import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

const ENDPOINT_BUSINESS = "https://365.kdocs.cn";
const ENDPOINT_PERSONAL = "https://drive.wps.cn";

type Node = { kind: "root" } | { kind: "group"; groupID: number } | { kind: "folder"; groupID: number; fileID: number } | { kind: "file"; groupID: number; fileID: number };

// WPS 云文档（钉钉/金山）。端点与参数来自 OpenList drivers/wps。
export class WpsDriver extends CloudBase {
  readonly id = "wps";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private isPersonal(): boolean {
    return (this.cfgStr("mode") || "Personal") === "Personal";
  }
  private driveHost(): string {
    return this.isPersonal() ? ENDPOINT_PERSONAL : ENDPOINT_BUSINESS;
  }
  private drivePrefix(): string {
    return this.isPersonal() ? "" : "/3rd/drive";
  }
  private driveURL(path: string): string {
    return this.driveHost() + this.drivePrefix() + path;
  }
  private cookie(): string {
    return this.cfgStr("cookie");
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {
      Cookie: this.cookie(),
      Accept: "application/json",
      "User-Agent": this.cfgStr("custom_ua") || "Mozilla/5.0",
    };
  }

  private async apiGet(url: string): Promise<any> {
    const r = await fetch(url, { headers: { ...(await this.hdrs()), Origin: this.driveHost() } });
    if (!r.ok) throw new Error(`WPS GET ${r.status} ${url}`);
    const j = (await r.json()) as any;
    if (j.result && j.result !== "ok") throw new Error(`WPS: ${j.result} ${j.msg || ""}`);
    return j;
  }

