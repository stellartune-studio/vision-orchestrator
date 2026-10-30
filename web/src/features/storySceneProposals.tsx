import { useEffect, useRef, useState } from "react";
import type { CharacterView, DocumentView, ItemView, ProjectCharacter, ProjectState } from "@vo/shared";
import { api } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import { storyScenes } from "./storyScenes.ts";
import { StoryboardGeneration } from "./storyboardGeneration.tsx";
import { SceneEditSource } from "./sceneEditSource.tsx";

function SceneProposal(props: { item: ItemView; state: ProjectState; projectId: string; scripts: DocumentView[]; pins: ProjectCharacter[]; characterViews: CharacterView[]; onChanged: () => Promise<void>; onError: (error: unknown) => void; onMove: (direction: -1 | 1) => void; canMoveUp: boolean; canMoveDown: boolean; moving: boolean }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [scriptId, setScriptId] = useState("");
  const [dialogue, setDialogue] = useState("");
  const [selectedCharacters, setSelectedCharacters] = useState<string[]>([]);
  const [castLoaded, setCastLoaded] = useState(false);
  const [castProposals, setCastProposals] = useState<{ revision_id: string; content: string; characters: { name: string }[] }[]>([]);
  useEffect(() => {
    let active = true;
    setCastLoaded(false);
    void fetch(`/api/projects/${encodeURIComponent(props.projectId)}/story-scenes/${encodeURIComponent(props.item.id)}/characters`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not read scene characters");
        const result = await response.json() as { revision_id: string | null; characters: { character_id: string }[]; proposals: { revision_id: string; content: string; characters: { name: string }[] }[] };
        if (active && result.revision_id === props.item.adopted_revision_id) { setSelectedCharacters(result.characters.map((c) => c.character_id)); setCastProposals(result.proposals); setCastLoaded(true); }
      }).catch((error) => { if (active) props.onError(error); });
    return () => { active = false; };
  }, [props.projectId, props.item.id, props.item.adopted_revision_id, props.item.revisions.length, props.item.state_version]);
  const submit = async () => {
    if (!draft.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.addRevision(props.item.id, draft.trim());
      setDraft("");
      await props.onChanged();
    } catch (error) { props.onError(error); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <section className="item">
    <strong>{props.item.label}</strong>
    <SceneEditSource scene={props.item} state={props.state} onChanged={props.onChanged} onError={props.onError} />
    <div className="row">
      <button disabled={props.moving || !props.canMoveUp} onClick={() => props.onMove(-1)}>{t("storyScenes.moveUp")}</button>
      <button disabled={props.moving || !props.canMoveDown} onClick={() => props.onMove(1)}>{t("storyScenes.moveDown")}</button>
    </div>
    <p className="muted small">{props.item.adopted_revision?.content ?? (t("storyScenes.notAdopted"))}</p>
    <label>{t("storyScenes.newSceneProposal")}
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
    </label>
    <button disabled={busy || !draft.trim()} onClick={() => void submit()}>{t("storyScenes.saveUnapprovedProposal")}</button>
    <details>
      <summary>{t("storyScenes.charactersInThisScene")}</summary>
      <p className="muted small">{t("storyScenes.selectPinnedCharacterRevisionsAndSave")}</p>
      {props.pins.map((pin) => <label key={pin.character_id}>
        <input type="checkbox" checked={selectedCharacters.includes(pin.character_id)} onChange={(event) => setSelectedCharacters((current) => event.target.checked ? [...current, pin.character_id] : current.filter((id) => id !== pin.character_id))} />
        {props.characterViews.find((character) => character.id === pin.character_id)?.name ?? pin.character_id}
      </label>)}
      {!props.pins.length && <p>{t("storyScenes.pinCharactersToThisWorkFirst")}</p>}
      {castProposals.map((proposal) => <p key={proposal.revision_id}>
        {t("storyScenes.unapprovedCast")}{proposal.characters.map((c) => c.name).join(", ") || (t("storyScenes.none"))}{" "}
        <span>{t("storyScenes.sceneContent")}{proposal.content}</span>{" "}
        <button disabled={busy} onClick={() => {
          if (busyRef.current) return;
          busyRef.current = true; setBusy(true);
          void api.adopt(props.item.id, proposal.revision_id, props.item.state_version).then(() => props.onChanged()).catch(props.onError).finally(() => { busyRef.current = false; setBusy(false); });
        }}>{t("storyScenes.adoptThisCast")}</button>
      </p>)}
      {selectedCharacters.some((id) => !props.pins.some((pin) => pin.character_id === id)) && <p>{t("storyScenes.anAdoptedCharacterIsNoLonger")}</p>}
      <button disabled={busy || !castLoaded || !props.item.adopted_revision_id || selectedCharacters.some((id) => !props.pins.some((pin) => pin.character_id === id))} onClick={() => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true);
        const characters = props.pins.filter((pin) => selectedCharacters.includes(pin.character_id)).map((pin) => ({ character_id: pin.character_id, character_revision_id: pin.character_revision_id, pin_version: pin.pin_version }));
        void fetch(`/api/projects/${encodeURIComponent(props.projectId)}/story-scenes/${encodeURIComponent(props.item.id)}/character-proposals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_version: props.item.state_version, characters }) })
          .then(async (response) => { if (!response.ok) throw new Error(t("storyScenes.couldNotSaveTheCastProposal")); await props.onChanged(); })
          .catch(props.onError).finally(() => { busyRef.current = false; setBusy(false); });
      }}>{t("storyScenes.saveUnapprovedCastProposal")}</button>
    </details>
    <details>
      <summary>{t("storyScenes.proposeDialogueInAScript")}</summary>
      <p className="muted small">{t("storyScenes.createAnUnapprovedRevisionFromAn")}</p>
      <label>{t("storyScenes.baseScript")}<select value={scriptId} onChange={(event) => setScriptId(event.target.value)}>
        <option value="">—</option>{props.scripts.map((doc) => <option key={doc.id} value={doc.id}>{doc.title || doc.id.slice(0, 8)}</option>)}
      </select></label>
      <label>{t("storyScenes.dialogueOrNarration")}<textarea value={dialogue} onChange={(event) => setDialogue(event.target.value)} /></label>
      <button disabled={busy || !scriptId || !dialogue.trim()} onClick={() => {
        const doc = props.scripts.find((entry) => entry.id === scriptId);
        if (!doc?.adopted_revision_id || busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        void fetch(`/api/projects/${encodeURIComponent(props.projectId)}/story-scenes/${encodeURIComponent(props.item.id)}/dialogue-proposals`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ document_id: doc.id, base_revision_id: doc.adopted_revision_id, expected_version: doc.state_version, content: dialogue }),
        }).then(async (response) => {
          if (!response.ok) throw new Error(t("storyScenes.dialogueProposalCouldNotBeSaved"));
          setDialogue(""); await props.onChanged();
        }).catch(props.onError).finally(() => { busyRef.current = false; setBusy(false); });
      }}>{t("storyScenes.saveUnapprovedScriptRevision")}</button>
    </details>
  </section>;
}

export function StorySceneProposals(props: { state: ProjectState; onChanged: () => Promise<void>; onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const scenes = storyScenes(props.state.items);
  const scripts = props.state.documents.filter((doc) => doc.kind === "script" && doc.adopted_revision_id);
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (movingRef.current || target < 0 || target >= scenes.length) return;
    const next = [...scenes];
    [next[index], next[target]] = [next[target], next[index]];
    movingRef.current = true;
    setMoving(true);
    void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/story-scenes/order`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenes: next.map((scene) => ({ id: scene.id, expected_version: scene.state_version })) }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(t("storyScenes.sceneOrderCouldNotBeSaved"));
      await props.onChanged();
    }).catch(props.onError).finally(() => { movingRef.current = false; setMoving(false); });
  };
  return <section>
    <StoryboardGeneration state={props.state} onChanged={props.onChanged} onError={props.onError} />
    <p className="muted small">{t("storyScenes.savedScenesRemainProposalsUntilAdopted")}</p>
    {scenes.length ? scenes.map((item, index) => <SceneProposal key={item.id} item={item} state={props.state} projectId={props.state.project.id} scripts={scripts} pins={props.state.characters} characterViews={props.state.character_views} onChanged={props.onChanged} onError={props.onError} onMove={(direction) => move(index, direction)} canMoveUp={index > 0} canMoveDown={index < scenes.length - 1} moving={moving} />)
      : <p>{t("storyScenes.thereAreNoScenesYet")}</p>}
    <button disabled={adding || moving} onClick={() => {
      if (addingRef.current) return;
      addingRef.current = true;
      setAdding(true);
      void fetch(`/api/projects/${encodeURIComponent(props.state.project.id)}/story-scenes`, { method: "POST" })
        .then((response) => { if (!response.ok) throw new Error(`Scene creation failed (${response.status})`); return props.onChanged(); })
        .catch(props.onError).finally(() => { addingRef.current = false; setAdding(false); });
    }}>{t("storyScenes.addScene")}</button>
  </section>;
}
