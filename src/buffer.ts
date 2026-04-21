import type { CapturedExchange } from "./types.js";

export interface BufferQueryOptions {
  urlFilter?: string;
  methodFilter?: string;
  statusFilter?: number;
  limit: number;
  offset: number;
  newestFirst?: boolean;
}

export interface BufferQueryResult {
  total: number;
  matched: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  exchanges: CapturedExchange[];
}

/**
 * In-memory ring buffer of captured exchanges, keyed by request id so that
 * responses can update the matching request without double-storing. When the
 * buffer is full, the oldest exchange is evicted.
 *
 * No persistence — buffer lives only as long as the MCP process.
 */
export class CaptureBuffer {
  private readonly order: string[] = []; // request ids, oldest first
  private readonly map = new Map<string, CapturedExchange>();

  constructor(private readonly maxSize: number) {}

  pushRequest(exchange: CapturedExchange): void {
    const id = exchange.request.id;
    if (this.map.has(id)) {
      // Request seen twice (unlikely but be safe): replace without reordering.
      this.map.set(id, exchange);
      return;
    }
    this.map.set(id, exchange);
    this.order.push(id);
    this.evictIfOversize();
  }

  attachResponse(requestId: string, response: NonNullable<CapturedExchange["response"]>): boolean {
    const existing = this.map.get(requestId);
    if (!existing) return false;
    existing.response = response;
    return true;
  }

  get(requestId: string): CapturedExchange | undefined {
    return this.map.get(requestId);
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.order.length = 0;
    this.map.clear();
  }

  query(opts: BufferQueryOptions): BufferQueryResult {
    const matching: CapturedExchange[] = [];
    // Iterate in the order requested. order[] is oldest-first.
    const iter = opts.newestFirst !== false
      ? this.order.slice().reverse()
      : this.order.slice();

    for (const id of iter) {
      const ex = this.map.get(id);
      if (!ex) continue;
      if (opts.urlFilter && !ex.request.url.includes(opts.urlFilter)) continue;
      if (opts.methodFilter &&
          ex.request.method.toUpperCase() !== opts.methodFilter.toUpperCase()) continue;
      if (opts.statusFilter !== undefined) {
        if (!ex.response) continue;
        if (ex.response.statusCode !== opts.statusFilter) continue;
      }
      matching.push(ex);
    }

    const offset = Math.max(0, opts.offset);
    const slice = matching.slice(offset, offset + opts.limit);
    const hasMore = offset + slice.length < matching.length;

    return {
      total: this.map.size,
      matched: matching.length,
      returned: slice.length,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + slice.length : undefined,
      exchanges: slice,
    };
  }

  private evictIfOversize(): void {
    while (this.order.length > this.maxSize) {
      const id = this.order.shift();
      if (id !== undefined) this.map.delete(id);
    }
  }
}
