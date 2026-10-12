// Builds dist/folio.html: the whole app in one file that opens by double-click
// (file://). ES modules are inlined into a tiny module registry, and the
// manifest/service worker links are dropped since a local file is already offline.
//
// Usage: node tools/build-single.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Dependency order: each module only imports modules listed before it.
const MODULES = ['js/zip.js', 'js/epub.js', 'js/db.js', 'js/reader.js', 'js/app.js'];

function convertModule(file) {
  let src = read(file);
  const exported = [];

  src = src.replace(/^import \* as (\w+) from '\.\/([\w.-]+)';$/gm,
    (_, name, dep) => `const ${name} = __modules['js/${dep}'];`);
  src = src.replace(/^import \{([^}]+)\} from '\.\/([\w.-]+)';$/gm,
    (_, names, dep) => `const {${names}} = __modules['js/${dep}'];`);
  src = src.replace(/^export (async function|function|class|const|let) (\w+)/gm, (_, kind, name) => {
    exported.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(`Unhandled import/export syntax in ${file}`);

  return `__modules['${file}'] = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();`;
}

const scripts = MODULES.map(convertModule).join('\n\n')
  // Keep a literal "</script>" in the code from closing the inline tag.
  .replace(/<\/script/gi, '<\\/script');

const icon = `data:image/svg+xml,${encodeURIComponent(read('icons/icon.svg').trim())}`;

let html = read('index.html');
const replaceOnce = (pattern, replacement) => {
  if (!pattern.test(html)) throw new Error(`Pattern not found in index.html: ${pattern}`);
  html = html.replace(pattern, replacement);
};
replaceOnce(/\s*<link rel="manifest"[^>]*>/, '');
replaceOnce(/\s*<link rel="apple-touch-icon"[^>]*>/, '');
replaceOnce(/<link rel="icon"[^>]*>/, `<link rel="icon" href="${icon}" type="image/svg+xml">`);
replaceOnce(/<link rel="stylesheet" href="css\/style.css">/, () => `<style>\n${read('css/style.css')}</style>`);
// Classic (non-module) script at the end of <body>, so the DOM exists when it runs.
replaceOnce(/\s*<script type="module" src="js\/app.js"><\/script>/, '');
replaceOnce(/<\/body>/, () => `<script>\n"use strict";\n(() => {\nconst __modules = {};\n${scripts}\n})();\n</script>\n</body>`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'folio.html');
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
