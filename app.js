"use strict";

const Tracker = window.Tracker;
const STORAGE_KEY = "jinghe-assistant-v2";
const LEGACY_STORAGE_KEY = "jinghe-assistant-v1";
const UI_KEY = "jinghe-assistant-ui-v1";
const FONT_KEY = "jinghe-assistant-font-v1";
const FONT_PRESETS = new Set(["system", "rounded", "clear", "journal"]);
const RAID_LIMIT_LABELS = {
  "character-raid": "角色单本",
  "character-total": "角色总奖励",
  "account-raid": "账号单本",
  "account-total": "账号总奖励",
};
const clearTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const byId = (id) => document.getElementById(id);
const market = window.JingheMarket?.mount();
const toolNav = byId("tool-nav");
const toolButtons = toolNav.querySelectorAll("button[data-tool]");
const accountList = byId("account-list");
const actionDialog = byId("action-dialog");
const backupDialog = byId("backup-dialog");
const batchDialog = byId("batch-dialog");
const raidCatalogDialog = byId("raid-catalog-dialog");
const raidQuotaDialog = byId("raid-quota-dialog");
const raidClearsDialog = byId("raid-clears-dialog");
const restoreDialog = byId("raid-restore-dialog");
const recoveryDialog = byId("recovery-dialog");
const fontDialog = byId("font-settings-dialog");
const fontChoices = fontDialog.querySelectorAll('input[name="font-preset"]');
const fontNote = byId("font-settings-note");
const defaultFontNote = fontNote.textContent;
const searchInput = byId("role-search");
const searchClear = byId("clear-role-search");
const searchResults = byId("search-results");
const searches = new Map();
let composingSearch = false;
const backupInput = byId("backup-input");
const compactLayout = window.matchMedia("(max-width: 859px)");

let storageNotice = "保存在此浏览器";
let needsMigration = false;
let storageReadError = false;
let deviceSync = null;
let state = readState(true);
const preferences = readPreferences();
let settingsExpanded = !compactLayout.matches;
let pendingAction = null;
let toastTimer = null;
let pendingUndo = null;
let batchContext = null;
let quotaContext = null;
let raidClearsContext = null;
let restoreServerId = null;
let recoveryWriting = false;

state.activeServer = "regular";

function readState(allowLegacy = false) {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const legacy = saved === null && allowLegacy ? localStorage.getItem(LEGACY_STORAGE_KEY) : null;
    const records = saved ?? legacy;
    const parsed = records === null ? Tracker.createAppState() : Tracker.normalizeAppState(JSON.parse(records));
    needsMigration = legacy !== null;
    storageReadError = false;
    return parsed;
  } catch (error) {
    storageReadError = true;
    storageNotice = "无法读取浏览器存储";
    console.error("无法读取晶核助手的记录", error);
    return Tracker.createAppState();
  }
}

function readPreferences() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(UI_KEY) || "null");
  } catch {
    stored = null;
  }
  return Object.fromEntries(["regular", "season"].map((server) => {
    const saved = stored?.[server];
    const filters = saved?.filters;
    return [server, {
      tool: saved?.tool === "stamina" ? "stamina" : "raids",
      filters: {
        raids: filters?.raids === "raid" ? "raid" : "all",
        stamina: filters?.stamina === "stamina" ? "stamina" : "all",
      },
      collapsed: Array.isArray(saved?.collapsed)
        ? saved.collapsed.filter((id) => typeof id === "string")
        : [],
    }];
  }));
}

function savePreferences() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences still apply while this page is open.
  }
}

function applyFontPreset(value) {
  const preset = FONT_PRESETS.has(value) ? value : "system";
  document.documentElement.dataset.fontPreset = preset;
  for (const choice of fontChoices) choice.checked = choice.value === preset;
}

function restoreFontPreset() {
  let saved;
  try {
    saved = localStorage.getItem(FONT_KEY);
  } catch {
    fontNote.textContent = "字体可在当前页面切换。";
  }
  applyFontPreset(saved);
}

function currentFilter() {
  return preferences[state.activeServer].filters[currentTool()];
}

function changeFilter(filter) {
  preferences[state.activeServer].filters[currentTool()] = filter;
  savePreferences();
}

function setCollapsed(accountId, collapsed) {
  const prefs = preferences[state.activeServer];
  prefs.collapsed = prefs.collapsed.filter((id) => id !== accountId);
  if (collapsed) prefs.collapsed.push(accountId);
  savePreferences();
}

function renderStorageStatus() {
  const status = byId("storage-status");
  status.textContent = storageNotice;
  status.dataset.state = /无法|未保存/.test(storageNotice) ? "error" : "ready";
}

function saveState(notifySync = true) {
  try {
    if (storageReadError) return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    needsMigration = false;
    storageNotice = "已保存到此浏览器";
    renderStorageStatus();
    if (notifySync) deviceSync?.localChanged();
    return true;
  } catch (error) {
    storageNotice = "未保存 · 请导出备份";
    renderStorageStatus();
    console.error("无法保存晶核助手的记录", error);
    return false;
  }
}

function changedServers(before, after) {
  return ["regular", "season"].filter((id) => JSON.stringify(before.servers[id]) !== JSON.stringify(after.servers[id]));
}

function scopedSnapshot(snapshot, ids) {
  return {
    dailyDate: snapshot.dailyDate,
    dailyResetHour: snapshot.dailyResetHour,
    servers: Object.fromEntries(ids.map((id) => [id, snapshot.servers[id]])),
  };
}

async function saveRestorable(label, nextState, replaceUnreadable = false) {
  if (recoveryWriting) throw new Error("有一项批量操作正在保存，请稍后再试。");
  recoveryWriting = true;
  const previous = state;
  const readError = storageReadError;
  let pointId;
  try {
    const before = Tracker.snapshotApp(previous);
    const after = Tracker.snapshotApp(nextState);
    const ids = changedServers(before, after);
    if (ids.length) {
      try {
        pointId = await window.JingheRecovery.add({
          label,
          createdAt: Date.now(),
          before: scopedSnapshot(before, ids),
          after: scopedSnapshot(after, ids),
        });
      } catch {
        throw new Error("无法保存恢复点，请检查浏览器存储后重试。");
      }
    }
    if (state !== previous || changedServers(before, Tracker.snapshotApp(state)).length) {
      throw new Error("记录刚刚更新，请重新预览后保存。");
    }
    state = nextState;
    if (replaceUnreadable) storageReadError = false;
    if (saveState()) {
      if (pointId) void window.JingheRecovery.trim().catch(() => {});
      return true;
    }
    state = previous;
    storageReadError = readError;
    if (pointId) await window.JingheRecovery.remove(pointId).catch(() => {});
    return false;
  } catch (error) {
    if (pointId) await window.JingheRecovery.remove(pointId).catch(() => {});
    throw error;
  } finally {
    recoveryWriting = false;
  }
}

function resetAtBoundary(notifySync = true) {
  const now = new Date();
  if (state.dailyDate === Tracker.dailyCycleKey(now) && state.dailyResetHour === Tracker.DAILY_RESET_HOUR) {
    return false;
  }
  const result = Tracker.ensureDailyReset(state, now);
  state = result.state;
  saveState(notifySync);
  return result.reset;
}

function updateDay() {
  if (resetAtBoundary()) {
    render();
    showToast("今日进度已重置");
  }
}

function editRecord(edit, message) {
  resetAtBoundary();
  edit();
  const saved = saveState();
  render();
  if (message) showToast(saved ? message : message + "，请导出备份");
}

function currentTool() {
  return preferences[state.activeServer].tool;
}

function changeTool(tool) {
  preferences[state.activeServer].tool = tool;
  savePreferences();
}

function currentServer() {
  return state.servers[state.activeServer];
}

function searchKey(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function currentSearch() {
  return searchKey(searches.get(state.activeServer) || "");
}

function updateSearch() {
  const previous = searches.get(state.activeServer) || "";
  if (searchInput.value === previous) return;
  searches.set(state.activeServer, searchInput.value);
  if (resetAtBoundary()) render();
  else renderAccounts();
}

searchInput.addEventListener("compositionstart", () => { composingSearch = true; });
searchInput.addEventListener("compositionend", () => {
  composingSearch = false;
  updateSearch();
});
searchInput.addEventListener("input", (event) => {
  if (!composingSearch && !event.isComposing) updateSearch();
});
searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchInput.focus({ preventScroll: true });
  updateSearch();
});


function toneIndex(value, modulo) {
  const text = String(value || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % modulo;
}

function nameBadge(value, fallback) {
  const compactName = String(value || "").trim().replace(/[\s_-]+/g, "");
  if (!compactName) return fallback;
  const characters = Array.from(compactName);
  if (/^[a-z0-9]$/i.test(characters[0])) {
    return characters.slice(0, 2).join("").toUpperCase();
  }
  return characters[0];
}

function make(tag, className, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children);
  return element;
}

function button(label, className, data = {}) {
  const control = make("button", className, label);
  control.type = "button";
  Object.assign(control.dataset, data);
  return control;
}

function showToast(message, undo) {
  const toast = byId("toast");
  const undoButton = byId("undo-record");
  clearTimeout(toastTimer);
  pendingUndo = undo || null;
  byId("toast-message").textContent = message;
  undoButton.hidden = !pendingUndo;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
    pendingUndo = null;
  }, pendingUndo ? 12000 : 2700);
}

byId("undo-record").addEventListener("click", () => {
  const undo = pendingUndo;
  pendingUndo = null;
  if (undo) undo();
});

