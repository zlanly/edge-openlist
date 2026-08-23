# 🌿 EdgeOpenList

把 [OpenList](https://doc.oplist.org/) 的核心能力搬上 **Cloudflare Worker**：多存储挂载、目录列表 / 预览 / 下载、文件管理、WebDAV、搜索、分享。后端 Hono + **D1（强制结构化存储）** + KV（令牌缓存）+ R2（可选落盘），前端 Vue3（温暖清新风），单仓库单部署。

> 免费档起步。受 CF 约束，**大文件上传走预签名/直传、下载永远流式、列表进 D1 缓存**，绝不缓冲整文件。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zlanly/edge-openlist)

## 架构

```
Browser (Vue3 SPA)
      │  REST / WebDAV
      ▼
Cloudflare Worker (Hono)
  ├─ Auth (JWT, PBKDF2)        ── D1(users)
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

应用**强制使用 D1** 作为结构化存储（用户 / 挂载 / 分享 / 文件索引）。为做到「部署时不需要任何绑定」，本仓库的 `wrangler.toml` **不声明任何 D1 / KV / R2 绑定**——先纯代码部署上线，部署完成后再到 Cloudflare 控制台逐个添加绑定即可生效。下面提供**全程在 Cloudflare 控制台（网页）操作**的部署教程，无需本地安装 Wrangler。

### 方式一：一键按钮（最简单）

点击仓库顶部的 **Deploy to Cloudflare Workers** 按钮 → 用 GitHub 授权登录 → 确认仓库与 Worker 名称 → 开始部署。Cloudflare 会自动克隆仓库并执行 `wrangler.toml` 里的 `[build]`（构建前端到 `web/dist`）后部署上线。**此步不需要创建任何 D1 / KV / R2 资源**，部署即可成功。

> 按钮部署后直接进入「方式二的 Step 2」继续添加绑定与变量。

### 方式二：在线控制台手动部署教程

> 全程在 https://dash.cloudflare.com 网页操作，不需要本地环境。

**Step 1 · 创建 Worker 并部署代码**
1. 左侧菜单 **Workers & Pages** → 右上角 **Create** → 选择 **Create Worker**。
2. 给 Worker 起名（如 `edge-openlist`），点 **Deploy**（先用默认 Hello World 占位也行，下一步会被仓库代码覆盖）。
3. 进入该 Worker 详情页 → **Settings → Build → 绑定 Git 仓库**（或 **Deployations → Connect Git**），选择你的 GitHub 仓库 `zlanly/edge-openlist`，分支 `main`，构建命令留空（仓库 `wrangler.toml` 的 `[build]` 会自动构建前端）。保存并触发一次部署。
4. 等待部署完成（日志出现 `Uploaded edge-openlist` / `Success`）。此时 Worker 已上线，但因尚无 D1 绑定，访问会提示「未检测到 D1 数据库绑定」——这是预期内的，下一步修复。

**Step 2 · 添加变量 / Secrets（JWT + 初始化密钥）**
1. Worker 详情页 → **Settings → Variables and Secrets**（或 **Variables**）。
2. 点 **Add** 添加以下 **Secret**（选 Secret 类型，不可读取，更安全）：
   - `JWT_SECRET`：值填 `openssl rand -hex 32` 生成的随机串（或任意 32+ 位随机值）。
3. 保存。添加变量会触发一次重新部署使其生效。

> 管理员初始化需要部署者配置一次性 Secret：请添加 `BOOTSTRAP_SECRET`，不要使用固定默认密码。初始化接口只接受受保护的 POST 请求，GET 页面不会创建账号。

初始化请求示例：
```bash
curl --fail-with-body -X POST "https://你的Worker子域.workers.dev/api/auth/setup" \\
  -H 'Content-Type: application/json' \\
  --data '{"username":"admin","password":"请替换为至少12位强密码","bootstrapSecret":"部署时配置的BOOTSTRAP_SECRET"}'
