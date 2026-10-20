// /bark-admin/add/:invite の案内ページと、確認通知から開かれるページ。QR から iPhone の Safari で開かれ、Bark アプリにサーバ (登録トークン入り URL) を追加させる。
// 案内ページは 3 段のステップ (1. サーバーを追加 → 2. 受信確認 → 3. 暗号化 (鍵付きの招待だけ)) を縦に並べる (見た目の判断は docs/design/ui.md)。
// 動きは public/assets/add.js: 段の進み具合は GET /bark-admin/api/registrations/:token で読む。

export const APP_STORE_URL = "https://apps.apple.com/app/bark-custom-notifications/id1403753865";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, main: string, script = ""): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/bark-admin/assets/style.css">
${script === "" ? "" : `<script type="module" src="/bark-admin/assets/${script}"></script>\n`}</head>
<body>
<main class="invite">
${main}
</main>
</body>
</html>
`;
}

// 段の見出しと、済んだ時に出す 1 行 (data-done に add.js が書く)。段の中身は今の段の時だけ見える
// 最初は 1 段目が今の段、残りは先の段
function step(id: string, n: number, title: string, body: string): string {
  return `<li id="step-${id}" class="step ${n === 1 ? "current" : "later"}">
<h2><span class="mark" aria-hidden="true">${n}</span>${esc(title)}</h2>
<p class="done-line" hidden></p>
<div class="body stack"${n === 1 ? "" : " hidden"}>
${body}
</div>
</li>`;
}

// 1. サーバーを追加。ボタンは 1 回だけ押せる。Bark が開かなかった時だけ App Store への案内を出す
function addStep(addserverUrl: string, tags: string): string {
  return step(
    "add",
    1,
    "Bark にサーバーを追加",
    `<button type="button" id="add-server" class="open" data-href="${esc(addserverUrl)}">Bark にサーバーを追加</button>
<p id="add-status" class="hint" role="status"></p>
<p id="no-bark" class="hint" hidden>Bark が開かなかった。入っていなければ <a href="${esc(APP_STORE_URL)}">App Store から入れて</a>からもう一度</p>
<p>Bark に切り替わったら、サーバーの追加を確定する。この端末が${tags === "" ? "タグなしで" : "次のタグで"}登録される。ボタンはこのページを開いた 1 台だけ、24 時間まで使える。</p>
${tags === "" ? "" : `<ul class="tags">${tags}</ul>`}`,
  );
}

// 2. 受信確認。登録できたら add.js が平文の確認通知を 1 回送る
function deliveryStep(): string {
  return step(
    "delivery",
    2,
    "受信確認",
    `<p>確認の通知が届いたらタップする。</p>
<div class="actions"><button type="button" id="delivery-again" class="secondary">もう一度送る</button><output id="delivery-status" class="hint"></output></div>`,
  );
}

// 3. 暗号化。鍵はページに埋めず、ボタンを押した時に取ってクリップボードへ写す (写せなかった時だけ見せる)
function cryptoStep(): string {
  return step(
    "crypto",
    3,
    "暗号化",
    `<p>この端末への通知は暗号化して送る。Bark に鍵を設定すると読める。</p>
<div class="key-row"><code id="crypto-key" class="key masked" aria-label="暗号化キー (隠している)">••••••••</code></div>
<button type="button" id="crypto-copy">暗号化キーをコピーして Bark を開く</button>
<p id="crypto-status" class="hint" role="status"></p>
<ol class="steps">
<li>Bark のホームで「推送加密 / Push Encryption」を開く</li>
<li>Algorithm を AES256、Mode を GCM、Padding を noPadding にする</li>
<li>Key に鍵を貼って保存する</li>
</ol>
<div class="actions"><button type="button" id="crypto-confirm" class="secondary">暗号化の確認を送る</button><output id="crypto-confirm-status" class="hint"></output></div>
<p class="hint">キーを設定してから送る。届いた通知をタップすると確認できる</p>`,
  );
}

export function addPageHtml(p: { addserverUrl: string; token: string; tags: Record<string, string>; encrypted: boolean }): string {
  const tags = Object.entries(p.tags)
    .map(([k, val]) => `<li class="tag">${esc(k)}=${esc(val)}</li>`)
    .join("");
  return page(
    "bark-admin: Bark にサーバーを追加",
    `<h1>Bark にこのサーバーを追加</h1>
<ol id="flow" class="flow" data-token="${esc(p.token)}">
${addStep(p.addserverUrl, tags)}
${deliveryStep()}
${p.encrypted ? `${cryptoStep()}\n` : ""}</ol>
<p id="flow-status" class="hint" role="status"></p>`,
    "add.js",
  );
}

export function notFoundPageHtml(message: string, heading = "招待が見つからない"): string {
  return page("bark-admin: 見つからない", `<h1>${esc(heading)}</h1>\n<p>${esc(message)}</p>`);
}

// 確認通知をタップして開かれるページ (crypto は復号できた端末だけが URL を知る)
export function confirmedPageHtml(kind: "delivery" | "crypto"): string {
  return kind === "delivery"
    ? page("bark-admin: 受信を確認できた", `<h1>受信を確認できた</h1>\n<p>この端末に通知が届いている。このページは閉じてよい。</p>`)
    : page("bark-admin: 暗号化を確認できた", `<h1>暗号化を確認できた</h1>\n<p>この端末は通知を復号できている。このページは閉じてよい。</p>`);
}
