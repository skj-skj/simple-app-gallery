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
  const WORD_LIST_URL = 'games/assets/scribble-word-list.json';
  // Fractions of round time *remaining* at which the drawer reveals a
  // letter to the guesser — first hint with 60% of the time left,
  // second with 40% left.
  const HINT_THRESHOLDS = [0.6, 0.4];
  const CHOOSE_SECONDS = 10; // how long the drawer has to pick a word

  const Scribble2 = {
    init(api) {
      this.api = api;

      this.round = -1;
      this.roundTime = 60;
      this.roundsEach = 5;
      this.totalRounds = 10;
      this.words = DEFAULT_WORDS;
      this.secretWord = null;
      this.roundActive = false;
      this.startedAt = 0;
      this.timerHandle = null;
      this.score = { me: 0, opp: 0 };

      this.wordListData = null;   // { categoryKey: { label, words[] } }, host-only
      this.hintsSent = 0;         // how many hints the drawer has sent this round
      this.revealedIndices = null; // Set of letter indices already hinted (drawer side)
      this.guessMask = null;      // per-character array the guesser renders as dashes
      this.usedWords = new Set(); // lowercase words already drawn this session — no repeats
      this.pendingChoices = null; // the 3 words currently offered to the drawer
      this.chooseTimerHandle = null;
      this.chooseSecondsLeft = CHOOSE_SECONDS;

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
        this.playAgainBtn.classList.remove('scr2-hidden');
        this.loadWordListAsset();
      } else {
        this.waitingNameEl.textContent = api.peerNickname || 'your partner';
        this.waitingEl.classList.remove('scr2-hidden');
        this.endWaitingNoteEl.classList.remove('scr2-hidden');
      }
    },

    cacheDom() {
      const $ = (sel) => this.api.root.querySelector(sel);

      this.setupEl = $('#s2-setup');
      this.waitingEl = $('#s2-waiting');
      this.waitingNameEl = $('#s2-waiting-name');
      this.timeSelect = $('#s2-time');
      this.roundsSelect = $('#s2-rounds');
      this.categorySelect = $('#s2-category');
      this.customFieldEl = $('#s2-custom-field');
      this.wordsInput = $('#s2-words');
      this.startBtn = $('#s2-start-btn');

      this.endEl = $('#s2-end');
      this.endResultEl = $('#s2-end-result');
      this.endScoreEl = $('#s2-end-score');
      this.playAgainBtn = $('#s2-play-again-btn');
      this.endWaitingNoteEl = $('#s2-end-waiting-note');

      this.gameEl = $('#s2-game');
      this.statusEl = $('#s2-status');
      this.timerEl = $('#s2-timer');
      this.wordEl = $('#s2-word');

      this.chooseEl = $('#s2-choose');
      this.chooseOptionsEl = $('#s2-choose-options');
      this.chooseTimerLabel = $('#s2-choose-timer');

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
      this.playAgainBtn.addEventListener('click', () => this.showSetupAgain());
      this.categorySelect.addEventListener('change', () => {
        this.customFieldEl.classList.toggle('scr2-hidden', this.categorySelect.value !== 'custom');
      });

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

    // Fetches the categorized word-list asset (pure data — see
    // games/assets/scribble-word-list.json) and, once it's in, adds an
    // <option> for each category to the setup dropdown. Failure just
    // means the host is left with "All" (falling back to DEFAULT_WORDS)
    // and "Custom list…" — the game still works.
    loadWordListAsset() {
      fetch(WORD_LIST_URL)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          this.wordListData = data;
          if (data) this.populateCategorySelect(data);
        })
        .catch(() => { this.wordListData = null; });
    },

    populateCategorySelect(list) {
      const customOpt = this.categorySelect.querySelector('#s2-custom-option');
      const frag = document.createDocumentFragment();
      Object.keys(list).forEach((key) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = `${list[key].label} (${list[key].words.length})`;
        frag.appendChild(opt);
      });
      this.categorySelect.insertBefore(frag, customOpt);
    },

    // Turns the setup screen's word-list selection into a concrete word
    // array: a specific category, every category merged and de-duplicated
    // ("All"), or the host's own custom list.
    resolveWordSelection() {
      const mode = this.categorySelect.value;

      if (mode === 'custom') {
        const custom = this.parseCustomWords(this.wordsInput.value);
        return custom.length >= MIN_CUSTOM_WORDS ? custom : DEFAULT_WORDS.slice();
      }

      const list = this.wordListData;
      if (!list) return DEFAULT_WORDS.slice();

      if (mode === 'all') {
        const seen = new Set();
        const merged = [];
        Object.keys(list).forEach((key) => {
          (list[key].words || []).forEach((w) => {
            const norm = w.toLowerCase();
            if (seen.has(norm)) return;
            seen.add(norm);
            merged.push(w);
          });
        });
        return merged;
      }

      return list[mode] ? list[mode].words.slice() : DEFAULT_WORDS.slice();
    },

    startGame() {
      const time = parseInt(this.timeSelect.value, 10) || 60;
      const roundsEach = parseInt(this.roundsSelect.value, 10) || 5;
      const words = this.resolveWordSelection();

      this.roundTime = time;
      this.roundsEach = roundsEach;
      this.totalRounds = roundsEach * 2;
      this.words = words;

      this.setupEl.classList.add('scr2-hidden');
      this.endEl.classList.add('scr2-hidden');
      this.gameEl.classList.remove('scr2-hidden');

      this.api.send({ type: 'CONFIG', roundTime: time, roundsEach, words });
      this.beginRound(0);
    },

    // Host-only: return to the setup screen after a game finishes, to
    // configure and start another one.
    showSetupAgain() {
      if (!this.api.isHost) return;
      this.endEl.classList.add('scr2-hidden');
      this.setupEl.classList.remove('scr2-hidden');
    },

    applyConfig(msg) {
      this.roundTime = msg.roundTime || 60;
      this.roundsEach = msg.roundsEach || 5;
      this.totalRounds = this.roundsEach * 2;
      this.words = Array.isArray(msg.words) && msg.words.length ? msg.words : DEFAULT_WORDS;

      this.waitingEl.classList.add('scr2-hidden');
      this.setupEl.classList.add('scr2-hidden');
      this.endEl.classList.add('scr2-hidden');
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

    turnLabel() {
      return `Turn ${Math.floor(this.round / 2) + 1}/${this.roundsEach}`;
    },

    spaceIndices(word) {
      const idx = [];
      for (let i = 0; i < word.length; i++) if (word[i] === ' ') idx.push(i);
      return idx;
    },

    // beginRound() only announces which round it is — nobody's drawing
    // timer starts yet. The drawer still has to pick a word (see
    // beginWordChoice()); the actual countdown starts from selectWord()
    // / receiveWordChosen(), once a word is locked in.
    beginRound(round) {
      this.applyRoundStart({ round });
      this.api.send({ type: 'ROUND_START', round });
    },

    applyRoundStart(msg) {
      this.round = msg.round;
      this.roundActive = false;
      this.secretWord = null;
      this.guessMask = null;
      this.hintsSent = 0;
      this.revealedIndices = new Set();
      this.stopTimer();
      this.stopChooseTimer();

      if (msg.round === 0) {
        this.score = { me: 0, opp: 0 };
        this.updateScore();
        this.usedWords = new Set(); // fresh no-repeat pool for a new game
      }

      this.setTool('draw');
      this.clearCanvas();
      this.clearFeed();
      this.chooseEl.classList.add('scr2-hidden');
      this.timerEl.textContent = '--';
      this.timerEl.classList.remove('low');
      this.setToolbarEnabled(false);
      this.setGuessEnabled(false);

      if (this.isMyDrawingTurn()) {
        this.statusEl.textContent = `Your turn — pick a word! (${this.turnLabel()})`;
        this.wordEl.textContent = '';
        this.wordEl.classList.remove('dashes');
        this.wordEl.classList.add('masked');
        this.beginWordChoice();
      } else {
        this.statusEl.textContent = `Partner is choosing a word… (${this.turnLabel()})`;
        this.wordEl.textContent = 'Waiting for partner to pick a word…';
        this.wordEl.classList.remove('dashes');
        this.wordEl.classList.add('masked');
      }
    },

    // ---------------------------------------------------------------
    // Word choice — skribbl-style: the drawer picks one of 3 options
    // (auto-picking the first if they don't choose in time). Words are
    // drawn from the not-yet-used pool for this session so nothing
    // repeats until every word in the chosen list has come up once.
    // ---------------------------------------------------------------

    pickWordChoices(n) {
      const unused = this.words.filter((w) => !this.usedWords.has(w.toLowerCase()));
      const source = unused.length >= n ? unused : this.words;
      const shuffled = source.slice().sort(() => Math.random() - 0.5);
      return shuffled.slice(0, Math.min(n, shuffled.length));
    },

    beginWordChoice() {
      this.pendingChoices = this.pickWordChoices(3);
      this.chooseOptionsEl.innerHTML = '';
      this.pendingChoices.forEach((word) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'scr2-choice-btn';
        btn.textContent = word;
        btn.addEventListener('click', () => this.selectWord(word));
        this.chooseOptionsEl.appendChild(btn);
      });
      this.chooseEl.classList.remove('scr2-hidden');
      this.startChooseTimer();
    },

    startChooseTimer() {
      this.stopChooseTimer();
      this.chooseSecondsLeft = CHOOSE_SECONDS;
      const tick = () => {
        this.chooseTimerLabel.textContent = `Auto-picking in ${this.chooseSecondsLeft}s`;
        if (this.chooseSecondsLeft <= 0) {
          this.selectWord(this.pendingChoices[0]);
          return;
        }
        this.chooseSecondsLeft--;
        this.chooseTimerHandle = setTimeout(tick, 1000);
      };
      tick();
    },

    stopChooseTimer() {
      if (this.chooseTimerHandle) clearTimeout(this.chooseTimerHandle);
      this.chooseTimerHandle = null;
    },

    selectWord(word) {
      this.stopChooseTimer();
      this.pendingChoices = null;
      this.chooseEl.classList.add('scr2-hidden');

      this.secretWord = word;
      this.usedWords.add(word.toLowerCase());
      if (this.usedWords.size >= this.words.length) {
        // Whole pool used up this session — start a fresh cycle rather
        // than getting stuck with nothing left to offer.
        this.usedWords = new Set([word.toLowerCase()]);
      }

      this.hintsSent = 0;
      this.revealedIndices = new Set();
      this.startedAt = Date.now();
      this.roundActive = true;

      this.statusEl.textContent = `Your turn — draw this! ✏️ (${this.turnLabel()})`;
      this.wordEl.textContent = this.secretWord;
      this.wordEl.classList.remove('masked');
      this.setToolbarEnabled(true);

      this.startTimer();

      this.api.send({
        type: 'WORD_CHOSEN',
        startedAt: this.startedAt,
        length: word.length,
        spaces: this.spaceIndices(word),
      });
    },

    receiveWordChosen(msg) {
      if (this.round < 0) return;

      this.startedAt = msg.startedAt;
      this.roundActive = true;
      this.hintsSent = 0;

      this.guessMask = new Array(msg.length).fill(null);
      (msg.spaces || []).forEach((i) => { this.guessMask[i] = ' '; });
      this.renderGuessMask();

      this.statusEl.textContent = `Partner is drawing… (${this.turnLabel()})`;
      this.setToolbarEnabled(false);
      this.setGuessEnabled(true);

      this.startTimer();
    },

    renderGuessMask() {
      if (!this.guessMask) return;
      this.wordEl.textContent = this.guessMask.map((c) => (c === null ? '_' : c)).join(' ');
      this.wordEl.classList.remove('masked');
      this.wordEl.classList.add('dashes');
    },

    // ---------------------------------------------------------------
    // Timer + letter hints — only the drawer decides when/what to
    // reveal, since only the drawer knows secretWord; the guesser just
    // applies whatever HINT messages arrive.
    // ---------------------------------------------------------------

    startTimer() {
      this.stopTimer();
      const tick = () => {
        if (!this.roundActive) return;
        const elapsed = (Date.now() - this.startedAt) / 1000;
        const remaining = Math.max(0, this.roundTime - Math.floor(elapsed));
        this.timerEl.textContent = remaining;
        this.timerEl.classList.toggle('low', remaining <= 10);

        if (this.isMyDrawingTurn()) this.maybeDropHint(remaining);

        if (remaining <= 0) { this.handleTimeout(); return; }
        this.timerHandle = setTimeout(tick, 250);
      };
      tick();
    },

    stopTimer() {
      if (this.timerHandle) clearTimeout(this.timerHandle);
      this.timerHandle = null;
    },

    maybeDropHint(remaining) {
      if (!this.secretWord) return;
      const fraction = remaining / this.roundTime;
      const threshold = HINT_THRESHOLDS[this.hintsSent];
      if (threshold === undefined || fraction > threshold) return;
      this.sendHint();
      this.hintsSent++;
    },

    sendHint() {
      const candidates = [];
      for (let i = 0; i < this.secretWord.length; i++) {
        if (this.secretWord[i] === ' ' || this.revealedIndices.has(i)) continue;
        candidates.push(i);
      }
      if (!candidates.length) return;
      const index = candidates[Math.floor(Math.random() * candidates.length)];
      this.revealedIndices.add(index);
      this.api.send({ type: 'HINT', index, letter: this.secretWord[index] });
    },

    receiveHint(msg) {
      if (!this.roundActive || !this.guessMask) return;
      this.guessMask[msg.index] = msg.letter;
      this.renderGuessMask();
      this.addFeed('💡 A letter was revealed', 'system');
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
        this.afterRoundEnd();
      } else {
        this.statusEl.textContent = "Time's up!";
      }
    },

    // Called locally by whichever client just found out the round ended
    // (as drawer, on timeout/correct-guess; as guesser, on receiving that
    // news). Every call independently works out whether the game is over;
    // only the room host actually originates the next ROUND_START, but
    // that's decided here rather than by who happened to be drawing, so
    // progression doesn't stall when the guest is drawing but the host
    // is guessing (or vice versa).
    afterRoundEnd() {
      const isLastRound = (this.round + 1) >= this.totalRounds;
      setTimeout(() => {
        if (isLastRound) {
          this.endGame();
        } else if (this.api.isHost) {
          this.beginRound(this.round + 1);
        }
      }, NEXT_ROUND_DELAY_MS);
    },

    endGame() {
      this.roundActive = false;
      this.stopTimer();
      this.setToolbarEnabled(false);
      this.setGuessEnabled(false);

      let resultText;
      if (this.score.me > this.score.opp) resultText = 'You won! 🏆';
      else if (this.score.me < this.score.opp) resultText = 'Partner won! 🏆';
      else resultText = "It's a tie!";

      this.endResultEl.textContent = resultText;
      this.endScoreEl.textContent = `Final score — You ${this.score.me} : ${this.score.opp} Partner`;

      this.gameEl.classList.add('scr2-hidden');
      this.endEl.classList.remove('scr2-hidden');
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

      if (norm && norm === this.normalize(this.secretWord)) {
        this.roundActive = false;
        this.stopTimer();
        this.score.opp++;
        this.updateScore();

        this.statusEl.textContent = 'Partner guessed it! 🎉';
        this.addFeed(`🎉 Partner guessed "${this.secretWord}"!`, 'correct');
        this.setToolbarEnabled(false);
        this.setGuessEnabled(false);

        this.api.send({ type: 'CORRECT', word: this.secretWord });
        this.afterRoundEnd();
      } else {
        this.addFeed(`Partner: ${text}`, 'peer');
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
      this.wordEl.textContent = msg.word;
      this.wordEl.classList.remove('masked', 'dashes');
      this.setGuessEnabled(false);
      this.afterRoundEnd();
    },

    receiveReveal(msg) {
      if (!this.roundActive) return;
      this.roundActive = false;
      this.stopTimer();

      this.statusEl.textContent = `Time's up! The word was "${msg.word}".`;
      this.addFeed(`⏰ Time's up — the word was "${msg.word}"`, 'system');
      this.wordEl.textContent = msg.word;
      this.wordEl.classList.remove('masked', 'dashes');
      this.setGuessEnabled(false);
      this.afterRoundEnd();
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
        case 'WORD_CHOSEN': this.receiveWordChosen(msg); break;
        case 'HINT': this.receiveHint(msg); break;
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
      this.stopChooseTimer();
      if (this.unsub) { this.unsub(); this.unsub = null; }
    },
  };

  window.GameModules = window.GameModules || {};
  window.GameModules['scribble2'] = Scribble2;
})();