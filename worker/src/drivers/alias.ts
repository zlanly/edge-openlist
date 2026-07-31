import type { Driver, DriverConfig, Env, FileItem, MountRow, UploadSession } from "../types";
import { basename, joinPath, normalizePath } from "./base";
import { buildDriver } from "./factory";
import { CloudBase } from "./cloud-base";
import { getStore } from "../db/store";

// 元驱动：别名挂载。把本挂载映射到另一个已存在挂载的某路径。
// init 从 cfg 读取目标挂载：优先 mount_id（+ 可选 path 子路径），否则读 remote（OpenList 形式 "/挂载名/子路径"）。
// 通过 D1 查询目标挂载行（SELECT * FROM mounts WHERE id/?），再用 buildDriver 获取目标 driver 实例并转发。
// 懒加载：在方法内调用 buildDriver，不在构造时建，避免循环依赖 / 初始化顺序问题。
//
// 注：OpenList 上游 alias 支持多后端负载均衡（ReadConflictPolicy/WriteConflictPolicy 等），
// 此处按任务说明实现单一目标映射（最常用形态）。

export class AliasDriver extends CloudBase {
  readonly id = "alias";
  private target: { driver: Driver; sub: string } | null = null;

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
  }

  private cfgStr(k: string): string {
    return (this.cfg as any)[k] as string;
  }

  private async resolveTarget(): Promise<{ driver: Driver; sub: string }> {
    if (this.target) return this.target;
    const mid = this.cfg.mount_id;
    if (mid != null && mid !== "") {
      const row = await getStore(this.env).getMount(Number(mid));
      if (!row) throw new Error("alias: 未找到目标挂载 id=" + mid);
      const d = await buildDriver(this.env, row);
      this.target = { driver: d, sub: normalizePath(this.cfgStr("path") || "/") };
      return this.target;
    }
    const remote = this.cfgStr("remote").trim();
    if (remote) {
      const [name, rest] = splitMount(remote);
      const row = await getStore(this.env).getMountByName(name);
      if (!row) throw new Error("alias: 未找到目标挂载 name=" + name);
      const d = await buildDriver(this.env, row);
      this.target = { driver: d, sub: rest };
      return this.target;
    }
    throw new Error("alias: 必须提供 mount_id 或 remote");
  }

  private async toRemote(path: string): Promise<string> {
    const { sub } = await this.resolveTarget();
    return joinPath(sub, path === "/" ? "" : path);
  }

  async list(path: string): Promise<FileItem[]> {
    const { driver } = await this.resolveTarget();
    return driver.list(await this.toRemote(path));
  }
  async get(path: string): Promise<FileItem> {
    const { driver } = await this.resolveTarget();
    return driver.get(await this.toRemote(path));
  }
  async getContent(path: string, range?: string): Promise<Response | string> {
    const { driver } = await this.resolveTarget();
    return driver.getContent(await this.toRemote(path), range);
  }
  async createUpload(path: string, size: number): Promise<UploadSession> {
    const { driver } = await this.resolveTarget();
    if (typeof driver.createUpload === "function") return driver.createUpload(await this.toRemote(path), size);
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "alias" } };
  }
  async putContent(path: string, body: ReadableStream, ct?: string, size?: number): Promise<void> {
    const { driver } = await this.resolveTarget();
    await driver.putContent?.(await this.toRemote(path), body, ct, size);
  }
  async mkdir(path: string): Promise<void> {
    const { driver } = await this.resolveTarget();
    await driver.mkdir(await this.toRemote(path));
  }
  async remove(path: string): Promise<void> {
    const { driver } = await this.resolveTarget();
    await driver.remove(await this.toRemote(path));
  }
  async rename(from: string, to: string): Promise<void> {
    const { driver } = await this.resolveTarget();
    await driver.rename(await this.toRemote(from), await this.toRemote(to));
  }
  async move(from: string, to: string): Promise<void> {
    const { driver } = await this.resolveTarget();
    await driver.move(await this.toRemote(from), await this.toRemote(to));
  }
}

function splitMount(p: string): [string, string] {
  const n = normalizePath(p).replace(/^\//, "");
  const i = n.indexOf("/");
  if (i < 0) return [n, "/"];
  return [n.slice(0, i), n.slice(i)];
}
