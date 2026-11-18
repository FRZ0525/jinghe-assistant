"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtemp, rm, rmdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { createSyncServer } = require("../server");
const Tracker = require("../tracker");

const origin = "https://jinghe.test";
const password = "同步测试口令 test-only";

async function listen(options = {}) {
  const server = createSyncServer({ origin, password, dbPath: ":memory:", trustProxy: false, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = "http://127.0.0.1:" + server.address().port;
  return {
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    request(path, { method = "GET", cookie, headers, data } = {}) {
      return fetch(address + path, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    },
  };
}

async function logIn(service, headers = { Origin: origin }, candidate = password) {
  const response = await service.request("/api/sync/login", {
    method: "POST", headers, data: { password: candidate },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { authenticated: true });
  return response.headers.get("set-cookie");
}

function stateWithProgress(name) {
  const data = Tracker.createAppState();
  data.dailyDate = "2020-01-01";
  const server = data.servers.regular;
  const account = Tracker.createAccount(name);
  const character = Tracker.createCharacter("角色一", server.activeRaids, server.maxAttempts);
  character.staminaDone = true;
  character.raids[0].doneToday = true;
  character.raids[0].remaining = 99;
  account.zones[0].characters.push(character);
  server.accounts.push(account);
  return data;
}

test("only a loopback origin may use HTTP", () => {
  assert.throws(() => createSyncServer({ origin: "http://192.168.1.9", password }), /HTTP/);
  assert.throws(() => createSyncServer({ origin: "https://jinghe.test/subpath", password }), /HTTPS/);
  assert.throws(() => createSyncServer({ origin, password: "a".repeat(1025) }), /JINGHE_SYNC_PASSWORD/);
  assert.throws(() => createSyncServer({
    origin, password, dbPath: join(__dirname, "..", "sync-merge.js"),
  }), /公开的页面资源/);
});

test("localhost preview can set a password once without an environment password", async (t) => {
  const localOrigin = "http://127.0.0.1:8765";
  const service = await listen({
    origin: localOrigin,
    password: "",
    onSetupRequired: () => assert.fail("Loopback setup needs no setup link"),
  });
  t.after(() => service.close());
  const status = await service.request("/api/sync/status");
  assert.deepEqual(await status.json(), { authenticated: false, needsSetup: true, requiresSetupCode: false });
  const setup = (headers) => service.request("/api/sync/setup", { method: "POST", headers, data: { password } });
  assert.equal((await setup({ Origin: origin })).status, 403);
  const operations = await Promise.all([setup({ Origin: localOrigin }), setup({ Origin: localOrigin })]);
  assert.deepEqual(operations.map((response) => response.status).sort(), [200, 409]);
  const result = operations.find((response) => response.ok);
  assert.deepEqual(await result.json(), { authenticated: true });
  const cookie = result.headers.get("set-cookie").split(";")[0];
  assert.deepEqual(await (await service.request("/api/sync/status", { cookie })).json(), { authenticated: true });
  assert.equal((await setup({ Origin: localOrigin })).status, 409);
});

test("initial HTTPS setup code stays in the startup callback and cannot be reused", async (t) => {
  const setupLinks = [];
  const service = await listen({ password: "", onSetupRequired: (url) => setupLinks.push(url) });
  t.after(() => service.close());
  assert.equal(setupLinks.length, 1);
  const [setupLink] = setupLinks;
  const setupCode = setupLink.slice((origin + "/#setup=").length);
  assert.equal(setupLink, origin + "/#setup=" + setupCode);
  assert.match(setupCode, /^[A-Za-z0-9_-]{43}$/);
  const status = await service.request("/api/sync/status");
  assert.deepEqual(await status.json(), { authenticated: false, needsSetup: true, requiresSetupCode: true });

  const setup = (candidate, originHeader = origin) => service.request("/api/sync/setup", {
    method: "POST", headers: { Origin: originHeader }, data: { password, setupCode: candidate },
  });
  assert.equal((await setup()).status, 403);
  const invalid = await setup("wrong");
  assert.equal(invalid.status, 403);
  const error = await invalid.text();
  assert.doesNotMatch(error, new RegExp(setupCode));
  assert.equal((await setup(setupCode, "https://other.test")).status, 403);
  const configured = await setup(setupCode);
  assert.equal(configured.status, 200);
  assert.match(configured.headers.get("set-cookie"), /^__Host-jinghe_sync=.*; Secure$/);
  assert.equal((await setup(setupCode)).status, 409);
  assert.deepEqual(await (await service.request("/api/sync/status")).json(), { authenticated: false });
});

test("changing an environment password persists a salted verifier and revokes other devices", async () => {
  const folder = await mkdtemp(join(tmpdir(), "jinghe-password-test-"));
  const dbPath = join(folder, "test.sqlite");
  const replacement = "新的同步密码 persisted-test";
  let service;
  try {
    service = await listen({ dbPath });
    const cookie = (await logIn(service)).split(";")[0];
    const other = (await logIn(service)).split(";")[0];
    const change = (currentPassword, headers = { Origin: origin }, session = cookie) => (
      service.request("/api/sync/password", {
        method: "POST", cookie: session, headers, data: { currentPassword, password: replacement },
      })
    );
    const existing = stateWithProgress("已同步进度");
    const write = await service.request("/api/sync/state", {
      method: "PUT", cookie, headers: { Origin: origin }, data: { revision: 0, data: existing },
    });
    assert.equal(write.status, 200);
    const oldState = await write.json();
    const blockedSetup = await service.request("/api/sync/setup", {
      method: "POST", headers: { Origin: origin }, data: { password: replacement },
    });
    assert.equal(blockedSetup.status, 409);
    assert.equal((await change(password, { Origin: "https://other.test" })).status, 403);
    assert.equal((await change(password, { Origin: origin }, "")).status, 401);
    assert.equal((await change("wrong")).status, 403);
    const updated = await change(password);
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { authenticated: true });
    const renewed = updated.headers.get("set-cookie").split(";")[0];
    assert.notEqual(renewed, cookie);
    for (const invalidated of [cookie, other]) {
      assert.equal((await service.request("/api/sync/state", { cookie: invalidated })).status, 401);
    }
    assert.deepEqual(await (await service.request("/api/sync/state", { cookie: renewed })).json(), oldState);
    await service.close();
    service = null;

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT salt, verifier FROM sync_password").get();
      assert.equal(row.salt.length, 16);
      assert.equal(row.verifier.length, 32);
      assert.notEqual(Buffer.from(row.verifier).toString("utf8"), replacement);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sync_sessions").get().count, 1);
    } finally {
      db.close();
    }
    service = await listen({
      dbPath,
      onSetupRequired: () => assert.fail("Persisted passwords must not generate a setup link"),
    });
    const oldLogin = await service.request("/api/sync/login", {
      method: "POST", headers: { Origin: origin }, data: { password },
    });
    assert.equal(oldLogin.status, 401);
    const fromNewPassword = (await logIn(service, { Origin: origin }, replacement)).split(";")[0];
    assert.deepEqual(await (await service.request("/api/sync/state", { cookie: fromNewPassword })).json(), oldState);
    assert.deepEqual(await (await service.request("/api/sync/status", { cookie: renewed })).json(), { authenticated: true });
  } finally {
    if (service) await service.close();
    for (const suffix of ["-wal", "-shm", ""]) await rm(dbPath + suffix, { force: true });
    await rmdir(folder);
  }
});

test("sync requires a session and restricts write origin", async (t) => {
  const service = await listen();
  t.after(() => service.close());

  const status = await service.request("/api/sync/status");
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), { authenticated: false });
  const unauthorized = await service.request("/api/sync/state");
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");
  assert.match((await unauthorized.json()).error, /登录/);

  for (const headers of [{}, { Origin: "https://other.test" }]) {
    const denied = await service.request("/api/sync/login", { method: "POST", headers, data: { password } });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /来源/);
  }

  const header = await logIn(service);
  assert.match(header, /^__Host-jinghe_sync=[A-Za-z0-9_-]{43};/);
  for (const value of ["Path=/", "HttpOnly", "SameSite=Strict", "Secure"]) assert.ok(header.includes(value));
  assert.doesNotMatch(header, /Domain=/i);
  const cookie = header.split(";")[0];
  assert.deepEqual(await (await service.request("/api/sync/status", { cookie })).json(), { authenticated: true });
  assert.deepEqual(await (await service.request("/api/sync/state", { cookie })).json(), { revision: 0, data: null });

  const crossSite = { cookie, headers: { Origin: "https://other.test" } };
  assert.equal((await service.request("/api/sync/state", {
    method: "PUT", ...crossSite, data: { revision: 0, data: stateWithProgress("外站") },
  })).status, 403);
  assert.equal((await service.request("/api/sync/logout", { method: "POST", ...crossSite })).status, 403);
  const logout = await service.request("/api/sync/logout", { method: "POST", cookie, headers: { Origin: origin } });
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.deepEqual(await logout.json(), { authenticated: false });
  assert.equal((await service.request("/api/sync/state", { cookie })).status, 401);
});

