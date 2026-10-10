/* ========================================================================
   Mine · 个人中心
   ------------------------------------------------------------------------
   · 修改我的头像（从本地文件上传，压缩存储）
   · 修改我的昵称
   · 数据存储于 localStorage "mine.me.v1"，与聊天模块共用
   ======================================================================== */

window.MineProfile = (function () {
  "use strict";

  var I = window.MineIcons;
  var U = window.MineUtils;
  var ME_KEY = "mine.me.v1";

  var meProfile = { name: "Mine", avatar: null };

  function loadMe() {
    try {
      var raw = localStorage.getItem(ME_KEY);
      if (raw) { meProfile = JSON.parse(raw); return; }
    } catch (e) {}
    meProfile = { name: "Mine", avatar: null };
    saveMe();
  }

  function saveMe() {
    try { localStorage.setItem(ME_KEY, JSON.stringify(meProfile)); } catch (e) {}
  }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function firstChar(s) {
    s = String(s || "");
    return s.charAt(0) || "?";
  }

  /* ---------------- 渲染头像 HTML ---------------- */
  function avatarHTML(size, cls) {
    var s = size || 32;
    var c = (cls ? " " + cls : "");
    if (meProfile && meProfile.avatar) {
      return '<div class="avatar' + c + '" style="width:' + s + 'px;height:' + s + 'px;">' +
        '<img src="' + escapeHtml(meProfile.avatar) + '" alt=""></div>';
    }
    return '<div class="avatar avatar-gen' + c + '" style="width:' + s + 'px;height:' + s + 'px;">' +
      escapeHtml(firstChar(meProfile ? meProfile.name : "雾")) + '</div>';
  }

  /* ---------------- 渲染个人中心页面 ---------------- */
  function renderPage() {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">个人中心</span>' +
        '<span class="nav-right"></span>' +
      '</div>';

    var html = '<div class="scroll me-scroll">';

    // 头部：头像 + 昵称（仅展示，编辑入口在"个性化"）
    var avatarInner = (meProfile.avatar
      ? '<img src="' + escapeHtml(meProfile.avatar) + '">'
      : '<span class="avatar-gen-text">' + escapeHtml(firstChar(meProfile.name)) + '</span>');

    html += '<div class="profile-hero">' +
      '<div class="avatar big-avatar profile-avatar" id="me-avatar" style="position:relative;">' +
        avatarInner +
      '</div>' +
      '<span class="profile-name" id="me-name-display">' + escapeHtml(meProfile.name || "Mine") + '</span>' +
      '<span class="profile-status">在"我的"中修改昵称与头像</span>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 我的：昵称 + 头像合并为"我的资料"
    html += '<div class="group-head">我的</div>';
    html += '<div class="func-row" role="button" tabindex="0" data-act="open-me">' +
      '<div class="func-icon">' + I.svg("me", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">我的资料</span>' +
        '<span class="func-sub">昵称与头像</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    // 个性化：背景 / 聊天气泡 / 系统主题（三者并列；气泡与主题后期支持增删导入）
    html += '<div class="group-head">个性化</div>';
    html += '<div class="func-row" role="button" tabindex="0" data-act="open-background">' +
      '<div class="func-icon">' + I.svg("background", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">背景</span>' +
        '<span class="func-sub">模式、背景、字体样式与字体颜色</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';
    html += '<div class="func-row" role="button" tabindex="0" data-act="open-bubble">' +
      '<div class="func-icon">' + I.svg("chat", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">聊天气泡</span>' +
        '<span class="func-sub">自定义聊天气泡样式（即将上线）</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';
    html += '<div class="func-row" role="button" tabindex="0" data-act="open-theme">' +
      '<div class="func-icon">' + I.svg("droplet", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">系统主题</span>' +
        '<span class="func-sub">自定义系统主题（即将上线）</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 字卡
    html += '<div class="group-head">字卡</div>';
    html += '<div class="func-row" role="button" tabindex="0" data-act="open-cards">' +
      '<div class="func-icon">' + I.svg("me", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">我的字卡</span>' +
        '<span class="func-sub">公用字卡所有联系人回复可用 · 单独字卡仅指定联系人 · 自动回复用单独字卡中的自动回复</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    // 系统字卡（内容后期新增）
    html += '<div class="func-row" role="button" tabindex="0" data-act="open-sys-cards">' +
      '<div class="func-icon">' + I.svg("bookmark", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">系统字卡</span>' +
        '<span class="func-sub">系统预设字卡，可整体/单张开关，可自行添加</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    // 全部字卡（搜索 / 增删改）
    html += '<div class="func-row" role="button" tabindex="0" data-act="open-search-cards">' +
      '<div class="func-icon">' + I.svg("search", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">全部字卡</span>' +
        '<span class="func-sub">搜索关键词，可增删修改所有字卡</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 概率修改（点击展开页内分栏，不再弹窗）
    html += '<div class="group-head">概率</div>';
    html += '<div class="func-row" role="button" tabindex="0" data-act="open-probability">' +
      '<div class="func-icon">' + I.svg("sliders", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">概率修改</span>' +
        '<span class="func-sub">字卡概率 / 电话概率 · 0~100% 支持一位小数，立即生效</span>' +
      '</div>' +
      '<span class="chevron" id="probs-chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';
    html += '<div id="probs-inline" class="probs-inline" hidden></div>';

    html += '</div>'; // .scroll

    // 渲染到 detail 页
    var detail = document.getElementById("page-detail");
    detail.innerHTML = navBar + html;

    bindEvents(detail);
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents(pageEl) {
    // 返回
    var backBtn = pageEl.querySelector('[data-act="back"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      window.MineApp.goHome();
    });

    // 背景入口 → 打开背景管理器
    var bgBtn = pageEl.querySelector('[data-act="open-background"]');
    if (bgBtn) {
      bgBtn.addEventListener("click", function () {
        if (window.MineBackground) window.MineBackground.openManager();
      });
    }

    // 聊天气泡 / 系统主题入口（本期占位，后期支持增删导入）
    var bubbleBtn = pageEl.querySelector('[data-act="open-bubble"]');
    if (bubbleBtn) {
      bubbleBtn.addEventListener("click", function () {
        showToast("聊天气泡即将上线，敬请期待");
      });
    }
    var themeBtn = pageEl.querySelector('[data-act="open-theme"]');
    if (themeBtn) {
      themeBtn.addEventListener("click", function () {
        showToast("系统主题即将上线，敬请期待");
      });
    }

    // 字卡入口 → 打开字卡管理器
    var cardsBtn = pageEl.querySelector('[data-act="open-cards"]');
    if (cardsBtn) {
      cardsBtn.addEventListener("click", function () {
        if (window.MineCards) window.MineCards.openManager();
      });
    }

    // 概率修改入口 → 展开 / 收起页内分栏（字卡概率 / 电话概率）
    var probBtn = pageEl.querySelector('[data-act="open-probability"]');
    if (probBtn) {
      probBtn.addEventListener("click", function () {
        var inline = pageEl.querySelector("#probs-inline");
        var chevron = pageEl.querySelector("#probs-chevron");
        if (!inline) return;
        if (inline.hidden) {
          inline.hidden = false;
          if (window.MineProbs && MineProbs.renderInline) MineProbs.renderInline(inline);
          if (chevron) chevron.classList.add("is-open");
        } else {
          inline.hidden = true;
          if (chevron) chevron.classList.remove("is-open");
        }
      });
      probBtn.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); probBtn.click(); }
      });
    }

    // 我的资料入口 → 打开资料编辑面板
    var meBtn = pageEl.querySelector('[data-act="open-me"]');
    if (meBtn) {
      meBtn.addEventListener("click", openMeSheet);
      meBtn.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMeSheet(); }
      });
    }

    // 全部字卡入口 → 打开搜索 / 增删改面板
    var searchCardsBtn = pageEl.querySelector('[data-act="open-search-cards"]');
    if (searchCardsBtn) {
      searchCardsBtn.addEventListener("click", function () {
        if (window.MineCards && window.MineCards.openSearch) window.MineCards.openSearch();
      });
      searchCardsBtn.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (window.MineCards && window.MineCards.openSearch) window.MineCards.openSearch();
        }
      });
    }

    // 系统字卡入口 → 打开系统字卡编辑器（所有联系人可用，独立发送概率）
    var sysCardsBtn = pageEl.querySelector('[data-act="open-sys-cards"]');
    if (sysCardsBtn) {
      sysCardsBtn.addEventListener("click", function () {
        if (window.MineCards && window.MineCards.openManager) window.MineCards.openManager("sys");
      });
      sysCardsBtn.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (window.MineCards && window.MineCards.openManager) window.MineCards.openManager("sys");
        }
      });
    }
  }

  /* ==================== "我的资料"编辑面板 ==================== */
  var meSheetEl = null;
  var meOverlayEl = null;

  function openMeSheet() {
    if (!meSheetEl) {
      meOverlayEl = document.createElement("div");
      meOverlayEl.className = "sheet-overlay";
      meOverlayEl.addEventListener("click", closeMeSheet);

      meSheetEl = document.createElement("div");
      meSheetEl.className = "sheet";
      meSheetEl.innerHTML =
        '<div class="sheet-handle"></div>' +
        '<div class="sheet-head"><h2>我的资料</h2>' +
        '<button class="nav-btn" data-act="close">' + I.svg("close", 20) + '</button></div>' +
        '<div class="sheet-body" id="me-sheet-body"></div>';
      document.body.appendChild(meOverlayEl);
      document.body.appendChild(meSheetEl);
      meSheetEl.querySelector('[data-act="close"]').addEventListener("click", closeMeSheet);
    }
    renderMeSheet();
    requestAnimationFrame(function () {
      meOverlayEl.classList.add("is-open");
      meSheetEl.classList.add("is-open");
    });
  }
  function closeMeSheet() {
    if (!meSheetEl) return;
    meOverlayEl.classList.remove("is-open");
    meSheetEl.classList.remove("is-open");
  }

  function renderMeSheet() {
    var body = document.getElementById("me-sheet-body");
    if (!body) return;

    var html =
      '<div class="me-sheet-preview">' + avatarHTML(72, "me-sheet-avatar") + '</div>' +
      '<div class="group-head">昵称</div>' +
      '<div class="me-edit-row">' +
        '<input type="text" class="field-input me-name-input" id="me-sheet-name" ' +
          'value="' + escapeHtml(meProfile.name || "Mine") + '" ' +
          'placeholder="输入你的昵称" maxlength="20">' +
        '<button class="btn btn-primary btn-sm" id="me-sheet-save">保存</button>' +
      '</div>' +
      '<div class="group-head">头像</div>' +
      '<div class="func-row" role="button" tabindex="0" data-act="me-sheet-avatar">' +
        '<div class="func-icon">' + I.svg("camera", 20) + '</div>' +
        '<div class="func-text">' +
          '<span class="func-title">更换头像</span>' +
          '<span class="func-sub">从相册选择图片</span>' +
        '</div>' +
        '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    if (meProfile.avatar) {
      html += '<div class="func-row" role="button" tabindex="0" data-act="me-sheet-remove">' +
        '<div class="func-icon">' + I.svg("trash", 20) + '</div>' +
        '<div class="func-text">' +
          '<span class="func-title">移除头像</span>' +
          '<span class="func-sub">恢复默认文字头像</span>' +
        '</div>' +
        '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';
    }

    html += '<input type="file" accept="image/*" id="me-sheet-file" class="file-hidden">';

    body.innerHTML = html;
    bindMeSheetEvents(body);
  }

  function bindMeSheetEvents(body) {
    // 昵称保存
    var nameInput = body.querySelector("#me-sheet-name");
    var nameSave = body.querySelector("#me-sheet-save");
    if (nameInput && nameSave) {
      var doSave = function () {
        var val = (nameInput.value || "").trim();
        if (!val) {
          nameInput.style.borderColor = "rgba(180,90,90,0.5)";
          nameInput.focus();
          setTimeout(function () { nameInput.style.borderColor = ""; }, 1500);
          return;
        }
        meProfile.name = val;
        saveMe();
        if (window.MineApp && window.MineApp.refreshGreeting) window.MineApp.refreshGreeting();
        renderPage();
        renderMeSheet();
        showToast("昵称已保存");
      };
      nameSave.addEventListener("click", doSave);
      nameInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") doSave();
      });
    }

    // 更换头像
    var fileEl = body.querySelector("#me-sheet-file");
    var avatarBtn = body.querySelector('[data-act="me-sheet-avatar"]');
    if (avatarBtn && fileEl) {
      var openPicker = function () { fileEl.click(); };
      avatarBtn.addEventListener("click", openPicker);
      avatarBtn.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
      });
      fileEl.addEventListener("change", function () {
        if (this.files && this.files[0]) {
          var f = this.files[0];
          if (U && U.compressImage) {
            U.compressImage(f, 200, 0.85, function (dataURL) {
              if (!dataURL) return;
              meProfile.avatar = dataURL;
              saveMe();
              renderPage();
              renderMeSheet();
            });
          }
          this.value = "";
        }
      });
    }

    // 移除头像
    var removeBtn = body.querySelector('[data-act="me-sheet-remove"]');
    if (removeBtn) {
      removeBtn.addEventListener("click", function () {
        meProfile.avatar = null;
        saveMe();
        renderPage();
        renderMeSheet();
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

  /* ---------------- 初始化 ---------------- */
  function init() {
    loadMe();
  }

  /* ---------------- 暴露接口 ---------------- */
  return {
    init: init,
    renderPage: renderPage,
    getProfile: function () { return meProfile; },
    getName: function () { return meProfile.name || "Mine"; },
    avatarHTML: avatarHTML,
    loadMe: loadMe,
    saveMe: saveMe
  };
})();
 
