// 各云盘驱动的自验证：用内�? KV 模拟 + 全局 fetch 模拟，断言列表解析 / 下载直链 / 令牌刷新 / 路径解析�?
// 注意：仅验证逻辑�? API 交互结构，真实联调需对应账号凭据�?
import assert from "node:assert";
import { createHash as _ch } from "node:crypto";
import { OneDriveDriver } from "../worker/src/drivers/onedrive";
import { GoogleDriveDriver } from "../worker/src/drivers/googledrive";
import { AliyunDriveDriver } from "../worker/src/drivers/aliyun";
import { AliyundriveOpenDriver } from "../worker/src/drivers/aliyundrive_open";
import { QuarkDriveDriver } from "../worker/src/drivers/quark";
import { P115DriveDriver } from "../worker/src/drivers/p115";
import { WebDAVDriver } from "../worker/src/drivers/webdav";
// ������ֲ�����Ĳ���
import { Pan115Driver } from "../worker/src/drivers/115";
import { BaiduNetdiskDriver } from "../worker/src/drivers/baidu_netdisk";
import { DropboxDriver } from "../worker/src/drivers/dropbox";
import { AzureBlobDriver } from "../worker/src/drivers/azure_blob";
import { VirtualDriver } from "../worker/src/drivers/virtual";
import { UrlTreeDriver } from "../worker/src/drivers/url_tree";
import { PikPakDriver } from "../worker/src/drivers/pikpak";
import { PikPakShareDriver } from "../worker/src/drivers/pikpak_share";
import { md5, parsePikPakResponse } from "../worker/src/drivers/pikpak-common";
import { Pan123Driver } from "../worker/src/drivers/123";
import { TeraboxDriver } from "../worker/src/drivers/terabox";

// ---------- 内存 KV 模拟 ----------
class KVMock {
  store = new Map<string, string>();
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.store.set(k, v);
  }
}
const kv = new KVMock();
const env: any = { KV: kv, R2: {}, DB: {}, ASSETS: {}, JWT_SECRET: "x", APP_TITLE: "t" };

