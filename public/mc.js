// Celtic Match Centre — browser side. Takes over the server-rendered block, keeps it live.
import { renderApp, phaseOf, goalCount, resultText, countdown, ago, koDate } from './mc-render.js';

const root = document.querySelector('.cahmc[data-mc]');
if (root) start(root);

function start(root) {
  const API = (root.getAttribute('data-api') || new URL('.', import.meta.url).origin).replace(/\/$/, '');
  const state = { tab: null, view: 'main', side: 'celtic', showAll: false };
  let data = null;
  let timer = null;
  let flashUntil = 0;
  let baseTitle = document.title;

  try {
    const q = new URLSearchParams(location.search).get('mc');
    if (q) state.tab = q;
  } catch (_) {}

  function draw() {
    if (!data) return;
    root.innerHTML = renderApp(data, { ...state, now: Date.now() }) + '<div class="toast" role="status" aria-live="polite"></div>';
    if (Date.now() < flashUntil) {
      const hero = root.querySelector('.hero');
      if (hero) hero.insertAdjacentHTML('afterbegin', `<div class="goalflash">Goal! ${escapeHtml(resultText(data))}</div>`);
    }
  }
  function toast(t) {
    const el = root.querySelector('.toast'); if (!el) return;
    el.textContent = t; el.classList.add('on');
    setTimeout(() => el.classList.remove('on'), 2400);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function cadence() {
    if (!data || !data.fixture) return 300000;
    const ph = phaseOf(data);
    if (ph === 'live') return 15000;
    const toKo = koDate(data.fixture) - Date.now();
    if (ph === 'buildup' && toKo < 2 * 3600e3) return 30000;   // team news window and the run-in to kick-off
    if (ph === 'ft') return 60000;
    return 300000;
  }
  async function load() {
    try {
      const r = await fetch(API + '/api/live', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const next = await r.json();
      const sameMatch = data && data.fixture && next.fixture && data.fixture.id === next.fixture.id;
      if (sameMatch && goalCount(next) > goalCount(data) && phaseOf(next) === 'live') {
        flashUntil = Date.now() + 60000;
        document.title = 'GOAL! ' + resultText(next) + ' | ' + baseTitle;
        setTimeout(() => { document.title = baseTitle; }, 60000);
      }
      data = next;
      draw();
    } catch (e) {
      // Keep what is on screen; the next poll will try again.
    }
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(load, cadence());
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load(); else clearTimeout(timer);
  });
  // Tick the countdown and "updated N ago" without refetching
  setInterval(() => {
    root.querySelectorAll('[data-ko]').forEach(el => { el.textContent = countdown(new Date(el.getAttribute('data-ko')), Date.now()); });
    root.querySelectorAll('[data-upd]').forEach(el => {
      const t = ago(el.getAttribute('data-upd'), Date.now());
      el.textContent = el.classList.contains('upd') ? 'Updated ' + t : t;
    });
  }, 15000);

  root.addEventListener('click', e => {
    const t = e.target.closest('[data-tab]');
    if (t) { state.tab = t.getAttribute('data-tab'); draw(); if (!t.closest('.tabs')) root.querySelector('.tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const v = e.target.closest('[data-view]');
    if (v) { state.view = v.getAttribute('data-view'); state.tab = null; state.side = 'celtic'; draw(); root.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const s = e.target.closest('[data-side]');
    if (s) { state.side = s.getAttribute('data-side'); draw(); return; }
    if (e.target.closest('[data-allstats]')) { state.showAll = !state.showAll; draw(); return; }
    if (e.target.closest('[data-share]')) {
      const txt = `FT: ${resultText(data)} | Celtic Match Centre`;
      const url = location.href.split('#')[0];
      if (navigator.share) { navigator.share({ title: txt, text: txt, url }).catch(() => {}); return; }
      try { navigator.clipboard.writeText(`${txt} ${url}`).then(() => toast('Copied — paste it anywhere'), () => toast(txt)); } catch (_) { toast(txt); }
    }
  });

  load();
}