  private async apiJson(method: string, url: string, body: unknown): Promise<any> {
    const r = await fetch(url, {
      method,
      headers: { ...(await this.hdrs()), "Content-Type": "application/json", Origin: this.driveHost() },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as any;
    if (j.result && j.result !== "ok") throw new Error(`WPS: ${j.result} ${j.msg || ""}`);
    return j;
  }

  private async getGroups(): Promise<{ groupID: number; name: string }[]> {
    if (this.isPersonal()) {
      const j = await this.apiGet(this.driveURL("/api/v3/groups"));
      return (j.groups || []).map((g: any) => ({ groupID: g.id, name: g.name }));
    }
    const cid = (await this.apiGet("https://account.kdocs.cn/api/v3/islogin")).companyid;
    const j = await this.apiGet(`${ENDPOINT_BUSINESS}/3rd/plus/groups/v1/companies/${cid}/users/self/groups/private`);
    return (j.groups || []).map((g: any) => ({ groupID: g.group_id, name: g.name }));
  }

  private async getFiles(groupID: number, parentID: number): Promise<any[]> {
    const out: any[] = [];
    let offset = 0;
    for (;;) {
      const url = `${this.driveHost()}${this.drivePrefix()}/api/v5/groups/${groupID}/files?parentid=${parentID}&offset=${offset}`;
      const j = await this.apiGet(url);
      const files = j.files || [];
      out.push(...files);
      if (j.next_offset === -1 || files.length === 0) break;
      offset = j.next_offset;
    }
    return out;
  }

  private async containerNode(): Promise<Node> {
    const rp = normalizePath(this.cfgStr("root_folder_id") || "/");
    if (rp === "/") return { kind: "root" };
    let node: Node = { kind: "root" };
    for (const seg of rp.split("/").filter(Boolean)) node = await this.childNode(node, seg);
    return node;
  }

  private async childNode(node: Node, name: string): Promise<Node> {
    if (node.kind === "root") {
      const g = (await this.getGroups()).find((x) => x.name === name);
      if (!g) throw new Error(`分组不存在: ${name}`);
      return { kind: "group", groupID: g.groupID };
    }
    if (node.kind === "group") {
      const f = (await this.getFiles(node.groupID, 0)).find((x) => x.ftype === "folder" && x.fname === name);
      if (!f) throw new Error(`目录不存在: ${name}`);
      return { kind: "folder", groupID: node.groupID, fileID: Number(f.id) };
    }
    const f = (await this.getFiles(node.groupID, node.fileID)).find((x) => x.fname === name);
    if (!f) throw new Error(`文件不存在: ${name}`);
    return f.ftype === "folder"
      ? { kind: "folder", groupID: node.groupID, fileID: Number(f.id) }
      : { kind: "file", groupID: node.groupID, fileID: Number(f.id) };
  }

  private async resolveNode(path: string): Promise<Node> {
    let node = await this.containerNode();
    for (const seg of normalizePath(path).split("/").filter(Boolean)) node = await this.childNode(node, seg);
    return node;
  }

  async list(path: string): Promise<FileItem[]> {
    const node = await this.resolveNode(path);
    if (node.kind === "root") {
      return (await this.getGroups()).map((g) => ({
        name: g.name,
        path: joinPath(path, g.name),
        is_dir: true,
        size: 0,
        modified: 0,
      }));
    }
    const files = await this.getFiles(node.kind === "group" ? node.groupID : node.groupID, node.kind === "group" ? 0 : node.fileID);
    return files.map((f) => ({
      name: f.fname,
      path: joinPath(path, f.fname),
      is_dir: f.ftype === "folder",
      size: Number(f.fsize || 0),
      modified: f.mtime ? f.mtime * 1000 : 0,
      etag: String(f.id),
    }));
  }

  async get(path: string): Promise<FileItem> {
    const node = await this.resolveNode(path);
    if (node.kind === "root") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const files = await this.getFiles(node.kind === "group" ? node.groupID : node.groupID, node.kind === "group" ? 0 : node.fileID);
    const f = files.find((x) => x.fname === basename(path));
    if (!f) throw new Error(`文件不存在: ${path}`);
    return { name: f.fname, path, is_dir: f.ftype === "folder", size: Number(f.fsize || 0), modified: f.mtime ? f.mtime * 1000 : 0, etag: String(f.id) };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const node = await this.resolveNode(path);
    if (node.kind !== "file") throw new Error("不是文件");
    const j = await this.apiGet(`${this.driveHost()}${this.drivePrefix()}/api/v5/groups/${node.groupID}/files/${node.fileID}/download?support_checksums=sha1`);
    if (!j.url) throw new Error("空下载链接");
    return fetch(j.url, range ? { headers: { Range: range, "User-Agent": this.cfgStr("custom_ua") || "Mozilla/5.0", Referer: this.driveHost() } } : { headers: { "User-Agent": this.cfgStr("custom_ua") || "Mozilla/5.0", Referer: this.driveHost() } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "wps" } };
  }

  // 注意：WPS 上传协议要求先传 sha1/sha256 再上传实体（与上游 Go 实现一致，需先读取全量计算哈希）。
  // 在此处按上游行为读取全量流计算哈希后分两步提交，无法在不知哈希前提下流式上传。
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const node = await this.resolveNode(parentPath(path));
    if (node.kind !== "group" && node.kind !== "folder") throw new Error("父目录无效");
    const groupID = node.groupID;
    const parentID = node.kind === "folder" ? node.fileID : 0;
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const sha1 = await sha1Hex(buf);
    const sha256 = await sha256Hex(buf);
    const info = await this.apiJson("PUT", this.driveURL("/api/v5/files/upload/create_update"), {
      group_id: groupID,
      name: basename(path),
      parent_id: parentID,
      sha1,
      sha256,
      size: buf.length,
    });
    if (!info.url) throw new Error("空上传链接");
    const headers: Record<string, string> = { ...(info.request?.headers || {}) };
    if (info.method && info.method.toUpperCase() === "POST") {
      const fd = new FormData();
      for (const [k, v] of Object.entries(info.request?.formData || {})) fd.append(k, v as string);
      fd.append("file", new Blob([buf]), basename(path));
      const r = await fetch(info.url, { method: "POST", headers, body: fd });
      if (!r.ok) throw new Error(`WPS 上传失败 ${r.status}`);
    } else {
      const r = await fetch(info.url, { method: "PUT", headers: { ...headers, "Content-Length": String(buf.length) }, body: buf });
      if (!r.ok) throw new Error(`WPS 上传失败 ${r.status}`);
    }
    await this.apiJson("POST", this.driveURL("/api/v5/files/file"), {
      etag: "",
      groupid: groupID,
      key: "",
      name: basename(path),
      parentid: parentID,
      sha1,
      size: buf.length,
      store: info.store || "ks3",
      storekey: "",
    });
  }

  async mkdir(path: string): Promise<void> {
    const node = await this.resolveNode(parentPath(path));
    if (node.kind !== "group" && node.kind !== "folder") throw new Error("父目录无效");
    await this.apiJson("POST", this.driveURL("/api/v5/files/folder"), {
      groupid: node.groupID,
      name: basename(path),
      parentid: node.kind === "folder" ? node.fileID : 0,
    });
  }

  async remove(path: string): Promise<void> {
    const node = await this.resolveNode(path);
    if (node.kind !== "file" && node.kind !== "folder") throw new Error("无效对象");
    await this.apiJson("POST", this.driveURL(`/api/v3/groups/${node.groupID}/files/batch/delete`), { fileids: [node.fileID] });
  }

  async rename(from: string, to: string): Promise<void> {
    const node = await this.resolveNode(from);
    if (node.kind !== "file" && node.kind !== "folder") throw new Error("无效对象");
    await this.apiJson("PUT", this.driveURL(`/api/v3/groups/${node.groupID}/files/${node.fileID}`), { fname: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const src = await this.resolveNode(from);
    const dst = await this.resolveNode(parentPath(to));
    if (src.kind !== "file" && src.kind !== "folder") throw new Error("源无效");
    if (dst.kind !== "group" && dst.kind !== "folder") throw new Error("目标无效");
    await this.apiJson("POST", this.driveURL(`/api/v3/groups/${src.groupID}/files/batch/move`), {
      fileids: [src.fileID],
      target_groupid: dst.groupID,
      target_parentid: dst.kind === "folder" ? dst.fileID : 0,
    });
  }
}

async function sha1Hex(buf: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(buf: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type _Avoid = Env | DriverConfig;