function recordCompletion(changes, message) {
  if (!changes.length) return;
  const date = state.dailyDate;
  const saved = saveState();
  render();
  showToast(saved ? message : message + "，请导出备份", () => {
    resetAtBoundary();
    if (state.dailyDate !== date) {
      render();
      showToast("已进入新的一天");
      return;
    }
    let restored = 0;
    for (const { ref, before, after, clearId } of changes.slice().reverse()) {
      const entry = records(ref);
      if (clearId) {
        if (Tracker.undoRaidClear(entry.server, entry.account, entry.character, entry.raid, clearId)) {
          restored += 1;
        }
        continue;
      }
      const target = entry.character;
      if (!target || !Object.entries(after).every(([field, value]) => target[field] === value)) continue;
      Object.assign(target, before);
      restored += 1;
    }
    if (restored) {
      const undoSaved = saveState();
      render();
      showToast(undoSaved ? "已撤销 " + restored + " 笔记录" : "已撤销，请导出备份");
    } else {
      showToast("这些记录已经更新");
    }
  });
}

function summaryText(summary) {
  if (!summary.accountCount) return "暂无账号";
  if (!summary.characterCount) return "暂无角色";
  if (!summary.staminaPending && !summary.raidsPending) return "今日已完成";
  return "体力待刷 " + summary.staminaPending + " · 副本待打 " + summary.raidsPending;
}

function renderOverview() {
  const regular = Tracker.summarize(state.servers.regular, { repeatable: true });
  const season = Tracker.summarize(state.servers.season, { repeatable: true });
  const selected = state.activeServer === "regular" ? regular : season;
  byId("regular-summary").textContent = summaryText(regular);
  byId("season-summary").textContent = summaryText(season);
  byId("roster-meta").textContent = selected.accountCount + " 个账号 · " + selected.zoneCount + " 个区服 · " + selected.characterCount + " 个角色";
  byId("tool-raid-summary").textContent = "可打 " + selected.raidsPending + " 项 · 已打 " + selected.raidsDoneToday + " 次";
  byId("tool-stamina-summary").textContent = "待刷 " + selected.staminaPending + " · 已刷 " + selected.staminaDone;
  if (currentTool() !== "raids") return;
  const overview = byId("raid-overview");
  overview.hidden = !selected.characterCount;
  overview.replaceChildren(...selected.raids.map((raid) => (
    make("div", "raid-summary",
      make("strong", "", raid.name),
      make("small", "", "剩余 " + raid.remaining + " 次 · 今日已打 " + raid.doneToday + " 次")
    )
  )));
}

function renderSettingsExpansion() {
  const toggle = byId("toggle-raid-settings");
  toggle.textContent = settingsExpanded ? "收起设置" : "展开设置";
  toggle.setAttribute("aria-expanded", String(settingsExpanded));
  byId("raid-settings-content").hidden = !settingsExpanded;
}

byId("toggle-raid-settings").addEventListener("click", () => {
  settingsExpanded = !settingsExpanded;
  renderSettingsExpansion();
});
byId("jump-to-settings").addEventListener("click", () => {
  closeMenus();
  resetAtBoundary();
  changeTool("raids");
  settingsExpanded = true;
  render();
  byId("toggle-raid-settings").focus({ preventScroll: true });
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  byId("raid-settings").scrollIntoView({ block: "start", behavior: reducedMotion ? "instant" : "smooth" });
});

compactLayout.addEventListener("change", () => {
  settingsExpanded = !compactLayout.matches;
  renderSettingsExpansion();
});

function renderSettings() {
  const server = currentServer();
  const mode = Tracker.getRaidMode(server);
  const pair = mode === "pair";
  byId("raid-mode").value = mode;
  renderSettingsExpansion();
  byId("raid-settings-note").textContent = pair
    ? "选择本期开放的两个轮换团本。"
    : "选择要记录的副本，至少保留一个。";
  byId("max-attempts").textContent = String(server.maxAttempts);
  byId("decrease-attempts").disabled = server.maxAttempts <= 1;
  byId("increase-attempts").disabled = server.maxAttempts >= 10;
  byId("restore-raids").disabled = !(server.serverId === "regular" ? server.accounts.length : characterTotal(server));

  const catalog = Tracker.getRaidCatalog(server);
  const controls = byId("raid-controls");
  if (pair) {
    controls.replaceChildren(make("div", "raid-selects", ...server.activeRaids.map((name, index) => {
      const select = make("select", "");
      select.dataset.slot = String(index);
      for (const raid of catalog) {
        const option = make("option", "", raid.name + (raid.detail ? " · " + raid.detail : ""));
        option.value = raid.name;
        select.append(option);
      }
      select.value = name;
      return make("label", "", make("span", "", "轮换位 " + (index + 1)), select);
    })));
  } else {
    controls.replaceChildren(make("div", "raid-pills", ...catalog.map((raid) => {
      const chip = button(raid.name, "raid-pill", { action: "toggle-catalog", raid: raid.name });
      chip.setAttribute("aria-pressed", String(server.activeRaids.includes(raid.name)));
      return chip;
    })));
  }
}

function renderFilters() {
  const tool = currentTool();
  const bar = byId("filters");
  bar.hidden = !currentServer().accounts.length;
  if (bar.dataset.filterType !== tool) {
    const options = tool === "raids"
      ? [["all", "全部"], ["raid", "仅待打"]]
      : [["all", "全部"], ["stamina", "仅待刷"]];
    bar.replaceChildren(...options.map(([key, label]) => button(label, "filter-button", { filter: key })));
    bar.dataset.filterType = tool;
  }
  const selected = currentFilter();
  for (const control of bar.children) {
    control.setAttribute("aria-pressed", String(control.dataset.filter === selected));
  }
}

function entryData(account, zone, character) {
  const data = { account: account.id };
  if (zone) data.zone = zone.id;
  if (character) data.character = character.id;
  return data;
}

function entryName(account, zone, character) {
  if (character) return "角色「" + character.name + "」";
  if (zone) return "区服「" + zone.name + "」";
  return "账号「" + account.name + "」";
}

function entryButton(label, action, account, zone, character) {
  const control = button(label, "button button--quiet", { ...entryData(account, zone, character), action });
  control.setAttribute("aria-label", entryName(account, zone, character) + " " + label.replace(/^[＋+]\s*/, ""));
  return control;
}

function entryMenu(account, zone, character, ...actions) {
  const trigger = make("summary", "menu-trigger", "⋯");
  trigger.setAttribute("aria-label", entryName(account, zone, character) + " 更多操作");
  Object.assign(trigger.dataset, entryData(account, zone, character), { menu: "" });
  return make("details", "entry-menu", trigger, make("div", "entry-menu-items", ...actions));
}

function taskButton(label, className, data, done) {
  const control = button("", className, data);
  const check = make("span", "task-check", done ? "✓" : "");
  check.setAttribute("aria-hidden", "true");
  control.append(check, make("span", "", label));
  control.setAttribute("aria-pressed", String(done));
  return control;
}

function staminaButton(account, zone, character, content) {
  const control = taskButton(content, "stamina-toggle", {
    ...entryData(account, zone, character), action: "stamina",
  }, character.staminaDone);
  control.setAttribute("aria-label", entryName(account, zone, character) + "体力已刷");
  return control;
}

function characterIdentity(character) {
  const identity = make("span", "character-identity",
    make("span", "character-avatar", nameBadge(character.name, "角")),
    make("strong", "character-name", character.name)
  );
  const profile = [
    character.level && "等级 " + character.level,
    character.power && "战力 " + character.power,
  ].filter(Boolean);
  if (profile.length) identity.append(make("small", "character-details", profile.join(" · ")));
  return identity;
}

function characterActions(account, zone, character) {
  const actions = [
    entryButton("改名", "rename-character", account, zone, character),
  ];
  if (account.zones.length > 1) {
    actions.push(entryButton("移动区服", "move-character", account, zone, character));
  }
  actions.push(entryButton("删除", "delete-character", account, zone, character));
  return make("div", "character-actions", entryMenu(account, zone, character, ...actions));
}

function raidCanRecord(account, character, raid) {
  return Boolean(raid) && Tracker.raidClearBlockers(account, character, raid).length === 0;
}

function renderRaidAvailability(entry, account, character, raid) {
  const blockers = Tracker.raidClearBlockers(account, character, raid);
  const record = entry.querySelector(".raid-toggle");
  const notice = entry.querySelector(".raid-blockers");
  record.disabled = blockers.length > 0;
  notice.hidden = !blockers.length;
  notice.textContent = blockers.length ? blockers.map((limit) => RAID_LIMIT_LABELS[limit]).join("、") + "额度已用完" : "";
  record.title = notice.textContent;
}

function renderRaid(account, zone, character, raid, defaultMaximum) {
  const maxAttempts = Tracker.raidLimit(defaultMaximum, raid);
  const data = { ...entryData(account, zone, character), raid: raid.name };
  const label = entryName(account, zone, character) + " " + raid.name;
  const record = button("", "raid-toggle", { ...data, action: "raid" });
  record.append(make("span", "raid-name", raid.name), make("small", "raid-record-label", "记 1 次"));
  record.setAttribute("aria-label", label + " 记录通关 1 次");

  const input = make("input", "");
  input.type = "number";
  input.inputMode = "numeric";
  input.min = "0";
  input.max = String(maxAttempts);
  input.step = "1";
  input.value = String(raid.remaining);
  input.setAttribute("aria-label", label + " 剩余次数");
  Object.assign(input.dataset, data, { field: "remaining" });

  const minus = button("−", "attempt-adjust", { ...data, action: "remaining-minus" });
  const plus = button("+", "attempt-adjust", { ...data, action: "remaining-plus" });
  minus.disabled = raid.remaining <= 0;
  plus.disabled = raid.remaining >= maxAttempts;
  minus.setAttribute("aria-label", label + " 减少一次剩余次数");
  plus.setAttribute("aria-label", label + " 增加一次剩余次数");
  minus.title = plus.title = "手工校正角色单本余额";

  const denominator = state.activeServer === "regular"
    ? button("/ " + maxAttempts, "role-raid-limit", { ...data, action: "edit-raid-quota" })
    : make("span", "", "/ " + maxAttempts);
  if (denominator instanceof HTMLButtonElement) {
    denominator.title = "设置角色单本额度";
    denominator.setAttribute("aria-label", label + " 设置单本额度，上限 " + maxAttempts);
  }
  const details = make("div", "raid-record-details");
  const count = Tracker.getRaidClears(raid).length;
  if (count) {
    const history = button("今日 " + count + " 次 · 明细", "button button--quiet raid-clears-trigger", { ...data, action: "raid-clears" });
    history.setAttribute("aria-label", label + " 今日 " + count + " 笔通关记录");
    history.setAttribute("aria-haspopup", "dialog");
    details.append(history);
  }
  details.append(make("small", "raid-blockers"));
  const entry = make("div", "raid-entry",
    make("div", "raid-row", record, make("div", "remaining-field", minus, input, plus, denominator)),
    details
  );
  renderRaidAvailability(entry, account, character, raid);
  return entry;
}

