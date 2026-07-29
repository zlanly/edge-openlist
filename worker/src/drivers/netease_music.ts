import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import {
  aesCbcEncrypt, aesEcbEncrypt, stringToBytes, bytesToBase64, bytesToHex, base64ToBytes,
} from "../util/aes";
import { md5Hex } from "../util/md5";

const presetKey = stringToBytes("0CoJUm6Qyw8W8jud");
const iv = stringToBytes("0102030405060708");
const eapiKey = stringToBytes("e82ckenh8dichen8");
const linuxapiKey = stringToBytes("rFgB&h#%2?^eDg:Q");
const publicKeyPem = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

const stdChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function randomKey(): Uint8Array {
  const k = new Uint8Array(16);
  for (let i = 0; i < 16; i++) k[i] = stdChars.charCodeAt(Math.floor(Math.random() * 62));
  return k;
}

function rsaModulus(pem: string): bigint {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = base64ToBytes(b64);
  const idx = der.indexOf(0x03);
  let p = idx + 1;
  let len = der[p++];
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = (len << 8) | der[p++]; }
  p++; // unused 0x00
  const i2 = der.indexOf(0x02, p);
  let q = i2 + 1; let l = der[q++];
  if (l & 0x80) { const n = l & 0x7f; l = 0; for (let k = 0; k < n; k++) l = (l << 8) | der[q++]; }
  let mod = 0n;
  for (let k = 0; k < l; k++) mod = (mod << 8n) | BigInt(der[q++]);
  return mod;
}
const N = rsaModulus(publicKeyPem);
const E = 65537n;

function rsaEncrypt(buffer: Uint8Array): Uint8Array {
  let m = 0n;
  for (const b of buffer) m = (m << 8n) | BigInt(b);
  let r = 1n, base = m % N, e = E;
  while (e > 0n) { if (e & 1n) r = (r * base) % N; base = (base * base) % N; e >>= 1n; }
  const out = new Uint8Array(128);
  let t = r;
  for (let k = 127; k >= 0; k--) { out[k] = Number(t & 0xffn); t >>= 8n; }
  return out;
}

async function weapi(data: Record<string, string>): Promise<Record<string, string>> {
  const secretKey = randomKey();
  const reversed = new Uint8Array(16);
  for (let i = 0; i < 16; i++) reversed[15 - i] = secretKey[i];
  const text = stringToBytes(JSON.stringify(data));
  const step1 = await aesCbcEncrypt(text, presetKey, iv);
  const step1B64 = stringToBytes(bytesToBase64(step1));
  const step2 = await aesCbcEncrypt(step1B64, reversed, iv);
  const params = bytesToBase64(step2);
  const encSecKey = bytesToHex(rsaEncrypt(secretKey));
  return { params, encSecKey };
}

async function eapi(url: string, data: any): Promise<Record<string, string>> {
  const text = JSON.stringify(data);
  const digest = md5Hex(stringToBytes("nobody" + url + "use" + text + "md5forencrypt"));
  const params = url + "-36cd479b6b5-" + text + "-36cd479b6b5-" + digest;
  const enc = await aesEcbEncrypt(stringToBytes(params), eapiKey);
  return { params: bytesToHex(enc) };
}

async function linuxapi(data: any): Promise<Record<string, string>> {
  const text = JSON.stringify(data);
  const enc = await aesEcbEncrypt(stringToBytes(text), linuxapiKey);
  return { eparams: bytesToHex(enc).toUpperCase() };
}

