/**
 * 楽曲解析: BPM / ビートグリッド / オンセット / 帯域別レベル
 *
 * 結果を JSON に固定するのが要点。
 * リアルタイムに解析すると書き出しのたびに結果が変わりうるが、
 * このツールの価値は「同じプロジェクトから同じ映像が出ること」なので、
 * 解析は一度だけ行い、以降はその結果を読むだけにする
 * (設計書 §2.2.12 の audioReactive の決定性要件)。
 *
 * 実行:
 *   node scripts/analyze-audio.mjs 素材/hikari.m4a .tmp/hikari.analysis.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const SAMPLE_RATE = 22050
const FFT_SIZE = 1024
const HOP = 256
const FRAME_RATE = SAMPLE_RATE / HOP // ≈ 86.13 Hz
const MIN_BPM = 70
const MAX_BPM = 180

// ---------- FFT (radix-2, in-place) ----------

const fft = (re, im) => {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

// ---------- デコード ----------

const decodeToMono = (inputPath) => {
  const raw = execFileSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      // 添付画像を持つ m4a があるので音声ストリームだけを明示的に選ぶ
      '-map',
      'a:0',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      '-',
    ],
    { maxBuffer: 1 << 30 },
  )
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
}

// ---------- STFT とオンセット包絡 ----------

const analyseSpectra = (samples) => {
  const frameCount = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1)
  const bins = FFT_SIZE / 2

  const window = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))
  }

  const flux = new Float32Array(frameCount)
  const low = new Float32Array(frameCount)
  const mid = new Float32Array(frameCount)
  const high = new Float32Array(frameCount)
  const rms = new Float32Array(frameCount)

  // 帯域の境界 (Hz → bin)
  const hzPerBin = SAMPLE_RATE / FFT_SIZE
  const lowEnd = Math.floor(200 / hzPerBin)
  const midEnd = Math.floor(2000 / hzPerBin)

  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  let prev = new Float32Array(bins)

  for (let f = 0; f < frameCount; f++) {
    const offset = f * HOP
    let energy = 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[offset + i] ?? 0
      re[i] = s * window[i]
      im[i] = 0
      energy += s * s
    }
    rms[f] = Math.sqrt(energy / FFT_SIZE)

    fft(re, im)

    const mag = new Float32Array(bins)
    let fluxSum = 0
    let lowSum = 0
    let midSum = 0
    let highSum = 0
    for (let b = 0; b < bins; b++) {
      const m = Math.hypot(re[b], im[b])
      mag[b] = m
      // スペクトルフラックス: 増加分のみを拾う (半波整流)。
      // 減少分まで数えると、音が止まる瞬間もオンセットとして拾ってしまう。
      const diff = m - prev[b]
      if (diff > 0) fluxSum += diff
      if (b < lowEnd) lowSum += m
      else if (b < midEnd) midSum += m
      else highSum += m
    }
    flux[f] = fluxSum
    low[f] = lowSum
    mid[f] = midSum
    high[f] = highSum
    prev = mag
  }

  return { frameCount, flux, low, mid, high, rms }
}

// ---------- 正規化 ----------

const normalise = (arr) => {
  let max = 0
  for (const v of arr) if (v > max) max = v
  if (max <= 0) return new Float32Array(arr.length)
  const out = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / max
  return out
}

/** 移動平均を引いて、曲全体の音量差の影響を取り除く */
const removeMovingAverage = (arr, radius) => {
  const out = new Float32Array(arr.length)
  let sum = 0
  const window = []
  for (let i = 0; i < arr.length; i++) {
    window.push(arr[i])
    sum += arr[i]
    if (window.length > radius * 2 + 1) sum -= window.shift()
    const mean = sum / window.length
    out[i] = Math.max(0, arr[i] - mean)
  }
  return out
}

// ---------- テンポ推定 ----------

const estimateTempo = (onset) => {
  const minLag = Math.round((60 / MAX_BPM) * FRAME_RATE)
  const maxLag = Math.round((60 / MIN_BPM) * FRAME_RATE)

  let bestLag = minLag
  let bestScore = -Infinity
  const scores = []

  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0
    for (let i = 0; i + lag < onset.length; i++) score += onset[i] * onset[i + lag]
    // 2 拍・4 拍先との相関も足すと、倍テンポ / 半テンポの取り違えが減る
    const lag2 = lag * 2
    if (lag2 < onset.length) {
      for (let i = 0; i + lag2 < onset.length; i++) score += 0.5 * onset[i] * onset[i + lag2]
    }
    const normalised = score / (onset.length - lag)
    scores.push({ lag, bpm: (60 * FRAME_RATE) / lag, score: normalised })
    if (normalised > bestScore) {
      bestScore = normalised
      bestLag = lag
    }
  }

  return { bpm: (60 * FRAME_RATE) / bestLag, lag: bestLag, scores }
}

/**
 * BPM を小数精度まで詰める。
 *
 * 自己相関のラグは整数フレームなので、129 BPM 付近では約 3 BPM 刻みでしか
 * 候補が出ない。この粗さは致命的で、1 BPM のずれは 90 秒で 0.57 秒の
 * ビートグリッドのずれになる。MV の同期では確実に破綻する。
 *
 * そこで粗い候補の周辺を小刻みに走査し、
 * 「各フレームのオンセット値を、そのフレームが持つ拍内位相のヒストグラムに
 * 積む」方式で評価する。位相が揃っている BPM ほどヒストグラムが尖る。
 * ラグが小数でも評価できるのが利点。
 */
