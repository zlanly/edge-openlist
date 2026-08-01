<script setup lang="ts">
import { onBeforeUnmount, onMounted, nextTick, ref } from "vue";
import type { MenuItem } from "./menu";

// 锚定式操作菜单。
// 取代原来每张卡片上平铺的「打开 / 改名 / 分享 / 删」四个小按钮 ——
// 那些按钮在手机上只有 20 多像素高，误触删除是家常便饭。
// 这里的菜单项有 40px 触控高度、危险项单独着色并放在末尾。

const props = defineProps<{ anchor: HTMLElement | null; items: MenuItem[] }>();
const emit = defineEmits<{ (e: "select", key: string): void; (e: "close"): void }>();

const menu = ref<HTMLElement | null>(null);
const style = ref<Record<string, string>>({ visibility: "hidden" });

function place() {
  const el = menu.value;
  const a = props.anchor;
  if (!el || !a) return;
  const r = a.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  const pad = 8;

  // 右对齐锚点；贴边时翻转，避免菜单被切掉一半（老界面在窄屏上就是这样）
  let left = r.right - mw;
  if (left < pad) left = pad;
  if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;

  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - pad) {
    const above = r.top - mh - 6;
    top = above > pad ? above : Math.max(pad, window.innerHeight - mh - pad);
  }

  style.value = { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
}

function onDocPointer(e: PointerEvent) {
  const t = e.target as Node;
  if (menu.value?.contains(t) || props.anchor?.contains(t)) return;
  emit("close");
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const nodes = Array.from(menu.value?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
  if (!nodes.length) return;
  const i = nodes.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "ArrowDown" ? (i + 1) % nodes.length : (i - 1 + nodes.length) % nodes.length;
  nodes[next]?.focus();
}
const reposition = () => emit("close"); // 滚动时直接关闭，比跟随重排更符合直觉

onMounted(async () => {
  await nextTick();
  place();
  menu.value?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  document.addEventListener("pointerdown", onDocPointer, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointer, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", reposition, true);
  window.removeEventListener("resize", reposition);
});
</script>

<template>
  <Teleport to="body">
    <div ref="menu" class="popmenu" :style="style" role="menu">
      <template v-for="it in items" :key="it.key">
        <div v-if="it.divided" class="sep" role="separator" />
        <button
          class="mi"
          :class="{ danger: it.danger }"
          role="menuitem"
          type="button"
          :disabled="it.disabled"
          @click="emit('select', it.key)"
        >
          <svg
            v-if="it.icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="it.icon" />
          </svg>
          <span>{{ it.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.popmenu {
  position: fixed;
  z-index: 260;
  min-width: 176px;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  animation: pm-in 0.16s var(--ease);
}
@keyframes pm-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
}

.mi {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.14s var(--ease);
}
.mi:hover:not(:disabled) { background: var(--surface-3); }
.mi:disabled { opacity: 0.45; cursor: not-allowed; }
.mi svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--text-soft); }
.mi.danger { color: var(--danger); }
.mi.danger svg { color: var(--danger); }
.mi.danger:hover:not(:disabled) { background: var(--danger-soft); }

.sep { height: 1px; margin: 5px 6px; background: var(--border); }

@media (max-width: 768px) {
  .mi { min-height: 44px; font-size: 14.5px; }
}
</style>
