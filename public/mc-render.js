// Celtic Match Centre renderer. Pure functions: data in, HTML string out.
// Used on the server (Vercel fragment for WordPress) and in the browser (live updates),
// so it must not touch the DOM or window.

export const CELTIC = 53;
const FINISHED = new Set(['FT', 'AET', 'FT_PEN', 'POSTPONED', 'CANCELLED', 'ABANDONED', 'AWARDED', 'WO', 'SUSPENDED']);
const UNPLAYED = new Set(['POSTPONED', 'CANCELLED', 'ABANDONED', 'SUSPENDED']);
const STALE_MS = 3 * 60 * 1000;

/* ---------- small helpers ---------- */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = n => String(n || '').replace(/\bSt\. /g, 'St ');
const dash = s => String(s || '').replace('-', '–');
function surname(n) {
  const p = String(n || '').trim().split(/\s+/);
  if (p.length < 2) return n || '';
  return /^(van|de|der|da|dos|di|le|la)$/i.test(p[p.length - 2]) ? p.slice(-2).join(' ') : p[p.length - 1];
}
const koDate = f => new Date(String(f.kickoff_utc).replace(' ', 'T') + 'Z');
const TZ = 'Europe/London';
const ukTime = d => d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const ukDay = (d, long) => d.toLocaleDateString('en-GB', { timeZone: TZ, weekday: long ? 'long' : 'short', day: 'numeric', month: long ? 'long' : 'short' });
const shortDate = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
const plural = (n, w, pl) => `${n} ${n === 1 ? w : (pl || w + 's')}`;
const band = r => r >= 8 ? 'b5' : r >= 7 ? 'b4' : r >= 6.5 ? 'b3' : r >= 6 ? 'b2' : 'b1';
const rt = (r, cls = '') => r == null ? '' : `<span class="rt ${band(r)} ${cls}">${(+r).toFixed(1)}</span>`;
const img = (src, cls = '') => src ? `<img src="${esc(src)}" alt="" class="${cls}" loading="lazy" decoding="async" width="40" height="40">` : `<span class="ph ${cls}"></span>`;

/* ---------- icons ---------- */
const I = {
  goal: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#fff" stroke="#111a15" stroke-width="1.5"/><path d="M10 5.2l3.3 2.4-1.3 3.9H8l-1.3-3.9z" fill="#111a15"/><path d="M10 1.5v3.7M13.3 7.6l3.6-1.1M12 11.5l2.2 3.2M8 11.5l-2.2 3.2M6.7 7.6L3.1 6.5" stroke="#111a15" stroke-width="1.2"/></svg>',
  yellow: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="2.5" width="10" height="15" rx="2" fill="#f2c200"/></svg>',
  red: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="2.5" width="10" height="15" rx="2" fill="#d4112e"/></svg>',
  yr: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="9" height="13.5" rx="2" fill="#f2c200"/><rect x="8" y="4.5" width="9" height="13.5" rx="2" fill="#d4112e"/></svg>',
  sub: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 15V5m0 0L3 8m3-3l3 3" stroke="#026c3d" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M14 5v10m0 0l-3-3m3 3l3-3" stroke="#c8102e" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  var: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="4" width="16" height="11" rx="2" fill="#111a15"/><text x="10" y="12.6" text-anchor="middle" font-size="6.6" font-weight="700" fill="#fff" font-family="Arial,sans-serif">VAR</text><path d="M7 17.5h6" stroke="#111a15" stroke-width="1.6"/></svg>',
  pensave: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#fff" stroke="#c8102e" stroke-width="1.5"/><path d="M6.5 6.5l7 7m0-7l-7 7" stroke="#c8102e" stroke-width="2" stroke-linecap="round"/></svg>',
  down: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12m0 0l-4-4m4 4l4-4" stroke="#6b7780" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>',
  up: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4m0 0L6 8m4-4l4 4" stroke="#026c3d" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>',
  star: '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M10 1.8l2.5 5.3 5.8.7-4.3 4 1.1 5.7L10 14.7l-5.1 2.8L6 11.8l-4.3-4 5.8-.7z" fill="currentColor"/></svg>',
};
const GOAL_TYPES = new Set(['Goal', 'Penalty', 'Owngoal', 'Own Goal']);
function evIcon(t) {
  if (GOAL_TYPES.has(t)) return I.goal;
  return { Yellowcard: I.yellow, Redcard: I.red, Yellowredcard: I.yr, 'Yellow/Red card': I.yr, Substitution: I.sub, VAR: I.var, 'VAR Card': I.var, 'Missed Penalty': I.pensave, 'Penalty Missed': I.pensave }[t] || '';
}

