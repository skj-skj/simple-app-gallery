/* =========================================================================
   Building Fall sound effects — synthesized entirely with the Web Audio API.
   No audio files: every sound is generated in code (oscillators, a shared
   noise buffer, envelopes), same approach as battleship_sounds.js and
   lazer_link_sounds.js.

   Exposes window.BuildingFallSounds:
     .unlock()               - call from inside a real user gesture (tap /
                               click). iOS Safari and Chrome only allow an
                               AudioContext to start inside a gesture;
                               building_fall.js calls this on every button
                               tap. Sounds triggered later by network
                               events then play because the context has
                               already been started once.
     .setMuted(bool) / .isMuted()
     .playCountdownTick(strong) - quiet tick; strong=true for the last 3 s
     .playJump()             - short falling whoosh
     .playSafeLanding()      - soft thud + gentle two-note rise
     .playFire()             - crackle + descending tone
     .playScore()            - tiny "+10" blip
     .playFloorTransition()  - soft upward sweep when a new floor starts
     .playWin() / .playLose() / .playDraw()

   Battery / voice-call friendliness:
     - Everything is short (< 0.8 s) and runs through a quiet master gain,
       because players are usually on a voice call at the same time.
     - The context is suspended again after a few idle seconds and while
       the page is hidden, so the audio thread isn't kept running (on
       Android an idle-but-running context keeps the audio output open).
       It's resumed on the next sound.
   All functions fail silently if Web Audio isn't available.
   ========================================================================= */
