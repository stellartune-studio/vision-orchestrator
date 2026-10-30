import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

export interface ProcessIdentity { pid: number; parent: number; started: string; commandHash: string; executableHash: string }
export interface ProcessSnapshot { machine: string; boot: string; processes: ProcessIdentity[] }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validProcess = (p: ProcessIdentity) => Number.isSafeInteger(p?.pid) && p.pid > 0 && Number.isSafeInteger(p.parent) && p.parent >= 0 && typeof p.started === "string" && Number.isFinite(Date.parse(p.started)) && validHash(p.commandHash) && validHash(p.executableHash);

/** Unknown is mandatory when OS facts are inaccessible, incomplete or from another boot. */
export function assessProcesses(original: ProcessSnapshot | null, current: ProcessSnapshot | null): "active" | "ended" | "unknown" {
  if (!original || !current || !validHash(original.machine) || original.machine !== current.machine ||
      typeof original.boot !== "string" || !original.boot || original.boot !== current.boot ||
      !Array.isArray(original.processes) || original.processes.length !== 2 || !original.processes.every(validProcess) ||
      original.processes[0].pid === original.processes[1].pid ||
      !Array.isArray(current.processes) || !current.processes.every(validProcess) ||
      new Set(current.processes.map((p) => p.pid)).size !== current.processes.length) return "unknown";
  let uncertain = false;
  for (const old of original.processes) {
    const now = current.processes.find((p) => p.pid === old.pid);
    if (!now || now.started !== old.started) continue;
    if (old.parent === now.parent && old.commandHash === now.commandHash && old.executableHash === now.executableHash) return "active";
    uncertain = true;
  }
  return uncertain ? "unknown" : "ended";
}

/** Read only: no process is stopped and raw command lines never leave this function. */
export async function observeProcesses(pids: number[]): Promise<ProcessSnapshot | null> {
  if (process.platform !== "win32" || !pids.length || pids.some((p) => !Number.isSafeInteger(p) || p <= 0)) return null;
  const filter = [...new Set(pids)].map((p) => `ProcessId = ${p}`).join(" OR ");
  const script = `$ErrorActionPreference='Stop'; $machine=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid; $boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); $items=@(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { @{ pid=$_.ProcessId; parent=$_.ParentProcessId; started=$_.CreationDate.ToUniversalTime().ToString('o'); command=$_.CommandLine; executable=$_.ExecutablePath } }); @{ machine=$machine; boot=$boot; processes=$items } | ConvertTo-Json -Compress -Depth 4`;
  try {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 });
    const value = JSON.parse(stdout) as { machine?: unknown; boot?: unknown; processes?: unknown };
    if (typeof value.machine !== "string" || !value.machine || typeof value.boot !== "string" || !value.boot || !Array.isArray(value.processes)) return null;
    const processes: ProcessIdentity[] = [];
    for (const raw of value.processes) {
      const p = raw as Record<string, unknown>;
      if (typeof p.command !== "string" || !p.command || typeof p.executable !== "string" || !p.executable || typeof p.started !== "string") return null;
      const item = { pid: p.pid as number, parent: p.parent as number, started: p.started, commandHash: digest(p.command), executableHash: digest(p.executable) };
      if (!validProcess(item) || !pids.includes(item.pid)) return null;
      processes.push(item);
    }
    return { machine: digest(value.machine), boot: value.boot, processes };
  } catch { return null; }
}
