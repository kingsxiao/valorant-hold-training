// 官方 .psa 骨骼动画（scripts/psa2clips.mjs 转换的 public/models/locomotion.json）
// → AnimationClip。英雄 GLB 与 psa 同源同约定（实测：psa Aim 站姿与 GLB kamae
// 第 0 帧逐骨 0.0°、位置 cm×0.01 精确进位）——走/跑/横移直接播放官方骨骼曲线，
// 步态数学近似（GaitBake.bakeLocomotionClips）只留给没有官方数据的模型。
// 骨名解析：psa 存无后缀名（L_Knee），英雄 GLB 带 _NNNN 后缀（L_Knee_0137，
// 每英雄编号不同）——按「去尾缀」在目标骨架上解析成实际骨名再建轨道。
import * as THREE from 'three'

export function buildClip(jsonClip, skeletonRoot, name = 'loco') {
  const byStripped = new Map()
  skeletonRoot.traverse(o => {
    if (o.isBone) {
      const k = o.name.replace(/_\d+$/, '')
      if (k && !byStripped.has(k)) byStripped.set(k, o.name)
    }
  })
  const tracks = []
  for (const t of jsonClip.tracks) {
    const boneName = byStripped.get(t.b)
    if (!boneName) continue // 目标骨架没有该骨（如 _end 辅助骨）——跳过
    tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, jsonClip.times, t.q))
    if (t.p) tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, jsonClip.times, t.p))
  }
  if (!tracks.length) return null
  const clip = new THREE.AnimationClip(name, jsonClip.duration, tracks)
  // 官方 IK 目标锚曲线（盆骨局部，脚部落地的本体数据）：不进 mixer（GLB 无对应
  // 骨也不需要），Bot._stepFootPin 按 action.time 采样作钉地锚
  if (jsonClip.ik) clip.userData.ik = { L: jsonClip.ik.L, R: jsonClip.ik.R, n: jsonClip.n }
  return clip
}

// 池条目用：core 集（TP_Core 共享移动循环，四英雄同款——本体移动就用它）+
// 横移 E/W 集（TP_Core 真方向性循环）。旧英雄名（jett/sova）留作回退兼容。
// 数据不齐返回 null（Bot 退回烘焙近似）。
export function buildLocomotion(locoJson, heroKey, skeletonRoot) {
  const heroSet = locoJson?.core ?? locoJson?.[heroKey] ?? locoJson?.jett
  const strafeSet = locoJson?.strafe ?? locoJson?.core
  if (!heroSet?.walkN || !heroSet?.runN) return null
  const build = (c, name) => (c ? buildClip(c, skeletonRoot, name) : null)
  const walk = build(heroSet.walkN, `${heroKey}-walkN`)
  const run = build(heroSet.runN, `${heroKey}-runN`)
  if (!walk || !run) return null
  const strafe = strafeSet
    ? {
      E: { walk: build(strafeSet.walkE, 'strafe-walkE'), run: build(strafeSet.runE, 'strafe-runE') },
      W: { walk: build(strafeSet.walkW, 'strafe-walkW'), run: build(strafeSet.runW, 'strafe-runW') },
    }
    : null
  if (strafe && (!strafe.E.walk || !strafe.E.run)) return { walk, run, strafe: null }
  // 官方死亡整身 clip（背摔/前扑）：缺席不阻塞移动集（Bot 退回烘焙塌倒）
  const deathSet = locoJson?.death
  const death = deathSet
    ? { back: build(deathSet.back, 'death-back'), front: build(deathSet.front, 'death-front') }
    : null
  return { walk, run, strafe, death }
}

// 死亡倒向选择（纯函数）：dot = 「bot 朝向」与「bot→玩家」的前向点积。
// 玩家在 bot 正面（dot>0）→ 弹道把人向后打 = 背摔；背后/侧后 → 前扑
export function pickDeathSide(forwardDot) {
  return forwardDot > 0 ? 'back' : 'front'
}

// 官方 IK 目标锚采样（纯函数，Bot._stepFootPin 与单测共用）：在 clip 的 ik
// 曲线（L/R 各 n×3 帧，盆骨局部空间）上按动作播放头 t 线性插值。返回 out
// （Vector3，盆骨局部），无数据返回 null
export function sampleIkAnchor(ik, duration, n, t, side, out) {
  if (!ik?.[side] || ik[side].length < 3) return null
  const f = Math.min(n - 1, Math.max(0, (t / duration) * (n - 1)))
  const i = Math.min(n - 2, Math.floor(f)), k = f - i
  const a = ik[side]
  out.set(
    a[i * 3] + (a[i * 3 + 3] - a[i * 3]) * k,
    a[i * 3 + 1] + (a[i * 3 + 4] - a[i * 3 + 1]) * k,
    a[i * 3 + 2] + (a[i * 3 + 5] - a[i * 3 + 2]) * k,
  )
  return out
}

// 走/跑/横移的动画权重分配（纯函数，Bot._setAnimWeights 与单测共用）：
export function locoWeights({ moveW, runW, strafeW = 0, hasStrafe = false }) {
  const wS = hasStrafe ? strafeW : 0
  const idle = 1 - moveW
  const noIdleWalk = moveW // 无 idle 动作时的 walk 残余（见调用侧）
  return {
    idle,
    walkN: moveW * (1 - runW) * (1 - wS),
    runN: moveW * runW * (1 - wS),
    walkS: moveW * (1 - runW) * wS,
    runS: moveW * runW * wS,
    walkNoIdle: noIdleWalk * (1 - runW) * (1 - wS) + idle,
  }
}

// 脚钉地状态机（纯函数，Bot._stepFootPin 与单测共用）：支撑判定 + 权重坡。
// 迟滞带（engageY < releaseY）防边界抖动；权重 ramp 让 IK 修正进入/退出平滑
// （20/s ≈ 50ms 全幅）。y 用脚的世界高度（锚点由调用侧在入锚沿记录）。
// 阈值口径：跑动支撑期脚踝 ~0.15m、摆动 0.4~1.0m，0.21/0.26 取分离带。
export function stepFootPinState(st, y, dt, { engageY = 0.21, releaseY = 0.26, rate = 20 } = {}) {
  if (!st.has) {
    if (y < engageY) st.has = true
  } else if (y > releaseY) {
    st.has = false
  }
  st.w = Math.max(0, Math.min(1, st.w + (st.has ? dt * rate : -dt * rate)))
  return st
}
