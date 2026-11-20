// Health check for the engine: when it last ran, what it's waiting for, any error.
import { getJSON } from '../lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const st = (await getJSON('state/sched.json').catch(() => null)) || {};
  const d = await getJSON('live.json').catch(() => null);
  const ago = t => (t ? Math.round((Date.now() - Date.parse(t)) / 1000) + 's ago' : null);
  res.status(200).json({
    last_run: st.last_run || null, last_run_ago: ago(st.last_run),
    last_ok: st.last_ok || null, last_error: st.last_error || null,
    next: st.next || null, match: st.match ? { id: st.match.id, polls: st.match.n, pending_goal: st.match.pending } : null,
    done: st.done || {}, token_set: !!process.env.SPORTMONKS_TOKEN,
    feed: d ? { state: d.state, live: d.live, score: d.score, fixture: d.fixture && `${d.fixture.home} v ${d.fixture.away}`, updated_at: d.updated_at, updated_ago: ago(d.updated_at), rate_remaining: d.rate_remaining ?? null } : null,
  });
}
