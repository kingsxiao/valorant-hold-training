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
  }
}
