import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'

// ============================================================================
// GLB 手部装配（IK 式姿态拟合）：把用户/内置的 hands.glb / glove.glb 装到枪上。
// 与 WeaponSystem 的接口：读 sys.vmScene / vmHolder / customVm / armMats，
// 写 sys.customHands / sys.customArms（显隐），结束时调 sys.weaponMeshFor()。
// sys = WeaponSystem 实例（字段定义与调用时序见各函数注释）。
// ============================================================================

// ---- 两骨 IK 手臂落位（glove 路径的建模手臂）----
// arms = hands.glb 场景（Shirt 袖 + Skin 皮肤小臂，Glove 手网格隐藏），
// tR/tL = 目标腕点（相机系世界坐标，通常为手套实例的腕骨）。
// 与 poseCustomHands 同一套数学：解剖学定尺（腕→食指尖恒 8.2cm，与手套同标定，
// 保证袖口与手套腕口粗细衔接）+ 肩位自由放置（肘方向 × 0.86 全链长，留弯曲量）
// + 两骨 IK（极向量约束肘部下弯出画）+ 战术腕带盖衔接缝。返回挂载的根节点。
function placeArmsIK(sys, group, arms, tR, tL) {
  const root = cloneSkinned(arms)
  root.traverse(o => {
    if (o.isMesh) {
      o.frustumCulled = false
      if (/glove/i.test(o.material?.name || '')) o.visible = false // 只留袖/皮肤小臂
    }
  })
  // 绑定长度必须在挂载前量（挂载后 wp 读数被 holder 缩放污染）
  root.quaternion.identity()
  root.position.set(0, 0, 0)
  root.scale.setScalar(1)
  root.updateMatrixWorld(true)
  const bonesA = {}
  root.traverse(o => { if (o.isBone) bonesA[o.name] = o })
  // GLTFLoader 清洗后名：UpperArm.R.001 → UpperArmR001、UpperArm.L → UpperArmL
  const armR = { up: bonesA.UpperArmR001, low: bonesA.LowerArmR001, hand: bonesA.HandR001 }
  const armL = { up: bonesA.UpperArmL, low: bonesA.LowerArmL, hand: bonesA.HandL }
  if ([armR.up, armR.low, armR.hand, armL.up, armL.low, armL.hand, bonesA.IndexTipR001].some(b => !b)) {
    console.warn('[VHT] hands.glb 臂骨不全，建模手臂未接入')
    return null
  }
  const wp = (o) => { sys.vmScene.updateMatrixWorld(true); return o.getWorldPosition(new THREE.Vector3()) }
  const worldRotate = (bone, q) => {
    sys.vmScene.updateMatrixWorld(true)
    const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion())
    bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq))
    sys.vmScene.updateMatrixWorld(true)
  }
  const pB = (o) => o.getWorldPosition(new THREE.Vector3())
  const segR = { u: pB(armR.low).distanceTo(pB(armR.up)), f: pB(armR.hand).distanceTo(pB(armR.low)) }
  const segL = { u: pB(armL.low).distanceTo(pB(armL.up)), f: pB(armL.hand).distanceTo(pB(armL.low)) }
  const armHandLen = pB(bonesA.IndexTipR001).distanceTo(pB(armR.hand))
  const holderScale = sys.vmHolder.scale.x
  const rootScale = 0.082 / armHandLen / holderScale
  root.scale.setScalar(rootScale)
  group.add(root)
  sys.vmScene.updateMatrixWorld(true)
  const elbowDirR = new THREE.Vector3(0.5, -0.78, 0.38).normalize() // 肘压低偏右 → 肘部出画
  const chainR = (segR.u + segR.f) * rootScale * holderScale
  const sR = tR.clone().addScaledVector(elbowDirR, chainR * 0.86)
  const pivot = wp(armR.up) // = hPos=0 时的右肩位
  const rsInv = sys.vmHolder.matrixWorld.clone()
  rsInv.setPosition(0, 0, 0) // 只消旋转+缩放；平移已包含在 pivot 中
  rsInv.invert()
  root.position.copy(sR.clone().sub(pivot).applyMatrix4(rsInv))
  sys.vmScene.updateMatrixWorld(true)
  const ik2 = (arm, seg, T, pole) => {
    const u = seg.u * rootScale * holderScale, f = seg.f * rootScale * holderScale
    const S = wp(arm.up)
    const D = THREE.MathUtils.clamp(S.distanceTo(T), Math.abs(u - f) + 1e-4, u + f - 1e-4)
    const a = (D * D + u * u - f * f) / (2 * D)
    const h = Math.sqrt(Math.max(u * u - a * a, 0))
    const dir = T.clone().sub(S).normalize()
    const perp = pole.clone().addScaledVector(dir, -pole.dot(dir))
    if (perp.lengthSq() < 1e-8) perp.set(-dir.y, dir.x, 0) // 极向量与臂轴共线时取正交fallback
    perp.normalize()
    const E = S.clone().addScaledVector(dir, a).addScaledVector(perp, h)
    worldRotate(arm.up, new THREE.Quaternion().setFromUnitVectors(
      wp(arm.low).sub(S).normalize(), E.clone().sub(S).normalize()))
    worldRotate(arm.low, new THREE.Quaternion().setFromUnitVectors(
      wp(arm.hand).sub(wp(arm.low)).normalize(), T.clone().sub(wp(arm.low)).normalize()))
  }
  // 右肘弯向右下（肘压低出画），左肘弯向左下（前臂自下而上托向护木）
  ik2(armR, segR, tR, elbowDirR)
  ik2(armL, segL, tL, new THREE.Vector3(-0.3, -0.95, -0.05).normalize())
  // ---- 腕带：战术护腕环，盖住手套腕口与建模手臂的衔接（兼遮粗细差）----
  const bandGeos = []
  const _m4 = new THREE.Matrix4(), _q2 = new THREE.Quaternion(), _s2 = new THREE.Vector3(1, 1, 1)
  const bandFor = (handBone, lowerBone) => {
    const hw = wp(handBone)
    const dir = hw.clone().sub(wp(lowerBone)).normalize() // 腕→小臂方向 = 前臂轴
    const center = hw.clone().addScaledVector(dir, 0.012) // 骑在手套腕口与袖口衔接缝上
    const ring = new THREE.TorusGeometry(0.015, 0.006, 10, 20)
    _q2.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)
    _m4.compose(center, _q2, _s2)
    ring.applyMatrix4(_m4).applyMatrix4(sys.vmHolder.matrixWorld.clone().invert())
    bandGeos.push(ring)
  }
  bandFor(armR.hand, armR.low)
  bandFor(armL.hand, armL.low)
  group.add(new THREE.Mesh(mergeGeometries(bandGeos, false), sys.armMats.sleeve))
  return root
}


