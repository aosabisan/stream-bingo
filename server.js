// Stream Bingo website. No dependencies: needs Node 22 or newer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const game = require('./src/game');
const chat = require('./src/chat');

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

game.load();

// ---- admin password: from ADMIN_PASSWORD, else generated once and kept in data/admin-password.txt ----
function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const f = path.join(game.DATA_DIR, 'admin-password.txt');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const pw = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(f, pw + '\n');
  console.log(`\nNo ADMIN_PASSWORD set. A password was generated and saved in ${f}\nAdmin password: ${pw}\n`);
  return pw;
}
const ADMIN_PW = adminPassword();
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const passOk = (given) => crypto.timingSafeEqual(hash(given), hash(ADMIN_PW));
// Mod page password: MOD_PASSWORD if set, otherwise the one kept in settings (made on first start, changeable on the admin page).
const modPw = () => process.env.MOD_PASSWORD || game.state.settings.modPassword;
const modOk = (given) => passOk(given) || crypto.timingSafeEqual(hash(given), hash(modPw()));

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
// Only a handful of fixed keys ever exist here (one per counter name).
const globalBuckets = new Map();
const limitedGlobal = (name, max, windowMs) => hit(globalBuckets, name, max, windowMs);

// Wrong passwords are limited per address (8) AND in total (60) per 10 minutes, with separate totals for
// admin (badpw) and mod (badmodpw). A correct password is always checked first, so the real admin is never
// locked out by someone else guessing.
function tooManyBad(ip, name) {
  const perAddr = limited(ip, name, 8, 10 * 60000);
  const total = limitedGlobal(name, 60, 10 * 60000);
  return perAddr || total;
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

const BG = path.join(game.DATA_DIR, 'background.img');
function sniff(buf) {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

// ---- admin actions ----
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

const admin = {
  async status() {
    const a = game.adminState();
    const { modPassword, ...settings } = a.settings;
    return { ...a, settings, modPassword: modPw(), modPasswordLocked: !!process.env.MOD_PASSWORD, chat: chat.status, chatLog: chat.log, hasBackground: fs.existsSync(BG) };
  },
  async modpassword(b) {
    if (process.env.MOD_PASSWORD) throw new Error('The mod password is set by the MOD_PASSWORD setting on the server, so it cannot be changed here.');
    const pw = str(b.password, 60) || crypto.randomBytes(6).toString('base64url');
    if (pw.length < 6) throw new Error('Use at least 6 characters, or leave it empty to make a random one.');
    game.state.settings.modPassword = pw; game.save(); return { modPassword: pw };
  },
  async start() { game.startGame(); return {}; },
  async end() { return { summary: game.endGame() }; },
  async mark(b) { return game.mark(str(b.word, 100), true, 'admin'); },
  async unmark(b) { return game.mark(str(b.word, 100), false, 'admin'); },
  async phrases(b) {
    if (!Array.isArray(b.phrases)) throw new Error('phrases must be a list');
    const list = [...new Set(b.phrases.map((s) => str(s, 80)).filter(Boolean))].slice(0, 300);
    if (list.length < 24) throw new Error(`Need at least 24 different words (got ${list.length}).`);
    game.state.settings.phrases = list; game.save(); return {};
  },
  async givepoints(b) {
    const amt = Math.round(Number(b.amount));
    if (!str(b.name, 40) || !Number.isFinite(amt)) throw new Error('Give a name and a whole number.');
    game.givePoints(str(b.name, 40), amt); return {};
  },
  async simulate(b) {
    const platform = ['twitch', 'kick', 'youtube', 'rumble'].includes(b.platform) ? b.platform : 'twitch';
    const r = game.handleChat({ platform, id: null, userId: null, name: str(b.name, 40) || 'tester', text: str(b.text, 200), roles: { broadcaster: !!b.owner, mod: !!b.mod, vip: !!b.vip } });
    return { result: r || { ok: false, error: 'Ignored: not a command, or not allowed for that role.' } };
  },
  async settings(b) {
    const s = game.state.settings;
    if (b.channels) {
      const c = b.channels, t = s.channels;
      for (const k of ['twitch', 'kick', 'youtube', 'rumble', 'kickChatroomId', 'kickPusherKey', 'kickPusherCluster']) if (k in c) t[k] = str(c[k], 200).replace(/^#/, '');
      chat.startAll();
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
    game.save(); return {};
  },
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = clientIp(req);

  // for hosting health checks (Render, Fly.io, Docker, uptime monitors)
  if (p === '/healthz') return send(res, 200, { ok: true, game: game.state.game.active ? 'live' : 'idle', chat: Object.fromEntries(Object.entries(chat.status).map(([k, v]) => [k, v.state || 'off'])) });
  if (p === '/api/state') return send(res, 200, { ...game.publicState(), hasBackground: fs.existsSync(BG) });
  if (p === '/api/card') {
    if (limited(ip, 'card', 60, 60000)) return send(res, 429, { error: 'Slow down a little.' });
    return send(res, 200, { matches: game.lookup(url.searchParams.get('name') || '') });
  }
  if (p === '/background') {
    if (!fs.existsSync(BG)) return send(res, 404, 'No background');
    return sendFile(res, BG, { 'Content-Type': (game.state.settings.backgroundType || 'image/png'), 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  if (p.startsWith('/api/admin/')) {
    if (limited(ip, 'admin', 120, 60000)) return send(res, 429, { error: 'Too many requests.' });
    const given = req.headers['x-admin-password'] || '';
    if (!passOk(given)) {
      if (tooManyBad(ip, 'badpw')) return send(res, 429, { error: 'Too many wrong passwords. Try again in 10 minutes.' });
      return send(res, 401, { error: 'Wrong password.' });
    }
    const action = p.slice('/api/admin/'.length);
    try {
      if (action === 'background') {
        if (req.method === 'DELETE') { try { fs.unlinkSync(BG); } catch {} game.state.settings.backgroundVersion++; game.save(); return send(res, 200, {}); }
        const buf = await readBody(req, 12 * 1024 * 1024);
        const type = sniff(buf);
        if (!type) throw new Error('Please upload a PNG, JPG or WEBP image.');
        fs.writeFileSync(BG, buf); game.state.settings.backgroundType = type; game.state.settings.backgroundVersion++; game.save();
        return send(res, 200, {});
      }
      if (!admin[action]) return send(res, 404, { error: 'Unknown action' });
      const body = action === 'status' ? {} : await readJson(req);
      return send(res, 200, { ok: true, ...(await admin[action](body)) });
    } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }

  // ---- mod page: may only look at the word list and call or un-call words ----
  if (p.startsWith('/api/mod/')) {
    if (limited(ip, 'mod', 120, 60000)) return send(res, 429, { error: 'Too many requests.' });
    if (!modOk(req.headers['x-mod-password'] || '')) {
      if (tooManyBad(ip, 'badmodpw')) return send(res, 429, { error: 'Too many wrong passwords. Try again in 10 minutes.' });
      return send(res, 401, { error: 'Wrong password.' });
    }
    const action = p.slice('/api/mod/'.length);
    try {
      if (action === 'status') { const g = game.adminState().game; return send(res, 200, { ok: true, title: game.state.settings.title, game: g }); }
      if (action === 'mark' || action === 'unmark') {
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
        const b = await readJson(req);
        return send(res, 200, { ok: true, ...game.mark(str(b.word, 100), action === 'mark', 'mod page') });
      }
      return send(res, 404, { error: 'Unknown action' });
    } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const clean = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p === '/mod' ? '/mod.html' : p;
  const file = path.normalize(path.join(PUB, clean));
  if (!file.startsWith(PUB + path.sep)) return send(res, 403, 'Forbidden');
  return sendFile(res, file, { 'Cache-Control': 'no-cache' });
}

const server = http.createServer((req, res) => handle(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: 'Server error' }); } catch {} }));
server.listen(PORT, () => {
  console.log(`Stream Bingo running on http://localhost:${PORT}  (admin: /admin, mods: /mod)`);
  if (!process.env.MOD_PASSWORD) console.log(`Mod page password: ${game.state.settings.modPassword}  (change it on the admin page)`);
  chat.startAll();
});
setInterval(() => game.tickWeek(), 60000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { game.saveNow(); process.exit(0); });
