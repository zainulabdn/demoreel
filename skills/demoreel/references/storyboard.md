# Storyboard reference

A storyboard is one JSON file. It says which app to open, what to do in it, and how the video should look. Only `steps` and one of `url` or `serve` are required.

```json
{
  "url": "http://localhost:5173",
  "displayUrl": "acme.app",
  "viewport": "desktop",
  "style": { "background": "dusk", "frame": "browser", "zoom": 1.6 },
  "sound": { "voice": true },
  "output": { "size": "1080p", "formats": ["mp4", "gif"] },
  "steps": [
    { "say": "Start a project in seconds" },
    { "click": "New project" }
  ]
}
```

## Contents

- [Where the app comes from](#where-the-app-comes-from)
- [Steps](#steps)
- [Targets: how elements are found](#targets-how-elements-are-found)
- [Keys](#keys)
- [Page setup](#page-setup)
- [Style](#style)
- [Sound](#sound)
- [Output](#output)
- [Secrets](#secrets)

## Where the app comes from

| Option | Use it when | Example |
|---|---|---|
| `url` | The app is already running, or is a public site. | `"url": "http://localhost:3000"` |
| `serve` | The app is a folder of static files. Demoreel serves it on a free local port. Unknown routes fall back to `index.html`. | `"serve": "./dist"` |
| `start` + `url` | Demoreel should start the dev server itself and wait for `url` to answer. If something already answers at `url`, nothing is started. | `"start": "npm run dev"` |

`start` may also be an object: `{ "command": "npm run dev", "cwd": "./web", "timeout": 90000 }`. Paths are relative to the storyboard file. With `serve`, `url` is optional and is treated as a path, for example `"url": "/pricing"`.

## Steps

Each step is an object with exactly one action. Every step also accepts `"pause": <ms>` (extra wait after it) and `"note": "..."` (ignored, for your own comments).

| Action | Value | Options | What happens |
|---|---|---|---|
| `click` | target | `nth`, `zoom`, `timeout`, `optional` | Scrolls the target into view if needed, moves the cursor to it and clicks. Waits for the page to settle. |
| `hover` | target | `nth`, `zoom`, `timeout`, `optional` | Moves the cursor to the target and rests there. |
| `type` | text | `into`, `clear`, `speed`, `nth`, `zoom`, `timeout`, `optional` | With `into`, clicks that field first. Without it, types into the field that has focus. `"clear": true` empties the field first. `"speed": 2` types twice as fast. |
| `press` | key | | Presses a key or shortcut. See [Keys](#keys). |
| `select` | option text | `in` (required), `nth`, `zoom`, `timeout` | Picks an option in a native `<select>`. For custom dropdowns use two `click` steps. |
| `scroll` | pixels, `"top"`, `"bottom"` or a target | `nth`, `timeout` | Scrolls smoothly. A negative number scrolls up. A target is scrolled to the middle of the page. |
| `drag` | target | `to` (required), `nth`, `timeout` | Presses on the target, drags to the `to` target and releases. |
| `goto` | path or URL | | Opens another page. Paths are relative to `url`. |
| `wait` | milliseconds | | Does nothing for that long. |
| `waitFor` | target | `nth`, `timeout` | Waits until the target is on the page. Default limit 15 seconds. |
| `say` | caption text | `for`, `speak`, `audio` | Shows a caption. It stays until the next `say`, or for `for` milliseconds. `""` removes it. With a voice turned on, the caption is also spoken: see [Sound](#sound). |
| `zoom` | target or `"out"` | `level`, `nth`, `timeout` | Points the camera at something without acting on it, or pulls back to the whole page. |
| `eval` | JavaScript | | Runs code in the page. The code is an async function body, so `await` works. Use it for setup: seeding `localStorage`, dismissing something, jumping to a state. |

Options, in detail:

| Option | Meaning |
|---|---|
| `nth` | Which match to use when several elements share a name, counting from 1 in page order. |
| `zoom` | `false` keeps the camera wide for this step. A number such as `2` sets the zoom level for this step. |
| `timeout` | How long to wait for the target, in milliseconds. Default 8000. |
| `optional` | `true` skips the step quietly if the target is not found within 1.5 seconds. For cookie banners and one-time tips. |

## Targets: how elements are found

A target is a string. By default it is a **name**: what a person would call the element.

```json
{ "click": "New project" }
{ "type": "ada@example.com", "into": "Email" }
```

Names are matched against, in this order of trust: `aria-label`, the text of an associated `<label>`, `placeholder`, the element's visible text, `title`, `alt`, and `data-testid`. An exact match beats a partial one ("Save" picks the Save button, not "Save draft"). Matching ignores case. Only visible, enabled elements are considered, and clickable ones are preferred. Text inside a clickable card resolves to the card. Open shadow DOM is searched.

When a name is not enough, use a prefix:

| Form | Finds | Example |
|---|---|---|
| `css=<selector>` | Any CSS selector. A target starting with `#`, `.` or `[` is treated as CSS without the prefix. | `"css=.sidebar a:last-child"`, `"#save"` |
| `testid=<id>` | `data-testid`, `data-test-id` or `data-test`, exact. | `"testid=submit-order"` |
| `text=<text>` | The element containing that text itself, not its clickable parent. | `"text=Total"` |
| `label=<text>` | A form field by its label. | `"label=Email"` |
| `placeholder=<text>` | A form field by its placeholder. | `"placeholder=Search"` |

A CSS target can reach controls that are present but transparent, such as the hidden native checkbox behind a styled one.

When a target is not found, the error lists close matches and what is on screen. Use those exact names.

## Keys

`press` takes a key name or a shortcut joined with `+`.

- Named keys: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`.
- Any single character: `a`, `7`, `/`, `?`.
- Modifiers: `Shift`, `Control`, `Alt`, `Meta`, and `Mod`, which is `Meta` on macOS and `Control` elsewhere. Use `Mod` for app shortcuts so the storyboard works on every machine.
- Also accepted: `Esc`, `Return`, `Cmd`, `Ctrl`, `Option`, `Up`, `Down`, `Left`, `Right`.

Examples: `"Mod+K"`, `"Shift+Tab"`, `"Control+Shift+P"`.

## Page setup

| Option | Default | Meaning |
|---|---|---|
| `viewport` | `"desktop"` | Size of the page being recorded. A preset or `{ "width": 1200, "height": 750 }`. |
| `scale` | `2` (`3` for `phone`) | Pixel density of the capture. Higher is sharper when zoomed, and slower. |
| `theme` | none | `"light"` or `"dark"`: what the app sees as the system colour scheme. |
| `pace` | `1` | Speed of the performance. `1.3` is calmer, `0.8` is brisker. |
| `hide` | `[]` | CSS selectors to hide for the whole recording, for example a chat widget or cookie banner. |
| `displayUrl` | the real host | The address shown in the browser bar, for example `"acme.app"` instead of `localhost:5173`. The path still follows the real page. |
| `seed` | from the steps | A number that fixes the small variations in cursor paths and typing rhythm. |

Viewport presets:

| Name | Size | Notes |
|---|---|---|
| `desktop` | 1280 x 720 | Fills a 16:9 video best. |
| `tall` | 1280 x 800 | |
| `laptop` | 1440 x 900 | Shows more of the app, with smaller text. |
| `wide` | 1600 x 900 | For dense dashboards. |
| `tablet` | 820 x 1180 | Mobile browser behaviour. |
| `phone` | 390 x 844 | Mobile browser behaviour, phone frame by default. |

A smaller viewport makes the app look larger in the video. If text is hard to read on the contact sheet, shrink the viewport before raising the zoom.

Developer overlays from Next.js, Astro, Nuxt, TanStack Query, Vue devtools and the webpack dev server are hidden automatically.

## Style

```json
"style": {
  "background": "ocean",
  "frame": "browser",
  "zoom": 1.6,
  "padding": 0.06,
  "radius": 14,
  "shadow": true,
  "chrome": "auto",
  "cursor": { "size": 1, "kind": "auto" },
  "captions": { "size": 1 }
}
```

| Option | Default | Meaning |
|---|---|---|
| `background` | `"dusk"` | A preset, one colour (`"#0f172a"`), or a list of colours for a gradient (`["#0f172a", "#7c3aed"]`). |
| `frame` | `"browser"` | `"browser"` (title bar with address), `"window"` (rounded corners only), `"phone"` (device bezel), `"none"` (the page fills the picture). |
| `zoom` | `1.6` | How far the camera zooms in on actions. `1` or `false` turns zooming off. Up to `4`. |
| `padding` | `0.06` | Space around the window, as a fraction of the picture's shorter side. |
| `radius` | `14` | Corner radius of the window, in pixels at 1080p. |
| `shadow` | `true` | Shadow under the window. |
| `chrome` | `"auto"` | Colour of the browser bar: `"auto"` follows the top of the page, or force `"light"` or `"dark"`. |
| `cursor.size` | `1` | Cursor size multiplier. `cursor.hidden: true` removes the cursor. |
| `cursor.kind` | `"auto"` | `"arrow"` is a mouse cursor, `"touch"` is a finger-sized dot. `"auto"` uses the dot for `phone` and `tablet` viewports. |
| `captions.size` | `1` | Caption size multiplier. |

Background presets: `dusk` (purple to rose), `ocean` (navy to teal), `ember` (brown to orange), `forest` (green), `slate` (dark grey), `lilac` (light purple), `sky` (light blue), `paper` (warm white). Dark presets suit light apps and the reverse.

## Sound

A video is silent unless the storyboard has `sound`. Sound goes into the MP4; a GIF has none.

```json
"sound": {
  "voice": true,
  "effects": true,
  "music": "./music.mp3",
  "pronounce": { "Demoreel": "Demo reel" }
}
```

`"sound": true` is short for a voice plus click sounds.

| Option | Default | Meaning |
|---|---|---|
| `voice` | off | `true` speaks every caption with the best voice on this machine. Or name one: `"natural"`, `"system"`, or an object (below). |
| `effects` | `true` | Click and typing sounds, placed on each click and key press. `false` turns them off; a number sets their volume (`0.5` is half, up to `3`). |
| `music` | none | A sound file (MP3, WAV, M4A, OGG), relative to the storyboard. It is cut or repeated to fit the video, faded in and out, and lowered while the voice speaks. `{ "file": "./music.mp3", "volume": 0.6 }` makes it quieter. |
| `pronounce` | none | Words the voice gets wrong, and how to say them. Whole words only. The caption and the subtitles keep the real spelling. |

### The voice

With a voice on, each `say` step is spoken as well as shown, and **the recording waits for the voice**: a line starts as its caption appears, the steps after it carry on while it is being said, and the next line does not start until this one has finished. The video never ends in the middle of a sentence. So the spoken lines set the pace; you do not add `wait` steps for them.

There are three voices:

| Voice | What it is | To use it |
|---|---|---|
| `"natural"` | Kokoro, a free voice model that runs on this machine. Sounds like a person. English, American and British, men and women. | It is not part of Demoreel. Install it once: `demoreel voice install` (a download of about 400 MB, 510 MB on disk, needs Python 3.10 to 3.13). |
| `"system"` | The voice the computer already has: `say` on macOS, the speech synthesizer on Windows, `espeak-ng` on Linux. | Nothing to install on macOS and Windows. It sounds like a computer. |
| your own command | Any text-to-speech program. | `"voice": { "command": "piper --model en.onnx --output_file {out}" }` |

`"voice": true` uses the natural voice when it is installed and the system voice otherwise, and says which one it used.

As an object:

```json
"voice": { "engine": "natural", "name": "bm_george", "speed": 0.95 }
```

| Option | Meaning |
|---|---|
| `engine` | `"auto"` (the default), `"natural"` or `"system"`. |
| `name` | Which voice. `demoreel voice` lists the names on this machine. Natural voices are named like `af_heart` (American woman), `am_michael` (American man), `bf_emma` and `bm_george` (British). Without `engine`, the name decides it. |
| `speed` | `1` is normal, `0.5` to `2`. |
| `command` | Use a program of your own instead. It is run once per line, without a shell. `{out}` is replaced with the path it must write a sound file to. The words arrive on standard input, or in place of `{text}` if you write that. `{voice}` and `{speed}` are replaced with `name` and `speed`. |

Hear a voice before using it:

```
node <skill>/scripts/demoreel.mjs voice
node <skill>/scripts/demoreel.mjs voice try "Your next demo is one sentence away." --voice bm_george
```

### What a caption says

By default a caption is spoken exactly as written. Three options on a `say` step change that:

```json
{ "say": "Start a project in seconds", "speak": "This is Lumen. A new project takes a few seconds." }
{ "say": "Works offline", "speak": false }
{ "say": "Built by two people", "audio": "./voice/intro.m4a" }
```

| Option | Meaning |
|---|---|
| `speak` | The words to say, when they should differ from the caption: a short headline on screen, a full sentence out loud. `false` shows the caption without saying anything. |
| `audio` | A clip you recorded, played instead of a generated voice. The recording waits for it the same way. A storyboard can use only clips, and then needs no voice at all. |

Lines are kept between runs: recording again only speaks the lines whose words or voice changed.

### How it is mixed

Every spoken line is brought to the same loudness. Music sits under the voice and drops further while a line is spoken. The finished soundtrack is set to -16 LUFS, the level phones and social sites expect, with peaks held under -1 dB. It is encoded as AAC by the browser. On a machine whose browser cannot encode AAC (most Linux installs), ffmpeg is used if it is installed; without it the MP4 is silent, the soundtrack is saved next to it as a WAV file, and a note says so. `doctor` tells you which case you are in.

## Output

```json
"output": {
  "size": "1080p",
  "fps": 30,
  "formats": ["mp4", "gif"],
  "quality": "high",
  "maxMB": 9.5,
  "dir": "./docs",
  "gif": { "width": 960, "fps": 15 }
}
```

| Option | Default | Meaning |
|---|---|---|
| `size` | `"1080p"` | A preset or `{ "width": 1600, "height": 900 }`. |
| `fps` | `30` | 24, 25, 30, 50 or 60. |
| `formats` | `["mp4", "gif"]` | Which files to make: any of `"mp4"`, `"gif"` and `"srt"`. `"srt"` writes a subtitle file with the spoken lines, or with the captions when nothing is spoken. |
| `quality` | `"high"` | MP4 bitrate: `"high"`, `"medium"` or `"small"`. Interface video compresses well, so even `"small"` keeps text sharp. |
| `maxMB` | `9.5` | Keep the MP4 under this many megabytes by lowering the bitrate for longer videos. The default fits GitHub's 10 MB limit for videos in READMEs and issues. `0` removes the limit. |
| `dir` | the storyboard's folder | Where files are written. |
| `gif.width` | `960` (`540` for tall videos) | GIF width in pixels. Lower it to shrink the file. |
| `gif.fps` | `15` | GIF frame rate. |
| `name` (top level) | the file name | Base name of the output files. `demo.reel.json` gives `demo.mp4`. |

Size presets:

| Name | Pixels | Good for |
|---|---|---|
| `1080p` | 1920 x 1080 | READMEs, X, YouTube |
| `720p` | 1280 x 720 | Smaller files |
| `1440p` | 2560 x 1440 | High-density displays |
| `square` | 1080 x 1080 | LinkedIn, Instagram feed |
| `portrait` | 1080 x 1350 | Instagram and LinkedIn feed, taller |
| `vertical` | 1080 x 1920 | Reels, Shorts, TikTok, Stories |

Files written: `<name>.mp4` (H.264, plays everywhere, with AAC sound when the storyboard has `sound`), `<name>.gif` (loops, embeds in a README), `<name>.poster.png` (a still for thumbnails), `<name>.sheet.png` (the contact sheet for checking the video) and, when asked for, `<name>.srt` (subtitles to upload with the video on LinkedIn or YouTube).

## Secrets

Write `${env:NAME}` in a `url`, `goto`, `type`, `say` or `eval` value and it is replaced with that environment variable when the storyboard runs. The value never appears in logs, step labels or the contact sheet. Password fields show dots in the video as usual.

```json
{ "type": "${env:DEMO_PASSWORD}", "into": "Password" }
```

```
DEMO_PASSWORD=... node <skill>/scripts/demoreel.mjs record demo.reel.json
```

If the variable is not set, the run stops with an error instead of typing an empty value.
