# Folio — offline EPUB reader

Folio is an EPUB reader that runs entirely in the browser. You host it as a plain static website. After the first visit it works with no network connection, and the books people add never leave their device.

## Features

- **Works offline.** A service worker precaches the app, and books are stored in IndexedDB. People can also install it as an app (PWA).
- **No dependencies and no build step.** It's plain HTML, CSS and ES modules. ZIP decompression uses the browser's built-in `DecompressionStream`.
- **Library:** add books by drag-and-drop or the file picker. It shows covers, remembers your reading position and progress, and detects duplicate files.
- **Reader:**
  - Paginated mode (two columns on wide screens) or continuous scroll mode
  - Table of contents (EPUB 3 nav or EPUB 2 NCX) that highlights the current chapter
  - Progress slider for jumping anywhere in the book
  - Internal links and footnotes work; external links open in a new tab
- **Display settings:** Grey (the default), Auto, Light, Sepia or Dark theme; text size; font; line spacing; margins; justified text.
- **Navigation:** arrow keys, PageUp/PageDown, Space, mouse wheel, tapping the left or right edge, swiping, or `T` to open the contents.
- **Safe rendering:** scripts inside books are removed, and each chapter is shown in a sandboxed iframe that cannot run scripts.

## Running locally

### Option A: single file, no server

`dist/folio.html` is the whole app in one file. Double-click it to open it in your browser, or copy it to a USB stick or another computer. Chrome and Edge also save your library and reading position.

After changing the source, rebuild it:

```bash
node tools/build-single.mjs
```

The single file doesn't install as an app and doesn't need a service worker, because a file on disk is already offline. If a browser won't let a page opened from disk store data, Folio still opens books but warns that they'll be gone when you close the tab.

### Option B: serve the folder

The multi-file version uses ES modules and a service worker. Browsers block both for pages opened from disk, so serve the folder over HTTP:

```bash
npx serve .
```

```bash
python -m http.server 8000
```

Then open the URL it prints (for example http://localhost:8000).

## Deploying

Upload the folder to any static host, such as GitHub Pages, Netlify, Cloudflare Pages, or S3. Offline support needs **HTTPS**; `localhost` is the only exception. All paths are relative, so the app works from a subfolder too, for example `https://example.com/reader/`.

When you change any app file, bump `VERSION` in [sw.js](sw.js). Returning visitors then get the new version on their next visit.

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | App shell (library and reader views) |
| `css/style.css` | UI styles and themes |
| `js/app.js` | Library, routing, settings, panels and keyboard handling |
| `js/reader.js` | Chapter rendering, pagination and scroll mode |
| `js/epub.js` | EPUB parsing (container, OPF, spine, TOC, cover) and resource rewriting |
| `js/zip.js` | Minimal ZIP reader |
| `js/db.js` | IndexedDB storage |
| `sw.js` | Service worker for offline use |
| `manifest.webmanifest` | PWA manifest, including the `.epub` file handler |
| `tools/build-single.mjs` | Builds `dist/folio.html`, the single-file version |

## Limitations

- Fixed-layout EPUBs (comics, picture books) and vertical writing modes are shown as reflowable text.
- DRM-protected EPUBs can't be opened.
- Fonts obfuscated with the IDPF scheme fall back to the reader's fonts.
- It needs a modern browser: Chrome/Edge 103+, Firefox 113+ or Safari 16.4+.
