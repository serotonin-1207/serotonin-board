// Per-browser copy of the revisions already received, so a page open only downloads what is new.
// Revisions never change, so the copy never goes stale; a full re-read still happens weekly or on request.
// Everything fails soft: without IndexedDB (private windows, blocked storage) the board simply reads from the server.
const DB = 'serotonin-board-cache',
  STORE = 'caches';

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function run(mode, action) {
  return open().then(
    db =>
      new Promise((resolve, reject) => {
        const request = action(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => {
          db.close();
          resolve(request.result);
        };
        request.onerror = () => {
          db.close();
          reject(request.error);
        };
      }),
  );
}
export async function load(key) {
  try {
    return (await run('readonly', store => store.get(key))) || null;
  } catch {
    return null;
  }
}
export async function save(key, value) {
  try {
    await run('readwrite', store => store.put(value, key));
    return true;
  } catch {
    return false;
  }
}
export async function remove(key) {
  try {
    await run('readwrite', store => store.delete(key));
  } catch {
    /* nothing cached */
  }
}
