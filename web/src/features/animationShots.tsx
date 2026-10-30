import { useEffect, useRef, useState } from "react";
import type { ProjectState } from "@vo/shared";
import { assetUrl } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import { storyScenes } from "./storyScenes.ts";
import { environmentRequest } from "../api/environment.ts";

type Recovery = { status: string; process: "active" | "ended" | "unknown"; artifact: string; asset_id?: string; safe_to_retry: boolean };

type CompositeJob = { id: string; shot_id: string; status: "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "unconfirmed"; asset_id: string | null; error: string | null };

export function AnimationShots(props: { state: ProjectState; onChanged: () => Promise<void>; onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [sceneId, setSceneId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [expression, setExpression] = useState("");
  const [movement, setMovement] = useState("");
  const [background, setBackground] = useState("");
  const [backgroundAsset, setBackgroundAsset] = useState("");
  const [foregroundAsset, setForegroundAsset] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState("");
  const [jobs, setJobs] = useState<CompositeJob[]>([]);
  const [recovery, setRecovery] = useState<Record<string, Recovery>>({});
  const refreshed = useRef(new Set<string>());
  const jobsPath = `/api/projects/${encodeURIComponent(props.state.project.id)}/animation-composite-jobs`;
  useEffect(() => {
    let active = true;
    const refresh = () => void environmentRequest<CompositeJob[]>(jobsPath).then((value) => { if (active) setJobs(value); }).catch(props.onError);
    refresh(); const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [jobsPath]);
  useEffect(() => {
    const missing = jobs.filter((job) => job.status === "succeeded" && job.asset_id && !refreshed.current.has(job.id) && !props.state.assets.some((asset) => asset.id === job.asset_id));
    if (missing.length) { for (const job of missing) refreshed.current.add(job.id); void props.onChanged().catch(props.onError); }
  }, [jobs, props.state.assets]);
  const pin = props.state.characters.find((item) => item.character_id === characterId);
  const scenes = storyScenes(props.state.items).filter((scene) => scene.adopted_revision_id);
  return <section className="item">
    <p>{t("animationShots.addPerformanceAndBackgroundDirectionTo")}</p>
    <label>{t("animationShots.scene")}<select value={sceneId} onChange={(event) => setSceneId(event.target.value)}><option value="">—</option>{scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.label}</option>)}</select></label>
    <label>{t("animationShots.character")}<select value={characterId} onChange={(event) => setCharacterId(event.target.value)}><option value="">—</option>{props.state.characters.map((item) => <option key={item.character_id} value={item.character_id}>{props.state.character_views.find((character) => character.id === item.character_id)?.name ?? item.character_id}</option>)}</select></label>
    <label>{t("animationShots.expression")}<input value={expression} onChange={(event) => setExpression(event.target.value)} /></label>
    <label>{t("animationShots.movement")}<textarea value={movement} onChange={(event) => setMovement(event.target.value)} /></label>
    <label>{t("animationShots.backgroundDirection")}<textarea value={background} onChange={(event) => setBackground(event.target.value)} /></label>
    <p>{t("animationShots.optionalPreprocessingOverlaySelectedPNGsWith")}</p>
    {[[backgroundAsset, setBackgroundAsset, t("animationShots.backgroundImage")], [foregroundAsset, setForegroundAsset, t("animationShots.transparentForegroundImage")]].map(([value, setter, label]) => <label key={label as string}>{label as string}<select value={value as string} onChange={(event) => (setter as (value: string) => void)(event.target.value)}><option value="">—</option>{props.state.assets.filter((asset) => asset.selected && asset.mime === "image/png" && asset.sha256).map((asset) => <option key={asset.id} value={asset.id}>{asset.id.slice(0, 8)} — {asset.kind}</option>)}</select></label>)}
    <button disabled={busy || !sceneId || !pin || !expression.trim() || !movement.trim() || !background.trim()} onClick={() => {
      if (!pin || busy) return;
      setBusy(true);
      void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/animation-shots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene_id: sceneId, character_id: pin.character_id, character_revision_id: pin.character_revision_id, pin_version: pin.pin_version, expression, movement, background, ...(backgroundAsset || foregroundAsset ? { background_asset_id: backgroundAsset, foreground_asset_id: foregroundAsset } : {}) }) }).then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`); await props.onChanged(); }).catch(props.onError).finally(() => setBusy(false));
    }}>{t("animationShots.addUnapprovedShot")}</button>
    <p>{t("animationShots.adoptTheShotAndFreezeA")}</p>
    {props.state.items.filter((item) => item.kind === "shot" && item.adopted_revision_id).map((shot) => <div key={shot.id}><span>{shot.label}</span><button disabled={!!composing || !props.state.blueprint_versions.length || jobs.some((job) => job.shot_id === shot.id && ["running", "cancelling", "unconfirmed"].includes(job.status))} onClick={() => {
      const blueprint = props.state.blueprint_versions.at(-1); if (!blueprint) return;
      setComposing(shot.id);
      void environmentRequest<CompositeJob>(`/api/projects/${encodeURIComponent(props.state.project.id)}/animation-shots/${encodeURIComponent(shot.id)}/background-composite-jobs`, { blueprint_version_id: blueprint.id }).then((job) => setJobs((old) => [job, ...old])).catch(props.onError).finally(() => setComposing(""));
    }}>{t("animationShots.compositeApprovedImages")}</button>
    {jobs.filter((job) => job.shot_id === shot.id).map((job) => <div key={job.id} role="status">{({ running: t("animationShots.status.running"), cancelling: t("animationShots.status.cancelling"), cancelled: t("animationShots.status.cancelled"), succeeded: t("animationShots.status.succeeded"), failed: t("animationShots.status.failed"), unconfirmed: t("animationShots.status.unconfirmed") } as Record<string, string>)[job.status] ?? job.status}{job.error ? `: ${job.error}` : ""}{job.status === "running" && <button onClick={() => void environmentRequest<CompositeJob>(`${jobsPath}/${encodeURIComponent(job.id)}/cancel`, {}).then((updated) => setJobs((old) => old.map((entry) => entry.id === updated.id ? updated : entry))).catch(props.onError)}>{t("animationShots.cancelComposition")}</button>}{job.status === "unconfirmed" && <button onClick={() => void environmentRequest<Recovery>(`${jobsPath}/${encodeURIComponent(job.id)}/reconcile`, {}).then(async (result) => { setRecovery((old) => ({ ...old, [job.id]: result })); setJobs(await environmentRequest<CompositeJob[]>(jobsPath)); if (result.status === "succeeded") await props.onChanged(); }).catch(props.onError)}>{t("animationShots.checkProcessAndArtifact")}</button>}{recovery[job.id] && <p>{t("animationShots.artifactCheck")}: {recovery[job.id].artifact}{recovery[job.id].asset_id ? ` (${recovery[job.id].asset_id})` : ""} · {recovery[job.id].safe_to_retry ? (t("animationShots.processesEndedRetryIsAvailable")) : recovery[job.id].status === "succeeded" ? (t("animationShots.processAndArtifactVerified")) : (t("animationShots.processRetryHeld", { process: recovery[job.id].process }))}</p>}</div>)}</div>)}
    {props.state.assets.filter((asset) => asset.kind === "animation-composite").map((asset) => <div key={asset.id}><img src={assetUrl(asset.id)} alt={t("animationShots.backgroundComposite")} /><small>{asset.id}</small></div>)}
  </section>;
}
