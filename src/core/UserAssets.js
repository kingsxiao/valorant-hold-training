import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { applyAgentTextures, applyViewmodelTextures, applyHandsTextures } from '../world/ModelTexturing.js'
import { buildLocomotion } from './Locomotion.js'

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

// 用户/开源模型加载：
//   public/models/agent-{jett,phoenix,sage,sova}.glb → 无畏契约英雄池（每 bot 随机一名，
//                                          UE 风格骨架 + 内嵌 PBR 贴图 + kamae 持枪待机 clip；
//                                          走/跑/横移优先官方 .psa 曲线（locomotion.json），
//                                          缺数据才由 core/GaitBake 步态数学现场烘焙）
//   public/models/agent.glb              → 训练机器人外观（当前内置：Mixamo "X Bot"，CC-BY，
//                                          含骨骼走路动画；英雄池缺位时的单模板回退；自动缩放到
//                                          总高 1.8m、脚底对地、面向 -Z）
//   public/models/viewmodel-vandal.glb   → Vandal 第一人称枪模（"AK-47 Kalashnikov" by
//                                          Mateusz Woliński, Sketchfab, CC-BY 4.0；真实 PBR 贴图，
//                                          原生材质直接保留；作者系枪管沿 -X，与管线约定一致）
//   public/models/viewmodel-phantom.glb  → Phantom 第一人称枪模（"AK 47 Tactical Upgrade" by
//                                          Mateusz Woliński, Sketchfab, CC-BY 4.0；带消音器/导轨，
//                                          含 bolt carrier / magazine / suppressor 独立网格）
//   public/models/viewmodel-vandal-aristocrat.glb → Vandal 官方皮肤（Aristocrat 收藏集，
//                                          内部代号 ArtDeco；Rocklan 包 .blend 转换，镀金 + RedDot 瞄具）
//   public/models/viewmodel.glb          → 旧版单枪模回退（Quaternius AK47，CC0 白模，
//                                          无贴图 → 程序化盒式投影 UV + 材质）
//   public/models/glove.glb              → 第一人称高精度手套（当前内置：J-Toastie "Gloved Hand"，CC-BY 3.0，
//                                          五指独立三关节骨骼；WeaponSystem 双实例化 + 五指 IK 持枪）
//   public/models/hands.glb              → 第一人称手臂备选（当前内置：J-Toastie "Rigged FPS Arms"，CC-BY 3.0；
//                                          glove.glb 缺失时回退使用）
// 文件缺失时静默跳过，回退到内置程序化模型。
export async function loadUserAssets() {
  const out = { agent: null, agentAnimations: null, agents: [], viewmodel: null, viewmodels: {}, hands: null, glove: null }
  const loader = new GLTFLoader()
  const tryLoad = (file) => new Promise((res) => {
    loader.load(
      new URL(`models/${file}`, document.baseURI).href,
      (gltf) => res(gltf),
      undefined,
      () => res(null),
    )
  })
  const hasRealTextures = (root) => {
    let any = false
    root.traverse(o => {
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])
      if (ms.some(m => m.map)) any = true
    })
    return any
  }
  // 无畏契约英雄池：命中即整体取代 agent.glb 单模板（main.js 注入 Bot.customTemplates）
  const AGENT_POOL = ['agent-jett.glb', 'agent-phoenix.glb', 'agent-sage.glb', 'agent-sova.glb']
  const loaded = await Promise.all([
    tryLoad('agent.glb'), ...AGENT_POOL.map(tryLoad),
    tryLoad('viewmodel-vandal.glb'), tryLoad('viewmodel-phantom.glb'),
    tryLoad('viewmodel-vandal-aristocrat.glb'),
    tryLoad('viewmodel.glb'), tryLoad('hands.glb'), tryLoad('glove.glb'),
  ])
  const agentGltf = loaded[0]
  const agentPoolGltfs = loaded.slice(1, 1 + AGENT_POOL.length)
  const [vandalGltf, phantomGltf, aristocratGltf, legacyVmGltf, handsGltf, gloveGltf] = loaded.slice(1 + AGENT_POOL.length)

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
  for (let i = 0; i < agentPoolGltfs.length; i++) {
    const gltf = agentPoolGltfs[i]
    if (!gltf?.scene) continue
    const entry = normalizeAgent(gltf)
    entry.hero = AGENT_POOL[i].replace(/^agent-/, '').replace(/\.glb$/, '')
    out.agents.push(entry)
  }
  // 官方 .psa 走/跑/横移曲线（scripts/psa2clips.mjs 从 Rocklan 官方动画转出）：
  // 每英雄按 GLB 骨名后缀解析成 AnimationClip——有官方数据就直接播官方骨骼曲线，
  // 没有才退回 GaitBake 的步态数学烘焙
  if (out.agents.length) {
    let locoJson = null
    try {
      locoJson = await (await fetch(new URL('models/locomotion.json', document.baseURI).href)).json()
    } catch { /* 缺文件静默退回烘焙 */ }
    if (locoJson) for (const e of out.agents) e.locomotion = buildLocomotion(locoJson, e.hero, e.root)
  }
  if (!out.agents.length && agentGltf?.scene) {
    const a = normalizeAgent(agentGltf)
    out.agent = a.root
    out.agentAnimations = a.clips
  }

  // 枪模归一化：最长水平轴对齐到 Z（枪管向），随后按包围盒尺寸归一到 0.85m
  // （90° 水平旋转只交换 x/z，最大边不变 → 缩放用旋转前的 size 即可）。
  // 自带贴图的模型（Objaverse 系 AK）原生 PBR 材质直接保留；白模才走程序化贴图
  const normalizeViewmodel = (vm) => {
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
  for (const [key, gltf] of [['vandal', vandalGltf], ['phantom', phantomGltf],
    ['vandal:aristocrat', aristocratGltf]]) {
    if (!gltf?.scene) continue
    const vm = normalizeViewmodel(gltf.scene)
    if (!hasRealTextures(vm)) applyViewmodelTextures(vm) // 白模才盒式投影 + 程序化材质
    out.viewmodels[key] = vm
  }
  if (legacyVmGltf?.scene) {
    const vm = normalizeViewmodel(legacyVmGltf.scene)
    applyViewmodelTextures(vm) // 无 UV 白模 → 盒式投影 UV + 金属/木纹贴图
    out.viewmodel = vm
  }
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
  return out
}
