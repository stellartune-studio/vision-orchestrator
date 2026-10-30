import { useEffect, useState } from "react";
import type { BlueprintVersionDetail, ProjectState } from "@vo/shared";
import { useI18n } from "../i18n.tsx";
import { assetUrl } from "../api/client.ts";
import { validPromotionLayout, type PromotionLayout } from "./promotionLayout.ts";

function promotionError(cause: unknown, t: (key: string, values?: Record<string, string | number>) => string): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("content does not match its registered hash")) return t("promotion.error.contentChanged");
  if (message.includes("PROMOTION_FONT_FILE")) return t("promotion.error.fontFile");
  if (message.includes("lacks verified glyphs")) return t("promotion.error.lacksGlyphs", { codepoints: message.match(/U\+[0-9A-F, +]+/)?.[0] ?? "" });
  if (message.includes("font coverage could not be verified")) return t("promotion.error.fontCoverage");
  return message;
}

export function PromotionProposal(props: { state: ProjectState; onChanged: () => Promise<void>; onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [scriptId, setScriptId] = useState("");
  const [points, setPoints] = useState("");
  const [closing, setClosing] = useState("");
  const [action, setAction] = useState("");
  const [logoId, setLogoId] = useState("");
  const [blueprint, setBlueprint] = useState<BlueprintVersionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [layout, setLayout] = useState<PromotionLayout>({ logo: { x: .1, y: .1, width: .2, height: .2 }, title: { x: .1, y: .8, width: .8, height: .045 } });
  const [approved, setApproved] = useState<{ revision_id: string; layout_json: string; title: string } | null>(null);
  const [videoId, setVideoId] = useState("");
  const [previewId, setPreviewId] = useState("");
  const [exportId, setExportId] = useState("");
  const [fonts, setFonts] = useState<{ id: string; label: string }[]>([]);
  const [fontId, setFontId] = useState("");
  const [error, setError] = useState("");
  const scripts = props.state.documents.filter((doc) => doc.kind === "script" && doc.adopted_revision_id);
  const script = scripts.find((doc) => doc.id === scriptId);
  const revision = script?.revisions.find((entry) => entry.id === script.adopted_revision_id);
  useEffect(() => {
    let active = true;
    void fetch("/api/promotion-fonts").then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<{ id: string; label: string }[]>; }).then((value) => { if (active) { setFonts(value); setFontId(value[0]?.id ?? ""); } }).catch((cause) => { if (active) setError(promotionError(cause, t)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setApproved(null); setPreviewId(""); setExportId("");
    if (revision?.id) void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/promotion-layouts/${encodeURIComponent(revision.id)}`).then(async (response) => {
      if (response.status === 409) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (active) { setApproved(data); setLayout(JSON.parse(data.layout_json) as PromotionLayout); }
    }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [props.state.project.id, revision?.id]);
  useEffect(() => {
    let active = true;
    setBlueprint(null); setLogoId("");
    if (revision?.blueprint_version_id) void fetch(`/api/blueprint-versions/${encodeURIComponent(revision.blueprint_version_id)}`).then(async (response) => {
      if (!response.ok) throw new Error("Could not read the script blueprint");
      const detail = await response.json() as BlueprintVersionDetail;
      if (active) setBlueprint(detail);
    }).catch((error) => { if (active) props.onError(error); });
    return () => { active = false; };
  }, [revision?.blueprint_version_id]);
  const logos = props.state.assets.filter((asset) => asset.mime === "image/png" && blueprint?.assets.some((entry) => entry.asset_id === asset.id));
  const videos = props.state.assets.filter((asset) => asset.mime === "video/mp4" && asset.owner_kind === "project" && asset.owner_id === props.state.project.id);
  const exports = videos.filter((asset) => asset.kind === "promotion-export");
  return <section className="item">
    <p>{t("promotion.saveAProposalWithAFrozen")}</p>
    <label>{t("promotion.baseScript")}<select value={scriptId} onChange={(event) => setScriptId(event.target.value)}><option value="">—</option>{scripts.map((doc) => <option key={doc.id} value={doc.id}>{doc.title || doc.id.slice(0, 8)}</option>)}</select></label>
    <label>{t("promotion.sellingPoints")}<textarea value={points} onChange={(event) => setPoints(event.target.value)} /></label>
    <label>{t("promotion.closingMessage")}<textarea value={closing} onChange={(event) => setClosing(event.target.value)} /></label>
    <label>{t("promotion.callToAction")}<input value={action} onChange={(event) => setAction(event.target.value)} /></label>
    <label>{t("promotion.frozenLogoAsset")}<select value={logoId} onChange={(event) => setLogoId(event.target.value)}><option value="">—</option>{logos.map((asset) => <option key={asset.id} value={asset.id}>{asset.id.slice(0, 8)}</option>)}</select></label>
    {(["logo", "title"] as const).map((part) => <fieldset key={part}><legend>{part === "logo" ? (t("promotion.logoPlacement")) : (t("promotion.titlePlacement"))}</legend>{(["x", "y", "width", "height"] as const).map((field) => <label key={field}>{field}<input type="number" min="0" max="1" step="0.01" value={layout[part][field]} onChange={(event) => setLayout((current) => ({ ...current, [part]: { ...current[part], [field]: event.target.value === "" ? NaN : Number(event.target.value) } }))} /></label>)}</fieldset>)}
    {!validPromotionLayout(layout) && <p role="alert">{t("promotion.useValuesFrom0To1")}</p>}
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || !script || !revision || !points.trim() || !closing.trim() || !action.trim() || !logoId || !validPromotionLayout(layout)} onClick={() => {
      if (!script || !revision || busy) return;
      setBusy(true);
      setError("");
      void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/promotion-proposals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document_id: script.id, base_revision_id: revision.id, expected_version: script.state_version, points, closing, call_to_action: action, logo_asset_id: logoId, layout }) }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        await props.onChanged();
      }).catch((cause) => setError(promotionError(cause, t))).finally(() => setBusy(false));
    }}>{t("promotion.saveUnapprovedScriptProposal")}</button>
    {approved && <section><p>{t("promotion.previewAndExportUseTheApproved")}</p>
      <label>{t("promotion.font")}<select value={fontId} onChange={(event) => setFontId(event.target.value)}><option value="">—</option>{fonts.map((font) => <option key={font.id} value={font.id}>{t("promotion.fontOption", { label: font.label })}</option>)}</select></label>
      <p className="muted small">{t("promotion.usesTheConfiguredFontUnverifiedGlyphs")}</p>
      {!fonts.length && <p role="alert">{t("promotion.noFontIsAvailableSetPROMOTION")}</p>}
      <label>{t("promotion.videoToPreview")}<select value={videoId} onChange={(event) => setVideoId(event.target.value)}><option value="">—</option>{videos.map((asset) => <option key={asset.id} value={asset.id}>{asset.id.slice(0, 8)}</option>)}</select></label>
      {([false, true] as const).map((exportFile) => <button key={String(exportFile)} disabled={busy || !videoId || !fontId} onClick={() => { setBusy(true); setError(""); void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/promotion-${exportFile ? "exports" : "previews"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: approved.revision_id, source_asset_id: videoId, font_id: fontId }) }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`); if (exportFile) setExportId(data.id); else setPreviewId(data.id); await props.onChanged(); }).catch((cause) => setError(promotionError(cause, t))).finally(() => setBusy(false)); }}>{exportFile ? t("promotion.exportAndSave") : t("promotion.previewApprovedLayout")}</button>)}
      {previewId && <video controls playsInline src={assetUrl(previewId)} />}
      {exportId && <p>{t("promotion.exportSavedToThisWork")}</p>}</section>}
    {exports.length > 0 && <section><h3>{t("promotion.savedExports")}</h3>{exports.map((asset) => <div key={asset.id}><p>{asset.id.slice(0, 8)} · {asset.created_at}</p><video controls playsInline src={assetUrl(asset.id)} /><a href={assetUrl(asset.id)} download>{t("promotion.downloadVideo")}</a></div>)}</section>}
  </section>;
}
