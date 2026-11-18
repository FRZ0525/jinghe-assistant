const assert = require("node:assert/strict");
const test = require("node:test");
const Tracker = require("../tracker");
const Merge = require("../sync-merge");

function clean() {
  const { dailyDate, dailyResetHour, servers } = Tracker.createAppState();
  return { dailyDate, dailyResetHour, servers };
}

function duplicate(value) {
  return JSON.parse(JSON.stringify(value));
}

function character(name, id, server) {
  return { ...Tracker.createCharacter(name, server.activeRaids, server.maxAttempts), id };
}

function seed() {
  const data = clean();
  const server = data.servers.regular;
  server.accounts.push(
    { id: "a", name: "长期号", zones: [
      { id: "west", name: "西区", characters: [character("风语", "first", server)] },
      { id: "east", name: "东区", characters: [character("风语", "second", server)] },
    ] },
    { id: "b", name: "备用号", zones: [] },
  );
  return data;
}

function role(data, zone = 0) {
  return data.servers.regular.accounts[0].zones[zone].characters[0];
}

function raid(data, name = "魔棋战局", zone = 0) {
  return role(data, zone).raids.find((entry) => entry.name === name);
}

test("同一数据忽略记录重排，轮换顺序和未知数组仍参与比较", () => {
  const original = seed();
  const variant = duplicate(original);
  variant.servers.regular.raidCatalog.reverse();
  variant.servers.regular.accounts[0].zones.reverse();
  variant.servers.regular.accounts[0].zones[0].characters[0].raids.reverse();
  variant.servers.regular.accounts.reverse();
  assert.equal(Merge.same(original, variant), true);
  variant.servers.season.activeRaids.reverse();
  assert.equal(Merge.same(original, variant), false);
  assert.equal(Merge.same({ preferences: { accounts: [{ id: "a" }, { id: "b" }] } },
    { preferences: { accounts: [{ id: "b" }, { id: "a" }] } }), false);
});

test("新安装判断忽略日期，但保留实际记录和自定义设置", () => {
  const initial = clean();
  initial.dailyDate = "2026-11-17";
  assert.equal(Merge.isEmpty(initial), true);
  assert.equal(Merge.isEmpty(null), true);
  assert.equal(Merge.isEmpty(seed()), false);
  const custom = duplicate(initial);
  custom.servers.regular = Tracker.addRaid(custom.servers.regular, "自定义").server;
  assert.equal(Merge.isEmpty(custom), false);
  initial.servers.season.maxAttempts = 7;
  assert.equal(Merge.isEmpty(initial), false);
});

test("按身份合并不同账号、区服、角色与独立字段", () => {
  const base = seed();
  const local = duplicate(base);
  const remote = duplicate(base);
  const baseBefore = JSON.stringify(base);
  role(local).staminaDone = true;
  local.servers.regular.accounts[0].zones.push({ id: "north", name: "北区", characters: [] });
  local.servers.regular.accounts[0].name = "新账号名";
  role(remote, 1).level = 70;
  remote.servers.regular.accounts.push({ id: "new", name: "异地号", zones: [] });
  const merged = Merge.merge(base, local, remote);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(role(merged.data).staminaDone, true);
  assert.equal(role(merged.data, 1).level, 70);
  assert.deepEqual(merged.data.servers.regular.accounts.map((item) => item.name), ["新账号名", "备用号", "异地号"]);
  assert.equal(merged.data.servers.regular.accounts[0].zones[2].name, "北区");
  role(merged.data).staminaDone = false;
  assert.equal(role(local).staminaDone, true);
  assert.equal(JSON.stringify(base), baseBefore);
});

test("无共同空快照时可合并不同的新增 ID", () => {
  const local = clean();
  const remote = clean();
  local.servers.regular.accounts.push({ id: "a", name: "两个端可独立新增", zones: [] });
  remote.servers.regular.accounts.push({ id: "b", name: "两个端可独立新增", zones: [] });
  const merged = Merge.merge(null, local, remote);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.data.servers.regular.accounts.map((item) => item.id), ["a", "b"]);
});

test("同一剩余次数冲突只选择该字段，其余并发编辑保留", () => {
  const base = seed();
  const local = duplicate(base);
  const remote = duplicate(base);
  raid(local).remaining = 2;
  raid(remote).remaining = 1;
  role(local).staminaDone = true;
  role(remote).level = 68;
  raid(remote, "失落遗迹").doneToday = true;
  for (const prefer of ["local", "remote"]) {
    const { data, conflicts } = Merge.merge(base, local, remote, prefer);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0].path, /长期号.*西区.*风语.*魔棋战局.*剩余次数/);
    assert.equal(conflicts[0].kind, "value");
    assert.equal(raid(data).remaining, prefer === "local" ? 2 : 1);
    assert.equal(role(data).staminaDone, true);
    assert.equal(role(data).level, 68);
    assert.equal(raid(data, "失落遗迹").doneToday, true);
  }
});

