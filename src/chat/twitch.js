// Twitch chat over the public IRC WebSocket, read-only anonymous login. No API key.
const { twitchMaybeCommand } = require('./fast');
function parseLine(line) {
  // @tags :nick!nick@nick.tmi.twitch.tv PRIVMSG #channel :message
  const m = /^(?:@(\S+) )?:([^!\s]+)![^ ]+ PRIVMSG #\S+ :(.*)$/.exec(line);
  if (!m) return null;
  const tags = {};
  for (const kv of (m[1] || '').split(';')) { const i = kv.indexOf('='); if (i > 0) tags[kv.slice(0, i)] = kv.slice(i + 1); }
  const badges = (tags.badges || '').split(',').map((b) => b.split('/')[0]);
  let text = m[3];
  if (text.startsWith('\u0001ACTION ')) text = text.slice(8).replace(/\u0001$/, '');
  return {
    platform: 'twitch', id: tags.id, userId: tags['user-id'], name: tags['display-name'] || m[2], text,
    // lead_moderator is Twitch's newer "lead mod" badge; it replaces the moderator badge for those users
    roles: { broadcaster: badges.includes('broadcaster'), mod: badges.includes('moderator') || badges.includes('lead_moderator'), vip: badges.includes('vip') },
  };
}

function start(channel, emit, status) {
  let ws, stopped = false, retry = 2000, watchdog;
  const name = String(channel).replace(/^#/, '').toLowerCase();
  const connect = () => {
    if (stopped) return;
    status.state = 'connecting'; status.error = '';
    ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { try { ws.close(); } catch {} }, 6 * 60 * 1000); };
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 89999));
      ws.send('JOIN #' + name);
      arm();
    };
    ws.onmessage = (ev) => {
      arm();
      for (const line of String(ev.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        if (line.includes(' 366 ')) { status.state = 'connected'; retry = 2000; continue; }
        if (line.includes('NOTICE') && /Login unsuccessful|Improperly formatted/i.test(line)) status.error = line;
        if (line.indexOf(' PRIVMSG #') < 0) continue;
        status.seen = (status.seen || 0) + 1;      // every chat line counts toward the room's chat rate
        if (!twitchMaybeCommand(line)) continue;   // not a "!" command: skip without parsing
        const m = parseLine(line);
        if (m) emit(m);
      }
    };
    ws.onerror = () => { status.error = status.error || 'connection error'; };
    ws.onclose = () => {
      clearTimeout(watchdog);
      if (stopped) return;
      status.state = 'reconnecting';
      setTimeout(connect, retry); retry = Math.min(retry * 2, 60000);
    };
  };
  connect();
  return () => { stopped = true; clearTimeout(watchdog); try { ws.close(); } catch {} };
}

module.exports = { start, parseLine };
