# PoC 実施結果

設計書 §10.4 / テスト設計 §4.3 で定義した検証項目の実測記録。

**この文書は判断の根拠であり、後から「なぜそう決めたか」を追えるようにするためのもの。**
数値を書き換える場合は、旧値を消さず実施日とともに追記すること。

## 進捗

| ID | 内容 | 状態 | 実施日 |
|---|---|---|---|
| PC001 | WebGPU 可用性 | **PASS** | 2026-08-19 |
| PC008 | 背景スロットリング | **PASS** | 2026-08-19 |
| PC002 | ImageBitmap 転送 | **PASS** | 2026-08-19 |
| PC003 | 出力チャンネル数 | **完了** (キューはスコープ外で確定) | 2026-08-19 |
| PC004 | 多レイヤーデコード | 未実施 (P1-24) | — |
| PC005 | ストレッチ CPU 負荷 | 未実施 (P2-16) | — |
| PC006 | 30 分 A/V ずれ | 未実施 (P2-16) | — |
| PC007 | VRAM 上限 | 未実施 (P1-24) | — |

---

## 実行環境

| 項目 | 値 |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| Electron | 43.4.1 |
| Chromium | 150.0.7871.224 |
| Node | 24.11.1 (開発) |
| GPU | NVIDIA / Ampere 世代 |
| ディスプレイ 1 | 1920×1080、scaleFactor 1.0 |
| ディスプレイ 2 | 1280×720、**scaleFactor 1.5** |

再実行: `npm run poc:platform` (既定 60 秒/フェーズ) / `POC_SECONDS=300 npm run poc:platform` (正式条件)
生データ: `.tmp/poc-platform.json`
ハーネス: `poc/platform/`

**計測は本番と同一のレンダラ設定 (`sandbox: true` / `contextIsolation: true` / `nodeIntegration: false` / `backgroundThrottling: false`) で行った。**設定を緩めて測ると数値が転用できないため。

---

## PC001: WebGPU 可用性 — **PASS**

### 判定基準と結果

| 基準 | 結果 |
|---|---|
| `requestAdapter()` が安定して成功する | **10/10 成功** |
| `--enable-unsafe-webgpu` フラグが不要 | **不要** (フラグなしで成功) |
| デバイス生成が成功する | **成功** |
| 実際に 1 フレーム描画できる | **成功** (canvas へ clear を実行し `onSubmittedWorkDone()` まで完走) |
| `app.getGPUFeatureStatus().webgpu` | `enabled` |

アダプタが取れるだけでは「使える」と言えないため、**デバイス生成と実描画まで確認する基準にした。**

### アダプタ情報

```
vendor       : nvidia
architecture : ampere
```

### 主要な上限値

| 上限 | 値 | 設計への含意 |
|---|---|---|
| `maxTextureDimension2D` | 16384 | 4K/8K 素材に対して十分 |
| `maxBufferSize` | 2 GiB | 十分 |
| `maxStorageBufferBindingSize` | 約 2 GiB | 十分 |
| `maxUniformBufferBindingSize` | 65536 (64 KiB) | 全レイヤーのユニフォームを 1 バッファにパックし動的オフセットで参照する方式 (設計書 §8.2) は問題なく成立する |
| **`maxBindGroups`** | **4** | **合成パイプラインのバインドグループ設計はこの数に収める必要がある。設計書に記載のなかった実制約** |
| `maxColorAttachmentBytesPerSample` | 128 | MRT を使う場合の制約。現設計では単一アタッチメントのため影響なし |

### 利用可能な機能 (19 件) と設計への影響

```
depth32float-stencil8, rg11b10ufloat-renderable, bgra8unorm-storage,
texture-formats-tier1, texture-formats-tier2, texture-compression-bc,
texture-compression-bc-sliced-3d, dual-source-blending, core-features-and-limits,
float32-filterable, float32-blendable, indirect-first-instance, depth-clip-control,
timestamp-query, clip-distances, shader-f16, primitive-index,
texture-component-swizzle, subgroups
```

