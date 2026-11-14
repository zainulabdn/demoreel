// Turns a recording's timeline into the list of sounds the soundtrack is made of, and into
// subtitles. Pure functions: no I/O.

import { clamp } from './util.mjs';

export const AUDIO_SAMPLE_RATE = 48000;
/** Bits per second of the AAC sound track. Plenty for a voice over music. */
export const AUDIO_BITRATE = 128000;

/**
 * What the soundtrack contains: spoken lines, clicks and key presses, and music.
 * Returns null when the video has no sound.
 *
 * @param {object} timeline    written by the recording pass
 * @param {object} storyboard  normalized storyboard
 * @param {number} durationMs  length of the finished video
 */
export function buildAudioPlan(timeline, storyboard, durationMs) {
  const sound = storyboard.sound;
  if (!sound || !storyboard.output.formats.includes('mp4')) return null;

  const voice = (timeline.voice || [])
    .filter((line) => line.t < durationMs)
    .map((line) => ({ t: line.t, url: line.file, skip: line.skip, duration: line.duration }));

  const effects = [];
  if (sound.effects > 0) {
    const width = timeline.viewport?.width || 1;
    // On a phone a tap is a soft touch, not a mouse button.
    const press = timeline.viewport?.mobile ? 'tap' : 'click';
    for (const click of timeline.clicks || []) {
      // A click on the left of the page is heard slightly to the left.
      effects.push({ at: click.t / 1000, kind: press, pan: Math.round(clamp((click.x / width - 0.5) * 0.7, -0.35, 0.35) * 100) / 100 });
    }
    for (const key of timeline.keys || []) effects.push({ at: key.t / 1000, kind: key.kind });
    effects.sort((a, b) => a.at - b.at);
  }

  const music = sound.music ? { url: 'music', volume: sound.music.volume } : null;
  if (!voice.length && !effects.length && !music) return null;
  return {
    sampleRate: AUDIO_SAMPLE_RATE,
    bitrate: AUDIO_BITRATE,
    durationMs,
    voice,
    effects,
    effectsVolume: sound.effects,
    music,
    seed: storyboard.seed ?? 1,
  };
}

/**
 * The lines of a subtitle file: what is spoken when the video has a voice, otherwise the captions.
 * @returns {Array<{start:number, end:number, text:string}>} times in milliseconds
 */
export function subtitleCues(timeline) {
  const spoken = (timeline.voice || []).filter((line) => line.text);
  const cues = spoken.length
    ? spoken.map((line) => ({ start: line.t, end: line.t + line.duration + 300, text: line.text }))
    : (timeline.captions || []).filter((caption) => caption.text).map((caption) => ({ start: caption.t0, end: caption.t1, text: caption.text }));
  cues.sort((a, b) => a.start - b.start);
  return cues
    .map((cue, index) => {
      const next = cues[index + 1];
      const limit = Math.min(next ? next.start - 40 : Infinity, timeline.duration ?? Infinity);
      return { ...cue, start: Math.max(0, Math.round(cue.start)), end: Math.round(Math.min(cue.end, limit)) };
    })
    .filter((cue) => cue.end > cue.start);
}

const stamp = (ms) => {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** Write cues as an .srt file, the subtitle format LinkedIn, YouTube and video players accept. */
export function toSrt(cues) {
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text.replace(/\s*\n\s*/g, ' ')}\n`).join('\n');
}
