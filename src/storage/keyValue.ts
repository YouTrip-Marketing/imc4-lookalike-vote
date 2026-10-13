/** The slice of Web Storage the app needs, so tests can pass an in-memory one. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorage implements KeyValueStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/**
 * localStorage if the browser allows it, otherwise memory.
 *
 * In-app browsers and private modes can block storage or throw on first use.
 * Nothing that matters depends on this: the page then just forgets on reload.
 */
export function browserStorage(): KeyValueStorage {
  try {
    const probe = '__imc4_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return new MemoryStorage();
  }
}
