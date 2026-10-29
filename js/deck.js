import { TAU, clamp, view, offscreen, roundRect, circle, text, glow } from './draw.js';

// ---------------------------------------------------------------------------
// Geometria de um toca-discos em mm (coordenadas locais do deck)
// ---------------------------------------------------------------------------
export const DW = 453, DH = 360;
export const NOMINAL = 100 / 3;
const PC = { x: 186, y: 172 };
const PLATTER_R = 166;
const RECORD_R = 151;
const GROOVE_OUT = 146;
const GROOVE_IN = 62;
const RUNOUT_R = 56;
const LABEL_R = 50;
const PIVOT = { x: 382, y: 84 };
const ARM_L = 230;
const HEAD_OFFSET = 0.38;
const SEC_PER_REV = 1.8;   // 1 volta em 33⅓ = 1,8 s de áudio

const UI = {
  power: { x: 30, y: 326, r: 15 },
  lamp: { x: 34, y: 284 },
  start: { x: 52, y: 322, w: 48, h: 30 },
  s33: { x: 108, y: 337, w: 22, h: 15 },
  s45: { x: 134, y: 337, w: 22, h: 15 },
  fader: { x: 436, y0: 214, y1: 332 },
  cue: { x: 422, y: 120, w: 18, h: 32 },
  quartz: { x: 436, y: 199 },
  antiskate: { x: 432, y: 38 },
};

// Fileiras do estroboscópio: +6,6%, +3,3%, 0%, −3,3% (lâmpada pisca 120×/s)
const STROBE_DEF = [0.066, 0.033, 0, -0.033].map((p, i) => ({
  p, r: 154 + i * 3.2, n: Math.round(7200 / (NOMINAL * (1 + p))),
}));

export function buildStrobeImages(pxmm) {
  const size = 2 * PLATTER_R * pxmm;
  return STROBE_DEF.map((row) => {
    const img = offscreen(size, size);
    const c = img.getContext('2d');
    c.setTransform(pxmm, 0, 0, pxmm, PLATTER_R * pxmm, PLATTER_R * pxmm);
    c.fillStyle = '#e9ebec';
    const dot = Math.min(2.2, TAU * row.r / row.n * 0.45);
    for (let k = 0; k < row.n; k++) {
      c.save();
      c.rotate(k / row.n * TAU);
      c.fillRect(row.r - 1, -dot / 2, 2, dot);
      c.restore();
    }
    return img;
  });
}

