// Stream Bingo website with rooms. No dependencies: needs Node 22.4 or newer.
//   /                  home page: featured rooms, live games, make a room
//   /<room>/           a room's public page   (/<room>/admin, /<room>/mod)
//   /site-admin        the site owner's page: every room, dedicated rooms, deleting rooms
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./src/game');
const rooms = require('./src/rooms');

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---- passwords ----
// The admin password from before rooms (ADMIN_PASSWORD, else data/admin-password.txt, made once). The game that
// existed before rooms keeps it as its room password. The site owner's password is SITE_ADMIN_PASSWORD, or this one.
function oldAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, 'admin-password.txt');
  try { const pw = fs.readFileSync(f, 'utf8').trim(); if (pw) return pw; } catch {}
  const pw = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(f, pw + '\n');
  console.log(`\nNo ADMIN_PASSWORD set. A password was generated and saved in ${f}\nSite admin password: ${pw}\n`);
  return pw;
}
const OLD_PW = oldAdminPassword();
const SITE_PW = process.env.SITE_ADMIN_PASSWORD || OLD_PW;
rooms.init({ legacyPassword: OLD_PW });

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const siteOk = (given) => !!given && same(given, SITE_PW);
const MAX_BG_BYTES = Math.max(1, Number(process.env.MAX_BACKGROUND_MB) || 4) * 1024 * 1024;

// ---- client address ----
// By default only the TCP socket address is used: X-Forwarded-For is written by the caller and can say anything.
// Behind N reverse proxies (each appending the address it saw), set TRUST_PROXY_HOPS=N to use the entry N hops
// from the right, which the nearest trusted proxy wrote. The leftmost entry is never used.
const TRUST_PROXY_HOPS = (() => { const n = Number(process.env.TRUST_PROXY_HOPS); return Number.isInteger(n) && n > 0 ? n : 0; })();
function clientIp(req) {
  const sock = req.socket.remoteAddress || '';
  if (!TRUST_PROXY_HOPS) return sock;
  const h = req.headers['x-forwarded-for'];
  if (!h) return sock;
  const parts = String(h).split(',').map((s) => s.trim());
  if (parts.length < TRUST_PROXY_HOPS) return sock;
  return parts[parts.length - TRUST_PROXY_HOPS] || sock;
}

// ---- small rate limiter ----
// Per-address counters. Map order = least recently used first, so when the map is full the oldest
// addresses are dropped. Only per-address keys live here.
const MAX_ADDR_KEYS = 5000;
const buckets = new Map();
function hit(map, k, max, windowMs) {
  const now = Date.now();
  const b = (map.get(k) || []).filter((t) => now - t < windowMs);
  b.push(now);
  if (b.length > max + 1) b.splice(0, b.length - max - 1);   // more is never needed to answer "over the limit?"
  map.delete(k); map.set(k, b);          // move to the newest end
  return b.length > max;
}
function limited(ip, name, max, windowMs) {
  const over = hit(buckets, name + '|' + ip, max, windowMs);
  while (buckets.size > MAX_ADDR_KEYS) buckets.delete(buckets.keys().next().value);
  return over;
}
// Site-wide counters are kept apart from the per-address map, so no amount of addresses can evict them.
// Keys here are fixed names, at most one per counter per room.
const globalBuckets = new Map();
const limitedGlobal = (name, max, windowMs) => hit(globalBuckets, name, max, windowMs);
// how many hits a counter has in the window, without adding one
const count = (map, k, windowMs) => { const now = Date.now(); return (map.get(k) || []).filter((t) => now - t < windowMs).length; };

