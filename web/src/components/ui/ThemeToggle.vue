<script setup lang="ts">
import { computed } from "vue";
import { useTheme, type ThemeMode } from "../../composables/useTheme";

const { mode, cycle } = useTheme();

const META: Record<ThemeMode, { label: string; path: string }> = {
  light: {
    label: "浅色",
    path: "M12 3v1m0 16v1m9-9h-1M4 12H3m15.4-6.4-.7.7M6.3 17.7l-.7.7m12.8 0-.7-.7M6.3 6.3l-.7-.7M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  },
  dark: { label: "深色", path: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" },
  system: {
    label: "跟随系统",
    path: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm5 16h8",
  },
};

const cur = computed(() => META[mode.value]);
</script>

<template>
  <button
    class="btn btn-icon btn-ghost theme-toggle"
    :title="`主题：${cur.label}（点击切换）`"
    :aria-label="`当前主题 ${cur.label}，点击切换`"
    @click="cycle"
  >
    <Transition name="spin" mode="out-in">
      <svg
        :key="mode"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path :d="cur.path" />
      </svg>
    </Transition>
  </button>
</template>

<style scoped>
.theme-toggle svg { width: 17px; height: 17px; }
.spin-enter-active, .spin-leave-active { transition: transform 0.28s var(--ease), opacity 0.28s var(--ease); }
.spin-enter-from { transform: rotate(-90deg) scale(0.6); opacity: 0; }
.spin-leave-to { transform: rotate(90deg) scale(0.6); opacity: 0; }
</style>
