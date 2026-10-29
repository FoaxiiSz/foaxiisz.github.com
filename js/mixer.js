import { clamp, view, roundRect, circle, text, glow, drawKnob, knobScale } from './draw.js';
import { FX_TYPES, BEATS, BEAT_LABELS, mixLevels, createFx } from './fx.js';

// Mixer de 2 canais estilo DJM: TRIM, EQ 3 bandas, FILTER, faders,
// crossfader com curva, medidores e seção BEAT FX.
export const MW = 300, MH = 360;

const STRIP_X = [52, 128];
const KNOBS = [
  { key: 'trim', y: 26, r: 10, def: 0.7, label: 'TRIM' },
  { key: 'hi', y: 56, r: 10, def: 0.5, label: 'HI', centered: true },
  { key: 'mid', y: 84, r: 10, def: 0.5, label: 'MID', centered: true },
  { key: 'low', y: 112, r: 10, def: 0.5, label: 'LOW', centered: true },
  { key: 'color', y: 145, r: 11, def: 0.5, label: 'FILTER', centered: true },
];
const CHF = { y0: 178, y1: 276 };
const XF = { y: 326, x0: 84, x1: 216 };
const CURVE = { x: 18, y: 318, w: 36, h: 16 };
const LCD = { x: 174, y: 12, w: 116, h: 40 };
const BTN = [
  { id: 'beatDown', x: 174, y: 57, w: 36, h: 15, label: '◀ BEAT' },
  { id: 'beatUp', x: 214, y: 57, w: 36, h: 15, label: 'BEAT ▶' },
  { id: 'tap', x: 254, y: 57, w: 36, h: 15, label: 'TAP' },
  ...FX_TYPES.map((t, i) => ({
    id: 'fx' + i, x: 174 + (i % 3) * 40, y: 82 + Math.floor(i / 3) * 20, w: 36, h: 16,
    label: t.id === 'PING PONG' ? 'PING' : t.id,
  })),
  { id: 'ch0', x: 174, y: 150, w: 36, h: 15, label: '1' },
  { id: 'ch1', x: 214, y: 150, w: 36, h: 15, label: '2' },
  { id: 'chM', x: 254, y: 150, w: 36, h: 15, label: 'MST' },
];
const FXON = { x: 228, y: 182, w: 62, h: 30 };
const DEPTH = { x: 196, y: 197, r: 14 };
const MASTER = { x: 196, y: 254, r: 11 };
const MMETER = { x: 256, y: 230, h: 66 };
const LEDS = 15;

const dbToGain = (db) => Math.pow(10, db / 20);

export class Mixer {
  constructor(ox, env) {
    this.ox = ox;
    this.env = env;   // { cfg, buzz }
    this.ch = [0, 1].map(() => ({ trim: 0.7, hi: 0.5, mid: 0.5, low: 0.5, color: 0.5, fader: 0.85, level: 0, peakHold: 0 }));
    this.xf = 0.5;
    this.master = 0.8;
    this.masterLevel = [0, 0];
    this.fx = { type: 0, beatIdx: FX_TYPES[0].beat, depth: 0.55, on: false, target: 'M', manualBpm: null, taps: [] };
    this.pressed = new Set();
    this.lastTap = {};
    this.lastLen = 0;
    this.bpm = 120;
    this.actx = null;
  }

  get curve() { return this.env.cfg.curve; }

