// OneDrive / SharePoint 分享链接（只读）。端点与逻辑忠实移植自 OpenList
// drivers/onedrive_sharelink/*。该驱动依赖分享页 HTML/GraphQL，属高脆弱实现：
// 不同分享域名/SharePoint 站点的页面结构差异可能导致解析失败，属已知限制。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";

interface ShareItem {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  modified: number;
}

export class OnedriveSharelinkDriver extends CloudBase {
  readonly id = "onedrive_sharelink";
  private shareUrl = "";
  private password = "";
  private isSharepoint = false;
  private headers: Record<string, string> = {};
  private downloadLinkPrefix = "";
  private redirectUrl = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return this.headers;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.shareUrl = this.cfgStr("url");
    this.password = this.cfgStr("password") || "";
    this.isSharepoint = !this.shareUrl.includes("-my");
    this.headers = await this.getHeaders();
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const h = new Headers();
    h.set("User-Agent", UA);
    h.set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6");
    if (!this.password) {
      const r = await fetch(this.shareUrl, { redirect: "manual", headers: h });
      const loc = r.headers.get("location");
      if (!loc) throw new Error("password protected link, please provide password");
      this.redirectUrl = loc;
      h.set("Cookie", r.headers.get("set-cookie") || "");
      h.set("Referer", loc);
      h.set("authority", new URL(loc).host);
    } else {
      const cookie = await this.getCookiesWithPassword();
      h.set("Cookie", cookie);
      h.set("Referer", this.shareUrl);
      h.set("authority", new URL(this.shareUrl).host);
    }
    return Object.fromEntries(h.entries());
  }

  // 解析分享页登录表单并提交密码，取回 FedAuth Cookie（对应 util.go getCookiesWithPassword）
  private async getCookiesWithPassword(): Promise<string> {
    const resp = await fetch(this.shareUrl);
    const html = await resp.text();
    const getInput = (id: string): string => {
      const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
      return m ? m[1] : "";
    };
    const viewstate = getInput("__VIEWSTATE");
    const eventvalidation = getInput("__EVENTVALIDATION");
    const formM = html.match(/<form[^>]*id="inputForm"[^>]*action="([^"]*)"/);
    const postAction = formM ? formM[1] : "";
    const u = new URL(this.shareUrl);
    const newURL = `${u.protocol}//${u.host}${postAction}`;
    const body = new URLSearchParams({
      txtPassword: this.password,
      __EVENTVALIDATION: eventvalidation,
      __VIEWSTATE: viewstate,
      __VIEWSTATEENCRYPTED: "",
    });
    const r = await fetch(newURL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    const setCookie = r.headers.get("set-cookie") || "";
    const fed = setCookie
      .split(",")
      .map((c) => c.trim())
      .find((c) => c.startsWith("FedAuth="));
    if (!fed) throw new Error("wrong password");
    return fed + ";";
  }

  private graphqlUrl(): string {
    const u = new URL(this.redirectUrl || this.shareUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const cut = parts.slice(0, Math.max(0, parts.length - 3));
    return `${u.origin}/${cut.join("/")}/_api/v2.1/graphql`;
  }

  private async getFiles(path: string): Promise<ShareItem[]> {
    if (!this.redirectUrl) {
      const r = await fetch(this.shareUrl, { redirect: "manual", headers: this.headers });
      this.redirectUrl = r.headers.get("location") || this.shareUrl;
    }
    const ru = new URL(this.redirectUrl);
    const redirectUrlCut = this.redirectUrl.slice(0, this.redirectUrl.lastIndexOf("/"));
    this.downloadLinkPrefix = redirectUrlCut + "/download.aspx?UniqueId=";
    const rootFolderPre = ru.searchParams.get("id") || "";
    const rootFolder = decodeURIComponent(rootFolderPre);
    const relativePath = rootFolder.split("Documents")[0] + "Documents";
    const enc = (s: string) =>
      encodeURIComponent(s).replace(/_/g, "%5F").replace(/-/g, "%2D");
    const relativeUrl = enc(relativePath);
    const rootFolderUrl = enc(path === "/" ? rootFolder : rootFolder + path);

    const reqHeaders = new Headers({ ...this.headers, "Content-Type": "application/json;odata=verbose" });
    const graphqlVar = buildGraphql(relativePath, path === "/" ? rootFolder : rootFolder + path, relativeUrl, rootFolderUrl);
    const resp = await fetch(this.graphqlUrl(), {
      method: "POST",
      headers: reqHeaders,
      body: graphqlVar,
    });
    const j = (await resp.json()) as any;
    let items: any[] = j?.data?.legacy?.renderListDataAsStream?.listData?.row || [];
    let nextHref: string = j?.data?.legacy?.renderListDataAsStream?.listData?.nextHref || "";
    const viewMeta = j?.data?.legacy?.renderListDataAsStream?.viewMetadata?.listViewXml || "";
    while (nextHref) {
      const nh = nextHref
        .replace(/&@a1=[^&]*/, "&@a1='" + relativeUrl + "'")
        .replace(/REPLACEME/g, "%27" + relativeUrl + "%27");
      const nextUrl =
        this.graphqlUrl().replace("/_api/v2.1/graphql", "") +
        "/_api/web/GetListUsingPath(DecodedUrl=@a1)/RenderListDataAsStream" +
        nh;
      const r2 = await fetch(nextUrl, { method: "POST", headers: reqHeaders, body: renderListBody(viewMeta) });
      const j2 = (await r2.json()) as any;
      items = (items || []).concat(j2?.data?.legacy?.renderListDataAsStream?.listData?.row || []);
      nextHref = j2?.data?.legacy?.renderListDataAsStream?.listData?.nextHref || "";
    }
    return (items || []).map((it: any) => ({
      id: it.UniqueId,
      name: it.FileLeafRef,
      isFolder: it.FSObjType === "1",
      size: Number(it.File_x0020_Size || 0),
      modified: it.Modified ? Date.parse(it.Modified) : 0,
    }));
  }

  async list(path: string): Promise<FileItem[]> {
    const items = await this.getFiles(path);
    return items.map((it) => ({
      name: it.name,
      path: joinPath(path, it.name),
      is_dir: it.isFolder,
      size: it.size,
      modified: it.modified,
      etag: it.id,
    }));
  }

  async get(path: string): Promise<FileItem> {
    const parent = parentPath(path);
    const items = await this.getFiles(parent);
    const it = items.find((i) => joinPath(parent, i.name) === path);
    if (!it) throw new Error("not found: " + path);
    return {
      name: it.name,
      path,
      is_dir: it.isFolder,
      size: it.size,
      modified: it.modified,
      etag: it.id,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const it = await this.get(path);
    let uniqueId = it.etag || "";
    if (uniqueId.length > 2) uniqueId = uniqueId.slice(1, -1);
    const url = this.downloadLinkPrefix + uniqueId;
    const h: Record<string, string> = { ...this.headers };
    if (range) h["Range"] = range;
    const r = await fetch(url, { headers: h });
    if (!r.ok && r.status !== 206) throw new Error(`sharelink 下载失败 ${r.status}`);
    return r;
  }

  // 分享链接只读：以下写操作上游未实现（对应 OpenList 返回 NotImplement）
  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error("onedrive_sharelink 为只读分享，不支持上传");
  }
  async mkdir(_path: string): Promise<void> {
    throw new Error("onedrive_sharelink 为只读分享，不支持创建目录");
  }
  async remove(_path: string): Promise<void> {
    throw new Error("onedrive_sharelink 为只读分享，不支持删除");
  }
  async rename(_from: string, _to: string): Promise<void> {
    throw new Error("onedrive_sharelink 为只读分享，不支持重命名");
  }
  async move(_from: string, _to: string): Promise<void> {
    throw new Error("onedrive_sharelink 为只读分享，不支持移动");
  }
}

