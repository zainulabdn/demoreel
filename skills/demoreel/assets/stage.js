// Runs in a headless browser tab. Reads the render plan, draws every output frame,
// and encodes the result to MP4 (H.264 and AAC through the browser's own encoders) and GIF.
// Finished files are posted back to the local Demoreel process that opened this page.

import { encodeWav } from './audio.js';
import { GifWriter, Histogram, Quantizer, buildPalette } from './gif.js';
import { Mp4Muxer } from './mp4.js';
import { createScene } from './scene.js';
import { buildSoundtrack, encodeAac, pickAacConfig } from './soundtrack.js';

const report = (data) => {
  try {
    window.__demoreelProgress?.(JSON.stringify(data));
  } catch {
    // Progress is best effort.
  }
};

/** Yield to the event loop without the timer throttling that applies to hidden tabs. */
const tick = () =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });

async function upload(path, body) {
  const response = await fetch(path, { method: 'POST', body });
  if (!response.ok) throw new Error(`Could not save ${path} (${response.status}). ${(await response.text()).slice(0, 400)}`.trim());
  return response.json();
}

/** Loads captured frames on demand and keeps a few decoded ahead of the one being drawn. */
class FrameSource {
  constructor(files) {
    this.files = files;
    this.cache = new Map();
  }

  #load(index) {
    if (!this.cache.has(index)) {
      this.cache.set(
        index,
        fetch(`frames/${this.files[index]}`)
          .then((response) => {
            if (!response.ok) throw new Error(`Missing frame ${this.files[index]}`);
            return response.blob();
          })
          .then((blob) => createImageBitmap(blob)),
      );
    }
    return this.cache.get(index);
  }

  /** Get a frame for sequential playback: older frames are released, the next few are preloaded. */
  async get(index) {
    for (const [key, promise] of this.cache) {
      if (key < index) {
        this.cache.delete(key);
        promise.then((bitmap) => bitmap.close()).catch(() => {});
      }
    }
    for (let ahead = 1; ahead <= 3 && index + ahead < this.files.length; ahead++) this.#load(index + ahead);
    return this.#load(index);
  }

  /** Get a frame out of order, without keeping it. */
  async peek(index) {
    const response = await fetch(`frames/${this.files[index]}`);
    return createImageBitmap(await response.blob());
  }

  clear() {
    for (const promise of this.cache.values()) promise.then((bitmap) => bitmap.close()).catch(() => {});
    this.cache.clear();
  }
}

async function pickEncoderConfig(plan) {
  if (typeof VideoEncoder === 'undefined') return null;
  const { layout, fps, encode } = plan;
  for (const codec of encode.codecs) {
    const config = {
      codec,
      width: layout.width,
      height: layout.height,
      bitrate: encode.bitrate,
      framerate: fps,
      bitrateMode: 'variable',
      latencyMode: 'quality',
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      // Try the next codec string.
    }
  }
  return null;
}

const toBytes = (buffer) =>
  buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

function makeSheet(plan) {
  const { layout } = plan;
  const moments = plan.sheet;
  const columns = Math.min(4, moments.length);
  const cellW = layout.width >= layout.height ? 480 : 300;
  const cellH = Math.round((cellW * layout.height) / layout.width);
  const labelH = 34;
  const gap = 14;
  const rows = Math.ceil(moments.length / columns);
  const canvas = new OffscreenCanvas(columns * cellW + (columns + 1) * gap, rows * (cellH + labelH) + (rows + 1) * gap);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#101114';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  return {
    canvas,
    place(slot, source) {
      const moment = moments[slot];
      const x = gap + (slot % columns) * (cellW + gap);
      const y = gap + Math.floor(slot / columns) * (cellH + labelH + gap);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, x, y, cellW, cellH);
      ctx.fillStyle = '#d7d9e0';
      let label = `${(moment.time / 1000).toFixed(1)}s  ${moment.label}`;
      while (label.length > 8 && ctx.measureText(label).width > cellW) label = `${label.slice(0, -4)}...`;
      ctx.fillText(label, x, y + cellH + labelH / 2);
    },
  };
}

