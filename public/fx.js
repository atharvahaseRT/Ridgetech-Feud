/* Ridgetech Feud FX: synthesized WebAudio sounds + DOM animation helpers. Exposes window.FX. */
(function () {
  'use strict';

  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('rtf:muted') === '1'; } catch (e) { /* storage blocked */ }

  // Browsers only allow audio after a user gesture: create/resume the context on the first one.
  function ac() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((t) => window.addEventListener(t, ac, { passive: true }));

  function tone(c, freq, t, dur, type = 'sine', gain = 0.2, to) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  let noiseBuf = null;
  function noise(c, t, dur, gain = 0.3, highpass = 0) {
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = c.createBufferSource();
    s.buffer = noiseBuf;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = s;
    if (highpass) {
      const f = c.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = highpass;
      s.connect(f);
      node = f;
    }
    node.connect(g).connect(c.destination);
    s.start(t);
    s.stop(t + dur + 0.02);
  }

  const SOUNDS = {
    ding(c, t) {
      tone(c, 880, t, 0.6, 'sine', 0.25);
      tone(c, 1320, t + 0.08, 0.7, 'sine', 0.18);
      tone(c, 1760, t + 0.16, 0.5, 'triangle', 0.08);
    },
    buzz(c, t) {
      tone(c, 140, t, 0.45, 'sawtooth', 0.18);
      tone(c, 147, t, 0.45, 'square', 0.07);
    },
    strike(c, t) {
      tone(c, 170, t, 0.55, 'sine', 0.55, 38);
      tone(c, 90, t, 0.6, 'square', 0.07, 45);
      noise(c, t, 0.2, 0.35);
    },
    tick(c, t) { tone(c, 1000, t, 0.06, 'square', 0.08); },
    countdown(c, t) { for (let i = 0; i < 3; i++) tone(c, 900, t + i, 0.08, 'square', 0.08); },
    go(c, t) {
      tone(c, 1568, t, 0.18, 'square', 0.1);
      tone(c, 2093, t + 0.09, 0.25, 'square', 0.09);
    },
    alarm(c, t) { for (let i = 0; i < 6; i++) tone(c, i % 2 ? 950 : 700, t + i * 0.18, 0.16, 'square', 0.1); },
    chip(c, t) {
      tone(c, 2000, t, 0.08, 'triangle', 0.12);
      tone(c, 2600, t + 0.06, 0.12, 'triangle', 0.1);
    },
    drumroll(c, t) {
      const n = 60;
      for (let i = 0; i < n; i++) noise(c, t + i * 0.035, 0.05, 0.04 + (0.22 * i) / n, 700);
      noise(c, t + n * 0.035, 1.2, 0.3, 5000);
      tone(c, 523, t + n * 0.035, 0.8, 'triangle', 0.12);
    },
    fanfare(c, t) {
      [523, 659, 784, 1047].forEach((f, i) => tone(c, f, t + i * 0.14, 0.25, 'triangle', 0.2));
      [523, 659, 784, 1047].forEach((f) => tone(c, f, t + 0.65, 1.1, 'triangle', 0.12));
      tone(c, 1568, t + 0.65, 1.1, 'sine', 0.06);
    },
  };

  function play(name) {
    if (muted || !SOUNDS[name]) return;
    const c = ac();
    if (!c) return;
    try { SOUNDS[name](c, c.currentTime + 0.01); } catch (e) { /* audio is best-effort */ }
  }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem('rtf:muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  // Restart a one-shot CSS class animation on an element.
  function pulse(el, cls, ms) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth; // reflow so the animation restarts
    el.classList.add(cls);
    clearTimeout(el['_t_' + cls]);
    el['_t_' + cls] = setTimeout(() => el.classList.remove(cls), ms);
  }

  const flare = (el) => { if (!reduced()) pulse(el, 'flare', 900); };
  const chase = (el) => { if (!reduced()) pulse(el, 'chase', 1800); };
  const stamp = () => pulse(document.getElementById('stamp'), 'show', 950);
  const shake = () => { if (!reduced()) pulse(document.querySelector('.game-grid'), 'shake', 500); }; // not #app: a transform there would re-anchor the fixed host bar

  function confetti(count = 140) {
    if (reduced()) return;
    const colors = ['#f2c14e', '#ff6b35', '#2ec4b6', '#e9c46a', '#c77dff', '#ffffff'];
    const box = document.createElement('div');
    box.className = 'confetti';
    box.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < count; i++) {
      const p = document.createElement('i');
      p.style.left = Math.random() * 100 + 'vw';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', (Math.random() * 40 - 20) + 'vw');
      p.style.setProperty('--rot', (Math.random() * 1080 - 540) + 'deg');
      p.style.animationDuration = 2.4 + Math.random() * 2 + 's';
      p.style.animationDelay = Math.random() * 0.8 + 's';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 5500);
  }

  window.FX = { play, setMuted, isMuted: () => muted, flare, chase, stamp, shake, confetti };
})();
