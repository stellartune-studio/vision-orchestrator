import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Project,
  ProjectListItem,
  ProjectState,
  ServerMeta,
} from "@vo/shared";
import { api, describeError } from "./api/client.ts";
import { ProjectList } from "./features/projects.tsx";
import { ChatPanel, type AmendTarget } from "./features/chat.tsx";
import { ContentPanel, type ContentTab } from "./features/content.tsx";
import { NextStepStrip, StatusPanel } from "./features/summary.tsx";
import { CharactersPanel } from "./features/characters.tsx";
import { GenerationPanel } from "./features/generation.tsx";
import { WorkbenchDesignPanel } from "./features/workbench-design.tsx";
import { ReviewPanel } from "./features/review.tsx";
import { I18nProvider, useI18n } from "./i18n.tsx";
import { ThemeControl, ThemeProvider } from "./theme.tsx";
import {
  EditToolsPanel,
  isWorkMode,
  ModeBar,
  ModeToolsPanel,
  type WorkMode,
} from "./features/modes.tsx";
import { sceneDraftReviewBackups } from "./features/sceneDraftReviewStorage.ts";
import { Icon } from "./features/icon.tsx";
import { useDetailsDismiss } from "./useDetailsDismiss.ts";

type Pane = "chat" | "content" | "generate" | "characters";
type LeftTab = "chat" | "material";
type SideTab = "mode" | "design" | "review" | "items" | "docs" | "tools" | "status";
type SideGroup = "setup" | "content" | "status";

// The shared-edit-tools catalog is preview-only; hidden until real
// ComfyUI/FFmpeg tools land. Actual trim + subtitle editing lives on
// the Stage via VideoEditPanel for successful video results.
const SHOW_EDIT_TOOLS_CATALOG = false;

const SIDE_GROUPS: {
  key: SideGroup;
  labelKey: string;
  tabs: { key: SideTab; labelKey: string }[];
}[] = [
  {
    key: "setup",
    labelKey: "app.sideGroup.setup",
    tabs: [
      { key: "mode", labelKey: "app.modeTools" },
      { key: "design", labelKey: "app.sharedDesign" },
      ...(SHOW_EDIT_TOOLS_CATALOG
        ? [{ key: "tools" as SideTab, labelKey: "app.editTools" }]
        : []),
    ],
  },
  {
    key: "content",
    labelKey: "app.sideGroup.content",
    tabs: [
      { key: "items", labelKey: "app.items" },
      { key: "docs", labelKey: "app.docs" },
    ],
  },
  {
    key: "status",
    labelKey: "app.sideGroup.status",
    tabs: [
      { key: "review", labelKey: "app.review" },
      { key: "status", labelKey: "app.status" },
    ],
  },
];

const SIDE_GROUP_OF: Record<SideTab, SideGroup> = {
  mode: "setup",
  design: "setup",
  tools: "setup",
  items: "content",
  docs: "content",
  review: "status",
  status: "status",
};

const NARROW_PANES: { key: Pane; labelKey: string }[] = [
  { key: "chat", labelKey: "app.chat" },
  { key: "content", labelKey: "app.content" },
  { key: "generate", labelKey: "app.generate" },
  { key: "characters", labelKey: "app.more" },
];

const LEFT_TABS: { key: LeftTab; labelKey: string }[] = [
  { key: "chat", labelKey: "app.chat" },
  { key: "material", labelKey: "app.material" },
];



const LAST_PROJECT_KEY = "vo.lastProjectId";
const MODE_KEY = (projectId: string) => `vo.mode.${projectId}`;
const PANEL_W_KEY = "vo.panelWidths";
const PANEL_W_MIN = 220;
const PANEL_W_MAX = 640;

function clampPanelWidth(px: number): number {
  return Math.max(PANEL_W_MIN, Math.min(PANEL_W_MAX, Math.round(px)));
}

