// 出场姿势（纯函数，Bot.step 与单测共用）
// 两种姿势各 50% 交替（BotManager 抽签、防连击）：
//  cross 侧身跑过 —— 身体顺跑向（±π/2 yaw），侧身入镜贯穿缺口
//  pull  横向拉出 —— 面向玩家持枪横移（strafe 对枪姿态）拉到窗口内急停
// GLB 骨骼假人只有前进向 clip：pull 的横移步态用「程序化侧移步态覆盖腿骨骼」
// 拼出来（见 Bot._stepStrafeGait），腿部骨链不齐的老模型退回顺跑向防滑步

import { GAIT } from './GaitBake.js'

// 朝向判定：横移中 cross=顺跑向 / pull=面向玩家；停步/站定一律转回面向
// 玩家（停步挑战）。dx/dz = 玩家 − Bot，返回目标 yaw（rad）
export function peekFacingYaw({ style, canStrafe, velX, moving, stopped, dx, dz }) {
  if (!moving || stopped) return faceTargetYaw(dx, dz)
  if (style === 'pull' && canStrafe) return faceTargetYaw(dx, dz) // 横向拉出：面向玩家横移
  return velX > 0 ? -Math.PI / 2 : Math.PI / 2                    // 侧身跑过 / 无骨链回退
}

// 玩家方向 yaw（与视角同约定：模型正面 -Z）
export function faceTargetYaw(dx, dz) {
  return Math.atan2(-dx, -dz)
}

// 横移步态权重：pull 波随移速 0.25→1.15 m/s 从前进 clip 淡入程序化侧移
// （与 idle→walk 动画权重同曲线，启停无跳变）；cross 波恒 0
export function strafeRampW({ style, speed, minSpeed = 0.25, rampSpeed = 1.15 }) {
  if (style !== 'pull') return 0
  return Math.min(1, Math.max(0, (speed - minSpeed) / (rampSpeed - minSpeed)))
}

// 程序化侧移步态的姿态量 —— 官方口径（assets-raw/sova-psa Q_Bow_RunE/WalkE 实测）：
// 横移循环 = 腿链朝移动方向 yaw 后的「前进跑循环」——左右腿反相（一屈一伸交替）。
// 膝曲线用官方 WalkE/RunE 双锚点按速度插值：走速以下全程 WalkE 深膝（起步拉出
// 不再被 k=speed/5.4 缩成浅膝碎步——官方走速横移本身就是 88.7° 峰值的大幅深膝），
// 走→跑速之间线性过渡，5.4 及以上 = 既有 RunE 验收口径不变：
//   WalkE 膝 基础 28.1°/峰值 88.7°（摆动幅 60.6°）→ base 0.49 / swing 1.06 rad
//   RunE  膝 基础 11.5°/峰值 ~106°            → base 0.20 / swing = GAIT.run.knee
// 髋摆同插值（走 ~42° 全幅 → 跑 0.82rad）；躯干/盆骨不扭（正对瞄准方向），盆骨
// 侧倾随步态。相位由里程推进（每步 π，调用侧保证横移步距口径，见 Bot.STRAFE_STEP_LEN）
const STRAFE_WALKE = { thigh: 0.70, base: 0.49, swing: 1.06 }
export function strafeStepPose({ speed, phase, lateralVel, moveSpeed = 5.4 }) {
  const t = Math.min(1, Math.max(0, (speed - 3.39) / (moveSpeed - 3.39)))
  const thigh = STRAFE_WALKE.thigh + (GAIT.run.thigh - STRAFE_WALKE.thigh) * t
  const base = STRAFE_WALKE.base + (0.20 - STRAFE_WALKE.base) * t
  const swing = STRAFE_WALKE.swing + (GAIT.run.knee - STRAFE_WALKE.swing) * t
  const sgn = -Math.sign(lateralVel || 1) // 模型右 +X：向右移腿链朝右
  const leg = (p) => ({
    thigh: thigh * Math.sin(p),
    knee: base + swing * Math.max(0, -Math.sin(p - 0.5)),
  })
  const L = leg(phase)
  const R = leg(phase + Math.PI)
  return {
    s: Math.cos(phase),
    yaw: sgn * 0.90 + Math.cos(phase) * 0.12,
    thighL: L.thigh, thighR: R.thigh,
    kneeL: L.knee, kneeR: R.knee,
    abductL: Math.cos(phase) * -0.12 * (0.75 + 0.25 * t),
    abductR: Math.cos(phase) * 0.12 * (0.75 + 0.25 * t),
    bob: (1 - Math.abs(Math.cos(phase))) * (0.01 + speed * 0.0036),
    lean: leanInto(lateralVel),
  }
}

// 向移动方向微倾（与程序化假人 _stepLegs 同参数）；回正速率由调用侧平滑。
// 上限对齐官方：Sova RunE/W 盆骨侧倾均值 -4.8°/+9.8°（镜像入移动方向），取
// 全速 ~0.12rad≈6.9°（0.02×5.4=0.108 未触顶）
export function leanInto(lateralVel) {
  return Math.min(0.12, Math.max(-0.12, -lateralVel * 0.02))
}
