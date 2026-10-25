// Canvas overlay: counting line with its dead band and IN/OUT arrows, then
// each track's box, trail and ID label. The canvas uses the video's own pixel
// size, so detector boxes are drawn as-is and CSS scales both layers together.

import { normal } from "./line.js";

const COLORS = {
  line: "#ff3b3b",
  band: "rgba(255, 59, 59, 0.14)",
  box: "#ffffff",
  tentative: "rgba(255, 255, 255, 0.45)",
  in: "#2ecc71",
  out: "#ffb020",
  label: "rgba(0, 0, 0, 0.72)",
};

export const FLASH_MS = 900;

export function draw(ctx, { w, h, line, band, inSide, tracks = [], flashes = new Map(), now = 0, handles = true }) {
  const s = Math.max(w, h) / 640;   // keep strokes and text readable at any resolution
  ctx.clearRect(0, 0, w, h);
  drawLine(ctx, w, h, line, band, inSide, s, handles);
  for (const t of tracks) {
    if (t.misses > 0 && !t.confirmed) continue;
    const flash = t.id != null && flashes.get(t.id);
    const active = flash && now - flash.t < FLASH_MS;
    const color = active ? COLORS[flash.dir] : t.confirmed ? COLORS.box : COLORS.tentative;
    drawTrack(ctx, t, color, s, active);
  }
}

function drawLine(ctx, w, h, line, band, inSide, s, handles) {
  const ax = line.a.x * w, ay = line.a.y * h, bx = line.b.x * w, by = line.b.y * h;
  const n = normal(line, w, h);

  // dead band
  ctx.fillStyle = COLORS.band;
  ctx.beginPath();
  ctx.moveTo(ax + n.x * band, ay + n.y * band);
  ctx.lineTo(bx + n.x * band, by + n.y * band);
  ctx.lineTo(bx - n.x * band, by - n.y * band);
  ctx.lineTo(ax - n.x * band, ay - n.y * band);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 3 * s;
  ctx.setLineDash([12 * s, 8 * s]);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);

  // IN / OUT arrows from the midpoint
  const mx = (ax + bx) / 2, my = (ay + by) / 2, len = 46 * s;
  arrow(ctx, mx, my, n.x * inSide, n.y * inSide, len, COLORS.in, "IN", s);
  arrow(ctx, mx, my, -n.x * inSide, -n.y * inSide, len, COLORS.out, "OUT", s);

  if (handles) {
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      ctx.beginPath();
      ctx.arc(x, y, 10 * s, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 3 * s;
      ctx.strokeStyle = COLORS.line;
      ctx.stroke();
    }
  }
}

function arrow(ctx, x, y, ux, uy, len, color, text, s) {
  const ex = x + ux * len, ey = y + uy * len, head = 9 * s;
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = 3 * s;
  ctx.beginPath();
  ctx.moveTo(x + ux * 8 * s, y + uy * 8 * s);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ex + ux * head, ey + uy * head);
  ctx.lineTo(ex - uy * head * 0.8, ey + ux * head * 0.8);
  ctx.lineTo(ex + uy * head * 0.8, ey - ux * head * 0.8);
  ctx.closePath();
  ctx.fill();
  label(ctx, text, ex + ux * 26 * s, ey + uy * 26 * s, color, s, "center");
}

function drawTrack(ctx, t, color, s, active) {
  ctx.lineWidth = (active ? 4 : 2.5) * s;
  ctx.strokeStyle = color;
  ctx.strokeRect(t.x, t.y, t.w, t.h);
  if (!t.confirmed) return;

  // trail of centres
  if (t.trail.length > 1) {
    ctx.lineWidth = 2 * s;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    t.trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const c = t.trail[t.trail.length - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(c.x, c.y, 4 * s, 0, Math.PI * 2);
  ctx.fill();

  const text = `#${t.id} · ${Math.round(t.score * 100)}%${t.misses ? " · lost" : ""}`;
  label(ctx, text, t.x, Math.max(t.y - 4 * s, 18 * s), color, s, "left");
}

function label(ctx, text, x, y, color, s, align) {
  ctx.font = `600 ${13 * s}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const pad = 4 * s, tw = ctx.measureText(text).width, th = 16 * s;
  const left = align === "center" ? x - tw / 2 - pad : x;
  const top = align === "center" ? y - th / 2 : y - th;
  ctx.fillStyle = COLORS.label;
  ctx.fillRect(left, top, tw + pad * 2, th);
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, left + pad, top + th / 2);
}
