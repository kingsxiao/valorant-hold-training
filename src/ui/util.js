// 小工具
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
export const lerp = (a, b, t) => a + (b - a) * t
export const fmtMs = (ms) => ms >= 10000 ? '—' : `${Math.round(ms)}`
