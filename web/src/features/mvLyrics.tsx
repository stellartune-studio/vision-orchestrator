import { useEffect, useRef, useState } from "react";
import type { BlueprintVersionDetail, ProjectState } from "@vo/shared";
import { useI18n } from "../i18n.tsx";
import { apiError, assetUrl } from "../api/client.ts";
import { createMvRequestLock, mvFont, mvLines, mvReadiness, mvSignature } from "./mvPlanState.ts";

export function MvLyrics(props: { state: ProjectState; onChanged: () => Promise<void>; onError: (error: unknown) => void }) {
  const { t, language } = useI18n();
  const text = language === "ja" ? {
    guide: "曲 → 構成・カット → 映像素材 → 確認・書き出し", music: "1. 曲を選ぶ", structure: "2. 構成・カット", media: "3. 映像素材", finish: "4. 確認・書き出し", noScript: "まず内容の書類でスクリプトを採用してください。", noAudio: "音声素材を選択して blueprint を保存し、その版のスクリプトを採用してください。", noVideo: "動画を生成または追加し、素材を選択して blueprint に保存してください。", instrumental: "歌詞なしで作る", lyrics: "歌詞を表示する", pending: "保存後、書類で提案を採用するとプレビューできます。", stale: "変更があります。提案を保存し、書類で採用してください。", ready: "採用済みのプランです。", busy: "処理中です。完了までお待ちください。", missingVideo: "書き出す映像を選択してください。", missingFont: "歌詞表示にはフォントが必要です。", sections: "曲区間とショットの計画は準備中です。"
  } : {
    guide: "Music → Structure and cuts → Video assets → Review and export", music: "1. Choose music", structure: "2. Structure and cuts", media: "3. Video assets", finish: "4. Review and export", noScript: "First adopt a script in Documents.", noAudio: "Select an audio asset, save a blueprint and adopt its script.", noVideo: "Generate or add video, select it and save it in a blueprint.", instrumental: "Create without lyrics", lyrics: "Show lyrics", pending: "After saving, adopt the proposal in Documents to preview.", stale: "Changes are unsaved or not adopted. Save the proposal and adopt it in Documents.", ready: "This plan is adopted.", busy: "Working. Please wait.", missingVideo: "Choose a video to export.", missingFont: "A font is required for lyrics.", sections: "Music section and shot planning is not yet available."
  };
  const [scriptId, setScriptId] = useState("");
  const [audioId, setAudioId] = useState("");
  const [blueprint, setBlueprint] = useState<BlueprintVersionDetail | null>(null);
  const [lines, setLines] = useState([{ start: "0", end: "", text: "" }]);
  const [instrumental, setInstrumental] = useState(false);
  const [beats, setBeats] = useState("");
  const [beatOrigin, setBeatOrigin] = useState<"manual" | "estimated_selected" | "estimated_edited">("manual");
  const [estimate, setEstimate] = useState<{ points: number[]; confidence: string; reason: string; duration: number; resolution_seconds: number } | null>(null);
  const [cuts, setCuts] = useState<{ start: string; video_asset_id: string }[]>([]);
  const [approvedSignature, setApprovedSignature] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [videoId, setVideoId] = useState("");
  const [fontId, setFontId] = useState("");
  const [fonts, setFonts] = useState<{ id: string; label: string }[]>([]);
  const [previewId, setPreviewId] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(createMvRequestLock());
  const begin = () => { if (!lock.current.begin()) return false; setBusy(true); return true; };
  const finish = () => { lock.current.finish(); setBusy(false); };
  const scripts = props.state.documents.filter((doc) => doc.kind === "script" && doc.adopted_revision_id);
  const doc = scripts.find((item) => item.id === scriptId);
  const revision = doc?.revisions.find((item) => item.id === doc.adopted_revision_id);
  const scope = JSON.stringify([props.state.project.id, doc?.id, revision?.id, doc?.state_version]);
  const current = useRef(""); current.current = JSON.stringify([props.state.project.id, audioId, revision?.id, doc?.state_version]);
  useEffect(() => {
    let active = true;
    void fetch("/api/promotion-fonts").then(async (response) => { if (!response.ok) throw apiError(response.status, await response.json().catch(() => null)); return response.json() as Promise<{ id: string; label: string }[]>; }).then((value) => { if (active) { setFonts(value); setFontId(value[0]?.id ?? ""); } }).catch((error) => { if (active) props.onError(error); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true; setBlueprint(null); setAudioId("");
    if (revision?.blueprint_version_id) void fetch(`/api/blueprint-versions/${encodeURIComponent(revision.blueprint_version_id)}`).then(async (response) => { if (!response.ok) throw apiError(response.status, await response.json().catch(() => null)); return response.json() as Promise<BlueprintVersionDetail>; }).then((value) => { if (active) setBlueprint(value); }).catch((error) => { if (active) props.onError(error); });
    return () => { active = false; };
  }, [revision?.blueprint_version_id]);
  useEffect(() => {
    let active = true; setDuration(null); setApprovedSignature("");
    if (revision?.id) void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/mv-plans/${encodeURIComponent(revision.id)}`).then(async (response) => {
      const data = await response.json() as { error?: string; audio_asset_id: string; audio_duration: number; beats_json: string; lyrics_json: string; clips_json: string; beat_origin: typeof beatOrigin };
      if (response.status === 409 && data.error === "MV plan is not the project's adopted revision") return;
      if (!response.ok) throw apiError(response.status, data);
      const plan = data;
      const savedLines = JSON.parse(plan.lyrics_json) as { start: number; end: number; text: string }[];
      const savedBeats = JSON.parse(plan.beats_json) as number[];
      const savedCuts = JSON.parse(plan.clips_json) as { start: number; video_asset_id: string }[];
      if (active) {
        const restoredLines = savedLines.map((line) => ({ start: String(line.start), end: String(line.end), text: line.text }));
        const restoredCuts = savedCuts.map((cut) => ({ start: String(cut.start), video_asset_id: cut.video_asset_id }));
        const restoredBeats = savedBeats.join(", ");
        setAudioId(plan.audio_asset_id); setDuration(plan.audio_duration); setInstrumental(restoredLines.length === 0); setLines(restoredLines.length ? restoredLines : [{ start: "0", end: "", text: "" }]); setBeats(restoredBeats); setCuts(restoredCuts); setBeatOrigin(plan.beat_origin);
        setApprovedSignature(mvSignature(scope, plan.audio_asset_id, restoredBeats, restoredLines, restoredCuts, plan.beat_origin, false));
      }
    }).catch((error) => { if (active) props.onError(error); });
    return () => { active = false; };
  }, [props.state.project.id, revision?.id]);
  useEffect(() => { setEstimate(null); }, [audioId, revision?.id]);
  useEffect(() => { setPreviewId(""); }, [props.state.project.id, scriptId, audioId, beats, lines, cuts, beatOrigin, instrumental]);
  const planChanged = approvedSignature !== mvSignature(scope, audioId, beats, lines, cuts, beatOrigin, instrumental);
  const audio = props.state.assets.filter((item) => item.mime?.startsWith("audio/") && blueprint?.assets.some((entry) => entry.asset_id === item.id));
  const videos = props.state.assets.filter((asset) => asset.mime === "video/mp4" && asset.owner_kind === "project" && asset.owner_id === props.state.project.id && blueprint?.assets.some((entry) => entry.asset_id === asset.id));
  const readiness = mvReadiness({ hasScript: !!doc, hasBlueprint: !!blueprint, audioCount: audio.length, videoCount: videos.length, adopted: duration !== null && !!revision, changed: planChanged, hasVideo: !!cuts.length || !!videoId, instrumental, hasFont: !!fontId, busy });
  return <section className="item">
    <p><strong>{text.guide}</strong></p>
    {busy && <p role="status">{text.busy}</p>}
    <h3>{text.music}</h3>
    {!scripts.length && <p role="status">{text.noScript}</p>}
    {readiness.noAudio && <p role="status">{text.noAudio}</p>}
    <p>{t("mvLyrics.estimateBeatCandidatesFromAudioTransients")}</p>
    <label>{t("mvLyrics.script")}<select value={scriptId} onChange={(event) => setScriptId(event.target.value)}><option value="">—</option>{scripts.map((item) => <option key={item.id} value={item.id}>{item.title || item.id.slice(0, 8)}</option>)}</select></label>
    <label>{t("mvLyrics.frozenAudio")}<select value={audioId} onChange={(event) => { setAudioId(event.target.value); setBeatOrigin("manual"); }}><option value="">—</option>{audio.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)}</option>)}</select></label>
    {duration !== null && <p>{t("mvLyrics.durationMeasured", { duration: duration.toFixed(3) })}</p>}
    <h3>{text.structure}</h3>
    <p>{text.sections}</p>
    <button type="button" disabled={busy || !doc || !revision || !audioId} onClick={() => {
      if (!doc || !revision || !begin()) return;
      const signature = current.current; setEstimate(null);
      void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/mv-beat-proposals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document_id: doc.id, base_revision_id: revision.id, expected_version: doc.state_version, audio_asset_id: audioId }) }).then(async (response) => {
        const data = await response.json(); if (!response.ok) throw apiError(response.status, data);
        if (current.current === signature) setEstimate(data);
      }).catch(props.onError).finally(finish);
    }}>{t("mvLyrics.estimateBeatCandidates")}</button>
    {estimate && <div role="status"><p>{t("mvLyrics.unconfirmedCandidates")}: {estimate.points.join(", ") || "—"} · {estimate.confidence} · {estimate.reason} · {estimate.duration.toFixed(3)}s · {estimate.resolution_seconds}s</p><button type="button" disabled={!estimate.points.length} onClick={() => { setBeats(estimate.points.join(", ")); setBeatOrigin("estimated_selected"); }}>{t("mvLyrics.useCandidatesInEditField")}</button></div>}
    <label>{t("mvLyrics.beatPointsToReviewAndEdit")}<input value={beats} onChange={(event) => { setBeats(event.target.value); setBeatOrigin((origin) => origin === "manual" ? "manual" : "estimated_edited"); }} placeholder="0, 0.5, 1" /></label>
    <p>{t("mvLyrics.beatSource")}: {beatOrigin}</p>
    <h3>{text.media}</h3>
    {readiness.noVideo && <p role="status">{text.noVideo}</p>}
    <p>{t("mvLyrics.startTheFirstCutAtZero")}</p>
    {cuts.map((cut, index) => <fieldset key={index}><legend>{t("mvLyrics.cutN", { n: index + 1 })}</legend>
      <label>{t("mvLyrics.startSeconds")}<input type="number" min="0" step="0.001" value={cut.start} onChange={(event) => setCuts((items) => items.map((item, i) => i === index ? { ...item, start: event.target.value } : item))} /></label>
      <label>{t("mvLyrics.frozenVideo")}<select value={cut.video_asset_id} onChange={(event) => setCuts((items) => items.map((item, i) => i === index ? { ...item, video_asset_id: event.target.value } : item))}><option value="">—</option>{props.state.assets.filter((asset) => asset.mime === "video/mp4" && asset.owner_kind === "project" && asset.owner_id === props.state.project.id && blueprint?.assets.some((entry) => entry.asset_id === asset.id)).map((asset) => <option key={asset.id} value={asset.id}>{asset.id.slice(0, 8)}</option>)}</select></label>
      <button type="button" onClick={() => setCuts((items) => items.filter((_, i) => i !== index))}>{t("mvLyrics.removeCut")}</button></fieldset>)}
    <button type="button" disabled={cuts.length >= 64} onClick={() => setCuts((items) => [...items, { start: items.length ? "" : "0", video_asset_id: "" }])}>{t("mvLyrics.addCut")}</button>
    <label><input type="checkbox" checked={instrumental} onChange={(event) => setInstrumental(event.target.checked)} /> {text.instrumental}</label>
    {!instrumental && <><h4>{text.lyrics}</h4>{lines.map((line, index) => <fieldset key={index}><legend>{t("mvLyrics.lyricN", { n: index + 1 })}</legend>{(["start", "end", "text"] as const).map((field) => <label key={field}>{field}<input type={field === "text" ? "text" : "number"} min={field === "text" ? undefined : "0"} step={field === "text" ? undefined : "0.001"} value={line[field]} onChange={(event) => setLines((items) => items.map((item, i) => i === index ? { ...item, [field]: event.target.value } : item))} /></label>)}<button type="button" disabled={lines.length === 1} onClick={() => setLines((items) => items.filter((_, i) => i !== index))}>{t("mvLyrics.removeLine")}</button></fieldset>)}
    <button type="button" disabled={lines.length >= 200} onClick={() => setLines((items) => [...items, { start: "", end: "", text: "" }])}>{t("mvLyrics.addLyricLine")}</button></>}
    <p>{text.pending}</p>
    <button disabled={busy || !doc || !revision || !audioId || (!instrumental && lines.some((line) => !line.start.trim() || !line.end.trim() || !line.text.trim()))} onClick={() => {
      if (!doc || !revision || !begin()) return;
      const points = beats.trim() ? beats.split(",").map((value) => value.trim() === "" ? null : Number(value.trim())) : [];
      void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/mv-lyrics-proposals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document_id: doc.id, base_revision_id: revision.id, expected_version: doc.state_version, audio_asset_id: audioId, beats: points, beat_origin: beatOrigin, cuts: cuts.map((cut) => ({ start: cut.start.trim() ? Number(cut.start) : null, video_asset_id: cut.video_asset_id })), lines: mvLines(instrumental, lines) }) }).then(async (response) => { const result = await response.json(); if (!response.ok) throw apiError(response.status, result); await props.onChanged(); }).catch(props.onError).finally(finish);
    }}>{t("mvLyrics.saveUnapprovedLyrics")}</button>
    <h3>{text.finish}</h3>
    {readiness.plan === "pending" && <p role="status">{text.pending}</p>}
    {duration !== null && revision && <section>
      <p>{t("mvLyrics.mixApprovedLyricsAndMusicWith")}</p>
      {readiness.plan !== "pending" && <p role="status">{readiness.plan === "stale" ? text.stale : text.ready}</p>}
      {readiness.missingVideo && <p>{text.missingVideo}</p>}
      {readiness.missingFont && <p>{text.missingFont}</p>}
      <label>{t("mvLyrics.frozenSourceVideo")}<select value={videoId} onChange={(event) => setVideoId(event.target.value)}><option value="">—</option>{props.state.assets.filter((asset) => asset.mime === "video/mp4" && asset.owner_kind === "project" && asset.owner_id === props.state.project.id && blueprint?.assets.some((entry) => entry.asset_id === asset.id)).map((asset) => <option key={asset.id} value={asset.id}>{asset.id.slice(0, 8)}</option>)}</select></label>
      {!instrumental && <><label>{t("mvLyrics.lyricFont")}<select value={fontId} onChange={(event) => setFontId(event.target.value)}><option value="">—</option>{fonts.map((font) => <option key={font.id} value={font.id}>{t("mvLyrics.fontOption", { label: font.label })}</option>)}</select></label>
      {!fonts.length && <p>{t("mvLyrics.setPROMOTIONFONTFILEToA")}</p>}</>}
      {([false, true] as const).map((exportFile) => <button key={String(exportFile)} disabled={!readiness.canRender} onClick={() => { if (!begin()) return; void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/mv-${exportFile ? "exports" : "previews"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: revision.id, video_asset_id: cuts.length ? cuts[0].video_asset_id : videoId, ...mvFont(instrumental, fontId) }) }).then(async (response) => { const result = await response.json(); if (!response.ok) throw apiError(response.status, result); if (!exportFile) setPreviewId(result.id); await props.onChanged(); }).catch(props.onError).finally(finish); }}>{exportFile ? t("mvLyrics.exportMv") : t("mvLyrics.previewMv")}</button>)}
      {previewId && <video controls playsInline src={assetUrl(previewId)} />}
    </section>}
    {props.state.assets.some((asset) => asset.kind === "mv-export") && <section><h3>{t("mvLyrics.savedMVs")}</h3>{props.state.assets.filter((asset) => asset.kind === "mv-export").map((asset) => <div key={asset.id}><p>{asset.id.slice(0, 8)} · {asset.created_at}</p><video controls playsInline src={assetUrl(asset.id)} /><a href={assetUrl(asset.id)} download>{t("mvLyrics.downloadVideo")}</a></div>)}</section>}
  </section>;
}
