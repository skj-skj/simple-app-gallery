# Couple Games

A tiny serverless, peer-to-peer game hub for two people. One person creates
a room, sends the link to the other, and they play directly over WebRTC
(via [PeerJS](https://peerjs.com/)) — no backend, no game server, no build
step, just the two browsers talking to each other.

## Games

| Game | Type | Notes |
| --- | --- | --- |
| ❌⭕ Tic Tac Toe | Turn-based | Host is X, guest is O; starting player alternates each rematch. |
| ✊✋✌️ Rock Paper Scissors | Simultaneous pick | Trust-based, see [Known limitations](#known-limitations). |
| 🖌️ Scribble 2 | Draw & guess | Host picks round time (30–120 s), rounds each (3–10) and word categories or a custom list. Players take turns drawing; the drawer picks from 3 words. |
| 🚢 Battleship | Turn-based | Classic 10×10 grid and 5-ship fleet; turns alternate every shot (no extra shot on a hit). |
| 🔲 Dots and Boxes | Turn-based | Host picks the board size (3×3 to 10×10); completing a box gives you another turn. |
| 🔦 Laser Link | Co-op puzzle | Each player controls half the mirrors on a shared grid and only sees their own, so you have to talk it through to guide the beam to the target. |
| 🏢 Building Fall | Simultaneous, timed | 3D trust-or-betray game. Each floor has 3 openings; you can't see which of yours are on fire, but you can see your partner's. Either player sets floors (3–20), timer (10/30/60/90 s) and difficulty (Easy: 2 safe + 1 fire, Hard: 1 safe + 2 fire). Every jump drops a floor: safe +10, fire −5 (your character darkens a little per fire). Both play to the ground; highest score wins. |
| 🎬 Bollywood | Take turns, guess the title | Hangman meets Wordle. One player types a movie or series name, the other guesses letters on an on-screen keyboard. Each miss crosses out one letter of BOLLYWOOD (9 lives). Host picks 5, 10 or 15 rounds. |

## How it works

- **Room = a short code.** Creating a room generates a 5-character code
  (ambiguous characters like `0/O` and `1/I` are left out). The host's
  PeerJS peer ID is `pcg-<CODE>`; the guest gets a random peer ID and
  connects directly to `pcg-<CODE>`.
- **Share link.** The room lives in the URL as `?room=<CODE>`. Opening that
  link joins as the guest. The host's browser remembers the room it created
  (in `localStorage`), so if the **host** reloads the page it re-opens the
  same room instead of trying to join it.
- **Nicknames** are optional and saved in `localStorage` for next time.
- **One data connection, two message "scopes".** Every message sent over
  the WebRTC data channel looks like `{ scope: 'core' | 'game', ... }`.
  - `core` messages are handled by `app.js` itself: the nickname handshake
    (`HELLO` / `HELLO_ACK`), which game is active (`SELECT_GAME` /
    `LEAVE_GAME`), and a `PING` / `PONG` every 4 seconds for the latency
    readout in the status bar.
  - `game` messages carry the active `gameId` and are delivered only to
    the game that's currently open. Messages for any other game are
    dropped.
- **Either player can pick a game.** Picking one opens it locally and sends
  `SELECT_GAME`, so the other side opens the same game. "Back to games"
  sends `LEAVE_GAME` and takes both players back to the grid.
- **Games are self-contained.** Each game is one HTML fragment (markup +
  scoped `<style>`) and one JS file that registers itself on
  `window.GameModules`. `app.js` fetches the fragment into `#game-root`,
  loads the script the first time the game is opened, then calls
  `init(api)`.
- Because it's a direct WebRTC data channel (not polling a server), the
  latency is your peer-to-peer round trip, usually tens of milliseconds.
  The PeerJS server is only used to set up the connection.

## Files

```
index.html                           page structure + all shared styles (lobby,
                                     waiting room, game grid, game screen,
                                     status bar); loads PeerJS 1.5.4 from jsDelivr
app.js                               PeerJS setup, reconnection, message bus,
                                     game registry (GAMES) and loader
games/tictactoe.html / .js           Tic Tac Toe
games/rps.html / .js                 Rock Paper Scissors
games/scribble2.html / .js           Scribble 2 (drawing canvas, rounds, word picker)
games/battleship.html / .js          Battleship
games/dots_and_boxes.html / .js      Dots and Boxes
games/lazer_link.html / .js          Laser Link (puzzle gen, laser sim, rendering)
games/building_fall.html / .js       Building Fall (3D scene, floor timer, jump resolution)
games/bollywood.html / .js           Bollywood (title typing, letter guessing, BOLLYWOOD lives)
games/assets/scribble-word-list.json Scribble 2's categorised word list
games/assets/battleship_sounds.js    Battleship's Web Audio sound effects
games/assets/lazer_link_sounds.js    Laser Link's Web Audio sound effects
games/assets/building_fall_sounds.js Building Fall's Web Audio sound effects
```

## Running it

It's all static files, but it **must be served over HTTP(S)**. Opening
`index.html` straight from disk (`file://`) won't work, because games are
loaded with `fetch()`.

```bash
cd apps/p2p-couple-games
python3 -m http.server 8080
```

Open `http://localhost:8080` in two browser windows, or two different
browsers, to test both roles. To test with a phone, the page has to be
served over **HTTPS** (for example a deployed copy, or a tunnel like
`ngrok` / `cloudflared`). Plain `http://<your-LAN-IP>:8080` is not a secure
context, so the **Copy** link buttons won't work there.

Both devices need internet access. PeerJS itself is loaded from a CDN, and
the connection is set up through PeerJS's free public server, even when
both devices are on the same network.

## Adding a new game

1. Create `games/<id>.html` with just the markup and a `<style>` block.
   Prefix every class with something unique to your game (for example
   `.mygame-*`, like the existing `.s2-*`, `.lzl-*`), so it can't clash
   with other games' styles.
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
         // optional: clear timers/intervals, stop audio, etc. Message
         // listeners are removed automatically by app.js.
       },
     };
     window.GameModules = window.GameModules || {};
     window.GameModules['<id>'] = MyGame;
   })();
   ```

   Notes on the contract:
   - The same module object is reused every time the game is opened, so
     `init()` must fully reset its state rather than assume a fresh object.
   - `api.peerNickname` is fixed when the game is opened. If a game is
     opened in the first moments after connecting, it may still be the
     default `"Partner"`.
   - Extra assets (sounds, word lists, …) go in `games/assets/` and are
     loaded by the game itself. See `battleship.js` / `scribble2.js`.

3. Add one entry to the `GAMES` array at the top of `app.js`:

   ```js
   { id: '<id>', name: 'Display Name', icon: '🎲', html: 'games/<id>.html', js: 'games/<id>.js' },
   ```

That's the whole integration surface. The grid, loading and message routing
all pick up the new entry automatically.

### Patterns the existing games use

- **Host-authoritative setup.** When a game has options (board size, round
  time, word list) or random generation, only the host shows the setup
  screen and sends the result (for example `CONFIG`, `ROUND_START`,
  `NEW_PUZZLE`). The guest only applies it. This way the two sides can
  never disagree. Dots and Boxes, Scribble 2 and Laser Link all work this
  way. If the guest wants a new puzzle or round, it asks the host (for
  example Laser Link's `REQUEST_NEW_PUZZLE`) instead of generating its own.
- **Send actions, not state.** Turn-based games send only the move
  (`MOVE`, `CLAIM_EDGE`, `FIRE`, `MIRROR_ROTATE`). Both sides apply it with
  the same rules and work out scores, turns and the win themselves. With
  strict turn-taking over a reliable, ordered channel, both sides stay in
  sync.
- **Deterministic turn order.** Who starts is worked out from a shared
  `round` counter (the host starts on even rounds and the guest on odd
  ones), so no extra message is needed to agree on it.
- **Keep secrets local.** Battleship never sends ship positions, only shots
  and hit/miss results. Scribble 2 never sends the secret word.
- **Continuous input.** Throttle it instead of adding a new transport.
  Scribble 2 groups drawing points and sends them every 40 ms
  (`MOVE_SEND_MS`). PeerJS's default reliable, ordered channel is fast
  enough for this.
- **Timers.** Send the start timestamp once and have each side compute the
  remaining time locally from `Date.now() - startedAt`, rather than both
  sides ticking down on their own and drifting apart.

### Laser Link puzzle generation

`generatePuzzle()` (host only) builds each puzzle solution-first. It walks
out a valid source → target laser path, places mirrors only where that path
turns, then scatters decoy mirrors, walls and splitters on the remaining
cells. It then runs the real `traceLaser()` check to confirm the intended
solution works and that the scrambled starting board isn't already solved.
It retries up to 80 times and falls back to a trivial puzzle, so it can
never get stuck. The beam itself is never sent over the network: both sides
run the same simulation on the same synced mirror state.

"Give Up" needs both players. Each side tracks its own give-up locally, and
the solution is shown only once both have pressed it, so one partner giving
up doesn't spoil the puzzle for the other.

### Building Fall

Each player stands on top of their own building (yours is always drawn on
the left). Every floor has three openings, **LEFT / CENTER / RIGHT**. You
can't see which of *your* openings are on fire, but you can see your
partner's, so the only way to know is to ask. Your partner can tell you
the truth or lie.

- **Settings (either player):** floors (3–20, default 10), floor timer
  (`TIMER_OPTIONS = [10, 30, 60, 90]`) and difficulty (`DIFFICULTIES`:
  **Easy** has 2 safe openings and 1 fire per floor, **Hard** has 1 safe
  and 2 fire). Both players can change them at the same time and each
  change shows up on both screens. Every `CONFIG` carries a revision
  number: the newer change wins, and if both change something at the same
  instant the host's change wins, so the screens can never disagree.
  Either player can press **Start**; it unlocks once both have opened the
  game and loaded the 3D engine. When the guest presses it, it sends
  `START_REQUEST` and the host starts the game (only if both have the
  same settings revision).
- **Choosing:** tap LEFT / CENTER / RIGHT as often as you like, or drag
  on the scene to move between openings. Your character moves on **both**
  screens as you do, so your partner can guide you ("left… a bit more…
  stop!"). When the timer hits 0, the opening nearest to where you are
  standing is used, so standing between two openings still picks one.
- **Scoring:** every jump drops you one floor. Safe jump **+10**, fire
  jump **−5**. Fire never takes you out of the game: the character bursts
  into flames for a moment and stays a little darker. The darkness is
  `fires / floors`, so a player who hit fire on every floor ends up
  darkest. Both players always play all the way to the ground; the higher
  score wins, with a draw on equal scores.
- **Names:** the game always says "You" and "Partner", on both screens.
- **Rematch:** *Play Again* (either player) keeps the settings and rolls
  new buildings. *Configuration* (either player) takes both back to the settings.

**Sync.** Once a game starts, the host is authoritative. It rolls both layouts, starts each
floor, collects the two final choices and resolves them. Messages:
`HELLO`, `CONFIG`, `START_REQUEST`, `GAME_STARTED`, `FLOOR_STARTED`, `POS`, `CHOICE`,
`FLOOR_RESOLVED` (per-player outcome with `PLAYER_JUMPED`, `PLAYER_SAFE` /
`PLAYER_FIRE`, `PLAYER_REACHED_BOTTOM`),
`GAME_FINISHED`, `REMATCH_REQUEST`, `BACK_TO_CONFIG` and
`TIME_REQ` / `TIME_RES`. The 3D scene is never synced; each side animates
the events itself.

- **Secrets:** the guest receives the host's layout, which it is meant to
  see, but not its own. Each of its floors is revealed in
  `FLOOR_RESOLVED` after the jump, and the full layout comes with
  `GAME_FINISHED`.
- **Live position:** while the timer runs, each side sends `POS` (its
  character's x position) whenever it changes, throttled to one message
  every 80 ms plus a final one. This is a position, not frame-by-frame
  sync, and it only drives the partner's character on screen. The pick
  that counts is still the `CHOICE` the guest sends when its timer ends,
  and the host works out the result.
- **Timer:** `FLOOR_STARTED` carries the deadline in host time. The guest
  converts it using a clock offset measured with a few `TIME_REQ` /
  `TIME_RES` round trips, so the countdowns end together even when the
  phones' clocks disagree. If the guest's `CHOICE` hasn't arrived 4 s after
  the deadline, the host uses the opening nearest the guest's last `POS`.
- **Duplicates / delays:** every message carries `gameNo` (and `round`).
  Stale or repeated ones are ignored. Scores come from the host's snapshot
  as absolute values, so a repeated message can't award points twice. If
  either player re-opens the game mid-match, both go back to the settings.

**Libraries.** Three.js 0.186.1 renders the 3D scene. KAPLAY 3001.0.19
drives the frame loop and a transparent 2D overlay for the floating
+10 / −5 text, sparks and confetti. Both are loaded from jsDelivr with
`import()` the first time the game opens, with no build step. If KAPLAY
fails to load, a plain `requestAnimationFrame` loop is used without the
overlay. KAPLAY's own AudioContext is kept suspended, because all sound
comes from `building_fall_sounds.js`.

**Sound.** `games/assets/building_fall_sounds.js` synthesises every sound
with Web Audio, with no audio files. The sounds are short and quiet
because players are usually on a voice call. The context is unlocked on
the first tap and suspended after a few idle seconds or when the tab is
hidden. There's a 🔊/🔇 toggle in the HUD, saved in `localStorage`.

### Bollywood

Each round, one player is the **setter** and the other the **guesser**.
Who sets is worked out from `(round + session) % 2`, so setters alternate
every round and the first setter alternates every session.

- **Setup (host):** rounds per session (`ROUND_OPTIONS = [5, 10, 15]`,
  default 5). The guest's *Play Again* asks the host to start a new
  session. *Change rounds* (either player) takes both back to setup.
- **Typing:** the setter types the title on the on-screen keyboard (A–Z,
  0–9, space; up to 40 characters). Neither player needs the phone's
  keyboard. Extra spaces are collapsed when it is submitted.
- **Guessing:** the guesser sees one dash per character, grouped by word,
  under the letters B-O-L-L-Y-W-O-O-D. A hit reveals every copy of that
  letter and turns the key green. A miss grays out the key and crosses
  out the next BOLLYWOOD letter with a `/`, writing the missed letter
  under it. Reveal the whole title to win the round; if all 9 are
  crossed out, the setter wins. The setter watches the same board, with
  the letters that haven't been guessed yet shown faintly.
- **Scoring:** 1 point per round won; most points after the last round
  wins the session, with a draw on equal points.

**Sync.** The title stays on the setter's device until the round ends.
Messages: `HELLO`, `CONFIG`, `AGAIN_REQUEST`, `SETTINGS`, `TITLE_SET`
(only the shape, e.g. `"_ ______"`), `GUESS`, `RESULT` (the positions
hit, plus the outcome and full title once the round is over) and `NEXT`.
The setter is the authority for its own round: it resolves each `GUESS`
and both sides apply the `RESULT`. Every message carries `session` and
`round`, and stale ones are dropped. If either player re-opens the game,
`HELLO` sends both back to setup.

## Known limitations

Most of these are kept simple on purpose for a casual game between two
people who trust each other.

- **Reconnection is basic.** If the connection drops, the guest retries
  automatically 8 times, 2.5 s apart (about 20 s). After that the page
  shows an error and you'll need to rejoin. After a successful reconnect,
  both sides land back on the game grid, and the game you were in is
  **not** restored. Just pick it again. The host doesn't retry anything;
  it just keeps the room open for the guest to come back.
- **Rooms aren't locked to two people.** The host accepts any incoming
  connection, so anyone with the code or link can connect, and the newest
  connection takes over. Share the link only with the person you're
  playing with.
- **No TURN server.** Only PeerJS's default public signalling server and
  STUN are used, with no TURN relay. That's fine on most home Wi-Fi and
  mobile networks, but on strict corporate, school or some carrier (CGNAT)
  networks, the connection may never be set up. The public server can also
  sometimes be slow to broker the first connection.
- **Picking a game at the same moment.** If both players tap a different
  game at the same instant, each side can end up in the other's pick.
  Going back to the grid and picking again fixes it.
- **Building Fall in the background.** If a player switches apps (for
  example to the call app) the browser may pause timers or drop the
  connection, especially on iOS. The host still resolves each floor at
  most 4 s after the deadline, but keep the game in the foreground while
  playing. The host's browser also holds both layouts, so a host with dev
  tools could peek at their own fire.
- **Not cheat-proof.** Rock Paper Scissors has no commit/reveal step, so
  someone who deliberately waits could see your move first (see the
  comment in `games/rps.js` for how to harden it). Battleship trusts each
  player to report hits on their own board honestly.
  