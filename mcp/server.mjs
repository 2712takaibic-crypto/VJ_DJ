#!/usr/bin/env node
/**
 * VJDJ の MCP サーバー。
 *
 * plan.txt の「MCP を通して AI のプロンプトで同様の操作ができるように」を
 * 実現する。起動中の VJDJ (Electron) のローカル制御 API を叩く。
 *
 * **capture が中核**。
 * AI がプロンプトで VJ を操作するには、結果を見られることが前提になる。
 * 画を見ずにパラメータを触るのは目をつぶって色を選ぶのと同じで、
 * 「もう少し明るく」のような指示に応えようがない。
 * capture は画像そのものを返すので、AI が自分の操作結果を確認して
 * 次の調整を決められる。
 *
 * 使い方 (Claude Code の場合):
 *   claude mcp add vjdj -- node D:/Programs/VJ_DJ/mcp/server.mjs
 * 事前に `npm start` などで VJDJ を起動しておくこと。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const CONTROL_PORT = Number(process.env.VJDJ_CONTROL_PORT ?? '7321')
const BASE_URL = `http://127.0.0.1:${CONTROL_PORT}`

const call = async (path, body) => {
  let response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  } catch (error) {
    throw new Error(
      `VJDJ に接続できません (${BASE_URL})。アプリが起動しているか確認してください。`,
      { cause: error },
    )
  }
  const payload = await response.json()
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `control API error (${response.status})`)
  }
  return payload.result
}

const server = new McpServer({ name: 'vjdj', version: '0.1.0' })

// ---------------------------------------------------------------- 状態

server.registerTool(
  'get_state',
  {
    title: 'ショーの状態を取得',
    description:
      '現在の調整パラメータ、再生位置、BPM、ビート数、出力解像度を返す。' +
      'パラメータを変える前に、今どうなっているかを確認するのに使う。',
    inputSchema: {},
  },
  async () => {
    const state = await call('/state')
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] }
  },
)

// ---------------------------------------------------------------- 画の確認

server.registerTool(
  'capture',
  {
    title: '今の画を見る',
    description:
      '指定時刻のフレームを描画して画像で返す。' +
      'パラメータを変えたら必ずこれで結果を確認すること。' +
      '画を見ずに調整しても意図した絵にはならない。',
    inputSchema: {
      seconds: z.number().optional().describe('曲頭からの秒数。省略すると現在の再生位置'),
      maxWidth: z.number().optional().describe('返す画像の最大幅 (既定 900)'),
    },
  },
  async ({ seconds, maxWidth }) => {
    const dataUrl = await call('/capture', { seconds: seconds ?? null, maxWidth: maxWidth ?? 900 })
    const base64 = String(dataUrl).replace(/^data:image\/jpeg;base64,/, '')
    return {
      content: [
        { type: 'image', data: base64, mimeType: 'image/jpeg' },
        {
          type: 'text',
          text: `t=${seconds ?? '(current)'} の画。意図と違えば set_* で調整して再度 capture すること。`,
        },
      ],
    }
  },
)

// ---------------------------------------------------------------- 個別の調整

server.registerTool(
  'set_chroma',
  {
    title: 'クロマキーを調整',
    description:
      'グリーンバックの抜き具合を調整する。' +
      '緑の縁が残るなら choke を上げる。' +
      '被写体の一部まで消えるなら innerTolerance を下げる。' +
      'matteView を true にすると抜き具合だけを白黒で確認できる。',
    inputSchema: {
      innerTolerance: z.number().min(0).max(1).optional().describe('これ以下の色距離は完全透過'),
      outerTolerance: z.number().min(0).max(1).optional().describe('これ以上は完全不透過'),
      despill: z.number().min(0).max(1).optional().describe('緑かぶりの除去量'),
      choke: z.number().min(0).max(6).optional().describe('マットの収縮量 (テクセル)。縁消し'),
      brightness: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe('被写体の明るさ。白飛びするなら下げる'),
      matteView: z.boolean().optional().describe('マット単体表示'),
    },
  },
  async (args) => {
    const state = await call('/params', { chroma: args })
    return { content: [{ type: 'text', text: JSON.stringify(state.params.chroma, null, 2) }] }
  },
)

server.registerTool(
  'set_performer',
  {
    title: '被写体の配置を調整',
    description: 'ステージ上の被写体 (グリーンバックを抜いた映像) の大きさと位置。',
    inputSchema: {
      heightMeters: z.number().min(0.5).max(15).optional().describe('高さ (メートル)'),
      x: z.number().min(-10).max(10).optional().describe('左右位置'),
      z: z.number().min(-10).max(10).optional().describe('奥行き位置'),
      bounce: z.number().min(0).max(1).optional().describe('低音での上下量'),
    },
  },
  async (args) => {
    const state = await call('/params', { performer: args })
    return { content: [{ type: 'text', text: JSON.stringify(state.params.performer, null, 2) }] }
  },
)

server.registerTool(
  'set_bloom',
  {
    title: '発光 (bloom) を調整',
    description:
      '明るい部分のにじみ。強くすると華やかに、弱くすると引き締まる。' +
      'audioResponse を 0 にすると音に反応しなくなる。',
    inputSchema: {
      strength: z.number().min(0).max(3).optional(),
      radius: z.number().min(0).max(2).optional(),
      threshold: z.number().min(0).max(2).optional().describe('この明るさ以上がにじむ'),
      audioResponse: z.number().min(0).max(3).optional().describe('音への追従量'),
    },
  },
  async (args) => {
    const state = await call('/params', { bloom: args })
    return { content: [{ type: 'text', text: JSON.stringify(state.params.bloom, null, 2) }] }
  },
)

server.registerTool(
  'set_lasers',
  {
    title: 'レーザーを調整',
    description: 'ステージ上部から降るレーザービームの強さと振れ速度。',
    inputSchema: {
      enabled: z.boolean().optional(),
      intensity: z.number().min(0).max(3).optional(),
      sweep: z.number().min(0).max(4).optional().describe('振れる速さ'),
    },
  },
  async (args) => {
    const state = await call('/params', { lasers: args })
    return { content: [{ type: 'text', text: JSON.stringify(state.params.lasers, null, 2) }] }
  },
)

server.registerTool(
  'set_wall',
  {
    title: 'LED ウォールを調整',
    description:
      '背面のLEDウォールの配色。hue は 0=赤 0.33=緑 0.62=青 0.83=マゼンタ。' +
      '明るすぎると被写体が逆光で沈むので注意。',
    inputSchema: {
      hue: z.number().min(0).max(1).optional().describe('色相の中心'),
      hueRange: z.number().min(0).max(0.5).optional().describe('色相の振れ幅'),
      brightness: z.number().min(0).max(3).optional(),
    },
  },
  async (args) => {
    const state = await call('/params', { wall: args })
    return { content: [{ type: 'text', text: JSON.stringify(state.params.wall, null, 2) }] }
  },
)

server.registerTool(
  'set_camera',
  {
    title: 'カメラを調整',
    description:
      'auto は小節ごとにショットを切り替える。manual は shotIndex を固定する。' +
      'ショットは 0=正面ミディアム 1=下手寄り 2=上手ロー 3=引き。',
    inputSchema: {
      mode: z.enum(['auto', 'manual']).optional(),
      shotIndex: z.number().int().min(0).optional(),
      barsPerShot: z.number().int().min(1).max(64).optional().describe('切り替え間隔 (小節)'),
    },
  },
  async (args) => {
    const state = await call('/params', { camera: args })
    return { content: [{ type: 'text', text: JSON.stringify(state.params.camera, null, 2) }] }
  },
)

server.registerTool(
  'set_particles',
  {
    title: 'パーティクルを調整',
    description: '空間を舞う粒子。',
    inputSchema: {
      enabled: z.boolean().optional(),
      intensity: z.number().min(0).max(3).optional(),
    },
  },
  async (args) => {
    const state = await call('/params', { particles: args })
    return { content: [{ type: 'text', text: JSON.stringify(state.params.particles, null, 2) }] }
  },
)

server.registerTool(
  'set_lightning',
  {
    title: '電撃を調整',
    description:
      '小節頭で閃く稲妻。intensity を上げると発生頻度と明るさが上がる。' +
      '拍から決定的に形状を生成するので、書き出しても同じ絵になる。',
    inputSchema: {
      enabled: z.boolean().optional(),
      intensity: z.number().min(0).max(3).optional(),
    },
  },
  async (args) => {
    const state = await call('/params', { lightning: args })
    return { content: [{ type: 'text', text: JSON.stringify(state.params.lightning, null, 2) }] }
  },
)

// ---------------------------------------------------------------- 再生

server.registerTool(
  'seek',
  {
    title: '再生位置を移動',
    description: '指定秒へ移動する。特定の場面の画を作り込むときに使う。',
    inputSchema: { seconds: z.number().min(0).describe('曲頭からの秒数') },
  },
  async ({ seconds }) => {
    await call('/seek', { seconds })
    return { content: [{ type: 'text', text: `t=${seconds}s へ移動した` }] }
  },
)

server.registerTool(
  'set_playing',
  {
    title: '再生 / 一時停止',
    description: '調整中は一時停止しておくと、同じ画を見ながら追い込める。',
    inputSchema: { playing: z.boolean() },
  },
  async ({ playing }) => {
    await call('/playing', { playing })
    return { content: [{ type: 'text', text: playing ? '再生中' : '一時停止' }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
