import { CaptureBuffer } from "./buffer.js";
import { subscribeToSession, type Subscription } from "./capture.js";
import { MCP_SERVER_VERSION } from "./constants.js";
import { FilterRegistry } from "./filters.js";
import {
  HOW_TO_GET_SESSION_ID,
  POST_START_WARNING,
  SESSION_ROTATES_WARNING,
} from "./guidance.js";

export type ManagerState =
  | { kind: "idle" }
  | { kind: "connecting"; sessionId: string; startedAt: number }
  | { kind: "running"; sessionId: string; startedAt: number }
  | { kind: "stopped"; sessionId: string; startedAt: number; stoppedAt: number; reason: string };

export interface ManagerStatus {
  mcpServerVersion: string;
  state: "idle" | "connecting" | "running" | "stopped";
  /**
   * True only when state === "running" and no subscription error has been
   * reported. An agent should treat false as "capture may not be delivering
   * events, warn the user" even if `state` is "running".
   */
  healthy: boolean;
  sessionId?: string;
  startedAt?: number;
  startedAtIso?: string;
  stoppedAt?: number;
  stoppedAtIso?: string;
  reason?: string;
  bufferedExchanges: number;
  bufferCapacity: number;
  bufferedBodyBytes: number;
  bodyBudgetBytes: number;
  skipFilters: number;
  lastError?: string;
  guidance: string;
}

export interface StartOptions {
  adminUrl: string;
  sessionId: string;
  headers: Record<string, string>;
}

export class CaptureManager {
  private state: ManagerState = { kind: "idle" };
  private subscription?: Subscription;
  private lastError?: string;
  private connectingTimer?: NodeJS.Timeout;
  private readonly filters = new FilterRegistry();

  constructor(private readonly buffer: CaptureBuffer) {}

  private markRunning(sessionId: string, startedAt: number): void {
    if (this.state.kind === "connecting" && this.state.sessionId === sessionId) {
      this.state = { kind: "running", sessionId, startedAt };
    }
    if (this.connectingTimer) {
      clearTimeout(this.connectingTimer);
      this.connectingTimer = undefined;
    }
  }

  async start(opts: StartOptions): Promise<ManagerStatus> {
    if (
      this.subscription &&
      this.state.kind !== "idle" &&
      "sessionId" in this.state &&
      this.state.sessionId !== opts.sessionId
    ) {
      this.stopInternal("replaced by start() with different session_id");
      this.buffer.clear();
    } else if (this.state.kind === "running" && this.state.sessionId === opts.sessionId) {
      return this.status();
    }

    const startedAt = Date.now();
    this.state = { kind: "connecting", sessionId: opts.sessionId, startedAt };
    this.lastError = undefined;

    this.subscription = subscribeToSession({
      adminUrl: opts.adminUrl,
      sessionId: opts.sessionId,
      headers: opts.headers,
      filters: this.filters,
      onReady: () => this.markRunning(opts.sessionId, startedAt),
      onEvent: (event) => {
        // Fallback: some servers might skip connection_ack in edge cases;
        // first real event also counts as "running".
        this.markRunning(opts.sessionId, startedAt);
        // A successful event means the subscription is live again; clear any
        // transient error so `healthy` recovers.
        this.lastError = undefined;
        if (event.kind === "request") {
          this.buffer.pushRequest(event.exchange);
        } else if (event.kind === "response") {
          this.buffer.attachResponse(event.requestId, event.response);
        }
      },
      onError: (err) => {
        this.lastError = err.message;
      },
      onClose: () => {
        if (this.connectingTimer) {
          clearTimeout(this.connectingTimer);
          this.connectingTimer = undefined;
        }
        if (this.state.kind !== "stopped" && this.state.kind !== "idle") {
          this.state = {
            kind: "stopped",
            sessionId: this.state.sessionId,
            startedAt: "startedAt" in this.state ? this.state.startedAt : Date.now(),
            stoppedAt: Date.now(),
            reason: this.lastError ?? "WebSocket closed",
          };
        }
        this.subscription = undefined;
      },
    });

    // Fallback to transition out of "connecting" if the server never sends
    // connection_ack (shouldn't happen, but guards the UI against a stuck
    // state). Normal path fires via onReady well before this.
    this.connectingTimer = setTimeout(() => {
      this.connectingTimer = undefined;
      this.markRunning(opts.sessionId, startedAt);
    }, 2000);

    return this.status();
  }

