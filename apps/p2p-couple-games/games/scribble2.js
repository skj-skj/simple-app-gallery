(function () {
  'use strict';

  /*
   * Scribble 2 — a from-scratch rewrite of the old Scribble game.
   *
   * Why a rewrite instead of a patch: the old game had the round-host
   * job split across both peers — whenever a message with `round > 0`
   * was handled, the code re-broadcast ROUND_START regardless of who
   * received it. That caused host <-> guest to bounce ROUND_START back
   * and forth forever from round 1 onward, re-rolling the secret word
   * on every bounce (looked like "all the words flashing in a loop")
   * and repeatedly wiping the canvas ("can't draw"). Here, only the
   * room host (api.isHost) ever originates ROUND_START — everyone else
   * only *applies* it. Same idea for CONFIG.
   *
   * The secret word itself is still never sent over the wire — only the
   * drawer ever knows it, exactly like before.
   *
   * Canvas: instead of resizing the backing buffer on every layout
   * change (which cleared the drawing and was a second source of
   * "can't draw" glitches), the canvas has one fixed logical
   * resolution (LOGICAL_W x LOGICAL_H) set once. CSS scales the
   * element to fit the container; the browser stretches the bitmap for
   * free, so nothing needs to be redrawn on resize.
   */

  const DEFAULT_WORDS = [
    'apple', 'balloon', 'banana', 'bicycle', 'camera', 'car', 'cat', 'chair',
    'clock', 'cloud', 'coffee', 'crown', 'dog', 'elephant', 'fish', 'flower',
    'guitar', 'house', 'ice cream', 'key', 'kite', 'lamp', 'lion', 'moon',
    'mountain', 'pizza', 'rainbow', 'robot', 'rocket', 'shoe', 'smile',
    'star', 'sun', 'tree', 'umbrella', 'watermelon',
  ];

  const SWATCHES = ['#222222', '#ffffff', '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6'];

  const LOGICAL_W = 800;
  const LOGICAL_H = 600;
  const MOVE_SEND_MS = 40;     // throttle for outgoing drawing points
  const NEXT_ROUND_DELAY_MS = 2200;
  const MIN_CUSTOM_WORDS = 4;
  const FILL_TOLERANCE = 48;

  const Scribble2 = {
    init(api) {
      this.api = api;

      this.round = -1;
      this.roundTime = 60;
      this.words = DEFAULT_WORDS;
      this.secretWord = null;
      this.roundActive = false;
      this.startedAt = 0;
      this.timerHandle = null;
      this.score = { me: 0, opp: 0 };

      this.tool = 'draw';
      this.color = '#222222';
      this.size = 6;
      this.drawing = false;
      this.myStroke = null;
      this.remoteStroke = null;
      this.pendingPoints = [];
      this.lastSentAt = 0;

      this.cacheDom();
      this.initCanvas();
      this.buildSwatches();
      this.setColor(this.colorInput.value);
      this.setSize(this.sizeInput.value);
      this.setTool('draw');
      this.setToolbarEnabled(false);
      this.setGuessEnabled(false);
      this.bindEvents();

      this.unsub = api.onMessage((msg) => this.handleMessage(msg));

      if (api.isHost) {
        this.setupEl.classList.remove('scr2-hidden');
      } else {
        this.waitingNameEl.textContent = api.peerNickname || 'your partner';
        this.waitingEl.classList.remove('scr2-hidden');
      }
    },

    cacheDom() {
      const $ = (sel) => this.api.root.querySelector(sel);

      this.setupEl = $('#s2-setup');
      this.waitingEl = $('#s2-waiting');
      this.waitingNameEl = $('#s2-waiting-name');
      this.timeSelect = $('#s2-time');
      this.wordsInput = $('#s2-words');
      this.startBtn = $('#s2-start-btn');

      this.gameEl = $('#s2-game');
      this.statusEl = $('#s2-status');
      this.timerEl = $('#s2-timer');
      this.wordEl = $('#s2-word');

      this.canvas = $('#s2-canvas');

      this.toolbarEl = $('#s2-toolbar');
      this.toolDrawBtn = $('#s2-tool-draw');
      this.toolEraseBtn = $('#s2-tool-erase');
      this.toolFillBtn = $('#s2-tool-fill');
      this.swatchesEl = $('#s2-swatches');
      this.colorInput = $('#s2-color');
      this.sizeInput = $('#s2-size');
      this.sizePreview = $('#s2-size-preview');
      this.clearBtn = $('#s2-clear-btn');

      this.guessAreaEl = $('#s2-guess-area');
      this.guessInput = $('#s2-guess-input');
      this.guessBtn = $('#s2-guess-btn');

      this.feedEl = $('#s2-feed');
      this.scoreEl = $('#s2-score');
    },

    bindEvents() {
      this.startBtn.addEventListener('click', () => this.startGame());

      this.toolDrawBtn.addEventListener('click', () => this.setTool('draw'));
      this.toolEraseBtn.addEventListener('click', () => this.setTool('erase'));
      this.toolFillBtn.addEventListener('click', () => this.setTool('fill'));

      this.colorInput.addEventListener('input', () => this.setColor(this.colorInput.value));
      this.sizeInput.addEventListener('input', () => this.setSize(this.sizeInput.value));

      this.clearBtn.addEventListener('click', () => {
        if (!this.canDraw()) return;
        this.clearCanvas();
        this.api.send({ type: 'CLEAR' });
      });

      this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
      const stop = () => this.onPointerUp();
      this.canvas.addEventListener('pointerup', stop);
      this.canvas.addEventListener('pointercancel', stop);
      this.canvas.addEventListener('pointerleave', stop);

      this.guessBtn.addEventListener('click', () => this.submitGuess());
      this.guessInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.submitGuess(); }
      });
    },

    // ---------------------------------------------------------------
    // Setup / config — only the room host ever originates CONFIG.
    // ---------------------------------------------------------------

    parseCustomWords(raw) {
      const seen = new Set();
      const list = [];
      raw.split(/[,\n]/).forEach((w) => {
        const trimmed = w.trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        list.push(trimmed);
      });
      return list;
    },

    startGame() {
      const time = parseInt(this.timeSelect.value, 10) || 60;
      const custom = this.parseCustomWords(this.wordsInput.value);
      const words = custom.length >= MIN_CUSTOM_WORDS ? custom : DEFAULT_WORDS;

      this.roundTime = time;
      this.words = words;

      this.setupEl.classList.add('scr2-hidden');
      this.gameEl.classList.remove('scr2-hidden');

      this.api.send({ type: 'CONFIG', roundTime: time, words });
      this.beginRound(0);
    },

    applyConfig(msg) {
      this.roundTime = msg.roundTime || 60;
      this.words = Array.isArray(msg.words) && msg.words.length ? msg.words : DEFAULT_WORDS;

      this.waitingEl.classList.add('scr2-hidden');
      this.setupEl.classList.add('scr2-hidden');
      this.gameEl.classList.remove('scr2-hidden');
    },

    // ---------------------------------------------------------------
    // Round flow — beginRound() is host-only and sends; applyRoundStart()
    // is what both sides use to actually enter the round.
    // ---------------------------------------------------------------

    isMyDrawingTurn() {
      const hostDraws = this.round % 2 === 0;
      return this.api.isHost === hostDraws;
    },

    canDraw() { return this.roundActive && this.isMyDrawingTurn(); },
    canGuess() { return this.roundActive && !this.isMyDrawingTurn(); },

    beginRound(round) {
      const startedAt = Date.now();
      this.applyRoundStart({ round, startedAt });
      this.api.send({ type: 'ROUND_START', round, startedAt });
    },

    applyRoundStart(msg) {
      this.round = msg.round;
      this.roundActive = true;
      this.startedAt = msg.startedAt;
      this.secretWord = null;

      this.setTool('draw');
      this.clearCanvas();
      this.clearFeed();

      if (this.isMyDrawingTurn()) {
        this.secretWord = this.words[Math.floor(Math.random() * this.words.length)];
        this.statusEl.textContent = 'Your turn — draw this! ✏️';
        this.wordEl.textContent = this.secretWord;
        this.wordEl.classList.remove('masked');
        this.setToolbarEnabled(true);
        this.setGuessEnabled(false);
      } else {
        this.statusEl.textContent = `${this.api.peerNickname || 'Partner'} is drawing…`;
        this.wordEl.textContent = 'Guess what they are drawing!';
        this.wordEl.classList.add('masked');
        this.setToolbarEnabled(false);
        this.setGuessEnabled(true);
      }

      this.startTimer();
    },

    startTimer() {
      this.stopTimer();
      const tick = () => {
        if (!this.roundActive) return;
        const remaining = Math.max(0, this.roundTime - Math.floor((Date.now() - this.startedAt) / 1000));
        this.timerEl.textContent = remaining;
        this.timerEl.classList.toggle('low', remaining <= 10);
        if (remaining <= 0) { this.handleTimeout(); return; }
        this.timerHandle = setTimeout(tick, 250);
      };
      tick();
    },

    stopTimer() {
      if (this.timerHandle) clearTimeout(this.timerHandle);
      this.timerHandle = null;
    },

    handleTimeout() {
      if (!this.roundActive) return;
      this.roundActive = false;
      this.stopTimer();
      this.setToolbarEnabled(false);
      this.setGuessEnabled(false);

      if (this.isMyDrawingTurn()) {
        this.statusEl.textContent = `Time's up! The word was "${this.secretWord}".`;
        this.addFeed(`⏰ Time's up — the word was "${this.secretWord}"`, 'system');
        this.api.send({ type: 'REVEAL', word: this.secretWord });
        this.scheduleNextRound();
      } else {
        this.statusEl.textContent = "Time's up!";
      }
    },

    scheduleNextRound() {
      if (!this.api.isHost) return;
      const next = this.round + 1;
      setTimeout(() => this.beginRound(next), NEXT_ROUND_DELAY_MS);
    },

    // ---------------------------------------------------------------
    // Guessing
    // ---------------------------------------------------------------

    submitGuess() {
      if (!this.canGuess()) return;
      const text = this.guessInput.value.trim();
      if (!text) return;
      this.guessInput.value = '';
      this.api.send({ type: 'GUESS', text });
      this.addFeed(`You: ${text}`, 'me');
    },

    receiveGuess(text) {
      if (!this.isMyDrawingTurn() || !this.roundActive) return;

      const norm = this.normalize(text);
      const peerName = this.api.peerNickname || 'Partner';

      if (norm && norm === this.normalize(this.secretWord)) {
        this.roundActive = false;
        this.stopTimer();
        this.score.opp++;
        this.updateScore();

        this.statusEl.textContent = `${peerName} guessed it! 🎉`;
        this.addFeed(`🎉 ${peerName} guessed "${this.secretWord}"!`, 'correct');
        this.setToolbarEnabled(false);
        this.setGuessEnabled(false);

        this.api.send({ type: 'CORRECT', word: this.secretWord });
        this.scheduleNextRound();
      } else {
        this.addFeed(`${peerName}: ${text}`, 'peer');
      }
    },

    receiveCorrect(msg) {
      if (!this.roundActive) return;
      this.roundActive = false;
      this.stopTimer();
      this.score.me++;
      this.updateScore();

      this.statusEl.textContent = 'Correct! 🎉';
      this.addFeed(`🎉 Correct! The word was "${msg.word}"`, 'correct');
      this.setGuessEnabled(false);
    },

    receiveReveal(msg) {
      if (!this.roundActive) return;
      this.roundActive = false;
      this.stopTimer();

      this.statusEl.textContent = `Time's up! The word was "${msg.word}".`;
      this.addFeed(`⏰ Time's up — the word was "${msg.word}"`, 'system');
      this.setGuessEnabled(false);
    },

    normalize(v) {
      return String(v || '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '');
    },

    // ---------------------------------------------------------------
    // Tools
    // ---------------------------------------------------------------

    buildSwatches() {
      SWATCHES.forEach((hex) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'scr2-swatch';
        btn.style.background = hex;
        btn.dataset.color = hex;
        btn.title = hex;
        btn.addEventListener('click', () => this.setColor(hex));
        this.swatchesEl.appendChild(btn);
      });
    },

    setTool(tool) {
      this.tool = tool;
      this.toolDrawBtn.classList.toggle('active', tool === 'draw');
      this.toolEraseBtn.classList.toggle('active', tool === 'erase');
      this.toolFillBtn.classList.toggle('active', tool === 'fill');
      this.canvas.classList.remove('draw', 'erase', 'fill');
      this.canvas.classList.add(tool);
    },

    setColor(hex) {
      this.color = hex;
      this.colorInput.value = hex;
      Array.from(this.swatchesEl.children).forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.color.toLowerCase() === hex.toLowerCase());
      });
    },

    setSize(val) {
      this.size = Number(val) || 6;
      const dot = Math.max(6, Math.min(28, this.size));
      this.sizePreview.style.width = dot + 'px';
      this.sizePreview.style.height = dot + 'px';
    },

    setToolbarEnabled(enabled) {
      this.toolbarEl.classList.toggle('scr2-disabled', !enabled);
    },

    setGuessEnabled(enabled) {
      this.guessInput.disabled = !enabled;
      this.guessBtn.disabled = !enabled;
      this.guessAreaEl.classList.toggle('scr2-disabled', !enabled);
      if (enabled) setTimeout(() => this.guessInput.focus(), 50);
    },

    // ---------------------------------------------------------------
    // Canvas — fixed logical resolution, scaled by CSS. No resize
    // listener needed, so nothing ever wipes the drawing mid-round.
    // ---------------------------------------------------------------

    initCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.dpr = dpr;
      this.canvas.width = LOGICAL_W * dpr;
      this.canvas.height = LOGICAL_H * dpr;
      this.ctx = this.canvas.getContext('2d');
      this.ctx.scale(dpr, dpr);
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.paintBackground();
    },

    paintBackground() {
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.restore();
    },

    clearCanvas() {
      this.paintBackground();
    },

    getLogicalPoint(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * LOGICAL_W;
      const y = ((e.clientY - rect.top) / rect.height) * LOGICAL_H;
      return {
        x: Math.max(0, Math.min(LOGICAL_W, x)),
        y: Math.max(0, Math.min(LOGICAL_H, y)),
      };
    },

    // A stroke is drawn as a running series of quadratic curves through
    // the midpoints of consecutive points — smooth on both Chrome and
    // Safari since it only uses plain Canvas2D primitives, no per-browser
    // smoothing hints.
    beginStroke(state, point) {
      state.points = [point];
      this.drawDot(point, state.style);
    },

    extendStroke(state, point) {
      const pts = state.points;
      pts.push(point);
      const n = pts.length;
      if (n < 3) {
        this.drawSegment(pts[n - 2], pts[n - 1], state.style);
        return;
      }
      const p0 = this.midpoint(pts[n - 3], pts[n - 2]);
      const p2 = this.midpoint(pts[n - 2], pts[n - 1]);
      this.drawQuad(p0, pts[n - 2], p2, state.style);
    },

    midpoint(a, b) {
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    },

    drawDot(p, style) {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, style.size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },

    drawSegment(a, b, style) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.size;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    },

    drawQuad(p0, p1, p2, style) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.size;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
      ctx.stroke();
      ctx.restore();
    },

    // Eraser is just drawing with the canvas background color — simpler
    // and more reliable cross-browser than toggling composite operations.
    strokeStyleFor(tool, color, size) {
      return { color: tool === 'erase' ? '#ffffff' : color, size };
    },

    // ---------------------------------------------------------------
    // Pointer input (local) — only the active drawer can draw.
    // ---------------------------------------------------------------

    onPointerDown(e) {
      if (!this.canDraw()) return;

      if (this.tool === 'fill') {
        const p = this.getLogicalPoint(e);
        this.floodFill(p, this.color);
        this.api.send({ type: 'FILL', x: p.x, y: p.y, color: this.color });
        return;
      }

      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.pendingPoints = [];
      this.lastSentAt = 0;

      const p = this.getLogicalPoint(e);
      const style = this.strokeStyleFor(this.tool, this.color, this.size);
      this.myStroke = { points: [], style };
      this.beginStroke(this.myStroke, p);

      this.api.send({ type: 'STROKE_START', x: p.x, y: p.y, color: style.color, size: style.size });
    },

    onPointerMove(e) {
      if (!this.drawing || !this.canDraw()) return;
      e.preventDefault();

      const p = this.getLogicalPoint(e);
      this.extendStroke(this.myStroke, p);
      this.pendingPoints.push(p);

      const now = Date.now();
      if (now - this.lastSentAt >= MOVE_SEND_MS) {
        this.api.send({ type: 'STROKE_MOVE', points: this.pendingPoints });
        this.pendingPoints = [];
        this.lastSentAt = now;
      }
    },

    onPointerUp() {
      if (!this.drawing) return;
      this.drawing = false;
      if (this.pendingPoints.length) {
        this.api.send({ type: 'STROKE_MOVE', points: this.pendingPoints });
        this.pendingPoints = [];
      }
      this.myStroke = null;
    },

    // ---------------------------------------------------------------
    // Remote replay — reconstructs the same smoothed strokes on the
    // guesser's screen as the drawer sends them.
    // ---------------------------------------------------------------

    receiveStrokeStart(msg) {
      if (!this.roundActive) return;
      this.remoteStroke = { points: [], style: { color: msg.color, size: msg.size } };
      this.beginStroke(this.remoteStroke, { x: msg.x, y: msg.y });
    },

    receiveStrokeMove(msg) {
      if (!this.roundActive || !this.remoteStroke) return;
      (msg.points || []).forEach((p) => this.extendStroke(this.remoteStroke, p));
    },

    receiveFill(msg) {
      if (!this.roundActive) return;
      this.floodFill({ x: msg.x, y: msg.y }, msg.color);
    },

    receiveClear() {
      this.clearCanvas();
    },

    // ---------------------------------------------------------------
    // Bucket fill — a scanline flood fill run on the local canvas's own
    // pixel buffer. Both sides run it independently against their own
    // (visually equivalent) canvas, so no raw pixels need to cross the
    // wire — just the click point and the chosen color.
    // ---------------------------------------------------------------

    floodFill(point, hex) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      const px = Math.max(0, Math.min(w - 1, Math.round(point.x * this.dpr)));
      const py = Math.max(0, Math.min(h - 1, Math.round(point.y * this.dpr)));

      const ctx = this.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const imgData = ctx.getImageData(0, 0, w, h);
      ctx.restore();
      const data = imgData.data;

      const fill = this.hexToRgba(hex);
      const startOff = (py * w + px) * 4;
      const target = [data[startOff], data[startOff + 1], data[startOff + 2], data[startOff + 3]];
      if (this.colorsClose(target, fill, 10)) return;

      const match = (x, y) => {
        const o = (y * w + x) * 4;
        return this.colorsClose([data[o], data[o + 1], data[o + 2], data[o + 3]], target, FILL_TOLERANCE);
      };
      const paint = (x, y) => {
        const o = (y * w + x) * 4;
        data[o] = fill[0]; data[o + 1] = fill[1]; data[o + 2] = fill[2]; data[o + 3] = 255;
      };

      const stack = [[px, py]];
      while (stack.length) {
        const [x, y] = stack.pop();
        if (!match(x, y)) continue;

        let xl = x;
        while (xl > 0 && match(xl - 1, y)) xl--;
        let xr = x;
        while (xr < w - 1 && match(xr + 1, y)) xr++;

        let aboveOpen = false;
        let belowOpen = false;
        for (let i = xl; i <= xr; i++) {
          paint(i, y);

          if (y > 0) {
            const above = match(i, y - 1);
            if (above && !aboveOpen) { stack.push([i, y - 1]); aboveOpen = true; }
            else if (!above) { aboveOpen = false; }
          }
          if (y < h - 1) {
            const below = match(i, y + 1);
            if (below && !belowOpen) { stack.push([i, y + 1]); belowOpen = true; }
            else if (!below) { belowOpen = false; }
          }
        }
      }

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(imgData, 0, 0);
      ctx.restore();
    },

    colorsClose(a, b, tolerance) {
      return (
        Math.abs(a[0] - b[0]) <= tolerance &&
        Math.abs(a[1] - b[1]) <= tolerance &&
        Math.abs(a[2] - b[2]) <= tolerance &&
        Math.abs(a[3] - b[3]) <= tolerance
      );
    },

    hexToRgba(hex) {
      const h = hex.replace('#', '');
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const n = parseInt(full, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    },

    // ---------------------------------------------------------------
    // Feed / score
    // ---------------------------------------------------------------

    addFeed(text, kind) {
      const div = document.createElement('div');
      div.className = 'scr2-feed-item' + (kind ? ' ' + kind : '');
      div.textContent = text;
      this.feedEl.appendChild(div);
      this.feedEl.scrollTop = this.feedEl.scrollHeight;
      while (this.feedEl.children.length > 40) this.feedEl.removeChild(this.feedEl.firstChild);
    },

    clearFeed() {
      this.feedEl.innerHTML = '';
    },

    updateScore() {
      this.scoreEl.textContent = `You ${this.score.me} — ${this.score.opp} Partner`;
    },

    // ---------------------------------------------------------------
    // Message routing
    // ---------------------------------------------------------------

    handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'CONFIG': this.applyConfig(msg); break;
        case 'ROUND_START': this.applyRoundStart(msg); break;
        case 'STROKE_START': this.receiveStrokeStart(msg); break;
        case 'STROKE_MOVE': this.receiveStrokeMove(msg); break;
        case 'FILL': this.receiveFill(msg); break;
        case 'CLEAR': this.receiveClear(); break;
        case 'GUESS': this.receiveGuess(msg.text); break;
        case 'CORRECT': this.receiveCorrect(msg); break;
        case 'REVEAL': this.receiveReveal(msg); break;
      }
    },

    destroy() {
      this.stopTimer();
      if (this.unsub) { this.unsub(); this.unsub = null; }
    },
  };

  window.GameModules = window.GameModules || {};
  window.GameModules['scribble2'] = Scribble2;
})();
