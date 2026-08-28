// 自动生成：驱动配置 schema。key 取自本仓库 driver 实际读取的 cfg 键（保证表单发出的键驱动能读到），
// 标签/类型/必填/帮助对齐 OpenList meta.go。运行 gen_schemas.js 可重新生成。
export type FieldType = "text" | "password" | "textarea" | "number" | "bool" | "select";
export interface FieldSchema {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: string | number | boolean;
  help?: string;
  options?: { label: string; value: string }[];
}
export interface DriverSchema {
  id: string;
  name: string;
  fields: FieldSchema[];
}
const SCHEMAS: Record<string, DriverSchema> = {
  "115": {
    "id": "115",
    "name": "115",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "text",
        "help": "one of QR code token and cookie required"
      }
    ]
  },
  "123": {
    "id": "123",
    "name": "123",
    "fields": [
      {
        "key": "username",
        "label": "Username",
        "type": "text",
        "required": true
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password",
        "required": true
      },
      {
        "key": "platform",
        "label": "Platform",
        "type": "text",
        "default": "web",
        "help": "the platform header value, sent with API requests"
      }
    ]
  },
  "139": {
    "id": "139",
    "name": "139",
    "fields": [
      {
        "key": "type",
        "label": "Type",
        "type": "text"
      },
      {
        "key": "authorization",
        "label": "Authorization",
        "type": "text",
        "required": true
      },
      {
        "key": "account",
        "label": "Account",
        "type": "text"
      }
    ]
  },
  "189": {
    "id": "189",
    "name": "189",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "help": "Fill in the cookie if need captcha"
      }
    ]
  },
  "115_open": {
    "id": "115_open",
    "name": "115 open",
    "fields": []
  },
  "115_share": {
    "id": "115_share",
    "name": "115 share",
    "fields": []
  },
  "123_link": {
    "id": "123_link",
    "name": "123 link",
    "fields": [
      {
        "key": "private_key",
        "label": "Private key",
        "type": "password"
      },
      {
        "key": "origin_urls",
        "label": "Origin urls",
        "type": "text",
        "required": true,
        "default": "https://vip.123pan.com/29/folder/file.mp3",
        "help": "structure:FolderName:\\n  [FileSize:][Modified:]Url"
      }
    ]
  },
  "123_open": {
    "id": "123_open",
    "name": "123 open",
    "fields": [
      {
        "key": "RefreshToken",
        "label": "Refresh Token",
        "type": "password"
      },
      {
        "key": "api_url_address",
        "label": "Api url address",
        "type": "text",
        "default": "https://api.oplist.org/123cloud/renewapi"
      },
      {
        "key": "ClientID",
        "label": "Client ID",
        "type": "text"
      },
      {
        "key": "ClientSecret",
        "label": "Client Secret",
        "type": "password"
      },
      {
        "key": "AccessToken",
        "label": "Access Token",
        "type": "password"
      },
      {
        "key": "DirectLinkPrivateKey",
        "label": "Direct Link Private Key",
        "type": "password",
        "help": "private key for direct link, if URL authentication is enabled"
      },
      {
        "key": "DirectLinkValidDuration",
        "label": "Direct Link Valid Duration",
        "type": "number",
        "default": "30",
        "help": "minutes, if URL authentication is enabled"
      }
    ]
  },
  "123_share": {
    "id": "123_share",
    "name": "123 share",
    "fields": [
      {
        "key": "AccessToken",
        "label": "Access Token",
        "type": "password"
      },
      {
        "key": "sharekey",
        "label": "Sharekey",
        "type": "password",
        "required": true
      },
      {
        "key": "sharepassword",
        "label": "Sharepassword",
        "type": "password"
      }
    ]
  },
  "189_tv": {
    "id": "189_tv",
    "name": "189 tv",
    "fields": [
      {
        "key": "type",
        "label": "Type",
        "type": "text"
      },
      {
        "key": "familyId",
        "label": "Family Id",
        "type": "text"
      }
    ]
  },
  "189pc": {
    "id": "189pc",
    "name": "189pc",
    "fields": [
      {
        "key": "type",
        "label": "Type",
        "type": "text"
      },
      {
        "key": "familyId",
        "label": "Family Id",
        "type": "text"
      }
    ]
  },
  "alias": {
    "id": "alias",
    "name": "Alias",
    "fields": [
      {
        "key": "path",
        "label": "Path",
        "type": "text"
      },
      {
        "key": "remote",
        "label": "Remote",
        "type": "text"
      },
      {
        "key": "mount_id",
        "label": "Mount id",
        "type": "text"
      }
    ]
  },
  "alidoc": {
    "id": "alidoc",
    "name": "Alidoc",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "text",
        "required": true,
        "help": "钉钉文档网页 Cookie"
      },
      {
        "key": "rootFolderId",
        "label": "根目录ID",
        "type": "text",
        "help": "根目录 ID（部分驱动用 ID 定位）"
      },
      {
        "key": "root_id",
        "label": "Root id",
        "type": "text"
      }
    ]
  },
  "alist_v3": {
    "id": "alist_v3",
    "name": "Alist v3",
    "fields": [
      {
        "key": "url",
        "label": "Url",
        "type": "text",
        "required": true
      },
      {
        "key": "meta_password",
        "label": "Meta password",
        "type": "password"
      },
      {
        "key": "root",
        "label": "Root",
        "type": "text"
      },
      {
        "key": "username",
        "label": "Username",
        "type": "text"
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password"
      },
      {
        "key": "token",
        "label": "Token",
        "type": "password"
      }
    ]
  },
  "aliyun": {
    "id": "aliyun",
    "name": "Aliyun",
    "fields": [
      {
        "key": "refreshToken",
        "label": "Refresh Token",
        "type": "password"
      },
      {
        "key": "driveId",
        "label": "Drive Id",
        "type": "text"
      }
    ]
  },
  "aliyundrive_open": {
    "id": "aliyundrive_open",
    "name": "Aliyundrive open",
    "fields": [
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password"
      },
      {
        "key": "api_url_address",
        "label": "Api url address",
        "type": "text",
        "default": "https://api.oplist.org/alicloud/renewapi"
      },
      {
        "key": "alipan_type",
        "label": "Alipan type",
        "type": "select",
        "required": true,
        "default": "default",
        "options": [
          {
            "label": "default",
            "value": "default"
          },
          {
            "label": "alipanTV",
            "value": "alipanTV"
          }
        ]
      },
      {
        "key": "client_id",
        "label": "Client id",
        "type": "text",
        "help": "Keep it empty if you don't have one"
      },
      {
        "key": "client_secret",
        "label": "Client secret",
        "type": "password",
        "help": "Keep it empty if you don't have one"
      },
      {
        "key": "drive_type",
        "label": "Drive type",
        "type": "select",
        "default": "resource",
        "options": [
          {
            "label": "default",
            "value": "default"
          },
          {
            "label": "resource",
            "value": "resource"
          },
          {
            "label": "backup",
            "value": "backup"
          }
        ]
      },
      {
        "key": "root_folder_id",
        "label": "根目录ID",
        "type": "text",
        "help": "根目录 ID（部分驱动用 ID 定位）"
      },
      {
        "key": "order_by",
        "label": "Order by",
        "type": "select",
        "options": [
          {
            "label": "name",
            "value": "name"
          },
          {
            "label": "size",
            "value": "size"
          },
          {
            "label": "updated_at",
            "value": "updated_at"
          },
          {
            "label": "created_at",
            "value": "created_at"
          }
        ]
      },
      {
        "key": "order_direction",
        "label": "Order direction",
        "type": "select",
        "options": [
          {
            "label": "ASC",
            "value": "ASC"
          },
          {
            "label": "DESC",
            "value": "DESC"
          }
        ]
      }
    ]
  },
  "aliyundrive_share": {
    "id": "aliyundrive_share",
    "name": "Aliyundrive share",
    "fields": [
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password",
        "required": true
      },
      {
        "key": "share_id",
        "label": "Share id",
        "type": "text"
      },
      {
        "key": "share_pwd",
        "label": "Share pwd",
        "type": "password"
      },
      {
        "key": "root_folder_id",
        "label": "根目录ID",
        "type": "text",
        "help": "根目录 ID（部分驱动用 ID 定位）"
      },
      {
        "key": "order_by",
        "label": "Order by",
        "type": "select",
        "options": [
          {
            "label": "name",
            "value": "name"
          },
          {
            "label": "size",
            "value": "size"
          },
          {
            "label": "updated_at",
            "value": "updated_at"
          },
          {
            "label": "created_at",
            "value": "created_at"
          }
        ]
      },
      {
        "key": "order_direction",
        "label": "Order direction",
        "type": "select",
        "options": [
          {
            "label": "ASC",
            "value": "ASC"
          },
          {
            "label": "DESC",
            "value": "DESC"
          }
        ]
      }
    ]
  },
  "autoindex": {
    "id": "autoindex",
    "name": "Autoindex",
    "fields": [
      {
        "key": "index_name",
        "label": "Index name",
        "type": "text"
      },
      {
        "key": "remote_driver",
        "label": "Remote driver",
        "type": "text"
      },
      {
        "key": "index_title",
        "label": "Index title",
        "type": "text"
      },
      {
        "key": "remote_config",
        "label": "Remote config",
        "type": "text"
      },
      {
        "key": "add_index",
        "label": "Add index",
        "type": "text"
      }
    ]
  },
  "azure_blob": {
    "id": "azure_blob",
    "name": "Azure blob",
    "fields": [
      {
        "key": "container_name",
        "label": "Container name",
        "type": "text",
        "required": true,
        "help": "The name of the container in Azure Storage (created in the Azure portal). https://learn.microsoft.com/azure/storage/blobs/blob-containers-portal"
      },
      {
        "key": "access_key",
        "label": "Access key",
        "type": "password",
        "required": true,
        "help": "The access key for Azure Storage, used for authentication. https://learn.microsoft.com/azure/storage/common/storage-account-keys-manage"
      },
      {
        "key": "sign_url_expire",
        "label": "Sign url expire",
        "type": "number",
        "default": "4",
        "help": "The expiration time for SAS URLs, in hours."
      },
      {
        "key": "root_folder_path",
        "label": "根目录路径",
        "type": "text",
        "help": "挂载到网盘内的根路径，默认 /"
      },
      {
        "key": "endpoint",
        "label": "Endpoint",
        "type": "text",
        "required": true,
        "default": "https://<accountname>.blob.core.windows.net/",
        "help": "e.g. https://accountname.blob.core.windows.net/. The full endpoint URL for Azure Storage, including the unique storage account name (3 ~ 24 numbers and lowercase letters only)."
      }
    ]
  },
  "baidu_netdisk": {
    "id": "baidu_netdisk",
    "name": "Baidu netdisk",
    "fields": [
      {
        "key": "refreshToken",
        "label": "Refresh token",
        "type": "password"
      },
      {
        "key": "useOnlineApi",
        "label": "Use online api",
        "type": "text",
        "default": "true"
      },
      {
        "key": "apiUrlAddress",
        "label": "Api url address",
        "type": "text",
        "default": "https://api.oplist.org/baiduyun/renewapi"
      },
      {
        "key": "clientId",
        "label": "Client id",
        "type": "text"
      },
      {
        "key": "clientSecret",
        "label": "Client secret",
        "type": "password"
      },
      {
        "key": "orderBy",
        "label": "Order by",
        "type": "select",
        "default": "name",
        "options": [
          {
            "label": "name",
            "value": "name"
          },
          {
            "label": "time",
            "value": "time"
          },
          {
            "label": "size",
            "value": "size"
          }
        ]
      },
      {
        "key": "orderDirection",
        "label": "Order direction",
        "type": "select",
        "default": "asc",
        "options": [
          {
            "label": "asc",
            "value": "asc"
          },
          {
            "label": "desc",
            "value": "desc"
          }
        ]
      }
    ]
  },
  "baidu_photo": {
    "id": "baidu_photo",
    "name": "Baidu photo",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "required": true
      }
    ]
  },
  "bunny_storage": {
    "id": "bunny_storage",
    "name": "Bunny storage",
    "fields": [
      {
        "key": "storage_zone_name",
        "label": "Storage zone name",
        "type": "text",
        "required": true
      },
      {
        "key": "access_key",
        "label": "Access key",
        "type": "password",
        "required": true
      },
      {
        "key": "endpoint",
        "label": "Endpoint",
        "type": "text",
        "required": true,
        "default": "storage.bunnycdn.com"
      },
      {
        "key": "cdn_base_url",
        "label": "Cdn base url",
        "type": "text"
      },
      {
        "key": "cdn_token_key",
        "label": "Cdn token key",
        "type": "password"
      },
      {
        "key": "cdn_token_method",
        "label": "Cdn token method",
        "type": "select",
        "default": "sha256",
        "options": [
          {
            "label": "sha256",
            "value": "sha256"
          },
          {
            "label": "hmac_sha256",
            "value": "hmac_sha256"
          }
        ]
      },
      {
        "key": "placeholder",
        "label": "Placeholder",
        "type": "text",
        "default": ".openlist"
      },
      {
        "key": "root_folder_path",
        "label": "根目录路径",
        "type": "text",
        "help": "挂载到网盘内的根路径，默认 /"
      }
    ]
  },
  "chaoxing": {
    "id": "chaoxing",
    "name": "Chaoxing",
    "fields": [
      {
        "key": "bbsid",
        "label": "Bbsid",
        "type": "text",
        "required": true
      },
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password"
      },
      {
        "key": "user_name",
        "label": "User name",
        "type": "text",
        "required": true
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password",
        "required": true
      },
      {
        "key": "root_id",
        "label": "Root id",
        "type": "text"
      },
      {
        "key": "token",
        "label": "Token",
        "type": "password"
      },
      {
        "key": "puid",
        "label": "Puid",
        "type": "text"
      }
    ]
  },
  "chunk": {
    "id": "chunk",
    "name": "Chunk",
    "fields": [
      {
        "key": "chunk_prefix",
        "label": "Chunk prefix",
        "type": "text",
        "default": "[openlist_chunk]",
        "help": "the prefix of chunk folder"
      },
      {
        "key": "custom_ext",
        "label": "Custom ext",
        "type": "text"
      },
      {
        "key": "remote_path",
        "label": "Remote path",
        "type": "text",
        "required": true
      },
      {
        "key": "drivers",
        "label": "Drivers",
        "type": "text"
      },
      {
        "key": "part_size",
        "label": "Part size",
        "type": "number",
        "required": true,
        "help": "bytes"
      }
    ]
  },
  "cloudreve": {
    "id": "cloudreve",
    "name": "Cloudreve",
    "fields": [
      {
        "key": "address",
        "label": "Address",
        "type": "text",
        "required": true
      },
      {
        "key": "custom_ua",
        "label": "Custom ua",
        "type": "text"
      },
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password"
      },
      {
        "key": "username",
        "label": "Username",
        "type": "text"
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password"
      }
    ]
  },
  "cloudreve_v4": {
    "id": "cloudreve_v4",
    "name": "Cloudreve v4",
    "fields": [
      {
        "key": "address",
        "label": "Address",
        "type": "text",
        "required": true
      },
      {
        "key": "custom_ua",
        "label": "Custom ua",
        "type": "text"
      },
      {
        "key": "access_token",
        "label": "Access token",
        "type": "password"
      },
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password"
      },
      {
        "key": "username",
        "label": "Username",
        "type": "text"
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password"
      },
      {
        "key": "order_by",
        "label": "Order by",
        "type": "select",
        "required": true,
        "default": "name",
        "options": [
          {
            "label": "name",
            "value": "name"
          },
          {
            "label": "size",
            "value": "size"
          },
          {
            "label": "updated_at",
            "value": "updated_at"
          },
          {
            "label": "created_at",
            "value": "created_at"
          }
        ]
      },
      {
        "key": "order_direction",
        "label": "Order direction",
        "type": "select",
        "required": true,
        "default": "asc",
        "options": [
          {
            "label": "asc",
            "value": "asc"
          },
          {
            "label": "desc",
            "value": "desc"
          }
        ]
      }
    ]
  },
  "cnb_releases": {
    "id": "cnb_releases",
    "name": "Cnb releases",
    "fields": [
      {
        "key": "repo",
        "label": "Repo",
        "type": "text",
        "required": true
      },
      {
        "key": "token",
        "label": "Token",
        "type": "password",
        "required": true
      },
      {
        "key": "default_branch",
        "label": "Default branch",
        "type": "text",
        "default": "main",
        "help": "Default branch for new releases"
      }
    ]
  },
  "crypt": {
    "id": "crypt",
    "name": "Crypt",
    "fields": [
      {
        "key": "password",
        "label": "Password",
        "type": "password",
        "required": true,
        "help": "the main password"
      },
      {
        "key": "salt",
        "label": "Salt",
        "type": "text",
        "help": "If you don't know what is salt, treat it as a second password. Optional but recommended"
      },
      {
        "key": "remote_path",
        "label": "Remote path",
        "type": "text",
        "required": true,
        "help": "This is where the encrypted data stores"
      },
      {
        "key": "remote_driver",
        "label": "Remote driver",
        "type": "text"
      },
      {
        "key": "remote_config",
        "label": "Remote config",
        "type": "text"
      }
    ]
  },
  "degoo": {
    "id": "degoo",
    "name": "Degoo",
    "fields": [
      {
        "key": "access_token",
        "label": "Access token",
        "type": "password",
        "help": "Access token for Degoo API, obtained automatically"
      },
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password",
        "help": "Refresh token for automatic token renewal, obtained automatically"
      },
      {
        "key": "username",
        "label": "Username",
        "type": "text",
        "help": "Your Degoo account email"
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password",
        "help": "Your Degoo account password"
      }
    ]
  },
  "doubao": {
    "id": "doubao",
    "name": "Doubao",
    "fields": [
      {
        "key": "download_api",
        "label": "Download api",
        "type": "select",
        "default": "get_file_url",
        "options": [
          {
            "label": "get_file_url",
            "value": "get_file_url"
          },
          {
            "label": "get_download_info",
            "value": "get_download_info"
          }
        ]
      },
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "text"
      },
      {
        "key": "mime",
        "label": "Mime",
        "type": "text"
      }
    ]
  },
  "doubao_new": {
    "id": "doubao_new",
    "name": "Doubao new",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "required": true,
        "help": "Web Cookie"
      },
      {
        "key": "app_id",
        "label": "App id",
        "type": "text",
        "required": true,
        "default": "497858",
        "help": "Doubao App ID"
      },
      {
        "key": "dpop_key_secret",
        "label": "Dpop key secret",
        "type": "password",
        "help": "DPoP Key Secret for generating DPoP token"
      },
      {
        "key": "auth_client_id",
        "label": "Auth client id",
        "type": "text",
        "help": "Doubao Biz Auth Client ID"
      },
      {
        "key": "auth_client_type",
        "label": "Auth client type",
        "type": "text",
        "help": "Doubao Biz Auth Client Type"
      },
      {
        "key": "auth_scope",
        "label": "Auth scope",
        "type": "text",
        "help": "Doubao Biz Auth Scope"
      },
      {
        "key": "auth_sdk_source",
        "label": "Auth sdk source",
        "type": "text",
        "help": "Doubao Biz Auth SDK Source"
      },
      {
        "key": "auth_sdk_version",
        "label": "Auth sdk version",
        "type": "text",
        "help": "Doubao Biz Auth SDK Version"
      },
      {
        "key": "root_id",
        "label": "Root id",
        "type": "text"
      }
    ]
  },
  "doubao_share": {
    "id": "doubao_share",
    "name": "Doubao share",
    "fields": [
      {
        "key": "share_ids",
        "label": "Share ids",
        "type": "text",
        "required": true
      },
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "text"
      },
      {
        "key": "virtualPath",
        "label": "Virtual Path",
        "type": "text"
      },
      {
        "key": "shareId",
        "label": "Share id",
        "type": "text"
      }
    ]
  },
  "dropbox": {
    "id": "dropbox",
    "name": "Dropbox",
    "fields": [
      {
        "key": "RootNamespaceId",
        "label": "Root Namespace Id",
        "type": "text"
      },
      {
        "key": "use_online_api",
        "label": "Use online api",
        "type": "text",
        "default": "false"
      },
      {
        "key": "api_url_address",
        "label": "Api url address",
        "type": "text",
        "default": "https://api.oplist.org/dropboxs/renewapi"
      },
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password"
      },
      {
        "key": "client_id",
        "label": "Client id",
        "type": "text",
        "help": "Keep it empty if you don't have one"
      },
      {
        "key": "client_secret",
        "label": "Client secret",
        "type": "password",
        "help": "Keep it empty if you don't have one"
      }
    ]
  },
  "febbox": {
    "id": "febbox",
    "name": "Febbox",
    "fields": [
      {
        "key": "client_id",
        "label": "Client id",
        "type": "text",
        "required": true
      },
      {
        "key": "client_secret",
        "label": "Client secret",
        "type": "password",
        "required": true
      },
      {
        "key": "page_size",
        "label": "Page size",
        "type": "number",
        "required": true,
        "default": "100",
        "help": "list api per page size of FebBox driver"
      },
      {
        "key": "sort_rule",
        "label": "Sort rule",
        "type": "select",
        "required": true,
        "default": "name_asc",
        "options": [
          {
            "label": "size_asc",
            "value": "size_asc"
          },
          {
            "label": "size_desc",
            "value": "size_desc"
          },
          {
            "label": "name_asc",
            "value": "name_asc"
          },
          {
            "label": "name_desc",
            "value": "name_desc"
          },
          {
            "label": "update_asc",
            "value": "update_asc"
          },
          {
            "label": "update_desc",
            "value": "update_desc"
          },
          {
            "label": "ext_asc",
            "value": "ext_asc"
          },
          {
            "label": "ext_desc",
            "value": "ext_desc"
          }
        ]
      },
      {
        "key": "root_id",
        "label": "Root id",
        "type": "text"
      },
      {
        "key": "user_ip",
        "label": "User ip",
        "type": "text",
        "help": "user ip address for download link which can speed up the download"
      }
    ]
  },
  "github": {
    "id": "github",
    "name": "Github",
    "fields": [
      {
        "key": "root",
        "label": "Root",
        "type": "text"
      },
      {
        "key": "token",
        "label": "Token",
        "type": "password",
        "required": true
      },
      {
        "key": "owner",
        "label": "Owner",
        "type": "text",
        "required": true
      },
      {
        "key": "repo",
        "label": "Repo",
        "type": "text",
        "required": true
      },
      {
        "key": "ref",
        "label": "Ref",
        "type": "text",
        "help": "A branch, a tag or a commit SHA, main branch by default."
      },
      {
        "key": "gh_proxy",
        "label": "Gh proxy",
        "type": "text",
        "help": "GitHub proxy, e.g. https://ghproxy.net/raw.githubusercontent.com or https://gh-proxy.com/raw.githubusercontent.com"
      }
    ]
  },
  "github_releases": {
    "id": "github_releases",
    "name": "Github releases",
    "fields": [
      {
        "key": "show_readme",
        "label": "Show readme",
        "type": "bool",
        "default": "true",
        "help": "show README、LICENSE file"
      },
      {
        "key": "token",
        "label": "Token",
        "type": "password",
        "help": "GitHub token, if you want to access private repositories or increase the rate limit"
      },
      {
        "key": "gh_proxy",
        "label": "Gh proxy",
        "type": "text",
        "help": "GitHub proxy, e.g. https://ghproxy.net/https://github.com or https://gh-proxy.com/https://github.com"
      },
      {
        "key": "repo_structure",
        "label": "Repo structure",
        "type": "text",
        "required": true,
        "default": "OpenListTeam/OpenList",
        "help": "structure:[path:]org/repo"
      }
    ]
  },
  "google_photo": {
    "id": "google_photo",
    "name": "Google photo",
    "fields": [
      {
        "key": "client_id",
        "label": "Client id",
        "type": "text",
        "required": true,
        "default": "202264815644.apps.googleusercontent.com"
      },
      {
        "key": "client_secret",
        "label": "Client secret",
        "type": "password",
        "required": true,
        "default": "X4Z3ca8xfWDb1Voo-F9a7ZxJ"
      },
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password",
        "required": true
      }
    ]
  },
  "googledrive": {
    "id": "googledrive",
    "name": "Googledrive",
    "fields": [
      {
        "key": "refreshToken",
        "label": "Refresh Token",
        "type": "password"
      },
      {
        "key": "clientId",
        "label": "Client Id",
        "type": "text"
      },
      {
        "key": "clientSecret",
        "label": "Client Secret",
        "type": "password"
      }
    ]
  },
  "halalcloud": {
    "id": "halalcloud",
    "name": "Halalcloud",
    "fields": []
  },
  "halalcloud_open": {
    "id": "halalcloud_open",
    "name": "Halalcloud open",
    "fields": []
  },
  "ilanzou": {
    "id": "ilanzou",
    "name": "Ilanzou",
    "fields": [
      {
        "key": "username",
        "label": "Username",
        "type": "text",
        "required": true
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password",
        "required": true
      },
      {
        "key": "ip",
        "label": "Ip",
        "type": "text"
      }
    ]
  },
  "ipfs_api": {
    "id": "ipfs_api",
    "name": "Ipfs api",
    "fields": [
      {
        "key": "mode",
        "label": "Mode",
        "type": "select",
        "required": true,
        "options": [
          {
            "label": "ipfs",
            "value": "ipfs"
          },
          {
            "label": "ipns",
            "value": "ipns"
          },
          {
            "label": "mfs",
            "value": "mfs"
          }
        ]
      },
      {
        "key": "endpoint",
        "label": "Endpoint",
        "type": "text",
        "required": true,
        "default": "http://127.0.0.1:5001"
      },
      {
        "key": "gateway",
        "label": "Gateway",
        "type": "text",
        "required": true,
        "default": "http://127.0.0.1:8080"
      },
      {
        "key": "root",
        "label": "Root",
        "type": "text"
      }
    ]
  },
  "kodbox": {
    "id": "kodbox",
    "name": "Kodbox",
    "fields": [
      {
        "key": "address",
        "label": "Address",
        "type": "text",
        "required": true
      },
      {
        "key": "username",
        "label": "Username",
        "type": "text"
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password"
      }
    ]
  },
  "lanzou": {
    "id": "lanzou",
    "name": "Lanzou",
    "fields": [
      {
        "key": "type",
        "label": "Type",
        "type": "select",
        "default": "cookie",
        "options": [
          {
            "label": "account",
            "value": "account"
          },
          {
            "label": "cookie",
            "value": "cookie"
          },
          {
            "label": "url",
            "value": "url"
          }
        ]
      },
      {
        "key": "baseUrl",
        "label": "Base Url",
        "type": "text",
        "required": true,
        "default": "https://pc.woozooo.com",
        "help": "basic URL for file operation"
      },
      {
        "key": "shareUrl",
        "label": "Share Url",
        "type": "text",
        "required": true,
        "default": "https://pan.lanzoui.com",
        "help": "used to get the sharing page"
      },
      {
        "key": "user_agent",
        "label": "User agent",
        "type": "text",
        "required": true,
        "default": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.39 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.39"
      },
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "help": "about 15 days valid, ignore if shareUrl is used"
      },
      {
        "key": "root_id",
        "label": "Root id",
        "type": "text"
      },
      {
        "key": "account",
        "label": "Account",
        "type": "text"
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password"
      },
      {
        "key": "share_id",
        "label": "Share id",
        "type": "text"
      },
      {
        "key": "share_password",
        "label": "Share password",
        "type": "password"
      }
    ]
  },
  "lenovonas_share": {
    "id": "lenovonas_share",
    "name": "Lenovonas share",
    "fields": [
      {
        "key": "share_id",
        "label": "Share id",
        "type": "text",
        "required": true,
        "help": "The part after the last / in the shared link"
      },
      {
        "key": "share_pwd",
        "label": "Share pwd",
        "type": "password",
        "required": true,
        "help": "The password of the shared link"
      }
    ]
  },
  "mediafire": {
    "id": "mediafire",
    "name": "Mediafire",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "required": true,
        "help": "Required for MediaFire API authentication"
      },
      {
        "key": "session_token",
        "label": "Session token",
        "type": "password"
      },
      {
        "key": "order_by",
        "label": "Order by",
        "type": "select",
        "default": "name",
        "options": [
          {
            "label": "name",
            "value": "name"
          },
          {
            "label": "time",
            "value": "time"
          },
          {
            "label": "size",
            "value": "size"
          }
        ]
      },
      {
        "key": "order_direction",
        "label": "Order direction",
        "type": "select",
        "default": "asc",
        "options": [
          {
            "label": "asc",
            "value": "asc"
          },
          {
            "label": "desc",
            "value": "desc"
          }
        ]
      },
      {
        "key": "chunk_size",
        "label": "Chunk size",
        "type": "text"
      }
    ]
  },
  "mediatrack": {
    "id": "mediatrack",
    "name": "Mediatrack",
    "fields": [
      {
        "key": "access_token",
        "label": "Access token",
        "type": "password",
        "required": true
      },
      {
        "key": "project_id",
        "label": "Project id",
        "type": "text"
      },
      {
        "key": "root",
        "label": "Root",
        "type": "text"
      },
      {
        "key": "order_by",
        "label": "Order by",
        "type": "select",
        "default": "title",
        "options": [
          {
            "label": "updated_at",
            "value": "updated_at"
          },
          {
            "label": "title",
            "value": "title"
          },
          {
            "label": "size",
            "value": "size"
          }
        ]
      }
    ]
  },
  "mega": {
    "id": "mega",
    "name": "Mega",
    "fields": []
  },
  "misskey": {
    "id": "misskey",
    "name": "Misskey",
    "fields": [
      {
        "key": "endpoint",
        "label": "Endpoint",
        "type": "text",
        "required": true,
        "default": "https://misskey.io"
      },
      {
        "key": "access_token",
        "label": "Access token",
        "type": "password",
        "required": true
      }
    ]
  },
  "mopan": {
    "id": "mopan",
    "name": "Mopan",
    "fields": [
      {
        "key": "phone",
        "label": "Phone",
        "type": "text",
        "required": true
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password",
        "required": true
      },
      {
        "key": "root_folder_id",
        "label": "Root folder id",
        "type": "text"
      }
    ]
  },
  "netease_music": {
    "id": "netease_music",
    "name": "Netease music",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "text",
        "required": true
      },
      {
        "key": "song_limit",
        "label": "Song limit",
        "type": "number",
        "default": "200",
        "help": "only get 200 songs by default"
      }
    ]
  },
  "onedrive": {
    "id": "onedrive",
    "name": "Onedrive",
    "fields": [
      {
        "key": "refreshToken",
        "label": "Refresh token",
        "type": "password"
      },
      {
        "key": "clientId",
        "label": "Client id",
        "type": "text"
      },
      {
        "key": "clientSecret",
        "label": "Client secret",
        "type": "password"
      }
    ]
  },
  "onedrive_app": {
    "id": "onedrive_app",
    "name": "Onedrive app",
    "fields": [
      {
        "key": "region",
        "label": "Region",
        "type": "select",
        "required": true,
        "default": "global",
        "options": [
          {
            "label": "global",
            "value": "global"
          },
          {
            "label": "cn",
            "value": "cn"
          },
          {
            "label": "us",
            "value": "us"
          },
          {
            "label": "de",
            "value": "de"
          }
        ]
      },
      {
        "key": "email",
        "label": "Email",
        "type": "text"
      },
      {
        "key": "tenant_id",
        "label": "Tenant id",
        "type": "text"
      },
      {
        "key": "client_id",
        "label": "Client id",
        "type": "text",
        "required": true
      },
      {
        "key": "client_secret",
        "label": "Client secret",
        "type": "password",
        "required": true
      }
    ]
  },
  "onedrive_sharelink": {
    "id": "onedrive_sharelink",
    "name": "Onedrive sharelink",
    "fields": [
      {
        "key": "url",
        "label": "Url",
        "type": "text",
        "required": true
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password"
      }
    ]
  },
  "openlist": {
    "id": "openlist",
    "name": "Openlist",
    "fields": [
      {
        "key": "url",
        "label": "Url",
        "type": "text",
        "required": true
      },
      {
        "key": "meta_password",
        "label": "Meta password",
        "type": "password"
      },
      {
        "key": "root",
        "label": "Root",
        "type": "text"
      },
      {
        "key": "username",
        "label": "Username",
        "type": "text"
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password"
      },
      {
        "key": "token",
        "label": "Token",
        "type": "password"
      }
    ]
  },
  "openlist_share": {
    "id": "openlist_share",
    "name": "Openlist share",
    "fields": [
      {
        "key": "url",
        "label": "Url",
        "type": "text",
        "required": true
      },
      {
        "key": "sid",
        "label": "Sid",
        "type": "text",
        "required": true
      },
      {
        "key": "pwd",
        "label": "Pwd",
        "type": "password"
      }
    ]
  },
  "p115": {
    "id": "p115",
    "name": "P115",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password"
      }
    ]
  },
  "pikpak": {
    "id": "pikpak",
    "name": "Pikpak",
    "fields": [
      {
        "key": "platform",
        "label": "Platform",
        "type": "select",
        "required": true,
        "default": "web",
        "options": [
          {
            "label": "android",
            "value": "android"
          },
          {
            "label": "web",
            "value": "web"
          },
          {
            "label": "pc",
            "value": "pc"
          }
        ]
      },
      {
        "key": "device_id",
        "label": "Device id",
        "type": "text"
      },
      {
        "key": "root_folder_id",
        "label": "Root folder id",
        "type": "text",
        "help": "可选：从指定目录 ID 作为挂载根目录"
      },
      {
        "key": "username",
        "label": "Username",
        "type": "text",
        "required": false
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password"
      },
      {
        "key": "captcha_token",
        "label": "Captcha token",
        "type": "password"
      },
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password",
        "help": "已有令牌时填写；没有令牌则同时填写用户名和密码"
      },
      {
        "key": "disable_media_link",
        "label": "Disable media link",
        "type": "text",
        "default": "true"
      }
    ]
  },
  "pikpak_share": {
    "id": "pikpak_share",
    "name": "Pikpak share",
    "fields": [
      {
        "key": "platform",
        "label": "Platform",
        "type": "select",
        "required": true,
        "default": "web",
        "options": [
          { "label": "android", "value": "android" },
          { "label": "web", "value": "web" },
          { "label": "pc", "value": "pc" }
        ]
      },
      {
        "key": "share_id",
        "label": "Share id",
        "type": "text",
        "required": true
      },
      {
        "key": "share_pwd",
        "label": "Share pwd",
        "type": "password"
      },
      {
        "key": "root_folder_id",
        "label": "Root folder id",
        "type": "text",
        "help": "可选：从指定分享目录 ID 作为挂载根目录"
      },
      {
        "key": "use_transcoding_address",
        "label": "Use transcoding address",
        "type": "text",
        "required": true,
        "default": "false"
      },
      {
        "key": "device_id",
        "label": "Device id",
        "type": "text"
      },
      {
        "key": "captcha_token",
        "label": "Captcha token",
        "type": "password"
      }
    ]
  },
  "proton_drive": {
    "id": "proton_drive",
    "name": "Proton drive",
    "fields": []
  },
  "quark": {
    "id": "quark",
    "name": "Quark",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password"
      }
    ]
  },
  "quark_open": {
    "id": "quark_open",
    "name": "Quark open",
    "fields": [
      {
        "key": "refreshToken",
        "label": "Refresh token",
        "type": "password"
      },
      {
        "key": "api_url_address",
        "label": "Api url address",
        "type": "text",
        "default": "https://api.oplist.org/quarkyun/renewapi"
      },
      {
        "key": "app_id",
        "label": "App id",
        "type": "text"
      },
      {
        "key": "sign_key",
        "label": "Sign key",
        "type": "password"
      }
    ]
  },
  "quark_uc": {
    "id": "quark_uc",
    "name": "Quark uc",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "required": true
      }
    ]
  },
  "quark_uc_tv": {
    "id": "quark_uc_tv",
    "name": "Quark uc tv",
    "fields": [
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password"
      },
      {
        "key": "device_id",
        "label": "Device id",
        "type": "text"
      }
    ]
  },
  "r2": {
    "id": "r2",
    "name": "R2",
    "fields": [
      {
        "key": "prefix",
        "label": "Prefix",
        "type": "text"
      }
    ]
  },
  "s3": {
    "id": "s3",
    "name": "S3",
    "fields": [
      {
        "key": "endpoint",
        "label": "Endpoint",
        "type": "text",
        "required": true
      },
      {
        "key": "region",
        "label": "Region",
        "type": "text"
      },
      {
        "key": "bucket",
        "label": "Bucket",
        "type": "text",
        "required": true
      },
      {
        "key": "accessKeyId",
        "label": "Access key id",
        "type": "password",
        "required": true
      },
      {
        "key": "secretAccessKey",
        "label": "Secret access key",
        "type": "password",
        "required": true
      },
      {
        "key": "pathStyle",
        "label": "Path Style",
        "type": "text"
      },
      {
        "key": "prefix",
        "label": "Prefix",
        "type": "text"
      }
    ]
  },
  "schemas": {
    "id": "schemas",
    "name": "Schemas",
    "fields": []
  },
  "seafile": {
    "id": "seafile",
    "name": "Seafile",
    "fields": [
      {
        "key": "address",
        "label": "Address",
        "type": "text",
        "required": true
      },
      {
        "key": "root_folder_path",
        "label": "根目录路径",
        "type": "text",
        "help": "挂载到网盘内的根路径，默认 /"
      },
      {
        "key": "token",
        "label": "Token",
        "type": "password"
      },
      {
        "key": "username",
        "label": "Username",
        "type": "text"
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password"
      }
    ]
  },
  "strm": {
    "id": "strm",
    "name": "Strm",
    "fields": [
      {
        "key": "paths",
        "label": "Paths",
        "type": "text",
        "required": true
      }
    ]
  },
  "teambition": {
    "id": "teambition",
    "name": "Teambition",
    "fields": [
      {
        "key": "region",
        "label": "Region",
        "type": "text"
      },
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "required": true
      },
      {
        "key": "project_id",
        "label": "Project id",
        "type": "text",
        "required": true
      },
      {
        "key": "root",
        "label": "Root",
        "type": "text"
      },
      {
        "key": "order_by",
        "label": "Order by",
        "type": "select",
        "default": "fileName",
        "options": [
          {
            "label": "fileName",
            "value": "fileName"
          },
          {
            "label": "fileSize",
            "value": "fileSize"
          },
          {
            "label": "updated",
            "value": "updated"
          },
          {
            "label": "created",
            "value": "created"
          }
        ]
      },
      {
        "key": "order_direction",
        "label": "Order direction",
        "type": "select",
        "default": "Asc",
        "options": [
          {
            "label": "Asc",
            "value": "Asc"
          },
          {
            "label": "Desc",
            "value": "Desc"
          }
        ]
      }
    ]
  },
  "teldrive": {
    "id": "teldrive",
    "name": "Teldrive",
    "fields": [
      {
        "key": "url",
        "label": "Url",
        "type": "text",
        "required": true
      },
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "required": true,
        "help": "access_token=xxx"
      }
    ]
  },
  "template": {
    "id": "template",
    "name": "Template",
    "fields": [
      {
        "key": "seed",
        "label": "Seed",
        "type": "text"
      }
    ]
  },
  "terabox": {
    "id": "terabox",
    "name": "Terabox",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "required": true
      },
      {
        "key": "js_token",
        "label": "jsToken（选填）",
        "type": "password",
        "help": "浏览器 Cookie 里通常自带 jsToken，会自动解析；仅当报「无法通过 jsToken 校验」时才需要手动填写（从浏览器开发者工具的 Cookie 中复制 jsToken 的值）"
      },
      {
        "key": "order_by",
        "label": "Order by",
        "type": "select",
        "default": "name",
        "options": [
          {
            "label": "name",
            "value": "name"
          },
          {
            "label": "time",
            "value": "time"
          },
          {
            "label": "size",
            "value": "size"
          }
        ]
      },
      {
        "key": "order_direction",
        "label": "Order direction",
        "type": "select",
        "default": "asc",
        "options": [
          {
            "label": "asc",
            "value": "asc"
          },
          {
            "label": "desc",
            "value": "desc"
          }
        ]
      },
      {
        "key": "download_api",
        "label": "Download api",
        "type": "select",
        "default": "official",
        "options": [
          {
            "label": "official",
            "value": "official"
          },
          {
            "label": "crack",
            "value": "crack"
          }
        ]
      }
    ]
  },
  "thunder": {
    "id": "thunder",
    "name": "Thunder",
    "fields": []
  },
  "thunder_browser": {
    "id": "thunder_browser",
    "name": "Thunder browser",
    "fields": []
  },
  "thunderx": {
    "id": "thunderx",
    "name": "Thunderx",
    "fields": []
  },
  "url_tree": {
    "id": "url_tree",
    "name": "Url tree",
    "fields": [
      {
        "key": "head_size",
        "label": "Head size",
        "type": "bool",
        "default": "false",
        "help": "Use head method to get file size, but it may be failed."
      },
      {
        "key": "url_structure",
        "label": "Url structure",
        "type": "text",
        "required": true,
        "default": "https://raw.githubusercontent.com/OpenListTeam/OpenList/main/README.md\\nhttps://raw.githubusercontent.com/OpenListTeam/OpenList/main/README/README_cn.md\\nfolder:\\n  CONTRIBUTING.md:1635:https://raw.githubusercontent.com/OpenListTeam/OpenList/main/CONTRIBUTING.md\\n  CODE_OF_CONDUCT.md:2093:https://raw.githubusercontent.com/OpenListTeam/OpenList/main/CODE_OF_CONDUCT.md",
        "help": "structure:FolderName:\\n  [FileName:][FileSize:][Modified:]Url"
      }
    ]
  },
  "uss": {
    "id": "uss",
    "name": "Uss",
    "fields": [
      {
        "key": "bucket",
        "label": "Bucket",
        "type": "text",
        "required": true
      },
      {
        "key": "operator_name",
        "label": "Operator name",
        "type": "text",
        "required": true
      },
      {
        "key": "operator_password",
        "label": "Operator password",
        "type": "password",
        "required": true
      },
      {
        "key": "endpoint",
        "label": "Endpoint",
        "type": "text",
        "required": true
      },
      {
        "key": "anti_theft_chain_token",
        "label": "Anti theft chain token",
        "type": "password"
      }
    ]
  },
  "virtual": {
    "id": "virtual",
    "name": "Virtual",
    "fields": [
      {
        "key": "tree",
        "label": "Tree",
        "type": "text"
      }
    ]
  },
  "webdav": {
    "id": "webdav",
    "name": "Webdav",
    "fields": [
      {
        "key": "endpoint",
        "label": "Endpoint",
        "type": "text"
      },
      {
        "key": "username",
        "label": "Username",
        "type": "text",
        "required": true
      },
      {
        "key": "password",
        "label": "Password",
        "type": "password",
        "required": true
      },
      {
        "key": "prefix",
        "label": "Prefix",
        "type": "text"
      }
    ]
  },
  "weiyun": {
    "id": "weiyun",
    "name": "Weiyun",
    "fields": [
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password"
      },
      {
        "key": "root_folder_id",
        "label": "Root folder id",
        "type": "text"
      }
    ]
  },
  "wopan": {
    "id": "wopan",
    "name": "Wopan",
    "fields": [
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password",
        "required": true
      },
      {
        "key": "family_id",
        "label": "Family id",
        "type": "text",
        "help": "Keep it empty if you want to use your personal drive"
      },
      {
        "key": "sort_rule",
        "label": "Sort rule",
        "type": "select",
        "default": "name_asc",
        "options": [
          {
            "label": "name_asc",
            "value": "name_asc"
          },
          {
            "label": "name_desc",
            "value": "name_desc"
          },
          {
            "label": "time_asc",
            "value": "time_asc"
          },
          {
            "label": "time_desc",
            "value": "time_desc"
          },
          {
            "label": "size_asc",
            "value": "size_asc"
          },
          {
            "label": "size_desc",
            "value": "size_desc"
          }
        ]
      },
      {
        "key": "root_folder_id",
        "label": "根目录ID",
        "type": "text",
        "help": "根目录 ID（部分驱动用 ID 定位）"
      }
    ]
  },
  "wps": {
    "id": "wps",
    "name": "Wps",
    "fields": [
      {
        "key": "mode",
        "label": "Mode",
        "type": "select",
        "default": "Personal",
        "options": [
          {
            "label": "Personal",
            "value": "Personal"
          },
          {
            "label": "Business",
            "value": "Business"
          }
        ]
      },
      {
        "key": "cookie",
        "label": "Cookie",
        "type": "password",
        "required": true
      },
      {
        "key": "custom_ua",
        "label": "Custom ua",
        "type": "text"
      },
      {
        "key": "root_folder_id",
        "label": "根目录ID",
        "type": "text",
        "help": "根目录 ID（部分驱动用 ID 定位）"
      }
    ]
  },
  "yandex_disk": {
    "id": "yandex_disk",
    "name": "Yandex disk",
    "fields": [
      {
        "key": "order_by",
        "label": "Order by",
        "type": "select",
        "default": "name",
        "options": [
          {
            "label": "name",
            "value": "name"
          },
          {
            "label": "path",
            "value": "path"
          },
          {
            "label": "created",
            "value": "created"
          },
          {
            "label": "modified",
            "value": "modified"
          },
          {
            "label": "size",
            "value": "size"
          }
        ]
      },
      {
        "key": "order_direction",
        "label": "Order direction",
        "type": "select",
        "default": "asc",
        "options": [
          {
            "label": "asc",
            "value": "asc"
          },
          {
            "label": "desc",
            "value": "desc"
          }
        ]
      },
      {
        "key": "use_online_api",
        "label": "Use online api",
        "type": "text",
        "default": "true"
      },
      {
        "key": "api_url_address",
        "label": "Api url address",
        "type": "text",
        "default": "https://api.oplist.org/yandexui/renewapi"
      },
      {
        "key": "refresh_token",
        "label": "Refresh token",
        "type": "password"
      },
      {
        "key": "client_id",
        "label": "Client id",
        "type": "text"
      },
      {
        "key": "client_secret",
        "label": "Client secret",
        "type": "password"
      }
    ]
  }
};
export function getDriverSchema(id: string): DriverSchema | undefined { return SCHEMAS[id]; }
export function listDriverSchemas(): DriverSchema[] { return Object.values(SCHEMAS); }
export default SCHEMAS;
