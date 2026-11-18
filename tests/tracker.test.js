const assert = require("assert");
const Tracker = require("../tracker");

function character(server, accountName, characterName, zoneName = Tracker.DEFAULT_ZONE_NAME) {
  const account = server.accounts.find(function find(item) {
    return item.name === accountName;
  });
  assert.ok(account, "missing account " + accountName);
  const zone = account.zones.find((item) => item.name === zoneName);
  assert.ok(zone, "missing zone " + zoneName);
  const found = zone.characters.find(function find(item) {
    return item.name === characterName;
  });
  assert.ok(found, "missing character " + characterName);
  return found;
}

function testDefaults() {
  const app = Tracker.createAppState();
  assert.strictEqual(app.activeServer, "regular");
  assert.strictEqual(Tracker.normalizeAppState({}).activeServer, "regular");
  assert.strictEqual(Tracker.normalizeAppState({ activeServer: "season" }).activeServer, "season");
  assert.deepStrictEqual(app.servers.season.activeRaids, ["国王", "女皇"]);
  assert.strictEqual(app.servers.season.maxAttempts, 5);
  assert.deepStrictEqual(app.servers.regular.activeRaids, [
    "魔棋战局",
    "失落遗迹",
    "天启降临",
    "沙影黑巢",
  ]);
  assert.strictEqual(app.servers.regular.maxAttempts, 3);
  assert.notStrictEqual(app.servers.season, app.servers.regular);
}

function testRaidRules() {
  const season = Tracker.createServerState("season");
  const swapped = Tracker.moveActiveRaid(season, 0, "女皇");
  assert.deepStrictEqual(swapped.activeRaids, ["女皇", "国王"]);

  const duplicated = Tracker.moveActiveRaid(swapped, 1, "女皇");
  assert.deepStrictEqual(duplicated.activeRaids, ["国王", "女皇"]);

  const regular = Tracker.createServerState("regular");
  const added = Tracker.toggleActiveRaid(regular, "禁忌之心");
  assert.strictEqual(added.changed, true);
  assert.ok(added.server.activeRaids.includes("禁忌之心"));
  assert.deepStrictEqual(
    added.server.activeRaids,
    Tracker.getServerDef("regular").raids.map(function name(raid) {
      return raid.name;
    }).filter(function selected(name) {
      return added.server.activeRaids.includes(name);
    }),
  );

  let only = Tracker.normalizeServerState("regular", {
    activeRaids: ["魔棋战局"],
    accounts: [],
  });
  const refused = Tracker.toggleActiveRaid(only, "魔棋战局");
  assert.strictEqual(refused.changed, false);
  assert.deepStrictEqual(refused.server.activeRaids, ["魔棋战局"]);
}

function testAttemptsAndNormalize() {
  const server = Tracker.normalizeServerState("season", {
    maxAttempts: 5,
    activeRaids: ["国王", "女皇"],
    accounts: [
      {
        id: "a1",
        name: " 主号 ",
        characters: [
          {
            id: "c1",
            name: "艾尔莎",
            staminaDone: true,
            raids: [
              { name: "国王", remaining: 9, doneToday: true },
              { name: "遗迹", remaining: 4, doneToday: false },
            ],
          },
        ],
      },
    ],
  });
  const person = character(server, "主号", "艾尔莎");
  assert.strictEqual(person.staminaDone, true);
  assert.strictEqual(person.raids[0].remaining, 5);
  assert.strictEqual(person.raids[0].doneToday, true);
  assert.strictEqual(person.raids[1].name, "女皇");
  assert.strictEqual(person.raids[1].remaining, 5);

  const lowered = Tracker.setMaxAttempts(server, 2);
  assert.strictEqual(character(lowered, "主号", "艾尔莎").raids[0].remaining, 2);

  const raised = Tracker.setMaxAttempts(lowered, 5);
  assert.strictEqual(character(raised, "主号", "艾尔莎").raids[0].remaining, 2);

  const restored = Tracker.resetRaidCycle(raised);
  const restoredPerson = character(restored, "主号", "艾尔莎");
  assert.strictEqual(restoredPerson.raids[0].remaining, 5);
  assert.strictEqual(restoredPerson.raids[0].doneToday, false);
  assert.strictEqual(restoredPerson.staminaDone, true);
}

function testDailyResetKeepsBothServers() {
  const app = Tracker.createAppState();
  app.dailyDate = "2026-11-14";
  app.dailyResetHour = 6;
  app.servers.season.accounts.push(Tracker.createAccount("赛季号"));
  app.servers.season.accounts[0].zones[0].characters.push(
    Tracker.createCharacter("角色1", app.servers.season.activeRaids, 5),
  );
  app.servers.regular.accounts.push(Tracker.createAccount("常规号"));
  app.servers.regular.accounts[0].zones[0].characters.push(
    Tracker.createCharacter("角色2", ["魔棋战局"], 3),
  );
  app.servers.season.accounts[0].zones[0].characters[0].staminaDone = true;
  app.servers.season.accounts[0].zones[0].characters[0].raids[0].remaining = 4;
  app.servers.season.accounts[0].zones[0].characters[0].raids[0].doneToday = true;
  app.servers.regular.accounts[0].zones[0].characters[0].staminaDone = true;
  app.servers.regular.accounts[0].zones[0].characters[0].raids[0].remaining = 1;

  const result = Tracker.ensureDailyReset(app, new Date("2026-11-16T06:05:00+08:00"));
  assert.strictEqual(result.reset, true);
  assert.strictEqual(result.state.dailyDate, "2026-11-16");
  assert.strictEqual(
    result.state.servers.season.accounts[0].zones[0].characters[0].staminaDone,
    false,
  );
  assert.strictEqual(
    result.state.servers.season.accounts[0].zones[0].characters[0].raids[0].doneToday,
    false,
  );
  assert.strictEqual(
    result.state.servers.season.accounts[0].zones[0].characters[0].raids[0].remaining,
    4,
  );
  assert.strictEqual(
    result.state.servers.regular.accounts[0].zones[0].characters[0].staminaDone,
    false,
  );
  assert.strictEqual(
    result.state.servers.regular.accounts[0].zones[0].characters[0].raids[0].remaining,
    1,
  );
  assert.strictEqual(result.state.servers.regular.activeRaids[0], "魔棋战局");

  const sameDay = Tracker.ensureDailyReset(result.state, new Date("2026-11-16T23:00:00+08:00"));
  assert.strictEqual(sameDay.reset, false);

  const beforeSix = Tracker.dailyCycleKey(new Date("2026-11-16T05:59:00+08:00"));
  assert.strictEqual(beforeSix, "2026-11-15");
}

