import { useState } from "react";
import type { GenerationStatus, Project, ProjectListItem } from "@vo/shared";
import { assetUrl } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import { Icon } from "./icon.tsx";

// Starting ideas that every existing feature can carry through the
// consult→approve→generate loop. Chips only fill the input — free
// text remains the primary entry, so examples never narrow ideas.
const IDEA_EXAMPLES = ["home.idea.story", "home.idea.animate", "home.idea.character", "home.idea.promo"];
const GEN_LABEL: Record<GenerationStatus, string> = {
  queued: "home.generation.queued", running: "home.generation.running",
  succeeded: "home.generation.succeeded", failed: "home.generation.failed",
};

function SummaryChips({ item }: { item: ProjectListItem }) {
  const { t } = useI18n();
  const s = item.summary;
  return (
    <span className="project-chips">
      {s.pending_proposals > 0 && (
        <span className="badge proposed">{t("home.unreviewed", { count: s.pending_proposals })}</span>
      )}
      {s.latest_version_no != null && (
        <span className="badge quiet">v{s.latest_version_no}</span>
      )}
      {s.latest_generation && (
        <span
          className={`badge ${
            s.latest_generation === "succeeded"
              ? "adopted"
              : s.latest_generation === "failed"
                ? "recheck"
                : "proposed"
          }`}
        >
          {t(GEN_LABEL[s.latest_generation])}
        </span>
      )}
    </span>
  );
}

