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
  // psa 根链参考系修正（2026-09-12 全身扭曲回归根因）：psa 导出把根链骨
  // Splitter / Skeleton 的旋转轨道值写成了英雄 GLB rest 旋转的「逆」（Splitter
  // 轨道恒 (0.5,0.5,0.5,-0.5)，GLB rest = (0.5,0.5,0.5,+0.5)，相差 120°）——
  // 直挂应用会把 Splitter 以下整副骨架放倒（超人姿）。
  // 修正 = 只跳过根链骨的旋转轨道（两者恒定、不参与动画，保持 GLB rest）；
  // 其余全部原样：Splitter 以下的 psa 局部四元数/位置在「GLB Splitter rest ×
  // psa 原始链」的组合下恰好逐帧复现官方世界姿态（M⊗P_split = Skel⊗G 恒等，
  // 无需任何逐骨换系——157 轮曾试过对直接子骨左乘 restQ，反而把髋关节偏移
  // 转到骨盆上方 10cm，腿全歪，158 轮回退）。位置轨道（Splitter 高度/骨盆
  // 微动/死亡根位移/IK 足骨/武器挂点）与旋转轨道全部原样保留：官方空间 =
  // 原始骨架空间（psa 与英雄 GLB 骨骼同源同约定，cm×0.01 精确进位），mixer
  // 播放时经英雄根缩放（UserAssets normalizeAgent 的 ×s）整体缩放——身体与
  // IK 锚曲线同空间同倍率，锚-髋几何才与官方自洽（2026-09-28 二轮定稿：
  // 一轮曾在此 ÷s，导致身体矮于 kamae/idle 且锚不可达——双脚腾空/滑步回归，
  // 已回退；缩放消费统一在 Bot._stepFootPin 的锚升世界处 ×s）
  const tracks = []
  for (const t of jsonClip.tracks) {
    const boneName = byStripped.get(t.b)
    if (!boneName) continue // 目标骨架没有该骨（如 _end 辅助骨）——跳过
    if (t.b === 'Splitter' || t.b === 'Skeleton') {
      // 根链：只保留位置轨道
      if (t.p) tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, jsonClip.times, t.p))
      continue
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, jsonClip.times, t.q))
    if (t.p) tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, jsonClip.times, t.p))
  }
  if (!tracks.length) return null
  const clip = new THREE.AnimationClip(name, jsonClip.duration, tracks)
  // 官方 IK 目标锚曲线（根骨空间=原始骨架空间，脚部落地的本体数据）：不进
  // mixer（GLB 无对应骨也不需要），Bot._stepFootPin 按 action.time 采样后
  // ×英雄根缩放升世界（与身体同一 ×s——锚-髋距离的官方自洽几何由此保持，
  // 支撑锚带 0.115~0.137 为原始空间口径，世界值随英雄 ×s）
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
  // strafe 只要有一侧不完整（如 json 只带 walkE/runE 无 W 侧）就整体置 null：
  // Bot 的消费侧（权重/播放头/对侧压零）假设 E/W 四键齐全，缺任一会
  // mk(null)→clipAction(null) 在构造函数里抛 TypeError
  if (strafe && (!strafe.E.walk || !strafe.E.run || !strafe.W.walk || !strafe.W.run)) {
    return { walk, run, strafe: null }
  }
  // 官方死亡整身 clip（背摔/前扑）：缺席不阻塞移动集（Bot 退回烘焙塌倒）
  const deathSet = locoJson?.death
  const death = deathSet
    ? { back: build(deathSet.back, 'death-back'), front: build(deathSet.front, 'death-front') }
    : null
  // 蹲踞待机循环（官方蹲姿根高，全程蹲姿的 4.5s 循环）：缺席不阻塞
  const crouchIdle = locoJson?.crouch?.idle ? build(locoJson.crouch.idle, 'crouch-idle') : null
  // 蹲走循环（官方）：N = 正面走出（walkout 沿 z 前进），E/W = 横移（台架/
  // 旧拉出语义）；缺席不阻塞
  const crouchWalk = locoJson?.crouch?.walkE
    ? {
      N: locoJson.crouch.walkN ? build(locoJson.crouch.walkN, 'crouch-walkN') : null,
      E: build(locoJson.crouch.walkE, 'crouch-walkE'),
      W: build(locoJson.crouch.walkW, 'crouch-walkW'),
    }
    : null
  // 跑动上身叠加层（加法）：与 RunN 同相（0.6s），Spine/颈/头/枪锚骨的官方
  // 跑动胸口运动；缺席不阻塞
  const runAddSet = locoJson?.runAdd
  const runAdd = runAddSet
    ? Object.fromEntries(Object.entries(runAddSet).map(([k, c]) => [k, build(c, `run-add-${k}`)]))
    : null
  if (runAdd) for (const c of Object.values(runAdd)) {
    THREE.AnimationUtils.makeClipAdditive(c, 0)
    c.blendMode = THREE.AdditiveAnimationBlendMode
  }
  // 161 轮玩法收敛（纯移动靶：不停步/不跳）后停步转身踏步（turn 8 向）、急停
  // 支架（stopAdd）与跳 peek（jump 三段）整层下线——不再构建，json 里的对应
  // 集是待清理的遗留数据
  return { walk, run, strafe, death, runAdd, crouchIdle, crouchWalk }
}

