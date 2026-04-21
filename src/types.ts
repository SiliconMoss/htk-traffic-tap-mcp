export interface CapturedRequest {
  id: string;
  method: string;
  url: string;
  protocol: string;
  headers: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
  remoteIpAddress?: string;
  tags: string[];
}

export interface CapturedResponse {
  id: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
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
   * Full user-facing guidance the agent should relay verbatim. Tells them
   * whether to start a capture, how to get the UUID, and what limitations apply.
   */
  guidance: string;
  hint?: string;
}
