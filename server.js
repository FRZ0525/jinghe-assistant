"use strict";

const { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { mkdirSync } = require("node:fs");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { isIP } = require("node:net");
const { dirname, join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { promisify } = require("node:util");
const { createMarketQuotes, MarketQuotesUnavailable } = require("./market-quotes");
const Tracker = require("./tracker");

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPTS = 8;
const LOGIN_BUCKETS = 4096;
const MAX_STATE_BYTES = Tracker.BACKUP_LIMIT;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_PASSWORD_BYTES = 1024;
const VERIFIER_BYTES = 32;
const derivePassword = promisify(scrypt);
const SERVER_IDS = ["regular", "season"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/tracker.js", "tracker.js"],
  ["/app.js", "app.js"],
  ["/recovery.js", "recovery.js"],
  ["/market-client.js", "market-client.js"],
  ["/sync-client.js", "sync-client.js"],
  ["/sync-merge.js", "sync-merge.js"],
  ["/roster-layout.js", "roster-layout.js"],
  ["/roster-import.js", "roster-import.js"],
  ["/roster-ocr.js", "roster-ocr.js"],
  ["/assets/app-icon.png", "assets/app-icon.png"],
  ["/assets/crystal-fox.webp", "assets/crystal-fox.webp"],
  ["/assets/fonts/fonts.css", "assets/fonts/fonts.css"],
  ["/assets/fonts/zcool-kuaile-headings.woff2", "assets/fonts/zcool-kuaile-headings.woff2"],
  ["/assets/fonts/noto-sans-sc-ui.woff2", "assets/fonts/noto-sans-sc-ui.woff2"],
  ["/assets/fonts/noto-sans-sc-gb2312.woff2", "assets/fonts/noto-sans-sc-gb2312.woff2"],
  ["/assets/fonts/noto-serif-sc-headings.woff2", "assets/fonts/noto-serif-sc-headings.woff2"],
  ["/assets/fonts/nunito-700-latin.woff2", "assets/fonts/nunito-700-latin.woff2"],
  ["/assets/fonts/inter-600-latin.woff2", "assets/fonts/inter-600-latin.woff2"],
  ["/assets/fonts/dm-sans-600-latin.woff2", "assets/fonts/dm-sans-600-latin.woff2"],
  ["/ocr/tesseract.min.js", "ocr/tesseract.min.js"],
  ["/ocr/worker.min.js", "ocr/worker.min.js"],
  ["/ocr/tesseract-core-lstm.wasm.js", "ocr/tesseract-core-lstm.wasm.js"],
  ["/ocr/tesseract-core-simd-lstm.wasm.js", "ocr/tesseract-core-simd-lstm.wasm.js"],
  ["/ocr/chi_sim.traineddata.gz", "ocr/chi_sim.traineddata.gz"],
  ["/ocr/eng.traineddata.gz", "ocr/eng.traineddata.gz"],
  ["/ocr/LICENSE-tesseract.md", "ocr/LICENSE-tesseract.md"],
  ["/ocr/LICENSE-core.txt", "ocr/LICENSE-core.txt"],
  ["/ocr/LICENSE-tessdata.txt", "ocr/LICENSE-tessdata.txt"],
  ["/ocr/SOURCES.md", "ocr/SOURCES.md"],
  ["/coa-scene.webp", "coa-scene.webp"],
  ["/coa-inventor.webp", "coa-inventor.webp"],
  ["/coa-frost.webp", "coa-frost.webp"],
]);
const TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  png: "image/png",
  webp: "image/webp",
  woff2: "font/woff2",
  gz: "application/gzip",
  md: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};
const API_METHODS = new Map([
  ["/api/sync/status", ["GET"]],
  ["/api/sync/login", ["POST"]],
  ["/api/sync/setup", ["POST"]],
  ["/api/sync/password", ["POST"]],
  ["/api/sync/logout", ["POST"]],
  ["/api/sync/state", ["GET", "PUT"]],
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function configuredOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("JINGHE_ORIGIN 必须是站点地址，例如 https://jinghe.example.com");
  }
  if (
    url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)))
  ) {
    throw new Error("JINGHE_ORIGIN 应为 HTTPS 站点地址。HTTP 仅用于本机测试");
  }
  return url;
}

