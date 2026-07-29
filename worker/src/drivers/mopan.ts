import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const HOME = "https://mopan.sc.189.cn";
const FAMILY = `${HOME}/mopanproxy/family`;
const AUTH = `${HOME}/mopanproxy/auth`;
const UPLOAD = `${HOME}/mopanproxy/fileupload`;
const PART_SIZE = 10 * 1024 * 1024;

type Json = Record<string, any>;

const enc = new TextEncoder();
const dec = new TextDecoder();
function toB64Bytes(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const b = atob(s);
  const o = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i);
  return o;
}
function pkcs7Pad(d: Uint8Array, b = 16): Uint8Array {
  const p = b - (d.length % b);
  const o = new Uint8Array(d.length + p);
  o.set(d);
  o.fill(p, d.length);
  return o;
}
// AES-ECB（WebCrypto 无原生 ECB，逐 16 字节块以 CBC + 零 IV 等价实现）
async function aesEcb(data: Uint8Array, key: Uint8Array, decrypt = false): Promise<Uint8Array> {
  const ko = await crypto.subtle.importKey("raw", key, "AES-CBC", false, [decrypt ? "decrypt" : "encrypt"]);
  const zero = new Uint8Array(16);
  let work = data;
  if (!decrypt) work = pkcs7Pad(data, 16);
  const out = new Uint8Array(work.length);
  for (let i = 0; i < work.length; i += 16) {
    const blk = work.slice(i, i + 16);
    const r = decrypt
      ? new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: zero }, ko, blk))
      : new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: zero }, ko, blk));
    out.set(r, i);
  }
  if (decrypt) {
    const pad = out[out.length - 1];
    return out.slice(0, out.length - pad);
  }
  return out;
}
async function md5Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("MD5", enc.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- RSA PKCS1v15 公钥加密（BigInt 实现，因 WebCrypto 仅支持 OAEP）----
const PUBLIC_KEY_V2 = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAgRb5UBbJFi3DFnxMxqqWZ0waO5a+dXLih6g47tT8H0ie+uYT3L7
nte63Cm04KX7HRovmN6zHI60m/gg6gukvqYqUtf3R2tP0i8T3KtWSZFjGqcDFLF2yvj3ntZUwU0/O3wZT3CbxOz2YoA6YXz
c0MlAjc8tu/YpBxN5CsO9auiaVSODiCNiUCFqEGBiHvQiRsX08bTOfSaTPw3SEavO24tknjAUahP/++uz2JOgLTN+zY0nmh
RZD3ArrPM84dtrldByc7g2kCwxSU3OsCpYuBZ8Po/Q/09p+Xpz2YP9dBGNnFR3sHIQcNA2Fj/nyNLRNw7FnWAcRwOvQhl8h
NqC40wIDAQAB
-----END PUBLIC KEY-----`;
function parseRsaInts(der: Uint8Array): bigint[] {
  const ints: bigint[] = [];
  let i = 0;
  while (i < der.length) {
    if (der[i] === 0x02) {
      i++;
      let len = der[i++];
      if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let k = 0; k < n; k++) len = (len << 8) | der[i++];
      }
      let v = 0n;
      let j = i;
      if (der[j] === 0) j++;
      for (; j < i + len; j++) v = (v << 8n) | BigInt(der[j]);
      ints.push(v);
      i += len;
    } else i++;
  }
  return ints;
}
function rsaEncrypt(message: Uint8Array, n: bigint, e: bigint): Uint8Array {
  const k = (n.toString(2).length + 7) >> 3;
  const psLen = k - 3 - message.length;
  const em = new Uint8Array(k);
  em[0] = 0; em[1] = 2;
  for (let i = 2; i < 2 + psLen; i++) {
    let b = 0;
    while (b === 0) b = Math.floor(Math.random() * 256);
    em[i] = b;
  }
  em[2 + psLen] = 0;
  em.set(message, 3 + psLen);
  let m = 0n;
  for (const byte of em) m = (m << 8n) | BigInt(byte);
  let c = 1n;
  let base = m % n;
  let exp = e;
  while (exp > 0n) {
    if (exp & 1n) c = (c * base) % n;
    base = (base * base) % n;
    exp >>= 1n;
  }
  const out = new Uint8Array(k);
  for (let i = k - 1; i >= 0; i--) {
    out[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return out;
}
const RSA_KEY = (() => {
  const b64 = PUBLIC_KEY_V2.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s/g, "");
  const der = fromB64(b64);
  const ints = parseRsaInts(der);
  return { n: ints[0], e: ints[1] };
})();

const DEFAULT_DEVICE = {
  deviceNo: "1104a897925070c638d",
  mp_remoteType: "3",
  mp_remoteChannel: "100",
  mp_version: "1.1.202",
  mp_version_code: 145,
  mp_deviceSerialNum: "1104a897925070c638d00000000000000",
  mp_manufcaturer: "Windows端",
  mp_model: "",
  mp_os: "windows",
  mp_osVersion: "31",
  mp_osVersion2: "12",
};

// 天翼云盘（手机号+密码 登录，AES-ECB + RSA 信封）。端点/参数来自 mopan-sdk-go v0.1.6。
export class MopanDriver extends CloudBase {
  readonly id = "mopan";
  private token = "";
  private userID = "";
  private device: Json = { ...DEFAULT_DEVICE };

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t) || !t?.access_token) {
      const phone = this.cfgStr("phone"), password = this.cfgStr("password");
      if (!phone || !password) throw new Error("缺少手机号/密码");
      const timestamp = Date.now();
      const random = (Math.random() + "").slice(2);
      const sign = await md5Hex(`${phone}${password}${timestamp}${random}`);
      const data = await this.rawRequest(`${AUTH}/through/login/pwd`, {
        phone, password, random, time: timestamp, sign,
      });
      this.token = data.token;
      t = { access_token: this.token, refresh_token: "", expires_at: Date.now() + 7200 * 1000, extra: {} };
      await saveTokens(this.env.KV, this.mountId, t);
    } else {
      this.token = t!.access_token;
    }
    return this.token;
  }

  private deviceEncryptAsync(secretKey: string): Promise<string> {
    return aesEcb(enc.encode(JSON.stringify(this.device)), enc.encode(secretKey)).then(toB64Bytes);
  }

  private async rawRequest(url: string, data?: Json): Promise<any> {
    await this.ensureToken();
    const secretKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      remoteInfo: await this.deviceEncryptAsync(secretKey),
      version: this.device.mp_version,
      "encrypted-key": toB64Bytes(rsaEncrypt(enc.encode(secretKey), RSA_KEY.n, RSA_KEY.e)),
    };
    let body: string | undefined;
    if (data) {
      const e = await aesEcb(enc.encode(JSON.stringify(data)), enc.encode(secretKey));
      body = toB64Bytes(e);
    }
    const r = await fetch(url, { method: "POST", headers, body });
    if (!r.ok) throw new Error(`天翼云盘请求失败 ${r.status}`);
    let raw = await r.text();
    if (raw.startsWith('"') && raw.endsWith('"')) {
      raw = dec.decode(await aesEcb(fromB64(raw.slice(1, -1)), enc.encode(secretKey), true));
    }
    const resp = JSON.parse(raw);
    if (resp.code !== 200) throw new Error(`天翼云盘 ${resp.code} ${resp.message}`);
    return resp.data;
  }

  private async rootId(): Promise<string> {
    const cfg = this.cfgStr("root_folder_id");
    if (cfg) return cfg;
    // 默认取 "/文件" 对应的 folderId
    const stor = await this.rawRequest(`${FAMILY}/user/cloudStorage/getByUserId`, { type: 2 });
    const f = (stor || []).find((x: any) => x.path === "/文件");
    return f ? f.folderId : "0";
  }

  private async resolveId(path: string): Promise<string> {
    const rt = normalizePath(path);
    if (rt === "/") return await this.rootId();
    let id = await this.rootId();
    for (const name of rt.split("/").filter(Boolean)) {
      const data = await this.rawRequest(`${FAMILY}/file/listFiles`, {
        folderId: id, pageNum: "1", source: 1, type: 1, remark: 60,
      });
      const f = (data.fileListAO?.folderList || []).concat(data.fileListAO?.fileList || []).find((x: any) => x.name === name);
      if (!f) throw new Error(`路径不存在: ${path}`);
      id = String(f.id);
    }
    return id;
  }

  private async listDir(id: string): Promise<FileItem[]> {
    const out: FileItem[] = [];
    for (let page = 1; ; page++) {
      const data = await this.rawRequest(`${FAMILY}/file/listFiles`, {
        folderId: id, pageNum: String(page), source: 1, type: 1, remark: 60,
      });
      const folders: any[] = data.fileListAO?.folderList || [];
      const files: any[] = data.fileListAO?.fileList || [];
      for (const f of folders) out.push({ name: f.name, path: "", is_dir: true, size: 0, modified: Date.parse(f.lastOpTime) || 0, etag: String(f.id) });
      for (const f of files) out.push({ name: f.name, path: "", is_dir: false, size: Number(f.size || 0), modified: Date.parse(f.lastOpTime) || 0, etag: String(f.id) });
      if (folders.length + files.length === 0) break;
    }
    return out;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const items = await this.listDir(id);
    return items.map((it) => ({ ...it, path: joinPath(path, it.name) }));
  }

  async get(path: string): Promise<FileItem> {
    const id = await this.resolveId(path);
    const items = await this.listDir(id);
    const f = items.find((x) => x.name === basename(path));
    if (!f) throw new Error(`文件不存在: ${path}`);
    return f;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.resolveId(path);
    const data = await this.rawRequest(`${FAMILY}/file/getFileDownloadUrl`, {
      fileId: id, forcedGet: 0, ifShort: false, limitRate: "10485760", source: 1,
    });
    let url = (data.downloadUrl || "").replace(/&amp;/g, "&").replace(/^http:\/\//, "https://");
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "mopan" } };
  }

  // Worker 代理上传：控制面（AES/RSA 信封）初始化分片并获取预签名 PUT 地址，再逐片流式 PUT
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parentId = await this.resolveId(parentPath(path));
    const name = basename(path);
    const buf = new Uint8Array(await new Response(body).arrayBuffer());

    const count = Math.max(1, Math.ceil(size / PART_SIZE));
    const lastPartSize = size % PART_SIZE === 0 ? PART_SIZE : size % PART_SIZE;
    const fileMd5 = await md5Hex(dec.decode(buf));
    const upper = (h: string) => h.toUpperCase();
    const sliceMd5Hexs: string[] = [];
    const partInfos: string[] = [];
    for (let i = 1; i <= count; i++) {
      const start = (i - 1) * PART_SIZE;
      const end = Math.min(size, start + PART_SIZE);
      const hex = upper(await md5Hex(dec.decode(buf.slice(start, end))));
      sliceMd5Hexs.push(hex);
      const b64 = toB64Bytes(toHexBytes(hex));
      partInfos.push(`${i}-${b64}`);
    }
    let sliceMd5 = upper(fileMd5);
    if (size > PART_SIZE) sliceMd5 = upper(await md5Hex(sliceMd5Hexs.join("\n")));

    const init = await this.rawRequest(`${UPLOAD}/service/initMultiUpload`, {
      parentFolderId: parentId, fileName: name, fileSize: size,
      fileMd5: upper(fileMd5), sliceMd5, sliceSize: PART_SIZE, limitrate: "10240000", source: 1,
    });
    if (init.fileDataExists) return; // 秒传
    const uploadFileId = init.uploadFileId;

    const urls = await this.rawRequest(`${UPLOAD}/service/getAllMultiUploadUrls`, {
      uploadFileId, partInfo: partInfos.join(","),
    });
    for (const part of urls) {
      const partNo = part.partNumber;
      const start = (partNo - 1) * PART_SIZE;
      const end = partNo === count ? start + lastPartSize : start + PART_SIZE;
      const chunk = buf.slice(start, end);
      const r = await fetch(part.httpURL, {
        method: part.httpMethod || "PUT",
        headers: {
          "Content-Type": part.contentType || "application/octet-stream",
          Authorization: part.authorization,
          Date: part.date,
          "x-amz-limit": `rate=${part.limitrate}`,
          "Content-Md5": part.partMD5,
        },
        body: chunk,
      });
      if (!r.ok) throw new Error(`天翼上传分片失败 ${r.status}`);
    }
    await this.rawRequest(`${UPLOAD}/service/commitMultiUploadFile`, {
      uploadFileId, opertype: 3, isLog: "其他",
    });
  }

  async mkdir(path: string): Promise<void> {
    const pid = await this.resolveId(parentPath(path));
    await this.rawRequest(`${FAMILY}/file/createFolder`, {
      folderName: basename(path), parentFolderId: pid, relativePath: "/", source: 1,
    });
  }

  async remove(path: string): Promise<void> {
    const node = await this.resolveIdNode(path);
    await this.rawRequest(`${FAMILY}/recycle/deleteToRecycle`, {
      source: 1, type: 1,
      taskInfos: [{ fileId: node.id, isFolder: node.is_dir, fileName: basename(path) }],
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const node = await this.resolveIdNode(from);
    if (node.is_dir) {
      await this.rawRequest(`${FAMILY}/file/renameFolder`, { folderId: node.id, destFolderName: basename(to), source: 1 });
    } else {
      await this.rawRequest(`${FAMILY}/file/renameFile`, { fileId: node.id, destFileName: basename(to), source: 1 });
    }
  }

  async move(from: string, to: string): Promise<void> {
    const src = await this.resolveIdNode(from);
    const dstId = await this.resolveId(parentPath(to));
    if (!this.userID) {
      const info = await this.rawRequest(`${FAMILY}/user/info/getUserInfo`, {});
      this.userID = info.userId;
    }
    const task = await this.rawRequest("addTask", {
      userOrCloudId: this.userID, source: 1, taskType: "MOVE", targetUserOrCloudId: this.userID,
      targetSource: 1, targetType: 1, targetFolderId: dstId,
      taskStatusDetailDTOList: [{ fileId: src.id, isFolder: src.is_dir, fileName: basename(from) }],
    });
    // 轮询任务状态（最多 5 次）
    for (let i = 0; i < 5; i++) {
      const stat = await this.rawRequest(`${FAMILY}/task/status/checkBatchTask`, {
        taskId: task.taskIdList[0], taskType: "MOVE", targetType: 1, targetFolderId: dstId,
        targetSource: 1, targetUserOrCloudId: this.userID,
      });
      if (stat.taskStatus === 4) return;
      if (stat.taskStatus === 2) throw new Error("文件名冲突");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // 解析为 {id, is_dir}
  private async resolveIdNode(path: string): Promise<{ id: string; is_dir: boolean }> {
    const rt = normalizePath(path);
    if (rt === "/") return { id: await this.rootId(), is_dir: true };
    let id = await this.rootId();
    let isDir = true;
    const parts = rt.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const data = await this.rawRequest(`${FAMILY}/file/listFiles`, { folderId: id, pageNum: "1", source: 1, type: 1, remark: 60 });
      const all = (data.fileListAO?.folderList || []).concat(data.fileListAO?.fileList || []);
      const f = all.find((x: any) => x.name === parts[i]);
      if (!f) throw new Error(`路径不存在: ${path}`);
      isDir = !("size" in f) ? true : false;
      id = String(f.id);
    }
    return { id, is_dir: isDir };
  }
}

function toHexBytes(hex: string): Uint8Array {
  const o = new Uint8Array(hex.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return o;
}

export type _Avoid = Env | DriverConfig;