function testShanghaiDailyBoundary() {
  assert.strictEqual(Tracker.dailyCycleKey(new Date("2026-12-31T21:59:59Z")), "2026-12-31");
  assert.strictEqual(Tracker.dailyCycleKey(new Date("2026-12-31T22:00:00Z")), "2027-01-01");
}

function testLegacyResetDoesNotDoubleClear() {
  const app = Tracker.createAppState();
  app.dailyResetHour = 0;
  app.dailyDate = "2026-11-16";
  app.servers.season.accounts.push(Tracker.createAccount("赛季号"));
  app.servers.season.accounts[0].zones[0].characters.push(
    Tracker.createCharacter("角色1", ["国王", "女皇"], 5),
  );
  app.servers.season.accounts[0].zones[0].characters[0].staminaDone = true;
  const result = Tracker.ensureDailyReset(app, new Date("2026-11-16T05:30:00+08:00"));
  assert.strictEqual(result.reset, false);
  assert.strictEqual(result.state.dailyDate, "2026-11-15");
  assert.strictEqual(
    result.state.servers.season.accounts[0].zones[0].characters[0].staminaDone,
    true,
  );
}

function testSummary() {
  const server = Tracker.createServerState("season");
  server.accounts.push(Tracker.createAccount("主号"));
  server.accounts[0].zones[0].characters.push(
    Tracker.createCharacter("一号", server.activeRaids, server.maxAttempts),
    Tracker.createCharacter("二号", server.activeRaids, server.maxAttempts),
  );
  server.accounts[0].zones[0].characters[0].staminaDone = true;
  server.accounts[0].zones[0].characters[0].raids[0].doneToday = true;
  server.accounts[0].zones[0].characters[0].raids[0].remaining = 4;
  const summary = Tracker.summarize(server);
  assert.strictEqual(summary.characterCount, 2);
  assert.strictEqual(summary.staminaPending, 1);
  assert.strictEqual(summary.raidsPending, 3);
  assert.strictEqual(summary.raids[0].doneToday, 1);
  assert.strictEqual(summary.raids[0].remaining, 9);
}

function testPlatformBackupRoundTrip() {
  const app = Tracker.createAppState();
  app.servers.regular.accounts.push(Tracker.createAccount("常规主号"));
  app.servers.season.accounts.push(Tracker.createAccount("赛季主号"));
  const backup = Tracker.formatBackup(app, "compact");
  const parsed = Tracker.parseBackupText(JSON.stringify(backup));
  assert.strictEqual(parsed.mode, "platform");
  assert.strictEqual(parsed.counts.regular.accounts, 1);
  assert.strictEqual(parsed.counts.season.accounts, 1);
  assert.strictEqual(parsed.layoutMode, "compact");
  const replaced = Tracker.replaceBackup(Tracker.createAppState(), parsed);
  assert.strictEqual(replaced.servers.regular.accounts[0].name, "常规主号");
  assert.strictEqual(replaced.servers.season.accounts[0].name, "赛季主号");
}

function testLegacyImportKeepsRegular() {
  const current = Tracker.createAppState();
  current.servers.regular.accounts.push(Tracker.createAccount("常规主号"));
  current.servers.season.activeRaids = ["国王", "天启"];
  current.servers.season.accounts.push(Tracker.createAccount("赛季主号"));
  current.servers.season.accounts[0].zones[0].characters.push(
    Tracker.createCharacter("旧角色", ["国王", "天启"], 5),
  );

  const legacy = {
    format: "season-growth-helper-backup",
    version: 1,
    data: {
      dailyDate: "2026-11-16",
      dailyResetHour: 6,
      tracker: {
        activeRaids: ["女皇", "遗迹"],
        accounts: [
          {
            id: "old-account",
            name: "赛季主号",
            characters: [
              {
                id: "old-character",
                name: "新角色",
                staminaDone: false,
                raids: [
                  { name: "女皇", remaining: 2, doneToday: false },
                  { name: "遗迹", remaining: 5, doneToday: true },
                ],
              },
            ],
          },
          {
            name: "赛季小号",
            characters: [],
          },
        ],
      },
    },
  };
  const parsed = Tracker.parseBackupText(JSON.stringify(legacy));
  assert.strictEqual(parsed.mode, "legacy-season");

  const merged = Tracker.mergeBackup(current, parsed);
  assert.strictEqual(merged.addedAccounts, 1);
  assert.strictEqual(merged.addedCharacters, 1);
  assert.deepStrictEqual(merged.app.servers.season.activeRaids, ["国王", "天启"]);
  assert.strictEqual(merged.app.servers.season.accounts.length, 2);
  assert.strictEqual(merged.app.servers.regular.accounts[0].name, "常规主号");
  assert.strictEqual(
    character(merged.app.servers.season, "赛季主号", "新角色").raids[0].name,
    "国王",
  );

  const replaced = Tracker.replaceBackup(current, parsed);
  assert.deepStrictEqual(replaced.servers.season.activeRaids, ["女皇", "遗迹"]);
  assert.strictEqual(
    character(replaced.servers.season, "赛季主号", "新角色").raids[0].remaining,
    2,
  );
  assert.strictEqual(replaced.servers.regular.accounts[0].name, "常规主号");
  assert.strictEqual(replaced.dailyDate, "2026-11-16");
}

function testMaximumSizeBackupRoundTrip() {
  const app = Tracker.createAppState();
  const regular = app.servers.regular;
  const season = app.servers.season;
  regular.activeRaids = Tracker.getServerDef("regular").raids.map((raid) => raid.name);

  for (const server of [regular, season]) {
    const account = Tracker.createAccount("账号");
    for (let index = 0; index < Tracker.CHARACTER_LIMIT; index += 1) {
      const name = "晶".repeat(30) + index;
      account.zones[0].characters.push(Tracker.createCharacter(name, server.activeRaids, server.maxAttempts));
    }
    server.accounts.push(account);
  }

  const backup = JSON.stringify(Tracker.formatBackup(app));
  assert.ok(backup.length > 500000);
  const restored = Tracker.parseBackupText(backup);
  assert.strictEqual(restored.characterCount, Tracker.CHARACTER_LIMIT * 2);
  assert.strictEqual(restored.app.servers.regular.activeRaids.length, regular.activeRaids.length);
}

