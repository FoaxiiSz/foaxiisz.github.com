// Motor de áudio do toca-discos. Roda na thread de áudio (AudioWorklet).
// A "agulha" lê o buffer em qualquer velocidade, inclusive para trás,
// com interpolação Hermite — é isso que dá o som de scratch.

const LOCK_GROOVE = 1.8; // segundos de áudio por volta em 33⅓ RPM

class TurntableProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null;
    this.R = null;
    this.len = 0;
    this.pos = 0;            // posição em amostras (pode ser < 0 = lead-in, > len = runout)
    this.rate = 0;           // velocidade atual (1 = normal, negativa = para trás)
    this.targetRate = 0;
    this.mode = 'rate';      // 'rate' (motor) ou 'follow' (mão no disco)
    this.anchor = 0;
    this.tOff = 0;
    this.tVel = 0;
    this.tAge = 0;
    this.needle = 0;         // 0 = levantada, 1 = no disco (suavizado)
    this.needleTarget = 0;
    this.crackle = true;
    this.hpX = [0, 0];
    this.hpY = [0, 0];
    this.pop = 0;
    this.popDecay = 0;
    this.thump = 0;
    this.reportCounter = 0;
    this.rnd = 12345;

    const sr = sampleRate;
    this.kRate = 1 - Math.exp(-1 / (sr * 0.006));
    this.kFollow = 1 - Math.exp(-1 / (sr * 0.0035));
    this.kNeedle = 1 - Math.exp(-1 / (sr * 0.004));
    this.hpA = Math.exp(-2 * Math.PI * 18 / sr); // passa-alta ~18 Hz: disco parado = silêncio

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.L = m.L;
        this.R = m.R || m.L;
        this.scale = m.int16 ? 1 / 32768 : 1;
        this.len = m.length;
        this.pos = m.startPos != null ? m.startPos * sampleRate : 0;
        break;
      case 'rate':
        this.mode = 'rate';
        this.targetRate = m.rate;
        break;
      case 'grab':
        this.mode = 'follow';
        this.anchor = this.pos;
        this.tOff = 0;
        this.tVel = this.rate;
        this.tAge = 0;
        break;
      case 'follow':
        this.tOff = m.off * sampleRate;
        this.tVel = m.vel;
        this.tAge = 0;
        break;
      case 'seek':
        this.pos = m.pos * sampleRate;
        break;
      case 'needle':
        this.needleTarget = m.down ? 1 : 0;
        if (m.down && m.thump) this.thump = 0.35;
        break;
      case 'crackle':
        this.crackle = m.on;
        break;
    }
  }

  random() {
    // xorshift: barato e determinístico
    let x = this.rnd;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rnd = x;
    return (x >>> 0) / 4294967296;
  }

  sample(ch, i) {
    return (i < 0 || i >= this.len) ? 0 : ch[i] * this.scale;
  }

  read(ch, p) {
    const i = Math.floor(p);
    const f = p - i;
    const xm1 = this.sample(ch, i - 1);
    const x0 = this.sample(ch, i);
    const x1 = this.sample(ch, i + 1);
    const x2 = this.sample(ch, i + 2);
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const bNeg = w + a;
    return ((((a * f) - bNeg) * f + c) * f + x0);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    const sr = sampleRate;
    const lock = LOCK_GROOVE * sr;
    const hasTrack = this.L !== null;

    for (let s = 0; s < n; s++) {
      if (this.mode === 'follow') {
        const target = this.anchor + this.tOff + this.tVel * this.tAge;
        this.tAge += 1;
        // velocidade desejada = velocidade da mão + correção do erro de posição
        const desired = this.tVel + (target - this.pos) / (sr * 0.018);
        this.rate += (desired - this.rate) * this.kFollow;
      } else {
        this.rate += (this.targetRate - this.rate) * this.kRate;
      }

      const prev = this.pos;
      this.pos += this.rate;

      // sulco de travamento (runout): fica girando no fim do disco
      let lockClick = false;
      if (this.len > 0 && this.pos > this.len + lock) {
        this.pos -= lock;
        lockClick = true;
      }
      if (this.pos < -6 * sr) this.pos = -6 * sr;

      this.needle += (this.needleTarget - this.needle) * this.kNeedle;

      let l = 0, r = 0;
      if (hasTrack && this.needle > 0.0005) {
        l = this.read(this.L, this.pos);
        r = this.read(this.R, this.pos);
      }

      // ruído do vinil: proporcional à velocidade do disco sob a agulha
      const speed = Math.abs(this.rate);
      if (this.crackle && this.needle > 0.01 && speed > 0.001) {
        const sp = Math.min(speed, 3);
        const hiss = (this.random() - 0.5) * 0.004 * sp;
        if (this.random() < 0.00012 * sp) {
          this.pop = (this.random() - 0.5) * (0.08 + this.random() * 0.25);
          this.popDecay = 0.55 + this.random() * 0.25;
        }
        l += hiss + this.pop;
        r += hiss + this.pop * 0.9;
        this.pop *= this.popDecay;
      }
      if (lockClick || (prev <= this.len && this.pos > this.len && this.len > 0)) {
        this.pop = 0.18;
        this.popDecay = 0.8;
      }

      l *= this.needle;
      r *= this.needle;

      if (this.thump > 0.0001) {
        const t = this.thump * Math.sin(this.thumpPhase = (this.thumpPhase || 0) + 0.006);
        l += t; r += t;
        this.thump *= 0.9993;
      } else {
        this.thumpPhase = 0;
      }

      // passa-alta: segurar o disco parado não gera DC (igual cápsula magnética)
      const yl = this.hpA * (this.hpY[0] + l - this.hpX[0]);
      const yr = this.hpA * (this.hpY[1] + r - this.hpX[1]);
      this.hpX[0] = l; this.hpX[1] = r;
      this.hpY[0] = yl; this.hpY[1] = yr;

      oL[s] = yl;
      if (oR !== oL) oR[s] = yr;
    }

    this.reportCounter += n;
    if (this.reportCounter >= 512) {
      this.reportCounter = 0;
      this.port.postMessage({ pos: this.pos / sr, rate: this.rate, t: currentTime });
    }
    return true;
  }
}

registerProcessor('turntable', TurntableProcessor);
