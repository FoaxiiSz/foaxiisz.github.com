import { makeDemoTrack } from './demo.js';
import { detectBPM } from './bpm.js';
import { clamp, view, offscreen } from './draw.js';
import { Deck, DW, DH, buildStrobeImages } from './deck.js';
import { Mixer, MW } from './mixer.js';

// ---------------------------------------------------------------------------
// Cena: [toca-discos A] [mixer] [toca-discos B], em milímetros
// ---------------------------------------------------------------------------
const SW = DW * 2 + MW, SH = DH;
const MARGIN = 12;
const FOCUS = {
  A: { x: 0, w: DW },
  AM: { x: 0, w: DW + MW },
  M: { x: DW, w: MW },
  MB: { x: DW, w: DW + MW },
  B: { x: DW + MW, w: DW },
  ALL: { x: 0, w: SW },
};

const $ = (sel) => document.querySelector(sel);

const cfg = (() => {
  const d = { range: 8, startTime: 0.7, brakeTime: 0.9, crackle: true, haptic: true, finish: 'black', curve: 'mix', focus: 'ALL' };
  try { return { ...d, ...JSON.parse(localStorage.getItem('vinil-mk2-mesa') || '{}') }; } catch { return d; }
})();
function saveCfg() {
  try { localStorage.setItem('vinil-mk2-mesa', JSON.stringify(cfg)); } catch { /* modo privado */ }
}
const buzz = (ms = 8) => { if (cfg.haptic && navigator.vibrate) navigator.vibrate(ms); };

const audio = { actx: null };
const env = { cfg, buzz, saveCfg, audio, strobe: [], pxmm: 2 };
const decks = [new Deck('A', 0, env), new Deck('B', DW + MW, env)];
const mixer = new Mixer(DW, env);

// ---------------------------------------------------------------------------
// Áudio
// ---------------------------------------------------------------------------
let audioReady = null;

function ensureAudio() {
  if (audioReady) {
    if (audio.actx && audio.actx.state !== 'running') audio.actx.resume();
    return audioReady;
  }
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* opcional */ }
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = new AC({ latencyHint: 'interactive' });
  audio.actx = actx;
  actx.resume();
  audioReady = (async () => {
    await actx.audioWorklet.addModule('js/deck-worklet.js');
    const nodes = decks.map(() => new AudioWorkletNode(actx, 'turntable', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    }));
    mixer.initAudio(actx, nodes);
    decks.forEach((d, i) => d.attach(nodes[i]));
    decks.forEach((d) => { if (!d.S.track || d.S.track.demoPending) loadDemo(d); });
  })();
  return audioReady;
}

function loadDemo(deck) {
  const sr = audio.actx ? audio.actx.sampleRate : 48000;
  const demo = makeDemoTrack(sr, deck.id);
  const title = deck.id === 'A' ? 'Disco de batalha (demo)' : 'Groove 96 (demo)';
  deck.setTrack({ title, duration: demo.duration, bpm: demo.bpm }, demo);
}

async function loadFile(deck, file) {
  showBusy('Prensando o disco…');
  try {
    await ensureAudio();
    const bytes = await file.arrayBuffer();
    const buf = await audio.actx.decodeAudioData(bytes);
    if (buf.duration > 15 * 60) throw new Error('Música muito longa (máx. 15 min).');
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    $('#busyText').textContent = 'Medindo o BPM…';
    await new Promise((r) => setTimeout(r, 30));
    const bpm = detectBPM(L, buf.sampleRate);
    const title = file.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ');
    deck.setTrack({ title, duration: buf.duration, bpm }, { L, R });
  } catch (err) {
    alert('Não consegui abrir esse arquivo.\n' + (err && err.message ? err.message : ''));
  } finally {
    hideBusy();
  }
}

// ---------------------------------------------------------------------------
// Câmera / layout
// ---------------------------------------------------------------------------
const canvas = $('#deck');
const g = canvas.getContext('2d');
const stage = $('#stage');
let cw = 1, ch = 1, dpr = 1;
const cam = { ...(FOCUS[cfg.focus] || FOCUS.ALL) };
let M = new DOMMatrix(), Minv = new DOMMatrix();
let staticLayer = null;

function scaleFor(f) {
  return Math.min((cw - 8) / f.w, (ch - 8) / SH);
}

