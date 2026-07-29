// 鍚勪簯鐩橀┍鍔ㄧ殑鑷獙璇侊細鐢ㄥ唴瀛? KV 妯℃嫙 + 鍏ㄥ眬 fetch 妯℃嫙锛屾柇瑷�鍒楄〃瑙ｆ瀽 / 涓嬭浇鐩撮摼 / 浠ょ墝鍒锋柊 / 璺緞瑙ｆ瀽銆?
// 娉ㄦ剰锛氫粎楠岃瘉閫昏緫涓? API 浜や簰缁撴瀯锛岀湡瀹炶仈璋冮渶瀵瑰簲璐﹀彿鍑嵁銆?
import assert from "node:assert";
import { OneDriveDriver } from "../worker/src/drivers/onedrive";
import { GoogleDriveDriver } from "../worker/src/drivers/googledrive";
import { AliyunDriveDriver } from "../worker/src/drivers/aliyun";
import { QuarkDriveDriver } from "../worker/src/drivers/quark";
import { P115DriveDriver } from "../worker/src/drivers/p115";
import { WebDAVDriver } from "../worker/src/drivers/webdav";
// 新增移植驱动的测试
import { Pan115Driver } from "../worker/src/drivers/115";
import { BaiduNetdiskDriver } from "../worker/src/drivers/baidu_netdisk";
import { DropboxDriver } from "../worker/src/drivers/dropbox";
import { AzureBlobDriver } from "../worker/src/drivers/azure_blob";
import { VirtualDriver } from "../worker/src/drivers/virtual";
import { UrlTreeDriver } from "../worker/src/drivers/url_tree";
import { PikPakDriver } from "../worker/src/drivers/pikpak";
import { Pan123Driver } from "../worker/src/drivers/123";

