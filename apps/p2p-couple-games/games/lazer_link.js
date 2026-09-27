(function () {
  'use strict';

  /*
   * Laser Link — cooperative two-player mirror puzzle.
   *
   * Each player owns half the mirrors on a shared grid but can only see
   * their own by default; guiding the beam to the single target means
   * describing your mirrors to your partner and listening to theirs.
   *
   * Config (host-authoritative, same pattern as dots_and_boxes.js and
   * scribble2.js): only the room host sees the setup screen. The guest
   * just waits until the host taps "Start Puzzle", at which point the
   * host generates the puzzle and sends the *entire* deterministic puzzle
   * state — grid size, source, target, every mirror/wall/splitter — in
   * one NEW_PUZZLE message. The guest never generates its own puzzle, so
   * the two sides can never disagree about the board. The same applies to
   * "New Puzzle" after a round ends: whoever isn't the host just asks the
   * host to generate one (REQUEST_NEW_PUZZLE) rather than rolling their
   * own.
   *
   * Puzzle generation is solution-first (see buildSolutionPath): a valid
   * source -> target path is walked out first, with mirrors placed only
   * at the turns that path actually needs, and everything else (decoy
   * mirrors, walls, splitters) is scattered on the *remaining* cells
   * afterwards, so it can never interfere with the intended solution.
   * That makes every generated puzzle solvable by construction — but
   * construction bugs are still bugs, so generatePuzzle() additionally
   * runs the real traceLaser() solver against the solution orientations
   * before handing the puzzle back, and also confirms the puzzle is NOT
   * already solved in its as-generated (scrambled) starting state —
   * discarding/retrying on either mismatch rather than trusting the
   * construction blindly.
   *
   * Networking is intentionally light: only discrete actions cross the
   * wire (MIRROR_ROTATE, GIVE_UP, NEW_PUZZLE, RESETUP). The live beam
   * itself is never synced — both sides run the identical traceLaser()
   * simulation against the same synchronized puzzle + mirror state and
   * therefore always land on the same answer, including "solved", with no
   * extra handshake needed for that part.
   */

  // ---------------------------------------------------------------------
  // Grid / direction primitives
  // ---------------------------------------------------------------------

  const MIN_SIZE = 5;
  const MAX_SIZE = 10;
  const DEFAULT_SIZE = 6;

  const DX = { right: 1, left: -1, up: 0, down: 0 };
  const DY = { right: 0, left: 0, up: -1, down: 1 };

  // '/' mirror: right<->up, left<->down. '\' mirror: right<->down, left<->up.
  const REFLECT_SLASH = { right: 'up', up: 'right', left: 'down', down: 'left' };
  const REFLECT_BACKSLASH = { right: 'down', down: 'right', left: 'up', up: 'left' };
  // Splitters keep it simple: the beam continues straight through AND a
  // second beam peels off 90° clockwise. Only one beam needs to reach the
  // target, so a splitter never has to sit on the solution path itself.
  const ROTATE_CW = { right: 'down', down: 'left', left: 'up', up: 'right' };

  const SOURCE_ARROW = { right: '→', left: '←', up: '↑', down: '↓' };

  function reflect(dir, orient) {
    return orient === '/' ? REFLECT_SLASH[dir] : REFLECT_BACKSLASH[dir];
  }

  function mirrorOrientationFor(oldDir, newDir) {
    return REFLECT_SLASH[oldDir] === newDir ? '/' : '\\';
  }

  function perpendicularOptions(dir) {
    return (dir === 'left' || dir === 'right') ? ['up', 'down'] : ['left', 'right'];
  }

  function move(pos, dir) {
    return { x: pos.x + DX[dir], y: pos.y + DY[dir] };
  }

  function inBounds(pos, N) {
    return pos.x >= 0 && pos.x < N && pos.y >= 0 && pos.y < N;
  }

  function cellKey(pos) {
    return pos.x + ',' + pos.y;
  }

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // ---------------------------------------------------------------------
  // Laser simulation — the single source of truth for "is this solved",
  // used identically for puzzle validation, the live helper beam, and the
  // solution-reveal animation.
  // ---------------------------------------------------------------------

  function cellSegment(x1, y1, x2, y2) {
    return { x1: x1 + 0.5, y1: y1 + 0.5, x2: x2 + 0.5, y2: y2 + 0.5 };
  }

  function edgeSegment(x, y, dir, N) {
    const cx = x + 0.5, cy = y + 0.5;
    let ex = cx, ey = cy;
    if (dir === 'right') ex = N;
    else if (dir === 'left') ex = 0;
    else if (dir === 'down') ey = N;
    else if (dir === 'up') ey = 0;
    return { x1: cx, y1: cy, x2: ex, y2: ey };
  }

  // Traces every beam spawned from the source (following splits) until
  // each one exits the grid, is absorbed by a wall, or loops back to a
  // state it's already visited. `segments` is every travelled line, for
  // drawing the live helper beam. `winningPath`/`winningCells` describe
  // whichever beam reaches the target first, for the solved animation and
  // solution reveal. A visited (x, y, direction) triple is never walked
  // twice — for any one beam that guarantees termination, and the global
  // MAX_STEPS cap guarantees the whole trace terminates regardless.
  function traceLaser(puzzle) {
    const { gridSize: N, laser, target, mirrors, walls, splitters } = puzzle;
    const mirrorMap = new Map(mirrors.map((m) => [cellKey(m), m]));
    const wallSet = new Set((walls || []).map(cellKey));
    const splitterSet = new Set((splitters || []).map(cellKey));

    const segments = [];
    let hitsTarget = false;
    let winningPath = null;
    let winningCells = null;

    const seenStates = new Set();
    const MAX_STEPS = N * N * 8;
    let guard = 0;

    const queue = [{
      x: laser.x, y: laser.y, dir: laser.dir,
      path: [], cells: [{ x: laser.x, y: laser.y }],
    }];

    while (queue.length && guard < MAX_STEPS) {
      const beam = queue.shift();
      let x = beam.x, y = beam.y, dir = beam.dir;
      let path = beam.path;
      let cells = beam.cells;
      let alive = true;

      while (alive) {
        guard++;
        if (guard > MAX_STEPS) break;

        const stateKey = x + ',' + y + ',' + dir;
        if (seenStates.has(stateKey)) break; // loop guard for this beam
        seenStates.add(stateKey);

        const nx = x + DX[dir], ny = y + DY[dir];
        if (nx < 0 || nx >= N || ny < 0 || ny >= N) {
          segments.push(edgeSegment(x, y, dir, N));
          break; // exits the grid
        }

        const seg = cellSegment(x, y, nx, ny);
        segments.push(seg);
        path = path.concat([seg]);
        cells = cells.concat([{ x: nx, y: ny }]);

        const key = nx + ',' + ny;

        if (nx === target.x && ny === target.y) {
          hitsTarget = true;
          if (!winningPath) { winningPath = path; winningCells = cells; }
          break;
        }
        if (wallSet.has(key)) break; // absorbed

        if (mirrorMap.has(key)) {
          dir = reflect(dir, mirrorMap.get(key).orient);
          x = nx; y = ny;
          continue;
        }

        if (splitterSet.has(key)) {
          queue.push({ x: nx, y: ny, dir, path, cells });
          queue.push({ x: nx, y: ny, dir: ROTATE_CW[dir], path, cells });
          alive = false;
          break;
        }

        x = nx; y = ny; // empty cell, keep travelling straight
      }
    }

    return { segments, hitsTarget, winningPath, winningCells };
  }

  // ---------------------------------------------------------------------
  // Puzzle generation
  // ---------------------------------------------------------------------

  function minTurnsForSize(N) {
    if (N <= 6) return 1;
    if (N <= 8) return 2;
    return 3;
  }

  function randomBorderSourceAndDir(N) {
    const edge = randInt(0, 3);
    if (edge === 0) return { pos: { x: randInt(0, N - 1), y: 0 }, dir: 'down' };
    if (edge === 1) return { pos: { x: randInt(0, N - 1), y: N - 1 }, dir: 'up' };
    if (edge === 2) return { pos: { x: 0, y: randInt(0, N - 1) }, dir: 'right' };
    return { pos: { x: N - 1, y: randInt(0, N - 1) }, dir: 'left' };
  }

  // Walks out a guaranteed source -> target path one cell at a time,
  // occasionally dropping a mirror on the cell just reached to bend the
  // path (alternating ownership so both players end up with path mirrors
  // to communicate about). Movement each step is always straight in the
  // *current* direction — a "turn" only changes the direction used on
  // subsequent steps, exactly like a real mirror would.
  function buildSolutionPath(N) {
    const { pos: sourcePos, dir: sourceDir } = randomBorderSourceAndDir(N);
    const visited = new Set([cellKey(sourcePos)]);
    const pathCells = [{ ...sourcePos }];
    const mirrors = [];

    let cur = { ...sourcePos };
    let dir = sourceDir;
    let owner = Math.random() < 0.5 ? 'host' : 'guest';

    const minSteps = Math.max(3, N - 1);
    const maxSteps = N * 2;
    const targetSteps = randInt(minSteps, maxSteps);
    const TURN_PROBABILITY = 0.5;

    for (let step = 0; step < targetSteps; step++) {
      const next = move(cur, dir);
      if (!inBounds(next, N) || visited.has(cellKey(next))) break; // dead end

      pathCells.push(next);
      visited.add(cellKey(next));
      cur = next;

      const isLastStep = step === targetSteps - 1;
      if (!isLastStep && Math.random() < TURN_PROBABILITY) {
        const viable = perpendicularOptions(dir).filter((d) => {
          const n2 = move(cur, d);
          return inBounds(n2, N) && !visited.has(cellKey(n2));
        });
        if (viable.length > 0) {
          const newDir = viable[randInt(0, viable.length - 1)];
          mirrors.push({
            id: 'm' + mirrors.length,
            x: cur.x, y: cur.y,
            orient: mirrorOrientationFor(dir, newDir),
            owner,
          });
          owner = owner === 'host' ? 'guest' : 'host';
          dir = newDir;
        }
      }
    }

    return {
      sourcePos, sourceDir,
      target: { ...cur },
      mirrors, pathCells,
      visited,
    };
  }

  // Scatters decoy mirrors/walls/splitters across whatever cells the
  // solution path doesn't use, so they can never block or shortcut it.
  function scatterDecoys(N, visited, wallsEnabled, splitterEnabled) {
    const emptyCells = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!visited.has(x + ',' + y)) emptyCells.push({ x, y });
      }
    }
    shuffleInPlace(emptyCells);

    let idx = 0;
    const mirrors = [];
    const walls = [];
    const splitters = [];

    const mirrorCount = Math.min(
      emptyCells.length,
      randInt(Math.max(1, Math.floor(N / 3)), Math.max(2, Math.floor(N / 2) + 1))
    );
    for (let i = 0; i < mirrorCount && idx < emptyCells.length; i++, idx++) {
      const c = emptyCells[idx];
      mirrors.push({ x: c.x, y: c.y, orient: Math.random() < 0.5 ? '/' : '\\', owner: Math.random() < 0.5 ? 'host' : 'guest' });
    }

    if (wallsEnabled) {
      const wallCount = Math.min(emptyCells.length - idx, randInt(0, Math.max(1, Math.floor(N / 4)) + 1));
      for (let i = 0; i < wallCount && idx < emptyCells.length; i++, idx++) {
        walls.push({ x: emptyCells[idx].x, y: emptyCells[idx].y });
      }
    }

    if (splitterEnabled) {
      const splitterCount = Math.min(emptyCells.length - idx, randInt(0, N >= 8 ? 2 : 1));
      for (let i = 0; i < splitterCount && idx < emptyCells.length; i++, idx++) {
        splitters.push({ x: emptyCells[idx].x, y: emptyCells[idx].y });
      }
    }

    return { mirrors, walls, splitters };
  }

  function tryBuildPuzzle(N, wallsEnabled, splitterEnabled) {
    const sol = buildSolutionPath(N);
    if (sol.pathCells.length < 2) return null; // source == target, retry
    if (sol.mirrors.length < minTurnsForSize(N)) return null; // too plain, retry

    const decoys = scatterDecoys(N, sol.visited, wallsEnabled, splitterEnabled);

    const pathMirrors = sol.mirrors.map((m) => ({
      id: m.id,
      x: m.x, y: m.y,
      // Scrambled starting orientation — the whole point is that it's
      // *not* already solved. Occasionally landing on the correct
      // orientation by chance is fine; it just means one less to flip.
      orient: Math.random() < 0.5 ? '/' : '\\',
      solutionOrient: m.orient,
      owner: m.owner,
      onPath: true,
    }));

    // Guarantee the puzzle doesn't start pre-solved: if every path
    // mirror's independently-scrambled starting orientation happens to
    // already match the solution (increasingly likely with very few path
    // mirrors, e.g. a 50% chance with just one), flip one so there's
    // always at least something to actually solve.
    if (pathMirrors.length > 0 && pathMirrors.every((m) => m.orient === m.solutionOrient)) {
      pathMirrors[0].orient = pathMirrors[0].orient === '/' ? '\\' : '/';
    }

    let nextId = pathMirrors.length;
    const decoyMirrors = decoys.mirrors.map((m) => ({
      id: 'm' + (nextId++),
      x: m.x, y: m.y,
      orient: m.orient,
      solutionOrient: m.orient, // never required, kept only for symmetry
      owner: m.owner,
      onPath: false,
    }));

    const puzzle = {
      gridSize: N,
      laser: { x: sol.sourcePos.x, y: sol.sourcePos.y, dir: sol.sourceDir },
      target: sol.target,
      mirrors: [...pathMirrors, ...decoyMirrors],
      walls: decoys.walls,
      splitters: decoys.splitters,
    };

    // Defensive validation: actually run the solver with every mirror set
    // to its intended solution orientation and confirm the beam truly
    // reaches the target, rather than trusting the construction above.
    const solvedMirrors = puzzle.mirrors.map((m) => ({ ...m, orient: m.solutionOrient }));
    const check = traceLaser({ ...puzzle, mirrors: solvedMirrors });
    if (!check.hitsTarget) return null;

    // Also confirm the puzzle as actually generated (scrambled starting
    // orientations, including decoys) is NOT already solved. The path
    // mirrors themselves are guaranteed not to already match above, but a
    // decoy mirror or splitter can occasionally line up into an
    // unintended accidental shortcut — rare, but a puzzle that's already
    // solved before anyone touches a mirror isn't a puzzle at all.
    if (traceLaser(puzzle).hitsTarget) return null;

    return puzzle;
  }

  // A trivial, always-solvable straight-line puzzle. Used only as a last
  // resort if generation somehow can't produce a valid puzzle after many
  // attempts, so the game can never get stuck trying forever.
  function fallbackPuzzle(N) {
    const mid = Math.floor(N / 2);
    return {
      gridSize: N,
      laser: { x: 0, y: mid, dir: 'right' },
      target: { x: N - 1, y: mid },
      mirrors: [],
      walls: [],
      splitters: [],
    };
  }

  function generatePuzzle(config) {
    const N = config.gridSize;
    const MAX_ATTEMPTS = 80;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const built = tryBuildPuzzle(N, config.wallsEnabled, config.splitterEnabled);
      if (built) return built;
    }
    return fallbackPuzzle(N);
  }

  // ---------------------------------------------------------------------
  // Game module
  // ---------------------------------------------------------------------

  const SOUND_SCRIPT_SRC = 'games/assets/lazer_link_sounds.js';

  const LazerLink = {
    init(api) {
      this.api = api;
      this.round = -1;
      this.phase = 'setup';
      this.config = null;
      this.puzzle = null;
      this.solved = false;
      this.ended = false;
      this.revealed = false;
      this.gaveUp = { me: false, opp: false };
      this._soundsLoading = false;
      this._animToken = 0;
      this.cellEls = new Map();
      this.mirrorEls = new Map();

      this.setupSelection = { size: DEFAULT_SIZE, walls: false, splitter: false, visibility: false };

      this.cacheDom();
      this.renderSizeGrid();
      this.renderToggle('walls');
      this.renderToggle('splitter');
      this.renderToggle('visibility');
      this.renderLegend();
      this.bindStaticEvents();
      this.unsub = api.onMessage((msg) => this.handleMessage(msg));
      this.loadSounds();

      this.goToSetup();
    },

    destroy() {
      this._animToken++; // invalidate any in-flight animation timeouts
      if (this.unsub) this.unsub();
    },

    // ---------------------------------------------------------------------
    // DOM setup
    // ---------------------------------------------------------------------

    cacheDom() {
      const $ = (sel) => this.api.root.querySelector(sel);

      this.statusEl = $('#lzl-status');
      this.substatusEl = $('#lzl-substatus');

      this.setupEl = $('#lzl-setup');
      this.sizeGridEl = $('#lzl-size-grid');
      this.toggleWallsBtn = $('#lzl-toggle-walls');
      this.toggleSplitterBtn = $('#lzl-toggle-splitter');
      this.toggleVisibilityBtn = $('#lzl-toggle-visibility');
      this.startBtn = $('#lzl-start-btn');
      this.setupWaitingEl = $('#lzl-setup-waiting');
      this.setupWaitingNameEl = $('#lzl-setup-waiting-name');

      this.playEl = $('#lzl-play');
      this.boardEl = $('#lzl-board');
      this.beamLayerEl = $('#lzl-beam-layer');
      this.legendEl = $('#lzl-legend');

      this.controlsActiveEl = $('#lzl-controls-active');
      this.giveupBtn = $('#lzl-giveup-btn');
      this.giveupStatusEl = $('#lzl-giveup-status');

      this.controlsEndEl = $('#lzl-controls-end');
      this.endTitleEl = $('#lzl-end-title');
      this.endSubEl = $('#lzl-end-sub');
      this.newPuzzleBtn = $('#lzl-newpuzzle-btn');
      this.changeSettingsBtn = $('#lzl-changesettings-btn');

      this.setupWaitingNameEl.textContent = this.api.peerNickname || 'Your partner';
    },

    renderSizeGrid() {
      this.sizeGridEl.innerHTML = '';
      for (let s = MIN_SIZE; s <= MAX_SIZE; s++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lzl-size-btn' + (s === this.setupSelection.size ? ' selected' : '');
        btn.textContent = `${s}×${s}`;
        btn.addEventListener('click', () => {
          if (!this.api.isHost) return;
          this.setupSelection.size = s;
          this.renderSizeGrid();
        });
        this.sizeGridEl.appendChild(btn);
      }
    },

    renderToggle(key) {
      const map = { walls: this.toggleWallsBtn, splitter: this.toggleSplitterBtn, visibility: this.toggleVisibilityBtn };
      const btn = map[key];
      const on = this.setupSelection[key];
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    },

    renderLegend() {
      const items = [
        { swatch: 'var(--lzl-source)', label: 'Source' },
        { swatch: 'var(--lzl-target)', label: 'Target' },
        { swatch: 'var(--lzl-me)', label: 'Your mirror' },
        { swatch: 'var(--lzl-opp)', label: "Partner's mirror" },
      ];
      if (this.config && this.config.wallsEnabled) items.push({ swatch: 'var(--lzl-wall)', label: 'Wall' });
      if (this.config && this.config.splitterEnabled) items.push({ swatch: 'var(--lzl-splitter)', label: 'Splitter' });

      this.legendEl.innerHTML = items.map((it) =>
        `<span><span class="lzl-legend-swatch" style="background:${it.swatch}"></span>${it.label}</span>`
      ).join('');
    },

    bindStaticEvents() {
      this.startBtn.addEventListener('click', () => this.onStartClick());
      this.giveupBtn.addEventListener('click', () => this.onGiveUpClick());
      this.newPuzzleBtn.addEventListener('click', () => this.onNewPuzzleClick());
      this.changeSettingsBtn.addEventListener('click', () => this.onChangeSettingsClick());

      this.toggleWallsBtn.addEventListener('click', () => this.onToggleClick('walls'));
      this.toggleSplitterBtn.addEventListener('click', () => this.onToggleClick('splitter'));
      this.toggleVisibilityBtn.addEventListener('click', () => this.onToggleClick('visibility'));

      // Delegated so we don't need a listener per cell — up to 100 of them
      // on a 10x10 board, but this avoids the churn of rebinding on every
      // buildBoard() anyway.
      this.boardEl.addEventListener('click', (e) => {
        const cell = e.target.closest('.lzl-cell');
        if (!cell) return;
        this.onCellTap(Number(cell.dataset.x), Number(cell.dataset.y));
      });
    },

    onToggleClick(key) {
      if (!this.api.isHost) return;
      this.setupSelection[key] = !this.setupSelection[key];
      this.renderToggle(key);
    },

    // ---------------------------------------------------------------------
    // Setup phase
    // ---------------------------------------------------------------------

    goToSetup() {
      this.phase = 'setup';
      this.solved = false;
      this.ended = false;
      this.revealed = false;
      this.gaveUp = { me: false, opp: false };
      this._animToken++;

      this.playEl.classList.add('lzl-hidden');
      if (this.api.isHost) {
        this.setupEl.classList.remove('lzl-hidden');
        this.setupWaitingEl.classList.add('lzl-hidden');
      } else {
        this.setupEl.classList.add('lzl-hidden');
        this.setupWaitingEl.classList.remove('lzl-hidden');
      }
      this.updateStatus();
    },

    onStartClick() {
      if (!this.api.isHost) return;
      this.unlockSound();
      const config = {
        gridSize: this.setupSelection.size,
        wallsEnabled: this.setupSelection.walls,
        splitterEnabled: this.setupSelection.splitter,
        showPartnerMirrors: this.setupSelection.visibility,
      };
      this.generateAndBroadcastNewPuzzle(config);
    },

    onChangeSettingsClick() {
      if (!this.api.isHost) return;
      this.api.send({ type: 'RESETUP' });
      this.goToSetup();
    },

    // ---------------------------------------------------------------------
    // Puzzle lifecycle
    // ---------------------------------------------------------------------

    generateAndBroadcastNewPuzzle(config) {
      const cfg = config || this.config;
      const puzzle = generatePuzzle(cfg);
      const round = this.round + 1;
      this.api.send({ type: 'NEW_PUZZLE', round, config: cfg, puzzle });
      this.applyNewPuzzle({ round, config: cfg, puzzle });
    },

    onNewPuzzleClick() {
      this.unlockSound();
      if (this.api.isHost) {
        this.generateAndBroadcastNewPuzzle(this.config);
      } else {
        this.api.send({ type: 'REQUEST_NEW_PUZZLE' });
      }
    },

    applyNewPuzzle({ round, config, puzzle }) {
      this.round = round;
      this.config = config;
      this.puzzle = puzzle;
      this.phase = 'play';
      this.solved = false;
      this.ended = false;
      this.revealed = false;
      this.gaveUp = { me: false, opp: false };
      this._animToken++;

      this.setupEl.classList.add('lzl-hidden');
      this.setupWaitingEl.classList.add('lzl-hidden');
      this.playEl.classList.remove('lzl-hidden');
      this.controlsEndEl.classList.add('lzl-hidden');
      this.controlsActiveEl.classList.remove('lzl-hidden');
      this.giveupStatusEl.classList.add('lzl-hidden');
      this.giveupBtn.disabled = false;

      this.renderLegend();
      this.buildBoard(puzzle.gridSize);
      this.renderPuzzleContents();
      // Also covers the rare case where every scrambled path mirror
      // happened to land correctly already — detected immediately rather
      // than waiting for a tap that may never come.
      this.retraceAndCheckSolved();
      this.updateStatus();
    },

    // ---------------------------------------------------------------------
    // Board building / rendering
    // ---------------------------------------------------------------------

    buildBoard(N) {
      this.boardEl.style.gridTemplateColumns = `repeat(${N}, 1fr)`;
      this.boardEl.style.gridTemplateRows = `repeat(${N}, 1fr)`;
      this.boardEl.innerHTML = '';
      this.cellEls = new Map();
      this.mirrorEls = new Map();

      const frag = document.createDocumentFragment();
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const cell = document.createElement('div');
          cell.className = 'lzl-cell';
          cell.dataset.x = String(x);
          cell.dataset.y = String(y);
          frag.appendChild(cell);
          this.cellEls.set(cellKey({ x, y }), cell);
        }
      }
      this.boardEl.appendChild(frag);
      this.beamLayerEl.setAttribute('viewBox', `0 0 ${N} ${N}`);
      this.clearBeamLayer('all');
    },

    renderPuzzleContents() {
      const p = this.puzzle;

      (p.walls || []).forEach((w) => {
        const cell = this.cellEls.get(cellKey(w));
        if (cell) cell.classList.add('lzl-wall');
      });
      (p.splitters || []).forEach((s) => {
        const cell = this.cellEls.get(cellKey(s));
        if (cell) cell.innerHTML = '<span class="lzl-icon-splitter" aria-hidden="true"></span>';
      });

      const sourceCell = this.cellEls.get(cellKey(p.laser));
      if (sourceCell) {
        sourceCell.innerHTML = `<span class="lzl-icon-source" aria-hidden="true">${SOURCE_ARROW[p.laser.dir]}</span>`;
      }
      const targetCell = this.cellEls.get(cellKey(p.target));
      if (targetCell) {
        targetCell.innerHTML = '<span class="lzl-icon-target" aria-hidden="true">◎</span>';
      }

      p.mirrors.forEach((m) => this.updateMirrorVisual(m));
    },

    updateMirrorVisual(m) {
      const cell = this.cellEls.get(cellKey(m));
      if (!cell) return;

      const myOwner = this.api.isHost ? 'host' : 'guest';
      const isMine = m.owner === myOwner;
      const visible = this.revealed || isMine || (this.config && this.config.showPartnerMirrors);

      let btn = this.mirrorEls.get(m.id);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lzl-mirror-btn';
        cell.appendChild(btn);
        this.mirrorEls.set(m.id, btn);
      }

      if (!visible) {
        btn.classList.add('lzl-hidden');
        return;
      }
      btn.classList.remove('lzl-hidden');
      btn.textContent = m.orient === '/' ? '╱' : '╲';
      btn.classList.toggle('lzl-mirror-me', isMine);
      btn.classList.toggle('lzl-mirror-opp', !isMine);
      btn.disabled = !isMine || this.solved || this.ended;
      btn.setAttribute(
        'aria-label',
        (isMine ? 'Your mirror, ' : "Partner's mirror, ") +
        (m.orient === '/' ? 'angled like a forward slash' : 'angled like a backslash')
      );
    },

    // ---------------------------------------------------------------------
    // Input
    // ---------------------------------------------------------------------

    onCellTap(x, y) {
      if (this.phase !== 'play' || this.solved || this.ended) return;
      const mirror = this.puzzle.mirrors.find((m) => m.x === x && m.y === y);
      if (!mirror) return;

      const myOwner = this.api.isHost ? 'host' : 'guest';
      if (mirror.owner !== myOwner) return; // not yours to rotate

      this.unlockSound();
      const newOrient = mirror.orient === '/' ? '\\' : '/';
      this.applyRotate(mirror.id, newOrient);
      this.api.send({ type: 'MIRROR_ROTATE', mirrorId: mirror.id, orient: newOrient });
      if (window.LazerLinkSounds) window.LazerLinkSounds.playRotate();
    },

    applyRotate(mirrorId, orient) {
      if (!this.puzzle || this.solved) return;
      const m = this.puzzle.mirrors.find((mm) => mm.id === mirrorId);
      if (!m) return;
      m.orient = orient;
      this.updateMirrorVisual(m);

      const btn = this.mirrorEls.get(mirrorId);
      if (btn) {
        btn.classList.remove('lzl-tapped');
        void btn.offsetWidth; // restart the pop animation
        btn.classList.add('lzl-tapped');
      }

      this.retraceAndCheckSolved();
    },

    // ---------------------------------------------------------------------
    // Simulation / solved detection
    // ---------------------------------------------------------------------

    retraceAndCheckSolved() {
      if (!this.puzzle || this.solved) return;
      const result = traceLaser(this.puzzle);
      this.renderHelperBeam(result.segments);
      if (result.hitsTarget) this.handleSolved(result.winningPath, result.winningCells);
    },

    handleSolved(winningPath, winningCells) {
      this.solved = true;
      this.ended = true;
      this.clearHelperBeam();
      this.puzzle.mirrors.forEach((m) => this.updateMirrorVisual(m)); // lock inputs
      this.highlightCells(winningCells);

      this.startSolutionAnimation(winningPath, () => {
        this.showEndControls({ title: '🎉 Solved!', sub: 'You linked the laser together.' });
      });
      this.updateStatus();
    },

    startSolutionAnimation(path, onDone) {
      const token = this._animToken;
      this.clearBeamLayer('solved');
      if (window.LazerLinkSounds) window.LazerLinkSounds.playBeamTravel();

      const total = path.length;
      const stepMs = total > 0 ? Math.max(45, Math.min(140, 700 / total)) : 0;
      let i = 0;

      const revealNext = () => {
        if (token !== this._animToken) return; // superseded — bail quietly
        if (i >= total) {
          if (window.LazerLinkSounds) window.LazerLinkSounds.playSuccess();
          if (onDone) setTimeout(onDone, 300);
          return;
        }
        this.drawBeamSegment(path[i], 'lzl-solved-line');
        i++;
        setTimeout(revealNext, stepMs);
      };
      revealNext();
    },

    // ---------------------------------------------------------------------
    // Give Up
    // ---------------------------------------------------------------------

    onGiveUpClick() {
      if (this.phase !== 'play' || this.solved || this.gaveUp.me) return;
      this.unlockSound();
      this.gaveUp.me = true;
      this.api.send({ type: 'GIVE_UP' });
      this.updateGiveUpUI();
      this.checkBothGaveUp();
    },

    updateGiveUpUI() {
      const partner = this.api.peerNickname || 'your partner';
      if (this.gaveUp.me && !this.gaveUp.opp) {
        this.giveupBtn.disabled = true;
        this.giveupStatusEl.textContent = `Waiting for ${partner} to give up too…`;
        this.giveupStatusEl.classList.remove('lzl-hidden');
      } else if (!this.gaveUp.me && this.gaveUp.opp) {
        this.giveupStatusEl.textContent = `${partner} wants to give up. Tap Give Up if you agree.`;
        this.giveupStatusEl.classList.remove('lzl-hidden');
      } else {
        this.giveupStatusEl.classList.add('lzl-hidden');
      }
    },

    checkBothGaveUp() {
      if (this.gaveUp.me && this.gaveUp.opp && !this.solved && !this.revealed) {
        this.revealSolution();
      }
    },

    revealSolution() {
      this.revealed = true;
      this.ended = true;
      this.clearHelperBeam();

      // Snap every on-path mirror to its solution orientation and show
      // every mirror (own and partner's alike) — the round is over.
      this.puzzle.mirrors.forEach((m) => { if (m.onPath) m.orient = m.solutionOrient; });
      const result = traceLaser(this.puzzle);
      this.puzzle.mirrors.forEach((m) => this.updateMirrorVisual(m));
      this.highlightCells(result.winningCells);
      this.drawSolutionPath(result.winningPath || result.segments);

      this.showEndControls({
        title: '🏳️ Given up',
        sub: "Here's the solution — your mirrors have been set to it.",
      });
      this.updateStatus();
    },

    // ---------------------------------------------------------------------
    // Beam rendering (SVG overlay)
    // ---------------------------------------------------------------------

    clearBeamLayer(which) {
      const sel = which === 'all' ? '.lzl-helper-line, .lzl-solved-line, .lzl-solution-line'
        : which === 'helper' ? '.lzl-helper-line'
        : which === 'solved' ? '.lzl-solved-line'
        : '.lzl-solution-line';
      this.beamLayerEl.querySelectorAll(sel).forEach((el) => el.remove());
    },

    drawBeamSegment(seg, className) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', seg.x1);
      line.setAttribute('y1', seg.y1);
      line.setAttribute('x2', seg.x2);
      line.setAttribute('y2', seg.y2);
      line.setAttribute('class', className);
      this.beamLayerEl.appendChild(line);
    },

    renderHelperBeam(segments) {
      if (this.solved || this.ended) return;
      this.clearBeamLayer('helper');
      segments.forEach((seg) => this.drawBeamSegment(seg, 'lzl-helper-line'));
    },

    clearHelperBeam() {
      this.clearBeamLayer('helper');
    },

    drawSolutionPath(segments) {
      this.clearBeamLayer('all');
      (segments || []).forEach((seg) => this.drawBeamSegment(seg, 'lzl-solution-line'));
    },

    highlightCells(cells) {
      (cells || []).forEach((c) => {
        const el = this.cellEls.get(cellKey(c));
        if (el) el.classList.add('lzl-solved-path');
      });
    },

    // ---------------------------------------------------------------------
    // End-of-round controls
    // ---------------------------------------------------------------------

    showEndControls({ title, sub }) {
      this.controlsActiveEl.classList.add('lzl-hidden');
      this.controlsEndEl.classList.remove('lzl-hidden');
      this.endTitleEl.textContent = title;
      this.endSubEl.textContent = sub;
      this.changeSettingsBtn.classList.toggle('lzl-hidden', !this.api.isHost);
    },

    // ---------------------------------------------------------------------
    // Status text
    // ---------------------------------------------------------------------

    updateStatus() {
      const partner = this.api.peerNickname || 'Partner';
      if (this.phase === 'setup') {
        this.statusEl.textContent = this.api.isHost ? 'Set up the puzzle' : 'Waiting for host';
        this.substatusEl.textContent = this.api.isHost
          ? 'Choose a grid size and options, then start.'
          : `${partner} is choosing the settings…`;
      } else if (this.solved) {
        this.statusEl.textContent = '🎉 Solved!';
        this.substatusEl.textContent = 'Nice teamwork.';
      } else if (this.revealed) {
        this.statusEl.textContent = 'Gave up';
        this.substatusEl.textContent = 'The solution is shown on the board.';
      } else {
        this.statusEl.textContent = 'Solve it together';
        this.substatusEl.textContent = (this.config && !this.config.showPartnerMirrors)
          ? `Talk to ${partner} — you can only see your own mirrors.`
          : 'Rotate your mirrors to guide the beam.';
      }
    },

    // ---------------------------------------------------------------------
    // Networking
    // ---------------------------------------------------------------------

    handleMessage(msg) {
      switch (msg.type) {
        case 'NEW_PUZZLE':
          this.applyNewPuzzle({ round: msg.round, config: msg.config, puzzle: msg.puzzle });
          break;
        case 'REQUEST_NEW_PUZZLE':
          if (this.api.isHost) this.generateAndBroadcastNewPuzzle(this.config);
          break;
        case 'MIRROR_ROTATE':
          this.applyRotate(msg.mirrorId, msg.orient);
          break;
        case 'GIVE_UP':
          this.gaveUp.opp = true;
          this.updateGiveUpUI();
          this.checkBothGaveUp();
          break;
        case 'RESETUP':
          this.goToSetup();
          break;
      }
    },

    // ---------------------------------------------------------------------
    // Audio
    // ---------------------------------------------------------------------

    loadSounds() {
      if (window.LazerLinkSounds || this._soundsLoading) return;
      this._soundsLoading = true;
      const s = document.createElement('script');
      s.src = SOUND_SCRIPT_SRC;
      s.onload = () => { this._soundsLoading = false; };
      s.onerror = () => {
        this._soundsLoading = false;
        console.error('Laser Link: failed to load sound module at', SOUND_SCRIPT_SRC);
      };
      document.head.appendChild(s);
    },

    unlockSound() {
      if (window.LazerLinkSounds) window.LazerLinkSounds.unlock();
    },
  };

  window.GameModules = window.GameModules || {};
  window.GameModules['lazer_link'] = LazerLink;
})();