/* ---------- phase + model ---------- */
export function phaseOf(d) {
  if (!d || !d.fixture) return 'none';
  if (d.live) return 'live';
  if (d.result || FINISHED.has(d.state)) return 'ft';
  return 'buildup';
}
function sides(f) {
  const cel = f.home_id === CELTIC ? 'home' : 'away';
  const opp = cel === 'home' ? 'away' : 'home';
  return { cel, opp, oppName: f[opp], oppId: f[opp + '_id'] };
}
function modelFor(d, view) {
  if (view === 'last' && d.last_match) {
    return { ...d.last_match, standings: d.standings, info: null, phase: 'ft', isLast: true, squad: d.squad, nextFixture: d.fixture };
  }
  const phase = phaseOf(d);
  const next = (d.next_fixtures || []).find(x => !d.fixture || x.id !== d.fixture.id) || null;
  return { ...d, phase, nextFixture: next };
}
export const TABS = {
  buildup: [['preview', 'Preview'], ['news', 'Team news'], ['table', 'Table']],
  live: [['match', 'Match'], ['lineups', 'Line-ups'], ['stats', 'Stats'], ['table', 'Table']],
  ft: [['match', 'Match'], ['lineups', 'Line-ups'], ['stats', 'Stats'], ['table', 'Table']],
  none: [['table', 'Table']],
};
export function tabsFor(d, view) {
  const m = modelFor(d, view);
  let t = TABS[m.phase] || TABS.none;
  if (m.phase === 'buildup' && d.lineups_confirmed) t = t.map(([k, l]) => k === 'news' ? [k, 'Line-ups'] : [k, l]);
  if (!(m.standings || []).length) t = t.filter(([k]) => k !== 'table');
  return t;
}

/* ---------- hero ---------- */
function scorersFor(m, side) {
  const by = {};
  (m.events || []).filter(e => GOAL_TYPES.has(e.type) && e.side === side).forEach(g => {
    const k = surname(g.player);
    (by[k] = by[k] || []).push(`${g.minute}${g.extra ? '+' + g.extra : ''}'${g.type === 'Penalty' ? ' pen' : ''}${/own/i.test(g.type) ? ' og' : ''}`);
  });
  return Object.entries(by).map(([k, v]) => `${esc(k)} ${v.join(', ')}`).join('<br>');
}
export function standLine(standings) {
  const t = standings || [];
  const c = t.find(r => r.team_id === CELTIC);
  if (!c || !t.length) return '';
  if (c.pos === 1 && t[1]) {
    const g = c.pts - t[1].pts;
    const gih = (t[1].p ?? 0) < (c.p ?? 0) ? ` (${clean(t[1].team)} have ${plural(c.p - t[1].p, 'game')} in hand)` : '';
    return g === 0 ? `Celtic top on goal difference${gih}` : `Celtic top, ${g} clear${gih}`;
  }
  return `Celtic ${ordinal(c.pos)}, ${t[0].pts - c.pts} behind ${clean(t[0].team)}`;
}
function tvLine(f, info) {
  const club = new RegExp(`^(${[f.home, f.away, clean(f.home), clean(f.away), 'Celtic', 'Rangers'].map(x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*TV$`, 'i');
  const real = ((info && info.tv) || []).filter(n => !club.test(n.trim()));
  if (real.length) return { main: real.slice(0, 2).join(', '), sub: '' };
  const ko = koDate(f);
  const sat3 = ko.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short' }) === 'Sat' && ukTime(ko) === '15:00';
  if (sat3) return { main: 'Not live in the UK', sub: '3pm Saturday blackout' };
  return { main: 'To be confirmed', sub: '' };
}
function countdown(ko, now) {
  const ms = ko - now;
  if (ms <= 0) return 'Kick-off';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), mi = Math.floor(ms % 36e5 / 6e4);
  return 'Kick-off in ' + (d ? d + 'd ' : '') + h + 'h ' + mi + 'm';
}
function ago(iso, now) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso)) / 1000));
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  return m < 60 ? plural(m, 'minute') + ' ago' : 'a while ago';
}
function renderHero(m, d, now) {
  const f = m.fixture, ko = koDate(f);
  let pill, centre, strip;
  if (m.phase === 'buildup') {
    const today = ukDay(ko) === ukDay(now);
    const late = now - ko > 5 * 60 * 1000;
    pill = late ? '<span class="pill live"><i></i>Kick-off · live data on its way</span>' : `<span class="pill">${today ? 'Matchday' : 'Up next'}</span>`;
    centre = `<div class="big">${ukTime(ko)}</div><div class="sub">${ukDay(ko, true)}</div><div class="count" data-ko="${ko.toISOString()}">${countdown(ko, now)}</div>`;
    const tv = tvLine(f, m.info);
    const bits = [`<span>On TV <b>${esc(tv.main)}</b>${tv.sub ? ' · ' + esc(tv.sub) : ''}</span>`];
    if (m.info && m.info.referee) bits.push(`<span>Referee <b>${esc(m.info.referee)}</b></span>`);
    if (m.info && m.info.weather && m.info.weather.temp_c != null) bits.push(`<span>Weather <b>${m.info.weather.temp_c}°C${m.info.weather.desc ? ', ' + esc(m.info.weather.desc) : ''}</b></span>`);
    strip = bits.join('');
  } else {
    const s = m.score || { home: 0, away: 0 };
    const stale = m.phase === 'live' && d.updated_at && (now - new Date(d.updated_at)) > STALE_MS;
    if (m.phase === 'live') {
      const min = m.state === 'HT' ? 'Half time' : `Live ${m.minute ?? ''}${m.minute != null ? "'" : ''}${m.added_time ? ' +' + m.added_time : ''}`;
      pill = `<span class="pill live"><i></i>${min}${stale ? ' · data delayed' : ''}</span>`;
    } else {
      pill = UNPLAYED.has(m.state) ? `<span class="pill ft">${esc(m.state_name || m.state)}</span>` : '<span class="pill ft">Full time</span>';
    }
    const ht = m.half_time && m.half_time.home != null && m.state !== 'HT' ? `HT ${m.half_time.home}–${m.half_time.away}` : '';
    centre = `<div class="big">${s.home ?? 0}<span class="dash">–</span>${s.away ?? 0}</div><div class="sub">${ht}</div>`;
    const sl = standLine(m.standings);
    strip = m.phase === 'live'
      ? `${sl ? `<span>As it stands <b>${esc(sl)}</b></span>` : ''}<span class="upd" data-upd="${esc(d.updated_at || '')}">Updated ${ago(d.updated_at, now)}</span>`
      : `<span>${ukDay(ko, true)}</span>${sl && !m.isLast ? `<span>${esc(sl)}</span>` : ''}`;
  }
  const team = side => `<div class="team ${side}">${img(f[side + '_logo'], 'crest')}<div class="tn"><div class="tname">${esc(clean(f[side]))}</div>${m.phase !== 'buildup' ? `<div class="scorers">${scorersFor(m, side)}</div>` : ''}</div></div>`;
  const back = m.isLast ? `<button class="backbar" data-view="main">← Back to ${esc(clean(m.nextFixture.home))} v ${esc(clean(m.nextFixture.away))}</button>` : '';
  return `<header class="hero">${back}<div class="in">
    <div class="h-top">${pill}<span>${esc(f.league || '')}${f.venue ? ' · ' + esc(f.venue) : ''}</span></div>
    <div class="h-main">${team('home')}<div class="centre">${centre}</div>${team('away')}</div>
    <div class="strip">${strip}</div></div></header>`;
}