// ---------- 鍐呭瓨 KV 妯℃嫙 ----------
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
const authLog: string[] = []; // 记录 Authorization 头，用于断言签名/Bearer
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------- 鍏ㄥ眬 fetch 妯℃嫙 ----------
(globalThis as any).fetch = async (url: string | URL, opts: any = {}) => {
  const u = String(url);
  requests.push(`${opts.method || "GET"} ${u}`);
  if (opts.headers && (opts.headers as any).Authorization) authLog.push((opts.headers as any).Authorization as string);
  // OneDrive 浠ょ墝
  if (u.includes("login.microsoftonline.com") && u.includes("token")) return json({ access_token: "od-token", refresh_token: "od-refresh", expires_in: 3600 });
  // OneDrive Graph
  if (u.includes("graph.microsoft.com")) {
    if (u.includes("createUploadSession")) return json({ uploadUrl: "https://up/od-session" });
    if (u.includes("/children")) return json({ value: [{ name: "a.txt", size: 10, lastModifiedDateTime: "2024-01-01T00:00:00Z" }, { name: "sub", folder: {} }] });
    return json({ name: "a.txt", size: 10, lastModifiedDateTime: "2024-01-01T00:00:00Z", "@microsoft.graph.downloadUrl": "https://dl/od-abc" });
  }
  // Google 浠ょ墝
  if (u.includes("oauth2.googleapis.com/token")) return json({ access_token: "gd-token", refresh_token: "gd-refresh", expires_in: 3600 });
  if (u.includes("googleapis.com")) {
    if (u.includes("alt=media")) return new Response("gdata");
    if (u.includes("/upload/drive")) return new Response(null, { status: 200, headers: { Location: "https://up/gd-session" } });
    // files?q= 瑙ｆ瀽锛圲RL 琚紪鐮侊紝鍏堣В鐮侊級
    const dec = decodeURIComponent(u);
    const m = dec.match(/name = "([^"]+)"/);
    const name = m ? m[1] : "";
    if (name === "Movies") return json({ files: [{ id: "m1" }] });
    if (name === "clip.mp4") return json({ files: [{ id: "f1" }] });
    // 鍒楃洰褰?
    return json({ files: [{ name: "child", mimeType: "application/vnd.google-apps.folder", size: "5", modifiedTime: "2024-01-01T00:00:00Z" }] });
  }
  // 闃块噷浜戠洏浠ょ墝
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
  // 澶稿厠
  if (u.includes("drive-pc.quark.cn")) {
    if (u.includes("/file/sort")) return json({ data: { list: [{ fid: "1", file_name: "q.mp4", file_size: "7", file_type: 1 }] } });
    if (u.includes("/file/download")) return json({ data: { download_url: "https://quark/dl" } });
  }
  // 115
  if (u.includes("webapi.115.com/files")) return json({ data: [{ cid: "1", n: "f.mp4", s: "9", t: "f", ico: "ico_video" }] });
  // 115 下载地址
  if (u.includes("proapi.115.com/3.0/files/download")) return json({ data: { url: "https://dl/115file" } });

  // 百度网盘：在线刷新 API（默认）
  if (u.includes("api.oplist.org/baiduyun/renewapi")) return json({ access_token: "bd-token", refresh_token: "bd-refresh", text: "" });
  // 百度网盘：列表 /xpan/file?method=list
  if (u.includes("pan.baidu.com/rest/2.0/xpan/file")) return json({ errno: 0, list: [
    { fs_id: 123, path: "/a.mp4", server_filename: "a.mp4", size: 99, isdir: 0, server_mtime: 1700000000, server_ctime: 1699999999 },
    { fs_id: 456, path: "/docs", server_filename: "docs", size: 0, isdir: 1, server_mtime: 1700000000 },
  ] });

  // Dropbox：refresh_token 换取 access_token
  if (u.includes("api.dropboxapi.com")) {
    if (u.includes("/oauth2/token")) return json({ access_token: "db-token", refresh_token: "db-refresh", expires_in: 3600 });
    if (u.includes("/2/files/list_folder")) return json({ entries: [
      { ".tag": "file", name: "note.txt", path_display: "/note.txt", size: 50, id: "id1", server_modified: "2024-01-01T00:00:00Z" },
      { ".tag": "folder", name: "photos", path_display: "/photos", id: "id2" },
    ], cursor: "c", has_more: false });
  }

  // Azure Blob：列表（comp=list）返回 XML
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

  // PikPak：token 刷新 + captcha + 列表
  if (u.includes("user.mypikpak.net/v1/auth/token")) return json({ access_token: "pk-token", refresh_token: "pk-refresh", sub: "pk-uid" });
  if (u.includes("user.mypikpak.net/v1/shield/captcha/init")) return json({ captcha_token: "pk-captcha" });
  if (u.includes("api-drive.mypikpak.net/drive/v1/files")) return json({ files: [
    { name: "movie.mp4", kind: "drive#file", size: "55", id: "f1", modified_time: "2024-01-01T00:00:00Z" },
    { name: "folderA", kind: "drive#folder", id: "d1" },
  ], next_page_token: "" });

  // 123 网盘：登录 + 列表
  if (u.includes("login.123pan.com/api/user/sign_in")) return json({ code: 200, data: { token: "t123" } });
  if (u.includes("yun.123pan.com/b/api/file/list/new")) return json({ code: 0, data: {
    InfoList: [
      { FileName: "a.mp4", FileId: 1, Type: 0, Size: "123", UpdateAt: "2024-01-01T00:00:00Z" },
      { FileName: "dir", FileId: 2, Type: 1, Size: "0", UpdateAt: "" },
    ], Next: "-1", Total: 2 } });
  // 閫氱敤涓嬭浇鐩撮摼
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
  console.log("  鉁?", name);
}

