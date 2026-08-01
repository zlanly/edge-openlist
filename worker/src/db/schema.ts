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

const MOUNT_COLUMNS = new Set(["name", "driver", "config_json", "root", "order", "enabled"]);

export async function updateMount(
  db: D1Database,
  id: number,
  patch: Partial<{ name: string; driver: string; config_json: string; root: string; order: number; enabled: number }>
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // 白名单校验：键名会被拼进 SQL，必须杜绝任意标识符注入
    if (!MOUNT_COLUMNS.has(k)) continue;
    sets.push(`\`${k}\` = ?`);
    binds.push(v);
  }
  if (!sets.length) return;
  binds.push(id);
  await db.prepare(`UPDATE mounts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
}

export async function deleteMount(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM mounts WHERE id = ?").bind(id),
    // 挂载没了，它的索引与分享也一并清掉，避免搜索结果指向幽灵挂载
    db.prepare("DELETE FROM file_cache WHERE mount_id = ?").bind(id),
    db.prepare("DELETE FROM shares WHERE mount_id = ?").bind(id),
  ]);
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

export async function updateUserPassword(db: D1Database, id: number, password_hash: string): Promise<void> {
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(password_hash, id).run();
}

// ---------- 应用设置（键值） ----------

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  // INSERT OR IGNORE：并发首启时先写入者胜出，不覆盖已有值
  await db
    .prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, value, Date.now())
    .run();
}

// ---------- 文件缓存 / 搜索索引 ----------
//
// 原实现的致命缺陷：file_cache 主键是 (mount_id, path)，但写入时每一行的 path
// 都绑成了「所在目录」dirPath，于是同一目录的 N 条记录互相 REPLACE，
// 最终每个目录只剩最后 1 行 —— 搜索功能形同虚设，而且白白消耗 N 次 D1 写配额。
// 现在：path 存文件真实完整路径，另用 dir 列记录所在目录（供搜索结果跳转）。

/** 目录索引的新鲜期：10 分钟内重复浏览同一目录不再重写，保护 D1 免费档写配额。 */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** 单次批量写入的语句上限，避免超大目录撑爆 D1 batch。 */
const BATCH_LIMIT = 100;

export async function isCacheFresh(db: D1Database, mountId: number, dirPath: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT MAX(cached_at) AS t FROM file_cache WHERE mount_id = ? AND dir = ?")
    .bind(mountId, dirPath)
    .first<{ t: number | null }>();
  return !!r?.t && Date.now() - r.t < CACHE_TTL_MS;
}

export async function upsertFileCache(db: D1Database, mountId: number, items: FileItem[], dirPath: string): Promise<void> {
  const now = Date.now();
  // 先清该目录下的旧记录（含已被删除的文件），再写入当前快照
  await db.prepare("DELETE FROM file_cache WHERE mount_id = ? AND dir = ?").bind(mountId, dirPath).run();
  if (!items.length) return;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO file_cache (mount_id, path, dir, name, size, is_dir, modified, etag, cached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const all = items.map((it) =>
    stmt.bind(mountId, it.path, dirPath, it.name, it.size, it.is_dir ? 1 : 0, it.modified, it.etag ?? null, now)
  );
  for (let i = 0; i < all.length; i += BATCH_LIMIT) {
    await db.batch(all.slice(i, i + BATCH_LIMIT));
  }
}

/** 转义 LIKE 通配符，否则用户搜 "100%" 会匹配到所有文件。 */
function escapeLike(kw: string): string {
  return kw.replace(/[\\%_]/g, (c) => "\\" + c);
}

export async function searchFiles(db: D1Database, kw: string, limit = 200): Promise<any[]> {
  return (
    (await db
      .prepare(
        "SELECT mount_id, path, dir, name, size, is_dir, modified FROM file_cache " +
          "WHERE name LIKE ? ESCAPE '\\' ORDER BY is_dir DESC, name ASC LIMIT ?"
      )
      .bind(`%${escapeLike(kw)}%`, limit)
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

export async function listShares(db: D1Database, limit = 100): Promise<any[]> {
  return (
    (await db.prepare("SELECT * FROM shares ORDER BY created_at DESC LIMIT ?").bind(limit).all()).results ?? []
  );
}

export async function deleteShare(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM shares WHERE id = ?").bind(id).run();
}

// 仅用于类型导出占位，避免未使用告警
export type _Env = Env;
