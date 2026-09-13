// 出场姿势（纯函数，Bot.step 与单测共用）
// 两种姿势各 50% 交替（BotManager 抽签、防连击）：
//  cross 侧身跑过 —— 身体顺跑向（±π/2 yaw），侧身入镜贯穿缺口
//  pull  横向拉出 —— 面向玩家持枪横移（strafe 对枪姿态）拉到窗口内急停
// GLB 骨骼假人只有前进向 clip：pull 的横移步态用「程序化侧移步态覆盖腿骨骼」
// 拼出来（见 Bot._stepStrafeGait），腿部骨链不齐的老模型退回顺跑向防滑步

import { GAIT } from './GaitBake.js'

// 朝向判定：出掩体全程面朝玩家（162 轮用户口径：pull 拉出即缩 / cross 贯穿
// 跑过都正面朝玩家横移——cross 曾顺跑向 = 玩家全程看侧身）；停步/站定同样面向
// 玩家。腿骨链不齐的老模型（canStrafe=false）无横移步态，回退顺跑向防滑步。
// dx/dz = 玩家 − Bot，返回目标 yaw（rad）。
// front = 模型视觉正面所在局部轴的符号（164 轮实测定案）：英雄 GLB 视觉正面
// = 局部 +Z（kamae 持枪位 L_Hand 前伸 z=+0.49 托护木、R_Hand z=+0.10 托握把
// = 右利手步枪姿态 ⇒ 前方=+Z；旧代码按「正面 -Z」算 yaw 差了 180° = 背对玩家
// 出场）。程序化假人面罩画在 -Z（front=-1）保持旧约定。
export function peekFacingYaw({ canStrafe, velX, moving, stopped, dx, dz, front = 1 }) {
  if (!moving || stopped) return faceTargetYaw(dx, dz, front)
  if (canStrafe) return faceTargetYaw(dx, dz, front) // 正面横移：面向玩家
  return front * (velX > 0 ? Math.PI / 2 : -Math.PI / 2)
}

// 玩家方向 yaw：front=+1（GLB，正面 +Z）yaw=atan2(dx,dz)；front=-1（程序化
// 假人，正面 -Z）= 旧约定 atan2(-dx,-dz)
export function faceTargetYaw(dx, dz, front = 1) {
  return Math.atan2(dx * front, dz * front)
}

// 横移步态权重：pull（拉出即缩）与 cross（贯穿跑过，162 轮起也面向玩家横移）
// 都随移速 0.25→1.15 m/s 淡入横移步态/横移 clip（与 idle→walk 动画权重同
// 曲线，启停无跳变）——cross 若沿用前进 clip，正面横移会全程滑步
export function strafeRampW({ style, speed, minSpeed = 0.25, rampSpeed = 1.15 }) {
  if (style !== 'pull' && style !== 'cross') return 0
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
