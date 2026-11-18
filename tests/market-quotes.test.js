"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { createMarketQuotes, MarketQuotesUnavailable } = require("../market-quotes");
const { createSyncServer } = require("../server");

const sampledAt = Date.parse("2026-11-17T05:30:00Z");

function item(overrides = {}) {
  return {
    GameId: 151, GoodsTypeId: 51, SpeciesGoodsUnitId: 16,
    AreaId: 701, AreaName: "大区", ServerId: 1, ServerName: "一服",
    GoldPrice: 5, TotalNum: 12.5, InventoryPiece: 1, Status: 0,
    CreateTime: "2026-11-17T07:30:00+08:00",
    UpdateTime: "2026-11-17T13:00:00+08:00",
    Proportion: 999,
    UserId: "not-for-output", GoodsSn: "not-for-output",
    ...overrides,
  };
}

function upstream(list, total = list.length) {
  return Response.json({ code: 200, data: { list, total } });
}

test("pages and groups actual zones, selecting the latest qualified computer-calculated quote", async () => {
  const requests = [];
  const regularSecond = item({
    AreaId: 702, AreaName: "另一个大区", ServerId: 1,
    GoldPrice: 4, TotalNum: 100,
    UpdateTime: "0001-01-01T00:00:00Z",
    CreateTime: "2026-11-16T16:00:00Z",
  });
  const seasonFirst = item({ GameId: 183, SpeciesGoodsUnitId: 11, GoldPrice: 4, TotalNum: 1400 });
  const getQuotes = createMarketQuotes({
    now: () => sampledAt,
    fetch: async (url, options) => {
      requests.push([url.searchParams.get("gameId"), url.searchParams.get("pages")]);
      assert.equal(url.origin, "https://www.hk1686.com");
      assert.equal(url.pathname, "/api/gameCurrency/getList");
      assert.equal(url.searchParams.get("pageSize"), "100");
      assert.equal(url.searchParams.get("goodsTypeId"), "51");
      assert.equal(options.redirect, "error");
      if (url.searchParams.get("gameId") === "183") return upstream([seasonFirst, item()]);
      if (url.searchParams.get("pages") === "2") {
        return upstream([regularSecond, item({ GoldPrice: 10, UpdateTime: "2026-11-17T13:29:00+08:00" })], 101);
      }
      return upstream([
        item(),
        item({ ServerId: 2, UpdateTime: "2026-11-16T15:59:59Z" }),
        item({ ServerId: 3, UpdateTime: "2026-11-17T13:31:00+08:00" }),
        item({ ServerId: 4, InventoryPiece: 0 }),
        item({ ServerId: 5, SpeciesGoodsUnitId: 11 }),
        item({ ServerId: 6, GoldPrice: 0 }),
        item({ ServerId: 7, TotalNum: -1 }),
        item({ ServerId: 8, Status: 1 }),
        item({ ServerId: 9, UpdateTime: "malformed", CreateTime: "malformed" }),
        item({ ServerId: "", TotalNum: 999 }),
        item({ ServerId: 10, GoodsTypeId: 50 }),
        seasonFirst,
      ], 101);
    },
  });
  const regular = await getQuotes("regular");
  const season = await getQuotes("season");
  assert.deepEqual(requests, [["151", "1"], ["151", "2"], ["183", "1"]]);
  assert.deepEqual(regular, {
    server: "regular", currency: "铸纹币", date: "2026-11-17", checkedAt: "2026-11-17T05:30:00.000Z", stale: false,
    quotes: [
      { areaId: 701, serverId: 1, areaName: "大区", serverName: "一服", perYuan: 1.25, updatedAt: "2026-11-17T05:29:00.000Z" },
      { areaId: 702, serverId: 1, areaName: "另一个大区", serverName: "一服", perYuan: 25, updatedAt: "2026-11-16T16:00:00.000Z" },
    ],
  });
  assert.equal(season.currency, "金币");
  assert.deepEqual(season.quotes, [
    { areaId: 701, serverId: 1, areaName: "大区", serverName: "一服", perYuan: 350, updatedAt: "2026-11-17T05:00:00.000Z" },
  ]);
  assert.doesNotMatch(JSON.stringify([regular, season]), /not-for-output/);
});

