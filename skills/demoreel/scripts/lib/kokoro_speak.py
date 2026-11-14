"""Speaks lines with the Kokoro voice model. Run by voice.mjs, from the Python environment
that "demoreel voice install" sets up; it is not meant to be run by hand.

    python kokoro_speak.py job.json

job.json is either
    { "model": path, "voices": path, "voice": name, "speed": 1.0,
      "lines": [ { "text": "...", "out": "line.wav" } ] }
or  { "model": path, "voices": path, "list": true }     to print the voice names as JSON.

Each line is written as a 16-bit mono WAV file.
"""

import json
import sys
import wave

import numpy
from kokoro_onnx import Kokoro

# Voice names start with a letter for the language they speak.
LANGUAGES = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "p": "pt-br"}

with open(sys.argv[1], encoding="utf-8") as handle:
    job = json.load(handle)

kokoro = Kokoro(job["model"], job["voices"])
names = sorted(kokoro.get_voices())

if job.get("list"):
    print(json.dumps(names))
    sys.exit(0)

voice = job["voice"]
if voice not in names:
    english = " ".join(name for name in names if name[0] in "ab")
    sys.exit(f'There is no voice called "{voice}". English voices: {english}')

for line in job["lines"]:
    samples, rate = kokoro.create(
        line["text"], voice=voice, speed=job.get("speed", 1.0), lang=LANGUAGES.get(voice[0], "en-us")
    )
    pcm = (numpy.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(line["out"], "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())