function renderCharacter(account, zone, character, maxAttempts) {
  const actions = characterActions(account, zone, character);
  const tone = "character-tone-" + toneIndex(character.id, 8);
  if (currentTool() === "stamina") {
    return make("div", "stamina-row " + tone, staminaButton(account, zone, character, characterIdentity(character)), actions);
  }
  if (state.activeServer === "regular") {
    const quota = Tracker.getCharacterRaidQuota(character);
    const edit = entryButton("角色总奖励", "edit-character-quota", account, zone, character);
    edit.className = "button button--quiet character-reward-quota";
    edit.append(quotaValue(quota));
    edit.setAttribute("aria-label", entryName(account, zone, character) + " 设置角色总奖励额度"
      + (quota ? "，剩余 " + quota.remaining + " 次，上限 " + quota.maxAttempts : "，未设置"));
    actions.prepend(edit);
  }
  return make("div", "character-card " + tone,
    make("div", "character-header", characterIdentity(character), actions),
    make("div", "raid-list", ...character.raids.map((raid) => renderRaid(account, zone, character, raid, maxAttempts)))
  );
}

function renderZone(account, zone, characters, maxAttempts) {
  const header = make("div", "zone-header",
    make("div", "zone-heading",
      make("span", "entry-kind entry-kind--zone", "区服"),
      make("strong", "zone-name", zone.name),
      make("small", "", zone.characters.length + " 个角色")
    ),
    make("div", "zone-actions",
      entryButton("＋ 添加角色", "add-character", account, zone),
      entryMenu(account, zone, null,
        entryButton("改名", "rename-zone", account, zone),
        entryButton("删除", "delete-zone", account, zone)
      )
    )
  );
  const list = make("div", currentTool() === "stamina" ? "stamina-list" : "character-list",
    ...characters.map((character) => renderCharacter(account, zone, character, maxAttempts))
  );
  if (!characters.length) list.append(make("p", "account-note", "添加角色后即可记录进度。"));
  const card = make("section", "zone-card", header, list);
  card.dataset.zone = zone.id;
  card.setAttribute("aria-label", "区服 " + zone.name);
  return card;
}

function accountProgress(account, collapsed) {
  const characters = account.zones.flatMap((zone) => zone.characters);
  if (!collapsed) return account.zones.length + " 个区服 · " + characters.length + " 个角色";
  if (currentTool() === "stamina") {
    const pending = characters.filter((character) => !character.staminaDone).length;
    return "体力待刷 " + pending;
  }
  const raids = characters.reduce((sum, character) => (
    sum + character.raids.filter((raid) => raidCanRecord(account, character, raid)).length
  ), 0);
  return "副本待打 " + raids;
}

function quotaValue(quota) {
  const value = make("strong", "account-raid-quota-value", quota ? quota.remaining + " / " + quota.maxAttempts : "未设置");
  if (quota) {
    value.title = "剩余 " + quota.remaining + " 次，上限 " + quota.maxAttempts + " 次";
    value.dataset.empty = String(quota.remaining === 0);
  }
  return value;
}

function accountRaidQuotas(account, server) {
  const edit = entryButton("设置额度", "edit-raid-quota", account);
  edit.className = "button button--secondary";
  const names = new Set([...server.activeRaids, ...account.raidQuota.raids.map(({ name }) => name)]);
  const items = Array.from(names, (name) => make(
    "li", "account-raid-quota-item", make("span", "", name), quotaValue(Tracker.getAccountRaidQuota(account, name))
  ));
  return make("div", "account-raid-quotas",
    make("div", "account-raid-quota-head",
      make("div", "account-raid-quota-total", make("span", "", "账号团本总奖励次数"), quotaValue(Tracker.getAccountRaidQuota(account))),
      edit
    ),
    make("ul", "account-raid-quota-list", ...items)
  );
}

function renderAccount(account, zones, maxAttempts, index, searching) {
  const collapsed = !searching && preferences[state.activeServer].collapsed.includes(account.id);
  const heading = button("", "account-heading account-fold", { ...entryData(account), action: "toggle-account" });
  const contentId = "account-content-" + index;
  const indicator = make("span", "fold-indicator");
  indicator.setAttribute("aria-hidden", "true");
  heading.append(
    make("span", "account-avatar", nameBadge(account.name, "号")),
    make("span", "account-name-line",
      make("strong", "account-name", account.name)
    ),
    make("small", "account-progress", accountProgress(account, collapsed)),
    indicator
  );
  heading.setAttribute("aria-expanded", String(!collapsed));
  heading.setAttribute("aria-controls", contentId);
  heading.disabled = Boolean(searching);
  const batch = entryButton("批量记录", "open-batch", account);
  batch.disabled = !account.zones.some((zone) => zone.characters.length);
  const more = [entryButton("改名", "rename-account", account)];
  if (currentTool() === "stamina") {
    const characters = account.zones.flatMap((zone) => zone.characters);
    if (characters.length) {
      const allDone = characters.every((character) => character.staminaDone);
      more.push(entryButton(allDone ? "取消全部已刷" : "本账号全部已刷", "stamina-all", account));
    }
  }
  more.push(entryButton("删除", "delete-account", account));
  const header = make("div", "account-header", heading,
    make("div", "account-actions",
      entryButton("＋ 添加区服", "add-zone", account),
      batch,
      entryMenu(account, null, null, ...more)
    )
  );
  const content = make("div", "account-content",
    ...zones.map(({ zone, characters }) => renderZone(account, zone, characters, maxAttempts))
  );
  if (!zones.length) content.append(make("p", "account-note", "添加区服后即可管理角色。"));
  content.id = contentId;
  content.hidden = collapsed;
  const card = make("article", "account-card account-tone-" + (index % 6), header);
  if (state.activeServer === "regular" && currentTool() === "raids") {
    card.append(accountRaidQuotas(account, currentServer()));
  }
  card.append(content);
  card.setAttribute("aria-label", "账号 " + account.name);
  return card;
}

function renderAccounts() {
  const server = currentServer();
  const filter = currentFilter();
  const term = currentSearch();
  const stamina = currentTool() === "stamina";
  searchInput.hidden = !server.accounts.length;
  searchClear.hidden = searchInput.hidden || !searchInput.value;
  searchClear.disabled = searchClear.hidden;
  const matches = (name) => searchKey(name).includes(term);
  const cards = [];
  let matchingCharacters = 0;
  for (const account of server.accounts) {
    const accountMatches = matches(account.name);
    const zones = account.zones.flatMap((zone) => {
      const zoneMatches = accountMatches || matches(zone.name);
      const characters = zone.characters.flatMap((character) => {
        const roleMatches = zoneMatches || matches(character.name);
        if (stamina) return roleMatches && (filter !== "stamina" || !character.staminaDone) ? [character] : [];
        if (roleMatches && filter === "all") return [character];
        const raids = character.raids.filter((raid) => (roleMatches || matches(raid.name)) &&
          (filter !== "raid" || raidCanRecord(account, character, raid)));
        return raids.length ? [{ ...character, raids }] : [];
      });
      matchingCharacters += characters.length;
      return characters.length || (filter === "all" && zoneMatches) ? [{ zone, characters }] : [];
    });
    if (zones.length || (filter === "all" && accountMatches)) {
      cards.push(renderAccount(account, zones, server.maxAttempts, cards.length, Boolean(term)));
    }
  }
  if (!cards.length) {
    let title = "还没有账号";
    if (server.accounts.length) {
      title = characterTotal(server) === 0 ? "还没有角色"
        : filter === "stamina" ? "没有待刷体力的角色" : "没有待打的副本";
    }
    if (term) title = "没有找到匹配的记录";
    const hint = term ? "换个关键词，或切换到「全部」查看。"
      : server.accounts.length
      ? "切换到「全部」可查看所有角色。"
      : "添加账号后，按区服管理角色、副本和体力。";
    cards.push(make("div", "empty-state", make("strong", "empty-title", title), make("p", "", hint)));
  }
  const results = term && !searchInput.hidden ? "匹配 " + matchingCharacters + " 个角色" : "";
  searchResults.hidden = !results;
  if (searchResults.textContent !== results) searchResults.textContent = results;
  byId("reset-daily").disabled = !characterTotal(server);
  accountList.replaceChildren(...cards);
}

function visibleTasks(action) {
  return Array.from(accountList.querySelectorAll("button[data-action='" + action + "']:not(:disabled)"))
    .filter((control) => !control.closest("[hidden]"));
}

