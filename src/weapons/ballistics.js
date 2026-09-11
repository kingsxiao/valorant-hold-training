// ============================================================================
// 弹道纯函数：伤害衰减 / 移动散布 —— 与渲染无关，独立可测。
// 武器数值全部来自 CONFIG.weapons（调用方传当前武器定义）。
// ============================================================================
import { CONFIG } from '../core/Config.js'

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
//  - 站立首发 stand；走路（静步 62.8% 速 ≈3.39 m/s）walk；全速 run —— 分段幂 1.4
//    曲线精确过这三锚点（低速段惩罚平缓、高速段快速逼近跑动散布，贴近游戏体感）
//  - 蹲姿限速 34%：独立支线 = stand×crouchMult + 蹲走惩罚 crouchMove（v9.10 起公开值）
//  - 空中直接取 jump（跳跃大幅扩散）
//  - 连射逐发 +0.05°，封顶在 max - stand（= 持续射击最大散布）
// ctx = { speedRatio: 水平速度/该武器全速 (0..1), crouched, grounded, sprayIndex }
export function spreadAt(w, ctx) {
  return spreadParts(w, ctx).total
}

// spreadAt 的分量拆分：准星动态误差需要"移动误差/开火误差"两路独立信号
// （对应游戏准星设置里内外线各自的移动/开火误差开关与倍率）：
//  - move：移动/跳跃超出当前姿态静止基准的超额部分（站定 = 0，游戏里站定即无移动误差）
//  - fire：连射逐发增长（sprayIndex × 0.05°，封顶同上）
//  - total：两者之和（= 旧 spreadAt，弹道采样口径不变）
export function spreadParts(w, ctx) {
  if (w.slot === 'melee') return { move: 0, fire: 0, total: 0 }
  const s = w.spread
  // ctx.ads（开镜态）：静止基准/连射封顶换成维基 Alternate Fire 行的 ADS 值
  // （首发更小、封顶反而略高于腰射）；移动加算惩罚（+°）维基标注与腰射同值，
  // 锚点曲线沿腰射 walk/run 的"加算量"平移到 ADS 基准上
  const a = ctx.ads && w.ads ? w.ads : null
  const stand = a ? a.stand : s.stand
  const crouchRest = a ? a.crouch : s.stand * s.crouchMult
  const walkV = stand + (s.walk - s.stand)
  const runV = stand + (s.run - s.stand)
  const r = Math.min(1, Math.max(0, ctx.speedRatio))
  // 锚点用 CONFIG.movement 的真实姿态速度：walk 值在静步速度处精确命中（62.8%），
  // 蹲走惩罚在蹲姿满速（34%）处满额 —— 散布曲线与移动模型同一套速度口径
  const walkA = CONFIG.movement.walkMult
  const crouchA = CONFIG.movement.crouchMult
  let sp
  if (ctx.crouched) {
    sp = crouchRest + s.crouchMove * Math.pow(Math.min(1, r / crouchA), 1.4)
  } else if (r <= walkA) {
    sp = stand + (walkV - stand) * Math.pow(r / walkA, 1.4)
  } else {
    sp = walkV + (runV - walkV) * Math.pow((r - walkA) / (1 - walkA), 1.4)
  }
  // 静止基准随姿态走：蹲姿基准 = 蹲立散布（蹲得越低基准越低）；空中无基准，
  // 跳跃散布全额计入移动误差（游戏中跳跃即最大移动误差）
  const rest = ctx.grounded ? (ctx.crouched ? crouchRest : stand) : 0
  if (!ctx.grounded) sp = s.jump
  const maxSp = a ? a.maxStand : (s.max ?? s.stand + 0.8)
  const fire = Math.min(ctx.sprayIndex * 0.05, Math.max(0, maxSp - stand))
  return { move: Math.max(0, sp - rest), fire, total: sp + fire }
}
