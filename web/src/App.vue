<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import LoginView from "./components/LoginView.vue";
import SetupView from "./components/SetupView.vue";
import TopBar from "./components/TopBar.vue";
import StorageHome from "./components/StorageHome.vue";
import FileBrowser from "./components/FileBrowser.vue";
import SearchPanel from "./components/SearchPanel.vue";
import UploadQueue from "./components/UploadQueue.vue";
import Previewer from "./components/Previewer.vue";
import MountManager from "./components/MountManager.vue";
import ChangePasswordModal from "./components/ChangePasswordModal.vue";
import ToastHost from "./components/ui/ToastHost.vue";
import DialogHost from "./components/ui/DialogHost.vue";
import { ApiError, api, clearToken, getToken, onSessionExpired, type FileItem, type MountRow, type UserInfo } from "./api";
import type { SearchRow } from "./types";
import { useToast } from "./composables/useToast";
import { useDialog } from "./composables/useDialog";

const toast = useToast();
const dialog = useDialog();

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
// /setup 是首次部署的初始化页：由应用自身渲染（与登录页同一套加载链路），
// 不走独立内嵌脚本页——那条路在部分浏览器/代理环境下脚本不执行，表现为「提交没反应」。
const isSetup = ref(location.pathname.replace(/\/+$/, "") === "/setup");

const booting = ref(true);
const bootError = ref("");
const user = ref<UserInfo | null>(null);
const sessionNotice = ref("");

const mounts = ref<MountRow[]>([]);
const mountsLoading = ref(false);
const curMountId = ref<number | null>(null);
const curPath = ref("/");

const keyword = ref("");
const searching = ref(false);

const showMounts = ref(false);
const showPwd = ref(false);
const preview = ref<{ item: FileItem; list: FileItem[] } | null>(null);

const curMount = computed(() => mounts.value.find((m) => m.id === curMountId.value) ?? null);
const isAdmin = computed(() => user.value?.role === "admin");

// ---------------------------------------------------------------------------
// 地址栏同步。
// 过去整个应用只有一个地址，浏览器「后退」等于直接退出应用 ——
// 用户反馈的「莫名其妙回到首页」有一部分就是这么来的。
// 现在目录层级进 history，后退＝回上一层。
// ---------------------------------------------------------------------------
function readUrl(): { m: number | null; p: string } {
  const q = new URLSearchParams(location.search);
  const m = Number(q.get("m"));
  return { m: Number.isFinite(m) && m > 0 ? m : null, p: q.get("p") || "/" };
}

function syncUrl(replace = false) {
  const q = new URLSearchParams();
  if (curMountId.value != null) q.set("m", String(curMountId.value));
  if (curPath.value !== "/") q.set("p", curPath.value);
  const qs = q.toString();
  const url = location.pathname + (qs ? "?" + qs : "");
  const state = { m: curMountId.value, p: curPath.value };
  try {
    replace ? history.replaceState(state, "", url) : history.pushState(state, "", url);
  } catch {
    // file:// 或某些内嵌 WebView 下 pushState 会抛错，忽略即可，功能不受影响
  }
}

