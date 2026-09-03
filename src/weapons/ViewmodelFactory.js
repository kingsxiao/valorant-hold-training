import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Tex } from '../world/Textures.js'

// ============================================================================
// 第一人称持枪模型工厂：程序化建模 5 把枪 + 刀 + 配套静态持枪手臂。
// 只管"造几何"——挂载位置/后坐摆动/机件动画均在 WeaponSystem（状态耦合）。
// 全部 -Z 朝前；每把枪在 userData 记录枪口/抛壳口/持枪偏移/缩放供武器系统读取。
// ============================================================================

function vmHelpers(M) {
  return {
    M,
    box: (g, mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz)
      g.add(m)
      return m
    },
    cyl: (g, mat, r, len, x, y, z, seg = 14) => { // 沿 Z 轴（枪管方向）
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat)
      m.rotation.x = Math.PI / 2
      m.position.set(x, y, z)
      g.add(m)
      return m
    },
  }
}

// 记录每把枪的枪口/抛壳口位置/持枪偏移/缩放（userData）
function orientVm(g, { muzzle, eject = null, pos = new THREE.Vector3(0.15, -0.12, -0.27), scale = 1 }) {
  g.userData.muzzle = muzzle
  g.userData.eject = eject
  g.userData.pos = pos
  g.userData.scale = scale
  g.position.copy(pos)
  g.scale.setScalar(scale)
}

// ---- 各武器建模（原创程序化几何）----

// AK 型自动步枪（Vandal 定位）：机匣/防尘盖/导气管/木质护木/四段弧形弹匣/斜托/光纤准星
function buildRifleAK(M) {
  const g = new THREE.Group()
  const { box, cyl } = vmHelpers(M)
  box(g, M.steel, 0.05, 0.065, 0.26, 0, 0, -0.04)                 // 机匣
  box(g, M.steel, 0.046, 0.018, 0.14, 0, 0.043, 0.01)             // 防尘盖
  box(g, M.dark, 0.028, 0.02, 0.045, 0, 0.058, -0.09)             // 表尺座
  box(g, M.dot, 0.006, 0.006, 0.006, 0, 0.072, -0.09)             // 表尺发光点
  cyl(g, M.dark, 0.011, 0.13, 0, 0.048, -0.3)                     // 导气管
  box(g, M.dark, 0.026, 0.03, 0.035, 0, 0.042, -0.38)             // 导气箍
  cyl(g, M.steel, 0.009, 0.2, 0, 0.012, -0.5, 6)                  // 六角枪管
  box(g, M.dark, 0.02, 0.03, 0.03, 0, 0.03, -0.6)                 // 准星座
  box(g, M.gold, 0.006, 0.028, 0.006, 0, 0.062, -0.6)             // 准星
  box(g, M.dot, 0.005, 0.005, 0.005, 0, 0.078, -0.6)              // 光纤点
  cyl(g, M.dark, 0.014, 0.055, 0, 0.012, -0.645)                  // 消焰器
  box(g, M.wood, 0.046, 0.042, 0.15, 0, -0.002, -0.31)            // 上护木
  box(g, M.wood, 0.04, 0.018, 0.15, 0, -0.032, -0.31)             // 下护木
  // 弹匣（独立组 + 克隆材质：换弹时下落/回插/淡出，不影响其它深色件）
  const mag = new THREE.Group()
  const magMat = M.dark.clone()
  magMat.transparent = true
  const magSeg = (y, z, rx) => box(mag, magMat, 0.034, 0.052, 0.05, 0, y, z, rx) // 四段弧形弹匣
  magSeg(-0.058, -0.025, 0.08)
  magSeg(-0.104, -0.008, 0.24)
  magSeg(-0.146, 0.018, 0.42)
  magSeg(-0.182, 0.052, 0.6)
  g.add(mag)
  g.userData.mag = mag
  g.userData.magMats = [magMat]
  box(g, M.dark, 0.028, 0.005, 0.06, 0, -0.035, 0.03)             // 扳机护圈
  box(g, M.dark, 0.006, 0.018, 0.008, 0, -0.028, 0.018)           // 扳机
  box(g, M.wood, 0.034, 0.085, 0.045, 0, -0.06, 0.085, 0.3)       // 握把
  box(g, M.wood, 0.038, 0.05, 0.2, 0, -0.002, 0.26, -0.06)        // 枪托
  box(g, M.dark, 0.04, 0.06, 0.02, 0, -0.012, 0.36)               // 托底板
  // 枪机组件（击发后坐回位）：拉机柄 + 右侧导轨盖，沿 +z 后坐
  const bolt = new THREE.Group()
  cyl(bolt, M.dark, 0.006, 0.03, 0.034, 0.01, -0.06, 8)           // 拉机柄
  box(bolt, M.dark, 0.009, 0.018, 0.1, 0.0285, 0.012, -0.05)      // 枪机导轨盖
  g.add(bolt)
  bolt.userData.travel = 0.03
  g.userData.bolt = bolt
  box(g, M.dark, 0.007, 0.026, 0.055, 0.0265, 0.012, -0.03)       // 抛壳口（右侧面暗槽）
  box(g, M.dark, 0.005, 0.02, 0.012, 0.0255, 0.012, -0.062)       // 抛壳口后导向
  for (const pz of [0.028, 0.072]) {                              // 机匣固定销 ×2
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.054, 8), M.dark)
    pin.rotation.z = Math.PI / 2
    pin.position.set(0, 0.008, pz)
    g.add(pin)
  }
  for (const rz of [-0.615, -0.655]) cyl(g, M.steel, 0.0155, 0.008, 0, 0.012, rz, 10) // 消焰器散热环
  orientVm(g, { muzzle: new THREE.Vector3(0, 0.012, -0.68), eject: new THREE.Vector3(0.035, 0.02, -0.03) })
  return g
}

