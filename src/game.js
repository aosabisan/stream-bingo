// Game rules, storage and leaderboards for one room. src/rooms.js makes one of these per room.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BUNDLED_DIR = path.join(__dirname, '..', 'data');

const LINES = [];
for (let r = 0; r < 5; r++) LINES.push([0, 1, 2, 3, 4].map((c) => r * 5 + c));
for (let c = 0; c < 5; c++) LINES.push([0, 1, 2, 3, 4].map((r) => r * 5 + c));
LINES.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);

// The starting word list for new rooms: DATA_DIR/words.default.txt if the host made one, else the bundled one.
function defaultPhrases() {
  for (const dir of [DATA_DIR, BUNDLED_DIR]) {
    try {
      const list = fs.readFileSync(path.join(dir, 'words.default.txt'), 'utf8')
        .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      if (list.length) return list;
    } catch {}
  }
  return [];
}

function defaults() {
  return {
    settings: {
      phrases: defaultPhrases(),
      channels: {
        twitch: '', kick: '', youtube: '', rumble: '',
        kickChatroomId: '', kickPusherKey: '32cbd69e4b950bf97679', kickPusherCluster: 'us2',
      },
      points: {
        currency: 'points', starting: 100, entryBonus: 10, bingoReward: 50, blackoutReward: 250,
        bingoMultiplier: 2, blackoutMultiplier: 5, maxWager: 1000,
      },
      allowLateEntry: true,
      countEarlyCalls: false, // new joiners get words called before they joined already marked on their card
      viewerMarking: false, // viewers may click squares on their own card to dab them (only in their browser, never scored)
      manualMarking: false, // with viewerMarking: the public page does not fill in called words, viewers dab their own
      allowMods: true,   // may chat moderators call words with !mark / !unmark
      allowVips: true,   // may chat VIPs call words (the streamer / channel owner always can)
      modPassword: '',   // password for the mod page; made on first start when empty
      weeklyDay: 0,
      weeklyHour: 20,
      title: 'STREAM BINGO',
      // colours of the room's public page (empty = the site's own); hex like #1d1830
      theme: { bg: '', panel: '', accent: '', text: '' },
      backgroundVersion: 0,
      layout: {
        width: 1000, height: 1200,
        nameBox: { x: 50, y: 120, w: 900, h: 90 },
        grid: { x: 50, y: 250, size: 900 },
        accent: '#ff4d6d', cellFill: 'rgba(0,0,0,0.55)', cellBorder: 'rgba(255,255,255,0.6)', textColor: '#ffffff',
      },
    },
    game: { active: false, number: 0, startedAt: 0, phrases: [], called: [], players: {}, bingoOrder: [], blackoutOrder: [], viewMarks: {}, markerCards: {}, cardMarkers: {}, lastActivity: 0 },
    templates: [],   // this room's own saved word lists: [{ id, name, phrases }]
    accounts: {},
    week: { id: '' },
    lastWeek: null,
    feed: [],
    // about the room itself (not shown to viewers): kind is 'dedicated' (made by the site owner, never expires,
    // chat always connected) or 'community' (made from the home page)
    room: { slug: '', kind: 'community', listed: true, created: 0, lastActive: 0, adminHash: '', adminSalt: '', hiddenTemplates: [], reopens: { day: '', count: 0 } },
  };
}

function merge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  if (extra && typeof extra === 'object') for (const k of Object.keys(extra)) out[k] = k in base ? merge(base[k], extra[k]) : extra[k];
  return out;
}

const norm = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();

