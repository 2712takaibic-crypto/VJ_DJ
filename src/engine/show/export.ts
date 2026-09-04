import type { StageRenderer } from '@engine/stage/renderer'
import type { ExportConfig, ExportResult } from '@shared/protocol/export'
import type { Show } from './show'

/**
 * オフライン書き出し。
 *
 * リアルタイム性を一切当てにせず、フレーム番号から時刻を決めて
 * 1 枚ずつ確実に描く。これにより「同じプロジェクトから同じ映像が出る」
 * ことが保証される (設計書 §2.2.13)。
 *
 * 各フレームで必ず映像フレームの読み込みを await すること。
 * await を省くと前のフレームの画がそのまま出て、映像が飛ぶ。
 */

export type ExportHooks = {
  onProgress?: (frame: number, total: number, elapsedSeconds: number) => void
}

export const runExport = async (
  show: Show,
  renderer: StageRenderer,
  canvas: HTMLCanvasElement,
  config: ExportConfig,
  hooks: ExportHooks = {},
): Promise<ExportResult> => {
  const totalFrames = Math.round(config.durationSeconds * config.fps)

  // 出力解像度で描く。表示上の canvas サイズとは独立 (要件 F-V5)
  renderer.setSize(config.width, config.height)

  const capture = new OffscreenCanvas(config.width, config.height)
  const context = capture.getContext('2d')
  if (context === null) throw new Error('failed to acquire 2d context for capture')

  await window.vjdj.exportBegin(config)
  const started = performance.now()

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      const t = frame / config.fps

      const trace = frame < 2
      if (trace) console.info(`[export] f${String(frame)} update…`)
      // awaitFrames: true が要点。映像フレームの読み込みを待つ。
      await show.update(t, { awaitFrames: true })
      if (trace) console.info(`[export] f${String(frame)} render…`)
      renderer.render()

      // createImageBitmap は GPU の描画完了を待ってから解決するので、
      // ここが同期点になる。直接 drawImage すると描き途中を拾いうる。
      if (trace) console.info(`[export] f${String(frame)} createImageBitmap…`)
      const bitmap = await createImageBitmap(canvas)
      context.drawImage(bitmap, 0, 0, config.width, config.height)
      bitmap.close()

      if (trace) console.info(`[export] f${String(frame)} convertToBlob…`)
      const blob = await capture.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
      if (trace) console.info(`[export] f${String(frame)} send ${String(blob.size)}B…`)
      await window.vjdj.exportFrame(new Uint8Array(await blob.arrayBuffer()))
      if (trace) console.info(`[export] f${String(frame)} sent`)

      if (frame % 30 === 0) {
        hooks.onProgress?.(frame, totalFrames, (performance.now() - started) / 1000)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 途中で落ちても、ここまでのフレームは ffmpeg 側に渡っている。
    // finish を呼んで部分出力を残す (設計書 §2.2.13)。
    await window.vjdj.exportFinish().catch(() => undefined)
    return { ok: false, error: `render failed at export: ${message}` }
  }

  hooks.onProgress?.(totalFrames, totalFrames, (performance.now() - started) / 1000)
  return window.vjdj.exportFinish()
}
