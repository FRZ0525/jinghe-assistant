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

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function catalogNames(def) {
    return def.raids.map(function raidName(raid) {
      return raid.name;
    });
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

  function normalizeActiveRaids(def, value) {
    const names = catalogNames(def);
    const source = Array.isArray(value) ? value : [];
    const picked = [];
    source.forEach(function pick(name) {
      if (names.includes(name) && !picked.includes(name)) picked.push(name);
    });

    if (def.raidMode === "pair") {
      const first = picked[0] || def.defaultActive[0];
      let second = picked[1] || def.defaultActive[1];
      if (second === first) {
        second =
          names.find(function different(name) {
            return name !== first;
          }) || first;
      }
      return [first, second];
    }

    if (!picked.length) {
      return def.defaultActive.filter(function known(name) {
        return names.includes(name);
      });
    }
    return names.filter(function selected(name) {
      return picked.includes(name);
    });
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

  function createAccount(name) {
    return {
      id: createId("account"),
      name: name || "新账号",
      characters: [],
    };
  }

  function normalizeCharacter(value, index, activeRaids, maxAttempts) {
    const source = value && typeof value === "object" ? value : {};
    const sourceRaids = Array.isArray(source.raids) ? source.raids : [];
    return {
      id: typeof source.id === "string" && source.id ? source.id : createId("character"),
      name:
        typeof source.name === "string" && source.name.trim()
          ? source.name.trim()
          : "角色" + (index + 1),
      staminaDone: source.staminaDone === true,
      raids: activeRaids.map(function normalizeRaid(raidName) {
        const existing = sourceRaids.find(function matchRaid(raid) {
          return raid && raid.name === raidName;
        });
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
    const activeRaids = normalizeActiveRaids(def, source.activeRaids);
    const sourceAccounts = Array.isArray(source.accounts) ? source.accounts : [];
    return {
      serverId: def.id,
      maxAttempts: maxAttempts,
      activeRaids: activeRaids,
      accounts: sourceAccounts.map(function normalizeAccount(account, accountIndex) {
        const accountSource = account && typeof account === "object" ? account : {};
        const characters = Array.isArray(accountSource.characters)
          ? accountSource.characters
          : [];
        return {
          id:
            typeof accountSource.id === "string" && accountSource.id
              ? accountSource.id
              : createId("account"),
          name:
            typeof accountSource.name === "string" && accountSource.name.trim()
              ? accountSource.name.trim()
              : "账号" + (accountIndex + 1),
          characters: characters.map(function mapCharacter(character, characterIndex) {
            return normalizeCharacter(
              character,
              characterIndex,
              activeRaids,
              maxAttempts,
            );
          }),
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

  function summarize(serverState) {
    const server = normalizeServerState(serverState && serverState.serverId, serverState);
    const def = getServerDef(server.serverId);
    const totals = {};
    server.activeRaids.forEach(function initRaid(name) {
      const raid = def.raids.find(function match(item) {
        return item.name === name;
      });
      totals[name] = {
        name: name,
        detail: raid ? raid.detail : "",
        characters: 0,
        remaining: 0,
        doneToday: 0,
        requiredToday: 0,
      };
    });

    let characterCount = 0;
    let staminaDone = 0;
    let raidsDoneToday = 0;
    let raidsRequiredToday = 0;
    let raidsPending = 0;

    server.accounts.forEach(function walkAccount(account) {
      account.characters.forEach(function walkCharacter(character) {
        characterCount += 1;
        if (character.staminaDone) staminaDone += 1;
        character.raids.forEach(function walkRaid(raid) {
          const bucket = totals[raid.name];
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
      characterCount: characterCount,
      staminaDone: staminaDone,
      staminaPending: characterCount - staminaDone,
      raidsDoneToday: raidsDoneToday,
      raidsRequiredToday: raidsRequiredToday,
      raidsPending: raidsPending,
      raids: server.activeRaids.map(function raidSummary(name) {
        return totals[name];
      }),
    };
  }

  function resetDailyProgress(serverState) {
    const server = normalizeServerState(serverState && serverState.serverId, serverState);
    server.accounts.forEach(function resetAccount(account) {
      account.characters.forEach(function resetCharacter(character) {
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
    server.accounts.forEach(function resetAccount(account) {
      account.characters.forEach(function resetCharacter(character) {
        character.raids.forEach(function resetRaid(raid) {
          raid.remaining = server.maxAttempts;
          raid.doneToday = false;
        });
      });
    });
    return server;
  }

  function setMaxAttempts(serverState, maxAttempts) {
    return normalizeServerState(serverState && serverState.serverId, {
      serverId: serverState && serverState.serverId,
      maxAttempts: maxAttempts,
      activeRaids: serverState && serverState.activeRaids,
      accounts: serverState && serverState.accounts,
    });
  }

  function moveActiveRaid(serverState, slotIndex, nextName) {
    const server = normalizeServerState(serverState && serverState.serverId, serverState);
    const def = getServerDef(server.serverId);
    if (def.raidMode !== "pair") return server;
    const names = catalogNames(def);
    if (!names.includes(nextName)) return server;
    const active = server.activeRaids.slice();
    const slot = slotIndex === 1 ? 1 : 0;
    const other = slot === 0 ? 1 : 0;
    const oldName = active[slot];
    if (active[other] === nextName) active[other] = oldName;
    active[slot] = nextName;
    server.activeRaids = active;
    return normalizeServerState(server.serverId, server);
  }

  function toggleActiveRaid(serverState, name) {
    const server = normalizeServerState(serverState && serverState.serverId, serverState);
    const def = getServerDef(server.serverId);
    if (def.raidMode !== "multi") {
      return { server: server, changed: false, message: "赛季服请改两个轮换位" };
    }
    if (!catalogNames(def).includes(name)) {
      return { server: server, changed: false, message: "没有这个副本" };
    }
    const active = server.activeRaids.slice();
    const index = active.indexOf(name);
    if (index >= 0) {
      if (active.length <= 1) {
        return { server: server, changed: false, message: "至少保留一个副本" };
      }
      active.splice(index, 1);
    } else {
      active.push(name);
    }
    server.activeRaids = active;
    return {
      server: normalizeServerState(server.serverId, server),
      changed: true,
      message: "",
    };
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
      version: 1,
      exportedAt: new Date().toISOString(),
      data: data,
    };
  }

  function countServer(server) {
    const characters = server.accounts.reduce(function add(total, account) {
      return total + account.characters.length;
    }, 0);
    return {
      accounts: server.accounts.length,
      characters: characters,
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
      season: { accounts: 0, characters: 0 },
      regular: { accounts: 0, characters: 0 },
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
    if (parsed.format === "jinghe-record-backup" && parsed.version && parsed.version !== 1) {
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
        app: app,
        server: null,
        dailyDate: app.dailyDate,
        dailyResetHour: app.dailyResetHour,
        layoutMode: layoutMode,
        counts: counts,
        accountCount: counts.season.accounts + counts.regular.accounts,
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
      app: null,
      server: server,
      dailyDate: typeof source.dailyDate === "string" ? source.dailyDate : "",
      dailyResetHour: Number(source.dailyResetHour) || 0,
      layoutMode: layoutMode,
      counts: counts,
      accountCount: seasonCounts.accounts,
      characterCount: seasonCounts.characters,
    };
  }

  function normalizedName(value) {
    return String(value || "")
      .trim()
      .toLocaleLowerCase();
  }

  function mergeServerAccounts(currentServer, importedServer) {
    const current = normalizeServerState(currentServer.serverId, currentServer);
    const imported = normalizeServerState(current.serverId, {
      serverId: current.serverId,
      maxAttempts: current.maxAttempts,
      activeRaids: current.activeRaids,
      accounts: importedServer.accounts,
    });
    let addedAccounts = 0;
    let addedCharacters = 0;

    imported.accounts.forEach(function mergeAccount(importedAccount) {
      const account = current.accounts.find(function findAccount(item) {
        return (
          item.id === importedAccount.id ||
          normalizedName(item.name) === normalizedName(importedAccount.name)
        );
      });
      if (!account) {
        current.accounts.push(clone(importedAccount));
        addedAccounts += 1;
        addedCharacters += importedAccount.characters.length;
        return;
      }
      importedAccount.characters.forEach(function mergeCharacter(importedCharacter) {
        const exists = account.characters.some(function findCharacter(item) {
          return (
            item.id === importedCharacter.id ||
            normalizedName(item.name) === normalizedName(importedCharacter.name)
          );
        });
        if (!exists) {
          account.characters.push(clone(importedCharacter));
          addedCharacters += 1;
        }
      });
    });

    const server = normalizeServerState(current.serverId, current);
    assertServerLimits(server, getServerDef(current.serverId).label);
    return {
      server: server,
      addedAccounts: addedAccounts,
      addedCharacters: addedCharacters,
    };
  }

  function mergeBackup(currentApp, parsed) {
    const next = normalizeAppState(currentApp);
    let addedAccounts = 0;
    let addedCharacters = 0;

    if (parsed.mode === "legacy-season") {
      const merged = mergeServerAccounts(next.servers.season, parsed.server);
      next.servers.season = merged.server;
      addedAccounts += merged.addedAccounts;
      addedCharacters += merged.addedCharacters;
    } else {
      ["season", "regular"].forEach(function mergeOne(serverId) {
        const merged = mergeServerAccounts(
          next.servers[serverId],
          parsed.app.servers[serverId],
        );
        next.servers[serverId] = merged.server;
        addedAccounts += merged.addedAccounts;
        addedCharacters += merged.addedCharacters;
      });
    }

    return {
      app: normalizeAppState(next),
      addedAccounts: addedAccounts,
      addedCharacters: addedCharacters,
    };
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
    getServerDef: getServerDef,
    createId: createId,
    createCharacter: createCharacter,
    createAccount: createAccount,
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
