import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// 天翼云盘（个人版）（OpenList 源码核对：drivers/189/{driver.go,login.go,util.go,meta.go}）
//
// 认证：Cookie（Addition.Cookie，绕开 RSA 登录）或用户名/密码 RSA 登录（newLogin：
//   appConf.do → encryptConf.do → loginSubmit.do，密码用 RSA PKCS#1 v1.5 加密）。
//   WebCrypto 不提供 RSAES-PKCS1-v1_5 *加密*，故密码登录无法在 Worker 复刻；
//   本驱动采用 Cookie 登录态（与 Addition 注释 “Fill in the cookie if need captcha” 一致）。
//
// 管理类 API（list/download/mkdir/remove/rename/move）均为公开可验证的 REST 端点，
// 已忠实移植。上传（newUpload）依赖 uploadRequest：用服务端 RSA 公钥加密随机密钥 `l`
// （RSA PKCS#1 v1.5）+ AES + HMAC —— 其中 RSA 加密在 Worker 无法实现，故标记不可实现。

const API = "https://cloud.189.cn";

export class Cloud189Driver extends CloudBase {
  readonly id = "189";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  protected async hdrs(): Promise<Record<string, string>> {
    return { Cookie: this.cfgStr("cookie"), Referer: "https://cloud.189.cn/" };
  }

  private async apiGet<T>(path: string, q: Record<string, string>): Promise<T> {
    const url = `${API}${path}?${new URLSearchParams(q)}`;
    const r = await fetch(url, { headers: await this.hdrs() });
    if (!r.ok) throw new Error(`189 GET ${r.status} ${url}`);
    const j = (await r.json()) as any;
    if (j.res_code != null && String(j.res_code) !== "0") throw new Error(`189 err ${j.res_code}: ${j.res_message}`);
    return j as T;
  }

