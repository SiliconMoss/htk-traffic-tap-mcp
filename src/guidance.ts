/**
 * Shared user-facing guidance snippets. These are embedded in tool outputs so
 * AI agents can relay them verbatim to the user without having to know the
 * underlying architecture.
 */

export const DEVTOOLS_UUID_SNIPPET =
  "copy([...new Set(performance.getEntriesByType('resource').flatMap(e => (e.name.match(/\\/session\\/([0-9a-f-]{36})/i) || []).slice(1)))][0])";

export const HOW_TO_GET_SESSION_ID = [
  "This MCP cannot discover the HTTP Toolkit UI's session UUID automatically — it only lives in the UI's JS heap.",
  "Ask the user to do this ONCE per HTTP Toolkit launch:",
  "  1. In the HTTP Toolkit window, press Ctrl+Shift+I (or View -> Toggle Developer Tools).",
  "  2. Open the Console tab.",
  "  3. Paste this exact snippet and press Enter:",
  `       ${DEVTOOLS_UUID_SNIPPET}`,
  "  4. The session UUID is now on their clipboard (a UUID like 595023a0-99fc-473d-aed0-75de6aef0100).",
  "  5. They paste it back to you; you call htk_start_capture with session_id set to that UUID.",
].join("\n");

export const POST_START_WARNING =
  "IMPORTANT: this capture buffers traffic that flows AFTER htk_start_capture was called. " +
  "Traffic the user already generated in the HTTP Toolkit UI before this MCP server started capturing is NOT retrievable — the HTTP Toolkit admin server does not expose historical events. " +
  "If the user asks you to analyze traffic they've 'already seen' in the HTTP Toolkit UI, tell them they need to reproduce it after htk_start_capture is running.";

export const SESSION_ROTATES_WARNING =
  "Each time HTTP Toolkit is restarted (or its UI is reloaded) it generates a NEW session UUID. " +
  "If a capture suddenly stops delivering events, or htk_check_connection reports 'auth_rejected', the UUID is likely stale — ask the user to re-run the DevTools snippet and call htk_start_capture with the fresh UUID.";
