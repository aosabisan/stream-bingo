// One chat manager per room: starts the four chat readers from that room's channel settings
// and passes every message to that room's game.
const twitch = require('./twitch');
const kick = require('./kick');
const youtube = require('./youtube');
const rumble = require('./rumble');

const PLATFORMS = ['twitch', 'kick', 'youtube', 'rumble'];

function createChat(room) {
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
    if (ch.kick || ch.kickChatroomId) stops.kick = kick.start(ch, onMessage, reset('kick')); else reset('kick');
    if (ch.youtube) stops.youtube = youtube.start(ch.youtube, onMessage, reset('youtube')); else reset('youtube');
    if (ch.rumble) stops.rumble = rumble.start(ch.rumble, onMessage, reset('rumble')); else reset('rumble');
  }
  function stopAll() {
    for (const k of Object.keys(stops)) { try { stops[k](); } catch {} delete stops[k]; }
    if (running) for (const k of PLATFORMS) status[k] = { state: 'off' };
    running = false;
  }

  return { startAll, stopAll, status, log, onMessage, get running() { return running; } };
}

module.exports = { createChat };
