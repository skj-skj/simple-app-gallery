/* =========================================================================
   Couple Games — core app
   -------------------------------------------------------------------------
   This file owns:
     1. The PeerJS room / connection lifecycle (create, join, reconnect).
     2. A tiny message bus over the single WebRTC data connection, split
        into "core" messages (handled here) and "game" messages (forwarded
        to whichever game is currently mounted).
     3. Dynamically loading a game's HTML fragment + JS module and handing
        it a small API object to talk to the peer.

   HOW TO ADD A NEW GAME
   -------------------------------------------------------------------------
   1. Create games/<id>.html  — just the markup + a scoped <style> block.
   2. Create games/<id>.js    — see games/tictactoe.js for the contract:
        window.GameModules['<id>'] = {
          init(api)  { ... },   // called once, api described below
          destroy()  { ... }    // optional cleanup (timers, etc.)
        };
      api = {
        root,                  // container element with your HTML already in it
        send(payload),         // send any JSON-serialisable payload to peer
        onMessage(fn),         // fn(payload) fires on incoming messages; call
                                // the returned function to unsubscribe
        isHost,                // true for whoever created the room
        myNickname, peerNickname
      }
   3. Add one line to the GAMES array below. That's it — the grid, loading,
      and message routing all pick it up automatically.
   ========================================================================= */

