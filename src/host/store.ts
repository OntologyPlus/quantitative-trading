import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { hash } from "../adapters/market.js";
import { fail } from "../domain/schemas.js";
import type { EngineState } from "../domain/contracts.js";
export class Store {
  readonly db: DatabaseSync;
  private readonly owner = randomUUID();
  private heartbeat: ReturnType<typeof setInterval>;
  private depth = 0;
  private listeners = new Set<() => void>();
  private resultDirectory: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.resultDirectory = join(dirname(path), "results");
    mkdirSync(this.resultDirectory, { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS fills(account_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account_id,id));
 CREATE TABLE IF NOT EXISTS ledger(account_id TEXT NOT NULL,id TEXT NOT NULL,fill_id TEXT NOT NULL,asset TEXT NOT NULL,delta TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account_id,id),FOREIGN KEY(account_id,fill_id) REFERENCES fills(account_id,id));
 CREATE TABLE IF NOT EXISTS decisions(account_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account_id,id));
 CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,object_id TEXT NOT NULL,at TEXT NOT NULL);
 `);
    const v = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get("schema") as
      | {
          value: string;
        }
      | undefined;
    if (v && !["1", "2"].includes(v.value))
      fail("SCHEMA_VERSION", "数据库版本不支持，请保留原目录");
    this.db
      .prepare("INSERT OR IGNORE INTO metadata VALUES (?,?)")
      .run("schema", "1");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.db
        .prepare("SELECT expires FROM lease WHERE id=1")
        .get() as
        | {
            expires: number;
          }
        | undefined;
      if (lease && lease.expires > Date.now())
        fail(
          "DATA_IN_USE",
          "此数据目录已有运行实例，请关闭旧实例或使用不同目录",
        );
      this.db
        .prepare("INSERT OR REPLACE INTO lease VALUES (1,?,?)")
        .run(this.owner, Date.now() + 120000);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw e;
    }
    // Acquire the writer lease before migrating. Keep a coherent SQLite backup,
    // including WAL contents, rather than copying the main database file.
    if (v?.value === "1" && !existsSync(`${path}.schema1.bak`))
      this.db.prepare("VACUUM INTO ?").run(`${path}.schema1.bak`);
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_events(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
          revision INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS project_events_project ON project_events(project_id,sequence);
        CREATE TABLE IF NOT EXISTS consumers(name TEXT PRIMARY KEY,cursor INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS objects_kind ON objects(kind);
        CREATE INDEX IF NOT EXISTS objects_status ON objects(kind,json_extract(body,'$.status'));
      `);
      this.db.prepare("UPDATE metadata SET value='2' WHERE key='schema'").run();
    });
    this.heartbeat = setInterval(() => {
      try {
        this.db
          .prepare(
            "UPDATE lease SET expires=? WHERE id=1 AND owner=? AND expires>?",
          )
          .run(Date.now() + 120000, this.owner, Date.now());
      } catch {}
    }, 10000);
    this.heartbeat.unref();
  }
  get<T>(kind: string, id: string): T {
    const row = this.db
      .prepare("SELECT body FROM objects WHERE kind=? AND id=?")
      .get(kind, id) as
      | {
          body: string;
        }
      | undefined;
    return row
      ? (this.hydrate(kind, JSON.parse(row.body)) as T)
      : fail("NOT_FOUND", "找不到指定对象");
  }
  maybe<T>(kind: string, id: string): T | null {
    try {
      return this.get<T>(kind, id);
    } catch {
      return null;
    }
  }
  list<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT body FROM objects WHERE kind=? ORDER BY rowid DESC")
        .all(kind) as {
        body: string;
      }[]
    ).map((x) => this.hydrate(kind, JSON.parse(x.body)) as T);
  }
  private hydrate(kind: string, value: any) {
    if (kind !== "run" || !value.resultArtifact) return value;
    if (!/^[a-f0-9]{64}$/.test(value.resultArtifact))
      fail("INVALID_ARTIFACT", "回测产物身份无效");
    const text = readFileSync(
      join(this.resultDirectory, `${value.resultArtifact}.json`),
      "utf8",
    );
    if (hash(text) !== value.resultArtifact)
      fail("ARTIFACT_HASH", "回测产物完整性校验失败");
    const { resultArtifact, ...record } = value;
    return { ...record, result: JSON.parse(text) };
  }
  private serialize(kind: string, value: unknown) {
    const record = value as any;
    if (kind !== "run" || !record.result?.state) return JSON.stringify(value);
    const text = JSON.stringify(record.result),
      digest = hash(text),
      path = join(this.resultDirectory, `${digest}.json`);
    if (!existsSync(path)) {
      const temp = join(this.resultDirectory, `${randomUUID()}.tmp`);
      writeFileSync(temp, text, { flag: "wx" });
      renameSync(temp, path);
    }
    const { state, ...summary } = record.result;
    return JSON.stringify({
      ...record,
      result: summary,
      resultArtifact: digest,
    });
  }
  withStatus<T>(kind: string, statuses: string[], limit = 1000): T[] {
    return (
      this.db
        .prepare(
          `SELECT body FROM objects WHERE kind=? AND json_extract(body,'$.status') IN (${statuses.map(() => "?").join(",")}) ORDER BY rowid LIMIT ?`,
        )
        .all(kind, ...statuses, limit) as { body: string }[]
    ).map((r) => this.hydrate(kind, JSON.parse(r.body)) as T);
  }
  pendingCount(kind: string) {
    return Number(
      (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM objects WHERE kind=? AND json_extract(body,'$.status') IN ('queued','running')",
          )
          .get(kind) as { n: number }
      ).n,
    );
  }
  assertLease() {
    const row = this.db
      .prepare("SELECT owner,expires FROM lease WHERE id=1")
      .get() as
      | {
          owner: string;
          expires: number;
        }
      | undefined;
    if (!row || row.owner !== this.owner || row.expires <= Date.now())
      fail("LEASE_LOST", "数据目录执行租约已失效，请重启应用");
  }
  put(kind: string, id: string, value: unknown): void {
    if (!this.depth) return this.transaction(() => this.put(kind, id, value));
    this.assertLease();
    this.db
      .prepare(
        "INSERT INTO objects VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, id, this.serialize(kind, value));
    this.db
      .prepare("INSERT INTO outbox(kind,object_id,at) VALUES (?,?,?)")
      .run(kind, id, new Date().toISOString());
  }
  transaction<T>(fn: () => T): T {
    const outer = this.depth === 0,
      name = `quant_tx_${this.depth}`;
    this.db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      this.assertLease();
      const value = fn();
      this.db.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
      if (outer) queueMicrotask(() => this.listeners.forEach((fn) => fn()));
      return value;
    } catch (e) {
      this.db.exec(outer ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${name}`);
      if (!outer) this.db.exec(`RELEASE SAVEPOINT ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  page<T>(kind: string, offset = 0, limit = 50, strip: string[] = []): T[] {
    // Paths are fixed by callers; user-supplied values never become SQL.
    const body = strip.length
      ? `json_remove(body,${strip.map(() => "?").join(",")})`
      : "body";
    return (
      this.db
        .prepare(
          `SELECT ${body} AS body FROM objects WHERE kind=? ORDER BY rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(...strip.map((p) => `$.${p}`), kind, limit, offset) as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body) as T);
  }
  count(kind: string) {
    return Number(
      (
        this.db
          .prepare("SELECT count(*) AS n FROM objects WHERE kind=?")
          .get(kind) as { n: number }
      ).n,
    );
  }
  event(projectId: string, revision: number, type: string, facts: unknown) {
    this.assertLease();
    this.db
      .prepare(
        "INSERT INTO project_events(project_id,revision,type,body,at) VALUES (?,?,?,?,?)",
      )
      .run(
        projectId,
        revision,
        type,
        JSON.stringify(facts),
        new Date().toISOString(),
      );
  }
  events(projectId: string, after = 0, limit = 100) {
    return (
      this.db
        .prepare(
          "SELECT * FROM project_events WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(projectId, after, limit) as {
        sequence: number;
        project_id: string;
        revision: number;
        type: string;
        body: string;
        at: string;
      }[]
    ).map(({ body, ...e }) => ({ ...e, facts: JSON.parse(body) as unknown }));
  }
  changes(after: number, limit = 200) {
    return this.db
      .prepare(
        "SELECT sequence,kind,object_id FROM outbox WHERE sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(after, limit) as {
      sequence: number;
      kind: string;
      object_id: string;
    }[];
  }
  cursor(name: string) {
    return Number(
      (
        this.db
          .prepare("SELECT cursor FROM consumers WHERE name=?")
          .get(name) as { cursor: number } | undefined
      )?.cursor ?? 0,
    );
  }
  consume(name: string, cursor: number) {
    this.assertLease();
    this.db
      .prepare(
        "INSERT INTO consumers VALUES (?,?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor",
      )
      .run(name, cursor);
    const low = (
      this.db.prepare("SELECT min(cursor) AS n FROM consumers").get() as {
        n: number;
      }
    ).n;
    if (low > 1000)
      this.db.prepare("DELETE FROM outbox WHERE sequence<?").run(low - 1000);
  }
  submit<T>(
    submissionId: string,
    operation: string,
    payload: unknown,
    fn: () => T,
  ): T {
    return this.transaction(() => {
      const digest = hash({ operation, payload }),
        existing = this.db
          .prepare("SELECT hash,result FROM submissions WHERE id=?")
          .get(submissionId) as
          | {
              hash: string;
              result: string;
            }
          | undefined;
      if (existing) {
        if (existing.hash !== digest)
          fail("IDEMPOTENCY_CONFLICT", "提交身份已用于其他内容，请创建新提交");
        return JSON.parse(existing.result) as T;
      }
      const value = fn();
      this.db
        .prepare("INSERT INTO submissions VALUES (?,?,?)")
        .run(submissionId, digest, JSON.stringify(value));
      return value;
    });
  }
  saveState(accountId: string, state: EngineState) {
    const f = this.db.prepare("INSERT OR IGNORE INTO fills VALUES (?,?,?,?)"),
      l = this.db.prepare("INSERT OR IGNORE INTO ledger VALUES (?,?,?,?,?,?)"),
      d = this.db.prepare("INSERT OR IGNORE INTO decisions VALUES (?,?,?,?)");
    for (const fill of state.fills)
      f.run(accountId, fill.id, fill.at, JSON.stringify(fill));
    for (const entry of state.ledger)
      l.run(
        accountId,
        entry.id,
        entry.fillId,
        entry.asset,
        entry.delta,
        JSON.stringify(entry),
      );
    for (const decision of state.decisions)
      d.run(accountId, decision.id, decision.at, JSON.stringify(decision));
    this.stateMatches(accountId, state);
  }
  stateMatches(accountId: string, state: EngineState) {
    const read = (table: string) =>
      new Map(
        (
          this.db
            .prepare(`SELECT id,body FROM ${table} WHERE account_id=?`)
            .all(accountId) as {
            id: string;
            body: string;
          }[]
        ).map((r) => [r.id, r.body]),
      );
    for (const [table, values] of [
      ["fills", state.fills],
      ["ledger", state.ledger],
      ["decisions", state.decisions],
    ] as const) {
      const rows = read(table);
      if (
        rows.size !== values.length ||
        values.some((v) => rows.get(v.id) !== JSON.stringify(v))
      )
        fail("LEDGER_MISMATCH", "持久化事件与账户投影不一致");
    }
  }
  close() {
    this.listeners.clear();
    clearInterval(this.heartbeat);
    this.db.prepare("DELETE FROM lease WHERE owner=?").run(this.owner);
    this.db.close();
  }
}
