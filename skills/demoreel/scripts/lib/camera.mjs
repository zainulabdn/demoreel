// The virtual camera. Given what happened during a recording (clicks, typing, scrolls),
// decide when to zoom in, where to look, and when to pull back, then smooth that into
// per-frame motion with a critically damped spring. Pure functions: no I/O.

import { clamp } from './util.mjs';

export const CAMERA = {
  /** How long before the cursor starts moving the camera begins to follow (ms). */
  lead: 150,
  /** How long the camera stays zoomed after an action finishes (ms). */
  hold: 1500,
  /** Two actions closer together than this stay in one zoomed shot (ms). */
  gap: 900,
  /** Pull back this long before a scroll, drag or page change (ms). */
  preroll: 250,
  /** The video always ends on the full page for at least this long (ms). */
  outro: 900,
  /** Targets that would zoom less than this are not worth a camera move. */
  minZoom: 1.15,
  /** Spring stiffness when zooming in / pulling back (rad/s). Higher is snappier. */
  omegaIn: 7.5,
  omegaOut: 6,
};

/** The zoom level at which a target rectangle still fits comfortably in view. */
export function fitZoom(rect, viewport, maxZoom) {
  const byWidth = (viewport.width * 0.9) / (rect.w + 80);
  const byHeight = (viewport.height * 0.9) / (rect.h + 80);
  return clamp(Math.min(maxZoom, byWidth, byHeight), 1, maxZoom);
}

/** Is a rectangle fully visible in a shot (with a little breathing room)? */
export function shotContains(shot, rect, viewport) {
  const halfW = viewport.width / (2 * shot.scale);
  const halfH = viewport.height / (2 * shot.scale);
  const cx = clamp(shot.cx, halfW, viewport.width - halfW);
  const cy = clamp(shot.cy, halfH, viewport.height - halfH);
  const margin = 12;
  return (
    rect.x >= cx - halfW + margin &&
    rect.y >= cy - halfH + margin &&
    rect.x + rect.w <= cx + halfW - margin &&
    rect.y + rect.h <= cy + halfH - margin
  );
}

/**
 * Turn recorded events into camera shots.
 *
 * Events are read in order. Each one either starts a zoomed shot, asks for the whole page
 * (when what it points at is too big to zoom on), or is absorbed by the shot already running.
 * A new event always takes over from whatever came before it, so the camera never jumps back.
 *
 * @returns {Array<{start:number,end:number,scale:number,cx:number,cy:number,anchor:number}>}
 *          sorted, non-overlapping; outside every shot the camera shows the whole page
 */
