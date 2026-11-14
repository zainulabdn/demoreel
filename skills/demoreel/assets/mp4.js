// A minimal MP4 writer for one H.264 video track at a constant frame rate, with an
// optional AAC sound track. It takes encoded frames (as produced by the browser's
// VideoEncoder in "avc" format, and AudioEncoder in "aac" format) and wraps them in a
// file that plays in browsers, QuickTime and on social sites.
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

/** One of the length-prefixed records inside an "esds" box. */
const descriptor = (tag, ...parts) => {
  const body = concat(parts);
  if (body.length > 127) throw new Error('The audio codec setup is larger than this writer supports.');
  return concat([u8(tag, body.length), body]);
};

/**
 * The "sample to chunk" table: how many samples each chunk holds, written only where
 * the number changes. @param {Array<{count:number}>} chunks
 */
function sampleToChunkEntries(chunks) {
  const entries = [];
  let previous = -1;
  chunks.forEach((chunk, index) => {
    if (chunk.count !== previous) entries.push(u32(index + 1), u32(chunk.count), u32(1));
    previous = chunk.count;
  });
  return entries;
}

/** The "time to sample" table: runs of samples that last equally long. */
function timeToSampleEntries(durations) {
  const runs = [];
  for (const duration of durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === duration) last[0]++;
    else runs.push([1, duration]);
  }
  return [u32(runs.length), ...runs.flatMap(([count, duration]) => [u32(count), u32(duration)])];
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
    this.audio = null;
  }

  /**
   * Turn on the sound track. Call before adding audio.
   * @param {object} options
   * @param {Uint8Array} options.description  the encoder's "AudioSpecificConfig"
   * @param {number} options.sampleRate
   * @param {number} options.channels
   * @param {number} [options.bitrate]
   */
  setAudioConfig({ description, sampleRate, channels, bitrate = 128000 }) {
    if (!description?.length) throw new Error('The audio encoder produced no decoder configuration.');
    this.audio = { description: new Uint8Array(description), sampleRate, channels, bitrate, samples: [], data: [], skip: 0, length: null };
  }

  /**
   * @param {Uint8Array} data    one encoded AAC packet
   * @param {number} [frames]    how many samples of sound it holds
   */
  addAudioSample(data, frames = 1024) {
    if (!this.audio) throw new Error('Call setAudioConfig before adding audio.');
    this.audio.samples.push({ size: data.length, frames });
    this.audio.data.push(data);
  }

  /**
   * Say which part of the encoded sound is the real sound. An AAC encoder puts a short
   * lead-in before the first sample and pads its last packet with silence. This writes an
   * edit list and a "roll" sample group, which is how players are told to skip both, so
   * sound and picture stay in step.
   * @param {number} skip    samples of lead-in before the sound starts (the encoder's delay)
   * @param {number} length  samples of real sound after that
   */
  setAudioTrim(skip, length) {
    if (!this.audio) return;
    this.audio.skip = Math.max(0, Math.round(skip));
    this.audio.length = Math.max(0, Math.round(length));
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
    const audio = this.audio?.samples.length ? this.audio : null;

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

    const movieTimescale = 1000;
    const mediaDuration = count * delta;
    const videoDuration = Math.round((mediaDuration * movieTimescale) / timescale);

    // One chunk of video per second, each followed by the sound for that second, so a
    // player reading the file from the start always has both.
    const perChunk = Math.max(1, Math.round(this.fps));
    const videoChunks = [];
    for (let first = 0; first < count; first += perChunk) videoChunks.push({ first, count: Math.min(perChunk, count - first) });

    const audioChunks = [];
    let audioFrames = 0;
    if (audio) {
      let chunk = null;
      audio.samples.forEach((sample, index) => {
        const slot = Math.min(Math.floor(audioFrames / audio.sampleRate), videoChunks.length - 1);
        if (!chunk || chunk.slot !== slot) {
          chunk = { slot, first: index, count: 0 };
          audioChunks.push(chunk);
        }
        chunk.count++;
        audioFrames += sample.frames;
      });
    }
    // The part of the encoded sound that is played: all of it, unless a trim was given.
    const audioTrimmed = audio !== null && audio.length !== null && audio.skip + audio.length <= audioFrames;
    const audioPlayed = audioTrimmed ? audio.length : audioFrames;
    const audioDuration = audio ? Math.round((audioPlayed * movieTimescale) / audio.sampleRate) : 0;
    const movieDuration = Math.max(videoDuration, audioDuration);

    // The order of the media in the file: video chunk, its sound, next video chunk, ...
    const order = [];
    let nextAudio = 0;
    videoChunks.forEach((chunk, slot) => {
      order.push({ track: 'video', chunk });
      while (nextAudio < audioChunks.length && audioChunks[nextAudio].slot === slot) order.push({ track: 'audio', chunk: audioChunks[nextAudio++] });
    });

    const build = (firstChunkOffset) => {
      const videoOffsets = [];
      const audioOffsets = [];
      let position = firstChunkOffset;
      for (const { track, chunk } of order) {
        const samples = track === 'video' ? this.samples : audio.samples;
        (track === 'video' ? videoOffsets : audioOffsets).push(position);
        for (let i = chunk.first; i < chunk.first + chunk.count; i++) position += samples[i].size;
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

      const sampleToChunk = sampleToChunkEntries(videoChunks);
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
        fullBox('stco', 0, 0, u32(videoOffsets.length), ...videoOffsets.map((offset) => u32(offset))),
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
          u32(0), u32(0), u32(1), u32(0), u32(videoDuration),
          zeros(8), u16(0), u16(0), u16(0), u16(0),
          MATRIX, u32(this.width << 16), u32(this.height << 16),
        ),
      ];
      if (shift > 0) {
        trackParts.push(box('edts', fullBox('elst', 0, 0, u32(1), u32(videoDuration), u32(shift), u32(0x00010000))));
      }
      trackParts.push(media);
      const tracks = [box('trak', ...trackParts)];

      if (audio) {
        const audioEntry = box(
          'mp4a',
          zeros(6), u16(1), // reserved, data reference index
          zeros(8), // version, revision, vendor
          u16(audio.channels), u16(16), // channels, bits per sample
          u16(0), u16(0), // pre_defined, reserved
          u32(audio.sampleRate * 65536), // sample rate as 16.16 fixed point
          fullBox(
            'esds', 0, 0,
            descriptor(
              0x03, u16(0), u8(0), // elementary stream: id 0, no flags
              descriptor(
                0x04, u8(0x40, 0x15), zeros(3), // MPEG-4 audio, an audio stream, buffer size not stated
                u32(audio.bitrate), u32(audio.bitrate), // peak and average bitrate
                descriptor(0x05, audio.description),
              ),
              descriptor(0x06, u8(0x02)),
            ),
          ),
        );
        const audioSampleToChunk = sampleToChunkEntries(audioChunks);
        const audioParts = [
          fullBox(
            'tkhd', 0, 3,
            u32(0), u32(0), u32(2), u32(0), u32(audioDuration),
            zeros(8), u16(0), u16(1), u16(0x0100), u16(0), // layer, alternate group, full volume
            MATRIX, u32(0), u32(0),
          ),
        ];
        if (audioTrimmed) {
          audioParts.push(box('edts', fullBox('elst', 0, 0, u32(1), u32(audioDuration), u32(audio.skip), u32(0x00010000))));
        }
        tracks.push(
          box(
            'trak',
            ...audioParts,
            box(
              'mdia',
              fullBox('mdhd', 0, 0, u32(0), u32(0), u32(audio.sampleRate), u32(audioFrames), u16(0x55c4), u16(0)),
              fullBox('hdlr', 0, 0, u32(0), text('soun'), zeros(12), text('SoundHandler\0')),
              box(
                'minf',
                fullBox('smhd', 0, 0, u16(0), u16(0)),
                box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
                box(
                  'stbl',
                  fullBox('stsd', 0, 0, u32(1), audioEntry),
                  fullBox('stts', 0, 0, ...timeToSampleEntries(audio.samples.map((sample) => sample.frames))),
                  fullBox('stsc', 0, 0, u32(audioSampleToChunk.length / 3), ...audioSampleToChunk),
                  fullBox('stsz', 0, 0, u32(0), u32(audio.samples.length), ...audio.samples.map((sample) => u32(sample.size))),
                  fullBox('stco', 0, 0, u32(audioOffsets.length), ...audioOffsets.map((offset) => u32(offset))),
                  // A "roll" sample group says each packet needs the one before it to decode cleanly.
                  // It must accompany the edit list: without it, Apple's players (QuickTime, Safari,
                  // iOS) skip the edit list's lead-in and then their own assumed 2112 samples as
                  // well, and the sound plays 44 ms early. With it, ffmpeg, Chrome and Apple agree.
                  ...(audioTrimmed
                    ? [
                        fullBox('sgpd', 1, 0, text('roll'), u32(2), u32(1), u16(0xffff)),
                        fullBox('sbgp', 0, 0, text('roll'), u32(1), u32(audio.samples.length), u32(1)),
                      ]
                    : []),
                ),
              ),
            ),
          ),
        );
      }

      return box(
        'moov',
        fullBox(
          'mvhd', 0, 0,
          u32(0), u32(0), u32(movieTimescale), u32(movieDuration),
          u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(audio ? 3 : 2),
        ),
        ...tracks,
      );
    };

    const ftyp = box('ftyp', text('isom'), u32(0x200), text('isom'), text('iso2'), text('avc1'), text('mp41'));
    let mediaSize = 0;
    for (const sample of this.samples) mediaSize += sample.size;
    if (audio) for (const sample of audio.samples) mediaSize += sample.size;
    if (mediaSize + 8 > 0xffffffff) throw new Error('The video is larger than 4 GB, which this writer does not support.');

    // The index size does not depend on the offsets inside it, so build once to measure, then for real.
    const moovSize = build(0).length;
    const moov = build(ftyp.length + moovSize + 8);
    const mdatHeader = concat([u32(mediaSize + 8), text('mdat')]);
    const media = [];
    for (const { track, chunk } of order) {
      const data = track === 'video' ? this.data : audio.data;
      for (let i = chunk.first; i < chunk.first + chunk.count; i++) media.push(data[i]);
    }
    return [ftyp, moov, mdatHeader, ...media];
  }
}
