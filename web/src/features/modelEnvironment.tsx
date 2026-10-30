import { useEffect, useState } from "react";
import type { SavedWorkflowSelection, WorkflowCatalogEntry, WorkflowNode, WorkflowSelection, WorkflowValue } from "@vo/shared";
import { useI18n } from "../i18n.tsx";
import { environmentRequest, inputChoices, nodeInputSchema, type Catalog } from "../api/environment.ts";
import { EnvironmentWizard } from "./environmentWizard.tsx";
import { MemoryStatus } from "./memoryStatus.tsx";

const empty: SavedWorkflowSelection = { version: 0, selection: null };

export function ModelEnvironmentPanel(props: { projectId: string; onSelection: (selection: SavedWorkflowSelection | null) => void }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<SavedWorkflowSelection>(empty);
  const [draft, setDraft] = useState<WorkflowSelection | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [templates, setTemplates] = useState<WorkflowCatalogEntry[]>([]);
  const [promptConfirmed, setPromptConfirmed] = useState(true);
  const [comparison, setComparison] = useState<SavedWorkflowSelection | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const dirty = JSON.stringify(saved.selection) !== JSON.stringify(draft);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    props.onSelection(null);
    Promise.all([
      environmentRequest<SavedWorkflowSelection>(`/api/projects/${props.projectId}/generation-selection`),
      environmentRequest<typeof templates>("/api/environment/workflows"),
      environmentRequest<Catalog>("/api/environment/catalog"),
    ]).then(([s, t, c]) => {
      if (!active) return;
      setSaved(s); setDraft(s.selection); setTemplates(t); setCatalog(c); setLoaded(true);
    }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [props.projectId]);
  useEffect(() => { props.onSelection(loaded && !dirty && !busy ? saved : null); }, [loaded, dirty, busy, saved]);

  const installGraph = (name: string, raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || "nodes" in raw) throw new Error(t("modelEnv.chooseAnAPIFormatWorkflow"));
    const graph = raw as Record<string, WorkflowNode>;
    if (!Object.values(graph).every((n) => n && typeof n.class_type === "string" && n.inputs)) throw new Error("Invalid API graph");
    const entries = Object.entries(graph);
    const promptCandidates = entries.flatMap(([node, n]) => Object.entries(n.inputs).filter(([key, v]) => typeof v === "string" && /^(prompt|text|value)$/.test(key)).map(([input]) => ({ node, input })));
    const prompt = promptCandidates[0];
    const output = entries.find(([, n]) => /SaveImage|SaveVideo|VideoCombine/.test(String(n.class_type)))?.[0] ?? entries.at(-1)?.[0];
    if (!prompt || !output) throw new Error(t("modelEnv.graphNeedsATextPromptInput"));
    const reference = entries.find(([, n]) => n.class_type === "LoadImage");
    const settings: WorkflowSelection["settings"] = {};
    // Preserve the imported graph's processing defaults. Output mappings are
    // opt-in: guessing dimensions/scales can change an official workflow.
    setPromptConfirmed(promptCandidates.length === 1);
    setDraft({ name, graph, kind: name.includes("i2v") || name.includes("video") ? "video" : "image", prompt, output_node: output, reference: reference ? { node: reference[0], input: "image" } : undefined, settings, values: [] });
    setMessage(""); setError("");
  };
  const inputs = draft ? Object.entries(draft.graph).flatMap(([node, n]) => Object.entries(n.inputs).filter(([, v]) => !Array.isArray(v)).map(([input, value]) => ({ node, input, value, classType: String(n.class_type) }))) : [];
  const reserved = (node: string, input: string) => draft && ((node === draft.prompt.node && input === draft.prompt.input) || (node === draft.reference?.node && input === draft.reference.input));
  const setValue = (node: string, input: string, value: WorkflowValue) => setDraft((d) => d && ({ ...d, values: [...d.values.filter((v) => v.node !== node || v.input !== input), { node, input, value }] }));
  const save = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const s = await environmentRequest<SavedWorkflowSelection>(`/api/projects/${props.projectId}/generation-selection`, { expected_version: saved.version, selection: draft }, "PUT");
      setSaved(s); setDraft(s.selection); setConflict(false); setComparison(null); setMessage(t("modelEnv.generationSettingsSavedNoApprovalOr"));
    } catch (e) { setError(String(e)); if ((e as { status?: number }).status === 409) setConflict(true); } finally { setBusy(false); }
  };
  const reload = async () => {
    if (dirty) { setError(t("modelEnv.unsavedInputPreservedFetchLatestFor")); setConflict(true); return; }
    setBusy(true);
    try {
      const [s, t, c] = await Promise.all([
        environmentRequest<SavedWorkflowSelection>(`/api/projects/${props.projectId}/generation-selection`),
        environmentRequest<typeof templates>("/api/environment/workflows"),
        environmentRequest<Catalog>("/api/environment/catalog"),
      ]);
      setSaved(s); setDraft(s.selection); setTemplates(t); setCatalog(c); setLoaded(true); setError("");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  // Collapse once the saved state has loaded — the stage belongs to
  // the work, not the environment form. Open while loading so the
  // first-run wizard stays reachable; users expand it when needed.
  return <details className="panel model-environment" open={!loaded}>
    <summary>{t("modelEnv.modelsWorkflowsEnvironment")}{dirty ? " *" : ""}</summary>
    <p className="muted small">{t("modelEnv.youChooseAIOnlyProposesSaved")}</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <p role="status">{t("modelEnv.currentlySaved")}: v{saved.version} · {saved.selection?.name ?? t("modelEnv.defaultWorkflowNotVerifiedAgainstThe")}</p>
    <p className="muted small">{t("modelEnv.importedProcessingDefaultsArePreservedResolution")}</p>
    {conflict && <div role="alert">
      <p>{t("modelEnv.draftPreservedCompareTheLatestSaved")}</p>
      <button onClick={() => void environmentRequest<SavedWorkflowSelection>(`/api/projects/${props.projectId}/generation-selection`).then(setComparison).catch((e) => setError(String(e)))}>{t("modelEnv.fetchLatestForComparison")}</button>
      {comparison && <><details><summary>{t("modelEnv.latestAndDraftComparison")}</summary><pre>{JSON.stringify({ latest: comparison, draft }, null, 2)}</pre></details><button onClick={() => { setSaved(comparison); setConflict(false); setComparison(null); setError(""); }}>{t("modelEnv.keepDraftUseLatestVersionAs")}</button><button onClick={() => { setSaved(comparison); setDraft(comparison.selection); setConflict(false); setComparison(null); setError(""); }}>{t("modelEnv.useLatestSavedSelection")}</button></>}
    </div>}
    <MemoryStatus />
    <EnvironmentWizard catalog={catalog} onCatalog={setCatalog} />
    <button type="button" onClick={() => void environmentRequest<typeof templates>("/api/environment/workflows").then(setTemplates).catch((e) => setError(String(e)))}>{t("modelEnv.reloadWorkflowCopies")}</button>
    <label>{t("modelEnv.chooseWorkflowCopy")}<select aria-label={t("modelEnv.chooseWorkflowCopy2")} disabled={!loaded || busy} value="" onChange={(e) => { const w = templates.find((v) => v.name === e.target.value); if (w) try { if (w.selection) { setDraft(structuredClone(w.selection)); setPromptConfirmed(true); setError(""); setMessage(""); } else installGraph(w.name, w.graph); } catch (e) { setError(String(e)); } }}><option value="">—</option>{templates.map((w) => <option key={w.name}>{w.name}</option>)}</select></label>
    <label>{t("modelEnv.importAPIWorkflowOriginalPreserved")}<input disabled={!loaded || busy} type="file" accept=".json" onChange={(e) => { const file = e.target.files?.[0]; if (file) void file.text().then((text) => installGraph(file.name, JSON.parse(text))).catch((e) => setError(String(e))); e.target.value = ""; }} /></label>
    {draft && <>
      {draft.source && <details><summary>{t("modelEnv.originalSourceAndPinnedVersionNot")}</summary><p><a href={draft.source.url} target="_blank" rel="noreferrer">{draft.source.url}</a></p><p>{draft.source.revision}</p><p>Source SHA256: {draft.source.source_sha256}</p><p>API SHA256: {draft.source.api_sha256}</p><p>{t("modelEnv.verbatimReproductionRequiresAnApprovedDocument")}</p></details>}
      <p className="muted small">{t("modelEnv.catalogChoicesConfirmAvailabilityArchitectureAnd")}</p>
      <label>{t("modelEnv.name")}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>{t("modelEnv.outputKind")}<select aria-label={t("modelEnv.outputKind2")} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as "image" | "video" })}><option value="image">Image</option><option value="video">Video</option></select></label>
      {!promptConfirmed && <p role="alert">{t("modelEnv.multipleTextInputsExistDistinguishSystem")}</p>}
      <label>{t("modelEnv.promptInput")}<select aria-label={t("modelEnv.promptInput2")} value={`${draft.prompt.node}\0${draft.prompt.input}`} onChange={(e) => { const [node, input] = e.target.value.split("\0"); setPromptConfirmed(true); setDraft({ ...draft, prompt: { node, input }, values: draft.values.filter((v) => v.node !== node || v.input !== input) }); }}>{inputs.filter((v) => typeof v.value === "string").map((v) => <option key={`${v.node}.${v.input}`} value={`${v.node}\0${v.input}`}>{v.node}.{v.input}</option>)}</select></label>
      <details><summary>{t("modelEnv.inspectOriginalTextToBeReplaced")}</summary><pre>{String(draft.graph[draft.prompt.node]?.inputs[draft.prompt.input] ?? "")}</pre></details>
      {!promptConfirmed && <button onClick={() => setPromptConfirmed(true)}>{t("modelEnv.confirmThisPromptMapping")}</button>}
      <label><input type="checkbox" checked={draft.prompt_verbatim === true} onChange={(e) => setDraft({ ...draft, prompt_verbatim: e.target.checked })} />{t("modelEnv.reproduceTemplateSubjectSendTheApproved")}</label>
      <label>{t("modelEnv.outputNode")}<select aria-label={t("modelEnv.outputNode2")} value={draft.output_node} onChange={(e) => setDraft({ ...draft, output_node: e.target.value })}>{Object.entries(draft.graph).map(([id, n]) => <option key={id} value={id}>{id}: {String(n.class_type)}</option>)}</select></label>
      <details><summary>{t("modelEnv.approvedOutputSettingBindings")}</summary>
        {(["width", "height", "duration_seconds"] as const).map((key) => <label key={key}>{key}<select value={draft.settings?.[key] ? `${draft.settings[key]!.node}\0${draft.settings[key]!.input}` : ""} onChange={(e) => {
          const settings = { ...draft.settings };
          if (!e.target.value) delete settings[key]; else { const [node, input] = e.target.value.split("\0"); settings[key] = { node, input, scale: 1 }; }
          setDraft({ ...draft, settings });
        }}><option value="">—</option>{inputs.filter((v) => typeof v.value === "number").map((v) => <option key={`${v.node}.${v.input}`} value={`${v.node}\0${v.input}`}>{v.node}.{v.input}</option>)}</select>
          {draft.settings?.[key] && <input aria-label={`${key} scale`} type="number" step="any" value={draft.settings[key]!.scale ?? 1} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, [key]: { ...draft.settings![key]!, scale: Number(e.target.value) } } })} />}
        </label>)}
      </details>
      <details open><summary>{t("modelEnv.mainModelComponentsLoRAInputs")}</summary>
        {inputs.filter((v) => !reserved(v.node, v.input)).map((v) => {
          const value = draft.values.find((x) => x.node === v.node && x.input === v.input)?.value ?? v.value;
          const savedValue = saved.selection?.values.find((x) => x.node === v.node && x.input === v.input)?.value ?? saved.selection?.graph[v.node]?.inputs[v.input];
          const spec = nodeInputSchema(catalog?.nodes[v.classType]);
          const options = inputChoices(spec?.required?.[v.input] ?? spec?.optional?.[v.input]);
          const fieldLabel = `${v.classType} · ${v.node}.${v.input}`;
          const warningId = catalog?.connected && !catalog.nodes[v.classType] ? `model-warning-${encodeURIComponent(`${v.node}/${v.input}`)}` : undefined;
          const definition = spec?.required?.[v.input] ?? spec?.optional?.[v.input];
          const isChoice = Array.isArray(definition?.[0]) || definition?.[0] === "COMBO";
          return <label key={`${v.node}.${v.input}`}>{v.classType} · {v.node}.{v.input}
            {options.length ? <select aria-label={fieldLabel} aria-describedby={warningId} value={String(value)} onChange={(e) => setValue(v.node, v.input, e.target.value)}>{!options.includes(String(value)) && <option value={String(value)}>{String(value)} ({t("modelEnv.unregistered")})</option>}{options.map((o) => <option key={o}>{o}</option>)}</select> : typeof value === "boolean" ? <input aria-label={fieldLabel} aria-describedby={warningId} type="checkbox" checked={value} onChange={(e) => setValue(v.node, v.input, e.target.checked)} /> : <input aria-label={fieldLabel} aria-describedby={warningId} type={typeof value === "number" ? "number" : "text"} value={String(value)} onChange={(e) => setValue(v.node, v.input, typeof value === "number" ? Number(e.target.value) : e.target.value)} />}
            <small style={{ display: "block" }}>{t("modelEnv.saved")}: {savedValue === undefined ? "—" : String(savedValue)}{savedValue !== value ? ` → ${String(value)} (${t("modelEnv.unsaved")})` : ""} · {options.length ? `${t("modelEnv.choices")}: ${options.length}` : t("modelEnv.directInput")}</small>
            {warningId && <small style={{ display: "block" }} id={warningId}>{t("modelEnv.nodeMissingIntegrationRequiredBeforeGeneration")}</small>}
            {catalog?.connected && isChoice && !options.includes(String(value)) && <small role="alert">{t("modelEnv.selectedValueIsUnavailableInThis")}</small>}
          </label>;
        })}
      </details>
      <button onClick={() => { const graph = structuredClone(draft.graph); for (const v of draft.values) graph[v.node].inputs[v.input] = v.value; const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" })); a.download = draft.name.endsWith(".json") ? draft.name : `${draft.name}.json`; a.click(); URL.revokeObjectURL(a.href); }}>{t("modelEnv.downloadEditableCopy")}</button>
    </>}
    <div><button disabled={busy || !loaded || !dirty || conflict || !promptConfirmed} onClick={() => void save()}>{t("modelEnv.saveGenerationSettings")}</button><button disabled={busy || (!loaded && !error)} onClick={() => void reload()}>{t("modelEnv.reloadSavedSettings")}</button><button disabled={busy || !loaded} onClick={() => setDraft(null)}>{t("modelEnv.useDefaultWorkflow")}</button></div>
    {dirty && <p>{t("modelEnv.unsavedChangesSaveBeforeGenerating")}</p>}
  </details>;
}