function testOldAccountMigrationAndRepair() {
  const raw = { accounts: [
    { id: "shared-account", name: "旧账号", characters: [
      { id: "shared-character", name: "原角色", raids: [{ name: "魔棋战局", remaining: 1 }] },
      { id: "shared-character", name: "重复ID角色" },
    ] },
    { id: "shared-account", name: "空账号", zones: [], characters: [{ name: "不要重新迁移" }] },
    { id: "areas", name: "已有区服", zones: [{ id: "shared-zone" }, { id: "shared-zone" }] },
  ] };
  const server = Tracker.normalizeServerState("regular", raw);
  const repeated = Tracker.normalizeServerState("regular", raw);
  const [original, empty, zoned] = server.accounts;
  assert.notStrictEqual(original.id, empty.id);
  assert.deepStrictEqual(empty.zones, []);
  assert.ok(!Object.hasOwn(original, "characters"));
  assert.strictEqual(original.zones[0].name, Tracker.DEFAULT_ZONE_NAME);
  assert.strictEqual(original.zones[0].id, repeated.accounts[0].zones[0].id);
  assert.notStrictEqual(original.zones[0].characters[0].id, original.zones[0].characters[1].id);
  assert.notStrictEqual(zoned.zones[0].id, zoned.zones[1].id);
  assert.strictEqual(character(server, "旧账号", "原角色").raids[0].remaining, 1);
}

function testDailyAndRaidRulesAcrossZones() {
  const app = Tracker.createAppState();
  app.dailyDate = "2026-11-15";
  const server = app.servers.regular;
  const account = Tracker.createAccount("主号");
  account.zones.push(Tracker.createZone("新区"));
  server.accounts.push(account);
  for (const zone of account.zones) {
    const character = Tracker.createCharacter("同名角色", server.activeRaids, server.maxAttempts);
    character.staminaDone = true;
    character.raids[0].doneToday = true;
    character.raids[0].remaining = 2;
    zone.characters.push(character);
  }
  const summary = Tracker.summarize(server);
  assert.strictEqual(summary.accountCount, 1);
  assert.strictEqual(summary.zoneCount, 2);
  assert.strictEqual(summary.characterCount, 2);
  assert.strictEqual(summary.staminaDone, 2);
  assert.strictEqual(summary.raidsDoneToday, 2);
  const { state, reset } = Tracker.ensureDailyReset(app, new Date("2026-11-16T06:00:00+08:00"));
  assert.strictEqual(reset, true);
  for (const zone of state.servers.regular.accounts[0].zones) {
    assert.strictEqual(zone.characters[0].staminaDone, false);
    assert.strictEqual(zone.characters[0].raids[0].doneToday, false);
    assert.strictEqual(zone.characters[0].raids[0].remaining, 2);
  }
  const limited = Tracker.setMaxAttempts(server, 1);
  const restored = Tracker.resetRaidCycle(server);
  const catalog = Tracker.toggleActiveRaid(server, "禁忌之心");
  assert.strictEqual(catalog.changed, true);
  for (let index = 0; index < account.zones.length; index += 1) {
    assert.strictEqual(limited.accounts[0].zones[index].characters[0].raids[0].remaining, 1);
    assert.strictEqual(restored.accounts[0].zones[index].characters[0].raids[0].remaining, 3);
    assert.strictEqual(restored.accounts[0].zones[index].characters[0].staminaDone, true);
    assert.ok(catalog.server.accounts[0].zones[index].characters[0].raids.some((raid) => raid.name === "禁忌之心"));
  }
}

function testVersionOneBackupMigration() {
  const current = Tracker.createAppState();
  const account = Tracker.createAccount("同名账号");
  account.zones[0].name = "当前区";
  account.zones[0].characters.push(Tracker.createCharacter("现有角色", current.servers.regular.activeRaids, 3));
  current.servers.regular.accounts.push(account);
  const legacy = {
    format: "jinghe-record-backup",
    version: 1,
    data: { servers: {
      regular: { accounts: [{ name: "同名账号", characters: [{ name: "旧角色" }] }] },
    } },
  };
  const parsed = Tracker.parseBackupText(JSON.stringify(legacy));
  const merged = Tracker.mergeBackup(current, parsed);
  assert.strictEqual(merged.addedAccounts, 0);
  assert.strictEqual(merged.addedZones, 1);
  assert.strictEqual(merged.addedCharacters, 1);
  assert.deepStrictEqual(merged.app.servers.regular.accounts[0].zones.map((zone) => zone.name),
    ["当前区", Tracker.DEFAULT_ZONE_NAME]);
  assert.ok(character(merged.app.servers.regular, "同名账号", "旧角色"));
  assert.ok(character(merged.app.servers.regular, "同名账号", "现有角色", "当前区"));
  const replaced = Tracker.replaceBackup(current, parsed);
  assert.strictEqual(replaced.servers.regular.accounts[0].zones.length, 1);
  assert.ok(character(replaced.servers.regular, "同名账号", "旧角色"));
}

function testVersionTwoBackupMergeAndReplace() {
  const current = Tracker.createAppState();
  const incoming = Tracker.createAppState();
  const target = Tracker.createAccount("主号");
  const imported = Tracker.createAccount("主号");
  target.zones[0] = { id: "same-zone", name: "旧区名", characters: [{ id: "cz", name: "保留", staminaDone: true }] };
  target.zones.push({ id: "another-zone", name: "匹配区名", characters: [] });
  imported.zones[0] = { id: "same-zone", name: "匹配区名", characters: [{ id: "cz", name: "保留" }, { name: "按ID新增" }] };
  imported.zones.push({ id: "different-zone", name: "匹配区名", characters: [{ name: "按名称新增" }] });
  imported.zones.push({ id: "new-zone", name: "新分区", characters: [{ name: "按区新增" }] });
  current.servers.regular.accounts.push(target);
  incoming.servers.regular.accounts.push(imported);
  const backup = Tracker.formatBackup(incoming);
  assert.strictEqual(backup.version, 2);
  const parsed = Tracker.parseBackupText(JSON.stringify(backup));
  assert.strictEqual(parsed.zoneCount, 3);
  assert.strictEqual(parsed.characterCount, 4);
  const merged = Tracker.mergeBackup(current, parsed);
  const [idZone, nameZone, newZone] = merged.app.servers.regular.accounts[0].zones;
  assert.strictEqual(merged.addedAccounts, 0);
  assert.strictEqual(merged.addedZones, 1);
  assert.strictEqual(merged.addedCharacters, 3);
  assert.strictEqual(idZone.characters[0].staminaDone, true);
  assert.strictEqual(idZone.characters[1].name, "按ID新增");
  assert.strictEqual(nameZone.characters[0].name, "按名称新增");
  assert.strictEqual(newZone.characters[0].name, "按区新增");
  assert.deepStrictEqual(Tracker.replaceBackup(current, parsed), backup.data);
}

