// 枪口朝向检测（截面法）：两端各 8% 顶点，横截面小的一端 = 细枪管 = 枪口。
// 读全部网格 POSITION（假定导出无奇异节点变换），输出枪口在 +X 还是 -X。
// 用法：node scripts/glb-muzzle-sign.mjs <file.glb>
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'

const file = process.argv[2]
const io = new NodeIO().registerExtensions([KHRMeshQuantization])
const doc = await io.read(file)

let minX = Infinity, maxX = -Infinity
const pts = []
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')
    if (!pos) continue
    const arr = pos.getArray()
    for (let i = 0; i < arr.length; i += 3) {
      pts.push([arr[i], arr[i + 1], arr[i + 2]])
      if (arr[i] < minX) minX = arr[i]
      if (arr[i] > maxX) maxX = arr[i]
    }
  }
}
const range = maxX - minX
const lo = pts.filter(p => p[0] < minX + 0.08 * range)
const hi = pts.filter(p => p[0] > maxX - 0.08 * range)
const spread = (set) => {
  let maxY = -Infinity, minY = Infinity, maxZ = -Infinity, minZ = Infinity
  for (const [, y, z] of set) {
    if (y > maxY) maxY = y; if (y < minY) minY = y
    if (z > maxZ) maxZ = z; if (z < minZ) minZ = z
  }
  return Math.max(maxY - minY, maxZ - minZ)
}
const sLo = spread(lo), sHi = spread(hi)
console.log(`${file}`)
console.log(`  X 范围 [${minX.toFixed(3)}, ${maxX.toFixed(3)}]  端点顶点数 lo=${lo.length} hi=${hi.length}`)
console.log(`  -X 端截面 ${sLo.toFixed(3)} | +X 端截面 ${sHi.toFixed(3)}  →  枪口在 ${sLo < sHi ? '-X' : '+X'}`)
