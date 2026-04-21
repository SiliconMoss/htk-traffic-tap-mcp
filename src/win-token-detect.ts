/**
 * Windows-only: auto-detect HTK_SERVER_TOKEN by reading the environment block
 * of the running `httptoolkit-server` subprocess.
 *
 * The HTTP Toolkit desktop app generates a fresh token each launch and passes
 * it to its server subprocess via the HTK_SERVER_TOKEN env var. There is no
 * on-disk persistence (verified in httptoolkit-desktop source). The only way
 * to automate token retrieval is to read the target process's PEB.
 *
 * Layout (x64, stable since Win7):
 *   PEB + 0x20                               -> ProcessParameters pointer
 *   RTL_USER_PROCESS_PARAMETERS + 0x80       -> Environment pointer
 *   RTL_USER_PROCESS_PARAMETERS + 0x3F0      -> EnvironmentSize (ULONG_PTR)
 *
 * Env block is UTF-16LE, entries null-terminated, block terminated by
 * double-null.
 *
 * No admin required — target runs as the same user at the same integrity level.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_VM_READ = 0x0010;

const PEB_PROCESS_PARAMETERS_OFFSET_X64 = 0x20;
const RTL_ENVIRONMENT_OFFSET_X64 = 0x80;
const RTL_ENVIRONMENT_SIZE_OFFSET_X64 = 0x3f0;

const MAX_ENV_BYTES = 1 << 20; // 1 MiB sanity cap

async function findCandidatePids(): Promise<number[]> {
  // Safe: execFile with argv array does not invoke a shell.
  const script =
    "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%httptoolkit-server%'\" | Select-Object -ExpandProperty ProcessId";
  try {
    const { stdout } = await execFileP(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 5000, windowsHide: true },
    );
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l))
      .map((l) => parseInt(l, 10));
  } catch {
    return [];
  }
}

interface Win32Bindings {
  openProcess: (pid: number) => bigint;
  closeHandle: (handle: bigint) => void;
  readMemory: (handle: bigint, address: bigint, size: number) => Buffer | null;
  queryPebAddress: (handle: bigint) => bigint | null;
}

type KoffiModule = typeof import("koffi");

function loadBindings(koffi: KoffiModule): Win32Bindings {
  const kernel32 = koffi.load("kernel32.dll");
  const ntdll = koffi.load("ntdll.dll");

  // Treat HANDLE and addresses as int64_t — koffi represents void* returns as
  // opaque objects that don't compare well, while int64_t round-trips as BigInt.
  const OpenProcess = kernel32.func(
    "int64_t __stdcall OpenProcess(uint32_t, int32_t, uint32_t)",
  );
  const CloseHandle = kernel32.func("int32_t __stdcall CloseHandle(int64_t)");
  const ReadProcessMemory = kernel32.func(
    "int32_t __stdcall ReadProcessMemory(int64_t, int64_t, _Out_ void *, size_t, _Out_ size_t *)",
  );
  const NtQueryInformationProcess = ntdll.func(
    "int32_t __stdcall NtQueryInformationProcess(int64_t, int32_t, _Out_ void *, uint32_t, _Out_ uint32_t *)",
  );

  return {
    openProcess(pid: number): bigint {
      const h = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
        0,
        pid,
      );
      return BigInt(h as number | bigint);
    },
    closeHandle(handle: bigint): void {
      if (handle !== 0n) CloseHandle(handle);
    },
    readMemory(handle: bigint, address: bigint, size: number): Buffer | null {
      if (size <= 0 || size > MAX_ENV_BYTES) return null;
      const buf = Buffer.alloc(size);
      const bytesRead: [bigint] = [0n];
      const ok = ReadProcessMemory(handle, address, buf, size, bytesRead);
      if (!ok) return null;
      const read = Number(bytesRead[0]);
      return read === size ? buf : buf.subarray(0, read);
    },
    queryPebAddress(handle: bigint): bigint | null {
      // PROCESS_BASIC_INFORMATION (x64, 48 bytes):
      //   Reserved1(8) PebBaseAddress(8) Reserved2[2](16) UniqueProcessId(8) Reserved3(8)
      const pbi = Buffer.alloc(48);
      const retLen: [number] = [0];
      const status = NtQueryInformationProcess(handle, 0, pbi, pbi.length, retLen);
      if (status !== 0) return null;
      const peb = pbi.readBigUInt64LE(8);
      return peb === 0n ? null : peb;
    },
  };
}

function parseEnvBlock(buf: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  // UTF-16LE, null-separated entries, ends at double-null.
  // Iterate in 2-byte code units.
  let start = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const codeUnit = buf.readUInt16LE(i);
    if (codeUnit === 0) {
      if (i === start) break; // double-null => end of block
      const entry = buf.subarray(start, i).toString("utf16le");
      const eq = entry.indexOf("=");
      if (eq > 0) result.set(entry.slice(0, eq), entry.slice(eq + 1));
      start = i + 2;
    }
  }
  return result;
}

interface PidReadResult {
  token?: string;
  stage: string;
  detail?: string;
}

async function readTokenFromPid(
  bindings: Win32Bindings,
  pid: number,
): Promise<PidReadResult> {
  const handle = bindings.openProcess(pid);
  if (handle === 0n) return { stage: "OpenProcess failed" };
  try {
    const pebAddr = bindings.queryPebAddress(handle);
    if (!pebAddr) return { stage: "NtQueryInformationProcess failed" };

    const paramsPtrBuf = bindings.readMemory(
      handle,
      pebAddr + BigInt(PEB_PROCESS_PARAMETERS_OFFSET_X64),
      8,
    );
    if (!paramsPtrBuf || paramsPtrBuf.length < 8) {
      return { stage: "read PEB.ProcessParameters failed", detail: `peb=0x${pebAddr.toString(16)}` };
    }
    const paramsAddr = paramsPtrBuf.readBigUInt64LE(0);
    if (paramsAddr === 0n) return { stage: "ProcessParameters null" };

    const envPtrBuf = bindings.readMemory(
      handle,
      paramsAddr + BigInt(RTL_ENVIRONMENT_OFFSET_X64),
      8,
    );
    const envSizeBuf = bindings.readMemory(
      handle,
      paramsAddr + BigInt(RTL_ENVIRONMENT_SIZE_OFFSET_X64),
      8,
    );
    if (!envPtrBuf || !envSizeBuf) return { stage: "read Environment ptr/size failed" };
    const envAddr = envPtrBuf.readBigUInt64LE(0);
    const envSize = Number(envSizeBuf.readBigUInt64LE(0));
    if (envAddr === 0n) return { stage: "Environment pointer null" };
    if (envSize <= 0 || envSize > MAX_ENV_BYTES) {
      return { stage: "Environment size implausible", detail: `size=${envSize}` };
    }

    const envBlock = bindings.readMemory(handle, envAddr, envSize);
    if (!envBlock) return { stage: "ReadProcessMemory on env block failed" };

    const env = parseEnvBlock(envBlock);
    const token = env.get("HTK_SERVER_TOKEN");
    if (token) return { token, stage: "ok" };
    return {
      stage: "token not present in env",
      detail: `${env.size} vars, e.g. ${[...env.keys()].slice(0, 5).join(",")}`,
    };
  } finally {
    bindings.closeHandle(handle);
  }
}

export interface DetectResult {
  token?: string;
  pid?: number;
  attemptedPids: number[];
  reason?: string;
  diagnostics?: Array<{ pid: number; stage: string; detail?: string }>;
}

export async function detectHtkTokenOnWindows(): Promise<DetectResult> {
  if (platform() !== "win32") {
    return { attemptedPids: [], reason: "not on Windows" };
  }

  let koffi: KoffiModule;
  try {
    const requireFromHere = createRequire(import.meta.url);
    koffi = requireFromHere("koffi") as KoffiModule;
  } catch (err) {
    return {
      attemptedPids: [],
      reason: `koffi not available: ${(err as Error).message}`,
    };
  }

  const pids = await findCandidatePids();
  if (pids.length === 0) {
    return {
      attemptedPids: [],
      reason: "no httptoolkit-server process found (is HTTP Toolkit running?)",
    };
  }

  let bindings: Win32Bindings;
  try {
    bindings = loadBindings(koffi);
  } catch (err) {
    return {
      attemptedPids: pids,
      reason: `failed to load Win32 bindings: ${(err as Error).message}`,
    };
  }

  const diagnostics: Array<{ pid: number; stage: string; detail?: string }> = [];
  for (const pid of pids) {
    try {
      const r = await readTokenFromPid(bindings, pid);
      diagnostics.push({ pid, stage: r.stage, detail: r.detail });
      if (r.token) return { token: r.token, pid, attemptedPids: pids, diagnostics };
    } catch (err) {
      diagnostics.push({ pid, stage: "exception", detail: (err as Error).message });
    }
  }
  return {
    attemptedPids: pids,
    reason: "could not read HTK_SERVER_TOKEN from any candidate process",
    diagnostics,
  };
}
