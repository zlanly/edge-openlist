<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import FileEntry from "./FileEntry.vue";
import PopMenu from "./ui/PopMenu.vue";
import type { MenuItem } from "./ui/menu";
import { ApiError, api, type FileItem, type MountRow } from "../api";
import { useToast } from "../composables/useToast";
import { useDialog } from "../composables/useDialog";
import { useUploads } from "../composables/useUploads";
import { isPreviewable, joinPath, kindOf, parentOf } from "../utils/format";
import { readLS, writeLS } from "../utils/storage";

const props = defineProps<{
  mount: MountRow | null;
  path: string;
  hasMounts: boolean;
  isAdmin: boolean;
}>();
const emit = defineEmits<{
  (e: "navigate", path: string): void;
  (e: "preview", payload: { item: FileItem; list: FileItem[] }): void;
  (e: "manage"): void;
}>();

const toast = useToast();
const dialog = useDialog();
const uploads = useUploads();

const items = ref<FileItem[]>([]);
const loading = ref(false);
const failure = ref<ApiError | null>(null);

// ---------------------------------------------------------------------------
// 载入。关键点：用 AbortController 取消上一次请求。
// 旧实现在快速点几个目录时会有多个 list 请求并发返回，最后落地的可能是最早发出的那个，
// 于是「点了 A 却显示 B 的内容」，用户以为界面卡死了。
// ---------------------------------------------------------------------------
let inflight: AbortController | null = null;

async function load(opts: { silent?: boolean } = {}) {
  const mount = props.mount;
  inflight?.abort();
  if (!mount) {
    items.value = [];
    loading.value = false;
    failure.value = null;
    return;
  }
  const ctl = new AbortController();
  inflight = ctl;
  if (!opts.silent) loading.value = true;
  failure.value = null;
  try {
    const res = await api.listFiles(mount.id, props.path, ctl.signal);
    if (ctl.signal.aborted) return;
    items.value = res;
    selected.value = new Set();
  } catch (e) {
    if (ctl.signal.aborted) return;
    // 会话失效由 App 统一接管；其余错误就地展示 + 提供重试，绝不留白屏
    if (e instanceof ApiError && e.isSessionExpired) return;
    failure.value =
      e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : "加载失败", 0, "internal");
    items.value = [];
  } finally {
    if (inflight === ctl) {
      inflight = null;
      loading.value = false;
    }
  }
}

watch(
  () => [props.mount?.id, props.path] as const,
  () => load(),
  { immediate: true }
);
onBeforeUnmount(() => inflight?.abort());

// 某个文件传完 → 如果正好是当前目录，静默刷新（不闪骨架屏）
const offUploadDone = uploads.onDone((mountId, dir) => {
  if (props.mount?.id === mountId && dir === props.path) void load({ silent: true });
});
onBeforeUnmount(offUploadDone);

// ---------------------------------------------------------------------------
// 视图 / 排序（持久化，用户不用每次重设）
// ---------------------------------------------------------------------------
type SortKey = "name" | "size" | "modified";
const view = ref<"grid" | "list">(readLS("eol_view") === "grid" ? "grid" : "list");
const sortKey = ref<SortKey>((readLS("eol_sort_key") as SortKey) || "name");
const sortAsc = ref(readLS("eol_sort_asc") !== "0");
watch(view, (v) => writeLS("eol_view", v));
watch([sortKey, sortAsc], () => {
  writeLS("eol_sort_key", sortKey.value);
  writeLS("eol_sort_asc", sortAsc.value ? "1" : "0");
});

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

const sorted = computed(() => {
  const arr = items.value.slice();
  const dir = sortAsc.value ? 1 : -1;
  arr.sort((a, b) => {
    // 文件夹恒在前：这是资源管理器的通用心智，按大小倒序时也不例外
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let r: number;
    if (sortKey.value === "size") r = (a.size || 0) - (b.size || 0);
    else if (sortKey.value === "modified") r = (a.modified || 0) - (b.modified || 0);
    else r = collator.compare(a.name, b.name);
    return (r || collator.compare(a.name, b.name)) * dir;
  });
  return arr;
});

