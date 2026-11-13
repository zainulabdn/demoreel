// A minimal MP4 writer for one H.264 video track at a constant frame rate.
// It takes encoded frames (as produced by the browser's VideoEncoder in "avc" format)
// and wraps them in a file that plays in browsers, QuickTime and on social sites.
// The index (moov) is written before the media (mdat) so the file starts playing
// before it has fully downloaded. Works in the browser and in Node. No dependencies.

const encoder = new TextEncoder();

const u8 = (...values) => Uint8Array.from(values);
const u16 = (value) => Uint8Array.from([(value >> 8) & 255, value & 255]);
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
};
const text = (value) => encoder.encode(value);
const zeros = (count) => new Uint8Array(count);

export function concat(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const box = (type, ...parts) => {
  const body = concat(parts);
  return concat([u32(body.length + 8), text(type), body]);
};

const fullBox = (type, version, flags, ...parts) =>
  box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

// The identity transform every video track carries.
const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

const COLOR_PRIMARIES = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
const COLOR_TRANSFER = { bt709: 1, smpte170m: 6, linear: 8, 'iec61966-2-1': 13, pq: 16, hlg: 18 };
const COLOR_MATRIX = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 };

/** A time base that divides evenly by the frame rate, so frame times are exact. */
export function timescaleFor(fps) {
  return 90000 % fps === 0 ? 90000 : fps * 1000;
}

export class Mp4Muxer {
  /**
   * @param {object} options
   * @param {number} options.width
   * @param {number} options.height
   * @param {number} options.fps
   */
  constructor({ width, height, fps }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.timescale = timescaleFor(fps);
    this.delta = this.timescale / fps;
    this.samples = [];
    this.data = [];
    this.description = null;
    this.colorSpace = null;
  }

  /**
   * Codec setup from the encoder (the "avcC" record), delivered with the first frame.
   * @param {Uint8Array} description
   * @param {{primaries?:string, transfer?:string, matrix?:string, fullRange?:boolean}} [colorSpace]
   */
  setDecoderConfig(description, colorSpace) {
    if (!this.description) {
      this.description = new Uint8Array(description);
      this.colorSpace = colorSpace || null;
    }
  }

  /**
   * @param {Uint8Array} data        one encoded frame
   * @param {boolean} key            true for a keyframe
   * @param {number} timestampUs     presentation time in microseconds
   */
  addSample(data, key, timestampUs) {
    this.samples.push({
      size: data.length,
      key,
      pts: Math.round((timestampUs * this.timescale) / 1_000_000),
    });
    this.data.push(data);
  }

