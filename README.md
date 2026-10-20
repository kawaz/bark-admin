# bark-admin

iPhone / iPad の Bark アプリへ通知を送るためのデバイス登録簿 + ファンアウト + 管理 UI。bark-server の前段に置く。設計は [docs/DESIGN.md](docs/DESIGN.md)。

## 使い方

```sh
just install    # bun install
mkdir -p ~/.config/bark-admin
echo 'server_url = "https://bark.<host>"' > ~/.config/bark-admin/config.toml
just run        # 127.0.0.1:8086 で起動 (BARK_ADMIN_ADDR / BARK_SERVER_URL で変更)。root は bark-server 互換の透過、管理面は /bark-admin/
```

通常は canddy-app-proxy から `ondemand/bark-admin-ensure.sh` で on-demand 起動する。

```sh
# タグ宛先で送る (管理 UI は https://bark.<host>/bark-admin/)
curl -sL -X POST https://bark.<host>/bark-admin/push -d '{"device":{"owner":"kawaz"},"title":"hello","body":"world"}'
```

### 暗号化

デバイス追加で「暗号化する」(既定 on) にすると、招待ページに 32 文字の鍵が出る。Bark アプリの「推送加密 / Push Encryption」で AES256 / GCM / noPadding を選び、Key にその鍵を貼る。以後 `/bark-admin/push` は、鍵を持つ端末へは通知の中身を AES-256-GCM で暗号化して 1 台ずつ送る (送る側はいつもどおり平文のパラメータを渡す)。既存の端末はデバイス詳細の「暗号化キーを設定」で鍵を作る (クリップボードに写る)。貼ったら「確認」を押すと暗号化した確認通知が届き、タップすると確認済みになる。

## 開発

```sh
just check   # oxlint + tsc + bun test
just push    # check の後に main を push
```
