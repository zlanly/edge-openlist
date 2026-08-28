// OAuth 提供商注册表（数据驱动）。覆盖所有支持交互式授权的驱动。
// 端点 / scope 取自各平台官方 OAuth 文档与 OpenList 源码对照。
export interface OAuthProvider {
  authorize: string;
  token: string;
  scope: string;
  // 授权端点额外参数（如 Dropbox 不需要 scope，但其它可加）
  extraAuth?: Record<string, string>;
  // 令牌端点额外参数（如 Dropbox 需要 token_access_type=offline 才能拿到 refresh_token）
  extraToken?: Record<string, string>;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  onedrive: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "Files.ReadWrite Files.ReadWrite.All offline_access",
  },
  onedrive_app: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "Files.ReadWrite.All offline_access",
  },
  googledrive: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive",
  },
  google_photo: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/photoslibrary https://www.googleapis.com/auth/photoslibrary.sharing",
  },
  dropbox: {
    authorize: "https://www.dropbox.com/oauth2/authorize",
    token: "https://api.dropboxapi.com/oauth2/token",
    scope: "",
    extraToken: { token_access_type: "offline" },
  },
  yandex_disk: {
    authorize: "https://oauth.yandex.com/authorize",
    token: "https://oauth.yandex.com/token",
    scope: "cloud:disk.read cloud:disk.write",
  },
  aliyundrive_open: {
    authorize: "https://open.aliyundrive.com/oauth/authorize",
    token: "https://open.aliyundrive.com/oauth/token",
    scope: "user:base user:drive",
  },
};

export const OAUTH_PROVIDER_IDS = Object.keys(OAUTH_PROVIDERS);

// 判断某个驱动 id 是否支持交互式 OAuth 授权
export function isOAuthDriver(driver: string): boolean {
  return driver in OAUTH_PROVIDERS;
}
