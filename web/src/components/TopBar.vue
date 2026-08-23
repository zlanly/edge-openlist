<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import ThemeToggle from "./ui/ThemeToggle.vue";
import PopMenu from "./ui/PopMenu.vue";
import type { MenuItem } from "./ui/menu";
import { useUploads } from "../composables/useUploads";
import type { UserInfo } from "../api";

const props = defineProps<{ user: UserInfo | null; keyword: string; searching: boolean }>();
const emit = defineEmits<{
  (e: "update:keyword", v: string): void;
  (e: "home"): void;
  (e: "open-mounts"): void;
  (e: "change-password"): void;
  (e: "logout"): void;
}>();

const { active, failed, progress, panelOpen } = useUploads();

// 搜索防抖：原实现 @input 直接打接口，一个字一次请求，
// 慢网络下几十个请求乱序回来，结果闪来闪去还容易触发限流。
const local = ref(props.keyword);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => props.keyword,
  (v) => {
    if (v !== local.value) local.value = v;
  }
);
watch(local, (v) => {
  clearTimeout(timer);
  timer = setTimeout(() => emit("update:keyword", v.trim()), 280);
});
onBeforeUnmount(() => clearTimeout(timer));

function clearSearch() {
  local.value = "";
  clearTimeout(timer);
  emit("update:keyword", "");
}

// OpenList 同款：Ctrl / Cmd + K 聚焦搜索
const searchInput = ref<HTMLInputElement | null>(null);
function onGlobalKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchInput.value?.focus();
    searchInput.value?.select();
  }
}
onMounted(() => window.addEventListener("keydown", onGlobalKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKey));

const userBtn = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
const menuItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [];
  if (props.user?.role === "admin") {
    items.push({
      key: "mounts",
      label: "管理挂载",
      icon: "M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3H4V7Zm0 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3Zm3.5-6h.01M7.5 15.5h.01",
    });
  }
  items.push({
    key: "password",
    label: "修改密码",
    icon: "M7 11V8a5 5 0 0 1 10 0v3m-11 0h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z",
  });
  items.push({
    key: "logout",
    label: "退出登录",
    icon: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9",
    danger: true,
    divided: true,
  });
  return items;
});

function onMenu(key: string) {
  menuOpen.value = false;
  if (key === "mounts") emit("open-mounts");
  else if (key === "password") emit("change-password");
  else if (key === "logout") emit("logout");
}

const initial = computed(() => (props.user?.username || "?").slice(0, 1).toUpperCase());
const uploadPct = computed(() => Math.round(progress.value * 100));

// 有失败的任务时按钮必须继续留着 —— 否则用户唯一能回到上传面板重试的入口
// 会在最后一个任务失败的瞬间消失，失败结果永远看不到。
const showUploads = computed(() => active.value.length > 0 || failed.value.length > 0);
const uploadTitle = computed(() =>
  active.value.length ? `${active.value.length} 个文件上传中` : `${failed.value.length} 个文件上传失败`
);
</script>

<template>
  <header class="topbar">
    <button class="brand" title="回到存储列表" aria-label="回到存储列表" @click="emit('home')">
      <svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 19a4 4 0 0 1-.9-7.9 5.5 5.5 0 0 1 10.7-1.8A4.5 4.5 0 1 1 17.5 19H6Z" />
      </svg>
      <span class="name">EdgeOpenList</span>
    </button>

    <div class="search">
      <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
           stroke-linecap="round" aria-hidden="true">
        <path d="m21 21-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" />
      </svg>
      <input
        ref="searchInput"
        v-model="local"
        class="input"
        type="search"
        placeholder="搜索已浏览过的文件…"
        aria-label="搜索文件"
        @keydown.esc="clearSearch"
      />
      <span v-if="searching" class="dot-spin" aria-hidden="true" />
      <button v-else-if="local" class="clr" aria-label="清空搜索" @click="clearSearch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
      <kbd v-else class="kbd" aria-hidden="true">Ctrl K</kbd>
    </div>

    <div class="right">
      <button
        v-if="showUploads"
        class="btn btn-ghost up-btn"
        :class="{ bad: !active.length && failed.length }"
        :title="uploadTitle"
        :aria-label="uploadTitle"
        @click="panelOpen = !panelOpen"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 19V5m0 0-6 6m6-6 6 6" />
        </svg>
        <span class="up-txt">{{ active.length ? uploadPct + "%" : failed.length + " 个失败" }}</span>
        <span v-if="active.length" class="up-bar"><i :style="{ width: uploadPct + '%' }" /></span>
      </button>

      <ThemeToggle />

      <button ref="userBtn" class="user" :aria-expanded="menuOpen" aria-haspopup="menu" @click="menuOpen = !menuOpen">
        <span class="avatar" aria-hidden="true">{{ initial }}</span>
        <span class="uname">{{ user?.username }}</span>
        <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <PopMenu v-if="menuOpen" :anchor="userBtn" :items="menuItems" @select="onMenu" @close="menuOpen = false" />
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--header-h);
  padding: 0 16px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  backdrop-filter: saturate(180%) blur(14px);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 120;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease);
}
.brand:hover { background: var(--surface-3); }
.mark { width: 22px; height: 22px; color: var(--brand); }
.name { font-weight: 680; font-size: 15px; letter-spacing: -0.01em; }

.search { position: relative; flex: 1; max-width: 440px; }
.search .input { padding-left: 34px; padding-right: 34px; background: var(--surface-2); }
.si {
  position: absolute;
  left: 11px;
  top: 50%;
  transform: translateY(-50%);
  width: 15px;
  height: 15px;
  color: var(--text-faint);
  pointer-events: none;
}
.search .input::-webkit-search-cancel-button { display: none; }
.kbd {
  position: absolute;
  right: 9px;
  top: 50%;
  transform: translateY(-50%);
  padding: 1px 7px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-faint);
  font-family: inherit;
  font-size: 10.5px;
  pointer-events: none;
}
.search .input:focus ~ .kbd { display: none; }
.clr {
  position: absolute;
  right: 7px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}
.clr:hover { background: var(--surface-3); color: var(--text); }
.clr svg { width: 12px; height: 12px; }
.dot-spin {
  position: absolute;
  right: 12px;
  top: 50%;
  margin-top: -6px;
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--brand);
  border-radius: 50%;
  animation: spin 0.65s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.right { margin-left: auto; display: flex; align-items: center; gap: 6px; }

.up-btn { position: relative; gap: 6px; overflow: hidden; }
.up-btn svg { width: 15px; height: 15px; }
.up-txt { font-variant-numeric: tabular-nums; font-size: 12.5px; }
.up-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--surface-3); }
.up-bar i { display: block; height: 100%; background: var(--brand); transition: width 0.25s var(--ease); }
.up-btn.bad { color: var(--danger); }

.user {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 9px 5px 5px;
  border: 1px solid transparent;
  border-radius: 99px;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease);
}
.user:hover { background: var(--surface-3); }
.avatar {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--brand);
  color: #fff;
  font-size: 12px;
  font-weight: 650;
}
.caret { width: 13px; height: 13px; color: var(--text-faint); }

@media (max-width: 900px) {
  .uname { display: none; }
  .caret { display: none; }
  .user { padding: 4px; }
}
@media (max-width: 768px) {
  .topbar { padding: 0 10px; gap: 8px; }
  .brand { padding: 6px 4px; }
  .search { max-width: none; }
  .kbd { display: none; }
  .up-txt { display: none; }
}
</style>
