"""Probe round 2: ratings in lineups.details, TV channel names, team season stats, commentary sample.
Writes docs/probe.json (no secrets). Safe to delete after use."""
import json, os, time, urllib.parse, urllib.request, urllib.error

TOKEN = os.environ["SPORTMONKS_TOKEN"]
BASE = "https://api.sportmonks.com/v3/football/"
TEAM = 53


def get(path, **params):
    q = urllib.parse.urlencode(params)
    url = BASE + path + ("?" + q if q else "")
    req = urllib.request.Request(url, headers={"Authorization": TOKEN, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
        except Exception:
            body = {"raw": "unparseable"}
        return e.code, body
    except Exception as e:
        return 0, {"error": str(e)}


out = {"ran_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
fx = json.load(open("docs/fixtures.json"))["fixtures"]
done = sorted([x for x in fx if x.get("finished") and not x.get("void")], key=lambda x: x["ts"])
nxt = sorted([x for x in fx if not x.get("finished")], key=lambda x: x["ts"])
LAST = done[-1]["id"]
NEXT = nxt[0]["id"] if nxt else None

# 1. Player match stats + ratings
code, b = get(f"fixtures/{LAST}", include="lineups.details.type")
out["lineups_details"] = {"http": code}
if code == 200:
    lu = b["data"].get("lineups", [])
    names = {}
    for p in lu:
        for d in p.get("details", []):
            t = d.get("type") or {}
            names[d.get("type_id")] = t.get("name")
    out["lineups_details"]["type_ids_seen"] = names
    out["lineups_details"]["rating_present"] = any(
        (d.get("type") or {}).get("name", "").lower() == "rating" or d.get("type_id") == 118
        for p in lu for d in p.get("details", [])
    )
    ex = [p for p in lu if p.get("details")][:2]
    out["lineups_details"]["example_players"] = [
        {"name": p.get("player_name"), "team_id": p.get("team_id"), "type_id": p.get("type_id"),
         "details": [{"type": (d.get("type") or {}).get("name"), "value": d.get("data")} for d in p["details"]][:40]}
        for p in ex
    ]
else:
    out["lineups_details"]["error"] = b.get("message") or b

# 2. TV channels with names (last + next)
for tag, fid in (("last", LAST), ("next", NEXT)):
    if not fid:
        continue
    code, b = get(f"fixtures/{fid}", include="tvStations.tvStation;tvStations.country")
    e = {"http": code}
    if code == 200:
        rows = []
        for t in b["data"].get("tvstations", b["data"].get("tvStations", [])):
            rows.append({"channel": (t.get("tvstation") or {}).get("name"),
                         "country": (t.get("country") or {}).get("name"),
                         "country_id": t.get("country_id")})
        e["count"] = len(rows)
        e["uk_or_scotland"] = [r for r in rows if (r.get("country") or "").lower() in ("united kingdom", "scotland", "england", "uk", "ireland")]
        e["first_10"] = rows[:10]
    else:
        e["error"] = b.get("message") or b
    out[f"tv_{tag}"] = e

# 3. Commentary sample
code, b = get(f"fixtures/{LAST}", include="comments")
out["comments"] = {"http": code}
if code == 200:
    cs = b["data"].get("comments", [])
    out["comments"]["count"] = len(cs)
    out["comments"]["sample"] = [{"minute": c.get("minute"), "extra": c.get("extra_minute"), "goal": c.get("is_goal"),
                                  "important": c.get("is_important"), "text": (c.get("comment") or "")[:160]}
                                 for c in cs[:6] + [c for c in cs if c.get("is_important")][:4]]

# 4. Team season stats
code, lg = get("leagues/501", include="currentSeason")
sid = None
if code == 200:
    sid = (lg["data"].get("currentseason") or lg["data"].get("currentSeason") or {}).get("id")
for name, params in (
    ("stats_details_type", dict(include="statistics.details.type", filters=f"teamStatisticSeasons:{sid}")),
    ("stats_details", dict(include="statistics.details", filters=f"teamStatisticSeasons:{sid}")),
    ("stats_plain", dict(include="statistics")),
):
    code, b = get(f"teams/{TEAM}", **params)
    e = {"http": code}
    if code == 200:
        st = b["data"].get("statistics", [])
        e["seasons"] = len(st)
        rows = []
        for s in st[:1]:
            for d in s.get("details", [])[:60]:
                rows.append({"type": (d.get("type") or {}).get("name") or d.get("type_id"), "value": d.get("value")})
        e["first_season_stats"] = rows
        e["season_ids"] = [s.get("season_id") for s in st]
    else:
        e["error"] = b.get("message") or b
    out[name] = e

# 5. Topscorer types
for flt in ("seasontopscorerTypes:208", "seasontopscorerTypes:209", "seasontopscorerTypes:83,84,208,209"):
    code, b = get(f"topscorers/seasons/{sid}", include="player", filters=flt)
    out["topscorers " + flt] = {"http": code, "rows": len(b.get("data", [])) if code == 200 else b.get("message")}

json.dump(out, open("docs/probe.json", "w"), indent=1)
print("done")
