import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { joinPath, normalizePath } from "./base";
import { CloudBase } from "./cloud-base";

// GitHub Releases 资源（只读）。端点严格对齐 drivers/github_releases/{driver,util,types}.go
// 列表按 repo_structure 中声明的挂载点聚合；下载直链走 browser_download_url / zipball / tarball
function notSupport(op: string): never {
  throw new Error(`NotSupport: github_releases 为只读驱动，不支持 ${op}`);
}

interface MountPoint { point: string; repo: string; }
interface ReleaseAsset { name: string; size: number; browser_download_url: string; updated_at: string; created_at: string; }
interface Release {
  tag_name: string; name: string; published_at: string; created_at: string; html_url: string;
  zipball_url: string; tarball_url: string; assets: ReleaseAsset[];
}
interface FileItemX { path: string; name: string; size: number; isDir: boolean; updateAt: string; createAt: string; url: string; }

export class GitHubReleasesDriver extends CloudBase {
  readonly id = "github_releases";
  private points: MountPoint[] = [];
  private showReadme = true;
  private token = "";
  private showSourceCode = false;
  private showAllVersion = false;
  private perPage = 30;
  private maxPage = 0;
  private ghProxy = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private cfgBool(k: string): boolean {
    return (this.cfg as Record<string, unknown>)[k] === true || this.cfg[k] === "true";
  }
  private cfgNum(k: string, d: number): number {
    const v = Number(this.cfg[k]);
    return Number.isFinite(v) && v !== 0 ? v : d;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.token = this.cfgStr("token") || "";
    this.showReadme = this.cfgBool("show_readme") ? true : this.cfg["show_readme"] === undefined ? true : this.cfgBool("show_readme");
    this.showSourceCode = this.cfgBool("show_source_code");
    this.showAllVersion = this.cfgBool("show_all_version");
    this.perPage = this.cfgNum("per_page", 30);
    this.maxPage = this.cfgNum("max_page", 0);
    this.ghProxy = (this.cfgStr("gh_proxy") || "").trim();
    this.points = this.parseRepos(this.cfgStr("repo_structure") || "");
  }

  private ghead(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (this.token) h.Authorization = "Bearer " + this.token;
    return h;
  }
  private async getJSON<T>(url: string): Promise<T> {
    const r = await fetch(url, { headers: this.ghead() });
    if (r.status !== 200) throw new Error(`github_releases api ${r.status} ${url}`);
    return (await r.json()) as T;
  }

