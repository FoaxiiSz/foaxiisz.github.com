import { makeDemoTrack } from './demo.js';

// ---------------------------------------------------------------------------
// Geometria do deck em milímetros (vista de cima, posição normal)
// ---------------------------------------------------------------------------
const W = 453, H = 360;
const PC = { x: 186, y: 172 };            // centro do prato
const PLATTER_R = 166;
const RECORD_R = 151;                     // disco de 12"
const GROOVE_OUT = 146;
const GROOVE_IN = 62;
const RUNOUT_R = 56;
const LABEL_R = 50;
const PIVOT = { x: 382, y: 84 };          // pivô do braço
const ARM_L = 230;                        // comprimento efetivo do braço
const HEAD_OFFSET = 0.38;                 // ângulo da headshell (rad)
const SEC_PER_REV = 1.8;                  // 1 volta em 33⅓ = 1,8 s de áudio
const NOMINAL = 100 / 3;
const TAU = Math.PI * 2;

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
const STROBE_ROWS = [0.066, 0.033, 0, -0.033].map((p, i) => ({
  p,
  r: 154 + i * 3.2,
  n: Math.round(7200 / (NOMINAL * (1 + p))),
  angle: 0,
}));

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const saved = (() => {
  try { return JSON.parse(localStorage.getItem('vinil-mk2') || '{}'); } catch { return {}; }
})();

const S = {
  power: true,
  motor: false,
  base: NOMINAL,
  pitch: 0,                 // −1..1 (posição do fader; +1 = embaixo = mais rápido)
  range: saved.range ?? 8,
  startTime: saved.startTime ?? 0.7,
  brakeTime: saved.brakeTime ?? 0.9,
  crackle: saved.crackle ?? true,
  haptic: saved.haptic ?? true,
  orient: saved.orient ?? 'auto',
  platterRPM: 0,
  recordRPM: 0,
  platterAngle: 0,
  recordAngle: 0,
  scratching: false,
  arm: 'rest',              // rest | play | cued | lowering | drag
  armTheta: 0,
  lift: 0.4,
  cueUp: false,
  track: null,
  cut: false,
  xf: 0.5,
  vol: 0.9,
  pressed: new Set(),
};

function persist() {
  try {
    localStorage.setItem('vinil-mk2', JSON.stringify({
      range: S.range, startTime: S.startTime, brakeTime: S.brakeTime,
      crackle: S.crackle, haptic: S.haptic, orient: S.orient,
    }));
  } catch { /* modo privado: tudo bem */ }
}

const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const buzz = (ms = 8) => { if (S.haptic && navigator.vibrate) navigator.vibrate(ms); };

// ---------------------------------------------------------------------------
// Áudio
// ---------------------------------------------------------------------------
let actx = null, node = null, cutGain = null, master = null;
let audioReady = null;
let report = { pos: 0, rate: 0, t: 0 };
let lastSentRate = NaN;
let pendingTrack = null;

function post(msg, transfer) {
  if (node) node.port.postMessage(msg, transfer || []);
}

function ensureAudio() {
  if (audioReady) {
    if (actx && actx.state !== 'running') actx.resume();
    return audioReady;
  }
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* opcional */ }
  const AC = window.AudioContext || window.webkitAudioContext;
  actx = new AC({ latencyHint: 'interactive' });
  actx.resume();
  audioReady = (async () => {
    await actx.audioWorklet.addModule('js/deck-worklet.js');
    node = new AudioWorkletNode(actx, 'turntable', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    cutGain = actx.createGain();
    master = actx.createGain();
    node.connect(cutGain).connect(master).connect(actx.destination);
    node.port.onmessage = (e) => { report = e.data; };
    post({ type: 'crackle', on: S.crackle });
    applyGain();
    if (pendingTrack) {
      const t = pendingTrack;
      pendingTrack = null;
      sendTrack(t);
    } else if (!S.track || S.track.demoPending) {
      loadDemo();
    }
  })();
  return audioReady;
}

function applyGain() {
  if (!actx) return;
  const fader = clamp((0.95 - S.xf) / 0.05, 0, 1);
  const g = (S.cut ? 0 : 1) * fader;
  cutGain.gain.setTargetAtTime(g, actx.currentTime, 0.0015);
  master.gain.setTargetAtTime(S.vol * S.vol, actx.currentTime, 0.02);
}

function audioPos() {
  if (!actx) return S.track ? -1.2 : 0;
  const dt = clamp(actx.currentTime - report.t, 0, 0.1);
  return report.pos + report.rate * dt;
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i];
    out[i] = v <= -1 ? -32768 : v >= 1 ? 32767 : v * 32767;
  }
  return out;
}

function sendTrack(t) {
  const L = toInt16(t.L);
  const R = t.R && t.R !== t.L ? toInt16(t.R) : null;
  const transfer = R ? [L.buffer, R.buffer] : [L.buffer];
  post({ type: 'load', L, R, int16: true, length: L.length, startPos: -1.2 }, transfer);
  report = { pos: -1.2, rate: 0, t: actx.currentTime };
  lastSentRate = NaN;
  dropNeedle(-1.2);
}

