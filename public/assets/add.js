import { copyText } from "./common.js";

// 招待ページ: data-copy="<id>" のボタンでその要素の文字をコピーする
for (const button of document.querySelectorAll("button[data-copy]")) {
  button.addEventListener("click", () => copyText(button, document.getElementById(button.dataset.copy).textContent));
}
