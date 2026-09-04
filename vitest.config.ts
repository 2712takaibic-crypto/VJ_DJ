import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import aliasMap from './build/aliases.json'

// エイリアスの定義元は build/aliases.json ただ 1 つ。
// electron.vite.config.ts / test/harness/main.mjs も同じファイルを読む。
const alias = Object.fromEntries(
  Object.entries(aliasMap).map(([key, value]) => [key, resolve(value)]),
)

/**
 * テストは 5 層に分ける (テスト設計 §1.3)。
 *
 * ここで定義するのは層 1 (純ロジック) のみ。
 * 層 2 (GPU) / 層 3 (音声) は Electron のレンダラでしか動かせないため、
 * `test/harness/` の専用ランナーを使う (`npm run test:gpu` / `test:audio`)。
 *
 * **層 1 の実行時間 30 秒以内を死守すること。**
 * ここが遅くなると誰も実行しなくなり、テストスイート全体が形骸化する。
 * 遅くなってきたら、それは GPU や I/O への依存が漏れ込んでいる兆候。
 */
export default defineConfig({
  resolve: { alias },
  test: {
    passWithNoTests: true,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
    ],
  },
})