  // ----- áudio -------------------------------------------------------------
  initAudio(actx, nodes) {
    this.actx = actx;
    this.bus = actx.createGain();
    this.masterGain = actx.createGain();
    this.limiter = actx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    this.split = actx.createChannelSplitter(2);
    this.anL = actx.createAnalyser();
    this.anR = actx.createAnalyser();
    this.anL.fftSize = this.anR.fftSize = 512;
    this.bus.connect(this.masterGain).connect(this.limiter).connect(actx.destination);
    this.limiter.connect(this.split);
    this.split.connect(this.anL, 0);
    this.split.connect(this.anR, 1);
    this.fxIn = actx.createGain();
    this.fxWet = actx.createGain();
    this.fxWet.gain.value = 0;
    this.fxWet.connect(this.bus);
    this.buf = new Float32Array(512);

    this.chs = nodes.map((node) => {
      const n = {
        trim: actx.createGain(),
        low: actx.createBiquadFilter(),
        mid: actx.createBiquadFilter(),
        hi: actx.createBiquadFilter(),
        lp: actx.createBiquadFilter(),
        hp: actx.createBiquadFilter(),
        fader: actx.createGain(),
        xf: actx.createGain(),
        an: actx.createAnalyser(),
        direct: actx.createGain(),
        send: actx.createGain(),
      };
      n.low.type = 'lowshelf'; n.low.frequency.value = 110;
      n.mid.type = 'peaking'; n.mid.frequency.value = 1000; n.mid.Q.value = 0.8;
      n.hi.type = 'highshelf'; n.hi.frequency.value = 8000;
      n.lp.type = 'lowpass'; n.lp.frequency.value = 22000;
      n.hp.type = 'highpass'; n.hp.frequency.value = 10;
      n.an.fftSize = 512;
      n.send.gain.value = 0;
      node.connect(n.trim).connect(n.low).connect(n.mid).connect(n.hi).connect(n.lp).connect(n.hp);
      n.hp.connect(n.an);                          // medidor pré-fader, como no DJM
      n.hp.connect(n.fader).connect(n.xf);
      n.xf.connect(n.direct).connect(this.bus);
      n.xf.connect(n.send).connect(this.fxIn);
      return n;
    });
    this.buildFx();
    this.applyAll();
  }

  set(param, value, tc = 0.008) {
    if (this.actx) param.setTargetAtTime(value, this.actx.currentTime, tc);
  }

  applyChannel(i) {
    if (!this.actx) return;
    const c = this.ch[i], n = this.chs[i];
    const tdb = c.trim < 0.01 ? -120 : c.trim >= 0.7 ? (c.trim - 0.7) / 0.3 * 9 : -Math.pow((0.7 - c.trim) / 0.7, 0.8) * 36;
    this.set(n.trim.gain, dbToGain(tdb));
    const eq = (v) => (v >= 0.5 ? (v - 0.5) / 0.5 * 6 : v < 0.02 ? -40 : -Math.pow((0.5 - v) / 0.5, 0.75) * 26);
    this.set(n.hi.gain, eq(c.hi));
    this.set(n.mid.gain, eq(c.mid));
    this.set(n.low.gain, eq(c.low));
    // FILTER: esquerda = passa-baixa, direita = passa-alta, com ressonância
    const v = c.color;
    if (v < 0.47) {
      const t = (0.47 - v) / 0.47;
      this.set(n.lp.frequency, 20000 * Math.pow(150 / 20000, t), 0.02);
      this.set(n.lp.Q, 0.7 + t * 5, 0.02);
      this.set(n.hp.frequency, 10, 0.02);
      this.set(n.hp.Q, 0.7, 0.02);
    } else if (v > 0.53) {
      const t = (v - 0.53) / 0.47;
      this.set(n.hp.frequency, 20 * Math.pow(6000 / 20, t), 0.02);
      this.set(n.hp.Q, 0.7 + t * 5, 0.02);
      this.set(n.lp.frequency, 22000, 0.02);
      this.set(n.lp.Q, 0.7, 0.02);
    } else {
      this.set(n.lp.frequency, 22000, 0.02);
      this.set(n.hp.frequency, 10, 0.02);
      this.set(n.lp.Q, 0.7, 0.02);
      this.set(n.hp.Q, 0.7, 0.02);
    }
    this.set(n.fader.gain, c.fader <= 0.001 ? 0 : Math.pow(c.fader, 1.6), 0.003);
  }

  xfGains() {
    const x = this.xf;
    if (this.curve === 'cut') {
      // curva de scratch: abre quase no início do curso
      return [clamp((1 - x) / 0.04, 0, 1), clamp(x / 0.04, 0, 1)];
    }
    // curva de mixagem: os dois cheios no meio, caem suavemente nas pontas
    return [Math.min(1, Math.cos(x * Math.PI / 2) * Math.SQRT2), Math.min(1, Math.sin(x * Math.PI / 2) * Math.SQRT2)];
  }

  applyXf() {
    if (!this.actx) return;
    const [a, b] = this.xfGains();
    this.set(this.chs[0].xf.gain, a, 0.001);
    this.set(this.chs[1].xf.gain, b, 0.001);
  }

  applyMaster() {
    if (this.actx) this.set(this.masterGain.gain, Math.pow(this.master / 0.8, 2) * 0.9, 0.02);
  }

