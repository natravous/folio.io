import { Book } from './epub.js';
import { Reader, resolveTheme } from './reader.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);

const SETTINGS_VERSION = 2;
const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  theme: 'grey',
  fontSize: 100,
  fontFamily: 'publisher',
  lineHeight: 'publisher',
  margins: 'normal',
  flow: 'paginated',
  spread: 'auto',
  pageWidth: 'normal',
  justify: false,
};
const THEME_COLORS = { light: '#ffffff', sepia: '#f6efe1', grey: '#3a3b3f', dark: '#16171a' };

let settings = loadSettings();
let current = null; // { id, meta, book, reader, cumulative, tocFlat }
let coverUrls = [];
let saveTimer = null;
let warnedNotPersistent = false;

// ---------- Settings ----------

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('folio-settings') || '{}');
    // v2 made Grey the default theme: books with white or pale text were
    // unreadable on the old white default, so move Auto/Light users over once.
    if ((saved.version || 1) < 2 && (saved.theme === 'auto' || saved.theme === 'light')) saved.theme = 'grey';
    return { ...DEFAULT_SETTINGS, ...saved, version: SETTINGS_VERSION };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try { localStorage.setItem('folio-settings', JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

function applyAppTheme() {
  const theme = resolveTheme(settings.theme);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', THEME_COLORS[theme]);
}

function syncSettingsUI() {
  for (const group of document.querySelectorAll('.segmented[data-setting]')) {
    for (const btn of group.querySelectorAll('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.value === settings[group.dataset.setting]));
    }
  }
  for (const select of document.querySelectorAll('select[data-setting]')) {
    select.value = settings[select.dataset.setting];
  }
  for (const box of document.querySelectorAll('input[type="checkbox"][data-setting]')) {
    box.checked = !!settings[box.dataset.setting];
  }
  $('font-size-value').textContent = `${settings.fontSize}%`;
}

function updateSetting(key, value) {
  settings = { ...settings, [key]: value };
  saveSettings();
  syncSettingsUI();
  applyAppTheme();
  if (current) current.reader.applySettings(settings);
}

function bindSettings() {
  for (const group of document.querySelectorAll('.segmented[data-setting]')) {
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn) updateSetting(group.dataset.setting, btn.dataset.value);
    });
  }
  for (const select of document.querySelectorAll('select[data-setting]')) {
    select.addEventListener('change', () => updateSetting(select.dataset.setting, select.value));
  }
  for (const box of document.querySelectorAll('input[type="checkbox"][data-setting]')) {
    box.addEventListener('change', () => updateSetting(box.dataset.setting, box.checked));
  }
  $('font-smaller').addEventListener('click', () => updateSetting('fontSize', Math.max(60, settings.fontSize - 10)));
  $('font-larger').addEventListener('click', () => updateSetting('fontSize', Math.min(250, settings.fontSize + 10)));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme !== 'auto') return;
    applyAppTheme();
    if (current) current.reader.applySettings(settings);
  });
}

// ---------- Toasts ----------

