import { Fragment, useState, type ReactNode } from "react";
import type { ProjectState } from "@vo/shared";
import { useI18n } from "../i18n.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { StorySceneProposals } from "./storySceneProposals.tsx";
import { PromotionProposal } from "./promotionProposal.tsx";
import { AnimationShots } from "./animationShots.tsx";
import { MvLyrics } from "./mvLyrics.tsx";
import { AssetShelf } from "./assetShelf.tsx";
import { PosterProposal } from "./posterProposal.tsx";
import { storyScenes } from "./storyScenes.ts";

/**
 * Workbench modes — one work, several editing viewpoints.
 *
 * A mode never owns data: consultation, materials, items, blueprint
 * versions and generation history all belong to the project and stay
 * mounted across switches. A mode only changes which tools and lanes
 * are surfaced around the same stage.
 *
 * Stages: "available" modes are wired end to end (freestyle);
 * "prototype" modes connect some real proposal/export paths while the
 * remaining tools are UI previews; "preview" would mean nothing is
 * wired at all. Adoption and generation remain explicit everywhere.
 */
export type WorkMode =
  | "freestyle"
  | "story"
  | "mv"
  | "animation"
  | "promo"
  | "poster";

export interface ModeTool {
  name: string;
  note: string;
}

export type ModeStage = "available" | "prototype" | "preview";

export interface ModeDef {
  key: WorkMode;
  label: string;
  icon: IconName;
  tagline: string;
  stage: ModeStage;
  tools: ModeTool[];
}

export const MODE_DEFS: ModeDef[] = [
  {
    key: "freestyle",
    label: "フリースタイル",
    icon: "sparkles",
    tagline: "形式に縛られず、素材やアイデアから自由に試す",
    stage: "available",
    tools: [],
  },
  {
    key: "story",
    label: "ストーリー",
    icon: "story",
    tagline: "場面・登場人物・会話を積み上げて物語を組み立てる",
    stage: "prototype",
    tools: [
      {
        name: "場面を分ける",
        note: "物語を場面の列として並べ、順番や繋がりを見渡します。",
      },
      {
        name: "登場人物を割り当てる",
        note: "素材のキャラクターを各場面の登場人物として固定します。",
      },
      {
        name: "会話を書く",
        note: "場面ごとのセリフやナレーションを台本として蓄積します。",
      },
    ],
  },
  {
    key: "mv",
    label: "MV",
    icon: "music",
    tagline: "音楽・拍・歌詞と映像のタイミングを合わせる",
    stage: "prototype",
    tools: [
      {
        name: "楽曲を配置する",
        note: "音声素材を置き、全体の尺を楽曲から決めます。",
      },
      {
        name: "拍に合わせる",
        note: "映像の切り替えや動きの山を拍・ビートに揃えます。",
      },
      {
        name: "歌詞をタイミングに並べる",
        note: "歌詞カードを発声タイミングに沿って配置します。",
      },
    ],
  },
  {
    key: "animation",
    label: "アニメーション",
    icon: "face",
    tagline: "キャラクターの表情・動きと背景を演技として作る",
    stage: "prototype",
    tools: [
      {
        name: "表情・動きを指定する",
        note: "カットごとにキャラクターの演技と動きの指示を管理します。",
      },
      {
        name: "背景を組み立てる",
        note: "カットの背景素材と合成方針をここで揃えます。",
      },
    ],
  },
  {
    key: "promo",
    label: "プロモーション",
    icon: "megaphone",
    tagline: "伝えたい魅力・商品・締めのメッセージを決める",
    stage: "prototype",
    tools: [
      {
        name: "伝えたい魅力を並べる",
        note: "商品・サービスの魅せどころを訴求点として整理します。",
      },
      {
        name: "締めのメッセージ",
        note: "最後に残す一文・ロゴ・行動への誘導を固定します。",
      },
    ],
  },
  {
    key: "poster",
    label: "動くポスター",
    icon: "poster",
    tagline: "静止した構図の中に、部分的な動きとループを仕込む",
    stage: "prototype",
    tools: [
      {
        name: "要素ごとの静止 / 動かす",
        note: "文字や構図は固定したまま、雨だけ・瞬きだけを動かします。",
      },
      {
        name: "動かす範囲・ループ",
        note: "どこを、どれくらい、どう繰り返すかを要素ごとに決めます。",
      },
      {
        name: "重なり順",
        note: "文字の読みやすさを守るため、手前・奥の順を管理します。",
      },
    ],
  },
];

export function isWorkMode(v: string | null): v is WorkMode {
  return !!v && MODE_DEFS.some((d) => d.key === v);
}