  applyAll() {
    this.applyChannel(0);
    this.applyChannel(1);
    this.applyXf();
    this.applyMaster();
    this.applyRouting();
  }

  // ----- Beat FX -----------------------------------------------------------
  buildFx() {
    if (!this.actx) return;
    const old = this.fxNode;
    if (old) {
      this.fxIn.disconnect();
      setTimeout(() => old.dispose(), 80);
    }
    this.fxNode = createFx(this.actx, FX_TYPES[this.fx.type].id);
    this.fxIn.connect(this.fxNode.input);
    this.fxNode.output.connect(this.fxWet);
    this.lastLen = 0;
    this.updateFxTiming();
    if (this.fx.on) this.fxNode.start();
    this.applyRouting();
  }

  applyRouting() {
    if (!this.actx) return;
    const t = FX_TYPES[this.fx.type];
    const { dry, wet } = mixLevels(t.id, this.fx.depth);
    for (let i = 0; i < 2; i++) {
      const targeted = this.fx.on && (this.fx.target === 'M' || this.fx.target === i);
      this.set(this.chs[i].direct.gain, targeted ? dry : 1, 0.004);
      this.set(this.chs[i].send.gain, targeted ? 1 : 0, 0.004);
    }
    this.set(this.fxWet.gain, this.fx.on || t.tail ? wet : 0, 0.004);
  }

  fxBpm(decks) {
    if (this.fx.manualBpm) return this.fx.manualBpm;
    let d;
    if (this.fx.target === 0 || this.fx.target === 1) d = decks[this.fx.target];
    else {
      const [ga, gb] = this.xfGains();
      const w = decks.map((dk, i) => (dk.S.motor ? 1 : 0.1) * this.ch[i].fader * [ga, gb][i]);
      d = w[1] > w[0] ? decks[1] : decks[0];
    }
    return (d && d.bpmNow()) || 120;
  }

  updateFxTiming() {
    if (!this.fxNode) return;
    const len = 60 / this.bpm * BEATS[this.fx.beatIdx];
    if (Math.abs(len - this.lastLen) / len > 0.004) {
      this.fxNode.set(len, this.fx.beatIdx);
      this.lastLen = len;
    }
  }

  setFxOn(on) {
    this.fx.on = on;
    this.env.buzz(12);
    if (this.fxNode) {
      if (on) this.fxNode.start();
      else this.fxNode.stop();
    }
    this.applyRouting();
  }

  // ----- quadro --------------------------------------------------------------
  update(dt, decks) {
    this.bpm = this.fxBpm(decks);
    this.updateFxTiming();
    if (!this.actx) return;
    const peakDb = (an) => {
      an.getFloatTimeDomainData(this.buf);
      let m = 0;
      for (let i = 0; i < this.buf.length; i++) m = Math.max(m, Math.abs(this.buf[i]));
      return 20 * Math.log10(m + 1e-6);
    };
    const fall = 26 * dt;   // dB/s de queda dos LEDs
    this.chs.forEach((n, i) => {
      const db = peakDb(n.an);
      const c = this.ch[i];
      c.level = Math.max(db, c.level - fall);
    });
    [this.anL, this.anR].forEach((an, i) => {
      this.masterLevel[i] = Math.max(peakDb(an), this.masterLevel[i] - fall);
    });
  }

  // ----- desenho -------------------------------------------------------------
  drawStatic(c, pxmm) {
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 14 * pxmm;
    c.shadowOffsetY = 5 * pxmm;
    roundRect(c, 4, 0, MW - 8, MH, 6);
    c.fillStyle = '#16171a';
    c.fill();
    c.restore();
    const body = c.createLinearGradient(0, 0, 0, MH);
    body.addColorStop(0, '#26282c');
    body.addColorStop(1, '#17181b');
    roundRect(c, 4, 0, MW - 8, MH, 6);
    c.fillStyle = body;
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.12)';
    c.lineWidth = 0.8;
    c.stroke();

    // parafusos
    for (const [x, y] of [[12, 8], [MW - 12, 8], [12, MH - 8], [MW - 12, MH - 8]]) {
      circle(c, x, y, 2.4);
      c.fillStyle = '#0d0d0f';
      c.fill();
      c.strokeStyle = '#3a3c40';
      c.lineWidth = 0.5;
      c.beginPath();
      c.moveTo(x - 1.6, y);
      c.lineTo(x + 1.6, y);
      c.stroke();
    }

