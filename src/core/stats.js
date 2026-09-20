// ============================================================================
// 训练统计汇总（纯函数）：HUD 实时面板与回合结算共用同一口径，避免两处漂移。
// ============================================================================

// 方向化预瞄偏差的判定门槛：样本 <3 只记幅值不判方向（两三发定不了"习惯"）；
// |偏差| <4° 视为噪声级 —— 说"稳定偏左"得先有稳定且可观的偏移量
const AIM_BIAS_MIN_SAMPLES = 3
const AIM_BIAS_TIP_DEG = 4

// 预瞄偏航方向（纯函数，符号链路在此收敛，锁死"偏左/偏右"不指反）：
// Bot.js 采样 dyaw = p.yaw − yawTo（归一到 −180..180），而 yaw 增大 = 视线
// 左转（Player.applyMouse：鼠标右移 dx>0 → yaw 递减，Player.js），故带符号
// 偏航均值 >0 ⇔ 准星系统性压在目标左侧
export function aimBiasDirection(yawBiasDeg) {
  if (yawBiasDeg > 0) return '偏左'
  if (yawBiasDeg < 0) return '偏右'
  return null
}

// 预瞄俯仰方向：dpitch = p.pitch − pitchTo（Bot.js），pitch 正 = 抬头
// （Player.js 相机 rotation.x 取 pitch，正角把视线抬向 +Y）→ 均值 >0 ⇔ 偏高
export function aimPitchDirection(pitchBiasDeg) {
  if (pitchBiasDeg > 0) return '偏高'
  if (pitchBiasDeg < 0) return '偏低'
  return null
}

// 方向化预瞄偏差文案（HUD 实时行与回合结算格共用同一拼法）：'（偏左·偏高）'
// 形态后缀；样本不足或 |偏差| 低于阈值时返回 ''——噪声级偏差谈方向只会误导
export function aimBiasSuffix(c) {
  if ((c.aimSamples ?? 0) < AIM_BIAS_MIN_SAMPLES) return ''
  const parts = []
  if (Math.abs(c.aimYawBiasDeg ?? 0) >= AIM_BIAS_TIP_DEG) parts.push(aimBiasDirection(c.aimYawBiasDeg))
  if (Math.abs(c.aimPitchBiasDeg ?? 0) >= AIM_BIAS_TIP_DEG) parts.push(aimPitchDirection(c.aimPitchBiasDeg))
  return parts.length ? `（${parts.join('·')}）` : ''
}

export function computeStats(s) {
  const rs = s.reactions ?? []
  const n = rs.length
  const avg = n ? Math.round(rs.reduce((a, b) => a + b, 0) / n) : 0
  // 反应稳定度（样本标准差 ms）：均值之外的第二维度 —— 均值低但波动大
  // 说明状态起伏（瞄点不稳/注意力涣散），压波动往往比抠均值更有效
  const std = n > 1 ? Math.round(Math.sqrt(rs.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1))) : 0
  const best = n ? Math.min(...rs) : 0
  const aes = s.aimErrors ?? []
  // aimErrors 自方向化改造后存 {yaw, pitch, mag}：幅值给"平均偏几度"的旧口径，
  // 带符号分量给偏航/俯仰偏差（正负号含义见 aimBiasDirection / aimPitchDirection）
  const aimAvg = aes.length ? Math.round(aes.reduce((a, b) => a + b.mag, 0) / aes.length * 10) / 10 : 0
  // 带符号偏差均值：对称甩枪（先左甩再右甩）会把幅值均值洗小、但洗不掉固定
  // 符号——方向统计正是补这个盲区。样本不足门槛记 0，与 aimErrorDeg"空=0"
  // 兜底口径一致；显示/建议层再按 |偏差|≥4° 过滤噪声
  const yawBias = aes.length >= AIM_BIAS_MIN_SAMPLES
    ? Math.round(aes.reduce((a, b) => a + b.yaw, 0) / aes.length * 10) / 10 : 0
  const pitchBias = aes.length >= AIM_BIAS_MIN_SAMPLES
    ? Math.round(aes.reduce((a, b) => a + b.pitch, 0) / aes.length * 10) / 10 : 0
  return {
    kills: s.kills ?? 0,
    duelsLost: s.duelsLost ?? 0,
    shots: s.shots ?? 0,
    hits: s.hits ?? 0,
    accuracy: s.shots ? Math.round(s.hits / s.shots * 100) : 0,
    headshotRate: s.hits ? Math.round(s.headshots / s.hits * 100) : 0,
    avgReactionMs: avg,
    bestReactionMs: best,
    reactStdMs: std,
    maxStreak: s.maxStreak ?? 0,
    aimErrorDeg: aimAvg,
    aimSamples: aes.length,
    aimYawBiasDeg: yawBias,
    aimPitchBiasDeg: pitchBias,
  }
}

