# 🌿 EdgeOpenList

把 [OpenList](https://doc.oplist.org/) 的核心能力搬上 **Cloudflare Worker**：多存储挂载、目录列表 / 预览 / 下载、文件管理、WebDAV、搜索、分享。后端 Hono + D1 + KV + R2，前端 Vue3（温暖清新风），单仓库单部署。

> 免费档起步。受 CF 约束，**大文件上传走预签名/直传、下载永远流式、列表进 KV/D1 缓存**，绝不缓冲整文件。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zlanly/edge-openlist)

## 架构

```
Browser (Vue3 SPA)
      │  REST / WebDAV
      ▼
Cloudflare Worker (Hono)
  ├─ Auth (JWT, PBKDF2)        ── D1(users) + KV(session)
  ├─ FS 路由 (/api/fs/*)       ── 驱动抽象
  ├─ WebDAV (/dav/:mount/*)    ── 驱动抽象
  ├─ 搜索 (/api/fs/search)     ── D1 file_cache 索引
  ├─ 分享 (/s/:id)             ── D1 shares
  └─ OAuth (/api/oauth/:p/*)   ── OneDrive / Google Drive 授权回调（令牌存 KV）
        │
   Storage Drivers（统一接口）
   r2 · s3 · webdav · 80+ 远程网盘驱动（见下文「驱动覆盖」）
```

## 已实现

- ✅ 多存储挂载（D1 配置，强一致）
- ✅ R2 / S3 兼容驱动：列表、Range 预览（视频/图片）、流式下载、文件管理（增删改/移动）、**预签名直传**
- ✅ WebDAV（PROPFIND/GET/PUT/DELETE/MKCOL/MOVE + OPTIONS/LOCK 占位），兼容 rclone / Infuse
- ✅ 搜索（列表写入 D1 索引 + 每日 Cron 后台爬取建索引）
- ✅ 公开分享（密码 + 过期）
- ✅ 鉴权（JWT + PBKDF2，管理员挂载管理）
- ✅ 自研 Vue3 前端（温暖清新风）
- ✅ **OAuth 网盘**：OneDrive（Graph API + 刷新令牌存 KV）、Google Drive（路径解析为 fileId + 可续传会话）
- ✅ **国内网盘**：阿里云盘（refresh_token + 分片直传代理）、夸克网盘（cookie）、115 网盘（cookie）
- ✅ **前端动态配置表单**：`GET /api/mounts/drivers` 返回各驱动字段 schema（key/类型/必填/帮助），挂载管理按字段类型（文本/密码/下拉/布尔/多行）自动渲染，84 个驱动开箱可用
- ✅ **交互式 OAuth 授权**：onedrive / onedrive_app / googledrive / google_photo / dropbox / pikpak / yandex_disk / aliyundrive_open 支持「启动授权」——弹出平台登录页，回调自动换令牌并存 KV（同时回写 `refresh_token` 到挂载配置）

## 驱动覆盖（全部移植自 OpenList 真实源码）

我们把 OpenList（`github.com/OpenListTeam/OpenList`）的**全部远程网盘 API 驱动**逐一定制移植到本项目的统一 `Driver` 接口，端点 / 参数 / 响应解析 / 上传流程均对照其 Go 源码核实，而非凭记忆拼凑。

### 中文网盘（cookie / token / OAuth）
百度网盘 `baidu_netdisk`、百度相册 `baidu_photo`、115（`115` / `115_open` / `115_share`）、123 网盘（`123` / `123_link` / `123_open` / `123_share`）、天翼云盘（`189` / `189pc` / `189tv`）、139 云盘 `139`、沃家云盘 `wopan`、腾讯微云 `weiyun`、WPS 云文档 `wps`、中国移动云盘 `mopan`、又拍云 `uss`、阿里云盘（`aliyun` / `aliyundrive_open` / `aliyundrive_share`）、阿里文档 `alidoc`、豆包（`doubao` / `doubao_new` / `doubao_share`）、Febb `febbox`、联想 NAS 分享 `lenovonas_share`、网易云音乐 `netease_music`、超星 `chaoxing`、ilanzou / 蓝奏云 `lanzou`、夸克（`quark` / `quark_open` / `quark_uc` / `quark_uc_tv`）、迅雷云盘（`thunder` / `thunder_browser` / `thunderx`）、Terabox `terabox`。

