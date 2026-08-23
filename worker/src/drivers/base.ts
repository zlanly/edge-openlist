import type { Driver, DriverConfig, Env, FileItem } from "../types";

// 路径工具：统一以 "/" 开头、去掉尾斜杠（根目录为 "/"）
export function normalizePath(p: string): string {
  if (!p) return "/";
  let s = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s || "/";
}

export function joinPath(base: string, name: string): string {
  const b = normalizePath(base);
  return b === "/" ? "/" + name : b + "/" + name;
}

export function parentPath(p: string): string {
  const s = normalizePath(p);
  if (s === "/") return "/";
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
}

export function basename(p: string): string {
  const s = normalizePath(p);
  if (s === "/") return "";
  return s.slice(s.lastIndexOf("/") + 1);
}

// 驱动工厂注册表
type DriverCtor = new () => Driver;

const registry: Record<string, DriverCtor> = {};

export function registerDriver(name: string, ctor: DriverCtor): void {
  registry[name] = ctor;
}

export function createDriver(name: string, cfg: DriverConfig, env: Env): Driver {
  const Ctor = registry[name];
  if (!Ctor) throw new Error(`未知驱动: ${name}`);
  const d = new Ctor();
  d.use(env);
  return d;
}

export function listDriverNames(): string[] {
  return Object.keys(registry);
}

export function sortItems(items: FileItem[]): FileItem[] {
  return items.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
}

// 解析 HTTP Range 头 -> R2/S3 的 {offset,length} 选项
export function parseRange(
  header: string | null
): { offset: number; length?: number } | { suffix: number } | null {
  if (!header) return null;
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const start = m[1];
  const end = m[2];
  if (start === "" && end === "") return null;
  if (start === "") {
    const suffix = Number(end);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : null; // bytes=-N
  }
  const off = Number(start);
  if (!Number.isSafeInteger(off) || off < 0) return null;
  if (end === "") return { offset: off }; // bytes=N-
  const last = Number(end);
  if (!Number.isSafeInteger(last) || last < off) return null;
  return { offset: off, length: last - off + 1 }; // bytes=N-M
}
