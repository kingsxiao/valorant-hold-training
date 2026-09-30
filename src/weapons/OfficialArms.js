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
// —— 终态参数速览（2026-10-01 持续穿模收敛后，详 DEPLOY 十~十八轮附录）：
//   锚：ARMS_ANCHORS 按 L* 流形（|handL−handR|=实际落腕跨度）标定，双腕真实
//       零误差（审计 0.006/0.0045mm）；滚转：数据解（__ARMS_ROLL 仅加性缝）；
//   网格：ARMS_DEPENETRATE 静止位偏移表（蒙皮线性映射，attach 按枪克隆施加）——
//       十轮仅存 vandal 表（0/0 守住）；phantom 表已回退（7~10mm 世界级拇指尖
//       拉伸=评审尖刺伪影源头）；
//   指姿：ARMS_GRIP_PATCH 握姿润饰（九~十一轮包握/收拢 + 十四轮 vandal 拇指
//       落位 + 十六轮指列收敛 Index Y42/Ring Y40 + 十七轮 Thumb2 X15 钩持与
//       Twist2 +8 袖口合缝；十三轮 L_Hand 滚转与十二轮 Twist2+45 经评审证实
//       致扭已回退）。终态审计：vandal 3/0/75/0、phantom 10/0/38/0（嵌枪/可见
//       /相交/可见），指尖 0.52/1.52mm、腕锚 0.006/0.0045mm、手尺 8.2cm；
//       手尺定尺不变。
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

// 官方手臂专用腕锚（GLOVE_POSES 系标定，2026-09-15 四轮收敛；2026-10-01 六轮在
// 五轮终态拟合基（枪本地两点拟合 + 数据解滚转）下重扫——四轮锚是为旧三点拟合基
// 调的，换基后从未重扫）：
//   - 可达流形：两点拟合把右腕精确钉锚、左腕落在 dstR + spanDir×(|srcSpan|·sLocal)
//     ——左锚只在 |handL−handR| = L*（实际落腕跨度）时可达；旧锚对半径与 L* 差
//     6.2/20.9 本地 mm（左腕从未真正落锚——旧「腕锚误差恒 0」读数是审计脚本
//     漏 ×1000 的米标毫米假象，脚本已修）。新锚对按 L* 球面投影 → 双腕真实
//     零误差（审计口径 0.006/0.005mm）。
//   - 结果（45mm 带内奇偶、世界系、十指尖悬停距离双目标坐标下降，右手握把
//     接触守恒——phantom handR 锁基线）：vandal 34→27 / phantom 49→9，均零
//     可见；指尖最小贴枪 1.38→0.52 / 2.40→1.52mm（更贴不悬空）；手尺 8.2cm
//     不变形；滚转仍由数据解出零手调。扫描方法与坑位见 DEPLOY.md 六轮附录）
export const ARMS_ANCHORS = {
  vandal: { handR: [0.24, -0.018, -0.109], handL: [-0.2525, 0.0174, -0.0019] },
  phantom: { handR: [0.237, -0.0495, -0.097], handL: [-0.2299, -0.0071, -0.0114] },
}

// 等价手尺寸（相机系米）：官方手的腕→中指尖骨链缩放到此值 = glove 路径的
// 手大小（8.2cm 标定，枪 0.85m×holder ~0.49 的取景下真手 19cm×同比例）。
// 腕锚为这个尺寸调校——官方手臂必须同尺寸落位，否则皮肉嵌枪
const OFFICIAL_HAND_EQUIV = 0.082

// 滚转修正：不手调——由官方 pose 的 Camera 骨方向 + 我们 rest 取景常数在枪
// 本地系对齐解出（见 attachOfficialArms 拟合段）。手调常数曾两轮换基即废
// （世界系→holder 系→枪本地系），数据解与基无关。globalThis.__ARMS_ROLL
// 仅作页内加性微调缝（vhtdbg 扫描用）

