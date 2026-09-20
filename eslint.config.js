import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    // 与根 .gitignore 的本机工具目录（.idea/.mimosa/.playwright-mcp/.video_agent/.v2c）对齐；
    // .zcode 不在根 .gitignore，由 .zcode/workflow-runs/.gitignore 的 `*` 内层兜底（git check-ignore 可证）。
    // 这些目录里的生成脚本（如 workflow-runs/*.mjs）不走上面 files glob 的 languageOptions，
    // 会落到无 globals 的 recommended 层误报 no-undef，导致本地 `npm run verify` 挂断。
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.playwright-mcp/**', '.mimosa/**', '.zcode/**', '.v2c/**', '.video_agent/**', '.idea/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // 浏览器游戏代码常见且安全的模式
      'no-empty': ['error', { allowEmptyCatch: true }], // 静默回退（资源加载失败换下一个）是既定策略
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
]
