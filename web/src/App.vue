<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { api, getToken, clearToken, uploadFile, type FileItem } from "./api";

const token = ref(getToken());
const user = ref<{ username: string; role: string } | null>(null);
const loginU = ref("");
const loginP = ref("");
const error = ref("");
const needSetup = ref(false);

// 修改密码
const showPwd = ref(false);
const oldP = ref("");
const newP = ref("");
const pwdMsg = ref("");
const pwdErr = ref("");
async function doChangePwd() {
  pwdMsg.value = "";
  pwdErr.value = "";
  try {
    await api.changePassword(oldP.value, newP.value);
    pwdMsg.value = "密码已修改，请牢记新密码";
    oldP.value = "";
    newP.value = "";
  } catch (e: any) {
    pwdErr.value = e.message;
  }
}

const mounts = ref<any[]>([]);
const curMount = ref<number | null>(null);
const curPath = ref("/");
const items = ref<FileItem[]>([]);
const loading = ref(false);
const searchKw = ref("");
const searchResults = ref<any[]>([]);

const breadcrumbs = computed(() => {
  if (curPath.value === "/") return [{ name: "根目录", path: "/" }];
  const segs = curPath.value.split("/").filter(Boolean);
  const out: { name: string; path: string }[] = [{ name: "根目录", path: "/" }];
  let acc = "";
  for (const s of segs) {
    acc += "/" + s;
    out.push({ name: s, path: acc });
  }
  return out;
});

async function doLogin() {
  try {
    const data = await api.login(loginU.value, loginP.value);
    token.value = data.token;
    user.value = data.user;
    await loadMounts();
  } catch (e: any) {
    error.value = e.message;
  }
}
function logout() {
  clearToken();
  token.value = null;
  user.value = null;
  curMount.value = null;
  mounts.value = [];
}

async function loadMounts() {
  // 防御：接口异常/返回非数组时不要抛错把用户踢回登录页
  const items = await api.listMounts();
  mounts.value = Array.isArray(items) ? items : [];
  if (mounts.value.length && curMount.value === null) {
    await openMount(mounts.value[0].id);
  }
}
async function openMount(id: number) {
  curMount.value = id;
  curPath.value = "/";
  await loadFiles();
}
async function loadFiles() {
  if (curMount.value === null) return;
  loading.value = true;
  try {
    items.value = await api.listFiles(curMount.value, curPath.value);
  } finally {
    loading.value = false;
  }
}
function enterDir(it: FileItem) {
  if (!it.is_dir) return openFile(it);
  curPath.value = it.path;
  loadFiles();
}
function goCrumb(p: string) {
  curPath.value = p;
  loadFiles();
}
async function newFolder() {
  const name = prompt("新建文件夹名称：");
  if (!name || curMount.value === null) return;
  await api.mkdir(curMount.value, curPath.value === "/" ? "/" + name : curPath.value + "/" + name);
  await loadFiles();
}
const fileInput = ref<HTMLInputElement | null>(null);
function pickFile() {
  fileInput.value?.click();
}
async function onFilePicked(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files || !files.length || curMount.value === null) return;
  for (const f of Array.from(files)) {
    const targetPath = curPath.value === "/" ? "/" + f.name : curPath.value + "/" + f.name;
    const init = await api.uploadInit(curMount.value, targetPath, f.size);
    await uploadFile(init, f);
  }
  (e.target as HTMLInputElement).value = "";
  await loadFiles();
}
async function removeItem(it: FileItem) {
  if (!confirm(`确定删除「${it.name}」？`)) return;
  if (curMount.value === null) return;
  await api.remove(curMount.value, it.path);
  await loadFiles();
}
async function renameItem(it: FileItem) {
  const name = prompt("重命名为：", it.name);
  if (!name || curMount.value === null) return;
  const parent = it.path.includes("/") ? it.path.slice(0, it.path.lastIndexOf("/")) : "";
  const to = (parent || "") + "/" + name;
  await api.rename(curMount.value, it.path, to);
  await loadFiles();
}
async function shareItem(it: FileItem) {
  if (curMount.value === null) return;
  const pwd = prompt("分享密码（留空表示无密码）：", "");
  const hours = prompt("有效期（小时，留空表示永久）：", "");
  const res = await api.share(curMount.value, it.path, pwd || undefined, hours ? Number(hours) : undefined);
  const link = location.origin + res.url;
  alert("分享链接：\n" + link + (pwd ? "\n密码：" + pwd : ""));
}
function openFile(it: FileItem) {
  if (curMount.value === null) return;
  const ext = it.name.split(".").pop()?.toLowerCase() || "";
  const previewable = ["mp4", "webm", "mp3", "ogg", "jpg", "jpeg", "png", "gif", "webp", "pdf", "txt", "md"].includes(ext);
  if (previewable) {
    window.open(api.previewUrl(curMount.value, it.path), "_blank");
  } else {
    window.open(api.downloadUrl(curMount.value, it.path), "_blank");
  }
}
async function doSearch() {
  const kw = searchKw.value.trim();
  if (!kw) {
    searchResults.value = [];
    return;
  }
  searchResults.value = await api.search(kw);
}
function fmtSize(n: number) {
  if (!n) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(1) + " " + u[i];
}
function icon(it: FileItem) {
  if (it.is_dir) return "📁";
  const ext = it.name.split(".").pop()?.toLowerCase();
  if (["mp4", "webm", "mkv"].includes(ext!)) return "🎬";
  if (["mp3", "flac", "wav"].includes(ext!)) return "🎵";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext!)) return "🖼️";
  if (["pdf", "doc", "docx", "txt", "md"].includes(ext!)) return "📄";
  if (["zip", "rar", "7z", "tar"].includes(ext!)) return "🗜️";
  return "📦";
}

