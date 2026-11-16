(function (root) {
  "use strict";

  const ignored = new Set(["账号", "添加账号", "删除账号", "服务器列表", "我的服务器",
    "上次登录", "已有角色", "角色列表", "角色名", "角色名称", "角色信息", "进入游戏", "统计", "排序",
    "团本", "团本总奖励次数", "挑战统计", "总计", "已达上限", "未达上限"]);

  function cleanLine(value) {
    return value.trim().replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "$1")
      .replace(/^[◆◇♦◈●•*#\s]+/u, "")
      .trim();
  }

  function lines(text) {
    return String(text || "").split(/\r\n|\n|\r/);
  }

  function key(name) {
    return name.trim().toLocaleLowerCase();
  }

  function cleanName(value) {
    return cleanLine(value).replace(/^[：:|｜\-—\s]+|[|｜\-—\s]+$/g, "").trim();
  }

  function candidate(name) {
    return name.length > 0 && name.length <= 40 && !ignored.has(name) && /[\p{L}\p{N}]/u.test(name);
  }

  function unique(values) {
    const seen = new Set();
    return values.filter((name) => {
      const normalized = key(name);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  function maskedAccounts(text) {
    const normalized = lines(text).map((line) => line.normalize("NFKC").replace(/\s/g, "")).join("\n");
    const matches = normalized.matchAll(/(?<!\d)(1\d{2})[*✱✳×xX·•]{3,9}(\d{2})(?!\d)/gu);
    const accounts = [...matches].map((match) => match[1] + "******" + match[2]);
    for (const line of lines(text)) {
      const named = line.match(/^\s*(?:登录|游戏)?账号\s*[:：]\s*(.+)$/u);
      if (!named) continue;
      const value = named[1].split(/(?:密码|验证码|登录时间|最近登录)\s*[:：]/u)[0].trim();
      if (candidate(value) && !/\d{7,}|[*✱✳×·•]/u.test(value)) accounts.push(value);
    }
    return unique(accounts);
  }

  function serverCards(text) {
    const rows = [];
    let pending = "";
    for (const raw of lines(text)) {
      const line = cleanLine(raw.trim().replace(/^令\s+/u, "")).normalize("NFKC");
      if (!line || ignored.has(line)) continue;
      const found = line.match(/([\p{Script=Han}·]{1,22}\s*[0-9OoIl]{1,3}\s*[服区]|[\p{Script=Han}·]{1,20}[一二三四五六七八九十]+区)\s*$/u);
      if (found) {
        const zone = found[1].replace(/\s/g, "").replace(/([0-9OoIl]+)(?=[服区])/u, (digits) => (
          digits.replace(/[Oo]/g, "0").replace(/[Il]/g, "1")
        )).replace(/\s/g, "");
        const character = cleanName(line.slice(0, found.index)) || pending;
        if (candidate(character)) rows.push({ zone, character });
        pending = "";
      } else if (candidate(line)) {
        pending = line;
      }
    }
    return rows;
  }

  function zoneLine(row) {
    return row.zone ? " | " + row.zone + " | " + row.character : row.character;
  }

  function serializeRole(row, prefix) {
    return (prefix || zoneLine(row)) + (row.level ? " | 等级:" + row.level : "")
      + (row.power ? " | 战力:" + row.power : "");
  }

  function readDraftLine(text) {
    const base = text.replace(/\s*[|｜]\s*(?:等级|战力)\s*[:：].*$/u, "");
    const columns = base.includes("|") || base.includes("｜")
      ? base.split(/[|｜]/u)
      : base.split(/\t| +[/／] +/u);
    const character = columns[columns.length - 1].trim();
    const zone = columns.length === 3 ? columns[1].trim() : "";
    const level = text.match(/[|｜]\s*等级\s*[:：]\s*([^|｜]+)/u)?.[1]?.trim();
    const power = text.match(/[|｜]\s*战力\s*[:：]\s*([^|｜]+)/u)?.[1]?.trim();
    return { base, character, zone, level, power };
  }

  function conflicts(left, right, field) {
    return left[field] != null && right[field] != null
      && String(left[field]).trim() !== String(right[field]).trim();
  }

  function combineRoleRows(rows) {
    const merged = new Map();
    for (const row of rows) {
      const id = JSON.stringify([row.account, row.zone, row.character].map(key));
      const previous = merged.get(id);
      if (previous) {
        for (const [field, label] of [["level", "等级"], ["power", "战力"]]) {
          if (conflicts(previous, row, field)) {
            throw new Error(row.character + " 的" + label + "有两个候选值（" + previous[field] + "、" + row[field] + "），请核对后保留一项。");
          }
        }
        merged.set(id, { ...previous, ...row });
      } else {
        merged.set(id, row);
      }
    }
    return [...merged.values()];
  }

  function appendRoles(text, incoming) {
    const draft = lines(text).filter((line) => line.trim());
    for (const row of incoming) {
      const matches = draft.map((line, index) => ({ ...readDraftLine(line), index }))
        .filter((item) => key(item.character) === key(row.character)
          && (!item.zone || !row.zone || key(item.zone) === key(row.zone)));
      if (matches.length === 1) {
        const [old] = matches;
        const base = !old.zone && row.zone ? zoneLine(row) : old.base;
        if (conflicts(old, row, "level") || conflicts(old, row, "power")) {
          const different = serializeRole(row, base);
          if (!draft.includes(different)) draft.push(different);
        } else {
          draft[old.index] = serializeRole({
            character: row.character, level: row.level || old.level, power: row.power || old.power,
          }, base);
        }
      } else {
        const addition = serializeRole(row);
        if (!draft.includes(addition)) draft.push(addition);
      }
    }
    return draft.join("\n");
  }

  async function readScreenshot(file, selectedKind, progress, catalog) {
    if (selectedKind === "roles") {
      return { roles: await root.JingheRosterLayout.readRoles(file, progress) };
    }
    if (selectedKind === "raids") {
      return root.JingheRosterLayout.readChallenges(file, progress, { catalog });
    }
    const regions = selectedKind === "account" ? [
      { x: 0.395, y: 0.278, width: 0.245, height: 0.32, psm: 6 },
    ] : [
      { x: 0.312, y: 0.235, width: 0.255, height: 0.72, psm: 6 },
      { x: 0.658, y: 0.235, width: 0.254, height: 0.72, psm: 6 },
    ];
    const scanned = await root.JingheOCR.recognize(file, progress, { regions });
    const extract = selectedKind === "account" ? maskedAccounts : serverCards;
    const values = scanned.flatMap((item) => extract(item.text));
    const result = values.length ? values : extract(await root.JingheOCR.recognize(file, progress, { psm: 11 }));
    return selectedKind === "account" ? { accounts: unique(result) } : { roles: result };
  }


  function mount(services) {
    const { tracker, getServer, refreshDay, commit, notice } = services;
    const get = (id) => document.getElementById(id);
    const dialog = get("roster-import-dialog");
    const form = get("roster-import-form");
    const account = get("roster-account");
    const zone = get("roster-zone");
    const accountText = get("roster-accounts-text");
    const roleText = get("roster-text");
    const raidText = get("roster-raid-text");
    const countText = get("roster-count-text");
    const countBasis = get("roster-count-basis");
    const status = get("roster-status");
    const preview = get("roster-preview");
    const apply = get("apply-roster");
    const chooser = get("roster-screenshot");
    const kind = get("roster-image-kind");
    const recognize = get("recognize-roster");
    let busy = false;
    let session = 0;

    function message(text) {
      status.textContent = text;
      status.hidden = !text;
    }

    function invalidate() {
      preview.hidden = true;
      apply.disabled = true;
    }

    function replaceOptions(id, names) {
      get(id).replaceChildren(...unique(names).map((name) => {
        const option = document.createElement("option");
        option.value = name;
        return option;
      }));
    }

    function refreshTargets(fillZone) {
      const server = getServer();
      replaceOptions("roster-account-options", server.accounts.map((item) => item.name).concat(lines(accountText.value)));
      const selected = server.accounts.filter((item) => key(item.name) === key(account.value));
      const zones = selected.length === 1 ? selected[0].zones.map((item) => item.name) : [];
      replaceOptions("roster-zone-options", zones);
      if (fillZone && !zone.value.trim() && zones.length === 1) zone.value = zones[0];
    }

    function plan() {
      const base = getServer();
      const targets = { account: account.value.trim(), zone: zone.value.trim() };
      const roles = roleText.value.trim() ? combineRoleRows(tracker.parseRosterText(roleText.value, targets)) : [];
      const accountNames = unique(lines(accountText.value).map((name) => name.trim()));
      const raids = unique(lines(raidText.value).map((name) => name.trim()));
      const counts = countText.value.trim() ? tracker.parseRaidCountText(countText.value, targets) : [];
      if (counts.length && !countBasis.value) throw new Error("请选择截图里的团本读数是剩余次数还是已用次数。");
      if (accountNames.some((name) => name.length > 40) || raids.some((name) => name.length > 40)) {
        throw new Error("账号及团本名称请控制在 40 字以内。");
      }
      if (!roles.length && !accountNames.length && !raids.length && !counts.length) throw new Error("请先填写要录入的名单或团本次数。");

      const result = tracker.importRoster(base, roles);
      let server = result.server;
      const newAccounts = [];
      for (const name of accountNames) {
        if (server.accounts.some((item) => key(item.name) === key(name))) continue;
        if (server.accounts.length >= tracker.ACCOUNT_LIMIT) throw new Error("该服的账号数量已到上限。");
        server.accounts.push(tracker.createAccount(name));
        newAccounts.push(name);
        result.addedAccounts += 1;
        result.addedZones += 1;
      }
      const original = new Set(tracker.getRaidCatalog(base).map((raid) => key(raid.name)));
      const existing = new Set(original);
      for (const name of raids) {
        if (existing.has(key(name))) continue;
        const added = tracker.addRaid(server, name);
        if (!added.changed) throw new Error(added.message);
        server = added.server;
        existing.add(key(name));
      }
      let updatedRaids = 0;
      let enabledRaids = [];
      if (counts.length) {
        const targetAccount = server.accounts.find((item) => key(item.name) === key(targets.account));
        const hasUnassignedRows = lines(countText.value)
          .some((line) => line.trim() && line.split(line.includes("\t") ? "\t" : /[|｜]/u).length === 3);
        if (hasUnassignedRows && !targets.zone && targetAccount?.zones.length > 1) {
          throw new Error("这个账号有多个区服。请为团本次数选择区服，或逐行注明归属。");
        }
        const imported = tracker.importRaidCounts(server, counts, countBasis.value);
        server = imported.server;
        updatedRaids = imported.updatedRaids;
        enabledRaids = imported.enabledRaids;
      }
      const newRaids = tracker.getRaidCatalog(server).map((entry) => entry.name).filter((name) => !original.has(key(name)));
      return { ...result, server, roles, counts, basis: countBasis.value, newAccounts, newRaids, updatedRaids, enabledRaids };
    }


    function summary(result) {
      const items = [];
      if (result.addedAccounts) items.push("新增账号 " + result.addedAccounts);
      if (result.addedZones) items.push("新增区服 " + result.addedZones);
      if (result.addedCharacters) items.push("新增角色 " + result.addedCharacters);
      if (result.updatedCharacters) items.push("更新角色资料 " + result.updatedCharacters);
      if (result.newRaids.length) items.push("新增团本 " + result.newRaids.length);
      if (result.enabledRaids.length) items.push("启用团本 " + result.enabledRaids.length);
      if (result.updatedRaids) items.push("更新次数 " + result.updatedRaids);
      if (result.skippedCharacters) items.push("略过已存在角色 " + result.skippedCharacters);
      return items.join(" · ") || "名单中没有新的记录";
    }

    function changed(result) {
      return result.addedAccounts || result.addedZones || result.addedCharacters ||
        result.updatedCharacters || result.newRaids.length || result.enabledRaids.length || result.updatedRaids;
    }

    function profileText(row) {
      return [row.level && "等级 " + row.level, row.power && "战力 " + row.power].filter(Boolean).join(" · ");
    }

    function review(result) {
      const heading = document.createElement("strong");
      heading.textContent = summary(result);
      const list = document.createElement("ul");
      const rows = [
        ...result.newAccounts.map((name) => "账号 · " + name),
        ...result.roles.map((role) => {
          const profile = profileText(role);
          const text = [role.account, role.zone, role.character].join(" / ");
          return profile ? text + " · " + profile : text;
        }),
        ...result.newRaids.map((name) => "团本 · " + name),
        ...result.counts.map((row) => {
          const remaining = result.basis === "used" ? row.denominator - row.numerator : row.numerator;
          return [row.account, row.zone, row.character, row.raid].join(" / ")
            + " · 原读数 " + row.reading + " → 剩余 " + remaining + "/" + row.denominator;
        }),
        ...result.enabledRaids.map((name) => "启用 · " + name),
      ];
      for (const text of rows) {
        const row = document.createElement("li");
        row.textContent = text;
        list.append(row);
      }
      preview.replaceChildren(heading, list);
      preview.hidden = false;
      apply.disabled = busy || !changed(result);
    }

    get("open-roster-import").addEventListener("click", () => {
      refreshDay();
      session += 1;
      const server = getServer();
      const label = tracker.getServerDef(server.serverId).label;
      get("roster-scope").textContent = "导入到" + label + "。已有同名角色保留记录，可补充等级和战力。";
      account.value = server.accounts.length === 1 ? server.accounts[0].name : "";
      zone.value = "";
      accountText.value = "";
      roleText.value = "";
      raidText.value = "";
      countText.value = "";
      countBasis.value = "";
      chooser.value = "";
      kind.value = "roles";
      refreshTargets(true);
      invalidate();
      message("");
      recognize.disabled = busy;
      dialog.showModal();
    });
    get("close-roster-import").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { session += 1; });
    form.addEventListener("input", (event) => {
      if (event.target === account || event.target === accountText) refreshTargets(event.target === account);
      if (event.target === account || event.target === zone || event.target === accountText ||
          event.target === roleText || event.target === raidText || event.target === countText || event.target === countBasis) invalidate();
    });

    countBasis.addEventListener("change", invalidate);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      try {
        refreshDay();
        review(plan());
        message("请核对识别出的账号、区服、角色和团本。");
        preview.focus();
      } catch (error) {
        invalidate();
        message(error.message);
      }
    });

    apply.addEventListener("click", () => {
      if (apply.disabled || busy) return;
      try {
        refreshDay();
        const result = plan();
        if (changed(result)) {
          const saved = commit(result.server);
          dialog.close();
          notice(saved ? "已导入。 " + summary(result) : "已导入，请导出备份保留改动。");
        } else {
          review(result);
          message("名单中没有可新增或更新的记录。");
        }
      } catch (error) {
        invalidate();
        message(error.message);
      }
    });

    recognize.addEventListener("click", async () => {
      if (busy) return;
      const files = Array.from(chooser.files);
      if (!files.length) {
        message("请先选择截图。");
        return;
      }
      busy = true;
      recognize.disabled = true;
      chooser.disabled = true;
      kind.disabled = true;
      get("preview-roster").disabled = true;
      invalidate();
      const run = session;
      const selectedKind = kind.value;
      let found = 0;
      let failed = 0;
      try {
        for (const [index, file] of files.entries()) {
          if (!dialog.open || run !== session) break;
          const progress = (fraction) => {
            if (dialog.open && run === session) {
              message("识别第 " + (index + 1) + "/" + files.length + " 张 · " + Math.round(fraction * 100) + "%");
            }
          };
          progress(0);
          try {
            const result = await readScreenshot(file, selectedKind, progress, tracker.getRaidCatalog(getServer()));
            if (!dialog.open || run !== session) break;
            if (result.accounts?.length) {
              accountText.value = unique(lines(accountText.value).concat(result.accounts)).join("\n");
              if (!account.value && result.accounts.length === 1) account.value = result.accounts[0];
              refreshTargets(true);
              found += result.accounts.length;
            }
            if (result.roles?.length) {
              roleText.value = appendRoles(roleText.value, result.roles);
              found += result.roles.length;
            }
            if (result.names?.length) {
              raidText.value = unique(lines(raidText.value).concat(result.names)).join("\n");
              found += result.names.length;
            }
            if (result.counts?.length) {
              const rows = result.counts.map((row) => [row.character, row.raid, row.reading].join(" | "));
              countText.value = unique(lines(countText.value).concat(rows)).join("\n");
              found += result.counts.length;
            }
          } catch (error) {
            failed += 1;
            console.warn("截图识别失败", error);
          }
        }
        if (dialog.open && run === session) {
          const failure = failed ? "有 " + failed + " 张未能识别。" : "";
          message(found ? "已加入 " + found + " 条候选，请核对后预览。" + failure
            : "没有识别出可录入的信息。可以换一张更清晰的截图，或直接粘贴名单。" + failure);
        }
      } finally {
        busy = false;
        recognize.disabled = false;
        chooser.disabled = false;
        kind.disabled = false;
        get("preview-roster").disabled = false;
        if (run === session) chooser.value = "";
      }
    });
  }

  root.JingheRosterImport = { mount };
})(window);
