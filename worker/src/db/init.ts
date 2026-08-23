import type { Env } from "../types";

// 运行时自动建表：覆盖「Deploy 按钮未执行 CLI 迁移」的场景（例如按钮沿用默认的
// `npx wrangler deploy` 而非 package.json 的 deploy 脚本）。D1 自动供给后会拿到空库，
// 首次请求时这里用 CREATE TABLE IF NOT EXISTS 把表建好，应用即可直接使用；
// 与 `wrangler d1 migrations apply` 完全幂等、可并存。
// 与 migrations/*.sql 保持同步。
const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    driver      TEXT NOT NULL,
    config_json TEXT NOT NULL,
    root        TEXT NOT NULL DEFAULT '/',
    \`order\`     INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS shares (
    id         TEXT PRIMARY KEY,
    mount_id   INTEGER NOT NULL,
    path       TEXT NOT NULL,
    password   TEXT,
    expire_at  INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

// file_cache 单独处理：老版本的表缺少 dir 列，且 path 列存的是目录路径（错误数据）。
// 它纯粹是缓存/索引，直接重建最干净，不会丢任何用户数据。
const FILE_CACHE_DDL = `CREATE TABLE IF NOT EXISTS file_cache (
    mount_id  INTEGER NOT NULL,
    path      TEXT NOT NULL,
    dir       TEXT NOT NULL,
    name      TEXT NOT NULL,
    size      INTEGER NOT NULL DEFAULT 0,
    is_dir    INTEGER NOT NULL DEFAULT 0,
    modified  INTEGER NOT NULL DEFAULT 0,
    etag      TEXT,
    cached_at INTEGER NOT NULL,
    PRIMARY KEY (mount_id, path)
  )`;

const FILE_CACHE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_file_cache_name ON file_cache(name)`,
  `CREATE INDEX IF NOT EXISTS idx_file_cache_dir ON file_cache(mount_id, dir)`,
];

async function migrateFileCache(db: D1Database): Promise<void> {
  let hasDir = false;
  let exists = false;
  try {
    const { results } = await db.prepare("PRAGMA table_info(file_cache)").all<{ name: string }>();
    exists = !!results && results.length > 0;
    hasDir = (results ?? []).some((r) => r.name === "dir");
  } catch {
    exists = false;
  }
  if (exists && !hasDir) {
    // 旧结构：丢弃重建（旧数据本身就是坏的 —— 每个目录只存下了一行）
    await db.prepare("DROP TABLE file_cache").run();
  }
  await db.prepare(FILE_CACHE_DDL).run();
  for (const sql of FILE_CACHE_INDEXES) await db.prepare(sql).run();
}

const initPromises = new WeakMap<D1Database, Promise<void>>();

export function initDb(env: Env): Promise<void> {
  if (!env.DB || typeof (env.DB as any).prepare !== "function") return Promise.resolve();
  const db = env.DB as D1Database;
  const existing = initPromises.get(db);
  if (existing) return existing;
  const task = (async () => {
    for (const sql of STATEMENTS) await db.prepare(sql).run();
    await migrateFileCache(db);
  })().catch((e) => {
    initPromises.delete(db);
    throw e;
  });
  initPromises.set(db, task);
  return task;
}
