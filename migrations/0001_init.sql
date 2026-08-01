-- EdgeOpenList 初始 schema
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
  created_at    INTEGER NOT NULL
);

-- 挂载配置（强一致，读写同请求安全）
CREATE TABLE IF NOT EXISTS mounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  driver      TEXT NOT NULL,          -- r2 | s3 | webdav | onedrive | googledrive | aliyun | quark | p115
  config_json TEXT NOT NULL,          -- 驱动私有配置（已脱敏，token 存 KV）
  root        TEXT NOT NULL DEFAULT '/',
  `order`     INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- 文件元数据缓存 / 搜索索引
CREATE TABLE IF NOT EXISTS file_cache (
  mount_id  INTEGER NOT NULL,
  path      TEXT NOT NULL,
  name      TEXT NOT NULL,
  size      INTEGER NOT NULL DEFAULT 0,
  is_dir    INTEGER NOT NULL DEFAULT 0,
  modified  INTEGER NOT NULL DEFAULT 0,
  etag      TEXT,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (mount_id, path)
);
CREATE INDEX IF NOT EXISTS idx_file_cache_name ON file_cache(mount_id, name);

-- 分享链接
CREATE TABLE IF NOT EXISTS shares (
  id         TEXT PRIMARY KEY,        -- 分享 token
  mount_id   INTEGER NOT NULL,
  path       TEXT NOT NULL,
  password   TEXT,                    -- 空表示无密码
  expire_at  INTEGER,                 -- 空表示永久
  created_at INTEGER NOT NULL
);

-- 首次部署后，用以下语句创建默认管理员（密码请自行生成哈希，建完请立即改密）：
-- INSERT INTO users (username, password_hash, role, created_at)
-- VALUES ('admin', '<由脚本生成>', 'admin', unixepoch());
-- 更简单：部署后浏览器访问一次 /api/auth/setup 即创建 admin/admin（见 routes/auth.ts）
