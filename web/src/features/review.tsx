import { useState } from "react";
import type { ProjectState } from "@vo/shared";
import { useI18n } from "../i18n.tsx";
import { Icon } from "./icon.tsx";

const examples = [
  { id: "clarity", kind: "check", title: "review.example.clarity.title", target: "review.example.clarity.target", detail: "review.example.clarity.detail", suggestion: "review.example.clarity.suggestion" },
  { id: "pacing", kind: "subjective", title: "review.example.pacing.title", target: "review.example.pacing.target", detail: "review.example.pacing.detail", suggestion: "review.example.pacing.suggestion" },
  { id: "audio", kind: "unknown", title: "review.example.audio.title", target: "review.example.audio.target", detail: "review.example.audio.detail", suggestion: "review.example.audio.suggestion" },
];

type DirectionTarget = "preview" | "cut" | "dialogue";

export function ReviewPanel({ state }: { state: ProjectState }) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [target, setTarget] = useState<DirectionTarget>("preview");
  const [note, setNote] = useState("");
  const [scope, setScope] = useState("cut");
  const [guard, setGuard] = useState<string[]>(["character"]);
  const [tryItems, setTryItems] = useState<string[]>(["light"]);
  const [variantAName, setVariantAName] = useState(t("review.variantA"));
  const [variantBName, setVariantBName] = useState(t("review.variantB"));
  const [colorChoice, setColorChoice] = useState("A");
  const [compositionChoice, setCompositionChoice] = useState("B");
  const [comparisonSaved, setComparisonSaved] = useState(false);
  const [goal, setGoal] = useState(t("review.goalDefault"));
  const [audience, setAudience] = useState(t("review.audienceDefault"));
  const [strictness, setStrictness] = useState("balanced");
  const [axes, setAxes] = useState(t("review.axesDefault"));
  const [selected, setSelected] = useState<string[]>([]);
  const [added, setAdded] = useState(false);
  const basisVersion = state.blueprint_versions.at(-1);
  const targetId = `${state.project.id}:${basisVersion?.id ?? "draft"}:${target}`;
  const toggle = (items: string[], setItems: (next: string[]) => void, item: string) => setItems(items.includes(item) ? items.filter(v => v !== item) : [...items, item]);
  return <section className="review-panel">
    <div className="design-heading"><span className="eyebrow">{t("review.eyebrow")}</span><h2>{t("review.title")}</h2><p>{t("review.intro")}</p><p className="muted small">{t("review.stageCompare")}</p></div>
    <div className="review-mock-banner"><b>MOCK</b><span>{t("review.sampleNotice")}</span></div>
    <section className="direction-flow" aria-label={t("review.flowTitle")}>
      <div className="direction-flow-head"><div><span className="eyebrow">{t("review.flowEyebrow")}</span><h3>{t("review.flowTitle")}</h3></div><span className="badge quiet">{t("review.localOnly")}</span></div>
      <nav className="direction-step-nav" aria-label={t("review.flowTitle")}>{[1, 2, 3].map(n => <button key={n} type="button" aria-current={step === n ? "step" : undefined} className={step === n ? "active" : ""} onClick={() => setStep(n)}><b>0{n}</b>{t(`review.step.${n}`)}</button>)}</nav>
      {step === 1 && <div className="direction-step">
        <h4>{t("review.step.1")}</h4><p className="muted small">{t("review.pointHint")}</p>
        <div className="point-preview" aria-label={t("review.pointPreview")}>
          <div className="point-preview-sky"><span>{t("review.previewMock")}</span></div>
          <button className={target === "preview" ? "selected" : ""} onClick={() => setTarget("preview")} aria-label={t("review.target.preview")}><Icon name="landscape" /><small>{t("review.target.preview")}</small></button>
          <button className={target === "cut" ? "selected" : ""} onClick={() => setTarget("cut")} aria-label={t("review.target.cut")}><Icon name="template" /><small>{t("review.target.cut")}</small></button>
          <button className={target === "dialogue" ? "selected" : ""} onClick={() => setTarget("dialogue")} aria-label={t("review.target.dialogue")}><Icon name="dialogue" /><small>{t("review.target.dialogue")}</small></button>
        </div>
        <div className="review-target-id"><span>{t("review.targetId")}</span><code>{targetId}</code><span>{t("review.basisVersion", { version: basisVersion ? `v${basisVersion.version_no}` : t("review.unsavedVersion") })}</span></div>
        <label className="review-note-label">{t("review.directionNote")}<textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder={t("review.directionPlaceholder")} /></label>
        <div className="review-change-preview"><b>{t("review.changePreview")}</b><span>{t("review.changePreviewLine", { target: t(`review.target.${target}`), note: note.trim() || t("review.noNoteYet") })}</span></div>
        <div className="direction-step-actions"><button className="primary" onClick={() => setStep(2)}>{t("review.nextProtect")} →</button></div>
      </div>}
      {step === 2 && <div className="direction-step">
        <h4>{t("review.step.2")}</h4><p className="muted small">{t("review.intentOnly")}</p>
        <label className="review-scope-label">{t("review.scope")}<select value={scope} onChange={e => setScope(e.target.value)}><option value="cut">{t("review.scope.cut")}</option><option value="work">{t("review.scope.work")}</option></select></label>
        <div className="review-guard-grid"><fieldset><legend>{t("review.protect")}</legend>{["character", "identity", "dialogue"].map(item => <label key={item}><input type="checkbox" checked={guard.includes(item)} onChange={() => toggle(guard, setGuard, item)} />{t(`review.guard.${item}`)}</label>)}</fieldset><fieldset><legend>{t("review.try")}</legend>{["light", "composition", "pace"].map(item => <label key={item}><input type="checkbox" checked={tryItems.includes(item)} onChange={() => toggle(tryItems, setTryItems, item)} />{t(`review.try.${item}`)}</label>)}</fieldset></div>
        <p className="review-intention-note">{t("review.noGuarantee")}</p>
        <div className="direction-step-actions"><button onClick={() => setStep(1)}>← {t("review.back")}</button><button className="primary" onClick={() => setStep(3)}>{t("review.nextCompare")} →</button></div>
      </div>}
      {step === 3 && <div className="direction-step">
        <h4>{t("review.step.3")}</h4><p className="muted small">{t("review.compareHint")}</p>
        <div className="variant-pair">{["A", "B"].map(v => <div className={`variant-card variant-${v.toLowerCase()}`} key={v}><div className="variant-art"><span>{v}</span></div><label>{t("review.variantName")}<input value={v === "A" ? variantAName : variantBName} onChange={e => v === "A" ? setVariantAName(e.target.value) : setVariantBName(e.target.value)} /></label></div>)}</div>
        <div className="review-mix-row"><label>{t("review.colorPreference")}<select value={colorChoice} onChange={e => setColorChoice(e.target.value)}><option value="A">{variantAName}</option><option value="B">{variantBName}</option></select></label><label>{t("review.compositionPreference")}<select value={compositionChoice} onChange={e => setCompositionChoice(e.target.value)}><option value="A">{variantAName}</option><option value="B">{variantBName}</option></select></label></div>
        <div className="review-change-preview"><b>{t("review.combinationDraft")}</b><span>{t("review.combinationLine", { color: colorChoice === "A" ? variantAName : variantBName, composition: compositionChoice === "A" ? variantAName : variantBName })}</span><small>{t("review.notApplied")}</small></div>
        <div className="direction-step-actions"><button onClick={() => setStep(2)}>← {t("review.back")}</button><button className="primary" onClick={() => setComparisonSaved(true)}>{t("review.keepPreference")}</button></div>
        {comparisonSaved && <p className="review-feedback" role="status">{t("review.preferenceKept")}</p>}
      </div>}
    </section>
    <details className="review-extra"><summary>{t("review.aiReviewMore")}</summary>
    <div className="review-brief">
      <label>{t("review.goal")}<textarea value={goal} onChange={e => setGoal(e.target.value)} rows={2} /></label>
      <label>{t("review.audience")}<textarea value={audience} onChange={e => setAudience(e.target.value)} rows={2} /></label>
      <label>{t("review.axes")}<textarea value={axes} onChange={e => setAxes(e.target.value)} rows={2} /></label>
      <label>{t("review.strictness")}<select value={strictness} onChange={e => setStrictness(e.target.value)}><option value="gentle">{t("review.gentle")}</option><option value="balanced">{t("review.balanced")}</option><option value="strict">{t("review.strict")}</option></select></label>
    </div>
    <div className="review-results-head"><h3>{t("review.results")}</h3><span className="badge quiet">{t("review.sampleLabel")}</span></div>
    <div className="review-cards">{examples.map(item => <article className={`review-card review-${item.kind}`} key={item.id}>
      <div className="review-card-head"><label><input type="checkbox" checked={selected.includes(item.id)} onChange={e => setSelected(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /> {t(item.title)}</label><span className="badge quiet">{t(`review.kind.${item.kind}`)}</span></div>
      <p className="muted small">{t(item.target)}</p><p>{t(item.detail)}</p><p className="review-suggestion">{t("review.suggestion")}: {t(item.suggestion)}</p>
    </article>)}</div>
    <button className="primary" disabled={!selected.length} onClick={() => setAdded(true)}>{t("review.addSelected", { count: selected.length })}</button>
    {added && <div className="review-draft" role="status"><b>{t("review.draftTitle")}</b><p>{t("review.goal")}: {goal}</p><ul>{examples.filter(item => selected.includes(item.id)).map(item => <li key={item.id}><strong>{t(item.title)}</strong><span>{t(item.suggestion)}</span></li>)}</ul><span className="muted small">{t("review.added")}</span></div>}
    <p className="muted small">{t("review.noOverwrite")}</p>
    </details>
  </section>;
}
