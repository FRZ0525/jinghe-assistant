"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(join(__dirname, "../market-client.js"), "utf8");
const flush = () => new Promise(setImmediate);

function preview(date) {
  const elements = new Map();
  const responses = [];
  const requests = [];
  let timer;
  let now = Date.parse(date);
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() { return now; }
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        textContent: "",
        addEventListener(name, listener) { this[name] = listener; },
      });
      return elements.get(id);
    },
    addEventListener() {},
  };
  const window = {
    addEventListener() {},
    setInterval(handler) { timer = handler; },
    setTimeout() {},
    clearTimeout() {},
    async fetch(url) {
      requests.push(url);
      const response = responses.shift();
      return { ok: Boolean(response), async json() { return response; } };
    },
  };
  runInNewContext(source, { document, window, Date: Clock, AbortController });
  return {
    market: window.JingheMarket.mount(),
    elements,
    responses,
    requests,
    interval(date) {
      now = Date.parse(date);
      timer();
    },
  };
}

const snapshot = {
  server: "regular", currency: "铸纹币", date: "2026-11-17", stale: false,
  checkedAt: "2026-11-17T05:24:00Z",
  quotes: [{ perYuan: 12.5, updatedAt: "2026-11-17T05:00:00Z" }],
};

test("uses the server check time separately from the listing, including a cached response", async () => {
  const page = preview("2026-11-17T06:00:00Z");
  page.responses.push(snapshot, snapshot);
  page.market.selectServer("regular");
  await flush();
  const status = page.elements.get("market-status");
  const message = "挂单更新 13:00 · 上次检查 13:24（北京时间）";
  assert.equal(status.textContent, message);
  page.interval("2026-11-17T06:59:59Z");
  assert.equal(page.requests.length, 1);
  page.interval("2026-11-17T07:00:00Z");
  await flush();
  assert.equal(page.requests.length, 2);
  assert.equal(status.textContent, message);
});

test("an empty check has a timestamp and a failure only reports a real previous check", async () => {
  const page = preview("2026-11-17T06:00:00Z");
  page.responses.push(null, { ...snapshot, quotes: [] }, null, null);
  page.market.selectServer("regular");
  await flush();
  const status = page.elements.get("market-status");
  const retry = page.elements.get("market-retry");
  assert.equal(status.textContent, "暂时无法获取报价。");
  retry.click();
  await flush();
  assert.equal(status.textContent, "今天暂无有效报价 · 上次检查 13:24（北京时间）");
  assert.equal(page.elements.get("market-result").hidden, true);
  page.interval("2026-11-17T07:00:00Z");
  await flush();
  assert.equal(status.textContent, "今天暂无有效报价 · 上次检查 13:24（北京时间） · 暂未刷新");
  assert.equal(retry.hidden, false);
  page.interval("2026-11-17T16:00:00Z");
  await flush();
  assert.equal(status.textContent, "上次检查 2026-11-17 13:24（北京时间） · 暂未刷新");
});
