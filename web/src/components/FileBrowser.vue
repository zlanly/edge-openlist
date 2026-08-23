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
  (e: "home"): void;
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
    // 静默刷新（上传完成回调）不重签缩略图，避免图片闪烁
    if (!opts.silent) {
      void loadReadme(res);
      if (view.value === "grid") loadThumbs(res);
      else thumbGen++; // 列表视图不签缩略图，让在途批次作废
    }
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

// ---------------------------------------------------------------------------
// 网格缩略图（OpenList Images 形态）。
// 列表加载完后为图片逐个签短期链接；并发 4、目录一切换整批作废，
// 绝不把上个目录的缩略图贴到新目录上。
// ---------------------------------------------------------------------------
const thumbs = ref<Map<string, string>>(new Map());
const THUMB_CONCURRENCY = 4;
const THUMB_MAX = 80; // 单目录最多签这么多，防止超大目录把配额吃光
let thumbGen = 0;

function loadThumbs(list: FileItem[]) {
  const mount = props.mount;
  if (!mount) return;
  const gen = ++thumbGen; // 使旧批次作废
  thumbs.value = new Map();
  const imgs = list.filter((i) => !i.is_dir && kindOf(i) === "image").slice(0, THUMB_MAX);
  if (!imgs.length) return;
  let idx = 0;
  const worker = async () => {
    for (;;) {
      const cur = idx++;
      if (cur >= imgs.length || gen !== thumbGen) return;
      try {
        const urls = await api.signUrls(mount.id, imgs[cur].path);
        if (gen !== thumbGen) return;
        thumbs.value.set(imgs[cur].path, urls.preview);
      } catch {
        // 缩略图拿不到就继续用图标，不打扰用户
      }
    }
  };
  void Promise.all(Array.from({ length: THUMB_CONCURRENCY }, worker));
}

// ---------------------------------------------------------------------------
// 目录 README（OpenList 会把当前目录下的 readme 渲染在列表下方）
// ---------------------------------------------------------------------------
const readme = ref<string | null>(null);
const README_LIMIT = 256 * 1024;
let readmeGen = 0;

async function loadReadme(list: FileItem[]) {
  const mount = props.mount;
  const gen = ++readmeGen;
  readme.value = null;
  if (!mount) return;
  const f = list.find((i) => !i.is_dir && /^readme\.(md|txt)$/i.test(i.name));
  if (!f || f.size > README_LIMIT) return;
  try {
    const urls = await api.signUrls(mount.id, f.path);
    const res = await fetch(urls.preview);
    if (gen !== readmeGen || !res.ok) return;
    readme.value = await res.text();
  } catch {
    // 读不到就当没有
  }
}

// 某个文件传完 → 如果正好是当前目录，静默刷新（不闪骨架屏）
const offUploadDone = uploads.onDone((mountId, dir) => {
  if (props.mount?.id === mountId && dir === props.path) void load({ silent: true });
});
onBeforeUnmount(offUploadDone);

// ---------------------------------------------------------------------------
// 视图 / 排序（持久化，用户不用每次重设）
// 排序按目录分别记忆（OpenList 行为）：每个目录第一次进入时用全局默认，
// 一旦手动改过就记住这个目录自己的偏好。
// ---------------------------------------------------------------------------
type SortKey = "name" | "size" | "modified";
const view = ref<"grid" | "list">(readLS("eol_view") === "grid" ? "grid" : "list");
const sortKey = ref<SortKey>("name");
const sortAsc = ref(true);

const dirSortKey = () => `eol_dir_sort_${props.mount?.id}:${props.path}`;
function applySortPref() {
  try {
    const per = readLS(dirSortKey());
    if (per) {
      const v = JSON.parse(per) as { k?: string; a?: number };
      if (v && (v.k === "name" || v.k === "size" || v.k === "modified")) {
        sortKey.value = v.k;
        sortAsc.value = v.a !== 0;
        return;
      }
    }
  } catch {
    // 存坏了就当没有，回退全局默认
  }
  sortKey.value = (readLS("eol_sort_key") as SortKey) || "name";
  sortAsc.value = readLS("eol_sort_asc") !== "0";
}
applySortPref();