test("writes are normalized, checked and protected by an atomic revision", async (t) => {
  const service = await listen();
  t.after(() => service.close());
  const cookie = (await logIn(service)).split(";")[0];
  const put = (data) => service.request("/api/sync/state", {
    method: "PUT", cookie, headers: { Origin: origin }, data,
  });
  const malformed = await put({ revision: 0, data: [] });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /账号/);

  const tooManyAccounts = Tracker.createAppState();
  tooManyAccounts.servers.regular.accounts = Array.from(
    { length: Tracker.ACCOUNT_LIMIT + 1 }, (_, index) => Tracker.createAccount("账号" + index),
  );
  const accountLimit = await put({ revision: 0, data: tooManyAccounts });
  assert.equal(accountLimit.status, 400);
  assert.match((await accountLimit.json()).error, /账号超过/);

  const tooManyCharacters = Tracker.createAppState();
  const account = Tracker.createAccount("账号");
  account.zones[0].characters = Array.from(
    { length: Tracker.CHARACTER_LIMIT + 1 }, (_, index) => ({ name: "角色" + index }),
  );
  tooManyCharacters.servers.regular.accounts.push(account);
  const characterLimit = await put({ revision: 0, data: tooManyCharacters });
  assert.equal(characterLimit.status, 400);
  assert.match((await characterLimit.json()).error, /角色超过/);

  const oversized = await put({ revision: 0, data: { note: "星".repeat(Tracker.BACKUP_LIMIT / 3) } });
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /过大/);

  const writes = await Promise.all([
    put({ revision: 0, data: stateWithProgress("电脑") }),
    put({ revision: 0, data: stateWithProgress("手机") }),
  ]);
  assert.deepEqual(writes.map((response) => response.status).sort(), [200, 409]);
  const [first, second] = await Promise.all(writes.map((response) => response.json()));
  assert.deepEqual(first, second);
  assert.equal(first.revision, 1);
  assert.equal(first.data.dailyDate, "2020-01-01");
  assert.deepEqual(Object.keys(first.data).sort(), ["dailyDate", "dailyResetHour", "servers"]);
  const character = first.data.servers.regular.accounts[0].zones[0].characters[0];
  assert.equal(character.staminaDone, true);
  assert.equal(character.raids[0].doneToday, true);
  assert.equal(character.raids[0].remaining, first.data.servers.regular.maxAttempts);
  assert.deepEqual(await (await service.request("/api/sync/state", { cookie })).json(), first);
});

