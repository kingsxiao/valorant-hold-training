// GLB 构成体检：贴图（名称/格式/尺寸/字节）与几何缓冲各占多少。
// 用法：node scripts/inspect-models.mjs [glb路径...]
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { readdir } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const io = new NodeIO().registerExtensions([KHRMeshQuantization])

const args = process.argv.slice(2)
const files = args.length
  ? args
  : (await readdir('public/models'))
      .filter((f) => f.endsWith('.glb'))
      .map((f) => join('public/models', f))

let grandTex = 0, grandFile = 0, grandBuf = 0
for (const file of files) {
  const doc = await io.read(file)
  const root = doc.getRoot()
  const size = (await stat(file)).size
  let texTotal = 0
  const parts = []
  for (const t of root.listTextures()) {
    const img = t.getImage()
    const s = t.getSize()
    const bytes = img ? img.byteLength : 0
    texTotal += bytes
    parts.push(`${t.getName() || '?'}:${s ? s[0] + 'x' + s[1] : '?'}:${t.getMimeType().replace('image/', '')}:${(bytes / 1024).toFixed(0)}K`)
  }
  const buf = root.listBuffers().reduce((a, b) => a + (b.getByteLength?.() ?? b.byteLength ?? 0), 0)
  grandTex += texTotal; grandFile += size; grandBuf += buf
  console.log(`${file.split('/').pop().padEnd(34)} file:${(size / 1048576).toFixed(2)}M tex:${(texTotal / 1048576).toFixed(2)}M geom:${(buf / 1024).toFixed(0)}K`)
  if (parts.length) console.log(`   ${parts.join(' ')}`)
}
console.log(`\n合计 file:${(grandFile / 1048576).toFixed(1)}M tex:${(grandTex / 1048576).toFixed(1)}M geom:${(grandBuf / 1024).toFixed(0)}K`)