function testConfigurableRaidCatalogAndBackup() {
  const app = Tracker.createAppState();
  const regular = app.servers.regular;
  const account = Tracker.createAccount("主号");
  account.zones.push(Tracker.createZone("二区"));
  for (const [index, zone] of account.zones.entries()) {
    zone.characters.push(Tracker.createCharacter("角色" + index, regular.activeRaids, regular.maxAttempts));
  }
  regular.accounts.push(account);

  const added = Tracker.addRaid(regular, "  新副本  ");
  assert.strictEqual(added.changed, true);
  assert.ok(Tracker.getRaidCatalog(added.server).some((raid) => raid.name === "新副本"));
  assert.ok(!added.server.activeRaids.includes("新副本"));
  assert.strictEqual(Tracker.addRaid(added.server, "新副本").changed, false);
  const active = Tracker.toggleActiveRaid(added.server, "新副本").server;
  for (const [index, zone] of active.accounts[0].zones.entries()) {
    const raid = zone.characters[0].raids.find((item) => item.name === "新副本");
    raid.remaining = index;
    raid.doneToday = true;
  }
  const renamed = Tracker.renameRaid(active, "新副本", "远星门").server;
  assert.ok(renamed.activeRaids.includes("远星门"));
  assert.deepStrictEqual(renamed.accounts[0].zones.map((zone) =>
    zone.characters[0].raids.find((item) => item.name === "远星门")), [
    { name: "远星门", remaining: 0, doneToday: true },
    { name: "远星门", remaining: 1, doneToday: true },
  ]);

  app.servers.regular = renamed;
  const parsed = Tracker.parseBackupText(JSON.stringify(Tracker.formatBackup(app)));
  const restored = Tracker.replaceBackup(Tracker.createAppState(), parsed);
  assert.deepStrictEqual(restored.servers.regular, renamed);
  assert.ok(!Tracker.getRaidCatalog(restored.servers.season).some((raid) => raid.name === "远星门"));

  const merged = Tracker.mergeBackup(Tracker.createAppState(), parsed).app.servers.regular;
  assert.ok(Tracker.getRaidCatalog(merged).some((raid) => raid.name === "远星门"));
  assert.ok(!merged.activeRaids.includes("远星门"));

  const removed = Tracker.removeRaid(restored.servers.regular, "远星门").server;
  assert.ok(!Tracker.getRaidCatalog(removed).some((raid) => raid.name === "远星门"));
  assert.ok(removed.accounts[0].zones.every((zone) =>
    zone.characters[0].raids.every((raid) => raid.name !== "远星门")));
}

function testConfigurableRaidMode() {
  const app = Tracker.createAppState();
  const season = app.servers.season;
  assert.strictEqual(Tracker.getRaidMode(season), "pair");
  const multi = Tracker.setRaidMode(season, "multi").server;
  assert.deepStrictEqual(multi.activeRaids, season.activeRaids);
  const three = Tracker.toggleActiveRaid(multi, "遗迹").server;
  assert.strictEqual(three.activeRaids.length, 3);
  app.servers.season = three;

  const parsed = Tracker.parseBackupText(JSON.stringify(Tracker.formatBackup(app)));
  const restored = Tracker.replaceBackup(Tracker.createAppState(), parsed).servers.season;
  assert.strictEqual(Tracker.getRaidMode(restored), "multi");
  assert.deepStrictEqual(restored.activeRaids, three.activeRaids);

  const pair = Tracker.setRaidMode(restored, "pair").server;
  assert.strictEqual(pair.activeRaids.length, 2);
  assert.strictEqual(Tracker.getRaidMode(pair), "pair");
  const reducedCatalog = Tracker.removeRaid(pair, pair.activeRaids[0]).server;
  assert.strictEqual(reducedCatalog.activeRaids.length, 2);
  assert.ok(reducedCatalog.activeRaids.every((name) => Tracker.getRaidCatalog(reducedCatalog).some((entry) => entry.name === name)));
}

function testParseRosterText() {
  const rows = Tracker.parseRosterText([
    "",
    "００７ | 等级：７０ | 战力：２３．５萬",
    "00123",
    "机甲/勇士",
    "常玩 / 二区 / 法师 | 战力:123,456.7",
    "备用\t新区\t枪手 | 等级:42",
    "新号 |  | 治疗",
    "账号：小号",
    "区服：西区",
    "角色名：智者 | 等级:80",
    "格斗",
  ].join("\r\n"), { account: "主号", zone: "一区" });
  assert.deepStrictEqual(rows, [
    { account: "主号", zone: "一区", character: "００７", level: 70, power: "23.5万" },
    { account: "主号", zone: "一区", character: "00123" },
    { account: "主号", zone: "一区", character: "机甲/勇士" },
    { account: "常玩", zone: "二区", character: "法师", power: "123,456.7" },
    { account: "备用", zone: "新区", character: "枪手", level: 42 },
    { account: "新号", zone: "一区", character: "治疗" },
    { account: "小号", zone: "西区", character: "智者", level: 80 },
    { account: "小号", zone: "西区", character: "格斗" },
  ]);
  assert.deepStrictEqual(Tracker.parseRosterText("账号 /  / 角色"), [
    { account: "账号", zone: Tracker.DEFAULT_ZONE_NAME, character: "角色" },
  ]);
  assert.deepStrictEqual(Tracker.parseRosterText("\r\n "), []);
  assert.throws(() => Tracker.parseRosterText("\n\n角色一"), /第 3 行：缺少账号/);
  assert.throws(() => Tracker.parseRosterText("主号|一区|"), /缺少角色/);
  assert.throws(() => Tracker.parseRosterText("主号|角色"), /三列/);
  assert.throws(() => Tracker.parseRosterText("角".repeat(41), { account: "主号" }), /40 个字符/);
  assert.throws(() => Tracker.parseRosterText("角色一 | 等级:0", { account: "主号" }), /大于等于 1 的整数/);
  assert.throws(() => Tracker.parseRosterText("角色一 | 战力:12,34", { account: "主号" }), /战力格式无效/);
  assert.throws(() => Tracker.parseRosterText("角色一 | 等级:70 | 等级:71", { account: "主号" }), /只能填写一次/);
}

