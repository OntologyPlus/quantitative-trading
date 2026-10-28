const root = "https://data-api.binance.vision";
for (const path of [
  "/api/v3/time",
  "/api/v3/exchangeInfo?symbol=BTCUSDT",
  "/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=3",
]) {
  const response = await fetch(root + path, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(`Public market endpoint returned ${response.status}`);
  const data = await response.json();
  console.log(
    path.split("?")[0],
    Array.isArray(data)
      ? `${data.length} bars`
      : data.symbols
        ? `${data.symbols.length} symbol; ${data.symbols[0].status}`
        : "clock available",
  );
}
