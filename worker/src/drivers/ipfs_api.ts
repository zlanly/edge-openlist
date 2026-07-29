import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// IPFS HTTP API 网关（列表/读取/写入）。端点对齐 OpenList drivers/ipfs_api/driver.go 使用的
// go-ipfs-api（kubo RPC）：/api/v0/ls、/api/v0/files/stat、/api/v0/files/{mkdir,mv,cp,rm}、/api/v0/add
// 注意：Endpoint 为 kubo RPC 端口（默认 5001），在 CF Worker 中必须配置为公网可达的 kubo 节点，
// 否则无法连接（本地 127.0.0.1 不可达）。下载直链走 Gateway。
export class IpfsApiDriver extends CloudBase {
  readonly id = "ipfs_api";
  private mode = "ipfs";
  private endpoint = "http://127.0.0.1:5001";
  private gateway = "http://127.0.0.1:8080";
  private root = "/";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.mode = this.cfgStr("mode") || "ipfs";
    this.endpoint = (this.cfgStr("endpoint") || this.endpoint).replace(/\/$/, "");
    this.gateway = (this.cfgStr("gateway") || this.gateway).replace(/\/$/, "");
    this.root = normalizePath(this.cfgStr("root") || "/");
    if (!["ipfs", "ipns", "mfs"].includes(this.mode)) throw new Error("ipfs_api: mode 非法");
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private apiPath(vpath: string): string {
    // 返回 kubo 可识别的 /ipfs/<cid>/... 或 /ipns/<name>/... 路径
    if (this.mode === "mfs") {
      const mfs = this.root === "/" ? vpath : joinPath(this.root, vpath);
      return mfs;
    }
    const prefix = this.mode === "ipns" ? "/ipns/" : "/ipfs/";
    const base = this.root === "/" ? "" : this.root;
    return prefix + base + (vpath === "/" ? "" : vpath);
  }

  private async ls(arg: string): Promise<{ Name: string; Hash: string; Size: number; Type: number }[]> {
    const r = await fetch(`${this.endpoint}/api/v0/ls?arg=${encodeURIComponent(arg)}`);
    if (!r.ok) throw new Error(`ipfs ls ${r.status}`);
    const j = (await r.json()) as any;
    const obj = j.Objects?.[0];
    return (obj?.Links || []) as any[];
  }

  // 解析虚拟路径到 /ipfs/<cid> 形式（mfs 需先 FilesStat 取 hash）
  private async resolveArg(path: string): Promise<string> {
    if (this.mode === "mfs") {
      const mfs = this.root === "/" ? path : joinPath(this.root, path);
      const r = await fetch(`${this.endpoint}/api/v0/files/stat?arg=${encodeURIComponent(mfs)}`, { method: "POST" });
      if (!r.ok) throw new Error(`ipfs files/stat ${r.status}`);
      const j = (await r.json()) as any;
      return "/ipfs/" + j.Hash;
    }
    return this.apiPath(path);
  }

  private gateUrl(cid: string, name: string): string {
    const u = new URL(this.gateway + "/ipfs/" + cid);
    u.searchParams.set("filename", name);
    return u.toString();
  }

  async list(path: string): Promise<FileItem[]> {
    const arg = await this.resolveArg(path);
    const links = await this.ls(arg);
    return links.map((l) => ({
      name: l.Name,
      path: joinPath(path, l.Name),
      is_dir: l.Type === 1,
      size: Number(l.Size || 0),
      modified: 0,
      etag: l.Hash,
    }));
  }

  async get(path: string): Promise<FileItem> {
    const arg = await this.resolveArg(path);
    let size = 0;
    let isDir = false;
    if (this.mode === "mfs") {
      const mfs = this.root === "/" ? path : joinPath(this.root, path);
      const r = await fetch(`${this.endpoint}/api/v0/files/stat?arg=${encodeURIComponent(mfs)}`, { method: "POST" });
      const j = (await r.json()) as any;
      size = Number(j.Size || 0);
      isDir = j.Type === "directory";
    } else {
      const links = await this.ls(arg);
      isDir = links.length > 0 || arg.endsWith("/");
    }
    return { name: basename(path), path, is_dir: isDir, size, modified: 0 };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const cid = (await this.list(path === "/" ? "/" : parentPath(path))).find((i) => i.path === path)?.etag
      || (await this.resolveArg(path)).replace(/^\/(ipfs|ipns)\//, "");
    const url = this.gateUrl(cid, basename(path));
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "ipfs_api" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, _size?: number): Promise<void> {
    if (this.mode !== "mfs") throw new Error("NotSupport: ipfs_api 仅在 mfs 模式可写");
    const r = await fetch(`${this.endpoint}/api/v0/add?pin=true`, { method: "POST", body });
    if (!r.ok) throw new Error(`ipfs add ${r.status}`);
    const j = (await r.json()) as any;
    const hash = j.Hash;
    const dst = this.root === "/" ? path : joinPath(this.root, path);
    await fetch(`${this.endpoint}/api/v0/files/rm?arg=${encodeURIComponent(dst)}&recursive=true`, { method: "POST" }).catch(() => {});
    const cp = await fetch(`${this.endpoint}/api/v0/files/cp?arg=${encodeURIComponent("/ipfs/" + hash)}&arg=${encodeURIComponent(dst)}`, { method: "POST" });
    if (!cp.ok) throw new Error(`ipfs files/cp ${cp.status}`);
  }

  async mkdir(path: string): Promise<void> {
    if (this.mode !== "mfs") throw new Error("NotSupport: ipfs_api 仅在 mfs 模式可写");
    const mfs = this.root === "/" ? path : joinPath(this.root, path);
    const r = await fetch(`${this.endpoint}/api/v0/files/mkdir?arg=${encodeURIComponent(mfs)}&parents=true`, { method: "POST" });
    if (!r.ok) throw new Error(`ipfs mkdir ${r.status}`);
  }

  async remove(path: string): Promise<void> {
    if (this.mode !== "mfs") throw new Error("NotSupport: ipfs_api 仅在 mfs 模式可写");
    const mfs = this.root === "/" ? path : joinPath(this.root, path);
    const r = await fetch(`${this.endpoint}/api/v0/files/rm?arg=${encodeURIComponent(mfs)}&recursive=true`, { method: "POST" });
    if (!r.ok) throw new Error(`ipfs rm ${r.status}`);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.mode !== "mfs") throw new Error("NotSupport: ipfs_api 仅在 mfs 模式可写");
    const src = this.root === "/" ? from : joinPath(this.root, from);
    const dst = this.root === "/" ? to : joinPath(this.root, to);
    await fetch(`${this.endpoint}/api/v0/files/rm?arg=${encodeURIComponent(dst)}&recursive=true`, { method: "POST" }).catch(() => {});
    const mv = await fetch(`${this.endpoint}/api/v0/files/mv?arg=${encodeURIComponent(src)}&arg=${encodeURIComponent(dst)}`, { method: "POST" });
    if (!mv.ok) throw new Error(`ipfs mv ${mv.status}`);
  }

  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }
}
