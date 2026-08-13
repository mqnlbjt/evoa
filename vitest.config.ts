import { defineConfig } from 'vitest/config'

// 覆盖率只统计 src/（核心包），web/、tasks/、dist/ 不纳入
// 阈值基于 2026-08 基线：80.15% stmts / 77.29% branch / 86.84% funcs
// 留 3-5% 余量，防止小幅波动直接挂 CI
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        statements: 75,
        branches: 72,
        functions: 80,
        lines: 75,
      },
    },
  },
})
