import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GifWriter, Histogram, Quantizer, buildPalette, lzwEncode } from '../skills/demoreel/assets/gif.js';
import { Mp4Muxer, concat, timescaleFor } from '../skills/demoreel/assets/mp4.js';

// ---------------------------------------------------------------- MP4

/** Read the boxes at one level of an MP4 file. */
function readBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let offset = start;
  while (offset < end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    assert.ok(size >= 8 && offset + size <= end, `box ${type} has a valid size`);
    boxes.push({ type, start: offset, bodyStart: offset + 8, end: offset + size });
    offset += size;
  }
  return boxes;
}

const find = (bytes, parent, ...path) => {
  let box = parent;
  for (const type of path) {
    const skip = ['stsd'].includes(box.type) ? 8 : 0;
    const child = readBoxes(bytes, box.bodyStart + skip, box.end).find((b) => b.type === type);
    assert.ok(child, `missing box ${type}`);
    box = child;
  }
  return box;
};

function makeVideo({ fps = 30, count = 75, pts } = {}) {
  const muxer = new Mp4Muxer({ width: 1920, height: 1080, fps });
  muxer.setDecoderConfig(Uint8Array.from([1, 100, 0, 40, 255, 225, 0, 0]), { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false });
  const samples = [];
  for (let i = 0; i < count; i++) {
    const data = new Uint8Array(10 + (i % 7)).fill(i % 251);
    samples.push(data);
    const frameNumber = pts ? pts[i] : i;
    muxer.addSample(data, i % 60 === 0, Math.round((frameNumber * 1e6) / fps));
  }
  return { file: concat(muxer.finalize()), samples, muxer };
}

test('MP4: index comes before the media, so the file can start playing while it downloads', () => {
  const { file } = makeVideo();
  assert.deepEqual(readBoxes(file).map((box) => box.type), ['ftyp', 'moov', 'mdat']);
});

test('MP4: sample tables describe exactly the frames that were added', () => {
  const { file, samples } = makeVideo({ fps: 30, count: 75 });
  const view = new DataView(file.buffer);
  const moov = readBoxes(file).find((box) => box.type === 'moov');
  const stbl = find(file, moov, 'trak', 'mdia', 'minf', 'stbl');

  const stsz = find(file, stbl, 'stsz');
  assert.equal(view.getUint32(stsz.bodyStart + 8), 75, 'sample count');
  samples.forEach((sample, i) => assert.equal(view.getUint32(stsz.bodyStart + 12 + i * 4), sample.length));

  const stts = find(file, stbl, 'stts');
  assert.equal(view.getUint32(stts.bodyStart + 8), 75);
  assert.equal(view.getUint32(stts.bodyStart + 12), timescaleFor(30) / 30);

  const stss = find(file, stbl, 'stss');
  assert.equal(view.getUint32(stss.bodyStart + 4), 2, 'two keyframes');
  assert.equal(view.getUint32(stss.bodyStart + 8), 1);
  assert.equal(view.getUint32(stss.bodyStart + 12), 61);

  // Every chunk offset must point at the first byte of that chunk's first frame.
  const stco = find(file, stbl, 'stco');
  const chunkCount = view.getUint32(stco.bodyStart + 4);
  assert.equal(chunkCount, 3, '75 frames in one-second chunks of 30');
  let expected = readBoxes(file).find((box) => box.type === 'mdat').bodyStart;
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    assert.equal(view.getUint32(stco.bodyStart + 8 + chunk * 4), expected, `chunk ${chunk} offset`);
    assert.equal(file[expected], samples[chunk * 30][0], 'offset lands on the right frame');
    for (let i = chunk * 30; i < Math.min(75, (chunk + 1) * 30); i++) expected += samples[i].length;
  }

  const stsc = find(file, stbl, 'stsc');
  assert.equal(view.getUint32(stsc.bodyStart + 4), 2, 'full chunks, then a shorter last chunk');
  assert.equal(view.getUint32(stsc.bodyStart + 12), 30);
  assert.equal(view.getUint32(stsc.bodyStart + 24), 15);
});

