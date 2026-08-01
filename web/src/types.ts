// 跨组件共享的视图层类型。
// 注意：`<script setup>` 里不能写 ES 导出，需要复用的类型一律放在这里。

/** /api/fs/search 返回的一行（来自 file_cache 索引 + 挂载名） */
export interface SearchRow {
  mount_id: number;
  mount_name: string;
  /** 文件的完整路径 */
  path: string;
  /** 所在目录 */
  dir: string;
  name: string;
  size: number;
  is_dir: number | boolean;
  modified: number;
}

// ---- 驱动配置 schema（后端 /api/mounts/drivers 下发，前端据此动态渲染表单） ----
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
  /** 该驱动是否支持交互式 OAuth 授权 */
  oauth?: boolean;
}
