// 出场姿势（纯函数，Bot.step 与单测共用）
// 两种姿势各 50% 交替（BotManager 抽签、防连击）：
//  cross 侧身跑过 —— 身体顺跑向（±π/2 yaw），侧身入镜贯穿缺口
//  pull  横向拉出 —— 面向玩家持枪横移（strafe 对枪姿态）拉到窗口内急停
// GLB 骨骼假人只有前进向 clip：pull 的横移步态用「程序化侧移步态覆盖腿骨骼」
// 拼出来（见 Bot._stepStrafeGait），腿部骨链不齐的老模型退回顺跑向防滑步

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

// 程序化侧移步态的姿态量 —— 无畏契约持枪横移形态：躯干正对瞄准方向不扭腰，
// 双腿镜像侧向外展滑步（步距开合交替）、双脚尖微朝移动方向、并腿过中点时
// 屈膝抬脚（|s|=1 为落脚支撑步，伸直）、重心随步态起伏。
// 幅度曲线与程序化假人 _stepLegs 同一套 VALORANT 口径（早前轮调校锁定）：
//   aLat = min(0.36, 0.12 + speed·0.058)   外展摆幅
//   feetYaw = −sign(lx)·0.26 + s·0.12      脚尖朝移动方向（含步内反摆）
//   bob = (1−|s|)·(0.01 + speed·0.0036)    起伏（落脚最低、并腿最高）
// phase 由里程推进（每 STEP_LEN 米 = π，见 Bot），s = cos(phase)
export function strafeStepPose({ speed, phase, lateralVel, moveSpeed = 5.4 }) {
  const s = Math.cos(phase)
  const a = Math.min(0.36, 0.12 + speed * 0.058)
  const k = Math.min(1, speed / moveSpeed)
  return {
    s,
    abductL: -s * a,   // 左大腿外展角（mesh 空间绕 Z；−s = 与右腿镜像开合）
    abductR: s * a,
    feetYaw: -Math.sign(lateralVel || 1) * 0.26 + s * 0.12,
    knee: 0.06 + 0.4 * (1 - Math.abs(s)) * k, // 并腿过中点屈膝，支撑步伸直
    bob: (1 - Math.abs(s)) * (0.01 + speed * 0.0036),
    lean: leanInto(lateralVel),
  }
}

// 向移动方向微倾（与程序化假人 _stepLegs 同参数）；回正速率由调用侧平滑
export function leanInto(lateralVel) {
  return Math.min(0.05, Math.max(-0.05, -lateralVel * 0.011))
}