function onPopState(e: PopStateEvent) {
  // 有预览打开时，后退优先关掉预览，这符合移动端用户的直觉
  if (preview.value) {
    preview.value = null;
    return;
  }
  const s = (e.state as { m?: number | null; p?: string } | null) || readUrl();
  const m = s.m ?? null;
  if (m == null) curMountId.value = null; // 后退回到存储列表首页
  else if (mounts.value.some((x) => x.id === m)) curMountId.value = m;
  curPath.value = s.p || "/";
  keyword.value = "";
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function boot() {
  booting.value = true;
  bootError.value = "";
  try {
    if (!getToken()) {
      user.value = null;
      return;
    }
    const me = await api.me();
    user.value = me;
    if (me) await loadMounts({ fromUrl: true });
  } catch (e) {
    // 关键：网络/超时/500 一律**不登出**。
    // 旧实现在这里 catch 后直接 logout()，于是 Worker 冷启动慢一点、
    // 或者手机切了个网络，用户就被踢回登录页并丢失当前位置。
    bootError.value = e instanceof ApiError ? e.message : "无法连接到服务";
  } finally {
    booting.value = false;
  }
}

async function loadMounts(opts: { fromUrl?: boolean } = {}) {
  mountsLoading.value = true;
  try {
    const list = await api.listMounts();
    mounts.value = list;

    // 当前挂载被删了 → 回落，而不是留在一个永远 404 的目录上
    if (curMountId.value != null && !list.some((m) => m.id === curMountId.value)) {
      curMountId.value = null;
      curPath.value = "/";
    }
    if (curMountId.value == null) {
      // OpenList 形态：根目录就是存储列表，不自动跳进第一个挂载
      const want = opts.fromUrl ? readUrl().m : null;
      const hit = want != null ? list.find((m) => m.id === want) : undefined;
      curMountId.value = hit?.id ?? null;
      if (hit && opts.fromUrl) curPath.value = readUrl().p;
    }
    syncUrl(true);
  } catch (e) {
    if (e instanceof ApiError && e.isSessionExpired) return;
    toast.fromError(e, "挂载列表加载失败", () => void loadMounts());
  } finally {
    mountsLoading.value = false;
  }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------
function resetSession() {
  user.value = null;
  mounts.value = [];
  curMountId.value = null;
  curPath.value = "/";
  keyword.value = "";
  preview.value = null;
  showMounts.value = false;
  showPwd.value = false;
}

const offSession = onSessionExpired(() => {
  resetSession();
  // 唯一会把用户送回登录页的路径：后端明确回了 code=unauthenticated
  sessionNotice.value = "登录状态已过期，请重新登录。";
});

async function onLoggedIn(u: UserInfo) {
  sessionNotice.value = "";
  user.value = u;
  await loadMounts({ fromUrl: true });
}

async function logout() {
  const ok = await dialog.confirm({
    title: "退出登录",
    message: "退出后需要重新输入用户名和密码。",
    confirmText: "退出",
  });
  if (!ok) return;
  clearToken();
  resetSession();
  sessionNotice.value = "";
  syncUrl(true);
}

// ---------------------------------------------------------------------------
// 导航
// ---------------------------------------------------------------------------
function navigate(path: string) {
  if (path === curPath.value) return;
  curPath.value = path;
  syncUrl();
}
// OpenList 的「回到首页」：存储列表
function goHome() {
  if (curMountId.value == null) return;
  curMountId.value = null;
  curPath.value = "/";
  keyword.value = "";
  syncUrl();
}
function selectMount(id: number) {
  if (id === curMountId.value) return;
  curMountId.value = id;
  curPath.value = "/";
  keyword.value = "";
  syncUrl();
}
function openSearchResult(row: SearchRow) {
  const target = row.is_dir ? row.path : row.dir || "/";
  if (row.mount_id !== curMountId.value) curMountId.value = row.mount_id;
  curPath.value = target || "/";
  keyword.value = "";
  syncUrl();
}

function onMountsChanged() {
  void loadMounts();
}

onMounted(() => {
  window.addEventListener("popstate", onPopState);
  // 初始化页不需要会话恢复
  if (!isSetup.value) void boot();
});
onBeforeUnmount(() => {
  window.removeEventListener("popstate", onPopState);
  offSession();
});
</script>

<template>
  <!-- 首次部署初始化页（/setup） -->
  <SetupView v-if="isSetup" @done="isSetup = false" />

  <!-- 启动中 -->
  <div v-else-if="booting" class="boot">
    <span class="spin" aria-hidden="true" />
    <p>正在连接…</p>
  </div>

  <!-- 启动失败：给出重试，而不是粗暴地登出 -->
  <div v-else-if="bootError" class="boot">
    <svg class="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
    <h2>{{ bootError }}</h2>
    <p>你的登录状态还在，只是这次没连上服务。</p>
    <div class="acts">
      <button class="btn btn-primary" @click="boot">重试</button>
      <button class="btn btn-ghost" @click="clearToken(); resetSession(); bootError = ''">退出登录</button>
    </div>
  </div>

  <!-- 未登录 -->
  <LoginView v-else-if="!user" :notice="sessionNotice" @logged-in="onLoggedIn" />

  <!-- 主界面 -->
  <div v-else class="shell">
    <TopBar
      v-model:keyword="keyword"
      :user="user"
      :searching="searching"
      @home="goHome"
      @open-mounts="showMounts = true"
      @change-password="showPwd = true"
      @logout="logout"
    />

    <div class="body">
      <main class="main">
        <SearchPanel
          v-if="keyword"
          :keyword="keyword"
          @open="openSearchResult"
          @exit="keyword = ''"
          @busy="searching = $event"
        />
        <StorageHome
          v-else-if="!curMount"
          :mounts="mounts"
          :loading="mountsLoading"
          :is-admin="isAdmin"
          @select="selectMount"
          @manage="showMounts = true"
        />
        <FileBrowser
          v-else
          :mount="curMount"
          :path="curPath"
          :has-mounts="mounts.length > 0"
          :is-admin="isAdmin"
          @navigate="navigate"
          @preview="preview = $event"
          @manage="showMounts = true"
          @home="goHome"
        />
      </main>
    </div>

    <footer class="footer">EdgeOpenList · OpenList 移植版</footer>
  </div>

  <!-- 悬浮层 -->
  <UploadQueue v-if="user" />
  <Previewer
    v-if="preview && curMount"
    :mount="curMount"
    :item="preview.item"
    :list="preview.list"
    @close="preview = null"
  />
  <MountManager v-if="showMounts" :mounts="mounts" @close="showMounts = false" @changed="onMountsChanged" />
  <ChangePasswordModal v-if="showPwd" @close="showPwd = false" />

  <DialogHost />
  <ToastHost />
</template>

<style scoped>
.shell { height: 100%; display: flex; flex-direction: column; }
.body { flex: 1; display: flex; min-height: 0; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.footer {
  flex-shrink: 0;
  padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  text-align: center;
  font-size: 11.5px;
  color: var(--text-faint);
}

.boot {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  color: var(--text-soft);
}
.boot h2 { font-size: 16px; color: var(--text); }
.boot p { margin: 0; font-size: 13px; max-width: 380px; line-height: 1.7; }
.boot .big { width: 46px; height: 46px; color: var(--text-faint); }
.boot .acts { margin-top: 14px; display: flex; gap: 8px; }
.spin {
  width: 28px;
  height: 28px;
  border: 2.5px solid var(--border-strong);
  border-top-color: var(--brand);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
