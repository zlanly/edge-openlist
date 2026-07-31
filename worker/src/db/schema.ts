import type { Env, MountRow, FileItem } from "../types";

// ---------- 挂载配置（D1，强一致） ----------

export async function listMounts(db: D1Database): Promise<MountRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM mounts WHERE enabled = 1 ORDER BY `order` ASC, id ASC")
    .all<MountRow>();
  return results ?? [];
}

export async function getMount(db: D1Database, id: number): Promise<MountRow | null> {
  return (await db.prepare("SELECT * FROM mounts WHERE id = ?").bind(id).first<MountRow>()) ?? null;
}

export async function getMountByName(db: D1Database, name: string): Promise<MountRow | null> {
  return (await db.prepare("SELECT * FROM mounts WHERE name = ?").bind(name).first<MountRow>()) ?? null;
}

// 管理后台列出所有挂载（含禁用项）
export async function listAllMounts(db: D1Database): Promise<MountRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM mounts ORDER BY `order` ASC, id ASC")
    .all<MountRow>();
  return results ?? [];
}

export async function createMount(
  db: D1Database,
  data: { name: string; driver: string; config_json: string; root: string; order: number }
): Promise<number> {
  const info = await db
    .prepare(
      "INSERT INTO mounts (name, driver, config_json, root, `order`, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)"
    )
    .bind(data.name, data.driver, data.config_json, data.root, data.order, Date.now())
    .run();
  return Number(info.meta.last_row_id);
}

export async function updateMount(
  db: D1Database,
  id: number,
  patch: Partial<{ name: string; driver: string; config_json: string; root: string; order: number; enabled: number }>
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (!sets.length) return;
  binds.push(id);
  await db.prepare(`UPDATE mounts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
}

export async function deleteMount(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM mounts WHERE id = ?").bind(id).run();
}

// ---------- 用户 ----------

export async function getUserByName(db: D1Database, username: string): Promise<{ id: number; username: string; password_hash: string; role: string } | null> {
  return (
    (await db
      .prepare("SELECT id, username, password_hash, role FROM users WHERE username = ?")
      .bind(username)
      .first<{ id: number; username: string; password_hash: string; role: string }>()) ?? null
  );
}

export async function createUser(
  db: D1Database,
  username: string,
  password_hash: string,
  role = "user"
): Promise<void> {
  await db
    .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
    .bind(username, password_hash, role, Date.now())
    .run();
}

export async function countUsers(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>();
  return r?.c ?? 0;
}

// ---------- 文件缓存 / 搜索索引 ----------

export async function upsertFileCache(db: D1Database, mountId: number, items: FileItem[], dirPath: string): Promise<void> {
  // 先清该目录下的旧记录，再批量写入
  const now = Date.now();
  await db.prepare("DELETE FROM file_cache WHERE mount_id = ? AND path = ?").bind(mountId, dirPath).run();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO file_cache (mount_id, path, name, size, is_dir, modified, etag, cached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const batch = items.map((it) =>
    stmt.bind(mountId, dirPath, it.name, it.size, it.is_dir ? 1 : 0, it.modified, it.etag ?? null, now)
  );
  if (batch.length) await db.batch(batch);
}

export async function searchFiles(db: D1Database, kw: string, limit = 200): Promise<any[]> {
  return (
    (await db
      .prepare("SELECT mount_id, path, name, size, is_dir, modified FROM file_cache WHERE name LIKE ? ORDER BY is_dir DESC, name ASC LIMIT ?")
      .bind(`%${kw}%`, limit)
      .all()
    ).results ?? []
  );
}

// ---------- 分享 ----------

export async function createShare(
  db: D1Database,
  data: { id: string; mount_id: number; path: string; password: string | null; expire_at: number | null }
): Promise<void> {
  await db
    .prepare("INSERT INTO shares (id, mount_id, path, password, expire_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(data.id, data.mount_id, data.path, data.password, data.expire_at, Date.now())
    .run();
}

export async function getShare(db: D1Database, id: string) {
  return (await db.prepare("SELECT * FROM shares WHERE id = ?").bind(id).first()) ?? null;
}

// 仅用于类型导出占位，避免未使用告警
export type _Env = Env;
