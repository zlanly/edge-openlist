import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

const WEBAPP = "https://www.weiyun.com/webapp/json";
const PRE_UPLOAD = "https://www.weiyun.com/api/v3/ftn_pre_upload";
const UPLOAD = "https://upload.weiyun.com/ftnup_v2/weiyun";
const BOUNDARY = "----WebKitFormBoundaryIifrOqiswelC8nfe";
const BLOCK = 1024 * 1024;

type Json = Record<string, any>;

function getCookieValue(name: string, cookie: string): string {
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
function sha1Hex(buf: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-1", buf).then((h) => [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}
// 微云 block_info 需要将 sha1 摘要（20 字节）每 4 字节倒序
function reorderSha1(hexStr: string): string {
  const b: number[] = [];
  for (let i = 0; i < hexStr.length; i += 2) b.push(parseInt(hexStr.slice(i, i + 2), 16));
  for (let g = 0; g < 20; g += 4) {
    const t = b[g]; b[g] = b[g + 3]; b[g + 3] = t;
    const t2 = b[g + 1]; b[g + 1] = b[g + 2]; b[g + 2] = t2;
  }
  return b.map((x) => x.toString(16).padStart(2, "0")).join("");
}

// 腾讯微云（Cookie 鉴权）。端点/参数/信封均来自 weiyun-sdk-go v0.1.4。
export class WeiyunDriver extends CloudBase {
  readonly id = "weiyun";
  private cookie = "";
  private rootDirKey = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private get gTk(): string {
    return getCookieValue("wyctoken", this.cookie) || "0";
  }

  protected async hdrs(): Promise<Record<string, string>> {
    this.cookie = this.cfgStr("cookie");
    return { Cookie: this.cookie, "User-Agent": "Mozilla/5.0" };
  }

  private newHeader(cmd: number, tokenInfo: Json): Json {
    return {
      seq: Math.floor(Date.now() / 1000),
      cmd,
      wx_openid: tokenInfo["openid"] || tokenInfo["minico_openid"] || "",
      qq_openid: tokenInfo["qq_openid"] || "",
      user_flag: tokenInfo["token_type"] || "",
      env_id: tokenInfo["env_id"] || "",
      type: 1, appid: 30013, version: 3, major_version: 3, minor_version: 3, fix_version: 3,
    };
  }
  private newBody(cmdName: string, data: Json, tokenInfo: Json): Json {
    return {
      ReqMsg_body: {
        ext_req_head: { token_info: tokenInfo, language_info: { language_type: 2052 } },
        [`.weiyun.${cmdName}MsgReq_body`]: data,
      },
    };
  }

  // 解析 Cookie 得到 token_info（QQ: login_key_type 27 + p_skey；微信: 192 + access_token）
  private parseTokenInfo(): Json {
    const hasWx = getCookieValue("wy_uf", this.cookie) === "1";
    if (hasWx) {
      return {
        token_type: 1,
        openid: getCookieValue("openid", this.cookie),
        open_appid: getCookieValue("wy_appid", this.cookie),
        access_token: getCookieValue("access_token", this.cookie),
        login_key_type: 192,
        login_key_value: getCookieValue("access_token", this.cookie),
      };
    }
    return {
      token_type: 0,
      login_key_type: 27,
      login_key_value: getCookieValue("p_skey", this.cookie),
      openid: "",
    };
  }

  private async request(protocol: string, name: string, cmd: number, data: Json): Promise<any> {
    const tokenInfo = this.parseTokenInfo();
    const body = {
      req_header: JSON.stringify(this.newHeader(cmd, tokenInfo)),
      req_body: JSON.stringify(this.newBody(name, data, tokenInfo)),
    };
    const url = `${WEBAPP}/${protocol}/${name}?g_tk=${encodeURIComponent(this.gTk)}&cmd=${cmd}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: this.cookie, "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`微云请求失败 ${r.status}`);
    const resp = (await r.json()) as any;
    if (resp.ret !== 0) throw new Error(`微云错误 ${resp.ret} ${resp.msg}`);
    const rspBody = resp.data?.rsp_body?.RspMsg_body || resp.result?.rsp_body?.RspMsg_body;
    if (!rspBody) throw new Error("微云响应为空");
    if (rspBody.rsp_header && rspBody.rsp_header.retcode && rspBody.rsp_header.retcode !== 0) {
      throw new Error(`微云 ${rspBody.rsp_header.retcode} ${rspBody.rsp_header.retmsg}`);
    }
    return rspBody;
  }

  private async rootKey(): Promise<string> {
    if (this.rootDirKey) return this.rootDirKey;
    const cfg = this.cfgStr("root_folder_id");
    if (cfg) return (this.rootDirKey = cfg);
    // 取主目录 key（DiskUserInfoGet -> MainDirKey 的近似：用 LibDirPathGet 兜底）
    const folders = await this.request("weiyunFileLibClient", "LibDirPathGet", 26150, { dir_key: "0" });
    const items: any[] = folders.items || [];
    this.rootDirKey = items.length ? items[items.length - 1].dir_key : "0";
    return this.rootDirKey;
  }

  // Node 模型：folder{ dirKey, pdirKey } / file{ fileId, pdirKey, name }
  private async resolve(path: string): Promise<{ kind: "folder"; dirKey: string; pdirKey: string } | { kind: "file"; fileId: string; pdirKey: string; name: string }> {
    const rt = normalizePath(path);
    if (rt === "/") {
      const k = await this.rootKey();
      return { kind: "folder", dirKey: k, pdirKey: "0" };
    }
    let dirKey = await this.rootKey();
    let pdirKey = "0";
    const parts = rt.split("/").filter(Boolean);
    // 逐层进入目录
    for (let i = 0; i < parts.length - 1; i++) {
      const list = await this.listDir(dirKey);
      const d = list.find((x) => x.is_dir && x.name === parts[i]);
      if (!d) throw new Error(`路径不存在: ${path}`);
      pdirKey = dirKey;
      dirKey = d.etag!;
    }
    const name = parts[parts.length - 1];
    const list = await this.listDir(dirKey);
    const f = list.find((x) => x.name === name);
    if (!f) throw new Error(`文件不存在: ${path}`);
    if (f.is_dir) return { kind: "folder", dirKey: f.etag!, pdirKey: dirKey };
    return { kind: "file", fileId: f.etag!, pdirKey: dirKey, name };
  }

  private async listDir(dirKey: string): Promise<FileItem[]> {
    const out: FileItem[] = [];
    for (let start = 0; ; start += 500) {
      const data = await this.request("weiyunQdisk", "DiskDirList", 2208, {
        dir_key: dirKey, start, count: 500, sort_field: 2, reverse_order: false, get_type: 0,
        get_abstract_url: false, get_dir_detail_info: false,
      });
      const dirs: any[] = data.dir_list || [];
      const files: any[] = data.file_list || [];
      for (const d of dirs) out.push({ name: d.dir_name, path: "", is_dir: true, size: 0, modified: Date.parse(d.dir_mtime) || 0, etag: d.dir_key });
      for (const f of files) out.push({ name: f.filename, path: "", is_dir: false, size: Number(f.file_size || 0), modified: Date.parse(f.file_mtime) || 0, etag: f.file_id });
      if (dirs.length + files.length < 500) break;
    }
    // 回填 path
    return out;
  }

  async list(path: string): Promise<FileItem[]> {
    const node = await this.resolve(path);
    if (node.kind !== "folder") throw new Error("不是目录");
    const items = await this.listDir(node.dirKey);
    return items.map((it) => ({ ...it, path: joinPath(path, it.name) }));
  }

  async get(path: string): Promise<FileItem> {
    const node = await this.resolve(path);
    const name = basename(path);
    if (node.kind === "folder") return { name, path, is_dir: true, size: 0, modified: 0, etag: node.dirKey };
    return { name, path, is_dir: false, size: 0, modified: 0, etag: node.fileId };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const node = await this.resolve(path);
    if (node.kind !== "file") throw new Error("不是文件");
    const data = await this.request("weiyunQdiskClient", "DiskFileBatchDownload", 2402, {
      file_list: [{ pdir_key: node.pdirKey, file_id: node.fileId, filename: node.name }],
      download_type: 0,
    });
    const item = (data.file_list || [])[0];
    if (!item || !item.download_url) throw new Error("获取下载链接失败");
    return fetch(item.download_url, {
      headers: { Cookie: `${item.cookie_name}=${item.cookie_value}`, Range: range || "" , "User-Agent": "Mozilla/5.0" },
    } as any);
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "weiyun" } };
  }

  // 微云上传：PreUpload（含分块 sha1）-> UploadPiece multipart（协议本身需全量哈希，故缓冲主体）
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parent = await this.resolve(parentPath(path));
    if (parent.kind !== "folder") throw new Error("父目录无效");
    const name = basename(path);
    const buf = new Uint8Array(await new Response(body).arrayBuffer());

    // 计算分块 sha1
    if (size !== buf.length) throw new Error(`微云上传大小不一致：声明 ${size}，实际 ${buf.length}`);
    const actualSize = buf.length;
    const count = Math.max(1, Math.ceil(actualSize / BLOCK));
    const lastBlockSize = actualSize % BLOCK === 0 ? BLOCK : actualSize % BLOCK;
    const beforeBlockSize = actualSize - lastBlockSize;
    const blockInfoList: Json[] = [];
    let checkSha = "";
    let checkData = "";
    let fileHash = "";
    const hash = new Uint8Array(0);
    void hash;
    for (let i = 0; i < count; i++) {
      const start = i * BLOCK;
      const end = Math.min(actualSize, start + BLOCK);
      const slice = buf.slice(start, end);
      const hex = await sha1Hex(slice);
      if (i === count - 1) {
        fileHash = hex;
      }
      blockInfoList.push({ sha: reorderSha1(hex), offset: start, size: slice.length });
    }
    // check_sha / check_data
    {
      const pre = buf.slice(0, beforeBlockSize);
      checkSha = reorderSha1(await sha1Hex(pre));
      const tail = buf.slice(Math.max(0, size - 128), size);
      let bin = "";
      for (const b of tail) bin += String.fromCharCode(b);
      checkData = btoa(bin);
    }

    const paramJson: Json = {
      common_upload_req: {
        ppdir_key: parent.pdirKey, pdir_key: parent.dirKey, file_size: actualSize,
        filename: name, file_exist_option: 1, use_mutil_channel: true,
      },
      upload_scr: 0, channel_count: 1, block_size: BLOCK,
      check_sha: checkSha, check_data: checkData, block_info_list: blockInfoList,
    };
    const uploadJson = {
      req_header: JSON.stringify({ cmd: 247120, appid: 30013, major_version: 3, minor_version: 0, fix_version: 0, version: 3, user_flag: 0 }),
      req_body: JSON.stringify({ ReqMsg_body: { "weiyun.PreUploadMsgReq_body": paramJson } }),
    };
    const r = await fetch(PRE_UPLOAD, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: this.cookie, "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify(uploadJson),
    });
    if (!r.ok) throw new Error(`微云预上传失败 ${r.status}`);
    const pre = (await r.json()) as any;
    if (pre.ret !== 0) throw new Error(`微云预上传 ${pre.ret} ${pre.msg}`);
    const preData = pre.data?.rsp_body?.RspMsg_body || pre.result?.rsp_body?.RspMsg_body;
    if (preData.file_exist) return; // 秒传命中

    const channel = (preData.channel_list || [{ id: 1, offset: 0, len: size }])[0];
    // UploadPiece multipart
    const pieceJson = {
      req_header: JSON.stringify({ cmd: 247121, appid: 30013, major_version: 3, minor_version: 0, fix_version: 0, version: 3, user_flag: 0 }),
      req_body: JSON.stringify({ ReqMsg_body: { "weiyun.UploadPieceMsgReq_body": { upload_key: preData.upload_key, ex: preData.ex, channel } } }),
    };
    const form: string[] = [];
    form.push(`--${BOUNDARY}`);
    form.push(`Content-Disposition: form-data; name="json"\r\n`);
    form.push(JSON.stringify(pieceJson));
    form.push(`\r\n--${BOUNDARY}`);
    form.push(`Content-Disposition: form-data; name="upload"; filename="blob"`);
    form.push("Content-Type: application/octet-stream\r\n");
    form.push("");
    const head = form.join("\r\n");
    const tail = `\r\n--${BOUNDARY}--\r\n`;
    const blob = new Blob([head, buf, tail], { type: `multipart/form-data; boundary=${BOUNDARY}` });
    const up = await fetch(UPLOAD, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`, Cookie: this.cookie, "User-Agent": "Mozilla/5.0" },
      body: blob,
    });
    if (!up.ok) throw new Error(`微云上传失败 ${up.status}`);
  }

  async mkdir(path: string): Promise<void> {
    const parent = await this.resolve(parentPath(path));
    if (parent.kind !== "folder") throw new Error("父目录无效");
    await this.request("weiyunQdiskClient", "DiskDirCreate", 2614, {
      ppdir_key: parent.pdirKey, pdir_key: parent.dirKey, dir_name: basename(path),
      file_exist_option: 2, create_type: 1,
    });
  }

  async remove(path: string): Promise<void> {
    const node = await this.resolve(path);
    if (node.kind === "folder") {
      await this.request("weiyunQdiskClient", "DiskDirFileBatchDeleteEx", 2509, {
        dir_list: [{ ppdir_key: node.pdirKey, pdir_key: node.dirKey, dir_key: node.dirKey, dir_name: basename(path) }],
      });
    } else {
      await this.request("weiyunQdiskClient", "DiskDirFileBatchDeleteEx", 2509, {
        file_list: [{ ppdir_key: node.pdirKey, pdir_key: node.pdirKey, file_id: node.fileId, filename: node.name }],
      });
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const node = await this.resolve(from);
    const name = basename(to);
    if (node.kind === "folder") {
      await this.request("weiyunQdiskClient", "DiskDirAttrModify", 2615, {
        ppdir_key: node.pdirKey, pdir_key: node.dirKey, dir_key: node.dirKey,
        src_dir_name: basename(from), dst_dir_name: name,
      });
    } else {
      await this.request("weiyunQdiskClient", "DiskFileRename", 2605, {
        ppdir_key: node.pdirKey, pdir_key: node.pdirKey, file_id: node.fileId,
        src_filename: node.name, filename: name,
      });
    }
  }

  async move(from: string, to: string): Promise<void> {
    const src = await this.resolve(from);
    const dst = await this.resolve(parentPath(to));
    if (dst.kind !== "folder") throw new Error("目标无效");
    if (src.kind === "folder") {
      await this.request("weiyunQdiskClient", "DiskDirFileBatchMove", 2618, {
        src_ppdir_key: src.pdirKey, src_pdir_key: src.dirKey,
        dir_list: [{ ppdir_key: src.pdirKey, pdir_key: src.dirKey, dir_key: src.dirKey, dir_name: basename(from) }],
        dst_ppdir_key: dst.pdirKey, dst_pdir_key: dst.dirKey,
      });
    } else {
      await this.request("weiyunQdiskClient", "DiskDirFileBatchMove", 2618, {
        src_ppdir_key: src.pdirKey, src_pdir_key: src.pdirKey,
        file_list: [{ ppdir_key: src.pdirKey, pdir_key: src.pdirKey, file_id: src.fileId, filename: src.name }],
        dst_ppdir_key: dst.pdirKey, dst_pdir_key: dst.dirKey,
      });
    }
  }
}

function concat(parts: Uint8Array[], len: number): Uint8Array {
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export type _Avoid = Env | DriverConfig;