const PHASE_BINS = 64

const scoreTempo = (onset, bpm) => {
  const framesPerBeat = (60 * FRAME_RATE) / bpm
  const histogram = new Float64Array(PHASE_BINS)
  for (let i = 0; i < onset.length; i++) {
    const v = onset[i]
    if (v <= 0) continue
    const phase = (i / framesPerBeat) % 1
    histogram[Math.min(PHASE_BINS - 1, Math.floor(phase * PHASE_BINS))] += v
  }
  let total = 0
  let peak = 0
  let peakBin = 0
  for (let b = 0; b < PHASE_BINS; b++) {
    total += histogram[b]
    if (histogram[b] > peak) {
      peak = histogram[b]
      peakBin = b
    }
  }
  if (total <= 0) return { score: 0, phase: 0 }
  // 尖り具合を評価する。平坦なら 1/PHASE_BINS に近づく。
  return { score: peak / total, phase: (peakBin + 0.5) / PHASE_BINS }
}

const refineTempo = (onset, coarseBpm) => {
  let best = { bpm: coarseBpm, score: -Infinity, phase: 0 }
  // 粗い推定の ±4 BPM を 0.01 刻みで走査する
  for (let bpm = coarseBpm - 4; bpm <= coarseBpm + 4; bpm += 0.01) {
    if (bpm < MIN_BPM || bpm > MAX_BPM) continue
    const { score, phase } = scoreTempo(onset, bpm)
    if (score > best.score) best = { bpm, score, phase }
  }
  const framesPerBeat = (60 * FRAME_RATE) / best.bpm
  // phase は「拍の先頭がフレーム 0 からどれだけ後ろか」の比率
  const offsetFrames = best.phase * framesPerBeat
  return { bpm: best.bpm, offsetSeconds: offsetFrames / FRAME_RATE, score: best.score }
}

// ---------- メイン ----------

const main = () => {
  const [, , inputPath, outputPath] = process.argv
  if (!inputPath || !outputPath) {
    console.error('usage: node scripts/analyze-audio.mjs <input> <output.json>')
    process.exit(2)
  }

  console.log(`decoding ${inputPath} …`)
  const samples = decodeToMono(inputPath)
  const duration = samples.length / SAMPLE_RATE
  console.log(`  ${samples.length} samples / ${duration.toFixed(2)}s @ ${SAMPLE_RATE}Hz`)

  console.log('analysing spectra …')
  const spectra = analyseSpectra(samples)
  console.log(`  ${spectra.frameCount} frames @ ${FRAME_RATE.toFixed(2)}Hz`)

  const onset = normalise(removeMovingAverage(normalise(spectra.flux), Math.round(FRAME_RATE)))

  console.log('estimating tempo …')
  const tempo = estimateTempo(onset)
  const top = [...tempo.scores].sort((a, b) => b.score - a.score).slice(0, 5)
  console.log(`  粗い推定: ${tempo.bpm.toFixed(2)} BPM (ラグ ${tempo.lag} フレーム)`)
  console.log('  上位候補:')
  for (const c of top) console.log(`    ${c.bpm.toFixed(2)} BPM (score ${c.score.toFixed(4)})`)

  console.log('refining …')
  const refined = refineTempo(onset, tempo.bpm)
  const beatOffset = refined.offsetSeconds
  const beatInterval = 60 / refined.bpm

  const beats = []
  for (let t = beatOffset; t < duration; t += beatInterval) beats.push(Number(t.toFixed(4)))

  // 粗い推定のままだった場合に生じたはずのずれを示す。
  // この差が大きいほど refinement の効果があったということ。
  const driftIfCoarse = Math.abs(
    (duration / (60 / tempo.bpm)) * (60 / tempo.bpm) - (duration / beatInterval) * beatInterval,
  )
  const beatDelta = Math.abs(60 / tempo.bpm - beatInterval) * beats.length
  console.log(
    `  BPM ${refined.bpm.toFixed(3)}  offset ${beatOffset.toFixed(3)}s  beats ${beats.length}  (位相の尖り ${refined.score.toFixed(3)})`,
  )
  console.log(
    `  粗い推定のままなら曲末で約 ${beatDelta.toFixed(2)}s ずれていた (drift check ${driftIfCoarse.toFixed(3)})`,
  )

  const result = {
    source: inputPath,
    analysedAt: new Date().toISOString(),
    sampleRate: SAMPLE_RATE,
    frameRate: FRAME_RATE,
    durationSeconds: Number(duration.toFixed(4)),
    tempo: {
      bpm: Number(refined.bpm.toFixed(4)),
      beatOffsetSeconds: Number(beatOffset.toFixed(4)),
      candidates: top.map((c) => ({ bpm: Number(c.bpm.toFixed(3)), score: Number(c.score.toFixed(6)) })),
    },
    beats,
    /** フレーム単位の系列。FX の変調に使う。0〜1 に正規化済み */
    envelopes: {
      onset: Array.from(onset, (v) => Number(v.toFixed(4))),
      low: Array.from(normalise(spectra.low), (v) => Number(v.toFixed(4))),
      mid: Array.from(normalise(spectra.mid), (v) => Number(v.toFixed(4))),
      high: Array.from(normalise(spectra.high), (v) => Number(v.toFixed(4))),
      rms: Array.from(normalise(spectra.rms), (v) => Number(v.toFixed(4))),
    },
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(result), 'utf8')
  console.log(`written ${outputPath}`)
}

main()
