// Lightweight multi-person tracker, ByteTrack-style but without a Kalman filter.
// Each frame: predict every track forward with its velocity, match confident
// detections by IoU (falling back to centre distance), then give unmatched
// confirmed tracks a second chance against low-confidence detections, which
// keeps people through partial occlusion. Pure logic, no DOM: easy to test.

const DEFAULTS = {
  highScore: 0.5,       // detections at or above this can start new tracks
  lowScore: 0.3,        // detections in [lowScore, highScore) only extend existing tracks
  minIou: 0.2,          // IoU needed for a box-overlap match
  maxCenterDist: 0.8,   // fallback match: centre distance / predicted box size
  confirmHits: 3,       // matched frames before a track gets an ID and can be counted
  tentativeMisses: 2,   // frames a new, unconfirmed track may go unseen before it's dropped as noise
  maxAgeMs: 1000,       // drop a confirmed track after this long unseen
  smoothing: 0.6,       // weight of the new box vs the old one (1 = no smoothing)
  trailLength: 30,
};

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export class Tracker {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.tracks = [];
    this.nextId = 1;
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }

  /**
   * @param {{x:number,y:number,w:number,h:number,score:number}[]} detections  pixel boxes
   * @param {number} now  ms timestamp
   * @returns the live tracks (confirmed and tentative); `misses === 0` means seen this frame
   */
  update(detections, now) {
    const o = this.o;
    for (const t of this.tracks) {
      const dt = Math.min(now - t.lastUpdate, 500);
      t.pred = { x: t.x + t.vx * dt, y: t.y + t.vy * dt, w: t.w, h: t.h };
    }

    const high = detections.filter(d => d.score >= o.highScore);
    const low = detections.filter(d => d.score >= o.lowScore && d.score < o.highScore);

    // 1) every track vs confident detections
    const first = this.#match(this.tracks, high, true);
    // 2) confirmed tracks still unmatched vs weak detections (IoU only: weak boxes are noisy)
    const leftover = this.tracks.filter(t => t.confirmed && !first.tracks.has(t));
    const second = this.#match(leftover, low, false);

    for (const [t, d] of [...first.pairs, ...second.pairs]) this.#apply(t, d, now);

    // Unmatched tracks: tentative ones get a couple of frames' grace, confirmed ones coast.
    const matched = new Set([...first.tracks, ...second.tracks]);
    this.tracks = this.tracks.filter(t => {
      if (matched.has(t)) return true;
      t.misses++;
      t.lastUpdate = now;
      t.vx *= 0.5; t.vy *= 0.5;   // damp the prediction while unseen
      return t.confirmed ? now - t.lastSeen <= o.maxAgeMs : t.misses <= o.tentativeMisses;
    });

    // 3) confident detections nobody claimed start tentative tracks
    for (const d of high) if (!first.dets.has(d)) this.tracks.push(this.#create(d, now));

    return this.tracks;
  }

  // Greedy assignment by descending score. IoU matches always outrank distance matches.
  #match(tracks, dets, allowDistance) {
    const o = this.o;
    const candidates = [];
    for (const t of tracks) {
      const p = t.pred, pc = center(p), size = Math.max(p.w, p.h);
      for (const d of dets) {
        const overlap = iou(p, d);
        if (overlap >= o.minIou) { candidates.push([overlap + 1, t, d]); continue; }
        if (!allowDistance) continue;
        const dc = center(d);
        const dist = Math.hypot(dc.x - pc.x, dc.y - pc.y) / size;
        // similar size too, so a near person and a far person don't swap IDs
        const ratio = Math.min(d.h, p.h) / Math.max(d.h, p.h);
        if (dist < o.maxCenterDist && ratio > 0.5) candidates.push([1 - dist / o.maxCenterDist, t, d]);
      }
    }
    candidates.sort((a, b) => b[0] - a[0]);
    const pairs = [], usedT = new Set(), usedD = new Set();
    for (const [, t, d] of candidates) {
      if (usedT.has(t) || usedD.has(d)) continue;
      usedT.add(t); usedD.add(d);
      pairs.push([t, d]);
    }
    return { pairs, tracks: usedT, dets: usedD };
  }

  #create(d, now) {
    const c = center(d);
    return {
      id: null, confirmed: false,
      x: d.x, y: d.y, w: d.w, h: d.h, score: d.score,
      vx: 0, vy: 0, hits: 1, misses: 0,
      lastSeen: now, lastUpdate: now,
      trail: [c],
      cross: null,   // owned by LineCounter
    };
  }

  #apply(t, d, now) {
    const o = this.o, a = o.smoothing;
    const before = center(t);
    const dt = Math.max(now - t.lastUpdate, 1);
    t.x += (d.x - t.x) * a; t.y += (d.y - t.y) * a;
    t.w += (d.w - t.w) * a; t.h += (d.h - t.h) * a;
    const after = center(t);
    t.vx = 0.5 * t.vx + 0.5 * (after.x - before.x) / dt;
    t.vy = 0.5 * t.vy + 0.5 * (after.y - before.y) / dt;
    t.score = d.score;
    t.hits++;
    t.misses = 0;
    t.lastSeen = t.lastUpdate = now;
    t.trail.push(after);
    if (t.trail.length > o.trailLength) t.trail.shift();
    if (!t.confirmed && t.hits >= o.confirmHits) {
      t.confirmed = true;
      t.id = this.nextId++;
    }
  }
}
