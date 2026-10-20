import { describe, expect, test } from "bun:test";
import { MESSAGES, flowView, type RegistrationStatus } from "../public/assets/add-state.js";

const used = (delivery: string | null, crypto: string | null | "none"): RegistrationStatus => ({
  state: "used",
  device: { delivery: { confirmed_at: delivery }, crypto: crypto === "none" ? null : { confirmed_at: crypto } },
});

describe("flowView (招待ページの段)", () => {
  test("unused: the add button stays enabled (also after coming back from the App Store), no message", () => {
    expect(flowView({ state: "unused" }, true)).toEqual({ add: "current", delivery: "later", crypto: "later", addButton: "enabled", current: "add", message: "", finished: false, deviceLink: false });
  });

  test.each([["expired"], ["invite-deleted"], ["gone"]] as const)("%s: the button is removed and the invite is unusable", (state) => {
    expect(flowView({ state }, true)).toMatchObject({ addButton: "removed", current: "add", message: MESSAGES.unusable, finished: true, deviceLink: false });
  });

  // 状態 → 今の段・案内の対応表
  test.each([
    ["registered, delivery pending", used(null, null), true, { add: "done", delivery: "current", crypto: "later", current: "delivery", message: MESSAGES.registered, finished: false, deviceLink: false }],
    ["delivered, crypto pending", used("t1", null), true, { add: "done", delivery: "done", crypto: "current", current: "crypto", message: MESSAGES.delivered, finished: false, deviceLink: false }],
    ["delivered, no key invite", used("t1", "none"), false, { add: "done", delivery: "done", current: null, message: MESSAGES.allDone, finished: true, deviceLink: true }],
    ["crypto confirmed", used("t1", "t2"), true, { add: "done", delivery: "done", crypto: "done", current: null, message: MESSAGES.cryptoDone, finished: true, deviceLink: true }],
  ] as const)("%s", (_, r, hasCrypto, expected) => {
    expect(flowView(r, hasCrypto)).toMatchObject({ ...expected, addButton: "removed" });
  });

  test("messages are the plain-form guidance for each step", () => {
    expect(MESSAGES.registered).toBe("サーバーの登録が完了した。確認の通知を送ったので、届いたらタップする");
    expect(MESSAGES.delivered).toContain("「暗号化キーをコピーして Bark を開く」");
    expect(MESSAGES.delivered).toContain("「暗号化の確認通知を送る」");
    expect(MESSAGES.cryptoDone).toBe("暗号化の確認が完了した。すべて済んだ");
  });
});