(function () {
  'use strict';

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  const MASTER_VOLUME = 0.45;
  const IDLE_SUSPEND_MS = 4000;
  const MUTE_KEY = 'bf_muted';

  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let idleTimer = null;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* private mode */ }

  function getCtx() {
    if (!AudioCtor) return null;
    if (!ctx) {
      try {
        ctx = new AudioCtor();
        master = ctx.createGain();
        master.gain.value = MASTER_VOLUME;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; }
    }
    return ctx;
  }

  function unlock() {
    const c = getCtx();
    if (!c) return;
    if (c.state !== 'running') c.resume().catch(() => {});
    // iOS: playing a silent buffer inside the gesture fully unlocks output.
    try {
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    } catch (e) { /* ignore */ }
    scheduleIdleSuspend();
  }

  function scheduleIdleSuspend() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    }, IDLE_SUSPEND_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  });

  // Run fn(ctx, t0) once the context is running. Never throws.
  function safePlay(fn) {
    if (muted) return;
    const c = getCtx();
    if (!c) return;
    const run = () => {
      try { fn(c, c.currentTime + 0.01); } catch (e) { /* never break the game */ }
      scheduleIdleSuspend();
    };
    if (c.state === 'running') run();
    else c.resume().then(() => { if (c.state === 'running') run(); }).catch(() => {});
  }

  function getNoise(c) {
    if (!noiseBuffer || noiseBuffer.sampleRate !== c.sampleRate) {
      const len = Math.floor(c.sampleRate * 0.8);
      noiseBuffer = c.createBuffer(1, len, c.sampleRate);
      const d = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuffer;
  }

  // One enveloped oscillator note.
  function tone(c, { type = 'sine', freq, freqEnd, start, dur, vol, attack = 0.008 }) {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, start + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // Enveloped, filtered noise burst.
  function noise(c, { start, dur, vol, filter = 'bandpass', f0, f1, q = 1 }) {
    const src = c.createBufferSource();
    src.buffer = getNoise(c);
    const bf = c.createBiquadFilter();
    bf.type = filter;
    bf.Q.value = q;
    bf.frequency.setValueAtTime(f0, start);
    if (f1) bf.frequency.exponentialRampToValueAtTime(f1, start + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(bf).connect(g).connect(master);
    src.start(start);
    src.stop(start + dur + 0.02);
  }

  // ---- Countdown: quiet tick; the last 3 seconds get a firmer one -------
  function playCountdownTick(strong) {
    safePlay((c, t) => {
      if (strong) tone(c, { type: 'triangle', freq: 1320, start: t, dur: 0.09, vol: 0.28, attack: 0.004 });
      else tone(c, { type: 'sine', freq: 1000, start: t, dur: 0.045, vol: 0.12, attack: 0.003 });
    });
  }

  // ---- Jump: short downward whoosh --------------------------------------
  function playJump() {
    safePlay((c, t) => {
      noise(c, { start: t, dur: 0.42, vol: 0.32, filter: 'bandpass', f0: 2200, f1: 350, q: 1.2 });
      tone(c, { type: 'sine', freq: 520, freqEnd: 180, start: t, dur: 0.38, vol: 0.08 });
    });
  }

  // ---- Safe landing: soft thud and a gentle rising pair ------------------
  function playSafeLanding() {
    safePlay((c, t) => {
      tone(c, { type: 'sine', freq: 150, freqEnd: 70, start: t, dur: 0.14, vol: 0.4, attack: 0.004 });
      tone(c, { type: 'triangle', freq: 523, start: t + 0.06, dur: 0.22, vol: 0.18 });
      tone(c, { type: 'triangle', freq: 784, start: t + 0.15, dur: 0.3, vol: 0.18 });
    });
  }

  // ---- Fire: crackle burst plus a falling, slightly buzzy tone -----------
  function playFire() {
    safePlay((c, t) => {
      noise(c, { start: t, dur: 0.55, vol: 0.34, filter: 'lowpass', f0: 1800, f1: 300, q: 0.7 });
      noise(c, { start: t + 0.05, dur: 0.3, vol: 0.12, filter: 'highpass', f0: 3000, q: 0.5 });
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(320, t);
      osc.frequency.exponentialRampToValueAtTime(90, t + 0.5);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.52);
      osc.connect(lp).connect(g).connect(master);
      osc.start(t); osc.stop(t + 0.55);
    });
  }

  // ---- Score: tiny confirmation blip -------------------------------------
  function playScore() {
    safePlay((c, t) => {
      tone(c, { type: 'sine', freq: 880, freqEnd: 1320, start: t, dur: 0.12, vol: 0.14 });
    });
  }

  // ---- Floor transition: soft upward sweep -------------------------------
  function playFloorTransition() {
    safePlay((c, t) => {
      tone(c, { type: 'sine', freq: 300, freqEnd: 520, start: t, dur: 0.26, vol: 0.09, attack: 0.03 });
    });
  }

  // ---- Results -----------------------------------------------------------
  function playWin() {
    safePlay((c, t) => {
      [523, 659, 784, 1047].forEach((f, i) =>
        tone(c, { type: 'triangle', freq: f, start: t + i * 0.09, dur: i === 3 ? 0.4 : 0.16, vol: 0.2 }));
    });
  }

  function playLose() {
    safePlay((c, t) => {
      [440, 370, 294].forEach((f, i) =>
        tone(c, { type: 'triangle', freq: f, start: t + i * 0.14, dur: i === 2 ? 0.4 : 0.18, vol: 0.17 }));
    });
  }

  function playDraw() {
    safePlay((c, t) => {
      tone(c, { type: 'sine', freq: 587, start: t, dur: 0.2, vol: 0.16 });
      tone(c, { type: 'sine', freq: 587, start: t + 0.2, dur: 0.2, vol: 0.16 });
      tone(c, { type: 'sine', freq: 880, start: t + 0.2, dur: 0.3, vol: 0.08 });
    });
  }

  function setMuted(v) {
    muted = !!v;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (muted && ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  }

  window.BuildingFallSounds = {
    unlock, setMuted, isMuted: () => muted,
    playCountdownTick, playJump, playSafeLanding, playFire, playScore,
    playFloorTransition, playWin, playLose, playDraw,
  };
})();