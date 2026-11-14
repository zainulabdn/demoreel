---
name: demoreel
description: "Record a polished demo video (MP4 and GIF) of a real, running web app: smooth cursor, automatic zoom on each action, captions, a browser or phone frame and a designed background, and optionally a spoken voice-over with click sounds and music. You write a short storyboard of plain-language steps (click \"New project\", type into \"Email\"), Demoreel drives the app in a headless browser and renders the video. Use whenever the user wants a demo video, product demo, walkthrough, screen recording, launch or teaser clip, a narrated or voice-over video, a GIF for a README, or to show how an app or feature works, even if they only say \"make a GIF of this\" or \"record this flow\". Works on web apps that render ordinary HTML (React, Next.js, Vue, Svelte, plain HTML). Not for native mobile or desktop apps."
license: MIT
compatibility: "Needs Node.js 20 or newer and a Chromium-based browser (Google Chrome, Microsoft Edge or Brave). No other dependencies and nothing to install. The natural voice for voice-overs is an optional one-time download that needs Python 3.10 to 3.13."
metadata:
  version: "0.2.0"
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/demoreel.mjs *)
---

# Demoreel

You are making a short demo video of the user's real app. The viewer is someone scrolling past it on GitHub, X or LinkedIn with the sound off, deciding in a few seconds whether the app is worth a closer look. A good result shows one thing the app does well, clearly, in 15 to 40 seconds.

You write the storyboard and judge the result. Demoreel does the recording: it opens the app in a headless browser, performs each step with a natural cursor, and renders the footage with zoom, captions and a frame, and with a voice-over when the storyboard asks for one.

## The command

Everything goes through one script. It needs only Node and a Chromium-based browser already on the machine.

```
node ${CLAUDE_SKILL_DIR}/scripts/demoreel.mjs <command>
```

If `${CLAUDE_SKILL_DIR}` appears above as literal text, your agent did not fill it in: use the folder that contains this SKILL.md.

| Command | What it does |
|---|---|
| `check <storyboard>` | Runs the steps fast, with no video. Reports which step fails and why, and saves a screenshot after every step. Takes a few seconds. |
| `record <storyboard>` | Records and renders. Writes `<name>.mp4`, `<name>.gif`, `<name>.poster.png` and `<name>.sheet.png` next to the storyboard. |
| `render <dir>` | Re-renders a recording kept with `record --keep`, with a new style, without recording again. |
| `doctor` | Checks that this machine can record, and which voices it has. Run it first if anything fails to start. |
| `voice` | Lists the voices on this machine. `voice try "<words>" --voice <name>` speaks a line to a sound file. `voice install` downloads the natural voice: ask the user before running it. |

Useful flags: `--out <dir>`, `--formats mp4,gif`, `--keep`, `--json`.

## How to work

### 1. Decide what the video is about

