#!/usr/bin/env python3
"""
Celtic match-day poller for CeltsAreHere.

Runs inside GitHub Actions. Finds today's Celtic fixture on Sportmonks, waits for
kick-off, then polls every 30 seconds and writes docs/live.json. Only commits when
something actually changed (score, event, state, minute bucket), so the repo isn't
spammed with identical commits.

Free-plan budget: 180 requests / hour / entity. One fixture request every 30s = 120/h.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.sportmonks.com/v3/football"
TOKEN = os.environ.get("SPORTMONKS_TOKEN", "").strip()
TEAM_ID = int(os.environ.get("TEAM_ID", "53"))          # Celtic
LEAGUE_ID = int(os.environ.get("LEAGUE_ID", "501"))      # Scottish Premiership
OUT = os.environ.get("OUT_FILE", "docs/live.json")
LATENCY_LOG = os.environ.get("LATENCY_LOG", "docs/latency.log")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
MAX_RUN_HOURS = float(os.environ.get("MAX_RUN_HOURS", "5.5"))   # GitHub job limit is 6h
LOOKAHEAD_MIN = int(os.environ.get("LOOKAHEAD_MIN", "75"))      # start if KO within this
FORCE_FIXTURE = os.environ.get("FIXTURE_ID", "").strip()        # manual override

FINISHED = {"FT", "AET", "FT_PEN", "POSTPONED", "CANCELLED", "ABANDONED", "AWARDED", "WO", "SUSPENDED"}
LIVE = {"INPLAY_1ST_HALF", "INPLAY_2ND_HALF", "HT", "INPLAY_ET", "INPLAY_ET_2ND_HALF", "BREAK", "PEN_BREAK", "INPLAY_PENALTIES", "EXTRA_TIME_BREAK"}


def log(msg):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


def die(msg, code=1):
    log("ERROR: " + msg)
    sys.exit(code)


def get(path, **params):
    """GET with token, returns (json, rate_remaining). Retries on transient errors."""
    if not TOKEN:
        die("SPORTMONKS_TOKEN is not set")
    params["api_token"] = TOKEN
    url = f"{API}/{path}?{urllib.parse.urlencode(params, safe=';:,')}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.loads(r.read().decode())
            remaining = (data.get("rate_limit") or {}).get("remaining")
            return data, remaining
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            if e.code == 429:
                log(f"429 rate limited, sleeping 60s ({body})")
                time.sleep(60)
                continue
            if e.code in (500, 502, 503, 504):
                log(f"{e.code} from API, retry in {10 * (attempt + 1)}s")
                time.sleep(10 * (attempt + 1))
                continue
            die(f"HTTP {e.code} for {path}: {body}")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            log(f"network error {e!r}, retry in {10 * (attempt + 1)}s")
            time.sleep(10 * (attempt + 1))
    die(f"gave up on {path}")


def parse_ts(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def sides(fx):
    home = away = None
    for p in fx.get("participants", []):
        loc = (p.get("meta") or {}).get("location")
        if loc == "home":
            home = p
        elif loc == "away":
            away = p
    return home, away


def find_fixture(now):
    if FORCE_FIXTURE:
        data, _ = get(f"fixtures/{FORCE_FIXTURE}", include="participants;state;league;venue")
        return data["data"], []
    start = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    end = (now + timedelta(days=14)).strftime("%Y-%m-%d")
    data, _ = get(f"fixtures/between/{start}/{end}/{TEAM_ID}", include="participants;state;league;venue")
    fixtures = sorted(data.get("data", []), key=lambda f: f["starting_at"])
    chosen = None
    for fx in fixtures:
        ko = parse_ts(fx["starting_at"])
        state = (fx.get("state") or {}).get("state", "")
        if state in FINISHED:
            continue
        # Start if KO is within LOOKAHEAD_MIN ahead, or it kicked off up to 3h ago (still live)
        if -3 * 3600 <= (ko - now).total_seconds() <= LOOKAHEAD_MIN * 60:
            chosen = fx
            break
    upcoming = [f for f in fixtures if (f.get("state") or {}).get("state", "") not in FINISHED][:3]
    return chosen, upcoming


def fixture_summary(fx):
    home, away = sides(fx)
    return {
        "id": fx["id"],
        "kickoff_utc": fx["starting_at"],
        "league": (fx.get("league") or {}).get("name"),
        "venue": (fx.get("venue") or {}).get("name"),
        "home": home["name"] if home else None,
        "away": away["name"] if away else None,
        "home_id": home["id"] if home else None,
        "away_id": away["id"] if away else None,
    }


def get_standings():
    try:
        lg, _ = get(f"leagues/{LEAGUE_ID}", include="currentSeason")
        season = (lg["data"].get("currentseason") or lg["data"].get("currentSeason") or {}).get("id")
        if not season:
            return []
        st, _ = get(f"standings/seasons/{season}", include="participant;details.type")
        rows = []
        for r in st.get("data", []):
            played = won = drawn = lost = gf = ga = None
            for d in r.get("details", []):
                name = ((d.get("type") or {}).get("name") or "").lower()
                v = d.get("value")
                if name == "overall matches played": played = v
                elif name == "overall won": won = v
                elif name == "overall draw": drawn = v
                elif name == "overall lost": lost = v
                elif name == "overall goals scored": gf = v
                elif name == "overall goals conceded": ga = v
            rows.append({
                "pos": r.get("position"),
                "team": (r.get("participant") or {}).get("name"),
                "team_id": r.get("participant_id"),
                "pts": r.get("points"),
                "p": played, "w": won, "d": drawn, "l": lost,
                "gd": (gf - ga) if isinstance(gf, int) and isinstance(ga, int) else None,
            })
        return sorted(rows, key=lambda x: (x["pos"] or 99))
    except SystemExit:
        raise
    except Exception as e:
        log(f"standings failed: {e!r}")
        return []


def build_live(fx, meta):
    home_id, away_id = meta["home_id"], meta["away_id"]
    score = {"home": 0, "away": 0}
    ht = {"home": None, "away": None}
    for s in fx.get("scores", []):
        side = "home" if s.get("participant_id") == home_id else "away"
        goals = (s.get("score") or {}).get("goals")
        if s.get("description") == "CURRENT":
            score[side] = goals
        elif s.get("description") == "1ST_HALF":
            ht[side] = goals

    state = (fx.get("state") or {})
    state_code = state.get("state", "NS")
    state_name = state.get("name", state_code)

    minute = None
    added = None
    for p in fx.get("periods", []):
        if p.get("ticking"):
            minute = p.get("minutes")
            added = p.get("time_added")
    minute_estimated = False
    if minute is None and state_code == "HT":
        minute = 45
    if minute is None and state_code in ("INPLAY_1ST_HALF", "INPLAY_2ND_HALF"):
        # Free plan may not return periods; estimate from kick-off time instead
        elapsed = (datetime.now(timezone.utc) - parse_ts(fx["starting_at"])).total_seconds() / 60
        if state_code == "INPLAY_1ST_HALF":
            minute = max(1, min(45, int(elapsed)))
        else:
            minute = max(46, min(90, int(elapsed) - 15))
        minute_estimated = True

    events = []
    for e in fx.get("events", []):
        t = (e.get("type") or {}).get("name") or str(e.get("type_id"))
        side = "home" if e.get("participant_id") == home_id else "away"
        events.append({
            "id": e.get("id"),
            "minute": e.get("minute"),
            "extra": e.get("extra_minute"),
            "type": t,
            "side": side,
            "team": meta["home"] if side == "home" else meta["away"],
            "player": e.get("player_name"),
            "related": e.get("related_player_name"),
            "result": e.get("result"),
            "info": e.get("info"),
        })
    events.sort(key=lambda x: ((x["minute"] or 0), (x["extra"] or 0), x["id"] or 0))

    stats = {}
    for s in fx.get("statistics", []):
        name = (s.get("type") or {}).get("name") or str(s.get("type_id"))
        side = "home" if s.get("participant_id") == home_id else "away"
        stats.setdefault(name, {"home": None, "away": None})[side] = (s.get("data") or {}).get("value")

    return {
        "fixture": meta,
        "state": state_code,
        "state_name": state_name,
        "minute": minute,
        "minute_estimated": minute_estimated,
        "added_time": added,
        "score": score,
        "half_time": ht,
        "events": events,
        "stats": stats,
    }


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)


def git(*args, check=True):
    return subprocess.run(["git", *args], check=check, capture_output=True, text=True)


def commit_push(msg, paths):
    try:
        git("add", *paths)
        st = git("status", "--porcelain", *paths)
        if not st.stdout.strip():
            return False
        git("commit", "-q", "-m", msg)
        for attempt in range(3):
            r = git("push", "-q", check=False)
            if r.returncode == 0:
                return True
            log(f"push failed ({r.stderr.strip()[:200]}), rebasing")
            git("pull", "--rebase", "-q", check=False)
        return False
    except subprocess.CalledProcessError as e:
        log(f"git error: {e.stderr[:300]}")
        return False


def main():
    now = datetime.now(timezone.utc)
    started = now
    git("config", "user.name", "celts-matchcentre-bot", check=False)
    git("config", "user.email", "bot@celtsarehere.com", check=False)

    fx, upcoming = find_fixture(now)
    if not fx:
        log("No Celtic fixture in window. Writing next-fixtures file and exiting.")
        payload = {
            "updated_at": now.isoformat(),
            "live": False,
            "state": "NONE",
            "next_fixtures": [fixture_summary(f) for f in upcoming],
            "standings": get_standings(),
        }
        write_json(OUT, payload)
        commit_push("No match today - refresh next fixtures", [OUT])
        return

    meta = fixture_summary(fx)
    ko = parse_ts(fx["starting_at"])
    log(f"Fixture {meta['id']}: {meta['home']} v {meta['away']} at {meta['kickoff_utc']} UTC ({meta['league']})")

    standings = get_standings()
    pre = {
        "updated_at": now.isoformat(),
        "live": False,
        "state": "NS",
        "state_name": "Not started",
        "fixture": meta,
        "score": {"home": 0, "away": 0},
        "events": [],
        "stats": {},
        "next_fixtures": [fixture_summary(f) for f in upcoming],
        "standings": standings,
    }
    write_json(OUT, pre)
    commit_push(f"Pre-match: {meta['home']} v {meta['away']}", [OUT])

    # Sleep until 3 minutes before kick-off
    wait = (ko - timedelta(minutes=3) - datetime.now(timezone.utc)).total_seconds()
    if wait > 0:
        log(f"Sleeping {int(wait)}s until 3 min before kick-off")
        time.sleep(wait)

    seen_events = set()
    last_payload_key = None
    last_commit = time.time()
    poll = POLL_SECONDS
    finished_polls = 0

    while True:
        loop_start = time.time()
        if (datetime.now(timezone.utc) - started).total_seconds() > MAX_RUN_HOURS * 3600:
            log("Max run time reached, exiting")
            break

        data, remaining = get(f"fixtures/{meta['id']}",
                              include="scores;events.type;statistics.type;participants;state;periods")
        live = build_live(data["data"], meta)
        now_iso = datetime.now(timezone.utc).isoformat()

        # latency log: first time we saw each event
        new_lines = []
        for e in live["events"]:
            if e["id"] and e["id"] not in seen_events:
                seen_events.add(e["id"])
                new_lines.append(f"{now_iso}\t{e['minute']}'\t{e['type']}\t{e['team']}\t{e['player']}\t{e['result'] or ''}")
        if new_lines:
            with open(LATENCY_LOG, "a") as f:
                f.write("\n".join(new_lines) + "\n")
            for l in new_lines:
                log("NEW EVENT " + l)

        payload = {
            "updated_at": now_iso,
            "live": live["state"] in LIVE,
            **live,
            "next_fixtures": pre["next_fixtures"],
            "standings": standings,
            "rate_remaining": remaining,
        }
        write_json(OUT, payload)

        key = json.dumps({k: live[k] for k in ("state", "minute", "score", "events", "stats")}, sort_keys=True)
        heartbeat = time.time() - last_commit > 300
        if key != last_payload_key or heartbeat:
            s = live["score"]
            msg = f"{meta['home']} {s['home']}-{s['away']} {meta['away']} [{live['state']} {live['minute'] or ''}']"
            if commit_push(msg, [OUT, LATENCY_LOG]):
                last_commit = time.time()
                log("pushed: " + msg)
            last_payload_key = key

        if live["state"] in FINISHED:
            finished_polls += 1
            if finished_polls >= 2:   # one extra poll to catch late stat updates
                log("Match finished. Refreshing standings and exiting.")
                payload["standings"] = get_standings()
                write_json(OUT, payload)
                commit_push(f"Full time: {meta['home']} {s['home']}-{s['away']} {meta['away']}", [OUT, LATENCY_LOG])
                break

        # Be polite to the free-plan budget
        if isinstance(remaining, int) and remaining < 25:
            poll = 90
        elif isinstance(remaining, int) and remaining < 60:
            poll = 60
        else:
            poll = POLL_SECONDS
        time.sleep(max(1, poll - (time.time() - loop_start)))


if __name__ == "__main__":
    main()
