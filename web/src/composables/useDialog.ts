import { ref } from "vue";

// 替代原生 confirm() / prompt()。
//
// 原生对话框的问题不只是丑：它们会**同步阻塞** JS 主线程，正在进行的
// 上传、目录加载、轮询全部冻结；在 iOS Safari 里还可能被「阻止此页面再次弹出」
// 直接吞掉，导致点了删除毫无反应 —— 用户报告的「没响应」有一部分正是这个。

export interface ConfirmSpec {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface PromptField {
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  type?: "text" | "password" | "number";
  help?: string;
  required?: boolean;
}

export interface PromptSpec {
  title: string;
  message?: string;
  fields: PromptField[];
  confirmText?: string;
  cancelText?: string;
}

type Pending =
  | { kind: "confirm"; spec: ConfirmSpec; resolve: (v: boolean) => void }
  | { kind: "prompt"; spec: PromptSpec; resolve: (v: Record<string, string> | null) => void };

const current = ref<Pending | null>(null);

function close(result: any) {
  const p = current.value;
  current.value = null;
  p?.resolve(result);
}

export function useDialog() {
  return {
    current,
    confirm(spec: ConfirmSpec): Promise<boolean> {
      // 前一个对话框还开着就先自动取消，避免 Promise 永远悬着（内存泄漏 + 界面卡死）
      if (current.value) close(current.value.kind === "confirm" ? false : null);
      return new Promise<boolean>((resolve) => {
        current.value = { kind: "confirm", spec, resolve };
      });
    },
    prompt(spec: PromptSpec): Promise<Record<string, string> | null> {
      if (current.value) close(current.value.kind === "confirm" ? false : null);
      return new Promise<Record<string, string> | null>((resolve) => {
        current.value = { kind: "prompt", spec, resolve };
      });
    },
    resolve: close,
    cancel() {
      if (!current.value) return;
      close(current.value.kind === "confirm" ? false : null);
    },
  };
}
