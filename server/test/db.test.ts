import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, transact } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import {
  adoptRevision,
  insertRevision,
  listItemViews,
} from "../src/repos/items.ts";
import { createBlueprintVersion } from "../src/repos/blueprints.ts";
import {
  adoptDocumentRevision,
  insertDocument,
  insertDocumentRevision,
} from "../src/repos/documents.ts";
import { insertMessage } from "../src/repos/messages.ts";
import {
  insertAmendmentOutcome,
  listAmendmentOutcomes,
} from "../src/repos/outcomes.ts";
import { getProjectState } from "../src/repos/views.ts";
import { BadRequestError, ConflictError } from "../src/repos/errors.ts";
import { buildSceneDraftPreview, saveVerifiedSceneInputDraft } from "../src/domain/sceneDraft.ts";
import { getSceneInputDraft, listSceneInputDrafts } from "../src/repos/sceneInputDrafts.ts";
import { getSceneInputDraftReview, saveSceneInputDraftReview } from "../src/domain/sceneDraftReview.ts";

const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");

function freshDb() {
  const db = openDatabase(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function firstItemId(db: ReturnType<typeof openDatabase>, projectId: string) {
  return (db
    .prepare("SELECT id FROM design_items WHERE project_id = ? LIMIT 1")
    .get(projectId) as { id: string }).id;
}

const EXPECTED_VERSIONS = readdirSync(MIGRATIONS)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .map((f) => parseInt(f.slice(0, 4), 10));

test("new database: migrations apply cleanly and record history", () => {
  const db = freshDb();
  const rows = db
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as { version: number; name: string }[];
  assert.deepEqual(rows.map((r) => r.version), EXPECTED_VERSIONS);
  assert.equal(rows[0].name, "0001_init.sql");
  db.close();
});

test("existing database: re-running migrate applies nothing again", () => {
  const db = freshDb();
  const applied = migrate(db, MIGRATIONS);
  assert.deepEqual(applied, []);
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
      n: number;
    }
  ).n;
  assert.equal(n, EXPECTED_VERSIONS.length);
  db.close();
});

