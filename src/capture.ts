import WebSocket from "ws";
import type { FilterRegistry, SkipFilter } from "./filters.js";
import type { CapturedExchange, CapturedRequest, CapturedResponse } from "./types.js";

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

function decodeBuffer(base64: string | undefined): Buffer | undefined {
  if (!base64) return undefined;
  try {
    return Buffer.from(base64, "base64");
  } catch {
    return undefined;
  }
}

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
}

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
    } catch {
      return;
    }

    if (msg.type === "connection_ack") {
      try {
        ws.send(JSON.stringify({ id: "1", type: "start", payload: { query: REQUEST_QUERY } }));
        ws.send(JSON.stringify({ id: "2", type: "start", payload: { query: RESPONSE_QUERY } }));
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
        const buf = decodeBuffer(rr.body);
        request = {
          id: rr.id,
          method: rr.method,
          url: rr.url,
          protocol: rr.protocol,
          headers: rr.headers,
          remoteIpAddress: rr.remoteIpAddress,
          tags: rr.tags ?? [],
          bodyBuffer: buf,
          bodyBytes: buf?.byteLength ?? 0,
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
        const buf = decodeBuffer(rc.body);
        response = {
          id: rc.id,
          statusCode: rc.statusCode,
          statusMessage: rc.statusMessage,
          headers: rc.headers,
          tags: rc.tags ?? [],
          bodyBuffer: buf,
          bodyBytes: buf?.byteLength ?? 0,
        };
      }
      opts.onEvent({ kind: "response", requestId: rc.id, response });
    }
  });

  ws.on("error", (err) => opts.onError(new Error(`WebSocket error: ${err.message}`)));
  ws.on("close", () => { closed = true; opts.onClose(); });

  return { close, sessionId: opts.sessionId };
}