test("删除无冲突记录和同一账号删除/编辑同时发生", () => {
  const base = seed();
  const local = duplicate(base);
  const remote = duplicate(base);
  local.servers.regular.accounts = [];
  role(remote).level = 70;
  remote.servers.regular.accounts.push({ id: "new", name: "新号", zones: [] });
  const localChoice = Merge.merge(base, local, remote, "local");
  const remoteChoice = Merge.merge(base, local, remote, "remote");
  assert.deepEqual(localChoice.conflicts, remoteChoice.conflicts);
  assert.equal(localChoice.conflicts.length, 1);
  assert.equal(localChoice.conflicts[0].kind, "delete-edit");
  assert.deepEqual(localChoice.data.servers.regular.accounts.map((item) => item.id), ["new"]);
  assert.deepEqual(remoteChoice.data.servers.regular.accounts.map((item) => item.id), ["a", "new"]);
  assert.equal(role(remoteChoice.data).level, 70);
});

test("未知数组和重复 ID 回退到整体冲突", () => {
  const base = { servers: { regular: { accounts: [{ id: "same", name: "甲" }, { id: "same", name: "乙" }] } }, custom: [0] };
  const local = duplicate(base);
  const remote = duplicate(base);
  local.servers.regular.accounts[0].name = "甲变动";
  remote.servers.regular.accounts[1].name = "乙变动";
  local.custom.push(1);
  remote.custom.push(2);
  const result = Merge.merge(base, local, remote, "local");
  assert.equal(result.conflicts.length, 2);
  assert.deepEqual(result.data, local);
});

test("团本停用与另一端改记录可选择，独立停用仍保留", () => {
  const base = seed();
  const local = duplicate(base);
  const remote = duplicate(base);
  local.servers.regular = Tracker.toggleActiveRaid(local.servers.regular, "魔棋战局").server;
  local.servers.regular = Tracker.toggleActiveRaid(local.servers.regular, "失落遗迹").server;
  raid(remote).remaining = 1;
  role(remote).level = 66;
  const localChoice = Merge.merge(base, local, remote, "local");
  const remoteChoice = Merge.merge(base, local, remote, "remote");
  for (const result of [localChoice, remoteChoice]) {
    assert.ok(result.conflicts.some(({ kind, items }) => (
      kind === "raid-config" && items.some(({ path }) => /魔棋战局/.test(path))
    )));
    assert.equal(result.data.servers.regular.activeRaids.includes("失落遗迹"), false);
    assert.equal(role(result.data).level, 66);
  }
  assert.equal(raid(localChoice.data), undefined);
  assert.equal(raid(remoteChoice.data).remaining, 1);
  assert.ok(remoteChoice.data.servers.regular.activeRaids.includes("魔棋战局"));
  const normalized = Tracker.normalizeServerState("regular", remoteChoice.data.servers.regular);
  assert.equal(normalized.accounts[0].zones[0].characters[0].raids.find((entry) => entry.name === "魔棋战局").remaining, 1);
});

test("降低上限和增加剩余次数产生配置冲突，保留不冲突的标记", () => {
  const base = seed();
  raid(base).remaining = 1;
  const local = duplicate(base);
  const remote = duplicate(base);
  local.servers.regular = Tracker.setMaxAttempts(local.servers.regular, 1);
  raid(remote).remaining = 2;
  raid(remote).doneToday = true;
  role(local).staminaDone = true;
  const mine = Merge.merge(base, local, remote, "local");
  const theirs = Merge.merge(base, local, remote, "remote");
  for (const result of [mine, theirs]) {
    assert.ok(result.conflicts.some(({ kind }) => kind === "raid-config"));
    assert.equal(raid(result.data).doneToday, true);
    assert.equal(role(result.data).staminaDone, true);
  }
  assert.equal(mine.data.servers.regular.maxAttempts, 1);
  assert.equal(raid(mine.data).remaining, 1);
  assert.equal(theirs.data.servers.regular.maxAttempts, 3);
  assert.equal(raid(theirs.data).remaining, 2);
});

