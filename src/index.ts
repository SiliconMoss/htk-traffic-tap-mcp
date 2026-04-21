#!/usr/bin/env node
/**
 * MCP server that exposes HTTP Toolkit's captured HTTP(S) traffic to AI
 * assistants for analysis. Local-only: refuses to connect to any non-loopback
 * address. No arbitrary HTTP request tool (no SSRF surface).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getBodyRange, searchBody, type BodyAccessError } from "./body-access.js";
import { CaptureBuffer } from "./buffer.js";
import { CaptureManager } from "./capture-manager.js";
import { loadConfig } from "./config.js";
import {
  HOW_TO_GET_SESSION_ID,
  POST_START_WARNING,
} from "./guidance.js";
import {
  BODY_BUDGET_BYTES,
  BUFFER_CAPACITY,
  CHARACTER_LIMIT,
  DEFAULT_SEARCH_CONTEXT,
  DEFAULT_SEARCH_MAX_MATCHES,
  MAX_BODY_RANGE_LENGTH,
  MAX_SEARCHABLE_BODY_BYTES,
  MAX_SEARCH_MAX_MATCHES,
  MAX_SEARCH_PATTERN_LENGTH,
  MCP_SERVER_VERSION,
} from "./constants.js";
import { getExchangeView, render, type DetailLevel } from "./summary.js";
import type { ConnectionStatus } from "./types.js";

const config = await loadConfig();
const captureManager = new CaptureManager(
  new CaptureBuffer(BUFFER_CAPACITY, BODY_BUDGET_BYTES),
);

const server = new McpServer({
  name: "htk-traffic-tap-mcp",
  version: MCP_SERVER_VERSION,
});

function jsonResult<T extends Record<string, unknown>>(data: T) {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data as { [key: string]: unknown },
  };
}

type VersionProbe =
  | { kind: "ok"; version: string }
  | { kind: "auth_rejected"; status: number }
  | { kind: "http_error"; status: number }
  | { kind: "unreachable"; reason: string };

async function fetchServerVersion(): Promise<VersionProbe> {
  try {
    const res = await fetch(`${config.serverUrl}/version`, {
      method: "GET",
      headers: config.headers,
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { version?: string };
      return { kind: "ok", version: data.version ?? "unknown" };
    }
    if (res.status === 401 || res.status === 403) {
      return { kind: "auth_rejected", status: res.status };
    }
    return { kind: "http_error", status: res.status };
  } catch (err) {
    return { kind: "unreachable", reason: (err as Error).message };
  }
}

// ----------------------------------------------------------------------------
// Tool: htk_check_connection
// ----------------------------------------------------------------------------

const CheckConnectionInputSchema = z.object({}).strict();

server.registerTool(
  "htk_check_connection",
  {
    title: "Check HTTP Toolkit Connection",
    description: `Verify connectivity to the local HTTP Toolkit server and resolve the active capture session.

This is a read-only diagnostic tool. It:
  - Tests whether the HTTP Toolkit REST API (default http://127.0.0.1:45457) responds
  - Reports whether HTK_SERVER_TOKEN is configured (needed for prod HTTP Toolkit builds)
  - Reports whether HTK_SESSION_ID is configured or can be auto-discovered from log files

Args: none

Returns JSON with schema:
  {
    "serverUrl": string,
    "adminUrl": string,
    "serverReachable": boolean,
    "serverVersion": string | undefined,
    "authTokenConfigured": boolean,
    "sessionIdConfigured": boolean,
    "sessionIdResolved": string | undefined,
    "error": string | undefined
  }

Use this before htk_capture_traffic to confirm HTTP Toolkit is running and a session is reachable.`,
    inputSchema: CheckConnectionInputSchema.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const probe = await fetchServerVersion();
    let sessionIdResolved: string | undefined;
    if (probe.kind === "ok" && config.sessionId) {
      sessionIdResolved = config.sessionId;
    }

    let hint: string | undefined;
    if (probe.kind === "auth_rejected") {
      hint = config.authToken
        ? `HTTP Toolkit rejected the auth token (source: ${config.authTokenSource}). The token regenerates on every HTTP Toolkit restart — if auto-detect found a stale PID, restart this MCP server to re-scan.`
        : "HTTP Toolkit requires an auth token. Auto-detection failed; launch HTTP Toolkit first or set HTK_SERVER_TOKEN manually.";
    } else if (probe.kind === "unreachable") {
      hint = "HTTP Toolkit doesn't appear to be running. Launch the desktop app and try again.";
    } else if (probe.kind === "http_error") {
      hint = `HTTP Toolkit responded with status ${probe.status}. This is unexpected — check the desktop app logs.`;
    }

    const status: ConnectionStatus = {
      mcpServerVersion: MCP_SERVER_VERSION,
      serverUrl: config.serverUrl,
      adminUrl: config.adminUrl,
      serverState: probe.kind,
      serverReachable: probe.kind === "ok",
      serverVersion: probe.kind === "ok" ? probe.version : undefined,
      serverStatusCode:
        probe.kind === "auth_rejected" || probe.kind === "http_error"
          ? probe.status
          : undefined,
      serverErrorReason: probe.kind === "unreachable" ? probe.reason : undefined,
      authTokenConfigured: !!config.authToken,
      authTokenSource: config.authTokenSource,
      authTokenAutoDetect: config.autoDetect
        ? {
            attempted: true,
            attemptedPids: config.autoDetect.attemptedPids,
            matchedPid: config.autoDetect.pid,
            reason: config.autoDetect.reason,
          }
        : undefined,
      sessionIdConfigured: !!config.sessionId,
      sessionIdResolved,
      sessionSource: sessionIdResolved ? "env-override" : undefined,
      captureState: captureManager.status().state,
      captureBufferedExchanges: captureManager.status().bufferedExchanges,
      guidance: buildConnectionGuidance(probe.kind, captureManager.status().state),
      hint,
    };
    return jsonResult(status as unknown as Record<string, unknown>);
  },
);

function buildConnectionGuidance(
  serverKind: "ok" | "auth_rejected" | "http_error" | "unreachable",
  capState: "idle" | "connecting" | "running" | "stopped",
): string {
  if (serverKind !== "ok") {
    if (serverKind === "unreachable") {
      return "HTTP Toolkit is not running. Ask the user to launch the HTTP Toolkit desktop app, then retry.";
    }
    if (serverKind === "auth_rejected") {
      return "HTTP Toolkit rejected this MCP server's auth token. On Windows the token is auto-detected from the running httptoolkit-server process, but it rotates every time HTTP Toolkit restarts. Ask the user to restart this MCP server (in their client's MCP settings) so it picks up the fresh token.";
    }
    return `HTTP Toolkit responded unexpectedly (${serverKind}). Ask the user to check the HTTP Toolkit desktop app logs.`;
  }
  if (capState === "running" || capState === "connecting") {
    return "HTTP Toolkit is reachable and a background capture is active. Call htk_capture_status for details or htk_list_exchanges to read buffered traffic.";
  }
  return [
    "HTTP Toolkit is reachable but NO background capture is running. To capture traffic the user intercepts through HTTP Toolkit's UI, you need to start one:",
    "",
    HOW_TO_GET_SESSION_ID,
    "",
    POST_START_WARNING,
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Background capture tools (htk_start_capture / stop / status / list / get / clear)
// ----------------------------------------------------------------------------

function resolveSessionForCapture(
  explicit: string | undefined,
): { sessionId: string } | { error: string } {
  const chosen = explicit ?? config.sessionId;
  if (chosen) return { sessionId: chosen };
  return {
    error:
      "No session_id provided and HTK_SESSION_ID is not set. " +
      "Get the HTTP Toolkit UI's session UUID via the DevTools snippet (see the tool description) and pass it as session_id.",
  };
}

server.registerTool(
  "htk_start_capture",
  {
    title: "Start Background Capture",
    description: `Start a long-running background subscription to an HTTP Toolkit session and accumulate intercepted request/response exchanges into an in-memory buffer. Once started, the MCP buffers traffic continuously — the user can do other things, you can do other tasks, then come back later and read the buffer via htk_list_exchanges / htk_get_exchange.

IMPORTANT — tell the user BEFORE starting capture:
  • Only traffic that flows AFTER this call is captured. Traffic the user already generated in the HTTP Toolkit UI before this moment is not retrievable.
  • Each time HTTP Toolkit is restarted or its UI reloaded, the session UUID rotates and you must call htk_start_capture again with the fresh UUID.

HOW TO GET THE SESSION UUID (piggy-back on the HTTP Toolkit UI's session):
  1. In the HTTP Toolkit window, press Ctrl+Shift+I (or View -> Toggle Developer Tools).
  2. In the Console tab, paste this snippet and press Enter:
       copy([...new Set(performance.getEntriesByType('resource').flatMap(e => (e.name.match(/\\/session\\/([0-9a-f-]{36})/i) || []).slice(1)))][0])
  3. The UUID is now on the user's clipboard.
  4. They paste it to you; you call htk_start_capture with session_id set to that UUID.

If called while already running for the same session, this is a no-op (returns current status). If called with a different session_id, the existing capture is replaced and the buffer is cleared.

Buffer is capped at ${BUFFER_CAPACITY} exchanges (oldest evicted first). Request bodies truncated at 2 KB, response bodies at 4 KB.

Args:
  - session_id (UUID, optional): HTTP Toolkit session UUID. Omit to fall back to HTK_SESSION_ID. If neither is set, the call returns an error with instructions to obtain the UUID.

Returns the current ManagerStatus JSON:
  {
    "state": "idle" | "connecting" | "running" | "stopped",
    "sessionId": string | undefined,
    "startedAt": number | undefined,       // unix ms
    "startedAtIso": string | undefined,
    "stoppedAt": number | undefined,
    "reason": string | undefined,
    "bufferedExchanges": number,
    "bufferCapacity": number,
    "lastError": string | undefined
  }`,
    inputSchema: z.object({
      session_id: z.string().uuid("session_id must be a UUID").optional(),
    }).strict().shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ session_id }) => {
    const resolved = resolveSessionForCapture(session_id);
    if ("error" in resolved) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Error resolving session: ${resolved.error}. Pass session_id or run htk_check_connection.`,
        }],
      };
    }
    const status = await captureManager.start({
      adminUrl: config.adminUrl,
      sessionId: resolved.sessionId,
      headers: config.headers,
    });
    return jsonResult(status as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "htk_stop_capture",
  {
    title: "Stop Background Capture",
    description:
      "Stop the running background capture (if any). The buffer is preserved — you can still call htk_list_exchanges / htk_get_exchange until the MCP process exits or htk_clear_capture is called. Returns the current ManagerStatus.",
    inputSchema: z.object({}).strict().shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => jsonResult(captureManager.stop() as unknown as Record<string, unknown>),
);

server.registerTool(
  "htk_capture_status",
  {
    title: "Get Background Capture Status",
    description:
      "Report whether a background capture is running, which session it's attached to, how long it's been running, and how many exchanges are buffered.",
    inputSchema: z.object({}).strict().shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => jsonResult(captureManager.status() as unknown as Record<string, unknown>),
);

server.registerTool(
  "htk_clear_capture",
  {
    title: "Clear Capture Buffer",
    description:
      "Delete all exchanges from the in-memory capture buffer. Does NOT stop the capture — if one is running, it continues collecting new exchanges. Returns the current ManagerStatus (with bufferedExchanges=0).",
    inputSchema: z.object({}).strict().shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    captureManager.clear();
    return jsonResult(captureManager.status() as unknown as Record<string, unknown>);
  },
);

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

const ListExchangesInputSchema = z.object({
  detail: z.enum(["summary", "meta", "headers"]).default("summary")
    .describe(
      "Detail tier per exchange. 'summary' (default, ~150 B/exchange) = method, host, path, status, response content-type. 'meta' (~300 B) = summary + header/body byte counts + content-types. 'headers' (1-5 KB) = meta + full headers dict. NEVER returns bodies — use htk_get_exchange for bodies.",
    ),
  url_filter: z.string().min(1).max(500).optional()
    .describe("Case-sensitive substring match on request URL."),
  method_filter: z.string().min(1).max(20).optional()
    .describe("HTTP method filter, case-insensitive (GET, POST, etc.)."),
  status_filter: z.number().int().min(100).max(599).optional()
    .describe("Exact response status code to match. Excludes requests without a response yet."),
  host_filter: z.string().min(1).max(253).optional()
    .describe("Exact or substring match on the request host (Host header). Case-insensitive substring.") ,
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT)
    .describe(`Max exchanges to return. Default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}.`),
  offset: z.number().int().min(0).default(0)
    .describe("Pagination offset into the filtered list. Use with returned nextOffset."),
  newest_first: z.boolean().default(true)
    .describe("If true (default), return newest exchanges first."),
}).strict();

type ListExchangesInput = z.infer<typeof ListExchangesInputSchema>;

server.registerTool(
  "htk_list_exchanges",
  {
    title: "List Buffered Exchanges",
    description: `Read a paginated, context-safe view of exchanges from the in-memory capture buffer populated by htk_start_capture.

DESIGNED TO BE SAFE BY DEFAULT: the default 'summary' detail tier is tiny (~150 B per exchange), so even the full 500-item max response stays well inside any agent's context window. Drill into individual exchanges with htk_get_exchange when needed.

Detail tiers (per-exchange approximate size):
  - summary (default, ~150 B):   id, method, scheme, host, path (truncated), status, response content-type
  - meta    (~300 B):            summary + header/body byte counts + request/response content-types
  - headers (1-5 KB):            meta + full request & response headers dicts

URL handling: URLs are truncated at 256 chars, paths at 128 chars. If truncation occurred, 'urlTruncatedFrom' / 'pathTruncatedFrom' fields report the original length so you know whether to drill down.

Bodies are NEVER included. Call htk_get_exchange(id, include_request_body=true, include_response_body=true) for those.

Filters (all ANDed together):
  - url_filter (string): case-sensitive substring match on the full URL.
  - method_filter (string): HTTP method, case-insensitive.
  - status_filter (int): exact response status; excludes in-flight requests.
  - host_filter (string): case-insensitive substring match on host.

Pagination:
  - limit (int 1-${MAX_LIST_LIMIT}, default ${DEFAULT_LIST_LIMIT}).
  - offset (int).
  - Response returns total (pre-filter), matched (post-filter), returned (this page), hasMore, nextOffset.

Returns:
  {
    "total": number,              // total buffered
    "matched": number,            // total matching filters
    "returned": number,
    "offset": number,
    "hasMore": boolean,
    "nextOffset": number?,
    "detail": "summary" | "meta" | "headers",
    "exchanges": [ ... ]          // shape depends on detail tier
  }`,
    inputSchema: ListExchangesInputSchema.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: ListExchangesInput) => {
    // Over-fetch so we can apply host_filter after the buffer query (buffer
    // doesn't know about host). Cheap since exchanges are in-memory.
    const rawQuery = captureManager.getBuffer().query({
      urlFilter: params.url_filter,
      methodFilter: params.method_filter,
      statusFilter: params.status_filter,
      limit: MAX_LIST_LIMIT * 2,
      offset: 0,
      newestFirst: params.newest_first,
    });

    const hostFilter = params.host_filter?.toLowerCase();
    const hostMatched = hostFilter
      ? rawQuery.exchanges.filter((ex) => {
          try { return new URL(ex.request.url).host.toLowerCase().includes(hostFilter); }
          catch { return false; }
        })
      : rawQuery.exchanges;

    const offset = params.offset;
    const page = hostMatched.slice(offset, offset + params.limit);
    const matched = hostMatched.length;

    const level = params.detail as DetailLevel;
    const rendered = page.map((ex) => render(ex, level));

    const view: {
      total: number; matched: number; returned: number; offset: number;
      hasMore: boolean; nextOffset?: number; detail: DetailLevel;
      exchanges: unknown[];
      truncated?: boolean;
      truncationNote?: string;
    } = {
      total: rawQuery.total,
      matched,
      returned: rendered.length,
      offset,
      hasMore: offset + rendered.length < matched,
      nextOffset: offset + rendered.length < matched ? offset + rendered.length : undefined,
      detail: level,
      exchanges: rendered,
    };

    // Server-side safety net: loop-truncate until under CHARACTER_LIMIT.
    let text = JSON.stringify(view, null, 2);
    while (text.length > CHARACTER_LIMIT && view.exchanges.length > 1) {
      const keep = Math.max(1, Math.floor(view.exchanges.length / 2));
      view.exchanges = view.exchanges.slice(0, keep);
      view.returned = view.exchanges.length;
      view.hasMore = true;
      view.nextOffset = offset + view.exchanges.length;
      view.truncated = true;
      view.truncationNote =
        `Response exceeded ${CHARACTER_LIMIT} chars; halved to ${keep} exchanges. ` +
        `Lower 'detail' level or use filters to see more per page.`;
      text = JSON.stringify(view, null, 2);
    }

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: view as unknown as { [key: string]: unknown },
    };
  },
);

server.registerTool(
  "htk_get_exchange",
  {
    title: "Get Exchange by ID",
    description: `Fetch a single buffered exchange by its request id. Returns metadata + headers (opt-in) + body byte counts + body skip markers. Does NOT return body contents — use htk_get_exchange_body (byte range) or htk_search_exchange_body (regex) for that.

Args:
  - id (string): the exchange id (from htk_list_exchanges).
  - include_request_headers (bool, default false)
  - include_response_headers (bool, default false)`,
    inputSchema: z.object({
      id: z.string().min(1).describe("The exchange id from htk_list_exchanges."),
      include_request_headers: z.boolean().default(false),
      include_response_headers: z.boolean().default(false),
    }).strict().shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    const ex = captureManager.getBuffer().get(params.id);
    if (!ex) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Error: no exchange with id=${params.id} in buffer. Use htk_list_exchanges to find valid ids.`,
        }],
      };
    }
    const view = getExchangeView(ex, {
      includeRequestHeaders: params.include_request_headers,
      includeResponseHeaders: params.include_response_headers,
    });

    // With no bodies here, this response is small; only risk is huge headers.
    let text = JSON.stringify(view, null, 2);
    if (text.length > CHARACTER_LIMIT) {
      view.request.headers = undefined;
      if (view.response) view.response.headers = undefined;
      text = JSON.stringify({
        ...view,
        truncated: true,
        truncationNote: "Headers exceeded character cap and were dropped. Re-fetch without include_*_headers flags.",
      }, null, 2);
    }

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: view as unknown as { [key: string]: unknown },
    };
  },
);

// ----------------------------------------------------------------------------
// Body access: byte-range read + regex search
// ----------------------------------------------------------------------------

function bodyErrorToMcp(id: string, which: "request" | "response", err: BodyAccessError) {
  let text = "";
  switch (err.kind) {
    case "side-missing":
      text = `Error: ${err.reason}. Use htk_get_exchange(id) to check whether a response has arrived.`;
      break;
    case "body-missing":
      text = `Error: ${err.reason} (exchange id=${id}, side=${which}).`;
      break;
    case "body-skipped":
      text = `Error: this exchange's ${which} body was skipped by filter #${err.filterId} (pattern=${err.reason}). Remove the filter with htk_remove_skip_filter to capture future matches, or list filters with htk_list_skip_filters.`;
      break;
    case "body-too-big":
      text = `Error: body is ${err.totalBytes} bytes, exceeding the ${err.limit}-byte cap for regex search. Use htk_get_exchange_body to slice smaller ranges first.`;
      break;
    case "pattern-too-long":
      text = `Error: pattern length ${err.length} exceeds the ${err.limit}-char limit.`;
      break;
    case "bad-regex":
      text = `Error: invalid regex pattern: ${err.message}`;
      break;
  }
  return { isError: true, content: [{ type: "text" as const, text }] };
}

server.registerTool(
  "htk_get_exchange_body",
  {
    title: "Read a Byte Range of an Exchange Body",
    description: `Read a byte range of a captured request or response body. Always paginated — max ${MAX_BODY_RANGE_LENGTH} bytes per call. The response reports the body's totalBytes and a nextOffset for the next slice so you can paginate through large bodies.

The body slice is returned as UTF-8 text when the bytes decode cleanly, otherwise as base64 (the \`encoding\` field tells you which). \`isUtf8\` is false for binary bodies.

Args:
  - id (string): exchange id from htk_list_exchanges.
  - which ("request" | "response"): which side of the exchange to read.
  - offset (int, default 0): byte offset into the body.
  - length (int, default ${MAX_BODY_RANGE_LENGTH}, max ${MAX_BODY_RANGE_LENGTH}): bytes to read.

Errors: body-skipped (filter-suppressed), body-missing (empty / not captured), side-missing (response not yet received).`,
    inputSchema: z.object({
      id: z.string().min(1),
      which: z.enum(["request", "response"]).default("response"),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(MAX_BODY_RANGE_LENGTH).default(MAX_BODY_RANGE_LENGTH),
    }).strict().shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    const ex = captureManager.getBuffer().get(params.id);
    if (!ex) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Error: no exchange with id=${params.id} in buffer.`,
        }],
      };
    }
    const side = params.which === "request" ? ex.request : ex.response;
    const result = getBodyRange(params.id, params.which, side, params.offset, params.length);
    if (!result.ok) return bodyErrorToMcp(params.id, params.which, result.error);
    return jsonResult(result.value as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "htk_search_exchange_body",
  {
    title: "Regex-Search an Exchange Body",
    description: `Run a regex over a captured request or response body and return matches with surrounding byte-context. Each match reports byte offset, 1-indexed lineNumber and column, and configurable before/after context so you can read excerpts without a separate fetch.

Use cases: finding a field in a JSON response, locating a marker in HTML, spotting a token or URL fragment in a payload. Match offsets are byte-level so you can feed them directly into htk_get_exchange_body to read a wider window.

Encoding: regex runs over the body re-interpreted as latin-1, so byte offsets equal character offsets. For UTF-8 text bodies this works naturally for ASCII patterns; for multi-byte chars, encode at the byte level (e.g. "\\xc3\\xa9" for 'é').

Safety caps:
  - Body must be ≤ ${MAX_SEARCHABLE_BODY_BYTES} bytes (${Math.round(MAX_SEARCHABLE_BODY_BYTES / (1024*1024))} MB). Over the limit, use htk_get_exchange_body to slice first.
  - Pattern length ≤ ${MAX_SEARCH_PATTERN_LENGTH} chars.
  - Flags are restricted to \`imsu\` (g is always added).

Args:
  - id (string): exchange id.
  - which ("request" | "response"): side to search.
  - pattern (string): regex pattern.
  - flags (string, default ""): subset of imsu.
  - context_before (int, default ${DEFAULT_SEARCH_CONTEXT}, max 512): bytes before each match in \`before\`.
  - context_after (int, default ${DEFAULT_SEARCH_CONTEXT}, max 512): bytes after each match in \`after\`.
  - max_matches (int, default ${DEFAULT_SEARCH_MAX_MATCHES}, max ${MAX_SEARCH_MAX_MATCHES}).

Returns: { totalMatches, returned, truncated, matches: [{offset, lineNumber, column, match, before, after}] }`,
    inputSchema: z.object({
      id: z.string().min(1),
      which: z.enum(["request", "response"]).default("response"),
      pattern: z.string().min(1).max(MAX_SEARCH_PATTERN_LENGTH),
      flags: z.string().max(8).default(""),
      context_before: z.number().int().min(0).max(512).default(DEFAULT_SEARCH_CONTEXT),
      context_after: z.number().int().min(0).max(512).default(DEFAULT_SEARCH_CONTEXT),
      max_matches: z.number().int().min(1).max(MAX_SEARCH_MAX_MATCHES).default(DEFAULT_SEARCH_MAX_MATCHES),
    }).strict().shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    const ex = captureManager.getBuffer().get(params.id);
    if (!ex) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Error: no exchange with id=${params.id} in buffer.`,
        }],
      };
    }
    const side = params.which === "request" ? ex.request : ex.response;
    const result = searchBody(
      params.id,
      params.which,
      side,
      params.pattern,
      params.flags,
      params.context_before,
      params.context_after,
      params.max_matches,
    );
    if (!result.ok) return bodyErrorToMcp(params.id, params.which, result.error);

    // Server-side safety net: the combined matches+context could blow the cap
    // if the agent requested very large contexts.
    let text = JSON.stringify(result.value, null, 2);
    if (text.length > CHARACTER_LIMIT) {
      const halfPoint = Math.max(1, Math.floor(result.value.matches.length / 2));
      result.value.matches = result.value.matches.slice(0, halfPoint);
      result.value.returned = result.value.matches.length;
      result.value.truncated = true;
      text = JSON.stringify({
        ...result.value,
        truncationNote: `Response exceeded ${CHARACTER_LIMIT} chars; kept first ${halfPoint} matches. Narrow the pattern or reduce context_before/context_after.`,
      }, null, 2);
    }
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: result.value as unknown as { [key: string]: unknown },
    };
  },
);

// ----------------------------------------------------------------------------
// Skip filters: agent can tell the MCP not to store bodies for certain URLs
// ----------------------------------------------------------------------------

server.registerTool(
  "htk_add_skip_filter",
  {
    title: "Add URL Skip Filter",
    description: `Register a URL substring filter. Future requests whose URL contains this (case-insensitive) substring will be captured for their metadata (method/URL/headers/status) but their request AND response bodies will NOT be stored in memory. The exchange shows up in htk_list_exchanges with bodySkipped=true and bodySkipFilterId=<id>.

Intended use: after inspecting htk_buffer_stats and finding that noisy CDNs, ad beacons, or telemetry endpoints are eating the body byte budget, add filters for them to free budget for the traffic you actually care about.

Filters are evaluated at capture time. Already-captured exchanges are not retroactively affected — use htk_clear_capture to drop them.

Args:
  - pattern (string, 1-500 chars): substring to match against request URL (case-insensitive).
  - description (string, optional): human-readable note for the filter, shown by htk_list_skip_filters.

Returns the newly-added filter with its auto-assigned id.`,
    inputSchema: z.object({
      pattern: z.string().min(1).max(500),
      description: z.string().max(200).optional(),
    }).strict().shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => {
    const filter = captureManager.getFilters().add(params.pattern, params.description);
    return jsonResult(filter as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "htk_list_skip_filters",
  {
    title: "List URL Skip Filters",
    description:
      "List all registered skip filters with their id, pattern, description, hit count (how many exchanges have matched them), and creation time.",
    inputSchema: z.object({}).strict().shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => jsonResult({ filters: captureManager.getFilters().list() } as unknown as Record<string, unknown>),
);

server.registerTool(
  "htk_remove_skip_filter",
  {
    title: "Remove a URL Skip Filter",
    description: "Remove the skip filter with the given id. Future requests matching the removed pattern will capture bodies normally. Existing exchanges in the buffer are unchanged.",
    inputSchema: z.object({
      id: z.number().int().min(1),
    }).strict().shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    const removed = captureManager.getFilters().remove(params.id);
    return jsonResult({ removed, remainingFilters: captureManager.getFilters().list() } as unknown as Record<string, unknown>);
  },
);

// ----------------------------------------------------------------------------
// Buffer stats — help the agent decide what to filter
// ----------------------------------------------------------------------------

server.registerTool(
  "htk_buffer_stats",
  {
    title: "Get Buffer Statistics",
    description: `Report total buffered exchanges, body bytes used vs budget, and breakdowns by host / status / method. Use this to spot heavy hosts to target with htk_add_skip_filter when memory pressure is high.

Returns:
  {
    "totalExchanges": number,
    "totalBodyBytes": number,
    "bodyBytesCapacity": number,
    "exchangeCapacity": number,
    "byHost": [{ host, count, bodyBytes }],   // top 10 by bytes
    "byStatus": [{ status, count }],
    "byMethod": [{ method, count }],
    "skippedByFilter": number
  }`,
    inputSchema: z.object({
      top_hosts: z.number().int().min(1).max(50).default(10).describe("Number of top hosts to include in byHost breakdown."),
    }).strict().shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    const stats = captureManager.getBuffer().stats(params.top_hosts);
    return jsonResult(stats as unknown as Record<string, unknown>);
  },
);

// ----------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const tokenStatus =
    config.authTokenSource === "env"
      ? "from env"
      : config.authTokenSource === "auto-detected"
        ? `auto-detected (pid=${config.autoDetect?.pid})`
        : "unset";

  // Auto-start background capture if HTK_SESSION_ID is configured.
  let autoStartStatus = "none";
  if (config.sessionId) {
    try {
      await captureManager.start({
        adminUrl: config.adminUrl,
        sessionId: config.sessionId,
        headers: config.headers,
      });
      autoStartStatus = `started (${config.sessionId})`;
    } catch (err) {
      autoStartStatus = `failed: ${(err as Error).message}`;
    }
  }

  console.error(
    `htk-traffic-tap-mcp v${MCP_SERVER_VERSION} running on stdio ` +
    `(serverUrl=${config.serverUrl}, adminUrl=${config.adminUrl}, ` +
    `token=${tokenStatus}, session=${config.sessionId ? "env-override" : "managed-lazy"}, ` +
    `auto-capture=${autoStartStatus})`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
