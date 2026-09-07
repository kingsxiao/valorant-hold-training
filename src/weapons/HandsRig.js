import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'

// ============================================================================
// GLB 手部装配（IK 式姿态拟合）：把用户/内置的 hands.glb / glove.glb 装到枪上。
// 与 WeaponSystem 的接口：读 sys.vmScene / vmHolder / activeCustomVm() / armMats，
// 写 sys.customHands / sys.customArms（显隐）/_handsPoseFor，结束时调 sys.weaponMeshFor()。
// sys = WeaponSystem 实例（字段定义与调用时序见各函数注释）。
// ============================================================================

// ---- 两骨 IK 手臂落位（glove 路径的建模手臂）----
// arms = hands.glb 场景（Shirt 袖 + Skin 皮肤小臂，Glove 手网格隐藏），
// tR/tL = 目标腕点（相机系世界坐标，通常为手套实例的腕骨）。
// 与 poseCustomHands 同一套数学：解剖学定尺（腕→食指尖恒 8.2cm，与手套同标定，
// 保证袖口与手套腕口粗细衔接）+ 肩位自由放置（肘方向 × 0.86 全链长，留弯曲量）
// + 两骨 IK（极向量约束肘部下弯出画）+ 战术腕带盖衔接缝。返回挂载的根节点。
// 衔接核验（2026-09-07 切枪摆动瞬态）：重摆时本函数与手套姿态在同一次
// poseGloveHands 调用内解算（袖臂 HandR 骨精确落在手套 Wrist 骨上，双腕
// 实测衔接 0mm），且两段式切枪的重摆发生在画面外 → 任何时刻无衔接缝

// 该模型的 Skin 材质网格除小臂外还含整只皮肤手与五指（权重绑到 Hand/指骨）。
// 本路径的手由高细节手套提供，皮肤手若保留会以绑定伸直姿态从手套指尖戳出，
// 视觉上呈"漂浮的断指"——按支配骨骼剥掉 Hand/指骨区顶点，只留袖/小臂段。
// 注意 cloneSkinned 与源场景共享 geometry，必须克隆后再过滤。
function stripHandVertices(armsRoot) {
  const keep = new Set(['UpperArmR001', 'UpperArmL', 'LowerArmR001', 'LowerArmL'])
  armsRoot.traverse(o => {
    if (!o.isSkinnedMesh || !o.geometry?.attributes?.skinIndex) return
    const src = o.geometry
    const si = src.attributes.skinIndex, sw = src.attributes.skinWeight
    const bones = o.skeleton?.bones
    if (!bones) return
    const keepV = new Uint8Array(si.count)
    let kept = 0
    for (let i = 0; i < si.count; i++) {
      let best = -1, bestW = 0
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k)
        if (w > bestW) { bestW = w; best = si.getComponent(i, k) }
      }
      if (best >= 0 && keep.has(bones[best]?.name)) { keepV[i] = 1; kept++ }
    }
    if (kept === si.count || kept === 0) return
    // 输出非索引几何：只保留被保留顶点涉及的三角形（跨保留/删除边界的三角形
    // 直接丢弃——蒙皮变形下缝隙由腕带遮盖）。顶点级悬空索引会以 0xFFFF 读出越界
    // 蒙皮权重 → applyBoneTransform 崩溃，所以绝不能只重映射 index。
    // 量化 GLB 的属性常共享交错缓冲，attr.array 不能当独立数组按位读——
    // 一律走 getX/getY/getZ/getW 接口取分量（对交错属性也正确）。
    const tris = src.index ? src.index.array : null
    const keptTris = []
    if (tris) {
      for (let t = 0; t < tris.length; t += 3) {
        if (keepV[tris[t]] && keepV[tris[t + 1]] && keepV[tris[t + 2]]) keptTris.push(tris[t], tris[t + 1], tris[t + 2])
      }
    } else {
      for (let i = 0; i < si.count; i += 3) {
        if (keepV[i] && keepV[i + 1] && keepV[i + 2]) keptTris.push(i, i + 1, i + 2)
      }
    }
    const getter = ['getX', 'getY', 'getZ', 'getW']
    const geo = new THREE.BufferGeometry()
    geo.userData.ownedByRig = true // 重摆时可安全 dispose（cloneSkinned 的其余几何与模板共享，不可释放）
    for (const name of Object.keys(src.attributes)) {
      const attr = src.attributes[name]
      const n = attr.itemSize
      const dst = new Float32Array(keptTris.length * n)
      let j = 0
      for (const vi of keptTris) {
        for (let k = 0; k < n; k++) dst[j++] = attr[getter[k]](vi)
      }
      geo.setAttribute(name, new THREE.BufferAttribute(dst, n))
    }
    o.geometry = geo
  })
}