function testImportRosterAndProfileRoundTrip() {
  const app = Tracker.createAppState();
  const server = app.servers.regular;
  const account = Tracker.createAccount("MAIN");
  const person = Tracker.createCharacter("Hero", server.activeRaids, server.maxAttempts);
  Object.assign(person, { level: 65, power: "23万", staminaDone: true });
  Object.assign(person.raids[0], { remaining: 1, doneToday: true });
  account.zones[0].characters.push(person);
  server.accounts.push(account);
  const original = JSON.stringify(server);
  const rows = Tracker.parseRosterText([
    " main | 默认区 | hero | 等级:70",
    "main | 默认区 | Hero | 等级:70",
    "main | 默认区 | 0003 | 战力:1.25亿",
    "main | 二区 | HERO | 等级:20",
    "小号 | 大区 | 777",
  ].join("\n"));
  const result = Tracker.importRoster(server, rows);
  assert.strictEqual(JSON.stringify(server), original);
  assert.strictEqual(result.addedAccounts, 1);
  assert.strictEqual(result.addedZones, 2);
  assert.strictEqual(result.addedCharacters, 3);
  assert.strictEqual(result.updatedCharacters, 1);
  assert.strictEqual(result.skippedCharacters, 1);

  const changed = character(result.server, "MAIN", "Hero");
  assert.strictEqual(changed.id, person.id);
  assert.strictEqual(changed.staminaDone, true);
  assert.strictEqual(changed.raids[0].remaining, 1);
  assert.strictEqual(changed.raids[0].doneToday, true);
  assert.strictEqual(changed.level, 70);
  assert.strictEqual(changed.power, "23万");
  assert.strictEqual(character(result.server, "MAIN", "0003").power, "1.25亿");
  assert.strictEqual(character(result.server, "MAIN", "HERO", "二区").level, 20);
  assert.deepStrictEqual(result.server.accounts[1].zones.map((zone) => zone.name), ["大区"]);
  assert.strictEqual(character(result.server, "小号", "777", "大区").raids[0].remaining, server.maxAttempts);

  app.servers.regular = result.server;
  const backup = Tracker.parseBackupText(JSON.stringify(Tracker.formatBackup(app)));
  const fromBackup = character(backup.app.servers.regular, "MAIN", "Hero");
  assert.strictEqual(fromBackup.level, 70);
  assert.strictEqual(fromBackup.power, "23万");
  assert.strictEqual(fromBackup.raids[0].remaining, 1);
}

function testRosterImportAmbiguousOrFullTargets() {
  const server = Tracker.createServerState("season");
  server.accounts.push(Tracker.createAccount("已存在"), Tracker.createAccount("已存在"));
  const snapshot = JSON.stringify(server);
  assert.throws(() => Tracker.importRoster(server, [
    { account: "新增", character: "新人" },
    { account: "已存在", character: "待导入" },
  ]), /多个同名账号/);
  assert.strictEqual(JSON.stringify(server), snapshot);

  server.accounts.pop();
  server.accounts[0].zones.push(Tracker.createZone(Tracker.DEFAULT_ZONE_NAME));
  assert.throws(() => Tracker.importRoster(server, [
    { account: "已存在", character: "待导入" },
  ]), /多个同名区服/);

  const full = Tracker.createServerState("regular");
  for (let index = 1; index <= Tracker.ACCOUNT_LIMIT; index += 1) {
    full.accounts.push(Tracker.createAccount("账号" + index));
  }
  assert.throws(() => Tracker.importRoster(full, [
    { account: "新账号", character: "新增" },
  ]), /账号超过/);

  const zone = full.accounts[0].zones[0];
  for (let index = 1; index <= Tracker.CHARACTER_LIMIT; index += 1) {
    zone.characters.push(Tracker.createCharacter("角色" + index, full.activeRaids, full.maxAttempts));
  }
  assert.throws(() => Tracker.importRoster(full, [
    { account: full.accounts[0].name, character: "新增" },
  ]), /角色超过/);
  const noChanges = Tracker.importRoster(full, [
    { account: full.accounts[0].name, character: "角色1" },
  ]);
  assert.strictEqual(noChanges.skippedCharacters, 1);
}

function testRaidCountTextAndConflict() {
  const defaults = { account: "主号", zone: "西区" };
  const rows = Tracker.parseRaidCountText([
    "机术士 | 魔棋战局 | 3/5",
    "",
    "主号｜西区｜机术士｜魔棋战局｜３ ／ ５",
    "主号\t北区\t机术士\t魔棋战局\t4/5",
    "小号 | 西区 | 机术士 | 魔棋战局 | 2/5",
  ].join("\r\n"), defaults);
  assert.deepStrictEqual(rows, [
    { ...defaults, character: "机术士", raid: "魔棋战局", reading: "3/5", numerator: 3, denominator: 5 },
    { account: "主号", zone: "北区", character: "机术士", raid: "魔棋战局", reading: "4/5", numerator: 4, denominator: 5 },
    { account: "小号", zone: "西区", character: "机术士", raid: "魔棋战局", reading: "2/5", numerator: 2, denominator: 5 },
  ]);
  assert.throws(() => Tracker.parseRaidCountText("角色 | 团本 | 3/5"), /第 1 行.*缺少账号/);
  assert.throws(() => Tracker.parseRaidCountText("角色 | 团本 | 3/", defaults), /填写成 3\/5/);
  assert.throws(() => Tracker.parseRaidCountText("角色 | 团本 | 4/3", defaults), /次数必须/);
  assert.throws(() => Tracker.parseRaidCountText("角色 | 团本 | 1/3\n角色 | 团本 | 2/3", defaults),
    /第 2 行.*次数冲突.*1\/3.*2\/3/);
}