// ---------- 挂载管理（动态配置表单） ----------
const showManage = ref(false);
const schemas = ref<any[]>([]);
const oauthList = ref<string[]>([]);
const editingId = ref<number | null>(null);
const formErr = ref("");
const form = ref<{ name: string; driver: string; root: string; config: Record<string, any>; enabled: number }>({
  name: "", driver: "", root: "/", config: {}, enabled: 1,
});
// 当前选中驱动的配置字段（供动态表单渲染）
const currentFields = computed(() => {
  const s = schemas.value.find((x) => x.id === form.value.driver);
  return s ? s.fields : [];
});
function onDriverChange(e: Event) {
  selectDriver((e.target as HTMLSelectElement).value);
}

async function openManage() {
  formErr.value = "";
  const [d, o] = await Promise.all([api.getDrivers(), api.oauthProviders()]);
  schemas.value = d.schemas;
  oauthList.value = o;
  showManage.value = true;
  if (editingId.value === null && schemas.value.length) selectDriver(schemas.value[0].id);
}
async function openAddMount() {
  editingId.value = null;
  await openManage();
}

function selectDriver(id: string) {
  const s = schemas.value.find((x) => x.id === id);
  const cfg: Record<string, any> = {};
  if (s) for (const f of s.fields) {
    if (f.default !== undefined) cfg[f.key] = f.default;
    else if (f.type === "bool") cfg[f.key] = false;
    else cfg[f.key] = "";
  }
  form.value = { name: form.value.name, driver: id, root: "/", config: cfg, enabled: 1 };
}
function startEdit(m: any) {
  const cfg = JSON.parse(m.config_json || "{}");
  form.value = { name: m.name, driver: m.driver, root: m.root || "/", config: cfg, enabled: m.enabled ?? 1 };
  editingId.value = m.id;
}
async function startOAuth() {
  formErr.value = "";
  try {
    if (editingId.value === null) {
      const r = await api.createMount({ name: form.value.name || form.value.driver, driver: form.value.driver, config: form.value.config, root: form.value.root });
      editingId.value = r.id;
      await loadMounts();
    }
    const url = await api.oauthStartUrl(form.value.driver, editingId.value);
    window.open(url, "_blank");
  } catch (e: any) { formErr.value = e.message; }
}
async function saveMount() {
  formErr.value = "";
  try {
    if (editingId.value === null) {
      await api.createMount({ name: form.value.name, driver: form.value.driver, config: form.value.config, root: form.value.root });
    } else {
      await api.updateMount(editingId.value, { name: form.value.name, driver: form.value.driver, config: form.value.config, root: form.value.root, enabled: form.value.enabled });
    }
    await loadMounts();
    showManage.value = false;
    editingId.value = null;
  } catch (e: any) { formErr.value = e.message; }
}
async function delMount(m: any) {
  if (!confirm(`确定删除挂载「${m.name}」？`)) return;
  await api.deleteMount(m.id);
  await loadMounts();
}

