// Beat FX no estilo dos mixers DJM: tempo sincronizado ao BPM.

export const BEATS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16, 32];
export const BEAT_LABELS = ['1/16', '1/8', '1/4', '1/2', '3/4', '1', '2', '4', '8', '16', '32'];

// beat = índice padrão em BEATS; tail = deixa o rastro soar ao desligar
export const FX_TYPES = [
  { id: 'ECHO', beat: 3, tail: true },
  { id: 'DELAY', beat: 3, tail: true },
  { id: 'PING PONG', beat: 3, tail: true },
  { id: 'REVERB', beat: 6, tail: true },
  { id: 'FLANGER', beat: 9, tail: false },
  { id: 'PHASER', beat: 9, tail: false },
  { id: 'FILTER', beat: 8, tail: false },
  { id: 'TRANS', beat: 2, tail: false },
  { id: 'ROLL', beat: 3, tail: false },
];

// Quanto do sinal seco e do efeito sai, conforme LEVEL/DEPTH
export function mixLevels(id, depth) {
  switch (id) {
    case 'ECHO':
    case 'DELAY':
    case 'PING PONG':
      return { dry: 1, wet: depth };
    case 'REVERB':
      return { dry: 1 - depth * 0.35, wet: depth * 0.9 };
    case 'FLANGER':
    case 'PHASER':
      return { dry: 1 - depth * 0.5, wet: depth };
    default:   // FILTER, TRANS, ROLL substituem o som
      return { dry: 1 - depth, wet: depth };
  }
}

function makeIR(actx, secs) {
  const sr = actx.sampleRate;
  const n = Math.floor(sr * secs);
  const buf = actx.createBuffer(2, n, sr);
  const pre = Math.floor(sr * 0.012);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / (n - pre);
      lp += ((Math.random() * 2 - 1) - lp) * (0.6 - 0.45 * t);   // fica mais escuro no fim
      d[i] = lp * Math.pow(1 - t, 2.2);
    }
  }
  return buf;
}

