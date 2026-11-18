(function (root) {
  "use strict";

  const ignored = new Set(["账号", "添加账号", "删除账号", "服务器列表", "我的服务器",
    "上次登录", "已有角色", "角色列表", "角色名", "角色名称", "角色信息", "进入游戏", "统计", "排序",
    "团本", "团本总奖励次数", "挑战统计", "总计", "已达上限", "未达上限"]);
  const TARGETS_KEY = "jinghe-assistant-roster-targets-v1";
  const CONFIDENT_NAME_SCORE = 78;
  const rowTypes = {
    account: { label: "新增账号", fields: [["name", "账号"]] },
    role: { label: "角色资料", fields: [["character", "角色"], ["level", "等级"], ["power", "战力"], ["zone", "区服"]] },
    raid: { label: "团本目录", fields: [["raid", "团本"]] },
    count: { label: "角色团本次数", fields: [["character", "角色"], ["raid", "团本"], ["reading", "次数"]] },
    quota: { label: "账号团本额度", fields: [["raid", "团本"], ["reading", "额度"]] },
  };

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
    return String(name ?? "").trim().toLocaleLowerCase();
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

  function screenshotAccounts(text) {
    const accounts = [];
    for (const raw of lines(text)) {
      const line = cleanName(raw.normalize("NFKC"));
      const compact = line.replace(/\s/g, "");
      for (const match of compact.matchAll(/(?<!\d)(1\d{2})[*✱✳×xX·•]{3,9}(\d{2})(?!\d)/gu)) {
        accounts.push(match[1] + "******" + match[2]);
      }
      const named = raw.match(/^\s*(?:登录|游戏)?账号\s*[:：]\s*(.+)$/u);
      const value = (named?.[1] ?? line).split(/(?:密码|验证码|登录时间|最近登录)\s*[:：]/u)[0].trim();
      const numberedUser = value.normalize("NFKC").replace(/\s/g, "");
      if (/^用户\d{7,20}$/u.test(numberedUser)) accounts.push(numberedUser);
      else if (named && candidate(value) && !/\d{7,}|[*✱✳×·•]/u.test(value)) accounts.push(value);
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

  function combineCountRows(rows) {
    const distinct = new Map();
    for (const row of rows) {
      const name = [row.account, row.zone, row.character, row.raid].map(key);
      const id = JSON.stringify([...name, row.numerator, row.denominator]);
      if (!distinct.has(id)) distinct.set(id, row);
    }
    return [...distinct.values()];
  }

  function quotaName(raid) {
    return raid === null ? "团本总奖励次数" : raid;
  }

  function quotaKey(raid) {
    return raid === null ? null : raid.normalize("NFKC").trim().toLocaleLowerCase();
  }

  function parseQuotaText(text, account) {
    const entries = new Map();
    for (const [index, line] of lines(text).entries()) {
      if (!line.trim()) continue;
      const prefix = "账号额度第 " + (index + 1) + " 行：";
      const columns = /[|｜]/u.test(line) ? line.split(/[|｜]/u) : line.split("\t");
      if (columns.length !== 2) throw new Error(prefix + "请按「团本名称 | 4/15」填写。");
      const label = columns[0].trim();
      if (!label || label.length > 40) throw new Error(prefix + "请填写 40 字以内的额度名称。");
      const raid = /^(?:团本总奖励次数|总计)$/u.test(label) ? null : label;
      const numbers = columns[1].normalize("NFKC").trim().match(/^(\d+)\s*\/\s*(\d+)$/u);
      const numerator = Number(numbers?.[1]);
      const denominator = Number(numbers?.[2]);
      if (!numbers || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
          denominator < 1 || numerator > denominator) {
        throw new Error(prefix + "次数请填写 0 到上限之间的整数，例如 4/15 或 180/180。");
      }
      const key = quotaKey(raid);
      const previous = entries.get(key);
      if (previous && (previous.numerator !== numerator || previous.denominator !== denominator)) {
        throw new Error(prefix + "「" + quotaName(raid) + "」有不同额度，请核对并保留一项。");
      }
      if (!previous) entries.set(key, { account, raid, numerator, denominator, reading: numbers[1] + "/" + numbers[2] });
    }
    return [...entries.values()];
  }

  function setQuotaRows(tracker, server, input, basis) {
    if (!input.length) return [];
    const catalog = new Map(tracker.getRaidCatalog(server).map((raid) => [quotaKey(raid.name), raid.name]));
    const entries = new Map();
    for (const row of input) {
      if (!row.account) throw new Error("请选择账号团本额度的导入账号。");
      const matches = server.accounts.filter((item) => key(item.name) === key(row.account));
      if (matches.length > 1) throw new Error("有多个同名账号，请先区分名称后再录入额度。");
      if (!matches.length) throw new Error("找不到额度导入账号「" + row.account + "」。");
      const [account] = matches;
      const raid = row.raid === null ? null : catalog.get(quotaKey(row.raid));
      if (raid === undefined) throw new Error("找不到团本「" + row.raid + "」，请先加入团本目录。");
      const remaining = basis === "used" ? row.denominator - row.numerator : row.numerator;
      const identity = JSON.stringify([account.id, raid]);
      const previous = entries.get(identity);
      if (previous && (previous.remaining !== remaining || previous.denominator !== row.denominator)) {
        throw new Error("账号「" + account.name + "」的「" + quotaName(raid) + "」有不同额度，请保留一项。");
      }
      if (previous) continue;
      if (!tracker.setAccountRaidQuota(account, raid, { remaining, maxAttempts: row.denominator })) {
        throw new Error("无法录入「" + quotaName(raid) + "」的账号额度。");
      }
      entries.set(identity, { ...row, account: account.name, raid, remaining });
    }
    return [...entries.values()];
  }

  async function readScreenshot(file, selectedKind, progress, catalog, includeQuotas) {
    if (selectedKind === "roles") {
      return { roles: await root.JingheRosterLayout.readRoles(file, progress, { review: true }) };
    }
    if (selectedKind === "raids") {
      return root.JingheRosterLayout.readChallenges(file, progress, { catalog, includeQuotas, review: true });
    }
    if (selectedKind === "account") {
      const list = { x: 0.395, y: 0.278, width: 0.245, height: 0.32, psm: 6 };
      const fullImage = { x: 0, y: 0, width: 1, height: 1, psm: 11 };
      const scans = await root.JingheOCR.recognize(file, progress, { regions: [list, fullImage] });
      let accounts = [];
      // Prefer the most complete pass without adding alternate readings of the same row.
      for (const { text, region } of scans) {
        const names = screenshotAccounts(text);
        if (names.length > accounts.length) {
          accounts = names.map((name) => ({ name, regions: region === fullImage ? [] : [region] }));
        }
      }
      return { accounts };
    }
    const cards = await root.JingheRosterLayout.readServerList(file, (ratio) => progress(ratio * 0.85), { review: true });
    if (cards.length) {
      progress(1);
      return { roles: cards };
    }
    const regions = [
      { x: 0.312, y: 0.17, width: 0.255, height: 0.79, psm: 6 },
      { x: 0.658, y: 0.17, width: 0.254, height: 0.79, psm: 6 },
    ];
    const remainingProgress = (ratio) => progress(0.85 + ratio * 0.15);
    const scanned = await root.JingheOCR.recognize(file, remainingProgress, { regions });
    const enrich = (value, region) => ({
      ...value, regions: region ? [region] : [],
    });
    const values = scanned.flatMap((item) => serverCards(item.text).map((value) => enrich(value, item.region)));
    const result = values.length ? values : serverCards(await root.JingheOCR.recognize(file, remainingProgress, { psm: 11 }))
      .map((value) => enrich(value));
    return { roles: result };
  }

  function matching(items, name) {
    const matches = (items ?? []).filter((item) => key(item.name) === key(name));
    return matches.length === 1 ? matches[0] : null;
  }

  function recentTargets() {
    try { return JSON.parse(root.localStorage.getItem(TARGETS_KEY)) || {}; }
    catch { return {}; }
  }

  function saveTarget(serverId, target) {
    if (!target?.account) return;
    try { root.localStorage.setItem(TARGETS_KEY, JSON.stringify({ ...recentTargets(), [serverId]: target })); }
    catch { /* A browser can disable persistent storage. */ }
  }

  function recognizedRows(result) {
    const groups = [
      ["account", result.accounts], ["role", result.roles],
      ["raid", result.namedRaids ?? result.names?.map((raid) => ({ raid }))],
      ["count", result.counts], ["quota", result.quotas],
    ];
    return groups.flatMap(([type, values]) => (values ?? []).map(({ regions, nameConfidence, ...value }) => ({
      type, raw: value, value: { ...value }, regions: regions ?? [], nameConfidence, included: true, confirmed: new Set(),
    })));
  }

  function readings(reading, basis) {
    const match = String(reading ?? "").normalize("NFKC").trim().match(/^(\d+)\s*\/\s*(\d+)$/u);
    if (!match) return null;
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator < 1 || numerator > denominator) return null;
    return { numerator, denominator, remaining: basis === "used" ? denominator - numerator : numerator };
  }

  function oneMissingCharacter(shorter, longer) {
    if (shorter.length < 2 || longer.length !== shorter.length + 1) return false;
    const mismatch = shorter.findIndex((letter, index) => letter !== longer[index]);
    return mismatch === -1 || shorter.slice(mismatch).every((letter, index) => letter === longer[mismatch + index + 1]);
  }

  function similarNames(value, choices, includeMissingCharacter = false) {
    const normalize = (name) => key(name.normalize("NFKC")).replace(/\s/g, "");
    const current = normalize(value ?? "");
    if (!current || choices.some((name) => key(name) === key(value))) return [];
    const letters = Array.from(current);
    return unique(choices).filter((name) => {
      const other = Array.from(normalize(name));
      if (current === other.join("")) return true;
      if (includeMissingCharacter && (oneMissingCharacter(letters, other) || oneMissingCharacter(other, letters))) return true;
      return letters.length >= 2 && letters.length === other.length && letters.filter((letter, index) => letter !== other[index]).length === 1;
    }).slice(0, 3);
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
    const quotaField = get("roster-quota-field");
    const quotaText = get("roster-quota-text");
    const countBasis = get("roster-count-basis");
    const status = get("roster-status");
    const preview = get("roster-preview");
    const apply = get("apply-roster");
    const chooser = get("roster-screenshot");
    const chooseImages = get("roster-choose-images");
    const batchKind = get("roster-image-kind");
    const typeOptions = Array.from(batchKind.options).filter((option) => option.value);
    const recognize = get("recognize-roster");
    const pasteImage = get("roster-paste-image");
    const queueStatus = get("roster-image-queue");
    const clearImages = get("roster-clear-images");
    const imageList = get("roster-images");
    const imageOptions = get("roster-image-options");
    const batchKindField = get("roster-batch-kind");
    const imageCard = get("roster-image-card");
    const reviewSection = get("roster-ocr-review");
    const reviewTitle = get("roster-ocr-title");
    const reviewStatus = get("roster-review-status");
    const reviewGroups = get("roster-review-groups");
    const evidence = get("roster-evidence");
    const evidenceImage = get("roster-evidence-image");
    const evidencePreview = get("roster-evidence-preview");
    const evidenceClose = get("roster-evidence-close");
    const previewButton = get("preview-roster");
    const closeButton = get("close-roster-import");
    const imageQueue = [];
    let busy = false;
    let saving = false;
    let readingClipboard = false;
    let session = 0;
    let imageNumber = 0;
    let sourceControl;
    let reviewRows = [];
    let reviewedBase;
    let defaultZoneEdited = false;

    function message(text) {
      status.textContent = text;
      status.hidden = !text;
    }

    function renderImageQueue() {
      const empty = imageQueue.length === 0;
      const locked = busy || saving || readingClipboard;
      imageOptions.hidden = empty;
      imageList.hidden = empty;
      queueStatus.hidden = empty;
      queueStatus.textContent = empty ? "" : "已添加 " + imageQueue.length + " 张截图";
      clearImages.disabled = locked;
      pasteImage.disabled = locked;
      recognize.disabled = empty || locked;
      chooseImages.disabled = locked;
      chooser.disabled = locked;
      batchKindField.hidden = imageQueue.length < 2;
      batchKind.disabled = locked;
      const firstKind = imageQueue[0]?.select.value;
      batchKind.value = imageQueue.every(({ select }) => select.value === firstKind) ? firstKind || "" : "";
      imageQueue.forEach(({ thumbnail, select, remove, accountInput, zoneInput, scanned }, index) => {
        const number = index + 1;
        thumbnail.alt = "第 " + number + " 张截图";
        select.setAttribute("aria-label", "第 " + number + " 张截图类型");
        remove.setAttribute("aria-label", "移除第 " + number + " 张截图");
        select.disabled = locked;
        remove.disabled = locked;
        accountInput.setAttribute("aria-label", "第 " + number + " 张截图账号");
        zoneInput.setAttribute("aria-label", "第 " + number + " 张截图区服");
        accountInput.disabled = locked || select.value === "account";
        zoneInput.disabled = locked || select.value === "account";
        select.closest("li").dataset.scanned = String(scanned);
      });
    }

    function addImages(images) {
      if (!images.length) return;
      for (const file of images) {
        const card = imageCard.content.firstElementChild.cloneNode(true);
        const thumbnail = card.querySelector("img");
        const select = card.querySelector("[data-roster-kind]");
        const remove = card.querySelector("[data-remove-roster-image]");
        const accountInput = card.querySelector("[data-image-account]");
        const zoneInput = card.querySelector("[data-image-zone]");
        const zoneOptions = card.querySelector("[data-image-zones]");
        zoneOptions.id = "roster-image-zones-" + (++imageNumber);
        zoneInput.setAttribute("list", zoneOptions.id);
        const url = URL.createObjectURL(file);
        thumbnail.src = url;
        select.replaceChildren(...typeOptions.map((option) => option.cloneNode(true)));
        select.value = "roles";
        const entry = { file, url, thumbnail, select, remove, accountInput, zoneInput, zoneOptions, rows: [], scanned: false };
        select.addEventListener("change", () => {
          entry.rows = [];
          entry.scanned = false;
          renderImageQueue();
          renderReview();
          invalidate();
        });
        accountInput.addEventListener("input", () => {
          refreshTargets(false);
          updateReview();
          invalidate();
        });
        zoneInput.addEventListener("input", () => {
          refreshTargets(false);
          updateReview();
          invalidate();
        });
        remove.addEventListener("click", () => {
          const index = imageQueue.indexOf(entry);
          URL.revokeObjectURL(url);
          imageQueue.splice(index, 1);
          card.remove();
          renderImageQueue();
          renderReview();
          invalidate();
          (imageQueue[index]?.remove || imageQueue[index - 1]?.remove || pasteImage).focus();
        });
        imageQueue.push(entry);
        imageList.append(card);
      }
      message("");
      renderImageQueue();
      refreshTargets(false);
    }

    function resetImages() {
      for (const { url } of imageQueue) URL.revokeObjectURL(url);
      imageQueue.length = 0;
      imageList.replaceChildren();
      chooser.value = "";
      renderImageQueue();
      renderReview();
      invalidate();
    }

    function invalidate() {
      preview.hidden = true;
      apply.disabled = true;
      reviewedBase = undefined;
    }

    function replaceOptions(element, names) {
      element.replaceChildren(...unique(names).map((name) => {
        const option = document.createElement("option");
        option.value = name;
        return option;
      }));
    }

    function accountFor(entry) {
      return entry.accountInput.value.trim() || account.value.trim();
    }

    function detectedRoles() {
      const roles = new Map();
      for (const entry of imageQueue) {
        const owner = key(accountFor(entry));
        if (!owner) continue;
        for (const row of entry.rows) {
          if (!row.included || row.type !== "role" || !row.value.character?.trim() || !row.value.zone?.trim()) continue;
          if (!roles.has(owner)) roles.set(owner, []);
          roles.get(owner).push({
            character: row.value.character.trim(),
            zone: entry.zoneInput.value.trim() || row.value.zone.trim(),
          });
        }
      }
      return roles;
    }

    function refreshTargets(fillZone) {
      const server = getServer();
      const scannedAccounts = imageQueue.flatMap((entry) => entry.rows.filter((row) => row.type === "account" && row.included)
        .map((row) => row.value.name));
      replaceOptions(get("roster-account-options"), server.accounts.map((item) => item.name).concat(lines(accountText.value), scannedAccounts));
      const sources = detectedRoles();
      const savedZoneNames = (name) => matching(server.accounts, name)?.zones.map((item) => item.name) ?? [];
      const zoneNames = (name) => [...savedZoneNames(name), ...(sources.get(key(name)) ?? []).map((item) => item.zone)];
      const zones = zoneNames(account.value);
      replaceOptions(get("roster-zone-options"), zones);
      const saved = savedZoneNames(account.value);
      if (fillZone && !zone.value.trim() && saved.length === 1) zone.value = saved[0];
      for (const entry of imageQueue) replaceOptions(entry.zoneOptions, zoneNames(accountFor(entry)));
    }

    function rowTarget(base, entry, row, sources) {
      const accountName = accountFor(entry);
      const savedAccount = matching(base.accounts, accountName);
      const defaultZone = key(accountName) === key(account.value) && (defaultZoneEdited || !sources.length)
        ? zone.value.trim() : "";
      const soleZone = !sources.length && savedAccount?.zones.length === 1 ? savedAccount.zones[0].name : "";
      const character = key(row.value.character);
      const sourceZones = unique(sources.filter((item) => key(item.character) === character).map((item) => item.zone));
      const savedZones = (savedAccount?.zones ?? [])
        .filter((item) => item.characters.some((role) => key(role.name) === character)).map((item) => item.name);
      const matches = unique([...sourceZones, ...savedZones]);
      const direct = entry.zoneInput.value.trim() || row.value.zone?.trim();
      const zoneName = direct || (matches.length === 1 ? matches[0] : "") || defaultZone || soleZone;
      return {
        account: accountName, zone: zoneName || tracker.DEFAULT_ZONE_NAME, savedAccount,
        unresolved: !zoneName && (sources.length > 0 || savedAccount?.zones.length > 1),
      };
    }

    function roleSources(base) {
      const detected = detectedRoles();
      const confirmed = new Map();
      for (const entry of imageQueue) {
        const owner = key(accountFor(entry));
        if (!owner) continue;
        for (const row of entry.rows) {
          const name = row.value.character?.trim();
          if (!row.included || !name || row.verifiedName !== name) continue;
          const target = rowTarget(base, entry, row, detected.get(owner) ?? []);
          if (target.unresolved) continue;
          if (!confirmed.has(owner)) confirmed.set(owner, []);
          confirmed.get(owner).push({ character: name, zone: target.zone });
        }
      }
      return { detected, confirmed };
    }

    function roleContext(base, entry, row, sources) {
      const owner = key(accountFor(entry));
      const confirmed = sources.confirmed.get(owner) ?? [];
      const batchRoles = [...(sources.detected.get(owner) ?? []), ...confirmed];
      const target = rowTarget(base, entry, row, batchRoles);
      const saved = (target.savedAccount?.zones ?? []).flatMap((zone) => (
        zone.characters.map(({ name }) => ({ character: name, zone: zone.name }))
      ));
      const inScope = (role) => target.unresolved || key(role.zone) === key(target.zone);
      return { target, verified: [...saved, ...confirmed].filter(inScope), batchRoles: batchRoles.filter(inScope) };
    }

    function roleSuggestions(row, context) {
      const { target, verified, batchRoles } = context;
      const name = row.value.character;
      const alternate = row.alternateName;
      const exact = verified.filter((role) => key(role.character) === key(name));
      const alternateVerified = alternate && verified.some((role) => key(role.character) === key(alternate));
      if (!target.unresolved && exact.length && !alternateVerified) return [];
      const evidence = row.value.zone?.trim() ? verified : [...verified, ...batchRoles];
      const similar = similarNames(name, evidence.map((role) => role.character), true);
      const suggestions = new Map();
      const add = (value, zone, rescan) => {
        const id = JSON.stringify([key(value), key(zone)]);
        if (!suggestions.has(id)) suggestions.set(id, { field: "character", value, zone, rescan });
      };
      for (const { character, zone } of evidence) {
        if (similar.includes(character) || (target.unresolved && key(character) === key(name))) {
          add(character, target.unresolved ? zone : undefined, false);
        }
      }
      if (alternate && key(alternate) !== key(name)) {
        const zones = target.unresolved ? unique(evidence.filter((role) => key(role.character) === key(alternate))
          .map((role) => role.zone)) : [];
        if (zones.length) {
          for (const zone of zones) add(alternate, zone, true);
        } else {
          add(alternate, undefined, true);
        }
      }
      return [...suggestions.values()];
    }

    function describeRow(base, entry, row, catalog, sources) {
      const context = roleContext(base, entry, row, sources);
      const { target } = context;
      const { name, character, level, power, raid, reading } = row.value;
      const savedZone = matching(target.savedAccount?.zones, target.zone);
      const savedRole = matching(savedZone?.characters, character ?? "");
      const savedRaid = matching(catalog, raid ?? "");
      const roleNeeded = row.type === "role" || row.type === "count";
      const readingNeeded = row.type === "count" || row.type === "quota";
      const basis = countBasis.value;
      const numbers = readingNeeded ? readings(reading, basis) : null;
      const profile = row.type === "role" ? tracker.normalizeCharacterProfile({ level, power }) : {};
      const suggestions = [];
      if (roleNeeded && !row.confirmed.has("character")) {
        suggestions.push(...roleSuggestions(row, context));
      }
      if (raid && !row.confirmed.has("raid")) {
        suggestions.push(...similarNames(raid, catalog.map((item) => item.name)).map((value) => ({ field: "raid", value })));
      }
      let error = "";
      if ((roleNeeded || readingNeeded) && !target.account) error = "请选择导入账号";
      else if (roleNeeded && target.unresolved) error = "未能唯一匹配区服，请核对角色或选择区服";
      else if (rowTypes[row.type].fields.some(([field]) =>
        ["name", "character", "raid"].includes(field) && row.value[field] !== null && !row.value[field]?.trim())) error = "请填写名称";
      else if (row.type === "role" && ((level && profile.level === undefined) || (power && profile.power === undefined))) {
        error = "请检查等级或战力格式";
      } else if (readingNeeded && !basis) error = "请选择读数含义";
      else if (readingNeeded && !numbers) error = "请填写有效次数，例如 3/5";
      else if (suggestions.length) error = "请确认相近名称";

      const describeReading = (record) => record
        ? record.remaining + "/" + tracker.raidLimit(base, record) : "未记录";
      let group = [row.type];
      let destination = "当前服";
      let current = "未录入";
      let next = "";
      let data = row.value;
      if (row.type === "account") {
        group.push(key(name));
        current = matching(base.accounts, name) ? "已有账号" : "未录入";
        next = name;
      } else if (row.type === "raid") {
        group.push(key(raid));
        current = savedRaid ? "已有团本" : "未录入";
        next = raid;
      } else {
        group.push(key(target.account));
        destination = target.account || "未选账号";
        if (roleNeeded) {
          group.push(key(target.zone), key(character));
          destination += " / " + (target.unresolved ? "未选区服" : target.zone);
        }
        if (row.type === "role") {
          current = savedRole ? profileText(savedRole) || "已有角色" : "未录入";
          next = profileText({ ...savedRole, ...profile }) || character;
          data = { account: target.account, zone: target.zone, character, ...profile };
        } else {
          group.push(raid === null ? null : key(raid));
          const record = row.type === "count"
            ? matching(savedRole?.raids, raid)
            : tracker.getAccountRaidQuota(target.savedAccount, raid);
          current = describeReading(record);
          next = numbers && basis ? numbers.remaining + "/" + numbers.denominator : "待核对";
          data = { ...row.value, ...numbers, account: target.account, zone: target.zone };
        }
      }
      const knownName = !target.unresolved && context.verified.some((role) => key(role.character) === key(character));
      return { identity: JSON.stringify(group), current, next, destination, data, error, suggestions, knownName };
    }

    function inspectRows(base, sources = roleSources(base)) {
      const catalog = tracker.getRaidCatalog(base);
      const statuses = reviewRows.map(({ entry, row }) => ({ entry, row, ...describeRow(base, entry, row, catalog, sources) }));
      const selected = new Map();
      for (const state of statuses) {
        if (!state.row.included || state.error) continue;
        if (!selected.has(state.identity)) selected.set(state.identity, []);
        selected.get(state.identity).push(state);
      }
      for (const candidates of selected.values()) {
        if (candidates.length < 2) continue;
        const first = candidates[0];
        const fields = first.row.type === "role" ? ["level", "power"] : ["numerator", "denominator"];
        const disputed = fields.some((field) => {
          const values = new Set(candidates.map(({ data }) => data[field]).filter((value) => value !== undefined));
          return values.size > 1;
        });
        if (disputed) for (const state of candidates) state.alternatives = candidates;
      }
      return statuses;
    }

    function planNameRescans(files) {
      const base = getServer();
      const sources = roleSources(base);
      const byImage = new Map();
      const seenIn = new Map();
      for (const entry of imageQueue) {
        const names = new Map();
        for (const row of entry.rows) {
          const region = row.regions[0];
          if (!row.included || !["role", "count"].includes(row.type) || !region?.id || names.has(region.id)) continue;
          const context = roleContext(base, entry, row, sources);
          const { target } = context;
          const word = key(row.value.character);
          const signature = target.account && !target.unresolved && word
            ? JSON.stringify([key(target.account), key(target.zone), word]) : "";
          if (signature) {
            if (!seenIn.has(signature)) seenIn.set(signature, new Set());
            seenIn.get(signature).add(entry);
          }
          names.set(region.id, { row, region, context, word, signature });
        }
        byImage.set(entry, names);
      }
      const tasks = [];
      for (const entry of files) {
        const regions = [];
        for (const { row, region, context, word, signature } of byImage.get(entry).values()) {
          if (row.confirmed.has("character")) continue;
          const lowConfidence = Number.isFinite(row.nameConfidence) && row.nameConfidence < CONFIDENT_NAME_SCORE;
          const verified = !context.target.unresolved && context.verified.some((role) => key(role.character) === word);
          const corroborated = signature && seenIn.get(signature).size > 1;
          const canCompare = context.verified.length || context.batchRoles.length;
          if (!candidate(row.value.character ?? "") || lowConfidence || (!verified && canCompare && !corroborated)) {
            regions.push(region);
          }
        }
        if (regions.length) tasks.push({ entry, regions });
      }
      return tasks;
    }

    async function rescanNames(files, run) {
      const tasks = planNameRescans(files);
      let failed = 0;
      for (const [index, { entry, regions }] of tasks.entries()) {
        if (!dialog.open || run !== session) break;
        const progress = (ratio) => {
          if (dialog.open && run === session) {
            message("复扫第 " + (index + 1) + "/" + tasks.length + " 张的角色名 · " + Math.round(ratio * 100) + "%");
          }
        };
        progress(0);
        try {
          const names = await root.JingheRosterLayout.readRoleNames(entry.file, progress, regions);
          if (!dialog.open || run !== session) break;
          for (const row of entry.rows) {
            const alternate = names.get(row.regions[0]?.id);
            if (alternate && key(alternate) !== key(row.value.character)) row.alternateName = alternate;
          }
        } catch (error) {
          failed += 1;
          console.warn("角色名复扫失败", error);
        }
      }
      return failed;
    }

    function element(tag, text, className) {
      const html = document.createElement(tag);
      if (text) html.textContent = text;
      if (className) html.className = className;
      return html;
    }

    function action(text, handler, className = "button button--quiet") {
      const button = element("button", text, className);
      button.type = "button";
      button.addEventListener("click", handler);
      return button;
    }

    function showEvidence(item, source) {
      const { entry, row } = item;
      const markers = row.regions.map((region) => {
        const marker = element("span", "", "roster-evidence-marker");
        marker.setAttribute("aria-hidden", "true");
        for (const [property, number] of Object.entries({ left: region.x, top: region.y, width: region.width, height: region.height })) {
          marker.style[property] = number * 100 + "%";
        }
        return marker;
      });
      sourceControl = source;
      const label = "第 " + (imageQueue.indexOf(entry) + 1) + " 张 · " + rowTypes[row.type].label;
      evidencePreview.alt = label;
      evidencePreview.src = entry.url;
      evidenceImage.replaceChildren(evidencePreview, ...markers);
      get("roster-evidence-label").textContent = label;
      evidence.hidden = false;
      evidenceClose.focus();
    }

    function hideEvidence() {
      evidence.hidden = true;
      evidencePreview.removeAttribute("src");
      evidenceImage.replaceChildren(evidencePreview);
      sourceControl = undefined;
    }

    evidenceClose.addEventListener("click", () => {
      const source = sourceControl;
      hideEvidence();
      source?.focus();
    });

    function setReviewValue(item, field, value) {
      item.row.value[field] = value;
      if (item.inputs[field].value !== value) item.inputs[field].value = value;
      item.row.confirmed.add(field);
    }

    function setSameImageValue(item, field, value, zone) {
      const original = item.row.raw[field];
      const proposed = item.row.value[field];
      const nameRegion = item.row.regions[0]?.id;
      const apply = (other) => {
        setReviewValue(other, field, value);
        if (zone) {
          other.row.value.zone = zone;
          if (other.inputs.zone) other.inputs.zone.value = zone;
        }
      };
      // A challenge row shares one source name across its raid cells.
      for (const other of reviewRows) {
        if (other === item) continue;
        if (other.entry !== item.entry || other.row.raw[field] !== original || other.row.value[field] !== proposed) continue;
        if (field === "character" && (
          item.row.type !== "count" || other.row.type !== "count"
          || !/^role-\d+$/.test(nameRegion) || other.row.regions[0]?.id !== nameRegion
        )) continue;
        apply(other);
      }
      apply(item);
    }

    function changeRow(item, field, value) {
      if (field === "character" && item.row.type === "count") setSameImageValue(item, field, value);
      else setReviewValue(item, field, value);
      if (field === "character") {
        item.row.nameEdited = true;
        item.row.verifiedName = value.trim();
      }
      if (item.row.type === "account" || field === "zone") refreshTargets(false);
      updateReview();
      invalidate();
    }

    function confirmSuggestion(item, field, value, zone) {
      setSameImageValue(item, field, value, zone);
      if (field === "character") {
        item.row.nameEdited = true;
        item.row.verifiedName = value.trim();
      }
      if (zone) refreshTargets(false);
      updateReview();
      item.inputs[field].focus();
      invalidate();
    }

    function relatedNameRows(item, base, sources) {
      const { entry, row } = item;
      const previous = key(row.raw.character);
      const name = row.value.character?.trim();
      const owner = key(accountFor(entry));
      if (!owner || !previous || !name || previous === key(name) || !row.nameEdited) return [];
      const batchRoles = sources.get(owner) ?? [];
      const target = rowTarget(base, entry, row, batchRoles);
      if (target.unresolved || target.zone === tracker.DEFAULT_ZONE_NAME) return [];
      return reviewRows.filter((other) => {
        const peer = other.row;
        if (other.entry === entry || !peer.included || key(accountFor(other.entry)) !== owner
          || key(peer.raw.character) !== previous || key(peer.value.character) !== previous
          || peer.confirmed.has("character")) return false;
        const corrected = { ...peer, value: { ...peer.value, character: name } };
        const destination = rowTarget(base, other.entry, corrected, batchRoles);
        return !destination.unresolved && key(destination.zone) === key(target.zone);
      });
    }

    function applyRelatedNames(item) {
      const name = item.row.value.character.trim();
      for (const other of relatedNameRows(item, getServer(), detectedRoles())) {
        setReviewValue(other, "character", name);
      }
      updateReview();
      item.inputs.character.focus();
      invalidate();
    }

    function rowControls(entry, row, number) {
      const elementRow = element("tr", "", "roster-review-row");
      const raw = rowTypes[row.type].fields.map(([field]) => field === "raid" ? quotaName(row.raw[field]) : row.raw[field])
        .filter((value) => value !== undefined).join(" · ");
      const sourceCell = element("td", "", "roster-review-source");
      const editCell = element("td", "", "roster-review-edit");
      const valueCell = element("td", "", "roster-review-values");
      const choiceCell = element("td", "", "roster-review-choice");
      const item = { entry, row, elementRow, inputs: {} };
      const source = action("图 " + number, () => showEvidence(item, source));
      source.setAttribute("aria-label", "查看图 " + number + " 中的" + rowTypes[row.type].label + " · " + raw);
      sourceCell.append(element("strong", rowTypes[row.type].label), element("span", raw), source);
      for (const [field, label] of rowTypes[row.type].fields) {
        const fieldLabel = element("label", "", "roster-review-field");
        fieldLabel.append(element("span", label));
        if (row.value[field] === null) {
          fieldLabel.append(element("span", quotaName(null)));
        } else {
          const input = element("input");
          input.type = "text";
          input.maxLength = 40;
          input.value = row.value[field] ?? "";
          input.autocomplete = "off";
          input.spellcheck = false;
          if (field === "zone") input.placeholder = "按角色匹配";
          input.addEventListener("input", (event) => {
            if (!event.isComposing) changeRow(item, field, input.value);
          });
          input.addEventListener("compositionend", () => changeRow(item, field, input.value));
          item.inputs[field] = input;
          fieldLabel.append(input);
        }
        editCell.append(fieldLabel);
      }
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = row.included;
      checkbox.addEventListener("change", () => {
        row.included = checkbox.checked;
        refreshTargets(false);
        updateReview();
        invalidate();
      });
      const keepLabel = element("label", "", "roster-review-keep");
      keepLabel.append(checkbox, element("span", "导入此条"));
      item.values = element("span");
      item.destination = element("small", "", "roster-review-target");
      item.issue = element("small", "", "roster-review-issue");
      item.suggestions = element("div", "", "roster-review-suggestions");
      item.checkbox = checkbox;
      valueCell.append(item.destination, item.values);
      choiceCell.append(keepLabel, item.issue, item.suggestions);
      elementRow.append(sourceCell, editCell, valueCell, choiceCell);
      return item;
    }

    function renderReview() {
      hideEvidence();
      reviewRows = [];
      const sections = [];
      for (const [index, entry] of imageQueue.entries()) {
        if (!entry.rows.length) continue;
        const table = element("table", "", "roster-review-table");
        table.append(element("caption", "第 " + (index + 1) + " 张 · " + entry.select.selectedOptions[0].textContent));
        const head = table.createTHead().insertRow();
        for (const label of ["来源与原读数", "核对内容", "现有值 → 导入值", "录入选择"]) {
          const heading = element("th", label);
          heading.scope = "col";
          head.append(heading);
        }
        const body = table.createTBody();
        for (const row of entry.rows) {
          const item = rowControls(entry, row, index + 1);
          reviewRows.push(item);
          body.append(item.elementRow);
        }
        sections.push(table);
      }
      reviewGroups.replaceChildren(...sections);
      reviewSection.hidden = !reviewRows.length;
      refreshTargets(false);
      updateReview();
    }

    function updateReview() {
      if (!reviewRows.length) return;
      const base = getServer();
      const sources = roleSources(base);
      const statuses = inspectRows(base, sources);
      let unresolved = 0;
      let selected = 0;
      for (const [index, state] of statuses.entries()) {
        const item = reviewRows[index];
        const selectedRow = item.row.included;
        const blocked = selectedRow && (state.error || state.alternatives);
        if (selectedRow) selected += 1;
        if (blocked) unresolved += 1;
        item.elementRow.dataset.included = String(selectedRow);
        item.elementRow.dataset.unresolved = String(Boolean(blocked));
        item.checkbox.checked = selectedRow;
        item.values.textContent = state.current + " → " + state.next;
        item.destination.textContent = state.destination;
        item.issue.textContent = selectedRow ? state.error || (state.alternatives ? "同一项有不同读数" : "") : "已跳过";
        const buttons = [];
        if (selectedRow) {
          for (const { field, value, zone, rescan } of state.suggestions) {
            const label = (rescan ? "采用复扫「" : "使用「") + value + "」" + (zone ? " · " + zone : "");
            buttons.push(action(label, () => confirmSuggestion(item, field, value, zone)));
          }
          for (const field of new Set(state.suggestions.map(({ field }) => field))) {
            const label = rowTypes[item.row.type].fields.find(([name]) => name === field)[1];
            buttons.push(action("保留原" + label, () => confirmSuggestion(item, field, item.row.value[field])));
          }
          if (state.row.type === "role" && state.row.value.character?.trim() && !state.knownName
            && !state.suggestions.some(({ field }) => field === "character") && !state.row.confirmed.has("character")) {
            buttons.push(action("确认角色名", () => confirmSuggestion(item, "character", item.row.value.character)));
          }
          const related = relatedNameRows(item, base, sources.detected);
          if (related.length) buttons.push(action("应用到同账号区服的其他 " + related.length + " 条", () => applyRelatedNames(item)));
          if (state.alternatives) buttons.push(action("保留此条", () => {
            for (const alternative of state.alternatives) {
              if (alternative.row !== item.row) alternative.row.included = false;
            }
            updateReview();
            item.checkbox.focus();
            invalidate();
          }));
        }
        item.suggestions.replaceChildren(...buttons);
      }
      const selectedText = "已选 " + selected + " 条";
      const text = selectedText + (unresolved ? " · " + unresolved + " 条待确认" : "");
      if (reviewStatus.textContent !== text) reviewStatus.textContent = text;
    }

    function plan() {
      const base = getServer();
      const targets = { account: account.value.trim(), zone: zone.value.trim() };
      const selected = inspectRows(base).filter(({ row }) => row.included);
      if (selected.some(({ error, alternatives }) => error || alternatives)) {
        throw new Error("请先处理表格中的待确认项，也可以跳过对应行。");
      }
      const recognized = (type) => selected.filter(({ row }) => row.type === type).map(({ data }) => data);
      const roles = combineRoleRows([...tracker.parseRosterText(roleText.value, targets), ...recognized("role")]);
      const accountNames = unique(lines(accountText.value).concat(recognized("account").map(({ name }) => name)).map((name) => name.trim()));
      const raids = unique(lines(raidText.value).concat(recognized("raid").map(({ raid }) => raid)).map((name) => name.trim()));
      const counts = combineCountRows([...tracker.parseRaidCountText(countText.value, targets), ...recognized("count")]);
      const quotaRows = base.serverId === "regular"
        ? [...parseQuotaText(quotaText.value, targets.account), ...recognized("quota")]
        : [];
      if ((counts.length || quotaRows.length) && !["remaining", "used"].includes(countBasis.value)) {
        throw new Error("请选择团本读数是剩余次数还是已用次数。");
      }
      if (accountNames.some((name) => name.length > 40) || raids.some((name) => name.length > 40)) {
        throw new Error("账号及团本名称请控制在 40 字以内。");
      }
      if (!roles.length && !accountNames.length && !raids.length && !counts.length && !quotaRows.length) {
        throw new Error("请先填写要录入的名单、团本次数或账号额度。");
      }

      const result = tracker.importRoster(base, roles);
      let server = result.server;
      const newAccounts = [];
      for (const name of accountNames) {
        if (server.accounts.some((item) => key(item.name) === key(name))) continue;
        if (server.accounts.length >= tracker.ACCOUNT_LIMIT) throw new Error("该服的账号数量已到上限。");
        server.accounts.push(tracker.createAccount(name, server.serverId));
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
      const quotas = setQuotaRows(tracker, server, quotaRows, countBasis.value);
      const newRaids = tracker.getRaidCatalog(server).map((entry) => entry.name).filter((name) => !original.has(key(name)));
      const usedTarget = [...roles, ...counts].at(-1) || quotas.at(-1) || { ...targets, account: targets.account || accountNames.at(-1) };
      const destinationAccount = matching(server.accounts, usedTarget.account);
      const destinationZone = matching(destinationAccount?.zones, usedTarget.zone);
      const recent = destinationAccount ? { account: destinationAccount.name, zone: destinationZone?.name || "" } : null;
      return { ...result, server, roles, counts, quotas, basis: countBasis.value, newAccounts, newRaids, updatedRaids, enabledRaids, recent };
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
      if (result.quotas.length) items.push("更新账号额度 " + result.quotas.length);
      if (result.skippedCharacters) items.push("略过已存在角色 " + result.skippedCharacters);
      return items.join(" · ") || "名单中没有新的记录";
    }

    function changed(result) {
      return result.addedAccounts || result.addedZones || result.addedCharacters ||
        result.updatedCharacters || result.newRaids.length || result.enabledRaids.length || result.updatedRaids || result.quotas.length;
    }

    function profileText(row) {
      return [row.level && "等级 " + row.level, row.power && "战力 " + row.power].filter(Boolean).join(" · ");
    }

    function review(result) {
      const heading = document.createElement("strong");
      heading.textContent = summary(result);
      const list = document.createElement("ul");
      const destinations = unique([
        ...result.roles.map(({ account, zone }) => account + " / " + zone),
        ...result.counts.map(({ account, zone }) => account + " / " + zone),
        ...result.quotas.map(({ account }) => account + "（账号额度）"),
      ]);
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
        ...result.quotas.map((row) => row.account + " / " + quotaName(row.raid)
          + " · 原读数 " + row.reading + " → 剩余 " + row.remaining + "/" + row.denominator),
        ...result.enabledRaids.map((name) => "启用 · " + name),
      ];
      for (const text of rows) {
        const row = document.createElement("li");
        row.textContent = text;
        list.append(row);
      }
      const groups = element("p", destinations.length ? "导入归属 " + destinations.join("、") : "");
      groups.hidden = !destinations.length;
      preview.replaceChildren(heading, groups, list);
      preview.hidden = false;
      apply.disabled = busy || !changed(result);
      reviewedBase = JSON.stringify(getServer());
    }

    get("open-roster-import").addEventListener("click", () => {
      refreshDay();
      session += 1;
      readingClipboard = false;
      const server = getServer();
      const label = tracker.getServerDef(server.serverId).label;
      get("roster-scope").textContent = "导入到" + label + "。请核对识别结果与归属。";
      const last = recentTargets()[server.serverId];
      const priorAccount = last ? matching(server.accounts, last.account) : null;
      const priorZone = matching(priorAccount?.zones, last?.zone);
      account.value = priorAccount?.name || (server.accounts.length === 1 ? server.accounts[0].name : "");
      zone.value = priorZone?.name || "";
      defaultZoneEdited = false;
      accountText.value = "";
      roleText.value = "";
      raidText.value = "";
      countText.value = "";
      quotaText.value = "";
      quotaField.hidden = server.serverId !== "regular";
      quotaText.disabled = quotaField.hidden;
      countBasis.value = "";
      get("roster-manual").open = false;
      resetImages();
      refreshTargets(true);
      invalidate();
      message("");
      dialog.showModal();
    });
    closeButton.addEventListener("click", () => { if (!saving) dialog.close(); });
    dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
    dialog.addEventListener("close", () => {
      session += 1;
      readingClipboard = false;
      resetImages();
    });
    clearImages.addEventListener("click", () => {
      resetImages();
      message("");
      pasteImage.focus();
    });
    chooseImages.addEventListener("click", () => chooser.click());
    chooser.addEventListener("change", () => {
      addImages(Array.from(chooser.files));
      chooser.value = "";
    });
    batchKind.addEventListener("change", () => {
      if (!batchKind.value) return;
      for (const entry of imageQueue) {
        if (entry.select.value === batchKind.value) continue;
        entry.select.value = batchKind.value;
        entry.rows = [];
        entry.scanned = false;
      }
      renderImageQueue();
      renderReview();
      invalidate();
    });
    dialog.addEventListener("paste", (event) => {
      const data = event.clipboardData;
      if (!data || !dialog.open || busy || saving) return;

      const images = Array.from(data.files).filter((file) => file.type.startsWith("image/"));
      if (!images.length) {
        for (const item of Array.from(data.items)) {
          if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
          const image = item.getAsFile();
          if (image) images.push(image);
        }
      }
      if (!images.length) return;
      event.preventDefault();
      addImages(images);
    });
    pasteImage.addEventListener("click", async () => {
      if (busy || saving || readingClipboard) return;
      if (!navigator.clipboard?.read) {
        message("此浏览器暂不支持按钮粘贴。可以在弹窗内用 Ctrl+V 或 ⌘V，也可以上传截图。");
        return;
      }
      const currentSession = session;
      readingClipboard = true;
      renderImageQueue();
      try {
        const items = await navigator.clipboard.read();
        const images = await Promise.all(items.flatMap((item) => {
          const type = item.types.find((value) => value.startsWith("image/"));
          return type ? [item.getType(type)] : [];
        }));
        if (!dialog.open || currentSession !== session) return;
        if (images.length) addImages(images);
        else message("剪贴板里没有截图，请先复制图片。");
      } catch {
        if (dialog.open && currentSession === session) {
          message("无法读取剪贴板。请允许粘贴后重试，也可以上传截图。");
        }
      } finally {
        if (currentSession === session) {
          readingClipboard = false;
          renderImageQueue();
        }
      }
    });
    form.addEventListener("input", (event) => {
      if (event.target === zone) defaultZoneEdited = true;
      if (event.target === account) {
        zone.value = "";
        defaultZoneEdited = false;
      }
      if (event.target === account || event.target === accountText) refreshTargets(event.target === account);
      if (event.target === account || event.target === zone || event.target === accountText ||
          event.target === roleText || event.target === raidText || event.target === countText ||
          event.target === quotaText || event.target === countBasis) {
        updateReview();
        invalidate();
      }
    });

    countBasis.addEventListener("change", () => {
      updateReview();
      invalidate();
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy || saving) return;
      try {
        refreshDay();
        updateReview();
        const result = plan();
        review(result);
        message(result.quotas.length ? "请核对导入账号、额度名称与剩余次数。" : "请核对识别出的账号、区服、角色和团本。");
        preview.focus();
      } catch (error) {
        invalidate();
        message(error.message);
      }
    });

    apply.addEventListener("click", async () => {
      if (apply.disabled || busy || saving) return;
      try {
        refreshDay();
        if (reviewedBase !== JSON.stringify(getServer())) {
          throw new Error("记录已经更新，请重新核对并预览。");
        }
        const result = plan();
        if (changed(result)) {
          saving = true;
          apply.disabled = true;
          previewButton.disabled = true;
          closeButton.disabled = true;
          renderImageQueue();
          const saved = await commit(result.server);
          if (!saved) throw new Error("未能保存导入，请重试。");
          saveTarget(result.server.serverId, result.recent);
          dialog.close();
          notice("已导入。 " + summary(result));
        } else {
          review(result);
          message("名单中没有可新增或更新的记录。");
        }
      } catch (error) {
        invalidate();
        updateReview();
        message(error.message);
      } finally {
        saving = false;
        previewButton.disabled = false;
        closeButton.disabled = false;
        renderImageQueue();
      }
    });

    recognize.addEventListener("click", async () => {
      if (busy || saving || readingClipboard || !imageQueue.length) return;
      const files = imageQueue.filter((entry) => !entry.scanned);
      if (!files.length) {
        reviewTitle.focus();
        message("当前截图已识别。可以继续添加截图或更改类型后重试。");
        return;
      }
      busy = true;
      renderImageQueue();
      previewButton.disabled = true;
      invalidate();
      const run = session;
      let found = 0;
      let failed = 0;
      try {
        for (const [index, entry] of files.entries()) {
          if (!dialog.open || run !== session) break;
          const progress = (fraction) => {
            if (dialog.open && run === session) {
              message("识别第 " + (index + 1) + "/" + files.length + " 张 · " + Math.round(fraction * 100) + "%");
            }
          };
          progress(0);
          try {
            const target = getServer();
            const result = await readScreenshot(entry.file, entry.select.value, progress, tracker.getRaidCatalog(target), target.serverId === "regular");
            if (!dialog.open || run !== session) break;
            entry.rows = recognizedRows(result);
            entry.scanned = entry.rows.length > 0;
            found += entry.rows.length;
          } catch (error) {
            failed += 1;
            console.warn("截图识别失败", error);
          }
        }
        const rescanFailures = dialog.open && run === session ? await rescanNames(files, run) : 0;
        if (dialog.open && run === session) {
          const failure = failed ? "有 " + failed + " 张未能识别。" : "";
          const retry = rescanFailures ? "有 " + rescanFailures + " 张姓名复扫未完成，已保留首次读数。" : "";
          renderReview();
          message(found ? "已识别 " + found + " 条，请核对后预览。" + failure + retry
            : "没有识别出可录入的信息。可以换一张更清晰的截图，或直接粘贴名单。" + failure);
        }
      } finally {
        busy = false;
        renderImageQueue();
        previewButton.disabled = false;
      }
    });
  }

  root.JingheRosterImport = { mount };
})(window);