function placeArmsIK(sys, group, arms, tR, tL) {
  const root = cloneSkinned(arms)
  root.traverse(o => {
    if (o.isMesh) {
      o.frustumCulled = false
      if (/glove/i.test(o.material?.name || '')) o.visible = false // 只留袖/皮肤小臂
    }
  })
  stripHandVertices(root)
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
    // 早退也释放已过滤的新建几何（仅 owned 标记，模板共享资源不动）
    root.traverse(o => { if (o.isMesh && o.geometry?.userData?.ownedByRig) o.geometry.dispose() })
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
  // ---- 腕口封堵：战术护腕环 + 带端盖的袖口圆柱 ----
  // stripHandVertices 丢弃腕口边界三角形后皮肤管是敞开的，只靠细环遮不住透空
  // （侧视能看穿到手套腕口与袖口之间的缝）。袖口圆柱沿前臂轴从手套腕口内侧
  // 伸向小臂、半径大于两侧敞口边缘，端盖封死管腔 → 任何角度不透。
  // 环单独成网格用深灰手套材质（与 glove.glb 手套色统一，读作手套腕筒的延伸）；
  // 圆锥袖管+端盖用布料材质衔接袖子。2026-09-07
  const bandGeos = [], ringGeos = []
  const _m4 = new THREE.Matrix4(), _q2 = new THREE.Quaternion(), _s2 = new THREE.Vector3(1, 1, 1)
  const bandFor = (handBone, lowerBone) => {
    const hw = wp(handBone)
    const dir = wp(lowerBone).sub(hw).normalize() // 腕→肘侧（前臂来向）；取反会指向枪体插进握把/弹匣
    const center = hw.clone().addScaledVector(dir, 0.012) // 骑在手套腕口与袖口衔接缝上
    const ring = new THREE.TorusGeometry(0.015, 0.006, 10, 20)
    _q2.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)
    _m4.compose(center, _q2, _s2)
    ring.applyMatrix4(_m4).applyMatrix4(sys.vmHolder.matrixWorld.clone().invert())
    ringGeos.push(ring)
    // 封堵袖口：锥形管只往小臂方向延伸（腕侧绝不越过腕点伸向枪体——会插进
    // 握把/弹匣），腕端 1.6cm 收窄、肘端 2.1cm 加粗出拟人的腕→前臂过渡
    const cuffLen = 0.03
    const cuffCenter = hw.clone().addScaledVector(dir, 0.002 + cuffLen / 2)
    const cuff = new THREE.CylinderGeometry(0.021, 0.016, cuffLen, 16, 1, true)
    _q2.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    _m4.compose(cuffCenter, _q2, _s2)
    cuff.applyMatrix4(_m4).applyMatrix4(sys.vmHolder.matrixWorld.clone().invert())
    bandGeos.push(cuff)
    // 端盖（肘侧管口封死；腕侧由手套网格+护腕环遮盖）
    const cap = new THREE.CircleGeometry(0.021, 16)
    _q2.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)
    _m4.compose(cuffCenter.clone().addScaledVector(dir, cuffLen / 2), _q2, _s2)
    cap.applyMatrix4(_m4).applyMatrix4(sys.vmHolder.matrixWorld.clone().invert())
    bandGeos.push(cap)
  }
  bandFor(armR.hand, armR.low)
  bandFor(armL.hand, armL.low)
  // 释放重摆时需要两个网格都带 owned 标记（同 stripHandVertices 约定）
  const bandGeo = mergeGeometries(bandGeos, false)
  bandGeo.userData.ownedByRig = true // 同 stripHandVertices：本文件新建，可释放
  group.add(new THREE.Mesh(bandGeo, sys.armMats.sleeve))
  const ringGeo = mergeGeometries(ringGeos, false)
  ringGeo.userData.ownedByRig = true
  group.add(new THREE.Mesh(ringGeo, sys.armMats.glove))
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
// 各枪握姿参数（作者系坐标：x=枪管轴 -X 枪口、y 垂直、z 横向 +Z=射手左侧）。
// 双枪 GLB（vandal/phantom）几何不同 → 各自收敛一套；default 为旧单模型
// （Quaternius AK，作者系全长 ~1.46）2026-09-04 逐指优化值，留作回退基准。
// 新枪参数由页面内射线实测握点 + 坐标下降优化得出（方法见会话记忆）。
export const GLOVE_POSES = {
  default: {
    handR: {
      mirror: true,
      wrist: [0.043, 0.053, 0.034],
      fDes: [-0.52, -0.332, -1.005],
      sDes: [-0.058, 0.46, -0.579],
      curls: { pinky: [27, 88, 61, 20], ring: [24, 92, 70, 22], middle: [45, 82, 88, 24], index: [-11.6, 52, 54.6, 14], thumb: [-3.2, 15, 2, 5] },
    },
    handL: {
      // 腕锚 2026-09-08 重校：原值 [-0.51,-0.211,0.218] 为归一化管线前的旧
      // 坐标系（枪模装载时居中缩放后错位悬浮）。网格扫描取零穿插且贴近护木
      // 下方的落位；旧 curls/fDes 与新坐标系无法两全（y>-0.20 即嵌入），
      // legacy 单模型路径整体逐指重推不在合理投入范围，右手已正确贴把
      wrist: [-0.15, -0.24, 0],
      fDes: [1.194, 0.656, -0.36],
      sDes: [0.214, 0.728, 0.45],
      // curls 2026-09-08 legacy 路径三轴重推：归一化管线后旧逐指值坐标系失效
      // （四指尖距枪面 64-74mm 悬空），坐标下降收敛至 0-11mm
      curls: { pinky: [[-55, -35, 40], [-35, 0, 40], [-55, 0, 30], 2], ring: [[-55, 25, -40], [-55, -10, -40], [-55, 0, -20], 3], middle: [[-45, 0, 40], [-55, -15, -40], [-55, 0, -30], 4], index: [[25, -20, 15], [-55, -25, -40], [-45, 0, -40], 12], thumb: [[-25, 20, 0], [18, 40, 30], 40, [40, 0, -25]] },
    },
  },
  // 以下为双枪 GLB 实测推导值（2026-09-04，居中作者系；数据见会话记录：
  // vandal 12.1u/m、phantom 3.04u/m；fDes/sDes 为相机系掌向、跨枪可沿用，
  // 腕锚/curls 按各枪握把/护木/扳机实测位置推导，特写评审后微调）
  // vandal（2026-09-05 按枪模顶点切片轮廓重推：握把顶开口 x≈0.7/y≈0、
  // 前握把面下探至 (2.0,-0.65)、右侧面 z≈-0.2；护木 x -2.4..-1.2、底 y≈0.6、
  // 半宽 0.23。R 腕置握把顶右后、指绕前握把带；L 腕置护木底下、指前伸上卷包左侧）
  vandal: {
    handR: {
      mirror: true,
      // 腕锚 2026-09-07 程序化穿插检测修正：原 [1.7,0.1,-0.22] 腕口环 59 采样
      // 顶点浅插握把顶/机匣（最深 6mm，蒙皮顶点级射线奇偶检测复现）。holder 本地
      // +X 8mm（含 0.49 缩放即世界 3.9mm）恰好清零且四指贴把接触顶点数不变
      // （57/300）——换算后仅 z 分量变化
      wrist: [1.7, 0.1, -0.317],
      fDes: [-0.3, -0.88, -0.36],
      sDes: [0.2, 0.8, -0.55],
      // curls 2026-09-07 三轴坐标下降定稿：中/无名/小指尖残余 6-15mm 为该参数化
      // 下的局部最优（同日复扫：任何单关节 ±3~25° 扰动均无法再减小距离或直接
      // 入侵枪体）；15 射线度量是真实距离的上界，放大目检三指指腹贴合无可见缝隙
      curls: { pinky: [30, [115, -20, 0], [110, 0, 15], 18], ring: [30, [115, -20, 0], 110, 20], middle: [28, [100, -15, 10], 115, 22], index: [0, [90, 30, 30], [90, 0, 30], [45, 0, 30]], thumb: [-25, 15, 5, 5] },
    },
    handL: {
      wrist: [-1.35, 0.38, 0.0],
      fDes: [-0.2, -0.1, -0.97],
      sDes: [0.95, 0.25, -0.2],
      // curls 2026-09-07 指尖贴合坐标下降优化：四指远端加卷把指尖距护木面从
      // 6-9mm 收到 0-4mm（且指尖不入枪体）；拇指卷曲无法进一步贴合（39mm 悬空
      // 为指向问题，留待后续按瞄准向量处理）。同日二轮：中节 Y 轴微调（+20°贴面
      // 指向）把残余 1-4mm 收至 0
      curls: { pinky: [32, 79, [103, 0, -10], 18], ring: [30, 77, [103, 20, -6], 27], middle: [28, 73, [103, 20, 0], 43], index: [26, 62, [97, 20, 0], 36], thumb: [[20, 40, 40], [-8, 10, 0], -4, 0] },
    },
  },
  // phantom（2026-09-05 按该枪顶点切片重推：全长仅 2.4 作者单位，1u≈35cm。
  // 护木/消音管段 x -0.8..-0.4、管轴 y≈0.19、半径≈0.08；机匣 -0.2..0.6；
  // 握把下探至 (0.2..0.4,-0.27)、宽 ±0.06。R 腕置握把顶右后、L 腕托护木管下侧）
  phantom: {
    handR: {
      mirror: true,
      // 腕锚：保持原始值。第七十四轮曾按 vandal 同款 +8mm 让位（实际误写 10 倍
      // 80mm 致手浮空 42mm，本日复核修正并回退）——sFlinch 手组旋转负号修正后
      // 连发态真实穿插已为 0，无需让位，贴把接触（43 顶点）更优
      wrist: [0.42, 0.1, -0.09],
      fDes: [-0.3, -0.88, -0.36],
      sDes: [0.2, 0.8, -0.55],
      curls: { pinky: [30, [115, 25, 0], 110, 18], ring: [30, [135, 25, -20], 115, 20], middle: [28, [140, 15, 0], 115, 22], index: [0, [65, 0, 25], [80, 0, 15], [43, 0, 10]], thumb: [-45, [15, 0, 20], 5, 5] },
    },
    handL: {
      // 腕锚 2026-09-07 顶点级穿插检测修正：原 [-0.2,0.05,0.04] 腕口 4 采样顶点
      // 浅插护木管下缘，holder 本地 +X 8mm 清零且接触基本保持（34 vs 40/300）
      wrist: [-0.2, 0.05, 0.016],
      fDes: [-0.2, -0.1, -0.97],
      sDes: [0.95, 0.25, -0.2],
      // curls 2026-09-07 二轮：三轴坐标下降把四指尖距护木面 14mm 收至 0
      //（中节回卷 X-15~20° + Z 轴贴面指向 -20°，phantom 护木管径小需回卷）
      curls: { pinky: [42, [92, 20, 0], [75, 0, -20], [14, 0, -20]], ring: [40, 88, [80, 0, -20], 11], middle: [38, 83, [100, 0, -20], [2, 0, -10]], index: [36, 80, [100, 0, -20], 20], thumb: [[10, 40, 40], [2, 0, 0], -14, 0] },
    },
  },
}

