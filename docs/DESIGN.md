# bark-admin 設計

iPhone / iPad の [Bark](https://github.com/Finb/Bark) アプリへ通知を送るための、デバイス登録簿 + ファンアウト + 管理 UI。[bark-server](https://github.com/Finb/bark-server) (device key → APNs token の転送) の前に置く。root は bark-server 互換のまま透過し、タグで宛先を指定する送信口 `POST /bark-admin/push` と管理 UI / API を `/bark-admin/` 配下に足す。

## 目的と責務

- 目的: 自作ツールやスクリプトが「誰のどの端末に送るか」をタグで指定して通知を送れるようにする。端末の追加・命名・退役を Web UI で行える
- 責務: 登録簿 (タグ、登録日時、退役、端末ごとの暗号化キー、登録の要求から観察した端末情報) / 招待 (再利用できるテンプレ) と使い切りの登録トークンによる登録 / タグによる宛先解決とファンアウト / 鍵を持つ端末への通知内容の暗号化 / 管理 UI
- 責務外: APNs への配送 (bark-server)、Bark アプリへの鍵の設定 (端末の持ち主が招待ページか詳細画面からコピーして手で貼る)、認証 (到達制限は canddy の tailnet_only が担う。device_id は秘密扱いしない)

## 配置

```
iPhone Bark app ──┐
自作ツール ─────┼─ https://bark.<host>/ (canddy, tailnet 限定) ─→ bark-admin 127.0.0.1:8086 ─→ bark-server 127.0.0.1:8085 ─→ APNs
Web UI (人) ──────┘
```

- bark-admin が `bark.<host>` の唯一の upstream。bark-server は直接叩かない (bark 互換の要求も bark-admin の root 面を経由する)
- どちらも常駐せず、canddy の on-demand 起動 (502 → ensure スクリプト → 302)。bark-admin の ensure スクリプト (`ondemand/bark-admin-ensure.sh`) が bark-server の ensure (canddy-app-proxy の `ondemand/bark-server-ensure.sh`) も呼ぶ
- bun + TypeScript。スキーマは valibot で定義し型を導く (境界で parse、`as` / `any` / `!` 禁止)
- 設定: `${XDG_CONFIG_HOME}/bark-admin/config.toml` に `server_url` (招待 URL / QR に埋める公開 URL、例 `https://bark.kawaz-mbp16-20211217.kawaz.jp`) と `db_path` (登録簿の置き場) の 2 つ。listen port (8086) と bark-server の upstream (`127.0.0.1:8085`) は既定値で、変えるときは env `BARK_ADMIN_ADDR` / `BARK_SERVER_URL`
- データ: `${XDG_DATA_HOME}/bark-admin/devices.json` (= `db_path` の既定) (atomic rename で書く。台数が 1 桁なので DB を持たず手で直せる方を優先)。招待は `invites.json`、登録トークンは `registrations.json` (同じディレクトリ)。1 回限りの招待だった頃の `invites.json` (`used_by` を持つ行) は起動時に `invites.legacy-<日時>.json` へ退けて空から始める
- ログ: `${XDG_STATE_HOME}/bark-admin/server.log`

## データ

```jsonc
// devices.json: device_id (= bark の device key) をキーにした map
{
  "DuMUEQLh3pDAagNNFVRraf": {
    "device_token": "0cc6…97bc",            // bark-server の応答の写し。送信には使わない (bark-server が自前の bbolt で引く)
    "registered_at": "2026-10-20T10:02:28+09:00",
    "archived_at": null,                     // 退役は削除せずこれを立てて一覧・送信対象から外す
    "tags": { "owner": "kawaz", "name": "iphone", "family": "kawazu" },  // 平坦な string map、キーは任意
    "crypto": { "key": "<32 文字の [A-Za-z0-9]>", "confirmed_at": null, "pending_nonce": null },  // null なら暗号化しない (キー自体を省いた行も null として読む)
    "delivery": { "confirmed_at": null, "pending_nonce": null },  // 受信の確認 (確認の節)。一度も送っていない行には無く、未確認として読む
    "info": {                                // 登録の要求から観察した端末情報。人は編集しない (PATCH 不可)。再登録のたび丸ごと置き換わる。無い行は次の登録で埋まる
      "bark_version": "1.6.4", "bark_build": "8", "os_version": "iOS 26.7.1",   // Bark アプリの User-Agent から
      "user_agent": "Bark/1.6.4 (me.fin.bark; build:8; iOS 26.7.1) Alamofire/5.10.2",
      "lang": "ja;q=1.0, en;q=0.9",          // Accept-Language の値そのまま
      "ts_name": "zunphone.tail0000.ts.net", "ts_hostname": "zunPhone", "ts_os": "iOS", "ts_user": "<LoginName>", "ts_ip": "100.104.30.107",  // tailscale whois
      "browser_user_agent": "Mozilla/5.0 (iPhone; …) … Safari/604.1", "browser_hints": { "sec-ch-ua-mobile": "?1" },  // 招待ページを開いたブラウザ (登録トークンの browser)
      "last_register_at": "2026-10-20T13:30:00+09:00"
    }                                        // 項目は全部 optional (取れなかったものは書かない)
  }
}
// invites.json: 招待 = 再利用できるテンプレ。削除するまで何度でも使える
{ "<invite>": { "tags": { "owner": "kawaz", "name": "ipad" }, "encrypt": true, "created_at": "…", "note": "家族の iPad 用" } }   // note は任意
// registrations.json: 登録トークン = 招待ページを開くたびに発行する使い切りのサーバ URL (/r/<token>)
{
  "<token>": {
    "invite": "<invite>",
    "crypto": { "key": "…" },                // 招待の encrypt が true ならトークンごとに新しい鍵。false なら null
    "browser": { "user_agent": "…", "hints": { … } },   // 招待ページを開いたブラウザ
    "created_at": "…", "expires_at": "…",    // 期限は 24 時間
    "used_by": null, "used_at": null         // 登録に使われたら device_id と日時
  }
}
```

## 端末情報と自動タグ

登録 (`/register` と `/r/<token>/register`) のたびに、要求から観察できる値を `info` に記録し、そこからタグを自動で付ける。実装は `src/device-info.ts`。

- Bark アプリの要求のヘッダは `User-Agent: Bark/<版> (me.fin.bark; build:<build>; <OS> <版>) Alamofire/<版>` と `Accept-Language` だけ (Sec-CH-UA 等は来ない)。UA がこの形でなければ `bark_version` / `bark_build` / `os_version` は付けない
- canddy が付ける `X-Forwarded-For` の末尾の IP を `/Applications/Tailscale.app/Contents/MacOS/Tailscale whois --json <ip>` (PATH に無い前提の絶対パス、タイムアウト 2 秒) で引き、`Node.Name` (末尾の `.` を落とす) / `Node.Hostinfo.Hostname` / `Node.Hostinfo.OS` / `UserProfile.LoginName` を `ts_*` に写す。whois は bark-server の応答を待つ間に走らせ、失敗・タイムアウト・null の項目は書かないだけで登録は通す
- 招待ページ (`/bark-admin/add/<invite>`) を開いたブラウザの `User-Agent` と `Sec-CH-UA*` をそのとき発行する登録トークンの `browser` に残し、そのトークンでの登録で `browser_user_agent` / `browser_hints` に写す。アプリはトークン入り URL で再登録し続けるので、再登録でも写り続ける
- 自動タグ: `name` = `ts_hostname` の小文字、`os` = `ts_os` (無ければ UA の OS 名) の小文字、`lang` = Accept-Language の先頭の言語の主タグ (`ja`)、`ts_user` = `ts_user`。`owner` は人が決めるので付けない
- タグの優先は 招待 > 既存 > 自動。自動タグは device の `tags` に無いキーだけ埋める (人が消した自動タグは次の登録で戻る)。招待のタグは登録トークンを使う登録 (未使用のトークン) でだけ付け、使用済みトークンでの再登録では付け直さない (人が直したタグを戻さない)

## 暗号化

Bark アプリの「推送加密 / Push Encryption」に合わせ、鍵を持つ端末への通知は bark-admin が暗号化して送る。通知の中身は bark-server と APNs から読めなくなる。仕様は Bark の `Model/Algorithm.swift` (`AESCryptoModel`) と `NotificationServiceExtension/Processor/CiphertextProcessor.swift` で確認した。実装は `src/push-crypto.ts`。

- 方式は AES-256-GCM 固定 (アプリ側の設定は AES256 / GCM / noPadding)。鍵は端末ごとに 32 文字の `[A-Za-z0-9]` を CSPRNG から作り (rejection sampling で偏りなし)、その文字列の UTF-8 バイト列をそのまま鍵にする
- 送るたびに端末ごとに 12 文字の `[A-Za-z0-9]` の IV を作る。平文は bark パラメータ全体の JSON (`device` / `device_key` を含まない)、`ciphertext = base64(暗号文 ‖ 16 byte の auth tag)`、AAD なし。暗号は WebCrypto (`crypto.subtle` の AES-GCM)
- bark-server `/push` へ `{device_key, ciphertext, iv}` で 1 台ずつ送る。アプリは `ciphertext` を復号した JSON を通常のパラメータとして扱う
- 鍵の配り方: 招待を `encrypt: true` で作ると、招待ページを開くたびに発行する登録トークンに端末ごとの新しい鍵を作り、そのトークンでの登録で device へ写る (招待ページには登録できた後に「暗号化キーをコピーして Bark を開く」で渡す) (既存の端末でも写す。使用済みトークンでの再登録では写し直さないので、詳細画面で作り直した鍵は戻らない)。既存の端末は詳細画面の「暗号化キーを設定」で鍵を作り、そのままクリップボードへ写す (作り直す / 外すも詳細画面)。鍵を返すのは詳細 (`GET /bark-admin/api/devices/:id`) と、登録に使った後の `GET /bark-admin/api/registrations/:token/crypto-key` だけで、一覧には `crypto: {confirmed_at}` だけ出す。招待ページの HTML には鍵の平文を入れない
- 確認: 鍵が Bark に正しく貼られたかは、暗号化した通知を端末が復号できたかで確かめる (`kind = crypto`、確認の節)

## 確認

通知が端末に届くか、鍵が Bark に正しく貼られたかを、nonce 入りの `url` を持つ確認通知を端末でタップしてもらって確かめる。種類 (`kind`) は 2 つで、仕組みは同じ:

| kind | 送り方 | 確かめること | 状態の置き場 |
|---|---|---|---|
| `delivery` | 平文 (鍵の有無に関わらず)。title「bark-admin 受信の確認」、body「この通知をタップすると受信確認が完了する」 | 通知が届いてタップできる | `delivery: {confirmed_at, pending_nonce}` |
| `crypto` | 暗号化 (暗号化の節)。title「bark-admin 暗号化の確認」。鍵が無ければ 409 | 復号できる (nonce は暗号文の中にしか無いので、復号できた端末だけが URL を開ける) | `crypto: {key, confirmed_at, pending_nonce}` |

- `POST …/devices/:id/confirm/<kind>` で nonce を作って kind の `pending_nonce` に保存し、`url` = `<server_url>/bark-admin/api/devices/:id/confirm/<kind>/<nonce>` の確認通知を送る。送り直すと前の nonce は無効
- タップで `GET …/confirm/<kind>/<nonce>` が開かれると、その kind の nonce が一致した時だけ `confirmed_at` を記録して nonce を消し「確認できた」の HTML を返す (同じ URL は 1 回だけ効く。別の kind の nonce では効かない)
- 鍵を作り直す / 設定し直すと `crypto` は未確認に戻る。`pending_nonce` は API に出さない

## 登録の流れ (招待と登録トークン)

Bark アプリは `bark://addserver?address=<URL>` でサーバを追加し、`<URL>/ping` → `<URL>/register?devicetoken=…&key=` を叩く (Moya が `baseURL.appendingPathComponent(path)` で結合する。path 付き URL でも成立する、ソースで確認済み)。これを使い、**サーバ URL に使い切りの登録トークンを埋める**。QR が指す招待は再利用でき、トークンは招待ページを開くたびに発行する 2 層にする (同じ QR で何台でも追加でき、鍵は端末ごとに別になる):

1. UI の「デバイス追加」でタグ・メモを入力 (「暗号化する」が既定 on) → `POST /bark-admin/api/invites` → `<invite>` 発行。招待は削除 (`DELETE /bark-admin/api/invites/<invite>`) するまで使える
2. QR の中身は `https://bark.<host>/bark-admin/add/<invite>` (Safari で開く案内ページ。iOS カメラが custom scheme の QR を直接開けるかは未検証なので https にする)。開くたびに登録トークンを発行し (招待が暗号化するならトークンに新しい鍵を作る、開いたブラウザを記録、期限 24 時間)。新しいトークンを発行するときに、期限切れで未使用のトークンを捨てる。ページは 3 段のステップを縦に並べ、段の進み具合は `GET /bark-admin/api/registrations/<token>` を 1 段目を押してから全部済むまで 2 秒おき (とページに戻った `visibilitychange` で即) に読んで決める:
   1. 「Bark にサーバーを追加」(`bark://addserver?address=https://bark.<host>/r/<token>` を開く)。Bark の addServer は address の重複を見ないので、押し直すと同じ address の行が増え、2 回目以降はトークンが使用済み (410) で key の無い行が残る。そのためボタンは押したら disabled にして「Bark で追加中…」にする。押して 1.5 秒以内に `visibilitychange` (hidden) が来なければ Bark が開かなかった (未導入なら iOS はダイアログを出すだけで App Store へ飛ばない) とみなし、ボタンの下に「Bark が開かなかった。入っていなければ App Store から入れてからもう一度」のリンクを出してボタンを押せるように戻す (App Store のリンクはこの時だけ出す)。`state` が `used` になったら ✓ と「追加できた: <name か device_id>」、`expired` / `invite-deleted` / 404 なら「この招待は使えない。QR を読み直す」
   2. 「受信確認」: 登録を見つけたらページが `POST …/devices/<device_id>/confirm/delivery` を 1 回送る (送ったことを sessionStorage に持ち、重ねて送らない)。「届いた通知をタップする」と「もう一度送る」。`device.delivery.confirmed_at` が付いたら ✓
   3. 「暗号化」(鍵付きの招待だけ): 伏せ字 `••••••••` の鍵と「暗号化キーをコピーして Bark を開く」(押すと `…/crypto-key` で鍵を取り、クリックの同期区間で `ClipboardItem` に写してから `bark://` で Bark を前に出す。写せなかった時だけ鍵を見せて手で入れてもらう)、アプリでの設定手順、「暗号化の確認を送る」(`POST …/confirm/crypto`、注記「キーを設定してから」)。`device.crypto.confirmed_at` が付いたら ✓
3. アプリが `/r/<token>/ping` `/r/<token>/register` を叩く → bark-admin は prefix を剥がして bark-server の `/ping` `/register` へ透過し、応答の `device_key` / `device_token` で登録簿を upsert、招待のタグとトークンの鍵を付け、トークンに `used_by` / `used_at` を記録する (トークンは 1 回限り)
   - アプリは APNs token を受け取るたび (= 起動のたび) に、追加済みの全サーバへ `register?key=<自分の key>&devicetoken=…` を送り直す (`ServerManager.syncAllServers`)。トークン入り URL も同じ URL で叩かれ続けるので、使用済みのトークンでも `key` が `used_by` と一致する再登録は通す (期限切れ・招待の削除後も)。register 以外 (ping 等) も使用済みのトークンでは透過する
   - 使用済みのトークンへの別の key (別端末・key 空) の register、期限切れで未使用のトークン (register / ping とも) は bark-server に渡さず 410。招待が消えた未使用のトークンも 410
   - 未知のトークンは 404、未知の (削除された) 招待の案内ページも 404。招待を削除すると、その招待の未使用のトークンも消す (使用済みは端末の再登録のために残す)
4. 招待なしの素の `/register` も受ける (自動タグだけで登録、詳細ページで編集)。既存 key の再登録は token と `info` の更新、自動タグの補充 (端末情報と自動タグの節)

## HTTP API

URL を 2 面に分ける。root は bark-server 互換面で、bark 互換クライアントと Bark アプリはここを叩く。管理と bark-admin 独自の機能は `/bark-admin/` 配下に置く。

### bark-server 互換面 (root)

| method path | 内容 |
|---|---|
| `* /<path>` | bark-server の全 endpoint (`/push` `/ping` `/healthz` `/info` `/register` `/<key>/…` の URL 形式 等) を method / query / body / Content-Type ごとそのまま透過し、応答も丸ごと返す。`/push` に `device` が来ても解釈しない |
| `* /r/:token/<path>` | 登録トークン入りのサーバ URL。`/r/:token` を剥がして同様に透過する。未知のトークンは 404、期限切れ・使用済み (使った本人の再登録を除く) は 410 (登録の流れ参照) |
| `GET /` | `302 /bark-admin/` |

bark-admin が中身を見るのは `/register` と `/r/:token/register` の 1 点だけ: bark-server が 200 で返した `data.device_key` / `data.device_token` を登録簿に写し、要求のヘッダと whois から `info` と自動タグを付ける (登録の流れ、端末情報と自動タグの節参照)。

### 管理面 (`/bark-admin/`)

| method path | 内容 |
|---|---|
| `POST /bark-admin/push` | bark-admin 独自の送信 API。body = bark V2 パラメータ (`device_key` / `device_keys` / `ciphertext` / `iv` を除く) + `device: {k: v, …}` (全キーの AND。値は `v` で完全一致、両端が `*` の `*v*` で v を含む、`*` (と `**`) でそのキーがあれば当たる。`v*` / `*v` の `*` は文字そのもので完全一致。否定・エスケープは無い。省略時は active 全台)。該当 device を解決し、鍵を持つ device は 1 台ずつ暗号化して (暗号化の節)、残りは bark-server `/push` に `device_keys` で一括送信、`{sent: [{device_id, status, message?, encrypted}], skipped: n}` を返す (`sent` は宛先の並び順、`status` / `message` は bark-server の device ごとの結果、`encrypted` は暗号化して送ったか、`skipped` はタグに当たったが退役済みで外した台数)。該当 0 台なら bark-server を呼ばず 404。body は Content-Type に関わらず JSON として読み、スキーマに無いキー (`device_key` / `device_keys` / `ciphertext` / `iv` を含む) は 400 |
| `GET /bark-admin/api/devices?k=v&…&archived=1` | `k=v` は `/bark-admin/push` の `device` と同じ解釈 (完全一致 / `*v*` / `*`)。jsonl (1 行 1 device、`device_id` 付き、`crypto` は `{confirmed_at}` か null で鍵を含まない、`delivery` は `{confirmed_at}`、`info` は `{ts_hostname, os_version}` だけ)。既定は active のみ |
| `GET /bark-admin/api/devices/:id` | 1 件 JSON (`crypto` は `{key, confirmed_at}` か null、`delivery` は `{confirmed_at}`、`info` は全項目で、無い device は `{}`) |
| `PATCH /bark-admin/api/devices/:id` | `{tags}` でタグ置換、`{crypto: {key}}` / `{crypto: null}` で鍵の設定 / 解除。`info` は観察値なので受け付けない (400) |
| `POST /bark-admin/api/devices/:id/crypto` | 新しい鍵を作って保存し (未確認に戻る)、鍵入りの device を返す (詳細画面の「暗号化キーを設定」「鍵を作り直す」) |
| `POST /bark-admin/api/devices/:id/confirm/:kind` | 確認通知を送る (確認の節)。`kind` は `delivery` (平文) か `crypto` (暗号化、鍵が無ければ 409)、それ以外は 404。`{sent: {device_id, status, message?, encrypted}}`、bark-server が受けなければ 502 |
| `GET /bark-admin/api/devices/:id/confirm/:kind/:nonce` | 確認通知の `url`。kind の nonce が一致すれば確認済みにして「確認できた」の HTML、不一致は 404 の HTML |
| `DELETE /bark-admin/api/devices/:id` | `archived_at` を立てる (復帰は PATCH `{archived_at: null}`) |
| `POST /bark-admin/api/invites` `{tags, encrypt?, note?}` | 201 で招待 `{invite, add_url, tags, encrypt, created_at, note?, registered: 0}`。`encrypt` の既定は false (UI は既定 on で送る) |
| `GET /bark-admin/api/invites` | jsonl (1 行 1 招待、POST の応答と同じ形、`registered` はその招待の使用済みトークンの数 = 登録した端末の数) |
| `GET /bark-admin/api/registrations/:token` | 招待ページが登録の完了を見る。`{token, state, used_by, used_at, expires_at, encrypted, device}`。`state` は `unused` / `used` / `expired` / `invite-deleted` (使用済みなら期限や招待の削除に関わらず `used`)、`device` は使用済みなら `{device_id, tags, info?, delivery: {confirmed_at}, crypto: {confirmed_at} | null}`、それ以外 null。鍵は返さない。不明なトークンは 404 |
| `GET /bark-admin/api/registrations/:token/crypto-key` | トークンの鍵 `{key}` (`cache-control: no-store`、何度でも取れる)。登録に使う前は 409、鍵の無いトークン・不明なトークンは 404 |
| `DELETE /bark-admin/api/invites/:invite` | 招待とその未使用のトークンを消す。204、無ければ 404 |
| `GET /bark-admin/api/invites/:invite/qr.svg` | `add_url` の QR (SVG)。TOP のデバイス追加で表示する |
| `GET /bark-admin/api/schema` | 通知パラメータのスキーマ (`{fields: [{name, kind, group, description, …}]}`)。TOP のテストフォームはこれから描く |
| `GET /bark-admin/` `/bark-admin/devices/:id` `/bark-admin/add/:invite` | 画面 (下記)。静的ファイルは `/bark-admin/assets/`。`/bark-admin/add/:invite` は開くたびに登録トークンを発行する (`cache-control: no-store`) |

パラメータのスキーマ (title / subtitle / body / markdown / sound / icon / image / group / level / volume / badge / call / url / copy / autoCopy / isArchive / ttl / action / id / delete) は `src/schema/push-params.ts` の 1 か所で定義し、`/bark-admin/push` の検証と TOP のフォーム生成の両方に使う。出典は bark-server `docs/API_V2.md` と Bark `docs/en-us/params.md`。暗号化の `ciphertext` / `iv` は bark-admin が作るので受け付けない (root の互換面は従来どおり透過する)。型は bark-server の扱いに合わせる: `badge` / `ttl` は JSON の整数、`volume` は `"0"`〜`"10"` の文字列、`call` / `autoCopy` / `delete` は `"1"`、`isArchive` は `"1"` / `"0"`、`delete` は `id` 必須。

### bark-server の応答 (v2.3.9 で確認)

- 共通: `{code, message, timestamp, data?}`
- `/register` (GET は `devicetoken` / `key` の query、POST は body): `data = {key, device_key, device_token}`。`key` が空なら bark-server が新しい key を発行する。登録済み key は token を上書き
- `/push` に `device_keys` (配列 or カンマ区切り) を渡すと、HTTP 200 で `data = [{device_key, code, message?}]` (device ごとの結果、失敗時だけ message)。1 台でも配列で返る
- `/push` に `device_key` 1 台を渡すと `data` は無く、結果は `{code, message}` で HTTP status も `code` と同じ
- APNs が `BadDeviceToken` / 410 を返した device は bark-server 側で token が空にされる (登録簿は変わらない)

## 画面

- `/bark-admin/` TOP: 通知テストフォーム (スキーマから生成、送信先はフィルタに当たる全台) / フィルタ入力 (`k=v` 改行区切り AND、値は `device` と同じ解釈) / デバイス一覧 (device_id, owner, name とその下に `info.os_version`, 暗号化の有無と未確認, 主要 4 tag + 残り n 件, registered_at。device_id で詳細へ) / デバイス追加 (招待の作成: タグ・メモ・「暗号化する」(既定 on) → QR、招待の一覧: タグ・メモ・暗号化・登録数、QR を再表示 / 削除)
- `/bark-admin/devices/:id`: タグ編集、暗号化 (無効 / 有効・未確認 / 有効・確認済み <日時>、「暗号化キーを設定」で鍵を作ってコピー、再コピー、「暗号化の確認を送る」、作り直す、無効にする)、受信確認 (未確認 / 確認済み <日時>、「受信確認を送る」)、端末情報 (`info` の定義リスト、無い項目は出さない)、退役ボタン、device_token と登録日時
- `/bark-admin/add/:invite`: 招待の案内ページ。開くたびにその 1 台用の登録トークンを発行する。3 段のステップ (1. Bark にサーバーを追加 (1 回だけ押せる、Bark が開かなかった時だけ App Store の案内) → 2. 受信確認 → 3. 暗号化 (鍵付きの招待だけ、伏せ字の鍵をコピーして Bark を開く、暗号化の確認を送る))。済んだ段に ✓、今の段を強調、先の段は薄く (登録の流れ参照)
- ビルド無しの静的 HTML + fetch。モダン CSS / JS (Baseline) を使い古いハックで代替しない

## 送信側の規約

正本は claude-rules-personal の reference `bark-push`。要点: タグ宛先の送信は常に `https://bark.<host>/bark-admin/push` (FQDN 経由。127.0.0.1 直結は on-demand 起動が効かない)、cold start では 302 が返るので `-L` か 1 回リトライ、宛先は `device` フィルタで指定。
