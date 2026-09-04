# blowser_VR

Meta Quest 3 のブラウザ（Meta Quest Browser）上で動作する WebXR コンテンツ。
**ハンドトラッキングで 3D ボタンを押す**インタラクションを、three.js 公式サンプル
[`webxr_vr_handinput_pressbutton`](https://threejs.org/examples/?q=xr#webxr_vr_handinput_pressbutton)
を参考に Vite + npm 構成で実装する。

## 特徴

- **WebXR + ハンドトラッキング**: `immersive-vr` セッションで Quest 3 の手を認識し、
  指先（`index-finger-tip` ジョイント）でボタンを押下する。
- **three.js (npm)**: `three` を npm 導入し、`three/addons/...` をバンドル。
- **HTTPS 開発サーバ**: WebXR は HTTPS（または localhost）必須のため、Vite の
  自己署名証明書プラグインで HTTPS 化し、LAN 公開して Quest 3 実機で確認する。
- **静的ホスティング向けデプロイ**: `vite build` で出力した `dist/` を
  静的ファイルホスティングへアップロードして配信する。

## ディレクトリ構成（予定）

```
blowser_VR/
├── index.html          # エントリ HTML
├── src/
│   └── main.js         # シーン・WebXR・ハンドトラッキング・ボタン押下ロジック
├── vite.config.js      # HTTPS 開発サーバ / LAN 公開 / base パス設定
├── package.json        # three, vite, @vitejs/plugin-basic-ssl
└── dist/               # vite build の成果物（デプロイ対象）
```

## 開発・ビルド・デプロイ

```bash
npm install          # 依存関係のインストール
npm run dev          # HTTPS 開発サーバ起動（LAN 公開、Quest 3 から接続して確認）
npm run build        # dist/ に静的ファイルを出力
npm run preview      # ビルド成果物のローカル確認（HTTPS）
```

Quest 3 での確認手順:

1. PC と Quest 3 を同一 LAN に接続する。
2. `npm run dev` の表示する `https://<PCのLAN IP>:<port>/` を Quest 3 のブラウザで開く。
3. 自己署名証明書の警告は許可して続行する。
4. 「VR」ボタンで没入。設定でハンドトラッキングを有効化しておくこと。

デプロイ: `npm run build` の `dist/` 配下を静的ホスティングへアップロードする。
サブディレクトリ配信の場合は `vite.config.js` の `base` を配信パスに合わせる。

## `.claude/` について

このディレクトリは Claude Code の設定一式（仕様駆動開発のスラッシュコマンド、
権限・フック設定、テンプレート等）。`settings.json` の通知フックは Windows
（PowerShell）向けに設定済み。プロジェクトの進捗は `tasks.json` で管理する。