function setTrack(info, data) {
  S.track = { title: info.title, duration: info.duration };
  $('#title').textContent = info.title;
  buildRecordImage();
  liftNeedle();
  S.arm = 'rest';
  if (node) sendTrack(data);
  else pendingTrack = data;
}

function loadDemo() {
  const sr = actx ? actx.sampleRate : 48000;
  const demo = makeDemoTrack(sr);
  setTrack({ title: 'Disco de batalha (demo)', duration: demo.duration }, demo);
}

async function loadFile(file) {
  showBusy('Prensando o disco…');
  try {
    await ensureAudio();
    const bytes = await file.arrayBuffer();
    const buf = await actx.decodeAudioData(bytes);
    if (buf.duration > 15 * 60) throw new Error('Música muito longa (máx. 15 min).');
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const title = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
    setTrack({ title, duration: buf.duration }, { L, R });
  } catch (err) {
    alert('Não consegui abrir esse arquivo.\n' + (err && err.message ? err.message : ''));
  } finally {
    hideBusy();
  }
}

// ---------------------------------------------------------------------------
// Braço / agulha
// ---------------------------------------------------------------------------
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

function posToRadius(p) {
  const D = S.track ? S.track.duration : 60;
  if (p < 0) return Math.min(RECORD_R - 1.5, GROOVE_OUT + -p * 2.2);
  if (p <= D) return GROOVE_OUT - (GROOVE_OUT - GROOVE_IN) * (p / D);
  return Math.max(RUNOUT_R, GROOVE_IN - (p - D) * 3);
}

function radiusToPos(r) {
  const D = S.track ? S.track.duration : 60;
  if (r > GROOVE_OUT) return -(r - GROOVE_OUT) / 2.2;
  if (r >= GROOVE_IN) return (GROOVE_OUT - r) / (GROOVE_OUT - GROOVE_IN) * D;
  return D + (GROOVE_IN - r) / 3;
}

let lowerTimer = 0;

function liftNeedle() {
  clearTimeout(lowerTimer);
  post({ type: 'needle', down: false });
}

function dropNeedle(pos) {
  clearTimeout(lowerTimer);
  post({ type: 'seek', pos });
  report = { pos, rate: 0, t: actx ? actx.currentTime : 0 };
  S.armTheta = thetaForRadius(posToRadius(pos));
  if (S.cueUp) { S.arm = 'cued'; return; }
  S.arm = 'lowering';
  lastSentRate = NaN;
  lowerTimer = setTimeout(() => {
    S.arm = 'play';
    lastSentRate = NaN;
    post({ type: 'needle', down: true, thump: true });
    if (S.scratching) { post({ type: 'grab' }); scratch.total = 0; scratch.base = S.recordAngle; }
  }, 160);
}

function setCue(up) {
  S.cueUp = up;
  buzz();
  if (up && (S.arm === 'play' || S.arm === 'lowering')) {
    liftNeedle();
    S.arm = 'cued';
  } else if (!up && S.arm === 'cued') {
    // descida hidráulica do cue: lenta
    S.arm = 'lowering';
    lowerTimer = setTimeout(() => {
      S.arm = 'play';
      lastSentRate = NaN;
      post({ type: 'needle', down: true, thump: true });
    }, 420);
  }
}

// ---------------------------------------------------------------------------
// Física do prato
// ---------------------------------------------------------------------------
function targetRPM() {
  return S.base * (1 + S.pitch * S.range / 100);
}

function updatePhysics(dt) {
  let rpm = S.platterRPM;
  if (S.power && S.motor) {
    const diff = targetRPM() - rpm;
    const accel = Math.min(NOMINAL / S.startTime, Math.abs(diff) * 10);
    rpm += Math.sign(diff) * Math.min(Math.abs(diff), accel * dt);
  } else if (S.power) {
    const decel = Math.min(NOMINAL / S.brakeTime, Math.abs(rpm) * 12 + 2);
    rpm -= Math.sign(rpm) * Math.min(Math.abs(rpm), decel * dt);
  } else {
    // sem energia: o prato pesado gira solto até parar
    const decel = 1.1 + Math.abs(rpm) * 0.11;
    rpm -= Math.sign(rpm) * Math.min(Math.abs(rpm), decel * dt);
  }
  S.platterRPM = rpm;
  S.platterAngle += rpm / 60 * TAU * dt;

  if (!S.scratching) {
    // feltro (slipmat): o disco é arrastado de volta à velocidade do prato
    const diff = S.platterRPM - S.recordRPM;
    const a = Math.min(320, Math.abs(diff) * 60);
    S.recordRPM += Math.sign(diff) * Math.min(Math.abs(diff), a * dt);
    S.recordAngle += S.recordRPM / 60 * TAU * dt;
  }

  // Estroboscópio: movimento aparente sob uma luz que pisca 120×/s
  const omega = S.platterRPM / 60 * TAU;
  for (const row of STROBE_ROWS) {
    const sp = TAU / row.n;
    const phi = omega / 120;
    const w = phi - sp * Math.round(phi / sp);
    row.angle += w * 120 * dt;
  }

  // envia velocidade para a agulha
  if (!S.scratching) {
    const want = S.arm === 'play' ? S.recordRPM / NOMINAL : 0;
    if (!(Math.abs(want - lastSentRate) < 1e-5)) {
      post({ type: 'rate', rate: want });
      lastSentRate = want;
    }
  }

  // braço
  const p = audioPos();
  if (S.arm === 'play' && S.track) S.armTheta = thetaForRadius(posToRadius(p));
  else if (S.arm === 'rest') S.armTheta += (0 - S.armTheta) * Math.min(1, dt * 6);
  const liftTarget = S.arm === 'play' ? 0 : S.arm === 'rest' ? 0.35 : 1;
  S.lift += (liftTarget - S.lift) * Math.min(1, dt * 10);
}

