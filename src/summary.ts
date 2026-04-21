/**
 * Compact summary views for captured exchanges, designed so the default
 * list_exchanges response stays well under any reasonable agent context budget.
 *
 * Tiers (cheapest → most detail):
 *   summary  — method, host, path-truncated, status, resp content-type, skip marker  (~150 B)
 *   meta     — summary + header counts, body byte counts                             (~300 B)
 *   headers  — meta + full headers dicts                                              (1-5 KB)
 *
 * Bodies are NEVER returned here. Use htk_get_exchange / htk_get_exchange_body
 * / htk_search_exchange_body for body access.
 */

import type { CapturedExchange, CapturedRequest, CapturedResponse } from "./types.js";

export type DetailLevel = "summary" | "meta" | "headers";

export const URL_TRUNCATE_AT = 256;
export const PATH_TRUNCATE_AT = 128;

interface UrlParts {
  scheme: string;
  host: string;
  path: string;
  pathTruncatedFrom?: number;
  url: string;
  urlTruncatedFrom?: number;
}

function splitUrl(urlStr: string): UrlParts {
  let parsed: URL | undefined;
  try {
    parsed = new URL(urlStr);
  } catch {
    return {
      scheme: "",
      host: "",
      path: truncateWith(urlStr, PATH_TRUNCATE_AT),
      url: truncateWith(urlStr, URL_TRUNCATE_AT),
      pathTruncatedFrom: urlStr.length > PATH_TRUNCATE_AT ? urlStr.length : undefined,
      urlTruncatedFrom: urlStr.length > URL_TRUNCATE_AT ? urlStr.length : undefined,
    };
  }
  const path = parsed.pathname + parsed.search;
  return {
    scheme: parsed.protocol.replace(":", ""),
    host: parsed.host,
    path: truncateWith(path, PATH_TRUNCATE_AT),
    pathTruncatedFrom: path.length > PATH_TRUNCATE_AT ? path.length : undefined,
    url: truncateWith(urlStr, URL_TRUNCATE_AT),
    urlTruncatedFrom: urlStr.length > URL_TRUNCATE_AT ? urlStr.length : undefined,
  };
}

function truncateWith(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function normalizeHeaders(h: unknown): Record<string, string> {
  if (typeof h === "string") {
    try {
      const parsed = JSON.parse(h);
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    } catch { /* fall through */ }
    return {};
  }
  if (h && typeof h === "object") return h as Record<string, string>;
  return {};
}

function pickHeader(h: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  return undefined;
}

function headerBytes(h: Record<string, string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    n += k.length + 2;
    if (Array.isArray(v)) n += v.reduce((a, s) => a + String(s).length + 2, 0);
    else n += String(v).length + 2;
  }
  return n;
}

export interface BodySkipInfo {
  bodySkipped: true;
  bodySkipFilterId?: number;
  bodySkipPattern?: string;
}

export interface ExchangeSummary {
  id: string;
  method: string;
  scheme: string;
  host: string;
  path: string;
  pathTruncatedFrom?: number;
  url: string;
  urlTruncatedFrom?: number;
  status?: number;
  responseContentType?: string;
  hasResponse: boolean;
  requestBodySkipped?: BodySkipInfo;
  responseBodySkipped?: BodySkipInfo;
  tags?: string[];
}

export interface ExchangeMeta extends ExchangeSummary {
  requestContentType?: string;
  requestHeaderCount: number;
  requestHeaderBytes: number;
  requestBodyBytes: number;
  requestWireEncoding?: string;
  requestWireBodyBytes?: number;
  responseHeaderCount?: number;
  responseHeaderBytes?: number;
  responseBodyBytes?: number;
  responseWireEncoding?: string;
  responseWireBodyBytes?: number;
  responseStatusMessage?: string;
}

