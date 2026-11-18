(function attach(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./tracker"));
  } else {
    root.JingheSyncMerge = factory(root.Tracker);
  }
})(globalThis, function createSyncMerge(Tracker) {
  "use strict";

  const missing = Symbol("missing");
  const serverIds = ["regular", "season"];
  const raidProgressFields = ["doneToday", "remaining", "quotaCharge", "clearsToday"];
  const accountTotalScope = JSON.stringify(["account"]);
  const children = {
    document: { servers: "servers" },
    servers: { regular: "server", season: "server" },
    server: { accounts: "accounts", raidCatalog: "catalog" },
    account: { zones: "zones", raidQuota: "raidQuota" },
    raidQuota: { total: "accountQuota", raids: "quotaRaids" },
    zone: { characters: "characters" },
    character: { raids: "raids", raidRewardQuota: "characterQuota" },
    raid: { clearsToday: "clears" },
  };
  const collections = {
    accounts: { key: "id", shape: "account", label: "账号" },
    zones: { key: "id", shape: "zone", label: "区服" },
    characters: { key: "id", shape: "character", label: "角色" },
    raids: { key: "name", shape: "raid", label: "团本" },
    clears: { key: "id", shape: "clear", label: "通关" },
    quotaRaids: { key: "name", shape: "accountQuota", label: "账号团本" },
    catalog: { key: "name", shape: "option", label: "团本目录" },
  };
  const labels = new Map(Object.entries({
    servers: "两服",
    regular: "常规服",
    season: "赛季服",
    dailyDate: "记录日期",
    dailyResetHour: "刷新时刻",
    activeRaids: "启用团本",
    raidCatalog: "团本目录",
    raidMode: "团本模式",
    raidQuota: "团本额度",
    raidRewardQuota: "角色总奖励额度",
    quotaCharge: "额度记录",
    clearsToday: "今日通关记录",
    maxAttempts: "次数上限",
    remaining: "剩余次数",
    doneToday: "今日已打",
    staminaDone: "体力完成",
    name: "名称",
    detail: "说明",
    level: "等级",
    power: "战力",
  }));

  function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function get(value, key) {
    return record(value) && own(value, key) ? value[key] : missing;
  }

  function raidKey(name) {
    return name.trim().toLowerCase();
  }

  function indexList(values, definition) {
    if (!definition || !Array.isArray(values)) return null;
    const index = new Map();
    for (const value of values) {
      const identity = get(value, definition.key);
      if (typeof identity !== "string" || !identity.trim()) return null;
      const key = definition.key === "name" ? raidKey(identity) : identity;
      if (index.has(key)) return null;
      index.set(key, value);
    }
    return index;
  }

  function childShape(shape, key) {
    const schema = children[shape];
    return schema && own(schema, key) ? schema[key] : "";
  }

  function sameAt(left, right, shape) {
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      const definition = collections[shape];
      const a = indexList(left, definition);
      const b = indexList(right, definition);
      if (a && b) {
        return Array.from(a).every(([key, value]) => b.has(key) && sameAt(value, b.get(key), definition.shape));
      }
      return left.every((value, index) => sameAt(value, right[index], ""));
    }
    if (!record(left) || !record(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => (
      own(right, key) && sameAt(left[key], right[key], childShape(shape, key))
    ));
  }

  function same(left, right) {
    return sameAt(left, right, "document");
  }

  function display(value) {
    return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80);
  }

  function describe(path) {
    return path.join(" › ") || "同步数据";
  }

  function itemLabel(definition, key, ...values) {
    const named = values.find((value) => record(value) && typeof value.name === "string" && value.name.trim());
    return definition.label + "「" + display(named ? named.name : key) + "」";
  }

  function valuesFor(index, key) {
    return index.has(key) ? index.get(key) : missing;
  }

  function configId(serverId) {
    return JSON.stringify(["raid-config", serverId]);
  }

  function quotaId(accountId) {
    return JSON.stringify(["raid-quota", accountId]);
  }

  function accountRaidScope(name) {
    return JSON.stringify(["raid", name]);
  }

  function characterScope(zoneId, characterId) {
    return JSON.stringify(["character", zoneId, characterId]);
  }

  function quotaGroup(identity, path) {
    return { id: quotaId(identity[3]), path: [...path.slice(0, 3), "团本额度和相关进度"], kind: "raid-quota" };
  }

  function raidProgress(raid) {
    if (!record(raid)) return missing;
    return Object.fromEntries(raidProgressFields.filter((key) => own(raid, key)).map((key) => [key, raid[key]]));
  }

  function mergeClearProgress(base, local, remote, path, identity, selection) {
    const versions = [base, local, remote];
    if (!versions.some((raid) => Array.isArray(raid?.clearsToday))) return null;
    const [previous, here, there] = versions.map(raidProgress);
    if (sameAt(here, there, "raid") || sameAt(previous, there, "raid")) return here;
    if (sameAt(previous, here, "raid")) return there;
    const shared = identity[1] === "regular" && versions.some((raid) => (
      record(raid) && Tracker.getRaidClears(raid).some(({ charge }) => charge & 14)
    ));
    const group = shared ? quotaGroup(identity, path)
      : { id: JSON.stringify(["raid-progress", ...identity]), path: [...path, "通关与次数"], kind: "value" };
    const detail = (raid) => conflictValue(raid.remaining + " 次剩余", "今日已打 " + Tracker.getRaidClears(raid).length + " 次");
    recordConflict(selection.conflicts, group.id, group.path, group.kind, JSON.stringify([...identity, "clearsToday"]),
      [...path, "通关与次数"], detail(local), detail(remote));
    return chooseSide(selection, group.id) === "remote" ? there : here;
  }

  function chooseSide(selection, id) {
    const side = selection.choices && own(selection.choices, id) ? selection.choices[id] : selection.prefer;
    return side === "remote" ? "remote" : "local";
  }

  function conflictValue(value, context) {
    return { missing: value === missing || value === undefined, data: copy(value), context };
  }

  function recordConflict(result, id, path, kind, itemId, itemPath, local, remote) {
    if (!result) return;
    if (!result.has(id)) result.set(id, { id, path: describe(path), kind, items: [] });
    const { items } = result.get(id);
    if (items.some((item) => item.id === itemId)) return;
    items.push({ id: itemId, path: describe(itemPath), local, remote });
  }

  function mergeAt(base, local, remote, shape, path, identity, selection, group) {
    if (sameAt(local, remote, shape)) return local;
    if (sameAt(base, local, shape)) return remote;
    if (sameAt(base, remote, shape)) return local;
    if (shape === "accountQuota" || shape === "characterQuota") {
      return chooseSide(selection, quotaId(identity[3])) === "remote" ? remote : local;
    }

    const definition = collections[shape];
    if (definition && Array.isArray(local) && Array.isArray(remote) && (base === missing || Array.isArray(base))) {
      const sides = [base === missing ? [] : base, local, remote].map((values) => indexList(values, definition));
      if (sides.every(Boolean)) {
        const keys = new Set(sides.flatMap((index) => Array.from(index.keys())));
        const merged = [];
        for (const key of keys) {
          const [previous, here, there] = sides.map((index) => valuesFor(index, key));
          const item = mergeAt(
            previous, here, there, definition.shape,
            [...path.slice(0, -1), itemLabel(definition, key, previous, here, there)], [...identity, key], selection, group
          );
          if (item !== missing) merged.push(item);
        }
        return merged;
      }
    }

    if (record(local) && record(remote) && (base === missing || record(base))) {
      const keys = new Set([...(base === missing ? [] : Object.keys(base)), ...Object.keys(local), ...Object.keys(remote)]);
      const merged = [];
      const progress = shape === "raid" ? mergeClearProgress(base, local, remote, path, identity, selection) : null;
      for (const key of keys) {
        if (progress && raidProgressFields.includes(key)) {
          if (own(progress, key)) merged.push([key, progress[key]]);
          continue;
        }
        const nextShape = childShape(shape, key);
        const nextPath = [...path, labels.get(key) || collections[nextShape]?.label || display(key)];
        let related = group;
        if (shape === "server" && ["raidCatalog", "activeRaids", "raidMode", "maxAttempts"].includes(key)) {
          related = { id: configId(identity[1]), path: [...path, "团本配置和相关进度"], kind: "raid-config" };
        } else if (shape === "raid" && identity[1] === "regular" &&
                   ["doneToday", "remaining", "quotaCharge"].includes(key) &&
                   [base, local, remote].some((raid) => raid?.quotaCharge & 14)) {
          related = quotaGroup(identity, path);
        }
        const value = mergeAt(
          get(base, key), get(local, key), get(remote, key), nextShape, nextPath, [...identity, key], selection, related
        );
        if (value !== missing) merged.push([key, value]);
      }
      return Object.fromEntries(merged);
    }

    const kind = local === missing || remote === missing ? "delete-edit" : "value";
    const itemId = JSON.stringify(identity);
    const id = group?.id || JSON.stringify(["field", ...identity]);
    recordConflict(selection.conflicts, id, group?.path || path, group?.kind || kind,
      itemId, path, conflictValue(local), conflictValue(remote));
    return chooseSide(selection, id) === "remote" ? remote : local;
  }

  function allRaidRows(server) {
    const rows = new Map();
    const accounts = indexList(server.accounts, collections.accounts);
    if (!accounts) return rows;
    for (const [accountId, account] of accounts) {
      const zones = indexList(account.zones, collections.zones);
      if (!zones) continue;
      for (const [zoneId, zone] of zones) {
        const characters = indexList(zone.characters, collections.characters);
        if (!characters) continue;
        for (const [characterId, character] of characters) {
          const raids = indexList(character.raids, collections.raids);
          if (!raids) continue;
          for (const [name, raid] of raids) {
            const key = JSON.stringify([accountId, zoneId, characterId, name]);
            rows.set(key, { account, zone, character, name, raid, characterQuota: characterScope(zoneId, characterId) });
          }
        }
      }
    }
    return rows;
  }

  function progressDiffers(previous, row, server) {
    if (!previous) {
      return row.doneToday || own(row, "maxAttempts") || row.remaining !== Tracker.raidLimit(server, row);
    }
    return [...raidProgressFields, "maxAttempts"].some((key) => !sameAt(get(previous, key), get(row, key), childShape("raid", key)));
  }

  function configFor(server) {
    return Tracker.normalizeServerState(server.serverId, { ...server, accounts: [] });
  }

  function inspectRaidChanges(server, base, local, remote, conflicts) {
    const active = new Set(configFor(server).activeRaids.map(raidKey));
    const oldRows = record(base) ? allRaidRows(base) : new Map();
    const tracking = new Map();
    const limits = [];
    for (const name of server.activeRaids) {
      const key = raidKey(name);
      if (!active.has(key)) tracking.set(key, name);
    }

    for (const [key, row] of allRaidRows(server)) {
      if (!active.has(row.name)) {
        if (progressDiffers(oldRows.get(key)?.raid, row.raid, server)) tracking.set(row.name, row.raid.name);
      } else if (row.raid.remaining > Tracker.raidLimit(server, row.raid)) {
        limits.push({ key, ...row });
      }
    }

    const serverLabel = Tracker.getServerDef(server.serverId).label;
    const id = configId(server.serverId);
    const groupPath = [serverLabel, "团本配置和相关进度"];
    if (!tracking.size && !limits.length) return { tracking, limits };
    const [localRows, remoteRows] = [local, remote].map(allRaidRows);
    for (const [key, name] of tracking) {
      const side = (item, rows) => {
        const enabled = item.activeRaids.some((raid) => raidKey(raid) === key);
        const records = Array.from(rows.values()).filter((row) => row.name === key);
        return conflictValue(enabled ? "已启用" : "已停用", records.length ? records.length + " 个角色的记录" : "");
      };
      recordConflict(conflicts, id, groupPath, "raid-config", JSON.stringify(["enabled", key]),
        [serverLabel, "团本「" + display(name) + "」的启用与进度"], side(local, localRows), side(remote, remoteRows));
    }
    for (const row of limits) {
      const path = [serverLabel,
        itemLabel(collections.accounts, "", row.account),
        itemLabel(collections.zones, "", row.zone),
        itemLabel(collections.characters, "", row.character),
        itemLabel(collections.raids, "", row.raid), "次数上限与进度"];
      const side = (item, rows) => {
        const raid = rows.get(row.key)?.raid;
        return raid ? conflictValue(raid.remaining + "/" + Tracker.raidLimit(item, raid)) : conflictValue(missing);
      };
      recordConflict(conflicts, id, groupPath, "raid-config", JSON.stringify(["limit", row.key]),
        path, side(local, localRows), side(remote, remoteRows));
    }
    return { tracking, limits };
  }

  function restoreTracking(server, preferred, tracking) {
    const preferredActive = new Map(preferred.activeRaids.map((name) => [raidKey(name), name]));
    const names = new Map(server.activeRaids.map((name) => [raidKey(name), name]));
    for (const key of tracking.keys()) {
      if (preferredActive.has(key)) names.set(key, preferredActive.get(key));
      else names.delete(key);
    }
    let active = Array.from(names.values());
    const pair = Tracker.getRaidMode(server) === "pair";
    if ((pair && active.length !== 2) || !active.length) {
      server.raidMode = Tracker.getRaidMode(preferred);
      active = preferred.activeRaids.slice();
    }
    const catalog = new Set(server.raidCatalog.map((option) => raidKey(option.name)));
    const required = new Set(active.map(raidKey));
    for (const option of preferred.raidCatalog) {
      const key = raidKey(option.name);
      if (!catalog.has(key) && required.has(key)) server.raidCatalog.push({ ...option });
    }
    server.activeRaids = active;
    server.activeRaids = configFor(server).activeRaids;

    const enabled = new Set(server.activeRaids.map(raidKey));
    for (const row of allRaidRows(server).values()) {
      if (!enabled.has(row.name)) {
        row.character.raids = row.character.raids.filter((raid) => raid !== row.raid);
      }
    }
  }

  function restoreLimits(server, preferred, limits) {
    const choices = allRaidRows(preferred);
    for (const { key, raid } of limits) {
      const choice = choices.get(key)?.raid;
      if (!choice) {
        raid.remaining = Math.min(raid.remaining, Tracker.raidLimit(server, raid));
        continue;
      }
      raid.remaining = choice.remaining;
      if (raid.remaining <= Tracker.raidLimit(server, raid)) continue;
      if (own(choice, "maxAttempts")) raid.maxAttempts = choice.maxAttempts;
      else delete raid.maxAttempts;
      if (raid.remaining > Tracker.raidLimit(server, raid)) server.maxAttempts = preferred.maxAttempts;
    }
  }

  function inspectTracking(data, base, local, remote, selection) {
    if (!Tracker || !record(data?.servers)) return;
    for (const serverId of serverIds) {
      const server = data.servers[serverId];
      const here = local?.servers?.[serverId];
      const there = remote?.servers?.[serverId];
      const preferred = chooseSide(selection, configId(serverId)) === "remote" ? there : here;
      const isConfigured = (item) => item?.serverId === serverId &&
        Array.isArray(item.activeRaids) && item.activeRaids.every((name) => typeof name === "string") &&
        indexList(item.raidCatalog, collections.catalog) && Array.isArray(item.accounts);
      if (!isConfigured(server) || !isConfigured(here) || !isConfigured(there)) continue;
      const { tracking, limits } = inspectRaidChanges(server, base?.servers?.[serverId], here, there, selection.conflicts);
      if (tracking.size) restoreTracking(server, preferred, tracking);
      if (limits.length) restoreLimits(server, preferred, limits);
    }
  }

  function accountRaidRows(server) {
    const accounts = new Map();
    for (const [key, row] of allRaidRows(server || {})) {
      if (!accounts.has(row.account.id)) accounts.set(row.account.id, new Map());
      accounts.get(row.account.id).set(key, row);
    }
    return accounts;
  }

  function accountCharacters(account) {
    const characters = new Map();
    const zones = indexList(account?.zones, collections.zones);
    for (const [zoneId, zone] of zones || []) {
      const list = indexList(zone.characters, collections.characters);
      for (const [characterId, character] of list || []) {
        characters.set(characterScope(zoneId, characterId), { zone, character });
      }
    }
    return characters;
  }

  function accountQuotas(account, characters) {
    const quotas = new Map();
    const source = account?.raidQuota;
    if (record(source?.total)) quotas.set(accountTotalScope, source.total);
    const items = indexList(source?.raids, collections.quotaRaids);
    for (const [key, quota] of items || []) quotas.set(accountRaidScope(key), quota);
    for (const [key, { character }] of characters) {
      if (record(character.raidRewardQuota)) quotas.set(key, character.raidRewardQuota);
    }
    return quotas;
  }

  function chargeEffect(after, previous, next, bit) {
    let difference = 0;
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const wasCharged = Boolean(previous.get(id) & bit);
      const isCharged = Boolean(next.get(id) & bit);
      if (wasCharged === isCharged) continue;
      if (isCharged && !previous.has(id)) difference -= 1;
      else if (wasCharged && !next.has(id) && after) difference += 1;
      else return null; // Changing a charge flag in place is a quota adjustment.
    }
    return difference || undefined;
  }

  function sharedScopes(row) {
    return [[accountTotalScope, 2], [accountRaidScope(row.name), 4], [row.characterQuota, 8]];
  }

  function chargeEffects(before, after) {
    const byQuota = new Map();
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(key);
      const current = after.get(key);
      const previousClears = new Map(Tracker.getRaidClears(previous?.raid).map(({ id, charge }) => [id, charge]));
      const currentClears = new Map(Tracker.getRaidClears(current?.raid).map(({ id, charge }) => [id, charge]));
      for (const [name, bit] of sharedScopes(current || previous)) {
        const effect = chargeEffect(current?.raid, previousClears, currentClears, bit);
        if (effect === undefined) continue;
        if (!byQuota.has(name)) byQuota.set(name, new Map());
        byQuota.get(name).set(key, effect);
      }
    }
    return byQuota;
  }

  function changedRoleAmounts(before, after) {
    const byQuota = new Map();
    for (const [key, row] of after) {
      const previous = before.get(key);
      if (!previous || previous.raid.remaining === row.raid.remaining) continue;
      const difference = row.raid.remaining - previous.raid.remaining;
      for (const [name] of sharedScopes(row)) {
        if (!byQuota.has(name)) byQuota.set(name, new Map());
        byQuota.get(name).set(key, difference);
      }
    }
    return byQuota;
  }

  function totalEffect(effects) {
    let delta = 0;
    for (const effect of effects.values()) {
      if (effect === null) return NaN;
      delta += effect;
    }
    return delta;
  }

  function sameEffects(left, right) {
    return left.size === right.size && Array.from(left).every(([key, value]) => right.get(key) === value);
  }

  function quotaScope(name, copies, effects, differences) {
    const [base, local, remote, merged] = copies.map((items) => items.get(name));
    const [localEffects, remoteEffects] = effects.map((items) => items.get(name) || new Map());
    const verified = [local, remote].every((value, index) => (
      base && value && value.maxAttempts === base.maxAttempts &&
      value.remaining - base.remaining === totalEffect([localEffects, remoteEffects][index])
    ));
    const [localAmounts, remoteAmounts] = differences.map((items) => items.get(name));
    const [kind, raidName] = JSON.parse(name);
    const characterQuota = kind === "character";
    const localChanged = !sameAt(base, local, "accountQuota") || localEffects.size || (characterQuota && localAmounts?.size);
    const remoteChanged = !sameAt(base, remote, "accountQuota") || remoteEffects.size || (characterQuota && remoteAmounts?.size);
    const agrees = sameAt(local, remote, "accountQuota") && sameEffects(localEffects, remoteEffects);
    // After the daily marks reset, equal balances may still come from distinct clears.
    const ambiguous = localAmounts?.size && remoteAmounts?.size && !sameEffects(localAmounts, remoteAmounts);
    return {
      name, kind, raidName, base, local, remote, merged, localEffects, remoteEffects, verified,
      localAmounts, remoteAmounts,
      contested: localChanged && remoteChanged && !verified && (!agrees || ambiguous),
    };
  }

  function settleQuotaEffects(scopes, rows, prefer) {
    const contested = new Set(scopes.filter((scope) => scope.contested).map((scope) => scope.name));
    const rejected = new Set();
    const preferredRows = rows[prefer];
    const mine = prefer + "Effects";
    const otherSide = prefer === "local" ? "remote" : "local";
    const other = otherSide + "Effects";
    let remainder;
    // Rejecting a completion in one quota can change how much was spent in another.
    for (;;) {
      for (const scope of scopes) {
        if (!contested.has(scope.name)) continue;
        for (const [key, effect] of scope[other]) {
          if (scope[mine].get(key) !== effect) rejected.add(key);
        }
        if (scope.kind === "character") {
          const oppositeAmounts = scope[otherSide + "Amounts"];
          for (const [key, amount] of oppositeAmounts || []) {
            if (scope[prefer + "Amounts"]?.get(key) !== amount) rejected.add(key);
          }
        }
      }
      const acceptedRows = new Map(rows.merged);
      for (const key of rejected) {
        if (preferredRows.has(key)) acceptedRows.set(key, preferredRows.get(key));
        else acceptedRows.delete(key);
      }
      const accepted = chargeEffects(rows.base, acceptedRows);
      remainder = new Map();
      const conflictCount = contested.size;
      for (const scope of scopes) {
        if (contested.has(scope.name)) continue;
        if (scope.verified) {
          const remaining = scope.base.remaining + totalEffect(accepted.get(scope.name) || new Map());
          if (remaining >= 0 && remaining <= scope.base.maxAttempts) remainder.set(scope.name, remaining);
          else contested.add(scope.name);
        } else if (Array.from(scope[other]).some(([key, effect]) => (
          rejected.has(key) && scope[mine].get(key) !== effect
        ))) {
          contested.add(scope.name);
        }
      }
      if (conflictCount === contested.size) return { contested, rejected, remainder };
    }
  }

  function restoreChargedRaid(row, previous, server) {
    const raid = row.raid;
    // Only the completion fields participate in a quota conflict.
    raid.doneToday = previous?.doneToday || false;
    const spent = Tracker.getRaidClears(raid).filter(({ charge }) => charge & 1).length;
    raid.remaining = Math.min(previous?.remaining ?? raid.remaining + Math.max(1, spent), Tracker.raidLimit(server, raid));
    if (previous && own(previous, "quotaCharge")) raid.quotaCharge = previous.quotaCharge;
    else delete raid.quotaCharge;
    if (previous && own(previous, "clearsToday")) raid.clearsToday = previous.clearsToday;
    else delete raid.clearsToday;
  }

  function quotaConflictValue(scope, side, rows) {
    const quota = scope[side];
    const keys = new Set([...scope[side + "Effects"].keys(), ...(scope[side + "Amounts"]?.keys() || [])]);
    const names = Array.from(keys, (key) => {
      const row = rows[side].get(key) || rows.base.get(key);
      return row ? [row.zone.name, row.character.name, row.raid.name].map(display).join(" / ") : "";
    }).filter(Boolean);
    const suffix = names.length > 3 ? " 等 " + names.length + " 项" : "";
    const context = names.length ? "关联 " + names.slice(0, 3).join("、") + suffix : "";
    return conflictValue(quota ? quota.remaining + "/" + quota.maxAttempts : missing, context);
  }

  function mergeAccountQuotas(data, base, local, remote, selection) {
    const servers = [base, local, remote, data].map((value) => value?.servers?.regular);
    const merged = servers[3];
    if (!merged) return;
    const [baseAccounts, localAccounts, remoteAccounts, mergedAccounts] = servers.map((server) => (
      indexList(server?.accounts, collections.accounts) || new Map()
    ));
    const [baseRows, localRows, remoteRows, mergedRows] = servers.map(accountRaidRows);
    const catalog = new Set((merged.raidCatalog || []).map(({ name }) => raidKey(name)));
    const catalogs = [servers[1], servers[2]].map((server) => indexList(server?.raidCatalog, collections.catalog));
    for (const [id, account] of mergedAccounts) {
      if (!localAccounts.has(id) || !remoteAccounts.has(id)) continue;
      const copies = [baseAccounts.get(id), localAccounts.get(id), remoteAccounts.get(id), account];
      const characters = copies.map(accountCharacters);
      const quotas = copies.map((copy, index) => accountQuotas(copy, characters[index]));
      const names = new Set(quotas.flatMap((items) => Array.from(items.keys())));
      if (!names.size) continue;
      const rows = {
        base: baseRows.get(id) || new Map(),
        local: localRows.get(id) || new Map(),
        remote: remoteRows.get(id) || new Map(),
        merged: mergedRows.get(id) || new Map(),
      };
      const effects = [chargeEffects(rows.base, rows.local), chargeEffects(rows.base, rows.remote)];
      const differences = [changedRoleAmounts(rows.base, rows.local), changedRoleAmounts(rows.base, rows.remote)];
      const scopes = Array.from(names, (name) => quotaScope(name, quotas, effects, differences));
      const groupId = quotaId(id);
      const prefer = chooseSide(selection, groupId);
      const preferredCatalog = catalogs[prefer === "remote" ? 1 : 0];
      const { contested, rejected, remainder } = settleQuotaEffects(scopes, rows, prefer);
      for (const key of rejected) {
        const row = rows.merged.get(key);
        if (row) restoreChargedRaid(row, rows[prefer].get(key)?.raid, merged);
      }
      const quota = { raids: [] };
      const path = ["常规服", itemLabel(collections.accounts, id, account), "团本额度和相关进度"];
      for (const scope of scopes) {
        const name = scope.kind === "raid" ? scope.raidName : "";
        const person = scope.kind === "character" ? characters[3].get(scope.name) : undefined;
        let nameLabel = "账号总奖励";
        if (name) nameLabel = itemLabel(collections.quotaRaids, name, scope.merged, scope[prefer], scope.base);
        if (person) nameLabel = [person.zone.name, person.character.name, "角色总奖励"].map(display).join(" / ");
        let value = scope.merged;
        if (contested.has(scope.name)) {
          recordConflict(selection.conflicts, groupId, path, "raid-quota", JSON.stringify([id, scope.name]),
            [nameLabel], quotaConflictValue(scope, "local", rows), quotaConflictValue(scope, "remote", rows));
          value = scope[prefer];
        } else if (remainder.has(scope.name)) {
          value = { ...scope.base, remaining: remainder.get(scope.name) };
        }
        if (scope.kind === "character") {
          if (person && value) person.character.raidRewardQuota = { ...value };
          else if (person) delete person.character.raidRewardQuota;
          continue;
        }
        if (name && value && !catalog.has(name)) {
          recordConflict(selection.conflicts, groupId, path, "raid-quota", JSON.stringify([id, "catalog", name]),
            [nameLabel, "副本目录"], quotaConflictValue(scope, "local", rows), quotaConflictValue(scope, "remote", rows));
          const catalogEntry = preferredCatalog?.get(name);
          if (!catalogEntry || !scope[prefer]) continue;
          merged.raidCatalog.push({ ...catalogEntry });
          catalog.add(name);
          value = scope[prefer];
        }
        if (!value) continue;
        if (name) quota.raids.push({ ...value });
        else quota.total = { ...value };
      }
      if (quota.total || quota.raids.length || own(account, "raidQuota")) account.raidQuota = quota;
    }
  }

  function copy(data) {
    return data === missing || data === undefined ? null : JSON.parse(JSON.stringify(data));
  }

  function merge(base, local, remote, prefer) {
    const conflicts = new Map();
    const anchor = base == null ? missing : base;
    const choice = prefer === "remote" ? "remote" : "local";
    const choices = record(prefer) ? prefer : undefined;
    const selection = { prefer: choice, choices, conflicts };
    const data = copy(mergeAt(anchor, local, remote, "document", [], [], selection));
    inspectTracking(data, base, local, remote, selection);
    mergeAccountQuotas(data, base, local, remote, selection);
    if (conflicts.size) {
      // Discover configuration dependencies revealed by taking the other branch.
      const opposite = { prefer: choice === "local" ? "remote" : "local" };
      const alternative = copy(mergeAt(anchor, local, remote, "document", [], [], opposite));
      opposite.conflicts = conflicts;
      inspectTracking(alternative, base, local, remote, opposite);
      mergeAccountQuotas(alternative, base, local, remote, opposite);
    }
    return { data, conflicts: [...conflicts.values()] };
  }

  function isEmpty(data) {
    if (data == null) return true;
    if (!Tracker || !record(data.servers)) return false;
    return same({ servers: data.servers }, { servers: Tracker.createAppState().servers });
  }

  return { merge, same, isEmpty };
});
