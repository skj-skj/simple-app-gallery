/* =========================================================================
   Laser Link sound effects — synthesized entirely with the Web Audio API.
   No audio files: every sound below is generated in code (oscillators,
   noise, envelopes), same approach as games/assets/battleship_sounds.js.
   Exposes window.LazerLinkSounds:
     .unlock()        - call from inside a real user-gesture handler (a
                         click/tap) to create + resume the AudioContext.
                         Browsers (notably iOS Safari) only allow
                         creating/resuming an AudioContext synchronously
                         inside a user gesture, so lazer_link.js calls this
                         on the "Start Puzzle" tap and on every mirror tap.
                         Once unlocked, sounds triggered later by incoming
                         network messages (which aren't user gestures
                         themselves) still play fine because the context
                         is already running.
     .playRotate()    - short, light click for rotating a mirror
     .playBeamTravel()- soft rising sweep, played as the solved beam
                        animates from source to target
     .playSuccess()   - bright, pleasant chime for reaching the target
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

  function safePlay(fn) {
    const c = getCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    try { fn(c); } catch (e) { /* never let a sound glitch break the game */ }
  }

  // ---- Rotate: a light, short "tick" — just enough feedback for a tap ----
  function playRotate() {
    safePlay((c) => {
      const now = c.currentTime;

      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(660, now + 0.05);

      const gain = c.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);

      osc.connect(gain).connect(c.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    });
  }

  // ---- Beam travel: a soft rising sweep, meant to be triggered once as --
  // ---- the solution animation starts (it plays over the whole reveal) ---
  function playBeamTravel() {
    safePlay((c) => {
      const now = c.currentTime;

      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(240, now);
      osc.frequency.exponentialRampToValueAtTime(900, now + 0.9);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(600, now);
      filter.frequency.exponentialRampToValueAtTime(3200, now + 0.9);
      filter.Q.value = 0.8;

      const gain = c.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.08);
      gain.gain.setValueAtTime(0.16, now + 0.7);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.95);

      osc.connect(filter).connect(gain).connect(c.destination);
      osc.start(now);
      osc.stop(now + 1.0);
    });
  }

  // ---- Success: a bright two-note chime for reaching the target ---------
  function playSuccess() {
    safePlay((c) => {
      const now = c.currentTime;
      const notes = [660, 990]; // a quick perfect-fifth rise
      notes.forEach((freq, i) => {
        const start = now + i * 0.11;
        const osc = c.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);

        const gain = c.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.32, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);

        osc.connect(gain).connect(c.destination);
        osc.start(start);
        osc.stop(start + 0.48);
      });

      // A little sparkle on top using filtered noise, timed with the
      // second note.
      const noiseStart = now + 0.11;
      const noise = c.createBufferSource();
      const len = Math.max(1, Math.floor(c.sampleRate * 0.35));
      const buffer = c.createBuffer(1, len, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      noise.buffer = buffer;

      const noiseFilter = c.createBiquadFilter();
      noiseFilter.type = 'highpass';
      noiseFilter.frequency.value = 3500;

      const noiseGain = c.createGain();
      noiseGain.gain.setValueAtTime(0.0001, noiseStart);
      noiseGain.gain.exponentialRampToValueAtTime(0.12, noiseStart + 0.02);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, noiseStart + 0.35);

      noise.connect(noiseFilter).connect(noiseGain).connect(c.destination);
      noise.start(noiseStart);
      noise.stop(noiseStart + 0.35);
    });
  }

  window.LazerLinkSounds = { unlock, playRotate, playBeamTravel, playSuccess };
})();