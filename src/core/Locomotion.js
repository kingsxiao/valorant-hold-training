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
  // 微动/死亡根位移）在公共父框架 z-up 里与 GLB 一致，原样保留
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
  // 跳 peek（JumpN 起跳保持 + Falling 滞空循环 + JumpLand 落地恢复）：缺席不阻塞
  const jump = locoJson?.jump
    ? {
      jumpN: build(locoJson.jump.jumpN, 'jump-n'),
      jumpLand: build(locoJson.jump.jumpLand, 'jump-land'),
      fall: locoJson.jump.fall ? build(locoJson.jump.fall, 'jump-fall') : null,
    }
    : null
  // 跑动上身叠加层（加法）：与 RunN 同相（0.6s），Spine/颈/头/枪锚骨的官方
  // 跑动胸口运动；缺席不阻塞
  const runAddSet = locoJson?.runAdd
  const runAdd = runAddSet
    ? Object.fromEntries(Object.entries(runAddSet).map(([k, c]) => [k, build(c, `run-add-${k}`)]))
    : null
  // 停步转身踏步（8 向）+ 急停支架（加法层）：缺席不阻塞
  const turnSet = locoJson?.turn
  const turn = turnSet
    ? Object.fromEntries(Object.entries(turnSet).map(([k, c]) => [k, build(c, `turn-${k}`)]))
    : null
  let stopAdd = locoJson?.stopAdd ? build(locoJson.stopAdd, 'stop-add') : null
  if (stopAdd) {
    // psa 导出是绝对姿态；转成相对首帧的偏移 + 加法混合，才能叠在 kamae 上
    // （急停支架 = 上身后压，叠加而非替换：kamae 持枪手形不丢）
    THREE.AnimationUtils.makeClipAdditive(stopAdd, 0)
    stopAdd.blendMode = THREE.AdditiveAnimationBlendMode
  }
  if (runAdd) for (const c of Object.values(runAdd)) {
    THREE.AnimationUtils.makeClipAdditive(c, 0)
    c.blendMode = THREE.AdditiveAnimationBlendMode
  }
  return { walk, run, strafe, death, turn, stopAdd, runAdd, crouchIdle, crouchWalk, jump }
}

// 蹲走拉出移速口径：本体蹲走 = 50% 跑速（5.4）≈ 2.7m/s（Config 可调，试玩
// 档位）
export const CROUCH_WALK_SPEED = 2.7

// 滞空换层混合比（纯函数，Bot 跳跃块与单测共用）：JumpN 空中段 → Falling 循
// 环的 crossfade 权重。airT = 滞空时间（s）；FALL_AFTER 起淡入、+FADE_S 完成
// ——布尔瞬切会让两套空中姿态硬跳一帧
export const JUMP_FALL_AFTER = 0.35
export const JUMP_FALL_FADE = 0.18
export function jumpFallBlend(airT) {
  const x = Math.min(1, Math.max(0, (airT - JUMP_FALL_AFTER) / JUMP_FALL_FADE))
  return x * x * (3 - 2 * x) // smoothstep
}

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

// 停步转身选型（纯函数）：deltaYaw = 朝向差（最短角，rad，正=左转）。
// 命名约定：E=向右转（yaw 减）、W=向左转（yaw 增），角度取最近档。
// |deltaYaw| < 0.35rad（~20°）不值得出转身踏步 → null（走急停支架）
export function pickTurnClip(deltaYaw) {
  const deg = Math.abs(deltaYaw) * 180 / Math.PI
  if (deg < 20) return null
  let best = 45
  for (const a of [45, 90, 135, 180]) {
    if (Math.abs(a - deg) < Math.abs(best - deg)) best = a
  }
  return (deltaYaw < 0 ? 'E' : 'W') + best
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

// 官方骨盆参考高（移动态）：runN 固定 mesh.y=-0.2 实测骨盆世界高 0.85~0.94m
// 取中；支撑踝官方锚 0.125m + 载荷腿跨，全部官方走跑横移同高（骨盆轨道 ±7mm）
export const PELVIS_REF_Y = 0.90
// 蹲族（蹲走/蹲踞移动）骨盆参考降幅：官方蹲姿 = 踝锚 0.125 + 深屈膝支撑跨
// ~0.48 + 髋偏移 0.115 ≈ 0.72（clip 自身骨盆轨道 ≈ 站高、蹲姿在腿/脊柱旋转
// 里——不降参考 = 浮空深蹲，实测脚悬 0.3~0.6m）
export const PELVIS_CROUCH_DROP = 0.18
// 站定脚踝离地余量：kamae 双脚落clip自含（实测落地世界高 0.09m）
export const FOOT_GROUND_Y = 0.09

// 身体高度解算（纯函数，Bot.step 官方曲线路径与单测共用）：
//  - 移动态参考 = 骨盆参考高（蹲族按 crouchW 降 PELVIS_CROUCH_DROP）− 骨盆局
//    部高——官方起伏由 clip 自己的骨盆/Splitter 位置轨道携带（±7mm + 相位起
//    伏），身体高度本身准静态
//  - 站定参考 = 贴地余量 − 最低脚局部高（kamae 站姿脚高稳定无伪影；蹲踞待机
//    的脚高含在 clip 里，sink 表现为下蹲）
//  - 两参考按移动权重（调用侧已 smoothW）线性混合
// ⚠ 绝不让身体追逐逐帧最低脚高：官方导出剥离根位移后 clip 内脚高含跑步机伪影
//   （runN 实测全周期 0.45~0.96m 摆动），追逐它 = 每步 ±20cm 弹跳 + 长期沉入
//   地下 0.5m（2026-09-11 抽搐回归根因，勿回退）
export function locoBodyY({ hipsLocalY, loMinY, moveW, crouchW = 0 }) {
  const stand = FOOT_GROUND_Y - loMinY
  const move = PELVIS_REF_Y - PELVIS_CROUCH_DROP * Math.min(1, Math.max(0, crouchW)) - hipsLocalY
  return stand + (move - stand) * Math.min(1, Math.max(0, moveW))
}

// 官方 IK 锚曲线的支撑/摆动落地窗（锚 z = 踝离地高，psa 实测）：支撑
// 0.123~0.155、摆动 0.31+——脚步声/落地事件如需判定窗，用 0.21/0.26 分离带。
// （旧「支撑窗钉地状态机」已在 2026-09-11 抽搐修复中移除：官方锚曲线全程
// 驱动脚部，不存在释放回 clip 姿态的动作——释放窗内慢放=拖拽、快放=瞬移，
// 双向都是跳变）
