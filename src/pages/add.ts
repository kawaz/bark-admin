// /bark-admin/add/:invite の案内ページと、暗号化の確認通知から開かれるページ。QR から iPhone の Safari で開かれ、Bark アプリにサーバ (登録トークン入り URL) を追加させる。
// 最初に目に入るのは「Bark にサーバーを追加」、App Store は末尾に小さく (見た目の判断は docs/design/ui.md)。
// 動きは public/assets/add.js: ボタンは 1 回だけ押せ、登録できたかを GET /bark-admin/api/registrations/:token で見て、できたら暗号化キーの節を出す。

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

// 登録できた後にだけ出す。鍵はページに埋めず、ボタンを押した時に取ってクリップボードへ写す (写せなかった時だけ見せる)
function cryptoSection(): string {
  return `<section id="crypto" class="crypto stack" aria-labelledby="crypto-heading" hidden>
<h2 id="crypto-heading">暗号化キー</h2>
<p>この端末への通知は暗号化して送る。Bark に鍵を設定すると読める。</p>
<div class="key-row"><code id="crypto-key" class="key masked" aria-label="暗号化キー (隠している)">••••••••</code></div>
<button type="button" id="crypto-copy">暗号化キーをコピーして Bark を開く</button>
<p id="crypto-status" class="hint" role="status"></p>
<ol class="steps">
<li>Bark のホームで「推送加密 / Push Encryption」を開く</li>
<li>Algorithm を AES256、Mode を GCM、Padding を noPadding にする</li>
<li>Key に鍵を貼って保存する</li>
</ol>
</section>`;
}

export function addPageHtml(p: { addserverUrl: string; token: string; tags: Record<string, string>; encrypted: boolean }): string {
  const tags = Object.entries(p.tags)
    .map(([k, val]) => `<li class="tag">${esc(k)}=${esc(val)}</li>`)
    .join("");
  return page(
    "bark-admin: Bark にサーバーを追加",
    `<h1>Bark にこのサーバーを追加</h1>
<div id="add" class="add stack" data-token="${esc(p.token)}" data-href="${esc(p.addserverUrl)}">
<button type="button" id="add-server" class="open">Bark にサーバーを追加</button>
<p id="add-status" class="status" role="status"></p>
</div>
<div class="then">
<p id="add-guide">Bark に切り替わったら、サーバーの追加を確定する。この端末が${tags === "" ? "タグなしで" : "次のタグで"}登録される。ボタンはこのページを開いた 1 台だけ、24 時間まで使える。</p>
${tags === "" ? "" : `<ul class="tags">${tags}</ul>`}
</div>
${p.encrypted ? `${cryptoSection()}\n` : ""}<p class="install hint">Bark が入っていなければ <a href="${esc(APP_STORE_URL)}">App Store で入れる</a></p>`,
    "add.js",
  );
}

export function notFoundPageHtml(message: string, heading = "招待が見つからない"): string {
  return page("bark-admin: 見つからない", `<h1>${esc(heading)}</h1>\n<p>${esc(message)}</p>`);
}

// 暗号化の確認通知をタップして開かれるページ (復号できた端末だけが URL を知る)
export function confirmedPageHtml(): string {
  return page("bark-admin: 暗号化を確認できた", `<h1>暗号化を確認できた</h1>\n<p>この端末は通知を復号できている。このページは閉じてよい。</p>`);
}