window.__demoreelRender = async () => {
  const started = performance.now();
  const plan = await (await fetch('plan.json')).json();
  const { layout, track, encode, fps, frameCount } = plan;
  const wantMp4 = encode.formats.includes('mp4');
  const wantGif = encode.formats.includes('gif');
  const result = { ok: true, files: [], frameCount, fps, codec: null, notes: [] };

  const canvas = new OffscreenCanvas(layout.width, layout.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const scene = createScene(plan);
  const source = new FrameSource(plan.frames);

  // ---- MP4 setup
  let encoder = null;
  let muxer = null;
  let encodeError = null;
  let useSink = false;
  if (wantMp4) {
    const config = encode.videoEncoder === 'ffmpeg' ? null : await pickEncoderConfig(plan);
    if (config) {
      result.codec = config.codec;
      muxer = new Mp4Muxer({ width: layout.width, height: layout.height, fps });
      encoder = new VideoEncoder({
        output(chunk, metadata) {
          const config = metadata?.decoderConfig;
          if (config?.description) {
            const space = config.colorSpace;
            muxer.setDecoderConfig(
              toBytes(config.description),
              space ? { primaries: space.primaries, transfer: space.transfer, matrix: space.matrix, fullRange: space.fullRange } : null,
            );
          }
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          muxer.addSample(data, chunk.type === 'key', chunk.timestamp);
        },
        error(error) {
          encodeError = error;
        },
      });
      encoder.configure(config);
    } else if (encode.sink) {
      useSink = true;
      result.codec = 'ffmpeg';
      result.notes.push(encode.videoEncoder === 'ffmpeg' ? 'The video was encoded by ffmpeg, as DEMOREEL_VIDEO_ENCODER asks.' : 'This browser has no H.264 encoder, so frames were handed to ffmpeg.');
    } else {
      return {
        ok: false,
        reason: 'no-h264',
        message: 'This browser cannot encode H.264 video.',
      };
    }
  }

  // ---- sound: mixed before the picture is drawn, because ffmpeg (when it is used) needs it from the first frame.
  let sound = null;
  if (plan.audio && (encoder || useSink)) {
    report({ phase: 'sound' });
    const load = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`The sound file ${url} is missing from the recording.`);
      return response.arrayBuffer();
    };
    const mix = await buildSoundtrack(plan.audio, load);
    const wav = () => new Blob([encodeWav([mix.left, mix.right], plan.audio.sampleRate)], { type: 'audio/wav' });
    const aacConfig = encoder && encode.audioEncoder !== 'ffmpeg' ? await pickAacConfig(plan.audio.bitrate, plan.audio.sampleRate) : null;
    if (aacConfig) {
      sound = { mode: 'browser', aac: await encodeAac(aacConfig, mix.left, mix.right), length: mix.left.length };
    } else if (encode.sink) {
      await upload('sink/audio', wav());
      sound = { mode: 'ffmpeg' };
      if (encoder) {
        result.notes.push(encode.audioEncoder === 'ffmpeg' ? 'The sound was encoded by ffmpeg, as DEMOREEL_AUDIO_ENCODER asks.' : 'This browser has no AAC encoder, so the sound was handed to ffmpeg.');
      }
    } else {
      const saved = await upload(`out/${plan.name}.wav`, wav());
      result.files.push({ kind: 'soundtrack', ...saved });
      sound = { mode: 'none' };
      result.notes.push(
        'The MP4 has no sound: this browser cannot encode AAC and ffmpeg is not installed. The soundtrack was saved as a WAV file next to the video. Install ffmpeg and run again.',
      );
    }
    result.sound = {
      encoder: sound.mode,
      voiceLines: mix.info.voiceLines,
      voiceSeconds: mix.info.voiceSeconds,
      effects: mix.info.effects,
      music: mix.info.music,
      lufs: Number.isFinite(mix.info.lufs) ? Math.round(mix.info.lufs * 10) / 10 : null,
      peak: Math.round(mix.info.peak * 1000) / 1000,
    };
  }

  // ---- GIF setup: look at frames across the whole video to choose one palette for all of it.
  let gif = null;
  if (wantGif) {
    const size = encode.gif;
    const small = new OffscreenCanvas(size.width, size.height);
    const smallCtx = small.getContext('2d', { alpha: false, willReadFrequently: true });
    smallCtx.imageSmoothingQuality = 'high';
    const histogram = new Histogram();
    const samples = Math.min(20, frameCount);
    for (let n = 0; n < samples; n++) {
      const i = samples === 1 ? 0 : Math.round((n * (frameCount - 1)) / (samples - 1));
      const bitmap = await source.peek(track.src[i]);
      scene.draw(ctx, i, bitmap, { snap: true });
      bitmap.close();
      smallCtx.drawImage(canvas, 0, 0, size.width, size.height);
      histogram.add(smallCtx.getImageData(0, 0, size.width, size.height).data);
      report({ phase: 'palette', done: n + 1, total: samples });
    }
    const palette = buildPalette(histogram);
    gif = {
      size,
      small,
      smallCtx,
      quantizer: new Quantizer(palette),
      writer: new GifWriter({ width: size.width, height: size.height, palette }),
      indices: new Uint8Array(size.width * size.height),
      delay: (size.every * 1000) / fps,
    };
    scene.reset();
  }

  // ---- contact sheet and poster
  const sheet = makeSheet(plan);
  const sheetSlots = new Map();
  plan.sheet.forEach((moment, slot) => {
    if (!sheetSlots.has(moment.frame)) sheetSlots.set(moment.frame, []);
    sheetSlots.get(moment.frame).push(slot);
  });
  let poster = null;

  // ---- main pass
  for (let i = 0; i < frameCount; i++) {
    const bitmap = await source.get(track.src[i]);
    scene.draw(ctx, i, bitmap);

    if (encoder) {
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % encode.keyframeEvery === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6) await tick();
      if (encodeError) throw encodeError;
    } else if (useSink) {
      await upload('sink/frame', await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 }));
    }

    if (gif && i % gif.size.every === 0) {
      gif.smallCtx.drawImage(canvas, 0, 0, gif.size.width, gif.size.height);
      const pixels = gif.smallCtx.getImageData(0, 0, gif.size.width, gif.size.height).data;
      gif.quantizer.apply(pixels, gif.size.width, gif.indices);
      gif.writer.addFrame(gif.indices, gif.delay);
    }

    const slots = sheetSlots.get(i);
    if (slots) for (const slot of slots) sheet.place(slot, canvas);
    if (i === plan.posterFrame) poster = await canvas.convertToBlob({ type: 'image/png' });

    if (i % 10 === 0 || i === frameCount - 1) {
      report({ phase: 'render', done: i + 1, total: frameCount });
      await tick();
    }
  }
  source.clear();

  // ---- finish and save
  if (encoder) {
    await encoder.flush();
    encoder.close();
    if (encodeError) throw encodeError;
    if (muxer.samples.length !== frameCount) {
      result.notes.push(`The encoder returned ${muxer.samples.length} of ${frameCount} frames.`);
    }
    if (sound?.mode === 'browser') {
      muxer.setAudioConfig({ description: sound.aac.description, sampleRate: plan.audio.sampleRate, channels: 2, bitrate: plan.audio.bitrate });
      for (const packet of sound.aac.packets) muxer.addAudioSample(packet.data, packet.frames);
      muxer.setAudioTrim(sound.aac.delay, sound.length);
    }
    report({ phase: 'save', file: 'mp4' });
    let saved = await upload(`out/${plan.name}.mp4`, new Blob(muxer.finalize(), { type: 'video/mp4' }));
    if (sound?.mode === 'ffmpeg') saved = await upload('sink/mux', '');
    result.files.push({ kind: 'mp4', ...saved });
  } else if (useSink) {
    const saved = await upload('sink/end', '');
    result.files.push({ kind: 'mp4', ...saved });
  }
  if (gif) {
    report({ phase: 'save', file: 'gif' });
    const saved = await upload(`out/${plan.name}.gif`, new Blob(gif.writer.finish(), { type: 'image/gif' }));
    result.files.push({ kind: 'gif', frames: gif.writer.frames, ...saved });
  }
  if (poster) {
    const saved = await upload(`out/${plan.name}.poster.png`, poster);
    result.files.push({ kind: 'poster', ...saved });
  }
  {
    const saved = await upload(`out/${plan.name}.sheet.png`, await sheet.canvas.convertToBlob({ type: 'image/png' }));
    result.files.push({ kind: 'sheet', ...saved });
  }

  result.renderMs = Math.round(performance.now() - started);
  return result;
};
