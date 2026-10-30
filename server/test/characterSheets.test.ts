import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import { MockGenerationBackend } from "../src/gen/mockBackend.ts";
import type { ServerConfig } from "../src/config.ts";

const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");

let dir: string;
let server: Server;
let base: string;
let db: ReturnType<typeof openDatabase>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "vo-sheets-"));
  db = openDatabase(join(dir, "app.db"));
  migrate(db, MIGRATIONS);
  const config: ServerConfig = {
    port: 0,
    data_dir: dir,
    db_path: join(dir, "app.db"),
    assets_root: join(dir, "assets"),
    llm_provider: "mock",
    gen_backend: "mock",
    workflow_file: "",
    max_body_bytes: 32 * 1024 * 1024,
  };
  const router = buildRouter({
    db,
    config,
    llm: new MockDirectorProvider(),
    gen: new MockGenerationBackend(config.assets_root),
  });
  server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  db.close();
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

const api = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

const newProject = async (name: string) => {
  const res = await api("POST", "/api/projects", { name });
  assert.equal(res.status, 201);
  return res.json.id as string;
};

const SHEET = {
  persona: "quiet apprentice mage who stargazes",
  appearance: "short silver hair, round glasses",
  outfit: "navy short coat",
  traits: "silver hairpin, star earrings",
  colors: "night navy / moon white",
  expression_memo: "calm eyes, soft cheeks when smiling",
  placed_views: ["front", "expressions"],
  // only explicitly fixed fields reach traits.locked — the memo is
  // deliberately left editable
  locked_fields: ["outfit", "traits", "colors"],
};

test("sheet save: new character → revision + pin; resave → new rev, pin moves", async () => {
  const pid = await newProject("sheet-save-basic");

  // first save creates the character, rev #1 and the pin atomically
  const first = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "ミナ",
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.character.name, "ミナ");
  assert.equal(first.json.revision.rev_no, 1);
  assert.equal(
    first.json.pin.character_revision_id,
    first.json.revision.id,
  );

  // the profile stores the sheet verbatim AND mirrors only the
  // explicitly fixed fields into traits.locked — the unfixed
  // expression memo never becomes a fixed condition
  const profile = JSON.parse(first.json.revision.profile);
  assert.deepEqual(profile.sheet, SHEET);
  assert.deepEqual(profile.traits.locked, {
    outfit: SHEET.outfit,
    features: SHEET.traits,
    colors: SHEET.colors,
  });
  assert.equal(profile.traits.locked.expression, undefined);
  // persona/appearance lift to the profile top level where the
  // generation input builder reads them
  assert.equal(profile.persona, SHEET.persona);
  assert.equal(profile.appearance, SHEET.appearance);

  // the work's state exposes the pin and the sheet restores from it
  const state = await api("GET", `/api/projects/${pid}/state`);
  const pin = state.json.characters.find(
    (pc: any) => pc.character_id === first.json.character.id,
  );
  assert.equal(pin.character_revision_id, first.json.revision.id);
  const view = state.json.character_views.find(
    (cv: any) => cv.id === first.json.character.id,
  );
  assert.equal(view.revisions.length, 1);

  // second save — base + expected both point at rev #1 → rev #2 pinned
  const second = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: first.json.character.id,
    sheet: { ...SHEET, outfit: "red coat" },
    base_revision_id: first.json.revision.id,
    expected_revision_id: first.json.revision.id,
  });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.revision.rev_no, 2);
  assert.equal(second.json.pin.character_revision_id, second.json.revision.id);

  // rev #1 is immutable — the older sheet text is preserved verbatim
  const revs = second.json.character.revisions;
  assert.equal(revs.length, 2);
  assert.equal(JSON.parse(revs[0].profile).sheet.outfit, "navy short coat");
  assert.equal(JSON.parse(revs[1].profile).sheet.outfit, "red coat");
});

test("sheet save: stale expected_revision_id → 409, nothing written", async () => {
  const pid = await newProject("sheet-save-conflict");
  const first = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "ルカ",
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(first.status, 201);

  // a client holding a stale "unpinned" view loses the race
  const stale = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: first.json.character.id,
    sheet: SHEET,
    base_revision_id: first.json.revision.id,
    expected_revision_id: null,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "conflict");

  const view = await api("GET", "/api/characters");
  const char = view.json.find((c: any) => c.id === first.json.character.id);
  assert.equal(char.revisions.length, 1, "conflict must not write a revision");
});

