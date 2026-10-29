/**
 * The cruise map, kept in the browser (IndexedDB) between visits: each built tile's ground
 * and plants, keyed by road seed and tile. Coming back to the same road loads them instead of
 * working the land out again. Best effort throughout: with storage blocked or full, the
 * world is simply built fresh.
 */

const DB = "revheadz-cruise";
const STORE = "tiles";
/** Past this many saved tiles (a few tens of MB), the oldest road's go first. */
const MAX_TILES = 900;

interface Row<T> {
  key: string;
  seed: number;
  at: number;
  data: T;
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("at", "at");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

const rowKey = (seed: number, tile: string) => `${seed}:${tile}`;

/** The saved tiles for a road among `tiles` ("ix,iz"), as a map; empty if none or no storage. */
export async function loadTiles<T>(seed: number, tiles: string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const db = await open();
  if (!db) return out;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      for (const t of tiles) {
        const req = store.get(rowKey(seed, t));
        req.onsuccess = () => {
          const row = req.result as Row<T> | undefined;
          if (row) out.set(t, row.data);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  return out;
}

/** Saves built tiles for a road, then trims the oldest if the cache has grown too big. */
export async function saveTiles<T>(seed: number, tiles: { key: string; data: T }[]): Promise<void> {
  if (!tiles.length) return;
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const now = Date.now();
    for (const t of tiles) store.put({ key: rowKey(seed, t.key), seed, at: now, data: t.data } satisfies Row<T>);
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - MAX_TILES;
      if (extra <= 0) return;
      // oldest first
      const cursor = store.index("at").openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || extra-- <= 0) return;
        c.delete();
        c.continue();
      };
    };
  } catch {
    /* full or blocked: the map just isn't kept */
  }
}

/** Forgets every saved tile of a road (a new road was asked for). */
export async function forgetRoad(seed: number): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if ((c.value as Row<unknown>).seed === seed) c.delete();
      c.continue();
    };
  } catch {
    /* nothing to forget */
  }
}
