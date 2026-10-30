import { useEffect, useState } from "react";
import type { EnvironmentPlan, SetupRun } from "@vo/shared";
import { useI18n } from "../i18n.tsx";
import { environmentRequest, type Catalog } from "../api/environment.ts";

export function EnvironmentWizard(props: { catalog: Catalog | null; onCatalog: (catalog: Catalog) => void }) {
  const { t } = useI18n();
  const catalog = props.catalog;
  const setCatalog = props.onCatalog;
  const [install, setInstall] = useState<SetupRun | null>(null);
  const [downloads, setDownloads] = useState(false);
  useEffect(() => {
    if (install?.status !== "running") return;
    const timer = setInterval(() => { void environmentRequest<SetupRun>("/api/environment/install-state").then(setInstall).catch((e) => setError(String(e))); }, 1000);
    return () => clearInterval(timer);
  }, [install?.status]);
  const installReal = async () => {
    if (!plan) return;
    setError("");
    try { setInstall(await environmentRequest<SetupRun>("/api/environment/install", { confirm_install: true, allow_downloads: downloads, expected_plan_token: plan.plan_token })); }
    catch (e) { setError(String(e)); }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actualRun, setActualRun] = useState<SetupRun | null>(null);
  const [plan, setPlan] = useState<EnvironmentPlan | null>(null);
  const [run, setRun] = useState<SetupRun | null>(null);
  const [mode, setMode] = useState<"managed" | "existing">("managed");
  const fixture = async (fail = false) => {
    setBusy(true);
    try { setRun(await environmentRequest<SetupRun>("/api/environment/setup-fixture", { mode, completed_steps: run?.completed_steps ?? [], fail_at: fail ? "venv" : undefined })); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const executeReal = async () => {
    if (!plan || busy) return;
    setBusy(true); setError(""); setActualRun(null);
    try {
      const result = await environmentRequest<SetupRun>("/api/environment/execute", { mode, expected_revision: plan.revision, expected_lock_sha256: plan.dependency_lock_sha256, expected_plan_token: plan.plan_token });
      setActualRun(result);
      setCatalog(await environmentRequest<Catalog>("/api/environment/catalog"));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <>
    {error && <p role="alert">{error}</p>}
    <details open={!catalog?.connected}>
      <summary>{t("envWizard.environmentWizard")}</summary>
      <label><input type="radio" checked={mode === "existing"} onChange={() => { setMode("existing"); setPlan(null); setRun(null); }} />{t("envWizard.connectExistingEnvironment")}</label>
      <label><input type="radio" checked={mode === "managed"} onChange={() => { setMode("managed"); setPlan(null); setRun(null); }} />{t("envWizard.setUpVOEnvironment")}</label>
      <p className="muted small">{catalog?.url} — {catalog?.connected ? t("envWizard.nodeCatalogConnectedGenerationUnverified") : t("envWizard.disconnected")}</p>
      <button type="button" onClick={() => void environmentRequest<Catalog>("/api/environment/catalog").then(setCatalog).catch((e) => setError(String(e)))}>{t("envWizard.reloadConnectionModels")}</button>
      <button type="button" onClick={() => void environmentRequest<EnvironmentPlan>("/api/environment/plan", { mode }).then(setPlan).catch((e) => setError(String(e)))}>{t("envWizard.reviewSetupPlan")}</button>
      <button type="button" onClick={() => void environmentRequest<SetupRun | null>("/api/environment/setup-state").then(setActualRun).catch((e) => setError(String(e)))}>{t("envWizard.readRealSetupProgress")}</button>
      {actualRun && <p role="status">{t("envWizard.realSetup")}: {actualRun.status} ({actualRun.completed_steps.join(", ")}) {actualRun.error}</p>}
      {actualRun?.connection_applied !== undefined && <p role="status">{actualRun.connection_applied ? t("envWizard.realEnvironmentVerifiedAndConnectedNo") : t("envWizard.realEnvironmentVerifiedGenerationBackendRemains")}</p>}
      {plan && <div><dl><dt>{t("envWizard.destination")}</dt><dd>{plan.root}</dd><dt>{t("envWizard.sharedModelReference")}</dt><dd>{plan.shared_models}</dd><dt>{t("envWizard.estimatedSpaceExcludingWeights")}</dt><dd>{plan.required_bytes / 1024 ** 3} GiB</dd><dt>{t("envWizard.dependenciesNodes")}</dt><dd>{plan.dependencies.join(", ")}</dd></dl>
        <p>{t("envWizard.freeDiskSpace")}: {plan.available_bytes == null ? t("envWizard.unavailable") : `${Math.floor(plan.available_bytes / 1024 ** 3)} GiB`}</p>
        <ol>{plan.steps.map((s) => <li key={s.id}>{({ source: t("envWizard.step.source"), venv: t("envWizard.step.venv"), models: t("envWizard.step.models"), workflows: t("envWizard.step.workflows"), connect: t("envWizard.step.connect") } as Record<string, string>)[s.id] ?? s.description}{run?.completed_steps.includes(s.id) ? " ✓ MOCK" : ""}</li>)}</ol>
        <p>{t("envWizard.detectVerifyPinnedDependenciesAndConnect")}</p>
        <button disabled={busy || (mode === "managed" && !plan.installed)} onClick={() => void executeReal()}>{t("envWizard.verifyInstalledEnvironmentConnect")}</button>
        <p className="muted small">{t("envWizard.automaticInstallationUsesPinnedUpstreamAnd")}</p>
        {mode === "managed" && <div>
          <label><input type="checkbox" checked={downloads} onChange={(e) => setDownloads(e.target.checked)} />{t("envWizard.allowUpstreamSourceAndLockedDependency")}</label>
          <button disabled={busy || install?.status === "running"} onClick={() => void installReal()}>{t("envWizard.installResumeManagedEnvironmentConnect")}</button>
          <button onClick={() => void environmentRequest<SetupRun | null>("/api/environment/install-state").then(setInstall).catch((e) => setError(String(e)))}>{t("envWizard.reloadInstallerState")}</button>
          {install && <p role="status">{t("envWizard.realInstaller")}: {install.status} — {install.current_step} — {t("envWizard.attempt")} {install.attempts} ({install.completed_steps.join(", ")}) {install.error}</p>}
          {install?.connection_applied !== undefined && <p>{install.connection_applied ? t("envWizard.appliedToGenerationConnectionThisRun") : t("envWizard.generationBackendUnchanged")}</p>}
        </div>}
        <button disabled={busy} onClick={() => void fixture(true)}>{t("envWizard.testMOCKFailure")}</button>
        <button disabled={busy} onClick={() => void fixture()}>{t("envWizard.verifyResumeMOCK")}</button>
        {run && <p role="status">MOCK: {run.status} {run.error} — {t("envWizard.realEnvironmentSetupIsNotCompleted")}</p>}
      </div>}
    </details>
  </>;
}