設計判断に効くもの:

| 機能 | 影響 |
|---|---|
| **`timestamp-query`** | **GPU 側の実行時間をパス単位で計測できる。**テスト設計 §4.1 の性能測定 (PF001〜007) を壁時計ではなく GPU 実時間で行えるため、最適化の効果を正確に測れる。`.tmp/perf-baseline.md` の精度が上がる |
| **`texture-compression-bc`** | HAP コーデック (DXT/BC 圧縮テクスチャ) の GPU 展開経路が存在する。要件 R-4 の対策として Phase 7 に置いた HAP 導入は、この環境で技術的に成立する |
| `dual-source-blending` | ブレンドの固定機能パス (設計書 §8.2 の最適化) で選べる手段が増える |
| `float32-blendable` / `float32-filterable` | 中間テクスチャに `rgba32float` を選ぶ余地がある。ただし現設計の `rgba16float` で足りる見込み |
| `shader-f16` | エフェクトの演算精度を下げて高速化する選択肢。必要になったら検討 |

`preferredCanvasFormat` は `bgra8unorm`。

### ハードウェア支援の状況

```
gpu_compositing : enabled
video_decode    : enabled   ← WebCodecs のハードウェアデコードが期待できる (PC004 で実測)
video_encode    : enabled
webgl           : enabled
webgpu          : enabled
```

---

## PC008: 背景スロットリング — **PASS**

`backgroundThrottling: false` を設定した Engine Host ウィンドウが、
非アクティブ状態でも 60Hz で `requestAnimationFrame` を回し続けるかを検証した。

### 判定基準

非フォーカス時に 58fps 以上、かつフレーム間隔の p99 が 20ms 未満。

### 結果

| フェーズ | 計測時間 | フレーム数 | fps | p50 | p95 | p99 | max | 20ms 超 | `document.hidden` |
|---|---|---|---|---|---|---|---|---|---|
| focused (フォーカスあり) | 300.0s | 18,001 | **60.002** | 16.70 | 16.80 | 16.80 | 17.00 | **0** | 0 |
| unfocused (非フォーカス + 遮蔽) | 300.0s | 18,003 | **60.007** | 16.70 | 16.80 | 16.80 | 16.90 | **0** | 0 |
| minimized (最小化) ※ | 20.0s | 1,202 | **60.09** | 16.70 | 16.80 | 16.80 | 16.80 | **0** | 0 |

単位は ms。※ minimized のみ 20 秒での補足計測 (focused / unfocused は正式条件の 300 秒)。

### 所見

**3 状態すべてでフレーム落ちゼロ。**設計書 §1.1 の設計判断 A (Engine Host ウィンドウに全リアルタイム処理を集約する) は、この環境で問題なく成立する。

計測中に一点、当初の想定と違う挙動を確認した。

**遮蔽状態でも `document.hidden` は `false` のままだった。**Page Visibility API はウィンドウが他ウィンドウに覆われただけでは `hidden` にならないため、当初の「非フォーカス」計測は実際には *遮蔽* を測っていて、*非表示* は測れていなかった。これでは運用上ありがちな「出力ウィンドウを誤って最小化する」ケースが未検証のまま残る。

そこで最小化状態の計測を追加したところ、**最小化しても `document.hidden` は `false` のまま、60fps を維持した。**`backgroundThrottling: false` は Page Visibility の状態そのものを抑止しており、想定より強く効いている。

結果として、設計書 §1.1 で「`show: false` の隠しウィンドウは rAF が停止するため採用しない」とした判断の前提はより緩い。ただし**この結論に依存した設計変更 (隠しウィンドウ化など) は行わない。**理由は 2 つ。

1. Engine Host は出力表示先そのものであり、可視である必然性がある
2. `show: false` と「最小化」は Chromium 内部で別扱いであり、最小化で問題ないことは `show: false` で問題ないことを意味しない

### 未検証として残る点

