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

// 程序化侧移步态的姿态量 —— 官方口径（TP_Core RunE/W 真方向性循环实测，
// python3 assets-raw/psa_analyze.py assets-raw/core-psa/TP_Core_Run{E,W}_LB.psa）：
// 横移无交叉步——前腿沿运动方向跨、后腿蹬伸，大腿前后剪方向性不对称：
//   RunE（局部左移）大腿 L ∈ [−71°, +4.3°]  → 幅 0.657rad、后蹬偏置 −0.582
//   RunW（局部右移）大腿 L ∈ [+5.5°, +55.8°] → 幅 0.439rad、前跨偏置 +0.535
// 髋外展同向不对称：RunE [−27.6°, +20°] / RunW [−9.1°, +37.2°] → 幅 0.41 +
// 方向偏置 ±0.155（两侧实测均值）。R 腿 = L 的反相镜像（循环节奏不变）。
// ⚠ 旧版「对称正弦 thigh 0.70~0.82 + 反向交叉 yaw」（sova-psa Q_Bow_RunE 旧口径）
//   无方向性前后剪，横移跑姿读作原地开合（审计缺陷 #6）；yaw 脚尖朝向机制
//   保留（新数据提取未含腿链 yaw 区间）。膝曲线官方 WalkE/RunE 双锚点按速度
//   插值保留：走速以下全程 WalkE 深膝（起步拉出不再浅膝碎步——官方走速横移
//   本身就是 88.7° 峰值大幅深膝）：
//   WalkE 膝 基础 28.1°/峰值 88.7° → base 0.49 / swing 1.06 rad
//   RunE  膝 基础 11.5°/峰值 ~106° → base 0.20 / swing = GAIT.run.knee
// 相位由里程推进（每步 π，调用侧保证横移步距口径，见 Bot.STRAFE_STEP_LEN）；
// abduct 消费端 Bot._applyLegPose 的 Z 轴镜像取反不在本函数——与单测锁值解耦
const STRAFE_WALKE = { base: 0.49, swing: 1.06 }
// leg() 内联化暂存（thigh/knee 顺序消费后立即写入 out——128Hz 热路径零分配，
// 与 locoWeights 的 _lwOut 同手法）；单次只有一份，L 消费完才算 R
const _ssLegOut = { thigh: 0, knee: 0 }
function _ssLeg(p, thighAmp, b, base, swing) {
  _ssLegOut.thigh = thighAmp * Math.sin(p) + b
  _ssLegOut.knee = base + swing * Math.max(0, -Math.sin(p - 0.5))
  return _ssLegOut
}
// out（可选）：热路径调用侧传自己的模块级 scratch；缺省新建 = 纯函数语义不变
// （单测锁值不传 out，返回形状与旧版逐字段一致）
export function strafeStepPose({ speed, phase, lateralVel, moveSpeed = 5.4 }, out = null) {
  const o = out ?? { s: 0, yawL: 0, yawR: 0, thighL: 0, thighR: 0, kneeL: 0, kneeR: 0, abductL: 0, abductR: 0, bob: 0, lean: 0 }
  const t = Math.min(1, Math.max(0, (speed - 3.39) / (moveSpeed - 3.39)))
  const base = STRAFE_WALKE.base + (0.20 - STRAFE_WALKE.base) * t
  const swing = STRAFE_WALKE.swing + (GAIT.run.knee - STRAFE_WALKE.swing) * t
  const sgn = -Math.sign(lateralVel || 1) // 模型右 +X：向右移交叉朝向整体换侧
  const dir = -sgn // 运动方向（+1 = 局部右移 = W 族）
  // 方向性前后剪（L 腿实测、R 反相镜像）：幅 0.548±0.109 随向、偏置 ∓0.56——
  // 前腿沿运动方向跨（W 的 L 前跨 +0.535、E 的 L 后蹬 −0.582）
  const thighAmp = 0.548 + (sgn > 0 ? 0.109 : -0.109)
  const thighBias = -sgn * 0.56
  const L = _ssLeg(phase, thighAmp, thighBias, base, swing)
  o.thighL = L.thigh; o.kneeL = L.knee
  const R = _ssLeg(phase + Math.PI, thighAmp, -thighBias, base, swing)
  o.thighR = R.thigh; o.kneeR = R.knee
  const yawOsc = Math.cos(phase) * 0.12
  const ab = Math.cos(phase) * 0.41 * (0.75 + 0.25 * t)
  o.s = Math.cos(phase)
  o.yawL = sgn * 0.90 + yawOsc
  o.yawR = -sgn * 0.90 + yawOsc
  o.abductL = -ab + dir * 0.155
  o.abductR = ab + dir * 0.155
  o.bob = (1 - Math.abs(Math.cos(phase))) * (0.01 + speed * 0.0036)
  o.lean = leanInto(lateralVel)
  return o
}

// 向移动方向微倾（与程序化假人 _stepLegs 同参数）；回正速率由调用侧平滑。
// 上限对齐官方：Sova RunE/W 盆骨侧倾均值 -4.8°/+9.8°（镜像入移动方向），取
// 全速 ~0.12rad≈6.9°（0.02×5.4=0.108 未触顶）
export function leanInto(lateralVel) {
  return Math.min(0.12, Math.max(-0.12, -lateralVel * 0.02))
}
