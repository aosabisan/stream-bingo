// Most chat lines are not bingo commands. These checks look only at the first character of the message, straight in the
// raw text that arrived, so everything that does not start with "!" is dropped before any parsing.
const isSpace = (c) => c === 32 || c === 9;   // space, tab

// true when the text starting at index i begins with "!" (after any spaces)
function bangAt(s, i) {
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  return s.charCodeAt(i) === 33;
}

// Twitch IRC line: "@tags :nick!nick@host PRIVMSG #chan :text". Also accepts /me lines ("\u0001ACTION !enter").
function twitchMaybeCommand(line) {
  const p = line.indexOf(' PRIVMSG #');
  if (p < 0) return false;
  const c = line.indexOf(' :', p + 10);
  if (c < 0) return false;
  if (bangAt(line, c + 2)) return true;
  return line.startsWith('\u0001ACTION ', c + 2) && bangAt(line, c + 10);
}

// Kick Pusher frame for a chat message: the message sits in "content" (escaped once, inside the data string).
function kickMaybeCommand(raw) {
  for (const key of ['\\"content\\":\\"', '"content":"']) {
    const i = raw.indexOf(key);
    if (i >= 0) return bangAt(raw, i + key.length);
  }
  return true;   // shape not recognised: let the full parser decide
}

module.exports = { bangAt, twitchMaybeCommand, kickMaybeCommand };