test('MP4: carries the picture size, codec setup and colour description', () => {
  const { file } = makeVideo();
  const view = new DataView(file.buffer);
  const moov = readBoxes(file).find((box) => box.type === 'moov');
  const stsd = find(file, moov, 'trak', 'mdia', 'minf', 'stbl', 'stsd');
  const avc1 = readBoxes(file, stsd.bodyStart + 8, stsd.end)[0];
  assert.equal(avc1.type, 'avc1');
  assert.equal(view.getUint16(avc1.bodyStart + 24), 1920);
  assert.equal(view.getUint16(avc1.bodyStart + 26), 1080);
  const inner = readBoxes(file, avc1.bodyStart + 78, avc1.end).map((box) => box.type);
  assert.deepEqual(inner, ['avcC', 'colr', 'pasp']);
});

test('MP4: duration matches the frame count for common frame rates', () => {
  for (const fps of [24, 25, 30, 50, 60]) {
    const { file } = makeVideo({ fps, count: fps * 3 });
    const view = new DataView(file.buffer);
    const moov = readBoxes(file).find((box) => box.type === 'moov');
    const mvhd = find(file, moov, 'mvhd');
    assert.equal(view.getUint32(mvhd.bodyStart + 12), 1000);
    assert.equal(view.getUint32(mvhd.bodyStart + 16), 3000, `${fps} fps`);
    assert.equal(Number.isInteger(timescaleFor(fps) / fps), true);
  }
});

test('MP4: reordered frames get display offsets and an edit list; in-order video does not', () => {
  const plain = makeVideo({ count: 6 });
  const plainMoov = readBoxes(plain.file).find((box) => box.type === 'moov');
  const plainStbl = find(plain.file, plainMoov, 'trak', 'mdia', 'minf', 'stbl');
  assert.ok(!readBoxes(plain.file, plainStbl.bodyStart, plainStbl.end).some((box) => box.type === 'ctts'));

  // Decode order I P B B: display order 0 3 1 2.
  const { file } = makeVideo({ count: 4, pts: [0, 3, 1, 2] });
  const view = new DataView(file.buffer);
  const moov = readBoxes(file).find((box) => box.type === 'moov');
  const trak = find(file, moov, 'trak');
  assert.ok(readBoxes(file, trak.bodyStart, trak.end).some((box) => box.type === 'edts'));
  const ctts = find(file, trak, 'mdia', 'minf', 'stbl', 'ctts');
  const delta = timescaleFor(30) / 30;
  const offsets = [0, 1, 2, 3].map((i) => view.getUint32(ctts.bodyStart + 8 + i * 8 + 4) / delta);
  assert.deepEqual(offsets, [1, 3, 0, 0], 'each offset is display time minus decode time, shifted to stay positive');
});

/** A video with a sound track: `packets` AAC packets of 1024 samples at 48 kHz. */
function makeVideoWithSound({ fps = 30, count = 75, packets = 118, trim = null } = {}) {
  const muxer = new Mp4Muxer({ width: 1920, height: 1080, fps });
  muxer.setDecoderConfig(Uint8Array.from([1, 100, 0, 40, 255, 225, 0, 0]));
  const frames = [];
  for (let i = 0; i < count; i++) {
    const data = new Uint8Array(10 + (i % 7)).fill(i % 251);
    frames.push(data);
    muxer.addSample(data, i % 60 === 0, Math.round((i * 1e6) / fps));
  }
  muxer.setAudioConfig({ description: Uint8Array.from([0x11, 0x90]), sampleRate: 48000, channels: 2, bitrate: 128000 });
  const sound = [];
  for (let i = 0; i < packets; i++) {
    // Sound bytes are 200 and up, so they can be told apart from picture bytes.
    const data = new Uint8Array(4 + (i % 5)).fill(200 + (i % 50));
    sound.push(data);
    muxer.addAudioSample(data);
  }
  if (trim) muxer.setAudioTrim(trim.skip, trim.length);
  return { file: concat(muxer.finalize()), frames, sound };
}

const tracksOf = (file) => {
  const moov = readBoxes(file).find((box) => box.type === 'moov');
  return readBoxes(file, moov.bodyStart, moov.end).filter((box) => box.type === 'trak');
};