test("sessions store only hashes and progress persists across restart", async () => {
  const folder = await mkdtemp(join(tmpdir(), "jinghe-sync-test-"));
  const dbPath = join(folder, "test.sqlite");
  let service;
  try {
    service = await listen({ dbPath });
    const cookie = (await logIn(service)).split(";")[0];
    const data = stateWithProgress("自己的账号");
    const saved = await service.request("/api/sync/state", {
      method: "PUT", cookie, headers: { Origin: origin }, data: { revision: 0, data },
    });
    assert.equal(saved.status, 200);
    const expected = await saved.json();
    await service.close();
    service = null;

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const { token_hash: hash } = db.prepare("SELECT token_hash FROM sync_sessions").get();
      assert.match(hash, /^[a-f0-9]{64}$/);
      assert.notEqual(hash, cookie.split("=")[1]);
    } finally {
      db.close();
    }
    service = await listen({ dbPath });
    assert.deepEqual(await (await service.request("/api/sync/state", { cookie })).json(), expected);
    await service.close();
    service = null;
    service = await listen({ dbPath, password: "不同的同步密码" });
    assert.equal((await service.request("/api/sync/state", { cookie })).status, 401);
  } finally {
    if (service) await service.close();
    for (const suffix of ["-wal", "-shm", ""]) await rm(dbPath + suffix, { force: true });
    await rmdir(folder);
  }
});

