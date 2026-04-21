/**
 * Byte-level access helpers for captured bodies. Two flavors:
 *   - getBodyRange — slice [offset, offset+length) of the body
 *   - searchBody   — regex scan with surrounding byte-context, line numbers
 *
 * Both operate on Buffer and report byte-level offsets, so results from search
 * can feed straight into getBodyRange.
 *
 * Regex runs over body.toString('latin1') — each byte becomes one 16-bit code
 * unit, so JS string offsets align exactly with byte offsets. The matched
 * substring and the context slices are then re-encoded as UTF-8 so text bodies
 * render naturally in the agent's output. This means Unicode-in-the-body works
 * for display but regex patterns should encode characters at the byte level if
 * the body is UTF-8 (e.g. 'é' is `\xc3\xa9` in UTF-8; either spelling will hit).
 *
 * Hard limits (see constants.ts):
 *   - body size ≤ 8 MB to run regex; over that we error out and tell the agent
 *     to use getBodyRange with a narrower slice.
 *   - pattern length ≤ 500 chars to keep compilation bounded.
 *   - slice length ≤ 8 KB per getBodyRange call (agent paginates).
 */

import vm from "node:vm";
import {
  DEFAULT_SEARCH_CONTEXT,
  DEFAULT_SEARCH_MAX_MATCHES,
  MAX_BODY_RANGE_LENGTH,
  MAX_SEARCHABLE_BODY_BYTES,
  MAX_SEARCH_MAX_MATCHES,
  MAX_SEARCH_PATTERN_LENGTH,
  SEARCH_TIMEOUT_MS,
} from "./constants.js";
import type { BodyData } from "./types.js";

export type BodySide = "request" | "response";

export interface BodyRangeResult {
  id: string;
  which: BodySide;
  totalBytes: number;
  offset: number;
  length: number;
  hasMore: boolean;
  nextOffset?: number;
  isUtf8: boolean;
  encoding: "utf-8" | "base64";
  body: string;
  bodySkipped?: boolean;
  bodySkipReason?: string;
  /**
   * Set when the wire body was advertised as gzip/deflate/br but decompression
   * failed. The returned bytes are the raw compressed stream — agents should
   * expect garbage and tell the user.
   */
  decompressionFailed?: boolean;
  wireEncoding?: string;
  warning?: string;
}

export interface SearchMatch {
  offset: number;        // byte offset in the body
  lineNumber: number;    // 1-indexed (LF count)
  column: number;        // 1-indexed byte column on that line
  match: string;
  before: string;
  after: string;
}

export interface SearchResult {
  id: string;
  which: BodySide;
  totalBytes: number;
  pattern: string;
  flags: string;
  totalMatches: number;
  returned: number;
  truncated: boolean;
  matches: SearchMatch[];
  bodySkipped?: boolean;
  bodySkipReason?: string;
  /** See BodyRangeResult.decompressionFailed. */
  decompressionFailed?: boolean;
  wireEncoding?: string;
  warning?: string;
  /** Agent-facing retry hint — e.g. on zero matches. */
  hint?: string;
}

/** Possible failure modes a caller can translate into MCP errors. */
export type BodyAccessError =
  | { kind: "body-skipped"; reason: string; filterId?: number }
  | { kind: "body-missing"; reason: string }
  | { kind: "side-missing"; reason: string }        // e.g. response not arrived yet
  | { kind: "body-too-big"; totalBytes: number; limit: number }
  | { kind: "pattern-too-long"; length: number; limit: number }
  | { kind: "bad-regex"; message: string }
  | { kind: "search-timeout"; timeoutMs: number };

export type Result<T> = { ok: true; value: T } | { ok: false; error: BodyAccessError };

export function getBodyRange(
  id: string,
  which: BodySide,
  side: BodyData | undefined,
  offset: number,
  length: number,
): Result<BodyRangeResult> {
  if (!side) {
    return { ok: false, error: { kind: "side-missing",
      reason: which === "response"
        ? "no response yet for this exchange"
        : "request has no body side" } };
  }
  if (side.bodySkipped) {
    return { ok: false, error: { kind: "body-skipped",
      reason: side.bodySkipPattern ?? "skipped",
      filterId: side.bodySkipFilterId } };
  }
  const buf = side.bodyBuffer;
  if (!buf) {
    return { ok: false, error: { kind: "body-missing",
      reason: side.bodyBytes === 0
        ? "body is empty (0 bytes)"
        : "body was not captured" } };
  }

  const total = buf.byteLength;
  const clampedOffset = Math.max(0, Math.min(Math.floor(offset), total));
  const requested = Math.max(0, Math.floor(length));
  const clampedLength = Math.min(requested, MAX_BODY_RANGE_LENGTH, total - clampedOffset);
  const slice = buf.subarray(clampedOffset, clampedOffset + clampedLength);

  const decoded = slice.toString("utf-8");
  const reEncoded = Buffer.from(decoded, "utf-8");
  const isUtf8 = reEncoded.equals(slice);

  const hasMore = clampedOffset + clampedLength < total;

  const result: BodyRangeResult = {
    id,
    which,
    totalBytes: total,
    offset: clampedOffset,
    length: clampedLength,
    hasMore,
    nextOffset: hasMore ? clampedOffset + clampedLength : undefined,
    isUtf8,
    encoding: isUtf8 ? "utf-8" : "base64",
    body: isUtf8 ? decoded : slice.toString("base64"),
  };
  if (side.bodyDecompressionFailed) {
    result.decompressionFailed = true;
    result.wireEncoding = side.wireEncoding;
    result.warning = `Body is still ${side.wireEncoding}-compressed; on-the-fly decompression failed at capture time. These bytes are the raw compressed stream and will not look like text.`;
  }
  return { ok: true, value: result };
}

