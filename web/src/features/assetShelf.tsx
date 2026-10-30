import { useRef, useState } from "react";
import type { Asset, ProjectState } from "@vo/shared";
import { api, assetUrl } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import { findShelfDuplicate, shelfFileError } from "./assetShelfState.ts";

export function AssetShelf({ state, onChanged }: { state: ProjectState; onChanged: () => Promise<void> }) {
  const { language } = useI18n();
  const ja = language === "ja";
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [duplicateId, setDuplicateId] = useState("");
  const assets = state.assets.filter((a) => a.owner_kind === "project" && a.owner_id === state.project.id && (a.mime?.startsWith("image/") || a.mime?.startsWith("audio/") || a.mime?.startsWith("video/")));
  const selected = assets.find((asset) => asset.id === selectedId);
  const choose = (candidate: File | undefined) => {
    if (!candidate || lock.current) return;
    setFile(candidate); setDuplicateId("");
    const issue = shelfFileError(candidate.name, candidate.size);
    setMessage(issue === "type" ? (ja ? "未対応の形式です。画像、音声または動画を選んでください。" : "Unsupported format. Choose a supported image, audio or video file.") : issue === "size" ? (ja ? "空ファイルまたは 16 MiB を超えるファイルは取り込めません。" : "Files must be nonempty and at most 16 MiB.") : "");
  };
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(`${ja ? "処理できませんでした。素材一覧を更新して確認後、再試行してください。" : "Could not complete the request. Refresh the shelf and check before retrying."} ${error instanceof Error ? error.message : ""}`); }
    finally { lock.current = false; setBusy(false); }
  };
  const upload = () => {
    if (!file || shelfFileError(file.name, file.size)) return;
    void run(async () => {
      const bytes = await file.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      // Refresh before checking: a previous response may have been lost after upload.
      await onChanged();
      const current = await api.state(state.project.id);
      const duplicate = findShelfDuplicate(current.assets, state.project.id, hash);
      if (duplicate) { setDuplicateId(duplicate.id); setMessage(ja ? "同じ内容の素材があります。既存素材を選べます。" : "Matching content already exists. You can use the existing asset."); return; }
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("File read failed")); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file); });
      const asset = await api.uploadAsset("project", state.project.id, "material", file.name, data);
      setSelectedId(asset.id); setFile(null); await onChanged();
      setMessage(ja ? "取り込みました。素材を選択してから blueprint を保存してください。" : "Imported. Select the asset, then save a blueprint.");
    });
  };
  const toggle = (asset: Asset) => void run(async () => { await api.selectAsset(asset.id, !asset.selected, asset.selection_version); await onChanged(); });
  return <section className="item" aria-label={ja ? "共通素材棚" : "Shared assets"}>
    <h3>{ja ? "共通素材棚" : "Shared assets"}</h3>
    <p className="muted small">{ja ? "元ファイルは変更されません。選択後、版を保存して各モードで使えます。" : "Your original file is unchanged. Select assets and save a version to use them in modes."}</p>
    <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
      <label>{ja ? "素材を選ぶ（またはここへドロップ）" : "Choose an asset (or drop it here)"}<input type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,.wav,.mp3,.m4a" disabled={busy} onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ""; }} /></label>
    </div>
    {file && <p>{file.name} · {(file.size / 1048576).toFixed(2)} MiB</p>}
    <button type="button" disabled={busy || !file || !!shelfFileError(file.name, file.size)} onClick={upload}>{busy ? (ja ? "処理中…" : "Working…") : (ja ? "取り込む" : "Import")}</button>
    {message && <p role="status">{message}</p>}
    {duplicateId && <button type="button" onClick={() => setSelectedId(duplicateId)}>{ja ? "既存素材を見る" : "View existing asset"}</button>}
    {assets.length === 0 ? <p>{ja ? "まだ素材がありません。上から追加できます。" : "No assets yet. Add one above."}</p> : <label>{ja ? "素材を表示" : "View asset"}<select value={selected?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}><option value="">—</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.kind} · {a.id.slice(0, 8)} {a.selected ? (ja ? "（選択中）" : "(selected)") : ""}</option>)}</select></label>}
    {selected && <div><p>{selected.mime} · {selected.id.slice(0, 8)} · {selected.selected ? (ja ? "選択中" : "selected") : (ja ? "未選択" : "not selected")}</p>
      {selected.mime?.startsWith("image/") && <img src={assetUrl(selected.id)} alt={ja ? "選択した素材のプレビュー" : "Selected asset preview"} style={{ maxWidth: "100%", maxHeight: "12rem" }} />}
      {selected.mime?.startsWith("audio/") && <audio controls src={assetUrl(selected.id)} />}
      {selected.mime?.startsWith("video/") && <video controls playsInline src={assetUrl(selected.id)} style={{ maxWidth: "100%", maxHeight: "12rem" }} />}
      <button type="button" disabled={busy} onClick={() => toggle(selected)}>{selected.selected ? (ja ? "選択を解除" : "Deselect") : (ja ? "素材として選択" : "Select as material")}</button>
      <p className="muted small">{ja ? "MV では音声と MP4 を、選択後に保存した blueprint と採用済みスクリプトから指定できます。" : "In MV, audio and MP4 can be chosen after saving a blueprint and adopting its script."}</p>
    </div>}
  </section>;
}
