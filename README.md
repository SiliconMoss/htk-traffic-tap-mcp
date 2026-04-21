# htk-traffic-tap-mcp

> **Unofficial — not affiliated with HTTP Toolkit.** This is a community-built, deliberately minimal MCP server. The name deliberately avoids `httptoolkit-*`: it uses the `htk-` abbreviation (the same prefix HTT's own env vars use: `HTK_SERVER_TOKEN`, `HTK_SESSION_ID`) and `-tap-` — networking terminology for a passive, read-only listening point. Distributed straight from this GitHub repo, not from the npm registry.

A minimal, read-only MCP server that taps into a running HTTP Toolkit session so AI assistants can read captured HTTP(S) traffic.

## Why this exists and what it isn't

There is no official HTTP Toolkit MCP. Another third-party package (`httptoolkit-mcp` on npm, by `fdciabdul`) picked a name that sounds official but ships a large attack surface — an arbitrary HTTP request tool (SSRF-capable), a server-shutdown tool, shell-based token harvesting via `/proc/{pid}/environ`, and broad device/interceptor management — from a single-developer account with no community vetting.

This project takes the opposite approach on every axis:

- **Scope**: reads captured traffic. Nothing else. No interceptor launching, no server control, no HTTP request sending, no rule management.
- **Name**: `htk-traffic-tap-mcp` (third-party abbreviation, `tap` = passive listener), scoped to an individual npm account. Zero chance of being mistaken for an official tool.
- **Surface**: 7 tools total; 5 of them are read-only and 2 are start/stop for the single background capture.

If you want the full HTT feature surface (launching interceptors, configuring rules, etc.) use HTT's own UI or REST API directly. This MCP is explicitly *not* a wrapper for that — just a traffic reader.

## Design constraints

- **Read-only.** No arbitrary HTTP requests. No server shutdown. No interceptor management.
- **Local-only.** Refuses to connect to any non-loopback address (`127.0.0.1`, `::1`, `localhost`).
- **No shell commands.** All file reads go through `fs`. All process interactions go through the HTTP Toolkit API (one exception: token auto-detection uses `koffi` FFI + PowerShell `Get-CimInstance` on Windows — argv-safe, no shell injection surface).
- **Auth token handling.** On Windows the `HTK_SERVER_TOKEN` is auto-detected by reading the env block of the running `httptoolkit-server` subprocess (same user, same integrity — no privilege escalation). Override with the env var, disable with `HTK_DISABLE_TOKEN_AUTODETECT=1`.
- **Bounded output.** Per-request body truncation (2 KB req / 4 KB resp), overall MCP reply capped at 25k chars, buffer capped at 5000 exchanges with ring-buffer eviction.

## Tools

| Tool | Description |
|------|-------------|
| `htk_check_connection` | Diagnostic. Confirms the HTTP Toolkit admin server is reachable, reports token-detection status, capture state, and surfaces instructions when idle. |
| `htk_start_capture` | Starts a long-running background subscription to a session and accumulates exchanges in memory. Pass `session_id` once; then leave it running. |
| `htk_stop_capture` | Stops the running subscription. Buffer preserved for further queries. |
| `htk_capture_status` | Reports whether capture is running, which session, how long it's been running, how many exchanges are buffered. Includes `guidance` text the agent can read to the user. |
| `htk_clear_capture` | Empties the buffer without stopping capture. |
| `htk_list_exchanges` | Paginated, tiered-detail query over the buffer. Summary view is ~150 B per exchange (default); `meta` adds byte counts; `headers` adds full headers. Bodies are never included here. Filter by URL/host substring, HTTP method, response status. |
| `htk_get_exchange` | Fetches a single exchange by id. Headers and bodies are opt-in (`include_request_headers`, `include_request_body`, `include_response_headers`, `include_response_body`) so you pay only for what you need. |

## How capture works

Each Mockttp admin session (HTTP Toolkit is built on Mockttp) is **isolated**: events from one session's proxy port never appear on another session's event bus. The HTTP Toolkit UI creates its own session; that session's UUID is not exposed via any API — it lives only in the UI's JS heap.

To tap into the UI's session, this MCP needs the UUID. You fetch it once with a one-line DevTools snippet (below) and pass it to `htk_start_capture`. From that moment on, the MCP holds a GraphQL subscription open to the UI's session and buffers every `requestReceived` / `responseCompleted` event in memory.

**Important limitation:** the subscription only sees traffic that flows **after** it's started. The admin server does not expose historical events, and the UI's in-memory list of past traffic is not reachable. If you need to analyze existing activity, reproduce it after starting the capture.

## Recommended workflow

1. Start HTTP Toolkit and activate interceptors as usual (Fresh Chrome, Android ADB, etc.) in the UI.
2. Grab the UI's session UUID from its DevTools console. Open the HTT window, press **Ctrl+Shift+I**, go to the **Console** tab, paste this and press Enter:
   ```javascript
   copy([...new Set(
     performance.getEntriesByType('resource')
       .flatMap(e => (e.name.match(/\/session\/([0-9a-f-]{36})/i) || []).slice(1))
   )][0])
   ```
   The UUID is now on the clipboard.
3. Call `htk_start_capture` with that UUID. (Or set `HTK_SESSION_ID` in your MCP client config so the MCP auto-starts capture on boot.)
4. Do your work — browse, tap around in the Android app, exercise the backend, etc.
5. Ask the AI to analyze traffic. It calls `htk_list_exchanges` with filters (URL substring, method, status) to find relevant requests, then `htk_get_exchange(id)` for full request/response bodies.
6. Buffer holds up to 5000 exchanges (oldest evicted). Call `htk_clear_capture` if you want to reset.

When HTTP Toolkit is restarted or its UI reloaded, the session UUID rotates — call `htk_start_capture` again with the fresh UUID. `htk_capture_status` and `htk_check_connection` both return `guidance` text walking the agent through this when needed.

## Prerequisites

- Node.js ≥ 18
- HTTP Toolkit desktop app installed and running
- At least one active interceptor (browser, device, Docker container, etc.) sending traffic through HTTP Toolkit

## Install

This package is installed directly from GitHub via `npx` — no npm registry account needed. Add this to your MCP client config:

```json
{
  "mcpServers": {
    "httptoolkit": {
      "command": "npx",
      "args": ["-y", "github:SiliconMoss/htk-traffic-tap-mcp"]
    }
  }
}
```

On first invocation `npx` clones the repo, runs `npm install` (which auto-builds via the `prepare` script), and starts the server. Subsequent runs are cached. To pin to a specific release, append a tag: `github:SiliconMoss/htk-traffic-tap-mcp#v0.1.0`.

Prerequisites on your machine: **Node.js ≥ 18** and **git** (both are standard on most dev machines).

### Local development (clone + build)

```bash
git clone https://github.com/SiliconMoss/htk-traffic-tap-mcp.git
cd htk-traffic-tap-mcp
npm install   # runs `prepare` which builds automatically
```

Then point your MCP client at the absolute path:

```json
{
  "mcpServers": {
    "httptoolkit": {
      "command": "node",
      "args": ["/absolute/path/to/htk-traffic-tap-mcp/dist/index.js"]
    }
  }
}
```

## Configuration (environment variables)

All optional; defaults match a standard HTTP Toolkit desktop install.

| Variable | Default | Notes |
|----------|---------|-------|
| `HTK_SERVER_URL` | `http://127.0.0.1:45457` | REST API. Must be loopback. |
| `HTK_ADMIN_URL`  | `http://127.0.0.1:45456` | Admin/WebSocket port. Must be loopback. |
| `HTK_SERVER_TOKEN` | _(unset)_ | Required for the prod HTTP Toolkit build. **Auto-detected on Windows** via PEB walk of the running `httptoolkit-server` process. Set explicitly to override. |
| `HTK_DISABLE_TOKEN_AUTODETECT` | _(unset)_ | Set to `1` to disable Windows token auto-detection. |
| `HTK_SESSION_ID` | _(unset)_ | HTTP Toolkit session UUID. If set, background capture auto-starts on MCP boot. |

### Auto-start on boot

On Windows, no `env` block is needed — `HTK_SERVER_TOKEN` is auto-detected. If you want the MCP to auto-start background capture when it boots (instead of you calling `htk_start_capture` manually), add `HTK_SESSION_ID` to the `env` block:

```json
"env": { "HTK_SESSION_ID": "<paste-uuid-here>" }
```

The UUID rotates each HTT launch, so explicit `htk_start_capture` calls are usually the better workflow.

## Example tool calls

```jsonc
// Diagnostic — tells you whether HTT is reachable and whether capture is running
{ "name": "htk_check_connection", "arguments": {} }

// Start a capture against the UI's session
{
  "name": "htk_start_capture",
  "arguments": { "session_id": "0e777654-960c-47e1-a456-09bb1c595212" }
}

// List requests to a specific host, newest first
{
  "name": "htk_list_exchanges",
  "arguments": { "url_filter": "api.example.com", "limit": 20 }
}

// Fetch full request/response body for one exchange
{
  "name": "htk_get_exchange",
  "arguments": { "id": "abc117b4-77bc-4804-a4fa-6c1934c9c349" }
}
```

## Context-budget design

An MCP running on an agent's critical path must not be able to blow the context window. This server is designed so the *default* `htk_list_exchanges` response stays around **10 KB even at 50 exchanges** — fine for any agent. Concretely:

- **URLs truncated** at 256 chars, **paths** at 128 chars. If truncated, `urlTruncatedFrom` / `pathTruncatedFrom` report the original length.
- **Three detail tiers** for `htk_list_exchanges` (agent picks the cheapest that answers the question):
  - `summary` (default, ~150 B/exchange): `id`, `method`, `scheme`, `host`, `path`, `status`, `responseContentType`
  - `meta` (~300 B/exchange): summary + byte counts + request/response content-types
  - `headers` (1–5 KB/exchange): meta + full headers
- **Bodies never appear in lists** — only in `htk_get_exchange`, and even there they're opt-in via `include_request_body` / `include_response_body`.
- **Opt-in headers on `htk_get_exchange`** too, via `include_request_headers` / `include_response_headers`.
- **Hard server-side safety net**: the response is halved and re-serialized in a loop until under 25 KB. If that trips, the response includes `truncated: true` and `truncationNote` telling the agent to paginate or lower the detail tier.
- **Pagination defaults**: 50 per page, max 500. Every response reports `total`, `matched`, `returned`, `hasMore`, `nextOffset`.

## Example output (htk_list_exchanges, default `summary`)

```jsonc
{
  "total": 127,
  "matched": 8,
  "returned": 8,
  "offset": 0,
  "hasMore": false,
  "detail": "summary",
  "exchanges": [
    {
      "id": "abc-...",
      "method": "POST",
      "scheme": "https",
      "host": "api.example.com",
      "path": "/v1/things",
      "url": "https://api.example.com/v1/things",
      "status": 200,
      "responseContentType": "application/json",
      "hasResponse": true
    }
  ]
}
```

Bump `detail` to `meta` for sizes and content-types, `headers` for full header dicts. Call `htk_get_exchange(id, include_*)` for bodies.

## What this server will NOT do

- Send HTTP requests to arbitrary URLs
- Shut down, update, or configure the HTTP Toolkit server
- Launch browsers, attach to Docker containers, or manage mobile/desktop interceptors
- Connect to non-loopback network addresses
- Read other users' process memory or credentials

Interceptors are configured manually through the HTT UI. This server only observes the results.

## Known caveats

- **Responses to HTTP Toolkit's own built-in mock rules** (e.g. the `amiusing.httptoolkit.tech` self-check endpoint, certificate-fetch endpoints) may not fire the `responseCompleted` subscription — only `requestReceived`. You'll see the request but no response. Real pass-through traffic to external hosts captures both sides correctly; this affects only HTT's internal machinery.
- **Buffer lives in memory only.** When the MCP process restarts, everything is lost. Call `htk_start_capture` again (or use `HTK_SESSION_ID` for auto-start).

## Releasing (for maintainers)

CI runs on every push to `main` and every PR (typecheck + build across Node 20/22 on Linux/macOS/Windows). To cut a release:

```bash
# 1. bump version (patch/minor/major) — this creates a commit and a tag locally
npm version patch

# 2. push the commit and the tag
git push --follow-tags
```

The `Release` workflow fires on any pushed tag matching `v*.*.*`:
1. Checks the tag matches `package.json#version`
2. Creates a GitHub Release with auto-generated notes and a prefilled `npx` install snippet pinned to the tag

No npm registry publishing — users install via `npx github:SiliconMoss/htk-traffic-tap-mcp#<tag>` directly. No secrets to configure, no tokens to manage.

## License

MIT
