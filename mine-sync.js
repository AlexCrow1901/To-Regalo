/*
 * To Regalo 云同步模块
 * 基于 GitHub Gist 实现跨设备/跨入口自动同步
 * 网页版和PWA版共用同一份云端数据
 */
(function () {
  "use strict";

  var GIST_ID_STORAGE_KEY = "mine.sync.gistId";
  var GIST_FILE = "data.json";
  var TOKEN_STORAGE_KEY = "mine.sync.githubToken";
  var LAST_SYNC_KEY = "mine.sync.lastSync";

  var state = {
    enabled: true,
    gistId: localStorage.getItem(GIST_ID_STORAGE_KEY) || "",
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

    fetch("https://api.github.com/gists/" + state.gistId, {
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

  /* 弹出配置框 */
  function showConfigDialog() {
    if (state.token && state.gistId) return;
    var dialog = document.createElement("div");
    dialog.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;";
    dialog.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:24px;max-width:400px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,0.2);">
        <h3 style="margin:0 0 12px;font-size:18px;">云同步配置</h3>
        <p style="margin:0 0 16px;color:#666;font-size:14px;line-height:1.5;">填写你的GitHub Gist ID和Token，开启跨设备同步</p>
        <input type="text" id="sync-gistid-input" placeholder="Gist ID" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;margin-bottom:12px;" value="${state.gistId || ''}" />
        <input type="text" id="sync-token-input" placeholder="GitHub Token" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;margin-bottom:12px;" value="${state.token || ''}" />
        <button id="sync-save-btn" style="width:100%;padding:12px;background:#333;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;">保存并开启同步</button>
      </div>
    `;
    document.body.appendChild(dialog);
    document.getElementById("sync-save-btn").onclick = function () {
      var gistId = document.getElementById("sync-gistid-input").value.trim();
      var token = document.getElementById("sync-token-input").value.trim();
      if (gistId && token) {
        localStorage.setItem(GIST_ID_STORAGE_KEY, gistId);
        localStorage.setItem(TOKEN_STORAGE_KEY, token);
        state.gistId = gistId;
        state.token = token;
        dialog.remove();
        location.reload();
      }
    };
  }

  /* 初始化 */
  function init() {
    console.log("[Sync] 云同步已启动");
    /* 没有token就弹出配置框 */
    setTimeout(showConfigDialog, 500);
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
