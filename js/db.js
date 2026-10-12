// Tiny promise wrapper around IndexedDB. Book metadata and the EPUB files are
// kept in separate stores so listing the library never loads whole books.

const DB_NAME = 'epub-reader';
const DB_VERSION = 1;

let dbPromise = null;

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

export function listBooks() {
  return run('books', 'readonly', (tx) => req(tx.objectStore('books').getAll()));
}

export function getBook(id) {
  return run('books', 'readonly', (tx) => req(tx.objectStore('books').get(id)));
}

export function getFile(id) {
  return run('files', 'readonly', (tx) => req(tx.objectStore('files').get(id))).then((r) => r && r.blob);
}

export function addBook(meta, blob) {
  return run(['books', 'files'], 'readwrite', (tx) => {
    tx.objectStore('books').put(meta);
    tx.objectStore('files').put({ id: meta.id, blob });
  });
}

export function updateBook(id, patch) {
  return run('books', 'readwrite', async (tx) => {
    const store = tx.objectStore('books');
    const current = await req(store.get(id));
    if (current) store.put({ ...current, ...patch });
  });
}

export function deleteBook(id) {
  return run(['books', 'files'], 'readwrite', (tx) => {
    tx.objectStore('books').delete(id);
    tx.objectStore('files').delete(id);
  });
}
