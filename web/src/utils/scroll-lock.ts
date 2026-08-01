// 页面滚动锁（模块级引用计数）。
//
// 嵌套弹窗时（例如预览器之上再弹一个确认框），内层关闭不能把外层的锁一起解掉，
// 否则背景会突然可滚、滚动位置错乱。所以必须计数，而不是直接置空 overflow。

let count = 0;
let prevOverflow = "";
let prevPaddingRight = "";

export function lockScroll(): void {
  if (count++ > 0) return;
  const body = document.body;
  prevOverflow = body.style.overflow;
  prevPaddingRight = body.style.paddingRight;
  // 补上滚动条宽度，避免弹窗打开瞬间整页横向「跳」一下
  const gap = window.innerWidth - document.documentElement.clientWidth;
  if (gap > 0) body.style.paddingRight = `${gap}px`;
  body.style.overflow = "hidden";
}

export function unlockScroll(): void {
  if (--count > 0) return;
  count = 0;
  document.body.style.overflow = prevOverflow;
  document.body.style.paddingRight = prevPaddingRight;
}
