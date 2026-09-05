# Celtic Match Centre

Live score, scorers, subs, cards, match stats and the Premiership table for Celtic games,
built for CeltsAreHere.com. Runs entirely on GitHub (Actions + Pages) with data from the
Sportmonks football API.

## How it works

1. `poller.py` runs in GitHub Actions every hour. If Celtic kick off within the next 75 minutes
   it waits for kick-off, then polls Sportmonks every 30 seconds until full time.
2. Each time the score, an event or the match state changes it writes `docs/live.json` and pushes it.
3. `docs/index.html` (served by GitHub Pages) reads `live.json` every 20 seconds and renders the page.
4. `docs/latency.log` records the moment each event was first seen, so we can measure lag against TV.

WordPress does no live work at all: it just embeds the page.

## Embed on the site

```html
<iframe src="https://craigfinn-coder.github.io/celts-matchcentre/" 
        style="width:100%;height:1400px;border:0" loading="lazy" title="Celtic Match Centre"></iframe>
```

## Manual run

Actions → "Match day poller" → Run workflow. Leave the fixture ID blank to auto-detect today's game,
or paste a Sportmonks fixture ID to force one.

## Settings

- Secret `SPORTMONKS_TOKEN` (Settings → Secrets and variables → Actions).
- Pages: deploy from branch `main`, folder `/docs`.
- Free plan limit is 180 requests/hour per entity; the poller slows itself down if it gets close.
