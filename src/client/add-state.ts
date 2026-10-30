import type { StepMode } from "../ui/components.ts";

// 招待ページの段の状態遷移 (純粋関数)。登録トークンの状態 (GET /bark-admin/api/registrations/:token) だけから、
// 各段の表示・1 段目のボタンの有無・今の段に出す案内を決める。DOM は add.ts が持つ

export const MESSAGES = {
  unusable: "この招待は使えない。QR を読み直す",
  registered: "サーバーの登録が完了した。確認の通知を送ったので、届いたらタップする",
  delivered: "受信確認が完了した。続いて暗号化を設定する。「暗号化キーをコピーして Bark を開く」を押し、Bark の暗号化設定に貼って保存したら「暗号化の確認通知を送る」を押す",
  allDone: "受信確認が完了した。すべて完了した",
  cryptoDone: "暗号化の確認が完了した。すべて済んだ",
};

// state: unused / used / expired / invite-deleted (API) と、トークンが見つからない (404) の gone
export type FlowStatus = {
  state: "unused" | "used" | "expired" | "invite-deleted" | "gone";
  device?: { delivery: { confirmed_at: string | null }; crypto: { confirmed_at: string | null } | null } | null;
};

export type FlowView = {
  add: StepMode;
  delivery: StepMode;
  crypto: StepMode;
  addButton: "enabled" | "removed";
  current: "add" | "delivery" | "crypto" | null;
  message: string;
  finished: boolean;
  deviceLink: boolean;
};

// 1 段目のボタンは登録 (used) を見つけるまで押せる (Bark の未導入・中断から戻ってもやり直せるように)。登録後は消す
export function flowView(r: FlowStatus, hasCrypto: boolean): FlowView {
  const base: FlowView = { add: "current", delivery: "later", crypto: "later", addButton: "enabled", current: "add", message: "", finished: false, deviceLink: false };
  if (r.state === "expired" || r.state === "invite-deleted" || r.state === "gone") {
    return { ...base, addButton: "removed", message: MESSAGES.unusable, finished: true };
  }
  if (r.state !== "used") return base;
  const registered: FlowView = { ...base, add: "done", addButton: "removed" };
  if ((r.device?.delivery.confirmed_at ?? null) === null) return { ...registered, delivery: "current", current: "delivery", message: MESSAGES.registered };
  const delivered: FlowView = { ...registered, delivery: "done" };
  if (!hasCrypto) return { ...delivered, current: null, message: MESSAGES.allDone, finished: true, deviceLink: true };
  if ((r.device?.crypto?.confirmed_at ?? null) === null) return { ...delivered, crypto: "current", current: "crypto", message: MESSAGES.delivered };
  return { ...delivered, crypto: "done", current: null, message: MESSAGES.cryptoDone, finished: true, deviceLink: true };
}