function readPanelWidths(): { left: number; right: number } {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(PANEL_W_KEY) ?? "null",
    ) as { left?: number; right?: number } | null;
    return {
      left: typeof parsed?.left === "number" ? clampPanelWidth(parsed.left) : 280,
      right:
        typeof parsed?.right === "number" ? clampPanelWidth(parsed.right) : 430,
    };
  } catch {
    return { left: 280, right: 430 };
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function pendingCount(state: ProjectState): number {
  return (
    state.items.reduce((n, i) => n + i.pending_proposals.length, 0) +
    state.documents.reduce((n, d) => n + d.pending_proposals.length, 0)
  );
}

function MetaBadges({ meta }: { meta: ServerMeta | null }) {
  const { t } = useI18n();
  const envRef = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(envRef);
  if (!meta) return null;
  // MOCK stays a standing flag; provider details fold into one
  // popover so the top bar keeps the work, not the environment.
  return (
    <>
      {meta.mock && <span className="badge mock">MOCK</span>}
      <details className="env-control" ref={envRef}>
        <summary title={t("app.environment")}>{t("app.environment")}</summary>
        <div className="env-menu">
          <dl>
            <div className="env-row">
              <dt>{t("app.llm")}</dt>
              <dd>{meta.llm_provider}</dd>
            </div>
            <div className="env-row">
              <dt>{t("app.generator")}</dt>
              <dd>{meta.gen_backend}</dd>
            </div>
            {meta.gen_profile && (
              <div className="env-row">
                <dt>{t("app.genProfile")}</dt>
                <dd>{meta.gen_profile}</dd>
              </div>
            )}
            <div className="env-row">
              <dt>{t("app.genKinds")}</dt>
              <dd>{meta.gen_kinds.join(", ")}</dd>
            </div>
            <div className="env-row">
              <dt>{t("app.nodeVersion")}</dt>
              <dd>{meta.node}</dd>
            </div>
          </dl>
          {meta.mock && <p className="env-note">{t("app.envMockNote")}</p>}
        </div>
      </details>
    </>
  );
}

export function App() {
  return <ThemeProvider><I18nProvider><AppContent /></I18nProvider></ThemeProvider>;
}

function LanguageControl() {
  const { language, setLanguage, t } = useI18n();
  return <label className="language-control"><span className="sr-only">{t("app.chooseLanguage")}</span><select aria-label={t("app.chooseLanguage")} value={language} onChange={(e) => setLanguage(e.target.value === "en" ? "en" : "ja")} title={t("app.languageScope")}><option value="ja">{t("app.japanese")}</option><option value="en">{t("app.english")}</option></select></label>;
}

function AppContent() {
  const { t } = useI18n();
  const latestT = useRef(t);
  latestT.current = t;
  const [memoryOnlyReviewInput, setMemoryOnlyReviewInput] = useState(() =>
    sceneDraftReviewBackups.hasMemoryOnlyUnsaved(),
  );
  const [meta, setMeta] = useState<ServerMeta | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [current, setCurrent] = useState<Project | null>(null);
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [pane, setPane] = useState<Pane>("chat");
  const [contentTab, setContentTab] = useState<ContentTab>("items");
  // The idea typed on the home screen, auto-sent once as the first
  // consultation — keyed to the project it was created for so it can
  // never ride along to another work or resend after a reload.
  const [firstIdea, setFirstIdea] = useState<{
    projectId: string;
    text: string;
  } | null>(null);
  // The revision a chat instruction will amend — keyed to the project
  // so switching works can never carry a directive across.
  const [amendTarget, setAmendTarget] = useState<{
    projectId: string;
    docId: string;
    revId: string;
  } | null>(null);
  // A saved outcome's own base↔result pair to show in the docs pane —
  // cleared on project switch so it can never point at another work.
  const [docFocus, setDocFocus] = useState<{
    documentId: string;
    baseRevisionId: string;
    resultRevisionId: string;
  } | null>(null);
  const narrow = useMediaQuery("(max-width: 1100px)");
  // Studio (wide) layout — the work keeps the central stage; side
  // panels collapse to edge rails so consulting/adjusting never
  // pushes the piece off screen.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  // Panel widths are drag-adjustable view state — like the panel
  // open/closed flags, they are saved locally, never on the work.
  // The edge rail is one affordance: click toggles, drag resizes.
  const [panelW, setPanelW] = useState(readPanelWidths);
  const edgeDrag = useRef<{
    side: "left" | "right";
    startX: number;
    startW: number;
    moved: boolean;
  } | null>(null);
  // The click that ends a real drag must not toggle the panel.
  const suppressEdgeClick = useRef(false);

  const edgePointerDown = useCallback(
    (side: "left" | "right") => (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      edgeDrag.current = {
        side,
        startX: e.clientX,
        startW: side === "left" ? panelW.left : panelW.right,
        moved: false,
      };
    },
    [panelW],
  );

  useEffect(() => {
    const persist = (w: { left: number; right: number }) => {
      try {
        localStorage.setItem(PANEL_W_KEY, JSON.stringify(w));
      } catch {
        /* Storage may be unavailable. */
      }
    };
    const onMove = (ev: PointerEvent) => {
      const d = edgeDrag.current;
      if (!d) return;
      if (!d.moved && Math.abs(ev.clientX - d.startX) <= 4) return;
      if (!d.moved) {
        d.moved = true;
        document.body.classList.add("panel-resizing");
        // Pulling a collapsed rail outward opens it at the dragged
        // width instead of leaving the change invisible.
        if (d.side === "left") setLeftOpen(true);
        else setRightOpen(true);
      }
      const sign = d.side === "left" ? 1 : -1;
      setPanelW((prev) => ({
        ...prev,
        [d.side]: clampPanelWidth(d.startW + sign * (ev.clientX - d.startX)),
      }));
    };
    const onUp = () => {
      const d = edgeDrag.current;
      if (!d) return;
      edgeDrag.current = null;
      if (d.moved) {
        document.body.classList.remove("panel-resizing");
        suppressEdgeClick.current = true;
        setPanelW((prev) => {
          persist(prev);
          return prev;
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("panel-resizing");
    };
  }, []);

  const toggleEdge = useCallback(
    (side: "left" | "right") => () => {
      if (suppressEdgeClick.current) {
        suppressEdgeClick.current = false;
        return;
      }
      if (side === "left") setLeftOpen((v) => !v);
      else setRightOpen((v) => !v);
    },
    [],
  );
  const [leftTab, setLeftTab] = useState<LeftTab>("chat");
  const [sideTab, setSideTab] = useState<SideTab>("items");
  // Last leaf chosen inside each group, so returning to a group
  // restores the panel the user was actually looking at.
  const [sideLeaf, setSideLeaf] = useState<Record<SideGroup, SideTab>>({
    setup: "mode",
    content: "items",
    status: "review",
  });
  // The workbench mode is pure view state — it never mutates the work.
  // Remembered per project so a reload returns to the same desk.
  const [mode, setMode] = useState<WorkMode>("freestyle");
  const switcherRef = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(switcherRef);

  // Review panels are replaced when works and panes change. Keep the one
  // beforeunload listener at App lifetime and derive it from every target in
  // the shared backup store, including targets no longer mounted.
  useEffect(() => sceneDraftReviewBackups.subscribe(() => {
    setMemoryOnlyReviewInput(sceneDraftReviewBackups.hasMemoryOnlyUnsaved());
  }), []);

  useEffect(() => {
    if (!memoryOnlyReviewInput) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [memoryOnlyReviewInput]);

  // Open-project generation: bumped on every open/close, so an async
  // completion issued under an older stint (A→B, or A→B→A) can never
  // apply its state or error to the screen now showing. Aborting the
  // fetch is only an optimization — the server still completes its
  // work; this guard only decides what the UI may adopt.
  const epoch = useRef(0);
  const openProjectId = useRef<string | null>(null);
  // Latest state GET issued — a response may only apply while no newer
  // request exists, so out-of-order replies cannot roll the view back.
  const stateReqSeq = useRef(0);
  const mayApply = (ep: number, pid: string | null) =>
    epoch.current === ep && openProjectId.current === pid;

  const selectPane = useCallback((p: Pane, tab?: ContentTab) => {
    setPane(p);
    if (p === "content" && tab) setContentTab(tab);
  }, []);

  const selectSideTab = useCallback((tab: SideTab) => {
    setSideTab(tab);
    const group = SIDE_GROUP_OF[tab];
    setSideLeaf((prev) =>
      prev[group] === tab ? prev : { ...prev, [group]: tab },
    );
  }, []);

  const selectSideGroup = useCallback(
    (group: SideGroup) => {
      if (SIDE_GROUP_OF[sideTab] === group) return;
      setSideTab(sideLeaf[group]);
    },
    [sideTab, sideLeaf],
  );

  // One navigation entry for both layouts: narrow mode switches the
  // single pane; the studio keeps the stage central and reveals the
  // matching side panel instead of swapping the work out.
  const focusArea = useCallback(
    (p: Pane, tab?: ContentTab) => {
      if (narrow) {
        selectPane(p, tab);
        return;
      }
      if (p === "content") {
        setRightOpen(true);
        selectSideTab(tab ?? "items");
        if (tab) setContentTab(tab);
      } else if (p === "characters") {
        // The unified character place is the Shared design → Character
        // sheet; the left "material" tab only holds a pointer to it.
        setRightOpen(true);
        selectSideTab("design");
      } else if (p === "chat") {
        setLeftOpen(true);
        setLeftTab("chat");
      }
      // "generate" is always on the central stage — nothing to reveal
    },
    [narrow, selectPane, selectSideTab],
  );

  // Pinned per render: callbacks handed to a panel keep the stint they
  // were created under — an older panel's completion must not pick up
  // the CURRENT epoch and run work under it.
  const renderedEpoch = epoch.current;
  const renderedProjectId = current?.id ?? null;

  const refresh = useCallback(async () => {
    if (!current) return;
    const ep = renderedEpoch; // fixed at creation, not read at call time
    const pid = current.id;
    if (!mayApply(ep, pid)) return; // stale stint — don't even issue
    const seq = ++stateReqSeq.current;
    try {
      const s = await api.state(pid);
      if (mayApply(ep, pid) && seq === stateReqSeq.current) setState(s);
    } catch (e) {
      // A stale request must not raise an error on the current screen
      // either — same guard as the success path.
      if (mayApply(ep, pid) && seq === stateReqSeq.current) {
        setError(latestT.current("app.stateLoadFailed", { error: describeError(e) }));
      }
    }
  }, [current, renderedEpoch]);

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
      setListFailed(false);
      setError(null);
    } catch (e) {
      setListFailed(true);
      setError(latestT.current("app.projectListFailed", { error: describeError(e) }));
    }
  }, []);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
    void loadProjects();
  }, [loadProjects]);

  // Reopen the last project after a reload — state resumes server-side,
  // including polling of generations still in flight.
  useEffect(() => {
    if (current || projects.length === 0) return;
    const saved = sessionStorage.getItem(LAST_PROJECT_KEY);
    const found = saved ? projects.find((p) => p.id === saved) : undefined;
    if (found) void openProject(found);
    else if (saved) sessionStorage.removeItem(LAST_PROJECT_KEY);
  }, [projects]);

  useEffect(() => {
    if (!current) {
      setState(null);
      return;
    }
    // The epoch captured here belongs to THIS open; a slower load from
    // a previous stint must not win the race and overwrite it.
    const ep = epoch.current;
    const pid = current.id;
    setState(null);
    const seq = ++stateReqSeq.current;
    api
      .state(pid)
      .then((s) => {
        if (mayApply(ep, pid) && seq === stateReqSeq.current) setState(s);
      })
      .catch((e) => {
        if (mayApply(ep, pid) && seq === stateReqSeq.current) {
          setError(latestT.current("app.stateLoadFailed", { error: describeError(e) }));
        }
      });
  }, [current]);

  const onError = async (e: unknown) => {
    if (!mayApply(renderedEpoch, renderedProjectId)) return;
    const err = e as { message?: string; status?: number };
    setError(
      err.status === 409
        ? t("app.updateConflict", { error: err.message ?? "" })
        : err.status === 422
          ? t("app.preconditionsMissing", { error: err.message ?? "" })
          : describeError(e),
    );
    await refresh();
  };

  const openProject = async (p: Project) => {
    // A new stint: older in-flight work may still complete server-side,
    // but its result belongs to the project that issued it — reopening
    // that project shows it, never this one.
    epoch.current++;
    openProjectId.current = p.id;
    setError(null);
    setFlash(null);
    setCurrent(p);
    setDocFocus(null);
    const savedMode = sessionStorage.getItem(MODE_KEY(p.id));
    setMode(isWorkMode(savedMode) ? savedMode : "freestyle");
    sessionStorage.setItem(LAST_PROJECT_KEY, p.id);
  };

  // Switching the workbench mode only rearranges tools and panels —
  // it never touches the work, its materials, or its history.
  const selectMode = (m: WorkMode) => {
    if (m === mode) return;
    setMode(m);
    if (current) sessionStorage.setItem(MODE_KEY(current.id), m);
    if (!narrow) {
      // Surface the mode's own tool tab so the switch is visible; the
      // panels themselves (consultation, materials, history) persist.
      setRightOpen(true);
      selectSideTab("mode");
    }
  };

  const closeProject = () => {
    epoch.current++;
    openProjectId.current = null;
    setCurrent(null);
    setAmendTarget(null);
    setDocFocus(null);
    setFlash(null);
    sessionStorage.removeItem(LAST_PROJECT_KEY);
  };

  const createProject = async (name: string, idea?: string) => {
    const p = await api.createProject(name);
    setProjects((prev) => [p, ...prev]);
    await openProject(p);
    if (idea?.trim()) setFirstIdea({ projectId: p.id, text: idea.trim() });
  };

  const pending = state ? pendingCount(state) : 0;
  const sideGroupDef =
    SIDE_GROUPS.find((g) => g.key === SIDE_GROUP_OF[sideTab]) ??
    SIDE_GROUPS[1];

  // Resolve the amendment target against live state: details shown in
  // the chat banner come from the actual revision, not a frozen copy.
  const amendTargetForChat: AmendTarget | null = (() => {
    if (!amendTarget || amendTarget.projectId !== current?.id || !state) {
      return null;
    }
    const doc = state.documents.find((d) => d.id === amendTarget.docId);
    const rev = doc?.revisions.find((r) => r.id === amendTarget.revId);
    if (!doc || !rev) return null;
    return {
      revisionId: rev.id,
      documentId: doc.id,
      docTitle: doc.title,
      docKind: doc.kind,
      revNo: rev.rev_no,
      blueprintVersionNo:
        state.blueprint_versions.find(
          (v) => v.id === rev.blueprint_version_id,
        )?.version_no ?? null,
    };
  })();
  const amendTargetStale =
    !!amendTarget && amendTarget.projectId === current?.id && !amendTargetForChat;

  const startAmendChat = (docId: string, revId: string) => {
    if (!current) return;
    setAmendTarget({ projectId: current.id, docId, revId });
    focusArea("chat");
  };

  const renderPane = (p: Pane) => {
    if (!state) return null;
    switch (p) {
      case "chat":
        return (
          // key by project: switching works remounts the panel so an
          // unsent instruction can never ride along to another project
          <ChatPanel
            key={state.project.id}
            project={state.project}
            messages={state.messages}
            adoptedItems={state.items.filter(
              (i) => i.adoption === "adopted",
            )}
            amendTarget={amendTargetForChat}
            amendTargetStale={amendTargetStale}
            initialMessage={
              firstIdea && firstIdea.projectId === state.project.id
                ? firstIdea.text
                : null
            }
            outcomes={state.amendment_outcomes}
            documents={state.documents}
            onClearAmendTarget={() => setAmendTarget(null)}
            onOpenDocument={(o) => {
              if (o.result_revision_id) {
                setDocFocus({
                  documentId: o.document_id,
                  baseRevisionId: o.base_revision_id,
                  resultRevisionId: o.result_revision_id,
                });
              }
              focusArea("content", "docs");
            }}
            onChanged={refresh}
            onError={onError}
            onOpenReview={() => focusArea("content")}
            pendingCount={pending}
          />
        );
      case "content":
        return (
          <ContentPanel
            key={state.project.id}
            state={state}
            tab={contentTab}
            onTabChange={setContentTab}
            docFocus={docFocus}
            onAmendWithAI={startAmendChat}
            onChanged={refresh}
            onError={onError}
          />
        );
      case "generate":
        return (
          <GenerationPanel
            key={state.project.id}
            state={state}
            meta={meta}
            mode={mode}
            onChanged={refresh}
            onError={onError}
            onSelect={focusArea}
            onAmendDoc={startAmendChat}
            onFlash={setFlash}
            onReview={() => { setRightOpen(true); selectSideTab("review"); }}
          />
        );
      case "characters":
        // Narrow layout has no right panel — the "characters" pane
        // opens the unified character sheet directly (Character tab
        // is the design panel's default).
        return (
          <WorkbenchDesignPanel
            mode={mode}
            state={state}
            onChanged={refresh}
            onError={onError}
          />
        );
    }
  };

  // Never render a state whose project differs from the open one —
  // between the switch and the fresh load, the old project's screen
  // must not stay editable or sendable.
  if (!current || !state || state.project.id !== current.id) {
    return (
      <div className="app">
        <header className="topbar">
          <h1 className="brand">{t("app.brand")}</h1>
          <span className="muted">{t("app.subtitle")}</span>
          <span className="topbar-badges">
            <LanguageControl />
            <ThemeControl />
            <MetaBadges meta={meta} />
          </span>
        </header>
        {error && (
          <div className="error" role="alert">
            <span className="error-text">{error}</span>
            <button className="ghost" onClick={() => void loadProjects()}>
              {t("app.reload")}
            </button>
            <button className="ghost" onClick={() => setError(null)}>
              {t("app.close")}
            </button>
          </div>
        )}
        {memoryOnlyReviewInput && (
          <p className="warn-text small" role="status">
            {t("app.memoryOnlyWarning")}
          </p>
        )}
        <main className="home">
          {listFailed ? (
            <section className="card">
              <h2>{t("app.serverUnavailable")}</h2>
              <p className="muted">
                {t("app.projectListUnavailable")}
              </p>
              <button className="primary" onClick={() => void loadProjects()}>
                {t("app.reload")}
              </button>
            </section>
          ) : (
            <ProjectList
              projects={projects}
              currentId={current?.id ?? null}
              onOpen={openProject}
              onCreate={createProject}
              onArchive={async (p, archived) => {
                await api.setProjectArchived(p.id, archived);
                await loadProjects();
              }}
              onDelete={async (p) => {
                await api.deleteProject(p.id);
                await loadProjects();
              }}
              onListArchived={() => api.listProjects(true)}
              onError={onError}
            />
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="ghost" onClick={closeProject}>
          ← {t("app.projectList")}
        </button>
        <h1 className="topbar-title">{state.project.name}</h1>
        {!narrow && (
          <details className="top-switcher" ref={switcherRef}>
            <summary title={t("app.openWork")}>
              {t("app.switchWork", { count: projects.length })}
            </summary>
            <div className="top-switcher-menu">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={
                    p.id === current.id ? "nav-item active" : "nav-item"
                  }
                  onClick={() => {
                    switcherRef.current?.removeAttribute("open");
                    void openProject(p);
                  }}
                >
                  {p.name}
                </button>
              ))}
              <button
                className="nav-item"
                onClick={() => {
                  switcherRef.current?.removeAttribute("open");
                  closeProject();
                }}
              >
                ＋ {t("app.newWork")}
              </button>
            </div>
          </details>
        )}
        {pending > 0 && (
          <button
            className="chip chip-warn"
            onClick={() => focusArea("content")}
            title={t("app.reviewProposals")}
          >
            {t("home.unreviewed", { count: pending })}
          </button>
        )}
        <span className="topbar-badges">
          <LanguageControl />
          <ThemeControl />
          <MetaBadges meta={meta} />
        </span>
      </header>

      {error && (
        <div className="error" role="alert">
          <span className="error-text">{error}</span>
          <button
            className="ghost"
            onClick={() => {
              setError(null);
              void refresh();
            }}
          >
            {t("app.reload")}
          </button>
          <button className="ghost" onClick={() => setError(null)}>
          {t("app.close")}
          </button>
        </div>
      )}

      {flash && (
        <div className="notice ok" role="status">
          <span className="error-text">{flash}</span>
          <button className="ghost" onClick={() => setFlash(null)}>
          {t("app.close")}
          </button>
        </div>
      )}

      {memoryOnlyReviewInput && (
        <p className="warn-text small" role="status">
          {t("app.memoryOnlyWarning")}
        </p>
      )}

      {narrow && (
        <nav className="panebar" role="tablist" aria-label={t("app.panelNavigation")}>
          {NARROW_PANES.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={pane === p.key}
              className={pane === p.key ? "tab active" : "tab"}
              onClick={() => selectPane(p.key)}
            >
              {t(p.labelKey)}
              {p.key === "content" && pending > 0 && (
                <span className="count">{pending}</span>
              )}
            </button>
          ))}
        </nav>
      )}

      {narrow && (
        <NextStepStrip
          state={state}
          meta={meta}
          onSelect={selectPane}
        />
      )}

      {narrow ? (
        // Every pane stays mounted; switching tabs only hides it.
        // Remounting on each hop would drop unsent drafts, the chosen
        // take, compare pins, and fold state — the desktop studio
        // keeps them because all panes are mounted there too.
        <main className="pane single">
          {NARROW_PANES.map((p) => (
            <div key={p.key} className="pane-slot" hidden={pane !== p.key}>
              {renderPane(p.key)}
            </div>
          ))}
        </main>
      ) : (
        // Desktop studio: one shared workbench. Consultation and
        // materials on the left, the work's stage in the centre, and
        // mode tools / content / editing / status on the right. The
        // mode bar rearranges tools only — the work stays put.
        <>
          <ModeBar mode={mode} onChange={selectMode} />
          <div
            className="studio"
            key={current.id}
            style={
              {
                "--left-w": `${panelW.left}px`,
                "--right-w": `${panelW.right}px`,
              } as React.CSSProperties
            }
          >
            <aside className={`spanel sp-left${leftOpen ? "" : " closed"}`}>
              <div className="spanel-body">
                <nav
                  className="spanel-tabs"
                  role="tablist"
                  aria-label={t("app.leftNavigation")}
                >
                  {LEFT_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      role="tab"
                      aria-selected={leftTab === tab.key}
                      className={leftTab === tab.key ? "tab active" : "tab"}
                      onClick={() => setLeftTab(tab.key)}
                    >
                      {t(tab.labelKey)}
                    </button>
                  ))}
                </nav>
                {leftTab === "chat" ? (
                  <div className="spanel-fill">{renderPane("chat")}</div>
                ) : (
                  <div className="spanel-scroll">
                    <CharactersPanel
                      state={state}
                      onOpenCharacterDesign={() => focusArea("characters")}
                    />
                  </div>
                )}
              </div>
              <button
                className="spanel-edge"
                onClick={toggleEdge("left")}
                onPointerDown={edgePointerDown("left")}
                aria-expanded={leftOpen}
                aria-label={leftOpen ? t("app.closeConsult") : t("app.openConsult")}
                title={`${leftOpen ? t("app.closeConsult") : t("app.openConsult")} — ${t("app.resizePanel")}`}
              >
                <span className="spanel-edge-icon" aria-hidden><Icon name={leftOpen ? "chevron-left" : "chevron-right"} /></span>
                <span className="spanel-edge-label">
                  {leftTab === "chat" ? t("app.chat") : t("app.material")}
                </span>
              </button>
            </aside>

            <main className="stage">{renderPane("generate")}</main>

          <aside className={`spanel sp-right${rightOpen ? "" : " closed"}`}>
            <button
              className="spanel-edge"
              onClick={toggleEdge("right")}
              onPointerDown={edgePointerDown("right")}
              aria-expanded={rightOpen}
              aria-label={rightOpen ? t("app.closeContent") : t("app.openContent")}
              title={`${rightOpen ? t("app.closeContent") : t("app.openContent")} — ${t("app.resizePanel")}`}
            >
              <span className="spanel-edge-icon" aria-hidden><Icon name={rightOpen ? "chevron-right" : "chevron-left"} /></span>
              <span className="spanel-edge-label">{t("app.content")}</span>
            </button>
            <div className="spanel-body">
              <nav
                className="spanel-groups"
                role="tablist"
                aria-label={t("app.rightNavigation")}
              >
                {SIDE_GROUPS.map((group) => {
                  const active = SIDE_GROUP_OF[sideTab] === group.key;
                  return (
                    <button
                      key={group.key}
                      role="tab"
                      aria-selected={active}
                      className={active ? "group-tab active" : "group-tab"}
                      onClick={() => selectSideGroup(group.key)}
                    >
                      {t(group.labelKey)}
                      {group.key === "content" && pending > 0 && (
                        <span className="count">{pending}</span>
                      )}
                    </button>
                  );
                })}
              </nav>
              <nav
                className="spanel-tabs spanel-subtabs"
                role="tablist"
                aria-label={t(sideGroupDef.labelKey)}
              >
                {sideGroupDef.tabs.map((tab) => (
                  <button
                    key={tab.key}
                    role="tab"
                    aria-selected={sideTab === tab.key}
                    className={sideTab === tab.key ? "tab active" : "tab"}
                    onClick={() => {
                      selectSideTab(tab.key);
                      if (tab.key === "items" || tab.key === "docs") {
                        setContentTab(tab.key);
                      }
                    }}
                  >
                    {t(tab.labelKey)}
                    {tab.key === "items" && pending > 0 && (
                      <span className="count">{pending}</span>
                    )}
                  </button>
                ))}
              </nav>
              <div className="spanel-scroll">
                <div hidden={sideTab !== "mode"}>
                  <ModeToolsPanel mode={mode} state={state} onChanged={refresh} onError={onError} />
                </div>
                <div hidden={sideTab !== "design"}>
                  <WorkbenchDesignPanel
                    mode={mode}
                    state={state}
                    onChanged={refresh}
                    onError={onError}
                  />
                </div>
                <div hidden={sideTab !== "review"}><ReviewPanel key={state.project.id} state={state} /></div>
                {(sideTab === "items" || sideTab === "docs") && (
                  <ContentPanel
                    key={state.project.id}
                    state={state}
                    tab={sideTab}
                    embedded
                    onTabChange={(t) => {
                      selectSideTab(t);
                      setContentTab(t);
                    }}
                    docFocus={docFocus}
                    onAmendWithAI={startAmendChat}
                    onChanged={refresh}
                    onError={onError}
                  />
                )}
                {SHOW_EDIT_TOOLS_CATALOG && sideTab === "tools" && (
                  <EditToolsPanel />
                )}
                {sideTab === "status" && (
                  <StatusPanel
                    state={state}
                    meta={meta}
                    onChanged={refresh}
                    onError={onError}
                    onSelect={focusArea}
                  />
                )}
              </div>
            </div>
          </aside>
          </div>
        </>
      )}
    </div>
  );
}