// ---- 高精度手套双手（public/models/glove.glb：单手 + Wrist/五指三关节骨骼）----
// 实例化两份（SkeletonUtils.clone）→ 各自根节点落位（腕骨精确到握点 + 掌姿态
// 对齐握持面）→ 五指逐节本地卷曲成握持状；袖管用程序化圆柱（布料贴图）自腕部
// 探向画面下侧出画。相比 hands.glb 的低模三指合并手套，五指独立 + 高模细节显著
// 更好；glove.glb 缺失/骨架不符时回退 hands.glb。
// 姿态要点（骨架特性驱动，2026-09-02 重写）：
//  1) 该骨架五指根骨共点（拇指/四指 meta 平移完全相同），五指展开角全部编码在
//     指根的绑定旋转里 —— 指根只做本地卷曲、绝不做"瞄准"旋转，否则扇形被抹掉
//     五指叠成一团（旧版把手揉成球的根因之一）。
//  2) 绑定基测量必须用指尖：掌根→拇指"根"与五指根共点，方向退化成零向量，
//     旧版据此算出的掌姿态基 qBind 是垃圾（根因之二）。
//  3) 骨骼沿本地 +Y 延伸（Blender 导出），rotateX(+) 即向掌心卷曲（实测验证）。
//  4) 模型本体是左手（掌心朝上绑定）：右手实例 scale.x 取负镜像出右手
//     （three.js 按矩阵行列式自动翻绕序，蒙皮渲染无瑕疵，实测验证）。
export function poseGloveHands(sys, scene, arms) {
  if (!sys.customVm) return false
  // 绑定几何测量（原始场景孤立态：根单位变换）——先于任何挂载/缩放
  scene.quaternion.identity()
  scene.position.set(0, 0, 0)
  scene.scale.setScalar(1)
  scene.updateMatrixWorld(true)
  const byName = {}
  scene.traverse(o => { if (o.name) byName[o.name] = o })
  if (localStorage.getItem('vhtdbg')) console.log('[dbg] glove bones:', Object.keys(byName).join(','))
  const pickAny = (...res) => byName[Object.keys(byName).find(k => res.some(re => re.test(k)))]
  // GLTFLoader 名称清洗：空格→下划线、点删除（"Index Finger"→Index_Finger / "Lower.001"→Lower001）
  const wristB = pickAny(/^Wrist$/)
  const handB = pickAny(/^Hand$/)
  const thumbEnd = pickAny(/^Top_end$/) // 拇指链末端节点（量拇指方向用，非骨骼）
  const F = {
    thumb: [pickAny(/^Thumb$/), pickAny(/^Lower$/), pickAny(/^Middle$/), pickAny(/^Top$/)],
    index: [pickAny(/^Index_?Finger$/), pickAny(/^Lower001$/), pickAny(/^Middle001$/), pickAny(/^Top001$/)],
    middle: [pickAny(/^Middle_?Finger$/), pickAny(/^Lower002$/), pickAny(/^Middle002$/), pickAny(/^Top002$/)],
    ring: [pickAny(/^Ring_?Finger$/), pickAny(/^Lower003$/), pickAny(/^Middle003$/), pickAny(/^Top003$/)],
    pinky: [pickAny(/^Pinky$/), pickAny(/^Lower004$/), pickAny(/^Middle004$/), pickAny(/^Top004$/)],
  }
  const needed = [wristB, handB, thumbEnd, ...F.thumb, ...F.index, ...F.middle, ...F.ring, ...F.pinky]
  if (needed.some(b => !b)) {
    console.warn('[VHT] glove.glb 骨架不符合预期（缺少 Wrist/五指骨），已回退 hands.glb')
    return false
  }
  const bp = (o) => o.getWorldPosition(new THREE.Vector3())
  const fBind = bp(F.middle[3]).sub(bp(wristB)).normalize()      // 腕→中指尖 = 手指方向
  const sBind0 = bp(thumbEnd).sub(bp(wristB)).normalize()        // 腕→拇指尖 = 拇指侧向（指尖才不共点）
  const pBind = fBind.clone().cross(sBind0).normalize()          // 掌法向（左手模型指向手背）
  const sBind = pBind.clone().cross(fBind).normalize()           // 正交化拇指侧向
  const handLenBind = bp(F.middle[3]).distanceTo(bp(wristB))     // 腕→中指尖实测长度

  // ---- 挂载组与矩阵工具（沿用 poseCustomHands 的教训：先挂载、vmScene 根级联刷新）----
  if (sys.customHands) sys.vmHolder.remove(sys.customHands)
  const group = new THREE.Group()
  sys.customHands = group
  sys.vmHolder.add(group)
  if (sys.customArms) sys.customArms.visible = false
  sys.vmScene.updateMatrixWorld(true)
  const vmP = (x, y, z) => sys.customVm.localToWorld(new THREE.Vector3(x, y, z))
  const wp = (o) => { sys.vmScene.updateMatrixWorld(true); return o.getWorldPosition(new THREE.Vector3()) }
  const holderScale = sys.vmHolder.scale.x
  // 腕→中指尖 8.2cm（相机系）：枪模 0.85m × holder 0.43 ≈ 37cm，真手 19cm × 同比例 ≈ 8cm
  const handLenM = 0.082
  const handScale = handLenM / handLenBind / holderScale

  // 单手实例：腕骨精确落位 + 掌姿态 → 五指逐节本地卷曲（保留绑定扇形展开）
  // mirror=true 时 scale.x 取负：模型是左手，镜像出右手。镜像会翻转基的手性，
  // 绑定基按 F·f / F·s、法向重算叉积（(Fa)×(Fs) = -F·(a×b)）构造合法旋转。
  const poseHand = (cfg) => {
    const root = cloneSkinned(scene)
    root.traverse(o => { if (o.isMesh) o.frustumCulled = false })
    group.add(root)
    root.quaternion.identity()
    root.scale.set(cfg.mirror ? -handScale : handScale, handScale, handScale)
    root.position.set(0, 0, 0)
    // 掌姿态：（镜像）绑定基 → 目标基（fDes 手指向 / sDes 拇指侧向），换算到 holder 本地
    const m = cfg.mirror ? -1 : 1
    const fB = new THREE.Vector3(m * fBind.x, fBind.y, fBind.z)
    const sB = new THREE.Vector3(m * sBind.x, sBind.y, sBind.z)
    const pB = fB.clone().cross(sB).normalize()
    const qB = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fB, sB, pB))
    const fD = cfg.fDes.clone().normalize()
    const sD0 = cfg.sDes.clone().normalize()
    const pD = fD.clone().cross(sD0).normalize()
    const sD = pD.clone().cross(fD).normalize()
    const qDes = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fD, sD, pD)).multiply(qB.clone().invert())
    const qHolder = sys.vmHolder.getWorldQuaternion(new THREE.Quaternion())
    root.quaternion.copy(qHolder.clone().invert().multiply(qDes))
    sys.vmScene.updateMatrixWorld(true)
    // 腕骨落位：t = (RS)⁻¹·(锚点 − pivot)（pivot = 本地零平移时的腕骨世界位；
    // RS 只逆 holder 的旋转+缩放，负 scale 的手根矩阵已含在 pivot 读数里）
    const bones = {}
    root.traverse(o => { if (o.isBone) bones[o.name] = o })
    const wristLocal = bones[wristB.name]
    const pivot = wp(wristLocal)
    const rsInv = sys.vmHolder.matrixWorld.clone()
    rsInv.setPosition(0, 0, 0)
    rsInv.invert()
    root.position.copy(cfg.wrist.clone().sub(pivot).applyMatrix4(rsInv))
    sys.vmScene.updateMatrixWorld(true)
    // 五指逐节本地卷曲：绕各节本地 X 轴（骨骼沿 +Y 延伸），+ 角度 = 向掌心（实测）。
    // curls 四值 = [指根meta, 近节, 中节, 远节]：指根小幅参与让掌指关节成弧，
    // 其余递减出自然梯度；指根本地 X 卷曲不改变绑定 Z 向扇形展开角
    for (const [k, degs] of Object.entries(cfg.curls)) {
      const ch = F[k].map(b => bones[b.name])
      degs.forEach((deg, i) => { if (deg) ch[i].rotateX(THREE.MathUtils.degToRad(deg)) })
    }
    sys.vmScene.updateMatrixWorld(true)
    return { root, wristBone: wristLocal }
  }

  // ---- 右手（镜像）：握把。掌压握把右面，四指阶梯卷曲绕握把前缘（中指→小指
  // 递增卷曲）、食指弯入扳机护圈扣扳机、拇指高位前伸贴机匣左侧（high-thumb）。
  // 腕锚为枪模本地系；fDes/sDes/curls 为 2026-09-03 页面内坐标下降优化收敛值
  // （十指指尖到各自握点误差：拇指 2.5cm、其余 ≤0.8cm）----
  const handR = poseHand({
    mirror: true,
    wrist: vmP(0.03, -0.045, 0.01),
    fDes: new THREE.Vector3(-0.66, -0.36, -0.95),
    sDes: new THREE.Vector3(-0.38, 0.81, -0.61),
    curls: {
      pinky: [12, 71, 68, 20],
      ring: [17, 74, 68, 22],
      middle: [22, 72, 73, 24],
      index: [23, 34, 40, 14],
      thumb: [5, 19, 10, 5],
    },
  })
  // ---- 左手（原生左手）：护木。掌从左下兜住护木底面，四指绕前右侧贴护木、
  // 拇指沿左侧前伸对握（C 型托握）。同上为优化收敛值 ----
  const handL = poseHand({
    wrist: vmP(-0.505, -0.265, 0.12),
    fDes: new THREE.Vector3(0.69, 0.67, -0.64),
    sDes: new THREE.Vector3(-0.71, 0.63, -0.25),
    curls: {
      pinky: [4, 22, 18, 12],
      ring: [4, 23, 19, 13],
      middle: [4, 24, 20, 14],
      index: [3, 20, 17, 12],
      thumb: [0, 3, 2, 0],
    },
  })

  // ---- 真人手臂（hands.glb 建模袖臂：Shirt 袖 + Skin 皮肤小臂；Glove 手网格
  // 隐藏 —— 手由上面的高细节五指手套提供）。落位 = placeArmsIK：解剖学定尺 +
  // 肩位自由放置 + 两骨 IK 精确够到双腕（手套腕骨），弯向同 2026-09-03 方案 ----
  if (arms) placeArmsIK(sys, group, arms, wp(handR.wristBone), wp(handL.wristBone))

  sys.weaponMeshFor(sys.currentVmId)
  return true
}

