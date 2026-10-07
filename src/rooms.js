// All the rooms on this site. Each room is its own game (src/game.js) with its own chat readers (src/chat),
// kept in DATA_DIR/rooms/<name>/state.json (+ background.img).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRoom, DATA_DIR } = require('./game');
const { createChat } = require('./chat');

const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const TRASH_DIR = path.join(DATA_DIR, 'deleted-rooms');
const SITE_FILE = path.join(DATA_DIR, 'site.json');

const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d; };
const CHAT_IDLE_MS = num(process.env.CHAT_IDLE_HOURS, 6) * 3600000;   // community rooms disconnect chat after this long unused
const EXPIRE_MS = num(process.env.ROOM_EXPIRE_DAYS, 90) * 86400000;   // community rooms are removed after this long unused (0 = never)
const MAX_AWAKE = num(process.env.MAX_AWAKE_ROOMS, 100);                // most community rooms with chat connected at once
const TRASH_KEEP_MS = num(process.env.DELETED_KEEP_DAYS, 30) * 86400000; // deleted rooms are erased for good after this

// Room names: 3-30 characters, lower case letters, numbers, - and _ (so Twitch and Kick names fit). Words used by the site are kept back.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;
const RESERVED = new Set(['admin', 'mod', 'api', 'site', 'site-admin', 'siteadmin', 'static', 'public', 'assets', 'rooms', 'room', 'new', 'create',
  'healthz', 'health', 'background', 'index', 'home', 'login', 'logout', 'about', 'help', 'support', 'terms', 'privacy', 'www', 'bingo', 'official',
  'staff', 'moderator', 'mods', 'root', 'null', 'undefined', 'favicon', 'robots', 'sitemap', 'deleted-rooms']);

const rooms = new Map();   // name -> { game, chat }
let site = { openRooms: true, maxRooms: num(process.env.MAX_ROOMS, 300), legacyRoom: '' };

function cleanName(v) { return String(v == null ? '' : v).trim().replace(/^@/, '').toLowerCase(); }
function checkName(v) {
  const name = cleanName(v);
  if (!NAME_RE.test(name)) throw new Error('Room names are 3-30 characters: letters, numbers, - and _, starting with a letter or number.');
  if (RESERVED.has(name)) throw new Error('That name is reserved. Pick another one.');
  return name;
}

// ---- passwords: scrypt with a per-room salt; recent correct answers are remembered so pages that poll stay cheap ----
const okCache = new Map();
function setPassword(game, pw) {
  const salt = crypto.randomBytes(16).toString('base64url');
  game.state.room.adminSalt = salt;
  game.state.room.adminHash = crypto.scryptSync(String(pw), salt, 32).toString('base64url');
  game.saveNow();
}
const cacheKey = (r, given) => crypto.createHash('sha256').update(r.adminHash + '\0' + given).digest('base64url');
// cheap: was this exact password accepted for this room recently? (no hashing)
function passwordCached(game, given) {
  const r = game.state.room;
  return !!given && !!r.adminHash && okCache.has(cacheKey(r, given));
}
// the real check. scrypt costs ~50 ms of CPU, so it runs off the main thread and the server keeps answering meanwhile;
// the server also refuses to start more checks for an address (or the whole site) that keeps getting it wrong.
function passwordCheck(game, given) {
  const r = game.state.room;
  if (!given || !r.adminHash) return Promise.resolve(false);
  if (passwordCached(game, given)) return Promise.resolve(true);
  const hashAtStart = r.adminHash;
  return new Promise((resolve) => crypto.scrypt(String(given), r.adminSalt, 32, (err, key) => {
    if (err || hashAtStart !== r.adminHash) return resolve(false);
    const ok = crypto.timingSafeEqual(key, Buffer.from(hashAtStart, 'base64url'));
    if (ok) { okCache.set(cacheKey(r, given), true); if (okCache.size > 2000) okCache.delete(okCache.keys().next().value); }
    resolve(ok);
  }));
}
const newPassword = () => crypto.randomBytes(9).toString('base64url');

