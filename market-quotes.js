"use strict";

const UPSTREAM = "https://www.hk1686.com/api/gameCurrency/getList";
const GOODS_TYPE = 51;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const CACHE_MS = 60 * 60 * 1000;
const STALE_RETRY_MS = 30 * 1000;
const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const MARKETS = new Map([
  ["regular", { gameId: 151, unitId: 16, currency: "铸纹币" }],
  ["season", { gameId: 183, unitId: 11, currency: "金币" }],
]);

class MarketQuotesUnavailable extends Error {
  constructor() {
    super("铠甲兽报价暂时无法获取，请稍后重试");
  }
}

function beijingDate(timestamp) {
  const parts = Object.fromEntries(SHANGHAI_DATE.formatToParts(timestamp).map(({ type, value }) => [type, value]));
  return [parts.year, parts.month, parts.day].join("-");
}

function number(value) {
  if (typeof value === "number" || typeof value === "string" && value.trim()) return Number(value);
  return NaN;
}

function quoteTime(value) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return NaN;
  const time = Date.parse(value);
  return time > 0 ? time : NaN;
}

function readQuote(listing, market, date, checkedAt) {
  if (!listing || typeof listing !== "object") return null;
  if (
    number(listing.GameId) !== market.gameId ||
    number(listing.GoodsTypeId) !== GOODS_TYPE ||
    number(listing.SpeciesGoodsUnitId) !== market.unitId ||
    number(listing.Status) !== 0 ||
    !(number(listing.InventoryPiece) > 0)
  ) return null;

  const areaId = number(listing.AreaId);
  const serverId = number(listing.ServerId);
  const areaName = typeof listing.AreaName === "string" ? listing.AreaName.trim() : "";
  const serverName = typeof listing.ServerName === "string" ? listing.ServerName.trim() : "";
  if (!Number.isSafeInteger(areaId) || areaId <= 0 || !Number.isSafeInteger(serverId) || serverId <= 0 ||
      !areaName || !serverName) return null;

  const price = number(listing.GoldPrice);
  const amount = number(listing.TotalNum);
  const perYuan = amount / price;
  if (!(price > 0 && amount > 0 && perYuan > 0 && Number.isFinite(perYuan))) return null;

  const time = quoteTime(listing.UpdateTime) || quoteTime(listing.CreateTime);
  if (!Number.isFinite(time) || time > checkedAt || beijingDate(time) !== date) return null;
  return { areaId, serverId, areaName, serverName, perYuan, updatedAt: new Date(time).toISOString() };
}

async function loadPage(fetch, market, page, signal) {
  const url = new URL(UPSTREAM);
  url.search = new URLSearchParams({
    pageSize: PAGE_SIZE,
    gameId: market.gameId,
    goodsTypeId: GOODS_TYPE,
    pages: page,
    proportion: "asc",
  });
  const response = await fetch(url, { signal, redirect: "error", headers: { Accept: "application/json" } });
  if (!response.ok) throw new MarketQuotesUnavailable();
  const payload = await response.json();
  const total = number(payload?.data?.total);
  const list = payload?.data?.list;
  if (payload?.code !== 200 || !Number.isSafeInteger(total) || total < 0 ||
      total > MAX_PAGES * PAGE_SIZE || !Array.isArray(list)) {
    throw new MarketQuotesUnavailable();
  }
  return { list, pages: Math.ceil(total / PAGE_SIZE) };
}

async function loadQuotes(fetch, now, server, market) {
  const signal = AbortSignal.timeout(12_000);
  const allListings = [];
  let pages = 1;
  for (let page = 1; page <= pages; page += 1) {
    const result = await loadPage(fetch, market, page, signal);
    allListings.push(...result.list);
    pages = Math.max(pages, result.pages);
  }

  const checkedAt = now();
  const date = beijingDate(checkedAt);
  const byRegion = new Map();
  for (const listing of allListings) {
    const quote = readQuote(listing, market, date, checkedAt);
    if (!quote) continue;
    const key = quote.areaId + ":" + quote.serverId;
    const previous = byRegion.get(key);
    if (!previous || previous.updatedAt < quote.updatedAt) byRegion.set(key, quote);
  }
  const quotes = [...byRegion.values()].sort((a, b) => (
    b.updatedAt.localeCompare(a.updatedAt) || a.areaId - b.areaId || a.serverId - b.serverId
  ));
  return { server, currency: market.currency, date, checkedAt: new Date(checkedAt).toISOString(), stale: false, quotes };
}

function createMarketQuotes({ fetch = globalThis.fetch, now = Date.now, ttlMs = CACHE_MS } = {}) {
  const caches = new Map();

  return async function getMarketQuotes(server) {
    const market = MARKETS.get(server);
    if (!market) throw new RangeError("没有这个游戏服");
    if (!caches.has(server)) {
      caches.set(server, { success: null, expiresAt: 0, retryAt: 0, pending: null });
    }
    const cache = caches.get(server);
    const requestedAt = now();
    if (cache.success?.date === beijingDate(requestedAt)) {
      if (requestedAt < cache.expiresAt) return cache.success;
      if (requestedAt < cache.retryAt) return { ...cache.success, stale: true };
    }
    if (cache.pending) return cache.pending;

    cache.pending = (async () => {
      try {
        const result = await loadQuotes(fetch, now, server, market);
        cache.success = result;
        cache.expiresAt = Date.parse(result.checkedAt) + ttlMs;
        cache.retryAt = 0;
        return result;
      } catch {
        const failedAt = now();
        if (cache.success?.date === beijingDate(failedAt)) {
          cache.retryAt = failedAt + STALE_RETRY_MS;
          return { ...cache.success, stale: true };
        }
        throw new MarketQuotesUnavailable();
      } finally {
        cache.pending = null;
      }
    })();
    return cache.pending;
  };
}

module.exports = { createMarketQuotes, MarketQuotesUnavailable };
