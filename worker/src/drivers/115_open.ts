import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { normalizePath } from "./base";
import { CloudBase } from "./cloud-base";

// 115 开放版（OpenList 源码核对：drivers/115_open/{driver.go,upload.go,util.go}）
//
// 忠实移植声明：115_open 驱动 100% 委托给外部 Go SDK github.com/OpenListTeam/115-sdk-go
// （sdk.New / sdk.Client）。Init 仅做 sdk.New(WithAccessToken, WithRefreshToken)，
// 所有 List / Link / Mkdir / Move / Rename / Remove / Put 都是对 sdk.Client 方法的薄封装
// （GetFiles、DownURL、Mkdir、Move、UpdateFile、DelFile、UploadInit、UploadGetToken、
// multpartUpload）。这些方法的真实 HTTP 契约（端点、请求/响应结构、签名）全部封装在
// 该外部 SDK 内，而 SDK 不在本克隆中（无 vendor、无 go mod 缓存），无法从源码还原。
//
// 因此本驱动无法忠实移植其网络协议。下面仅实现接口骨架并显式抛出不可实现原因，
// 以免伪造任何猜测性端点。
export class Open115Driver extends CloudBase {
  readonly id = "115_open";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  protected async hdrs(): Promise<Record<string, string>> {
    // 真实鉴权由 OpenListTeam/115-sdk-go 在内部处理（access/refresh token + 内部签名），
    // 没有可在 Worker 复刻的对外 Header 契约。
    return {};
  }

  private notImpl(): never {
    throw new Error(
      "115_open 无法在 CF Worker 忠实实现：其全部 API（sdk.Client.GetFiles/DownURL/Mkdir/UploadInit…）" +
        "封装在外部 Go SDK github.com/OpenListTeam/115-sdk-go 中，源码不在本克隆，HTTP 契约不可还原。",
    );
  }

  async list(_path: string): Promise<FileItem[]> {
    this.notImpl();
  }
  async get(path: string): Promise<FileItem> {
    return { name: path, path: normalizePath(path), is_dir: false, size: 0, modified: 0 };
  }
  async getContent(_path: string, _range?: string): Promise<Response | string> {
    this.notImpl();
  }
  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "115_open" } };
  }
  async putContent(): Promise<void> {
    this.notImpl();
  }
  async mkdir(_path: string): Promise<void> {
    this.notImpl();
  }
  async remove(_path: string): Promise<void> {
    this.notImpl();
  }
  async rename(_from: string, _to: string): Promise<void> {
    this.notImpl();
  }
  async move(_from: string, _to: string): Promise<void> {
    this.notImpl();
  }
}

export type _Avoid = Env | DriverConfig;
