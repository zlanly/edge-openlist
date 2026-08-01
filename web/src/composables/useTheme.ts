import { ref, watch } from "vue";

// 浅色 / 深色 / 跟随系统。
// 主题在 index.html 的内联脚本里就已应用（见 web/index.html），
// 这里只负责后续切换，避免刷新时出现白屏闪烁（FOUC）。

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "eol_theme";

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

const mode = ref<ThemeMode>(readStored());
const resolved = ref<"light" | "dark">("light");

const mql = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function apply() {
  const isDark = mode.value === "dark" || (mode.value === "system" && !!mql?.matches);
  resolved.value = isDark ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", resolved.value);
  // 同步移动端浏览器地址栏配色
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", isDark ? "#17151a" : "#f7f4ef");
}

apply();
mql?.addEventListener?.("change", () => {
  if (mode.value === "system") apply();
});

watch(mode, (v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {}
  apply();
});

export function useTheme() {
  return {
    mode,
    resolved,
    set(m: ThemeMode) {
      mode.value = m;
    },
    /** 在 浅色 → 深色 → 跟随系统 之间循环。 */
    cycle() {
      mode.value = mode.value === "light" ? "dark" : mode.value === "dark" ? "system" : "light";
    },
  };
}
