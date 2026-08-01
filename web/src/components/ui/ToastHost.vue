<script setup lang="ts">
import { useToast } from "../../composables/useToast";

const { toasts, dismiss } = useToast();

const ICONS: Record<string, string> = {
  success: "M20 6 9 17l-5-5",
  error: "M12 8v5M12 16.5v.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  warn: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  info: "M12 16v-4M12 8h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
};
</script>

<template>
  <!-- role=status + aria-live：屏幕阅读器能播报提示，而 alert() 做不到无障碍分级 -->
  <div class="toast-host" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="'toast-' + t.kind">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="ICONS[t.kind]" />
        </svg>
        <div class="body">
          <div class="title">{{ t.title }}</div>
          <div v-if="t.desc" class="desc">{{ t.desc }}</div>
          <button v-if="t.action" class="btn btn-sm btn-outline retry" @click="t.action.run(); dismiss(t.id)">
            {{ t.action.label }}
          </button>
        </div>
        <button class="close" :aria-label="`关闭提示：${t.title}`" @click="dismiss(t.id)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 400;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(380px, calc(100vw - 32px));
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 12px 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--text-faint);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}
.toast-success { border-left-color: var(--success); }
.toast-error { border-left-color: var(--danger); }
.toast-warn { border-left-color: var(--warn); }
.toast-info { border-left-color: var(--info); }

.ic { width: 18px; height: 18px; flex-shrink: 0; margin-top: 1px; }
.toast-success .ic { color: var(--success); }
.toast-error .ic { color: var(--danger); }
.toast-warn .ic { color: var(--warn); }
.toast-info .ic { color: var(--info); }

.body { flex: 1; min-width: 0; }
.title { font-size: 13.5px; font-weight: 600; line-height: 1.45; word-break: break-word; }
.desc { margin-top: 3px; font-size: 12.5px; color: var(--text-soft); line-height: 1.5; word-break: break-word; }
.retry { margin-top: 8px; }

.close {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  border-radius: 6px;
}
.close:hover { background: var(--surface-3); color: var(--text); }
.close svg { width: 13px; height: 13px; }

.toast-enter-active { transition: all 0.3s var(--ease); }
.toast-leave-active { transition: all 0.2s var(--ease); position: absolute; right: 0; width: 100%; }
.toast-enter-from { opacity: 0; transform: translateX(24px) scale(0.96); }
.toast-leave-to { opacity: 0; transform: translateX(24px) scale(0.96); }
.toast-move { transition: transform 0.3s var(--ease); }

@media (max-width: 768px) {
  .toast-host { top: auto; bottom: 16px; left: 16px; right: 16px; width: auto; }
  .toast-enter-from, .toast-leave-to { transform: translateY(24px) scale(0.96); }
}
</style>
