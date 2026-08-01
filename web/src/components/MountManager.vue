<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import BaseModal from "./ui/BaseModal.vue";
import MountForm from "./MountForm.vue";
import { api, type MountRow } from "../api";
import type { DriverSchema } from "../types";
import { useToast } from "../composables/useToast";
import { useDialog } from "../composables/useDialog";

const props = defineProps<{ mounts: MountRow[] }>();
const emit = defineEmits<{ (e: "close"): void; (e: "changed"): void }>();

const toast = useToast();
const dialog = useDialog();

const schemas = ref<DriverSchema[]>([]);
const loading = ref(true);
const loadError = ref("");
const page = ref<"list" | "form">("list");
const editing = ref<MountRow | null>(null);
const busyId = ref<number | null>(null);

const sorted = computed(() => [...props.mounts].sort((a, b) => a.order - b.order || a.id - b.id));

async function loadSchemas() {
  loading.value = true;
  loadError.value = "";
  try {
    const d = await api.getDrivers();
    schemas.value = (d.schemas || []) as DriverSchema[];
    // 如果一进来就没有挂载，直接把新建表单摆在面前，少点一次
    if (!props.mounts.length) create();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : "驱动列表加载失败";
  } finally {
    loading.value = false;
  }
}
onMounted(loadSchemas);

function create() {
  editing.value = null;
  page.value = "form";
}
function edit(m: MountRow) {
  editing.value = m;
  page.value = "form";
}
function onSaved() {
  emit("changed");
  page.value = "list";
  editing.value = null;
}

async function toggleEnabled(m: MountRow) {
  busyId.value = m.id;
  try {
    await api.updateMount(m.id, { enabled: m.enabled ? 0 : 1 });
    toast.success(m.enabled ? `已停用「${m.name}」` : `已启用「${m.name}」`);
    emit("changed");
  } catch (e) {
    toast.fromError(e, "操作失败");
  } finally {
    busyId.value = null;
  }
}

async function remove(m: MountRow) {
  const ok = await dialog.confirm({
    title: "删除挂载",
    message: `将移除「${m.name}」及其本地索引。网盘里的文件不会被删除，但所有指向它的分享链接都会失效。`,
    confirmText: "删除挂载",
    danger: true,
  });
  if (!ok) return;
  busyId.value = m.id;
  try {
    await api.deleteMount(m.id);
    toast.success("已删除", m.name);
    emit("changed");
  } catch (e) {
    toast.fromError(e, "删除失败");
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <BaseModal
    :title="page === 'list' ? '管理挂载' : editing ? `编辑「${editing.name}」` : '添加网盘'"
    width="680px"
    @close="page === 'form' && mounts.length ? (page = 'list') : emit('close')"
  >
    <div v-if="loadError" class="state">
      <p>{{ loadError }}</p>
      <button class="btn btn-primary" @click="loadSchemas">重试</button>
    </div>

    <!-- 列表页：挂载数据早就在手上（父组件传进来的），没道理等 80 多个驱动的
         配置 schema 拉完才肯显示。原来一进来先糊三条骨架屏，网络稍慢就是
         「点了管理挂载但什么都没有」的假死感。 -->
    <div v-else-if="page === 'list'" class="list">
      <p v-if="!sorted.length && !loading" class="empty">还没有任何挂载。</p>

      <div v-for="m in sorted" :key="m.id" class="row" :class="{ off: !m.enabled }">
        <div class="info">
          <span class="nm">
            {{ m.name }}
            <span v-if="!m.enabled" class="badge badge-muted">已停用</span>
          </span>
          <span class="sub">{{ m.driver }} · 根路径 {{ m.root || "/" }}</span>
        </div>
        <div class="ops">
          <button class="btn btn-sm btn-ghost" :disabled="busyId === m.id" @click="toggleEnabled(m)">
            {{ m.enabled ? "停用" : "启用" }}
          </button>
          <button class="btn btn-sm btn-ghost" @click="edit(m)">编辑</button>
          <button class="btn btn-sm btn-danger" :disabled="busyId === m.id" @click="remove(m)">删除</button>
        </div>
      </div>

      <button class="add" :disabled="loading" @click="create">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {{ loading ? "驱动列表加载中…" : "添加网盘" }}
      </button>
    </div>

    <!-- 表单页：这里才真的需要 schema -->
    <div v-else-if="loading" class="loading">
      <div v-for="i in 3" :key="i" class="skeleton sk" />
    </div>

    <MountForm
      v-else
      :schemas="schemas"
      :initial="editing"
      @saved="onSaved"
      @cancel="mounts.length ? (page = 'list') : emit('close')"
    />
  </BaseModal>
</template>

<style scoped>
.loading { display: flex; flex-direction: column; gap: 10px; }
.sk { height: 56px; border-radius: var(--radius); }

.state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 28px 0; }
.state p { margin: 0; color: var(--text-soft); font-size: 13.5px; }

.list { display: flex; flex-direction: column; gap: 8px; }
.empty { margin: 0 0 4px; font-size: 13px; color: var(--text-faint); }

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.row.off { opacity: 0.6; }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.nm { display: flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 600; }
.sub { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ops { display: flex; gap: 2px; flex-shrink: 0; }

.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 4px;
  padding: 11px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-soft);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.add:hover { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.add svg { width: 15px; height: 15px; }

@media (max-width: 768px) {
  .row { flex-direction: column; align-items: stretch; gap: 8px; }
  .ops { justify-content: flex-end; }
}
</style>
