import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

// 用户/开源模型加载：
//   public/models/agent.glb      → 训练机器人外观（当前内置：Khronos "BrainStem"，CC-BY 4.0 by Microsoft，
//                                  含骨骼走路动画；自动缩放到总高 1.8m、脚底对地、面向 -Z）
//   public/models/viewmodel.glb  → 第一人称枪模（当前内置：Quaternius AK47，CC0；最长轴对齐 -Z 枪管向）
//   public/models/hands.glb      → 第一人称手臂（当前内置：J-Toastie "Rigged FPS Arms"，CC-BY 3.0，
//                                  poly.pizza 分发；按骨骼左右手位置自动对位到枪的握把/护木）
// 文件缺失时静默跳过，回退到内置程序化模型。
export async function loadUserAssets() {
  const out = { agent: null, agentAnimations: null, viewmodel: null, hands: null }
  const loader = new GLTFLoader()
  const tryLoad = (file) => new Promise((res) => {
    loader.load(
      new URL(`models/${file}`, document.baseURI).href,
      (gltf) => res(gltf),
      undefined,
      () => res(null),
    )
  })
  const [agentGltf, vmGltf, handsGltf] = await Promise.all([tryLoad('agent.glb'), tryLoad('viewmodel.glb'), tryLoad('hands.glb')])

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
    out.viewmodel = vm
  }
  // 手臂：原始场景原样返回，对位/缩放在 WeaponSystem.setCustomHands 里按骨骼位置计算
  if (handsGltf?.scene) out.hands = handsGltf.scene
  return out
}
