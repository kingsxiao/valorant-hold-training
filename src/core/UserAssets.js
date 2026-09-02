import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { applyAgentTextures, applyViewmodelTextures, applyHandsTextures } from '../world/ModelTexturing.js'

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
//   public/models/agent.glb      → 训练机器人外观（当前内置：Mixamo "X Bot"，CC-BY，
//                                  含骨骼走路动画；自动缩放到总高 1.8m、脚底对地、面向 -Z）
//   public/models/viewmodel.glb  → 第一人称枪模（当前内置：Quaternius AK47，CC0；最长轴对齐 -Z 枪管向）
//   public/models/glove.glb      → 第一人称高精度手套（当前内置：J-Toastie "Gloved Hand"，CC-BY 3.0，
//                                  五指独立三关节骨骼；WeaponSystem 双实例化 + 五指 IK 持枪）
//   public/models/hands.glb      → 第一人称手臂备选（当前内置：J-Toastie "Rigged FPS Arms"，CC-BY 3.0；
//                                  glove.glb 缺失时回退使用）
// 文件缺失时静默跳过，回退到内置程序化模型。
export async function loadUserAssets() {
  const out = { agent: null, agentAnimations: null, viewmodel: null, hands: null, glove: null }
  const loader = new GLTFLoader()
  const tryLoad = (file) => new Promise((res) => {
    loader.load(
      new URL(`models/${file}`, document.baseURI).href,
      (gltf) => res(gltf),
      undefined,
      () => res(null),
    )
  })
  const [agentGltf, vmGltf, handsGltf, gloveGltf] = await Promise.all([
    tryLoad('agent.glb'), tryLoad('viewmodel.glb'), tryLoad('hands.glb'), tryLoad('glove.glb'),
  ])

  if (agentGltf?.scene) {
    const agent = agentGltf.scene
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
    const animations = agentGltf.animations ?? []
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
    applyAgentTextures(agent) // GLB 白模 → 程序化装甲/关节贴图
    out.agent = agent
    out.agentAnimations = animations
  }

  if (vmGltf?.scene) {
    const vm = vmGltf.scene
    vm.updateMatrixWorld(true)
    // 最长水平轴对齐到 Z（枪管向），随后按包围盒尺寸归一到 0.85m
    let box = new THREE.Box3().setFromObject(vm)
    const size = box.getSize(new THREE.Vector3())
    if (size.x > size.z) vm.rotation.y = -Math.PI / 2
    vm.updateMatrixWorld(true)
    box = new THREE.Box3().setFromObject(vm)
    const s = 0.85 / Math.max(0.001, Math.max(size.x, size.y, size.z))
    vm.scale.multiplyScalar(s)
    vm.updateMatrixWorld(true)
    box = new THREE.Box3().setFromObject(vm)
    const c = box.getCenter(new THREE.Vector3())
    vm.position.x -= c.x
    vm.position.y -= c.y
    vm.position.z -= c.z
    applyViewmodelTextures(vm) // 无 UV 白模 → 盒式投影 UV + 金属/木纹贴图
    out.viewmodel = vm
  }
  // 手臂：原始场景原样返回，对位/缩放在 WeaponSystem.setCustomHands 里按骨骼位置计算
  if (handsGltf?.scene) {
    applyHandsTextures(handsGltf.scene) // 袖/肤/手套 → 布料/皮肤/聚合物贴图
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