function testRaidCountImportPerCharacterCaps() {
  const server = Tracker.createServerState("regular");
  const account = Tracker.createAccount("主号");
  account.zones[0].name = "西区";
  account.zones.push(Tracker.createZone("北区"));
  for (const zone of account.zones) {
    zone.characters.push(Tracker.createCharacter("机术士", server.activeRaids, server.maxAttempts));
  }
  server.accounts.push(account);
  Object.assign(account.zones[0].characters[0].raids[0], { remaining: 2, doneToday: true });
  const initial = JSON.stringify(server);
  const rows = Tracker.parseRaidCountText([
    "主号 | 西区 | 机术士 | 魔棋战局 | 3/5",
    "主号 | 北区 | 机术士 | 魔棋战局 | 4/12",
    "主号 | 西区 | 机术士 | 自定义团本 | 1/6",
  ].join("\n"));
  const remaining = Tracker.importRaidCounts(server, rows, "remaining");
  const used = Tracker.importRaidCounts(server, rows, "used");
  assert.strictEqual(JSON.stringify(server), initial);
  assert.strictEqual(used.server.maxAttempts, server.maxAttempts);
  assert.strictEqual(used.updatedRaids, 3);
  assert.deepStrictEqual(used.enabledRaids, ["自定义团本"]);
  assert.ok(Tracker.getRaidCatalog(used.server).some((raid) => raid.name === "自定义团本"));

  const west = character(used.server, "主号", "机术士", "西区");
  const north = character(used.server, "主号", "机术士", "北区");
  assert.deepStrictEqual(west.raids[0], { name: "魔棋战局", remaining: 2, doneToday: true, maxAttempts: 5, quotaCharge: 0 });
  assert.deepStrictEqual(north.raids[0], { name: "魔棋战局", remaining: 8, doneToday: false, maxAttempts: 12 });
  assert.strictEqual(Tracker.raidLimit(used.server, north.raids[0]), 12);
  assert.strictEqual(Tracker.raidLimit(used.server.maxAttempts, north.raids[1]), 3);
  assert.strictEqual(west.raids.find((raid) => raid.name === "自定义团本").remaining, 5);
  assert.strictEqual(north.raids.find((raid) => raid.name === "自定义团本").remaining, 3);
  assert.deepStrictEqual(character(remaining.server, "主号", "机术士", "西区").raids[0],
    { name: "魔棋战局", remaining: 3, doneToday: true, maxAttempts: 5, quotaCharge: 0 });
  assert.strictEqual(Tracker.importRaidCounts(used.server, rows, "used").updatedRaids, 0);

  const limited = Tracker.setMaxAttempts(used.server, 1);
  assert.strictEqual(character(limited, "主号", "机术士", "北区").raids[0].remaining, 8);
  assert.strictEqual(character(limited, "主号", "机术士", "北区").raids[1].remaining, 1);
  const restored = Tracker.resetRaidCycle(limited);
  assert.strictEqual(character(restored, "主号", "机术士", "北区").raids[0].remaining, 12);
  assert.strictEqual(character(restored, "主号", "机术士", "北区").raids[1].remaining, 1);

  const app = Tracker.createAppState();
  app.servers.regular = used.server;
  const backup = Tracker.parseBackupText(JSON.stringify(Tracker.formatBackup(app)));
  assert.deepStrictEqual(backup.app.servers.regular, used.server);
  const rollover = Tracker.ensureDailyReset(backup.app, new Date("2026-11-16T06:01:00+08:00"));
  const dailyRaid = character(rollover.state.servers.regular, "主号", "机术士", "西区").raids[0];
  assert.strictEqual(dailyRaid.maxAttempts, 5);
  assert.strictEqual(dailyRaid.remaining, 2);
  assert.strictEqual(dailyRaid.doneToday, false);
}

function testRaidCountImportIsAtomicAndRequiredScope() {
  const pair = Tracker.createServerState("season");
  const account = Tracker.createAccount("主号");
  account.zones[0].characters.push(Tracker.createCharacter("机术士", pair.activeRaids, pair.maxAttempts));
  pair.accounts.push(account);
  const first = "主号 | 默认区 | 机术士 | 国王 | 2/6";
  const initial = JSON.stringify(pair);
  assert.throws(() => Tracker.importRaidCounts(pair, Tracker.parseRaidCountText(first), ""), /请先选择/);
  assert.throws(() => Tracker.importRaidCounts(pair, Tracker.parseRaidCountText([
    first, "主号 | 默认区 | 机术士 | 未知团本 | 3/5",
  ].join("\n")), "remaining"), /加入目录.*轮换团本.*多选模式/);
  assert.throws(() => Tracker.importRaidCounts(pair, Tracker.parseRaidCountText([
    first, "主号 | 默认区 | 机术士 | 遗迹 | 3/5",
  ].join("\n")), "remaining"), /请先选为轮换团本.*多选模式/);
  assert.throws(() => Tracker.importRaidCounts(pair, Tracker.parseRaidCountText([
    first, "主号 | 其他区 | 机术士 | 国王 | 2/6",
  ].join("\n")), "remaining"), /找不到区服/);
  assert.throws(() => Tracker.importRaidCounts(pair, Tracker.parseRaidCountText([
    first, "主号 | 默认区 | 其他角色 | 国王 | 2/6",
  ].join("\n")), "remaining"), /找不到角色/);
  const firstRows = Tracker.parseRaidCountText(first);
  assert.throws(() => Tracker.importRaidCounts(pair, [
    ...firstRows, { ...firstRows[0], reading: "3/6" },
  ], "remaining"), /次数冲突.*2\/6.*3\/6/);
  assert.strictEqual(JSON.stringify(pair), initial);
  account.zones[0].characters.push(Tracker.createCharacter("机术士", pair.activeRaids, pair.maxAttempts));
  assert.throws(() => Tracker.importRaidCounts(pair, Tracker.parseRaidCountText(first), "remaining"), /多个同名角色/);
}

function testRejectsBadBackup() {
  assert.throws(function () {
    Tracker.parseBackupText("");
  }, /没有备份内容/);
  assert.throws(function () {
    Tracker.parseBackupText("hello");
  }, /不是有效的备份/);
  assert.throws(function () {
    Tracker.parseBackupText(JSON.stringify({ format: "jinghe-record-backup", version: 3, data: {} }));
  }, /备份版本/);
}

