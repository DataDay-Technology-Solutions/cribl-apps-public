// src/mock/store.ts — where the emulator keeps its state.
//
// In the browser MSW runs the handlers in the PAGE (the service worker only relays), so in-memory
// state would die on reload and differ between tabs. The browser store is therefore backed by
// localStorage — one entry per KV key plus small documents — which survives reloads and is shared by
// every tab of the origin (the two-tab KV-lock test needs exactly that). This is the emulated
// Leader's storage, not app data: the app itself still persists only through the KV API.
// Any storage failure (private mode, quota) degrades to memory with a single console.warn — never
// console.error, which the smoke test treats as a failure.

export interface MockStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  /** keys starting with `prefix`, unsorted */
  keys(prefix: string): string[];
}

export function createMemoryStore(): MockStore {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
    keys: (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * localStorage-backed store with a memory overlay for anything the browser refuses to hold.
 * `namespace` prefixes every key so the emulator never collides with other code on the origin.
 */
export function createBrowserStore(namespace = 'mr-mock:'): MockStore {
  let storage: StorageLike | null = null;
  try {
    storage = (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
    storage?.getItem(`${namespace}probe`);
  } catch {
    storage = null;
  }
  const memory = createMemoryStore();
  let warned = false;
  const degrade = (why: unknown): void => {
    if (warned) return;
    warned = true;
    console.warn('[meter-reader mock] browser storage unavailable; emulator state will not survive a reload.', why);
  };
  if (!storage) degrade('localStorage missing');
  return {
    get(key) {
      const mem = memory.get(key);
      if (mem !== null || !storage) return mem;
      try {
        return storage.getItem(namespace + key);
      } catch (e) {
        degrade(e);
        return null;
      }
    },
    set(key, value) {
      if (storage) {
        try {
          storage.setItem(namespace + key, value);
          memory.delete(key);
          return;
        } catch (e) {
          degrade(e);
        }
      }
      memory.set(key, value);
    },
    delete(key) {
      memory.delete(key);
      if (!storage) return;
      try {
        storage.removeItem(namespace + key);
      } catch (e) {
        degrade(e);
      }
    },
    keys(prefix) {
      const out = new Set(memory.keys(prefix));
      if (storage) {
        try {
          for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (k !== null && k.startsWith(namespace + prefix)) out.add(k.slice(namespace.length));
          }
        } catch (e) {
          degrade(e);
        }
      }
      return [...out];
    },
  };
}
