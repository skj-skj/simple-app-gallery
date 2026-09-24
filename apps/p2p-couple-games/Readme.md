# Couple Games

A tiny serverless, peer-to-peer game hub for two people. One person creates
a room, sends the link to the other, and they play directly over WebRTC
(via [PeerJS](https://peerjs.com/)) — no backend, no game server, just the
two browsers talking to each other.

## How it works

- **Room = a short code.** The host's PeerJS peer ID is `pcg-<CODE>`. The
  guest generates a random peer ID and connects directly to `pcg-<CODE>`.
- **One data connection, two message "scopes".** Every message sent over
  the WebRTC data channel looks like `{ scope: 'core' | 'game', ... }`.
  - `core` messages are handled by `app.js` itself: handshake (`HELLO`),
    which game is active (`SELECT_GAME` / `LEAVE_GAME`), and a lightweight
    ping/pong for the latency readout in the status bar.
  - `game` messages are stamped with the active `gameId` and forwarded
    straight to whichever game module is mounted.
- **Games are self-contained.** Each game is one HTML fragment (markup +
  scoped `<style>`) and one JS file that registers itself on
  `window.GameModules`. `app.js` fetches the fragment into `#game-root`,
  lazy-loads the script once, then calls `init(api)`.
- Because it's a plain WebRTC data channel (not polling a server), latency
  is just your direct peer-to-peer round trip — normally tens of
  milliseconds.

## Files

```
index.html            structure + all shared styles (lobby, waiting room,
                       game grid, game screen, status bar)
app.js                 PeerJS setup, reconnection, message bus, game loader
games/tictactoe.html   Tic Tac Toe markup
games/tictactoe.js     Tic Tac Toe logic
games/rps.html         Rock Paper Scissors markup
games/rps.js           Rock Paper Scissors logic
```

## Adding a new game

1. Create `games/<id>.html` — just markup plus a `<style>` block scoped
   with a unique class prefix (e.g. `.scribble-*`) so it can't clash with
   other games' styles.
2. Create `games/<id>.js` implementing the contract:

   ```js
   (function () {
     const MyGame = {
       init(api) {
         // api.root         — container element, your HTML is already inside it
         // api.isHost       — true for whoever created the room
         // api.myNickname / api.peerNickname
         // api.send(payload)     — send any JSON-serialisable data to the peer
         // api.onMessage(fn)     — fn(payload) on incoming data; returns an
         //                         unsubscribe function
       },
       destroy() {
         // optional: clear timers/intervals, etc. Message listeners are
         // unsubscribed automatically by app.js, you don't need to do that.
       },
     };
     window.GameModules = window.GameModules || {};
     window.GameModules['<id>'] = MyGame;
   })();
   ```

3. Add one line to the `GAMES` array at the top of `app.js`:

   ```js
   { id: '<id>', name: 'Display Name', icon: '🎲', html: 'games/<id>.html', js: 'games/<id>.js' },
   ```

That's the whole integration surface — the grid, loading, and message
routing all pick up the new entry automatically.

### Design notes for games with real-time/continuous input (e.g. a Scribble
or a "Keep Talking"-style timer game)

- For turn-based games, `api.send`/`api.onMessage` as-is (reliable, ordered)
  is fine.
- For something continuous like a drawing canvas, you may want to throttle
  `api.send` calls (e.g. send a point every ~30ms instead of on every
  `mousemove`) rather than adding a new transport — PeerJS's default
  reliable/ordered channel is already low latency for this scale of data.
- For a countdown/timer game, keep the timer's *start timestamp* in the
  synced state (send it once) and have each side compute remaining time
  locally from `Date.now() - startedAt`, rather than ticking down
  independently — that avoids the two clocks drifting apart.

## Known limitations (kept simple on purpose)

- If the connection drops mid-game, the guest auto-retries connecting for
  about 20 seconds; if it succeeds, the current game is **not** resumed
  mid-state — it's simplest to just re-pick it from the grid. Adding full
  state resync is possible but wasn't worth the complexity for a casual
  couple's game.
- Rock Paper Scissors has no commit/reveal handshake, so it isn't
  cheat-proof against someone deliberately stalling to see your move first.
  See the comment in `games/rps.js` if you ever want to harden that.
- PeerJS's public signalling/STUN server is used (no config needed to run
  it), which is fine for personal use but can occasionally be slow to
  broker the initial connection.

## Testing locally

Any static file server works, e.g.:

```bash
cd apps/p2p-couple-games
python3 -m http.server 8080
```

Open `http://localhost:8080` in two different browsers/tabs (or one tab
+ your phone) to test both roles.
