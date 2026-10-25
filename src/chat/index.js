// One chat manager per room: starts the four chat readers from that room's channel settings
// and passes every message to that room's game.
const twitch = require('./twitch');
const kick = require('./kick');
const youtube = require('./youtube');
const rumble = require('./rumble');

const PLATFORMS = ['twitch', 'kick', 'youtube', 'rumble'];

// opts.kickApp() gives Kick's Pusher { key, cluster }, which is one setting for the whole site
function createChat(room, opts = {}) {
  const kickApp = opts.kickApp || (() => ({ key: '32cbd69e4b950bf97679', cluster: 'us2' }));
  const kickCfg = (ch) => { const a = kickApp(); return { ...ch, kickPusherKey: a.key, kickPusherCluster: a.cluster }; };
  const stops = {};
  const status = { twitch: {}, kick: {}, youtube: {}, rumble: {} };
  const log = [];
  const recentIds = new Set();
  let running = false;

  function onMessage(m) {
    const st = status[m.platform];
    if (st) { st.last = Date.now(); st.messages = (st.messages || 0) + 1; }
    if (m.id != null) { const k = m.platform + m.id; if (recentIds.has(k)) return; recentIds.add(k); if (recentIds.size > 800) recentIds.delete(recentIds.values().next().value); }
    const res = room.handleChat(m);
    if (res) {
      room.touch();
      log.unshift({ t: Date.now(), platform: m.platform, name: m.name, text: m.text.slice(0, 80), ok: res.ok, error: res.error });
      if (log.length > 30) log.length = 30;
    }
  }

  function startAll() {
    stopAll();
    running = true;
    const ch = room.state.settings.channels;
    const reset = (k) => { status[k] = { state: 'off' }; return status[k]; };
    if (ch.twitch) stops.twitch = twitch.start(ch.twitch, onMessage, reset('twitch')); else reset('twitch');
    if (ch.kick || ch.kickChatroomId) stops.kick = kick.start(kickCfg(ch), onMessage, reset('kick')); else reset('kick');
    if (ch.youtube) stops.youtube = youtube.start(ch.youtube, onMessage, reset('youtube')); else reset('youtube');
    if (ch.rumble) stops.rumble = rumble.start(ch.rumble, onMessage, reset('rumble')); else reset('rumble');
  }
  function stopAll() {
    for (const k of Object.keys(stops)) { try { stops[k](); } catch {} delete stops[k]; }
    if (running) for (const k of PLATFORMS) status[k] = { state: 'off' };
    running = false;
  }

  // reconnect only Kick (after the site's Pusher key changed); true when this room was connected to Kick
  function restartKick() {
    if (!running || !stops.kick) return false;
    try { stops.kick(); } catch {}
    const ch = room.state.settings.channels;
    status.kick = { state: 'off' };
    stops.kick = kick.start(kickCfg(ch), onMessage, status.kick);
    return true;
  }

  // chat lines seen since chat was (re)connected, over all platforms (the readers count every line, commands or not)
  const seenTotal = () => PLATFORMS.reduce((n, k) => n + ((status[k] && status[k].seen) || 0), 0);
  return { startAll, stopAll, restartKick, status, log, onMessage, seenTotal, get running() { return running; } };
}

module.exports = { createChat };