    // divisória da seção de efeitos
    c.strokeStyle = 'rgba(255,255,255,0.1)';
    c.lineWidth = 0.6;
    c.beginPath();
    c.moveTo(166, 10);
    c.lineTo(166, 296);
    c.stroke();
    c.beginPath();
    c.moveTo(12, 300);
    c.lineTo(MW - 12, 300);
    c.stroke();

    const ink = '#c9cbcf', soft = '#8b8e93';
    // rótulos dos canais
    STRIP_X.forEach((x, i) => {
      KNOBS.forEach((k) => {
        knobScale(c, x, k.y, k.r, k.centered, soft);
        const lx = i === 0 ? x - k.r - 5 : x + k.r + 5;
        text(c, k.label, lx, k.y, 3.4, { align: i === 0 ? 'right' : 'left', color: ink, weight: 700 });
      });
      // trilho do fader de canal
      roundRect(c, x - 1.6, CHF.y0 - 5, 3.2, CHF.y1 - CHF.y0 + 10, 1.6);
      c.fillStyle = '#060607';
      c.fill();
      for (let k = 0; k <= 10; k++) {
        const y = CHF.y0 + k / 10 * (CHF.y1 - CHF.y0);
        c.strokeStyle = soft;
        c.lineWidth = k % 5 === 0 ? 0.6 : 0.35;
        c.beginPath();
        c.moveTo(x + 10, y);
        c.lineTo(x + (k % 5 === 0 ? 15 : 13), y);
        c.stroke();
        c.beginPath();
        c.moveTo(x - 10, y);
        c.lineTo(x - (k % 5 === 0 ? 15 : 13), y);
        c.stroke();
      }
      roundRect(c, x - 9, CHF.y1 + 10, 18, 9, 2);
      c.fillStyle = '#0c0c0e';
      c.fill();
      text(c, String(i + 1), x, CHF.y1 + 14.6, 5, { color: '#fff', weight: 800 });
    });
    text(c, 'CH LEVEL', 90, 18, 3, { color: soft });

    // crossfader
    roundRect(c, XF.x0 - 12, XF.y - 1.6, XF.x1 - XF.x0 + 24, 3.2, 1.6);
    c.fillStyle = '#060607';
    c.fill();
    for (let k = 0; k <= 10; k++) {
      const x = XF.x0 + k / 10 * (XF.x1 - XF.x0);
      c.strokeStyle = soft;
      c.lineWidth = k % 5 === 0 ? 0.6 : 0.35;
      c.beginPath();
      c.moveTo(x, XF.y + 11);
      c.lineTo(x, XF.y + (k % 5 === 0 ? 16 : 14));
      c.stroke();
    }
    text(c, 'A', XF.x0 - 20, XF.y, 5, { color: '#ff7a1a', weight: 800 });
    text(c, 'B', XF.x1 + 20, XF.y, 5, { color: '#ffd21a', weight: 800 });
    text(c, 'CROSSFADER', 150, XF.y - 13, 3.4, { color: soft, weight: 700 });
    text(c, 'CURVE', CURVE.x + CURVE.w / 2, CURVE.y - 5, 3.2, { color: soft, weight: 700 });
    text(c, 'MIX', CURVE.x + 9, CURVE.y + CURVE.h + 5, 3, { color: soft });
    text(c, 'CUT', CURVE.x + CURVE.w - 9, CURVE.y + CURVE.h + 5, 3, { color: soft });
    roundRect(c, CURVE.x, CURVE.y, CURVE.w, CURVE.h, 3);
    c.fillStyle = '#060607';
    c.fill();

    // seção de efeitos
    text(c, 'BEAT FX', 232, 77, 3.2, { color: soft, weight: 700 });
    text(c, 'CH SELECT', 232, 145, 3.2, { color: soft, weight: 700 });
    knobScale(c, DEPTH.x, DEPTH.y, DEPTH.r, false, soft);
    text(c, 'LEVEL/DEPTH', DEPTH.x, DEPTH.y + DEPTH.r + 7, 3, { color: soft, weight: 700 });
    knobScale(c, MASTER.x, MASTER.y, MASTER.r, false, soft);
    text(c, 'MASTER', MASTER.x, MASTER.y + MASTER.r + 7, 3.2, { color: soft, weight: 700 });
    text(c, 'MASTER', MMETER.x + 9, MMETER.y - 6, 3, { color: soft });
    roundRect(c, LCD.x - 1.5, LCD.y - 1.5, LCD.w + 3, LCD.h + 3, 3);
    c.fillStyle = '#050506';
    c.fill();

