// Public feed the page polls. Short CDN cache during a match, longer otherwise.
import { getJSON } from '../lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  let d = null;
  try { d = await getJSON('live.json'); } catch (e) { console.error('live read', e.message); }
  if (!d) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'not ready' });
  }
  const ko = d.fixture ? Date.parse(String(d.fixture.kickoff_utc).replace(' ', 'T') + 'Z') : 0;
  const hot = d.live || (ko && Math.abs(ko - Date.now()) < 3 * 3600e3);
  res.setHeader('Cache-Control', hot
    ? 'public, max-age=0, s-maxage=5, stale-while-revalidate=10'
    : 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json(d);
}
