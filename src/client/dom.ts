import type { Html } from "../ui/html.ts";

// ブラウザ側の小物 (要素の取得・クリップボード・タグの行)。

// HTML と JS の版がずれると (古い版がキャッシュに残る等) 要素が見つからない。黙って空欄にせず、知らせて止める
function stale(sel: string): never {
  console.error(`bark-admin: ${sel} is not in the page. The HTML and the script are from different versions`);
  if (document.querySelector("#stale") === null) {
    const note = document.createElement("p");
    note.id = "stale";
    note.className = "error";
    note.role = "alert";
    note.textContent = "古い版が表示されている。再読み込みする ";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "btn btn-small";
    reload.textContent = "再読み込み";
    reload.onclick = () => location.reload();
    note.append(reload);
    document.querySelector("main")?.prepend(note);
  }
  throw new Error(`missing element ${sel}`);
}

// id の要素を型を確かめて取る (無い・型が違うのは版ずれ)
export function byId<T extends Element>(id: string, ctor: abstract new (...args: never[]) => T): T {
  const node = document.getElementById(id);
  if (node instanceof ctor) return node;
  return stale(`#${id}`);
}

export function setHtml(node: Element, h: Html): void {
  node.innerHTML = h.value;
}

// "k=v" の行を tag map にする。空行は無視、= が無い行はエラー
export type TagLines = { ok: true; tags: Record<string, string> } | { ok: false; error: string };

export function parseTagLines(text: string): TagLines {
  const tags: Record<string, string> = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { ok: false, error: `${i + 1} 行目が key=value の形ではない: ${line}` };
    tags[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { ok: true, tags };
}

export function formatTagLines(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

// text (文字列か、文字列になる Promise) をクリップボードへ写す。
// Safari はクリック直後の同期区間でしか書かせないので、値を待たずに ClipboardItem へ Promise のまま渡す
export async function writeClipboard(text: string | Promise<string>): Promise<void> {
  if (typeof ClipboardItem === "function") {
    const blob = Promise.resolve(text).then((t) => new Blob([t], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  } else {
    await navigator.clipboard.writeText(await text);
  }
}

// text をクリップボードへ写し、押したボタンの文言で結果を返す (少し経つと元の文言に戻す)
export async function copyText(button: HTMLButtonElement, text: string | Promise<string>): Promise<boolean> {
  const label = button.dataset["label"] ?? button.textContent;
  button.dataset["label"] = label;
  let copied = true;
  try {
    await writeClipboard(text);
    button.textContent = "コピーした";
  } catch {
    copied = false;
    button.textContent = "コピーできなかった";
  }
  setTimeout(() => {
    button.textContent = label;
  }, 2000);
  return copied;
}

// <dialog> を閉じる (開いていなければ何もしない)
export function closeDialog(id: string): void {
  byId(id, HTMLDialogElement).close();
}
