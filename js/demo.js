// Gera um "disco de batalha" de demonstração: samples "ahh" para scratch
// no começo e depois um breakbeat a 92 BPM. Tudo sintetizado, sem arquivos.

function biquadBandpass(sr, f, q) {
  const w = 2 * Math.PI * f / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0, b1: 0, b2: -alpha / a0,
    a1: -2 * Math.cos(w) / a0, a2: (1 - alpha) / a0,
    x1: 0, x2: 0, y1: 0, y2: 0,
  };
}

function runBiquad(bq, x) {
  const y = bq.b0 * x + bq.b1 * bq.x1 + bq.b2 * bq.x2 - bq.a1 * bq.y1 - bq.a2 * bq.y2;
  bq.x2 = bq.x1; bq.x1 = x; bq.y2 = bq.y1; bq.y1 = y;
  return y;
}

function makeAhh(sr, dur, f0a, f0b) {
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  const formants = [[730, 8, 1], [1090, 10, 0.5], [2440, 12, 0.25]].map(
    ([f, q, g]) => ({ bq: biquadBandpass(sr, f, q), g })
  );
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const k = t / dur;
    const vib = 1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t);
    const f0 = (f0a + (f0b - f0a) * k) * vib;
    phase += f0 / sr;
    phase -= Math.floor(phase);
    const src = (phase * 2 - 1) + (Math.random() - 0.5) * 0.15;
    let y = 0;
    for (const fm of formants) y += runBiquad(fm.bq, src) * fm.g;
    const env = Math.min(1, t / 0.02) * Math.pow(1 - k, 0.6);
    out[i] = y * env * 1.6;
  }
  return out;
}

function makeKick(sr) {
  const n = Math.floor(sr * 0.45);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 45 + 95 * Math.exp(-t * 28);
    ph += 2 * Math.PI * f / sr;
    out[i] = Math.sin(ph) * Math.exp(-t * 7) * 0.95 + (i < 60 ? (Math.random() - 0.5) * 0.3 : 0);
  }
  return out;
}

function makeSnare(sr) {
  const n = Math.floor(sr * 0.3);
  const out = new Float32Array(n);
  const bp = biquadBandpass(sr, 1800, 0.7);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += 2 * Math.PI * 190 / sr;
    const tone = Math.sin(ph) * Math.exp(-t * 30) * 0.5;
    const noise = runBiquad(bp, Math.random() * 2 - 1) * Math.exp(-t * 16) * 1.1;
    out[i] = tone + noise;
  }
  return out;
}

function makeHat(sr, open) {
  const n = Math.floor(sr * (open ? 0.25 : 0.05));
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const w = Math.random() * 2 - 1;
    const hp = w - prev;
    prev = w;
    out[i] = hp * Math.exp(-t * (open ? 14 : 70)) * 0.22;
  }
  return out;
}

function makeStab(sr, freqs, dur) {
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  const phases = freqs.flatMap(() => [0, 0]);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    freqs.forEach((f, j) => {
      for (let d = 0; d < 2; d++) {
        const k = j * 2 + d;
        phases[k] += f * (d ? 1.006 : 0.994) / sr;
        phases[k] -= Math.floor(phases[k]);
        s += phases[k] * 2 - 1;
      }
    });
    const cutoff = 0.08 + 0.25 * Math.exp(-t * 9);
    lp += (s - lp) * cutoff;
    out[i] = lp * Math.exp(-t * 4) * 0.12;
  }
  return out;
}

function mixIn(dst, src, at, gain) {
  const start = Math.floor(at);
  const end = Math.min(dst.length, start + src.length);
  for (let i = Math.max(0, start); i < end; i++) dst[i] += src[i - start] * gain;
}

export function makeDemoTrack(sr) {
  const bpm = 92;
  const beat = 60 / bpm;
  const intro = 8;
  const bars = 16;
  const duration = intro + bars * 4 * beat + 2;
  const out = new Float32Array(Math.floor(sr * duration));

  const ahh = makeAhh(sr, 0.75, 210, 150);
  const ahhLow = makeAhh(sr, 0.6, 160, 120);
  const kick = makeKick(sr);
  const snare = makeSnare(sr);
  const hat = makeHat(sr, false);
  const ohat = makeHat(sr, true);
  const stabA = makeStab(sr, [220, 261.6, 329.6], 0.6);
  const stabB = makeStab(sr, [196, 246.9, 293.7], 0.6);

  // Seção de scratch: "ahh" isolado, como num disco de batalha
  for (let k = 0; k < 4; k++) {
    mixIn(out, k % 2 ? ahhLow : ahh, sr * (0.3 + k * 2), 0.9);
  }

  const step = beat / 4;
  const kicks = [0, 7, 10];
  const bassNotes = [55, 55, 49, 41.2];
  for (let bar = 0; bar < bars; bar++) {
    const t0 = intro + bar * 4 * beat;
    for (let st = 0; st < 16; st++) {
      const t = (t0 + st * step) * sr;
      if (kicks.includes(st)) mixIn(out, kick, t, 0.9);
      if (st === 4 || st === 12) mixIn(out, snare, t, 0.7);
      if (st % 2 === 0 && st !== 14) mixIn(out, hat, t, 1);
      if (st === 14) mixIn(out, ohat, t, 0.8);
    }
    if (bar % 4 === 0) mixIn(out, ahh, t0 * sr, 0.55);
    mixIn(out, bar % 2 ? stabB : stabA, (t0 + 6 * step) * sr, 1);

    // linha de baixo simples
    const f = bassNotes[bar % 4];
    const len = Math.floor(beat * 3 * sr);
    const st0 = Math.floor(t0 * sr);
    let ph = 0;
    for (let i = 0; i < len && st0 + i < out.length; i++) {
      const t = i / sr;
      ph += f / sr;
      const v = Math.sin(2 * Math.PI * ph) + 0.3 * Math.sin(4 * Math.PI * ph);
      out[st0 + i] += v * 0.28 * Math.min(1, t / 0.01) * Math.exp(-t * 0.9);
    }
  }

  // limitador suave
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * 0.9);
  return { L: out, R: out, duration: out.length / sr };
}