export function modeLabelKey(mode: WorkMode): string {
  return `design.modes.${mode}`;
}

export function modeDef(mode: WorkMode): ModeDef {
  return MODE_DEFS.find((d) => d.key === mode) ?? MODE_DEFS[0];
}

function StageBadge({ stage }: { stage: ModeStage }) {
  const { t } = useI18n();
  return (
    <span
      className={`badge ${stage === "available" ? "adopted" : "preview"}`}
      title={t(`mode.stage.${stage}.tooltip`)}
    >
      {t(`mode.stage.${stage}`)}
    </span>
  );
}

function MVContentControls({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  const [withVocals, setWithVocals] = useState(true);
  const [showLyrics, setShowLyrics] = useState(true);
  const [lyrics, setLyrics] = useState("Past the unravelling night\nWalking toward the light");
  const [template, setTemplate] = useState("lyrics");
  const [backdrop, setBackdrop] = useState("water");
  const [loop, setLoop] = useState("seamless");

  return (
    <section className="mv-content-preview" hidden={!visible} aria-label={t("mv.content")}>
      <div className="mv-content-head"><div><b>{t("mv.content")}</b><small>{t("mv.contentIntro")}</small></div><StageBadge stage="preview" /></div>
      <div className="mv-kind-switch" role="group" aria-label={t("mv.songKind")}>
        <button type="button" aria-pressed={withVocals} className={withVocals ? "selected" : ""} onClick={() => setWithVocals(true)}><Icon name="voice" />{t("mv.withVocals")}</button>
        <button type="button" aria-pressed={!withVocals} className={!withVocals ? "selected" : ""} onClick={() => setWithVocals(false)}><Icon name="music" />{t("mv.instrumental")}</button>
      </div>
      <label className="mv-lyrics-toggle"><input type="checkbox" checked={showLyrics} onChange={(e) => setShowLyrics(e.target.checked)} /><span><b>{t("mv.showLyrics")}</b><small>{t("mv.lyricsIndependent")}</small></span><span className={`toggle-pill${showLyrics ? " on" : ""}`}>{showLyrics ? t("mv.show") : t("mv.hide")}</span></label>
      {withVocals ? (
        <div className="mv-lyrics-area">
          {showLyrics ? <>
            <label className="design-label">{t("mv.lyricsDraft")}<textarea aria-label={t("mv.lyricsDraft")} rows={4} value={lyrics} onChange={(e) => setLyrics(e.target.value)} /></label>
            <div className="mv-detail-chips"><span>{t("mv.timingMock")}</span><span>{t("mv.typeMock")}</span></div>
          </> : <p className="mv-muted-card">{t("mv.vocalsNoLyrics")}</p>}
        </div>
      ) : (
        <>
          <p className="mv-muted-card">{t("mv.noVocalsNote")}</p>
          <div className="mv-silent-controls">
            <label className="design-label">{t("mv.backdrop")}<select value={backdrop} onChange={(e) => setBackdrop(e.target.value)}><option value="water">{t("mv.scene.water")}</option><option value="rain">{t("mv.scene.rain")}</option><option value="clouds">{t("mv.scene.clouds")}</option></select></label>
            <label className="design-label">{t("mv.loop")}<select value={loop} onChange={(e) => setLoop(e.target.value)}><option value="seamless">{t("mv.loop.seamless")}</option><option value="fade">{t("mv.loop.fade")}</option><option value="none">{t("mv.loop.none")}</option></select></label>
            <div className="mv-detail-chips"><span>{t("mv.syncMock")}</span><span>{t("mv.motionMock")}</span></div>
          </div>
          <details className="mv-retained-lyrics"><summary>{t("mv.keptLyrics")}</summary><label className="design-label">{t("mv.lyricsDraft")}<textarea aria-label={t("mv.keptLyrics")} rows={3} value={lyrics} onChange={(e) => setLyrics(e.target.value)} /></label></details>
        </>
      )}
      <div className="mv-template-row"><span>{t("mv.template")}</span>{["lyrics", "bg"].map((item) => <button key={item} type="button" className={template === item ? "selected" : ""} onClick={() => setTemplate(item)}>{t(`mv.template.${item}`)}</button>)}</div>
      {!withVocals && <span className="mv-current-backdrop">{t("mv.currentBackdrop", { backdrop: t(`mv.scene.${backdrop}`), loop: t(`mv.loop.${loop}`) })}</span>}
      <p className="design-note">{t("mv.mockNote")}</p>
    </section>
  );
}

/* ---------- mode switcher strip (above the studio) ---------- */

export function ModeBar(props: {
  mode: WorkMode;
  onChange: (m: WorkMode) => void;
}) {
  const { t } = useI18n();
  const active = modeDef(props.mode);
  return (
    <nav className="modebar" aria-label={t("app.mode")}>
      <span className="modebar-label">{t("app.mode")}</span>
      <span className="modebar-btns" role="tablist">
        {MODE_DEFS.map((d, i) => (
          <Fragment key={d.key}>
            {i > 0 &&
              d.stage !== "available" &&
              MODE_DEFS[i - 1].stage === "available" && (
                <span className="modebar-sep" aria-hidden />
              )}
            <button
              role="tab"
              aria-selected={props.mode === d.key}
              className={`mode-btn${props.mode === d.key ? " active" : ""}${d.stage !== "available" ? " preview" : ""}`}
              onClick={() => props.onChange(d.key)}
              title={t(`mode.${d.key}.tagline`)}
            >
              <span className="mode-icon" aria-hidden>
                <Icon name={d.icon} />
              </span>
              {t(modeLabelKey(d.key))}
              {d.stage !== "available" && (
                <span className="mode-pv">{t(`mode.stage.${d.stage}`)}</span>
              )}
            </button>
          </Fragment>
        ))}
      </span>
      <span className="modebar-desc">
        <span className="muted">{t(`mode.${active.key}.tagline`)}</span>
        {active.stage !== "available" && <StageBadge stage={active.stage} />}
      </span>
    </nav>
  );
}

/* ---------- mode lane on the stage (under the preview) ---------- */

function LaneShell(props: {
  title: string;
  stage: ModeStage;
  children: ReactNode;
}) {
  return (
    <div className="stage-lane">
      <div className="lane-head">
        <span className="lane-title">{props.title}</span>
        <StageBadge stage={props.stage} />
      </div>
      <div className="lane-body">{props.children}</div>
    </div>
  );
}

export function ModeLane(props: { mode: WorkMode; state: ProjectState }) {
  const { mode, state } = props;
  const { t } = useI18n();
  const stage = modeDef(mode).stage;
  switch (mode) {
    case "story": {
      const scenes = storyScenes(state.items);
      return (
        <LaneShell title={t("lane.story")} stage={stage}>
          {scenes.map((scene, i) => (
            <span key={scene.id} className={`lane-slot ${scene.adopted_revision ? "real" : "ghost"}`}>
              {t("lane.sceneToDecide", { number: i + 1 })} · {scene.adopted_revision?.content ?? scene.label}
            </span>
          ))}
          {scenes.length === 0 && <span className="lane-slot ghost">{t("lane.sceneToDecide", { number: 1 })}</span>}
        </LaneShell>
      );
    }
    case "mv":
      return (
        <LaneShell title={t("lane.timing")} stage={stage}>
          <span className="lane-slot ghost">{t("lane.trackEmpty")}</span>
          <span className="lane-beats" aria-hidden>
            {Array.from({ length: 24 }, (_, i) => (
              <i key={i} className={i % 4 === 0 ? "beat strong" : "beat"} />
            ))}
          </span>
          <span className="lane-slot ghost">{t("lane.lyricsEmpty")}</span>
        </LaneShell>
      );
    case "animation":
      return (
        <LaneShell title={t("lane.cuts")} stage={stage}>
          <span className="lane-slot ghost">{t("lane.cutPlaceholder", { number: 1 })}</span>
          <span className="lane-slot ghost">{t("lane.cutPlaceholder", { number: 2 })}</span>
          <span className="lane-slot ghost">＋</span>
        </LaneShell>
      );
    case "promo":
      return (
        <LaneShell title={t("lane.structure")} stage={stage}>
          <span className="lane-slot ghost">{t("lane.hook")}</span>
          <span className="lane-slot ghost">{t("lane.appeal")}</span>
          <span className="lane-slot ghost">{t("lane.closing")}</span>
        </LaneShell>
      );
    case "poster":
      // The mixed static/moving idea, shown as element rows: text and
      // composition stay pinned, partial motion loops underneath.
      return (
        <LaneShell title={t("lane.elements")} stage={stage}>
          <span className="lane-slot">
            {t("lane.titleText")} <span className="el-state">{t("lane.still")}</span>
          </span>
          <span className="lane-slot">
            {t("lane.backgroundComposition")} <span className="el-state">{t("lane.still")}</span>
          </span>
          <span className="lane-slot">
            {t("lane.rainLight")} <span className="el-state moving">{t("lane.motionLoop")}</span>
          </span>
        </LaneShell>
      );
    default:
      return null;
  }
}

/* ---------- mode tab in the right panel ---------- */

export function ModeToolsPanel(props: {
  mode: WorkMode;
  state: ProjectState;
  onChanged: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const { t, language } = useI18n();
  const def = modeDef(props.mode);
  if (def.key === "freestyle") {
    return (
      <div className="pane-swap">
        <MVContentControls visible={false} />
        <AssetShelf key={props.state.project.id} state={props.state} onChanged={props.onChanged} />
        <div className="pane-head">
          <h2>{t(modeLabelKey(def.key))}</h2>
          <p className="muted">{t(`mode.${def.key}.tagline`)}</p>
        </div>
        <div className="item">
          <p className="muted small">
            {t("mode.freestyle.guide")}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="pane-swap">
      <MVContentControls visible={false} />
      <AssetShelf key={props.state.project.id} state={props.state} onChanged={props.onChanged} />
      <div className="pane-head">
        <h2>
          {t(modeLabelKey(def.key))} <StageBadge stage={def.stage} />
        </h2>
        <p className="muted">{t(`mode.${def.key}.tagline`)}</p>
      </div>
      {def.key === "story" && <StorySceneProposals state={props.state} onChanged={props.onChanged} onError={props.onError} />}
      {def.key === "promo" && <PromotionProposal state={props.state} onChanged={props.onChanged} onError={props.onError} />}
      {def.key === "animation" && <AnimationShots state={props.state} onChanged={props.onChanged} onError={props.onError} />}
      {def.key === "mv" && <MvLyrics state={props.state} onChanged={props.onChanged} onError={props.onError} />}
      {def.key === "poster" && <PosterProposal state={props.state} onChanged={props.onChanged} onError={props.onError} />}
      {def.tools.map((tool, index) => (
        <details key={tool.name} className="tool">
          <summary>{t(`mode.${def.key}.tool.${index}`)}</summary>
          <p className="muted small">{t(`mode.${def.key}.note.${index}`)}</p>
          <p className="tool-note">{def.key === "story" && index === 0
            ? (t("modes.addAndReorderScenesAndSave"))
            : def.key === "story" && index === 2
              ? (t("modes.createAnUnapprovedScriptRevisionWith"))
              : def.key === "animation" && index === 1
                ? (t("modes.compositeAnApprovedBackgroundAndTransparent"))
              : t("mode.toolNotImplemented")}</p>
        </details>
      ))}
      <p className="muted small mode-tools-hint">
        {t("mode.sharedHint")}
      </p>
    </div>
  );
}

/* ---------- shared editing tools (right panel, all modes) ---------- */

const EDIT_GROUPS: { titleKey: string; tools: { nameKey: string; noteKey: string; engine: string }[] }[] = [
  {
    titleKey: "editTools.trim",
    tools: [
      {
        nameKey: "editTools.trimSplit",
        noteKey: "editTools.trimSplitNote",
        engine: "FFmpeg",
      },
      {
        nameKey: "editTools.extractFrame",
        noteKey: "editTools.extractFrameNote",
        engine: "FFmpeg",
      },
    ],
  },
  {
    titleKey: "editTools.cutout",
    tools: [
      {
        nameKey: "editTools.subjectCutout",
        noteKey: "editTools.subjectCutoutNote",
        engine: "ComfyUI",
      },
      {
        nameKey: "editTools.transparencyMask",
        noteKey: "editTools.transparencyMaskNote",
        engine: "ComfyUI",
      },
    ],
  },
  {
    titleKey: "editTools.composition",
    tools: [
      {
        nameKey: "editTools.layers",
        noteKey: "editTools.layersNote",
        engine: "ComfyUI / FFmpeg",
      },
      {
        nameKey: "editTools.positionOrder",
        noteKey: "editTools.positionOrderNote",
        engine: "UI",
      },
    ],
  },
  {
    titleKey: "editTools.motion",
    tools: [
      {
        nameKey: "editTools.motionParameters",
        noteKey: "editTools.motionParametersNote",
        engine: "ComfyUI / FFmpeg",
      },
    ],
  },
];

export function EditToolsPanel() {
  const { t } = useI18n();
  return (
    <div className="pane-swap">
      <div className="pane-head">
        <h2>
          {t("editTools.title")} <StageBadge stage="preview" />
        </h2>
        <p className="muted">
          {t("editTools.intro")}
        </p>
      </div>
      {EDIT_GROUPS.map((g) => (
        <section key={g.titleKey} className="tool-group">
          <h3>{t(g.titleKey)}</h3>
          {g.tools.map((tool) => (
            <details key={tool.nameKey} className="tool">
              <summary>
                {t(tool.nameKey)}
                <span className="tool-engine">{tool.engine}</span>
              </summary>
              <p className="muted small">{t(tool.noteKey)}</p>
              <p className="tool-note">{t("editTools.notImplemented")}</p>
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}
