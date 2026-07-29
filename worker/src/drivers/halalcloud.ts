import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { CloudBase } from "./cloud-base";

// HalalCloud 驱动 —— CF Worker 中【无法实现】。
//
// 原因（已核实 OpenList drivers/halalcloud/driver.go）：
//   所有接口（list / link / mkdir / move / rename / copy / remove / put）均通过
//   pubUserFile.NewPubUserFileClient(d.HalalCommon.serv.GetGrpcConnection()) 调用，
//   即底层强依赖 **gRPC**（github.com/city404/v6-public-rpc-proto）。
//   Cloudflare Workers 运行时不支持 gRPC（无 HTTP/2 流控 + protobuf 编解码能力），
//   且无法在 Worker 内建立到 grpcuserapi.2dland.cn 的 gRPC 连接。
//   上传虽然最终落到 AWS S3（CreateUploadToken -> s3manager），但上传令牌也由 gRPC 下发，
//   因此整条链路在 Worker 中无法重建。
//
// 故本文件仅声明驱动占位，所有方法抛出明确错误，不做伪造实现。
// 若需在边缘运行，需上游提供等价的 REST/HTTP 网关替代 gRPC。

const REASON = "HalalCloud 依赖 gRPC，无法在 Cloudflare Worker 中运行（无 gRPC 支持）";

export class HalalCloudDriver extends CloudBase {
  readonly id = "halalcloud";

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