function createRoom(dir) {
const STATE_FILE = path.join(dir, 'state.json');
let state = defaults();
let saveTimer = null;

function load() {
  fs.mkdirSync(dir, { recursive: true });
  try {
    state = merge(defaults(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // a damaged file is kept aside instead of being overwritten
      try { fs.copyFileSync(STATE_FILE, STATE_FILE + '.broken-' + Date.now()); } catch {}
      console.error(`${STATE_FILE} could not be read, starting fresh (old file kept):`, e.message);
    }
    state = defaults();
  }
  delete state.events; delete state.eventSeq;   // left over from older versions
  if (!state.game.viewMarks) state.game.viewMarks = {};
  if (!state.game.markerCards) state.game.markerCards = {};
  if (!state.game.cardMarkers) state.game.cardMarkers = {};
  if (state.game.active && !state.game.lastActivity) state.game.lastActivity = Date.now();   // games from before idle closing start their clock now
  if (!state.settings.modPassword) {
    state.settings.modPassword = require('crypto').randomBytes(6).toString('base64url');
    saveNow();
  }
  tickWeek();
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 400); }
// something happened in the room (a game, a call, an admin visit): keeps chat awake and the room from expiring
function touch() { const now = Date.now(); if (now - (state.room.lastActive || 0) > 60000) { state.room.lastActive = now; save(); } }

const P = () => state.settings.points;
const keyOf = (platform, userId, name) => `${platform}:${userId ? String(userId) : norm(name)}`;

function feedAdd(type, text) {
  state.feed.unshift({ t: Date.now(), type, text });
  if (state.feed.length > 40) state.feed.length = 40;
}

function getAccount(key, name, platform) {
  let a = state.accounts[key];
  if (!a) {
    // points given with !givepoints before the person ever played
    const early = 'byname:' + norm(name);
    if (state.accounts[early]) { a = state.accounts[early]; delete state.accounts[early]; state.accounts[key] = a; }
    else a = state.accounts[key] = { name, platform, points: P().starting, bingos: 0, blackouts: 0, weekly: 0 };
  }
  a.name = name; a.platform = platform || a.platform;
  return a;
}
function addPoints(a, delta) { a.points += delta; a.weekly += delta; }

// ---------- weekly leaderboard ----------
function weekId(now = new Date()) {
  const { weeklyDay, weeklyHour } = state.settings;
  const d = new Date(now); d.setMinutes(0, 0, 0); d.setHours(weeklyHour);
  d.setDate(d.getDate() - ((d.getDay() - weeklyDay + 7) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function tickWeek() {
  const id = weekId();
  if (state.week.id === id) return;
  if (state.week.id) {
    const rows = Object.values(state.accounts).filter((a) => a.weekly !== 0)
      .sort((a, b) => b.weekly - a.weekly).slice(0, 10)
      .map((a) => ({ name: a.name, platform: a.platform, weekly: a.weekly }));
    state.lastWeek = { id: state.week.id, rows };
    if (rows.length) feedAdd('week', `Weekly winner: ${rows[0].name} (+${rows[0].weekly} ${P().currency})`);
  }
  for (const a of Object.values(state.accounts)) a.weekly = 0;
  state.week = { id };
  save();
}

// ---------- cards ----------
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function newCard(count) {
  const pool = shuffle([...Array(count).keys()].map((i) => i + 1)).slice(0, 24);
  pool.splice(12, 0, 0);
  return pool;
}
const isMarked = (g, p, cell) => cell === 0 || (g.called.includes(cell) && !p.ignored.includes(cell));
const countMarked = (g, p) => p.card.filter((c) => isMarked(g, p, c)).length;
const completedLines = (g, p) => LINES.filter((l) => l.every((i) => isMarked(g, p, p.card[i]))).length;
const neededForLine = (g, p) => Math.min(...LINES.map((l) => l.filter((i) => !isMarked(g, p, p.card[i])).length));

// only: check just these player keys (a new card), instead of every card (after a word is called)
function checkWinners(g, only) {
  const wins = [];
  for (const [key, p] of only ? only.map((k) => [k, g.players[k]]) : Object.entries(g.players)) {
    const a = getAccount(key, p.name, p.platform);
    if (!p.bingo && completedLines(g, p) > 0) {
      p.bingo = true; g.bingoOrder.push(key);
      const pay = P().bingoReward + p.wager * P().bingoMultiplier;
      addPoints(a, pay); a.bingos++;
      wins.push({ type: 'bingo', name: p.name, pay });
      feedAdd('bingo', `BINGO! ${p.name} (+${pay} ${P().currency})`);
    }
    if (!p.blackout && countMarked(g, p) === 25) {
      p.blackout = true; g.blackoutOrder.push(key);
      const pay = P().blackoutReward + p.wager * P().blackoutMultiplier;
      addPoints(a, pay); a.blackouts++;
      wins.push({ type: 'blackout', name: p.name, pay });
      feedAdd('blackout', `BLACKOUT! ${p.name} (+${pay} ${P().currency})`);
    }
  }
  return wins;
}

// ---------- commands ----------
function startGame() {
  const g = state.game;
  if (g.active) throw new Error(`Game #${g.number} is already running.`);
  const phrases = [...new Set(state.settings.phrases.map((s) => s.trim()).filter(Boolean))];
  if (phrases.length < 24) throw new Error(`Need at least 24 words (have ${phrases.length}).`);
  state.game = { active: true, number: g.number + 1, startedAt: Date.now(), lastActivity: Date.now(), phrases, called: [], players: {}, bingoOrder: [], blackoutOrder: [], viewMarks: {}, markerCards: {}, cardMarkers: {} };
  touch();
  feedAdd('start', `Game #${state.game.number} is open. Type !enter in chat to get a card.`);
  save();
  return state.game;
}

function endGame() {
  const g = state.game;
  if (!g.active) throw new Error('No game is running.');
  g.active = false;
  const lost = Object.values(g.players).filter((p) => !p.bingo).reduce((s, p) => s + p.wager, 0);
  const s = { players: Object.keys(g.players).length, bingos: g.bingoOrder.length, blackouts: g.blackoutOrder.length, called: g.called.length, lost };
  feedAdd('end', `Game #${g.number} over: ${s.players} players, ${s.bingos} bingos, ${s.blackouts} blackouts.`);
  save();
  return s;
}

function enter(platform, userId, name, arg) {
  const g = state.game;
  if (!g.active) throw new Error('No bingo game is running.');
  if (!state.settings.allowLateEntry && g.called.length) throw new Error('Entries are closed for this game.');
  const key = keyOf(platform, userId, name);
  if (g.players[key]) throw new Error(`${name} already has a card.`);
  const a = getAccount(key, name, platform);
  let wager = 0;
  const w = String(arg || '').trim().split(/\s+/)[0];
  if (w) {
    wager = w.toLowerCase() === 'all' ? Math.min(a.points, P().maxWager) : /^\d+$/.test(w) ? parseInt(w, 10) : NaN;
    if (Number.isNaN(wager)) throw new Error('Use !enter or !enter 50');
    if (wager > P().maxWager) throw new Error(`Max wager is ${P().maxWager}.`);
    if (wager > a.points) throw new Error(`${name} only has ${a.points} ${P().currency}.`);
  }
  addPoints(a, -wager + P().entryBonus);
  g.players[key] = { name, platform, card: newCard(g.phrases.length), wager, ignored: state.settings.countEarlyCalls ? [] : [...g.called], bingo: false, blackout: false };
  touch(); g.lastActivity = Date.now();
  feedAdd('join', `${name} joined${wager ? ` with a ${wager} ${P().currency} wager` : ''}`);
  const wins = checkWinners(g, [key]);   // nobody else's card changed
  save();
  return { key, wins };
}

function resolve(g, input) {
  const tokens = String(input).split(/[\s,]+/).filter(Boolean).map((t) => t.replace(/^#/, ''));
  if (!tokens.length) throw new Error('Say which word: a number or part of the text.');
  if (tokens.every((t) => /^\d+$/.test(t))) {
    const nums = [...new Set(tokens.map(Number))];
    const bad = nums.filter((n) => n < 1 || n > g.phrases.length);
    if (bad.length) throw new Error(`No word #${bad.join(', #')} (there are ${g.phrases.length}).`);
    return nums;
  }
  const q = String(input).trim().toLowerCase();
  const exact = g.phrases.findIndex((p) => p.toLowerCase() === q);
  if (exact >= 0) return [exact + 1];
  const hits = g.phrases.map((p, i) => [p, i + 1]).filter(([p]) => p.toLowerCase().includes(q));
  if (hits.length === 1) return [hits[0][1]];
  if (!hits.length) throw new Error(`No word contains "${input}".`);
  throw new Error(`Several words match: ${hits.slice(0, 4).map(([p, n]) => `#${n} ${p}`).join(' | ')}. Use the number.`);
}

function mark(input, on, who = 'mod') {
  const g = state.game;
  if (!g.active) throw new Error('No bingo game is running.');
  const nums = resolve(g, input);
  const changed = [];
  for (const n of nums) {
    const has = g.called.includes(n);
    if (on && !has) { g.called.push(n); changed.push(n); }
    if (!on && has) {
      g.called = g.called.filter((x) => x !== n);
      for (const p of Object.values(g.players)) p.ignored = p.ignored.filter((x) => x !== n);
      changed.push(n);
    }
  }
  if (!changed.length) throw new Error(on ? 'Already called.' : 'Not called yet.');
  for (const n of changed) feedAdd(on ? 'call' : 'uncall', `${on ? 'Called' : 'Un-called'} #${n} ${g.phrases[n - 1]} (by ${who})`);
  touch(); g.lastActivity = Date.now();
  const wins = on ? checkWinners(g) : [];
  save();
  return { changed, wins };
}

function givePoints(name, amount) {
  const target = norm(name);
  let a = Object.values(state.accounts).find((x) => norm(x.name) === target);
  if (!a) a = state.accounts['byname:' + target] = { name: String(name).replace(/^@/, ''), platform: '', points: P().starting, bingos: 0, blackouts: 0, weekly: 0 };
  a.points = Math.max(0, a.points + amount);
  save();
  return a;
}

// Entry point for chat lines from any platform. Returns a short result for the admin log.
function handleChat(m) {
  const text = String(m.text || '').trim();
  if (!text.startsWith('!')) return null;
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(' ');
  const ch = state.settings.channels;
  // Twitch and Kick names are unique logins, so matching the channel setting is safe there.
  // YouTube names are display names anyone can copy, so on YouTube only the OWNER badge counts.
  const nameIsOwner = m.platform !== 'youtube' && ch[m.platform] && norm(ch[m.platform]) === norm(m.name);
  const isOwner = m.roles.broadcaster || nameIsOwner;
  const isMod = isOwner || m.roles.mod;
  // The streamer always may. Mods and VIPs may only while the admin page allows them to.
  const s = state.settings;
  const canMark = isOwner || (m.roles.mod && s.allowMods) || (m.roles.vip && s.allowVips);
  try {
    switch (cmd) {
      case '!enter': return { ok: true, ...enter(m.platform, m.userId, m.name, arg) };
      case '!mark': if (!canMark) return null; return { ok: true, ...mark(arg, true, m.name) };
      case '!unmark': if (!canMark) return null; return { ok: true, ...mark(arg, false, m.name) };
      case '!bingostart': if (!isMod) return null; startGame(); return { ok: true };
      case '!bingoend': if (!isMod) return null; endGame(); return { ok: true };
      case '!givepoints': {
        if (!isMod) return null;
        const [who, amt] = arg.split(/\s+/);
        if (!who || !/^-?\d+$/.test(amt || '')) throw new Error('Use !givepoints @name 50');
        givePoints(who, parseInt(amt, 10)); return { ok: true };
      }
      default: return null;
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- idle games ----------
// A running game with nobody joining and no words called for idleMs is closed. The room's admin can re-open the
// same game (same cards, calls and wagers) up to REOPENS_PER_DAY times a day.
const REOPENS_PER_DAY = 3;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function reopensLeft() {
  const r = state.room.reopens || { day: '', count: 0 };
  return REOPENS_PER_DAY - (r.day === today() ? r.count : 0);
}
function idleCheck(now, idleMs) {
  const g = state.game;
  if (!idleMs || !g.active || now - (g.lastActivity || g.startedAt || now) < idleMs) return false;
  g.active = false; g.closedIdle = true; g.closedAt = now;
  feedAdd('end', `Game #${g.number} closed: nobody joined and no words were called for ${Math.round(idleMs / 60000)} minutes.`);
  save();
  return true;
}
function reopen() {
  const g = state.game;
  if (g.active) throw new Error(`Game #${g.number} is already running.`);
  if (!g.closedIdle) throw new Error('Only a game that was closed for being idle can be re-opened. Start a new game instead.');
  const left = reopensLeft();
  if (left <= 0) throw new Error(`This room has re-opened ${REOPENS_PER_DAY} games today already. Start a new game instead.`);
  const r = state.room.reopens && state.room.reopens.day === today() ? state.room.reopens : { day: today(), count: 0 };
  r.count++; state.room.reopens = r;
  g.active = true; g.closedIdle = false; g.closedAt = 0; g.lastActivity = Date.now();
  feedAdd('start', `Game #${g.number} is open again. Type !enter in chat to get a card.`);
  touch(); save();
  return { reopensLeft: left - 1 };
}

// ---------- viewers marking their own cards ----------
// Viewers' own marks (when the admin allows it) only change what they see. They are also sent here, so the admin and
// mod pages can show how many viewers think each not-yet-called word happened. A card whose owner marked all 25
// squares while fewer than 22 are really marked is treated as someone clicking everything, and is not counted.
// Whoever marks is known by their address and a random id their browser keeps ("markers"). Someone who marks squares on
// more than one player's card is not playing their own card, so none of their marks count, on any card.
function findPlayer(g, name, platform) {
  const q = norm(name);
  for (const [key, p] of Object.entries(g.players)) if (norm(p.name) === q && p.platform === platform) return [key, p];
  return [null, null];
}
function noteMarker(g, key, markers) {
  const cm = new Set(g.cardMarkers[key] || []);
  for (const id of markers || []) {
    if (!id) continue;
    const cards = new Set(g.markerCards[id] || []);
    if (cards.size < 5) cards.add(key);   // two is already enough to rule them out; keep the list short
    g.markerCards[id] = [...cards];
    cm.add(id);
  }
  g.cardMarkers[key] = [...cm].slice(-20);
  const ids = Object.keys(g.markerCards);
  if (ids.length > 20000) for (const id of ids.slice(0, ids.length - 20000)) delete g.markerCards[id];
}
// true when someone who marked this card also marked another player's card
const multiMarked = (g, key) => (g.cardMarkers[key] || []).some((id) => (g.markerCards[id] || []).length > 1);

function viewMark(name, platform, n, on, clear, markers) {
  const g = state.game;
  if (!state.settings.viewerMarking) throw new Error('Marking your own card is switched off in this room.');
  if (!g.active) throw new Error('No game is running.');
  const [key, p] = findPlayer(g, name, platform);
  if (!p) throw new Error('No card with that name in this game.');
  noteMarker(g, key, markers);
  if (clear) { delete g.viewMarks[key]; save(); return { marks: [] }; }
  const num = Number(n);
  if (!Number.isInteger(num) || num === 0 || !p.card.includes(num)) throw new Error('That word is not on this card.');
  const set = new Set(g.viewMarks[key] || []);
  if (on) set.add(num); else set.delete(num);
  if (set.size) g.viewMarks[key] = [...set]; else delete g.viewMarks[key];
  save();
  return { marks: [...set] };
}
function viewCounts(g = state.game) {
  const counts = {};
  for (const [key, list] of Object.entries(g.viewMarks || {})) {
    const p = g.players[key];
    if (!p || !list.length) continue;
    if (multiMarked(g, key)) continue;               // marked by someone who also marks other cards: ignored
    const mine = new Set(list);
    const official = countMarked(g, p);
    const covered = p.card.filter((c) => isMarked(g, p, c) || mine.has(c)).length;
    if (covered === 25 && official < 22) continue;   // "marked everything": ignored
    for (const n of mine) if (!g.called.includes(n)) counts[n] = (counts[n] || 0) + 1;
  }
  return counts;
}

// ---------- views for the website ----------
function cardView(p, g, a) {
  // early: the word was called before this player joined, so it does not count on their card
  const cells = p.card.map((n) => (n === 0 ? { free: true, marked: true }
    : { n, text: g.phrases[n - 1], marked: isMarked(g, p, n), early: g.called.includes(n) && p.ignored.includes(n) }));
  return {
    name: p.name, platform: p.platform, gameNumber: g.number, active: g.active,
    cells, marked: countMarked(g, p), needed: neededForLine(g, p), early: cells.filter((c) => c.early).length,
    wager: p.wager, bingo: p.bingo, blackout: p.blackout,
    points: a ? a.points : null, bingos: a ? a.bingos : 0, blackouts: a ? a.blackouts : 0,
  };
}

function lookup(name) {
  const q = norm(name);
  if (!q) return [];
  const g = state.game;
  const out = [];
  for (const [key, a] of Object.entries(state.accounts)) {
    if (norm(a.name) !== q) continue;
    const p = g.players[key];
    out.push(p ? { hasCard: true, ...cardView(p, g, a) }
      : { hasCard: false, name: a.name, platform: a.platform, points: a.points, bingos: a.bingos, blackouts: a.blackouts, active: g.active, gameNumber: g.number });
  }
  // players whose account row is missing (should not happen) still show
  for (const [key, p] of Object.entries(g.players)) if (norm(p.name) === q && !state.accounts[key]) out.push({ hasCard: true, ...cardView(p, g, null) });
  return out;
}


function publicState() {
  tickWeek();
  const g = state.game;
  const rows = (arr) => arr.map((a) => ({ name: a.name, platform: a.platform, points: a.points, weekly: a.weekly, bingos: a.bingos, blackouts: a.blackouts }));
  const all = Object.values(state.accounts);
  const s = state.settings;
  return {
    title: s.title, currency: s.points.currency,
    channels: { twitch: s.channels.twitch, kick: s.channels.kick, youtube: s.channels.youtube, rumble: s.channels.rumble },
    layout: s.layout, backgroundVersion: s.backgroundVersion,
    cards: { clickToMark: !!s.viewerMarking, autoMark: !(s.viewerMarking && s.manualMarking) },
    theme: s.theme,
    rules: { entryBonus: s.points.entryBonus, starting: s.points.starting, bingoReward: s.points.bingoReward, blackoutReward: s.points.blackoutReward, bingoMultiplier: s.points.bingoMultiplier, blackoutMultiplier: s.points.blackoutMultiplier, maxWager: s.points.maxWager },
    game: {
      active: g.active, number: g.number, players: Object.keys(g.players).length, total: g.phrases.length, closedIdle: !!g.closedIdle,
      called: g.called.map((n) => ({ n, text: g.phrases[n - 1] })),
      bingos: g.bingoOrder.length, blackouts: g.blackoutOrder.length,
    },
    board: Object.values(g.players)
      .map((p) => ({ name: p.name, platform: p.platform, marked: countMarked(g, p), needed: neededForLine(g, p), bingo: p.bingo, blackout: p.blackout }))
      .sort((a, b) => b.marked - a.marked || a.needed - b.needed)   // stable: ties keep join order
      .slice(0, 20),
    weekly: rows([...all].filter((a) => a.weekly !== 0).sort((a, b) => b.weekly - a.weekly).slice(0, 10)),
    allTime: rows([...all].sort((a, b) => b.points - a.points).slice(0, 10)),
    lastWeek: state.lastWeek,
    weekStarted: state.week.id,
    feed: state.feed.slice(0, 15),
  };
}

function adminState() {
  const g = state.game, s0 = state.settings;
  return {
    settings: state.settings,
    game: {
      active: g.active, number: g.number, phrases: g.phrases, called: g.called, players: Object.keys(g.players).length,
      closedIdle: !!g.closedIdle, closedAt: g.closedAt || 0, reopensLeft: reopensLeft(), lastActivity: g.lastActivity || 0,
      viewCounts: s0.viewerMarking ? viewCounts(g) : {},
    },
  };
}

return {
  dir, load, saveNow, save, touch, get state() { return state; }, get slug() { return state.room.slug; },
  startGame, endGame, enter, mark, givePoints, handleChat, lookup, publicState, adminState, weekId, tickWeek,
  idleCheck, reopen, reopensLeft, viewMark, viewCounts, multiMarked: (key) => multiMarked(state.game, key), REOPENS_PER_DAY,
};
}

module.exports = { createRoom, norm, defaults, DATA_DIR };
