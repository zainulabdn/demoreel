# Contributing

Thanks for helping. Demoreel is small on purpose, so most changes are easy to find a home for.

## Setup

There is nothing to install. You need Node.js 20 or newer and Chrome, Edge or Brave.

```bash
git clone https://github.com/zainulabdn/demoreel
cd demoreel
npm test          # everything, about a minute
npm run test:unit # skips the tests that open a browser, a few seconds
npm run demo      # records the example app
```

## Where things live

| Path | What it is |
|---|---|
| `skills/demoreel/SKILL.md` | What the agent reads: when to use Demoreel and how to work. |
| `skills/demoreel/references/` | The storyboard reference, the directing guide and troubleshooting. |
| `skills/demoreel/scripts/demoreel.mjs` | The command line. |
| `skills/demoreel/scripts/lib/` | Recording: browser control, finding elements, the camera, the render plan. |
| `skills/demoreel/assets/` | Rendering, which runs in the browser: the compositor, the MP4 writer, the GIF encoder. |
| `examples/lumen/` | The sample app and storyboards used in the README. |
| `tests/` | Unit tests, plus browser tests that are skipped when no browser is found. |

## Rules of the road

- **No dependencies.** If a change needs a package, it needs a very good reason. Node built-ins and the browser cover a lot.
- **Pure logic gets a unit test.** The camera, the plan, the storyboard checks and both encoders are plain functions for that reason.
- **Errors are written for the person fixing the storyboard.** Say which step, what was wrong, and what to try. Throw `DemoreelError(message, hint)`.
- **Docs change with the code.** A new step or option is not done until it is in `references/storyboard.md`.
- Run `claude plugin validate .` if you touch the manifests.

## Good first changes

- A new background preset in `assets/scene.js`.
- A new frame style.
- A framework's dev overlay missing from `DEFAULT_HIDE` in `lib/page.mjs`.
- A real app where a step fails: open an issue with the storyboard and the error.

## Regenerating the README media

```bash
node skills/demoreel/scripts/demoreel.mjs record examples/lumen/demo.reel.json --out docs/media
node skills/demoreel/scripts/demoreel.mjs record examples/lumen/phone.reel.json --out docs/media
node tools/render-icon.mjs
```
