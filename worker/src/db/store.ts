import type { Env, MountRow, FileItem } from "../types";
import * as D1 from "./schema";

// 统一存储接口：存在 D1 绑定时走 D1（强一致、支持 SQL 搜索），
// 否则自动降级到 KV（无 D1 权限 / 未启用 R2 的账户也能完整运行）。
// 这样一份代码既能部署到拥有 D1 的账户，也能在仅有 KV 的账户上跑起来。
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
  countUsers(): Promise<number>;

  // 文件缓存 / 搜索索引
  upsertFileCache(mountId: number, items: FileItem[], dirPath: string): Promise<void>;
  searchFiles(kw: string, limit?: number): Promise<any[]>;

  // 分享
  createShare(data: { id: string; mount_id: number; path: string; password: string | null; expire_at: number | null }): Promise<void>;
  getShare(id: string): Promise<any | null>;
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
  countUsers() {
    return D1.countUsers(this.db);
  }
  upsertFileCache(m: number, items: FileItem[], d: string) {
    return D1.upsertFileCache(this.db, m, items, d);
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
}

// ---------- KV 实现（无 D1 时的降级路径） ----------
// 键设计：
//   mount:<id>            -> MountRow JSON
//   mountname:<name>      -> mount id（按名索引）
//   meta:mount_seq        -> 自增 ID 计数器
//   user:<username>       -> 用户 JSON
//   meta:user_seq / meta:user_count
//   share:<id>            -> 分享 JSON
//   fcache:<mountId>:<dir>-> FileItem[] JSON（每目录一档，对应 D1 的目录级 upsert）
class KvStore implements Store {
  constructor(private kv: KVNamespace) {}

  private async nextId(metaKey: string): Promise<number> {
    const cur = Number((await this.kv.get(metaKey)) || "0");
    const next = cur + 1;
    await this.kv.put(metaKey, String(next));
    return next;
  }

  async listAllMounts(): Promise<MountRow[]> {
    const out: MountRow[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.kv.list({ prefix: "mount:", cursor });
      for (const k of r.keys) {
        if (k.name.startsWith("mountname:")) continue;
        const v = await this.kv.get(k.name);
        if (v) out.push(JSON.parse(v) as MountRow);
      }
      cursor = r.list_complete ? undefined : r.cursor;
    } while (cursor);
    out.sort((a, b) => a.order - b.order || a.id - b.id);
    return out;
  }

  async listMounts(): Promise<MountRow[]> {
    return (await this.listAllMounts()).filter((m) => m.enabled !== 0);
  }

  async getMount(id: number): Promise<MountRow | null> {
    const v = await this.kv.get("mount:" + id);
    return v ? (JSON.parse(v) as MountRow) : null;
  }

  async getMountByName(name: string): Promise<MountRow | null> {
    const id = await this.kv.get("mountname:" + name);
    if (!id) return null;
    return this.getMount(Number(id));
  }

  async createMount(data: { name: string; driver: string; config_json: string; root: string; order: number }): Promise<number> {
    const id = await this.nextId("meta:mount_seq");
    const row: MountRow = {
      id,
      name: data.name,
      driver: data.driver,
      config_json: data.config_json,
      root: data.root,
      order: data.order,
      enabled: 1,
      created_at: Date.now(),
    };
    await this.kv.put("mount:" + id, JSON.stringify(row));
    await this.kv.put("mountname:" + data.name, String(id));
    return id;
  }

  async updateMount(
    id: number,
    patch: Partial<{ name: string; driver: string; config_json: string; root: string; order: number; enabled: number }>
  ): Promise<void> {
    const row = await this.getMount(id);
    if (!row) return;
    if (patch.name !== undefined && patch.name !== row.name) {
      await this.kv.delete("mountname:" + row.name);
      await this.kv.put("mountname:" + patch.name, String(id));
      row.name = patch.name;
    }
    if (patch.driver !== undefined) row.driver = patch.driver;
    if (patch.config_json !== undefined) row.config_json = patch.config_json;
    if (patch.root !== undefined) row.root = patch.root;
    if (patch.order !== undefined) row.order = patch.order;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    await this.kv.put("mount:" + id, JSON.stringify(row));
  }

  async deleteMount(id: number): Promise<void> {
    const row = await this.getMount(id);
    if (!row) return;
    await this.kv.delete("mount:" + id);
    await this.kv.delete("mountname:" + row.name);
  }

  async getUserByName(username: string): Promise<{ id: number; username: string; password_hash: string; role: string } | null> {
    const v = await this.kv.get("user:" + username);
    return v ? (JSON.parse(v) as any) : null;
  }

  async createUser(username: string, password_hash: string, role = "user"): Promise<void> {
    const id = await this.nextId("meta:user_seq");
    const row = { id, username, password_hash, role, created_at: Date.now() };
    await this.kv.put("user:" + username, JSON.stringify(row));
    const c = Number((await this.kv.get("meta:user_count")) || "0");
    await this.kv.put("meta:user_count", String(c + 1));
  }

  async countUsers(): Promise<number> {
    return Number((await this.kv.get("meta:user_count")) || "0");
  }

  async upsertFileCache(mountId: number, items: FileItem[], dirPath: string): Promise<void> {
    const key = "fcache:" + mountId + ":" + dirPath;
    const payload = items.map((it) => ({
      name: it.name,
      path: it.path,
      size: it.size,
      is_dir: it.is_dir ? 1 : 0,
      modified: it.modified,
      etag: it.etag ?? null,
    }));
    await this.kv.put(key, JSON.stringify(payload));
  }

  async searchFiles(kw: string, limit = 200): Promise<any[]> {
    const out: any[] = [];
    const q = kw.toLowerCase();
    let cursor: string | undefined;
    do {
      const r = await this.kv.list({ prefix: "fcache:", cursor });
      for (const k of r.keys) {
        const parts = k.name.split(":");
        const mountId = Number(parts[1]);
        const v = await this.kv.get(k.name);
        if (!v) continue;
        const items: any[] = JSON.parse(v);
        for (const it of items) {
          if (it.name && String(it.name).toLowerCase().includes(q)) {
            out.push({
              mount_id: mountId,
              path: it.path,
              name: it.name,
              size: it.size,
              is_dir: it.is_dir,
              modified: it.modified,
            });
          }
        }
        if (out.length >= limit) break;
      }
      cursor = r.list_complete || out.length >= limit ? undefined : r.cursor;
    } while (cursor);
    out.sort((a, b) => b.is_dir - a.is_dir || String(a.name).localeCompare(String(b.name)));
    return out.slice(0, limit);
  }

  async createShare(data: { id: string; mount_id: number; path: string; password: string | null; expire_at: number | null }): Promise<void> {
    const row = { id: data.id, mount_id: data.mount_id, path: data.path, password: data.password, expire_at: data.expire_at, created_at: Date.now() };
    await this.kv.put("share:" + data.id, JSON.stringify(row));
  }

  async getShare(id: string): Promise<any | null> {
    const v = await this.kv.get("share:" + id);
    return v ? JSON.parse(v) : null;
  }
}

// 根据环境选择存储实现：有 D1 用 D1，否则用 KV。
export function getStore(env: Env): Store {
  if (env.DB && typeof (env.DB as any).prepare === "function") {
    return new D1Store(env.DB);
  }
  return new KvStore(env.KV);
}
