// Counting line + crossing logic. The line is a segment A→B in normalised
// frame coordinates (0..1). A track's side is the sign of the cross product of
// (B−A) and (centre−A). A crossing counts only when the track:
//   - is confirmed and was seen this frame (no counting from a coasting guess),
//   - already had a known side (people who appear on the line aren't counted),
//   - leaves the dead band around the line on the other side,
//   - stays there for `confirmFrames` frames in a row (filters box jitter),
//   - crosses within the segment's length, not past its ends.
// If the same track crosses back within `reversalMs`, the first count is undone,
// so someone hovering on the line nets to zero instead of +1 in and +1 out.

const DEFAULTS = { bandFraction: 0.03, confirmFrames: 2, reversalMs: 1500 };

export const PRESETS = {
  vertical: { a: { x: 0.5, y: 0.08 }, b: { x: 0.5, y: 0.92 } },
  horizontal: { a: { x: 0.06, y: 0.5 }, b: { x: 0.94, y: 0.5 } },
};

/** Signed distance (px) of point p from the infinite line, and position t along A→B (0..1 = on the segment). */
export function measure(line, w, h, p) {
  const ax = line.a.x * w, ay = line.a.y * h;
  const dx = line.b.x * w - ax, dy = line.b.y * h - ay;
  const len = Math.hypot(dx, dy) || 1;
  const px = p.x - ax, py = p.y - ay;
  return { dist: (dx * py - dy * px) / len, t: (dx * px + dy * py) / (len * len) };
}

/** Unit vector pointing to the positive side, in pixel space. */
export function normal(line, w, h) {
  const dx = (line.b.x - line.a.x) * w, dy = (line.b.y - line.a.y) * h;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

export class LineCounter {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.counts = { in: 0, out: 0 };
    this.inSide = -1;   // which side of the line is "in"; for the default vertical line, -1 = right
  }

  band(w, h) {
    return Math.max(6, this.o.bandFraction * Math.min(w, h));
  }

  /** @returns events: [{ track, dir: "in"|"out", undo: boolean }] */
  update(tracks, line, w, h, now) {
    const band = this.band(w, h), events = [];
    for (const t of tracks) {
      if (!t.confirmed || t.misses > 0) continue;
      const c = (t.cross ??= { side: 0, pending: 0, frames: 0, last: null });
      const { dist, t: along } = measure(line, w, h, { x: t.x + t.w / 2, y: t.y + t.h / 2 });
      const zone = dist > band ? 1 : dist < -band ? -1 : 0;

      if (zone === 0) { c.pending = 0; c.frames = 0; continue; }
      if (c.side === 0 || zone === c.side) { c.side = zone; c.pending = 0; c.frames = 0; continue; }

      // on the opposite side: wait for it to stick
      if (c.pending === zone) c.frames++;
      else { c.pending = zone; c.frames = 1; }
      if (c.frames < this.o.confirmFrames) continue;

      c.side = zone; c.pending = 0; c.frames = 0;
      if (along < -0.05 || along > 1.05) continue;   // walked around the end of the segment

      const dir = zone === this.inSide ? "in" : "out";
      if (c.last && c.last.dir !== dir && now - c.last.t < this.o.reversalMs) {
        this.counts[c.last.dir]--;
        events.push({ track: t, dir: c.last.dir, undo: true });
        c.last = null;
      } else {
        this.counts[dir]++;
        c.last = { dir, t: now };
        events.push({ track: t, dir, undo: false });
      }
    }
    return events;
  }

  /** Zero the counters. Tracks keep their side, so nobody already past the line is re-counted. */
  reset(tracks) {
    this.counts = { in: 0, out: 0 };
    for (const t of tracks) if (t.cross) t.cross.last = null;
  }

  /** The line moved: sides are meaningless now, so every track re-learns its side without counting. */
  lineChanged(tracks) {
    for (const t of tracks) t.cross = null;
  }

  flip() {
    this.inSide = -this.inSide;
  }
}
