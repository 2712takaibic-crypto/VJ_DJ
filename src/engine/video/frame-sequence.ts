import * as THREE from 'three/webgpu'

/**
 * 静止画列を映像ソースとして扱う。
 *
 * HTMLVideoElement を使わない理由は決定性。
 * currentTime によるシークはフレーム精度が保証されず、
 * 「同じプロジェクトから同じ映像が出る」を満たせない。
 * 静止画列なら時刻からフレーム番号を計算するだけで完全に決定的になる。
 *
 * プレビューと書き出しで同じソースを使うのも意図的。
 * 経路を分けると「プレビューでは良かったのに書き出すと違う」が起きる。
 */

export type FrameSequenceManifest = {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly frameCount: number
  readonly durationSeconds: number
  readonly pattern: string
}

export type FrameSequenceSource = {
  readonly texture: THREE.Texture
  readonly width: number
  readonly height: number
  readonly durationSeconds: number
  readonly frameCount: number
  /**
   * 指定時刻の画をテクスチャへ反映する。
   *
   * 書き出しでは必ず await すること。await しないと
   * 前のフレームの画がそのまま出て、映像が飛ぶ。
   * リアルタイムでは await せず、間に合わなければ直前の画のままでよい。
   */
  setTime(seconds: number, loop: boolean): Promise<void>
  /** 先読み。リアルタイム再生で息継ぎを防ぐ */
  prefetch(seconds: number, count: number, loop: boolean): void
  dispose(): void
}

const CACHE_LIMIT = 96

export const createFrameSequenceSource = async (baseUrl: string): Promise<FrameSequenceSource> => {
  const manifestResponse = await fetch(`${baseUrl}/manifest.json`)
  if (!manifestResponse.ok) {
    throw new Error(`frame sequence manifest not found: ${baseUrl}/manifest.json`)
  }
  const manifest = (await manifestResponse.json()) as FrameSequenceManifest

  const frameUrl = (index: number): string => `${baseUrl}/${String(index + 1).padStart(5, '0')}.jpg`

  const cache = new Map<number, ImageBitmap>()
  const inflight = new Map<number, Promise<ImageBitmap>>()

  const load = async (index: number): Promise<ImageBitmap> => {
    const cached = cache.get(index)
    if (cached) return cached
    const pending = inflight.get(index)
    if (pending) return pending

    const promise = (async (): Promise<ImageBitmap> => {
      const response = await fetch(frameUrl(index))
      if (!response.ok) throw new Error(`frame ${index} not found`)
      const bitmap = await createImageBitmap(await response.blob())
      cache.set(index, bitmap)
      // 古いものから捨てる。ImageBitmap は明示的に close しないとリークする。
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next()
        if (oldest.done) break
        cache.get(oldest.value)?.close()
        cache.delete(oldest.value)
      }
      inflight.delete(index)
      return bitmap
    })()
    inflight.set(index, promise)
    return promise
  }

  // 初期フレームでテクスチャを作る
  const first = await load(0)
  const texture = new THREE.Texture(first)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true

  let currentIndex = 0

  const indexFor = (seconds: number, loop: boolean): number => {
    const raw = Math.floor(seconds * manifest.fps)
    if (loop) {
      const wrapped = ((raw % manifest.frameCount) + manifest.frameCount) % manifest.frameCount
      return wrapped
    }
    return Math.min(manifest.frameCount - 1, Math.max(0, raw))
  }

  return {
    texture,
    width: manifest.width,
    height: manifest.height,
    durationSeconds: manifest.durationSeconds,
    frameCount: manifest.frameCount,

    setTime: async (seconds, loop) => {
      const index = indexFor(seconds, loop)
      if (index === currentIndex) return
      const bitmap = await load(index)
      texture.image = bitmap
      texture.needsUpdate = true
      currentIndex = index
    },

    prefetch: (seconds, count, loop) => {
      const start = indexFor(seconds, loop)
      for (let i = 1; i <= count; i++) {
        const index = indexFor((start + i) / manifest.fps, loop)
        if (!cache.has(index) && !inflight.has(index)) void load(index).catch(() => undefined)
      }
    },

    dispose: () => {
      for (const bitmap of cache.values()) bitmap.close()
      cache.clear()
      inflight.clear()
      texture.dispose()
    },
  }
}