test("failed migration: rolls back, db stays at last good version", () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-mig-"));
  try {
    writeFileSync(
      join(dir, "0001_init.sql"),
      "CREATE TABLE t_ok (id TEXT PRIMARY KEY);",
    );
    writeFileSync(
      join(dir, "0002_bad.sql"),
      "CREATE TABLE t_bad (id TEXT); THIS IS NOT SQL;",
    );
    const db = openDatabase(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    assert.throws(() => migrate(db, dir), /0002_bad/);
    // migration 1 applied and persisted; the failed one is not recorded
    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    assert.deepEqual(
      rows.map((r) => r.version),
      [1],
    );
    // t_bad must not exist (rolled back), t_ok does
    db.prepare("SELECT id FROM t_ok LIMIT 0");
    assert.throws(() => db.prepare("SELECT id FROM t_bad LIMIT 0"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revision protection: content update and delete are rejected", () => {
  const db = freshDb();
  const project = transact(db, () => createProject(db, "p1"));
  const itemId = firstItemId(db, project.id);
  const rev = transact(db, () =>
    insertRevision(db, { item_id: itemId, content: "v1", source: "user" }),
  );
  assert.throws(
    () =>
      db
        .prepare("UPDATE item_revisions SET content = 'hacked' WHERE id = ?")
        .run(rev.id),
    /only proposal_status may change/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM item_revisions WHERE id = ?").run(rev.id),
    /immutable/,
  );
  db.close();
});

test("adopt: supersedes other pending proposals, writes audit event", () => {
  const db = freshDb();
  const project = transact(db, () => createProject(db, "p1"));
  const itemId = firstItemId(db, project.id);
  const r1 = transact(db, () =>
    insertRevision(db, { item_id: itemId, content: "A", source: "llm" }),
  );
  const r2 = transact(db, () =>
    insertRevision(db, { item_id: itemId, content: "B", source: "llm" }),
  );
  const item = db
    .prepare("SELECT state_version FROM design_items WHERE id = ?")
    .get(itemId) as { state_version: number };

  const view = transact(db, () =>
    adoptRevision(db, {
      item_id: itemId,
      revision_id: r1.id,
      expected_version: item.state_version,
    }),
  );

  assert.equal(view.adopted_revision_id, r1.id);
  const statuses = db
    .prepare(
      "SELECT id, proposal_status FROM item_revisions WHERE item_id = ? ORDER BY rev_no",
    )
    .all(itemId) as { id: string; proposal_status: string }[];
  assert.equal(statuses[0].proposal_status, "adopted");
  assert.equal(statuses[1].proposal_status, "superseded");

  // audit event written by trigger
  const ev = db
    .prepare(
      "SELECT entity_kind, entity_id, revision_id FROM approval_events WHERE entity_id = ?",
    )
    .get(itemId) as
    | { entity_kind: string; entity_id: string; revision_id: string }
    | undefined;
  assert.equal(ev?.entity_kind, "design_item");
  assert.equal(ev?.revision_id, r1.id);
  db.close();
});

test("adopt: stale expected_version is a conflict, not a silent write", () => {
  const db = freshDb();
  const project = transact(db, () => createProject(db, "p1"));
  const itemId = firstItemId(db, project.id);
  const r1 = transact(db, () =>
    insertRevision(db, { item_id: itemId, content: "A", source: "llm" }),
  );
  const r2 = transact(db, () =>
    insertRevision(db, { item_id: itemId, content: "B", source: "llm" }),
  );

  transact(db, () =>
    adoptRevision(db, {
      item_id: itemId,
      revision_id: r1.id,
      expected_version: 0,
    }),
  );
  // adopting r2 with the pre-adoption version must conflict
  assert.throws(
    () =>
      transact(db, () =>
        adoptRevision(db, {
          item_id: itemId,
          revision_id: r2.id,
          expected_version: 0,
        }),
      ),
    ConflictError,
  );
  // and nothing changed: adopted is still r1
  const item = db
    .prepare("SELECT adopted_revision_id FROM design_items WHERE id = ?")
    .get(itemId) as { adopted_revision_id: string };
  assert.equal(item.adopted_revision_id, r1.id);
  db.close();
});

test("wrong-ownership references are rejected by composite FKs", () => {
  const db = freshDb();
  const pA = transact(db, () => createProject(db, "A"));
  const pB = transact(db, () => createProject(db, "B"));
  const itemA = firstItemId(db, pA.id);
  const itemB = firstItemId(db, pB.id);
  const revA = transact(db, () =>
    insertRevision(db, { item_id: itemA, content: "A", source: "user" }),
  );

  // project A's item cannot adopt project B... (item B's revision)
  const revB = transact(db, () =>
    insertRevision(db, { item_id: itemB, content: "B", source: "user" }),
  );
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE design_items SET adopted_revision_id = ? WHERE id = ?",
        )
        .run(revB.id, itemA),
    /FOREIGN KEY/,
  );

  // a blueprint version of project B cannot contain project A's item
  db.prepare(
    "INSERT INTO blueprint_versions (id, project_id, version_no) VALUES ('bv-b', ?, 1)",
  ).run(pB.id);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO blueprint_version_items
             (blueprint_version_id, project_id, item_id, revision_id, seq, kind, label)
           VALUES ('bv-b', ?, ?, ?, 0, 'intent', 'x')`,
        )
        .run(pB.id, itemA, revA.id),
    /FOREIGN KEY/,
  );

  // a character revision cannot be pinned to a different character
  db.prepare("INSERT INTO characters (id, name) VALUES ('c1','C1'),('c2','C2')").run();
  db.prepare(
    "INSERT INTO character_revisions (id, character_id, rev_no, profile) VALUES ('cr1','c1',1,'{}')",
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO project_characters
             (project_id, character_id, character_revision_id)
           VALUES (?, 'c2', 'cr1')`,
        )
        .run(pA.id),
    /FOREIGN KEY/,
  );
  db.close();
});