// 用户自有 GLB 手臂（public/models/hands.glb）→ IK 式持枪姿态
// 成熟 FPS 做法（CS2 / Valorant / OW 通用）：
//   1) 手臂明显短于解剖学比例 —— viewmodel 只保留小臂+手，肘/肩永远在画外，
//      既避免"手臂过长穿帮"，也省去近裁剪面/穿模问题
//   2) 握点从枪模几何自动推导（换 viewmodel.glb 无需重调姿态）
//   3) 肩位 = 握点 + 肘方向 × 臂长：肘方向压低朝画面下侧 → 肘部尽快出画
// 骨架适配（J-Toastie Rigged FPS Arms，绑定姿态=双臂前伸、指与前臂共线）：
//   aimArm 整臂绕肩旋转（直链，腕到肩距离=臂长恒定）；orientHand 三点基定腕朝向；
//   aimFinger 指链先瞄特征点再逐节向掌心卷曲。
// 注意：hands 需为未经本方法处理过的新实例（loadUserAssets 每次返回新场景）。
export function poseCustomHands(sys, hands) {
  if (!sys.customVm) return false // 无自有枪模时握点无法推导，直接回退内置手臂
  hands.updateMatrixWorld(true)
  const byName = {}
  hands.traverse(o => { if (o.name) byName[o.name] = o })
  const pick = (re) => byName[Object.keys(byName).find(k => re.test(k))]
  const armR = { up: pick(/^UpperArmR/), low: pick(/^LowerArmR/), hand: pick(/^HandR/) }
  const armL = { up: pick(/^UpperArmL$/), low: pick(/^LowerArmL$/), hand: pick(/^HandL$/) }
  const chain = (a, b, c) => [pick(a), pick(b), pick(c)]
  const F = {
    R: { // 点号已被 GLTFLoader 清理：Hand.R.001 → HandR001
      dbl: chain(/^DoubleFingersBeginning001/, /^DoubleFingersR/, /^DoubleFingersTipR/),
      idx: chain(/^IndexBeginningR/, /^IndexR/, /^IndexTipR/),
      thb: chain(/^ThumbBeginningR/, /^ThumbR/, /^ThumbTipR/),
    },
    L: {
      dbl: chain(/^DoubleFingersBeginning$/, /^DoubleFingersL$/, /^DoubleFingersTipL$/),
      idx: chain(/^IndexBeginningL$/, /^IndexL$/, /^IndexTipL$/),
      thb: chain(/^ThumbBeginningL$/, /^ThumbL$/, /^ThumbTipL$/),
    },
  }
  // 骨架防御：用户换用其它骨架的 hands.glb 时骨骼名对不上，后续 IK 取世界矩阵会抛
  // TypeError → 跳过贴合，回退内置程序化手臂
  const needed = [armR.up, armR.low, armR.hand, armL.up, armL.low, armL.hand,
    ...F.R.dbl, ...F.R.idx, ...F.R.thb, ...F.L.dbl, ...F.L.idx, ...F.L.thb]
  if (needed.some(b => !b)) {
    console.warn('[VHT] hands.glb 骨架不符合预期（缺少 UpperArm/Hand/指骨），已回退内置手臂')
    return false
  }
  const wp = (o) => { sys.vmScene.updateMatrixWorld(true); return o.getWorldPosition(new THREE.Vector3()) }
  // 世界系旋转单根骨骼（保持父链不变）。矩阵从场景根级联刷新，保证 pq 与姿态始终同帧
  const worldRotate = (bone, q) => {
    sys.vmScene.updateMatrixWorld(true)
    const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion())
    bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq))
    sys.vmScene.updateMatrixWorld(true)
  }
  // 单指节向掌心卷曲：绕（指节方向 × 指根→腕方向）轴
  const curlJoint = (bone, handBone, angle) => {
    const a = wp(bone)
    const child = bone.children.find(c => c.isBone || c.name)
    const dir = wp(child).sub(a).normalize()
    const radial = a.clone().sub(wp(handBone)).normalize()
    worldRotate(bone, new THREE.Quaternion().setFromAxisAngle(dir.cross(radial).normalize(), angle))
  }
  const aimFinger = (ch, handBone, aim, curlDegs) => {
    const base = wp(ch[0])
    const cur = wp(ch[2]).sub(base).normalize()
    worldRotate(ch[0], new THREE.Quaternion().setFromUnitVectors(cur, aim.clone().sub(base).normalize()))
    curlDegs.forEach((deg, i) => { if (deg) curlJoint(ch[i], handBone, THREE.MathUtils.degToRad(deg)) })
  }
  // 手腕姿态：三点基（指/拇/掌）→ 目标基（掌心朝 pDes、指朝 fDes）
  const orientHand = (arm, fing, fDes, pDes) => {
    const Fd = wp(fing.idx[2]).sub(wp(arm.hand)).normalize()
    const Td = wp(fing.thb[2]).sub(wp(arm.hand)).normalize()
    const Pd = Fd.clone().cross(Td).normalize()
    const tDes = pDes.clone().cross(fDes).normalize()
    const qCur = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Fd, Td, Pd))
    const qTar = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fDes.clone().normalize(), tDes, pDes.clone().normalize()))
    worldRotate(arm.hand, qTar.multiply(qCur.invert()))
  }

  // ---- 姿态（vmScene 世界系 == 相机本地系；vmCamera 固定原点无旋转）----
  // 握点/指尖瞄准点全部用"枪模模型系"坐标经 vmP() 精确换算（含缩放/旋转/平移）。
  // 本枪模（Quaternius AK47，归一化前）实测几何轮廓（2026-09-03 顶点切片复测，X=枪管轴）：
  //   枪管 -1.05..-0.7（轴心 y≈0.25）/ 护木 -0.6..-0.45（底面 y≈-0.24）/ 弹匣 -0.45..-0.3
  //   （下探 y=-0.32）/ 机匣 -0.3..-0.1（底面 y≈0）/ 握把 -0.1..0.1（下探 y=-0.1）/ 枪托 0.1..0.41
  // vmP 坐标系 = 枪模本地系：(x=枪管轴向, y=垂直, z=横向)。customVm 自带 -90°Y 旋转，
  // 本地 -X（枪口方向）映到相机 -Z、本地 -Z 映到相机 +X（右侧）——横向偏移取负即在相机右侧。
  // 挂载前先量绑定几何（挂载后距离读数会被 holder 缩放污染）：
  // u/f = 上臂/小臂绑定长度，handLen = 腕→食指尖（解剖学定尺用）
  hands.quaternion.identity()
  hands.position.set(0, 0, 0)
  hands.scale.setScalar(1)
  hands.updateMatrixWorld(true)
  const pB = (o) => o.getWorldPosition(new THREE.Vector3())
  const segR = { u: pB(armR.low).distanceTo(pB(armR.up)), f: pB(armR.hand).distanceTo(pB(armR.low)) }
  const segL = { u: pB(armL.low).distanceTo(pB(armL.up)), f: pB(armL.hand).distanceTo(pB(armL.low)) }
  const handLen = pB(F.R.idx[2]).distanceTo(pB(armR.hand))
  // 挂进 holder 后做姿态：wp/worldRotate 一律从 vmScene 根级联刷新矩阵，
  // 所有量（锚点、骨骼位置、旋转）始终同帧，免疫挂载时序问题
  if (sys.customHands && sys.customHands !== hands) sys.vmHolder.remove(sys.customHands)
  sys.customHands = hands
  sys.vmHolder.add(hands)
  if (sys.customArms) sys.customArms.visible = false
  sys.vmScene.updateMatrixWorld(true)
  // 握点/指尖瞄准点全部用"枪模模型系"坐标经 vmP() 精确换算（含缩放/旋转/平移）。
  const vmP = (x, y, z) => sys.customVm.localToWorld(new THREE.Vector3(x, y, z))
  // 腕锚点（枪模本地系）：右手在握把右后下方（掌压握把右面）、左手在弹匣交界
  // 后下方（掌托护木底、指朝前上绕护木前缘 → C 型托握）；横向 z 取负 = 相机右侧
  const wristR = vmP(-0.02, -0.055, -0.045)
  const wristL = vmP(-0.42, -0.27, 0.03)
  // 解剖学定尺：腕→指尖恒 8.2cm（与 setGloveHands 同一标定），根缩放与臂长解耦——
  // 旧方案"扫描臂长使双肩恰好够到双腕"把手的尺寸绑死在肩腕距离上，左腕移近后
  // 整条手臂+手缩到 60%（戴手套的玩偶手）。肩位在画外可自由放置，够距交给两骨 IK。
  const holderScale = sys.vmHolder.scale.x
  const rootScale = 0.082 / handLen / holderScale
  hands.quaternion.identity()
  hands.scale.setScalar(rootScale)
  hands.position.set(0, 0, 0)
  // 肩位放置：右肩 = 右腕锚 + 肘方向 × 弯曲度×全链长（0.86 留 14% 弯曲量给 IK），
  // 根平移 t = (RS)⁻¹·(S_target − pivot)（pivot = hPos=0 时的右肩位，RS 只逆旋转+缩放）
  const elbowDirR = new THREE.Vector3(0.5, -0.78, 0.38).normalize() // 肘压低偏右 → 肘部出画
  const chainR = (segR.u + segR.f) * rootScale * holderScale
  const sR = wristR.clone().addScaledVector(elbowDirR, chainR * 0.86)
  const pivot = wp(armR.up)
  const rsInv = sys.vmHolder.matrixWorld.clone()
  rsInv.setPosition(0, 0, 0) // 只消旋转+缩放；平移已包含在 pivot 中
  rsInv.invert()
  hands.position.copy(sR.clone().sub(pivot).applyMatrix4(rsInv))
  sys.vmScene.updateMatrixWorld(true)
  // 两骨 IK（肩-肘-腕）：极向量约束肘部弯向；肘位 = 肩 + dir·a + perp·h（余弦定理），
  // 先整链瞄肘位、再小臂骨旋转把腕精确落到目标。腕不可达时夹紧 D（腕落短在线上）
  const ik2 = (arm, seg, T, pole) => {
    const u = seg.u * rootScale * holderScale, f = seg.f * rootScale * holderScale
    const S = wp(arm.up)
    const D = THREE.MathUtils.clamp(S.distanceTo(T), Math.abs(u - f) + 1e-4, u + f - 1e-4)
    const a = (D * D + u * u - f * f) / (2 * D)
    const h = Math.sqrt(Math.max(u * u - a * a, 0))
    const dir = T.clone().sub(S).normalize()
    const perp = pole.clone().addScaledVector(dir, -pole.dot(dir))
    if (perp.lengthSq() < 1e-8) perp.set(-dir.y, dir.x, 0) // 极向量与臂轴共线时取正交fallback
    perp.normalize()
    const E = S.clone().addScaledVector(dir, a).addScaledVector(perp, h)
    worldRotate(arm.up, new THREE.Quaternion().setFromUnitVectors(
      wp(arm.low).sub(S).normalize(), E.clone().sub(S).normalize()))
    worldRotate(arm.low, new THREE.Quaternion().setFromUnitVectors(
      wp(arm.hand).sub(wp(arm.low)).normalize(), T.clone().sub(wp(arm.low)).normalize()))
  }
  // 右肘弯向右下（肘压低出画），左肘弯向左下（前臂自下而上托向护木）
  ik2(armR, segR, wristR, elbowDirR)
  ik2(armL, segL, wristL, new THREE.Vector3(-0.3, -0.95, -0.05).normalize())
  // 掌心朝向：右手压握把右侧面（掌朝 -X）；左手掌朝上（fDes 前上 55°、
  // 卷曲把四指收在护木前下缘、拇指贴左侧面成对握 → 27 组网格搜索实测最优）
  const V = (x, y, z) => new THREE.Vector3(x, y, z).normalize()
  orientHand(armR, F.R, V(-0.6, -0.4, -0.68), V(-0.95, -0.2, -0.25))
  orientHand(armL, F.L, V(0.22, 0.55, -0.8), V(0.2, 0.95, 0.15))
  // 指尖瞄准点（枪模本地系）：R 四指绕握把前缘 / 食指沿扳机护圈 / 拇指压握把后脊；
  // L 四指卷向护木右前侧面 / 拇指沿护木左侧上提对握
  aimFinger(F.R.dbl, armR.hand, vmP(-0.16, -0.075, -0.055), [28, 46, 40])
  aimFinger(F.R.idx, armR.hand, vmP(-0.17, -0.045, -0.03), [8, 14, 12])
  aimFinger(F.R.thb, armR.hand, vmP(0.03, 0, -0.05), [8, 12, 0])
  aimFinger(F.L.dbl, armL.hand, vmP(-0.53, -0.08, -0.08), [30, 50, 44])
  aimFinger(F.L.idx, armL.hand, vmP(-0.55, -0.05, -0.085), [26, 43, 37])
  aimFinger(F.L.thb, armL.hand, vmP(-0.57, -0.02, 0.085), [10, 10, 4])

  hands.traverse(o => { if (o.isMesh) o.frustumCulled = false }) // 蒙皮包围盒不随骨骼更新
  sys.weaponMeshFor(sys.currentVmId)
}