function json(response, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    throw new RequestError(415, "请求需要使用 JSON 格式");
  }
  if (Number(request.headers["content-length"]) > limit) {
    throw new RequestError(413, "请求数据过大");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw new RequestError(413, "请求数据过大");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "请求不是有效的 JSON");
  }
  if (!isRecord(body)) throw new RequestError(400, "请求需要包含一个 JSON 对象");
  return body;
}

function normalizeData(data) {
  if (!isRecord(data) || !isRecord(data.servers)) {
    throw new RequestError(400, "同步数据需要包含账号进度");
  }

  try {
    for (const serverId of SERVER_IDS) {
      const server = data.servers[serverId];
      const label = Tracker.getServerDef(serverId).label;
      if (!isRecord(server) || !Array.isArray(server.accounts)) {
        throw new RequestError(400, label + "的账号数据格式不正确");
      }
      if (server.accounts.length > Tracker.ACCOUNT_LIMIT) {
        throw new RequestError(400, label + "账号超过 " + Tracker.ACCOUNT_LIMIT + " 个");
      }

      let characters = 0;
      for (const account of server.accounts) {
        const zones = Array.isArray(account?.zones) ? account.zones : [account];
        for (const zone of zones) {
          if (Array.isArray(zone?.characters)) characters += zone.characters.length;
        }
      }
      if (characters > Tracker.CHARACTER_LIMIT) {
        throw new RequestError(400, label + "角色超过 " + Tracker.CHARACTER_LIMIT + " 个");
      }

      // An omitted raid is generated for every character by the tracker.
      const config = Tracker.normalizeServerState(serverId, { ...server, accounts: [] });
      const raidBytes = config.activeRaids.reduce((total, name) => (
        total + Buffer.byteLength(JSON.stringify({ name, remaining: 0, doneToday: true }))
      ), 0);
      if (characters * raidBytes > MAX_STATE_BYTES) {
        throw new RequestError(413, "同步进度的数据量过大");
      }
    }

    const { dailyDate, dailyResetHour, servers } = Tracker.normalizeAppState(data);
    const serialized = JSON.stringify({ dailyDate, dailyResetHour, servers });
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new RequestError(413, "同步进度的数据量过大");
    }
    return serialized;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "同步进度的数据格式不正确");
  }
}

function openDatabase(dbPath) {
  if (dbPath !== ":memory:") {
    dbPath = resolve(dbPath);
    const isPublicFile = Array.from(STATIC_FILES.values()).some((file) => (
      join(__dirname, file).toLowerCase() === dbPath.toLowerCase()
    ));
    if (isPublicFile) throw new Error("JINGHE_DB_PATH 不能指向公开的页面资源");
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        data TEXT
      ) STRICT;
      INSERT OR IGNORE INTO sync_state (id, revision, data) VALUES (1, 0, NULL);
      CREATE TABLE IF NOT EXISTS sync_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sync_password (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        salt BLOB NOT NULL,
        verifier BLOB NOT NULL
      ) STRICT;
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function publicState(row) {
  return { revision: row.revision, data: row.data === null ? null : JSON.parse(row.data) };
}

function clientAddress(request, trustProxy) {
  const forwarded = trustProxy && request.headers["x-forwarded-for"];
  return typeof forwarded === "string" && isIP(forwarded.trim())
    ? forwarded.trim()
    : request.socket.remoteAddress || "unknown";
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function validPassword(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_PASSWORD_BYTES;
}

async function makeCredentials(password) {
  if (!validPassword(password)) throw new RequestError(400, "请输入 1 至 1024 字节的同步密码");
  const salt = randomBytes(16);
  return { salt, verifier: await derivePassword(password, salt, VERIFIER_BYTES) };
}

async function verifyPassword(password, credentials) {
  if (!validPassword(password)) return false;
  const candidate = credentials.salt
    ? await derivePassword(password, credentials.salt, VERIFIER_BYTES)
    : sha256(password);
  return timingSafeEqual(credentials.verifier, candidate);
}

function hashSession(token, verifier) {
  return createHmac("sha256", verifier).update(token).digest("hex");
}

function readSessionHash(request, cookieName, credentials) {
  if (!credentials) return null;
  const cookie = request.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const value = part.trim();
    if (!value.startsWith(cookieName + "=")) continue;
    const token = value.slice(cookieName.length + 1);
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return hashSession(token, credentials.verifier);
    }
  }
  return null;
}