test("全局上限缩小与独立的截图分母升级可以同时保留", () => {
  const base = seed();
  raid(base).remaining = 1;
  const local = duplicate(base);
  const remote = duplicate(base);
  local.servers.regular = Tracker.setMaxAttempts(local.servers.regular, 1);
  raid(remote).maxAttempts = 6;
  raid(remote).remaining = 4;
  const result = Merge.merge(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.data.servers.regular.maxAttempts, 1);
  assert.equal(raid(result.data).maxAttempts, 6);
  assert.equal(raid(result.data).remaining, 4);
});

test("双轮换改名与旧副本计数冲突，选择后副本位置与进度都能保留", () => {
  const base = clean();
  const season = base.servers.season;
  season.accounts.push({
    id: "season-account",
    name: "赛季号",
    zones: [{ id: "first", name: "一区", characters: [character("风语", "season-role", season)] }],
  });
  const local = duplicate(base);
  const remote = duplicate(base);
  local.servers.season = Tracker.renameRaid(local.servers.season, "国王", "轮换副本").server;
  const player = remote.servers.season.accounts[0].zones[0].characters[0];
  player.raids[0].remaining = 1;
  player.staminaDone = true;

  const mine = Merge.merge(base, local, remote, "local");
  const theirs = Merge.merge(base, local, remote, "remote");
  for (const result of [mine, theirs]) {
    assert.ok(result.conflicts.some(({ kind, items }) => (
      kind === "raid-config" && items.some(({ path }) => /国王/.test(path))
    )));
    assert.equal(result.data.servers.season.accounts[0].zones[0].characters[0].staminaDone, true);
  }
  assert.deepEqual(mine.data.servers.season.activeRaids, ["轮换副本", "女皇"]);
  assert.deepEqual(theirs.data.servers.season.activeRaids, ["国王", "女皇"]);
  const kept = theirs.data.servers.season.accounts[0].zones[0].characters[0];
  assert.equal(kept.raids.find((item) => item.name === "国王").remaining, 1);
  assert.equal(kept.raids.some((item) => item.name === "轮换副本"), false);
});

test("同名的两条独立记录各自列出冲突", () => {
  const base = seed();
  const west = base.servers.regular.accounts[0].zones[0];
  west.characters.push(character("风语", "separate-id", base.servers.regular));
  const local = duplicate(base);
  const remote = duplicate(base);
  for (const item of local.servers.regular.accounts[0].zones[0].characters) item.level = 40;
  for (const item of remote.servers.regular.accounts[0].zones[0].characters) item.level = 65;
  const result = Merge.merge(base, local, remote, "remote");
  assert.equal(result.conflicts.length, 2);
  assert.deepEqual(result.data.servers.regular.accounts[0].zones[0].characters.map((item) => item.level), [65, 65]);
});

function quotaSeed(capacity) {
  const data = seed();
  const server = data.servers.regular = Tracker.normalizeServerState("regular", data.servers.regular);
  const account = server.accounts[0];
  Tracker.setAccountRaidQuota(account, null, { remaining: capacity, maxAttempts: 180 });
  Tracker.setAccountRaidQuota(account, "魔棋战局", { remaining: capacity, maxAttempts: 15 });
  return data;
}

function completeRaid(data, zone) {
  const server = data.servers.regular;
  assert.ok(Tracker.applyRaidCompletion(server, server.accounts[0], raid(data, "魔棋战局", zone), true));
}

function quotaOf(data, name = null) {
  return Tracker.getAccountRaidQuota(data.servers.regular.accounts[0], name)?.remaining;
}

function recordClear(data, name, zone = 0, serverId = "regular") {
  const server = data.servers[serverId];
  const account = server.accounts[0];
  const recipient = account.zones[zone].characters[0];
  const entry = recipient.raids.find((item) => item.name === name);
  const id = Tracker.recordRaidClear(server, account, recipient, entry);
  assert.ok(id);
  return id;
}

function clearIds(entry) {
  return Tracker.getRaidClears(entry).map(({ id }) => id);
}

