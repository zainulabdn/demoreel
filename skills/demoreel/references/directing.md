# Directing a demo

The tool gets the mechanics right on its own: the cursor, the zoom, the timing. What it cannot decide is what the video is about. That part is yours.

## The shape of a good demo

A demo that works has three parts, and each one is short.

1. **A starting point worth looking at (2 to 3 seconds).** The app with real-looking content already in it. Not a login form, not an empty state, not a loading spinner. If the app starts empty, seed it before the visible steps.
2. **The thing it does (10 to 30 seconds).** One flow, start to finish, where the viewer sees a result appear. Two to four beats, each introduced by a caption.
3. **The payoff (2 to 3 seconds).** The finished state, held still: the chart drawn, the list filled, the page in dark mode. End here. Do not navigate away or open another menu after the best moment.

If you cannot say what the payoff frame is, the storyboard is not ready.

## Choosing the flow

Pick the flow where the app does the most with the fewest clicks. Good signs:

- Something appears that was not there before (a created item, a generated result, a chart).
- A slow thing is fast (search as you type, drag to reorder, a keyboard shortcut).
- The before and after look visibly different.

Leave out settings pages, sign-up forms, anything that needs a long wait, and anything the viewer would have to read carefully to appreciate.

## Captions

Captions carry the pitch, because most people watch without sound.

- Write the benefit, not the action. "Find anything in two keystrokes", not "Open the search bar".
- Seven words or fewer. If it needs a comma, it is two captions or one too many ideas.
- Three to five in a video. A new caption marks a new beat; if nothing new is happening, do not add one.
- Put the `say` step just before the action it describes, so the viewer reads first and then sees it happen.
- No trailing full stop. Sentence case.

## What to type

Typed text is on screen for seconds and gets read. Use the kind of thing a real user of this app would enter: a plausible project name, a real-sounding task, a search for something that exists in the seed data. Avoid "test", "foo", "asdf", lorem ipsum, and your own name.

Keep it short. Typing is the slowest thing in a demo: about ten characters a second. A forty-character sentence costs four seconds of the viewer's patience. If long text is essential, add `"speed": 2`.

## Pacing

The default pace suits most apps. Change it only when the contact sheet or the total length tells you to.

- Video over 45 seconds: cut steps first. Then consider `"pace": 0.85`.
- Things happen before the viewer can read them: add `"pause": 600` to the step that produced the result, rather than slowing everything down.
- The ending feels clipped: add `"pause": 1500` to the last step.

## The camera

By default the camera zooms in as the cursor approaches a target, holds while you act there, follows the part of the page that changed, and pulls back for scrolls, drags and page changes. Most storyboards need no camera instructions at all.

Step in when the contact sheet shows one of these:

| What you see | What to do |
|---|---|
| The interesting result is outside the zoomed view | Add `"zoom": false` to that step, so the whole page is visible when it happens. |
| The camera zooms on a click that is not interesting (a menu toggle on the way to something) | `"zoom": false` on that step. |
| A detail is too small to read even when zoomed | `"zoom": 2.2` on that step, or a `{ "zoom": "Chart", "level": 2.2 }` step to look at it. |
| The whole video feels too close | Lower `"style": { "zoom": 1.35 }`. |
| The whole app is small text on a big page | Use a smaller viewport, such as `{ "width": 1100, "height": 620 }`. |
| You want a calm, wide shot of everything | `{ "zoom": "out" }`, usually before the final step. |

## Choosing the look

- **Background.** Contrast with the app. A light app on `dusk`, `ocean` or `slate`; a dark app on `lilac`, `sky` or `paper`. If the product has a brand colour, a two-colour gradient built from it looks deliberate: `"background": ["#1e1b4b", "#6d4aff"]`.
- **Frame.** `browser` says "this is a web app" and shows the address. `window` is cleaner for embedded widgets and marketing shots. `phone` for mobile layouts. `none` when the video will be placed inside another design.
- **Address.** Set `displayUrl` to the product's real domain. `localhost:5173` in the bar makes a demo look unfinished.
- **Size.** Match where it will be watched. A wide desktop app squeezed into a vertical video is unreadable; for vertical formats, record a `phone` or `tablet` viewport instead.

## Before you call it done

Open the contact sheet and answer four questions:

1. Could someone who has never seen the app say what it does from these frames alone?
2. Is every caption true of the frame it sits on?
3. Is there any frame that shows an error, an empty state or a half-loaded page?
4. Is the last frame the one you would choose as the thumbnail?

Four yes answers and you are finished.
