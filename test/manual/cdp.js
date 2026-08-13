// Manual-test helper: evaluate a JS expression in the running app's settings
// page via the Chrome DevTools Protocol (launch the app with
// --remote-debugging-port=9333). Prints the JSON result.
//   usage: node test/manual/cdp.js [port] <expression>
'use strict';

const port = process.argv[2] || '9333';
const expression = process.argv[3];
if (!expression) {
  console.error('usage: node test/manual/cdp.js [port] <expression>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Wait for the CDP endpoint to come up (the app may still be starting).
  let list = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) { list = await res.json(); break; }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  if (!list) { console.error('NO_CDP_ENDPOINT on port ' + port); process.exit(3); }

  const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''))
    || list.find((t) => t.type === 'page');
  if (!target) {
    console.error('NO_PAGE_TARGET', JSON.stringify(list));
    process.exit(3);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP evaluate timeout')), 20000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id === 1) {
        clearTimeout(timer);
        resolve(msg);
        try { ws.close(); } catch { /* ignore */ }
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
  });

  if (result.result && result.result.exceptionDetails) {
    console.error('EXCEPTION', JSON.stringify(result.result.exceptionDetails, null, 2));
    process.exit(4);
  }
  const value = result.result && result.result.result ? result.result.result.value : undefined;
  if (value === undefined) {
    console.log('OK (no return value)');
  } else {
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  process.exit(0);
})().catch((e) => {
  console.error('CDP_ERROR', String((e && e.message) || e));
  process.exit(5);
});
