// Game rules, storage and leaderboards for one room. src/rooms.js makes one of these per room.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
        kickChatroomId: '',   // (Kick's Pusher key and cluster are one setting for the whole site, on /site-admin)
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
      // the chat words for getting a card and (streamer and chat mods only) starting a game; the room's admin can rename them
      commands: { enter: '!enter', start: '!start' },
      modPassword: '',   // the shared password for the mod page; made on first start when empty
      sharedModLogin: true,   // may the shared mod password still be used (named mod logins always work)
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
    mods: [],        // named mod logins: [{ id, name, salt, hash, created, lastUsed, calls }] (only a hash of each password)
    modLog: [],      // who called or un-called which word, from where: newest first, last 300
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

// ---- renameable chat commands ----
// Chat lines are dropped unless they start with "!" (see chat/fast.js), so every command keeps the "!".
const COMMAND_DEFAULTS = { enter: '!enter', start: '!start' };
// fixed commands a renamed one may not take over
const FIXED_COMMANDS = ['!mark', '!unmark', '!givepoints', '!bingostart', '!bingoend'];
function cleanCommand(v, label) {
  let c = String(v == null ? '' : v).trim().toLowerCase();
  if (!c.startsWith('!')) c = '!' + c;
  if (!/^![a-z0-9_]{2,20}$/.test(c)) throw new Error(`The ${label} command must be 2 to 20 letters, numbers or _ after the "!" (no spaces).`);
  if (FIXED_COMMANDS.includes(c)) throw new Error(`${c} is already used for something else. Pick another ${label} command.`);
  return c;
}

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
  if (!Array.isArray(state.mods)) state.mods = [];
  if (!Array.isArray(state.modLog)) state.modLog = [];
  state.settings.commands = commandsOk(state.settings.commands);
  // older rooms kept their own copy of Kick's Pusher key; the site-wide one is used now
  delete state.settings.channels.kickPusherKey; delete state.settings.channels.kickPusherCluster;
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
// rev goes up on every change, so cached answers (the card lookups) know when they are out of date
let rev = 0;
function save() { rev++; if (!saveTimer) saveTimer = setTimeout(saveNow, 400); }
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
// the room's command words, falling back to the defaults if a saved file holds something unusable
function commandsOk(c) {
  const out = { ...COMMAND_DEFAULTS };
  for (const k of Object.keys(out)) { try { out[k] = cleanCommand(c && c[k], k); } catch {} }
  if (out.enter === out.start) return { ...COMMAND_DEFAULTS };
  return out;
}
const cmds = () => state.settings.commands || COMMAND_DEFAULTS;
function setCommands(given) {
  const cur = cmds();
  const next = { enter: cleanCommand(given && 'enter' in given ? given.enter : cur.enter, 'join'), start: cleanCommand(given && 'start' in given ? given.start : cur.start, 'start') };
  if (next.enter === next.start) throw new Error('The join and start commands must be different.');
  state.settings.commands = next; save();
  return next;
}
function logAction(who, source, action) {
  state.modLog.unshift({ t: Date.now(), who, source, action, game: state.game.number });
  if (state.modLog.length > 300) state.modLog.length = 300;
}

