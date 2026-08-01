<script setup lang="ts">
import { computed } from "vue";
import type { MountRow } from "../api";

const props = defineProps<{
  mounts: MountRow[];
  current: number | null;
  open: boolean;
  isAdmin: boolean;
  loading: boolean;
}>();
const emit = defineEmits<{
  (e: "select", id: number): void;
  (e: "close"): void;
  (e: "manage"): void;
}>();

// 禁用的挂载排在最后：它们点进去只会 404，不该抢占视线
const sorted = computed(() =>
  [...props.mounts].sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0) || a.order - b.order || a.id - b.id)
);

function pick(m: MountRow) {
  emit("select", m.id);
  emit("close"); // 移动端选完自动收起抽屉
}
</script>

<template>
  <!-- 移动端遮罩 -->
  <Transition name="fade">
    <div v-if="open" class="scrim" @click="emit('close')" />
  </Transition>

  <aside class="sidebar" :class="{ open }" aria-label="挂载列表">
    <div class="head">
      <span class="cap">我的网盘</span>
      <button class="btn btn-icon btn-ghost close-btn" aria-label="收起" @click="emit('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>

    <nav class="list">
      <template v-if="loading && !mounts.length">
        <div v-for="i in 4" :key="i" class="skeleton sk-row" />
      </template>

      <button
        v-for="m in sorted"
        :key="m.id"
        class="item"
        :class="{ active: current === m.id, off: !m.enabled }"
        :aria-current="current === m.id ? 'true' : undefined"
        @click="pick(m)"
      >
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3H4V7Zm0 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3Z" />
          <path d="M7.5 8h.01M7.5 15.5h.01" />
        </svg>
        <span class="txt">
          <span class="nm">{{ m.name }}</span>
          <span class="dv">{{ m.driver }}</span>
        </span>
        <span v-if="!m.enabled" class="badge badge-muted off-tag">已停用</span>
      </button>

      <p v-if="!loading && !mounts.length" class="none">还没有挂载</p>
    </nav>

    <button v-if="isAdmin" class="add" @click="emit('manage')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      添加网盘
    </button>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--side-w);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 10px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  background: color-mix(in srgb, var(--surface) 45%, transparent);
}

.head { display: flex; align-items: center; padding: 0 8px 8px; }
.cap { flex: 1; font-size: 11.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); }
.close-btn { display: none; }
.close-btn svg { width: 15px; height: 15px; }

.list { display: flex; flex-direction: column; gap: 2px; flex: 1; min-height: 0; }
.sk-row { height: 40px; margin-bottom: 2px; }

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.16s var(--ease), color 0.16s var(--ease);
}
.item:hover { background: var(--surface-3); }
.item.active { background: var(--brand-soft); color: var(--brand-strong); }
.item.active .ic { color: var(--brand); }
.item.off { opacity: 0.55; }

.ic { width: 18px; height: 18px; flex-shrink: 0; color: var(--text-faint); }
.txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm { font-size: 13.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dv { font-size: 11px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.off-tag { flex-shrink: 0; }

.none { padding: 14px 10px; margin: 0; font-size: 12.5px; color: var(--text-faint); }

.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 6px;
  padding: 9px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-soft);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.add:hover { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.add svg { width: 15px; height: 15px; }

.scrim { display: none; }

@media (max-width: 768px) {
  .scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 140;
    background: var(--overlay);
    backdrop-filter: blur(2px);
  }
  .sidebar {
    position: fixed;
    z-index: 150;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(280px, 84vw);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    transform: translateX(-100%);
    transition: transform 0.28s var(--ease);
    padding-top: calc(14px + env(safe-area-inset-top));
  }
  .sidebar.open { transform: none; }
  .close-btn { display: grid; }
  .item { padding: 11px 10px; }
}
</style>
