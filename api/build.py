"""Data builder for the Vercel match centre engine.

Reuses the proven functions in poller.py (the GitHub poller) so the data shape
stays exactly the same as docs/live.json. Stateless: the scheduler (api/cron.js)
calls it, stores the result and decides what to ask for next.

Modes (GET /api/build?mode=...):
  board                       off-day board: next fixture or the held result, plus extras
  enrich&fixture=ID           form, H2H, team news, top scorers, info, season stats for one match
  lineups&fixture=ID          line-ups and whether they are the real team sheet
  live&fixture=ID&extra=1&table=1   live score/events/stats (+ ratings/commentary, + live table)

Only the scheduler may call it: header x-mc-key must equal CRON_SECRET.
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# poller.get() sleeps up to 60s on errors. In a 60s function that would time out,
# so cap every sleep at 3s; the scheduler retries on its next poll instead.
_real_sleep = time.sleep
time.sleep = lambda s: _real_sleep(min(float(s), 3.0))

import poller as P  # noqa: E402

# Team sheets are announced about an hour before kick-off.
P.LINEUP_WINDOW_MINUTES = 65


def ko_iso(s):
    return P.parse_ts(s).isoformat()


def sm_lineup_confirmed(fixture_id):
    """Sportmonks' own 'line-up confirmed' flag, if the plan returns it. None if unknown."""
    data = P.soft_get(f"fixtures/{fixture_id}", include="metadata.type")
    fx = (data or {}).get("data") or {}
    for m in fx.get("metadata") or []:
        t = m.get("type") or {}
        label = " ".join(str(t.get(k) or "") for k in ("code", "developer_name", "name")).lower()
        if "lineup" in label.replace("-", "").replace("_", "").replace(" ", "") and "confirm" in label:
            v = m.get("values")
            if isinstance(v, dict):
                for k in ("confirmed", "value"):
                    if k in v:
                        return bool(v[k])
            if isinstance(v, bool):
                return v
    return None


def confirmed_lineups(fx, meta, now):
    lu = P.parse_lineups(fx, meta)
    if not P.full_xis(lu):
        return lu, False
    ko = P.parse_ts(fx["starting_at"])
    sm = sm_lineup_confirmed(meta["id"])
    ok = sm if sm is not None else P.lineups_confirmed(lu, ko, now)
    return lu, bool(ok)


def upcoming_fixtures(now):
    start = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    end = (now + timedelta(days=60)).strftime("%Y-%m-%d")
    data, _ = P.get(f"fixtures/between/{start}/{end}/{P.TEAM_ID}", include="participants;state;league;venue")
    fixtures = sorted(data.get("data", []), key=lambda f: f["starting_at"])
    return [f for f in fixtures if (f.get("state") or {}).get("state", "") not in P.FINISHED][:3]


def mode_board():
    """Same board as the poller's off-day branch."""
    now = datetime.now(timezone.utc)
    upcoming = upcoming_fixtures(now)
    payload = {
        "live": False,
        "state": "NONE",
        "next_fixtures": [P.fixture_summary(f) for f in upcoming],
        "standings": P.get_standings(),
    }
    hold_hours = float(os.environ.get("RESULT_HOLD_HOURS", "4"))
    last = P.last_result(now)
    last_ko = P.parse_ts(last["starting_at"]) if last else None
    hold = bool(last_ko) and (now - last_ko).total_seconds() < (2 + hold_hours) * 3600
    if hold or not upcoming:
        if last:
            meta = P.fixture_summary(last)
            payload.update(P.build_live(last, meta))
            payload["live"] = False
            payload["result"] = True
            payload.update(P.live_extra(last["id"], meta))
            payload.update(P.enrich(meta, now, payload["standings"]))
    else:
        meta = P.fixture_summary(upcoming[0])
        full, _ = P.get(f"fixtures/{meta['id']}", include="participants;state;league;venue;lineups")
        lu, ok = confirmed_lineups(full["data"], meta, now)
        payload.update({
            "state": "NS", "state_name": "Not started", "fixture": meta,
            "score": {"home": 0, "away": 0}, "events": [], "stats": {},
            "lineups": lu if ok else P.empty_lineups(), "lineups_confirmed": ok,
        })
        payload.update(P.enrich(meta, now, payload["standings"]))
        if last:
            lm = P.fixture_summary(last)
            lb = P.build_live(last, lm)
            payload["last_match"] = {k: lb[k] for k in ("fixture", "state", "score", "half_time", "events", "stats", "lineups", "lineups_confirmed")}
            payload["last_match"].update(P.live_extra(last["id"], lm))
    nxt = upcoming[0] if upcoming else None
    return {"payload": payload, "next": {"id": nxt["id"], "ko": ko_iso(nxt["starting_at"])} if nxt else None}


def fixture_meta(fixture_id, include="participants;state;league;venue"):
    data, remaining = P.get(f"fixtures/{fixture_id}", include=include)
    return data["data"], remaining


def mode_enrich(fixture_id):
    now = datetime.now(timezone.utc)
    fx, _ = fixture_meta(fixture_id)
    meta = P.fixture_summary(fx)
    standings = P.get_standings()
    return {
        "meta": meta,
        "standings": standings,
        "next_fixtures": [P.fixture_summary(f) for f in upcoming_fixtures(now)],
        "extras": P.enrich(meta, now, standings),
    }


def mode_lineups(fixture_id):
    now = datetime.now(timezone.utc)
    fx, remaining = fixture_meta(fixture_id, include="participants;state;league;venue;lineups")
    meta = P.fixture_summary(fx)
    lu, ok = confirmed_lineups(fx, meta, now)
    return {"lineups": lu, "confirmed": ok, "remaining": remaining}


def mode_live(fixture_id, want_extra, want_table):
    fx, remaining = fixture_meta(
        fixture_id, include="scores;events.type;statistics.type;participants;state;periods;lineups;league;venue")
    meta = P.fixture_summary(fx)
    live = P.build_live(fx, meta)
    out = {"live": live, "remaining": remaining}
    if want_extra or live["state"] in P.FINISHED:
        out["lx"] = P.live_extra(fixture_id, meta)
    if want_table:
        if live["state"] in P.LIVE:
            rows, is_live = P.get_live_standings()
        else:
            rows, is_live = P.get_standings(), False
        if rows:
            out["standings"] = rows
            out["live_table"] = is_live
    return out


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        secret = os.environ.get("CRON_SECRET", "")
        if not secret or self.headers.get("x-mc-key") != secret:
            return self._send(401, {"error": "unauthorised"})
        if not P.TOKEN:
            return self._send(503, {"error": "SPORTMONKS_TOKEN is not set"})
        q = parse_qs(urlparse(self.path).query)

        def arg(k, d=None):
            return (q.get(k) or [d])[0]

        t0 = time.time()
        try:
            mode = arg("mode")
            fid = arg("fixture")
            if mode == "board":
                out = mode_board()
            elif mode == "enrich" and fid:
                out = mode_enrich(int(fid))
            elif mode == "lineups" and fid:
                out = mode_lineups(int(fid))
            elif mode == "live" and fid:
                out = mode_live(int(fid), arg("extra") == "1", arg("table") == "1")
            else:
                return self._send(400, {"error": "bad mode"})
            out["took_ms"] = int((time.time() - t0) * 1000)
            return self._send(200, out)
        except SystemExit:
            return self._send(502, {"error": "Sportmonks request failed"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": repr(e)[:300]})

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass
