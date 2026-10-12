// Renders one spine item at a time inside a sandboxed iframe. Paginated mode
// lays the chapter out in CSS columns and scrolls horizontally page by page;
// scrolled mode lets the chapter flow vertically.

import { isExternal, resolveHref } from './epub.js';

const THEMES = {
  light: { bg: '#ffffff', fg: '#1d1d1f', link: '#0b57d0', force: false },
  sepia: { bg: '#f6efe1', fg: '#4b3b2a', link: '#8a4b14', force: true },
  grey: { bg: '#3a3b3f', fg: '#ecebe7', link: '#a8c7fa', force: true },
  dark: { bg: '#16171a', fg: '#d7d5d0', link: '#8ab4f8', force: true },
};

const FONTS = {
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  dyslexic: '"Comic Sans MS", "Comic Neue", Verdana, sans-serif',
};

// "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" -> [r, g, b, a]; null for other formats.
function parseColor(value) {
  if (value.startsWith('#')) {
    const n = parseInt(value.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (!m) return null;
  let a = m[4] == null ? 1 : parseFloat(m[4]);
  if (m[4] && m[4].endsWith('%')) a /= 100;
  return [+m[1], +m[2], +m[3], a];
}

// Composite a (possibly translucent) colour over an opaque one.
function blend([r, g, b, a], [br, bg, bb]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

// WCAG contrast ratio between two opaque colours.
function contrast(c1, c2) {
  const lum = ([r, g, b]) => {
    const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const [hi, lo] = [lum(c1), lum(c2)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function resolveTheme(name) {
  if (name === 'auto') {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return THEMES[name] ? name : 'light';
}

export class Reader {
  constructor(container, book, { settings, onRelocate, onError }) {
    this.container = container;
    this.book = book;
    this.settings = settings;
    this.onRelocate = onRelocate || (() => {});
    this.onError = onError || ((e) => console.error(e));
    this.index = -1;
    this.page = 0;
    this.pages = 1;
    this.fraction = 0;
    this._loadToken = 0;
    this._wheelLock = 0;
    this.pageCounts = null; // pages per spine item for the current layout
    this._countKey = null;
    this._countToken = 0;
    this._counter = null;

    this.iframe = document.createElement('iframe');
    this.iframe.className = 'reader-frame';
    this.iframe.title = 'Book content';
    // No allow-scripts: book scripts never execute. Same origin lets us style the page.
    this.iframe.setAttribute('sandbox', 'allow-same-origin');
    container.appendChild(this.iframe);

    this._onKey = this._onKey.bind(this);
    this._resizeObserver = new ResizeObserver(() => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this._relayout(), 120);
    });
    this._resizeObserver.observe(container);

    // Clicks in the blank margin beside a centred page turn the page too.
    this._onGutterClick = (e) => {
      if (e.target !== container || !this.paginated) return;
      const rect = container.getBoundingClientRect();
      if (e.clientX - rect.left < rect.width / 2) this.prev(); else this.next();
    };
    container.addEventListener('click', this._onGutterClick);
  }

  get paginated() {
    return this.settings.flow !== 'scrolled';
  }

  get doc() {
    return this.iframe.contentDocument;
  }

  get win() {
    return this.iframe.contentWindow;
  }

  // location: { index, fraction } or { path, fragment }
  async display(location = {}) {
    let { index, fraction = 0, fragment = '' } = location;
    if (location.path != null) {
      index = this.book.spineIndexOf(location.path);
      if (index < 0) return;
    }
    index = Math.min(Math.max(index || 0, 0), this.book.spine.length - 1);

    if (index === this.index && this.doc && this.doc.body) {
      this._goTo({ fraction, fragment, atEnd: location.atEnd });
      return;
    }
    await this._load(index, { fraction, fragment, atEnd: location.atEnd });
  }

  async _load(index, position) {
    const token = ++this._loadToken;
    this._loading = true;
    try {
      await this._loadInner(index, position, token);
    } finally {
      if (token === this._loadToken) this._loading = false;
    }
  }

  async _loadInner(index, position, token) {
    this.iframe.style.visibility = 'hidden';
    let html;
    try {
      html = await this.book.chapterHtml(index);
    } catch (err) {
      if (token === this._loadToken) this.iframe.style.visibility = 'visible';
      this.onError(err);
      return;
    }
    if (token !== this._loadToken) return;

    await new Promise((resolve) => {
      this.iframe.onload = resolve;
      this.iframe.srcdoc = html;
    });
    if (token !== this._loadToken) return;

    this.index = index;
    this._flow = this.settings.flow;
    this._setupDocument();
    try { await this.doc.fonts.ready; } catch { /* not supported */ }
    if (token !== this._loadToken) return;
    this._layout();
    this._goTo(position);
    this.iframe.style.visibility = 'visible';
  }

  _setupDocument() {
    const doc = this.doc;
    if (!doc || !doc.documentElement) return;
    const head = doc.head || doc.getElementsByTagName('head')[0] || doc.documentElement;
    this._contrastTheme = null;
    this._style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
    head.appendChild(this._style);

    doc.addEventListener('keydown', this._onKey);
    doc.addEventListener('click', (e) => this._onClick(e));
    doc.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    doc.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      this._touch = { x: t.clientX, y: t.clientY, time: Date.now() };
    }, { passive: true });
    doc.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: true });
    this.win.addEventListener('scroll', () => this._onScroll());
    // Images can finish decoding late; re-measure so the page count stays right.
    for (const img of doc.querySelectorAll('img, image')) {
      img.addEventListener('load', () => this._relayout(), { once: true });
    }
  }

  _css() {
    const s = this.settings;
    const theme = THEMES[resolveTheme(s.theme)];
    const W = this._width;
    const H = this._height;
    const M = this._margin;
    const V = this._vpad;
    const fontFamily = FONTS[s.fontFamily];
    const lines = [];

    lines.push(`html { font-size: ${s.fontSize}% !important; -webkit-text-size-adjust: none; text-size-adjust: none; }`);
    lines.push(`html, body { background: ${theme.bg} !important; color: ${theme.fg} !important; }`);
    lines.push(`a, a * { color: ${theme.link} !important; }`);
    if (theme.force) {
      lines.push('body *:not(a) { color: inherit !important; background-color: transparent !important; }');
    }
    if (fontFamily) {
      lines.push(`body { font-family: ${fontFamily} !important; }`);
      lines.push('body *:not(pre):not(code):not(kbd):not(samp):not(tt) { font-family: inherit !important; }');
    }
    if (s.lineHeight !== 'publisher') {
      lines.push(`body, body p, body div, body li, body blockquote, body dd { line-height: ${s.lineHeight} !important; }`);
    }
    if (s.justify) {
      lines.push('body p { text-align: justify !important; hyphens: auto; -webkit-hyphens: auto; }');
    }
    lines.push('::selection { background: rgba(255, 196, 0, 0.45); }');

    if (this.paginated) {
      const cols = this._cols;
      lines.push(`html { width: ${W}px !important; height: ${H}px !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; max-width: none !important; }`);
      lines.push(`body { box-sizing: border-box !important; width: auto !important; max-width: none !important; height: ${H}px !important;
        min-height: 0 !important; margin: 0 ${M}px !important; padding: ${V}px 0 !important; overflow: visible !important;
        column-count: ${cols} !important; column-gap: ${2 * M}px !important; column-fill: auto !important; column-width: auto !important; }`);
      lines.push(`img, svg, video, image { max-width: 100% !important; max-height: ${H - 2 * V}px !important; object-fit: contain; box-sizing: border-box; break-inside: avoid; }`);
      lines.push('h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; }');
      lines.push('p, li, blockquote { orphans: 2; widows: 2; }');
    } else {
      lines.push('html { overflow-x: hidden !important; overflow-y: auto !important; height: auto !important; }');
      lines.push(`body { box-sizing: border-box !important; max-width: ${s.pageWidth === 'wide' ? 'none' : '46em'} !important; margin: 0 auto !important; padding: ${V}px ${M}px ${V * 2}px !important; }`);
      lines.push('img, svg, video { max-width: 100% !important; height: auto; }');
    }
    return lines.join('\n');
  }

  _measure() {
    const rect = this.container.getBoundingClientRect();
    const available = Math.max(200, Math.floor(rect.width));
    const H = Math.max(200, Math.floor(rect.height));
    const scale = { narrow: 0.6, normal: 1, wide: 1.6 }[this.settings.margins] || 1;
    const wide = this.settings.pageWidth === 'wide';

    if (this.paginated) {
      this._cols = this.settings.spread !== 'single' && available >= 1000 ? 2 : 1;
      // Normal: each page keeps a book-like 3:4 shape (capped for line length)
      // and the spread is centred. Wide: pages share all available width.
      const pageW = wide
        ? available / this._cols
        : Math.min(available / this._cols, Math.max(320, H * 0.75), 760);
      this._width = Math.floor(pageW * this._cols);
      this._margin = Math.round((pageW < 500 ? 20 : Math.min(64, Math.max(28, pageW * 0.07))) * scale);
    } else {
      this._cols = 1;
      this._width = available;
      this._margin = Math.round((available < 600 ? 20 : Math.min(72, Math.max(32, available * 0.05))) * scale);
    }
    this._height = H;
    this._vpad = H < 500 ? 20 : 40;
    this.iframe.style.width = `${this._width}px`;
    this.iframe.style.height = `${H}px`;
  }

  _layout() {
    if (!this.doc || !this._style) return;
    this._measure();
    this._style.textContent = this._css();
    this._fixContrast();
    this._countPages();
    if (this.paginated) {
      const key = this._layoutKey();
      if (key !== this._countKey) {
        this._countKey = key;
        this.pageCounts = new Array(this.book.spine.length).fill(null);
        this._countAllPages();
      }
      this.pageCounts[this.index] = this.pages;
    }
  }

  // Everything that changes how many pages a chapter takes.
  _layoutKey() {
    const s = this.settings;
    return JSON.stringify([this._width, this._height, this._cols, this._margin, this._vpad,
      s.fontSize, s.fontFamily, s.lineHeight, s.justify]);
  }

  // Lays out every chapter in a hidden frame with the current settings to get
  // whole-book page numbers. Restarts whenever the layout key changes.
  async _countAllPages() {
    const token = ++this._countToken;
    await new Promise((r) => setTimeout(r, 300)); // let the visible chapter render first
    if (token !== this._countToken) return;

    if (!this._counter) {
      this._counter = document.createElement('iframe');
      this._counter.setAttribute('sandbox', 'allow-same-origin');
      this._counter.setAttribute('aria-hidden', 'true');
      this._counter.tabIndex = -1;
      this._counter.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;border:0;';
      this.container.appendChild(this._counter);
    }
    const frame = this._counter;
    const W = this._width;
    const M = this._margin;
    const css = this._css();
    frame.style.width = `${W}px`;
    frame.style.height = `${this._height}px`;

    for (let i = 0; i < this.book.spine.length; i++) {
      if (token !== this._countToken) return;
      if (this.pageCounts[i] != null) continue;
      try {
        const html = await this.book.chapterHtml(i);
        if (token !== this._countToken) return;
        await new Promise((resolve) => {
          frame.onload = resolve;
          frame.srcdoc = html;
        });
        const doc = frame.contentDocument;
        const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
        style.textContent = css;
        (doc.head || doc.documentElement).appendChild(style);
        try { await doc.fonts.ready; } catch { /* not supported */ }
        if (token !== this._countToken) return;
        const el = doc.scrollingElement || doc.documentElement;
        if (this.pageCounts[i] == null) this.pageCounts[i] = Math.max(1, Math.ceil((el.scrollWidth - M - 1) / W));
      } catch (err) {
        console.warn('Could not count pages for chapter', i, err);
        this.pageCounts[i] = 1;
      }
    }
    frame.removeAttribute('srcdoc');
    if (token === this._countToken && this.index >= 0) this._emit();
  }

  // Themes that keep the publisher's colours (Light) can leave text unreadable,
  // e.g. white text designed for a dark page. Recolour only text whose contrast
  // against what is actually behind it is too low; other colours stay as-is.
  _fixContrast() {
    const themeName = resolveTheme(this.settings.theme);
    if (this._contrastTheme === themeName) return;
    this._contrastTheme = themeName;
    const doc = this.doc;

    for (const el of doc.querySelectorAll('[data-folio-color]')) {
      const [value, priority] = JSON.parse(el.dataset.folioColor);
      if (value) el.style.setProperty('color', value, priority); else el.style.removeProperty('color');
      delete el.dataset.folioColor;
    }
    const theme = THEMES[themeName];
    if (theme.force || !doc.body) return;

    const pageBg = parseColor(theme.bg);
    const bgCache = new Map();
    const backgroundOf = (el) => {
      if (!el || el.nodeType !== 1) return pageBg;
      if (bgCache.has(el)) return bgCache.get(el);
      const own = parseColor(this.win.getComputedStyle(el).backgroundColor);
      const under = backgroundOf(el.parentElement);
      const result = own && own[3] > 0 ? blend(own, under) : under;
      bgCache.set(el, result);
      return result;
    };

    for (const el of [doc.body, ...doc.body.querySelectorAll('*')]) {
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (!hasText) continue;
      const fg = parseColor(this.win.getComputedStyle(el).color);
      if (!fg) continue;
      const bg = backgroundOf(el);
      if (contrast(blend(fg, bg), bg) >= 3) continue;
      const dark = [29, 29, 31, 1];
      const light = [255, 255, 255, 1];
      const replacement = contrast(dark, bg) >= contrast(light, bg) ? dark : light;
      el.dataset.folioColor = JSON.stringify([el.style.getPropertyValue('color'), el.style.getPropertyPriority('color')]);
      el.style.setProperty('color', `rgb(${replacement.slice(0, 3).join(',')})`, 'important');
    }
  }

  _countPages() {
    const el = this.doc.scrollingElement || this.doc.documentElement;
    if (this.paginated) {
      this.pages = Math.max(1, Math.ceil((el.scrollWidth - this._margin - 1) / this._width));
    } else {
      this.pages = 1;
    }
  }

  _relayout() {
    if (this.index < 0 || !this.doc || !this._style) return;
    const fraction = this.fraction;
    this._layout();
    this._goTo({ fraction });
  }

  _goTo({ fraction = 0, fragment = '', atEnd = false } = {}) {
    const el = this.doc.scrollingElement || this.doc.documentElement;
    const target = fragment ? (this.doc.getElementById(fragment) || this.doc.getElementsByName(fragment)[0]) : null;

    if (this.paginated) {
      let page;
      if (atEnd) page = this.pages - 1;
      else if (target) {
        const rect = target.getBoundingClientRect();
        page = Math.floor((rect.left + this.win.scrollX) / this._width);
      } else page = Math.floor(fraction * this.pages + 1e-6);
      this._showPage(page);
    } else {
      const max = Math.max(0, el.scrollHeight - this._height);
      let top;
      if (atEnd) top = max;
      else if (target) top = target.getBoundingClientRect().top + this.win.scrollY - 16;
      else top = fraction * max;
      this.win.scrollTo(0, Math.max(0, top));
      this._reportScroll();
    }
  }

  _showPage(page) {
    this.page = Math.min(Math.max(0, page), this.pages - 1);
    this._expectedScroll = this.page * this._width;
    this.win.scrollTo(this._expectedScroll, 0);
    this.fraction = this.pages > 1 ? this.page / this.pages : 0;
    this._emit();
  }

  _reportScroll() {
    const el = this.doc.scrollingElement || this.doc.documentElement;
    const max = Math.max(1, el.scrollHeight - this._height);
    this.fraction = Math.min(1, this.win.scrollY / max);
    this._emit();
  }

  _emit() {
    let bookPage = null;
    let bookPages = null;
    if (this.paginated && this.pageCounts && this.pageCounts.every((c) => c != null)) {
      bookPages = this.pageCounts.reduce((a, b) => a + b, 0);
      bookPage = this.pageCounts.slice(0, this.index).reduce((a, b) => a + b, 0) + this.page + 1;
    }
    this.onRelocate({
      index: this.index,
      fraction: this.fraction,
      page: this.page,
      pages: this.pages,
      bookPage,
      bookPages,
      atStart: this.index === 0 && this._atChapterStart(),
      atEnd: this.index === this.book.spine.length - 1 && this._atChapterEnd(),
    });
  }

  _atChapterStart() {
    return this.paginated ? this.page === 0 : this.win.scrollY <= 2;
  }

  _atChapterEnd() {
    if (this.paginated) return this.page >= this.pages - 1;
    const el = this.doc.scrollingElement || this.doc.documentElement;
    return this.win.scrollY + this._height >= el.scrollHeight - 2;
  }

  _onScroll() {
    if (this.paginated) {
      // Keep focus/selection changes from leaving the page half-scrolled.
      if (this._expectedScroll != null && Math.abs(this.win.scrollX - this._expectedScroll) > 1) {
        this.win.scrollTo(this._expectedScroll, 0);
      }
      return;
    }
    clearTimeout(this._scrollTimer);
    this._scrollTimer = setTimeout(() => this._reportScroll(), 100);
  }

  async next() {
    if (this.index < 0 || this._loading) return;
    if (this.paginated) {
      if (this.page < this.pages - 1) return this._showPage(this.page + 1);
    } else if (!this._atChapterEnd()) {
      this.win.scrollBy({ top: this._height - 48, behavior: 'smooth' });
      return;
    }
    if (this.index < this.book.spine.length - 1) await this._load(this.index + 1, { fraction: 0 });
  }

  async prev() {
    if (this.index < 0 || this._loading) return;
    if (this.paginated) {
      if (this.page > 0) return this._showPage(this.page - 1);
    } else if (!this._atChapterStart()) {
      this.win.scrollBy({ top: -(this._height - 48), behavior: 'smooth' });
      return;
    }
    if (this.index > 0) await this._load(this.index - 1, { atEnd: true });
  }

  // True when the element with this id is on the current page or an earlier one.
  fragmentReached(fragment) {
    const el = this.doc && this.doc.getElementById(fragment);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return this.paginated ? rect.left < this._width : rect.top < this._height / 2;
  }

  goToHref(path, fragment) {
    return this.display({ path, fragment });
  }

  applySettings(settings) {
    this.settings = settings;
    if (this.index < 0) return;
    // Switching flow needs a fresh document so scroll state starts clean.
    if (this._flow !== settings.flow) return this._load(this.index, { fraction: this.fraction });
    this._relayout();
  }

  setKeyHandler(fn) {
    this._externalKey = fn;
  }

  _onKey(e) {
    if (this._externalKey) this._externalKey(e);
  }

  _onClick(e) {
    const link = e.target.closest && e.target.closest('a');
    const href = link && (link.getAttribute('href') || link.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
    if (href) {
      e.preventDefault();
      if (isExternal(href)) {
        if (/^(https?|mailto):/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      const target = resolveHref(this.book.spine[this.index].path, href);
      if (target) this.goToHref(target.path, target.fragment).catch(this.onError);
      return;
    }
    if (!this.paginated) return;
    const selection = this.win.getSelection();
    if (selection && !selection.isCollapsed) return;
    const ratio = e.clientX / this._width;
    if (ratio < 0.25) this.prev();
    else if (ratio > 0.75) this.next();
  }

  _onWheel(e) {
    if (!this.paginated) return;
    e.preventDefault();
    const now = Date.now();
    if (now < this._wheelLock) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 4) return;
    this._wheelLock = now + 350;
    if (delta > 0) this.next(); else this.prev();
  }

  _onTouchEnd(e) {
    if (!this.paginated || !this._touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - this._touch.x;
    const dy = t.clientY - this._touch.y;
    if (Date.now() - this._touch.time < 800 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) this.next(); else this.prev();
    }
    this._touch = null;
  }

  destroy() {
    this._loadToken++;
    this._countToken++;
    this._resizeObserver.disconnect();
    clearTimeout(this._resizeTimer);
    this.container.removeEventListener('click', this._onGutterClick);
    this.iframe.remove();
    if (this._counter) this._counter.remove();
  }
}