export function createFx(actx, id) {
  const input = actx.createGain();
  const output = actx.createGain();
  const now = () => actx.currentTime;
  const oscs = [];
  const lfo = (freq, amount, ...params) => {
    const o = actx.createOscillator();
    const gn = actx.createGain();
    o.frequency.value = freq;
    gn.gain.value = amount;
    o.connect(gn);
    params.forEach((p) => gn.connect(p));
    o.start();
    oscs.push(o);
    return o;
  };
  const fx = { input, output, set() {}, start() {}, stop() {} };

  switch (id) {
    case 'ECHO':
    case 'DELAY': {
      const d = actx.createDelay(8);
      const fb = actx.createGain();
      const lp = actx.createBiquadFilter();
      const hp = actx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = id === 'ECHO' ? 3800 : 14000;
      hp.type = 'highpass';
      hp.frequency.value = id === 'ECHO' ? 160 : 40;
      fb.gain.value = id === 'ECHO' ? 0.62 : 0.25;
      input.connect(d);
      d.connect(lp).connect(hp).connect(output);
      hp.connect(fb).connect(d);
      fx.set = (len) => d.delayTime.setTargetAtTime(Math.min(len, 7.9), now(), 0.03);
      break;
    }
    case 'PING PONG': {
      const dL = actx.createDelay(8), dR = actx.createDelay(8);
      const pL = actx.createStereoPanner(), pR = actx.createStereoPanner();
      const fb = actx.createGain();
      pL.pan.value = -1;
      pR.pan.value = 1;
      fb.gain.value = 0.55;
      input.connect(dL);
      dL.connect(pL).connect(output);
      dL.connect(dR);
      dR.connect(pR).connect(output);
      dR.connect(fb).connect(dL);
      fx.set = (len) => {
        const t = Math.min(len, 3.9);
        dL.delayTime.setTargetAtTime(t, now(), 0.03);
        dR.delayTime.setTargetAtTime(t, now(), 0.03);
      };
      break;
    }
    case 'REVERB': {
      const conv = actx.createConvolver();
      const hp = actx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 200;
      input.connect(hp).connect(conv).connect(output);
      let lastIdx = -1;
      fx.set = (len, idx) => {
        if (idx === lastIdx) return;
        lastIdx = idx;
        conv.buffer = makeIR(actx, 0.5 + idx * 0.42);   // BEAT ajusta o tamanho da sala
      };
      break;
    }
    case 'FLANGER': {
      const d = actx.createDelay(0.05);
      const fb = actx.createGain();
      d.delayTime.value = 0.0035;
      fb.gain.value = 0.6;
      input.connect(d).connect(output);
      d.connect(fb).connect(d);
      const o = lfo(0.25, 0.0028, d.delayTime);
      fx.set = (len) => o.frequency.setTargetAtTime(1 / len, now(), 0.05);
      break;
    }
    case 'PHASER': {
      const stages = [0, 1, 2, 3, 4, 5].map(() => {
        const ap = actx.createBiquadFilter();
        ap.type = 'allpass';
        ap.frequency.value = 900;
        ap.Q.value = 0.7;
        return ap;
      });
      let node = input;
      for (const s of stages) { node.connect(s); node = s; }
      node.connect(output);
      const o = lfo(0.25, 750, ...stages.map((s) => s.frequency));
      fx.set = (len) => o.frequency.setTargetAtTime(1 / len, now(), 0.05);
      break;
    }
    case 'FILTER': {
      const f = actx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2600;
      f.Q.value = 7;
      input.connect(f).connect(output);
      const o = lfo(0.25, 2350, f.frequency);
      fx.set = (len) => o.frequency.setTargetAtTime(1 / len, now(), 0.05);
      break;
    }
    case 'TRANS': {
      const gate = actx.createGain();
      gate.gain.value = 0.5;
      input.connect(gate).connect(output);
      const o = actx.createOscillator();
      o.type = 'square';
      const amt = actx.createGain();
      amt.gain.value = 0.5;
      o.connect(amt).connect(gate.gain);
      o.start();
      oscs.push(o);
      fx.set = (len) => o.frequency.setTargetAtTime(1 / len, now(), 0.01);
      break;
    }
    case 'ROLL': {
      // grava 1 trecho do tamanho do BEAT e repete em loop
      const rin = actx.createGain();
      const d = actx.createDelay(8);
      const fb = actx.createGain();
      rin.gain.value = 0;
      fb.gain.value = 0;
      input.connect(rin);
      rin.connect(d).connect(output);
      rin.connect(output);
      d.connect(fb).connect(d);
      let active = false, curLen = 0.5;
      const begin = () => {
        const t = now();
        d.delayTime.cancelScheduledValues(t);
        d.delayTime.setValueAtTime(curLen, t);
        rin.gain.cancelScheduledValues(t);
        rin.gain.setValueAtTime(1, t);
        rin.gain.setValueAtTime(0, t + curLen);
        fb.gain.cancelScheduledValues(t);
        fb.gain.setValueAtTime(0, t);
        fb.gain.setValueAtTime(1, t + curLen - 0.001);
      };
      fx.set = (len) => {
        curLen = Math.min(len, 7.9);
        if (active) begin();
      };
      fx.start = () => { active = true; begin(); };
      fx.stop = () => {
        active = false;
        const t = now();
        rin.gain.cancelScheduledValues(t);
        rin.gain.setValueAtTime(0, t);
        fb.gain.cancelScheduledValues(t);
        fb.gain.setValueAtTime(0, t);
      };
      break;
    }
  }

  fx.dispose = () => {
    oscs.forEach((o) => { try { o.stop(); } catch { /* já parado */ } });
    input.disconnect();
    output.disconnect();
  };
  return fx;
}
