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

import {
  DEFAULT_SEARCH_CONTEXT,
  DEFAULT_SEARCH_MAX_MATCHES,
  MAX_BODY_RANGE_LENGTH,
  MAX_SEARCHABLE_BODY_BYTES,
  MAX_SEARCH_MAX_MATCHES,
  MAX_SEARCH_PATTERN_LENGTH,
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
}

/** Possible failure modes a caller can translate into MCP errors. */
export type BodyAccessError =
  | { kind: "body-skipped"; reason: string; filterId?: number }
  | { kind: "body-missing"; reason: string }
  | { kind: "side-missing"; reason: string }        // e.g. response not arrived yet
  | { kind: "body-too-big"; totalBytes: number; limit: number }
  | { kind: "pattern-too-long"; length: number; limit: number }
  | { kind: "bad-regex"; message: string };

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
  const matches: SearchMatch[] = [];
  let totalMatches = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    totalMatches++;
    if (matches.length < cappedMax) {
      const offset = m.index;
      const end = offset + m[0].length;
      const { lineNumber, column } = locate(buf, offset);
      matches.push({
        offset,
        lineNumber,
        column,
        match: latin1SliceAsUtf8(buf, offset, end),
        before: latin1SliceAsUtf8(buf, offset - ctxBefore, offset),
        after: latin1SliceAsUtf8(buf, end, end + ctxAfter),
      });
    }
    if (m[0].length === 0) re.lastIndex++;
  }

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
  }
  return { ok: true, value: result };
}
