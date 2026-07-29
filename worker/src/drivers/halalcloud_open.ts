import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { CloudBase } from "./cloud-base";

// HalalCloud 开放版驱动 —— CF Worker 中【不移植 / 不伪造】。
//
// 原因（已核实 OpenList drivers/halalcloud_open/*）：
//   1. 上传基于内容寻址（IPFS/CID）分片模型：drivers/halalcloud_open/halalcloud_upload.go
//      使用 github.com/ipfs/go-cid 对每个分片计算 CIDv1（自定义 codec/multihash），
//      先 POST 每个分片（x-content-cid / x-task-id），再 makeFile 组合成文件。
//      下载（driver_get_link.go）则需按 result.Sizes 重新拼装分片流并校验 sha1
//      （openObject 分片重组读取器）。
//   2. 所有元操作走 `github.com/halalcloud/golang-sdk-lite` 这一**专有 REST SDK**，
//      其网关端点、鉴权头、请求/响应结构在 Go 之外无公开 TypeScript 等价物，
//      也无法仅从 OpenList 源码完整还原（SDK 内部未内联）。
//   3. 要在 Worker 忠实实现需引入 multiformats CID 库 + 复刻该私有 SDK 的全部 REST 契约，
//      工作量大且无法在此环境用真实账号验证，属于“不可行/高风险”移植。
//
// 因此本文件仅作占位，所有方法抛出明确错误，不做伪造实现。

const REASON =
  "HalalCloudOpen 依赖 IPFS/CID 分片寻址与专有 REST SDK（无 TS 等价物），不在此移植";

export class HalalCloudOpenDriver extends CloudBase {
  readonly id = "halalcloud_open";

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    throw new Error(REASON);
  }

  protected async hdrs(): Promise<Record<string, string>> {
    throw new Error(REASON);
  }

  async list(_path: string): Promise<FileItem[]> {
    throw new Error(REASON);
  }
  async get(_path: string): Promise<FileItem> {
    throw new Error(REASON);
  }
  async getContent(_path: string, _range?: string): Promise<Response | string> {
    throw new Error(REASON);
  }
  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error(REASON);
  }
  async mkdir(_path: string): Promise<void> {
    throw new Error(REASON);
  }
  async remove(_path: string): Promise<void> {
    throw new Error(REASON);
  }
  async rename(_from: string, _to: string): Promise<void> {
    throw new Error(REASON);
  }
  async move(_from: string, _to: string): Promise<void> {
    throw new Error(REASON);
  }
}

export type _Avoid = Env | DriverConfig;
