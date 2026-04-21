export interface BodyData {
  /**
   * Body bytes as stored in the buffer. If the wire body had a supported
   * Content-Encoding (gzip / deflate / br), this is the DECODED bytes — so
   * regex search / UTF-8 decoding work directly. The original wire encoding
   * is recorded in wireEncoding for transparency. Undefined if skipped/absent.
   */
  bodyBuffer?: Buffer;
  /** Convenience: bodyBuffer?.byteLength ?? 0. Reported even when skipped (will be 0). */
  bodyBytes: number;
  /**
   * If the server sent the body with a supported Content-Encoding, this is
   * the name of that encoding (e.g. "gzip"). bodyBuffer above is the
   * DECOMPRESSED form. Undefined means the body was stored as-is.
   */
  wireEncoding?: string;
  /** Size of the body as it was on the wire (pre-decompression), if different from bodyBytes. */
  wireBodyBytes?: number;
  /** True when a URL skip filter matched this exchange — body intentionally not captured. */
  bodySkipped?: boolean;
  /** Filter id that caused the skip, if any. */
  bodySkipFilterId?: number;
  /** Human-readable reason (the filter pattern), for agent UX. */
  bodySkipPattern?: string;
}

export interface CapturedRequest extends BodyData {
  id: string;
  method: string;
  url: string;
  protocol: string;
  headers: Record<string, string>;
  remoteIpAddress?: string;
  tags: string[];
}

export interface CapturedResponse extends BodyData {
  id: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  tags: string[];
}

export interface CapturedExchange {
  request: CapturedRequest;
  response?: CapturedResponse;
}

export type ServerState =
  | "ok"
  | "auth_rejected"
  | "http_error"
  | "unreachable";

export interface ConnectionStatus {
  serverUrl: string;
  adminUrl: string;
  serverState: ServerState;
  serverReachable: boolean;
  serverVersion?: string;
  serverStatusCode?: number;
  serverErrorReason?: string;
  authTokenConfigured: boolean;
  authTokenSource: "env" | "auto-detected" | "none";
  authTokenAutoDetect?: {
    attempted: boolean;
    attemptedPids: number[];
    matchedPid?: number;
    reason?: string;
  };
  sessionIdConfigured: boolean;
  sessionIdResolved?: string;
  sessionSource?: "env-override";
  captureState: "idle" | "connecting" | "running" | "stopped";
  captureBufferedExchanges: number;
  /**
   * A multi-paragraph string the AI agent should relay verbatim. Tells them
   * whether to start a capture, how to get the UUID, and what limitations apply.
   */
  guidance: string;
  hint?: string;
}
