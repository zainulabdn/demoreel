# Troubleshooting

Start with `doctor`. It reports whether Node, the browser and video encoding are usable on this machine:

```
node <skill>/scripts/demoreel.mjs doctor
```

## Starting up

| Message | Cause | Fix |
|---|---|---|
| `Could not find Chrome, Edge or Brave on this machine.` | No Chromium-based browser in the usual places. | Install Google Chrome, or pass `--chrome /path/to/browser`, or set `CHROME_PATH`. |
| `Could not start the browser` | The browser exists but will not launch headless. Common in containers and CI. | In Docker or as root, set `DEMOREEL_NO_SANDBOX=1`. On a Linux server, install the browser's system libraries. |
| `Could not open http://localhost:... (net::ERR_CONNECTION_REFUSED)` | Nothing is listening at `url`. | Start the app, or add `"start": "npm run dev"`, or use `"serve"` for a static folder. Check the port. |
| `... did not come up within 60s of running "..."` | The dev server started on a different port, or is slow. | Make `url` match the port the server prints. Allow more time with `"start": { "command": "npm run dev", "timeout": 120000 }`. |
| `cannot encode H.264 video, and ffmpeg is not installed` | Plain Chromium builds ship without an H.264 encoder. | Use Google Chrome or Microsoft Edge, or install ffmpeg (it is used automatically), or set `"formats": ["gif"]`. |

## Steps that fail

| Message | Cause | Fix |
|---|---|---|
| `Could not find "X" to click. Nothing on the page matches.` | The name is not on the page at that moment. | Use a name from the "Did you mean" or "On screen now" lists. If the element appears late, put a `waitFor` before it. Open the failure screenshot to see the page. |
| `The matching element is disabled right now.` | The button exists but cannot be clicked yet. | An earlier step is missing, usually a required field. |
| `Only 2 element(s) match, so nth 3 does not exist.` | `nth` is larger than the number of matches. | Lower `nth`, or use a `css=` target. |
| `"X" is not a valid CSS selector.` | A `css=` target has a syntax error. | Fix the selector. |
| `There is no focused field to type into.` | A `type` step has no `into`, and nothing has focus. | Add `"into": "<field>"`. |
| `"X" is not a native <select> dropdown.` | `select` was used on a custom dropdown. | Use `click` on the dropdown, then `click` on the option. |
| Note: `"X" is covered by ...; the click may land on that instead.` | Something sits on top of the target: a modal backdrop, a sticky header, a cookie banner. | Close or `hide` whatever covers it, or `waitFor` it to go away. |
| The step passes but did the wrong thing | The name matched a different element than you meant. | Look at the step's screenshot. Make the target more specific: a fuller name, `nth`, or `css=`. |

## The page

| What you see | Cause | Fix |
|---|---|---|
| A login page instead of the app | The recording browser starts with no cookies or storage, every time. | Sign in with a test account as the first steps, or set the session with an `eval` step. Use `${env:NAME}` for the password. |
| The app looks empty | Same reason: no saved data. | Seed data with the app's own script, or an `eval` step that writes to `localStorage` followed by `{ "goto": "/" }`. |
| A cookie banner, chat bubble or promo bar is in the shot | Third-party overlays. | `"hide": [".cookie-banner", "#intercom-container"]`, or an optional click: `{ "click": "Accept", "optional": true }`. |
| A dev-tools badge is visible | A framework overlay that is not hidden by default. | Add its selector to `hide`. |
| Note: `The page opened a confirm dialog...` | The app called `alert()`, `confirm()` or `prompt()`. | These are accepted automatically and are not visible in the video. If the dialog matters to the story, say so in a caption. |
| Note: `the page reported N JavaScript error(s)` | The app threw errors while running. | Read them. They often explain a step that "worked" but showed nothing. |
| A hover menu closes before the next click | The cursor leaves the menu's hover area on the way. | Click the item directly if it is clickable while hidden, or target the menu item right after the `hover`. |
| Nothing happens on `drag` | The app uses native HTML5 drag-and-drop, which synthetic mouse input does not always trigger. | Show the feature another way (a keyboard shortcut or a move button), or leave it out. |

## The video

| What you see on the contact sheet | Fix |
|---|---|
| The camera is zoomed on the wrong place, or a dialog is cut off | `"zoom": false` on that step. See the camera table in [directing.md](directing.md). |
| Text is too small to read | A smaller `viewport`, or a higher `style.zoom`. |
| Everything is blurry when zoomed | Raise `"scale"` to `3`. |
| The video is too long | Cut steps. Typing is the slowest part: shorten typed text or add `"speed": 2`. |
| The video ends too suddenly | `"pause": 1500` on the last step. |
| The GIF is too large | `"output": { "gif": { "width": 720, "fps": 12 } }`, or a shorter video. |
| The browser bar shows `127.0.0.1:49152` | Set `"displayUrl": "yourproduct.com"`. |
| Fonts look different from your own browser | The headless browser uses the fonts installed on this machine. Web fonts load as usual; wait for them with `{ "wait": 500 }` at the start if the first frame shows fallback fonts. |

## Changing the look without recording again

Record once with `--keep`, then re-render with a different style in a few seconds:

```
node <skill>/scripts/demoreel.mjs record demo.reel.json --keep
# edit "style" or "output" in demo.reel.json
node <skill>/scripts/demoreel.mjs render <recording dir printed above> --storyboard demo.reel.json
```

Only `style`, `output`, `name` and `displayUrl` are taken from the storyboard when re-rendering. Changes to steps need a new recording.

## Limits

- Web apps only: anything that runs in a Chromium browser.
- No audio track.
- Links that open a new tab are not followed. Remove `target="_blank"` with an `eval` step if you need to follow one.
- Content inside iframes cannot be targeted.
- No file uploads.
- Canvas-only apps (games, map and drawing tools) have no elements to target by name.
