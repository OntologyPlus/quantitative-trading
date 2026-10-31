import { withHarness } from "./harness-fixture.mjs";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const browser =
  process.env.QUANT_CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
assert.ok(
  existsSync(browser),
  "Set QUANT_CHROME_PATH to an installed Chrome/Chromium executable",
);
await withHarness(async ({ base, cookie, rpc, temp, root }) => {
  await rpc("demo", { submissionId: "browser-demo" });
  const compiled = await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{Studio}from'./src/client/studio.tsx';let n=0;const rpc={async call(_c,endpoint,payload,signal){const response=await fetch('/api/'+endpoint,{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'browser-'+(++n),method:endpoint,payload})});if(!response.ok)throw Error('HTTP '+response.status);return(await response.json()).result;}};const info=()=>({tab:{visible:true}});createRoot(document.getElementById('app')).render(<Studio rpc={rpc} sessionId="browser-session" useTabInfo={info} bring={()=>'ok'}/>);`,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
  });
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/fixture.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(compiled.outputFiles[0].text);
        return;
      }
      if (req.url?.startsWith("/api/quant/")) {
        let body = "";
        for await (const b of req) body += b;
        const response = await fetch(base + req.url, {
          method: "POST",
          headers: { cookie, origin: base, "content-type": "application/json" },
          body,
        });
        res.statusCode = response.status;
        res.setHeader("content-type", "application/json");
        res.end(await response.text());
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quant Lab browser check</title><body style="margin:0;background:#101419"><div id="app"></div><script src="/fixture.js"></script></body></html>',
      );
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port,
    userDir = join(temp, "chrome"),
    child = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDir}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
  let socket;
  try {
    const deadline = Date.now() + 20000,
      active = join(userDir, "DevToolsActivePort");
    while (!existsSync(active) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(active), "Chrome failed to start");
    const debugPort = Number(readFileSync(active, "utf8").split("\n")[0]);
    const pages = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json();
    const page = pages.find((p) => p.type === "page");
    assert.ok(page);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    const pending = new Map(),
      exceptions = [];
    socket.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          m.error
            ? p.reject(Error(JSON.stringify(m.error)))
            : p.resolve(m.result);
        }
      } else if (m.method === "Runtime.exceptionThrown")
        exceptions.push(m.params.exceptionDetails.text);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const current = ++id;
        pending.set(current, { resolve, reject });
        socket.send(JSON.stringify({ id: current, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const wait = async (expression, timeout = 20000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        if (await evaluate(expression)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error(
        `Browser wait failed: ${expression}\n${await evaluate("document.body.innerText.slice(-3000)")}`,
      );
    };
    const click = async (text) => {
      const result = await evaluate(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true;})()`,
      );
      assert.equal(result, true, `Button missing: ${text}`);
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await wait("document.body.innerText.includes('把研究交给 Agent')");
    await click("检验成本影响");
    assert.ok(
      await evaluate(
        "document.querySelector('textarea').value.includes('手续费和滑点增加')",
      ),
      "Research starter should populate an editable objective",
    );
    await evaluate(
      "(()=>{const select=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='protocol'));select.value='protocol';select.dispatchEvent(new Event('change',{bubbles:true}));const checkbox=[...document.querySelectorAll('label.choice')].find(l=>l.textContent.includes('合成演示')).querySelector('input');checkbox.click();})()",
    );
    await click("生成研究委托");
    await wait("document.body.innerText.includes('确认协议并启动研究')");
    await wait("document.body.innerText.includes('本次研究条件')");
    assert.ok(
      await evaluate(
        "document.body.innerText.includes('0.1%') && document.body.innerText.includes('买入、卖出分别收取')",
      ),
      "Draft should show actual per-side fees in bps and percent",
    );
    await click("确认协议并启动研究");
    await wait("document.body.innerText.includes('已交付')", 30000);
    await click("研究报告");
    await wait(
      "document.body.innerText.includes('合成数据仅用于检验研究流程')",
    );
    await wait(
      "document.body.innerText.includes('关键依据与反证') && document.body.innerText.includes('限制（引用时务必保留）')",
    );
    assert.ok(
      await evaluate(
        "document.body.innerText.includes('合成结果只用于检查流程')",
      ),
      "Synthetic report should propose real-data followup instead of simulation",
    );
    const out = join(root, ".runtime", "browser-check");
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "desktop.png"),
      Buffer.from(
        (
          await send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await click("实验与证据");
    await wait("document.querySelectorAll('tbody tr').length===6");
    await evaluate(
      "(()=>{const details=[...document.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent.includes('核对指标证据'));details.open=true;details.querySelector('button').click();})()",
    );
    await wait("document.body.innerText.includes('证据身份与数值已核对')");
    await click("研究报告");
    await evaluate("document.querySelector('.report-checks button').click()");
    await wait(
      "document.body.innerText.includes('证据身份与数值已核对') && document.querySelectorAll('tbody tr').length===6",
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      await evaluate(
        "document.documentElement.scrollWidth<=window.innerWidth+1",
      ),
      "Mobile page overflows horizontally",
    );
    writeFileSync(
      join(out, "mobile.png"),
      Buffer.from(
        (
          await send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await send("Network.setBlockedURLs", {
      urls: ["*/api/quant/project-list"],
    });
    await wait(
      "document.querySelector('.research-space [role=alert]')!==null",
      10000,
    );
    await send("Network.setBlockedURLs", { urls: [] });
    await click("刷新状态");
    await wait("document.querySelector('.research-space [role=alert]')===null");
    await click("新建研究委托");
    await evaluate(
      "(()=>{const label=[...document.querySelectorAll('label.choice')].find(l=>l.textContent.includes('启用稳健性研究'));label.querySelector('input').click();})()",
    );
    await wait(
      "document.body.innerText.includes('当前委托至少需要 20 个实验')",
    );
    await click("生成研究委托");
    await wait(
      "document.querySelector('.project-detail .badge')?.textContent.trim()==='待确认委托'",
    );
    await click("确认协议并启动研究");
    await wait(
      "document.querySelector('.project-detail .badge')?.textContent.trim()==='已交付'",
      45000,
    );
    await click("研究报告");
    await wait("document.querySelector('.diagnostic-results')!==null");
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.diagnostic-results svg circle').length",
      ),
      4,
    );
    assert.ok(
      await evaluate(
        "document.querySelector('.diagnostic-results').innerText.includes('滚动验证') && document.querySelector('.diagnostic-results').innerText.includes('最终区间收益归因')",
      ),
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      "document.querySelector('.diagnostic-results').scrollIntoView({block:'start'})",
    );
    writeFileSync(
      join(out, "robust-desktop.png"),
      Buffer.from(
        (
          await send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      await evaluate(
        "document.documentElement.scrollWidth<=window.innerWidth+1",
      ),
      "Robust report overflows mobile viewport",
    );
    writeFileSync(
      join(out, "robust-mobile.png"),
      Buffer.from(
        (
          await send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await evaluate(
      "(()=>{const table=[...document.querySelectorAll('.diagnostic-results table')].find(t=>t.textContent.includes('UTC月份'));table.querySelector('tbody button').click();})()",
    );
    await wait(
      "document.body.innerText.includes('证据身份与数值已核对') && document.body.innerText.includes('attribution.months.0.startEquity')",
    );
    assert.equal(
      await evaluate("document.querySelectorAll('tbody tr').length"),
      20,
    );
    // Controlled CSV fixture exercises eligible report promotion; it is not market evidence.
    // Use a fresh deterministic series well outside previous holdout intervals.
    const fixtureBars = Array.from({ length: 1440 }, (_, i) => {
      const price = 100 + Math.sin(i / 12) * 5 + i * 0.02,
        open = 100 + Math.sin((i - 1) / 12) * 5 + (i - 1) * 0.02;
      return [
        Date.UTC(2023, 0, 1) + i * 3600000,
        open,
        Math.max(open, price) + 1,
        Math.min(open, price) - 1,
        price,
        100000,
      ];
    });
    const imported = await rpc("import", {
      submissionId: "cycle-csv",
      name: "Controlled browser lifecycle fixture",
      symbol: "BTCUSDT",
      interval: "1h",
      csv:
        "time,open,high,low,close,volume\n" +
        fixtureBars.map((row) => row.join(",")).join("\n"),
    });
    const oldStrategy = await rpc("draft", {
      submissionId: "cycle-old-strategy",
      expectedRevision: 0,
      name: "待替换配置",
      definition: {
        template: "sma_cross",
        symbols: ["BTCUSDT"],
        interval: "1h",
        fast: 5,
        slow: 30,
      },
    });
    await rpc("publish", {
      submissionId: "cycle-old-publish",
      id: oldStrategy.id,
      expectedRevision: oldStrategy.revision,
    });
    const oldAccount = await rpc("account", {
      submissionId: "cycle-old-account",
      name: "浏览器来源账户",
      strategyId: oldStrategy.id,
      config: { initialCash: "12000", costs: { feeBps: "7.5" } },
    });
    await evaluate(
      "[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.trim()==='模拟盘').click()",
    );
    await wait(
      "document.body.innerText.includes('浏览器来源账户') && document.body.innerText.includes('生成当前事实复盘')",
    );
    await click("生成当前事实复盘");
    await wait("document.body.innerText.includes('原研究与观察事实')");
    await evaluate(
      "document.querySelector('.simulation-review tbody button').click()",
    );
    await wait("document.body.innerText.includes('复盘证据已核对')");
    await click("从此问题生成研究草稿");
    await wait(
      "document.body.innerText.includes('来自模拟事实复盘的关联研究') && document.querySelector('.project-detail .badge')?.textContent.trim()==='待确认委托'",
    );
    const list = await rpc("monitor-list"),
      sourceReview = list.reviews.find((v) => v.accountId === oldAccount.id);
    const eligible = await rpc("project-create", {
      submissionId: "cycle-study",
      name: "运行变更验证",
      objective: "控制数据验证版本与批准流程",
      symbols: ["BTCUSDT"],
      interval: "1h",
      from: imported.from,
      to: imported.to,
      datasetIds: [imported.id],
      mode: "protocol",
      thresholds: {
        minClosedTrades: 1,
        maxDrawdownPct: "100",
        minExcessReturnPct: "-10000",
      },
      simulationSource: {
        accountId: oldAccount.id,
        reviewId: sourceReview.id,
        reviewHash: sourceReview.hash,
      },
    });
    await evaluate(
      `window.dispatchEvent(new CustomEvent('quant-open-project',{detail:${JSON.stringify(eligible.id)}}))`,
    );
    await wait(
      "document.querySelector('.project-detail h2')?.textContent==='运行变更验证'",
    );
    await click("确认协议并启动研究");
    await wait(
      "document.querySelector('.project-detail .badge')?.textContent.trim()==='已交付'",
      30000,
    );
    await click("研究报告");
    await wait("document.querySelector('.promotion-panel')!==null");
    await evaluate("document.querySelector('.promotion-panel').open=true");
    await wait(
      "document.body.innerText.includes('独立账户初始资金 USDT') && document.body.innerText.includes('单边手续费 bps')",
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      "document.querySelector('.promotion-panel').scrollIntoView({block:'start'})",
    );
    writeFileSync(
      join(out, "promotion-desktop.png"),
      Buffer.from(
        (
          await send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    await click("确认变更并替换原观察账户");
    await wait(
      "document.body.innerText.includes('新模拟账户已创建，尚未启动')",
    );
    const after = await rpc("snapshot"),
      transitions = (await rpc("monitor-list")).transitions;
    assert.equal(
      after.accounts.find((a) => a.id === oldAccount.id).status,
      "stopped",
    );
    const transition = transitions.find(
      (t) => t.fromAccountId === oldAccount.id,
    );
    assert.ok(transition);
    assert.equal(
      after.accounts.find((a) => a.id === transition.toAccountId).status,
      "created",
    );
    await click("前往模拟盘处理或启动");
    await wait("document.body.innerText.includes('已批准的运行版本变更')");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      await evaluate(
        "document.documentElement.scrollWidth<=window.innerWidth+1",
      ),
      "Simulation review overflows mobile viewport",
    );
    await evaluate(
      "document.querySelector('.simulation-review').scrollIntoView({block:'start'})",
    );
    writeFileSync(
      join(out, "simulation-mobile.png"),
      Buffer.from(
        (
          await send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          })
        ).data,
        "base64",
      ),
    );
    assert.equal(exceptions.length, 0, exceptions.join("\n"));
    console.log(
      "Chrome desktop/mobile, authenticated research, robust diagnostics, frozen simulation evidence, linked draft, approved account replacement and disconnect recovery: PASS",
    );
    console.log(`Browser screenshots: ${out}`);
  } finally {
    socket?.close();
    child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