// 蹲走拉出移速口径：本体蹲走 = 50% 跑速（5.4）≈ 2.7m/s（Config 可调，试玩
// 档位）
export const CROUCH_WALK_SPEED = 2.7

// 蹲走锁相步幅（纯常量，Bot 与单测共用）：步幅是 clip 的几何属性，与移速
// 无关——移速只改步频（cadence = 移速/步幅）。触地窗（z≤zMin+4mm）后扫速率
// 实测 1.53~1.61 m/s → 步距 = 速率×周期/2 = 0.71~0.75 取 0.735（160 轮：
// 与走/跑族同判定学；旧 0.84 是锚水平总扫幅口径，含跟趾滚动的重复计量，
// 播放慢 14% = 蹲走支撑 0.30 m/s 滑步）。⚠ 141 轮曾把步幅改成「随移速派生」
// （speed×0.4667）——那会让步频恒定、滑步随移速线性放大，是回归，勿改回
export const CROUCH_WALK_STEP = 0.735

// 官方步距（走/跑/横移的相位锁相基准；Bot.step 的 mixer 分支与单测共用）。
// 实测方法（scripts/analyze-gait-data.mjs，psa 锚曲线）：
//  - 跑族（有腾空相，触地占周期 <100%）：stepLen = 触地窗（z≤zMin+4mm 的
//    平台段）后扫速率 × 周期 / 2 ——runN 1.54 与旧单一常量 1.55 互证；
//    横移跑 E/W = 1.40/1.39（触地窗速率 4.4-5.0 m/s，非 5.4）
//  - 全触地步态（走/蹲走，无腾空相）：stepLen = 锚水平扫幅（每步净推进）——
//    walkN/E/W = 0.99~1.05 取 1.05，与触地窗法在走上互证一致
// ⚠ 各族天然速度不同（跑 N ≈5.4@1x、横移跑 ≈4.6、走 ≈2.4）：官方引擎按实际
//   移速缩放播放速率。曾用单一 STEP_LEN=1.55 统一锁相——对跑成立，对走播放
//   慢 ~35%（走态支撑滑步 ~1.0 m/s）、横移跑慢 ~9%（160 轮修正）
export const STEP_WALK = 1.05
export const STEP_RUN = 1.54
export const STEP_STRAFE_RUN = 1.40

// 当前混合态的有效步距（纯函数，相位推进速率 = 移速/步距）：前进族按 runW
// 内插、横移按 strafeW 内插——权重连续 → 步距连续（换态无相位速率跳变）
export function gaitStepLen({ runW = 0, strafeW = 0 } = {}) {
  const c = (v) => Math.min(1, Math.max(0, v))
  const fwd = STEP_WALK + (STEP_RUN - STEP_WALK) * c(runW)
  const side = STEP_WALK + (STEP_STRAFE_RUN - STEP_WALK) * c(runW)
  return fwd + (side - fwd) * c(strafeW)
}

// 死亡倒向选择（纯函数）：dot = 「bot 朝向」与「bot→玩家」的前向点积。
// 玩家在 bot 正面（dot>0）→ 弹道把人向后打 = 背摔；背后/侧后 → 前扑
export function pickDeathSide(forwardDot) {
  return forwardDot > 0 ? 'back' : 'front'
}

// 官方 IK 目标锚采样（纯函数，Bot._stepFootPin 与单测共用）：在 clip 的 ik
// 曲线（L/R 各 n×3 帧，根骨空间）上按动作播放头 t 线性插值。返回 out
// （Vector3，根骨空间），无数据返回 null
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
// out：可选复用对象（Bot 128Hz 热路径零分配；不传时每次新对象，纯函数语义不变）
export function locoWeights({ moveW, runW, strafeW = 0, hasStrafe = false }, out) {
  const wS = hasStrafe ? strafeW : 0
  const idle = 1 - moveW
  const noIdleWalk = moveW // 无 idle 动作时的 walk 残余（见调用侧）
  const r = out ?? {}
  r.idle = idle
  r.walkN = moveW * (1 - runW) * (1 - wS)
  r.runN = moveW * runW * (1 - wS)
  r.walkS = moveW * (1 - runW) * wS
  r.runS = moveW * runW * wS
  r.walkNoIdle = noIdleWalk * (1 - runW) * (1 - wS) + idle
  return r
}

// 官方 IK 锚曲线的支撑/摆动落地窗（锚 z = 踝离地高，psa 实测）：支撑
// 0.123~0.155、摆动 0.31+——脚步声/落地事件如需判定窗，用 0.21/0.26 分离带。
// （旧「支撑窗钉地状态机」已在 2026-09-11 抽搐修复中移除：官方锚曲线全程
// 驱动脚部，不存在释放回 clip 姿态的动作——释放窗内慢放=拖拽、快放=瞬移，
// 双向都是跳变）
