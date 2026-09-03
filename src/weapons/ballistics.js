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

// 当前散布（度）：静止精度高，移动/跳跃剧增，蹲下小幅加成，连射小幅追加。
// ctx = { speedRatio: 水平速度/该武器全速 (0..1), crouched, grounded, sprayIndex }
export function spreadAt(w, ctx) {
  if (w.slot === 'melee') return 0
  const s = w.spread
  // 幂 1.4：低速段惩罚平缓、高速段快速逼近跑动散布（贴近游戏体感）
  let sp = s.stand + (s.run - s.stand) * Math.pow(Math.min(1, Math.max(0, ctx.speedRatio)), 1.4)
  if (ctx.crouched) sp *= s.crouchMult
  if (!ctx.grounded) sp = s.jump
  sp += Math.min(ctx.sprayIndex * 0.05, 0.8) // 主要偏差由后坐力弹道表决定
  return sp
}
