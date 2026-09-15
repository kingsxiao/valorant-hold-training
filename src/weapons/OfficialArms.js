import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { GLOVE_POSES } from './HandsRig.js'

// ============================================================================
// 官方第一人称手臂（public/models/arms-official.glb）：Valporant 官方 Phoenix 1P
// 手臂（Rocklan 官方包 phoenixFirstPerson.blend 转换，贴图 DF/MRAE/NM 全官方），
// 骨架 104 骨（官方 1P 骨名：R/L_Shoulder→Elbow→Hand→五指三关节 + Camera 骨 +
// R/L_WeaponPoint/MasterWeapon/WeaponADS 官方挂点）。
// 姿势来源：官方 FP_Core_{AK,Carbine}_S0_IdlePose.psa（Vandal/Phantom 持枪
// 待机姿势）——Blender 内按 Befzz psa 导入配方摆好、烘成 GLB 动画轨道
// （vandal_idle / phantom_idle，各 312 通道，scripts/fp-arms-export.py）。
// 运行时装配：轨道首帧写骨局部量 → 官方持枪姿势 → 枪本地系两点拟合（官方
// 腕-腕轴 → 现役枪 GLOVE_POSES 腕锚轴 + 官方 Camera 骨 ↔ rest 取景的数据解
// 滚转 + 等价手定尺）把整副手臂贴到当前枪上，root 直接挂 vm 下与枪同做
// 刚体运动（后坐/摇摆/ADS 全程不脱手，且与 attach 时刻的 holder 瞬态无关）。
// 与 WeaponSystem 的接口：读 sys.vmScene / vmHolder / activeCustomVm()，
// 写 sys.officialArms / sys.handsAnim（置 null，官方姿势自带扳机指放置）。
// ============================================================================

// 三点相似变换拟合（非共线时精确解；右手旋转保证蒙皮法线不翻）：
// src 基（p1→p2 叉 p1→p3）→ dst 基。缩放只取 p1p2 边（腕-腕 = 握把到护木的
// 真实跨度，两侧语义严格对应）；p1p3 边（腕-相机）的屏幕距离两侧刻意调校
// 不同（我们的取景 FRAMING ≠ 官方相机距离），不能进缩放
// 导出供 tests/official-arms.test.js 回归（姿势数学曾两次翻车：MasterWeapon
// 锚污染缩放、质心定位摊残差到手）
export function fitSimilar3(p1, p2, p3, q1, q2, q3) {
  const u1raw = p2.clone().sub(p1)
  const u2raw = p3.clone().sub(p1)
  const v1raw = q2.clone().sub(q1)
  const v2raw = q3.clone().sub(q1)
  const u2 = new THREE.Vector3().crossVectors(u1raw, u2raw)
  const v2 = new THREE.Vector3().crossVectors(v1raw, v2raw)
  const u3 = new THREE.Vector3().crossVectors(u1raw, u2)
  const v3 = new THREE.Vector3().crossVectors(v1raw, v2)
  if (u1raw.lengthSq() < 1e-12 || u2.lengthSq() < 1e-12 || v1raw.lengthSq() < 1e-12 || v2.lengthSq() < 1e-12) return null
  const u1 = u1raw.clone().normalize(), u2n = u2.clone().normalize(), u3n = u3.clone().normalize()
  const v1 = v1raw.clone().normalize(), v2n = v2.clone().normalize(), v3n = v3.clone().normalize()
  // R·U = V（列基）→ R = V·U⁻¹；U/V 行列式同号（对应点同手性）时为纯旋转
  const U = new THREE.Matrix4().makeBasis(u1, u2n, u3n)
  const V = new THREE.Matrix4().makeBasis(v1, v2n, v3n)
  const R = V.multiply(U.invert())
  if (R.determinant() < 0) return null // 手性不匹配：对应关系错，宁可不装
  const scale = v1raw.length() / u1raw.length()
  return { scale, quat: new THREE.Quaternion().setFromRotationMatrix(R) }
}

