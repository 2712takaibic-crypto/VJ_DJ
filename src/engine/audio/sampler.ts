/**
 * サンプラー。
 *
 * plan.txt の「音のサンプリング」に対応する。
 * 短い音を複数のパッドに割り当て、即座に鳴らす。
 *
 * 同じパッドを連打しても前の音を切らない (ポリフォニック)。
 * 切ってしまうと連打が詰まって聞こえる。
 */

export type SamplerPad = {
  readonly index: number
  readonly name: string
  readonly durationSeconds: number
}

export type Sampler = {
  readonly output: GainNode
  /** パッドに音を割り当てる */
  assign(index: number, name: string, buffer: AudioBuffer): void
  /** 鳴らす。`when` を省略すると即時 */
  trigger(index: number, when?: number, gain?: number): void
  /** 鳴っている音をすべて止める */
  stopAll(): void
  listPads(): readonly SamplerPad[]
  dispose(): void
}

export const createSampler = (context: AudioContext, padCount = 8): Sampler => {
  const output = context.createGain()
  output.gain.value = 1

  type Pad = { name: string; buffer: AudioBuffer | null }
  const pads: Pad[] = Array.from({ length: padCount }, () => ({ name: '', buffer: null }))
  const voices = new Set<AudioBufferSourceNode>()

  return {
    output,

    assign: (index, name, buffer) => {
      const pad = pads[index]
      if (pad === undefined) return
      pad.name = name
      pad.buffer = buffer
    },

    trigger: (index, when, gain = 1) => {
      const pad = pads[index]
      if (pad?.buffer == null) return

      const source = context.createBufferSource()
      source.buffer = pad.buffer
      const level = context.createGain()
      level.gain.value = Math.max(0, Math.min(2, gain))
      source.connect(level)
      level.connect(output)

      // 前の音を切らない。切ると連打が詰まって聞こえる。
      voices.add(source)
      source.onended = () => {
        source.disconnect()
        level.disconnect()
        voices.delete(source)
      }
      source.start(when ?? context.currentTime)
    },

    stopAll: () => {
      for (const voice of voices) {
        try {
          voice.stop()
        } catch {
          // すでに停止済み
        }
      }
      voices.clear()
    },

    listPads: () =>
      pads.map((pad, index) => ({
        index,
        name: pad.name,
        durationSeconds: pad.buffer?.duration ?? 0,
      })),

    dispose: () => {
      for (const voice of voices) {
        try {
          voice.stop()
        } catch {
          // すでに停止済み
        }
      }
      voices.clear()
      output.disconnect()
    },
  }
}
