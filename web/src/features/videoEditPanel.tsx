import { useState } from "react";
import { api, assetUrl } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import "./videoEditPanel.css";

interface VideoEditResponse {
  asset: { id: string };
  source_asset_id: string;
  start_seconds: number;
  end_seconds: number;
  subtitle_sha256: string | null;
}

export function VideoEditPanel(props: {
  projectId: string;
  sourceAssetId: string;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(1.5);
  const [duration, setDuration] = useState<number | null>(null);
  const [srt, setSrt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoEditResponse | null>(null);

  const edit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.editVideo(props.projectId, {
        source_asset_id: props.sourceAssetId,
        start_seconds: start,
        end_seconds: end,
        ...(srt.trim() ? { subtitles_srt: srt } : {}),
      });
      setResult(response);
      await props.onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card video-edit-panel" aria-label={t("videoEdit.aria")}>
      <h3>{t("videoEdit.title")}</h3>
      <video
        src={assetUrl(props.sourceAssetId)}
        controls
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) {
            setDuration(value);
            setEnd((previous) => previous === 1.5 ? value : Math.min(previous, value));
          }
        }}
      />
      <div className="video-edit-range">
        <label>{t("videoEdit.start")}
          <input type="number" min="0" step="0.1" value={start}
            onChange={(event) => setStart(Number(event.target.value))} />
        </label>
        <label>{t("videoEdit.end")}
          <input type="number" min="0.1" step="0.1" max={duration ?? undefined} value={end}
            onChange={(event) => setEnd(Number(event.target.value))} />
        </label>
      </div>
      <label>{t("videoEdit.subtitles")}
        <textarea rows={6} value={srt} onChange={(event) => setSrt(event.target.value)}
          placeholder={t("videoEdit.placeholder")} />
      </label>
      <p className="muted small">{t("videoEdit.sourceNote")}</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="button primary" disabled={busy || end <= start || (duration != null && end > duration)} onClick={() => void edit()}>
        {busy ? t("videoEdit.busy") : t("videoEdit.submit")}
      </button>
      {result && <div className="video-edit-result">
        <p className="muted small">{t("videoEdit.saved", { source: result.source_asset_id.slice(0, 8), start: result.start_seconds, end: result.end_seconds })}</p>
        <video src={assetUrl(result.asset.id)} controls playsInline />
      </div>}
    </section>
  );
}