const previewables = computed(() => sorted.value.filter((i) => !i.is_dir && isPreviewable(kindOf(i))));

const SORT_LABEL: Record<SortKey, string> = { name: "名称", size: "大小", modified: "修改时间" };
const sortBtn = ref<HTMLElement | null>(null);
const sortMenuOpen = ref(false);
const sortMenu = computed<MenuItem[]>(() => [
  { key: "name", label: "按名称" + (sortKey.value === "name" ? " ✓" : "") },
  { key: "size", label: "按大小" + (sortKey.value === "size" ? " ✓" : "") },
  { key: "modified", label: "按修改时间" + (sortKey.value === "modified" ? " ✓" : "") },
  { key: "toggle", label: sortAsc.value ? "改为倒序" : "改为正序", divided: true },
]);
function onSortMenu(key: string) {
  sortMenuOpen.value = false;
  if (key === "toggle") sortAsc.value = !sortAsc.value;
  else sortKey.value = key as SortKey;
}

// ---------------------------------------------------------------------------
// 面包屑
// ---------------------------------------------------------------------------
const crumbs = computed(() => {
  const out = [{ name: props.mount?.name || "根目录", path: "/" }];
  let acc = "";
  for (const seg of props.path.split("/").filter(Boolean)) {
    acc += "/" + seg;
    out.push({ name: seg, path: acc });
  }
  return out;
});

function go(path: string) {
  if (path === props.path) return void load();
  emit("navigate", path);
}

// ---------------------------------------------------------------------------
// 多选
// ---------------------------------------------------------------------------
const selected = ref<Set<string>>(new Set());
const picking = computed(() => selected.value.size > 0);
const selectedItems = computed(() => sorted.value.filter((i) => selected.value.has(i.path)));

function toggle(item: FileItem) {
  const next = new Set(selected.value);
  next.has(item.path) ? next.delete(item.path) : next.add(item.path);
  selected.value = next;
}
function selectAll() {
  selected.value =
    selected.value.size === sorted.value.length ? new Set() : new Set(sorted.value.map((i) => i.path));
}
function clearSelection() {
  selected.value = new Set();
}

// ---------------------------------------------------------------------------
// 打开 / 下载 / 预览
// ---------------------------------------------------------------------------
function openItem(item: FileItem) {
  if (item.is_dir) return go(item.path);
  if (isPreviewable(kindOf(item))) return emit("preview", { item, list: previewables.value });
  void download(item);
}

/** 用带签名的一次性链接触发下载：window.open 带不了 Authorization 头。 */
async function download(item: FileItem) {
  if (!props.mount) return;
  try {
    const { download: url } = await api.signUrls(props.mount.id, item.path);
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    a.download = item.name; // 同源，浏览器会直接落盘而不是跳走
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    toast.fromError(e, "无法获取下载链接", () => void download(item));
  }
}

