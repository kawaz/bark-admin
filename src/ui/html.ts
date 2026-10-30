// HTML を文字列で組む小さな道具。サーバ (ページの HTML) とブラウザ (一覧・詳細の描き直し) の両方の部品がこれで書かれる。
// 差し込んだ値は既定でエスケープし、部品が返した Html だけをそのまま埋める (二重エスケープも漏れも起きない)

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Part = Html | string | number | null | undefined | false | readonly Part[];

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function render(p: Part): string {
  if (p === null || p === undefined || p === false) return "";
  if (p instanceof Html) return p.value;
  if (typeof p === "string") return esc(p);
  if (typeof p === "number") return String(p);
  return p.map(render).join("");
}

export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  let out = strings[0] ?? "";
  parts.forEach((p, i) => {
    out += render(p) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

// 属性の並び。true は値なしの属性、false / undefined は出さない
export type Attrs = Record<string, string | number | boolean | undefined>;

export function attrs(a: Attrs): Html {
  return new Html(
    Object.entries(a)
      .flatMap(([k, val]) => (val === undefined || val === false ? [] : [val === true ? ` ${k}` : ` ${k}="${esc(String(val))}"`]))
      .join(""),
  );
}
