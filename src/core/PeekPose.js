// 出场姿势（纯函数，Bot.step 与单测共用）
// 两种姿势各 50% 交替（BotManager 抽签、防连击）：
//  cross 侧身跑过 —— 身体顺跑向（±π/2 yaw），侧身入镜贯穿缺口
//  pull  横向拉出 —— 面向玩家横移（strafe 对枪姿态）拉到窗口内急停
// GLB 骨骼假人只有前进向 clip：pull 的横移步态用「髋部向移动方向偏转 +
// 脊柱逐节回正」拼出来（strafeGait），骨骼链不齐的老模型退回顺跑向防滑步

// 朝向判定：横移中 cross=顺跑向 / pull=面向玩家；停步/站定一律转回面向
// 玩家（停步挑战）。dx/dz = 玩家 − Bot，返回目标 yaw（rad）
export function peekFacingYaw({ style, canStrafe, velX, moving, stopped, dx, dz }) {
  if (!moving || stopped) return faceTargetYaw(dx, dz)
  if (style === 'pull' && canStrafe) return faceTargetYaw(dx, dz) // 横向拉出：面向玩家横移
  return velX > 0 ? -Math.PI / 2 : Math.PI / 2                    // 侧身跑过 / 无骨骼链回退
}

// 玩家方向 yaw（与视角同约定：模型正面 -Z）
export function faceTargetYaw(dx, dz) {
  return Math.atan2(-dx, -dz)
}

// GLB 横移步态的骨骼偏转量：髋部（Hips）绕局部 Y 偏转 ±maxYaw·w —— 前进
// clip 的迈步方向是局部 -Z，转 ±π/2 后脚掌恰好顺移动方向迈步（不滑步）；
// 脊柱逐节回正合计 −髋偏转·w（Bot 按节数均分）—— 胸肩/头正对玩家（持枪
// 对枪姿态）。w 随移速 0.25→1.15 m/s 淡入淡出（与 idle→walk 动画权重同
// 曲线），启停无关节跳变。lateralVel = 模型局部横向速度（右侧 +X 为正）
export function strafeGait({ style, speed, lateralVel, minSpeed = 0.25, rampSpeed = 1.15, maxYaw = Math.PI / 2 }) {
  const w = style === 'pull'
    ? Math.min(1, Math.max(0, (speed - minSpeed) / (rampSpeed - minSpeed)))
    : 0
  if (w <= 0) return { w: 0, hipYaw: 0, lean: 0 }
  return { w, hipYaw: -Math.sign(lateralVel || 1) * maxYaw * w, lean: leanInto(lateralVel) }
}

// 向移动方向微倾（与程序化假人 _stepLegs 同参数）；回正速率由调用侧平滑
export function leanInto(lateralVel) {
  return Math.min(0.05, Math.max(-0.05, -lateralVel * 0.011))
}
