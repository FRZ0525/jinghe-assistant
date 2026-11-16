"use strict";

const Tracker = window.Tracker;
const STORAGE_KEY = "jinghe-assistant-v2";
const LEGACY_STORAGE_KEY = "jinghe-assistant-v1";
const UI_KEY = "jinghe-assistant-ui-v1";
const byId = (id) => document.getElementById(id);
const accountList = byId("account-list");
const actionDialog = byId("action-dialog");
const backupDialog = byId("backup-dialog");
const batchDialog = byId("batch-dialog");
const raidCatalogDialog = byId("raid-catalog-dialog");
const backupInput = byId("backup-input");
const compactLayout = window.matchMedia("(max-width: 859px)");

let storageNotice = "保存在此浏览器";
let needsMigration = false;
let storageReadError = false;
let state = readState(true);
const preferences = readPreferences();
let settingsExpanded = !compactLayout.matches;
let pendingAction = null;
let toastTimer = null;
let pendingUndo = null;
let batchContext = null;

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
        raids: ["stamina", "raid"].includes(filters?.raids) ? filters.raids : "all",
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

function saveState() {
  try {
    if (storageReadError) return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    needsMigration = false;
    storageNotice = "已保存到此浏览器";
    renderStorageStatus();
    return true;
  } catch (error) {
    storageNotice = "未保存 · 请导出备份";
    renderStorageStatus();
    console.error("无法保存晶核助手的记录", error);
    return false;
  }
}