// ---------------------------------------------------------------------------
// Canvas / layout
// ---------------------------------------------------------------------------
const canvas = $('#deck');
const g = canvas.getContext('2d');
const stage = $('#stage');
let M = new DOMMatrix(), Minv = new DOMMatrix(), DM = new DOMMatrix();
let pxmm = 1, dpr = 1, battle = false;
let staticLayer = null, recordImg = null, rowImgs = [], sheen = null;

function layout() {
  const rect = stage.getBoundingClientRect();
  const cw = Math.max(1, rect.width), ch = Math.max(1, rect.height);
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  battle = S.orient === 'battle' || (S.orient === 'auto' && cw < ch);
  const dw = battle ? H : W, dh = battle ? W : H;
  const s = Math.min((cw - 8) / dw, (ch - 8) / dh);
  M = new DOMMatrix().translate(cw / 2, ch / 2).scale(s).rotate(battle ? -90 : 0).translate(-W / 2, -H / 2);
  Minv = M.inverse();
  DM = new DOMMatrix().scale(dpr).multiply(M);
  pxmm = s * dpr;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  buildStatic();
  buildRecordImage();
  buildStrobeRows();
  sheen = null;
}

function toDeck(e) {
  const r = canvas.getBoundingClientRect();
  const p = Minv.transformPoint(new DOMPoint(e.clientX - r.left, e.clientY - r.top));
  return { x: p.x, y: p.y };
}

function offscreen(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function circle(c, x, y, r) {
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
}

function text(c, str, x, y, size, opts = {}) {
  c.font = `${opts.weight || 600} ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  c.textAlign = opts.align || 'center';
  c.textBaseline = 'middle';
  c.fillStyle = opts.color || '#3b3d40';
  c.fillText(str, x, y);
}

// Plinto (corpo), textos fixos e partes que não se mexem
function buildStatic() {
  staticLayer = offscreen(canvas.width, canvas.height);
  const c = staticLayer.getContext('2d');
  c.setTransform(DM);

  // sombra do corpo
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.6)';
  c.shadowBlur = 18 * pxmm;
  c.shadowOffsetY = 6 * pxmm;
  roundRect(c, 0, 0, W, H, 9);
  c.fillStyle = '#9fa2a5';
  c.fill();
  c.restore();

  // tampo de alumínio escovado (cor champanhe-prata do MK2)
  const body = c.createLinearGradient(0, 0, W * 0.3, H);
  body.addColorStop(0, '#d3d4d2');
  body.addColorStop(0.5, '#bfc0be');
  body.addColorStop(1, '#a9aaa8');
  roundRect(c, 0, 0, W, H, 9);
  c.fillStyle = body;
  c.fill();
  c.save();
  roundRect(c, 0, 0, W, H, 9);
  c.clip();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < H; y += 0.7) {
    c.strokeStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${rnd() * 0.05})`;
    c.lineWidth = 0.35;
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(W, y);
    c.stroke();
  }
  c.restore();
  roundRect(c, 0.5, 0.5, W - 1, H - 1, 9);
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = 0.8;
  c.stroke();

  // dobradiças da tampa
  for (const hx of [40, 330]) {
    roundRect(c, hx, -1, 44, 7, 1.5);
    c.fillStyle = '#26272a';
    c.fill();
  }

  // poço do prato
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.55)';
  c.shadowBlur = 6 * pxmm;
  c.shadowOffsetY = 2 * pxmm;
  circle(c, PC.x, PC.y, PLATTER_R + 1.5);
  c.fillStyle = '#2a2b2d';
  c.fill();
  c.restore();

  // prato (borda de alumínio)
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
  // slipmat (feltro)
  circle(c, PC.x, PC.y, RECORD_R + 0.8);
  c.fillStyle = '#121213';
  c.fill();

  // textos do painel
  text(c, 'QUARTZ  DIRECT  DRIVE  TURNTABLE  SYSTEM', 300, 352, 5.2, { weight: 500, color: '#4a4c4f' });
  text(c, 'SL-1200MK2', 14, 14, 7.5, { align: 'left', weight: 800, color: '#2d2f31' });
  text(c, 'POWER', UI.power.x, UI.power.y + 23, 4.2);
  text(c, 'OFF', UI.power.x - 15, UI.power.y - 19, 3.6);
  text(c, 'ON', UI.power.x + 15, UI.power.y - 19, 3.6);
  text(c, 'START·STOP', UI.start.x + UI.start.w / 2, UI.start.y - 5, 4.2);
  text(c, '33', UI.s33.x + UI.s33.w / 2, UI.s33.y - 5, 4.6, { weight: 700 });
  text(c, '45', UI.s45.x + UI.s45.w / 2, UI.s45.y - 5, 4.6, { weight: 700 });
  text(c, 'R.P.M.', 162, UI.s33.y + 7.5, 3.6, { align: 'left' });
  text(c, 'QUARTZ', UI.quartz.x - 8, UI.quartz.y - 7, 3.4);
  text(c, 'LOCK', UI.quartz.x - 8, UI.quartz.y - 3, 3.4);
  text(c, 'CUE', UI.cue.x + UI.cue.w / 2, UI.cue.y - 5, 4);
  text(c, 'ANTI-SKATING', UI.antiskate.x, UI.antiskate.y + 15, 3, { weight: 500 });

  // trilho do pitch + escala
  const f = UI.fader;
  roundRect(c, f.x - 12, f.y0 - 12, 24, f.y1 - f.y0 + 24, 3);
  c.fillStyle = 'rgba(0,0,0,0.07)';
  c.fill();
  roundRect(c, f.x - 1.8, f.y0 - 6, 3.6, f.y1 - f.y0 + 12, 1.8);
  c.fillStyle = '#111';
  c.fill();
  for (let i = -8; i <= 8; i++) {
    const y = f.y0 + (i + 8) / 16 * (f.y1 - f.y0);
    const major = i % 4 === 0;
    c.strokeStyle = '#3b3d40';
    c.lineWidth = major ? 0.6 : 0.35;
    c.beginPath();
    c.moveTo(f.x - 13, y);
    c.lineTo(f.x - (major ? 7 : 9.5), y);
    c.stroke();
    if (major) {
      const v = Math.round(i / 8 * S.range);
      const label = v === 0 ? '0' : (v > 0 ? '+' : '−') + Math.abs(v);
      text(c, label, f.x - 15, y, 4, { align: 'right', weight: 700 });
    }
  }
  text(c, 'PITCH ADJ.', f.x - 14, f.y1 + 14, 3.6, { align: 'center' });

  // base do braço
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

  // descanso do braço
  const restPt = { x: PIVOT.x - 4, y: PIVOT.y + ARM_L * 0.72 };
  roundRect(c, restPt.x - 7, restPt.y - 5, 14, 10, 2);
  c.fillStyle = '#1b1c1e';
  c.fill();
  roundRect(c, restPt.x - 4, restPt.y - 3, 8, 6, 2);
  c.fillStyle = '#3a3b3e';
  c.fill();

  // anti-skating
  circle(c, UI.antiskate.x, UI.antiskate.y, 9);
  c.fillStyle = '#1e1f21';
  c.fill();
  circle(c, UI.antiskate.x, UI.antiskate.y, 7);
  c.fillStyle = '#8c8f92';
  c.fill();
  c.strokeStyle = '#222';
  c.lineWidth = 0.8;
  c.beginPath();
  c.moveTo(UI.antiskate.x, UI.antiskate.y);
  c.lineTo(UI.antiskate.x + 5, UI.antiskate.y - 5);
  c.stroke();

  // base do cue
  roundRect(c, UI.cue.x, UI.cue.y, UI.cue.w, UI.cue.h, 3);
  c.fillStyle = '#1b1c1e';
  c.fill();

  // lâmpada do estroboscópio (corpo)
  circle(c, UI.lamp.x, UI.lamp.y, 8);
  c.fillStyle = '#26272a';
  c.fill();
}

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