// Wrong passwords are limited per address (8) AND in total (60) per 10 minutes, counted separately for each room
// and page. A correct password is always checked first, so the real admin is never locked out by someone guessing.
function tooManyBad(ip, name) {
  const perAddr = limited(ip, name, 8, 10 * 60000);
  const total = limitedGlobal(name, 60, 10 * 60000);
  // also counted across all rooms: one address guessing at many rooms, or many addresses at once
  const anyAddr = limited(ip, 'badpw-any', BAD_ANY_ADDR, 10 * 60000);
  const anyTotal = limitedGlobal('badpw-any', BAD_ANY_TOTAL, 10 * 60000);
  return perAddr || total || anyAddr || anyTotal;
}
// Checking a room password costs real CPU (scrypt), so once an address, or the whole site, has made this many wrong
// guesses in 10 minutes, new checks are refused before any hashing. Passwords that worked recently (and the site
// owner's) are still recognised, because those checks are cheap.
const BAD_ANY_ADDR = 20, BAD_ANY_TOTAL = 300;
const hashingPaused = (ip) => count(buckets, 'badpw-any|' + ip, 10 * 60000) >= BAD_ANY_ADDR || count(globalBuckets, 'badpw-any', 10 * 60000) >= BAD_ANY_TOTAL;

// a room's admin page: that room's password, or the site owner's. Returns 'ok', 'wrong' or 'paused'.
async function roomAdminAuth(e, given, ip) {
  if (!given) return 'wrong';
  if (siteOk(given) || rooms.passwordCached(e.game, given)) return 'ok';
  if (hashingPaused(ip)) return 'paused';
  return (await rooms.passwordCheck(e.game, given)) ? 'ok' : 'wrong';
}
// a room's mod page: the room's mod password, or anything that opens its admin page
async function roomModAuth(e, given, ip) {
  if (given && same(given, e.game.state.settings.modPassword)) return 'ok';
  return roomAdminAuth(e, given, ip);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('Upload too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readJson = async (req) => { const b = await readBody(req, 300000); try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); } };

function send(res, code, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function sendFile(res, file, extra = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(buf);
  });
}
// Content-Security-Policy: pages may only load from and talk to this site. Pages with passwords may not be shown inside
// another site's frame (clickjacking); viewer pages may (some streamers embed them).
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'";
const page = (res, name, { framable = false } = {}) => sendFile(res, path.join(PUB, name), {
  'Cache-Control': 'no-cache', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': CSP + (framable ? '' : "; frame-ancestors 'none'"), ...(framable ? {} : { 'X-Frame-Options': 'DENY' }),
});
const redirect = (res, to, code = 302) => { res.writeHead(code, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };

function sniff(buf) {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const roomInfo = (e) => {
  const r = e.game.state.room;
  return { name: e.game.slug, kind: r.kind, listed: r.listed !== false, chatAwake: e.chat.running, idleHours: rooms.CHAT_IDLE_MS / 3600000, expireDays: rooms.EXPIRE_MS / 86400000 };
};

// ---- a room's admin page actions ----
const admin = {
  async status(e) {
    rooms.wake(e);   // opening the admin page connects a sleeping room's chat
    const a = e.game.adminState();
    const { modPassword, ...settings } = a.settings;
    return { ...a, settings, room: roomInfo(e), modPassword, modPasswordLocked: false, chat: e.chat.status, chatLog: e.chat.log, hasBackground: fs.existsSync(bgFile(e)) };
  },
  async modpassword(e, b) {
    const pw = str(b.password, 60) || crypto.randomBytes(6).toString('base64url');
    if (pw.length < 6) throw new Error('Use at least 6 characters, or leave it empty to make a random one.');
    e.game.state.settings.modPassword = pw; e.game.save(); return { modPassword: pw };
  },
  async adminpassword(e, b) {
    const pw = str(b.password, 100);
    if (pw.length < 8) throw new Error('Use at least 8 characters.');
    rooms.setPassword(e.game, pw); return {};
  },
  async room(e, b) {
    if ('listed' in b) { e.game.state.room.listed = !!b.listed; e.game.save(); }
    return { room: roomInfo(e) };
  },
  async start(e) { e.game.startGame(); rooms.wake(e); return {}; },
  async end(e) { return { summary: e.game.endGame() }; },
  async mark(e, b) { return e.game.mark(str(b.word, 100), true, 'admin'); },
  async unmark(e, b) { return e.game.mark(str(b.word, 100), false, 'admin'); },
  async phrases(e, b) {
    if (!Array.isArray(b.phrases)) throw new Error('phrases must be a list');
    const list = [...new Set(b.phrases.map((s) => str(s, 80)).filter(Boolean))].slice(0, 300);
    if (list.length < 24) throw new Error(`Need at least 24 different words (got ${list.length}).`);
    e.game.state.settings.phrases = list; e.game.save(); return {};
  },
  async givepoints(e, b) {
    const amt = Math.round(Number(b.amount));
    if (!str(b.name, 40) || !Number.isFinite(amt)) throw new Error('Give a name and a whole number.');
    e.game.givePoints(str(b.name, 40), amt); return {};
  },
  async simulate(e, b) {
    const platform = ['twitch', 'kick', 'youtube', 'rumble'].includes(b.platform) ? b.platform : 'twitch';
    const r = e.game.handleChat({ platform, id: null, userId: null, name: str(b.name, 40) || 'tester', text: str(b.text, 200), roles: { broadcaster: !!b.owner, mod: !!b.mod, vip: !!b.vip } });
    return { result: r || { ok: false, error: 'Ignored: not a command, or not allowed for that role.' } };
  },
  async settings(e, b) {
    const s = e.game.state.settings;
    if (b.channels) {
      const c = b.channels, t = s.channels;
      for (const k of ['twitch', 'kick', 'youtube', 'rumble', 'kickChatroomId', 'kickPusherKey', 'kickPusherCluster']) if (k in c) t[k] = str(c[k], 200).replace(/^#/, '');
      rooms.channelsChanged(e);
    }
    if (b.points) {
      const p = s.points, q = b.points;
      p.currency = str(q.currency, 20) || p.currency;
      for (const [k, lo, hi] of [['starting', 0, 1e6], ['entryBonus', 0, 1e6], ['bingoReward', 0, 1e6], ['blackoutReward', 0, 1e6], ['bingoMultiplier', 0, 100], ['blackoutMultiplier', 0, 100], ['maxWager', 0, 1e6]]) if (k in q) p[k] = clampInt(q[k], lo, hi, p[k]);
    }
    if ('allowLateEntry' in b) s.allowLateEntry = !!b.allowLateEntry;
    if ('countEarlyCalls' in b) s.countEarlyCalls = !!b.countEarlyCalls;
    if ('viewerMarking' in b) s.viewerMarking = !!b.viewerMarking;
    if ('manualMarking' in b) s.manualMarking = !!b.manualMarking;
    if (!s.viewerMarking) s.manualMarking = false;   // no auto-marking only makes sense when viewers can mark
    if ('allowMods' in b) s.allowMods = !!b.allowMods;
    if ('allowVips' in b) s.allowVips = !!b.allowVips;
    if ('title' in b) s.title = str(b.title, 40) || s.title;
    if ('weeklyDay' in b) s.weeklyDay = clampInt(b.weeklyDay, 0, 6, s.weeklyDay);
    if ('weeklyHour' in b) s.weeklyHour = clampInt(b.weeklyHour, 0, 23, s.weeklyHour);
    if (b.layout) {
      const L = s.layout, q = b.layout;
      L.width = clampInt(q.width, 300, 3000, L.width); L.height = clampInt(q.height, 300, 4000, L.height);
      for (const [box, keys] of [['nameBox', ['x', 'y', 'w', 'h']], ['grid', ['x', 'y', 'size']]]) if (q[box]) for (const k of keys) L[box][k] = clampInt(q[box][k], 0, 4000, L[box][k]);
      for (const k of ['accent', 'cellFill', 'cellBorder', 'textColor']) if (k in q) { const v = str(q[k], 40); if (/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(v)) L[k] = v; }
    }
    e.game.save(); return {};
  },
};

// ---- the site owner's actions ----
const getRoom = (name) => { const e = rooms.get(name); if (!e) throw Object.assign(new Error('No such room.'), { status: 404 }); return e; };
const siteAdmin = {
  async status() {
    return { rooms: rooms.list(), site: { openRooms: rooms.site.openRooms !== false, maxRooms: rooms.site.maxRooms, legacyRoom: rooms.site.legacyRoom }, idleHours: rooms.CHAT_IDLE_MS / 3600000, expireDays: rooms.EXPIRE_MS / 86400000 };
  },
  async create(b) {
    const { entry, password } = rooms.create(b.name, { title: b.title, kind: b.dedicated ? 'dedicated' : 'community' });
    if (b.channel) { const ch = entry.game.state.settings.channels; const c = str(b.channel, 60).replace(/^[@#]/, ''); if (b.platform === 'twitch') ch.twitch = c; else ch.kick = c; entry.game.save(); }
    rooms.channelsChanged(entry);
    return { name: entry.game.slug, password, modPassword: entry.game.state.settings.modPassword };
  },
  async update(b) {
    const e = getRoom(b.name), r = e.game.state.room;
    if ('dedicated' in b) r.kind = b.dedicated ? 'dedicated' : 'community';
    if ('listed' in b) r.listed = !!b.listed;
    r.lastActive = Date.now(); e.game.save(); rooms.tick();
    return { room: rooms.summary(e.game.slug, e) };
  },
  async resetpw(b) { const e = getRoom(b.name); const pw = rooms.newPassword(); rooms.setPassword(e.game, pw); return { password: pw }; },
  async delete(b) {
    const e = getRoom(b.name);
    if (str(b.confirm, 40).toLowerCase() !== e.game.slug) throw new Error('Type the room name to confirm.');
    rooms.remove(e.game.slug); return {};
  },
  async settings(b) {
    if ('openRooms' in b) rooms.site.openRooms = !!b.openRooms;
    if ('maxRooms' in b) rooms.site.maxRooms = clampInt(b.maxRooms, 0, 100000, rooms.site.maxRooms);
    rooms.saveSite(); return {};
  },
};

// ---- the home page's room list and "make a room" ----
function directory() {
  const all = rooms.list().filter((r) => r.listed);
  const pick = (r) => ({ name: r.name, title: r.title, live: r.live, players: r.players, channels: { twitch: r.channels.twitch, kick: r.channels.kick } });
  return {
    featured: all.filter((r) => r.kind === 'dedicated').sort((a, b) => b.live - a.live || b.players - a.players || a.name.localeCompare(b.name)).map(pick),
    live: all.filter((r) => r.kind !== 'dedicated' && r.live).sort((a, b) => b.players - a.players).slice(0, 30).map(pick),
    openRooms: rooms.site.openRooms !== false,
  };
}
async function createRoom(req, res, ip) {
  if (rooms.site.openRooms === false) return send(res, 403, { error: 'Making new rooms is switched off right now.' });
  // JSON only: a plain form on another website cannot send that without the browser asking this site first (and it says no)
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Send JSON.' });
  const b = await readJson(req);
  let name;
  try { name = rooms.checkName(b.name); } catch (e) { return send(res, 400, { error: e.message }); }
  if (rooms.get(name)) return send(res, 409, { error: 'That room name is taken. Pick another one.' });
  const community = rooms.list().filter((r) => r.kind !== 'dedicated').length;
  if (community >= rooms.site.maxRooms) return send(res, 503, { error: 'The site is full right now. Try again later.' });
  if (limited(ip, 'create', 3, 3600000)) return send(res, 429, { error: 'You made a few rooms already. Try again in an hour.' });
  if (limitedGlobal('create', 40, 3600000)) return send(res, 429, { error: 'Lots of rooms were made in the last hour. Try again later.' });
  try {
    const { entry, password } = rooms.create(name, { title: str(b.title, 40) });
    return send(res, 200, { ok: true, name: entry.game.slug, password, modPassword: entry.game.state.settings.modPassword });
  } catch (e) { return send(res, e.status || 400, { error: e.message }); }
}

const bgFile = (e) => path.join(e.game.dir, 'background.img');

// ---- one room: /<room>/... ----
async function handleRoom(req, res, e, rest, url, ip) {
  const name = e.game.slug, game = e.game;
  if (rest === '/') return page(res, 'index.html', { framable: true });
  if (rest === '/admin') return page(res, 'admin.html');
  if (rest === '/mod') return page(res, 'mod.html');
  if (rest === '/api/state') {
    // every viewer's page asks for this every 5 seconds, so the answer is reused for a second
    const now = Date.now();
    if (!e.stateCache || now - e.stateCache.t > 1000) e.stateCache = { t: now, body: JSON.stringify({ ...game.publicState(), room: name, hasBackground: fs.existsSync(bgFile(e)) }) };
    return send(res, 200, e.stateCache.body, { 'Content-Type': 'application/json' });
  }
  if (rest === '/api/card') {
    if (limited(ip, 'card', 60, 60000)) return send(res, 429, { error: 'Slow down a little.' });
    return send(res, 200, { matches: game.lookup(url.searchParams.get('name') || '') });
  }
  if (rest === '/background') {
    if (!fs.existsSync(bgFile(e))) return send(res, 404, 'No background');
    return sendFile(res, bgFile(e), { 'Content-Type': (game.state.settings.backgroundType || 'image/png'), 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  if (rest.startsWith('/api/admin/')) {
    if (limited(ip, 'admin', 120, 60000)) return send(res, 429, { error: 'Too many requests.' });
    const auth = await roomAdminAuth(e, req.headers['x-admin-password'] || '', ip);
    if (auth === 'paused') return send(res, 429, { error: 'Too many wrong passwords. Try again in 10 minutes.' });
    if (auth !== 'ok') {
      if (tooManyBad(ip, 'badpw:' + name)) return send(res, 429, { error: 'Too many wrong passwords. Try again in 10 minutes.' });
      return send(res, 401, { error: 'Wrong password.' });
    }
    e.stateCache = null;
    const action = rest.slice('/api/admin/'.length);
    try {
      if (action === 'background') {
        if (req.method === 'DELETE') { try { fs.unlinkSync(bgFile(e)); } catch {} game.state.settings.backgroundVersion++; game.save(); return send(res, 200, {}); }
        const buf = await readBody(req, MAX_BG_BYTES);
        const type = sniff(buf);
        if (!type) throw new Error('Please upload a PNG, JPG or WEBP image.');
        fs.writeFileSync(bgFile(e), buf); game.state.settings.backgroundType = type; game.state.settings.backgroundVersion++; game.save();
        return send(res, 200, {});
      }
      if (!Object.hasOwn(admin, action)) return send(res, 404, { error: 'Unknown action' });
      const body = action === 'status' ? {} : await readJson(req);
      return send(res, 200, { ok: true, ...(await admin[action](e, body)) });
    } catch (err) { return send(res, err.status || 400, { error: err.message }); }
  }

  // ---- mod page: may only look at the word list and call or un-call words ----
  if (rest.startsWith('/api/mod/')) {
    if (limited(ip, 'mod', 120, 60000)) return send(res, 429, { error: 'Too many requests.' });
    const auth = await roomModAuth(e, req.headers['x-mod-password'] || '', ip);
    if (auth === 'paused') return send(res, 429, { error: 'Too many wrong passwords. Try again in 10 minutes.' });
    if (auth !== 'ok') {
      if (tooManyBad(ip, 'badmodpw:' + name)) return send(res, 429, { error: 'Too many wrong passwords. Try again in 10 minutes.' });
      return send(res, 401, { error: 'Wrong password.' });
    }
    e.stateCache = null;
    const action = rest.slice('/api/mod/'.length);
    try {
      if (action === 'status') { const g = game.adminState().game; return send(res, 200, { ok: true, title: game.state.settings.title, game: g }); }
      if (action === 'mark' || action === 'unmark') {
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
        const b = await readJson(req);
        return send(res, 200, { ok: true, ...game.mark(str(b.word, 100), action === 'mark', 'mod page') });
      }
      return send(res, 404, { error: 'Unknown action' });
    } catch (err) { return send(res, err.status || 400, { error: err.message }); }
  }
  return send(res, 404, 'Not found');
}

const ROOM_PATH = /^\/([A-Za-z0-9][A-Za-z0-9_-]{2,29})(\/.*)?$/;

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = clientIp(req);
  const legacy = rooms.site.legacyRoom && rooms.get(rooms.site.legacyRoom) ? rooms.site.legacyRoom : '';

  // for hosting health checks (Render, Fly.io, Docker, uptime monitors)
  if (p === '/healthz') {
    const all = rooms.list();
    return send(res, 200, { ok: true, rooms: all.length, live: all.filter((r) => r.live).length, chatOn: all.filter((r) => r.chat === 'on').length });
  }

  if (p === '/api/rooms') {
    if (req.method === 'POST') return createRoom(req, res, ip);
    if (limited(ip, 'rooms', 120, 60000)) return send(res, 429, { error: 'Slow down a little.' });
    return send(res, 200, directory());
  }
  if (p.startsWith('/api/site/')) {
    if (limited(ip, 'site', 120, 60000)) return send(res, 429, { error: 'Too many requests.' });
    if (!siteOk(req.headers['x-admin-password'] || '')) {
      if (tooManyBad(ip, 'badsitepw')) return send(res, 429, { error: 'Too many wrong passwords. Try again in 10 minutes.' });
      return send(res, 401, { error: 'Wrong password.' });
    }
    const action = p.slice('/api/site/'.length);
    if (!Object.hasOwn(siteAdmin, action)) return send(res, 404, { error: 'Unknown action' });
    try { return send(res, 200, { ok: true, ...(await siteAdmin[action](action === 'status' ? {} : await readJson(req))) }); }
    catch (err) { return send(res, err.status || 400, { error: err.message }); }
  }

  // addresses from before rooms lead to the room that game became
  if (legacy) {
    if (p === '/' && url.searchParams.has('u')) return redirect(res, `/${legacy}/${url.search}`);
    if (p === '/admin' || p === '/mod') return redirect(res, `/${legacy}${p}`);
    if (p.startsWith('/api/') || p === '/background') return handleRoom(req, res, rooms.get(legacy), p, url, ip);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && !p.includes('/api/')) return send(res, 405, 'Method not allowed');
  if (p === '/') return page(res, 'home.html', { framable: true });
  if (p === '/site-admin') return page(res, 'site-admin.html');

  const m = ROOM_PATH.exec(p);
  if (m) {
    const name = m[1].toLowerCase();
    const e = rooms.get(name);
    if (!e) return (m[2] || '/').startsWith('/api/') ? send(res, 404, { error: 'No such room.' }) : redirect(res, '/?missing=' + encodeURIComponent(name));
    if (m[1] !== name || !m[2]) return redirect(res, `/${name}${m[2] || '/'}${url.search}`, 301);
    return handleRoom(req, res, e, m[2], url, ip);
  }

  // shared files: scripts, styles, images (the pages themselves are only served through the addresses above)
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (path.extname(p) === '.html') return send(res, 404, 'Not found');
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) return send(res, 403, 'Forbidden');
  return sendFile(res, file, { 'Cache-Control': 'no-cache' });
}

const server = http.createServer((req, res) => handle(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: 'Server error' }); } catch {} }));
// slow or stuck clients are cut off instead of holding a connection open
server.headersTimeout = 20000; server.requestTimeout = 60000; server.keepAliveTimeout = 10000;
server.listen(PORT, () => {
  console.log(`Stream Bingo running on http://localhost:${PORT}  (${rooms.count} rooms, site admin: /site-admin)`);
  rooms.tick();
});
setInterval(() => rooms.tick(), 60000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { rooms.saveAll(); process.exit(0); });
module.exports = { server };
