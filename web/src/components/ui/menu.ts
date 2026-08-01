// PopMenu 的菜单项定义。
// 单独放在 .ts 里而不是 SFC 内 —— `<script setup>` 不允许出现 ES 模块导出。

export interface MenuItem {
  key: string;
  label: string;
  /** 24×24 viewBox 的 SVG path */
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 在该项之前画一条分隔线 */
  divided?: boolean;
}
