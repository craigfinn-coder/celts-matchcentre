#!/usr/bin/env python3
"""
Celtic squad season stats -> docs/players.json

Pulls every active season Celtic are in (league, cups, Europe) from Sportmonks,
reads each squad member's statistic details, and writes one JSON file the
CeltsAreHere player profile pages read (cached server-side for an hour).

Runs on a schedule via .github/workflows/players.yml. Safe to run any time:
it only commits when the numbers actually change.
"""
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://api.sportmonks.com/v3/football"
TOKEN = os.environ.get("SPORTMONKS_TOKEN", "").strip()
TEAM_ID = int(os.environ.get("TEAM_ID", "53"))  # Celtic
OUT = os.environ.get("PLAYERS_OUT", "docs/players.json")

# Sportmonks statistic developer_name -> our key
STAT_KEYS = {
    "APPEARANCES": "apps",
    "LINEUPS": "starts",
    "SUBSTITUTIONS": "sub_apps",
    "MINUTES_PLAYED": "minutes",
    "GOALS": "goals",
    "ASSISTS": "assists",
    "YELLOWCARDS": "yellows",
    "REDCARDS": "reds",
    "CLEANSHEETS": "clean_sheets",
    "PENALTIES": "penalties",
}


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


def norm(s):
    """lowercase, accents stripped, letters only, for name matching"""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z]+", " ", s.lower()).strip()


def stat_value(detail):
    v = detail.get("value")
    if isinstance(v, dict):
        for k in ("total", "count", "all", "overall"):
            if k in v and isinstance(v[k], (int, float)):
                return v[k]
        # nested e.g. {"home": .., "away": ..}
        nums = [x for x in v.values() if isinstance(x, (int, float))]
        return sum(nums) if nums else 0
    return v if isinstance(v, (int, float)) else 0


def active_seasons():
    data = get(f"teams/{TEAM_ID}", include="activeSeasons.league")
    team = data.get("data") or {}
    out = []
    for s in team.get("activeSeasons") or []:
        lg = s.get("league") or {}
        out.append({
            "season_id": s["id"],
            "season": s.get("name"),
            "league_id": lg.get("id"),
            "league": lg.get("name") or f"League {lg.get('id')}",
            "is_current": bool(s.get("is_current")),
        })
    return out


def squad_stats(season):
    data = get(f"squads/seasons/{season['season_id']}/teams/{TEAM_ID}",
               include="player.nationality;player.position;details.type")
    rows = []
    for m in data.get("data") or []:
        p = m.get("player") or {}
        if not p:
            continue
        stats = {}
        for d in m.get("details") or []:
            t = (d.get("type") or {}).get("developer_name")
            key = STAT_KEYS.get(t)
            if key:
                stats[key] = stat_value(d)
        rows.append({
            "player_id": p["id"],
            "name": p.get("name"),
            "display_name": p.get("display_name") or p.get("common_name") or p.get("name"),
            "image": p.get("image_path"),
            "dob": p.get("date_of_birth"),
            "nationality": (p.get("nationality") or {}).get("name"),
            "position": (p.get("position") or {}).get("name"),
            "jersey": m.get("jersey_number"),
            "captain": bool(m.get("captain")),
            "stats": stats,
        })
    return rows


def main():
    seasons = [s for s in active_seasons() if s["is_current"] or True]
    if not seasons:
        die("no active seasons returned for team")
    log("seasons: " + ", ".join(f"{s['league']} ({s['season']})" for s in seasons))

    players = {}
    for s in seasons:
        try:
            rows = squad_stats(s)
        except SystemExit:
            raise
        except Exception as e:  # keep going if one competition fails
            log(f"skip {s['league']}: {e!r}")
            continue
        log(f"{s['league']}: {len(rows)} squad members")
        for r in rows:
            pid = str(r["player_id"])
            entry = players.setdefault(pid, {
                "id": r["player_id"], "name": r["name"], "display_name": r["display_name"],
                "image": r["image"], "dob": r["dob"], "nationality": r["nationality"],
                "position": r["position"], "jersey": r["jersey"], "captain": r["captain"],
                "competitions": [], "total": {},
            })
            if r["jersey"] and not entry.get("jersey"):
                entry["jersey"] = r["jersey"]
            if r["stats"]:
                entry["competitions"].append({"league": s["league"], "league_id": s["league_id"], "season": s["season"], **r["stats"]})
                for k, v in r["stats"].items():
                    entry["total"][k] = entry["total"].get(k, 0) + (v or 0)

    by_name = {}
    for pid, e in players.items():
        for n in (e["name"], e["display_name"]):
            if n:
                by_name[norm(n)] = e["id"]

    season_label = ""
    for s in seasons:
        if s["league_id"] == 501:
            season_label = s["season"] or ""
    out = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "team_id": TEAM_ID,
        "season": season_label,
        "competitions": [{"league": s["league"], "league_id": s["league_id"], "season": s["season"]} for s in seasons],
        "players": players,
        "by_name": by_name,
    }

    old = None
    if os.path.exists(OUT):
        try:
            with open(OUT) as f:
                old = json.load(f)
        except Exception:
            old = None
    if old and {k: v for k, v in old.items() if k != "updated"} == {k: v for k, v in out.items() if k != "updated"}:
        log("no change in stats, nothing to commit")
        return

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    log(f"wrote {OUT}: {len(players)} players")

    if os.environ.get("GITHUB_ACTIONS"):
        subprocess.run(["git", "config", "user.name", "celts-bot"], check=True)
        subprocess.run(["git", "config", "user.email", "bot@celtsarehere.com"], check=True)
        subprocess.run(["git", "add", OUT], check=True)
        st = subprocess.run(["git", "status", "--porcelain", OUT], capture_output=True, text=True)
        if st.stdout.strip():
            subprocess.run(["git", "commit", "-q", "-m", "Update player season stats"], check=True)
            for _ in range(3):
                if subprocess.run(["git", "push", "-q"]).returncode == 0:
                    log("pushed")
                    break
                subprocess.run(["git", "pull", "--rebase", "-q"])


if __name__ == "__main__":
    main()
