# Stream Bingo (website)

One small server that reads Twitch, Kick, YouTube and Rumble chats, runs bingo games, and shows them on web pages.
It hosts **rooms**: each streamer gets their own room with its own game, word list, points, leaderboards, look and passwords.
No `npm install` needed. It only needs Node 22.4 or newer (the built-in WebSocket it uses for chat arrived in 22.4).

## Run it
1. Install Node 22.4+ (the current LTS is fine) from nodejs.org.
2. Double-click `start.bat` (or run `node server.js`).
3. Open http://localhost:3000. That is the home page: featured rooms, games that are live, and a form to make a room.
4. Make a room there. You get its address (for example `http://localhost:3000/mychannel/`) and its admin password, shown once.
   The room's admin page is that address + `admin`, its mod page + `mod`.
5. The site owner's page is http://localhost:3000/site-admin. Its password is `SITE_ADMIN_PASSWORD` (or `ADMIN_PASSWORD`).
   If neither is set, one is made for you and printed in the window (also saved in `data/admin-password.txt`).

## Rooms
- **Addresses:** `/<room>/` is a room's public page, `/<room>/admin` its admin page, `/<room>/mod` its mod page.
  Room names are 3-30 letters, numbers, `-` or `_` (so channel names fit). Words the site uses, like `admin` or `api`, are kept back.
- **Community rooms** are made by anyone from the home page (up to 3 an hour per visitor, 40 an hour in total, and a site-wide
  maximum you set). Each one gets its own admin password, shown once, which the room owner can change on their admin page.
  They are listed on the home page while a game is running, unless the owner turns that off.
- **Featured rooms** are made by the site owner on `/site-admin` (or by switching a community room to featured). They are always
  listed on the home page, keep chat connected all the time, and are never removed.
- **The site owner's password opens every room's admin page**, plus `/site-admin`, where you can see all rooms, feature or hide
  them, give a room a new admin password, delete a room, and switch off making new rooms.
- **Saving resources:** a community room disconnects from chat after `CHAT_IDLE_HOURS` (default 6) with no game running and nobody
  on its admin page. Opening the admin page or starting a game connects it again. Community rooms not used for
  `ROOM_EXPIRE_DAYS` (default 90, `0` = never) are removed. Removed and deleted rooms are moved to `DATA_DIR/deleted-rooms`,
  not erased, so you can bring one back by moving its folder into `DATA_DIR/rooms` and restarting.
- Room names are first come, first served. If someone takes a streamer's name, delete it on `/site-admin` and make it again as a featured room.

## Upgrading from 1.x (one game per site)
Nothing to do by hand. On the first start the existing game (`DATA_DIR/state.json` and the background) moves into a featured room named
after its Kick channel (or Twitch channel, or `LEGACY_ROOM` if you set it). It keeps its players, points, settings and mod password, and
its admin password stays the old `ADMIN_PASSWORD`. Old links keep working: `/?u=name`, `/admin` and `/mod` lead to that room.

Because that room keeps the old password, **set `SITE_ADMIN_PASSWORD` to a new password** for yourself when you upgrade. Otherwise whoever
uses the old admin password for that room can also open `/site-admin` and every other room.

## What viewers do
- `!enter` in chat to get a card, or `!enter 50` / `!enter all` to wager points.
- Open the room's page, type their chat name, and see their card fill in. Links like `/<room>/?u=name` can be shared.

## What mods and VIPs do (in any of the four chats)
- `!mark 7` or `!mark part of the text` marks a word. `!unmark 7` undoes it.
- The admin page has two switches, **Chat moderators** and **Chat VIPs**, that decide who may use `!mark` and `!unmark`.
  The streamer (and the channel owner's own account) can always do it.
- Mods and the streamer also have `!bingostart`, `!bingoend` and `!givepoints @name 50`.
- Everything above can also be done by clicking on the admin page.

## Mod page (`/<room>/mod`)
A separate login for people who should only check off words. It is the whole front page (card search, top-20 board with clickable names,
called words, leaderboards) and, once logged in, a **Call words** panel on top to call and un-call words. No settings, no points, no starting
or ending games. The mod password is made on first start and kept on the admin page, hidden until you press **Show** (there is also a **Copy** button).
You can change it there. The room's admin password (and the site owner's) also opens the mod page.

## Admin page
Start and end games, click words to call them, edit the word list, upload the card background, set the chat channels,
change points and payouts, rename the page, choose whether words called before someone joins count on their card, and send test chat messages to try the rules. The status table shows whether each chat is connected.
A new room starts blank: no chat channels, a general-purpose word list and "points" as the currency.
Set your channels, words, title and payouts on the admin page. The admin page also shows the room's address, whether its chat is
connected or asleep, a switch for being listed on the home page, and a box to change the room's admin password.
To give every new room a different starting word list, put a `words.default.txt` (one word per line) in `DATA_DIR`.

### Viewers marking their own cards
Two switches on the admin page, under Points and rules:
- **Viewers can click squares to mark their card.** Clicking a square on the public page dabs it in the viewer's chosen color.
  This only changes what that viewer sees, in their own browser. Nothing is sent to the server, and points, bingos and blackouts are
  still worked out by the server from the words your mods call.