test("shares an active fetch and a one-hour cache; a partial refresh can only return same-day data", async () => {
  let now = sampledAt;
  let calls = 0;
  let interruptPage;
  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  const getQuotes = createMarketQuotes({
    now: () => now,
    fetch: async (url) => {
      calls += 1;
      await pause;
      if (url.searchParams.get("pages") === "2") {
        if (interruptPage) return new Response(null, { status: 502 });
        return upstream([item()], 101);
      }
      return upstream([item()], 101);
    },
  });
  const firstRequest = getQuotes("regular");
  const secondRequest = getQuotes("regular");
  assert.equal(calls, 1);
  release();
  const first = await firstRequest;
  assert.deepEqual(await secondRequest, first);
  assert.equal(calls, 2);

  now += 60 * 60_000 - 1;
  assert.deepEqual(await getQuotes("regular"), first);
  assert.equal(calls, 2);
  now += 1;
  interruptPage = true;
  assert.deepEqual(await getQuotes("regular"), { ...first, stale: true });
  assert.equal(calls, 4);
  assert.deepEqual(await getQuotes("regular"), { ...first, stale: true });
  assert.equal(calls, 4);
});

test("Beijing midnight invalidates the previous date, and a successful empty result differs from 503", async () => {
  let now = Date.parse("2026-11-17T15:59:00Z");
  let outcome = "valid";
  let calls = 0;
  const getQuotes = createMarketQuotes({
    now: () => now,
    fetch: async () => {
      calls += 1;
      if (outcome === "malformed") return Response.json({ code: 200, data: { total: 0 } });
      return upstream(outcome === "valid" ? [item()] : []);
    },
  });
  const before = await getQuotes("regular");
  assert.equal(before.date, "2026-11-17");
  assert.equal(before.quotes.length, 1);
  now += 60_000;
  outcome = "malformed";
  await assert.rejects(getQuotes("regular"), MarketQuotesUnavailable);
  assert.equal(calls, 2);
  outcome = "valid";
  const after = await getQuotes("regular");
  assert.deepEqual(after, {
    server: "regular", currency: "铸纹币", date: "2026-11-18", checkedAt: "2026-11-17T16:00:00.000Z",
    stale: false, quotes: [],
  });
  outcome = "empty";
  now += 60 * 60_000;
  const empty = await getQuotes("regular");
  assert.deepEqual(empty.quotes, []);
  assert.equal(empty.stale, false);
  assert.equal(calls, 4);
});

test("HTTP quotes endpoint is public, no-store and distinguishes invalid input from upstream failure", async (t) => {
  const server = createSyncServer({
    origin: "http://127.0.0.1:8765", password: "", dbPath: ":memory:",
    getMarketQuotes: createMarketQuotes({
      now: () => sampledAt,
      fetch: async (url) => url.searchParams.get("gameId") === "151" ? upstream([]) : new Response(null, { status: 503 }),
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = "http://127.0.0.1:" + server.address().port;
  const response = await fetch(address + "/api/market/quotes?server=regular");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    server: "regular", currency: "铸纹币", date: "2026-11-17", checkedAt: "2026-11-17T05:30:00.000Z",
    stale: false, quotes: [],
  });
  assert.equal((await fetch(address + "/api/market/quotes", { method: "POST" })).status, 405);
  assert.equal((await fetch(address + "/api/market/quotes?server=invalid")).status, 400);
  assert.equal((await fetch(address + "/market-quotes.js")).status, 404);
  const failure = await fetch(address + "/api/market/quotes?server=season");
  assert.equal(failure.status, 503);
  assert.match((await failure.json()).error, /铠甲兽/);
});
