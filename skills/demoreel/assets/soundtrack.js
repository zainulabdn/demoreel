// The browser's half of the sound: it reads audio files (any format the browser can play),
// hands the samples to the mixer in audio.js, and encodes the result as AAC for the MP4.

import { SAMPLE_RATE, mixSoundtrack, toMono } from './audio.js';

const toBytes = (buffer) =>
  buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

/** Yield to the event loop without the timer throttling that applies to hidden tabs. */
const tick = () =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });

/**
 * Decode an audio file (WAV, MP3, M4A, OGG, FLAC...) to samples at 48 kHz.
 * @param {ArrayBuffer} bytes
 * @returns {Promise<Float32Array[]>} one array per channel
 */
export async function decodeAudio(bytes, rate = SAMPLE_RATE) {
  const context = new OfflineAudioContext(2, 1, rate);
  const buffer = await context.decodeAudioData(bytes);
  return Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
}

/**
 * Load every sound the plan names and mix the soundtrack.
 * @param {object} audio  the "audio" part of the render plan
 * @param {(url: string) => Promise<ArrayBuffer>} load
 */
export async function buildSoundtrack(audio, load) {
  const rate = audio.sampleRate;
  const voice = [];
  for (const line of audio.voice) {
    const mono = toMono(await decodeAudio(await load(line.url), rate));
    const from = Math.min(mono.length, Math.round((line.skip / 1000) * rate));
    const to = Math.min(mono.length, from + Math.round((line.duration / 1000) * rate));
    voice.push({ at: line.t / 1000, samples: mono.subarray(from, to) });
  }
  let music = null;
  if (audio.music) {
    const channels = await decodeAudio(await load(audio.music.url), rate);
    music = { left: channels[0], right: channels[1] || channels[0], volume: audio.music.volume };
  }
  return mixSoundtrack({
    length: Math.round((audio.durationMs / 1000) * rate),
    voice,
    effects: audio.effects,
    effectsVolume: audio.effectsVolume,
    music,
    seed: audio.seed,
    rate,
  });
}

/** The AAC settings this browser can encode, or null if it cannot encode AAC at all. */
export async function pickAacConfig(bitrate, rate = SAMPLE_RATE) {
  if (typeof AudioEncoder === 'undefined') return null;
  const config = { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 2, bitrate };
  try {
    return (await AudioEncoder.isConfigSupported(config)).supported ? config : null;
  } catch {
    return null;
  }
}

async function encode(config, left, right) {
  const packets = [];
  let description = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      if (!description && metadata?.decoderConfig?.description) description = toBytes(metadata.decoderConfig.description).slice();
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, timestamp: chunk.timestamp, duration: chunk.duration });
    },
    error(error) {
      failure = error;
    },
  });
  encoder.configure(config);
  const block = 8192;
  for (let at = 0; at < left.length; at += block) {
    const count = Math.min(block, left.length - at);
    const data = new Float32Array(count * 2);
    data.set(left.subarray(at, at + count), 0);
    data.set(right.subarray(at, at + count), count);
    const frame = new AudioData({
      format: 'f32-planar',
      sampleRate: config.sampleRate,
      numberOfFrames: count,
      numberOfChannels: 2,
      timestamp: Math.round((at * 1e6) / config.sampleRate),
      data,
    });
    encoder.encode(frame);
    frame.close();
    while (encoder.encodeQueueSize > 16) await tick();
    if (failure) throw failure;
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!description) throw new Error('The audio encoder produced no decoder configuration.');
  return { packets, description };
}

/**
 * How many samples of lead-in this browser's AAC encoder puts before the sound. Every AAC
 * encoder has one, and it differs between systems (2112 on a Mac, 1024 or other values
 * elsewhere), so it is measured: a tick is encoded, decoded again, and looked for.
 * Returns null if it cannot be measured.
 */
export async function measureAacDelay(config) {
  if (typeof AudioDecoder === 'undefined') return null;
  try {
    const rate = config.sampleRate;
    const mark = 6000;
    const burst = Math.round(0.002 * rate);
    const test = new Float32Array(Math.round(0.4 * rate));
    for (let i = 0; i < burst; i++) {
      test[mark + i] = 0.8 * Math.sin((Math.PI * 2 * 3000 * i) / rate) * (0.5 - 0.5 * Math.cos((Math.PI * 2 * i) / (burst - 1)));
    }
    const peakAt = (samples) => {
      let best = 0;
      for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i]) > Math.abs(samples[best])) best = i;
      return best;
    };
    const { packets, description } = await encode(config, test, test);

    const parts = [];
    let failure = null;
    const decoder = new AudioDecoder({
      output(frame) {
        const part = new Float32Array(frame.numberOfFrames);
        frame.copyTo(part, { planeIndex: 0, format: 'f32-planar' });
        parts.push(part);
        frame.close();
      },
      error(error) {
        failure = error;
      },
    });
    decoder.configure({ codec: config.codec, sampleRate: rate, numberOfChannels: config.numberOfChannels, description });
    for (const packet of packets) {
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: packet.timestamp, duration: packet.duration, data: packet.data }));
    }
    await decoder.flush();
    decoder.close();
    if (failure) return null;
    let total = 0;
    for (const part of parts) total += part.length;
    const decoded = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      decoded.set(part, offset);
      offset += part.length;
    }
    const delay = peakAt(decoded) - peakAt(test);
    return delay >= 0 && delay <= 8192 ? delay : null;
  } catch {
    return null;
  }
}

/**
 * Encode a stereo soundtrack as AAC.
 * @returns {Promise<{packets: Array<{data: Uint8Array, frames: number}>, description: Uint8Array, delay: number, measured: boolean}>}
 */
export async function encodeAac(config, left, right) {
  const measured = await measureAacDelay(config);
  const { packets, description } = await encode(config, left, right);
  return {
    packets: packets.map((packet) => ({
      data: packet.data,
      frames: packet.duration ? Math.round((packet.duration * config.sampleRate) / 1e6) : 1024,
    })),
    description,
    // 1024 is the lead-in every AAC encoder has at the least, used when it could not be measured.
    delay: measured ?? 1024,
    measured: measured !== null,
  };
}