function saveSite() { const tmp = SITE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(site, null, 1)); fs.renameSync(tmp, SITE_FILE); }

function open(name) {
  const game = createRoom(path.join(ROOMS_DIR, name));
  game.load();
  if (game.state.room.slug !== name) { game.state.room.slug = name; game.save(); }
  const entry = { game, chat: createChat(game) };
  rooms.set(name, entry);
  return entry;
}

// The single game from before rooms existed (DATA_DIR/state.json) becomes a dedicated room. Its admin password stays
// what it was, so nothing changes for whoever runs it; its address comes from LEGACY_ROOM or its Kick/Twitch channel.
function migrateLegacy(legacyPassword) {
  const old = path.join(DATA_DIR, 'state.json');
  if (!fs.existsSync(old)) return;
  let ch = {};
  try { ch = JSON.parse(fs.readFileSync(old, 'utf8')).settings.channels || {}; } catch {}
  let name = '';
  for (const c of [process.env.LEGACY_ROOM, ch.kick, ch.twitch, 'main']) { try { name = checkName(c); break; } catch {} }
  while (fs.existsSync(path.join(ROOMS_DIR, name))) name = (name + '-1').slice(-30);
  const dir = path.join(ROOMS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(old, path.join(dir, 'state.json'));
  const bg = path.join(DATA_DIR, 'background.img');
  if (fs.existsSync(bg)) fs.renameSync(bg, path.join(dir, 'background.img'));
  const { game } = open(name);
  Object.assign(game.state.room, { kind: 'dedicated', listed: true, created: Date.now(), lastActive: Date.now() });
  if (process.env.MOD_PASSWORD) game.state.settings.modPassword = process.env.MOD_PASSWORD;
  setPassword(game, legacyPassword);
  site.legacyRoom = name; saveSite();
  console.log(`Moved the existing game into the room "${name}" (/${name}/). Its admin password is unchanged.`);
}

function init({ legacyPassword }) {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
  try { site = { ...site, ...JSON.parse(fs.readFileSync(SITE_FILE, 'utf8')) }; } catch {}
  if (process.env.MAX_ROOMS) site.maxRooms = num(process.env.MAX_ROOMS, 300);
  migrateLegacy(legacyPassword);
  for (const name of fs.readdirSync(ROOMS_DIR)) {
    if (rooms.has(name) || !NAME_RE.test(name) || !fs.existsSync(path.join(ROOMS_DIR, name, 'state.json'))) continue;
    try { open(name); } catch (e) { console.error(`Room ${name} could not be loaded:`, e.message); }
  }
  saveSite();
}

function create(rawName, { title, kind = 'community', password } = {}) {
  const name = checkName(rawName);
  if (rooms.has(name) || fs.existsSync(path.join(ROOMS_DIR, name))) throw Object.assign(new Error('That room name is taken. Pick another one.'), { status: 409 });
  const entry = open(name);
  const g = entry.game;
  Object.assign(g.state.room, { kind: kind === 'dedicated' ? 'dedicated' : 'community', listed: true, created: Date.now(), lastActive: Date.now() });
  const t = String(title || '').trim().slice(0, 40);
  g.state.settings.title = t || name.toUpperCase().replace(/[-_]/g, ' ') + ' BINGO';
  const pw = password || newPassword();
  setPassword(g, pw);
  return { entry, password: pw };
}

// Deleted rooms are moved aside (DATA_DIR/deleted-rooms), not erased, so a mistake can be undone by moving the folder back.
function remove(name) {
  const e = rooms.get(name);
  if (!e) throw Object.assign(new Error('No such room.'), { status: 404 });
  e.chat.stopAll();
  try { e.game.saveNow(); } catch {}
  rooms.delete(name);
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const dest = path.join(TRASH_DIR, `${name}-${new Date().toISOString().slice(0, 10)}-${Date.now() % 100000}`);
  fs.renameSync(path.join(ROOMS_DIR, name), dest);
  try { const t = new Date(); fs.utimesSync(dest, t, t); } catch {}
  if (site.legacyRoom === name) { site.legacyRoom = ''; saveSite(); }
}

const isDedicated = (e) => e.game.state.room.kind === 'dedicated';
function awake(e, now = Date.now()) {
  const s = e.game.state;
  return isDedicated(e) || s.game.active || now - (s.room.lastActive || 0) < CHAT_IDLE_MS;
}
// an admin visit or a game start: note it and connect chat if it was asleep
function wake(e) { e.game.touch(); if (!e.chat.running) e.chat.startAll(); }
// channels changed: reconnect now if the room is awake
function channelsChanged(e) { if (awake(e)) e.chat.startAll(); else e.chat.stopAll(); }

// Which community rooms may have chat connected: the ones that are awake, busiest first (running game, then most recently used),
// up to MAX_AWAKE. Featured rooms are always connected and do not count.
function allowedAwake(now) {
  const want = [...rooms].filter(([, e]) => !isDedicated(e) && awake(e, now));
  want.sort(([, a], [, b]) => (b.game.state.game.active - a.game.state.game.active) || ((b.game.state.room.lastActive || 0) - (a.game.state.room.lastActive || 0)));
  return new Set(want.slice(0, MAX_AWAKE).map(([n]) => n));
}

function pruneTrash(now) {
  if (!TRASH_KEEP_MS) return;
  let list = [];
  try { list = fs.readdirSync(TRASH_DIR); } catch { return; }
  for (const d of list) {
    const full = path.join(TRASH_DIR, d);
    try { if (now - fs.statSync(full).mtimeMs > TRASH_KEEP_MS) fs.rmSync(full, { recursive: true, force: true }); } catch {}
  }
}

let lastPrune = 0;
function tick(now = Date.now()) {
  if (now - lastPrune > 3600000) { lastPrune = now; pruneTrash(now); }
  const allowed = allowedAwake(now);
  for (const [name, e] of [...rooms]) {
    try {
      e.game.tickWeek();
      const s = e.game.state;
      if (!isDedicated(e) && EXPIRE_MS && !s.game.active && now - (s.room.lastActive || s.room.created || 0) > EXPIRE_MS) {
        console.log(`Room ${name} was unused for ${Math.round(EXPIRE_MS / 86400000)} days and was removed.`);
        remove(name); continue;
      }
      const on = isDedicated(e) || allowed.has(name);
      if (on && !e.chat.running) e.chat.startAll();
      if (!on && e.chat.running) e.chat.stopAll();
    } catch (err) { console.error(`Room ${name}:`, err.message); }
  }
}

function summary(name, e) {
  const s = e.game.state, g = s.game;
  return {
    name, title: s.settings.title, kind: s.room.kind, listed: s.room.listed !== false,
    live: g.active, players: Object.keys(g.players).length, game: g.number,
    channels: { twitch: s.settings.channels.twitch, kick: s.settings.channels.kick, youtube: s.settings.channels.youtube ? 'yes' : '', rumble: s.settings.channels.rumble ? 'yes' : '' },
    created: s.room.created, lastActive: s.room.lastActive, chat: e.chat.running ? 'on' : 'asleep',
  };
}
const list = () => [...rooms].map(([n, e]) => summary(n, e));

function saveAll() { for (const e of rooms.values()) { try { e.game.saveNow(); } catch {} } }

module.exports = {
  init, create, remove, get: (name) => rooms.get(cleanName(name)), list, summary, tick, wake, awake, channelsChanged, saveAll,
  checkName, passwordCached, passwordCheck, setPassword, pruneTrash, MAX_AWAKE, TRASH_DIR, newPassword, saveSite, isDedicated,
  get site() { return site; }, get count() { return rooms.size; }, ROOMS_DIR, CHAT_IDLE_MS, EXPIRE_MS,
};
