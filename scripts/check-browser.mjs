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
    await evaluate(
      "(()=>{const select=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='protocol'));select.value='protocol';select.dispatchEvent(new Event('change',{bubbles:true}));const checkbox=[...document.querySelectorAll('label.choice')].find(l=>l.textContent.includes('合成演示')).querySelector('input');checkbox.click();})()",
    );
    await click("生成研究委托");
    await wait("document.body.innerText.includes('确认协议并启动研究')");
    await click("确认协议并启动研究");
    await wait("document.body.innerText.includes('已交付')", 30000);
    await click("研究报告");
    await wait(
      "document.body.innerText.includes('合成数据仅用于检验研究流程')",
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
    assert.equal(exceptions.length, 0, exceptions.join("\n"));
    console.log(
      "Chrome desktop/mobile, real authenticated RPC, six worker experiments, report/evidence navigation and disconnect recovery: PASS",
    );
    console.log(`Browser screenshots: ${out}`);
  } finally {
    socket?.close();
    child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