  private parseRepos(text: string): MountPoint[] {
    const pts: MountPoint[] = [];
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      const parts = l.split(":");
      let path = "/", repo = "";
      if (parts.length === 1) { repo = parts[0]; }
      else if (parts.length === 2) { path = "/" + parts[0].trim(); repo = parts[1]; }
      else throw new Error(`github_releases: 非法 repo_structure 行: ${l}`);
      pts.push({ point: normalizePath(path), repo });
    }
    return pts;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return this.ghead();
  }

  private async getLatestRelease(repo: string): Promise<Release | null> {
    return this.getJSON<Release>(`https://api.github.com/repos/${repo}/releases/latest`);
  }
  private async getAllReleases(repo: string): Promise<Release[]> {
    const all: Release[] = [];
    let page = 1;
    const maxPage = this.maxPage < 0 ? 0 : this.maxPage;
    for (;;) {
      const list = await this.getJSON<Release[]>(`https://api.github.com/repos/${repo}/releases?per_page=${this.perPage}&page=${page}`);
      if (list.length === 0) break;
      all.push(...list);
      if (maxPage > 0 && page >= maxPage) break;
      if (list.length < this.perPage) break;
      page++;
    }
    return all;
  }
  private async fetchRepoFiles(repo: string): Promise<any[]> {
    return this.getJSON<any[]>(`https://api.github.com/repos/${repo}/contents`);
  }

  private toFileItem(f: FileItemX): FileItem {
    const t = Date.parse(f.createAt || f.updateAt || "1970-01-01T00:00:00Z");
    const item: FileItem = {
      name: f.name,
      path: f.path,
      is_dir: f.isDir,
      size: f.size,
      modified: Number.isNaN(t) ? 0 : t,
    };
    if (f.url) item.etag = f.url; // 用 etag 携带下载直链
    return item;
  }

  async list(path: string): Promise<FileItem[]> {
    const cur = normalizePath(path);
    const out: FileItemX[] = [];
    const pushIfAbsent = (name: string, make: () => FileItemX) => {
      if (!out.some((o) => o.name === name)) out.push(make());
    };
    for (const point of this.points) {
      if (!this.showAllVersion) {
        const rel = await this.safe(this.getLatestRelease(point.repo));
        if (!rel) continue;
        if (point.point === cur) {
          for (const a of rel.assets) out.push({ path: joinPath(point.point, a.name), name: a.name, size: a.size, isDir: false, updateAt: a.updated_at, createAt: a.created_at, url: a.browser_download_url });
          if (this.showReadme) this.pushReadme(out, point, await this.safe(this.fetchRepoFiles(point.repo)));
          if (this.showSourceCode) this.pushSource(out, point, rel);
        } else if (point.point.startsWith(cur)) {
          const next = getNextDir(point.point, cur);
          if (!next) continue;
          const exist = out.find((o) => o.name === next);
          if (exist) exist.size += rel.assets.reduce((s, a) => s + a.size, 0);
          else out.push({ path: joinPath(cur, next), name: next, size: rel.assets.reduce((s, a) => s + a.size, 0), isDir: true, updateAt: rel.published_at, createAt: rel.created_at, url: "" });
        }
      } else {
        const rels = await this.safe(this.getAllReleases(point.repo));
        if (!rels || rels.length === 0) {
          if (point.point === cur && this.showReadme) this.pushReadme(out, point, await this.safe(this.fetchRepoFiles(point.repo)));
          continue;
        }
        if (point.point === cur) {
          for (const r of rels) out.push({ path: joinPath(point.point, r.tag_name), name: r.tag_name, size: r.assets.reduce((s, a) => s + a.size, 0), isDir: true, updateAt: r.published_at, createAt: r.created_at, url: r.html_url });
          if (this.showReadme) this.pushReadme(out, point, await this.safe(this.fetchRepoFiles(point.repo)));
        } else if (point.point.startsWith(cur)) {
          const next = getNextDir(point.point, cur);
          if (!next) continue;
          const exist = out.find((o) => o.name === next);
          const total = rels.reduce((s, r) => s + r.assets.reduce((x, a) => x + a.size, 0), 0);
          if (exist) exist.size += total;
          else out.push({ path: joinPath(cur, next), name: next, size: total, isDir: true, updateAt: rels[0].published_at, createAt: rels[0].created_at, url: "" });
        } else if (cur.startsWith(point.point)) {
          const tag = getNextDir(cur, point.point);
          if (!tag) continue;
          const r = rels.find((x) => x.tag_name === tag);
          if (r) {
            for (const a of r.assets) out.push({ path: joinPath(cur, a.name), name: a.name, size: a.size, isDir: false, updateAt: a.updated_at, createAt: a.created_at, url: a.browser_download_url });
            if (this.showSourceCode) this.pushSource(out, point, r);
          }
        }
      }
    }
    return out.map((f) => this.toFileItem(f));
  }

  private pushReadme(out: FileItemX[], point: MountPoint, files: any[] | null) {
    if (!files) return;
    for (const f of files) {
      if (f.type === "dir") continue;
      if (f.name.toLowerCase() === "readme.md" || f.name.toLowerCase().startsWith("license")) {
        if (!out.some((o) => o.name === f.name)) out.push({ path: joinPath(point.point, f.name), name: f.name, size: Number(f.size || 0), isDir: false, updateAt: "1970-01-01T00:00:00Z", createAt: "1970-01-01T00:00:00Z", url: f.download_url });
      }
    }
  }
  private pushSource(out: FileItemX[], point: MountPoint, r: Release) {
    out.push({ path: joinPath(point.point, "Source code (zip)"), name: "Source code (zip)", size: 1, isDir: false, updateAt: r.created_at, createAt: r.created_at, url: r.zipball_url });
    out.push({ path: joinPath(point.point, "Source code (tar.gz)"), name: "Source code (tar.gz)", size: 1, isDir: false, updateAt: r.created_at, createAt: r.created_at, url: r.tarball_url });
  }

  private async safe<T>(p: Promise<T>): Promise<T | null> {
    try { return await p; } catch { return null; }
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(path === "/" ? "/" : parentPathOf(path));
    const hit = items.find((i) => i.name === basenameOf(path));
    if (!hit) throw new Error("文件不存在");
    return hit;
  }

  async getContent(path: string, _range?: string): Promise<Response | string> {
    const items = await this.list(path === "/" ? "/" : parentPathOf(path));
    const hit = items.find((i) => i.name === basenameOf(path));
    if (!hit || !hit.etag) throw new Error("无法生成下载链接");
    let url = hit.etag;
    if (this.ghProxy) url = url.replace("https://github.com", this.ghProxy);
    return url;
  }

  async createUpload(_p: string, _s: number): Promise<UploadSession> { notSupport("上传"); }
  async mkdir(_p: string): Promise<void> { notSupport("创建目录"); }
  async remove(_p: string): Promise<void> { notSupport("删除"); }
  async rename(_f: string, _t: string): Promise<void> { notSupport("重命名"); }
  async move(_f: string, _t: string): Promise<void> { notSupport("移动"); }
}

function getNextDir(whole: string, base: string): string {
  base = (base.replace(/\/+$/, "") + "/");
  if (!whole.startsWith(base)) return "";
  const rest = whole.slice(base.length);
  if (!rest) return "";
  const i = rest.indexOf("/");
  return i === -1 ? rest : rest.slice(0, i);
}
function parentPathOf(p: string): string {
  const n = normalizePath(p);
  if (n === "/") return "/";
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}
function basenameOf(p: string): string {
  const n = normalizePath(p);
  if (n === "/") return "";
  return n.slice(n.lastIndexOf("/") + 1);
}
