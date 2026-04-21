export const DEFAULT_ADMIN_URL = "http://127.0.0.1:45456";
export const DEFAULT_SERVER_URL = "http://127.0.0.1:45457";

/** MCP tool response cap — keep agent context safe. */
export const CHARACTER_LIMIT = 25000;

/** Capture buffer sizing — overridable by env. */
const DEFAULT_BUFFER_CAPACITY = 2000;
const DEFAULT_BODY_BUDGET_MB = 100;

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export const BUFFER_CAPACITY = envInt("HTK_EXCHANGE_CAP", DEFAULT_BUFFER_CAPACITY, 1);
export const BODY_BUDGET_BYTES =
  envInt("HTK_BODY_BUDGET_MB", DEFAULT_BODY_BUDGET_MB, 1) * 1024 * 1024;

/** Per-call caps on body-access tools. */
export const MAX_BODY_RANGE_LENGTH = 8 * 1024;          // 8 KB per fetch
export const MAX_SEARCHABLE_BODY_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_SEARCH_PATTERN_LENGTH = 500;
export const DEFAULT_SEARCH_CONTEXT = 64;
export const DEFAULT_SEARCH_MAX_MATCHES = 20;
export const MAX_SEARCH_MAX_MATCHES = 100;

export const SESSION_PROBE_TIMEOUT_MS = 2000;