test("resume: persisted state survives close and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-db-"));
  try {
    const path = join(dir, "app.db");
    let db = openDatabase(path);
    migrate(db, MIGRATIONS);
    const project = transact(db, () => createProject(db, "p1"));
    const itemId = firstItemId(db, project.id);
    const rev = transact(db, () =>
      insertRevision(db, { item_id: itemId, content: "A", source: "llm" }),
    );
    transact(db, () =>
      adoptRevision(db, {
        item_id: itemId,
        revision_id: rev.id,
        expected_version: 0,
      }),
    );
    db.close();

    db = openDatabase(path);
    const views = listItemViews(db, project.id);
    const item = views.find((v) => v.id === itemId)!;
    assert.equal(item.adoption, "adopted");
    assert.equal(item.adopted_revision?.content, "A");
    assert.equal(item.state_version, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recheck: item order and parent links flag an approved document", () => {
  const db = freshDb();
  const project = transact(db, () => createProject(db, "p1"));
  const items = db
    .prepare(
      "SELECT id FROM design_items WHERE project_id = ? ORDER BY created_at",
    )
    .all(project.id) as { id: string }[];
  const itemId = items[0].id;
  const otherId = items[1].id;
  const rev = transact(db, () =>
    insertRevision(db, { item_id: itemId, content: "A", source: "user" }),
  );
  transact(db, () =>
    adoptRevision(db, {
      item_id: itemId,
      revision_id: rev.id,
      expected_version: 0,
    }),
  );
  const bv = transact(db, () => createBlueprintVersion(db, project.id));
  const doc = transact(db, () =>
    insertDocument(db, { project_id: project.id, kind: "script" }),
  );
  const docRev = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "draft",
      source: "user",
      blueprint_version_id: bv.id,
    }),
  );
  transact(db, () =>
    adoptDocumentRevision(db, {
      document_id: doc.id,
      revision_id: docRev.id,
      expected_version: 0,
    }),
  );

  const consistency = () =>
    getProjectState(db, project.id).documents.find((d) => d.id === doc.id)!
      .consistency;
  assert.equal(consistency(), "in_sync");

  const origSeq = (
    db.prepare("SELECT seq FROM design_items WHERE id = ?").get(itemId) as {
      seq: number;
    }
  ).seq;

  // reorder drift: same revisions, different structure → recheck
  db.prepare("UPDATE design_items SET seq = ? WHERE id = ?").run(
    origSeq + 100,
    itemId,
  );
  assert.equal(consistency(), "needs_recheck");
  db.prepare("UPDATE design_items SET seq = ? WHERE id = ?").run(
    origSeq,
    itemId,
  );
  assert.equal(consistency(), "in_sync");

  // parent-link drift: attaching the item under another → recheck
  db.prepare("UPDATE design_items SET parent_item_id = ? WHERE id = ?").run(
    otherId,
    itemId,
  );
  assert.equal(consistency(), "needs_recheck");
  db.prepare(
    "UPDATE design_items SET parent_item_id = NULL WHERE id = ?",
  ).run(itemId);
  assert.equal(consistency(), "in_sync");
  db.close();
});

test("common seed: project starts with undecided items before any chat", () => {
  const db = freshDb();
  const project = transact(db, () => createProject(db, "p1"));
  const views = listItemViews(db, project.id);
  assert.equal(views.length, 7);
  assert.ok(views.every((v) => v.adoption === "undecided"));
  assert.ok(views.some((v) => v.kind === "purpose"));
  assert.ok(views.some((v) => v.kind === "output_policy"));
  assert.ok(views.some((v) => v.kind === "camera_work"));
  db.close();
});

