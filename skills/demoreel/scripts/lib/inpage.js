// Runs inside the page being recorded. Injected before any page script on every document.
// It finds elements the way a person would describe them ("New board", "Email"),
// scrolls smoothly, and reports when the page has stopped changing.
// Plain script, no imports: it is evaluated as-is in the page.
(() => {
  if (window.__demoreel) return;

  const config = window.__demoreelConfig || {};

  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'label',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="option"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="combobox"]',
    '[role="textbox"]', '[role="searchbox"]', '[role="treeitem"]',
    '[contenteditable=""]', '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])', '[onclick]',
  ].join(',');

  const EDITABLE = [
    'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"])' +
      ':not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="range"])' +
      ':not([type="color"]):not([type="image"])',
    'textarea', 'select', '[contenteditable=""]', '[contenteditable="true"]',
    '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
  ].join(',');

  const norm = (value) => (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);

  // ---------------------------------------------------------------- page activity

  let lastMutation = performance.now();
  /** While set, collects the elements that change, so the camera can follow the result of an action. */
  let tracked = null;
  const track = (el) => {
    if (tracked && el && el.nodeType === 1 && tracked.size < 400) tracked.add(el);
  };
  try {
    new MutationObserver((records) => {
      lastMutation = performance.now();
      if (!tracked) return;
      for (const record of records) {
        if (record.type === 'attributes') {
          track(record.target);
        } else if (record.type === 'characterData') {
          track(record.target.parentElement);
        } else {
          let addedElement = false;
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) {
              track(node);
              addedElement = true;
            }
          }
          // Text replaced, or something removed: the container is what visibly changed.
          if (!addedElement) track(record.target);
        }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    // Some documents (for example XML) cannot be observed. Activity then looks quiet.
  }

  const applyHide = () => {
    const selectors = config.hide || [];
    if (!selectors.length || document.getElementById('__demoreel-hide')) return;
    const root = document.head || document.documentElement;
    if (!root) return;
    const style = document.createElement('style');
    style.id = '__demoreel-hide';
    style.textContent = selectors.map((s) => `${s}{display:none !important}`).join('\n');
    root.appendChild(style);
  };
  applyHide();
  document.addEventListener('DOMContentLoaded', applyHide);

  // ---------------------------------------------------------------- element helpers

  const deepQueryAll = (selector, root = document) => {
    const out = [];
    const visit = (node) => {
      for (const el of node.querySelectorAll(selector)) out.push(el);
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  };

  const isVisible = (el) => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity) !== 0;
  };

  /**
   * Laid out and hit-testable, even if fully transparent. Custom checkboxes and file inputs
   * are often an invisible native control stretched over a styled one, and are still clickable.
   */
  const isRendered = (el) => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkVisibilityCSS: true });
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const isDisabled = (el) =>
    el.disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest?.('fieldset[disabled]');

  const ownText = (el) => {
    let text = '';
    for (const node of el.childNodes) if (node.nodeType === 3) text += node.nodeValue;
    return norm(text);
  };

  /** Everything a person might call this element, with a weight for how natural that name is. */
  const namesOf = (el) => {
    const out = [];
    const push = (value, weight) => {
      const text = norm(value);
      if (text) out.push([text, weight]);
    };
    push(el.getAttribute('aria-label'), 1);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      push(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '), 1);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.labels) for (const label of el.labels) push(label.innerText, 1);
      push(el.getAttribute('placeholder'), 1);
      if (tag === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) push(el.value, 1);
      push(el.getAttribute('name'), 0.8);
      push(el.id, 0.7);
    } else {
      push(el.innerText !== undefined ? el.innerText : el.textContent, 1);
      const image = el.querySelector?.('img[alt], svg[aria-label], [aria-label]');
      if (image) push(image.getAttribute('alt') || image.getAttribute('aria-label'), 0.9);
    }
    push(el.getAttribute('title'), 0.9);
    push(el.getAttribute('alt'), 0.9);
    push(el.getAttribute('data-testid'), 0.6);
    return out;
  };

  const scoreName = (name, query, queryLower) => {
    if (name === query) return 100;
    const lower = name.toLowerCase();
    if (lower === queryLower) return 95;
    const extra = Math.min(25, (lower.length - queryLower.length) / 4);
    if (lower.startsWith(queryLower)) return 70 - extra;
    const index = lower.indexOf(queryLower);
    if (index < 0) return 0;
    const before = index === 0 || /[^a-z0-9]/.test(lower[index - 1]);
    const afterIndex = index + queryLower.length;
    const after = afterIndex === lower.length || /[^a-z0-9]/.test(lower[afterIndex]);
    return (before && after ? 50 : 35) - extra;
  };

  const bestScore = (el, query, queryLower) => {
    let best = 0;
    for (const [name, weight] of namesOf(el)) {
      const score = scoreName(name, query, queryLower) * weight;
      if (score > best) best = score;
    }
    return best;
  };

  const clickableAncestor = (el) => {
    let node = el;
    for (let depth = 0; node && depth < 5; depth++) {
      if (node.matches?.(INTERACTIVE) || getComputedStyle(node).cursor === 'pointer') return node;
      node = node.parentElement || node.getRootNode()?.host;
    }
    return el;
  };

  const describe = (el) => {
    const name = namesOf(el)[0]?.[0] || '';
    const tag = el.tagName.toLowerCase();
    return name ? `${tag} "${name.slice(0, 60)}"` : tag;
  };

  const inViewport = (rect) =>
    rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;

  // ---------------------------------------------------------------- locating

  const parseQuery = (raw) => {
    const query = String(raw);
    const match = /^(css|text|label|placeholder|testid)=(.*)$/s.exec(query);
    if (match) return { kind: match[1], value: match[2] };
    if (/^[#.\[]/.test(query)) return { kind: 'css', value: query, guessed: true };
    return { kind: 'name', value: query };
  };

  const findCandidates = (raw, mode) => {
    const parsed = parseQuery(raw);
    const value = norm(parsed.value);
    const lower = value.toLowerCase();

    if (parsed.kind === 'css') {
      let list;
      try {
        list = deepQueryAll(parsed.value);
      } catch {
        if (!parsed.guessed) return { error: `"${parsed.value}" is not a valid CSS selector.` };
        list = [];
      }
      // A selector names its element exactly, so transparency is not a reason to refuse it.
      if (list.length || !parsed.guessed) return { list: list.filter(isRendered).map((el) => ({ el, score: 100 })) };
    }
    if (parsed.kind === 'testid') {
      const list = deepQueryAll('[data-testid],[data-test-id],[data-test]').filter(
        (el) =>
          isVisible(el) &&
          [el.getAttribute('data-testid'), el.getAttribute('data-test-id'), el.getAttribute('data-test')].includes(value),
      );
      return { list: list.map((el) => ({ el, score: 100 })) };
    }
    if (parsed.kind === 'placeholder') {
      const list = deepQueryAll('[placeholder]').filter(
        (el) => isVisible(el) && norm(el.getAttribute('placeholder')).toLowerCase().includes(lower),
      );
      return { list: list.map((el) => ({ el, score: 100 })) };
    }

    const candidates = [];
    const pool = deepQueryAll(mode === 'edit' || parsed.kind === 'label' ? EDITABLE : INTERACTIVE);
    for (const el of pool) {
      if (!isVisible(el)) continue;
      const score = bestScore(el, value, lower);
      if (score > 0) candidates.push({ el, score: score + 20 });
    }

    const strong = candidates.some((c) => c.score >= 80);
    if (!strong && mode !== 'edit' && parsed.kind !== 'label') {
      // Fall back to any element whose own text matches, then climb to what is actually clickable.
      const seen = new Set(candidates.map((c) => c.el));
      for (const el of deepQueryAll('*')) {
        const text = ownText(el);
        if (!text) continue;
        const score = scoreName(text, value, lower);
        if (score <= 0 || !isVisible(el)) continue;
        const target = parsed.kind === 'text' ? el : clickableAncestor(el);
        if (seen.has(target)) continue;
        seen.add(target);
        candidates.push({ el: target, score });
      }
    }
    return { list: candidates };
  };

  const pickPoint = (el, rect) => {
    // In a text field, aim near the right end: text is typed from the left, and a cursor
    // parked in the middle would sit on top of it.
    const textField = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.matches(EDITABLE) && rect.width > 160;
    const xs = textField ? [0.84, 0.5, 0.25, 0.75] : [0.5, 0.25, 0.75, 0.1, 0.9];
    const ys = [0.5, 0.3, 0.7];
    for (const fy of ys) {
      for (const fx of xs) {
        const x = clamp(rect.left + rect.width * fx, 1, window.innerWidth - 2);
        const y = clamp(rect.top + rect.height * fy, 1, window.innerHeight - 2);
        const hit = document.elementFromPoint(x, y);
        if (!hit) continue;
        if (hit === el || el.contains(hit) || hit.contains(el) || hit.shadowRoot?.contains(el)) {
          return { x, y, hit, covered: false };
        }
        if (el.tagName === 'LABEL' && el.control && (hit === el.control || el.control.contains(hit))) {
          return { x, y, hit, covered: false };
        }
      }
    }
    const x = clamp(rect.left + rect.width / 2, 1, window.innerWidth - 2);
    const y = clamp(rect.top + rect.height / 2, 1, window.innerHeight - 2);
    return { x, y, hit: document.elementFromPoint(x, y), covered: true };
  };

  const cursorKind = (el) => {
    if (!el) return 'default';
    const cursor = getComputedStyle(el).cursor;
    if (cursor === 'pointer') return 'pointer';
    if (cursor === 'text' || cursor === 'vertical-text') return 'text';
    if (cursor === 'grab' || cursor === 'grabbing' || cursor === 'move') return 'grab';
    if (cursor === 'auto') {
      if (el.closest?.('a[href]')) return 'pointer';
      if (el.matches?.(EDITABLE) && el.tagName !== 'SELECT') return 'text';
      if (el.isContentEditable) return 'text';
    }
    return 'default';
  };

  const similarity = (a, b) => {
    const grams = (s) => {
      const set = new Set();
      const text = ` ${s.toLowerCase()} `;
      for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
      return set;
    };
    const ga = grams(a);
    const gb = grams(b);
    let shared = 0;
    for (const g of ga) if (gb.has(g)) shared++;
    return (2 * shared) / (ga.size + gb.size || 1);
  };

  const suggestions = (raw, mode) => {
    const query = norm(parseQuery(raw).value);
    const seen = new Set();
    const names = [];
    for (const el of deepQueryAll(mode === 'edit' ? EDITABLE : INTERACTIVE)) {
      if (!isVisible(el)) continue;
      const name = namesOf(el)[0]?.[0];
      if (!name || name.length > 60 || seen.has(name)) continue;
      seen.add(name);
      names.push({ name, onScreen: inViewport(el.getBoundingClientRect()), score: similarity(name, query) });
    }
    const close = [...names].sort((a, b) => b.score - a.score).filter((n) => n.score > 0.3).slice(0, 5).map((n) => n.name);
    const visible = names.filter((n) => n.onScreen).slice(0, 14).map((n) => n.name);
    return { close, visible };
  };

  let last = null;

  /**
   * Find one element. `mode` is "click" (anything a person can click) or "edit" (a field to type in).
   */
  const locate = (raw, options = {}) => {
    const mode = options.mode || 'click';
    const found = findCandidates(raw, mode);
    if (found.error) return { ok: false, reason: found.error, ...suggestions(raw, mode) };

    let list = found.list.filter((c) => !isDisabled(c.el));
    const disabledOnly = !list.length && found.list.length > 0;
    if (!list.length) {
      return {
        ok: false,
        reason: disabledOnly ? 'The matching element is disabled right now.' : 'Nothing on the page matches.',
        ...suggestions(raw, mode),
      };
    }

    let chosen;
    if (options.nth) {
      const best = Math.max(...list.map((c) => c.score));
      const good = list.filter((c) => c.score >= Math.max(30, best - 30));
      good.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      chosen = good[options.nth - 1];
      if (!chosen) {
        return { ok: false, reason: `Only ${good.length} element(s) match, so nth ${options.nth} does not exist.`, ...suggestions(raw, mode) };
      }
    } else {
      list = list
        .map((c, index) => ({ ...c, index, onScreen: inViewport(c.el.getBoundingClientRect()) }))
        .sort((a, b) => b.score - a.score || Number(b.onScreen) - Number(a.onScreen) || a.index - b.index);
      chosen = list[0];
    }

    const el = chosen.el;
    last = el;
    const rect = el.getBoundingClientRect();
    const margin = 24;
    const fullyVisible =
      rect.top >= margin &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight - margin &&
      rect.right <= window.innerWidth;
    const fits = rect.height <= window.innerHeight - margin * 2;
    const point = pickPoint(el, rect);
    return {
      ok: true,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      point: { x: point.x, y: point.y },
      covered: point.covered,
      coveredBy: point.covered && point.hit ? describe(point.hit) : null,
      needsScroll: fits ? !fullyVisible : rect.top < 0 || rect.top > window.innerHeight * 0.6,
      cursor: cursorKind(point.covered ? el : point.hit || el),
      label: describe(el),
      tag: el.tagName.toLowerCase(),
      editable: el.matches(EDITABLE) || el.isContentEditable,
      isSelect: el.tagName === 'SELECT',
      matches: found.list.length,
    };
  };

  // ---------------------------------------------------------------- scrolling

  const scrollContainerOf = (el) => {
    let node = el.parentElement || el.getRootNode()?.host;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
      node = node.parentElement || node.getRootNode()?.host;
    }
    return document.scrollingElement || document.documentElement;
  };

  const mainScroller = () => {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 1) return root;
    let best = root;
    let bestArea = 0;
    for (const el of deepQueryAll('*')) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };

  const animateScroll = (container, targetTop, duration) =>
    new Promise((resolve) => {
      const from = container.scrollTop;
      const to = clamp(targetTop, 0, container.scrollHeight - container.clientHeight);
      const distance = to - from;
      if (Math.abs(distance) < 1) return resolve({ scrolled: false, distance: 0 });
      const ms = duration || clamp(380 + Math.abs(distance) * 0.45, 450, 1200);
      const previous = container.style.scrollBehavior;
      container.style.scrollBehavior = 'auto';
      const start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / ms);
        container.scrollTop = from + distance * minJerk(t);
        if (t < 1) return requestAnimationFrame(tick);
        container.style.scrollBehavior = previous;
        resolve({ scrolled: true, distance });
      };
      requestAnimationFrame(tick);
    });

  const scrollLastIntoView = (duration) => {
    if (!last || !last.isConnected) return Promise.resolve({ scrolled: false, distance: 0 });
    const container = scrollContainerOf(last);
    const rect = last.getBoundingClientRect();
    const isRoot = container === (document.scrollingElement || document.documentElement);
    const viewTop = isRoot ? 0 : container.getBoundingClientRect().top;
    const viewHeight = isRoot ? window.innerHeight : container.clientHeight;
    const offset = rect.height < viewHeight * 0.8 ? (viewHeight - rect.height) / 2 : viewHeight * 0.12;
    return animateScroll(container, container.scrollTop + (rect.top - viewTop) - offset, duration);
  };

  const scrollPage = (amount, duration) => {
    const container = mainScroller();
    let target;
    if (amount === 'top') target = 0;
    else if (amount === 'bottom') target = container.scrollHeight;
    else target = container.scrollTop + Number(amount);
    return animateScroll(container, target, duration);
  };

  // ---------------------------------------------------------------- form helpers

  const selectOption = (wanted) => {
    if (!last || last.tagName !== 'SELECT') return { ok: false, reason: 'The target is not a <select> dropdown.' };
    const lower = norm(wanted).toLowerCase();
    const options = [...last.options];
    const option =
      options.find((o) => norm(o.label).toLowerCase() === lower || o.value.toLowerCase() === lower) ||
      options.find((o) => norm(o.label).toLowerCase().includes(lower));
    if (!option) return { ok: false, reason: `No option matches "${wanted}".`, visible: options.map((o) => norm(o.label)).slice(0, 14) };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(last, option.value);
    last.dispatchEvent(new Event('input', { bubbles: true }));
    last.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, label: norm(option.label) };
  };

  const focusLast = () => {
    if (last && last.isConnected && typeof last.focus === 'function') last.focus({ preventScroll: true });
    return true;
  };

  const lastValueLength = () => {
    if (!last) return 0;
    if (typeof last.value === 'string') return last.value.length;
    if (last.isContentEditable) return (last.textContent || '').length;
    return 0;
  };

  /** Select everything in the last located field, so the next key press replaces it. */
  const selectLastContents = () => {
    if (!last || !last.isConnected) return 0;
    if (typeof last.select === 'function') last.select();
    else if (last.isContentEditable) document.getSelection()?.selectAllChildren(last);
    return lastValueLength();
  };

  /** The field that currently has keyboard focus (looking inside shadow roots too). */
  const activeField = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { ok: false };
    last = el;
    const rect = el.getBoundingClientRect();
    return {
      ok: true,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      editable: el.matches(EDITABLE) || el.isContentEditable,
      label: describe(el),
    };
  };

  // ---------------------------------------------------------------- what changed

  const markChanges = () => {
    tracked = new Set();
    return true;
  };

  /** The on-screen area covered by everything that changed since markChanges(), or null. */
  const changeRect = () => {
    const elements = tracked ? [...tracked] : [];
    tracked = null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const el of elements) {
      if (!el.isConnected || el.id === '__demoreel-hide') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height < 256) continue;
      const x0 = Math.max(0, rect.left);
      const y0 = Math.max(0, rect.top);
      const x1 = Math.min(window.innerWidth, rect.right);
      const y1 = Math.min(window.innerHeight, rect.bottom);
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      if (x0 < left) left = x0;
      if (y0 < top) top = y0;
      if (x1 > right) right = x1;
      if (y1 > bottom) bottom = y1;
    }
    if (right < left) return null;
    return { x: left, y: top, w: right - left, h: bottom - top };
  };

  // ---------------------------------------------------------------- state

  const quiet = () => {
    let animating = false;
    if (document.getAnimations) {
      animating = document.getAnimations().some((animation) => {
        if (animation.playState !== 'running' || !animation.effect) return false;
        const timing = animation.effect.getComputedTiming();
        return Number.isFinite(timing.endTime) && timing.endTime < 4000;
      });
    }
    return {
      ready: document.readyState === 'complete',
      sinceMutation: performance.now() - lastMutation,
      animating,
    };
  };

  const pageInfo = () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    return {
      title: document.title,
      url: location.href,
      width: window.innerWidth,
      height: window.innerHeight,
      themeColor: meta ? meta.getAttribute('content') : null,
    };
  };

  window.__demoreel = {
    locate,
    scrollLastIntoView,
    scrollPage,
    selectOption,
    focusLast,
    lastValueLength,
    selectLastContents,
    activeField,
    markChanges,
    changeRect,
    quiet,
    pageInfo,
    cursorAt: (x, y) => cursorKind(document.elementFromPoint(x, y)),
  };
})();