function buildGraphql(relativePath: string, rootFolder: string, relativeUrl: string, rootFolderUrl: string): string {
  return JSON.stringify({
    query:
      "query (\n        $listServerRelativeUrl: String!,$renderListDataAsStreamParameters: RenderListDataAsStreamParameters!,$renderListDataAsStreamQueryString: String!\n        )\n      {\n      \n      legacy {\n      \n      renderListDataAsStream(\n      listServerRelativeUrl: $listServerRelativeUrl,\n      parameters: $renderListDataAsStreamParameters,\n      queryString: $renderListDataAsStreamQueryString\n    )\n    }\n      \n      \n  perf {\n    executionTime\n    overheadTime\n    parsingTime\n    queryCount\n    validationTime\n    resolvers {\n      name\n      queryCount\n      resolveTime\n      waitTime\n    }\n  }\n    }",
    variables: {
      listServerRelativeUrl: relativePath,
      renderListDataAsStreamParameters: {
        renderOptions: 5707527,
        allowMultipleValueFilterForTaxonomyFields: true,
        addRequiredFields: true,
        folderServerRelativeUrl: rootFolder,
      },
      renderListDataAsStreamQueryString: `@a1='${relativeUrl}'&RootFolder=${rootFolderUrl}&TryNewExperienceSingle=TRUE`,
    },
  });
}
function renderListBody(listViewXml: string): string {
  return JSON.stringify({
    parameters: {
      __metadata: { type: "SP.RenderListDataParameters" },
      RenderOptions: 1216519,
      ViewXml: listViewXml,
      AllowMultipleValueFilterForTaxonomyFields: true,
      AddRequiredFields: true,
    },
  });
}

export type _Avoid = Env | DriverConfig;
