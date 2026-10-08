'use strict';
const $ = (id) => document.getElementById(id);
const el = (tag, props, ...kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); for (const k of kids) e.append(k); return e; };
const PLAT = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', rumble: 'Rumble' };
let S = null, lbMode = 'weekly', matches = [], pick = 0, name = '';

function ago(t) { const s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; }

function renderState() {
  document.title = S.title + (window.TITLE_SUFFIX || '');
  $('title').textContent = S.title;
  const g = S.game, pill = $('status');
  pill.classList.toggle('live', g.active);
  $('statusText').textContent = g.active ? `Game #${g.number} live · ${g.players} players · ${g.called.length}/${g.total} called`
    : g.closedIdle ? `Game #${g.number} paused (no activity)` : (g.number ? `Game #${g.number} finished` : 'No game running');
  applyTheme(S.theme);

  const called = $('called'); called.replaceChildren();
  for (const c of g.called) called.append(el('span', { className: 'chip' }, el('i', { textContent: c.n }), c.text));
  $('calledEmpty').hidden = g.called.length > 0;

  renderLive();
  renderLb();
  const feed = $('feed'); feed.replaceChildren();
  for (const f of S.feed) feed.append(el('li', {}, el('time', { textContent: ago(f.t) }), el('span', { className: f.type, textContent: f.text })));
  if (!S.feed.length) feed.append(el('li', { className: 'empty', textContent: 'Nothing yet.' }));

  const r = S.rules, cur = S.currency;
  const how = $('how'); how.replaceChildren();
  const where = Object.entries(S.channels).filter(([, v]) => v).map(([k]) => PLAT[k]).join(', ');
  [`Type !enter in chat to get a card${where ? ' (' + where + ')' : ''}. You get ${r.entryBonus} ${cur} for joining and start with ${r.starting}.`,
   `Add a wager: !enter 50 or !enter all (up to ${r.maxWager}). A bingo pays ${r.bingoReward} + wager x${r.bingoMultiplier}. A blackout pays ${r.blackoutReward} + wager x${r.blackoutMultiplier} more. No bingo, no wager back.`,
   'Mods and VIPs call words with !mark. Click your name in the top 20, or search for it, to watch your card fill in.'].forEach((t) => how.append(el('li', { textContent: t })));
}

function nameBtn(r) {
  const b = el('button', { type: 'button', className: 'pname', textContent: r.name });
  b.title = 'Show ' + r.name + "'s card";
  b.onclick = () => selectPlayer(r.name, r.platform);
  return b;
}
const isSel = (r) => name && matches[pick] && matches[pick].name.toLowerCase() === r.name.toLowerCase() && matches[pick].platform === r.platform;

function renderLive() {
  const body = $('liveBody'); body.replaceChildren();
  const rows = S.board || [];
  rows.forEach((r, i) => {
    const tr = el('tr', { className: isSel(r) ? 'sel' : '' }, el('td', { className: 'rank', textContent: i + 1 }),
      el('td', { className: 'who' }, nameBtn(r), el('span', { className: 'plat', textContent: PLAT[r.platform] || '' }),
        r.blackout ? el('span', { className: 'badge black sm', textContent: 'BLACKOUT' }) : r.bingo ? el('span', { className: 'badge sm', textContent: 'BINGO' }) : ''),
      el('td', { className: 'n' }, el('span', { className: 'meter' }, el('i', { style: 'width:' + Math.round(r.marked / 25 * 100) + '%' })), r.marked + '/25'));
    body.append(tr);
  });
  $('liveEmpty').hidden = rows.length > 0;
  if (S.game.players > rows.length) body.append(el('tr', {}, el('td'), el('td', { className: 'empty', colSpan: 2, textContent: `+ ${S.game.players - rows.length} more players. Use the search above to find yours.` })));
}