function startGame() {
  const g = state.game;
  if (g.active) throw new Error(`Game #${g.number} is already running.`);
  const phrases = [...new Set(state.settings.phrases.map((s) => s.trim()).filter(Boolean))];
  if (phrases.length < 24) throw new Error(`Need at least 24 words (have ${phrases.length}).`);
  state.game = { active: true, number: g.number + 1, startedAt: Date.now(), lastActivity: Date.now(), phrases, called: [], players: {}, bingoOrder: [], blackoutOrder: [], viewMarks: {}, markerCards: {}, cardMarkers: {} };
  touch();
  feedAdd('start', `Game #${state.game.number} is open. Type ${cmds().enter} in chat to get a card.`);
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

// What a viewer asked to bet: 0 for no bet, a number, or Infinity for "all"; null when it is not a bet.
function parseBet(arg) {
  const w = String(arg || '').trim().split(/\s+/)[0].toLowerCase();
  if (!w) return 0;
  if (w === 'all') return Infinity;
  return /^\d{1,12}$/.test(w) ? parseInt(w, 10) : null;
}
// A player may add to their bet while their card has fewer than this many squares filled (the free square counts).
const ADD_BET_BELOW = 3;

function enter(platform, userId, name, arg) {
  const g = state.game, E = cmds().enter;
  if (!g.active) throw new Error('No bingo game is running.');
  const want = parseBet(arg);
  if (want === null) throw new Error(`Use ${E}, ${E} 50 or ${E} all`);
  const key = keyOf(platform, userId, name);
  if (g.players[key]) return addBet(g, key, want);
  if (!state.settings.allowLateEntry && g.called.length) throw new Error('Entries are closed for this game.');
  const a = getAccount(key, name, platform);
  // a bet bigger than the balance (or the room's max) bets as much as is allowed instead of being refused
  const wager = Math.max(0, Math.min(want, a.points, P().maxWager));
  addPoints(a, -wager + P().entryBonus);
  g.players[key] = { name, platform, card: newCard(g.phrases.length), wager, ignored: state.settings.countEarlyCalls ? [] : [...g.called], bingo: false, blackout: false };
  touch(); g.lastActivity = Date.now();
  feedAdd('join', `${name} joined${wager ? ` with a ${wager} ${P().currency} wager` : ''}`);
  const wins = checkWinners(g, [key]);   // nobody else's card changed
  save();
  return { key, wins, wager };
}

// Someone who already has a card types the join command with a bet again: it is added to their wager, while their card
// has fewer than ADD_BET_BELOW squares filled. Capped by their balance and by the room's max wager (the total).
function addBet(g, key, want) {
  const p = g.players[key], E = cmds().enter, cur = P().currency;
  if (!want) throw new Error(`${p.name} already has a card. To add to the bet, type ${E} 50 while the card has fewer than ${ADD_BET_BELOW} squares filled.`);
  const filled = countMarked(g, p);
  if (filled >= ADD_BET_BELOW) throw new Error(`${p.name}'s card has ${filled} squares filled. Bets can only be added while it has fewer than ${ADD_BET_BELOW}.`);
  const a = getAccount(key, p.name, p.platform);
  const room = P().maxWager - p.wager;
  if (room <= 0) throw new Error(`${p.name} already bet the most allowed (${P().maxWager} ${cur}).`);
  if (a.points <= 0) throw new Error(`${p.name} has no ${cur} left to bet.`);
  const added = Math.min(want, a.points, room);
  addPoints(a, -added);
  p.wager += added;
  touch(); g.lastActivity = Date.now();
  feedAdd('join', `${p.name} added ${added} ${cur} to their wager (now ${p.wager})`);
  save();
  return { key, wins: [], added, wager: p.wager };
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

function mark(input, on, who = 'mod', source = '') {
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
  const where = source === 'mod page' ? ' on the mod page' : '';
  for (const n of changed) {
    feedAdd(on ? 'call' : 'uncall', `${on ? 'Called' : 'Un-called'} #${n} ${g.phrases[n - 1]} (by ${who}${where})`);
    state.modLog.unshift({ t: Date.now(), who, source: source || 'chat', action: on ? 'called' : 'un-called', n, word: g.phrases[n - 1], game: g.number });
  }
  if (state.modLog.length > 300) state.modLog.length = 300;
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
  const where = 'chat (' + m.platform + ')';
  try {
    // the room's own words for joining and starting (renameable on the admin page)
    const c = cmds();
    if (cmd === c.enter) return { ok: true, ...enter(m.platform, m.userId, m.name, arg) };
    if (cmd === c.start) { if (!isMod) return null; startGame(); logAction(m.name, where, 'started a game'); return { ok: true }; }
    // the join command with the bet stuck on, like !enter10 or !enterall
    if (cmd.startsWith(c.enter)) {
      const glued = cmd.slice(c.enter.length);
      if (/^(\d{1,12}|all)$/.test(glued)) return { ok: true, ...enter(m.platform, m.userId, m.name, glued) };
    }
    switch (cmd) {
      case '!mark': if (!canMark) return null; return { ok: true, ...mark(arg, true, m.name, where) };
      case '!unmark': if (!canMark) return null; return { ok: true, ...mark(arg, false, m.name, where) };
      // older names, kept so existing chat bots and habits still work
      case '!bingostart': if (!isMod) return null; startGame(); logAction(m.name, where, 'started a game'); return { ok: true };
      case '!bingoend': if (!isMod) return null; endGame(); logAction(m.name, where, 'ended the game'); return { ok: true };
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
  feedAdd('start', `Game #${g.number} is open again. Type ${cmds().enter} in chat to get a card.`);
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
    commands: { ...cmds() },
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

// ---------- named mod logins ----------
// Each mod gets their own random password, so calls on the mod page are logged under their name. Passwords are random
// (not chosen by people), so a salted SHA-256 is enough to store them; the plain password is shown to the admin once.
const modHash = (salt, pw) => crypto.createHash('sha256').update(salt + '\0' + pw).digest('base64url');
const newModPassword = () => crypto.randomBytes(9).toString('base64url');
function cleanModName(v) {
  const n = String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, 30);
  if (!n) throw new Error('Give the mod a name (their chat name works well).');
  return n;
}
function addMod(name) {
  const n = cleanModName(name);
  if (state.mods.length >= 50) throw new Error('This room has 50 mod logins already. Remove one first.');
  if (state.mods.some((m) => m.name.toLowerCase() === n.toLowerCase())) throw new Error(`There is already a mod login called "${n}".`);
  const salt = crypto.randomBytes(12).toString('base64url'), password = newModPassword();
  const m = { id: crypto.randomBytes(6).toString('base64url'), name: n, salt, hash: modHash(salt, password), created: Date.now(), lastUsed: 0, calls: 0 };
  state.mods.push(m); save();
  return { id: m.id, name: m.name, password };
}
function resetMod(id) {
  const m = state.mods.find((x) => x.id === id); if (!m) throw new Error('No such mod login.');
  const password = newModPassword(); m.salt = crypto.randomBytes(12).toString('base64url'); m.hash = modHash(m.salt, password); save();
  return { id: m.id, name: m.name, password };
}
function removeMod(id) {
  const n = state.mods.length; state.mods = state.mods.filter((x) => x.id !== id);
  if (state.mods.length === n) throw new Error('No such mod login.');
  save();
}
// the mod whose password this is, or null
function findMod(given) {
  if (!given) return null;
  for (const m of state.mods) {
    const a = Buffer.from(modHash(m.salt, given)), b = Buffer.from(m.hash);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return m;
  }
  return null;
}
function modUsed(m, called) { m.lastUsed = Date.now(); if (called) m.calls = (m.calls || 0) + 1; save(); }
const modList = () => state.mods.map((m) => ({ id: m.id, name: m.name, created: m.created, lastUsed: m.lastUsed, calls: m.calls || 0 }));

function adminState() {
  const g = state.game, s0 = state.settings;
  return {
    settings: state.settings,
    game: {
      active: g.active, number: g.number, phrases: g.phrases, called: g.called, players: Object.keys(g.players).length,
      closedIdle: !!g.closedIdle, closedAt: g.closedAt || 0, reopensLeft: reopensLeft(), lastActivity: g.lastActivity || 0,
      viewCounts: s0.viewerMarking ? viewCounts(g) : {},
    },
    mods: modList(),
    modLog: state.modLog.slice(0, 100),
  };
}

return {
  dir, load, saveNow, save, touch, get rev() { return rev; }, get state() { return state; }, get slug() { return state.room.slug; },
  startGame, endGame, enter, mark, setCommands, givePoints, handleChat, lookup, publicState, adminState, weekId, tickWeek,
  addMod, resetMod, removeMod, findMod, modUsed, modList,
  idleCheck, reopen, reopensLeft, viewMark, viewCounts, multiMarked: (key) => multiMarked(state.game, key), REOPENS_PER_DAY,
};
}

module.exports = { createRoom, norm, defaults, DATA_DIR };
