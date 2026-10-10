/* ========================================================================
   Mine · 文件管理（数据导出 / 清除 / 存储扩容）
   ======================================================================== */

window.MineFiles = (function () {
  "use strict";

  var I = window.MineIcons;

  /* ---------------- 模块注册表（与各模块存储键一一对应） ---------------- */
  var MODULES = [
    { key: "me",       name: "个人中心",   icon: "me",        keys: ["mine.me.v1"] },
    { key: "contacts", name: "通讯录",     icon: "contacts",  keys: ["mine.contacts.v1", "mine.contacts.lastShuffle"] },
    { key: "chat",     name: "聊天",       icon: "chat",      keys: ["mine.chat.v1", "mine.chat.unread.v1", "mine.chat.bg.v1", "mine.chat.fontColor.v1", "mine.chat.choices.v1"] },
    { key: "cards",    name: "字卡",       icon: "feather",   keys: ["mine.cards.v1"] },
    { key: "moments",  name: "朋友圈",     icon: "moments",   keys: ["mine.moments.v1", "mine.moments.cover", "mine.moments.contactInteractions"] },
    { key: "phone",    name: "通话记录",   icon: "phone",     keys: ["mine.phone.log.v1"] },
    { key: "mail",     name: "次元信箱",   icon: "mail",      keys: ["mine.mail.v1", "mine.mail.pending.v1", "mine.mail.active.v1", "mine.mail.activecheck.v1"] },
    { key: "treehole", name: "深夜树洞",   icon: "feather",   keys: ["mine.treehole.v2", "mine.treehole.verify.v1", "mine.treehole.pending.v2", "mine.treehole.templates.v1", "mine.treehole.seenCount.v1"] },
    { key: "radio",    name: "心情电台",   icon: "music",     keys: ["mine.radio.v1", "mine.radio.mode.v1"] },
    { key: "foodie",   name: "雾都觅食",   icon: "utensils",  keys: ["mine.foodie.v1"] },
    { key: "theme",    name: "背景与主题", icon: "background", keys: ["mine.bg.v1", "mine.theme.v1"] },
    { key: "notify",   name: "通知记录",   icon: "bell",      keys: ["mine.notify.lastSeen.v1"] }
  ];

  /* ---------------- 工具函数 ---------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function sizeOf(str) {
    try { return new Blob([String(str || "")]).size; }
    catch (e) { return String(str || "").length * 2; }
  }
  function fmtBytes(n) {
    n = Math.max(0, Math.floor(n || 0));
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }
  function collectAll() {
    var all = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf("mine.") !== 0) continue;
        all[k] = localStorage.getItem(k);
      }
    } catch (e) {}
    return all;
  }
  function moduleData(mod) {
    var out = {};
    mod.keys.forEach(function (k) {
      var v = null;
      try { v = localStorage.getItem(k); } catch (e) {}
      if (v != null) out[k] = v;
    });
    return out;
  }
  function moduleSize(mod) {
    var data = moduleData(mod);
    var bytes = 0, count = 0;
    Object.keys(data).forEach(function (k) { bytes += sizeOf(k) + sizeOf(data[k]); count++; });
    return { bytes: bytes, count: count };
  }
  function otherKeys() {
    var all = collectAll();
    var known = {};
    MODULES.forEach(function (m) { m.keys.forEach(function (k) { known[k] = true; }); });
    var extra = {};
    Object.keys(all).forEach(function (k) { if (!known[k]) extra[k] = all[k]; });
    return extra;
  }

  /* ---------------- Toast ---------------- */
  var toastTimer = null;
  function showToast(msg) {
    var el = document.querySelector(".phone-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "phone-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("is-show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("is-show"); }, 2400);
  }

  /* ---------------- 导出下载 ---------------- */
  function downloadJSON(filename, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 300);
  }
  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }
  function buildBackup(modules) {
    return { app: "Mine", format: 1, exportedAt: new Date().toISOString(), modules: modules };
  }
  function exportAll() {
    var mods = {};
    MODULES.forEach(function (m) {
      var d = moduleData(m);
      if (Object.keys(d).length) mods[m.name] = d;
    });
    var extra = otherKeys();
    if (Object.keys(extra).length) mods["其他"] = extra;
    if (Object.keys(mods).length === 0) { showToast("暂无数据可导出"); return; }
    downloadJSON("mine-backup-" + stamp() + ".json", buildBackup(mods));
    showToast("已导出全部数据备份");
  }
  function exportModule(mod) {
    var d = moduleData(mod);
    if (Object.keys(d).length === 0) { showToast("「" + mod.name + "」暂无数据"); return; }
    var single = {}; single[mod.name] = d;
    downloadJSON("mine-" + mod.key + "-" + stamp() + ".json", buildBackup(single));
    showToast("已导出「" + mod.name + "」");
  }

  /* ---------------- 导入（所有可导出项均可导入） ---------------- */
  function openFilePicker(onRead) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try { onRead(String(reader.result)); }
        catch (e) { showToast("导入失败：" + (e && e.message ? e.message : "解析错误")); }
      };
      reader.onerror = function () { showToast("读取文件失败"); };
      reader.readAsText(file);
    });
    input.click();
  }
  function parseBackup(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return { error: "文件不是有效的 JSON" }; }
    if (!data || data.app !== "Mine" || !data.modules || typeof data.modules !== "object") {
      return { error: "不是 Mine 备份文件（缺少 modules 字段）" };
    }
    return { data: data };
  }
  function afterImport() {
    renderPage();
    setTimeout(function () { location.reload(); }, 1200);
  }
  function importModule(mod) {
    openFilePicker(function (text) {
      var parsed = parseBackup(text);
      if (parsed.error) { showToast(parsed.error); return; }
      var entries = parsed.data.modules[mod.name] || {};
      var applied = 0;
      mod.keys.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(entries, k)) {
          try { localStorage.setItem(k, entries[k]); applied++; } catch (e) {}
        }
      });
      if (!applied) { showToast("备份中未找到「" + mod.name + "」的数据"); return; }
      showToast("已导入「" + mod.name + "」" + applied + " 项，正在刷新…");
      afterImport();
    });
  }
  function importAll() {
    openFilePicker(function (text) {
      var parsed = parseBackup(text);
      if (parsed.error) { showToast(parsed.error); return; }
      var known = {};
      MODULES.forEach(function (m) { m.keys.forEach(function (k) { known[k] = true; }); });
      var applied = 0;
      Object.keys(parsed.data.modules).forEach(function (modName) {
        var entries = parsed.data.modules[modName];
        if (!entries || typeof entries !== "object") return;
        Object.keys(entries).forEach(function (k) {
          if (modName === "其他" || known[k]) {
            try { localStorage.setItem(k, entries[k]); applied++; } catch (e) {}
          }
        });
      });
      if (!applied) { showToast("备份中未找到可导入的数据"); return; }
      showToast("已导入 " + applied + " 项数据，正在刷新…");
      afterImport();
    });
  }

  /* ---------------- 清除（二次确认 sheet） ---------------- */
  function confirmSheet(title, descHtml, okText, onOk) {
    var ov = document.createElement("div");
    ov.className = "sheet-overlay";
    ov.innerHTML =
      '<div class="sheet">' +
        '<div class="sheet-handle"></div>' +
        '<div class="sheet-head"><h2>' + esc(title) + '</h2>' +
        '<button class="sheet-close" data-close="1">' + I.svg("close", 20) + '</button></div>' +
        '<div class="sheet-body">' +
          '<div class="phone-reserved">' +
            '<div class="phone-reserved-desc" style="margin-bottom:14px;">' + descHtml + '</div>' +
            '<button class="btn btn-primary" data-confirm="1" style="width:100%;">' + esc(okText) + '</button>' +
            '<button class="btn" data-close="1" style="width:100%;margin-top:8px;">取消</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function () {
      ov.classList.add("is-open");
      var sheet = ov.querySelector(".sheet");
      if (sheet) sheet.classList.add("is-open");
    });
    function close() {
      ov.classList.remove("is-open");
      setTimeout(function () { ov.remove(); }, 300);
    }
    ov.addEventListener("click", function (e) {
      var t = e.target;
      var closeHit = (t === ov) || (t && t.closest && t.closest("[data-close]"));
      if (closeHit) { close(); return; }
      var okHit = t && t.closest && t.closest("[data-confirm]");
      if (okHit) { close(); onOk(); }
    });
  }
  function removeKeys(keys) {
    keys.forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
    });
  }
  function clearModule(mod) {
    var d = moduleData(mod);
    var n = Object.keys(d).length;
    if (n === 0) { showToast("「" + mod.name + "」本就没有数据"); return; }
    confirmSheet(
      "清除「" + mod.name + "」？",
      "将删除该模块下 <b>" + n + "</b> 项本地数据，不可恢复。<br>建议先导出备份。",
      "确认清除",
      function () {
        removeKeys(mod.keys);
        showToast("已清除「" + mod.name + "」，刷新页面后生效");
        renderPage();
      }
    );
  }
  function clearAll() {
    var all = collectAll();
    var n = Object.keys(all).length;
    if (n === 0) { showToast("当前没有任何数据"); return; }
    confirmSheet(
      "清空全部 Mine 数据？",
      "<b>危险操作</b>：将删除本机全部 " + n + " 项 Mine 数据（聊天 / 联系人 / 个人中心等），<br>不可恢复。<br><br>建议先点上方「一键导出全部数据」备份。",
      "全部删除",
      function () {
        var keys = Object.keys(all);
        removeKeys(keys);
        showToast("已清空全部数据，2 秒后刷新…");
        setTimeout(function () { location.reload(); }, 2000);
      }
    );
  }

  /* ---------------- 存储容量 / 持久化 ---------------- */
  function refreshQuota() {
    var usageEl = document.getElementById("fs-usage");
    var quotaEl = document.getElementById("fs-quota");
    if (!usageEl) return;
    var all = collectAll();
    var mineBytes = 0;
    Object.keys(all).forEach(function (k) { mineBytes += sizeOf(k) + sizeOf(all[k]); });
    usageEl.textContent = fmtBytes(mineBytes) + "（Mine 数据）";
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        if (quotaEl) {
          quotaEl.textContent = "浏览器已用 " + fmtBytes(est.usage || 0) +
            " / 配额约 " + fmtBytes(est.quota || 0) +
            " · IndexedDB 大容量引擎";
        }
      }).catch(function () {
        if (quotaEl) quotaEl.textContent = "IndexedDB 大容量引擎 · 配额读取失败";
      });
    } else {
      if (quotaEl) quotaEl.textContent = "当前浏览器不支持容量查询 · IndexedDB 大容量引擎";
    }
    var pTitle = document.getElementById("fs-persist-title");
    var pSub = document.getElementById("fs-persist-sub");
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (persisted) {
        if (pTitle) pTitle.textContent = persisted ? "持久化存储：已开启" : "申请持久化存储";
        if (pSub) pSub.textContent = persisted
          ? "浏览器不会自动清理本网站数据，容量更有保障"
          : "申请后浏览器尽量保留数据，不自动清理";
      });
    }
  }
  function requestPersist() {
    if (!navigator.storage || !navigator.storage.persist) {
      showToast("当前浏览器不支持持久化存储");
      return;
    }
    navigator.storage.persist().then(function (ok) {
      showToast(ok ? "持久化存储已开启" : "浏览器暂未批准，可稍后重试");
      refreshQuota();
    }).catch(function () { showToast("申请失败，请稍后再试"); });
  }

  /* ---------------- 渲染页面 ---------------- */
  function renderPage() {
    var detail = document.getElementById("page-detail");
    if (!detail) return;
    var rowsHtml = "";
    MODULES.forEach(function (mod) {
      var s = moduleSize(mod);
      var sizeText = s.count > 0 ? (fmtBytes(s.bytes) + " · " + s.count + " 项") : "空";
      rowsHtml +=
        '<div class="func-row" style="align-items:center;">' +
          '<div class="func-icon">' + I.svg(mod.icon, 20) + '</div>' +
          '<div class="func-text" style="flex:1;">' +
            '<span class="func-title">' + esc(mod.name) + '</span>' +
            '<span class="func-sub">' + sizeText + '</span>' +
          '</div>' +
          '<button class="fs-mini-btn" data-act="import-mod" data-mod="' + mod.key + '" title="导入' + esc(mod.name) + '">' + I.svg("upload", 16) + '</button>' +
          '<button class="fs-mini-btn" data-act="export-mod" data-mod="' + mod.key + '" title="导出' + esc(mod.name) + '">' + I.svg("download", 16) + '</button>' +
          '<button class="fs-mini-btn is-danger" data-act="clear-mod" data-mod="' + mod.key + '" title="清除' + esc(mod.name) + '">' + I.svg("trash", 16) + '</button>' +
        '</div>';
    });
    var html =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">文件</span>' +
        '<span class="nav-right"></span>' +
      '</div>' +
      '<div class="scroll">' +
        '<div class="group-head">存储容量</div>' +
        '<div class="func-row">' +
          '<div class="func-icon">' + I.svg("files", 20) + '</div>' +
          '<div class="func-text">' +
            '<span class="func-title" id="fs-usage">统计中…</span>' +
            '<span class="func-sub" id="fs-quota">配额统计中…</span>' +
          '</div>' +
        '</div>' +
        '<div class="func-row" data-act="persist">' +
          '<div class="func-icon">' + I.svg("shield", 20) + '</div>' +
          '<div class="func-text">' +
            '<span class="func-title" id="fs-persist-title">申请持久化存储</span>' +
            '<span class="func-sub" id="fs-persist-sub">防止浏览器自动清理，容量更大更稳</span>' +
          '</div>' +
          '<span class="chevron">' + I.svg("back", 18) + '</span>' +
        '</div>' +
        '<div class="list-sep"></div>' +
        '<div class="group-head">数据导入 · 导出 · 清除</div>' +
        '<div class="func-row" data-act="import-all" style="background:rgba(150,170,190,0.10);">' +
          '<div class="func-icon" style="color:#9fb6c9;">' + I.svg("upload", 20) + '</div>' +
          '<div class="func-text">' +
            '<span class="func-title">一键导入全部数据</span>' +
            '<span class="func-sub">选择 Mine 备份 JSON，恢复下列所有模块</span>' +
          '</div>' +
          '<span class="chevron">' + I.svg("back", 18) + '</span>' +
        '</div>' +
        '<div class="func-row" data-act="export-all" style="background:rgba(150,170,190,0.10);">' +
          '<div class="func-icon" style="color:#9fb6c9;">' + I.svg("download", 20) + '</div>' +
          '<div class="func-text">' +
            '<span class="func-title">一键导出全部数据</span>' +
            '<span class="func-sub">下载 JSON 备份（含下列所有模块）</span>' +
          '</div>' +
          '<span class="chevron">' + I.svg("back", 18) + '</span>' +
        '</div>' +
        rowsHtml +
        '<div class="list-sep"></div>' +
        '<div class="group-head">危险操作</div>' +
        '<div class="func-row" data-act="clear-all" style="color:#c98a8a;">' +
          '<div class="func-icon">' + I.svg("trash", 20) + '</div>' +
          '<div class="func-text">' +
            '<span class="func-title">清空全部 Mine 数据</span>' +
            '<span class="func-sub">删除所有模块数据，不可恢复（先导出备份！）</span>' +
          '</div>' +
          '<span class="chevron">' + I.svg("back", 18) + '</span>' +
        '</div>' +
        '<div class="card-hint" style="margin:14px 16px 30px;">' +
          '数据保存在本机浏览器（IndexedDB 大容量引擎，配额可达数百 MB）。<br>' +
          '「清除」后需刷新页面才完全生效；「清空」将自动刷新。' +
        '</div>' +
      '</div>';
    detail.innerHTML = html;
    var style = document.getElementById("fs-mini-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "fs-mini-style";
      style.textContent =
        ".fs-mini-btn{width:34px;height:34px;margin-left:8px;border-radius:10px;border:1px solid rgba(160,180,200,0.18);" +
        "background:rgba(150,170,190,0.08);color:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer;}" +
        ".fs-mini-btn.is-danger{color:#c98a8a;}" +
        ".fs-mini-btn:active{transform:scale(0.94);}";
      document.head.appendChild(style);
    }
    bindEvents(detail);
    refreshQuota();
  }

  function findMod(key) {
    for (var i = 0; i < MODULES.length; i++) if (MODULES[i].key === key) return MODULES[i];
    return null;
  }
  function bindEvents(pageEl) {
    var backBtn = pageEl.querySelector('[data-act="back"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      if (window.MineApp && MineApp.goHome) MineApp.goHome();
    });
    pageEl.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var exportModBtn = t.closest('[data-act="export-mod"]');
      if (exportModBtn) {
        e.stopPropagation();
        var mod = findMod(exportModBtn.getAttribute("data-mod"));
        if (mod) exportModule(mod);
        return;
      }
      var importModBtn = t.closest('[data-act="import-mod"]');
      if (importModBtn) {
        e.stopPropagation();
        var im = findMod(importModBtn.getAttribute("data-mod"));
        if (im) importModule(im);
        return;
      }
      var clearModBtn = t.closest('[data-act="clear-mod"]');
      if (clearModBtn) {
        e.stopPropagation();
        var m2 = findMod(clearModBtn.getAttribute("data-mod"));
        if (m2) clearModule(m2);
        return;
      }
      var exportAllRow = t.closest('[data-act="export-all"]');
      if (exportAllRow) { exportAll(); return; }
      var importAllRow = t.closest('[data-act="import-all"]');
      if (importAllRow) { importAll(); return; }
      var persistRow = t.closest('[data-act="persist"]');
      if (persistRow) { requestPersist(); return; }
      var clearAllRow = t.closest('[data-act="clear-all"]');
      if (clearAllRow) { clearAll(); return; }
    });
  }

  return { renderPage: renderPage, exportAll: exportAll, clearAll: clearAll };
})();
