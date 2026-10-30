import type {
  SceneDraftReviewStatus,
  SceneInputDraftReviewItem,
} from "@vo/shared";
import { useI18n } from "../i18n.tsx";

const STATUS_LABEL: Record<SceneDraftReviewStatus, string> = {
  unconfirmed: "sceneReview.status.unconfirmed",
  in_progress: "sceneReview.status.inProgress",
  confirmed: "sceneReview.status.confirmed",
};

const STATUS_OPTIONS: SceneDraftReviewStatus[] = [
  "unconfirmed",
  "in_progress",
  "confirmed",
];

export function ReviewItemEditor({
  item,
  onChange,
}: {
  item: SceneInputDraftReviewItem;
  onChange: (
    patch: Partial<Pick<SceneInputDraftReviewItem, "status" | "answer" | "memo">>,
  ) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="scene-review-item" data-review-item-id={item.id}>
      <h5>{item.label}</h5>
      <p className="muted small">
        {item.source_status ? `${t("sceneReview.inspectedAtSave")}: ${item.source_status}.` : t("sceneReview.sourceShownAsSaved")}
        {item.kind === "constraint" && t("sceneReview.constraintImmutable")}
      </p>
      <details>
        <summary>{t("sceneReview.savedSourceDetails")}</summary>
        <pre>{item.source_text}</pre>
      </details>
      <ReviewFields
        label={item.label}
        status={item.status}
        answer={item.answer}
        memo={item.memo}
        onChange={onChange}
      />
    </div>
  );
}

export function ReviewFields({
  label,
  status,
  answer,
  memo,
  onChange,
}: {
  label: string;
  status: SceneDraftReviewStatus;
  answer: string;
  memo: string;
  onChange: (
    patch: Partial<Pick<SceneInputDraftReviewItem, "status" | "answer" | "memo">>,
  ) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="scene-review-fields">
      <label>
        {t("sceneReview.reviewStatus")}
        <select
          aria-label={t("sceneReview.itemStatus", { label })}
          value={status}
          onChange={(event) => onChange({ status: event.target.value as SceneDraftReviewStatus })}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>{t(STATUS_LABEL[option])}</option>
          ))}
        </select>
      </label>
      <label>
        {t("sceneReview.answerDraft")}
        <textarea
          aria-label={t("sceneReview.itemAnswer", { label })}
          value={answer}
          onChange={(event) => onChange({ answer: event.target.value })}
        />
      </label>
      <label>
        {t("sceneReview.memo")}
        <textarea
          aria-label={t("sceneReview.itemMemo", { label })}
          value={memo}
          onChange={(event) => onChange({ memo: event.target.value })}
        />
      </label>
    </div>
  );
}