test("两端给不同角色记多次通关时保留各笔并汇总账号额度", () => {
  const base = quotaSeed(8);
  for (const position of [0, 1]) {
    Tracker.setCharacterRaidQuota(role(base, position), { remaining: 5, maxAttempts: 30 });
  }
  const local = duplicate(base);
  const remote = duplicate(base);
  const west = [recordClear(local, "魔棋战局"), recordClear(local, "魔棋战局")];
  const east = [recordClear(remote, "魔棋战局", 1)];
  const result = Merge.merge(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(clearIds(raid(result.data, "魔棋战局")), west);
  assert.deepEqual(clearIds(raid(result.data, "魔棋战局", 1)), east);
  assert.equal(quotaOf(result.data), 5);
  assert.equal(quotaOf(result.data, "魔棋战局"), 5);
  assert.equal(role(result.data).raidRewardQuota.remaining, 3);
  assert.equal(role(result.data, 1).raidRewardQuota.remaining, 4);
});

test("两端同时改同一角色同一团本可整组保留通关与四层额度", () => {
  const base = quotaSeed(8);
  Tracker.setCharacterRaidQuota(role(base), { remaining: 5, maxAttempts: 30 });
  const local = duplicate(base);
  const remote = duplicate(base);
  recordClear(local, "魔棋战局");
  recordClear(local, "魔棋战局");
  const id = recordClear(remote, "魔棋战局");
  const preview = Merge.merge(base, local, remote);
  const conflict = preview.conflicts.find(({ kind }) => kind === "raid-quota");
  assert.ok(conflict);
  assert.equal(quotaOf(preview.data), 6);
  assert.equal(raid(preview.data).remaining, raid(base).remaining - 2);
  const result = Merge.merge(base, local, remote, { [conflict.id]: "remote" });
  assert.deepEqual(clearIds(raid(result.data)), [id]);
  assert.equal(raid(result.data).remaining, raid(base).remaining - 1);
  assert.equal(role(result.data).raidRewardQuota.remaining, 4);
  assert.equal(quotaOf(result.data), 7);
  assert.equal(quotaOf(result.data, "魔棋战局"), 7);
});

test("同角色不同团本汇总角色总奖励，最后一次不足时整组选边", () => {
  for (const capacity of [3, 1]) {
    const base = quotaSeed(8);
    Tracker.setCharacterRaidQuota(role(base), { remaining: capacity, maxAttempts: 30 });
    const local = duplicate(base);
    const remote = duplicate(base);
    const left = recordClear(local, "魔棋战局");
    const right = recordClear(remote, "失落遗迹");
    const result = Merge.merge(base, local, remote, "remote");
    assert.equal(result.conflicts.some(({ kind }) => kind === "raid-quota"), capacity === 1);
    assert.deepEqual(clearIds(raid(result.data, "失落遗迹")), [right]);
    assert.deepEqual(clearIds(raid(result.data, "魔棋战局")), capacity === 1 ? [] : [left]);
    assert.equal(role(result.data).raidRewardQuota.remaining, capacity === 1 ? 0 : 1);
    assert.equal(quotaOf(result.data), capacity === 1 ? 7 : 6);
    assert.equal(quotaOf(result.data, "魔棋战局"), capacity === 1 ? 8 : 7);
  }
});

test("赛季服可多次记录同一团本，两端冲突时通关与剩余次数同组选边", () => {
  const base = clean();
  const server = base.servers.season;
  const account = Tracker.createAccount("赛季号", "season");
  const recipient = Tracker.createCharacter("角色", server.activeRaids, server.maxAttempts);
  account.zones[0].characters.push(recipient);
  server.accounts.push(account);
  const local = duplicate(base);
  const remote = duplicate(base);
  recordClear(local, server.activeRaids[0], 0, "season");
  recordClear(local, server.activeRaids[0], 0, "season");
  const right = recordClear(remote, server.activeRaids[0], 0, "season");
  const result = Merge.merge(base, local, remote, "remote");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, "value");
  const saved = result.data.servers.season.accounts[0].zones[0].characters[0];
  assert.equal(saved.raids[0].remaining, recipient.raids[0].remaining - 1);
  assert.deepEqual(clearIds(saved.raids[0]), [right]);
});

