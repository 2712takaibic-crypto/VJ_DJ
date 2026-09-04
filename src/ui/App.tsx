import { useEffect, useState, type JSX } from 'react'
import type { HandshakeStatus } from '@shared/protocol/handshake'
import { startRealtime } from './realtime'

/**
 * P0-3 時点の Control Window。
 * RealtimeChannel の疎通状態を表示する。
 * 実際の UI (レイヤーリスト / インスペクタ / プレビュー) は P1-23 で構築する。
 */
export const App = (): JSX.Element => {
  const { electron, chrome, node } = window.vjdj.versions
  const [handshake, setHandshake] = useState<HandshakeStatus>({ state: 'pending' })

  useEffect(() => {
    // StrictMode の二重実行でハンドシェイクを 2 回走らせないためのガード。
    // 2 回目は ready() が再度呼ばれてポートが再配布され、状態が壊れる。
    let cancelled = false
    void startRealtime().then((status) => {
      if (!cancelled) setHandshake(status)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const tone =
    handshake.state === 'ok' ? '#5ad18a' : handshake.state === 'failed' ? '#f2777a' : '#8a8a99'

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        color: '#e8e8ec',
        background: '#101014',
        height: '100vh',
        margin: 0,
        padding: '2rem',
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>VJDJ — Control</h1>
      <p style={{ color: '#8a8a99', fontSize: '0.875rem' }}>
        Phase 0 / Task P0-3: 2 ウィンドウ構成と MessageChannel
      </p>

      <section style={{ marginTop: '1.5rem', fontSize: '0.875rem', lineHeight: 1.9 }}>
        <div style={{ color: tone, fontWeight: 600 }}>
          RealtimeChannel: {handshake.state}
          {handshake.state === 'ok' && ` — RTT ${handshake.rttMs.toFixed(2)}ms`}
          {handshake.state === 'failed' && ` — ${handshake.error}`}
        </div>
        <div style={{ color: '#8a8a99' }}>
          Electron {electron} / Chromium {chrome} / Node {node}
        </div>
      </section>
    </main>
  )
}
