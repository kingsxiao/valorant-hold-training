// ============================================================================
// 训练统计汇总（纯函数）：HUD 实时面板与回合结算共用同一口径，避免两处漂移。
// ============================================================================

export function computeStats(s) {
  const rs = s.reactions ?? []
  const n = rs.length
  const avg = n ? Math.round(rs.reduce((a, b) => a + b, 0) / n) : 0
  const best = n ? Math.min(...rs) : 0
  return {
    kills: s.kills ?? 0,
    duelsLost: s.duelsLost ?? 0,
    shots: s.shots ?? 0,
    hits: s.hits ?? 0,
    accuracy: s.shots ? Math.round(s.hits / s.shots * 100) : 0,
    headshotRate: s.hits ? Math.round(s.headshots / s.hits * 100) : 0,
    avgReactionMs: avg,
    bestReactionMs: best,
    maxStreak: s.maxStreak ?? 0,
  }
}

// 规则化训练建议：按本局数据挑最突出的一块短板给一条可执行建议。
// 只挑"最该练的"（优先级从高到低），没有足够数据或没有明显短板则不给。
export function coachingTip(c) {
  if (c.kills + c.duelsLost === 0) return null
  if (c.duelsLost > c.kills)
    return '对枪败多于击杀 —— 把准星预先放在缺口沿的高度，Bot 出现时只需微调，不必大幅甩枪。'
  if (c.avgReactionMs >= 550)
    return '平均反应偏慢 —— 别等看清楚再开枪：缺口出现动静（脚步/边缘露身）就预压准星。'
  if (c.accuracy < 30 && c.shots >= 10)
    return '命中率偏低 —— 开枪前先急停：移动中弹道是扩散的，停稳的那一瞬才是出手时机。'
  if (c.headshotRate < 15 && c.hits >= 5)
    return '爆头率偏低 —— 准星整体上抬到头部线，第一枪就瞄头，身体命中只是意外收获。'
  if (c.maxStreak <= 1 && c.kills >= 2)
    return '连杀总是断 —— 击杀后立刻回准星到缺口，别跟着尸体压枪。'
  if (c.avgReactionMs > 0 && c.avgReactionMs < 350 && c.accuracy >= 45)
    return '反应与命中都在线 —— 试着调快 Bot 出现间隔或反杀时间，逼出自己的上限。'
  return null
}
