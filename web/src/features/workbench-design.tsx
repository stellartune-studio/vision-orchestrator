import { useState } from "react";
import {
  CHARACTER_SHEET_FIELDS,
  CHARACTER_SHEET_LOCKABLE_FIELDS,
  CHARACTER_SHEET_VIEWS,
  type CharacterSheetField,
  type CharacterSheetLockField,
  type ProjectState,
} from "@vo/shared";
import type { WorkMode } from "./modes.tsx";
import { useI18n } from "../i18n.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { assetUrl } from "../api/client.ts";
import {
  sheetDiffFields,
  useWorkbenchCharacterSheets,
} from "./characterSheet.ts";
import { CharacterCard } from "./characters.tsx";
import { useWorkbenchBackground } from "./workbenchBackground.ts";
import { MOCK_BACKDROPS } from "./workbench-design.mock.ts";

type DesignTab = "character" | "scene" | "voice" | "template";

const tabs: { key: DesignTab; icon: IconName }[] = [
  { key: "character", icon: "character" },
  { key: "scene", icon: "landscape" },
  { key: "voice", icon: "voice" },
  { key: "template", icon: "template" },
];

const backdrops = MOCK_BACKDROPS;

function MockMark() {
  const { t } = useI18n();
  return <span className="design-mock"><i />{t("mode.preview")}</span>;
}

function Avatar({ variant = "front", color = "#eea98b" }: { variant?: string; color?: string }) {
  return (
    <div className={`sheet-avatar ${variant}`} style={{ "--avatar-color": color } as React.CSSProperties} aria-hidden="true">
      <span className="avatar-hair" /><span className="avatar-face"><Icon name="face" /></span><span className="avatar-body" />
    </div>
  );
}

