// 轻量确定性 PRNG（mulberry32）—— 仅供视觉特效 / 程序化纹理的扰动量采样使用
// 非加密场景：不需要抗预测熵源，需要的是可种子复现（调试/回放友好）与高频零分配
let s = ((Date.now() % 2147483647) | 0) || 1

export function reseed(seed) { s = (seed >>> 0) || 1 }

export function vary() {
  s |= 0; s = (s + 0x6D2B79F5) | 0
  let t = Math.imul(s ^ (s >>> 15), 1 | s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const varyRange = (a, b) => a + (b - a) * vary()