export function poseGloveHands(sys, scene, arms, weaponId = sys.currentVmId) {
  const vm = sys.activeCustomVm(weaponId)
  if (!vm) return false
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
  // 旧手部资源释放：重摆是切枪级频率，stripHandVertices/护腕环每次都新建
  // BufferGeometry，只 remove 不 dispose 会持续泄漏显存。cloneSkinned 的几何/
  // 材质与 GLB 模板共享——只释放带 ownedByRig 标记的本文件新建几何
  if (sys.customHands) {
    sys.customHands.traverse(o => {
      if (o.isMesh && o.geometry?.userData?.ownedByRig) o.geometry.dispose()
    })
    sys.vmHolder.remove(sys.customHands)
  }
  const group = new THREE.Group()
  sys.customHands = group
  sys.vmHolder.add(group)
  if (sys.customArms) sys.customArms.visible = false
  sys.vmScene.updateMatrixWorld(true)
  const vmP = (x, y, z) => vm.localToWorld(new THREE.Vector3(x, y, z))
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
    // 其余递减出自然梯度；指根本地 X 卷曲不改变绑定 Z 向扇形展开角。
    // 数组值 [x,y,z] = 依次本地 rotateX/Y/Z（拇指对握需展开+卷曲多轴，2026-09-07）
    for (const [k, degs] of Object.entries(cfg.curls)) {
      const ch = F[k].map(b => bones[b.name])
      degs.forEach((deg, i) => {
        if (Array.isArray(deg)) {
          const [rx, ry, rz] = deg.map(d => THREE.MathUtils.degToRad(d || 0))
          if (rx) ch[i].rotateX(rx)
          if (ry) ch[i].rotateY(ry)
          if (rz) ch[i].rotateZ(rz)
        } else if (deg) ch[i].rotateX(THREE.MathUtils.degToRad(deg))
      })
    }
    sys.vmScene.updateMatrixWorld(true)
    // 动画基准存档：指骨本地四元数 + 根变换。WeaponSystem._animateHands 每帧
    // 先重置回这些基准再叠加（扳机扣动/握持收紧），动画与静态握姿解耦不漂移
    const fingers = {}, bases = {}
    for (const [k, chain] of Object.entries(F)) {
      fingers[k] = chain.map(b => bones[b.name])
      bases[k] = fingers[k].map(b => b.quaternion.clone())
    }
    return {
      root, wristBone: wristLocal, fingers, bases,
      basePos: root.position.clone(), baseQuat: root.quaternion.clone(),
    }
  }

  // ---- 按武器取握姿参数（作者系数组 → Vector3；腕锚经 vmP 进相机系）----
  // poseHand：右手（镜像）握把/掌压右面/四指阶梯卷曲、食指扣扳机、拇指 high-thumb；
  // 左手（原生）护木/掌从左下兜底/四指绕前缘、拇指沿左侧对握。目标点按各枪
  // 射线实测表面内推 1cm 设定（指尖骨+节段延伸比 mesh 指尖长 ~1cm → 误差≈0 实贴）
  // 旧版单模型回退（viewmodel.glb 双 id 共享，装载时克隆导致实例不同——
  // 由 WeaponSystem.setCustomViewmodel 置 _sharedCustomVm 标记）。各武器 id 的
  // 握姿锚点是为双枪 GLB 作者系逐枪调校的，用在单模型上单位错配（实测手浮空
  // >99m），共享时强制走 default（Quarnius AK 实测握姿）
  const pose = sys._sharedCustomVm ? GLOVE_POSES.default : (GLOVE_POSES[weaponId] ?? GLOVE_POSES.default)
  const toV3 = (a) => new THREE.Vector3(a[0], a[1], a[2])
  const handR = poseHand({
    mirror: pose.handR.mirror,
    wrist: vmP(...pose.handR.wrist),
    fDes: toV3(pose.handR.fDes),
    sDes: toV3(pose.handR.sDes),
    curls: pose.handR.curls,
  })
  const handL = poseHand({
    mirror: pose.handL.mirror,
    wrist: vmP(...pose.handL.wrist),
    fDes: toV3(pose.handL.fDes),
    sDes: toV3(pose.handL.sDes),
    curls: pose.handL.curls,
  })

  // ---- 真人手臂（hands.glb 建模袖臂：Shirt 袖 + Skin 皮肤小臂；Glove 手网格
  // 隐藏 —— 手由上面的高细节五指手套提供）。落位 = placeArmsIK：解剖学定尺 +
  // 肩位自由放置 + 两骨 IK 精确够到双腕（手套腕骨），弯向同 2026-09-03 方案 ----
  if (arms) placeArmsIK(sys, group, arms, wp(handR.wristBone), wp(handL.wristBone))

  // 手部动画基准注入（_animateHands：扳机指/握持收紧/滞后回弹）。
  // group 级回弹会带动袖臂+腕带整体 → 手与袖口不会脱节
  sys.handsAnim = { right: handR, left: handL, group }
  sys._handsPoseFor = weaponId
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
// 握姿表（2026-09-07）：default 六点为旧单模型（Quaternius AK）2026-09-04 实测值；
// vandal/phantom 由单位换算（旧模型 1u≈0.625m；vandal 12.1u/m、phantom 3.04u/m，
// 腕锚对齐 GLOVE_POSES 同名枪的腕锚）+ 页内穿插扫描校正——回退路径（glove.glb
// 缺失）此前用 default 点在 vandal 上指尖深插握把（43 视口内穿插顶点）。
export const ARMS_POSES = {
  default: {
    wristR: [-0.02, -0.055, -0.045], wristL: [-0.42, -0.27, 0.03],
    aimR: { dbl: [-0.16, -0.075, -0.055], idx: [-0.17, -0.045, -0.03], thb: [0.03, 0, -0.05] },
    aimL: { dbl: [-0.53, -0.08, -0.08], idx: [-0.55, -0.05, -0.085], thb: [-0.57, -0.02, 0.085] },
  },
  vandal: {
    wristR: [1.7, 0.1, -0.32], wristL: [-1.5, 0.15, 0.2],
    aimR: { dbl: [0.64, -0.05, -0.30], idx: [0.57, 0.18, -0.11], thb: [2.08, 0.52, -0.18] },
    aimL: { dbl: [-2.18, 1.8, -0.83], idx: [-2.33, 2.0, -1.0], thb: [-2.48, 2.15, 0.48] },
  },
  phantom: {
    wristR: [0.42, 0.1, -0.09], wristL: [-0.2, 0.05, 0.04],
    aimR: { dbl: [0.16, -0.05, -0.13], idx: [0.14, 0.15, -0.06], thb: [0.52, 0.37, -0.09] },
    aimL: { dbl: [-0.55, 0.85, -0.36], idx: [-0.59, 0.94, -0.43], thb: [-0.63, 1.02, 0.27] },
  },
}