test("两个设备重复收到同一笔通关保留原时间，只扣一次额度", () => {
  const base = quotaSeed(8);
  Tracker.setCharacterRaidQuota(role(base), { remaining: 5, maxAttempts: 30 });
  const local = duplicate(base);
  const id = recordClear(local, "魔棋战局");
  const remote = duplicate(local);
  role(remote, 1).staminaDone = true;
  const result = Merge.merge(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(quotaOf(result.data), 7);
  assert.deepEqual(Tracker.getRaidClears(raid(result.data)), Tracker.getRaidClears(raid(local)));
  assert.deepEqual(clearIds(raid(result.data)), [id]);
  assert.equal(role(result.data, 1).staminaDone, true);
});

test("两端不同区服的角色同时打本时汇总共享扣减", () => {
  const base = quotaSeed(3);
  const local = duplicate(base);
  const remote = duplicate(base);
  completeRaid(local, 0);
  completeRaid(remote, 1);
  const result = Merge.merge(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(quotaOf(result.data), 1);
  assert.equal(quotaOf(result.data, "魔棋战局"), 1);
  assert.equal(raid(result.data).doneToday, true);
  assert.equal(raid(result.data, "魔棋战局", 1).doneToday, true);
});

test("同一角色在两端重复打本只扣一份共享额度", () => {
  const base = quotaSeed(3);
  const local = duplicate(base);
  const remote = duplicate(base);
  completeRaid(local, 0);
  completeRaid(remote, 0);
  role(remote, 1).staminaDone = true;
  const result = Merge.merge(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(quotaOf(result.data), 2);
  assert.equal(quotaOf(result.data, "魔棋战局"), 2);
  assert.equal(role(result.data, 1).staminaDone, true);
});

test("两端同时使用账号最后一次额度时可选择一项记录", () => {
  const base = quotaSeed(1);
  const local = duplicate(base);
  const remote = duplicate(base);
  completeRaid(local, 0);
  completeRaid(remote, 1);
  role(local, 1).staminaDone = true;
  const result = Merge.merge(base, local, remote, "remote");
  assert.ok(result.conflicts.some(({ kind }) => kind === "raid-quota"));
  assert.equal(quotaOf(result.data), 0);
  assert.equal(quotaOf(result.data, "魔棋战局"), 0);
  assert.equal(raid(result.data).doneToday, false);
  assert.equal(raid(result.data, "魔棋战局", 1).doneToday, true);
  assert.equal(role(result.data, 1).staminaDone, true);
});

test("跨过日切的独立记录不能因账号数值恰好相同而默默合并", () => {
  const base = quotaSeed(3);
  const local = duplicate(base);
  const remote = duplicate(base);
  completeRaid(local, 0);
  completeRaid(remote, 1);
  for (const data of [local, remote]) {
    data.servers.regular = Tracker.resetDailyProgress(data.servers.regular);
  }
  const result = Merge.merge(base, local, remote);
  assert.ok(result.conflicts.some(({ kind }) => kind === "raid-quota"));
  assert.equal(raid(result.data).remaining, raid(base).remaining - 1);
  assert.equal(raid(result.data, "魔棋战局", 1).remaining, raid(base, "魔棋战局", 1).remaining - 1);
});

test("同名角色按稳定身份各选一端，保留两端独立编辑", () => {
  const base = seed();
  const west = base.servers.regular.accounts[0].zones[0];
  west.characters.push(character("风语", "duplicate-role", base.servers.regular));
  for (const player of west.characters) player.level = 50;
  const local = duplicate(base);
  const remote = duplicate(base);
  const roles = (data) => data.servers.regular.accounts[0].zones[0].characters;
  roles(local)[0].level = 60;
  roles(local)[1].level = 61;
  roles(local)[1].staminaDone = true;
  roles(remote)[0].level = 65;
  roles(remote)[0].power = "100万";
  roles(remote)[1].level = 66;
  const preview = Merge.merge(base, local, remote);
  const [first, second] = preview.conflicts;
  assert.equal(preview.conflicts.length, 2);
  assert.notEqual(first.id, second.id);
  assert.equal(first.path, second.path);
  assert.equal(first.items[0].local.data, 60);
  assert.equal(first.items[0].remote.data, 65);
  const selected = Merge.merge(base, local, remote, { [first.id]: "remote", [second.id]: "local" });
  assert.deepEqual(roles(selected.data).map((item) => item.level), [65, 61]);
  assert.equal(roles(selected.data)[0].power, "100万");
  assert.equal(roles(selected.data)[1].staminaDone, true);
  assert.deepEqual(selected.conflicts.map(({ id }) => id), preview.conflicts.map(({ id }) => id));
});

test("账号最后一次额度可以整组选服务器，独立角色字段仍可保留本机", () => {
  const base = quotaSeed(1);
  const local = duplicate(base);
  const remote = duplicate(base);
  completeRaid(local, 0);
  completeRaid(remote, 1);
  role(local).level = 62;
  role(remote).level = 70;
  const preview = Merge.merge(base, local, remote);
  const group = preview.conflicts.find(({ kind }) => kind === "raid-quota");
  const field = preview.conflicts.find(({ kind }) => kind === "value");
  assert.equal(preview.conflicts.length, 2);
  assert.equal(group.items.length, 2);
  assert.match(group.items[0].local.context, /西区/);
  assert.match(group.items[0].remote.context, /东区/);
  const { data } = Merge.merge(base, local, remote, { [group.id]: "remote", [field.id]: "local" });
  assert.equal(quotaOf(data), 0);
  assert.equal(quotaOf(data, "魔棋战局"), 0);
  assert.equal(raid(data).doneToday, false);
  assert.equal(raid(data, "魔棋战局", 1).doneToday, true);
  assert.equal(role(data).level, 62);
});
