"""One-off probe: which Sportmonks includes work on this plan, and what they return.
Writes docs/probe.json (no secrets). Safe to delete after use."""
import json, os, sys, time, urllib.parse, urllib.request, urllib.error

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


def shape(o, depth=0):
    """Compact description of a JSON value: keys + a sample."""
    if isinstance(o, dict):
        if depth > 3:
            return "{...}"
        return {k: shape(v, depth + 1) for k, v in list(o.items())[:30]}
    if isinstance(o, list):
        return [shape(o[0], depth + 1), f"(+{len(o)-1} more)"] if o else []
    if isinstance(o, str):
        return o[:80]
    return o


out = {"ran_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tests": {}}

fx = json.load(open("docs/fixtures.json"))["fixtures"]
done = [x for x in fx if x.get("finished") and not x.get("void")]
nxt = [x for x in fx if not x.get("finished")]
done.sort(key=lambda x: x["ts"])
nxt.sort(key=lambda x: x["ts"])
last = done[-1]
nextfx = nxt[0] if nxt else None
out["last_fixture"] = {k: last.get(k) for k in ("id", "home", "away", "score", "kickoff_utc", "league")}
out["next_fixture"] = {k: nextfx.get(k) for k in ("id", "home", "away", "kickoff_utc", "league")} if nextfx else None


def test(name, path, **params):
    code, body = get(path, **params)
    entry = {"http": code}
    if code == 200:
        entry["sample"] = shape(body.get("data"))
    else:
        entry["error"] = body.get("message") or body
    if isinstance(body, dict) and "subscription" in body:
        pass
    out["tests"][name] = entry
    print(name, code)
    return code, body


LAST = last["id"]
# --- per-include probes on the last finished Celtic game ---
for inc in [
    "lineups.details.type",       # per-player match stats incl. rating?
    "lineups.xGLineup",           # player xG
    "xGFixture",                  # team xG
    "pressure",                   # momentum
    "comments",                   # text commentary
    "timeline",
    "tvStations",
    "referees.referee",
    "coaches",
    "weatherReport",
    "predictions",
    "trends",
    "ballCoordinates",
    "metadata.type",
    "venue",
]:
    test("last:" + inc, f"fixtures/{LAST}", include=inc)

# --- upcoming game ---
if nextfx:
    NX = nextfx["id"]
    for inc in ["tvStations", "referees.referee", "coaches", "weatherReport", "predictions", "metadata.type", "expectedLineups", "premiumExpectedLineups"]:
        test("next:" + inc, f"fixtures/{NX}", include=inc)

# --- team season stats (for comparison bars) ---
code, lg = get("leagues/501", include="currentSeason")
sid = None
if code == 200:
    sid = (lg["data"].get("currentseason") or lg["data"].get("currentSeason") or {}).get("id")
out["season_id"] = sid
test("team:statistics.type", f"teams/{TEAM}", include="statistics.type")
if sid:
    test("team:statistics(season filter)", f"teams/{TEAM}", include="statistics.type", filters=f"teamStatisticSeasons:{sid}")
    code, ts = get(f"topscorers/seasons/{sid}", include="player;type")
    entry = {"http": code}
    if code == 200:
        types = {}
        for r in ts["data"]:
            t = (r.get("type") or {})
            types.setdefault(r.get("type_id"), t.get("name"))
        entry["topscorer_types"] = types
    else:
        entry["error"] = ts.get("message") or ts
    out["tests"]["topscorers:all types"] = entry
    print("topscorers", code)

json.dump(out, open("docs/probe.json", "w"), indent=1)
print("done")
