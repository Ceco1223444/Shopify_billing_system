/**
 * Per-computer settings of the archive, kept in this browser's IndexedDB:
 * the chosen folder (a FileSystemDirectoryHandle can only be stored there) and
 * the name of this computer. Storage can be unavailable (private window,
 * blocked site data): every call fails soft and the app keeps working.
 */
const DB_NAME = 'happyhome-archive';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadLocal<T>(key: string): Promise<T | undefined> {
  try {
    return (await run('readonly', (s) => s.get(key))) as T | undefined;
  } catch {
    return undefined;
  }
}

export async function saveLocal(key: string, value: unknown): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(value, key));
    return true;
  } catch {
    return false;
  }
}

/** A readable default name for this computer, e.g. "Windows · Chrome". */
export function defaultComputerName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS/.test(ua)
      ? 'Mac'
      : /Android/.test(ua)
        ? 'Android'
        : /Linux/.test(ua)
          ? 'Linux'
          : 'PC';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${os} · ${browser}` : os;
}