- 最小化状態の 300 秒計測 (20 秒でのみ確認)。必要なら `POC_SECONDS=300` で再実行して確認する
- 別の仮想デスクトップへ移動した場合の挙動
- ノート PC のバッテリー駆動時 / 省電力プロファイル下での挙動 (対象環境がデスクトップのため優先度低)

---

## PC002: プレビュー転送方式 — **PASS (ImageBitmap を採用)**

設計書 §2.2.10 は ImageBitmap の transfer を第一候補、`copyTextureToBuffer` の読み戻しを
フォールバックとしていた。**両方を同一条件で実測し、採用方式を確定させた。**

ハーネス: `poc/preview/` / 再実行: `npm run poc:preview`
生データ: `.tmp/poc-preview.json`

### 測定条件

- シーン: 1920×1080 / `rgba16float` を毎フレーム描画 (合成結果を模したもの)
- プレビュー: 30fps で発行 (レンダリングは 60fps)
- 背圧: 未 ack が 2 枚を超えたら発行をスキップ
- 経路 A: OffscreenCanvas(webgpu) → `transferToImageBitmap()` → MessagePort へ transfer
- 経路 B: `copyTextureToBuffer` → `mapAsync` → ArrayBuffer を transfer (受信側で行パディングを解く)
- 遅延は両レンダラの `performance.timeOrigin + performance.now()` の差で測定 (同一マシンなので時計は共通)

### 判定基準と結果 (480×270 / 各 60 秒)

| 基準 | 経路 A (ImageBitmap) | 経路 B (readback) |
|---|---|---|
| engine 側の追加コスト < 1ms | **0.500ms** (p99) ✅ | **0.100ms** (p99) ✅ |
| 表示遅延 < 100ms | **0.70ms** (p99) ✅ | **1.10ms** (p99) ✅ |
| フレーム落ち | 0 / 3,601 | 0 / 3,601 |
| 発行 / ack / スキップ | 1801 / 1801 / 0 | 1801 / 1801 / 0 |

**両方とも基準を大きく下回った。**480×270 の時点では、同期コストだけ見ると経路 B の方が有利ですらある
(`mapAsync` 以降が非同期のため、レンダリングループを止める時間が短い)。

### 解像度スケーリング — ここで優劣が決まる

480p の絶対値だけでは判断を誤る。**両経路はプレビュー解像度に対する挙動がまったく異なる。**

| プレビュー | 画素数 | A: publish p99 | A: 遅延 p99 | A: 受信描画 p50 | B: publish p99 | B: 遅延 p99 | B: 受信描画 p50 |
|---|---|---|---|---|---|---|---|
| 480×270 | 129K | 0.500 | 0.70 | 0.000 | 0.100 | 1.10 | 0.200 |
| 960×540 | 518K (×4) | 0.400 | 0.60 | 0.000 | 0.100 | 2.70 | 0.500 |
| 1920×1080 | 2.07M (×16) | 0.400 | **0.40** | 0.000 | 0.100 | **10.80** | 1.700 |

単位 ms。480p は 60 秒、それ以外は 20 秒計測。

- **経路 A は解像度に対してほぼ定数。**GPU 側のハンドルを渡すだけなので、画素数が 16 倍でもコストが変わらない
- **経路 B は画素数に線形。**遅延は 1.10 → 10.80ms (約 10 倍)、受信側の描画コストも 0.200 → 1.700ms

1080p では経路 B の遅延 10.8ms が 1 フレーム予算 (16.6ms) の大半を占め、
受信側の描画 1.7〜3.0ms も UI の描画と競合する。

### 結論

**経路 A (ImageBitmap の transfer) を採用する。**設計書 §2.2.10 の判断は正しかったが、
**根拠は「480p での絶対値」ではなく「解像度に対してスケールしないこと」である。**

副次的だが実用上重要な発見が 1 つ。

