import { spawn, type ChildProcess } from "node:child_process";

/** Wait for the specific spawned child to close, including after cancellation. */
export function runOwnedProcess(command: string, args: string[], options: { cwd: string; signal: AbortSignal; timeoutMs: number; onStart?: (child: ChildProcess) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { reject(new Error("cancelled")); return; }
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: "ignore" });
    let failure: Error | undefined;
    let timedOut = false;
    const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
    const onAbort = () => stop();
    const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => { failure = error; });
    child.once("close", (code) => {
      clearTimeout(timeout); options.signal.removeEventListener("abort", onAbort);
      if (options.signal.aborted) reject(new Error("cancelled"));
      else if (timedOut) reject(new Error("timed out"));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`process exited with ${code}`));
      else resolve();
    });
    options.onStart?.(child);
    if (options.signal.aborted) stop();
  });
}
