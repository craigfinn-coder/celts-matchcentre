// Match centre scheduler. Vercel runs it every minute (vercel.json "crons").
//
// Off-day:   refreshes the board every 30 min (every 10 min in the 26h before a game).
// Match day: from 90 min before kick-off it checks for the confirmed XI once a minute,
//            then polls the live feed every 15s until full time, archives the match
//            to matches/<id>.json and hands back to the board.
//
// Each run stops by ~50s so the next minute's run takes over cleanly.
// The Sportmonks work is done by api/build.py (the poller's own Python code).
import { getJSON, putJSON } from '../lib/store.js';

const FINISHED = new Set(['FT', 'AET', 'FT_PEN', 'POSTPONED', 'CANCELLED', 'ABANDONED', 'AWARDED', 'WO', 'SUSPENDED']);
const LIVE = new Set(['INPLAY_1ST_HALF', 'INPLAY_2ND_HALF', 'HT', 'INPLAY_ET', 'INPLAY_ET_2ND_HALF', 'BREAK', 'PEN_BREAK', 'INPLAY_PENALTIES', 'EXTRA_TIME_BREAK']);
const POLL_MS = 15000;
const RUN_MS = 47000;
const PRE_KO_MIN = 90;
const SQUAD_URL = 'https://raw.githubusercontent.com/craigfinn-coder/celts-matchcentre/main/docs/players.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const goals = s => (s ? (+s.home || 0) + (+s.away || 0) : 0);
const emptyLineups = () => ({ home: { xi: [], bench: [], formation: null }, away: { xi: [], bench: [], formation: null } });

function base() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host.startsWith('http') ? host : `https://${host}`;
}

export async function build(params) {
  const u = new URL(base() + '/api/build');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: { 'x-mc-key': process.env.CRON_SECRET }, signal: AbortSignal.timeout(45000) });
  let j = {};
  try { j = await r.json(); } catch (_) {}
  if (!r.ok || j.error) throw new Error(`build ${params.mode} ${r.status} ${j.error || ''}`.trim());
  return j;
}

