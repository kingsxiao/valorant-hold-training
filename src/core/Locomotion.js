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
  return new THREE.AnimationClip(name, jsonClip.duration, tracks)
}

// 池条目用：heroKey 的 N 集（jett/sova 各自官方曲线，未知英雄回退 jett）+
// 横移 E/W 集（Sova 官方方向性曲线，四英雄共用——Jett 的 E/W 腿轨道是 N 的
// 导出复件，非真横移）。数据不齐返回 null（Bot 退回烘焙近似）。
export function buildLocomotion(locoJson, heroKey, skeletonRoot) {
  const heroSet = locoJson?.[heroKey] ?? locoJson?.jett
  const strafeSet = locoJson?.strafe
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
  return { walk, run, strafe }
}

// 走/跑/横移的动画权重分配（纯函数，Bot._setAnimWeights 与单测共用）：
// idle ↔ 走 ↔ 跑 × 前进(N)/横移(E/W) 两组正交分配——横移权重 wS 把 moveW 按
// (1-wS)/wS 分给 N 与 E/W，走↔跑再按 runW 内分。无 idle 动作的老模型 walk
// 承接 (1-moveW) 残余（单 clip 冻结语义）
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
