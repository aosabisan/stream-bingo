// YouTube live chat read the way the YouTube page itself does it. No API key.
const { bangAt } = require('./fast');
// Unofficial: YouTube can change this without notice. YouTube has no VIP role, so only the owner and moderators can mark words.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HEAD = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+1' };

function videoIdFromInput(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(s) || /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(s) || /\/live\/([A-Za-z0-9_-]{11})/.exec(s);
  return m ? m[1] : null;
}

async function findLiveVideo(input) {
  const direct = videoIdFromInput(input);
  if (direct) return direct;
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^UC[\w-]{22}$/.test(s)) s = `https://www.youtube.com/channel/${s}`;
  else if (s.startsWith('@')) s = `https://www.youtube.com/${s}`;
  else if (!/^https?:/.test(s)) s = `https://www.youtube.com/@${s}`;
  const url = s.replace(/\/(live|streams|videos|featured)?\/?$/, '') + '/live';
  const r = await fetch(url, { headers: HEAD, redirect: 'follow' });
  const html = await r.text();
  const canon = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/.exec(html);
  if (canon && /"isLiveNow":true|"isLive":true/.test(html)) return canon[1];
  return null;
}

function extractJson(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  let j = html.indexOf('{', i), depth = 0, inStr = false, esc = false;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(j, k + 1)); } catch { return null; } }
  }
  return null;
}

function continuationOf(cont) {
  const c = (cont.continuations || [])[0] || {};
  const d = c.invalidationContinuationData || c.timedContinuationData || c.reloadContinuationData || c.liveChatReplayContinuationData;
  return d ? { token: d.continuation, wait: d.timeoutMs } : null;
}

function parseAction(a) {
  const r = a && a.addChatItemAction && a.addChatItemAction.item && a.addChatItemAction.item.liveChatTextMessageRenderer;
  if (!r) return null;
  const text = (r.message && r.message.runs || []).map((x) => x.text || '').join('');
  const icons = (r.authorBadges || []).map((b) => String((b.liveChatAuthorBadgeRenderer && b.liveChatAuthorBadgeRenderer.icon && b.liveChatAuthorBadgeRenderer.icon.iconType) || '').toUpperCase());
  return {
    platform: 'youtube', id: r.id, userId: r.authorExternalChannelId,
    name: (r.authorName && r.authorName.simpleText) || '', text,
    roles: { broadcaster: icons.includes('OWNER'), mod: icons.includes('MODERATOR'), vip: false },
  };
}

function start(input, emit, status) {
  let stopped = false, timer;
  const sleep = (ms) => new Promise((res) => { timer = setTimeout(res, ms); });
  (async () => {
    while (!stopped) {
      try {
        status.state = 'connecting'; status.error = '';
        const vid = await findLiveVideo(input);
        if (!vid) { status.state = 'waiting'; status.error = 'No live stream found on that channel right now. Checking again in a minute.'; await sleep(60000); continue; }
        status.videoId = vid;
        const r = await fetch(`https://www.youtube.com/live_chat?is_popout=1&v=${vid}`, { headers: HEAD });
        const html = await r.text();
        const key = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1];
        const ver = (/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(html) || /"clientVersion":"([^"]+)"/.exec(html) || [])[1] || '2.20240101.00.00';
        const data = extractJson(html, 'ytInitialData');
        const lcr = data && data.contents && data.contents.liveChatRenderer;
        let next = lcr && continuationOf(lcr);
        if (!key || !next) throw new Error('Could not read the YouTube chat page (it may have changed or chat is disabled).');
        let first = true; const seen = new Set();
        status.state = 'connected';
        while (!stopped && next) {
          const resp = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${key}`, {
            method: 'POST', headers: { ...HEAD, 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver } }, continuation: next.token }),
          });
          if (!resp.ok) throw new Error('YouTube chat answered ' + resp.status);
          const j = await resp.json();
          const cc = j.continuationContents && j.continuationContents.liveChatContinuation;
          if (!cc) throw new Error('YouTube chat ended.');
          // the first reply is the chat backlog: skip it so old commands are not replayed
          if (stopped) return;   // channel settings changed while this request was out: drop it
          if (!first) for (const act of cc.actions || []) { const m = parseAction(act); if (m && !seen.has(m.id)) { seen.add(m.id); status.seen = (status.seen || 0) + 1; if (bangAt(m.text, 0)) emit(m); } }
          else for (const act of cc.actions || []) { const m = parseAction(act); if (m) seen.add(m.id); }
          first = false;
          next = continuationOf(cc);
          await sleep(Math.min(Math.max(Number(next && next.wait) || 3000, 1500), 10000));
        }
      } catch (e) { if (stopped) return; status.state = 'error'; status.error = e.message; await sleep(30000); }
    }
  })();
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { start, parseAction, videoIdFromInput };