async function main() {
  // OneDrive
  await test("OneDrive 鍒楄〃瑙ｆ瀽锛堟枃浠?/鐩綍鍖哄垎锛?", async () => {
    const d = await mk(OneDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "a.txt");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 10);
    assert.equal(items[1].name, "sub");
    assert.equal(items[1].is_dir, true);
  });
  await test("OneDrive 浠ょ墝鍐欏叆 KV + 涓嬭浇鐩撮摼浠ｇ悊", async () => {
    const d = await mk(OneDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const res: any = await d.getContent("/a.txt");
    assert.equal(await res.text(), "filedata");
    assert.ok(kv.store.has("tok:1"), "浠ょ墝搴斿啓鍏? KV");
  });
  await test("OneDrive 涓婁紶浼氳瘽杩斿洖鐩翠紶 URL", async () => {
    const d = await mk(OneDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const s = await d.createUpload("/a.txt", 10);
    assert.equal(s.uploadUrl, "https://up/od-session");
  });

  // Google Drive
  await test("Google Drive 璺緞瑙ｆ瀽 + 鍒楄〃瑙ｆ瀽", async () => {
    const d = await mk(GoogleDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const items = await d.list("/Movies/clip.mp4");
    // 搴斿彂鐢熶袱娆¤矾寰勮В鏋愶紙Movies, clip.mp4锛?+ 涓�娆″垪鐩綍
    assert.ok(requests.some((r) => decodeURIComponent(r).includes('name = "Movies"')), "搴旇В鏋? Movies");
    assert.equal(items.length, 1);
    assert.equal(items[0].is_dir, true);
  });
  await test("Google Drive alt=media 涓嬭浇浠ｇ悊", async () => {
    const d = await mk(GoogleDriveDriver, { clientId: "c", clientSecret: "s", refreshToken: "rt" });
    const res: any = await d.getContent("/Movies/clip.mp4");
    assert.equal(await res.text(), "gdata");
  });

  // 闃块噷浜戠洏
  await test("闃块噷浜戠洏 鍒楄〃瑙ｆ瀽锛堟枃浠?/鐩綍锛?", async () => {
    const d = await mk(AliyunDriveDriver, { refreshToken: "rt" });
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 3);
    assert.equal(items[1].is_dir, true);
  });
  await test("闃块噷浜戠洏 涓嬭浇鐩撮摼浠ｇ悊", async () => {
    const d = await mk(AliyunDriveDriver, { refreshToken: "rt" });
    const res: any = await d.getContent("/vid.mp4");
    assert.equal(await res.text(), "filedata");
  });

  // 澶稿厠
  await test("澶稿厠 鍒楄〃瑙ｆ瀽锛坒ile_type 鍒ゅ畾鏂囦欢锛?", async () => {
    const d = await mk(QuarkDriveDriver, { cookie: "k=1" });
    const items = await d.list("/");
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "q.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 7);
  });

  // 115
  await test("115 列表解析（t 判定文件）", async () => {
    const d = await mk(P115DriveDriver, { cookie: "uid=1" });
    const items = await d.list("/");
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "f.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 9);
  });

  // ---------- 新增：刚移植驱动的列表解析 / 令牌刷新 / 下载代理 ----------
  // 115（新 Pan115Driver）：下载直链代理
  await test("115 下载直链代理（getContent 转发到上游）", async () => {
    const d = await mk(Pan115Driver, { cookie: "uid=1" }, 11);
    const res: any = await d.getContent("/f.mp4");
    assert.equal(await res.text(), "filedata");
    assert.ok(requests.some((r) => r.includes("proapi.115.com/3.0/files/download")), "应请求 115 下载地址接口");
  });

  // 百度网盘：列表解析 + 令牌写入 KV
  await test("百度网盘 列表解析（server_filename/isdir）+ 令牌写入 KV", async () => {
    const d = await mk(BaiduNetdiskDriver, { refreshToken: "rt" }, 2);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "a.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 99);
    assert.equal(items[1].name, "docs");
    assert.equal(items[1].is_dir, true);
    assert.ok(kv.store.has("tok:2"), "刷新令牌应写入 KV");
  });

  // Dropbox：列表解析（POST list_folder，entries[].tag/.size/path_display）+ 令牌写入 KV
  await test("Dropbox 列表解析（.tag 判定目录）+ 令牌写入 KV", async () => {
    const d = await mk(DropboxDriver, { client_id: "c", client_secret: "s", refresh_token: "rt" }, 3);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "note.txt");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 50);
    assert.equal(items[1].name, "photos");
    assert.equal(items[1].is_dir, true);
    assert.ok(requests.some((r) => r.includes("/2/files/list_folder")), "应 POST list_folder");
    assert.ok(kv.store.has("tok:3"), "刷新令牌应写入 KV");
  });

  // Azure Blob：列表 XML 解析 + SharedKey 签名头
  await test("Azure Blob 列表 XML 解析（BlobPrefix/Blob）+ SharedKey 签名头", async () => {
    const d = await mk(AzureBlobDriver, { endpoint: "myacct", container_name: "mycontainer", access_key: "dGVzdGtleQ==" }, 4);
    const items = await d.list("/");
    const dir = items.find((i) => i.name === "docs");
    const file = items.find((i) => i.name === "root.mp4");
    assert.ok(dir && dir.is_dir, "docs 应为目录");
    assert.ok(file && !file.is_dir && file.size === 20, "root.mp4 应为文件且 size=20");
    assert.ok(requests.some((r) => r.includes("restype=container") && r.includes("comp=list")), "应为 list 接口");
    assert.ok(authLog.some((h) => h.startsWith("SharedKey ")), "应带 SharedKey 签名头");
  });

  // Virtual：内联 tree 列表解析
  await test("Virtual 内联 tree 列表解析", async () => {
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
    assert.ok(items.some((i) => i.name === "file.txt" && !i.is_dir), "file.txt 应为文件");
    assert.ok(items.some((i) => i.name === "sub" && i.is_dir), "sub 应为目录");
    const inner = await d.list("/sub");
    assert.equal(inner.length, 1);
    assert.equal(inner[0].name, "inner.txt");
  });

  // UrlTree：文本树列表解析
  await test("UrlTree 文本树列表解析（缩进层级 + 文件信息）", async () => {
    const d = await mk(UrlTreeDriver, {
      url_structure: "movies:\n  clip.mp4:1024:https://dl/clip.mp4\nreadme.txt:https://dl/readme.txt",
    }, 6);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.ok(items.some((i) => i.name === "movies" && i.is_dir), "movies 应为目录");
    const readme = items.find((i) => i.name === "readme.txt");
    assert.ok(readme && !readme.is_dir && readme.size === 0, "readme.txt 应为文件");
    const movies = await d.list("/movies");
    assert.equal(movies.length, 1);
    assert.equal(movies[0].name, "clip.mp4");
    assert.equal(movies[0].size, 1024);
  });

  // PikPak：OAuth 刷新 + 列表解析 + 令牌写入 KV
  await test("PikPak 令牌刷新 + 列表解析（kind 判定目录）+ 令牌写入 KV", async () => {
    const d = await mk(PikPakDriver, { refresh_token: "rt" }, 7);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "movie.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 55);
    assert.equal(items[1].name, "folderA");
    assert.equal(items[1].is_dir, true);
    assert.ok(requests.some((r) => r.includes("/v1/auth/token")), "应刷新 token");
    assert.ok(kv.store.has("tok:7"), "令牌应写入 KV");
  });

  // 123 网盘：登录 + 列表解析 + 令牌写入 KV
  await test("123 网盘 登录 + 列表解析（Type 判定目录）+ 令牌写入 KV", async () => {
    const d = await mk(Pan123Driver, { username: "u", password: "p" }, 8);
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "a.mp4");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 123);
    assert.equal(items[1].name, "dir");
    assert.equal(items[1].is_dir, true);
    assert.ok(requests.some((r) => r.includes("login.123pan.com/api/user/sign_in")), "应先登录");
    assert.ok(kv.store.has("tok:8"), "令牌应写入 KV");
  });

  // WebDAV
  await test("WebDAV 列表 XML 解析", async () => {
    const d = await mk(WebDAVDriver, { endpoint: "https://dav.example.com", username: "u", password: "p" });
    const items = await d.list("/");
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "file.txt");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 11);
    assert.equal(items[1].name, "folder");
    assert.equal(items[1].is_dir, true);
  });
  await test("WebDAV 代理上传（流式转发到上游）", async () => {
    const d = await mk(WebDAVDriver, { endpoint: "https://dav.example.com", username: "u", password: "p" });
    requests.length = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello-webdav"));
        c.close();
      },
    });
    await d.putContent!("/file.txt", stream as any, "text/plain");
    assert.ok(requests.includes("PUT-BODY-RECEIVED"), "Worker 应将请求体转发到 WebDAV 上游");
  });

  // 阿里云盘分片上传代理
  await test("阿里云盘 分片上传（create→PUT 分片→complete）", async () => {
    const d = await mk(AliyunDriveDriver, { refreshToken: "rt" });
    requests.length = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello-aliyun"));
        c.close();
      },
    });
    await d.putContent!("/up.mp4", stream as any, "application/octet-stream", 12);
    assert.ok(requests.some((r) => r.includes("v2/file/create")), "应创建文件条目");
    assert.ok(requests.some((r) => r.startsWith("PUT https://ali/part")), "应 PUT 上传分片");
    assert.ok(requests.some((r) => r.includes("v2/file/complete")), "应完成上传");
  });

  console.log(`\n全部 ${passed} 项自验证通过 ?`);
}

main().catch((e) => {
  console.error("娴嬭瘯澶辫触锛?", e);
  process.exit(1);
});