const requests: string[] = [];
const pikpakBodies: any[] = [];
const tbChunkMd5 = _ch("md5").update("hello-terabox").digest("hex");
const authLog: string[] = []; // ��¼ Authorization ͷ�����ڶ���ǩ��/Bearer
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------- 全局 fetch 模拟 ----------
(globalThis as any).fetch = async (url: string | URL, opts: any = {}) => {
  const u = String(url);
  requests.push(`${opts.method || "GET"} ${u}`);
  if (opts.headers && (opts.headers as any).Authorization) authLog.push((opts.headers as any).Authorization as string);
  // OneDrive 令牌
  if (u.includes("login.microsoftonline.com") && u.includes("token")) return json({ access_token: "od-token", refresh_token: "od-refresh", expires_in: 3600 });
  // OneDrive Graph
  if (u.includes("graph.microsoft.com")) {
    if (u.includes("createUploadSession")) return json({ uploadUrl: "https://up/od-session" });
    if (u.includes("/children")) return json({ value: [{ name: "a.txt", size: 10, lastModifiedDateTime: "2024-01-01T00:00:00Z" }, { name: "sub", folder: {} }] });
    return json({ name: "a.txt", size: 10, lastModifiedDateTime: "2024-01-01T00:00:00Z", "@microsoft.graph.downloadUrl": "https://dl/od-abc" });
  }
  // Google 令牌
  if (u.includes("oauth2.googleapis.com/token")) return json({ access_token: "gd-token", refresh_token: "gd-refresh", expires_in: 3600 });
  if (u.includes("googleapis.com")) {
    if (u.includes("alt=media")) return new Response("gdata");
    if (u.includes("/upload/drive")) return new Response(null, { status: 200, headers: { Location: "https://up/gd-session" } });
    // files?q= 解析（URL 被编码，先解码；URLSearchParams 会把空格编成 +，一并还原）
    const dec = decodeURIComponent(u).replaceAll("+", " ");
    const m = dec.match(/name = "([^"]+)"/);
    const name = m ? m[1] : "";
    if (name === "Movies") return json({ files: [{ id: "m1" }] });
    if (name === "clip.mp4") return json({ files: [{ id: "f1" }] });
    // 快捷方式（「添加到我的云端硬盘」的共享条目）
    if (name === "SharedDir") return json({ files: [{ id: "sc1", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "tgt1", targetMimeType: "application/vnd.google-apps.folder" } }] });
    if (name === "link.mp4") return json({ files: [{ id: "sc2", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "tgt9", targetMimeType: "video/mp4" } }] });
    // 根目录列表：含指向文件夹/文件的快捷方式
    if (dec.includes("'root' in parents")) {
      return json({ files: [
        { name: "SharedDir", mimeType: "application/vnd.google-apps.shortcut", size: "0", modifiedTime: "2024-01-01T00:00:00Z", shortcutDetails: { targetId: "tgt1", targetMimeType: "application/vnd.google-apps.folder" } },
        { name: "link.mp4", mimeType: "application/vnd.google-apps.shortcut", size: "0", modifiedTime: "2024-01-01T00:00:00Z", shortcutDetails: { targetId: "tgt9", targetMimeType: "video/mp4" } },
      ] });
    }
    // 快捷方式目标目录的内容
    if (dec.includes("'tgt1' in parents")) return json({ files: [{ name: "inner.mp4", mimeType: "video/mp4", size: "9", modifiedTime: "2024-01-01T00:00:00Z" }] });
    // 列目�?
    return json({ files: [{ name: "child", mimeType: "application/vnd.google-apps.folder", size: "5", modifiedTime: "2024-01-01T00:00:00Z" }] });
  }
  // 阿里云盘开放平台令牌与接口
  if (u.includes("openapi.alipan.com/oauth/access_token")) return json({ access_token: "ali-open-token", refresh_token: "ali-open-refresh", expires_in: 7200 });
  if (u.includes("openapi.alipan.com/adrive/v1.0/user/getDriveInfo")) return json({ default_drive_id: "drive1", resource_drive_id: "drive1" });
  if (u.includes("openapi.alipan.com/adrive/v1.0/openFile/list")) {
    const requestBody = opts.body ? JSON.parse(opts.body) : {};
    const marker = requestBody.marker || "";
    return json({ items: marker ? [{ name: "b", type: "file", size: "4", file_id: "b1" }] : [{ name: "a", type: "file", size: "3", updated_at: "2024-01-01T00:00:00Z", file_id: "a1" }, { name: "d", type: "folder", file_id: "d1" }], next_marker: marker ? "" : "next" });
  }
  if (u.includes("openapi.alipan.com/adrive/v1.0/openFile/create")) {
    return json({ file_id: "new-open", upload_id: "upload-open", part_info_list: [{ part_number: 1, upload_url: "https://ali-open/part1" }] });
  }
  if (u.includes("openapi.alipan.com/adrive/v1.0/openFile/complete")) return json({});
  if (u.startsWith("https://ali-open/part")) return new Response(null, { status: 200 });
  if (u.includes("auth.aliyundrive.com")) return json({ access_token: "ali-token", refresh_token: "ali-refresh", expires_in: 7200, default_drive_id: "drive1" });
  if (u.includes("api.aliyundrive.com")) {
    if (u.includes("get_by_path")) return json({ file_id: "f1" });
    if (u.includes("/file/list")) return json({ items: [{ name: "a", type: "file", size: "3", updated_at: "2024-01-01T00:00:00Z", file_id: "a1" }, { name: "d", type: "folder", size: "0", updated_at: "", file_id: "d1" }] });
    if (u.includes("get_download_url")) return json({ url: "https://ali/dl" });
    if (u.includes("/file/create")) return json({ file_id: "new", upload_id: "u1", part_info_list: [{ part_number: 1, upload_url: "https://ali/part1" }] });
    if (u.includes("/file/complete")) return json({});
  }
  if (u.startsWith("https://ali/part")) return new Response(null, { status: 200 });
  if (u.startsWith("https://dav.example.com")) {
    if (opts.method === "PROPFIND") {
      return new Response(
        `<?xml version="1.0"?><multistatus xmlns="DAV:">
        <response><href>/</href><propstat><prop><displayname>.</displayname><resourcetype><collection/></resourcetype></prop></propstat></response>
        <response><href>/file.txt</href><propstat><prop><displayname>file.txt</displayname><getcontentlength>11</getcontentlength><getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</getlastmodified></prop></propstat></response>
        <response><href>/folder</href><propstat><prop><displayname>folder</displayname><resourcetype><collection/></resourcetype></prop></propstat></response>
        </multistatus>`,
        { status: 207, headers: { "content-type": "application/xml" } }
      );
    }
    if (opts.method === "PUT") {
      requests.push("PUT-BODY-RECEIVED");
      return new Response(null, { status: 201 });
    }
  }
  // 夸克
  if (u.includes("drive-pc.quark.cn")) {
    if (u.includes("/file/sort")) return json({ data: { list: [{ fid: "1", file_name: "q.mp4", file_size: "7", file_type: 1 }] } });
    if (u.includes("/file/download")) return json({ data: { download_url: "https://quark/dl" } });
  }
  // 115
  if (u.includes("webapi.115.com/files")) return json({ data: [{ cid: "1", n: "f.mp4", s: "9", t: "f", ico: "ico_video" }] });
  // 115 ���ص�ַ
  if (u.includes("proapi.115.com/3.0/files/download")) return json({ data: { url: "https://dl/115file" } });

  // �ٶ����̣�����ˢ�� API��Ĭ�ϣ�
  if (u.includes("api.oplist.org/baiduyun/renewapi")) return json({ access_token: "bd-token", refresh_token: "bd-refresh", text: "" });
  // �ٶ����̣��б� /xpan/file?method=list
  if (u.includes("pan.baidu.com/rest/2.0/xpan/file")) return json({ errno: 0, list: [
    { fs_id: 123, path: "/a.mp4", server_filename: "a.mp4", size: 99, isdir: 0, server_mtime: 1700000000, server_ctime: 1699999999 },
    { fs_id: 456, path: "/docs", server_filename: "docs", size: 0, isdir: 1, server_mtime: 1700000000 },
  ] });

  // Dropbox��refresh_token ��ȡ access_token
  if (u.includes("api.dropboxapi.com")) {
    if (u.includes("/oauth2/token")) return json({ access_token: "db-token", refresh_token: "db-refresh", expires_in: 3600 });
    if (u.includes("/2/files/list_folder")) return json({ entries: [
      { ".tag": "file", name: "note.txt", path_display: "/note.txt", size: 50, id: "id1", server_modified: "2024-01-01T00:00:00Z" },
      { ".tag": "folder", name: "photos", path_display: "/photos", id: "id2" },
    ], cursor: "c", has_more: false });
  }

  // Azure Blob���б���comp=list������ XML
  if (u.includes("blob.core.windows.net") && u.includes("restype=container") && u.includes("comp=list")) {
    return new Response(
      `<?xml version="1.0"?><EnumerationResults><Blobs>
        <BlobPrefix><Name>docs/</Name></BlobPrefix>
        <Blob><Name>docs/a.txt</Name><Properties><Content-Length>10</Content-Length><Last-Modified>Mon, 01 Jan 2024 00:00:00 GMT</Last-Modified></Properties></Blob>
        <Blob><Name>root.mp4</Name><Properties><Content-Length>20</Content-Length><Last-Modified>Mon, 01 Jan 2024 00:00:00 GMT</Last-Modified></Properties></Blob>
      </Blobs></EnumerationResults>`,
      { status: 200, headers: { "content-type": "application/xml" } }
    );
  }

  // PikPak：token、captcha、个人盘和分享盘
  if (u.includes("user.mypikpak.net/v1/shield/captcha/init") || u.includes("user.mypikpak.net/v1/auth/signin") || u.includes("user.mypikpak.net/v1/auth/token")) {
    if (opts.body) pikpakBodies.push(typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body);
  }
  if (u.includes("user.mypikpak.net/v1/auth/token")) return json({ access_token: "pk-token", refresh_token: "pk-refresh", sub: "pk-uid" });
  if (u.includes("user.mypikpak.net/v1/auth/signin")) return json({ access_token: "pk-login-token", refresh_token: "pk-login-refresh", sub: "pk-uid" });
  if (u.includes("user.mypikpak.net/v1/shield/captcha/init")) return json({ captcha_token: "pk-captcha" });
  if (u.includes("api-drive.mypikpak.net/drive/v1/share?") && u.includes("share_id=share1")) return json({ pass_code_token: "pk-pass" });
  if (u.includes("api-drive.mypikpak.net/drive/v1/share/detail")) return json({ share_status: "OK", files: [
    { name: "shared.mp4", kind: "drive#file", size: "55", id: "sf1", modified_time: "2024-01-01T00:00:00Z" },
    { name: "shared-dir", kind: "drive#folder", id: "sd1" },
  ], next_page_token: "" });
  if (u.includes("api-drive.mypikpak.net/drive/v1/share/file_info")) return json({ file_info: { web_content_link: "https://dl/pikpak-share" } });
  if (u.includes("api-drive.mypikpak.net/drive/v1/files")) return json({ files: [
    { name: "movie.mp4", kind: "drive#file", size: "55", id: "f1", modified_time: "2024-01-01T00:00:00Z" },
    { name: "folderA", kind: "drive#folder", id: "d1" },
  ], next_page_token: "" });
  // 123 ���̣���¼ + �б�
  if (u.includes("login.123pan.com/api/user/sign_in")) return json({ code: 200, data: { token: "t123" } });
  if (u.includes("yun.123pan.com/b/api/file/list/new")) return json({ code: 0, data: {
    InfoList: [
      { FileName: "a.mp4", FileId: 1, Type: 0, Size: "123", UpdateAt: "2024-01-01T00:00:00Z" },
      { FileName: "dir", FileId: 2, Type: 1, Size: "0", UpdateAt: "" },
    ], Next: "-1", Total: 2 } });
  // Terabox：jsToken 自愈链路
  if (u.includes("terabox.com/api/check/login")) {
    const js = new URL(u).searchParams.get("jsToken") || "";
    if (js === "tb-fresh" || js === "tb-home" || js === "tb-cookie") return json({ errno: 0 });
    // 这类 Cookie 模拟「错误响应体里不带新令牌」，逼驱动走首页提取
    if (((opts.headers as any)?.Cookie || "").includes("noBodyToken")) return json({ errno: 450016 });
    return json({ errno: 4000023, jsToken: "tb-fresh" });
  }
  if (u.includes("terabox.com/api/list")) {
    return json({ errno: 0, list: [{ server_filename: "t.mp4", size: 5, isdir: 0, server_mtime: 1700000000, fs_id: 1 }] });
  }
  if (u.includes("-data.terabox.com/rest/2.0/pcs/file") && u.includes("method=locateupload")) {
    return json({ host: "c-jp-data.terabox.com" });
  }
  if (u.includes("terabox.com/api/precreate")) return json({ errno: 0, uploadid: "tb-up1", return_type: 1 });
  if (u.includes("terabox.com/rest/2.0/pcs/superfile2")) return json({ md5: tbChunkMd5 });
  if (u.includes("terabox.com/api/create")) return json({ errno: 0 });
  if (u.includes("terabox.com/api/home/info")) return json({ errno: 0, data: { sign1: "s1", sign3: "s3" } });
  if (u.includes("terabox.com/api/download")) return json({ errno: 0, dlink: [{ dlink: "https://dl-terabox/file" }] });
  if (u.startsWith("https://dl-terabox/file")) {
    const ck = String(((opts.headers as any) || {}).Cookie || "");
    if (ck.includes("BDUSS")) requests.push("DL-COOKIE-SENT");
    return new Response("tb-filedata");
  }

  // 首页 HTML：只含备选样式（未编码）的令牌注入，验证多模式提取
  if (u === "https://jp.terabox.com" || u === "https://www.terabox.com") {
    return new Response('<html>window.jsToken = "tb-home"</html>', {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }

  // 通用下载直链
  if (u.startsWith("https://dl/") || u.startsWith("https://ali/dl") || u.startsWith("https://quark/dl")) return new Response("filedata");
  return json({ error: "unmocked", url: u }, 404);
};

async function mk(DriverCtor: any, cfg: any, mountId = 1) {
  const d = new DriverCtor();
  d.use(env);
  cfg._mountId = mountId;
  await d.init(cfg);
  return d;
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  requests.length = 0;
  authLog.length = 0;
  await fn();
  passed++;
  console.log("  �?", name);
}

async function main() {
  // OneDrive
  await test("OneDrive 列表解析（文�?/目录区分�?", async () => {
    const d = await mk(OneDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "a.txt");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 10);
    assert.equal(items[1].name, "sub");
    assert.equal(items[1].is_dir, true);
  });
  await test("OneDrive 令牌写入 KV + 下载直链代理", async () => {
    const d = await mk(OneDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const res: any = await d.getContent("/a.txt");
    assert.equal(await res.text(), "filedata");
    assert.ok(kv.store.has("tok:1"), "令牌应写�? KV");
  });
  await test("OneDrive 上传会话返回直传 URL", async () => {
    const d = await mk(OneDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const s = await d.createUpload("/a.txt", 10);
    assert.equal(s.uploadUrl, "https://up/od-session");
  });

  // Google Drive
  await test("Google Drive 路径解析 + 列表解析", async () => {
    const d = await mk(GoogleDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const items = await d.list("/Movies/clip.mp4");
    // 应发生两次路径解析（Movies, clip.mp4�?+ 一次列目录
    assert.ok(requests.some((r) => decodeURIComponent(r).includes('name = "Movies"')), "应解�? Movies");
    assert.equal(items.length, 1);
    assert.equal(items[0].is_dir, true);
  });
  await test("Google Drive alt=media 下载代理", async () => {
    const d = await mk(GoogleDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const res: any = await d.getContent("/Movies/clip.mp4");
    assert.equal(await res.text(), "gdata");
  });
  await test("Google Drive 快捷方式解析到共享目标（不再下载 HTML 存根）", async () => {
    const d = await mk(GoogleDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    // 列表中快捷方式按目标定性：指向文件夹 → 目录；指向文件 → 文件；etag 记录目标 ID
    const root = await d.list("/");
    assert.equal(root.length, 2);
    assert.equal(root[0].name, "SharedDir");
    assert.equal(root[0].is_dir, true, "指向文件夹的快捷方式应当作目录");
    assert.equal(root[0].etag, "tgt1");
    assert.equal(root[1].is_dir, false);
    assert.equal(root[1].etag, "tgt9");
    // 进入快捷方式目录：路径解析必须跟随到目标 ID，列的是共享目标的内容
    const inner = await d.list("/SharedDir");
    assert.ok(requests.some((r) => decodeURIComponent(r).replaceAll("+", " ").includes("'tgt1' in parents")), "应解析到快捷方式目标 tgt1 再列目录");
    assert.equal(inner.length, 1);
    assert.equal(inner[0].name, "inner.mp4");
    // 下载快捷方式文件：作用于目标文件，而不是快捷方式存根
    const res: any = await d.getContent("/link.mp4");
    assert.equal(await res.text(), "gdata");
    assert.ok(requests.some((r) => r.includes("files/tgt9") && r.includes("alt=media")), "应下载快捷方式指向的目标文件");
  });

  // 阿里云盘开放驱动
  await test("阿里云盘开放驱动分页列表与开放 API 刷新", async () => {
    const d = await mk(AliyundriveOpenDriver, { refresh_token: "rt", use_online_api: false, client_id: "cid", client_secret: "sec" }, 21);
    const items = await d.list("/");
    assert.equal(items.length, 3);
    assert.equal(items[0].name, "a");
    assert.equal(items[1].is_dir, true);
    assert.equal(items[2].name, "b");
    assert.ok(requests.some((r) => r.includes("openFile/list")), "应调用开放平台列表接口");
    assert.ok(kv.store.has("tok:21"), "开放平台令牌应写入 KV");
  });
  await test("阿里云盘开放驱动拒绝超出声明大小的上传", async () => {
    const d = await mk(AliyundriveOpenDriver, { refresh_token: "rt", use_online_api: false, client_id: "cid", client_secret: "sec" }, 22);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("too-large")); c.close(); } });
    await assert.rejects(() => d.putContent("/up.mp4", stream as any, "application/octet-stream", 1), /超过声明的文件大小/);
  });

  // 阿里云盘
  await test("阿里云盘 列表解析（文�?/目录�?", async () => {
    const d = await mk(AliyunDriveDriver, { refreshToken: "rt" });
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 3);
    assert.equal(items[1].is_dir, true);
  });
  await test("阿里云盘 下载直链代理", async () => {
    const d = await mk(AliyunDriveDriver, { refreshToken: "rt" });
    const res: any = await d.getContent("/vid.mp4");
    assert.equal(await res.text(), "filedata");
  });

  // 夸克
  await test("夸克 列表解析（file_type 判定文件�?", async () => {
    const d = await mk(QuarkDriveDriver, { cookie: "k=1" });
    const items = await d.list("/");
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "q.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 7);
  });

  // 115
  await test("115 �б�������t �ж��ļ���", async () => {
    const d = await mk(P115DriveDriver, { cookie: "uid=1" });
    const items = await d.list("/");
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "f.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 9);
  });

  // ---------- ����������ֲ�������б����� / ����ˢ�� / ���ش��� ----------
  // 115���� Pan115Driver��������ֱ������
  await test("115 ����ֱ��������getContent ת�������Σ�", async () => {
    const d = await mk(Pan115Driver, { cookie: "uid=1" }, 11);
    const res: any = await d.getContent("/f.mp4");
    assert.equal(await res.text(), "filedata");
    assert.ok(requests.some((r) => r.includes("proapi.115.com/3.0/files/download")), "Ӧ���� 115 ���ص�ַ�ӿ�");
  });

  // �ٶ����̣��б����� + ����д�� KV
  await test("�ٶ����� �б�������server_filename/isdir��+ ����д�� KV", async () => {
    const d = await mk(BaiduNetdiskDriver, { refreshToken: "rt" }, 2);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "a.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 99);
    assert.equal(items[1].name, "docs");
    assert.equal(items[1].is_dir, true);
    assert.ok(kv.store.has("tok:2"), "ˢ������Ӧд�� KV");
  });

  // Dropbox���б�������POST list_folder��entries[].tag/.size/path_display��+ ����д�� KV
  await test("Dropbox �б�������.tag �ж�Ŀ¼��+ ����д�� KV", async () => {
    const d = await mk(DropboxDriver, { client_id: "c", client_secret: "s", refresh_token: "rt" }, 3);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "note.txt");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 50);
    assert.equal(items[1].name, "photos");
    assert.equal(items[1].is_dir, true);
    assert.ok(requests.some((r) => r.includes("/2/files/list_folder")), "Ӧ POST list_folder");
    assert.ok(kv.store.has("tok:3"), "ˢ������Ӧд�� KV");
  });

  // Azure Blob���б� XML ���� + SharedKey ǩ��ͷ
  await test("Azure Blob �б� XML ������BlobPrefix/Blob��+ SharedKey ǩ��ͷ", async () => {
    const d = await mk(AzureBlobDriver, { endpoint: "myacct", container_name: "mycontainer", access_key: "dGVzdGtleQ==" }, 4);
    const items = await d.list("/");
    const dir = items.find((i) => i.name === "docs");
    const file = items.find((i) => i.name === "root.mp4");
    assert.ok(dir && dir.is_dir, "docs ӦΪĿ¼");
    assert.ok(file && !file.is_dir && file.size === 20, "root.mp4 ӦΪ�ļ��� size=20");
    assert.ok(requests.some((r) => r.includes("restype=container") && r.includes("comp=list")), "ӦΪ list �ӿ�");
    assert.ok(authLog.some((h) => h.startsWith("SharedKey ")), "Ӧ�� SharedKey ǩ��ͷ");
  });

  // Virtual������ tree �б�����
  await test("Virtual ���� tree �б�����", async () => {
    const d = await mk(VirtualDriver, {
      tree: {
        is_dir: true,
        children: {
          "file.txt": { content: "hello" },
          sub: { is_dir: true, children: { "inner.txt": { content: "world" } } },
        },
      },
    }, 5);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.ok(items.some((i) => i.name === "file.txt" && !i.is_dir), "file.txt ӦΪ�ļ�");
    assert.ok(items.some((i) => i.name === "sub" && i.is_dir), "sub ӦΪĿ¼");
    const inner = await d.list("/sub");
    assert.equal(inner.length, 1);
    assert.equal(inner[0].name, "inner.txt");
  });

  // UrlTree���ı����б�����
  await test("UrlTree �ı����б������������㼶 + �ļ���Ϣ��", async () => {
    const d = await mk(UrlTreeDriver, {
      url_structure: "movies:\n  clip.mp4:1024:https://dl/clip.mp4\nreadme.txt:https://dl/readme.txt",
    }, 6);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.ok(items.some((i) => i.name === "movies" && i.is_dir), "movies ӦΪĿ¼");
    const readme = items.find((i) => i.name === "readme.txt");
    assert.ok(readme && !readme.is_dir && readme.size === 0, "readme.txt ӦΪ�ļ�");
    const movies = await d.list("/movies");
    assert.equal(movies.length, 1);
    assert.equal(movies[0].name, "clip.mp4");
    assert.equal(movies[0].size, 1024);
  });

  // PikPak��OAuth ˢ�� + �б����� + ����д�� KV
  await test("PikPak ����ˢ�� + �б�������kind �ж�Ŀ¼��+ ����д�� KV", async () => {
    const d = await mk(PikPakDriver, { refresh_token: "rt" }, 7);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "movie.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 55);
    assert.equal(items[1].name, "folderA");
    assert.equal(items[1].is_dir, true);
    assert.ok(requests.some((r) => r.includes("/v1/auth/token")), "Ӧˢ�� token");
    assert.ok(kv.store.has("tok:7"), "����Ӧд�� KV");
  });

  // 123 ���̣���¼ + �б����� + ����д�� KV
  await test("PikPak MD5 使用标准小端摘要", async () => {
    assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
    assert.equal(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  });

  await test("PikPak 非 JSON 错误不会被当成空成功", async () => {
    await assert.rejects(
      () => parsePikPakResponse<any>(new Response("<html>blocked</html>", { status: 403 }), "列表"),
      /非 JSON.*403/,
    );
  });

  await test("PikPak root_folder_id 作为个人盘根目录并缓存文件 ID", async () => {
    const d = await mk(PikPakDriver, { refresh_token: "rt", root_folder_id: "d1" }, 73);
    const items = await d.list("/");
    assert.equal(items[0].path, "/movie.mp4");
    assert.ok(requests.some((r) => r.includes("parent_id=d1")), "应使用配置的根目录 ID");
    const before = requests.filter((r) => r.includes("/drive/v1/files")).length;
    await d.get("/movie.mp4");
    const after = requests.filter((r) => r.includes("/drive/v1/files")).length;
    assert.equal(after, before, "已列出的文件应命中路径 ID 缓存");
  });

  await test("PikPak share 按 platform 生成 captcha 并解析分享目录", async () => {
    const d = await mk(PikPakShareDriver, { share_id: "share1", platform: "android" }, 71);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "shared.mp4");
    assert.equal(items[1].is_dir, true);
    assert.ok(requests.some((r) => r.includes("share/detail")), "应请求分享目录");
  });

  await test("PikPak 无 refresh_token 时可用账号密码登录", async () => {
    pikpakBodies.length = 0;
    const d = await mk(PikPakDriver, { platform: "pc", username: "user", password: "pass" }, 72);
    await d.list("/");
    assert.ok(requests.some((r) => r.includes("/v1/auth/signin?client_id=YvtoWO6GNHiuCl7x")), "应使用 pc client id 登录");
    assert.ok(pikpakBodies.some((b) => b.client_id === "YvtoWO6GNHiuCl7x" && b.client_secret), "登录应携带对应客户端凭据");
    assert.ok(kv.store.has("tok:72"), "登录令牌应写入 KV");
  });

  await test("123 ���� ��¼ + �б�������Type �ж�Ŀ¼��+ ����д�� KV", async () => {
    const d = await mk(Pan123Driver, { username: "u", password: "p" }, 8);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "a.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 123);
    assert.equal(items[1].name, "dir");
    assert.equal(items[1].is_dir, true);
    assert.ok(requests.some((r) => r.includes("login.123pan.com/api/user/sign_in")), "Ӧ�ȵ�¼");
    assert.ok(kv.store.has("tok:8"), "����Ӧд�� KV");
  });

  // WebDAV
  await test("WebDAV �б� XML ����", async () => {
    const d = await mk(WebDAVDriver, { endpoint: "https://dav.example.com", username: "u", password: "p" });
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "file.txt");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 11);
    assert.equal(items[1].name, "folder");
    assert.equal(items[1].is_dir, true);
  });
  await test("WebDAV �����ϴ�����ʽת�������Σ�", async () => {
    const d = await mk(WebDAVDriver, { endpoint: "https://dav.example.com", username: "u", password: "p" });
    requests.length = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello-webdav"));
        c.close();
      },
    });
    await d.putContent!("/file.txt", stream as any, "text/plain");
    assert.ok(requests.includes("PUT-BODY-RECEIVED"), "Worker Ӧ��������ת���� WebDAV ����");
  });

  // �������̷�Ƭ�ϴ�����
  await test("�������� ��Ƭ�ϴ���create��PUT ��Ƭ��complete��", async () => {
    const d = await mk(AliyunDriveDriver, { refreshToken: "rt" });
    requests.length = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello-aliyun"));
        c.close();
      },
    });
    await d.putContent!("/up.mp4", stream as any, "application/octet-stream", 12);
    assert.ok(requests.some((r) => r.includes("v2/file/create")), "Ӧ�����ļ���Ŀ");
    assert.ok(requests.some((r) => r.startsWith("PUT https://ali/part")), "Ӧ PUT �ϴ���Ƭ");
    assert.ok(requests.some((r) => r.includes("v2/file/complete")), "Ӧ����ϴ�");
  });

  // Terabox：jsToken 自愈
  await test("Terabox 从错误响应体直接恢复 jsToken（列表可用）", async () => {
    const d = await mk(TeraboxDriver, { cookie: "BDUSS=x" }, 50);
    const items = await d.list("/");
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "t.mp4");
    const sess = kv.store.get("terabox:sess:50") || "";
    assert.ok(sess.includes("tb-fresh"), "恢复到的新令牌应写入会话缓存");
  });
  await test("Terabox 直接用 Cookie 自带的 jsToken（无需抓首页）", async () => {
    const d = await mk(TeraboxDriver, { cookie: "noBodyToken=1; jsToken=tb-cookie" }, 52);
    const items = await d.list("/");
    assert.equal(items.length, 1);
    const sess = kv.store.get("terabox:sess:52") || "";
    assert.ok(sess.includes("tb-cookie"), "Cookie 自带的令牌应写入会话缓存");
    assert.ok(!requests.includes("GET https://jp.terabox.com"), "令牌来自 Cookie 时不应再抓首页");
  });
  await test("Terabox 响应体无令牌时从首页备选样式提取（不再整挂载瘫痪）", async () => {
    const d = await mk(TeraboxDriver, { cookie: "noBodyToken=1" }, 51);
    const items = await d.list("/");
    assert.equal(items.length, 1);
    const sess = kv.store.get("terabox:sess:51") || "";
    assert.ok(sess.includes("tb-home"), "首页提取到的令牌应写入会话缓存");
  });
  await test("Terabox 下载直链附带 Cookie（修复 need verify）", async () => {
    const d = await mk(TeraboxDriver, { cookie: "noBodyToken=1; jsToken=tb-cookie; BDUSS=x" }, 52);
    requests.length = 0;
    const res: any = await d.getContent("/t.mp4");
    assert.equal(await res.text(), "tb-filedata");
    assert.ok(requests.includes("DL-COOKIE-SENT"), "直链请求必须附带 Cookie，否则上游回 need verify");
  });
  await test("Terabox 上传链路（locateupload→precreate→分片→create）", async () => {
    const d = await mk(TeraboxDriver, { cookie: "BDUSS=x" }, 50);
    requests.length = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello-terabox"));
        c.close();
      },
    });
    await d.putContent!("/错题.docx", stream as any, "application/octet-stream", 13);
    assert.ok(requests.some((r) => r.includes("method=locateupload")), "应定位上传域名");
    assert.ok(requests.some((r) => r.includes("/api/precreate")), "应预创建文件");
    assert.ok(requests.some((r) => r.includes("/rest/2.0/pcs/superfile2")), "应上传分片");
    assert.ok(requests.some((r) => r.includes("/api/create")), "应提交文件");
  });


  console.log(`\nȫ�� ${passed} ������֤ͨ�� ?`);
}

main().catch((e) => {
  console.error("测试失败�?", e);
  process.exit(1);
});
