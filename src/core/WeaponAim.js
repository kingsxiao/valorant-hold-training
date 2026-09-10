// Bot 挂枪的运行时数学（纯函数，Bot.step 与单测共用）：
//  无畏契约敌人持枪形态——kamae 双手架枪位挂官方枪（Vandal/Phantom 池），
//  枪口始终追瞄准目标（pull 对枪/站定瞄玩家眼、cross 顺跑向携枪）；击杀后
//  掉枪抛落（弹道 + 翻滚 + 落地摆平），开火时枪身后顶 + 脊柱微仰
import * as THREE from 'three'

const _dir = new THREE.Vector3()
const _m4 = new THREE.Matrix4()
const _zero = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _q = new THREE.Quaternion()
const _gmQ = new THREE.Quaternion()
const _gmV = new THREE.Vector3()

// 瞄准四元数：局部 -Z（枪口向）指向 from→to、+Y 尽量朝上。
// 近垂直俯仰时把方向压回 ±72°（Matrix4.lookAt 在方向平行 up 时退化）
export function solveGunAim(from, to, out = new THREE.Quaternion()) {
  _dir.copy(to).sub(from)
  const len = _dir.length()
  if (len < 1e-6) return out.identity()
  _dir.divideScalar(len)
  if (Math.abs(_dir.y) > 0.95) {
    _dir.multiplyScalar(0.95 / Math.abs(_dir.y)) // 等比压缩 y 分量后归一
    _dir.normalize()
  }
  _m4.lookAt(_zero, _dir, _up) // Z 轴 = -dir → 局部 -Z = dir（枪口向）
  return out.setFromRotationMatrix(_m4)
}

// 瞄准目标选择：站定/急停/pull 横移对枪 → 枪口追玩家（本体 strafe 对枪正是
// 腿横移、枪贴着你）；cross 跑过 → 顺身体前方携枪跑（不追人不扭枪）
export function pickAimTarget({ style, stopped, moving }) {
  if (!moving || stopped || style === 'pull') return 'player'
  return 'forward'
}

// 步伐随动幅度（纯函数，Bot._stepGun 与单测共用）：跑动中武器随步频的
// dip/sway/roll——本体跑动枪不是焊死在胸口：落脚（phase=kπ）后武器惯性下沉、
// 左右脚交替横向微摆、枪轴微倾。phase=步态相位（每步 π，与腿 clip 播放头同源）；
// speed 归一到跑速 5.4 线性缩放幅值，≤0.4（站定/急停末段）全零——站定对枪
// 枪口纪律不受扰。dip 负=下沉，谷在落脚后 ~0.28rad（落脚→体重压实→武器下沉
// 的时序）；sway/roll 慢半拍随重心横移
export function gunBobPose({ phase, speed = 0 }) {
  const k = speed <= 0.4 ? 0 : Math.min(1, speed / 5.4)
  return {
    dip: -Math.cos(2 * phase - 0.55) * 0.008 * k, // ±8mm（周期 π = 每步一次）
    sway: Math.sin(phase) * 0.005 * k,            // ±5mm（周期 2π = 左右脚交替）
    roll: Math.sin(phase + 0.9) * 0.007 * k,      // ±0.4°（枪轴微倾与 sway 同源）
  }
}

// 掉枪一步弹道（纯）：重力 + 绕轴翻滚（轴心偏置到枪口端 = 枪托绕前段甩，非
// 绕几何中心匀速自旋）；落地按着速反弹 ≤2 次（v.y 反射 ×0.3、spin 减半、水平
// 摩擦 ×0.6），慢落/弹完即停（landed=true 后冻结）。state：{ p, v, q, axis,
// spin, restY, landed, bounces?, pivotLocal? }（Vector3/Quaternion 不可原地改；
// pivotLocal 缺省 = 老语义绕位置原点自旋）
export function stepDroppedGun(state, dt, g = 9.8) {
  if (state.landed) return state
  const v = state.v.clone()
  v.y -= g * dt
  const p = state.p.clone().addScaledVector(v, dt)
  const dq = _q.setFromAxisAngle(state.axis, state.spin * dt)
  const q = state.q.clone().premultiply(dq)
  let p2 = p
  if (state.pivotLocal) {
    // 枪绕前段转：轴过枪口端一点（步初位姿算轴点），位置绕轴随 Δq 公转——
    // 刚体绕偏心轴的自由飞行近似（轴点随弹道平移，偏置 0.2m 级视觉无差）
    const pivot = _ikTmp.copy(state.pivotLocal).applyQuaternion(state.q).add(state.p)
    p2 = p.clone().sub(pivot).applyQuaternion(dq).add(pivot)
  }
  let { spin, bounces = 0 } = state
  let landed = false
  if (p2.y <= state.restY) {
    p2.y = state.restY
    if (bounces < 2 && v.y < -0.8) { // 着速够才有弹（<0.8m/s 直接趴住）
      v.y *= -0.3
      v.x *= 0.6; v.z *= 0.6
      spin *= 0.5
      bounces += 1
    } else {
      landed = true
    }
  }
  return { ...state, p: p2, v, q, spin, bounces, landed }
}

