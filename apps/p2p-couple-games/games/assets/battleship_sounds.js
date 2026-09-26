/* =========================================================================
   Battleship sound effects — synthesized entirely with the Web Audio API.
   No audio files: every sound below is generated in code (noise bursts,
   oscillators, envelopes). Exposes window.BattleshipSounds:
     .unlock()    - call from inside a real user-gesture handler (a click/tap)
                    to create + resume the AudioContext. Browsers (notably
                    iOS Safari) only allow creating/resuming an AudioContext
                    synchronously inside a user gesture, so battleship.js
                    calls this on every tap during placement/battle. Once
                    unlocked, sounds triggered later by incoming network
                    messages (which aren't user gestures themselves) still
                    play fine because the context is already running.
     .playHit()   - short sharp clang, for a hit that didn't sink a ship
     .playMiss()  - soft splash/plunk, for a shot that missed
     .playSink()  - bomb-blast / ship-sinking explosion (low boom + noise)
   All functions are no-ops (fail silently) if Web Audio isn't available.
   ========================================================================= */
(function () {
  'use strict';

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  let ctx = null;

  function getCtx() {
    if (!AudioCtor) return null;
    if (!ctx) {
      try { ctx = new AudioCtor(); } catch (e) { ctx = null; }
    }
    return ctx;
  }

  function unlock() {
    const c = getCtx();
    if (c && c.state === 'suspended') {
      c.resume().catch(() => {});
    }
  }

  // A short buffer of white noise, used as the raw material for splashes,
  // clangs, and explosions (shaped afterwards by filters + envelopes).
  function makeNoiseBuffer(c, seconds) {
    const len = Math.max(1, Math.floor(c.sampleRate * seconds));
    const buffer = c.createBuffer(1, len, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function safePlay(fn) {
    const c = getCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    try { fn(c); } catch (e) { /* never let a sound glitch break the game */ }
  }

  // ---- Hit: a bright, short metallic clang ------------------------------
  function playHit() {
    safePlay((c) => {
      const now = c.currentTime;

      const osc = c.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(720, now);
      osc.frequency.exponentialRampToValueAtTime(180, now + 0.12);

      const gain = c.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.5, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

      osc.connect(gain).connect(c.destination);
      osc.start(now);
      osc.stop(now + 0.2);

      // A touch of noise on top for a "clang" texture.
      const noise = c.createBufferSource();
      noise.buffer = makeNoiseBuffer(c, 0.08);
      const noiseFilter = c.createBiquadFilter();
      noiseFilter.type = 'highpass';
      noiseFilter.frequency.value = 1500;
      const noiseGain = c.createGain();
      noiseGain.gain.setValueAtTime(0.25, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      noise.connect(noiseFilter).connect(noiseGain).connect(c.destination);
      noise.start(now);
      noise.stop(now + 0.09);
    });
  }

  // ---- Miss: a soft, quick water splash ----------------------------------
  function playMiss() {
    safePlay((c) => {
      const now = c.currentTime;

      const noise = c.createBufferSource();
      noise.buffer = makeNoiseBuffer(c, 0.3);
      const filter = c.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1200, now);
      filter.frequency.exponentialRampToValueAtTime(400, now + 0.25);
      filter.Q.value = 0.7;

      const gain = c.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

      noise.connect(filter).connect(gain).connect(c.destination);
      noise.start(now);
      noise.stop(now + 0.3);
    });
  }

  // ---- Sink: bomb-blast / ship-sinking explosion -------------------------
  function playSink() {
    safePlay((c) => {
      const now = c.currentTime;
      const master = c.createGain();
      master.gain.value = 0.9;
      master.connect(c.destination);

      // Low sub-bass "boom" — a sine that drops in pitch fast.
      const boom = c.createOscillator();
      boom.type = 'sine';
      boom.frequency.setValueAtTime(160, now);
      boom.frequency.exponentialRampToValueAtTime(35, now + 0.5);
      const boomGain = c.createGain();
      boomGain.gain.setValueAtTime(0.0001, now);
      boomGain.gain.exponentialRampToValueAtTime(1, now + 0.015);
      boomGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      boom.connect(boomGain).connect(master);
      boom.start(now);
      boom.stop(now + 0.95);

      // A slightly detuned second oscillator thickens the boom.
      const boom2 = c.createOscillator();
      boom2.type = 'triangle';
      boom2.frequency.setValueAtTime(90, now);
      boom2.frequency.exponentialRampToValueAtTime(28, now + 0.6);
      const boom2Gain = c.createGain();
      boom2Gain.gain.setValueAtTime(0.0001, now);
      boom2Gain.gain.exponentialRampToValueAtTime(0.6, now + 0.02);
      boom2Gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
      boom2.connect(boom2Gain).connect(master);
      boom2.start(now);
      boom2.stop(now + 0.85);

      // Explosion noise burst — filtered white noise sweeping down,
      // this is the "crackle/blast" layer.
      const noise = c.createBufferSource();
      noise.buffer = makeNoiseBuffer(c, 1.1);
      const noiseFilter = c.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.setValueAtTime(4500, now);
      noiseFilter.frequency.exponentialRampToValueAtTime(120, now + 1.0);
      const noiseGain = c.createGain();
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.8, now + 0.01);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
      noise.connect(noiseFilter).connect(noiseGain).connect(master);
      noise.start(now);
      noise.stop(now + 1.1);

      // A brief sharp crack right at the very start (transient attack).
      const crack = c.createBufferSource();
      crack.buffer = makeNoiseBuffer(c, 0.05);
      const crackFilter = c.createBiquadFilter();
      crackFilter.type = 'highpass';
      crackFilter.frequency.value = 800;
      const crackGain = c.createGain();
      crackGain.gain.setValueAtTime(0.6, now);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      crack.connect(crackFilter).connect(crackGain).connect(master);
      crack.start(now);
      crack.stop(now + 0.06);
    });
  }

  window.BattleshipSounds = { unlock, playHit, playMiss, playSink };
})();