// O disco (sulcos + selo) é desenhado uma vez e depois só girado
function buildRecordImage() {
  const size = 2 * RECORD_R * pxmm;
  recordImg = offscreen(size, size);
  const c = recordImg.getContext('2d');
  c.setTransform(pxmm, 0, 0, pxmm, RECORD_R * pxmm, RECORD_R * pxmm);

  circle(c, 0, 0, RECORD_R);
  c.fillStyle = '#0b0b0c';
  c.fill();
  circle(c, 0, 0, RECORD_R - 0.6);
  c.strokeStyle = '#2a2a2c';
  c.lineWidth = 1.2;
  c.stroke();

  // sulcos
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const step = Math.max(0.22, 0.9 / pxmm);
  for (let r = GROOVE_IN; r < GROOVE_OUT; r += step) {
    const v = 14 + Math.floor(rnd() * 10);
    c.strokeStyle = `rgb(${v},${v},${v + 1})`;
    c.lineWidth = step * 0.55;
    circle(c, 0, 0, r);
    c.stroke();
  }
  // divisões de faixa (anéis mais lisos) para dar referência visual
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

  // poeira e marcas: deixam a rotação perceptível
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

  // selo
  const title = S.track ? S.track.title : 'VINIL MK2';
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

  // adesivo branco de marcação (cue mark), como os DJs de scratch usam
  c.save();
  c.rotate(-Math.PI / 2);
  roundRect(c, 20, -2.6, 28, 5.2, 0.8);
  c.fillStyle = '#f4f1e8';
  c.fill();
  c.restore();

  // texto do selo
  c.fillStyle = '#fff';
  const lines = wrapText(c, title.toUpperCase(), 60, 5);
  lines.slice(0, 2).forEach((ln, i) => {
    text(c, ln, 0, 14 + i * 6.5, 5, { color: 'rgba(255,255,255,0.95)', weight: 800 });
  });
  text(c, 'SIDE A', -26, 0, 4, { color: 'rgba(255,255,255,0.8)', weight: 700 });
  text(c, '33⅓', 26, 0, 4.4, { color: 'rgba(255,255,255,0.8)', weight: 700 });
  text(c, 'STEREO', 0, -18, 3.4, { color: 'rgba(255,255,255,0.75)' });

  circle(c, 0, 0, 3.6);
  c.fillStyle = '#0a0a0a';
  c.fill();
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

function buildStrobeRows() {
  const size = 2 * PLATTER_R * pxmm;
  rowImgs = STROBE_ROWS.map((row) => {
    const img = offscreen(size, size);
    const c = img.getContext('2d');
    c.setTransform(pxmm, 0, 0, pxmm, PLATTER_R * pxmm, PLATTER_R * pxmm);
    c.fillStyle = '#e9ebec';
    const dot = Math.min(2.2, TAU * row.r / row.n * 0.45);
    for (let k = 0; k < row.n; k++) {
      const a = k / row.n * TAU;
      c.save();
      c.rotate(a);
      c.fillRect(row.r - 1, -dot / 2, 2, dot);
      c.restore();
    }
    return img;
  });
}

// ---------------------------------------------------------------------------
// Desenho por quadro
// ---------------------------------------------------------------------------
function draw() {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (staticLayer) g.drawImage(staticLayer, 0, 0);
  g.setTransform(DM);

  // pontos do estroboscópio
  rowImgs.forEach((img, i) => {
    g.save();
    g.translate(PC.x, PC.y);
    g.rotate(STROBE_ROWS[i].angle);
    g.drawImage(img, -PLATTER_R, -PLATTER_R, PLATTER_R * 2, PLATTER_R * 2);
    g.restore();
  });
  // luz vermelha do estroboscópio
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

  // disco
  if (recordImg) {
    g.save();
    g.translate(PC.x, PC.y);
    g.rotate(S.recordAngle);
    g.drawImage(recordImg, -RECORD_R, -RECORD_R, RECORD_R * 2, RECORD_R * 2);
    g.restore();
  }
  drawSheen();

  // eixo central
  circle(g, PC.x, PC.y, 3.4);
  const sp = g.createRadialGradient(PC.x - 1, PC.y - 1, 0.3, PC.x, PC.y, 3.4);
  sp.addColorStop(0, '#fff');
  sp.addColorStop(1, '#6d7073');
  g.fillStyle = sp;
  g.fill();

  drawControls();
  drawArm();
}

function drawSheen() {
  if (!g.createConicGradient) return;
  if (!sheen) {
    sheen = g.createConicGradient(-0.6, PC.x, PC.y);
    const st = [[0, 0], [0.07, 0], [0.12, 0.13], [0.17, 0], [0.55, 0], [0.61, 0.08], [0.67, 0], [1, 0]];
    for (const [o, a] of st) sheen.addColorStop(o, `rgba(255,255,255,${a})`);
  }
  g.save();
  g.beginPath();
  g.arc(PC.x, PC.y, RECORD_R - 1, 0, TAU);
  g.arc(PC.x, PC.y, LABEL_R + 1, 0, TAU, true);
  g.fillStyle = sheen;
  g.fill('evenodd');
  g.restore();
}

function drawButton(b, pressed, lit) {
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)';
  g.shadowBlur = (pressed ? 0.5 : 2.5) * pxmm;
  g.shadowOffsetY = (pressed ? 0.3 : 1.2) * pxmm;
  roundRect(g, b.x, b.y, b.w, b.h, 2.5);
  const gr = g.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
  gr.addColorStop(0, pressed ? '#9a9c9e' : '#eeefef');
  gr.addColorStop(1, pressed ? '#7c7e80' : '#a9abad');
  g.fillStyle = gr;
  g.fill();
  g.restore();
  roundRect(g, b.x + 0.4, b.y + 0.4, b.w - 0.8, b.h - 0.8, 2.2);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 0.4;
  g.stroke();
  if (lit !== undefined) {
    circle(g, b.x + b.w / 2, b.y + b.h + 4.5, 1.3);
    g.fillStyle = lit ? '#ff8c1a' : '#4a3a2a';
    g.fill();
    if (lit) {
      g.save();
      g.shadowColor = '#ff8c1a';
      g.shadowBlur = 4 * pxmm;
      g.fill();
      g.restore();
    }
  }
}

