/* ========================================================================
   Mine · 概率修改（个人中心）
   ------------------------------------------------------------------------
   所有系统预设概率均可自行修改（0% ~ 100%），通过加减号或打字输入。
   数据存储于 localStorage "mine.probabilities.v1"：
       { imageCard: 5, emojiCard: 10, audioCard: 3, emojiAttach: 15,
         silentChance: 1, groupSecond: 40 }
   聊天模块（chat.js）通过 get(key) 实时读取（除以 100 后使用）。
   ======================================================================== */

window.MineProbs = (function () {
  "use strict";

  var I = window.MineIcons;
  var U = window.MineUtils;
  var STORE_KEY = "mine.probabilities.v1";

  /* 系统预设概率一览（key: 默认值(百分比，允许小数)） */
  var DEFAULTS = {
    /* —— 聊天 —— */
    imageCard:     5,   // 图片字卡发送概率
    emojiCard:    10,   // emoji 字卡发送概率
    audioCard:     3,   // 语音字卡发送概率
    sysCard:      10,   // 系统字卡发送概率（所有联系人可用）
    emojiAttach:  15,   // 文字字卡附带 emoji 概率
    silentChance:  1,   // 自动回复沉默概率
    groupSecond:  40,   // 群聊(≤2人)第二条回复概率
    groupThird:   15,   // 群聊(≥3人)第三条回复概率
    groupAll:      5,   // 群聊(≥3人)全员回复概率
    /* —— 电话 —— */
    phoneIncoming:        0.5,  // 联系人主动来电概率
    phoneHangup:          2,    // 呼出时对方直接挂断概率
    phoneCardMsg:         49,   // 挂断后附字卡留言概率
    phoneVoiceMsg:        49,   // 挂断后附语音留言概率
    phoneMissedCard:      49,   // 未接来电后附字卡留言概率
    phoneMissedVoice:     49,   // 未接来电后附语音留言概率
    phoneAutoRatio:       70,   // 留言中自动回复字卡占比
    phoneEmojiAttach:     2,    // 字卡留言附赠 emoji 概率
    phoneConnectedHangup: 1,    // 通话中对方主动挂断概率
    phoneGroupInvite1:    10,   // 群电话邀请 1 人概率
    phoneGroupInvite2:    35,   // 群电话邀请 2 人概率
    phoneGroupCall:       0.5,  // 群成员发起通话概率
    phoneNormal1:         75,   // 字卡留言发 1 条概率
    phoneNormal2:         20,   // 字卡留言发 2 条概率
    phoneVoice1:          70,   // 语音留言发 1 条概率
    phoneVoice2:          20,   // 语音留言发 2 条概率
    phoneEmoji2:          20    // 附赠 2 个 emoji 概率
  };

  var state = null;

  function cloneDefaults() {
    var s = {};
    for (var k in DEFAULTS) s[k] = DEFAULTS[k];
    return s;
  }
  function clamp(v) {
    v = parseFloat(v);
    if (isNaN(v)) return 0;
    if (v < 0) return 0;
    if (v > 100) return 100;
    return v;
  }
  function load() {
    if (state) return;
    state = cloneDefaults();
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && typeof d === "object") {
          for (var k in DEFAULTS) {
            if (typeof d[k] === "number" && !isNaN(d[k])) state[k] = clamp(d[k]);
          }
        }
      }
    } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /** 读取某个概率（0~100，允许一位小数），供 chat.js 使用 */
  function get(key) {
    load();
    if (state[key] === undefined) return DEFAULTS[key] !== undefined ? DEFAULTS[key] : 0;
    return state[key];
  }
  function set(key, value) {
    load();
    if (DEFAULTS[key] === undefined) return false;
    /* 统一保留一位小数（0~100%） */
    state[key] = Math.round(clamp(value) * 10) / 10;
    save();
    return true;
  }
  function resetAll() {
    load();
    state = cloneDefaults();
    save();
    return true;
  }

  /* ==================== 页内分栏（个人中心「概率」下直接展开，不再弹窗） ==================== */
  var currentTab = "cards";   // "cards"（字卡概率）| "phone"（电话概率）

  /** 数值展示：去除多余小数位，如 0.5 / 5 */
  function fmt(v) {
    var n = Math.round((parseFloat(v) || 0) * 10) / 10;
    return String(n);
  }

  /* 分组：字卡 / 电话（分栏通过 tab 切换显示） */
  var GROUPS = [
    {
      key: "cards",
      title: "字卡概率",
      items: [
        { key: "imageCard",    name: "图片字卡发送", desc: "对方回复时发送图片字卡的概率" },
        { key: "emojiCard",    name: "emoji 字卡发送", desc: "对方回复时发送 emoji 字卡的概率" },
        { key: "audioCard",    name: "语音字卡发送", desc: "对方回复时发送语音字卡的概率" },
        { key: "sysCard",      name: "系统字卡发送", desc: "回复时发送系统字卡的概率（所有联系人可用）" },
        { key: "emojiAttach",  name: "文字附带 emoji", desc: "文字回复时附带 emoji 字卡的概率" },
        { key: "silentChance", name: "自动回复沉默", desc: "触发自动回复（而非普通回复）的概率" },
        { key: "groupSecond",  name: "群聊第二条回复", desc: "群聊出现第二条回复的概率（任意人数群聊均生效，需至少 2 人可回复）" },
        { key: "groupThird",   name: "群聊第三条回复", desc: "群聊出现第三条回复的概率（需至少 3 人可回复）" },
        { key: "groupAll",     name: "群聊全员回复", desc: "群聊全部成员都回复的概率（需至少 4 人可回复）" }
      ]
    },
    {
      key: "phone",
      title: "电话概率",
      items: [
        { key: "phoneIncoming",        name: "主动来电", desc: "联系人每小时主动来电的概率" },
        { key: "phoneHangup",          name: "呼出被挂断", desc: "拨出时对方直接挂断的概率" },
        { key: "phoneCardMsg",         name: "挂断后字卡留言", desc: "呼出被挂断后附赠字卡留言的概率" },
        { key: "phoneVoiceMsg",        name: "挂断后语音留言", desc: "呼出被挂断后附赠语音留言的概率" },
        { key: "phoneMissedCard",      name: "未接后字卡留言", desc: "未接来电后附赠字卡留言的概率" },
        { key: "phoneMissedVoice",     name: "未接后语音留言", desc: "未接来电后附赠语音留言的概率" },
        { key: "phoneAutoRatio",       name: "留言用自动回复字卡", desc: "字卡留言中自动回复字卡占比" },
        { key: "phoneEmojiAttach",     name: "留言附赠 emoji", desc: "字卡留言附赠 emoji 的概率" },
        { key: "phoneConnectedHangup", name: "通话中对方挂断", desc: "通话中对方主动挂断的概率（每 20 分钟检查一次）" },
        { key: "phoneGroupInvite1",    name: "群电话邀请 1 人", desc: "群成员发起通话时邀请 1 人的概率" },
        { key: "phoneGroupInvite2",    name: "群电话邀请 2 人", desc: "群成员发起通话时邀请 2 人的概率" },
        { key: "phoneGroupCall",       name: "群成员发起通话", desc: "每个群每小时抽取成员发起通话的概率" },
        { key: "phoneNormal1",         name: "字卡留言发 1 条", desc: "普通字卡留言发送 1 条的概率" },
        { key: "phoneNormal2",         name: "字卡留言发 2 条", desc: "普通字卡留言发送 2 条的概率" },
        { key: "phoneVoice1",          name: "语音留言发 1 条", desc: "语音留言发送 1 条的概率" },
        { key: "phoneVoice2",          name: "语音留言发 2 条", desc: "语音留言发送 2 条的概率" },
        { key: "phoneEmoji2",          name: "附赠 2 个 emoji", desc: "字卡留言附赠 2 个 emoji 的概率" }
      ]
    }
  ];

  /** 渲染页内分栏（挂在个人中心「概率修改」行下方） */
  function renderInline(container) {
    if (!container) return;
    load();

    /* 分栏 tab：字卡概率 / 电话概率 */
    var tabs =
      '<div class="prob-tabs">' +
        '<button class="card-tab' + (currentTab === "cards" ? " is-active" : "") + '" data-tab="cards">字卡概率</button>' +
        '<button class="card-tab' + (currentTab === "phone" ? " is-active" : "") + '" data-tab="phone">电话概率</button>' +
      '</div>';

    var html = tabs +
      '<div class="card-hint">修改范围为 0~100%，支持一位小数（如 0.5%），点击加减号或直接输入数字，立即生效</div>';
    GROUPS.forEach(function (g) {
      if (g.key !== currentTab) return;
      html += '<div class="prob-group-title">' + g.title + '</div>';
      html += '<div class="prob-list">' + g.items.map(function (it) {
        var val = state[it.key];
        return '<div class="prob-item">' +
          '<div class="prob-head">' +
            '<span class="prob-name">' + it.name + '</span>' +
            '<span class="prob-value">' + fmt(val) + '%</span>' +
          '</div>' +
          '<div class="prob-desc">' + it.desc + '</div>' +
          '<div class="prob-ctl">' +
            '<button class="prob-step" data-step="' + it.key + '" data-delta="-1" aria-label="减">' + I.svg("minus", 18) + '</button>' +
            '<input type="number" class="prob-input" data-key="' + it.key + '" min="0" max="100" step="0.1" value="' + fmt(val) + '">' +
            '<span class="prob-unit">%</span>' +
            '<button class="prob-step" data-step="' + it.key + '" data-delta="1" aria-label="加">' + I.svg("plus", 18) + '</button>' +
            '<button class="prob-step" data-step="' + it.key + '" data-delta="-5" aria-label="减5">' + I.svg("minus", 18) + '5</button>' +
            '<button class="prob-step" data-step="' + it.key + '" data-delta="5" aria-label="加5">' + I.svg("plus", 18) + '5</button>' +
          '</div>' +
        '</div>';
      }).join("") + '</div>';
    });

    html += '<div class="prob-reset-wrap">' +
      '<button class="btn btn-block" data-act="reset-probs">' + I.svg("refresh", 16) + ' 恢复默认</button>' +
      '</div>';

    container.innerHTML = html;
    bindInline(container);
  }

  function bindInline(container) {
    /* 分栏 tab：字卡概率 / 电话概率 */
    container.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        currentTab = btn.getAttribute("data-tab");
        renderInline(container);
      });
    });

    /* 加减号（±1 / ±5） */
    container.querySelectorAll("[data-step]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-step");
        var delta = parseFloat(btn.getAttribute("data-delta"));
        set(key, get(key) + delta);
        var input = container.querySelector('[data-key="' + key + '"]');
        if (input) input.value = fmt(get(key));
        var row = input ? input.closest(".prob-item") : null;
        if (row) row.querySelector(".prob-value").textContent = fmt(get(key)) + "%";
      });
    });

    /* 打字输入（支持一位小数） */
    container.querySelectorAll(".prob-input").forEach(function (input) {
      var commit = function () {
        var key = input.getAttribute("data-key");
        var v = parseFloat(input.value);
        if (isNaN(v)) { input.value = fmt(get(key)); return; }
        set(key, v);
        input.value = fmt(get(key));
        var row = input.closest(".prob-item");
        if (row) row.querySelector(".prob-value").textContent = fmt(get(key)) + "%";
      };
      input.addEventListener("change", commit);
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
      });
    });

    /* 恢复默认 */
    var resetBtn = container.querySelector('[data-act="reset-probs"]');
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        resetAll();
        renderInline(container);
        showToast("已恢复默认概率");
      });
    }
  }

  function showToast(msg) {
    try {
      if (U && U.showToast) { U.showToast(msg); return; }
    } catch (e) {}
    try {
      var t = document.createElement("div");
      t.className = "mini-toast";
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 2000);
    } catch (e) {}
  }

  /* ==================== 初始化 ==================== */
  function init() {
    load();
  }

  return {
    init: init,
    renderInline: renderInline,
    get: get,
    set: set,
    resetAll: resetAll,
    getDefaults: function () { return JSON.parse(JSON.stringify(DEFAULTS)); },
    getState: function () { load(); return JSON.parse(JSON.stringify(state)); }
  };
})();
