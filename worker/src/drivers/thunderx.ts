import type { DriverConfig } from "../types";
import { XunLeiBase } from "./xunlei-base";

// 迅雷 X 盘（refresh_token + captcha 签名）。端点来自 OpenList drivers/thunderx。
export class ThunderXDriver extends XunLeiBase {
  readonly id = "thunderx";
  async init(cfg: DriverConfig): Promise<void> {
    this.clientID = "ZQL_zwA4qhHcoe_2";
    this.clientSecret = "Og9Vr1L8Ee6bh0olFxFDRg";
    this.clientVersion = "1.06.0.2132";
    this.packageName = "com.thunder.downloader";
    this.algorithms = [
      "kVy0WbPhiE4v6oxXZ88DvoA3Q", "lON/AUoZKj8/nBtcE85mVbkOaVdVa", "rLGffQrfBKH0BgwQ33yZofvO3Or", "FO6HWqw", "GbgvyA2",
      "L1NU9QvIQIH7DTRt", "y7llk4Y8WfYflt6", "iuDp1WPbV3HRZudZtoXChxH4HNVBX5ZALe", "8C28RTXmVcco0", "X5Xh",
      "7xe25YUgfGgD0xW3ezFS", "", "CKCR", "8EmDjBo6h3eLaK7U6vU2Qys0NsMx", "t2TeZBXKqbdP09Arh9C3",
    ];
    this.space = "";
    await super.init(cfg);
  }
}
