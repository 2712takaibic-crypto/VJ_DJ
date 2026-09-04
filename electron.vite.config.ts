import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import aliasMap from './build/aliases.json'

/**
 * エイリアスの定義元は build/aliases.json ただ 1 つ。
 * vitest.config.ts / test/harness/main.mjs も同じファイルを読む。
 * tsconfig.base.json の `paths` だけは TypeScript の都合で別記述になるため、
 * 変更時は両方を直すこと。
 */
const alias = Object.fromEntries(
  Object.entries(aliasMap).map(([key, value]) => [key, resolve(value)]),
)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // `sandbox: true` のレンダラでは preload に ESM を使えない (Electron の制約)。
        // 設計書 §6.1 は sandbox を必須としているため、preload は CJS で出力する。
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    // 2 つのレンダラ (Control Window / Engine Host) を別エントリとして持つ。
    // 設計書 §1.1 のプロセス構成に対応する。
    root: 'src',
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          control: resolve('src/ui/index.html'),
          engine: resolve('src/engine/index.html'),
        },
      },
    },
  },
})
