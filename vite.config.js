import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    sourcemap: false,
    reportCompressedSize: false, // 省去每次 build 的 gzip 体积计算
    chunkSizeWarningLimit: 650, // three.js 单库实测 615.31kB（npm run build，2026-09-30）——600 的旧阈值每次构建必发超限警告
    rollupOptions: {
      output: {
        // three.js 单独成 chunk：业务代码改动不需要用户重新下载渲染库
        manualChunks: { three: ['three'] },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
})