// 落地摆平：保当前枪管朝向的水平 yaw、俯仰/横滚归零（枪平躺在地）
export function settleFlatQ(q, out = new THREE.Quaternion()) {
  _dir.set(0, 0, -1).applyQuaternion(q)
  _dir.y = 0
  if (_dir.lengthSq() < 1e-6) return out.identity()
  return out.setFromAxisAngle(_up, Math.atan2(-_dir.x, -_dir.z))
}

// 开火后坐的姿态量（k: 1→0 衰减）：spine 脊柱微仰、gunZ 枪身向射手后顶
export function kickPose(k) {
  return { spine: 0.085 * k, gunZ: 0.05 * k }
}

// ---- 枪体双手握点几何推导（AK 族步枪按顶点分布自动定位，不逐枪调常量）----
// 必须在模板挂入场景图前调用（独立根的 matrixWorld 即摆放系：枪口 -Z、居中、
// 0.85m 归一）。扫描顶点——
//   枪管轴线高 yBarrel = 前端 20% 切片（枪管/消音管段）顶点 y 中位数；
//   后握把：z 落在 [55%, 85%] 枪长带内、低于枪管线 0.1L 的顶点按 0.03L 分箱，
//   连续箱成簇，取「质量 ≥ max(6, 0.4% 采样) 且簇均深最深」的一簇（AK 布局
//   弹匣-握把-枪托自前向后：该带内枪托被 z 带排除、弹匣被簇心排除，剩下即握把）；
//   前握点：z ∈ [15%, 42%] 枪长、|y−yBarrel| < 0.05 的顶点质心（护木/消音管
//   下侧托握位）。
// 返回 {grip, fore}（根局部 Vector3，调用方持有）；无网格几何返回 null
export function deriveGunHoldPoints(root) {
  root.updateMatrixWorld(true)
  const pts = []
  root.traverse(o => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return
    o.updateWorldMatrix(true, false)
    const p = o.geometry.attributes.position
    const v = new THREE.Vector3()
    const stride = p.count > 12000 ? 3 : 1
    for (let i = 0; i < p.count; i += stride) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld)
      pts.push(v.x, v.y, v.z)
    }
  })
  const N = pts.length / 3
  if (!N) return null
  let zMin = Infinity, zMax = -Infinity
  for (let i = 2; i < pts.length; i += 3) {
    if (pts[i] < zMin) zMin = pts[i]
    if (pts[i] > zMax) zMax = pts[i]
  }
  const L = zMax - zMin
  if (L < 1e-3) return null
  const frontY = []
  for (let i = 1; i < pts.length; i += 3) if (pts[i + 1] < zMin + L * 0.2) frontY.push(pts[i])
  frontY.sort((a, b) => a - b)
  const yBarrel = frontY.length ? frontY[frontY.length >> 1] : 0
  // 后握把：低于枪管线的顶点按 z 分箱（含 y 均值累积），再聚簇。切深 0.1L：
  // 浅切时扳机护圈会把弹匣-握把在切割线下连成一簇（簇心被拽进弹匣区、被 z 带
  // 误排除）；深切断开护圈，弹匣/握把/枪托各自成簇
  const cut = yBarrel - L * 0.1
  const binW = L * 0.03
  const bins = new Map()
  for (let i = 0; i < N; i++) {
    const y = pts[i * 3 + 1], z = pts[i * 3 + 2]
    if (y >= cut) continue
    const k = Math.floor((z - zMin) / binW)
    const b = bins.get(k) ?? { n: 0, ySum: 0, zSum: 0 }
    b.n++; b.ySum += y; b.zSum += z
    bins.set(k, b)
  }
  const massMin = Math.max(6, N * 0.004)
  const ks = [...bins.keys()].sort((a, b) => a - b)
  const clusters = []
  let cur = null
  for (const k of ks) {
    if (cur && k === cur.k1 + 1) { cur.k1 = k; cur.n += bins.get(k).n; cur.ySum += bins.get(k).ySum; cur.zSum += bins.get(k).zSum }
    else { if (cur) clusters.push(cur); cur = { k0: k, k1: k, n: bins.get(k).n, ySum: bins.get(k).ySum, zSum: bins.get(k).zSum } }
  }
  if (cur) clusters.push(cur)
  let grip = null
  for (const c of clusters) {
    if (c.n < massMin) continue
    const zc = c.zSum / c.n
    if (zc < zMin + L * 0.55 || zc > zMin + L * 0.85) continue // 带 z 心：排弹匣(前)与枪托(后)
    if (!grip || c.ySum / c.n < grip.ySum / grip.n) grip = c // 均深深者优先
  }
  const gripV = grip
    ? new THREE.Vector3(0, grip.ySum / grip.n, grip.zSum / grip.n)
    : new THREE.Vector3(0, yBarrel, zMin + L * 0.72)
  // 前握点：护木段环绕顶点质心
  let fn = 0, fy = 0, fz = 0
  for (let i = 0; i < N; i++) {
    const y = pts[i * 3 + 1], z = pts[i * 3 + 2]
    if (z < zMin + L * 0.15 || z > zMin + L * 0.42) continue
    if (Math.abs(y - yBarrel) >= L * 0.06) continue
    fn++; fy += y; fz += z
  }
  const foreV = fn
    ? new THREE.Vector3(0, fy / fn, fz / fn)
    : new THREE.Vector3(0, yBarrel, zMin + L * 0.3)
  return { grip: gripV, fore: foreV }
}