### 国际网盘 / 对象存储（OAuth / SigV4 / SharedKey）
OneDrive（`onedrive` / `onedrive_app` / `onedrive_sharelink`）、Google（`googledrive` / `google_photo`）、Dropbox `dropbox`、PikPak（`pikpak` / `pikpak_share`）、Yandex `yandex_disk`、MediaFire `mediafire`、Azure Blob `azure_blob`、Bunny `bunny_storage`、Seafile `seafile`、Degoo `degoo`、Misskey `misskey`、KodBox `kodbox`、Cloudreve（`cloudreve` / `cloudreve_v4`）、GitHub（`github` / `github_releases`）、CNB `cnb_releases`、IPFS `ipfs_api`、Teambition `teambition`、TelDrive `teldrive`、MediaTrack `mediatrack`、挂载其它实例（`alist_v3` / `openlist` / `openlist_share`）。

### 元 / 虚拟驱动
`virtual`（内联文件树）、`strm`（.strm 流文件）、`autoindex`（自动索引）、`url_tree`（URL 树）、`template`（通用范本）、`alias`（别名挂载另一挂载）、`crypt`（AES-256 流式加解密层，**与 rclone crypt 密文互通**：scrypt 密钥派生 + NaCl secretbox 内容加密 + EME(AES-256) 文件名加密）、`chunk`（分块到多后端）。

### 边缘不可行项（诚实标注，未伪造）
以下驱动在 Cloudflare Worker 上**确实无法实现**，已在代码中显式报错而非假装可用：
- `halalcloud` / `halalcloud_open`：走 gRPC / CID 分片寻址，Worker 无 gRPC 支持。
- `mega`：需 AES-ECB 链路加密 + RSA 模幂握手，WebCrypto 不支持对应原语，协议过重。
- `proton_drive`：依赖 `go-proton-api` / `gopenpgp`（SRP-6a + OpenPGP + AES-GCM 分块），无 TS 等价实现。
- `115` **上传**：依赖外部 Go SDK（ECDH 握手 + 阿里 OSS 分片），HTTP 契约无法重构；**列表 / 下载可用**。
- `189` 个人版**上传**：需 RSAES-PKCS1-v1.5 加密（WebCrypto 仅 OAEP/PSS），**列表 / 下载可用**。
- 本地 / 局域网类（`local` / `ftp` / `sftp` / `smb`）：需服务端文件系统或 TCP 套接字，边缘无；属非网盘类，不在覆盖范围内。

> 说明：部分驱动（如 189pc/189tv/139/quark/123/Degoo 等）上传需先算整文件 MD5/SHA1 校验和，会触发整文件缓冲，受 Worker 内存约束——大文件上传请优先使用支持预签名直传的后端（R2/S3/Azure/Bunny 等）。


## 本地开发

```bash
npm install                 # 安装 worker + web 依赖（workspaces）
npm run dev:web             # 前端 dev（http://localhost:5173）
npm run dev:worker          # wrangler dev（本地 miniflare，含 D1/KV/R2）
npm run typecheck           # worker 类型检查
npm run build:web           # 构建前端到 web/dist
```

## 部署

