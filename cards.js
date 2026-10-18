/* ========================================================================
   Mine · 字卡管理（我的字卡 + 系统字卡）
   ------------------------------------------------------------------------
   · 公用字卡：所有联系人均可使用
   · 单独字卡：仅供指定联系人使用（通讯录联系人直接列出，点击姓名即可添加）
   · 系统字卡：系统预置 / 用户自建，所有联系人均可使用（独立发送概率）
   · 字卡类型：字符 / emoji / 图片 / 语音，每一栏一种类型，点击栏头折叠/展开
   · 数据存储于 localStorage "mine.cards.v1"：
       { public: [card...], per: { cid: [card...] }, autoPer: { cid: [card...] }, sys: [card...] }
       · public / per / sys：普通回复字卡池
       · autoPer：单独"自动回复"字卡（仅触发自动回复时使用）
   · 聊天回复逻辑（chat.js）：getReplyPool(contactId) 返回 单独+公用 字卡池，
     系统字卡通过 getSysCards() 单独读取并按"系统字卡发送概率"抽取，
     自动回复场景通过 getAutoCards(contactId) 优先读取单独自动回复字卡。
   ======================================================================== */

window.MineCards = (function () {
  "use strict";

  var I = window.MineIcons;
  var U = window.MineUtils;
  var C = window.MineContacts;
  var STORE_KEY = "mine.cards.v1";

  var state = { public: [], per: {}, autoPer: {}, sys: [], sysAllOn: true, sysOff: {}, cardAt: {} };
  var expandedTypes = { text: true, emoji: true, image: true, audio: false, auto: true };  // 类型栏折叠状态
  var expandedMore = {};   // 大列表"显示更多"展开状态（按 scope:cid:type 记忆）

  /* ==================== 字卡类型判断（与 chat.js 保持同一套规则） ==================== */
  function isImageCard(card) {
    return typeof card === "string" && card.indexOf("data:image/") === 0;
  }
  function isAudioCard(card) {
    return typeof card === "string" && card.indexOf("data:audio/") === 0;
  }
  function isEmojiCard(card) {
    if (typeof card !== "string" || card.length === 0) return false;
    if (isImageCard(card)) return false;
    var stripped = card.replace(/[\uFE0F\u200D\u200C\u2640\u2642\u20E3\uFE0E]/g, "");
    var chars = Array.from(stripped);
    if (chars.length === 0 || chars.length > 4) return false;
    return chars.every(function (ch) {
      var code = ch.codePointAt(0);
      return (code >= 0x1F300 && code <= 0x1FAFF) ||
             (code >= 0x2600 && code <= 0x27BF) ||
             (code >= 0x2B50 && code <= 0x2BFF) ||
             (code >= 0x2300 && code <= 0x23FF);
    });
  }

  /* ==================== 持久化 ==================== */
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        state.public = Array.isArray(d.public) ? d.public : [];
        state.per = (d.per && typeof d.per === "object") ? d.per : {};
        state.sys = Array.isArray(d.sys) ? d.sys : [];
        state.autoPer = (d.autoPer && typeof d.autoPer === "object") ? d.autoPer : {};
        state.sysAllOn = d.sysAllOn === false ? false : true;
        state.sysOff = (d.sysOff && typeof d.sysOff === "object") ? d.sysOff : {};
        state.cardAt = (d.cardAt && typeof d.cardAt === "object") ? d.cardAt : {};
      }
    } catch (e) {}
    if (!Array.isArray(state.public)) state.public = [];
    if (!state.per || typeof state.per !== "object") state.per = {};
    if (!Array.isArray(state.sys)) state.sys = [];
    if (!state.autoPer || typeof state.autoPer !== "object") state.autoPer = {};
    if (state.sysAllOn !== false) state.sysAllOn = true;
    if (!state.sysOff || typeof state.sysOff !== "object") state.sysOff = {};
  }

  /* ==================== 数据读写 ==================== */
  function getPublicCards() { return state.public.slice(); }
  function getPerCards(cid) {
    return (cid && state.per[cid]) ? state.per[cid].slice() : [];
  }
  /* 系统字卡（所有联系人可用，独立发送概率）——按开关过滤：总开关关闭返回空，单张关闭的不参与 */
  function getSysCards() {
    if (state.sysAllOn === false) return [];
    return state.sys.filter(function (c) { return !state.sysOff[c]; });
  }
  /* 系统字卡总开关 */
  function getSysAllOn() { return state.sysAllOn !== false; }
  function setSysAllOn(on) { state.sysAllOn = !!on; save(); }
  /* 单张系统字卡开关 */
  function isSysCardOn(card) { return getSysAllOn() && !state.sysOff[card]; }
  function setSysCardOn(card, on) {
    if (card === undefined || card === null) return;
    if (on) {
      if (state.sysOff[card]) { delete state.sysOff[card]; save(); }
    } else {
      if (!state.sysOff[card]) { state.sysOff[card] = true; save(); }
    }
  }
  /* 聊天回复使用的字卡池：单独字卡(该联系人) + 我的字卡（公用 + 系统预设已合并，
     系统字卡由 chat.js 统一从此池随机，不再单独抽取） */
  function getReplyPool(cid) {
    var pool = [];
    if (cid && state.per[cid] && state.per[cid].length) {
      pool = pool.concat(state.per[cid]);
    }
    if (state.public.length) pool = pool.concat(state.public);
    var sysOn = getSysCards();
    if (sysOn.length) pool = pool.concat(sysOn);
    return pool;
  }
  function hasAnyCards() {
    return state.public.length > 0 || getSysCards().length > 0 || Object.keys(state.per).some(function (k) {
      return state.per[k] && state.per[k].length > 0;
    });
  }

  /* ==================== 排序 / 去重 / 批量 ==================== */
  /** 字卡排序：图片/语音 → 最末；emoji → 次末；文本按首字母 A-Z（中文按拼音） */
  function compareCards(a, b) {
    var ia = isImageCard(a) || isAudioCard(a);
    var ib = isImageCard(b) || isAudioCard(b);
    if (ia && ib) return 0;
    if (ia) return 1;
    if (ib) return -1;
    var ea = isEmojiCard(a), eb = isEmojiCard(b);
    if (ea && eb) return String(a).localeCompare(String(b));
    if (ea) return 1;
    if (eb) return -1;
    return String(a).localeCompare(String(b), "zh-Hans-CN", { sensitivity: "base", numeric: true });
  }
  function sortList(list) {
    try { list.sort(compareCards); } catch (e) {}
    return list;
  }
  /** 单条添加：自动去重 + 排序 + 保存 + 记录添加日期 */
  function addTo(list, v) {
    v = String(v || "").trim();
    if (!v) return false;
    if (list.indexOf(v) >= 0) return false;  // 自动去重
    list.push(v);
    sortList(list);
    state.cardAt[v] = Date.now();
    save();
    return true;
  }
  /** 批量添加（按空格拆分），返回 { added, skipped } */
  function addMany(list, raw) {
    var parts = String(raw || "").split(/\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length === 0) return { added: 0, skipped: 0 };
    var added = 0, skipped = 0;
    parts.forEach(function (p) {
      if (addTo(list, p)) added++; else skipped++;
    });
    return { added: added, skipped: skipped };
  }
  /** 按作用域取存储数组 */
  function listFor(scope, cid) {
    if (scope === "public") return state.public;
    if (scope === "sys") return state.sys;
    if (scope === "auto") {
      if (!state.autoPer[cid]) state.autoPer[cid] = [];
      return state.autoPer[cid];
    }
    if (scope === "per") {
      if (!state.per[cid]) state.per[cid] = [];
      return state.per[cid];
    }
    return null;
  }
  /** 修改指定字卡（自动去重 + 排序） */
  function updateCard(scope, cid, idx, newVal) {
    var list = listFor(scope, cid);
    if (!list || idx < 0 || idx >= list.length) return false;
    newVal = String(newVal || "").trim();
    if (!newVal) return false;
    if (list.indexOf(newVal) >= 0 && list[idx] !== newVal) return false;
    list[idx] = newVal;
    sortList(list);
    save();
    return true;
  }
  /** 按作用域删除字卡 */
  function removeCardByScope(scope, cid, idx) {
    if (scope === "public") return removePublicCard(idx);
    if (scope === "sys") return removeSysCard(idx);
    if (scope === "auto") return removeAutoCard(cid, idx);
    if (scope === "per") return removePerCard(cid, idx);
    return false;
  }

  function addPublicCard(card) {
    return addTo(state.public, card);
  }
  function addPublicCards(raw) { return addMany(state.public, raw); }
  function removePublicCard(idx) {
    if (idx < 0 || idx >= state.public.length) return false;
    state.public.splice(idx, 1);
    save();
    return true;
  }
  /* 按值从公用字卡池移除（生成器/字卡池删除用，幂等） */
  function removePublicCardByValue(card) {
    var idx = state.public.indexOf(card);
    if (idx < 0) return false;
    state.public.splice(idx, 1);
    save();
    return true;
  }
  function addSysCard(card) {
    return addTo(state.sys, card);
  }
  function addSysCards(raw) { return addMany(state.sys, raw); }
  function removeSysCard(idx) {
    if (idx < 0 || idx >= state.sys.length) return false;
    state.sys.splice(idx, 1);
    save();
    return true;
  }
  /* 单独字卡：自动回复字卡（仅自动回复场景使用） */
  function getAutoCards(cid) {
    if (!cid || !state.autoPer[cid]) return [];
    return state.autoPer[cid].slice();
  }
  function addAutoCard(cid, card) {
    if (!cid) return false;
    if (!state.autoPer[cid]) state.autoPer[cid] = [];
    var ok = addTo(state.autoPer[cid], card);
    if (ok) syncCardsToContact(cid, "autoCards", [card]);
    return ok;
  }
  function addAutoCards(cid, raw) {
    if (!cid) return { added: 0, skipped: 0 };
    if (!state.autoPer[cid]) state.autoPer[cid] = [];
    return addMany(state.autoPer[cid], raw);
  }
  function removeAutoCard(cid, idx) {
    if (!cid || !state.autoPer[cid]) return false;
    if (idx < 0 || idx >= state.autoPer[cid].length) return false;
    var removed = state.autoPer[cid][idx];
    state.autoPer[cid].splice(idx, 1);
    save();
    removeCardFromContact(cid, "autoCards", removed);
    return true;
  }
  /* ==================== 与联系人主页字卡的双向同步 ====================
     联系人主页（MineContacts）维护 c.cards / c.autoCards，
     个人中心（本模块 MineCards）维护 per[cid] / autoPer[cid]。
     两处通过「按值同步」保持内容一致（各自排序互不影响）：
       · 联系人主页增删字卡 → contacts.save() 调 syncContactCards() 合并到本模块
       · 本模块增删（个人中心）→ 反向同步到联系人 c.cards / c.autoCards 并落盘
     所有同步均为幂等操作（去重 + 存在判断），不会互相触发循环。 */
  function syncCardsToContact(cid, target, cards) {
    if (!cid) return;
    try {
      var ct = (C && C.findContact) ? C.findContact(cid) : null;
      if (!ct) return;
      var changed = false;
      (cards || []).forEach(function (card) {
        if (card === undefined || card === null) return;
        if (!Array.isArray(ct[target]) || ct[target].indexOf(card) < 0) {
          if (!Array.isArray(ct[target])) ct[target] = [];
          ct[target].push(card);
          changed = true;
        }
      });
      if (changed && C && C.save) C.save();
    } catch (e) {}
  }
  function removeCardFromContact(cid, target, card) {
    if (!cid) return;
    try {
      var ct = (C && C.findContact) ? C.findContact(cid) : null;
      if (!ct || !Array.isArray(ct[target])) return;
      var idx = ct[target].indexOf(card);
      if (idx < 0) return;
      ct[target].splice(idx, 1);
      if (C && C.save) C.save();
    } catch (e) {}
  }
  /* 联系人主页 → 本模块：增量合并（不删除个人中心已有的字卡，幂等） */
  function syncContactCards(cid, cards, autoCards) {
    if (!cid) return;
    var changed = false;
    (cards || []).forEach(function (card) {
      if (card === undefined || card === null) return;
      if (!state.per[cid]) state.per[cid] = [];
      if (state.per[cid].indexOf(card) < 0) {
        state.per[cid].push(card);
        changed = true;
      }
    });
    if (changed) sortList(state.per[cid]);
    var aChanged = false;
    (autoCards || []).forEach(function (card) {
      if (card === undefined || card === null) return;
      if (!state.autoPer[cid]) state.autoPer[cid] = [];
      if (state.autoPer[cid].indexOf(card) < 0) {
        state.autoPer[cid].push(card);
        aChanged = true;
      }
    });
    if (aChanged) sortList(state.autoPer[cid]);
    if (changed || aChanged) save();
  }
  /* 按值删除单独 / 自动回复字卡（供联系人主页删除同步使用，同时反向同步联系人） */
  function removePerCardByValue(cid, card) {
    if (!cid || !state.per[cid]) return false;
    var idx = state.per[cid].indexOf(card);
    if (idx < 0) return false;
    state.per[cid].splice(idx, 1);
    save();
    removeCardFromContact(cid, "cards", card);
    return true;
  }
  function removeAutoCardByValue(cid, card) {
    if (!cid || !state.autoPer[cid]) return false;
    var idx = state.autoPer[cid].indexOf(card);
    if (idx < 0) return false;
    state.autoPer[cid].splice(idx, 1);
    save();
    removeCardFromContact(cid, "autoCards", card);
    return true;
  }

  function addPerCard(cid, card) {
    if (!cid) return false;
    if (!state.per[cid]) state.per[cid] = [];
    var ok = addTo(state.per[cid], card);
    if (ok) syncCardsToContact(cid, "cards", [card]);
    return ok;
  }
  function addPerCards(cid, raw) {
    if (!cid) return { added: 0, skipped: 0 };
    if (!state.per[cid]) state.per[cid] = [];
    return addMany(state.per[cid], raw);
  }
  function removePerCard(cid, idx) {
    if (!cid || !state.per[cid]) return false;
    if (idx < 0 || idx >= state.per[cid].length) return false;
    var removed = state.per[cid][idx];
    state.per[cid].splice(idx, 1);
    save();
    removeCardFromContact(cid, "cards", removed);
    return true;
  }

  /* ==================== 工具 ==================== */
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function contactName(cid) {
    try {
      if (C && C.loadData) C.loadData();
      if (C && C.getState) {
        var st = C.getState();
        var list = st.contacts || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === cid) return list[i].name || list[i].nickname || cid;
        }
      }
    } catch (e) {}
    return cid;
  }
  function listContacts() {
    try {
      if (C && C.loadData) C.loadData();
      if (C && C.getState) return C.getState().contacts || [];
    } catch (e) {}
    return [];
  }

  /* ==================== 字卡一键导入 / 导出 ==================== */
  function cardType(card) {
    if (isImageCard(card)) return "image";
    if (isAudioCard(card)) return "audio";
    if (isEmojiCard(card)) return "emoji";
    return "text";
  }
  function typeLabel(type) {
    return type === "text" ? "字符" :
      (type === "emoji" ? "emoji" :
      (type === "image" ? "图片" :
      (type === "audio" ? "语音" : "自动回复")));
  }
  function stamp2() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }
  function downloadJSON(filename, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
  }
  function scopeLabel(scope, cid) {
    if (scope === "public") return "公用";
    if (scope === "sys") return "系统";
    if (scope === "auto") return "自动回复";
    return "单独";
  }
  function exportTypeCards(scope, cid, type) {
    var list = listFor(scope, cid);
    if (!list) return;
    var cards = list.filter(function (c) { return cardType(c) === type; });
    if (!cards.length) { showToast("该类型暂无「" + typeLabel(type) + "」字卡可导出"); return; }
    downloadJSON("mine-cards-" + scopeLabel(scope, cid) + "-" + type + "-" + stamp2() + ".json", {
      app: "Mine", format: 1, kind: "cards", scope: scope, cid: cid || null, type: type, cards: cards
    });
    showToast("已导出 " + cards.length + " 张「" + typeLabel(type) + "」字卡");
  }
  function importTypeCards(scope, cid, type) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      document.body.removeChild(input);
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var data;
        try { data = JSON.parse(String(reader.result)); } catch (e) { showToast("文件不是有效的 JSON"); return; }
        var cards = Array.isArray(data) ? data : (data && Array.isArray(data.cards) ? data.cards : null);
        if (!cards) { showToast("文件格式不符：应为字卡数组或 Mine 字卡导出文件"); return; }
        var list = listFor(scope, cid);
        if (!list) return;
        var added = 0, skipped = 0;
        cards.forEach(function (c) {
          if (cardType(c) !== type) { skipped++; return; }
          if (addTo(list, c)) added++; else skipped++;
        });
        var msg = added ? "已导入 " + added + " 张「" + typeLabel(type) + "」字卡" : "没有可导入的「" + typeLabel(type) + "」字卡";
        if (skipped) msg += "（" + skipped + " 条无效或重复）";
        showToast(msg);
        render();
      };
      reader.onerror = function () { showToast("读取文件失败"); };
      reader.readAsText(f);
    });
    input.click();
  }

  /* ==================== 管理面板 ==================== */
  var sheetEl = null;
  var overlayEl = null;
  var currentTab = "mine";   // "mine"(我的字卡) | "per"(单独字卡) | "syspool"(系统字卡=审批通过池)
  var currentCid = null;       // 单独字卡当前选中的联系人
  var pvSearch = "", pvFilter = "all", pvSearchTimer = null;   // 便捷版：搜索词 / 类型过滤 / 防抖计时器

  function buildSheet() {
    if (sheetEl) return;
    overlayEl = document.createElement("div");
    overlayEl.className = "sheet-overlay";
    overlayEl.addEventListener("click", closeManager);

    sheetEl = document.createElement("div");
    sheetEl.className = "sheet";
    sheetEl.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-head"><h2>字卡</h2>' +
      '<button class="nav-btn" data-act="close">' + I.svg("close", 20) + '</button></div>' +
      '<div class="sheet-body" id="cards-sheet-body"></div>';

    document.body.appendChild(overlayEl);
    document.body.appendChild(sheetEl);
    sheetEl.querySelector('[data-act="close"]').addEventListener("click", closeManager);
    render();
  }

  function render() {
    var body = document.getElementById("cards-sheet-body");
    if (!body) return;

    var head =
      '<div class="pv-head">' +
        '<span class="pv-head-title">' + (currentTab === "mine" ? "我的字卡" : currentTab === "per" ? "单独字卡" : "系统字卡") + '</span>' +
        '<span class="pv-head-switch">' +
          '<button class="pv-head-tab' + (currentTab === "mine" ? " on" : "") + '" data-tab="mine">我的</button>' +
          '<button class="pv-head-tab' + (currentTab === "per" ? " on" : "") + '" data-tab="per">单独</button>' +
          '<button class="pv-head-tab' + (currentTab === "syspool" ? " on" : "") + '" data-tab="syspool">系统</button>' +
        '</span>' +
      '</div>';

    var content = "";
    try {
      if (currentTab === "mine") {
        content = renderMineTab();
      } else if (currentTab === "per") {
        content = renderPerTab();
      } else {
        content = renderSysPoolTab();
      }
    } catch (e) {
      /* 渲染异常不允许白屏：显示错误信息便于定位 */
      content = '<div class="card-hint" style="color:#a93226;">字卡列表渲染失败：' +
        escapeHtml((e && e.message) ? e.message : String(e)) +
        '<br>可尝试在设置中清除缓存后重试。</div>';
    }

    /* 弹层内交互重渲染（删除/添加/tab 切换）保持滚动位置，避免跳回顶部
       防御：MineScroll 异常时回退为直接渲染，保证交互不失效（防"点击没反应"） */
    try {
      window.MineScroll.render(body, head + content, true, function () { bindEvents(body); });
    } catch (e) {
      console.error("[MineCards] render failed:", e);
      body.innerHTML = head + content;
      try { bindEvents(body); } catch (e2) { console.error("[MineCards] bindEvents failed:", e2); }
    }
  }

  /* ---- 我的字卡 tab：便捷版 v2（搜索 + 目标下拉 + 添加按钮 + 系统滑块开关 + 类型过滤 + 一行一张） ---- */
  function renderMineTab() {
    var on = getSysAllOn();
    return '<div class="pv-searchbox">' + I.svg("search", 15) +
        '<input type="text" id="pv-card-search" placeholder="搜索字卡内容" value="' + escapeHtml(pvSearch) + '"></div>' +
      '<div class="pv-addrow">' +
        '<select class="card-search-target" id="pv-card-target" aria-label="添加目标">' + targetSelectHtml() + '</select>' +
        '<input type="text" class="card-input" id="card-input-text" ' +
          'placeholder="输入字卡内容，空格分隔批量添加，回车确认" maxlength="500">' +
        '<button class="pv-addbtn" data-add-scope="public" data-add-type="text">添加</button>' +
      '</div>' +
      '<div class="pv-sysrow"><span class="pv-lbl">系统预设字卡</span>' +
        '<div class="pv-switch' + (on ? " on" : "") + '" id="pv-syssw"></div></div>' +
      '<div class="pv-filters" id="pv-filters">' + pvFiltersHtml() + '</div>' +
      '<div class="pv-list" id="pv-card-list">' + pvListHtml("mine") + '</div>';
  }
  /* 目标选择下拉选项（与全部字卡一致：公用/系统/单独·联系人/自动回复·联系人） */
  function targetSelectHtml() {
    var opts = '<option value="public">公用字卡</option>' +
      '<option value="sys">系统字卡</option>';
    listContacts().forEach(function (t) {
      var nm = escapeHtml(t.name || t.nickname || t.id);
      opts += '<option value="per:' + escapeHtml(t.id) + '">单独 · ' + nm + '</option>';
    });
    listContacts().forEach(function (t) {
      var nm = escapeHtml(t.name || t.nickname || t.id);
      opts += '<option value="auto:' + escapeHtml(t.id) + '">自动回复 · ' + nm + '</option>';
    });
    return opts;
  }

  /* ---- 便捷版：字卡类型归类 ---- */
  function cardType(card) {
    if (isImageCard(card)) return "image";
    if (isAudioCard(card)) return "audio";
    if (isEmojiCard(card)) return "emoji";
    return "text";
  }
  function pvEmpty() {
    return '<div class="pv-empty">暂无字卡 · 上方输入直接添加</div>';
  }
  /* 统计条：全部 / 字符 / emoji / 图片 / 语音（includePer 时统计单独+自动回复池） */
  function pvFiltersHtml(includePer) {
    var on = getSysAllOn();
    var counts = { all: 0, text: 0, emoji: 0, image: 0, audio: 0 };
    state.public.forEach(function (c) { counts.all++; counts[cardType(c)]++; });
    state.sys.forEach(function (c) { if (!on) return; counts.all++; counts[cardType(c)]++; });
    if (includePer) {
      Object.keys(state.per).forEach(function (cid) {
        (state.per[cid] || []).forEach(function (c) { counts.all++; counts[cardType(c)]++; });
      });
      Object.keys(state.autoPer).forEach(function (cid) {
        (state.autoPer[cid] || []).forEach(function (c) { counts.all++; counts[cardType(c)]++; });
      });
    }
    var names = [["all", "全部 " + counts.all], ["text", "字符 " + counts.text],
      ["emoji", "emoji " + counts.emoji], ["image", "图片 " + counts.image], ["audio", "语音 " + counts.audio]];
    return names.map(function (f) {
      return '<span class="pv-fchip' + (pvFilter === f[0] ? " on" : "") + '" data-pv-filter="' + f[0] + '">' + f[1] + '</span>';
    }).join("");
  }
  /* 一行一张字卡（对齐 v2 预览：文本 + 来源标记 + 行尾 × 删除） */
  function renderPvEntry(entry, scope, cid) {
    var card = entry.card;
    var label = isImageCard(card) ? "[图片]" : (isAudioCard(card) ? "[语音]" : String(card));
    var isSys = (scope === "mine" && entry.src === "sys") || scope === "sys";
    var delScope = (scope === "mine") ? entry.src : scope;
    var mark = isSys ? "系统预设" : (scope === "sys" ? "审批" : "公用");
    return '<div class="pv-crow' + (isSys ? " sys" : "") + '">' +
      '<span class="pv-txt">' + escapeHtml(label) + '</span>' +
      '<span class="pv-mark">' + mark + '</span>' +
      '<span class="pv-del" data-del-scope="' + delScope + '" data-del-cid="' + (cid || "") + '" data-del-idx="' + entry.idx + '" ' +
      'aria-label="删除">×</span></div>';
  }
  /* 便捷版列表（mine 合并 / per 联系人） */
  function pvListHtml(kind) {
    var on = getSysAllOn();
    var list;
    if (kind === "mine") {
      list = state.public.map(function (c, i) { return { card: c, idx: i, src: "public" }; })
        .concat(state.sys.map(function (c, i) { return { card: c, idx: i, src: "sys" }; }));
      list = list.filter(function (e) {
        if (e.src === "sys" && !on) return false;
        if (pvFilter !== "all" && cardType(e.card) !== pvFilter) return false;
        if (pvSearch) {
          var text = isImageCard(e.card) ? "[图片]" : (isAudioCard(e.card) ? "[语音]" : String(e.card));
          if (text.toLowerCase().indexOf(pvSearch.toLowerCase()) < 0) return false;
        }
        return true;
      });
      if (!list.length) return pvEmpty();
      return list.map(function (e) { return renderPvEntry(e, "mine", null); }).join("");
    }
    list = (state.per[currentCid] || []).map(function (c, i) { return { card: c, idx: i, src: "per" }; });
    if (!list.length) return pvEmpty();
    return list.map(function (e) { return renderPvEntry(e, "per", currentCid); }).join("");
  }
  /* 便捷版局部重渲染：只重建过滤条与列表（搜索输入框不重建、不丢焦点） */
  function renderPvList(body) {
    var kind = (currentTab === "per") ? "per" : "mine";
    var f = body.querySelector("#pv-filters");
    if (f) {
      f.innerHTML = pvFiltersHtml();
      f.querySelectorAll("[data-pv-filter]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          pvFilter = btn.getAttribute("data-pv-filter");
          renderPvList(body);
        });
      });
    }
    var l = body.querySelector("#pv-card-list");
    if (!l) { render(); return; }
    l.innerHTML = pvListHtml(kind);
    bindPvList(body);
    var sw = body.querySelector("#pv-syssw");
    if (sw) sw.className = "pv-switch" + (getSysAllOn() ? " on" : "");
  }
  /* 便捷版列表内按钮：删除（行尾 ×） */
  function bindPvList(body) {
    body.querySelectorAll("#pv-card-list [data-del-scope]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var scope = btn.getAttribute("data-del-scope");
        var cid = btn.getAttribute("data-del-cid") || null;
        var idx = parseInt(btn.getAttribute("data-del-idx"), 10);
        if (scope === "public") removePublicCard(idx);
        else if (scope === "per") removePerCard(cid, idx);
        else if (scope === "sys") removeSysCard(idx);
        else if (scope === "auto") removeAutoCard(cid, idx);
        renderPvList(body);
      });
    });
  }

  /* ---- 系统字卡 tab：字卡池中你审批通过的字卡（来自组字卡审批），按联系人分组、可折叠 ---- */
  var sysPoolCollapse = {};   /* 联系人组折叠状态：默认折叠，点击组头展开 */
  var sysPoolMore = {};       /* 联系人组「显示更多」展开状态 */
  function renderSysPoolTab() {
    var spKw = (window.__spSearch || "").toLowerCase();
    var on = getSysAllOn();
    var html = '<div class="pv-searchbox">' + I.svg("search", 15) +
        '<input type="text" id="sp-card-search" placeholder="搜索字卡内容" value="' + escapeHtml(window.__spSearch || "") + '"></div>' +
      '<div class="pv-addrow">' +
        '<select class="card-search-target" id="pv-card-target" aria-label="添加目标">' + targetSelectHtml() + '</select>' +
        '<input type="text" class="card-input" id="card-input-text" ' +
          'placeholder="输入字卡内容，空格分隔批量添加，回车确认" maxlength="500">' +
        '<button class="pv-addbtn" data-add-scope="public" data-add-type="text">添加</button>' +
      '</div>' +
      '<div class="pv-sysrow"><span class="pv-lbl">系统预设字卡</span>' +
        '<div class="pv-switch' + (on ? " on" : "") + '" id="pv-syssw"></div></div>' +
      '<div class="pv-filters" id="pv-filters">' + pvFiltersHtml() + '</div>' +
      '<div class="card-hint">系统字卡：你审批通过的字卡（来自字卡池），联系人组卡审批通过后自动进入此处 · 按联系人分组，点击组名展开/折叠 · 删除后同时移出聊天使用</div>';
    var pool = (window.MineCardGenerator && window.MineCardGenerator.getPool) ? window.MineCardGenerator.getPool() : [];
    if (!pool || pool.length === 0) {
      return html + '<div class="cm-empty">暂无审批通过的字卡</div>';
    }
    var byCid = {};
    pool.forEach(function (it) {
      var k = (it.contactId && it.contactId !== "global") ? it.contactId : "global";
      (byCid[k] = byCid[k] || []).push(it);
    });
    var POOL_MORE = 100;   /* 每组最多渲染 100 条，防大量审批通过卡导致卡顿 */
    var anyShown = false;
    Object.keys(byCid).forEach(function (k) {
      var name = k === "global" ? "通用" : contactName(k);
      var group = byCid[k];
      /* 搜索时过滤组内字卡；命中为空则整组隐藏 */
      if (spKw) group = group.filter(function (it) { return String(it.text || "").toLowerCase().indexOf(spKw) >= 0; });
      if (!group.length) return;
      anyShown = true;
      var open = sysPoolCollapse[k] === true || !!spKw;   /* 搜索时自动展开 */
      html += '<div class="group-head sp-group-head" data-sp-group="' + escapeHtml(k) + '" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;">' +
        '<span>' + escapeHtml(name) + ' · ' + group.length + ' 张</span>' +
        '<span style="font-size:12px;color:#888;">' + (open ? '收起 ▲' : '展开 ▼') + '</span></div>';
      if (open) {
        var poolExpanded = sysPoolMore[k] === true;
        var poolShown = poolExpanded ? group : group.slice(0, POOL_MORE);
        html += '<div class="pv-list">' + poolShown.map(function (it) {
          return '<div class="pv-crow sys">' +
            '<span class="pv-txt">' + escapeHtml(it.text) + '</span>' +
            '<span class="pv-mark">审批</span>' +
            '<span class="pv-del" data-del-pool-id="' + escapeHtml(it.id) + '" aria-label="删除">×</span></div>';
        }).join("") + '</div>';
        if (group.length > poolShown.length) {
          html += '<button class="card-more-btn" data-sp-more="' + escapeHtml(k) + '" style="width:100%;padding:9px;border:none;background:none;color:#4a90d9;font-size:12px;cursor:pointer;">显示更多（还有 ' + (group.length - poolShown.length) + ' 张）</button>';
        }
      }
    });
    if (!anyShown) return html + '<div class="pv-empty">' + (spKw ? "未找到匹配的字卡" : "暂无字卡") + '</div>';
    return html;
  }

  /* ---- 单独字卡 tab：通讯录联系人直接列出，点击姓名即可添加 ---- */
  function renderPerTab() {
    var html = '<div class="card-hint">单独字卡：仅指定联系人回复时使用 · 其下的「自动回复」仅该联系人的自动回复场景使用</div>';
    if (!currentCid) {
      /* 通讯录所有联系人直接显示 */
      var targets = listContacts();
      var items = targets.length
        ? targets.map(function (t) {
            var per = (state.per[t.id] || []).length;
            return '<button class="target-row" data-pick-cid="' + escapeHtml(t.id) + '">' +
              '<span class="target-avatar">' + (C && C.avatarHTML ? C.avatarHTML(28, "target-avatar-img") : "") + '</span>' +
              '<span class="target-name">' + escapeHtml(t.name || t.nickname || t.id) + '</span>' +
              (per ? '<span class="target-sub">' + per + ' 张</span>' : '<span class="target-sub">未设置</span>') +
              '<span class="chevron">' + I.svg("back", 18) + '</span>' +
              '</button>';
          }).join("")
        : '<div class="cm-empty">通讯录暂无联系人，可先到通讯录添加</div>';
      html += '<div class="card-target-list">' + items + '</div>';
      return html;
    }
    /* 已选择联系人 → 该联系人的单独字卡（v2 样式：切换行 + 添加按钮 + 一行一张） */
    html += '<div class="pv-currow">' +
      '<span class="pv-cname">当前联系人：' + escapeHtml(contactName(currentCid)) + '</span>' +
      '<button class="pv-back" data-pick-back>' + I.svg("back", 13) + ' 切换</button>' +
      '</div>' +
      '<div class="pv-addrow">' +
        '<input type="text" class="card-input" id="card-input-text" ' +
          'placeholder="添加 TA 的字卡，空格分隔批量添加，回车确认" maxlength="500">' +
        '<button class="pv-addbtn" data-add-scope="per" data-add-cid="' + escapeHtml(currentCid) + '" data-add-type="text">添加</button>' +
      '</div>' +
      '<div class="pv-list" id="pv-card-list">' + pvListHtml("per") + '</div>';
    return html;
  }

  /* ---- 类型分栏编辑器：每一栏一种字卡类型，点击栏头折叠/展开
       includeAudio=true 时额外显示语音栏（单独字卡）
       单独字卡（scope=per 且有 cid）的"自动回复"栏排在最后（字符/emoji/图片/语音 → 自动回复） ---- */
  function renderCardEditor(list, scope, cid, includeAudio) {
    var groups = [];
    groups.push(
      { type: "text",  name: "字符", icon: "feather", items: [] },
      { type: "emoji", name: "emoji", icon: "smile", items: [] },
      { type: "image", name: "图片", icon: "image", items: [] }
    );
    if (includeAudio) {
      groups.push({ type: "audio", name: "语音", icon: "mic", items: [] });
    }
    /* 单独字卡：自动回复栏排最后（不占用前置索引，与下方按类型分组保持一致） */
    if (scope === "per" && cid) {
      var autoList = (state.autoPer[cid] || []).filter(function (c) {
        return typeof c === "string" && c.length > 0;   /* 过滤脏条目，避免空白行 */
      }).map(function (card, i) {
        return { card: card, idx: i };
      });
      groups.push({ type: "auto", name: "自动回复", icon: "feather", items: autoList });
    }
    /* 按类型放入对应组：按 type 查找目标组（auto 组存在时不再按硬编码索引，避免内容错位） */
    function groupByType(t) {
      for (var gi = 0; gi < groups.length; gi++) if (groups[gi].type === t) return groups[gi];
      return null;
    }
    (list || []).forEach(function (entry0, i) {
      var card = entry0.card;
      var entry = { card: card, idx: entry0.idx, src: entry0.src || null };
      var g;
      if (isImageCard(card)) g = groupByType("image") || groupByType("emoji");
      else if (isAudioCard(card)) g = groupByType("audio") || groupByType("image");
      else if (isEmojiCard(card)) g = groupByType("emoji") || groupByType("text");
      else g = groupByType("text");
      if (g) g.items.push(entry);
    });

    return '<div class="card-editor">' + groups.map(function (g) {
      var expanded = expandedTypes[g.type] !== false;
      var bodyHtml;
      if (g.type === "auto") {
        bodyHtml = renderAutoSection(g.items, cid);
      } else {
        bodyHtml = renderTypeItems(g.items, scope, cid, g.type) +
          renderTypeAddRow(g.type, scope, cid);
      }
      /* 一键导出 / 一键导入（各类字卡）——"mine" 合并 tab 作用于公用池部分 */
      var toolsScope = (scope === "mine") ? "public" : scope;
      var toolsHtml =
        '<div class="card-type-tools">' +
          '<button class="card-type-tool" data-export-type="' + g.type + '" data-tool-scope="' + toolsScope + '" data-tool-cid="' + (cid || "") + '">' + I.svg("download", 13) + '导出</button>' +
          '<button class="card-type-tool" data-import-type="' + g.type + '" data-tool-scope="' + toolsScope + '" data-tool-cid="' + (cid || "") + '">' + I.svg("upload", 13) + '导入</button>' +
        '</div>';
      return '<div class="card-type-section">' +
        '<button class="card-type-head" data-fold="' + g.type + '">' +
          '<span class="card-type-icon">' + I.svg(g.icon, 18) + '</span>' +
          '<span class="card-type-name">' + g.name + '</span>' +
          '<span class="card-type-count">' + g.items.length + '</span>' +
          '<span class="card-type-arrow' + (expanded ? " is-open" : "") + '">' + I.svg("back", 16) + '</span>' +
        '</button>' +
        (expanded
          ? '<div class="card-type-body">' + toolsHtml + bodyHtml + '</div>'
          : '') +
        '</div>';
    }).join("") + '</div>';
  }

  /* ---- 自动回复栏内容：列表 + 字符输入 + 图片 / 语音选择 ---- */
  function renderAutoSection(items, cid) {
    return renderTypeItems(items, "auto", cid, "auto") + renderAutoAddRow(cid);
  }
  function renderAutoAddRow(cid) {
    return '<div class="card-add-row">' +
      '<input type="text" class="card-input" id="card-input-auto" ' +
        'placeholder="输入自动回复字卡，空格分隔批量添加 · 回车确认 · 自动去重" maxlength="500">' +
      '<button class="card-add-btn" data-add-scope="auto" data-add-cid="' + (cid || "") + '" ' +
        'data-add-type="text" aria-label="添加">' + I.svg("plus", 18) + '</button>' +
      '</div>' +
      '<div class="card-add-row">' +
        '<button class="card-image-add-btn" data-add-scope="auto" data-add-cid="' + (cid || "") + '" ' +
          'data-add-type="image">' + I.svg("image", 18) + ' 选择图片</button>' +
        '<button class="card-image-add-btn" data-add-scope="auto" data-add-cid="' + (cid || "") + '" ' +
          'data-add-type="audio">' + I.svg("mic", 18) + ' 选择语音</button>' +
      '</div>';
  }

  function fmtCardDate(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? "0" + n : n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  /* ---- 某类型下的字卡项列表（items: [{card, idx}]，idx 为存储数组真实索引） ---- */
  function renderTypeItems(items, scope, cid, type) {
    if (!items || items.length === 0) {
      var emptyText =
        type === "text" ? "暂无字符字卡" :
        (type === "emoji" ? "暂无 emoji 字卡" :
        (type === "image" ? "暂无图片字卡" :
        (type === "auto" ? "暂无自动回复字卡" : "暂无语音字卡")));
      return '<div class="cards-empty">' + emptyText + '</div>';
    }
    /* 大列表限流：每栏默认最多渲染 100 条，点击「显示更多」展开全部（防大量字卡导致页面卡顿） */
    var MORE_LIMIT = 100;
    var moreKey = (scope || "s") + ":" + (cid || "") + ":" + type;
    var expanded = expandedMore[moreKey] === true;
    var shown = expanded ? items : items.slice(0, MORE_LIMIT);
    var listHtml = shown.map(function (entry) {
      var card = entry.card;
      var inner;
      if (isImageCard(card)) {
        inner = '<img class="card-img" src="' + escapeHtml(card) + '" alt="图片字卡">';
      } else if (isAudioCard(card)) {
        inner = MineVoiceBar.html(card, "vb-full");
      } else if (isEmojiCard(card)) {
        inner = '<span class="card-emoji">' + escapeHtml(card) + '</span>';
      } else {
        inner = '<span class="card-text">' + escapeHtml(card) + '</span>';
      }
      /* 添加日期（文本/emoji 卡有记录；图片/语音无记录不显示） */
      var at = state.cardAt[card];
      var atLine = at
        ? '<div style="font-size:11px;color:#aaa;margin-top:2px;">添加于 ' + fmtCardDate(at) + '</div>'
        : '';
      /* 系统预设字卡（来源 sys）显示开关；"mine" 合并 tab 内按 entry.src 区分删除目标 */
      var isSysEntry = (scope === "mine" && entry.src === "sys") || scope === "sys";
      var sysToggle = isSysEntry
        ? '<button class="card-sys-toggle' + (isSysCardOn(card) ? " is-on" : "") + '" data-sys-toggle-idx="' + entry.idx + '" ' +
          'aria-label="' + (isSysCardOn(card) ? "关闭此系统预设字卡" : "开启此系统预设字卡") + '">' +
          (isSysCardOn(card) ? I.svg("check", 13) : '') +
          '</button>'
        : '';
      var delScope = (scope === "mine") ? entry.src : scope;
      return '<div class="card-item' + (isAudioCard(card) ? " is-voice" : "") + '">' + inner + atLine + sysToggle +
        '<button class="card-del" data-del-scope="' + delScope + '" data-del-cid="' + (cid || "") + '" data-del-idx="' + entry.idx + '" ' +
        'aria-label="删除">' + I.svg("trash", 16) + '</button></div>';
    }).join("");
    var moreBtn = items.length > shown.length
      ? '<button class="card-more-btn" data-more-key="' + moreKey + '" style="width:100%;padding:9px;border:none;background:none;color:#4a90d9;font-size:12px;cursor:pointer;">显示更多（还有 ' + (items.length - shown.length) + ' 条）</button>'
      : '';
    return '<div class="card-list">' + listHtml + '</div>' + moreBtn;
  }

  /* ---- 某类型的添加行 ---- */
  function renderTypeAddRow(type, scope, cid) {
    /* "mine" 合并 tab：新增字卡进入公用池 */
    var data = 'data-add-scope="' + ((scope === "mine") ? "public" : scope) + '" data-add-cid="' + (cid || "") + '"';
    if (type === "text") {
      return '<div class="card-add-row">' +
        '<input type="text" class="card-input" id="card-input-text" ' +
          'placeholder="输入字卡，空格分隔批量添加 · 回车确认" maxlength="500">' +
        '<button class="card-add-btn" ' + data + ' data-add-type="text" aria-label="添加">' + I.svg("plus", 18) + '</button>' +
        '</div>';
    }
    if (type === "emoji") {
      return '<div class="card-add-row">' +
        '<input type="text" class="card-input" id="card-input-emoji" ' +
          'placeholder="输入 emoji，空格分隔批量添加 · 回车确认" maxlength="60">' +
        '<button class="card-add-btn" ' + data + ' data-add-type="emoji" aria-label="添加">' + I.svg("plus", 18) + '</button>' +
        '</div>';
    }
    if (type === "audio") {
      return '<div class="card-add-row">' +
        '<button class="card-image-add-btn" ' + data + ' data-add-type="audio">' + I.svg("mic", 18) + ' 选择语音文件</button>' +
        '</div>';
    }
    return '<div class="card-add-row">' +
      '<button class="card-image-add-btn" ' + data + ' data-add-type="image">' + I.svg("image", 18) + ' 选择图片</button>' +
      '</div>';
  }

  function bindEvents(body) {
    /* tab 切换 */
    body.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        currentTab = btn.getAttribute("data-tab");
        render();
      });
    });

    /* 关闭 */
    var closeBtn = body.closest(".sheet").querySelector('[data-act="close"]');
    if (closeBtn) closeBtn.addEventListener("click", closeManager);

    /* 选择联系人（单独字卡，点击姓名即进入） */
    body.querySelectorAll("[data-pick-cid]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        currentCid = btn.getAttribute("data-pick-cid");
        render();
      });
    });
    var backBtn = body.querySelector("[data-pick-back]");
    if (backBtn) {
      backBtn.addEventListener("click", function () {
        currentCid = null;
        render();
      });
    }

    /* 类型栏折叠 / 展开 */
    body.querySelectorAll("[data-fold]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var type = btn.getAttribute("data-fold");
        expandedTypes[type] = expandedTypes[type] === false;
        render();
      });
    });

    /* 大列表「显示更多」展开（防卡顿限流后的补充分页） */
    body.querySelectorAll("[data-more-key]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        expandedMore[btn.getAttribute("data-more-key")] = true;
        render();
      });
    });

    /* 一键导出 / 一键导入（各类字卡） */
    body.querySelectorAll("[data-export-type]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var type = btn.getAttribute("data-export-type");
        var scope = btn.getAttribute("data-tool-scope");
        var cid = btn.getAttribute("data-tool-cid") || null;
        exportTypeCards(scope, cid, type);
      });
    });
    body.querySelectorAll("[data-import-type]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var type = btn.getAttribute("data-import-type");
        var scope = btn.getAttribute("data-tool-scope");
        var cid = btn.getAttribute("data-tool-cid") || null;
        importTypeCards(scope, cid, type);
      });
    });

    /* 系统字卡总开关：开启全部 / 关闭全部 */
    var sysAllBtn = body.querySelector("[data-sys-all-toggle]");
    if (sysAllBtn) {
      sysAllBtn.addEventListener("click", function () {
        setSysAllOn(!getSysAllOn());
        render();
      });
    }

    /* 单张系统字卡开关 */
    body.querySelectorAll("[data-sys-toggle-idx]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(btn.getAttribute("data-sys-toggle-idx"), 10);
        var card = state.sys[idx];
        if (card === undefined) return;
        setSysCardOn(card, !isSysCardOn(card));
        render();
      });
    });

    /* 删除字卡（data-del-idx 为存储数组真实索引） */
    body.querySelectorAll("[data-del-scope]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var scope = btn.getAttribute("data-del-scope");
        var cid = btn.getAttribute("data-del-cid") || null;
        var idx = parseInt(btn.getAttribute("data-del-idx"), 10);
        if (scope === "public") removePublicCard(idx);
        else if (scope === "per") removePerCard(cid, idx);
        else if (scope === "sys") removeSysCard(idx);
        else if (scope === "auto") removeAutoCard(cid, idx);
        render();
      });
    });

    /* 系统字卡联系人分组：点击组头展开 / 折叠 */
    body.querySelectorAll("[data-sp-group]").forEach(function (h) {
      h.addEventListener("click", function () {
        var k = h.getAttribute("data-sp-group");
        sysPoolCollapse[k] = sysPoolCollapse[k] !== true;
        render();
      });
    });

    /* 系统字卡分组「显示更多」展开 */
    body.querySelectorAll("[data-sp-more]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        sysPoolMore[btn.getAttribute("data-sp-more")] = true;
        render();
      });
    });

    /* 系统字卡 tab 搜索：防抖过滤（只重建列表，不丢焦点） */
    var spInput = body.querySelector("#sp-card-search");
    if (spInput) {
      var spTimer = null;
      spInput.addEventListener("input", function () {
        window.__spSearch = spInput.value;
        if (spTimer) clearTimeout(spTimer);
        spTimer = setTimeout(function () { render(); }, 120);
      });
    }
    /* 系统字卡 tab：系统滑块开关 + 类型过滤（与全部字卡统一样式；render() 整页重建后重新绑定） */
    if (currentTab === "syspool") {
      var sysSw = body.querySelector("#pv-syssw");
      if (sysSw) sysSw.addEventListener("click", function () {
        setSysAllOn(!getSysAllOn());
        render();
      });
      body.querySelectorAll("#pv-filters [data-pv-filter]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          pvFilter = btn.getAttribute("data-pv-filter");
          render();
        });
      });
    }

    /* 系统字卡（审批通过池）删除：同步移除生成器记录 + 对应字卡池 */
    body.querySelectorAll("[data-del-pool-id]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-del-pool-id");
        var G = window.MineCardGenerator;
        if (!G || !G.removePoolItem) { showToast("字卡引擎未加载"); return; }
        var r = G.removePoolItem(id);
        showToast(r && r.ok ? ("已移除「" + r.text + "」") : "移除失败或字卡不存在");
        render();
      });
    });

    /* 添加字符 / emoji 字卡（机制与通讯录联系人主页一致：
       输入框空格分隔批量添加 + 回车确认 + 自动去重；+ 按钮点击同样生效） */
    function doAddFromInput(btn, input) {
      var scope = btn.getAttribute("data-add-scope");
      var cid = btn.getAttribute("data-add-cid") || null;
      var v = input ? input.value : "";
      if (!v) { showToast("请输入字卡内容"); return; }
      /* 批量添加：按空格拆分，自动去重 */
      var r;
      if (scope === "public") r = addPublicCards(v);
      else if (scope === "sys") r = addSysCards(v);
      else if (scope === "auto") r = addAutoCards(cid, v);
      else r = addPerCards(cid, v);
      if (r.added > 0 && input) input.value = "";
      var msg = "";
      if (r.added > 0) msg = "已添加 " + r.added + " 条";
      if (r.skipped > 0) msg += (msg ? "，" : "") + "跳过重复 " + r.skipped + " 条";
      if (!r.added && r.skipped > 0) msg = "字卡已存在，未重复添加";
      if (msg) showToast(msg);
      render();
    }
    body.querySelectorAll("[data-add-type='text'], [data-add-type='emoji']").forEach(function (btn) {
      var scope = btn.getAttribute("data-add-scope");
      var cid = btn.getAttribute("data-add-cid") || null;
      var type = btn.getAttribute("data-add-type");
      var input;
      if (scope === "auto") input = body.querySelector("#card-input-auto");
      else input = body.querySelector(type === "text" ? "#card-input-text" : "#card-input-emoji");
      btn.addEventListener("click", function () {
        /* 我的字卡 tab：添加目标下拉存在时按下拉值动态确定 scope/cid（与全部字卡一致） */
        var targetSel = body.querySelector("#pv-card-target");
        if (targetSel) {
          var v = targetSel.value;
          if (v === "public") { btn.setAttribute("data-add-scope", "public"); btn.removeAttribute("data-add-cid"); }
          else if (v === "sys") { btn.setAttribute("data-add-scope", "sys"); btn.removeAttribute("data-add-cid"); }
          else if (v.indexOf("auto:") === 0) { btn.setAttribute("data-add-scope", "auto"); btn.setAttribute("data-add-cid", v.slice(5)); }
          else if (v.indexOf("per:") === 0) { btn.setAttribute("data-add-scope", "per"); btn.setAttribute("data-add-cid", v.slice(4)); }
        }
        doAddFromInput(btn, input);
      });
      /* 回车确认：与通讯录联系人主页「输入字卡，空格分隔批量添加 · 回车确认」一致 */
      if (input) {
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); doAddFromInput(btn, input); }
        });
      }
    });

    /* 添加图片 / 语音字卡 */
    body.querySelectorAll("[data-add-type='image'], [data-add-type='audio']").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var addType = btn.getAttribute("data-add-type");
        var scope = btn.getAttribute("data-add-scope");
        var cid = btn.getAttribute("data-add-cid") || null;
        var fid = addType === "audio" ? "card-audio-file" : "card-img-file";
        var fileEl = body.querySelector("#" + fid);
        if (!fileEl) {
          fileEl = document.createElement("input");
          fileEl.type = "file";
          fileEl.accept = addType === "audio" ? "audio/*" : "image/*";
          fileEl.id = fid;
          fileEl.className = "file-hidden";
          document.body.appendChild(fileEl);
          fileEl.addEventListener("change", function () {
            if (this.files && this.files[0]) {
              var f = this.files[0];
              if (addType === "audio") {
                /* 语音：读为 audio dataURL 原样存储（不做压缩） */
                var reader = new FileReader();
                reader.onload = function (ev) {
                  var dataURL = ev.target.result;
                  if (!dataURL) return;
                  if (scope === "public") addPublicCard(dataURL);
                  else if (scope === "sys") addSysCard(dataURL);
                  else if (scope === "auto") addAutoCard(cid, dataURL);
                  else if (scope === "per" && cid) addPerCard(cid, dataURL);
                  render();
                };
                reader.onerror = function () { showToast("语音文件读取失败"); };
                reader.readAsDataURL(f);
              } else {
                if (U && U.compressImage) {
                  U.compressImage(f, 600, 0.78, function (dataURL) {
                    if (!dataURL) return;
                    if (scope === "public") addPublicCard(dataURL);
                    else if (scope === "sys") addSysCard(dataURL);
                    else if (scope === "auto") addAutoCard(cid, dataURL);
                    else if (scope === "per" && cid) addPerCard(cid, dataURL);
                    render();
                  });
                }
              }
            }
            this.value = "";
          });
        }
        fileEl.click();
      });
    });

    /* 便捷版：搜索 + 类型过滤（只重建列表与过滤条，输入框不丢焦点，防抖丝滑） */
    var searchEl = body.querySelector("#pv-card-search");
    if (searchEl) {
      searchEl.addEventListener("input", function () {
        pvSearch = this.value.trim();
        clearTimeout(pvSearchTimer);
        pvSearchTimer = setTimeout(function () { renderPvList(body); }, 120);
      });
    }
    body.querySelectorAll("#pv-filters [data-pv-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        pvFilter = btn.getAttribute("data-pv-filter");
        renderPvList(body);
      });
    });
    /* 便捷版：系统预设滑块开关（整体开/关） */
    var sysSw = body.querySelector("#pv-syssw");
    if (sysSw) {
      sysSw.addEventListener("click", function () {
        setSysAllOn(!getSysAllOn());
        renderPvList(body);
      });
    }
  }

  function showToast(msg) {
    try {
      if (U && U.showToast) { U.showToast(msg); return; }
      if (window.MineApp && MineApp.toast) { MineApp.toast(msg); return; }
    } catch (e) {}
    try {
      var t = document.createElement("div");
      t.className = "mini-toast";
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 2000);
    } catch (e) {}
  }

  function openManager(tab) {
    /* 兼容旧调用：public→mine（我的字卡），sys→syspool（系统字卡=审批通过池） */
    try {
      if (tab === "public") tab = "mine";
      else if (tab === "sys") tab = "syspool";
      if (tab === "mine" || tab === "per" || tab === "syspool") currentTab = tab;
      buildSheet();
      requestAnimationFrame(function () {
        if (overlayEl && sheetEl) {
          overlayEl.classList.add("is-open");
          sheetEl.classList.add("is-open");
        }
      });
    } catch (e) {
      console.error("[MineCards] openManager failed:", e);
      if (window.MineToast && MineToast.show) MineToast.show("字卡打开失败，请重试");
    }
  }
  function closeManager() {
    if (!sheetEl) return;
    overlayEl.classList.remove("is-open");
    sheetEl.classList.remove("is-open");
  }

  /* ==================== 全部字卡：搜索 / 增删改 ==================== */
  var searchSheetEl = null;
  var searchOverlayEl = null;
  var searchKeyword = "";

  function openSearch() {
    if (!searchSheetEl) {
      searchOverlayEl = document.createElement("div");
      searchOverlayEl.className = "sheet-overlay";
      searchOverlayEl.addEventListener("click", closeSearch);

      searchSheetEl = document.createElement("div");
      searchSheetEl.className = "sheet";
      searchSheetEl.innerHTML =
        '<div class="sheet-handle"></div>' +
        '<div class="sheet-head"><h2>全部字卡</h2>' +
        '<button class="nav-btn" data-act="close">' + I.svg("close", 20) + '</button></div>' +
        '<div class="sheet-body" id="cards-search-body"></div>';
      document.body.appendChild(searchOverlayEl);
      document.body.appendChild(searchSheetEl);
      searchSheetEl.querySelector('[data-act="close"]').addEventListener("click", closeSearch);
    }
    /* 防御：渲染异常不得导致"点了没反应"（死按钮） */
    try {
      renderSearch();
    } catch (e) {
      console.error("[MineCards] renderSearch failed:", e);
      var body = document.getElementById("cards-search-body");
      if (body) body.innerHTML = '<div class="cm-empty">字卡加载失败：' + escapeHtml(String(e && e.message || e)) + '</div>';
    }
    requestAnimationFrame(function () {
      if (searchOverlayEl && searchSheetEl) {
        searchOverlayEl.classList.add("is-open");
        searchSheetEl.classList.add("is-open");
      }
    });
  }
  function closeSearch() {
    if (!searchSheetEl) return;
    searchOverlayEl.classList.remove("is-open");
    searchSheetEl.classList.remove("is-open");
  }

  /** 收集全部字卡：公用 / 系统 / 单独 / 自动回复 */
  function collectAll() {
    var out = [];
    state.public.forEach(function (card, i) {
      out.push({ scope: "public", cid: null, idx: i, card: card, label: "公用字卡" });
    });
    state.sys.forEach(function (card, i) {
      out.push({ scope: "sys", cid: null, idx: i, card: card, label: "我的字卡 · 系统预设" });
    });
    Object.keys(state.per).forEach(function (cid) {
      (state.per[cid] || []).forEach(function (card, i) {
        out.push({ scope: "per", cid: cid, idx: i, card: card, label: "单独 · " + contactName(cid) });
      });
    });
    Object.keys(state.autoPer).forEach(function (cid) {
      (state.autoPer[cid] || []).forEach(function (card, i) {
        out.push({ scope: "auto", cid: cid, idx: i, card: card, label: "自动回复 · " + contactName(cid) });
      });
    });
    return out;
  }

  function searchFilter(card, kw) {
    if (!kw) return true;
    if (isImageCard(card) || isAudioCard(card)) return false;  /* 图片/语音无文本，不参与关键词搜索 */
    return String(card).toLowerCase().indexOf(kw) >= 0;
  }

  function cardPreviewHTML(card) {
    if (isImageCard(card)) return '<img class="sitem-img" src="' + escapeHtml(card) + '" alt="图片字卡">';
    if (isAudioCard(card)) return '<span class="sitem-voice">' + I.svg("mic", 14) + ' 语音</span>';
    if (isEmojiCard(card)) return '<span class="sitem-emoji">' + escapeHtml(card) + '</span>';
    return '<span class="sitem-text">' + escapeHtml(card) + '</span>';
  }

  function renderSearch() {
    var body = document.getElementById("cards-search-body");
    if (!body) return;

    /* 目标选择选项 */
    var targetOpts = '<option value="public">公用字卡</option>' +
      '<option value="sys">系统字卡</option>';
    listContacts().forEach(function (t) {
      var nm = escapeHtml(t.name || t.nickname || t.id);
      targetOpts += '<option value="per:' + escapeHtml(t.id) + '">单独 · ' + nm + '</option>';
    });
    listContacts().forEach(function (t) {
      var nm = escapeHtml(t.name || t.nickname || t.id);
      targetOpts += '<option value="auto:' + escapeHtml(t.id) + '">自动回复 · ' + nm + '</option>';
    });

    var html =
      '<div class="pv-searchbox">' + I.svg("search", 15) +
        '<input type="text" id="card-search-input" placeholder="搜索字卡内容" value="' + escapeHtml(searchKeyword) + '"></div>' +
      '<div class="pv-addrow">' +
        '<select class="card-search-target" id="card-search-target" aria-label="添加目标">' + targetOpts + '</select>' +
        '<input type="text" class="card-input" id="card-search-new" ' +
          'placeholder="输入字卡内容，空格分隔批量添加，回车确认" maxlength="500">' +
        '<button class="pv-addbtn" id="card-search-save">添加</button>' +
      '</div>' +
      '<div class="pv-sysrow"><span class="pv-lbl">系统预设字卡</span>' +
        '<div class="pv-switch' + (getSysAllOn() ? " on" : "") + '" id="pv-syssw"></div></div>' +
      '<div class="pv-filters" id="pv-filters">' + pvFiltersHtml(true) + '</div>' +
      '<div class="pv-list" id="card-search-list"></div>';

    body.innerHTML = html;
    renderSearchList(body);
    renderSearchFilters(body);

    /* 搜索输入实时过滤（防抖 120ms，只重建列表不丢焦点） */
    var searchInput = body.querySelector("#card-search-input");
    var searchTimer = null;
    searchInput.addEventListener("input", function () {
      searchKeyword = searchInput.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { renderSearchList(body); }, 120);
    });
    /* 添加：按空格批量、自动去重 */
    var saveBtn = body.querySelector("#card-search-save");
    saveBtn.addEventListener("click", function () {
      var target = body.querySelector("#card-search-target").value;
      var val = body.querySelector("#card-search-new").value;
      if (!val.trim()) { showToast("请输入字卡内容"); return; }
      var r;
      if (target === "public") r = addPublicCards(val);
      else if (target === "sys") r = addSysCards(val);
      else if (target.indexOf("auto:") === 0) r = addAutoCards(target.slice(5), val);
      else if (target.indexOf("per:") === 0) r = addPerCards(target.slice(4), val);
      var msg = r.added > 0 ? "已添加 " + r.added + " 条" : "";
      if (r.skipped > 0) msg += (msg ? "，" : "") + "跳过重复 " + r.skipped + " 条";
      showToast(msg || "字卡已存在，未重复添加");
      body.querySelector("#card-search-new").value = "";
      renderSearchList(body);
    });
    /* 回车确认：与通讯录联系人主页机制一致 */
    var newInput = body.querySelector("#card-search-new");
    if (newInput) {
      newInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
      });
    }
  }

  /* 全部字卡列表（v2 样式：一行一张 + 来源标记 + 行尾 × 删除；与我的字卡共用系统开关/类型过滤） */
  function renderSearchList(body) {
    var kw = (searchKeyword || "").toLowerCase();
    var on = getSysAllOn();
    var items = collectAll().filter(function (it) {
      if (it.scope === "sys" && !on) return false;
      if (pvFilter !== "all" && cardType(it.card) !== pvFilter) return false;
      return searchFilter(it.card, kw);
    });
    var listEl = body.querySelector("#card-search-list");
    if (!listEl) return;
    if (items.length === 0) {
      listEl.innerHTML = '<div class="pv-empty">' + (kw ? "未找到匹配的字卡" : "暂无字卡") + '</div>';
      return;
    }
    /* 大数据防卡：单次最多渲染 300 条，超出提示（搜索可继续缩小范围） */
    var shown = items.slice(0, 300);
    listEl.innerHTML = shown.map(function (it, j) {
      var txt = isImageCard(it.card) ? "[图片]" : (isAudioCard(it.card) ? "[语音]" : String(it.card));
      return '<div class="pv-crow' + (it.scope === "sys" ? " sys" : "") + '">' +
        '<span class="pv-txt">' + escapeHtml(txt) + '</span>' +
        '<span class="pv-mark">' + escapeHtml(it.label || "") + '</span>' +
        '<span class="pv-del" data-del="' + j + '" aria-label="删除">×</span></div>';
    }).join("");
    if (items.length > 300) {
      listEl.innerHTML += '<div class="pv-empty">共 ' + items.length + ' 条，仅显示前 300 条 · 输入关键词可继续筛选</div>';
    }
    bindSearchList(body, shown);
  }

  /* 全部字卡统计条 + 系统滑块开关（局部更新，不重建搜索框） */
  function renderSearchFilters(body) {
    var f = body.querySelector("#pv-filters");
    if (f) {
      f.innerHTML = pvFiltersHtml(true);
      f.querySelectorAll("[data-pv-filter]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          pvFilter = btn.getAttribute("data-pv-filter");
          renderSearchList(body);
          renderSearchFilters(body);
        });
      });
    }
    var sw = body.querySelector("#pv-syssw");
    if (sw) {
      sw.addEventListener("click", function () {
        setSysAllOn(!getSysAllOn());
        renderSearchList(body);
        renderSearchFilters(body);
      });
    }
  }

  function bindSearchList(body, items) {
    /* 删除（行尾 ×，与我的字卡/系统字卡一致） */
    body.querySelectorAll("[data-del]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var j = parseInt(btn.getAttribute("data-del"), 10);
        var it = items[j];
        var ok = removeCardByScope(it.scope, it.cid, it.idx);
        showToast(ok ? "已删除" : "删除失败");
        renderSearchList(body);
      });
    });
  }

  /* ==================== 初始化 ==================== */
  function init() {
    load();
  }

  return {
    init: init,
    openManager: openManager,
    closeManager: closeManager,
    openSearch: openSearch,
    closeSearch: closeSearch,
    getPublicCards: getPublicCards,
    getPerCards: getPerCards,
    getSysCards: getSysCards,
    getSysAllOn: getSysAllOn,
    setSysAllOn: setSysAllOn,
    isSysCardOn: isSysCardOn,
    setSysCardOn: setSysCardOn,
    getAutoCards: getAutoCards,
    getReplyPool: getReplyPool,
    hasAnyCards: hasAnyCards,
    addPublicCard: addPublicCard,
    addPublicCards: addPublicCards,
    removePublicCard: removePublicCard,
    addSysCard: addSysCard,
    addSysCards: addSysCards,
    removeSysCard: removeSysCard,
    addAutoCard: addAutoCard,
    addAutoCards: addAutoCards,
    removeAutoCard: removeAutoCard,
    removeAutoCardByValue: removeAutoCardByValue,
    addPerCard: addPerCard,
    addPerCards: addPerCards,
    removePerCard: removePerCard,
    removePerCardByValue: removePerCardByValue,
    syncContactCards: syncContactCards,
    updateCard: updateCard,
    removeCardByScope: removeCardByScope,
    isImageCard: isImageCard,
    isAudioCard: isAudioCard,
    isEmojiCard: isEmojiCard,
    getState: function () { return JSON.parse(JSON.stringify(state)); }
  };
})();
