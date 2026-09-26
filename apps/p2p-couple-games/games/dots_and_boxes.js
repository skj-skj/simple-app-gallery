(function () {
  'use strict';

  /*
   * Dots and Boxes — configurable NxN boxes (3x3 up to 10x10).
   *
   * Only the room host picks the grid size (same pattern as Scribble 2's
   * host-authoritative config): the host sees the size picker, sends
   * CONFIG once they hit "Start Game", and the guest just waits until it
   * arrives. This avoids the two peers ever disagreeing about board size.
   *
   * Board model: for an NxN box grid there are (N+1) rows of horizontal
   * edges (N per row) and N rows of vertical edges (N+1 per row).
   *   hEdges[row][col] = the edge between dot(row,col) and dot(row,col+1)
   *   vEdges[row][col] = the edge between dot(row,col) and dot(row+1,col)
   * A box(row,col) is complete once its four bordering edges — hEdges
   * [row][col] (top), hEdges[row+1][col] (bottom), vEdges[row][col]
   * (left), vEdges[row][col+1] (right) — are all claimed.
   *
   * Turn rule: claiming an edge that completes one or two boxes earns
   * another turn for the same player; otherwise the turn passes. Both
   * peers compute box completion locally and independently the same
   * way — only the edge itself is sent over the wire, and each side
   * derives everything else (bonus turns, scores, game end) from that,
   * so there's nothing to desync as long as both apply edges in the
   * same order, which the strict turn-taking guarantees.
   *
   * Layout: the board is a single CSS grid with (2N+1) row/column
   * tracks. Even tracks (0, 2, 4, ...) are small fixed-size "dot"
   * tracks; odd tracks are flexible "fr" tracks shared by edges and
   * box interiors. A cell at (even, even) is a dot, (even, odd) is a
   * horizontal edge, (odd, even) is a vertical edge, and (odd, odd) is
   * a box — a standard trick that gives correctly-proportioned thin
   * edges and square boxes without any manual positioning math.
   */

  const MIN_SIZE = 3;
  const MAX_SIZE = 10;
  const DEFAULT_SIZE = 5;

  const DotsAndBoxes = {
    init(api) {
      this.api = api;
      this.round = -1;
      this.n = null;
      this.phase = 'setup';
      this.selectedSize = DEFAULT_SIZE;
      this.score = { me: 0, opp: 0 };

      this.cacheDom();
      this.renderSizeGrid();
      this.bindStaticEvents();
      this.unsub = api.onMessage((msg) => this.handleMessage(msg));

      this.goToSetup();
    },

    // ---------------------------------------------------------------------
    // DOM setup
    // ---------------------------------------------------------------------

    cacheDom() {
      const $ = (sel) => this.api.root.querySelector(sel);

      this.statusEl = $('#dnb-status');
      this.substatusEl = $('#dnb-substatus');

      this.setupEl = $('#dnb-setup');
      this.sizeGridEl = $('#dnb-size-grid');
      this.startBtn = $('#dnb-start-btn');
      this.setupWaitingEl = $('#dnb-setup-waiting');
      this.setupWaitingNameEl = $('#dnb-setup-waiting-name');

      this.playEl = $('#dnb-play');
      this.scoreMeEl = $('#dnb-score-me');
      this.scoreOppEl = $('#dnb-score-opp');
      this.boardEl = $('#dnb-board');

      this.gameoverEl = $('#dnb-gameover');
      this.gameoverTitleEl = $('#dnb-gameover-title');
      this.gameoverSubEl = $('#dnb-gameover-sub');
      this.rematchBtn = $('#dnb-rematch-btn');
      this.changeSizeBtn = $('#dnb-change-size-btn');

      this.setupWaitingNameEl.textContent = this.api.peerNickname || 'Your partner';
    },

    renderSizeGrid() {
      this.sizeGridEl.innerHTML = '';
      for (let s = MIN_SIZE; s <= MAX_SIZE; s++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dnb-size-btn' + (s === this.selectedSize ? ' selected' : '');
        btn.textContent = `${s}×${s}`;
        btn.addEventListener('click', () => {
          this.selectedSize = s;
          this.renderSizeGrid();
        });
        this.sizeGridEl.appendChild(btn);
      }
    },

    bindStaticEvents() {
      this.startBtn.addEventListener('click', () => this.startNewConfigGame(this.selectedSize));
      this.rematchBtn.addEventListener('click', () => this.requestRematch());
      this.changeSizeBtn.addEventListener('click', () => this.requestChangeSize());
    },

    // ---------------------------------------------------------------------
    // Setup / config phase
    // ---------------------------------------------------------------------

    goToSetup() {
      this.phase = 'setup';
      this.gameoverEl.classList.add('dnb-hidden');
      this.playEl.classList.add('dnb-hidden');
      if (this.api.isHost) {
        this.setupEl.classList.remove('dnb-hidden');
        this.setupWaitingEl.classList.add('dnb-hidden');
      } else {
        this.setupEl.classList.add('dnb-hidden');
        this.setupWaitingEl.classList.remove('dnb-hidden');
      }
      this.updateStatus();
    },

    startNewConfigGame(n) {
      if (!this.api.isHost) return;
      const round = this.round + 1;
      this.api.send({ type: 'CONFIG', n, round });
      this.startGame(n, round);
    },

    requestChangeSize() {
      if (!this.api.isHost) return;
      this.api.send({ type: 'RESETUP' });
      this.goToSetup();
    },

    requestRematch() {
      const round = this.round + 1;
      this.api.send({ type: 'REMATCH', round });
      this.startGame(this.n, round);
    },

    // ---------------------------------------------------------------------
    // Game start / board construction
    // ---------------------------------------------------------------------

    startGame(n, round) {
      this.n = n;
      this.round = round;
      this.phase = 'play';
      this.totalBoxes = n * n;
      this.claimedBoxes = 0;
      this.hEdges = Array((n + 1) * n).fill(null);
      this.vEdges = Array(n * (n + 1)).fill(null);
      this.boxOwners = Array(n * n).fill(null);
      this.score = { me: 0, opp: 0 };

      const hostGoesFirst = round % 2 === 0;
      this.turn = hostGoesFirst === this.api.isHost ? 'me' : 'opp';

      this.setupEl.classList.add('dnb-hidden');
      this.setupWaitingEl.classList.add('dnb-hidden');
      this.gameoverEl.classList.add('dnb-hidden');
      this.playEl.classList.remove('dnb-hidden');

      this.buildBoard(n);
      this.refreshAllEdges();
      this.updateScoreLine();
      this.updateStatus();
    },

    dotSizeFor(n) {
      if (n <= 4) return 16;
      if (n <= 6) return 13;
      if (n <= 8) return 11;
      return 9;
    },

    buildBoard(n) {
      const dotPx = this.dotSizeFor(n);
      const tracks = [];
      for (let i = 0; i < 2 * n + 1; i++) tracks.push(i % 2 === 0 ? `${dotPx}px` : '1fr');
      this.boardEl.style.gridTemplateColumns = tracks.join(' ');
      this.boardEl.style.gridTemplateRows = tracks.join(' ');
      this.boardEl.innerHTML = '';

      this.hEdgeEls = Array((n + 1) * n).fill(null);
      this.vEdgeEls = Array(n * (n + 1)).fill(null);
      this.boxEls = Array(n * n).fill(null);

      const frag = document.createDocumentFragment();
      for (let i = 0; i < 2 * n + 1; i++) {
        const iEven = i % 2 === 0;
        for (let j = 0; j < 2 * n + 1; j++) {
          const jEven = j % 2 === 0;
          if (iEven && jEven) {
            const dot = document.createElement('div');
            dot.className = 'dnb-dot';
            frag.appendChild(dot);
          } else if (iEven && !jEven) {
            const row = i / 2;
            const col = (j - 1) / 2;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dnb-edge dnb-edge-h dnb-clickable';
            btn.innerHTML = '<span class="dnb-edge-line"></span>';
            btn.addEventListener('click', () => this.onEdgeClick('h', row, col));
            this.hEdgeEls[row * n + col] = btn;
            frag.appendChild(btn);
          } else if (!iEven && jEven) {
            const row = (i - 1) / 2;
            const col = j / 2;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dnb-edge dnb-edge-v dnb-clickable';
            btn.innerHTML = '<span class="dnb-edge-line"></span>';
            btn.addEventListener('click', () => this.onEdgeClick('v', row, col));
            this.vEdgeEls[row * (n + 1) + col] = btn;
            frag.appendChild(btn);
          } else {
            const row = (i - 1) / 2;
            const col = (j - 1) / 2;
            const box = document.createElement('div');
            box.className = 'dnb-box';
            this.boxEls[row * n + col] = box;
            frag.appendChild(box);
          }
        }
      }
      this.boardEl.appendChild(frag);
    },

    // ---------------------------------------------------------------------
    // Edge / box mechanics
    // ---------------------------------------------------------------------

    edgeIndex(type, row, col) {
      return type === 'h' ? row * this.n + col : row * (this.n + 1) + col;
    },

    onEdgeClick(type, row, col) {
      if (this.phase !== 'play' || this.turn !== 'me') return;
      const idx = this.edgeIndex(type, row, col);
      const arr = type === 'h' ? this.hEdges : this.vEdges;
      if (arr[idx]) return; // already claimed
      this.applyClaim('me', type, row, col);
      this.api.send({ type: 'CLAIM_EDGE', edgeType: type, row, col });
    },

    // Applies an edge claim by `owner` ('me' or 'opp') to local state and
    // re-renders. Used both for my own clicks and for incoming messages,
    // so the exact same box-completion / turn-passing logic runs on both
    // sides of the connection.
    applyClaim(owner, type, row, col) {
      const idx = this.edgeIndex(type, row, col);
      const arr = type === 'h' ? this.hEdges : this.vEdges;
      if (arr[idx]) return; // defensive: ignore an already-claimed edge
      arr[idx] = owner;

      const el = type === 'h' ? this.hEdgeEls[idx] : this.vEdgeEls[idx];
      el.classList.add(owner === 'me' ? 'dnb-owned-me' : 'dnb-owned-opp');
      this.animate(el, 320);

      const completed = this.checkCompletedBoxes(type, row, col);
      completed.forEach(({ r, c }) => {
        this.boxOwners[r * this.n + c] = owner;
        this.claimedBoxes++;
        if (owner === 'me') this.score.me++; else this.score.opp++;
        const boxEl = this.boxEls[r * this.n + c];
        boxEl.classList.add(owner === 'me' ? 'dnb-owned-me' : 'dnb-owned-opp');
        this.animate(boxEl, 420);
      });

      // Completing at least one box earns another turn for the same player.
      this.turn = completed.length > 0 ? owner : (owner === 'me' ? 'opp' : 'me');

      this.refreshAllEdges();
      this.updateScoreLine();
      this.updateStatus();

      if (this.claimedBoxes === this.totalBoxes) {
        this.handleGameOver();
      }
    },

    // Returns the boxes (0, 1, or 2 of them) that just became complete as
    // a result of claiming the given edge. Skips any box that was already
    // owned (shouldn't happen, but keeps this idempotent just in case).
    checkCompletedBoxes(type, row, col) {
      const results = [];
      if (type === 'h') {
        if (row < this.n && this.isBoxComplete(row, col)) results.push({ r: row, c: col });
        if (row > 0 && this.isBoxComplete(row - 1, col)) results.push({ r: row - 1, c: col });
      } else {
        if (col < this.n && this.isBoxComplete(row, col)) results.push({ r: row, c: col });
        if (col > 0 && this.isBoxComplete(row, col - 1)) results.push({ r: row, c: col - 1 });
      }
      return results;
    },

    isBoxComplete(r, c) {
      if (this.boxOwners[r * this.n + c]) return false; // already claimed
      const top = this.hEdges[r * this.n + c];
      const bottom = this.hEdges[(r + 1) * this.n + c];
      const left = this.vEdges[r * (this.n + 1) + c];
      const right = this.vEdges[r * (this.n + 1) + c + 1];
      return !!(top && bottom && left && right);
    },

    animate(el, ms) {
      el.classList.remove('dnb-anim-claim');
      void el.offsetWidth;
      el.classList.add('dnb-anim-claim');
      setTimeout(() => el.classList.remove('dnb-anim-claim'), ms);
    },

    // ---------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------

    refreshAllEdges() {
      for (let row = 0; row <= this.n; row++) {
        for (let col = 0; col < this.n; col++) this.updateEdgeInteractivity('h', row, col);
      }
      for (let row = 0; row < this.n; row++) {
        for (let col = 0; col <= this.n; col++) this.updateEdgeInteractivity('v', row, col);
      }
    },

    updateEdgeInteractivity(type, row, col) {
      const idx = this.edgeIndex(type, row, col);
      const owner = (type === 'h' ? this.hEdges : this.vEdges)[idx];
      const el = type === 'h' ? this.hEdgeEls[idx] : this.vEdgeEls[idx];
      el.disabled = !!owner || this.turn !== 'me' || this.phase !== 'play';
    },

    updateScoreLine() {
      this.scoreMeEl.textContent = String(this.score.me);
      this.scoreOppEl.textContent = String(this.score.opp);
    },

    updateStatus() {
      const partnerName = this.api.peerNickname || 'Partner';
      if (this.phase === 'setup') {
        this.statusEl.textContent = this.api.isHost ? 'Set up the game' : 'Waiting for host';
        this.substatusEl.textContent = this.api.isHost
          ? 'Pick a grid size to begin.'
          : `${partnerName} is choosing a grid size…`;
      } else if (this.phase === 'play') {
        this.statusEl.textContent = this.turn === 'me' ? 'Your turn' : `${partnerName}'s turn…`;
        this.substatusEl.textContent = '\u00A0';
      } else if (this.phase === 'gameover') {
        this.statusEl.textContent = 'Game over';
        this.substatusEl.textContent = '\u00A0';
      }
    },

    handleGameOver() {
      this.phase = 'gameover';
      const partnerName = this.api.peerNickname || 'Partner';

      this.playEl.classList.add('dnb-hidden');
      this.gameoverEl.classList.remove('dnb-hidden');

      let title;
      if (this.score.me > this.score.opp) title = '🎉 You win!';
      else if (this.score.opp > this.score.me) title = `💥 ${partnerName} wins!`;
      else title = "🤝 It's a tie!";

      this.gameoverTitleEl.textContent = title;
      this.gameoverSubEl.textContent = `Final score — You ${this.score.me} : ${this.score.opp} ${partnerName}`;
      this.changeSizeBtn.classList.toggle('dnb-hidden', !this.api.isHost);
      this.updateStatus();
    },

    // ---------------------------------------------------------------------
    // Networking
    // ---------------------------------------------------------------------

    handleMessage(msg) {
      switch (msg.type) {
        case 'CONFIG':
          this.startGame(msg.n, msg.round);
          break;
        case 'CLAIM_EDGE':
          this.applyClaim('opp', msg.edgeType, msg.row, msg.col);
          break;
        case 'REMATCH':
          this.startGame(this.n, msg.round);
          break;
        case 'RESETUP':
          this.goToSetup();
          break;
      }
    },

    destroy() {
      if (this.unsub) this.unsub();
    },
  };

  window.GameModules = window.GameModules || {};
  window.GameModules['dots_and_boxes'] = DotsAndBoxes;
})();