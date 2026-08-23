# 🌿 EdgeOpenList

把 [OpenList](https://doc.oplist.org/) 的核心能力搬上 **Cloudflare Worker**：多网盘挂载、目录列表 / 预览 / 下载、文件管理、WebDAV、搜索、分享。后端 Hono + D1 + KV，前端 Vue3，单仓库单部署，免费档起步。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zlanly/edge-openlist)

## 功能一览

- ✅ 84 个网盘驱动开箱可用：阿里云盘、夸克、115、百度、123、天翼、OneDrive、Google Drive、Dropbox、PikPak 等
- ✅ 挂载管理页面按驱动自动渲染配置表单，支持 OAuth 一键授权（OneDrive / Google Drive 等）
- ✅ 目录浏览、图片 / 视频 / 音频在线预览、流式下载、上传、移动 / 重命名 / 删除
- ✅ 全局搜索（D1 索引 + 每日后台爬取）、公开分享（密码 + 过期）、WebDAV（兼容 rclone / Infuse）
- ✅ JWT 登录、管理员管理挂载，密钥自动生成并加密落库，无需手工配置

## 在线部署（全程浏览器操作，无需本地环境）

只需要一个 Cloudflare 账号（免费）。数据库会在首次访问时自动建表，**部署过程中不需要执行任何命令**。

### 方式一：一键部署按钮（最简单）

1. 点击仓库顶部的 **Deploy to Cloudflare Workers** 按钮，用 GitHub 授权登录。
2. 确认仓库与 Worker 名称，点击部署。Cloudflare 会自动构建并上线。
3. 部署成功后，继续下面「添加存储绑定」一节。

### 方式二：控制台手动部署

**第 1 步 · 创建 Worker 并关联本仓库**

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com)，左侧菜单 **Workers & Pages** → 右上角 **Create** → **Create Worker**。
2. 给 Worker 起名（如 `edge-openlist`），先点 **Deploy** 创建。
3. 进入该 Worker 详情页 → **Settings → Build**（或 **Deployments → Connect Git**），绑定 GitHub 仓库 `zlanly/edge-openlist`，分支 `main`，构建命令留空（仓库已内置自动构建），保存并触发一次部署。

**第 2 步 · 创建 D1 数据库并绑定（必选）**

1. 左侧菜单 **Storage & Databases → D1 SQL Database** → **Create**，名称随意（如 `edge-openlist`）。
2. 回到 Worker 详情页 → **Settings → Bindings → Add → D1 Database Binding**。
3. 变量名必须填 **`DB`**，Database 选刚创建的数据库，保存。

**第 3 步 · 创建 KV 并绑定（推荐，OAuth 网盘需要）**

1. 左侧菜单 **Storage & Databases → KV** → **Create a namespace**，名称随意（如 `edge-openlist-kv`）。
2. Worker 详情页 → **Settings → Bindings → Add → KV Namespace Binding**，变量名必须填 **`KV`**，选刚创建的命名空间，保存。

**第 4 步 · 初始化管理员账号**

1. 打开你的 Worker 地址（`https://<Worker 名>.<账户子域>.workers.dev`）。
2. 登录页下方会出现「首次使用？点此初始化管理员账号」，点击后设置管理员用户名和密码（至少 12 位）即可完成初始化。
3. 用刚设置的账号登录，进入「挂载管理」添加网盘。

> 初始化入口仅在系统还没有任何账号时开放，初始化完成后自动关闭。
> 若打开提示「尚未绑定 D1」，说明第 2 步的绑定未生效，回到控制台检查绑定名是否为 `DB`。

## 常见问题

**Q：部署后访问页面提示「尚未绑定 D1」？**
按第 2 步添加 D1 绑定（变量名必须是 `DB`）。保存绑定后控制台会自动重新部署，稍等片刻再访问。

**Q：需要配置密钥吗？**
不需要。登录密钥首次启动时自动生成并存入 D1。如果你希望给初始化入口额外加一道钥匙，可在 **Settings → Variables and Secrets** 添加 Secret `BOOTSTRAP_SECRET`，之后初始化页面会要求填写它。

**Q：忘记密码怎么办？**
打开控制台 **Storage & Databases → D1**，进入你的数据库 → **Console** 标签，执行 `DELETE FROM users;`，然后重新访问 `/setup` 初始化新账号（挂载数据不受影响）。

**Q：如何验证部署成功？**
访问 `https://<你的域名>/api/health`，返回 `{"ok":true,...}` 即正常。

## 约束与限制（免费档）

- 所有文件流式处理，不缓冲整文件；大文件上传请优先使用支持预签名直传的存储（R2 / S3 / Azure Blob 等）。
- 部分网盘（189 个人版、115 等）的上传受平台加密协议限制，仅支持列表 / 下载，界面会明确提示。

## 驱动覆盖

<details>
<summary>点击展开完整驱动列表</summary>

**中文网盘**：百度网盘、百度相册、115、123 网盘、天翼云盘、139 云盘、沃家云盘、腾讯微云、WPS 云文档、中国移动云盘、又拍云、阿里云盘、阿里文档、豆包、联想 NAS 分享、网易云音乐、超星、蓝奏云、夸克、迅雷云盘、Terabox。

**国际网盘 / 对象存储**：R2、S3 兼容、WebDAV、OneDrive、Google Drive / Photo、Dropbox、PikPak、Yandex、MediaFire、Azure Blob、Bunny、Seafile、Degoo、Misskey、KodBox、Cloudreve、GitHub、IPFS、Teambition 等。

**元 / 虚拟驱动**：虚拟目录、别名、自动索引、URL 树、STRM、分块聚合，以及 **AES-256 加密层**（与 rclone crypt 密文互通）。

**边缘不可行项（诚实标注）**：halalcloud（gRPC）、mega、proton_drive 无法在 Worker 上实现，代码中显式报错；115 / 189 个人版仅支持列表与下载；本地 / FTP / SMB 类不在覆盖范围。

</details>
