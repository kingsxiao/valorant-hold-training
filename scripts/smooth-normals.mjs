// 对指定 GLB 做按位置聚合的顶点法线平滑（2026-09-08）。
// 背景：glove/hands.glb 自带逐面法线（95.8% 顶点法线≈所在三角形面法线）→近景面片化。
// gltf-transform normals() 对未焊接顶点无效（每顶点仅属一个三角形，算出的"平滑"
// 法线仍等于面法线）；weld 又因重复顶点间法线/UV 不一致而拒绝合并（鸡生蛋）。
// 本脚本绕开拓扑：同位置（1e-5 精度）顶点的法线取均值写回每个顶点——
// 跨 UV/材质缝的着色连续，且完全不动索引/权重/UV（蒙皮与穿插审计结果不变）。
// 用法：node scripts/smooth-normals.mjs [file.glb ...]（默认 glove.glb + hands.glb）
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { quantize } from '@gltf-transform/functions'

const io = new NodeIO().registerExtensions([KHRMeshQuantization])
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['public/models/glove.glb', 'public/models/hands.glb']
for (const path of files) {
  const doc = await io.read(path)
  for (const prim of doc.getRoot().listMeshes().flatMap(m => m.listPrimitives())) {
    const pos = prim.getAttribute('POSITION'), nor = prim.getAttribute('NORMAL')
    if (!nor) continue
    const key = (x, y, z) => Math.round(x * 1e5) + ',' + Math.round(y * 1e5) + ',' + Math.round(z * 1e5)
    const groups = new Map()
    for (let i = 0; i < pos.getCount(); i++) {
      const p = pos.getElement(i, [0, 0, 0])
      const k = key(p[0], p[1], p[2])
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(i)
    }
    const arr = nor.getArray()
    const out = new Float32Array(arr.length)
    for (const idxs of groups.values()) {
      let sx = 0, sy = 0, sz = 0
      for (const i of idxs) { const n = nor.getElement(i, [0, 0, 0]); sx += n[0]; sy += n[1]; sz += n[2] }
      const len = Math.hypot(sx, sy, sz) || 1
      for (const i of idxs) { out[i * 3] = sx / len; out[i * 3 + 1] = sy / len; out[i * 3 + 2] = sz / len }
    }
    prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(out))
  }
  await doc.transform(quantize({ quantizeNormal: 12 }))
  await io.write(path, doc)
  console.log(`${path}: 法线已按位置聚合平滑（${groups0(doc)} 顶点组）`)
}
function groups0() { return '' }
