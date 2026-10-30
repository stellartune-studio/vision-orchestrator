import { useEffect, useState } from "react";
import { environmentRequest } from "../api/environment.ts";
import { useI18n } from "../i18n.tsx";

type MemoryStatus = { local_reference_release: string; gpu_release: string; monitor_interval_ms: number };

export function MemoryStatus() {
  const { t } = useI18n();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => void environmentRequest<MemoryStatus>("/api/environment/memory-status").then((value) => { if (active) setStatus(value); }).catch(() => { if (active) setStatus(null); });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (!status) return <div role="status">{t("memoryStatus.memoryManagementStatusUnavailable")}</div>;
  const local = status?.local_reference_release;
  const localText = local === "reference_dropped" ? (t("memoryStatus.referenceDroppedCollectionTimeUnconfirmed")) : local === "waiting" ? (t("memoryStatus.waitingForJobs")) : local === "disabled" ? (t("memoryStatus.disabled")) : (t("memoryStatus.unconfirmed"));
  return <div role="status"><p>{t("memoryStatus.voSDKReference")}: {localText}</p><p>{t("memoryStatus.automaticGPUMemoryReleaseUnsupportedServer")}</p><p>{t("memoryStatus.setVOAUTORELEASELOCALREFERENCES")}</p></div>;
}
