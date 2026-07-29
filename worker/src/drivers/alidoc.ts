import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// 阿里云盘文档（钉钉文档）驱动
// 认证：网页 Cookie（DingTalk）。上传走 OSS STS_SIGNATURE 临时凭证。
// 源：OpenList drivers/alidoc (driver.go / meta.go / upload.go / util.go / types.go)
// 端点：https://alidocs.dingtalk.com
//   - 列表  GET  /box/api/v2/dentry/list
//   - 下载  GET  /box/api/v2/file/download        -> OSS 预签名直链
//   - 建目录 POST /box/api/v2/dentry/createfolder
//   - 移动  POST /box/api/v2/dentry/move
//   - 重命名 POST /box/api/v2/dentry/rename
//   - 删除  POST /box/api/v1/dentry/recycle
//   - 上传  POST /box/api/v2/file/uploadinfo      -> STS 临时凭证
//   - 提交  POST /box/api/v2/file/commit

const API = "https://alidocs.dingtalk.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const enc = new TextEncoder();

function toB64(bytes: ArrayBuffer): string {
  const u = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

export class AliDocDriver extends CloudBase {
  readonly id = "alidoc";
  private cookie = "";
  private rootId = "";

  private cfgStr(k: string): string {
    return ((this.cfg as Record<string, unknown>)[k] as string) ?? "";
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.cookie = (this.cfgStr("cookie") || "").trim();
    this.rootId = (this.cfgStr("rootFolderId") || this.cfgStr("root_id") || "").trim();
    if (!this.cookie) throw new Error("alidoc: 缺少 cookie");
    if (!this.rootId) throw new Error("alidoc: 缺少 rootFolderId");
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {
      Cookie: this.cookie,
      Accept: "application/json, text/plain, */*",
      Referer: API + "/",
      Origin: API,
      "User-Agent": UA,
    };
  }

  // 深序路径 -> dentryUuid
  private async resolveId(path: string): Promise<string> {
    if (path === "/" || path === "") return this.rootId;
    const parts = normalizePath(path).split("/").filter(Boolean);
    let parent = this.rootId;
    for (const name of parts) {
      const children = await this.listDentry(parent);
      const found = children.find((c) => c.Name === name);
      if (!found) throw new Error(`alidoc: 路径不存在 ${path}`);
      parent = found.DentryUUID;
    }
    return parent;
  }

  private async listDentry(dentryUuid: string): Promise<any[]> {
    const qs = new URLSearchParams({
      dentryUuid,
      withParentAncestors: "true",
      orderType: "SORT_KEY",
      sortType: "desc",
      listDentrySource: "2",
      pageSize: "1000",
    });
    const r = await fetch(`${API}/box/api/v2/dentry/list?${qs.toString()}`, {
      headers: await this.hdrs(),
    });
    if (!r.ok) throw new Error(`alidoc list ${r.status}`);
    const j = (await r.json()) as any;
    if (!j.isSuccess || j.status !== 200) throw new Error(`alidoc list: ${j.message || j.msg || "failed"}`);
    return j.data?.children || [];
  }

  private async post(path: string, body: unknown): Promise<any> {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await this.hdrs()) },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`alidoc post ${r.status} ${path}`);
    const j = (await r.json()) as any;
    if (!j.isSuccess || j.status !== 200) throw new Error(`alidoc ${path}: ${j.message || j.msg || "failed"}`);
    return j;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const children = await this.listDentry(id);
    return children
      .filter((c) => c.DentryUUID && c.Name)
      .map((c) => ({
        name: c.Name,
        path: joinPath(path, c.Name),
        is_dir: c.DentryType === "folder",
        size: Number(c.FileSize || 0),
        modified: Number(c.UpdatedTime || 0),
      }));
  }

  private async findDentry(path: string): Promise<any> {
    if (path === "/") return { DentryUUID: this.rootId, Name: "", DentryType: "folder", FileSize: 0, UpdatedTime: 0 };
    const id = await this.resolveId(parentPath(path));
    const name = basename(path);
    const children = await this.listDentry(id);
    const f = children.find((c) => c.Name === name);
    if (!f) throw new Error(`alidoc: 文件不存在 ${path}`);
    return f;
  }

  async get(path: string): Promise<FileItem> {
    const f = await this.findDentry(path);
    return {
      name: f.Name,
      path: normalizePath(path),
      is_dir: f.DentryType === "folder",
      size: Number(f.FileSize || 0),
      modified: Number(f.UpdatedTime || 0),
    };
  }

  async getContent(path: string, _range?: string): Promise<Response | string> {
    const id = await this.resolveId(path);
    const qs = new URLSearchParams({
      dentryUuid: id,
      version: "1",
      supportDownloadTypes: "URL_PRE_SIGNATURE,HTTP_TO_CENTER",
      downloadType: "URL_PRE_SIGNATURE",
    });
    const r = await fetch(`${API}/box/api/v2/file/download?${qs.toString()}`, { headers: await this.hdrs() });
    if (!r.ok) throw new Error(`alidoc download ${r.status}`);
    const j = (await r.json()) as any;
    if (!j.isSuccess || j.status !== 200) throw new Error(`alidoc download: ${j.message || j.msg}`);
    const urls: string[] = j.data?.ossUrlPreSignatureInfo?.preSignURLs || [];
    if (!urls.length) throw new Error("alidoc: 空下载链接");
    return urls[0]; // OSS 预签名直链，客户端直接拉取
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 上传走 Worker 代理：在 putContent 内用 STS 凭证直传 OSS
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "alidoc" } };
  }

  // 取 STS 临时凭证（OSS）
  private async getUploadInfo(parentId: string, name: string, size: number): Promise<any> {
    const body = {
      uploadType: "STS_SIGNATURE",
      supportUploadTypes: ["STS_SIGNATURE", "HTTP_TO_CENTER"],
      parentDentryUuid: parentId,
      fileSize: size,
      name,
      multipart: false,
    };
    const j = await this.post("/box/api/v2/file/uploadinfo", body);
    const sts = j.data?.stsSignatureInfo;
    if (!sts || !sts.Bucket) throw new Error("alidoc: 空上传 Bucket");
    return { sts, uploadKey: j.data?.uploadKey };
  }

  // OSS Header 签名（V1）：SignString = VERB\n+Content-MD5\n+Content-Type\n+Date\n+CanonicalizedOSSHeaders+CanonicalizedResource
  private async ossAuth(
    method: string,
    bucket: string,
    objectKey: string,
    secret: string,
    token: string,
    date: string,
    contentType: string,
  ): Promise<string> {
    const resource = `/${bucket}/${objectKey}`;
    const ossHeaders = `x-oss-security-token:${token}\n`;
    const signStr = `${method}\n\n${contentType}\n${date}\n${ossHeaders}${resource}`;
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: { name: "SHA-1" } },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signStr));
    return "OSS " + this.uploadAK + ":" + toB64(sig);
  }

  private uploadAK = "";

  async putContent(path: string, body: ReadableStream, ct = "application/octet-stream", size = 0): Promise<void> {
    const parentId = await this.resolveId(parentPath(path));
    const name = basename(path);
    const info = await this.getUploadInfo(parentId, name, size);
    const sts = info.sts;
    const objectKey = (sts.ObjectKey || info.uploadKey) as string;
    if (!objectKey) throw new Error("alidoc: 空上传 objectKey");
    const endpoint = (sts.EndPoint || sts.Cname || sts.AccelerateCname) as string;
    if (!endpoint) throw new Error("alidoc: 空上传 endpoint");
    const base = endpoint.startsWith("http") ? endpoint : "https://" + endpoint;
    const url = `${base.replace(/\/$/, "")}/${objectKey}`;
    const date = new Date().toUTCString();
    this.uploadAK = sts.AccessKeyID;
    const auth = await this.ossAuth("PUT", sts.Bucket, objectKey, sts.AccessKeySecret, sts.AccessToken, date, ct);
    const r = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: auth,
        "x-oss-security-token": sts.AccessToken,
        Date: date,
        "Content-Type": ct,
      },
      body: body as unknown as BodyInit,
    });
    if (!r.ok) throw new Error(`alidoc OSS 上传失败 ${r.status}: ${await r.text().catch(() => "")}`);

    // 提交（commit）
    await this.post("/box/api/v2/file/commit", {
      parentDentryUuid: parentId,
      uploadKey: info.uploadKey,
      fileSize: size,
      name,
      toPrevDentryUuid: null,
      toNextDentryUuid: null,
      batchId: crypto.randomUUID(),
      batchUploadType: 1,
      batchParentDentryUuid: parentId,
    });
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(parentPath(path));
    await this.post("/box/api/v2/dentry/createfolder", {
      dentryType: "folder",
      name: basename(path),
      parentDentryUuid: parentId,
      conflictHandleStrategy: "auto_rename",
    });
  }

  async remove(path: string): Promise<void> {
    const f = await this.findDentry(path);
    await this.post("/box/api/v1/dentry/recycle", { dentryUuid: f.DentryUUID });
  }

  async rename(from: string, to: string): Promise<void> {
    const f = await this.findDentry(from);
    await this.post("/box/api/v2/dentry/rename", { dentryUuid: f.DentryUUID, name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const f = await this.findDentry(from);
    const destId = await this.resolveId(parentPath(to));
    await this.post("/box/api/v2/dentry/move", {
      targetParentDentryUuid: destId,
      sourceDentryUuid: f.DentryUUID,
      operateFrom: 1,
    });
  }
}

export type _Avoid = Env | DriverConfig;
