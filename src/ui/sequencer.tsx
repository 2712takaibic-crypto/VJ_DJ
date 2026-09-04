import { useEffect, useState, type JSX } from 'react'
import type { DjStatePayload } from '@shared/renderer/realtime'
import { Section, Slider } from './controls'
import type { EngineLink } from './engine-link'

/**
 * ステップシーケンサーの UI。
 *
 * plan.txt の「打ち込みやシーケンサーで曲を作れる DAW 機能」に対応する。
 *
 * 16 ステップのグリッド。クリックで打ち込み、再度クリックで消す。
 * 4 ステップごとに区切りを入れる。拍が見えないと打ち込めない。
 */

export const SequencerPanel = ({ link }: { link: EngineLink }): JSX.Element => {
  const [state, setState] = useState<DjStatePayload | null>(null)

  useEffect(() => link.onDjState(setState), [link])

  if (state === null) {
    return (
      <Section title="シーケンサー">
        <p style={{ color: '#6f7690', fontSize: '0.7rem', margin: 0 }}>接続待ち…</p>
      </Section>
    )
  }

  const seq = state.sequencer

  return (
    <Section title="シーケンサー (DAW)">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <button
          type="button"
          onClick={() => {
            link.seqTransport(seq.playing ? 'stop' : 'start')
          }}
          style={transportButton(seq.playing)}
        >
          {seq.playing ? '■ 停止' : '▶ 再生'}
        </button>
        <span style={{ fontSize: '0.68rem', color: '#8a90a6' }}>
          {seq.bpm.toFixed(0)} BPM / 16分
        </span>
      </div>

      <Slider
        name="テンポ"
        value={seq.bpm}
        min={60}
        max={200}
        step={1}
        onChange={(v) => {
          link.seqBpm(v)
        }}
      />

      <div style={{ marginTop: '0.4rem' }}>
        {seq.tracks.map((track, trackIndex) => (
          <div key={track.name} style={rowStyle}>
            <button
              type="button"
              onClick={() => {
                link.seqMute(trackIndex, !track.muted)
              }}
              title={track.muted ? 'ミュート中' : 'クリックでミュート'}
              style={nameButton(track.muted)}
            >
              {track.name}
            </button>
            <div style={{ display: 'flex', gap: 1, flex: 1 }}>
              {track.steps.map((velocity, stepIndex) => (
                <button
                  key={stepIndex}
                  type="button"
                  onClick={() => {
                    link.seqStep(trackIndex, stepIndex, velocity > 0 ? 0 : 0.9)
                  }}
                  style={stepButton(
                    velocity > 0,
                    stepIndex % 4 === 0,
                    seq.playing && seq.currentStep === stepIndex,
                  )}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <p style={{ color: '#6f7690', fontSize: '0.64rem', margin: '0.45rem 0 0' }}>
        クリックで打ち込み。トラック名でミュート。 PAD 1 はサンプラーのパッド 1 を鳴らす。
      </p>
    </Section>
  )
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
  marginBottom: 2,
}

const nameButton = (muted: boolean): React.CSSProperties => ({
  width: 46,
  flex: '0 0 46px',
  background: muted ? '#1a1a22' : '#232b40',
  color: muted ? '#4e5468' : '#aebbe0',
  border: '1px solid #2c3550',
  borderRadius: 3,
  padding: '0.15rem 0',
  fontSize: '0.56rem',
  cursor: 'pointer',
})

const stepButton = (on: boolean, accent: boolean, current: boolean): React.CSSProperties => ({
  flex: 1,
  height: 17,
  // 現在位置を光らせる。どこを鳴らしているか見えないと打ち込みにくい。
  background: on
    ? current
      ? '#7fd1ff'
      : '#4a8fd6'
    : current
      ? '#2e3550'
      : accent
        ? '#1f2333'
        : '#171a24',
  border: accent ? '1px solid #2f3550' : '1px solid #1c2030',
  borderRadius: 2,
  padding: 0,
  cursor: 'pointer',
})

const transportButton = (playing: boolean): React.CSSProperties => ({
  background: playing ? '#3a2f4f' : '#2a3350',
  color: '#dfe6ff',
  border: '1px solid #3b4870',
  borderRadius: 5,
  padding: '0.25rem 0.7rem',
  fontSize: '0.75rem',
  cursor: 'pointer',
})
