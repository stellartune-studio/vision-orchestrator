# Data model — Vision Orchestrator

One SQLite database (`data/app.db`) holds every project, scoped by
`project_id`. File payloads live under `data/assets/<owner_id>/`.
Schema is versioned by numbered SQL files in
`server/src/db/migrations/`; applied files are never edited — new
changes are new migrations. `schema_migrations` records what ran.

## Core pattern: immutable revisions + adopted pointer + audit ledger

Every approvable entity (`design_items`, `production_documents`,
`characters`) follows the same shape:

- a **revisions table** holds every content version. Revision rows are
  append-only: triggers reject UPDATE of content columns and all
  DELETEs. A new idea is always a NEW revision — approved content is
  never rewritten.
- `adopted_revision_id` on the entity points at the revision the user
  approved. A composite foreign key (`(adopted_revision_id, id) →
  (id, item_id)`) proves the adopted revision belongs to THAT entity —
  adopting another item's revision is a SQL-level error.
- `approval_events` rows are written **only by triggers** when the
  adopted pointer changes, so the audit ledger can never drift from
  the pointer.
- `state_version` increments on every adoption-relevant update.
  Clients pass `expected_version`; a mismatch is a 409 conflict, never
  a silent overwrite. (`expected_status` was rejected: A→B swaps share
  the same status.)

## Three-axis status (never one value)

| Axis | Values | Derived from |
| --- | --- | --- |
| Adoption | undecided / proposed_only / adopted | revisions + adopted pointer |
| Unconfirmed proposals | pending count, target revisions | `proposal_status='pending'` |
| Consistency (docs/gen) | in_sync / needs_recheck | snapshot fingerprint vs current blueprint (items+order/links, character pins, selected assets) |

- Proposal lifecycle: `pending → adopted | dismissed | superseded`.
  Adopting one proposal supersedes the item's other pending ones in
  the same transaction. Dismissed/superseded proposals never count as
  "unconfirmed". A pending proposal whose `base_state_version` is
  behind is flagged "based on older base", not auto-applied.
- `needs_recheck` does NOT revoke approval: a document stays approved
  AND shows needs_recheck when the blueprint version it was drafted
  from no longer matches current adopted items.

## Blueprint versions (immutable snapshots)

`blueprint_versions` + three child tables freeze everything a piece of
production meaningfully depends on:

- `blueprint_version_items`: adopted revision per item **plus** seq,
  parent link (story_segment ↔ shot), kind and label — ordering and
  structure are part of the snapshot, not just text.
- `blueprint_version_characters`: pinned character revision + base
  image reference per project character.
- `blueprint_version_assets`: selected materials.
- `blueprint_versions`: template_key + template_version used.

Snapshot tables have immutability triggers; a later edit or new item
cannot rewrite a finalized blueprint. Every `document_revisions` row
carries `blueprint_version_id` — each draft traces to the blueprint
it was made from. Composite FKs with a denormalized `project_id`
prove a snapshot only references same-project entities.

Document revisions also carry persistent provenance (migration 0004):

- `base_revision_id` — the revision the draft was edited from. An
  insert trigger enforces it belongs to the SAME document; NULL is
  kept for roots and pre-provenance rows (never back-guessed).
- `instruction_message_id` — the chat instruction that produced an
  LLM amendment, so a draft traces back to the exact directive across
  restarts. Both columns are covered by the immutability trigger —
  provenance is written once at insert. When non-NULL, migration 0005
  adds an insert trigger requiring the message to exist, belong to the
  same project as the document, and have `role='user'`; the repository
  layer rejects the same violations first so callers see a readable
  error. NULL stays valid for roots, manual drafts, and pre-provenance
  rows.

Workbench character sheets reuse the same revision+pin pattern with
no new tables: the sheet's editable fields (outfit / traits / colors /
expression memo / placed views) live inside `character_revisions.profile`
as a `sheet` JSON object. `sheet.locked_fields` lists the fields the
user explicitly fixed; only those mirror into `traits.locked` so the
consult context sees them as fixed conditions — entered text alone is
never a lock, and unfixing or clearing a field drops the stale trait on
the next save. `PUT /api/projects/:id/character-sheets` is the only
operation that both writes a sheet revision and moves the work's pin —
in one transaction, guarded by `expected_revision_id` (409 on a stale
pin) and `base_revision_id` (required once revisions exist; carries the
base image forward). Unsaved sheet edits never reach the server and
survive project/character switches and failed saves in browser memory.