// 官方手臂专用腕锚（GLOVE_POSES 系标定，2026-09-15；穿透感知网格扫描收敛——
// 手臂网格顶点对枪面 45mm 带内做 +X 光线奇偶判定（负=枪内）计数最小化 +
// 双手十指尖悬停距离次级目标。基态（沿用 GLOVE_POSES 锚）实测 495/325 顶点
// 嵌枪（掌根/鱼际），收敛后枪本地系 + 数据解滚转下残留 35/56 个，均在玩家
// 视角被枪体遮挡区（左前臂下侧/拇指远侧，截图评审 2-4px 边缘重叠）。
// 扫描方法与坑位见 DEPLOY.md 四轮附录）
export const ARMS_ANCHORS = {
  vandal: { handR: [0.24, -0.009, -0.109], handL: [-0.247, 0.0225, -0.0045] },
  phantom: { handR: [0.237, -0.0495, -0.097], handL: [-0.2065, -0.017, 0.0025] },
}

// 等价手尺寸（相机系米）：官方手的腕→中指尖骨链缩放到此值 = glove 路径的
// 手大小（8.2cm 标定，枪 0.85m×holder ~0.49 的取景下真手 19cm×同比例）。
// 腕锚为这个尺寸调校——官方手臂必须同尺寸落位，否则皮肉嵌枪
const OFFICIAL_HAND_EQUIV = 0.082

// 滚转修正：不手调——由官方 pose 的 Camera 骨方向 + 我们 rest 取景常数在枪
// 本地系对齐解出（见 attachOfficialArms 拟合段）。手调常数曾两轮换基即废
// （世界系→holder 系→枪本地系），数据解与基无关。globalThis.__ARMS_ROLL
// 仅作页内加性微调缝（vhtdbg 扫描用）