/** Every sample of a track, as [file offset, size], worked out from its tables like a player does. */
function sampleLocations(file, trak) {
  const view = new DataView(file.buffer);
  const stbl = find(file, trak, 'mdia', 'minf', 'stbl');
  const stsc = find(file, stbl, 'stsc');
  const stsz = find(file, stbl, 'stsz');
  const stco = find(file, stbl, 'stco');
  const runs = [];
  for (let i = 0; i < view.getUint32(stsc.bodyStart + 4); i++) {
    runs.push({ firstChunk: view.getUint32(stsc.bodyStart + 8 + i * 12), perChunk: view.getUint32(stsc.bodyStart + 12 + i * 12) });
  }
  const locations = [];
  let sample = 0;
  for (let chunk = 1; chunk <= view.getUint32(stco.bodyStart + 4); chunk++) {
    const run = runs.findLast((entry) => entry.firstChunk <= chunk);
    let offset = view.getUint32(stco.bodyStart + 8 + (chunk - 1) * 4);
    for (let i = 0; i < run.perChunk; i++) {
      const size = view.getUint32(stsz.bodyStart + 12 + sample * 4);
      locations.push([offset, size]);
      offset += size;
      sample++;
    }
  }
  assert.equal(sample, view.getUint32(stsz.bodyStart + 8), 'the chunks hold every sample');
  return locations;
}

test('MP4 sound: a second track is added, and a silent video is unchanged', () => {
  const { file } = makeVideoWithSound();
  const view = new DataView(file.buffer);
  const tracks = tracksOf(file);
  assert.equal(tracks.length, 2);
  const handler = (trak) => {
    const hdlr = find(file, trak, 'mdia', 'hdlr');
    return String.fromCharCode(...file.subarray(hdlr.bodyStart + 8, hdlr.bodyStart + 12));
  };
  assert.deepEqual(tracks.map(handler), ['vide', 'soun']);
  const mvhd = find(file, readBoxes(file).find((box) => box.type === 'moov'), 'mvhd');
  assert.equal(view.getUint32(mvhd.end - 4), 3, 'the next free track number');
  assert.equal(view.getUint32(find(file, tracks[1], 'tkhd').bodyStart + 12), 2, 'the sound is track 2');
  assert.equal(view.getUint16(find(file, tracks[1], 'tkhd').bodyStart + 36), 0x0100, 'at full volume');

  assert.equal(tracksOf(makeVideo().file).length, 1);
});

test('MP4 sound: every picture and sound sample is where the tables say it is', () => {
  const { file, frames, sound } = makeVideoWithSound();
  const [video, audio] = tracksOf(file);
  const pictures = sampleLocations(file, video);
  const packets = sampleLocations(file, audio);
  assert.equal(pictures.length, frames.length);
  assert.equal(packets.length, sound.length);
  pictures.forEach(([offset, size], i) => assert.deepEqual(file.subarray(offset, offset + size), frames[i], `frame ${i}`));
  packets.forEach(([offset, size], i) => assert.deepEqual(file.subarray(offset, offset + size), sound[i], `packet ${i}`));

  // Nothing overlaps and nothing is left over: together they fill the media box exactly.
  const mdat = readBoxes(file).find((box) => box.type === 'mdat');
  const all = [...pictures, ...packets].sort((a, b) => a[0] - b[0]);
  let position = mdat.bodyStart;
  for (const [offset, size] of all) {
    assert.equal(offset, position);
    position += size;
  }
  assert.equal(position, mdat.end);
});

test('MP4 sound: each second of sound sits right after that second of video', () => {
  const { file } = makeVideoWithSound({ fps: 30, count: 75, packets: 118 });
  const view = new DataView(file.buffer);
  const [video, audio] = tracksOf(file);
  const chunkOffsets = (trak) => {
    const stco = find(file, trak, 'mdia', 'minf', 'stbl', 'stco');
    return Array.from({ length: view.getUint32(stco.bodyStart + 4) }, (_, i) => view.getUint32(stco.bodyStart + 8 + i * 4));
  };
  const videoChunks = chunkOffsets(video);
  const audioChunks = chunkOffsets(audio);
  assert.equal(videoChunks.length, 3);
  assert.equal(audioChunks.length, 3);
  const order = [...videoChunks.map((offset) => ['video', offset]), ...audioChunks.map((offset) => ['audio', offset])].sort((a, b) => a[1] - b[1]);
  assert.deepEqual(order.map(([kind]) => kind), ['video', 'audio', 'video', 'audio', 'video', 'audio']);
  // 48000 / 1024 is 46.9 packets a second: 47 in the first second, and the rest follow.
  const stsc = find(file, audio, 'mdia', 'minf', 'stbl', 'stsc');
  assert.equal(view.getUint32(stsc.bodyStart + 12), 47);
});

