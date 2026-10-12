// Tiny promise wrapper around IndexedDB. Book metadata and the EPUB files are
// kept in separate stores so listing the library never loads whole books.

const DB_NAME = 'epub-reader';
const DB_VERSION = 1;

let dbPromise = null;
// Some contexts (e.g. a page opened from disk in some browsers, or private
// modes) refuse IndexedDB. Then the library lives in memory for this session.
let memory = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(storeNames, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    Promise.resolve(fn(tx)).then((r) => { result = r; }, reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function useMemory() {
  if (memory) return true;
  try {
    await open();
    return false;
  } catch (err) {
    console.warn('IndexedDB unavailable; keeping books in memory only', err);
    memory = { books: new Map(), files: new Map() };
    return true;
  }
}

export async function isPersistent() {
  return !(await useMemory());
}

export async function listBooks() {
  if (await useMemory()) return [...memory.books.values()];
  return run('books', 'readonly', (tx) => req(tx.objectStore('books').getAll()));
}

export async function getBook(id) {
  if (await useMemory()) return memory.books.get(id);
  return run('books', 'readonly', (tx) => req(tx.objectStore('books').get(id)));
}

export async function getFile(id) {
  if (await useMemory()) return memory.files.get(id);
  return run('files', 'readonly', (tx) => req(tx.objectStore('files').get(id))).then((r) => r && r.blob);
}

export async function addBook(meta, blob) {
  if (await useMemory()) {
    memory.books.set(meta.id, meta);
    memory.files.set(meta.id, blob);
    return;
  }
  return run(['books', 'files'], 'readwrite', (tx) => {
    tx.objectStore('books').put(meta);
    tx.objectStore('files').put({ id: meta.id, blob });
  });
}

export async function updateBook(id, patch) {
  if (await useMemory()) {
    const current = memory.books.get(id);
    if (current) memory.books.set(id, { ...current, ...patch });
    return;
  }
  return run('books', 'readwrite', async (tx) => {
    const store = tx.objectStore('books');
    const current = await req(store.get(id));
    if (current) store.put({ ...current, ...patch });
  });
}

export async function deleteBook(id) {
  if (await useMemory()) {
    memory.books.delete(id);
    memory.files.delete(id);
    return;
  }
  return run(['books', 'files'], 'readwrite', (tx) => {
    tx.objectStore('books').delete(id);
    tx.objectStore('files').delete(id);
  });
}