function locate(buf: Buffer, offset: number): { lineNumber: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < buf.byteLength; i++) {
    if (buf[i] === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { lineNumber: line, column: offset - lineStart + 1 };
}

function latin1SliceAsUtf8(buf: Buffer, start: number, end: number): string {
  const s = buf.subarray(Math.max(0, start), Math.min(buf.byteLength, end));
  // s is already a Buffer; rendering as utf-8 gracefully handles text bodies;
  // for binary, invalid sequences become U+FFFD but that's fine for display.
  return s.toString("utf-8");
}

export function searchBody(
  id: string,
  which: BodySide,
  side: BodyData | undefined,
  pattern: string,
  flags: string = "",
  contextBefore: number = DEFAULT_SEARCH_CONTEXT,
  contextAfter: number = DEFAULT_SEARCH_CONTEXT,
  maxMatches: number = DEFAULT_SEARCH_MAX_MATCHES,
): Result<SearchResult> {
  if (!side) {
    return { ok: false, error: { kind: "side-missing",
      reason: which === "response" ? "no response yet for this exchange" : "request has no body side" } };
  }
  if (side.bodySkipped) {
    return { ok: false, error: { kind: "body-skipped",
      reason: side.bodySkipPattern ?? "skipped",
      filterId: side.bodySkipFilterId } };
  }
  const buf = side.bodyBuffer;
  if (!buf) {
    return { ok: false, error: { kind: "body-missing",
      reason: side.bodyBytes === 0 ? "body is empty (0 bytes)" : "body was not captured" } };
  }
  if (buf.byteLength > MAX_SEARCHABLE_BODY_BYTES) {
    return { ok: false, error: { kind: "body-too-big",
      totalBytes: buf.byteLength, limit: MAX_SEARCHABLE_BODY_BYTES } };
  }
  if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
    return { ok: false, error: { kind: "pattern-too-long",
      length: pattern.length, limit: MAX_SEARCH_PATTERN_LENGTH } };
  }

  // Sanitize flags: keep only i, m, s, u. Always add g for iteration.
  const flagSet = new Set<string>();
  for (const c of flags) if ("imsu".includes(c)) flagSet.add(c);
  flagSet.add("g");
  const safeFlags = [...flagSet].join("");

  let re: RegExp;
  try {
    re = new RegExp(pattern, safeFlags);
  } catch (err) {
    return { ok: false, error: { kind: "bad-regex", message: (err as Error).message } };
  }

  const cappedMax = Math.max(1, Math.min(MAX_SEARCH_MAX_MATCHES, Math.floor(maxMatches)));
  const ctxBefore = Math.max(0, Math.min(512, Math.floor(contextBefore)));
  const ctxAfter = Math.max(0, Math.min(512, Math.floor(contextAfter)));

  const haystack = buf.toString("latin1");

  // Run matching inside a vm sandbox so the SEARCH_TIMEOUT_MS wall-clock cap
  // applies. This catches most catastrophic-backtracking patterns; combined
  // with the pattern-length / body-size caps it keeps the tool bounded.
  let raw: { out: Array<{ index: number; length: number }>; total: number };
  try {
    raw = vm.runInNewContext(
      `(function (re, haystack, cappedMax) {
        const out = [];
        let total = 0;
        let m;
        while ((m = re.exec(haystack)) !== null) {
          total++;
          if (out.length < cappedMax) out.push({ index: m.index, length: m[0].length });
          if (m[0].length === 0) re.lastIndex++;
        }
        return { out: out, total: total };
      })(re, haystack, cappedMax)`,
      { re, haystack, cappedMax },
      { timeout: SEARCH_TIMEOUT_MS },
    ) as { out: Array<{ index: number; length: number }>; total: number };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("Script execution timed out")) {
      return { ok: false, error: { kind: "search-timeout", timeoutMs: SEARCH_TIMEOUT_MS } };
    }
    throw err;
  }
  const totalMatches = raw.total;
  const matches: SearchMatch[] = raw.out.map(({ index, length }) => {
    const end = index + length;
    const { lineNumber, column } = locate(buf, index);
    return {
      offset: index,
      lineNumber,
      column,
      match: latin1SliceAsUtf8(buf, index, end),
      before: latin1SliceAsUtf8(buf, index - ctxBefore, index),
      after: latin1SliceAsUtf8(buf, end, end + ctxAfter),
    };
  });

  const result: SearchResult = {
    id,
    which,
    totalBytes: buf.byteLength,
    pattern,
    flags: safeFlags,
    totalMatches,
    returned: matches.length,
    truncated: totalMatches > matches.length,
    matches,
  };
  if (side.bodyDecompressionFailed) {
    result.decompressionFailed = true;
    result.wireEncoding = side.wireEncoding;
    result.warning = `0 matches may be expected: body is still ${side.wireEncoding}-compressed (decompression failed at capture time). The regex ran against raw compressed bytes.`;
  } else if (totalMatches === 0) {
    result.hint = "0 matches. If the pattern expected text, try the `i` flag for case-insensitive matching, or widen it. For UTF-8 text with non-ASCII chars, remember the regex runs on latin-1 bytes (e.g. 'é' is \\xc3\\xa9). Use htk_get_exchange_body to inspect raw bytes if the body might be binary.";
  }
  return { ok: true, value: result };
}