function drawControls() {
  drawButton(UI.start, S.pressed.has('start'));
  drawButton(UI.s33, S.pressed.has('s33'), S.power && S.base === NOMINAL);
  drawButton(UI.s45, S.pressed.has('s45'), S.power && S.base === 45);

  // botão POWER (giratório) com a lâmpada
  const pw = UI.power;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)';
  g.shadowBlur = 3 * pxmm;
  g.shadowOffsetY = 1 * pxmm;
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
  if (S.power) {
    g.save();
    g.shadowColor = '#ff3b20';
    g.shadowBlur = 8 * pxmm;
    g.fill();
    g.restore();
  }

  // quartz lock
  const locked = S.power && S.pitch === 0;
  circle(g, UI.quartz.x, UI.quartz.y, 1.8);
  g.fillStyle = locked ? '#5dff8a' : '#1f3a26';
  g.fill();
  if (locked) {
    g.save();
    g.shadowColor = '#5dff8a';
    g.shadowBlur = 5 * pxmm;
    g.fill();
    g.restore();
  }

  // botão do pitch
  const f = UI.fader;
  const y = faderY();
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 3 * pxmm;
  g.shadowOffsetY = 1.5 * pxmm;
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

  // alavanca do cue
  const cq = UI.cue;
  const ly = S.cueUp ? cq.y + 6 : cq.y + cq.h - 8;
  roundRect(g, cq.x + 3, ly - 3, cq.w - 6, 6, 2);
  g.fillStyle = S.cueUp ? '#e9eaeb' : '#a3a5a7';
  g.fill();
}

