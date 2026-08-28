<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api, type MountRow } from "../api";
import type { DriverSchema, FieldSchema } from "../types";
import { useToast } from "../composables/useToast";

const props = defineProps<{ schemas: DriverSchema[]; initial: MountRow | null }>();
const emit = defineEmits<{ (e: "saved", id: number): void; (e: "cancel"): void }>();

const toast = useToast();

const name = ref("");
const driver = ref("");
const root = ref("/");
const order = ref(0);
const enabled = ref(true);
const config = ref<Record<string, any>>({});
const touched = ref(false);
const saving = ref(false);
const mountId = ref<number | null>(null);

// 84 个驱动全塞进一个 select 根本没法找。给一个过滤框。
const filter = ref("");
const driverOptions = computed(() => {
  const kw = filter.value.trim().toLowerCase();
  const list = props.schemas.slice().sort((a, b) => a.id.localeCompare(b.id));
  if (!kw) return list;
  return list.filter((s) => s.id.toLowerCase().includes(kw) || s.name.toLowerCase().includes(kw));
});

const schema = computed<DriverSchema | undefined>(() => props.schemas.find((s) => s.id === driver.value));
const fields = computed<FieldSchema[]>(() => schema.value?.fields ?? []);
const isOAuth = computed(() => !!schema.value?.oauth);

function blankConfig(s: DriverSchema | undefined): Record<string, any> {
  const cfg: Record<string, any> = {};
  for (const f of s?.fields ?? []) {
    if (f.default !== undefined) cfg[f.key] = f.default;
    else if (f.type === "bool") cfg[f.key] = false;
    else if (f.type === "number") cfg[f.key] = 0;
    else if (f.type === "select") cfg[f.key] = f.options?.[0]?.value ?? "";
    else cfg[f.key] = "";
  }
  return cfg;
}

function reset() {
  const m = props.initial;
  touched.value = false;
  if (m) {
    mountId.value = m.id;
    name.value = m.name;
    driver.value = m.driver;
    root.value = m.root || "/";
    order.value = m.order ?? 0;
    enabled.value = !!m.enabled;
    let saved: Record<string, any> = {};
    try {
      saved = JSON.parse(m.config_json || "{}");
    } catch {
      // 配置损坏也别让整个弹窗炸掉，退回空配置并提示
      toast.warn("该挂载的配置无法解析", "已重置为默认值，保存后会覆盖旧配置");
    }
    // 用 schema 兜底：schema 新增字段时老挂载不会缺键，避免 undefined 进 v-model
    config.value = { ...blankConfig(props.schemas.find((s) => s.id === m.driver)), ...saved };
  } else {
    mountId.value = null;
    name.value = "";
    driver.value = props.schemas[0]?.id ?? "";
    root.value = "/";
    order.value = 0;
    enabled.value = true;
    config.value = blankConfig(props.schemas[0]);
  }
}
watch(() => props.initial, reset, { immediate: true });

// 切驱动 → 换一套字段。保留同名键的已填值，减少重填成本
function onDriverChange() {
  const next = blankConfig(schema.value);
  for (const k of Object.keys(next)) {
    if (config.value[k] !== undefined && config.value[k] !== "") next[k] = config.value[k];
  }
  config.value = next;
  if (!name.value.trim()) name.value = schema.value?.name || driver.value;
}

