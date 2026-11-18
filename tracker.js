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
  const ROSTER_NAME_LIMIT = 40;
  const BACKUP_LIMIT = 4000000;
  const DEFAULT_ZONE_NAME = "默认区";
  const LEGACY_ZONE_ID = "zone-default";
  const ACCOUNT_TOTAL_ATTEMPTS = 180;
  const ROLE_CHARGE = 1;
  const ACCOUNT_TOTAL_CHARGE = 2;
  const ACCOUNT_RAID_CHARGE = 4;
  const CHARACTER_TOTAL_CHARGE = 8;
  const ALL_CHARGES = ROLE_CHARGE | ACCOUNT_TOTAL_CHARGE | ACCOUNT_RAID_CHARGE | CHARACTER_TOTAL_CHARGE;
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

  function hasRaidLimit(raid) {
    return Number.isSafeInteger(raid?.maxAttempts) && raid.maxAttempts >= 1;
  }

  function raidLimit(serverOrNumber, raid) {
    if (hasRaidLimit(raid)) return raid.maxAttempts;
    if (typeof serverOrNumber === "number") return clampMax(serverOrNumber, 5);
    const fallback = getServerDef(serverOrNumber?.serverId).defaultMaxAttempts;
    return clampMax(serverOrNumber?.maxAttempts, fallback);
  }

  function clampRemaining(maxAttempts, value) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return 0;
    return Math.min(maxAttempts, Math.max(0, number));
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

  function createAccountRaidQuota() {
    return {
      total: { remaining: ACCOUNT_TOTAL_ATTEMPTS, maxAttempts: ACCOUNT_TOTAL_ATTEMPTS },
      raids: [],
    };
  }

  function createAccount(name, serverId) {
    return {
      id: createId("account"),
      name: name || "新账号",
      zones: [createZone(DEFAULT_ZONE_NAME)],
      ...(serverId === "regular" ? { raidQuota: createAccountRaidQuota() } : {}),
    };
  }

  function normalizeQuota(value) {
    if (!hasRaidLimit(value)) return null;
    return {
      remaining: clampRemaining(value.maxAttempts, value.remaining),
      maxAttempts: value.maxAttempts,
    };
  }

  function normalizeAccountRaidQuota(value, raidCatalog) {
    const quota = createAccountRaidQuota();
    quota.total = normalizeQuota(value?.total) || quota.total;
    const byName = new Map();
    for (const entry of Array.isArray(value?.raids) ? value.raids : []) {
      const key = raidNameKey(entry?.name);
      const normalized = normalizeQuota(entry);
      if (key && normalized && !byName.has(key)) byName.set(key, normalized);
    }
    for (const { name } of raidCatalog) {
      const entry = byName.get(raidNameKey(name));
      if (entry) quota.raids.push({ name, ...entry });
    }
    return quota;
  }

  function getAccountRaidQuota(account, name = null) {
    const quota = account?.raidQuota;
    if (!quota) return null;
    if (name === null) return quota.total || null;
    return Array.isArray(quota.raids) ? findRaid(quota.raids, name) || null : null;
  }

  function getCharacterRaidQuota(character) {
    return character?.raidRewardQuota || null;
  }

  function validQuota(value) {
    return hasRaidLimit(value) && Number.isSafeInteger(value.remaining) &&
      value.remaining >= 0 && value.remaining <= value.maxAttempts;
  }

  function setCharacterRaidQuota(character, value) {
    if (!Array.isArray(character?.raids) || (value !== null && !validQuota(value))) return false;
    if (value === null) {
      if (!getCharacterRaidQuota(character)) return false;
      delete character.raidRewardQuota;
    } else {
      character.raidRewardQuota = normalizeQuota(value);
    }
    for (const raid of character.raids) clearCharge(raid, CHARACTER_TOTAL_CHARGE);
    return true;
  }

  function explicitCharge(raid) {
    const value = raid?.quotaCharge;
    if (value === undefined) return undefined;
    return Number.isInteger(value) && value >= 0 && value <= ALL_CHARGES ? value : 0;
  }

  function normalizeRaidClears(value, allowed = ALL_CHARGES) {
    const clears = [];
    const ids = new Set();
    for (const entry of value) {
      const id = entry?.id;
      if (typeof id !== "string" || !id.trim() || id.length > 128 || ids.has(id)) continue;
      ids.add(id);
      const charge = Number.isInteger(entry.charge) && entry.charge >= 0 && entry.charge <= ALL_CHARGES
        ? entry.charge & allowed : 0;
      const clear = { id, charge };
      if (Number.isSafeInteger(entry.recordedAt) && entry.recordedAt >= 0 && entry.recordedAt <= 8_640_000_000_000_000) {
        clear.recordedAt = entry.recordedAt;
      }
      clears.push(clear);
    }
    return clears;
  }

  function getRaidClears(raid) {
    if (Array.isArray(raid?.clearsToday)) return normalizeRaidClears(raid.clearsToday);
    if (raid?.doneToday) return [{ id: "legacy", charge: explicitCharge(raid) ?? ROLE_CHARGE }];
    return [];
  }

  function writeRaidClears(raid, clears) {
    raid.doneToday = clears.length > 0;
    delete raid.quotaCharge;
    if (clears.length) raid.clearsToday = clears;
    else delete raid.clearsToday;
  }

  function clearCharge(raid, mask) {
    const previous = getRaidClears(raid);
    if (!previous.some(({ charge }) => charge & mask)) return false;
    const clears = previous.map((clear) => ({ ...clear, charge: clear.charge & ~mask }));
    if (Array.isArray(raid.clearsToday)) writeRaidClears(raid, clears);
    else raid.quotaCharge = clears[0].charge;
    return true;
  }

  function clearRaidCharge(raid) {
    return clearCharge(raid, ROLE_CHARGE);
  }

  function setAccountRaidQuota(account, name, value) {
    if (!Array.isArray(account?.raidQuota?.raids) || (name !== null && !raidNameKey(name))) return false;
    const current = getAccountRaidQuota(account, name);
    if (value === null) {
      if (name === null || !current) return false;
      account.raidQuota.raids.splice(account.raidQuota.raids.indexOf(current), 1);
    } else {
      if (!validQuota(value)) return false;
      const next = normalizeQuota(value);
      if (name === null) account.raidQuota.total = next;
      else if (current) Object.assign(current, next);
      else account.raidQuota.raids.push({ name: name.trim(), ...next });
    }
    const key = raidNameKey(name);
    for (const zone of account.zones || []) {
      for (const character of zone.characters) {
        for (const raid of character.raids) {
          if (name === null) clearCharge(raid, ACCOUNT_TOTAL_CHARGE);
          else if (raidNameKey(raid.name) === key) clearCharge(raid, ACCOUNT_RAID_CHARGE);
        }
      }
    }
    return true;
  }

  function clearBalances(account, character, raid) {
    return [
      { code: "character-raid", flag: ROLE_CHARGE, quota: raid },
      { code: "character-total", flag: CHARACTER_TOTAL_CHARGE, quota: getCharacterRaidQuota(character) },
      { code: "account-raid", flag: ACCOUNT_RAID_CHARGE, quota: getAccountRaidQuota(account, raid.name) },
      { code: "account-total", flag: ACCOUNT_TOTAL_CHARGE, quota: getAccountRaidQuota(account) },
    ].filter(({ quota }) => quota);
  }

  function raidClearBlockers(account, character, raid) {
    if (!raidNameKey(raid?.name)) return ["character-raid"];
    return clearBalances(account, character, raid)
      .filter(({ quota }) => !(quota.remaining > 0))
      .map(({ code }) => code);
  }

  function raidOwner(account, raid) {
    for (const zone of account?.zones || []) {
      const owner = zone.characters.find((character) => character.raids.includes(raid));
      if (owner) return owner;
    }
    return null;
  }

  function canCompleteRaid(account, raid) {
    return Boolean(raid && !raid.doneToday && !raidClearBlockers(account, raidOwner(account, raid), raid).length);
  }

  function debitRaidClear(server, account, character, raid) {
    if (server.serverId === "regular" && !account.raidQuota) account.raidQuota = createAccountRaidQuota();
    let charge = 0;
    for (const { flag, quota } of clearBalances(account, character, raid)) {
      quota.remaining -= 1;
      charge |= flag;
    }
    return charge;
  }

  function refundRaidClear(server, account, character, raid, charge) {
    for (const { flag, quota } of clearBalances(account, character, raid)) {
      if (!(charge & flag)) continue;
      const max = flag === ROLE_CHARGE ? raidLimit(server, raid) : quota.maxAttempts;
      quota.remaining = Math.min(max, quota.remaining + 1);
    }
  }

  function recordRaidClear(server, account, character, raid) {
    if (!server || !account || !character || !raid || raidOwner(account, raid) !== character ||
        raidClearBlockers(account, character, raid).length) return null;
    const clears = getRaidClears(raid);
    const id = globalThis.crypto?.randomUUID?.() ?? createId("raid-clear");
    const recordedAt = Date.now();
    const charge = debitRaidClear(server, account, character, raid);
    writeRaidClears(raid, [...clears, { id, charge, recordedAt }]);
    return id;
  }

  function undoRaidClear(server, account, character, raid, id) {
    if (!server || !account || !character || !raid || raidOwner(account, raid) !== character) return false;
    const clears = getRaidClears(raid);
    const chosen = clears.find((clear) => clear.id === id);
    if (!chosen) return false;
    refundRaidClear(server, account, character, raid, chosen.charge);
    writeRaidClears(raid, clears.filter((clear) => clear !== chosen));
    return true;
  }

  function raidCompletionState(server, raid) {
    return {
      doneToday: raid.doneToday,
      remaining: raid.remaining,
      quotaCharge: raid.quotaCharge,
      clearsToday: raid.clearsToday,
      maxAttempts: raidLimit(server, raid),
    };
  }

  function applyRaidCompletion(server, account, raid, doneToday) {
    if (!server || !account || !raid || typeof doneToday !== "boolean" || raid.doneToday === doneToday) return null;
    const character = raidOwner(account, raid);
    if (doneToday && raidClearBlockers(account, character, raid).length) return null;
    if (server.serverId === "regular" && !account.raidQuota) account.raidQuota = createAccountRaidQuota();
    const before = raidCompletionState(server, raid);
    const quotas = clearBalances(account, character, raid).filter(({ flag }) => flag !== ROLE_CHARGE)
      .map(({ flag, quota }) => ({ flag, quota, before: quota.remaining, maxAttempts: quota.maxAttempts }));
    if (doneToday) {
      const charge = debitRaidClear(server, account, character, raid);
      delete raid.clearsToday;
      raid.doneToday = true;
      if (server.serverId === "regular" || (charge & CHARACTER_TOTAL_CHARGE)) raid.quotaCharge = charge;
    } else {
      const clears = getRaidClears(raid);
      const last = clears.pop();
      if (!last) return null;
      refundRaidClear(server, account, character, raid, last.charge);
      writeRaidClears(raid, clears);
    }
    const changes = quotas.filter(({ quota, before }) => quota.remaining !== before)
      .map(({ flag, quota, before, maxAttempts }) => ({ flag, before, after: quota.remaining, maxAttempts }));
    const characterQuota = changes.find(({ flag }) => flag === CHARACTER_TOTAL_CHARGE);
    return {
      serverId: server.serverId,
      accountId: account.id,
      raidName: raid.name,
      before,
      after: raidCompletionState(server, raid),
      accountQuotas: changes.filter(({ flag }) => flag !== CHARACTER_TOTAL_CHARGE)
        .map(({ flag, ...change }) => ({ name: flag === ACCOUNT_TOTAL_CHARGE ? null : raid.name, ...change })),
      ...(characterQuota ? { characterQuota } : {}),
    };
  }

  function undoRaidCompletion(server, account, raid, operation) {
    if (!server || !account || !raid || !operation || operation.serverId !== server.serverId || operation.accountId !== account.id ||
        operation.raidName !== raid.name) return false;
    const current = raidCompletionState(server, raid);
    if (!Object.entries(operation.after).every(([key, value]) => (
      key === "clearsToday" ? JSON.stringify(current[key]) === JSON.stringify(value) : current[key] === value
    ))) return false;
    const quotas = operation.accountQuotas.map((change) => ({
      change, quota: getAccountRaidQuota(account, change.name),
    }));
    if (operation.characterQuota) {
      quotas.push({ change: operation.characterQuota, quota: getCharacterRaidQuota(raidOwner(account, raid)) });
    }
    if (!quotas.every(({ quota, change }) => quota?.remaining === change.after && quota.maxAttempts === change.maxAttempts)) {
      return false;
    }
    const { doneToday, remaining, quotaCharge, clearsToday } = operation.before;
    raid.doneToday = doneToday;
    raid.remaining = remaining;
    if (quotaCharge === undefined) delete raid.quotaCharge;
    else raid.quotaCharge = quotaCharge;
    if (clearsToday === undefined) delete raid.clearsToday;
    else raid.clearsToday = clearsToday;
    for (const { quota, change } of quotas) quota.remaining = change.before;
    return true;
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

  function profileText(value) {
    return typeof value === "string" || typeof value === "number"
      ? String(value).normalize("NFKC").trim()
      : "";
  }

  function normalizeCharacterProfile(value) {
    const profile = {};
    const level = profileText(value?.level);
    const power = profileText(value?.power)
      .replace(/萬/g, "万")
      .replace(/億/g, "亿")
      .replace(/\s+(?=[万亿兆])/g, "");
    if (/^\d+$/.test(level) && Number.isSafeInteger(Number(level)) && Number(level) >= 1) {
      profile.level = Number(level);
    }
    if (/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?[万亿兆]?$/.test(power)) {
      profile.power = power;
    }
    return profile;
  }

  function normalizeCharacter(source, id, index, activeRaids, maxAttempts, quotaRaids) {
    const sourceRaids = Array.isArray(source.raids) ? source.raids : [];
    const byName = new Map();
    for (const raid of sourceRaids) {
      const key = raidNameKey(raid?.name);
      if (key && !byName.has(key)) byName.set(key, raid);
    }
    const characterQuota = quotaRaids ? normalizeQuota(source.raidRewardQuota) : null;
    return {
      id,
      name: normalizeName(source.name, "角色" + (index + 1)),
      staminaDone: source.staminaDone === true,
      ...normalizeCharacterProfile(source),
      ...(characterQuota ? { raidRewardQuota: characterQuota } : {}),
      raids: activeRaids.map(function normalizeRaid(raidName) {
        const existing = byName.get(raidNameKey(raidName));
        const allowed = ROLE_CHARGE
          | (characterQuota ? CHARACTER_TOTAL_CHARGE : 0)
          | (quotaRaids ? ACCOUNT_TOTAL_CHARGE : 0)
          | (quotaRaids?.has(raidName) ? ACCOUNT_RAID_CHARGE : 0);
        const explicitClears = Array.isArray(existing?.clearsToday);
        const clears = explicitClears ? normalizeRaidClears(existing.clearsToday, allowed) : [];
        const doneToday = explicitClears ? clears.length > 0 : existing?.doneToday === true;
        const charge = !explicitClears && doneToday ? explicitCharge(existing) : undefined;
        return {
          name: raidName,
          remaining: existing
            ? clampRemaining(raidLimit(maxAttempts, existing), existing.remaining)
            : maxAttempts,
          doneToday,
          ...(hasRaidLimit(existing) ? { maxAttempts: existing.maxAttempts } : {}),
          ...(charge === undefined ? {} : { quotaCharge: charge & allowed }),
          ...(clears.length ? { clearsToday: clears } : {}),
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
        const raidQuota = def.id === "regular" ? normalizeAccountRaidQuota(account.raidQuota, raidCatalog) : null;
        const quotaRaids = raidQuota ? new Set(raidQuota.raids.map(({ name }) => name)) : null;
        return {
          id,
          name: normalizeName(account.name, "账号" + (accountIndex + 1)),
          ...(raidQuota ? { raidQuota } : {}),
          zones: normalizeSiblings(sourceZones, "zone", (zone, zoneId, zoneIndex) => ({
            id: zoneId,
            name: normalizeName(zone.name, "区服" + (zoneIndex + 1)),
            characters: normalizeSiblings(zone.characters, "character", (character, characterId, index) =>
              normalizeCharacter(character, characterId, index, activeRaids, maxAttempts, quotaRaids)
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

  function summarize(serverState, { repeatable = false } = {}) {
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
    for (const account of server.accounts) {
      for (const zone of account.zones) {
        for (const character of zone.characters) {
          characterCount += 1;
          if (character.staminaDone) staminaDone += 1;
          for (const raid of character.raids) {
            const bucket = totals.get(raid.name);
            const clears = repeatable ? getRaidClears(raid).length : Number(raid.doneToday);
            const pending = (repeatable || !raid.doneToday) && !raidClearBlockers(account, character, raid).length;
            bucket.characters += 1;
            bucket.remaining += raid.remaining;
            bucket.doneToday += clears;
            raidsDoneToday += clears;
            const required = repeatable ? clears + Number(pending) : Number(clears > 0 || pending);
            bucket.requiredToday += required;
            raidsRequiredToday += required;
            if (pending) raidsPending += 1;
          }
        }
      }
    }

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
          writeRaidClears(raid, []);
        });
      });
    });
    return server;
  }

  function resetRaidCycle(serverState, { accountId = "", raidName = "", restoreTotal = !raidName } = {}) {
    const server = normalizeServerState(serverState && serverState.serverId, serverState);
    const selectedRaid = raidNameKey(raidName);
    const inScope = (raid) => !selectedRaid || raidNameKey(raid.name) === selectedRaid;
    for (const account of server.accounts) {
      if (accountId && account.id !== accountId) continue;
      if (account.raidQuota && restoreTotal) {
        const { maxAttempts } = account.raidQuota.total;
        setAccountRaidQuota(account, null, { maxAttempts, remaining: maxAttempts });
      }
      for (const quota of account.raidQuota?.raids || []) {
        if (inScope(quota)) quota.remaining = quota.maxAttempts;
      }
      for (const zone of account.zones) {
        for (const character of zone.characters) {
          const characterQuota = getCharacterRaidQuota(character);
          if (!selectedRaid && characterQuota) {
            setCharacterRaidQuota(character, { remaining: characterQuota.maxAttempts, maxAttempts: characterQuota.maxAttempts });
          }
          for (const raid of character.raids) {
            if (!inScope(raid)) continue;
            raid.remaining = raidLimit(server, raid);
            const mask = ROLE_CHARGE | ACCOUNT_RAID_CHARGE;
            const retained = getRaidClears(raid)
              .map((clear) => ({ ...clear, charge: clear.charge & ~mask }))
              .filter(({ charge }) => charge > 0);
            if (Array.isArray(raid.clearsToday) || !retained.length) writeRaidClears(raid, retained);
            else raid.quotaCharge = retained[0].charge;
          }
        }
      }
    }
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
    const server = normalizeServerState(serverState?.serverId, { ...serverState, maxAttempts });
    const before = clampMax(serverState?.maxAttempts, getServerDef(server.serverId).defaultMaxAttempts);
    if (server.maxAttempts !== before) {
      for (const zone of serverZones(server)) {
        for (const character of zone.characters) {
          for (const raid of character.raids) {
            if (!hasRaidLimit(raid)) clearRaidCharge(raid);
          }
        }
      }
    }
    return server;
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
    for (const account of server.accounts) {
      const quota = getAccountRaidQuota(account, previousName);
      if (quota) quota.name = nextName;
    }
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

  function readRosterName(value, fallback) {
    return (typeof value === "string" ? value.trim() : "") || fallback;
  }

  function validateRosterName(name, label, location) {
    if (!name) throw new Error(location + "缺少" + label);
    if (name.length > ROSTER_NAME_LIMIT) {
      throw new Error(location + label + "最多 " + ROSTER_NAME_LIMIT + " 个字符");
    }
    return name;
  }

  function validateRosterProfile(fields, location) {
    const profile = normalizeCharacterProfile(fields);
    if (fields.level !== undefined && profile.level === undefined) {
      throw new Error(location + "等级须为大于等于 1 的整数");
    }
    if (fields.power !== undefined && profile.power === undefined) {
      throw new Error(location + "战力格式无效，请填写数字，可带小数、千分位逗号或万、亿单位");
    }
    return profile;
  }

  function rosterRow(fields, defaults, location) {
    return {
      account: validateRosterName(readRosterName(fields.account, defaults.account), "账号名称", location),
      zone: validateRosterName(readRosterName(fields.zone, defaults.zone), "区服名称", location),
      character: validateRosterName(readRosterName(fields.character, ""), "角色名称", location),
      ...validateRosterProfile(fields, location),
    };
  }

  function rosterFields(line, location) {
    const fields = {};
    const plain = [];
    for (const [index, part] of line.split(/[|｜]/).entries()) {
      const metadata = index > 0 && part.match(/^\s*(等级|战力)\s*[：:]\s*(.*)$/);
      if (!metadata) {
        plain.push(part);
        continue;
      }
      const key = metadata[1] === "等级" ? "level" : "power";
      if (fields[key] !== undefined) throw new Error(location + metadata[1] + "只能填写一次");
      fields[key] = metadata[2].trim();
    }
    return { plain, fields };
  }

  function parseRosterText(raw, defaults = {}) {
    const target = {
      account: readRosterName(defaults?.account, ""),
      zone: readRosterName(defaults?.zone, DEFAULT_ZONE_NAME),
    };
    const rows = [];
    const lines = String(raw ?? "").split(/\r\n|\n|\r/);
    let account = target.account;
    let zone = target.zone;

    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const location = "第 " + (index + 1) + " 行：";
      const { plain, fields } = rosterFields(line, location);
      const text = plain.join("|");
      const label = plain.length === 1 && text.match(/^\s*(账号|区服|角色名|角色)\s*[：:]\s*(.*)$/);
      if (label) {
        const name = label[2].trim();
        if (label[1] === "账号" || label[1] === "区服") {
          if (Object.keys(fields).length) throw new Error(location + "等级、战力请填在角色行");
          validateRosterName(name, label[1] + "名称", location);
          if (label[1] === "账号") {
            account = name;
            zone = target.zone;
          } else {
            zone = name;
          }
        } else {
          rows.push(rosterRow({ character: name, ...fields }, { account, zone }, location));
        }
        continue;
      }

      const columns = text.includes("\t")
        ? text.split("\t")
        : plain.length > 1
          ? plain
          : text.split(/\s+[/／](?=\s)/);
      if (columns.length === 1) {
        rows.push(rosterRow({ character: columns[0], ...fields }, { account, zone }, location));
        continue;
      }
      if (columns.length !== 3) throw new Error(location + "请填写账号、区服、角色三列");
      const [rowAccount, rowZone, character] = columns;
      rows.push(rosterRow({ account: rowAccount, zone: rowZone, character, ...fields }, { account, zone }, location));
    }
    return rows;
  }

  function rosterMatches(items, name) {
    const key = normalizedName(name);
    return items.filter((item) => normalizedName(item.name) === key);
  }

  function importRoster(serverState, rows) {
    if (!Array.isArray(rows)) throw new Error("角色名单格式无效");
    const server = normalizeServerState(serverState?.serverId, serverState);
    const label = getServerDef(server.serverId).label;
    assertServerLimits(server, label);
    let characterCount = countServer(server).characters;
    let addedAccounts = 0;
    let addedZones = 0;
    let addedCharacters = 0;
    let updatedCharacters = 0;
    let skippedCharacters = 0;
    for (const [index, value] of rows.entries()) {
      const location = "第 " + (index + 1) + " 条：";
      const row = rosterRow(value || {}, { account: "", zone: DEFAULT_ZONE_NAME }, location);
      const accounts = rosterMatches(server.accounts, row.account);
      if (accounts.length > 1) throw new Error(location + "有多个同名账号「" + row.account + "」，请先区分名称");
      let [account] = accounts;
      if (!account) {
        if (server.accounts.length >= ACCOUNT_LIMIT) {
          throw new Error(location + label + "账号超过 " + ACCOUNT_LIMIT + " 个");
        }
        account = createAccount(row.account, server.serverId);
        account.zones[0].name = row.zone;
        server.accounts.push(account);
        addedAccounts += 1;
        addedZones += 1;
      }

      const zones = rosterMatches(account.zones, row.zone);
      if (zones.length > 1) {
        throw new Error(location + "账号「" + account.name + "」有多个同名区服「" + row.zone + "」，请先区分名称");
      }
      let [zone] = zones;
      if (!zone) {
        zone = createZone(row.zone);
        account.zones.push(zone);
        addedZones += 1;
      }

      const characters = rosterMatches(zone.characters, row.character);
      const profile = normalizeCharacterProfile(row);
      if (characters.length) {
        const changes = characters.some((character) =>
          Object.entries(profile).some(([field, value]) => character[field] !== value)
        );
        if (!changes) {
          skippedCharacters += 1;
          continue;
        }
        if (characters.length > 1) {
          throw new Error(location + "区服「" + zone.name + "」有多个同名角色「" + row.character + "」，无法更新资料");
        }
        Object.assign(characters[0], profile);
        updatedCharacters += 1;
        continue;
      }

      if (characterCount >= CHARACTER_LIMIT) {
        throw new Error(location + label + "角色超过 " + CHARACTER_LIMIT + " 个");
      }
      const character = createCharacter(row.character, server.activeRaids, server.maxAttempts);
      zone.characters.push(Object.assign(character, profile));
      characterCount += 1;
      addedCharacters += 1;
    }
    return { server, addedAccounts, addedZones, addedCharacters, updatedCharacters, skippedCharacters };
  }

  function raidCountRow(fields, defaults, location) {
    const { account, zone, character } = rosterRow({
      account: fields.account,
      zone: fields.zone,
      character: fields.character,
    }, defaults, location);
    const raid = validateRosterName(readRosterName(fields.raid, ""), "团本名称", location);
    const reading = readRosterName(fields.reading, "");
    const value = reading.normalize("NFKC").match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!value) throw new Error(location + "团本次数请填写成 3/5 这样的格式");
    const numerator = Number(value[1]);
    const denominator = Number(value[2]);
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
        denominator < 1 || numerator > denominator) {
      throw new Error(location + "次数必须是 0 到上限之间的整数，上限至少为 1");
    }
    return { account, zone, character, raid, reading, numerator, denominator };
  }

  function collectRaidCountRow(entries, row, location) {
    const key = JSON.stringify([
      normalizedName(row.account), normalizedName(row.zone), normalizedName(row.character), raidNameKey(row.raid),
    ]);
    const previous = entries.get(key);
    if (previous) {
      if (previous.numerator !== row.numerator || previous.denominator !== row.denominator) {
        const identity = [row.account, row.zone, row.character, row.raid].join(" / ");
        throw new Error(location + "「" + identity + "」的次数冲突：" + previous.reading + " 与 " + row.reading);
      }
      return;
    }
    entries.set(key, row);
  }

  function parseRaidCountText(raw, defaults = {}) {
    const target = {
      account: readRosterName(defaults?.account, ""),
      zone: readRosterName(defaults?.zone, DEFAULT_ZONE_NAME),
    };
    const entries = new Map();
    const lines = String(raw ?? "").split(/\r\n|\n|\r/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const location = "第 " + (index + 1) + " 行：";
      const columns = /[|｜]/.test(line) ? line.split(/[|｜]/) : line.split("\t");
      let fields;
      if (columns.length === 3) {
        const [character, raid, reading] = columns;
        fields = { character, raid, reading };
      } else if (columns.length === 5) {
        const [account, zone, character, raid, reading] = columns;
        fields = { account, zone, character, raid, reading };
      } else {
        throw new Error(location + "请填写角色、团本、次数三列，或加上账号和区服共五列");
      }
      collectRaidCountRow(entries, raidCountRow(fields, target, location), location);
    }
    return Array.from(entries.values());
  }

  function exactRosterEntry(items, name, label, location) {
    const matches = rosterMatches(items, name);
    if (matches.length > 1) throw new Error(location + "有多个同名" + label + "「" + name + "」，请先区分名称");
    if (!matches.length) throw new Error(location + "找不到" + label + "「" + name + "」");
    return matches[0];
  }

  function importRaidCounts(serverState, rows, basis) {
    if (basis !== "remaining" && basis !== "used") throw new Error("请先选择 X/Y 中的 X 是剩余次数还是已用次数");
    if (!Array.isArray(rows)) throw new Error("团本次数名单格式无效");

    const entries = new Map();
    const defaults = { account: "", zone: DEFAULT_ZONE_NAME };
    for (const [index, fields] of rows.entries()) {
      const location = "第 " + (index + 1) + " 条：";
      collectRaidCountRow(entries, raidCountRow(fields || {}, defaults, location), location);
    }

    const server = normalizeServerState(serverState?.serverId, serverState);
    const pair = getRaidMode(server) === "pair";
    const active = new Set(server.activeRaids);
    const enabledRaids = [];
    let updatedRaids = 0;
    for (const row of entries.values()) {
      const location = "「" + [row.account, row.zone, row.character, row.raid].join(" / ") + "」：";
      const account = exactRosterEntry(server.accounts, row.account, "账号", location);
      const zone = exactRosterEntry(account.zones, row.zone, "区服", location);
      const character = exactRosterEntry(zone.characters, row.character, "角色", location);
      let option = findRaid(server.raidCatalog, row.raid);
      if (pair && (!option || !active.has(option.name))) {
        throw new Error(location + (option ? "请先选为轮换团本" : "请先加入目录并选为轮换团本") + "，或切换到多选模式");
      }
      if (!option) {
        option = { name: row.raid, detail: "" };
        server.raidCatalog.push(option);
      }
      if (!active.has(option.name)) {
        active.add(option.name);
        enabledRaids.push(option.name);
      }

      const remaining = basis === "remaining" ? row.numerator : row.denominator - row.numerator;
      const entry = character.raids.find((raid) => raid.name === option.name);
      if (!entry) {
        character.raids.push({ name: option.name, remaining, maxAttempts: row.denominator, doneToday: false });
      } else {
        const chargeCleared = clearRaidCharge(entry);
        if (entry.remaining === remaining && entry.maxAttempts === row.denominator && !chargeCleared) continue;
        Object.assign(entry, { remaining, maxAttempts: row.denominator });
      }
      updatedRaids += 1;
    }

    server.activeRaids = Array.from(active);
    return { server: normalizeServerState(server.serverId, server), updatedRaids, enabledRaids };
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

      // Keep the current shared balance. Charges on imported roles cannot be refunded against it.
      if (account.raidQuota) {
        for (const quota of incoming.raidQuota.raids) {
          if (!getAccountRaidQuota(account, quota.name)) account.raidQuota.raids.push(quota);
        }
        for (const zone of incoming.zones) {
          for (const character of zone.characters) {
            for (const raid of character.raids) clearCharge(raid, ACCOUNT_TOTAL_CHARGE | ACCOUNT_RAID_CHARGE);
          }
        }
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
    ACCOUNT_TOTAL_ATTEMPTS: ACCOUNT_TOTAL_ATTEMPTS,
    getServerDef: getServerDef,
    getRaidMode: getRaidMode,
    getRaidCatalog: getRaidCatalog,
    setRaidMode: setRaidMode,
    addRaid: addRaid,
    renameRaid: renameRaid,
    removeRaid: removeRaid,
    createId: createId,
    createCharacter: createCharacter,
    normalizeCharacterProfile: normalizeCharacterProfile,
    parseRosterText: parseRosterText,
    importRoster: importRoster,
    parseRaidCountText: parseRaidCountText,
    importRaidCounts: importRaidCounts,
    raidLimit: raidLimit,
    getAccountRaidQuota: getAccountRaidQuota,
    setAccountRaidQuota: setAccountRaidQuota,
    getCharacterRaidQuota: getCharacterRaidQuota,
    setCharacterRaidQuota: setCharacterRaidQuota,
    clearRaidCharge: clearRaidCharge,
    raidClearBlockers: raidClearBlockers,
    getRaidClears: getRaidClears,
    recordRaidClear: recordRaidClear,
    undoRaidClear: undoRaidClear,
    canCompleteRaid: canCompleteRaid,
    applyRaidCompletion: applyRaidCompletion,
    undoRaidCompletion: undoRaidCompletion,
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
