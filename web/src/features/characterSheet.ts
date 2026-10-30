import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHARACTER_SHEET_FIELDS,
  CHARACTER_SHEET_LOCKABLE_FIELDS,
  CHARACTER_SHEET_VIEWS,
  type CharacterRevision,
  type CharacterSheet,
  type CharacterSheetLockField,
  type CharacterSheetView,
  type CharacterView,
  type ProjectState,
} from "@vo/shared";
import { api } from "../api/client.ts";

export function emptySheet(): CharacterSheet {
  return {
    persona: "",
    appearance: "",
    outfit: "",
    traits: "",
    colors: "",
    expression_memo: "",
    placed_views: [],
    locked_fields: [],
  };
}

/** Read the sheet payload out of a revision's profile JSON. Revisions
 *  written before sheets existed (or written by hand) simply have no
 *  `sheet` key — they read as an empty sheet, never as broken data. */
export function sheetFromRevision(
  rev: CharacterRevision | null | undefined,
): CharacterSheet {
  if (!rev) return emptySheet();
  try {
    const profile = JSON.parse(rev.profile) as {
      persona?: unknown;
      appearance?: unknown;
      sheet?: Record<string, unknown>;
    };
    const s = profile?.sheet;
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    // Revisions written before sheets existed keep persona/appearance
    // at the profile top level — fall back to them so a re-save never
    // silently drops text the user once entered.
    const legacyPersona = text(profile.persona);
    const legacyAppearance = text(profile.appearance);
    if (typeof s !== "object" || s === null) {
      if (!legacyPersona && !legacyAppearance) return emptySheet();
      return {
        ...emptySheet(),
        persona: legacyPersona,
        appearance: legacyAppearance,
      };
    }
    const views = Array.isArray(s.placed_views) ? s.placed_views : [];
    const locks = Array.isArray(s.locked_fields) ? s.locked_fields : [];
    return {
      persona: text(s.persona) || legacyPersona,
      appearance: text(s.appearance) || legacyAppearance,
      outfit: text(s.outfit),
      traits: text(s.traits),
      colors: text(s.colors),
      expression_memo: text(s.expression_memo),
      placed_views: views.filter(
        (v): v is CharacterSheetView =>
          typeof v === "string" &&
          (CHARACTER_SHEET_VIEWS as readonly string[]).includes(v),
      ),
      locked_fields: locks.filter(
        (v): v is CharacterSheetLockField =>
          typeof v === "string" &&
          (CHARACTER_SHEET_LOCKABLE_FIELDS as readonly string[]).includes(v),
      ),
    };
  } catch {
    return emptySheet();
  }
}

/** Fields (text + placed_views) where two sheets differ — drives the
 *  conflict-review list so the user can inspect before overwriting. */
export function sheetDiffFields(
  draft: CharacterSheet,
  saved: CharacterSheet,
): string[] {
  const diff: string[] = CHARACTER_SHEET_FIELDS.filter(
    (f) => draft[f] !== saved[f],
  );
  if (
    draft.placed_views.length !== saved.placed_views.length ||
    draft.placed_views.some((v, i) => v !== saved.placed_views[i])
  ) {
    diff.push("placed_views");
  }
  if (
    draft.locked_fields.length !== saved.locked_fields.length ||
    draft.locked_fields.some((v, i) => v !== saved.locked_fields[i])
  ) {
    diff.push("locked_fields");
  }
  return diff;
}

export function sheetsEqual(a: CharacterSheet, b: CharacterSheet): boolean {
  return (
    a.persona === b.persona &&
    a.appearance === b.appearance &&
    a.outfit === b.outfit &&
    a.traits === b.traits &&
    a.colors === b.colors &&
    a.expression_memo === b.expression_memo &&
    a.placed_views.length === b.placed_views.length &&
    a.placed_views.every((v, i) => v === b.placed_views[i]) &&
    a.locked_fields.length === b.locked_fields.length &&
    a.locked_fields.every((v, i) => v === b.locked_fields[i])
  );
}

/** The revision a work sees: its own pin when the character is pinned
 *  here, else the latest library revision. Pinned-but-missing falls
 *  back to latest rather than showing nothing. */
export function displayRevision(
  view: CharacterView,
  pinnedRevisionId: string | null,
): CharacterRevision | null {
  if (pinnedRevisionId) {
    const pinned = view.revisions.find((r) => r.id === pinnedRevisionId);
    if (pinned) return pinned;
  }
  return view.revisions[view.revisions.length - 1] ?? null;
}

/** One row in the sheet selector — a library character, or a local
 *  "new sheet" draft that only reaches the server on explicit save. */
