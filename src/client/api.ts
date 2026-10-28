export interface Caller {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<
    | {
        ok: true;
        value: unknown;
      }
    | {
        ok: false;
        error: {
          message: string;
          code: string;
        };
      }
  >;
}
export async function call<T>(
  rpc: Caller,
  sessionId: string,
  action: string,
  input: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  const result = await rpc.call(
    "/api",
    `quant/${action}`,
    { sessionId, input },
    signal,
  );
  if (!result.ok) throw Error(`${result.error.code} · ${result.error.message}`);
  return result.value as T;
}
export function download(
  name: string,
  text: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(
      new Blob([text], { type: `${type};charset=utf-8` }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