function toast(message, { error = false, timeout = 3500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  $('toast-region').appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

// ---------- Library ----------

function hueFor(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

async function renderLibrary() {
  for (const url of coverUrls) URL.revokeObjectURL(url);
  coverUrls = [];

  const books = await db.listBooks();
  books.sort((a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
  const grid = $('book-grid');
  grid.replaceChildren();
  $('empty-state').hidden = books.length > 0;

  for (const meta of books) {
    const li = document.createElement('li');
    li.className = 'card';

    const open = document.createElement('button');
    open.className = 'card-open';
    open.setAttribute('aria-label', `Open ${meta.title}`);
    open.addEventListener('click', () => { location.hash = `#/book/${meta.id}`; });

    const cover = document.createElement('div');
    cover.className = 'cover';
    if (meta.cover) {
      const img = document.createElement('img');
      const url = URL.createObjectURL(meta.cover);
      coverUrls.push(url);
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      cover.appendChild(img);
    } else {
      const hue = hueFor(meta.title);
      const fb = document.createElement('div');
      fb.className = 'cover-fallback';
      fb.style.background = `linear-gradient(160deg, hsl(${hue} 45% 38%), hsl(${(hue + 40) % 360} 50% 22%))`;
      const t = document.createElement('div');
      t.className = 'cf-title';
      t.textContent = meta.title;
      const a = document.createElement('div');
      a.className = 'cf-author';
      a.textContent = meta.author;
      fb.append(t, a);
      cover.appendChild(fb);
    }
    open.appendChild(cover);

    const info = document.createElement('div');
    info.className = 'card-meta';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = meta.title;
    const author = document.createElement('div');
    author.className = 'card-author';
    author.textContent = meta.author || 'Unknown author';
    info.append(title, author);

    const pct = Math.round((meta.progress || 0) * 100);
    const progress = document.createElement('div');
    progress.className = 'card-progress';
    if (meta.lastOpened) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      const label = document.createElement('span');
      label.textContent = `${pct}%`;
      progress.append(bar, label);
    } else {
      progress.textContent = 'New';
    }
    info.appendChild(progress);
    open.appendChild(info);

    const del = document.createElement('button');
    del.className = 'card-delete';
    del.title = 'Remove from library';
    del.setAttribute('aria-label', `Remove ${meta.title}`);
    del.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove “${meta.title}” from this device?`)) return;
      await db.deleteBook(meta.id);
      renderLibrary();
    });

    li.append(open, del);
    grid.appendChild(li);
  }
}

async function bookId(buffer, file) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // crypto.subtle needs a secure context; fall back to file attributes.
    return `f-${file.size}-${file.lastModified}-${file.name}`.replace(/[^\w.-]/g, '_');
  }
}

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => /\.epub$/i.test(f.name) || f.type === 'application/epub+zip');
  if (!files.length) {
    toast('Please choose .epub files.', { error: true });
    return [];
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const added = [];
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const id = await bookId(buffer, file);
      if (await db.getBook(id)) {
        toast(`Already in your library: ${file.name}`);
        added.push(id);
        continue;
      }
      const book = await Book.open(buffer);
      const cover = await book.getCoverBlob().catch(() => null);
      await db.addBook({
        id,
        title: book.metadata.title || file.name.replace(/\.epub$/i, ''),
        author: book.metadata.creator,
        cover,
        fileName: file.name,
        size: file.size,
        addedAt: Date.now(),
        lastOpened: 0,
        location: null,
        progress: 0,
      }, new Blob([buffer], { type: 'application/epub+zip' }));
      book.destroy();
      added.push(id);
      toast(`Added “${book.metadata.title}”`);
    } catch (err) {
      console.error(err);
      toast(`Couldn't open ${file.name}: ${err.message}`, { error: true, timeout: 6000 });
    }
  }
  if (added.length && !warnedNotPersistent && !(await db.isPersistent())) {
    warnedNotPersistent = true;
    toast('This browser won’t let Folio save books here, so they’ll be gone when you close the tab. Host Folio on a website to keep a library.', { timeout: 9000 });
  }
  await renderLibrary();
  return added;
}

// ---------- Reader ----------

function flattenToc(items, book, depth = 0, out = []) {
  for (const item of items) {
    out.push({ ...item, depth, spineIndex: item.path ? book.spineIndexOf(item.path) : -1 });
    flattenToc(item.children, book, depth + 1, out);
  }
  return out;
}

function renderToc() {
  const { book } = current;
  const list = $('toc-list');
  list.replaceChildren();
  let n = 0;
  const build = (items) => {
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = item.label;
      btn.dataset.tocIndex = String(n++);
      if (!item.path || book.spineIndexOf(item.path) < 0) btn.disabled = true;
      btn.addEventListener('click', () => {
        closePanels();
        current.reader.goToHref(item.path, item.fragment).catch(showError);
      });
      li.appendChild(btn);
      if (item.children.length) li.appendChild(build(item.children));
      ul.appendChild(li);
    }
    return ul;
  };
  list.appendChild(build(book.toc));
}

// The TOC entry for a location is the last one that starts at or before it.
function currentTocIndex(index) {
  let best = -1;
  current.tocFlat.forEach((item, i) => {
    if (item.spineIndex < 0 || item.spineIndex > index) return;
    if (item.spineIndex === index && item.fragment && !current.reader.fragmentReached(item.fragment)) return;
    if (best < 0 || item.spineIndex >= current.tocFlat[best].spineIndex) best = i;
  });
  return best;
}

function onRelocate(loc) {
  if (!current) return;
  const { book, cumulative } = current;
  const progress = Math.min(1, (cumulative[loc.index] + loc.fraction * book.spine[loc.index].size) / book.totalSize);
  const pct = Math.round(progress * 100);
  $('progress').value = String(Math.round(progress * 1000));
  $('progress-text').textContent = `${pct}%`;

  const tocIndex = currentTocIndex(loc.index);
  $('chapter-title').textContent = tocIndex >= 0 ? current.tocFlat[tocIndex].label : '';
  for (const btn of $('toc-list').querySelectorAll('button.active')) btn.classList.remove('active');
  const activeBtn = $('toc-list').querySelector(`button[data-toc-index="${tocIndex}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  const info = $('page-info');
  if (settings.flow === 'scrolled') {
    info.textContent = `Section ${loc.index + 1} of ${book.spine.length}`;
    info.title = '';
  } else if (loc.bookPages) {
    info.textContent = compactFooter() ? `${loc.bookPage} / ${loc.bookPages}` : `Page ${loc.bookPage} of ${loc.bookPages}`;
    info.title = `Page ${loc.page + 1} of ${loc.pages} in this section`;
  } else {
    // Whole-book numbers appear once every chapter has been laid out.
    info.textContent = compactFooter()
      ? `p. ${loc.page + 1}/${loc.pages}…`
      : `Page ${loc.page + 1} of ${loc.pages} · counting…`;
    info.title = 'Counting pages in the whole book';
  }
  $('btn-prev').disabled = $('foot-prev').disabled = !!loc.atStart;
  $('btn-next').disabled = $('foot-next').disabled = !!loc.atEnd;

  const { id } = current;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    db.updateBook(id, { location: { index: loc.index, fraction: loc.fraction }, progress, lastOpened: Date.now() });
  }, 400);
}

// Phones get a short "22 / 74" so the footer fits next to the page buttons.
function compactFooter() {
  return matchMedia('(max-width: 699px)').matches;
}

function showError(err) {
  console.error(err);
  toast(err && err.message ? err.message : String(err), { error: true, timeout: 6000 });
}

async function openBook(id) {
  closeBook();
  showView('reader');
  $('viewer-loading').hidden = false;
  $('book-title').textContent = '';
  $('chapter-title').textContent = '';
  try {
    const meta = await db.getBook(id);
    const blob = meta && await db.getFile(id);
    if (!blob) throw new Error('That book is no longer in your library.');
    const book = await Book.open(await blob.arrayBuffer());

    const cumulative = [];
    book.spine.reduce((sum, s, i) => { cumulative[i] = sum; return sum + s.size; }, 0);
    current = { id, meta, book, cumulative, tocFlat: flattenToc(book.toc, book) };
    document.title = `${meta.title} — Folio`;
    $('book-title').textContent = meta.title;
    renderToc();

    current.reader = new Reader($('viewer'), book, { settings, onRelocate, onError: showError });
    current.reader.setKeyHandler(onKey);
    const start = meta.location || { index: Math.max(0, book.spine.findIndex((s) => s.linear)) };
    await current.reader.display(start);
    db.updateBook(id, { lastOpened: Date.now() });
  } catch (err) {
    showError(err);
    location.hash = '';
  } finally {
    $('viewer-loading').hidden = true;
  }
}

function closeBook() {
  closePanels();
  if (!current) return;
  clearTimeout(saveTimer);
  if (current.reader) {
    const r = current.reader;
    if (r.index >= 0) {
      const progress = Number($('progress').value) / 1000;
      db.updateBook(current.id, { location: { index: r.index, fraction: r.fraction }, progress, lastOpened: Date.now() });
    }
    r.destroy();
  }
  current.book.destroy();
  current = null;
  document.title = 'Folio — EPUB Reader';
}

function seek(overall) {
  if (!current) return;
  const { book, cumulative } = current;
  const target = overall * book.totalSize;
  let index = 0;
  while (index < book.spine.length - 1 && cumulative[index + 1] <= target) index++;
  const fraction = Math.min(0.999, Math.max(0, (target - cumulative[index]) / book.spine[index].size));
  current.reader.display({ index, fraction }).catch(showError);
}

// ---------- Panels ----------

function openPanel(name) {
  const panel = $(name === 'toc' ? 'toc-panel' : 'settings-panel');
  const wasOpen = !panel.hidden;
  closePanels();
  if (wasOpen) return;
  panel.hidden = false;
  $('scrim').hidden = false;
  $(name === 'toc' ? 'btn-toc' : 'btn-settings').setAttribute('aria-expanded', 'true');
  if (name === 'toc') {
    const active = panel.querySelector('button.active');
    if (active) active.scrollIntoView({ block: 'center' });
    (active || panel.querySelector('button:not([data-close])'))?.focus();
  } else {
    panel.querySelector('button, select, input')?.focus();
  }
}

function closePanels() {
  $('toc-panel').hidden = true;
  $('settings-panel').hidden = true;
  $('scrim').hidden = true;
  $('btn-toc').setAttribute('aria-expanded', 'false');
  $('btn-settings').setAttribute('aria-expanded', 'false');
}

function panelsOpen() {
  return !$('toc-panel').hidden || !$('settings-panel').hidden;
}

// ---------- Keyboard ----------

function onKey(e) {
  if (!current || $('reader-view').hidden) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    if (e.key === 'Escape') closePanels();
    return;
  }
  if (e.key === 'Escape') {
    if (panelsOpen()) { closePanels(); e.preventDefault(); }
    return;
  }
  if (panelsOpen()) return;
  const paginated = settings.flow !== 'scrolled';
  switch (e.key) {
    case 'ArrowRight':
    case 'PageDown':
      e.preventDefault(); current.reader.next(); break;
    case 'ArrowLeft':
    case 'PageUp':
      e.preventDefault(); current.reader.prev(); break;
    case ' ':
      e.preventDefault();
      if (e.shiftKey) current.reader.prev(); else current.reader.next();
      break;
    case 'ArrowDown':
      if (paginated) { e.preventDefault(); current.reader.next(); }
      break;
    case 'ArrowUp':
      if (paginated) { e.preventDefault(); current.reader.prev(); }
      break;
    case 't':
    case 'T':
      openPanel('toc'); break;
    default:
  }
}

// ---------- Routing & views ----------

function showView(name) {
  $('library-view').hidden = name !== 'library';
  $('reader-view').hidden = name !== 'reader';
}

async function route() {
  const match = location.hash.match(/^#\/book\/(.+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (!current || current.id !== id) await openBook(id);
  } else {
    closeBook();
    showView('library');
    await renderLibrary();
  }
}

// ---------- Drag & drop, file handling ----------

function bindDragDrop() {
  let depth = 0;
  const overlay = $('drop-overlay');
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const ids = await importFiles(e.dataTransfer.files);
    if (ids.length === 1 && $('library-view').hidden === false) location.hash = `#/book/${ids[0]}`;
  });

  // Installed app on desktop: "Open with Folio" from the file manager.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return;
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      const ids = await importFiles(files);
      if (ids.length) location.hash = `#/book/${ids[0]}`;
    });
  }
}