/* ---------- shared blocks ---------- */
function teamColour(f, side) { return f[side + '_id'] === CELTIC ? 'c' : 'o'; }
function bars(rows, f) {
  const hc = teamColour(f, 'home'), ac = teamColour(f, 'away');
  return rows.map(([label, hv, av, mode, unit]) => {
    if (hv == null && av == null) return '';
    hv = +hv || 0; av = +av || 0;
    const tot = (hv + av) || 1;
    const better = mode === 'none' ? '' : mode === 'low' ? (hv < av ? 'h' : av < hv ? 'a' : '') : (hv > av ? 'h' : av > hv ? 'a' : '');
    const fmt = v => (Number.isInteger(v) ? v : v.toFixed(1)) + (unit || '');
    return `<div class="bar"><div class="v ${better === 'h' ? 'best' : ''}">${fmt(hv)}</div>
      <div><div class="lab">${esc(label)}</div><div class="track"><div class="half l"><div class="fill ${hc}" style="width:${(hv / tot * 100).toFixed(1)}%"></div></div><div class="half"><div class="fill ${ac}" style="width:${(av / tot * 100).toFixed(1)}%"></div></div></div></div>
      <div class="v r ${better === 'a' ? 'best' : ''}">${fmt(av)}</div></div>`;
  }).join('');
}
function legend(f) {
  const col = side => f[side + '_id'] === CELTIC ? 'var(--mc-celtic)' : 'var(--mc-opp)';
  return `<div class="legend"><span><i style="background:${col('home')}"></i>${esc(clean(f.home))}</span><span>${esc(clean(f.away))}<i style="background:${col('away')}"></i></span></div>`;
}
function possession(m) {
  const s = (m.stats || {})['Ball Possession %'];
  if (!s || s.home == null) return '';
  const hc = teamColour(m.fixture, 'home'), ac = teamColour(m.fixture, 'away');
  return `<div class="poss-lab">Possession</div><div class="poss"><div class="${hc}" style="width:${s.home}%">${s.home}%</div><div class="${ac}" style="width:${s.away}%">${s.away}%</div></div>`;
}
const stat = (m, k) => { const s = (m.stats || {})[k]; return s ? [s.home, s.away] : [null, null]; };
function card(title, body, small = '', cls = '') {
  return `<section class="card ${cls}"><h2>${title}${small ? `<small>${small}</small>` : ''}</h2>${body}</section>`;
}
function keyNumbers(m) {
  if (!m.stats || !Object.keys(m.stats).length) return '';
  const rows = [['Shots', ...stat(m, 'Shots Total')], ['On target', ...stat(m, 'Shots On Target')], ['Big chances', ...stat(m, 'Big Chances Created')], ['Corners', ...stat(m, 'Corners')]];
  return card('Key numbers', `${legend(m.fixture)}${possession(m)}${bars(rows, m.fixture)}<button class="more" data-tab="stats">All stats ›</button>`);
}
function tableCard(m, title, note) {
  const f = m.fixture || {};
  const oppId = f.home_id === CELTIC ? f.away_id : f.home_id;
  const rows = (m.standings || []).map(r => `<tr class="${r.team_id === CELTIC ? 'cel' : r.team_id === oppId ? 'opp' : ''} ${r.pos === 6 ? 'zone' : ''}"><td class="pos">${r.pos ?? ''}</td><td class="tm"><div>${img(r.logo, 'tcrest')}${esc(clean(r.team))}</div></td><td>${r.p ?? ''}</td><td class="hide-s">${r.w ?? ''}</td><td class="hide-s">${r.d ?? ''}</td><td class="hide-s">${r.l ?? ''}</td><td>${r.gd > 0 ? '+' : ''}${r.gd ?? ''}</td><td class="pts">${r.pts ?? ''}</td></tr>`).join('');
  return card(title, `<div class="tablewrap"><table><thead><tr><th>#</th><th class="l">Team</th><th>P</th><th class="hide-s">W</th><th class="hide-s">D</th><th class="hide-s">L</th><th>GD</th><th>Pts</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted note">The line marks the top-six split.</p>`, note || '');
}

