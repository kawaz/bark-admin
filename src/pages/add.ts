// /bark-admin/add/:invite の案内ページ。QR から Safari で開かれ、Bark アプリにサーバ (招待入り URL) を追加させる。

export const APP_STORE_URL = "https://apps.apple.com/app/bark-custom-notifications/id1403753865";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function addPageHtml(p: { addserverUrl: string; tags: Record<string, string>; used: boolean }): string {
  const tags = Object.entries(p.tags)
    .map(([k, val]) => `<li><code>${esc(k)}</code> = <code>${esc(val)}</code></li>`)
    .join("");
  const body = p.used
    ? `<p class="notice">この招待は使用済みです。新しい端末を追加するには管理画面で招待を作り直してください。</p>`
    : `<ol>
  <li>Bark アプリが入っていなければ <a href="${esc(APP_STORE_URL)}">App Store から入れる</a></li>
  <li><a class="button" href="${esc(p.addserverUrl)}">Bark で開く</a> を押し、サーバの追加を確定する</li>
</ol>`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bark-admin: デバイス追加</title>
<link rel="stylesheet" href="/bark-admin/assets/style.css">
</head>
<body>
<main class="narrow">
<h1>Bark にこのサーバを追加</h1>
${body}
${tags === "" ? "" : `<h2>付くタグ</h2><ul class="tags">${tags}</ul>`}
</main>
</body>
</html>
`;
}

export function notFoundPageHtml(message: string): string {
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>bark-admin</title>
<link rel="stylesheet" href="/bark-admin/assets/style.css"></head>
<body><main class="narrow"><h1>見つかりません</h1><p>${esc(message)}</p></main></body>
</html>
`;
}