// 消音步枪（Phantom 定位）：一体式消音管 + 平直弹匣 + 战术托
function buildRifleSuppressed(M) {
  const g = new THREE.Group()
  const { box, cyl } = vmHelpers(M)
  box(g, M.poly, 0.05, 0.06, 0.3, 0, 0, -0.05)                    // 机匣
  box(g, M.dark, 0.016, 0.01, 0.42, 0, 0.038, -0.12)              // 全长导轨
  for (let i = 0; i < 9; i++) box(g, M.dark, 0.018, 0.006, 0.013, 0, 0.047, -0.24 + i * 0.045) // 导轨齿
  cyl(g, M.dark, 0.023, 0.28, 0, 0.012, -0.48)                    // 消音外管
  cyl(g, M.silver, 0.024, 0.012, 0, 0.012, -0.625)                // 管口银环
  box(g, M.poly, 0.044, 0.05, 0.16, 0, -0.004, -0.26)             // 护木
  box(g, M.dark, 0.03, 0.024, 0.02, 0, 0.03, -0.2)                // 前准星
  box(g, M.dark, 0.032, 0.022, 0.025, 0, 0.056, 0.06)             // 后照门
  // 弹匣（独立组 + 克隆材质，换弹动画用）
  const mag = new THREE.Group()
  const magMat = M.poly.clone()
  magMat.transparent = true
  box(mag, magMat, 0.032, 0.11, 0.05, 0, -0.075, -0.02, 0.08)     // 直弹匣
  g.add(mag)
  g.userData.mag = mag
  g.userData.magMats = [magMat]
  // 枪机组件：后置拉机柄，击发后坐
  const bolt = new THREE.Group()
  box(bolt, M.dark, 0.022, 0.012, 0.032, -0.02, 0.046, 0.075)     // 拉机柄（左后上）
  g.add(bolt)
  bolt.userData.travel = 0.02
  g.userData.bolt = bolt
  box(g, M.poly, 0.034, 0.08, 0.045, 0, -0.055, 0.08, 0.25)       // 握把
  box(g, M.poly, 0.036, 0.055, 0.14, 0, -0.005, 0.19)             // 枪托
  box(g, M.poly, 0.04, 0.07, 0.03, 0, -0.012, 0.27)               // 托腮板
  box(g, M.dark, 0.024, 0.005, 0.055, 0, -0.032, 0.02)            // 护圈
  box(g, M.dark, 0.006, 0.022, 0.05, 0.0235, 0.01, -0.02)         // 抛壳口
  orientVm(g, { muzzle: new THREE.Vector3(0, 0.012, -0.64), eject: new THREE.Vector3(0.032, 0.015, -0.02) })
  return g
}