function testRegularSharedRaidQuotas() {
  const server = Tracker.createServerState("regular");
  const legacy = Tracker.createAccount("历史账号");
  legacy.zones.push(Tracker.createZone("二区"));
  for (const zone of legacy.zones) {
    zone.characters.push(Tracker.createCharacter("测试角色", server.activeRaids, server.maxAttempts));
  }
  server.accounts.push(legacy);
  const normalized = Tracker.normalizeServerState("regular", server);
  const account = normalized.accounts[0];
  const [first, second] = account.zones.map((zone) => zone.characters[0].raids[0]);
  const name = first.name;
  assert.deepStrictEqual(Tracker.getAccountRaidQuota(account), { remaining: 180, maxAttempts: 180 });
  assert.strictEqual(Tracker.getAccountRaidQuota(account, name), null);
  assert.strictEqual(Tracker.setAccountRaidQuota(account, name, { remaining: 1, maxAttempts: 15 }), true);

  const operation = Tracker.applyRaidCompletion(normalized, account, first, true);
  assert.ok(operation);
  assert.strictEqual(Tracker.getAccountRaidQuota(account).remaining, 179);
  assert.strictEqual(Tracker.getAccountRaidQuota(account, name).remaining, 0);
  assert.strictEqual(Tracker.canCompleteRaid(account, second), false);
  assert.strictEqual(Tracker.applyRaidCompletion(normalized, account, second, true), null);
  assert.strictEqual(Tracker.undoRaidCompletion(normalized, account, first, operation), true);
  assert.strictEqual(Tracker.getAccountRaidQuota(account).remaining, 180);
  assert.strictEqual(Tracker.getAccountRaidQuota(account, name).remaining, 1);
  assert.strictEqual(first.remaining, normalized.maxAttempts);

  const secondOperation = Tracker.applyRaidCompletion(normalized, account, first, true);
  assert.strictEqual(Tracker.setAccountRaidQuota(account, null, { remaining: 100, maxAttempts: 180 }), true);
  assert.strictEqual(Tracker.undoRaidCompletion(normalized, account, first, secondOperation), false);
  assert.ok(Tracker.applyRaidCompletion(normalized, account, first, false));
  assert.strictEqual(Tracker.getAccountRaidQuota(account).remaining, 100);
  assert.strictEqual(Tracker.getAccountRaidQuota(account, name).remaining, 1);

  assert.ok(Tracker.applyRaidCompletion(normalized, account, second, true));
  const daily = Tracker.resetDailyProgress(normalized);
  assert.strictEqual(Tracker.getAccountRaidQuota(daily.accounts[0]).remaining, 99);
  assert.strictEqual(Tracker.getAccountRaidQuota(daily.accounts[0], name).remaining, 0);
  assert.strictEqual(daily.accounts[0].zones[1].characters[0].raids[0].quotaCharge, undefined);
  const renamed = Tracker.renameRaid(daily, name, "额度改名测试").server;
  assert.strictEqual(Tracker.getAccountRaidQuota(renamed.accounts[0], name), null);
  assert.deepStrictEqual(Tracker.getAccountRaidQuota(renamed.accounts[0], "额度改名测试"), {
    name: "额度改名测试", remaining: 0, maxAttempts: 15,
  });
  const restored = Tracker.resetRaidCycle(renamed);
  assert.strictEqual(Tracker.getAccountRaidQuota(restored.accounts[0]).remaining, 180);
  assert.strictEqual(Tracker.getAccountRaidQuota(restored.accounts[0], "额度改名测试").remaining, 15);
  const season = Tracker.normalizeServerState("season", { accounts: restored.accounts });
  assert.ok(!Object.hasOwn(season.accounts[0], "raidQuota"));
}

function testScopedRaidRestore() {
  const regular = Tracker.createServerState("regular");
  const first = regular.activeRaids[0];
  const second = regular.activeRaids[1];
  regular.accounts = ["甲", "乙"].map((name) => {
    const account = Tracker.createAccount(name, "regular");
    const role = Tracker.createCharacter(name, regular.activeRaids, regular.maxAttempts);
    role.staminaDone = true;
    for (const raid of role.raids) Object.assign(raid, { remaining: 1, doneToday: true });
    account.zones[0].characters = [role];
    Tracker.setAccountRaidQuota(account, null, { remaining: 30, maxAttempts: 180 });
    Tracker.setAccountRaidQuota(account, first, { remaining: 2, maxAttempts: 15 });
    Tracker.setAccountRaidQuota(account, second, { remaining: 3, maxAttempts: 18 });
    return account;
  });
  const restored = Tracker.resetRaidCycle(regular, { accountId: regular.accounts[0].id, raidName: first });
  const [account, other] = restored.accounts;
  const role = account.zones[0].characters[0];
  assert.strictEqual(Tracker.getAccountRaidQuota(account).remaining, 30);
  assert.strictEqual(Tracker.getAccountRaidQuota(account, first).remaining, 15);
  assert.strictEqual(Tracker.getAccountRaidQuota(account, second).remaining, 3);
  assert.strictEqual(role.staminaDone, true);
  assert.strictEqual(role.raids.find((raid) => raid.name === first).doneToday, false);
  assert.strictEqual(role.raids.find((raid) => raid.name === second).doneToday, true);
  assert.strictEqual(Tracker.getAccountRaidQuota(other, first).remaining, 2);
  assert.strictEqual(regular.accounts[0].zones[0].characters[0].raids[0].remaining, 1);
}

function repeatableRaidFixture(serverId = "regular") {
  const server = Tracker.createServerState(serverId);
  const account = Tracker.createAccount("测试账号", serverId);
  const role = Tracker.createCharacter("测试角色", server.activeRaids, server.maxAttempts);
  const [raid] = role.raids;
  account.zones[0].characters.push(role);
  server.accounts.push(account);
  return { server, account, role, raid };
}

function testRepeatableRaidClearsAndCorrections() {
  const { server, account, role, raid } = repeatableRaidFixture();
  Tracker.setCharacterRaidQuota(role, { remaining: 30, maxAttempts: 30 });
  Tracker.setAccountRaidQuota(account, raid.name, { remaining: 15, maxAttempts: 15 });
  const first = Tracker.recordRaidClear(server, account, role, raid);
  const second = Tracker.recordRaidClear(server, account, role, raid);
  assert.ok(first && second && first !== second);
  const balances = () => [
    raid.remaining,
    Tracker.getCharacterRaidQuota(role).remaining,
    Tracker.getAccountRaidQuota(account, raid.name).remaining,
    Tracker.getAccountRaidQuota(account).remaining,
  ];
  assert.deepStrictEqual(balances(), [1, 28, 13, 178]);
  assert.deepStrictEqual(Tracker.getRaidClears(raid).map(({ id, charge }) => [id, charge]), [[first, 15], [second, 15]]);
  assert.ok(Tracker.getRaidClears(raid).every(({ recordedAt }) => Number.isSafeInteger(recordedAt)));
  assert.deepStrictEqual(Tracker.raidClearBlockers(account, role, raid), []);
  assert.strictEqual(Tracker.summarize(server, { repeatable: true }).raids[0].doneToday, 2);
  assert.strictEqual(Tracker.summarize(server, { repeatable: true }).raidsPending, 4);

  const app = Tracker.createAppState();
  app.servers.regular = server;
  const backedUp = Tracker.parseBackupText(JSON.stringify(Tracker.formatBackup(app))).app.servers.regular;
  assert.deepStrictEqual(backedUp, server);
  assert.strictEqual(Tracker.undoRaidClear(server, account, role, raid, first), true);
  assert.deepStrictEqual(balances(), [2, 29, 14, 179]);
  raid.remaining = 0;
  Tracker.clearRaidCharge(raid);
  Tracker.setCharacterRaidQuota(role, { remaining: 22, maxAttempts: 30 });
  Tracker.setAccountRaidQuota(account, null, { remaining: 150, maxAttempts: 180 });
  assert.strictEqual(Tracker.getRaidClears(raid)[0].charge, 4);
  assert.strictEqual(Tracker.undoRaidClear(server, account, role, raid, second), true);
  assert.deepStrictEqual(balances(), [0, 22, 15, 150]);
  assert.strictEqual(raid.doneToday, false);
  assert.strictEqual(Tracker.undoRaidClear(server, account, role, raid, second), false);
}

