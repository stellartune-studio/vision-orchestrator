import { useEffect, useState } from "react";
import type { ItemView, ProjectState } from "@vo/shared";
import { api } from "../api/client.ts";
import { environmentRequest } from "../api/environment.ts";
import { useI18n } from "../i18n.tsx";

type Source = { revision_id: string; asset_id: string; sha256: string };
export function SceneEditSource(props: { scene: ItemView; state: ProjectState; onChanged: () => Promise<void>; onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [record, setRecord] = useState<{ adopted: Source | null; pending: Source[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/api/projects/${encodeURIComponent(props.state.project.id)}/story-scenes/${encodeURIComponent(props.scene.id)}`;
  useEffect(() => { let active = true; void environmentRequest<{ adopted: Source | null; pending: Source[] }>(`${path}/edit-sources`).then((v) => { if (active) setRecord(v); }).catch(props.onError); return () => { active = false; }; }, [path, props.scene.state_version, props.scene.revisions.length]);
  const projectAssets = props.state.assets.filter((asset) => asset.owner_kind === "project" && asset.owner_id === props.state.project.id && asset.selected && asset.mime === "image/png" && asset.sha256);
  const pinned = props.state.characters.flatMap((pin) => {
    const character = props.state.character_views.find((entry) => entry.id === pin.character_id);
    const revision = character?.revisions.find((entry) => entry.id === pin.character_revision_id);
    return revision?.base_image_asset_id ? [{ id: revision.base_image_asset_id, label: character?.name ?? pin.character_id }] : [];
  });
  return <details><summary>{t("sceneEditSource.approveThisSceneSEditSource")}</summary>
    <p>{t("sceneEditSource.oneEditImageIsUsedOther")}</p>
    <label>{t("sceneEditSource.editSourceImagePNG")}<select value={source} onChange={(event) => setSource(event.target.value)}><option value="">—</option>{projectAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.id.slice(0, 8)} — {t("sceneEditSource.projectAsset")}</option>)}{pinned.map((asset) => <option key={`character-${asset.id}`} value={asset.id}>{asset.label} — {t("sceneEditSource.pinnedCharacterBase")}</option>)}</select></label>
    <button disabled={busy || !source || !props.scene.adopted_revision_id} onClick={() => { setBusy(true); void environmentRequest(`${path}/edit-source-proposals`, { asset_id: source, expected_version: props.scene.state_version }).then(props.onChanged).catch(props.onError).finally(() => setBusy(false)); }}>{t("sceneEditSource.saveUnapprovedEditSource")}</button>
    {record?.adopted && <p>{t("sceneEditSource.adoptedEditSource")}: {record.adopted.asset_id}</p>}
    {record?.pending.map((entry) => <p key={entry.revision_id}>{entry.asset_id} <button disabled={busy} onClick={() => { setBusy(true); void api.adopt(props.scene.id, entry.revision_id, props.scene.state_version).then(props.onChanged).catch(props.onError).finally(() => setBusy(false)); }}>{t("sceneEditSource.adoptThisEditSource")}</button></p>)}
  </details>;
}
