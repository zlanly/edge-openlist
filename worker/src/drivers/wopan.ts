import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const BASE = "https://panservice.mail.wo.cn";
const ZONE = "https://tjupload.pan.wo.cn";
const DEF_CLIENT_ID = "1001000021";
const DEF_CLIENT_SECRET = "XFmi9GS2hzk98jGX";
const IV = "wNSOYIB1k1j1DjY5lA";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.37";
const PART_SIZE = 8 * 1024 * 1024;

type Json = Record<string, any>;

// ---- 加密辅助（与 wopan-sdk-go 一致：AES-CBC + PKCS7 + Base64，iv 固定）----
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function pkcs7Pad(data: Uint8Array, block = 16): Uint8Array {
  const pad = block - (data.length % block);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}
async function md5Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("MD5", enc.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function aesCbc(key: Uint8Array, data: Uint8Array, decrypt: boolean): Promise<Uint8Array> {
  const ko = await crypto.subtle.importKey("raw", key, "AES-CBC", false, [decrypt ? "decrypt" : "encrypt"]);
  if (decrypt) {
    const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv: enc.encode(IV) }, ko, data);
    return new Uint8Array(out);
  }
  const out = await crypto.subtle.encrypt({ name: "AES-CBC", iv: enc.encode(IV) }, ko, pkcs7Pad(data, 16));
  return new Uint8Array(out);
}