test("sheet save: base_revision_id rules — required once revisions exist, must belong to the character", async () => {
  const pid = await newProject("sheet-save-base");
  const a = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "A",
    sheet: SHEET,
    expected_revision_id: null,
  });
  const b = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "B",
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  // omitted base → 400 (prevents silently dropping the base image)
  const noBase = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: a.json.character.id,
    sheet: SHEET,
    expected_revision_id: a.json.revision.id,
  });
  assert.equal(noBase.status, 400);

  // base from ANOTHER character → 400
  const wrongBase = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: a.json.character.id,
    sheet: SHEET,
    base_revision_id: b.json.revision.id,
    expected_revision_id: a.json.revision.id,
  });
  assert.equal(wrongBase.status, 400);

  // base passed for a brand-new character → 400
  const noRevs = await api("POST", "/api/characters", { name: "empty" });
  const baseless = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: noRevs.json.id,
    sheet: SHEET,
    base_revision_id: a.json.revision.id,
    expected_revision_id: null,
  });
  assert.equal(baseless.status, 400);
});

test("sheet save: base image carries forward from the base revision", async () => {
  const pid = await newProject("sheet-save-image");
  const char = await api("POST", "/api/characters", { name: "画像持ち" });
  assert.equal(char.status, 201);

  // a 1×1 png — content is never decoded by the asset route, but the
  // signature/type check needs a real image payload
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const asset = await api("POST", "/api/assets", {
    owner_kind: "character",
    owner_id: char.json.id,
    kind: "image",
    name: "ref.png",
    content_base64: png,
    mime: "image/png",
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));

  const rev1 = await api("POST", `/api/characters/${char.json.id}/revisions`, {
    profile: { traits: { locked: {} } },
    base_image_asset_id: asset.json.id,
  });
  assert.equal(rev1.status, 201);
  await api("PUT", `/api/projects/${pid}/characters`, {
    character_id: char.json.id,
    character_revision_id: rev1.json.id,
    expected_version: null,
  });

  const saved = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: char.json.id,
    sheet: SHEET,
    base_revision_id: rev1.json.id,
    expected_revision_id: rev1.json.id,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.revision.base_image_asset_id, asset.json.id);
});

test("sheet save: pins are per-work — two projects keep their own revision", async () => {
  const p1 = await newProject("sheet-owner-a");
  const p2 = await newProject("sheet-owner-b");

  const first = await api("PUT", `/api/projects/${p1}/character-sheets`, {
    name: "共有キャラ",
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(first.status, 201);
  const charId = first.json.character.id;

  // p2 pins its own revision of the same shared character
  const second = await api("PUT", `/api/projects/${p2}/character-sheets`, {
    character_id: charId,
    sheet: { ...SHEET, outfit: "B用の衣装" },
    base_revision_id: first.json.revision.id,
    expected_revision_id: null,
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.revision.rev_no, 2);

  const s1 = await api("GET", `/api/projects/${p1}/state`);
  const s2 = await api("GET", `/api/projects/${p2}/state`);
  const pin1 = s1.json.characters.find((pc: any) => pc.character_id === charId);
  const pin2 = s2.json.characters.find((pc: any) => pc.character_id === charId);
  assert.equal(pin1.character_revision_id, first.json.revision.id);
  assert.equal(pin2.character_revision_id, second.json.revision.id);

  // p1's DISPLAYED revision is still rev #1 even though the library
  // latest is now rev #2 — the pin, not "latest", decides the view
  const view1 = s1.json.character_views.find((cv: any) => cv.id === charId);
  const pinnedRev1 = view1.revisions.find(
    (r: any) => r.id === pin1.character_revision_id,
  );
  assert.equal(pinnedRev1.rev_no, 1);
  assert.equal(
    JSON.parse(pinnedRev1.profile).sheet.outfit,
    "navy short coat",
  );
  assert.equal(view1.revisions.length, 2, "library latest is visible");
});

test("sheet save: fixed fields — only explicit locks mirror, unfixing and clearing drop stale values", async () => {
  const pid = await newProject("sheet-locks");
  const first = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "サラ",
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(first.status, 201);

  // resave: unlock colors, clear traits while keeping it "fixed", add
  // an explicit lock on the (now-filled) memo
  const second = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: first.json.character.id,
    sheet: {
      ...SHEET,
      traits: "",
      locked_fields: ["outfit", "traits", "expression_memo"],
    },
    base_revision_id: first.json.revision.id,
    expected_revision_id: first.json.revision.id,
  });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const profile = JSON.parse(second.json.revision.profile);
  assert.deepEqual(profile.traits.locked, {
    outfit: SHEET.outfit,
    expression: SHEET.expression_memo,
  });
  // colors was unfixed → gone; traits was fixed but empty → not locked
  assert.equal(profile.traits.locked.colors, undefined);
  assert.equal(profile.traits.locked.features, undefined);
  // the sheet itself still carries the editable text state verbatim
  assert.equal(profile.sheet.traits, "");
  assert.equal(profile.sheet.colors, SHEET.colors);
});

test("sheet save: locked_fields validation", async () => {
  const pid = await newProject("sheet-locks-validation");
  const badType = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "x",
    sheet: { ...SHEET, locked_fields: "outfit" },
    expected_revision_id: null,
  });
  assert.equal(badType.status, 400);
  const badField = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "x",
    sheet: { ...SHEET, locked_fields: ["outfit", "password"] },
    expected_revision_id: null,
  });
  assert.equal(badField.status, 400);
});

