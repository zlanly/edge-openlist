import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// 豆包分享驱动（OpenList drivers/doubao_share）
// 认证：Cookie（hdrs 返回 {Cookie}）。只读（NoUpload）。
// 通过虚拟目录树把多个 share_id 挂载到统一路径，导航依赖 node_id。
// API 端点已对照 openlist-src/drivers/doubao_share/*.go 核实。

const BaseURL = "https://www.doubao.com";
const DirectoryType = 1;
const VideoType = 6;
const AudioType = 7;
const UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

interface ShareCfg { shareId: string; virtualPath: string }
interface Node {
  id: string; name: string; key: string; node_type: number; size: number;
  create_time: number; update_time: number;
}

export class DoubaoShareDriver extends CloudBase {
  readonly id = "doubao_share";
  private shares: ShareCfg[] = [];

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.shares = this.parseShares(this.cfgStr("share_ids") || "");
  }

  private parseShares(raw: string): ShareCfg[] {
    const out: ShareCfg[] = [];
    for (let line of raw.split("\n")) {
      line = line.trim();
      if (!line) continue;
      const parts = line.split("|").map((s) => s.trim());
      let shareId = "", vpath = "";
      if (parts.length >= 2) {
        shareId = this.extractShareId(parts[0]);
        vpath = parts[1].replace(/^\/+|\/+$/g, "");
      } else {
        shareId = this.extractShareId(parts[0]);
      }
      if (shareId) out.push({ shareId, virtualPath: vpath });
    }
    return out;
  }

  private extractShareId(input: string): string {
    const m = input.match(/\/drive\/s\/([a-zA-Z0-9]+)/);
    return m ? m[1] : input.trim();
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {
      Cookie: this.cfgStr("cookie"),
      "User-Agent": UserAgent,
    };
  }

  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    const url = `${BaseURL}${path}?version_code=20800&device_platform=web`;
    const r = await fetch(url, {
      method: "POST",
      headers: { ...(await this.hdrs()), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as any;
    if (j.code !== 0) throw new Error(`豆包分享API错误: ${j.msg || j.message || ""}`);
    return j.data;
  }

  // 递归拉取某分享目录下全部文件（对照 util.go getShareOverview / getFiles）
  private async listNodes(shareId: string, nodeId: string): Promise<Node[]> {
    const out: Node[] = [];
    let cursor = "";
    for (;;) {
      const body: Record<string, unknown> = nodeId
        ? { share_id: shareId, node_id: nodeId }
        : { share_id: shareId };
      if (cursor) {
        body.cursor = cursor;
        body.size = 50;
      } else {
        body.need_full_path = false;
      }
      const data = nodeId
        ? await this.post("/samantha/aispace/share/node_info", body)
        : await this.post("/samantha/aispace/share/overview", body);
      const children: Node[] = data.children || data.node_list || [];
      out.push(...children);
      const next: string = data.next_cursor || "";
      if (!next || next === "-1") break;
      cursor = next;
    }
    return out;
  }

  // 解析路径到 {shareId, nodeId}；虚拟目录（无真实节点）返回 nodeId=""
  private async resolveDir(path: string): Promise<{ shareId: string; nodeId: string }> {
    const clean = path.replace(/^\/+|\/+$/g, "");
    let best: ShareCfg | null = null;
    for (const cfg of this.shares) {
      if (cfg.virtualPath === clean) return { shareId: cfg.shareId, nodeId: "" };
      if (cfg.virtualPath && (clean === cfg.virtualPath || clean.startsWith(cfg.virtualPath + "/"))) {
        if (!best || cfg.virtualPath.length > best.virtualPath.length) best = cfg;
      }
    }
    if (!best) {
      // 可能是虚拟目录的祖先段，交由 list 处理虚拟项
      return { shareId: "", nodeId: "" };
    }
    const rel = best.virtualPath ? clean.slice(best.virtualPath.length + 1) : clean;
    if (!rel) return { shareId: best.shareId, nodeId: "" };
    // 逐级下钻，找到目标目录的 node_id
    let nodeId = "";
    const segs = rel.split("/");
    for (const seg of segs) {
      const nodes = await this.listNodes(best.shareId, nodeId);
      const hit = nodes.find((n) => n.node_type === DirectoryType && n.name === seg);
      if (!hit) throw new Error(`豆包分享目录不存在: ${path}`);
      nodeId = hit.id;
    }
    return { shareId: best.shareId, nodeId };
  }

  private toItem(n: Node, basePath: string, shareId: string): FileItem {
    const isDir = n.node_type === DirectoryType;
    return {
      name: n.name,
      path: joinPath(basePath, n.name),
      is_dir: isDir,
      size: isDir ? 0 : Number(n.size) || 0,
      modified: (n.update_time || n.create_time || 0) * 1000,
      etag: isDir ? "" : `${shareId}|${n.id}|${n.key}|${n.node_type}`,
    };
  }

  async list(path: string): Promise<FileItem[]> {
    const clean = path.replace(/^\/+|\/+$/g, "");
    const items: FileItem[] = [];

    // 1) 精确匹配分享根目录 + 前缀匹配分享，列出真实文件
    const dir = await this.resolveDir(path);
    if (dir.shareId) {
      const nodes = await this.listNodes(dir.shareId, dir.nodeId);
      for (const n of nodes) items.push(this.toItem(n, path, dir.shareId));
    }

    // 2) 虚拟目录：展示挂载在当前路径下的子级虚拟文件夹
    const prefix = clean === "" ? "" : clean + "/";
    const seen = new Set<string>();
    for (const cfg of this.shares) {
      const vp = cfg.virtualPath;
      if (!vp) continue;
      if (vp === clean) continue; // 已是真实分享根
      if (prefix && !vp.startsWith(prefix)) continue;
      const rest = vp.slice(prefix.length);
      const seg = rest.split("/")[0];
      if (seg && !seen.has(seg)) {
        seen.add(seg);
        items.push({
          name: seg,
          path: joinPath(path, seg),
          is_dir: true,
          size: 0,
          modified: 0,
          etag: "",
        });
      }
    }
    return items;
  }

  async get(path: string): Promise<FileItem> {
    const parent = parentPath(path);
    const items = await this.list(parent);
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error(`豆包分享未找到: ${path}`);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const etag = (await this.get(path)).etag;
    if (!etag) throw new Error("豆包分享：目录无法下载");
    const [shareId, nodeId, key, nodeTypeStr] = etag.split("|");
    const nodeType = Number(nodeTypeStr);
    let url: string;
    if (nodeType === VideoType || nodeType === AudioType) {
      const d = await this.post("/samantha/media/get_play_info", {
        key, share_id: shareId, node_id: nodeId,
      });
      url = d.original_media_info.main_url;
    } else {
      const d = await this.post("/samantha/aispace/get_download_info", {
        requests: [{ node_id: nodeId }],
      });
      url = d.download_infos[0].main_url;
    }
    const headers: Record<string, string> = { "User-Agent": UserAgent };
    if (range) headers["Range"] = range;
    return fetch(url, { headers });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "doubao_share" } };
  }
  async putContent(): Promise<void> {
    throw new Error("豆包分享驱动不支持上传 (NoUpload)");
  }
  async mkdir(): Promise<void> {
    throw new Error("豆包分享驱动不支持创建目录 (NoUpload)");
  }
  async remove(): Promise<void> {
    throw new Error("豆包分享驱动不支持删除 (NoUpload)");
  }
  async rename(): Promise<void> {
    throw new Error("豆包分享驱动不支持重命名 (NoUpload)");
  }
  async move(): Promise<void> {
    throw new Error("豆包分享驱动不支持移动 (NoUpload)");
  }
}
