/**
 * URL-based skip filters. When a filter matches a request URL, the exchange is
 * recorded (URL, method, headers, status all captured) but the bodies are NOT
 * stored — avoiding RAM pressure from noisy traffic like CDN assets or ad
 * beacons. The exchange is marked `bodySkipped: true` so the agent can still
 * see it showed up.
 *
 * Matching is a simple case-insensitive substring search against the full
 * request URL. Simple, safe, predictable — no regex ReDoS surface.
 */

export interface SkipFilter {
  id: number;
  pattern: string;            // lower-cased substring
  description?: string;
  hits: number;
  createdAt: number;
}

export interface SkipFilterSnapshot {
  id: number;
  pattern: string;
  description?: string;
  hits: number;
  createdAt: number;
  createdAtIso: string;
}

export class FilterRegistry {
  private nextId = 1;
  private readonly byId = new Map<number, SkipFilter>();

  add(pattern: string, description?: string): SkipFilterSnapshot {
    const id = this.nextId++;
    const filter: SkipFilter = {
      id,
      pattern: pattern.toLowerCase(),
      description,
      hits: 0,
      createdAt: Date.now(),
    };
    this.byId.set(id, filter);
    return this.snapshot(filter);
  }

  remove(id: number): boolean {
    return this.byId.delete(id);
  }

  list(): SkipFilterSnapshot[] {
    return Array.from(this.byId.values())
      .sort((a, b) => a.id - b.id)
      .map((f) => this.snapshot(f));
  }

  /** Returns the first matching filter (bumps hit counter), or undefined. */
  match(url: string): SkipFilter | undefined {
    const lower = url.toLowerCase();
    for (const f of this.byId.values()) {
      if (lower.includes(f.pattern)) {
        f.hits++;
        return f;
      }
    }
    return undefined;
  }

  clear(): number {
    const n = this.byId.size;
    this.byId.clear();
    return n;
  }

  private snapshot(f: SkipFilter): SkipFilterSnapshot {
    return {
      id: f.id,
      pattern: f.pattern,
      description: f.description,
      hits: f.hits,
      createdAt: f.createdAt,
      createdAtIso: new Date(f.createdAt).toISOString(),
    };
  }
}
