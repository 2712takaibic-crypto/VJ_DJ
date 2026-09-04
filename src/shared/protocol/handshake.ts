/**
 * RealtimeChannel の疎通状態。
 *
 * Control Window の主ワールドが `window.__vjdjHandshake` に公開する
 * (Window の型拡張は src/shared/renderer/globals.ts)。
 *
 * UI の表示に使うほか、main プロセスと E2E テストが
 * `executeJavaScript` でチャネルの健全性を外から確認するための唯一の口になる。
 *
 * 「ポートが配られた」ことと「実際に往復した」ことは別物であり、
 * 後者を確認できる経路がないと S001-R (100 回連続起動) を自動化できない。
 */
export type HandshakeStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'ok'; readonly rttMs: number; readonly peerTimeOrigin: number }
  | { readonly state: 'failed'; readonly error: string }
