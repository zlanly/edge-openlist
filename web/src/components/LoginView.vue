<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError, type UserInfo } from "../api";
import ThemeToggle from "./ui/ThemeToggle.vue";

const props = withDefaults(defineProps<{ notice?: string }>(), { notice: "" });
const emit = defineEmits<{ (e: "logged-in", user: UserInfo): void }>();

const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);
const needSetup = ref(false);
const userRef = ref<HTMLInputElement | null>(null);

async function submit() {
  if (busy.value) return;
  error.value = "";
  if (!username.value.trim() || !password.value) {
    error.value = "请输入用户名和密码";
    return;
  }
  busy.value = true;
  try {
    const data = await api.login(username.value.trim(), password.value);
    emit("logged-in", data.user);
  } catch (e) {
    // 登录失败必须停在本页并给出原因，绝不能触发「会话失效」跳转
    error.value = e instanceof ApiError ? e.message : "登录失败，请稍后重试";
    password.value = "";
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  userRef.value?.focus();
  needSetup.value = await api.needsSetup();
});
</script>

<template>
  <div class="login-page">
    <!-- OpenList 登录页同款：主色渐变的装饰圆 -->
    <div class="bg" aria-hidden="true">
      <i class="blob b1" />
      <i class="blob b2" />
      <i class="blob b3" />
    </div>
    <div class="corner"><ThemeToggle /></div>

    <div class="card panel">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 19a4 4 0 0 1-.9-7.9 5.5 5.5 0 0 1 10.7-1.8A4.5 4.5 0 1 1 17.5 19H6Z" />
        </svg>
      </div>
      <h1>EdgeOpenList</h1>
      <p class="sub">运行在 Cloudflare 边缘网络上的网盘聚合</p>

      <!-- 会话过期等原因导致的回落，明确告诉用户「为什么会在这里」 -->
      <p v-if="props.notice && !error" class="alert alert-warn notice" role="status">{{ props.notice }}</p>

      <form class="form" @submit.prevent="submit">
        <div class="field">
          <label class="field-label" for="lg-user">用户名</label>
          <input
            id="lg-user"
            ref="userRef"
            v-model="username"
            class="input"
            autocomplete="username"
            :disabled="busy"
            placeholder="请输入用户名"
          />
        </div>
        <div class="field">
          <label class="field-label" for="lg-pass">密码</label>
          <input
            id="lg-pass"
            v-model="password"
            class="input"
            type="password"
            autocomplete="current-password"
            :disabled="busy"
            placeholder="请输入密码"
          />
        </div>

        <!-- role=alert：错误出现时屏幕阅读器会立刻播报 -->
        <p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>

        <button class="btn btn-primary btn-block submit" type="submit" :disabled="busy">
          <span v-if="busy" class="spinner" aria-hidden="true" />
          {{ busy ? "登录中…" : "登录" }}
        </button>
      </form>

      <a v-if="needSetup" class="setup" href="/setup?init=1">
        首次使用？点此初始化管理员账号
      </a>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
  position: relative;
  overflow: hidden;
}
/* 装饰背景：主色系渐变圆，和 OpenList 登录页一个路数 */
.bg { position: absolute; inset: 0; pointer-events: none; }
.blob { position: absolute; border-radius: 50%; filter: blur(70px); opacity: 0.5; }
.b1 { width: 420px; height: 420px; top: -140px; left: -120px; background: radial-gradient(circle, var(--brand) 0%, transparent 70%); }
.b2 { width: 360px; height: 360px; bottom: -120px; right: -100px; background: radial-gradient(circle, var(--accent-2) 0%, transparent 70%); }
.b3 { width: 260px; height: 260px; top: 40%; left: 60%; background: radial-gradient(circle, var(--brand-strong) 0%, transparent 70%); opacity: 0.28; }
.corner { position: fixed; top: 16px; right: 16px; z-index: 2; }

.card {
  width: 100%;
  max-width: 380px;
  padding: 36px 32px 30px;
  text-align: center;
  box-shadow: var(--shadow-lg);
  animation: rise 0.45s var(--ease);
  position: relative;
  z-index: 1;
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
.sub { margin: 6px 0 26px; font-size: 13px; color: var(--text-soft); }
.notice { margin: 0 0 16px; text-align: left; }

.form { display: flex; flex-direction: column; gap: 14px; text-align: left; }
.submit { margin-top: 4px; padding: 11px; font-size: 14.5px; }

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.setup {
  display: block;
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text-soft);
}
.setup:hover { color: var(--brand); }
</style>
