// 闪光致盲模型（纯函数，无 DOM/three 依赖 —— tests/flash.test.js 直接覆盖）
// 口径：Fandom 维基 Status Effect#Flash 定性描述的参数化近似：
//  - 需要视线（LOS）：起爆点与眼睛之间被几何遮挡 → 不致盲
//  - 直视起爆点 = 满时长；背对 = "轻微短暂"；超远距离可完全免疫
//  - 致盲到期后白屏 1 秒渐褪（该 1s 为维基确认值）
import { CONFIG } from '../core/Config.js'

const clamp01 = (v) => Math.max(0, Math.min(1, v))

// 朝向因子：起爆点在视野锥内（半水平 FOV）= 1（直视）；FOV 外随角度衰减，
// 完全背对（180°）落到 backFactor（"slightly blinded for a very brief time"）
export function angleFactor(angleDeg) {
  const F = CONFIG.flash
  if (angleDeg <= F.fovHalf) return 1
  const t = (180 - angleDeg) / (180 - F.fovHalf) // 0（背对）→ 1（FOV 边缘）
  return Math.max(F.backFactor, Math.pow(clamp01(t), F.angleExp))
}

// 距离因子：≤fullDist 满时长，其后线性衰减到 zeroDist 归零（近似口径，
// 维基只确认"越远越短、超远免疫"两个锚点）
export function distFactor(dist) {
  const F = CONFIG.flash
  if (dist <= F.fullDist) return 1
  return clamp01(1 - (dist - F.fullDist) / (F.zeroDist - F.fullDist))
}

// 起爆瞬间的致盲时长（s）。los=false 或算出的时长不足 50ms 视为未致盲（0）
export function blindDuration(maxBlindSec, dist, angleDeg, los) {
  if (!los) return 0
  const d = maxBlindSec * distFactor(dist) * angleFactor(angleDeg)
  return d < 0.05 ? 0 : d
}

// Skye 鹰：最大致盲时长随飞行时间充能 —— 0s 飞行 = 1s，0.75s 飞行后 = 2.25s（线性，v5.07）
export function skyeMaxBlind(flightSec) {
  const S = CONFIG.flash.skye
  const t = clamp01(flightSec / S.chargeTime)
  return S.minBlind + (S.maxBlind - S.minBlind) * t
}

// KAY/O 手雷弹跳后的新引信（v10.06）：0.8s，但不延长原有剩余时间
export function kayoFuseAfterBounce(remainingSec) {
  return Math.min(remainingSec, CONFIG.flash.kayo.bounceFuse)
}

// 二次贝塞尔弧长表：Fixed 曲线导弹（Curveball）按恒定速度行进需要弧长参数化。
// 返回 { point(u, out), len }——point 接受 0..len 的弧长，落到贝塞尔曲线上
export function arcBezier(p0, p1, p2, samples = 48) {
  const cum = [0]
  let prevX = p0.x, prevY = p0.y, prevZ = p0.z, len = 0
  for (let i = 1; i <= samples; i++) {
    const u = i / samples
    const iu = 1 - u
    const x = iu * iu * p0.x + 2 * iu * u * p1.x + u * u * p2.x
    const y = iu * iu * p0.y + 2 * iu * u * p1.y + u * u * p2.y
    const z = iu * iu * p0.z + 2 * iu * u * p1.z + u * u * p2.z
    len += Math.hypot(x - prevX, y - prevY, z - prevZ)
    cum.push(len)
    prevX = x; prevY = y; prevZ = z
  }
  return {
    len,
    // s：弧长（clamp 到 [0, len]）；out：{x,y,z} 就地写入
    point(s, out) {
      s = Math.max(0, Math.min(len, s))
      // 二分找弧长区间，再线性插参数 u
      let lo = 0, hi = samples
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cum[mid] < s) lo = mid + 1
        else hi = mid
      }
      const i = Math.max(1, lo)
      const span = cum[i] - cum[i - 1] || 1
      const f = (s - cum[i - 1]) / span
      const u = ((i - 1) + f) / samples
      const iu = 1 - u
      out.x = iu * iu * p0.x + 2 * iu * u * p1.x + u * u * p2.x
      out.y = iu * iu * p0.y + 2 * iu * u * p1.y + u * u * p2.y
      out.z = iu * iu * p0.z + 2 * iu * u * p1.z + u * u * p2.z
      return out
    },
  }
}
