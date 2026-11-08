import { Service, type Context } from "@deepseek-ai/cordis";
import { clientRequestSchema } from "@deepseek-ai/dsh-client-connection";
import { z } from "zod";
import { id, parseError } from "../domain/schemas.js";
import type {} from "./index.js";
export const ACTIONS = [
  "universe-asof",
  "portfolio-backtest",
  "research-quality",
  "portfolio-research",
  "data-audit",
  "simulation-replay",
  "parameter-sweep",
  "walk-forward",
  "performance-report",
  "snapshot",
  "demo",
  "import",
  "prepare",
  "draft",
  "publish",
  "backtest",
  "run",
  "decisions",
  "cancel",
  "account",
  "control",
  "review",
  "backup",
  "restore",
  "export-run",
  "project-create",
  "project-list",
  "project-read",
  "project-control",
  "project-approve",
  "project-promotion-preview",
  "project-answer",
  "project-export",
  "project-evidence",
  "health",
  "monitor-list",
  "monitor-config",
  "monitor-review",
  "monitor-read",
  "monitor-followup",
  "notice-ack",
] as const;
export default class QuantRPC extends Service {
  static inject = ["connection", "quant"];
  constructor(ctx: Context) {
    super(ctx, "quantRPC");
    for (const action of ACTIONS)
      ctx.effect(() =>
        ctx.connection.fetch.register({
          path: `/api/quant/${action}`,
          methods: ["POST"],
          requestBody: "buffered",
          // Connection exact routes enforce authenticated owner admission before this handler.
          fetch: async (request) => {
            if (
              request.headers.get("content-type")?.split(";")[0] !==
              "application/json"
            )
              return new Response("expected application/json", { status: 415 });
            let body: unknown;
            try {
              const text = await request.text();
              if (Buffer.byteLength(text, "utf8") > 64 * 1024 * 1024)
                return new Response("request too large", { status: 413 });
              body = JSON.parse(text);
            } catch {
              return new Response("invalid JSON", { status: 400 });
            }
            const parsed = clientRequestSchema.safeParse(body);
            if (!parsed.success || parsed.data.method !== `quant/${action}`)
              return new Response("invalid RPC envelope", { status: 400 });
            const { rpcId, payload } = parsed.data;
            try {
              request.signal.throwIfAborted();
              const envelope = z
                .object({ sessionId: id, input: z.unknown().optional() })
                .strict()
                .parse(payload);
              return Response.json({
                type: "server-response",
                rpcId,
                result: {
                  ok: true,
                  value: await ctx.quant.user(
                    action,
                    envelope.input ?? {},
                    envelope.sessionId,
                    request.signal,
                  ),
                },
              });
            } catch (e) {
              return Response.json({
                type: "server-response",
                rpcId,
                result: { ok: false, error: { ...parseError(e), details: {} } },
              });
            }
          },
        }),
      );
  }
}
