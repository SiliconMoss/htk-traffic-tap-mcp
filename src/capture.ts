import WebSocket from "ws";
import {
  REQUEST_BODY_MAX_BYTES,
  RESPONSE_BODY_MAX_BYTES,
} from "./constants.js";
import type { CapturedExchange } from "./types.js";

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

function decodeBody(
  base64: string | undefined,
  maxBytes: number,
): { body?: string; truncated?: boolean } {
  if (!base64) return {};
  try {
    const buf = Buffer.from(base64, "base64");
    const truncated = buf.byteLength > maxBytes;
    const slice = truncated ? buf.subarray(0, maxBytes) : buf;
    return { body: slice.toString("utf-8"), truncated: truncated || undefined };
  } catch {
    return {};
  }
}

export type CaptureEvent =
  | { kind: "request"; exchange: CapturedExchange }
  | { kind: "response"; requestId: string; response: NonNullable<CapturedExchange["response"]> };

export interface SubscribeOptions {
  adminUrl: string;
  sessionId: string;
  headers: Record<string, string>;
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
 */
export function subscribeToSession(opts: SubscribeOptions): Subscription {
  const wsUrl =
    opts.adminUrl.replace(/^http/, "ws") + `/session/${opts.sessionId}/subscription`;
  const ws = new WebSocket(wsUrl, "graphql-ws", { headers: opts.headers });
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
      const req = payload.data.requestReceived as Record<string, unknown> & {
        id: string; method: string; url: string; protocol: string;
        headers: Record<string, string>; body?: string;
        remoteIpAddress?: string; tags?: string[];
      };
      const { body, truncated } = decodeBody(req.body, REQUEST_BODY_MAX_BYTES);
      opts.onEvent({
        kind: "request",
        exchange: {
          request: {
            id: req.id,
            method: req.method,
            url: req.url,
            protocol: req.protocol,
            headers: req.headers,
            body,
            bodyTruncated: truncated,
            remoteIpAddress: req.remoteIpAddress,
            tags: req.tags ?? [],
          },
        },
      });
      return;
    }

    if (msg.id === "2" && payload.data.responseCompleted) {
      const resp = payload.data.responseCompleted as Record<string, unknown> & {
        id: string; statusCode: number; statusMessage: string;
        headers: Record<string, string>; body?: string; tags?: string[];
      };
      const { body, truncated } = decodeBody(resp.body, RESPONSE_BODY_MAX_BYTES);
      opts.onEvent({
        kind: "response",
        requestId: resp.id,
        response: {
          id: resp.id,
          statusCode: resp.statusCode,
          statusMessage: resp.statusMessage,
          headers: resp.headers,
          body,
          bodyTruncated: truncated,
          tags: resp.tags ?? [],
        },
      });
    }
  });

  ws.on("error", (err) => opts.onError(new Error(`WebSocket error: ${err.message}`)));
  ws.on("close", () => { closed = true; opts.onClose(); });

  return { close, sessionId: opts.sessionId };
}

