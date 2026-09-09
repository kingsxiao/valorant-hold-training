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

// 掉枪一步弹道（纯）：重力 + 绕随机水平轴翻滚；落到 restY 钳平并标 landed。
// state：{ p, v, q, axis, spin, restY, landed }（Vector3/Quaternion 不可原地改）
export function stepDroppedGun(state, dt, g = 9.8) {
  if (state.landed) return state
  const v = state.v.clone()
  v.y -= g * dt
  const p = state.p.clone().addScaledVector(v, dt)
  const q = state.q.clone().premultiply(_q.setFromAxisAngle(state.axis, state.spin * dt))
  const landed = p.y <= state.restY
  if (landed) p.y = state.restY
  return { ...state, p, v, q, landed }
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
