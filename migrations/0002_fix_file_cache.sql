-- 修复搜索索引：0001 的 file_cache 主键是 (mount_id, path)，但写入代码给每一行的
-- path 都绑了「所在目录」，导致同目录的记录互相 REPLACE，一个目录最终只留下 1 行，
-- 搜索几乎搜不到东西，而且搜到了也无法定位（path 是目录不是文件）。
--
-- file_cache 纯粹是缓存/索引，直接重建，不涉及任何用户数据。
DROP TABLE IF EXISTS file_cache;

CREATE TABLE file_cache (
  mount_id  INTEGER NOT NULL,
  path      TEXT NOT NULL,          -- 文件真实完整路径（挂载内）
  dir       TEXT NOT NULL,          -- 所在目录，供搜索结果一键跳转
  name      TEXT NOT NULL,
  size      INTEGER NOT NULL DEFAULT 0,
  is_dir    INTEGER NOT NULL DEFAULT 0,
  modified  INTEGER NOT NULL DEFAULT 0,
  etag      TEXT,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (mount_id, path)
);

CREATE INDEX IF NOT EXISTS idx_file_cache_name ON file_cache(name);
CREATE INDEX IF NOT EXISTS idx_file_cache_dir  ON file_cache(mount_id, dir);

-- 应用设置（用于持久化自动生成的 JWT 密钥等）
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
