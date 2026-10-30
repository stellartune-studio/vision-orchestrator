import { useState } from "react";
import type { CharacterProfile, CharacterView, ProjectState } from "@vo/shared";
import { api, assetUrl } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";

/** Revision/pin/JSON-profile editor for one library character. Embedded
 *  as the "advanced" section of the unified character sheet in
 *  workbench-design — the raw calls stay the same as the old library
 *  panel (pinCharacter, addCharacterRevision, uploadAsset). */
export function CharacterCard(props: {
  view: CharacterView;
  projectId: string;
  pinnedRevisionId: string | null;
  pinVersion: number | null;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useI18n();
  const { view } = props;
  const [pinConflict, setPinConflict] = useState<{ requested: string; latest?: { revision: string | null; version: number | null } } | null>(null);
  const choosePin = async (requested: string, expectedVersion: number | null) => {
    setBusy(true);
    try { await api.pinCharacter(props.projectId, view.id, requested, expectedVersion); setPinConflict(null); await props.onChanged(); }
    catch (e) { if ((e as { status?: number }).status === 409) setPinConflict({ requested }); else props.onError(e); }
    finally { setBusy(false); }
  };
  const [busy, setBusy] = useState(false);
  const [profileDraft, setProfileDraft] = useState(
    JSON.stringify(
      {
        persona: "",
        appearance: "",
        traits: { locked: { hair: "", outfit: "" }, changeable: {} },
      },
      null,
      2,
    ),
  );

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn()
      .then(props.onChanged)
      .catch(props.onError)
      .finally(() => setBusy(false));
  };

  const uploadImage = (file: File, revisionId: string) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      run(async () => {
        const asset = await api.uploadAsset(
          "character",
          view.id,
          "image",
          file.name,
          base64,
          file.type,
        );
        const current = view.revisions.find((r) => r.id === revisionId);
        const profile: CharacterProfile = current
          ? (JSON.parse(current.profile) as CharacterProfile)
          : {};
        // a base image is only ever attached via a NEW revision — the
        // previously approved reference is never silently replaced
        await api.addCharacterRevision(view.id, profile, asset.id);
      });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="item">
      <div className="item-head">
        <span className="item-label">{view.name}</span>
        {props.pinnedRevisionId && (
          <span className="badge adopted">{t("characters.inUse")}</span>
        )}
      </div>
      {pinConflict && <div role="alert">
        <p>{t("characters.anotherSaveConflictedYourSelectionAnd")}</p>
        <p>{t("characters.yourChoice")}: {pinConflict.requested} / {t("characters.current")}: {pinConflict.latest?.revision ?? "—"}</p>
        <button disabled={busy} onClick={() => void api.state(props.projectId).then((s) => { const p = s.characters.find((p) => p.character_id === view.id); setPinConflict({ requested: pinConflict.requested, latest: { revision: p?.character_revision_id ?? null, version: p?.pin_version ?? null } }); }).catch(props.onError)}>{t("characters.fetchLatestPinToCompare")}</button>
        <button disabled={busy || !pinConflict.latest} onClick={() => void choosePin(pinConflict.requested, pinConflict.latest!.version)}>{t("characters.chooseThisRevisionAfterComparison")}</button>
        <button onClick={() => setPinConflict(null)}>{t("characters.keepCurrentPin")}</button>
      </div>}
      {view.revisions.map((r) => {
        let profile: CharacterProfile = {};
        try {
          profile = JSON.parse(r.profile) as CharacterProfile;
        } catch {
          /* keep {} */
        }
        const locked = profile.traits?.locked ?? {};
        return (
          <div key={r.id} className="proposal">
            <div className="muted">
              {t("characters.revision", { version: r.rev_no })}
              {r.id === props.pinnedRevisionId && ` ← ${t("characters.inUse")}`}
            </div>
            {profile.persona && <p className="item-content">{profile.persona}</p>}
            {Object.entries(locked).map(([k, v]) => (
              <div key={k} className="muted">
                {t("characters.lockedTrait", { key: k })}: {v}
              </div>
            ))}
            {r.base_image_asset_id && (
              <img
                src={assetUrl(r.base_image_asset_id)}
                alt={t("characters.referenceImage")}
                style={{ maxWidth: 96, borderRadius: 4, marginTop: 4 }}
              />
            )}
            <div className="row">
              <button
                disabled={busy || r.id === props.pinnedRevisionId}
                onClick={() =>
                  void choosePin(r.id, props.pinVersion)
                }
              >
                {t("characters.useRevision")}
              </button>
              <label className="file-btn">
                {t("characters.addReferenceRevision")}
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadImage(f, r.id);
                  }}
                />
              </label>
            </div>
          </div>
        );
      })}
      <details>
        <summary className="muted">{t("characters.addRevisionJson")}</summary>
        <textarea
          value={profileDraft}
          onChange={(e) => setProfileDraft(e.target.value)}
          rows={8}
        />
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              JSON.parse(profileDraft); // throws → onError
              await api.addCharacterRevision(view.id, profileDraft);
            })
          }
        >
          {t("characters.saveRevision")}
        </button>
      </details>
    </div>
  );
}

/** Pointer panel: character editing lives in the unified character
 *  sheet (Shared design → Character). Kept reachable from the left
 *  "material" tab so the library entry point is discoverable, but the
 *  card/revision UI itself is only rendered inside the sheet. */
export function CharactersPanel(props: {
  state: ProjectState;
  onOpenCharacterDesign: () => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div className="pane-head">
        <h2>{t("characters.libraryTitle")}</h2>
        <p className="muted">
          {t("characters.libraryIntro")}
        </p>
      </div>
      <div className="item">
        <p className="muted small">{t("characters.movedToDesign")}</p>
        <button className="primary" onClick={props.onOpenCharacterDesign}>
          {t("characters.openCharacterSheet")}
        </button>
      </div>
      {props.state.characters.length > 0 && (
        <p className="muted small">
          {t("characters.pinnedCount", {
            count: props.state.characters.length,
          })}
        </p>
      )}
    </div>
  );
}
