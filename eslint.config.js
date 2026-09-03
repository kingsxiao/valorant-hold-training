import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.playwright-mcp/**', '.mimosa/**'],
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
