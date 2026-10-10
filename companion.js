/* ========================================================================
   Mine · 陪伴页模块
   ------------------------------------------------------------------------
   功能：
   · 内容应用入口（bento 网格布局）
   · 每日寄语展示
   · 预留扩展：通过 register() 注册具体内容功能
   接入：通过 MineApp.page("companion") 钩子接管占位页。
   ======================================================================== */

window.MineCompanion = (function () {
  "use strict";

  var I = window.MineIcons;
  var pageEl = null;

  /* ========================================================================
     内容应用注册表
     ------------------------------------------------------------------------
     后续扩展：在此添加新条目即可。
     每项格式：
       id:     唯一标识
       icon:   图标名（对应 icons.js 中的 key）
       title:  卡片标题
       desc:   卡片描述
       wide:   是否跨两列（大卡片）
       accent: 是否使用强调色
       soon:   是否显示"待开放"标签
       onOpen: 点击时的回调函数（可选，后续实现具体功能时填充）
     ======================================================================== */
  var CONTENT_APPS = [
    // —— 每日陪伴 ——
    { id: "daily-companion", icon: "sunrise", title: "每日陪伴", desc: "晨间问候 · 今日心境", wide: true, accent: true, soon: true },
    { id: "mood-radio",      icon: "music",    title: "心情电台", desc: "依心绪而生的旋律", soon: true },
    { id: "breathing",       icon: "wind",     title: "呼吸练习", desc: "四拍呼吸 · 安定心神", soon: true },

    // —— 时光记录 ——
    { id: "time-mailbox",    icon: "feather",  title: "次元信箱", desc: "跨越次元的来信", soon: false },
    { id: "memory-album",   icon: "book",     title: "记忆相册", desc: "收藏温暖瞬间", soon: true },
    { id: "night-whispers",  icon: "moon",     title: "深夜树洞", desc: "倾诉此刻的心声", wide: true, soon: false },

    // —— 温暖陪伴 ——
    { id: "food-hunt",      icon: "utensils",  title: "觅食", desc: "塔罗牌抽签今日食", soon: false },
    { id: "quiet-flame",     icon: "flame",    title: "静默炉火", desc: "凝视跳动的火光", soon: true },
    { id: "companion-heart", icon: "heart",   title: "陪伴之心", desc: "此刻有人惦念着你", wide: true, accent: true, soon: true }
  ];

  /* ========================================================================
     每日寄语库（系统内置寄语已全部删除）
     ------------------------------------------------------------------------
     系统内不再预置任何寄语，每日寄语仅从用户自定义寄语中随机抽取；
     可在陪伴页「管理今日寄语」中添加 / 删除 / 导入 / 导出。
     自定义寄语存于 localStorage "mine.companion.quotes.v1"。
     ======================================================================== */
  var QUOTES = [];

  /* ---------------- 工具 ---------------- */
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ========================================================================
     今日寄语 · 自定义文案（可添加 / 删除 / 导入 / 导出）
     ------------------------------------------------------------------------
     自定义寄语存于 localStorage "mine.companion.quotes.v1"：
        [{ text: 文案, author: 作者 }, ...]
     系统内置寄语已全部删除，每日寄语仅从自定义寄语中随机抽取。
     ======================================================================== */
  var USER_QUOTES_KEY = "mine.companion.quotes.v1";
  var userQuotes = [];
  function loadUserQuotes() {
    userQuotes = [];
    try {
      var raw = localStorage.getItem(USER_QUOTES_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (Array.isArray(d)) {
          d.forEach(function (q) {
            if (!q) return;
            if (typeof q === "string" && q.trim()) {
              userQuotes.push({ text: q.trim(), author: "" });
            } else if (q && typeof q === "object" && typeof q.text === "string" && q.text.trim()) {
              userQuotes.push({ text: q.text.trim(), author: String(q.author || "").trim() });
            }
          });
        }
      }
    } catch (e) {}
  }
  function saveUserQuotes() {
    try { localStorage.setItem(USER_QUOTES_KEY, JSON.stringify(userQuotes)); } catch (e) {}
  }

  function getDailyQuote() {
    /* 每隔 12 小时随机抽取一句，同一 12 小时窗口内结果一致 */
    var now = new Date();
    var halfDayIndex = Math.floor(now.getTime() / 43200000); // 43200000ms = 12小时
    var pool = QUOTES.concat(userQuotes);
    if (pool.length === 0) return { text: "静候灵感降临。", author: "Mine" };
    // 用时间窗口作为种子做伪随机，确保同一窗口内结果一致
    var seed = halfDayIndex;
    var rand = function () {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    // 多次迭代使种子更分散
    for (var i = 0; i < 10; i++) { rand(); }
    var idx = Math.floor(rand() * pool.length);
    return pool[idx];
  }

  /** 每隔 12 小时从联系人列表中随机抽取一位，返回其昵称 */
  function getDailyPersonName() {
    var C = window.MineContacts;
    if (!C || !C.loadData) return "";
    C.loadData();
    var contacts = (C.getState && C.getState().contacts) || [];
    if (contacts.length === 0) return "";
    var now = new Date();
    var halfDayIndex = Math.floor(now.getTime() / 43200000); // 43200000ms = 12小时
    // 用不同偏移量的种子，确保和诗句不总是抽到同一索引
    var seed = halfDayIndex + 7777;
    var rand = function () {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (var i = 0; i < 10; i++) { rand(); }
    var idx = Math.floor(rand() * contacts.length);
    return contacts[idx].name || "";
  }

  function getGreeting() {
    var h = new Date().getHours();
    if (h < 6)  return "深夜好，愿雾散心宁";
    if (h < 11) return "早安，新的一天开始了";
    if (h < 14) return "午安，歇歇脚吧";
    if (h < 18) return "午后好，阳光正柔";
    if (h < 22) return "晚安，一天辛苦了";
    return "夜深了，注意保暖";
  }

  /* ========================================================================
     渲染：内容卡片 HTML
     ======================================================================== */
  function cardHTML(app) {
    var wide = app.wide ? " is-wide" : "";
    var accent = app.accent ? " is-accent" : "";
    var soon = app.soon ? '<span class="comp-soon">待开放</span>' : "";
    var badge = window.MineNotify ? MineNotify.badgeHTML(app.id) : "";

    return '<div class="comp-card' + wide + accent + '" role="button" tabindex="0" data-app="' + app.id + '">' +
      soon +
      '<div class="comp-card-glow"></div>' +
      '<div class="comp-card-icon">' + I.svg(app.icon, 22) + '</div>' + badge +
      '<div class="comp-card-body">' +
        '<div class="comp-card-title">' + escapeHtml(app.title) + '</div>' +
        '<div class="comp-card-desc">' + escapeHtml(app.desc) + '</div>' +
      '</div>' +
      '</div>';
  }

  /* ========================================================================
     渲染：陪伴页主体
     ======================================================================== */
  function viewCompanion() {
    var html = '';

    // 导航栏
    html += '<div class="nav-bar">' +
      '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
      '<span class="nav-title">陪伴</span>' +
      '<span class="nav-right"></span>' +
      '</div>';

    html += '<div class="scroll">';

    // 顶部问候
    html += '<div class="comp-hero">';
    html += '<div class="comp-hero-title">陪伴</div>';
    html += '<div class="comp-hero-sub">' + getGreeting() + '</div>';
    html += '</div>';

    // 每日寄语
    var quote = getDailyQuote();
    var personName = getDailyPersonName();
    var label = personName ? personName + "的今日寄语" : "今日寄语";
    html += '<div class="comp-quote">';
    html += '<div class="comp-quote-label">' + escapeHtml(label) + '</div>';
    html += '<div class="comp-quote-text">' + escapeHtml(quote.text) + '</div>';
    html += '<div class="comp-quote-author">—— ' + escapeHtml(quote.author) + '</div>';
    html += '<button class="comp-quote-manage" data-act="quote-manage">' + I.svg("pencil", 14) + '管理今日寄语</button>';
    html += '</div>';

    // 内容应用网格
    html += '<div class="comp-grid">';

    // 分区：每日陪伴
    html += '<div class="comp-section-label">每日陪伴</div>';
    CONTENT_APPS.filter(function (a) {
      return ["daily-companion", "mood-radio", "breathing"].indexOf(a.id) >= 0;
    }).forEach(function (a) { html += cardHTML(a); });

    // 分区：时光记录
    html += '<div class="comp-section-label">时光记录</div>';
    CONTENT_APPS.filter(function (a) {
      return ["time-mailbox", "memory-album", "night-whispers"].indexOf(a.id) >= 0;
    }).forEach(function (a) { html += cardHTML(a); });

    // 分区：温暖陪伴
    html += '<div class="comp-section-label">温暖陪伴</div>';
    CONTENT_APPS.filter(function (a) {
      return ["food-hunt", "quiet-flame", "companion-heart"].indexOf(a.id) >= 0;
    }).forEach(function (a) { html += cardHTML(a); });

    html += '</div>'; // .comp-grid
    html += '</div>'; // .scroll

    return html;
  }

  /* ========================================================================
     绑定交互
     ======================================================================== */
  function bindCompanion() {
    if (!pageEl) return;

    // 返回按钮
    var backBtn = pageEl.querySelector('[data-act="back"]');
    if (backBtn) {
      backBtn.addEventListener("click", function () {
        if (window.MineApp && MineApp.goHome) MineApp.goHome();
      });
    }

    // 今日寄语管理
    var quoteManageBtn = pageEl.querySelector('[data-act="quote-manage"]');
    if (quoteManageBtn) {
      quoteManageBtn.addEventListener("click", openQuoteManager);
    }

    // 内容卡片点击
    pageEl.querySelectorAll(".comp-card").forEach(function (card) {
      card.addEventListener("click", function () {
        onCardTap(card.getAttribute("data-app"));
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCardTap(card.getAttribute("data-app"));
        }
      });
    });
  }

  /* ---------------- 卡片点击处理 ----------------
     后续在此分发到具体功能模块。
     目前所有内容均为"待开放"状态，显示轻量提示。 */
  function onCardTap(appId) {
    var app = findApp(appId);
    if (!app) return;

    // 标记已查看该卡片的通知
    if (window.MineNotify) MineNotify.markSeen(appId);

    // 预留：若已注册具体功能，则调用
    if (typeof app.onOpen === "function") {
      app.onOpen();
      return;
    }

    // 默认：轻量提示（后续替换为具体功能页面）
    showSoonToast(app.title);
  }

  function findApp(id) {
    for (var i = 0; i < CONTENT_APPS.length; i++) {
      if (CONTENT_APPS[i].id === id) return CONTENT_APPS[i];
    }
    return null;
  }

  /* ---------------- 轻量提示 ---------------- */
  var toastTimer = null;
  function showSoonToast(title) {
    if (toastTimer) { clearTimeout(toastTimer); }

    // 移除已有 toast
    var existing = document.querySelector(".comp-toast");
    if (existing) existing.remove();

    var toast = document.createElement("div");
    toast.className = "comp-toast";
    toast.innerHTML = '<span class="comp-toast-icon">' + I.svg("moon", 18) + '</span>' +
      '<span class="comp-toast-text">' + escapeHtml(title) + ' · 即将开放</span>';
    document.body.appendChild(toast);

    // 触发动画
    requestAnimationFrame(function () {
      toast.classList.add("is-show");
    });

    toastTimer = setTimeout(function () {
      toast.classList.remove("is-show");
      setTimeout(function () { toast.remove(); }, 300);
    }, 1800);
  }

  /* ========================================================================
     今日寄语管理面板（添加 / 删除 / 导入 / 导出）
     ======================================================================== */
  var quoteSheetEl = null;
  var quoteOverlayEl = null;

  function quoteStamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }
  function quoteDownload(arr) {
    var blob = new Blob([JSON.stringify(arr, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "mine-quotes-" + quoteStamp() + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
  }
  function quoteToast(msg) {
    var el = document.querySelector(".phone-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "phone-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("is-show");
    setTimeout(function () { el.classList.remove("is-show"); }, 2200);
  }
  function openQuoteManager() {
    if (!quoteSheetEl) {
      quoteOverlayEl = document.createElement("div");
      quoteOverlayEl.className = "sheet-overlay";
      quoteOverlayEl.addEventListener("click", closeQuoteManager);

      quoteSheetEl = document.createElement("div");
      quoteSheetEl.className = "sheet";
      quoteSheetEl.innerHTML =
        '<div class="sheet-handle"></div>' +
        '<div class="sheet-head"><h2>今日寄语管理</h2>' +
        '<button class="nav-btn" data-act="close">' + I.svg("close", 20) + '</button></div>' +
        '<div class="sheet-body" id="quote-sheet-body"></div>';
      document.body.appendChild(quoteOverlayEl);
      document.body.appendChild(quoteSheetEl);
      quoteSheetEl.querySelector('[data-act="close"]').addEventListener("click", closeQuoteManager);
    }
    renderQuoteManager();
    requestAnimationFrame(function () {
      quoteOverlayEl.classList.add("is-open");
      quoteSheetEl.classList.add("is-open");
    });
  }
  function closeQuoteManager() {
    if (!quoteSheetEl) return;
    quoteOverlayEl.classList.remove("is-open");
    quoteSheetEl.classList.remove("is-open");
  }
  function renderQuoteManager() {
    loadUserQuotes();
    var body = document.getElementById("quote-sheet-body");
    if (!body) return;
    var listHtml = userQuotes.length
      ? userQuotes.map(function (q, i) {
          return '<div class="quote-item">' +
            '<div class="quote-item-main">' +
              '<div class="quote-item-text">' + escapeHtml(q.text) + '</div>' +
              (q.author ? '<div class="quote-item-author">—— ' + escapeHtml(q.author) + '</div>' : '') +
            '</div>' +
            '<button class="quote-del" data-quote-del="' + i + '" aria-label="删除">' + I.svg("trash", 16) + '</button>' +
          '</div>';
        }).join("")
      : '<div class="quote-empty">还没有自定义寄语，添加一句吧</div>';
    body.innerHTML =
      '<div class="card-hint">每日寄语从以下自定义寄语中随机展示 · 格式：文案 或 文案|作者</div>' +
      '<div class="quote-add-row">' +
        '<input type="text" class="card-input" id="quote-input" placeholder="输入寄语文案（可选 | 作者），回车添加" maxlength="200">' +
        '<button class="card-add-btn" data-act="quote-add" aria-label="添加">' + I.svg("plus", 18) + '</button>' +
      '</div>' +
      '<div class="quote-tools">' +
        '<button class="card-type-tool" data-act="quote-export">' + I.svg("download", 13) + '导出</button>' +
        '<button class="card-type-tool" data-act="quote-import">' + I.svg("upload", 13) + '导入</button>' +
      '</div>' +
      '<div class="quote-list">' + listHtml + '</div>';
    bindQuoteEvents(body);
  }
  function bindQuoteEvents(body) {
    /* 添加（回车 / + 按钮） */
    var input = body.querySelector("#quote-input");
    function doAdd() {
      var v = input ? input.value.trim() : "";
      if (!v) { quoteToast("请输入寄语文案"); return; }
      var text = v, author = "";
      var pipe = v.indexOf("|");
      if (pipe >= 0) {
        text = v.slice(0, pipe).trim();
        author = v.slice(pipe + 1).trim();
      }
      if (!text) { quoteToast("文案不能为空"); return; }
      userQuotes.push({ text: text, author: author });
      saveUserQuotes();
      if (input) input.value = "";
      quoteToast("已添加今日寄语");
      renderQuoteManager();
    }
    if (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doAdd(); }
      });
    }
    var addBtn = body.querySelector('[data-act="quote-add"]');
    if (addBtn) addBtn.addEventListener("click", doAdd);

    /* 删除 */
    body.querySelectorAll("[data-quote-del]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var i = parseInt(btn.getAttribute("data-quote-del"), 10);
        if (i >= 0 && i < userQuotes.length) {
          userQuotes.splice(i, 1);
          saveUserQuotes();
          renderQuoteManager();
        }
      });
    });

    /* 导出 */
    var expBtn = body.querySelector('[data-act="quote-export"]');
    if (expBtn) {
      expBtn.addEventListener("click", function () {
        if (!userQuotes.length) { quoteToast("暂无自定义寄语可导出"); return; }
        quoteDownload(userQuotes);
        quoteToast("已导出 " + userQuotes.length + " 条寄语");
      });
    }

    /* 导入 */
    var impBtn = body.querySelector('[data-act="quote-import"]');
    if (impBtn) {
      impBtn.addEventListener("click", function () {
        var fi = document.createElement("input");
        fi.type = "file";
        fi.accept = ".json,application/json";
        fi.style.display = "none";
        document.body.appendChild(fi);
        fi.addEventListener("change", function () {
          var f = fi.files && fi.files[0];
          document.body.removeChild(fi);
          if (!f) return;
          var reader = new FileReader();
          reader.onload = function () {
            var data;
            try { data = JSON.parse(String(reader.result)); } catch (e) { quoteToast("文件不是有效的 JSON"); return; }
            if (!Array.isArray(data)) { quoteToast("格式不符：应为寄语数组"); return; }
            var added = 0;
            data.forEach(function (q) {
              if (typeof q === "string" && q.trim()) {
                userQuotes.push({ text: q.trim(), author: "" }); added++;
              } else if (q && typeof q === "object" && typeof q.text === "string" && q.text.trim()) {
                userQuotes.push({ text: q.text.trim(), author: String(q.author || "").trim() }); added++;
              }
            });
            if (!added) { quoteToast("文件中没有可导入的寄语"); return; }
            saveUserQuotes();
            quoteToast("已导入 " + added + " 条寄语");
            renderQuoteManager();
          };
          reader.onerror = function () { quoteToast("读取文件失败"); };
          reader.readAsText(f);
        });
        fi.click();
      });
    }
  }

  /* ========================================================================
     对外接口
     ======================================================================== */
  function open() {
    if (!pageEl) pageEl = document.getElementById("page-companion");
    if (!pageEl) return;
    pageEl.innerHTML = viewCompanion();
    bindCompanion();
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("companion");
  }

  /* ---------------- 扩展接口 ----------------
     供后续模块注册具体功能：
       MineCompanion.register("mood-radio", function () { ... });
     注册后，点击对应卡片将调用该回调而非显示"待开放"提示。 */
  function register(appId, callback) {
    var app = findApp(appId);
    if (app) {
      app.onOpen = callback;
      app.soon = false;
    }
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    loadUserQuotes();
    pageEl = document.getElementById("page-companion");
    // 注册次元信箱
    register("time-mailbox", function () {
      if (window.MineMail) window.MineMail.open();
    });
    // 注册深夜树洞
    register("night-whispers", function () {
      if (window.MineTreeHole) window.MineTreeHole.open();
    });
    // 注册心情电台
    register("mood-radio", function () {
      if (window.MineRadio) window.MineRadio.open();
    });
    // 注册觅食
    register("food-hunt", function () {
      if (window.MineFoodie) window.MineFoodie.open();
    });
  }

  /* ---------------- 注册页面钩子（链式，不覆盖其他模块） ---------------- */
  window.MineApp = window.MineApp || {};
  var prevPage = window.MineApp.page;
  window.MineApp.page = function (id) {
    if (id === "companion") { open(); return true; }
    return prevPage ? prevPage(id) : false;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    open: open,
    register: register,
    getApps: function () { return CONTENT_APPS.slice(); }
  };
})();