(function () {
  'use strict';

  // ---- Extension point: register games here -----------------------------
  const GAMES = [
    {
      id: 'tictactoe',
      name: 'Tic Tac Toe',
      icon: '❌⭕',
      html: 'games/tictactoe.html',
      js: 'games/tictactoe.js'
    },
    {
      id: 'rps',
      name: 'Rock Paper Scissors',
      icon: '✊✋✌️',
      html: 'games/rps.html',
      js: 'games/rps.js'
    },
    { 
      id: 'scribble2',
      name: 'Scribble 2',
      icon: '🖌️',
      html: 'games/scribble2.html',
      js: 'games/scribble2.js'
    },
  ];
  
  const ROOM_PREFIX = 'pcg-';
  const PING_INTERVAL_MS = 4000;
  const GUEST_RECONNECT_ATTEMPTS = 8;
  const GUEST_RECONNECT_DELAY_MS = 2500;

  // ---- DOM refs -----------------------------------------------------------
  const statusBar = document.getElementById('status-bar');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const pingText = document.getElementById('ping-text');
  const copyLinkBtn = document.getElementById('copy-link-btn');
  const leaveRoomBtn = document.getElementById('leave-room-btn');

  const nicknameInput = document.getElementById('nickname-input');
  const createRoomBtn = document.getElementById('create-room-btn');
  const joinCodeInput = document.getElementById('join-code-input');
  const joinRoomBtn = document.getElementById('join-room-btn');
  const lobbyError = document.getElementById('lobby-error');

  const waitingTitle = document.getElementById('waiting-title');
  const waitingShare = document.getElementById('waiting-share');
  const shareLinkInput = document.getElementById('share-link-input');
  const shareCopyBtn = document.getElementById('share-copy-btn');
  const roomCodeDisplay = document.getElementById('room-code-display');
  const waitingMsg = document.getElementById('waiting-msg');
  const waitingError = document.getElementById('waiting-error');

  const gameGrid = document.getElementById('game-grid');
  const gameTitle = document.getElementById('game-title');
  const gameRoot = document.getElementById('game-root');
  const backToGamesBtn = document.getElementById('back-to-games-btn');

  // ---- State ---------------------------------------------------------------
  let peer = null;
  let conn = null;
  let isHost = false;
  let roomCode = null;
  let myNickname = '';
  let peerNickname = 'Partner';
  let connected = false;
  let guestReconnectTries = 0;
  let pingTimer = null;
  let lastPingSentAt = 0;

  let currentGameId = null;
  let gameMessageHandlers = [];   // subscribers for the active game
  let loadedScripts = new Set();  // avoid re-injecting the same <script>

  // ---- Small utilities -------------------------------------------------

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    statusBar.classList.toggle('hidden', id === 'screen-lobby');
  }

  function showLobbyError(msg) {
    lobbyError.textContent = msg;
    lobbyError.classList.remove('hidden');
  }

  function generateRoomCode(len = 5) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skip ambiguous chars
    let code = '';
    for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function roomLink(code) {
    return `${location.origin}${location.pathname}?room=${code}`;
  }

  function setStatus(state, text) {
    statusDot.className = 'dot' + (state ? ' ' + state : '');
    statusText.textContent = text;
  }

  // ---- Peer / connection lifecycle --------------------------------------

  function createRoom(existingCode) {
    isHost = true;
    roomCode = existingCode || generateRoomCode();
    myNickname = nicknameInput.value.trim() || myNickname;
    localStorage.setItem('pcg_nickname', myNickname);

    showScreen('screen-waiting');
    waitingTitle.textContent = 'Creating your room…';
    setStatus('', 'Setting up…');

    peer = new Peer(ROOM_PREFIX + roomCode);

    peer.on('open', () => {
      localStorage.setItem('pcg_host_room', roomCode);
      history.replaceState({}, '', `?room=${roomCode}`);

      waitingTitle.textContent = 'Room created!';
      shareLinkInput.value = roomLink(roomCode);
      roomCodeDisplay.textContent = roomCode;
      waitingShare.classList.remove('hidden');
      waitingMsg.textContent = '⏳ Waiting for your partner to join…';
      setStatus('', 'Waiting for partner…');
    });

    peer.on('connection', (c) => {
      conn = c;
      wireConnection();
    });

    peer.on('disconnected', () => {
      setStatus('disconnected', 'Reconnecting to server…');
      peer.reconnect();
    });

    peer.on('error', handlePeerError);
  }

  function joinRoom(code) {
    isHost = false;
    roomCode = code.trim().toUpperCase();
    myNickname = nicknameInput.value.trim() || myNickname;
    localStorage.setItem('pcg_nickname', myNickname);

    showScreen('screen-waiting');
    waitingTitle.textContent = `Joining room ${roomCode}…`;
    waitingShare.classList.add('hidden');
    waitingMsg.textContent = '⏳ Connecting to your partner…';
    setStatus('', 'Connecting…');

    peer = new Peer();

    peer.on('open', () => {
      history.replaceState({}, '', `?room=${roomCode}`);
      connectToHost();
    });

    peer.on('disconnected', () => {
      setStatus('disconnected', 'Reconnecting to server…');
      peer.reconnect();
    });

    peer.on('error', handlePeerError);
  }

  function connectToHost() {
    conn = peer.connect(ROOM_PREFIX + roomCode, { reliable: true });
    conn.on('error', () => attemptGuestReconnect());
    wireConnection();
  }

  function attemptGuestReconnect() {
    if (isHost || connected) return;
    if (guestReconnectTries >= GUEST_RECONNECT_ATTEMPTS) {
      waitingError.textContent = "Couldn't reach the room. Check the code and try again.";
      waitingError.classList.remove('hidden');
      setStatus('disconnected', 'Connection failed');
      return;
    }
    guestReconnectTries++;
    setStatus('disconnected', `Reconnecting… (${guestReconnectTries}/${GUEST_RECONNECT_ATTEMPTS})`);
    setTimeout(() => { if (!connected) connectToHost(); }, GUEST_RECONNECT_DELAY_MS);
  }

  function wireConnection() {
    conn.on('open', () => {
      connected = true;
      guestReconnectTries = 0;
      setStatus('connected', 'Connected');
      sendCore({ type: 'HELLO', nickname: myNickname });
      showScreen('screen-games');
      startPing();
    });

    conn.on('data', handleData);

    conn.on('close', () => {
      connected = false;
      stopPing();
      if (isHost) {
        setStatus('disconnected', 'Partner disconnected');
      } else {
        setStatus('disconnected', 'Disconnected');
        attemptGuestReconnect();
      }
    });

    conn.on('error', () => {
      connected = false;
      if (!isHost) attemptGuestReconnect();
    });
  }

  function handlePeerError(err) {
    console.error('PeerJS error:', err);
    if (err.type === 'peer-unavailable') {
      waitingError.textContent = "That room doesn't exist (or your partner hasn't opened it yet).";
      waitingError.classList.remove('hidden');
      setStatus('disconnected', 'Room not found');
    } else if (err.type === 'unavailable-id') {
      // Room code collision on create — extremely rare, just retry with a new code.
      createRoom();
    } else {
      showLobbyError('Connection error: ' + err.type);
    }
  }

  function leaveRoom() {
    stopPing();
    if (conn) { try { conn.close(); } catch (e) {} }
    if (peer) { try { peer.destroy(); } catch (e) {} }
    conn = null; peer = null; connected = false;
    isHost = false; roomCode = null; currentGameId = null;
    gameMessageHandlers = [];
    localStorage.removeItem('pcg_host_room');
    history.replaceState({}, '', location.pathname);
    lobbyError.classList.add('hidden');
    waitingError.classList.add('hidden');
    showScreen('screen-lobby');
  }

  // ---- Ping / latency ----------------------------------------------------

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (!connected) return;
      lastPingSentAt = Date.now();
      sendCore({ type: 'PING', ts: lastPingSentAt });
    }, PING_INTERVAL_MS);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    pingText.textContent = '';
  }

  // ---- Messaging -----------------------------------------------------------

  function sendCore(payload) {
    if (conn && conn.open) conn.send({ scope: 'core', ...payload });
  }

  function sendGame(gameId, payload) {
    if (conn && conn.open) conn.send({ scope: 'game', gameId, payload });
  }

  function handleData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.scope === 'core') {
      handleCoreMessage(msg);
    } else if (msg.scope === 'game' && msg.gameId === currentGameId) {
      gameMessageHandlers.forEach(fn => { try { fn(msg.payload); } catch (e) { console.error(e); } });
    }
  }

  function handleCoreMessage(msg) {
    switch (msg.type) {
      case 'HELLO':
        peerNickname = msg.nickname || 'Partner';
        sendCore({ type: 'HELLO_ACK', nickname: myNickname });
        break;
      case 'HELLO_ACK':
        peerNickname = msg.nickname || 'Partner';
        break;
      case 'SELECT_GAME':
        loadGame(msg.gameId, { announce: false });
        break;
      case 'LEAVE_GAME':
        currentGameId = null;
        showScreen('screen-games');
        break;
      case 'PING':
        sendCore({ type: 'PONG', ts: msg.ts });
        break;
      case 'PONG':
        pingText.textContent = `· ${Date.now() - msg.ts}ms`;
        break;
    }
  }

  // ---- Game loading -------------------------------------------------------

  function renderGameGrid() {
    gameGrid.innerHTML = '';
    GAMES.forEach(g => {
      const card = document.createElement('div');
      card.className = 'game-card';
      card.innerHTML = `<span class="icon">${g.icon}</span><span class="name">${g.name}</span>`;
      card.addEventListener('click', () => loadGame(g.id, { announce: true }));
      gameGrid.appendChild(card);
    });
  }

  function ensureScriptLoaded(src) {
    if (loadedScripts.has(src)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => { loadedScripts.add(src); resolve(); };
      script.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(script);
    });
  }

  function buildGameApi(gameId) {
    return {
      root: gameRoot,
      isHost,
      myNickname,
      peerNickname,
      send(payload) { sendGame(gameId, payload); },
      onMessage(fn) {
        gameMessageHandlers.push(fn);
        return () => { gameMessageHandlers = gameMessageHandlers.filter(f => f !== fn); };
      },
    };
  }

  async function loadGame(gameId, { announce }) {
    const game = GAMES.find(g => g.id === gameId);
    if (!game) return;

    // Clean up whatever game is currently mounted.
    if (currentGameId && window.GameModules && window.GameModules[currentGameId]) {
      const prev = window.GameModules[currentGameId];
      if (typeof prev.destroy === 'function') { try { prev.destroy(); } catch (e) {} }
    }
    gameMessageHandlers = [];
    currentGameId = gameId;

    showScreen('screen-game');
    gameTitle.textContent = game.name;
    gameRoot.innerHTML = '<p class="loading">Loading…</p>';

    try {
      const html = await fetch(game.html).then(r => r.text());
      gameRoot.innerHTML = html;
      await ensureScriptLoaded(game.js);
      const mod = window.GameModules && window.GameModules[gameId];
      if (!mod || typeof mod.init !== 'function') {
        throw new Error(`Game module "${gameId}" did not register correctly`);
      }
      mod.init(buildGameApi(gameId));
      if (announce) sendCore({ type: 'SELECT_GAME', gameId });
    } catch (err) {
      console.error(err);
      gameRoot.innerHTML = `<p class="loading">Couldn't load this game. ${err.message}</p>`;
    }
  }

  function backToGames() {
    if (currentGameId && window.GameModules && window.GameModules[currentGameId]) {
      const mod = window.GameModules[currentGameId];
      if (typeof mod.destroy === 'function') { try { mod.destroy(); } catch (e) {} }
    }
    gameMessageHandlers = [];
    currentGameId = null;
    sendCore({ type: 'LEAVE_GAME' });
    showScreen('screen-games');
  }

  // ---- Bootstrap ------------------------------------------------------------

  function init() {
    renderGameGrid();

    myNickname = localStorage.getItem('pcg_nickname') || '';
    nicknameInput.value = myNickname;

    createRoomBtn.addEventListener('click', () => createRoom());
    joinRoomBtn.addEventListener('click', () => {
      const code = joinCodeInput.value.trim();
      if (!code) { showLobbyError('Enter a room code to join.'); return; }
      lobbyError.classList.add('hidden');
      joinRoom(code);
    });

    shareCopyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(shareLinkInput.value);
      shareCopyBtn.textContent = 'Copied!';
      setTimeout(() => (shareCopyBtn.textContent = 'Copy'), 1500);
    });
    copyLinkBtn.addEventListener('click', () => {
      if (!roomCode) return;
      navigator.clipboard?.writeText(roomLink(roomCode));
      copyLinkBtn.textContent = '✅';
      setTimeout(() => (copyLinkBtn.textContent = '🔗 Link'), 1500);
    });
    leaveRoomBtn.addEventListener('click', () => {
      if (confirm('Leave this room?')) leaveRoom();
    });
    backToGamesBtn.addEventListener('click', backToGames);

    // Resolve room from URL: resume as host, or join as guest.
    const params = new URLSearchParams(location.search);
    const urlRoom = (params.get('room') || '').toUpperCase();
    if (urlRoom) {
      joinCodeInput.value = urlRoom;
      if (localStorage.getItem('pcg_host_room') === urlRoom) {
        createRoom(urlRoom);
      } else {
        joinRoom(urlRoom);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