watch(view, (v) => writeLS("eol_view", v));
// 从列表切到网格时补签缩略图（之前是列表视图没有签过）
watch(view, (v) => {
  if (v === "grid" && items.value.length && thumbs.value.size === 0) loadThumbs(items.value);
});
watch(
  () => [props.mount?.id, props.path] as const,
  () => applySortPref()
);
watch([sortKey, sortAsc], () => {
  writeLS("eol_sort_key", sortKey.value);
  writeLS("eol_sort_asc", sortAsc.value ? "1" : "0");
  try {
    writeLS(dirSortKey(), JSON.stringify({ k: sortKey.value, a: sortAsc.value ? 1 : 0 }));
  } catch {}
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

// OpenList 的表头即排序控件：点列头切换排序键，再点一次反转方向
function sortBy(key: SortKey) {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value;
  else {
    sortKey.value = key;
    sortAsc.value = true;
  }
}

// ---------------------------------------------------------------------------
// 分页（OpenList 形态：底部分页器，默认每页 100 条）
// ---------------------------------------------------------------------------
const PAGE_SIZE = 100;
const page = ref(1);
watch(
  () => [props.mount?.id, props.path, items.value.length] as const,
  () => (page.value = 1)
);
const pageCount = computed(() => Math.max(1, Math.ceil(sorted.value.length / PAGE_SIZE)));
const paged = computed(() => sorted.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));
watch(pageCount, (n) => {
  if (page.value > n) page.value = n;
});
function gotoPage(p: number) {
  if (p < 1 || p > pageCount.value || p === page.value) return;
  page.value = p;
}
// 页码按钮：当前页附近全列，远处折叠成省略号（页数多时不会挤爆一行）
const pagerItems = computed<(number | "…")[]>(() => {
  const n = pageCount.value;
  const cur = page.value;
  if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const lo = Math.max(2, cur - 1);
  const hi = Math.min(n - 1, cur + 1);
  if (lo > 2) out.push("…");
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < n - 1) out.push("…");
  out.push(n);
  return out;
});

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
    <div class="container">
      <!-- ── 面包屑（OpenList Nav：首页图标 + 路径层级） ── -->
      <nav class="nav" aria-label="路径">
        <button class="crumb home" title="回到存储列表" aria-label="回到存储列表" @click="emit('home')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V10Z" />
          </svg>
        </button>
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span class="sep" aria-hidden="true">/</span>
          <button class="crumb" :class="{ cur: i === crumbs.length - 1 }" @click="go(c.path)">{{ c.name }}</button>
        </template>
      </nav>

      <!-- ── 工具条（OpenList Toolbar） ── -->
      <div class="toolbar">
        <div class="tools">
          <button class="btn btn-primary" :disabled="!mount" @click="pickFiles">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 19V5m0 0-6 6m6-6 6 6" />
            </svg>
            <span class="lbl">上传</span>
          </button>
          <button class="btn" :disabled="!mount || busy" @click="newFolder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm9 4v6m-3-3h6" />
            </svg>
            <span class="lbl">新建文件夹</span>
          </button>
          <input ref="fileInput" type="file" multiple hidden @change="onPicked" />

          <span class="divider" aria-hidden="true" />

          <button
            class="btn btn-icon"
            :title="view === 'grid' ? '切换为列表' : '切换为网格'"
            :aria-label="view === 'grid' ? '切换为列表视图' : '切换为网格视图'"
            @click="view = view === 'grid' ? 'list' : 'grid'"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path v-if="view === 'grid'" d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
              <path v-else d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
            </svg>
          </button>
          <button class="btn btn-icon" title="刷新" aria-label="刷新" :disabled="loading" @click="load()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />
            </svg>
          </button>
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

      <!-- ── 内容卡片（OpenList obj-box） ── -->
      <div class="obj-box panel">
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
          <p>把文件拖到这里，或者点上方上传。</p>
          <div class="acts"><button class="btn btn-primary" @click="pickFiles">上传文件</button></div>
        </div>

        <!-- 列表 -->
        <div v-else class="entries" :class="'v-' + view">
          <div v-if="view === 'list'" class="lhead">
            <button class="lh lh-name" :class="{ on: sortKey === 'name' }" @click="sortBy('name')">
              {{ SORT_LABEL.name }}<i class="arr" :class="{ desc: sortKey === 'name' && !sortAsc }" aria-hidden="true" />
            </button>
            <button class="lh lh-size" :class="{ on: sortKey === 'size' }" @click="sortBy('size')">
              {{ SORT_LABEL.size }}<i class="arr" :class="{ desc: sortKey === 'size' && !sortAsc }" aria-hidden="true" />
            </button>
            <button class="lh lh-time" :class="{ on: sortKey === 'modified' }" @click="sortBy('modified')">
              {{ SORT_LABEL.modified }}<i class="arr" :class="{ desc: sortKey === 'modified' && !sortAsc }" aria-hidden="true" />
            </button>
          </div>
          <FileEntry
            v-for="it in paged"
            :key="it.path"
            :item="it"
            :view="view"
            :selected="selected.has(it.path)"
            :picking="picking"
            :thumb="view === 'grid' ? thumbs.get(it.path) || '' : ''"
            @open="openItem"
            @toggle="toggle"
            @menu="openEntryMenu"
          />
        </div>

        <!-- 分页器（OpenList Pager） -->
        <div v-if="!loading && !failure && sorted.length > PAGE_SIZE" class="pager" role="navigation" aria-label="分页">
          <button class="btn btn-sm" :disabled="page <= 1" aria-label="上一页" @click="gotoPage(page - 1)">‹</button>
          <template v-for="p in pagerItems" :key="p">
            <span v-if="p === '…'" class="ellip">…</span>
            <button v-else class="btn btn-sm pg" :class="{ on: p === page }" :aria-current="p === page ? 'page' : undefined" @click="gotoPage(p as number)">
              {{ p }}
            </button>
          </template>
          <button class="btn btn-sm" :disabled="page >= pageCount" aria-label="下一页" @click="gotoPage(page + 1)">›</button>
        </div>
      </div>

      <!-- 目录 README（OpenList 同款：当前目录的 readme 渲染在列表下方） -->
      <div v-if="readme" class="readme panel">
        <div class="rm-head">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z" />
          </svg>
          README
        </div>
        <div class="rm-body">{{ readme }}</div>
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

