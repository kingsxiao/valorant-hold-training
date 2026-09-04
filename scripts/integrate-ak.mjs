// 把 Objaverse 选定的 AK 枪模集成进 public/models/（2026-09-04）：
//   1. 烘焙预旋转：统一到管线约定的"作者系枪管沿 -X"（与旧 Quaternius AK 相同），
//      运行时 loadUserAssets 的条件旋转/setCustomViewmodel 的枪口推导/
//      HandsRig 的 vmP 握点全部无需改坐标系逻辑。
//        kalash（作者系枪口 -Z）→ +π/2 绕 Y；tac（作者系枪口 +Z）→ +3π/2 绕 Y
//   2. 几何：dedup / prune(keepLeaves) / weld / quantize(KHR_mesh_quantization)
//   3. 贴图：sharp 重编码 —— 基色 JPEG 1024、法线 JPEG 1024(q95)、
//      金属粗糙 JPEG 512（低频），照 Sketchfab 原 PNG 动辄 1-2MB 砍一个量级
// 来源（CC-BY 4.0，署名见 README）：
//   viewmodel-vandal.glb   ← "AK-47 Kalashnikov" by Mateusz Woliński (Sketchfab)
//   viewmodel-phantom.glb  ← "AK 47 Tactical Upgrade" by Mateusz Woliński (Sketchfab)
// 用法：node scripts/integrate-ak.mjs   （源文件在 public/_preview/，属临时产物）
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { dedup, prune, weld, quantize, textureCompress } from '@gltf-transform/functions'
import sharp from 'sharp'
import { stat, writeFile } from 'node:fs/promises'

const io = new NodeIO().registerExtensions([KHRMeshQuantization])

const JOBS = [
  { src: 'public/_preview/ak47_kalash_wolinski.glb', out: 'public/models/viewmodel-vandal.glb', rotY: Math.PI / 2 },
  { src: 'public/_preview/ak47_tac_wolinski.glb', out: 'public/models/viewmodel-phantom.glb', rotY: Math.PI * 3 / 2 },
]

const mb = (n) => (n / 1048576).toFixed(2).padStart(7) + ' MB'

for (const { src, out, rotY } of JOBS) {
  const before = (await stat(src)).size
  const doc = await io.read(src)

  // 场景根节点烘焙预旋转（Scene 的直接子节点；两模型均为单根 Sketchfab_model）。
  // setRotation 是"替换"，而根节点自带 Z-up→Y-up 等烘焙旋转 → 必须左乘叠加：
  // q' = qMy ⊗ qOrig（先应用原旋转再应用预旋转）。绕 Y 转 θ 的四元数 =
  // [0, sin(θ/2), 0, cos(θ/2)]
  const my = [0, Math.sin(rotY / 2), 0, Math.cos(rotY / 2)]
  const mul = (a, b) => ({ // a ⊗ b（Hamilton 积，a 后应用）
    w: a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    x: a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    y: a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    z: a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  })
  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) {
      const o = node.getRotation() // [x,y,z,w]，默认 [0,0,0,1]
      const q = mul(my, o)
      node.setRotation([q.x, q.y, q.z, q.w])
    }
  }

  // 按材质槽位给贴图分类命名，供 textureCompress 的 pattern 分别处理
  for (const mat of doc.getRoot().listMaterials()) {
    let i = 0
    for (const [tex, tag] of [
      [mat.getBaseColorTexture(), 'bc'],
      [mat.getNormalTexture(), 'nrm'],
      [mat.getMetallicRoughnessTexture(), 'mr'],
      [mat.getOcclusionTexture(), 'ao'],
      [mat.getEmissiveTexture(), 'em'],
    ]) {
      if (tex && !tex.getName()) tex.setName(`${tag}_${i++}`)
    }
  }

  await doc.transform(
    dedup(),
    prune({ keepLeaves: true }),
    weld(),
    quantize({ quantizeNormal: 12 }),
    textureCompress({ encoder: sharp, pattern: /^bc/, targetFormat: 'jpeg', resize: [1024, 1024], quality: 88 }),
    textureCompress({ encoder: sharp, pattern: /^nrm/, targetFormat: 'jpeg', resize: [1024, 1024], quality: 95 }),
    textureCompress({ encoder: sharp, pattern: /^mr|^ao/, targetFormat: 'jpeg', resize: [512, 512], quality: 95 }),
    textureCompress({ encoder: sharp, pattern: /^em/, targetFormat: 'jpeg', resize: [512, 512], quality: 90 }),
  )

  const bytes = await io.writeBinary(doc)
  await writeFile(out, bytes)
  const pct = ((1 - bytes.byteLength / before) * 100).toFixed(0)
  console.log(`${out}: ${mb(before)} → ${mb(bytes.byteLength)}（-${pct}%）`)
}
