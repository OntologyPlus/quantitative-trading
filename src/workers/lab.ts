import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { labAction, type LabReader } from "../host/lab.js";
import { hash, validateBars } from "../adapters/market.js";
import { fail, parseError } from "../domain/schemas.js";
import type { Dataset } from "../domain/contracts.js";

let db: DatabaseSync | undefined;
try {
  db = new DatabaseSync(join(workerData.directory, "quant.sqlite"), {
    readOnly: true,
  });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
  // All records, including a running account, come from one coherent WAL snapshot.
  let bytes = 0;
  const maxBytes = 192 * 1024 * 1024;
  const read = (path: string) => {
    bytes += statSync(path).size;
    if (bytes > maxBytes)
      fail("LAB_DATA_BUDGET", "研究分析读取数据超过192 MiB上限，请缩小范围");
    return readFileSync(path, "utf8");
  };
  const metadata = <T>(kind: string, id: string): T => {
    const size = db!
      .prepare(
        "SELECT length(CAST(body AS BLOB)) AS n FROM objects WHERE kind=? AND id=?",
      )
      .get(kind, id) as { n: number } | undefined;
    if (!size) fail("NOT_FOUND", "找不到指定研究对象");
    bytes += size.n;
    if (bytes > maxBytes)
      fail("LAB_DATA_BUDGET", "研究分析读取数据超过192 MiB上限，请缩小范围");
    const row = db!
      .prepare("SELECT body FROM objects WHERE kind=? AND id=?")
      .get(kind, id) as { body: string };
    return JSON.parse(row.body) as T;
  };
  const reader: LabReader = {
    store: {
      assertLease() {},
      metadata,
      count(kind) {
        return (
          db!
            .prepare("SELECT count(*) AS n FROM objects WHERE kind=?")
            .get(kind) as { n: number }
        ).n;
      },
      get<T>(kind: string, id: string): T {
        const record = metadata<any>(kind, id);
        if (!record.resultArtifact) return record;
        if (!/^[a-f0-9]{64}$/.test(record.resultArtifact))
          fail("INVALID_ARTIFACT", "研究产物身份无效");
        const text = read(
          join(
            workerData.directory,
            "results",
            `${record.resultArtifact}.json`,
          ),
        );
        if (hash(text) !== record.resultArtifact)
          fail("ARTIFACT_HASH", "研究产物完整性校验失败");
        const { resultArtifact, ...body } = record;
        return { ...body, result: JSON.parse(text) } as T;
      },
    },
    bars(dataset: Dataset) {
      if (!/^[a-f0-9]{64}\.json$/.test(dataset.file))
        fail("INVALID_FILE", "数据文件身份无效");
      const text = read(join(workerData.directory, "datasets", dataset.file));
      if (hash(text) !== dataset.hash)
        fail("HASH_MISMATCH", "数据快照hash不匹配");
      return validateBars(JSON.parse(text), dataset.symbol, dataset.interval);
    },
  };
  const value = labAction(reader, workerData.action, workerData.input);
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024)
    fail("LAB_RESULT_BUDGET", "研究分析结果超过32 MiB上限，请缩小范围");
  parentPort!.postMessage({ type: "result", value });
} catch (error) {
  parentPort!.postMessage({ type: "error", ...parseError(error) });
} finally {
  db?.close();
}
