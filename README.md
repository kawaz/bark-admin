# bark-admin

iPhone / iPad の Bark アプリへ通知を送るためのデバイス登録簿 + ファンアウト + 管理 UI。bark-server の前段に置く。設計は [docs/DESIGN.md](docs/DESIGN.md)。

## 使い方

```sh
just install    # bun install
mkdir -p ~/.config/bark-admin
echo 'server_url = "https://bark.<host>"' > ~/.config/bark-admin/config.toml
just run        # 127.0.0.1:8086 で起動 (BARK_ADMIN_ADDR / BARK_SERVER_URL で変更)
```

通常は canddy-app-proxy から `ondemand/bark-admin-ensure.sh` で on-demand 起動する。

```sh
curl -sL -X POST https://bark.<host>/push -d '{"device":{"owner":"kawaz"},"title":"hello","body":"world"}'
```

## 開発

```sh
just check   # oxlint + tsc + bun test
just push    # check の後に main を push
```
