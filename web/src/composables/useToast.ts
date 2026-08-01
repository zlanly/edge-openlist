import { ref } from "vue";
import { ApiError } from "../api";

// 全局轻提示。替代原来散落各处的 alert()：
// alert 会阻塞整个 JS 线程（上传/加载全部卡住），且样式无法控制、移动端体验极差。

export type ToastKind = "success" | "error" | "info" | "warn";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  desc?: string;
  /** 可选的重试回调：网络/上游错误时给用户一个立即重试的按钮。 */
  action?: { label: string; run: () => void };
  timeout: number;
}

const toasts = ref<Toast[]>([]);
let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function dismiss(id: number) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  toasts.value = toasts.value.filter((x) => x.id !== id);
}

function push(kind: ToastKind, title: string, desc?: string, opts: Partial<Toast> = {}): number {
  const id = ++seq;
  const timeout = opts.timeout ?? (kind === "error" ? 6000 : 3000);
  toasts.value = [...toasts.value, { id, kind, title, desc, action: opts.action, timeout }];
  // 最多同时显示 4 条，超出的挤掉最旧的，避免刷屏遮挡界面
  if (toasts.value.length > 4) dismiss(toasts.value[0].id);
  if (timeout > 0) timers.set(id, setTimeout(() => dismiss(id), timeout));
  return id;
}

export function useToast() {
  return {
    toasts,
    dismiss,
    success: (title: string, desc?: string) => push("success", title, desc),
    info: (title: string, desc?: string) => push("info", title, desc),
    warn: (title: string, desc?: string) => push("warn", title, desc),
    error: (title: string, desc?: string, action?: Toast["action"]) => push("error", title, desc, { action }),

    /**
     * 统一的异常呈现。把 ApiError 的 code 翻译成人话，
     * 并对可重试的故障附上「重试」按钮 —— 而不是像以前那样悄无声息地失败。
     */
    fromError(e: unknown, fallback = "操作失败", retry?: () => void) {
      if (e instanceof ApiError) {
        // 会话失效由 App 统一接管（弹登录框），这里不再重复打扰用户
        if (e.isSessionExpired) return;
        const hint = explain(e);
        push("error", e.message || fallback, hint, {
          action: retry && e.isRetryable ? { label: "重试", run: retry } : undefined,
        });
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      push("error", fallback, msg, { action: retry ? { label: "重试", run: retry } : undefined });
    },
  };
}

function explain(e: ApiError): string | undefined {
  switch (e.code) {
    case "upstream_error":
      return "这是网盘侧的问题，与你的登录状态无关。若反复出现，请到「管理挂载」更新该网盘的凭据。";
    case "rate_limited":
      return "请求过于频繁，稍等片刻再试。";
    case "network":
      return "请检查网络连接。";
    case "timeout":
      return "服务响应超时，可能是网盘目录过大。";
    case "forbidden":
      return "当前账号没有执行该操作的权限。";
    case "unsupported":
      return "该网盘驱动不支持这个操作。";
    default:
      return e.detail && e.detail !== e.message ? e.detail : undefined;
  }
}
