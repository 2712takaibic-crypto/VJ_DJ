# VJDJ

グリーンバック素材を Three.js の 3D 空間に合成し、音楽に同期した
バーチャルライブ風の MV を作るツール。

現時点の成果物: `output/hikari-mv.mp4` (1920×1080 / 30fps / 90秒 / H.264 + AAC)

## できること

| 機能 | 状態 |
|---|---|
| グリーンバックのクロマキー合成 | ✅ CbCr 距離方式 + チョーク + デスピル |
| 3D ステージ (WebGPU) | ✅ LEDウォール / トラス / 床グリッド / 照明 |
| 舞台演出 | ✅ レーザービーム / 電撃 / パーティクル / bloom |
| 音楽同期 | ✅ BPM・ビートグリッド・帯域別エンベロープに追従 |
| mp4 書き出し | ✅ 決定的なオフラインレンダリング + 音声多重化 |
| MCP からの操作 | ✅ AI が画を見ながら調整できる |
| 人間向け UI | ✅ プレビュー / トランスポート / パラメータ操作 |
| DJ 機能 / DAW 機能 | ⏳ 未着手 |

## 使い方

### 準備

```bash
npm install
node scripts/analyze-audio.mjs 素材/hikari.m4a .tmp/hikari.analysis.json
node scripts/extract-frames.mjs 素材/green_back.mp4 .tmp/frames/green_back
npm run build
```

音源と映像素材は `素材/` に置く。解析結果と展開フレームは `.tmp/` に生成される。
どちらも Git 管理外。

### 起動

```bash
npm start
```

Control ウィンドウと Output ウィンドウが開く。
Output ウィンドウを 2 画面目へ移してフルスクリーンにすると外部出力になる。

### MV の書き出し

```bash
VJDJ_EXPORT=output/hikari-mv.mp4 \
VJDJ_EXPORT_AUDIO=素材/hikari.m4a \
VJDJ_EXPORT_DURATION=90.47 \
npm start
```

| 環境変数 | 既定 | 内容 |
|---|---|---|
| `VJDJ_EXPORT` | — | 出力パス。指定すると書き出しモードになる |
| `VJDJ_EXPORT_AUDIO` | なし | 多重化する音声 |
| `VJDJ_EXPORT_START` | 0 | 開始秒。画の確認で途中だけ出すのに使う |
| `VJDJ_EXPORT_DURATION` | 90.47 | 長さ (秒) |
| `VJDJ_EXPORT_WIDTH` / `_HEIGHT` | 1920 / 1080 | 解像度 |
| `VJDJ_EXPORT_FPS` | 30 | フレームレート |
| `VJDJ_EXPORT_CRF` | 18 | H.264 の品質。小さいほど高品質 |

1080p 30fps を実時間より速く書き出す (90 秒の映像が約 87 秒)。

### AI (MCP) から操作する

```bash
claude mcp add vjdj -- node D:/Programs/VJ_DJ/mcp/server.mjs
```

VJDJ を起動した状態で、プロンプトで指示できる。

> 40秒の画を見て、LEDウォールをもう少し寒色に、レーザーを強めて

**`capture` ツールが中核。**AI が自分の操作結果を画像で確認してから
次の調整を決められる。画を見ずにパラメータを触っても意図した絵にはならない。

提供ツール: `get_state` `capture` `set_chroma` `set_performer` `set_bloom`
`set_lasers` `set_lightning` `set_wall` `set_camera` `set_particles` `seek` `set_playing`

## 開発

```bash
npm run verify      # lint + typecheck + 層1テスト
npm run test:all    # 層1〜3すべて
npm run test:gpu    # WebGPU テスト (Electron 内で実行)
npm run test:audio  # 音声テスト (OfflineAudioContext)
npm run poc:platform / poc:preview / poc:audio   # PoC の再測定
```

テストは 5 層に分かれている (`.tmp/test_design.md`)。
層 1 は 30 秒以内を死守すること。遅くなると実行されなくなる。

## 設計の要点

- **すべてが時刻の純関数**。リアルタイム再生と書き出しが同じコードを通るので、
  プレビューで見た画がそのまま書き出される。内部に累積状態を持たせない
- **映像ソースは静止画列**。`HTMLVideoElement` の `currentTime` は
  フレーム精度が保証されず、決定性を満たせない
- **楽曲解析はオフラインで固定**。リアルタイム解析だと
  書き出しのたびに結果が変わる
- **Engine Host に映像・音・時刻を集約**。マスタークロックは音声クロックであり、
  毎フレームの参照を IPC にすると同期精度が壊れる

詳細は `.tmp/` の設計文書を参照:
`requirements.md` / `design.md` / `test_design.md` / `tasks.md` /
`poc-results.md` / `perf-baseline.md`

## 素材について

`素材/green_back.mp4` はストック素材で、透かしが入っており被写体の脚が
下端で切れている。足元は床の発光で隠す構図にしてある。
解像度も 596×336 と小さいため、被写体を大きくしすぎると粗が出る。
