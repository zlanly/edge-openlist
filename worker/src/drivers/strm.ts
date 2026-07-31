import type { Driver, DriverConfig, Env, FileItem, MountRow, UploadSession } from "../types";
import { basename, joinPath, normalizePath, sortItems } from "./base";
import { buildDriver } from "./factory";
import { CloudBase } from "./cloud-base";
import { getStore } from "../db/store";

// 元驱动：.strm 流文件。配置 paths（换行）每行 "name:/mount/sub" 或 "/mount/sub"（取末段为名），
// 把本挂载映射到一组底层挂载（multi-root）。list/get 转发到底层 driver；
// 对 .strm 文件，getContent 读取其底层文本内容（即真实播放地址）并返回该 URL 作为直链。
//
// 移植自 OpenList strm（drivers/strm/driver.go + util.go）：保留其 getPair / getRootAndPath /
// convert2strmObjs 思路，但底层挂载通过 buildDriver + D1 查询（按挂载名）获得，而非 OpenList 的 fs 层。

export class StrmDriver extends CloudBase {
  readonly id = "strm";
  private pathMap: Map<string, string> = new Map(); // name -> "/mount/sub"
  private autoFlatten = false;
  private cache: Map<string, Driver> = new Map();

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    for (const line of String(cfg.paths || "").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const [k, v] = getPair(t);
      this.pathMap.set(k, v);
    }
    this.autoFlatten = this.pathMap.size === 1;
  }

  private async driverForMount(mountPath: string): Promise<Driver> {
    const [name] = splitMount(mountPath);
    const cached = this.cache.get(name);
    if (cached) return cached;
    const row = await getStore(this.env).getMountByName(name);
    if (!row) throw new Error("strm: 未找到挂载: " + name);
    const d = await buildDriver(this.env, row);
    this.cache.set(name, d);
    return d;
  }

  private rootAndPath(path: string): [string, string] {
    if (this.autoFlatten) return [this.pathMap.keys().next().value as string, path];
    const p = path.replace(/^\//, "");
    const i = p.indexOf("/");
    if (i < 0) return [p, ""];
    return [p.slice(0, i), p.slice(i + 1)];
  }

  async list(path: string): Promise<FileItem[]> {
    if (path === "/" && !this.autoFlatten) {
      const items: FileItem[] = [];
      for (const k of this.pathMap.keys()) items.push({ name: k, path: "/" + k, is_dir: true, size: 0, modified: Date.now() });
      return sortItems(items);
    }
    const [root, sub] = this.rootAndPath(path);
    const dst = this.pathMap.get(root);
    if (!dst) throw new Error("strm: 无此根 " + root);
    const d = await this.driverForMount(dst);
    const [mName, mSub] = splitMount(dst);
    const rel = joinPath(mSub, sub);
    const objs = await d.list(rel);
    return sortItems(objs.map((o) => ({ ...o, path: joinPath(path, o.name) })));
  }

  async get(path: string): Promise<FileItem> {
    const [root, sub] = this.rootAndPath(path);
    const dst = this.pathMap.get(root);
    if (!dst) throw new Error("strm: 无此根 " + root);
    const d = await this.driverForMount(dst);
    const [mName, mSub] = splitMount(dst);
    const rel = joinPath(mSub, sub);
    const o = await d.get(rel);
    return { ...o, path };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const name = basename(path);
    const [root, sub] = this.rootAndPath(path);
    const dst = this.pathMap.get(root);
    if (!dst) throw new Error("strm: 无此根 " + root);
    const d = await this.driverForMount(dst);
    const [mName, mSub] = splitMount(dst);
    const rel = joinPath(mSub, sub);

    if (name.endsWith(".strm")) {
      const link = await d.getContent(rel);
      const stream = typeof link === "string" ? (await fetch(link)).body : link.body;
      if (!stream) throw new Error("strm: 读取失败");
      const urlText = (await new Response(stream).text()).trim();
      if (range) {
        const r = await fetch(urlText, { headers: { Range: range } });
        if (!r.ok && r.status !== 206) throw new Error("strm: fetch 失败 " + r.status);
        return r;
      }
      return urlText; // 直链
    }
    const r = await d.getContent(rel, range);
    if (typeof r === "string") {
      if (range) {
        const rr = await fetch(r, { headers: { Range: range } });
        if (!rr.ok && rr.status !== 206) throw new Error("strm: fetch 失败 " + rr.status);
        return rr;
      }
      return r;
    }
    return r;
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "strm" } };
  }

  async putContent(path: string, body: ReadableStream, ct?: string, size?: number): Promise<void> {
    const [root, sub] = this.rootAndPath(path);
    const dst = this.pathMap.get(root);
    if (!dst) throw new Error("strm: 无此根 " + root);
    const d = await this.driverForMount(dst);
    const [, mSub] = splitMount(dst);
    const rel = joinPath(mSub, sub);
    await d.putContent?.(rel, body, ct, size);
  }

  async mkdir(path: string): Promise<void> {
    const [root, sub] = this.rootAndPath(path);
    const dst = this.pathMap.get(root);
    if (!dst) throw new Error("strm: 无此根 " + root);
    const d = await this.driverForMount(dst);
    const [, mSub] = splitMount(dst);
    await d.mkdir(joinPath(mSub, sub));
  }
  async remove(path: string): Promise<void> {
    const [root, sub] = this.rootAndPath(path);
    const dst = this.pathMap.get(root);
    if (!dst) throw new Error("strm: 无此根 " + root);
    const d = await this.driverForMount(dst);
    const [, mSub] = splitMount(dst);
    await d.remove(joinPath(mSub, sub));
  }
  async rename(from: string, to: string): Promise<void> {
    const [rf, sf] = this.rootAndPath(from);
    const [rt, st] = this.rootAndPath(to);
    const dstf = this.pathMap.get(rf);
    const dstt = this.pathMap.get(rt);
    if (!dstf || !dstt) throw new Error("strm: 根不存在");
    const d = await this.driverForMount(dstf);
    const [, mf] = splitMount(dstf);
    const [, mt] = splitMount(dstt);
    await d.rename(joinPath(mf, sf), joinPath(mt, st));
  }
  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }
}

// 与 OpenList strm/util.go getPair 一致：含 ':' 且 ':' 前无 '/' 视为 "name:value"
function getPair(path: string): [string, string] {
  if (path.includes(":") && !path.slice(0, path.indexOf(":")).includes("/")) {
    const pair = path.split(":");
    return [pair[0], pair[1]];
  }
  return [basename(path.replace(/:/g, "")), path];
}

function splitMount(p: string): [string, string] {
  const n = normalizePath(p).replace(/^\//, "");
  const i = n.indexOf("/");
  if (i < 0) return [n, "/"];
  return [n.slice(0, i), n.slice(i)];
}