function faderY() {
  const f = UI.fader;
  return f.y0 + (S.pitch + 1) / 2 * (f.y1 - f.y0);
}

function rot(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

function armGeometry(th) {
  const dir = { x: -Math.sin(th), y: Math.cos(th) };
  const st = stylusAt(th);
  const hd = rot(dir, HEAD_OFFSET);
  const col = { x: st.x - hd.x * 44, y: st.y - hd.y * 44 };
  return { dir, st, hd, col };
}

function drawArmShape(th, shadow) {
  const { dir, st, hd, col } = armGeometry(th);
  const P = PIVOT;
  const c1 = rot(dir, -0.16), c2 = rot(hd, -0.5);

  // contrapeso
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
  // haste traseira
  g.beginPath();
  g.moveTo(P.x, P.y);
  g.lineTo(P.x - dir.x * 34, P.y - dir.y * 34);
  g.strokeStyle = shadow || '#7c7f82';
  g.lineWidth = 5;
  g.stroke();

  // tubo em S
  g.beginPath();
  g.moveTo(P.x, P.y);
  g.bezierCurveTo(
    P.x + c1.x * 95, P.y + c1.y * 95,
    col.x - c2.x * 65, col.y - c2.y * 65,
    col.x, col.y,
  );
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

  // headshell + cápsula
  g.save();
  g.translate(col.x, col.y);
  g.rotate(Math.atan2(hd.y, hd.x));
  g.fillStyle = shadow || '#2a2b2d';
  roundRect(g, -3, -5, 10, 10, 2);           // colar
  g.fill();
  if (!shadow) { g.fillStyle = '#c9cbcc'; roundRect(g, -2, -4, 3, 8, 1); g.fill(); }
  g.fillStyle = shadow || '#1b1c1e';
  g.beginPath();                              // placa da headshell
  g.moveTo(6, -6);
  g.lineTo(50, -9);
  g.lineTo(52, 8);
  g.lineTo(6, 6);
  g.closePath();
  g.fill();
  g.fillStyle = shadow || '#1b1c1e';          // levantador de dedo
  roundRect(g, 26, -22, 4, 15, 1.5);
  g.fill();
  if (!shadow) {
    g.fillStyle = '#3a3b3e';
    roundRect(g, 26.5, -22, 3, 4, 1);
    g.fill();
    // cápsula
    roundRect(g, 26, -7.5, 24, 15, 2.5);
    const cart = g.createLinearGradient(0, -7.5, 0, 7.5);
    cart.addColorStop(0, '#2f3134');
    cart.addColorStop(0.5, '#4a4d51');
    cart.addColorStop(1, '#1e1f21');
    g.fillStyle = cart;
    g.fill();
    g.fillStyle = '#ff7a1a';
    g.fillRect(46, -6, 2.5, 12);
  }
  g.restore();

  // gimbal do pivô
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

function drawArm() {
  const th = S.armTheta;
  const lift = S.lift;
  g.save();
  g.translate(2 + lift * 5, 3 + lift * 7);
  g.globalAlpha = 0.35 - lift * 0.1;
  drawArmShape(th, '#000');
  g.restore();
  drawArmShape(th, null);
}

// ---------------------------------------------------------------------------
// Toque
// ---------------------------------------------------------------------------
const pointers = new Map();
const scratch = { id: null, lastA: 0, total: 0, base: 0, vel: 0, lastT: 0, lastMove: 0, sentZero: false };
let lastFaderTap = 0;

function inRect(p, b, pad = 5) {
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function hitTest(p) {
  if (inRect(p, UI.start, 7)) return 'start';
  if (inRect(p, UI.s33, 4)) return 's33';
  if (inRect(p, UI.s45, 4)) return 's45';
  if (Math.hypot(p.x - UI.power.x, p.y - UI.power.y) < UI.power.r + 6) return 'power';
  if (inRect(p, UI.cue, 6)) return 'cue';
  const f = UI.fader;
  if (Math.abs(p.x - f.x) < 17 && p.y > f.y0 - 14 && p.y < f.y1 + 14) return 'fader';
  const { st, col } = armGeometry(S.armTheta);
  const head = { x: st.x + (st.x - col.x) * 0.15, y: st.y + (st.y - col.y) * 0.15 };
  if (distToSeg(p, col, head) < 16) return 'arm';
  const mid = stylusAt(S.armTheta * 0.98);
  if (distToSeg(p, { x: (PIVOT.x + mid.x) / 2, y: (PIVOT.y + mid.y) / 2 }, col) < 8) return 'arm';
  if (Math.hypot(p.x - PC.x, p.y - PC.y) < PLATTER_R + 4) return 'record';
  return null;
}

function angleOf(p) {
  return Math.atan2(p.y - PC.y, p.x - PC.x);
}

function setPitchFromY(y) {
  const f = UI.fader;
  let v = clamp((y - f.y0) / (f.y1 - f.y0) * 2 - 1, -1, 1);
  if (Math.abs(v) < 0.03) v = 0;              // trava central
  if (v === 0 && S.pitch !== 0) buzz(12);
  S.pitch = v;
}

function onDown(e) {
  ensureAudio();
  requestWakeLock();
  const p = toDeck(e);
  const kind = hitTest(p);
  if (!kind) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const info = { kind };
  pointers.set(e.pointerId, info);

  switch (kind) {
    case 'start':
      S.pressed.add('start');
      buzz(14);
      if (S.power) S.motor = !S.motor;
      break;
    case 's33':
    case 's45':
      S.pressed.add(kind);
      buzz();
      if (S.power) S.base = kind === 's33' ? NOMINAL : 45;
      break;
    case 'power':
      buzz(20);
      S.power = !S.power;
      S.motor = false;
      break;
    case 'cue':
      setCue(!S.cueUp);
      break;
    case 'fader': {
      const now = performance.now();
      const ky = faderY();
      if (Math.abs(p.y - ky) < 10) {
        info.offset = p.y - ky;
        if (now - lastFaderTap < 320) { S.pitch = 0; buzz(12); info.offset = null; }
        lastFaderTap = now;
      } else {
        info.offset = 0;
        setPitchFromY(p.y);
      }
      break;
    }
    case 'arm': {
      const th = Math.atan2(-(p.x - PIVOT.x), p.y - PIVOT.y);
      info.thOffset = S.armTheta - th;
      liftNeedle();
      S.arm = 'drag';
      break;
    }
    case 'record': {
      if (S.scratching) { pointers.delete(e.pointerId); return; }
      S.scratching = true;
      Object.assign(scratch, {
        id: e.pointerId, lastA: angleOf(p), total: 0, base: S.recordAngle, vel: S.recordRPM / 60 * TAU,
        lastT: e.timeStamp, lastMove: performance.now(), sentZero: false,
      });
      lastSentRate = NaN;
      if (S.arm === 'play') post({ type: 'grab' });
      break;
    }
  }
}

function onMove(e) {
  const info = pointers.get(e.pointerId);
  if (!info) return;
  e.preventDefault();
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  const list = events.length ? events : [e];

  switch (info.kind) {
    case 'fader': {
      if (info.offset == null) return;
      const p = toDeck(e);
      setPitchFromY(p.y - info.offset);
      break;
    }
    case 'arm': {
      const p = toDeck(e);
      const th = Math.atan2(-(p.x - PIVOT.x), p.y - PIVOT.y) + info.thOffset;
      S.armTheta = clamp(th, -0.02, 1.0);
      break;
    }
    case 'record': {
      for (const ev of list) {
        const p = toDeck(ev);
        const a = angleOf(p);
        let d = a - scratch.lastA;
        if (d > Math.PI) d -= TAU;
        else if (d < -Math.PI) d += TAU;
        scratch.lastA = a;
        scratch.total += d;
        const dt = (ev.timeStamp - scratch.lastT) / 1000;
        if (dt > 0.0005) {
          const v = d / dt;
          scratch.vel += (v - scratch.vel) * 0.4;
          scratch.lastT = ev.timeStamp;
        }
      }
      scratch.lastMove = performance.now();
      scratch.sentZero = false;
      S.recordAngle = scratch.base + scratch.total;
      sendScratch();
      break;
    }
  }
}

function sendScratch() {
  if (S.arm !== 'play') return;
  post({
    type: 'follow',
    off: scratch.total / TAU * SEC_PER_REV,
    vel: scratch.vel / TAU * SEC_PER_REV,
  });
}

function onUp(e) {
  const info = pointers.get(e.pointerId);
  if (!info) return;
  pointers.delete(e.pointerId);

  switch (info.kind) {
    case 'start':
    case 's33':
    case 's45':
      S.pressed.delete(info.kind);
      break;
    case 'arm': {
      const st = stylusAt(S.armTheta);
      const r = Math.hypot(st.x - PC.x, st.y - PC.y);
      if (r < RECORD_R - 1 && r > RUNOUT_R - 1 && S.track) {
        dropNeedle(radiusToPos(r));
      } else {
        S.arm = 'rest';
      }
      break;
    }
    case 'record': {
      const idle = performance.now() - scratch.lastMove > 60;
      const omega = idle ? 0 : scratch.vel;
      S.recordRPM = clamp(omega * 60 / TAU, -400, 400);
      S.scratching = false;
      scratch.id = null;
      lastSentRate = NaN;
      break;
    }
  }
}

canvas.addEventListener('pointerdown', onDown);
canvas.addEventListener('pointermove', onMove);
canvas.addEventListener('pointerup', onUp);
canvas.addEventListener('pointercancel', onUp);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    ensureAudio();
    if (S.power) S.motor = !S.motor;
  } else if (e.code === 'ArrowUp') S.pitch = clamp(S.pitch - 0.01, -1, 1);
  else if (e.code === 'ArrowDown') S.pitch = clamp(S.pitch + 0.01, -1, 1);
});

