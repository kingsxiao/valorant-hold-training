import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { applyAgentTextures, applyViewmodelTextures, applyHandsTextures } from '../world/ModelTexturing.js'
import { buildLocomotion } from './Locomotion.js'
import { SKINS } from '../weapons/skinMap.js'

// 手指修长化：J-Toastie 手为卡通比例（指节粗短）。该骨架指骨沿本地 +Y 延伸，
// 平移 y 分量拉伸 12% 改善长宽比；Wrist/Hand 不动（手掌宽度不变）。
// setGloveHands 以实测腕→中指尖长度定总长 → 总长恒定，仅手指比例变修长。
function elongateFingers(root, k = 1.12) {
  root.traverse(o => {
    if (o.isBone && /^(Lower|Middle|Top)/.test(o.name)) o.position.y *= k
  })
}

// 手部蒙皮网格平滑：源模型常为非索引几何（逐三角面独立顶点/法线 → 渲染呈棱面
// "晶体感"，机械感的主要来源）。先删法线再按位置焊接顶点（蒙皮 JOINTS/WEIGHTS
// 与 UV 作为合并键一同对齐，不影响绑定），最后重算平滑法线 → 同面数下观感
// 从低模棱面变为雕塑曲面。UV 缝处顶点因 UV 不同不合并，留有极细微法线接缝。
function smoothSkinGeometry(root) {
  root.traverse(o => {
    if (!o.isSkinnedMesh) return
    const geo = o.geometry
    if (!geo.index) {
      geo.deleteAttribute('normal')
      o.geometry = mergeVertices(geo, 1e-4)
      o.geometry.computeVertexNormals()
    }
  })
}

// 模型自带任意贴图（map）即视为真实 PBR 材质，原生材质直接保留；
// 白模才走程序化贴图（agent/viewmodel 共用，含 requestSkin 的按需皮肤）
function hasRealTextures(root) {
  let any = false
  root.traverse(o => {
    const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])
    if (ms.some(m => m.map)) any = true
  })
  return any
}

// 枪模归一化（关键批/后台批/requestSkin 共用）：最长水平轴对齐到 Z（枪管向），
// 随后按包围盒尺寸归一到 0.85m（90° 水平旋转只交换 x/z，最大边不变 → 缩放用
// 旋转前的 size 即可）。自带贴图的模型（Objaverse 系 AK）原生 PBR 材质直接
// 保留；白模才走程序化贴图
function normalizeViewmodel(vm) {
  vm.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(vm).getSize(new THREE.Vector3())
  if (size.x > size.z) vm.rotation.y = -Math.PI / 2
  vm.scale.multiplyScalar(0.85 / Math.max(0.001, Math.max(size.x, size.y, size.z)))
  vm.updateMatrixWorld(true)
  const c = new THREE.Box3().setFromObject(vm).getCenter(new THREE.Vector3())
  vm.position.x -= c.x
  vm.position.y -= c.y
  vm.position.z -= c.z
  return vm
}

// 归一化 + 白模补程序化贴图后写入 out.viewmodels[key]（三个加载入口共用的
// 落库口径：requestSkin 到货的皮肤键与两批资产完全同构，main 增量接线无特判）
function addViewmodel(out, key, gltf) {
  if (!gltf?.scene) return
  const vm = normalizeViewmodel(gltf.scene)
  if (!hasRealTextures(vm)) applyViewmodelTextures(vm) // 白模才盒式投影 + 程序化材质
  out.viewmodels[key] = vm
}