```

**Step 3 · 添加 D1 数据库绑定（必选，核心存储）**
1. 左侧菜单 **Storage & Databases → D1 SQL Database** → **Create** 创建一个数据库，名称 `edge-openlist`，记下它。
2. 回到 Worker 详情页 → **Settings → Bindings → Add → D1 Database Binding**。
3. 变量名（Variable name）填 **`DB`**（必须与代码一致），Database 选刚创建的 `edge-openlist`，保存。
4. 保存绑定同样会重新部署。

**Step 4 · 添加 KV 命名空间绑定（令牌缓存，必选）**
1. 左侧菜单 **Storage & Databases → KV** → **Create a namespace**，名称 `edge-openlist-kv`。
2. Worker 详情页 → **Settings → Bindings → Add → KV Namespace Binding**，变量名填 **`KV`**，选刚创建的命名空间，保存。

**Step 5 · 添加 R2 桶绑定（可选，仅 `r2` 驱动上传落盘需要）**
1. 左侧菜单 **Storage & Databases → R2** —— 若未启用 R2，按提示启用（免费额度通常够用）。
2. 创建桶 `edge-openlist`。
3. Worker 详情页 → **Settings → Bindings → Add → R2 Bucket Binding**，变量名填 **`R2`**，选该桶，保存。

> 绑定名务必为 `DB` / `KV` / `R2`，与代码一致；改完任一项绑定后控制台会自动重新部署。

**Step 6 · 初始化 D1 表**
Worker 在**首次收到请求时会自动执行 `CREATE TABLE IF NOT EXISTS`**（`worker/src/db/init.ts`，与迁移脚本幂等），所以通常无需手动迁移。若想显式建表，本地装好 Wrangler 后执行：
```bash
wrangler d1 migrations apply edge-openlist --remote   # 需先在 wrangler.toml 声明 [[d1_databases]]
```
（仅用控制台部署、不碰本地 wrangler.toml 时，可跳过此步，依赖运行时自动建表。）

**Step 7 · 创建管理员（仅首次，浏览器一步完成）**
有两种等价入口（任选其一）：
- **最省事**：直接访问首页 `https://你的Worker子域.workers.dev/`，登录页会自动出现「⚙️ 一键初始化管理员」按钮，点它即可。
- 或手动访问：`https://你的Worker子域.workers.dev/setup`（等价于 `/api/auth/setup`）。

页面会提示「初始化完成」，并自动创建默认管理员：**用户名 `admin` ／ 密码 `admin`**。
> 该路径**仅当系统尚无任何用户时**生效，重复访问安全（已存在用户会提示「已完成初始化」）。若尚未绑定 D1，页面会明确提示先去控制台加 `DB` 绑定，而不是报错。
> ⚠️ 默认密码过于简单，**登录后请立即点右上角「修改密码」改掉**。

随后用 `admin / admin` 登录前端即可挂载网盘。

### 验证
- 健康检查：`GET /api/health` → `{"ok":true,"title":"EdgeOpenList"}`
- 若未加 D1 绑定就访问，会返回清晰错误：「未检测到 D1 数据库绑定……请到 Cloudflare 控制台为 Worker 添加 D1 数据库绑定」，按 Step 3 处理即可。

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
- D1 强一致：用户 / 挂载 / 分享 / 文件索引存 D1（强制）；KV 仅用于驱动令牌缓存（最终一致）。
- 内存 128MB：所有文件一律流式，不缓冲整文件。

## 目录

```
worker/src/
  index.ts            Hono 入口 + 路由装配 + Cron 爬取
  types.ts            环境/接口类型
  util/auth.ts        JWT + PBKDF2
  db/store.ts         存储抽象（强制 D1 实现；未绑定 D1 时抛出明确错误）
  db/schema.ts        D1 封装（D1Store 委托对象）
  middleware/auth.ts  鉴权中间件
  drivers/            驱动抽象与各后端实现
  routes/             auth / mounts / fs / dav / share
web/src/              Vue3 前端（api.ts + App.vue + styles.css）
migrations/           D1 schema
```
