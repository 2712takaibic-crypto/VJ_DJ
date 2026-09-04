# 詳細設計書 - VJ/DJ 統合ツール

- 作成日: 2026-08-18
- ステータス: Stage 2 (Design) — 初版・レビュー待ち
- 前提文書: `.tmp/requirements.md`

## 本設計書の適用範囲

本書は **Phase 0〜4 (基盤・VJ・同期・書き出し・タイムライン編集)** を実装可能な粒度で設計する。Phase 5 (DJ) / Phase 6 (DAW) は、基盤側に必要な拡張点 (インターフェース・データモデルの余地) のみを定義し、詳細は各フェーズ着手時に別途設計する。

### 調査手段に関する注記

プロジェクト規約では serena / context7 MCP の使用が指示されているが、本セッションでは両 MCP が未接続だった。既存コードは存在しない (グリーンフィールド) ため serena は不要。外部ライブラリについては Web 検索で以下を実地確認済み。

| 確認事項 | 結果 | 出典 |
|---|---|---|
| signalsmith-stretch のライセンスと Web Audio 対応 | **MIT**。公式の WASM + AudioWorkletProcessor ビルドが npm にあり (v1.3.2)、`splitComputation` で演算平準化、サンプル再生・ループ内蔵 | [Signalsmith Audio](https://signalsmith-audio.co.uk/code/stretch/web-audio/) / [GitHub](https://github.com/Signalsmith-Audio/signalsmith-stretch) |
| Electron の WebGPU 可用性 | Chromium 113 (Electron 25+) 以降で利用可。過去に `--enable-unsafe-webgpu` を要した経緯あり、**対象バージョンでの実測必須** | [electron#26944](https://github.com/electron/electron/issues/26944) |
| ImageBitmap のレンダラ間転送 | main プロセスは DOM オブジェクトをデシリアライズできず `ipcRenderer` 経由は**不可**。`MessageChannelMain` でポートのみ仲介すればレンダラ間で直接 transfer 可能 | [Electron MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports) |

この 3 点目が、要件定義時に「PoC で実測」としていたプレビュー転送問題 (R-1) の解になる。設計に反映済み (§2.2.10)。

---

## 1. アーキテクチャ概要

### 1.1 システム構成図

#### プロセス構成

```
┌──────────────────────────────────────────────────────────────────┐
│ Main Process (Node.js)                                           │
│                                                                  │
│  WindowManager      ProjectStore(正)    MediaJobRunner           │
│  ・ウィンドウ生成    ・CommandStack      ・FFmpeg 子プロセス       │
│  ・ディスプレイ列挙  ・JSON Patch 生成   ・probe / proxy / export  │
│  ・フルスクリーン    ・自動保存          ・ジョブキュー            │
│                                                                  │
│  IpcRouter (zod 検証)      NativeBridge (将来: ASIO / Spout)      │
└───┬──────────────────────────────────────────┬───────────────────┘
    │ ipcRenderer.invoke / webContents.send    │ MessageChannelMain
    │ (ProjectChannel: 永続・Undo対象)          │ (ポートの仲介のみ)
    │                                          │
┌───▼─────────────────────────┐          ┌─────▼───────────────────────┐
│ Control Window (Renderer)   │◄════════►│ Engine Host Window (Renderer)│
│                             │ Realtime │                             │
│  React UI                   │ Channel  │  ★ 全リアルタイム処理はここ  │
│  ・タイムライン (Canvas)     │ (直結)   │                             │
│  ・インスペクタ / ミキサー    │          │  Transport (マスタークロック)│
│  ・ライブラリ / パッドグリッド │          │  AudioEngine (WebAudio)     │
│  ・プレビュー表示 (<img>)    │          │  VideoEngine (WebGPU)       │
│                             │          │  Compositor / EffectChain   │
│  ※ GPU・音声を一切持たない   │          │  ClipPlayer (WebCodecs)     │
└─────────────────────────────┘          │  OutputPresenter (canvas)   │
                                         │  PreviewPublisher           │
         ImageBitmap を transfer ◄───────┤                             │
                                         └──────┬──────────────────────┘
                                                │ Worker (同一プロセス内)
                                    ┌───────────▼──────────────┐
                                    │ Worker Pool              │
                                    │ ・Demuxer (mp4box.js)    │
                                    │ ・Analysis (essentia.js) │
                                    │ ・Waveform / Thumbnail   │
                                    └──────────────────────────┘
```

#### 設計判断 A — 「Engine Host ウィンドウ」に全リアルタイム処理を集約する

要件定義では「レンダリングエンジンは出力ウィンドウ側に置く」としたが、設計段階で **音声エンジンも同一レンダラに置く** ことを確定する。

理由: マスタークロックはオーディオクロックである (F-C1)。映像は毎フレーム「今の音声時刻に対応するトランスポート位置」を問い合わせる。音声と映像が別プロセスにあると、この問い合わせが毎フレームの IPC 往復になり、レイテンシと jitter が同期精度 (NF-3) を直接破壊する。**同一レンダラ内なら同期呼び出しで済む。**

このウィンドウを本設計では **Engine Host** と呼ぶ。役割は 2 つ。

1. リアルタイムエンジンの実行コンテキスト
2. 出力映像の表示先 (2画面目フルスクリーン)

**常に生成し、常に可視に保つ**。2 画面目がない場合はプライマリディスプレイ上の通常ウィンドウとして表示する。`show: false` の隠しウィンドウは Chromium にバックグラウンドスロットリングされ `requestAnimationFrame` が停止するため採用しない (検索結果でも指摘されている既知の落とし穴)。加えて両ウィンドウで `webPreferences.backgroundThrottling: false` を設定する。

#### 設計判断 B — IPC を 2 系統に分離する

| チャネル | 経路 | 用途 | 特性 |
|---|---|---|---|
| **ProjectChannel** | Renderer ⇄ Main ⇄ Renderer | プロジェクト状態の変更 (クリップ追加、エフェクト追加、パラメータ確定値) | 永続化される / Undo 対象 / JSON Patch でブロードキャスト / 低頻度 |
| **RealtimeChannel** | Control ⇄ Engine (MessageChannelMain で直結) | ノブのドラッグ中の値、トランスポート操作、再生位置、レベルメーター、プレビュー画像 | 揮発 / Undo 非対象 / main を経由しない / 高頻度 (60Hz) |

これを分けないと、ノブを 1 回ドラッグしただけで数百件の Undo エントリが積まれ、かつ全操作が main プロセスを 2 回横断して UI が重くなる。**「ドラッグ中は RealtimeChannel、離した瞬間に ProjectChannel へ確定値を 1 件」** が原則。

### 1.2 技術スタック

| 分類 | 採用 | バージョン方針 | 備考 |
|---|---|---|---|
| 言語 | TypeScript | 5.x (strict, `noUncheckedIndexedAccess` 有効) | `any` / `unknown` / `class` 禁止 (§10.1) |
| ランタイム | Electron | 最新安定版。**Chromium 113 未満は不可** | WebGPU 実測を Phase 0 で行う |
| UI | React 19 + TypeScript | | タイムライン等の重量描画は Canvas 2D で自前実装 |
| 状態管理 | Zustand | | 高頻度値はストア外 (§4.1) |
| ビルド | Vite + electron-vite | | |
| パッケージ | electron-builder (NSIS / portable) | | |
| スキーマ検証 | zod | 4.x | IPC 境界とプロジェクトファイルの検証。`unknown` を型に漏らさないための要 |
| 映像デコード | WebCodecs `VideoDecoder` | ブラウザ標準 | |
| デマックス | mp4box.js | | Worker 内で実行 |
| 映像合成 | WebGPU / WGSL | ブラウザ標準 | |
| 音声 | Web Audio API + AudioWorklet | ブラウザ標準 | バックエンド抽象化の背後 (§2.3.1) |
| タイムストレッチ | **signalsmith-stretch** (npm, MIT) | 1.3.x | 公式 AudioWorklet ビルドを使用 |
| 音楽解析 | essentia.js (WASM) | | BPM / ビート / キー / オンセット |
| メディア変換 | FFmpeg (バンドル実行ファイル) | 7.x | 子プロセスとして main から起動 |
| MIDI | Web MIDI API | ブラウザ標準 | Electron 側で権限許可が必要 |
| テスト | Vitest + Playwright(Electron) | | 詳細は `/test-design` |

**採用しない**: VST/AU (ネイティブホストが必要)、Pioneer HID (プロトコル非公開)、Tauri (WebView2 のバージョン差異で WebCodecs/WebGPU 挙動が不定)。

### 1.3 ディレクトリ構成

```
src/
  main/                    # Electron main プロセス
    windows/               # WindowManager, DisplayWatcher
    project/               # ProjectStore(正), CommandStack, Persistence, Migration
    media/                 # FFmpegRunner, ProbeService, ProxyService, ExportService, JobQueue
    ipc/                   # IpcRouter, channel 定義, zod 検証
    native/                # 将来のネイティブアドオン境界 (Phase 7)
  engine/                  # Engine Host レンダラで動く純ロジック
    clock/                 # TempoMap, Transport, ClockSource, LookaheadScheduler
    video/
      decode/              # ClipPlayer, DecoderPool, FrameRing, DemuxClient
      gpu/                 # GpuContext, TexturePool, PipelineCache, BindGroupCache
      graph/               # CompositionEvaluator, BlendStage, EffectChain
      effects/             # 各エフェクト定義 (descriptor + WGSL)
      output/              # OutputPresenter, PreviewPublisher, TestPattern
    audio/
      backend/             # AudioBackend I/F, WebAudioBackend
      nodes/               # deck, mixer, eq3, filter, meter
      worklets/            # stretch(signalsmith), meter, sampler
    modulation/            # LFO, BeatTrigger, AudioReactive
    render/                # OfflineRenderer (決定性レンダリング駆動)
  ui/                      # Control Window (React)
    timeline/ inspector/ mixer/ library/ padgrid/ preview/ settings/
  shared/                  # 両プロセス共有
    units/                 # Ticks, Seconds, Samples の branded type
    schema/                # zod スキーマ (Project, IPC メッセージ)
    protocol/              # チャネル定義, メッセージ型
  workers/                 # analysis, waveform, thumbnail, demux
resources/
  ffmpeg/                  # バンドル実行ファイル (asar 外)
```

---

## 2. コンポーネント設計

### 2.1 コンポーネント一覧

| # | コンポーネント | 責務 | 配置 | 依存 |
|---|---|---|---|---|
| 1 | WindowManager | ウィンドウ生成、ディスプレイ列挙・変化監視、フルスクリーン制御、MessageChannel 仲介 | Main | — |
| 2 | ProjectStore | プロジェクト状態の正本を保持。Command 適用と JSON Patch 生成 | Main | CommandStack, Persistence |
| 3 | CommandStack | Undo/Redo。Command の逆操作を保持 | Main | — |
| 4 | Persistence | プロジェクトファイル入出力、自動保存、スナップショット、スキーマ移行 | Main | zod schema |
| 5 | MediaJobRunner | FFmpeg 子プロセスの起動・キュー・進捗・キャンセル | Main | FFmpegRunner |
| 6 | ProbeService | メディアのメタデータ取得 | Main | MediaJobRunner |
| 7 | ProxyService | プロキシ生成 (全 I フレーム fMP4) | Main | MediaJobRunner |
| 8 | ExportService | 生フレーム受け取り → エンコード → 多重化 | Main | MediaJobRunner |
| 9 | IpcRouter | 全 IPC の入口。zod 検証、ルーティング、エラー整形 | Main | shared/schema |
| 10 | **TempoMap** | tick ⇄ 秒の相互変換、拍・小節の算出 | Engine | — |
| 11 | **Transport** | 再生状態、再生位置の権威。アンカー方式で drift なし | Engine | TempoMap, ClockSource |
| 12 | ClockSource | 時間源の抽象 (リアルタイム / オフライン) | Engine | AudioBackend |
| 13 | LookaheadScheduler | 音声イベントの先読みスケジューリング | Engine | Transport |
| 14 | GpuContext | GPUDevice のライフサイクル、デバイスロスト復旧 | Engine | — |
| 15 | TexturePool | テクスチャの再利用プール。リーク防止の要 | Engine | GpuContext |
| 16 | PipelineCache | パイプライン・バインドグループのキャッシュ | Engine | GpuContext |
| 17 | ClipPlayer | 1 クリップのデコードとフレーム供給 | Engine | DecoderPool, DemuxClient |
| 18 | DecoderPool | VideoDecoder の上限管理と LRU 退避 | Engine | GpuContext |
| 19 | **CompositionEvaluator** | 毎フレームのレイヤー評価と合成 | Engine | TexturePool, ClipPlayer, EffectChain |
| 20 | EffectChain | レイヤー/マスターのエフェクト適用 (ping-pong) | Engine | EffectRegistry, TexturePool |
| 21 | EffectRegistry | エフェクト定義の登録。descriptor から UI と WGSL を導出 | Engine/共有 | — |
| 22 | OutputPresenter | 最終テクスチャを出力 canvas へ提示 | Engine | GpuContext |
| 23 | **PreviewPublisher** | 縮小 ImageBitmap を生成し Control へ transfer | Engine | GpuContext |
| 24 | **AudioBackend** | 音声実装の抽象。WebAudio 実装を同梱 | Engine | — |
| 25 | AudioGraph | 記述子からノードグラフを構築・更新 | Engine | AudioBackend |
| 26 | ModulationEngine | LFO・ビートトリガ・音声反応によるパラメータ変調 | Engine | Transport, AudioBackend |
| 27 | OfflineRenderer | 固定タイムステップの決定性レンダリング駆動 | Engine | Transport, CompositionEvaluator, AudioBackend |
| 28 | AnalysisService | BPM/キー/波形/サムネイル解析 (Worker) | Worker | essentia.js |
| 29 | ControlSurface | MIDI 入出力、MIDI ラーン、マッピング適用 | Engine | Web MIDI |

太字は本プロジェクトの中核であり、設計を誤ると影響範囲が広い。

---

### 2.2 中核コンポーネントの詳細

#### 2.2.1 単位型 (shared/units)

すべての時間量に branded type を用いる。本アプリでは tick / 秒 / サンプル / フレーム番号が常に併存し、素の `number` では取り違えが必ず起きる。

```typescript
declare const brand: unique symbol

type Brand<T, B extends string> = T & { readonly [brand]: B }

export type Ticks = Brand<number, 'Ticks'>       // PPQ=960 の楽曲内位置
export type Seconds = Brand<number, 'Seconds'>   // タイムライン上の秒
export type AudioTime = Brand<number, 'AudioTime'> // AudioContext.currentTime 系
export type Samples = Brand<number, 'Samples'>
export type FrameIndex = Brand<number, 'FrameIndex'>
export type Beats = Brand<number, 'Beats'>

export const ticks = (n: number): Ticks => n as Ticks
export const seconds = (n: number): Seconds => n as Seconds
// 以下同様

export const PPQ = 960
```

`Seconds` と `AudioTime` を分けている点が重要。前者はタイムラインの原点からの経過、後者は AudioContext の起動からの経過であり、両者の変換は Transport のアンカーを介してのみ行う。

#### 2.2.2 TempoMap

```typescript
export type TempoEvent = { readonly tick: Ticks; readonly bpm: number }
export type MeterEvent = { readonly tick: Ticks; readonly numerator: number; readonly denominator: number }

export type TempoMap = {
  /** tick 昇順。先頭は必ず tick=0 */
  readonly tempos: readonly TempoEvent[]
  readonly meters: readonly MeterEvent[]
}

/** 変換に必要な前計算済みセグメント */
export type TempoIndex = {
  toSeconds(t: Ticks): Seconds
  toTicks(s: Seconds): Ticks
  bpmAt(t: Ticks): number
  /** 小節・拍・tick への分解 (1 始まり) */
  toBarBeat(t: Ticks): { bar: number; beat: number; tick: number }
  fromBarBeat(bar: number, beat: number, tick?: number): Ticks
  /** 直近の拍/小節境界へのスナップ */
  snap(t: Ticks, grid: SnapGrid): Ticks
}

export type SnapGrid =
  | { readonly kind: 'off' }
  | { readonly kind: 'bar' }
  | { readonly kind: 'beat'; readonly division: number }  // 1=四分, 2=八分, 4=十六分, 3=三連

export const createTempoIndex = (map: TempoMap): TempoIndex => { /* ... */ }
```

**実装方針**

- 生成時に各テンポイベントの累積秒を前計算し、`{ tick, seconds, secondsPerTick }` のセグメント配列を作る
- 変換は二分探索 + セグメント内の線形計算。O(log n)
- **テンポ変更は階段状 (ジャンプ) のみとし、リニアランプは v1 では実装しない。** ランプは秒への変換に積分が必要で、逆変換に解析解を持たせるとコードが 3 倍になる。VJ/DJ 用途で線形ランプの必要性は薄い。将来必要になったらセグメント種別を増やして拡張する
- `TempoIndex` は immutable。TempoMap が変わったら作り直す (頻度が低いので問題ない)

#### 2.2.3 ClockSource と Transport

**ここが本プロジェクトで最も重要な設計。**

```typescript
export type ClockSource = {
  /** 現在の音声時刻 */
  now(): AudioTime
  /**
   * 音声時刻と performance タイムラインの対応点。
   * リアルタイム実装は AudioContext.getOutputTimestamp() を使う。
   */
  calibrate(): { readonly audioTime: AudioTime; readonly perfTime: number }
}
```

`AudioContext.getOutputTimestamp()` は `{ contextTime, performanceTime }` を返し、これがまさに「今スピーカーから出ている音の音声時刻と、それが起きた実時刻」の対応点である。この API のためにこの設計が成立する。

```typescript
export type TransportState =
  | { readonly kind: 'stopped'; readonly positionTicks: Ticks }
  | {
      readonly kind: 'playing'
      /** アンカー: この音声時刻に、この tick にいた */
      readonly anchorAudioTime: AudioTime
      readonly anchorTicks: Ticks
      readonly rate: number            // 1.0 = 等速
      readonly loop: LoopRegion | null
    }

export type LoopRegion = { readonly startTicks: Ticks; readonly endTicks: Ticks }

export type Transport = {
  getState(): TransportState
  /** 任意の音声時刻におけるトランスポート位置 */
  positionAt(audioTime: AudioTime): Ticks
  /** 現在位置 (= positionAt(clock.now())) */
  position(): Ticks
  /**
   * 描画フレーム用。rAF のタイムスタンプから、
   * そのフレームが実際に画面に出る瞬間のトランスポート位置を推定する。
   */
  positionForFrame(rafTimestamp: number): Ticks

  play(fromTicks?: Ticks): void
  pause(): void
  stop(): void
  seek(to: Ticks): void
  setRate(rate: number): void
  setLoop(loop: LoopRegion | null): void

  subscribe(listener: (s: TransportState) => void): () => void
}
```

**アンカー方式の要点**

再生位置を「毎フレーム加算するカウンタ」で持ってはならない。浮動小数の誤差が蓄積し、30 分後には確実にずれる (NF-3 違反)。代わりに **(音声時刻, tick) のアンカー 1 組**を持ち、位置は常にそこからの差分で計算する。

```
positionAt(audioTime) =
  tempoIndex.toTicks(
    tempoIndex.toSeconds(anchorTicks) + (audioTime - anchorAudioTime) * rate
  )
```

シークとレート変更は「現在位置でアンカーを打ち直す」だけ。ループも「ループ端に達したら start でアンカーを打ち直す」。誤差は蓄積しない。

**`positionForFrame` の実装**

```typescript
const positionForFrame = (rafTimestamp: number): Ticks => {
  const { audioTime, perfTime } = clock.calibrate()
  // rAF コールバック時点の音声時刻へ換算
  const atRaf = audioTime + (rafTimestamp - perfTime) / 1000
  // 描画したフレームが実際に見えるのは概ね次の vsync 以降
  const presentation = atRaf + frameInterval + settings.avOffsetSeconds
  return transport.positionAt(presentation as AudioTime)
}
```

`avOffsetSeconds` は**ユーザーが設定画面で調整できる A/V オフセット (ms)** とする。ディスプレイやプロジェクタの内部遅延は API から知りようがないため、最終的な追い込みは手動調整に委ねるのが唯一現実的な解。市販 VJ ソフトも同様。

**音声イベントと映像状態の扱いを分ける**

| | 方式 | 理由 |
|---|---|---|
| 音声 (ノート発音、サンプルトリガ、ループ点) | **先読みスケジューリング**。25ms 間隔のタイマーで 100ms 先までのイベントを `AudioParam` / `start(when)` に予約 | Web Audio はサンプル精度の予約が可能。JS のタイマー精度に依存させてはならない |
| 映像 (レイヤー状態、エフェクト値) | **毎フレームのサンプリング**。`positionForFrame` で位置を得て、その時点の値を計算 | 映像はフレーム単位でしか変化しない。イベントは不要 |

この区別を曖昧にすると「映像がカクつく」「音がヨレる」の両方を招く。

```typescript
export type LookaheadScheduler = {
  /** 音声イベント供給者を登録 */
  register(source: ScheduledSource): () => void
  start(): void
  stop(): void
}

export type ScheduledSource = {
  /** [fromTicks, toTicks) の区間で発火すべきイベントを返す */
  collect(fromTicks: Ticks, toTicks: Ticks): readonly ScheduledEvent[]
}

export type ScheduledEvent = {
  readonly atTicks: Ticks
  readonly atAudioTime: AudioTime
  readonly payload: EventPayload
}
```

#### 2.2.4 GpuContext とリソース管理

```typescript
export type GpuContext = {
  readonly device: GPUDevice
  readonly preferredFormat: GPUTextureFormat
  /** デバイスロスト時に全リソースを再構築するためのフック */
  onDeviceLost(handler: (info: GPUDeviceLostInfo) => void): () => void
  destroy(): void
}
```

**GPU デバイスロストは必ず起きる前提で設計する。** ドライバ更新・TDR・スリープ復帰で `device.lost` は発火する。発火したら全 GPU リソース (テクスチャ・バッファ・パイプライン) が無効になるため、**すべてのリソースを記述子から再生成できる構造**にしておく。後付けはほぼ不可能なので Phase 1 から入れる。

```typescript
export type TexturePool = {
  /** 指定仕様のテクスチャを借りる。使い終わったら必ず release */
  acquire(spec: TextureSpec): PooledTexture
  release(t: PooledTexture): void
  /** フレーム終了時に未返却があれば警告 (開発時のリーク検知) */
  endFrame(): void
  recreateAll(): void   // デバイスロスト復旧用
}

export type TextureSpec = {
  readonly width: number
  readonly height: number
  readonly format: GPUTextureFormat
  readonly usage: GPUTextureUsageFlags
}
```

**中間テクスチャのフォーマットは `rgba16float` を既定とする。** 合成はリニア色空間・プリマルチプライドアルファで行い、`rgba8unorm` ではエフェクトを重ねた際にバンディングとクリップが出る。メモリは 2 倍になるが 1080p×16 レイヤーでも 250MB 程度で許容範囲。

#### 2.2.5 CompositionEvaluator (合成の中核)

```typescript
export type Composition = {
  readonly size: { readonly width: number; readonly height: number }
  readonly fps: number
  readonly layers: readonly Layer[]        // index 0 が最背面
  readonly masterEffects: readonly EffectInstance[]
}

export type Layer = {
  readonly id: LayerId
  readonly name: string
  readonly source: LayerSource
  readonly transform: Transform2D
  readonly opacity: Modulatable<number>
  readonly blendMode: BlendMode
  readonly effects: readonly EffectInstance[]
  readonly mask: MaskConfig | null
  readonly enabled: boolean
  readonly solo: boolean
}

export type LayerSource =
  | { readonly kind: 'clip'; readonly clips: readonly TimelineClip[] }
  | { readonly kind: 'still'; readonly assetId: AssetId }
  | { readonly kind: 'camera'; readonly deviceId: string }
  | { readonly kind: 'solid'; readonly color: RGBA }
  | { readonly kind: 'gradient'; readonly stops: readonly GradientStop[]; readonly angle: number }
  | { readonly kind: 'generative'; readonly shaderId: string; readonly params: ParamValues }
  | { readonly kind: 'group'; readonly children: readonly Layer[] }

export type BlendMode =
  | 'normal' | 'add' | 'screen' | 'multiply'
  | 'overlay' | 'difference' | 'lighten' | 'darken'
  | 'softLight' | 'hardLight' | 'colorDodge' | 'colorBurn' | 'exclusion'

export type CompositionEvaluator = {
  /** 指定 tick の 1 フレームを合成し、結果テクスチャを返す */
  evaluate(atTicks: Ticks, ctx: EvalContext): Promise<PooledTexture>
  prepare(atTicks: Ticks): Promise<void>   // 先読み (デコード要求のみ発行)
}

export type EvalContext = {
  readonly mode: 'realtime' | 'offline'
  /** offline では欠落フレームを待つ。realtime では直近フレームで代替 */
  readonly allowFrameSubstitution: boolean
  readonly quality: 'preview' | 'full'
}
```

**評価アルゴリズム (1 フレーム)**

```
1. accumulator ← TexturePool.acquire(compSize, rgba16float)  … 透明でクリア
2. 可視レイヤーを背面から順に:
   a. source を解決してソーステクスチャを得る
      - clip:  ClipPlayer.frameAt(localTick) → VideoFrame → copyExternalImageToTexture
      - group: 再帰的に evaluate
   b. sRGB → リニアへ変換 (ソース取り込み時に一度だけ)
   c. EffectChain を適用 (ping-pong)
   d. mask があればマット生成 → アルファに乗算
   e. transform + opacity + blendMode で accumulator へ合成
      - 合成はシェーダで行うため accumulator も ping-pong (読み書き同時不可)
3. masterEffects を適用
4. accumulator を返す (呼び出し側が release する責務を持つ)
```

**ブレンドの高速パスと汎用パス**

`normal` / `add` / `multiply` / `screen` は WebGPU の固定機能ブレンド (`GPUBlendState`) で表現でき、accumulator の ping-pong が不要。`overlay` 以降はシェーダで accumulator をテクスチャとして読む必要があり ping-pong が要る。**レイヤーのブレンドモードに応じて両者を切り替える**。実測で 8 レイヤー全部が固定機能に乗ると描画時間がおよそ半分になるため、この最適化は入れる価値がある。

**ユニフォームのパッキング**

レイヤーごとに `device.queue.writeBuffer` を呼ぶとコール数が線形に増えて CPU 律速になる。**全レイヤーのユニフォームを 1 本の大きなバッファにパックし、動的オフセット付きバインドグループで参照する**。バッファはトリプルバッファリング (3 本のリング) にして GPU の使用中バッファへの書き込みストールを避ける。

#### 2.2.6 EffectRegistry — 宣言的エフェクト定義

エフェクトは「パラメータ記述子 + WGSL パス定義」の純データとして定義し、そこから **UI・ユニフォーム構造体・バインドグループレイアウトをすべて自動導出する**。エフェクトを 1 つ足すのに UI コードを書かなくて済む状態を維持する。

```typescript
export type ParamDescriptor =
  | { readonly kind: 'float'; readonly key: string; readonly label: string
      readonly min: number; readonly max: number; readonly defaultValue: number
      readonly curve?: 'linear' | 'log'; readonly unit?: string; readonly modulatable: boolean }
  | { readonly kind: 'int'; readonly key: string; readonly label: string
      readonly min: number; readonly max: number; readonly defaultValue: number }
  | { readonly kind: 'bool'; readonly key: string; readonly label: string; readonly defaultValue: boolean }
  | { readonly kind: 'color'; readonly key: string; readonly label: string; readonly defaultValue: RGBA }
  | { readonly kind: 'vec2'; readonly key: string; readonly label: string
      readonly min: Vec2; readonly max: Vec2; readonly defaultValue: Vec2; readonly modulatable: boolean }
  | { readonly kind: 'enum'; readonly key: string; readonly label: string
      readonly options: readonly { readonly value: string; readonly label: string }[]
      readonly defaultValue: string }

export type PassDefinition = {
  readonly id: string
  readonly wgsl: string
  /** このパスの入力 ('source' | 前パスの id | 'sceneBackdrop') */
  readonly inputs: readonly string[]
  /** 出力解像度の倍率 (ブラー等のダウンサンプル用) */
  readonly scale?: number
  /** 分離可能フィルタなどで同一パスを複数回実行する場合 */
  readonly iterations?: number | { readonly fromParam: string }
}

export type EffectDefinition = {
  readonly id: string
  readonly label: string
  readonly category: 'color' | 'blur' | 'distort' | 'stylize' | 'key' | 'time'
  readonly params: readonly ParamDescriptor[]
  readonly passes: readonly PassDefinition[]
}

export type EffectInstance = {
  readonly instanceId: string
  readonly effectId: string
  readonly enabled: boolean
  readonly values: Readonly<Record<string, Modulatable<ParamValue>>>
}
```

ユニフォーム構造体は `params` から WGSL のソース文字列として生成し、各パスの WGSL 先頭に挿入する。WGSL の uniform アドレス空間はアライメント規則 (vec2 は 8 バイト、vec3/vec4 は 16 バイト境界) が厳格なので、**パッキング処理は 1 箇所に集約し、単体テストを厚くする** (§7 で扱う)。

#### 2.2.7 クロマキー (F-V2) の具体設計

要件の中核であり、実装の質がそのままツールの価値になるため、アルゴリズムを確定させる。`chromaKey` という 1 つの `EffectDefinition` として、4 パス構成で実装する。

**パラメータ**

| key | 種別 | 既定 | 説明 |
|---|---|---|---|
| `keyColor` | color | (0,1,0) | スポイトで取得 |
| `innerTolerance` | float 0–1 | 0.08 | これ以下の色距離は完全透過 |
| `outerTolerance` | float 0–1 | 0.22 | これ以上の色距離は完全不透過 |
| `choke` | float -10–10 px | 0 | 負=収縮 / 正=膨張 |
| `feather` | float 0–20 px | 1.5 | マットのぼかし半径 |
| `despill` | float 0–1 | 0.8 | スピル抑制の強さ |
| `lightWrap` | float 0–1 | 0 | 背景の回り込み (P1) |
| `viewMode` | enum | `composite` | `composite` / `matte` / `despillOnly` |

**Pass 1: マット生成**

RGB 閾値ではなく **YCbCr の CbCr 平面上での距離**で判定する。輝度変化 (被写体の影、照明ムラ) に対して頑健になるのがこの方式の利点。

```wgsl
fn rgbToCbCr(c: vec3f) -> vec2f {
  // BT.709
  let y = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return vec2f((c.b - y) / 1.8556, (c.r - y) / 1.5748);
}

@fragment fn matte(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSample(srcTex, samp, uv);
  let d = distance(rgbToCbCr(src.rgb), rgbToCbCr(u.keyColor.rgb));
  // d が小さい = キー色に近い = 透過
  let a = smoothstep(u.innerTolerance, u.outerTolerance, d);
  return vec4f(a, 0.0, 0.0, 1.0);   // r チャンネルにマットを格納
}
```

**Pass 2: チョーク (収縮/膨張)** — カーネル内の min (収縮) / max (膨張)。半径は `choke` の絶対値。

**Pass 3: フェザー** — 分離可能ガウシアン (水平・垂直の 2 回)。

**Pass 4: 合成 + デスピル**

```wgsl
// キー色軸方向の残留を抑える (緑の場合 g が r,b の最大値を超える分を削る)
fn despillGreen(c: vec3f, amount: f32) -> vec3f {
  let m = max(c.r, c.b);
  return vec3f(c.r, select(c.g, mix(c.g, m, amount), c.g > m), c.b);
}
```

キー色が緑以外 (青バック等) の場合に備え、**キー色の主成分チャンネルを実行時に判定して軸を選ぶ**汎用実装にする。

出力は**プリマルチプライドアルファ**。`viewMode: 'matte'` はマットをグレースケール表示し、調整作業を可能にする。市販ソフトでこのモードがないものはまず使い物にならない。

**ライトラップ (P1)** は、背景レイヤーをぼかしたテクスチャを `sceneBackdrop` として受け取り、`(1 - alpha)` で重み付けして輪郭に加算する。この機能のためだけに `EffectChain` は「背後の accumulator を入力として受け取れる」仕組みを持つ必要がある (`PassDefinition.inputs` の `'sceneBackdrop'`)。

**AI セグメンテーション (P2)** は同じ `EffectDefinition` の枠組みで、Pass 1 を ONNX Runtime Web の推論結果テクスチャに差し替える形で追加できる。Pass 2〜4 はそのまま流用できる設計になっている。

#### 2.2.8 ClipPlayer と DecoderPool

```typescript
export type ClipPlayer = {
  /** クリップローカル時刻のフレームを要求 */
  frameAt(localSeconds: Seconds, ctx: EvalContext): Promise<VideoFrame | null>
  /** 先読み要求 (await しない) */
  prefetch(localSeconds: Seconds, direction: 1 | -1): void
  release(): void
}
```

**設計上の要点**

1. **プロキシが全 I フレームであることが、この設計全体を成立させている。** 任意フレームへのシークが「該当サンプルを 1 個デコードする」だけで済み、逆再生も可能になる。Long-GOP のままではどちらも成立しない
2. **`VideoFrame.close()` を必ず呼ぶ。** WebCodecs で最も多い実害のあるバグがフレームリーク。数フレーム溜まるとデコーダが `dequeue` を止めて再生が停止する。`FrameRing` が所有権を一元管理し、リング外に生の `VideoFrame` を漏らさない
3. **同時デコーダ数の上限。** コンシューマ GPU のハードウェア H.264 デコードセッションは概ね 3〜8 本。要件の 8〜16 レイヤーはこれを超えうる。`DecoderPool` が上限 (既定 6、設定可能) を持ち、超過分は LRU で解放するか `hardwareAcceleration: 'prefer-software'` にフォールバックする。**これは Phase 0 の PoC 項目 4 で実測して既定値を決める**
4. **realtime と offline で挙動を変える。** realtime はフレームが間に合わなければ直近のフレームを再利用して描画を止めない (`allowFrameSubstitution: true`)。offline は必ず待つ

#### 2.2.9 OutputPresenter

出力 canvas は `GPUCanvasContext` に `configure({ device, format, alphaMode: 'opaque' })` で接続する。合成解像度 (プロジェクト設定) と出力ディスプレイ解像度は独立しており、最終段でアスペクト比を保ったスケーリング (レターボックス) を行う。

- テストパターン表示 (グリッド + セーフエリア + 解像度表示) を切り替え可能に
- ディスプレイ切断時は `screen` の `display-removed` を WindowManager が受け、プライマリへ復帰させる

#### 2.2.10 PreviewPublisher — R-1 の解決

Web 検索で確認したとおり、`ImageBitmap` は main プロセスを通せないが、`MessageChannelMain` でポートだけを仲介すればレンダラ間で直接 transfer できる。これが最も筋の良い経路になる。

```typescript
export type PreviewPublisher = {
  configure(cfg: { readonly width: number; readonly fps: number }): void
  /** 合成結果テクスチャからプレビューを 1 枚発行 (フレームレート制限つき) */
  publish(source: PooledTexture, atTicks: Ticks): void
}
```

**実装フロー**

```
合成結果テクスチャ
  → 縮小描画 (既定 480×270) を OffscreenCanvas へ
  → offscreen.transferToImageBitmap()
  → port.postMessage({ bitmap, atTicks }, [bitmap])   ← transfer (ピクセルコピーなし)
Control 側:
  → createImageBitmap 済みなのでそのまま canvas.drawImage / <img> へ
  → 表示後に bitmap.close()
```

**設計上の注意**

- **フレームレートを分離する。** 出力は 60fps でもプレビューは 30fps で十分。`fps` を設定可能にし、既定 30。負荷が高い環境では 15 まで落とせるようにする
- **背圧制御。** Control 側の描画が追いつかない場合に postMessage が溜まると破綻する。Control から `ack` を返させ、**未 ack が 2 枚を超えたら発行をスキップする**
- **`bitmap.close()` を必ず呼ぶ。** VideoFrame と同じくリークする
- **ポート受け渡しのハンドシェイク。** Electron の既知の落とし穴として、`ready-to-show` でポートを送ると受信側のリスナ登録前に届いて取りこぼす事例が報告されている。**レンダラ側から `ipcRenderer.send('engine:ready')` を送り、それを受けて main がポートを配る**方式にする

代替案として `copyTextureToBuffer` + `mapAsync` によるピクセル読み戻しがあるが、非同期マップで 1〜2 フレーム遅れる上に CPU コピーが入る。**ImageBitmap 経路を第一候補、読み戻しを Phase 0 で不調だった場合のフォールバックとする。**

#### 2.2.11 AudioBackend — 差し替え可能性の担保

> **【2026-08-19 更新】この節の前提は変わった。**
>
> 本節の設計は、要件 R-2 (Web Audio でヘッドホンキューを実現できない可能性) に備えて
> 音声実装を差し替え可能にすることを目的としていた。
> しかし **ユーザーがオーディオIF を保有せず購入予定もないため、キューはスコープ外として確定した**
> (要件 F-D3 / PC003)。ネイティブバックエンドを必要とする唯一の機能がなくなり、
> 用途も制作中心 (低レイテンシ要求が緩い) であるため、**この抽象化を維持する根拠は大きく後退した。**
>
> **Phase 2 着手時 (P2-1) に以下を判断すること:**
>
> - **推奨**: `AudioBackend` インターフェースと `AudioGraphDesc` による間接層を廃し、
>   Web Audio に直接書く。ただし Web Audio 固有の記述を `src/engine/audio/` に閉じ込め、
>   将来の差し替えが「そのディレクトリの書き直し」で済む範囲に留める。
>   検証されない抽象化は、実際に差し替えるときに結局動かない。
> - ケイパビリティ判定 (`maxChannelCount` の実行時取得) は残す。
>   出力デバイスの選択 UI に必要であり、コストも小さい。
> - `outputs.cue` は型から削除してよい。
>
> 以下の記述は当初設計として残す。

要件 R-2 (ヘッドホンキューが Web Audio で実現できない可能性) に備え、**音声実装をインターフェースの背後に置く**。ただし Web Audio のノードグラフ API をそのまま抽象化すると抽象化コストが実装コストを上回るため、**抽象化の粒度を「本アプリが必要とするノード種別」に限定する**。

```typescript
export type AudioNodeDesc =
  | { readonly kind: 'player'; readonly assetId: AssetId; readonly stretch: StretchConfig | null }
  | { readonly kind: 'gain'; readonly gain: number }
  | { readonly kind: 'eq3'; readonly low: number; readonly mid: number; readonly high: number }
  | { readonly kind: 'filter'; readonly type: 'lowpass' | 'highpass'; readonly freq: number; readonly q: number }
  | { readonly kind: 'meter' }
  | { readonly kind: 'analyser'; readonly bands: number }
  | { readonly kind: 'sendFx'; readonly fx: SendFxConfig }

export type AudioGraphDesc = {
  readonly nodes: Readonly<Record<string, AudioNodeDesc>>
  readonly edges: readonly { readonly from: string; readonly to: string }[]
  /** 出力ルーティング。master は ch1/2、cue は ch3/4 を想定 */
  readonly outputs: {
    readonly master: { readonly node: string; readonly channels: readonly [number, number] }
    readonly cue: { readonly node: string; readonly channels: readonly [number, number] } | null
  }
}

export type AudioBackend = {
  readonly kind: 'webaudio' | 'native'
  readonly capabilities: {
    readonly maxOutputChannels: number
    readonly supportsIndependentCue: boolean
    readonly reportedLatencySeconds: number
  }
  init(cfg: AudioDeviceConfig): Promise<void>
  readonly clock: ClockSource
  applyGraph(desc: AudioGraphDesc): void
  /** 高頻度パラメータ更新 (ノブのドラッグ中など) */
  setParam(nodeId: string, key: string, value: number, atAudioTime?: AudioTime): void
  renderOffline(range: { from: Seconds; to: Seconds }, sampleRate: number): Promise<AudioBuffer>
  dispose(): Promise<void>
}
```

**WebAudioBackend での cue 出力**

```typescript
// AudioContext を最大チャンネル数で開き、ChannelMergerNode で 4ch へ配線する
const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
ctx.destination.channelCount = ctx.destination.maxChannelCount   // 4 以上なら cue 可能
ctx.destination.channelCountMode = 'explicit'
ctx.destination.channelInterpretation = 'discrete'
const merger = ctx.createChannelMerger(4)   // 0,1 = master / 2,3 = cue
```

`maxChannelCount` が 4 未満なら `supportsIndependentCue: false` を報告し、UI 側は cue 機能を無効表示にする。**この判定を実行時に行い、機能の有無をケイパビリティとして扱う**ことで、環境差を設計に織り込む。

**タイムストレッチ**

signalsmith-stretch の公式 Web Audio ビルド (MIT) をそのまま使う。`SignalsmithStretch(audioContext)` が AudioWorkletNode を返す API 形態で、サンプル再生・ループ・ピッチ/テンポ独立制御・`splitComputation` による演算平準化まで揃っており、DJ デッキ (F-D1) の要求をほぼ満たす。自前実装は行わない。

`splitComputation: true` を既定とする。これは出力レイテンシが 1 インターバル増える代わりに演算バーストを均すオプションで、複数デッキ同時再生時のドロップアウト (R-3) 対策として有効。

#### 2.2.12 ModulationEngine (BPM 同期の実体)

要件 F-V3「すべてのエフェクトパラメータは BPM 同期可能」を実現する仕組み。パラメータ値を「静的値」ではなく「変調可能な値」として型で表現する。

```typescript
export type Modulatable<T> = {
  readonly base: T
  readonly modulators: readonly Modulator[]
  readonly keyframes: readonly Keyframe<T>[] | null
}

export type Modulator =
  | { readonly kind: 'lfo'; readonly shape: LfoShape; readonly rate: MusicalRate
      readonly depth: number; readonly phase: number; readonly bipolar: boolean }
  | { readonly kind: 'beatTrigger'; readonly division: MusicalRate
      readonly attack: number; readonly decay: number; readonly depth: number }
  | { readonly kind: 'audioReactive'; readonly band: 'low' | 'mid' | 'high' | 'full'
      readonly source: 'level' | 'onset'; readonly depth: number
      readonly smoothing: number; readonly gate: number }

/** 音楽的な長さ。拍の分数で表現する */
export type MusicalRate = { readonly numerator: number; readonly denominator: number }
// 例: 1小節=(4,1) / 1拍=(1,1) / 8分=(1,2) / 付点4分=(3,2) / 3連8分=(1,3)

export type LfoShape = 'sine' | 'triangle' | 'saw' | 'ramp' | 'square' | 'sampleHold' | 'noise'
```

**評価**

```typescript
export const evaluateModulatable = (
  m: Modulatable<number>,
  atTicks: Ticks,
  ctx: ModulationContext,   // TempoIndex, 音声解析値, 乱数シード
): number => { /* base → keyframes → modulators を順に適用 */ }
```

LFO の位相は **tick から直接計算する** (`phase = (atTicks / rateInTicks) % 1`)。時間の累積で持つと、シークしたときに位相が飛ぶ・オフラインレンダリングで再現しないという問題が出る。tick から純関数として導出すれば、**どの位置にシークしても、何度レンダリングしても必ず同じ結果になる** (F-E1 の決定性要件)。

`sampleHold` / `noise` は乱数を使うが、**シードを (レイヤーID + パラメータキー + 経過ステップ数) から決定的に導出する**ことで再現性を保つ。`Math.random()` は使わない。

`audioReactive` だけは決定性に注意が要る。オフラインレンダリングでは音声を先に解析し、**tick → 解析値のテーブルを事前に構築してから映像を回す**。リアルタイムの `AnalyserNode` の値をそのまま使うと書き出しのたびに結果が変わってしまう。

#### 2.2.13 OfflineRenderer (F-E1)

```typescript
export type RenderRequest = {
  readonly range: { readonly fromTicks: Ticks; readonly toTicks: Ticks }
  readonly video: { readonly width: number; readonly height: number; readonly fps: number
                    readonly codec: 'h264' | 'h265' | 'prores' | 'vp9'
                    readonly bitrate?: number; readonly proresProfile?: string }
  readonly audio: { readonly sampleRate: number; readonly codec: 'pcm' | 'aac' | 'mp3' }
  readonly useOriginalMedia: boolean      // false ならプロキシで高速書き出し
  readonly outputPath: string
}
```

**手順**

```
1. 音声を先にバウンス
   AudioBackend.renderOffline(range) → Float32 → 一時 WAV へ書き出し
   ・audioReactive 用の解析テーブルもここで構築する

2. 映像をフレーム単位で回す
   for (let f = 0; f < totalFrames; f++) {
     const tick = tempoIndex.toTicks(startSec + f / fps)
     await evaluator.prepare(tick)                       // デコード要求
     const tex = await evaluator.evaluate(tick, offlineCtx)
     const bytes = await readback(tex)                    // copyTextureToBuffer + mapAsync
     await ffmpegStdin.write(bytes)                       // 背圧を await で受ける
     texturePool.release(tex)
   }

3. FFmpeg で多重化
   ffmpeg -f rawvideo -pix_fmt rgba -s WxH -r FPS -i pipe:0 \
          -i temp_audio.wav -c:v ... -c:a ... out.mp4
```

**設計上の要点**

- **オフラインは常に前方へ順次進む。** したがって書き出し時は元メディア (Long-GOP) を直接デコードしても効率が落ちない。`useOriginalMedia: true` で最高画質、`false` でプロキシから高速書き出し
- **背圧の処理。** `stdin.write()` が `false` を返したら `'drain'` を待つ。これを怠ると FFmpeg が詰まった際にメモリが際限なく膨らむ
- **`mapAsync` はレンダリングループを直列化させる。** リードバックバッファを 2〜3 本のリングにし、N フレーム目を書き戻している間に N+1 フレーム目を合成するパイプライン化で NF-7 (実時間の 3 倍以内) を狙う
- **キャンセルは AbortSignal で伝搬。** FFmpeg プロセスは kill し、一時ファイルを削除する
- **失敗時も部分出力を残す。** 30 分書き出して最後に落ちて全部消える、は最悪の体験

#### 2.2.14 ControlSurface (MIDI)

```typescript
export type MidiBinding = {
  readonly id: string
  readonly message: MidiMessageMatcher
  readonly target: ParamTarget
  readonly mode: 'absolute' | 'relative' | 'toggle' | 'trigger'
  readonly range: { readonly min: number; readonly max: number }
  /** 相対エンコーダのエンコード方式。機種ごとに異なる */
  readonly relativeEncoding?: 'twosComplement' | 'signedBit' | 'binaryOffset'
  readonly softTakeover: boolean
}

export type MidiProfile = {
  readonly id: string
  readonly name: string
  readonly deviceNameMatch: string
  readonly bindings: readonly MidiBinding[]
}
```

**ソフトテイクオーバー**を最初から入れる。物理フェーダーの位置とソフト側の値が食い違っている状態で触ると値が飛ぶため、「物理値がソフト値を通過するまで無視する」処理が必要。後から入れると全パラメータに手を入れる羽目になる。

Electron 側で Web MIDI を有効化するには main プロセスで権限ハンドラが必要:

```typescript
session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
  callback(permission === 'midi' || permission === 'midiSysex' || permission === 'media')
})
```

ジョグホイール (P2) は相対 CC を受け、`速度 = delta / 経過時間` を求めて再生レートに写像し、離した後は慣性モデルで減衰させる。Pioneer 等の HID モードは非対応 (§1.2)。

---

## 3. データフロー

### 3.1 リアルタイム再生時のフレームフロー

```
                     ┌─────────────────────────────────┐
                     │ AudioContext (ハードウェアクロック) │
                     └───────────────┬─────────────────┘
                                     │ getOutputTimestamp()
                                     ▼
   requestAnimationFrame(t) ──► Transport.positionForFrame(t) ──► Ticks
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
  ModulationEngine            CompositionEvaluator          LookaheadScheduler
  (LFO/ビート/音反応を          レイヤー評価                  (別タイマー 25ms 間隔)
   tick から純関数で算出)         │                            │
        │                        │                            ▼
        └───► パラメータ値 ──────►│                    AudioParam / start(when)
                                  ▼                       に 100ms 先まで予約
                       ClipPlayer.frameAt()
                                  │ VideoFrame
                                  ▼
                          copyExternalImageToTexture
                                  │
                                  ▼
                          EffectChain (ping-pong)
                                  │
                                  ▼
                          Blend → accumulator
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
            OutputPresenter              PreviewPublisher
          (出力 canvas / 全解像度)      (480×270 / 30fps)
                                              │ ImageBitmap を transfer
                                              ▼
                                      Control Window の canvas
```

### 3.2 メディア取り込みフロー

```
ユーザーがファイルをドロップ
  │
  ▼
[Main] ProbeService ── ffprobe ──► { duration, size, fps, codec, channels }
  │
  ▼
[Main] contentHash 算出
  ・全体ハッシュは 4GB 動画で数十秒かかるため採用しない
  ・(ファイルサイズ + 先頭 1MB + 末尾 1MB) の xxhash64 を採用
  │
  ▼
[Main] キャッシュ確認 <userData>/cache/<hash>/
  │ ヒットすれば以降をスキップ
  ▼
[Main] ProxyService ── ffmpeg ──► 全 I フレーム fMP4
    -g 1 -bf 0 -movflags +frag_keyframe+empty_moov
  │
  ├──► [Worker] 波形生成 (ピーク配列 / 複数ズーム段)
  ├──► [Worker] サムネイル生成 (タイムライン用スプライトシート)
  └──► [Worker] AnalysisService (essentia.js)
              BPM / ビートグリッド / ダウンビート / キー / LUFS
  │
  ▼
[Main] ProjectStore に MediaAsset を追加 ──► JSON Patch を両レンダラへ配信
```

進捗は `JobQueue` が集約し、UI に一括表示する。**1 ファイルの失敗が取り込み全体を止めない** (§5.1)。

### 3.3 データ変換の要点

| 変換 | 入力 | 処理 | 出力 |
|---|---|---|---|
| 時間 | `Ticks` | TempoIndex の二分探索 + セグメント内線形補間 | `Seconds` |
| 色 | sRGB 8bit (`VideoFrame`) | ソース取り込み時に一度だけリニア化 | linear `rgba16float` |
| 色 | linear `rgba16float` | 出力直前に sRGB へ | 出力 canvas |
| アルファ | ストレート | ソース取り込み時にプリマルチプライ化 | プリマルチプライド |
| 音声 | 圧縮ファイル | FFmpeg → PCM → `AudioBuffer` | Float32 |
| プレビュー | GPU テクスチャ | 縮小描画 → `transferToImageBitmap()` | `ImageBitmap` (transfer) |
| 書き出し | GPU テクスチャ | `copyTextureToBuffer` + `mapAsync` | RGBA raw → FFmpeg stdin |

色空間の扱いは一箇所にまとめる。「どこでリニアで、どこで sRGB か」が曖昧なコードベースは、エフェクトを足すたびに見た目が壊れる。

---

## 4. API インターフェース

### 4.1 ProjectChannel (Renderer ⇄ Main)

すべての永続的変更は `Command` として表現する。**Command が Undo の単位であり、JSON Patch の生成単位でもある。**

```typescript
export type Command =
  | { readonly kind: 'layer.add'; readonly layer: Layer; readonly index: number }
  | { readonly kind: 'layer.remove'; readonly layerId: LayerId }
  | { readonly kind: 'layer.reorder'; readonly layerId: LayerId; readonly toIndex: number }
  | { readonly kind: 'layer.setProps'; readonly layerId: LayerId; readonly props: Partial<LayerProps> }
  | { readonly kind: 'clip.add'; readonly layerId: LayerId; readonly clip: TimelineClip }
  | { readonly kind: 'clip.trim'; readonly clipId: ClipId
      readonly startTicks: Ticks; readonly endTicks: Ticks; readonly offsetTicks: Ticks }
  | { readonly kind: 'clip.split'; readonly clipId: ClipId; readonly atTicks: Ticks }
  | { readonly kind: 'effect.add'; readonly ownerId: string; readonly effect: EffectInstance }
  | { readonly kind: 'effect.setParam'; readonly instanceId: string
      readonly key: string; readonly value: ParamValue }
  | { readonly kind: 'keyframe.set'; readonly targetPath: string
      readonly atTicks: Ticks; readonly value: ParamValue; readonly interp: Interpolation }
  | { readonly kind: 'tempo.set'; readonly tempos: readonly TempoEvent[] }
  | { readonly kind: 'asset.add'; readonly asset: MediaAsset }
  | { readonly kind: 'transaction'; readonly label: string; readonly commands: readonly Command[] }

export type CommandResult =
  | { readonly ok: true; readonly patches: readonly JsonPatchOp[]; readonly revision: number }
  | { readonly ok: false; readonly error: AppErrorPayload }
```

`transaction` は複数操作を 1 回の Undo にまとめるためのもの (例: 「クリップを分割して後半を削除」)。

```typescript
// Preload (contextBridge で公開)
export type ProjectApi = {
  dispatch(command: Command): Promise<CommandResult>
  undo(): Promise<CommandResult>
  redo(): Promise<CommandResult>
  getSnapshot(): Promise<{ readonly state: ProjectState; readonly revision: number }>
  onPatch(handler: (p: { readonly patches: readonly JsonPatchOp[]; readonly revision: number }) => void): () => void
}
```

**リビジョン番号**を必ず付ける。レンダラは受け取ったパッチの `revision` が `自分の revision + 1` でなければ「取りこぼした」と判断し、`getSnapshot()` で全体を取り直す。これがないと稀な取りこぼしで状態が静かに壊れ、原因の特定が極めて困難になる。

### 4.2 RealtimeChannel (Control ⇄ Engine 直結)

main プロセスを経由しない。`MessageChannelMain` で確立し、以降は両レンダラが直接やり取りする。

```typescript
export type ControlToEngine =
  | { readonly t: 'transport'; readonly action: 'play' | 'pause' | 'stop'; readonly fromTicks?: number }
  | { readonly t: 'seek'; readonly ticks: number }
  | { readonly t: 'rate'; readonly value: number }
  | { readonly t: 'param'; readonly instanceId: string; readonly key: string; readonly value: number }
  | { readonly t: 'trigger'; readonly cellId: string; readonly quantize: MusicalRate | null }
  | { readonly t: 'previewConfig'; readonly width: number; readonly fps: number }
  | { readonly t: 'previewAck'; readonly seq: number }
  | { readonly t: 'projectSync'; readonly revision: number }

export type EngineToControl =
  | { readonly t: 'tick'; readonly ticks: number; readonly playing: boolean }   // 60Hz
  | { readonly t: 'preview'; readonly seq: number; readonly bitmap: ImageBitmap }  // transfer
  | { readonly t: 'meters'; readonly master: readonly [number, number]; readonly decks: readonly number[] }
  | { readonly t: 'perf'; readonly frameMs: number; readonly droppedFrames: number; readonly decoders: number }
  | { readonly t: 'engineError'; readonly error: AppErrorPayload }
```

**`param` メッセージは Undo に載らない。** ノブを離した時点で UI 側が `ProjectApi.dispatch({ kind: 'effect.setParam', ... })` を 1 回だけ呼び、確定値を永続化する。この二段構えが §1.1 設計判断 B の実体。

**状態管理での扱い (Zustand)**

`tick` / `meters` は 60Hz で届く。これを Zustand ストアに入れると全購読コンポーネントが毎フレーム再レンダリングされ、UI が破綻する。**ストアの外に置き、必要なコンポーネントだけが `useSyncExternalStore` か ref 経由で直接読む**。再生ヘッドの描画はそもそも React を通さず Canvas に直接描く。

### 4.3 外部インターフェース

| 相手 | 方式 | 備考 |
|---|---|---|
| FFmpeg | 子プロセス (stdin/stdout/stderr) | `resources/ffmpeg/` にバンドル。asar 外に配置 |
| MIDI 機器 | Web MIDI API | main で権限許可が必要 |
| オーディオ IF | Web Audio (WASAPI 経由) | 将来ネイティブバックエンドへ差し替え可能 |
| カメラ | `getUserMedia` | |
| ファイルシステム | main 経由のみ | レンダラから直接触らない (§6.1) |

---

## 5. エラーハンドリング

### 5.1 エラー分類と方針

CLAUDE.md の規約により `class` は原則禁止だが、`instanceof` 判定を要する Error 拡張は明示的な例外として認められている。**`AppError` 1 種類のみを定義し、種別はフィールドで区別する。**

```typescript
export type ErrorCode =
  | 'MEDIA_UNSUPPORTED' | 'MEDIA_CORRUPT' | 'MEDIA_MISSING'
  | 'DECODE_FAILED' | 'DECODER_EXHAUSTED'
  | 'GPU_DEVICE_LOST' | 'GPU_OOM'
  | 'AUDIO_DEVICE_LOST' | 'AUDIO_UNSUPPORTED_CHANNELS'
  | 'EXPORT_FAILED' | 'FFMPEG_FAILED'
  | 'PROJECT_SCHEMA_INVALID' | 'PROJECT_VERSION_UNSUPPORTED'
  | 'IPC_VALIDATION_FAILED' | 'MIDI_UNAVAILABLE'

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: { readonly [k: string]: string | number | boolean },
    readonly cause?: Error,
  ) { super(message) }
}
```

| 分類 | 例 | 方針 |
|---|---|---|
| **回復可能・局所** | 1 ファイルの取り込み失敗、1 レイヤーのデコード失敗 | **絶対に全体を止めない。** 該当レイヤーを黒表示 + UI にバッジを出し、再生は継続する |
| **回復可能・全体** | GPU デバイスロスト、オーディオデバイス切断、ディスプレイ切断 | 自動復旧を試みる。GPU は全リソース再生成、音声は AudioContext 再初期化、ディスプレイはプライマリへ復帰 |
| **回復不能・処理単位** | 書き出し失敗 | 処理を中止し、**部分出力とログを残す**。FFmpeg の stderr 末尾をユーザーに提示 |
| **回復不能・起動時** | プロジェクトのスキーマ不整合 | 読み込みを中止し、直近の自動保存スナップショットからの復元を提案 |
| **バグ** | IPC 検証失敗 | 開発時は即座に throw。本番はログに残して当該操作のみ破棄 |

**メディア欠落 (`MEDIA_MISSING`)** は特別扱いする。プロジェクトを開いた時点で参照先が見つからない場合、その場でエラーにせず「オフライン素材」として扱い、プレースホルダを表示したままプロジェクトを開けるようにする。再リンク UI で `contentHash` を頼りに候補を探す。制作ツールとして必須の挙動。

### 5.2 通知とログ

- **ユーザー通知**: 重大度 3 段階 (info / warning / error)。トーストと、詳細を見られる通知センターの 2 段構え。`error` のみモーダルを許す
- **ログ**: `<userData>/logs/app-YYYYMMDD.jsonl` に JSON Lines で追記。7 日分でローテーション
- **パフォーマンスログ**: `perf-*.jsonl` に別系統でフレーム時間・ドロップ数・デコーダ数を記録。NF-1/NF-6 の検証に使う。リングバッファに保持し、問題発生時のみディスクへ吐く
- **クラッシュ**: `crashReporter` でダンプをローカル保存 (外部送信はしない)

---

## 6. セキュリティ設計

個人利用のデスクトップアプリであり認証・認可は不要。**攻撃面は「悪意ある、あるいは壊れたメディアファイルを読み込むこと」に集約される。**

### 6.1 Electron の堅牢化

| 項目 | 設定 |
|---|---|
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| `sandbox` | `true` (両レンダラ)。ネイティブ処理は必ず main 側に置く |
| `webSecurity` | `true` |
| コンテンツ読込 | `file://` ではなく **カスタム `app://` プロトコル**で配信 |
| CSP | `default-src 'self'; script-src 'self'; connect-src 'self'` |
| 外部遷移 | `setWindowOpenHandler` で全拒否。`shell.openExternal` は許可リスト方式 |
| リモートコンテンツ | 読み込まない |

**`sandbox: true` とネイティブアドオンは併存しない。** FFmpeg 起動もファイル I/O も main プロセスに閉じ込め、レンダラは IPC 越しにしか外界へ触れない構成にする。

### 6.2 IPC 境界の検証

**すべての IPC ペイロードを zod で検証する。** レンダラが侵害された場合の被害を、検証済みスキーマの範囲に限定するのが目的。

```typescript
const handle = <S extends z.ZodTypeAny, R>(
  channel: string,
  schema: S,
  handler: (input: z.output<S>, event: IpcMainInvokeEvent) => Promise<R>,
): void => {
  ipcMain.handle(channel, async (event, raw) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw new AppError('IPC_VALIDATION_FAILED', `invalid payload on ${channel}`,
        { channel, issues: parsed.error.issues.length })
    }
    return handler(parsed.data, event)
  })
}
```

この形にすることで `unknown` を自前の型定義に一切登場させずに済む (`z.output<S>` が具体型を与える)。CLAUDE.md の `unknown` 禁止規約と、外部入力の型安全性を両立させる要となる設計。

### 6.3 ファイルパスの取り扱い

- レンダラから受け取ったパスは main で必ず `path.resolve` し、**許可ディレクトリ (ユーザーが選択したメディアフォルダ、userData) の配下かを検証**してから使う
- FFmpeg の引数は配列で渡し、シェルを経由させない (`shell: false`)。ファイル名に `;` や `&` が含まれても安全
- プロジェクトファイル内のパスは、プロジェクトからの相対パスと絶対パスを併記し、移動に耐えるようにする

### 6.4 データ保護

機密情報を扱わない。プロジェクトファイルは平文 JSON とし、暗号化はしない。外部通信は一切行わない (テレメトリなし、更新チェックなし)。

---

## 7. テスト設計

**詳細なテスト設計は `/test-design` コマンドで別途作成する。**

本設計から見て、テスト設計時に特に重点を置くべき領域を挙げておく。

| 優先度 | 対象 | 理由 |
|---|---|---|
| 最高 | TempoMap の tick⇄秒 相互変換 | ラウンドトリップ性質テスト。可変テンポ・境界・負値・巨大値。ここが壊れると全機能が壊れる |
| 最高 | Transport のアンカー方式 | 疑似クロックを注入し、長時間再生・シーク・レート変更・ループ後の位置誤差を検証 |
| 最高 | ModulationEngine の決定性 | 同じ tick で必ず同じ値。ランダム系のシード再現性。オフラインとリアルタイムの一致 |
| 高 | WGSL ユニフォームのパッキング | アライメント規則の誤りは黙って値が壊れる。全 ParamDescriptor 組合せを網羅 |
| 高 | Command / Undo / JSON Patch | 「適用 → Undo → 状態が完全に一致」の性質テスト |
| 高 | リソースリーク | `VideoFrame` / `ImageBitmap` / GPU テクスチャの取得と解放の収支が合うこと |
| 中 | クロマキーシェーダ | 既知の入出力画像でのゴールデンテスト。許容誤差付き画素比較 |
| 中 | プロジェクトのスキーマ移行 | 旧バージョンのファイルが読めること |
| 中 | 書き出しの A/V 同期 | 生成物をデコードし直し、既知のパターンで音映像のずれを測定 |

GPU を伴うテストは CI で動かしづらいため、**合成ロジック (どのパスをどの順で実行するか) をシェーダ実行から分離**し、前者を純関数としてテスト可能にする。これは設計上の制約として `CompositionEvaluator` に課す。

---

## 8. パフォーマンス最適化

### 8.1 想定される負荷とフレーム予算

60fps における 1 フレームの予算は 16.6ms。Engine Host レンダラでの内訳目標:

| 処理 | 目標 | 備考 |
|---|---|---|
| デコード | 0ms (メインスレッド上) | WebCodecs は別スレッドで動く。待たない |
| テクスチャアップロード | 2ms | 8 レイヤー分 |
| エフェクトチェーン | 6ms | レイヤーあたり 2 段想定 |
| 合成 | 3ms | |
| プレビュー発行 | 1ms | 30fps なので 2 フレームに 1 回 |
| 余裕 | 4ms | |

Control Window は別プロセスなので、UI の重さがエンジンのフレームレートに影響しない。**これがプロセス分離のもう一つの利点**で、タイムラインの再描画が重くても出力は止まらない。

### 8.2 最適化方針

**GPU 側**

1. **ユニフォームの一括パッキング** — 全レイヤーのユニフォームを 1 バッファにまとめ、動的オフセットで参照。`writeBuffer` 呼び出しをフレームあたり 1 回にする
2. **バッファのトリプルバッファリング** — GPU が使用中のバッファへの書き込みストールを避ける
3. **バインドグループのキャッシュ** — 内容が変わらない限り再生成しない
4. **固定機能ブレンドの優先利用** — §2.2.5 のとおり ping-pong を省ける
5. **ブラー系のダウンサンプル** — `PassDefinition.scale` で半解像度実行。見た目の差はほぼなく、コストは 1/4
6. **`onSubmittedWorkDone()` をレンダリングループ内で await しない** — GPU パイプラインを直列化させる典型的な失敗

**デコード側**

7. **プロキシによる全 I フレーム化** — 設計の根幹 (§2.2.8)
8. **デコーダ数の上限管理と LRU** — ハードウェアデコーダの枯渇を防ぐ
9. **先読み** — 再生方向に N フレーム (既定 8) を維持
10. **可視レイヤーのみデコード** — `enabled: false` や不透明レイヤーに完全に隠されたレイヤーはデコードを止める

**UI 側**

11. **タイムラインは Canvas 2D で描画** — 1000 クリップを DOM で描くと破綻する
12. **60Hz の値をストアに入れない** — §4.2
13. **波形は多段ズームのピーク配列を事前生成** — 表示ズームに応じた段を選ぶ

**書き出し側**

14. **リードバックのパイプライン化** — §2.2.13

### 8.3 計測

最適化の前に計測する。`perf` ログに以下を常時記録し、UI にオーバーレイ表示 (開発時) できるようにする。

- フレーム時間の分布 (平均ではなく p50 / p95 / p99 と最大値)
- ドロップフレーム数
- アクティブデコーダ数、フレームリングの充填率
- GPU テクスチャプールの在庫と貸出数
- プレビューの未 ack 数

**平均フレームレートは指標として役に立たない。** 60fps 平均でも p99 が 40ms ならカクついて見える。分位点で見る。

---

## 9. デプロイメント

### 9.1 構成

- **個人利用のため配布は行わない。** electron-builder で portable ビルドを生成し、ローカルに配置するだけ
- FFmpeg は `extraResources` で `resources/ffmpeg/` に同梱 (asar 内に入れると子プロセスから実行できない)
- WASM (essentia.js / signalsmith-stretch) は asar 内に含めてよい
- コード署名・自動更新・テレメトリはいずれも不要

**ライセンス**: 個人利用の範囲では GPL 版 FFmpeg でも問題ない。signalsmith-stretch は MIT なので制約なし。将来配布する場合のみ LGPL 版 FFmpeg への差し替えを検討する (要件 R-7)。

### 9.2 設定管理

| 種別 | 保存先 | 内容 |
|---|---|---|
| アプリ設定 | `<userData>/settings.json` | オーディオデバイス、出力ディスプレイ、A/V オフセット、プレビュー品質、デコーダ上限、キャッシュ上限 |
| MIDI プロファイル | `<userData>/midi-profiles/*.json` | 機種ごとのマッピング |
| プロジェクト | 任意の場所 `*.vjdj.json` | §2.2 のプロジェクト状態 |
| キャッシュ | `<userData>/cache/<hash>/` | プロキシ、波形、サムネイル、解析結果 |
| ログ | `<userData>/logs/` | |

**キャッシュはプロジェクト横断で共有する** (キーは contentHash)。同じ素材を複数プロジェクトで使ってもプロキシ生成は 1 回で済む。上限サイズを設定し、LRU で古いものから削除する。

キャッシュには `cacheFormatVersion` を持たせ、プロキシの生成条件を変えたら自動的に無効化されるようにする。

環境変数は開発時のみ使用 (`VJDJ_DEV_TOOLS`, `VJDJ_LOG_LEVEL`)。実行時設定を環境変数に依存させない。

---

## 10. 実装上の注意事項

### 10.1 プロジェクト規約への対応

**`class` を使わない (Error 拡張を除く)**

エンジン側は本質的に状態を持つが、クラスは使わない。**ファクトリ関数がクロージャで状態を閉じ込め、メソッドを持つオブジェクトを返す**形で統一する。

```typescript
export const createTransport = (deps: TransportDeps): Transport => {
  let state: TransportState = { kind: 'stopped', positionTicks: ticks(0) }
  const listeners = new Set<(s: TransportState) => void>()

  const position = (): Ticks => positionAt(deps.clock.now())
  const play = (fromTicks?: Ticks): void => { /* ... */ }
  // ...

  return { getState: () => state, position, positionAt, positionForFrame, play, pause, stop, seek, setRate, setLoop, subscribe }
}
```

例外は `AppError extends Error` の 1 箇所のみ (§5.1)。`instanceof` 判定が必要なため規約上の例外に該当する。

**`any` / `unknown` を使わない**

外部入力 (IPC ペイロード、JSON ファイル) は本来 `unknown` になるが、**zod の `safeParse` を境界に置き、`z.output<S>` で具体型に変換してから内部へ渡す** (§6.2)。`JSON.parse` の戻り値を直接扱うコードを書かない。

WebGPU / WebCodecs の型は `@webgpu/types` と TypeScript の DOM lib で足りる。不足があれば `.d.ts` に明示的な型を書き足し、キャストで逃げない。

**`.tmp` への設計メモ**

実装中に発生した判断は `.tmp/` にメモを残す。特に Phase 0 の PoC 結果は `.tmp/poc-results.md` に記録し、本設計書へ反映する。

### 10.2 実装順序に関する制約

以下は**後付けが極めて困難**なため、該当機能の最初の実装時点で必ず組み込む。

| 項目 | 理由 |
|---|---|
| 単位の branded type | 後から入れると全コードに型エラーが出る。最初に入れれば自然に守られる |
| GPU デバイスロスト復旧 | 全リソースを記述子から再生成できる構造が前提。後から入れるにはリソース生成箇所を全て書き直す必要がある |
| `VideoFrame` / `ImageBitmap` の所有権管理 | リークは症状が出るまで気づきにくく、原因箇所の特定が困難 |
| ProjectChannel / RealtimeChannel の分離 | 一本化してから分けるのは全 UI コンポーネントの書き換えになる |
| Command ベースの状態変更 | Undo を後付けするには全変更経路の洗い出しが必要 |
| MIDI のソフトテイクオーバー | 全パラメータのバインディングに関わる |
| 変調の tick 由来の決定性 | 時間累積で書いてから直すのは、全モジュレータの書き直し |

### 10.3 未確定事項と暫定決定

要件定義 §7 の未決定事項について、設計を進めるため以下を**暫定値**として採用した。実装着手前に確認したい。

| # | 項目 | 暫定決定 | 変更した場合の影響 |
|---|---|---|---|
| 1 | 既定の出力解像度・fps | **1920×1080 / 60fps** | 小。プロジェクト設定なので既定値の変更のみ |
| 2 | オーディオ IF / MIDI 機種 | **未定のまま。ケイパビリティ判定で実行時に吸収** (§2.2.11) | 小。設計側で環境差を織り込み済み |
| 3 | 既存 DAW との連携 | **WAV ステム / 標準 MIDI ファイルの入出力のみ対応。Ableton Link は Phase 7 送り** | 中。Link はネイティブアドオンが必要 |
| 4 | VJ 素材の主な出所 | **混在を想定。プロキシ既定 1080p** | 小。4K 素材中心ならプロキシ解像度の既定を上げる |
| 5 | アプリケーション名 | **未定。内部識別子は `vjdj` を仮置き** | 小。ただし userData ディレクトリ名に影響するので早めに決めたい |

### 10.4 Phase 0 で決着させるべき事項

要件 §4.5 の PoC 項目のうち、3 番目 (ImageBitmap 転送) は本設計で方式が確定したため、**実測すべきは残り 5 項目 + 新規 2 項目**となる。

| # | 検証内容 | 判定基準 | 不合格時の代替 |
|---|---|---|---|
| 1 | 対象 Electron バージョンでの WebGPU 可用性 | `chrome://gpu` で有効、`requestAdapter()` が成功 | `--enable-unsafe-webgpu` を付与。それでも不可なら WebGL2 へ後退 |
| 2 | ImageBitmap のレンダラ間 transfer | 480×270 / 30fps で Engine 側の追加コスト 1ms 未満 | `copyTextureToBuffer` 読み戻しへ切替 |
| 3 | オーディオ IF の `maxChannelCount` | 4 以上なら cue 実現可能 | cue 機能を無効化。Phase 7 でネイティブバックエンド |
| 4 | 1080p All-Intra の同時デコード本数 | 8 本で 60fps 維持 | `DecoderPool` 上限を実測値に設定。超過分はソフトウェアデコード |
| 5 | signalsmith-stretch 2 デッキ同時の CPU 負荷 | ドロップアウトなし | `splitComputation` 調整、品質モード切替 |
| 6 | 30 分再生後の A/V ずれ | 1 フレーム以内 | `positionForFrame` の較正周期を見直す |
| 7 | **`rgba16float` 16 レイヤー時の VRAM 使用量** | 実測して上限レイヤー数を決める | レイヤー数上限を設ける、または `rgba8unorm` へ後退 |
| 8 | **Engine Host ウィンドウの背景スロットリング** | 非フォーカス時も rAF が 60Hz で回る | `backgroundThrottling: false` で解決するはず。不可なら別手段を検討 |

PoC の結果は `.tmp/poc-results.md` に記録する。

### 10.5 確定した挙動仕様 (D-1〜D-8)

Stage 3 のテスト設計時に、本設計書が定義しきれていない挙動が 8 件判明した。**2026-08-19 にユーザー承認により以下で確定。** 実装はこの表に従うこと。詳細な検討経緯とテストケース対応は `.tmp/test_design.md` §9 を参照。

| ID | 項目 | **確定した挙動** | 根拠 |
|---|---|---|---|
| **D-1** | 負の tick | **許可する。** `Ticks` は負値を取りうる。TempoIndex の変換・スナップ・小節分解はすべて負領域で動作すること | カウントイン/プリロール (F-A1) で必要。後から許可制に変えると全変換ロジックに波及する |
| **D-2** | TempoMap の不変条件 | **生成時に正規化する** (tick 昇順に安定ソート、同一 tick は後勝ち、tick=0 のイベントがなければ既定 BPM で補完)。**正規化を行った事実は警告ログに残す** | UI 操作で一時的に不正な状態が作られうるため、拒否は使いにくい |
| **D-3** | Transport の rate | **rate = 0 は一時停止と等価に扱う。負値は拒否** (`AppError`) | トランスポート全体の逆再生は要件にない。逆再生はクリップ単位 (F-V4) で実現する |
| **D-4** | ループ範囲の逆転 | **自動で入れ替える** (start > end なら swap) | UI でのドラッグ中に一時的な逆転は普通に起きる |
| **D-5** | 複数モジュレータの合成 | **加算。適用順は配列順で固定。** `base → keyframes → modulators を加算 → パラメータ範囲へクランプ` の順に評価する。将来モジュレータごとの合成方式指定へ拡張可能な形にしておく | 加算は直感的で、depth = 0 が恒等元になる性質が扱いやすい |
| **D-6** | クロマキーの inner ≥ outer | **クランプする** (`outer = max(outer, inner + ε)`)。拒否しない | スライダ操作で普通に起きる。NaN を出さないことが最優先 |
| **D-7** | Undo スタックの上限 | **既定 200 件。設定で変更可能。**超過時は最古から破棄 | 映像プロジェクトは 1 Command が重くなりうるため無制限は危険 |
| **D-8** | 同一 MIDI メッセージへの複数バインド | **全てのバインディングに配信する** | 1 つのノブで複数パラメータを同時に動かすのは VJ では通常の使い方 |

加えて、テスト設計から**設計への追加制約 1 件**を採用する。

- **`buildRenderPlan(comp, atTicks, ctx): RenderPlan` を純関数として切り出す。** §2.2.5 の評価アルゴリズムのうち「どのパスをどの順で、どのテクスチャを入出力として実行するか」を決める部分を、シェーダ実行から分離する。§7 では方針としてのみ述べていたものを、明示的な関数境界として確定する。合成ロジックの大半が GPU なしでテスト可能になり、副次的に書き出し時のデコード先読みにも同じ関数を再利用できる

---

## 11. 本設計で確定した主要な判断 (サマリ)

| # | 判断 | 根拠 |
|---|---|---|
| 1 | 音声・映像エンジンを **Engine Host ウィンドウ 1 つに集約** | 毎フレームの音声時刻参照を IPC にしないため。同期精度 NF-3 の前提 |
| 2 | IPC を **ProjectChannel / RealtimeChannel の 2 系統**に分離 | Undo 汚染と main 経由の遅延を避ける |
| 3 | プレビューは **ImageBitmap の transfer** | 実地確認済み。R-1 の解決 |
| 4 | トランスポートは **アンカー方式** (加算カウンタを使わない) | 誤差の非蓄積。長時間再生と決定的書き出しの前提 |
| 5 | フレーム位置は **`getOutputTimestamp()` で較正** + ユーザー調整可能な A/V オフセット | 表示遅延は API から知り得ないため |
| 6 | 変調値は **tick からの純関数**として算出 | シーク耐性と書き出しの決定性 (F-E1) |
| 7 | 合成は **リニア色空間・プリマルチプライド・`rgba16float`** | 多段エフェクトでの破綻を防ぐ |
| 8 | クロマキーは **CbCr 距離 + 二重閾値 + チョーク/フェザー + デスピル**の 4 パス | ナイーブ実装では実用に耐えないため |
| 9 | タイムストレッチは **signalsmith-stretch (MIT) をそのまま採用** | 実地確認済み。自前実装は不要かつ不合理 |
| 10 | 音声は **AudioBackend で抽象化**し、cue 可否は**実行時ケイパビリティ**で判定 | R-2 の局所化と環境差の吸収 |
| 11 | 全変更を **Command 化**し JSON Patch + リビジョンで同期 | Undo と 2 ウィンドウ同期を同一機構で解決 |
| 12 | 状態を持つ実装は **ファクトリ関数 + クロージャ** | プロジェクト規約 (class 禁止) への適合 |

---

## 12. 次のステップ

1. 本設計のレビューと承認 (特に §11 の 12 項目)
2. §10.3 の暫定決定 5 件の確認
3. `/test-design` で Stage 3 (テスト設計) — §7 の重点領域を詳細化
4. `/tasks` で Stage 4 (タスク分解) — Phase 0 から着手
