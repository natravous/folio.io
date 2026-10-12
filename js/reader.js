// Renders one spine item at a time inside a sandboxed iframe. Paginated mode
// lays the chapter out in CSS columns and scrolls horizontally page by page;
// scrolled mode lets the chapter flow vertically.

import { isExternal, resolveHref } from './epub.js';

const THEMES = {
  light: { bg: '#ffffff', fg: '#1d1d1f', link: '#0b57d0', force: false },
  sepia: { bg: '#f6efe1', fg: '#4b3b2a', link: '#8a4b14', force: true },
  dark: { bg: '#16171a', fg: '#d7d5d0', link: '#8ab4f8', force: true },
};

const FONTS = {
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  dyslexic: '"Comic Sans MS", "Comic Neue", Verdana, sans-serif',
};

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
    let url;
    try {
      url = await this.book.chapterUrl(index);
    } catch (err) {
      if (token === this._loadToken) this.iframe.style.visibility = 'visible';
      this.onError(err);
      return;
    }
    if (token !== this._loadToken) return;

    await new Promise((resolve) => {
      this.iframe.onload = resolve;
      this.iframe.src = url;
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
      lines.push(`body { box-sizing: border-box !important; max-width: 46em !important; margin: 0 auto !important; padding: ${V}px ${M}px ${V * 2}px !important; }`);
      lines.push('img, svg, video { max-width: 100% !important; height: auto; }');
    }
    return lines.join('\n');
  }

  _measure() {
    const rect = this.container.getBoundingClientRect();
    this._width = Math.max(200, Math.floor(rect.width));
    this._height = Math.max(200, Math.floor(rect.height));
    const W = this._width;
    const scale = { narrow: 0.6, normal: 1, wide: 1.6 }[this.settings.margins] || 1;
    this._margin = Math.round((W < 600 ? 20 : Math.min(72, Math.max(32, W * 0.05))) * scale);
    this._vpad = this._height < 500 ? 20 : 40;
    this._cols = this.settings.spread !== 'single' && W >= 1000 ? 2 : 1;
    this.iframe.style.width = `${W}px`;
    this.iframe.style.height = `${this._height}px`;
  }

  _layout() {
    if (!this.doc || !this._style) return;
    this._measure();
    this._style.textContent = this._css();
    this._countPages();
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
    this.onRelocate({
      index: this.index,
      fraction: this.fraction,
      page: this.page,
      pages: this.pages,
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
    this._resizeObserver.disconnect();
    clearTimeout(this._resizeTimer);
    this.iframe.remove();
  }
}
