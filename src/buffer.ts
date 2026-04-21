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

export interface BufferStats {
  totalExchanges: number;
  totalBodyBytes: number;
  bodyBytesCapacity: number;
  exchangeCapacity: number;
  byHost: Array<{ host: string; count: number; bodyBytes: number }>;
  byStatus: Array<{ status: number | "pending"; count: number }>;
  byMethod: Array<{ method: string; count: number }>;
  skippedByFilter: number;
}

/**
 * In-memory ring buffer of captured exchanges. Evicts oldest entries when
 * either the exchange-count cap or the body-byte budget is exceeded.
 */
export class CaptureBuffer {
  private readonly order: string[] = [];         // request ids, oldest first
  private readonly map = new Map<string, CapturedExchange>();
  private totalBodyBytes = 0;

  constructor(
    private readonly maxCount: number,
    private readonly maxBodyBytes: number,
  ) {}

  pushRequest(exchange: CapturedExchange): void {
    const id = exchange.request.id;
    if (this.map.has(id)) {
      // Duplicate request id (unlikely): replace without reordering and adjust byte counter.
      const prev = this.map.get(id)!;
      this.totalBodyBytes -= exchangeBytes(prev);
      this.totalBodyBytes += exchangeBytes(exchange);
      this.map.set(id, exchange);
      return;
    }
    this.map.set(id, exchange);
    this.order.push(id);
    this.totalBodyBytes += exchangeBytes(exchange);
    this.evict();
  }

  attachResponse(
    requestId: string,
    response: NonNullable<CapturedExchange["response"]>,
  ): boolean {
    const existing = this.map.get(requestId);
    if (!existing) return false;
    // Old response bytes (if any) go away when replaced.
    const oldResponseBytes = existing.response?.bodyBytes ?? 0;
    existing.response = response;
    this.totalBodyBytes += response.bodyBytes - oldResponseBytes;
    this.evict();
    return true;
  }

  get(requestId: string): CapturedExchange | undefined {
    return this.map.get(requestId);
  }

  size(): number {
    return this.map.size;
  }

  bodyBytes(): number {
    return this.totalBodyBytes;
  }

  capacity(): { exchanges: number; bodyBytes: number } {
    return { exchanges: this.maxCount, bodyBytes: this.maxBodyBytes };
  }

  clear(): void {
    this.order.length = 0;
    this.map.clear();
    this.totalBodyBytes = 0;
  }

  query(opts: BufferQueryOptions): BufferQueryResult {
    const matching: CapturedExchange[] = [];
    const iter = opts.newestFirst !== false
      ? [...this.order].reverse()
      : [...this.order];

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

  stats(topN = 10): BufferStats {
    const hostCounts = new Map<string, { count: number; bodyBytes: number }>();
    const statusCounts = new Map<number | "pending", number>();
    const methodCounts = new Map<string, number>();
    let skippedByFilter = 0;

    for (const id of this.order) {
      const ex = this.map.get(id);
      if (!ex) continue;

      let host = "";
      try { host = new URL(ex.request.url).host; } catch { host = "(invalid-url)"; }
      const h = hostCounts.get(host) ?? { count: 0, bodyBytes: 0 };
      h.count++;
      h.bodyBytes += exchangeBytes(ex);
      hostCounts.set(host, h);

      const status: number | "pending" = ex.response ? ex.response.statusCode : "pending";
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);

      methodCounts.set(ex.request.method, (methodCounts.get(ex.request.method) ?? 0) + 1);

      if (ex.request.bodySkipped || ex.response?.bodySkipped) skippedByFilter++;
    }

    const byHost = [...hostCounts.entries()]
      .map(([host, v]) => ({ host, ...v }))
      .sort((a, b) => b.bodyBytes - a.bodyBytes || b.count - a.count)
      .slice(0, topN);

    const byStatus = [...statusCounts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    const byMethod = [...methodCounts.entries()]
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalExchanges: this.map.size,
      totalBodyBytes: this.totalBodyBytes,
      bodyBytesCapacity: this.maxBodyBytes,
      exchangeCapacity: this.maxCount,
      byHost,
      byStatus,
      byMethod,
      skippedByFilter,
    };
  }

  private evict(): void {
    while (
      this.order.length > this.maxCount ||
      this.totalBodyBytes > this.maxBodyBytes
    ) {
      const id = this.order.shift();
      if (id === undefined) break;
      const ex = this.map.get(id);
      if (ex) this.totalBodyBytes -= exchangeBytes(ex);
      this.map.delete(id);
    }
  }
}

function exchangeBytes(ex: CapturedExchange): number {
  return ex.request.bodyBytes + (ex.response?.bodyBytes ?? 0);
}