function render() {
  const focused = document.activeElement;
  const taskAction = currentFilter() !== "all" && focused?.matches(".raid-toggle, .stamina-toggle")
    ? focused.dataset.action : "";
  const taskIndex = taskAction ? visibleTasks(taskAction).indexOf(focused) : -1;
  const keyboardTaskFocus = taskIndex >= 0 && focused.matches(":focus-visible");
  const tool = currentTool();
  const search = searches.get(state.activeServer) || "";
  if (!composingSearch && searchInput.value !== search) searchInput.value = search;
  const searchLabel = tool === "stamina" ? "搜索账号、区服或角色" : "搜索账号、区服、角色或团本";
  searchInput.placeholder = searchLabel;
  searchInput.setAttribute("aria-label", searchLabel);
  document.body.dataset.server = state.activeServer;
  document.body.dataset.tool = tool;
  market?.selectServer(state.activeServer);
  for (const control of toolButtons) {
    control.setAttribute("aria-pressed", String(control.dataset.tool === tool));
  }
  for (const control of document.querySelectorAll("[data-select-server]")) {
    control.setAttribute("aria-pressed", String(control.dataset.selectServer === state.activeServer));
  }
  const serverLabel = Tracker.getServerDef(state.activeServer).label;
  byId("workspace-title").textContent = serverLabel;
  toolNav.setAttribute("aria-label", serverLabel + "记录工具");
  byId("workspace-subtitle").textContent = tool === "stamina"
    ? "北京时间 06:00 重置体力完成标记"
    : "北京时间 06:00 重置今日已打标记，保留副本剩余次数";
  byId("raid-settings").hidden = tool !== "raids";
  renderStorageStatus();

  renderOverview();
  if (tool === "raids") renderSettings();
  renderFilters();
  renderAccounts();
  if (raidCatalogDialog.open) renderRaidCatalog();
  if (restoreDialog.open) renderRaidRestorePreview();
  if (raidClearsDialog.open) renderRaidClearsDialog();

  if (focused instanceof HTMLSelectElement && !focused.isConnected && focused.dataset.slot !== undefined) {
    const replacement = Array.from(byId("raid-controls").querySelectorAll("select"))
      .find((control) => control.dataset.slot === focused.dataset.slot);
    replacement?.focus({ preventScroll: true });
  }
  if (focused instanceof HTMLElement && !focused.isConnected && focused.matches("button, summary[data-menu]")) {
    const data = Object.entries(focused.dataset);
    if (data.length) {
      const replacement = Array.from(document.querySelectorAll("button[data-action], button[data-filter], summary[data-menu]"))
        .find((control) => data.every(([key, value]) => control.dataset[key] === value));
      if (replacement && !replacement.matches(":disabled") && !replacement.closest("[hidden]")) {
        replacement.focus({ preventScroll: true });
        return;
      }
      const tasks = taskIndex < 0 ? [] : visibleTasks(taskAction);
      const next = tasks[Math.min(taskIndex, tasks.length - 1)];
      if (next) next.focus({ preventScroll: !keyboardTaskFocus });
      else byId("filters").querySelector("[aria-pressed=true]")?.focus({ preventScroll: true });
    }
  }
}

function openAction(title, message, options, confirm) {
  pendingAction = confirm;
  byId("action-title").textContent = title;
  const description = byId("action-message");
  description.hidden = !message;
  description.textContent = message || "";
  const nameField = byId("name-field");
  const input = byId("name-input");
  nameField.hidden = !options.nameLabel;
  byId("name-label").textContent = options.nameLabel || "";
  input.disabled = nameField.hidden;
  input.required = !nameField.hidden;
  input.value = options.value || "";
  const choices = byId("choice-field");
  const select = byId("action-choice");
  choices.hidden = !options.choices;
  select.disabled = choices.hidden;
  byId("choice-label").textContent = options.choiceLabel || "";
  setChoices(select, options.choices || []);
  input.setCustomValidity("");
  const confirmButton = byId("confirm-action");
  confirmButton.textContent = options.confirmLabel || "确定";
  confirmButton.className = "button " + (options.danger ? "button--danger" : "button--primary");
  actionDialog.showModal();
  if (!nameField.hidden) {
    input.focus();
    input.select();
  } else if (!choices.hidden) {
    select.focus();
  }
}

function openName(title, label, value, confirm) {
  openAction(title, "", { nameLabel: label, value, confirmLabel: "保存" }, confirm);
}

byId("name-input").addEventListener("input", (event) => event.target.setCustomValidity(""));
byId("cancel-action").addEventListener("click", () => actionDialog.close());
byId("action-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = byId("name-input");
  const name = input.value.trim();
  if (!input.disabled && !name) {
    input.focus();
    input.setCustomValidity("请输入名称");
    input.reportValidity();
    return;
  }
  const confirm = pendingAction;
  actionDialog.close();
  pendingAction = null;
  if (confirm) confirm(name, byId("action-choice").value);
});

function records(ref) {
  const server = state.servers[ref.server];
  const account = server.accounts.find((item) => item.id === ref.account);
  const zone = account?.zones.find((item) => item.id === ref.zone);
  const character = zone?.characters.find((item) => item.id === ref.character);
  const raid = character?.raids.find((item) => item.name === ref.raid);
  return { server, account, zone, character, raid };
}

for (const control of document.querySelectorAll("[data-select-server]")) {
  control.addEventListener("click", () => {
    const reset = resetAtBoundary();
    const server = control.dataset.selectServer;
    if (server !== state.activeServer) {
      if (composingSearch) searchInput.blur();
      composingSearch = false;
      state.activeServer = server;
      render();
    } else if (reset) {
      render();
    }
  });
}

for (const control of toolButtons) {
  control.addEventListener("click", () => {
    const reset = resetAtBoundary();
    const tool = control.dataset.tool;
    if (tool !== currentTool()) {
      changeTool(tool);
      render();
    } else if (reset) {
      render();
    }
  });
}

byId("filters").addEventListener("click", (event) => {
  const filter = event.target.closest("button[data-filter]")?.dataset.filter;
  if (!filter) return;
  const reset = resetAtBoundary();
  const changed = filter !== currentFilter();
  if (changed) changeFilter(filter);
  if (reset) {
    render();
  } else if (changed) {
    renderFilters();
    renderAccounts();
  }
});

byId("raid-controls").addEventListener("click", (event) => {
  const control = event.target.closest("[data-action='toggle-catalog']");
  if (!control) return;
  resetAtBoundary();
  const result = Tracker.toggleActiveRaid(currentServer(), control.dataset.raid);
  if (!result.changed) {
    showToast(result.message);
    return;
  }
  editRecord(() => { state.servers[state.activeServer] = result.server; });
});

byId("raid-controls").addEventListener("change", (event) => {
  const control = event.target.closest("select[data-slot]");
  if (!control) return;
  const { slot } = control.dataset;
  const name = control.value;
  editRecord(() => {
    state.servers[state.activeServer] = Tracker.moveActiveRaid(currentServer(), Number(slot), name);
  });
});

byId("raid-mode").addEventListener("change", (event) => {
  const select = event.target;
  const mode = select.value;
  resetAtBoundary();
  const serverId = state.activeServer;
  const server = state.servers[serverId];
  select.value = Tracker.getRaidMode(server);
  const apply = () => {
    resetAtBoundary();
    const result = Tracker.setRaidMode(state.servers[serverId], mode);
    if (!result.changed) {
      showToast(result.message);
      return;
    }
    state.servers[serverId] = result.server;
    const saved = saveState();
    render();
    showToast(saved ? "副本启用方式已更新" : "已更新，请导出备份");
  };
  if (mode === "pair" && server.activeRaids.length > 2) {
    const keep = server.activeRaids.slice(0, 2).join("、");
    openAction("切换为双副本轮换", "将保留「" + keep + "」，并清除其他已启用副本的次数和今日标记。", {
      danger: true, confirmLabel: "确认切换",
    }, apply);
  } else {
    apply();
  }
});

function setCatalogMessage(message) {
  const status = byId("catalog-message");
  status.textContent = message;
  status.hidden = !message;
}

function renderRaidCatalog() {
  const server = currentServer();
  const catalog = Tracker.getRaidCatalog(server);
  const minimum = Tracker.getRaidMode(server) === "pair" ? 2 : 1;
  byId("raid-catalog-title").textContent = Tracker.getServerDef(server.serverId).label + "副本管理";
  byId("raid-catalog-list").replaceChildren(...catalog.map((raid) => {
    const rename = button("改名", "button button--secondary", { action: "rename-catalog-raid", raid: raid.name });
    rename.setAttribute("aria-label", raid.name + " 改名");
    const remove = button("移除", "button button--quiet", { action: "remove-catalog-raid", raid: raid.name });
    remove.setAttribute("aria-label", raid.name + " 移除");
    remove.disabled = catalog.length <= minimum;
    if (remove.disabled) remove.title = "当前服至少保留 " + minimum + " 个副本";
    return make("div", "catalog-row",
      make("div", "catalog-identity",
        make("strong", "", raid.name),
        make("small", "", server.activeRaids.includes(raid.name) ? "已启用" : "未启用")
      ),
      make("div", "catalog-actions", rename, remove)
    );
  }));
}

function editRaidCatalog(serverId, apply, message) {
  resetAtBoundary();
  const result = apply(state.servers[serverId]);
  if (!result.changed) {
    setCatalogMessage(result.message || "副本设置没有变化");
    return false;
  }
  state.servers[serverId] = result.server;
  const saved = saveState();
  render();
  setCatalogMessage(saved ? message : message + "，请导出备份");
  return true;
}

byId("open-raid-catalog").addEventListener("click", () => {
  resetAtBoundary();
  renderRaidCatalog();
  setCatalogMessage("");
  byId("catalog-raid-name").value = "";
  raidCatalogDialog.showModal();
});
byId("close-raid-catalog").addEventListener("click", () => raidCatalogDialog.close());

byId("add-catalog-raid").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = byId("catalog-raid-name");
  const name = input.value.trim();
  if (!name) {
    input.focus();
    setCatalogMessage("请输入副本名称");
    return;
  }
  const added = editRaidCatalog(state.activeServer, (server) => Tracker.addRaid(server, name), "副本已添加，可在副本设置中启用。");
  if (added) input.value = "";
  input.focus();
});

