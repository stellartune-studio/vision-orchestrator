import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "./i18n.tsx";
import { Icon } from "./features/icon.tsx";
import { useDetailsDismiss } from "./useDetailsDismiss.ts";

type Preset = "neutral" | "sharp" | "soft";
type ThemeSettings = {
  preset: Preset;
  accent: string;
  font: "system" | "editorial";
  icons: "line" | "solid";
  size: "small" | "normal" | "large";
  radius: number;
  density: "compact" | "normal" | "relaxed";
  motion: "none" | "soft" | "full";
};
const KEY = "vo.uiAppearance";
const defaults: ThemeSettings = { preset: "neutral", accent: "#8ba6f8", font: "system", icons: "line", size: "normal", radius: 8, density: "normal", motion: "soft" };
const palette: Record<Preset, { bg: string; panel: string; panel2: string; line: string; text: string; muted: string; soft: string; accent: string }> = {
  neutral: { bg: "#16181d", panel: "#1d2027", panel2: "#232731", line: "#2d3340", text: "#e9ebf0", muted: "#9aa2b4", soft: "#28314e", accent: "#8ba6f8" },
  sharp: { bg: "#13191d", panel: "#1b2329", panel2: "#222c33", line: "#344149", text: "#edf4f5", muted: "#a0b0b6", soft: "#203b43", accent: "#72c4d2" },
  soft: { bg: "#1e1a22", panel: "#27212b", panel2: "#302936", line: "#433846", text: "#f3edf4", muted: "#b4a8b9", soft: "#46334c", accent: "#d7a9c8" },
};
/* Extended surface/accent ramp — hue-shifted siblings of each preset's
   base colors so secondary chrome (hover, insets, accent borders,
   disabled fills) follows the theme instead of staying neutral. */
const ramp: Record<Preset, Record<string, string>> = {
  neutral: {
    "--sunken": "#101318", "--inset": "#14171d", "--rail": "#1a1d24",
    "--modebar": "#161920", "--overlay": "#191c23", "--hover": "#2b303c",
    "--glow": "#20242e", "--line-hi": "#3a4152",
    "--fg-soft": "#d3d7df", "--fg-faint": "#454d60",
    "--accent-line": "#3d4a77", "--accent-line-hi": "#52628e",
    "--accent-soft-hi": "#303956", "--accent-fg": "#dfe6ff",
    "--accent-fg-mid": "#b3c3ff", "--accent-hover": "#313c60",
    "--accent-deep": "#202638", "--accent-deep-line": "#2e3550",
    "--accent-dim": "#93a0c4", "--accent-hi": "#a3b8fa",
  },
  sharp: {
    "--sunken": "#0f1517", "--inset": "#121a1d", "--rail": "#172227",
    "--modebar": "#121b1f", "--overlay": "#1a2429", "--hover": "#27363d",
    "--glow": "#1a2b32", "--line-hi": "#3a4c55",
    "--fg-soft": "#d5e2e5", "--fg-faint": "#3f545c",
    "--accent-line": "#2e5a64", "--accent-line-hi": "#3f7380",
    "--accent-soft-hi": "#28454e", "--accent-fg": "#dcf3f7",
    "--accent-fg-mid": "#a8d4de", "--accent-hover": "#2a4b55",
    "--accent-deep": "#1a2c33", "--accent-deep-line": "#2a444e",
    "--accent-dim": "#7fa9b4", "--accent-hi": "#8ed3df",
  },
  soft: {
    "--sunken": "#151117", "--inset": "#1a151e", "--rail": "#221d27",
    "--modebar": "#1b161f", "--overlay": "#211b26", "--hover": "#372e3d",
    "--glow": "#2b2233", "--line-hi": "#4a3e52",
    "--fg-soft": "#e0d5e0", "--fg-faint": "#554a5e",
    "--accent-line": "#5e4670", "--accent-line-hi": "#7a5c8e",
    "--accent-soft-hi": "#452f52", "--accent-fg": "#f7e0f2",
    "--accent-fg-mid": "#d0a8cd", "--accent-hover": "#4d3760",
    "--accent-deep": "#2b2036", "--accent-deep-line": "#453055",
    "--accent-dim": "#b394ad", "--accent-hi": "#e4bcd7",
  },
};
type ThemeContextValue = { settings: ThemeSettings; setSettings: (next: ThemeSettings) => void; save: () => void; reset: () => void };
const ThemeContext = createContext<ThemeContextValue>({ settings: defaults, setSettings: () => {}, save: () => {}, reset: () => {} });