function testRaidClearLimitsAndLegacy() {
  const { server, account, role, raid } = repeatableRaidFixture();
  Object.assign(raid, { remaining: 0, doneToday: true });
  Tracker.setCharacterRaidQuota(role, { remaining: 0, maxAttempts: 30 });
  Tracker.setAccountRaidQuota(account, raid.name, { remaining: 0, maxAttempts: 15 });
  Tracker.setAccountRaidQuota(account, null, { remaining: 0, maxAttempts: 180 });
  assert.deepStrictEqual(Tracker.raidClearBlockers(account, role, raid),
    ["character-raid", "character-total", "account-raid", "account-total"]);
  const before = JSON.stringify(server);
  assert.strictEqual(Tracker.recordRaidClear(server, account, role, raid), null);
  assert.strictEqual(JSON.stringify(server), before);
  assert.deepStrictEqual(Tracker.getRaidClears(raid), [{ id: "legacy", charge: 1 }]);
  assert.strictEqual(Tracker.undoRaidClear(server, account, role, raid, "legacy"), true);
  assert.strictEqual(raid.remaining, 1);
  assert.strictEqual(Tracker.getCharacterRaidQuota(role).remaining, 0);
  assert.strictEqual(Tracker.getAccountRaidQuota(account).remaining, 0);

  const season = repeatableRaidFixture("season");
  season.role.raidRewardQuota = { remaining: 0, maxAttempts: 30 };
  const normalized = Tracker.normalizeServerState("season", season.server);
  const seasonAccount = normalized.accounts[0];
  const seasonRole = seasonAccount.zones[0].characters[0];
  const seasonRaid = seasonRole.raids[0];
  assert.strictEqual(Tracker.getCharacterRaidQuota(seasonRole), null);
  const id = Tracker.recordRaidClear(normalized, seasonAccount, seasonRole, seasonRaid);
  assert.ok(id);
  assert.strictEqual(Tracker.getRaidClears(seasonRaid)[0].charge, 1);
  assert.deepStrictEqual(Tracker.raidClearBlockers(seasonAccount, seasonRole, seasonRaid), []);
  const undoViaLegacy = Tracker.applyRaidCompletion(normalized, seasonAccount, seasonRaid, false);
  assert.ok(undoViaLegacy);
  assert.strictEqual(seasonRaid.remaining, 5);
  assert.strictEqual(Tracker.undoRaidCompletion(normalized, seasonAccount, seasonRaid, undoViaLegacy), true);
  assert.strictEqual(Tracker.getRaidClears(seasonRaid)[0].id, id);
  assert.strictEqual(seasonRaid.remaining, 4);
}

function testRepeatableRaidResets() {
  const { server, account, role, raid } = repeatableRaidFixture();
  Tracker.setCharacterRaidQuota(role, { remaining: 30, maxAttempts: 30 });
  Tracker.setAccountRaidQuota(account, raid.name, { remaining: 15, maxAttempts: 15 });
  const id = Tracker.recordRaidClear(server, account, role, raid);
  const daily = Tracker.resetDailyProgress(server);
  const dailyRole = daily.accounts[0].zones[0].characters[0];
  assert.deepStrictEqual(Tracker.getRaidClears(dailyRole.raids[0]), []);
  assert.strictEqual(dailyRole.raids[0].remaining, 2);
  assert.strictEqual(Tracker.getCharacterRaidQuota(dailyRole).remaining, 29);

  const scoped = Tracker.resetRaidCycle(server, { raidName: raid.name });
  const scopedAccount = scoped.accounts[0];
  const scopedRole = scopedAccount.zones[0].characters[0];
  const [scopedRaid] = scopedRole.raids;
  assert.strictEqual(Tracker.getRaidClears(scopedRaid)[0].charge, 10);
  assert.strictEqual(scopedRaid.remaining, 3);
  assert.strictEqual(Tracker.getCharacterRaidQuota(scopedRole).remaining, 29);
  assert.strictEqual(Tracker.getAccountRaidQuota(scopedAccount, raid.name).remaining, 15);
  assert.strictEqual(Tracker.undoRaidClear(scoped, scopedAccount, scopedRole, scopedRaid, id), true);
  assert.strictEqual(scopedRaid.remaining, 3);
  assert.strictEqual(Tracker.getCharacterRaidQuota(scopedRole).remaining, 30);
  assert.strictEqual(Tracker.getAccountRaidQuota(scopedAccount).remaining, 180);

  const restored = Tracker.resetRaidCycle(server);
  const restoredRole = restored.accounts[0].zones[0].characters[0];
  assert.deepStrictEqual(Tracker.getRaidClears(restoredRole.raids[0]), []);
  assert.strictEqual(restoredRole.raids[0].remaining, 3);
  assert.strictEqual(Tracker.getCharacterRaidQuota(restoredRole).remaining, 30);
}

function main() {
  testDefaults();
  testRaidRules();
  testAttemptsAndNormalize();
  testDailyResetKeepsBothServers();
  testShanghaiDailyBoundary();
  testLegacyResetDoesNotDoubleClear();
  testSummary();
  testPlatformBackupRoundTrip();
  testLegacyImportKeepsRegular();
  testMaximumSizeBackupRoundTrip();
  testOldAccountMigrationAndRepair();
  testDailyAndRaidRulesAcrossZones();
  testVersionOneBackupMigration();
  testVersionTwoBackupMergeAndReplace();
  testConfigurableRaidCatalogAndBackup();
  testConfigurableRaidMode();
  testParseRosterText();
  testImportRosterAndProfileRoundTrip();
  testRosterImportAmbiguousOrFullTargets();
  testRaidCountTextAndConflict();
  testRaidCountImportPerCharacterCaps();
  testRaidCountImportIsAtomicAndRequiredScope();
  testRegularSharedRaidQuotas();
  testScopedRaidRestore();
  testRepeatableRaidClearsAndCorrections();
  testRaidClearLimitsAndLegacy();
  testRepeatableRaidResets();
  testRejectsBadBackup();
  console.log("tracker tests passed");
}

main();
