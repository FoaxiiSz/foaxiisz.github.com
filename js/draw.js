// Utilitários de desenho compartilhados (unidades em milímetros da cena)

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Escala atual (pixels do aparelho por mm). Sombras do canvas não seguem a
// transformação, então precisam disso para ficar proporcionais.
export const view = { k: 1 };

export function offscreen(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function circle(c, x, y, r) {
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
}

export function text(c, str, x, y, size, opts = {}) {
  c.font = `${opts.weight || 600} ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  c.textAlign = opts.align || 'center';
  c.textBaseline = 'middle';
  c.fillStyle = opts.color || '#3b3d40';
  c.fillText(str, x, y);
}

export function glow(c, color, blurMm) {
  c.save();
  c.shadowColor = color;
  c.shadowBlur = blurMm * view.k;
  c.fill();
  c.restore();
}

// Knob estilo DJM: borracha serrilhada, tampa escura e risco branco
export function drawKnob(c, x, y, r, v) {
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.7)';
  c.shadowBlur = 2.5 * view.k;
  c.shadowOffsetY = 1.2 * view.k;
  circle(c, x, y, r);
  c.fillStyle = '#121214';
  c.fill();
  c.restore();
  c.strokeStyle = 'rgba(255,255,255,0.08)';
  c.lineWidth = 0.5;
  for (let k = 0; k < 24; k++) {
    const a = k / 24 * TAU;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * (r - 1.8), y + Math.sin(a) * (r - 1.8));
    c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    c.stroke();
  }
  circle(c, x, y, r * 0.72);
  const cg = c.createRadialGradient(x - r * 0.3, y - r * 0.35, 0.5, x, y, r * 0.72);
  cg.addColorStop(0, '#4a4c50');
  cg.addColorStop(1, '#1b1c1f');
  c.fillStyle = cg;
  c.fill();
  const a = (-225 + v * 270) * Math.PI / 180;
  c.strokeStyle = '#f2f2f2';
  c.lineWidth = Math.max(0.9, r * 0.12);
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x + Math.cos(a) * r * 0.25, y + Math.sin(a) * r * 0.25);
  c.lineTo(x + Math.cos(a) * (r - 1.2), y + Math.sin(a) * (r - 1.2));
  c.stroke();
}

// Marcas de escala em volta de um knob (desenhadas na camada fixa)
export function knobScale(c, x, y, r, centered, color = '#8a8c90') {
  c.fillStyle = color;
  for (let k = 0; k <= 10; k++) {
    const a = (-225 + k * 27) * Math.PI / 180;
    const rr = r + 2.6;
    circle(c, x + Math.cos(a) * rr, y + Math.sin(a) * rr, k === 0 || k === 10 || (centered && k === 5) ? 0.75 : 0.4);
    c.fill();
  }
}
