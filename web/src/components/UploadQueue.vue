<script setup lang="ts">
import { computed } from "vue";
import { useUploads } from "../composables/useUploads";
import { formatSize } from "../utils/format";

// 悬浮上传面板。
// 旧版上传是「点了按钮 → 界面毫无变化 → 过一会儿列表可能多个文件」，
// 大文件时用户完全不知道发生了什么，这里把每个文件的进度、失败原因、
// 取消与重试全部摊开。

const { tasks, panelOpen, clearFinished, cancel, retry, remove } = useUploads();

const visible = computed(() => tasks.value.length > 0);
const doneCount = computed(() => tasks.value.filter((t) => t.status === "done").length);
const activeCount = computed(() => tasks.value.filter((t) => t.status === "uploading" || t.status === "queued").length);

const STATUS_TEXT: Record<string, string> = {
  queued: "排队中",
  uploading: "上传中",
  done: "已完成",
  error: "失败",
  canceled: "已取消",
};

function pct(loaded: number, size: number): number {
  if (!size) return 0;
  return Math.min(100, Math.round((loaded / size) * 100));
}
</script>

<template>
  <Transition name="pop">
    <section v-if="visible" class="upq panel" aria-label="上传队列">
      <header class="head" @click="panelOpen = !panelOpen">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 19V5m0 0-6 6m6-6 6 6" />
        </svg>
        <span class="t">
          {{ activeCount ? `上传中 ${activeCount} 个` : `已完成 ${doneCount} 个` }}
        </span>
        <button
          v-if="!activeCount"
          class="btn btn-sm btn-ghost"
          @click.stop="clearFinished"
        >
          清空
        </button>
        <button class="btn btn-icon btn-ghost fold" :aria-label="panelOpen ? '收起' : '展开'" @click.stop="panelOpen = !panelOpen">
          <svg :class="{ up: panelOpen }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </header>

      <ul v-show="panelOpen" class="list">
        <li v-for="t in tasks" :key="t.id" class="task" :class="t.status">
          <div class="row1">
            <span class="nm" :title="t.name">{{ t.name }}</span>
            <span class="st">{{ STATUS_TEXT[t.status] }}</span>
          </div>
          <div class="bar" :aria-valuenow="pct(t.loaded, t.size)" role="progressbar" aria-valuemin="0" aria-valuemax="100">
            <i :style="{ width: (t.status === 'done' ? 100 : pct(t.loaded, t.size)) + '%' }" />
          </div>
          <div class="row2">
            <span class="sz">
              <template v-if="t.status === 'uploading'">
                {{ formatSize(t.loaded) }} / {{ formatSize(t.size) }}
              </template>
              <template v-else-if="t.status === 'error'">{{ t.error }}</template>
              <template v-else>{{ formatSize(t.size) }}</template>
            </span>
            <span class="ops">
              <button v-if="t.status === 'uploading' || t.status === 'queued'" class="mini" @click="cancel(t.id)">取消</button>
              <button v-if="t.status === 'error' || t.status === 'canceled'" class="mini" @click="retry(t.id)">重试</button>
              <button class="mini" @click="remove(t.id)">移除</button>
            </span>
          </div>
        </li>
      </ul>
    </section>
  </Transition>
</template>

<style scoped>
.upq {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 200;
  width: min(360px, calc(100vw - 32px));
  overflow: hidden;
  box-shadow: var(--shadow-lg);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 14px;
  cursor: pointer;
  user-select: none;
}
.head .ic { width: 16px; height: 16px; color: var(--brand); }
.head .t { flex: 1; font-size: 13px; font-weight: 600; }
.fold svg { width: 15px; height: 15px; transition: transform var(--dur) var(--ease); }
.fold svg.up { transform: rotate(180deg); }

.list {
  list-style: none;
  margin: 0;
  padding: 0 10px 10px;
  max-height: 46vh;
  overflow-y: auto;
  border-top: 1px solid var(--border);
}
.task { padding: 10px 4px 8px; border-bottom: 1px solid var(--border); }
.task:last-child { border-bottom: none; }

.row1 { display: flex; align-items: baseline; gap: 8px; }
.nm { flex: 1; min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st { font-size: 11px; color: var(--text-faint); flex-shrink: 0; }
.task.error .st { color: var(--danger); }
.task.done .st { color: var(--success); }

.bar { margin: 6px 0 5px; height: 4px; border-radius: 99px; background: var(--surface-3); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--brand); border-radius: 99px; transition: width 0.2s var(--ease); }
.task.done .bar i { background: var(--success); }
.task.error .bar i { background: var(--danger); }
.task.canceled .bar i { background: var(--text-faint); }

.row2 { display: flex; align-items: center; gap: 8px; }
.sz { flex: 1; min-width: 0; font-size: 11px; color: var(--text-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task.error .sz { color: var(--danger); }
.ops { display: flex; gap: 4px; flex-shrink: 0; }
.mini {
  border: none;
  background: transparent;
  color: var(--text-soft);
  font-family: inherit;
  font-size: 11.5px;
  padding: 2px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.mini:hover { background: var(--surface-3); color: var(--text); }

@media (max-width: 768px) {
  .upq { right: 10px; left: 10px; bottom: calc(10px + env(safe-area-inset-bottom)); width: auto; }
  .list { max-height: 38vh; }
}
</style>