test("instruction_message_id: ownership enforced at repo and trigger", () => {
  const db = freshDb();
  const pA = transact(db, () => createProject(db, "proj-a"));
  const pB = transact(db, () => createProject(db, "proj-b"));
  const doc = transact(db, () =>
    insertDocument(db, {
      project_id: pA.id,
      kind: "script",
    }),
  );

  const userMsg = transact(db, () =>
    insertMessage(db, {
      project_id: pA.id,
      role: "user",
      content: "fix the ending",
    }),
  );
  const assistantMsg = transact(db, () =>
    insertMessage(db, {
      project_id: pA.id,
      role: "assistant",
      content: "a reply",
    }),
  );
  const foreignMsg = transact(db, () =>
    insertMessage(db, {
      project_id: pB.id,
      role: "user",
      content: "other project's turn",
    }),
  );

  // same-project user message — accepted
  const okRev = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "amended",
      source: "llm",
      instruction_message_id: userMsg.id,
    }),
  );
  assert.equal(okRev.instruction_message_id, userMsg.id);

  // Direct INSERT: every row is otherwise fully valid — all NOT NULL
  // columns populated, unique rev_no — so ONLY the ownership condition
  // differs, and the trigger's own message proves what rejected it.
  const rawInsert = (revId: string, revNo: number, msgId: string | null) =>
    db
      .prepare(
        `INSERT INTO document_revisions
           (id, document_id, project_id, rev_no, content, source,
            proposal_status, instruction_message_id)
         VALUES (?, ?, ?, ?, 'raw', 'llm', 'pending', ?)`,
      )
      .run(revId, doc.id, pA.id, revNo, msgId);

  // control: identical INSERT with a valid owner succeeds — a failure
  // of the bad rows cannot be blamed on unrelated NOT NULL checks
  rawInsert("raw-ok", 90, userMsg.id);
  assert.equal(
    (
      db
        .prepare(
          `SELECT instruction_message_id FROM document_revisions
            WHERE id = 'raw-ok'`,
        )
        .get() as { instruction_message_id: string }
    ).instruction_message_id,
    userMsg.id,
  );

  // foreign-project user message — repo check AND the trigger itself
  assert.throws(() =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "x",
      source: "llm",
      instruction_message_id: foreignMsg.id,
    }),
  );
  assert.throws(
    () => rawInsert("raw-fk", 91, foreignMsg.id),
    /instruction_message_id must reference a user message of the same project/,
  );
  assert.throws(
    () => rawInsert("raw-missing", 92, "no-such-message"),
    /instruction_message_id must reference a user message of the same project/,
  );

  // assistant message — rejected
  assert.throws(() =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "x",
      source: "llm",
      instruction_message_id: assistantMsg.id,
    }),
  );

  // nonexistent message id — rejected
  assert.throws(() =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "x",
      source: "llm",
      instruction_message_id: "no-such-message",
    }),
  );

  // NULL remains permitted and preserved
  const nullRev = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "hand edit",
      source: "user",
    }),
  );
  assert.equal(nullRev.instruction_message_id, null);

  // provenance columns cannot be rewritten after insert
  assert.throws(() =>
    db
      .prepare(
        `UPDATE document_revisions SET instruction_message_id = NULL
          WHERE id = ?`,
      )
      .run(okRev.id),
  );
  // (a real rewrite attempt — setting another revision as the base)
  assert.throws(() =>
    db
      .prepare(
        `UPDATE document_revisions SET base_revision_id = ?
          WHERE id = ?`,
      )
      .run(nullRev.id, okRev.id),
  );
  db.close();
});