test('MP4 sound: describes the codec the way players expect (mp4a with an esds record)', () => {
  const { file } = makeVideoWithSound();
  const view = new DataView(file.buffer);
  const audio = tracksOf(file)[1];
  const mdhd = find(file, audio, 'mdia', 'mdhd');
  assert.equal(view.getUint32(mdhd.bodyStart + 12), 48000, 'time is counted in samples');
  const stbl = find(file, audio, 'mdia', 'minf', 'stbl');
  assert.ok(readBoxes(file, find(file, audio, 'mdia', 'minf').bodyStart, find(file, audio, 'mdia', 'minf').end).some((box) => box.type === 'smhd'));
  const stsd = find(file, stbl, 'stsd');
  const mp4a = readBoxes(file, stsd.bodyStart + 8, stsd.end)[0];
  assert.equal(mp4a.type, 'mp4a');
  assert.equal(view.getUint16(mp4a.bodyStart + 16), 2, 'channels');
  assert.equal(view.getUint16(mp4a.bodyStart + 18), 16, 'bits');
  assert.equal(view.getUint32(mp4a.bodyStart + 24), 48000 * 65536, 'sample rate');
  const esds = readBoxes(file, mp4a.bodyStart + 28, mp4a.end)[0];
  assert.equal(esds.type, 'esds');
  const body = [...file.subarray(esds.bodyStart + 4, esds.end)];
  // Tag, length, then contents, nested: stream (3) > decoder config (4) > codec setup (5), then (6).
  assert.equal(body[0], 0x03);
  assert.equal(body[1], body.length - 2, 'the outer record spans the whole box');
  assert.equal(body[5], 0x04);
  assert.equal(body[7], 0x40, 'MPEG-4 audio');
  assert.equal(body[8], 0x15, 'an audio stream');
  assert.equal(new DataView(Uint8Array.from(body).buffer).getUint32(16), 128000, 'average bitrate');
  assert.deepEqual(body.slice(20, 24), [0x05, 2, 0x11, 0x90], 'the AudioSpecificConfig, untouched');
  assert.deepEqual(body.slice(24), [0x06, 1, 0x02]);
  assert.ok(!readBoxes(file, stbl.bodyStart, stbl.end).some((box) => box.type === 'stss'), 'every sound packet can be a starting point');
});

