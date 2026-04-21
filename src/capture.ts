import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import WebSocket from "ws";
import type { FilterRegistry, SkipFilter } from "./filters.js";
import type {
  BodyData,
  CapturedExchange,
  CapturedRequest,
  CapturedResponse,
} from "./types.js";

/** 16 MB — guardrail against decompression bombs. */
const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

function pickContentEncoding(headers: unknown): string | undefined {
  // HTT ships the `headers` GraphQL Json scalar either as a plain object
  // or as a JSON-encoded string. Handle both.
  let h: Record<string, unknown> | undefined;
  if (typeof headers === "string") {
    try {
      const parsed = JSON.parse(headers);
      if (parsed && typeof parsed === "object") h = parsed as Record<string, unknown>;
    } catch { /* not valid json — ignore */ }
  } else if (headers && typeof headers === "object") {
    h = headers as Record<string, unknown>;
  }
  if (!h) return undefined;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === "content-encoding") {
      const str = Array.isArray(v) ? v[0] : v;
      return typeof str === "string" ? str.toLowerCase().trim() : undefined;
    }
  }
  return undefined;
}

function tryDecompress(
  buf: Buffer,
  encoding: string,
): { decoded: Buffer } | undefined {
  try {
    let out: Buffer;
    switch (encoding) {
      case "gzip":
      case "x-gzip":
        out = gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
        break;
      case "deflate":
        // Heuristic: HTTP deflate is ambiguous (zlib vs raw). Try zlib first,
        // fall back to raw.
        try {
          out = inflateSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
        } catch {
          out = inflateRawSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
        }
        break;
      case "br":
        out = brotliDecompressSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
        break;
      default:
        return undefined;
    }
    return { decoded: out };
  } catch {
    return undefined;
  }
}

/**
 * Decode base64 body and decompress if Content-Encoding is supported.
 * Returns populated BodyData fields (bodyBuffer, bodyBytes, wireEncoding,
 * wireBodyBytes).
 */
function decodeBody(
  base64: string | undefined,
  headers: unknown,
): Pick<BodyData, "bodyBuffer" | "bodyBytes" | "wireEncoding" | "wireBodyBytes"> {
  if (!base64) return { bodyBytes: 0 };
  let raw: Buffer;
  try { raw = Buffer.from(base64, "base64"); }
  catch { return { bodyBytes: 0 }; }

  const wireEncoding = pickContentEncoding(headers);
  if (wireEncoding) {
    const result = tryDecompress(raw, wireEncoding);
    if (result) {
      return {
        bodyBuffer: result.decoded,
        bodyBytes: result.decoded.byteLength,
        wireEncoding,
        wireBodyBytes: raw.byteLength,
      };
    }
    // Decompression failed (unknown encoding, corrupted, too big) —
    // store raw so the agent still has something to inspect.
    return {
      bodyBuffer: raw,
      bodyBytes: raw.byteLength,
      wireEncoding,  // marker: bytes are still compressed
    };
  }
  return { bodyBuffer: raw, bodyBytes: raw.byteLength };
}

const REQUEST_QUERY = `subscription {
  requestReceived {
    id
    protocol
    httpVersion
    method
    url
    path
    headers
    body
    remoteIpAddress
    remotePort
    tags
  }
}`;

const RESPONSE_QUERY = `subscription {
  responseCompleted {
    id
    statusCode
    statusMessage
    headers
    body
    tags
  }
}`;

export type CaptureEvent =
  | { kind: "request"; exchange: CapturedExchange }
  | { kind: "response"; requestId: string; response: CapturedResponse };

export interface SubscribeOptions {
  adminUrl: string;
  sessionId: string;
  headers: Record<string, string>;
  filters?: FilterRegistry;
  onEvent: (event: CaptureEvent) => void;
  onError: (err: Error) => void;
  onClose: () => void;
  /** Fired when the server has accepted the subscription handshake. */
  onReady?: () => void;
}

/**
 * Cap on the `skipByRequestId` map. Entries are created when a skip-filter
 * matches a request; they're normally cleared when the response arrives.
 * If a response never arrives (dropped connection, aborted request) the
 * entry would leak. Cap bounds worst-case memory to ~1000 SkipFilter refs.
 */
const SKIP_MAP_MAX_ENTRIES = 1000;

export interface Subscription {
  close(): void;
  sessionId: string;
}

/**
 * Open a GraphQL subscription against a session's WebSocket and invoke onEvent
 * for each request/response. Returns an object with close(). Long-lived — the
 * caller decides when to stop.
 *
 * If a FilterRegistry is supplied, requests matching a skip filter have their
 * bodies replaced with a skip marker (exchange is still emitted so the agent
 * can see the URL / method / headers / status).
 */
