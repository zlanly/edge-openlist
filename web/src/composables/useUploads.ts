import { computed, ref } from "vue";
import { ApiError, api, uploadFile, type UploadHandle } from "../api";
import { joinPath } from "../utils/format";
import { useToast } from "./useToast";

// ---------------------------------------------------------------------------
// 上传队列
//
// 旧实现是 `for (const f of files) await uploadFile(init, f)`：
//   · 没有进度，用户面对一个不动的界面，只能猜是不是死了；
//   · 没有并发控制，也没有失败处理 —— 中途失败后面的文件全部静默丢失；
//   · 整个过程阻塞在一个 async 函数里，切目录/刷新都会把它连根拔掉。
//
// 现在：全局队列 + 有限并发 + 逐项进度 / 重试 / 取消，切目录也不会中断。
// ---------------------------------------------------------------------------

export type UploadStatus = "queued" | "uploading" | "done" | "error" | "canceled";

export interface UploadTask {
  id: number;
  file: File;
  name: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  error?: string;
  mount: number;
  /** 目标目录（不含文件名） */
  dir: string;
  handle?: UploadHandle;
  /** 用户主动取消。单独用一个字段而不是看 status —— 取消发生在 await 中途，
   *  TypeScript 的控制流分析看不到这条路径。 */
  canceled?: boolean;
}

// 并发 2：Workers 单请求 subrequest 有上限，手机上行带宽也吃不消更多并发；
// 再高只会让每个文件都变慢，还更容易触发网盘侧限流。
const CONCURRENCY = 2;

const tasks = ref<UploadTask[]>([]);
const panelOpen = ref(false);
let seq = 0;
let running = 0;

type DoneListener = (mount: number, dir: string) => void;
const doneListeners = new Set<DoneListener>();

function retryTask(id: number) {
  const t = tasks.value.find((x) => x.id === id);
  if (!t || (t.status !== "error" && t.status !== "canceled")) return;
  t.canceled = false;
  t.status = "queued";
  t.error = undefined;
  t.loaded = 0;
  pump();
}

function pump() {
  while (running < CONCURRENCY) {
    const next = tasks.value.find((t) => t.status === "queued");
    if (!next) return;
    void run(next);
  }
}

async function run(task: UploadTask) {
  running++;
  task.status = "uploading";
  task.loaded = 0;
  try {
    const target = joinPath(task.dir, task.file.name);
    const init = await api.uploadInit(task.mount, target, task.size);
    const handle = uploadFile(init, task.file, (loaded) => {
      task.loaded = loaded;
    });
    task.handle = handle;
    await handle.promise;
    task.status = "done";
    task.loaded = task.size;
    for (const fn of doneListeners) {
      try {
        fn(task.mount, task.dir);
      } catch {}
    }
  } catch (e) {
    // 用户主动取消不该被当成错误刷屏
    if (!task.canceled) {
      task.status = "error";
      task.error = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "上传失败";
      // 会话失效交给 App 统一处理，其余失败必须主动说出来：
      // 上传面板可能是折叠的，而顶栏进度按钮在任务失败后就不再显示，
      // 不弹提示的话这次上传就彻底石沉大海了。
      if (!(e instanceof ApiError && e.isSessionExpired)) {
        useToast().error(`「${task.name}」上传失败`, task.error, {
          label: "重试",
          run: () => {
            panelOpen.value = true;
            retryTask(task.id);
          },
        });
      }
    }
  } finally {
    task.handle = undefined;
    running--;
    pump();
  }
}

export function useUploads() {
  return {
    tasks,
    panelOpen,

    active: computed(() => tasks.value.filter((t) => t.status === "queued" || t.status === "uploading")),
    failed: computed(() => tasks.value.filter((t) => t.status === "error")),
    /** 整体进度 0~1，用于顶栏的细进度条 */
    progress: computed(() => {
      const live = tasks.value.filter((t) => t.status === "queued" || t.status === "uploading");
      if (!live.length) return 0;
      const total = live.reduce((s, t) => s + t.size, 0);
      const done = live.reduce((s, t) => s + t.loaded, 0);
      return total ? done / total : 0;
    }),

    enqueue(files: File[] | FileList, mount: number, dir: string) {
      const list = Array.from(files);
      if (!list.length) return;
      for (const file of list) {
        tasks.value.push({
          id: ++seq,
          file,
          name: file.name,
          size: file.size,
          loaded: 0,
          status: "queued",
          mount,
          dir,
        });
      }
      panelOpen.value = true;
      pump();
    },

    cancel(id: number) {
      const t = tasks.value.find((x) => x.id === id);
      if (!t) return;
      t.canceled = true;
      t.status = "canceled";
      t.handle?.abort();
    },

    retry: retryTask,

    remove(id: number) {
      const t = tasks.value.find((x) => x.id === id);
      if (t && (t.status === "uploading" || t.status === "queued")) {
        t.canceled = true;
        t.status = "canceled";
        t.handle?.abort();
      }
      tasks.value = tasks.value.filter((x) => x.id !== id);
    },

    clearFinished() {
      tasks.value = tasks.value.filter((t) => t.status === "queued" || t.status === "uploading");
      if (!tasks.value.length) panelOpen.value = false;
    },

    /** 某个文件传完时通知（用于自动刷新对应目录）。 */
    onDone(fn: DoneListener): () => void {
      doneListeners.add(fn);
      return () => doneListeners.delete(fn);
    },
  };
}
