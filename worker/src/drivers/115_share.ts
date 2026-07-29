import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { normalizePath } from "./base";
import { CloudBase } from "./cloud-base";

// 115 分享盘（OpenList 源码核对：drivers/115_share/driver.go + utils.go）
//
// 忠实移植声明：115_share 驱动同样委托给外部 Go SDK github.com/SheltonZhu/115driver
// （Pan115Client）。List 走 client.GetShareSnapWithUA / GetShareSnap，Link 走
// client.DownloadByShareCodeWithUA；MakeDir/Move/Rename/Remove/Put 在源码中直接返回
// errs.NotSupport。与 115/115_open 相同，真实 HTTP 契约（分享快照、按分享码下载的
// 端点与加密）封装在 SDK 内，不在本克隆中，无法还原。
//
// 故本驱动列出/取链均显式抛出“不可实现”，写操作按源码语义返回 NotSupport。
export class Pan115ShareDriver extends CloudBase {
  readonly id = "115_share";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  async list(_path: string): Promise<FileItem[]> {
    throw new Error(
      "115_share 列出无法在 CF Worker 忠实实现：依赖外部 Go SDK SheltonZhu/115driver 的 " +
        "GetShareSnap/GetShareSnapWithUA，其 HTTP 契约不在本克隆中。",
    );
  }
  async get(path: string): Promise<FileItem> {
    return { name: path, path: normalizePath(path), is_dir: false, size: 0, modified: 0 };
  }
  async getContent(_path: string, _range?: string): Promise<Response | string> {
    throw new Error(
      "115_share 取链无法在 CF Worker 忠实实现：依赖外部 Go SDK SheltonZhu/115driver 的 " +
        "DownloadByShareCodeWithUA，其 HTTP 契约不在本克隆中。",
    );
  }
  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "115_share" } };
  }
  async putContent(): Promise<void> {
    throw new Error("115_share 不支持上传（源码 errs.NotSupport）");
  }
  async mkdir(_path: string): Promise<void> {
    throw new Error("115_share 不支持建目录（源码 errs.NotSupport）");
  }
  async remove(_path: string): Promise<void> {
    throw new Error("115_share 不支持删除（源码 errs.NotSupport）");
  }
  async rename(_from: string, _to: string): Promise<void> {
    throw new Error("115_share 不支持重命名（源码 errs.NotSupport）");
  }
  async move(_from: string, _to: string): Promise<void> {
    throw new Error("115_share 不支持移动（源码 errs.NotSupport）");
  }
}

export type _Avoid = Env | DriverConfig;