async function copyDirect(item: FileItem) {
  if (!props.mount) return;
  try {
    const { download: url } = await api.signUrls(props.mount.id, item.path);
    await copyText(location.origin + url);
    toast.success("直链已复制", "链接为临时凭据，约 6 小时后失效");
  } catch (e) {
    toast.fromError(e, "复制直链失败");
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http:// 或旧浏览器下 clipboard API 不可用，退回选中复制
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------------------------------------------------------------------------
// 写操作。每一个都：等待结果 → 成功提示 → 刷新；失败弹错误并保留现场。
// 旧实现是「发出请求就当成功、立刻 loadFiles()」，失败时界面毫无反应。
// ---------------------------------------------------------------------------
const busy = ref(false);

async function newFolder() {
  if (!props.mount) return;
  const r = await dialog.prompt({
    title: "新建文件夹",
    fields: [{ key: "name", label: "文件夹名称", required: true, placeholder: "例如：照片备份" }],
    confirmText: "创建",
  });
  const name = r?.name?.trim();
  if (!name) return;
  if (/[\/\\]/.test(name)) return toast.error("名称不能包含斜杠");
  busy.value = true;
  try {
    await api.mkdir(props.mount.id, joinPath(props.path, name));
    toast.success("已创建", name);
    await load({ silent: true });
  } catch (e) {
    toast.fromError(e, "创建文件夹失败");
  } finally {
    busy.value = false;
  }
}

async function rename(item: FileItem) {
  if (!props.mount) return;
  const r = await dialog.prompt({
    title: "重命名",
    fields: [{ key: "name", label: "新名称", value: item.name, required: true }],
    confirmText: "保存",
  });
  const name = r?.name?.trim();
  if (!name || name === item.name) return;
  if (/[\/\\]/.test(name)) return toast.error("名称不能包含斜杠");
  busy.value = true;
  try {
    await api.rename(props.mount.id, item.path, joinPath(parentOf(item.path), name));
    toast.success("已重命名", `${item.name} → ${name}`);
    await load({ silent: true });
  } catch (e) {
    toast.fromError(e, "重命名失败");
  } finally {
    busy.value = false;
  }
}

async function move(item: FileItem) {
  if (!props.mount) return;
  const r = await dialog.prompt({
    title: "移动到",
    message: "填写目标目录的绝对路径（相对该挂载的根）。",
    fields: [
      { key: "dir", label: "目标目录", value: parentOf(item.path), required: true, placeholder: "/备份/2024" },
    ],
    confirmText: "移动",
  });
  const dir = r?.dir?.trim();
  if (!dir) return;
  const target = joinPath(dir.startsWith("/") ? dir : "/" + dir, item.name);
  if (target === item.path) return;
  busy.value = true;
  try {
    await api.move(props.mount.id, item.path, target);
    toast.success("已移动", target);
    await load({ silent: true });
  } catch (e) {
    toast.fromError(e, "移动失败");
  } finally {
    busy.value = false;
  }
}

async function remove(item: FileItem) {
  if (!props.mount) return;
  const ok = await dialog.confirm({
    title: `删除${item.is_dir ? "文件夹" : "文件"}`,
    message: `「${item.name}」将从「${props.mount.name}」中删除，该操作通常不可撤销。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  try {
    await api.remove(props.mount.id, item.path);
    toast.success("已删除", item.name);
    await load({ silent: true });
  } catch (e) {
    toast.fromError(e, "删除失败");
  } finally {
    busy.value = false;
  }
}

async function removeSelected() {
  if (!props.mount) return;
  const list = selectedItems.value;
  if (!list.length) return;
  const ok = await dialog.confirm({
    title: `删除 ${list.length} 个项目`,
    message: list
      .slice(0, 6)
      .map((i) => i.name)
      .join("、") + (list.length > 6 ? ` 等 ${list.length} 项` : ""),
    confirmText: "全部删除",
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  const failed: string[] = [];
  // 串行：并发删除很容易踩到网盘侧限流，届时一半成功一半失败更难收拾
  for (const it of list) {
    try {
      await api.remove(props.mount.id, it.path);
    } catch {
      failed.push(it.name);
    }
  }
  busy.value = false;
  if (failed.length) toast.error(`${failed.length} 项删除失败`, failed.slice(0, 4).join("、"));
  else toast.success(`已删除 ${list.length} 项`);
  clearSelection();
  await load({ silent: true });
}

async function share(item: FileItem) {
  if (!props.mount) return;
  const r = await dialog.prompt({
    title: "创建分享链接",
    message: "留空表示不设密码 / 永久有效。",
    fields: [
      { key: "password", label: "访问密码", placeholder: "选填" },
      { key: "hours", label: "有效期（小时）", type: "number", placeholder: "选填，例如 24" },
    ],
    confirmText: "生成链接",
  });
  if (!r) return;
  const pwd = r.password?.trim() || undefined;
  const hours = r.hours ? Number(r.hours) : undefined;
  if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0)) return toast.error("有效期必须是正数");
  busy.value = true;
  try {
    const res = await api.share(props.mount.id, item.path, pwd, hours);
    const link = location.origin + res.url;
    await copyText(link);
    toast.success("分享链接已复制", pwd ? `${link}（密码 ${pwd}）` : link);
  } catch (e) {
    toast.fromError(e, "创建分享失败");
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------------------
// 单项操作菜单
// ---------------------------------------------------------------------------
const ICON = {
  open: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  down: "M12 5v14m0 0 6-6m-6 6-6-6M4 21h16",
  link: "M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1L11.3 4.6M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7",
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z",
  move: "M5 9V5h4M5 5l6 6m8 4v4h-4m4 0-6-6",
  share: "M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4m4-4v13",
  trash: "M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6h14ZM10 11v6M14 11v6",
};

const menuAnchor = ref<HTMLElement | null>(null);
const menuItem = ref<FileItem | null>(null);
const entryMenu = computed<MenuItem[]>(() => {
  const it = menuItem.value;
  if (!it) return [];
  const out: MenuItem[] = [];
  if (it.is_dir) {
    out.push({ key: "open", label: "打开", icon: ICON.open });
  } else {
    if (isPreviewable(kindOf(it))) out.push({ key: "preview", label: "预览", icon: ICON.eye });
    out.push({ key: "download", label: "下载", icon: ICON.down });
    out.push({ key: "copy", label: "复制直链", icon: ICON.link });
  }
  out.push({ key: "share", label: "创建分享", icon: ICON.share, divided: true });
  out.push({ key: "rename", label: "重命名", icon: ICON.pen });
  out.push({ key: "move", label: "移动", icon: ICON.move });
  out.push({ key: "remove", label: "删除", icon: ICON.trash, danger: true, divided: true });
  return out;
});

function openEntryMenu(payload: { item: FileItem; anchor: HTMLElement }) {
  menuItem.value = payload.item;
  menuAnchor.value = payload.anchor;
}
function closeEntryMenu() {
  menuItem.value = null;
  menuAnchor.value = null;
}
function onEntryMenu(key: string) {
  const it = menuItem.value;
  closeEntryMenu();
  if (!it) return;
  if (key === "open") go(it.path);
  else if (key === "preview") emit("preview", { item: it, list: previewables.value });
  else if (key === "download") void download(it);
  else if (key === "copy") void copyDirect(it);
  else if (key === "share") void share(it);
  else if (key === "rename") void rename(it);
  else if (key === "move") void move(it);
  else if (key === "remove") void remove(it);
}

// ---------------------------------------------------------------------------
// 上传（按钮 + 拖拽）
// ---------------------------------------------------------------------------
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
let dragDepth = 0;

function pickFiles() {
  fileInput.value?.click();
}
function onPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.length && props.mount) uploads.enqueue(input.files, props.mount.id, props.path);
  input.value = "";
}
function onDragEnter(e: DragEvent) {
  if (!props.mount || !e.dataTransfer?.types?.includes("Files")) return;
  dragDepth++;
  dragging.value = true;
}
function onDragLeave() {
  // dragenter/leave 会在子元素间反复触发，用计数抵消，否则遮罩疯狂闪烁
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dragging.value = false;
  }
}
function onDrop(e: DragEvent) {
  dragDepth = 0;
  dragging.value = false;
  const files = e.dataTransfer?.files;
  if (files?.length && props.mount) uploads.enqueue(files, props.mount.id, props.path);
}
</script>

<template>
  <section
    class="browser"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- ── 工具栏 ── -->
    <div class="toolbar">
      <nav class="crumbs" aria-label="路径">
        <button
          v-if="path !== '/'"
          class="btn btn-icon btn-ghost up"
          aria-label="返回上一级"
          @click="go(parentOf(path))"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i" class="sep" aria-hidden="true">/</span>
          <button class="crumb" :class="{ cur: i === crumbs.length - 1 }" @click="go(c.path)">{{ c.name }}</button>
        </template>
      </nav>

      <div class="tools">
        <button class="btn btn-ghost btn-icon" title="刷新" aria-label="刷新" :disabled="loading" @click="load()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />
          </svg>
        </button>
        <button
          ref="sortBtn"
          class="btn btn-ghost sort"
          :title="`排序：${SORT_LABEL[sortKey]}`"
          @click="sortMenuOpen = !sortMenuOpen"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="sortAsc" d="M3 6h11M3 12h7M3 18h4m10-13v14m0 0 4-4m-4 4-4-4" />
            <path v-else d="M3 6h4M3 12h7M3 18h11m3-13v14m0 0 4-4m-4 4-4-4" />
          </svg>
          <span class="sort-txt">{{ SORT_LABEL[sortKey] }}</span>
        </button>
        <PopMenu v-if="sortMenuOpen" :anchor="sortBtn" :items="sortMenu" @select="onSortMenu" @close="sortMenuOpen = false" />

        <button
          class="btn btn-ghost btn-icon"
          :title="view === 'grid' ? '切换为列表' : '切换为网格'"
          :aria-label="view === 'grid' ? '切换为列表视图' : '切换为网格视图'"
          @click="view = view === 'grid' ? 'list' : 'grid'"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="view === 'grid'" d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
            <path v-else d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
          </svg>
        </button>

        <span class="divider" aria-hidden="true" />

        <button class="btn btn-ghost" :disabled="!mount || busy" @click="newFolder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm9 4v6m-3-3h6" />
          </svg>
          <span class="lbl">新建文件夹</span>
        </button>
        <button class="btn btn-primary" :disabled="!mount" @click="pickFiles">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 19V5m0 0-6 6m6-6 6 6" />
          </svg>
          <span class="lbl">上传</span>
        </button>
        <input ref="fileInput" type="file" multiple hidden @change="onPicked" />
      </div>
    </div>

    <!-- ── 多选操作条 ── -->
    <Transition name="pop">
      <div v-if="picking" class="selbar">
        <span class="cnt">已选 {{ selected.size }} 项</span>
        <button class="btn btn-sm btn-ghost" @click="selectAll">
          {{ selected.size === sorted.length ? "取消全选" : "全选" }}
        </button>
        <button class="btn btn-sm btn-danger" :disabled="busy" @click="removeSelected">删除所选</button>
        <button class="btn btn-sm btn-ghost" @click="clearSelection">退出多选</button>
      </div>
    </Transition>

    <!-- ── 内容区 ── -->
    <div class="content">
      <!-- 加载：骨架屏而不是一行「加载中…」，视觉上告诉用户「东西正在来」 -->
      <div v-if="loading" class="entries" :class="'v-' + view">
        <div v-for="i in view === 'grid' ? 12 : 8" :key="i" class="skeleton" :class="view === 'grid' ? 'sk-card' : 'sk-row'" />
      </div>

      <!-- 出错：明确原因 + 重试，而不是空白 -->
      <div v-else-if="failure" class="state">
        <svg class="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
        <h3>{{ failure.message }}</h3>
        <p v-if="failure.code === 'upstream_error'">
          这是网盘侧返回的错误，和你的登录状态无关。若持续出现，请到「管理挂载」里更新该网盘的凭据。
        </p>
        <p v-else-if="failure.code === 'timeout'">目录可能过大或网盘响应缓慢，可以稍后重试。</p>
        <div class="acts">
          <button class="btn btn-primary" @click="load()">重新加载</button>
          <button v-if="isAdmin" class="btn btn-ghost" @click="emit('manage')">检查挂载配置</button>
        </div>
      </div>

      <!-- 一个挂载都没有 -->
      <div v-else-if="!hasMounts" class="state">
        <svg class="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3H4V7Zm0 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3Z" />
        </svg>
        <h3>还没有挂载任何网盘</h3>
        <p>添加一个网盘后，它的文件就会出现在这里。</p>
        <div class="acts">
          <button v-if="isAdmin" class="btn btn-primary" @click="emit('manage')">添加网盘</button>
          <p v-else class="hint">请联系管理员添加挂载。</p>
        </div>
      </div>

      <!-- 空目录 -->
      <div v-else-if="!sorted.length" class="state">
        <svg class="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
        <h3>这个文件夹是空的</h3>
        <p>把文件拖到这里，或者点右上角上传。</p>
        <div class="acts"><button class="btn btn-primary" @click="pickFiles">上传文件</button></div>
      </div>

      <!-- 列表 -->
      <div v-else class="entries" :class="'v-' + view">
        <div v-if="view === 'list'" class="lhead" aria-hidden="true">
          <span class="lh-name">名称</span>
          <span class="lh-size">大小</span>
          <span class="lh-time">修改时间</span>
        </div>
        <FileEntry
          v-for="it in sorted"
          :key="it.path"
          :item="it"
          :view="view"
          :selected="selected.has(it.path)"
          :picking="picking"
          @open="openItem"
          @toggle="toggle"
          @menu="openEntryMenu"
        />
      </div>
    </div>

    <PopMenu v-if="menuItem" :anchor="menuAnchor" :items="entryMenu" @select="onEntryMenu" @close="closeEntryMenu" />

    <!-- 拖拽上传提示 -->
    <Transition name="fade">
      <div v-if="dragging" class="dropzone">
        <div class="dz-inner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 16V4m0 0-5 5m5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
          <p>松手上传到 <b>{{ crumbs[crumbs.length - 1].name }}</b></p>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.browser { position: relative; display: flex; flex-direction: column; min-height: 0; flex: 1; }

/* ---------- 工具栏 ---------- */
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.crumbs { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.crumbs::-webkit-scrollbar { display: none; }
.up { margin-right: 4px; flex-shrink: 0; }
.up svg { width: 16px; height: 16px; }
.crumb {
  flex-shrink: 0;
  max-width: 210px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-soft);
  font-family: inherit;
  font-size: 13.5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background-color 0.15s var(--ease), color 0.15s var(--ease);
}
.crumb:hover { background: var(--surface-3); color: var(--text); }
.crumb.cur { color: var(--text); font-weight: 600; }
.sep { color: var(--text-faint); font-size: 12px; flex-shrink: 0; }

.tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.tools svg { width: 16px; height: 16px; }
.sort-txt { font-size: 12.5px; }
.divider { width: 1px; height: 20px; background: var(--border); margin: 0 2px; }

/* ---------- 多选条 ---------- */
.selbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  background: var(--brand-soft);
  border-bottom: 1px solid var(--border);
}
.cnt { font-size: 13px; font-weight: 600; color: var(--brand-strong); margin-right: auto; }

/* ---------- 内容 ---------- */
.content { flex: 1; overflow-y: auto; padding: 14px 18px 28px; min-height: 0; }

.entries.v-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 12px; }
.entries.v-list { display: flex; flex-direction: column; }

.lhead {
  display: flex;
  gap: 12px;
  padding: 0 10px 8px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  text-transform: uppercase;
  border-bottom: 1px solid var(--border);
}
.lh-name { flex: 1; padding-left: 46px; }
.lh-size { width: 92px; text-align: right; }
.lh-time { width: 132px; text-align: right; }

.sk-card { height: 128px; border-radius: var(--radius-lg); }
.sk-row { height: 42px; margin-bottom: 6px; }

/* ---------- 状态页 ---------- */
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 64px 20px;
  gap: 6px;
}
.state .big { width: 54px; height: 54px; color: var(--text-faint); margin-bottom: 6px; }
.state h3 { font-size: 15.5px; }
.state p { margin: 0; max-width: 420px; font-size: 13px; color: var(--text-soft); line-height: 1.7; }
.state .acts { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.state .hint { font-size: 12.5px; color: var(--text-faint); }

/* ---------- 拖拽 ---------- */
.dropzone {
  position: absolute;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  backdrop-filter: blur(2px);
  pointer-events: none;
}
.dz-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  justify-content: center;
  border: 2px dashed var(--brand);
  border-radius: var(--radius-xl);
  color: var(--brand-strong);
  background: var(--brand-soft);
}
.dz-inner svg { width: 44px; height: 44px; }
.dz-inner p { margin: 0; font-size: 14px; }

@media (max-width: 768px) {
  .toolbar { padding: 10px 12px; gap: 8px; }
  .crumbs { order: 1; flex-basis: 100%; }
  .tools { order: 2; width: 100%; }
  .tools .btn-primary { margin-left: auto; }
  .lbl { display: none; }
  .sort-txt { display: none; }
  .content { padding: 12px 12px 32px; }
  .entries.v-grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; }
  .lhead { display: none; }
  .selbar { padding: 8px 12px; }
  .cnt { font-size: 12.5px; }
  .state { padding: 48px 16px; }
}
</style>
