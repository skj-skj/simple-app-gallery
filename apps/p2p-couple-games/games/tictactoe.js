(function () {
  'use strict';

  const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];

  const TicTacToe = {
    init(api) {
      this.api = api;
      this.mySymbol = api.isHost ? 'X' : 'O';
      this.score = { me: 0, opp: 0, draw: 0 };

      this.boardEl = api.root.querySelector('#ttt-board');
      this.statusEl = api.root.querySelector('#ttt-status');
      this.scoreEl = api.root.querySelector('#ttt-score');
      this.rematchBtn = api.root.querySelector('#ttt-rematch-btn');
      this.rematchBtn.addEventListener('click', () => this.requestRematch());

      this.unsub = api.onMessage((msg) => this.handleMessage(msg));

      this.resetBoard(0);
    },

    // round determines who starts (alternates each rematch, deterministically
    // derived on both sides so no extra handshake is needed).
    resetBoard(round) {
      this.round = round;
      this.board = Array(9).fill(null);
      this.winner = null;
      this.turn = round % 2 === 0 ? 'X' : 'O';
      this.rematchBtn.classList.add('hidden');
      this.render();
    },

    render() {
      this.boardEl.innerHTML = '';
      this.board.forEach((val, i) => {
        const btn = document.createElement('button');
        btn.className = 'ttt-cell';
        btn.textContent = val || '';
        const isMyTurn = !this.winner && !val && this.turn === this.mySymbol;
        btn.disabled = !isMyTurn;
        btn.addEventListener('click', () => this.makeMove(i));
        this.boardEl.appendChild(btn);
      });
      this.updateStatus();
    },

    makeMove(i) {
      if (this.winner || this.board[i] || this.turn !== this.mySymbol) return;
      this.applyMove(i, this.mySymbol);
      this.api.send({ type: 'MOVE', index: i, symbol: this.mySymbol });
    },

    applyMove(i, symbol) {
      this.board[i] = symbol;
      this.turn = symbol === 'X' ? 'O' : 'X';
      this.checkWinner();
      this.render();
    },

    checkWinner() {
      for (const [a, b, c] of WIN_LINES) {
        if (this.board[a] && this.board[a] === this.board[b] && this.board[a] === this.board[c]) {
          this.winner = this.board[a];
          this.tallyScore();
          return;
        }
      }
      if (this.board.every((c) => c)) {
        this.winner = 'draw';
        this.tallyScore();
      }
    },

    tallyScore() {
      if (this.winner === 'draw') this.score.draw++;
      else if (this.winner === this.mySymbol) this.score.me++;
      else this.score.opp++;
      this.scoreEl.textContent = `You ${this.score.me} — ${this.score.opp} Partner (Draws: ${this.score.draw})`;
      this.rematchBtn.classList.remove('hidden');
    },

    updateStatus() {
      if (this.winner === 'draw') this.statusEl.textContent = "It's a draw!";
      else if (this.winner === this.mySymbol) this.statusEl.textContent = 'You win! 🎉';
      else if (this.winner) this.statusEl.textContent = 'Partner wins!';
      else this.statusEl.textContent = this.turn === this.mySymbol ? 'Your turn' : "Partner's turn…";
    },

    requestRematch() {
      const nextRound = this.round + 1;
      this.api.send({ type: 'REMATCH', round: nextRound });
      this.resetBoard(nextRound);
    },

    handleMessage(msg) {
      if (msg.type === 'MOVE') {
        this.applyMove(msg.index, msg.symbol);
      } else if (msg.type === 'REMATCH') {
        this.resetBoard(msg.round);
      }
    },

    destroy() {
      if (this.unsub) this.unsub();
    },
  };

  window.GameModules = window.GameModules || {};
  window.GameModules['tictactoe'] = TicTacToe;
})();
