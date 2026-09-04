import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { ShowParamsPatch } from '@shared/protocol/show-params'
import { connectEngine, type EngineLink, type EngineState } from './engine-link'
import { Section, Slider, Toggle } from './controls'
import { Library } from './library'

/**
 * Control Window。
 *
 * Engine Host のプレビューを表示し、パラメータを操作する。
 * 操作対象は MCP が触るものと同一 (ShowParams)。
 * 分けると「UI では変えられるのに AI からは変えられない」が生まれる。
 */

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${String(m)}:${s.toFixed(1).padStart(4, '0')}`
}

export const App = (): JSX.Element => {
  const [link, setLink] = useState<EngineLink | null>(null)
  const [state, setState] = useState<EngineState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let disposed = false
    let stopState: (() => void) | undefined
    let stopPreview: (() => void) | undefined

    void connectEngine()
      .then((engine) => {
        if (disposed) return
        setLink(engine)
        engine.configurePreview(720, 30)

        stopState = engine.onState((next) => {
          setState(next)
        })

        stopPreview = engine.onPreview((bitmap) => {
          const canvas = canvasRef.current
          if (canvas === null) {
            bitmap.close()
            return
          }
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          const ctx = canvas.getContext('2d')
          ctx?.drawImage(bitmap, 0, 0)
          // ImageBitmap は明示的に close しないとリークする
          bitmap.close()
        })
      })
      .catch((reason: Error) => {
        if (!disposed) setError(reason.message)
      })

    return () => {
      disposed = true
      stopState?.()
      stopPreview?.()
    }
  }, [])

  const patch = useCallback(
    (next: ShowParamsPatch) => {
      link?.setParams(next)
    },
    [link],
  )

  if (error !== null) {
    return (
      <main style={{ ...page, color: '#f2777a' }}>
        <p>Engine Host に接続できません</p>
        <p style={{ fontSize: '0.8rem', color: '#8a8a99' }}>{error}</p>
      </main>
    )
  }

  if (state === null) {
    return (
      <main style={page}>
        <p style={{ color: '#8a8a99' }}>Engine Host に接続中…</p>
      </main>
    )
  }

  const p = state.params

  return (
    <main style={page}>
      {/* ---- プレビュー ---- */}
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            aspectRatio: '16 / 9',
            background: '#000',
            border: '1px solid #23232f',
            borderRadius: 6,
            display: 'block',
          }}
        />

        {/* ---- トランスポート ---- */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', marginTop: '0.6rem' }}>
          <button
            type="button"
            onClick={() => {
              link?.setPlaying(!state.playing)
            }}
            style={button}
          >
            {state.playing ? '⏸ 一時停止' : '▶ 再生'}
          </button>
          <span
            style={{ fontVariantNumeric: 'tabular-nums', color: '#d8dcea', fontSize: '0.85rem' }}
          >
            {formatTime(state.timeSeconds)} / {formatTime(state.duration)}
          </span>
          <input
            type="range"
            min={0}
            max={state.duration}
            step={0.05}
            value={state.timeSeconds}
            onChange={(event) => {
              link?.seek(Number(event.target.value))
            }}
            style={{ flex: 1, accentColor: '#5aa0ff' }}
          />
          <span style={{ color: '#6f7690', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
            {state.bpm.toFixed(1)} BPM / {state.fps.toFixed(0)} fps
          </span>
        </div>
      </div>

      {/* ---- パラメータ ---- */}
      <aside style={{ width: 280, flex: '0 0 280px', overflowY: 'auto', paddingLeft: '0.8rem' }}>
        <Library
          onSelectVideo={(asset) => {
            link?.setVideoSource(asset.url)
          }}
          onSelectAudio={(asset) => {
            link?.setAudioSource(asset.url)
          }}
        />

        <Section title="クロマキー">
          <Slider
            name="inner"
            value={p.chroma.innerTolerance}
            min={0}
            max={0.5}
            onChange={(v) => {
              patch({ chroma: { innerTolerance: v } })
            }}
          />
          <Slider
            name="outer"
            value={p.chroma.outerTolerance}
            min={0}
            max={0.8}
            onChange={(v) => {
              patch({ chroma: { outerTolerance: v } })
            }}
          />
          <Slider
            name="despill"
            value={p.chroma.despill}
            min={0}
            max={1}
            onChange={(v) => {
              patch({ chroma: { despill: v } })
            }}
          />
          <Slider
            name="choke (縁消し)"
            value={p.chroma.choke}
            min={0}
            max={5}
            onChange={(v) => {
              patch({ chroma: { choke: v } })
            }}
          />
          <Slider
            name="brightness"
            value={p.chroma.brightness}
            min={0}
            max={2}
            onChange={(v) => {
              patch({ chroma: { brightness: v } })
            }}
          />
          <Toggle
            name="マット表示 (調整用)"
            value={p.chroma.matteView}
            onChange={(v) => {
              patch({ chroma: { matteView: v } })
            }}
          />
        </Section>

        <Section title="被写体">
          <Slider
            name="高さ (m)"
            value={p.performer.heightMeters}
            min={1}
            max={10}
            step={0.1}
            onChange={(v) => {
              patch({ performer: { heightMeters: v } })
            }}
          />
          <Slider
            name="左右"
            value={p.performer.x}
            min={-6}
            max={6}
            step={0.1}
            onChange={(v) => {
              patch({ performer: { x: v } })
            }}
          />
          <Slider
            name="奥行き"
            value={p.performer.z}
            min={-6}
            max={6}
            step={0.1}
            onChange={(v) => {
              patch({ performer: { z: v } })
            }}
          />
        </Section>

        <Section title="発光 (bloom)">
          <Slider
            name="strength"
            value={p.bloom.strength}
            min={0}
            max={2}
            onChange={(v) => {
              patch({ bloom: { strength: v } })
            }}
          />
          <Slider
            name="threshold"
            value={p.bloom.threshold}
            min={0}
            max={1.5}
            onChange={(v) => {
              patch({ bloom: { threshold: v } })
            }}
          />
          <Slider
            name="音への追従"
            value={p.bloom.audioResponse}
            min={0}
            max={2}
            onChange={(v) => {
              patch({ bloom: { audioResponse: v } })
            }}
          />
        </Section>

        <Section title="LED ウォール">
          <Slider
            name="色相"
            value={p.wall.hue}
            min={0}
            max={1}
            onChange={(v) => {
              patch({ wall: { hue: v } })
            }}
          />
          <Slider
            name="色の振れ幅"
            value={p.wall.hueRange}
            min={0}
            max={0.5}
            onChange={(v) => {
              patch({ wall: { hueRange: v } })
            }}
          />
          <Slider
            name="明るさ"
            value={p.wall.brightness}
            min={0}
            max={3}
            onChange={(v) => {
              patch({ wall: { brightness: v } })
            }}
          />
        </Section>

        <Section title="エフェクト">
          <Toggle
            name="レーザー"
            value={p.lasers.enabled}
            onChange={(v) => {
              patch({ lasers: { enabled: v } })
            }}
          />
          <Slider
            name="レーザー強度"
            value={p.lasers.intensity}
            min={0}
            max={3}
            onChange={(v) => {
              patch({ lasers: { intensity: v } })
            }}
          />
          <Toggle
            name="電撃"
            value={p.lightning.enabled}
            onChange={(v) => {
              patch({ lightning: { enabled: v } })
            }}
          />
          <Slider
            name="電撃強度"
            value={p.lightning.intensity}
            min={0}
            max={3}
            onChange={(v) => {
              patch({ lightning: { intensity: v } })
            }}
          />
          <Toggle
            name="パーティクル"
            value={p.particles.enabled}
            onChange={(v) => {
              patch({ particles: { enabled: v } })
            }}
          />
        </Section>

        <Section title="カメラ">
          <Toggle
            name="自動切り替え"
            value={p.camera.mode === 'auto'}
            onChange={(v) => {
              patch({ camera: { mode: v ? 'auto' : 'manual' } })
            }}
          />
          <Slider
            name="ショット"
            value={p.camera.shotIndex}
            min={0}
            max={3}
            step={1}
            onChange={(v) => {
              patch({ camera: { shotIndex: v, mode: 'manual' } })
            }}
          />
          <Slider
            name="切替間隔 (小節)"
            value={p.camera.barsPerShot}
            min={1}
            max={16}
            step={1}
            onChange={(v) => {
              patch({ camera: { barsPerShot: v } })
            }}
          />
        </Section>
      </aside>
    </main>
  )
}

const page: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  color: '#e8e8ec',
  background: '#0d0d13',
  height: '100vh',
  margin: 0,
  padding: '0.8rem',
  boxSizing: 'border-box',
  display: 'flex',
  gap: '0.4rem',
}

const button: React.CSSProperties = {
  background: '#2a3350',
  color: '#dfe6ff',
  border: '1px solid #3b4870',
  borderRadius: 5,
  padding: '0.35rem 0.9rem',
  fontSize: '0.85rem',
  cursor: 'pointer',
}