One video, one idea. Ask yourself what the single most convincing thing this app does is, and build the video around it. If the user named a feature or flow, that is the subject. If they said only "make a demo", pick the core flow yourself (the thing the README's first sentence promises) and say which one you picked. Do not ask the user to choose unless the app has several unrelated products.

### 2. Get the app running, and learn its real labels

Find how the app starts (`package.json` scripts, a README, a `dist/` folder). Then choose one:

- Already running or you can start it yourself: set `"url"`.
- A static site or a built folder: set `"serve": "./dist"` and Demoreel serves it.
- You want the recording to be repeatable later: set `"start": "npm run dev"` with `"url"`, and Demoreel starts it and waits.

Steps target elements by the words a person sees: button text, a field's label or placeholder, an `aria-label`. Read the components for the flow you chose and copy the labels exactly. Guessing wastes a round trip.

The video should open on a state worth looking at. An empty first-run screen or a login wall is a weak opening. If the app needs data or a signed-in session, set that up before the visible part: use the app's seed script, or an `eval` step that writes to `localStorage`, or sign in with a test account at the start. Put passwords and tokens in environment variables and refer to them as `${env:NAME}`; never write a real secret into the storyboard.

### 3. Write the storyboard

Save it as `demo.reel.json` in the project root, unless the user wants it elsewhere.

```json
{
  "url": "http://localhost:5173",
  "displayUrl": "acme.app",
  "steps": [
    { "say": "Start a project in seconds" },
    { "click": "New project" },
    { "type": "Website launch", "into": "Project name" },
    { "click": "Create project" },
    { "say": "Add tasks as fast as you can type" },
    { "type": "Write the announcement post", "into": "Add a task" },
    { "press": "Enter" }
  ]
}
```

The steps you will use most:

| Step | Meaning |
|---|---|
| `{ "click": "New project" }` | Move the cursor there and click. |
| `{ "type": "hello", "into": "Email" }` | Click the field, then type. Leave out `into` to keep typing in the focused field. |
| `{ "press": "Enter" }` | A key or shortcut. `"Mod+K"` is Cmd on macOS and Ctrl elsewhere. |
| `{ "say": "One short line" }` | A caption. It stays until the next `say`. `{ "say": "" }` clears it. |
| `{ "hover": "Chart" }`, `{ "scroll": 600 }`, `{ "scroll": "Pricing" }` | Hover, scroll by pixels, or scroll something into view. |
| `{ "wait": 800 }`, `{ "waitFor": "Report ready" }` | Pause, or wait for something to appear. |
| `{ "goto": "/settings" }` | Open another page. |

Targets are matched against visible names, exact match first. When a name is ambiguous add `"nth": 2`, or use a selector: `"css=.sidebar button"`, `"#save"`, `"testid=submit"`. Add `"optional": true` to a step that may have nothing to act on, such as dismissing a cookie banner.

The full list of steps, options, styles, sizes and frames is in [references/storyboard.md](references/storyboard.md). Read it before using anything not shown here.

### 4. Check, then record

Run `check` first. It is fast and tells you exactly what is wrong:

```
Step 4 (click "Creat project") failed: Could not find "Creat project" to click.
  Did you mean: "Create project"?
  On screen now: "Cancel", "Create project", "Project name"
  Screenshot of the page at that moment: /tmp/demoreel/demo-check/step-04-failed.jpg
```

Fix the step and run `check` again until every step passes. Then open two or three of the saved step screenshots and confirm the steps did what you meant, not just that they found something to click.

Then run `record`.

### 5. Look at the result before you report it

`record` writes a contact sheet, `<name>.sheet.png`: one frame from the end of every step, with the step and its time under it. Open it and look at every frame. This is how you watch your own video.

Check each frame for:

- **Framing.** Is the thing the step is about in view and readable? If the camera is zoomed on the wrong area, or a dialog is cut off, add `"zoom": false` to that step, or a `{ "zoom": "out" }` step before it.
- **Truth.** Does the frame show the app working? Look for error messages, empty states, spinners that never finished, placeholder text.
- **Captions.** Does the caption on that frame describe what is happening in it?
- **The last frame.** It should be the best-looking state of the app, held long enough to read. Add `"pause": 1500` to the last step if it ends abruptly.

Fix the storyboard and record again. Two or three rounds is normal. Stop when the sheet looks right; do not keep polishing a video that already works.

### 6. Hand it over

Tell the user where the files are, how long the video is, and what it shows. Report any notes Demoreel printed (page errors, covered elements). If you could not get a step to work and removed it, say so.

If they want it in their README: a GIF embeds directly (`![Demo](docs/demo.gif)`). GitHub does not play an MP4 that lives in the repo; the user has to drag the MP4 into the README editor on github.com to get a playable link. Say that rather than embedding a link that will not play.

## Sound

A video is silent unless the storyboard asks for sound. Silent is right for a README GIF. Add sound when the user asks for a voice-over, narration, music or "with sound", or says the video is for a launch post or a product page.

```json
"sound": { "voice": true }
```

Every `say` caption is then spoken, with click and typing sounds under it. The recording waits for each line, so the voice sets the pace and you add no `wait` steps for it. Keep the caption a short headline and put the full sentence in `speak`:

```json
{ "say": "Add tasks as fast as you can type", "speak": "Adding a task is as quick as typing it." }
```

- **Which voice.** `doctor` says what this machine has. `"voice": true` uses the natural voice when it is installed, and otherwise the computer's built-in voice, which sounds like a computer. If only the built-in one is there, make the video with it, then tell the user that `voice install` gets a natural voice (a one-time download of about 400 MB that then runs on their machine). Do not run `voice install` without asking.
- **Music.** `"music": "./track.mp3"` uses a file the user gives you. It is lowered while the voice speaks. Do not download music.
- **Subtitles.** For LinkedIn or YouTube, add `"srt"` to `output.formats` and a `.srt` file is written to upload with the video.
- **Checking it.** You cannot hear the video. `record` prints every spoken line with the time it starts: check that each one starts with its beat, and shorten any line marked "held back". Then say which voice was used and that you could not listen to it.

All options, the voice names and using recorded clips: [references/storyboard.md](references/storyboard.md#sound). Writing lines that sound good: [references/directing.md](references/directing.md).

## Directing, in short

- **Captions are headlines, not narration.** Seven words or fewer, about the benefit ("Check things off as you go"), not the action ("Now I click the checkbox"). Three to five captions in a video. With a voice, the sentence goes in `speak` and the caption stays short.
- **Type real things.** "Website launch", not "test" or "asdf". The typed text is part of the pitch.
- **Fewer steps.** Six to fifteen actions. Cut anything that is setup rather than payoff, or do it with `eval` before the visible part.
- **Let the camera work.** It zooms on each action and follows what changed on the page. Override it only when the contact sheet shows a problem.
- **Pick the size for where it will be watched.** Default 1080p suits READMEs and X. For LinkedIn or Instagram use `"output": { "size": "square" }` or `"vertical"`. For a mobile web app use `"viewport": "phone"`.

More on structure, pacing and style choices: [references/directing.md](references/directing.md).

## Privacy and honesty

- Everything runs on this machine, the voice included. Demoreel opens no network connection of its own; the browser loads only the app you point it at. The one exception is `voice install`, which downloads the voice model when it is run.
- The recording shows whatever is on the page. Use test accounts and made-up data. Do not record real customer data, real email addresses or internal URLs without the user's say-so.
- Show the app as it is. Do not use `eval` to fake a feature, hide a real error, or make something look faster than it is. Seeding data and hiding developer overlays is fine; inventing behaviour is not.

## What it cannot do

Web apps only. Sound goes into the MP4, not the GIF. It does not follow links that open a new tab, cannot reach inside iframes, and cannot upload files. Native HTML5 drag-and-drop may not respond (pointer-based dragging does). Native `alert()` and `confirm()` boxes are accepted automatically and do not appear in the video. If the flow depends on one of these, say so and record the part that works.

When something fails in a way the error message does not explain, see [references/troubleshooting.md](references/troubleshooting.md).