test("migration upgrade: pre-trigger rows keep NULL provenance intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-mig-up-"));
  try {
    // an old-schema database: only migrations up to 0004 applied —
    // provenance columns exist but the ownership trigger does not
    const oldDir = join(dir, "mig-old");
    mkdirSync(oldDir);
    for (const f of readdirSync(MIGRATIONS)) {
      if (/^000[1-4]_/.test(f)) {
        copyFileSync(join(MIGRATIONS, f), join(oldDir, f));
      }
    }
    const db = openDatabase(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, oldDir);

    // a revision row as it existed then: NULL provenance, pending
    // row-only fixture: createProject seeds kinds the pre-0014 schema rejects
    db.prepare(
      "INSERT INTO projects (id, name) VALUES ('legacy-proj', 'legacy')",
    ).run();
    const p = { id: "legacy-proj" };
    const doc = transact(db, () =>
      insertDocument(db, { project_id: p.id, kind: "script" }),
    );
    db.prepare(
      `INSERT INTO document_revisions
         (id, document_id, project_id, rev_no, content, source,
          proposal_status)
       VALUES ('legacy-rev', ?, ?, 1, 'legacy body', 'user', 'pending')`,
    ).run(doc.id, p.id);

    // the real upgrade path: apply the remaining migrations
    const applied = migrate(db, MIGRATIONS);
    assert.deepEqual(applied, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);

    // the pre-existing row survives untouched
    const row = db
      .prepare(
        `SELECT id, content, base_revision_id, instruction_message_id,
                proposal_status
           FROM document_revisions WHERE id = 'legacy-rev'`,
      )
      .get() as Record<string, unknown>;
    assert.equal(row.content, "legacy body");
    assert.equal(row.base_revision_id, null);
    assert.equal(row.instruction_message_id, null);
    assert.equal(row.proposal_status, "pending");

    // and the new table accepts a well-formed row post-upgrade
    const userMsg = transact(db, () =>
      insertMessage(db, {
        project_id: p.id,
        role: "user",
        content: "later instruction",
      }),
    );
    const replyMsg = transact(db, () =>
      insertMessage(db, {
        project_id: p.id,
        role: "assistant",
        content: "reply",
      }),
    );
    const outcome = transact(db, () =>
      insertAmendmentOutcome(db, {
        project_id: p.id,
        instruction_message_id: userMsg.id,
        assistant_message_id: replyMsg.id,
        document_id: doc.id,
        base_revision_id: "legacy-rev",
        outcome: "reply_only",
      }),
    );
    assert.equal(outcome.outcome, "reply_only");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("amendment_outcomes: repo + trigger enforce linkage and outcome shape", () => {
  const db = freshDb();
  const pA = transact(db, () => createProject(db, "proj-a"));
  const pB = transact(db, () => createProject(db, "proj-b"));
  const doc = transact(db, () =>
    insertDocument(db, { project_id: pA.id, kind: "script" }),
  );
  const doc2 = transact(db, () =>
    insertDocument(db, { project_id: pA.id, kind: "storyboard" }),
  );
  const rev = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "base",
      source: "user",
    }),
  );
  const rev2 = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc2.id,
      content: "other doc rev",
      source: "user",
    }),
  );
  const userMsg = transact(db, () =>
    insertMessage(db, { project_id: pA.id, role: "user", content: "fix" }),
  );
  const replyMsg = transact(db, () =>
    insertMessage(db, {
      project_id: pA.id,
      role: "assistant",
      content: "done",
    }),
  );
  const foreignMsg = transact(db, () =>
    insertMessage(db, { project_id: pB.id, role: "user", content: "x" }),
  );

  const baseInput = {
    project_id: pA.id,
    instruction_message_id: userMsg.id,
    assistant_message_id: replyMsg.id,
    document_id: doc.id,
    base_revision_id: rev.id,
  };

  // happy path — the result must be the actual llm amendment: a real
  // revision built on THIS base by THIS instruction, inheriting the
  // base's blueprint basis (NULL here, matched explicitly).
  const amendRev = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "amended body",
      source: "llm",
      base_revision_id: rev.id,
      instruction_message_id: userMsg.id,
    }),
  );
  const saved = transact(db, () =>
    insertAmendmentOutcome(db, {
      ...baseInput,
      outcome: "saved",
      result_revision_id: amendRev.id,
    }),
  );
  assert.equal(saved.outcome, "saved");
  assert.equal(saved.result_revision_id, amendRev.id);

  // one directive → one result row
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...baseInput,
        outcome: "reply_only",
      }),
    /UNIQUE/,
  );

  const instr2 = transact(db, () =>
    insertMessage(db, { project_id: pA.id, role: "user", content: "more" }),
  );
  const reply2 = transact(db, () =>
    insertMessage(db, {
      project_id: pA.id,
      role: "assistant",
      content: "more",
    }),
  );
  const second = {
    ...baseInput,
    instruction_message_id: instr2.id,
    assistant_message_id: reply2.id,
  };

  // readable repo-layer rejections
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        instruction_message_id: foreignMsg.id,
        outcome: "reply_only",
      }),
    BadRequestError,
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        instruction_message_id: replyMsg.id, // assistant turn as instruction
        outcome: "reply_only",
      }),
    BadRequestError,
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        assistant_message_id: userMsg.id, // user turn as reply
        outcome: "reply_only",
      }),
    BadRequestError,
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        base_revision_id: rev2.id, // revision of ANOTHER document
        outcome: "reply_only",
      }),
    BadRequestError,
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "saved", // without result_revision_id
      }),
    BadRequestError,
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "rejected", // without reject_reason
      }),
    BadRequestError,
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "rejected",
        reject_reason: "   ", // whitespace is not a reason
      }),
    BadRequestError,
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "reply_only",
        reject_reason: "no rejection happened", // a reason that is not a rejection
      }),
    BadRequestError,
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "reply_only",
        result_revision_id: amendRev.id, // a saved link without a save
      }),
    BadRequestError,
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "saved",
        result_revision_id: rev.id, // the base cannot be its own result
      }),
    BadRequestError,
  );
  // the outcome's basis must be the base's — a blueprint version that
  // is not the base revision's own is a wrong claim, even when the
  // version exists in this project
  const bv = transact(db, () => createBlueprintVersion(db, pA.id));
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        blueprint_version_id: bv.id, // base rev has NULL basis
        outcome: "reply_only",
      }),
    BadRequestError,
  );

  // ── saved must name THE amendment, not a lookalike on the doc ──
  // same document, wrong combinations — each rejected:
  // (a) a user revision with the right base is not an llm amendment
  const userRevSameBase = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "hand edit",
      source: "user",
      base_revision_id: rev.id,
    }),
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "saved",
        result_revision_id: userRevSameBase.id,
      }),
    BadRequestError,
  );
  // (b) an llm revision of a DIFFERENT base revision
  const otherBase = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "other base",
      source: "user",
    }),
  );
  const llmOtherBase = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "amended",
      source: "llm",
      base_revision_id: otherBase.id,
      instruction_message_id: userMsg.id,
    }),
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "saved",
        result_revision_id: llmOtherBase.id,
      }),
    BadRequestError,
  );
  // (c) an llm amendment of the right base but a DIFFERENT instruction
  const llmOtherInstr = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "amended",
      source: "llm",
      base_revision_id: rev.id,
      instruction_message_id: userMsg.id, // not this outcome's instruction
    }),
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "saved",
        result_revision_id: llmOtherInstr.id,
      }),
    BadRequestError,
  );
  // (d) an llm amendment on a DIFFERENT blueprint basis — the base is
  // NULL-basis here, so any non-NULL result basis mismatches
  const bv2 = transact(db, () => createBlueprintVersion(db, pA.id));
  const llmOtherBasis = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "amended",
      source: "llm",
      base_revision_id: rev.id,
      instruction_message_id: instr2.id, // matches — ONLY the basis differs
      blueprint_version_id: bv2.id,
    }),
  );
  assert.throws(
    () =>
      insertAmendmentOutcome(db, {
        ...second,
        outcome: "saved",
        result_revision_id: llmOtherBasis.id,
      }),
    BadRequestError,
  );
  // control: the fully matching llm amendment IS accepted — the
  // rejections above were the linkage rules, not unrelated constraints
  const amendRev2 = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "amended v2",
      source: "llm",
      base_revision_id: rev.id,
      instruction_message_id: instr2.id,
    }),
  );
  const saved2 = transact(db, () =>
    insertAmendmentOutcome(db, {
      ...second,
      outcome: "saved",
      result_revision_id: amendRev2.id,
    }),
  );
  assert.equal(saved2.result_revision_id, amendRev2.id);

  // raw INSERT: same checks enforced by the trigger, not just the repo
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO amendment_outcomes
             (id, project_id, instruction_message_id, assistant_message_id,
              document_id, base_revision_id, outcome)
           VALUES ('raw-o1', ?, ?, ?, ?, ?, 'reply_only')`,
        )
        .run(pA.id, foreignMsg.id, reply2.id, doc.id, rev.id),
    /instruction must be a user message of the same project/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO amendment_outcomes
             (id, project_id, instruction_message_id, assistant_message_id,
              document_id, base_revision_id, outcome)
           VALUES ('raw-o2', ?, ?, ?, ?, ?, 'reply_only')`,
        )
        .run(pA.id, instr2.id, userMsg.id, doc.id, rev.id),
    /reply must be an assistant message of the same project/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO amendment_outcomes
             (id, project_id, instruction_message_id, assistant_message_id,
              document_id, base_revision_id, outcome)
           VALUES ('raw-o3', ?, ?, ?, ?, ?, 'saved')`,
        )
        .run(pA.id, instr2.id, reply2.id, doc.id, rev.id),
    // saved without a result: the 0007 link trigger aborts before the
    // CHECK even runs — rejected either way
    /CHECK|saved|llm amendment/,
  );

  // 0007 triggers: the result must be THIS directive's own amendment.
  // Each raw row gets a fresh instruction/reply pair so a UNIQUE hit
  // can never masquerade as the linkage trigger under test.
  const freshPair = () => ({
    i: transact(db, () =>
      insertMessage(db, {
        project_id: pA.id,
        role: "user",
        content: "raw instr",
      }),
    ).id,
    r: transact(db, () =>
      insertMessage(db, {
        project_id: pA.id,
        role: "assistant",
        content: "raw reply",
      }),
    ).id,
  });
  const rawO = (
    id: string,
    outcome: string,
    extra: { result?: string | null; reason?: string | null; bv?: string | null },
  ) => {
    const { i, r } = freshPair();
    return db
      .prepare(
        `INSERT INTO amendment_outcomes
           (id, project_id, instruction_message_id, assistant_message_id,
            document_id, base_revision_id, blueprint_version_id,
            outcome, result_revision_id, reject_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        pA.id,
        i,
        r,
        doc.id,
        rev.id,
        extra.bv ?? null,
        outcome,
        extra.result ?? null,
        extra.reason ?? null,
      );
  };
  // control: a fully-consistent saved row is accepted
  const instr3 = transact(db, () =>
    insertMessage(db, { project_id: pA.id, role: "user", content: "i3" }),
  );
  const reply3 = transact(db, () =>
    insertMessage(db, {
      project_id: pA.id,
      role: "assistant",
      content: "r3",
    }),
  );
  const amendRev3 = transact(db, () =>
    insertDocumentRevision(db, {
      document_id: doc.id,
      content: "amended v3",
      source: "llm",
      base_revision_id: rev.id,
      instruction_message_id: instr3.id,
    }),
  );
  db.prepare(
    `INSERT INTO amendment_outcomes
       (id, project_id, instruction_message_id, assistant_message_id,
        document_id, base_revision_id, outcome, result_revision_id)
     VALUES ('raw-ok', ?, ?, ?, ?, ?, 'saved', ?)`,
  ).run(pA.id, instr3.id, reply3.id, doc.id, rev.id, amendRev3.id);
  // control succeeded — now only the linkage differs
  assert.throws(
    () => rawO("raw-o4", "saved", { result: rev.id }),
    /result revision must differ from its base/,
  );
  assert.throws(
    () => rawO("raw-o5", "saved", { result: userRevSameBase.id }),
    /result must be the llm amendment/,
  );
  assert.throws(
    () => rawO("raw-o6", "saved", { result: llmOtherBasis.id }),
    /result must be the llm amendment/,
  );
  assert.throws(
    () => rawO("raw-o7", "rejected", { reason: "  " }),
    /non-empty reject_reason/,
  );
  assert.throws(
    () => rawO("raw-o8", "reply_only", { reason: "not a rejection" }),
    /reject_reason only belongs to rejected/,
  );
  assert.throws(
    () =>
      rawO("raw-o9", "reply_only", { bv: bv.id }), // base rev is NULL-basis
    /blueprint_version_id must match the base revision/,
  );

  // immutable once written
  assert.throws(
    () =>
      db
        .prepare(
          `UPDATE amendment_outcomes SET outcome = 'rejected' WHERE id = ?`,
        )
        .run(saved.id),
    /immutable/,
  );
  assert.throws(
    () =>
      db
        .prepare(`DELETE FROM amendment_outcomes WHERE id = ?`)
        .run(saved.id),
    /immutable/,
  );
  db.close();
});

