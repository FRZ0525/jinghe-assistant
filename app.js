"use strict";

const Tracker = window.Tracker;
const STORAGE_KEY = "jinghe-assistant-v1";
const byId = (id) => document.getElementById(id);
const accountList = byId("account-list");
const actionDialog = byId("action-dialog");
const backupDialog = byId("backup-dialog");
const backupInput = byId("backup-input");
const compactLayout = window.matchMedia("(max-width: 760px)");

let storageNotice = "保存在此浏览器";
let state = readState();
const toolByServer = { regular: "raids", season: "raids" };
let activeFilter = "all";
let settingsExpanded = !compactLayout.matches;
let pendingAction = null;
let toastTimer = null;

state.activeServer = "regular";

function readState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? Tracker.normalizeAppState(JSON.parse(saved)) : Tracker.createAppState();
  } catch (error) {
    storageNotice = "无法读取浏览器存储";
    console.error("无法读取晶核助手的记录", error);
    return Tracker.createAppState();
  }
}

function renderStorageStatus() {
  const status = byId("storage-status");
  status.textContent = storageNotice;
  status.dataset.state = /无法|未保存/.test(storageNotice) ? "error" : "ready";
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  return toolByServer[state.activeServer];
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

function showToast(message) {
  const toast = byId("toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2700);
}

function summaryText(summary) {
  if (!summary.accountCount) return "暂无账号";
  if (!summary.characterCount) return "暂无角色";
  if (!summary.staminaPending && !summary.raidsPending) return "今日已完成";
  return "体力待刷 " + summary.staminaPending + " · 副本待打 " + summary.raidsPending;
}

function metric(label, value, detail) {
  return make("div", "metric",
    make("span", "metric-label", label),
    make("strong", "metric-value", String(value)),
    make("small", "metric-detail", detail)
  );
}

function renderMetrics() {
  const regular = Tracker.summarize(state.servers.regular);
  const season = Tracker.summarize(state.servers.season);
  const selected = state.activeServer === "regular" ? regular : season;
  byId("regular-summary").textContent = summaryText(regular);
  byId("season-summary").textContent = summaryText(season);
  byId("metrics").replaceChildren(
    metric("角色总数", selected.characterCount, selected.accountCount + " 个账号"),
    metric("体力待刷", selected.staminaPending, "已刷 " + selected.staminaDone + " 个角色"),
    metric("副本待打", selected.raidsPending, "今日已打 " + selected.raidsDoneToday + " 项")
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
  byId("restore-raids").hidden = !settingsExpanded;
}

byId("toggle-raid-settings").addEventListener("click", () => {
  settingsExpanded = !settingsExpanded;
  renderSettingsExpansion();
});
byId("jump-to-settings").addEventListener("click", (event) => {
  event.preventDefault();
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
  const definition = Tracker.getServerDef(server.serverId);
  const pair = definition.raidMode === "pair";
  byId("raid-settings").hidden = currentTool() !== "raids";
  byId("jump-to-settings").hidden = currentTool() !== "raids";
  renderSettingsExpansion();
  byId("raid-settings-note").textContent = pair
    ? "选择本期开放的两个轮换团本。"
    : "选择要记录的副本，至少保留一个。";
  byId("max-attempts").textContent = String(server.maxAttempts);
  byId("decrease-attempts").disabled = server.maxAttempts <= 1;
  byId("increase-attempts").disabled = server.maxAttempts >= 10;
  byId("restore-raids").disabled = !server.accounts.some((account) => account.characters.length);

  const controls = byId("raid-controls");
  if (pair) {
    controls.replaceChildren(make("div", "raid-selects", ...server.activeRaids.map((name, index) => {
      const select = make("select", "");
      select.dataset.slot = String(index);
      for (const raid of definition.raids) {
        const option = make("option", "", raid.name + (raid.detail ? " · " + raid.detail : ""));
        option.value = raid.name;
        select.append(option);
      }
      select.value = name;
      return make("label", "", make("span", "", "轮换位 " + (index + 1)), select);
    })));
  } else {
    controls.replaceChildren(make("div", "raid-pills", ...definition.raids.map((raid) => {
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
    control.setAttribute("aria-pressed", String(activeFilter === key));
    return control;
  }));
}

function accountButton(label, action, account, character) {
  const data = { action, account: account.id };
  if (character) data.character = character.id;
  return button(label, "button button--quiet", data);
}

function taskButton(label, className, data, done) {
  const control = button("", className, data);
  const check = make("span", "task-check", done ? "✓" : "");
  check.setAttribute("aria-hidden", "true");
  control.append(check, make("span", "", label));
  control.setAttribute("aria-pressed", String(done));
  return control;
}

function staminaButton(account, character, displayName) {
  const control = taskButton(displayName, "stamina-toggle", {
    action: "stamina", account: account.id, character: character.id,
  }, character.staminaDone);
  control.setAttribute("aria-label", character.name + " 体力已刷");
  return control;
}

function isPendingRaid(raid) {
  return !raid.doneToday && raid.remaining > 0;
}

function renderCharacter(account, character, maxAttempts) {
  const actions = make("div", "character-actions",
    staminaButton(account, character, "体力"),
    accountButton("改名", "rename-character", account, character),
    accountButton("删除", "delete-character", account, character)
  );
  const raids = activeFilter === "raid" ? character.raids.filter(isPendingRaid) : character.raids;
  const rows = raids.map((raid) => {
    const data = { account: account.id, character: character.id, raid: raid.name };
    const toggle = taskButton(raid.name, "raid-toggle", { ...data, action: "raid" }, raid.doneToday);
    toggle.disabled = !raid.doneToday && raid.remaining <= 0;
    toggle.setAttribute("aria-label", character.name + " " + raid.name + " 今日已打");

    const input = make("input", "");
    input.type = "number";
    input.inputMode = "numeric";
    input.min = "0";
    input.max = String(maxAttempts);
    input.step = "1";
    input.value = String(raid.remaining);
    input.setAttribute("aria-label", character.name + " " + raid.name + " 剩余次数");
    Object.assign(input.dataset, data, { field: "remaining" });

    return make("div", "raid-row", toggle,
      make("label", "remaining-field", input, make("span", "", "/ " + maxAttempts))
    );
  });
  return make("div", "character-card",
    make("div", "character-header", make("strong", "", character.name), actions),
    make("div", "raid-list", ...rows)
  );
}

function renderAccount(account, characters, maxAttempts) {
  const avatar = make("span", "account-avatar", Array.from(account.name.trim())[0] || "账");
  avatar.setAttribute("aria-hidden", "true");
  const done = account.characters.filter((character) => character.staminaDone).length;
  const progress = currentTool() === "stamina"
    ? "体力 " + done + "/" + account.characters.length
    : account.characters.length + " 个角色";
  const header = make("div", "account-header",
    avatar,
    make("div", "account-heading", make("strong", "", account.name), make("small", "", progress)),
    make("div", "account-actions",
      accountButton("＋ 添加角色", "add-character", account),
      accountButton("改名", "rename-account", account),
      accountButton("删除", "delete-account", account)
    )
  );
  if (!characters.length) {
    return make("article", "account-card", header, make("p", "account-note", "添加角色后即可记录进度。"));
  }
  if (currentTool() === "stamina") {
    const rows = characters.map((character) => make("div", "stamina-row",
      staminaButton(account, character, character.name),
      make("div", "character-actions",
        accountButton("改名", "rename-character", account, character),
        accountButton("删除", "delete-character", account, character)
      )
    ));
    return make("article", "account-card", header, make("div", "stamina-list", ...rows));
  }
  return make("article", "account-card", header,
    make("div", "character-list", ...characters.map((character) => renderCharacter(account, character, maxAttempts)))
  );
}

function renderAccounts() {
  const server = currentServer();
  const cards = [];
  for (const account of server.accounts) {
    const characters = account.characters.filter((character) => {
      if (activeFilter === "stamina") return !character.staminaDone;
      if (activeFilter === "raid") return character.raids.some(isPendingRaid);
      return true;
    });
    if (activeFilter === "all" || characters.length) {
      cards.push(renderAccount(account, characters, server.maxAttempts));
    }
  }
  if (!cards.length) {
    const title = server.accounts.length ? "没有符合筛选条件的角色" : "还没有账号";
    const hint = server.accounts.length
      ? "切换到「全部」可查看所有角色。"
      : "添加账号和角色后，就可以开始记录副本和体力。";
    cards.push(make("div", "empty-state", make("strong", "empty-title", title), make("p", "", hint)));
  }
  byId("reset-daily").disabled = !server.accounts.some((account) => account.characters.length);
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
  byId("workspace-subtitle").textContent = currentTool() === "raids"
    ? "北京时间 06:00 重置今日标记"
    : "北京时间 06:00 重置体力完成标记";
  renderStorageStatus();

  renderMetrics();
  renderSettings();
  renderFilters();
  renderAccounts();

  if (focused instanceof HTMLSelectElement && !focused.isConnected && focused.dataset.slot !== undefined) {
    const replacement = Array.from(byId("raid-controls").querySelectorAll("select"))
      .find((control) => control.dataset.slot === focused.dataset.slot);
    replacement?.focus({ preventScroll: true });
  }
  if (focused instanceof HTMLButtonElement && !focused.isConnected) {
    const data = Object.entries(focused.dataset);
    if (data.length) {
      const replacement = Array.from(document.querySelectorAll("button[data-action], button[data-filter]"))
        .find((control) => data.every(([key, value]) => control.dataset[key] === value));
      const currentFilter = byId("filters").querySelector("[aria-pressed=true]");
      const next = replacement && !replacement.disabled ? replacement : currentFilter;
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
  const confirmButton = byId("confirm-action");
  confirmButton.textContent = options.confirmLabel || "确定";
  confirmButton.className = "button " + (options.danger ? "button--danger" : "button--primary");
  actionDialog.showModal();
  if (!nameField.hidden) {
    input.focus();
    input.select();
  }
}

function openName(title, label, value, confirm) {
  openAction(title, "", { nameLabel: label, value, confirmLabel: "保存" }, confirm);
}

byId("cancel-action").addEventListener("click", () => actionDialog.close());
byId("action-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = byId("name-input");
  const name = input.value.trim();
  if (!input.disabled && !name) {
    input.focus();
    showToast("请输入名称");
    return;
  }
  const confirm = pendingAction;
  actionDialog.close();
  pendingAction = null;
  if (confirm) confirm(name);
});

function records(serverId, accountId, characterId, raidName) {
  const server = state.servers[serverId];
  const account = server.accounts.find((item) => item.id === accountId);
  const character = account?.characters.find((item) => item.id === characterId);
  const raid = character?.raids.find((item) => item.name === raidName);
  return { server, account, character, raid };
}

for (const control of document.querySelectorAll("[data-select-server]")) {
  control.addEventListener("click", () => {
    resetAtBoundary();
    state.activeServer = control.dataset.selectServer;
    activeFilter = "all";
    render();
  });
}

for (const control of document.querySelectorAll("[data-tool]")) {
  control.addEventListener("click", () => {
    resetAtBoundary();
    toolByServer[state.activeServer] = control.dataset.tool;
    activeFilter = "all";
    render();
  });
}

byId("filters").addEventListener("click", (event) => {
  const filter = event.target.closest("button[data-filter]");
  if (!filter) return;
  resetAtBoundary();
  activeFilter = filter.dataset.filter;
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
    activeFilter = "all";
    editRecord(() => state.servers[serverId].accounts.push(Tracker.createAccount(name)), "账号已添加");
  });
});

function characterTotal(server) {
  return server.accounts.reduce((sum, account) => sum + account.characters.length, 0);
}

accountList.addEventListener("click", (event) => {
  const control = event.target.closest("button[data-action]");
  if (!control) return;
  resetAtBoundary();
  const { action, account: accountId, character: characterId, raid: raidName } = control.dataset;
  const serverId = state.activeServer;
  const getRecords = () => records(serverId, accountId, characterId, raidName);
  const { server, account, character, raid } = getRecords();
  if (!account) return;

  switch (action) {
    case "stamina":
      if (character) editRecord(() => {
        const target = getRecords().character;
        if (target) target.staminaDone = !target.staminaDone;
      });
      break;
    case "raid":
      if (raid) editRecord(() => {
        const target = getRecords();
        if (target.raid?.doneToday) {
          target.raid.remaining = Math.min(target.server.maxAttempts, target.raid.remaining + 1);
          target.raid.doneToday = false;
        } else if (target.raid?.remaining > 0) {
          target.raid.remaining -= 1;
          target.raid.doneToday = true;
        }
      });
      break;
    case "add-character":
      if (characterTotal(server) >= Tracker.CHARACTER_LIMIT) {
        showToast("该服最多可保存 " + Tracker.CHARACTER_LIMIT + " 个角色");
        break;
      }
      openName("添加角色", "角色名称", "", (name) => {
        const target = getRecords();
        if (!target.account || characterTotal(target.server) >= Tracker.CHARACTER_LIMIT) {
          showToast("无法添加角色，请检查账号和角色数量");
          return;
        }
        activeFilter = "all";
        editRecord(() => {
          const current = getRecords();
          current.account?.characters.push(Tracker.createCharacter(name, current.server.activeRaids, current.server.maxAttempts));
        }, "角色已添加");
      });
      break;
    case "rename-account":
    case "rename-character": {
      const isCharacter = action === "rename-character";
      const item = isCharacter ? character : account;
      if (!item) break;
      const label = isCharacter ? "角色" : "账号";
      openName("修改" + label + "名称", label + "名称", item.name, (name) => {
        editRecord(() => {
          const current = getRecords();
          const target = isCharacter ? current.character : current.account;
          if (target) target.name = name;
        }, "名称已更新");
      });
      break;
    }
    case "delete-account":
      openAction("删除账号", "删除「" + account.name + "」及其所有角色？", {
        danger: true, confirmLabel: "删除账号",
      }, () => editRecord(() => {
        const current = state.servers[serverId];
        current.accounts = current.accounts.filter((item) => item.id !== accountId);
      }, "账号已删除"));
      break;
    case "delete-character":
      if (!character) break;
      openAction("删除角色", "删除「" + character.name + "」及其进度？", {
        danger: true, confirmLabel: "删除角色",
      }, () => editRecord(() => {
        const target = getRecords().account;
        if (target) target.characters = target.characters.filter((item) => item.id !== characterId);
      }, "角色已删除"));
      break;
  }
});

accountList.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-field='remaining']");
  if (!input) return;
  const reset = resetAtBoundary();
  const { account, character, raid } = input.dataset;
  const target = records(state.activeServer, account, character, raid);
  if (!target.raid) return;
  const candidate = input.valueAsNumber;
  if (Number.isFinite(candidate)) {
    target.raid.remaining = Math.max(0, Math.min(target.server.maxAttempts, Math.floor(candidate)));
    saveState();
  }
  input.value = String(target.raid.remaining);
  if (reset) {
    render();
    return;
  }
  const toggle = input.closest(".raid-row").querySelector(".raid-toggle");
  toggle.disabled = !target.raid.doneToday && target.raid.remaining <= 0;
  renderMetrics();
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
  const details = scope + "备份中有 " + backup.accountCount + " 个账号、" + backup.characterCount + " 个角色。";
  const message = details + (replace ? "当前对应数据会被替换。" : "保留已有进度，补充缺少的账号和角色。");
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
      activeFilter = "all";
      const saved = saveState();
      render();
      backupInput.value = "";
      const summary = result
        ? "新增 " + result.addedAccounts + " 个账号、" + result.addedCharacters + " 个角色"
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
render();
