import { DEFAULT_ADMIN_URL, DEFAULT_SERVER_URL } from "./constants.js";
import { detectHtkTokenOnWindows, type DetectResult } from "./win-token-detect.js";

export interface HtkConfig {
  serverUrl: string;
  adminUrl: string;
  authToken?: string;
  authTokenSource: "env" | "auto-detected" | "none";
  autoDetect?: DetectResult;
  sessionId?: string;
  logPath?: string;
  headers: Record<string, string>;
}

function assertSafeLocalUrl(url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http(s), got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const isLocal =
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost";
  if (!isLocal) {
    throw new Error(
      `${label} must point to a loopback address (127.0.0.1, ::1, or localhost). ` +
      `Refusing to connect to remote host: ${host}`,
    );
  }
  return url.replace(/\/$/, "");
}

export async function loadConfig(): Promise<HtkConfig> {
  const serverUrl = assertSafeLocalUrl(
    process.env.HTK_SERVER_URL ?? DEFAULT_SERVER_URL,
    "HTK_SERVER_URL",
  );
  const adminUrl = assertSafeLocalUrl(
    process.env.HTK_ADMIN_URL ?? DEFAULT_ADMIN_URL,
    "HTK_ADMIN_URL",
  );
  const envToken = process.env.HTK_SERVER_TOKEN?.trim() || undefined;
  const sessionId = process.env.HTK_SESSION_ID?.trim() || undefined;
  const logPath = process.env.HTK_LOG_PATH?.trim() || undefined;
  const autoDisabled = process.env.HTK_DISABLE_TOKEN_AUTODETECT === "1";

  let authToken = envToken;
  let authTokenSource: HtkConfig["authTokenSource"] = envToken ? "env" : "none";
  let autoDetect: DetectResult | undefined;

  if (!authToken && !autoDisabled) {
    autoDetect = await detectHtkTokenOnWindows();
    if (autoDetect.token) {
      authToken = autoDetect.token;
      authTokenSource = "auto-detected";
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: authToken ? "https://app.httptoolkit.tech" : "http://localhost",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  return {
    serverUrl,
    adminUrl,
    authToken,
    authTokenSource,
    autoDetect,
    sessionId,
    logPath,
    headers,
  };
}

export interface RefreshResult {
  /** True if the token value changed as a result of this refresh. */
  changed: boolean;
  /** Why we did or didn't refresh. */
  reason:
    | "env-configured"                 // HTK_SERVER_TOKEN set; refresh skipped
    | "autodetect-disabled"            // HTK_DISABLE_TOKEN_AUTODETECT=1
    | "autodetect-succeeded"           // found a new token
    | "autodetect-failed"              // no token found in scanned processes
    | "not-on-windows";                // PEB walk only runs on Windows
  previousSource: HtkConfig["authTokenSource"];
  newSource: HtkConfig["authTokenSource"];
  detect?: DetectResult;
}

/**
 * Re-run the Windows PEB-walk auto-detection and mutate `config` in place if
 * the token changed. Safe to call any time after loadConfig. No-op when
 * HTK_SERVER_TOKEN was set explicitly (that takes precedence) or auto-detect
 * is disabled. Use after an auth_rejected response to self-heal stale tokens
 * caused by HTTP Toolkit restarting in the background.
 */
export async function refreshAuthToken(config: HtkConfig): Promise<RefreshResult> {
  const previousSource = config.authTokenSource;
  const previousToken = config.authToken;

  if (previousSource === "env") {
    return { changed: false, reason: "env-configured", previousSource, newSource: previousSource };
  }
  if (process.env.HTK_DISABLE_TOKEN_AUTODETECT === "1") {
    return { changed: false, reason: "autodetect-disabled", previousSource, newSource: previousSource };
  }
  if (process.platform !== "win32") {
    return { changed: false, reason: "not-on-windows", previousSource, newSource: previousSource };
  }

  const detect = await detectHtkTokenOnWindows();
  config.autoDetect = detect;

  if (detect.token) {
    const changed = detect.token !== previousToken;
    config.authToken = detect.token;
    config.authTokenSource = "auto-detected";
    config.headers["Authorization"] = `Bearer ${detect.token}`;
    config.headers["Origin"] = "https://app.httptoolkit.tech";
    return {
      changed,
      reason: "autodetect-succeeded",
      previousSource,
      newSource: "auto-detected",
      detect,
    };
  }

  // No token this time — if we previously had one that's now invalid, clear it.
  if (previousToken) {
    config.authToken = undefined;
    config.authTokenSource = "none";
    delete config.headers["Authorization"];
    config.headers["Origin"] = "http://localhost";
    return {
      changed: true,
      reason: "autodetect-failed",
      previousSource,
      newSource: "none",
      detect,
    };
  }
  return {
    changed: false,
    reason: "autodetect-failed",
    previousSource,
    newSource: previousSource,
    detect,
  };
}
