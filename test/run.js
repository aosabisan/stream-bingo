// Run with: node test/run.js   (uses a temporary data folder, never touches your real data)
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-'));
fs.copyFileSync(path.join(__dirname, '..', 'data', 'words.default.txt'), path.join(tmp, 'words.default.txt'));
process.env.DATA_DIR = tmp; process.env.BINGO_NO_SEED = '1'; process.env.ADMIN_PASSWORD = 'pw-test'; process.env.PORT = '3911';

let pass = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('ok  ', name); }, (e) => { console.error('FAIL', name, '\n    ', e.message); process.exitCode = 1; });

(async () => {
  const twitch = require('../src/chat/twitch'), kick = require('../src/chat/kick'), yt = require('../src/chat/youtube'), rumble = require('../src/chat/rumble');
  // the game tests run in one room; the room tests further down make more
  const rooms = require('../src/rooms');
  rooms.init({ legacyPassword: 'pw-test' });
  const game = rooms.create('teststreamer', { password: 'room-pw-test' }).entry.game;
  game.state.settings.channels.twitch = 'teststreamer';   // a new room has no channels set

  await t('twitch line parses badges and name', () => {
    const m = twitch.parseLine('@badge-info=;badges=moderator/1,vip/1;display-name=CoolMod;id=abc;user-id=42 :coolmod!coolmod@coolmod.tmi.twitch.tv PRIVMSG #teststreamer :!mark 7');
    assert.deepStrictEqual([m.name, m.userId, m.text, m.roles.mod, m.roles.vip, m.roles.broadcaster], ['CoolMod', '42', '!mark 7', true, true, false]);
    assert.strictEqual(twitch.parseLine('@a=b :x!x@x JOIN #c'), null);
    assert.strictEqual(twitch.parseLine('@badges=broadcaster/1;user-id=1 :a!a@a PRIVMSG #a :\u0001ACTION !enter\u0001').text, '!enter');
  });
  await t('kick event parses roles', () => {
    const raw = JSON.stringify({ event: 'App\\Events\\ChatMessageEvent', channel: 'chatrooms.1.v2', data: JSON.stringify({ id: 'x1', content: '!mark 3', sender: { id: 9, username: 'Vippy', identity: { badges: [{ type: 'vip', text: 'VIP' }] } } }) });
    const m = kick.parseEvent(raw);
    assert.deepStrictEqual([m.name, m.userId, m.roles.vip, m.roles.mod], ['Vippy', 9, true, false]);
    assert.strictEqual(kick.parseEvent(JSON.stringify({ event: 'other', data: '{}' })), null);
  });
  await t('youtube action parses owner and moderator', () => {
    const mk = (icon) => ({ addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'i', message: { runs: [{ text: '!mark ' }, { text: '2' }] }, authorName: { simpleText: 'Mo' }, authorExternalChannelId: 'UCx', authorBadges: [{ liveChatAuthorBadgeRenderer: { icon: { iconType: icon } } }] } } } });
    assert.strictEqual(yt.parseAction(mk('MODERATOR')).roles.mod, true);
    assert.strictEqual(yt.parseAction(mk('OWNER')).roles.broadcaster, true);
    assert.strictEqual(yt.parseAction(mk('MODERATOR')).text, '!mark 2');
    assert.strictEqual(yt.parseAction({ other: 1 }), null);
    assert.strictEqual(yt.videoIdFromInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(yt.videoIdFromInput('@somechannel'), null);
  });
  await t('rumble payload parses (assumed shape)', () => {
    const r = rumble.parsePayload({ type: 'messages', data: { messages: [{ id: 1, user_id: 5, text: '!enter' }], users: [{ id: 5, username: 'Rum', badges: ['moderator'] }] } });
    assert.deepStrictEqual([r[0].name, r[0].roles.mod], ['Rum', true]);
  });

  const msg = (name, text, roles = {}, platform = 'twitch', userId) => ({ platform, id: null, userId: userId || name, name, text, roles: { broadcaster: false, mod: false, vip: false, ...roles } });
  const S = () => game.state;

  await t('commands are ignored before a game and from normal users', () => {
    assert.strictEqual(game.handleChat(msg('viewer', '!bingostart')), null);
    assert.strictEqual(game.handleChat(msg('viewer', '!enter')).ok, false);
    assert.strictEqual(game.handleChat(msg('boss', '!bingostart', { mod: true })).ok, true);
    assert.strictEqual(S().game.active, true);
  });
  await t('enter with wager deducts the wager and gives the entry bonus', () => {
    assert.strictEqual(game.handleChat(msg('alice', '!enter 40')).ok, true);
    assert.strictEqual(S().accounts['twitch:alice'].points, 100 - 40 + 10);
    assert.strictEqual(game.handleChat(msg('alice', '!enter')).ok, false);          // one card each
    assert.strictEqual(game.handleChat(msg('bob', '!enter 999')).ok, false);        // more than they have
    assert.strictEqual(game.handleChat(msg('bob', '!enter abc')).ok, false);
    assert.strictEqual(game.handleChat(msg('bob', '!enter all', {}, 'kick', 77)).ok, true);
    assert.strictEqual(S().accounts['kick:77'].points, 10);
  });
  await t('card has 24 distinct words plus a free centre', () => {
    const c = S().game.players['twitch:alice'].card;
    assert.strictEqual(c.length, 25); assert.strictEqual(c[12], 0);
    assert.strictEqual(new Set(c.filter((x) => x)).size, 24);
  });
  await t('only mods, VIPs and the streamer can mark', () => {
    assert.strictEqual(game.handleChat(msg('alice', '!mark 1')), null);
    assert.strictEqual(game.handleChat(msg('v', '!mark 1', { vip: true })).ok, true);
    assert.deepStrictEqual(S().game.called, [1]);
    assert.strictEqual(game.handleChat(msg('m', '!mark 1', { mod: true })).ok, false); // already called
    assert.strictEqual(game.handleChat(msg('teststreamer', '!mark 2')).ok, true);              // streamer by channel name
    assert.strictEqual(game.handleChat(msg('v', '!bingostart', { vip: true })), null);   // VIPs cannot start/end
  });
  await t('!start (streamer and chat mods) and !enter can be renamed; old names keep working; starts are logged', () => {
    const g2 = rooms.create('cmd-room').entry.game, s2 = () => g2.state;
    g2.state.settings.channels.twitch = 'cmdowner';
    assert.deepStrictEqual(g2.publicState().commands, { enter: '!enter', start: '!start' }, 'defaults');
    // who may start: the streamer (badge or channel name) and chat mods; not VIPs or viewers
    assert.strictEqual(g2.handleChat(msg('viewer', '!start')), null);
    assert.strictEqual(g2.handleChat(msg('v', '!start', { vip: true })), null);
    assert.strictEqual(g2.handleChat(msg('cmdowner', '!start')).ok, true, 'streamer by channel name');
    assert.strictEqual(s2().game.active, true);
    assert.strictEqual(g2.handleChat(msg('m', '!start', { mod: true })).ok, false, 'already running');
    assert.strictEqual(g2.handleChat(msg('m', '!bingoend', { mod: true })).ok, true);
    assert.strictEqual(g2.handleChat(msg('m', '!start', { mod: true })).ok, true, 'chat mod');
    assert.deepStrictEqual(s2().modLog.slice(0, 3).map((l) => [l.who, l.action, l.source]), [['m', 'started a game', 'chat (twitch)'], ['m', 'ended the game', 'chat (twitch)'], ['cmdowner', 'started a game', 'chat (twitch)']]);
    // rename: the "!" is added if left off, letters are lower-cased
    assert.deepStrictEqual(g2.setCommands({ enter: 'Card', start: '!Go' }), { enter: '!card', start: '!go' });
    assert.strictEqual(g2.handleChat(msg('ann', '!enter')), null, 'the old join word does nothing');
    assert.strictEqual(g2.handleChat(msg('ann', '!CARD 0')).ok, true, 'the new one works, any case');
    assert.match(s2().feed[0].text + ' ' + g2.handleChat(msg('bo', '!card xyz')).error, /!card/);
    g2.handleChat(msg('m', '!bingoend', { mod: true }));
    assert.strictEqual(g2.handleChat(msg('m', '!start', { mod: true })), null, 'the old start word does nothing');
    assert.strictEqual(g2.handleChat(msg('m', '!go', { mod: true })).ok, true);
    assert.match(s2().feed[0].text, /Type !card in chat/);
    g2.handleChat(msg('m', '!bingoend', { mod: true }));
    assert.strictEqual(g2.handleChat(msg('m', '!bingostart', { mod: true })).ok, true, '!bingostart still works');
    assert.deepStrictEqual(g2.publicState().commands, { enter: '!card', start: '!go' });
    // bad names are refused and change nothing
    for (const [c, re] of [[{ enter: '!go' }, /different/], [{ start: '!mark' }, /already used/], [{ enter: '!two words' }, /letters/], [{ start: '!' }, /letters/], [{ enter: '!' + 'x'.repeat(21) }, /letters/], [{ enter: '!café' }, /letters/]]) assert.throws(() => g2.setCommands(c), re);
    assert.deepStrictEqual(s2().settings.commands, { enter: '!card', start: '!go' });
    // a saved file with something unusable falls back to the defaults
    s2().settings.commands = { enter: 'has space', start: 5 }; g2.saveNow(); g2.load();
    assert.deepStrictEqual(s2().settings.commands, { enter: '!enter', start: '!start' });
    rooms.remove('cmd-room');
  });
  await t('bingo pays reward plus wager multiplier, once', () => {
    const p = S().game.players['twitch:alice'];
    const row = p.card.slice(0, 5).filter((n) => n !== 0);
    const before = S().accounts['twitch:alice'].points;
    for (const n of row) if (!S().game.called.includes(n)) game.mark(String(n), true);
    assert.strictEqual(p.bingo, true);
    assert.strictEqual(S().accounts['twitch:alice'].points, before + 50 + 40 * 2);
    assert.strictEqual(S().accounts['twitch:alice'].bingos, 1);
    const after = S().accounts['twitch:alice'].points;
    game.mark(String(S().game.phrases.findIndex((_, i) => !S().game.called.includes(i + 1)) + 1), true);
    assert.ok(S().accounts['twitch:alice'].points >= after);
    assert.strictEqual(S().accounts['twitch:alice'].bingos, 1);
  });
  await t('late joiners only count words called after they join', () => {
    const called = [...S().game.called];
    game.handleChat(msg('late', '!enter'));
    const p = S().game.players['twitch:late'];
    assert.deepStrictEqual(p.ignored, called);
    const view = game.lookup('late')[0];
    assert.strictEqual(view.cells.filter((c) => c.marked && !c.free).length, 0);
  });
  await t('unmark removes a call and re-calling counts for everyone', () => {
    const n = S().game.called[0];
    game.mark(String(n), false);
    assert.ok(!S().game.called.includes(n));
    game.mark(String(n), true);
    assert.ok(S().game.called.includes(n));
  });
  await t('word text matching: ambiguous and unknown', () => {
    assert.throws(() => game.mark('streamer', true), /Several words match|Already called/);
    assert.throws(() => game.mark('zzzzzz', true), /No word contains/);
    assert.throws(() => game.mark('999', true), /No word #999/);
  });
  await t('blackout pays the larger reward and is final', () => {
    const p = S().game.players['twitch:alice'];
    const before = S().accounts['twitch:alice'].points;
    for (const n of p.card) if (n && !S().game.called.includes(n)) game.mark(String(n), true);
    assert.strictEqual(p.blackout, true);
    assert.strictEqual(S().accounts['twitch:alice'].points, before + 250 + 40 * 5);
  });
  await t('lookup is case-insensitive, strips @, and separates platforms', () => {
    assert.strictEqual(game.lookup('@ALICE')[0].hasCard, true);
    assert.strictEqual(game.lookup('alice')[0].blackout, true);
    game.handleChat(msg('Alice', '!enter', {}, 'kick', 500));
    assert.strictEqual(game.lookup('alice').length, 2);
    assert.strictEqual(game.lookup('nobody').length, 0);
  });
  await t('leaderboards rank by weekly gain and balance', () => {
    const s = game.publicState();
    assert.strictEqual(s.weekly[0].name, 'alice');
    assert.strictEqual(s.allTime[0].name, 'alice');
    assert.ok(s.feed.some((f) => f.type === 'blackout'));
  });
  await t('givepoints works for unknown names, never below zero, mods only', () => {
    game.handleChat(msg('boss', '!givepoints @newperson 30', { mod: true }));
    assert.strictEqual(game.state.accounts['byname:newperson'].points, 130);
    game.handleChat(msg('boss', '!givepoints @newperson -9999', { mod: true }));
    assert.strictEqual(game.state.accounts['byname:newperson'].points, 0);
    game.handleChat(msg('newperson', '!bingoend')); // not a mod
    assert.strictEqual(S().game.active, true);
  });
  await t('ending a game keeps cards visible, and a new one needs 24 words', () => {
    assert.strictEqual(game.handleChat(msg('boss', '!bingoend', { mod: true })).ok, true);
    assert.strictEqual(game.lookup('alice')[0].active, false);
    const keep = S().settings.phrases; S().settings.phrases = ['a', 'b'];
    assert.throws(() => game.startGame(), /at least 24/);
    S().settings.phrases = keep;
  });
  await t('weekly rollover archives last week and zeroes scores', () => {
    S().week.id = '2000-01-01'; game.tickWeek();
    assert.ok(S().lastWeek && S().lastWeek.rows.length > 0);
    assert.ok(Object.values(S().accounts).every((a) => a.weekly === 0));
  });
  await t('state survives a save and reload', () => {
    game.saveNow();
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'rooms', 'teststreamer', 'state.json'), 'utf8'));
    assert.ok(saved.accounts['twitch:alice'] && saved.game.number === 1);
  });

  // ---- HTTP ----
  require('../server.js');
  await new Promise((r) => setTimeout(r, 400));
  const site = 'http://localhost:3911', base = site + '/teststreamer';
  const J = async (url, opt) => { const r = await fetch(base + url, opt); return { status: r.status, body: await r.json().catch(() => null) }; };
  const adm = (action, body) => J('/api/admin/' + action, { method: 'POST', headers: { 'x-admin-password': 'pw-test', 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  await t('public API: state and card lookup', async () => {
    assert.strictEqual((await J('/api/state')).status, 200);
    const r = await J('/api/card?name=alice');
    assert.strictEqual(r.body.matches.length, 2);
    assert.strictEqual((await J('/api/card?name=')).body.matches.length, 0);
  });
  await t('admin endpoints need the password', async () => {
    assert.strictEqual((await J('/api/admin/status', { method: 'POST', headers: { 'x-admin-password': 'nope' }, body: '{}' })).status, 401);
    assert.strictEqual((await J('/api/admin/status', { method: 'POST', body: '{}' })).status, 401);
    assert.strictEqual((await adm('status')).status, 200);
  });
  await t('admin: start, mark by click, simulate, end', async () => {
    assert.strictEqual((await adm('start')).status, 200);
    assert.strictEqual((await adm('mark', { word: '3' })).status, 200);
    assert.strictEqual((await adm('mark', { word: '3' })).status, 400);
    const sim = await adm('simulate', { name: 'zed', platform: 'youtube', text: '!enter 10' });
    assert.strictEqual(sim.body.result.ok, true);
    assert.strictEqual((await adm('end')).status, 200);
  });
  await t('admin: word list needs 24, saves, and is used by the next game', async () => {
    assert.strictEqual((await adm('phrases', { phrases: ['one', 'two'] })).status, 400);
    const list = Array.from({ length: 30 }, (_, i) => 'Custom word ' + (i + 1));
    assert.strictEqual((await adm('phrases', { phrases: list })).status, 200);
    await adm('start');
    const st = (await adm('status')).body;
    assert.strictEqual(st.game.phrases[0], 'Custom word 1');
    await adm('end');
  });
  await t('admin: settings are validated and channels restart chat', async () => {
    const r = await adm('settings', { points: { bingoReward: '75', maxWager: 'abc' }, layout: { accent: 'javascript:alert(1)', width: 1200 }, channels: { twitch: '', kick: '', youtube: '', rumble: '' } });
    assert.strictEqual(r.status, 200);
    const s = (await adm('status')).body.settings;
    assert.strictEqual(s.points.bingoReward, 75); assert.strictEqual(s.points.maxWager, 1000);
    assert.notStrictEqual(s.layout.accent, 'javascript:alert(1)'); assert.strictEqual(s.layout.width, 1200);
  });
  await t('admin: background images work in featured rooms, and the file type is checked', async () => {
    game.state.room.kind = 'dedicated';
    const bad = await fetch(base + '/api/admin/background', { method: 'POST', headers: { 'x-admin-password': 'pw-test' }, body: Buffer.from('not an image') });
    assert.strictEqual(bad.status, 400);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const ok = await fetch(base + '/api/admin/background', { method: 'POST', headers: { 'x-admin-password': 'pw-test', 'Content-Type': 'image/png' }, body: png });
    assert.strictEqual(ok.status, 200);
    const got = await fetch(base + '/background'); assert.strictEqual(got.status, 200); assert.strictEqual(got.headers.get('content-type'), 'image/png');
    // a room that stops being featured stops showing its image (the file is kept)
    game.state.room.kind = 'community';
    assert.strictEqual((await fetch(base + '/background')).status, 404);
  });
  await t('static pages serve and path traversal is refused', async () => {
    for (const p of ['/', '/admin', '/mod']) assert.strictEqual((await fetch(base + p)).status, 200, p);
    for (const p of ['/', '/site-admin', '/card.js', '/front.css']) assert.strictEqual((await fetch(site + p)).status, 200, p);
    assert.notStrictEqual((await fetch(base + '/..%2f..%2fetc%2fpasswd')).status, 200);
    assert.notStrictEqual((await fetch(base + '/%2e%2e/server.js')).status, 200);
  });

  await t('admin toggles decide whether mods and VIPs can mark from chat', async () => {
    if (!S().game.active) game.startGame();
    const w = () => String(S().game.phrases.findIndex((_, i) => !S().game.called.includes(i + 1)) + 1);
    assert.strictEqual((await adm('settings', { allowMods: false })).status, 200);
    assert.strictEqual(game.handleChat(msg('m1', '!mark ' + w(), { mod: true })), null);          // mods blocked
    assert.strictEqual(game.handleChat(msg('v1', '!mark ' + w(), { vip: true })).ok, true);       // VIPs still fine
    assert.strictEqual((await adm('settings', { allowMods: true, allowVips: false })).status, 200);
    assert.strictEqual(game.handleChat(msg('v2', '!mark ' + w(), { vip: true })), null);          // VIPs blocked
    assert.strictEqual(game.handleChat(msg('m2', '!mark ' + w(), { mod: true })).ok, true);       // mods back
    assert.strictEqual(game.handleChat(msg('streamer', '!mark ' + w(), { broadcaster: true })).ok, true);  // streamer always can
    assert.strictEqual(game.handleChat(msg('m3', '!bingoend', { mod: true })).ok, true);          // other mod commands unaffected
    game.startGame();
    await adm('settings', { allowMods: true, allowVips: true });
  });
  await t('mod page: own password, can only call words', async () => {
    const st = await adm('status'); const modPw = st.body.modPassword;
    assert.ok(modPw && modPw.length >= 6); assert.strictEqual(st.body.settings.modPassword, undefined);
    const mod = (action, body, pw) => J('/api/mod/' + action, { method: body ? 'POST' : 'GET', headers: { 'x-mod-password': pw === undefined ? modPw : pw, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.strictEqual((await mod('status', null, 'wrong')).status, 401);
    assert.strictEqual((await mod('status', null, '')).status, 401);
    const s = await mod('status'); assert.strictEqual(s.status, 200); assert.strictEqual(s.body.settings, undefined); assert.ok(Array.isArray(s.body.game.phrases));
    await mod('unmark', { word: '30' });                                                  // make sure #30 starts un-called
    const m = await mod('mark', { word: '30' }); assert.strictEqual(m.status, 200); assert.ok(S().game.called.includes(30));
    const u = await mod('unmark', { word: '30' }); assert.strictEqual(u.status, 200); assert.ok(!S().game.called.includes(30));
    assert.strictEqual((await mod('mark', { word: 'zzzz no such' })).status, 400);
    // the mod password does not open any admin action
    const asAdmin = await J('/api/admin/status', { method: 'POST', headers: { 'x-admin-password': modPw, 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(asAdmin.status, 401);
    assert.strictEqual((await mod('start', {})).status, 404); assert.strictEqual((await mod('settings', {})).status, 404);
    // the admin password also works on the mod page
    assert.strictEqual((await mod('status', null, 'pw-test')).status, 200);
  });
  await t('admin can change the mod password; the old one stops working', async () => {
    const old = (await adm('status')).body.modPassword;
    assert.strictEqual((await adm('modpassword', { password: 'abc' })).status, 400);      // too short
    const r = await adm('modpassword', { password: 'new-mod-pw' }); assert.strictEqual(r.status, 200);
    const probe = (pw) => J('/api/mod/status', { headers: { 'x-mod-password': pw } });
    assert.strictEqual((await probe(old)).status, 401); assert.strictEqual((await probe('new-mod-pw')).status, 200);
    const rnd = await adm('modpassword', {}); assert.ok(rnd.body.modPassword.length >= 6);
  });
  await t('mod page is served at /mod and has everything the front page has', async () => {
    assert.strictEqual((await fetch(base + '/mod')).status, 200);
    for (const f of ['/front.css', '/front.js', '/card.js']) assert.strictEqual((await fetch(site + f)).status, 200, f);
    const ids = (h) => new Set([...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const front = ids(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'));
    const mod = fs.readFileSync(path.join(__dirname, '..', 'public', 'mod.html'), 'utf8');
    const have = ids(mod);
    for (const id of front) assert.ok(have.has(id), 'mod page is missing #' + id);
    assert.ok(mod.includes('/front.js') && mod.includes('/front.css') && mod.includes("'api/mod/'"));
  });

  await t('public state has a top-20 board of the current game, most squares first', async () => {
    await adm('end'); await adm('start');
    for (let i = 1; i <= 25; i++) await adm('simulate', { name: 'p' + i, platform: i % 2 ? 'twitch' : 'kick', text: '!enter' });
    for (let n = 1; n <= 12; n++) await adm('mark', { word: String(n) });
    const st = (await J('/api/state')).body;
    assert.strictEqual(st.game.players, 25);
    assert.strictEqual(st.board.length, 20);
    for (let i = 1; i < st.board.length; i++) assert.ok(st.board[i - 1].marked >= st.board[i].marked, 'sorted by squares');
    const top = st.board[0];
    assert.ok(top.marked >= 1 && top.marked <= 25 && 'needed' in top && 'platform' in top && 'bingo' in top);
    // every board entry can be opened with the existing card lookup (this is what a click does)
    const m = (await J('/api/card?name=' + encodeURIComponent(top.name))).body.matches.find((x) => x.platform === top.platform);
    assert.ok(m && m.hasCard && m.marked === top.marked);
    await adm('end');
  });

  await t('admin toggle: words called before joining can count on a new card', async () => {
    await adm('end'); await adm('start');
    await adm('mark', { word: '1' }); await adm('mark', { word: '2' });
    const joined = async (name) => (await J('/api/card?name=' + name)).body.matches[0];
    // default: only words called after joining count
    await adm('simulate', { name: 'lateA', platform: 'twitch', text: '!enter' });
    const a = await joined('lateA');
    assert.strictEqual(a.cells.filter((c) => !c.free && c.marked).length, 0);
    // toggle on: a new joiner has the two earlier words marked (if they landed on the card)
    assert.strictEqual((await adm('settings', { countEarlyCalls: true })).status, 200);
    assert.strictEqual((await adm('status')).body.settings.countEarlyCalls, true);
    await adm('simulate', { name: 'lateB', platform: 'twitch', text: '!enter' });
    const b = await joined('lateB');
    const early = b.cells.filter((c) => !c.free && (c.n === 1 || c.n === 2));
    assert.ok(early.every((c) => c.marked), 'early calls marked');
    assert.strictEqual(b.marked, 1 + early.length);
    // existing player A is unchanged by the toggle
    assert.strictEqual((await joined('lateA')).cells.filter((c) => !c.free && c.marked).length, 0);
    // a card that is already complete when it joins wins at once
    await adm('settings', { countEarlyCalls: true });
    for (let n = 3; n <= 30; n++) await adm('mark', { word: String(n) });
    await adm('simulate', { name: 'lateC', platform: 'kick', text: '!enter' });
    const c = await joined('lateC'); assert.ok(c.blackout && c.bingo);
    await adm('settings', { countEarlyCalls: false }); await adm('end');
  });

  await t('viewer marking switches: off by default, "no auto-mark" needs click-to-mark, scoring unchanged', async () => {
    const cards = async () => (await J('/api/state')).body.cards;
    assert.deepStrictEqual(await cards(), { clickToMark: false, autoMark: true });
    // "don't auto-mark" alone is refused while click-to-mark is off
    await adm('settings', { manualMarking: true });
    assert.strictEqual((await adm('status')).body.settings.manualMarking, false);
    assert.deepStrictEqual(await cards(), { clickToMark: false, autoMark: true });
    await adm('settings', { viewerMarking: true, manualMarking: true });
    assert.deepStrictEqual(await cards(), { clickToMark: true, autoMark: false });
    // the server still marks and scores cards the same way
    await adm('start');
    await adm('simulate', { name: 'dabber', platform: 'twitch', text: '!enter' });
    const card = (await J('/api/card?name=dabber')).body.matches[0];
    const words = card.cells.filter((c) => !c.free).slice(0, 4).map((c) => c.n);
    for (const w of words) await adm('mark', { word: String(w) });
    const after = (await J('/api/card?name=dabber')).body.matches[0];
    assert.strictEqual(after.marked, 1 + words.length);
    // turning click-to-mark off also turns "don't auto-mark" off
    await adm('settings', { viewerMarking: false });
    assert.deepStrictEqual(await cards(), { clickToMark: false, autoMark: true });
    assert.strictEqual((await adm('status')).body.settings.manualMarking, false);
    await adm('end');
  });

  await t('fresh install has no personal channels and the admin page has the marking switches', async () => {
    const fresh = require('../src/game');
    const html = await (await fetch(base + '/admin')).text();
    assert.match(html, /id="pClick"/); assert.match(html, /id="pManual"/);
    const idx = await (await fetch(base + '/')).text();
    assert.match(idx, /id="dabBar"/);
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'data', 'state.json')) || process.env.CI_KEEP_STATE, 'no bundled state.json');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'game.js'), 'utf8');
    assert.match(src, /twitch: '', kick: '', youtube: ''/);
    assert.ok(fresh);
  });

  await t('admin can rename the page; it shows on the public state and is length-limited', async () => {
    assert.strictEqual((await adm('settings', { title: 'My Own Bingo' })).status, 200);
    assert.strictEqual((await J('/api/state')).body.title, 'My Own Bingo');
    await adm('settings', { title: 'x'.repeat(80) });
    assert.strictEqual((await J('/api/state')).body.title.length, 40);
    await adm('settings', { title: '   ' });                       // empty keeps the old name
    assert.strictEqual((await J('/api/state')).body.title.length, 40);
    await adm('settings', { title: 'STREAM BINGO' });
  });

  await t('twitch lead moderators count as mods', () => {
    const m = twitch.parseLine('@badges=lead_moderator/1;display-name=Lead;id=z;user-id=8 :lead!lead@lead.tmi.twitch.tv PRIVMSG #teststreamer :!mark 1');
    assert.strictEqual(m.roles.mod, true);
  });
  await t('cards flag words called before joining (dashed, not counted)', async () => {
    try { game.endGame(); } catch {}
    game.state.settings.countEarlyCalls = false;
    game.startGame();
    for (let n = 1; n <= 30; n++) game.mark(String(n), true, 't');          // every word called before anyone joins
    game.enter('kick', 'late1', 'EarlyBird', '');
    const v = (await J('/api/card?name=EarlyBird')).body.matches[0];
    assert.strictEqual(v.early, 24); assert.strictEqual(v.marked, 1);
    assert.ok(v.cells.filter((c) => !c.free).every((c) => c.early && !c.marked));
    game.mark('5', false, 't');                                               // un-calling clears the early flag for that word
    const v2 = (await J('/api/card?name=EarlyBird')).body.matches[0];
    assert.ok(v2.cells.every((c) => c.n !== 5 || !c.early));
    game.endGame();
  });
  await t('health check answers without a password', async () => {
    const r = await fetch(site + '/healthz').then(async (x) => ({ status: x.status, body: await x.json() }));
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.rooms >= 1 && typeof r.body.live === 'number');
  });
  await t('admin page keeps the mod password hidden until Show is pressed', async () => {
    const h = await (await fetch(base + '/admin')).text();
    assert.match(h, /<code id="modPwShown" class="masked"[^>]*>••••••••<\/code>/);
    assert.match(h, /id="modPwToggle"[^>]*>Show</);
    assert.match(h, /<input type="password" id="modPwNew"/);
    assert.ok(!/\.textContent = D\.modPassword;/.test(h), 'the password is never written straight into the page');
    assert.ok(h.includes('id="logoutBtn"') && h.includes('id="callFind"') && h.includes('id="lyBorder"'));
  });
  await t('wrong passwords are capped site-wide even with a fake X-Forwarded-For', async () => {
    let last;
    for (let i = 0; i < 70; i++) last = await J('/api/mod/status', { headers: { 'x-mod-password': 'bad' + i, 'x-forwarded-for': '10.9.' + Math.floor(i / 250) + '.' + (i % 250) } });
    assert.strictEqual(last.status, 429);
    assert.strictEqual((await J('/api/mod/status', { headers: { 'x-mod-password': 'pw-test', 'x-forwarded-for': '10.9.9.9' } })).status, 200);   // the right one still works
  });


  await t('YouTube display name matching the channel setting does not make someone the owner', () => {
    const ch = game.state.settings.channels, saved = { ...ch };
    const s = game.state.settings, savedMods = s.allowMods, savedVips = s.allowVips;
    ch.youtube = 'somechannel'; ch.twitch = 'teststreamer';
    try { game.endGame(); } catch {}
    game.startGame();
    const yt = (roles) => ({ platform: 'youtube', id: null, userId: 'UCsomeoneElse000000000000', name: 'somechannel', text: '', roles: { broadcaster: false, mod: false, vip: false, ...roles } });
    const say = (roles, text) => game.handleChat({ ...yt(roles), text });
    const beforeCalled = [...S().game.called], beforeAcc = JSON.stringify(S().accounts), beforeGame = S().game.number;
    assert.strictEqual(say({}, '!mark 1'), null);
    assert.strictEqual(say({}, '!unmark 1'), null);
    assert.strictEqual(say({}, '!bingostart'), null);
    assert.strictEqual(say({}, '!bingoend'), null);
    assert.strictEqual(say({}, '!givepoints @alice 500'), null);
    assert.deepStrictEqual(S().game.called, beforeCalled);
    assert.strictEqual(JSON.stringify(S().accounts), beforeAcc);
    assert.strictEqual(S().game.number, beforeGame); assert.strictEqual(S().game.active, true);
    // !enter is still open to every chatter
    assert.strictEqual(say({}, '!enter').ok, true);
    // YouTube mods and VIPs follow the switches; only the OWNER badge bypasses them
    s.allowMods = false; s.allowVips = false;
    assert.strictEqual(say({ mod: true }, '!mark 1'), null);
    assert.strictEqual(say({ vip: true }, '!mark 1'), null);
    assert.strictEqual(say({ broadcaster: true }, '!mark 1').ok, true);
    s.allowMods = true;
    assert.strictEqual(say({ mod: true }, '!mark 2').ok, true);
    // Twitch keeps the login check: the channel name is the owner without a badge
    assert.strictEqual(game.handleChat(msg('teststreamer', '!mark 3')).ok, true);
    s.allowMods = savedMods; s.allowVips = savedVips; Object.assign(ch, saved);
    game.endGame();
  });

  await t('a proxy whose visitor address is not used: viewers are not lumped into one budget, site-wide caps still hold', async () => {
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-shared-'));
    const port = 3919, b2 = 'http://127.0.0.1:' + port;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), SITE_ADMIN_PASSWORD: 'owner-pw', ADMIN_PASSWORD: 'adm-sh', TRUST_PROXY_HOPS: '', TRUST_REAL_IP: '' }, stdio: 'ignore' });
    try {
      for (let i = 0; i < 50; i++) { try { if ((await fetch(b2 + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
      const made = await (await fetch(b2 + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'shared-test' }) })).json();
      const room = made.name;
      const card = (hdr) => fetch(b2 + '/' + room + '/api/card?name=x', { headers: hdr || {} }).then((r) => r.status);
      assert.strictEqual((await (await fetch(b2 + '/healthz')).json()).visitorAddress, 'per visitor');
      // a direct connection is one visitor with its own budget (240 a minute)
      const direct = await Promise.all(Array.from({ length: 260 }, () => card()));
      assert.ok(direct.slice(0, 240).every((s) => s === 200) && direct.slice(241).every((s) => s === 429), 'direct budget');
      // through a proxy on this machine whose address is not used: not one visitor, so no shared budget runs out
      const viaProxy = await Promise.all(Array.from({ length: 600 }, (_, i) => card({ 'x-forwarded-for': '203.0.113.' + (i % 250) })));
      assert.ok(viaProxy.every((s) => s === 200), 'the audience does not share one card budget');
      assert.strictEqual((await (await fetch(b2 + '/healthz')).json()).visitorAddress, 'shared', 'health check reports it');
      // wrong passwords: the site-wide cap (60 per room page per 10 minutes) still holds; the right password still works
      const guess = (pw) => fetch(b2 + '/' + room + '/api/mod/status', { headers: { 'x-mod-password': pw, 'x-forwarded-for': '198.51.100.1' } }).then((r) => r.status);
      for (let i = 0; i < 60; i++) assert.strictEqual(await guess('bad' + i), 401, 'guess ' + i);
      assert.strictEqual(await guess('bad-61'), 429, 'site-wide cap');
      assert.strictEqual(await guess(made.password), 200, 'right password still works');
    } finally { child.kill('SIGTERM'); }
  });

  await t('TRUST_PROXY_HOPS=1 uses the rightmost X-Forwarded-For entry, and global caps survive address floods', async () => {
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-hops-'));
    fs.copyFileSync(path.join(__dirname, '..', 'data', 'words.default.txt'), path.join(dir, 'words.default.txt'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { channels: { twitch: '', kick: '', youtube: '', rumble: '', kickChatroomId: '' } } }));
    const port = 3912, b2 = 'http://localhost:' + port;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'adm-hops', MOD_PASSWORD: 'mod-hops', TRUST_PROXY_HOPS: '1', BINGO_NO_SEED: '1' }, stdio: 'ignore',
    });
    try {
      for (let i = 0; i < 50; i++) { try { if ((await fetch(b2 + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
      const guess = (xff, pw = 'bad') => fetch(b2 + '/api/mod/status', { headers: { 'x-mod-password': pw, 'x-forwarded-for': xff } }).then((r) => r.status);
      // 8 wrong guesses from client 5.5.5.5 (rightmost) with a different made-up leftmost each time: the 9th is blocked
      for (let i = 0; i < 8; i++) assert.strictEqual(await guess(`66.66.66.${i}, 5.5.5.5`), 401);
      assert.strictEqual(await guess('77.77.77.77, 5.5.5.5'), 429);
      // the leftmost is ignored: 5.5.5.5 on the LEFT with a fresh rightmost is a different client
      assert.strictEqual(await guess('5.5.5.5, 6.6.6.6'), 401);
      // a header shorter than the hop count falls back to the socket address (here: no header at all)
      assert.strictEqual(await fetch(b2 + '/api/mod/status', { headers: { 'x-mod-password': 'mod-hops' } }).then((r) => r.status), 200);
      // use up the site-wide cap of 60 from many different trusted addresses
      let n = 10;   // 5.5.5.5 made 9 wrong guesses and 6.6.6.6 made 1 -> 10 counted so far
      for (let a = 0; n < 60; a++) for (let k = 0; k < 5 && n < 60; k++, n++) assert.strictEqual(await guess('9.9.' + a + '.1'), 401, 'guess ' + n);
      assert.strictEqual(await guess('9.9.200.1'), 429, 'site-wide cap reached');
      // flood more distinct addresses than the per-address map holds: the site-wide counter must survive
      const ids = Array.from({ length: 6000 }, (_, i) => i);
      for (let i = 0; i < ids.length; i += 200) await Promise.all(ids.slice(i, i + 200).map((k) => fetch(b2 + '/api/card?name=x', { headers: { 'x-forwarded-for': `100.${k >> 16 & 255}.${k >> 8 & 255}.${k & 255}` } }).then((r) => r.status)));
      assert.strictEqual(await guess('9.9.250.1'), 429, 'site-wide cap still holds after the flood');
      assert.strictEqual(await guess('9.9.251.1', 'mod-hops'), 200, 'right password still works');
      // admin has its own counters: not blocked by the mod total, capped at 8 per address, right password still 200
      const adm2 = (xff, pw = 'nope') => fetch(b2 + '/api/admin/status', { method: 'POST', headers: { 'x-admin-password': pw, 'x-forwarded-for': xff }, body: '{}' }).then((r) => r.status);
      for (let i = 0; i < 8; i++) assert.strictEqual(await adm2(`1.${i}.1.1, 8.8.8.8`), 401);
      assert.strictEqual(await adm2('2.2.2.2, 8.8.8.8'), 429);
      assert.strictEqual(await adm2('3.3.3.3, 8.8.8.8'), 429);
      assert.strictEqual(await adm2('8.8.8.8', 'adm-hops'), 200);
    } finally { child.kill('SIGTERM'); }
  });

  await t('TRUST_REAL_IP: X-Real-IP from this machine names the visitor only when switched on; bad values name nobody', async () => {
    const { spawn } = require('child_process');
    const run = async (port, env, fn) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-realip-'));
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), SITE_ADMIN_PASSWORD: 'owner-pw', ADMIN_PASSWORD: '', ...env }, stdio: 'ignore' });
      const b = 'http://127.0.0.1:' + port;
      try {
        for (let i = 0; i < 50; i++) { try { if ((await fetch(b + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
        await fn(b);
      } finally { child.kill('SIGTERM'); }
    };
    const make = (b, name, hdr) => fetch(b + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr }, body: JSON.stringify({ name }) }).then((r) => r.status);
    // off (the default): the header is not used to tell visitors apart; requests through such a proxy are not one visitor
    // either (that would make the whole audience share one budget), so only the site-wide limits apply
    await run(3916, { TRUST_PROXY_HOPS: '' }, async (b) => {
      const st = []; for (let i = 0; i < 4; i++) st.push(await make(b, 'off-room-' + i, { 'x-real-ip': '203.0.113.7' }));
      assert.deepStrictEqual(st, [200, 200, 200, 200]);
      // a direct connection (no proxy headers) is still one visitor: 3 rooms an hour
      const d = []; for (let i = 0; i < 4; i++) d.push(await make(b, 'direct-room-' + i, {}));
      assert.deepStrictEqual(d, [200, 200, 200, 429]);
    });
    // on: each X-Real-IP is its own visitor; a junk value falls back to the connection address (or the hop count)
    await run(3917, { TRUST_REAL_IP: '1', TRUST_PROXY_HOPS: '' }, async (b) => {
      const st = []; for (let i = 0; i < 4; i++) st.push(await make(b, 'on-room-' + i, { 'x-real-ip': '203.0.113.' + i }));
      assert.deepStrictEqual(st, [200, 200, 200, 200], 'four visitors');
      // junk values name nobody: not used as an address
      for (let i = 0; i < 4; i++) assert.strictEqual(await make(b, 'junk-room-' + i, { 'x-real-ip': 'not-an-ip' }), 200, 'junk value ' + i);
      for (let i = 0; i < 3; i++) await make(b, 'same-' + i, { 'x-real-ip': '198.51.100.7' });
      assert.strictEqual(await make(b, 'same-3', { 'x-real-ip': '198.51.100.7' }), 429, 'the same X-Real-IP is one visitor');
    });
  });

  // ---------------- rooms ----------------
  await t('rooms: community rooms sleep chat when unused, wake on an admin visit, and expire; featured rooms never do', async () => {
    const a = rooms.create('sleepy-room').entry, f = rooms.create('featured-room', { kind: 'dedicated' }).entry;
    a.game.state.settings.channels.twitch = 'nobody_here_123';
    const now = Date.now();
    rooms.tick(now); assert.strictEqual(a.chat.running, true, 'a new room is awake');
    a.game.state.room.lastActive = now - rooms.CHAT_IDLE_MS - 60000; f.game.state.room.lastActive = 1;
    rooms.tick(now); assert.strictEqual(a.chat.running, false, 'asleep after the idle time'); assert.strictEqual(f.chat.running, true, 'featured stays on');
    a.game.startGame(); rooms.tick(now); assert.strictEqual(a.chat.running, true, 'a running game keeps it awake');
    a.game.endGame(); a.game.state.room.lastActive = now - rooms.CHAT_IDLE_MS - 60000; rooms.tick(now);
    rooms.wake(a); assert.strictEqual(a.chat.running, true, 'an admin visit wakes it');
    // expiry: unused for longer than ROOM_EXPIRE_DAYS -> moved to deleted-rooms; featured rooms stay
    a.game.state.room.lastActive = now - rooms.EXPIRE_MS - 86400000;
    rooms.tick(now);
    assert.strictEqual(rooms.get('sleepy-room'), undefined); assert.ok(rooms.get('featured-room'));
    assert.ok(fs.readdirSync(path.join(tmp, 'deleted-rooms')).some((d) => d.startsWith('sleepy-room-')));
    rooms.remove('featured-room');
  });

  await t('Kick Pusher key: one site-wide setting used by every room; changing it reconnects connected Kick chats', () => {
    const kick = require('../src/chat/kick'), realStart = kick.start, opened = [];
    // a stand-in Kick reader that only records what it was started with
    kick.start = (cfg, emit, status) => { const c = { room: cfg.kick, key: cfg.kickPusherKey, cluster: cfg.kickPusherCluster, stopped: false }; opened.push(c); status.state = 'connected'; return () => { c.stopped = true; }; };
    try {
      const d = rooms.KICK_DEFAULTS;
      assert.deepStrictEqual(rooms.kickApp(), { key: d.kickPusherKey, cluster: d.kickPusherCluster }, 'built-in key by default');
      const a = rooms.create('kick-a').entry, b = rooms.create('kick-b').entry, tw = rooms.create('kick-none').entry;
      a.game.state.settings.channels.kick = 'chan_a'; b.game.state.settings.channels.kick = 'chan_b'; tw.game.state.settings.channels.twitch = '';
      // an old room file that still holds its own key: the site's one is used and the old copy is dropped
      a.game.state.settings.channels.kickPusherKey = 'oldroomkey123'; a.game.saveNow(); a.game.load();
      assert.ok(!('kickPusherKey' in a.game.state.settings.channels));
      a.chat.startAll(); b.chat.startAll(); tw.chat.startAll();
      assert.deepStrictEqual(opened.map((c) => [c.room, c.key]), [['chan_a', d.kickPusherKey], ['chan_b', d.kickPusherKey]]);
      // bad values are refused and change nothing
      assert.throws(() => rooms.setKickApp('has space', 'us2'), /letters and numbers/);
      assert.throws(() => rooms.setKickApp('abcdefgh12', 'US 2!'), /cluster/);
      assert.strictEqual(rooms.kickApp().key, d.kickPusherKey);
      // a new key: both Kick rooms reconnect with it (the old connections are closed), the Twitch-only room is left alone
      const r = rooms.setKickApp('  NewKey0123456789abcd ', 'MT1');
      assert.deepStrictEqual([r.key, r.cluster, r.reconnected], ['NewKey0123456789abcd', 'mt1', 2]);
      assert.deepStrictEqual(opened.slice(0, 2).map((c) => c.stopped), [true, true]);
      assert.deepStrictEqual(opened.slice(2).map((c) => [c.room, c.key, c.cluster]), [['chan_a', 'NewKey0123456789abcd', 'mt1'], ['chan_b', 'NewKey0123456789abcd', 'mt1']]);
      // saving the same values again does not reconnect anyone
      assert.strictEqual(rooms.setKickApp('NewKey0123456789abcd', 'mt1').reconnected, 0);
      // a room made later uses it too, and so does a room after its channels change
      const c = rooms.create('kick-c').entry; c.game.state.settings.channels.kick = 'chan_c'; c.chat.startAll();
      assert.strictEqual(opened.at(-1).key, 'NewKey0123456789abcd');
      // it is kept in site.json across a restart
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'site.json'), 'utf8')).kickPusherKey, 'NewKey0123456789abcd');
      rooms.setKickApp(d.kickPusherKey, d.kickPusherCluster);
      for (const e of [a, b, tw, c]) e.chat.stopAll();
      for (const n of ['kick-a', 'kick-b', 'kick-none', 'kick-c']) rooms.remove(n);
    } finally { kick.start = realStart; }
  });

  await t('rooms: names are checked and reserved words refused', () => {
    for (const bad of ['ab', 'admin', 'site-admin', 'api', 'has space', 'dot.name', '-dash', 'x'.repeat(31), '']) assert.throws(() => rooms.checkName(bad), undefined, bad);
    assert.strictEqual(rooms.checkName('@Cool_Streamer-1'), 'cool_streamer-1');
  });

  await t('rooms over HTTP: make, isolate, list, site admin, limits, and links from before rooms', async () => {
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-rooms-'));
    // a single game from before rooms, as an existing site has it
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { title: 'OLD GAME', channels: { twitch: '', kick: 'Old_Streamer', youtube: '', rumble: '', kickChatroomId: '1' }, modPassword: 'old-mod-pw' }, accounts: { 'kick:5': { name: 'Regular', platform: 'kick', points: 777, bingos: 3, blackouts: 1, weekly: 0 } }, game: { active: false, number: 4, phrases: [], called: [], players: {}, bingoOrder: [], blackoutOrder: [] } }));
    const port = 3913, b3 = 'http://localhost:' + port;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'old-admin-pw', SITE_ADMIN_PASSWORD: 'owner-pw', TRUST_PROXY_HOPS: '', MOD_PASSWORD: '' }, stdio: 'ignore',
    });
    const R = async (u, opt = {}) => { const r = await fetch(b3 + u, { redirect: 'manual', ...opt }); return { status: r.status, loc: r.headers.get('location'), body: await r.json().catch(() => null) }; };
    const post = (u, body, pw, hdr = 'x-admin-password') => R(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(pw ? { [hdr]: pw } : {}) }, body: JSON.stringify(body || {}) });
    try {
      for (let i = 0; i < 50; i++) { try { if ((await fetch(b3 + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
      // the old game became the featured room "old_streamer", keeping its players, its admin password and its mod password
      const old = await R('/old_streamer/api/state');
      assert.strictEqual(old.body.title, 'OLD GAME'); assert.strictEqual(old.body.allTime[0].points, 777);
      assert.strictEqual((await post('/old_streamer/api/admin/status', {}, 'old-admin-pw')).status, 200);
      assert.strictEqual((await R('/old_streamer/api/mod/status', { headers: { 'x-mod-password': 'old-mod-pw' } })).status, 200);
      assert.strictEqual((await post('/api/site/status', {}, 'old-admin-pw')).status, 401, 'old room password is not the site password');
      // old addresses lead there
      assert.deepStrictEqual([(await R('/?u=Regular')).loc, (await R('/admin')).loc, (await R('/mod')).loc], ['/old_streamer/?u=Regular', '/old_streamer/admin', '/old_streamer/mod']);
      assert.strictEqual((await R('/api/state')).body.title, 'OLD GAME');
      assert.strictEqual((await R('/Old_Streamer')).loc, '/old_streamer/');
      assert.strictEqual((await R('/no-such-room/')).loc, '/?missing=no-such-room');
      assert.strictEqual((await R('/index.html')).status, 404);
      // anyone can make a room; the password comes back once
      const mk = await post('/api/rooms', { name: 'NewStreamer', title: 'Friday Bingo' });
      assert.strictEqual(mk.status, 200); assert.strictEqual(mk.body.name, 'newstreamer'); assert.ok(mk.body.password.length >= 10 && mk.body.modPassword);
      assert.strictEqual((await post('/api/rooms', { name: 'newstreamer' })).status, 409);
      assert.strictEqual((await post('/api/rooms', { name: 'admin' })).status, 400);
      assert.strictEqual((await R('/newstreamer/api/state')).body.title, 'Friday Bingo');
      // each room's password opens only that room; the site password opens every room
      assert.strictEqual((await post('/newstreamer/api/admin/status', {}, mk.body.password)).status, 200);
      assert.strictEqual((await post('/old_streamer/api/admin/status', {}, mk.body.password)).status, 401);
      assert.strictEqual((await post('/newstreamer/api/admin/status', {}, 'old-admin-pw')).status, 401);
      assert.strictEqual((await post('/newstreamer/api/admin/status', {}, 'owner-pw')).status, 200);
      assert.strictEqual((await post('/api/site/status', {}, mk.body.password)).status, 401);
      // games are separate
      assert.strictEqual((await post('/newstreamer/api/admin/start', {}, mk.body.password)).status, 200);
      assert.strictEqual((await post('/newstreamer/api/admin/simulate', { name: 'Fan', text: '!enter' }, mk.body.password)).body.result.ok, true);
      assert.strictEqual((await R('/newstreamer/api/state')).body.game.players, 1);
      assert.strictEqual((await R('/old_streamer/api/state')).body.game.active, false);
      assert.strictEqual((await R('/old_streamer/api/card?name=Fan')).body.matches.length, 0);
      // the home page lists featured rooms, and community rooms while live
      let d = (await R('/api/rooms')).body;
      assert.deepStrictEqual(d.featured.map((r) => r.name), ['old_streamer']); assert.deepStrictEqual(d.live.map((r) => r.name), ['newstreamer']);
      assert.strictEqual((await post('/newstreamer/api/admin/room', { listed: false }, mk.body.password)).status, 200);
      assert.strictEqual((await R('/api/rooms')).body.live.length, 0, 'unlisted rooms are not shown');
      // the room owner can change their password
      assert.strictEqual((await post('/newstreamer/api/admin/adminpassword', { password: 'short' }, mk.body.password)).status, 400);
      assert.strictEqual((await post('/newstreamer/api/admin/adminpassword', { password: 'a-new-room-pw' }, mk.body.password)).status, 200);
      assert.strictEqual((await post('/newstreamer/api/admin/status', {}, mk.body.password)).status, 401);
      assert.strictEqual((await post('/newstreamer/api/admin/status', {}, 'a-new-room-pw')).status, 200);
      // making rooms is limited per address (3 an hour)
      assert.strictEqual((await post('/api/rooms', { name: 'second-room' })).status, 200);
      assert.strictEqual((await post('/api/rooms', { name: 'third-room' })).status, 200);
      assert.strictEqual((await post('/api/rooms', { name: 'fourth-room' })).status, 429);
      // site admin: list, feature, new password, delete (needs the name typed), switch off room making
      const st = await post('/api/site/status', {}, 'owner-pw');
      assert.deepStrictEqual(st.body.rooms.map((r) => r.name).sort(), ['newstreamer', 'old_streamer', 'second-room', 'third-room']);
      assert.strictEqual(st.body.site.legacyRoom, 'old_streamer');
      assert.strictEqual((await post('/api/site/update', { name: 'second-room', dedicated: true }, 'owner-pw')).status, 200);
      d = (await R('/api/rooms')).body; assert.ok(d.featured.some((r) => r.name === 'second-room'));
      const np = await post('/api/site/resetpw', { name: 'third-room' }, 'owner-pw');
      assert.strictEqual((await post('/third-room/api/admin/status', {}, np.body.password)).status, 200);
      assert.strictEqual((await post('/api/site/delete', { name: 'third-room', confirm: 'nope' }, 'owner-pw')).status, 400);
      assert.strictEqual((await post('/api/site/delete', { name: 'third-room', confirm: 'third-room' }, 'owner-pw')).status, 200);
      assert.strictEqual((await R('/third-room/api/state')).status, 404);
      assert.ok(fs.readdirSync(path.join(dir, 'deleted-rooms')).some((n) => n.startsWith('third-room-')));
      assert.strictEqual((await post('/api/site/create', { name: 'hosted-one', dedicated: true, platform: 'kick', channel: 'hosted_one' }, 'owner-pw')).status, 200);
      assert.strictEqual((await R('/hosted-one/api/state')).body.channels.kick, 'hosted_one');
      assert.strictEqual((await post('/api/site/settings', { openRooms: false }, 'owner-pw')).status, 200);
      assert.strictEqual((await R('/api/rooms')).body.openRooms, false);
      assert.strictEqual((await post('/api/rooms', { name: 'blocked-room' })).status, 403);
      // the wrong-password counters are per room: guessing at one room does not lock another
      for (let i = 0; i < 8; i++) await post('/second-room/api/admin/status', {}, 'guess' + i);
      assert.strictEqual((await post('/second-room/api/admin/status', {}, 'guess9')).status, 429);
      assert.strictEqual((await post('/hosted-one/api/admin/status', {}, 'typo')).status, 401);
    } finally { child.kill('SIGTERM'); }
    // a restart keeps every room
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'rooms')).sort(), ['hosted-one', 'newstreamer', 'old_streamer', 'second-room']);
    assert.ok(!fs.existsSync(path.join(dir, 'state.json')), 'the old file was moved into the room');
  });

  await t('deleted rooms are erased for good after DELETED_KEEP_DAYS (30)', () => {
    fs.mkdirSync(rooms.TRASH_DIR, { recursive: true });
    const old = path.join(rooms.TRASH_DIR, 'old-room-2020-01-01-1'), fresh = path.join(rooms.TRASH_DIR, 'new-room-x');
    fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(fresh, { recursive: true });
    const long = new Date(Date.now() - 31 * 86400000); fs.utimesSync(old, long, long);
    rooms.pruneTrash(Date.now());
    assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(fresh));
  });

  await t('security: password guessing cannot stall the server, cross-room guessing is capped, CSRF/framing/upload limits', async () => {
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-sec-'));
    const port = 3914, b4 = 'http://localhost:' + port;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DATA_DIR: dir, PORT: String(port), SITE_ADMIN_PASSWORD: 'owner-pw', ADMIN_PASSWORD: '', TRUST_PROXY_HOPS: '1', MAX_AWAKE_ROOMS: '2', MAX_BACKGROUND_MB: '1' }, stdio: 'ignore',
    });
    const R = async (u, opt = {}) => { const r = await fetch(b4 + u, opt); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };
    const post = (u, body, hdr = {}) => R(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr }, body: JSON.stringify(body || {}) });
    try {
      for (let i = 0; i < 50; i++) { try { if ((await fetch(b4 + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
      const made = [];
      for (let i = 0; i < 12; i++) {
        const r = await post('/api/rooms', { name: 'sec-room-' + i }, { 'x-forwarded-for': `40.0.${i >> 1}.1` });   // 3 an hour per address: spread out
        assert.strictEqual(r.status, 200, 'make room ' + i); made.push(r.body);
      }
      // CSRF: a cross-site form can only send text/plain or form data; those are refused
      assert.strictEqual((await R('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-forwarded-for': '41.0.0.1' }, body: JSON.stringify({ name: 'csrf-room' }) })).status, 415);
      // 120 wrong guesses at 12 rooms from 120 addresses at once: each costs a hash, but the server keeps answering quickly
      const flood = Array.from({ length: 120 }, (_, i) => post(`/sec-room-${i % 12}/api/admin/status`, {}, { 'x-admin-password': 'guess-' + i, 'x-forwarded-for': `50.1.${i}.1` }));
      const t0 = Date.now(); const h = await fetch(b4 + '/healthz'); const lag = Date.now() - t0;
      assert.ok(h.ok && lag < 250, `health check took ${lag} ms during the flood`);
      const st = await Promise.all(flood); assert.ok(st.every((r) => r.status === 401 || r.status === 429));
      // one address guessing across many rooms: after 20 wrong it gets 429 without any hashing, even at a fresh room
      let last;
      for (let i = 0; i < 21; i++) last = await post(`/sec-room-${i % 12}/api/admin/status`, {}, { 'x-admin-password': 'nope' + i, 'x-forwarded-for': '60.0.0.1' });
      assert.strictEqual(last.status, 429);
      assert.strictEqual((await post('/sec-room-11/api/mod/status', {}, { 'x-mod-password': 'nope', 'x-forwarded-for': '60.0.0.1' })).status, 429);
      // ...while the real owner elsewhere still gets in, and the site owner always does
      assert.strictEqual((await post('/sec-room-3/api/admin/status', {}, { 'x-admin-password': made[3].password, 'x-forwarded-for': '61.0.0.1' })).status, 200);
      assert.strictEqual((await post('/sec-room-4/api/admin/status', {}, { 'x-admin-password': 'owner-pw', 'x-forwarded-for': '60.0.0.1' })).status, 200);
      // framing: password pages refuse to be framed; the viewer page and home page may be
      const adminPage = await fetch(b4 + '/sec-room-1/admin'), viewer = await fetch(b4 + '/sec-room-1/'), siteP = await fetch(b4 + '/site-admin');
      for (const r of [adminPage, siteP]) { assert.strictEqual(r.headers.get('x-frame-options'), 'DENY'); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/); }
      assert.strictEqual(viewer.headers.get('x-frame-options'), null); assert.match(viewer.headers.get('content-security-policy'), /connect-src 'self'/);
      // background uploads are capped (MAX_BACKGROUND_MB=1 here), with a clear message
      await post('/api/site/update', { name: 'sec-room-3', dedicated: true }, { 'x-admin-password': 'owner-pw', 'x-forwarded-for': '62.0.0.2' });
      const big = Buffer.alloc(1.5 * 1024 * 1024); big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const up = await fetch(b4 + '/sec-room-3/api/admin/background', { method: 'POST', headers: { 'x-admin-password': made[3].password, 'x-forwarded-for': '61.0.0.1' }, body: big }).catch(() => ({ status: 413 }));
      assert.strictEqual(up.status, 413);
      // at most MAX_AWAKE_ROOMS (2 here) community rooms keep chat connected; the most recently used win
      await post('/api/site/update', { name: 'sec-room-0', listed: true }, { 'x-admin-password': 'owner-pw', 'x-forwarded-for': '62.0.0.1' });   // runs a tick
      const list = (await post('/api/site/status', {}, { 'x-admin-password': 'owner-pw', 'x-forwarded-for': '62.0.0.1' })).body.rooms;
      assert.strictEqual(list.filter((r) => r.kind !== 'dedicated' && r.chat === 'on').length, 2, list.map((r) => r.name + ':' + r.chat).join(' '));
    } finally { child.kill('SIGTERM'); }
  });

  // ---------------- 2.1 features ----------------
  await t('chat: only lines starting with "!" are parsed; every line is still counted', () => {
    const fast = require('../src/chat/fast');
    const tw = (x) => '@badges=;display-name=A;user-id=1 :a!a@a.tmi.twitch.tv PRIVMSG #chan :' + x;
    assert.deepStrictEqual(['!enter', ' !mark 2', '\u0001ACTION !enter\u0001', 'hello !enter', 'lol', '\u0001ACTION waves\u0001'].map((x) => fast.twitchMaybeCommand(tw(x))), [true, true, true, false, false, false]);
    const kf = (x) => JSON.stringify({ event: 'App\\Events\\ChatMessageEvent', channel: 'chatrooms.1.v2', data: JSON.stringify({ id: '1', content: x, sender: { id: 5, username: 'u', identity: { badges: [] } } }) });
    assert.deepStrictEqual(['!enter', '  !mark 3', 'nice !enter', 'gg', ''].map((x) => fast.kickMaybeCommand(kf(x))), [true, true, false, false, false]);
    assert.strictEqual(fast.kickMaybeCommand('{"event":"something else"}'), true, 'unknown shapes fall through to the full parser');
    const chat = require('../src/chat').createChat({ handleChat: () => null, touch() {}, state: { settings: { channels: {} } } });
    chat.status.kick = { seen: 40 }; chat.status.twitch = { seen: 2 };
    assert.strictEqual(chat.seenTotal(), 42);
  });

  await t('idle games close after GAME_IDLE_MINUTES and can be re-opened 3 times a day, keeping cards and calls', () => {
    const g = rooms.create('idle-room').entry.game;
    g.startGame(); g.enter('kick', '9', 'Sleepy', ''); g.mark('1', true, 'mod');
    const card = JSON.stringify(g.state.game.players['kick:9'].card);
    const now = Date.now();
    assert.strictEqual(g.idleCheck(now + 29 * 60000, 30 * 60000), false, 'not yet');
    assert.strictEqual(g.idleCheck(now + 31 * 60000, 30 * 60000), true, 'closed');
    assert.strictEqual(g.state.game.active, false); assert.strictEqual(g.state.game.closedIdle, true);
    assert.strictEqual(g.publicState().game.closedIdle, true);
    assert.strictEqual(g.handleChat({ platform: 'kick', userId: '10', name: 'Late', text: '!enter', roles: {} }).ok, false, 'closed game takes no entries');
    for (let i = 3; i >= 1; i--) {
      assert.strictEqual(g.reopen().reopensLeft, i - 1);
      assert.strictEqual(g.state.game.active, true);
      assert.strictEqual(JSON.stringify(g.state.game.players['kick:9'].card), card); assert.deepStrictEqual(g.state.game.called, [1]);
      g.idleCheck(Date.now() + 31 * 60000, 30 * 60000);
    }
    assert.throws(() => g.reopen(), /3 games today/);
    g.state.game.closedIdle = false;   // a game ended by hand is not re-openable
    assert.throws(() => g.reopen(), /Only a game that was closed for being idle/);
    g.state.room.reopens = { day: 'yesterday', count: 3 }; g.state.game.closedIdle = true;
    assert.strictEqual(g.reopen().reopensLeft, 2, 'the count starts again the next day');
    rooms.remove('idle-room');
  });

  await t('viewer marks: count per word, skip called words and "marked everything" cards, only when allowed', () => {
    const g = rooms.create('count-room').entry.game;
    g.startGame();
    for (let i = 0; i < 4; i++) g.enter('twitch', String(100 + i), 'Fan' + i, '');
    const P = (i) => g.state.game.players['twitch:' + (100 + i)];
    assert.throws(() => g.viewMark('Fan0', 'twitch', P(0).card[0], true), /switched off/);
    g.state.settings.viewerMarking = true;
    const w = P(0).card[0];
    for (let i = 0; i < 3; i++) if (P(i).card.includes(w)) g.viewMark('Fan' + i, 'twitch', w, true);
    const expect = [0, 1, 2].filter((i) => P(i).card.includes(w)).length;
    assert.strictEqual(g.viewCounts()[w], expect);
    assert.throws(() => g.viewMark('Fan0', 'twitch', 0, true), /not on this card/);
    assert.throws(() => g.viewMark('Nobody', 'twitch', w, true), /No card/);
    // un-marking lowers the count; a called word is not counted any more
    g.viewMark('Fan0', 'twitch', w, false);
    assert.strictEqual(g.viewCounts()[w] || 0, expect - 1);
    g.viewMark('Fan0', 'twitch', w, true);
    g.mark(String(w), true, 'mod');
    assert.strictEqual(g.viewCounts()[w], undefined, 'called words are not counted');
    // Fan3 marks every square while few are really called: ignored entirely
    for (const c of P(3).card) if (c) g.viewMark('Fan3', 'twitch', c, true);
    const counts = g.viewCounts(), fan3word = P(3).card.find((c) => c && !g.state.game.called.includes(c) && !P(0).card.includes(c) && !P(1).card.includes(c) && !P(2).card.includes(c));
    if (fan3word) assert.strictEqual(counts[fan3word], undefined, 'the blackout-clicker is not counted');
    // the admin and mod views carry the counts
    g.viewMark('Fan1', 'twitch', P(1).card.find((c) => c && !g.state.game.called.includes(c)), true);
    assert.ok(Object.keys(g.adminState().game.viewCounts).length >= 1);
    g.viewMark('Fan1', 'twitch', 0, false, true);
    assert.strictEqual(g.state.game.viewMarks['twitch:101'], undefined, 'clear removes a viewer\'s marks');
    rooms.remove('count-room');
  });

  await t('viewer marks: someone who marks more than one player\'s card counts for nothing', () => {
    const g = rooms.create('multi-room').entry.game;
    g.state.settings.viewerMarking = true;
    g.startGame();
    for (let i = 0; i < 3; i++) g.enter('kick', String(500 + i), 'Watcher' + i, '');
    const P = (i) => g.state.game.players['kick:' + (500 + i)];
    const free = (i) => P(i).card.filter((c) => c && !g.state.game.called.includes(c));
    // an honest viewer marks only their own card: counted
    g.viewMark('Watcher0', 'kick', free(0)[0], true, false, ['ip:1.1.1.1', 't:honest-viewer-0']);
    assert.strictEqual(g.viewCounts()[free(0)[0]], 1);
    // another viewer marks their own card, then someone else's: none of their marks count, on either card
    g.viewMark('Watcher1', 'kick', free(1)[0], true, false, ['ip:2.2.2.2', 't:snooper-viewer']);
    assert.strictEqual(g.viewCounts()[free(1)[0]] >= 1, true, 'counted while it is only one card');
    g.viewMark('Watcher2', 'kick', free(2)[1], true, false, ['ip:9.9.9.9', 't:snooper-viewer']);   // same browser, other address
    const c = g.viewCounts();
    assert.strictEqual(c[free(2)[1]] || 0, (free(0)[0] === free(2)[1] ? 1 : 0), 'the second card is not counted');
    assert.ok(!(free(1)[0] in c) || free(1)[0] === free(0)[0], 'the first card is no longer counted either');
    assert.ok(g.multiMarked('kick:501') && g.multiMarked('kick:502') && !g.multiMarked('kick:500'));
    // the same address on two cards counts as one person too
    g.viewMark('Watcher0', 'kick', free(0)[1], true, false, ['ip:2.2.2.2', 't:another-browser']);
    assert.ok(g.multiMarked('kick:500'), 'shared address');
    assert.deepStrictEqual(g.viewCounts(), {});
    rooms.remove('multi-room');
  });

  await t('spam guard: lots of chat with no game activity pauses a community room; the admin page lifts it', () => {
    const e = rooms.create('noisy-room').entry;
    const now = Date.now();
    assert.strictEqual(rooms.chatLimit(2), Infinity); assert.strictEqual(rooms.chatLimit(10), 1000); assert.strictEqual(rooms.chatLimit(20), 500); assert.strictEqual(rooms.chatLimit(120), 300);
    rooms.wake(e);
    e.game.state.room.lastActive = now - 20 * 60000;      // quiet for 20 minutes: 500 lines a minute allowed
    const feed = (n) => { e.chat.status.kick = { ...(e.chat.status.kick || {}), seen: ((e.chat.status.kick && e.chat.status.kick.seen) || 0) + n }; rooms.tick(now); };
    feed(400); assert.ok(!e.flood && e.chat.running, 'under the limit');
    feed(900); feed(900); assert.ok(!e.flood, 'two minutes over is not enough');
    feed(900); assert.ok(e.flood, 'three minutes over pauses chat');
    assert.strictEqual(e.chat.running, false);
    assert.match(rooms.summary('noisy-room', e).chat, /spam guard/);
    rooms.wake(e); assert.ok(!e.flood && e.chat.running, 'opening the admin page lifts it');
    // a featured room is never paused
    const f = rooms.create('busy-featured', { kind: 'dedicated' }).entry; f.game.state.room.lastActive = now - 3600000; rooms.wake(f); f.game.state.room.lastActive = now - 3600000;
    for (let i = 0; i < 4; i++) { f.chat.status.kick = { seen: ((f.chat.status.kick && f.chat.status.kick.seen) || 0) + 5000 }; rooms.tick(now); }
    assert.ok(!f.flood && f.chat.running);
    rooms.remove('noisy-room'); rooms.remove('busy-featured');
  });

  await t('templates, page colours and viewer marking over HTTP', async () => {
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-21-'));
    const port = 3915, b6 = 'http://localhost:' + port;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), SITE_ADMIN_PASSWORD: 'owner-pw', ADMIN_PASSWORD: '', TRUST_PROXY_HOPS: '' }, stdio: 'ignore' });
    const call = (u, pw, body) => fetch(b6 + u, { method: 'POST', headers: { 'x-admin-password': pw, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    try {
      for (let i = 0; i < 50; i++) { try { if ((await fetch(b6 + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
      const mk = await fetch(b6 + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'tpl-room' }) }).then((r) => r.json());
      const A = (action, body) => call('/tpl-room/api/admin/' + action, mk.password, body);
      const S2 = (action, body) => call('/api/site/' + action, 'owner-pw', body);
      const words = (k) => Array.from({ length: 26 }, (_, i) => `${k} word ${i + 1}`);
      // site templates
      assert.strictEqual((await S2('templateadd', { name: 'Too short', phrases: ['a', 'b'] })).status, 400);
      const st = await S2('templateadd', { name: 'Horror games', phrases: words('horror') }); assert.strictEqual(st.status, 200);
      const st2 = await S2('templateadd', { name: 'Racing', phrases: words('racing') });
      // a room saves its own, loads either kind, hides a site one
      assert.strictEqual((await A('templatesave', { name: 'My list', phrases: words('mine') })).status, 200);
      assert.strictEqual((await A('templatesave', { name: 'my list', phrases: words('mine2') })).body.replaced, true, 'same name updates');
      let tl = (await A('templates')).body;
      assert.deepStrictEqual(tl.mine.map((x) => x.name), ['My list']); assert.ok(tl.site.some((x) => x.name === 'Horror games'));
      assert.strictEqual((await A('templateload', { source: 'site', id: st.body.id })).body.phrases[0], 'horror word 1');
      assert.strictEqual((await A('templateload', { source: 'room', id: tl.mine[0].id })).body.phrases[0], 'mine2 word 1');
      await A('templatehide', { id: st.body.id, hidden: true });
      assert.strictEqual((await A('templates')).body.site.find((x) => x.id === st.body.id).hidden, true);
      // the site owner hides one from every room and deletes another
      await S2('templatehide', { id: st2.body.id, hidden: true });
      assert.ok(!(await A('templates')).body.site.some((x) => x.id === st2.body.id));
      assert.strictEqual((await A('templateload', { source: 'site', id: st2.body.id })).status, 400);
      await S2('templatedelete', { id: st.body.id });
      assert.strictEqual((await S2('templates')).body.templates.length, 1);
      await A('templatedelete', { id: tl.mine[0].id }); assert.strictEqual((await A('templates')).body.mine.length, 0);
      // card background colour: #rrggbb or empty; community rooms are told images are for featured rooms
      assert.strictEqual((await A('status')).body.backgroundAllowed, false);
      const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const refused = await fetch(b6 + '/tpl-room/api/admin/background', { method: 'POST', headers: { 'x-admin-password': mk.password, 'Content-Type': 'image/png' }, body: png1 });
      assert.strictEqual(refused.status, 403); assert.match((await refused.json()).error, /featured rooms/);
      await A('settings', { layout: { bgColor: '#123ABC' } });
      await A('settings', { layout: { bgColor: 'url(x)' } });
      assert.strictEqual((await fetch(b6 + '/tpl-room/api/state').then((r) => r.json())).layout.bgColor, '#123abc', 'junk is ignored');
      // page colours: only #rrggbb, shown to every visitor
      await A('settings', { theme: { bg: '#0b1726', panel: 'red; x', accent: '#3EC1FF', text: '' } });
      assert.deepStrictEqual((await fetch(b6 + '/tpl-room/api/state').then((r) => r.json())).theme, { bg: '#0b1726', panel: '', accent: '#3ec1ff', text: '' });
      // viewer marks sent from the room page
      const vm = (body, ct = 'application/json') => fetch(b6 + '/tpl-room/api/viewmark', { method: 'POST', headers: { 'Content-Type': ct }, body: JSON.stringify(body) }).then((r) => r.status);
      await A('start'); await A('simulate', { name: 'Clicker', platform: 'kick', text: '!enter' });
      const cell = (await fetch(b6 + '/tpl-room/api/card?name=Clicker').then((r) => r.json())).matches[0].cells.find((c) => !c.free);
      assert.strictEqual(await vm({ name: 'Clicker', platform: 'kick', n: cell.n, on: true }), 400, 'refused while viewer marking is off');
      await A('settings', { viewerMarking: true });
      assert.strictEqual(await vm({ name: 'Clicker', platform: 'kick', n: cell.n, on: true }), 200);
      assert.strictEqual(await vm({ name: 'Clicker', platform: 'kick', n: cell.n, on: true }, 'text/plain'), 415);
      assert.strictEqual(await vm({ name: 'Clicker', platform: 'kick', n: 9999, on: true }), 400);
      assert.strictEqual((await A('status')).body.game.viewCounts[cell.n], 1);
      assert.strictEqual((await call('/tpl-room/api/mod/status', '', {}).then(() => fetch(b6 + '/tpl-room/api/mod/status', { headers: { 'x-mod-password': mk.modPassword } })).then((r) => r.json())).game.viewCounts[cell.n], 1, 'mods see the counts too');
      // re-open only applies to idle-closed games
      assert.match((await A('reopen')).body.error, /already running/);
      await A('end'); assert.match((await A('reopen')).body.error, /Only a game that was closed for being idle/);
    } finally { child.kill('SIGTERM'); }
  });

  await t('named mod logins: own passwords, calls logged by name, removable; the shared password can be switched off', async () => {
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-mods-'));
    const port = 3918, b7 = 'http://localhost:' + port;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), SITE_ADMIN_PASSWORD: 'owner-pw', ADMIN_PASSWORD: '', TRUST_PROXY_HOPS: '' }, stdio: 'ignore' });
    const call = (u, hdr, body) => fetch(b7 + u, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...hdr }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    try {
      for (let i = 0; i < 50; i++) { try { if ((await fetch(b7 + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
      const mk = await call('/api/rooms', {}, { name: 'mod-room' }).then((r) => r.body);
      const A = (action, body) => call('/mod-room/api/admin/' + action, { 'x-admin-password': mk.password }, body || {});
      const M = (pw, action = 'status', body) => call('/mod-room/api/mod/' + action, { 'x-mod-password': pw }, body);
      // add two mods; names must be unique
      const ann = (await A('modadd', { name: 'Ann' })).body, bo = (await A('modadd', { name: 'Bo' })).body;
      assert.ok(ann.password.length >= 12 && bo.password !== ann.password);
      assert.strictEqual((await A('modadd', { name: 'ann' })).status, 400, 'names are unique');
      assert.strictEqual((await A('modadd', { name: '  ' })).status, 400, 'a name is needed');
      // the stored state has no plain passwords
      const raw = fs.readFileSync(path.join(dir, 'rooms', 'mod-room', 'state.json'), 'utf8');
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(!fs.readFileSync(path.join(dir, 'rooms', 'mod-room', 'state.json'), 'utf8').includes(ann.password) && !raw.includes(ann.password));
      // each mod logs in with their own password and is named
      assert.strictEqual((await M(ann.password)).body.loggedInAs, 'Ann');
      await A('start');
      await M(ann.password, 'mark', { word: '3' }); await M(bo.password, 'mark', { word: '4' }); await M(ann.password, 'unmark', { word: '3' });
      await A('mark', { word: '5' });
      await A('simulate', { name: 'ChatMod', platform: 'kick', text: '!mark 6', mod: true });
      const st = (await A('status')).body;
      const log = st.modLog.map((l) => `${l.who}|${l.source}|${l.action}|${l.n}`);
      assert.deepStrictEqual(log.slice(0, 5), ['ChatMod|chat (kick)|called|6', 'admin|admin page|called|5', 'Ann|mod page|un-called|3', 'Bo|mod page|called|4', 'Ann|mod page|called|3']);
      assert.deepStrictEqual(st.mods.map((m) => `${m.name}:${m.calls}`), ['Ann:2', 'Bo:1']);
      assert.ok(st.mods.every((m) => !('hash' in m) && !('salt' in m)), 'no hashes sent to the page');
      const feed = (await fetch(b7 + '/mod-room/api/state').then((r) => r.json())).feed.map((f) => f.text);
      assert.ok(feed.some((t) => /Called #4 .* \(by Bo on the mod page\)/.test(t)), 'the public feed names the mod');
      // a new password replaces the old; removing a mod locks them out
      const bo2 = (await A('modreset', { id: bo.id })).body;
      assert.strictEqual((await M(bo.password)).status, 401); assert.strictEqual((await M(bo2.password)).status, 200);
      await A('modremove', { id: bo.id });
      assert.strictEqual((await M(bo2.password)).status, 401);
      // the shared password works until switched off; named logins keep working
      assert.strictEqual((await M(mk.modPassword)).body.loggedInAs, 'shared mod login');
      await A('settings', { sharedModLogin: false });
      assert.strictEqual((await M(mk.modPassword)).status, 401);
      assert.strictEqual((await M(ann.password)).status, 200);
      assert.strictEqual((await M(mk.password)).body.loggedInAs, 'admin', 'the admin password still opens the mod page');
    } finally { child.kill('SIGTERM'); }
  });

  console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
  game.saveNow(); process.exit(process.exitCode || 0);
})();
