import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// 超星小组网盘驱动（OpenList drivers/chaoxing）
// 认证：用户名/密码经 AES-CBC 加密后 fanyalogin 换取 Cookie（也可直接提供 Cookie）。
// 上传：multipart 流式代理（putContent），先 getUploadConfig 取 token/puid，再直传 pan-yz.chaoxing.com。
// API 端点已对照 openlist-src/drivers/chaoxing/*.go 核实。

const API = "https://groupweb.chaoxing.com";
const DOWNLOAD_API = "https://noteyd.chaoxing.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";

// AES-128-CBC（iv = key 前16字节），PKCS7 填充，输出 base64（对照 util.go EncryptByAES）
async function aesCbcB64(message: string, keyStr: string): Promise<string> {
  const key = new TextEncoder().encode(keyStr);
  const iv = key;
  const pt = new TextEncoder().encode(message);
  const pad = 16 - (pt.length % 16);
  const padded = new Uint8Array(pt.length + pad);
  padded.set(pt);
  padded.fill(pad, pt.length);
  const ck = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, padded);
  let s = "";
  const u = new Uint8Array(ct);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

export class ChaoXingDriver extends CloudBase {
  readonly id = "chaoxing";
  private cookie = "";
  private bbsid = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.bbsid = this.cfgStr("bbsid");
    this.cookie = this.cfgStr("cookie") || "";
    if (!this.cookie) await this.login();
  }

  private async login(): Promise<void> {
    const key = "u2oh6Vu^HWe4_AES";
    const fd = new FormData();
    fd.set("uname", await aesCbcB64(this.cfgStr("user_name"), key));
    fd.set("password", await aesCbcB64(this.cfgStr("password"), key));
    fd.set("t", "true");
    const r = await fetch("https://passport2.chaoxing.com/fanyalogin", { method: "POST", body: fd });
    const cookies = ((r.headers as any).getSetCookie?.() || []).map((c: string) => c.split(";")[0]).join("; ");
    if (!cookies) throw new Error("超星登录失败：未返回 Cookie");
    this.cookie = cookies;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    if (!this.cookie) await this.login();
    return {
      Cookie: this.cookie,
      Accept: "application/json, text/plain, */*",
      Referer: "https://chaoxing.com/",
    };
  }

  private async apiGet(pathname: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`${API}${pathname}?${qs}`, { headers: await this.hdrs() });
    const j = (await r.json()) as any;
    return j;
  }

  async list(path: string): Promise<FileItem[]> {
    const folderId = await this.resolveDirId(path);
    return this.listChildren(folderId, path);
  }

  // 调用 getResourceList（recType 1=文件 2=文件夹），返回当前目录子项
  private async listChildren(folderId: string, basePath: string): Promise<FileItem[]> {
    const out: FileItem[] = [];
    for (const recType of ["1", "2"]) {
      const j = await this.apiGet("/pc/resource/getResourceList", {
        bbsid: this.bbsid,
        folderId,
        recType,
      });
      if (j.result !== 1) throw new Error(`超星列目录失败: ${j.msg}`);
      for (const f of j.list || []) {
        if (f.content.folderName) {
          const fp = joinPath(basePath, f.content.folderName);
          out.push({
            name: f.content.folderName,
            path: fp,
            is_dir: true,
            size: 0,
            modified: Number(f.inserttime) || 0,
            etag: String(f.id),
          });
        } else {
          const fileId = f.content.fileId || f.content.objectId;
          out.push({
            name: f.content.name,
            path: joinPath(basePath, f.content.name),
            is_dir: false,
            size: Number(f.content.size) || 0,
            modified: Number(f.content.uploadDate) || 0,
            etag: `${f.id}$${fileId}`,
          });
        }
      }
    }
    return out;
  }

  // 将挂载内路径解析为超星 folderId（逐段下钻，KV 缓存加速）
  private async resolveDirId(path: string): Promise<string> {
    if (path === "/") return this.cfgStr("root_id") || "-1";
    const cacheKey = `cxdir:${this.mountId}:${path}`;
    const cached = await this.env.KV.get(cacheKey);
    if (cached) return cached;
    const segs = path.split("/").filter(Boolean);
    let curId = this.cfgStr("root_id") || "-1";
    let curPath = "/";
    for (const seg of segs) {
      const items = await this.listChildren(curId, curPath);
      const hit = items.find((i) => i.is_dir && i.name === seg);
      if (!hit) throw new Error(`超星目录不存在: ${path}`);
      curId = hit.etag as string;
      curPath = joinPath(curPath, seg);
    }
    await this.env.KV.put(cacheKey, curId);
    return curId;
  }

  async get(path: string): Promise<FileItem> {
    const parent = parentPath(path);
    const items = await this.list(parent);
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error(`超星未找到: ${path}`);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const etag = (await this.get(path)).etag;
    if (!etag || !etag.includes("$")) throw new Error("超星：目录无法下载");
    const fileId = etag.split("$")[1];
    const r = await fetch(`${DOWNLOAD_API}/screen/note_note/files/status/${fileId}`, {
      method: "POST",
      headers: { ...(await this.hdrs()), "User-Agent": UA },
    });
    const j = (await r.json()) as any;
    if (!j.download) throw new Error("超星获取下载链接失败");
    return fetch(j.download, {
      headers: {
        Cookie: this.cookie,
        Referer: "https://chaoxing.com/",
        "User-Agent": UA,
        ...(range ? { Range: range } : {}),
      },
    });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "chaoxing" } };
  }

  // 流式 multipart 上传（对照 driver.go Put / util.go Login 之外的上传段）
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const cfg = await this.getUploadConfig();
    const name = basename(path);
    const boundary = "----edgeopenlist" + Date.now().toString(16);
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    const tail =
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="_token"\r\n\r\n${cfg.token}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="puid"\r\n\r\n${cfg.puid}\r\n` +
      `--${boundary}--\r\n`;

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(head));
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              controller.enqueue(enc.encode(tail));
              controller.close();
              return;
            }
            controller.enqueue(value);
            return pump();
          });
        return pump();
      },
    });

    const up = await fetch("https://pan-yz.chaoxing.com/upload", {
      method: "POST",
      headers: {
        ...(await this.hdrs()),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: stream,
    });
    const fr = (await up.json()) as any;
    if (fr.msg !== "success") throw new Error(`超星上传失败: ${fr.msg}`);
    const param = [{ key: fr.objectId, cataid: "100000019", param: fr.data }];
    const r2 = await this.apiGet("/pc/resource/addResource", {
      bbsid: this.bbsid,
      pid: await this.resolveDirId(parentPath(path)),
      type: "yunpan",
      params: encodeURIComponent(JSON.stringify(param)),
    });
    if (r2.result !== 1) throw new Error(`超星落盘失败: ${r2.msg}`);
  }

  private async getUploadConfig(): Promise<{ token: string; puid: string }> {
    const r = await fetch(`${DOWNLOAD_API}/pc/files/getUploadConfig`, { headers: await this.hdrs() });
    const j = (await r.json()) as any;
    if (j.result !== 1) throw new Error("超星获取上传配置失败");
    return { token: j.msg.token, puid: String(j.msg.puid) };
  }

  async mkdir(path: string): Promise<void> {
    const j = await this.apiGet("/pc/resource/addResourceFolder", {
      bbsid: this.bbsid,
      name: basename(path),
      pid: await this.resolveDirId(parentPath(path)),
    });
    if (j.result !== 1) throw new Error(`超星创建目录失败: ${j.msg}`);
  }

  async remove(path: string): Promise<void> {
    const etag = (await this.get(path)).etag!;
    if (etag.includes("$")) {
      const j = await this.apiGet("/pc/resource/deleteResourceFile", {
        bbsid: this.bbsid,
        recIds: etag.split("$")[0],
      });
      if (!j.status) throw new Error(`超星删除文件失败: ${j.msg}`);
    } else {
      const j = await this.apiGet("/pc/resource/deleteResourceFolder", {
        bbsid: this.bbsid,
        folderIds: etag,
      });
      if (j.result !== 1) throw new Error(`超星删除目录失败: ${j.msg}`);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const etag = (await this.get(from)).etag!;
    if (etag.includes("$")) throw new Error("超星不支持修改文件名");
    const j = await this.apiGet("/pc/resource/updateResourceFolderName", {
      bbsid: this.bbsid,
      folderId: etag,
      name: basename(to),
    });
    if (j.result !== 1) throw new Error(`超星重命名失败: ${j.msg}`);
  }

  async move(from: string, to: string): Promise<void> {
    const etag = (await this.get(from)).etag!;
    const target = await this.resolveDirId(parentPath(to));
    let j: any;
    if (etag.includes("$")) {
      j = await this.apiGet("/pc/resource/moveResource", {
        bbsid: this.bbsid,
        recIds: etag.split("$")[0],
        targetId: target,
      });
    } else {
      j = await this.apiGet("/pc/resource/moveResource", {
        bbsid: this.bbsid,
        folderIds: etag,
        targetId: target,
      });
    }
    if (!j.status) throw new Error(`超星移动失败: ${j.msg}`);
  }
}