/* ---------- build-up ---------- */
function buildupPreview(m, now) {
  const f = m.fixture, { cel, opp, oppName, oppId } = sides(f);
  const t = m.standings || [];
  const c = t.find(r => r.team_id === CELTIC), o = t.find(r => r.team_id === oppId), second = t[1];
  const out = [];
  // The picture (league games only, when both sides are in the table)
  if (c && second && o && /premiership/i.test(f.league || '')) {
    const gap = c.pos === 1 ? c.pts - second.pts : c.pts - t[0].pts;
    const lead = c.pos === 1
      ? (gap > 3 ? 'Celtic will still be top after this round, whatever happens.' : gap > 0 ? 'A win keeps Celtic top.' : 'Level on points at the top: a win matters.')
      : `Celtic are ${t[0].pts - c.pts} behind ${esc(clean(t[0].team))}.`;
    const oppWins = ((m.form || {})[opp] || []).filter(x => x.r === 'W').length;
    out.push(card('The picture', `<div class="gap">
      <div class="box"><div class="n">${ordinal(c.pos)}</div><div class="t">Celtic, ${c.pts} pts from ${c.p}</div></div>
      ${c.pos === 1 ? `<div class="box"><div class="n">+${gap}</div><div class="t">over ${esc(clean(second.team))}${(second.p ?? 0) < (c.p ?? 0) ? `, who have ${c.p - second.p} in hand` : ''}</div></div>` : ''}
      <div class="box"><div class="n o">${ordinal(o.pos)}</div><div class="t">${esc(clean(o.team))}, ${o.pts} pts</div></div></div>
      <p class="lead">${lead} ${esc(clean(oppName))} have won ${oppWins} of their last ${((m.form || {})[opp] || []).length || 5}.</p>`));
  }
  // Form
  if (m.form && (m.form.home || []).length) {
    const fr = side => {
      const team = side === cel ? 'Celtic' : oppName;
      const logo = f[side + '_logo'];
      return `<div class="formrow"><div class="who">${img(logo, 'mini')}${esc(clean(team))}</div><div class="chips">${(m.form[side] || []).map(x => `<div class="chip ${x.r}" title="${esc(clean(x.home))} ${esc(x.score)} ${esc(clean(x.away))}"><b>${x.r}</b><span>${esc(dash(x.score))}</span></div>`).join('')}</div></div>`;
    };
    out.push(card('Form', fr(cel) + fr(opp), 'last five · newest on the right'));
  }
  // Head to head
  if ((m.h2h || []).length) {
    const h = m.h2h; const w = h.filter(x => x.r === 'W').length, dr = h.filter(x => x.r === 'D').length, l = h.filter(x => x.r === 'L').length;
    const lastHome = h.find(x => x.home === 'Celtic' && /premiership/i.test(x.league || ''));
    out.push(card('Head to head', `
      <div class="rec">${w ? `<div style="flex:${w}" class="W">${w}</div>` : ''}${dr ? `<div style="flex:${dr}" class="D">${dr}</div>` : ''}${l ? `<div style="flex:${l}" class="L">${l}</div>` : ''}</div>
      <div class="reclab"><span>Celtic wins</span><span>${dr ? 'Draws · ' : ''}${esc(clean(oppName))} wins</span></div>
      ${lastHome && f.home_id === CELTIC ? `<div class="callout">Last league meeting at Celtic Park: <b>Celtic ${esc(dash(lastHome.score))} ${esc(clean(oppName))}</b>, ${shortDate(lastHome.date)}</div>` : ''}
      <ul class="list">${h.map(x => `<li><span class="grow">${esc(clean(x.home))} v ${esc(clean(x.away))}<span class="meta">${shortDate(x.date)} · ${esc(x.league || '')}</span></span><span class="res">${esc(dash(x.score))}</span><span class="rchip ${x.r}">${x.r}</span></li>`).join('')}</ul>`, `last ${h.length} meetings`));
  }
  // Season so far
  const s = m.season_stats;
  if (s && s.home && s.away) {
    const S = (lab, k, mode, unit, round) => { let a = s.home[k], b = s.away[k]; if (a == null && b == null) return null; if (round) { a = a == null ? a : Math.round(a); b = b == null ? b : Math.round(b); } return [lab, a, b, mode, unit]; };
    const rows = [S('Goals per game', 'goals_pg'), S('Conceded per game', 'conceded_pg', 'low'), S('Clean sheets', 'clean_sheet_pct', 'high', '%', true), S('Possession', 'possession', 'high', '%', true), S('Corners per game', 'corners_pg')].filter(Boolean);
    out.push(card('Season so far', legend(f) + bars(rows, f), `${esc(s.label || 'League')} averages`));
  }
  // Celtic's goals
  const top = (m.squad || []).filter(p => p.g > 0).slice(0, 5);
  if (top.length) {
    const lead = (m.top_scorers || [])[0];
    const joint = lead ? (m.top_scorers || []).filter(x => x.goals === lead.goals).length > 1 : false;
    const call = lead && lead.team_id === CELTIC ? `<div class="callout"><b>${esc(lead.player)}</b> ${joint ? 'is joint top of' : 'leads'} the Premiership scoring chart with ${lead.goals}.</div>` : '';
    out.push(card("Celtic's goals", `${call}<ul class="list scr">${top.map(p => `<li><span class="grow"><b>${esc(p.name)}</b><span class="meta">${plural(p.a, 'assist')} · ${plural(p.starts, 'start')}</span></span><span class="split">${p.pg} league${p.eg ? ` · ${p.eg} Europe` : ''}</span><span class="num">${p.g}</span></li>`).join('')}</ul>`, 'all competitions'));
  }
  return `<div class="col">${out.join('')}</div><div class="col">${matchdayCard(m)}${lastMatchCard(m)}</div>`;
}
function matchdayCard(m) {
  const f = m.fixture, ko = koDate(f), tv = tvLine(f, m.info), i = m.info || {};
  const rows = [['Kick-off', `${ukDay(ko, true)}, ${ukTime(ko)}`], ['Venue', esc(f.venue || '')], ['On TV', `${esc(tv.main)}${tv.sub ? `<br><span class="muted">${esc(tv.sub)}</span>` : ''}`]];
  if (i.referee) rows.push(['Referee', esc(i.referee)]);
  if (i.coaches && i.coaches.home && i.coaches.away) rows.push(['Managers', `${esc(i.coaches.home)} v ${esc(i.coaches.away)}`]);
  if (i.weather && i.weather.temp_c != null) rows.push(['Weather', `${i.weather.temp_c}°C${i.weather.desc ? ', ' + esc(i.weather.desc) : ''}`]);
  return card('Matchday', `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`);
}
function lastMatchCard(m) {
  const lm = m.last_match;
  if (!lm || !lm.fixture || !lm.score) return '';
  const f = lm.fixture;
  const cel = f.home_id === CELTIC ? 'home' : 'away';
  const cs = lm.score[cel], os = lm.score[cel === 'home' ? 'away' : 'home'];
  const r = cs > os ? 'W' : cs < os ? 'L' : 'D';
  return card('Last time out', `<div class="lastm"><span class="rchip ${r}">${r}</span><span class="grow"><b>${esc(clean(f.home))} ${lm.score.home}–${lm.score.away} ${esc(clean(f.away))}</b><span class="meta">${esc(f.league || '')} · ${ukDay(koDate(f))}</span></span></div><button class="btn ghost" data-view="last">Ratings, stats and line-ups ›</button>`);
}
function buildupNews(m, side) {
  const f = m.fixture, { cel, opp, oppName } = sides(f);
  const out = [];
  if (m.lineups_confirmed && m.lineups && (m.lineups[cel] || {}).xi && m.lineups[cel].xi.length) {
    out.push(card('Line-ups', `${sideToggle(m, side)}${pitch(m, side)}`, 'confirmed'));
  }
  const absent = (side, team) => {
    const L = ((m.sidelined || {})[side]) || [];
    return card(esc(clean(team)), L.length ? `<ul class="list">${L.map(p => `<li><span class="grow"><b>${esc(p.player)}</b><span class="meta">${esc(p.type || 'Unavailable')}${p.since ? ' · since ' + shortDate(p.since) : ''}</span></span>${p.missed != null ? `<span class="muted">${plural(p.missed, 'game')} missed</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No absences reported.</p>', L.length ? `${L.length} out` : '');
  };
  out.push(absent(cel, 'Celtic'), absent(opp, oppName));
  if (!m.lineups_confirmed) out.push(card('Line-ups', '<p class="lead">The confirmed XIs land here about an hour before kick-off.</p><p class="muted">Nothing guessed is ever shown as confirmed.</p>'));
  return `<div class="col">${out.join('')}</div><div class="col">${matchdayCard(m)}</div>`;
}

/* ---------- live / full time ---------- */
function eventsList(m, keyOnly, chrono) {
  let ev = (m.events || []).slice();
  if (keyOnly) ev = ev.filter(e => GOAL_TYPES.has(e.type) || /red|var|missed|penalty/i.test(e.type));
  ev.sort((a, b) => (a.minute + (a.extra || 0) / 100) - (b.minute + (b.extra || 0) / 100) || (a.id || 0) - (b.id || 0));
  if (!chrono) ev.reverse();
  const html = ev.map(e => {
    const isGoal = GOAL_TYPES.has(e.type);
    let main = esc(e.player || ''), extra = '';
    if (e.type === 'Substitution') extra = e.related ? `on for ${esc(e.related)}` : 'Substitution';
    else if (isGoal) extra = [e.related ? `Assist: ${esc(e.related)}` : '', e.result ? esc(dash(e.result)) : '', /own/i.test(e.type) ? 'Own goal' : '', e.type === 'Penalty' ? 'Penalty' : ''].filter(Boolean).join(' · ');
    else if (/var/i.test(e.type)) extra = e.info ? esc(e.info) : 'VAR check';
    else if (/missed/i.test(e.type)) extra = 'Penalty missed';
    else if (/card/i.test(e.type)) extra = e.info ? esc(e.info) : 'Booked';
    const side = `<div class="side ${e.side}"><span class="ico">${evIcon(e.type)}</span><span><span class="p">${main}</span><span class="x">${extra}</span></span></div>`;
    const min = `<div class="m">${e.minute ?? ''}${e.extra ? '+' + e.extra : ''}'</div>`;
    return `<li class="${isGoal ? 'goal' : ''}">${e.side === 'home' ? side + min + '<div></div>' : '<div></div>' + min + side}</li>`;
  }).join('');
  return html ? `<ul class="ev">${html}</ul>` : '<p class="muted">Nothing yet.</p>';
}
function celticPlayers(m) {
  const { cel } = sides(m.fixture);
  return Object.entries(m.player_stats || {}).map(([id, p]) => ({ id, ...p })).filter(p => p.side === cel && p.rating != null).sort((a, b) => b.rating - a.rating);
}
function statLine(p) {
  const out = [];
  if (p.g) out.push(plural(p.g, 'goal'));
  if (p.a) out.push(plural(p.a, 'assist'));
  if (p.saves) out.push(plural(p.saves, 'save'));
  if (p.kp) out.push(plural(p.kp, 'key pass', 'key passes'));
  if (p.bcc) out.push(plural(p.bcc, 'big chance') + ' created');
  if (p.sot && !p.g) out.push(`${p.sot} on target`);
  if (p.tkl && out.length < 3) out.push(plural(p.tkl, 'tackle'));
  if (p.clr && out.length < 3) out.push(plural(p.clr, 'clearance'));
  if (p.duels_t && out.length < 3) out.push(`${p.duels || 0}/${p.duels_t} duels won`);
  if (p.pass && out.length < 3) out.push(plural(p.pass, 'pass', 'passes'));
  return out.slice(0, 3).join(' · ');
}
function bestCard(m, title) {
  const ps = celticPlayers(m).slice(0, 3);
  if (!ps.length) return '';
  return card(title, `<ul class="list">${ps.map(p => `<li>${rt(p.rating)}<span class="grow"><b>${esc(p.name)}</b><span class="meta">${statLine(p)}</span></span></li>`).join('')}</ul><button class="more" data-tab="lineups">All ratings ›</button>`, 'match rating');
}
function potmCard(m) {
  const all = Object.values(m.player_stats || {}).filter(p => p.rating != null).sort((a, b) => b.rating - a.rating);
  const p = celticPlayers(m)[0];
  if (!p) return '';
  const isTop = all[0] && all[0].name === p.name;
  return `<section class="card"><span class="star">${I.star} ${isTop ? 'Player of the match' : "Celtic's best"}</span>
    <div class="potm"><div class="score">${p.rating.toFixed(1)}</div><div><div class="nm">${esc(p.name)}</div><div class="line">${statLine(p)}</div></div></div>
    <p class="muted note">Match rating from the data. Everyone's rating is under Line-ups.</p></section>`;
}
function whatItMeans(m) {
  if (m.isLast) return '';
  const sl = standLine(m.standings);
  const nx = m.nextFixture;
  const bits = [];
  if (sl) bits.push(esc(sl) + '.');
  if (nx) bits.push(`Next: <b>${esc(clean(nx.home))} v ${esc(clean(nx.away))}</b>, ${ukDay(koDate(nx))} ${ukTime(koDate(nx))}.`);
  if (!bits.length) return '';
  return card('What it means', `<p class="lead">${bits.join(' ')}</p><button class="btn" data-share="1">Share the result</button>`);
}
function matchTab(m, now) {
  const ev = card(m.phase === 'live' ? 'Latest' : 'Key moments', eventsList(m, m.phase !== 'live', m.phase !== 'live') + (m.phase !== 'live' ? '<button class="more" data-tab="stats">Full timeline ›</button>' : ''), m.phase === 'live' ? 'newest first' : '');
  if (m.phase === 'live') {
    return `<div class="col">${ev}${keyNumbers(m)}${bestCard(m, "Celtic's best so far")}</div><div class="col">${(m.standings || []).length ? tableCard(m, 'As it stands', m.live_table ? 'live table' : '') : ''}</div>`;
  }
  return `<div class="col">${potmCard(m)}${ev}${keyNumbers(m)}</div><div class="col">${whatItMeans(m)}${bestCard(m, "Celtic's best")}</div>`;
}
function sideToggle(m, side = 'celtic') {
  const { oppName } = sides(m.fixture);
  return `<div class="toggle" role="group" aria-label="Team"><button data-side="celtic" aria-pressed="${side === 'celtic'}">Celtic</button><button data-side="opp" aria-pressed="${side === 'opp'}">${esc(clean(oppName))}</button></div>`;
}
function pitch(m, which = 'celtic') {
  const f = m.fixture, { cel, opp } = sides(f);
  const side = which === 'celtic' ? cel : opp, isC = side === cel;
  const L = (m.lineups || {})[side];
  if (!L || !(L.xi || []).length) return '<p class="muted">Line-ups not available.</p>';
  const ps = m.player_stats || {};
  const rows = {};
  L.xi.forEach(p => { const r = +String(p.field || '1:1').split(':')[0]; rows[r] = (rows[r] || 0) + 1; });
  const lines = Math.max(...Object.keys(rows).map(Number));
  const evs = m.events || [];
  const badges = p => {
    let b = '';
    evs.forEach(e => {
      if (e.side === side && e.player === p.name) {
        if (GOAL_TYPES.has(e.type) && !/own/i.test(e.type)) b += `<span class="bd">${I.goal}</span>`;
        if (e.type === 'Yellowcard') b += `<span class="bd">${I.yellow}</span>`;
        if (/^red/i.test(e.type) || e.type === 'Yellowredcard') b += `<span class="bd">${I.red}</span>`;
      }
      if (e.type === 'Substitution' && e.side === side && e.related === p.name) b += `<span class="bd">${I.down}</span>`;
    });
    return b ? `<span class="badges">${b}</span>` : '';
  };
  const players = L.xi.map(p => {
    const [r, c] = String(p.field || '1:1').split(':').map(Number);
    const n = rows[r] || 1;
    const x = 100 - ((c - 0.5) / n * 100);
    const y = 100 - ((r - 0.5) / lines * 92 + 4);
    const st = ps[p.id];
    const gk = r === 1;
    return `<div class="pl" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%"><div class="disc ${isC ? 'c' : 'o'} ${gk && isC ? 'gk' : ''}"><span>${p.num ?? ''}</span>${badges(p)}</div><div class="n">${esc(surname(p.name))}</div>${st && st.rating != null ? rt(st.rating, 'sm') : ''}</div>`;
  }).join('');
  const marks = '<div class="mk half"></div><div class="mk circ"></div><div class="mk box b1"></div><div class="mk box b2"></div><div class="mk box t1"></div><div class="mk box t2"></div>';
  const subsOn = evs.filter(e => e.type === 'Substitution' && e.side === side);
  const bench = (L.bench || []).map(p => {
    const sub = subsOn.find(e => e.player === p.name); const st = ps[p.id];
    return { on: !!sub, html: `<li><span class="ico">${sub ? I.up : ''}</span><span class="grow"><b>${esc(p.name)}</b><span class="meta">${sub ? `On ${sub.minute}' for ${esc(surname(sub.related))}` : (m.phase === 'buildup' ? 'Substitute' : 'Unused')}</span></span>${st && st.rating != null ? rt(st.rating) : ''}</li>` };
  }).sort((a, b) => b.on - a.on).map(x => x.html).join('');
  return `<div class="pitch">${marks}${players}</div>${bench ? `<h3 class="sub-h">Bench${L.formation ? `<small>${esc(L.formation)}</small>` : ''}</h3><ul class="list bench">${bench}</ul>` : ''}`;
}
function lineupsTab(m, side) {
  const ratings = celticPlayers(m);
  const left = card('Line-ups', `${sideToggle(m, side)}${pitch(m, side)}`, m.phase === 'live' ? 'live ratings' : ratings.length ? 'ratings at full time' : '');
  const right = ratings.length ? card('Celtic ratings', `<ul class="list">${ratings.map(p => `<li>${rt(p.rating)}<span class="grow"><b>${esc(p.name)}</b><span class="meta">${p.min ? p.min + ' mins · ' : ''}${statLine(p)}</span></span></li>`).join('')}</ul>
    <p class="muted note">Colours: <span class="rt b5 sm">8+</span> <span class="rt b4 sm">7+</span> <span class="rt b3 sm">6.5+</span> <span class="rt b2 sm">6+</span> <span class="rt b1 sm">&lt;6</span></p>`, 'high to low') : '';
  return `<div class="col">${left}</div><div class="col">${right}</div>`;
}
const STAT_GROUPS = [
  ['Attack', [['Shots', 'Shots Total'], ['On target', 'Shots On Target'], ['Big chances created', 'Big Chances Created'], ['Big chances missed', 'Big Chances Missed', 'low'], ['Shots inside the box', 'Shots Insidebox'], ['Shots outside the box', 'Shots Outsidebox', 'none'], ['Blocked shots', 'Shots Blocked', 'none'], ['Corners', 'Corners'], ['Dangerous attacks', 'Dangerous Attacks']]],
  ['Passing', [['Passes', 'Passes'], ['Pass accuracy', 'Successful Passes Percentage', 'high', '%'], ['Key passes', 'Key Passes'], ['Crosses', 'Total Crosses', 'none'], ['Accurate crosses', 'Accurate Crosses'], ['Successful dribbles', 'Successful Dribbles']]],
  ['Defending', [['Tackles', 'Tackles'], ['Interceptions', 'Interceptions'], ['Duels won', 'Duels Won'], ['Saves', 'Saves'], ['Headers won', 'Successful Headers']]],
  ['Discipline', [['Fouls', 'Fouls', 'low'], ['Yellow cards', 'Yellowcards', 'low'], ['Red cards', 'Redcards', 'low'], ['Offsides', 'Offsides', 'low']]],
];
function statsTab(m, showAll) {
  const st = m.stats || {};
  let count = 0;
  const body = STAT_GROUPS.map(([g, rows], gi) => {
    const avail = rows.filter(r => st[r[1]]);
    count += avail.length;
    const rs = avail.filter((r, i) => showAll || (gi < 2 && i < 5));
    if (!rs.length) return '';
    return `<div class="grp">${g}</div>${bars(rs.map(([lab, k, mode, unit]) => [lab, st[k].home, st[k].away, mode || 'high', unit]), m.fixture)}`;
  }).join('');
  const statsCard = count
    ? card('Match stats', `${legend(m.fixture)}${possession(m)}${body}<button class="more" data-allstats="1">${showAll ? 'Show fewer' : `Show all ${count} stats`}</button><p class="muted note">The bold figure is the better number. Celtic are always green.</p>`)
    : card('Match stats', '<p class="muted">Stats appear once the game is under way.</p>');
  const tl = card('Timeline', eventsList(m, false, m.phase !== 'live'), 'every event');
  return `<div class="col">${statsCard}</div><div class="col">${tl}</div>`;
}

/* ---------- top level ---------- */
export function renderApp(d, state = {}) {
  const now = state.now ? new Date(state.now) : new Date();
  const view = state.view === 'last' && d && d.last_match ? 'last' : 'main';
  if (!d || !d.fixture) {
    const m = { ...(d || {}), phase: 'none', fixture: {} };
    return `<div class="mc-empty">${card('Celtic Match Centre', '<p class="lead">No upcoming Celtic fixture is scheduled yet. Check back soon.</p>')}${(m.standings || []).length ? tableCard(m, 'Premiership') : ''}</div>`;
  }
  const m = modelFor(d, view);
  const side = state.side === 'opp' ? 'opp' : 'celtic';
  const tabs = tabsFor(d, view);
  const tab = tabs.some(([k]) => k === state.tab) ? state.tab : tabs[0][0];
  let body = '';
  if (m.phase === 'buildup') body = tab === 'preview' ? buildupPreview(m, now) : tab === 'news' ? buildupNews(m, side) : `<div class="col">${tableCard(m, 'Premiership')}</div><div class="col">${matchdayCard(m)}</div>`;
  else body = tab === 'match' ? matchTab(m, now) : tab === 'lineups' ? lineupsTab(m, side) : tab === 'stats' ? statsTab(m, !!state.showAll) : `<div class="col">${tableCard(m, m.phase === 'live' ? 'As it stands' : 'Premiership', m.phase === 'live' && m.live_table ? 'updates with every goal' : '')}</div><div class="col"></div>`;
  return `${renderHero(m, d, now)}
    <nav class="tabs" role="tablist" aria-label="Match centre sections">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</nav>
    <div class="grid" data-phase="${m.phase}" data-tabname="${tab}">${body}</div>
    <p class="mc-foot">Data from Sportmonks${d.updated_at ? ` · updated <span data-upd="${esc(d.updated_at)}">${ago(d.updated_at, now)}</span>` : ''}</p>`;
}

/* Short text for the share button and goal alerts */
export function resultText(d) {
  const f = d.fixture; if (!f || !d.score) return '';
  return `${clean(f.home)} ${d.score.home}–${d.score.away} ${clean(f.away)}`;
}
export function goalCount(d) { return d && d.score ? (+d.score.home || 0) + (+d.score.away || 0) : 0; }
export { countdown, ago, koDate, phaseOf as _phase, pitch as _pitch };