function readSaved(): ThemeSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ThemeSettings> | null;
    if (!parsed) return defaults;
    return {
      preset: parsed.preset === "sharp" || parsed.preset === "soft" ? parsed.preset : "neutral",
      accent: typeof parsed.accent === "string" && /^#[\da-fA-F]{6}$/.test(parsed.accent) ? parsed.accent : defaults.accent,
      font: parsed.font === "editorial" ? "editorial" : "system",
      icons: parsed.icons === "solid" ? "solid" : "line",
      size: parsed.size === "small" || parsed.size === "large" ? parsed.size : "normal",
      radius: typeof parsed.radius === "number" && Number.isFinite(parsed.radius) ? Math.max(4, Math.min(16, parsed.radius)) : defaults.radius,
      density: parsed.density === "compact" || parsed.density === "relaxed" ? parsed.density : "normal",
      motion: parsed.motion === "none" || parsed.motion === "full" ? parsed.motion : "soft",
    };
  } catch { return defaults; }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ThemeSettings>(readSaved);
  useEffect(() => {
    const root = document.documentElement;
    const colors = palette[settings.preset];
    root.dataset.uiPreset = settings.preset;
    root.dataset.uiFont = settings.font;
    root.dataset.uiIcons = settings.icons;
    root.dataset.uiDensity = settings.density;
    root.dataset.uiMotion = settings.motion;
    root.style.setProperty("--bg", colors.bg);
    root.style.setProperty("--panel", colors.panel);
    root.style.setProperty("--panel-2", colors.panel2);
    root.style.setProperty("--line", colors.line);
    root.style.setProperty("--text", colors.text);
    root.style.setProperty("--muted", colors.muted);
    root.style.setProperty("--accent", settings.accent);
    root.style.setProperty("--accent-soft", colors.soft);
    for (const [key, value] of Object.entries(ramp[settings.preset])) {
      root.style.setProperty(key, value);
    }
    root.style.setProperty("--radius", `${settings.radius}px`);
    root.style.setProperty("--radius-sm", `${Math.max(4, Math.round(settings.radius * .65))}px`);
    root.style.setProperty("--ui-font-scale", settings.size === "small" ? "0.92" : settings.size === "large" ? "1.08" : "1");
    root.style.setProperty("--ui-muted-contrast", settings.preset === "soft" ? "#c1b4c7" : colors.muted);
  }, [settings]);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* Storage may be unavailable. */ } };
  const reset = () => { setSettings(defaults); try { localStorage.setItem(KEY, JSON.stringify(defaults)); } catch { /* Storage may be unavailable. */ } };
  const value = useMemo(() => ({ settings, setSettings, save, reset }), [settings]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeSettings() { return useContext(ThemeContext); }

export function ThemeControl() {
  const { t } = useI18n();
  const { settings, setSettings, save, reset } = useThemeSettings();
  const [saved, setSaved] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(detailsRef);
  const change = <K extends keyof ThemeSettings>(key: K, value: ThemeSettings[K]) => {
    setSaved(false);
    setSettings({ ...settings, [key]: value });
  };
  const updatePreset = (preset: Preset) => { setSaved(false); setSettings({ ...settings, preset, accent: palette[preset].accent }); };
  return (
    <details className="appearance-control" ref={detailsRef}>
      <summary title={t("theme.title")}><Icon name="sliders" /> {t("theme.open")}</summary>
      <form className="appearance-menu" onSubmit={(e) => { e.preventDefault(); save(); setSaved(true); }}>
        <div className="appearance-heading"><b>{t("theme.title")}</b><span>{t("theme.title")}</span></div>
        <label>{t("theme.preset")}<select value={settings.preset} onChange={(e) => updatePreset(e.target.value as Preset)}>
          <option value="neutral">{t("theme.neutral")} · {t("theme.neutralDesc")}</option>
          <option value="sharp">{t("theme.sharp")} · {t("theme.sharpDesc")}</option>
          <option value="soft">{t("theme.soft")} · {t("theme.softDesc")}</option>
        </select></label>
        <div className="appearance-grid">
          <label>{t("theme.accent")}<input type="color" value={settings.accent} onChange={(e) => change("accent", e.target.value)} /></label>
          <label>{t("theme.font")}<select value={settings.font} onChange={(e) => change("font", e.target.value as ThemeSettings["font"])}><option value="system">{t("theme.font.system")}</option><option value="editorial">{t("theme.font.editorial")}</option></select></label>
          <label>{t("theme.icons")}<select value={settings.icons} onChange={(e) => change("icons", e.target.value as ThemeSettings["icons"])}><option value="line">{t("theme.icons.line")}</option><option value="solid">{t("theme.icons.solid")}</option></select></label>
          <label>{t("theme.size")}<select value={settings.size} onChange={(e) => change("size", e.target.value as ThemeSettings["size"])}><option value="small">{t("theme.size.small")}</option><option value="normal">{t("theme.size.normal")}</option><option value="large">{t("theme.size.large")}</option></select></label>
          <label>{t("theme.density")}<select value={settings.density} onChange={(e) => change("density", e.target.value as ThemeSettings["density"])}><option value="compact">{t("theme.density.compact")}</option><option value="normal">{t("theme.density.normal")}</option><option value="relaxed">{t("theme.density.relaxed")}</option></select></label>
          <label className="appearance-range">{t("theme.corners")}<input type="range" min="4" max="16" step="1" value={settings.radius} onChange={(e) => change("radius", Number(e.target.value))} /></label>
          <label>{t("theme.motion")}<select value={settings.motion} onChange={(e) => change("motion", e.target.value as ThemeSettings["motion"])}><option value="none">{t("theme.motion.none")}</option><option value="soft">{t("theme.motion.soft")}</option><option value="full">{t("theme.motion.full")}</option></select></label>
        </div>
        <p className="appearance-note">{t("theme.reducedMotion")}</p>
        <div className="appearance-actions"><button type="submit" className="primary">{saved ? t("theme.saved") : t("theme.save")}</button><button type="button" onClick={() => { reset(); setSaved(true); }}>{t("theme.reset")}</button></div>
      </form>
    </details>
  );
}
