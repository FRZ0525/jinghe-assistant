
(function () {
  "use strict";

  const POLL_DELAY = 10000;
  const EDIT_DELAY = 350;
  const MAX_RETRY_DELAY = 60000;
  const CHECKPOINT_KEY = "jinghe-assistant-sync-checkpoint-v1";
  const CHECKPOINT_STORE = "checkpoints";
  let databasePromise;

  class SyncError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.status = status;
      this.payload = payload;
    }
  }

  class LocalRecordError extends Error {}

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(CHECKPOINT_KEY, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(CHECKPOINT_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("同步缓存暂不可用"));
    }).catch((error) => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  }

  async function databaseCheckpoint(value) {
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const writing = value !== undefined;
      const transaction = database.transaction(CHECKPOINT_STORE, writing ? "readwrite" : "readonly");
      const store = transaction.objectStore(CHECKPOINT_STORE);
      const request = writing ? store.put(value, "state") : store.get("state");
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function usableData(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      && value.servers && typeof value.servers === "object" && !Array.isArray(value.servers);
  }

  function usableVersion(value) {
    return value && Number.isSafeInteger(value.revision) && value.revision >= 0
      && (value.data === null || usableData(value.data));
  }

  function snapshotFields(data) {
    return { dailyDate: data.dailyDate, dailyResetHour: data.dailyResetHour, servers: data.servers };
  }

  function canonicalVersion(version) {
    return { revision: version.revision, data: version.data === null ? null : snapshotFields(version.data) };
  }

  async function readCheckpoint() {
    let cached = null;
    try {
      cached = JSON.parse(window.localStorage.getItem(CHECKPOINT_KEY));
    } catch {
      // LocalStorage is optional when the browser supports IndexedDB.
    }
    const stored = await databaseCheckpoint().catch(() => null);
    const latest = (cached?.savedAt || 0) >= (stored?.savedAt || 0) ? cached : stored;
    return {
      base: usableVersion(latest?.base) ? canonicalVersion(latest.base) : null,
      pending: usableVersion(latest?.pending) && latest.pending.data !== null ? canonicalVersion(latest.pending) : null,
    };
  }

  async function saveCheckpoint(base, pending) {
    const checkpoint = { base, pending, savedAt: Date.now() };
    try {
      await databaseCheckpoint(checkpoint);
      try { window.localStorage.removeItem(CHECKPOINT_KEY); } catch {}
    } catch {
      try { window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint)); } catch {}
    }
  }

  async function request(path, method = "GET", body) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const headers = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await window.fetch("/api/sync/" + path, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof payload?.error === "string" ? payload.error : "同步服务暂不可用";
        throw new SyncError(message, response.status, payload);
      }
      return payload;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function parseServerState(state) {
    if (!usableVersion(state)) throw new SyncError("同步服务返回的数据无效");
    return canonicalVersion(state);
  }

  function mount({ getSnapshot, applySnapshot }) {
    const model = window.JingheSyncMerge;
    const byId = (id) => document.getElementById(id);
    const dialog = byId("sync-dialog");
    const badge = byId("sync-badge");
    const stateText = byId("sync-state");
    const setupForm = byId("sync-setup-form");
    const setupPassword = byId("sync-setup-password");
    const setupConfirm = byId("sync-setup-confirm");
    const setupCode = byId("sync-setup-code");
    const setupCodeField = byId("sync-setup-code-field");
    const setupMessage = byId("sync-setup-message");
    const loginForm = byId("sync-login-form");
    const passwordField = byId("sync-password");
    const accountActions = byId("sync-account-actions");
    const openPassword = byId("sync-open-password");
    const passwordForm = byId("sync-password-form");
    const currentPassword = byId("sync-current-password");
    const newPassword = byId("sync-new-password");
    const confirmPassword = byId("sync-confirm-password");
    const passwordMessage = byId("sync-password-message");
    const pullButton = byId("sync-pull");
    const logoutButton = byId("sync-logout");
    const conflictSection = byId("sync-conflict");
    const conflictCopy = byId("sync-conflict-copy");
    const conflictList = byId("sync-conflict-list");
    const applyChoices = byId("sync-conflict-apply");
    const chooseLocal = byId("sync-conflict-local");
    const chooseRemote = byId("sync-conflict-remote");
    const submitButtons = [setupForm, loginForm, passwordForm].map((form) => form.querySelector('button[type="submit"]'));

    let checkpoint;
    let authenticated = false;
    let statusKnown = false;
    let setup = null;
    let changingPassword = false;
    let busy = false;
    let applying = false;
    let rerun = false;
    let conflict = null;
    let renderedConflict;
    let timer;
    let scheduledAt = Infinity;
    let retryDelay = 0;
    let nextRetryAt = 0;
    let display = { text: "正在检查同步状态", short: "检查中", kind: "pending" };

    function isOnline() {
      return window.navigator.onLine !== false;
    }

    function textFor(value) {
      if (value.missing) return "已删除或未填写";
      const { data } = value;
      if (data === null || data === "") return "空值";
      if (typeof data === "boolean") return data ? "是" : "否";
      if (typeof data !== "object") return String(data);
      if (Array.isArray(data) && data.every((item) => typeof item === "string")) {
        return data.length ? data.join("、") : "空列表";
      }
      return JSON.stringify(data);
    }

    function renderConflictItems() {
      if (renderedConflict === conflict) return;
      renderedConflict = conflict;
      conflictList.replaceChildren();
      const groups = conflict?.items || [];
      const occurrences = new Map();
      for (const { path } of groups) occurrences.set(path, (occurrences.get(path) || 0) + 1);
      const previous = new Map();
      groups.forEach((group, index) => {
        const li = document.createElement("li");
        const fieldset = document.createElement("fieldset");
        fieldset.className = "sync-choice-group";
        const legend = document.createElement("legend");
        const position = (previous.get(group.path) || 0) + 1;
        previous.set(group.path, position);
        legend.textContent = group.path + (occurrences.get(group.path) > 1 ? " · 第 " + position + " 条同名记录" : "");
        const options = document.createElement("div");
        options.className = "sync-choice-options";
        for (const [side, title] of [["local", "本机"], ["remote", "服务器"]]) {
          const label = document.createElement("label");
          label.className = "sync-choice-option";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "sync-choice-" + index;
          radio.value = side;
          radio.checked = conflict.picks.get(group.id) === side;
          radio.addEventListener("change", () => {
            if (radio.checked) conflict.picks.set(group.id, side);
            render();
          });
          const heading = document.createElement("strong");
          heading.textContent = title;
          const content = document.createElement("span");
          content.className = "sync-choice-value";
          for (const item of group.items) {
            const line = document.createElement("span");
            if (group.items.length > 1 || item.path !== group.path) {
              const name = document.createElement("small");
              name.textContent = item.path;
              line.append(name);
            }
            const value = item[side];
            line.append(document.createTextNode(textFor(value)));
            if (value.context) {
              const note = document.createElement("small");
              note.textContent = value.context;
              line.append(note);
            }
            content.append(line);
          }
          label.append(radio, heading, content);
          options.append(label);
        }
        fieldset.append(legend, options);
        li.append(fieldset);
        conflictList.append(li);
      });
    }

    function render() {
      stateText.textContent = display.text;
      stateText.dataset.state = display.kind;
      badge.textContent = "同步：" + display.short;
      badge.dataset.state = display.kind;
      loginForm.hidden = !statusKnown || authenticated || Boolean(setup);
      setupForm.hidden = authenticated || !setup;
      setupCodeField.hidden = !setup?.requiresSetupCode;
      setupCode.required = Boolean(setup?.requiresSetupCode);
      accountActions.hidden = !authenticated;
      passwordForm.hidden = !authenticated || !changingPassword;
      openPassword.setAttribute("aria-expanded", String(!passwordForm.hidden));
      conflictSection.hidden = !authenticated || !conflict;
      pullButton.disabled = busy || !isOnline();
      logoutButton.disabled = busy || !isOnline();
      for (const submit of submitButtons) submit.disabled = busy || !isOnline();
      chooseLocal.disabled = busy || !isOnline();
      chooseRemote.disabled = busy || !isOnline();
      const items = conflict?.items ?? [];
      conflictList.hidden = !items.length;
      renderConflictItems();
      for (const group of conflictList.querySelectorAll("fieldset")) group.disabled = busy || !isOnline();
      applyChoices.hidden = !items.length;
      applyChoices.disabled = busy || !isOnline() || !items.length || conflict.picks.size !== items.length;
      if (conflict?.initial) {
        conflictCopy.textContent = "本机和服务器都有记录，这台设备尚无共同版本。先下载本机备份，再选择要使用的记录。";
        chooseLocal.textContent = "采用本机记录";
        chooseRemote.textContent = "采用服务器记录";
      } else {
        conflictCopy.textContent = "对比 " + items.length + " 项冲突，分别选择要保留的值。";
        chooseLocal.textContent = "冲突项全部用本机";
        chooseRemote.textContent = "冲突项全部用服务器";
      }
    }

    function show(text, short, kind) {
      display = { text, short, kind };
      render();
    }

    function showLocal() {
      show("尚未登录同步，记录保存在此浏览器。", "未登录", "local");
    }

    function showSetup() {
      const message = setup.requiresSetupCode
        ? "从服务器日志打开首次设置链接，验证码会自动填入。"
        : "在下面设置一个同步密码，即可开启设备同步。";
      show(message, "设置密码", "local");
    }

    function formMessage(element, message, error = true) {
      element.textContent = message;
      element.hidden = !message;
      element.dataset.state = error ? "error" : "ready";
    }

    function acceptSession(result) {
      if (result?.authenticated !== true) throw new SyncError("同步登录未成功");
      authenticated = true;
      statusKnown = true;
      setup = null;
    }

    function showOffline() {
      show("目前离线，记录保存在此浏览器，连接恢复后将继续同步。", "离线", "offline");
    }

    function showSynced() {
      show("本机与服务器记录已同步。", "已同步", "ready");
    }

    function sameVersion(left, right) {
      return left === right || Boolean(left && right && left.revision === right.revision && model.same(left.data, right.data));
    }

    async function remember(base, pending = null) {
      if (sameVersion(checkpoint.base, base) && sameVersion(checkpoint.pending, pending)) return;
      checkpoint = { base, pending };
      await saveCheckpoint(base, pending);
    }

    function localSnapshot() {
      const value = getSnapshot();
      if (!usableData(value)) throw new LocalRecordError("本机记录暂时无法读取，已暂停同步。");
      return JSON.parse(JSON.stringify(snapshotFields(value)));
    }

    function applyLocal(data) {
      applying = true;
      try {
        if (!applySnapshot(JSON.parse(JSON.stringify(data)))) {
          throw new LocalRecordError("浏览器无法保存同步记录，请检查存储空间后再试。");
        }
      } finally {
        applying = false;
      }
    }

    function alignToday(data, now) {
      if (!data) return null;
      const { state } = window.Tracker.ensureDailyReset(data, now);
      return snapshotFields(state);
    }

    function sameConflictDraft(left, right) {
      return Boolean(left && right && left.day === right.day && sameVersion(left.base, right.base) &&
        sameVersion(left.remote, right.remote) && model.same(left.local, right.local));
    }

    function propose(remote, local, choice, draft, now) {
      const todayLocal = alignToday(local, now);
      const todayRemote = alignToday(remote.data, now);
      if (model.same(todayRemote, todayLocal) || !todayRemote) return { data: todayLocal };

      const base = checkpoint.base;
      const known = base && (remote.revision > base.revision || sameVersion(base, remote));
      const selected = choice && sameConflictDraft(choice, draft) ? choice.prefer : "";
      if (known) {
        const todayBase = alignToday(base.data, now);
        if (model.same(todayRemote, todayBase)) return { data: todayLocal };
        if (model.same(todayLocal, todayBase) || (todayBase === null && model.isEmpty(todayLocal))) {
          return { data: todayRemote };
        }
        const result = model.merge(todayBase, todayLocal, todayRemote, selected || "local");
        const unconfirmed = result.conflicts.some(({ id }) => (
          !selected || (typeof selected === "object" && !["local", "remote"].includes(selected[id]))
        ));
        if (unconfirmed) return { items: result.conflicts };
        return { data: result.data, confirmed: Boolean(selected) };
      }

      if (model.isEmpty(todayLocal)) return { data: todayRemote };
      if (model.isEmpty(todayRemote)) return { data: todayLocal };
      if (selected) return { data: selected === "local" ? todayLocal : todayRemote, confirmed: true };
      return { initial: true };
    }

    async function commitChoice(data, remote, local) {
      try {
        const written = parseServerState(await request("state", "PUT", { revision: remote.revision, data }));
        if (!model.same(localSnapshot(), local)) {
          rerun = true;
          show("确认期间本机有新更改，正在重新核对。", "待同步", "pending");
          return null;
        }
        if (!model.same(written.data, local)) applyLocal(written.data);
        conflict = null;
        await remember(written);
        showSynced();
        return null;
      } catch (error) {
        if (error?.status === 409) return parseServerState(error.payload);
        throw error;
      }
    }

    async function reconcile(remote, choice) {
      const pending = checkpoint.pending;
      if (pending && remote.revision > pending.revision && model.same(pending.data, remote.data)) {
        // A request whose reply was lost may already have reached the server.
        await remember(remote);
      }

      const local = localSnapshot();
      const now = new Date();
      const draft = { remote, local, base: checkpoint.base, day: window.Tracker.dailyCycleKey(now) };
      const plan = propose(remote, local, choice, draft, now);
      if (!plan.data) {
        const previous = conflict;
        if (!previous || !sameConflictDraft(previous, draft)) {
          conflict = { ...draft, initial: plan.initial, items: plan.items, picks: new Map() };
        } else if (plan.items?.some((item) => !previous.items?.some(({ id }) => id === item.id))) {
          conflict = { ...draft, initial: plan.initial, items: plan.items, picks: previous.picks };
        }
        const changed = previous && !sameConflictDraft(previous, draft);
        show(changed ? "记录已有新变化，请重新比对确认。" : "有需要确认的同步冲突。", "待确认", "conflict");
        return null;
      }

      if (plan.confirmed && !model.same(plan.data, remote.data)) return commitChoice(plan.data, remote, local);
      if (!model.same(plan.data, local)) applyLocal(plan.data);
      conflict = null;
      await remember(remote);
      const current = localSnapshot();
      if (remote.data === null ? model.isEmpty(current) : model.same(remote.data, current)) {
        showSynced();
        return null;
      }

      const sent = { revision: remote.revision, data: current };
      await remember(remote, sent);
      try {
        const written = parseServerState(await request("state", "PUT", sent));
        await remember(written);
        if (model.same(localSnapshot(), written.data)) showSynced();
        else {
          rerun = true;
          show("本机的新更改正在等待同步。", "待同步", "pending");
        }
        return null;
      } catch (error) {
        if (error?.status === 409) return parseServerState(error.payload);
        throw error;
      }
    }

    async function syncState(choice) {
      if (!checkpoint) checkpoint = await readCheckpoint();
      let remote = parseServerState(await request("state"));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stale = await reconcile(remote, choice);
        if (!stale) return;
        remote = stale;
        choice = null;
      }
      rerun = true;
      show("服务器正处理其他设备的更改，即将再试。", "待同步", "pending");
    }

    async function checkAndSync() {
      if (!authenticated) {
        const status = await request("status");
        if (typeof status?.authenticated !== "boolean") throw new SyncError("无法确认同步登录状态");
        authenticated = status.authenticated;
        statusKnown = true;
        setup = status.needsSetup === true ? { requiresSetupCode: status.requiresSetupCode === true } : null;
      }
      if (!authenticated) {
        conflict = null;
        if (setup) {
          showSetup();
        } else {
          setupForm.reset();
          showLocal();
        }
        return;
      }
      await syncState();
    }

    function stopTimer() {
      window.clearTimeout(timer);
      scheduledAt = Infinity;
    }

    function wake(delay = 0, urgent = false) {
      if (!isOnline()) {
        stopTimer();
        showOffline();
        return;
      }
      if (busy) {
        rerun = true;
        return;
      }
      const when = Math.max(Date.now() + delay, urgent ? 0 : nextRetryAt);
      if (when >= scheduledAt) return;
      stopTimer();
      scheduledAt = when;
      timer = window.setTimeout(() => {
        scheduledAt = Infinity;
        execute(checkAndSync);
      }, Math.max(0, when - Date.now()));
    }

    function failed(error, operation) {
      if (operation === "setup" && error?.status) {
        formMessage(setupMessage, error.message);
        if (error.status === 409) rerun = true;
        return;
      }
      if (operation === "password" && error?.status && error.status !== 401) {
        formMessage(passwordMessage, error.message);
        return;
      }
      if (error?.status === 401) {
        authenticated = false;
        changingPassword = false;
        passwordForm.reset();
        conflict = null;
        if (operation === "login") show("登录失败：" + error.message, "未登录", "error");
        else show("同步登录已失效，请重新输入密码。", "未登录", "local");
        return;
      }
      if (error instanceof LocalRecordError) {
        show(error.message, "本机存储异常", "error");
        return;
      }
      if (operation === "login" && error?.status) {
        show("登录失败：" + error.message, "未登录", "error");
        return;
      }
      retryDelay = retryDelay ? Math.min(retryDelay * 2, MAX_RETRY_DELAY) : POLL_DELAY;
      nextRetryAt = Date.now() + retryDelay;
      if (!isOnline()) showOffline();
      else if (error instanceof SyncError) show(error.message + "，稍后将重试。", "待重试", "error");
      else show("暂时无法连接同步服务，记录留在本机，稍后将重试。", "待重试", "offline");
    }

    async function execute(action, operation = "sync") {
      if (busy || !isOnline()) return;
      busy = true;
      stopTimer();
      render();
      try {
        await action();
        retryDelay = 0;
        nextRetryAt = 0;
      } catch (error) {
        failed(error, operation);
      } finally {
        busy = false;
        render();
        const delay = rerun ? EDIT_DELAY : POLL_DELAY;
        rerun = false;
        wake(delay);
      }
    }

    function openDialog() {
      if (!dialog.open) dialog.showModal();
    }

    function readSetupLink() {
      const code = new URLSearchParams(window.location.hash.slice(1)).get("setup");
      if (!code) return;
      setupCode.value = code;
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      openDialog();
    }

    function hidePasswordEditor() {
      changingPassword = false;
      passwordForm.reset();
      formMessage(passwordMessage, "");
    }

    byId("open-sync").addEventListener("click", openDialog);
    byId("sync-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      setupPassword.value = "";
      setupConfirm.value = "";
      loginForm.reset();
      hidePasswordEditor();
      formMessage(setupMessage, "");
      render();
    });
    setupForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const password = setupPassword.value;
      if (!setup || !password || busy || !isOnline()) return;
      if (password !== setupConfirm.value) {
        formMessage(setupMessage, "两次输入的密码不一致。");
        setupConfirm.focus();
        return;
      }
      formMessage(setupMessage, "");
      execute(async () => {
        const result = await request("setup", "POST", { password, setupCode: setupCode.value });
        acceptSession(result);
        setupForm.reset();
        show("同步密码已设置，正在读取服务器记录。", "同步中", "pending");
        rerun = true;
      }, "setup");
    });
    loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const password = passwordField.value;
      if (!password || busy || !isOnline()) return;
      passwordField.value = "";
      execute(async () => {
        show("正在登录同步。", "登录中", "pending");
        const result = await request("login", "POST", { password });
        acceptSession(result);
        show("已登录，正在读取服务器记录。", "同步中", "pending");
        await syncState();
      }, "login");
    });
    openPassword.addEventListener("click", () => {
      if (changingPassword) {
        hidePasswordEditor();
        render();
        return;
      }
      changingPassword = true;
      formMessage(passwordMessage, "");
      render();
      currentPassword.focus();
    });
    byId("sync-cancel-password").addEventListener("click", () => {
      hidePasswordEditor();
      render();
      openPassword.focus();
    });
    passwordForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const password = newPassword.value;
      if (!authenticated || !password || busy || !isOnline()) return;
      if (password !== confirmPassword.value) {
        formMessage(passwordMessage, "两次输入的新密码不一致。");
        confirmPassword.focus();
        return;
      }
      formMessage(passwordMessage, "");
      execute(async () => {
        const result = await request("password", "POST", { currentPassword: currentPassword.value, password });
        acceptSession(result);
        hidePasswordEditor();
        formMessage(passwordMessage, "同步密码已修改。其他设备需用新密码重新登录。", false);
        openPassword.focus();
      }, "password");
    });
    pullButton.addEventListener("click", () => {
      if (!conflict) show("正在检查服务器记录。", "同步中", "pending");
      wake(0, true);
    });
    logoutButton.addEventListener("click", () => {
      execute(async () => {
        await request("logout", "POST");
        authenticated = false;
        conflict = null;
        hidePasswordEditor();
        showLocal();
      }, "logout");
    });

    function choose(prefer) {
      if (!conflict) return;
      const choice = { ...conflict, prefer };
      execute(() => syncState(choice));
    }

    chooseLocal.addEventListener("click", () => choose("local"));
    chooseRemote.addEventListener("click", () => choose("remote"));
    applyChoices.addEventListener("click", () => {
      if (conflict?.items?.length && conflict.picks.size === conflict.items.length) {
        choose(Object.fromEntries(conflict.picks));
      }
    });
    window.addEventListener("focus", () => wake(0, true));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) wake(0, true);
    });
    window.addEventListener("online", () => {
      retryDelay = 0;
      nextRetryAt = 0;
      wake(0, true);
    });
    window.addEventListener("offline", () => {
      stopTimer();
      showOffline();
    });
    window.addEventListener("hashchange", readSetupLink);

    render();
    readSetupLink();
    wake();
    return {
      localChanged() {
        if (applying) return;
        if (authenticated && !conflict && isOnline() && !retryDelay) {
          show("本机的新更改正在等待同步。", "待同步", "pending");
        }
        wake(EDIT_DELAY);
      },
    };
  }

  window.JingheSync = { mount };
})();