export function buildShots(timeline, style) {
  const maxZoom = style.zoom ?? 1.6;
  if (maxZoom <= 1) return [];
  const { viewport, duration } = timeline;

  const beginOf = (event) =>
    event.kind === 'result' ? event.t0 : event.t0 - (event.approach || 0) - CAMERA.lead;
  const events = [...(timeline.focus || [])].sort((a, b) => beginOf(a) - beginOf(b) || a.t0 - b.t0);

  /** @type {Array<{kind:'shot'|'wide', start:number, end:number, scale?:number, cx?:number, cy?:number, anchor?:number}>} */
  const segments = [];
  const runningShot = (at) => {
    const last = segments[segments.length - 1];
    return last && last.kind === 'shot' && at <= last.end ? last : null;
  };

  events.forEach((event, index) => {
    const begin = beginOf(event);

    if (event.kind === 'key') {
      // A key press has no location: it just keeps the running shot alive a little longer.
      const current = runningShot(event.t0);
      if (current) current.end = Math.max(current.end, event.t1 + CAMERA.hold);
      return;
    }

    if (event.kind === 'result') {
      // The page changed after an action. Stay put if the running shot already shows the change,
      // or if the very next action continues inside the same shot (typing the next line, say).
      const current = runningShot(begin);
      if (current) {
        const next = events.slice(index + 1).find((e) => e.kind !== 'key' && e.kind !== 'result');
        const continues =
          next && beginOf(next) - begin < 700 && next.zoom !== false && shotContains(current, next.rect, viewport);
        if (continues || shotContains(current, event.rect, viewport)) {
          current.end = Math.max(current.end, event.t1 + CAMERA.hold);
          return;
        }
      }
    }

    const scale =
      event.zoom === false ? 1 : fitZoom(event.rect, viewport, typeof event.zoom === 'number' ? event.zoom : maxZoom);
    const segment =
      scale < CAMERA.minZoom
        ? { kind: 'wide', start: begin, end: Math.max(event.t1, begin + 400) }
        : {
            kind: 'shot',
            start: begin,
            end: event.t1 + CAMERA.hold,
            scale,
            cx: event.rect.x + event.rect.w / 2,
            cy: event.rect.y + event.rect.h / 2,
            anchor: event.t0,
          };

    const previous = segments[segments.length - 1];
    if (previous) {
      const bothShots = previous.kind === 'shot' && segment.kind === 'shot';
      if (bothShots && segment.start <= previous.end + CAMERA.gap) {
        // Two actions close together: pan straight across instead of pulling back in between.
        previous.end = Math.max(previous.start + 1, segment.start);
        segment.start = previous.end;
      } else if (segment.start < previous.end) {
        previous.end = Math.max(previous.start, segment.start);
      }
    }
    segments.push(segment);
  });

  let shots = segments.filter((segment) => segment.kind === 'shot').map(({ kind, ...shot }) => shot);

  // A click that changed the page address: stay for the click itself, then pull back.
  const urls = timeline.urls || [];
  for (let i = 1; i < urls.length; i++) {
    const t = urls[i].t;
    for (const shot of shots) {
      if (t > shot.start && t < shot.end) shot.end = Math.min(shot.end, Math.max(t, shot.anchor + 300));
    }
  }

  // Scrolls, drags and navigations move the page under the camera, so they need the whole page
  // in view. A shot is not resumed afterwards unless its action happened after the move.
  for (const recorded of timeline.wide || []) {
    const from = recorded.t0 - CAMERA.preroll;
    const next = [];
    for (const shot of shots) {
      if (shot.end <= from || shot.start >= recorded.t1) {
        next.push(shot);
        continue;
      }
      if (shot.start < from) next.push({ ...shot, end: from });
      if (shot.end > recorded.t1 && shot.anchor >= recorded.t1) next.push({ ...shot, start: recorded.t1 });
    }
    shots = next;
  }

  // Start and finish on the whole page; drop shots too short to read.
  const latest = duration - CAMERA.outro;
  return shots
    .map((shot) => ({ ...shot, start: Math.max(shot.start, 250), end: Math.min(shot.end, latest) }))
    .filter((shot) => shot.end - shot.start >= 350)
    .sort((a, b) => a.start - b.start);
}

/**
 * Sample smooth camera motion for every output frame.
 * @returns {{scale: number[], cx: number[], cy: number[]}} one value per frame; cx/cy are the
 *          centre of the visible region in page pixels, already kept inside the page
 */
export function sampleCamera(shots, viewport, frameCount, fps) {
  const { width, height } = viewport;
  const state = { s: 1, cx: width / 2, cy: height / 2, vs: 0, vx: 0, vy: 0 };
  const out = { scale: new Array(frameCount), cx: new Array(frameCount), cy: new Array(frameCount) };
  const substeps = 4;
  const dt = 1 / fps / substeps;
  let shotIndex = 0;
  let active = null;

  for (let frame = 0; frame < frameCount; frame++) {
    const t = (frame * 1000) / fps;
    while (shotIndex < shots.length && shots[shotIndex].end <= t) shotIndex++;
    const shot = shotIndex < shots.length && shots[shotIndex].start <= t ? shots[shotIndex] : null;

    if (shot && shot !== active && state.s < 1.04) {
      // Zooming in from the full page: aim straight at the target instead of panning to it.
      state.cx = shot.cx;
      state.cy = shot.cy;
      state.vx = 0;
      state.vy = 0;
    }
    active = shot;

    const target = shot ? { s: shot.scale, cx: shot.cx, cy: shot.cy } : { s: 1, cx: state.cx, cy: state.cy };
    const omega = shot ? CAMERA.omegaIn : CAMERA.omegaOut;
    for (let i = 0; i < substeps; i++) {
      state.vs += (omega * omega * (target.s - state.s) - 2 * omega * state.vs) * dt;
      state.vx += (omega * omega * (target.cx - state.cx) - 2 * omega * state.vx) * dt;
      state.vy += (omega * omega * (target.cy - state.cy) - 2 * omega * state.vy) * dt;
      state.s += state.vs * dt;
      state.cx += state.vx * dt;
      state.cy += state.vy * dt;
    }

    // Round first, then keep the view inside the page, so rounding can never push it outside.
    const scale = Math.round(Math.max(1, state.s) * 10000) / 10000;
    const halfW = width / (2 * scale);
    const halfH = height / (2 * scale);
    out.scale[frame] = scale;
    out.cx[frame] = clamp(Math.round(state.cx * 100) / 100, halfW, width - halfW);
    out.cy[frame] = clamp(Math.round(state.cy * 100) / 100, halfH, height - halfH);
  }
  return out;
}
