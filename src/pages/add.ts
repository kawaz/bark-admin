// /bark-admin/add/:invite の案内ページと、暗号化の確認通知から開かれるページ。QR から iPhone の Safari で開かれ、Bark アプリにサーバ (登録トークン入り URL) を追加させる。
// 最初に目に入るのは「Bark で開く」、App Store はその下 (見た目の判断は docs/design/ui.md)。

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

// 鍵は Bark アプリの暗号化設定に手で貼る。ページを開くたびに端末ごとの新しい鍵になる (登録後は端末の詳細画面にある)
function cryptoSection(key: string): string {
  return `<section class="crypto stack" aria-labelledby="crypto-heading">
<h2 id="crypto-heading">暗号化キー</h2>
<p>この端末への通知は暗号化して送る。Bark に次の鍵を設定すると読める。</p>
<div class="key-row"><code id="crypto-key" class="key">${esc(key)}</code><button type="button" class="secondary" data-copy="crypto-key">コピー</button></div>
<ol class="steps">
<li>Bark のホームで「推送加密 / Push Encryption」を開く</li>
<li>Algorithm を AES256、Mode を GCM、Padding を noPadding にする</li>
<li>Key に上の鍵を貼って保存する</li>
</ol>
</section>`;
}

export function addPageHtml(p: { addserverUrl: string; tags: Record<string, string>; cryptoKey: string | null }): string {
  const tags = Object.entries(p.tags)
    .map(([k, val]) => `<li class="tag">${esc(k)}=${esc(val)}</li>`)
    .join("");
  return page(
    "bark-admin: Bark にサーバを追加",
    `<h1>Bark にこのサーバを追加</h1>
<a class="button open" href="${esc(p.addserverUrl)}">Bark で開く</a>
<div class="then">
<p>Bark に切り替わったら、サーバの追加を確定する。この端末が${tags === "" ? "タグなしで" : "次のタグで"}登録される。「Bark で開く」はこのページを開いた 1 台だけ、24 時間まで使える。</p>
${tags === "" ? "" : `<ul class="tags">${tags}</ul>`}
</div>
${p.cryptoKey === null ? "" : `${cryptoSection(p.cryptoKey)}\n`}<div class="install">
<p class="hint">Bark が入っていなければ、先に入れてから「Bark で開く」を押す。</p>
<a class="button secondary" href="${esc(APP_STORE_URL)}">App Store で Bark を入れる</a>
</div>`,
    p.cryptoKey === null ? "" : "add.js",
  );
}

export function notFoundPageHtml(message: string, heading = "招待が見つからない"): string {
  return page("bark-admin: 見つからない", `<h1>${esc(heading)}</h1>\n<p>${esc(message)}</p>`);
}

// 暗号化の確認通知をタップして開かれるページ (復号できた端末だけが URL を知る)
export function confirmedPageHtml(): string {
  return page("bark-admin: 暗号化を確認できた", `<h1>暗号化を確認できた</h1>\n<p>この端末は通知を復号できている。このページは閉じてよい。</p>`);
}
