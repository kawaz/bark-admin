# bark-admin 設計

iPhone / iPad の [Bark](https://github.com/Finb/Bark) アプリへ通知を送るための、デバイス登録簿 + ファンアウト + 管理 UI。[bark-server](https://github.com/Finb/bark-server) (device key → APNs token の転送) の前に置く。root は bark-server 互換のまま透過し、タグで宛先を指定する送信口 `POST /bark-admin/push` と管理 UI / API を `/bark-admin/` 配下に足す。

## 目的と責務

- 目的: 自作ツールやスクリプトが「誰のどの端末に送るか」をタグで指定して通知を送れるようにする。端末の追加・命名・退役を Web UI で行える
- 責務: 登録簿 (タグ、登録日時、退役、端末ごとの暗号化キー、登録の要求から観察した端末情報) / 招待 (再利用できるテンプレ) と使い切りの登録トークンによる登録 / 公開名が変わった端末の新しい公開名での登録し直し (移行) / タグによる宛先解決とファンアウト / 鍵を持つ端末への通知内容の暗号化 / 管理 UI
- 責務外: APNs への配送 (bark-server)、Bark アプリへの鍵の設定 (端末の持ち主が招待ページか詳細画面からコピーして手で貼る)、認証 (到達制限は caddy-app-proxy の tailnet_only が担う。device_id は秘密扱いしない)

## 配置

```
iPhone Bark app ──┐
自作ツール ─────┼─ https://bark.<host>/ (caddy-app-proxy, tailnet 限定) ─→ bark-admin 127.0.0.1:8086 ─→ bark-server 127.0.0.1:8085 ─→ APNs
Web UI (人) ──────┘
```

- bark-admin が `bark.<host>` の唯一の upstream。bark-server は直接叩かない (bark 互換の要求も bark-admin の root 面を経由する)
- どちらも常駐せず、caddy-app-proxy の on-demand 起動 (502 → ensure スクリプト → 302)。bark-admin の ensure スクリプト (`ondemand/bark-admin-ensure.sh`) が bark-server の ensure (caddy-app-proxy の `ondemand/bark-server-ensure.sh`) も呼ぶ
- bun + TypeScript。スキーマは valibot で定義し型を導く (境界で parse、`as` / `any` / `!` 禁止)
- 設定: `${XDG_CONFIG_HOME}/bark-admin/config.toml` に `server_url` (招待 URL / QR に埋める公開 URL、例 `https://bark.kawaz-mbp.kawaz.jp`) と `db_path` (登録簿の置き場) の 2 つ。listen port (8086) と bark-server の upstream (`127.0.0.1:8085`) は既定値で、変えるときは env `BARK_ADMIN_ADDR` / `BARK_SERVER_URL`。`X-Forwarded-For` を信頼する前段は既定で loopback だけで、足すときは env `BARK_ADMIN_TRUSTED_PROXIES` (CIDR のカンマ区切り)
- データ: `${XDG_DATA_HOME}/bark-admin/devices.json` (= `db_path` の既定) (atomic rename で書く。台数が 1 桁なので DB を持たず手で直せる方を優先)。招待は `invites.json`、登録トークンは `registrations.json` (同じディレクトリ)。1 回限りの招待だった頃の `invites.json` (`used_by` を持つ行) は起動時に `invites.legacy-<日時>.json` へ退けて空から始める
- ログ: `${XDG_STATE_HOME}/bark-admin/server.log`

## データ

```jsonc
// devices.json: device_id (= bark の device key) をキーにした map
{
  "DuMUEQLh3pDAagNNFVRraf": {
    "device_token": "0cc6…97bc",            // bark-server の応答の写し。送信には使わない (bark-server が自前の bbolt で引く)。API にも画面にも出さない
    "registered_at": "2026-10-20T10:02:28+09:00",
    "archived_at": null,                     // 退役は削除せずこれを立てて一覧・送信対象から外す
    "tags": { "owner": "kawaz", "name": "iphone", "family": "kawazu" },  // 平坦な string map、キーは任意
    "crypto": { "key": "<32 文字の [A-Za-z0-9]>", "confirmed_at": null, "pending_nonce": null },  // null なら暗号化しない (キー自体を省いた行も null として読む)
    "delivery": { "confirmed_at": null, "pending_nonce": null },  // 受信の確認 (確認の節)。一度も送っていない行には無く、未確認として読む
    "info": {                                // 登録の要求から観察した端末情報。人は編集しない (PATCH 不可)。再登録のたび丸ごと置き換わる。無い行は次の登録で埋まる
      "bark_version": "1.6.4", "bark_build": "8", "os_version": "iOS 26.7.1",   // Bark アプリの User-Agent から
      "user_agent": "Bark/1.6.4 (me.fin.bark; build:8; iOS 26.7.1) Alamofire/5.10.2",
      "lang": "ja;q=1.0, en;q=0.9",          // Accept-Language の値そのまま
      "server_host": "bark.kawaz-mbp.kawaz.jp",  // 要求の Host から port を落としたもの (= 端末が Bark に追加した address のホスト)
      "ts_name": "zunphone.tail0000.ts.net", "ts_machine": "zunphone", "ts_hostname": "zunPhone", "ts_os": "iOS", "ts_user": "<LoginName>", "ts_ip": "100.104.30.107",  // tailscale whois
      "device_kind": "iphone",               // 招待ページのブラウザが送った client から判定 (ipad / iphone / mac / android)
      "browser_user_agent": "Mozilla/5.0 (iPhone; …) … Safari/604.1", "browser_platform": "iPhone", "browser_max_touch_points": "5", "browser_language": "ja-JP", "browser_screen": "390x844@3",  // その client
      "last_register_at": "2026-10-20T13:30:00+09:00"
    },                                       // 項目は全部 optional (取れなかったものは書かない)
    "migrated_to": "<新しい device_id>", "migrated_at": "…",  // 旧端末: 移行トークンでの登録で付く (移行の節)
    "migrated_from": "<旧 device_id>"         // 新しい端末: 移行トークンで登録した時の移行元。どれも移行に関わらない行には無く、API は null で出す
  }
}
// invites.json: 招待 = 再利用できるテンプレ。削除するまで何度でも使える
{ "<invite>": { "tags": { "owner": "kawaz", "name": "ipad" }, "encrypt": true, "created_at": "…" } }   // 見分けはタグと作成日時
// registrations.json: 登録トークン = 使い切りのサーバ URL (/r/<token>)。招待ページを開くたびに発行するものと、移行 API が発行する移行トークンの 2 種類
{
  "<token>": {
    "invite": "<invite>",
    "migrate_from": null,                    // 招待のトークンは null (キーを省いた行も null として読む)
    "crypto": { "key": "…" },                // 招待の encrypt が true ならトークンごとに新しい鍵。false なら null
    "client": { "user_agent": "…", "platform": "MacIntel", "max_touch_points": 5, "language": "ja-JP", "screen": { "w": 1024, "h": 1366, "dpr": 2 } },  // 招待ページの JS が送る (送る前は null)
    "created_at": "…", "expires_at": "…",    // 期限は 24 時間
    "used_by": null, "used_at": null         // 登録に使われたら device_id と日時
  },
  "<migration token>": {
    "migrate_from": "<旧 device_id>",        // 移行トークン (移行の節)。invite は持たない
    "tags": { "owner": "kawaz", "name": "iphone" },        // 発行した時の旧端末のタグ全部
    "crypto": { "key": "…", "confirmed_at": "…" },         // 旧端末の鍵と暗号化の確認状態 (鍵が無ければ null)
    "client": null, "created_at": "…", "expires_at": "…", "used_by": null, "used_at": null  // 招待のトークンと同じ
  }
}
```

## 端末情報と自動タグ

登録 (`/register` と `/r/<token>/register`) のたびに、要求から観察できる値を `info` に記録し、そこからタグを自動で付ける。実装は `src/device-info.ts`。

- Bark アプリの要求のヘッダは `User-Agent: Bark/<版> (me.fin.bark; build:<build>; <OS> <版>) Alamofire/<版>` と `Accept-Language` だけ (Sec-CH-UA 等は来ない)。UA がこの形でなければ `bark_version` / `bark_build` / `os_version` は付けない
- `server_host`: 要求の `Host` (caddy-app-proxy が透過する公開ホスト名) から port を落とし小文字にしたもの。Bark アプリはサーバ追加時の address を持ち続けて以後の登録もそこへ送るので、公開名 (`server_url`) を変えた後も古い名前のまま来る端末をこれで見分ける。画面は `server_url` のホスト名と違えば「古い」と注記する
- 端末の IP: 接続元の実 IP (`server.requestIP`) が loopback (`127.0.0.0/8`, `::1`) か env `BARK_ADMIN_TRUSTED_PROXIES` (CIDR のカンマ区切り) に含まれる時だけ `X-Forwarded-For` の末尾 (= 前段の Caddy が見た接続元) を使い、それ以外は接続元の IP をそのまま使う。XFF は Caddy (loopback) 経由の時だけ信頼する (他から来た XFF は誰でも書ける)。実装は `src/client-ip.ts`
- Tailscale があれば `ts_*` も記録する: その IP を `/Applications/Tailscale.app/Contents/MacOS/Tailscale whois --json <ip>` (PATH に無い前提の絶対パス、タイムアウト 2 秒) で引き、`Node.Name` (末尾の `.` を落とす) / `Node.ComputedName` (Tailscale のマシン名 → `ts_machine`) / `Node.Hostinfo.Hostname` (iPadOS は `localhost`) / `Node.Hostinfo.OS` / `UserProfile.LoginName` を `ts_*` に写す。whois は bark-server の応答を待つ間に走らせる。CLI が無い・失敗・タイムアウトなら黙って何も書かず、登録も自動タグも Tailscale 無しで完結する (起動時に CLI が無ければ「tailscale: not available」を 1 行だけログに出す)
- 招待ページの JS が、表示した時に 1 回 `POST /bark-admin/api/registrations/<token>/client` で `{user_agent, platform, max_touch_points, language, screen: {w, h, dpr}}` を送り、登録トークンの `client` に残す。そのトークンでの登録で `device_kind` と `browser_*` に写す (アプリはトークン入り URL で再登録し続けるので、再登録でも写り続ける)。HTTP ヘッダでは iPad を見分けられない (iPad の Safari はデスクトップ表示で `Macintosh` を名乗り、Bark の UA も Tailscale も `iOS` と報告する) ので、よく使われる判定をそのまま使う: `platform` が `MacIntel` かつ `max_touch_points > 1` → ipad、UA に `iPad` → ipad、`iPhone` → iphone、`Macintosh` でタッチ無し → mac、`Android` → android
- 自動タグ (Tailscale に依存しない): `name` = 端末の種類そのまま (`iphone` / `ipad` / `mac` / `android`。`device_kind`、無ければ Bark の UA の OS が `iOS` なら `iphone`、それも無ければ付けない。name は自由記入欄で後から人が直す前提なので凝らない)、`os` = その種類の OS (`ios` / `ipados` / `macos` / `android`、種類が無ければ UA の OS 名の小文字)、`lang` = Accept-Language の先頭の言語の主タグ (`ja`)、`ts_user` = whois が取れた時だけ LoginName。`owner` は人が決めるので付けない
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
| `delivery` | 平文 (鍵の有無に関わらず)。title「bark-admin 受信の確認」、body「この通知をタップすると受信確認が完了する」+ 改行 + `device: <device_id>` | 通知が届いてタップできる | `delivery: {confirmed_at, pending_nonce}` |
| `crypto` | 暗号化 (暗号化の節)。title「bark-admin 暗号化の確認」、body「この通知をタップすると暗号化の確認が完了する」+ 改行 + `device: <device_id>`。鍵が無ければ 409 | 復号できる (nonce は暗号文の中にしか無いので、復号できた端末だけが URL を開ける) | `crypto: {key, confirmed_at, pending_nonce}` |

- `POST …/devices/:id/confirm/<kind>` で nonce を作って kind の `pending_nonce` に保存し、`url` = `<server_url>/bark-admin/api/devices/:id/confirm/<kind>/<nonce>` の確認通知を送る。送り直すと前の nonce は無効
- タップで `GET …/confirm/<kind>/<nonce>` が開かれると、その kind の nonce が一致した時だけ `confirmed_at` を記録して nonce を消し「確認できた」の HTML を返す (同じ URL は 1 回だけ効く。別の kind の nonce では効かない)。ページは詳細の要約で、詳細と同じ 3 節 (「端末」= device_id / registered_at / 受信確認 / 暗号化、「タグ」= 全部をチップで、「端末情報」= device_kind / os_version / ts_machine があれば) に分け、今回確認した kind の行を太字にする。続けて 詳細 (`/bark-admin/devices/:id`) への「この端末の設定を開く」を出す。nonce が合わない (使用済み・古い) 時は 404 の HTML で、TOP (`/bark-admin/`) へのリンクを置く
- Bark のサーバー一覧に同じ address が複数並んでも、各行の key が device_id なので、通知の body・確認できたページ・招待ページの「追加できた」・詳細の見出し直下に出す device_id と見比べれば登録簿上のどの端末かが分かる
- 鍵を作り直す / 設定し直すと `crypto` は未確認に戻る。`pending_nonce` は API に出さない

## 登録の流れ (招待と登録トークン)

Bark アプリは `bark://addserver?address=<URL>` でサーバを追加し、`<URL>/ping` → `<URL>/register?devicetoken=…&key=` を叩く (Moya が `baseURL.appendingPathComponent(path)` で結合する。path 付き URL でも成立する、ソースで確認済み)。これを使い、**サーバ URL に使い切りの登録トークンを埋める**。QR が指す招待は再利用でき、トークンは招待ページを開くたびに発行する 2 層にする (同じ QR で何台でも追加でき、鍵は端末ごとに別になる):

1. UI の「デバイス追加」でタグを入力 (「暗号化する」が既定 on) → `POST /bark-admin/api/invites` → `<invite>` 発行。招待は削除 (`DELETE /bark-admin/api/invites/<invite>`) するまで使える
2. QR の中身は `https://bark.<host>/bark-admin/add/<invite>` (Safari で開く案内ページ。iOS カメラが custom scheme の QR を直接開けるかは未検証なので https にする)。開くたびに登録トークンを発行し (招待が暗号化するならトークンに新しい鍵を作る、期限 24 時間)、ページの JS が端末の手がかり (client) を送る。新しいトークンを発行するときに、期限切れで未使用のトークンを捨てる。ページは 3 段のステップを縦に並べ、段の進み具合は `GET /bark-admin/api/registrations/<token>` を 1 段目を押してから全部済むまで 2 秒おき (とページに戻った `visibilitychange` で即) に読んで決める:
   1. 「Bark にサーバーを追加」(`bark://addserver?address=https://bark.<host>/r/<token>` を開く)。ボタンは登録 (`state` が `used`) を見つけるまで押せる。Bark が未導入で App Store から入れて戻った時や、Bark で中断した時にやり直せるようにするため。押した直後の二重タップだけ 1 秒止める (Bark の addServer は address の重複を見ず、2 回目以降はトークンが使用済み (410) で key の無い行が残るので)。`visibilitychange` は状態を読み直す合図にだけ使い、ボタンの可否には使わない。押して 1.5 秒以内に hidden が来なければ Bark が開かなかった (未導入なら iOS はダイアログを出すだけで App Store へ飛ばない) とみなし、ボタンの下に「Bark が開かなかった。入っていなければ App Store から入れてからもう一度」のリンクを出す (App Store のリンクはこの時だけ出す)。`used` になったらボタンを消して ✓ と「追加できた: <name> <device_id>」、`expired` / `invite-deleted` / 404 なら「この招待は使えない。QR を読み直す」
   2. 「受信確認」: 登録を見つけたらページが `POST …/devices/<device_id>/confirm/delivery` を 1 回送る (送ったことを sessionStorage に持ち、送れなかった時も含めて重ねて送らない)。案内「サーバーの登録が完了した。確認の通知を送ったので、届いたらタップする」と「確認通知を再送する」(届かない・消した時用、押すたびに送る)。`device.delivery.confirmed_at` が付いたら ✓ (鍵なしの招待はここで「受信確認が完了した。すべて完了した」)
   3. 「暗号化」(鍵付きの招待だけ): 案内「受信確認が完了した。続いて暗号化を設定する。『暗号化キーをコピーして Bark を開く』を押し、Bark の暗号化設定に貼って保存したら『暗号化の確認通知を送る』を押す」、伏せ字 `••••••••` の鍵と「暗号化キーをコピーして Bark を開く」(押すと `…/crypto-key` で鍵を取り、クリックの同期区間で `ClipboardItem` に写してから `bark://` で Bark を前に出す。写せなかった時だけ鍵を見せて手で入れてもらう)、アプリでの設定手順、「暗号化の確認通知を送る」(`POST …/confirm/crypto`)。`device.crypto.confirmed_at` が付いたら ✓ と「暗号化の確認が完了した。すべて済んだ」
   - 段の表示・ボタンの有無・案内の文言は登録トークンの状態だけから決める純粋関数 (`src/client/add-state.ts` の `flowView`) で、`bun test` で状態との対応を固定している
   - 全部の段が済んだら「すべて済んだ」と、登録した端末の詳細への「この端末の設定を開く」を出す。未知の (削除された) 招待の案内ページは 404 の HTML で、TOP へのリンクを置く
3. アプリが `/r/<token>/ping` `/r/<token>/register` を叩く → bark-admin は prefix を剥がして bark-server の `/ping` `/register` へ透過し、応答の `device_key` / `device_token` で登録簿を upsert、招待のタグとトークンの鍵を付け、トークンに `used_by` / `used_at` を記録する (トークンは 1 回限り)
   - アプリは APNs token を受け取るたび (= 起動のたび) に、追加済みの全サーバへ `register?key=<自分の key>&devicetoken=…` を送り直す (`ServerManager.syncAllServers`)。トークン入り URL も同じ URL で叩かれ続けるので、使用済みのトークンでも `key` が `used_by` と一致する再登録は通す (期限切れ・招待の削除後も)。register 以外 (ping 等) も使用済みのトークンでは透過する
   - 使用済みのトークンへの別の key (別端末・key 空) の register、期限切れで未使用のトークン (register / ping とも) は bark-server に渡さず 410。招待が消えた未使用のトークンも 410
   - 未知のトークンは 404、未知の (削除された) 招待の案内ページも 404。招待を削除すると、その招待の未使用のトークンも消す (使用済みは端末の再登録のために残す)
4. 招待なしの素の `/register` も受ける (自動タグだけで登録、詳細ページで編集)。既存 key の再登録は token と `info` の更新、自動タグの補充 (端末情報と自動タグの節)

## 移行 (公開名が変わった端末の登録し直し)

Bark アプリはサーバ追加時の address に登録し続けるので、公開名 (`server_url`) を変えても古い名前で来る端末が残る (`info.server_host` が今の公開名と違う端末)。その端末に新しい公開名のサーバーを追加させ、登録簿上は新しい device として作り直す。Bark の暗号化設定はアプリに 1 つで鍵は貼られたままなので、鍵と暗号化の確認状態は引き継ぎ、受信確認だけ取り直す。

1. 詳細の「新しいサーバー名で登録し直す」→ `POST /bark-admin/api/devices/:id/migrate`。旧端末のタグ全部と `crypto` (key / confirmed_at) を写した移行トークン (`migrate_from` = 旧 device_id、期限 24 時間) を作り、旧端末へ通知を送る: title「bark-admin サーバー名の更新」、body「新しいサーバー名 <今の公開名> で登録し直す。タップして案内に従う」+ 改行 + `device: <id>`、`url` = `<server_url>/bark-admin/add/m/<token>`。旧端末に鍵があれば暗号化して送る。期限内で未使用の移行トークンがあればそれを使い回し (タグと鍵は今の旧端末の値に写し直す)、トークンを増やさない。移行済み (`migrated_to` がある) の端末は 409
2. 通知をタップすると移行の案内ページ `/bark-admin/add/m/<token>` が開く。招待ページと同じ段の UI と JS (`src/client/add.ts`、`/client` を送る、状態の読み方も同じ) で、1 段目は見出しとボタンが「新しいサーバー名で追加」(`bark://addserver?address=<server_url>/r/<token>`)、タグは旧端末のもの、2 段目は受信確認。鍵を引き継ぐので暗号化の段は無い (鍵の無い端末も同じ 2 段)。開いてもトークンは発行しない
3. アプリが `/r/<token>/register` を叩くと、招待のトークンと同じく新しい device を作り、トークンのタグと鍵 (確認状態ごと) を写す (タグの優先は トークン > 既存 > 自動)。加えて旧端末に `migrated_to` (新しい device_id) と `migrated_at` を記録し、新しい端末へ完了の案内を送る: title「bark-admin 移行完了」、body「この端末は <今の公開名> で登録された。Bark のサーバーリストから <旧端末の server_host> を削除してよい」+ 改行 + `device: <新 id>` (鍵があれば暗号化)。送れなくても登録は済んでいるので、Bark アプリへの応答は変えずにログに残す
   - 新しい端末には `migrated_from` (旧 device_id) を記録する。旧端末の受信確認・暗号化の確認・`info` は触らない
   - 新しい端末の受信確認は案内ページの 2 段目で取り直す
4. 新しい端末の受信確認 (`GET …/confirm/delivery/<nonce>` で `delivery.confirmed_at` が付いた時) で、その端末の `migrated_from` の旧端末を自動で退役させる (`archived_at` を立てる。退役済みなら日時を保つ。`migrated_to` はそのまま)。鍵を持つ端末の移行は案内を暗号化して送っているので、ここまで来れば暗号の受信まで確かめられている。旧端末は一覧の既定から消え、`archived=1` で「移行済み」として見える
   - 移行トークンはタグと鍵を自分で持ち招待に依らないので、招待の削除や旧端末の有無で使えなくならない (`state` が `invite-deleted` にならない)。使用済み・期限切れの扱いは招待のトークンと同じ (登録の流れの 3)。招待の登録数には数えない

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
| `GET /bark-admin/api/devices?k=v&…&archived=1` | `k=v` は `/bark-admin/push` の `device` と同じ解釈 (完全一致 / `*v*` / `*`)。jsonl (1 行 1 device、`device_token` は含まない、`device_id` 付き、`crypto` は `{confirmed_at}` か null で鍵を含まない、`delivery` は `{confirmed_at}`、`info` は `{ts_hostname, os_version, server_host}` だけ、`migrated_to` / `migrated_at` / `migrated_from` は移行に関わっていなければ null)。既定は active のみ |
| `GET /bark-admin/api/devices/:id` | 1 件 JSON (`device_token` は含まない、`crypto` は `{key, confirmed_at}` か null、`delivery` は `{confirmed_at}`、`info` は全項目で、無い device は `{}`、`migrated_to` / `migrated_at` は一覧と同じ) |
| `PATCH /bark-admin/api/devices/:id` | `{tags}` でタグ置換、`{crypto: {key}}` / `{crypto: null}` で鍵の設定 / 解除。`info` は観察値なので受け付けない (400) |
| `POST /bark-admin/api/devices/:id/crypto` | 新しい鍵を作って保存し (未確認に戻る)、鍵入りの device を返す (詳細画面の「暗号化キーを設定」「鍵を作り直す」) |
| `POST /bark-admin/api/devices/:id/confirm/:kind` | 確認通知を送る (確認の節)。`kind` は `delivery` (平文) か `crypto` (暗号化、鍵が無ければ 409)、それ以外は 404。`{sent: {device_id, status, message?, encrypted}}`、bark-server が受けなければ 502 |
| `GET /bark-admin/api/devices/:id/confirm/:kind/:nonce` | 確認通知の `url`。kind の nonce が一致すれば確認済みにして「確認できた」の HTML、不一致は 404 の HTML |
| `POST /bark-admin/api/devices/:id/migrate` | 移行トークンを用意して旧端末へ移行の案内の通知を送る (移行の節)。`{token, sent: {device_id, status, message?, encrypted}}`、bark-server が受けなければ 502 (`token` も返す)、移行済みは 409、不明な device は 404 |
| `DELETE /bark-admin/api/devices/:id` | `archived_at` を立てる (復帰は PATCH `{archived_at: null}`) |
| `POST /bark-admin/api/invites` `{tags, encrypt?}` | 201 で招待 `{invite, add_url, tags, encrypt, created_at, registered: 0}`。`encrypt` の既定は false (UI は既定 on で送る) |
| `GET /bark-admin/api/invites` | jsonl (1 行 1 招待、POST の応答と同じ形、`registered` はその招待の使用済みトークンの数 = 登録した端末の数) |
| `GET /bark-admin/api/registrations/:token` | 招待ページが登録の完了を見る。`{token, state, used_by, used_at, expires_at, encrypted, device}`。`state` は `unused` / `used` / `expired` / `invite-deleted` (使用済みなら期限や招待の削除に関わらず `used`)、`device` は使用済みなら `{device_id, tags, info?, delivery: {confirmed_at}, crypto: {confirmed_at} | null}`、それ以外 null。鍵は返さない。不明なトークンは 404 |
| `POST /bark-admin/api/registrations/:token/client` | 招待ページの JS が送る端末の手がかり `{user_agent, platform, max_touch_points, language, screen: {w, h, dpr}}` をトークンに残す (端末情報と自動タグの節)。204、形が違えば 400、不明なトークンは 404 |
| `GET /bark-admin/api/registrations/:token/crypto-key` | トークンの鍵 `{key}` (`cache-control: no-store`、何度でも取れる)。登録に使う前は 409、鍵の無いトークン・不明なトークンは 404 |
| `DELETE /bark-admin/api/invites/:invite` | 招待とその未使用のトークンを消す。204、無ければ 404 |
| `GET /bark-admin/api/invites/:invite/qr.svg` | `add_url` の QR (SVG)。TOP のデバイス追加で表示する |
| `GET /bark-admin/api/schema` | 通知パラメータのスキーマ (`{fields: [{name, kind, group, description, …}]}`)。TOP のテストフォームはこれから描く |
| `GET /bark-admin/api/config` | 今の公開名 `{server_host}` (`server_url` のホスト名)。画面が端末の `info.server_host` と見比べて古い公開名を注記する |
| `GET /bark-admin/` `/bark-admin/devices/:id` `/bark-admin/add/:invite` `/bark-admin/add/m/:token` | 画面 (下記)。静的ファイルは `/bark-admin/assets/`。HTML と静的ファイルは `Cache-Control: no-cache` + ETag (内容の hash、一致すれば 304) で配り、HTML の中の asset 参照には起動時に計算した内容の hash で `?v=<先頭 8>` を付ける (古い JS / CSS が残って HTML と版がずれないように。JS はページごとに import を持たない 1 本の bundle)。`/bark-admin/add/:invite` は開くたびに登録トークンを発行する (`cache-control: no-store`)。`/bark-admin/add/m/:token` は移行トークンの案内ページ (発行しない、`cache-control: no-store`、移行トークンでなければ 404 の HTML) |

パラメータのスキーマ (title / subtitle / body / markdown / sound / icon / image / group / level / volume / badge / call / url / copy / autoCopy / isArchive / ttl / action / id / delete) は `src/schema/push-params.ts` の 1 か所で定義し、`/bark-admin/push` の検証と TOP のフォーム生成の両方に使う。出典は bark-server `docs/API_V2.md` と Bark `docs/en-us/params.md`。暗号化の `ciphertext` / `iv` は bark-admin が作るので受け付けない (root の互換面は従来どおり透過する)。型は bark-server の扱いに合わせる: `badge` / `ttl` は JSON の整数、`volume` は `"0"`〜`"10"` の文字列、`call` / `autoCopy` / `delete` は `"1"`、`isArchive` は `"1"` / `"0"`、`delete` は `id` 必須。

### bark-server の応答 (v2.3.9 で確認)

- 共通: `{code, message, timestamp, data?}`
- `/register` (GET は `devicetoken` / `key` の query、POST は body): `data = {key, device_key, device_token}`。`key` が空なら bark-server が新しい key を発行する。登録済み key は token を上書き
- `/push` に `device_keys` (配列 or カンマ区切り) を渡すと、HTTP 200 で `data = [{device_key, code, message?}]` (device ごとの結果、失敗時だけ message)。1 台でも配列で返る
- `/push` に `device_key` 1 台を渡すと `data` は無く、結果は `{code, message}` で HTTP status も `code` と同じ
- APNs が `BadDeviceToken` / 410 を返した device は bark-server 側で token が空にされる (登録簿は変わらない)

## 画面

見た目 (配色・字・部品の形) と判断は [design/ui.md](design/ui.md)。ここは各画面に何を置くか。

- `/bark-admin/` TOP: 宛先と端末の一覧だけを置き、操作はダイアログに出す
  - 並びはどの幅でも 1 列で、見出し (「端末」と今の公開名) → 宛先 → 操作 → 端末の一覧。操作は宛先のパネルの下端の 1 か所だけに置き、画面に固定しない
  - 宛先: `k=v` 改行区切りの AND (値は `device` と同じ解釈)、書き方の誤り、「退役済みも表示」
  - 操作: 一致した台数の行と、「n 台へ通知を送る」(主、0 台なら押せない)・「デバイスを追加」(副) の 2 つのボタンを横に並べる
  - 端末の一覧: 1 端末 1 行で、名前 (詳細へのリンクが行全体を覆う)、owner、残りのタグ (4 つまで、残りは +n。宛先のパターンに当たったタグを先に並べ、押すと宛先に足す / 外す)、device_id、registered_at、`info.os_version`、状態ラベル (受信未確認 / 暗号化 確認済み・未確認 / サーバー名が古い / 移行済み / 退役済み)。送信先に入る端末 (退役していない端末) の絵に黄色の印
  - 「通知を送る」ダイアログ: 宛先の写し (条件・台数・端末名)、ロック画面風の見本 (title / body を写す)、title / body / level / sound と、残り 17 項目を群 (本文・表示・鳴り方・タップしたとき・履歴) に分けて畳んだ「その他の項目」(入力数を出す)、「n 台へ送る」(シートの下端に付いて回る)、端末ごとの送信結果と生の応答
  - 「デバイスを追加」ダイアログ: 招待の作成 (タグ・「暗号化する」(既定 on)) → QR と URL、作成済みの招待の一覧 (QR の縮小・タグ・暗号化・登録数・作成日時、QR を大きく表示 / URL をコピー / 削除)
- `/bark-admin/devices/:id` 詳細: 基本情報の表示が主で、操作は状態の行やタグの横の小さなボタンが開くダイアログに分ける
  - 見出し: 端末の絵、name、owner、状態ラベル
  - 知らせ: サーバー名が古ければ「新しいサーバー名で登録し直す」、移行済みなら移行先へのリンク (この時は退役も復帰も出さない)、退役済みなら「復帰させる」
  - 状態: device_id / 登録日時 / 受信確認 (未確認 / 確認済み <日時>、「確認を送る」) / 暗号化 (無効 / 有効・未確認 / 有効・確認済み <日時>、「設定する」か「鍵と確認」) / サーバー名 (`info.server_host`。古ければ今の公開名を添えて「登録し直す」、無ければ「不明」、移行済みなら移行先) / 移行元 (移行トークンで登録した端末だけ)。退役済みの端末には操作のボタンを出さない
  - タグ: チップと「タグを編集」
  - 端末情報: `info` の定義リスト (server_host は状態に出すので除く、編集できない)
  - 退役: 「この端末を退役させる」(確認のダイアログ)
  - ダイアログ: 受信確認 (平文の確認通知を送る) / 暗号化 (3 段の状態、伏せた鍵と「表示」「コピー」、手順、「暗号化の確認を送る」、畳んだ「鍵を作り直す・無効にする」。無効なら「暗号化キーを設定」で鍵を作ってコピー) / 新しいサーバー名で登録し直す (移行の通知を送る) / タグを編集 / 退役・復帰。鍵は暗号化のダイアログで「表示」を押すまで画面に出さず、閉じると伏せ直す
- `/bark-admin/add/:invite`: 招待の案内ページ。開くたびにその 1 台用の登録トークンを発行する。段 (1. Bark にサーバーを追加 (登録を見つけるまで押せる、Bark が開かなかった時だけ App Store の案内) → 2. 受信確認の通知をタップ (確認通知を再送する) → 3. 暗号化キーを Bark に入れる (鍵付きの招待だけ、伏せ字の鍵をコピーして Bark を開く、暗号化の確認通知を送る))。各段は済み (✓ と 1 行) / 今 (中身を見せ、状態に合わせた案内) / 先 (見出しだけ薄く) (登録の流れ参照)
- `/bark-admin/add/m/:token`: 移行の案内ページ。招待の案内ページの 1 段目 (見出しとボタンが「新しいサーバー名で追加」、旧端末のタグ) と 2 段目だけ。冒頭に「済んだら Bark のサーバーリストから <旧端末の server_host> を削除してよい」(移行の節参照)
- 確認できたページ (確認通知の URL) と 404 のページも同じ部品で組む。確認できたページは「端末」(今回確認した行を強調) / 「タグ」/ 「端末情報」(種類・OS の版・Tailscale のマシン名) と詳細へのリンク、404 は TOP へのリンク
- 組み方: 部品 (`src/ui/components.ts`) と画面の塊 (`src/ui/views.ts`) は HTML 文字列を返す関数で、サーバ (`src/ui/pages.ts`) とブラウザ (`src/client/`) が同じものを使う。TOP と詳細の HTML は枠とダイアログだけで、中身は API の値でブラウザが描く。招待・移行・確認できた・404 はサーバが組み切る。ブラウザ側の TS は起動時に `Bun.build` でページごとに bundle してメモリに持つ (外部依存は増やさない)
- ブラウザ側の JS は要素が見つからない時 (HTML と JS の版ずれ) に黙って空欄にせず、`console.error` と画面の「古い版が表示されている。再読み込みする」(再読み込みボタン付き) を出して止まる

## 送信側の規約

正本は claude-rules-personal の reference `bark-push`。要点: タグ宛先の送信は常に `https://bark.<host>/bark-admin/push` (FQDN 経由。127.0.0.1 直結は on-demand 起動が効かない)、cold start では 302 が返るので `-L` か 1 回リトライ、宛先は `device` フィルタで指定。