byId("raid-catalog-list").addEventListener("click", (event) => {
  const control = event.target.closest("button[data-action]");
  if (!control) return;
  const name = control.dataset.raid;
  const serverId = state.activeServer;
  if (control.dataset.action === "rename-catalog-raid") {
    openName("修改副本名称", "副本名称", name, (next) => {
      if (editRaidCatalog(serverId, (server) => Tracker.renameRaid(server, name, next), "副本名称已更新。")) {
        byId("catalog-raid-name").focus();
      }
    });
    return;
  }
  const active = currentServer().activeRaids.includes(name);
  const message = active
    ? "移除「" + name + "」及该服所有角色的对应副本记录？"
    : "从副本目录中移除「" + name + "」？";
  openAction("移除副本", message, { danger: true, confirmLabel: "移除副本" }, () => {
    if (editRaidCatalog(serverId, (server) => Tracker.removeRaid(server, name), "副本已移除。")) {
      byId("catalog-raid-name").focus();
    }
  });
});

function changeAttempts(delta) {
  editRecord(() => {
    const server = currentServer();
    state.servers[state.activeServer] = Tracker.setMaxAttempts(server, server.maxAttempts + delta);
  });
}

byId("increase-attempts").addEventListener("click", () => changeAttempts(1));
byId("decrease-attempts").addEventListener("click", () => changeAttempts(-1));

function raidRestorePlan() {
  const current = state.servers[restoreServerId];
  const accountId = byId("raid-restore-account").value;
  const raidName = byId("raid-restore-raid").value;
  const restoreTotal = restoreServerId === "regular" && byId("raid-restore-total").checked;
  const next = Tracker.resetRaidCycle(current, { accountId, raidName, restoreTotal });
  const changes = [];
  current.accounts.forEach((account, accountIndex) => {
    if (accountId && account.id !== accountId) return;
    const planned = next.accounts[accountIndex];
    const details = [];
    const quotas = [null, ...(account.raidQuota?.raids || []).map(({ name }) => name)];
    for (const name of quotas) {
      const previous = Tracker.getAccountRaidQuota(account, name);
      const updated = Tracker.getAccountRaidQuota(planned, name);
      if (previous && updated && previous.remaining !== updated.remaining) {
        details.push((name || "账号总奖励") + " " + previous.remaining + " → " + updated.remaining + "/" + updated.maxAttempts);
      }
    }
    const roles = new Map();
    account.zones.forEach((zone, zoneIndex) => {
      zone.characters.forEach((character, charIndex) => {
        const target = planned.zones[zoneIndex].characters[charIndex];
        const before = Tracker.getCharacterRaidQuota(character);
        const after = Tracker.getCharacterRaidQuota(target);
        if (before && after && before.remaining !== after.remaining) {
          details.push(character.name + "总奖励 " + before.remaining + " → " + after.remaining + "/" + after.maxAttempts);
        }
        for (let index = 0; index < character.raids.length; index += 1) {
          const oldRaid = character.raids[index];
          const newRaid = target.raids[index];
          if (oldRaid.remaining !== newRaid.remaining ||
              JSON.stringify(Tracker.getRaidClears(oldRaid)) !== JSON.stringify(Tracker.getRaidClears(newRaid))) {
            roles.set(oldRaid.name, (roles.get(oldRaid.name) || 0) + 1);
          }
        }
      });
    });
    for (const [name, count] of roles) details.push(name + "恢复 " + count + " 个角色");
    if (details.length) changes.push({ accountName: account.name, details });
  });
  return { next, changes };
}

function renderRaidRestorePreview() {
  if (!restoreServerId) return;
  const { changes } = raidRestorePlan();
  const preview = byId("raid-restore-preview");
  preview.replaceChildren(...(changes.length ? changes.map(({ accountName, details }) => make(
    "div", "", make("strong", "", accountName), make("p", "", details.join(" · "))
  )) : [make("p", "", "所选范围内的次数已满。")]));
  byId("confirm-raid-restore").disabled = !changes.length || recoveryWriting;
}

byId("restore-raids").addEventListener("click", () => {
  resetAtBoundary();
  restoreServerId = state.activeServer;
  const server = currentServer();
  const names = new Set([...server.activeRaids, ...server.accounts.flatMap((account) => (
    (account.raidQuota?.raids || []).map(({ name }) => name)
  ))]);
  setChoices(byId("raid-restore-account"), [["", "全部账号"], ...server.accounts.map(({ id, name }) => [id, name])]);
  setChoices(byId("raid-restore-raid"), [["", "全部团本"], ...Array.from(names, (name) => [name, name])]);
  byId("raid-restore-total-field").hidden = restoreServerId !== "regular";
  byId("raid-restore-total").checked = true;
  byId("raid-restore-message").hidden = true;
  renderRaidRestorePreview();
  restoreDialog.showModal();
});

byId("raid-restore-account").addEventListener("change", renderRaidRestorePreview);
byId("raid-restore-total").addEventListener("change", renderRaidRestorePreview);
byId("raid-restore-raid").addEventListener("change", (event) => {
  byId("raid-restore-total").checked = !event.target.value;
  renderRaidRestorePreview();
});
byId("close-raid-restore").addEventListener("click", () => restoreDialog.close());
restoreDialog.addEventListener("cancel", (event) => {
  if (restoreDialog.getAttribute("aria-busy") === "true") event.preventDefault();
});
restoreDialog.addEventListener("close", () => {
  if (!restoreDialog.open) restoreServerId = null;
});
byId("raid-restore-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!restoreServerId || recoveryWriting) return;
  resetAtBoundary();
  const id = restoreServerId;
  const { next, changes } = raidRestorePlan();
  if (!changes.length) return;
  const status = byId("raid-restore-message");
  status.textContent = "正在保存恢复点和变更…";
  status.hidden = false;
  restoreDialog.setAttribute("aria-busy", "true");
  const controls = ["raid-restore-account", "raid-restore-raid", "raid-restore-total", "close-raid-restore"];
  for (const control of controls) byId(control).disabled = true;
  byId("confirm-raid-restore").disabled = true;
  try {
    const saved = await saveRestorable("恢复副本次数", {
      ...state,
      servers: { ...state.servers, [id]: next },
    });
    if (!saved) throw new Error("浏览器保存失败，请重试。");
    restoreDialog.close();
    render();
    showToast("已恢复所选范围的副本次数");
  } catch (error) {
    status.textContent = error.message;
    renderRaidRestorePreview();
  } finally {
    restoreDialog.removeAttribute("aria-busy");
    for (const control of controls) byId(control).disabled = false;
  }
});

byId("reset-daily").addEventListener("click", () => {
  closeMenus();
  byId("open-more").focus({ preventScroll: true });
  const serverId = state.activeServer;
  const label = Tracker.getServerDef(serverId).label;
  openAction("重置今日进度", "清除" + label + "的体力完成和今日已打标记，保留副本剩余次数。",
    { confirmLabel: "重置进度" }, async () => {
      resetAtBoundary();
      const next = Tracker.resetDailyProgress(state.servers[serverId]);
      try {
        const saved = await saveRestorable("重置今日进度", {
          ...state,
          servers: { ...state.servers, [serverId]: next },
        });
        if (!saved) throw new Error("浏览器保存失败，请重试。");
        render();
        showToast("今日进度已重置");
      } catch (error) {
        showToast(error.message);
      }
    });
});

byId("add-account").addEventListener("click", () => {
  const serverId = state.activeServer;
  if (currentServer().accounts.length >= Tracker.ACCOUNT_LIMIT) {
    showToast("该服最多可保存 " + Tracker.ACCOUNT_LIMIT + " 个账号");
    return;
  }
  openName("添加账号", "账号名称", "", (name) => {
    if (state.servers[serverId].accounts.length >= Tracker.ACCOUNT_LIMIT) {
      showToast("该服最多可保存 " + Tracker.ACCOUNT_LIMIT + " 个账号");
      return;
    }
    changeFilter("all");
    editRecord(() => state.servers[serverId].accounts.push(Tracker.createAccount(name, serverId)), "账号已添加");
  });
});

function characterTotal(server) {
  return server.accounts.reduce((total, account) => (
    total + account.zones.reduce((count, zone) => count + zone.characters.length, 0)
  ), 0);
}

function applyRecordChange(ref, target, after) {
  const before = Object.fromEntries(Object.keys(after).map((field) => [field, target[field]]));
  Object.assign(target, after);
  return { ref, before, after };
}

function recordProgress(ref, record) {
  const { server, account, character, raid } = record;
  if (ref.raid) {
    if (!raid) return;
    const clearId = Tracker.recordRaidClear(server, account, character, raid);
    if (clearId) {
      recordCompletion([{ ref, clearId }], "已记录 1 次通关");
    } else {
      render();
    }
  } else if (character) {
    const staminaDone = !character.staminaDone;
    const change = applyRecordChange(ref, character, { staminaDone });
    recordCompletion([change], staminaDone ? "已记录体力完成" : "已取消体力完成标记");
  }
}

function renderRaidClearsDialog() {
  const { raid, character } = records(raidClearsContext);
  const clears = raid ? Tracker.getRaidClears(raid) : [];
  const list = byId("raid-clears-list");
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.clearId : "";
  byId("raid-clears-title").textContent = raid ? raid.name + "通关记录" : "通关记录";
  byId("raid-clears-summary").textContent = raid
    ? "角色「" + character.name + "」今日记录 " + clears.length + " 笔。"
    : "当前记录已更新。";
  const entries = clears.map(({ id, recordedAt }, index) => {
    const label = "第 " + (index + 1) + " 笔";
    const undo = button("撤销", "button button--secondary", { clearId: id });
    undo.setAttribute("aria-label", "撤销" + label + "通关记录");
    const time = recordedAt === undefined ? "" : clearTime.format(recordedAt);
    return make("li", "raid-clear-record", make("div", "",
      make("strong", "", label), time ? make("small", "", time) : ""
    ), undo);
  });
  list.replaceChildren(...(entries.length ? entries.reverse() : [make("li", "dialog-message", "今日暂无通关记录。")]));
  if (focused) {
    const buttons = Array.from(list.querySelectorAll("[data-clear-id]"));
    (buttons.find((item) => item.dataset.clearId === focused) || buttons[0] || byId("close-raid-clears")).focus();
  }
}

