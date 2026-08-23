<script setup lang="ts">
import { computed, ref, watch } from "vue";
import FileIcon from "./ui/FileIcon.vue";
import { formatSize, formatTime, kindOf } from "../utils/format";
import type { FileItem } from "../api";

const props = defineProps<{
  item: FileItem;
  view: "grid" | "list";
  selected: boolean;
  /** 已经进入多选状态时，复选框常驻显示 */
  picking: boolean;
  /** 网格视图的图片缩略图 URL（有则替代图标展示） */
  thumb?: string;
}>();
const emit = defineEmits<{
  (e: "open", item: FileItem): void;
  (e: "toggle", item: FileItem): void;
  (e: "menu", payload: { item: FileItem; anchor: HTMLElement }): void;
}>();

const kind = computed(() => kindOf(props.item));
const meta = computed(() =>
  props.item.is_dir ? "文件夹" : `${formatSize(props.item.size)} · ${formatTime(props.item.modified)}`
);

// 缩略图加载失败（链接过期 / 上游异常）就退回图标，不露破图
const thumbBroken = ref(false);
watch(() => props.thumb, () => (thumbBroken.value = false));

function openMenu(e: MouseEvent) {
  emit("menu", { item: props.item, anchor: e.currentTarget as HTMLElement });
}
// 右键也走同一套菜单，桌面用户的肌肉记忆
function onContext(e: MouseEvent) {
  e.preventDefault();
  emit("menu", { item: props.item, anchor: e.currentTarget as HTMLElement });
}
</script>

<template>
  <!-- 用 role=button + tabindex 而不是裸 div：键盘用户可以 Tab 过来、Enter 打开。
       原实现整张卡片只有一个 @click，键盘完全无法操作。 -->
  <div
    class="entry"
    :class="[view, { selected, picking }]"
    role="button"
    tabindex="0"
    :aria-label="`${item.is_dir ? '文件夹' : '文件'} ${item.name}`"
    @click="emit('open', item)"
    @keydown.enter.prevent="emit('open', item)"
    @keydown.space.prevent="emit('toggle', item)"
    @contextmenu="onContext"
  >
    <label class="pick" @click.stop>
      <input
        type="checkbox"
        :checked="selected"
        :aria-label="`选择 ${item.name}`"
        @change="emit('toggle', item)"
      />
    </label>

    <div v-if="view === 'grid' && thumb && !thumbBroken" class="thumb-box">
      <img :src="thumb" :alt="item.name" loading="lazy" @error="thumbBroken = true" />
    </div>
    <FileIcon v-else class="icon" :kind="kind" :size="view === 'grid' ? 40 : 22" />

    <div class="info">
      <div class="name" :title="item.name">{{ item.name }}</div>
      <div v-if="view === 'grid'" class="meta">{{ meta }}</div>
    </div>

    <template v-if="view === 'list'">
      <div class="col size">{{ item.is_dir ? "—" : formatSize(item.size) }}</div>
      <div class="col time">{{ formatTime(item.modified) }}</div>
    </template>

    <button class="more" :aria-label="`${item.name} 的更多操作`" @click.stop="openMenu">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.entry {
  position: relative;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color 0.16s var(--ease), border-color 0.16s var(--ease), transform 0.16s var(--ease),
    box-shadow 0.16s var(--ease);
}
.entry:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

/* ---------- 网格 ---------- */
.entry.grid {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 12px 14px;
  border-radius: var(--radius-lg);
  background: var(--surface);
  border-color: var(--border);
  text-align: center;
}
.entry.grid:hover { transform: translateY(-2px); box-shadow: var(--shadow); border-color: var(--border-strong); }
.entry.grid .info { width: 100%; min-width: 0; }
/* 图片缩略图（OpenList 网格形态）：等比裁满，圆角随卡片 */
.entry.grid .thumb-box {
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface-2);
}
.entry.grid .thumb-box img { width: 100%; height: 100%; object-fit: cover; display: block; }
.entry.grid .name {
  font-size: 13px;
  line-height: 1.45;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.entry.grid .meta { margin-top: 3px; font-size: 11px; color: var(--text-faint); }
.entry.grid .more { position: absolute; top: 6px; right: 6px; }
.entry.grid .pick { position: absolute; top: 8px; left: 8px; }

/* ---------- 列表（OpenList 风格：整行圆角卡片，悬浮轻微放大，无分隔线） ---------- */
.entry.list {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: var(--radius);
}
.entry.list + .entry.list { margin-top: 2px; }
.entry.list:hover { background: var(--surface-2); transform: scale(1.01); }
.entry.list .info { flex: 1; min-width: 0; }
.entry.list .name { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col { flex-shrink: 0; font-size: 12.5px; color: var(--text-soft); font-variant-numeric: tabular-nums; }
.size { width: 92px; text-align: right; }
.time { width: 132px; text-align: right; }

/* ---------- 选中 ---------- */
.entry.selected { background: var(--brand-soft); border-color: var(--brand); }

.pick { display: none; }
.entry.picking .pick,
.entry:hover .pick,
.entry.selected .pick { display: block; }
.pick input {
  width: 16px;
  height: 16px;
  accent-color: var(--brand);
  cursor: pointer;
}

.more {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.16s var(--ease), background-color 0.16s var(--ease);
}
.entry:hover .more,
.entry:focus-within .more { opacity: 1; }
.more:hover { background: var(--surface-3); color: var(--text); }
.more svg { width: 15px; height: 15px; }

@media (hover: none) {
  /* 触屏没有 hover，操作入口必须常驻，否则用户根本发现不了 */
  .more { opacity: 1; }
}

@media (max-width: 768px) {
  .entry.list { padding: 11px 8px; gap: 10px; }
  .time { display: none; }
  .size { width: 66px; font-size: 11.5px; }
  .entry.grid { padding: 14px 8px 12px; }
}
</style>