function layout() {
  const rect = stage.getBoundingClientRect();
  cw = Math.max(1, rect.width);
  ch = Math.max(1, rect.height);
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  // resolução das camadas pré-desenhadas = maior zoom possível
  const maxS = Math.max(...Object.values(FOCUS).map(scaleFor));
  env.pxmm = clamp(maxS * dpr, 1, 3.2);
  env.strobe = buildStrobeImages(env.pxmm);
  decks.forEach((d) => { d.buildRecordImage(); d.sheen = null; });
  buildStatic();
  document.body.classList.toggle('portrait', cw < ch);
}

function buildStatic() {
  const px = env.pxmm;
  staticLayer = offscreen((SW + MARGIN * 2) * px, (SH + MARGIN * 2) * px);
  const c = staticLayer.getContext('2d');
  for (const d of decks) {
    c.setTransform(px, 0, 0, px, (d.ox + MARGIN) * px, MARGIN * px);
    d.drawStatic(c, px);
  }
  c.setTransform(px, 0, 0, px, (mixer.ox + MARGIN) * px, MARGIN * px);
  mixer.drawStatic(c, px);
}

function updateCamera(dt) {
  const t = FOCUS[cfg.focus] || FOCUS.ALL;
  const k = Math.min(1, dt * 9);
  cam.x += (t.x - cam.x) * k;
  cam.w += (t.w - cam.w) * k;
  const s = scaleFor(cam);
  M = new DOMMatrix().translate(cw / 2, ch / 2).scale(s).translate(-(cam.x + cam.w / 2), -SH / 2);
  Minv = M.inverse();
  view.k = s * dpr;
}

function toScene(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const p = Minv.transformPoint(new DOMPoint(clientX - r.left, clientY - r.top));
  return { x: p.x, y: p.y };
}

// ---------------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------------
function draw(now) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.setTransform(new DOMMatrix().scale(dpr).multiply(M));
  g.imageSmoothingQuality = 'high';
  if (staticLayer) g.drawImage(staticLayer, -MARGIN, -MARGIN, SW + MARGIN * 2, SH + MARGIN * 2);
  for (const d of decks) {
    g.save();
    g.translate(d.ox, 0);
    d.draw(g);
    g.restore();
  }
  g.save();
  g.translate(mixer.ox, 0);
  mixer.draw(g, now);
  g.restore();
}

// ---------------------------------------------------------------------------
// Toque (vários dedos ao mesmo tempo: um no disco, outro no crossfader…)
// ---------------------------------------------------------------------------
const pointers = new Map();

function targetAt(p) {
  if (p.x < DW) return decks[0];
  if (p.x < DW + MW) return mixer;
  return decks[1];
}

function local(obj, p) {
  return { x: p.x - obj.ox, y: p.y };
}

canvas.addEventListener('pointerdown', (e) => {
  ensureAudio();
  requestWakeLock();
  const p = toScene(e.clientX, e.clientY);
  const obj = targetAt(p);
  const info = obj.down(local(obj, p), e);
  if (!info) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { obj, info });
});

canvas.addEventListener('pointermove', (e) => {
  const ptr = pointers.get(e.pointerId);
  if (!ptr) return;
  e.preventDefault();
  const { obj, info } = ptr;
  if (obj === mixer) {
    mixer.move(info, local(mixer, toScene(e.clientX, e.clientY)), e);
  } else {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const list = (evs.length ? evs : [e]).map((ev) => ({ p: local(obj, toScene(ev.clientX, ev.clientY)), t: ev.timeStamp }));
    obj.move(info, list);
  }
});

function endPointer(e) {
  const ptr = pointers.get(e.pointerId);
  if (!ptr) return;
  pointers.delete(e.pointerId);
  ptr.obj.up(ptr.info);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const d = e.code === 'KeyA' ? decks[0] : e.code === 'KeyL' ? decks[1] : null;
  if (d) {
    ensureAudio();
    if (d.S.power) d.S.motor = !d.S.motor;
  }
});

let wakeLock = null;
async function requestWakeLock() {
  if (wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* sem permissão */ }
}

// ---------------------------------------------------------------------------
// Barra superior e folhas
// ---------------------------------------------------------------------------
let loadTarget = decks[0];