export function poseCustomHands(sys, hands, weaponId = sys.currentVmId) {
  const vm = sys.activeCustomVm()
  if (!vm) return false // 无自有枪模时握点无法推导，直接回退内置手臂
  sys.handsAnim = null // 本路径无逐指动画基准（四指合并骨架），禁用 _animateHands
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
  // vmP 坐标系 = 枪模本地系：(x=枪管轴向, y=垂直, z=横向)。自有枪模自带 -90°Y 旋转，
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
  const vmP = (x, y, z) => vm.localToWorld(new THREE.Vector3(x, y, z))
  // 腕锚点（枪模本地系）：右手在握把右后下方（掌压握把右面）、左手在弹匣交界
  // 后下方（掌托护木底、指朝前上绕护木前缘 → C 型托握）；横向 z 取负 = 相机右侧
  const P = (sys._sharedCustomVm ? ARMS_POSES.default : (ARMS_POSES[weaponId] ?? ARMS_POSES.default))
  // 共享单枪模（_sharedCustomVm，见 setCustomViewmodel）时各枪腕锚作者系单位
  // 错配（实测臂离枪 65mm），走 default 旧 AK 实测六点
  const wristR = vmP(...P.wristR)
  const wristL = vmP(...P.wristL)
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
  // 指尖瞄准点（枪模本地系，per-weapon 表）：R 四指绕握把前缘 / 食指沿扳机护圈 /
  // 拇指压握把后脊；L 四指卷向护木右前侧面 / 拇指沿护木左侧上提对握。
  // 非 default 枪（几何与旧 AK 不同、无法沿用六点）→ 从腕锚沿特征方向对枪模
  // 射线求面，命中点沿射线回退 1.2cm（指尖网格比链末骨长 ~1cm → 实贴表面）；
  // 未命中（如方向打到画外）回退表值。2026-09-07
  const gunMeshes = []
  vm.traverse(o => { if (o.isMesh) gunMeshes.push(o) })
  const _ray = new THREE.Raycaster()
  const autoAim = (wristWorld, camDir, fallback, pullback = 0.012) => {
    if (!gunMeshes.length) return vmP(...fallback)
    const dir = camDir.clone().normalize()
    _ray.set(wristWorld, dir)
    _ray.far = 0.6
    const hit = _ray.intersectObjects(gunMeshes, false)[0]
    if (!hit) return vmP(...fallback)
    return hit.point.clone().addScaledVector(dir, -pullback)
  }
  // 方向为相机系实测：vandal/phantom 的腕锚在握把/护木下方，枪面在腕上方
  const R_DBL = new THREE.Vector3(-0.6, 0.75, -0.3), R_IDX = new THREE.Vector3(-0.5, 0.65, -0.6)
  const R_THB = new THREE.Vector3(0.5, 0.6, -0.3), L_DBL = new THREE.Vector3(0, 0.95, -0.3)
  const L_IDX = new THREE.Vector3(0.15, 0.9, -0.4), L_THB = new THREE.Vector3(0.2, 0.9, 0.3)
  // 食指多退 1cm：扣扳机姿态下指尖卷进扳机护圈/机匣（IndexR001 8 顶点实测）。
  // 共享单枪模（_sharedCustomVm）时 default 六点也是归一化前旧坐标系（实测指尖
  // 嵌入 8 视口顶点）→ 腕锚取 default 表、瞄准点仍走自动射线推导（2026-09-08）
  const useTableAim = weaponId === 'default' && !sys._sharedCustomVm
  const aimR = useTableAim
    ? { dbl: vmP(...P.aimR.dbl), idx: vmP(...P.aimR.idx), thb: vmP(...P.aimR.thb) }
    : { dbl: autoAim(wristR, R_DBL, P.aimR.dbl), idx: autoAim(wristR, R_IDX, P.aimR.idx, 0.022), thb: autoAim(wristR, R_THB, P.aimR.thb) }
  const aimL = useTableAim
    ? { dbl: vmP(...P.aimL.dbl), idx: vmP(...P.aimL.idx), thb: vmP(...P.aimL.thb) }
    : { dbl: autoAim(wristL, L_DBL, P.aimL.dbl), idx: autoAim(wristL, L_IDX, P.aimL.idx, 0.02), thb: autoAim(wristL, L_THB, P.aimL.thb) }
  aimFinger(F.R.dbl, armR.hand, aimR.dbl, [28, 46, 40])
  aimFinger(F.R.idx, armR.hand, aimR.idx, [8, 14, 12])
  aimFinger(F.R.thb, armR.hand, aimR.thb, [8, 12, 0])
  aimFinger(F.L.dbl, armL.hand, aimL.dbl, [30, 50, 44])
  aimFinger(F.L.idx, armL.hand, aimL.idx, [26, 43, 37])
  aimFinger(F.L.thb, armL.hand, aimL.thb, [10, 10, 4])

  hands.traverse(o => { if (o.isMesh) o.frustumCulled = false }) // 蒙皮包围盒不随骨骼更新
  sys.weaponMeshFor(sys.currentVmId)
}