    text(c, 'DJ MIXER', 150, MH - 10, 4.4, { color: '#5a5d62', weight: 800 });
  }

  drawMeter(g, x, y0, h, db) {
    const seg = h / LEDS;
    for (let k = 0; k < LEDS; k++) {
      const thr = -42 + k * 3;    // −42 … 0 dB
      const on = db >= thr;
      const col = k >= LEDS - 2 ? '#ff3b30' : k >= LEDS - 5 ? '#ffb020' : '#2fe36b';
      const y = y0 + h - (k + 1) * seg;
      g.fillStyle = on ? col : '#1a1c1a';
      g.fillRect(x, y + 0.4, 5, seg - 0.8);
    }
  }

  drawFaderCap(g, x, y, horizontal) {
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.7)';
    g.shadowBlur = 3 * view.k;
    g.shadowOffsetY = 1.5 * view.k;
    if (horizontal) roundRect(g, x - 6, y - 10, 12, 20, 2);
    else roundRect(g, x - 10, y - 6, 20, 12, 2);
    g.fillStyle = '#26282b';
    g.fill();
    g.restore();
    g.fillStyle = '#3a3c40';
    if (horizontal) g.fillRect(x - 4.5, y - 8.5, 9, 17);
    else g.fillRect(x - 8.5, y - 4.5, 17, 9);
    g.fillStyle = '#f0f0f0';
    if (horizontal) g.fillRect(x - 0.5, y - 8.5, 1, 17);
    else g.fillRect(x - 8.5, y - 0.5, 17, 1);
  }

  drawBtn(g, b, active, color = '#ffffff') {
    const pressed = this.pressed.has(b.id);
    roundRect(g, b.x, b.y + (pressed ? 0.5 : 0), b.w, b.h, 2.5);
    g.fillStyle = pressed ? '#1d1e21' : '#2c2e32';
    g.fill();
    if (active) {
      g.strokeStyle = color;
      g.lineWidth = 0.9;
      g.stroke();
      g.save();
      g.shadowColor = color;
      g.shadowBlur = 4 * view.k;
      g.stroke();
      g.restore();
    }
    text(g, b.label, b.x + b.w / 2, b.y + b.h / 2 + (pressed ? 0.5 : 0), b.label.length > 6 ? 3.2 : 3.6, {
      color: active ? color : '#c9cbcf', weight: 800,
    });
  }

  draw(g, now) {
    // canais
    STRIP_X.forEach((x, i) => {
      const c = this.ch[i];
      KNOBS.forEach((k) => drawKnob(g, x, k.y, k.r, c[k.key]));
      const fy = CHF.y1 - c.fader * (CHF.y1 - CHF.y0);
      this.drawFaderCap(g, x, fy, false);
    });
    this.drawMeter(g, 84, 22, 104, this.ch[0].level);
    this.drawMeter(g, 91, 22, 104, this.ch[1].level);

    // crossfader e curva
    const cx = XF.x0 + this.xf * (XF.x1 - XF.x0);
    this.drawFaderCap(g, cx, XF.y, true);
    const sx = this.curve === 'cut' ? CURVE.x + CURVE.w - 9 : CURVE.x + 9;
    roundRect(g, sx - 7, CURVE.y + 2, 14, CURVE.h - 4, 2);
    g.fillStyle = '#c9cbcf';
    g.fill();

    // LCD
    const fx = this.fx;
    const t = FX_TYPES[fx.type];
    roundRect(g, LCD.x, LCD.y, LCD.w, LCD.h, 2);
    const lg = g.createLinearGradient(0, LCD.y, 0, LCD.y + LCD.h);
    lg.addColorStop(0, '#0c1420');
    lg.addColorStop(1, '#070b12');
    g.fillStyle = lg;
    g.fill();
    const ice = '#dff3ff';
    text(g, t.id, LCD.x + 5, LCD.y + 10, 7, { align: 'left', color: ice, weight: 800 });
    text(g, BEAT_LABELS[fx.beatIdx], LCD.x + LCD.w - 5, LCD.y + 10, 7, { align: 'right', color: '#ffb347', weight: 800 });
    text(g, `${this.bpm.toFixed(1)} BPM`, LCD.x + 5, LCD.y + 24, 5, { align: 'left', color: ice, weight: 700 });
    text(g, fx.manualBpm ? 'TAP' : 'AUTO', LCD.x + LCD.w - 5, LCD.y + 24, 3.6, { align: 'right', color: '#7fb6d9', weight: 700 });
    const tgt = fx.target === 'M' ? 'MASTER' : 'CH ' + (fx.target + 1);
    text(g, `${tgt}  ·  ${Math.round(fx.depth * 100)}%`, LCD.x + 5, LCD.y + 34, 3.6, { align: 'left', color: '#7fb6d9', weight: 700 });
    // barrinha de batida
    const beatPhase = ((now / 1000) * this.bpm / 60) % 1;
    g.fillStyle = beatPhase < 0.2 ? '#ffb347' : '#2b3a4a';
    g.fillRect(LCD.x + LCD.w - 10, LCD.y + 31, 5, 5);

    // botões
    for (const b of BTN) {
      let active = false, color = '#ffffff';
      if (b.id.startsWith('fx')) { active = +b.id.slice(2) === fx.type; color = '#7fd4ff'; }
      if (b.id === 'ch0') active = fx.target === 0;
      if (b.id === 'ch1') active = fx.target === 1;
      if (b.id === 'chM') active = fx.target === 'M';
      if (b.id === 'tap') { active = !!fx.manualBpm; color = '#ffb347'; }
      this.drawBtn(g, b, active, color);
    }

    drawKnob(g, DEPTH.x, DEPTH.y, DEPTH.r, fx.depth);
    drawKnob(g, MASTER.x, MASTER.y, MASTER.r, this.master);
    this.drawMeter(g, MMETER.x, MMETER.y, MMETER.h, this.masterLevel[0]);
    this.drawMeter(g, MMETER.x + 7, MMETER.y, MMETER.h, this.masterLevel[1]);

    // botão ON (pisca no tempo quando ligado)
    const lit = fx.on && beatPhase < 0.5;
    const pressed = this.pressed.has('fxon');
    roundRect(g, FXON.x, FXON.y + (pressed ? 0.6 : 0), FXON.w, FXON.h, 4);
    g.fillStyle = fx.on ? (lit ? '#ff2d2d' : '#a01818') : '#2c2e32';
    g.fill();
    if (fx.on) glow(g, '#ff2d2d', lit ? 8 : 3);
    text(g, 'ON', FXON.x + FXON.w / 2, FXON.y + FXON.h / 2 + (pressed ? 0.6 : 0), 6, {
      color: fx.on ? '#fff' : '#c9cbcf', weight: 800,
    });
  }

  // ----- toque ---------------------------------------------------------------
  hit(p) {
    for (let i = 0; i < 2; i++) {
      const x = STRIP_X[i];
      for (const k of KNOBS) {
        if (Math.hypot(p.x - x, p.y - k.y) < k.r + 4) return { kind: 'knob', ch: i, key: k.key, def: k.def };
      }
      if (Math.abs(p.x - x) < 15 && p.y > CHF.y0 - 12 && p.y < CHF.y1 + 12) return { kind: 'chfader', ch: i };
    }
    if (Math.hypot(p.x - DEPTH.x, p.y - DEPTH.y) < DEPTH.r + 4) return { kind: 'knob', key: 'depth', def: 0.55 };
    if (Math.hypot(p.x - MASTER.x, p.y - MASTER.y) < MASTER.r + 4) return { kind: 'knob', key: 'master', def: 0.8 };
    if (p.y > XF.y - 14 && p.y < XF.y + 14 && p.x > XF.x0 - 18 && p.x < XF.x1 + 18) return { kind: 'xf' };
    const inB = (b, pad = 2) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
    if (inB(CURVE, 5)) return { kind: 'curve' };
    if (inB(FXON, 3)) return { kind: 'btn', id: 'fxon' };
    for (const b of BTN) if (inB(b)) return { kind: 'btn', id: b.id };
    return null;
  }

  getKnob(info) {
    if (info.key === 'depth') return this.fx.depth;
    if (info.key === 'master') return this.master;
    return this.ch[info.ch][info.key];
  }

  setKnob(info, v) {
    if (info.key === 'depth') { this.fx.depth = v; this.applyRouting(); return; }
    if (info.key === 'master') { this.master = v; this.applyMaster(); return; }
    const c = this.ch[info.ch];
    if (info.def === 0.5 && Math.abs(v - 0.5) < 0.02) v = 0.5;   // trava no centro
    c[info.key] = v;
    this.applyChannel(info.ch);
  }

  down(p, e) {
    const info = this.hit(p);
    if (!info) return null;
    switch (info.kind) {
      case 'knob': {
        const id = (info.ch ?? '') + info.key;
        const now = performance.now();
        info.startY = e.clientY;
        info.startV = this.getKnob(info);
        if (now - (this.lastTap[id] || 0) < 300) {
          this.setKnob(info, info.def);
          info.startV = info.def;
          this.env.buzz(10);
        }
        this.lastTap[id] = now;
        break;
      }
      case 'chfader': {
        const c = this.ch[info.ch];
        const fy = CHF.y1 - c.fader * (CHF.y1 - CHF.y0);
        info.offset = Math.abs(p.y - fy) < 8 ? p.y - fy : 0;
        this.moveChFader(info, p);
        break;
      }
      case 'xf': {
        const cx = XF.x0 + this.xf * (XF.x1 - XF.x0);
        info.offset = Math.abs(p.x - cx) < 8 ? p.x - cx : 0;
        this.moveXf(info, p);
        break;
      }
      case 'curve':
        this.env.cfg.curve = this.curve === 'cut' ? 'mix' : 'cut';
        this.env.saveCfg();
        this.applyXf();
        this.env.buzz();
        break;
      case 'btn':
        this.pressed.add(info.id);
        info.t0 = performance.now();
        this.press(info.id);
        break;
    }
    return info;
  }

  moveChFader(info, p) {
    const v = clamp((CHF.y1 - (p.y - info.offset)) / (CHF.y1 - CHF.y0), 0, 1);
    this.ch[info.ch].fader = v;
    this.applyChannel(info.ch);
  }

  moveXf(info, p) {
    this.xf = clamp((p.x - info.offset - XF.x0) / (XF.x1 - XF.x0), 0, 1);
    this.applyXf();
  }

  move(info, p, e) {
    switch (info.kind) {
      case 'knob': {
        const v = clamp(info.startV - (e.clientY - info.startY) / 160, 0, 1);
        this.setKnob(info, v);
        break;
      }
      case 'chfader': this.moveChFader(info, p); break;
      case 'xf': this.moveXf(info, p); break;
    }
  }

  up(info) {
    if (info.kind === 'btn') {
      this.pressed.delete(info.id);
      // segurar TAP volta para BPM automático
      if (info.id === 'tap' && performance.now() - info.t0 > 650) {
        this.fx.manualBpm = null;
        this.fx.taps = [];
        this.env.buzz(20);
      }
    }
  }

  press(id) {
    const fx = this.fx;
    this.env.buzz(8);
    if (id === 'fxon') this.setFxOn(!fx.on);
    else if (id === 'beatDown') fx.beatIdx = Math.max(0, fx.beatIdx - 1);
    else if (id === 'beatUp') fx.beatIdx = Math.min(BEATS.length - 1, fx.beatIdx + 1);
    else if (id === 'tap') {
      const now = performance.now();
      fx.taps = fx.taps.filter((t) => now - t < 2000);
      fx.taps.push(now);
      if (fx.taps.length >= 3) {
        const iv = (fx.taps[fx.taps.length - 1] - fx.taps[0]) / (fx.taps.length - 1);
        fx.manualBpm = clamp(60000 / iv, 60, 200);
      }
    } else if (id.startsWith('fx')) {
      const type = +id.slice(2);
      if (type !== fx.type) {
        fx.type = type;
        fx.beatIdx = FX_TYPES[type].beat;
        this.buildFx();
      }
    } else if (id === 'ch0') { fx.target = 0; this.applyRouting(); }
    else if (id === 'ch1') { fx.target = 1; this.applyRouting(); }
    else if (id === 'chM') { fx.target = 'M'; this.applyRouting(); }
  }
}