onMounted(async () => {
  if (token.value) {
    // 刷新后 token 仍在，但 user 未恢复 —— 调 /me 重建（含 role），否则管理员按钮会消失
    const me = await api.me();
    if (!me) { logout(); return; }
    user.value = me;
    try {
      await loadMounts();
    } catch {
      logout();
    }
  } else {
    // 未登录时探测是否需要首次初始化，登录页给出一键初始化入口
    needSetup.value = await api.needsSetup();
  }
});
</script>

<template>
  <div v-if="!token" class="login-wrap card">
    <h1>🌿 EdgeOpenList</h1>
    <p class="sub">运行于 Cloudflare Worker 的网盘聚合</p>
    <input v-model="loginU" placeholder="用户名" @keyup.enter="doLogin" />
    <input v-model="loginP" type="password" placeholder="密码" @keyup.enter="doLogin" />
    <button @click="doLogin">登录</button>
    <p v-if="error" class="err">{{ error }}</p>
    <a v-if="needSetup" class="setup-cta" href="/setup">⚙️ 首次使用？一键初始化管理员（admin/admin）</a>
  </div>

  <div v-else class="app">
    <header class="topbar card">
      <div class="brand">🌿 EdgeOpenList</div>
      <input class="search" v-model="searchKw" @input="doSearch" placeholder="搜索文件名…" />
      <div class="me">
        <span>{{ user?.username }}</span>
        <button v-if="user?.role === 'admin'" class="ghost" @click="openManage">管理挂载</button>
        <button class="ghost" @click="showPwd = true">修改密码</button>
        <button class="ghost" @click="logout">退出</button>
      </div>
    </header>

    <div class="body">
      <aside class="side card">
        <div class="side-title">挂载</div>
        <div
          v-for="m in mounts"
          :key="m.id"
          class="mount"
          :class="{ active: curMount === m.id }"
          @click="openMount(m.id)"
        >
          💾 {{ m.name }}
        </div>
      </aside>

      <main class="main card">
        <template v-if="searchResults.length">
          <div class="crumbs">搜索「{{ searchKw }}」结果（{{ searchResults.length }}）</div>
          <div class="grid">
            <div v-for="r in searchResults" :key="r.path" class="file">
              <div class="ic">{{ r.is_dir ? "📁" : "📦" }}</div>
              <div class="nm">{{ r.name }}</div>
              <div class="mt">📍 {{ r.mount_name }}</div>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="toolbar">
            <div class="crumbs">
              <span v-for="(c, i) in breadcrumbs" :key="i" @click="goCrumb(c.path)" class="crumb">{{ c.name }}</span>
            </div>
            <div class="actions">
              <button class="ghost" @click="newFolder">+ 文件夹</button>
              <button @click="pickFile">↑ 上传</button>
              <input ref="fileInput" type="file" multiple hidden @change="onFilePicked" />
            </div>
          </div>

          <div v-if="loading" class="hint">加载中…</div>
          <div v-else-if="!mounts.length" class="hint empty-cta">
            <p>还没有挂载任何网盘</p>
            <button class="primary" @click="openAddMount">＋ 添加网盘</button>
          </div>
          <div v-else-if="!items.length" class="hint">空空如也</div>
          <div v-else class="grid">
            <div v-for="it in items" :key="it.path" class="file" @click="enterDir(it)">
              <div class="ic">{{ icon(it) }}</div>
              <div class="nm" :title="it.name">{{ it.name }}</div>
              <div class="mt">{{ it.is_dir ? "文件夹" : fmtSize(it.size) }}</div>
              <div class="ops" @click.stop>
                <button class="ghost sm" @click="openFile(it)">打开</button>
                <button class="ghost sm" @click="renameItem(it)">改名</button>
                <button class="ghost sm" @click="shareItem(it)">分享</button>
                <button class="ghost sm danger" @click="removeItem(it)">删</button>
              </div>
            </div>
          </div>
        </template>
      </main>
    </div>
  </div>

  <!-- 挂载管理：动态配置表单 -->
  <div v-if="showManage" class="modal-mask" @click.self="showManage = false">
    <div class="modal card">
      <div class="modal-head">
        <h3>挂载管理</h3>
        <button class="ghost" @click="showManage = false">关闭</button>
      </div>
      <div class="modal-body">
        <div class="m-list">
          <div v-for="m in mounts" :key="m.id" class="m-item">
            <span class="m-name">💾 {{ m.name }} <em>({{ m.driver }})</em></span>
            <span class="ops">
              <button class="ghost sm" @click="startEdit(m)">编辑</button>
              <button class="ghost sm danger" @click="delMount(m)">删</button>
            </span>
          </div>
          <button class="add" @click="editingId = null; selectDriver(schemas[0]?.id)">+ 新建挂载</button>
        </div>
        <div class="m-form">
          <input v-model="form.name" placeholder="挂载名称" />
          <select v-model="form.driver" @change="onDriverChange">
            <option v-for="s in schemas" :key="s.id" :value="s.id">{{ s.name }} ({{ s.id }})</option>
          </select>
          <input v-model="form.root" placeholder="根路径（默认 /）" />
          <div v-if="oauthList.includes(form.driver)" class="oauth-row">
            <button class="ghost" @click="startOAuth">🔑 启动 OAuth 授权</button>
            <span class="hint-sm">授权后令牌自动保存，可关闭弹窗</span>
          </div>
          <div v-for="f in currentFields" :key="f.key" class="fld">
            <label>{{ f.label }}<i v-if="f.required">*</i></label>
            <textarea v-if="f.type === 'textarea'" v-model="form.config[f.key]" :placeholder="f.key"></textarea>
            <select v-else-if="f.type === 'select'" v-model="form.config[f.key]">
              <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <input v-else-if="f.type === 'bool'" type="checkbox" v-model="form.config[f.key]" />
            <input v-else-if="f.type === 'number'" type="number" v-model.number="form.config[f.key]" :placeholder="f.key" />
            <input v-else :type="f.type === 'password' ? 'password' : 'text'" v-model="form.config[f.key]" :placeholder="f.key" />
            <small v-if="f.help" class="fhelp">{{ f.help }}</small>
          </div>
          <p v-if="formErr" class="err">{{ formErr }}</p>
          <button class="primary" @click="saveMount">{{ editingId === null ? "创建" : "保存" }}</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 修改密码 -->
  <div v-if="showPwd" class="modal-mask" @click.self="showPwd = false">
    <div class="modal card" style="width: 380px">
      <div class="modal-head">
        <h3>修改密码</h3>
        <button class="ghost" @click="showPwd = false">关闭</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 10px">
        <input v-model="oldP" type="password" placeholder="当前密码" />
        <input v-model="newP" type="password" placeholder="新密码（至少 6 位）" />
        <p v-if="pwdErr" class="err">{{ pwdErr }}</p>
        <p v-if="pwdMsg" class="ok">{{ pwdMsg }}</p>
        <button class="primary" @click="doChangePwd">保存新密码</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-wrap { width: 320px; margin: 14vh auto; padding: 32px; display: flex; flex-direction: column; gap: 12px; }