export function attachOfficialArms(sys, gltf, weaponId = sys.currentVmId) {
  const vm = sys.activeCustomVm(weaponId)
  if (!vm) return false
  let pose = GLOVE_POSES[weaponId]
  if (!pose) return false
  // 页内腕锚校准缝（vhtdbg 时读全局覆盖，扫描最优值后固化进 ARMS_ANCHORS）
  const anchors = (typeof globalThis !== 'undefined' && globalThis.__ARMS_ANCHORS?.[weaponId]) || ARMS_ANCHORS[weaponId]
  // 滚转加性微调缝（数据解之上；缺 Camera 骨时退化为主修正量）
  const rollTweak = (typeof globalThis !== 'undefined' && globalThis.__ARMS_ROLL?.[weaponId]) || 0
  if (anchors) {
    pose = { handR: { ...pose.handR, wrist: anchors.handR },
            handL: { ...pose.handL, wrist: anchors.handL } }
  }
  const clip = (gltf.animations ?? []).find(a => a.name === `${weaponId}_idle`)
  if (!clip) return false
  // 旧实例清理（cloneSkinned 与模板共享 geometry/材质，不可 dispose，仅摘除）
  if (sys.officialArms) sys.officialArms.removeFromParent() // 现挂 vm 下
  const root = cloneSkinned(gltf.scene)
  root.traverse(o => {
    if (o.isMesh) o.frustumCulled = false // 蒙皮包围盒不随骨骼更新
  })
  // 官方姿势：动画轨道首帧写节点局部量（2 帧 clip，两帧同值，取 0 即可）
  const byName = {}
  root.traverse(o => { if (o.name) byName[o.name] = o })
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.')
    const node = byName[track.name.slice(0, dot)]
    if (!node) continue
    const prop = track.name.slice(dot + 1)
    const v = track.values
    if (prop === 'quaternion') node.quaternion.set(v[0], v[1], v[2], v[3])
    else if (prop === 'position') node.position.set(v[0], v[1], v[2])
  }
  // 孤立态读官方骨世界位（挂枪前的绑定测量，同 poseGloveHands 的教训）
  root.quaternion.identity()
  root.position.set(0, 0, 0)
  root.scale.setScalar(1)
  sys.vmScene.add(root)
  sys.vmScene.updateMatrixWorld(true)
  const wp = (name) => {
    const n = byName[name]
    return n ? n.getWorldPosition(new THREE.Vector3()) : null
  }
  const srcR = wp('R_Hand'), srcL = wp('L_Hand')
  if (!srcR || !srcL) {
    sys.vmScene.remove(root)
    sys.officialArms = null
    console.warn('[VHT] 官方手臂缺关键骨（R_Hand/L_Hand）')
    return false
  }
  // ---- 拟合全程在枪本地系（vm-local），root 直接挂 vm 下 ----
  // 世界系拟合在 attach 时刻会吃到 holder 的切枪抬枪瞬态倾斜——绕轴滚转被
  // 倾斜共轭污染（phantom 实测 407 顶点嵌枪稳定复现；vandal 开局 instant
  // 无倾斜故侥幸正确）。两点拟合 + 数据解滚转：相机的实时位姿完全退出
  // （它天然是世界固定的，其枪本地位置随 holder 动画漂移——倾斜泄漏的源
  // 头），输入只有枪本地锚常数 + 官方骨骼 + rest 取景常数——零倾斜依赖：
  //   ① 官方腕-腕轴 → 锚轴（setFromUnitVectors，双腕精确落锚）
  //   ② 滚转 = 官方 Camera 骨方向 ↔ rest 取景相机方向的数据解夹角
  //   ③ 缩放 = 等价手定尺（8.2cm 世界表观 / 枪链世界系数）
  const dstR_g = new THREE.Vector3(...pose.handR.wrist)
  const dstL_g = new THREE.Vector3(...pose.handL.wrist)
  const chainNames = ['R_Hand', 'R_Middle0', 'R_Middle1', 'R_Middle2', 'R_Middle3']
  let handLen = 0
  for (let i = 1; i < chainNames.length; i++) {
    const a = wp(chainNames[i - 1]), b = wp(chainNames[i])
    if (!a || !b) { handLen = 0; break }
    handLen += a.distanceTo(b)
  }
  if (handLen < 0.05) handLen = 0.19 // 骨链缺失兜底（解剖学近似值）
  const sEq = OFFICIAL_HAND_EQUIV / handLen
  // 枪链世界系数：vm-local 长度 → 世界表观（vm 缩放 × holder 缩放；equip
  // 期间 holder 缩放不变、vm 缩放是枪常数——两系数在 attach 时刻均稳定）
  const gunScale = vm.getWorldScale(new THREE.Vector3()).x
  const sLocal = sEq / gunScale
  // ①+② 轴对齐 + 数据解滚转。跨度方向：src 取官方骨骼系（root 本地 = vmScene 单位
  // 态读数，root 的 TRS 作用于该系），dst 取枪本地锚——root 挂 vm 下，其旋转
  // 恰是「官方系 → 枪本地系」的映射。srcR/srcL 本体也必须是官方系（勿用
  // vmInv 变换过的——曾把 5.7u 的枪本地向量塞进 root 局部公式，双腕偏 0.9m）
  const spanSrc = srcL.clone().sub(srcR).normalize()
  const spanDst = dstL_g.clone().sub(dstR_g).normalize()
  if (spanSrc.lengthSq() < 1e-12 || spanDst.lengthSq() < 1e-12) {
    sys.vmScene.remove(root)
    sys.officialArms = null
    console.warn('[VHT] 官方手臂拟合失败（腕轴退化）')
    return false
  }
  const q = new THREE.Quaternion().setFromUnitVectors(spanSrc, spanDst)
  // ② 滚转（数据解）：官方 pose 自带「臂面相对官方相机」（Camera 骨世界位），
  // 我们 rest 取景（vmBase + vmBaseYaw/Roll + baseVmScale + vm 本地阵——动画
  // 未启动的基态常数）定义「枪相对相机」（vmCamera 固定原点无旋转）。官方
  // 「span 中点→相机」方向经 q 映到枪本地，与「rest 相机→锚中点」方向在
  // span 平面上的有向夹角 = 两侧取景的系统差 → 滚转角。全程静态常数，相机
  // 的实时位姿不参与（倾斜泄漏的源头），结果与 attach 时刻的 holder 瞬态无关
  let rollData = 0
  const camOff = wp('Camera')
  if (camOff) {
    const midOff = srcR.clone().add(srcL).multiplyScalar(0.5)
    const d1_g = camOff.clone().sub(midOff).normalize().applyQuaternion(q)
    vm.updateMatrix()
    const restInv = new THREE.Matrix4().compose(
      sys.vmBase,
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, sys.constructor.vmBaseYaw, sys.constructor.vmBaseRoll)),
      new THREE.Vector3().setScalar(sys.baseVmScale),
    ).multiply(vm.matrix).invert()
    const camG = new THREE.Vector3().applyMatrix4(restInv) // 相机原点的枪本地常数位
    const midG = dstR_g.clone().add(dstL_g).multiplyScalar(0.5)
    const d2 = camG.sub(midG).normalize()
    const a = d1_g.clone().projectOnPlane(spanDst)
    const b = d2.clone().projectOnPlane(spanDst)
    if (a.lengthSq() > 1e-8 && b.lengthSq() > 1e-8) {
      rollData = Math.atan2(new THREE.Vector3().crossVectors(a, b).dot(spanDst), a.dot(b))
    }
  }
  const roll = rollData + rollTweak
  if (roll) q.premultiply(new THREE.Quaternion().setFromAxisAngle(spanDst, roll))
  // ③ 右腕精确锚定（轴对齐保证左腕同时落在官方比例位置）
  root.quaternion.copy(q)
  root.scale.setScalar(sLocal)
  root.position.copy(dstR_g.clone().sub(srcR.clone().applyQuaternion(q).multiplyScalar(sLocal)))
  sys.vmScene.updateMatrixWorld(true)
  if (localStorage.getItem('vhtdbg')) {
    console.log('[dbg] official arms fit(gun-local):', {
      srcR: srcR.toArray(), srcL: srcL.toArray(),
      dstR_g: dstR_g.toArray(), dstL_g: dstL_g.toArray(),
      sLocal, handLen, gunScale, roll: { data: rollData, tweak: rollTweak, rad: roll, deg: +(roll * 180 / Math.PI).toFixed(1) },
    })
  }
  // 挂枪（vm 本地）：枪的一切刚体运动（后坐/摇摆/ADS 缩放/切枪取景）手臂同行
  sys.vmScene.remove(root)
  vm.add(root)
  vm.updateMatrixWorld(true)
  if (localStorage.getItem('vhtdbg')) {
    const dstR_w = vm.localToWorld(dstR_g.clone())
    console.log('[dbg] post-attach err:',
      +byName.R_Hand.getWorldPosition(new THREE.Vector3()).distanceTo(dstR_w).toFixed(6))
  }
  sys.officialArms = root
  sys.handsAnim = null // 官方姿势自带握持/扳机指放置，glove 逐指动画停用
  // ---- 动画层装配：idle 基准 + equip 切枪轨道 + fire 加法增量
  //（见 animateOfficialArms 每帧管线）
  sys._armsAnim = buildArmsAnim(root, gltf.animations, weaponId)
  return true
}

