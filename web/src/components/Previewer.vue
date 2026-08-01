<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError, api, type FileItem, type MountRow } from "../api";
import { formatSize, kindOf } from "../utils/format";
import { lockScroll, unlockScroll } from "../utils/scroll-lock";
import { useToast } from "../composables/useToast";

// 就地预览。
// 旧实现是 window.open(previewUrl)：URL 不带任何凭据，必然 401；
// 而 401 又被前端当成「登录失效」—— 于是「点一下图片，整个人被踢回登录页」。
// 现在统一走 /api/fs/sign 拿到短期内容令牌，再把带签名的 URL 交给 <img>/<video>。

const props = defineProps<{ mount: MountRow; item: FileItem; list: FileItem[] }>();
const emit = defineEmits<{ (e: "close"): void }>();

const toast = useToast();

const index = ref(Math.max(0, props.list.findIndex((i) => i.path === props.item.path)));
const current = computed<FileItem>(() => props.list[index.value] ?? props.item);
const kind = computed(() => kindOf(current.value));

const loading = ref(true);
const failed = ref<string | null>(null);
const src = ref("");
const downloadUrl = ref("");
const text = ref("");

const TEXT_LIMIT = 512 * 1024; // 超过 512KB 的文本别往 DOM 里塞，浏览器会直接卡死

let token = 0;

async function loadCurrent() {
  const it = current.value;
  const my = ++token;
  loading.value = true;
  failed.value = null;
  src.value = "";
  text.value = "";
  downloadUrl.value = "";
  try {
    const urls = await api.signUrls(props.mount.id, it.path);
    if (my !== token) return;
    src.value = urls.preview;
    downloadUrl.value = urls.download;

    if (kind.value === "text" || kind.value === "code") {
      if (it.size > TEXT_LIMIT) {
        failed.value = `文件超过 ${formatSize(TEXT_LIMIT)}，请下载后查看`;
        return;
      }
      const res = await fetch(urls.preview);
      if (my !== token) return;
      if (!res.ok) throw new ApiError(`读取失败（${res.status}）`, res.status, "upstream_error");
      text.value = await res.text();
      if (my !== token) return;
    }
  } catch (e) {
    if (my !== token) return;
    failed.value = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "无法加载预览";
  } finally {
    if (my === token) loading.value = false;
  }
}

watch(index, loadCurrent);
watch(
  () => props.item.path,
  (p) => {
    const i = props.list.findIndex((x) => x.path === p);
    if (i >= 0 && i !== index.value) index.value = i;
    else loadCurrent();
  }
);

const hasPrev = computed(() => index.value > 0);
const hasNext = computed(() => index.value < props.list.length - 1);
function prev() {
  if (hasPrev.value) index.value--;
}
function next() {
  if (hasNext.value) index.value++;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") return emit("close");
  if (e.key === "ArrowLeft") prev();
  if (e.key === "ArrowRight") next();
}

async function doDownload() {
  try {
    const url = downloadUrl.value || (await api.signUrls(props.mount.id, current.value.path)).download;
    const a = document.createElement("a");
    a.href = url;
    a.download = current.value.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    toast.fromError(e, "下载失败");
  }
}

const wrap = ref<HTMLElement | null>(null);
onMounted(() => {
  lockScroll();
  document.addEventListener("keydown", onKey, true);
  wrap.value?.focus();
  void loadCurrent();
});
onBeforeUnmount(() => {
  token++; // 让在途请求的回调失效，避免关闭后还去写已卸载组件的状态
  unlockScroll();
  document.removeEventListener("keydown", onKey, true);
});
</script>

