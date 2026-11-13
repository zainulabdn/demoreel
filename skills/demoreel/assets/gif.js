// A small animated GIF encoder tuned for screen recordings:
//  - one shared 255-colour palette chosen by median cut, so colours never flicker between frames
//  - only the part of each frame that changed is stored, which keeps UI demos small
//  - ordered dithering that only acts where a colour truly lies between two palette entries
//    (gradients, blurs, shadows), so flat interface colours stay perfectly flat
// Works in the browser and in Node. No dependencies.

const TRANSPARENT = 255;
const MAX_COLORS = 255;

const bin = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

const distance = (colors, index, r, g, b) => {
  const dr = r - colors[index * 3];
  const dg = g - colors[index * 3 + 1];
  const db = b - colors[index * 3 + 2];
  return dr * dr + dg * dg + db * db;
};

// An 8x8 ordered-dither pattern, scaled to nudge a colour by up to about +-9 levels.
const DITHER = (() => {
  const base = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ];
  return Float32Array.from(base, (value) => ((value + 0.5) / 64 - 0.5) * 18);
})();

/** Count colours (at 5 bits per channel) across sampled frames. */
export class Histogram {
  constructor() {
    this.counts = new Uint32Array(32768);
  }

  /** @param {Uint8ClampedArray|Uint8Array} rgba */
  add(rgba) {
    const counts = this.counts;
    for (let i = 0; i < rgba.length; i += 4) counts[bin(rgba[i], rgba[i + 1], rgba[i + 2])]++;
  }
}

/**
 * Choose a palette with median cut.
 * @returns {{colors: Uint8Array, count: number}} `colors` holds 256 RGB triples; entry 255 is reserved for "unchanged"
 */
export function buildPalette(histogram, maxColors = MAX_COLORS) {
  const counts = histogram.counts;
  const used = [];
  for (let i = 0; i < counts.length; i++) if (counts[i]) used.push(i);
  const channel = (index, c) => (index >> (10 - 5 * c)) & 31;

  const makeBox = (bins) => {
    const min = [31, 31, 31];
    const max = [0, 0, 0];
    let weight = 0;
    for (const index of bins) {
      weight += counts[index];
      for (let c = 0; c < 3; c++) {
        const v = channel(index, c);
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    const ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const axis = ranges.indexOf(Math.max(...ranges));
    return { bins, weight, axis, range: ranges[axis] };
  };

  const boxes = used.length ? [makeBox(used)] : [];
  while (boxes.length < maxColors) {
    // Split the box that is both wide and heavily used.
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const candidate = boxes[i];
      if (candidate.bins.length < 2 || candidate.range === 0) continue;
      const score = candidate.range * Math.sqrt(candidate.weight);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    const target = boxes[best];
    const axis = target.axis;
    target.bins.sort((a, b) => channel(a, axis) - channel(b, axis));
    let half = target.weight / 2;
    let cut = 0;
    while (cut < target.bins.length - 1) {
      half -= counts[target.bins[cut]];
      cut++;
      if (half <= 0) break;
    }
    boxes.splice(best, 1, makeBox(target.bins.slice(0, cut)), makeBox(target.bins.slice(cut)));
  }

  const colors = new Uint8Array(256 * 3);
  boxes.forEach((entry, i) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const index of entry.bins) {
      const weight = counts[index];
      r += (channel(index, 0) * 8 + 4) * weight;
      g += (channel(index, 1) * 8 + 4) * weight;
      b += (channel(index, 2) * 8 + 4) * weight;
    }
    colors[i * 3] = Math.round(r / entry.weight);
    colors[i * 3 + 1] = Math.round(g / entry.weight);
    colors[i * 3 + 2] = Math.round(b / entry.weight);
  });
  return { colors, count: boxes.length };
}

/** Maps any colour to its nearest palette entry. */
export class Quantizer {
  constructor(palette) {
    this.palette = palette;
    const { colors, count } = palette;
    this.lookup = new Uint8Array(32768);
    for (let index = 0; index < 32768; index++) {
      const r = ((index >> 10) & 31) * 8 + 4;
      const g = ((index >> 5) & 31) * 8 + 4;
      const b = (index & 31) * 8 + 4;
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < count; i++) {
        const dr = r - colors[i * 3];
        const dg = g - colors[i * 3 + 1];
        const db = b - colors[i * 3 + 2];
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      }
      this.lookup[index] = best;
    }
  }

  /**
   * @param {Uint8ClampedArray|Uint8Array} rgba
   * @param {number} width
   * @param {Uint8Array} out  palette indices, one per pixel
   */
  apply(rgba, width, out) {
    const { lookup } = this;
    const colors = this.palette.colors;
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    let x = 0;
    let y = 0;
    for (let p = 0, i = 0; i < rgba.length; i += 4, p++) {
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const plain = lookup[bin(r, g, b)];
      // Ordered dithering: nudge the colour by a fixed pattern and see if a neighbouring
      // palette entry is picked instead. The pattern depends only on position, so a still
      // image dithers identically in every frame and costs nothing after the first.
      const nudge = DITHER[((y & 7) << 3) | (x & 7)];
      const nudged = lookup[bin(clamp(r + nudge), clamp(g + nudge), clamp(b + nudge))];
      let choice = plain;
      if (nudged !== plain) {
        const d0 = distance(colors, plain, r, g, b);
        const d1 = distance(colors, nudged, r, g, b);
        // Only switch when the true colour really lies between the two entries (a gradient).
        // A flat interface colour sits on its own entry, far from any other, and stays flat.
        if (d1 <= d0 * 3 + 30) choice = nudged;
      }
      out[p] = choice;
      if (++x === width) {
        x = 0;
        y++;
      }
    }
    return out;
  }
}

