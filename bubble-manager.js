/* ========================================================================
   To Regalo · 聊天气泡 + 系统主题 上传管理器
   ------------------------------------------------------------------------
   · 聊天气泡：上传一张图片作为双方消息气泡皮肤（--bubble-* CSS 变量驱动，
     与 theme-manager.js 的 BUBBLES 注册表联动）。存 localStorage
     "mine.bubble.custom.v1"；可清除恢复默认气泡。
   · 系统主题：上传一张图片作为全局主题背景（复用背景管理器 global 作用域，
     与"背景 → 系统网页背景"同一存储位，面板会显示当前已设置的缩略图）。
     可清除恢复默认。
   · 对外 API：MineLook.init() / openBubbleManager() / openThemeManager()
   ======================================================================== */

window.MineLook = (function () {
  "use strict";

  var U = window.MineUtils;
  var I = window.MineIcons;

  var BUBBLE_KEY = "mine.bubble.custom.v1";

  /* ==================== 聊天气泡 ==================== */

  /* 读取已保存的自定义气泡图（dataURL 或 null） */
  function getCustomBubble() {
    try { return localStorage.getItem(BUBBLE_KEY) || null; } catch (e) {}
    return null;
  }

  /* 把上传图注册为"自定义气泡"并立即应用（自动持久化，刷新后保留） */
  function applyCustomBubble(url) {
    if (!url) return false;
    try { localStorage.setItem(BUBBLE_KEY, url); } catch (e) {}
    if (!window.MineTheme || !MineTheme.registerBubble || !MineTheme.applyBubble) return false;
    MineTheme.registerBubble({
      key: "custom",
      name: "自定义气泡",
      desc: "用户上传的气泡皮肤",
      vars: {
        "--bubble-radius": "16px",
        "--bubble-tail-radius": "4px",
        "--bubble-them-bg": 'url("' + url + '") center / cover no-repeat',
        "--bubble-them-bd": "rgba(255,255,255,0.35)",
        "--bubble-them-color": "#ffffff",
        "--bubble-me-bg": 'url("' + url + '") center / cover no-repeat',
        "--bubble-me-bd": "rgba(255,255,255,0.35)",
        "--bubble-me-color": "#ffffff"
      }
    });
    MineTheme.applyBubble("custom");
    return true;
  }

  /* 启动时恢复自定义气泡（若已保存） */
  function loadCustomBubble() {
    var url = getCustomBubble();
    if (url) applyCustomBubble(url);
  }

  /* 清除自定义气泡 → 恢复默认 */
  function clearCustomBubble() {
    try { localStorage.removeItem(BUBBLE_KEY); } catch (e) {}
    if (window.MineTheme && MineTheme.applyBubble) MineTheme.applyBubble("default");
    renderBubbleSheet();
    toast("已恢复默认气泡");
  }

  /* 气泡示例（取当前 --bubble-* 变量实时预览） */
  function bubbleSampleHTML() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fb) {
      var val = cs.getPropertyValue(name).trim();
      return val || fb;
    }
    var radius = v("--bubble-radius", "14px");
    var themBg = v("--bubble-them-bg", "rgba(255,255,255,0.55)");
    var themBd = v("--bubble-them-bd", "rgba(255,255,255,0.3)");
    var themColor = v("--bubble-them-color", "#333");
    var meBg = v("--bubble-me-bg", "rgba(120,160,255,0.35)");
    var meBd = v("--bubble-me-bd", "rgba(120,160,255,0.4)");
    var meColor = v("--bubble-me-color", "#fff");
    function bubble(bg, bd, color, radius, align, text) {
      return '<div style="display:flex;' + (align === "right" ? "justify-content:flex-end;" : "") +
        'margin:6px 0;">' +
        '<span style="max-width:70%;padding:10px 14px;border-radius:' + radius + ';' +
        'border:1px solid ' + bd + ';background:' + bg + ';color:' + color + ';' +
        'font-size:13px;line-height:1.5;box-shadow:0 1px 4px rgba(0,0,0,0.08);">' + text + '</span>' +
        '</div>';
    }
    return '<div style="background:rgba(0,0,0,0.05);border-radius:12px;padding:12px;margin:10px 0;">' +
      bubble(themBg, themBd, themColor, radius, "left", "对方的消息气泡") +
      bubble(meBg, meBd, meColor, radius, "right", "我的消息气泡") +
      '</div>';
  }

  /* ==================== 聊天气泡面板 ==================== */
  var bubbleSheetEl = null;
  var bubbleOverlayEl = null;

  function buildBubbleSheet() {
    if (bubbleSheetEl) return;
    bubbleOverlayEl = document.createElement("div");
    bubbleOverlayEl.className = "sheet-overlay";
    bubbleOverlayEl.addEventListener("click", closeBubbleSheet);

    bubbleSheetEl = document.createElement("div");
    bubbleSheetEl.className = "sheet";
    bubbleSheetEl.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-head"><h2>聊天气泡</h2>' +
      '<button class="nav-btn" data-act="close">' + I.svg("close", 20) + '</button></div>' +
      '<div class="sheet-body" id="look-bubble-body"></div>';
    document.body.appendChild(bubbleOverlayEl);
    document.body.appendChild(bubbleSheetEl);
    bubbleSheetEl.querySelector('[data-act="close"]').addEventListener("click", closeBubbleSheet);
    renderBubbleSheet();
  }
  function renderBubbleSheet() {
    var body = document.getElementById("look-bubble-body");
    if (!body) return;
    var has = !!getCustomBubble();
    var html =
      '<div class="section-label">效果预览</div>' +
      bubbleSampleHTML() +
      '<div class="section-label">上传气泡皮肤</div>' +
      '<div class="upload-zone" id="look-bubble-upload">' + I.svg("upload", 24) + '<span>点击选择本地图片</span></div>' +
      '<input type="file" accept="image/*" id="look-bubble-file" class="file-hidden">' +
      (has
        ? '<div style="margin-top:14px;"><button class="btn btn-danger btn-block" data-act="look-bubble-clear" style="width:100%;">' +
          I.svg("trash", 16) + ' 清除，恢复默认气泡</button></div>'
        : '<div class="section-label" style="margin-top:16px;color:var(--t-tertiary);">当前为默认气泡 · 上传图片后立即生效</div>');
    body.innerHTML = html;

    var zone = body.querySelector("#look-bubble-upload");
    var fileEl = document.getElementById("look-bubble-file");
    if (zone && fileEl) {
      zone.addEventListener("click", function () { fileEl.click(); });
      fileEl.addEventListener("change", function () {
        if (this.files && this.files[0]) {
          var f = this.files[0];
          var done = function (dataURL) {
            if (!dataURL) { toast("图片处理失败，请重试"); return; }
            try { localStorage.setItem(BUBBLE_KEY, dataURL); } catch (e) {}
            applyCustomBubble(dataURL);
            renderBubbleSheet();
            toast("聊天气泡已更新");
          };
          if (U && U.compressImage) U.compressImage(f, 600, 0.78, done);
          else done(f.type.indexOf("image/") === 0 ? f : null);
        }
        this.value = "";
      });
    }
    var clearBtn = body.querySelector('[data-act="look-bubble-clear"]');
    if (clearBtn) clearBtn.addEventListener("click", clearCustomBubble);
  }
  function closeBubbleSheet() {
    if (!bubbleSheetEl) return;
    bubbleOverlayEl.classList.remove("is-open");
    bubbleSheetEl.classList.remove("is-open");
  }
  function openBubbleManager() {
    buildBubbleSheet();
    requestAnimationFrame(function () {
      bubbleOverlayEl.classList.add("is-open");
      bubbleSheetEl.classList.add("is-open");
    });
  }

  /* ==================== 系统主题面板 ====================
     上传图片 → 写入背景管理器 global 作用域（等同"系统网页背景"）。 */
  var themeSheetEl = null;
  var themeOverlayEl = null;

  function getThemeBg() {
    try {
      if (window.MineBackground && MineBackground.getScopeBg) {
        return MineBackground.getScopeBg("global", null) || null;
      }
    } catch (e) {}
    return null;
  }

  function buildThemeSheet() {
    if (themeSheetEl) return;
    themeOverlayEl = document.createElement("div");
    themeOverlayEl.className = "sheet-overlay";
    themeOverlayEl.addEventListener("click", closeThemeSheet);

    themeSheetEl = document.createElement("div");
    themeSheetEl.className = "sheet";
    themeSheetEl.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-head"><h2>系统主题</h2>' +
      '<button class="nav-btn" data-act="close">' + I.svg("close", 20) + '</button></div>' +
      '<div class="sheet-body" id="look-theme-body"></div>';
    document.body.appendChild(themeOverlayEl);
    document.body.appendChild(themeSheetEl);
    themeSheetEl.querySelector('[data-act="close"]').addEventListener("click", closeThemeSheet);
    renderThemeSheet();
  }
  function renderThemeSheet() {
    var body = document.getElementById("look-theme-body");
    if (!body) return;
    var bg = getThemeBg();
    var html =
      '<div class="section-label">主题背景</div>' +
      (bg
        ? '<div class="bg-scope-item" style="margin:10px 0;">' +
          '<span class="bg-scope-thumb" style="background-image:url(\'' + bg + '\')"></span>' +
          '<span class="bg-scope-label">当前主题背景</span>' +
          '</div>'
        : '<div class="section-label" style="color:var(--t-tertiary);">当前为默认主题 · 上传图片即可作为全局主题背景</div>') +
      '<div class="section-label">上传主题背景</div>' +
      '<div class="upload-zone" id="look-theme-upload">' + I.svg("upload", 24) + '<span>点击选择本地图片</span></div>' +
      '<input type="file" accept="image/*" id="look-theme-file" class="file-hidden">' +
      (bg
        ? '<div style="margin-top:14px;"><button class="btn btn-danger btn-block" data-act="look-theme-clear" style="width:100%;">' +
          I.svg("trash", 16) + ' 清除，恢复默认主题</button></div>'
        : '');
    body.innerHTML = html;

    var zone = body.querySelector("#look-theme-upload");
    var fileEl = document.getElementById("look-theme-file");
    if (zone && fileEl) {
      zone.addEventListener("click", function () { fileEl.click(); });
      fileEl.addEventListener("change", function () {
        if (this.files && this.files[0]) {
          var f = this.files[0];
          var done = function (dataURL) {
            if (!dataURL) { toast("图片处理失败，请重试"); return; }
            if (window.MineBackground && MineBackground.setCustomBg) {
              MineBackground.setCustomBg("global", null, dataURL);
              renderThemeSheet();
              toast("系统主题已更新");
            }
          };
          if (U && U.compressImage) U.compressImage(f, 800, 0.72, done);
          else done(f.type.indexOf("image/") === 0 ? f : null);
        }
        this.value = "";
      });
    }
    var clearBtn = body.querySelector('[data-act="look-theme-clear"]');
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        if (window.MineBackground && MineBackground.setCustomBg) {
          MineBackground.setCustomBg("global", null, null);
        }
        renderThemeSheet();
        toast("已恢复默认主题");
      });
    }
  }
  function closeThemeSheet() {
    if (!themeSheetEl) return;
    themeOverlayEl.classList.remove("is-open");
    themeSheetEl.classList.remove("is-open");
  }
  function openThemeManager() {
    buildThemeSheet();
    requestAnimationFrame(function () {
      themeOverlayEl.classList.add("is-open");
      themeSheetEl.classList.add("is-open");
    });
  }

  function toast(msg) {
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
    loadCustomBubble();
  }

  return {
    init: init,
    openBubbleManager: openBubbleManager,
    closeBubbleManager: closeBubbleSheet,
    openThemeManager: openThemeManager,
    closeThemeManager: closeThemeSheet,
    getCustomBubble: getCustomBubble,
    applyCustomBubble: applyCustomBubble,
    clearCustomBubble: clearCustomBubble
  };
})();
