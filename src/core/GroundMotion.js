// ============================================================================
// 地面移动模型（纯函数，玩家与 Bot 共用）—— 数值口径见 CONFIG.movement 注释。
//
// 模型（对齐无畏契约公开资料）：
//  - 加速：恒定 accel（社区实测持步枪 18.75 m/s²，按目标速度等比缩放）
//  - 减速：dv/dt = -(decelFlat + decelDrag·|v|)——恒定摩擦 + 速度比例阻尼，
//    解析解 v(t) = (v₀ + flat/drag)·e^(-drag·t) − flat/drag
//  - counter-strafe 无额外收益：反向输入只走摩擦（摩擦 28.6 恒大于加速 18.75；
//    Riot_Classick 官方实测反向键仅省 ~10ms）
//
// 官方急停里程碑（Riot_Classick，Phantom 实测，全跑 5.4 m/s 出发）与模型对照：
//    走路级精度 61% 速度  0.055s   |  模型 0.049s（56.8% @0.055s ✓ 低于门槛）
//    死区 25% 速度        0.104s   |  模型 0.104s（24.3% @0.104s ✓）
//    停稳                 0.160s   |  模型 0.147s（≈，残余差为"完全精度"含枪械恢复）
// ============================================================================

// 单个速度标量向 target 收敛一步（128Hz 调用；符号任意）：
//  - 同向不足：恒定加速；同向超出（降档，如跑→走/蹲）：摩擦减到目标
//  - 反向：摩擦减到 0（本步不越过 0，下一步起由加速分支接管）
export function groundStep(v, target, { accel, decelFlat, decelDrag }, dt) {
  const sv = v > 0 ? 1 : v < 0 ? -1 : 0
  const st = target > 0 ? 1 : target < 0 ? -1 : 0
  const mag = Math.abs(v)
  if (sv === st || sv === 0) {
    const tm = Math.abs(target)
    if (mag < tm) return st * Math.min(tm, mag + accel * dt)
    const drop = (decelFlat + decelDrag * mag) * dt
    return st * Math.max(tm, mag - drop)
  }
  const drop = (decelFlat + decelDrag * mag) * dt
  return sv * Math.max(0, mag - drop)
}

// 加速常数随目标速度等比缩放（实测口径为持步枪 18.75 m/s²@5.4 → 任何档位
// 达标耗时恒 ≈0.29s；社区实测记法"18.75 with Rifle (scales with speed)"）
export function accelFor(targetSpeed, baseAccel, baseSpeed) {
  return baseAccel * (Math.abs(targetSpeed) / baseSpeed)
}
