// Detecção de BPM simples: envelope de ataques + autocorrelação com pente
// (lag, 2×lag, 4×lag) e varredura fina. Bom o bastante para música com batida.

export function detectBPM(L, sr) {
  const hop = 512;
  const fps = sr / hop;
  let start = Math.floor(L.length * 0.15);
  let end = Math.min(L.length, start + Math.floor(sr * 60));
  if (end - start < sr * 10) { start = 0; end = L.length; }
  const n = Math.floor((end - start) / hop);
  if (n < fps * 6) return null;

  const env = new Float32Array(n);
  let prevLe = 0, lp = 0;
  for (let k = 0; k < n; k++) {
    let e = 0;
    const o = start + k * hop;
    for (let i = 0; i < hop; i++) {
      lp += (L[o + i] - lp) * 0.08;    // dá mais peso ao grave (bumbo)
      e += lp * lp + L[o + i] * L[o + i] * 0.25;
    }
    const le = Math.log(1e-9 + e);
    env[k] = Math.max(0, le - prevLe);
    prevLe = le;
  }
  let mean = 0;
  for (let k = 0; k < n; k++) mean += env[k];
  mean /= n;
  for (let k = 0; k < n; k++) env[k] -= mean;

  const minLag = fps * 60 / 180, maxLag = fps * 60 / 70;
  const maxAc = Math.min(n - 1, Math.ceil(maxLag * 4) + 2);
  const ac = new Float32Array(maxAc + 1);
  for (let lag = 1; lag <= maxAc; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (n - lag);
  }
  const acAt = (x) => {
    const i = Math.floor(x), f = x - i;
    if (i + 1 > maxAc) return 0;
    return ac[i] * (1 - f) + ac[i + 1] * f;
  };

  let best = 0, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 0.02) {
    const bpm = 60 * fps / lag;
    const pref = 1 - Math.abs(Math.log2(bpm / 110)) * 0.15;   // leve preferência por 85–140
    const score = (acAt(lag) + acAt(lag * 2) * 0.5 + acAt(lag * 4) * 0.25) * pref;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (!best || bestScore <= 0) return null;
  return Math.round(600 * fps / best) / 10;
}
