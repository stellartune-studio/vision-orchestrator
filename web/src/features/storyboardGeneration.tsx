import { useEffect, useState } from "react";
import type { ProjectState, QwenReferenceSize, SavedWorkflowSelection, ServerMeta } from "@vo/shared";
import { api, assetUrl } from "../api/client.ts";
import { environmentRequest } from "../api/environment.ts";
import { useI18n } from "../i18n.tsx";
import { storyScenes } from "./storyScenes.ts";
import { storyboardUsesSingleEdit } from "./storyboardProfile.ts";

export function StoryboardGeneration(props: { state: ProjectState; onChanged: () => Promise<void>; onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const latest = props.state.blueprint_versions.at(-1);
  const docs = props.state.documents.filter((doc) => doc.adopted_revision_id && doc.revisions.some((revision) => revision.id === doc.adopted_revision_id && revision.blueprint_version_id === latest?.id));
  const [documentId, setDocumentId] = useState("");
  const doc = docs.find((entry) => entry.id === documentId);
  const [sizes, setSizes] = useState<Record<string, QwenReferenceSize>>({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const [meta, setMeta] = useState<ServerMeta | null>(null);
  const [workflow, setWorkflow] = useState<SavedWorkflowSelection | null>(null);
  const [sources, setSources] = useState<Record<string, { asset_id: string; revision_id: string } | null>>({});
  useEffect(() => { setSizes({}); setConfirmed({}); }, [props.state.project.id, latest?.id]);
  const scenes = storyScenes(props.state.items);
  const sceneKey = scenes.map((scene) => `${scene.id}:${scene.adopted_revision_id}`).join(",");
  useEffect(() => {
    let active = true;
    setWorkflow(null);
    setSources({});
    void api.meta().then((value) => { if (active) setMeta(value); }).catch(props.onError);
    void environmentRequest<SavedWorkflowSelection>(`/api/projects/${encodeURIComponent(props.state.project.id)}/generation-selection`).then((value) => { if (active) setWorkflow(value); }).catch(props.onError);
    void Promise.all(scenes.map(async (scene) => {
      const value = await environmentRequest<{ adopted: { asset_id: string; revision_id: string } | null }>(`/api/projects/${encodeURIComponent(props.state.project.id)}/story-scenes/${encodeURIComponent(scene.id)}/edit-sources`);
      return [scene.id, value.adopted] as const;
    })).then((entries) => { if (active) setSources(Object.fromEntries(entries)); }).catch(props.onError);
    return () => { active = false; };
  }, [props.state.project.id, sceneKey]);
  const qwenEdit = storyboardUsesSingleEdit(meta, workflow);
  const records = props.state.generations.filter((record) => {
    try { return !!JSON.parse(record.inputs).resolved_refs?.story_scene_id; } catch { return false; }
  });
  const running = records.filter((record) => record.status === "running" || record.status === "queued");
  useEffect(() => {
    if (!running.length) return;
    const timer = setInterval(() => void props.onChanged().catch(props.onError), 3000);
    return () => clearInterval(timer);
  }, [running.map((record) => record.id).join(",")]);
  const request = async (sceneId: string, preflight: boolean) => {
    if (!latest || busy || (!preflight && !doc?.adopted_revision_id)) return;
    setBusy(sceneId);
    try {
      if (preflight) {
        const size = await environmentRequest<QwenReferenceSize>(`/api/projects/${encodeURIComponent(props.state.project.id)}/qwen-reference-size`, { blueprint_version_id: latest.id, story_scene_id: sceneId }, "POST");
        setSizes((old) => ({ ...old, [sceneId]: size }));
        setConfirmed((old) => ({ ...old, [sceneId]: false }));
      } else {
        const selection = await environmentRequest<SavedWorkflowSelection>(`/api/projects/${encodeURIComponent(props.state.project.id)}/generation-selection`);
        if (selection.version !== workflow?.version) { setWorkflow(selection); setSizes({}); setConfirmed({}); throw new Error(t("storyboardGen.generationSettingsChangedReviewTheScene")); }
        await environmentRequest(`/api/projects/${encodeURIComponent(props.state.project.id)}/generations`, { blueprint_version_id: latest.id, kind: "image", document_revision_id: doc!.adopted_revision_id, story_scene_id: sceneId, selection_version: selection.version, ...(qwenEdit ? { edit_source_asset_id: sources[sceneId]?.asset_id } : {}), ...(confirmed[sceneId] && !qwenEdit ? { reference_size: sizes[sceneId] } : {}) }, "POST");
        await props.onChanged();
      }
    } catch (error) { props.onError(error); }
    finally { setBusy(""); }
  };
  return <section>
    <h3>{t("storyboardGen.storyboardImagesByScene")}</h3>
    <p>{t("storyboardGen.usesTheLatestFrozenBlueprintAnd")}</p>
    <label>{t("storyboardGen.adoptedScriptOrStoryboard")}<select value={doc ? documentId : ""} onChange={(event) => setDocumentId(event.target.value)}><option value="">—</option>{docs.map((entry) => <option key={entry.id} value={entry.id}>{entry.title || entry.id.slice(0, 8)}</option>)}</select></label>
    {scenes.map((scene) => {
      const jobs = records.filter((record) => { try { return JSON.parse(record.inputs).resolved_refs?.story_scene_id === scene.id && record.blueprint_version_id === latest?.id; } catch { return false; } });
      return <div key={scene.id}><strong>{scene.label}</strong>
        {qwenEdit && <p>{t("storyboardGen.adoptedEditSource")}: {sources[scene.id]?.asset_id ?? (t("storyboardGen.none"))}</p>}
        {meta?.gen_backend === "comfy-sdk" && meta.gen_profile === "qwen-image-2.1-turbo" && !workflow?.selection && <button disabled={!!busy || !latest || !scene.adopted_revision_id} onClick={() => void request(scene.id, true)}>{t("storyboardGen.checkQwenReferenceDimensions")}</button>}
        {sizes[scene.id] && <label><input type="checkbox" checked={!!confirmed[scene.id]} onChange={(event) => setConfirmed((old) => ({ ...old, [scene.id]: event.target.checked }))} />{t("storyboardGen.confirmOutputDimensions")}: {sizes[scene.id].width} × {sizes[scene.id].height}</label>}
        <button disabled={!!busy || !meta || !workflow || !doc || !latest || !scene.adopted_revision_id || (qwenEdit && !sources[scene.id]) || (!!sizes[scene.id] && !confirmed[scene.id])} onClick={() => void request(scene.id, false)}>{t("storyboardGen.generateOrRetryScene")}</button>
        {jobs.map((job) => <div key={job.id}><span>{job.status}{job.error ? `: ${job.error}` : ""}</span>{job.output_asset_id && <img src={assetUrl(job.output_asset_id)} alt={scene.label} />}{(job.status === "running" || job.status === "queued") && <button onClick={() => void fetch(`/api/generations/${encodeURIComponent(job.id)}/cancel`, { method: "POST" }).then((response) => { if (!response.ok) throw new Error(`Cancel failed (${response.status})`); return props.onChanged(); }).catch(props.onError)}>{t("storyboardGen.cancel")}</button>}</div>)}
      </div>;
    })}
  </section>;
}
