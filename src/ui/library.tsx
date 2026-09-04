import { useCallback, useEffect, useState, type JSX } from 'react'
import type { MediaAsset } from '@shared/protocol/media'
import { Section } from './controls'

/**
 * 素材ライブラリ。
 *
 * 取り込みは main プロセスで行う。レンダラは sandbox 内にあり
 * ファイルシステムへ直接触れないため (設計書 §6.1)。
 *
 * 取り込みには時間がかかる (映像は静止画列への展開、音声は解析)。
 * 進行中であることを必ず表示する。無反応に見えると壊れたと思われる。
 */

export const Library = ({
  onSelectVideo,
  onSelectAudio,
}: {
  onSelectVideo: (asset: MediaAsset) => void
  onSelectAudio: (asset: MediaAsset) => void
}): JSX.Element => {
  const [assets, setAssets] = useState<readonly MediaAsset[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.vjdj
      .listMedia()
      .then(setAssets)
      .catch((reason: Error) => {
        setError(reason.message)
      })
  }, [])

  useEffect(refresh, [refresh])

  const doImport = useCallback(() => {
    setBusy(true)
    setError(null)
    void window.vjdj
      .importMedia()
      .then(() => {
        refresh()
      })
      .catch((reason: Error) => {
        setError(reason.message)
      })
      .finally(() => {
        setBusy(false)
      })
  }, [refresh])

  return (
    <Section title="素材ライブラリ">
      <button type="button" onClick={doImport} disabled={busy} style={importButton(busy)}>
        {busy ? '取り込み中… (解析と展開に時間がかかります)' : '+ ファイルを取り込む'}
      </button>

      {error !== null && (
        <p style={{ color: '#f2777a', fontSize: '0.7rem', margin: '0.4rem 0 0' }}>{error}</p>
      )}

      {assets.length === 0 && !busy && (
        <p style={{ color: '#6f7690', fontSize: '0.7rem', margin: '0.5rem 0 0' }}>
          まだ素材がありません。映像 (mp4 等) と音源 (m4a 等) を取り込んでください。
        </p>
      )}

      <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0 }}>
        {assets.map((asset) => (
          <li key={asset.id} style={row}>
            <div style={{ minWidth: 0 }}>
              <div style={name} title={asset.sourcePath}>
                {asset.name}
              </div>
              <div style={meta}>
                {asset.kind === 'video'
                  ? `${String(asset.width)}×${String(asset.height)} ${asset.fps.toFixed(0)}fps`
                  : asset.kind}
                {asset.durationSeconds > 0 && ` / ${asset.durationSeconds.toFixed(1)}s`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                if (asset.kind === 'video') onSelectVideo(asset)
                else if (asset.kind === 'audio') onSelectAudio(asset)
              }}
              disabled={asset.kind === 'image'}
              style={useButton}
            >
              使う
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

const importButton = (busy: boolean): React.CSSProperties => ({
  width: '100%',
  background: busy ? '#23283a' : '#2a3350',
  color: busy ? '#7b8199' : '#dfe6ff',
  border: '1px solid #3b4870',
  borderRadius: 5,
  padding: '0.4rem',
  fontSize: '0.75rem',
  cursor: busy ? 'progress' : 'pointer',
})

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.4rem',
  padding: '0.3rem 0',
  borderBottom: '1px solid #1e1e29',
}

const name: React.CSSProperties = {
  fontSize: '0.72rem',
  color: '#d8dcea',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 165,
}

const meta: React.CSSProperties = { fontSize: '0.64rem', color: '#6f7690' }

const useButton: React.CSSProperties = {
  background: '#1d2436',
  color: '#aebbe0',
  border: '1px solid #303b58',
  borderRadius: 4,
  padding: '0.2rem 0.5rem',
  fontSize: '0.68rem',
  cursor: 'pointer',
  flex: '0 0 auto',
}
