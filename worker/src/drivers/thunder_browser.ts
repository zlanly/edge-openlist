import type { DriverConfig } from "../types";
import { XunLeiBase } from "./xunlei-base";

// 迅雷云盘浏览器端（refresh_token + captcha 签名）。端点来自 OpenList drivers/thunder_browser。
export class ThunderBrowserDriver extends XunLeiBase {
  readonly id = "thunder_browser";
  async init(cfg: DriverConfig): Promise<void> {
    this.clientID = "ZUBzD9J_XPXfn7f7";
    this.clientSecret = "yESVmHecEe6F0aou69vl-g";
    this.clientVersion = "1.40.0.7208";
    this.packageName = "com.xunlei.browser";
    this.algorithms = [
      "Cw4kArmKJ/aOiFTxnQ0ES+D4mbbrIUsFn", "HIGg0Qfbpm5ThZ/RJfjoao4YwgT9/M", "u/PUD", "OlAm8tPkOF1qO5bXxRN2iFttuDldrg",
      "FFIiM6sFhWhU7tIMVUKOF7CUv/KzgwwV8FE", "yN", "4m5mglrIHksI6wYdq", "LXEfS7", "T+p+C+F2yjgsUtiXWU/cMNYEtJI4pq7GofW",
      "14BrGIEMXkbvFvZ49nDUfVCRcHYFOJ1BP1Y", "kWIH3Row", "RAmRTKNCjucPWC",
    ];
    this.space = "";
    await super.init(cfg);
  }
}