export function WorkbenchDesignPanel(props: {
  mode: WorkMode;
  state: ProjectState;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { mode } = props;
  const { t } = useI18n();
  const [tab, setTab] = useState<DesignTab>("character");
  const sheets = useWorkbenchCharacterSheets(props.state, props.onChanged, props.onError);
  const entry = sheets.entry;
  const sheet = sheets.sheet;
  const selKey = sheets.selected ?? "";
  const [selectedViewByCharacter, setSelectedViewByCharacter] = useState<Record<string, string>>({});
  const selectedView = selectedViewByCharacter[selKey] ?? "front";
  const setSelectedView = (view: string) => setSelectedViewByCharacter((old) => ({ ...old, [selKey]: view }));
  const bg = useWorkbenchBackground(
    props.state,
    props.onChanged,
    props.onError,
    MOCK_BACKDROPS[0].key,
  );
  const sceneIndex = Math.max(
    0,
    backdrops.findIndex((b) => b.key === bg.backdropKey),
  );
  const [voiceByCharacter, setVoiceByCharacter] = useState<Record<string, string>>({});
  const [voicePinnedByCharacter, setVoicePinnedByCharacter] = useState<Record<string, boolean>>({});
  const [emotionByCharacter, setEmotionByCharacter] = useState<Record<string, string>>({});
  const [speedByCharacter, setSpeedByCharacter] = useState<Record<string, number>>({});
  const voice = voiceByCharacter[selKey] ?? "mid";
  const voicePinned = voicePinnedByCharacter[selKey] ?? true;
  const emotion = emotionByCharacter[selKey] ?? "gentle";
  const speed = speedByCharacter[selKey] ?? 1;
  const setVoice = (next: string | ((previous: string) => string)) => setVoiceByCharacter((old) => ({ ...old, [selKey]: typeof next === "function" ? next(old[selKey] ?? "mid") : next }));
  const [template, setTemplate] = useState("story");
  const [templateName, setTemplateName] = useState(() => t("design.template.default"));
  const [saved, setSaved] = useState<string[]>([]);
  const characterLabel = entry?.name ?? "—";
  const newSheetCount = sheets.entries.filter((e) => e.isNew).length;
  // The selected sheet's library character — drives the collapsed
  // advanced revision/pin editor (unsaved "new" sheets have none).
  const libraryView =
    sheets.library.find((c) => c.id === entry?.characterId) ?? null;
  const pinVersion =
    props.state.characters.find((p) => p.character_id === entry?.characterId)
      ?.pin_version ?? null;

  const sheetStatus = !entry
    ? null
    : entry.isNew
      ? t("design.sheetNewUnsaved")
      : sheets.dirty
        ? t("design.sheetUnsaved")
        : entry.baseRevNo != null
          ? t("design.sheetSaved", { version: entry.baseRevNo })
          : t("design.sheetNoRevision");
  const sheetFailure =
    sheets.saveFailure === "conflict"
      ? t("design.sheetConflict")
      : sheets.saveFailure === "failed"
        ? t("design.sheetSaveFailed")
        : null;
  const toggleFieldLock = (field: CharacterSheetLockField) =>
    sheets.edit({
      locked_fields: sheet.locked_fields.includes(field)
        ? sheet.locked_fields.filter((f) => f !== field)
        : [...sheet.locked_fields, field],
    });
  const isLockable = (field: CharacterSheetField): field is CharacterSheetLockField =>
    (CHARACTER_SHEET_LOCKABLE_FIELDS as readonly string[]).includes(field);
  const sceneFieldLabel = (field: CharacterSheetField) =>
    t(`design.${field === "expression_memo" ? "expressionMemo" : field}`);
  const diffFieldLabel = (f: string) =>
    f === "placed_views"
      ? t("design.fieldPlacedViews")
      : f === "locked_fields"
        ? t("design.fieldLocks")
        : sceneFieldLabel(f as CharacterSheetField);
  const diffValue = (sheet2: typeof sheet, f: string) => {
    const v = sheet2[f as keyof typeof sheet2];
    const text = Array.isArray(v) ? v.join(", ") : String(v);
    return text || "—";
  };

  return (
    <section className="design-panel" aria-label={t("design.sharedMaterialsAria")}>
      <div className="design-heading">
        <div><span className="design-eyebrow">{t("design.eyebrow")}</span><h2>{t("design.title")}</h2></div>
        <MockMark />
      </div>
      <p className="design-intro">{t("design.intro")}</p>
      <div className="design-tabs" role="tablist" aria-label={t("design.sharedSetupTabs")}>
        {tabs.map((item) => <button key={item.key} role="tab" aria-selected={tab === item.key} className={tab === item.key ? "active" : ""} onClick={() => setTab(item.key)}><Icon name={item.icon} />{t(`design.${item.key}`)}</button>)}
      </div>

      {tab === "character" && <div className="design-view pane-swap">
        <div className="design-section-title"><div><strong>{t("design.characterSheet")}</strong><small>{t("design.characterReuse")}</small></div><button className="design-mini" type="button" disabled={sheets.busy} onClick={() => { sheets.createSheet(t("design.newCharacter", { count: newSheetCount + 1 })); setSelectedView("front"); }}>{t("design.newSheet")}</button></div>
        {sheets.entries.length === 0 ? (
          <p className="muted">{t("design.sheetEmpty")}</p>
        ) : (
          <>
            <label className="design-label">{t("design.selectCharacter")}<select value={selKey} onChange={(e) => sheets.select(e.target.value)} disabled={sheets.busy}>{sheets.entries.map((e) => <option key={e.key} value={e.key}>{e.name}{e.isNew ? ` (${t("design.sheetUnsavedMark")})` : ""}</option>)}</select></label>
            {entry && <label className="design-label">{t("design.characterName")}<input value={sheets.nameDraft} onChange={(e) => sheets.setName(e.target.value)} disabled={sheets.busy} /></label>}
            <div className="sheet-board">
              <label className="sheet-reference">{sheets.pendingImage ? <img className="sheet-reference-img" src={sheets.pendingImage.dataUrl} alt={t("design.baseImage")} /> : entry?.baseImageAssetId ? <img className="sheet-reference-img" src={assetUrl(entry.baseImageAssetId)} alt={t("design.baseImage")} /> : <Avatar />}<b>{t("design.baseImage")}</b><small>{sheets.pendingImage ? t("design.imageUnsaved") : entry?.baseImageAssetId ? t("design.baseImageManaged") : t("design.chooseImage")}</small><input type="file" accept="image/*" style={{ display: "none" }} disabled={sheets.busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) sheets.setImage(f); e.target.value = ""; }} /></label>
              {sheets.pendingImage && <button type="button" className="design-mini" disabled={sheets.busy} onClick={sheets.clearImage}>{t("design.clearImage")}</button>}
              <div className="sheet-views">{CHARACTER_SHEET_VIEWS.map((v, i) => <button type="button" key={v} disabled={sheets.busy} className={selectedView === v ? "selected" : ""} onClick={() => { setSelectedView(v); sheets.edit({ placed_views: sheet.placed_views.includes(v) ? sheet.placed_views.filter((item) => item !== v) : [...sheet.placed_views, v] }); }}><Avatar variant={i === 1 ? "profile" : i === 2 ? "back" : i === 3 ? "smile" : "front"} color={i === 3 ? "#d7ad69" : "#eea98b"}/><b>{t(`design.${v}`)}</b><small>{sheet.placed_views.includes(v) ? t("design.removeImage") : i === 3 ? t("design.expressionsHint") : t("design.placeImage")}</small></button>)}</div>
            </div>
            <div className="design-edit-grid">
              {CHARACTER_SHEET_FIELDS.map((f) => {
                const lockable = isLockable(f);
                const locked = lockable && sheet.locked_fields.includes(f);
                return (
                  <div className="design-field" key={f}>
                    <label className="design-label">{sceneFieldLabel(f)}<input value={sheet[f]} disabled={sheets.busy} onChange={(e) => sheets.edit({ [f]: e.target.value })} /></label>
                    {lockable && <button type="button" className={`pin-toggle field-lock${locked ? " on" : ""}`} aria-pressed={locked} disabled={sheets.busy} title={locked ? t("design.unlockField") : t("design.lockField")} onClick={() => toggleFieldLock(f)}><Icon name={locked ? "lock" : "unlock"} /></button>}
                  </div>
                );
              })}
            </div>
            {sheets.saveFailure === "conflict" && entry && (
              <div className="conflict-box">
                <p className="conflict-title">{t("design.conflictPrompt")}</p>
                <ul className="conflict-diff">
                  {sheetDiffFields(sheet, entry.saved).map((f) => (
                    <li key={f}>
                      <b>{diffFieldLabel(f)}</b>
                      <span><i>{t("design.latestValue")}</i>{diffValue(entry.saved, f)}</span>
                      <span><i>{t("design.draftValue")}</i>{diffValue(sheet, f)}</span>
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <button type="button" disabled={sheets.busy} onClick={sheets.discardDraft}>{t("design.useLatest")}</button>
                  <button type="button" className="primary" disabled={sheets.busy} onClick={sheets.save}>{sheets.busy ? t("design.sheetSaving") : t("design.overwriteDraft")}</button>
                </div>
              </div>
            )}
            <div className="row design-actions">
              {sheets.saveFailure !== "conflict" && <button type="button" className="primary" disabled={sheets.busy || !sheets.dirty || !sheets.nameDraft.trim()} onClick={sheets.save}>{sheets.busy ? t("design.sheetSaving") : t("design.saveSheet")}</button>}
              {entry && !entry.isNew && entry.pinnedRevisionId && <span className="badge adopted">{t("characters.inUse")}</span>}
              {sheetFailure && <span className="badge stale">{sheetFailure}</span>}
              <span className="muted">{sheetStatus}</span>
            </div>
          </>
        )}
        {entry && !entry.isNew && libraryView && (
          <details className="character-advanced">
            <summary className="muted">{t("characters.advancedTitle")}</summary>
            <CharacterCard
              view={libraryView}
              projectId={props.state.project.id}
              pinnedRevisionId={entry.pinnedRevisionId}
              pinVersion={pinVersion}
              onChanged={async () => {
                await sheets.reloadLibrary();
                await props.onChanged();
              }}
              onError={props.onError}
            />
          </details>
        )}
        <div className="design-note">{t("design.characterMockNote")}</div>
      </div>}

      {tab === "scene" && <div className="design-view pane-swap">
        <div className="design-section-title"><div><strong>{t("design.sceneTitle")}</strong><small>{t("design.sceneIntro")}</small></div><button type="button" className={`pin-toggle${bg.locked ? " on" : ""}`} aria-pressed={bg.locked} disabled={bg.busy} onClick={() => bg.setLocked(!bg.locked)}><Icon name={bg.locked ? "lock" : "unlock"} />{bg.locked ? t("design.unlockBackground") : t("design.lockBackground")}</button></div>
        <div className="scene-list">{backdrops.map((b) => <button key={b.key} disabled={bg.locked || bg.busy} className={`scene-card${bg.backdropKey === b.key ? " selected" : ""}`} onClick={() => bg.select(b.key)}><span className="scene-art" style={{ "--scene-color": b.color } as React.CSSProperties}><Icon name={b.icon} /><b>{t(b.nameKey)}</b></span><span className="scene-meta"><b>{t(b.nameKey)}</b><small>{t(b.typeKey)}</small></span>{bg.backdropKey === b.key && <span className="scene-check">✓</span>}</button>)}</div>
        <div className="scene-separation"><span className="scene-chip"><small>{t("design.character")}</small><b>{characterLabel}</b></span><span className="scene-plus">＋</span><span className="scene-chip"><small>{t("design.scene")}</small><b>{t(backdrops[sceneIndex].nameKey)}{bg.locked ? ` · ${t("design.locked")}` : ""}</b></span></div>
        <div className="scene-cuts"><b>{t("design.sceneUseCuts")}</b><span>01 {t("design.cutOpening")} <i>{t("design.sameSetting")}</i></span><span>02 {t("design.cutMeeting")} <i>{t("design.sameSetting")}</i></span><span>03 {t("design.cutAfterglow")} <i>{t("design.sameSetting")}</i></span></div>
        <div className="row design-actions">
          {bg.saveFailure === "conflict" ? (
            <>
              <button type="button" disabled={bg.busy} onClick={bg.discardDraft}>{t("design.useLatest")}</button>
              <button type="button" className="primary" disabled={bg.busy} onClick={bg.save}>{bg.busy ? t("design.sceneSaving") : t("design.overwriteDraft")}</button>
              <span className="badge stale">{t("design.sceneConflict")}</span>
            </>
          ) : (
            <>
              <button type="button" className="primary" disabled={bg.busy || !bg.dirty} onClick={bg.save}>{bg.busy ? t("design.sceneSaving") : bg.saveFailure === "failed" ? t("design.retrySave") : t("design.sceneSave")}</button>
              {bg.saveFailure === "failed" && <span className="badge stale">{t("design.sceneSaveFailed")}</span>}
            </>
          )}
          <span className="muted">{bg.dirty ? t("design.sceneUnsaved") : props.state.workbench_background ? t("design.sceneSaved") : ""}</span>
        </div>
        <div className="design-note">{t("design.sceneMockNote")}</div>
      </div>}

      {tab === "voice" && <div className="design-view pane-swap">
        <div className="design-section-title"><div><strong>{t("design.voiceTitle")}</strong><small>{t("design.voiceIntro")}</small></div><button type="button" className={`pin-toggle${voicePinned ? " on" : ""}`} aria-pressed={voicePinned} onClick={() => setVoicePinnedByCharacter((old) => ({ ...old, [selKey]: !voicePinned }))}><Icon name={voicePinned ? "lock" : "unlock"} />{voicePinned ? t("design.unlockVoice") : t("design.lockVoice")}</button></div>
        <label className="design-label">{t("design.selectCharacter")}<select value={selKey} onChange={(e) => sheets.select(e.target.value)}>{sheets.entries.map((e) => <option key={e.key} value={e.key}>{e.name}{e.isNew ? ` (${t("design.sheetUnsavedMark")})` : ""}</option>)}</select></label>
        <div className="voice-card"><span className="voice-symbol"><Icon name="voice" /></span><span><b>{t(`design.voice.${voice}`)}</b><small>{t("design.voicePreset")} · {t("design.mockSetting")}</small></span><button type="button" aria-label={t("design.voiceSwap")} disabled={voicePinned} onClick={() => setVoice((current) => current === "mid" ? "low" : current === "low" ? "high" : "mid")}>{t("design.voiceSwap")}</button></div>
        <div className="voice-play"><button type="button" className="voice-audition" disabled title={t("design.audioUnconnected")}><Icon name="play" />{t("design.audition")}</button><span><i />{t("design.audioUnconnected")}</span></div>
        <label className="design-label">{t("design.emotion")}<select value={emotion} onChange={(e) => setEmotionByCharacter((old) => ({ ...old, [selKey]: e.target.value }))}><option value="gentle">{t("design.emotion.gentle")}</option><option value="happy">{t("design.emotion.happy")}</option><option value="resolve">{t("design.emotion.resolve")}</option><option value="surprised">{t("design.emotion.surprised")}</option></select></label>
        <label className="design-label range-label">{t("design.speed")} <b>{speed.toFixed(1)}×</b><input type="range" min="0.7" max="1.3" step="0.1" value={speed} onChange={(e) => setSpeedByCharacter((old) => ({ ...old, [selKey]: Number(e.target.value) }))}/></label>
        <div className="design-note">{t("design.voiceMockNote")}</div>
      </div>}

      {tab === "template" && <div className="design-view pane-swap">
        <div className="design-section-title"><div><strong>{t("design.templateTitle")}</strong><small>{t("design.templateCurrentMode", { mode: t(`design.modes.${mode}`) })}</small></div><MockMark /></div>
        <p className="template-separation">{t("design.templateDistinct")}</p>
        <div className="template-list">{["story", "mv", "character"].map((item, i) => <button key={item} className={`template-card${template === item ? " selected" : ""}`} onClick={() => setTemplate(item)}><span className={`template-art t${i}`}><Icon name={item === "story" ? "story" : item === "mv" ? "music" : "character"} /></span><span><b>{t(`design.template.${item}`)}</b><small>{t(`design.template.${item}Note`)}</small></span>{template === item && <span className="scene-check">✓</span>}</button>)}</div>
        <div className="template-inherits"><b>{t("design.inherit")}</b><div><span><Icon name="character" />{characterLabel}</span><span><Icon name="landscape" />{t(backdrops[sceneIndex].nameKey)}</span><span><Icon name="voice" />{t("design.voiceTitle")}</span><span><Icon name="template" />{t(`design.template.${template}`)}</span></div></div>
        <label className="design-label">{t("design.templateName")}<input value={templateName} onChange={(e) => setTemplateName(e.target.value)} /></label>
        <div className="row design-actions"><button type="button" className="primary" onClick={() => setSaved((old) => old.includes(templateName.trim()) || !templateName.trim() ? old : [...old, templateName.trim()])}>{t("design.savePersonal")}</button><span className="muted">{t("design.templateEditHint")}</span></div>
        {saved.length > 0 && <div className="saved-template">{t("design.savedHere", { names: saved.join(t("workbenchDesign.text")) })}</div>}
        <div className="design-note">{t("design.templateMockNote")}</div>
      </div>}
    </section>
  );
}