function resetAtBoundary() {
  const now = new Date();
  if (state.dailyDate === Tracker.dailyCycleKey(now) && state.dailyResetHour === Tracker.DAILY_RESET_HOUR) {
    return false;
  }
  const result = Tracker.ensureDailyReset(state, now);
  state = result.state;
  saveState();
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
    for (const { ref, before, after } of changes) {
      const entry = records(ref);
      const target = ref.raid ? entry.raid : entry.character;
      if (!target || !Object.entries(after).every(([field, value]) => target[field] === value)) continue;
      if (before.remaining > entry.server.maxAttempts) continue;
      Object.assign(target, before);
      restored += 1;
    }
    if (restored) {
      const undoSaved = saveState();
      render();
      showToast(undoSaved ? "已撤销 " + restored + " 个角色的记录" : "已撤销，请导出备份");
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

function metric(label, value, detail, action) {
  const fields = [
    make("span", "metric-label", label),
    make("strong", "metric-value", String(value)),
    make("small", "metric-detail", detail),
  ];
  const tool = action === "stamina" ? "stamina" : "raids";
  const control = button("", "metric metric--link", { metric: action });
  const arrow = make("span", "metric-arrow", "↗");
  arrow.setAttribute("aria-hidden", "true");
  control.append(...fields, arrow);
  control.setAttribute("aria-pressed", String(currentTool() === tool));
  control.dataset.cleared = String(value === 0);
  control.setAttribute("aria-label", label + " " + value + "，查看待办");
  return control;
}

byId("metrics").addEventListener("click", (event) => {
  const control = event.target.closest("button[data-metric]");
  if (!control) return;
  const filter = control.dataset.metric;
  resetAtBoundary();
  changeTool(filter === "raid" ? "raids" : "stamina");
  changeFilter(filter);
  render();
  const title = byId("accounts-title");
  title.focus({ preventScroll: true });
  title.scrollIntoView({ block: "start" });
});

function renderMetrics() {
  const regular = Tracker.summarize(state.servers.regular);
  const season = Tracker.summarize(state.servers.season);
  const selected = state.activeServer === "regular" ? regular : season;
  byId("regular-summary").textContent = summaryText(regular);
  byId("season-summary").textContent = summaryText(season);
  byId("roster-meta").textContent = selected.accountCount + " 个账号 · " + selected.zoneCount + " 个区服 · " + selected.characterCount + " 个角色";
  byId("metrics").replaceChildren(
    metric("体力待刷", selected.staminaPending, "已刷 " + selected.staminaDone + " 个角色", "stamina"),
    metric("副本待打", selected.raidsPending, "今日已打 " + selected.raidsDoneToday + " 项", "raid")
  );
  const overview = byId("raid-overview");
  overview.hidden = !selected.characterCount;
  overview.replaceChildren(...selected.raids.map((raid) => (
    make("div", "raid-summary",
      make("strong", "", raid.name),
      make("small", "", "剩余 " + raid.remaining + " 次 · 今日已打 " + raid.doneToday)
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
  settingsExpanded = true;
  renderSettingsExpansion();
  byId("toggle-raid-settings").focus({ preventScroll: true });
  byId("raid-settings").scrollIntoView({ block: "start" });
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
  byId("restore-raids").disabled = !characterTotal(server);

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
  const options = currentTool() === "raids"
    ? [["all", "全部"], ["stamina", "体力待刷"], ["raid", "副本待打"]]
    : [["all", "全部"], ["stamina", "体力待刷"]];
  byId("filters").hidden = !currentServer().accounts.length;
  byId("filters").replaceChildren(...options.map(([key, label]) => {
    const control = button(label, "filter-button", { filter: key });
    control.setAttribute("aria-pressed", String(currentFilter() === key));
    return control;
  }));
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
  return make("span", "character-identity",
    make("span", "entry-kind entry-kind--character", "角色"),
    make("strong", "character-name", character.name)
  );
}

function isPendingRaid(raid) {
  return !raid.doneToday && raid.remaining > 0;
}

function characterActions(account, zone, character) {
  const actions = [
    entryButton("改名", "rename-character", account, zone, character),
  ];
  if (account.zones.length > 1) {
    actions.push(entryButton("移动区服", "move-character", account, zone, character));
  }
  actions.push(entryButton("删除", "delete-character", account, zone, character));
  const menu = entryMenu(account, zone, character, ...actions);
  return currentTool() === "stamina"
    ? make("div", "character-actions", menu)
    : make("div", "character-actions", staminaButton(account, zone, character, "体力"), menu);
}

function renderRaid(account, zone, character, raid, maxAttempts) {
  const data = { ...entryData(account, zone, character), raid: raid.name };
  const label = entryName(account, zone, character) + " " + raid.name;
  const toggle = taskButton(raid.name, "raid-toggle", { ...data, action: "raid" }, raid.doneToday);
  toggle.disabled = !raid.doneToday && raid.remaining <= 0;
  toggle.setAttribute("aria-label", label + " 今日已打");

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

  return make("div", "raid-row", toggle,
    make("div", "remaining-field", minus, input, plus, make("span", "", "/ " + maxAttempts))
  );
}

function renderCharacter(account, zone, character, maxAttempts) {
  const actions = characterActions(account, zone, character);
  if (currentTool() === "stamina") {
    return make("div", "stamina-row", staminaButton(account, zone, character, characterIdentity(character)), actions);
  }
  const raids = currentFilter() === "raid" ? character.raids.filter(isPendingRaid) : character.raids;
  return make("div", "character-card",
    make("div", "character-header", characterIdentity(character), actions),
    make("div", "raid-list", ...raids.map((raid) => renderRaid(account, zone, character, raid, maxAttempts)))
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
  const stamina = characters.filter((character) => !character.staminaDone).length;
  const raids = characters.reduce((sum, character) => sum + character.raids.filter(isPendingRaid).length, 0);
  return "体力待刷 " + stamina + " · 副本待打 " + raids;
}

function renderAccount(account, zones, maxAttempts, index) {
  const collapsed = preferences[state.activeServer].collapsed.includes(account.id);
  const heading = button("", "account-heading account-fold", { ...entryData(account), action: "toggle-account" });
  const contentId = "account-content-" + index;
  const indicator = make("span", "fold-indicator");
  indicator.setAttribute("aria-hidden", "true");
  heading.append(
    indicator,
    make("span", "account-name-line",
      make("span", "entry-kind entry-kind--account", "账号"),
      make("strong", "account-name", account.name)
    ),
    make("small", "", accountProgress(account, collapsed))
  );
  heading.setAttribute("aria-expanded", String(!collapsed));
  heading.setAttribute("aria-controls", contentId);
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
  const card = make("article", "account-card", header, content);
  card.setAttribute("aria-label", "账号 " + account.name);
  return card;
}

function renderAccounts() {
  const server = currentServer();
  const filter = currentFilter();
  const cards = [];
  for (const account of server.accounts) {
    const zones = account.zones.map((zone) => ({
      zone,
      characters: zone.characters.filter((character) => {
        if (filter === "stamina") return !character.staminaDone;
        if (filter === "raid") return character.raids.some(isPendingRaid);
        return true;
      }),
    })).filter(({ characters }) => filter === "all" || characters.length);
    if (filter === "all" || zones.length) {
      cards.push(renderAccount(account, zones, server.maxAttempts, cards.length));
    }
  }
  if (!cards.length) {
    const title = server.accounts.length ? "没有符合筛选条件的角色" : "还没有账号";
    const hint = server.accounts.length
      ? "切换到「全部」可查看所有角色。"
      : "添加账号后，按区服管理角色、副本和体力。";
    cards.push(make("div", "empty-state", make("strong", "empty-title", title), make("p", "", hint)));
  }
  byId("reset-daily").disabled = !characterTotal(server);
  accountList.replaceChildren(...cards);
}

function render() {
  const focused = document.activeElement;
  document.body.dataset.server = state.activeServer;
  for (const control of document.querySelectorAll("[data-tool]")) {
    control.setAttribute("aria-pressed", String(control.dataset.tool === currentTool()));
  }
  for (const control of document.querySelectorAll("[data-select-server]")) {
    control.setAttribute("aria-pressed", String(control.dataset.selectServer === state.activeServer));
  }
  const serverLabel = Tracker.getServerDef(state.activeServer).label;
  byId("workspace-title").textContent = serverLabel;
  byId("tool-nav").setAttribute("aria-label", serverLabel + "记录工具");
  byId("workspace-subtitle").textContent = "北京时间 06:00 重置今日标记，剩余次数不会自动恢复";
  renderStorageStatus();

  renderMetrics();
  renderSettings();
  renderFilters();
  renderAccounts();
  if (raidCatalogDialog.open) renderRaidCatalog();

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
      const currentFilter = byId("filters").querySelector("[aria-pressed=true]");
      const next = replacement && !replacement.matches(":disabled") ? replacement : currentFilter;
      next?.focus({ preventScroll: true });
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
    resetAtBoundary();
    state.activeServer = control.dataset.selectServer;
    render();
  });
}

for (const control of document.querySelectorAll("[data-tool]")) {
  control.addEventListener("click", () => {
    resetAtBoundary();
    changeTool(control.dataset.tool);
    render();
  });
}

byId("filters").addEventListener("click", (event) => {
  const filter = event.target.closest("button[data-filter]");
  if (!filter) return;
  resetAtBoundary();
  changeFilter(filter.dataset.filter);
  render();
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

byId("restore-raids").addEventListener("click", () => {
  const serverId = state.activeServer;
  const label = Tracker.getServerDef(serverId).label;
  openAction("恢复副本次数", "将" + label + "的副本剩余次数补到当前上限，并清除今日已打标记。",
    { confirmLabel: "恢复次数" }, () => {
      editRecord(() => { state.servers[serverId] = Tracker.resetRaidCycle(state.servers[serverId]); }, "副本次数已恢复");
    });
});

byId("reset-daily").addEventListener("click", () => {
  const serverId = state.activeServer;
  const label = Tracker.getServerDef(serverId).label;
  openAction("重置今日进度", "清除" + label + "的体力完成和今日已打标记，保留副本剩余次数。",
    { confirmLabel: "重置进度" }, () => {
      editRecord(() => { state.servers[serverId] = Tracker.resetDailyProgress(state.servers[serverId]); }, "今日进度已重置");
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
    editRecord(() => state.servers[serverId].accounts.push(Tracker.createAccount(name)), "账号已添加");
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

function toggleCompletion(ref, record) {
  const { server, character, raid } = record;
  if (ref.raid) {
    if (!raid || (!raid.doneToday && raid.remaining <= 0)) return;
    const doneToday = !raid.doneToday;
    const remaining = doneToday ? raid.remaining - 1 : Math.min(server.maxAttempts, raid.remaining + 1);
    const change = applyRecordChange(ref, raid, { doneToday, remaining });
    recordCompletion([change], doneToday ? "已记录副本完成" : "已取消副本完成标记");
  } else if (character) {
    const staminaDone = !character.staminaDone;
    const change = applyRecordChange(ref, character, { staminaDone });
    recordCompletion([change], staminaDone ? "已记录体力完成" : "已取消体力完成标记");
  }
}

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
  resetAtBoundary();
  const ref = { ...control.dataset, server: state.activeServer };
  const record = records(ref);
  if (!record.account) return;

  switch (ref.action) {
    case "stamina":
    case "raid":
      toggleCompletion(ref, record);
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
          raid.remaining = clampRemaining(raid.remaining + delta, server.maxAttempts);
        }
      });
      break;
    case "toggle-account":
      setCollapsed(ref.account, control.getAttribute("aria-expanded") === "true");
      render();
      break;
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
  const { raid, server } = records({ ...input.dataset, server: state.activeServer });
  if (!raid) return;
  if (Number.isFinite(input.valueAsNumber)) {
    raid.remaining = clampRemaining(input.valueAsNumber, server.maxAttempts);
    saveState();
  }
  input.value = String(raid.remaining);
  if (reset) {
    render();
    return;
  }
  const row = input.closest(".raid-row");
  row.querySelector(".raid-toggle").disabled = !raid.doneToday && raid.remaining <= 0;
  row.querySelector("[data-action='remaining-minus']").disabled = raid.remaining <= 0;
  row.querySelector("[data-action='remaining-plus']").disabled = raid.remaining >= server.maxAttempts;
  renderMetrics();
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
  const select = byId("batch-kind");
  setChoices(select, [["stamina", "每日体力"], ...server.activeRaids.map((name) => ["raid:" + name, name])]);
  if (currentTool() === "raids" && server.activeRaids.length) select.value = "raid:" + server.activeRaids[0];
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

function updateBatchSelection() {
  const inputs = batchInputs();
  const count = inputs.filter((input) => input.checked).length;
  const selectAll = byId("batch-select-all");
  selectAll.disabled = !inputs.length;
  selectAll.textContent = inputs.length && count === inputs.length ? "取消全选" : "全选";
  byId("batch-selection").textContent = "已选 " + count + " 个角色";
  const confirm = byId("batch-confirm");
  confirm.disabled = !count;
  confirm.textContent = "完成 " + count + " 个角色";
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
      if (raidName ? !raid || !isPendingRaid(raid) : character.staminaDone) continue;
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
  const select = inputs.some((input) => !input.checked);
  for (const input of inputs) input.checked = select;
  updateBatchSelection();
});
byId("close-batch").addEventListener("click", () => batchDialog.close());
batchDialog.addEventListener("close", () => { batchContext = null; });

byId("batch-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!batchContext) return;
  resetAtBoundary();
  const raidName = selectedBatchRaid();
  const changes = [];
  for (const input of batchInputs()) {
    if (!input.checked) continue;
    const ref = { ...batchContext, ...input.dataset, raid: raidName };
    const target = records(ref);
    if (raidName && target.raid && isPendingRaid(target.raid)) {
      changes.push(applyRecordChange(ref, target.raid, { remaining: target.raid.remaining - 1, doneToday: true }));
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
byId("download-backup").addEventListener("click", () => {
  const blob = new Blob([backupText()], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = make("a", "");
  link.href = url;
  link.download = "晶核助手-" + Tracker.dailyCycleKey(new Date()) + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  backupMessage("备份文件已生成");
});
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
  }, () => {
    resetAtBoundary();
    const activeServer = state.activeServer;
    try {
      const result = replace ? null : Tracker.mergeBackup(state, backup);
      const imported = replace ? Tracker.replaceBackup(state, backup) : result.app;
      imported.activeServer = activeServer;
      state = imported;
      if (replace) storageReadError = false;
      changeFilter("all");
      const saved = saveState();
      render();
      backupInput.value = "";
      const summary = result
        ? "新增 " + result.addedAccounts + " 个账号、" + result.addedZones + " 个区服、" + result.addedCharacters + " 个角色"
        : "备份已导入";
      backupMessage(saved ? summary : summary + "，浏览器保存失败，请导出备份。");
    } catch (error) {
      backupMessage(error.message);
    }
  });
}

byId("replace-backup").addEventListener("click", () => importBackup(true));
byId("merge-backup").addEventListener("click", () => importBackup(false));

window.addEventListener("storage", (event) => {
  if (event.storageArea !== localStorage || (event.key !== STORAGE_KEY && event.key !== null)) return;
  const activeServer = state.activeServer;
  storageNotice = "已保存到此浏览器";
  state = readState();
  state.activeServer = activeServer;
  resetAtBoundary();
  render();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) updateDay();
});
window.addEventListener("focus", updateDay);
setInterval(updateDay, 30000);

resetAtBoundary();
if (needsMigration) saveState();
render();
