import { assert, assertBytesClose, assertClose, test } from '@test/harness/api'

/**
 * 層 3 の疎通確認。
 *
 * `OfflineAudioContext` は実デバイス不要で、実時間より高速に、
 * かつ決定的にレンダリングできる。
 * **音声処理の正しさはハードウェアなしで検証できる** — これが
 * テスト設計 §1.3 で層 3 を独立させた理由。
 *
 * ここでは AUP01 (書き出しの再現性) と同じ手順が成立することを確かめる。
 */

const renderSine = async (frequency: number, seconds: number): Promise<Float32Array> => {
  const sampleRate = 48000
  const ctx = new OfflineAudioContext(1, sampleRate * seconds, sampleRate)
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = frequency
  const gain = ctx.createGain()
  gain.gain.value = 0.5
  osc.connect(gain).connect(ctx.destination)
  osc.start(0)
  osc.stop(seconds)
  const buffer = await ctx.startRendering()
  return buffer.getChannelData(0).slice()
}

test('OfflineAudioContext がレンダリングできる', async () => {
  const rendered = await renderSine(440, 0.1)
  assert(rendered.length === 4800, `expected 4800 samples, got ${String(rendered.length)}`)
  const peak = rendered.reduce((max, x) => Math.max(max, Math.abs(x)), 0)
  assertClose(peak, 0.5, 0.01, 'peak amplitude')
})

test('同じ入力を 2 回レンダリングするとサンプル単位で一致する (AUP01 の足場)', async () => {
  const first = await renderSine(440, 0.25)
  const second = await renderSine(440, 0.25)
  // 書き出しの決定性はこのツールの価値そのもの。完全一致を要求する。
  assertBytesClose(first, second, 0, 'offline rendering is not deterministic')
})

test('AudioWorklet を登録して動かせる (P2-8 の前提)', async () => {
  const sampleRate = 48000
  const ctx = new OfflineAudioContext(1, sampleRate / 10, sampleRate)
  const source = `
    registerProcessor('const-one', class extends AudioWorkletProcessor {
      process(inputs, outputs) {
        const out = outputs[0]
        for (const channel of out) channel.fill(0.25)
        return true
      }
    })`
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
    const node = new AudioWorkletNode(ctx, 'const-one')
    node.connect(ctx.destination)
    const buffer = await ctx.startRendering()
    const data = buffer.getChannelData(0)
    assertClose(data[2400] ?? 0, 0.25, 1e-6, 'worklet output value')
  } finally {
    URL.revokeObjectURL(url)
  }
})