async function serveStatic(request, response, path) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const file = STATIC_FILES.get(path);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(join(__dirname, file));
    const versionedFont = file.endsWith(".woff2") && /\?v=[a-f0-9]{12}$/.test(request.url);
    response.writeHead(200, {
      "Content-Type": TYPES[file.split(".").at(-1)],
      "Content-Length": content.length,
      "Cache-Control": versionedFont ? "public, max-age=31536000, immutable" : "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404).end();
      return;
    }
    throw error;
  }
}

function createSyncServer({
  origin = process.env.JINGHE_ORIGIN,
  password = process.env.JINGHE_SYNC_PASSWORD,
  dbPath = process.env.JINGHE_DB_PATH || join(__dirname, "data", "jinghe.sqlite"),
  trustProxy = process.env.JINGHE_TRUST_PROXY === "1",
  onSetupRequired,
  getMarketQuotes = createMarketQuotes(),
} = {}) {
  const url = configuredOrigin(origin);
  if (password !== undefined && password !== "" && !validPassword(password)) {
    throw new Error("请通过 JINGHE_SYNC_PASSWORD 设置 1 至 1024 字节的同步密码");
  }
  const legacyCredentials = password ? { salt: null, verifier: sha256(password) } : null;
  const secure = url.protocol === "https:";
  const requiresSetupCode = secure || trustProxy;
  const cookieName = secure ? "__Host-jinghe_sync" : "jinghe_sync";
  const cookieHeader = (token, maxAge) => (
    cookieName + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge +
    (secure ? "; Secure" : "")
  );
  const db = openDatabase(dbPath);
  const getState = db.prepare("SELECT revision, data FROM sync_state WHERE id = 1");
  const updateState = db.prepare(`
    UPDATE sync_state SET revision = revision + 1, data = ?
    WHERE id = 1 AND revision = ?
    RETURNING revision, data
  `);
  const getSession = db.prepare("SELECT 1 FROM sync_sessions WHERE token_hash = ? AND expires_at > ?");
  const addSession = db.prepare("INSERT INTO sync_sessions (token_hash, expires_at) VALUES (?, ?)");
  const deleteSession = db.prepare("DELETE FROM sync_sessions WHERE token_hash = ?");
  const deleteExpired = db.prepare("DELETE FROM sync_sessions WHERE expires_at <= ?");
  const deleteAllSessions = db.prepare("DELETE FROM sync_sessions");
  const getPassword = db.prepare("SELECT salt, verifier FROM sync_password WHERE id = 1");
  const putPassword = db.prepare(`
    INSERT INTO sync_password (id, salt, verifier) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET salt = excluded.salt, verifier = excluded.verifier
  `);
  const failures = new Map();
  const currentCredentials = () => getPassword.get() || legacyCredentials;
  const setupCode = requiresSetupCode && !currentCredentials() ? randomBytes(32).toString("base64url") : null;
  const setupCodeHash = setupCode && sha256(setupCode);

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function throttleCredentials(request, response) {
    const now = Date.now();
    const address = clientAddress(request, trustProxy);
    for (const [key, bucket] of failures) {
      if (bucket.until > now) break;
      failures.delete(key);
    }
    let bucket = failures.get(address);
    if (bucket?.count >= LOGIN_ATTEMPTS || (!bucket && failures.size >= LOGIN_BUCKETS)) {
      const until = bucket?.until ?? now + LOGIN_WINDOW_MS;
      response.setHeader("Retry-After", Math.max(1, Math.ceil((until - now) / 1000)));
      throw new RequestError(429, "登录尝试过多，请稍后再试");
    }
    if (!bucket) {
      bucket = { count: 0, until: now + LOGIN_WINDOW_MS };
      failures.set(address, bucket);
    }
    bucket.count += 1;
    return () => {
      if (failures.get(address) === bucket) failures.delete(address);
    };
  }

  function newSession(credentials, oldHash) {
    const now = Date.now();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashSession(token, credentials.verifier);
    deleteExpired.run(now);
    if (oldHash) deleteSession.run(oldHash);
    addSession.run(tokenHash, now + SESSION_SECONDS * 1000);
    return token;
  }

  function respondAuthenticated(response, token) {
    response.setHeader("Set-Cookie", cookieHeader(token, SESSION_SECONDS));
    json(response, 200, { authenticated: true });
  }

  function ensureCurrentCredentials(credentials) {
    const current = currentCredentials();
    if (!current || !timingSafeEqual(credentials.verifier, current.verifier)) {
      throw new RequestError(401, "同步密码已更新，请重新登录");
    }
  }

  async function login(request, response, credentials, oldHash) {
    if (!credentials) throw new RequestError(409, "请先设置同步密码");
    const body = await readJson(request, MAX_CREDENTIAL_BYTES);
    const resetThrottle = throttleCredentials(request, response);
    if (!await verifyPassword(body.password, credentials)) {
      throw new RequestError(401, "同步密码不正确");
    }
    const token = transaction(() => {
      ensureCurrentCredentials(credentials);
      return newSession(credentials, oldHash);
    });
    resetThrottle();
    respondAuthenticated(response, token);
  }

  async function setup(request, response) {
    if (currentCredentials()) throw new RequestError(409, "同步密码已设置");
    const address = request.socket.remoteAddress;
    if (!requiresSetupCode && !LOOPBACK_HOSTS.has(address) && address !== "::ffff:127.0.0.1") {
      throw new RequestError(403, "请从运行服务的设备打开本站完成设置");
    }
    const body = await readJson(request, MAX_CREDENTIAL_BYTES);
    const resetThrottle = throttleCredentials(request, response);
    if (requiresSetupCode && (
      !setupCodeHash || typeof body.setupCode !== "string" ||
      !timingSafeEqual(setupCodeHash, sha256(body.setupCode))
    )) {
      throw new RequestError(403, "设置码不正确，请从服务启动日志打开设置链接");
    }
    const credentials = await makeCredentials(body.password);
    const token = transaction(() => {
      if (currentCredentials()) throw new RequestError(409, "同步密码已设置");
      putPassword.run(credentials.salt, credentials.verifier);
      return newSession(credentials);
    });
    resetThrottle();
    respondAuthenticated(response, token);
  }

  async function changePassword(request, response, credentials, tokenHash) {
    const body = await readJson(request, MAX_CREDENTIAL_BYTES);
    const resetThrottle = throttleCredentials(request, response);
    if (!await verifyPassword(body.currentPassword, credentials)) {
      throw new RequestError(403, "当前同步密码不正确");
    }
    const next = await makeCredentials(body.password);
    const token = transaction(() => {
      ensureCurrentCredentials(credentials);
      if (!getSession.get(tokenHash, Date.now())) throw new RequestError(401, "请先登录同步");
      putPassword.run(next.salt, next.verifier);
      deleteAllSessions.run();
      return newSession(next);
    });
    resetThrottle();
    respondAuthenticated(response, token);
  }

  async function sync(request, response, path) {
    const methods = API_METHODS.get(path);
    if (!methods) throw new RequestError(404, "找不到同步接口");
    if (!methods.includes(request.method)) {
      response.setHeader("Allow", methods.join(", "));
      throw new RequestError(405, "同步接口不支持此请求方法");
    }
    if (request.method !== "GET" && request.headers.origin !== url.origin) {
      throw new RequestError(403, "同步请求的来源不符合站点设置");
    }

    const credentials = currentCredentials();
    const tokenHash = readSessionHash(request, cookieName, credentials);
    if (path === "/api/sync/setup") {
      await setup(request, response);
      return;
    }
    if (path === "/api/sync/login") {
      await login(request, response, credentials, tokenHash);
      return;
    }
    if (path === "/api/sync/logout") {
      if (tokenHash) deleteSession.run(tokenHash);
      response.setHeader("Set-Cookie", cookieHeader("", 0));
      json(response, 200, { authenticated: false });
      return;
    }

    const authenticated = Boolean(tokenHash && getSession.get(tokenHash, Date.now()));
    if (path === "/api/sync/status") {
      json(response, 200, credentials ? { authenticated } : {
        authenticated: false,
        needsSetup: true,
        requiresSetupCode,
      });
      return;
    }
    if (!authenticated) throw new RequestError(401, "请先登录同步");
    if (path === "/api/sync/password") {
      await changePassword(request, response, credentials, tokenHash);
      return;
    }
    if (request.method === "GET") {
      json(response, 200, publicState(getState.get()));
      return;
    }

    const body = await readJson(request, MAX_STATE_BYTES);
    if (!getSession.get(tokenHash, Date.now())) throw new RequestError(401, "请先登录同步");
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 || body.revision >= Number.MAX_SAFE_INTEGER) {
      throw new RequestError(400, "同步版本号不正确");
    }
    const row = updateState.get(normalizeData(body.data), body.revision);
    if (!row) {
      json(response, 409, publicState(getState.get()));
      return;
    }
    json(response, 200, publicState(row));
  }

  async function marketQuotes(request, response) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      throw new RequestError(405, "行情接口不支持此请求方法");
    }
    const server = new URL(request.url, url.origin).searchParams.get("server");
    if (!SERVER_IDS.includes(server)) throw new RequestError(400, "请选择常规服或赛季服");
    try {
      json(response, 200, await getMarketQuotes(server));
    } catch (error) {
      if (error instanceof MarketQuotesUnavailable) throw new RequestError(503, error.message);
      throw error;
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (request, response) => {
    const path = request.url.split("?", 1)[0];
    const isApi = path === "/api" || path.startsWith("/api/");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (path === "/api/market/quotes") await marketQuotes(request, response);
      else if (isApi) await sync(request, response, path);
      else await serveStatic(request, response, path);
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
      } else if (error instanceof RequestError) {
        if (error.status === 413) request.resume();
        json(response, error.status, { error: error.message });
      } else {
        console.error("晶核助手服务器处理请求失败", error.code || error.name);
        if (isApi) json(response, 500, { error: "同步服务暂时无法处理请求" });
        else response.writeHead(500).end();
      }
    }
  });
  if (setupCode && typeof onSetupRequired === "function") {
    server.once("listening", () => onSetupRequired(url.origin + "/#setup=" + setupCode));
  }
  server.once("close", () => db.close());
  return server;
}

if (require.main === module) {
  try {
    const port = Number(process.env.JINGHE_PORT || "8765");
    const configuredHost = process.env.JINGHE_HOST || "127.0.0.1";
    const host = configuredHost === "[::1]" ? "::1" : configuredHost;
    const origin = process.env.JINGHE_ORIGIN || "http://127.0.0.1:" + port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("JINGHE_PORT 必须介于 1 和 65535 之间");
    }
    if (configuredOrigin(origin).protocol === "http:" && !LOOPBACK_HOSTS.has(host)) {
      throw new Error("HTTP 测试只允许监听本机回环地址");
    }
    const server = createSyncServer({
      origin,
      onSetupRequired: (setupUrl) => console.log("首次设置同步密码 " + setupUrl),
    });
    server.on("error", (error) => {
      console.error(error.code === "EADDRINUSE" ? "端口已被占用，请修改 JINGHE_PORT" : error.message);
      process.exitCode = 1;
    });
    server.listen(port, host, () => console.log("晶核助手 " + configuredOrigin(origin).origin));
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => server.close());
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createSyncServer };
