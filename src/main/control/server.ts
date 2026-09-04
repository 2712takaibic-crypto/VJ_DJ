import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { BrowserWindow } from 'electron'
import type { RawValue } from '@shared/protocol/raw'

/**
 * ローカル制御 API。
 *
 * MCP サーバー (別プロセス) がここを叩いてショーを操作する。
 * plan.txt の「MCP を通して AI のプロンプトで同様の操作ができるように」を
 * 実現する経路の main プロセス側。
 *
 * **127.0.0.1 にのみ束縛する。**外部から到達できてはならない。
 * このサーバーは Electron の中身を操作できるので、
 * 公開したら任意コード実行に等しくなる。
 */

export type ControlServer = {
  readonly port: number
  close(): Promise<void>
}

type Handler = (body: RawValue) => Promise<RawValue>

const readBody = async (request: IncomingMessage): Promise<RawValue> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return null
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return null
  return JSON.parse(text) as RawValue
}

/**
 * レンダラ側の `window.__vjdjControl` を呼ぶ。
 *
 * IPC を組まずに executeJavaScript を使っているのは、
 * 制御対象が「任意のパラメータの部分適用」であり、
 * メッセージ型を都度増やすより素直だから。
 * 引数は JSON.stringify して埋め込むので、注入の余地はない。
 */
const callRenderer = async (
  window: BrowserWindow,
  method: string,
  args: readonly RawValue[],
): Promise<RawValue> => {
  const encoded = args.map((a) => JSON.stringify(a)).join(', ')
  const expression = `
    (async () => {
      const control = window.__vjdjControl
      if (!control) throw new Error('controller not installed yet')
      const result = await control.${method}(${encoded})
      return JSON.stringify(result ?? null)
    })()`
  const json = (await window.webContents.executeJavaScript(expression)) as string
  return JSON.parse(json) as RawValue
}

export const startControlServer = async (
  engineWindow: BrowserWindow,
  requestedPort: number,
): Promise<ControlServer> => {
  const routes: Record<string, Handler> = {
    '/state': () => callRenderer(engineWindow, 'getState', []),
    '/params': (body) => callRenderer(engineWindow, 'setParams', [body ?? {}]),
    '/seek': (body) => {
      const seconds =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? Number((body as { [k: string]: RawValue })['seconds'] ?? 0)
          : 0
      return callRenderer(engineWindow, 'seek', [seconds])
    },
    '/playing': (body) => {
      const playing =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as { [k: string]: RawValue })['playing'] === true
          : false
      return callRenderer(engineWindow, 'setPlaying', [playing])
    },
    '/setVideoSource': (body) => {
      const url =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? String((body as { [k: string]: RawValue })['url'] ?? '')
          : ''
      return callRenderer(engineWindow, 'setVideoSource', [url])
    },
    '/setAudioSource': (body) => {
      const url =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? String((body as { [k: string]: RawValue })['url'] ?? '')
          : ''
      return callRenderer(engineWindow, 'setAudioSource', [url])
    },
    '/capture': (body) => {
      const record =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as { [k: string]: RawValue })
          : {}
      const seconds = record['seconds'] === undefined ? null : Number(record['seconds'])
      const maxWidth = Number(record['maxWidth'] ?? 900)
      return callRenderer(engineWindow, 'capture', [seconds, maxWidth])
    },
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? '/').split('?')[0] ?? '/'
      const handler = routes[path]
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: `unknown route ${path}` }))
        return
      }
      try {
        const body = await readBody(request)
        const result = await handler(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, result }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: message }))
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 127.0.0.1 限定。0.0.0.0 にしてはならない。
    server.listen(requestedPort, '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort
  console.log(`[control] listening on http://127.0.0.1:${String(port)}`)

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}