/** Growable byte buffer. */
class Bytes {
  constructor(size = 1 << 16) {
    this.data = new Uint8Array(size);
    this.length = 0;
  }

  ensure(extra) {
    if (this.length + extra <= this.data.length) return;
    const next = new Uint8Array(Math.max(this.data.length * 2, this.length + extra));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  byte(value) {
    this.ensure(1);
    this.data[this.length++] = value;
  }

  u16(value) {
    this.ensure(2);
    this.data[this.length++] = value & 255;
    this.data[this.length++] = (value >> 8) & 255;
  }

  bytes(values) {
    this.ensure(values.length);
    this.data.set(values, this.length);
    this.length += values.length;
  }

  take() {
    return this.data.slice(0, this.length);
  }
}

const HASH_SIZE = 8209;

/** GIF-flavoured LZW compression of palette indices, written as length-prefixed sub-blocks. */
export function lzwEncode(indices, minCodeSize, out) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  const keys = new Int32Array(HASH_SIZE).fill(-1);
  const values = new Int32Array(HASH_SIZE);

  out.byte(minCodeSize);
  const block = new Uint8Array(255);
  let blockLength = 0;
  let buffer = 0;
  let bits = 0;
  const emit = (code) => {
    buffer |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      block[blockLength++] = buffer & 255;
      buffer >>>= 8;
      bits -= 8;
      if (blockLength === 255) {
        out.byte(255);
        out.bytes(block);
        blockLength = 0;
      }
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const value = indices[i];
    const key = (prefix << 8) | value;
    let slot = ((value << 5) ^ prefix) % HASH_SIZE;
    while (keys[slot] !== -1 && keys[slot] !== key) slot = slot + 1 === HASH_SIZE ? 0 : slot + 1;
    if (keys[slot] === key) {
      prefix = values[slot];
      continue;
    }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      keys.fill(-1);
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      keys[slot] = key;
      values[slot] = nextCode++;
    }
    prefix = value;
  }
  emit(prefix);
  emit(endCode);
  if (bits > 0) {
    block[blockLength++] = buffer & 255;
  }
  if (blockLength > 0) {
    out.byte(blockLength);
    out.bytes(block.subarray(0, blockLength));
  }
  out.byte(0);
}

export class GifWriter {
  /**
   * @param {object} options
   * @param {number} options.width
   * @param {number} options.height
   * @param {{colors: Uint8Array}} options.palette
   */
  constructor({ width, height, palette }) {
    this.width = width;
    this.height = height;
    this.parts = [];
    this.previous = null;
    this.pending = null;
    this.carryMs = 0;
    this.frames = 0;

    const header = new Bytes(1024);
    header.bytes(new TextEncoder().encode('GIF89a'));
    header.u16(width);
    header.u16(height);
    header.byte(0xf7); // global colour table, 256 entries
    header.byte(0);
    header.byte(0);
    header.bytes(palette.colors);
    // Loop forever.
    header.bytes([0x21, 0xff, 0x0b]);
    header.bytes(new TextEncoder().encode('NETSCAPE2.0'));
    header.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
    this.parts.push(header.take());
  }

  #flush() {
    const frame = this.pending;
    if (!frame) return;
    // GIF timing is in hundredths of a second: carry the rounding error to the next frame.
    const total = frame.delayMs + this.carryMs;
    const delay = Math.max(2, Math.round(total / 10));
    this.carryMs = total - delay * 10;

    const out = new Bytes(frame.indices.length / 2 + 256);
    out.bytes([0x21, 0xf9, 0x04, frame.transparent ? 0x05 : 0x04]);
    out.u16(delay);
    out.byte(frame.transparent ? TRANSPARENT : 0);
    out.byte(0);
    out.byte(0x2c);
    out.u16(frame.x);
    out.u16(frame.y);
    out.u16(frame.w);
    out.u16(frame.h);
    out.byte(0);
    lzwEncode(frame.indices, 8, out);
    this.parts.push(out.take());
    this.frames++;
    this.pending = null;
  }

  /**
   * @param {Uint8Array} indices  palette index for every pixel of the full frame
   * @param {number} delayMs      how long this frame stays on screen
   */
  addFrame(indices, delayMs) {
    const { width, height } = this;
    if (!this.previous) {
      this.previous = indices.slice();
      this.pending = { x: 0, y: 0, w: width, h: height, indices: indices.slice(), delayMs, transparent: false };
      return;
    }
    const previous = this.previous;
    let top = -1;
    let bottom = -1;
    let left = width;
    let right = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (indices[row + x] === previous[row + x]) continue;
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (top < 0) {
      // Nothing changed: just keep the previous frame on screen longer.
      this.pending.delayMs += delayMs;
      return;
    }
    this.#flush();
    const w = right - left + 1;
    const h = bottom - top + 1;
    const region = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const source = (top + y) * width + left;
      const target = y * w;
      for (let x = 0; x < w; x++) {
        const value = indices[source + x];
        region[target + x] = value === previous[source + x] ? TRANSPARENT : value;
      }
    }
    this.pending = { x: left, y: top, w, h, indices: region, delayMs, transparent: true };
    previous.set(indices);
  }

  /** @returns {Uint8Array[]} the file as parts, ready for `new Blob(parts)` */
  finish() {
    this.#flush();
    this.parts.push(Uint8Array.from([0x3b]));
    return this.parts;
  }
}
