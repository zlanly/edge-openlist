<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, ApiError } from "../api";
import ThemeToggle from "./ui/ThemeToggle.vue";

const emit = defineEmits<{ (e: "done"): void }>();

const loading = ref(true);
const needed = ref(false);
const secretRequired = ref(false);
const noDb = ref(false);
const loadError = ref("");

const username = ref("");
const password = ref("");
const pass2 = ref("");
const secret = ref("");
const error = ref("");
const busy = ref(false);
const done = ref(false);

async function loadStatus() {
  loading.value = true;
  loadError.value = "";
  try {
    const s = await api.setupStatus();
    needed.value = s.needed;
    secretRequired.value = s.secretRequired;
    noDb.value = s.reason === "no-d1";
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : "无法连接服务，请刷新重试";
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (busy.value) return;
  error.value = "";
  const name = username.value.trim();
  if (!name) { error.value = "请输入用户名"; return; }
  if (password.value.length < 12) { error.value = "密码至少 12 位"; return; }
  if (password.value !== pass2.value) { error.value = "两次输入的密码不一致"; return; }
  if (secretRequired.value && !secret.value) { error.value = "请输入初始化密钥"; return; }
  busy.value = true;
  try {
    await api.setupAdmin(name, password.value, secret.value);
    done.value = true;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : "初始化失败，请重试";
  } finally {
    busy.value = false;
  }
}

function goLogin() {
  // 清掉地址栏里的 /setup，避免刷新又回到初始化页
  try { history.replaceState(null, "", "/"); } catch { /* 内嵌 WebView 忽略 */ }
  emit("done");
}

onMounted(loadStatus);
</script>

<template>
  <div class="setup-page">
    <div class="corner"><ThemeToggle /></div>

    <div class="card panel">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 19a4 4 0 0 1-.9-7.9 5.5 5.5 0 0 1 10.7-1.8A4.5 4.5 0 1 1 17.5 19H6Z" />
        </svg>
      </div>
      <h1>初始化管理员</h1>
      <p class="sub">首次使用，请设置管理员账号</p>

      <!-- 状态加载中 -->
      <div v-if="loading" class="state">
        <span class="spinner" aria-hidden="true" />
        <p>正在检查系统状态…</p>
      </div>

      <!-- 加载失败 -->
      <div v-else-if="loadError" class="state">
        <p class="alert alert-error">{{ loadError }}</p>
        <button class="btn btn-primary btn-block" @click="loadStatus">重试</button>
      </div>

      <!-- 尚未绑定数据库：初始化无从谈起，给出明确的控制台操作指引 -->
      <div v-else-if="noDb" class="state">
        <p class="alert alert-warn">检测到本部署尚未绑定数据库，无法初始化管理员。</p>
        <p class="steps">请到 Cloudflare 控制台补上绑定：<br />① Storage &amp; Databases → D1 → Create 创建一个数据库<br />② 回到 Worker → Settings → Bindings → Add → D1 Database Binding<br />③ 变量名必须填 <b>DB</b>，保存后等待自动重新部署，再回来刷新本页</p>
        <button class="btn btn-primary btn-block" @click="loadStatus">我已绑定，重新检测</button>
      </div>

      <!-- 已完成初始化 -->
      <div v-else-if="!needed" class="state">
        <p>系统已存在管理员账号，无需再次初始化。</p>
        <button class="btn btn-primary btn-block" @click="goLogin">前往登录</button>
      </div>

      <!-- 初始化完成 -->
      <div v-else-if="done" class="state">
        <p class="ok">✅ 管理员账号已创建</p>
        <p>现在可以用刚设置的账号登录了。</p>
        <button class="btn btn-primary btn-block" @click="goLogin">前往登录</button>
      </div>

      <!-- 初始化表单 -->
      <form v-else class="form" @submit.prevent="submit">
        <div class="field">
          <label class="field-label" for="su-user">用户名</label>
          <input id="su-user" v-model="username" class="input" autocomplete="username" :disabled="busy" placeholder="例如 admin" maxlength="64" />
        </div>
        <div class="field">
          <label class="field-label" for="su-pass">密码</label>
          <input id="su-pass" v-model="password" class="input" type="password" autocomplete="new-password" :disabled="busy" placeholder="至少 12 位" />
        </div>
        <div class="field">
          <label class="field-label" for="su-pass2">确认密码</label>
          <input id="su-pass2" v-model="pass2" class="input" type="password" autocomplete="new-password" :disabled="busy" placeholder="再输入一次" />
        </div>
        <div v-if="secretRequired" class="field">
          <label class="field-label" for="su-secret">初始化密钥</label>
          <input id="su-secret" v-model="secret" class="input" type="password" autocomplete="off" :disabled="busy" placeholder="部署时设置的 BOOTSTRAP_SECRET" />
        </div>

        <p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>

        <button class="btn btn-primary btn-block submit" type="submit" :disabled="busy">
          <span v-if="busy" class="spinner" aria-hidden="true" />
          {{ busy ? "初始化中…" : "完成初始化" }}
        </button>
        <p v-if="!secretRequired" class="hint">尚未配置初始化密钥：任何能访问本地址的人都可以完成初始化，请在部署后尽快设置。</p>
      </form>
    </div>
  </div>
</template>

<style scoped>
.setup-page {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
}
.corner { position: fixed; top: 16px; right: 16px; }

.card {
  width: 100%;
  max-width: 380px;
  padding: 36px 32px 30px;
  text-align: center;
  box-shadow: var(--shadow-lg);
  animation: rise 0.45s var(--ease);
}
@keyframes rise { from { opacity: 0; transform: translateY(16px); } }

.logo {
  width: 54px;
  height: 54px;
  margin: 0 auto 14px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-lg);
  background: var(--brand-soft);
  color: var(--brand);
}
.logo svg { width: 28px; height: 28px; }

h1 { font-size: 21px; }
.sub { margin: 6px 0 22px; font-size: 13px; color: var(--text-soft); }

.state { display: flex; flex-direction: column; gap: 12px; align-items: center; padding: 8px 0; }
.state p { margin: 0; font-size: 14px; line-height: 1.6; }
.steps { font-size: 13px; color: var(--text-soft); text-align: left; }
.steps b { color: var(--text); }
.ok { color: var(--brand); font-weight: 600; }

.form { display: flex; flex-direction: column; gap: 14px; text-align: left; }
.submit { margin-top: 4px; padding: 11px; font-size: 14.5px; }
.hint { margin: 0; font-size: 12px; color: var(--text-soft); line-height: 1.6; }

.spinner {
  width: 14px;
  height: 14px;
  display: inline-block;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.state .spinner {
  width: 22px;
  height: 22px;
  border-color: var(--border);
  border-top-color: var(--brand);
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
