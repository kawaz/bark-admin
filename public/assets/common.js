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

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