- **Don't auto-mark cards on the page** (needs the first switch). Called words are no longer filled in on viewers' cards,
  so viewers play along by dabbing squares themselves. Scoring on the server is unchanged.

## Putting it on the internet
The server has to stay running, because it is the thing reading chat. It listens on `PORT` (default 3000) on all addresses.

**Hosting it yourself (the short version).** You need a machine that is always on and either Node 22+ or Docker.
1. Copy this folder to it.
2. Start it with the settings below, using one of these:
   - Node: `SITE_ADMIN_PASSWORD=choose-one TZ=America/Los_Angeles node server.js`
     (add `TRUST_PROXY_HOPS=1` once it is behind the HTTPS proxy in step 3)
   - Docker: `docker build -t bingo .` then
     `docker run -d --restart unless-stopped -p 3000:3000 -v bingo-data:/data -e SITE_ADMIN_PASSWORD=choose-one -e TZ=America/Los_Angeles -e TRUST_PROXY_HOPS=1 bingo`
3. Put it behind HTTPS. If your site already has a web server, proxy a path or subdomain to port 3000. With Caddy that is one line:
   `bingo.example.com { reverse_proxy localhost:3000 }`
4. Open `/site-admin`, add featured rooms for the streamers you host (or let them make their own on the home page), and you are done.

Settings that matter on a server:
- `SITE_ADMIN_PASSWORD`: the site owner's password (`/site-admin` and every room). Falls back to `ADMIN_PASSWORD`, then to one that is
  generated and saved in `DATA_DIR/admin-password.txt`.
- `ADMIN_PASSWORD`: the admin password from 1.x. Only used for the game that is moved into a room when upgrading (see above).
- `DATA_DIR`: where rooms are saved (`DATA_DIR/rooms/<room>/`). Point it at a persistent disk or the data is lost on restart.
- `MAX_ROOMS` (default 300): most community rooms at once. Also changeable on `/site-admin`.
- `CHAT_IDLE_HOURS` (default 6) and `ROOM_EXPIRE_DAYS` (default 90): see Rooms above.
- `LEGACY_ROOM`: the room name for the 1.x game when upgrading, if you do not want it named after its channel.
- `PORT`: set it if your host tells you which port to use.
- `TZ`: the weekly leaderboard resets on the server's clock. Servers usually run on UTC, so set `TZ` to your own time zone.
- `TRUST_PROXY_HOPS`: **set this when the site sits behind a reverse proxy** (Render, Railway, Fly.io, Caddy, nginx, a Cloudflare
  tunnel). Use the number of proxies in front of the server, usually `1`. The rate limits then use the visitor address that proxy
  wrote (the right-hand end of `X-Forwarded-For`). Without it the server only trusts the connection itself and ignores
  `X-Forwarded-For`, because a visitor can type anything into that header. Behind a proxy that would make every visitor look like
  the proxy, so all viewers would share one rate limit (card lookups are 60 a minute) and the page could start answering
  "Slow down" during a busy stream. Leave it unset when people connect to the server directly.
- Wrong passwords are limited to 8 per address and 60 in total per 10 minutes, counted separately for each room's admin and mod
  pages and for `/site-admin`. A correct password always works, so guessing cannot lock you out.
- `/healthz` answers 200 with the number of rooms, live games and connected chats. Use it as the health check path on Render,
  Fly.io or an uptime monitor.
- Docker on a host disk: if the mounted `/data` folder is owned by root the server cannot save. Either let the host create the
  volume (Docker named volumes are fine) or run `chown 1000:1000` on the folder once.

Hosts that run Node apps from a folder or a Dockerfile (Railway, Render, Fly.io, a VPS, a Raspberry Pi) all work the same way: start command
`node server.js`, a persistent volume for `DATA_DIR`, and the settings above. A "static site" host (GitHub Pages, shared web space) will not work,
because there is nothing there to run the server.

**From your own PC (free):** install Cloudflare's `cloudflared`, then run `cloudflared tunnel --url http://localhost:3000`.
It prints a public https address. A fixed address on your own domain needs a free Cloudflare account and a named tunnel.

Back up `DATA_DIR` now and then. Each room's `state.json` holds its cards, points and settings.
Each connected room keeps a few chat connections open, so a small server handles dozens of active rooms comfortably;
keep `MAX_ROOMS` in line with what your host allows.

## Things to know
- Chat is read only. The site cannot reply in chat, so viewers see results on the web page.
- Twitch reading is the standard anonymous chat connection. Kick, YouTube and Rumble have no public chat feed, so this reads
  the same feeds their own web pages use. They can change without notice. If one stops working, the admin page shows why.
- Kick: if the automatic lookup is blocked, open `https://kick.com/api/v2/channels/YOURNAME` in a browser, copy the
  `chatroom` `id` number, and paste it under Advanced Kick settings.
- YouTube has no VIP role, so only the owner and moderators can mark words there. On YouTube the streamer is recognised only by
  YouTube's owner badge, never by name, because YouTube display names can be copied by anyone. Rumble support is experimental.
- Weekly leaderboard resets on the day and hour set on the admin page, using the server's clock.

Run `node test/run.js` to check the game rules and the website API.