function openRaidClears(ref) {
  raidClearsContext = ref;
  renderRaidClearsDialog();
  raidClearsDialog.showModal();
}

byId("close-raid-clears").addEventListener("click", () => raidClearsDialog.close());
raidClearsDialog.addEventListener("close", () => { if (!raidClearsDialog.open) raidClearsContext = null; });
byId("raid-clears-list").addEventListener("click", (event) => {
  const action = event.target.closest("button[data-clear-id]");
  if (!action || !raidClearsContext) return;
  resetAtBoundary();
  const { server, account, character, raid } = records(raidClearsContext);
  if (!Tracker.undoRaidClear(server, account, character, raid, action.dataset.clearId)) {
    render();
    byId("raid-clears-summary").textContent = "这笔记录已更新，请核对当前列表。";
    return;
  }
  const saved = saveState();
  render();
  byId("raid-clears-summary").textContent = saved ? "已撤销这笔通关记录。" : "已撤销，请导出备份。";
});

function toggleAccountStamina(ref, account) {
  const characters = account.zones.flatMap((zone) => zone.characters.map((character) => ({ zone, character })));
  if (!characters.length) return;
  const staminaDone = characters.some(({ character }) => !character.staminaDone);
  const changes = characters
    .filter(({ character }) => character.staminaDone !== staminaDone)
    .map(({ zone, character }) => applyRecordChange({ ...ref, zone: zone.id, character: character.id }, character, { staminaDone }));
  recordCompletion(changes, staminaDone ? "本账号体力已全部标记" : "已取消本账号全部体力标记");
}

function clampRemaining(value, maximum) {
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}

function setRoleRemaining(server, raid, value) {
  const remaining = clampRemaining(value, Tracker.raidLimit(server, raid));
  if (remaining === raid.remaining) return;
  raid.remaining = remaining;
  Tracker.clearRaidCharge(raid);
}

function quotaEditRow(name, label, quota, fallback = "") {
  const row = make("div", "quota-edit-row", make("strong", "", label));
  row.dataset.raidName = name ?? "";
  for (const [field, title, minimum] of [["remaining", "剩余次数", 0], ["maxAttempts", "上限", 1]]) {
    const input = make("input", "");
    input.type = "number";
    input.step = "1";
    input.inputMode = "numeric";
    input.min = String(minimum);
    input.max = String(Number.MAX_SAFE_INTEGER);
    input.dataset.quotaField = field;
    input.defaultValue = quota?.[field] === undefined ? "" : String(quota[field]);
    if (field === "maxAttempts") input.placeholder = fallback;
    input.setAttribute("aria-label", label + " " + title);
    row.append(make("label", "dialog-field", make("span", "", title), input));
  }
  return row;
}

function openRaidQuota(ref, { server, account, character, raid }) {
  const characterTotal = ref.action === "edit-character-quota";
  if (server.serverId !== "regular" || (ref.raid && !raid) || (characterTotal && !character)) return;
  quotaContext = ref;
  byId("raid-quota-error").hidden = true;
  let title;
  let description;
  let rows;
  if (characterTotal) {
    title = "角色总奖励额度";
    description = "角色「" + character.name + "」的所有团本共享这项额度。只填上限按满额保存。两项留空可取消。";
    rows = [quotaEditRow("character-total", "角色总奖励次数", Tracker.getCharacterRaidQuota(character), "例如 30")];
  } else if (raid) {
    title = "角色单本额度";
    description = "角色「" + character.name + "」。上限留空时使用常规服的角色单本默认上限。";
    rows = [quotaEditRow(raid.name, raid.name, raid, String(Tracker.raidLimit(server)))];
  } else {
    title = "账号团本额度";
    description = "账号「" + account.name + "」。只填上限时按满额保存。单团本两项留空可取消该项额度。";
    rows = [
      quotaEditRow(null, "团本总奖励次数", Tracker.getAccountRaidQuota(account)),
      ...Tracker.getRaidCatalog(server).map(({ name }) => quotaEditRow(name, name, Tracker.getAccountRaidQuota(account, name))),
    ];
  }
  byId("raid-quota-title").textContent = title;
  byId("raid-quota-description").textContent = description;
  byId("raid-quota-fields").replaceChildren(...rows);
  raidQuotaDialog.showModal();
}

function readQuotaRow(row, defaultMaximum) {
  const remainingField = row.querySelector("[data-quota-field='remaining']");
  const maximumField = row.querySelector("[data-quota-field='maxAttempts']");
  if (remainingField.value === remainingField.defaultValue && maximumField.value === maximumField.defaultValue) return null;
  const name = row.dataset.raidName || null;
  if (defaultMaximum === undefined && name && !remainingField.value && !maximumField.value) return { name, quota: null };
  const override = maximumField.value ? maximumField.valueAsNumber : undefined;
  const maxAttempts = override ?? defaultMaximum;
  const remaining = remainingField.value ? remainingField.valueAsNumber : maxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
      !Number.isSafeInteger(remaining) || remaining < 0 || remaining > maxAttempts) {
    throw new Error("「" + row.querySelector("strong").textContent + "」请填写正整数上限，剩余次数须在 0 到上限之间。");
  }
  return { name, quota: { maxAttempts, remaining }, override };
}

byId("close-raid-quota").addEventListener("click", () => raidQuotaDialog.close());
raidQuotaDialog.addEventListener("close", () => {
  if (!raidQuotaDialog.open) quotaContext = null;
});
byId("raid-quota-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!quotaContext) return;
  resetAtBoundary();
  const { server, account, character, raid } = records(quotaContext);
  const characterTotal = quotaContext.action === "edit-character-quota";
  const error = byId("raid-quota-error");
  try {
    if (!account || (quotaContext.raid && !raid) || (characterTotal && !character)) {
      throw new Error("这条记录已更新，请重新打开额度设置。");
    }
    const rows = Array.from(byId("raid-quota-fields").children);
    const updates = rows.map((row) => readQuotaRow(row, raid ? Tracker.raidLimit(server) : undefined)).filter(Boolean);
    if (!updates.length) {
      raidQuotaDialog.close();
      return;
    }
    if (characterTotal) {
      Tracker.setCharacterRaidQuota(character, updates[0].quota);
    } else if (raid) {
      const [{ quota, override }] = updates;
      if (override === undefined) delete raid.maxAttempts;
      else raid.maxAttempts = override;
      setRoleRemaining(server, raid, quota.remaining);
    } else {
      const catalog = new Set(Tracker.getRaidCatalog(server).map(({ name }) => name));
      if (updates.some(({ name }) => name && !catalog.has(name))) {
        throw new Error("副本目录已更新，请重新打开额度设置。");
      }
      for (const { name, quota } of updates) Tracker.setAccountRaidQuota(account, name, quota);
    }
    const saved = saveState();
    raidQuotaDialog.close();
    render();
    showToast(saved ? "团本额度已保存" : "团本额度已更新，请导出备份");
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
});

function sameZoneName(account, name, exceptId) {
  const key = name.trim().toLocaleLowerCase();
  return account.zones.some((zone) => zone.id !== exceptId && zone.name.toLocaleLowerCase() === key);
}

function addZone(ref) {
  openName("添加区服", "区服名称", "", (name) => {
    resetAtBoundary();
    const { account } = records(ref);
    if (!account) return;
    if (sameZoneName(account, name)) {
      showToast("这个账号下已有同名区服");
      return;
    }
    changeFilter("all");
    setCollapsed(account.id, false);
    editRecord(() => records(ref).account.zones.push(Tracker.createZone(name)), "区服已添加");
  });
}

function addCharacter(ref) {
  const maximum = "该服最多可保存 " + Tracker.CHARACTER_LIMIT + " 个角色";
  if (characterTotal(records(ref).server) >= Tracker.CHARACTER_LIMIT) {
    showToast(maximum);
    return;
  }
  openName("添加角色", "角色名称", "", (name) => {
    resetAtBoundary();
    const { server, zone } = records(ref);
    if (!zone) return;
    if (characterTotal(server) >= Tracker.CHARACTER_LIMIT) {
      showToast(maximum);
      return;
    }
    changeFilter("all");
    editRecord(() => {
      const current = records(ref);
      current.zone.characters.push(Tracker.createCharacter(name, current.server.activeRaids, current.server.maxAttempts));
    }, "角色已添加");
  });
}

const entryLabels = { account: "账号", zone: "区服", character: "角色" };

function renameEntry(ref, kind) {
  const item = records(ref)[kind];
  if (!item) return;
  const label = entryLabels[kind];
  openName("修改" + label + "名称", label + "名称", item.name, (name) => {
    resetAtBoundary();
    const current = records(ref);
    if (!current[kind]) return;
    if (kind === "zone" && sameZoneName(current.account, name, current.zone.id)) {
      showToast("这个账号下已有同名区服");
      return;
    }
    editRecord(() => { records(ref)[kind].name = name; }, "名称已更新");
  });
}

function deleteEntry(ref, kind) {
  const item = records(ref)[kind];
  if (!item) return;
  const label = entryLabels[kind];
  const following = {
    account: "及其所有区服和角色",
    zone: "及该区所有角色",
    character: "及其进度",
  };
  openAction("删除" + label, "删除「" + item.name + "」" + following[kind] + "？", {
    danger: true, confirmLabel: "删除" + label,
  }, () => {
    editRecord(() => {
      const { server, account, zone } = records(ref);
      if (kind === "account") {
        server.accounts = server.accounts.filter((entry) => entry.id !== ref.account);
        setCollapsed(ref.account, false);
      } else if (kind === "zone" && account) {
        account.zones = account.zones.filter((entry) => entry.id !== ref.zone);
      } else if (zone) {
        zone.characters = zone.characters.filter((entry) => entry.id !== ref.character);
      }
    }, label + "已删除");
  });
}

