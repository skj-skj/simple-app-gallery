(function () {
  'use strict';

  const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
  const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

  // NOTE on fairness: choices are sent as soon as picked, with no
  // commit/reveal handshake — a peer that stalls could technically wait
  // to see your move first. That trade-off is intentional for a simple,
  // trusted, two-player casual game. If you ever need it to be cheat-proof,
  // swap `pick()` to send a hash of the choice first and reveal after both
  // hashes are in.

  const RPS = {
    init(api) {
      this.api = api;
      this.score = { me: 0, opp: 0, draw: 0 };
      this.myChoice = null;
      this.oppChoice = null;

      this.statusEl = api.root.querySelector('#rps-status');
      this.resultEl = api.root.querySelector('#rps-result');
      this.scoreEl = api.root.querySelector('#rps-score');
      this.againBtn = api.root.querySelector('#rps-again-btn');
      this.choiceBtns = Array.from(api.root.querySelectorAll('.rps-choice'));

      this.choiceBtns.forEach((btn) => {
        btn.addEventListener('click', () => this.pick(btn.dataset.choice));
      });
      this.againBtn.addEventListener('click', () => this.playAgain());

      this.unsub = api.onMessage((msg) => this.handleMessage(msg));

      this.reset();
    },

    reset() {
      this.myChoice = null;
      this.oppChoice = null;
      this.resultEl.classList.add('hidden');
      this.againBtn.classList.add('hidden');
      this.statusEl.textContent = 'Pick your move!';
      this.choiceBtns.forEach((b) => { b.disabled = false; b.classList.remove('selected'); });
    },

    pick(choice) {
      if (this.myChoice) return;
      this.myChoice = choice;
      this.choiceBtns.forEach((b) => {
        b.disabled = true;
        b.classList.toggle('selected', b.dataset.choice === choice);
      });
      this.statusEl.textContent = 'Waiting for partner…';
      this.api.send({ type: 'CHOICE', choice });
      this.maybeResolve();
    },

    handleMessage(msg) {
      if (msg.type === 'CHOICE') {
        this.oppChoice = msg.choice;
        this.maybeResolve();
      } else if (msg.type === 'RESET') {
        this.reset();
      }
    },

    maybeResolve() {
      if (!this.myChoice || !this.oppChoice) return;

      let outcome;
      if (this.myChoice === this.oppChoice) outcome = 'draw';
      else if (BEATS[this.myChoice] === this.oppChoice) outcome = 'win';
      else outcome = 'lose';

      if (outcome === 'draw') { this.score.draw++; this.statusEl.textContent = "It's a draw!"; }
      else if (outcome === 'win') { this.score.me++; this.statusEl.textContent = 'You win! 🎉'; }
      else { this.score.opp++; this.statusEl.textContent = 'Partner wins!'; }

      this.resultEl.innerHTML =
        `<span>${EMOJI[this.myChoice]}</span><span class="vs">vs</span><span>${EMOJI[this.oppChoice]}</span>`;
      this.resultEl.classList.remove('hidden');
      this.scoreEl.textContent = `You ${this.score.me} — ${this.score.opp} Partner (Draws: ${this.score.draw})`;
      this.againBtn.classList.remove('hidden');
    },

    playAgain() {
      this.api.send({ type: 'RESET' });
      this.reset();
    },

    destroy() {
      if (this.unsub) this.unsub();
    },
  };

  window.GameModules = window.GameModules || {};
  window.GameModules['rps'] = RPS;
})();