export function ProjectList(props: {
  projects: ProjectListItem[];
  currentId: string | null;
  onOpen: (p: Project) => void;
  onCreate: (name: string, idea?: string) => Promise<void>;
  onArchive: (p: ProjectListItem, archived: boolean) => Promise<void>;
  onDelete: (p: ProjectListItem) => Promise<void>;
  onListArchived: () => Promise<ProjectListItem[]>;
  onError: (e: unknown) => void;
}) {
  const { t, formatDate } = useI18n();
  const [idea, setIdea] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<ProjectListItem[] | null>(null);
  const [archBusy, setArchBusy] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<"archive" | "delete" | "restore">(
    "archive",
  );

  const toggleEdit = () => {
    setEditMode((v) => !v);
    setSel(new Set());
  };
  const toggleSel = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Bulk run: the action is chosen by the header toggle, then the
  // execute button applies it to every checked work. Delete always
  // confirms first — it is the only irreversible action.
  const run = () => {
    if (archBusy || sel.size === 0) return;
    const list = (showArchived ? archived ?? [] : props.projects).filter((p) =>
      sel.has(p.id),
    );
    if (
      action === "delete" &&
      !window.confirm(t("home.deleteConfirmBulk", { count: list.length }))
    )
      return;
    setArchBusy(true);
    (async () => {
      for (const p of list) {
        if (action === "archive") await props.onArchive(p, true);
        else if (action === "restore") await props.onArchive(p, false);
        else await props.onDelete(p);
      }
    })()
      .then(() => props.onListArchived())
      .then(setArchived)
      .catch(props.onError)
      .finally(() => {
        setSel(new Set());
        setArchBusy(false);
      });
  };

  const toggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    setEditMode(false);
    setSel(new Set());
    setAction(next ? "restore" : "archive");
    if (next && archived === null) {
      props
        .onListArchived()
        .then(setArchived)
        .catch(props.onError);
    }
  };



  const start = () => {
    const text = idea.trim();
    if (!text || busy) return;
    const autoName =
      text.replace(/\s+/g, " ").slice(0, 30) || t("home.newWork");
    setBusy(true);
    props
      .onCreate(name.trim() || autoName, text)
      .then(() => {
        setIdea("");
        setName("");
      })
      .catch(props.onError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="home-inner">
      <section className="card hero">
        <h2 className="hero-q">{t("home.question")}</h2>
        <p className="muted">
          {t("home.intro")}
        </p>
        <textarea
          className="hero-input"
          placeholder={t("home.ideaPlaceholder")}
          value={idea}
          rows={3}
          onChange={(e) => setIdea(e.target.value)}
        />
        <div className="chips">
          {IDEA_EXAMPLES.map((key) => (
            <button
              key={key}
              className="chip"
              onClick={() => setIdea(t(key))}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <p className="muted small">
          {t("home.exampleHint")}
        </p>
        <details className="subtle">
          <summary className="muted">
            {t("home.nameOptional")}
          </summary>
          <input
            placeholder={t("home.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </details>
        <button
          className="primary primary-block"
          disabled={!idea.trim() || busy}
          onClick={start}
        >
          {busy ? t("home.starting") : t("home.start")}
        </button>
        <p className="muted small">
          {t("home.initialConsult")}
        </p>
      </section>

      <section className="home-works">
        <div className="home-works-head">
          <h2>{showArchived ? t("home.archivedTitle") : t("home.library")}</h2>
          <span className="muted small">
            {showArchived
              ? t("home.archivedCount", { count: archived?.length ?? 0 })
              : t("home.workCount", { count: props.projects.length })}
          </span>
          <span className="works-head-actions">
            {editMode ? (
              <>
                <span className="muted small">
                  {t("home.selectedCount", { count: sel.size })}
                </span>
                <select
                  className="work-action-select"
                  value={action}
                  onChange={(e) =>
                    setAction(
                      e.target.value as "archive" | "delete" | "restore",
                    )
                  }
                >
                  {showArchived ? (
                    <option value="restore">{t("home.restoreSelected")}</option>
                  ) : (
                    <option value="archive">{t("home.archiveSelected")}</option>
                  )}
                  <option value="delete">{t("home.deleteSelected")}</option>
                </select>
                <button
                  className={`ghost work-arch-toggle${action === "delete" ? " danger" : ""}`}
                  disabled={sel.size === 0 || archBusy}
                  onClick={run}
                >
                  {t("home.run")}
                </button>
                <button
                  className="ghost work-arch-toggle"
                  disabled={sel.size === 0}
                  onClick={() => setSel(new Set())}
                >
                  {t("home.clearSelection")}
                </button>
              </>
            ) : null}
            <button className="ghost work-arch-toggle" onClick={toggleArchived}>
              {showArchived ? t("home.backToLibrary") : t("home.showArchived")}
            </button>
            <button
              className={`ghost work-arch-toggle${editMode ? " active" : ""}`}
              onClick={toggleEdit}
            >
              {editMode ? t("home.editDone") : t("home.edit")}
            </button>
          </span>
        </div>
        {showArchived ? (
          archived === null ? (
            <p className="muted small">{t("home.archivedLoading")}</p>
          ) : archived.length === 0 ? (
            <div className="empty">
              <p>{t("home.archivedEmpty")}</p>
            </div>
          ) : (
            <div className="work-grid">
              {archived.map((p) => {
                const thumbId = p.summary.latest_output_asset_id;
                return (
                  <div
                    key={p.id}
                    className={`work-card archived${sel.has(p.id) ? " selected" : ""}`}
                  >
                    {editMode && (
                      <input
                        type="checkbox"
                        className="work-check"
                        checked={sel.has(p.id)}
                        onChange={() => toggleSel(p.id)}
                        aria-label={p.name}
                      />
                    )}
                    <button
                      className="work-open"
                      onClick={() => (editMode ? toggleSel(p.id) : props.onOpen(p))}
                    >
                      <span className="work-thumb archived">
                        {thumbId && p.summary.latest_output_kind === "video" ? (
                          <video
                            src={assetUrl(thumbId)}
                            muted
                            playsInline
                            preload="metadata"
                          />
                        ) : thumbId ? (
                          <img src={assetUrl(thumbId)} alt="" />
                        ) : (
                          <span className="work-mono" aria-hidden>
                            {p.name.trim().charAt(0) ||
                              (t("projects.w"))}
                          </span>
                        )}
                      </span>
                      <span className="work-meta">
                        <span className="work-name">{p.name}</span>
                        <span className="muted work-date">
                          {t("home.archivedAt", {
                            date: formatDate(p.archived_at ?? p.updated_at),
                          })}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <>
            {props.projects.length === 0 && (
              <div className="home-empty">
                <Icon name="sparkles" />
                <p className="empty-title">{t("home.empty")}</p>
                <p className="muted small">{t("home.emptyHint")}</p>
              </div>
            )}
            <div className="work-grid">
              {props.projects.map((p) => {
                const s = p.summary;
                const thumbId = s.latest_output_asset_id;
                const live =
                  s.latest_generation === "running" ||
                  s.latest_generation === "queued";
                return (
                  <div
                    key={p.id}
                    className={`work-card${sel.has(p.id) ? " selected" : ""}`}
                  >
                    {editMode && (
                      <input
                        type="checkbox"
                        className="work-check"
                        checked={sel.has(p.id)}
                        onChange={() => toggleSel(p.id)}
                        aria-label={p.name}
                      />
                    )}
                    <button
                      className="work-open"
                      onClick={() => (editMode ? toggleSel(p.id) : props.onOpen(p))}
                    >
                      <span className="work-thumb">
                        {thumbId && s.latest_output_kind === "video" ? (
                          <video
                            src={assetUrl(thumbId)}
                            muted
                            playsInline
                            preload="metadata"
                          />
                        ) : thumbId ? (
                          <img src={assetUrl(thumbId)} alt="" />
                        ) : (
                          <span className="work-mono" aria-hidden>
                            {p.name.trim().charAt(0) ||
                              (t("projects.w2"))}
                          </span>
                        )}
                        {live && (
                          <span className="work-thumb-live">
                            {t("home.generation.running")}
                          </span>
                        )}
                      </span>
                      <span className="work-meta">
                        <span className="work-name">{p.name}</span>
                        <SummaryChips item={p} />
                        <span className="muted work-date">
                          {formatDate(p.updated_at)}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
