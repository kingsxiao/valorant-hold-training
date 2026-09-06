// 给 glove.glb 补生成盒式投影 TEXCOORD_0：该模型无 UV，ModelTexturing 指定的
// 皮肤贴图/法线贴图全被 three.js 忽略（近景细节只剩顶点法线）。皱纹/毛孔类
// 噪声法线贴图对盒式投影的接缝不敏感（2026-09-08 实测定稿）。
// 用法：node scripts/add-glove-uvs.mjs（幂等：已有 TEXCOORD_0 则跳过）
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { weld, quantize } from '@gltf-transform/functions'

const io = new NodeIO().registerExtensions([KHRMeshQuantization])
const path = 'public/models/glove.glb'
const doc = await io.read(path)
let added = 0
for (const prim of doc.getRoot().listMeshes().flatMap(m => m.listPrimitives())) {
  if (prim.getAttribute('TEXCOORD_0')) continue
  const pos = prim.getAttribute('POSITION')
  const n = pos.getCount()
  const uv = new Float32Array(n * 2)
  // 盒式投影：按法线主导轴投影到对应平面，归一化到 0..1
  const nor = prim.getAttribute('NORMAL')
  const p = [0, 0, 0], nn = [0, 0, 0]
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    pos.getElement(i, p)
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]) }
  }
  const span = max.map((m, k) => Math.max(1e-6, m - min[k]))
  for (let i = 0; i < n; i++) {
    pos.getElement(i, p)
    nor?.getElement(i, nn)
    const ax = Math.abs(nn[0]), ay = Math.abs(nn[1]), az = Math.abs(nn[2])
    let u, v
    if (ax >= ay && ax >= az) { u = (p[2] - min[2]) / span[2]; v = (p[1] - min[1]) / span[1] }
    else if (ay >= az) { u = (p[0] - min[0]) / span[0]; v = (p[2] - min[2]) / span[2] }
    else { u = (p[0] - min[0]) / span[0]; v = (p[1] - min[1]) / span[1] }
    uv[i * 2] = u
    uv[i * 2 + 1] = v
  }
  prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv))
  added++
}
if (!added) { console.log('TEXCOORD_0 已存在，跳过'); process.exit(0) }
await doc.transform(weld(), quantize({ quantizeNormal: 12 }))
await io.write(path, doc)
console.log(`已为 ${added} 个 primitive 生成盒式投影 TEXCOORD_0 并重新量化`)
