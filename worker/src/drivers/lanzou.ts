import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// 蓝奏云。支持 cookie/account（需 uid+vei）与 share url 两种模式；
// 下载链解析涉及分享页 HTML 抓取、acw_sc__v2 反爬与 ajaxm/ajax 二次请求。
export class LanZouDriver extends CloudBase {
  readonly id = "lanzou";
  private uid = "";
  private vei = "";
  private acw = ""; // acw_sc__v2 反爬 cookie

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private isCookie(): boolean { return this.cfgStr("type") === "cookie"; }
  private isAccount(): boolean { return this.cfgStr("type") === "account"; }
  private get baseUrl(): string { return this.cfgStr("baseUrl") || "https://pc.woozooo.com"; }
  private get shareUrl(): string { return this.cfgStr("shareUrl") || "https://pan.lanzoui.com"; }
  private get ua(): string { return this.cfgStr("user_agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.39 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.39"; }

  protected async hdrs(): Promise<Record<string, string>> {
    const h: Record<string, string> = { Referer: "https://pc.woozooo.com", "User-Agent": this.ua };
    let cookie = this.cfgStr("cookie") || "";
    if (cookie) {
      cookie += "; ";
    }
    cookie += "down_ip=1";
    if (this.acw) cookie += "; acw_sc__v2=" + this.acw;
    h["Cookie"] = cookie;
    return h;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    if (this.isAccount()) {
      const c = await this.Login();
      this.cfg = { ...this.cfg, cookie: c };
    }
    if (this.isCookie() || this.isAccount()) {
      if (!this.cfgStr("root_id")) this.cfg = { ...this.cfg, root_id: "-1" } as DriverConfig;
      const [vei, uid] = await this.getVeiAndUid();
      this.vei = vei; this.uid = uid;
    }
  }

  // ===== acw_sc__v2 反爬 =====
  private calcAcwScV2(html: string): string {
    const m = html.match(/arg1='([0-9A-Z]+)'/);
    if (!m) throw new Error("无法匹配 arg1");
    const arg1 = m[1];
    const box = [6,28,34,31,33,18,30,23,9,8,19,38,17,24,0,5,32,21,10,22,25,14,15,3,16,27,13,35,2,29,11,26,4,36,1,39,37,7,20,12];
    const nb: string[] = new Array(arg1.length);
    for (let i = 0; i < box.length; i++) {
      const j = box[i];
      if (nb.length > j) nb[j] = arg1[i];
    }
    const unbox = nb.join("");
    const mask = "3000176000856006061501533003690027800375";
    const b1 = hexToBytes(unbox), b2 = hexToBytes(mask);
    const min = Math.min(b1.length, b2.length);
    const out = new Uint8Array(min);
    for (let i = 0; i < min; i++) out[i] = b1[i] ^ b2[i];
    return bytesToHex(out);
  }

  // 处理 acw_sc__v2 的通用 GET（返回最终 HTML 文本）
  private async getHtml(url: string): Promise<string> {
    for (let i = 0; i < 3; i++) {
      const headers = await this.hdrs();
      if (this.acw) headers["Cookie"] += "; acw_sc__v2=" + this.acw;
      const r = await fetch(url, { headers });
      const txt = await r.text();
      if (txt.includes("acw_sc__v2")) {
        this.acw = this.calcAcwScV2(txt);
        continue;
      }
      return txt;
    }
    throw new Error("acw_sc__v2 校验失败");
  }

  async Login(): Promise<string> {
    const fd = new FormData();
    fd.set("task", "3");
    fd.set("uid", this.cfgStr("account"));
    fd.set("pwd", this.cfgStr("password"));
    const r = await fetch("https://up.woozooo.com/mlogin.php", { method: "POST", body: fd });
    const j = (await r.json()) as any;
    if (j.zt != 1) throw new Error(`蓝奏登录失败: ${JSON.stringify(j)}`);
    const sc = r.headers.get("set-cookie") || "";
    return sc.split(",").map((c) => c.split(";")[0]).join("; ");
  }

  private async getVeiAndUid(): Promise<[string, string]> {
    const url = `${this.baseUrl}/mydisk.php?item=files&action=index`;
    const txt = await this.getHtml(url);
    const um = txt.match(/uid=([^'"&;]+)/);
    if (!um) throw new Error("uid 未找到");
    const uid = um[1];
    const vei = htmlJsonToMap(removeNotes(txt))["vei"] || "";
    return [vei, uid];
  }

  // ===== doupload.php 表单调用 =====
  private async doupload(form: Record<string, string>, retry = false): Promise<any> {
    const url = `${this.baseUrl}/doupload.php?uid=${this.uid}&vei=${this.vei}`;
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.set(k, v);
    const r = await fetch(url, { method: "POST", headers: await this.hdrs(), body: fd });
    const j = (await r.json()) as any;
    if (j.zt === 9) throw new Error("cookie 过期");
    if (j.zt !== 1 && j.zt !== 2 && j.zt !== 4) {
      throw new Error(j.inf || j.info || "蓝奏操作失败");
    }
    return j;
  }

  async list(path: string): Promise<FileItem[]> {
    if (this.isCookie() || this.isAccount()) {
      const folderId = path === "/" ? (this.cfgStr("root_id") || "-1") : (await this.get(path)).etag!;
      const out: FileItem[] = [];
      const folders = (await this.doupload({ task: "47", folder_id: folderId })).text as any[];
      for (const f of folders || []) out.push(this.folderToItem(f, path));
      for (let pg = 1; ; pg++) {
        const files = (await this.doupload({ task: "5", folder_id: folderId, pg: String(pg) })).text as any[];
        if (!files || files.length === 0) break;
        for (const f of files) out.push(this.fileToItem(f, path));
      }
      return out;
    }
    // 分享链接模式（仅根/单文件或文件夹）
    return this.listByShare(path);
  }

  private folderToItem(f: any, base: string): FileItem {
    return { name: f.name, path: joinPath(base, f.name), is_dir: true, size: 0, modified: 0, etag: f.fol_id };
  }
  private fileToItem(f: any, base: string): FileItem {
    return {
      name: f.name_all || f.name,
      path: joinPath(base, f.name_all || f.name),
      is_dir: false,
      size: sizeStrToInt64(f.size || ""),
      modified: parseTime(f.time || "").getTime(),
      etag: f.id,
    };
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error(`蓝奏文件不存在: ${path}`);
    return it;
  }

  // ===== 分享链接列举 =====
  private async listByShare(path: string): Promise<FileItem[]> {
    const shareID = this.cfgStr("share_id") || path.replace(/^\//, "");
    const pwd = this.cfgStr("share_password") || "";
    const page = await this.getShareHtml(shareID);
    const out: FileItem[] = [];
    if (!/class="fileinfo"|id="file"|文件描述/.test(page)) {
      // 文件夹分享
      const subs = [...page.matchAll(/(?:folderlink|mbxfolder).+?href="\/(.+?)".*?filename"?>(.+?)</g)];
      for (const s of subs) out.push({ name: s[2], path: joinPath(path, s[2]), is_dir: true, size: 0, modified: 0, etag: s[1] });
      const from = htmlJsonToMap(removeNotes(page));
      from["pwd"] = pwd;
      for (let pg = 1; ; pg++) {
        from["pg"] = String(pg);
        const r = await fetch(`${this.shareUrl}/filemoreajax.php`, { method: "POST", headers: { Referer: this.shareUrl + "/" }, body: formFromMap(from) });
        const j = (await r.json()) as any;
        const list = j.text as any[];
        if (!list || list.length === 0) break;
        for (const f of list) out.push({ name: f.name_all, path: joinPath(path, f.name_all), is_dir: false, size: sizeStrToInt64(f.size || ""), modified: parseTime(f.time || "").getTime(), etag: f.id, etag2: pwd } as any);
        await sleep(1000);
      }
      return out;
    }
    // 单文件分享
    const file = await this.getFilesByShareUrl(shareID, pwd, page);
    return [{
      name: file.nameAll, path: joinPath(path, file.nameAll), is_dir: false,
      size: sizeStrToInt64(file.size || ""), modified: parseTime(file.time || "").getTime(), etag: shareID,
    }];
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    if (this.isCookie() || this.isAccount()) {
      const it = await this.get(path);
      // 取分享信息
      const share = await this.doupload({ task: "22", file_id: it.etag! });
      const fId = share.info?.f_id || share.info?.fid;
      const pwd = share.info?.pwd || "";
      const file = await this.getFilesByShareUrl(fId, pwd);
      return this.finalLink(file, range);
    }
    // 分享链接
    const shareID = this.cfgStr("share_id") || path.replace(/^\//, "");
    const pwd = this.cfgStr("share_password") || "";
    const page = await this.getShareHtml(shareID);
    const file = await this.getFilesByShareUrl(shareID, pwd, page);
    return this.finalLink(file, range);
  }

  private async finalLink(file: any, range?: string): Promise<Response | string> {
    const url = file.url;
    if (!url) throw new Error("蓝奏获取下载链失败");
    const headers: Record<string, string> = { "User-Agent": this.ua };
    if (range) headers["Range"] = range;
    return fetch(url, { headers, redirect: "follow" });
  }

  // 解析分享页 -> 下载直链（含 ajaxm.php 与二次验证 ajax.php）
  private async getFilesByShareUrl(shareID: string, pwd: string, pageData?: string): Promise<any> {
    const page = pageData || (await this.getShareHtml(shareID));
    const p = removeNotes(page);
    let baseUrl = "", downloadUrl = "", file: any = { nameAll: "", size: "", time: "", id: shareID, pwd };
    if (/pwdload|passwddiv/.test(p)) {
      const fn = getJSFunctionByName(p, "down_p");
      const param = htmlJsonToMap(fn);
      param["p"] = pwd;
      const fm = fn.match(/'\/ajaxm\.php\?file=(\d+)'/);
      const fileID = fm ? fm[1] : "";
      const resp = await this.ajaxm(fileID, param);
      file.nameAll = resp.inf;
      baseUrl = `${resp.dom}/file`;
      downloadUrl = `${baseUrl}/${resp.url}`;
    } else {
      const up = p.match(/<iframe.*?src="(.+?)"/);
      if (!up) throw new Error("未找到下载页参数");
      const data = await this.getHtml(`${this.shareUrl}${up[1]}`);
      const np = removeNotes(data);
      const param = htmlJsonToMap(np);
      const fm = np.match(/'\/ajaxm\.php\?file=(\d+)'/);
      const fileID = fm ? fm[1] : "";
      const resp = await this.ajaxm(fileID, param);
      baseUrl = `${resp.dom}/file`;
      downloadUrl = `${baseUrl}/${resp.url}`;
      const names = p.match(/<title>(.+?) - 蓝奏云<\/title>|id="filenajax">(.+?)<\/div>|var filename = '(.+?)';|<div style="font-size.+?>([^<>].+?)<\/div>|<div class="filethetext".+?>([^<>]+?)<\/div>/);
      if (names) for (const n of names.slice(1)) if (n) { file.nameAll = n; break; }
    }
    const sizes = p.match(/大小\W*([0-9.]+\s*[bkm]+)/i);
    if (sizes) file.size = sizes[1];
    file.time = (p.match(/\d+\s*[秒天分小][钟时]?前|[昨前]天|\d{4}-\d{2}-\d{2}/) || [])[0] || "";
    // 302 重定向获取真实链接
    const r = await fetch(downloadUrl, { headers: { "accept-language": "zh-CN,zh;q=0.9", Referer: baseUrl, "User-Agent": this.ua, cookie: "down_ip=1" + (this.acw ? "; acw_sc__v2=" + this.acw : "") }, redirect: "manual" });
    if (r.status === 302) {
      file.url = r.headers.get("location") || "";
      return file;
    }
    // 二次验证
    const body = await r.text();
    if (body.includes("acw_sc__v2")) this.acw = this.calcAcwScV2(body);
    const p2 = htmlJsonToMap(body);
    p2["el"] = "2";
    await sleep(2000);
    const ar = await fetch(`${baseUrl}/ajax.php`, { method: "POST", headers: { cookie: "down_ip=1", "User-Agent": this.ua, Referer: baseUrl }, body: formFromMap(p2) });
    const aj = (await ar.json()) as any;
    file.url = aj.url;
    return file;
  }

  private async ajaxm(fileID: string, param: Record<string, string>): Promise<any> {
    const r = await fetch(`${this.shareUrl}/ajaxm.php?file=${fileID}`, { method: "POST", headers: { Referer: this.shareUrl + "/" }, body: formFromMap(param) });
    return (await r.json()) as any;
  }

  private async getShareHtml(shareID: string): Promise<string> {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${this.shareUrl}/${shareID}`, { headers: { "User-Agent": this.ua } });
      const txt = await r.text();
      if (txt.includes("取消分享")) throw new Error("分享已取消");
      if (txt.includes("文件不存在")) throw new Error("文件不存在");
      if (txt.includes("acw_sc__v2")) { this.acw = this.calcAcwScV2(txt); continue; }
      return txt;
    }
    throw new Error("acw_sc__v2 校验失败");
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    if (this.isCookie() || this.isAccount()) {
      return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "lanzou" } };
    }
    throw new Error("蓝奏分享模式不支持上传");
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, _size = 0): Promise<void> {
    if (!(this.isCookie() || this.isAccount())) throw new Error("蓝奏不支持该模式上传");
    const name = basename(path);
    const folderId = path === "/" ? (this.cfgStr("root_id") || "-1") : (await this.get(parentPath(path))).etag!;
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const fd = new FormData();
    fd.set("task", "1"); fd.set("vie", "2"); fd.set("ve", "2"); fd.set("id", "WU_FILE_0");
    fd.set("name", name); fd.set("folder_id_bb_n", folderId);
    fd.set("upload_file", new Blob([buf], { type: "application/octet-stream" }), name);
    const r = await fetch(`${this.baseUrl}/html5up.php`, { method: "POST", headers: await this.hdrs(), body: fd });
    const j = (await r.json()) as any;
    if (!j.text || !j.text[0]) throw new Error("蓝奏上传失败");
  }

  async mkdir(path: string): Promise<void> {
    if (!(this.isCookie() || this.isAccount())) throw new Error("不支持");
    await this.doupload({
      task: "2", parent_id: parentPath(path) === "/" ? (this.cfgStr("root_id") || "-1") : (await this.get(parentPath(path))).etag!, folder_name: basename(path), folder_description: "",
    });
  }
  async remove(path: string): Promise<void> {
    if (!(this.isCookie() || this.isAccount())) throw new Error("不支持");
    const it = await this.get(path);
    await this.doupload(it.is_dir ? { task: "3", folder_id: it.etag! } : { task: "6", file_id: it.etag! });
  }
  async rename(from: string, to: string): Promise<void> {
    if (!(this.isCookie() || this.isAccount())) throw new Error("不支持");
    const it = await this.get(from);
    if (it.is_dir) throw new Error("蓝奏不支持重命名文件夹");
    await this.doupload({ task: "46", file_id: it.etag!, file_name: basename(to), type: "2" });
  }
  async move(from: string, to: string): Promise<void> {
    if (!(this.isCookie() || this.isAccount())) throw new Error("不支持");
    const it = await this.get(from);
    if (it.is_dir) throw new Error("蓝奏仅支持移动文件");
    await this.doupload({ task: "20", folder_id: (await this.get(parentPath(to))).etag!, file_id: it.etag! });
  }
}

// ===== 工具函数 =====
function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function formFromMap(m: Record<string, string>): string {
  return Object.entries(m).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
function removeNotes(html: string): string {
  return html.replace(/<!--.*?-->/gs, "\n").replace(/(^|[^:])(\/\/.*)/g, "$1");
}
function removeJSComment(data: string): string {
  let res = "", inC = false, inS = false;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (inS) { res += v; if (v === "\n" || v === "\r") inS = false; continue; }
    if (inC && v === "*" && data[i + 1] === "/") { inC = false; i++; continue; }
    if (inC || inS) { continue; }
    if (v === "/" && data[i + 1] === "*") { inC = true; i++; continue; }
    if (v === "/" && data[i + 1] === "/") { inS = true; i++; continue; }
    res += v;
  }
  return res;
}
function findKVAll(data: string): [string, string][] {
  const re = /'(.+?)':('?([^' },]*)'?)/g; const out: [string, string][] = []; let m;
  while ((m = re.exec(data))) out.push([m[1], m[3] || ""]);
  return out;
}
function findJSVar(key: string, html: string): string {
  const m = html.match(new RegExp(`var\\s+${key}\\s*=\\s*['"]?(.+?)['"]?;`));
  return m ? m[1] : "";
}
function htmlJsonToMap(html: string): Record<string, string> {
  const m = html.match(/data[:\s]+({[^}]+})/);
  if (!m) throw new Error("未找到 data");
  const param: Record<string, string> = {};
  for (const [k, v] of findKVAll(m[1])) {
    if (v === "" || v.includes("'") || /^\d+$/.test(v)) param[k] = v;
    else param[k] = findJSVar(v, html);
  }
  return param;
}
function getJSFunctionByName(html: string, name: string): string {
  const re = /function\s+[^(]*\([^)]*\)\s*\{/g; let m; const idxs: [number, number][] = [];
  while ((m = re.exec(html))) {
    const start = m.index; let depth = 0;
    for (let i = m[0].length; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") { depth--; if (depth === 0) { idxs.push([start, i + 1]); break; } }
    }
  }
  for (const [a, b] of idxs) {
    const data = html.slice(a, b);
    if (new RegExp(`function\\s+${name}\\s*\\(`).test(data)) return data;
  }
  throw new Error(`未找到 ${name} 函数`);
}
function sizeStrToInt64(size: string): number {
  const m = size.match(/([0-9.]+)\s*([bkm]+)/i);
  if (!m) return 0;
  const s = parseFloat(m[1]);
  switch (m[2].toUpperCase()) { case "B": return s; case "K": return s * 1024; case "M": return s * 1048576; }
  return 0;
}
function parseTime(str: string): Date {
  const d = new Date();
  const m = str.match(/([0-9.]*)\s*([\u4e00-\u9fa5]+)/);
  if (m) {
    const i = parseFloat(m[1]) || 0;
    switch (m[2]) {
      case "秒前": return new Date(d.getTime() - i * 1000);
      case "分钟前": return new Date(d.getTime() - i * 60000);
      case "小时前": return new Date(d.getTime() - i * 3600000);
      case "天前": return new Date(d.getTime() - i * 86400000);
      case "昨天": return new Date(d.getTime() - 86400000);
      case "前天": return new Date(d.getTime() - 2 * 86400000);
    }
  }
  const dt = new Date(str);
  return isNaN(dt.getTime()) ? d : dt;
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