  stop(reason: string = "stopped by user"): ManagerStatus {
    this.stopInternal(reason);
    return this.status();
  }

  private stopInternal(reason: string): void {
    if (this.connectingTimer) {
      clearTimeout(this.connectingTimer);
      this.connectingTimer = undefined;
    }
    if (this.subscription) {
      try { this.subscription.close(); } catch { /* ignore */ }
      this.subscription = undefined;
    }
    if (this.state.kind === "running" || this.state.kind === "connecting") {
      this.state = {
        kind: "stopped",
        sessionId: this.state.sessionId,
        startedAt: this.state.startedAt,
        stoppedAt: Date.now(),
        reason,
      };
    }
  }

  clear(): void {
    this.buffer.clear();
  }

  getBuffer(): CaptureBuffer {
    return this.buffer;
  }

  getFilters(): FilterRegistry {
    return this.filters;
  }

  status(): ManagerStatus {
    const cap = this.buffer.capacity();
    const base: ManagerStatus = {
      mcpServerVersion: MCP_SERVER_VERSION,
      state: this.state.kind,
      healthy: this.state.kind === "running" && !this.lastError,
      bufferedExchanges: this.buffer.size(),
      bufferCapacity: cap.exchanges,
      bufferedBodyBytes: this.buffer.bodyBytes(),
      bodyBudgetBytes: cap.bodyBytes,
      skipFilters: this.filters.list().length,
      lastError: this.lastError,
      guidance: this.buildGuidance(),
    };
    if ("sessionId" in this.state) {
      base.sessionId = this.state.sessionId;
      base.startedAt = this.state.startedAt;
      base.startedAtIso = new Date(this.state.startedAt).toISOString();
    }
    if (this.state.kind === "stopped") {
      base.stoppedAt = this.state.stoppedAt;
      base.stoppedAtIso = new Date(this.state.stoppedAt).toISOString();
      base.reason = this.state.reason;
    }
    return base;
  }

  private buildGuidance(): string {
    switch (this.state.kind) {
      case "idle":
        return [
          "No background capture is running. Before the user can analyze HTTP traffic, you must start one.",
          "",
          HOW_TO_GET_SESSION_ID,
          "",
          POST_START_WARNING,
        ].join("\n");

      case "connecting":
        return [
          "Capture is connecting to the session. This usually takes <1s.",
          "Call htk_capture_status again in a moment to confirm it is running.",
        ].join("\n");

      case "running": {
        const minutesRunning = ((Date.now() - this.state.startedAt) / 60000).toFixed(1);
        const buffered = this.buffer.size();
        const bodyMB = (this.buffer.bodyBytes() / (1024 * 1024)).toFixed(1);
        const budgetMB = (this.buffer.capacity().bodyBytes / (1024 * 1024)).toFixed(0);
        const lines = [
          `Background capture is running against session ${this.state.sessionId} (started ${minutesRunning} min ago). ${buffered} exchanges buffered, using ${bodyMB} of ${budgetMB} MB body budget.`,
          "",
          POST_START_WARNING,
          "",
          "To analyze traffic: tell the user to reproduce the activity now (tap in the Android app, refresh the browser, etc.), then call htk_list_exchanges with filters.",
          "",
          "If memory pressure becomes an issue, use htk_buffer_stats to identify heavy hosts and htk_add_skip_filter to stop capturing their bodies (the exchange records still show up, just with bodySkipped=true).",
        ];
        if (this.lastError) {
          lines.push("");
          lines.push(`Note: last error on the subscription: ${this.lastError}. If no new exchanges arrive, the session UUID may be stale — see below.`);
          lines.push("");
          lines.push(SESSION_ROTATES_WARNING);
        }
        return lines.join("\n");
      }

      case "stopped":
        return [
          `Capture stopped. Reason: ${this.state.reason}`,
          `The buffer still contains ${this.buffer.size()} exchanges and is readable via htk_list_exchanges / htk_get_exchange until the MCP process exits or htk_clear_capture is called.`,
          "",
          SESSION_ROTATES_WARNING,
          "",
          "To resume capturing, get a fresh session UUID and call htk_start_capture:",
          "",
          HOW_TO_GET_SESSION_ID,
        ].join("\n");
    }
  }
}
