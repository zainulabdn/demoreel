# Changelog

## 0.1.0

First release.

- Record a real web app from a JSON storyboard of plain-language steps: `click`, `type`, `press`, `hover`, `scroll`, `select`, `drag`, `goto`, `wait`, `waitFor`, `say`, `zoom` and `eval`.
- Elements are found by the names people see (button text, labels, placeholders, `aria-label`), with `css=`, `testid=`, `text=`, `label=` and `placeholder=` for the rest. Failures suggest close matches and list what is on screen.
- Automatic camera: zooms in as the cursor arrives, holds while typing, follows the part of the page that changed, and pulls back for scrolls, drags and page changes.
- Natural cursor paths, click ripples, arrow, hand and text cursors, and a touch dot for phone and tablet viewports.
- Captions, browser, window, phone and bare frames, eight backgrounds, custom colours and gradients.
- Output as MP4 (H.264), GIF, a poster image and a contact sheet, in 1080p, 720p, 1440p, square, portrait and vertical sizes. The MP4 is kept under 10 MB by default.
- `check` to test a storyboard in seconds, `render` to restyle a kept recording, `doctor` to check the machine, `init` for a starter file.
- `serve` for static folders, `start` to launch a dev server, `theme` for dark mode, `${env:NAME}` for secrets.
- Zero dependencies: drives an installed Chrome, Edge or Brave over the DevTools Protocol and encodes in the browser. Falls back to `ffmpeg` for MP4 when the browser has no H.264 encoder.
- Packaged as an Agent Skill, a Claude Code plugin and a Codex plugin.
