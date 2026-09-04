import { useCallback, useEffect, useState, type JSX } from 'react'
import type { MediaAsset } from '@shared/protocol/media'
import type { DjDeckPayload, DjStatePayload } from '@shared/renderer/realtime'
import { Section, Slider } from './controls'
import type { EngineLink } from './engine-link'

/**
 * DJ セクションの UI。
 *
 * plan.txt の「音のサンプリング、ミキシングなど、DJ 用機能一式」に対応する。
 *
 * ヘッドホンキューは対象外 (要件 F-D3)。手持ちの出力が 2ch のみのため、
 * 次に繋ぐ曲の頭出しは再生位置と BPM の表示で行う。
 */

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${String(m)}:${s.toFixed(1).padStart(4, '0')}`
}

const DeckPanel = ({
  id,
  deck,
  audioAssets,
  link,
}: {
  id: 'A' | 'B'
  deck: DjDeckPayload
  audioAssets: readonly MediaAsset[]
  link: EngineLink
}): JSX.Element => (
  <div style={deckBox}>
    <div style={deckHeader}>
      <strong style={{ color: id === 'A' ? '#68b0ff' : '#ff86c8' }}>DECK {id}</strong>
      <span style={{ color: '#8a90a6', fontSize: '0.66rem' }}>
        {deck.bpm === null ? '— BPM' : `${deck.bpm.toFixed(1)} BPM`}
      </span>
    </div>

    <select
      value=""
      onChange={(event) => {
        const asset = audioAssets.find((a) => a.id === event.target.value)
        if (asset?.audioUrl != null) link.djLoadDeck(id, asset.audioUrl, asset.name, null)
      }}
      style={select}
    >
      <option value="">{deck.loaded ? deck.name : '曲を選ぶ…'}</option>
      {audioAssets.map((asset) => (
        <option key={asset.id} value={asset.id}>
          {asset.name}
        </option>
      ))}
    </select>

    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: '0.35rem 0' }}>
      <button
        type="button"
        onClick={() => {
          link.djDeck(id, deck.playing ? 'pause' : 'play')
        }}
        disabled={!deck.loaded}
        style={playButton(deck.loaded)}
      >
        {deck.playing ? '⏸' : '▶'}
      </button>
      <span style={{ fontSize: '0.66rem', color: '#c7cbdb', fontVariantNumeric: 'tabular-nums' }}>
        {formatTime(deck.positionSeconds)} / {formatTime(deck.durationSeconds)}
      </span>
    </div>

    <input
      type="range"
      min={0}
      max={Math.max(1, deck.durationSeconds)}
      step={0.1}
      value={deck.positionSeconds}
      onChange={(event) => {
        link.djSeek(id, Number(event.target.value))
      }}
      disabled={!deck.loaded}
      style={{ width: '100%', accentColor: '#5aa0ff' }}
    />

    <Slider
      name="テンポ (ピッチも変わる)"
      value={deck.rate}
      min={0.5}
      max={2}
      onChange={(v) => {
        link.djRate(id, v)
      }}
    />
    <Slider
      name="ゲイン"
      value={deck.gain}
      min={0}
      max={2}
      onChange={(v) => {
        link.djGain(id, v)
      }}
    />
    <Slider
      name="LOW (dB)"
      value={deck.eq.low}
      min={-30}
      max={12}
      step={0.5}
      onChange={(v) => {
        link.djEq(id, 'low', v)
      }}
    />
    <Slider
      name="MID (dB)"
      value={deck.eq.mid}
      min={-30}
      max={12}
      step={0.5}
      onChange={(v) => {
        link.djEq(id, 'mid', v)
      }}
    />
    <Slider
      name="HIGH (dB)"
      value={deck.eq.high}
      min={-30}
      max={12}
      step={0.5}
      onChange={(v) => {
        link.djEq(id, 'high', v)
      }}
    />
  </div>
)

export const DjPanel = ({ link }: { link: EngineLink }): JSX.Element => {
  const [state, setState] = useState<DjStatePayload | null>(null)
  const [assets, setAssets] = useState<readonly MediaAsset[]>([])

  useEffect(() => link.onDjState(setState), [link])

  useEffect(() => {
    void window.vjdj
      .listMedia()
      .then(setAssets)
      .catch(() => undefined)
  }, [])

  const audioAssets = assets.filter((a) => a.kind === 'audio' && a.audioUrl !== null)

  const assignPad = useCallback(
    (index: number, assetId: string) => {
      const asset = assets.find((a) => a.id === assetId)
      if (asset?.audioUrl != null) link.djLoadPad(index, asset.audioUrl, asset.name)
    },
    [assets, link],
  )

  if (state === null) {
    return (
      <Section title="DJ">
        <p style={{ color: '#6f7690', fontSize: '0.7rem', margin: 0 }}>接続待ち…</p>
      </Section>
    )
  }

  return (
    <Section title="DJ">
      <DeckPanel id="A" deck={state.deckA} audioAssets={audioAssets} link={link} />
      <DeckPanel id="B" deck={state.deckB} audioAssets={audioAssets} link={link} />

      <div style={{ marginTop: '0.5rem' }}>
        <Slider
          name="クロスフェーダー (A ⇄ B)"
          value={state.crossfader}
          min={0}
          max={1}
          onChange={(v) => {
            link.djCrossfader(v)
          }}
        />
        <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.5rem' }}>
          {(['smooth', 'sharp'] as const).map((curve) => (
            <button
              key={curve}
              type="button"
              onClick={() => {
                link.djCurve(curve)
              }}
              style={curveButton(state.curve === curve)}
            >
              {curve === 'smooth' ? 'スムーズ' : 'シャープ'}
            </button>
          ))}
        </div>
        <Slider
          name="マスター"
          value={state.masterGain}
          min={0}
          max={1.5}
          onChange={(v) => {
            link.djMaster(v)
          }}
        />
        {/* レベルメーター。鳴っているかが一目で分かる */}
        <div style={meterTrack}>
          <div style={{ ...meterFill, width: `${String(Math.min(100, state.level * 140))}%` }} />
        </div>
      </div>

      <div style={{ marginTop: '0.6rem' }}>
        <div style={{ fontSize: '0.7rem', color: '#8a90a6', marginBottom: '0.3rem' }}>
          サンプラー (クリックで再生)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.25rem' }}>
          {state.pads.map((pad) => (
            <button
              key={pad.index}
              type="button"
              onClick={() => {
                link.djTriggerPad(pad.index)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                const first = audioAssets[0]
                if (first !== undefined) assignPad(pad.index, first.id)
              }}
              title={pad.name === '' ? '右クリックで最初の音源を割り当て' : pad.name}
              style={padButton(pad.name !== '')}
            >
              {pad.index + 1}
            </button>
          ))}
        </div>
      </div>
    </Section>
  )
}

const deckBox: React.CSSProperties = {
  border: '1px solid #23232f',
  borderRadius: 5,
  padding: '0.4rem 0.45rem',
  marginBottom: '0.45rem',
}

const deckHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  fontSize: '0.72rem',
  marginBottom: '0.3rem',
}

const select: React.CSSProperties = {
  width: '100%',
  background: '#1a1f2e',
  color: '#d8dcea',
  border: '1px solid #2c3550',
  borderRadius: 4,
  padding: '0.25rem',
  fontSize: '0.68rem',
}

const playButton = (enabled: boolean): React.CSSProperties => ({
  background: enabled ? '#2a3350' : '#1c1f2a',
  color: enabled ? '#dfe6ff' : '#5a5f70',
  border: '1px solid #3b4870',
  borderRadius: 4,
  padding: '0.15rem 0.6rem',
  fontSize: '0.8rem',
  cursor: enabled ? 'pointer' : 'default',
})

const curveButton = (active: boolean): React.CSSProperties => ({
  flex: 1,
  background: active ? '#2f3d63' : '#1a1f2e',
  color: active ? '#dfe6ff' : '#8a90a6',
  border: '1px solid #2c3550',
  borderRadius: 4,
  padding: '0.2rem',
  fontSize: '0.66rem',
  cursor: 'pointer',
})

const meterTrack: React.CSSProperties = {
  height: 5,
  background: '#14141c',
  borderRadius: 3,
  overflow: 'hidden',
}

const meterFill: React.CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg,#4ad991,#e8d44a,#f2777a)',
  transition: 'width 80ms linear',
}

const padButton = (assigned: boolean): React.CSSProperties => ({
  background: assigned ? '#2a3350' : '#171b26',
  color: assigned ? '#dfe6ff' : '#4e5468',
  border: '1px solid #2c3550',
  borderRadius: 4,
  padding: '0.3rem 0',
  fontSize: '0.7rem',
  cursor: 'pointer',
})