// 中国联通沃盘（refresh_token 鉴权）。端点/参数/加密均来自 wopan-sdk-go v0.1.5。
export class WopanDriver extends CloudBase {
  readonly id = "wopan";
  private accessToken = "";
  private defaultFamilyID = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private keyFor(channel: string): Uint8Array {
    return channel === "api-user" ? enc.encode(DEF_CLIENT_SECRET) : enc.encode(this.accessToken.slice(0, 16));
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t) || !t?.access_token) {
      const rt = this.cfgStr("refresh_token") || t?.refresh_token || "";
      if (!rt) throw new Error("缺少 refresh_token");
      const data = await this.request(
        "api-user",
        "AppRefreshToken",
        { refreshToken: rt, clientSecret: DEF_CLIENT_SECRET },
        { clientId: DEF_CLIENT_ID, secret: true }
      );
      t = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || rt,
        expires_at: Date.now() + (Number(data.expires_in) || 7200) * 1000,
        extra: {},
      };
      await saveTokens(this.env.KV, this.mountId, t);
    }
    this.accessToken = t!.access_token;
    return this.accessToken;
  }

  private async ensureFamily(): Promise<void> {
    if (this.defaultFamilyID || !this.familyID()) return;
    await this.ensureToken();
    const d = await this.request("wohome", "FamilyUserCurrentEncode", { clientId: DEF_CLIENT_ID }, { secret: true });
    this.defaultFamilyID = String(d.defaultHomeId);
  }

  private familyID(): string {
    return this.cfgStr("family_id");
  }
  private spaceType(): string {
    return this.familyID() ? "1" : "0";
  }
  private sortRule(): number {
    switch (this.cfgStr("sort_rule")) {
      case "name_desc": return 2;
      case "time_asc": return 3;
      case "time_desc": return 4;
      case "size_asc": return 5;
      case "size_desc": return 6;
      default: return 1;
    }
  }
  private async rootId(): Promise<string> {
    const cfg = this.cfgStr("root_folder_id");
    if (cfg) return cfg;
    if (this.familyID()) {
      await this.ensureFamily();
      return this.defaultFamilyID || "1";
    }
    return "0";
  }

  private async encryptParam(channel: string, param?: Json): Promise<string | undefined> {
    if (!param) return undefined;
    const e = await aesCbc(this.keyFor(channel), enc.encode(JSON.stringify(param)), false);
    return toB64(e);
  }

  private calHeader(channel: string, key: string) {
    const resTime = Date.now();
    const reqSeq = Math.floor(Math.random() * 8999) + 100000;
    const sign = md5Hex(`${key}${resTime}${reqSeq}${channel}`);
    return { key, resTime, reqSeq, channel, sign, version: "" };
  }

  private async request(channel: string, apiKey: string, param?: Json, other?: Json): Promise<any> {
    await this.ensureToken();
    const header = this.calHeader(channel, apiKey);
    const bodyOther: Json = { ...(other || {}) };
    const encParam = await this.encryptParam(channel, param);
    if (encParam !== undefined) bodyOther.param = encParam;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Origin: "https://pan.wo.cn",
      Referer: "https://pan.wo.cn/",
    };
    if (this.accessToken) headers["Accesstoken"] = this.accessToken;
    const r = await fetch(`${BASE}/${channel}/dispatcher`, {
      method: "POST",
      headers,
      body: JSON.stringify({ header, body: bodyOther }),
    });
    if (!r.ok) throw new Error(`沃盘请求失败 ${r.status}`);
    const resp = (await r.json()) as any;
    if (resp.STATUS !== "200") throw new Error(`沃盘状态码 ${resp.STATUS} ${resp.MSG}`);
    if (resp.RSP.RSP_CODE !== "0000") throw new Error(`沃盘 ${resp.RSP.RSP_CODE} ${resp.RSP_DESC}`);
    let data = resp.RSP.DATA;
    if (typeof data === "string") {
      const raw = await aesCbc(this.keyFor(channel), fromB64(data), true);
      data = JSON.parse(dec.decode(raw));
    }
    return data;
  }

  private async queryAll(parentId: string): Promise<any[]> {
    const out: any[] = [];
    let page = 0;
    for (;;) {
      const data = await this.request(
        "wohome",
        "QueryAllFiles",
        {
          spaceType: this.spaceType(),
          parentDirectoryId: parentId,
          pageNum: page,
          pageSize: 100,
          sortRule: this.sortRule(),
          clientId: DEF_CLIENT_ID,
          ...(this.familyID() ? { familyId: this.familyID() } : {}),
        },
        { secret: true }
      );
      const files = data.files || [];
      out.push(...files);
      if (files.length < 100) break;
      page++;
    }
    return out;
  }

  private async resolveId(path: string): Promise<string> {
    const rt = normalizePath(path);
    if (rt === "/") return await this.rootId();
    let id = await this.rootId();
    for (const name of rt.split("/").filter(Boolean)) {
      const f = (await this.queryAll(id)).find((x) => x.name === name);
      if (!f) throw new Error(`路径不存在: ${path}`);
      id = f.id;
    }
    return id;
  }

  private fileType(name: string): string {
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    if (!ext) return "5";
    const map: Record<string, string> = {
      doc: "1", docx: "1", xls: "2", xlsx: "2", ppt: "3", pptx: "3",
      pdf: "4", jpg: "6", jpeg: "6", png: "6", gif: "6", bmp: "6",
      mp3: "7", wav: "7", mp4: "8", avi: "8", mov: "8", zip: "9", rar: "9",
    };
    return map[ext] || "5";
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    return (await this.queryAll(id)).map((f) => ({
      name: f.name,
      path: joinPath(path, f.name),
      is_dir: f.type === 0,
      size: Number(f.size || 0),
      modified: parseWoTime(f.createTime),
      etag: f.id,
    }));
  }

  async get(path: string): Promise<FileItem> {
    const id = await this.resolveId(path);
    const f = (await this.queryAll(id)).find((x) => x.name === basename(path));
    if (!f) throw new Error(`文件不存在: ${path}`);
    return {
      name: f.name,
      path,
      is_dir: f.type === 0,
      size: Number(f.size || 0),
      modified: parseWoTime(f.createTime),
      etag: f.id,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.resolveId(path);
    const data = await this.request("wohome", "GetDownloadUrlV2", { type: "1", fidList: [id], clientId: DEF_CLIENT_ID }, { secret: true });
    const item = (data.list || []).find((x: any) => x.fid === id);
    if (!item || !item.downloadUrl) throw new Error("获取下载链接失败");
    return fetch(item.downloadUrl, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "wopan" } };
  }

  // Worker 代理分片上传（边读边传 multipart，每片 8MB，不缓冲整文件）
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    await this.ensureToken();
    const parentId = await this.resolveId(parentPath(path));
    const name = basename(path);
    const fileInfo: Json = {
      spaceType: this.spaceType(),
      directoryId: parentId,
      batchNo: fmtTime(),
      fileName: name,
      fileSize: size,
      fileType: this.fileType(name),
    };
    if (this.familyID()) fileInfo.familyId = this.familyID();
    const fileInfoStr = await this.encryptParam("wohome", fileInfo);
    const totalPart = Math.max(1, Math.ceil(size / PART_SIZE));

    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let buf = new Uint8Array(0);
    let partIndex = 1;
    const uploadPart = async (chunk: Uint8Array) => {
      const fd = new FormData();
      fd.set("uniqueId", String(Date.now()));
      fd.set("accessToken", this.accessToken);
      fd.set("fileName", name);
      fd.set("psToken", "undefined");
      fd.set("fileSize", String(size));
      fd.set("totalPart", String(totalPart));
      fd.set("channel", "wocloud");
      fd.set("directoryId", parentId);
      fd.set("fileInfo", fileInfoStr!);
      fd.set("partSize", String(chunk.length));
      fd.set("partIndex", String(partIndex));
      fd.set("file", new Blob([chunk], { type: "application/octet-stream" }), name);
      const r = await fetch(`${ZONE}/openapi/client/upload2C`, {
        method: "POST",
        headers: { Origin: "https://pan.wo.cn", Referer: "https://pan.wo.cn/", "User-Agent": UA },
        body: fd,
      });
      if (!r.ok) throw new Error(`沃盘上传失败 ${r.status}`);
      const j = (await r.json()) as any;
      if (j.code !== "0000") throw new Error(`沃盘上传失败 ${j.code} ${j.msg}`);
      partIndex++;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf, 0);
      merged.set(value, buf.length);
      buf = merged;
      while (buf.length >= PART_SIZE && partIndex <= totalPart) {
        await uploadPart(buf.slice(0, PART_SIZE));
        buf = buf.slice(PART_SIZE);
      }
    }
    if (buf.length > 0 && partIndex <= totalPart) await uploadPart(buf);
  }

  async mkdir(path: string): Promise<void> {
    const pid = await this.resolveId(parentPath(path));
    await this.request(
      "wohome",
      "CreateDirectory",
      {
        spaceType: this.spaceType(),
        familyId: this.familyID(),
        parentDirectoryId: pid,
        directoryName: basename(path),
        clientId: DEF_CLIENT_ID,
      },
      { secret: true }
    );
  }

  async remove(path: string): Promise<void> {
    const id = await this.resolveId(path);
    await this.request(
      "wohome",
      "DeleteFile",
      { spaceType: this.spaceType(), vipLevel: "0", dirList: [], fileList: [id], clientId: DEF_CLIENT_ID },
      { secret: true }
    );
  }

  async rename(from: string, to: string): Promise<void> {
    const id = await this.resolveId(from);
    await this.request(
      "wohome",
      "RenameFileOrDirectory",
      {
        spaceType: this.spaceType(),
        type: 1,
        fileType: this.fileType(basename(to)),
        id,
        name: basename(to),
        clientId: DEF_CLIENT_ID,
        ...(this.familyID() ? { familyId: this.familyID() } : {}),
      },
      { secret: true }
    );
  }

  async move(from: string, to: string): Promise<void> {
    const srcId = await this.resolveId(from);
    const dstId = await this.resolveId(parentPath(to));
    await this.request(
      "wohome",
      "MoveFile",
      {
        targetDirId: dstId,
        sourceType: this.spaceType(),
        targetType: this.spaceType(),
        dirList: [],
        fileList: [srcId],
        secret: false,
        clientId: DEF_CLIENT_ID,
        ...(this.familyID() ? { fromFamilyId: this.familyID(), familyId: this.familyID() } : {}),
      },
      { secret: true }
    );
  }
}

function fmtTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function parseWoTime(s: string): number {
  if (!s || s.length < 14) return 0;
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8), h = +s.slice(8, 10), mi = +s.slice(10, 12), se = +s.slice(12, 14);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se) + 8 * 3600 * 1000).getTime();
}

export type _Avoid = Env | DriverConfig;