// 重左轮（Sheriff 定位）：转轮 + 六角枪管 + 木质握把
// 击发时转轮分度 60°、击锤前倒再待击（见 WeaponSystem._updateVmParts）
function buildRevolver(M) {
  const g = new THREE.Group()
  const { box, cyl } = vmHelpers(M)
  box(g, M.steel, 0.032, 0.05, 0.15, 0, 0.005, -0.02)             // 枪身框架
  // 转轮（pivot 旋转 = 分度；弹巢槽随之转动可见）
  const cylPivot = new THREE.Group()
  cylPivot.position.set(0, -0.002, -0.06)
  cyl(cylPivot, M.steel, 0.027, 0.05, 0, 0, 0)                    // 转轮体
  cyl(cylPivot, M.dark, 0.006, 0.052, 0, 0, 0, 6)                 // 中心栓
  for (let i = 0; i < 6; i++) {                                   // 六个弹巢暗槽
    const a = i * Math.PI / 3
    box(cylPivot, M.dark, 0.0085, 0.0085, 0.05, Math.cos(a) * 0.017, Math.sin(a) * 0.017, 0)
  }
  g.add(cylPivot)
  g.userData.cylPivot = cylPivot
  cyl(g, M.steel, 0.013, 0.17, 0, 0.014, -0.16, 6)                // 六角枪管
  box(g, M.dark, 0.012, 0.014, 0.16, 0, 0.033, -0.15)             // 准星肋
  box(g, M.gold, 0.005, 0.018, 0.008, 0, 0.05, -0.225)            // 前准星
  // 击锤（几何上移使 pivot 在根部，rotation.x 前倒/待击）
  const hammerGeo = new THREE.BoxGeometry(0.01, 0.03, 0.024)
  hammerGeo.translate(0, 0.015, 0)
  const hammer = new THREE.Mesh(hammerGeo, M.dark)
  hammer.position.set(0, 0.026, 0.056)
  g.add(hammer)
  g.userData.hammer = hammer
  box(g, M.wood, 0.03, 0.08, 0.042, 0, -0.05, 0.055, 0.38)        // 木质握把
  box(g, M.dark, 0.024, 0.005, 0.05, 0, -0.028, 0.0)              // 护圈
  box(g, M.dark, 0.006, 0.016, 0.008, 0, -0.02, -0.005)           // 扳机
  cyl(g, M.dark, 0.006, 0.13, 0, -0.008, -0.15, 8)                // 排壳杆外壳
  orientVm(g, {
    muzzle: new THREE.Vector3(0, 0.014, -0.25),
    pos: new THREE.Vector3(0.13, -0.125, -0.24),
    scale: 0.92,
    eject: new THREE.Vector3(0.024, 0.01, -0.05),
  })
  return g
}