const FINISH = {
  black: {
    top: ['#36383b', '#2a2b2e', '#1f2022'], line: 'rgba(255,255,255,0.18)', ink: '#c3c5c8',
    inkSoft: '#9a9da1', brushed: 0.035, well: '#141516',
  },
  silver: {
    top: ['#d3d4d2', '#bfc0be', '#a9aaa8'], line: 'rgba(255,255,255,0.5)', ink: '#3b3d40',
    inkSoft: '#4a4c4f', brushed: 0.05, well: '#2a2b2d',
  },
};

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function rot(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

function inRect(p, b, pad = 5) {
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function stylusAt(th) {
  return { x: PIVOT.x - ARM_L * Math.sin(th), y: PIVOT.y + ARM_L * Math.cos(th) };
}

function thetaForRadius(r) {
  let lo = 0, hi = 1.1;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const s = stylusAt(mid);
    if (Math.hypot(s.x - PC.x, s.y - PC.y) > r) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function armGeometry(th) {
  const dir = { x: -Math.sin(th), y: Math.cos(th) };
  const st = stylusAt(th);
  const hd = rot(dir, HEAD_OFFSET);
  const col = { x: st.x - hd.x * 44, y: st.y - hd.y * 44 };
  return { dir, st, hd, col };
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i];
    out[i] = v <= -1 ? -32768 : v >= 1 ? 32767 : v * 32767;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Um toca-discos
// ---------------------------------------------------------------------------
export class Deck {
  constructor(id, ox, env) {
    this.id = id;
    this.ox = ox;
    this.env = env;           // { cfg, buzz, audio: { actx }, strobe: [] }
    this.S = {
      power: true, motor: false, base: NOMINAL, pitch: 0,
      platterRPM: 0, recordRPM: 0,
      platterAngle: Math.random() * TAU, recordAngle: Math.random() * TAU,
      scratching: false, arm: 'rest', armTheta: 0, lift: 0.4, cueUp: false,
      track: null, pressed: new Set(),
    };
    this.rows = STROBE_DEF.map(() => ({ angle: Math.random() }));
    this.node = null;
    this.report = { pos: 0, rate: 0, t: 0 };
    this.lastSentRate = NaN;
    this.pending = null;
    this.lowerTimer = 0;
    this.lastFaderTap = 0;
    this.scratch = { id: null, lastA: 0, total: 0, base: 0, vel: 0, lastT: 0, lastMove: 0, sentZero: false };
    this.recordImg = null;
    this.sheen = null;
  }

  get cfg() { return this.env.cfg; }
  get actx() { return this.env.audio.actx; }

  // ----- áudio -------------------------------------------------------------
  attach(node) {
    this.node = node;
    node.port.onmessage = (e) => { this.report = e.data; };
    this.post({ type: 'crackle', on: this.cfg.crackle });
    if (this.pending) {
      const t = this.pending;
      this.pending = null;
      this.sendTrack(t);
    }
  }

  post(msg, transfer) {
    if (this.node) this.node.port.postMessage(msg, transfer || []);
  }

  audioPos() {
    if (!this.actx || !this.node) return this.S.track ? -1.2 : 0;
    const dt = clamp(this.actx.currentTime - this.report.t, 0, 0.1);
    return this.report.pos + this.report.rate * dt;
  }

  setTrack(info, data) {
    this.S.track = { title: info.title, duration: info.duration, bpm: info.bpm || null };
    this.buildRecordImage();
    this.liftNeedle();
    this.S.arm = 'rest';
    if (this.node) this.sendTrack(data);
    else this.pending = data;
  }

  sendTrack(t) {
    const L = toInt16(t.L);
    const R = t.R && t.R !== t.L ? toInt16(t.R) : null;
    this.post({ type: 'load', L, R, int16: true, length: L.length, startPos: -1.2 }, R ? [L.buffer, R.buffer] : [L.buffer]);
    this.report = { pos: -1.2, rate: 0, t: this.actx.currentTime };
    this.lastSentRate = NaN;
    this.dropNeedle(-1.2);
  }

  targetRPM() {
    return this.S.base * (1 + this.S.pitch * this.cfg.range / 100);
  }

  bpmNow() {
    const t = this.S.track;
    return t && t.bpm ? t.bpm * this.targetRPM() / NOMINAL : null;
  }

  // ----- braço -------------------------------------------------------------
  posToRadius(p) {
    const D = this.S.track ? this.S.track.duration : 60;
    if (p < 0) return Math.min(RECORD_R - 1.5, GROOVE_OUT + -p * 2.2);
    if (p <= D) return GROOVE_OUT - (GROOVE_OUT - GROOVE_IN) * (p / D);
    return Math.max(RUNOUT_R, GROOVE_IN - (p - D) * 3);
  }

  radiusToPos(r) {
    const D = this.S.track ? this.S.track.duration : 60;
    if (r > GROOVE_OUT) return -(r - GROOVE_OUT) / 2.2;
    if (r >= GROOVE_IN) return (GROOVE_OUT - r) / (GROOVE_OUT - GROOVE_IN) * D;
    return D + (GROOVE_IN - r) / 3;
  }

  liftNeedle() {
    clearTimeout(this.lowerTimer);
    this.post({ type: 'needle', down: false });
  }

  dropNeedle(pos) {
    const S = this.S;
    clearTimeout(this.lowerTimer);
    this.post({ type: 'seek', pos });
    this.report = { pos, rate: 0, t: this.actx ? this.actx.currentTime : 0 };
    S.armTheta = thetaForRadius(this.posToRadius(pos));
    if (S.cueUp) { S.arm = 'cued'; return; }
    S.arm = 'lowering';
    this.lastSentRate = NaN;
    this.lowerTimer = setTimeout(() => {
      S.arm = 'play';
      this.lastSentRate = NaN;
      this.post({ type: 'needle', down: true, thump: true });
      if (S.scratching) {
        this.post({ type: 'grab' });
        this.scratch.total = 0;
        this.scratch.base = S.recordAngle;
      }
    }, 160);
  }

  setCue(up) {
    const S = this.S;
    S.cueUp = up;
    this.env.buzz();
    if (up && (S.arm === 'play' || S.arm === 'lowering')) {
      this.liftNeedle();
      S.arm = 'cued';
    } else if (!up && S.arm === 'cued') {
      S.arm = 'lowering';
      this.lowerTimer = setTimeout(() => {
        S.arm = 'play';
        this.lastSentRate = NaN;
        this.post({ type: 'needle', down: true, thump: true });
      }, 420);
    }
  }

  // ----- física ------------------------------------------------------------
  physics(dt) {
    const S = this.S, cfg = this.cfg;
    let rpm = S.platterRPM;
    if (S.power && S.motor) {
      const diff = this.targetRPM() - rpm;
      const accel = Math.min(NOMINAL / cfg.startTime, Math.abs(diff) * 10);
      rpm += Math.sign(diff) * Math.min(Math.abs(diff), accel * dt);
    } else if (S.power) {
      const decel = Math.min(NOMINAL / cfg.brakeTime, Math.abs(rpm) * 12 + 2);
      rpm -= Math.sign(rpm) * Math.min(Math.abs(rpm), decel * dt);
    } else {
      const decel = 1.1 + Math.abs(rpm) * 0.11;   // sem energia: gira solto
      rpm -= Math.sign(rpm) * Math.min(Math.abs(rpm), decel * dt);
    }
    S.platterRPM = rpm;
    S.platterAngle += rpm / 60 * TAU * dt;

    if (!S.scratching) {
      // feltro (slipmat) arrasta o disco de volta à velocidade do prato
      const diff = S.platterRPM - S.recordRPM;
      const a = Math.min(320, Math.abs(diff) * 60);
      S.recordRPM += Math.sign(diff) * Math.min(Math.abs(diff), a * dt);
      S.recordAngle += S.recordRPM / 60 * TAU * dt;
    }

    // estroboscópio: movimento aparente sob luz piscando
    const omega = S.platterRPM / 60 * TAU;
    STROBE_DEF.forEach((def, i) => {
      const sp = TAU / def.n;
      const phi = omega / 120;
      this.rows[i].angle += (phi - sp * Math.round(phi / sp)) * 120 * dt;
    });

    // mão parada no disco = velocidade zero
    const sc = this.scratch;
    if (S.scratching && !sc.sentZero && performance.now() - sc.lastMove > 28) {
      sc.vel = 0;
      sc.sentZero = true;
      this.sendScratch();
    }

    if (!S.scratching) {
      const want = S.arm === 'play' ? S.recordRPM / NOMINAL : 0;
      if (!(Math.abs(want - this.lastSentRate) < 1e-5)) {
        this.post({ type: 'rate', rate: want });
        this.lastSentRate = want;
      }
    }

    if (S.arm === 'play' && S.track) S.armTheta = thetaForRadius(this.posToRadius(this.audioPos()));
    else if (S.arm === 'rest') S.armTheta += (0 - S.armTheta) * Math.min(1, dt * 6);
    const liftTarget = S.arm === 'play' ? 0 : S.arm === 'rest' ? 0.35 : 1;
    S.lift += (liftTarget - S.lift) * Math.min(1, dt * 10);
  }

  // ----- desenho fixo (corpo) ------------------------------------------------
  drawStatic(c, pxmm) {
    const F = FINISH[this.cfg.finish] || FINISH.black;
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 14 * pxmm;
    c.shadowOffsetY = 5 * pxmm;
    roundRect(c, 0, 0, DW, DH, 9);
    c.fillStyle = F.top[2];
    c.fill();
    c.restore();

    const body = c.createLinearGradient(0, 0, DW * 0.3, DH);
    F.top.forEach((col, i) => body.addColorStop(i / 2, col));
    roundRect(c, 0, 0, DW, DH, 9);
    c.fillStyle = body;
    c.fill();
    c.save();
    roundRect(c, 0, 0, DW, DH, 9);
    c.clip();
    let seed = this.id === 'A' ? 7 : 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < DH; y += 0.7) {
      c.strokeStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${rnd() * F.brushed})`;
      c.lineWidth = 0.35;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(DW, y);
      c.stroke();
    }
    c.restore();
    roundRect(c, 0.5, 0.5, DW - 1, DH - 1, 9);
    c.strokeStyle = F.line;
    c.lineWidth = 0.8;
    c.stroke();

    for (const hx of [40, 330]) {
      roundRect(c, hx, -1, 44, 7, 1.5);
      c.fillStyle = '#151618';
      c.fill();
    }

    c.save();
    c.shadowColor = 'rgba(0,0,0,0.55)';
    c.shadowBlur = 6 * pxmm;
    c.shadowOffsetY = 2 * pxmm;
    circle(c, PC.x, PC.y, PLATTER_R + 1.5);
    c.fillStyle = F.well;
    c.fill();
    c.restore();

    const pl = c.createLinearGradient(PC.x - PLATTER_R, PC.y - PLATTER_R, PC.x + PLATTER_R, PC.y + PLATTER_R);
    pl.addColorStop(0, '#d9dbdc');
    pl.addColorStop(0.45, '#8e9194');
    pl.addColorStop(0.55, '#a8abad');
    pl.addColorStop(1, '#5d6063');
    circle(c, PC.x, PC.y, PLATTER_R);
    c.fillStyle = pl;
    c.fill();
    circle(c, PC.x, PC.y, PLATTER_R - 14.5);
    c.fillStyle = '#4a4c4f';
    c.fill();
    circle(c, PC.x, PC.y, RECORD_R + 0.8);
    c.fillStyle = '#121213';
    c.fill();

    const ink = F.ink;
    text(c, 'QUARTZ  DIRECT  DRIVE  TURNTABLE  SYSTEM', 300, 352, 5.2, { weight: 500, color: F.inkSoft });
    text(c, 'SL-1200MK2', 14, 14, 7.5, { align: 'left', weight: 800, color: ink });
    text(c, this.id, 14, 26, 6, { align: 'left', weight: 800, color: '#ff7a1a' });
    text(c, 'POWER', UI.power.x, UI.power.y + 23, 4.2, { color: ink });
    text(c, 'OFF', UI.power.x - 15, UI.power.y - 19, 3.6, { color: ink });
    text(c, 'ON', UI.power.x + 15, UI.power.y - 19, 3.6, { color: ink });
    text(c, 'START·STOP', UI.start.x + UI.start.w / 2, UI.start.y - 5, 4.2, { color: ink });
    text(c, '33', UI.s33.x + UI.s33.w / 2, UI.s33.y - 5, 4.6, { weight: 700, color: ink });
    text(c, '45', UI.s45.x + UI.s45.w / 2, UI.s45.y - 5, 4.6, { weight: 700, color: ink });
    text(c, 'R.P.M.', 162, UI.s33.y + 7.5, 3.6, { align: 'left', color: ink });
    text(c, 'QUARTZ', UI.quartz.x - 8, UI.quartz.y - 7, 3.4, { color: ink });
    text(c, 'LOCK', UI.quartz.x - 8, UI.quartz.y - 3, 3.4, { color: ink });
    text(c, 'CUE', UI.cue.x + UI.cue.w / 2, UI.cue.y - 5, 4, { color: ink });
    text(c, 'ANTI-SKATING', UI.antiskate.x, UI.antiskate.y + 15, 3, { weight: 500, color: ink });

    const f = UI.fader;
    roundRect(c, f.x - 12, f.y0 - 12, 24, f.y1 - f.y0 + 24, 3);
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fill();
    roundRect(c, f.x - 1.8, f.y0 - 6, 3.6, f.y1 - f.y0 + 12, 1.8);
    c.fillStyle = '#0b0b0c';
    c.fill();
    for (let i = -8; i <= 8; i++) {
      const y = f.y0 + (i + 8) / 16 * (f.y1 - f.y0);
      const major = i % 4 === 0;
      c.strokeStyle = ink;
      c.lineWidth = major ? 0.6 : 0.35;
      c.beginPath();
      c.moveTo(f.x - 13, y);
      c.lineTo(f.x - (major ? 7 : 9.5), y);
      c.stroke();
      if (major) {
        const v = Math.round(i / 8 * this.cfg.range);
        const label = v === 0 ? '0' : (v > 0 ? '+' : '−') + Math.abs(v);
        text(c, label, f.x - 15, y, 4, { align: 'right', weight: 700, color: ink });
      }
    }
    text(c, 'PITCH ADJ.', f.x - 14, f.y1 + 14, 3.6, { color: ink });

    c.save();
    c.shadowColor = 'rgba(0,0,0,0.4)';
    c.shadowBlur = 4 * pxmm;
    circle(c, PIVOT.x, PIVOT.y, 33);
    c.fillStyle = '#1c1d1f';
    c.fill();
    c.restore();
    circle(c, PIVOT.x, PIVOT.y, 27);
    const ring = c.createLinearGradient(PIVOT.x - 27, PIVOT.y - 27, PIVOT.x + 27, PIVOT.y + 27);
    ring.addColorStop(0, '#5a5c5f');
    ring.addColorStop(1, '#232426');
    c.fillStyle = ring;
    c.fill();
    for (let k = 0; k < 48; k++) {
      const a = k / 48 * TAU;
      c.strokeStyle = 'rgba(255,255,255,0.12)';
      c.lineWidth = 0.4;
      c.beginPath();
      c.moveTo(PIVOT.x + Math.cos(a) * 24, PIVOT.y + Math.sin(a) * 24);
      c.lineTo(PIVOT.x + Math.cos(a) * 27, PIVOT.y + Math.sin(a) * 27);
      c.stroke();
    }
    circle(c, PIVOT.x, PIVOT.y, 18);
    c.fillStyle = '#121314';
    c.fill();

    const restPt = { x: PIVOT.x - 4, y: PIVOT.y + ARM_L * 0.72 };
    roundRect(c, restPt.x - 7, restPt.y - 5, 14, 10, 2);
    c.fillStyle = '#111214';
    c.fill();
    roundRect(c, restPt.x - 4, restPt.y - 3, 8, 6, 2);
    c.fillStyle = '#3a3b3e';
    c.fill();

    circle(c, UI.antiskate.x, UI.antiskate.y, 9);
    c.fillStyle = '#1e1f21';
    c.fill();
    circle(c, UI.antiskate.x, UI.antiskate.y, 7);
    c.fillStyle = '#8c8f92';
    c.fill();

    roundRect(c, UI.cue.x, UI.cue.y, UI.cue.w, UI.cue.h, 3);
    c.fillStyle = '#111214';
    c.fill();

    circle(c, UI.lamp.x, UI.lamp.y, 8);
    c.fillStyle = '#18191b';
    c.fill();
  }

  // O disco (sulcos + selo) é desenhado uma vez e depois só girado
  buildRecordImage() {
    const pxmm = this.env.pxmm || 2;
    const size = 2 * RECORD_R * pxmm;
    this.recordImg = offscreen(size, size);
    const c = this.recordImg.getContext('2d');
    c.setTransform(pxmm, 0, 0, pxmm, RECORD_R * pxmm, RECORD_R * pxmm);

    circle(c, 0, 0, RECORD_R);
    c.fillStyle = '#0b0b0c';
    c.fill();
    circle(c, 0, 0, RECORD_R - 0.6);
    c.strokeStyle = '#2a2a2c';
    c.lineWidth = 1.2;
    c.stroke();

    let seed = this.id === 'A' ? 3 : 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const step = Math.max(0.22, 0.9 / pxmm);
    for (let r = GROOVE_IN; r < GROOVE_OUT; r += step) {
      const v = 14 + Math.floor(rnd() * 10);
      c.strokeStyle = `rgb(${v},${v},${v + 1})`;
      c.lineWidth = step * 0.55;
      circle(c, 0, 0, r);
      c.stroke();
    }
    for (const r of [GROOVE_IN + 0.5, GROOVE_OUT - 0.3]) {
      circle(c, 0, 0, r);
      c.strokeStyle = '#2b2b2e';
      c.lineWidth = 0.7;
      c.stroke();
    }
    circle(c, 0, 0, RUNOUT_R + 0.5);
    c.strokeStyle = '#242426';
    c.lineWidth = 0.5;
    c.stroke();

    for (let i = 0; i < 70; i++) {
      const a = rnd() * TAU, r = LABEL_R + 4 + rnd() * (RECORD_R - LABEL_R - 6);
      c.fillStyle = `rgba(255,255,255,${0.06 + rnd() * 0.12})`;
      c.fillRect(Math.cos(a) * r, Math.sin(a) * r, 0.35 + rnd() * 0.4, 0.35);
    }
    for (let i = 0; i < 4; i++) {
      const r = 70 + rnd() * 70, a = rnd() * TAU;
      c.strokeStyle = 'rgba(255,255,255,0.05)';
      c.lineWidth = 0.4;
      c.beginPath();
      c.arc(0, 0, r, a, a + 0.15 + rnd() * 0.3);
      c.stroke();
    }

    const title = this.S.track ? this.S.track.title : 'VINIL MK2';
    const hue = hashHue(title);
    circle(c, 0, 0, LABEL_R);
    const lg = c.createRadialGradient(-12, -12, 4, 0, 0, LABEL_R);
    lg.addColorStop(0, `hsl(${hue} 70% 52%)`);
    lg.addColorStop(1, `hsl(${hue} 72% 38%)`);
    c.fillStyle = lg;
    c.fill();
    circle(c, 0, 0, LABEL_R - 3);
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 0.4;
    c.stroke();

    // adesivo de marcação (cue mark) que os DJs de scratch usam
    c.save();
    c.rotate(-Math.PI / 2);
    roundRect(c, 20, -2.6, 28, 5.2, 0.8);
    c.fillStyle = '#f4f1e8';
    c.fill();
    c.restore();

    const lines = wrapText(c, title.toUpperCase(), 60, 5);
    lines.slice(0, 2).forEach((ln, i) => {
      text(c, ln, 0, 14 + i * 6.5, 5, { color: 'rgba(255,255,255,0.95)', weight: 800 });
    });
    text(c, 'SIDE ' + this.id, -26, 0, 4, { color: 'rgba(255,255,255,0.8)', weight: 700 });
    text(c, '33⅓', 26, 0, 4.4, { color: 'rgba(255,255,255,0.8)', weight: 700 });
    const bpm = this.S.track && this.S.track.bpm;
    text(c, bpm ? `${bpm.toFixed(0)} BPM` : 'STEREO', 0, -18, 3.4, { color: 'rgba(255,255,255,0.75)' });

    circle(c, 0, 0, 3.6);
    c.fillStyle = '#0a0a0a';
    c.fill();
  }

  // ----- desenho por quadro --------------------------------------------------
  draw(g) {
    const S = this.S;
    const strobe = this.env.strobe;
    strobe.forEach((img, i) => {
      g.save();
      g.translate(PC.x, PC.y);
      g.rotate(this.rows[i].angle);
      g.drawImage(img, -PLATTER_R, -PLATTER_R, PLATTER_R * 2, PLATTER_R * 2);
      g.restore();
    });
    if (S.power) {
      const lg = g.createRadialGradient(UI.lamp.x, UI.lamp.y, 4, UI.lamp.x, UI.lamp.y, 90);
      lg.addColorStop(0, 'rgba(255,60,40,0.55)');
      lg.addColorStop(1, 'rgba(255,60,40,0)');
      g.save();
      g.beginPath();
      g.arc(PC.x, PC.y, PLATTER_R, 0, TAU);
      g.arc(PC.x, PC.y, RECORD_R + 1, 0, TAU, true);
      g.clip();
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = 'rgba(255,120,100,0.9)';
      g.fillRect(UI.lamp.x - 10, UI.lamp.y - 120, 130, 130);
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = lg;
      g.fillRect(UI.lamp.x - 10, UI.lamp.y - 120, 130, 130);
      g.restore();
    }

    if (this.recordImg) {
      g.save();
      g.translate(PC.x, PC.y);
      g.rotate(S.recordAngle);
      g.drawImage(this.recordImg, -RECORD_R, -RECORD_R, RECORD_R * 2, RECORD_R * 2);
      g.restore();
    }
    this.drawSheen(g);

    circle(g, PC.x, PC.y, 3.4);
    const sp = g.createRadialGradient(PC.x - 1, PC.y - 1, 0.3, PC.x, PC.y, 3.4);
    sp.addColorStop(0, '#fff');
    sp.addColorStop(1, '#6d7073');
    g.fillStyle = sp;
    g.fill();

    this.drawControls(g);
    this.drawArm(g);
  }

  drawSheen(g) {
    if (!g.createConicGradient) return;
    if (!this.sheen) {
      this.sheen = g.createConicGradient(-0.6, PC.x, PC.y);
      const st = [[0, 0], [0.07, 0], [0.12, 0.13], [0.17, 0], [0.55, 0], [0.61, 0.08], [0.67, 0], [1, 0]];
      for (const [o, a] of st) this.sheen.addColorStop(o, `rgba(255,255,255,${a})`);
    }
    g.beginPath();
    g.arc(PC.x, PC.y, RECORD_R - 1, 0, TAU);
    g.arc(PC.x, PC.y, LABEL_R + 1, 0, TAU, true);
    g.fillStyle = this.sheen;
    g.fill('evenodd');
  }

  drawButton(g, b, pressed, lit) {
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = (pressed ? 0.5 : 2.5) * view.k;
    g.shadowOffsetY = (pressed ? 0.3 : 1.2) * view.k;
    roundRect(g, b.x, b.y, b.w, b.h, 2.5);
    const gr = g.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    gr.addColorStop(0, pressed ? '#9a9c9e' : '#eeefef');
    gr.addColorStop(1, pressed ? '#7c7e80' : '#a9abad');
    g.fillStyle = gr;
    g.fill();
    g.restore();
    if (lit !== undefined) {
      circle(g, b.x + b.w / 2, b.y + b.h + 4.5, 1.3);
      g.fillStyle = lit ? '#ff8c1a' : '#4a3a2a';
      g.fill();
      if (lit) glow(g, '#ff8c1a', 4);
    }
  }

  drawControls(g) {
    const S = this.S;
    this.drawButton(g, UI.start, S.pressed.has('start'));
    this.drawButton(g, UI.s33, S.pressed.has('s33'), S.power && S.base === NOMINAL);
    this.drawButton(g, UI.s45, S.pressed.has('s45'), S.power && S.base === 45);

    const pw = UI.power;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = 3 * view.k;
    g.shadowOffsetY = 1 * view.k;
    circle(g, pw.x, pw.y, pw.r);
    g.fillStyle = '#1f2022';
    g.fill();
    g.restore();
    circle(g, pw.x, pw.y, pw.r - 3);
    const kg = g.createLinearGradient(pw.x - pw.r, pw.y - pw.r, pw.x + pw.r, pw.y + pw.r);
    kg.addColorStop(0, '#d7d9da');
    kg.addColorStop(1, '#7f8285');
    g.fillStyle = kg;
    g.fill();
    const ang = (S.power ? 40 : -40) * Math.PI / 180 - Math.PI / 2;
    g.strokeStyle = '#1a1a1a';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(pw.x + Math.cos(ang) * 3, pw.y + Math.sin(ang) * 3);
    g.lineTo(pw.x + Math.cos(ang) * (pw.r - 4), pw.y + Math.sin(ang) * (pw.r - 4));
    g.stroke();

    circle(g, UI.lamp.x, UI.lamp.y, 5);
    g.fillStyle = S.power ? '#ff5a3c' : '#4a2a26';
    g.fill();
    if (S.power) glow(g, '#ff3b20', 8);

    const locked = S.power && S.pitch === 0;
    circle(g, UI.quartz.x, UI.quartz.y, 1.8);
    g.fillStyle = locked ? '#5dff8a' : '#1f3a26';
    g.fill();
    if (locked) glow(g, '#5dff8a', 5);

    const f = UI.fader;
    const y = this.faderY();
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 3 * view.k;
    g.shadowOffsetY = 1.5 * view.k;
    roundRect(g, f.x - 11, y - 7, 22, 14, 2);
    const fg = g.createLinearGradient(f.x, y - 7, f.x, y + 7);
    fg.addColorStop(0, '#f2f3f3');
    fg.addColorStop(0.5, '#b9bbbd');
    fg.addColorStop(1, '#8a8c8f');
    g.fillStyle = fg;
    g.fill();
    g.restore();
    g.fillStyle = '#1a1a1a';
    g.fillRect(f.x - 9, y - 0.5, 18, 1);

    const cq = UI.cue;
    const ly = S.cueUp ? cq.y + 6 : cq.y + cq.h - 8;
    roundRect(g, cq.x + 3, ly - 3, cq.w - 6, 6, 2);
    g.fillStyle = S.cueUp ? '#e9eaeb' : '#a3a5a7';
    g.fill();
  }

  faderY() {
    const f = UI.fader;
    return f.y0 + (this.S.pitch + 1) / 2 * (f.y1 - f.y0);
  }

  drawArmShape(g, th, shadow) {
    const { dir, hd, col } = armGeometry(th);
    const P = PIVOT;
    const c1 = rot(dir, -0.16), c2 = rot(hd, -0.5);

    g.save();
    g.translate(P.x - dir.x * 46, P.y - dir.y * 46);
    g.rotate(Math.atan2(dir.y, dir.x));
    roundRect(g, -15, -13, 30, 26, 4);
    if (shadow) g.fillStyle = shadow;
    else {
      const cg = g.createLinearGradient(0, -13, 0, 13);
      cg.addColorStop(0, '#4b4d50');
      cg.addColorStop(0.45, '#e2e4e5');
      cg.addColorStop(1, '#3c3e40');
      g.fillStyle = cg;
    }
    g.fill();
    if (!shadow) {
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 0.4;
      for (let k = -12; k <= 12; k += 3) {
        g.beginPath();
        g.moveTo(k, -13);
        g.lineTo(k, 13);
        g.stroke();
      }
    }
    g.restore();
    g.beginPath();
    g.moveTo(P.x, P.y);
    g.lineTo(P.x - dir.x * 34, P.y - dir.y * 34);
    g.strokeStyle = shadow || '#7c7f82';
    g.lineWidth = 5;
    g.stroke();

    g.beginPath();
    g.moveTo(P.x, P.y);
    g.bezierCurveTo(P.x + c1.x * 95, P.y + c1.y * 95, col.x - c2.x * 65, col.y - c2.y * 65, col.x, col.y);
    g.lineCap = 'round';
    g.strokeStyle = shadow || '#6e7174';
    g.lineWidth = 7;
    g.stroke();
    if (!shadow) {
      g.strokeStyle = '#e6e8e9';
      g.lineWidth = 3;
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.lineWidth = 1;
      g.stroke();
    }

    g.save();
    g.translate(col.x, col.y);
    g.rotate(Math.atan2(hd.y, hd.x));
    g.fillStyle = shadow || '#2a2b2d';
    roundRect(g, -3, -5, 10, 10, 2);
    g.fill();
    if (!shadow) { g.fillStyle = '#c9cbcc'; roundRect(g, -2, -4, 3, 8, 1); g.fill(); }
    g.fillStyle = shadow || '#1b1c1e';
    g.beginPath();
    g.moveTo(6, -6);
    g.lineTo(50, -9);
    g.lineTo(52, 8);
    g.lineTo(6, 6);
    g.closePath();
    g.fill();
    g.fillStyle = shadow || '#1b1c1e';
    roundRect(g, 26, -22, 4, 15, 1.5);
    g.fill();
    if (!shadow) {
      roundRect(g, 26, -7.5, 24, 15, 2.5);
      const cart = g.createLinearGradient(0, -7.5, 0, 7.5);
      cart.addColorStop(0, '#2f3134');
      cart.addColorStop(0.5, '#4a4d51');
      cart.addColorStop(1, '#1e1f21');
      g.fillStyle = cart;
      g.fill();
      g.fillStyle = this.id === 'A' ? '#ff7a1a' : '#ffd21a';
      g.fillRect(46, -6, 2.5, 12);
    }
    g.restore();

    circle(g, P.x, P.y, 12);
    g.fillStyle = shadow || '#2b2c2e';
    g.fill();
    if (!shadow) {
      circle(g, P.x, P.y, 8);
      const pg = g.createRadialGradient(P.x - 3, P.y - 3, 1, P.x, P.y, 8);
      pg.addColorStop(0, '#f4f5f5');
      pg.addColorStop(1, '#6f7275');
      g.fillStyle = pg;
      g.fill();
    }
  }

  drawArm(g) {
    const th = this.S.armTheta, lift = this.S.lift;
    g.save();
    g.translate(2 + lift * 5, 3 + lift * 7);
    g.globalAlpha = 0.35 - lift * 0.1;
    this.drawArmShape(g, th, '#000');
    g.restore();
    this.drawArmShape(g, th, null);
  }

  // ----- toque ---------------------------------------------------------------
  hit(p) {
    if (inRect(p, UI.start, 7)) return 'start';
    if (inRect(p, UI.s33, 4)) return 's33';
    if (inRect(p, UI.s45, 4)) return 's45';
    if (Math.hypot(p.x - UI.power.x, p.y - UI.power.y) < UI.power.r + 6) return 'power';
    if (inRect(p, UI.cue, 6)) return 'cue';
    const f = UI.fader;
    if (Math.abs(p.x - f.x) < 17 && p.y > f.y0 - 14 && p.y < f.y1 + 14) return 'fader';
    const { st, col } = armGeometry(this.S.armTheta);
    const head = { x: st.x + (st.x - col.x) * 0.15, y: st.y + (st.y - col.y) * 0.15 };
    if (distToSeg(p, col, head) < 16) return 'arm';
    const mid = stylusAt(this.S.armTheta * 0.98);
    if (distToSeg(p, { x: (PIVOT.x + mid.x) / 2, y: (PIVOT.y + mid.y) / 2 }, col) < 8) return 'arm';
    if (Math.hypot(p.x - PC.x, p.y - PC.y) < PLATTER_R + 4) return 'record';
    return null;
  }

  setPitchFromY(y) {
    const f = UI.fader;
    let v = clamp((y - f.y0) / (f.y1 - f.y0) * 2 - 1, -1, 1);
    if (Math.abs(v) < 0.03) v = 0;     // trava central
    if (v === 0 && this.S.pitch !== 0) this.env.buzz(12);
    this.S.pitch = v;
  }

  down(p, e) {
    const S = this.S;
    const kind = this.hit(p);
    if (!kind) return null;
    const info = { kind };
    switch (kind) {
      case 'start':
        S.pressed.add('start');
        this.env.buzz(14);
        if (S.power) S.motor = !S.motor;
        break;
      case 's33':
      case 's45':
        S.pressed.add(kind);
        this.env.buzz();
        if (S.power) S.base = kind === 's33' ? NOMINAL : 45;
        break;
      case 'power':
        this.env.buzz(20);
        S.power = !S.power;
        S.motor = false;
        break;
      case 'cue':
        this.setCue(!S.cueUp);
        break;
      case 'fader': {
        const now = performance.now();
        const ky = this.faderY();
        if (Math.abs(p.y - ky) < 10) {
          info.offset = p.y - ky;
          if (now - this.lastFaderTap < 320) { S.pitch = 0; this.env.buzz(12); info.offset = null; }
          this.lastFaderTap = now;
        } else {
          info.offset = 0;
          this.setPitchFromY(p.y);
        }
        break;
      }
      case 'arm': {
        const th = Math.atan2(-(p.x - PIVOT.x), p.y - PIVOT.y);
        info.thOffset = S.armTheta - th;
        this.liftNeedle();
        S.arm = 'drag';
        break;
      }
      case 'record': {
        if (S.scratching) return null;
        S.scratching = true;
        Object.assign(this.scratch, {
          id: e.pointerId, lastA: Math.atan2(p.y - PC.y, p.x - PC.x), total: 0, base: S.recordAngle,
          vel: S.recordRPM / 60 * TAU, lastT: e.timeStamp, lastMove: performance.now(), sentZero: false,
        });
        this.lastSentRate = NaN;
        if (S.arm === 'play') this.post({ type: 'grab' });
        break;
      }
    }
    return info;
  }

  // pts: lista de { p (local), t (timeStamp) } — eventos agrupados do dedo
  move(info, pts) {
    const S = this.S;
    const last = pts[pts.length - 1].p;
    switch (info.kind) {
      case 'fader':
        if (info.offset != null) this.setPitchFromY(last.y - info.offset);
        break;
      case 'arm': {
        const th = Math.atan2(-(last.x - PIVOT.x), last.y - PIVOT.y) + info.thOffset;
        S.armTheta = clamp(th, -0.02, 1.0);
        break;
      }
      case 'record': {
        const sc = this.scratch;
        for (const { p, t } of pts) {
          const a = Math.atan2(p.y - PC.y, p.x - PC.x);
          let d = a - sc.lastA;
          if (d > Math.PI) d -= TAU;
          else if (d < -Math.PI) d += TAU;
          sc.lastA = a;
          sc.total += d;
          const dt = (t - sc.lastT) / 1000;
          if (dt > 0.0005) {
            sc.vel += (d / dt - sc.vel) * 0.4;
            sc.lastT = t;
          }
        }
        sc.lastMove = performance.now();
        sc.sentZero = false;
        S.recordAngle = sc.base + sc.total;
        this.sendScratch();
        break;
      }
    }
  }

  sendScratch() {
    if (this.S.arm !== 'play') return;
    const sc = this.scratch;
    this.post({ type: 'follow', off: sc.total / TAU * SEC_PER_REV, vel: sc.vel / TAU * SEC_PER_REV });
  }

  up(info) {
    const S = this.S;
    switch (info.kind) {
      case 'start':
      case 's33':
      case 's45':
        S.pressed.delete(info.kind);
        break;
      case 'arm': {
        const st = stylusAt(S.armTheta);
        const r = Math.hypot(st.x - PC.x, st.y - PC.y);
        if (r < RECORD_R - 1 && r > RUNOUT_R - 1 && S.track) this.dropNeedle(this.radiusToPos(r));
        else S.arm = 'rest';
        break;
      }
      case 'record': {
        const idle = performance.now() - this.scratch.lastMove > 60;
        const omega = idle ? 0 : this.scratch.vel;
        S.recordRPM = clamp(omega * 60 / TAU, -400, 400);
        S.scratching = false;
        this.scratch.id = null;
        this.lastSentRate = NaN;
        break;
      }
    }
  }
}

function wrapText(c, str, maxW, size) {
  c.font = `800 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  const words = str.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (c.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) lines[1] = lines[1].replace(/.{0,2}$/, '…');
  return lines;
}
