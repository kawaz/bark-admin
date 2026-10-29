// index.js / device.js 共通の小物。

// "k=v" の行を tag map にする。空行は無視、= が無い行はエラー。
export function parseTagLines(text) {
  const tags = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`${i + 1} 行目: key=value の形ではありません: ${line}`);
    tags[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return tags;
}

// device フィルタの値 1 つの解釈 (src/registry.ts の matchTag の写し)。`*v*` は v を含む、`*` はキーがある、それ以外は完全一致
export function matchTag(value, pattern) {
  if (value === undefined) return false;
  if (pattern === "*") return true;
  if (pattern.length >= 2 && pattern.startsWith("*") && pattern.endsWith("*")) return value.includes(pattern.slice(1, -1));
  return value === pattern;
}

export function formatTagLines(tags) {
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

// "2026-10-20T10:02:28+09:00" → "2026-10-20 10:02"。登録簿はローカル時刻で持つので、そのまま切り詰める
export function formatAt(iso) {
  return iso.slice(0, 16).replace("T", " ");
}

export function parseJsonl(text) {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

// 失敗応答は {error} か bark 形式の {message} を持つ
export async function errorMessage(res) {
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    return body.error ?? body.message ?? text;
  } catch {
    return text || `${res.status} ${res.statusText}`;
  }
}

// 公開名が古い端末に、新しい公開名で登録し直す案内の通知を送る (POST /api/devices/:id/migrate)。端末で通知をタップすると移行の案内ページが開く
export async function sendMigration(id, button, status) {
  button.disabled = true;
  status.textContent = "送っている";
  const res = await fetch(`/bark-admin/api/devices/${encodeURIComponent(id)}/migrate`, { method: "POST" });
  status.textContent = res.ok ? "通知を送った。端末で開いて案内に従う" : `送れなかった: ${await errorMessage(res)}`;
  button.disabled = false;
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// text (文字列か、文字列になる Promise) をクリップボードへ写す。
// Safari はクリック直後の同期区間でしか書かせないので、値を待たずに ClipboardItem へ Promise のまま渡す
export async function writeClipboard(text) {
  if (typeof ClipboardItem === "function") {
    const blob = Promise.resolve(text).then((t) => new Blob([t], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  } else {
    await navigator.clipboard.writeText(await text);
  }
}

// text をクリップボードへ写し、押したボタンの文言で結果を返す (少し経つと元の文言に戻す)
export async function copyText(button, text) {
  const label = button.dataset.label ?? button.textContent;
  button.dataset.label = label;
  try {
    await writeClipboard(text);
    button.textContent = "コピーした";
  } catch {
    button.textContent = "コピーできなかった。長押しで選ぶ";
  }
  setTimeout(() => {
    button.textContent = label;
  }, 2000);
}