  /** @returns {Uint8Array[]} the file as a list of parts, ready for `new Blob(parts)` */
  finalize() {
    if (!this.description) throw new Error('The encoder produced no decoder configuration.');
    if (!this.samples.length) throw new Error('No frames were encoded.');
    const count = this.samples.length;
    const { timescale, delta } = this;

    // Frames arrive in decode order. If the encoder reordered any (B-frames), record how far
    // each one's display time is from its decode time, and shift the track to start at zero.
    let shift = 0;
    let reordered = false;
    const offsets = this.samples.map((sample, index) => {
      const offset = sample.pts - index * delta;
      if (offset !== 0) reordered = true;
      if (-offset > shift) shift = -offset;
      return offset;
    });

    const mediaDuration = count * delta;
    const movieTimescale = 1000;
    const movieDuration = Math.round((mediaDuration * movieTimescale) / timescale);
    const perChunk = Math.max(1, Math.round(this.fps));
    const chunkCount = Math.ceil(count / perChunk);
    const lastChunkSize = count - (chunkCount - 1) * perChunk;

    const build = (firstChunkOffset) => {
      const chunkOffsets = [];
      let position = firstChunkOffset;
      for (let i = 0; i < count; i++) {
        if (i % perChunk === 0) chunkOffsets.push(position);
        position += this.samples[i].size;
      }

      const visualEntry = [
        zeros(6), u16(1), // reserved, data reference index
        zeros(16), // pre_defined and reserved
        u16(this.width), u16(this.height),
        u32(0x00480000), u32(0x00480000), // 72 dpi
        u32(0), u16(1), // reserved, one frame per sample
        zeros(32), // compressor name
        u16(0x0018), u16(0xffff), // depth, pre_defined
        box('avcC', this.description),
      ];
      const color = this.colorSpace;
      if (color && COLOR_PRIMARIES[color.primaries] && COLOR_TRANSFER[color.transfer] && color.matrix in COLOR_MATRIX) {
        visualEntry.push(
          box(
            'colr', text('nclx'),
            u16(COLOR_PRIMARIES[color.primaries]), u16(COLOR_TRANSFER[color.transfer]), u16(COLOR_MATRIX[color.matrix]),
            u8(color.fullRange ? 0x80 : 0),
          ),
        );
      }
      visualEntry.push(box('pasp', u32(1), u32(1)));

      const keyframes = [];
      this.samples.forEach((sample, index) => {
        if (sample.key) keyframes.push(index + 1);
      });

      const sampleToChunk = [u32(1), u32(Math.min(perChunk, count)), u32(1)];
      if (chunkCount > 1 && lastChunkSize !== perChunk) sampleToChunk.push(u32(chunkCount), u32(lastChunkSize), u32(1));

      const tables = [
        fullBox('stsd', 0, 0, u32(1), box('avc1', ...visualEntry)),
        fullBox('stts', 0, 0, u32(1), u32(count), u32(delta)),
      ];
      if (reordered) {
        tables.push(fullBox('ctts', 0, 0, u32(count), ...offsets.flatMap((offset) => [u32(1), u32(offset + shift)])));
      }
      if (keyframes.length !== count) {
        tables.push(fullBox('stss', 0, 0, u32(keyframes.length), ...keyframes.map((n) => u32(n))));
      }
      tables.push(
        fullBox('stsc', 0, 0, u32(sampleToChunk.length / 3), ...sampleToChunk),
        fullBox('stsz', 0, 0, u32(0), u32(count), ...this.samples.map((sample) => u32(sample.size))),
        fullBox('stco', 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map((offset) => u32(offset))),
      );

      const media = box(
        'mdia',
        fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0)),
        fullBox('hdlr', 0, 0, u32(0), text('vide'), zeros(12), text('VideoHandler\0')),
        box(
          'minf',
          fullBox('vmhd', 0, 1, zeros(8)),
          box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
          box('stbl', ...tables),
        ),
      );

      const trackParts = [
        fullBox(
          'tkhd', 0, 3,
          u32(0), u32(0), u32(1), u32(0), u32(movieDuration),
          zeros(8), u16(0), u16(0), u16(0), u16(0),
          MATRIX, u32(this.width << 16), u32(this.height << 16),
        ),
      ];
      if (shift > 0) {
        trackParts.push(box('edts', fullBox('elst', 0, 0, u32(1), u32(movieDuration), u32(shift), u32(0x00010000))));
      }
      trackParts.push(media);

      return box(
        'moov',
        fullBox(
          'mvhd', 0, 0,
          u32(0), u32(0), u32(movieTimescale), u32(movieDuration),
          u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2),
        ),
        box('trak', ...trackParts),
      );
    };

    const ftyp = box('ftyp', text('isom'), u32(0x200), text('isom'), text('iso2'), text('avc1'), text('mp41'));
    let mediaSize = 0;
    for (const sample of this.samples) mediaSize += sample.size;
    if (mediaSize + 8 > 0xffffffff) throw new Error('The video is larger than 4 GB, which this writer does not support.');

    // The index size does not depend on the offsets inside it, so build once to measure, then for real.
    const moovSize = build(0).length;
    const moov = build(ftyp.length + moovSize + 8);
    const mdatHeader = concat([u32(mediaSize + 8), text('mdat')]);
    return [ftyp, moov, mdatHeader, ...this.data];
  }
}
