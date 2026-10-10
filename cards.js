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

  var state = { public: [], per: {}, autoPer: {}, sys: [], sysAllOn: true, sysOff: {} };
  var expandedTypes = { text: true, emoji: true, image: true, audio: false, auto: false };  // 类型栏折叠状态

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
  /* 聊天回复使用的字卡池：单独字卡(该联系人) + 公用字卡（系统字卡由 chat.js 单独读取） */
  function getReplyPool(cid) {
    var pool = [];
    if (cid && state.per[cid] && state.per[cid].length) {
      pool = pool.concat(state.per[cid]);
    }
    if (state.public.length) pool = pool.concat(state.public);
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
  /** 单条添加：自动去重 + 排序 + 保存 */
  function addTo(list, v) {
    v = String(v || "").trim();
    if (!v) return false;
    if (list.indexOf(v) >= 0) return false;  // 自动去重
    list.push(v);
    sortList(list);
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
    return addTo(state.autoPer[cid], card);
  }
  function addAutoCards(cid, raw) {
    if (!cid) return { added: 0, skipped: 0 };
    if (!state.autoPer[cid]) state.autoPer[cid] = [];
    return addMany(state.autoPer[cid], raw);
  }
  function removeAutoCard(cid, idx) {
    if (!cid || !state.autoPer[cid]) return false;
    if (idx < 0 || idx >= state.autoPer[cid].length) return false;
    state.autoPer[cid].splice(idx, 1);
    save();
    return true;
  }
  function addPerCard(cid, card) {
    if (!cid) return false;
    if (!state.per[cid]) state.per[cid] = [];
    return addTo(state.per[cid], card);
  }
  function addPerCards(cid, raw) {
    if (!cid) return { added: 0, skipped: 0 };
    if (!state.per[cid]) state.per[cid] = [];
    return addMany(state.per[cid], raw);
  }
  function removePerCard(cid, idx) {
    if (!cid || !state.per[cid]) return false;
    if (idx < 0 || idx >= state.per[cid].length) return false;
    state.per[cid].splice(idx, 1);
    save();
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
  var currentTab = "public";   // "public" | "per"
  var currentCid = null;       // 单独字卡当前选中的联系人

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

    var tabs =
      '<div class="card-tabs">' +
        '<button class="card-tab' + (currentTab === "public" ? " is-active" : "") + '" data-tab="public">公用字卡</button>' +
        '<button class="card-tab' + (currentTab === "per" ? " is-active" : "") + '" data-tab="per">单独字卡</button>' +
        '<button class="card-tab' + (currentTab === "sys" ? " is-active" : "") + '" data-tab="sys">系统字卡</button>' +
      '</div>';

    var content = "";
    if (currentTab === "public") {
      content = renderPublicTab();
    } else if (currentTab === "per") {
      content = renderPerTab();
    } else {
      content = renderSysTab();
    }

    body.innerHTML = tabs + content;
    bindEvents(body);
  }

  /* ---- 公用字卡 tab ---- */
  function renderPublicTab() {
    var html = '<div class="card-hint">公用字卡：所有联系人普通回复时均可使用（不用于自动回复）</div>';
    html += renderCardEditor(state.public, "public", null);
    return html;
  }

  /* ---- 系统字卡 tab：系统预设字卡，可整体 / 单张开关，可自行添加 ---- */
  function renderSysTab() {
    var on = getSysAllOn();
    var html =
      '<div class="card-hint">系统字卡：系统预设字卡，所有联系人回复时均可使用 · 可整体开关 / 单张开关 / 自行添加 · 发送概率可在「概率修改」中调整</div>' +
      '<div class="sys-master-row">' +
        '<span class="sys-master-label">' + (on ? "系统字卡已开启" : "系统字卡已关闭") + '</span>' +
        '<button class="sys-master-toggle' + (on ? " is-on" : "") + '" data-sys-all-toggle aria-pressed="' + (on ? "true" : "false") + '">' +
          (on ? I.svg("close", 14) + '关闭全部' : I.svg("check", 14) + '开启全部') +
        '</button>' +
      '</div>';
    html += renderCardEditor(state.sys, "sys", null, true);
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
    /* 已选择联系人 → 该联系人的单独字卡 */
    html += '<div class="card-current-row">' +
      '<span>当前联系人：' + escapeHtml(contactName(currentCid)) + '</span>' +
      '<button class="card-back" data-pick-back>' + I.svg("back", 14) + ' 切换</button>' +
      '</div>';
    var per = state.per[currentCid] || [];
    html += renderCardEditor(per, "per", currentCid, true);
    return html;
  }

  /* ---- 类型分栏编辑器：每一栏一种字卡类型，点击栏头折叠/展开
       includeAudio=true 时额外显示语音栏（单独字卡）
       单独字卡（scope=per 且有 cid）的"自动回复"栏置顶（在字符字卡上面） ---- */
  function renderCardEditor(list, scope, cid, includeAudio) {
    var groups = [];
    /* 单独字卡：自动回复栏置顶（与字符、emoji 等并列，排最前） */
    if (scope === "per" && cid) {
      var autoList = (state.autoPer[cid] || []).map(function (card, i) {
        return { card: card, idx: i };
      });
      groups.push({ type: "auto", name: "自动回复", icon: "feather", items: autoList });
    }
    groups.push(
      { type: "text",  name: "字符", icon: "feather", items: [] },
      { type: "emoji", name: "emoji", icon: "smile", items: [] },
      { type: "image", name: "图片", icon: "image", items: [] }
    );
    if (includeAudio) {
      groups.push({ type: "audio", name: "语音", icon: "mic", items: [] });
    }
    (list || []).forEach(function (card, i) {
      var entry = { card: card, idx: i };
      if (isImageCard(card)) groups[2].items.push(entry);
      else if (isAudioCard(card)) {
        if (includeAudio) groups[3].items.push(entry);
        else groups[2].items.push(entry);  /* 公用字卡无语音栏时语音并入图片栏 */
      }
      else if (isEmojiCard(card)) groups[1].items.push(entry);
      else groups[0].items.push(entry);
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
      /* 每种类型提供一键导出 / 一键导入 */
      var toolsHtml =
        '<div class="card-type-tools">' +
          '<button class="card-type-tool" data-export-type="' + g.type + '" data-tool-scope="' + scope + '" data-tool-cid="' + (cid || "") + '">' + I.svg("download", 13) + '导出</button>' +
          '<button class="card-type-tool" data-import-type="' + g.type + '" data-tool-scope="' + scope + '" data-tool-cid="' + (cid || "") + '">' + I.svg("upload", 13) + '导入</button>' +
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
    return '<div class="card-list">' + items.map(function (entry) {
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
      var sysToggle = scope === "sys"
        ? '<button class="card-sys-toggle' + (isSysCardOn(card) ? " is-on" : "") + '" data-sys-toggle-idx="' + entry.idx + '" ' +
          'aria-label="' + (isSysCardOn(card) ? "关闭此系统字卡" : "开启此系统字卡") + '">' +
          (isSysCardOn(card) ? I.svg("check", 13) : '') +
          '</button>'
        : '';
      return '<div class="card-item' + (isAudioCard(card) ? " is-voice" : "") + '">' + inner + sysToggle +
        '<button class="card-del" data-del-scope="' + scope + '" data-del-cid="' + (cid || "") + '" data-del-idx="' + entry.idx + '" ' +
        'aria-label="删除">' + I.svg("trash", 16) + '</button></div>';
    }).join("") + '</div>';
  }

  /* ---- 某类型的添加行 ---- */
  function renderTypeAddRow(type, scope, cid) {
    var data = 'data-add-scope="' + scope + '" data-add-cid="' + (cid || "") + '"';
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
      btn.addEventListener("click", function () { doAddFromInput(btn, input); });
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
    if (tab === "public" || tab === "per" || tab === "sys") currentTab = tab;
    buildSheet();
    requestAnimationFrame(function () {
      overlayEl.classList.add("is-open");
      sheetEl.classList.add("is-open");
    });
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
    renderSearch();
    requestAnimationFrame(function () {
      searchOverlayEl.classList.add("is-open");
      searchSheetEl.classList.add("is-open");
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
      out.push({ scope: "sys", cid: null, idx: i, card: card, label: "系统字卡" });
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
      '<div class="card-search-row">' +
        '<span class="card-search-icon">' + I.svg("search", 16) + '</span>' +
        '<input type="text" class="card-search-input" id="card-search-input" ' +
          'placeholder="搜索字卡内容" value="' + escapeHtml(searchKeyword) + '">' +
        '<button class="card-search-add-btn" id="card-search-open-add">' + I.svg("plus", 16) + ' 添加</button>' +
      '</div>' +
      '<div class="card-search-addbox" id="card-search-addbox" style="display:none;">' +
        '<div class="card-add-row">' +
          '<select class="card-search-target" id="card-search-target">' + targetOpts + '</select>' +
        '</div>' +
        '<div class="card-add-row">' +
          '<input type="text" class="card-input" id="card-search-new" ' +
            'placeholder="输入字卡内容，空格分隔可批量添加 · 回车确认" maxlength="500">' +
          '<button class="card-add-btn" id="card-search-save" aria-label="保存">' + I.svg("check", 18) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="card-search-list" id="card-search-list"></div>';

    body.innerHTML = html;

    var kw = searchKeyword.toLowerCase();
    var items = collectAll().filter(function (it) { return searchFilter(it.card, kw); });
    var listEl = body.querySelector("#card-search-list");
    if (items.length === 0) {
      listEl.innerHTML = '<div class="cards-empty">' + (kw ? "未找到匹配的字卡" : "暂无字卡") + '</div>';
    } else {
      listEl.innerHTML = items.map(function (it, j) {
        return '<div class="sitem" data-row="' + j + '">' +
          '<div class="sitem-main">' +
            '<div class="sitem-preview">' + cardPreviewHTML(it.card) + '</div>' +
            '<div class="sitem-info">' +
              '<span class="sitem-tag">' + escapeHtml(it.label) + '</span>' +
              '<span class="sitem-idx">#' + (it.idx + 1) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="sitem-actions">' +
            '<button class="sitem-btn" data-edit="' + j + '">' + I.svg("pencil", 14) + ' 修改</button>' +
            '<button class="sitem-btn is-danger" data-del="' + j + '">' + I.svg("trash", 14) + ' 删除</button>' +
          '</div>' +
        '</div>';
      }).join("");
      bindSearchList(body, items);
    }

    /* 搜索输入实时过滤 */
    var searchInput = body.querySelector("#card-search-input");
    searchInput.addEventListener("input", function () {
      searchKeyword = searchInput.value;
      renderSearch();
    });
    /* 展开/收起添加区 */
    var openAdd = body.querySelector("#card-search-open-add");
    var addBox = body.querySelector("#card-search-addbox");
    openAdd.addEventListener("click", function () {
      var show = addBox.style.display === "none";
      addBox.style.display = show ? "block" : "none";
      if (show) body.querySelector("#card-search-new").focus();
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
      renderSearch();
    });
    /* 回车确认：与通讯录联系人主页机制一致 */
    var newInput = body.querySelector("#card-search-new");
    if (newInput) {
      newInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
      });
    }
  }

  function bindSearchList(body, items) {
    /* 修改：行内编辑 */
    body.querySelectorAll("[data-edit]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var row = btn.closest(".sitem");
        var j = parseInt(btn.getAttribute("data-edit"), 10);
        var it = items[j];
        var prev = row.querySelector(".sitem-preview");
        prev.innerHTML =
          '<input type="text" class="card-input sitem-edit-input" value="' +
          (isImageCard(it.card) || isAudioCard(it.card) ? "" : escapeHtml(it.card)) +
          '" placeholder="输入新内容">';
        row.querySelector(".sitem-actions").innerHTML =
          '<button class="sitem-btn is-primary" data-save="' + j + '">' + I.svg("check", 14) + ' 保存</button>' +
          '<button class="sitem-btn" data-cancel>取消</button>';
        var saveBtn = row.querySelector("[data-save]");
        var cancelBtn = row.querySelector("[data-cancel]");
        cancelBtn.addEventListener("click", function () { renderSearch(); });
        saveBtn.addEventListener("click", function () {
          var input = row.querySelector(".sitem-edit-input");
          var v = input.value;
          if (!v.trim()) { showToast("内容不能为空"); return; }
          var ok = updateCard(it.scope, it.cid, it.idx, v);
          showToast(ok ? "已修改" : "修改失败：内容为空或与其他字卡重复");
          renderSearch();
        });
        input && setTimeout(function () { input.focus(); }, 50);
      });
    });
    /* 删除 */
    body.querySelectorAll("[data-del]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var j = parseInt(btn.getAttribute("data-del"), 10);
        var it = items[j];
        var ok = removeCardByScope(it.scope, it.cid, it.idx);
        showToast(ok ? "已删除" : "删除失败");
        renderSearch();
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
    addPerCard: addPerCard,
    addPerCards: addPerCards,
    removePerCard: removePerCard,
    updateCard: updateCard,
    removeCardByScope: removeCardByScope,
    isImageCard: isImageCard,
    isAudioCard: isAudioCard,
    isEmojiCard: isEmojiCard,
    getState: function () { return JSON.parse(JSON.stringify(state)); }
  };
})();
