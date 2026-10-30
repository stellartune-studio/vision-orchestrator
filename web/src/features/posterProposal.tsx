import { useEffect, useState } from "react";
import type { BlueprintVersionDetail, ProjectState } from "@vo/shared";
import { assetUrl } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";

type Layer = { kind: "still" | "motion"; x: number; y: number; width: number; height: number; loop_frames?: number };
type Layout = { width: number; height: number; fps: number; duration: number; layers: Layer[] };
type Plan = { revision_id: string; still_asset_id: string; motion_asset_id: string; layout_json: string };

export function PosterProposal(props: { state: ProjectState; onChanged: () => Promise<void>; onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [scriptId, setScriptId] = useState("");
  const [blueprint, setBlueprint] = useState<BlueprintVersionDetail | null>(null);
  const [stillId, setStillId] = useState(""); const [motionId, setMotionId] = useState("");
  const [layout, setLayout] = useState<Layout>({ width: 768, height: 1344, fps: 24, duration: 4, layers: [{ kind: "motion", x: 0, y: 0, width: 768, height: 1344, loop_frames: 24 }] });
  const [approved, setApproved] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false); const [previewId, setPreviewId] = useState(""); const [error, setError] = useState("");
  const scripts = props.state.documents.filter((doc) => doc.kind === "script" && doc.adopted_revision_id);
  const doc = scripts.find((item) => item.id === scriptId);
  const revision = doc?.revisions.find((item) => item.id === doc.adopted_revision_id);
  useEffect(() => {
    let active = true; setBlueprint(null); setApproved(null); setPreviewId(""); setError("");
    if (revision?.blueprint_version_id) void fetch(`/api/blueprint-versions/${encodeURIComponent(revision.blueprint_version_id)}`).then(async (response) => { if (!response.ok) throw new Error(`Blueprint error (${response.status})`); return response.json() as Promise<BlueprintVersionDetail>; }).then((data) => { if (active) setBlueprint(data); }).catch((cause) => { if (active) props.onError(cause); });
    if (revision?.id) void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/poster-plans/${encodeURIComponent(revision.id)}`).then(async (response) => {
      const data = await response.json();
      if (response.status === 409 && data.error === "Poster plan is not the project's adopted revision") return null;
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`); return data as Plan;
    }).then((plan) => { if (active && plan) { setApproved(plan); setStillId(plan.still_asset_id); setMotionId(plan.motion_asset_id); setLayout(JSON.parse(plan.layout_json) as Layout); } }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [revision?.id, revision?.blueprint_version_id, props.state.project.id]);
  const assets = props.state.assets.filter((asset) => asset.owner_kind === "project" && asset.owner_id === props.state.project.id && blueprint?.assets.some((entry) => entry.asset_id === asset.id));
  const changed = approved && (approved.still_asset_id !== stillId || approved.motion_asset_id !== motionId || approved.layout_json !== JSON.stringify(layout));
  const updateLayer = (index: number, update: Partial<Layer>) => setLayout((current) => ({ ...current, layers: current.layers.map((layer, i) => i === index ? { ...layer, ...update } : layer) }));
    return <section className="item">
    <p>{t("poster.chooseAFrozenPNGAndMatching")}</p>
    <label>{t("poster.baseScript")}<select value={scriptId} onChange={(event) => setScriptId(event.target.value)}><option value="">—</option>{scripts.map((item) => <option key={item.id} value={item.id}>{item.title || item.id.slice(0, 8)}</option>)}</select></label>
    {([ ["still", stillId, setStillId, "image/png"], ["motion", motionId, setMotionId, "video/mp4"] ] as const).map(([kind, selected, setSelected, mime]) => <label key={kind}>{kind === "still" ? t("poster.frozenStill") : t("poster.frozenMotion")}<select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">—</option>{assets.filter((asset) => asset.mime === mime).map((asset) => <option key={asset.id} value={asset.id}>{asset.id.slice(0, 8)}</option>)}</select></label>)}
    {(["width", "height", "fps", "duration"] as const).map((key) => <label key={key}>{key}<input type="number" min="1" step={key === "duration" ? "0.01" : "1"} value={Number.isFinite(layout[key]) ? layout[key] : ""} onChange={(event) => setLayout((old) => ({ ...old, [key]: event.target.value === "" ? NaN : Number(event.target.value) }))} /></label>)}
    {layout.layers.map((layer, index) => <fieldset key={index}><legend>{t("poster.layerN", { n: index + 1 })}</legend>
      <label>{t("poster.type")}<select value={layer.kind} onChange={(event) => { const kind = event.target.value as Layer["kind"]; setLayout((old) => ({ ...old, layers: old.layers.map((item, i) => i !== index ? item : kind === "still" ? { kind, x: item.x, y: item.y, width: item.width, height: item.height } : { ...item, kind, loop_frames: old.fps }) })); }}><option value="motion">{t("poster.motion")}</option><option value="still">{t("poster.still")}</option></select></label>
      {(["x", "y", "width", "height"] as const).map((key) => <label key={key}>{key}<input type="number" min="0" step="2" value={Number.isFinite(layer[key]) ? layer[key] : ""} onChange={(event) => updateLayer(index, { [key]: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>)}
      {layer.kind === "motion" && <label>{t("poster.loopFrames")}<input type="number" min="1" value={Number.isFinite(layer.loop_frames) ? layer.loop_frames : ""} onChange={(event) => updateLayer(index, { loop_frames: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>}
      <button type="button" disabled={index === 0} onClick={() => setLayout((old) => { const layers = [...old.layers]; [layers[index - 1], layers[index]] = [layers[index], layers[index - 1]]; return { ...old, layers }; })}>{t("poster.moveBack")}</button>
      <button type="button" disabled={index === layout.layers.length - 1} onClick={() => setLayout((old) => { const layers = [...old.layers]; [layers[index], layers[index + 1]] = [layers[index + 1], layers[index]]; return { ...old, layers }; })}>{t("poster.moveForward")}</button>
      <button type="button" disabled={layout.layers.length === 1} onClick={() => setLayout((old) => ({ ...old, layers: old.layers.filter((_, i) => i !== index) }))}>{t("poster.remove")}</button>
    </fieldset>)}
    <button type="button" disabled={layout.layers.length >= 8} onClick={() => setLayout((old) => ({ ...old, layers: [...old.layers, { kind: "motion", x: 0, y: 0, width: old.width, height: old.height, loop_frames: old.fps }] }))}>{t("poster.addLayer")}</button>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || !doc || !revision || !stillId || !motionId} onClick={() => { if (!doc || !revision) return; setBusy(true); setError(""); void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/poster-proposals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document_id: doc.id, base_revision_id: revision.id, expected_version: doc.state_version, still_asset_id: stillId, motion_asset_id: motionId, layout }) }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`); await props.onChanged(); }).catch((cause) => setError(String(cause))).finally(() => setBusy(false)); }}>{t("poster.saveUnapprovedPosterProposal")}</button>
    {approved && <section><p>{changed ? t("poster.saveAndAdoptChangesBeforeRendering") : t("poster.renderingUsesTheAdoptedAssetsAnd")}</p>
      {([false, true] as const).map((exportFile) => <button key={String(exportFile)} disabled={busy || !!changed} onClick={() => { setBusy(true); setError(""); void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/poster-${exportFile ? "exports" : "previews"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: approved.revision_id }) }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`); if (!exportFile) setPreviewId(data.id); await props.onChanged(); }).catch((cause) => setError(String(cause))).finally(() => setBusy(false)); }}>{exportFile ? t("poster.exportAndSave") : t("poster.preview")}</button>)}
      {previewId && <video controls playsInline src={assetUrl(previewId)} />}</section>}
    {props.state.assets.filter((asset) => asset.kind === "poster-export").map((asset) => <section key={asset.id}><p>{t("poster.savedPoster")} · {asset.created_at}</p><video controls playsInline src={assetUrl(asset.id)} /><a href={assetUrl(asset.id)} download>{t("poster.download")}</a></section>)}
  </section>;
}
