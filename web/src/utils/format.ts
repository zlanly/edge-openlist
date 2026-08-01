// 展示层格式化工具

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  // 1 位小数够用，整数就不带小数点，观感更干净
  return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)) + " " + UNITS[i];
}

export function formatTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";

  const now = Date.now();
  const diff = now - ms;
  if (diff >= 0 && diff < 60_000) return "刚刚";
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;

  const sameDay = new Date(now).toDateString() === d.toDateString();
  const pad = (x: number) => String(x).padStart(2, "0");
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getFullYear()}年${md}`;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export type FileKind = "dir" | "image" | "video" | "audio" | "pdf" | "text" | "code" | "archive" | "file";

const KIND_MAP: Record<string, FileKind> = {};
const register = (kind: FileKind, exts: string[]) => exts.forEach((e) => (KIND_MAP[e] = kind));
register("image", ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "ico", "heic"]);
register("video", ["mp4", "webm", "mkv", "mov", "avi", "flv", "m4v", "ts", "wmv", "rmvb"]);
register("audio", ["mp3", "flac", "wav", "ogg", "m4a", "aac", "wma", "opus"]);
register("pdf", ["pdf"]);
register("text", ["txt", "md", "log", "csv", "srt", "ass", "ini", "conf", "yml", "yaml"]);
register("code", ["js", "ts", "tsx", "jsx", "json", "html", "css", "scss", "vue", "py", "go", "rs", "java", "c", "cpp", "h", "sh", "sql", "xml", "php", "rb"]);
register("archive", ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "apk", "dmg"]);

export function kindOf(item: { name: string; is_dir: boolean }): FileKind {
  if (item.is_dir) return "dir";
  return KIND_MAP[extOf(item.name)] || "file";
}

/** 浏览器能就地预览的类型；其余一律走下载，避免打开一个满屏乱码的标签页。 */
export function isPreviewable(kind: FileKind): boolean {
  return kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" || kind === "text" || kind === "code";
}

export function joinPath(dir: string, name: string): string {
  if (!dir || dir === "/") return "/" + name;
  return dir.replace(/\/+$/, "") + "/" + name;
}

export function parentOf(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