function moveCharacter(ref) {
  const { account, zone, character } = records(ref);
  if (!zone || !character) return;
  const choices = account.zones.filter((entry) => entry.id !== zone.id)
    .map((entry) => [entry.id, entry.name]);
  if (!choices.length) return;
  openAction("移动角色", "把「" + character.name + "」从「" + zone.name + "」移到另一个区服。副本和体力进度会随角色移动。", {
    choiceLabel: "移到区服", choices, confirmLabel: "移动角色",
  }, (_name, destinationId) => {
    resetAtBoundary();
    const current = records(ref);
    const destination = current.account?.zones.find((entry) => entry.id === destinationId);
    if (!destination || !current.character || destination.id === ref.zone) {
      showToast("目标区服或角色已变更");
      return;
    }
    const characterToMove = current.character;
    current.zone.characters = current.zone.characters.filter((entry) => entry !== characterToMove);
    if (destination.characters.some((entry) => entry.id === characterToMove.id)) {
      characterToMove.id = Tracker.createId("character");
    }
    destination.characters.push(characterToMove);
    const saved = saveState();
    render();
    showToast("已移到「" + destination.name + "」" + (saved ? "" : "，请导出备份"));
  });
}

function closeMenus(except) {
  const moreMenu = byId("more-menu");
  if (except !== moreMenu) {
    moreMenu.hidden = true;
    byId("open-more").setAttribute("aria-expanded", "false");
  }
  for (const menu of document.querySelectorAll(".entry-menu[open]")) {
    if (except !== menu) menu.open = false;
  }
}

byId("open-more").addEventListener("click", () => {
  const moreMenu = byId("more-menu");
  const willOpen = moreMenu.hidden;
  closeMenus();
  if (willOpen) {
    moreMenu.hidden = false;
    byId("open-more").setAttribute("aria-expanded", "true");
  }
});

byId("open-font-settings").addEventListener("click", () => {
  closeMenus();
  fontDialog.querySelector(".font-preview-title").textContent = byId("workspace-title").textContent;
  fontDialog.showModal();
  fontDialog.querySelector(":checked")?.focus();
});

fontDialog.addEventListener("change", (event) => {
  const choice = event.target;
  if (!choice.matches('input[name="font-preset"]') || !FONT_PRESETS.has(choice.value)) return;
  applyFontPreset(choice.value);
  try {
    localStorage.setItem(FONT_KEY, choice.value);
    fontNote.textContent = defaultFontNote;
  } catch {
    fontNote.textContent = "字体已应用到当前页面，浏览器存储不可用。";
  }
});

fontDialog.addEventListener("close", () => byId("open-more").focus({ preventScroll: true }));

document.addEventListener("click", (event) => {
  const keep = event.target.closest(".more-wrap") ? byId("more-menu") : event.target.closest(".entry-menu[open]");
  closeMenus(keep);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const menu = event.target.closest(".entry-menu[open]");
  if (menu) {
    event.preventDefault();
    menu.querySelector("summary").focus();
    closeMenus();
  } else if (!byId("more-menu").hidden) {
    event.preventDefault();
    closeMenus();
    byId("open-more").focus();
  }
});

accountList.addEventListener("click", (event) => {
  const control = event.target.closest("button[data-action]");
  if (!control) return;
  const menu = control.closest(".entry-menu[open]");
  if (menu) {
    menu.open = false;
    menu.querySelector("summary").focus({ preventScroll: true });
  }
  const reset = resetAtBoundary();
  const ref = { ...control.dataset, server: state.activeServer };
  const record = records(ref);
  if (!record.account) return;

  switch (ref.action) {
    case "stamina":
    case "raid":
      recordProgress(ref, record);
      break;
    case "stamina-all":
      toggleAccountStamina(ref, record.account);
      break;
    case "remaining-minus":
    case "remaining-plus":
      if (record.raid) editRecord(() => {
        const { server, raid } = records(ref);
        if (raid) {
          const delta = ref.action === "remaining-plus" ? 1 : -1;
          setRoleRemaining(server, raid, raid.remaining + delta);
        }
      });
      break;
    case "edit-raid-quota":
    case "edit-character-quota":
      openRaidQuota(ref, record);
      break;
    case "raid-clears":
      if (reset) render();
      openRaidClears(ref);
      break;
    case "toggle-account": {
      const collapsed = control.getAttribute("aria-expanded") === "true";
      setCollapsed(ref.account, collapsed);
      if (reset) {
        render();
      } else {
        control.setAttribute("aria-expanded", String(!collapsed));
        control.querySelector(".account-progress").textContent = accountProgress(record.account, collapsed);
        byId(control.getAttribute("aria-controls")).hidden = collapsed;
      }
      break;
    }
    case "open-batch":
      openBatch(ref, record);
      break;
    case "add-zone":
      addZone(ref);
      break;
    case "add-character":
      addCharacter(ref);
      break;
    case "move-character":
      moveCharacter(ref);
      break;
    case "rename-account":
    case "rename-zone":
    case "rename-character":
      renameEntry(ref, ref.action.slice("rename-".length));
      break;
    case "delete-account":
    case "delete-zone":
    case "delete-character":
      deleteEntry(ref, ref.action.slice("delete-".length));
      break;
  }
});

accountList.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-field='remaining']");
  if (!input) return;
  const reset = resetAtBoundary();
  const { raid, server, account, character } = records({ ...input.dataset, server: state.activeServer });
  if (!raid) return;
  if (Number.isFinite(input.valueAsNumber)) {
    setRoleRemaining(server, raid, input.valueAsNumber);
    saveState();
  }
  input.value = String(raid.remaining);
  if (reset) {
    render();
    return;
  }
  if (currentFilter() === "raid" && !raidCanRecord(account, character, raid)) {
    renderOverview();
    renderAccounts();
    return;
  }
  const row = input.closest(".raid-row");
  renderRaidAvailability(input.closest(".raid-entry"), account, character, raid);
  row.querySelector("[data-action='remaining-minus']").disabled = raid.remaining <= 0;
  row.querySelector("[data-action='remaining-plus']").disabled = raid.remaining >= Tracker.raidLimit(server, raid);
  renderOverview();
});

function setChoices(select, choices) {
  select.replaceChildren(...choices.map(([value, label]) => {
    const option = make("option", "", label);
    option.value = value;
    return option;
  }));
}

function openBatch(ref, { account, server }) {
  batchContext = { account: ref.account, server: ref.server };
  byId("batch-account").textContent = "账号「" + account.name + "」";
  const stamina = currentTool() === "stamina";
  byId("batch-title").textContent = stamina ? "批量记录体力" : "批量记录副本";
  byId("batch-kind-field").hidden = stamina;
  const choices = stamina ? [["stamina", "每日体力"]] : server.activeRaids.map((name) => ["raid:" + name, name]);
  setChoices(byId("batch-kind"), choices);
  renderBatchOptions();
  batchDialog.showModal();
}

function selectedBatchRaid() {
  const value = byId("batch-kind").value;
  return value.startsWith("raid:") ? value.slice("raid:".length) : null;
}

function batchInputs() {
  return Array.from(byId("batch-options").querySelectorAll("input[type='checkbox']"));
}

function batchRaidCapacity() {
  const raid = selectedBatchRaid();
  if (!batchContext || !raid) return Infinity;
  const { account } = records(batchContext);
  return Math.min(
    Tracker.getAccountRaidQuota(account)?.remaining ?? Infinity,
    Tracker.getAccountRaidQuota(account, raid)?.remaining ?? Infinity
  );
}

function updateBatchSelection() {
  const inputs = batchInputs();
  const count = inputs.filter((input) => input.checked).length;
  const limit = Math.min(inputs.length, batchRaidCapacity());
  const selectAll = byId("batch-select-all");
  selectAll.disabled = limit === 0 && count === 0;
  selectAll.textContent = count && count >= limit ? "取消全选" : limit < inputs.length ? "选到额度上限" : "全选";
  byId("batch-selection").textContent = "已选 " + count + " 个角色" + (limit < inputs.length ? " · 最多可记录 " + limit + " 个" : "");
  const confirm = byId("batch-confirm");
  confirm.disabled = !count || count > limit;
  confirm.textContent = selectedBatchRaid() ? count + " 个角色各记 1 次" : "完成 " + count + " 个角色";
}

function renderBatchOptions() {
  if (!batchContext) return;
  const raidName = selectedBatchRaid();
  const { account } = records(batchContext);
  const groups = [];
  for (const zone of account?.zones || []) {
    const group = make("fieldset", "batch-group", make("legend", "", zone.name));
    for (const character of zone.characters) {
      const raid = raidName ? character.raids.find((entry) => entry.name === raidName) : null;
      if (raidName ? !raidCanRecord(account, character, raid) : character.staminaDone) continue;
      const input = make("input", "");
      input.type = "checkbox";
      Object.assign(input.dataset, { zone: zone.id, character: character.id });
      const text = character.name + (raid ? " · 剩 " + raid.remaining + " 次" : "");
      group.append(make("label", "batch-option", input, make("span", "", text)));
    }
    if (group.children.length > 1) groups.push(group);
  }
  const empty = make("p", "dialog-message", "这项没有可批量完成的角色。");
  byId("batch-options").replaceChildren(...(groups.length ? groups : [empty]));
  updateBatchSelection();
}

byId("batch-kind").addEventListener("change", renderBatchOptions);
byId("batch-options").addEventListener("change", updateBatchSelection);
byId("batch-select-all").addEventListener("click", () => {
  const inputs = batchInputs();
  const limit = Math.min(inputs.length, batchRaidCapacity());
  let count = inputs.filter((input) => input.checked).length;
  if (count >= limit) {
    for (const input of inputs) input.checked = false;
  } else {
    for (const input of inputs) {
      if (count >= limit) break;
      if (input.checked) continue;
      input.checked = true;
      count += 1;
    }
  }
  updateBatchSelection();
});
byId("close-batch").addEventListener("click", () => batchDialog.close());
batchDialog.addEventListener("close", () => { batchContext = null; });