function openSheet(id) { $(id).classList.add('open'); }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open')); }
document.querySelectorAll('.sheet').forEach((s) => {
  s.addEventListener('click', (e) => {
    if (e.target === s || e.target.hasAttribute('data-close')) closeSheets();
  });
});

document.querySelectorAll('[data-load]').forEach((b) => {
  b.addEventListener('click', () => {
    ensureAudio();
    loadTarget = decks[b.dataset.load === 'B' ? 1 : 0];
    $('#loadDeck').textContent = loadTarget.id;
    openSheet('#sheetLoad');
  });
});
$('#btnSettings').addEventListener('click', () => openSheet('#sheetSettings'));
$('#btnHelp').addEventListener('click', () => openSheet('#sheetHelp'));
$('#optFile').addEventListener('click', () => { closeSheets(); $('#file').click(); });
$('#optDemo').addEventListener('click', async () => {
  closeSheets();
  await ensureAudio();
  loadDemo(loadTarget);
});
$('#file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(loadTarget, f);
  e.target.value = '';
});

const focusSeg = $('#focus');
function renderFocus() {
  focusSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === cfg.focus));
}
focusSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  cfg.focus = b.dataset.v;
  saveCfg();
  renderFocus();
});
renderFocus();

const fsBtn = $('#btnFull');
if (!document.documentElement.requestFullscreen) fsBtn.hidden = true;
fsBtn.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(() => {});
    }
  } catch { /* não suportado */ }
});

$('#rotateHint').addEventListener('click', (e) => e.currentTarget.classList.add('dismissed'));

function bindSeg(id, get, set) {
  const seg = $(id);
  const render = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    saveCfg();
    render();
  });
  render();
  return render;
}
bindSeg('#segRange', () => cfg.range, (v) => { cfg.range = +v; buildStatic(); });
bindSeg('#segFinish', () => cfg.finish, (v) => { cfg.finish = v; buildStatic(); });
const renderCurve = bindSeg('#segCurve', () => cfg.curve, (v) => { cfg.curve = v; mixer.applyXf(); });
$('#btnSettings').addEventListener('click', renderCurve);
bindSeg('#segCrackle', () => (cfg.crackle ? 1 : 0), (v) => {
  cfg.crackle = v === '1';
  decks.forEach((d) => d.post({ type: 'crackle', on: cfg.crackle }));
});
bindSeg('#segHaptic', () => (cfg.haptic ? 1 : 0), (v) => { cfg.haptic = v === '1'; });

function bindRange(id, valId, key) {
  const el = $(id), out = $(valId);
  el.value = cfg[key];
  out.textContent = `(${(+cfg[key]).toFixed(2)} s)`;
  el.addEventListener('input', () => {
    cfg[key] = +el.value;
    out.textContent = `(${cfg[key].toFixed(2)} s)`;
    saveCfg();
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
const infoEls = decks.map((d) => ({ title: $(`#title${d.id}`), meta: $(`#meta${d.id}`) }));

function fmt(t) {
  t = Math.max(0, t);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

let lastT = performance.now();
let frame = 0;

function tick(now) {
  const dt = clamp((now - lastT) / 1000, 0, 0.05);
  lastT = now;
  decks.forEach((d) => d.physics(dt));
  mixer.update(dt, decks);
  updateCamera(dt);
  draw(now);

  if (++frame % 6 === 0) {
    decks.forEach((d, i) => {
      const t = d.S.track;
      if (!t) return;
      if (infoEls[i].title.textContent !== t.title) infoEls[i].title.textContent = t.title;
      const p = clamp(d.audioPos(), 0, t.duration);
      const pct = d.S.pitch * cfg.range;
      const bpm = d.bpmNow();
      infoEls[i].meta.textContent = `${fmt(p)} −${fmt(t.duration - p)} · ${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`
        + (bpm ? ` · ${bpm.toFixed(1)} BPM` : '');
    });
  }
  requestAnimationFrame(tick);
}

// Discos demo aparecem desde o início (o áudio nasce no primeiro toque)
decks.forEach((d) => {
  d.S.track = {
    title: d.id === 'A' ? 'Disco de batalha (demo)' : 'Groove 96 (demo)',
    duration: 50, bpm: d.id === 'A' ? 92 : 96, demoPending: true,
  };
});

new ResizeObserver(() => layout()).observe(stage);
layout();
requestAnimationFrame(tick);

window.__mesa = { decks, mixer, cfg };

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
