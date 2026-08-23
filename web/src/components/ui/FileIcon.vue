<script setup lang="ts">
import { computed } from "vue";
import type { FileKind } from "../../utils/format";

// 用 SVG 而非 emoji：emoji 在 Windows / 安卓上渲染差异极大，
// 且无法跟随主题变色，深色模式下常常糊成一团。
const props = withDefaults(defineProps<{ kind: FileKind; size?: number }>(), { size: 24 });

const PATHS: Record<FileKind, string> = {
  dir: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  image: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm2 12 4-4 3 3 3-3 4 4M8.5 9.5a1 1 0 1 1 0-.01",
  video: "M3 6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm13 4 5-3v10l-5-3",
  audio: "M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm10-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  pdf: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 15h1.5a1.5 1.5 0 0 0 0-3H8v6m5-6v6h1a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-1Z",
  text: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h5",
  code: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6m-9 4-2 3 2 3m4-6 2 3-2 3",
  archive: "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Zm7-2v3m2 1v3m-2 1v3m2 1v2a1 1 0 0 1-1 1h0a1 1 0 0 1-1-1v-2h2Z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6",
};

const path = computed(() => PATHS[props.kind] || PATHS.file);
</script>

<template>
  <svg
    class="file-icon"
    :class="'k-' + kind"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="path" />
  </svg>
</template>

<style scoped>
/* OpenList 风格：图标统一用主色，靠形状区分类型，而不是彩虹色 */
.file-icon { flex-shrink: 0; }
.k-dir { color: var(--brand); fill: var(--brand-soft); }
.k-image,
.k-video,
.k-audio,
.k-pdf,
.k-code,
.k-archive { color: var(--brand); }
.k-text { color: var(--text-soft); }
.k-file { color: var(--text-faint); }
</style>
