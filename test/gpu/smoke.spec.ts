import { assert, assertBytesClose, assertEqual, test } from '@test/harness/api'
import {
  assertNoLeaks,
  countCreated,
  installLeakDetector,
  uninstallLeakDetector,
} from '@test/harness/leak-detector'

/**
 * 層 2 の疎通確認。
 *
 * ここで確認するのは「テストが書ける状態になっているか」であって、
 * 製品の機能ではない。ただし **UP301 (ユニフォームの GPU 往復テスト) と
 * 同じ手順を通す** ようにしてある。UP301 はこの領域のバグを根絶する
 * 最重要テストであり、その足場がここで成立していることを確かめておく。
 */

const requestDevice = async (): Promise<GPUDevice> => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  assert(adapter !== null, 'no WebGPU adapter')
  return adapter.requestDevice()
}

test('WebGPU アダプタとデバイスを取得できる', async () => {
  const device = await requestDevice()
  assert(device.limits.maxTextureDimension2D >= 4096, 'maxTextureDimension2D too small')
  // PC001 の実測値。ここが 4 未満になる環境では合成パイプラインの設計が変わる。
  assert(device.limits.maxBindGroups >= 4, 'maxBindGroups < 4')
  device.destroy()
})

test('バッファへ書き込んだ値をコンピュートシェーダ経由で読み戻せる (UP301 の足場)', async () => {
  const device = await requestDevice()

  const input = new Float32Array([1.5, -2.25, 3.125, 1024.5])
  const inputBuffer = device.createBuffer({
    size: input.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(inputBuffer, 0, input)

  const outputBuffer = device.createBuffer({
    size: input.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const staging = device.createBuffer({
    size: input.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  const module = device.createShaderModule({
    code: `
      struct U { v: vec4f };
      @group(0) @binding(0) var<uniform> u: U;
      @group(0) @binding(1) var<storage, read_write> out: array<f32, 4>;
      @compute @workgroup_size(1) fn main() {
        out[0] = u.v.x; out[1] = u.v.y; out[2] = u.v.z; out[3] = u.v.w;
      }`,
  })
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inputBuffer } },
      { binding: 1, resource: { buffer: outputBuffer } },
    ],
  })

  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(1)
  pass.end()
  encoder.copyBufferToBuffer(outputBuffer, 0, staging, 0, input.byteLength)
  device.queue.submit([encoder.finish()])

  await staging.mapAsync(GPUMapMode.READ)
  const result = new Float32Array(staging.getMappedRange().slice(0))
  staging.unmap()
  device.destroy()

  // f32 の往復なので完全一致するはず。ずれるならパッキングかアライメントの問題。
  assertBytesClose(result, input, 0, 'uniform roundtrip mismatch')
})

test('LeakDetector が ImageBitmap の収支を検出する', () => {
  installLeakDetector()
  try {
    const canvas = new OffscreenCanvas(16, 16)
    const ctx = canvas.getContext('2d')
    assert(ctx !== null, 'no 2d context')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 16, 16)

    const bitmap = canvas.transferToImageBitmap()
    countCreated('ImageBitmap')
    assertEqual(bitmap.width, 16, 'bitmap width')

    // close する前は収支が合わない = 検出できることの確認
    let detected = false
    try {
      assertNoLeaks()
    } catch {
      detected = true
    }
    assert(detected, 'leak detector failed to report an outstanding ImageBitmap')

    bitmap.close()
    assertNoLeaks('after close the ledger must balance')
  } finally {
    uninstallLeakDetector()
  }
})