let wakeLock = null;
async function requestWakeLock() {
  if (wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* sem permissão: tudo bem */ }
}

// ---------------------------------------------------------------------------
// Rodapé: CUT, fader, volume
// ---------------------------------------------------------------------------
const cutBtn = $('#cut');
const setCut = (on) => {
  S.cut = on;
  cutBtn.classList.toggle('active', on);
  applyGain();
};
cutBtn.addEventListener('pointerdown', (e) => {
  ensureAudio();
  cutBtn.setPointerCapture(e.pointerId);
  setCut(true);
});
for (const ev of ['pointerup', 'pointercancel']) cutBtn.addEventListener(ev, () => setCut(false));

const xf = $('#xfader');
const xfCap = xf.querySelector('.cap');
let xfId = null;
function setXf(e) {
  const r = xf.getBoundingClientRect();
  S.xf = clamp((e.clientX - r.left - 14) / (r.width - 28), 0, 1);
  renderXf();
  applyGain();
}
function renderXf() {
  xfCap.style.left = `calc(14px + (100% - 28px) * ${S.xf})`;
}
xf.addEventListener('pointerdown', (e) => {
  ensureAudio();
  xfId = e.pointerId;
  xf.setPointerCapture(e.pointerId);
  setXf(e);
});
xf.addEventListener('pointermove', (e) => { if (e.pointerId === xfId) setXf(e); });
for (const ev of ['pointerup', 'pointercancel']) xf.addEventListener(ev, () => { xfId = null; });
renderXf();

