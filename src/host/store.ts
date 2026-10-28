import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hash } from "../adapters/market.js";
import { fail } from "../domain/schemas.js";
import type { EngineState } from "../domain/contracts.js";
export class Store {
  readonly db: DatabaseSync;
  private readonly owner = randomUUID();
  private heartbeat: ReturnType<typeof setInterval>;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
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
    if (v && v.value !== "1")
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
      ? (JSON.parse(row.body) as T)
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
    ).map((x) => JSON.parse(x.body) as T);
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
  put(kind: string, id: string, value: unknown) {
    this.assertLease();
    this.db
      .prepare(
        "INSERT INTO objects VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, id, JSON.stringify(value));
    this.db
      .prepare("INSERT INTO outbox(kind,object_id,at) VALUES (?,?,?)")
      .run(kind, id, new Date().toISOString());
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertLease();
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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
    clearInterval(this.heartbeat);
    this.db.prepare("DELETE FROM lease WHERE owner=?").run(this.owner);
    this.db.close();
  }
}
