(function () {
  'use strict';

  /*
   * Scribble
   *
   * A simple 2-player drawing + guessing game.
   *
   * Important:
   * The secret word is NEVER sent over the WebRTC connection.
   * The drawer chooses the word locally and only sends drawing/guess/result
   * messages.
   */

  const WORDS = [
    'apple',
    'banana',
    'balloon',
    'bicycle',
    'camera',
    'car',
    'cat',
    'chair',
    'clock',
    'cloud',
    'coffee',
    'crown',
    'dog',
    'elephant',
    'fish',
    'flower',
    'guitar',
    'house',
    'ice cream',
    'key',
    'kite',
    'lamp',
    'lion',
    'moon',
    'mountain',
    'pizza',
    'rainbow',
    'rocket',
    'shoe',
    'smile',
    'star',
    'sun',
    'tree',
    'umbrella',
    'watch',
    'watermelon'
  ];

  const ROUND_TIME = 60;
  const DRAW_THROTTLE_MS = 25;

  const Scribble = {
    init(api) {
      this.api = api;
      this.round = 0;
      this.secretWord = null;
      this.isDrawing = false;
      this.roundActive = false;
      this.lastPoint = null;
      this.lastSentAt = 0;
      this.timer = null;

      this.score = {
        me: 0,
        opp: 0
      };

      this.statusEl = api.root.querySelector('#scribble-status');
      this.timerEl = api.root.querySelector('#scribble-timer');
      this.wordEl = api.root.querySelector('#scribble-word');
      this.messageEl = api.root.querySelector('#scribble-message');
      this.scoreEl = api.root.querySelector('#scribble-score');

      this.canvas = api.root.querySelector('#scribble-canvas');
      this.canvasWrap = api.root.querySelector('#scribble-canvas-wrap');
      this.ctx = this.canvas.getContext('2d');

      this.clearBtn = api.root.querySelector('#scribble-clear-btn');
      this.colorInput = api.root.querySelector('#scribble-color');
      this.sizeInput = api.root.querySelector('#scribble-size');

      this.guessArea = api.root.querySelector('#scribble-guess-area');
      this.guessInput = api.root.querySelector('#scribble-guess-input');
      this.guessBtn = api.root.querySelector('#scribble-guess-btn');
      this.drawControls = api.root.querySelector('#scribble-draw-controls');

      this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
      this.resizeObserver.observe(this.canvasWrap);

      this.bindEvents();

      this.unsub = api.onMessage((msg) => this.handleMessage(msg));

      this.resizeCanvas();
      this.updateScore();

      /*
       * Host starts round 0.
       * Guest waits for ROUND_START.
       */
      if (api.isHost) {
        this.startRound(0);
      } else {
        this.showWaiting();
      }
    },

    bindEvents() {
      this.canvas.addEventListener('pointerdown', (event) => {
        if (!this.canDraw()) return;

        event.preventDefault();

        this.canvas.setPointerCapture(event.pointerId);

        const point = this.getPoint(event);
        this.isDrawing = true;
        this.lastPoint = point;

        this.drawDot(point);

        this.sendStroke({
          type: 'START',
          x: point.x,
          y: point.y
        });
      });

      this.canvas.addEventListener('pointermove', (event) => {
        if (!this.isDrawing || !this.canDraw()) return;

        event.preventDefault();

        const point = this.getPoint(event);

        this.drawLine(this.lastPoint, point);

        const now = Date.now();

        if (now - this.lastSentAt >= DRAW_THROTTLE_MS) {
          this.sendStroke({
            type: 'LINE',
            x1: this.lastPoint.x,
            y1: this.lastPoint.y,
            x2: point.x,
            y2: point.y
          });

          this.lastSentAt = now;
        }

        this.lastPoint = point;
      });

      const stopDrawing = () => {
        this.isDrawing = false;
        this.lastPoint = null;
      };

      this.canvas.addEventListener('pointerup', stopDrawing);
      this.canvas.addEventListener('pointercancel', stopDrawing);
      this.canvas.addEventListener('pointerleave', stopDrawing);

      this.clearBtn.addEventListener('click', () => {
        if (!this.canDraw()) return;

        this.clearCanvas();
        this.api.send({
          type: 'CLEAR'
        });
      });

      this.guessBtn.addEventListener('click', () => {
        this.submitGuess();
      });

      this.guessInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submitGuess();
        }
      });
    },

    /*
     * Host draws on even rounds.
     * Guest draws on odd rounds.
     */
    isMyDrawingTurn() {
      const hostDrawing = this.round % 2 === 0;
      return this.api.isHost === hostDrawing;
    },

    canDraw() {
      return this.roundActive && this.isMyDrawingTurn();
    },

    canGuess() {
      return this.roundActive && !this.isMyDrawingTurn();
    },

    startRound(round) {
      this.round = round;
      this.roundActive = true;
      this.secretWord = null;

      this.clearCanvas();
      this.clearMessage();

      /*
       * The drawer chooses the word locally.
       * It is intentionally NOT included in ROUND_START.
       */
      if (this.isMyDrawingTurn()) {
        this.secretWord = WORDS[Math.floor(Math.random() * WORDS.length)];

        this.statusEl.textContent = 'Draw this! ✏️';
        this.wordEl.textContent = this.secretWord;
        this.wordEl.classList.remove('hidden-word');

        this.setDrawingEnabled(true);
        this.setGuessEnabled(false);
      } else {
        this.statusEl.textContent = `${this.api.peerNickname || 'Partner'} is drawing…`;
        this.wordEl.textContent = 'Guess what they are drawing!';
        this.wordEl.classList.add('hidden-word');

        this.setDrawingEnabled(false);
        this.setGuessEnabled(true);
      }

      this.startTimer();

      /*
       * Only the host announces the beginning of a new round.
       * The guest gets the same round number through ROUND_START.
       */
      if (this.api.isHost || round > 0) {
        this.api.send({
          type: 'ROUND_START',
          round
        });
      }
    },

    showWaiting() {
      this.roundActive = false;
      this.statusEl.textContent = 'Waiting for the first round…';
      this.wordEl.textContent = 'Get ready!';
      this.wordEl.classList.add('hidden-word');
      this.setDrawingEnabled(false);
      this.setGuessEnabled(false);
    },

    startTimer() {
      this.stopTimer();

      const startedAt = Date.now();

      const update = () => {
        if (!this.roundActive) return;

        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        const remaining = Math.max(0, ROUND_TIME - elapsed);

        this.timerEl.textContent = remaining;

        if (remaining <= 0) {
          this.handleTimeout();
          return;
        }

        this.timer = setTimeout(update, 250);
      };

      update();
    },

    stopTimer() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    },

    handleTimeout() {
      if (!this.roundActive) return;

      this.roundActive = false;
      this.stopTimer();

      if (this.isMyDrawingTurn()) {
        this.statusEl.textContent = `Time's up! The word was "${this.secretWord}".`;
        this.api.send({
          type: 'TIMEOUT',
          word: this.secretWord
        });

        this.setDrawingEnabled(false);
        this.setGuessEnabled(false);

        this.nextRoundSoon();
      } else {
        this.statusEl.textContent = "Time's up!";
        this.setDrawingEnabled(false);
        this.setGuessEnabled(false);
      }
    },

    submitGuess() {
      if (!this.canGuess()) return;

      const guess = this.guessInput.value.trim();

      if (!guess) return;

      this.guessInput.value = '';

      this.api.send({
        type: 'GUESS',
        guess
      });

      this.messageEl.textContent = `You guessed: ${guess}`;
      this.messageEl.classList.add('muted');
    },

    handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'ROUND_START':
          this.startRound(msg.round);
          break;

        case 'START':
          this.receiveStart(msg);
          break;

        case 'LINE':
          this.receiveLine(msg);
          break;

        case 'CLEAR':
          this.clearCanvas();
          break;

        case 'GUESS':
          this.receiveGuess(msg.guess);
          break;

        case 'CORRECT':
          this.receiveCorrect(msg);
          break;

        case 'TIMEOUT':
          this.receiveTimeout(msg);
          break;
      }
    },

    receiveStart(msg) {
      if (!this.roundActive) return;

      this.drawDot({
        x: msg.x,
        y: msg.y
      });
    },

    receiveLine(msg) {
      if (!this.roundActive) return;

      this.drawLine(
        {
          x: msg.x1,
          y: msg.y1
        },
        {
          x: msg.x2,
          y: msg.y2
        }
      );
    },

    receiveGuess(guess) {
      /*
       * Only the drawer knows the secret word, so only the drawer
       * can validate guesses.
       */
      if (!this.isMyDrawingTurn() || !this.roundActive) return;

      const normalizedGuess = this.normalizeWord(guess);
      const normalizedWord = this.normalizeWord(this.secretWord);

      if (normalizedGuess === normalizedWord) {
        this.roundActive = false;
        this.stopTimer();

        this.score.opp++;

        this.statusEl.textContent = `${this.api.peerNickname || 'Partner'} guessed it! 🎉`;
        this.messageEl.textContent = `The word was "${this.secretWord}"`;
        this.messageEl.classList.remove('muted');
        this.updateScore();

        this.setDrawingEnabled(false);
        this.setGuessEnabled(false);

        this.api.send({
          type: 'CORRECT',
          word: this.secretWord
        });

        this.nextRoundSoon();
      } else {
        this.messageEl.textContent = `${this.api.peerNickname || 'Partner'} guessed: ${guess}`;
        this.messageEl.classList.add('muted');
      }
    },

    receiveCorrect(msg) {
      if (!this.roundActive) return;

      this.roundActive = false;
      this.stopTimer();

      this.score.me++;

      this.statusEl.textContent = 'Correct! 🎉';
      this.messageEl.textContent = `The word was "${msg.word}"`;
      this.messageEl.classList.remove('muted');

      this.updateScore();

      this.setDrawingEnabled(false);
      this.setGuessEnabled(false);
    },

    receiveTimeout(msg) {
      if (!this.roundActive) return;

      this.roundActive = false;
      this.stopTimer();

      this.statusEl.textContent = `Time's up! The word was "${msg.word}".`;
      this.setDrawingEnabled(false);
      this.setGuessEnabled(false);
    },

    nextRoundSoon() {
      /*
       * Give both players a moment to see the result.
       *
       * Only the host announces the next round so there is one
       * authoritative sequence of round numbers.
       */
      if (!this.api.isHost) return;

      const nextRound = this.round + 1;

      setTimeout(() => {
        this.startRound(nextRound);
      }, 1800);
    },

    normalizeWord(value) {
      return String(value || '')
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}]+/gu, '');
    },

    setDrawingEnabled(enabled) {
      this.clearBtn.disabled = !enabled;
      this.colorInput.disabled = !enabled;
      this.sizeInput.disabled = !enabled;

      this.drawControls.classList.toggle(
        'scribble-disabled',
        !enabled
      );
    },

    setGuessEnabled(enabled) {
      this.guessInput.disabled = !enabled;
      this.guessBtn.disabled = !enabled;

      if (enabled) {
        this.guessArea.classList.remove('scribble-disabled');
        setTimeout(() => this.guessInput.focus(), 50);
      } else {
        this.guessArea.classList.add('scribble-disabled');
      }
    },

    sendStroke(stroke) {
      this.api.send({
        ...stroke,
        color: this.colorInput.value,
        size: Number(this.sizeInput.value)
      });
    },

    getPoint(event) {
      const rect = this.canvas.getBoundingClientRect();

      /*
       * Coordinates are normalized to 0..1 so both players can have
       * different screen sizes / canvas resolutions.
       */
      return {
        x: Math.max(
          0,
          Math.min(1, (event.clientX - rect.left) / rect.width)
        ),
        y: Math.max(
          0,
          Math.min(1, (event.clientY - rect.top) / rect.height)
        )
      };
    },

    canvasPoint(point) {
      return {
        x: point.x * this.canvas.width,
        y: point.y * this.canvas.height
      };
    },

    applyBrush() {
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.strokeStyle = this.currentColor || '#222222';
      this.ctx.lineWidth = this.currentSize || 5;
    },

    drawDot(point, color, size) {
      const p = this.canvasPoint(point);

      this.ctx.save();

      this.ctx.fillStyle = color || this.colorInput.value || '#222222';

      const brushSize =
        size ||
        Number(this.sizeInput.value) ||
        5;

      this.ctx.beginPath();
      this.ctx.arc(
        p.x,
        p.y,
        brushSize / 2,
        0,
        Math.PI * 2
      );
      this.ctx.fill();

      this.ctx.restore();
    },

    drawLine(from, to, color, size) {
      const p1 = this.canvasPoint(from);
      const p2 = this.canvasPoint(to);

      this.ctx.save();

      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.strokeStyle =
        color || this.colorInput.value || '#222222';
      this.ctx.lineWidth =
        size || Number(this.sizeInput.value) || 5;

      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.stroke();

      this.ctx.restore();
    },

    clearCanvas() {
      this.ctx.clearRect(
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );
    },

    resizeCanvas() {
      if (!this.canvasWrap) return;

      const rect = this.canvasWrap.getBoundingClientRect();

      if (!rect.width || !rect.height) return;

      /*
       * Keep the canvas reasonably sharp on high-DPI phones.
       */
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      const oldCanvas = document.createElement('canvas');
      oldCanvas.width = this.canvas.width;
      oldCanvas.height = this.canvas.height;

      if (this.canvas.width && this.canvas.height) {
        oldCanvas
          .getContext('2d')
          .drawImage(this.canvas, 0, 0);
      }

      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);

      /*
       * The CSS size remains the actual displayed size.
       */
      this.canvas.style.width = `${rect.width}px`;
      this.canvas.style.height = `${rect.height}px`;

      /*
       * Existing drawing is intentionally not restored here.
       * A resize usually happens before drawing starts.
       */
      this.ctx.clearRect(
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );
    },

    updateScore() {
      this.scoreEl.textContent =
        `You ${this.score.me} — ` +
        `${this.score.opp} Partner`;
    },

    clearMessage() {
      this.messageEl.textContent = '';
      this.messageEl.classList.add('muted');
    },

    destroy() {
      this.stopTimer();

      if (this.unsub) {
        this.unsub();
        this.unsub = null;
      }

      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
    }
  };

  window.GameModules = window.GameModules || {};
  window.GameModules['scribble'] = Scribble;
})();