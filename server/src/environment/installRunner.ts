import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EnvironmentPlan, SetupRun } from "@vo/shared";
import { ConflictError } from "../repos/errors.ts";
import { environmentPlanToken } from "./setupService.ts";

export interface InstallJournal extends SetupRun {
  plan_token: string;
  current_step?: string;
  executor_pid?: number;
  child_pid?: number;
  attempts: number;
}
export interface InstallStep {
  id: string;
  ready(): Promise<boolean>;
  apply(recordChild: (pid: number | undefined) => void): Promise<void>;
}
export function readInstallJournal(file: string): InstallJournal | null {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const activeFiles = new Set<string>();
export function assertInstallCanResume(file: string, plan: EnvironmentPlan): void {
  const old = readInstallJournal(file);
  if (old && old.plan_token !== environmentPlanToken(plan)) throw new ConflictError("Installation plan changed; preserve the journal and review a new plan");
  if (activeFiles.has(file) || (old?.status === "running" && ((old.executor_pid !== process.pid && alive(old.executor_pid)) || alive(old.child_pid)))) throw new ConflictError("A previous installer command is still running; wait before resuming");
}
export function installStatus(file: string, activeInThisProcess = false): InstallJournal | null {
  const state = readInstallJournal(file);
  if (state?.status === "running" && !activeInThisProcess && !alive(state.child_pid) && (state.executor_pid === process.pid || !alive(state.executor_pid))) return { ...state, status: "interrupted", error: "Installer worker stopped; inspect the last step and resume" };
  return state;
}

/** The same persisted, probe-before-apply engine drives real installation and bounded fixtures. */
export async function runInstallSteps(args: {
  plan: EnvironmentPlan; file: string; steps: InstallStep[]; fixture?: boolean;
  assertAllowed?: () => void; startServices?: boolean;
}): Promise<InstallJournal> {
  const token = environmentPlanToken(args.plan);
  const old = readInstallJournal(args.file);
  assertInstallCanResume(args.file, args.plan);
  activeFiles.add(args.file);
  const state: InstallJournal = {
    plan: args.plan, plan_token: token, mock: args.fixture === true, status: "running",
    completed_steps: [], executor_pid: process.pid, attempts: (old?.attempts ?? 0) + 1,
    evidence: { execution: args.fixture ? "bounded_filesystem_fixture" : "managed_install_or_resume", checked_steps: [], applied_steps: [], previous_status: old?.status, previous_error: old?.error },
  };
  const checked: string[] = [], applied: string[] = [];
  const save = () => {
    mkdirSync(dirname(args.file), { recursive: true });
    const temp = `${args.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2)); renameSync(temp, args.file);
  };
  try {
    save();
    for (const step of args.steps) {
      args.assertAllowed?.(); state.current_step = step.id; save();
      checked.push(step.id);
      if (!(await step.ready())) {
        await step.apply((pid) => { state.child_pid = pid; save(); });
        state.child_pid = undefined;
        if (!(await step.ready())) throw new Error(`Installation step did not verify: ${step.id}`);
        applied.push(step.id);
      }
      state.completed_steps.push(step.id);
      state.evidence = { ...state.evidence, checked_steps: [...checked], applied_steps: [...applied] }; save();
    }
    state.status = args.fixture ? "mock_completed" : args.startServices ? "connected_not_generation_verified" : "installed_not_connected";
    state.current_step = undefined; state.child_pid = undefined; state.executor_pid = undefined; save();
  } catch (error) {
    state.status = "failed"; state.error = error instanceof Error ? error.message : String(error);
    state.child_pid = undefined; state.executor_pid = undefined; save(); throw error;
  } finally { activeFiles.delete(args.file); }
  return state;
}