<template>
  <Teleport to="body">
    <div ref="wrap" class="viewer" tabindex="-1" role="dialog" aria-modal="true" :aria-label="`预览 ${current.name}`">
      <header class="bar">
        <div class="meta">
          <span class="nm" :title="current.name">{{ current.name }}</span>
          <span class="sz">{{ formatSize(current.size) }}</span>
        </div>
        <div class="acts">
          <span v-if="list.length > 1" class="idx">{{ index + 1 }} / {{ list.length }}</span>
          <button class="btn btn-icon btn-ghost" title="下载" aria-label="下载" @click="doDownload">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v10m0 0 5-5m-5 5-5-5M4 19h16" />
            </svg>
          </button>
          <button class="btn btn-icon btn-ghost" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </header>

      <div class="stage" @click.self="emit('close')">
        <button v-if="hasPrev" class="nav left" aria-label="上一个" @click.stop="prev">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>

        <div v-if="loading" class="center">
          <span class="spin" aria-hidden="true" />
          <p>正在准备预览…</p>
        </div>

        <div v-else-if="failed" class="center">
          <svg class="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          <p>{{ failed }}</p>
          <div class="cacts">
            <button class="btn btn-primary" @click="loadCurrent">重试</button>
            <button class="btn btn-outline" @click="doDownload">改为下载</button>
          </div>
        </div>

        <template v-else>
          <img v-if="kind === 'image'" :src="src" :alt="current.name" class="media img" @error="failed = '图片加载失败'" />
          <video
            v-else-if="kind === 'video'"
            :src="src"
            class="media vid"
            controls
            playsinline
            preload="metadata"
            @error="failed = '视频无法播放，可能是浏览器不支持该编码，建议下载后观看'"
          />
          <div v-else-if="kind === 'audio'" class="audio-box">
            <svg class="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm10-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
            <p class="aname">{{ current.name }}</p>
            <audio :src="src" controls autoplay @error="failed = '音频无法播放'" />
          </div>
          <iframe v-else-if="kind === 'pdf'" :src="src" class="media pdf" :title="current.name" />
          <pre v-else class="media txt">{{ text }}</pre>
        </template>

        <button v-if="hasNext" class="nav right" aria-label="下一个" @click.stop="next">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 320;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--bg) 92%, #000);
  outline: none;
  animation: v-in 0.2s var(--ease);
}
@keyframes v-in { from { opacity: 0; } }

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  padding-top: calc(10px + env(safe-area-inset-top));
}
.meta { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; }
.nm { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sz { font-size: 12px; color: var(--text-faint); flex-shrink: 0; }
.acts { display: flex; align-items: center; gap: 4px; }
.acts svg { width: 16px; height: 16px; }
.idx { font-size: 12px; color: var(--text-soft); margin-right: 6px; font-variant-numeric: tabular-nums; }

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  overflow: auto;
}

.media { max-width: 100%; max-height: 100%; }
.img { object-fit: contain; border-radius: var(--radius); box-shadow: var(--shadow-lg); }
.vid { width: min(1100px, 100%); border-radius: var(--radius); background: #000; }
.pdf { width: min(980px, 100%); height: 100%; border: none; border-radius: var(--radius); background: var(--surface); }
.txt {
  width: min(980px, 100%);
  max-height: 100%;
  margin: 0;
  padding: 18px 20px;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}

.audio-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 34px 26px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow);
  max-width: 100%;
}
.audio-box .big { width: 48px; height: 48px; color: var(--brand); }
.aname { margin: 0; font-size: 13.5px; word-break: break-all; text-align: center; }
.audio-box audio { width: min(420px, 76vw); }

.center { display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--text-soft); }
.center p { margin: 0; font-size: 13.5px; text-align: center; max-width: 380px; line-height: 1.7; }
.center .big { width: 46px; height: 46px; color: var(--text-faint); }
.cacts { display: flex; gap: 8px; margin-top: 6px; }
.spin {
  width: 26px;
  height: 26px;
  border: 2.5px solid var(--border-strong);
  border-top-color: var(--brand);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  box-shadow: var(--shadow);
  transition: background-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.nav:hover { background: var(--surface-3); }
.nav:active { transform: translateY(-50%) scale(0.94); }
.nav svg { width: 18px; height: 18px; }
.left { left: 14px; }
.right { right: 14px; }

@media (max-width: 768px) {
  .stage { padding: 10px; }
  .nav { width: 36px; height: 36px; }
  .left { left: 6px; }
  .right { right: 6px; }
  .txt { padding: 14px; font-size: 12px; }
}
</style>