// 手枪（Classic / Ghost）：套筒 + 握把，（Ghost）加消音管
// 套筒（含准星/防滑纹）为独立组：击发后坐回位；弹匣底板换弹时下落/回插
function buildPistol(M, suppressed) {
  const g = new THREE.Group()
  const { box, cyl } = vmHelpers(M)
  const slide = suppressed ? M.steel : M.silver
  const bolt = new THREE.Group()
  box(bolt, slide, 0.028, 0.038, 0.17, 0, 0.02, -0.06)             // 套筒
  box(bolt, M.dark, 0.006, 0.008, 0.01, 0, 0.045, -0.135)         // 前准星
  box(bolt, M.dark, 0.022, 0.008, 0.012, 0, 0.046, 0.015)         // 后照门
  for (let i = 0; i < 3; i++) box(bolt, M.dark, 0.03, 0.026, 0.0035, 0, 0.02, 0.0 + i * 0.009) // 套筒后部防滑纹
  if (suppressed) box(bolt, M.dark, 0.007, 0.012, 0.03, 0.0145, 0.024, -0.03) // 抛壳窗
  g.add(bolt)
  bolt.userData.travel = 0.017
  g.userData.bolt = bolt
  box(g, M.poly, 0.026, 0.03, 0.15, 0, -0.008, -0.04)             // 下机匣
  box(g, M.poly, 0.03, 0.082, 0.044, 0, -0.05, 0.04, 0.28)        // 握把
  const mag = new THREE.Group()
  const magMat = M.dark.clone()
  magMat.transparent = true
  box(mag, magMat, 0.027, 0.016, 0.038, 0, -0.094, 0.052, 0.28)   // 弹匣底板（握把底微露）
  g.add(mag)
  g.userData.mag = mag
  g.userData.magMats = [magMat]
  box(g, M.dark, 0.022, 0.005, 0.05, 0, -0.026, -0.015)           // 护圈
  box(g, M.dark, 0.005, 0.014, 0.007, 0, -0.018, -0.02)           // 扳机
  if (suppressed) {
    cyl(g, M.dark, 0.015, 0.1, 0, 0.02, -0.2)                     // 消音管
    orientVm(g, { muzzle: new THREE.Vector3(0, 0.02, -0.26), pos: new THREE.Vector3(0.13, -0.125, -0.24), scale: 0.95, eject: new THREE.Vector3(0.018, 0.024, -0.05) })
  } else {
    cyl(g, M.dark, 0.009, 0.02, 0, 0.02, -0.155)                  // 枪口
    orientVm(g, { muzzle: new THREE.Vector3(0, 0.02, -0.17), pos: new THREE.Vector3(0.13, -0.125, -0.24), scale: 0.95, eject: new THREE.Vector3(0.018, 0.024, -0.02) })
  }
  return g
}

function buildKnife(M) {
  const k = new THREE.Group()
  const metalMaps = Tex.metal()
  const polyMaps = Tex.polymer()
  const steel = new THREE.MeshStandardMaterial({ color: 0xdfe4ea, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, normalMap: metalMaps.normalMap, roughness: 0.26, metalness: 0.94 })
  const gripM = new THREE.MeshStandardMaterial({ color: 0x31353c, map: polyMaps.map, roughnessMap: polyMaps.roughnessMap, normalMap: polyMaps.normalMap, roughness: 0.85, metalness: 0.05 })
  const bladeGeo = new THREE.BoxGeometry(0.018, 0.045, 0.24)
  bladeGeo.translate(0, 0, -0.14)
  const blade = new THREE.Mesh(bladeGeo, steel)
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.07, 4), steel)
  tip.rotation.x = -Math.PI / 2; tip.rotation.y = Math.PI / 4
  tip.position.set(0, 0, -0.29)
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.014, 0.016), M.dark)
  guard.position.set(0, 0, -0.015)
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.04, 0.12), gripM)
  grip.position.set(0, 0, 0.055)
  k.add(blade, tip, guard, grip)
  orientVm(k, { muzzle: new THREE.Vector3(0, 0, -0.3), pos: new THREE.Vector3(0.15, -0.13, -0.22), scale: 0.95 })
  return k
}

