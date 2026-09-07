#!/usr/bin/env python3
"""
Celtic season fixtures & results -> docs/fixtures.json

All competitions on the plan, from 1 July to 30 June of the current season,
with scores for finished games. The match centre page renders this as the
Fixtures & Results section. Runs alongside players.py (see players.yml).
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
TEAM_ID = int(os.environ.get("TEAM_ID", "53"))  # Celtic
OUT = os.environ.get("FIXTURES_OUT", "docs/fixtures.json")

FINISHED = {"FT", "AET", "FT_PEN", "AWARDED", "WO"}
VOID = {"POSTPONED", "CANCELLED", "ABANDONED", "SUSPENDED", "DELAYED", "TBA"}


def log(msg):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


def die(msg, code=1):
    log("ERROR: " + msg)
    sys.exit(code)


def get(path, **params):
    if not TOKEN:
        die("SPORTMONKS_TOKEN is not set")
    params["api_token"] = TOKEN
    url = f"{API}/{path}?{urllib.parse.urlencode(params, safe=';:,')}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            if e.code == 429:
                log(f"429 rate limited, sleeping 60s ({body})")
                time.sleep(60)
                continue
            if e.code in (500, 502, 503, 504):
                time.sleep(10 * (attempt + 1))
                continue
            die(f"HTTP {e.code} for {path}: {body}")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            log(f"network error {e!r}, retry")
            time.sleep(10 * (attempt + 1))
    die(f"gave up on {path}")


def season_window(now):
    y = now.year if now.month >= 7 else now.year - 1
    return f"{y}-07-01", f"{y + 1}-06-30", f"{y}/{str(y + 1)[2:]}"


def sides(fx):
    home = away = None
    for p in fx.get("participants", []) or []:
        loc = (p.get("meta") or {}).get("location")
        if loc == "home":
            home = p
        elif loc == "away":
            away = p
    return home, away


def scores(fx, home_id, away_id):
    cur, ht = {}, {}
    for x in fx.get("scores", []) or []:
        d = x.get("description")
        g = (x.get("score") or {}).get("goals")
        if d == "CURRENT":
            cur[x.get("participant_id")] = g
        elif d == "1ST_HALF":
            ht[x.get("participant_id")] = g
    return (cur.get(home_id), cur.get(away_id)), (ht.get(home_id), ht.get(away_id))


def fetch_all(start, end):
    out, page = [], 1
    while True:
        data = get(f"fixtures/between/{start}/{end}/{TEAM_ID}",
                   include="participants;scores;state;league;venue;round;stage",
                   per_page=50, page=page)
        out.extend(data.get("data") or [])
        pg = data.get("pagination") or {}
        if not pg.get("has_more"):
            break
        page += 1
    return out


def main():
    now = datetime.now(timezone.utc)
    start, end, label = season_window(now)
    raw = fetch_all(start, end)
    log(f"{len(raw)} fixtures {start}..{end}")

    rows = []
    for fx in raw:
        home, away = sides(fx)
        if not home or not away:
            continue
        state = ((fx.get("state") or {}).get("state")) or ""
        (hg, ag), (hh, ah) = scores(fx, home["id"], away["id"])
        is_home = home["id"] == TEAM_ID
        opp = away if is_home else home
        result = None
        if state in FINISHED and hg is not None and ag is not None:
            mine, theirs = (hg, ag) if is_home else (ag, hg)
            result = "W" if mine > theirs else "L" if mine < theirs else "D"
        rnd = (fx.get("round") or {}).get("name")
        stage = (fx.get("stage") or {}).get("name")
        rows.append({
            "id": fx["id"],
            "kickoff_utc": fx.get("starting_at"),
            "ts": fx.get("starting_at_timestamp"),
            "league": (fx.get("league") or {}).get("name"),
            "league_id": (fx.get("league") or {}).get("id"),
            "round": (f"Round {rnd}" if rnd and str(rnd).isdigit() else rnd) or stage,
            "venue": (fx.get("venue") or {}).get("name"),
            "home": home["name"], "away": away["name"],
            "home_id": home["id"], "away_id": away["id"],
            "home_logo": home.get("image_path"), "away_logo": away.get("image_path"),
            "ha": "H" if is_home else "A",
            "opp": opp["name"], "opp_logo": opp.get("image_path"),
            "state": state,
            "finished": state in FINISHED,
            "void": state in VOID,
            "score": {"home": hg, "away": ag} if hg is not None else None,
            "half_time": {"home": hh, "away": ah} if hh is not None else None,
            "result": result,
        })
    rows.sort(key=lambda r: r["ts"] or 0)

    played = [r for r in rows if r["finished"]]
    record = {"p": len(played), "w": sum(r["result"] == "W" for r in played),
              "d": sum(r["result"] == "D" for r in played), "l": sum(r["result"] == "L" for r in played),
              "gf": sum((r["score"]["home"] if r["ha"] == "H" else r["score"]["away"]) or 0 for r in played if r["score"]),
              "ga": sum((r["score"]["away"] if r["ha"] == "H" else r["score"]["home"]) or 0 for r in played if r["score"])}

    out = {"updated": now.isoformat(timespec="seconds"), "season": label, "team_id": TEAM_ID,
           "record": record, "fixtures": rows}

    old = None
    if os.path.exists(OUT):
        try:
            with open(OUT) as f:
                old = json.load(f)
        except Exception:
            old = None
    if old and {k: v for k, v in old.items() if k != "updated"} == {k: v for k, v in out.items() if k != "updated"}:
        log("no change, nothing to commit")
        return

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    log(f"wrote {OUT}: {len(rows)} fixtures, {record['p']} played")

    if os.environ.get("GITHUB_ACTIONS"):
        subprocess.run(["git", "config", "user.name", "celts-bot"], check=True)
        subprocess.run(["git", "config", "user.email", "bot@celtsarehere.com"], check=True)
        subprocess.run(["git", "add", OUT], check=True)
        st = subprocess.run(["git", "status", "--porcelain", OUT], capture_output=True, text=True)
        if st.stdout.strip():
            subprocess.run(["git", "commit", "-q", "-m", "Update fixtures & results"], check=True)
            for _ in range(3):
                if subprocess.run(["git", "push", "-q"]).returncode == 0:
                    log("pushed")
                    break
                subprocess.run(["git", "pull", "--rebase", "-q"])


if __name__ == "__main__":
    main()