test("sheet save: request validation — bad keys, bad sheet shape, bad views", async () => {
  const pid = await newProject("sheet-save-validation");

  const unknownKey = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "x",
    sheet: SHEET,
    expected_revision_id: null,
    extra: true,
  });
  assert.equal(unknownKey.status, 400);

  const missingExpected = await api(
    "PUT",
    `/api/projects/${pid}/character-sheets`,
    { name: "x", sheet: SHEET },
  );
  assert.equal(missingExpected.status, 400);

  const noTarget = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(noTarget.status, 400);

  const emptyName = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: "c1",
    name: "  ",
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(emptyName.status, 400);

  const badImageKey = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "x",
    sheet: SHEET,
    base_image_asset_id: 7,
    expected_revision_id: null,
  });
  assert.equal(badImageKey.status, 400);

  const badView = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "x",
    sheet: { ...SHEET, placed_views: ["front", "ceiling"] },
    expected_revision_id: null,
  });
  assert.equal(badView.status, 400);

  const badField = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "x",
    sheet: { ...SHEET, outfit: 42 },
    expected_revision_id: null,
  });
  assert.equal(badField.status, 400);

  // a nonexistent project → 404
  const ghost = await api("PUT", `/api/projects/nope/character-sheets`, {
    name: "x",
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(ghost.status, 404);
});

test("sheet save: name + character_id renames inside the save", async () => {
  const pid = await newProject("sheet-rename");
  const first = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "旧名",
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(first.status, 201);

  const renamed = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: first.json.character.id,
    name: "新名",
    sheet: SHEET,
    base_revision_id: first.json.revision.id,
    expected_revision_id: first.json.revision.id,
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal(renamed.json.character.name, "新名");
  // rename rides the save — the new revision + moved pin are atomic
  assert.equal(renamed.json.revision.rev_no, 2);

  const list = await api("GET", "/api/characters");
  const persisted = list.json.find((c: any) => c.id === first.json.character.id);
  assert.equal(persisted.name, "新名");
});

test("sheet save: base_image_asset_id must belong to the character", async () => {
  const pid = await newProject("sheet-image-owner");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const upload = async (ownerKind: string, ownerId: string) => {
    const res = await api("POST", "/api/assets", {
      owner_kind: ownerKind,
      owner_id: ownerId,
      kind: "image",
      name: "ref.png",
      content_base64: png,
      mime: "image/png",
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.id as string;
  };

  const owner = await api("POST", "/api/characters", { name: "持ち主" });
  const other = await api("POST", "/api/characters", { name: "他人" });
  const ownImage = await upload("character", owner.json.id);
  const alienImage = await upload("character", other.json.id);
  const projectImage = await upload("project", pid);

  // a project asset can never serve as a character's base image
  const projectOwned = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: owner.json.id,
    sheet: SHEET,
    base_image_asset_id: projectImage,
    expected_revision_id: null,
  });
  assert.equal(projectOwned.status, 400);

  // nor can an asset owned by a DIFFERENT character
  const alienOwned = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: owner.json.id,
    sheet: SHEET,
    base_image_asset_id: alienImage,
    expected_revision_id: null,
  });
  assert.equal(alienOwned.status, 400);

  // the character's own asset lands on the new revision
  const saved = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: owner.json.id,
    sheet: SHEET,
    base_image_asset_id: ownImage,
    expected_revision_id: null,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.revision.base_image_asset_id, ownImage);

  // the next save without an explicit image carries it forward
  const resaved = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    character_id: owner.json.id,
    sheet: SHEET,
    base_revision_id: saved.json.revision.id,
    expected_revision_id: saved.json.revision.id,
  });
  assert.equal(resaved.status, 200);
  assert.equal(resaved.json.revision.base_image_asset_id, ownImage);
});

test("sheet save: writes no generation and touches no approved content", async () => {
  const pid = await newProject("sheet-save-isolation");
  const saved = await api("PUT", `/api/projects/${pid}/character-sheets`, {
    name: "隔離",
    sheet: SHEET,
    expected_revision_id: null,
  });
  assert.equal(saved.status, 201);
  const state = await api("GET", `/api/projects/${pid}/state`);
  assert.equal(state.json.generations.length, 0);
  assert.equal(state.json.blueprint_versions.length, 0);
  // seeded items are untouched — saving a sheet is not an adoption
  assert.ok(
    state.json.items.every((i: any) => i.adopted_revision_id === null),
  );
});
