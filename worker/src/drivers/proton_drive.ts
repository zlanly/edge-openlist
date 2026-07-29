import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { CloudBase } from "./cloud-base";

// Proton Drive —— 本驱动在 CF Worker 中**无法忠实实现**，故此处仅给出占位实现并显式抛出错误，
// 不做任何伪造。原因（基于对 OpenList drivers/proton_drive 全部 .go 源码的核实）：
//   - 上游 driver.go / util.go 几乎不实现协议细节，全部委托给第三方 Go 库：
//       github.com/henrybear327/Proton-API-Bridge、github.com/henrybear327/go-proton-api、
//       github.com/ProtonMail/gopenpgp/v2。
//   - 登录需要 SRP-6a（2048-bit 群、SHA-512）协商会话密钥；元数据（文件名/节点密码）用 OpenPGP
//     (gopenpgp) 加解密、KeyRing 管理与会话密钥重加密；文件体按 Proton 自定义分块 AES-GCM 加解密。
//   - 这些密码学原语与协议状态机在 WebCrypto 中**没有等价实现**：WebCrypto 不提供 SRP、不提供
//     OpenPGP(PGP) 加解密、也不提供 Proton 的分块信封格式。在 Worker 内从零重写 SRP+OpenPGP+
//     Proton 文件密码学属于数万行级别且需对齐私有协议，超出可移植范围，且无法验证正确性。
//   - 端点虽可在 util.go 中看到（如 /api/drive/v2/volumes/{volume}/links/{id}/rename），
//     但请求体（加密后的 Name/NodePassphrase/Hash）必须由 gopenpgp 生成，无法手工构造。
// 最小可行替代：保留对 Proton Drive 的只读 WebDAV/转发需要其官方客户端，或改用其桌面客户端；
// 在 EdgeOpenList 中建议将其标记为 unsupported，等待上游提供 WASM/JS 版 bridge。
export class ProtonDriveDriver extends CloudBase {
  readonly id = "proton_drive";

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    throw new Error(
      "Proton Drive 在 CF Worker 中不可实现：依赖 Proton-API-Bridge + gopenpgp（SRP 登录 + OpenPGP 元数据 + 自定义 AES-GCM 分块），WebCrypto 无对应原语，无法忠实移植。"
    );
  }

  protected async hdrs(): Promise<Record<string, string>> {
    throw new Error("Proton Drive 未实现");
  }

  async list(_path: string): Promise<FileItem[]> {
    throw new Error("Proton Drive 未实现（缺少 OpenPGP/SRP 依赖）");
  }
  async get(_path: string): Promise<FileItem> {
    throw new Error("Proton Drive 未实现（缺少 OpenPGP/SRP 依赖）");
  }
  async getContent(_path: string, _range?: string): Promise<Response | string> {
    throw new Error("Proton Drive 未实现（下载需 Proton AES-GCM 解密）");
  }
  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error("Proton Drive 未实现（上传需 Proton AES-GCM 加密）");
  }
  async mkdir(_path: string): Promise<void> {
    throw new Error("Proton Drive 未实现（需 Proton 节点密钥加密）");
  }
  async remove(_path: string): Promise<void> {
    throw new Error("Proton Drive 未实现");
  }
  async rename(_from: string, _to: string): Promise<void> {
    throw new Error("Proton Drive 未实现（需 OpenPGP 重加密节点密码）");
  }
  async move(_from: string, _to: string): Promise<void> {
    throw new Error("Proton Drive 未实现（需 OpenPGP 重加密节点密码）");
  }
}
