import type { Driver, DriverConfig, Env, FileItem, MountRow, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath, sortItems } from "./base";
import { buildDriver } from "./factory";
import { CloudBase } from "./cloud-base";

// 元驱动（按移植任务说明实现）：包装一个底层 driver（cfg.remote_driver / remote_config），
// 转发所有操作；并在每个目录自动生成一个索引项（index_name，默认 index.html），
// 访问该索引项时根据当前目录列表动态生成 HTML 索引页 —— “自动索引”。
//
// 说明：OpenList 上游 autoindex 的真实逻辑是抓取远程 HTTP 目录列表页（HTML + XPath）并解析，
// 这依赖 XPath/DOM 引擎，CF Worker 运行时不具备，无法忠实移植；故此处按任务说明实现为
// “底层 driver 元驱动 + 自动生成索引”的等效形态。

export class AutoIndexDriver extends CloudBase {
  readonly id = "autoindex";
  private sub!: Driver;
  private indexName = "index.html";

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private cfgStr(k: string): string {
    return (this.cfg as any)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.indexName = this.cfgStr("index_name") || "index.html";
  }

  private async remote(): Promise<Driver> {
    if (this.sub) return this.sub;
    const cfgObj = this.cfg.remote_config && typeof this.cfg.remote_config === "object" ? this.cfg.remote_config : {};
    const row: MountRow = {
      id: this.mountId,
      name: this.cfgStr("remote_driver") || "autoindex",
      driver: this.cfgStr("remote_driver") || "",
      config_json: JSON.stringify(cfgObj),
      root: "/",
      order: 0,
      enabled: 1,
      created_at: Date.now(),
    };
    this.sub = await buildDriver(this.env, row);
    return this.sub;
  }

  private isIndex(path: string): boolean {
    return basename(normalizePath(path)) === this.indexName;
  }

  async list(path: string): Promise<FileItem[]> {
    const d = await this.remote();
    const items = await d.list(path);
    if (this.cfg.add_index !== false) {
      items.push({ name: this.indexName, path: joinPath(path, this.indexName), is_dir: false, size: 0, modified: Date.now() });
    }
    return sortItems(items);
  }

  async get(path: string): Promise<FileItem> {
    if (this.isIndex(path)) {
      return { name: this.indexName, path, is_dir: false, size: 0, modified: Date.now() };
    }
    const d = await this.remote();
    return d.get(path);
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    if (this.isIndex(path)) {
      const d = await this.remote();
      const parent = parentPath(path);
      const items = await d.list(parent);
      const lines = items
        .filter((i) => i.name !== this.indexName)
        .map((i) => `<li><a href="${encodeURIComponent(i.name)}">${escapeHtml(i.name)}${i.is_dir ? "/" : ""}</a>${i.is_dir ? "" : " (" + i.size + ")"}</li>`)
        .join("\n");
      const title = this.cfgStr("index_title") || "Index of " + parent;
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><ul>${lines}</ul></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(new TextEncoder().encode(html).length) } });
    }
    const d = await this.remote();
    const r = await d.getContent(path, range);
    return r;
  }

  async createUpload(path: string, size: number): Promise<UploadSession> {
    const d = await this.remote();
    if (this.isIndex(path)) return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "autoindex" } };
    return d.createUpload(path, size);
  }

  async putContent(path: string, body: ReadableStream, ct?: string, size?: number): Promise<void> {
    if (this.isIndex(path)) throw new Error("autoindex 索引项不可写");
    const d = await this.remote();
    await d.putContent?.(path, body, ct, size);
  }

  async mkdir(path: string): Promise<void> {
    const d = await this.remote();
    await d.mkdir(path);
  }
  async remove(path: string): Promise<void> {
    if (this.isIndex(path)) throw new Error("autoindex 索引项不可删");
    const d = await this.remote();
    await d.remove(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const d = await this.remote();
    await d.rename(from, to);
  }
  async move(from: string, to: string): Promise<void> {
    const d = await this.remote();
    await d.move(from, to);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
