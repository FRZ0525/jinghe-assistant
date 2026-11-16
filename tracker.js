(function attachTracker(root, factory) {
  const tracker = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = tracker;
  }
  root.JingheTracker = tracker;
  root.Tracker = tracker;
})(typeof globalThis !== "undefined" ? globalThis : this, function createTracker() {
  const DAILY_RESET_HOUR = 6;
  const ATTEMPT_MIN = 1;
  const ATTEMPT_MAX = 10;
  const ACCOUNT_LIMIT = 100;
  const CHARACTER_LIMIT = 1000;
  const BACKUP_LIMIT = 4000000;
  const DEFAULT_ZONE_NAME = "默认区";
  const LEGACY_ZONE_ID = "zone-default";
  const SHANGHAI_CLOCK = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });

  const SERVER_DEFS = {
    season: {
      id: "season",
      label: "赛季服",
      kicker: "SEASON",
      summary: "周一、周三 10:00 轮换两个团本。每日 6:00 只清体力和今日标记，次数要手动补满。",
      raidMode: "pair",
      defaultMaxAttempts: 5,
      raids: [
        { name: "国王", detail: "合力将军" },
        { name: "女皇", detail: "皇后加冕" },
        { name: "遗迹", detail: "命运之殿" },
        { name: "天启", detail: "天启降临" },
      ],
      defaultActive: ["国王", "女皇"],
    },
    regular: {
      id: "regular",
      label: "常规服",
      kicker: "REGULAR",
      summary: "同时记多个团本。每日 6:00 只清体力和今日标记，周一或周三刷新后手动补满次数。",
      raidMode: "multi",
      defaultMaxAttempts: 3,
      raids: [
        { name: "魔棋战局", detail: "" },
        { name: "皇后加冕", detail: "" },
        { name: "失落遗迹", detail: "" },
        { name: "天启降临", detail: "" },
        { name: "沙影黑巢", detail: "" },
        { name: "禁忌之心", detail: "" },
        { name: "铸骨迷巢", detail: "" },
        { name: "永罚霜狱", detail: "" },
        { name: "金权蚀局", detail: "" },
      ],
      defaultActive: ["魔棋战局", "失落遗迹", "天启降临", "沙影黑巢"],
    },
  };

  function getServerDef(serverId) {
    return serverId === "season" ? SERVER_DEFS.season : SERVER_DEFS.regular;
  }

  function createId(prefix) {
    return (
      prefix +
      "-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function raidNameKey(name) {
    return typeof name === "string" ? name.trim().toLowerCase() : "";
  }

  function getRaidMode(server) {
    if (server?.raidMode === "pair" || server?.raidMode === "multi") return server.raidMode;
    return getServerDef(server?.serverId).raidMode;
  }

  function minimumRaidCount(mode) {
    return mode === "pair" ? 2 : 1;
  }

  function normalizeRaidCatalog(def, value, mode) {
    const entries = Array.isArray(value) ? value : def.raids;
    const seen = new Set();
    const catalog = [];
    for (const entry of entries) {
      const key = raidNameKey(entry?.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      catalog.push({
        name: entry.name.trim(),
        detail: typeof entry.detail === "string" ? entry.detail : "",
      });
    }

    // Repair incomplete catalogs in imported or manually edited data.
    for (const template of def.raids) {
      if (catalog.length >= minimumRaidCount(mode)) break;
      const key = raidNameKey(template.name);
      if (seen.has(key)) continue;
      seen.add(key);
      catalog.push({ ...template });
    }
    return catalog;
  }

  function getRaidCatalog(server) {
    return normalizeRaidCatalog(getServerDef(server?.serverId), server?.raidCatalog, getRaidMode(server));
  }

  function findRaid(catalog, name) {
    const key = raidNameKey(name);
    return catalog.find((raid) => raidNameKey(raid.name) === key);
  }

  function clampMax(value, fallback) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.min(ATTEMPT_MAX, Math.max(ATTEMPT_MIN, number));
  }

  function clampRemaining(maxAttempts, value) {
    const max = clampMax(maxAttempts, 5);
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return 0;
    return Math.min(max, Math.max(0, number));
  }

  function normalizeActiveRaids(def, catalog, value, mode) {
    const byName = new Map(catalog.map((raid) => [raidNameKey(raid.name), raid.name]));
    const saved = Array.isArray(value) ? value : [];
    const picked = new Set(saved.map((name) => byName.get(raidNameKey(name))).filter(Boolean));
    const defaults = def.defaultActive.map((name) => byName.get(raidNameKey(name)));
    if (mode === "pair") {
      const [first, second] = picked;
      const firstRaid = first || defaults[0] || catalog[0].name;
      const secondRaid = second || [defaults[1], ...byName.values()].find((name) => name && name !== firstRaid);
      return [firstRaid, secondRaid];
    }

    if (picked.size) return catalog.filter((raid) => picked.has(raid.name)).map((raid) => raid.name);
    const availableDefaults = defaults.filter(Boolean);
    return availableDefaults.length ? availableDefaults : [catalog[0].name];
  }

  function createCharacter(name, activeRaids, maxAttempts) {
    const raids = Array.isArray(activeRaids) ? activeRaids : [];
    const max = clampMax(maxAttempts, 5);
    return {
      id: createId("character"),
      name: name || "新角色",
      staminaDone: false,
      raids: raids.map(function createRaid(raidName) {
        return {
          name: raidName,
          remaining: max,
          doneToday: false,
        };
      }),
    };
  }

  function createZone(name) {
    return { id: createId("zone"), name: name || DEFAULT_ZONE_NAME, characters: [] };
  }

  function createAccount(name) {
    return {
      id: createId("account"),
      name: name || "新账号",
      zones: [createZone(DEFAULT_ZONE_NAME)],
    };
  }

  function normalizeSiblings(value, prefix, normalize) {
    const entries = Array.isArray(value)
      ? value.map((entry) => entry && typeof entry === "object" ? entry : {})
      : [];
    const originalIds = entries.map((entry) => typeof entry.id === "string" && entry.id.trim() ? entry.id : "");
    const reserved = new Set(originalIds);
    const used = new Set();
    return entries.map((entry, index) => {
      let id = originalIds[index];
      if (!id || used.has(id)) {
        const generated = createId(prefix);
        id = generated;
        for (let suffix = 2; reserved.has(id) || used.has(id); suffix += 1) {
          id = generated + "-" + suffix;
        }
      }
      used.add(id);
      return normalize(entry, id, index);
    });
  }

  function normalizeName(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function normalizeCharacter(source, id, index, activeRaids, maxAttempts) {
    const sourceRaids = Array.isArray(source.raids) ? source.raids : [];
    const byName = new Map();
    for (const raid of sourceRaids) {
      const key = raidNameKey(raid?.name);
      if (key && !byName.has(key)) byName.set(key, raid);
    }
    return {
      id,
      name: normalizeName(source.name, "角色" + (index + 1)),
      staminaDone: source.staminaDone === true,
      raids: activeRaids.map(function normalizeRaid(raidName) {
        const existing = byName.get(raidNameKey(raidName));
        return {
          name: raidName,
          remaining: existing
            ? clampRemaining(maxAttempts, existing.remaining)
            : maxAttempts,
          doneToday: existing ? existing.doneToday === true : false,
        };
      }),
    };
  }

  function normalizeServerState(serverId, value) {
    const def = getServerDef(serverId);
    const source = value && typeof value === "object" ? value : {};
    const maxAttempts = clampMax(source.maxAttempts, def.defaultMaxAttempts);
    const raidMode = getRaidMode({ serverId: def.id, raidMode: source.raidMode });
    const raidCatalog = normalizeRaidCatalog(def, source.raidCatalog, raidMode);
    const activeRaids = normalizeActiveRaids(def, raidCatalog, source.activeRaids, raidMode);
    return {
      serverId: def.id,
      maxAttempts,
      raidMode,
      raidCatalog,
      activeRaids,
      accounts: normalizeSiblings(source.accounts, "account", (account, id, accountIndex) => {
        const sourceZones = Array.isArray(account.zones)
          ? account.zones
          : [{ id: LEGACY_ZONE_ID, name: DEFAULT_ZONE_NAME, characters: account.characters }];
        return {
          id,
          name: normalizeName(account.name, "账号" + (accountIndex + 1)),
          zones: normalizeSiblings(sourceZones, "zone", (zone, zoneId, zoneIndex) => ({
            id: zoneId,
            name: normalizeName(zone.name, "区服" + (zoneIndex + 1)),
            characters: normalizeSiblings(zone.characters, "character", (character, characterId, index) =>
              normalizeCharacter(character, characterId, index, activeRaids, maxAttempts)
            ),
          })),
        };
      }),
    };
  }

  function createServerState(serverId) {
    const def = getServerDef(serverId);
    return normalizeServerState(def.id, {
      serverId: def.id,
      maxAttempts: def.defaultMaxAttempts,
      activeRaids: def.defaultActive.slice(),
      accounts: [],
    });
  }

  function createAppState() {
    return {
      activeServer: "regular",
      dailyDate: "",
      dailyResetHour: DAILY_RESET_HOUR,
      servers: {
        season: createServerState("season"),
        regular: createServerState("regular"),
      },
    };
  }

  function normalizeAppState(value) {
    const source = value && typeof value === "object" ? value : {};
    const activeServer = source.activeServer === "season" ? "season" : "regular";
    return {
      activeServer: activeServer,
      dailyDate: typeof source.dailyDate === "string" ? source.dailyDate : "",
      dailyResetHour:
        Number(source.dailyResetHour) === DAILY_RESET_HOUR ? DAILY_RESET_HOUR : 0,
      servers: {
        season: normalizeServerState(
          "season",
          source.servers && source.servers.season,
        ),
        regular: normalizeServerState(
          "regular",
          source.servers && source.servers.regular,
        ),
      },
    };
  }

  function serverZones(server) {
    return server.accounts.flatMap((account) => account.zones);
  }

  function summarize(serverState) {
    const server = normalizeServerState(serverState && serverState.serverId, serverState);
    const details = new Map(server.raidCatalog.map((raid) => [raid.name, raid.detail]));
    const totals = new Map(server.activeRaids.map((name) => [name, {
      name,
      detail: details.get(name) || "",
      characters: 0,
      remaining: 0,
      doneToday: 0,
      requiredToday: 0,
    }]));

    let characterCount = 0;
    let staminaDone = 0;
    let raidsDoneToday = 0;
    let raidsRequiredToday = 0;
    let raidsPending = 0;

    const zones = serverZones(server);
    zones.forEach(function walkZone(zone) {
      zone.characters.forEach(function walkCharacter(character) {
        characterCount += 1;
        if (character.staminaDone) staminaDone += 1;
        character.raids.forEach(function walkRaid(raid) {
          const bucket = totals.get(raid.name);
          if (!bucket) return;
          bucket.characters += 1;
          bucket.remaining += raid.remaining;
          if (raid.doneToday) {
            bucket.doneToday += 1;
            raidsDoneToday += 1;
          }
          if (raid.doneToday || raid.remaining > 0) {
            bucket.requiredToday += 1;
            raidsRequiredToday += 1;
          }
          if (!raid.doneToday && raid.remaining > 0) raidsPending += 1;
        });
      });
    });

    return {
      serverId: server.serverId,
      accountCount: server.accounts.length,
      zoneCount: zones.length,
      characterCount: characterCount,
      staminaDone: staminaDone,
      staminaPending: characterCount - staminaDone,
      raidsDoneToday: raidsDoneToday,
      raidsRequiredToday: raidsRequiredToday,
      raidsPending: raidsPending,
      raids: server.activeRaids.map(function raidSummary(name) {
        return totals.get(name);
      }),
    };
  }

  function resetDailyProgress(serverState) {
    const server = normalizeServerState(serverState && serverState.serverId, serverState);
    serverZones(server).forEach(function resetZone(zone) {
      zone.characters.forEach(function resetCharacter(character) {
        character.staminaDone = false;
        character.raids.forEach(function resetRaid(raid) {
          raid.doneToday = false;
        });
      });
    });
    return server;
  }

  function resetRaidCycle(serverState) {
    const server = normalizeServerState(serverState && serverState.serverId, serverState);
    serverZones(server).forEach(function resetZone(zone) {
      zone.characters.forEach(function resetCharacter(character) {
        character.raids.forEach(function resetRaid(raid) {
          raid.remaining = server.maxAttempts;
          raid.doneToday = false;
        });
      });
    });
    return server;
  }

  function setRaidMode(serverState, mode) {
    const server = normalizeServerState(serverState?.serverId, serverState);
    if (mode !== "pair" && mode !== "multi") return unchangedRaid(server, "请选择有效的启用方式");
    if (server.raidMode === mode) return unchangedRaid(server, "启用方式没有变化");
    if (server.raidCatalog.length < minimumRaidCount(mode)) {
      return unchangedRaid(server, "双副本轮换需要至少两个候选副本");
    }
    server.raidMode = mode;
    return { changed: true, server: normalizeServerState(server.serverId, server), message: "" };
  }

  function setMaxAttempts(serverState, maxAttempts) {
    return normalizeServerState(serverState?.serverId, { ...serverState, maxAttempts });
  }

  function moveActiveRaid(serverState, slotIndex, nextName) {
    const server = normalizeServerState(serverState?.serverId, serverState);
    if (server.raidMode !== "pair") return server;
    const next = findRaid(server.raidCatalog, nextName);
    if (!next) return server;
    const active = server.activeRaids;
    const slot = slotIndex === 1 ? 1 : 0;
    const other = 1 - slot;
    if (active[other] === next.name) active[other] = active[slot];
    active[slot] = next.name;
    return normalizeServerState(server.serverId, server);
  }

  function toggleActiveRaid(serverState, name) {
    const server = normalizeServerState(serverState?.serverId, serverState);
    if (server.raidMode !== "multi") return unchangedRaid(server, "双副本轮换请调整轮换位");
    const raid = findRaid(server.raidCatalog, name);
    if (!raid) return unchangedRaid(server, "没有这个副本");
    const active = server.activeRaids;
    const index = active.indexOf(raid.name);
    if (index >= 0) {
      if (active.length <= 1) return unchangedRaid(server, "至少保留一个启用的副本");
      active.splice(index, 1);
    } else {
      active.push(raid.name);
    }
    return { changed: true, server: normalizeServerState(server.serverId, server), message: "" };
  }

  function unchangedRaid(server, message) {
    return { changed: false, server, message };
  }

  function addRaid(serverState, name) {
    const server = normalizeServerState(serverState?.serverId, serverState);
    if (!raidNameKey(name)) return unchangedRaid(server, "请输入副本名称");
    if (findRaid(server.raidCatalog, name)) return unchangedRaid(server, "已存在同名副本");
    server.raidCatalog.push({ name: name.trim(), detail: "" });
    return { changed: true, server, message: "" };
  }

  function renameRaid(serverState, oldName, newName) {
    const server = normalizeServerState(serverState?.serverId, serverState);
    const raid = findRaid(server.raidCatalog, oldName);
    if (!raid) return unchangedRaid(server, "没有这个副本");
    if (!raidNameKey(newName)) return unchangedRaid(server, "请输入副本名称");
    const matching = findRaid(server.raidCatalog, newName);
    if (matching && matching !== raid) return unchangedRaid(server, "已存在同名副本");
    const nextName = newName.trim();
    const previousName = raid.name;
    if (nextName === previousName) return unchangedRaid(server, "副本名称没有变化");

    raid.name = nextName;
    server.activeRaids = server.activeRaids.map((name) => name === previousName ? nextName : name);
    for (const zone of serverZones(server)) {
      for (const character of zone.characters) {
        const record = character.raids.find((entry) => entry.name === previousName);
        if (record) record.name = nextName;
      }
    }
    return { changed: true, server, message: "" };
  }

  function removeRaid(serverState, name) {
    const server = normalizeServerState(serverState?.serverId, serverState);
    const raid = findRaid(server.raidCatalog, name);
    if (!raid) return unchangedRaid(server, "没有这个副本");
    const minimum = minimumRaidCount(server.raidMode);
    if (server.raidCatalog.length <= minimum) {
      return unchangedRaid(server, "副本目录至少保留 " + minimum + " 项");
    }

    server.raidCatalog = server.raidCatalog.filter((entry) => entry !== raid);
    const active = server.activeRaids.filter((entry) => entry !== raid.name);
    if (active.length < minimum) {
      const replacement = server.raidCatalog.find((entry) => !active.includes(entry.name));
      server.activeRaids = server.activeRaids.map((entry) => entry === raid.name ? replacement.name : entry);
    } else {
      server.activeRaids = active;
    }
    return { changed: true, server: normalizeServerState(server.serverId, server), message: "" };
  }

  function shanghaiDateParts(value) {
    const clock = value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
    return Object.fromEntries(
      SHANGHAI_CLOCK.formatToParts(clock).map(({ type, value }) => [type, Number(value)]),
    );
  }

  function dailyCycleKey(value) {
    const { year, month, day, hour } = shanghaiDateParts(value);
    const cycleDay = day - Number(hour < DAILY_RESET_HOUR);
    return new Date(Date.UTC(year, month - 1, cycleDay)).toISOString().slice(0, 10);
  }

  function ensureDailyReset(appState, now) {
    const state = normalizeAppState(appState);
    const clock = now instanceof Date ? now : new Date();
    const today = dailyCycleKey(clock);
    const legacy = state.dailyResetHour !== DAILY_RESET_HOUR;
    state.dailyResetHour = DAILY_RESET_HOUR;
    if (legacy && shanghaiDateParts(clock).hour < DAILY_RESET_HOUR) {
      state.dailyDate = today;
      return { state: state, reset: false };
    }
    if (state.dailyDate === today) return { state: state, reset: false };
    state.servers.season = resetDailyProgress(state.servers.season);
    state.servers.regular = resetDailyProgress(state.servers.regular);
    state.dailyDate = today;
    return { state: state, reset: true };
  }

  function snapshotApp(appState) {
    const state = normalizeAppState(appState);
    return {
      activeServer: state.activeServer,
      dailyDate: state.dailyDate,
      dailyResetHour: DAILY_RESET_HOUR,
      servers: state.servers,
    };
  }

  function formatBackup(appState, layoutMode) {
    const data = snapshotApp(appState);
    if (layoutMode === "comfortable" || layoutMode === "compact") {
      data.layoutMode = layoutMode;
    }
    return {
      format: "jinghe-record-backup",
      version: 2,
      exportedAt: new Date().toISOString(),
      data: data,
    };
  }

  function countServer(server) {
    const zones = serverZones(server);
    return {
      accounts: server.accounts.length,
      zones: zones.length,
      characters: zones.reduce((total, zone) => total + zone.characters.length, 0),
    };
  }

  function assertServerLimits(server, label) {
    const counts = countServer(server);
    if (counts.accounts > ACCOUNT_LIMIT) {
      throw new Error(label + "账号超过 " + ACCOUNT_LIMIT + " 个");
    }
    if (counts.characters > CHARACTER_LIMIT) {
      throw new Error(label + "角色超过 " + CHARACTER_LIMIT + " 个");
    }
  }

  function emptyCounts() {
    return {
      season: { accounts: 0, zones: 0, characters: 0 },
      regular: { accounts: 0, zones: 0, characters: 0 },
    };
  }

  function parseBackupText(value) {
    const text = String(value || "").trim();
    if (!text) throw new Error("剪贴板中没有备份内容");
    if (text.length > BACKUP_LIMIT) throw new Error("备份内容过大，无法导入");

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error("剪贴板内容不是有效的备份");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("剪贴板内容不是有效的备份");
    }
    if (parsed.format === "jinghe-record-backup" && parsed.version && ![1, 2].includes(parsed.version)) {
      throw new Error("无法识别的备份版本");
    }

    const source =
      (parsed.format === "jinghe-record-backup" ||
        parsed.format === "season-growth-helper-backup") &&
      parsed.data &&
      typeof parsed.data === "object"
        ? parsed.data
        : parsed;
    const layoutMode =
      source.layoutMode === "comfortable" || source.layoutMode === "compact"
        ? source.layoutMode
        : "";

    if (source.servers && typeof source.servers === "object") {
      const app = normalizeAppState(source);
      assertServerLimits(app.servers.season, "赛季服");
      assertServerLimits(app.servers.regular, "常规服");
      const counts = {
        season: countServer(app.servers.season),
        regular: countServer(app.servers.regular),
      };
      return {
        mode: "platform",
        version: parsed.version || 1,
        app: app,
        server: null,
        dailyDate: app.dailyDate,
        dailyResetHour: app.dailyResetHour,
        layoutMode: layoutMode,
        counts: counts,
        accountCount: counts.season.accounts + counts.regular.accounts,
        zoneCount: counts.season.zones + counts.regular.zones,
        characterCount: counts.season.characters + counts.regular.characters,
      };
    }

    const accounts =
      source.tracker && Array.isArray(source.tracker.accounts)
        ? source.tracker.accounts
        : null;
    if (!accounts) throw new Error("没有找到账号进度数据");

    const server = normalizeServerState("season", {
      serverId: "season",
      maxAttempts: 5,
      activeRaids: source.tracker.activeRaids,
      accounts: accounts,
    });
    assertServerLimits(server, "赛季服");
    const seasonCounts = countServer(server);
    const counts = emptyCounts();
    counts.season = seasonCounts;
    return {
      mode: "legacy-season",
      version: 1,
      app: null,
      server: server,
      dailyDate: typeof source.dailyDate === "string" ? source.dailyDate : "",
      dailyResetHour: Number(source.dailyResetHour) || 0,
      layoutMode: layoutMode,
      counts: counts,
      accountCount: seasonCounts.accounts,
      zoneCount: seasonCounts.zones,
      characterCount: seasonCounts.characters,
    };
  }

  function normalizedName(value) {
    return String(value || "")
      .trim()
      .toLocaleLowerCase();
  }

  function findMatch(items, incoming) {
    return items.find((item) => item.id === incoming.id) ||
      items.find((item) => normalizedName(item.name) === normalizedName(incoming.name));
  }

  function mergeServerAccounts(currentServer, importedServer, legacyZones) {
    const current = normalizeServerState(currentServer.serverId, currentServer);
    const def = getServerDef(current.serverId);
    // Imported custom options are available for selection while the local active list is preserved.
    const builtInNames = new Set(def.raids.map((raid) => raidNameKey(raid.name)));
    const currentNames = new Set(current.raidCatalog.map((raid) => raidNameKey(raid.name)));
    for (const entry of getRaidCatalog(importedServer)) {
      const key = raidNameKey(entry.name);
      if (!currentNames.has(key) && !builtInNames.has(key)) current.raidCatalog.push(entry);
    }
    const imported = normalizeServerState(current.serverId, {
      maxAttempts: current.maxAttempts,
      raidMode: current.raidMode,
      raidCatalog: current.raidCatalog,
      activeRaids: current.activeRaids,
      accounts: importedServer.accounts,
    });
    const added = { accounts: 0, zones: 0, characters: 0 };

    for (const incoming of imported.accounts) {
      const account = findMatch(current.accounts, incoming);
      if (!account) {
        current.accounts.push(incoming);
        added.accounts += 1;
        added.zones += incoming.zones.length;
        added.characters += incoming.zones.reduce((total, zone) => total + zone.characters.length, 0);
        continue;
      }

      for (const importedZone of incoming.zones) {
        const zone = legacyZones && importedZone.name === DEFAULT_ZONE_NAME
          ? account.zones.find((item) => item.name === DEFAULT_ZONE_NAME)
          : findMatch(account.zones, importedZone);
        if (!zone) {
          account.zones.push(importedZone);
          added.zones += 1;
          added.characters += importedZone.characters.length;
          continue;
        }
        for (const character of importedZone.characters) {
          if (findMatch(zone.characters, character)) continue;
          zone.characters.push(character);
          added.characters += 1;
        }
      }
    }

    const server = normalizeServerState(current.serverId, current);
    assertServerLimits(server, getServerDef(current.serverId).label);
    return { server, added };
  }

  function mergeBackup(currentApp, parsed) {
    const next = normalizeAppState(currentApp);
    const legacySeason = parsed.mode === "legacy-season";
    const serverIds = legacySeason ? ["season"] : ["season", "regular"];
    let addedAccounts = 0;
    let addedZones = 0;
    let addedCharacters = 0;

    for (const serverId of serverIds) {
      const imported = legacySeason ? parsed.server : parsed.app.servers[serverId];
      const merged = mergeServerAccounts(next.servers[serverId], imported, legacySeason || parsed.version === 1);
      next.servers[serverId] = merged.server;
      addedAccounts += merged.added.accounts;
      addedZones += merged.added.zones;
      addedCharacters += merged.added.characters;
    }

    return { app: next, addedAccounts, addedZones, addedCharacters };
  }

  function replaceBackup(currentApp, parsed) {
    if (parsed.mode === "legacy-season") {
      const next = normalizeAppState(currentApp);
      next.servers.season = parsed.server;
      if (parsed.dailyDate) next.dailyDate = parsed.dailyDate;
      if (Number(parsed.dailyResetHour) === DAILY_RESET_HOUR) {
        next.dailyResetHour = DAILY_RESET_HOUR;
      }
      return normalizeAppState(next);
    }
    return normalizeAppState(parsed.app);
  }

  return {
    DAILY_RESET_HOUR: DAILY_RESET_HOUR,
    ACCOUNT_LIMIT: ACCOUNT_LIMIT,
    CHARACTER_LIMIT: CHARACTER_LIMIT,
    BACKUP_LIMIT: BACKUP_LIMIT,
    DEFAULT_ZONE_NAME: DEFAULT_ZONE_NAME,
    getServerDef: getServerDef,
    getRaidMode: getRaidMode,
    getRaidCatalog: getRaidCatalog,
    setRaidMode: setRaidMode,
    addRaid: addRaid,
    renameRaid: renameRaid,
    removeRaid: removeRaid,
    createId: createId,
    createCharacter: createCharacter,
    createAccount: createAccount,
    createZone: createZone,
    createServerState: createServerState,
    createAppState: createAppState,
    normalizeServerState: normalizeServerState,
    normalizeAppState: normalizeAppState,
    summarize: summarize,
    resetDailyProgress: resetDailyProgress,
    resetRaidCycle: resetRaidCycle,
    setMaxAttempts: setMaxAttempts,
    moveActiveRaid: moveActiveRaid,
    toggleActiveRaid: toggleActiveRaid,
    dailyCycleKey: dailyCycleKey,
    ensureDailyReset: ensureDailyReset,
    snapshotApp: snapshotApp,
    formatBackup: formatBackup,
    parseBackupText: parseBackupText,
    mergeBackup: mergeBackup,
    replaceBackup: replaceBackup,
  };
});
