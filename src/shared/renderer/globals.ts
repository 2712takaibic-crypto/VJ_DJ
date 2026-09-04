import type { VjdjApi } from '@shared/protocol/api'
import type { HandshakeStatus } from '@shared/protocol/handshake'

/**
 * レンダラの主ワールドに存在するグローバル。
 *
 * DOM を要するため src/shared/protocol/ ではなくここに置く
 * (protocol/ は main プロセスからも参照され、そちらには DOM 型がない)。
 */
declare global {
  interface Window {
    readonly vjdj: VjdjApi
    __vjdjHandshake?: HandshakeStatus
  }
}

export {}
