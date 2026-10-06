// Starts the four chat readers from the saved channel settings and passes every message to the game.
const game = require('../game');
const twitch = require('./twitch');
const kick = require('./kick');
const youtube = require('./youtube');
const rumble = require('./rumble');

const stops = {};
const status = { twitch: {}, kick: {}, youtube: {}, rumble: {} };
const log = [];
const recentIds = new Set();

function onMessage(m) {
  const st = status[m.platform];
  if (st) { st.last = Date.now(); st.messages = (st.messages || 0) + 1; }
  if (m.id != null) { const k = m.platform + m.id; if (recentIds.has(k)) return; recentIds.add(k); if (recentIds.size > 800) recentIds.delete(recentIds.values().next().value); }
  const res = game.handleChat(m);
  if (res) {
    log.unshift({ t: Date.now(), platform: m.platform, name: m.name, text: m.text.slice(0, 80), ok: res.ok, error: res.error });
    if (log.length > 30) log.length = 30;
    if (!res.ok) console.log(`[chat] ${m.platform}/${m.name}: ${m.text} -> ${res.error}`);
  }
}

function startAll() {
  stopAll();
  const ch = game.state.settings.channels;
  const reset = (k) => { status[k] = { state: 'off' }; return status[k]; };
  if (ch.twitch) stops.twitch = twitch.start(ch.twitch, onMessage, reset('twitch')); else reset('twitch');
  if (ch.kick || ch.kickChatroomId) stops.kick = kick.start(ch, onMessage, reset('kick')); else reset('kick');
  if (ch.youtube) stops.youtube = youtube.start(ch.youtube, onMessage, reset('youtube')); else reset('youtube');
  if (ch.rumble) stops.rumble = rumble.start(ch.rumble, onMessage, reset('rumble')); else reset('rumble');
}
function stopAll() { for (const k of Object.keys(stops)) { try { stops[k](); } catch {} delete stops[k]; } }

module.exports = { startAll, stopAll, status, log, onMessage };