// 握把钉位：holder 朝向已定（=瞄准），解 holder 位置使枪上握点 gripLocal
// （holder 系）精确落在世界位 worldGrip（后手 WeaponPoint）。恒等式：
// meshPos + R_meshQ·(holderPos + R_hwQ·gripLocal) = worldGrip
export function solveGripMount(worldGrip, meshPos, meshQ, holderWorldQ, gripLocal, out = new THREE.Vector3()) {
  _gmQ.copy(meshQ).invert()
  out.copy(worldGrip).sub(meshPos).applyQuaternion(_gmQ)
  _gmV.copy(gripLocal).applyQuaternion(holderWorldQ)
  return out.sub(_gmV)
}

// ---- 左手两骨 IK（分析解）：把前手钉在护木握点上 ----
// 输入肩/肘/腕/目标的世界位置；输出世界系的几何解（不碰骨骼，共轭到骨局部
// 由调用侧做）。极向量取「当前上臂方向」——解留在当前姿态附近：目标=当前
// 手位时 dirAb≈abDirCur（旋转增量≈0，天然无跳变）；瞄准把枪拉远时手臂沿
// 最小旋转路径伸展。返回共享对象（模块级暂存，勿持有），数据不齐返回 null
const _ikAt = new THREE.Vector3()
const _ikPole = new THREE.Vector3()
const _ikE = new THREE.Vector3()
const _ikTmp = new THREE.Vector3()
const _ikRes = { abDirCur: new THREE.Vector3(), dirAb: new THREE.Vector3(), dirCb: new THREE.Vector3(), lab: 0, lcb: 0, clamped: false }

export function solveTwoBoneIK({ shoulder, elbow, hand, target, eps = 1e-4 }) {
  const lab = elbow.distanceTo(shoulder)
  const lcb = hand.distanceTo(elbow)
  if (lab < eps || lcb < eps) return null
  _ikAt.copy(target).sub(shoulder)
  const dRaw = _ikAt.length()
  if (dRaw < eps) return null
  _ikAt.divideScalar(dRaw)
  const dMax = lab + lcb - eps
  const dMin = Math.abs(lab - lcb) + eps
  const clamped = dRaw > dMax || dRaw < dMin
  const d = THREE.MathUtils.clamp(dRaw, dMin, dMax)
  // 弯曲平面基向量 e：极向量（当前上臂方向）去掉沿目标方向分量后的垂直向
  _ikPole.copy(elbow).sub(shoulder).normalize()
  _ikE.copy(_ikPole).addScaledVector(_ikAt, -_ikPole.dot(_ikAt))
  if (_ikE.lengthSq() < 1e-8) { // 上臂与目标线共线：任取垂直向
    _ikE.set(0, 1, 0).addScaledVector(_ikAt, -_ikAt.y)
    if (_ikE.lengthSq() < 1e-8) _ikE.set(1, 0, 0).addScaledVector(_ikAt, -_ikAt.x)
  }
  _ikE.normalize()
  const alpha = Math.acos(THREE.MathUtils.clamp((lab * lab + d * d - lcb * lcb) / (2 * lab * d), -1, 1))
  _ikRes.abDirCur.copy(_ikPole)
  _ikRes.dirAb.copy(_ikAt).multiplyScalar(Math.cos(alpha)).addScaledVector(_ikE, Math.sin(alpha))
  _ikTmp.copy(shoulder).addScaledVector(_ikRes.dirAb, lab) // 肘解算位
  _ikRes.dirCb.copy(target).sub(_ikTmp).normalize()
  _ikRes.lab = lab
  _ikRes.lcb = lcb
  _ikRes.clamped = clamped
  return _ikRes
}
