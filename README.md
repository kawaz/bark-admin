# bark-admin

iPhone / iPad の Bark アプリへ通知を送るためのデバイス登録簿 + ファンアウト + 管理 UI。bark-server の前段に置く。設計は [docs/DESIGN.md](docs/DESIGN.md)。

## 使い方

```sh
just install    # bun install
mkdir -p ~/.config/bark-admin
echo 'server_url = "https://bark.<host>"' > ~/.config/bark-admin/config.toml
just run        # 127.0.0.1:8086 で起動 (BARK_ADMIN_ADDR / BARK_SERVER_URL で変更)。root は bark-server 互換の透過、管理面は /bark-admin/
```

端末は管理 UI の「デバイスを追加」で招待 (タグ・暗号化) を作り、その QR を新しい端末で読んで追加する。招待は削除するまで何度でも使え、QR を開くたびにその 1 台用の登録リンク (24 時間有効、1 回限り) が出る。

通常は caddy-app-proxy から `ondemand/bark-admin-ensure.sh` で on-demand 起動する。

```sh
# タグ宛先で送る (管理 UI は https://bark.<host>/bark-admin/)
curl -sL -X POST https://bark.<host>/bark-admin/push -d '{"device":{"owner":"kawaz"},"title":"hello","body":"world"}'
```

`device` は全キーの AND で、値は完全一致。`"*phone*"` のように両端を `*` で囲むと部分一致、`"*"` だけならそのタグを持つ端末に当たる (`ip*` のような片側の `*` は文字そのもの)。

### 暗号化

デバイス追加で「暗号化する」(既定 on) にすると、招待ページを開くたびに端末ごとの 32 文字の鍵が作られ、Bark にサーバーを追加できた後に招待ページの「暗号化キーをコピーして Bark を開く」でクリップボードに写る。Bark アプリの「推送加密 / Push Encryption」で AES256 / GCM / noPadding を選び、Key にその鍵を貼る。以後 `/bark-admin/push` は、鍵を持つ端末へは通知の中身を AES-256-GCM で暗号化して 1 台ずつ送る (送る側はいつもどおり平文のパラメータを渡す)。既存の端末はデバイス詳細の暗号化の行の「設定する」から「暗号化キーを設定」で鍵を作る (クリップボードに写る)。貼ったら同じダイアログの「暗号化の確認を送る」を押すと暗号化した確認通知が届き、タップすると確認済みになる。通知が届くかどうかは、詳細の受信確認の行の「確認を送る」(平文) で同じように確かめられる。招待ページでは追加・受信確認・暗号化の 3 段を順に案内する。

### 端末情報

登録のたびに Bark アプリの User-Agent / Accept-Language と tailscale whois (X-Forwarded-For の IP) から端末情報 (Bark と iOS の版、tailnet のホスト名・ユーザ等) を記録してデバイス詳細に出し、`name` / `os` / `lang` / `ts_user` のうち未設定のタグを自動で付ける。

## 開発

管理 UI は `src/ui/` (部品と HTML、`style.css`) と `src/client/` (ページごとのブラウザ側 TS) にあり、起動時に `Bun.build` で bundle してメモリから配る (ビルドの成果物はリポに置かない、依存も増やさない)。

```sh
just check   # oxlint + tsc + bun test
just push    # check の後に main を push
```
