import { useEffect, type RefObject } from "react";

// <details>-based popovers should behave like menus: a pointer-down
// outside or Escape closes them. Selection handlers may also close them
// explicitly via removeAttribute("open"). ref.current is resolved at
// event time because the details element may mount after the effect
// runs (e.g. content gated on loaded data).
export function useDetailsDismiss(ref: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el?.open && !el.contains(e.target as Node)) el.removeAttribute("open");
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key === "Escape" && el?.open) el.removeAttribute("open");
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref]);
}