const missing = computed(() =>
  fields.value.filter((f) => f.required && !String(config.value[f.key] ?? "").trim()).map((f) => f.key)
);
const nameError = computed(() => {
  const n = name.value.trim();
  if (!n) return "挂载名不能为空";
  if (n.length > 64) return "挂载名不能超过 64 个字符";
  if (/[\/\\?#]/.test(n)) return "挂载名不能包含 / \\ ? # 等字符";
  return "";
});

async function save() {
  touched.value = true;
  if (nameError.value) return;
  if (!driver.value) return toast.error("请选择驱动类型");
  if (missing.value.length) {
    toast.error("还有必填项没有填写", `缺少：${missing.value.join("、")}`);
    return;
  }
  saving.value = true;
  try {
    const body = {
      name: name.value.trim(),
      driver: driver.value,
      config: config.value,
      root: root.value.trim() || "/",
      order: Number(order.value) || 0,
    };
    if (mountId.value === null) {
      const r = await api.createMount(body);
      toast.success("挂载已创建", body.name);
      emit("saved", r.id);
    } else {
      await api.updateMount(mountId.value, { ...body, enabled: enabled.value ? 1 : 0 });
      toast.success("已保存", body.name);
      emit("saved", mountId.value);
    }
  } catch (e) {
    toast.fromError(e, "保存失败");
  } finally {
    saving.value = false;
  }
}

// OAuth 需要一个已存在的 mount id 承载回调写回来的令牌，所以先落库再跳转
async function startOAuth() {
  if (nameError.value) {
    touched.value = true;
    return;
  }
  // 必须在点击事件同步阶段打开窗口，否则浏览器会拦截异步 window.open。
  const win = window.open("", "_blank");
  if (!win) {
    toast.warn("浏览器拦截了新窗口", "请允许弹出窗口后重试");
    return;
  }
  win.document.title = "正在准备授权…";
  saving.value = true;
  try {
    let id = mountId.value;
    if (id === null) {
      const r = await api.createMount({
        name: name.value.trim(),
        driver: driver.value,
        config: config.value,
        root: root.value.trim() || "/",
      });
      id = r.id;
      mountId.value = id;
      emit("saved", id);
      toast.info("已先创建挂载", "授权完成后回到这里保存其余配置");
    }
    const url = await api.oauthStartUrl(driver.value, id);
    win.location.href = url;
  } catch (e) {
    win.close();
    toast.fromError(e, "无法启动授权");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="mform">
    <div class="field">
      <label class="field-label" for="mf-name">挂载名称<span class="req">*</span></label>
      <input id="mf-name" v-model="name" class="input" placeholder="显示在侧栏的名字，例如：我的 TeraBox" />
      <small v-if="touched && nameError" class="err">{{ nameError }}</small>
    </div>

    <div class="field">
      <label class="field-label" for="mf-driver">驱动类型<span class="req">*</span></label>
      <input v-model="filter" class="input filter" placeholder="过滤驱动（输入 tera、onedrive…）" />
      <select id="mf-driver" v-model="driver" class="select" @change="onDriverChange">
        <option v-for="s in driverOptions" :key="s.id" :value="s.id">{{ s.name }}（{{ s.id }}）</option>
      </select>
      <small class="field-help">共 {{ schemas.length }} 种驱动，当前列出 {{ driverOptions.length }} 种。</small>
    </div>

    <div class="two">
      <div class="field">
        <label class="field-label" for="mf-root">根路径</label>
        <input id="mf-root" v-model="root" class="input" placeholder="/" />
        <small class="field-help">只暴露网盘中的某个子目录时填写，默认 /。</small>
      </div>
      <div class="field">
        <label class="field-label" for="mf-order">排序</label>
        <input id="mf-order" v-model.number="order" class="input" type="number" />
        <small class="field-help">数字越小越靠前。</small>
      </div>
    </div>

    <label v-if="mountId !== null" class="toggle">
      <input v-model="enabled" type="checkbox" />
      <span>启用该挂载（停用后不会出现在文件浏览里）</span>
    </label>

    <div v-if="isOAuth" class="oauth">
      <div class="oa-txt">
        <b>该网盘支持网页授权</b>
        <span>填好 Client ID / Secret 后点击授权，令牌会自动写回，不需要手动粘贴。</span>
      </div>
      <button class="btn btn-outline" :disabled="saving" @click="startOAuth">前往授权</button>
    </div>

    <hr class="hr" />

    <p v-if="!fields.length" class="none">该驱动无需额外配置。</p>

    <div v-for="f in fields" :key="f.key" class="field">
      <label class="field-label" :for="'cf-' + f.key">
        {{ f.label }}<span v-if="f.required" class="req">*</span>
      </label>

      <textarea v-if="f.type === 'textarea'" :id="'cf-' + f.key" v-model="config[f.key]" class="textarea" :placeholder="f.key" />
      <select v-else-if="f.type === 'select'" :id="'cf-' + f.key" v-model="config[f.key]" class="select">
        <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <label v-else-if="f.type === 'bool'" class="toggle">
        <input :id="'cf-' + f.key" v-model="config[f.key]" type="checkbox" />
        <span>{{ f.help || "启用" }}</span>
      </label>
      <input
        v-else-if="f.type === 'number'"
        :id="'cf-' + f.key"
        v-model.number="config[f.key]"
        class="input"
        type="number"
        :placeholder="f.key"
      />
      <input
        v-else
        :id="'cf-' + f.key"
        v-model="config[f.key]"
        class="input"
        :type="f.type === 'password' ? 'password' : 'text'"
        :placeholder="f.key"
        autocomplete="off"
        spellcheck="false"
      />

      <small v-if="f.help && f.type !== 'bool'" class="field-help">{{ f.help }}</small>
      <small v-if="touched && f.required && !String(config[f.key] ?? '').trim()" class="err">此项为必填</small>
    </div>

    <div class="foot">
      <button class="btn btn-ghost" :disabled="saving" @click="emit('cancel')">返回</button>
      <button class="btn btn-primary" :disabled="saving" @click="save">
        {{ saving ? "保存中…" : mountId === null ? "创建挂载" : "保存修改" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.mform { display: flex; flex-direction: column; gap: 15px; }
.two { display: grid; grid-template-columns: 1fr 120px; gap: 12px; }
.filter { margin-bottom: 6px; font-size: 13px; }
.err { color: var(--danger); font-size: 11.5px; }
.none { margin: 0; font-size: 12.5px; color: var(--text-faint); }
.hr { width: 100%; height: 1px; border: none; background: var(--border); margin: 2px 0; }

.toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-soft); cursor: pointer; }
.toggle input { width: 16px; height: 16px; accent-color: var(--brand); cursor: pointer; }

.oauth {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--brand-soft);
}
.oa-txt { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.oa-txt b { font-size: 13px; color: var(--brand-strong); }
.oa-txt span { font-size: 12px; color: var(--text-soft); line-height: 1.5; }

.foot { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }

@media (max-width: 768px) {
  .two { grid-template-columns: 1fr; }
  .oauth { flex-direction: column; align-items: stretch; }
}
</style>
