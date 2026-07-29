import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { aesEcbEncrypt, bytesToHex, bytesToBase64, stringToBytes } from "../util/aes";

// ilanzou / 蓝奏云国际版（飞极盘）。Cookie(账号密码) 鉴权，mopan AES-ECB 签名，
// 上传走七牛(Qiniu) 直传。下载需 /file/redirect 二次跳转。
const CONF = {
  base: "https://apis.ilanzou.com",
  secret: "lanZouY-disk-app",
  bucket: "wpanstore-lanzou",
  unproved: "unproved",
  proved: "proved",
  devVersion: "125",
  site: "https://www.ilanzou.com",
};
const DEFAULT_PART_SIZE = 1024 * 1024 * 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ILanZouDriver extends CloudBase {
  readonly id = "ilanzou";
  private uuid = "";
  private token = "";
  private userId = "";
  private account = "";
  private idCache = new Map<string, string>();
  private secretBytes = stringToBytes(CONF.secret);

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private async loadState(): Promise<void> {
    const raw = await this.env.KV.get(`ilanzou:${this.mountId}`).catch(() => null);
    if (raw) {
      try {
        const s = JSON.parse(raw) as { uuid: string; token: string; userId: string; account: string };
        this.uuid = s.uuid || "";
        this.token = s.token || "";
        this.userId = s.userId || "";
        this.account = s.account || "";
      } catch { /* ignore */ }
    }
  }
  private async saveState(): Promise<void> {
    await this.env.KV.put(
      `ilanzou:${this.mountId}`,
      JSON.stringify({ uuid: this.uuid, token: this.token, userId: this.userId, account: this.account })
    ).catch(() => {});
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    await this.loadState();
    if (!this.uuid) {
      const j = await this.unprovedJson("/getUuid", "GET");
      this.uuid = j.uuid || "";
    }
    if (!this.token) await this.login();
    const map = await this.provedJson("/user/account/map", "GET");
    this.userId = String(map.map?.userId ?? "");
    this.account = String(map.map?.account ?? "");
    await this.saveState();
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Origin: CONF.site, Referer: CONF.site + "/", "Accept-Encoding": "gzip" };
  }

  private async login(): Promise<void> {
    const j = await this.unprovedJson("/login", "POST", {
      loginName: this.cfgStr("username"),
      loginPwd: this.cfgStr("password"),
    });
    this.token = j.data?.appToken || "";
    if (!this.token) throw new Error("ilanzou 登录失败: token 为空");
  }

  private async buildQuery(proved: boolean): Promise<string> {
    const ts = Date.now();
    const encTs = bytesToHex(await aesEcbEncrypt(stringToBytes(String(ts)), this.secretBytes));
    const p = [
      `uuid=${encodeURIComponent(this.uuid)}`,
      "devType=6",
      `devCode=${encodeURIComponent(this.uuid)}`,
      "devModel=chrome",
      `devVersion=${encodeURIComponent(CONF.devVersion)}`,
      "appVersion=",
      `timestamp=${encTs}`,
    ];
    if (proved) p.push(`appToken=${encodeURIComponent(this.token)}`);
    p.push("extra=2");
    return p.join("&");
  }

  private async request(pathname: string, method: string, proved: boolean, params?: Record<string, string>, body?: unknown): Promise<any> {
    const qs = await this.buildQuery(proved);
    let url = `${CONF.base}/${proved ? CONF.proved : CONF.unproved}${pathname}?${qs}`;
    if (params) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      url = u.toString();
    }
    const headers: Record<string, string> = await this.hdrs();
    if (this.cfgStr("ip")) headers["X-Forwarded-For"] = this.cfgStr("ip");
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
    const res = await fetch(url, init);
    const j = (await res.json()) as any;
    if (j.code !== 200) {
      if (!proved) throw new Error(`ilanzou ${j.code}: ${j.msg}`);
      if ((j.code === -1 || j.code === -2) && this.token) {
        await this.login();
        await this.saveState();
        return this.request(pathname, method, proved, params, body);
      }
      throw new Error(`ilanzou ${j.code}: ${j.msg}`);
    }
    return j;
  }

  private provedJson(pathname: string, method: string, body?: unknown): Promise<any> {
    return this.request(pathname, method, true, undefined, body);
  }
  private unprovedJson(pathname: string, method: string, body?: unknown): Promise<any> {
    return this.request(pathname, method, false, undefined, body);
  }

  private async resolveFolderId(path: string): Promise<string> {
    if (path === "/") return "0";
    if (this.idCache.has(path)) return this.idCache.get(path)!;
    const parts = path.split("/").filter(Boolean);
    let id = "0";
    let cur = "/";
    for (const p of parts) {
      cur = joinPath(cur, p);
      if (this.idCache.has(cur)) { id = this.idCache.get(cur)!; continue; }
      const items = await this.listByFolder(id);
      const it = items.find((i) => i.name === p && i.is_dir);
      if (!it) throw new Error(`ilanzou 目录不存在: ${cur}`);
      id = it.etag!;
      this.idCache.set(cur, id);
    }
    return id;
  }

  private async listByFolder(folderId: string): Promise<FileItem[]> {
    const out: FileItem[] = [];
    let offset = 1;
    for (;;) {
      const resp: any = await this.request("/record/file/list", "GET", true, {
        offset: String(offset), limit: "60", folderId, type: "0",
      });
      const list: any[] = resp.list || [];
      for (const f of list) {
        const isFolder = f.fileType === 2;
        const name = isFolder ? f.folderName : f.fileName;
        out.push({
          name,
          path: "",
          is_dir: isFolder,
          size: isFolder ? 0 : Number(f.fileSize || 0) * 1024,
          modified: Date.parse(f.updTime) || Date.now(),
          etag: isFolder ? String(f.folderId) : String(f.fileId),
        });
      }
      if (resp.offset < resp.totalPage) offset++; else break;
    }
    return out;
  }

  async list(path: string): Promise<FileItem[]> {
    const folderId = await this.resolveFolderId(path);
    const raw = await this.listByFolder(folderId);
    return raw.map((i) => ({ ...i, path: joinPath(path, i.name) }));
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error(`ilanzou 文件不存在: ${path}`);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const it = await this.get(path);
    if (it.is_dir) throw new Error("ilanzou 目录不可下载");
    const url = await this.buildRedirectUrl(it.etag!);
    const r = await fetch(url, { redirect: "manual", headers: await this.hdrs() });
    const loc = r.headers.get("location");
    if (!loc) throw new Error(`ilanzou 跳转失败: ${r.status}`);
    if (range) return fetch(loc, { headers: { Range: range } });
    return loc;
  }

  private async buildRedirectUrl(fileId: string): Promise<string> {
    const u = new URL(`${CONF.base}/${CONF.unproved}/file/redirect`);
    const ts = Date.now();
    const encTs = bytesToHex(await aesEcbEncrypt(stringToBytes(String(ts)), this.secretBytes));
    const p = [
      `uuid=${encodeURIComponent(this.uuid)}`,
      "devType=6",
      `devCode=${encodeURIComponent(this.uuid)}`,
      "devModel=chrome",
      `devVersion=${encodeURIComponent(CONF.devVersion)}`,
      "appVersion=",
      `timestamp=${encTs}`,
      `appToken=${encodeURIComponent(this.token)}`,
      "enable=1",
    ];
    const downloadId = bytesToHex(await aesEcbEncrypt(stringToBytes(`${fileId}|${this.userId}`), this.secretBytes));
    p.push(`downloadId=${encodeURIComponent(downloadId)}`);
    const auth = bytesToHex(await aesEcbEncrypt(stringToBytes(`${fileId}|${ts}`), this.secretBytes));
    p.push(`auth=${encodeURIComponent(auth)}`);
    u.search = p.join("&");
    return u.toString();
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 走 Worker 代理：七牛流式直传
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "ilanzou" } };
  }

  private buildQiniuMultipart(fields: Record<string, string>, file: ReadableStream<Uint8Array>, filename: string): { body: ReadableStream; contentType: string } {
    const enc = new TextEncoder();
    const boundary = "----edgeopenlistilanzou";
    const head = (() => {
      let s = "";
      for (const [k, v] of Object.entries(fields)) s += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
      s += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      return s;
    })();
    const tail = `\r\n--${boundary}--\r\n`;
    const stream = new ReadableStream<Uint8Array>({
      async start(c) { c.enqueue(enc.encode(head)); },
      async pull(c) {
        const reader = file.getReader();
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; c.enqueue(value); } }
        finally { reader.releaseLock(); }
        c.enqueue(enc.encode(tail));
        c.close();
      },
    });
    return { body: stream, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parentId = await this.resolveFolderId(parentPath(path));
    const name = basename(path);
    const resp: any = await this.provedJson("/7n/getUpToken", "POST", {
      fileId: "", fileName: name, fileSize: Math.floor(size / 1024) + 1, folderId: parentId, md5: "", type: 1,
    });
    const upToken = resp.upToken;
    if (upToken === "-1") return; // 秒传命中
    const now = new Date();
    const key = `disk/${now.getUTCFullYear()}/${now.getUTCMonth() + 1}/${now.getUTCDate()}/${this.account}/${now.getTime()}`;
    const keyB64 = bytesToBase64(stringToBytes(key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    let token: string | undefined;
    if (size <= DEFAULT_PART_SIZE) {
      const { body: mp, contentType } = this.buildQiniuMultipart({ token: upToken, key, fname: name }, body, name);
      const r = await fetch("https://upload.qiniup.com/", { method: "POST", headers: { "Content-Type": contentType }, body: mp });
      if (!r.ok) throw new Error(`ilanzou 上传失败 ${r.status}`);
      const jr = (await r.json().catch(() => ({}))) as any;
      token = jr.token || jr.hash;
    } else {
      const initR = await fetch(
        `https://upload.qiniup.com/buckets/${CONF.bucket}/objects/${keyB64}/uploads`,
        { method: "POST", headers: { Authorization: `UpToken ${upToken}` } }
      );
      if (!initR.ok) throw new Error(`ilanzou 分片初始化失败 ${initR.status}`);
      const uploadId: string = ((await initR.json()) as any)?.uploadId;
      const parts: { partNumber: number; etag: string }[] = [];
      const reader = body.getReader();
      const chunk = new Uint8Array(DEFAULT_PART_SIZE);
      let filled = 0, partNum = 1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunk.set(value, filled); filled += value.length;
        if (filled < DEFAULT_PART_SIZE) continue;
        const slice = chunk.slice(0, filled);
        const pu = await fetch(
          `https://upload.qiniup.com/buckets/${CONF.bucket}/objects/${keyB64}/uploads/${uploadId}/${partNum}`,
          { method: "PUT", headers: { Authorization: `UpToken ${upToken}` }, body: slice }
        );
        if (!pu.ok) throw new Error(`ilanzou 分片 ${partNum} 失败 ${pu.status}`);
        parts.push({ partNumber: partNum, etag: ((await pu.json()) as any)?.etag || "" });
        partNum++; filled = 0;
      }
      const cm = await fetch(
        `https://upload.qiniup.com/buckets/${CONF.bucket}/objects/${keyB64}/uploads/${uploadId}`,
        { method: "POST", headers: { Authorization: `UpToken ${upToken}` }, body: JSON.stringify({ fnmae: name, parts }) }
      );
      if (!cm.ok) throw new Error(`ilanzou 分片合并失败 ${cm.status}`);
      token = ((await cm.json()) as any)?.token;
    }
    // 提交上传结果（轮询，最多 10 次）
    for (let i = 0; i < 10; i++) {
      const res: any = await this.unprovedJson("/7n/results", "POST");
      const list: any[] = res.list || [];
      if (list.length && list[0].status === 1) return;
      await sleep(1000);
    }
    throw new Error("ilanzou 上传提交失败");
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveFolderId(parentPath(path));
    await this.provedJson("/file/folder/save", "POST", { folderDesc: "", folderId: parentId, folderName: basename(path) });
  }

  async remove(path: string): Promise<void> {
    const it = await this.get(path);
    await this.provedJson("/file/delete", "POST", {
      folderIds: it.is_dir ? it.etag! : "",
      fileIds: it.is_dir ? "" : it.etag!,
      status: 0,
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const it = await this.get(from);
    if (it.is_dir) {
      await this.provedJson("/file/folder/edit", "POST", { folderDesc: "", folderId: it.etag!, folderName: basename(to) });
    } else {
      await this.provedJson("/file/edit", "POST", { fileDesc: "", fileId: it.etag!, fileName: basename(to) });
    }
  }

  async move(from: string, to: string): Promise<void> {
    const it = await this.get(from);
    const dest = await this.resolveFolderId(parentPath(to));
    await this.provedJson("/file/folder/move", "POST", {
      folderIds: it.is_dir ? it.etag! : "",
      fileIds: it.is_dir ? "" : it.etag!,
      targetId: dest,
    });
  }
}

