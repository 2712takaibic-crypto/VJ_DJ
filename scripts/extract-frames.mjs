/**
 * 映像を静止画列に展開する。
 *
 * 理由: 書き出しはフレーム単位で正確に画を取り出せる必要がある。
 * HTMLVideoElement の currentTime によるシークはフレーム精度が保証されず、
 * 「同じプロジェクトから同じ映像が出る」という前提を満たせない。
 *
 * 静止画列にしてしまえば、時刻からフレーム番号を計算するだけで
 * 完全に決定的にアクセスできる。素材が短い (29 秒) ので容量も問題にならない。
 *
 * プレビューと書き出しで同じ経路を使うことにも意味がある。
 * 経路が分かれていると「プレビューでは良かったのに書き出すと違う」が起きる。
 *
 * 実行:
 *   node scripts/extract-frames.mjs 素材/green_back.mp4 .tmp/frames/green_back
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const main = () => {
  const [, , inputPath, outputDir] = process.argv
  if (!inputPath || !outputDir) {
    console.error('usage: node scripts/extract-frames.mjs <input> <outputDir>')
    process.exit(2)
  }

  // 素材のフレームレートと寸法を取得する
  let info = ''
  try {
    execFileSync(ffmpegPath, ['-hide_banner', '-i', inputPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    info = String(error.stderr)
  }
  const streamLine = info.split('\n').find((l) => l.includes('Video:')) ?? ''
  const fpsMatch = /([\d.]+) fps/.exec(streamLine)
  const sizeMatch = /, (\d+)x(\d+)/.exec(streamLine)
  const fps = fpsMatch ? Number(fpsMatch[1]) : 30
  const width = sizeMatch ? Number(sizeMatch[1]) : 0
  const height = sizeMatch ? Number(sizeMatch[2]) : 0
  const durMatch = /Duration: (\d+):(\d+):([\d.]+)/.exec(info)
  const duration = durMatch
    ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
    : 0

  console.log(`${inputPath}: ${width}x${height} ${fps}fps ${duration}s`)

  mkdirSync(outputDir, { recursive: true })

  // JPEG は非可逆だが、この後クロマキーで抜くので輪郭のリンギングが気になる。
  // 品質を高めに固定して劣化を抑える (-q:v 2 が実質最高品質)。
  console.log('extracting …')
  execFileSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-vsync',
      '0',
      '-q:v',
      '2',
      join(outputDir, '%05d.jpg'),
    ],
    { stdio: 'inherit' },
  )

  const files = readdirSync(outputDir).filter((f) => f.endsWith('.jpg'))
  const manifest = {
    source: inputPath,
    extractedAt: new Date().toISOString(),
    width,
    height,
    fps,
    frameCount: files.length,
    durationSeconds: files.length / fps,
    pattern: '%05d.jpg',
  }
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  console.log(`  ${files.length} frames -> ${outputDir}`)
  console.log(`  manifest: ${JSON.stringify(manifest)}`)
  if (!existsSync(join(outputDir, '00001.jpg'))) {
    console.error('WARN: 00001.jpg not found — 出力パターンを確認すること')
  }
}

main()