  private async apiPost(path: string, form: Record<string, string>): Promise<any> {
    const url = `${API}${path}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(await this.hdrs()) },
      body: new URLSearchParams(form).toString(),
    });
    if (!r.ok) throw new Error(`189 POST ${r.status} ${url}`);
    const j = (await r.json()) as any;
    if (j.res_code != null && String(j.res_code) !== "0") throw new Error(`189 err ${j.res_code}: ${j.res_message}`);
    return j;
  }

  private async listFolder(folderId: string): Promise<{ folderList: any[]; fileList: any[] }> {
    const folders: any[] = [];
    const files: any[] = [];
    for (let pageNum = 1;; pageNum++) {
      const j = await this.apiGet<{ fileListAO?: { folderList?: any[]; fileList?: any[] }; total?: number }>(
        "/api/open/file/listFiles.action",
        { folderId, pageSize: "100", pageNum: String(pageNum), mediaType: "0", iconOption: "5", orderBy: "lastOpTime", descending: "true" },
      );
      const pageFolders = j.fileListAO?.folderList || [];
      const pageFiles = j.fileListAO?.fileList || [];
      folders.push(...pageFolders);
      files.push(...pageFiles);
      const count = pageFolders.length + pageFiles.length;
      const total = Number(j.total ?? (j.fileListAO as any)?.total ?? NaN);
      if (count === 0 || count < 100 || (Number.isFinite(total) && folders.length + files.length >= total)) break;
    }
    return { folderList: folders, fileList: files };
  }

  private async resolveFolder(path: string): Promise<string> {
    if (path === "/" || path === "") return "-11";
    let folderId = "-11";
    for (const name of path.split("/").filter(Boolean)) {
      const listing = await this.listFolder(folderId);
      const folder = listing.folderList.find((x) => x.name === name);
      if (!folder) throw new Error("not found: " + path);
      folderId = String(folder.id);
    }
    return folderId;
  }

  private async resolve(path: string): Promise<{ id: string; isDir: boolean }> {
    const dirId = await this.resolveFolder(parentPath(path));
    const name = basename(path);
    const listing = await this.listFolder(dirId);
    const f = listing.folderList.find((x) => x.name === name);
    if (f) return { id: String(f.id), isDir: true };
    const fi = listing.fileList.find((x) => x.name === name);
    if (fi) return { id: String(fi.id), isDir: false };
    throw new Error("not found: " + path);
  }

  async list(path: string): Promise<FileItem[]> {
    const folderId = await this.resolveFolder(path);
    const listing = await this.listFolder(folderId);
    const out: FileItem[] = [];
    for (const f of listing.folderList) {
      out.push({ name: f.name, path: joinPath(path, f.name), is_dir: true, size: 0, modified: Date.parse(f.lastOpTime) || 0 });
    }
    for (const f of listing.fileList) {
      out.push({ name: f.name, path: joinPath(path, f.name), is_dir: false, size: Number(f.size || 0), modified: Date.parse(f.lastOpTime) || 0 });
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const r = await this.resolve(path);
    return { name: basename(path), path, is_dir: r.isDir, size: 0, modified: 0, etag: r.id };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const r = await this.resolve(path);
    const j = await this.apiGet<{ fileDownloadUrl: string }>("/api/portal/getFileInfo.action", { fileId: r.id });
    let url = j.fileDownloadUrl;
    if (!url) throw new Error("189 无下载地址");
    url = url.replace(/^http:/, "https:");
    // 跟随最多两次 302 拿到真实直链（与源码 Link 逻辑一致）
    let finalUrl = url;
    for (let i = 0; i < 2; i++) {
      const head = await fetch(finalUrl, { method: "GET", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
      if (head.status === 302 && head.headers.get("location")) finalUrl = head.headers.get("location")!;
      else break;
    }
    return fetch(finalUrl, range ? { headers: { Range: range, "User-Agent": "Mozilla/5.0" } } : { headers: { "User-Agent": "Mozilla/5.0" } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 上传依赖 uploadRequest：RSA PKCS#1 v1.5 加密随机密钥（WebCrypto 无此加密原语）
    // + AES + HMAC。RSA 加密不可在 CF Worker 复刻，故不可实现。
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "189" } };
  }

  async putContent(): Promise<void> {
    throw new Error(
      "189 个人版上传无法在 CF Worker 实现：uploadRequest 使用服务端 RSA 公钥对随机密钥做 RSAES-PKCS1-v1_5 加密" +
        "（WebCrypto 仅支持 RSA-OAEP/RSA-PSS，无 PKCS#1 v1.5 加密），无法忠实移植。",
    );
  }

  async mkdir(path: string): Promise<void> {
    await this.apiPost("/api/open/file/createFolder.action", {
      parentFolderId: await this.resolveFolder(parentPath(path)),
      folderName: basename(path),
    });
  }

  async remove(path: string): Promise<void> {
    const r = await this.resolve(path);
    await this.apiPost("/api/open/batch/createBatchTask.action", {
      type: "DELETE",
      targetFolderId: "",
      taskInfos: JSON.stringify([{ fileId: r.id, fileName: basename(path), isFolder: r.isDir ? 1 : 0 }]),
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const r = await this.resolve(from);
    const url = r.isDir ? "/api/open/file/renameFolder.action" : "/api/open/file/renameFile.action";
    const key = r.isDir ? "folderId" : "fileId";
    const nameKey = r.isDir ? "destFolderName" : "destFileName";
    await this.apiPost(url, { [key]: r.id, [nameKey]: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const r = await this.resolve(from);
    await this.apiPost("/api/open/batch/createBatchTask.action", {
      type: "MOVE",
      targetFolderId: await this.resolveFolder(parentPath(to)),
      taskInfos: JSON.stringify([{ fileId: r.id, fileName: basename(from), isFolder: r.isDir ? 1 : 0 }]),
    });
  }
}

export type _Avoid = Env | DriverConfig;
