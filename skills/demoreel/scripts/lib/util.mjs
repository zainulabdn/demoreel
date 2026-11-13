// Small shared helpers. No dependencies.

/** An error whose message is safe to show to a user, with an optional hint on how to fix it. */
export class DemoreelError extends Error {
  /**
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(message, hint) {
    super(message);
    this.name = 'DemoreelError';
    this.hint = hint;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const lerp = (a, b, t) => a + (b - a) * t;

/** Minimum-jerk easing: starts and ends at rest, which is how a hand moves a mouse. */
export const easeMinJerk = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * x * (10 - 15 * x + 6 * x * x);
};

export const easeInOutCubic = (t) => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/**
 * Deterministic pseudo-random generator (mulberry32), so the same storyboard
 * always produces the same cursor arcs and typing rhythm.
 * @param {number} seed
 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string, used to derive a seed from a storyboard. */
export function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Zero-padded frame file name. */
export const frameName = (index) => `${String(index).padStart(6, '0')}.jpg`;