async function selectPlayer(n, platform) {
  name = n; $('nameInput').value = n;
  const u = new URL(location.href); u.searchParams.set('u', n); history.replaceState(null, '', u);
  try { localStorage.setItem('bingoName', n); } catch {}
  matches = []; pick = 0;
  await loadCard(platform);
  $('findH').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderLb() {
  const body = $('lbBody'); body.replaceChildren();
  let rows, key;
  if (lbMode === 'weekly') { rows = S.weekly; key = 'weekly'; $('lbHead').textContent = 'Gained'; }
  else if (lbMode === 'allTime') { rows = S.allTime; key = 'points'; $('lbHead').textContent = S.currency; }
  else { rows = S.lastWeek ? S.lastWeek.rows : []; key = 'weekly'; $('lbHead').textContent = 'Gained'; }
  rows.forEach((r, i) => body.append(el('tr', {}, el('td', { className: 'rank', textContent: i + 1 }),
    el('td', { className: 'who' }, nameBtn(r), el('span', { className: 'plat', textContent: PLAT[r.platform] || '' })),
    el('td', { className: 'n', textContent: (key === 'weekly' && r[key] > 0 ? '+' : '') + r[key] }))));
  $('lbEmpty').hidden = rows.length > 0;
}

async function renderCard() {
  const area = $('cardArea'), nc = $('noCard'), seg = $('platSeg');
  $('dabHint').hidden = true; cur = null;
  if (!name) { area.hidden = true; nc.hidden = true; seg.hidden = true; return; }
  seg.replaceChildren();
  if (matches.length > 1) {
    seg.hidden = false;
    matches.forEach((m, i) => { const b = el('button', { type: 'button', textContent: PLAT[m.platform] || m.platform }); b.setAttribute('aria-pressed', String(i === pick)); b.onclick = () => { pick = i; renderCard(); }; seg.append(b); });
  } else seg.hidden = true;
  const m = matches[pick];
  if (!m) { area.hidden = true; nc.hidden = false; nc.textContent = `Nobody called "${name}" has played yet. Type !enter in chat while a game is open, then check back here.`; return; }
  if (!m.hasCard) {
    area.hidden = true; nc.hidden = false;
    nc.textContent = `${m.name} has ${m.points} ${S.currency} (${m.bingos} bingos, ${m.blackouts} blackouts) but no card in ${m.active ? 'the current game. Type !enter in chat to join.' : 'the last game. Wait for the next game to open.'}`;
    return;
  }
  nc.hidden = true; area.hidden = false;
  const bg = await BingoCard.loadBackground(S.backgroundVersion, S.hasBackground);
  cur = { m, bg };
  drawCard();
}

// ---- viewer marks: a viewer taps a square and it fills in exactly like a called word. Only this viewer sees it,
// and it never counts toward a bingo; it is also sent to the server so the admin can see what viewers think happened ----
let cur = null;
const memMarks = new Map();   // used as-is when the browser blocks storage
const cardOpts = () => (S && S.cards) || { clickToMark: false, autoMark: true };
const ROOM = location.pathname.split('/')[1] || '';
const marksKey = (m) => `bingoMarks2:${ROOM}:${m.gameNumber}:${m.platform}:${String(m.name).toLowerCase()}`;
function getMarks(m) {   // a Set of square positions (0-24)
  const k = marksKey(m);
  if (memMarks.has(k)) return memMarks.get(k);
  const set = new Set();
  try { for (const i of JSON.parse(localStorage.getItem(k) || '[]')) if (Number.isInteger(i) && i >= 0 && i < 25) set.add(i); } catch {}
  memMarks.set(k, set); return set;
}
function putMarks(m, set) {
  const k = marksKey(m); memMarks.set(k, set);
  try {
    // forget marks from older games, and the older formats, so storage does not pile up
    for (let n = localStorage.length - 1; n >= 0; n--) {
      const key = localStorage.key(n);
      if (!key) continue;
      if (key.startsWith('bingoMarks:') || key === 'bingoDabColor') { localStorage.removeItem(key); continue; }   // older formats
      const part = key.split(':');
      if (part[0] === 'bingoMarks2' && part[1] === ROOM && +part[2] < m.gameNumber) localStorage.removeItem(key);
    }
    if (set.size) localStorage.setItem(k, JSON.stringify([...set])); else localStorage.removeItem(k);
  } catch {}
}
// a random id for this browser, so the server can tell one viewer marking several people's cards (those marks are not counted)
let VIEWER = '';
try { VIEWER = localStorage.getItem('bingoViewer') || ''; if (!/^[A-Za-z0-9_-]{8,40}$/.test(VIEWER)) { VIEWER = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[x & 63]).join(''); localStorage.setItem('bingoViewer', VIEWER); } } catch {}
function tellServer(m, body) {
  fetch('api/viewmark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: m.name, platform: m.platform, viewer: VIEWER, ...body }) }).catch(() => {});
}

function drawCard() {
  if (!cur || !S) return;
  const { m, bg } = cur, opt = cardOpts(), mine = opt.clickToMark ? getMarks(m) : new Set();
  // the viewer's own marks look exactly like called words
  const view = { ...m, cells: m.cells.map((c, i) => ({ ...c, marked: (opt.autoMark ? c.marked : !!c.free) || mine.has(i), early: opt.autoMark && !mine.has(i) ? c.early : false })) };
  BingoCard.draw($('card'), view, S.layout, bg, S.title);
  $('card').classList.toggle('dabbable', opt.clickToMark && m.active);
  $('dabBar').hidden = !opt.clickToMark; $('dabHint').hidden = !opt.clickToMark;
  $('dabLbl').textContent = opt.autoMark ? 'Tap a square to mark it yourself' : 'Called words are not filled in. Tap squares to mark them';
  $('dabHint').textContent = 'Your own marks only show on this device. Bingos are decided by the words that get called' + (opt.autoMark ? '.' : ', not by your marks.');
  const stats = $('stats'); stats.replaceChildren();
  const add = (label, val) => stats.append(el('span', {}, label + ' ', el('b', { textContent: val })));
  add('Game', '#' + m.gameNumber + (m.active ? '' : ' (finished)'));
  if (opt.autoMark) {
    add('Squares', m.marked + '/25');
    if (!m.bingo && m.needed > 0) add('Closest line needs', m.needed + ' more');
    if (m.early) add('Called before you joined (dashed, not counted)', m.early);
  }
  if (opt.clickToMark) add('Your marks', mine.size);
  if (m.wager) add('Wager', m.wager + ' ' + S.currency);
  if (m.points != null) add('Balance', m.points + ' ' + S.currency);
  if (m.bingo) stats.append(el('span', { className: m.blackout ? 'badge black' : 'badge', textContent: m.blackout ? 'BLACKOUT' : 'BINGO' }));
}

$('card').addEventListener('click', (e) => {
  if (!cur || !cardOpts().clickToMark || !cur.m.active) return;
  const i = BingoCard.cellAt($('card'), S.layout, e.clientX, e.clientY);
  const cell = i >= 0 && cur.m.cells[i];
  if (!cell || cell.free) return;
  if (cardOpts().autoMark && cell.marked) return;   // already called: nothing to add
  const set = new Set(getMarks(cur.m)), on = !set.has(i);
  if (on) set.add(i); else set.delete(i);
  putMarks(cur.m, set); drawCard();
  tellServer(cur.m, { n: cell.n, on });
});
$('dabClear').onclick = () => { if (cur) { putMarks(cur.m, new Set()); drawCard(); tellServer(cur.m, { clear: true }); } };

// ---- the room's own page colours (set on its admin page) ----
function applyTheme(t) {
  const r = document.documentElement.style, hex = /^#[0-9a-f]{6}$/i;
  const set = (k, v) => (v ? r.setProperty(k, v) : r.removeProperty(k));
  t = t || {};
  const lum = (h) => { const n = parseInt(h.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const bg = hex.test(t.bg) ? t.bg : '', panel = hex.test(t.panel) ? t.panel : '', text = hex.test(t.text) ? t.text : '', accent = hex.test(t.accent) ? t.accent : '';
  set('--bg', bg); set('--panel', panel); set('--fg', text); set('--accent', accent);
  set('--panel2', panel ? `color-mix(in srgb, ${panel} 88%, ${text || '#ffffff'})` : '');
  set('--line', panel ? `color-mix(in srgb, ${panel} 72%, ${text || '#ffffff'})` : '');
  set('--muted', text ? `color-mix(in srgb, ${text} 62%, ${bg || panel || '#130f1f'})` : '');
  set('--accent-fg', accent ? (lum(accent) > 0.35 ? '#111111' : '#ffffff') : '');
  document.documentElement.style.colorScheme = bg && lum(bg) > 0.5 ? 'light' : '';
}

async function loadState() { try { S = await (await fetch('api/state')).json(); renderState(); } catch {} }
async function loadCard(prefer) {
  if (!name) return;
  try {
    const keep = prefer || (matches[pick] && matches[pick].platform);
    matches = (await (await fetch('api/card?name=' + encodeURIComponent(name))).json()).matches || [];
    const idx = matches.findIndex((m) => m.platform === keep); pick = idx >= 0 ? idx : 0;
    if (S) { renderCard(); renderLive(); }
  } catch {}
}

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  name = $('nameInput').value.trim().replace(/^@/, '');
  const u = new URL(location.href); if (name) u.searchParams.set('u', name); else u.searchParams.delete('u');
  history.replaceState(null, '', u);
  try { localStorage.setItem('bingoName', name); } catch {}
  pick = 0; if (!S) await loadState(); await loadCard();
});
document.querySelectorAll('[data-lb]').forEach((b) => b.addEventListener('click', () => {
  lbMode = b.dataset.lb;
  document.querySelectorAll('[data-lb]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  if (S) renderLb();
}));
$('saveBtn').onclick = () => { $('card').toBlob((blob) => { const a = el('a', { href: URL.createObjectURL(blob), download: `bingo-${name}.png` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }); };
$('linkBtn').onclick = async () => { const b = $('linkBtn'); try { await navigator.clipboard.writeText(location.href); b.textContent = 'Copied'; } catch { b.textContent = 'Copy the address bar'; } setTimeout(() => (b.textContent = 'Copy link'), 1800); };

(async () => {
  const q = new URL(location.href).searchParams.get('u');
  let saved = ''; try { saved = localStorage.getItem('bingoName') || ''; } catch {}
  name = (q || saved || '').trim(); $('nameInput').value = name;
  await loadState(); await loadCard();
  setInterval(() => { loadState(); loadCard(); }, 5000);
})();