async function loadSquad() {
  const r = await fetch(SQUAD_URL + '?t=' + Date.now(), { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('players.json ' + r.status);
  const p = await r.json();
  const out = Object.values(p.players || {}).map(pl => {
    const tot = pl.total || {};
    const comps = pl.competitions || [];
    const prem = comps.find(c => c.league === 'Premiership') || {};
    const eur = comps.filter(c => /Europa|Champions|Conference/.test(c.league || ''));
    return {
      name: pl.display_name || pl.name, pos: pl.position, num: pl.jersey,
      g: tot.goals || 0, a: tot.assists || 0, apps: tot.apps || 0, starts: tot.starts || 0, min: tot.minutes || 0,
      pg: prem.goals || 0, pa: prem.assists || 0, eg: eur.reduce((s, c) => s + (c.goals || 0), 0),
    };
  });
  out.sort((a, b) => b.g - a.g || b.a - a.a);
  return out.slice(0, 30);
}

function activeMatch(st, now) {
  const nx = st.next;
  if (!nx || (st.done || {})[nx.id]) return null;
  const ko = Date.parse(nx.ko);
  if (now >= ko - PRE_KO_MIN * 60e3 && now <= ko + 4 * 3600e3) return { id: nx.id, ko };
  return null;
}

async function refreshBoard(st, log) {
  const b = await build({ mode: 'board' });
  const payload = { ...b.payload, squad: st.squad || [], updated_at: iso(), engine: 'vercel' };
  await putJSON('live.json', payload);
  st.board_at = Date.now();
  st.next = b.next || null;
  log('board', b.next ? `next ${b.next.id} at ${b.next.ko}` : 'no upcoming fixture', `${b.took_ms}ms`);
}

async function matchDay(st, act, deadline, log) {
  const { id, ko } = act;
  if (!st.match || st.match.id !== id) st.match = { id, n: 0, finished: 0, pending: null, extras_at: 0 };
  const m = st.match;

  let extras = await getJSON(`extras/${id}.json`);
  if (!extras || (Date.now() < ko && Date.now() - m.extras_at > 30 * 60e3)) {
    extras = await build({ mode: 'enrich', fixture: id });
    await putJSON(`extras/${id}.json`, extras);
    m.extras_at = Date.now();
    log('extras refreshed', `${extras.took_ms}ms`);
  }
  let prev = await getJSON('live.json');
  const sameMatch = p => p && p.fixture && p.fixture.id === id;

  // Before kick-off: one line-up check per run (= once a minute)
  if (Date.now() < ko - 2 * 60e3) {
    const lu = await build({ mode: 'lineups', fixture: id });
    const payload = {
      live: false, state: 'NS', state_name: 'Not started', fixture: extras.meta,
      score: { home: 0, away: 0 }, events: [], stats: {},
      lineups: lu.confirmed ? lu.lineups : emptyLineups(), lineups_confirmed: !!lu.confirmed,
      next_fixtures: extras.next_fixtures, standings: extras.standings, ...extras.extras,
      last_match: prev && prev.last_match, squad: st.squad || [], updated_at: iso(), engine: 'vercel',
    };
    await putJSON('live.json', payload);
    log('pre-match', lu.confirmed ? 'XI confirmed' : 'XI not out yet', `rate ${lu.remaining}`);
    return;
  }

  // Kick-off onwards: poll every 15s until this run's time is up
  while (Date.now() < deadline) {
    const t0 = Date.now();
    let r;
    try {
      r = await build({ mode: 'live', fixture: id, extra: m.n % 2 === 0 ? 1 : 0, table: m.n % 8 === 0 ? 1 : 0 });
    } catch (e) {
      log('live poll failed', e.message);
      await sleep(5000);
      continue;
    }
    m.n++;
    const L = r.live;

    // Phantom goal guard: a new goal must show up on two polls in a row before we publish it.
    // (8 Nov: the feed showed 2-0 v Kilmarnock for ~90s before VAR wiped it.)
    if (sameMatch(prev) && goals(L.score) > goals(prev.score)) {
      const key = JSON.stringify(L.score);
      if (m.pending !== key) {
        m.pending = key;
        log('goal seen once, waiting for confirmation', key);
        await sleep(Math.max(1000, POLL_MS - (Date.now() - t0)));
        continue;
      }
    }
    m.pending = null;

    const keepLx = sameMatch(prev) ? { player_stats: prev.player_stats, commentary: prev.commentary } : {};
    const payload = {
      ...L,
      live: LIVE.has(L.state),
      next_fixtures: extras.next_fixtures,
      standings: r.standings || (sameMatch(prev) && prev.standings) || extras.standings,
      live_table: r.standings ? !!r.live_table : !!(sameMatch(prev) && prev.live_table),
      ...extras.extras,
      ...keepLx,
      ...(r.lx || {}),
      squad: st.squad || [],
      rate_remaining: r.remaining,
      updated_at: iso(),
      engine: 'vercel',
    };
    await putJSON('live.json', payload);
    prev = payload;

    if (FINISHED.has(L.state)) {
      m.finished++;
      if (m.finished >= 2) {
        const final = { ...payload, live: false, result: true };
        await putJSON(`matches/${id}.json`, final);
        await putJSON('live.json', final);
        st.done = { ...(st.done || {}), [id]: Date.now() };
        st.board_at = Date.now();   // the board takes over 10 min later and holds the result for 4h
        log('full time, archived', `${L.score.home}-${L.score.away}`);
        return;
      }
    }

    let wait = POLL_MS;
    if (typeof r.remaining === 'number') {
      if (r.remaining < 300) wait = 45000;
      else if (r.remaining < 700) wait = 25000;
    }
    await sleep(Math.max(1000, wait - (Date.now() - t0)));
  }
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers['authorization'] !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorised' });
  const started = Date.now();
  const deadline = started + RUN_MS;
  const logs = [];
  const log = (...a) => { const s = a.join(' '); logs.push(s); console.log(s); };

  let st = (await getJSON('state/sched.json')) || {};
  if (st.lock && st.lock > Date.now()) return res.status(200).json({ ok: true, skipped: 'previous run still going' });
  st.lock = Date.now() + 58000;
  await putJSON('state/sched.json', st);

  try {
    if (!process.env.SPORTMONKS_TOKEN) throw new Error('SPORTMONKS_TOKEN is not set');
    if (!st.squad_at || Date.now() - st.squad_at > 30 * 60e3) {
      try { st.squad = await loadSquad(); st.squad_at = Date.now(); } catch (e) { log('squad', e.message); }
    }
    const act = activeMatch(st, Date.now());
    if (act) {
      await matchDay(st, act, deadline, log);
    } else {
      const toKo = st.next ? Date.parse(st.next.ko) - Date.now() : Infinity;
      const every = toKo < 26 * 3600e3 ? 10 * 60e3 : 30 * 60e3;
      if (!st.board_at || Date.now() - st.board_at > every) await refreshBoard(st, log);
    }
    st.last_ok = iso();
    st.last_error = null;
  } catch (e) {
    log('ERROR', e.message);
    st.last_error = { at: iso(), msg: e.message };
  }
  st.lock = 0;
  st.last_run = iso();
  await putJSON('state/sched.json', st);
  return res.status(200).json({ ok: !st.last_error, took_ms: Date.now() - started, logs });
}
