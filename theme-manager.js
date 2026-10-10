/* ========================================================================
   Mine · 主题管理器 + 小组件系统
   ------------------------------------------------------------------------
   功能：
   · 主题切换（支持后期扩展更多主题）
   · 聊天气泡样式（BUBBLES 注册表：系统可预置，后期可在设置中手动添加）
   · 主题选择面板
   · 小组件弹窗（添加小组件）
   · 编辑模式（拖拽排列、删除组件）
   · 时钟组件实时更新
   · Hero 卡片读取用户资料
   ------------------------------------------------------------------------
   对外 API：MineTheme.switch(name) / getTheme() / registerTheme()
            / applyBubble(key) / getBubble() / registerBubble()
   气泡联动：聊天气泡、统一语音条等界面组件均使用 --bubble-* CSS 变量渲染，
   修改气泡样式或系统主题即可全局生效。
   ======================================================================== */

window.MineTheme = (function () {
  "use strict";

  /* ====== 主题注册表（后期扩展在此追加） ======
     每个主题需要：
     · key:  唯一标识
     · name: 显示名称
     · desc: 描述
     · bodyClass: 激活时添加到 body 的 class（默认主题留空）
     · swatchClass: 色板预览的 CSS class
  */
  var THEMES = [
    {
      key: "fog",
      name: "黑夜",
      desc: "纯黑背景",
      bodyClass: "theme-night",
      swatchClass: "fog"
    },
    {
      key: "neumorphism",
      name: "白天",
      desc: "奶油软拟态",
      bodyClass: "theme-neumorphism",
      swatchClass: "neumorphism"
    }
    /* ---- 后续新增主题示例 ----
    {
      key: "ocean",
      name: "深海蓝",
      desc: "深海渐变 · 冷调波纹",
      bodyClass: "theme-ocean",
      swatchClass: "ocean"
    }
    */
  ];

  var STORAGE_KEY = "mine.theme.v1";
  var currentTheme = "neumorphism";
  var dom = {};

  /* ====== 聊天气泡注册表（后期扩展在此追加；也可 registerBubble 运行时添加） ======
     每个气泡样式通过 CSS 变量驱动所有界面组件：
     · --bubble-radius     气泡圆角
     · --bubble-tail-radius 气泡小尾巴圆角（聊天气泡专用）
     · --bubble-them-*     对方气泡（背景 / 边框 / 文字色）
     · --bubble-me-*       我的气泡（背景 / 边框 / 文字色）
  */
  var BUBBLES = [
    {
      key: "default",
      name: "默认气泡",
      desc: "雾面玻璃 · 冷调柔和",
      vars: {
        "--bubble-radius": "var(--r-md)",
        "--bubble-tail-radius": "4px",
        "--bubble-them-bg": "var(--glass-2)",
        "--bubble-them-bd": "var(--bd-soft)",
        "--bubble-them-color": "var(--t-primary)",
        "--bubble-me-bg": "var(--accent-soft)",
        "--bubble-me-bd": "var(--bd-medium)",
        "--bubble-me-color": "var(--c-ghost)"
      }
    }
    /* ---- 后续新增气泡样式示例 ----
    {
      key: "cream",
      name: "奶油圆角",
      desc: "暖白圆角 · 柔和阴影",
      vars: {
        "--bubble-radius": "18px",
        "--bubble-tail-radius": "4px",
        "--bubble-them-bg": "#f5efe6",
        "--bubble-them-bd": "#e4d9c6",
        "--bubble-them-color": "#3a342a",
        "--bubble-me-bg": "#ffe9c7",
        "--bubble-me-bd": "#f3d3a3",
        "--bubble-me-color": "#5a4326"
      }
    }
    */
  ];

  var BUBBLE_STORAGE_KEY = "mine.bubbles.v1";
  var currentBubble = "default";

  /* ====== 工具函数 ====== */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return (root || document).querySelectorAll(sel); }

  /* ====== 获取当前主题 ====== */
  function getTheme() { return currentTheme; }

  /* ====== 注册新主题（运行时动态添加） ====== */
  function registerTheme(theme) {
    if (!theme || !theme.key) return;
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].key === theme.key) { THEMES[i] = theme; return; }
    }
    THEMES.push(theme);
  }

  /* ====== 气泡：注册新样式（系统预置 / 手动添加均走此接口） ====== */
  function registerBubble(bubble) {
    if (!bubble || !bubble.key || !bubble.vars) return;
    for (var i = 0; i < BUBBLES.length; i++) {
      if (BUBBLES[i].key === bubble.key) { BUBBLES[i] = bubble; return; }
    }
    BUBBLES.push(bubble);
  }

  function getBubble() { return currentBubble; }

  /* ====== 气泡：应用指定样式（把 --bubble-* 变量写到 :root） ====== */
  function applyBubble(key) {
    var bubble = null;
    for (var i = 0; i < BUBBLES.length; i++) {
      if (BUBBLES[i].key === key) { bubble = BUBBLES[i]; break; }
    }
    if (!bubble) return;
    var root = document.documentElement;
    for (var v in bubble.vars) {
      if (bubble.vars.hasOwnProperty(v)) {
        root.style.setProperty(v, bubble.vars[v]);
      }
    }
    currentBubble = key;
    try { localStorage.setItem(BUBBLE_STORAGE_KEY, key); } catch (e) {}
    if (typeof onBubbleChange === "function") onBubbleChange(key);
  }

  /* ====== 气泡：加载保存的样式 ====== */
  function loadBubble() {
    var saved = "default";
    try { saved = localStorage.getItem(BUBBLE_STORAGE_KEY) || "default"; } catch (e) {}
    applyBubble(saved);
  }

  /* ====== 切换主题 ====== */
  function switchTheme(key) {
    var theme = null;
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].key === key) { theme = THEMES[i]; break; }
    }
    if (!theme) return;

    /* 移除所有主题 class */
    for (var j = 0; j < THEMES.length; j++) {
      if (THEMES[j].bodyClass) {
        document.body.classList.remove(THEMES[j].bodyClass);
      }
    }
    /* 添加新主题 class */
    if (theme.bodyClass) {
      document.body.classList.add(theme.bodyClass);
    }
    currentTheme = key;

    /* 持久化 */
    try { localStorage.setItem(STORAGE_KEY, key); } catch (e) {}

    /* 更新面板选中状态 */
    updateThemePanelSelection();

    /* 如果是新拟态主题，渲染首页组件 */
    if (key === "neumorphism") {
      renderNeuHome();
    }

    /* 触发主题切换回调 */
    if (typeof onThemeChange === "function") onThemeChange(key);
  }

  var onThemeChange = null;
  var onBubbleChange = null;

  /* ====== 加载保存的主题 ====== */
  function loadTheme() {
    var saved = "neumorphism";
    try { saved = localStorage.getItem(STORAGE_KEY) || "neumorphism"; } catch (e) {}
    switchTheme(saved);
  }

  /* ====== 渲染新拟态首页组件 ====== */
  function renderNeuHome() {
    if (!dom.heroContainer) return;

    /* 读取用户资料 */
    var profile = { name: "Mine", avatar: null };
    try {
      var raw = localStorage.getItem("mine.me.v1");
      if (raw) {
        var me = JSON.parse(raw);
        if (me && me.name) profile.name = me.name;
        if (me && me.avatar) profile.avatar = me.avatar;
      }
    } catch (e) {}

    /* 渲染 Hero 卡片 */
    var avatarHTML = profile.avatar
      ? '<img src="' + escapeAttr(profile.avatar) + '" alt="">'
      : '<span style="font-family:var(--font-script);font-size:20px;color:var(--t-tertiary);">' +
        escapeHtml(firstChar(profile.name)) + '</span>';

    dom.heroContainer.innerHTML =
      '<div class="neu-delete-badge">×</div>' +
      '<div class="neu-hero-avatar">' + avatarHTML + '</div>' +
      '<div class="neu-hero-info">' +
        '<div class="neu-hero-name">' + escapeHtml(profile.name) + '</div>' +
        '<div class="neu-hero-subtitle">Mine</div>' +
        '<div class="neu-hero-quote">She walks with moonlight in her heart, and stars in her dreams.</div>' +
      '</div>';

    /* 渲染时钟 */
    updateNeuClock();
  }

  /* ====== 时钟更新 ====== */
  function updateNeuClock() {
    if (!dom.clockTime) return;
    var now = new Date();
    var h = now.getHours();
    var m = now.getMinutes();
    dom.clockTime.textContent = (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;

    if (dom.clockDate) {
      var days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      var months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                     "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      dom.clockDate.textContent =
        days[now.getDay()] + " · " + now.getDate() + " " + months[now.getMonth()];
    }
  }

  /* ====== 主题选择面板 ====== */
  function buildThemePanel() {
    if (dom.themePanel) return;

    var overlay = document.createElement("div");
    overlay.className = "neu-overlay theme-overlay";

    var panel = document.createElement("div");
    panel.className = "theme-panel";

    var swatchesHTML = THEMES.map(function (t) {
      return '<div class="theme-option' + (t.key === currentTheme ? " is-active" : "") +
             '" data-theme="' + t.key + '">' +
        '<div class="theme-swatch ' + t.swatchClass + '"></div>' +
        '<div class="theme-option-info">' +
          '<div class="theme-option-name">' + t.name + '</div>' +
          '<div class="theme-option-desc">' + t.desc + '</div>' +
        '</div>' +
      '</div>';
    }).join("");

    panel.innerHTML =
      '<div class="theme-panel-handle"></div>' +
      '<div class="theme-panel-head">' +
        '<h2>切换主题</h2>' +
        '<button class="theme-panel-close">×</button>' +
      '</div>' +
      '<div class="theme-panel-body">' + swatchesHTML + '</div>';

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    dom.themeOverlay = overlay;
    dom.themePanel = panel;

    /* 绑定主题选项点击 */
    $all(".theme-option", panel).forEach(function (opt) {
      opt.addEventListener("click", function () {
        switchTheme(opt.getAttribute("data-theme"));
        closeThemePanel();
      });
    });

    /* 关闭按钮 */
    $(".theme-panel-close", panel).addEventListener("click", closeThemePanel);
    overlay.addEventListener("click", closeThemePanel);
  }

  function openThemePanel() {
    buildThemePanel();
    updateThemePanelSelection();
    dom.themeOverlay.classList.add("is-open");
    dom.themePanel.classList.add("is-open");
  }

  function closeThemePanel() {
    if (!dom.themePanel) return;
    dom.themeOverlay.classList.remove("is-open");
    dom.themePanel.classList.remove("is-open");
  }

  function updateThemePanelSelection() {
    if (!dom.themePanel) return;
    $all(".theme-option", dom.themePanel).forEach(function (opt) {
      opt.classList.toggle("is-active",
        opt.getAttribute("data-theme") === currentTheme);
    });
  }

  /* ====== 主题切换按钮 ====== */
  function buildSwitchButton() {
    if (dom.switchBtn) return;
    var btn = document.createElement("button");
    btn.className = "theme-switch-btn";
    btn.setAttribute("aria-label", "切换主题");
    btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/></svg>';
    btn.addEventListener("click", openThemePanel);
    document.body.appendChild(btn);
    dom.switchBtn = btn;
  }

  /* ====== 辅助函数 ====== */
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function firstChar(s) {
    s = String(s || "");
    return s.charAt(0) || "?";
  }

  /* ====== 注入新拟态首页 HTML ======
     按用户要求删除主界面顶部卡片区（Hero / 时钟 / MEMOIRE 卡）与
     长按后的小组件设置：不再注入任何卡片内容，主界面仅保留功能图标
     宫格（app-grid）与底部导航。相关 DOM 引用置空后，renderNeuHome /
     updateNeuClock 等渲染函数自动跳过（内部均有 null 判断），
     主题切换与聊天气泡功能不受影响。 */
  function injectNeuHomeHTML() {
    dom.heroContainer = null;
    dom.clockTime = null;
    dom.clockDate = null;
  }

  /* ====== 显示/隐藏新拟态首页组件 ====== */
  function showNeuHome(show) {
    var content = $("#neu-home-content");
    if (content) content.style.display = show ? "block" : "none";
    if (show) renderNeuHome();
  }

  /* ====== 初始化 ====== */
  function init() {
    /* 注入新拟态首页 HTML */
    injectNeuHomeHTML();

    /* 右上角圆形主题切换按钮已移除：
       白天 | 黑夜 模式已合并进"个人中心 → 背景"面板（background.js setMode） */

    /* 加载保存的主题 */
    loadTheme();

    /* 加载保存的聊天气泡样式 */
    loadBubble();

    /* 时钟定时更新 */
    updateNeuClock();
    setInterval(updateNeuClock, 10000);

    /* 当主题切换时，控制新拟态首页显示 */
    onThemeChange = function (key) {
      showNeuHome(key === "neumorphism");
    };

    /* 初始显示 */
    showNeuHome(currentTheme === "neumorphism");
  }

  /* ====== 公共 API ====== */
  return {
    init: init,
    switchTheme: switchTheme,
    getTheme: getTheme,
    registerTheme: registerTheme,
    applyBubble: applyBubble,
    getBubble: getBubble,
    registerBubble: registerBubble,
    openThemePanel: openThemePanel,
    closeThemePanel: closeThemePanel
  };
})();
