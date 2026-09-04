/**
 * 音声エンジン。
 *
 * 現状このツールはプレビューが無音で、音声は書き出し時に ffmpeg で
 * 多重化しているだけだった。DJ 機能には実際の再生が要る。
 *
 * 設計上の注意 (PC003 の実測より):
 *   - `AudioContext` を resume した直後の `getOutputTimestamp()` は
 *     `{contextTime: 0, performanceTime: 0}` を返し、
 *     実際にデバイスが回り出すまで約 65ms かかる。
 *     この期間の値を基準にすると、以降ずっと補正されない定数オフセットが乗る。
 *   - 単発の較正値には最大 10ms のジッタが乗る。平滑化が要る。
 *
 * ヘッドホンキューは対象外 (要件 F-D3)。手持ちの出力が 2ch のみのため。
 */

export type AudioEngine = {
  readonly context: AudioContext
  /** マスター出力。デッキとサンプラーはここへ繋ぐ */
  readonly master: GainNode
  /** 較正が確立したら解決する。再生開始前に await する */
  whenReady(timeoutMs?: number): Promise<void>
  isReady(): boolean
  /** 音声時刻。較正未確立なら null */
  now(): number | null
  setMasterGain(value: number): void
  getLevel(): number
  dispose(): Promise<void>
}

const READY_POLL_MS = 10

export const createAudioEngine = (): AudioEngine => {
  const context = new AudioContext({ latencyHint: 'interactive' })

  const master = context.createGain()
  master.gain.value = 0.9

  // レベルメーター用。UI に出すと「鳴っているのか」がすぐ分かる。
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.7
  const levelBuffer = new Float32Array(analyser.fftSize)

  master.connect(analyser)
  analyser.connect(context.destination)

  let ready = false

  const probeReady = (): boolean => {
    if (ready) return true
    const stamp = context.getOutputTimestamp()
    // contextTime > 0 を確認してから較正済みとする。
    // 0 のまま基準を取ると補正されないずれが乗る (PC003)。
    if (
      stamp.contextTime !== undefined &&
      stamp.contextTime > 0 &&
      stamp.performanceTime !== undefined &&
      stamp.performanceTime > 0
    ) {
      ready = true
    }
    return ready
  }

  return {
    context,
    master,

    whenReady: async (timeoutMs = 5000) => {
      await context.resume()
      const deadline = Date.now() + timeoutMs
      while (!probeReady()) {
        if (Date.now() > deadline) {
          throw new Error('audio clock did not start within the timeout')
        }
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
      }
    },

    isReady: () => probeReady(),

    now: () => (probeReady() ? context.currentTime : null),

    setMasterGain: (value) => {
      // 直接代入するとクリックノイズが出るので短くランプさせる
      master.gain.setTargetAtTime(Math.max(0, Math.min(2, value)), context.currentTime, 0.01)
    },

    getLevel: () => {
      analyser.getFloatTimeDomainData(levelBuffer)
      let peak = 0
      for (const sample of levelBuffer) {
        const abs = Math.abs(sample)
        if (abs > peak) peak = abs
      }
      return peak
    },

    dispose: async () => {
      master.disconnect()
      analyser.disconnect()
      await context.close()
    },
  }
}
