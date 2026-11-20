// Server-rendered HTML for the WordPress page, so Google sees the real content.
// The browser script then takes over and keeps it live.
import { getJSON } from '../lib/store.js';
import { renderApp } from '../public/mc-render.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let d = null;
  try { d = await getJSON('live.json'); } catch (e) { console.error('fragment read', e.message); }
  if (!d) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).send('');
  }
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
  return res.status(200).send(renderApp(d, {}));
}