// 评级：按"得分/分钟"分档（击杀 100+爆头 50+连杀加成的口径下，
// 350/min ≈ 每 17s 一个身体击杀的及格线，1000/min ≈ 稳定爆头连杀的高手线）
export function gradeFor(score, minutes) {
  if (!score || !(minutes > 0)) return '—'
  const perMin = score / minutes
  if (perMin >= 1000) return 'S'
  if (perMin >= 750) return 'A'
  if (perMin >= 550) return 'B'
  if (perMin >= 350) return 'C'
  return 'D'
}

// 规则化训练建议：按本局数据挑最突出的一块短板给一条可执行建议。
// 只挑"最该练的"（优先级从高到低），没有足够数据或没有明显短板则不给。
export function coachingTip(c) {
  if (c.kills + c.duelsLost === 0) return null
  if (c.duelsLost > c.kills)
    return '漏杀多于击杀 —— 把准星预先放在缺口沿的高度，Bot 出现时只需微调，不必大幅甩枪。'
  // 系统性预瞄偏移（带方向）：|偏差|≥4° 且样本≥3 —— 习惯性压左/压右/偏高/偏低
  // 是预瞄习惯问题，一次纠偏每波都吃到；取偏差更大的轴给建议
  const yB = c.aimYawBiasDeg ?? 0
  const pB = c.aimPitchBiasDeg ?? 0
  if (c.aimSamples >= AIM_BIAS_MIN_SAMPLES && (Math.abs(yB) >= AIM_BIAS_TIP_DEG || Math.abs(pB) >= AIM_BIAS_TIP_DEG)) {
    const useYaw = Math.abs(yB) >= Math.abs(pB)
    const dir = useYaw ? aimBiasDirection(yB) : aimPitchDirection(pB)
    const deg = Math.abs(useYaw ? yB : pB)
    const fix = useYaw
      ? (dir === '偏左' ? '整体右移' : '整体左移')
      : (dir === '偏高' ? '整体下压' : '整体上抬')
    return `露头瞬间准星稳定${dir} ${deg}°—— 这是习惯性偏移不是随机散布，把默认预瞄点${fix}几度，一次纠偏每波对枪都吃到。`
  }
  if (c.aimSamples >= 3 && c.aimErrorDeg >= 12)
    return `露头瞬间准星平均偏了 ${c.aimErrorDeg}°—— 预瞄点要贴在缺口沿（A 缺口看左沿、B 缺口看右沿），出现后只补最后几度。`
  if (c.avgReactionMs >= 550)
    return '平均反应偏慢 —— 别等看清楚再开枪：缺口出现动静（脚步/边缘露身）就预压准星。'
  if (c.reactStdMs >= 160 && c.avgReactionMs > 0)
    return `反应波动 ±${c.reactStdMs}ms 偏大 —— 快慢起伏说明瞄点不稳，先固定预瞄点压波动，再抠速度。`
  if (c.accuracy < 30 && c.shots >= 10)
    return '命中率偏低 —— 开枪前先急停：移动中弹道是扩散的，停稳的那一瞬才是出手时机。'
  if (c.headshotRate < 15 && c.hits >= 5)
    return '爆头率偏低 —— 准星整体上抬到头部线，第一枪就瞄头，身体命中只是意外收获。'
  if (c.maxStreak <= 1 && c.kills >= 2)
    return '连杀总是断 —— 击杀后立刻回准星到缺口，别跟着尸体压枪。'
  if (c.avgReactionMs > 0 && c.avgReactionMs < 350 && c.accuracy >= 45)
    return '反应与命中都在线 —— 试着调快 Bot 出现间隔或缩短击杀时限，逼出自己的上限。'
  return null
}
