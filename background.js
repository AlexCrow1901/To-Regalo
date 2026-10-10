/* ========================================================================
   Mine · 背景管理器（v14）
   ------------------------------------------------------------------------
   功能（微信式视觉管理，入口在"个人中心 → 背景"）：
   · 白天 | 黑夜：白天 = 奶油软拟态，黑夜 = 纯黑
   · 自定义图片分作用域应用：
       global  系统网页背景（主界面全局）
       moments 朋友圈页面背景
       contact 指定联系人聊天背景（按联系人）
       group   指定群聊聊天背景（按群）
     支持"全部同时更换"或单个更换，每个作用域可单独清除
   · 字体样式（默认/圆体/宋体/楷体/等宽/自定义）+ 字体颜色（白/黑/米白/浅蓝/浅绿/自定义）
     自定义 = 输入字体样式编码（font-family）或颜色编码（#hex）即可新增
   · 持久化：图片数据存 IndexedDB "mine-bg"（容量大，修复"自定义背景
     闪现一下就消失"：旧 localStorage 5MB 配额写入大图静默失败导致刷新即失）；
     localStorage 仅存元数据（模式/字体设置/自定义编码），旧数据自动迁移
   ======================================================================== */

window.MineBackground = (function () {
  "use strict";

  var STORE_KEY = "mine.bg.v1";

  /* 作用域定义 */
  var SCOPES = [
    { id: "global",  name: "系统网页", desc: "主界面全局背景" },
    { id: "moments", name: "朋友圈",   desc: "朋友圈页面背景" },
    { id: "contact", name: "联系人聊天", desc: "指定联系人的聊天背景" },
    { id: "group",   name: "群聊",     desc: "指定群聊的聊天背景" }
  ];

  var state = {
    mode: "day",        // day=白天(奶油) | night=黑夜(纯黑)
    custom: {           // 各作用域自定义背景（dataURL，存 IndexedDB）
      global: null,
      moments: null,
      contact: {},      // { cid: url }
      group: {}         // { gid: url }
    },
    fontStyle: "default",
    fontColor: "black",
    customFontStyle: "",   // 自定义字体编码（font-family css）
    customFontColor: ""    // 自定义颜色编码（#hex）
  };

  var el = {};              // 背景层 DOM
  var sheetEl = null;       // 管理面板
  var overlayEl = null;
  var pendingImage = null;  // 待应用图片（上传后、选择作用域前暂存）

  /* ==================== IndexedDB（图片数据） ====================
     图片 dataURL 较大，localStorage 5MB 配额写失败会被静默吞掉，
     导致"背景闪现一下就消失"。改用 IDB 持久化。 */
  var DB_NAME = "mine-bg";
  function bgDbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        try {
          if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
        } catch (e) {}
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbPut(key, val) {
    return bgDbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction("kv", "readwrite");
          tx.objectStore("kv").put(val, key);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        } catch (e) { reject(e); }
      });
    });
  }
  function idbGet(key) {
    return bgDbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction("kv", "readonly");
          var rq = tx.objectStore("kv").get(key);
          rq.onsuccess = function () { resolve(rq.result); };
          rq.onerror = function () { reject(rq.error); };
        } catch (e) { reject(e); }
      });
    });
  }

  /* ==================== 持久化 ==================== */
  function save() {
    /* 图片 → IDB（异步、幂等；失败静默——内存仍保留，刷新后有 IDB 兜底） */
    idbPut("global", state.custom.global).catch(function () {});
    idbPut("moments", state.custom.moments).catch(function () {});
    idbPut("contact", state.custom.contact).catch(function () {});
    idbPut("group", state.custom.group).catch(function () {});
    /* 元数据 → localStorage */
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        mode: state.mode,
        fontStyle: state.fontStyle,
        fontColor: state.fontColor,
        customFontStyle: state.customFontStyle,
        customFontColor: state.customFontColor
      }));
    } catch (e) {}
  }
  function load(cb) {
    var data = null;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (e) {}
    if (data) {
      state.mode = data.mode === "night" ? "night" : "day";
      state.fontStyle = (data.fontStyle && FONT_STYLES[data.fontStyle]) ? data.fontStyle : "default";
      state.fontColor = (data.fontColor && FONT_COLORS[data.fontColor]) ? data.fontColor : "black";
      state.customFontStyle = (typeof data.customFontStyle === "string") ? data.customFontStyle : "";
      state.customFontColor = (typeof data.customFontColor === "string") ? data.customFontColor : "";
    }
    /* 旧版 localStorage 内嵌图片（v11 及更早）→ 迁移到 IDB */
    var legacy = null;
    if (data && data.custom && typeof data.custom === "object") {
      legacy = {
        global: data.custom.global || null,
        moments: data.custom.moments || null,
        contact: (data.custom.contact && typeof data.custom.contact === "object") ? data.custom.contact : {},
        group: (data.custom.group && typeof data.custom.group === "object") ? data.custom.group : {}
      };
    } else if (data && data.customUrl) {
      legacy = { global: data.customUrl || null, moments: null, contact: {}, group: {} };
    }
    state.custom = { global: null, moments: null, contact: {}, group: {} };

    /* 从 IDB 取回图片（异步） */
    Promise.all([idbGet("global"), idbGet("moments"), idbGet("contact"), idbGet("group")])
      .then(function (vals) {
        state.custom.global = vals[0] || (legacy && legacy.global) || null;
        state.custom.moments = vals[1] || (legacy && legacy.moments) || null;
        state.custom.contact = (vals[2] && typeof vals[2] === "object")
          ? vals[2]
          : ((legacy && legacy.contact) || {});
        state.custom.group = (vals[3] && typeof vals[3] === "object")
          ? vals[3]
          : ((legacy && legacy.group) || {});
        /* 旧数据迁移入库 */
        if (legacy) {
          if (legacy.global) idbPut("global", legacy.global).catch(function () {});
          if (legacy.moments) idbPut("moments", legacy.moments).catch(function () {});
          if (legacy.contact && Object.keys(legacy.contact).length) idbPut("contact", legacy.contact).catch(function () {});
          if (legacy.group && Object.keys(legacy.group).length) idbPut("group", legacy.group).catch(function () {});
        }
        /* 会话背景同步到 chat.js（其内部也走 IDB，幂等） */
        syncChatBgs();
        apply();
        if (cb) cb();
      })
      .catch(function () {
        /* IDB 不可用 → 用旧 localStorage 数据兜底 */
        if (legacy) {
          state.custom.global = legacy.global;
          state.custom.moments = legacy.moments;
          state.custom.contact = legacy.contact;
          state.custom.group = legacy.group;
        }
        syncChatBgs();
        apply();
        if (cb) cb();
      });
  }
  function syncChatBgs() {
    if (!window.MineChat || !window.MineChat.setConvBg) return;
    try {
      Object.keys(state.custom.contact).forEach(function (cid) {
        MineChat.setConvBg("contact:" + cid, state.custom.contact[cid]);
      });
      Object.keys(state.custom.group).forEach(function (gid) {
        MineChat.setConvBg("group:" + gid, state.custom.group[gid]);
      });
    } catch (e) {}
  }

  /* ==================== 应用背景层 ==================== */
  function applyGlobalBg() {
    var bg = el.image;
    if (!bg) return;
    var url = state.custom.global;
    if (url) {
      bg.style.backgroundImage = "url('" + url + "')";
      bg.classList.add("is-active", "is-img");
      bg.style.filter = "none";
      bg.style.transform = "scale(1)";
    } else {
      bg.classList.remove("is-active", "is-img");
      bg.style.backgroundImage = "none";
    }
  }
  /* 应用朋友圈背景（moments.js 渲染完成后也会调用） */
  function applyPageBg(scope, pageEl) {
    if (!pageEl) return;
    if (scope === "moments") {
      var url = state.custom.moments;
      if (url) {
        pageEl.style.backgroundImage = "url('" + url + "')";
        pageEl.style.backgroundSize = "cover";
        pageEl.style.backgroundPosition = "center";
        pageEl.classList.add("has-page-bg");
      } else {
        pageEl.style.backgroundImage = "";
        pageEl.classList.remove("has-page-bg");
      }
    }
  }
  function apply() {
    applyGlobalBg();
    applyPageBg("moments", document.getElementById("page-moments"));
    applyFontColor();
    applyFontStyle();
    save();
    syncManagerUI();
  }

  /* ==================== 白天 / 黑夜模式 ====================
     白天 = 奶油软拟态（neumorphism），黑夜 = 纯黑（fog + theme-night）。 */
  function applyMode() {
    if (!window.MineTheme) return;
    var want = state.mode === "night" ? "fog" : "neumorphism";
    if (window.MineTheme.getTheme() !== want) {
      window.MineTheme.switchTheme(want);
    }
  }
  function setMode(m) {
    if (m !== "day" && m !== "night") return;
    state.mode = m;
    applyMode();
    /* 模式联动字体颜色：白天=黑色字，黑夜=白色字 */
    state.fontColor = (m === "day") ? "black" : "white";
    applyFontColor();
    save();
    syncManagerUI();
  }
  function toggleMode() {
    setMode(state.mode === "day" ? "night" : "day");
  }

  /* ==================== 分作用域自定义背景 ====================
     scope: global | moments | contact | group
     key:   contact/group 时为联系人 id / 群 id，其余忽略
     url:   空 = 清除该作用域背景 */
  function setCustomBg(scope, key, url) {
    if (scope === "global") {
      state.custom.global = url || null;
    } else if (scope === "moments") {
      state.custom.moments = url || null;
    } else if (scope === "contact" || scope === "group") {
      if (!key) return;
      var map = state.custom[scope];
      if (url) map[key] = url;
      else delete map[key];
      /* 同步到聊天背景系统（chat.js，内部走 IDB） */
      if (window.MineChat && window.MineChat.setConvBg) {
        window.MineChat.setConvBg((scope === "contact" ? "contact:" : "group:") + key, url);
      }
    } else {
      return;
    }
    apply();
  }
  function getScopeBg(scope, key) {
    if (scope === "global") return state.custom.global || null;
    if (scope === "moments") return state.custom.moments || null;
    if (scope === "contact" || scope === "group") {
      return (state.custom[scope] && state.custom[scope][key]) || null;
    }
    return null;
  }
  function clearScopeBg(scope, key) { setCustomBg(scope, key, null); }
  /* 全部同时更换：同一张图应用到所有作用域 */
  function setAllBg(url) {
    state.custom.global = url;
    state.custom.moments = url;
    try {
      if (window.MineContacts && MineContacts.getState) {
        /* 通讯录是懒加载：未打开过通讯录页时内存为空，
           必须先 loadData() 才能拿到联系人/群，否则聊天背景会被静默跳过 */
        if (MineContacts.loadData) MineContacts.loadData();
        var st = MineContacts.getState();
        (st.contacts || []).forEach(function (c) {
          if (c && c.id) state.custom.contact[c.id] = url;
        });
        (st.groups || []).forEach(function (g) {
          if (g && g.id) state.custom.group[g.id] = url;
        });
      }
    } catch (e) {}
    /* 同步所有会话背景到 chat.js */
    syncChatBgs();
    apply();
  }

  /* ==================== 上传 ====================
     压缩更小（800px / 0.72），控制 dataURL 体积，进一步降低存储压力 */
  function upload(file, cb) {
    if (!file || !/^image\//.test(file.type)) { if (cb) cb(null); return; }
    window.MineUtils.compressImage(file, 800, 0.72, function (dataURL) {
      if (!dataURL) { if (cb) cb(null); return; }
      if (cb) cb(dataURL);
    });
  }

  /* ==================== 字体样式 ==================== */
  var FONT_STYLES = {
    default: { name: "默认", char: "默", css: "" },
    rounded: { name: "圆体", char: "圆",
      css: "'Yuanti SC','YouYuan','PingFang SC','Microsoft YaHei',system-ui,sans-serif" },
    songti:  { name: "宋体", char: "宋",
      css: "'Songti SC','SimSun','宋体',serif" },
    kai:     { name: "楷体", char: "楷",
      css: "'Kaiti SC','KaiTi','楷体',serif" },
    mono:    { name: "等宽", char: "码",
      css: "'SF Mono','Consolas','Menlo',monospace" },
    custom:  { name: "自定义", char: "自", css: "" }
  };
  function applyFontStyle() {
    /* 设到 body 而非 html：body 上可能有主题规则（如 theme-neumorphism 定义
       文字变量），body inline 优先级最高，可确保全局文字样式真实生效 */
    var root = document.body;
    var css = "";
    if (state.fontStyle === "custom") {
      css = state.customFontStyle || "";
    } else {
      css = FONT_STYLES[state.fontStyle] ? FONT_STYLES[state.fontStyle].css : "";
    }
    if (css) root.style.setProperty("--font-base", css);
    else root.style.removeProperty("--font-base");
  }
  function setFontStyle(style) {
    if (!FONT_STYLES[style]) return;
    state.fontStyle = style;
    applyFontStyle();
    save();
    syncManagerUI();
  }
  function setCustomFontStyle(css) {
    var v = String(css || "").trim();
    if (!v) { showToast("请输入字体样式编码"); return false; }
    state.customFontStyle = v;
    state.fontStyle = "custom";
    applyFontStyle();
    save();
    syncManagerUI();
    return true;
  }

  /* ==================== 字体颜色 ==================== */
  function hexToRgba(hex, alpha) {
    var h = String(hex || "").trim().replace(/^#/, "");
    if (!h) return null;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + alpha + ")";
  }
  var FONT_COLORS = {
    white: { name: "白色",
      "--t-primary":   "#dde3e6",
      "--t-secondary": "#aab1b6",
      "--t-tertiary":  "#71787d",
      "--t-faint":     "#565c61" },
    black: { name: "黑色",
      "--t-primary":   "#1a1a1a",
      "--t-secondary": "#3a3a3a",
      "--t-tertiary":  "#6a6a6a",
      "--t-faint":     "#9a9a9a" },
    cream: { name: "米白",
      "--t-primary":   "#efe9dc",
      "--t-secondary": "#c9bfa8",
      "--t-tertiary":  "#9c917c",
      "--t-faint":     "#7a7160" },
    azure: { name: "浅蓝",
      "--t-primary":   "#d6e4ee",
      "--t-secondary": "#a9c2d4",
      "--t-tertiary":  "#7d97ab",
      "--t-faint":     "#647c8e" },
    sage:  { name: "浅绿",
      "--t-primary":   "#dde8d8",
      "--t-secondary": "#b3c9ab",
      "--t-tertiary":  "#8ba383",
      "--t-faint":     "#718a6a" },
    custom: { name: "自定义", isCustom: true }
  };
  function applyFontColor() {
    /* 设到 body（inline 优先于 body 上的主题变量规则），确保字体颜色真实生效 */
    var root = document.body;
    if (state.fontColor === "custom" && state.customFontColor) {
      var c = state.customFontColor;
      root.style.setProperty("--t-primary",   hexToRgba(c, 1));
      root.style.setProperty("--t-secondary", hexToRgba(c, 0.78));
      root.style.setProperty("--t-tertiary",  hexToRgba(c, 0.55));
      root.style.setProperty("--t-faint",     hexToRgba(c, 0.4));
      return;
    }
    var vars = FONT_COLORS[state.fontColor] || FONT_COLORS.black;
    Object.keys(vars).forEach(function (k) {
      if (k === "name" || k === "isCustom") return;
      root.style.setProperty(k, vars[k]);
    });
  }
  function setFontColor(color) {
    if (!FONT_COLORS[color]) return;
    state.fontColor = color;
    applyFontColor();
    save();
    syncManagerUI();
  }
  function setCustomFontColor(hex) {
    var v = String(hex || "").trim();
    if (!hexToRgba(v, 1)) { showToast("颜色编码格式不对，示例：#7c3aed"); return false; }
    state.customFontColor = v;
    state.fontColor = "custom";
    applyFontColor();
    save();
    syncManagerUI();
    return true;
  }

  /* ==================== 面板（底部 Sheet） ==================== */
  function buildSheet() {
    if (sheetEl) return;

    overlayEl = document.createElement("div");
    overlayEl.className = "sheet-overlay";
    overlayEl.addEventListener("click", closeManager);

    sheetEl = document.createElement("div");
    sheetEl.className = "sheet";
    sheetEl.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-head"><h2>背景</h2>' +
      '<button class="nav-btn" data-act="close">' + window.MineIcons.svg("close", 20) + '</button></div>' +
      '<div class="sheet-body" id="bg-sheet-body"></div>';

    document.body.appendChild(overlayEl);
    document.body.appendChild(sheetEl);

    sheetEl.querySelector('[data-act="close"]').addEventListener("click", closeManager);
    renderManager();
  }

  /* 联系人 / 群列表（供作用域选择）
     通讯录是懒加载：未打开过通讯录页时数据为空 → 先强制 loadData()，
     保证"选择指定联系人"始终可用 */
  function listTargets(kind) {
    try {
      if (window.MineContacts) {
        if (MineContacts.loadData) MineContacts.loadData();
        if (MineContacts.getState) {
          var st = MineContacts.getState();
          if (kind === "contact") return st.contacts || [];
          if (kind === "group") return st.groups || [];
        }
      }
    } catch (e) {}
    return [];
  }
  function targetName(kind, id) {
    var list = listTargets(kind);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i].name || list[i].nickname || id;
    }
    return id;
  }

  function renderManager() {
    var body = document.getElementById("bg-sheet-body");
    if (!body) return;

    /* 1. 白天 | 黑夜 */
    var modeHtml =
      '<div class="section-label">模式</div>' +
      '<div class="mode-row">' +
        '<button class="mode-btn' + (state.mode === "day" ? " is-active" : "") + '" data-mode="day">' +
          '<span class="mode-swatch mode-day"></span><span>白天</span></button>' +
        '<button class="mode-btn' + (state.mode === "night" ? " is-active" : "") + '" data-mode="night">' +
          '<span class="mode-swatch mode-night"></span><span>黑夜</span></button>' +
      '</div>';

    /* 2. 自定义图片上传 + 作用域选择 */
    var uploadHtml =
      '<div class="section-label">自定义背景</div>' +
      '<div class="upload-zone" id="bg-upload-zone">' +
        window.MineIcons.svg("upload", 24) +
        '<span>点击选择本地图片</span>' +
      '</div>' +
      '<input type="file" accept="image/*" id="bg-file" class="file-hidden">';

    var scopeHtml =
      '<div class="section-label" style="margin-top:16px;">应用到</div>' +
      '<div class="scope-row">' +
        SCOPES.map(function (s) {
          return '<button class="scope-btn" data-scope="' + s.id + '">' +
            '<span class="scope-name">' + s.name + '</span>' +
            '<span class="scope-sub">' + s.desc + '</span></button>';
        }).join("") +
        '<button class="scope-btn scope-btn-all" data-scope="all">' +
          '<span class="scope-name">全部同时更换</span>' +
          '<span class="scope-sub">同一张图应用到所有页面</span></button>' +
      '</div>';

    /* 3. 已设置列表 */
    var setHtml = buildSetListHtml();

    /* 4. 字体样式 / 颜色（含自定义输入） */
    var fontStyleHtml =
      '<div class="section-label">字体样式</div>' +
      '<div class="font-color-row">' +
        Object.keys(FONT_STYLES).map(function (key) {
          var fs = FONT_STYLES[key];
          return '<button class="font-color-btn' + (state.fontStyle === key ? " is-active" : "") +
            '" data-font-style="' + key + '">' +
            '<span class="fc-swatch font-style-swatch" style="font-family:' + (fs.css || "sans-serif") + ';">' + fs.char + '</span>' +
            '<span>' + fs.name + '</span></button>';
        }).join("") +
      '</div>' +
      '<div class="font-custom-row">' +
        '<input class="font-custom-input" id="font-style-input" ' +
          'placeholder="输入字体样式编码，如 \'PingFang SC\',sans-serif" value="' +
          (state.fontStyle === "custom" ? state.customFontStyle : "") + '">' +
        '<button class="font-custom-apply" id="font-style-apply">应用</button>' +
      '</div>';

    var fontColorHtml =
      '<div class="section-label">字体颜色</div>' +
      '<div class="font-color-row">' +
        Object.keys(FONT_COLORS).map(function (key) {
          var fc = FONT_COLORS[key];
          if (key === "name") return "";
          return '<button class="font-color-btn' + (state.fontColor === key ? " is-active" : "") +
            '" data-font-color="' + key + '">' +
            '<span class="fc-swatch' + (fc.isCustom ? " fc-custom" : " fc-" + key) + '"></span>' +
            '<span>' + fc.name + '</span></button>';
        }).join("") +
      '</div>' +
      '<div class="font-custom-row">' +
        '<input class="font-custom-input" id="font-color-input" ' +
          'placeholder="输入颜色编码，如 #7c3aed" value="' +
          (state.fontColor === "custom" ? state.customFontColor : "") + '">' +
        '<button class="font-custom-apply" id="font-color-apply">应用</button>' +
      '</div>';

    body.innerHTML = modeHtml + uploadHtml + scopeHtml + setHtml + fontStyleHtml + fontColorHtml;

    bindManagerEvents(body);
  }

  /* 已设置背景列表（缩略图 + 名称 + 清除） */
  function buildSetListHtml() {
    var rows = [];
    function rowFor(scope, key, label) {
      var url = getScopeBg(scope, key);
      if (!url) return;
      rows.push(
        '<div class="bg-scope-item">' +
          '<span class="bg-scope-thumb" style="background-image:url(\'' + url + '\')"></span>' +
          '<span class="bg-scope-label">' + label + '</span>' +
          '<button class="bg-scope-clear" data-clear-scope="' + scope + '" data-clear-key="' + (key || "") + '" ' +
            'aria-label="清除">' + window.MineIcons.svg("trash", 16) + '</button>' +
        '</div>'
      );
    }
    rowFor("global", null, "系统网页背景");
    rowFor("moments", null, "朋友圈背景");
    Object.keys(state.custom.contact).forEach(function (cid) {
      rowFor("contact", cid, targetName("contact", cid) + " 的聊天");
    });
    Object.keys(state.custom.group).forEach(function (gid) {
      rowFor("group", gid, targetName("group", gid) + " 的群聊");
    });
    if (!rows.length) return "";
    return '<div class="section-label">已设置</div><div class="bg-scope-list">' + rows.join("") + '</div>';
  }

  function bindManagerEvents(body) {
    /* 模式按钮 */
    body.querySelectorAll("[data-mode]").forEach(function (btn) {
      btn.addEventListener("click", function () { setMode(btn.getAttribute("data-mode")); });
    });

    /* 上传 */
    var uploadZone = body.querySelector("#bg-upload-zone");
    var fileInput = document.getElementById("bg-file");
    if (uploadZone && fileInput) {
      uploadZone.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        if (this.files && this.files[0]) {
          var file = this.files[0];
          upload(file, function (dataURL) {
            if (!dataURL) { return; }
            /* 记住待应用图片，弹出作用域选择 */
            pendingImage = dataURL;
            showScopePicker();
          });
        }
        this.value = "";
      });
    }

    /* 作用域按钮 */
    body.querySelectorAll("[data-scope]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var scope = btn.getAttribute("data-scope");
        if (!pendingImage) {
          /* 未上传图片时点击 → 提示先选图 */
          showToast("请先选择一张背景图片");
          return;
        }
        if (scope === "all") {
          setAllBg(pendingImage);
          pendingImage = null;
          renderManager();
        } else if (scope === "contact" || scope === "group") {
          showTargetPicker(scope, pendingImage);
        } else {
          setCustomBg(scope, null, pendingImage);
          pendingImage = null;
          renderManager();
        }
      });
    });

    /* 已设置项清除 */
    body.querySelectorAll("[data-clear-scope]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var scope = btn.getAttribute("data-clear-scope");
        var key = btn.getAttribute("data-clear-key") || null;
        setCustomBg(scope, key, null);
        renderManager();
      });
    });

    /* 字体样式 / 颜色预设 */
    body.querySelectorAll("[data-font-style]").forEach(function (btn) {
      btn.addEventListener("click", function () { setFontStyle(btn.getAttribute("data-font-style")); });
    });
    body.querySelectorAll("[data-font-color]").forEach(function (btn) {
      btn.addEventListener("click", function () { setFontColor(btn.getAttribute("data-font-color")); });
    });

    /* 自定义字体样式 / 字体颜色 */
    var fsInput = body.querySelector("#font-style-input");
    var fsApply = body.querySelector("#font-style-apply");
    if (fsInput && fsApply) {
      fsApply.addEventListener("click", function () {
        if (setCustomFontStyle(fsInput.value)) renderManager();
      });
    }
    var fcInput = body.querySelector("#font-color-input");
    var fcApply = body.querySelector("#font-color-apply");
    if (fcInput && fcApply) {
      fcApply.addEventListener("click", function () {
        if (setCustomFontColor(fcInput.value)) renderManager();
      });
    }
  }

  /* 作用域选择浮层（上传图片后出现） */
  function showScopePicker() {
    var overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.addEventListener("click", function () { overlay.remove(); });

    var panel = document.createElement("div");
    panel.className = "sheet scope-picker";
    panel.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-head"><h2>应用到</h2>' +
      '<button class="nav-btn" data-act="cancel">' + window.MineIcons.svg("close", 20) + '</button></div>' +
      '<div class="sheet-body">' +
        '<div class="scope-picker-preview">' +
          '<span class="bg-scope-thumb" style="background-image:url(\'' + pendingImage + '\')"></span>' +
          '<span>将这张图应用到：</span>' +
        '</div>' +
        '<div class="scope-row scope-row-col">' +
          SCOPES.map(function (s) {
            return '<button class="scope-btn" data-pick="' + s.id + '">' +
              '<span class="scope-name">' + s.name + '</span>' +
              '<span class="scope-sub">' + s.desc + '</span></button>';
          }).join("") +
          '<button class="scope-btn scope-btn-all" data-pick="all">' +
            '<span class="scope-name">全部同时更换</span>' +
            '<span class="scope-sub">同一张图应用到所有页面</span></button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    requestAnimationFrame(function () {
      overlay.classList.add("is-open");
      panel.classList.add("is-open");
    });

    panel.querySelector('[data-act="cancel"]').addEventListener("click", function () {
      overlay.classList.remove("is-open");
      panel.classList.remove("is-open");
      setTimeout(function () { overlay.remove(); panel.remove(); }, 300);
    });
    panel.querySelectorAll("[data-pick]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var scope = btn.getAttribute("data-pick");
        overlay.remove();
        panel.remove();
        if (scope === "all") {
          setAllBg(pendingImage);
          pendingImage = null;
          renderManager();
        } else if (scope === "contact" || scope === "group") {
          showTargetPicker(scope, pendingImage);
        } else {
          setCustomBg(scope, null, pendingImage);
          pendingImage = null;
          renderManager();
        }
      });
    });
  }

  /* 联系人 / 群选择浮层 */
  function showTargetPicker(kind, image) {
    var targets = listTargets(kind);
    var overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.addEventListener("click", function () { overlay.remove(); });

    var panel = document.createElement("div");
    panel.className = "sheet scope-picker";
    var items = targets.length
      ? targets.map(function (t) {
          return '<button class="target-row" data-target="' + (t.id || "") + '">' +
            '<span class="target-avatar">' + (window.MineContacts && MineContacts.avatarHTML
              ? MineContacts.avatarHTML(t, 28, "target-avatar-img") : "") + '</span>' +
            '<span class="target-name">' + (t.name || t.nickname || t.id) + '</span></button>';
        }).join("")
      : '<div class="cm-empty">暂无可选' + (kind === "contact" ? "联系人" : "群聊") + '，请先到通讯录添加</div>';

    panel.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-head"><h2>选择' + (kind === "contact" ? "联系人" : "群聊") + '</h2>' +
      '<button class="nav-btn" data-act="cancel">' + window.MineIcons.svg("close", 20) + '</button></div>' +
      '<div class="sheet-body target-list">' + items + '</div>';

    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    requestAnimationFrame(function () {
      overlay.classList.add("is-open");
      panel.classList.add("is-open");
    });

    panel.querySelector('[data-act="cancel"]').addEventListener("click", function () {
      overlay.classList.remove("is-open");
      panel.classList.remove("is-open");
      setTimeout(function () { overlay.remove(); panel.remove(); }, 300);
    });
    panel.querySelectorAll("[data-target]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-target");
        overlay.remove();
        panel.remove();
        setCustomBg(kind, id, image);
        pendingImage = null;
        renderManager();
      });
    });
  }

  function showToast(msg) {
    try {
      if (window.MineUtils && MineUtils.showToast) { MineUtils.showToast(msg); return; }
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

  function syncManagerUI() {
    if (!sheetEl || !sheetEl.classList.contains("is-open")) return;
    var body = document.getElementById("bg-sheet-body");
    if (!body) return;

    body.querySelectorAll("[data-mode]").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-mode") === state.mode);
    });
    body.querySelectorAll("[data-font-style]").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-font-style") === state.fontStyle);
    });
    body.querySelectorAll("[data-font-color]").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-font-color") === state.fontColor);
    });
  }

  function openManager() {
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

  /* ==================== 初始化 ==================== */
  function init() {
    el.image = document.querySelector(".bg-image");
    load();
    applyMode();
  }

  return {
    init: init,
    openManager: openManager,
    closeManager: closeManager,
    setMode: setMode,
    toggleMode: toggleMode,
    upload: upload,
    setCustomBg: setCustomBg,
    getScopeBg: getScopeBg,
    clearScopeBg: clearScopeBg,
    setAllBg: setAllBg,
    applyPageBg: applyPageBg,
    setFontStyle: setFontStyle,
    setFontColor: setFontColor,
    setCustomFontStyle: setCustomFontStyle,
    setCustomFontColor: setCustomFontColor,
    applyFontColor: applyFontColor,
    applyFontStyle: applyFontStyle,
    getState: function () { return JSON.parse(JSON.stringify(state)); }
  };
})();
