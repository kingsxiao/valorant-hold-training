import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 600, // three.js 单库即 ~540kB，属预期
    rollupOptions: {
      output: {
        // three.js 单独成 chunk：业务代码改动不需要用户重新下载渲染库
        manualChunks: { three: ['three'] },
      },
    },
  },
})
