import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { parseJsonWith } from "./parse.ts";
import { DevicesSchema, InvitesSchema } from "./schema/registry.ts";

// 1 ファイル = 1 つの JSON map。手で直されることがあるので毎回ファイルから読む (台数が 1 桁なので安い)。
// 書き込みは tmp → rename で途中状態を見せず、read-modify-write はプロセス内で直列化する。
export class JsonMapFile<S extends v.GenericSchema<Record<string, unknown>>> {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    readonly schema: S,
  ) {}

  async read(): Promise<v.InferOutput<S>> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) {
      const empty = v.safeParse(this.schema, {});
      if (!empty.success) throw new Error(`${this.path}: schema does not accept an empty map`);
      return empty.output;
    }
    const r = parseJsonWith(this.schema, await file.text());
    // 壊れたファイルを上書きして手修正を失わないよう、読めなければ止める
    if (!r.ok) throw new Error(`${this.path}: ${r.error.kind}: ${r.error.message}`);
    return r.value;
  }

  // fn が返した map を書き戻し、fn の結果 (result) を返す。next が undefined なら書かない。
  update<R>(fn: (cur: v.InferOutput<S>) => { next?: v.InferOutput<S>; result: R }): Promise<R> {
    const run = this.#queue.then(async () => {
      const { next, result } = fn(await this.read());
      if (next !== undefined) await this.#write(next);
      return result;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #write(value: v.InferOutput<S>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await Bun.write(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tmp, this.path);
  }
}

export type Store = {
  devices: JsonMapFile<typeof DevicesSchema>;
  invites: JsonMapFile<typeof InvitesSchema>;
};

// invites.json は devices.json と同じディレクトリに置く
export function openStore(dbPath: string): Store {
  return {
    devices: new JsonMapFile(dbPath, DevicesSchema),
    invites: new JsonMapFile(join(dirname(dbPath), "invites.json"), InvitesSchema),
  };
}