// 用户/开源模型加载（分两批，见 loadUserAssets）：
//   public/models/agent-{jett,phoenix,sage,sova}.glb → 无畏契约英雄池（每 bot 随机一名，
//                                          UE 风格骨架 + 内嵌 PBR 贴图 + kamae 持枪待机 clip；
//                                          走/跑/横移优先官方 .psa 曲线（locomotion.json），
//                                          缺数据才由 core/GaitBake 步态数学现场烘焙）
//                                          ——唯一模板来源（166 轮起去掉 agent.glb 单模板
//                                          回退：英雄池随仓库分发永不缺位，缺位的兜底是
//                                          Bot 内置程序化假人，无需再下载 1.5MB 死重）
//   public/models/viewmodel-vandal.glb   → Vandal 第一人称枪模（"AK-47 Kalashnikov" by
//                                          Mateusz Woliński, Sketchfab, CC-BY 4.0；真实 PBR 贴图，
//                                          原生材质直接保留；作者系枪管沿 -X，与管线约定一致）
//   public/models/viewmodel-phantom.glb  → Phantom 第一人称枪模（"AK 47 Tactical Upgrade" by
//                                          Mateusz Woliński, Sketchfab, CC-BY 4.0；带消音器/导轨，
//                                          含 bolt carrier / magazine / suppressor 独立网格）
//   public/models/viewmodel-vandal-aristocrat.glb → Vandal 官方皮肤（Aristocrat 收藏集，
//                                          内部代号 ArtDeco；Rocklan 包 .blend 转换，镀金 + RedDot 瞄具）。
//                                          不随两批分发——requestSkin 点选/启动补拉才下载
//                                          （默认皮肤 chaos 的用户用不到，按需省 1.9MB 传输 + 34.5MB VRAM）
//   public/models/viewmodel-vandal-chaos.glb → Vandal 皮肤（混沌序曲 Prelude to Chaos；
//                                          仓库不带模型，投放即换模；缺位时皮肤=本体枪模+
//                                          rifle_chaos 音效/CHAOS_FX 枪口包；投放位探测走
//                                          requestSkin（404 一次即负缓存，不重复失败请求））
//   public/models/glove.glb              → 第一人称高精度手套（当前内置：J-Toastie "Gloved Hand"，CC-BY 3.0，
//                                          五指独立三关节骨骼；WeaponSystem 双实例化 + 五指 IK 持枪）
//   public/models/hands.glb              → 第一人称手臂（当前内置：J-Toastie "Rigged FPS Arms"，CC-BY 3.0；
//                                          glove 主路径的袖臂建模取自此模型（placeArmsIK 衔接
//                                          手套腕口），glove 缺位时才整体回退）
//   public/models/arms-official.glb      → 官方 1P 手臂（Phoenix，Rocklan 官方包转换；104 骨官方
//                                          1P 骨架 + 官方 DF/MRAE/NM 贴图；动画轨道 = 官方
//                                          FP_Core_{AK,Carbine}_S0_IdlePose 持枪姿势，见
//                                          scripts/fp-arms-export.py）。主路径；缺失/装配失败
//                                          回退 glove/hands 开源件
// 文件缺失时静默跳过，回退到内置程序化模型。
//
// 加载分两批（时间到可玩优先）：
//   关键批（await）：首位英雄 + vandal + glove/hands + locomotion.json——开局最小集，
//     全部走 index.html 的 preload，模块脚本一下来就并行拉取
//   后台批（不阻塞）：其余英雄 + phantom + 官方手臂——到货后 push 进同一 out 对象
//     （agents 数组/viewmodels 映射是同一实例，main 持有的引用天然看到增量），
//     再回调 onLate(out) 让 main 增量接线枪模
//   皮肤 GLB 不在两批里（P3 起按需）：requestSkin 点选/启动补拉触发，到货走
//     onSkinArrival —— main 的第三条到货线，与两批共用 wireViewmodels/prewarm
export async function loadUserAssets(onLate = null) {
  const out = { agents: [], viewmodels: {}, hands: null, glove: null, fpArms: null }
  const loader = new GLTFLoader()
  const tryLoad = (file) => new Promise((res) => {
    loader.load(
      new URL(`models/${file}`, document.baseURI).href,
      (gltf) => res(gltf),
      undefined,
      () => res(null),
    )
  })
  // 无畏契约英雄池：命中即整体取代 agent.glb 单模板（main.js 注入 Bot.customTemplates）
  const AGENT_POOL = ['agent-jett.glb', 'agent-phoenix.glb', 'agent-sage.glb', 'agent-sova.glb']

  // 官方 .psa 走/跑/横移曲线（scripts/psa2clips.mjs 从 Rocklan 官方动画转出）：
  // 每英雄按 GLB 骨名后缀解析成 AnimationClip——有官方数据就直接播官方骨骼曲线，
  // 没有才退回 GaitBake 的步态数学烘焙。关键批与后台批共用一次拉取
  let locoJson = null
  const loadLoco = fetch(new URL('models/locomotion.json', document.baseURI).href)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)

  const [firstAgentGltf, vandalGltf, handsGltf, gloveGltf, loco] = await Promise.all([
    tryLoad(AGENT_POOL[0]), tryLoad('viewmodel-vandal.glb'),
    tryLoad('hands.glb'), tryLoad('glove.glb'),
    loadLoco,
  ])
  locoJson = loco

  // agent 归一化：匿名节点命名/轨道引用重写（BrainStem 类模型）→ 缩放 1.8m →
  // 居中贴地 → 白模补程序化贴图（自带 PBR 贴图的英雄 GLB 原生材质直接保留）
  const normalizeAgent = (gltf) => {
    const agent = gltf.scene
    // BrainStem 类模型的节点大多无名字，动画轨道以"原始 UUID"引用节点；
    // SkeletonUtils.clone 会生成新 UUID → 先给匿名节点起稳定名并重写轨道引用，动画才能绑定
    const uuidToName = new Map()
    let anon = 0
    agent.traverse(o => {
      if (!o.name) {
        const n = 'anon_' + anon++
        o.name = n
        uuidToName.set(o.uuid, n)
      }
    })
    const animations = gltf.animations ?? []
    for (const clip of animations) {
      for (const track of clip.tracks) {
        const dot = track.name.indexOf('.')
        if (dot <= 0) continue
        const nodeName = track.name.slice(0, dot)
        const newName = uuidToName.get(nodeName)
        if (newName) track.name = newName + track.name.slice(dot)
      }
    }
    agent.updateMatrixWorld(true)
    let box = new THREE.Box3().setFromObject(agent)
    const s = 1.8 / Math.max(0.001, box.max.y - box.min.y)
    agent.scale.multiplyScalar(s)
    agent.updateMatrixWorld(true)
    box = new THREE.Box3().setFromObject(agent)
    const c = box.getCenter(new THREE.Vector3())
    agent.position.x -= c.x
    agent.position.z -= c.z
    agent.position.y -= box.min.y
    if (!hasRealTextures(agent)) applyAgentTextures(agent) // GLB 白模 → 程序化装甲/关节贴图
    return { root: agent, clips: animations }
  }
  const addAgent = (gltf, i) => {
    if (!gltf?.scene) return
    const entry = normalizeAgent(gltf)
    entry.hero = AGENT_POOL[i].replace(/^agent-/, '').replace(/\.glb$/, '')
    if (locoJson) entry.locomotion = buildLocomotion(locoJson, entry.hero, entry.root)
    out.agents.push(entry) // 同一数组实例：main 的 Bot.customTemplates 引用不变，即推即生效
  }
  addAgent(firstAgentGltf, 0)

  // 枪模归一化/落库已提为模块级共用件（addViewmodel），requestSkin 同口径
  addViewmodel(out, 'vandal', vandalGltf)

  // 手臂：原始场景原样返回，对位/缩放在 WeaponSystem.setCustomHands 里按骨骼位置计算
  if (handsGltf?.scene) {
    applyHandsTextures(handsGltf.scene) // 袖/肤/手套 → 布料/皮肤贴图
    smoothSkinGeometry(handsGltf.scene) // 非索引蒙皮网格 → 焊接+平滑法线（消棱面）
    out.hands = handsGltf.scene
  }
  // 高精度手套：同样原样返回（WeaponSystem.setGloveHands 双实例化 + 五指 IK）
  if (gloveGltf?.scene) {
    applyHandsTextures(gloveGltf.scene)
    smoothSkinGeometry(gloveGltf.scene)
    elongateFingers(gloveGltf.scene, 1.12)
    out.glove = gloveGltf.scene
  }

  // 后台批（不阻塞开局）：其余英雄 + phantom + 官方手臂。全部到货后并入同一 out
  // 并回调 onLate——main 只增量接线新到的枪模键（已接过的重跑 setCustomViewmodel
  // 会二次包裹枪体）；英雄池走同一数组引用无需通知。加载失败静默留缺位回退。
  // 皮肤 GLB 不在此批（P3 按需化）：默认皮肤 chaos 的用户不必白拉 aristocrat
  if (onLate) {
    ;(async () => {
      try {
        const rest = await Promise.all([
          ...AGENT_POOL.slice(1).map(tryLoad),
          tryLoad('viewmodel-phantom.glb'),
          tryLoad('arms-official.glb'),
        ])
        const nAgents = AGENT_POOL.length - 1
        for (let i = 0; i < nAgents; i++) addAgent(rest[i], i + 1)
        addViewmodel(out, 'phantom', rest[nAgents])
        // 官方 1P 手臂（原样返回：OfficialArms attach 时克隆+摆姿+拟合；
        // 动画轨道 = 官方 IdlePose，随 gltf.animations 带出）
        const armsGltf = rest[nAgents + 1]
        if (armsGltf?.scene) {
          out.fpArms = { scene: armsGltf.scene, animations: armsGltf.animations ?? [] }
        }
        onLate(out)
      } catch (e) {
        console.error('[VHT] background asset batch failed', e)
      }
    })()
  }
  return out
}