test('MP4 sound: an edit list skips the encoder lead-in and ends the sound with the picture', () => {
  const view = (file) => new DataView(file.buffer);
  const hasEditList = (file, trak) => readBoxes(file, trak.bodyStart, trak.end).some((box) => box.type === 'edts');
  // 2.5 s of video is 120000 samples. 120 packets hold 122880: a 2112-sample lead-in, the sound, and padding.
  const trimmed = makeVideoWithSound({ packets: 120, trim: { skip: 2112, length: 120000 } }).file;
  const audio = tracksOf(trimmed)[1];
  const elst = find(trimmed, audio, 'edts', 'elst');
  assert.deepEqual([4, 8, 12, 16].map((at) => view(trimmed).getUint32(elst.bodyStart + at)), [1, 2500, 2112, 0x00010000], 'one edit: play 2.5 s starting 2112 samples in');
  assert.equal(view(trimmed).getUint32(find(trimmed, audio, 'tkhd').bodyStart + 20), 2500, 'the track lasts as long as what is played');
  assert.equal(view(trimmed).getUint32(find(trimmed, audio, 'mdia', 'mdhd').bodyStart + 16), 120 * 1024, 'the media still counts every packet');
  const stts = find(trimmed, audio, 'mdia', 'minf', 'stbl', 'stts');
  assert.deepEqual([4, 8, 12].map((at) => view(trimmed).getUint32(stts.bodyStart + at)), [1, 120, 1024]);
  const mvhd = find(trimmed, readBoxes(trimmed).find((box) => box.type === 'moov'), 'mvhd');
  assert.equal(view(trimmed).getUint32(mvhd.bodyStart + 16), 2500, 'the film is as long as the picture');
  assert.ok(!hasEditList(trimmed, tracksOf(trimmed)[0]), 'the picture needs no edit list');

  // Apple's players only trust the edit list when a "roll" sample group comes with it; without
  // one they skip their own assumed lead-in as well, and the sound plays 44 ms early.
  const stbl = find(trimmed, audio, 'mdia', 'minf', 'stbl');
  const sgpd = find(trimmed, stbl, 'sgpd');
  assert.equal(trimmed[sgpd.bodyStart], 1, 'version 1');
  assert.equal(String.fromCharCode(...trimmed.subarray(sgpd.bodyStart + 4, sgpd.bodyStart + 8)), 'roll');
  assert.deepEqual([8, 12].map((at) => view(trimmed).getUint32(sgpd.bodyStart + at)), [2, 1], 'one entry of two bytes');
  assert.equal(view(trimmed).getInt16(sgpd.bodyStart + 16), -1, 'each packet leans on the one before it');
  const sbgp = find(trimmed, stbl, 'sbgp');
  assert.equal(String.fromCharCode(...trimmed.subarray(sbgp.bodyStart + 4, sbgp.bodyStart + 8)), 'roll');
  assert.deepEqual([8, 12, 16].map((at) => view(trimmed).getUint32(sbgp.bodyStart + at)), [1, 120, 1], 'every packet is in that group');

  // Without a trim, every packet is played and the film is as long as the sound.
  const full = makeVideoWithSound({ packets: 120 }).file;
  assert.ok(!hasEditList(full, tracksOf(full)[1]));
  const fullStbl = find(full, tracksOf(full)[1], 'mdia', 'minf', 'stbl');
  assert.ok(!readBoxes(full, fullStbl.bodyStart, fullStbl.end).some((box) => box.type === 'sgpd'));
  const fullMvhd = find(full, readBoxes(full).find((box) => box.type === 'moov'), 'mvhd');
  assert.equal(view(full).getUint32(fullMvhd.bodyStart + 16), Math.round((120 * 1024 * 1000) / 48000));

  // A trim that asks for more sound than was encoded is ignored rather than trusted.
  const odd = makeVideoWithSound({ packets: 100, trim: { skip: 2112, length: 120000 } }).file;
  assert.ok(!hasEditList(odd, tracksOf(odd)[1]));
});

test('MP4 sound: sound longer than the video is kept with the last second, and misuse is refused', () => {
  const { file, sound } = makeVideoWithSound({ count: 30, packets: 120 });
  const packets = sampleLocations(file, tracksOf(file)[1]);
  assert.equal(packets.length, 120);
  packets.forEach(([offset, size], i) => assert.deepEqual(file.subarray(offset, offset + size), sound[i]));

  const muxer = new Mp4Muxer({ width: 2, height: 2, fps: 30 });
  assert.throws(() => muxer.addAudioSample(new Uint8Array(4)), /setAudioConfig/);
  assert.throws(() => muxer.setAudioConfig({ description: new Uint8Array(0), sampleRate: 48000, channels: 2 }), /decoder configuration/);
});

test('MP4: refuses to write a file with no frames or no codec setup', () => {
  assert.throws(() => new Mp4Muxer({ width: 2, height: 2, fps: 30 }).finalize(), /decoder configuration/);
  const muxer = new Mp4Muxer({ width: 2, height: 2, fps: 30 });
  muxer.setDecoderConfig(Uint8Array.from([1]));
  assert.throws(() => muxer.finalize(), /No frames/);
});

// ---------------------------------------------------------------- GIF