$('#vol').addEventListener('input', (e) => {
  S.vol = +e.target.value;
  applyGain();
});

// ---------------------------------------------------------------------------
// Folhas: carregar, ajustes, ajuda
// ---------------------------------------------------------------------------
function openSheet(id) { $(id).classList.add('open'); }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open')); }
document.querySelectorAll('.sheet').forEach((s) => {
  s.addEventListener('click', (e) => {
    if (e.target === s || e.target.hasAttribute('data-close')) closeSheets();
  });
});

$('#btnLoad').addEventListener('click', () => { ensureAudio(); openSheet('#sheetLoad'); });
$('#btnSettings').addEventListener('click', () => openSheet('#sheetSettings'));
$('#btnHelp').addEventListener('click', () => openSheet('#sheetHelp'));
$('#optFile').addEventListener('click', () => { closeSheets(); $('#file').click(); });
$('#optDemo').addEventListener('click', async () => {
  closeSheets();
  await ensureAudio();
  loadDemo();
});
$('#file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
  e.target.value = '';
});

function bindSeg(id, get, set) {
  const seg = $(id);
  const render = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    persist();
    render();
  });
  render();
}

bindSeg('#segRange', () => S.range, (v) => { S.range = +v; buildStatic(); });
bindSeg('#segOrient', () => S.orient, (v) => { S.orient = v; layout(); });
bindSeg('#segCrackle', () => (S.crackle ? 1 : 0), (v) => { S.crackle = v === '1'; post({ type: 'crackle', on: S.crackle }); });
bindSeg('#segHaptic', () => (S.haptic ? 1 : 0), (v) => { S.haptic = v === '1'; });

function bindRange(id, valId, key) {
  const el = $(id);
  const out = $(valId);
  el.value = S[key];
  out.textContent = `(${(+S[key]).toFixed(2)} s)`;
  el.addEventListener('input', () => {
    S[key] = +el.value;
    out.textContent = `(${S[key].toFixed(2)} s)`;
    persist();
  });
}
bindRange('#startTime', '#startVal', 'startTime');
bindRange('#brakeTime', '#brakeVal', 'brakeTime');

const busy = $('#busy');
function showBusy(t) { $('#busyText').textContent = t; busy.classList.add('open'); }
function hideBusy() { busy.classList.remove('open'); }

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------
const pitchEl = $('#pitchVal'), rpmEl = $('#rpmVal'), timeEl = $('#time');
let lastT = performance.now();
let frame = 0;

function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function tick(now) {
  const dt = clamp((now - lastT) / 1000, 0, 0.05);
  lastT = now;

  // mão parada no disco = velocidade zero
  if (S.scratching && !scratch.sentZero && performance.now() - scratch.lastMove > 28) {
    scratch.vel = 0;
    scratch.sentZero = true;
    sendScratch();
  }

  updatePhysics(dt);
  draw();

  if (++frame % 6 === 0) {
    const pct = S.pitch * S.range;
    pitchEl.textContent = (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(1) + '%';
    const rpm = S.scratching ? scratch.vel * 60 / TAU : S.recordRPM;
    rpmEl.textContent = rpm.toFixed(1);
    if (S.track) {
      const p = clamp(audioPos(), 0, S.track.duration);
      timeEl.textContent = `${fmt(p)} / −${fmt(S.track.duration - p)}`;
    }
  }
  requestAnimationFrame(tick);
}

// Mostra o disco demo desde o início (o áudio é criado no primeiro toque)
S.track = { title: 'Disco de batalha (demo)', duration: 50, demoPending: true };
$('#title').textContent = S.track.title;

new ResizeObserver(() => layout()).observe(stage);
layout();
requestAnimationFrame(tick);

window.__deck = { S, audioPos, get report() { return report; } };

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