.login-wrap h1 { margin: 0; color: var(--accent); }
.login-wrap .sub { margin: 0 0 8px; color: var(--text-soft); font-size: 13px; }
.setup-cta { margin-top: 14px; display: block; padding: 11px 14px; background: var(--accent); color: #fff; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 13px; }
.setup-cta:hover { filter: brightness(1.05); }
.err { color: #e06c5a; font-size: 13px; }
.ok { color: var(--accent); font-size: 13px; }
.app { height: 100%; display: flex; flex-direction: column; padding: 16px; gap: 14px; }
.topbar { display: flex; align-items: center; gap: 16px; padding: 12px 18px; }
.brand { font-weight: 700; color: var(--accent); }
.search { flex: 1; max-width: 420px; }
.me { margin-left: auto; display: flex; align-items: center; gap: 10px; color: var(--text-soft); }
.body { flex: 1; display: flex; gap: 14px; min-height: 0; }
.side { width: 220px; padding: 14px; overflow: auto; }
.side-title { color: var(--text-soft); font-size: 12px; margin-bottom: 8px; }
.mount { padding: 9px 12px; border-radius: 10px; cursor: pointer; margin-bottom: 4px; }
.mount:hover { background: var(--bg-soft); }
.mount.active { background: var(--accent-soft); color: #a8521f; font-weight: 600; }
.main { flex: 1; padding: 16px; overflow: auto; }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 10px; }
.crumbs { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.crumb { cursor: pointer; color: var(--accent); }
.crumb:not(:last-child)::after { content: " ›"; color: var(--text-soft); }
.actions { display: flex; gap: 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.file { background: var(--bg-soft); border-radius: 14px; padding: 14px; text-align: center; cursor: pointer; transition: transform .08s; position: relative; }
.file:hover { transform: translateY(-3px); box-shadow: var(--shadow); }
.ic { font-size: 40px; }
.nm { margin-top: 6px; font-size: 13px; word-break: break-all; max-height: 36px; overflow: hidden; }
.mt { font-size: 11px; color: var(--text-soft); margin-top: 4px; }
.ops { display: flex; gap: 4px; justify-content: center; margin-top: 8px; flex-wrap: wrap; }
.ops .sm { padding: 4px 8px; font-size: 11px; }
.danger { color: #e06c5a; }
.hint { color: var(--text-soft); padding: 40px; text-align: center; }
.empty-cta { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.empty-cta p { margin: 0; }
.modal-mask { position: fixed; inset: 0; background: rgba(40, 30, 20, 0.32); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.modal { width: 860px; max-width: 100%; max-height: 88vh; display: flex; flex-direction: column; padding: 18px; }
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.modal-head h3 { margin: 0; color: var(--accent); }
.modal-body { display: flex; gap: 16px; min-height: 0; flex: 1; }
.m-list { width: 240px; border-right: 1px solid var(--bg-soft); padding-right: 14px; overflow: auto; }
.m-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 6px; border-radius: 8px; }
.m-item:hover { background: var(--bg-soft); }
.m-name em { color: var(--text-soft); font-style: normal; font-size: 11px; }
.m-form { flex: 1; display: flex; flex-direction: column; gap: 10px; overflow: auto; padding-right: 6px; }
.m-form input, .m-form select, .m-form textarea { width: 100%; }
.m-form textarea { min-height: 64px; resize: vertical; font-family: inherit; }
.oauth-row { display: flex; align-items: center; gap: 10px; background: var(--accent-soft); padding: 8px 10px; border-radius: 8px; }
.hint-sm { color: var(--text-soft); font-size: 12px; }
.fld { display: flex; flex-direction: column; gap: 3px; }
.fld label { font-size: 12px; color: var(--text-soft); }
.fld label i { color: #e06c5a; font-style: normal; }
.fld input[type="checkbox"] { width: auto; }
.fhelp { color: var(--text-soft); font-size: 11px; }
.add { margin-top: 10px; width: 100%; border: 1px dashed var(--accent); color: var(--accent); background: transparent; border-radius: 8px; padding: 8px; cursor: pointer; }
.primary { background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 10px 16px; font-weight: 600; cursor: pointer; }
.primary:hover { filter: brightness(1.05); }
</style>
