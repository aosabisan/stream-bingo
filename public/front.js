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
  $('statusText').textContent = g.active ? `Game #${g.number} live · ${g.players} players · ${g.called.length}/${g.total} called` : (g.number ? `Game #${g.number} finished` : 'No game running');

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

// ---- viewer marks: a color dab per square, kept in this browser only and never sent anywhere ----
const DAB_COLORS = ['#ffd23f', '#3ec1ff', '#5be0a0', '#c77dff', '#ff8fab'];
let dabColor = DAB_COLORS[0], cur = null;
try { const c = localStorage.getItem('bingoDabColor'); if (DAB_COLORS.includes(c)) dabColor = c; } catch {}
const memMarks = new Map();   // used as-is when the browser blocks storage
const cardOpts = () => (S && S.cards) || { clickToMark: false, autoMark: true };
const ROOM = location.pathname.split('/')[1] || '';
const marksKey = (m) => `bingoMarks:${ROOM}:${m.gameNumber}:${m.platform}:${String(m.name).toLowerCase()}`;
function getMarks(m) {
  const k = marksKey(m);
  if (memMarks.has(k)) return memMarks.get(k);
  const o = {};
  try {
    const raw = JSON.parse(localStorage.getItem(k) || '{}');
    for (const [i, c] of Object.entries(raw || {})) if (/^\d+$/.test(i) && +i < 25 && DAB_COLORS.includes(c)) o[i] = c;
  } catch {}
  memMarks.set(k, o); return o;
}
function putMarks(m, o) {
  const k = marksKey(m); memMarks.set(k, o);
  try {
    // forget marks from older games so storage does not pile up
    for (let n = localStorage.length - 1; n >= 0; n--) {
      const key = localStorage.key(n);
      if (!key || !key.startsWith('bingoMarks:')) continue;
      const part = key.split(':');
      // older games in this room, or keys in the format from before rooms
      if (/^\d+$/.test(part[1]) || (part[1] === ROOM && +part[2] < m.gameNumber)) localStorage.removeItem(key);
    }
    if (Object.keys(o).length) localStorage.setItem(k, JSON.stringify(o)); else localStorage.removeItem(k);
  } catch {}
}

function drawCard() {
  if (!cur || !S) return;
  const { m, bg } = cur, opt = cardOpts(), marks = opt.clickToMark ? getMarks(m) : {};
  const view = { ...m, cells: m.cells.map((c, i) => ({ ...c, marked: opt.autoMark ? c.marked : !!c.free, early: opt.autoMark ? c.early : false, dab: marks[i] || null })) };
  BingoCard.draw($('card'), view, S.layout, bg, S.title);
  $('card').classList.toggle('dabbable', opt.clickToMark);
  $('dabBar').hidden = !opt.clickToMark; $('dabHint').hidden = !opt.clickToMark;
  $('dabLbl').textContent = opt.autoMark ? 'Tap a square to mark it' : 'Called words are not filled in. Tap squares to mark them';
  $('dabHint').textContent = 'Your marks are only saved on this device. Bingos are still decided by the words that get called' + (opt.autoMark ? '.' : ', not by your marks.');
  const stats = $('stats'); stats.replaceChildren();
  const add = (label, val) => stats.append(el('span', {}, label + ' ', el('b', { textContent: val })));
  add('Game', '#' + m.gameNumber + (m.active ? '' : ' (finished)'));
  if (opt.autoMark) {
    add('Squares', m.marked + '/25');
    if (!m.bingo && m.needed > 0) add('Closest line needs', m.needed + ' more');
    if (m.early) add('Called before you joined (dashed, not counted)', m.early);
  }
  if (opt.clickToMark) add('Your marks', Object.keys(marks).length);
  if (m.wager) add('Wager', m.wager + ' ' + S.currency);
  if (m.points != null) add('Balance', m.points + ' ' + S.currency);
  if (m.bingo) stats.append(el('span', { className: m.blackout ? 'badge black' : 'badge', textContent: m.blackout ? 'BLACKOUT' : 'BINGO' }));
}

function renderSwatches() {
  const box = $('swatches'); box.replaceChildren();
  DAB_COLORS.forEach((c, n) => {
    const b = el('button', { type: 'button', title: 'Marker color ' + (n + 1) });
    b.style.background = c; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(c === dabColor)); b.setAttribute('aria-label', 'Marker color ' + (n + 1));
    b.onclick = () => { dabColor = c; try { localStorage.setItem('bingoDabColor', c); } catch {} renderSwatches(); };
    box.append(b);
  });
}
renderSwatches();
$('card').addEventListener('click', (e) => {
  if (!cur || !cardOpts().clickToMark) return;
  const i = BingoCard.cellAt($('card'), S.layout, e.clientX, e.clientY);
  if (i < 0 || cur.m.cells[i].free) return;
  const o = { ...getMarks(cur.m) };
  if (o[i] === dabColor) delete o[i]; else o[i] = dabColor;   // same color clears, another color repaints
  putMarks(cur.m, o); drawCard();
});
$('dabClear').onclick = () => { if (cur) { putMarks(cur.m, {}); drawCard(); } };

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
