<script setup lang="ts">
import type { MountRow } from "../api";

// OpenList 的根目录就是「存储列表」：每个挂载一行，点进去才是文件。
// 这里 1:1 对应它的首页形态，替代旧版的左侧边栏。

defineProps<{
  mounts: MountRow[];
  loading: boolean;
  isAdmin: boolean;
}>();
const emit = defineEmits<{
  (e: "select", id: number): void;
  (e: "manage"): void;
}>();
</script>

<template>
  <section class="home">
    <div class="obj-box panel">
      <div v-if="loading" class="rows">
        <div v-for="i in 3" :key="i" class="skeleton sk-row" />
      </div>

      <div v-else-if="!mounts.length" class="state">
        <svg class="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3H4V7Zm0 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3Z" />
        </svg>
        <h3>还没有挂载任何网盘</h3>
        <p>添加一个网盘后，它就会出现在这个列表里。</p>
        <div class="acts">
          <button v-if="isAdmin" class="btn btn-primary" @click="emit('manage')">添加网盘</button>
          <p v-else class="hint">请联系管理员添加挂载。</p>
        </div>
      </div>

      <div v-else class="rows" role="list">
        <button
          v-for="m in mounts"
          :key="m.id"
          class="row"
          :class="{ off: !m.enabled }"
          role="listitem"
          @click="m.enabled && emit('select', m.id)"
        >
          <span class="ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 19a4 4 0 0 1-.9-7.9 5.5 5.5 0 0 1 10.7-1.8A4.5 4.5 0 1 1 17.5 19H6Z" />
            </svg>
          </span>
          <span class="nm">
            {{ m.name }}
            <span v-if="!m.enabled" class="badge badge-muted">已停用</span>
          </span>
          <span class="meta">{{ m.driver }}</span>
          <svg class="go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
    </div>

    <p v-if="isAdmin && mounts.length" class="manage">
      <button class="btn btn-ghost btn-sm" @click="emit('manage')">管理挂载</button>
    </p>
  </section>
</template>

<style scoped>
.home { width: 100%; max-width: 1100px; margin: 0 auto; padding: 12px 16px 40px; }

.obj-box { padding: 10px; border-radius: var(--radius-xl); box-shadow: var(--shadow); }

.rows { display: flex; flex-direction: column; gap: 4px; }
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 13px 14px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), transform 0.16s var(--ease);
}
.row:hover { background: var(--surface-2); transform: scale(1.01); }
.row.off { cursor: not-allowed; opacity: 0.62; }
.row.off:hover { transform: none; }

.ic { width: 34px; height: 34px; flex-shrink: 0; display: grid; place-items: center; border-radius: var(--radius-sm); background: var(--brand-soft); color: var(--brand); }
.ic svg { width: 19px; height: 19px; }

.nm { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 8px; }
.meta { flex-shrink: 0; font-size: 12px; color: var(--text-faint); font-family: ui-monospace, monospace; }
.go { width: 15px; height: 15px; flex-shrink: 0; color: var(--text-faint); }

.sk-row { height: 52px; }

.state { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 56px 20px; gap: 6px; }
.state .big { width: 54px; height: 54px; color: var(--text-faint); margin-bottom: 6px; }
.state h3 { font-size: 15.5px; }
.state p { margin: 0; max-width: 420px; font-size: 13px; color: var(--text-soft); line-height: 1.7; }
.state .acts { margin-top: 14px; display: flex; gap: 8px; }
.state .hint { font-size: 12.5px; color: var(--text-faint); }

.manage { margin-top: 14px; text-align: center; }

@media (max-width: 768px) {
  .home { padding: 8px 10px 32px; }
  .meta { display: none; }
}
</style>
