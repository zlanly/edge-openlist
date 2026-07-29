import type { DriverConfig } from "../types";
import { XunLeiBase } from "./xunlei-base";

// 迅雷云盘（OAuth2 refresh_token + captcha 签名）。端点来自 OpenList drivers/thunder。
export class ThunderDriver extends XunLeiBase {
  readonly id = "thunder";
  async init(cfg: DriverConfig): Promise<void> {
    this.clientID = "Xp6vsxz_7IYVw2BB";
    this.clientSecret = "Xp6vsy4tN9toTVdMSpomVdXpRmES";
    this.clientVersion = "8.31.0.9726";
    this.packageName = "com.xunlei.downloadprovider";
    this.algorithms = [
      "9uJNVj/wLmdwKrJaVj/omlQ", "Oz64Lp0GigmChHMf/6TNfxx7O9PyopcczMsnf", "Eb+L7Ce+Ej48u",
      "jKY0", "ASr0zCl6v8W4aidjPK5KHd1Lq3+t+vBFf41dqv5+fnOd", "wQlozdg6r1qxh0eRmt3QgNXOvSZO6q/GXK",
      "gmirk+ciAvIgA/cxUUCema47jr/YToixTT+Q6O", "5IiCoM9B1/788ntB", "P07JH0h6qoM6TSUAK2aL9T5s2QBVeY9JWvalf", "+oK0AN",
    ];
    this.space = "";
    await super.init(cfg);
  }
}
