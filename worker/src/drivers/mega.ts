// MEGA —— 在 Cloudflare Worker 中【不可实现】，仅保留接口占位（不伪造数据）。
//
// 原因（务必阅读）：
// OpenList 的 mega 驱动依赖 github.com/t3rm1n4l/go-mega 完整客户端协议，
// 该协议需要以下原语，而 Worker 运行时的 WebCrypto / 纯 JS 均无法提供：
//   1) RSA 自定义握手：登录时服务端下发 pubkey，客户端需计算 (pubKey^d)^e mod n
//      这类「任意精度模幂」(big-integer modular exponentiation) WebCrypto 完全不支持，
//      纯 JS 实现 BigInteger 模幂代价极高且易错，超出可移植范围。
//   2) AES-ECB：MEGA 用 AES-ECB（零 IV）做密钥变换。WebCrypto 仅支持
//      AES-CBC / CTR / GCM，没有 ECB 模式，无法忠实移植。
//   3) 文件以 AES-CTR 分片加解密，且每片带逆向 MAC 校验，需完整复刻
//      go-mega 的 chunk / MAC 状态机。
//
// 结论：忠实移植需把一个数千行的协议客户端整体搬入 Worker，且核心原语受
// 运行时限制，故本驱动不提供功能实现。如需 MEGA，请在独立服务端（OpenList
// 原生 / 自建网关）代理，本 Worker 仅做转发注册。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { CloudBase } from "./cloud-base";

const NOT_SUPPORTED =
  "MEGA 在 Cloudflare Worker 中不可实现：WebCrypto 缺少 AES-ECB 与 RSA 模幂握手原语（详见文件头注释）";

export class MegaDriver extends CloudBase {
  readonly id = "mega";

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    throw new Error(NOT_SUPPORTED);
  }
  protected async hdrs(): Promise<Record<string, string>> {
    throw new Error(NOT_SUPPORTED);
  }
  async list(_path: string): Promise<FileItem[]> {
    throw new Error(NOT_SUPPORTED);
  }
  async get(_path: string): Promise<FileItem> {
    throw new Error(NOT_SUPPORTED);
  }
  async getContent(_path: string, _range?: string): Promise<Response | string> {
    throw new Error(NOT_SUPPORTED);
  }
  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error(NOT_SUPPORTED);
  }
  async mkdir(_path: string): Promise<void> {
    throw new Error(NOT_SUPPORTED);
  }
  async remove(_path: string): Promise<void> {
    throw new Error(NOT_SUPPORTED);
  }
  async rename(_from: string, _to: string): Promise<void> {
    throw new Error(NOT_SUPPORTED);
  }
  async move(_from: string, _to: string): Promise<void> {
    throw new Error(NOT_SUPPORTED);
  }
}

export type _Avoid = Env | DriverConfig;