test("amendment_outcomes: record survives a close/reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-db-"));
  try {
    const path = join(dir, "app.db");
    let db = openDatabase(path);
    migrate(db, MIGRATIONS);
    const p = transact(db, () => createProject(db, "p1"));
    const doc = transact(db, () =>
      insertDocument(db, { project_id: p.id, kind: "script" }),
    );
    const rev = transact(db, () =>
      insertDocumentRevision(db, {
        document_id: doc.id,
        content: "base",
        source: "user",
      }),
    );
    const userMsg = transact(db, () =>
      insertMessage(db, { project_id: p.id, role: "user", content: "fix" }),
    );
    const replyMsg = transact(db, () =>
      insertMessage(db, {
        project_id: p.id,
        role: "assistant",
        content: "reply",
      }),
    );
    transact(db, () =>
      insertAmendmentOutcome(db, {
        project_id: p.id,
        instruction_message_id: userMsg.id,
        assistant_message_id: replyMsg.id,
        document_id: doc.id,
        base_revision_id: rev.id,
        outcome: "rejected",
        reject_reason: "amendment content is required",
      }),
    );
    const outcomeId = listAmendmentOutcomes(db, p.id)[0].id;
    db.close();

    db = openDatabase(path);
    const rows = listAmendmentOutcomes(db, p.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, outcomeId);
    assert.equal(rows[0].outcome, "rejected");
    assert.equal(rows[0].reject_reason, "amendment content is required");
    assert.equal(rows[0].result_revision_id, null);
    // and it flows into the resumed project state
    assert.equal(
      getProjectState(db, p.id).amendment_outcomes.length,
      1,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scene input draft: immutable preview snapshot survives DB close/reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-scene-save-"));
  const path = join(dir, "app.db");
  try {
    let db = openDatabase(path);
    migrate(db, MIGRATIONS);
    const project = transact(db, () => createProject(db, "scene-save-persistence"));
    for (const kind of ["intent", "output_policy"]) {
      const item = listItemViews(db, project.id).find((x) => x.kind === kind)!;
      const rev = transact(db, () => insertRevision(db, {
        item_id: item.id,
        content: kind === "intent" ? "雨上がりの駅前" : "静止画1枚",
        source: "user",
      }));
      transact(db, () => adoptRevision(db, {
        item_id: item.id,
        revision_id: rev.id,
        expected_version: item.state_version,
      }));
    }
    const blueprint = transact(db, () => createBlueprintVersion(db, project.id));
    const doc = transact(db, () => insertDocument(db, {
      project_id: project.id,
      kind: "script",
      title: "保存時の資料名",
    }));
    const revision = transact(db, () => insertDocumentRevision(db, {
      document_id: doc.id,
      content: "場面: 夕方の駅前。少女が立つ。",
      source: "user",
      blueprint_version_id: blueprint.id,
    }));
    transact(db, () => adoptDocumentRevision(db, {
      document_id: doc.id,
      revision_id: revision.id,
      expected_version: doc.state_version,
    }));
    const preview = buildSceneDraftPreview(db, {
      project_id: project.id,
      blueprint_version_id: blueprint.id,
      document_revision_id: revision.id,
    });
    const saved = saveVerifiedSceneInputDraft(db, {
      project_id: project.id,
      blueprint_version_id: blueprint.id,
      document_id: doc.id,
      document_revision_id: revision.id,
      digest: preview.digest,
    });
    const savedId = saved.id;
    const initialReview = getSceneInputDraftReview(db, project.id, savedId);
    assert.equal(initialReview.persisted, false);
    assert.equal(initialReview.version, 0);
    assert.ok(initialReview.items.length > 0);
    const firstItem = initialReview.items[0]!;
    const reviewSaved = saveSceneInputDraftReview(db, project.id, savedId, {
      expected_version: 0,
      items: initialReview.items.map((item) => ({
        id: item.id,
        status: item.id === firstItem.id ? "in_progress" : item.status,
        answer: item.id === firstItem.id ? "再開後も残す回答" : item.answer,
        memo: item.id === firstItem.id ? "メモ" : item.memo,
      })),
      unresolved_issues: [],
      resume_target: { draft_id: savedId, issue_id: firstItem.id },
    });
    assert.equal(reviewSaved.version, 1);
    db.close();

    db = openDatabase(path);
    migrate(db, MIGRATIONS);
    const reopened = getSceneInputDraft(db, project.id, savedId);
    assert.deepEqual(reopened.snapshot, preview);
    assert.equal(reopened.digest, preview.digest);
    assert.equal(listSceneInputDrafts(db, project.id)[0].id, savedId);
    assert.equal(getProjectState(db, project.id).scene_input_drafts[0].id, savedId);
    const reopenedReview = getSceneInputDraftReview(db, project.id, savedId);
    assert.equal(reopenedReview.persisted, true);
    assert.equal(reopenedReview.version, 1);
    assert.equal(reopenedReview.items[0]?.answer, "再開後も残す回答");
    assert.equal(reopenedReview.items[0]?.memo, "メモ");
    assert.deepEqual(reopenedReview.resume_target, {
      draft_id: savedId,
      issue_id: firstItem.id,
    });
    assert.equal(reopened.digest, preview.digest, "review progress does not alter the immutable snapshot");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