> **一键部署（推荐）**：点击顶部 **Deploy to Cloudflare Workers** 按钮 → 授权 → 确认资源名。Cloudflare 会自动：克隆仓库 → **构建前端（vite → `web/dist`，由 `wrangler.toml` 的 `[build]` 保证，对默认 `npx wrangler deploy` 也生效）** → **创建并绑定 D1 / KV / R2（自动回填 ID）** → 部署。D1 表结构在 Worker **首次请求时自动创建**（`db/init.ts` 的 `CREATE TABLE IF NOT EXISTS`，与 `wrangler d1 migrations apply` 幂等），无需手动跑迁移。
>
> 部署完成后还需两步才能用：
> 1. 到 Cloudflare 控制台 **Workers → 设置 → 变量** 把 `JWT_SECRET`、`BOOTSTRAP_SECRET` 改成 `openssl rand -hex 32` 生成的随机值（默认值是占位符，存在安全风险）。
> 2. 创建管理员（仅首次，无用户时）：
>    ```bash
>    curl "https://你的域名/api/auth/bootstrap?secret=你的BOOTSTRAP_SECRET&username=admin&password=你的密码"
>    ```

手动部署：

```bash
# 1. 创建绑定资源
wrangler d1 create edge-openlist
wrangler kv namespace create edge-openlist-kv
wrangler r2 bucket create edge-openlist

# 2. 把 ids 填进 wrangler.toml 的 database_id / id / bucket_name
# 3. dashboard 设置变量 JWT_SECRET、BOOTSTRAP_SECRET（或写进 .dev.vars）
npm run build:web          # 先构建前端
npm run deploy             # 跑 D1 迁移 + 部署

# 4. 创建管理员（仅首次，无用户时）
curl "https://你的域名/api/auth/bootstrap?secret=你的BOOTSTRAP_SECRET&username=admin&password=你的密码"
```

## 驱动配置字段

在「挂载管理」中按驱动填写 `config`（JSON）：

| 驱动 | 字段 |
|---|---|
| `r2` | `prefix`（可选，桶内根前缀） |
| `s3` | `endpoint` `region` `bucket` `accessKeyId` `secretAccessKey` `prefix?` `pathStyle?` |
| `webdav` | `endpoint` `username` `password` `prefix?` |
| `onedrive` | `clientId` `clientSecret` `redirectUri`（默认 `https://<域名>/api/oauth/onedrive/callback`）；首次授权走 `/api/oauth/onedrive/start`，令牌自动刷新增量存 KV |
| `googledrive` | `clientId` `clientSecret` `redirectUri`（默认 `https://<域名>/api/oauth/googledrive/callback`）；首次授权走 `/api/oauth/googledrive/start` |
| `aliyun` | `refreshToken`（阿里云盘开放平台 / 抓包获取）；上传走分片直传代理 |
| `quark` | `cookie`（夸克网盘网页端 cookie，含 `cookie_token` 等） |
| `p115` | `cookie`（115 网盘网页端 cookie，含 `UID` / `CID` / `SEID` 等） |

> OAuth 网盘（onedrive / googledrive）的 `redirectUri` 需与对应开放平台后台登记一致；回调由 Worker 内置 `/api/oauth/:provider/callback` 处理，自动 `saveTokens` 到 KV（`tok:<mountId>`）。国内网盘（aliyun / quark / p115）上传为 best-effort，依赖平台风控，需真实设备/账号验证。

## 约束与限制（免费档）

- CPU 10ms/请求：重目录解析靠缓存与分页；大计算需升付费档。
- 请求体 100MB：R2 走预签名直传；WebDAV 经 Worker 流式代理（≤100MB）。
- KV 最终一致：挂载配置存 D1，不依赖 KV 读后写。
- 内存 128MB：所有文件一律流式，不缓冲整文件。

## 目录

```
worker/src/
  index.ts            Hono 入口 + 路由装配 + Cron 爬取
  types.ts            环境/接口类型
  util/auth.ts        JWT + PBKDF2
  db/schema.ts        D1 封装
  middleware/auth.ts  鉴权中间件
  drivers/            驱动抽象与各后端实现
  routes/             auth / mounts / fs / dav / share
web/src/              Vue3 前端（api.ts + App.vue + styles.css）
migrations/           D1 schema
```
