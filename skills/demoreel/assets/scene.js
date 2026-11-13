// Draws one finished video frame: background, window frame, the zoomed page,
// click ripples, the cursor and captions. Everything is plain Canvas 2D.

export const BACKGROUNDS = {
  dusk: {
    stops: ['#1b1340', '#4a2a7a', '#c0507a'],
    blobs: [['#f2a65a', 0.88, 0.1, 0.55, 0.45], ['#2d6cdf', 0.05, 0.95, 0.6, 0.38]],
  },
  ocean: {
    stops: ['#071a2c', '#0d4a6b', '#1aa3a3'],
    blobs: [['#7ce0c3', 0.9, 0.88, 0.5, 0.35], ['#1b3fa0', 0.08, 0.08, 0.6, 0.42]],
  },
  ember: {
    stops: ['#2a0f0a', '#8a2b12', '#f08a3c'],
    blobs: [['#ffd27a', 0.86, 0.14, 0.5, 0.4], ['#5a1030', 0.1, 0.92, 0.6, 0.45]],
  },
  forest: {
    stops: ['#0c1f17', '#1f5a3d', '#8ac46a'],
    blobs: [['#e6e08a', 0.9, 0.1, 0.45, 0.35], ['#0f3a4a', 0.05, 0.9, 0.6, 0.42]],
  },
  slate: {
    stops: ['#14161b', '#2a2e38'],
    blobs: [['#566179', 0.85, 0.08, 0.55, 0.38], ['#0b0c10', 0.1, 0.95, 0.6, 0.5]],
  },
  lilac: {
    stops: ['#e9e4ff', '#c9b8ff', '#f7c6e0'],
    blobs: [['#ffffff', 0.18, 0.14, 0.5, 0.6], ['#a6c8ff', 0.9, 0.9, 0.55, 0.5]],
  },
  sky: {
    stops: ['#cfe8ff', '#9cc9f5', '#e3d9ff'],
    blobs: [['#ffffff', 0.15, 0.85, 0.5, 0.55], ['#7fb2f0', 0.92, 0.1, 0.5, 0.4]],
  },
  paper: {
    stops: ['#f4efe6', '#e9e1d2'],
    blobs: [['#ffffff', 0.15, 0.1, 0.6, 0.7], ['#e0cfb2', 0.9, 0.95, 0.5, 0.5]],
  },
};

const FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

function parseColor(color) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    let value = hex[1];
    if (value.length === 3) value = value.replace(/./g, (c) => c + c);
    const number = parseInt(value, 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  }
  // Let the browser parse anything else (named colours, rgb(), hsl()).
  const probe = new OffscreenCanvas(1, 1).getContext('2d');
  probe.fillStyle = '#000';
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

const rgba = ([r, g, b], alpha) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function backgroundSpec(background) {
  if (Array.isArray(background)) return { stops: background, blobs: [] };
  if (BACKGROUNDS[background]) return BACKGROUNDS[background];
  return { stops: [background, background], blobs: [], vignette: true };
}

function paintBackground(ctx, W, H, background) {
  const spec = backgroundSpec(background);
  const angle = ((spec.angle ?? 135) * Math.PI) / 180;
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  const length = Math.abs(W * dx) + Math.abs(H * dy);
  const gradient = ctx.createLinearGradient(
    W / 2 - (dx * length) / 2, H / 2 - (dy * length) / 2,
    W / 2 + (dx * length) / 2, H / 2 + (dy * length) / 2,
  );
  spec.stops.forEach((stop, i) => gradient.addColorStop(spec.stops.length === 1 ? 0 : i / (spec.stops.length - 1), stop));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  for (const [color, x, y, radius, alpha] of spec.blobs) {
    const rgb = parseColor(color);
    const r = radius * Math.max(W, H);
    const blob = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r);
    blob.addColorStop(0, rgba(rgb, alpha));
    blob.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, W, H);
  }
  if (spec.vignette) {
    const shade = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------------------------------------------------------------- cursors

function arrowPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17.6);
  ctx.lineTo(4.3, 13.7);
  ctx.lineTo(7.2, 20.6);
  ctx.lineTo(10.1, 19.4);
  ctx.lineTo(7.2, 12.7);
  ctx.lineTo(12.9, 12.7);
  ctx.closePath();
}

function handPath(ctx) {
  // A pointing hand built from rounded shapes; the fingertip sits at (0, 0).
  ctx.beginPath();
  ctx.roundRect(-2, -1, 4.2, 14, 2.1); // index finger
  ctx.roundRect(2.2, 5.2, 3.9, 9, 1.95); // middle
  ctx.roundRect(6.1, 6.2, 3.7, 8.6, 1.85); // ring
  ctx.roundRect(9.8, 7.6, 3.4, 8, 1.7); // little
  ctx.roundRect(-2, 9.6, 15.2, 12.6, [3, 3, 5.5, 5.5]); // palm
  // thumb, angled out to the left
  ctx.save();
  ctx.translate(-3.7, 13.6);
  ctx.rotate(-0.66);
  ctx.roundRect(-1.9, -4.6, 3.8, 9.2, 1.9);
  ctx.restore();
}

function ibeamPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(-3.2, -9);
  ctx.quadraticCurveTo(-0.6, -9, 0, -7.4);
  ctx.quadraticCurveTo(0.6, -9, 3.2, -9);
  ctx.moveTo(0, -7.4);
  ctx.lineTo(0, 7.4);
  ctx.moveTo(-3.2, 9);
  ctx.quadraticCurveTo(-0.6, 9, 0, 7.4);
  ctx.quadraticCurveTo(0.6, 9, 3.2, 9);
}

/** A finger-sized dot, used instead of a mouse cursor for phone and tablet recordings. */
function drawTouch(ctx, x, y, size, press) {
  const radius = 15 * size * (1 - 0.22 * press);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 8 * size;
  ctx.shadowOffsetY = 2 * size;
  ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.3 * press})`;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2 * size;
  ctx.strokeStyle = 'rgba(17,17,17,0.45)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, radius - 2 * size), 0, Math.PI * 2);
  ctx.lineWidth = 1.2 * size;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
  ctx.restore();
}

function drawCursor(ctx, kind, x, y, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 1.5 * size;

  if (kind === 1) {
    handPath(ctx);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#111';
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    for (const fx of [2.2, 6.1, 9.8]) {
      ctx.moveTo(fx, 9.2);
      ctx.lineTo(fx, 13.2);
    }
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = 'rgba(17,17,17,0.55)';
    ctx.stroke();
  } else if (kind === 2) {
    ibeamPath(ctx);
    ctx.lineWidth = 3.6;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#111';
    ctx.stroke();
  } else {
    arrowPath(ctx);
    ctx.lineWidth = 2.1;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#111';
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- captions

function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const attempt = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(attempt).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = attempt;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

// ---------------------------------------------------------------- scene

export function createScene(plan) {
  const { layout, style, track, viewport, fps } = plan;
  const W = layout.width;
  const H = layout.height;
  const k = layout.unit;
  const win = layout.window;
  const content = layout.content;
  const bar = layout.bar.h;
  const bare = layout.frame === 'none';

  // Everything that never changes is painted once.
  const base = new OffscreenCanvas(W, H);
  {
    const ctx = base.getContext('2d', { alpha: false });
    paintBackground(ctx, W, H, style.background);
    if (!bare) {
      ctx.save();
      if (style.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.42)';
        ctx.shadowBlur = 70 * k;
        ctx.shadowOffsetY = 26 * k;
      }
      ctx.fillStyle = layout.frame === 'phone' ? '#0b0b0d' : '#ffffff';
      ctx.beginPath();
      ctx.roundRect(win.x, win.y, win.w, win.h, win.radius);
      ctx.fill();
      ctx.restore();
      if (layout.frame === 'phone') {
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = Math.max(1, 1.5 * k);
        ctx.beginPath();
        ctx.roundRect(win.x + 0.75, win.y + 0.75, win.w - 1.5, win.h - 1.5, win.radius);
        ctx.stroke();
      }
    }
  }

  const sampler = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  const fixedChrome = style.chrome === 'light' ? [244, 244, 246] : style.chrome === 'dark' ? [37, 38, 43] : null;
  let chrome = fixedChrome || [246, 246, 248];
  let chromeTarget = chrome;
  let sampledIndex = -1;
  let primed = false;

  const captionFont = `600 ${layout.caption.font}px ${FONT_STACK}`;
  const urlFont = `500 ${Math.round(13.5 * k)}px ${FONT_STACK}`;

  const contentRadii = () => {
    if (bare) return 0;
    if (layout.frame === 'browser') return [0, 0, win.radius, win.radius];
    if (layout.frame === 'phone') return Math.max(0, win.radius - layout.bezel);
    return win.radius;
  };

  function drawBar(ctx, urlText) {
    const dark = luminance(chrome) < 0.5;
    ctx.fillStyle = rgba(chrome, 1);
    ctx.beginPath();
    ctx.roundRect(win.x, win.y, win.w, bar + 1, [win.radius, win.radius, 0, 0]);
    ctx.fill();
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.09)';
    ctx.fillRect(win.x, win.y + bar - 1, win.w, 1);

    const dotY = win.y + bar / 2;
    const dotR = 6.2 * k;
    ['#ff5f57', '#febc2e', '#28c840'].forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(win.x + 22 * k + i * 21 * k, dotY, dotR, 0, Math.PI * 2);
      ctx.fill();
    });

    const pillW = Math.min(win.w * 0.46, 640 * k);
    const pillH = Math.round(bar * 0.62);
    const pillX = win.x + (win.w - pillW) / 2;
    const pillY = win.y + (bar - pillH) / 2;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)';
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fill();

    if (urlText) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(pillX + 12 * k, pillY, pillW - 24 * k, pillH);
      ctx.clip();
      ctx.font = urlFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.74)' : 'rgba(0,0,0,0.62)';
      ctx.fillText(urlText, pillX + pillW / 2, pillY + pillH / 2 + 0.5);
      ctx.restore();
    }
  }

  function drawCaptions(ctx, t) {
    const fadeIn = 220;
    const fadeOut = 180;
    for (const caption of plan.captions) {
      if (t < caption.t0 || t > caption.t1 + fadeOut) continue;
      const appear = clamp((t - caption.t0) / fadeIn, 0, 1);
      const vanish = clamp((caption.t1 + fadeOut - t) / fadeOut, 0, 1);
      const alpha = Math.min(appear, vanish);
      if (alpha <= 0) continue;

      ctx.save();
      ctx.font = captionFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = wrapText(ctx, caption.text, layout.caption.maxWidth);
      const lineHeight = Math.round(layout.caption.font * 1.28);
      const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
      const padX = Math.round(layout.caption.font * 0.95);
      const padY = Math.round(layout.caption.font * 0.5);
      const boxW = textWidth + padX * 2;
      const boxH = lines.length * lineHeight + padY * 2;
      const lift = (1 - easeOut(appear)) * 14 * k;
      const boxX = layout.caption.cx - boxW / 2;
      const boxY = layout.caption.cy - boxH / 2 + lift;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(12,12,16,0.84)';
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, Math.min(boxH / 2, 26 * k));
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      lines.forEach((line, i) => {
        ctx.fillText(line, layout.caption.cx, boxY + padY + lineHeight * (i + 0.5) + 1);
      });
      ctx.restore();
    }
  }

  return {
    /** Forget smoothing state, so the next frame drawn is treated as the first. */
    reset() {
      primed = false;
      sampledIndex = -1;
    },

    /**
     * @param {OffscreenCanvasRenderingContext2D} ctx
     * @param {number} i              output frame number
     * @param {ImageBitmap} bitmap    the captured page frame to show
     * @param {{snap?: boolean}} [options]  snap: skip smoothing (used when frames are drawn out of order)
     */
    draw(ctx, i, bitmap, options = {}) {
      const t = (i * 1000) / fps;
      const scale = track.scale[i];
      const viewW = viewport.width / scale;
      const viewH = viewport.height / scale;
      const viewX = track.cx[i] - viewW / 2;
      const viewY = track.cy[i] - viewH / 2;
      const density = bitmap.width / viewport.width;

      ctx.drawImage(base, 0, 0);

      if (bar && !fixedChrome && track.src[i] !== sampledIndex) {
        // Tint the browser bar with the colour at the top of the page, like a real browser does.
        sampledIndex = track.src[i];
        sampler.drawImage(bitmap, 0, 0, bitmap.width, Math.max(2, Math.round(3 * density)), 0, 0, 1, 1);
        const [r, g, b] = sampler.getImageData(0, 0, 1, 1).data;
        chromeTarget = [r, g, b];
      }
      if (!primed || options.snap) {
        chrome = chromeTarget;
        primed = true;
      } else {
        chrome = chrome.map((value, c) => value + (chromeTarget[c] - value) * 0.16);
      }

      if (bar) {
        let urlText = '';
        for (const entry of plan.urls) {
          if (entry.t <= t) urlText = entry.text;
          else break;
        }
        drawBar(ctx, urlText);
      }

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(content.x, content.y, content.w, content.h, contentRadii());
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, viewX * density, viewY * density, viewW * density, viewH * density, content.x, content.y, content.w, content.h);

      const toX = (x) => content.x + ((x - viewX) / viewW) * content.w;
      const toY = (y) => content.y + ((y - viewY) / viewH) * content.h;
      const boost = 0.8 + 0.2 * scale;

      for (const click of plan.clicks) {
        const dt = t - click.t;
        if (dt < 0 || dt > 520) continue;
        const p = dt / 520;
        const radius = (9 + 30 * easeOut(p)) * k * boost;
        const x = toX(click.x);
        const y = toY(click.y);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.3 * (1 - p)})`;
        ctx.fill();
        ctx.lineWidth = 2.6 * k;
        ctx.strokeStyle = `rgba(17,17,17,${0.38 * (1 - p)})`;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0, radius - 2.2 * k), 0, Math.PI * 2);
        ctx.lineWidth = 1.3 * k;
        ctx.strokeStyle = `rgba(255,255,255,${0.85 * (1 - p)})`;
        ctx.stroke();
      }

      if (!style.cursorHidden) {
        const base = 1.5 * k * style.cursorSize * Math.sqrt(scale);
        const x = toX(track.cursorX[i]);
        const y = toY(track.cursorY[i]);
        if (style.cursorKind === 'touch') {
          if (track.cursorAlpha[i] > 0) {
            ctx.globalAlpha = track.cursorAlpha[i];
            drawTouch(ctx, x, y, base, track.press[i]);
            ctx.globalAlpha = 1;
          }
        } else {
          drawCursor(ctx, track.cursorKind[i], x, y, base * (1 - 0.14 * track.press[i]));
        }
      }
      ctx.restore();

      if (!bare && layout.frame !== 'phone') {
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(win.x + 0.5, win.y + 0.5, win.w - 1, win.h - 1, win.radius);
        ctx.stroke();
      }

      drawCaptions(ctx, t);
    },
  };
}
