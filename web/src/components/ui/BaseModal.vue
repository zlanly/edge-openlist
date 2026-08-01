<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from "vue";
import { lockScroll, unlockScroll } from "../../utils/scroll-lock";

// 统一的模态框：焦点陷阱 + Esc 关闭 + 滚动锁定。
// 原来的弹窗只有一个 @click.self 关闭，键盘用户既进不去也出不来。

const props = withDefaults(defineProps<{ title: string; width?: string; closable?: boolean }>(), {
  width: "560px",
  closable: true,
});
const emit = defineEmits<{ (e: "close"): void }>();

const panel = ref<HTMLElement | null>(null);
let lastFocused: HTMLElement | null = null;

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.closable) {
    e.stopPropagation();
    emit("close");
    return;
  }
  if (e.key !== "Tab" || !panel.value) return;
  // 焦点陷阱：Tab 不能跑到弹窗背后的页面上去
  const nodes = Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  lastFocused = document.activeElement as HTMLElement;
  document.addEventListener("keydown", onKeydown, true);
  lockScroll();
  await nextTick();
  const target = panel.value?.querySelector<HTMLElement>(FOCUSABLE);
  (target ?? panel.value)?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown, true);
  unlockScroll();
  // 关闭后把焦点还给触发它的按钮，键盘操作不会「丢失位置」
  lastFocused?.focus?.();
});
</script>

<template>
  <!-- Teleport 到 body：否则一旦某个祖先有 overflow:auto 或 transform，
       fixed 定位就会被「关」进那个容器里，弹窗直接消失或被裁掉。 -->
  <Teleport to="body">
  <div class="mask" @mousedown.self="closable && emit('close')">
    <div
      ref="panel"
      class="dialog"
      :style="{ width }"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
    >
      <header class="head">
        <h3 class="title">{{ title }}</h3>
        <slot name="head-extra" />
        <button v-if="closable" class="btn btn-icon btn-ghost" aria-label="关闭" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>
      <div class="content"><slot /></div>
      <footer v-if="$slots.footer" class="foot"><slot name="footer" /></footer>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: var(--overlay);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  animation: mask-in 0.2s var(--ease);
}
@keyframes mask-in { from { opacity: 0; } }

.dialog {
  max-width: 100%;
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  outline: none;
  animation: dialog-in 0.26s var(--ease);
}
@keyframes dialog-in {
  from { opacity: 0; transform: translateY(14px) scale(0.97); }
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 16px 12px 20px;
  border-bottom: 1px solid var(--border);
}
.title { flex: 1; font-size: 15.5px; }
.head svg { width: 16px; height: 16px; }

.content { flex: 1; overflow: auto; padding: 18px 20px; min-height: 0; }
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 13px 20px;
  border-top: 1px solid var(--border);
}

@media (max-width: 768px) {
  .mask { padding: 0; align-items: flex-end; }
  .dialog {
    width: 100% !important;
    max-height: 92vh;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    animation: sheet-in 0.28s var(--ease);
  }
  @keyframes sheet-in { from { transform: translateY(100%); } }
  .content { padding: 16px; }
  .foot { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); }
}
</style>