test("login attempts are limited using only a configured proxy address", async (t) => {
  const localOrigin = "http://127.0.0.1:8765";
  const service = await listen({ origin: localOrigin });
  t.after(() => service.close());
  const request = (address) => service.request("/api/sync/login", {
    method: "POST",
    headers: { Origin: localOrigin, "X-Forwarded-For": address },
    data: { password: "wrong" },
  });
  for (let i = 1; i <= 8; i += 1) assert.equal((await request("192.0.2." + i)).status, 401);
  const limited = await request("192.0.2.9");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);

  const proxied = await listen({ origin: localOrigin, trustProxy: true });
  t.after(() => proxied.close());
  for (let i = 0; i < 9; i += 1) {
    const response = await proxied.request("/api/sync/login", {
      method: "POST",
      headers: { Origin: localOrigin, "X-Forwarded-For": "192.0.2.1" },
      data: { password: "wrong" },
    });
    assert.equal(response.status, i === 8 ? 429 : 401);
  }
  const localCookie = await logIn(proxied, { Origin: localOrigin, "X-Forwarded-For": "192.0.2.2" });
  assert.match(localCookie, /^jinghe_sync=/);
  assert.doesNotMatch(localCookie, /; Secure/);
});

test("the static allowlist serves site assets and denies private files", async (t) => {
  const service = await listen();
  t.after(() => service.close());
  for (const path of ["/", "/tracker.js?cache=1", "/assets/app-icon.png", "/ocr/worker.min.js"]) {
    const response = await service.request(path, { method: "HEAD" });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  const stylesheet = await service.request("/assets/fonts/fonts.css");
  assert.equal(stylesheet.status, 200);
  const fontUrls = (await stylesheet.text()).matchAll(/url\(["']?(?:\.\/)?([\w-]+\.woff2\?v=[a-f0-9]{12})/g);
  const fontFiles = new Set(Array.from(fontUrls, (match) => match[1]));
  assert.equal(fontFiles.size, 7);
  for (const file of fontFiles) {
    const response = await service.request("/assets/fonts/" + file, { method: "HEAD" });
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get("content-type"), "font/woff2");
    assert.match(response.headers.get("cache-control"), /immutable/);
    assert.ok(Number(response.headers.get("content-length")) > 0);
  }
  for (const path of ["/server.js", "/.env", "/data/jinghe.sqlite", "/%2e%2e/.env"]) {
    assert.equal((await service.request(path)).status, 404, path);
  }
});