**プレビュー解像度は実質的に自由なパラメータになる。**
1080p のプレビューでも engine 側のコストは 0.4ms、受信側の描画は 0.0ms。
設計書は「既定 480×270、負荷が高ければ 360p まで落とす」としていたが、
**下げる必要はなく、むしろ既定をもっと上げてよい。**
P1-20 の実装時に既定値を再検討すること (プレビューの見やすさは制作ツールの使い勝手に直結する)。

### 未検証として残る点

- 経路 B の非同期部分 (`getMappedRange().slice()` の CPU コピー) は `publishCost` に含まれていない。
  フレーム間隔の分布に劣化が出ていないため実害はないと判断したが、厳密な数値としては未計測
- 実際の合成負荷 (16 レイヤー + エフェクト) がかかった状態での再測定。P1-25 の性能計測時に確認する

---

## PC003: 音声デバイス能力 — **部分完了**

ハーネス: `poc/audio/` / 再実行: `npm run poc:audio` / 生データ: `.tmp/poc-audio.json`

**計測時にオーディオインターフェースは未接続 (ヘッドホンのみ)。**

その後、ユーザーがオーディオIF を保有しておらず購入予定もないことを確認したため、
**ヘッドホンキューはスコープ外として確定した** (要件 F-D3 を更新、リスク R-2 は解消)。
以下の「機材待ち」の記述は計測時点のもの。

| 項目 | 結果 |
|---|---|
| AudioWorklet | **PASS** — 動作確認済み。P2-8 (signalsmith-stretch) の前提が満たされる |
| オーディオクロック | **PASS** — 詳細は下記 |
| ヘッドホンキュー (ch3/4) | **NOT-AVAILABLE** — この環境では不可 |

### 出力デバイス (5 件、いずれも 2ch / 48kHz)

```
2ch  Default - スピーカー (Realtek(R) Audio)
2ch  Communications - TOSHIBA-TV (NVIDIA High Definition Audio)
2ch  TOSHIBA-TV (NVIDIA High Definition Audio)
2ch  LCD-MF276XD (NVIDIA High Definition Audio)
2ch  スピーカー (Realtek(R) Audio)
```

4ch 以上を報告するデバイスが 1 つもないため、設計書 §2.2.11 の
「`ChannelMergerNode` で master=ch1/2, cue=ch3/4 に分ける」方式は**この環境では成立しない**。

ただしこれは想定内の結果であり、設計は**実行時のケイパビリティ判定**でこの差を吸収する作りになっている
(`supportsIndependentCue`)。キュー機能は Phase 5 (DJ) の項目であり、**Phase 1〜4 の進行を妨げない。**

`navigator.mediaDevices.enumerateDevices()` + `AudioContext.setSinkId()` で
デバイスごとに能力を調べられることは確認できた。出力デバイス選択 UI (P0-5 の範囲外) の実装方法として使える。

### オーディオクロック — 設計の中核前提の検証

Transport はアンカー方式で (音声時刻, tick) の 1 組から位置を計算する (設計書 §2.2.3)。
その前提として、`getOutputTimestamp()` が安定した対応点を返す必要がある。
**この検証は接続機材に依存しないため、オーディオIF がなくても意味のある結果が出る。**

| 項目 | 値 |
|---|---|
| 計測区間 | 59.9 秒 / 3,597 サンプル |
| 最終乖離 | **0.103 ms** |
| ドリフト | **1.7 ppm** |
| skew p50 | 0.003 ms |
| skew p95 | 0.302 ms |
| skew min / max | -3.872 / **10.202** ms |

1.7ppm を線形に外挿すると、30 分で約 3ms、2 時間で約 12ms。
**いずれも 1 フレーム (16.7ms) 未満**であり、NF-3 (音映像同期 ±1〜2 フレーム) を満たせる。

### ここで見つかった 2 つの実装上の罠

計測を最初に実行したとき、ドリフトが **-154,527 ppm (60 秒で -5.5 秒)** という異常値になった。
原因は計測側のバグだったが、**製品コードでも同じ間違いを踏む種類のもの**なので記録しておく。

**罠 1: 音声デバイスが動き出す前の `getOutputTimestamp()` を基準にしてはならない。**

