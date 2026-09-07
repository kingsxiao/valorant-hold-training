// ============================================================================
// 弹道纯函数：伤害衰减 / 移动散布 —— 与渲染无关，独立可测。
// 武器数值全部来自 CONFIG.weapons（调用方传当前武器定义）。
// ============================================================================

// 分段衰减伤害：falloff 为按 maxDist 升序的档位数组，命不中档位回退基础值
export function damageFor(w, zone, dist) {
  const base = w.damage[zone] ?? w.damage.body
  if (!w.falloff) return base
  for (const tier of w.falloff) {
    if (dist <= tier.maxDist) return tier.damage[zone] ?? tier.damage.body
  }
  return base
}

// 当前散布（度）。数值锚点对齐 Fandom 维基 Spread values 表（公开资料值）：
//  - 站立首发 stand；走路（50% 速）walk；全速 run —— 分段幂 1.4 曲线精确过这三点
//    （低速段惩罚平缓、高速段快速逼近跑动散布，贴近游戏体感）
//  - 蹲姿限速 34%：独立支线 = stand×crouchMult + 蹲走惩罚 crouchMove（v9.10 起公开值）
//  - 空中直接取 jump（跳跃大幅扩散）
//  - 连射逐发 +0.05°，封顶在 max - stand（= 持续射击最大散布）
// ctx = { speedRatio: 水平速度/该武器全速 (0..1), crouched, grounded, sprayIndex }
export function spreadAt(w, ctx) {
  if (w.slot === 'melee') return 0
  const s = w.spread
  const r = Math.min(1, Math.max(0, ctx.speedRatio))
  let sp
  if (ctx.crouched) {
    sp = s.stand * s.crouchMult + s.crouchMove * Math.pow(Math.min(1, r / 0.34), 1.4)
  } else if (r <= 0.5) {
    sp = s.stand + (s.walk - s.stand) * Math.pow(r / 0.5, 1.4)
  } else {
    sp = s.walk + (s.run - s.walk) * Math.pow((r - 0.5) / 0.5, 1.4)
  }
  if (!ctx.grounded) sp = s.jump
  sp += Math.min(ctx.sprayIndex * 0.05, Math.max(0, (s.max ?? s.stand + 0.8) - s.stand))
  return sp
}