// 网格级去穿透（第 2 轮/七轮）：动骨（六轮锚重扫）到界后剩余嵌枪肉点（vandal
// 27 / phantom 9）的终解。推出向量按蒙皮线性（s(p+Δ)=s(p)+B_lin·Δ）映射进静止
// 位姿——骨系零改动，腕锚/手尺/肘位天然不变，fire/equip 姿态下偏移随骨走。
// 偏移表由 scripts/arms-depenetrate-bake.mjs 在当前锚/拟合常量下烘焙（45mm 带
// +X 奇偶迭代推出 + 顽固组试逃）——锚再调需重烘焙。
// 十轮教训（2026-10-01）：推距必须以世界 mm 记账（B_lin 实测，rest≈世界 ×5.8），
// 「rest 数值≈亚毫米世界」是记账坑——phantom 表的 7~10mm 世界级拇指尖推拉被
// 评审读作「撕裂/尖刺」后整体回退（见上）；保留本层的枪必须过截图评审关。
// cloneSkinned 共享模板 geometry → 按枪克隆一份施加（_depenetratedGeo 缓存，
// 首次 attach 一次性付清，切枪重挂零开销）
export const ARMS_DEPENETRATE = {
  vandal: {
    FP_Phoenix_S0_Skelmesh001: [
      [1678, -0.011779, -0.014102, -0.005313], [1679, -0.008281, -0.01001, -0.003758],
      [1680, -0.001999, 0.005172, -0.007374], [1688, 0.005541, 0.002478, -0.012875],
      [1740, -0.01314, 0.003882, 0.007828], [1742, -0.02068, 0.006213, 0.01114],
      [1743, -0.007632, -0.014159, -0.005059], [1744, 0.031711, -0.00931, -0.018818],
      [1745, -0.003612, -0.006718, -0.002215], [1746, 0.024406, -0.007496, -0.015468],
      [1747, 0.021063, -0.006794, -0.014353], [1748, -0.007558, -0.013729, -0.003872],
      [1749, 0.007283, -0.002236, -0.004674], [1750, 0.005451, -0.001977, -0.004064],
      [1753, 0.012602, -0.0037, -0.007478], [1762, 0.01045, -0.006223, -0.000279],
      [1764, -0.005877, -0.008544, 0.000671], [1804, 0.011671, -0.003381, -0.00633],
      [1807, 0.029437, -0.008642, -0.015901], [1866, 0.014252, -0.007595, -0.008845],
      [1869, 0.00876, 0.002675, 0.000514], [1870, -0.003403, -8.8e-05, 0.005507],
      [1872, -0.011409, -0.012265, -0.006923], [3698, -0.028986, 0.010811, -0.003428],
      [3711, -0.003465, -0.005478, 0.002727], [3932, -0.014241, -0.007803, 0.005701],
      [1873, -0.013327, -0.016109, -0.006048],
    ],
  },
  phantom: {
    // 十轮回退（2026-10-01）：评审证实的「网格撕裂/尖刺」伪影源头即本表——
    // 页内取证（scripts/arms-diag.mjs）实测 6579/6584/6588/6595（L_Thumb2/3 拇
    // 指尖簇）世界位移 7.3/7.8/8.1/9.8mm、3929（L_Hand 掌跟）4.5mm——七轮附录
    // 「亚毫米世界推距」系把 rest 单位误当世界 mm 的记账错误（本单位坑的复刻）。
    // 拇指尖高曲率轮廓区局部 4 顶点 8~10mm 拉伸=肉眼可见尖刺；页内对照（S3 变体）
    // 撤表后拇指尖平滑、无可见互陷。代价：隐藏嵌枪 30→32、相交臂三角 27→36
    //（双可见口径 0/0 不变；指尖/腕锚/手尺分毫不差）。vandal 表不回退（评审 9 分
    // 通过、审计 0/0；其顶点均在遮挡面低曲率区）。
    FP_Phoenix_S0_Skelmesh001: [],
  },
}
const _depenetratedGeo = new Map()
// 握持润饰补丁（八轮起；十一轮扩近节/小指，十二轮扩前臂拧转骨，十四轮扩
// vandal 左拇指基节）：官方 idle 指姿 × 我们枪体前段尺寸的错配校正——phantom
// 左拇指横跨枪管、指尖过导轨、指列扇形不包握、袖扣带拧麻花呈现，vandal 左
// 拇指悬空。final = base ⊗ delta（骨本地小旋转），只动指骨/前臂拧转骨；
// 调参经 globalThis.__GRIP_PATCH 覆盖缝（页内迭代，scripts/grip-wrap-tune.mjs
// / cuff-roll-tune.mjs / vandal-thumb-tune.mjs），收敛值固化于此表。
export const ARMS_GRIP_PATCH = {
  vandal: {
    // 左三指中节 +本地X 40°：指尖过导轨上缘（评审【穿模】）→ 收拢到护木后侧
    L_Index2: [0.34202, 0, 0, 0.93969],
    L_Middle2: [0.34202, 0, 0, 0.93969],
    L_Ring2: [0.34202, 0, 0, 0.93969],
    // 左拇指基节 +本地Z −25°（十四轮）：官方 idle 拇指在我们护木尺寸下悬空
    // 16mm（评审【光滑钩状悬空不接触护木】）——基节绕 Z 收拢使指尖贴护木侧
    // 1.6mm（接触不穿；扫描 out/vandal-thumb-tune：−20 → 4.1mm、−25 → 1.6mm
    // 隐藏嵌枪 3、−30 起穿透劣化 23/104）。轴探测：±X/±Y 均不朝向护木。
    L_Thumb1: [0, 0, -0.21644, 0.976296],
  },
  phantom: {
    // 左三指近节 +本地Y（十一轮 +Y35 整指包握；十六轮收敛定稿：Index +Y42 /
    // Middle +Y35 / Ring +Y40）——均匀 +Y35 时指团间隙透出背景与金戒指（评审
    // 【指间大缝隙】【黄色碎片】），差异化收拢使指团互贴、戒指藏到中指团后
    // （露边大幅缩小，全消需模型层）。轴物理：近节绕 Y=整指摆向近侧；
    // 本骨架骨长轴=局部 X（零偏移骨架——*2 旋转不动 *3 节点，绕 X=拧转），
    // *1 绕 Y+ 才把整列往「屏幕下方+近侧」摆=包握向；+X 实测反向（张开）。
    L_Index1: [0, 0.358368, 0, 0.93358],
    L_Middle1: [0, 0.300706, 0, 0.953717],
    L_Ring1: [0, 0.34202, 0, 0.939693],
    // 左三指中节 +本地X 75°（九轮，保留）：扇形竖指带背景缝 → 整排包覆枪体
    L_Index2: [0.608761, 0, 0, 0.793353],
    L_Middle2: [0.608761, 0, 0, 0.793353],
    L_Ring2: [0.608761, 0, 0, 0.793353],
    // 左小指收拢（十一轮）：+本地Y 20° 摆近 + 中节 +本地X 55° 卷指——小指不再
    // 向后外翘拖出扇形尾巴
    L_Pinky1: [0, 0.173648, 0, 0.984808],
    L_Pinky2: [0.461749, 0, 0, 0.887011],
    // 左拇指中节 +本地X 15°（十七轮，替换九轮 Y25）：九轮 Y25 沉拇指后它呈
    // 「细长僵直伸向枪口悬空」（评审）——X15 卷曲使拇指尖钩向护木底、贴合持
    // 观感且脱离护木顶压持带（隐藏嵌枪 32→10，扫描 scripts/grip-deepen-tune
    // 20/21 候选）；末节 +本地Y 15°（九轮，保留）
    L_Thumb2: [0.382683, 0, 0, 0.92388],
    L_Thumb3: [0, 0.130526, 0, 0.991445],
    // 左前臂拧转骨 +本地X 8°（十七轮）：掌跟与袖口间透缝（评审【断裂镂空】）
    // ——微正角把袖口向掌侧收，透缝显著变窄；+15 起环折初现（十五轮漏斗教训），
    // 全闭合需模型层，透缝变窄为姿势层上限
    L_Twist2: [0.069756, 0, 0, 0.997564],
    // 十五回退（2026-10-01）：L_Hand +X−20°（十三轮）与 L_Twist2 +X45°（十二轮）
    // 整体摘除——五轮视觉评审证实两者为「压数字换扭曲」：hx−20 造成腕部反向
    // 弯折、掌反搭枪顶观感与拇指蹼皮肤拉伸薄膜；twist+45 把袖扣带卷成环带
    // 镂空漏斗（中心透出腕部皮肤）。回退后袖口为平滑袖管、腕线自然；隐藏嵌枪
    // 4→32、相交 31→36 为如实代价（可见口径 0/0 不变）。十七轮在回退基线上
    // 只保留微调量（twist+8、拇指 X15），不复活漏斗/反折。
  },
}
function applyArmsDepenetration(root, weaponId) {
  const table = ARMS_DEPENETRATE[weaponId]
  if (!table) return
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !table[o.name]) return
    const key = weaponId + '/' + o.name
    let geo = _depenetratedGeo.get(key)
    if (!geo) {
      geo = o.geometry.clone()
      const pos = geo.attributes.position
      for (const [i, dx, dy, dz] of table[o.name]) {
        pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz)
      }
      _depenetratedGeo.set(key, geo)
    }
    o.geometry = geo
  })
}

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
  applyArmsDepenetration(root, weaponId) // 网格级去穿透（七轮，静态偏移表）
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
// 模块级 scratch：104 骨 × 开火/切枪窗口每帧曾分配 1 个 tmp + 逐骨克隆乘积~
// 100+/帧（每秒 6000+ 短命 Quaternion）——管线是「算完立即 copy 进 node」的
// 纯重算，scratch 跨骨/跨帧覆盖安全，128Hz 热路径零分配
const _poseQ = new THREE.Quaternion() // base 姿势（slerp 目标）
const _finalQ = new THREE.Quaternion() // final = base ⊗ fireD（替代逐骨克隆乘积）
const _patchQ = new THREE.Quaternion() // 握持润饰补丁（八轮，见 ARMS_GRIP_PATCH）
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
  // 握持润饰补丁（八轮）：官方 idle 的拇指/指姿在我们的枪体前段尺寸下会横跨
  // 枪管/指尖过轨——按骨名叠加本地小旋转（final = base ⊗ patch）。只动指骨
  // （L_Thumb*/L_Index*/L_Middle*/L_Ring*/L_Pinky*），腕/臂锚与手定尺不变。
  // 常量表 + globalThis.__GRIP_PATCH 覆盖缝（页内调参用，同 __ARMS_ANCHORS 模式）
  const patch = (typeof globalThis !== 'undefined' && globalThis.__GRIP_PATCH) || ARMS_GRIP_PATCH
  const patchQ = patch && patch[sys.currentVmId]
  for (const b of A.bones) {
    let q
    if (eqU < 1 && b.equip) q = sampleQuatTrack(b.equip, eqU * A.equipDur) // = _sampleQ
    else if (adsK > 0 && b.ads) q = _poseQ.slerpQuaternions(b.idle, b.ads, adsK)
    else q = b.idle
    // copy 必须先于 multiply 的参数求值：q 可能是 _sampleQ（equip 路径），而
    // sampleQuatTrack(fireD) 会覆盖 _sampleQ——先落 _finalQ 再采样再乘
    if (fT >= 0 && b.fireD) q = _finalQ.copy(q).multiply(sampleQuatTrack(b.fireD, fT))
    if (patchQ) {
      const pq = patchQ[b.node.name]
      if (pq) q = _finalQ.copy(q).multiply(_patchQ.set(pq[0], pq[1], pq[2], pq[3]))
    }
    b.node.quaternion.copy(q)
  }
}
