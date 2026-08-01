// localStorage 的安全封装。
// Safari 无痕模式、被策略禁用第三方存储的 iframe 里，直接访问 localStorage
// 会抛异常。裸用一次就足以让整个组件 setup 崩掉、页面白屏。

export function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLS(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