export function subscribeToSession(opts: SubscribeOptions): Subscription {
  const wsUrl =
    opts.adminUrl.replace(/^http/, "ws") + `/session/${opts.sessionId}/subscription`;
  const ws = new WebSocket(wsUrl, "graphql-ws", { headers: opts.headers });

  /**
   * Per-request memory of skip status, keyed by request id. Populated when a
   * requestReceived arrives; consulted when its responseCompleted comes in.
   */
  const skipByRequestId = new Map<string, SkipFilter>();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch { /* ignore */ }
  };

  ws.on("open", () => {
    try {
      ws.send(JSON.stringify({ type: "connection_init" }));
    } catch (err) {
      opts.onError(new Error(`Failed to init WebSocket: ${(err as Error).message}`));
      close();
    }
  });

  ws.on("message", (data: WebSocket.Data) => {
    let msg: { type?: string; id?: string; payload?: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      // One bad frame shouldn't tear down the subscription — report and skip.
      opts.onError(new Error(
        `Failed to parse WebSocket frame as JSON: ${(err as Error).message}`,
      ));
      return;
    }

    if (msg.type === "connection_ack") {
      try {
        ws.send(JSON.stringify({ id: "1", type: "start", payload: { query: REQUEST_QUERY } }));
        ws.send(JSON.stringify({ id: "2", type: "start", payload: { query: RESPONSE_QUERY } }));
        opts.onReady?.();
      } catch (err) {
        opts.onError(new Error(`Failed to subscribe: ${(err as Error).message}`));
        close();
      }
      return;
    }

    if (msg.type === "connection_error") {
      opts.onError(new Error(
        `HTTP Toolkit rejected WebSocket connection: ${JSON.stringify(msg.payload)}`,
      ));
      close();
      return;
    }

    if (msg.type === "error" && msg.id) {
      opts.onError(new Error(
        `GraphQL subscription error on id=${msg.id}: ${JSON.stringify(msg.payload)}`,
      ));
      return;
    }

    if (msg.type !== "data") return;

    const payload = msg.payload as { data?: Record<string, unknown> } | undefined;
    if (!payload?.data) return;

    if (msg.id === "1" && payload.data.requestReceived) {
      const rr = payload.data.requestReceived as Record<string, unknown> & {
        id: string; method: string; url: string; protocol: string;
        headers: Record<string, string>; body?: string;
        remoteIpAddress?: string; tags?: string[];
      };

      const skip = opts.filters?.match(rr.url);
      let request: CapturedRequest;
      if (skip) {
        // Bound the map in case responses never arrive for some requests
        // (dropped connections, aborted requests). Map preserves insertion
        // order, so deleting the first key evicts the oldest pending entry.
        if (skipByRequestId.size >= SKIP_MAP_MAX_ENTRIES) {
          const oldest = skipByRequestId.keys().next().value;
          if (oldest !== undefined) skipByRequestId.delete(oldest);
        }
        skipByRequestId.set(rr.id, skip);
        request = {
          id: rr.id,
          method: rr.method,
          url: rr.url,
          protocol: rr.protocol,
          headers: rr.headers,
          remoteIpAddress: rr.remoteIpAddress,
          tags: rr.tags ?? [],
          bodyBytes: 0,
          bodySkipped: true,
          bodySkipFilterId: skip.id,
          bodySkipPattern: skip.pattern,
        };
      } else {
        const body = decodeBody(rr.body, rr.headers);
        request = {
          id: rr.id,
          method: rr.method,
          url: rr.url,
          protocol: rr.protocol,
          headers: rr.headers,
          remoteIpAddress: rr.remoteIpAddress,
          tags: rr.tags ?? [],
          ...body,
        };
      }
      opts.onEvent({ kind: "request", exchange: { request } });
      return;
    }

    if (msg.id === "2" && payload.data.responseCompleted) {
      const rc = payload.data.responseCompleted as Record<string, unknown> & {
        id: string; statusCode: number; statusMessage: string;
        headers: Record<string, string>; body?: string; tags?: string[];
      };
      const skip = skipByRequestId.get(rc.id);
      let response: CapturedResponse;
      if (skip) {
        response = {
          id: rc.id,
          statusCode: rc.statusCode,
          statusMessage: rc.statusMessage,
          headers: rc.headers,
          tags: rc.tags ?? [],
          bodyBytes: 0,
          bodySkipped: true,
          bodySkipFilterId: skip.id,
          bodySkipPattern: skip.pattern,
        };
        skipByRequestId.delete(rc.id);
      } else {
        const body = decodeBody(rc.body, rc.headers);
        response = {
          id: rc.id,
          statusCode: rc.statusCode,
          statusMessage: rc.statusMessage,
          headers: rc.headers,
          tags: rc.tags ?? [],
          ...body,
        };
      }
      opts.onEvent({ kind: "response", requestId: rc.id, response });
    }
  });

  ws.on("error", (err) => opts.onError(new Error(`WebSocket error: ${err.message}`)));
  ws.on("close", () => { closed = true; opts.onClose(); });

  return { close, sessionId: opts.sessionId };
}