byId("batch-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!batchContext) return;
  resetAtBoundary();
  const raidName = selectedBatchRaid();
  const selected = batchInputs().filter((input) => input.checked);
  if (selected.length > batchRaidCapacity()) {
    updateBatchSelection();
    return;
  }
  const changes = [];
  for (const input of selected) {
    const ref = { ...batchContext, ...input.dataset, raid: raidName };
    const target = records(ref);
    if (raidName && target.raid) {
      const clearId = Tracker.recordRaidClear(target.server, target.account, target.character, target.raid);
      if (clearId) changes.push({ ref, clearId });
    } else if (!raidName && target.character && !target.character.staminaDone) {
      changes.push(applyRecordChange(ref, target.character, { staminaDone: true }));
    }
  }
  batchDialog.close();
  if (!changes.length) {
    render();
    showToast("所选角色的进度已经更新");
    return;
  }
  recordCompletion(changes, "已记录 " + changes.length + " 个角色的" + (raidName ? "副本" : "体力"));
});

function backupText() {
  resetAtBoundary();
  return JSON.stringify(Tracker.formatBackup(state));
}

function recoveryPlan(point, preference) {
  const clock = new Date();
  const ids = Object.keys(point.before.servers);
  const align = (value) => scopedSnapshot(Tracker.ensureDailyReset(value, clock).state, ids);
  const current = align(state);
  const { data, conflicts } = window.JingheSyncMerge.merge(align(point.after), align(point.before), current, preference);
  const next = { ...state, servers: { ...state.servers, ...data.servers } };
  return { next, conflicts };
}

function openRecoveryPoint(point) {
  if (recoveryWriting) return;
  resetAtBoundary();
  const base = Tracker.snapshotApp(state);
  const { next, conflicts } = recoveryPlan(point, "remote");
  const message = byId("recovery-message");
  if (!conflicts.length && !changedServers(base, Tracker.snapshotApp(next)).length) {
    message.textContent = "当前记录已包含这次恢复结果。";
    return;
  }
  const options = { confirmLabel: "确认回退" };
  let description = "回退「" + point.label + "」造成的变更。";
  if (conflicts.length) {
    description += "其中 " + conflicts.length + " 项后来又有修改。";
    options.choiceLabel = "重叠项如何处理";
    options.choices = [["remote", "保留后来修改的值"], ["local", "采用恢复点的值"]];
  }
  openAction("确认回退", description, options, async (_name, preference) => {
    resetAtBoundary();
    try {
      if (state.dailyDate !== base.dailyDate || changedServers(base, Tracker.snapshotApp(state)).length) {
        throw new Error("记录刚刚更新，请重新选择恢复点。");
      }
      const planned = recoveryPlan(point, preference === "local" ? "local" : "remote");
      if (!changedServers(base, Tracker.snapshotApp(planned.next)).length) {
        message.textContent = "没有需要回退的记录。";
        return;
      }
      if (!await saveRestorable("回退恢复点", planned.next)) throw new Error("浏览器保存失败，请重试。");
      render();
      await renderRecoveryPoints();
      message.textContent = "已回退所选恢复点。";
      showToast("已回退所选恢复点");
    } catch (error) {
      message.textContent = error.message;
    }
  });
}

const recoveryTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short",
});

async function renderRecoveryPoints() {
  const list = byId("recovery-list");
  const message = byId("recovery-message");
  message.textContent = "正在读取恢复点…";
  list.replaceChildren();
  try {
    const points = await window.JingheRecovery.list();
    if (!recoveryDialog.open) return;
    message.textContent = points.length ? "" : "这里还没有恢复点。";
    list.replaceChildren(...points.reverse().map((point) => {
      const names = Object.keys(point.before.servers).map((id) => Tracker.getServerDef(id).label);
      const meta = make("small", "", names.join("、") + " · " + recoveryTime.format(point.createdAt));
      const control = button("回退", "button button--secondary");
      control.setAttribute("aria-label", "回退" + point.label);
      control.addEventListener("click", () => openRecoveryPoint(point));
      return make("div", "recovery-item", make("div", "", make("strong", "", point.label), meta), control);
    }));
  } catch {
    message.textContent = "当前浏览器无法读取恢复点。";
  }
}

byId("open-recovery").addEventListener("click", () => {
  closeMenus();
  byId("open-more").focus({ preventScroll: true });
  recoveryDialog.showModal();
  void renderRecoveryPoints();
});
byId("close-recovery").addEventListener("click", () => recoveryDialog.close());

function backupMessage(message) {
  const element = byId("backup-message");
  element.hidden = !message;
  element.textContent = message;
}

byId("open-backup").addEventListener("click", () => {
  closeMenus();
  byId("open-more").focus({ preventScroll: true });
  backupMessage("");
  backupDialog.showModal();
});
byId("close-backup").addEventListener("click", () => backupDialog.close());
function downloadBackup() {
  const blob = new Blob([backupText()], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = make("a", "");
  link.href = url;
  link.download = "晶核助手-" + Tracker.dailyCycleKey(new Date()) + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

byId("download-backup").addEventListener("click", () => {
  downloadBackup();
  backupMessage("备份文件已生成");
});
byId("sync-backup-local").addEventListener("click", downloadBackup);
byId("copy-backup").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(backupText());
    backupMessage("备份已复制");
  } catch {
    backupMessage("当前浏览器无法自动复制，请使用「下载备份」。");
  }
});
byId("backup-file").addEventListener("change", async (event) => {
  const input = event.target;
  const [file] = input.files;
  if (!file) return;
  try {
    if (file.size > Tracker.BACKUP_LIMIT * 4) throw new Error("备份文件过大");
    backupInput.value = await file.text();
    backupMessage("已读取 " + file.name + "，请选择合并或覆盖。");
  } catch (error) {
    backupMessage("读取失败：" + error.message);
  } finally {
    input.value = "";
  }
});

function alignBackupDate(backup) {
  const incoming = backup.mode === "legacy-season" ? Tracker.createAppState() : backup.app;
  if (backup.mode === "legacy-season") {
    incoming.servers.season = backup.server;
    incoming.dailyDate = backup.dailyDate;
    incoming.dailyResetHour = backup.dailyResetHour;
  }
  const { state: aligned } = Tracker.ensureDailyReset(incoming, new Date());
  return {
    ...backup,
    app: aligned,
    server: aligned.servers.season,
    dailyDate: aligned.dailyDate,
    dailyResetHour: aligned.dailyResetHour,
  };
}

function importBackup(replace) {
  let backup;
  try {
    backup = alignBackupDate(Tracker.parseBackupText(backupInput.value.replace(/^\uFEFF/, "")));
  } catch (error) {
    backupMessage(error.message);
    return;
  }
  const scope = backup.mode === "legacy-season" ? "赛季服" : "两个服";
  const details = scope + "备份中有 " + backup.accountCount + " 个账号、" + backup.zoneCount + " 个区服、" + backup.characterCount + " 个角色。";
  const message = details + (replace ? "当前对应数据会被替换。" : "保留已有进度，补充缺少的账号、区服和角色。");
  openAction(replace ? "覆盖导入" : "合并导入", message, {
    confirmLabel: "确认导入", danger: replace,
  }, async () => {
    resetAtBoundary();
    const activeServer = state.activeServer;
    try {
      const result = replace ? null : Tracker.mergeBackup(state, backup);
      const imported = replace ? Tracker.replaceBackup(state, backup) : result.app;
      imported.activeServer = activeServer;
      const saved = await saveRestorable(replace ? "覆盖导入备份" : "合并导入备份", imported, replace);
      if (!saved) throw new Error("浏览器保存失败，请重试。");
      changeFilter("all");
      render();
      backupInput.value = "";
      const summary = result
        ? "新增 " + result.addedAccounts + " 个账号、" + result.addedZones + " 个区服、" + result.addedCharacters + " 个角色"
        : "备份已导入";
      backupMessage(summary);
    } catch (error) {
      backupMessage(error.message);
    }
  });
}

byId("replace-backup").addEventListener("click", () => importBackup(true));
byId("merge-backup").addEventListener("click", () => importBackup(false));

window.addEventListener("storage", (event) => {
  if (event.storageArea !== localStorage) return;
  if (event.key === FONT_KEY || event.key === null) restoreFontPreset();
  if (event.key !== STORAGE_KEY || event.newValue === null) return;
  const activeServer = state.activeServer;
  storageNotice = "已保存到此浏览器";
  state = readState();
  state.activeServer = activeServer;
  resetAtBoundary(false);
  render();
  deviceSync?.localChanged();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) updateDay();
});
window.addEventListener("focus", updateDay);
setInterval(updateDay, 30000);

restoreFontPreset();
resetAtBoundary();
if (needsMigration) saveState();
render();

deviceSync = window.JingheSync.mount({
  getSnapshot() {
    if (storageReadError) return null;
    const { dailyDate, dailyResetHour, servers } = Tracker.snapshotApp(state);
    return { dailyDate, dailyResetHour, servers };
  },
  applySnapshot(data) {
    const previous = state;
    state = Tracker.ensureDailyReset({ ...data, activeServer: previous.activeServer }, new Date()).state;
    if (!saveState(false)) {
      state = previous;
      return false;
    }
    render();
    return true;
  },
});

window.JingheRosterImport.mount({
  tracker: Tracker,
  getServer: currentServer,
  refreshDay: resetAtBoundary,
  async commit(server) {
    const saved = await saveRestorable("截图或名单导入", {
      ...state,
      servers: { ...state.servers, [server.serverId]: server },
    });
    if (!saved) return false;
    changeFilter("all");
    render();
    return true;
  },
  notice: showToast,
});