The scene tab's backdrop selection + pin is a per-work setting:
`project_workbench` (migration 0010; `workbench_version` counter added
by 0011) upserts `{backdrop_key, locked}` per project via
`PUT /api/projects/:id/workbench/background`. Keys come from the shared
`WORKBENCH_BACKDROPS` preset catalog; unlocking or re-selecting
overwrites the row so no stale value survives. Writes are guarded by
`expected_version` — a stale screen gets 409 and keeps its draft rather
than silently replacing a newer setting. It is a settings write only:
no revision chain, no generation side effect.

`amendment_outcomes` (migration 0006) records what each completed
revision directive produced: the instruction message, the paired
assistant reply, the target document + base revision + blueprint
version, and the result — `saved` with `result_revision_id`,
`reply_only`, or `rejected` with `reject_reason`. Composite FKs pin
every reference to the same project; a trigger enforces message roles;
rows are immutable (one row per instruction). A directive with no row
is "unknown" — conflicts, failures and pre-record history are never
back-filled by guessing.

Migration 0007 tightens the link: the outcome's
`blueprint_version_id` must equal the base revision's own basis
(NULL counts), `rejected` requires a non-empty reason, and a `saved`
row's `result_revision_id` must be the actual amendment — an `llm`
revision of the same document whose `base_revision_id`,
`instruction_message_id`, and `blueprint_version_id` match this
directive. These are save-time relationships; the adopted pointer may
move later and never invalidates the record.

## Project seeding and templates

`domain/templates.ts` defines the seeds. `COMMON_SEED` items
(purpose, audience, intent, constraints, material, output_policy) are
inserted as undecided at project creation — undecided items exist
BEFORE they come up in conversation. Adopting a `purpose` revision
applies a matching template (narrative/introduction/personal), adding
missing items only. 起承転結 is not forced; `narrative` seeds generic
story-flow segments.

## Tables

| Table | Purpose |
| --- | --- |
| projects | work identity + applied template |
| messages | per-project conversation log |
| design_items / item_revisions | blueprint items + versions |
| approval_events | trigger-written adoption ledger |
| blueprint_versions (+3 children) | immutable production snapshots |
| production_documents / document_revisions | script/storyboard + versions |
| characters / character_revisions | shared library + versions |
| project_characters | per-project pinned character revision |
| assets | uploaded/generated files (polymorphic owner verified in repo layer) |
| generation_records | outputs + exact inputs snapshot (prompt, resolved refs, settings) |
| amendment_outcomes | per-directive durable result: saved / reply_only / rejected + linkage |
| scene_input_drafts | immutable, digest-verified save-time copy of the displayed scene instruction preview; unapproved and not connected to generation |
| project_workbench | per-project workbench settings (backdrop selection + pin) — upserted, last-write-wins |

`scene_input_drafts` is created by migration 0008. Each row pins a
same-project blueprint version, document, and document revision, and
stores the complete preview JSON with payload and builder versions plus
a SHA-256 digest. Saving accepts target IDs and that digest only; inside
one short transaction the server rebuilds the deterministic preview,
requires an exact digest match, and inserts its own payload. Repeated
submissions of the same target and content return the same row. SQLite
triggers reject UPDATE and DELETE. Reading a saved draft returns this
snapshot directly; it never rebuilds it from current adopted pointers.
Saving does not adopt content, write an approval event, or call an LLM or
generation backend. Unresolved references and inspection warnings stay
as recorded in the snapshot.

Polymorphic references that SQL cannot constrain —
`approval_events.entity_id`, `assets.owner_id`, generation `inputs`
JSON — are guaranteed by trigger-only writes and repo-layer existence
checks (tested in `server/test/db.test.ts`).