// 网易云音乐（文件/云盘）。Cookie 鉴权；接口请求经 weapi/eapi/linuxapi 加密。
export class NeteaseMusicDriver extends CloudBase {
  readonly id = "netease_music";
  private musicU = "";
  private csrf = "";
  private fileMap = new Map<string, FileItem>();

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private getCookie(name: string): string {
    const m = this.cfgStr("cookie").match(new RegExp(name + "=([^;]+)"));
    return m ? m[1] : "";
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.csrf = this.getCookie("__csrf");
    this.musicU = this.getCookie("MUSIC_U");
    if (!this.csrf || !this.musicU) throw new Error("netease_music: 缺少 __csrf 或 MUSIC_U");
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Cookie: this.cfgStr("cookie"), Referer: "https://music.163.com" };
  }

  private async request(
    url: string,
    cryptoType: "weapi" | "eapi" | "linuxapi" | "",
    data: Record<string, string> = {},
    extraCookies: Record<string, string> = {}
  ): Promise<any> {
    let post: Record<string, string> = {};
    let finalUrl = url;
    if (cryptoType === "weapi") {
      post = await weapi(data);
      finalUrl = url.replace(/\/api\//, "/weapi/");
    } else if (cryptoType === "eapi") {
      const ch: Record<string, string> = {
        osver: "", deviceId: "", mobilename: "", appver: "6.1.1", versioncode: "140",
        buildver: String(Math.floor(Date.now() / 1000)), resolution: "1920x1080", os: "android",
        channel: "", requestId: String(Date.now() * 1000) + Math.floor(Math.random() * 1000), MUSIC_U: this.musicU,
      };
      const body = { header: ch, ...data };
      post = await eapi(url, body);
      finalUrl = url.replace(/\/api\//, "/eapi/");
    } else if (cryptoType === "linuxapi") {
      post = await linuxapi({ url: url.replace(/\/api\//, "/api/"), method: "POST", params: data });
      finalUrl = "https://music.163.com/api/linux/forward";
    }
    const cookie = [this.cfgStr("cookie"), ...Object.entries(extraCookies).map(([k, v]) => `${k}=${v}`)].join("; ");
    const r = await fetch(finalUrl, {
      method: "POST",
      headers: { ...(await this.hdrs()), Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(post).toString(),
    });
    if (!r.ok) throw new Error(`网易云请求失败 ${r.status}`);
    return r.json();
  }

  private characteristic(): Record<string, string> {
    return {
      osver: "", deviceId: "", mobilename: "", appver: "6.1.1", versioncode: "140",
      buildver: String(Math.floor(Date.now() / 1000)), resolution: "1920x1080", os: "android",
      channel: "", requestId: String(Date.now() * 1000) + Math.floor(Math.random() * 1000), MUSIC_U: this.musicU,
    };
  }

  async list(path: string): Promise<FileItem[]> {
    const limit = this.cfgStr("song_limit") || "200";
    const j = await this.request("https://music.163.com/weapi/v1/cloud/get", "weapi", { limit, offset: "0" }, { os: "pc" });
    const out: FileItem[] = [];
    this.fileMap.clear();
    for (const f of (j.data || []) as any[]) {
      const song: FileItem = {
        name: f.fileName,
        // path 在云盘内均以根展示
        path: "/" + f.fileName,
        is_dir: false,
        size: Number(f.fileSize || 0),
        modified: Number(f.addTime) * 1000,
        etag: String(f.songId),
      };
      this.fileMap.set(song.name, song);
      const lrcName = f.fileName.replace(/\.[^.]+$/, "") + ".lrc";
      this.fileMap.set(lrcName, { ...song, name: lrcName, path: "/" + lrcName });
      out.push(song);
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const name = path.replace(/^\//, "").replace(/\.lrc$/, "");
    const cached = this.fileMap.get(basename(path)) || [...this.fileMap.values()].find((i) => i.path === path);
    if (cached) return cached;
    const items = await this.list("/");
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error(`网易云文件不存在: ${path}`);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    if (path.endsWith(".lrc")) {
      const it = await this.get(path);
      const j = await this.request("https://music.163.com/api/song/lyric?_nmclfl=1", "", { id: it.etag!, tv: "-1", lv: "-1", rv: "-1", kv: "-1" }, { os: "ios" });
      const lyric = j.lrc?.lyric || "";
      const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
      if (range) headers["Range"] = range;
      return new Response(lyric, { headers });
    }
    const it = await this.get(path);
    const j = await this.request("https://music.163.com/api/song/enhance/player/url", "linuxapi", { ids: "[" + it.etag! + "]", br: "999000" }, { os: "pc" });
    const url = j.data?.[0]?.url;
    if (!url) throw new Error("网易云获取播放链失败");
    const headers: Record<string, string> = { Referer: "https://music.163.com" };
    if (range) headers["Range"] = range;
    return fetch(url, { headers });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "netease_music" } };
  }

  // 上传到 NOS（需先整文件计算 MD5，故内部缓冲；见报告说明）
  async putContent(path: string, body: ReadableStream, _ct?: string): Promise<void> {
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const md5 = md5Hex(buf);
    const filename = basename(path);
    const size = buf.length;
    const ext = filename.toLowerCase().endsWith("flac") ? "flac" : "mp3";
    // check
    const check = await this.request("https://interface.music.163.com/api/cloud/upload/check", "weapi",
      { ext: "", songId: "0", version: "1", bitrate: "999000", length: String(size), md5 }, { os: "pc", appver: "2.9.7" });
    const songId = String(check.songId);
    const needUpload = !!check.needUpload;
    let resourceId = "";
    if (needUpload) {
      const tok = await this.request("https://music.163.com/weapi/nos/token/alloc", "weapi",
        { bucket: "", local: "false", type: "audio", nos_product: "3", filename, md5, ext });
      resourceId = tok.result.resourceId;
      const objectKey = tok.result.objectKey;
      const token = tok.result.token;
      const bucket = "jd-musicrep-privatecloud-audio-public";
      const lbs: any = await fetch("https://wanproxy.127.net/lbs?version=1.0&bucketname=" + bucket).then((r) => r.json());
      const host: string = (lbs.upload && lbs.upload[0]) || "";
      const ok = await fetch(`${host}/${bucket}/${objectKey.replace(/\//g, "%2F")}?offset=0&complete=true&version=1.0`, {
        method: "POST",
        headers: { "x-nos-token": token, "Content-Type": "audio/mpeg", "Content-Length": String(size), "Content-MD5": md5 },
        body: buf,
      });
      if (!ok.ok) throw new Error(`网易云 NOS 上传失败 ${ok.status}`);
    }
    // publish
    const info = await this.request("https://music.163.com/api/upload/cloud/info/v2", "weapi",
      { md5, filename, song: filename.replace(/\.[^.]+$/, ""), album: "未知专辑", artist: "未知艺术家", songid: songId, resourceId, bitrate: "999000" });
    await this.request("https://interface.music.163.com/api/cloud/pub/v2", "weapi", { songid: String(info.songId) });
  }

  async remove(path: string): Promise<void> {
    const it = await this.get(path);
    await this.request("http://music.163.com/weapi/cloud/del", "weapi", { songIds: "[" + it.etag! + "]" });
  }
  async mkdir(_p: string): Promise<void> { throw new Error("网易云不支持建目录"); }
  async rename(_f: string, _t: string): Promise<void> { throw new Error("网易云不支持重命名"); }
  async move(_f: string, _t: string): Promise<void> { throw new Error("网易云不支持移动"); }
}
