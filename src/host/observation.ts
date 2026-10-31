import { hash } from "../adapters/market.js";
import type { Account } from "../domain/contracts.js";
import type {
  ObservationRecord,
  ObservationEvent,
} from "../domain/simulation.js";
import type { Store } from "./store.js";

export function observationEvent(
  store: Store,
  account: Account,
  kind: ObservationEvent["kind"],
  reason: string,
  now = Date.now(),
) {
  const prior = store.maybe<ObservationRecord>("observation", account.id);
  const state: ObservationRecord = prior ?? {
    id: account.id,
    trackedFrom: now,
    historyComplete: kind === "start",
    firstMarketAt: 0,
    lastMarketAt: 0,
    lastTransportAt: 0,
    lastBarCloseAt: 0,
    transport: "unknown",
    gapCount: 0,
    gapOpenAt: null,
    gapMs: 0,
  };
  if (kind === "start" || kind === "resume") {
    state.sessionStartedAt = now;
    state.transport = "unknown";
  }
  if (
    [
      "disconnected",
      "pause",
      "stop",
      "fault",
      "restart",
      "closed",
      "replaced",
    ].includes(kind)
  ) {
    state.transport = "disconnected";
    if (state.gapOpenAt === null) {
      state.gapOpenAt =
        kind === "restart"
          ? Math.min(now, state.lastTransportAt || state.lastMarketAt || now)
          : now;
      state.gapCount++;
    }
  }
  if (kind === "connected") {
    state.transport = "connected";
    state.lastTransportAt = now;
    if (state.gapOpenAt !== null) {
      state.gapMs += Math.max(0, now - state.gapOpenAt);
      state.gapOpenAt = null;
    }
  }
  const body = {
    accountId: account.id,
    at: now,
    generation: account.generation,
    kind,
    reason,
  };
  const event: ObservationEvent = { id: hash(body), ...body };
  store.transaction(() => {
    store.put("observation", account.id, state);
    store.put("observationEvent", event.id, event);
  });
}
export function observationMarket(
  store: Store,
  accountId: string,
  source: "transport" | "bar" | "quote",
  at: number,
  barCloseAt = 0,
) {
  const state = store.maybe<ObservationRecord>("observation", accountId);
  if (!state) return;
  if (source === "transport") {
    if (at - state.lastTransportAt < 5000) return;
    state.lastTransportAt = Math.max(state.lastTransportAt, at);
  } else {
    state.firstMarketAt ||= at;
    state.lastMarketAt = Math.max(state.lastMarketAt, at);
    if (source === "bar")
      state.lastBarCloseAt = Math.max(state.lastBarCloseAt, barCloseAt);
  }
  store.put("observation", accountId, state);
}
export function accountObservationEvents(
  store: Store,
  accountId: string,
): ObservationEvent[] {
  return (
    store.db
      .prepare(
        "SELECT body FROM objects WHERE kind='observationEvent' AND json_extract(body,'$.accountId')=? ORDER BY json_extract(body,'$.at'),rowid",
      )
      .all(accountId) as { body: string }[]
  ).map((row) => JSON.parse(row.body));
}