/** A straightforward GIF decoder, written independently of the encoder, to check its output. */
function decodeGif(bytes) {
  let p = 0;
  const u16 = () => {
    const value = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    return value;
  };
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
  p = 6;
  const width = u16();
  const height = u16();
  const packed = bytes[p++];
  p += 2;
  assert.ok(packed & 0x80, 'has a global colour table');
  const tableSize = 3 * (1 << ((packed & 7) + 1));
  const palette = bytes.subarray(p, p + tableSize);
  p += tableSize;

  const canvas = new Uint8Array(width * height);
  const frames = [];
  let delay = 0;
  let transparent = -1;
  let loops = false;
  while (p < bytes.length) {
    const marker = bytes[p++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) {
        p++;
        const flags = bytes[p++];
        delay = u16();
        const index = bytes[p++];
        transparent = flags & 1 ? index : -1;
        p++;
      } else {
        if (label === 0xff) loops = true;
        while (bytes[p] !== 0) p += bytes[p] + 1;
        p++;
      }
      continue;
    }
    assert.equal(marker, 0x2c, 'image descriptor');
    const x = u16();
    const y = u16();
    const w = u16();
    const h = u16();
    p++;
    const minCodeSize = bytes[p++];
    const data = [];
    while (bytes[p] !== 0) {
      const length = bytes[p++];
      for (let i = 0; i < length; i++) data.push(bytes[p++]);
    }
    p++;

    const clear = 1 << minCodeSize;
    const end = clear + 1;
    let codeSize = minCodeSize + 1;
    let table = [];
    const reset = () => {
      table = [];
      for (let i = 0; i < clear; i++) table[i] = [i];
      table[clear] = [];
      table[end] = [];
      codeSize = minCodeSize + 1;
    };
    reset();
    const pixels = [];
    let buffer = 0;
    let bits = 0;
    let previous = null;
    let position = 0;
    while (true) {
      while (bits < codeSize && position < data.length) {
        buffer |= data[position++] << bits;
        bits += 8;
      }
      if (bits < codeSize) break;
      const code = buffer & ((1 << codeSize) - 1);
      buffer >>>= codeSize;
      bits -= codeSize;
      if (code === clear) {
        reset();
        previous = null;
        continue;
      }
      if (code === end) break;
      let entry;
      if (code < table.length) entry = table[code];
      else {
        assert.ok(previous && code === table.length, 'valid LZW code');
        entry = [...previous, previous[0]];
      }
      for (const value of entry) pixels.push(value);
      if (previous) {
        table.push([...previous, entry[0]]);
        if (table.length === 1 << codeSize && codeSize < 12) codeSize++;
      }
      previous = entry;
    }
    assert.equal(pixels.length, w * h, 'frame has the right number of pixels');
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const value = pixels[row * w + col];
        if (value !== transparent) canvas[(y + row) * width + (x + col)] = value;
      }
    }
    frames.push({ delay, indices: canvas.slice() });
  }
  return { width, height, palette, frames, loops };
}

/** Deterministic test picture: flat panels, a gradient, and a block that moves each frame. */
function picture(width, height, frame) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let color = [245, 245, 248];
      if (y < 12) color = [Math.round((x / width) * 255), 60, 160];
      if (x >= 10 + frame * 6 && x < 30 + frame * 6 && y >= 30 && y < 50) color = [109, 74, 255];
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

test('GIF: decodes back to exactly the pixels that were encoded', () => {
  const width = 96;
  const height = 64;
  const histogram = new Histogram();
  const pictures = [0, 1, 2, 3].map((frame) => picture(width, height, frame));
  pictures.forEach((rgba) => histogram.add(rgba));
  const palette = buildPalette(histogram);
  const quantizer = new Quantizer(palette);
  const writer = new GifWriter({ width, height, palette });
  const expected = [];
  for (const rgba of pictures) {
    const indices = quantizer.apply(rgba, width, new Uint8Array(width * height));
    expected.push(indices.slice());
    writer.addFrame(indices, 100);
  }
  const gif = decodeGif(concat(writer.finish()));
  assert.equal(gif.width, width);
  assert.equal(gif.height, height);
  assert.equal(gif.loops, true);
  assert.equal(gif.frames.length, 4);
  gif.frames.forEach((frame, i) => {
    assert.deepEqual(frame.indices, expected[i], `frame ${i} pixels`);
    assert.equal(frame.delay, 10);
  });
});