export interface ExchangeWithHeaders extends ExchangeMeta {
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

function skipInfoFor(side: { bodySkipped?: boolean; bodySkipFilterId?: number; bodySkipPattern?: string }): BodySkipInfo | undefined {
  if (!side.bodySkipped) return undefined;
  return {
    bodySkipped: true,
    bodySkipFilterId: side.bodySkipFilterId,
    bodySkipPattern: side.bodySkipPattern,
  };
}

export function summarize(exchange: CapturedExchange): ExchangeSummary {
  const req = exchange.request;
  const parts = splitUrl(req.url);
  const respHeaders = exchange.response ? normalizeHeaders(exchange.response.headers) : undefined;
  return {
    id: req.id,
    method: req.method,
    scheme: parts.scheme,
    host: parts.host,
    path: parts.path,
    pathTruncatedFrom: parts.pathTruncatedFrom,
    url: parts.url,
    urlTruncatedFrom: parts.urlTruncatedFrom,
    status: exchange.response?.statusCode,
    responseContentType: respHeaders ? pickHeader(respHeaders, "content-type") : undefined,
    hasResponse: !!exchange.response,
    requestBodySkipped: skipInfoFor(req),
    responseBodySkipped: exchange.response ? skipInfoFor(exchange.response) : undefined,
    tags: req.tags?.length ? req.tags : undefined,
  };
}

export function toMeta(exchange: CapturedExchange): ExchangeMeta {
  const summary = summarize(exchange);
  const req = exchange.request;
  const resp = exchange.response;
  const reqHeaders = normalizeHeaders(req.headers);
  const respHeaders = resp ? normalizeHeaders(resp.headers) : undefined;
  return {
    ...summary,
    requestContentType: pickHeader(reqHeaders, "content-type"),
    requestHeaderCount: Object.keys(reqHeaders).length,
    requestHeaderBytes: headerBytes(reqHeaders),
    requestBodyBytes: req.bodyBytes,
    requestWireEncoding: req.wireEncoding,
    requestWireBodyBytes: req.wireBodyBytes,
    responseHeaderCount: respHeaders ? Object.keys(respHeaders).length : undefined,
    responseHeaderBytes: respHeaders ? headerBytes(respHeaders) : undefined,
    responseBodyBytes: resp?.bodyBytes,
    responseWireEncoding: resp?.wireEncoding,
    responseWireBodyBytes: resp?.wireBodyBytes,
    responseStatusMessage: resp?.statusMessage,
  };
}

export function toWithHeaders(exchange: CapturedExchange): ExchangeWithHeaders {
  const meta = toMeta(exchange);
  return {
    ...meta,
    requestHeaders: normalizeHeaders(exchange.request.headers),
    responseHeaders: exchange.response ? normalizeHeaders(exchange.response.headers) : undefined,
  };
}

export function render(
  exchange: CapturedExchange,
  level: DetailLevel,
): ExchangeSummary | ExchangeMeta | ExchangeWithHeaders {
  switch (level) {
    case "summary": return summarize(exchange);
    case "meta": return toMeta(exchange);
    case "headers": return toWithHeaders(exchange);
  }
}

/** Detail views for htk_get_exchange. Bodies are byte-count only — use
 * htk_get_exchange_body / htk_search_exchange_body to read body contents. */
export interface GetExchangeView {
  id: string;
  method: string;
  url: string;
  urlTruncatedFrom?: number;
  scheme: string;
  host: string;
  path: string;
  pathTruncatedFrom?: number;
  protocol: string;
  tags: string[];
  remoteIpAddress?: string;
  request: {
    headers?: Record<string, string>;
    bodyBytes: number;
    wireEncoding?: string;
    wireBodyBytes?: number;
    bodySkipped?: BodySkipInfo;
  };
  response?: {
    statusCode: number;
    statusMessage: string;
    headers?: Record<string, string>;
    bodyBytes: number;
    wireEncoding?: string;
    wireBodyBytes?: number;
    bodySkipped?: BodySkipInfo;
  };
}

export interface GetExchangeOptions {
  includeRequestHeaders?: boolean;
  includeResponseHeaders?: boolean;
}

export function getExchangeView(
  exchange: CapturedExchange,
  opts: GetExchangeOptions,
): GetExchangeView {
  const req: CapturedRequest = exchange.request;
  const resp: CapturedResponse | undefined = exchange.response;
  const parts = splitUrl(req.url);

  return {
    id: req.id,
    method: req.method,
    url: parts.url,
    urlTruncatedFrom: parts.urlTruncatedFrom,
    scheme: parts.scheme,
    host: parts.host,
    path: parts.path,
    pathTruncatedFrom: parts.pathTruncatedFrom,
    protocol: req.protocol,
    tags: req.tags ?? [],
    remoteIpAddress: req.remoteIpAddress,
    request: {
      headers: opts.includeRequestHeaders ? normalizeHeaders(req.headers) : undefined,
      bodyBytes: req.bodyBytes,
      wireEncoding: req.wireEncoding,
      wireBodyBytes: req.wireBodyBytes,
      bodySkipped: skipInfoFor(req),
    },
    response: resp
      ? {
          statusCode: resp.statusCode,
          statusMessage: resp.statusMessage,
          headers: opts.includeResponseHeaders ? normalizeHeaders(resp.headers) : undefined,
          bodyBytes: resp.bodyBytes,
          wireEncoding: resp.wireEncoding,
          wireBodyBytes: resp.wireBodyBytes,
          bodySkipped: skipInfoFor(resp),
        }
      : undefined,
  };
}