// ---- 第一人称持枪手臂（静态姿势）：袖臂圆柱 + 解剖学手部，全部合并成 2 个网格 ----
// 坐标为各武器本地系（-Z 朝前），随武器继承持枪位置/缩放/后坐摆动，不做独立动画
// 手臂比例按 FPS 惯例明显缩短（约解剖学 60%）：只保留小臂+手，上臂残段
// 加粗压低 —— 肘部贴画面底边出画，避免"手臂过长穿帮"与近裁剪问题
// 手部结构：三球掌型（掌跟/掌中/指根脊）+ 三节分段手指（指节球+扣握弧+微扁指尖）
//           + 三段拇指 + 指节护甲板 + 护腕束带 —— 全部合并，零 draw call 增量
function buildArms(armMats, kind) {
  const sleeve = [], glove = []
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3()
  const ball = (bk, x, y, z, r, sx = 1, sy = 1, sz = 1, seg = 12) => {
    _m4.compose(_p.set(x, y, z), _q.identity(), _s.set(sx, sy, sz))
    bk.push(new THREE.SphereGeometry(r, seg, Math.round(seg * 0.75)).applyMatrix4(_m4))
  }
  const tube = (bk, ax, ay, az, bx, by, bz, r1, r2 = r1) => { // r1 近端 → r2 远端
    _d.set(bx - ax, by - ay, bz - az)
    const len = _d.length()
    const geo = new THREE.CylinderGeometry(r2, r1, len, 10)
    geo.translate(0, len / 2, 0)
    _q.setFromUnitVectors(UP, _d.normalize())
    _m4.compose(_p.set(ax, ay, az), _q, _s.set(1, 1, 1))
    bk.push(geo.applyMatrix4(_m4))
  }
  const boxAt = (bk, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => {
    _q.setFromEuler(new THREE.Euler(rx, ry, rz))
    _m4.compose(_p.set(x, y, z), _q, _s.set(1, 1, 1))
    bk.push(new THREE.BoxGeometry(w, h, d).applyMatrix4(_m4))
  }
  // 三节扣握手指：沿 S→E 三段递进弓起（bow>0 向下扣、<0 向上翻）。
  // 关键：管段末端明显收细 + 指节球放大 → 关节处有肉眼可见的鼓包折角
  const curlFinger = (bk, S, E, rBase = 0.0104, bow = [0, 0.006, 0.014, 0.02]) => {
    const ts = [0, 0.36, 0.7, 1]
    const pts = ts.map((t, i) => [
      S[0] + (E[0] - S[0]) * t,
      S[1] + (E[1] - S[1]) * t - bow[i],
      S[2] + (E[2] - S[2]) * t,
    ])
    tube(bk, ...pts[0], ...pts[1], rBase * 0.9, rBase * 0.66)                       // 近节（粗→细）
    ball(bk, ...pts[1], rBase * 0.97)                                                // 指节球（凸出管端 ~45%）
    tube(bk, ...pts[1], ...pts[2], rBase * 0.78, rBase * 0.56)                      // 中节
    ball(bk, ...pts[2], rBase * 0.8)                                                 // 中节球
    tube(bk, ...pts[2], ...pts[3], rBase * 0.7, rBase * 0.48)                       // 远节（最细）
    ball(bk, pts[3][0], pts[3][1] - 0.001, pts[3][2], rBase * 0.62, 1, 0.92, 1.2)  // 指尖（微扁圆）
  }
  // 三段拇指：粗短腕掌根 → 渐细指尖，与四指形成明显粗细对比
  const thumb3 = (bk, base, mid, tip) => {
    ball(bk, ...base, 0.0142)                          // 腕掌关节（粗）
    tube(bk, ...base, ...mid, 0.012, 0.0094)
    ball(bk, ...mid, 0.0112)                           // 拇指掌指球
    tube(bk, ...mid, ...tip, 0.0102, 0.007)
    ball(bk, tip[0], tip[1] + 0.001, tip[2], 0.0078, 1, 0.85, 1.35)
  }
  // 三球掌型：掌跟（近腕收窄）+ 掌中（最饱满）+ 指根脊（横向展开）叠出体积过渡
  const palm3 = (bk, heel, mid, ridge) => {
    ball(bk, ...heel, 16)
    ball(bk, ...mid, 16)
    ball(bk, ...ridge, 14)
  }
  // 指节护甲板：横跨指根列的微倾厚板（战术手套样式，凸出轮廓 ~2mm 读得出体积）
  const knucklePlate = (bk, x, y, z, span, rx) => boxAt(bk, 0.014, 0.016, span, x, y, z, rx)
  // 护腕束带：腕口一段加粗环（手套色，与袖料形成层次；合并进现有桶 → 零 draw call）
  const cuff = (bk, A, B, t0, t1, r) => tube(bk,
    A[0] + (B[0] - A[0]) * t0, A[1] + (B[1] - A[1]) * t0, A[2] + (B[2] - A[2]) * t0,
    A[0] + (B[0] - A[0]) * t1, A[1] + (B[1] - A[1]) * t1, A[2] + (B[2] - A[2]) * t1, r)
  // 右臂（握把）：三球掌 + 指节护甲 + 四指三节扣握 + 三段拇指 + 小臂/上臂探出画面右下（fingerZ 为绝对 Z 坐标）
  const rightArm = (gx, gy, gz, gripW, fingerZ, thumbZ) => {
    palm3(glove,
      [gx + 0.033, gy - 0.03, gz + 0.05, 0.030, 0.8, 1.02, 0.85],     // 掌跟
      [gx + 0.030, gy - 0.012, gz + 0.018, 0.036, 0.88, 1.18, 1.12],  // 掌中
      [gx + 0.026, gy + 0.008, gz - 0.006, 0.030, 1.14, 0.6, 1.38],   // 指根脊
    )
    const zMid = (fingerZ[0] + fingerZ[fingerZ.length - 1]) / 2
    knucklePlate(glove, gx + gripW + 0.006, gy + 0.026, zMid,
      Math.abs(fingerZ[fingerZ.length - 1] - fingerZ[0]) + 0.024, 0.22)
    for (const fz of fingerZ) curlFinger(glove, [gx + gripW, gy + 0.017, fz], [gx - gripW, gy - 0.004, fz - 0.006])
    thumb3(glove,
      [gx + 0.034, gy + 0.026, thumbZ + 0.014],
      [gx + 0.038, gy + 0.04, thumbZ - 0.004],
      [gx + 0.034, gy + 0.049, thumbZ - 0.022],
    )
    ball(sleeve, gx + 0.052, gy - 0.045, gz + 0.06, 0.036)                          // 腕
    tube(sleeve, gx + 0.056, gy - 0.05, gz + 0.07, gx + 0.10, gy - 0.125, gz + 0.185, 0.043, 0.054) // 小臂（短，肘端加粗）
    tube(sleeve, gx + 0.10, gy - 0.125, gz + 0.185, gx + 0.155, gy - 0.245, gz + 0.27, 0.054, 0.062) // 上臂残段（出画）
    cuff(glove, [gx + 0.056, gy - 0.05, gz + 0.07], [gx + 0.10, gy - 0.125, gz + 0.185], 0.04, 0.17, 0.0465)
  }
  // 左臂（护木/握把下）：三球掌（宽扁托底）+ 四指三节上翻扣顶 + 三段拇指 + 小臂/上臂探出画面左下
  const leftArm = (gx, gy, gz, gripW, fingerZ) => {
    palm3(glove,
      [gx - 0.006, gy - 0.034, gz + 0.056, 0.030, 0.9, 0.95, 0.9],    // 掌跟
      [gx - 0.004, gy - 0.018, gz + 0.008, 0.038, 1.22, 0.88, 1.3],   // 掌中（宽扁）
      [gx - 0.002, gy + 0.002, gz - 0.018, 0.031, 1.3, 0.55, 1.45],   // 指根脊
    )
    const zMid = (fingerZ[0] + fingerZ[fingerZ.length - 1]) / 2
    knucklePlate(glove, gx - gripW - 0.003, gy + 0.03, zMid,
      Math.abs(fingerZ[fingerZ.length - 1] - fingerZ[0]) + 0.024, -0.16)
    for (const fz of fingerZ) curlFinger(glove, [gx - gripW, gy + 0.014, fz], [gx + gripW - 0.004, gy + 0.032, fz + 0.005], 0.0098, [0, -0.004, -0.01, -0.003])
    thumb3(glove,
      [gx + gripW - 0.004, gy + 0.002, gz - 0.052],
      [gx + gripW + 0.002, gy + 0.008, gz - 0.03],
      [gx + gripW + 0.006, gy + 0.014, gz - 0.008],
    )
    ball(sleeve, gx - 0.052, gy - 0.055, gz + 0.11, 0.035)                          // 腕
    tube(sleeve, gx - 0.056, gy - 0.06, gz + 0.12, gx - 0.105, gy - 0.15, gz + 0.235, 0.043, 0.054) // 小臂（短）
    tube(sleeve, gx - 0.105, gy - 0.15, gz + 0.235, gx - 0.165, gy - 0.27, gz + 0.30, 0.054, 0.062) // 上臂残段（出画）
    cuff(glove, [gx - 0.056, gy - 0.06, gz + 0.12], [gx - 0.105, gy - 0.15, gz + 0.235], 0.04, 0.17, 0.0465)
  }

  if (kind === 'rifle') {
    rightArm(-0.068, -0.068, 0.086, 0.04, [0.064, 0.086, 0.108], 0.106)             // 右手握木握把（掌贴近侧面）
    leftArm(-0.036, -0.032, -0.31, 0.028, [-0.26, -0.3, -0.34, -0.37])              // 左手托下护木
  } else if (kind === 'pistol') {
    // 右手（主力握把）：三球掌 + 指节护甲 + 三指扣握 + 拇指贴机匣侧
    palm3(glove,
      [-0.032, -0.08, 0.076, 0.029, 0.8, 1.0, 0.85],
      [-0.03, -0.058, 0.05, 0.035, 0.82, 1.16, 1.25],
      [-0.028, -0.04, 0.026, 0.03, 1.06, 0.6, 1.3],
    )
    knucklePlate(glove, 0.038, -0.018, 0.048, 0.064, 0.25)
    for (const dz of [0.028, 0.048, 0.068]) curlFinger(glove, [0.034, -0.026, dz], [-0.028, -0.046, dz], 0.0098)
    thumb3(glove, [-0.03, -0.032, 0.06], [-0.028, -0.024, 0.028], [-0.026, -0.022, -0.004])
    // 左手（托底支撑）：三球掌 + 三指扣压右手 + 拇指压掌背
    palm3(glove,
      [-0.056, -0.09, 0.062, 0.028, 0.8, 0.95, 0.85],
      [-0.052, -0.066, 0.038, 0.033, 0.8, 1.1, 1.15],
      [-0.048, -0.046, 0.018, 0.028, 1.1, 0.55, 1.25],
    )
    for (const dz of [0.03, 0.05, 0.07]) curlFinger(glove, [-0.054, -0.044, dz], [0.026, -0.056, dz], 0.0092, [0, 0.003, 0.008, 0.012])
    thumb3(glove, [-0.06, -0.052, 0.024], [-0.052, -0.038, 0.006], [-0.044, -0.03, -0.008])
    ball(sleeve, 0.048, -0.092, 0.1, 0.036)
    tube(sleeve, 0.052, -0.096, 0.11, 0.10, -0.19, 0.235, 0.043, 0.054)
    tube(sleeve, 0.10, -0.19, 0.235, 0.155, -0.30, 0.33, 0.054, 0.062)
    cuff(glove, [0.052, -0.096, 0.11], [0.10, -0.19, 0.235], 0.04, 0.17, 0.0465)
    ball(sleeve, -0.05, -0.098, 0.085, 0.035)
    tube(sleeve, -0.054, -0.102, 0.095, -0.10, -0.19, 0.225, 0.042, 0.053)
    tube(sleeve, -0.10, -0.19, 0.225, -0.155, -0.29, 0.31, 0.053, 0.061)
    cuff(glove, [-0.054, -0.102, 0.095], [-0.10, -0.19, 0.225], 0.04, 0.17, 0.0445)
  } else if (kind === 'knife') {
    // 反握刀柄：三球掌 + 指节护甲 + 三指扣柄 + 拇指压柄脊
    palm3(glove,
      [-0.028, -0.05, 0.085, 0.029, 0.8, 1.0, 0.9],
      [-0.026, -0.026, 0.055, 0.036, 0.85, 1.28, 1.45],
      [-0.024, -0.006, 0.03, 0.03, 1.0, 0.6, 1.5],
    )
    knucklePlate(glove, 0.028, 0.002, 0.06, 0.087, 0.3)
    for (const dz of [0.03, 0.06, 0.09]) curlFinger(glove, [0.024, 0.0, dz], [-0.022, -0.018, dz], 0.01)
    thumb3(glove, [-0.026, 0.0, 0.04], [-0.022, 0.01, 0.026], [-0.018, 0.016, 0.012])
    ball(sleeve, 0.042, -0.058, 0.12, 0.036)
    tube(sleeve, 0.046, -0.062, 0.13, 0.095, -0.175, 0.25, 0.043, 0.054)
    tube(sleeve, 0.095, -0.175, 0.25, 0.15, -0.28, 0.32, 0.054, 0.062)
    cuff(glove, [0.046, -0.062, 0.13], [0.095, -0.175, 0.25], 0.04, 0.17, 0.0465)
  } else { // custom：用户自有枪模（customArms 原点=模型包围盒中心，-Z 朝枪口；经投影校准）
    // 手掌贴在枪身近侧（-X 面）外，手指穿过侧面 → 可见的"包握"
    rightArm(-0.12, 0.03, 0.126, 0.05, [0.1, 0.13, 0.16], 0.13)                     // 右手握握把（枪身后段）
    leftArm(-0.095, 0.1, -0.21, 0.035, [-0.26, -0.22, -0.18, -0.14])                // 左手包护木（枪身前段）
  }

  const g = new THREE.Group()
  g.add(new THREE.Mesh(mergeGeometries(sleeve, false), armMats.sleeve))
  g.add(new THREE.Mesh(mergeGeometries(glove, false), armMats.glove))
  return g
}

// 自有 GLB 枪模的静态持枪手臂（原点=模型包围盒中心，-Z 朝枪口；经投影校准）
export function buildCustomArms(armMats) {
  return buildArms(armMats, 'custom')
}

// ---- 入口：构建全部武器模型与共享材质 ----
export function buildWeaponModels() {
  // 共享 PBR 材质（拉丝金属/聚合物/木纹贴图 + 法线/粗糙度）
  const metalMaps = Tex.metal()
  const woodMaps = Tex.wood()
  const polyMaps = Tex.polymer()
  const vmMats = {
    steel: new THREE.MeshStandardMaterial({ color: 0x868e99, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, normalMap: metalMaps.normalMap, roughness: 0.42, metalness: 0.82 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x565c66, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, normalMap: metalMaps.normalMap, roughness: 0.55, metalness: 0.6 }),
    wood: new THREE.MeshStandardMaterial({ color: 0xb08a5e, map: woodMaps.map, normalMap: woodMaps.normalMap, roughness: 0.55, metalness: 0.05 }),
    poly: new THREE.MeshStandardMaterial({ color: 0xcfd4da, map: polyMaps.map, roughnessMap: polyMaps.roughnessMap, normalMap: polyMaps.normalMap, roughness: 0.82, metalness: 0.08 }),
    silver: new THREE.MeshStandardMaterial({ color: 0xc9d2da, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, roughness: 0.3, metalness: 0.95 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xe0b53c, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, normalMap: metalMaps.normalMap, roughness: 0.3, metalness: 0.9, emissive: 0x332200 }),
    dot: new THREE.MeshStandardMaterial({ color: 0x7dff9a, emissive: 0x2fbf62, emissiveIntensity: 2.2, roughness: 0.4 }),
  }
  // 第一人称手臂材质：袖臂 = 战术布料织纹；手套 = 聚合物橘皮纹（法线加重出近景微凹凸）
  const fabricMaps = Tex.fabric()
  const armMats = {
    sleeve: new THREE.MeshStandardMaterial({ color: 0x8d949c, map: fabricMaps.map, roughnessMap: fabricMaps.roughnessMap, normalMap: fabricMaps.normalMap, roughness: 0.93, metalness: 0 }),
    glove: (() => {
      const m = new THREE.MeshStandardMaterial({ color: 0xa8aeb5, map: polyMaps.map, roughnessMap: polyMaps.roughnessMap, normalMap: polyMaps.normalMap, roughness: 0.85, metalness: 0.05 })
      m.normalScale = new THREE.Vector2(1.3, 1.3) // 近景微凹凸加重
      return m
    })(),
  }
  const viewmodels = {
    vandal: buildRifleAK(vmMats),
    phantom: buildRifleSuppressed(vmMats),
    sheriff: buildRevolver(vmMats),
    classic: buildPistol(vmMats, false),
    ghost: buildPistol(vmMats, true),
    knife: buildKnife(vmMats),
  }
  // 静态持枪手臂跟随各武器（继承位置/缩放/后坐摆动，本身不做独立动画）
  const armFor = { vandal: 'rifle', phantom: 'rifle', sheriff: 'pistol', classic: 'pistol', ghost: 'pistol', knife: 'knife' }
  for (const [id, kind] of Object.entries(armFor)) viewmodels[id].add(buildArms(armMats, kind))
  return { viewmodels, vmMats, armMats }
}