// 读 clip 的四元数轨道 → { 骨名: track }
function readQuatTracks(animations, name) {
  const clip = (animations ?? []).find(a => a.name === name)
  if (!clip) return null
  const map = {}
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.')
    if (tr.name.slice(dot + 1) !== 'quaternion') continue
    map[tr.name.slice(0, dot)] = tr
  }
  return { map, duration: clip.duration || 0.3 }
}

// 按时间采样轨道（times 可被 optimize resample 抽稀——逐骨自带时间轴，
// 线性找段 + slerp；单键直接取）
const _sampleQ = new THREE.Quaternion()
function sampleQuatTrack(track, t) {
  const { times, frames } = track
  if (times.length === 1) return frames[0]
  let i = times.length - 2
  for (let k = 0; k < times.length - 1; k++) { if (t <= times[k + 1]) { i = k; break } }
  const span = times[i + 1] - times[i]
  const kk = span > 1e-9 ? THREE.MathUtils.clamp((t - times[i]) / span, 0, 1) : 0
  return _sampleQ.slerpQuaternions(frames[i], frames[i + 1], kk)
}

// 逐骨动画状态：idle（基础握姿）/ ads（合成 Aim2N 绝对姿势，phantom 专有）/
// equip（官方切枪动画绝对轨道，末帧=idle 分毫不差）/ fireD（官方 fire 加法
// 增量 D(t)=F(0)⁻¹⊗F(t)——fire 是「ref+踢动」格式，增量必须以自身帧 0 为
// 参考（makeClipAdditive 口径），以 idle 为参考会引入 idle↔ref 常量偏差）
function buildArmsAnim(root, animations, weaponId) {
  const idle = readQuatTracks(animations, `${weaponId}_idle`)
  const ads = readQuatTracks(animations, 'phantom_ads')
  const equip = readQuatTracks(animations, `${weaponId}_equip`)
  const fire = readQuatTracks(animations, `${weaponId}_fire`)
  if (!idle) return null
  const byName = {}
  root.traverse(o => { if (o.name) byName[o.name] = o })
  const _q = (arr, i) => new THREE.Quaternion(arr[i * 4], arr[i * 4 + 1], arr[i * 4 + 2], arr[i * 4 + 3])
  const buildTrack = (tr, ref0) => {
    const n = tr.values.length / 4
    const frames = []
    for (let i = 0; i < n; i++) {
      const d = ref0 ? ref0.clone().multiply(_q(tr.values, i)) : _q(tr.values, i).clone()
      if (i > 0 && d.dot(frames[i - 1]) < 0) d.set(-d.x, -d.y, -d.z, -d.w)
      else if (i === 0 && d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w)
      frames.push(d.normalize())
    }
    return { times: tr.times, frames }
  }
  const bones = []
  for (const [name, idleTr] of Object.entries(idle.map)) {
    const node = byName[name]
    if (!node) continue
    const rec = { node, idle: _q(idleTr.values, 0).clone(), ads: null, equip: null, fireD: null }
    const adsTr = ads?.map[name]
    if (adsTr) rec.ads = _q(adsTr.values, 0).clone()
    const eqTr = equip?.map[name]
    if (eqTr) rec.equip = buildTrack(eqTr)
    const fireTr = fire?.map[name]
    if (fireTr) rec.fireD = buildTrack(fireTr, _q(fireTr.values, 0).invert())
    bones.push(rec)
  }
  if (!bones.length) return null
  return {
    bones,
    hasAds: !!(ads && weaponId === 'phantom'),
    equipDur: equip?.duration ?? 0,
    fire: fire ? { t: Infinity, dur: fire.duration } : null,
  }
}

