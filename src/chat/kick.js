// Kick chat through the public Pusher socket the Kick website itself uses. No API key.
// Unofficial: Kick can change the key or message format. Both are editable in the admin page.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function parseEvent(raw) {
  let outer; try { outer = JSON.parse(raw); } catch { return null; }
  if (!outer || outer.event !== 'App\\Events\\ChatMessageEvent') return null;
  let d = outer.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return null; } }
  if (!d || !d.sender) return null;
  const types = ((d.sender.identity && d.sender.identity.badges) || []).map((b) => String(b.type || '').toLowerCase());
  return {
    platform: 'kick', id: d.id, userId: d.sender.id, name: d.sender.username, text: String(d.content || ''),
    roles: { broadcaster: types.includes('broadcaster'), mod: types.includes('moderator'), vip: types.includes('vip') },
  };
}

async function findChatroomId(slug) {
  const r = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug), { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Kick answered ${r.status} when looking up the chat room. Open https://kick.com/api/v2/channels/${slug} in your browser, find "chatroom":{"id":NUMBER, and paste that number into the Kick chat room ID box on the admin page.`);
  const j = await r.json();
  if (!j.chatroom || !j.chatroom.id) throw new Error('Kick channel found but no chat room id in the reply.');
  return String(j.chatroom.id);
}

function start(cfg, emit, status) {
  let ws, stopped = false, retry = 3000, timer, watchdog;
  const connect = async () => {
    if (stopped) return;
    status.state = 'connecting'; status.error = '';
    let room;
    try { room = cfg.kickChatroomId || (cfg.kick ? await findChatroomId(cfg.kick) : ''); } catch (e) { if (stopped) return; status.state = 'error'; status.error = e.message; timer = setTimeout(connect, 60000); return; }
    // the settings may have been changed while the lookup was running: do not open a second, orphaned connection
    if (stopped) return;
    if (!room) { status.state = 'off'; return; }
    status.chatroomId = room;
    const url = `wss://ws-${cfg.kickPusherCluster || 'us2'}.pusher.com/app/${cfg.kickPusherKey}?protocol=7&client=js&version=8.4.0&flash=false`;
    ws = new WebSocket(url);
    // Pusher pings about every 2 minutes. If nothing at all arrives for 3 minutes the socket is dead
    // without having closed (sleeping laptop, dropped Wi-Fi), so close it and let it reconnect.
    const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { try { ws.close(); } catch {} }, 3 * 60 * 1000); };
    ws.onopen = arm;
    ws.onmessage = (ev) => {
      arm();
      let o; try { o = JSON.parse(ev.data); } catch { return; }
      if (o.event === 'pusher:connection_established') ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${room}.v2` } }));
      else if (o.event === 'pusher_internal:subscription_succeeded') { status.state = 'connected'; retry = 3000; }
      else if (o.event === 'pusher:ping') ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      else if (o.event === 'pusher:error') status.error = String(o.data && (o.data.message || o.data));
      else { const m = parseEvent(ev.data); if (m) emit(m); }
    };
    ws.onerror = () => { status.error = status.error || 'connection error'; };
    ws.onclose = () => { clearTimeout(watchdog); if (stopped) return; status.state = 'reconnecting'; timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 60000); };
  };
  connect();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(watchdog); try { ws && ws.close(); } catch {} };
}

module.exports = { start, parseEvent };
