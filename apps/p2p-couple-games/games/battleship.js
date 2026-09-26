(function () {
  'use strict';

  /*
   * Battleship — standard 10x10 grid, classic 5-ship fleet.
   *
   * Trust model (same spirit as the fairness note in games/rps.js): each
   * player's own board is the single source of truth for what happens to
   * their ships. Ship *positions* are never sent over the wire — only
   * FIRE (a coordinate) and RESULT (hit/miss/sunk, computed by whoever
   * owns that board) are exchanged. That keeps it simple and honest for a
   * casual two-player game without needing a server referee, at the cost
   * of not being cheat-proof against a deliberately malicious peer lying
   * about their own board — an acceptable trade-off here, same as RPS.
   *
   * Turn order: whoever's turn it is fires, the other side reports the
   * result, and the turn then passes to the side that was just fired at.
   * This alternates strictly every shot (no "go again on hit" rule) so
   * there's no ambiguity about whose turn it is on either side.
   *
   * Who goes first is derived from `round` (0, 1, 2, ... incremented on
   * every rematch) the same deterministic way tictactoe.js does it: the
   * host goes first on even rounds, the guest on odd rounds. Both peers
   * compute this independently from the same round number, so no extra
   * handshake message is needed to agree on the starting player.
   */

  const SHIPS = [
    { id: 'carrier', name: 'Carrier', size: 5 },
    { id: 'battleship', name: 'Battleship', size: 4 },
    { id: 'cruiser', name: 'Cruiser', size: 3 },
    { id: 'submarine', name: 'Submarine', size: 3 },
    { id: 'destroyer', name: 'Destroyer', size: 2 },
  ];

  const SOUND_SCRIPT_SRC = 'games/assets/battleship_sounds.js';

  const Battleship = {
    init(api) {
      this.api = api;
      this.score = { me: 0, opp: 0 };
      this._soundsLoading = false;

      this.cacheDom();
      this.bindStaticEvents();
      this.unsub = api.onMessage((msg) => this.handleMessage(msg));
      this.loadSounds();
      this.resetForRound(0);
    },

    // ---------------------------------------------------------------------
    // DOM setup
    // ---------------------------------------------------------------------

    cacheDom() {
      const $ = (sel) => this.api.root.querySelector(sel);

      this.statusEl = $('#bs-status');
      this.substatusEl = $('#bs-substatus');

      this.placementEl = $('#bs-placement');
      this.trayEl = $('#bs-tray');
      this.rotateBtn = $('#bs-rotate-btn');
      this.orientationLabelEl = $('#bs-orientation-label');
      this.randomBtn = $('#bs-random-btn');
      this.clearBtn = $('#bs-clear-btn');
      this.toolsEl = this.rotateBtn.closest('.bs-tools');
      this.placeBoardEl = $('#bs-place-board');
      this.readyBtn = $('#bs-ready-btn');
      this.placeWaitingEl = $('#bs-place-waiting');
      this.placeWaitingNameEl = $('#bs-place-waiting-name');

      this.battleEl = $('#bs-battle');
      this.logEl = $('#bs-log');
      this.scoreEl = $('#bs-score');
      this.attackBoardEl = $('#bs-attack-board');
      this.sunkOppEl = $('#bs-sunk-opp');
      this.defenseBoardEl = $('#bs-defense-board');
      this.sunkMineEl = $('#bs-sunk-mine');

      this.gameoverEl = $('#bs-gameover');
      this.gameoverTitleEl = $('#bs-gameover-title');
      this.gameoverSubEl = $('#bs-gameover-sub');
      this.rematchBtn = $('#bs-rematch-btn');

      this.placeWaitingNameEl.textContent = this.api.peerNickname || 'your partner';

      this.placeCells = this.buildBoardGrid(this.placeBoardEl, {
        clickable: true,
        onClick: (idx) => this.onPlaceCellClick(idx),
      });
      this.attackCells = this.buildBoardGrid(this.attackBoardEl, {
        clickable: true,
        onClick: (idx) => this.onAttackCellClick(idx),
      });
      this.defenseCells = this.buildBoardGrid(this.defenseBoardEl, { clickable: false });
    },

    buildBoardGrid(container, opts) {
      container.innerHTML = '';
      const frag = document.createDocumentFragment();

      const corner = document.createElement('div');
      corner.className = 'bs-axis-label';
      frag.appendChild(corner);

      for (let c = 0; c < 10; c++) {
        const lbl = document.createElement('div');
        lbl.className = 'bs-axis-label';
        lbl.textContent = String(c + 1);
        frag.appendChild(lbl);
      }

      const cells = [];
      for (let r = 0; r < 10; r++) {
        const rowLbl = document.createElement('div');
        rowLbl.className = 'bs-axis-label';
        rowLbl.textContent = String.fromCharCode(65 + r);
        frag.appendChild(rowLbl);

        for (let c = 0; c < 10; c++) {
          const idx = r * 10 + c;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'bs-cell' + (opts.clickable ? ' bs-clickable' : '');
          if (!opts.clickable) btn.disabled = true;
          if (opts.onClick) btn.addEventListener('click', () => opts.onClick(idx));
          frag.appendChild(btn);
          cells.push(btn);
        }
      }
      container.appendChild(frag);
      return cells;
    },

    bindStaticEvents() {
      this.rotateBtn.addEventListener('click', () => {
        this.unlockSound();
        this.orientation = this.orientation === 'h' ? 'v' : 'h';
        this.updateOrientationLabel();
      });
      this.randomBtn.addEventListener('click', () => {
        this.unlockSound();
        this.randomizePlacement();
      });
      this.clearBtn.addEventListener('click', () => {
        this.unlockSound();
        this.clearPlacement();
      });
      this.readyBtn.addEventListener('click', () => {
        this.unlockSound();
        this.confirmReady();
      });
      this.rematchBtn.addEventListener('click', () => {
        this.unlockSound();
        this.requestRematch();
      });
    },

    loadSounds() {
      if (window.BattleshipSounds || this._soundsLoading) return;
      this._soundsLoading = true;
      const s = document.createElement('script');
      s.src = SOUND_SCRIPT_SRC;
      s.onload = () => { this._soundsLoading = false; };
      s.onerror = () => {
        this._soundsLoading = false;
        console.error('Battleship: failed to load sound module at', SOUND_SCRIPT_SRC);
      };
      document.head.appendChild(s);
    },

    unlockSound() {
      if (window.BattleshipSounds) window.BattleshipSounds.unlock();
    },

    playResultSound(hit, sunk) {
      if (!window.BattleshipSounds) return;
      if (sunk) window.BattleshipSounds.playSink();
      else if (hit) window.BattleshipSounds.playHit();
      else window.BattleshipSounds.playMiss();
    },

    // ---------------------------------------------------------------------
    // Round / state reset (called at start and on every rematch)
    // ---------------------------------------------------------------------

    resetForRound(round) {
      this.round = round;
      this.phase = 'placing';
      this.orientation = 'h';
      this.placeBoard = Array(100).fill(null);
      this.placedShips = {};
      this.selectedShipId = SHIPS[0].id;

      this.myBoard = null;
      this.myShips = null;
      this.iReady = false;
      this.oppReady = false;

      this.trackingGrid = Array(100).fill('unknown'); // my shots on partner's board
      this.myDefenseMarks = Array(100).fill(null);     // partner's shots on my board
      this.turn = null;
      this.waitingForResult = false;
      this.sunkOppShipNames = [];
      this.sunkMineShipNames = [];

      this.gameoverEl.classList.add('bs-hidden');
      this.battleEl.classList.add('bs-hidden');
      this.placementEl.classList.remove('bs-hidden');
      this.placeWaitingEl.classList.add('bs-hidden');
      this.trayEl.classList.remove('bs-hidden');
      this.toolsEl.classList.remove('bs-hidden');
      this.readyBtn.classList.remove('bs-hidden');

      this.updateOrientationLabel();
      this.renderTray();
      this.renderPlaceBoard();
      this.updateReadyButton();
      this.logEl.textContent = '\u00A0';
      this.sunkOppEl.textContent = '\u00A0';
      this.sunkMineEl.textContent = '\u00A0';
      this.updateScoreLine();
      this.updateStatus();
    },

    // ---------------------------------------------------------------------
    // Placement phase
    // ---------------------------------------------------------------------

    updateOrientationLabel() {
      this.orientationLabelEl.textContent = this.orientation === 'h' ? 'Horizontal' : 'Vertical';
    },

    renderTray() {
      this.trayEl.innerHTML = '';
      SHIPS.forEach((ship) => {
        const chip = document.createElement('div');
        const placed = !!this.placedShips[ship.id];
        chip.className = 'bs-ship-chip' + (placed ? ' placed' : '') +
          (this.selectedShipId === ship.id ? ' selected' : '');
        const dots = Array.from({ length: ship.size }).map(() => '<span></span>').join('');
        chip.innerHTML = `<span>${ship.name}</span><span class="dots">${dots}</span>`;
        chip.addEventListener('click', () => this.onTrayClick(ship.id));
        this.trayEl.appendChild(chip);
      });
    },

    onTrayClick(shipId) {
      if (this.phase !== 'placing' || this.iReady) return;
      this.unlockSound();
      if (this.placedShips[shipId]) {
        this.removeShipFromBoard(shipId);
      }
      this.selectedShipId = shipId;
      this.renderTray();
      this.renderPlaceBoard();
    },

    removeShipFromBoard(shipId) {
      const ship = this.placedShips[shipId];
      if (!ship) return;
      ship.cells.forEach((idx) => { this.placeBoard[idx] = null; });
      delete this.placedShips[shipId];
      this.updateReadyButton();
    },

    // Returns the array of cell indices a ship would occupy, or null if
    // that placement is out of bounds or overlaps an existing ship on
    // the given board array.
    getShipCellsIfValid(board, anchorIdx, size, orientation) {
      const r0 = Math.floor(anchorIdx / 10);
      const c0 = anchorIdx % 10;
      const cells = [];
      for (let i = 0; i < size; i++) {
        const r = orientation === 'h' ? r0 : r0 + i;
        const c = orientation === 'h' ? c0 + i : c0;
        if (r > 9 || c > 9) return null;
        const idx = r * 10 + c;
        if (board[idx]) return null;
        cells.push(idx);
      }
      return cells;
    },

    onPlaceCellClick(idx) {
      if (this.phase !== 'placing' || this.iReady) return;
      this.unlockSound();

      const occupant = this.placeBoard[idx];
      if (occupant) {
        // Tap a placed ship to pick it up again for repositioning.
        this.removeShipFromBoard(occupant);
        this.selectedShipId = occupant;
        this.renderTray();
        this.renderPlaceBoard();
        return;
      }

      if (!this.selectedShipId) return; // everything already placed
      const ship = SHIPS.find((s) => s.id === this.selectedShipId);
      const cells = this.getShipCellsIfValid(this.placeBoard, idx, ship.size, this.orientation);
      if (!cells) {
        this.flashInvalid(idx);
        return;
      }

      cells.forEach((i) => { this.placeBoard[i] = ship.id; });
      this.placedShips[ship.id] = { cells };
      const next = SHIPS.find((s) => !this.placedShips[s.id]);
      this.selectedShipId = next ? next.id : null;

      this.renderTray();
      this.renderPlaceBoard();
      this.animateCells(this.placeCells, cells, 'bs-anim-pop');
      this.updateReadyButton();
    },

    flashInvalid(idx) {
      const el = this.placeCells[idx];
      el.classList.remove('bs-invalid-flash');
      void el.offsetWidth; // restart animation if triggered again quickly
      el.classList.add('bs-invalid-flash');
      setTimeout(() => el.classList.remove('bs-invalid-flash'), 300);
    },

    renderPlaceBoard() {
      this.placeCells.forEach((el, idx) => {
        const occ = this.placeBoard[idx];
        el.className = 'bs-cell bs-clickable' + (occ ? ' bs-ship' : '');
        el.disabled = false;
      });
    },

    updateReadyButton() {
      const allPlaced = SHIPS.every((s) => this.placedShips[s.id]);
      this.readyBtn.disabled = !allPlaced;
      this.readyBtn.textContent = allPlaced ? "Ready — Let's Battle!" : 'Place all ships to continue';
    },

    clearPlacement() {
      if (this.phase !== 'placing' || this.iReady) return;
      this.placeBoard = Array(100).fill(null);
      this.placedShips = {};
      this.selectedShipId = SHIPS[0].id;
      this.renderTray();
      this.renderPlaceBoard();
      this.updateReadyButton();
    },

    randomizePlacement() {
      if (this.phase !== 'placing' || this.iReady) return;
      const board = Array(100).fill(null);
      const placed = {};

      for (const ship of SHIPS) {
        let cells = null;
        let tries = 0;
        while (tries < 400 && !cells) {
          tries++;
          const orientation = Math.random() < 0.5 ? 'h' : 'v';
          const anchor = Math.floor(Math.random() * 100);
          cells = this.getShipCellsIfValid(board, anchor, ship.size, orientation);
        }
        if (!cells) cells = this.findAnySlot(board, ship.size);
        cells.forEach((i) => { board[i] = ship.id; });
        placed[ship.id] = { cells };
      }

      this.placeBoard = board;
      this.placedShips = placed;
      this.selectedShipId = null;
      this.renderTray();
      this.renderPlaceBoard();
      this.animateCells(this.placeCells, board.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), 'bs-anim-pop');
      this.updateReadyButton();
    },

    // Exhaustive fallback so randomize can never fail to place a ship
    // (practically unreachable with the standard fleet on a 10x10 board,
    // but guarantees this never throws).
    findAnySlot(board, size) {
      for (const orientation of ['h', 'v']) {
        for (let idx = 0; idx < 100; idx++) {
          const cells = this.getShipCellsIfValid(board, idx, size, orientation);
          if (cells) return cells;
        }
      }
      return [0]; // should be unreachable
    },

    animateCells(cellsArr, indices, cls) {
      indices.forEach((idx) => {
        const el = cellsArr[idx];
        if (!el) return;
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
        setTimeout(() => el.classList.remove(cls), 700);
      });
    },

    confirmReady() {
      if (this.phase !== 'placing' || this.iReady) return;
      if (!SHIPS.every((s) => this.placedShips[s.id])) return;

      // Freeze my authoritative board + per-ship hit tracking. Positions
      // themselves are kept local — only ever referenced, never sent.
      this.myBoard = this.placeBoard.slice();
      this.myShips = {};
      SHIPS.forEach((ship) => {
        const p = this.placedShips[ship.id];
        this.myShips[ship.id] = { name: ship.name, cells: p.cells.slice(), hits: new Set(), sunk: false };
      });
      this.iReady = true;

      this.placeCells.forEach((el) => { el.disabled = true; });
      this.trayEl.classList.add('bs-hidden');
      this.toolsEl.classList.add('bs-hidden');
      this.readyBtn.classList.add('bs-hidden');
      this.placeWaitingEl.classList.remove('bs-hidden');

      this.api.send({ type: 'READY' });
      this.updateStatus();
      this.maybeStartBattle();
    },

    maybeStartBattle() {
      if (this.iReady && this.oppReady && this.phase === 'placing') {
        this.startBattle();
      }
    },

    // ---------------------------------------------------------------------
    // Battle phase
    // ---------------------------------------------------------------------

    startBattle() {
      this.phase = 'battle';
      this.placementEl.classList.add('bs-hidden');
      this.battleEl.classList.remove('bs-hidden');

      const hostGoesFirst = this.round % 2 === 0;
      this.turn = hostGoesFirst === this.api.isHost ? 'me' : 'opp';

      this.renderAttackBoard();
      this.renderDefenseBoard();
      this.updateScoreLine();
      this.logEl.textContent = this.turn === 'me'
        ? 'Battle begins — take the first shot!'
        : `Battle begins — ${this.api.peerNickname || 'your partner'} fires first.`;
      this.updateStatus();
    },

    coordLabel(idx) {
      const r = Math.floor(idx / 10);
      const c = idx % 10;
      return String.fromCharCode(65 + r) + (c + 1);
    },

    onAttackCellClick(idx) {
      if (this.phase !== 'battle' || this.turn !== 'me' || this.waitingForResult) return;
      if (this.trackingGrid[idx] !== 'unknown') return;
      this.unlockSound();

      this.waitingForResult = true;
      this.attackCells[idx].disabled = true;
      this.attackCells[idx].classList.add('bs-pending');
      this.logEl.textContent = `You fired at ${this.coordLabel(idx)}…`;
      this.api.send({ type: 'FIRE', idx });
      this.updateStatus();
    },

    // I am the target: my own board is authoritative for what happens.
    handleIncomingFire(idx) {
      if (!this.myBoard) return; // shouldn't happen once battle has started
      const shipId = this.myBoard[idx];
      let hit = false;
      let sunk = false;
      let shipName = null;
      let sunkCells = null;

      if (shipId) {
        hit = true;
        const ship = this.myShips[shipId];
        ship.hits.add(idx);
        if (ship.hits.size === ship.cells.length) {
          sunk = true;
          ship.sunk = true;
          shipName = ship.name;
          sunkCells = ship.cells.slice();
          this.sunkMineShipNames.push(ship.name);
        }
      }

      this.myDefenseMarks[idx] = hit ? 'hit' : 'miss';
      this.renderDefenseCell(idx);
      this.animateCells(this.defenseCells, [idx], sunk ? 'bs-anim-sunkwave' : (hit ? 'bs-anim-pop' : 'bs-anim-ripple'));
      this.playResultSound(hit, sunk);

      const allSunk = Object.values(this.myShips).every((s) => s.sunk);
      const partnerName = this.api.peerNickname || 'Partner';
      this.logEl.textContent = `${partnerName} fired at ${this.coordLabel(idx)} — ${
        sunk ? shipName + ' sunk!' : (hit ? 'Hit!' : 'Miss.')
      }`;
      this.updateSunkLine();

      this.api.send({ type: 'RESULT', idx, hit, sunk, shipName, cells: sunkCells, gameOver: allSunk });

      if (allSunk) {
        this.handleGameOver(false); // partner sank my whole fleet
      } else {
        this.turn = 'me';
        this.updateStatus();
        this.renderAttackBoard(); // re-enable my cells now that it's my turn
      }
    },

    // I was the firer: apply partner's authoritative result to my tracking grid.
    handleIncomingResult(msg) {
      const { idx, hit, sunk, shipName, cells, gameOver } = msg;
      this.waitingForResult = false;
      this.attackCells[idx].classList.remove('bs-pending');

      this.trackingGrid[idx] = sunk ? 'sunk' : (hit ? 'hit' : 'miss');
      if (sunk && cells) {
        cells.forEach((i) => { this.trackingGrid[i] = 'sunk'; });
        this.sunkOppShipNames.push(shipName);
      }
      this.renderAttackBoard();
      this.animateCells(this.attackCells, sunk && cells ? cells : [idx],
        sunk ? 'bs-anim-sunkwave' : (hit ? 'bs-anim-pop' : 'bs-anim-ripple'));
      this.playResultSound(hit, sunk);

      this.logEl.textContent = `You fired at ${this.coordLabel(idx)} — ${
        sunk ? shipName + ' sunk!' : (hit ? 'Hit!' : 'Miss.')
      }`;
      this.updateSunkLine();

      if (gameOver) {
        this.handleGameOver(true); // I sank partner's whole fleet
      } else {
        this.turn = 'opp';
        this.updateStatus();
        this.renderAttackBoard();
      }
    },

    renderAttackCell(idx) {
      const el = this.attackCells[idx];
      const state = this.trackingGrid[idx];
      el.className = 'bs-cell bs-clickable' +
        (state === 'hit' ? ' bs-hit' : state === 'miss' ? ' bs-miss' : state === 'sunk' ? ' bs-sunk' : '');
      el.disabled = !(this.phase === 'battle' && this.turn === 'me' && state === 'unknown' && !this.waitingForResult);
    },

    renderAttackBoard() {
      this.attackCells.forEach((el, idx) => this.renderAttackCell(idx));
    },

    renderDefenseCell(idx) {
      const el = this.defenseCells[idx];
      const shipId = this.myBoard ? this.myBoard[idx] : null;
      const mark = this.myDefenseMarks[idx];
      let cls = 'bs-cell';
      if (shipId) {
        const sunk = this.myShips[shipId].sunk;
        if (sunk) cls += ' bs-sunk';
        else if (mark === 'hit') cls += ' bs-hit';
        else cls += ' bs-ship';
      } else if (mark === 'miss') {
        cls += ' bs-miss';
      }
      el.className = cls;
    },

    renderDefenseBoard() {
      this.defenseCells.forEach((el, idx) => this.renderDefenseCell(idx));
    },

    updateSunkLine() {
      this.sunkOppEl.textContent = this.sunkOppShipNames.length
        ? `Sunk: ${this.sunkOppShipNames.join(', ')}` : '\u00A0';
      this.sunkMineEl.textContent = this.sunkMineShipNames.length
        ? `Sunk: ${this.sunkMineShipNames.join(', ')}` : '\u00A0';
    },

    updateScoreLine() {
      this.scoreEl.textContent = `You ${this.score.me} — ${this.score.opp} ${this.api.peerNickname || 'Partner'}`;
    },

    handleGameOver(iWon) {
      this.phase = 'gameover';
      if (iWon) this.score.me++; else this.score.opp++;
      this.updateScoreLine();

      this.attackCells.forEach((el) => { el.disabled = true; });
      this.battleEl.classList.add('bs-hidden');
      this.gameoverEl.classList.remove('bs-hidden');

      const partnerName = this.api.peerNickname || 'Partner';
      this.gameoverTitleEl.textContent = iWon
        ? '🎉 You sank the fleet — Victory!'
        : `💥 ${partnerName} sank your fleet.`;
      this.gameoverSubEl.textContent = iWon
        ? 'Every one of their ships is at the bottom of the sea.'
        : 'Better luck on the next voyage.';
      this.updateStatus();
    },

    requestRematch() {
      const nextRound = this.round + 1;
      this.api.send({ type: 'REMATCH', round: nextRound });
      this.resetForRound(nextRound);
    },

    // ---------------------------------------------------------------------
    // Status banner
    // ---------------------------------------------------------------------

    updateStatus() {
      const partnerName = this.api.peerNickname || 'Partner';
      if (this.phase === 'placing') {
        if (!this.iReady) {
          this.statusEl.textContent = 'Arrange your fleet';
          this.substatusEl.textContent = 'Tap a ship below, then tap the board to place it.';
        } else {
          this.statusEl.textContent = 'Fleet ready!';
          this.substatusEl.textContent = `Waiting for ${partnerName}…`;
        }
      } else if (this.phase === 'battle') {
        this.statusEl.textContent = this.turn === 'me' ? 'Your turn — fire!' : `${partnerName}'s turn…`;
        this.substatusEl.textContent = this.waitingForResult ? 'Shot fired, awaiting result…' : '\u00A0';
      } else if (this.phase === 'gameover') {
        this.statusEl.textContent = 'Game over';
        this.substatusEl.textContent = '\u00A0';
      }
    },

    // ---------------------------------------------------------------------
    // Networking
    // ---------------------------------------------------------------------

    handleMessage(msg) {
      switch (msg.type) {
        case 'READY':
          this.oppReady = true;
          this.updateStatus();
          this.maybeStartBattle();
          break;
        case 'FIRE':
          this.handleIncomingFire(msg.idx);
          break;
        case 'RESULT':
          this.handleIncomingResult(msg);
          break;
        case 'REMATCH':
          this.resetForRound(msg.round);
          break;
      }
    },

    destroy() {
      if (this.unsub) this.unsub();
    },
  };

  window.GameModules = window.GameModules || {};
  window.GameModules['battleship'] = Battleship;
})();