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

// 程序化侧移步态的姿态量 —— 官方口径（assets-raw/sova-psa Q_Bow_RunE/W 实测）：
// 横移循环 = 腿链朝移动方向 yaw 后的「前进跑循环」——左右腿反相（一屈一伸交替）、
// 膝基础屈曲 ~11.5° + 摆动峰值 ~106°、髋摆同跑（膝/髋曲线直接复用 GaitBake 跑步
// 曲线按速度强度 k 缩放）；躯干/盆骨不扭（正对瞄准方向），盆骨侧倾随步态。
// 这替换了早前「双腿镜像外展开合滑步（同屈同伸）」方案——官方数据里横移不是
// 双脚同时触地的开合步，而是交替深膝循环，两种步态肉眼可辨。
//   yaw   = −sign(lx)·0.90 + s·0.12      腿链朝移动方向（含步内呼吸）
//   thigh = GAIT.run.thigh·k·sin(p)      矢状交替摆动（L 相位 p、R 相位 p+π）
//   knee  = k·(0.20 + 1.55·max(0, −sin(p−0.5)))  官方 RunE 膝曲线
//   abduct = s·0.12·k                    小幅外展稳定（官方 RunE 髋 Y 分量 ~35%）
//   bob = (1−|s|)·(0.01 + speed·0.0036)  起伏（落脚最低、过中点最高）
// phase 由里程推进（每步 π，调用侧保证横移步距口径，见 Bot.STRAFE_STEP_LEN）
export function strafeStepPose({ speed, phase, lateralVel, moveSpeed = 5.4 }) {
  const k = Math.min(1, speed / moveSpeed)
  const sgn = -Math.sign(lateralVel || 1) // 模型右 +X：向右移腿链朝右
  const leg = (p) => ({
    thigh: GAIT.run.thigh * k * Math.sin(p),
    knee: k * (0.20 + GAIT.run.knee * Math.max(0, -Math.sin(p - 0.5))),
  })
  const L = leg(phase)
  const R = leg(phase + Math.PI)
  return {
    s: Math.cos(phase),
    yaw: sgn * 0.90 + Math.cos(phase) * 0.12,
    thighL: L.thigh, thighR: R.thigh,
    kneeL: L.knee, kneeR: R.knee,
    abductL: Math.cos(phase) * -0.12 * k,
    abductR: Math.cos(phase) * 0.12 * k,
    bob: (1 - Math.abs(Math.cos(phase))) * (0.01 + speed * 0.0036),
    lean: leanInto(lateralVel),
  }
}

// 向移动方向微倾（与程序化假人 _stepLegs 同参数）；回正速率由调用侧平滑
export function leanInto(lateralVel) {
  return Math.min(0.05, Math.max(-0.05, -lateralVel * 0.011))
}
