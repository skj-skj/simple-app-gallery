(function () {
  'use strict';

  /*
   * Building Fall — a trust / betrayal game for two.
   *
   * Each player stands on top of their own building. Every floor has three
   * openings (LEFT / CENTER / RIGHT). HARD: one safe, two on fire.
   * EASY: two safe, one on fire (host picks the difficulty). You
   * can't see which of YOUR openings is safe, but you can see your
   * partner's — so each of you depends on what the other one tells you.
   * Every jump drops you one floor: safe +10, fire −5 (your character
   * gets a little darker with every fire, darkest if every jump was
   * fire). Both players always play to the ground; highest score wins.
   *
   * ---------------------------------------------------------------------
   * Architecture (same conventions as the other games)
   * ---------------------------------------------------------------------
   * - Host-authoritative. Only the host shows the config controls, rolls
   *   the building layouts, starts each floor, collects both final choices
   *   and resolves the jumps. The guest only applies what it receives.
   * - Send events, not the scene. Nothing about the Three.js scene is sent.
   *   Messages: HELLO, CONFIG, GAME_STARTED, FLOOR_STARTED, CHOICE,
   *   POS (live character position while choosing, throttled),
   *   FLOOR_RESOLVED (per-player outcomes carrying PLAYER_JUMPED /
   *   PLAYER_SAFE / PLAYER_FIRE / PLAYER_REACHED_BOTTOM),
   *   GAME_FINISHED, REMATCH_REQUEST, BACK_TO_CONFIG, TIME_REQ / TIME_RES.
   * - Keep secrets local. The guest receives the HOST's layout (it is
   *   meant to see it) but NOT its own: each of its own floors is revealed
   *   in FLOOR_RESOLVED after it jumps, and the full layout arrives with
   *   GAME_FINISHED. Where each character stands IS shared live (POS),
   *   so you can guide your partner ("go left… more… stop!"); the
   *   authoritative pick is still the final CHOICE sent at time-out.
   * - Timer. The host sends the floor deadline once (in host clock). The
   *   guest converts it with a clock offset measured by a small
   *   TIME_REQ/TIME_RES exchange, so both countdowns end together. The
   *   visual countdown is local; the actual result only comes from the
   *   host's FLOOR_RESOLVED.
   * - Idempotent. Every message carries gameNo (+ round). Anything for an
   *   old game/round, or already applied, is ignored, and scores are
   *   applied as absolute values from the host's snapshot — a duplicated
   *   message can never award points twice.
   *
   * Rendering: Three.js draws the 3D buildings/characters/flames. KAPLAY
   * drives the frame loop (onUpdate + dt) and a transparent 2D overlay for
   * the floating "+10 / −5" text, sparks and confetti. Both are loaded
   * from jsDelivr with dynamic import(), no build step. If KAPLAY can't
   * load, a plain requestAnimationFrame loop is used and the overlay
   * effects are skipped. All game logic uses setTimeout/Date.now, never
   * the render loop, so it keeps working even when frames aren't drawn.
   */

  const GAME_ID = 'building_fall';
  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
  const KAPLAY_URL = 'https://cdn.jsdelivr.net/npm/kaplay@3001.0.19/dist/kaplay.mjs';
  const SOUND_SCRIPT_SRC = 'games/assets/building_fall_sounds.js';

  // ---- Configuration ------------------------------------------------------
  const TIMER_OPTIONS = [30, 60, 90];          // seconds; add values here
  const DEFAULT_TIMER = 30;
  // Difficulty = how many of the 3 openings on each floor are safe.
  const DIFFICULTIES = {
    easy: { label: 'Easy', safeCount: 2, rule: '2 safe, 1 on fire' },
    hard: { label: 'Hard', safeCount: 1, rule: '1 safe, 2 on fire' },
  };
  const DEFAULT_DIFFICULTY = 'hard';
  const FLOORS_MIN = 3;
  const FLOORS_MAX = 20;
  const FLOORS_DEFAULT = 10;

  // ---- Scoring -------------------------------------------------------------
  const SAFE_POINTS = 10;
  const FIRE_POINTS = -5;

  // ---- Timing --------------------------------------------------------------
  const INTRO_MS = 1600;         // GAME_STARTED → first floor
  const RESULT_PAUSE_MS = 2700;  // FLOOR_RESOLVED → next floor / game over
  const CHOICE_WAIT_MS = 4000;   // host waits this long past the deadline for the guest's CHOICE
  const TICK_FROM_S = 10;        // countdown ticks only in the last N seconds
  const POS_SEND_MS = 80;        // throttle for live position updates
  const MAX_DARKNESS = 0.85;     // how dark a character gets if EVERY jump was fire

  const OPENINGS = ['LEFT', 'CENTER', 'RIGHT'];

  // ---- Scene dimensions (world units) -------------------------------------
  const FLOOR_H = 3;
  const SLAB_T = 0.3;
  const BLD_W = 5;
  const BLD_D = 3.2;
  const HOLE = 1.1;
  const HOLE_X = [-1.6, 0, 1.6];
  const HOLE_Z = 0.35;
  const CHAR_Z = -0.95;
  const BLD_CX = 3.0;            // building centres at ±BLD_CX (yours on the left)
  const X_MIN = -2.2;
  const X_MAX = 2.2;
  const CAM_FOV = 40;
  const CAM_PITCH = 0.5;         // radians looking down

  const ROLE_COLOR = { host: 0x667eea, guest: 0xe0724a };
  const ROLE_CSS = { host: '#667eea', guest: '#e0724a' };
  const BLD_TINT = { host: 0xdfe3fb, guest: 0xfbe3d8 };
  const WALL_TINT = { host: 0xb7bfe8, guest: 0xe8c2b0 };

  // Jump animation phases (seconds)
  const T_WALK = 0.3;
  const T_HOP = 0.26;
  const T_FALL = 0.5;
  const T_LAND = 0.35;

  // ---------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------

  function randInt(n) {
    if (window.crypto && crypto.getRandomValues) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  // layout[level] = sorted list of the SAFE opening indices (0..2) on that
  // floor, e.g. [1] on hard or [0, 2] on easy. Level 0 is the ground.
  function generateLayout(floors, difficulty) {
    const safeCount = (DIFFICULTIES[difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY]).safeCount;
    const layout = [null];
    for (let level = 1; level <= floors; level++) {
      const idx = [0, 1, 2];
      for (let i = idx.length - 1; i > 0; i--) { const j = randInt(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      layout.push(idx.slice(0, safeCount).sort());
    }
    return layout;
  }

  function isSafe(row, idx) { return Array.isArray(row) && row.indexOf(idx) >= 0; }

  function nearestOpening(x) {
    let best = 0;
    for (let i = 1; i < HOLE_X.length; i++) {
      if (Math.abs(x - HOLE_X[i]) < Math.abs(x - HOLE_X[best])) best = i;
    }
    return best;
  }

  function alignedOpening(x) {
    for (let i = 0; i < HOLE_X.length; i++) if (Math.abs(x - HOLE_X[i]) < 0.06) return i;
    return -1;
  }

  function initialPlayers(floors) {
    const p = () => ({ level: floors, score: 0, status: 'active', history: [] });
    return { host: p(), guest: p() };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function activeRoles(players) {
    return ['host', 'guest'].filter((r) => players[r].status === 'active');
  }

  function winnerOf(players) {
    if (players.host.score > players.guest.score) return 'host';
    if (players.guest.score > players.host.score) return 'guest';
    return 'draw';
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  // ---------------------------------------------------------------------
  // Game module
  // ---------------------------------------------------------------------

  const BuildingFall = {
    init(api) {
      this.api = api;
      this.me = api.isHost ? 'host' : 'guest';
      this.opp = api.isHost ? 'guest' : 'host';
      this.alive = true;
      this.timers = new Set();
      this.hostTimers = new Set();
      this.cleanups = [];

      this.phase = 'config';   // config | intro | choosing | locked | resolving | finished
      this.config = { floors: FLOORS_DEFAULT, timer: DEFAULT_TIMER, difficulty: DEFAULT_DIFFICULTY };
      this.gameNo = 0;
      this.round = -1;
      this.lastResolvedRound = -1;
      this.finishedGameNo = 0;
      this.players = null;
      this.layouts = { host: null, guest: null };
      this.pendingChoices = {};
      this.lastColumn = { host: 1, guest: 1 };
      this.hostLocked = false;

      this.peerReady = false;   // partner's module is mounted and its 3D libs loaded
      this.peerPresent = false;
      this.libsReady = false;
      this.clock = { offset: 0, bestRtt: Infinity, synced: false };

      this.localDeadline = 0;
      this.tickHandle = null;
      this.lastTickSec = null;
      this.myTargetX = 0;
      this.myFinal = null;
      this.oppTargetX = null;   // partner's live position (from POS)
      this._posLastSent = 0;
      this._posLastX = null;
      this._posTimer = null;
      this.displayScore = { host: 0, guest: 0 };
      this.view = null;         // what the scene currently shows per role (lags data during animations)
      this.revealed = { host: new Set(), guest: new Set() };
      this.waitingRematch = false;

      this.three = null;        // scene state once the libraries are loaded
      this.k = null;

      this.cacheDom();
      this.bindEvents();
      this.unsub = api.onMessage((msg) => this.handleMessage(msg));
      this.loadSounds();
      this.applyTheme();
      this.goToConfig();

      this.sendHello(true);
      this.loadLibraries();
    },

    destroy() {
      this.alive = false;
      this.clearHostTimers();
      this.timers.forEach((h) => clearTimeout(h));
      this.timers.clear();
      this.stopTick();
      if (this.unsub) this.unsub();
      this.cleanups.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
      this.cleanups = [];
      this.disposeScene();
    },

    // ---------------------------------------------------------------------
    // Timers (all cleared on destroy; host round timers also on abort)
    // ---------------------------------------------------------------------

    later(fn, ms) {
      const h = setTimeout(() => { this.timers.delete(h); if (this.alive) fn(); }, ms);
      this.timers.add(h);
      return h;
    },

    hostLater(fn, ms) {
      const h = setTimeout(() => { this.hostTimers.delete(h); if (this.alive) fn(); }, ms);
      this.hostTimers.add(h);
      return h;
    },

    clearHostTimers() {
      this.hostTimers.forEach((h) => clearTimeout(h));
      this.hostTimers.clear();
    },

    // ---------------------------------------------------------------------
    // DOM
    // ---------------------------------------------------------------------

    cacheDom() {
      const $ = (sel) => this.api.root.querySelector(sel);
      this.wrapEl = $('#bf-wrap');
      this.stageEl = $('#bf-stage');
      this.canvas3d = $('#bf-3d');
      this.canvasFx = $('#bf-fx');

      this.hudFloorEl = $('#bf-hud-floor');
      this.hudTimeEl = $('#bf-hud-time');
      this.hudTimeCell = $('#bf-hud-time-cell');
      this.hudMeEl = $('#bf-hud-me');
      this.hudOppEl = $('#bf-hud-opp');
      this.hudOppLabel = $('#bf-hud-opp-label');
      this.muteBtn = $('#bf-mute-btn');
      this.tagMeEl = $('#bf-tag-me');
      this.tagOppEl = $('#bf-tag-opp');

      this.toastEl = $('#bf-toast');
      this.toastTitleEl = $('#bf-toast-title');
      this.toastDeltaEl = $('#bf-toast-delta');
      this.toastSubEl = $('#bf-toast-sub');

      this.configEl = $('#bf-config');
      this.configSubEl = $('#bf-config-sub');
      this.floorsMinusBtn = $('#bf-floors-minus');
      this.floorsPlusBtn = $('#bf-floors-plus');
      this.floorsValEl = $('#bf-floors-val');
      this.timerOptsEl = $('#bf-timer-opts');
      this.diffOptsEl = $('#bf-diff-opts');
      this.rulesSplitEl = $('#bf-rules-split');
      this.startBtn = $('#bf-start-btn');
      this.configNoteEl = $('#bf-config-note');
      this.configSpinnerEl = $('#bf-config-spinner');

      this.resultEl = $('#bf-result');
      this.resultVerdictEl = $('#bf-result-verdict');
      this.resultMeBox = $('#bf-result-me');
      this.resultOppBox = $('#bf-result-opp');
      this.resultMeName = $('#bf-result-me-name');
      this.resultOppName = $('#bf-result-opp-name');
      this.resultMeScore = $('#bf-result-me-score');
      this.resultOppScore = $('#bf-result-opp-score');
      this.resultMeStatus = $('#bf-result-me-status');
      this.resultOppStatus = $('#bf-result-opp-status');
      this.resultMeHist = $('#bf-result-me-hist');
      this.resultOppHist = $('#bf-result-opp-hist');
      this.againBtn = $('#bf-again-btn');
      this.configBtn = $('#bf-config-btn');
      this.resultNoteEl = $('#bf-result-note');
      this.resultModeEl = $('#bf-result-mode');

      this.loadingEl = $('#bf-loading');
      this.loadingTextEl = $('#bf-loading-text');

      this.statusEl = $('#bf-status');
      this.choiceLabelEl = $('#bf-choice-label');
      this.choiceBtns = Array.from(this.api.root.querySelectorAll('.bf-choice'));
    },

    // Always "You" / "Partner" (nicknames can be stale or the room name).
    partnerName() { return 'Partner'; },

    applyTheme() {
      this.wrapEl.style.setProperty('--bf-me-color', ROLE_CSS[this.me]);
      this.wrapEl.style.setProperty('--bf-opp-color', ROLE_CSS[this.opp]);
      const pn = this.partnerName();
      this.hudOppLabel.textContent = pn;
      this.tagMeEl.textContent = 'YOU · fire hidden ❓';
      this.tagOppEl.textContent = `${pn.toUpperCase()} · fire visible 👁`;
      this.resultMeName.textContent = 'You';
      this.resultOppName.textContent = pn;
      this.updateMuteBtn();
    },

    bindEvents() {
      const on = (el, ev, fn, opts) => {
        el.addEventListener(ev, fn, opts);
        this.cleanups.push(() => el.removeEventListener(ev, fn, opts));
      };

      this.choiceBtns.forEach((btn) => {
        on(btn, 'click', () => {
          this.unlockSound();
          this.selectOpening(Number(btn.dataset.idx));
        });
      });

      on(this.floorsMinusBtn, 'click', () => { this.unlockSound(); this.changeFloors(-1); });
      on(this.floorsPlusBtn, 'click', () => { this.unlockSound(); this.changeFloors(1); });
      on(this.startBtn, 'click', () => { this.unlockSound(); this.hostStartGame(); });
      on(this.againBtn, 'click', () => { this.unlockSound(); this.onPlayAgain(); });
      on(this.configBtn, 'click', () => { this.unlockSound(); this.hostBackToConfig(); });
      on(this.muteBtn, 'click', () => {
        const S = window.BuildingFallSounds;
        if (!S) return;
        S.setMuted(!S.isMuted());
        if (!S.isMuted()) S.unlock();
        this.updateMuteBtn();
      });
      on(this.loadingEl, 'click', () => { if (this.libsFailed) this.loadLibraries(); });

      // Desktop convenience only — never required.
      on(document, 'keydown', (e) => {
        if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
        const k = e.key;
        let idx = null;
        if (k === '1' || k === 'a' || k === 'A') idx = 0;
        else if (k === '2' || k === 's' || k === 'S') idx = 1;
        else if (k === '3' || k === 'd' || k === 'D') idx = 2;
        else if (k === 'ArrowLeft' || k === 'ArrowRight') {
          const cur = nearestOpening(this.myTargetX);
          idx = clamp(cur + (k === 'ArrowLeft' ? -1 : 1), 0, 2);
          if (this.canChoose()) e.preventDefault();
        }
        if (idx !== null && this.canChoose()) { this.unlockSound(); this.selectOpening(idx); }
      });

      // Drag on the scene to shuffle freely between openings (so you can
      // end up "between" two openings — the nearest one is then used).
      let drag = null;
      on(this.stageEl, 'pointerdown', (e) => {
        if (e.target !== this.canvas3d && e.target !== this.canvasFx) return;
        this.unlockSound();
        if (!this.canChoose()) return;
        drag = { id: e.pointerId, x: e.clientX };
      });
      on(this.stageEl, 'pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (!this.canChoose()) { drag = null; return; }
        const dx = e.clientX - drag.x;
        drag.x = e.clientX;
        this.myTargetX = clamp(this.myTargetX + dx * this.worldPerPixel(), X_MIN, X_MAX);
        this.updateChoiceUI();
        this.sendPos(false);
      });
      const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
      on(this.stageEl, 'pointerup', endDrag);
      on(this.stageEl, 'pointercancel', endDrag);

      on(document, 'visibilitychange', () => {
        if (!document.hidden) this.checkDeadline();
      });
    },

    // ---------------------------------------------------------------------
    // Sound (all Web Audio lives in games/assets/building_fall_sounds.js)
    // ---------------------------------------------------------------------

    loadSounds() {
      if (window.BuildingFallSounds || this._soundsLoading) return;
      this._soundsLoading = true;
      const s = document.createElement('script');
      s.src = SOUND_SCRIPT_SRC;
      s.onload = () => { this._soundsLoading = false; if (this.alive) this.updateMuteBtn(); };
      s.onerror = () => {
        this._soundsLoading = false;
        console.error('Building Fall: failed to load sound module at', SOUND_SCRIPT_SRC);
      };
      document.head.appendChild(s);
    },

    unlockSound() {
      if (window.BuildingFallSounds) window.BuildingFallSounds.unlock();
    },

    sound(name, ...args) {
      const S = window.BuildingFallSounds;
      if (S && typeof S[name] === 'function') S[name](...args);
    },

    updateMuteBtn() {
      const S = window.BuildingFallSounds;
      this.muteBtn.textContent = S && S.isMuted() ? '🔇' : '🔊';
    },

    // ---------------------------------------------------------------------
    // Configuration screen
    // ---------------------------------------------------------------------

    renderDifficultyOptions() {
      this.diffOptsEl.innerHTML = '';
      Object.keys(DIFFICULTIES).forEach((key) => {
        const d = DIFFICULTIES[key];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bf-opt bf-opt-wide' + (key === this.config.difficulty ? ' bf-on' : '');
        b.innerHTML = `${d.label}<small>${d.rule}</small>`;
        b.disabled = !this.api.isHost;
        b.addEventListener('click', () => {
          if (!this.api.isHost || this.phase !== 'config') return;
          this.unlockSound();
          this.config.difficulty = key;
          this.renderConfig();
          this.sendConfig();
        });
        this.diffOptsEl.appendChild(b);
      });
      this.rulesSplitEl.textContent = DIFFICULTIES[this.config.difficulty].rule;
    },

    renderTimerOptions() {
      this.timerOptsEl.innerHTML = '';
      TIMER_OPTIONS.forEach((sec) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bf-opt' + (sec === this.config.timer ? ' bf-on' : '');
        b.textContent = `${sec}s`;
        b.disabled = !this.api.isHost;
        b.addEventListener('click', () => {
          if (!this.api.isHost || this.phase !== 'config') return;
          this.unlockSound();
          this.config.timer = sec;
          this.renderTimerOptions();
          this.sendConfig();
        });
        this.timerOptsEl.appendChild(b);
      });
    },

    changeFloors(delta) {
      if (!this.api.isHost || this.phase !== 'config') return;
      this.config.floors = clamp(this.config.floors + delta, FLOORS_MIN, FLOORS_MAX);
      this.renderConfig();
      this.sendConfig();
      this.schedulePreview();
    },

    sendConfig() {
      if (this.api.isHost) this.api.send({ type: 'CONFIG', config: this.config });
    },

    renderConfig() {
      const host = this.api.isHost;
      this.floorsValEl.textContent = String(this.config.floors);
      this.floorsMinusBtn.disabled = !host || this.config.floors <= FLOORS_MIN;
      this.floorsPlusBtn.disabled = !host || this.config.floors >= FLOORS_MAX;
      this.renderTimerOptions();
      this.renderDifficultyOptions();

      if (host) {
        this.configSubEl.textContent = 'You pick the settings';
        this.startBtn.classList.remove('bf-hidden');
        const ready = this.peerReady && this.libsReady;
        this.startBtn.disabled = !ready;
        let note = '';
        if (!this.libsReady) note = 'Loading 3D…';
        else if (!this.peerPresent) note = `Waiting for ${this.partnerName()} to open Building Fall…`;
        else if (!this.peerReady) note = `${this.partnerName()} is still loading…`;
        else note = `${this.partnerName()} is ready.`;
        this.configNoteEl.textContent = note;
        this.configSpinnerEl.classList.toggle('bf-hidden', ready);
      } else {
        this.configSubEl.textContent = `${this.partnerName()} picks the settings`;
        this.startBtn.classList.add('bf-hidden');
        this.configNoteEl.textContent = this.peerPresent
          ? `Waiting for ${this.partnerName()} to start…`
          : `Waiting for ${this.partnerName()}…`;
        this.configSpinnerEl.classList.remove('bf-hidden');
      }
    },

    goToConfig() {
      this.phase = 'config';
      this.clearHostTimers();
      this.stopTick();
      this.round = -1;
      this.players = null;
      this.waitingRematch = false;
      this.resultEl.classList.add('bf-hidden');
      this.configEl.classList.remove('bf-hidden');
      this.hideToast();
      this.renderConfig();
      this.setChoiceEnabled(false);
      this.displayScore = { host: 0, guest: 0 };
      this.view = null;
      this.updateHud();
      this.updateStatus();
      this.updateChoiceUI();
      this.schedulePreview();
    },

    hostBackToConfig() {
      if (!this.api.isHost) return;
      this.api.send({ type: 'BACK_TO_CONFIG', gameNo: this.gameNo });
      this.goToConfig();
      this.sendConfig();
    },

    // ---------------------------------------------------------------------
    // Game start / rematch
    // ---------------------------------------------------------------------

    hostStartGame() {
      if (!this.api.isHost || !this.peerReady || !this.libsReady) return;
      if (this.phase !== 'config' && this.phase !== 'finished') return; // no double start
      const floors = this.config.floors;
      const diff = this.config.difficulty;
      this.layouts = { host: generateLayout(floors, diff), guest: generateLayout(floors, diff) };
      const msg = {
        type: 'GAME_STARTED',
        gameNo: this.gameNo + 1,
        config: { ...this.config },
        hostLayout: this.layouts.host,   // the guest is meant to see this one
        players: initialPlayers(floors),
      };
      this.api.send(msg);
      this.applyGameStarted(msg);
      this.hostLater(() => this.hostStartFloor(0), INTRO_MS);
    },

    onPlayAgain() {
      if (this.phase !== 'finished') return;
      if (this.api.isHost) {
        this.hostStartGame();
      } else if (!this.waitingRematch) {
        this.waitingRematch = true;
        this.againBtn.disabled = true;
        this.resultNoteEl.textContent = `Asked ${this.partnerName()} for a rematch…`;
        this.api.send({ type: 'REMATCH_REQUEST', gameNo: this.gameNo });
      }
    },

    applyGameStarted(msg) {
      if (msg.gameNo <= this.gameNo) return; // duplicate / stale start
      this.clearHostTimers(); // drop any timers left over from the previous game
      this.gameNo = msg.gameNo;
      this.config = { ...msg.config };
      this.round = -1;
      this.lastResolvedRound = -1;
      this.players = clone(msg.players);
      if (!this.api.isHost) {
        // Own layout stays unknown until each floor is revealed.
        this.layouts = { host: msg.hostLayout.slice(), guest: new Array(msg.config.floors + 1).fill(null) };
      }
      this.lastColumn = { host: 1, guest: 1 };
      this.displayScore = { host: 0, guest: 0 };
      this.view = {
        host: { level: msg.config.floors, status: 'active' },
        guest: { level: msg.config.floors, status: 'active' },
      };
      this.revealed = { host: new Set(), guest: new Set() };
      this.myFinal = null;
      this.waitingRematch = false;
      this.againBtn.disabled = false;
      this.resultNoteEl.textContent = '';

      // Start between two openings so "doing nothing" still has a
      // well-defined nearest opening.
      this.myTargetX = (Math.random() < 0.5 ? -1 : 1) * (0.62 + Math.random() * 0.3);

      this.phase = 'intro';
      this.stopTick();
      this.configEl.classList.add('bf-hidden');
      this.resultEl.classList.add('bf-hidden');
      this.setChoiceEnabled(false);
      this.sceneNewGame();
      this.updateHud();
      this.updateStatus();
      this.updateChoiceUI();
      this.showToast('', 'GET READY', '', 'Talk it through — or don\'t 😈', 1400);
    },

    // ---------------------------------------------------------------------
    // Floor timer
    // ---------------------------------------------------------------------

    hostStartFloor(round) {
      if (!this.api.isHost || this.phase === 'finished' || this.phase === 'config') return;
      const durationMs = this.config.timer * 1000;
      const msg = {
        type: 'FLOOR_STARTED',
        gameNo: this.gameNo,
        round,
        deadline: Date.now() + durationMs,
        durationMs,
      };
      this.pendingChoices = {};
      this.hostLocked = false;
      this.api.send(msg);
      this.applyFloorStarted(msg);
      // Safety net: resolve even if the guest's CHOICE never arrives.
      this.hostLater(() => { if (this.round === round) this.hostTryResolve(true); }, durationMs + CHOICE_WAIT_MS);
    },

    applyFloorStarted(msg) {
      if (msg.gameNo !== this.gameNo || msg.round <= this.round) return;
      if (this.phase === 'finished' || this.phase === 'config') return;
      this.round = msg.round;

      const now = Date.now();
      let deadline;
      if (this.api.isHost) deadline = msg.deadline;
      else if (this.clock.synced) deadline = msg.deadline - this.clock.offset;
      else deadline = now + msg.durationMs;
      if (deadline - now > msg.durationMs + 500) deadline = now + msg.durationMs; // bad clock estimate
      this.localDeadline = deadline;

      this.phase = 'choosing';
      this.myFinal = null;
      this.lastTickSec = null;
      if (!this.api.isHost) this.sendTimeReq();

      if (this.isActive(this.me)) {
        const c = this.three && this.three.chars[this.me];
        if (this.round > 0 && c) this.myTargetX = c.anim ? HOLE_X[c.anim.choice] : c.x;
      }
      if (this.round > 0) this.sound('playFloorTransition');
      this.oppTargetX = null;
      this._posLastX = null;

      this.setChoiceEnabled(this.canChoose());
      this.updateChoiceUI();
      this.updateStatus();
      this.refreshMarks();
      this.startTick();
      this.later(() => this.checkDeadline(), Math.max(0, deadline - now) + 10);
      if (this.isActive(this.me)) this.sendPos(true);
    },

    startTick() {
      this.stopTick();
      const tick = () => {
        this.tickHandle = null;
        if (!this.alive || this.phase !== 'choosing') return;
        const remMs = this.localDeadline - Date.now();
        const sec = Math.max(0, Math.ceil(remMs / 1000));
        if (sec !== this.lastTickSec) {
          if (this.lastTickSec !== null && sec > 0 && sec <= TICK_FROM_S) this.sound('playCountdownTick', sec <= 3);
          this.lastTickSec = sec;
        }
        this.updateHud();
        if (remMs <= 0) { this.onLocalDeadline(); return; }
        this.tickHandle = setTimeout(tick, Math.min(200, Math.max(20, remMs % 1000 || 200)));
      };
      tick();
    },

    stopTick() {
      if (this.tickHandle) clearTimeout(this.tickHandle);
      this.tickHandle = null;
    },

    checkDeadline() {
      if (this.phase === 'choosing' && Date.now() >= this.localDeadline) this.onLocalDeadline();
    },

    // The timer hit zero: stop accepting changes and lock the final opening.
    onLocalDeadline() {
      if (this.phase !== 'choosing') return;
      this.phase = 'locked';
      this.stopTick();
      this.setChoiceEnabled(false);

      if (this.isActive(this.me)) {
        const choice = nearestOpening(this.myTargetX);
        this.myFinal = choice;
        this.myTargetX = HOLE_X[choice]; // character visibly steps onto the chosen opening
        this.sendPos(true);
        if (this.api.isHost) this.pendingChoices.host = choice;
        else this.api.send({ type: 'CHOICE', gameNo: this.gameNo, round: this.round, choice });
      }
      if (this.api.isHost) {
        this.hostLocked = true;
        this.hostTryResolve(false);
      }
      this.updateHud();
      this.updateChoiceUI();
      this.updateStatus();
      this.refreshMarks();
    },

    // ---------------------------------------------------------------------
    // Player choice (local only — never sent until the timer ends)
    // ---------------------------------------------------------------------

    isActive(role) {
      return !!(this.players && this.players[role] && this.players[role].status === 'active');
    },

    canChoose() {
      return this.phase === 'choosing' && this.isActive(this.me);
    },

    selectOpening(idx) {
      if (!this.canChoose()) return;
      this.myTargetX = HOLE_X[idx];
      this.updateChoiceUI();
      this.sendPos(false);
    },

    // Live position so the partner sees where you're standing. Throttled;
    // the last position is always sent (trailing send).
    sendPos(force) {
      if (!this.players || this.round < 0) return;
      if (!force && !this.canChoose()) return;
      const x = Math.round(this.myTargetX * 100) / 100;
      if (!force && x === this._posLastX) return;
      const wait = POS_SEND_MS - (Date.now() - this._posLastSent);
      if (!force && wait > 0) {
        if (!this._posTimer) this._posTimer = this.later(() => { this._posTimer = null; this.sendPos(false); }, wait);
        return;
      }
      this._posLastSent = Date.now();
      this._posLastX = x;
      this.api.send({ type: 'POS', gameNo: this.gameNo, round: this.round, x });
    },

    onPos(msg) {
      if (msg.gameNo !== this.gameNo || msg.round !== this.round) return;
      if (this.phase !== 'choosing' && this.phase !== 'locked') return;
      const x = clamp(Number(msg.x) || 0, X_MIN, X_MAX);
      this.oppTargetX = x;
      if (this.api.isHost) this.lastColumn.guest = nearestOpening(x); // fallback if CHOICE is lost
    },

    setChoiceEnabled(on) {
      this.choiceBtns.forEach((b) => { b.disabled = !on; });
    },

    updateChoiceUI() {
      const inGame = this.phase !== 'config' && this.players;
      const active = inGame && this.isActive(this.me);
      this.choiceBtns.forEach((b, i) => {
        b.classList.remove('bf-selected', 'bf-nearest', 'bf-final');
      });
      if (!inGame) { this.choiceLabelEl.innerHTML = '&nbsp;'; return; }

      if (this.myFinal !== null && (this.phase === 'locked' || this.phase === 'resolving')) {
        this.choiceBtns[this.myFinal].classList.add('bf-final');
        this.choiceLabelEl.innerHTML = `Final: <b>${OPENINGS[this.myFinal]}</b>`;
        return;
      }
      if (!active || this.phase !== 'choosing') {
        this.choiceLabelEl.innerHTML = '&nbsp;';
        return;
      }
      const aligned = alignedOpening(this.myTargetX);
      if (aligned >= 0) {
        this.choiceBtns[aligned].classList.add('bf-selected');
        this.choiceLabelEl.innerHTML = `Selected: <b>${OPENINGS[aligned]}</b>`;
      } else {
        const n = nearestOpening(this.myTargetX);
        this.choiceBtns[n].classList.add('bf-nearest');
        this.choiceLabelEl.innerHTML = `Between openings → nearest: <b>${OPENINGS[n]}</b> (auto)`;
      }
    },

    // ---------------------------------------------------------------------
    // Jump resolution + scoring (host only)
    // ---------------------------------------------------------------------

    hostTryResolve(force) {
      if (!this.api.isHost || !this.players) return;
      if (this.phase === 'config' || this.phase === 'finished' || this.phase === 'intro') return;
      if (this.round < 0 || this.round <= this.lastResolvedRound) return;
      if (!this.hostLocked && !force) return;
      if (force && this.phase === 'choosing') {
        this.onLocalDeadline(); // host tab was throttled; this may already resolve
        if (this.round <= this.lastResolvedRound) return;
      }
      const need = activeRoles(this.players);
      const missing = need.filter((r) => this.pendingChoices[r] == null);
      if (missing.length && !force) return;
      // Missing choice (lost connection): the player stays in the column
      // they're standing in, i.e. the nearest opening to their position.
      missing.forEach((r) => { this.pendingChoices[r] = this.lastColumn[r]; });
      this.hostResolveFloor();
    },

    hostResolveFloor() {
      const round = this.round;
      const players = clone(this.players);
      const outcomes = {};
      activeRoles(players).forEach((r) => {
        const p = players[r];
        const fromLevel = p.level;
        const safeRow = this.layouts[r][fromLevel];
        const choice = clamp(Number(this.pendingChoices[r]) | 0, 0, 2);
        const safe = isSafe(safeRow, choice);
        const delta = safe ? SAFE_POINTS : FIRE_POINTS;
        const events = ['PLAYER_JUMPED', safe ? 'PLAYER_SAFE' : 'PLAYER_FIRE'];
        p.score += delta;
        p.level = fromLevel - 1;
        p.history.push({ level: fromLevel, choice, safe });
        // Fire costs points but never ends your game: you keep falling.
        if (p.level === 0) { p.status = 'bottom'; events.push('PLAYER_REACHED_BOTTOM'); }
        outcomes[r] = { choice, safeRow, safe, delta, fromLevel, events };
        this.lastColumn[r] = choice;
      });

      const msg = { type: 'FLOOR_RESOLVED', gameNo: this.gameNo, round, outcomes, players };
      this.api.send(msg);
      this.applyFloorResolved(msg);

      if (activeRoles(players).length === 0) this.hostLater(() => this.hostFinishGame(), RESULT_PAUSE_MS);
      else this.hostLater(() => this.hostStartFloor(round + 1), RESULT_PAUSE_MS);
    },

    applyFloorResolved(msg) {
      if (msg.gameNo !== this.gameNo || msg.round <= this.lastResolvedRound) return;
      if (this.phase === 'config' || this.phase === 'finished') return;
      this.lastResolvedRound = msg.round;
      if (this.phase === 'choosing') {
        // Our local timer was a hair behind the host's; the host's result wins.
        this.stopTick();
        this.setChoiceEnabled(false);
      }
      this.phase = 'resolving';
      this.players = clone(msg.players);

      Object.keys(msg.outcomes).forEach((role) => {
        const o = msg.outcomes[role];
        if (this.layouts[role]) this.layouts[role][o.fromLevel] = o.safeRow; // reveals the guest's own floor
        if (role === this.me) this.myFinal = o.choice;
        this.animateJump(role, o, msg.players[role]);
      });

      this.updateHud();
      this.updateChoiceUI();
      this.updateStatus();
    },

    // Runs the jump animation for one player, then applies its visible
    // consequences (reveal, score display, sound) at the moment of landing.
    animateJump(role, o, after) {
      const isMe = role === this.me;
      const onEnterHole = () => {
        if (!o.safe) this.sound('playFire');
        this.fxSparks(role, o.safe);
      };
      const onLand = () => {
        if (!this.alive || !this.view || this.phase === 'config') return;
        this.view[role] = { level: after.level, status: after.status };
        this.revealed[role].add(o.fromLevel);
        this.displayScore[role] = after.score;
        this.refreshMarks();
        this.updateHud();
        const text = o.safe ? `+${SAFE_POINTS}` : `${FIRE_POINTS}`;
        this.fxPopup(role, text, o.safe);
        if (isMe) {
          if (o.safe) {
            this.sound('playSafeLanding');
            this.later(() => this.sound('playScore'), 220);
            this.showToast('bf-safe', after.status === 'bottom' ? 'GROUND! 🏁' : 'SAFE JUMP!', text, `Score: ${after.score}`, 1500);
          } else {
            this.showToast('bf-fire', after.status === 'bottom' ? 'FIRE! 🔥 …but GROUND 🏁' : 'FIRE! 🔥', text,
              `Score: ${after.score}${after.status === 'bottom' ? '' : ' · keep going!'}`, 1700);
          }
        }
        this.updateStatus();
      };
      if (isMe) this.later(() => this.sound('playJump'), T_WALK * 1000);
      if (this.three) {
        this.startCharJump(role, o, onEnterHole, onLand);
      } else {
        this.later(onEnterHole, (T_WALK + T_HOP + 0.1) * 1000);
        this.later(onLand, (T_WALK + T_HOP + T_FALL) * 1000);
      }
    },

    hostFinishGame() {
      if (!this.api.isHost || this.phase === 'finished' || this.phase === 'config') return;
      const msg = {
        type: 'GAME_FINISHED',
        gameNo: this.gameNo,
        players: this.players,
        winner: winnerOf(this.players),
        layouts: this.layouts,   // full reveal for the guest
      };
      this.api.send(msg);
      this.applyGameFinished(msg);
    },

    // ---------------------------------------------------------------------
    // Result screen
    // ---------------------------------------------------------------------

    applyGameFinished(msg) {
      if (msg.gameNo !== this.gameNo || this.finishedGameNo >= msg.gameNo) return;
      if (this.phase === 'config') return;
      this.finishedGameNo = msg.gameNo;
      this.phase = 'finished';
      this.stopTick();
      this.setChoiceEnabled(false);
      this.players = clone(msg.players);
      this.layouts = clone(msg.layouts);
      ['host', 'guest'].forEach((r) => {
        this.displayScore[r] = this.players[r].score;
        if (this.view) this.view[r] = { level: this.players[r].level, status: this.players[r].status };
      });
      this.refreshMarks();
      this.updateHud();
      this.updateStatus();
      this.updateChoiceUI();
      this.later(() => this.showResult(msg.winner), 500);
    },

    showResult(winner) {
      if (this.phase !== 'finished') return;
      const me = this.players[this.me];
      const opp = this.players[this.opp];
      let verdict;
      if (winner === 'draw') { verdict = '🤝 DRAW'; this.sound('playDraw'); }
      else if (winner === this.me) { verdict = '🎉 YOU WIN'; this.sound('playWin'); this.fxConfetti(); }
      else { verdict = `${this.partnerName().toUpperCase()} WINS`; this.sound('playLose'); }
      this.resultVerdictEl.textContent = verdict;
      const d = DIFFICULTIES[this.config.difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY];
      this.resultModeEl.textContent = `${d.label} · ${this.config.floors} floors · ${this.config.timer}s per floor`;

      const statusText = (p) => {
        const fires = p.history.filter((h) => !h.safe).length;
        return `🏁 Reached the ground · ${fires} fire${fires === 1 ? '' : 's'}`;
      };
      const hist = (p) => p.history.map((h) => (h.safe ? '✅' : '🔥')).join('');
      this.resultMeScore.textContent = String(me.score);
      this.resultOppScore.textContent = String(opp.score);
      this.resultMeStatus.textContent = statusText(me);
      this.resultOppStatus.textContent = statusText(opp);
      this.resultMeHist.textContent = hist(me);
      this.resultOppHist.textContent = hist(opp);
      this.resultMeScore.style.color = ROLE_CSS[this.me];
      this.resultOppScore.style.color = ROLE_CSS[this.opp];
      this.resultMeBox.classList.toggle('bf-winner', winner === this.me);
      this.resultOppBox.classList.toggle('bf-winner', winner === this.opp);

      this.againBtn.disabled = false;
      this.configBtn.classList.toggle('bf-hidden', !this.api.isHost);
      this.resultNoteEl.textContent = this.api.isHost ? '' : `${this.partnerName()} can change the settings.`;
      this.resultEl.classList.remove('bf-hidden');
    },

    // ---------------------------------------------------------------------
    // HUD / status
    // ---------------------------------------------------------------------

    updateHud() {
      const inGame = this.phase !== 'config' && this.view;
      if (!inGame) {
        this.hudFloorEl.textContent = '–';
        this.hudTimeEl.textContent = '–';
      } else {
        const lv = this.view[this.me].level;
        this.hudFloorEl.textContent = lv > 0 ? `${lv} / ${this.config.floors}` : 'GROUND';
        if (this.phase === 'choosing') {
          const sec = Math.max(0, Math.ceil((this.localDeadline - Date.now()) / 1000));
          this.hudTimeEl.textContent = String(sec);
          this.hudTimeCell.classList.toggle('bf-low', sec <= 5);
        } else {
          this.hudTimeEl.textContent = this.phase === 'locked' || this.phase === 'resolving' ? '0' : '–';
          this.hudTimeCell.classList.remove('bf-low');
        }
      }
      if (this.phase === 'config') this.hudTimeCell.classList.remove('bf-low');
      this.hudMeEl.textContent = String(this.displayScore[this.me]);
      this.hudOppEl.textContent = String(this.displayScore[this.opp]);
    },

    updateStatus() {
      const pn = this.partnerName();
      let s = ' ';
      if (this.phase === 'config') s = this.api.isHost ? 'Choose the settings, then start' : `Waiting for ${pn} to start…`;
      else if (this.phase === 'intro') s = 'Get ready…';
      else if (this.phase === 'finished') s = 'Game over';
      else if (this.players) {
        // Use what the scene currently shows, so the text never spoils a
        // result before the fall animation lands.
        const meP = this.view ? this.view[this.me] : this.players[this.me];
        const oppActive = (this.view ? this.view[this.opp] : this.players[this.opp]).status === 'active';
        if (meP.status === 'bottom') s = oppActive ? `You made it down 🏁 — guide ${pn}!` : 'You made it down 🏁';
        else if (this.phase === 'choosing') s = oppActive ? `Pick an opening — ask ${pn} which one is safe` : `${pn} is out — you're on your own… or are you?`;
        else if (this.phase === 'locked') s = 'Time! Jumping…';
        else if (this.phase === 'resolving') s = 'Jump!';
      }
      this.statusEl.textContent = s;
    },

    showToast(cls, title, delta, sub, ms) {
      this.toastEl.className = 'bf-toast ' + (cls || '');
      this.toastTitleEl.textContent = title;
      this.toastDeltaEl.textContent = delta;
      this.toastDeltaEl.classList.toggle('bf-hidden', !delta);
      this.toastSubEl.textContent = sub || '';
      void this.toastEl.offsetWidth;
      this.toastEl.classList.add('bf-show');
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = this.later(() => this.hideToast(), ms || 1500);
    },

    hideToast() { this.toastEl.classList.remove('bf-show'); },

    // ---------------------------------------------------------------------
    // P2P synchronisation
    // ---------------------------------------------------------------------

    // HELLO doubles as "I'm here" and "my 3D libs are ready". fresh=true
    // means the module was just (re)opened, so any game in progress on the
    // other side can't continue and both sides go back to configuration.
    sendHello(fresh) {
      this.api.send({ type: 'HELLO', ready: this.libsReady, fresh: !!fresh, wantAck: true });
    },

    handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'HELLO': this.onHello(msg); break;
        case 'CONFIG':
          if (this.api.isHost || !msg.config) break;
          this.config = {
            floors: clamp(msg.config.floors | 0, FLOORS_MIN, FLOORS_MAX),
            timer: msg.config.timer,
            difficulty: DIFFICULTIES[msg.config.difficulty] ? msg.config.difficulty : DEFAULT_DIFFICULTY,
          };
          if (this.phase === 'config') { this.renderConfig(); this.schedulePreview(); }
          break;
        case 'GAME_STARTED': if (!this.api.isHost) this.applyGameStarted(msg); break;
        case 'FLOOR_STARTED': if (!this.api.isHost) this.applyFloorStarted(msg); break;
        case 'CHOICE':
          if (!this.api.isHost) break;
          if (msg.gameNo !== this.gameNo || msg.round !== this.round) break;  // stale / duplicate
          if (this.pendingChoices.guest != null || this.round <= this.lastResolvedRound) break;
          this.pendingChoices.guest = clamp(msg.choice | 0, 0, 2);
          this.hostTryResolve(false);
          break;
        case 'POS': this.onPos(msg); break;
        case 'FLOOR_RESOLVED': if (!this.api.isHost) this.applyFloorResolved(msg); break;
        case 'GAME_FINISHED': if (!this.api.isHost) this.applyGameFinished(msg); break;
        case 'REMATCH_REQUEST':
          if (this.api.isHost && this.phase === 'finished' && msg.gameNo === this.gameNo) this.hostStartGame();
          break;
        case 'BACK_TO_CONFIG':
          if (!this.api.isHost && msg.gameNo >= this.gameNo) this.goToConfig();
          break;
        case 'TIME_REQ':
          if (this.api.isHost) this.api.send({ type: 'TIME_RES', t0: msg.t0, th: Date.now() });
          break;
        case 'TIME_RES': this.onTimeRes(msg); break;
      }
    },

    onHello(msg) {
      this.peerPresent = true;
      this.peerReady = !!msg.ready;
      if (msg.fresh && this.phase !== 'config') this.goToConfig(); // partner re-opened the game
      if (msg.wantAck) this.api.send({ type: 'HELLO', ready: this.libsReady, fresh: false, wantAck: false });
      if (this.api.isHost) this.sendConfig();
      else if (!this.clock.synced) this.syncClock();
      this.applyTheme();
      if (this.phase === 'config') this.renderConfig();
    },

    // Guest only: estimate host clock − guest clock from a few round trips.
    syncClock() {
      for (let i = 0; i < 5; i++) this.later(() => this.sendTimeReq(), i * 150);
    },

    sendTimeReq() {
      if (!this.api.isHost) this.api.send({ type: 'TIME_REQ', t0: Date.now() });
    },

    onTimeRes(msg) {
      if (this.api.isHost) return;
      const t1 = Date.now();
      const rtt = t1 - msg.t0;
      if (rtt < 0 || rtt > 10000) return;
      this.clock.bestRtt *= 1.15; // slowly forget old samples
      if (rtt <= this.clock.bestRtt) {
        this.clock.bestRtt = rtt;
        this.clock.offset = msg.th - (msg.t0 + rtt / 2);
        this.clock.synced = true;
      }
    },

    // ---------------------------------------------------------------------
    // Library loading (Three.js + KAPLAY from jsDelivr, no build step)
    // ---------------------------------------------------------------------

    loadLibraries() {
      this.libsFailed = false;
      this.loadingEl.classList.remove('bf-hidden');
      this.loadingTextEl.textContent = 'Loading 3D…';
      const cache = window.__buildingFallLibs || (window.__buildingFallLibs = {});
      if (!cache.promise) {
        cache.promise = Promise.all([
          import(THREE_URL),
          import(KAPLAY_URL).catch((e) => { console.warn('Building Fall: KAPLAY unavailable, using rAF loop', e); return null; }),
        ]).then(([THREE, kap]) => ({ THREE, kaplay: kap ? (kap.default || kap.kaplay) : null }));
        cache.promise.catch(() => { cache.promise = null; });
      }
      cache.promise.then((libs) => {
        if (!this.alive) return;
        try {
          this.setupScene(libs);
        } catch (e) {
          console.error('Building Fall: scene setup failed', e);
          this.libsFailed = true;
          this.loadingTextEl.textContent = 'Couldn\'t start 3D graphics on this device. Tap to retry.';
          return;
        }
        this.libsReady = true;
        this.loadingEl.classList.add('bf-hidden');
        this.sendHello(false);
        if (this.phase === 'config') { this.renderConfig(); this.schedulePreview(); }
        else this.sceneNewGame();
      }).catch((e) => {
        if (!this.alive) return;
        console.error('Building Fall: failed to load libraries', e);
        this.libsFailed = true;
        this.loadingTextEl.textContent = 'Couldn\'t load the 3D engine. Check your connection and tap to retry.';
      });
    },

    // ---------------------------------------------------------------------
    // Three.js scene
    // ---------------------------------------------------------------------

    setupScene(libs) {
      const THREE = libs.THREE;
      const renderer = new THREE.WebGLRenderer({
        canvas: this.canvas3d, antialias: true, alpha: true, powerPreference: 'low-power',
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);

      const scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0xd8e4ff, 40, 90);
      const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.1, 200);

      scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7fa0, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(6, 14, 10);
      scene.add(sun);

      const street = new THREE.Mesh(
        new THREE.PlaneGeometry(80, 50),
        new THREE.MeshLambertMaterial({ color: 0x9aa3b8 })
      );
      street.rotation.x = -Math.PI / 2;
      street.position.y = -0.02;
      scene.add(street);

      const t = {
        THREE, renderer, scene, camera,
        buildingGroup: null, marksGroup: new THREE.Group(),
        flames: [], bobbers: [], texCache: new Map(), matCache: new Map(),
        camY: null, camDist: 20, time: 0, width: 1, height: 1,
      };
      scene.add(t.marksGroup);
      this.three = t;
      this.buildSharedAssets();
      t.chars = { host: this.makeCharacter('host'), guest: this.makeCharacter('guest') };
      scene.add(t.chars.host.group, t.chars.guest.group);
      t.thinking = this.makeSprite('think', '💭', { size: 0.8 });
      scene.add(t.thinking);

      // Resize with the stage
      const resize = () => {
        const w = Math.max(1, this.stageEl.clientWidth);
        const h = Math.max(1, this.stageEl.clientHeight);
        t.width = w; t.height = h;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        this.fitCamera();
      };
      resize();
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(resize);
        ro.observe(this.stageEl);
        this.cleanups.push(() => ro.disconnect());
      } else {
        window.addEventListener('resize', resize);
        this.cleanups.push(() => window.removeEventListener('resize', resize));
      }

      this.startLoop(libs.kaplay);
    },

    buildSharedAssets() {
      const { THREE } = this.three;
      const s = {};

      // Floor slab with three square openings. Shape is drawn in X/Y and
      // rotated flat, so shape-Y becomes world −Z.
      const shape = new THREE.Shape();
      shape.moveTo(-BLD_W / 2, -BLD_D / 2);
      shape.lineTo(BLD_W / 2, -BLD_D / 2);
      shape.lineTo(BLD_W / 2, BLD_D / 2);
      shape.lineTo(-BLD_W / 2, BLD_D / 2);
      shape.closePath();
      HOLE_X.forEach((x) => {
        const h = HOLE / 2;
        const y = -HOLE_Z;
        const p = new THREE.Path();
        p.moveTo(x - h, y - h); p.lineTo(x - h, y + h); p.lineTo(x + h, y + h); p.lineTo(x + h, y - h);
        p.closePath();
        shape.holes.push(p);
      });
      s.slabGeo = new THREE.ExtrudeGeometry(shape, { depth: SLAB_T, bevelEnabled: false });
      s.slabGeo.rotateX(-Math.PI / 2);
      s.groundGeo = new THREE.BoxGeometry(BLD_W, SLAB_T, BLD_D);
      s.groundGeo.translate(0, SLAB_T / 2, 0);

      // Square frame drawn around an opening + a translucent fill inside it.
      const fo = HOLE / 2 + 0.13;
      const fi = HOLE / 2;
      const frame = new THREE.Shape();
      frame.moveTo(-fo, -fo); frame.lineTo(fo, -fo); frame.lineTo(fo, fo); frame.lineTo(-fo, fo); frame.closePath();
      const fh = new THREE.Path();
      fh.moveTo(-fi, -fi); fh.lineTo(-fi, fi); fh.lineTo(fi, fi); fh.lineTo(fi, -fi); fh.closePath();
      frame.holes.push(fh);
      s.frameGeo = new THREE.ShapeGeometry(frame);
      s.frameGeo.rotateX(-Math.PI / 2);
      s.fillGeo = new THREE.PlaneGeometry(HOLE, HOLE);
      s.fillGeo.rotateX(-Math.PI / 2);

      const basic = (color, opacity) => new THREE.MeshBasicMaterial({
        color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: THREE.DoubleSide,
      });
      s.mat = {
        slab: { host: new THREE.MeshLambertMaterial({ color: BLD_TINT.host }), guest: new THREE.MeshLambertMaterial({ color: BLD_TINT.guest }) },
        frameUnknown: basic(0x7a6fd6, 1),
        frameSafe: basic(0x2fbf71, 1),
        frameFire: basic(0xff5a2a, 1),
        frameSafeDim: basic(0x2fbf71, 0.55),
        frameFireDim: basic(0xff5a2a, 0.55),
        fillUnknown: basic(0x1b1640, 0.45),
        fillSafe: basic(0x2fbf71, 0.35),
        fillFire: basic(0xff4a1a, 0.4),
        flameOuter: basic(0xff5a1f, 0.9),
        flameMid: basic(0xffa62b, 0.92),
        flameCore: basic(0xffe36e, 0.95),
        pole: new THREE.MeshLambertMaterial({ color: 0x777777 }),
        flag: { host: new THREE.MeshLambertMaterial({ color: ROLE_COLOR.host }), guest: new THREE.MeshLambertMaterial({ color: ROLE_COLOR.guest }) },
      };
      s.flameGeo = new THREE.ConeGeometry(0.3, 1, 7);
      s.flameGeo.translate(0, 0.5, 0);
      this.three.shared = s;
    },

    // Canvas-text textures (numbers, "?", "SAFE", L/C/R…), cached per key.
    textTexture(key, text, opts) {
      const t = this.three;
      if (t.texCache.has(key)) return t.texCache.get(key);
      const { THREE } = t;
      const o = opts || {};
      const w = o.w || 128;
      const h = o.h || 128;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      if (o.bg) {
        g.fillStyle = o.bg;
        g.beginPath();
        if (g.roundRect) g.roundRect(4, 4, w - 8, h - 8, Math.min(w, h) / 2 - 4);
        else g.rect(4, 4, w - 8, h - 8);
        g.fill();
      }
      g.fillStyle = o.color || '#fff';
      g.font = `900 ${o.font || 80}px -apple-system, "Segoe UI", Roboto, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + (o.dy || 4));
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      t.texCache.set(key, tex);
      return tex;
    },

    makeSprite(key, text, opts) {
      const t = this.three;
      const { THREE } = t;
      const o = opts || {};
      let mat = t.matCache.get(key);
      if (!mat) {
        mat = new THREE.SpriteMaterial({ map: this.textTexture(key, text, o), transparent: true, depthWrite: false });
        t.matCache.set(key, mat);
      }
      const sp = new THREE.Sprite(mat);
      const size = o.size || 0.6;
      sp.scale.set(size * ((o.w || 128) / (o.h || 128)), size, 1);
      return sp;
    },

    roleX(role) { return role === this.me ? -BLD_CX : BLD_CX; },
    surfaceY(level) { return level * FLOOR_H + SLAB_T; },

    buildBuildings(floors) {
      const t = this.three;
      if (!t) return;
      const { THREE } = t;
      const s = t.shared;
      if (t.buildingGroup) {
        t.scene.remove(t.buildingGroup);
        t.buildingGroup.userData.dispose.forEach((d) => d.dispose());
      }
      const group = new THREE.Group();
      const disposables = [];
      group.userData.dispose = disposables;
      const height = floors * FLOOR_H + SLAB_T;

      // Window-pattern texture for the back walls (repeats once per floor).
      const wc = document.createElement('canvas');
      wc.width = 64; wc.height = 64;
      const g = wc.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#9fb4d8'; g.fillRect(14, 16, 14, 26); g.fillRect(36, 16, 14, 26);
      g.fillStyle = '#d6d6e0'; g.fillRect(0, 58, 64, 6);
      const wallTex = new THREE.CanvasTexture(wc);
      wallTex.colorSpace = THREE.SRGBColorSpace;
      wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
      wallTex.repeat.set(3, floors);
      disposables.push(wallTex);

      ['host', 'guest'].forEach((role) => {
        const b = new THREE.Group();
        b.position.x = this.roleX(role);

        for (let level = 0; level <= floors; level++) {
          const slab = new THREE.Mesh(level === 0 ? s.groundGeo : s.slabGeo, s.mat.slab[role]);
          slab.position.y = level * FLOOR_H;
          b.add(slab);
          const num = this.makeSprite(`num-${level}`, level === 0 ? 'G' : String(level), {
            bg: 'rgba(40,40,70,0.75)', color: '#fff', font: level >= 10 ? 60 : 72, size: 0.55,
          });
          num.position.set(-BLD_W / 2 + 0.35, level * FLOOR_H + SLAB_T + 0.3, BLD_D / 2 - 0.3);
          b.add(num);
        }

        const wallMat = new THREE.MeshLambertMaterial({ color: WALL_TINT[role], map: wallTex });
        const sideMat = new THREE.MeshLambertMaterial({ color: WALL_TINT[role] });
        disposables.push(wallMat, sideMat);
        const backGeo = new THREE.BoxGeometry(BLD_W, height, 0.2);
        const sideGeo = new THREE.BoxGeometry(0.22, height, BLD_D + 0.2);
        disposables.push(backGeo, sideGeo);
        const back = new THREE.Mesh(backGeo, wallMat);
        back.position.set(0, height / 2, -BLD_D / 2 - 0.1);
        b.add(back);
        [-1, 1].forEach((sgn) => {
          const side = new THREE.Mesh(sideGeo, sideMat);
          side.position.set(sgn * (BLD_W / 2 + 0.11), height / 2, 0);
          b.add(side);
        });

        // Roof flag in the player's colour.
        const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6);
        const flagGeo = new THREE.BoxGeometry(0.7, 0.4, 0.04);
        disposables.push(poleGeo, flagGeo);
        const pole = new THREE.Mesh(poleGeo, s.mat.pole);
        pole.position.set(BLD_W / 2 - 0.3, height + 0.8, -BLD_D / 2 + 0.3);
        const flag = new THREE.Mesh(flagGeo, s.mat.flag[role]);
        flag.position.set(BLD_W / 2 - 0.3 - 0.37, height + 1.35, -BLD_D / 2 + 0.3);
        b.add(pole, flag);

        group.add(b);
      });
      t.scene.add(group);
      t.buildingGroup = group;
      t.floors = floors;
    },

    // ---- Openings / fire markers ------------------------------------------

    addOpeningMark(role, level, idx, kind, dim) {
      const t = this.three;
      const { THREE } = t;
      const s = t.shared;
      const x = this.roleX(role) + HOLE_X[idx];
      const y = this.surfaceY(level);
      const frameMat = kind === 'unknown' ? s.mat.frameUnknown
        : kind === 'safe' ? (dim ? s.mat.frameSafeDim : s.mat.frameSafe)
          : (dim ? s.mat.frameFireDim : s.mat.frameFire);
      const frame = new THREE.Mesh(s.frameGeo, frameMat);
      frame.position.set(x, y + 0.015, HOLE_Z);
      t.marksGroup.add(frame);
      if (!dim) {
        const fillMat = kind === 'unknown' ? s.mat.fillUnknown : kind === 'safe' ? s.mat.fillSafe : s.mat.fillFire;
        const fill = new THREE.Mesh(s.fillGeo, fillMat);
        fill.position.set(x, y - 0.02, HOLE_Z);
        t.marksGroup.add(fill);
      }
    },

    addFlames(role, level, idx, scale) {
      const t = this.three;
      const { THREE } = t;
      const s = t.shared;
      const g = new THREE.Group();
      g.position.set(this.roleX(role) + HOLE_X[idx], this.surfaceY(level) - 0.35, HOLE_Z);
      const parts = [
        [s.mat.flameOuter, -0.22, 0.05, 1.0],
        [s.mat.flameOuter, 0.22, -0.05, 0.9],
        [s.mat.flameMid, 0.02, 0.12, 0.75],
        [s.mat.flameCore, -0.05, 0.2, 0.5],
      ];
      parts.forEach(([mat, dx, dz, sc]) => {
        const m = new THREE.Mesh(s.flameGeo, mat);
        m.position.set(dx, 0, dz);
        m.scale.set(sc, sc * 1.25, sc);
        m.userData.base = sc;
        g.add(m);
      });
      g.scale.setScalar(scale);
      t.marksGroup.add(g);
      const f = { group: g, phase: Math.random() * 10, flare: 0, role, level, idx };
      t.flames.push(f);
      return f;
    },

    addLabel(role, level, idx, key, text, opts, bob) {
      const t = this.three;
      const sp = this.makeSprite(key, text, opts);
      const baseY = this.surfaceY(level) + (opts.lift || 0.55);
      sp.position.set(this.roleX(role) + HOLE_X[idx], baseY, opts.z != null ? opts.z : HOLE_Z);
      t.marksGroup.add(sp);
      if (bob) t.bobbers.push({ sp, baseY, phase: idx * 1.3 });
    },

    // Rebuilds every opening marker from game state. Rules:
    //  - partner's building: their current floor shows SAFE / FIRE (+ flames)
    //  - your building: current floor shows only "?"
    //  - floors already jumped through (either building) show dim safe/fire
    //    frames; the fire you (or they) fell into keeps burning
    //  - after GAME_FINISHED everything is revealed
    refreshMarks() {
      const t = this.three;
      if (!t) return;
      while (t.marksGroup.children.length) t.marksGroup.remove(t.marksGroup.children[0]);
      t.flames = [];
      t.bobbers = [];
      if (!this.view || !this.players || this.phase === 'config') return;
      const finished = this.phase === 'finished';

      ['host', 'guest'].forEach((role) => {
        const layout = this.layouts[role] || [];
        const v = this.view[role];
        const drawn = new Set();
        const fireJumps = (this.players[role].history || []).filter((h) => !h.safe);

        // Past floors (revealed at landing) — and everything once finished.
        for (let level = 1; level <= this.config.floors; level++) {
          const revealed = this.revealed[role].has(level) || (finished && layout[level] != null);
          if (!revealed || layout[level] == null) continue;
          if (!finished && level === v.level && v.status === 'active') continue;
          drawn.add(level);
          for (let i = 0; i < 3; i++) this.addOpeningMark(role, level, i, isSafe(layout[level], i) ? 'safe' : 'fire', true);
          const fj = fireJumps.find((h) => h.level === level);
          if (fj && this.revealed[role].has(level)) this.addFlames(role, level, fj.choice, 0.6); // the fire they fell through
        }

        // Current floor.
        if (!finished && v.status === 'active' && v.level > 0 && !drawn.has(v.level)) {
          const level = v.level;
          if (role === this.me) {
            for (let i = 0; i < 3; i++) {
              this.addOpeningMark(role, level, i, 'unknown', false);
              this.addLabel(role, level, i, 'q', '?', { bg: '#7a6fd6', color: '#fff', size: 0.5, lift: 0.6 }, true);
            }
          } else if (layout[level] != null) {
            for (let i = 0; i < 3; i++) {
              const safe = isSafe(layout[level], i);
              this.addOpeningMark(role, level, i, safe ? 'safe' : 'fire', false);
              if (safe) this.addLabel(role, level, i, 'safe', 'SAFE', { bg: '#2fbf71', color: '#fff', w: 192, h: 96, font: 52, size: 0.42, lift: 0.5 }, true);
              else this.addFlames(role, level, i, 1);
            }
          }
          ['L', 'C', 'R'].forEach((letter, i) => {
            this.addLabel(role, level, i, `lbl-${letter}`, letter, { color: '#3b3560', font: 88, size: 0.42, lift: 0.18, z: BLD_D / 2 - 0.22 }, false);
          });
        }
      });
    },

    // ---- Characters ---------------------------------------------------------

    makeCharacter(role) {
      const { THREE } = this.three;
      const group = new THREE.Group();
      const mats = [];
      const mk = (color) => { const m = new THREE.MeshLambertMaterial({ color }); m.userData.orig = color; mats.push(m); return m; };
      const bodyMat = mk(ROLE_COLOR[role]);
      const headMat = mk(0xefe4d6);        // stylised, neutral "toy" tone
      const pantsMat = mk(0x3d4454);
      const eyeMat = mk(0x222222);
      const accMat = mk(role === 'host' ? 0xffd23f : 0x2ec4b6);
      const geos = [];
      const G = (geo) => { geos.push(geo); return geo; };

      const body = new THREE.Mesh(G(new THREE.CapsuleGeometry(0.25, 0.4, 4, 10)), bodyMat);
      body.position.y = 0.95;
      const head = new THREE.Mesh(G(new THREE.SphereGeometry(0.24, 16, 12)), headMat);
      head.position.y = 1.52;
      const eyeGeo = G(new THREE.SphereGeometry(0.035, 8, 6));
      [-0.08, 0.08].forEach((ex) => {
        const e = new THREE.Mesh(eyeGeo, eyeMat);
        e.position.set(ex, 1.55, 0.215);
        group.add(e);
      });
      group.add(body, head);

      const limb = (r, len, mat, px, py) => {
        const pivot = new THREE.Group();
        pivot.position.set(px, py, 0);
        const m = new THREE.Mesh(G(new THREE.CapsuleGeometry(r, len, 3, 8)), mat);
        m.position.y = -(len / 2 + r);
        pivot.add(m);
        group.add(pivot);
        return pivot;
      };
      const legs = [limb(0.09, 0.34, pantsMat, -0.11, 0.62), limb(0.09, 0.34, pantsMat, 0.11, 0.62)];
      const arms = [limb(0.07, 0.32, bodyMat, -0.33, 1.2), limb(0.07, 0.32, bodyMat, 0.33, 1.2)];

      // Distinguishing accessory (not gendered): cap vs. scarf.
      if (role === 'host') {
        const cap = new THREE.Mesh(G(new THREE.SphereGeometry(0.255, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), accMat);
        cap.position.y = 1.56;
        const brim = new THREE.Mesh(G(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 16, 1, false, -Math.PI / 2, Math.PI)), accMat);
        brim.position.set(0, 1.58, 0.12);
        group.add(cap, brim);
      } else {
        const scarf = new THREE.Mesh(G(new THREE.TorusGeometry(0.2, 0.07, 8, 18)), accMat);
        scarf.rotation.x = Math.PI / 2;
        scarf.position.y = 1.3;
        const tail = new THREE.Mesh(G(new THREE.BoxGeometry(0.12, 0.3, 0.05)), accMat);
        tail.position.set(0.12, 1.12, 0.22);
        group.add(scarf, tail);
      }

      const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
      mats.push(shadowMat);
      const shadow = new THREE.Mesh(G(new THREE.CircleGeometry(0.34, 16)), shadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.02;
      group.add(shadow);

      // Flames that wrap the character for a moment after a fire jump.
      const s = this.three.shared;
      const burn = new THREE.Group();
      [[s.mat.flameOuter, -0.18, 1.0], [s.mat.flameOuter, 0.2, 0.9], [s.mat.flameMid, 0, 0.8], [s.mat.flameCore, 0.05, 0.55]]
        .forEach(([mat, dx, sc]) => {
          const m = new THREE.Mesh(s.flameGeo, mat);
          m.position.set(dx, 0.1, 0.12);
          m.userData.base = sc;
          burn.add(m);
        });
      burn.visible = false;
      group.add(burn);

      return { role, group, legs, arms, mats, geos, shadow, burn, burnT: 0, fires: 0, x: 0, y: 0, z: CHAR_Z, anim: null, walk: 0, squash: 0 };
    },

    resetCharacter(c, x, level) {
      c.x = x; c.y = this.surfaceY(level); c.z = CHAR_Z;
      c.anim = null; c.squash = 0; c.burnT = 0; c.burn.visible = false;
      c.group.rotation.set(0, 0, 0);
      c.shadow.visible = true;
      this.setCharDarkness(c, 0);
    },

    // Darkness grows with each fire jump: fires / floors, so a character
    // that fell into fire on every floor ends up darkest.
    setCharDarkness(c, fires) {
      c.fires = fires;
      const k = this.config.floors > 0 ? MAX_DARKNESS * Math.min(1, fires / this.config.floors) : 0;
      const { THREE } = this.three;
      const dark = new THREE.Color(0x140c0a);
      c.mats.forEach((m) => {
        if (m.userData.orig == null) return;
        m.color.setHex(m.userData.orig).lerp(dark, k);
      });
    },

    charTargetX(c) {
      if (c.role === this.me && this.canChoose()) return this.myTargetX;
      if (c.role === this.me && this.phase === 'locked' && this.myFinal !== null) return HOLE_X[this.myFinal];
      if (c.role === this.opp && (this.phase === 'choosing' || this.phase === 'locked') && this.oppTargetX !== null) {
        return this.oppTargetX; // partner's live position
      }
      return c.x;
    },

    startCharJump(role, o, onEnterHole, onLand) {
      const c = this.three.chars[role];
      c.anim = {
        t: 0, choice: o.choice, safe: o.safe,
        x0: c.x, x1: HOLE_X[o.choice],
        y0: this.surfaceY(o.fromLevel), y1: this.surfaceY(o.fromLevel - 1),
        fromLevel: o.fromLevel,
        entered: false, landed: false, onEnterHole, onLand,
      };
    },

    updateCharacter(c, dt) {
      const t = this.three;
      const a = c.anim;
      let moving = false;
      c.group.scale.set(1, 1, 1);
      if (a) {
        a.t += dt;
        const tt = a.t;
        if (tt < T_WALK) {
          c.x = lerp(a.x0, a.x1, easeInOut(tt / T_WALK));
          c.y = a.y0; c.z = CHAR_Z; moving = true;
        } else if (tt < T_WALK + T_HOP) {
          const u = (tt - T_WALK) / T_HOP;
          c.x = a.x1;
          c.z = lerp(CHAR_Z, HOLE_Z, u);
          c.y = a.y0 + 0.9 * (1 - (1 - u) * (1 - u));
          c.arms.forEach((arm) => { arm.rotation.z = 0; arm.rotation.x = -2.6 * u; });
          c.shadow.visible = false;
        } else if (tt < T_WALK + T_HOP + T_FALL) {
          const u = (tt - T_WALK - T_HOP) / T_FALL;
          c.x = a.x1;
          c.y = lerp(a.y0 + 0.9, a.y1, u * u);
          c.z = lerp(HOLE_Z, CHAR_Z, u);
          if (!a.entered && c.y < a.y0 - 0.2) {
            a.entered = true;
            if (!a.safe) {
              c.burnT = 2.6; // on fire for a moment…
              this.setCharDarkness(c, c.fires + 1); // …and a little darker for good
              t.flames.forEach((f) => {
                if (f.role === c.role && f.level === a.fromLevel && f.idx === a.choice) f.flare = 1.4;
              });
              // our own building had no flames yet (it was hidden): add one to flare
              if (!t.flames.some((f) => f.role === c.role && f.level === a.fromLevel && f.idx === a.choice)) {
                const f = this.addFlames(c.role, a.fromLevel, a.choice, 1);
                f.flare = 1.4;
              }
            }
            a.onEnterHole && a.onEnterHole();
          }
        } else {
          const u = Math.min(1, (tt - T_WALK - T_HOP - T_FALL) / T_LAND);
          c.x = a.x1; c.y = a.y1; c.z = CHAR_Z;
          c.shadow.visible = true;
          if (!a.landed) { a.landed = true; c.squash = 1; a.onLand && a.onLand(); }
          c.arms.forEach((arm) => { arm.rotation.x = lerp(arm.rotation.x, 0, u); });
          if (u >= 1) c.anim = null;
        }
      } else {
        const tx = this.charTargetX(c);
        const d = tx - c.x;
        if (Math.abs(d) > 0.01) {
          c.x += Math.sign(d) * Math.min(Math.abs(d), 5.5 * dt);
          moving = true;
        } else c.x = tx;
      }

      // Pose
      if (moving) c.walk += dt * 14; else c.walk *= 0.8;
      const swing = moving ? Math.sin(c.walk) * 0.7 : 0;
      c.legs[0].rotation.x = swing; c.legs[1].rotation.x = -swing;
      if (!a || a.t < T_WALK || a.landed) {
        c.arms[0].rotation.x = -swing * 0.8; c.arms[1].rotation.x = swing * 0.8;
      }
      if (c.squash > 0) {
        c.squash = Math.max(0, c.squash - dt * 4);
        const sq = Math.sin(c.squash * Math.PI) * 0.25;
        c.group.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);
      }
      const bob = !a && !moving ? Math.sin(t.time * 2.2 + (c.role === 'host' ? 0 : 1.7)) * 0.02 : 0;
      c.group.position.set(this.roleX(c.role) + c.x, c.y + bob, c.z);

      // Burning: flames flicker around the body, then die down.
      if (c.burnT > 0) {
        c.burnT = Math.max(0, c.burnT - dt);
        const life = Math.min(1, c.burnT / 0.6);
        c.burn.visible = c.burnT > 0;
        c.burn.children.forEach((m, i) => {
          const b = m.userData.base * life;
          m.scale.set(b, b * 1.6 * (1 + 0.3 * Math.sin(t.time * 13 + i * 2.1)), b);
        });
        if (!a && !moving) c.group.position.x += Math.sin(t.time * 40) * 0.02 * life; // shiver
      }
      c.group.rotation.y = moving && !a ? Math.sign(this.charTargetX(c) - c.x) * 0.5 : lerp(c.group.rotation.y, 0, Math.min(1, dt * 8));
    },

    sceneNewGame() {
      const t = this.three;
      if (!t) return;
      const F = this.config.floors;
      this.buildBuildings(F);
      this.resetCharacter(t.chars[this.me], this.myTargetX, F);
      this.resetCharacter(t.chars[this.opp], 0, F);
      if (this.view) {
        // Late library load mid-game: jump straight to the current state.
        ['host', 'guest'].forEach((r) => {
          const c = t.chars[r];
          c.y = this.surfaceY(this.view[r].level);
          const last = this.players && this.players[r].history.slice(-1)[0];
          if (last) c.x = HOLE_X[last.choice];
          this.setCharDarkness(c, this.players ? this.players[r].history.filter((h) => !h.safe).length : 0);
        });
        if (this.isActive(this.me)) this.myTargetX = t.chars[this.me].x;
      }
      t.camY = null;
      this.refreshMarks();
    },

    // Config screen: show the buildings for the chosen floor count.
    schedulePreview() {
      if (this._previewTimer) clearTimeout(this._previewTimer);
      this._previewTimer = this.later(() => {
        if (!this.three || this.phase !== 'config') return;
        const F = this.config.floors;
        this.buildBuildings(F);
        this.resetCharacter(this.three.chars[this.me], -0.8, F);
        this.resetCharacter(this.three.chars[this.opp], 0.8, F);
        this.refreshMarks();
        this.three.camY = null;
      }, 120);
    },

    // ---- Camera --------------------------------------------------------------

    fitCamera() {
      const t = this.three;
      const aspect = t.width / t.height;
      const vHalf = (CAM_FOV / 2) * Math.PI / 180;
      const hHalf = Math.atan(Math.tan(vHalf) * aspect);
      const halfW = BLD_CX + BLD_W / 2 + 0.45;
      const halfH = 3.6;
      t.camDist = Math.max(halfW / Math.tan(hHalf), halfH / Math.tan(vHalf)) + 1.5;
      t.hHalf = hHalf;
    },

    worldPerPixel() {
      const t = this.three;
      if (!t) return 0.02;
      return (2 * t.camDist * Math.tan(t.hHalf)) / t.width;
    },

    focusY() {
      const t = this.three;
      const pick = (r) => this.view && (this.view[r].status === 'active' || t.chars[r].anim);
      let role = this.me;
      if (this.view && !pick(this.me) && pick(this.opp)) role = this.opp;
      if (!this.view) return this.surfaceY(this.config.floors);
      return t.chars[role].y;
    },

    updateCamera(dt) {
      const t = this.three;
      const target = this.focusY();
      if (t.camY === null) t.camY = target;
      t.camY = lerp(t.camY, target, 1 - Math.exp(-dt * 4.5));
      const d = t.camDist;
      t.camera.position.set(0, t.camY + d * Math.sin(CAM_PITCH) + 0.4, d * Math.cos(CAM_PITCH));
      t.camera.lookAt(0, t.camY + 0.5, 0); // keeps the current floor below the HUD
    },

    // ---- Frame loop (KAPLAY onUpdate, or requestAnimationFrame fallback) --

    startLoop(kaplayFn) {
      const frame = (dt) => {
        if (!this.alive || !this.three) return;
        this.renderFrame(Math.min(0.05, Math.max(0, dt)));
      };
      if (kaplayFn) {
        try {
          const k = kaplayFn({
            canvas: this.canvasFx,
            root: this.stageEl, // without this KAPLAY restyles <body>/<html>
            background: [0, 0, 0, 0],
            global: false,
            debug: false,
            focus: false,
            touchToMouse: false,
            loadingScreen: false,
            burp: false,
            maxFPS: 60,
            pixelDensity: Math.min(window.devicePixelRatio || 1, 2),
            font: 'sans-serif',
          });
          // KAPLAY creates its own AudioContext; this game never uses it
          // (all sound is in building_fall_sounds.js), so keep it
          // suspended to avoid holding the audio output open.
          try {
            if (k.audioCtx) {
              k.audioCtx.suspend().catch(() => {});
              k.audioCtx.resume = () => Promise.resolve();
            }
          } catch (e) { /* ignore */ }
          k.onUpdate(() => frame(k.dt()));
          this.k = k;
          return;
        } catch (e) {
          console.warn('Building Fall: KAPLAY init failed, using rAF loop', e);
          this.k = null;
        }
      }
      let last = performance.now();
      const raf = (now) => {
        if (!this.alive) return;
        frame((now - last) / 1000);
        last = now;
        this._raf = requestAnimationFrame(raf);
      };
      this._raf = requestAnimationFrame(raf);
    },

    renderFrame(dt) {
      const t = this.three;
      t.time += dt;
      this.updateCharacter(t.chars.host, dt);
      this.updateCharacter(t.chars.guest, dt);

      t.flames.forEach((f) => {
        f.flare = Math.max(0, f.flare - dt * 1.6);
        const k = 1 + f.flare;
        f.group.children.forEach((m, i) => {
          const b = m.userData.base;
          m.scale.y = b * 1.25 * k * (1 + 0.22 * Math.sin(t.time * 11 + f.phase + i * 1.9));
          m.scale.x = m.scale.z = b * (0.9 + f.flare * 0.4 + 0.08 * Math.sin(t.time * 7 + i));
        });
      });
      t.bobbers.forEach((b) => { b.sp.position.y = b.baseY + Math.sin(t.time * 2.5 + b.phase) * 0.08; });

      const opp = t.chars[this.opp];
      t.thinking.visible = this.phase === 'choosing' && this.isActive(this.opp);
      t.thinking.position.set(opp.group.position.x + 0.45, opp.y + 2.1 + Math.sin(t.time * 2) * 0.05, opp.z);

      this.updateCamera(dt);
      t.renderer.render(t.scene, t.camera);
    },

    // ---- KAPLAY 2D overlay effects -------------------------------------------

    toScreen(role, dy) {
      const t = this.three;
      const k = this.k;
      if (!t || !k) return null;
      const c = t.chars[role];
      const v = new t.THREE.Vector3(c.group.position.x, c.y + (dy || 2), c.z);
      v.project(t.camera);
      if (v.z > 1) return null;
      return { x: (v.x + 1) / 2 * k.width(), y: (1 - v.y) / 2 * k.height() };
    },

    fxPopup(role, text, safe) {
      const k = this.k;
      const p = this.toScreen(role, 2.1);
      if (!k || !p) return;
      const col = safe ? [47, 191, 113] : [255, 90, 42];
      const make = (dx, dy, color, alpha) => {
        const o = k.add([
          k.text(text, { size: 30 }),
          k.pos(p.x + dx, p.y + dy),
          k.anchor('center'),
          k.color(...color),
          k.opacity(1),
          k.z(10),
        ]);
        let life = 1.2;
        o.onUpdate(() => {
          life -= k.dt();
          o.pos.y -= 55 * k.dt();
          o.opacity = alpha * Math.max(0, Math.min(1, life * 2));
          if (life <= 0) o.destroy();
        });
      };
      make(1.5, 1.5, [30, 30, 40], 0.3); // faint drop shadow
      make(0, 0, col, 1);
    },

    fxSparks(role, safe) {
      const k = this.k;
      const p = this.toScreen(role, 0.6);
      if (!k || !p) return;
      const colors = safe ? [[120, 230, 160], [255, 255, 255]] : [[255, 90, 30], [255, 180, 40], [255, 230, 110]];
      for (let i = 0; i < 16; i++) {
        const col = colors[i % colors.length];
        const o = k.add([k.circle(2 + Math.random() * 3), k.pos(p.x, p.y), k.color(...col), k.opacity(1), k.z(5)]);
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
        const sp = 90 + Math.random() * 160;
        let vx = Math.cos(ang) * sp;
        let vy = Math.sin(ang) * sp;
        let life = 0.5 + Math.random() * 0.4;
        o.onUpdate(() => {
          const dt = k.dt();
          life -= dt;
          vy += 260 * dt;
          o.pos.x += vx * dt; o.pos.y += vy * dt;
          o.opacity = Math.max(0, life * 2);
          if (life <= 0) o.destroy();
        });
      }
    },

    fxConfetti() {
      const k = this.k;
      if (!k) return;
      const colors = [[102, 126, 234], [224, 114, 74], [255, 210, 63], [47, 191, 113], [236, 72, 153]];
      for (let i = 0; i < 60; i++) {
        const col = colors[i % colors.length];
        const o = k.add([
          k.rect(6, 10), k.pos(Math.random() * k.width(), -20 - Math.random() * 120),
          k.anchor('center'), k.rotate(Math.random() * 360), k.color(...col), k.opacity(1), k.z(20),
        ]);
        const vx = (Math.random() - 0.5) * 60;
        const vy = 120 + Math.random() * 120;
        const spin = (Math.random() - 0.5) * 400;
        let life = 2.4 + Math.random();
        o.onUpdate(() => {
          const dt = k.dt();
          life -= dt;
          o.pos.x += vx * dt; o.pos.y += vy * dt; o.angle += spin * dt;
          o.opacity = Math.max(0, Math.min(1, life));
          if (life <= 0 || o.pos.y > k.height() + 20) o.destroy();
        });
      }
    },

    // ---- Cleanup ---------------------------------------------------------------

    disposeScene() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      if (this.k) {
        try { if (this.k.audioCtx) this.k.audioCtx.close().catch(() => {}); } catch (e) { /* ignore */ }
        try { this.k.quit(); } catch (e) { /* ignore */ }
        this.k = null;
      }
      const t = this.three;
      if (!t) return;
      this.three = null;
      try {
        if (t.buildingGroup) t.buildingGroup.userData.dispose.forEach((d) => d.dispose());
        const s = t.shared;
        [s.slabGeo, s.groundGeo, s.frameGeo, s.fillGeo, s.flameGeo].forEach((g) => g.dispose());
        Object.values(s.mat).forEach((m) => (m.dispose ? m.dispose() : Object.values(m).forEach((x) => x.dispose())));
        ['host', 'guest'].forEach((r) => {
          t.chars[r].geos.forEach((g) => g.dispose());
          t.chars[r].mats.forEach((m) => m.dispose());
        });
        t.texCache.forEach((tex) => tex.dispose());
        t.matCache.forEach((m) => m.dispose());
        t.scene.traverse((o) => {
          if (o.isMesh && o.geometry && o.geometry.type === 'PlaneGeometry' && o.parent === t.scene) o.geometry.dispose();
        });
        t.renderer.dispose();
        t.renderer.forceContextLoss(); // free the WebGL context right away (matters on iOS)
      } catch (e) { /* ignore */ }
    },
  };

  window.GameModules = window.GameModules || {};
  window.GameModules[GAME_ID] = BuildingFall;
})();
