(function (window) {
  "use strict";

  const CURRENCIES = {
    regular: { name: "铸纹币", gameId: 151 },
    season: { name: "金币", gameId: 183 },
  };
  const REFRESH_INTERVAL = 60 * 60 * 1000;
  const beijingDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const beijingTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const rate = new Intl.NumberFormat("zh-CN", {
    useGrouping: false,
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });

  function today() {
    const parts = Object.fromEntries(beijingDate.formatToParts(new Date()).map(({ type, value }) => [type, value]));
    return parts.year + "-" + parts.month + "-" + parts.day;
  }

  function formatRatio(value) {
    return value < 0.00005 ? value.toPrecision(4) : rate.format(value);
  }

  function mount() {
    const title = document.getElementById("market-title");
    const source = document.getElementById("market-source");
    const result = document.getElementById("market-result");
    const unitRatio = document.getElementById("market-unit-ratio");
    const ratio = document.getElementById("market-ratio");
    const status = document.getElementById("market-status");
    const retry = document.getElementById("market-retry");
    const snapshots = new Map();
    let selectedServer;
    let activeRequest;
    let nextRefresh = 0;

    function setStatus(text, retryable = false) {
      if (status.textContent !== text) status.textContent = text;
      retry.hidden = !retryable;
    }

    function currentSnapshot() {
      const snapshot = snapshots.get(selectedServer);
      return snapshot?.date === today() ? snapshot : null;
    }

    function clearQuotes() {
      result.hidden = true;
      unitRatio.textContent = "";
      ratio.textContent = "";
    }

    function lastCheck(snapshot) {
      const date = snapshot.date === today() ? "" : snapshot.date + " ";
      return "上次检查 " + date + beijingTime.format(new Date(snapshot.checkedAt));
    }

    function showQuotes(snapshot) {
      const [latest] = snapshot.quotes;
      const labels = [];
      if (latest) {
        result.hidden = false;
        unitRatio.textContent = "1万个=" + formatRatio(1 / latest.perYuan) + "元";
        ratio.textContent = "1元=" + formatRatio(latest.perYuan) + "万个";
        labels.push("挂单更新 " + beijingTime.format(new Date(latest.updatedAt)));
      } else {
        clearQuotes();
        labels.push("今天暂无有效报价");
      }
      labels.push(lastCheck(snapshot) + "（北京时间）");
      if (snapshot.stale) labels.push("暂未刷新");
      setStatus(labels.join(" · "), snapshot.stale);
    }

    async function refresh() {
      const server = selectedServer;
      const cached = currentSnapshot();
      activeRequest?.abort();
      const controller = new AbortController();
      activeRequest = controller;
      if (cached) showQuotes(cached);
      else {
        clearQuotes();
        setStatus("正在获取报价…");
      }
      retry.disabled = true;
      const timer = window.setTimeout(() => controller.abort(), 20000);
      try {
        const response = await window.fetch("/api/market/quotes?server=" + server, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Quote request failed");
        const data = await response.json();
        if (activeRequest !== controller) return;
        if (data.server !== server || data.currency !== CURRENCIES[server].name ||
            data.date !== today() || typeof data.checkedAt !== "string" ||
            !Number.isFinite(Date.parse(data.checkedAt)) || !Array.isArray(data.quotes)) {
          throw new Error("Invalid quote response");
        }
        showQuotes(data);
        snapshots.set(server, data);
      } catch {
        if (activeRequest !== controller) return;
        const fallback = currentSnapshot();
        if (fallback) {
          const stale = { ...fallback, stale: true };
          snapshots.set(server, stale);
          showQuotes(stale);
        } else {
          clearQuotes();
          const previous = snapshots.get(server);
          setStatus(previous ? lastCheck(previous) + "（北京时间） · 暂未刷新" : "暂时无法获取报价。", true);
        }
      } finally {
        window.clearTimeout(timer);
        if (activeRequest === controller) {
          activeRequest = null;
          retry.disabled = false;
          nextRefresh = Date.now() + REFRESH_INTERVAL;
        }
      }
    }

    function refreshWhenDue() {
      if (!selectedServer || activeRequest || document.hidden) return;
      const previous = snapshots.get(selectedServer);
      if (Date.now() >= nextRefresh || (previous && previous.date !== today())) void refresh();
    }

    retry.addEventListener("click", () => { void refresh(); });
    document.addEventListener("visibilitychange", refreshWhenDue);
    window.addEventListener("online", () => {
      if (selectedServer && !activeRequest) void refresh();
    });
    window.setInterval(refreshWhenDue, 60000);

    return {
      selectServer(server) {
        if (server === selectedServer) return;
        selectedServer = server;
        const currency = CURRENCIES[server];
        title.textContent = "今日" + currency.name + "比例";
        source.href = "https://www.hk1686.com/wares/?gameId=" + currency.gameId + "&goodsTypeId=51";
        void refresh();
      },
    };
  }

  window.JingheMarket = { mount };
})(window);
