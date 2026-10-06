// Rumble live chat through the stream Rumble's own page uses. No API key.
// EXPERIMENTAL: this is the least documented of the four. Raw samples are kept in the admin page so it can be adjusted quickly.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Accepts: a numeric chat id, a video id like v5abc12, or a Rumble video URL.
async function resolveChatId(input) {
  const s = String(input || '').trim();
  if (/^\d{5,}$/.test(s)) return s;
  const m = /\b(v[0-9a-z]{4,10})\b/.exec(s);
  if (m && !/^https?:/.test(s) && /^v[0-9a-z]+$/.test(s)) return String(parseInt(m[1].slice(1), 36));
  if (/^https?:/.test(s)) {
    const r = await fetch(s, { headers: { 'User-Agent': UA } });
    const html = await r.text();
    const direct = /chat\/api\/chat\/(\d+)/.exec(html) || /"chat_id"\s*:\s*"?(\d+)/.exec(html);
    if (direct) return direct[1];
    const vid = /\/(v[0-9a-z]{4,10})(?:-|\.|\/|$)/.exec(new URL(s).pathname);
    if (vid) return String(parseInt(vid[1].slice(1), 36));
  }
  return null;
}

function parsePayload(obj) {
  const data = obj && (obj.data || obj);
  if (!data || !Array.isArray(data.messages)) return [];
  const users = {};
  for (const u of data.users || []) users[u.id] = u;
  const out = [];
  for (const m of data.messages) {
    const u = users[m.user_id] || m.user || {};
    const name = u.username || u.name || m.username;
    if (!name) continue;
    const badges = (u.badges || m.badges || []).map((b) => String(typeof b === 'string' ? b : (b.name || b.slug || b.type || '')).toLowerCase());
    out.push({
      platform: 'rumble', id: m.id, userId: m.user_id || u.id, name, text: String(m.text || ''),
      roles: { broadcaster: badges.some((b) => /streamer|owner|creator/.test(b)), mod: badges.some((b) => /mod|admin/.test(b)), vip: badges.some((b) => /vip/.test(b)) },
    });
  }
  return out;
}

function start(input, emit, status) {
  let stopped = false, ctrl;
  status.samples = [];
  (async () => {
    let wait = 3000;
    while (!stopped) {
      try {
        status.state = 'connecting'; status.error = '';
        const id = await resolveChatId(input);
        if (!id) throw new Error('Could not work out the Rumble chat id. Paste the live video URL or the numeric chat id.');
        status.chatId = id;
        ctrl = new AbortController();
        const r = await fetch(`https://web7.rumble.com/chat/api/chat/${id}/stream`, { headers: { Accept: 'text/event-stream', 'User-Agent': UA }, signal: ctrl.signal });
        if (!r.ok) throw new Error('Rumble chat answered ' + r.status);
        status.state = 'connected'; wait = 3000;
        const dec = new TextDecoder(); let buf = ''; const seen = new Set();
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
            const dataLine = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
            if (!dataLine) continue;
            let obj; try { obj = JSON.parse(dataLine); } catch { continue; }
            if (status.samples.length < 3) status.samples.push(dataLine.slice(0, 600));
            // "init" carries the recent history: skip it so old commands are not replayed
            if (obj.type === 'init') { for (const m of parsePayload(obj)) seen.add(m.id); continue; }
            for (const m of parsePayload(obj)) { if (m.id != null && seen.has(m.id)) continue; seen.add(m.id); emit(m); }
          }
        }
      } catch (e) { if (stopped) return; status.state = 'error'; status.error = e.message; }
      await new Promise((res) => setTimeout(res, wait)); wait = Math.min(wait * 2, 60000);
    }
  })();
  return () => { stopped = true; try { ctrl && ctrl.abort(); } catch {} };
}

module.exports = { start, parsePayload, resolveChatId };