// ---------- Offline support ----------

function registerServiceWorker() {
  const status = $('offline-status');
  const show = (icon, text) => {
    status.innerHTML = `<svg class="icon"><use href="#${icon}"/></svg><span class="pill-text"></span>`;
    status.querySelector('.pill-text').textContent = text;
    status.title = text;
    status.hidden = false;
  };
  const refresh = () => {
    if (!navigator.onLine) show('i-cloud-off', 'Offline');
    else if (navigator.serviceWorker && navigator.serviceWorker.controller) show('i-check', 'Works offline');
    else status.hidden = true;
  };
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);

  // Opened straight from disk (single-file build): nothing to cache, already offline.
  if (location.protocol === 'file:') { show('i-check', 'Works offline'); return; }
  if (!('serviceWorker' in navigator)) { refresh(); return; }
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker && worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('An update is ready — it will be used next time you open Folio.', { timeout: 6000 });
        }
      });
    });
  }).catch((err) => console.warn('Service worker registration failed', err));
  navigator.serviceWorker.addEventListener('controllerchange', refresh);
  navigator.serviceWorker.ready.then(refresh);
  refresh();
}

// ---------- Init ----------

function init() {
  applyAppTheme();
  syncSettingsUI();
  bindSettings();
  bindDragDrop();

  $('file-input').addEventListener('change', async (e) => {
    const ids = await importFiles(e.target.files);
    e.target.value = '';
    if (ids.length === 1) location.hash = `#/book/${ids[0]}`;
  });
  $('btn-library').addEventListener('click', () => { location.hash = ''; });
  $('btn-toc').addEventListener('click', () => openPanel('toc'));
  $('btn-settings').addEventListener('click', () => openPanel('settings'));
  $('scrim').addEventListener('click', closePanels);
  for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', closePanels);
  $('btn-prev').addEventListener('click', () => current && current.reader.prev());
  $('btn-next').addEventListener('click', () => current && current.reader.next());
  $('foot-prev').addEventListener('click', () => current && current.reader.prev());
  $('foot-next').addEventListener('click', () => current && current.reader.next());
  $('progress').addEventListener('input', (e) => {
    $('progress-text').textContent = `${Math.round(Number(e.target.value) / 10)}%`;
  });
  $('progress').addEventListener('change', (e) => seek(Number(e.target.value) / 1000));
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', () => {
    if (current && current.reader.index >= 0) {
      db.updateBook(current.id, { location: { index: current.reader.index, fraction: current.reader.fraction } });
    }
  });

  registerServiceWorker();
  route();
}

init();
