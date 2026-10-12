// EPUB 2/3 parser: reads the package document, spine, table of contents and
// cover, and turns chapters into self-contained blob: URLs for rendering.

import { ZipArchive, decodeText } from './zip.js';

const NS = {
  opf: 'http://www.idpf.org/2007/opf',
  dc: 'http://purl.org/dc/elements/1.1/',
  ops: 'http://www.idpf.org/2007/ops',
  xlink: 'http://www.w3.org/1999/xlink',
  xhtml: 'http://www.w3.org/1999/xhtml',
};

const MIME_BY_EXT = {
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', xml: 'application/xml',
  css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg',
};

// Element attributes that reference resources inside the book.
const URL_ATTRS = {
  img: ['src'], image: ['href'], source: ['src'], video: ['src', 'poster'], audio: ['src'],
  track: ['src'], object: ['data'], embed: ['src'], use: ['href'], iframe: ['src'], input: ['src'],
};

export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

export function isExternal(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

// Resolve `href` relative to the file at `basePath`. Returns { path, fragment }
// or null for external URLs.
export function resolveHref(basePath, href) {
  if (href == null) return null;
  href = href.trim();
  if (isExternal(href)) return null;
  let fragment = '';
  const hash = href.indexOf('#');
  if (hash >= 0) { fragment = href.slice(hash + 1); href = href.slice(0, hash); }
  const q = href.indexOf('?');
  if (q >= 0) href = href.slice(0, q);
  try { href = decodeURIComponent(href); } catch { /* keep as-is */ }
  try { fragment = decodeURIComponent(fragment); } catch { /* keep as-is */ }
  if (!href) return { path: basePath, fragment };

  const joined = href.startsWith('/') ? href.slice(1) : dirname(basePath) + href;
  const out = [];
  for (const part of joined.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return { path: out.join('/'), fragment };
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    // Some books ship slightly broken XML; the HTML parser is far more forgiving.
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

function byTag(root, ns, local) {
  const list = root.getElementsByTagNameNS(ns, local);
  if (list.length) return [...list];
  // Fallbacks for documents parsed without namespaces.
  const prefixed = root.getElementsByTagName(`dc:${local}`);
  if (prefixed.length) return [...prefixed];
  return [...root.getElementsByTagName(local)];
}

function children(el, local) {
  return [...el.children].filter((c) => c.localName === local);
}

export class Book {
  static async open(buffer) {
    const book = new Book(new ZipArchive(buffer));
    await book._load();
    return book;
  }

  constructor(zip) {
    this.zip = zip;
    this.metadata = { title: '', creator: '', language: '', identifier: '' };
    this.manifest = new Map();      // id -> item
    this.manifestByPath = new Map(); // path -> item
    this.spine = [];
    this.toc = [];
    this.coverPath = null;
    this._resourceUrls = new Map(); // path -> Promise<url>
    this._chapters = new Map();     // spine index -> Promise<html>
    this._allUrls = [];
  }

  async _load() {
    if (!this.zip.has('META-INF/container.xml')) throw new Error('This file is not an EPUB (missing META-INF/container.xml).');
    const container = parseXml(await this.zip.text('META-INF/container.xml'));
    const rootfile = container.getElementsByTagName('rootfile')[0];
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUB container does not point to a package document.');
    this.opfPath = opfPath;

    const opf = parseXml(await this.zip.text(opfPath));
    const text = (local) => {
      const el = byTag(opf, NS.dc, local)[0];
      return el ? el.textContent.trim() : '';
    };
    this.metadata = {
      title: text('title') || 'Untitled',
      creator: byTag(opf, NS.dc, 'creator').map((e) => e.textContent.trim()).filter(Boolean).join(', '),
      language: text('language'),
      identifier: text('identifier'),
      publisher: text('publisher'),
      description: text('description'),
    };

    for (const item of opf.getElementsByTagName('item')) {
      const href = item.getAttribute('href');
      if (!href) continue;
      const resolved = resolveHref(opfPath, href);
      if (!resolved) continue;
      const entry = {
        id: item.getAttribute('id'),
        path: resolved.path,
        mediaType: item.getAttribute('media-type') || '',
        properties: (item.getAttribute('properties') || '').split(/\s+/).filter(Boolean),
      };
      this.manifest.set(entry.id, entry);
      this.manifestByPath.set(entry.path, entry);
    }

    const spineEl = opf.getElementsByTagName('spine')[0];
    if (spineEl) {
      for (const ref of spineEl.getElementsByTagName('itemref')) {
        const item = this.manifest.get(ref.getAttribute('idref'));
        if (!item || !this.zip.has(item.path)) continue;
        const entry = this.zip.getEntry(item.path);
        this.spine.push({
          path: item.path,
          mediaType: item.mediaType,
          linear: ref.getAttribute('linear') !== 'no',
          size: Math.max(entry.size, 1),
        });
      }
    }
    if (!this.spine.length) throw new Error('This EPUB has no readable chapters.');
    this.spine.forEach((s, i) => { s.index = i; });
    this.totalSize = this.spine.reduce((sum, s) => sum + s.size, 0);

    this.coverPath = this._findCover(opf);
    try {
      this.toc = await this._loadToc(spineEl);
    } catch (err) {
      console.warn('Could not read table of contents', err);
    }
    if (!this.toc.length) {
      this.toc = this.spine.map((s, i) => ({ label: `Section ${i + 1}`, path: s.path, fragment: '', children: [] }));
    }
  }

  _findCover(opf) {
    for (const item of this.manifest.values()) {
      if (item.properties.includes('cover-image')) return item.path;
    }
    for (const meta of opf.getElementsByTagName('meta')) {
      if (meta.getAttribute('name') === 'cover') {
        const ref = meta.getAttribute('content');
        const item = this.manifest.get(ref);
        if (item && item.mediaType.startsWith('image/')) return item.path;
        const byPath = ref && resolveHref(this.opfPath, ref);
        if (byPath && this.zip.has(byPath.path)) return byPath.path;
      }
    }
    for (const item of this.manifest.values()) {
      if (item.mediaType.startsWith('image/') && /cover/i.test(item.id + item.path)) return item.path;
    }
    return null;
  }

  async _loadToc(spineEl) {
    const nav = [...this.manifest.values()].find((i) => i.properties.includes('nav'));
    if (nav && this.zip.has(nav.path)) {
      const toc = this._parseNav(parseXml(await this.zip.text(nav.path)), nav.path);
      if (toc.length) return toc;
    }
    const ncxId = spineEl && spineEl.getAttribute('toc');
    const ncx = (ncxId && this.manifest.get(ncxId))
      || [...this.manifest.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml');
    if (ncx && this.zip.has(ncx.path)) {
      return this._parseNcx(parseXml(await this.zip.text(ncx.path)), ncx.path);
    }
    return [];
  }

  _parseNav(doc, basePath) {
    const navs = [...doc.getElementsByTagName('nav')];
    const navEl = navs.find((n) => (n.getAttributeNS(NS.ops, 'type') || n.getAttribute('epub:type') || '').split(/\s+/).includes('toc')) || navs[0];
    if (!navEl) return [];
    const ol = navEl.getElementsByTagName('ol')[0];
    const walk = (list) => children(list, 'li').map((li) => {
      const link = children(li, 'a')[0] || children(li, 'span')[0];
      const sub = children(li, 'ol')[0];
      const href = link && link.getAttribute('href');
      const target = href ? resolveHref(basePath, href) : null;
      return {
        label: (link ? link.textContent : li.textContent).replace(/\s+/g, ' ').trim(),
        path: target ? target.path : null,
        fragment: target ? target.fragment : '',
        children: sub ? walk(sub) : [],
      };
    }).filter((e) => e.label);
    return ol ? walk(ol) : [];
  }

  _parseNcx(doc, basePath) {
    const navMap = doc.getElementsByTagName('navMap')[0];
    if (!navMap) return [];
    const walk = (parent) => children(parent, 'navPoint').map((np) => {
      const label = np.getElementsByTagName('text')[0];
      const content = children(np, 'content')[0];
      const target = content ? resolveHref(basePath, content.getAttribute('src')) : null;
      return {
        label: label ? label.textContent.replace(/\s+/g, ' ').trim() : '',
        path: target ? target.path : null,
        fragment: target ? target.fragment : '',
        children: walk(np),
      };
    }).filter((e) => e.label);
    return walk(navMap);
  }

  spineIndexOf(path) {
    const lower = path.toLowerCase();
    return this.spine.findIndex((s) => s.path === path || s.path.toLowerCase() === lower);
  }

  mimeFor(path) {
    const item = this.manifestByPath.get(path);
    if (item && item.mediaType) return item.mediaType;
    const ext = path.split('.').pop().toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
  }

  async getCoverBlob() {
    if (!this.coverPath || !this.zip.has(this.coverPath)) return null;
    const bytes = await this.zip.bytes(this.coverPath);
    return new Blob([bytes], { type: this.mimeFor(this.coverPath) });
  }

  _blobUrl(data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    this._allUrls.push(url);
    return url;
  }

  // Blob URL for any resource; stylesheets get their own url() references rewritten.
  resourceUrl(path) {
    if (!this._resourceUrls.has(path)) {
      const promise = (async () => {
        if (!this.zip.has(path)) return null;
        const type = this.mimeFor(path);
        if (type === 'text/css') {
          const css = await this._rewriteCss(await this.zip.text(path), path);
          return this._blobUrl(css, 'text/css');
        }
        return this._blobUrl(await this.zip.bytes(path), type);
      })();
      this._resourceUrls.set(path, promise);
    }
    return this._resourceUrls.get(path);
  }

  async _rewriteCss(css, basePath) {
    const re = /url\(\s*(['"]?)([^'")]+?)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;
    const refs = new Set();
    for (const m of css.matchAll(re)) refs.add(m[2] || m[4]);
    const map = new Map();
    await Promise.all([...refs].map(async (ref) => {
      if (ref.startsWith('data:') || ref.startsWith('#')) return;
      const target = resolveHref(basePath, ref);
      if (!target) return;
      const url = await this.resourceUrl(target.path);
      if (url) map.set(ref, url);
    }));
    return css.replace(re, (match, q1, urlRef, q2, importRef) => {
      const ref = urlRef || importRef;
      const url = map.get(ref);
      if (!url) return match;
      return urlRef ? `url("${url}")` : `@import "${url}"`;
    });
  }

  // HTML source for a spine item, with every internal resource rewritten to
  // blob URLs. It is shown via iframe srcdoc, which shares the app's origin even
  // when the app is opened from disk (file://), unlike a blob: document.
  chapterHtml(index) {
    if (!this._chapters.has(index)) {
      this._chapters.set(index, this._buildChapter(this.spine[index]));
    }
    return this._chapters.get(index);
  }

  async _buildChapter(item) {
    const { path } = item;
    const type = this.mimeFor(path);

    // Image-only spine items (including SVG) are wrapped in a minimal page.
    if (type.startsWith('image/')) {
      const url = await this.resourceUrl(path);
      return `<!DOCTYPE html><html><head><title></title></head><body><img src="${url}" alt=""></body></html>`;
    }

    const source = decodeText(await this.zip.bytes(path));

    let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) {
      doc = new DOMParser().parseFromString(source, 'text/html');
    }

    // Books are untrusted content: never run their scripts.
    for (const s of [...doc.getElementsByTagName('script')]) s.remove();

    const jobs = [];
    for (const el of [...doc.getElementsByTagName('*')]) {
      const name = el.localName.toLowerCase();

      if (name === 'link') {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        const target = rel.includes('stylesheet') ? resolveHref(path, el.getAttribute('href')) : null;
        if (!target) { el.remove(); continue; }
        jobs.push(this.resourceUrl(target.path).then((url) => {
          if (url) el.setAttribute('href', url); else el.remove();
        }));
        continue;
      }

      if (name === 'style') {
        jobs.push(this._rewriteCss(el.textContent, path).then((css) => { el.textContent = css; }));
        continue;
      }

      if (el.hasAttribute('style') && el.getAttribute('style').includes('url(')) {
        jobs.push(this._rewriteCss(el.getAttribute('style'), path).then((css) => el.setAttribute('style', css)));
      }

      for (const attr of el.getAttributeNames()) {
        if (/^on/i.test(attr)) el.removeAttribute(attr);
      }

      const attrs = URL_ATTRS[name];
      if (!attrs) continue;
      if (name === 'img') el.removeAttribute('srcset');
      for (const attr of attrs) {
        const candidates = attr === 'href'
          ? [['xlink', el.getAttributeNS(NS.xlink, 'href')], ['plain', el.getAttribute('href')]]
          : [['plain', el.getAttribute(attr)]];
        for (const [kind, value] of candidates) {
          if (!value || value.startsWith('data:') || value.startsWith('#')) continue;
          const target = resolveHref(path, value);
          if (!target) continue;
          jobs.push(this.resourceUrl(target.path).then((url) => {
            if (!url) return;
            if (kind === 'xlink') el.setAttributeNS(NS.xlink, 'xlink:href', url);
            else el.setAttribute(attr, url);
          }));
        }
      }
    }
    await Promise.all(jobs);

    // srcdoc is always parsed as HTML, so move XHTML into an HTML document to get
    // HTML serialization (no self-closing <div/> or <a/> that HTML would misread).
    const html = document.implementation.createHTMLDocument('');
    html.replaceChild(html.importNode(doc.documentElement, true), html.documentElement);
    return `<!DOCTYPE html>\n${html.documentElement.outerHTML}`;
  }

  destroy() {
    for (const url of this._allUrls) URL.revokeObjectURL(url);
    this._allUrls = [];
    this._resourceUrls.clear();
    this._chapters.clear();
  }
}
