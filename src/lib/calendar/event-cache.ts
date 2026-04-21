import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const CACHE_FILE = join(process.cwd(), 'data', 'event-cache.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

export class PersistentEventCache {
  private cache = new Map<string, any>();

  async load(): Promise<void> {
    try {
      await mkdir(join(process.cwd(), 'data'), { recursive: true });
      const raw = await readFile(CACHE_FILE, 'utf-8');
      const entries: Array<[string, any]> = JSON.parse(raw);
      const now = Date.now();
      for (const [id, value] of entries) {
        if (value?.timestamp && now - value.timestamp < CACHE_TTL_MS) {
          this.cache.set(id, value);
        }
      }
      console.log(`[EventCache] Loaded ${this.cache.size} entries from disk`);
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  private persist(): void {
    const entries = Array.from(this.cache.entries());
    writeFile(CACHE_FILE, JSON.stringify(entries, null, 2)).catch(err =>
      console.error('[EventCache] Persist error:', err)
    );
  }

  get(id: string): any { return this.cache.get(id); }
  set(id: string, value: any): void { this.cache.set(id, value); this.persist(); }
  delete(id: string): void { this.cache.delete(id); this.persist(); }
  has(id: string): boolean { return this.cache.has(id); }
}
