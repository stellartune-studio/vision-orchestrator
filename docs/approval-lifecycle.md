# Approval lifecycle — what "agreed" means

## Item/document revision lifecycle

```
[LLM or user creates revision]
        │  status = pending, base_state_version = current item state
        ▼
   pending ──adopt──▶ adopted        (item.adopted_revision_id set,
        │                             state_version+1, approval_events
        │                             row via trigger — one transaction)
        ├──dismiss──▶ dismissed      (explicit user rejection,
        │                             state_version+1)
        └──other adopted──▶ superseded (sibling adoption in same txn)
```

- A pending proposal whose `base_state_version` < item `state_version`
  is *stale*: still listed but flagged — the client shows "基準が古い
  提案" and the server never auto-applies it.
- LLM proposals carry `base_state_version` from the context snapshot;
  if the world moved while the model was thinking, the proposal lands
  as stale rather than silently current.
- Dismissed and superseded proposals never count toward "unconfirmed"
  totals. Only `pending` does.

## Display contract

An item can be simultaneously **adopted** AND show **unconfirmed
proposals** — e.g. ending A approved, alternative B proposed. The UI
must render both facts, not collapse to one status. A document can be
**approved** AND **needs_recheck**: approval was real, and it was made
against a blueprint that has since changed.

## Auto-save is not approval

Storing an LLM proposal creates an unconfirmed revision only.
`adopted_revision_id` changes solely through the adopt/dismiss
endpoints with a matching `expected_version`.

## Conflicts

Every adoption request includes `expected_version` (the state_version
the client last saw). The transaction guards on it:
`UPDATE ... WHERE id=? AND state_version=?` — zero rows changed means
409 Conflict, and the client refetches. There is no blind overwrite.

## Documents and recheck

`document_revisions.blueprint_version_id` records the source snapshot.
Consistency compares a fingerprint of that snapshot — adopted item
revisions plus their order/parent links, pinned character revisions,
and selected assets — against the project's current blueprint state.
Any difference marks the document `needs_recheck` at read time; a
character re-pin or asset (de)select flags it even when item text is
unchanged. Nothing is rewritten underneath.

A hand-written revision (`POST /api/documents/:id/revisions`) keeps
the lineage: an explicit `blueprint_version_id` re-bases it onto
another snapshot; otherwise it inherits the link from
`base_revision_id`, or from the adopted revision when no base is
given. A claimed base is validated even when an explicit re-base
follows — a foreign revision id is never silently ignored. A revision
without the link can never satisfy the production gate — losing it
would silently orphan the document.

## Chat-driven document amendment

`POST /api/projects/:id/messages` with `document_revision_id` is a
*revision directive*: the instruction targets one concrete revision,
validated server-side to belong to this project. The provider gets the
base body plus the frozen blueprint context of the version the base
derived from (`blueprintFrozenContext`) — live project drift is passed
separately as `drift_notes`, never blended into the basis. The model
receives content, not ids: document/base/blueprint identity is fixed
by the validated request, and an emitted foreign id cannot redirect
the save.

The model returns `reply` + an unvalidated `amendment`. Only a
well-formed amendment (`validateAmendment`) is stored — as a new
`pending` revision with `source='llm'`, `base_revision_id`, and
`instruction_message_id` set. The adopted pointer and approval history
are untouched; approval stays a separate explicit action with
`expected_version`.

If the document's `state_version` moved while the call was in flight
(adoption, dismissal), the save aborts with 409: only the staged
assistant reply + amendment draft + outcome row roll back. The user
instruction was committed in its own transaction BEFORE the LLM call
and intentionally survives — the directive is never lost, it can be
re-checked and retried. A stale-premise draft never lands as current.

Every COMPLETED directive records an `amendment_outcomes` row in the
same transaction as the assistant reply (and the saved draft, when
there is one): `saved` / `reply_only` / `rejected`, plus the revision
id or the refusal reason. The chat surface reads only this record —
never the reply prose — so the save result survives reloads, and a
directive that never completed (409, provider failure, pre-record
history) has no row and stays "unknown" rather than being
guess-converted.

## Which document feeds generation

`POST /api/projects/:id/generations` accepts `document_revision_id`.
The server requires it to be the adopted revision of a document in
this project, derived from the requested blueprint version. Omitted,
the server resolves it only when exactly one approved document
revision derives from that version — several candidates is a 422,
never a silent `LIMIT 1` pick. The chosen revision's body is part of
the generation input, not just a recorded reference.