export interface CharacterSheetEntry {
  key: string;
  characterId: string | null;
  name: string;
  /** revision this work pins, if the character is pinned here */
  pinnedRevisionId: string | null;
  /** revision the displayed sheet was loaded from */
  baseRevisionId: string | null;
  baseRevNo: number | null;
  baseImageAssetId: string | null;
  /** last persisted sheet contents (empty for new drafts) */
  saved: CharacterSheet;
  isNew: boolean;
}

/** A base image picked for the next save — preview only until the
 *  sheet is saved, at which point the file uploads and lands on the
 *  new revision. */
export interface PendingImage {
  dataUrl: string;
  base64: string;
  name: string;
  mime: string;
}

export type SheetSaveFailure = "failed" | "conflict";

/**
 * Drafts survive the full studio remount a project switch triggers
 * (`key={project.id}` in App.tsx) — they live in this project-keyed
 * module store and the hook mirrors it through React state.
 */
interface SheetMemory {
  drafts: Record<string, CharacterSheet>;
  /** name drafts for EXISTING characters — saved as a rename inside
   *  the sheet save (new sheets use newEntries[].name instead) */
  names: Record<string, string>;
  images: Record<string, PendingImage>;
  failures: Record<string, SheetSaveFailure>;
  newEntries: { key: string; name: string; createdId?: string }[];
  newCount: number;
  selected: string | null;
}
const sheetMemory = new Map<string, SheetMemory>();
const emptyMemory = (): SheetMemory => ({
  drafts: {},
  names: {},
  images: {},
  failures: {},
  newEntries: [],
  newCount: 0,
  selected: null,
});

export interface WorkbenchCharacterSheets {
  /** the shared character library as last fetched — lets the sheet
   *  surface the raw revision/pin editor for the selected character */
  library: CharacterView[];
  /** re-fetch the shared character library (after revision/pin edits) */
  reloadLibrary: () => Promise<void>;
  entries: CharacterSheetEntry[];
  selected: string | null;
  select: (key: string) => void;
  entry: CharacterSheetEntry | null;
  /** displayed sheet — the unsaved draft when present, else `saved` */
  sheet: CharacterSheet;
  /** displayed name — the draft rename when present, else the entry name */
  nameDraft: string;
  dirty: boolean;
  busy: boolean;
  libraryFailed: boolean;
  /** why the last save of the selected draft was rejected, if any */
  saveFailure: SheetSaveFailure | null;
  /** base image picked but not yet saved, if any */
  pendingImage: PendingImage | null;
  edit: (patch: Partial<CharacterSheet>) => void;
  setName: (name: string) => void;
  setImage: (file: File) => void;
  clearImage: () => void;
  createSheet: (defaultName: string) => void;
  renameNew: (name: string) => void;
  save: () => void;
  /** drop the selected draft and take the latest persisted sheet */
  discardDraft: () => void;
}

/**
 * Connection seam between the workbench character tab and the server:
 * owns the library fetch, per-character draft state and the explicit
 * save request. The display component only renders what this returns.
 * Unsaved drafts live in memory only — a save is the single write.
 */