```
初回の読み取り: contextTime=0, performanceTime=0
contextTime > 0 になるまで: 64.7ms (破棄したサンプル 64 件)
```

`AudioContext` を作って `resume()` した直後、`getOutputTimestamp()` は
`{contextTime: 0, performanceTime: 0}` を返す。実際にレンダリングが始まるまで約 65ms かかる。
この期間の値を基準にアンカーを打つと、**以降ずっと補正されない定数オフセットが乗る。**
最初の計測で出た -5.5 秒はこれが原因だった。

→ **P0-11 の実装で必須の対策**: `RealtimeClockSource` は
`contextTime > 0` を確認してから較正を確立する。それ以前は「未初期化」として扱い、
Transport の再生開始を許可しない (または確立後に再アンカーする)。

**罠 2: 較正値には最大 10ms のジッタが乗る。**

p50 は 0.003ms と極めて安定している一方、max は 10.202ms。
設計書 §2.2.3 の `positionForFrame` は毎フレーム `calibrate()` を呼ぶが、
**単発の読み取りをそのまま使うと、この外れ値がそのまま映像位置の飛びになる。**

→ **P0-11 の実装で必須の対策**: 較正値をローパスフィルタで平滑化し、
「音声クロックと performance クロックのオフセット」の推定値をゆっくり更新する。
毎フレームの生の読み取りを直接使わない。

### 未検証として残る点

- **キュー (ch3/4) の可否** — オーディオIF 接続後に `npm run poc:audio` を再実行する
- 実際の往復レイテンシ (NF-2 の 30ms 以下)。報告値 (`baseLatency` / `outputLatency`) は取得できるが、
  実測にはループバック接続が要る。機材接続時に併せて検討する

---

## 設計書へ反映すべき事項

| # | 内容 | 反映先 |
|---|---|---|
| 1 | **`maxBindGroups` が 4**。合成パイプラインのバインドグループ設計はこの制約内に収める | 設計書 §2.2.5 / P1-3 の実装時 |
| 2 | `timestamp-query` が使えるため、性能計測を GPU 実時間で行う | テスト設計 §4.1 / P1-25 |
| 3 | `texture-compression-bc` があり HAP 導入は技術的に成立する | 要件 R-4 / Phase 7 |
| 4 | **2 画面目の scaleFactor が 1.5**。フルスクリーン出力時に論理ピクセルと物理ピクセルの差を扱う必要がある | 設計書 §2.2.9 / P1-19 |
| 5 | `backgroundThrottling: false` は最小化状態でも rAF を維持する | 設計書 §1.1 の注記 |
| 6 | **プレビュー転送は ImageBitmap で確定。**根拠は解像度に対してスケールしないこと | 設計書 §2.2.10 / リスク R-1 は解消 |
| 7 | **プレビュー解像度の既定を 480×270 より上げてよい。**1080p でも engine 側 0.4ms | 設計書 §2.2.10 / P1-20 |
| 8 | **`contextTime > 0` を確認してから較正を確立する。**起動後 65ms は `{0, 0}` が返る | 設計書 §2.2.3 / **P0-11 必須** |
| 9 | **較正値をローパスフィルタで平滑化する。**単発の読み取りは最大 10ms のジッタを含む | 設計書 §2.2.3 / **P0-11 必須** |
| 10 | オーディオクロックのドリフトは 1.7ppm。2 時間でも 1 フレーム未満 | NF-3 は達成可能 |

8 と 9 は設計書 §2.2.3 に記載がなく、実測で初めて判明した。
どちらも入れ忘れると「なぜか映像が音とずれる」「たまに映像がカクつく」という
原因の特定しにくい不具合になる。**P0-11 の実装時に必ず組み込むこと。**

4 は見落としやすい。出力解像度をディスプレイ解像度から独立させた設計 (F-V5) のおかげで大きな問題にはならないが、**canvas のバッキングストアサイズを `devicePixelRatio` 込みで決める処理が必要**になる。P1-19 の実装時に必ず確認すること。