// 每帧姿势管线（WeaponSystem._animateHands 调用，equipU 由其按切枪时间轴算好
// 写入 sys._armsEquipU：1=不播 equip；0..1 = 官方切枪动画进度）：
//   base = equip(u)（切枪中，绝对姿势）否则 slerp(idle→ads, adsBlend)
//   final = base ⊗ fireD(t)（fire 加法增量，互斥：equip 期间无法开火）
export function animateOfficialArms(sys, dt) {
  const A = sys._armsAnim
  if (!A || !sys.officialArms) return
  if (A.fire) {
    if (A.fire.t !== Infinity) {
      A.fire.t += dt
      if (A.fire.t >= A.fire.dur) A.fire.t = Infinity
    }
  }
  const eqU = sys._armsEquipU ?? 1
  const adsK = A.hasAds ? sys.adsBlend : 0
  const fT = A.fire && A.fire.t !== Infinity ? A.fire.t : -1
  const tmp = new THREE.Quaternion()
  for (const b of A.bones) {
    let q
    if (eqU < 1 && b.equip) q = sampleQuatTrack(b.equip, eqU * A.equipDur)
    else if (adsK > 0 && b.ads) q = tmp.slerpQuaternions(b.idle, b.ads, adsK)
    else q = b.idle
    if (fT >= 0 && b.fireD) q = q.clone().multiply(sampleQuatTrack(b.fireD, fT))
    b.node.quaternion.copy(q)
  }
}
