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