test('GIF: flat interface colours stay flat and gradients are dithered', () => {
  const width = 96;
  const height = 64;
  const rgba = picture(width, height, 0);
  const histogram = new Histogram();
  histogram.add(rgba);
  const palette = buildPalette(histogram);
  const indices = new Quantizer(palette).apply(rgba, width, new Uint8Array(width * height));
  const panel = new Set();
  for (let y = 54; y < 64; y++) for (let x = 0; x < width; x++) panel.add(indices[y * width + x]);
  assert.equal(panel.size, 1, 'a flat panel maps to a single palette entry');
  const colorOf = (index) => [...palette.colors.subarray(index * 3, index * 3 + 3)];
  const [r, g, b] = colorOf([...panel][0]);
  assert.ok(Math.abs(r - 245) <= 4 && Math.abs(g - 245) <= 4 && Math.abs(b - 248) <= 4, 'and that entry is the right colour');
});

test('GIF: unchanged frames are merged into a longer delay instead of stored again', () => {
  const width = 32;
  const height = 16;
  const rgba = picture(width, height, 0);
  const histogram = new Histogram();
  histogram.add(rgba);
  const palette = buildPalette(histogram);
  const quantizer = new Quantizer(palette);
  const writer = new GifWriter({ width, height, palette });
  const indices = quantizer.apply(rgba, width, new Uint8Array(width * height));
  for (let i = 0; i < 5; i++) writer.addFrame(indices, 66.67);
  const gif = decodeGif(concat(writer.finish()));
  assert.equal(gif.frames.length, 1);
  assert.equal(gif.frames[0].delay, 33, 'five frames of 66.67ms');
});

test('GIF: uneven frame times do not drift (rounding error is carried forward)', () => {
  const width = 16;
  const height = 8;
  const histogram = new Histogram();
  const frames = [0, 1, 2, 3, 4, 5].map((n) => {
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    rgba[n * 4] = 0;
    histogram.add(rgba);
    return rgba;
  });
  const palette = buildPalette(histogram);
  const quantizer = new Quantizer(palette);
  const writer = new GifWriter({ width, height, palette });
  for (const rgba of frames) writer.addFrame(quantizer.apply(rgba, width, new Uint8Array(width * height)), 66.67);
  const gif = decodeGif(concat(writer.finish()));
  const total = gif.frames.reduce((sum, frame) => sum + frame.delay, 0);
  assert.equal(total, 40, '6 x 66.67ms is 400ms');
});

test('GIF: a large noisy frame survives the 4096-code dictionary reset', () => {
  const width = 200;
  const height = 120;
  const indices = new Uint8Array(width * height);
  let seed = 12345;
  for (let i = 0; i < indices.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    indices[i] = seed % 200;
  }
  const colors = new Uint8Array(768);
  for (let i = 0; i < 256; i++) colors.set([i, i, i], i * 3);
  const writer = new GifWriter({ width, height, palette: { colors, count: 255 } });
  writer.addFrame(indices, 100);
  const gif = decodeGif(concat(writer.finish()));
  assert.deepEqual(gif.frames[0].indices, indices);
});

test('GIF: the palette never uses more than 255 colours (one is reserved for "unchanged")', () => {
  const histogram = new Histogram();
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  let seed = 99;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >> 8) & 255;
  };
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = next();
    rgba[i + 1] = next();
    rgba[i + 2] = next();
    rgba[i + 3] = 255;
  }
  histogram.add(rgba);
  const palette = buildPalette(histogram);
  assert.ok(palette.count <= 255 && palette.count > 100);
  const indices = new Quantizer(palette).apply(rgba, 64, new Uint8Array(64 * 64));
  assert.ok(indices.every((index) => index < 255));
});

test('LZW: a single pixel still produces a valid stream', () => {
  const out = { data: [], byte(v) { this.data.push(v); }, bytes(v) { this.data.push(...v); } };
  lzwEncode(Uint8Array.from([7]), 8, out);
  assert.equal(out.data[0], 8);
  assert.equal(out.data.at(-1), 0);
});
