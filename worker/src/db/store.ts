import type { Env, MountRow, FileItem } from "../types";
import * as D1 from "./schema";
import { HttpError } from "../util/errors";

// 统一存储接口。本应用强制使用 D1 作为结构化数据存储（用户 / 挂载 / 分享 / 文件索引），
// 提供强一致与 SQL 搜索能力。部署时 Worker 可先不带任何绑定上传，部署完成后
// 再到 Cloudflare 控制台为 Worker 添加 D1 数据库绑定（绑定名 DB）即可启用。
// 若未绑定 D1，调用存储层会抛出明确错误，提示去控制台添加绑定（见 README 部署教程）。
export interface Store {
  // 挂载（仅启用）
  listMounts(): Promise<MountRow[]>;
  // 挂载（全部，含禁用，管理后台用）
  listAllMounts(): Promise<MountRow[]>;
  getMount(id: number): Promise<MountRow | null>;
  getMountByName(name: string): Promise<MountRow | null>;
  createMount(data: { name: string; driver: string; config_json: string; root: string; order: number }): Promise<number>;
  updateMount(
    id: number,
    patch: Partial<{ name: string; driver: string; config_json: string; root: string; order: number; enabled: number }>
  ): Promise<void>;
  deleteMount(id: number): Promise<void>;

  // 用户
  getUserByName(username: string): Promise<{ id: number; username: string; password_hash: string; role: string } | null>;
  createUser(username: string, password_hash: string, role?: string): Promise<void>;
  updateUserPassword(id: number, password_hash: string): Promise<void>;
  countUsers(): Promise<number>;

  // 文件缓存 / 搜索索引
  upsertFileCache(mountId: number, items: FileItem[], dirPath: string): Promise<void>;
  isCacheFresh(mountId: number, dirPath: string): Promise<boolean>;
  searchFiles(kw: string, limit?: number): Promise<any[]>;

  // 分享
  createShare(data: { id: string; mount_id: number; path: string; password: string | null; expire_at: number | null }): Promise<void>;
  getShare(id: string): Promise<any | null>;
  listShares(limit?: number): Promise<any[]>;
  deleteShare(id: string): Promise<void>;
}

// ---------- D1 实现（委托给 schema.ts） ----------
class D1Store implements Store {
  constructor(private db: D1Database) {}
  listMounts() {
    return D1.listMounts(this.db);
  }
  listAllMounts() {
    return D1.listAllMounts(this.db);
  }
  getMount(id: number) {
    return D1.getMount(this.db, id);
  }
  getMountByName(name: string) {
    return D1.getMountByName(this.db, name);
  }
  createMount(d: { name: string; driver: string; config_json: string; root: string; order: number }) {
    return D1.createMount(this.db, d);
  }
  updateMount(id: number, p: any) {
    return D1.updateMount(this.db, id, p);
  }
  deleteMount(id: number) {
    return D1.deleteMount(this.db, id);
  }
  getUserByName(u: string) {
    return D1.getUserByName(this.db, u);
  }
  createUser(u: string, h: string, r?: string) {
    return D1.createUser(this.db, u, h, r);
  }
  updateUserPassword(id: number, h: string) {
    return D1.updateUserPassword(this.db, id, h);
  }
  countUsers() {
    return D1.countUsers(this.db);
  }
  upsertFileCache(m: number, items: FileItem[], d: string) {
    return D1.upsertFileCache(this.db, m, items, d);
  }
  isCacheFresh(m: number, d: string) {
    return D1.isCacheFresh(this.db, m, d);
  }
  searchFiles(kw: string, limit?: number) {
    return D1.searchFiles(this.db, kw, limit);
  }
  createShare(d: any) {
    return D1.createShare(this.db, d);
  }
  getShare(id: string) {
    return D1.getShare(this.db, id);
  }
  listShares(limit?: number) {
    return D1.listShares(this.db, limit);
  }
  deleteShare(id: string) {
    return D1.deleteShare(this.db, id);
  }
}

// 取得存储实现：必须绑定 D1，否则抛出清晰错误引导去控制台添加绑定。
export function getStore(env: Env): Store {
  if (!env.DB || typeof (env.DB as any).prepare !== "function") {
    throw new HttpError(
      503,
      "未检测到 D1 数据库绑定（env.DB）。请到 Cloudflare 控制台为 Worker 添加 D1 数据库绑定（绑定名 DB），" +
        "然后重新部署。详见 README 部署教程。",
      "internal"
    );
  }
  return new D1Store(env.DB);
}
