import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath } from "./base";
import { CloudBase } from "./cloud-base";

// OpenList 分享解析（只读）。端点对齐 drivers/openlist_share/{driver,util}.go
// 列表走 /api/fs/list（路径前缀 /@s/<sid>），下载链接走 /sd/<shareId><path>?pwd=
function notSupport(op: string): never {
  throw new Error(`NotSupport: openlist_share 为只读驱动，不支持 ${op}`);
}

export class OpenListShareDriver extends CloudBase {
  readonly id = "openlist_share";
  private address = "";
  private shareId = "";
  private pwd = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.address = (this.cfgStr("url") || "").replace(/\/$/, "");
    this.shareId = this.cfgStr("sid") || "";
    this.pwd = this.cfgStr("pwd") || "";
    if (!this.address || !this.shareId) throw new Error("openlist_share: 缺少 url 或 sid");
    // 校验站点允许挂载（/api/public/settings -> data.share_archive_preview 等）
    const r = await fetch(this.address + "/api/public/settings");
    if (!r.ok) throw new Error(`openlist_share 获取公开设置失败 ${r.status}`);
  }

  // 上游列表路径：/@s/<sid> + 虚拟路径
  private listPath(p: string): string {
    const v = normalizePath(p);
    return joinPath("/@s/" + this.shareId, v === "/" ? "" : v.slice(1));
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  async list(path: string): Promise<FileItem[]> {
    const j = await this.jsonPost<{ code: number; message: string; data: { content: any[] } }>(
      this.address + "/api/fs/list",
      { page: 1, per_page: 0, path: this.listPath(path), password: this.pwd, refresh: false }
    );
    if (j.code !== 200) throw new Error(`openlist_share list: ${j.message}`);
    return (j.data.content || []).map((f) => ({
      name: f.name,
      path: joinPath(path, f.name),
      is_dir: !!f.is_dir,
      size: Number(f.size || 0),
      modified: f.modified ? new Date(f.modified).getTime() : 0,
    }));
  }

  async get(path: string): Promise<FileItem> {
    // 分享侧无独立 get，复用列表
    const items = await this.list(path === "/" ? "/" : parentPathOf(path));
    const name = basename(path);
    const hit = items.find((i) => i.name === name);
    if (!hit) throw new Error("文件不存在");
    return hit;
  }

  async getContent(path: string, _range?: string): Promise<Response | string> {
    // 优先返回上游直链字符串（/sd/<shareId><虚拟路径>?pwd=）
    const v = normalizePath(path);
    const full = joinPath("/" + this.shareId, v === "/" ? "" : v.slice(1));
    return `${this.address}/sd${full}?pwd=${encodeURIComponent(this.pwd)}`;
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    notSupport("上传");
  }
  async mkdir(_path: string): Promise<void> {
    notSupport("创建目录");
  }
  async remove(_path: string): Promise<void> {
    notSupport("删除");
  }
  async rename(_from: string, _to: string): Promise<void> {
    notSupport("重命名");
  }
  async move(_from: string, _to: string): Promise<void> {
    notSupport("移动");
  }
}

function parentPathOf(p: string): string {
  const n = normalizePath(p);
  if (n === "/") return "/";
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}