/* OpenList 的居中容器 */
.container { width: 100%; max-width: 1100px; margin: 0 auto; padding: 10px 16px 40px; display: flex; flex-direction: column; min-height: 0; }

/* ---------- 面包屑（Nav） ---------- */
.nav { display: flex; align-items: center; gap: 2px; padding: 6px 2px 10px; min-width: 0; overflow-x: auto; scrollbar-width: none; flex-shrink: 0; }
.nav::-webkit-scrollbar { display: none; }
.crumb {
  flex-shrink: 0;
  max-width: 220px;
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
  transition: background-color 0.15s var(--ease), color 0.15s var(--ease), transform 0.1s var(--ease);
}
.crumb:hover { background: var(--surface-3); color: var(--text); }
.crumb:active { transform: scale(0.95); }
.crumb.cur { color: var(--text); font-weight: 600; }
.crumb.home { display: grid; place-items: center; color: var(--brand); }
.crumb.home svg { width: 16px; height: 16px; }
.sep { color: var(--text-faint); font-size: 12px; flex-shrink: 0; }

/* ---------- 工具条（Toolbar） ---------- */
.toolbar { display: flex; align-items: center; padding: 0 2px 10px; flex-shrink: 0; }
.tools { display: flex; align-items: center; gap: 6px; }
.tools svg { width: 16px; height: 16px; }
.divider { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }

/* ---------- 多选条 ---------- */
.selbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  margin-bottom: 8px;
  background: var(--brand-soft);
  border-radius: var(--radius);
  flex-shrink: 0;
}
.cnt { font-size: 13px; font-weight: 600; color: var(--brand-strong); margin-right: auto; }

/* ---------- 内容卡片（obj-box） ---------- */
.obj-box {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
}

.entries.v-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 12px; padding: 4px; }
.entries.v-list { display: flex; flex-direction: column; }

/* 可点排序的表头（OpenList ListTitle） */
.lhead { display: flex; gap: 12px; padding: 4px 10px 8px; }
.lh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  padding: 2px 0;
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--text-soft);
  cursor: pointer;
  transition: color 0.15s var(--ease);
}
.lh:hover { color: var(--text); }
.lh.on { color: var(--brand); }
.arr {
  width: 0;
  height: 0;
  opacity: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid currentColor;
  transition: transform 0.15s var(--ease), opacity 0.15s var(--ease);
}
.lh.on .arr { opacity: 1; }
.arr.desc { transform: rotate(180deg); }
.lh-name { flex: 1; padding-left: 46px; text-align: left; }
.lh-size { width: 92px; justify-content: flex-end; }
.lh-time { width: 132px; justify-content: flex-end; }

.sk-card { height: 128px; border-radius: var(--radius-lg); }
.sk-row { height: 42px; margin-bottom: 6px; }

/* ---------- 分页器（Pager） ---------- */
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 14px 8px 8px;
  margin-top: auto;
}
.pg { min-width: 30px; font-variant-numeric: tabular-nums; }
.pg.on { background: var(--brand); color: #fff; }
.ellip { color: var(--text-faint); padding: 0 4px; font-size: 12px; }

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

/* ---------- 目录 README ---------- */
.readme { margin-top: 14px; padding: 16px 18px; border-radius: var(--radius-xl); }
.rm-head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 650;
  color: var(--text-soft);
  margin-bottom: 10px;
}
.rm-head svg { width: 15px; height: 15px; color: var(--brand); }
.rm-body {
  font-size: 13px;
  line-height: 1.75;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 420px;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .container { padding: 6px 10px 32px; }
  .toolbar { overflow-x: auto; }
  .lbl { display: none; }
  .entries.v-grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; }
  .lhead { display: none; }
  .selbar { padding: 8px 12px; }
  .cnt { font-size: 12.5px; }
  .state { padding: 48px 16px; }
}
</style>
