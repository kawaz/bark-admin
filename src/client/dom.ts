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

// ダイアログの開閉をこの 1 か所で受け持つ。
// - commandfor / command のボタンは JS で showModal() / close() する (Invoker Commands を持たないブラウザでも必ず modal で開き、裏の画面が inert になる)。ボタンの既定の動き (ブラウザの Invoker Commands) は止めて二重に開かない
// - 外側 (::backdrop) のクリックで閉じる (closedby="any" を持たないブラウザの分も)
// - 開いている間は裏の画面のスクロールを止める (html.scroll-locked)。
//   Design rationale: iOS 向けの定番の body を position: fixed にする止め方は、閉じた後に WebKit がスクロール位置を 0 へ戻してしまい (playwright の WebKit 26.6 で観測)、元の位置へ戻せないので使わない
export function setupDialogs(): void {
  const root = document.documentElement;
  const lock = () => root.classList.add("scroll-locked");
  const unlock = () => {
    if (document.querySelector("dialog[open]") === null) root.classList.remove("scroll-locked");
  };

  document.addEventListener("click", (ev) => {
    if (!(ev.target instanceof Element)) return;
    const button = ev.target.closest("button[commandfor]");
    if (!(button instanceof HTMLButtonElement)) return;
    const target = document.getElementById(button.getAttribute("commandfor") ?? "");
    if (!(target instanceof HTMLDialogElement)) return;
    const command = button.getAttribute("command");
    if (command !== "show-modal" && command !== "close") return;
    ev.preventDefault();
    if (command === "close") target.close();
    else if (!target.open) {
      lock();
      target.showModal();
    }
  });

  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("close", unlock);
    // 外側のクリックは dialog 自身に届く (中身は dialog の子)。中身の外の座標なら閉じる
    d.addEventListener("click", (ev) => {
      if (ev.target !== d) return;
      const r = d.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) d.close();
    });
  }
}