export function useWorkbenchCharacterSheets(
  state: ProjectState,
  onChanged: () => Promise<void>,
  onError: (e: unknown) => void,
): WorkbenchCharacterSheets {
  const [library, setLibrary] = useState<CharacterView[]>([]);
  const [libraryFailed, setLibraryFailed] = useState(false);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const pid = state.project.id;
  if (!sheetMemory.has(pid)) sheetMemory.set(pid, emptyMemory());
  const [, bump] = useState(0);
  const setMem = useCallback(
    (mut: (m: SheetMemory) => SheetMemory | void) => {
      const m = sheetMemory.get(pid) ?? emptyMemory();
      sheetMemory.set(pid, mut(m) ?? m);
      bump((n) => n + 1);
    },
    [pid],
  );
  const { drafts, names, images, failures, newEntries, newCount, selected } =
    sheetMemory.get(pid) ?? emptyMemory();
  const setSelected = useCallback(
    (v: string | null) => setMem((m) => ({ ...m, selected: v })),
    [setMem],
  );
  const [busy, setBusy] = useState(false);
  // Latest-callback refs — the fetch effect must not refire just
  // because the parent re-rendered and recreated onError/onChanged.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const pins = useMemo(
    () =>
      new Map(
        state.characters.map((pc) => [
          pc.character_id,
          pc.character_revision_id,
        ]),
      ),
    [state.characters],
  );

  useEffect(() => {
    let alive = true;
    api
      .listCharacters()
      .then((list) => {
        if (alive) {
          setLibrary(list);
          setLibraryFailed(false);
          setLibraryLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) {
          setLibraryFailed(true);
          setLibraryLoaded(true);
        }
        onErrorRef.current(e);
      });
    return () => {
      alive = false;
    };
  }, [state.characters]);

  const entries = useMemo<CharacterSheetEntry[]>(
    () => [
      ...library.map((view) => {
        const pinned = pins.get(view.id) ?? null;
        const rev = displayRevision(view, pinned);
        return {
          key: view.id,
          characterId: view.id,
          name: view.name,
          pinnedRevisionId: pinned,
          baseRevisionId: rev?.id ?? null,
          baseRevNo: rev?.rev_no ?? null,
          baseImageAssetId: rev?.base_image_asset_id ?? null,
          saved: sheetFromRevision(rev),
          isNew: false,
        };
      }),
      ...newEntries.map((n) => ({
        key: n.key,
        // a pre-created character (base image upload needed the owner)
        // is still an unsaved new sheet until the save lands
        characterId: n.createdId ?? null,
        name: n.name,
        pinnedRevisionId: null,
        baseRevisionId: null,
        baseRevNo: null,
        baseImageAssetId: null,
        saved: emptySheet(),
        isNew: true,
      })),
    ],
    [library, pins, newEntries],
  );

  const selectedKey =
    selected && entries.some((e) => e.key === selected)
      ? selected
      : (entries[0]?.key ?? null);
  const entry = entries.find((e) => e.key === selectedKey) ?? null;
  const sheet = (selectedKey && drafts[selectedKey]) || entry?.saved || emptySheet();
  const nameDraft =
    (selectedKey && !entry?.isNew && names[selectedKey] !== undefined
      ? names[selectedKey]
      : null) ??
    entry?.name ??
    "";
  const dirty =
    !!entry &&
    (entry.isNew ||
      (!!drafts[entry.key] && !sheetsEqual(drafts[entry.key], entry.saved)) ||
      (names[entry.key] !== undefined && names[entry.key] !== entry.name) ||
      !!images[entry.key]);

  const edit = useCallback(
    (patch: Partial<CharacterSheet>) => {
      if (!entry) return;
      const key = entry.key;
      setMem((m) => ({
        ...m,
        drafts: {
          ...m.drafts,
          [key]: { ...(m.drafts[key] ?? entry.saved), ...patch },
        },
      }));
    },
    [entry, setMem],
  );

  const createSheet = useCallback(
    (defaultName: string) => {
      const key = `new-${newCount + 1}`;
      setMem((m) => ({
        ...m,
        newCount: m.newCount + 1,
        newEntries: [...m.newEntries, { key, name: defaultName }],
        selected: key,
      }));
    },
    [newCount, setMem],
  );

  const renameNew = useCallback(
    (name: string) => {
      if (!entry?.isNew) return;
      const key = entry.key;
      setMem((m) => ({
        ...m,
        newEntries: m.newEntries.map((n) =>
          n.key === key ? { ...n, name } : n,
        ),
      }));
    },
    [entry, setMem],
  );

  const setName = useCallback(
    (name: string) => {
      if (!entry) return;
      if (entry.isNew) {
        renameNew(name);
        return;
      }
      const key = entry.key;
      setMem((m) => ({
        ...m,
        names: { ...m.names, [key]: name },
      }));
    },
    [entry, setMem, renameNew],
  );

  const setImage = useCallback(
    (file: File) => {
      if (!entry) return;
      const key = entry.key;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        setMem((m) => ({
          ...m,
          images: {
            ...m.images,
            [key]: {
              dataUrl: result,
              base64: result.split(",")[1] ?? "",
              name: file.name,
              mime: file.type,
            },
          },
        }));
      };
      reader.readAsDataURL(file);
    },
    [entry, setMem],
  );

  const clearImage = useCallback(() => {
    if (!entry) return;
    const key = entry.key;
    setMem((m) => {
      const { [key]: _i, ...images } = m.images;
      return { ...m, images };
    });
  }, [entry, setMem]);

  const discardDraft = useCallback(() => {
    if (!entry) return;
    const key = entry.key;
    setMem((m) => {
      const { [key]: _d, ...drafts } = m.drafts;
      const { [key]: _f, ...failures } = m.failures;
      const { [key]: _n, ...names } = m.names;
      const { [key]: _i, ...images } = m.images;
      return {
        ...m,
        drafts,
        failures,
        names,
        images,
        // a discarded NEW sheet disappears entirely (a character
        // pre-created for an image upload stays in the library — it
        // is real persisted data, not draft state)
        newEntries: entry.isNew
          ? m.newEntries.filter((n) => n.key !== key)
          : m.newEntries,
        selected: entry.isNew ? null : m.selected,
      };
    });
  }, [entry, setMem]);

  // Keep the module memory honest: drafts/failures whose character is
  // no longer a known entry (deleted elsewhere, merged, ...) are
  // pruned — but only after the library answered, so a remount's
  // empty-until-fetched view can't wipe live drafts.
  useEffect(() => {
    if (!libraryLoaded) return;
    const valid = new Set(entries.map((e) => e.key));
    setMem((m) => {
      const keep = <V>(rec: Record<string, V>): Record<string, V> => {
        const next: Record<string, V> = {};
        for (const [k, v] of Object.entries(rec)) {
          if (valid.has(k)) next[k] = v;
        }
        return Object.keys(next).length === Object.keys(rec).length
          ? rec
          : next;
      };
      const drafts = keep(m.drafts);
      const failures = keep(m.failures);
      const names = keep(m.names);
      const images = keep(m.images);
      if (
        drafts === m.drafts &&
        failures === m.failures &&
        names === m.names &&
        images === m.images
      )
        return m;
      return { ...m, drafts, failures, names, images };
    });
  }, [libraryLoaded, entries, setMem]);

  const save = useCallback(() => {
    if (!entry || busy) return;
    const current = drafts[entry.key] ?? entry.saved;
    const image = images[entry.key];
    const draftName = entry.isNew
      ? entry.name
      : (names[entry.key] ?? entry.name);
    const key = entry.key;
    setBusy(true);
    (async () => {
      let characterId = entry.characterId;
      // A pending base image needs an existing owner — for a brand-new
      // sheet the character is created first so the upload can carry
      // owner_kind=character (project assets never serve as base images).
      if (image && !characterId) {
        const created = await api.createCharacter(draftName.trim());
        characterId = created.id;
        // Record it so a failed save retries against the SAME character
        // instead of creating library duplicates.
        setMem((m) => ({
          ...m,
          newEntries: m.newEntries.map((n) =>
            n.key === key ? { ...n, createdId: created.id } : n,
          ),
        }));
      }
      let baseImageAssetId: string | undefined;
      if (image) {
        const asset = await api.uploadAsset(
          "character",
          characterId!,
          "image",
          image.name,
          image.base64,
          image.mime,
        );
        baseImageAssetId = asset.id;
      }
      const nameChanged =
        !entry.isNew &&
        names[entry.key] !== undefined &&
        draftName.trim() !== entry.name;
      return api.saveCharacterSheet(state.project.id, {
        character_id: characterId ?? undefined,
        // new sheets pass their name (create), renamed existing ones
        // pass the draft (rename inside the save), pre-created ones
        // pass it too (rename to the latest draft, no-op if unchanged)
        name:
          entry.isNew || nameChanged ? draftName.trim() || undefined : undefined,
        sheet: current,
        base_revision_id: entry.baseRevisionId ?? undefined,
        base_image_asset_id: baseImageAssetId,
        expected_revision_id: entry.pinnedRevisionId,
      });
    })()
      .then(async (res) => {
        // The server is now the source of truth: fold the saved
        // character into the library, drop the local draft, and let
        // the project-state refresh publish the moved pin.
        setLibrary((old) => [
          ...old.filter((c) => c.id !== res.character.id),
          res.character,
        ]);
        setMem((m) => {
          const { [key]: _d, ...drafts } = m.drafts;
          const { [key]: _f, ...failures } = m.failures;
          const { [key]: _n, ...names } = m.names;
          const { [key]: _i, ...images } = m.images;
          return {
            ...m,
            drafts,
            failures,
            names,
            images,
            newEntries: entry.isNew
              ? m.newEntries.filter((n) => n.key !== key)
              : m.newEntries,
            selected: entry.isNew ? res.character.id : m.selected,
          };
        });
        await onChanged();
      })
      .catch((e) => {
        // Keep the draft and mark why it was rejected — the user can
        // inspect, edit, or retry. 409 means the server state moved
        // while the user was editing; the draft still wins locally
        // until they save again or refresh.
        setMem((m) => ({
          ...m,
          failures: {
            ...m.failures,
            [key]:
              (e as { status?: number })?.status === 409
                ? "conflict"
                : "failed",
          },
        }));
        onErrorRef.current(e);
      })
      .finally(() => setBusy(false));
  }, [entry, drafts, names, images, busy, state.project.id, onChanged, setMem]);

  const reloadLibrary = useCallback(async () => {
    try {
      const list = await api.listCharacters();
      setLibrary(list);
      setLibraryFailed(false);
      setLibraryLoaded(true);
    } catch (e) {
      setLibraryFailed(true);
      setLibraryLoaded(true);
      onErrorRef.current(e);
      throw e;
    }
  }, []);

  return {
    library,
    reloadLibrary,
    entries,
    selected: selectedKey,
    select: setSelected,
    entry,
    sheet,
    nameDraft,
    dirty,
    busy,
    libraryFailed,
    saveFailure: (selectedKey && failures[selectedKey]) || null,
    pendingImage: (selectedKey && images[selectedKey]) || null,
    edit,
    setName,
    setImage,
    clearImage,
    createSheet,
    renameNew,
    save,
    discardDraft,
  };
}
