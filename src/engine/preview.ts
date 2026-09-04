import type { EngineToControl } from '@shared/renderer/realtime'

/**
 * プレビューの発行。
 *
 * 合成結果を縮小して `ImageBitmap` にし、Control Window へ transfer する。
 *
 * PC002 の実測より、この経路のコストは**プレビュー解像度に対してほぼ定数**で、
 * 1080p でも engine 側 0.4ms しかかからない。
 * 生ピクセルの読み戻しは画素数に線形で、1080p では 10.8ms かかる。
 * そのため既定の解像度を低く抑える必要がない。
 *
 * 背圧制御が要点。受信側が追いつかないまま送り続けると、
 * 未処理の ImageBitmap が溜まってメモリを食う。
 */

export type PreviewPublisher = {
  configure(width: number, fps: number): void
  /** 発行を試みる。間隔・背圧の条件を満たさなければ何もしない */
  publish(source: HTMLCanvasElement, now: number): void
  ack(seq: number): void
  dispose(): void
}

const MAX_UNACKED = 2

export const createPreviewPublisher = (port: MessagePort): PreviewPublisher => {
  let width = 640
  let fps = 30
  let lastPublish = 0
  let seq = 0
  let unacked = 0
  let inFlight = false
  let surface: OffscreenCanvas | null = null
  let context: OffscreenCanvasRenderingContext2D | null = null

  const ensureSurface = (aspect: number): OffscreenCanvasRenderingContext2D | null => {
    const height = Math.max(1, Math.round(width / aspect))
    if (surface === null || surface.width !== width || surface.height !== height) {
      surface = new OffscreenCanvas(width, height)
      context = surface.getContext('2d')
    }
    return context
  }

  return {
    configure: (nextWidth, nextFps) => {
      width = Math.max(160, Math.min(1920, Math.round(nextWidth)))
      fps = Math.max(1, Math.min(60, nextFps))
      surface = null
    },

    publish: (source, now) => {
      if (inFlight) return
      // 未 ack が溜まっているなら捨てる。溜め込むより落とす方がよい。
      if (unacked > MAX_UNACKED) return
      const interval = 1000 / fps
      if (now - lastPublish < interval) return
      lastPublish = now

      inFlight = true
      void (async () => {
        try {
          const ctx = ensureSurface(source.width / source.height)
          const target = surface
          if (ctx === null || target === null) return

          const bitmap = await createImageBitmap(source)
          ctx.drawImage(bitmap, 0, 0, target.width, target.height)
          bitmap.close()

          const preview = target.transferToImageBitmap()
          seq++
          unacked++
          const message: EngineToControl = { t: 'preview', seq, bitmap: preview }
          port.postMessage(message, [preview])
        } catch {
          // プレビューが出せなくても本体の描画は続ける。
          // ここで例外を伝播させると出力が止まる。
        } finally {
          inFlight = false
        }
      })()
    },

    ack: () => {
      unacked = Math.max(0, unacked - 1)
    },

    dispose: () => {
      surface = null
      context = null
    },
  }
}
