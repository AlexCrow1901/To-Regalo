/* ========================================================================
   Mine · 全局通知系统
   ------------------------------------------------------------------------
   功能：
   · 统一管理各模块的未读通知计数
   · 在主屏图标、Dock 图标、陪伴页卡片上显示通知角标
   · 角标设计：左上角、象牙白楷体数字、无边框
   · 各模块通过 register() 注册未读计数 provider
   接入：app.js 渲染图标时调用 MineNotify.badgeHTML(id)
         各模块有新消息时调用 MineNotify.refreshBadges()
   ======================================================================== */

window.MineNotify = (function () {
  "use strict";

  var providers = {};        // { "chat": function() → number, "mail": ..., ... }
  var seenCallbacks = {};   // { "chat": function() → void, ... }
  var LAST_SEEN_KEY = "mine.notify.lastSeen.v1";
  var lastSeen = {};         // { "chat": timestamp, "moments": timestamp, ... }

  /* ---------------- 持久化 ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(LAST_SEEN_KEY);
      if (raw) lastSeen = JSON.parse(raw) || {};
    } catch (e) {}
    if (!lastSeen) lastSeen = {};
  }
  function save() {
    try { localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(lastSeen)); } catch (e) {}
  }

  /* ---------------- 注册 provider ----------------
     id:       模块标识（如 "chat", "companion", "moments"）
     provider: function() → 返回当前未读数
     onSeen:   function() → 用户查看时清除未读（可选）
  */
  function register(id, provider, onSeen) {
    providers[id] = provider;
    if (onSeen) seenCallbacks[id] = onSeen;
  }

  /* ---------------- 获取未读数 ---------------- */
  function getCount(id) {
    if (providers[id]) {
      try { return providers[id]() || 0; } catch (e) { return 0; }
    }
    return 0;
  }

  /* ---------------- 获取总未读数 ---------------- */
  function getTotal() {
    var total = 0;
    Object.keys(providers).forEach(function (id) {
      total += getCount(id);
    });
    return total;
  }

  /* ---------------- 标记已查看 ----------------
     记录时间戳，并调用模块的清除回调
     最后刷新所有角标 DOM
  */
  function markSeen(id) {
    lastSeen[id] = Date.now();
    save();
    if (seenCallbacks[id]) {
      try { seenCallbacks[id](); } catch (e) {}
    }
    refreshBadges();
  }
  function getLastSeen(id) {
    return lastSeen[id] || 0;
  }

  /* ---------------- 工具 ---------------- */
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---------------- 生成角标 HTML ----------------
     始终生成角标元素（count 为 0 时隐藏），确保 refreshBadges 可以后续显示
  */
  function badgeHTML(id) {
    var count = getCount(id);
    var num = count > 99 ? '99+' : String(count);
    var style = count <= 0 ? ' style="display:none"' : '';
    return '<span class="notify-badge" data-notify="' + id + '"' + style + '>' + escapeHtml(num) + '</span>';
  }

  /* ---------------- 刷新所有角标 DOM ---------------- */
  function refreshBadges() {
    document.querySelectorAll(".notify-badge").forEach(function (el) {
      var appId = el.getAttribute("data-notify");
      if (!appId) return;
      var count = getCount(appId);
      if (count > 0) {
        el.textContent = count > 99 ? '99+' : String(count);
        el.style.display = "";
      } else {
        el.style.display = "none";
      }
    });
  }

  /* ---------------- 初始化 ---------------- */
  load();

  /* 定期刷新角标（5 秒） */
  setInterval(function () { refreshBadges(); }, 5000);

  return {
    register: register,
    getCount: getCount,
    getTotal: getTotal,
    markSeen: markSeen,
    getLastSeen: getLastSeen,
    badgeHTML: badgeHTML,
    refreshBadges: refreshBadges,
    load: load
  };
})();