// ============================================================================
// 皮肤 GLB 按需拉取（P3）：皮肤模型不再随后台批发（默认皮肤是 chaos 的用户
// 用不到 aristocrat，白背 1.9MB 传输 + 34.5MB VRAM），改为「菜单点选/启动补拉」
// 触发。语义三要点：
//   触发条件是条目带 file，而不是「非 default」——default 无文件无事可拉；
//   chaos 虽是默认皮肤但带投放位 file，照样发起（文件放入 models/ 即自动换模）
//   负缓存：请求失败（404 投放位缺文件 / 解析损坏）一次即记，会话内不再重发
//   ——否则默认 chaos 用户每次点按钮都重发必然失败的请求
//   到货：addViewmodel 归一化后经 onSkinArrival 回调（main 的第三条到货线做
//   增量接线 + 预热 + applyWeaponSkin 补挂），与两批资产共用同一条管线
// ============================================================================
const skinRequests = new Map() // skin id → 'inflight' | 'failed' | 模板根（已到货）
const skinArrivalCbs = []

export function onSkinArrival(cb) { skinArrivalCbs.push(cb) }

export function requestSkin(id) {
  const entry = SKINS.vandal.find(s => s.id === id) // 皮肤目录目前只登记 vandal
  if (!entry?.file || skinRequests.has(id)) return // 无 file / 已到货 / 在途 / 负缓存
  skinRequests.set(id, 'inflight')
  // 先 fetch 后 parse：GLTFLoader.load 的错误回调不带 HTTP 状态，无法据此做
  // 404 负缓存；fetch 拿得到 r.ok。GLB 是自包含二进制，parse 直接吃 ArrayBuffer，
  // path 仅供外部资源解析（皮肤 GLB 贴图均内嵌，不会真去取）
  fetch(new URL(`models/${entry.file}`, document.baseURI).href)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => new Promise((res) => {
      if (!buf) return res(null)
      new GLTFLoader().parse(buf, new URL('models/', document.baseURI).href, (gltf) => res(gltf), () => res(null))
    }))
    .then((gltf) => {
      const out = { viewmodels: {} }
      if (gltf?.scene) addViewmodel(out, `vandal:${id}`, gltf)
      const vm = out.viewmodels[`vandal:${id}`]
      skinRequests.set(id, vm ?? 'failed') // 空场景同负缓存（损坏文件不会自愈）
      if (vm) for (const cb of skinArrivalCbs) cb(out.viewmodels)
    })
    .catch(() => skinRequests.set(id, 'failed'))
}
