/*
 * To Regalo 云同步模块
 * 基于 GitHub Gist 实现跨设备/跨入口自动同步
 * 网页版和PWA版共用同一份云端数据
 */
(function () {
  "use strict";

  var GIST_ID = "0b601e352111c57fd3067a6afb43e227";
  var GIST_FILE = "data.json";
  var TOKEN_STORAGE_KEY = "mine.sync.githubToken";
  var LAST_SYNC_KEY = "mine.sync.lastSync";

  var state = {
    enabled: true,
    token: localStorage.getItem(TOKEN_STORAGE_KEY) || "",
    uploading: false,
    downloading: false,
    lastPush: 0,
    lastPull: 0
  };

  /* 防抖：避免频繁请求Gist */
  var pushTimer = null;
  function schedulePush(delay) {
    if (!state.enabled || !state.token) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushToCloud, delay || 3000);
  }

  /* 收集整个localStorage的数据 */
  function collectLocalData() {
    var data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      /* 不同步token本身和同步状态 */
      if (key === TOKEN_STORAGE_KEY || key === LAST_SYNC_KEY) continue;
      data[key] = localStorage.getItem(key);
    }
    return data;
  }

  /* 推送到云端 */
  function pushToCloud() {
    if (!state.enabled || !state.token || state.uploading) return;
    state.uploading = true;
    var now = Date.now();

    var data = collectLocalData();
    var payload = {
      version: "1.0.0",
      lastSync: now,
      keys: data
    };

    fetch("https://api.github.com/gists/" + GIST_ID, {
      method: "PATCH",
      headers: {
        "Authorization": "token " + state.token,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: {
          [GIST_FILE]: {
            content: JSON.stringify(payload)
          }
        }
      })
    }).then(function (r) {
      if (!r.ok) throw new Error("push failed: " + r.status);
      state.lastPush = now;
      localStorage.setItem(LAST_SYNC_KEY, String(now));
      console.log("[Sync] 推送成功", new Date(now).toLocaleTimeString());
    }).catch(function (e) {
      console.warn("[Sync] 推送失败", e);
    }).finally(function () {
      state.uploading = false;
    });
  }

  /* 从云端拉取 */
  function pullFromCloud() {
    if (!state.enabled || !state.token || state.downloading) return Promise.resolve();
    state.downloading = true;

    return fetch("https://api.github.com/gists/" + GIST_ID, {
      headers: {
        "Authorization": "token " + state.token,
        "Accept": "application/vnd.github.v3+json"
      }
    }).then(function (r) {
      if (!r.ok) throw new Error("pull failed: " + r.status);
      return r.json();
    }).then(function (gist) {
      var content = gist.files[GIST_FILE].content;
      var cloud = JSON.parse(content);
      if (!cloud || !cloud.keys) return;

      var localLast = parseInt(localStorage.getItem(LAST_SYNC_KEY) || "0");
      var cloudLast = cloud.lastSync || 0;

      /* 如果云端比本地新，就合并 */
      if (cloudLast > localLast) {
        console.log("[Sync] 云端数据更新，正在合并...");
        Object.keys(cloud.keys).forEach(function (key) {
          var cloudVal = cloud.keys[key];
          var localVal = localStorage.getItem(key);
          /* 如果本地没有，或者云端的更新时间更近，就用云端的 */
          if (localVal !== cloudVal) {
            localStorage.setItem(key, cloudVal);
          }
        });
        localStorage.setItem(LAST_SYNC_KEY, String(cloudLast));
        state.lastPull = cloudLast;
        console.log("[Sync] 同步完成", new Date(cloudLast).toLocaleString());
        /* 同步后刷新页面 */
        setTimeout(function () {
          location.reload();
        }, 500);
      } else {
        console.log("[Sync] 本地已是最新");
      }
    }).catch(function (e) {
      console.warn("[Sync] 拉取失败", e);
    }).finally(function () {
      state.downloading = false;
    });
  }

  /* 监听localStorage变化（跨标签页同步） */
  window.addEventListener("storage", function (e) {
    schedulePush(2000);
  });

  /* 初始化 */
  function init() {
    console.log("[Sync] 云同步已启动");
    /* 先拉取一次 */
    pullFromCloud();
    /* 每30秒自动拉取一次，检查有没有新数据 */
    setInterval(pullFromCloud, 30000);
    /* 监听所有localStorage变化，自动推送 */
    var origSet = localStorage.setItem;
    localStorage.setItem = function (key, val) {
      origSet.apply(localStorage, arguments);
      schedulePush(2000);
    };
    var origRemove = localStorage.removeItem;
    localStorage.removeItem = function (key) {
      origRemove.apply(localStorage, arguments);
      schedulePush(2000);
    };
  }

  /* 导出接口 */
  window.MineSync = {
    init: init,
    push: pushToCloud,
    pull: pullFromCloud,
    getState: function () { return Object.assign({}, state); }
  };

  /* 自动启动 */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
