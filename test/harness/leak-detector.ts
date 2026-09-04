/**
 * `VideoFrame` と `ImageBitmap` の生成・解放の収支を数える。
 *
 * WebCodecs で最も多い実害のあるバグがフレームリークで、
 * 数フレーム溜まるとデコーダが停止して再生が止まる。
 * `ImageBitmap` も同様にリークする (プレビュー転送で毎秒 30 枚作る)。
 *
 * どちらも症状が出るまで気づきにくいため、
 * テストで能動的に収支を取る (テスト設計 RL003 / RL005)。
 *
 * レンダラ (層 2) でのみ動作する。Node には両クラスとも存在しない。
 */

export type LeakReport = {
  readonly kind: string
  readonly created: number
  readonly closed: number
  readonly outstanding: number
}

type Counter = { created: number; closed: number }

const counters = new Map<string, Counter>()
const restorers: (() => void)[] = []

const counterFor = (kind: string): Counter => {
  const existing = counters.get(kind)
  if (existing) return existing
  const fresh = { created: 0, closed: 0 }
  counters.set(kind, fresh)
  return fresh
}

/**
 * 計測を開始する。close() を数えるためにプロトタイプを差し替える。
 *
 * 生成側は API が多岐にわたる (decoder の出力 / createImageBitmap /
 * transferToImageBitmap / new VideoFrame) ため、
 * **生成は `countCreated()` を明示的に呼んで登録する。**
 * 暗黙に全部を捕まえようとすると取りこぼしが出て、
 * 「リークしていないのに検出できない」より悪い
 * 「リークしているのに検出できない」状態になる。
 */
export const installLeakDetector = (): void => {
  uninstallLeakDetector()

  const patchClose = (kind: string, proto: { close?: () => void } | undefined): void => {
    if (!proto || typeof proto.close !== 'function') return
    const original = proto.close
    proto.close = function patched(this: object): void {
      counterFor(kind).closed++
      original.call(this)
    }
    restorers.push(() => {
      proto.close = original
    })
  }

  patchClose('ImageBitmap', globalThis.ImageBitmap?.prototype)
  patchClose(
    'VideoFrame',
    (globalThis as { VideoFrame?: { prototype: { close?: () => void } } }).VideoFrame?.prototype,
  )
}

export const uninstallLeakDetector = (): void => {
  while (restorers.length > 0) restorers.pop()?.()
  counters.clear()
}

/** 生成を 1 件記録する。生成箇所で明示的に呼ぶこと。 */
export const countCreated = (kind: string, n = 1): void => {
  counterFor(kind).created += n
}

export const leakReport = (): readonly LeakReport[] =>
  [...counters.entries()].map(([kind, c]) => ({
    kind,
    created: c.created,
    closed: c.closed,
    outstanding: c.created - c.closed,
  }))

/** 収支が合っていなければ throw する。テストの最後に呼ぶ。 */
export const assertNoLeaks = (message = 'resource leak detected'): void => {
  const leaked = leakReport().filter((r) => r.outstanding !== 0)
  if (leaked.length > 0) {
    const detail = leaked
      .map(
        (r) =>
          `  ${r.kind}: created=${String(r.created)} closed=${String(r.closed)} outstanding=${String(r.outstanding)}`,
      )
      .join('\n')
    throw new Error(`${message}\n${detail}`)
  }
}
