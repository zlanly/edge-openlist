<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import FileIcon from "./ui/FileIcon.vue";
import { ApiError, api } from "../api";
import { formatSize, formatTime, kindOf } from "../utils/format";
import type { SearchRow } from "../types";

const props = defineProps<{ keyword: string }>();
const emit = defineEmits<{
  (e: "open", row: SearchRow): void;
  (e: "exit"): void;
  (e: "busy", v: boolean): void;
}>();

const rows = ref<SearchRow[]>([]);
const loading = ref(false);
const failure = ref<string | null>(null);

let inflight: AbortController | null = null;

async function run() {
  const kw = props.keyword.trim();
  inflight?.abort();
  if (!kw) {
    rows.value = [];
    return;
  }
  const ctl = new AbortController();
  inflight = ctl;
  loading.value = true;
  emit("busy", true);
  failure.value = null;
  try {
    const res = await api.search(kw, ctl.signal);
    if (ctl.signal.aborted) return;
    rows.value = res as SearchRow[];
  } catch (e) {
    if (ctl.signal.aborted) return;
    if (e instanceof ApiError && e.isSessionExpired) return;
    failure.value = e instanceof Error ? e.message : "搜索失败";
    rows.value = [];
  } finally {
    if (inflight === ctl) {
      inflight = null;
      loading.value = false;
      emit("busy", false);
    }
  }
}

watch(() => props.keyword, run, { immediate: true });
onBeforeUnmount(() => inflight?.abort());

function kindFor(r: SearchRow) {
  return kindOf({ name: r.name, is_dir: !!r.is_dir });
}
</script>

<template>
  <section class="search-panel">
    <div class="head">
      <div class="ttl">
        搜索「<b>{{ keyword }}</b>」
        <span v-if="!loading" class="cnt">{{ rows.length }} 条结果</span>
      </div>
      <button class="btn btn-sm btn-ghost" @click="emit('exit')">返回浏览</button>
    </div>

    <p class="tip">
      搜索基于「你浏览过的目录」建立的本地索引，没打开过的目录不会出现在结果里。
    </p>

    <div v-if="loading" class="list">
      <div v-for="i in 6" :key="i" class="skeleton sk" />
    </div>

    <div v-else-if="failure" class="state">
      <p>{{ failure }}</p>
      <button class="btn btn-primary" @click="run">重试</button>
    </div>

    <div v-else-if="!rows.length" class="state">
      <p>没有找到匹配的文件。</p>
      <p class="dim">试试更短的关键词，或者先进入对应目录浏览一次让它进入索引。</p>
    </div>

    <div v-else class="list">
      <button v-for="r in rows" :key="r.mount_id + r.path" class="row" @click="emit('open', r)">
        <FileIcon :kind="kindFor(r)" :size="20" />
        <span class="info">
          <span class="nm">{{ r.name }}</span>
          <span class="loc">{{ r.mount_name }} · {{ r.dir || "/" }}</span>
        </span>
        <span class="sz">{{ r.is_dir ? "文件夹" : formatSize(r.size) }}</span>
        <span class="tm">{{ formatTime(r.modified) }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.search-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 16px 18px 28px; overflow-y: auto; }

.head { display: flex; align-items: center; gap: 12px; }
.ttl { flex: 1; font-size: 14.5px; }
.ttl b { color: var(--brand-strong); }
.cnt { margin-left: 8px; font-size: 12.5px; color: var(--text-faint); }

.tip { margin: 6px 0 14px; font-size: 12px; color: var(--text-faint); line-height: 1.6; }

.list { display: flex; flex-direction: column; }
.sk { height: 44px; margin-bottom: 6px; }

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s var(--ease);
}
.row:hover { background: var(--surface-2); }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loc { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sz { width: 88px; text-align: right; font-size: 12.5px; color: var(--text-soft); font-variant-numeric: tabular-nums; }
.tm { width: 124px; text-align: right; font-size: 12.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }

.state { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 56px 20px; text-align: center; }
.state p { margin: 0; font-size: 13.5px; color: var(--text-soft); }
.state .dim { font-size: 12.5px; color: var(--text-faint); max-width: 380px; line-height: 1.7; }

@media (max-width: 768px) {
  .search-panel { padding: 12px 12px 28px; }
  .tm { display: none; }
  .sz { width: 64px; font-size: 11.5px; }
}
</style>
