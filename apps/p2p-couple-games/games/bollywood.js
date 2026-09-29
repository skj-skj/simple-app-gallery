(function () {
    "use strict";

    /*
     * Bollywood — a hangman / wordle mix for two.
     *
     * Each round one player is the "setter" and types a movie or series
     * name (any language, letters/digits/spaces only) on the on-screen
     * keyboard. The other is the "guesser": they see one dash per character
     * and tap letters. A hit reveals every copy of that letter; a miss
     * crosses out the next letter of B-O-L-L-Y-W-O-O-D with a "/" and
     * writes the missed letter under it. Reveal the whole title before all
     * 9 letters are crossed and the guesser wins the round, otherwise the
     * setter does. Most rounds won after the session wins.
     *
     * Sync (same patterns as the other games, see Readme):
     * - Host-authoritative setup: only the host picks the round count and
     *   sends CONFIG (with a new `session` number). The guest's "Play Again"
     *   is a request the host turns into a new CONFIG.
     * - Keep secrets local: the title never leaves the setter's device until
     *   the round is over. The guesser gets only its shape ("____ _____"),
     *   sends GUESS, and the setter answers with RESULT (positions, and the
     *   round outcome + full title once the round ends). So the setter is
     *   the authority for its own round.
     * - Deterministic roles: who sets is derived from (round + session), so
     *   no message is needed to agree on it. Setters alternate every round
     *   and the first setter alternates every session.
     * - Every message carries `session` and `round`; stale ones are dropped.
     *   HELLO on open lets a player who re-opens the game mid-session pull
     *   both sides back to the setup screen.
     */

    const ROUND_OPTIONS = [5, 10, 15];
    const DEFAULT_ROUNDS = 5;
    const LIVES_WORD = "BOLLYWOOD";
    const MAX_TITLE_LEN = 40;
    const KB_ROWS = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
    const VALID_CH = /^[A-Z0-9]$/;

    const Bollywood = {
        init(api) {
            this.api = api;
            this.myRole = api.isHost ? "host" : "guest";
            this.partnerName = api.peerNickname || "Partner";
            this.selectedRounds = this.selectedRounds || DEFAULT_ROUNDS; // kept across re-opens
            this.session = 0;
            this.totalRounds = DEFAULT_ROUNDS;
            this.round = 0;
            this.phase = "setup";
            this.results = [];
            this.resetRoundState();

            this.cacheDom();
            this.renderRoundOptions();
            this.bindStaticEvents();
            this.unsub = api.onMessage((msg) => this.handleMessage(msg));

            this.goToSetup();
            this.api.send({ type: "HELLO" });
        },

        resetRoundState() {
            this.secret = null; // setter only: the normalised title
            this.typed = ""; // setter only: text while typing
            this.shape = null; // '_' per character, ' ' for spaces
            this.revealed = []; // char per index once revealed (null otherwise)
            this.wrongs = []; // missed characters, in order
            this.keyState = {}; // ch -> 'hit' | 'miss' | 'pending'
            this.outcome = null; // 'guesser' | 'setter' once the round is over
            this.fullTitle = null; // known to both once the round is over
        },

        // ---------------------------------------------------------------------
        // DOM
        // ---------------------------------------------------------------------

        cacheDom() {
            const $ = (sel) => this.api.root.querySelector(sel);
            this.statusEl = $("#bw-status");
            this.substatusEl = $("#bw-substatus");

            this.setupEl = $("#bw-setup");
            this.roundsOptsEl = $("#bw-rounds-opts");
            this.startBtn = $("#bw-start-btn");
            this.setupWaitingEl = $("#bw-setup-waiting");

            this.playEl = $("#bw-play");
            this.roundLabelEl = $("#bw-round-label");
            this.scoreMeEl = $("#bw-score-me");
            this.scoreOppEl = $("#bw-score-opp");
            this.typingEl = $("#bw-typing");
            this.typedEl = $("#bw-typed");
            this.typedMetaEl = $("#bw-typed-meta");
            this.boardEl = $("#bw-board");
            this.stripEl = $("#bw-strip");
            this.titleEl = $("#bw-title");
            this.waitTitleEl = $("#bw-wait-title");
            this.kbEl = $("#bw-kb");
            this.roundEndEl = $("#bw-round-end");
            this.roundEndTitleEl = $("#bw-round-end-title");
            this.roundEndRevealEl = $("#bw-round-end-reveal");
            this.nextBtn = $("#bw-next-btn");

            this.gameoverEl = $("#bw-gameover");
            this.gameoverTitleEl = $("#bw-gameover-title");
            this.gameoverSubEl = $("#bw-gameover-sub");
            this.historyEl = $("#bw-history");
            this.againBtn = $("#bw-again-btn");
            this.settingsBtn = $("#bw-settings-btn");

            $("#bw-setup-waiting-name").textContent = this.partnerName;
            $("#bw-wait-title-name").textContent = this.partnerName;
            this.scoreOppEl.parentElement.firstChild.textContent = `${this.partnerName}: `;
        },

        renderRoundOptions() {
            this.roundsOptsEl.innerHTML = "";
            ROUND_OPTIONS.forEach((n) => {
                const b = document.createElement("button");
                b.type = "button";
                b.className =
                    "bw-opt" + (n === this.selectedRounds ? " bw-on" : "");
                b.textContent = String(n);
                b.addEventListener("click", () => {
                    this.selectedRounds = n;
                    this.renderRoundOptions();
                });
                this.roundsOptsEl.appendChild(b);
            });
        },

        bindStaticEvents() {
            this.startBtn.addEventListener("click", () =>
                this.hostStartSession(this.selectedRounds),
            );
            this.nextBtn.addEventListener("click", () => this.requestNext());
            this.againBtn.addEventListener("click", () => this.requestAgain());
            this.settingsBtn.addEventListener("click", () => {
                this.api.send({ type: "SETTINGS" });
                this.goToSetup();
            });
        },

        show(el, on) {
            el.classList.toggle("bw-hidden", !on);
        },

        // ---------------------------------------------------------------------
        // Setup / session
        // ---------------------------------------------------------------------

        goToSetup() {
            this.phase = "setup";
            this.show(this.setupEl, this.api.isHost);
            this.show(this.setupWaitingEl, !this.api.isHost);
            this.show(this.playEl, false);
            this.show(this.gameoverEl, false);
            this.updateStatus();
        },

        hostStartSession(rounds) {
            if (!this.api.isHost) return;
            const session = this.session + 1;
            this.api.send({ type: "CONFIG", session, rounds });
            this.startSession(session, rounds);
        },

        startSession(session, rounds) {
            this.session = session;
            this.totalRounds =
                ROUND_OPTIONS.indexOf(rounds) >= 0 ? rounds : DEFAULT_ROUNDS;
            this.selectedRounds = this.totalRounds;
            this.results = [];
            this.show(this.setupEl, false);
            this.show(this.setupWaitingEl, false);
            this.show(this.gameoverEl, false);
            this.show(this.playEl, true);
            this.startRound(1);
        },

        requestAgain() {
            if (this.phase !== "gameover") return;
            if (this.api.isHost) this.hostStartSession(this.totalRounds);
            else
                this.api.send({ type: "AGAIN_REQUEST", session: this.session });
        },

        setterRole(round) {
            return (round + this.session) % 2 === 0 ? "host" : "guest";
        },

        get amSetter() {
            return this.setterRole(this.round) === this.myRole;
        },

        // ---------------------------------------------------------------------
        // Rounds
        // ---------------------------------------------------------------------

        startRound(round) {
            this.round = round;
            this.resetRoundState();
            this.phase = "typing";
            this.show(this.roundEndEl, false);
            this.show(this.boardEl, false);
            this.show(this.typingEl, this.amSetter);
            this.show(this.waitTitleEl, !this.amSetter);
            this.renderScore();
            if (this.amSetter) {
                this.renderKeyboard("type");
                this.renderTyped();
            } else {
                this.renderKeyboard(null);
            }
            this.updateStatus();
        },

        // Either player can move on; the round number makes it idempotent.
        requestNext() {
            if (this.phase !== "roundEnd") return;
            const next = this.round + 1;
            this.api.send({ type: "NEXT", session: this.session, round: next });
            this.goToRound(next);
        },

        goToRound(next) {
            if (next > this.totalRounds) this.showGameOver();
            else this.startRound(next);
        },

        // ---------------------------------------------------------------------
        // Setter: typing the title
        // ---------------------------------------------------------------------

        onTypeKey(key) {
            if (this.phase !== "typing" || !this.amSetter) return;
            if (key === "BACK") {
                this.typed = this.typed.slice(0, -1);
            } else if (key === "SPACE") {
                if (
                    this.typed &&
                    !this.typed.endsWith(" ") &&
                    this.typed.length < MAX_TITLE_LEN
                )
                    this.typed += " ";
            } else if (key === "DONE") {
                this.submitTitle();
                return;
            } else if (
                VALID_CH.test(key) &&
                this.typed.length < MAX_TITLE_LEN
            ) {
                this.typed += key;
            }
            this.renderTyped();
        },

        renderTyped() {
            this.typedEl.innerHTML = "";
            if (this.typed)
                this.typedEl.appendChild(document.createTextNode(this.typed));
            else {
                const ph = document.createElement("span");
                ph.className = "bw-placeholder";
                ph.textContent = "Type a movie or series name…";
                this.typedEl.appendChild(ph);
            }
            const caret = document.createElement("span");
            caret.className = "bw-caret";
            this.typedEl.appendChild(caret);

            const len = this.typed.trim().length;
            const full = this.typed.length >= MAX_TITLE_LEN;
            this.typedMetaEl.textContent = full
                ? `Max ${MAX_TITLE_LEN} characters`
                : `${len}/${MAX_TITLE_LEN} · letters, numbers and spaces only`;
            this.typedMetaEl.classList.toggle("bw-warn", full);
            const done = this.kbEl.querySelector(".bw-key-done");
            if (done) done.disabled = len === 0;
        },

        submitTitle() {
            const title = this.typed.trim().replace(/ +/g, " ");
            if (!title) return;
            this.secret = title;
            this.shape = title.replace(/[A-Z0-9]/g, "_");
            this.revealed = Array(title.length).fill(null);
            this.api.send({
                type: "TITLE_SET",
                session: this.session,
                round: this.round,
                shape: this.shape,
            });
            this.beginGuessing();
        },

        beginGuessing() {
            this.phase = "guessing";
            this.show(this.typingEl, false);
            this.show(this.waitTitleEl, false);
            this.show(this.boardEl, true);
            this.renderKeyboard("guess");
            this.renderStrip();
            this.renderTitle();
            this.updateStatus();
        },

        // ---------------------------------------------------------------------
        // Guessing
        // ---------------------------------------------------------------------

        onGuessKey(ch) {
            if (this.phase !== "guessing" || this.amSetter || this.keyState[ch])
                return;
            this.keyState[ch] = "pending";
            this.refreshKeys();
            this.api.send({
                type: "GUESS",
                session: this.session,
                round: this.round,
                ch,
            });
        },

        // Setter side: the authority for its own round.
        onPartnerGuess(ch) {
            if (
                this.phase !== "guessing" ||
                !this.amSetter ||
                !VALID_CH.test(ch)
            )
                return;
            if (this.keyState[ch] === "hit" || this.keyState[ch] === "miss")
                return;
            const positions = [];
            for (let i = 0; i < this.secret.length; i++)
                if (this.secret[i] === ch) positions.push(i);

            const hidden = this.revealed.filter(
                (c, i) => c === null && this.shape[i] === "_",
            ).length;
            let outcome = null;
            if (positions.length && hidden === positions.length)
                outcome = "guesser";
            else if (
                !positions.length &&
                this.wrongs.length + 1 >= LIVES_WORD.length
            )
                outcome = "setter";

            const msg = {
                type: "RESULT",
                session: this.session,
                round: this.round,
                ch,
                positions,
                outcome,
            };
            if (outcome) msg.title = this.secret;
            this.api.send(msg);
            this.applyResult(msg);
        },

        // Both sides: apply a resolved guess.
        applyResult(msg) {
            const { ch, positions } = msg;
            if (this.keyState[ch] === "hit" || this.keyState[ch] === "miss")
                return;
            if (positions.length) {
                this.keyState[ch] = "hit";
                positions.forEach((i) => {
                    this.revealed[i] = ch;
                });
            } else {
                this.keyState[ch] = "miss";
                this.wrongs.push(ch);
            }
            this.renderStrip(!positions.length);
            this.renderTitle(positions);
            this.refreshKeys();
            if (msg.outcome) this.endRound(msg.outcome, msg.title);
            else this.updateStatus();
        },

        endRound(outcome, title) {
            this.phase = "roundEnd";
            this.outcome = outcome;
            this.fullTitle = title || this.secret || "";
            const setter = this.setterRole(this.round);
            const guesser = setter === "host" ? "guest" : "host";
            this.results[this.round - 1] = {
                winner: outcome === "guesser" ? guesser : setter,
                setter,
                title: this.fullTitle,
            };
            // Any guesses still in flight are void now.
            Object.keys(this.keyState).forEach((k) => {
                if (this.keyState[k] === "pending") delete this.keyState[k];
            });

            this.renderScore();
            this.renderTitle();
            this.refreshKeys();

            const iWon = this.results[this.round - 1].winner === this.myRole;
            let head;
            if (this.amSetter)
                head = iWon
                    ? `😈 You stumped ${this.partnerName}!`
                    : `${this.partnerName} got it!`;
            else
                head = iWon ? "🎉 You got it!" : "💥 BOLLYWOOD is crossed out!";
            this.roundEndTitleEl.textContent = head;
            this.roundEndRevealEl.textContent = this.fullTitle;
            this.nextBtn.textContent =
                this.round >= this.totalRounds ? "See results" : "Next round";
            this.show(this.roundEndEl, true);
            this.updateStatus();
        },

        // ---------------------------------------------------------------------
        // Session over
        // ---------------------------------------------------------------------

        showGameOver() {
            this.phase = "gameover";
            this.show(this.playEl, false);
            this.show(this.gameoverEl, true);
            const { me, opp } = this.tally();
            let title;
            if (me > opp) title = "🎉 You win the session!";
            else if (opp > me)
                title = `🎬 ${this.partnerName} wins the session!`;
            else title = "🤝 It's a tie!";
            this.gameoverTitleEl.textContent = title;
            this.gameoverSubEl.textContent = `You ${me} : ${opp} ${this.partnerName}`;

            this.historyEl.innerHTML = "";
            this.results.forEach((r, i) => {
                const li = document.createElement("li");
                const name = document.createElement("span");
                name.textContent = `${i + 1}. ${r.title}`;
                const who = document.createElement("span");
                const mine = r.winner === this.myRole;
                who.className = mine ? "bw-w-me" : "bw-w-opp";
                who.textContent = mine ? "You" : this.partnerName;
                li.append(name, who);
                this.historyEl.appendChild(li);
            });
            this.updateStatus();
        },

        tally() {
            let me = 0,
                opp = 0;
            this.results.forEach((r) => {
                if (r) {
                    if (r.winner === this.myRole) me++;
                    else opp++;
                }
            });
            return { me, opp };
        },

        // ---------------------------------------------------------------------
        // Rendering
        // ---------------------------------------------------------------------

        renderScore() {
            const { me, opp } = this.tally();
            this.scoreMeEl.textContent = String(me);
            this.scoreOppEl.textContent = String(opp);
            this.roundLabelEl.textContent = `Round ${this.round} / ${this.totalRounds}`;
        },

        renderStrip(animateLast) {
            this.stripEl.innerHTML = "";
            for (let i = 0; i < LIVES_WORD.length; i++) {
                const tile = document.createElement("div");
                tile.className = "bw-life";
                tile.textContent = LIVES_WORD[i];
                if (i < this.wrongs.length) {
                    tile.classList.add("bw-crossed");
                    const slash = document.createElement("span");
                    slash.className = "bw-slash";
                    if (!(animateLast && i === this.wrongs.length - 1))
                        slash.style.animation = "none";
                    const by = document.createElement("span");
                    by.className = "bw-by";
                    by.textContent = this.wrongs[i];
                    tile.append(slash, by);
                }
                this.stripEl.appendChild(tile);
            }
        },

        renderTitle(justOpened) {
            const opened = new Set(justOpened || []);
            const known = this.fullTitle || this.secret; // setter always, guesser after the round
            this.titleEl.innerHTML = "";
            let word = null;
            for (let i = 0; i <= this.shape.length; i++) {
                if (i === this.shape.length || this.shape[i] === " ") {
                    if (word) this.titleEl.appendChild(word);
                    word = null;
                    continue;
                }
                if (!word) {
                    word = document.createElement("div");
                    word.className = "bw-word";
                }
                const slot = document.createElement("div");
                slot.className = "bw-slot";
                if (this.revealed[i]) {
                    slot.textContent = this.revealed[i];
                    if (opened.has(i)) slot.classList.add("bw-open");
                } else if (known) {
                    slot.textContent = known[i];
                    slot.classList.add(
                        this.phase === "roundEnd" ? "bw-missed" : "bw-ghost",
                    );
                }
                word.appendChild(slot);
            }
        },

        // mode: 'type' (setter entering a title), 'guess' (letters for guessing),
        // or null (hidden).
        renderKeyboard(mode) {
            this.kbMode = mode;
            this.kbEl.innerHTML = "";
            this.show(this.kbEl, !!mode);
            if (!mode) return;
            const mkKey = (label, key, extra) => {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "bw-key" + (extra ? " " + extra : "");
                b.textContent = label;
                b.dataset.key = key;
                b.addEventListener("click", () => {
                    if (this.kbMode === "type") this.onTypeKey(key);
                    else this.onGuessKey(key);
                });
                return b;
            };
            KB_ROWS.forEach((row, r) => {
                const rowEl = document.createElement("div");
                rowEl.className = "bw-kb-row";
                if (mode === "type" && r === KB_ROWS.length - 1)
                    rowEl.appendChild(mkKey("⌫", "BACK", "bw-key-wide"));
                for (const ch of row) rowEl.appendChild(mkKey(ch, ch));
                this.kbEl.appendChild(rowEl);
            });
            if (mode === "type") {
                const rowEl = document.createElement("div");
                rowEl.className = "bw-kb-row";
                rowEl.append(
                    mkKey("SPACE", "SPACE", "bw-key-space"),
                    mkKey("DONE ✓", "DONE", "bw-key-wide bw-key-done"),
                );
                this.kbEl.appendChild(rowEl);
            }
            this.refreshKeys();
        },

        refreshKeys() {
            if (this.kbMode !== "guess") return;
            const canGuess = this.phase === "guessing" && !this.amSetter;
            this.kbEl.querySelectorAll(".bw-key").forEach((b) => {
                const st = this.keyState[b.dataset.key];
                b.classList.toggle("bw-key-hit", st === "hit");
                b.classList.toggle("bw-key-miss", st === "miss");
                b.classList.toggle("bw-key-pending", st === "pending");
                b.disabled = !canGuess || !!st;
            });
        },

        updateStatus() {
            const p = this.partnerName;
            let s = "",
                sub = " ";
            switch (this.phase) {
                case "setup":
                    s = this.api.isHost
                        ? "Set up the game"
                        : "Waiting for host";
                    sub = this.api.isHost
                        ? "Pick how many rounds to play."
                        : `${p} is choosing the rounds…`;
                    break;
                case "typing":
                    s = this.amSetter
                        ? "Your turn to pick a title"
                        : `${p} is picking a title`;
                    sub = this.amSetter
                        ? `${p} will try to guess it.`
                        : "Get ready to guess!";
                    break;
                case "guessing": {
                    const left = LIVES_WORD.length - this.wrongs.length;
                    s = this.amSetter
                        ? `${p} is guessing…`
                        : "Guess the title!";
                    sub = `${left} wrong guess${left === 1 ? "" : "es"} left`;
                    break;
                }
                case "roundEnd":
                    s = `Round ${this.round} over`;
                    break;
                case "gameover":
                    s = "Session over";
                    break;
            }
            this.statusEl.textContent = s;
            this.substatusEl.textContent = sub;
        },

        // ---------------------------------------------------------------------
        // Networking
        // ---------------------------------------------------------------------

        isCurrent(msg) {
            return msg.session === this.session && msg.round === this.round;
        },

        handleMessage(msg) {
            switch (msg.type) {
                case "HELLO":
                    // Partner (re)opened the game: anything in progress is gone on
                    // their side, so both start over from setup.
                    if (this.phase !== "setup") this.goToSetup();
                    break;
                case "CONFIG":
                    if (!this.api.isHost && msg.session > this.session)
                        this.startSession(msg.session, msg.rounds);
                    break;
                case "AGAIN_REQUEST":
                    if (
                        this.api.isHost &&
                        this.phase === "gameover" &&
                        msg.session === this.session
                    ) {
                        this.hostStartSession(this.totalRounds);
                    }
                    break;
                case "SETTINGS":
                    if (this.phase !== "setup") this.goToSetup();
                    break;
                case "TITLE_SET":
                    if (
                        this.isCurrent(msg) &&
                        this.phase === "typing" &&
                        !this.amSetter &&
                        typeof msg.shape === "string"
                    ) {
                        this.shape = msg.shape;
                        this.revealed = Array(msg.shape.length).fill(null);
                        this.beginGuessing();
                    }
                    break;
                case "GUESS":
                    if (this.isCurrent(msg)) this.onPartnerGuess(msg.ch);
                    break;
                case "RESULT":
                    if (
                        this.isCurrent(msg) &&
                        this.phase === "guessing" &&
                        !this.amSetter
                    )
                        this.applyResult(msg);
                    break;
                case "NEXT":
                    if (
                        msg.session === this.session &&
                        this.phase === "roundEnd" &&
                        msg.round === this.round + 1
                    ) {
                        this.goToRound(msg.round);
                    }
                    break;
            }
        },

        destroy() {
            if (this.unsub) this.unsub();
        },
    };

    window.GameModules = window.GameModules || {};
    window.GameModules["bollywood"] = Bollywood;
})();
