/* ========================================================================
   Mine · 浏览器（基础版）
   ------------------------------------------------------------------------
   · 当前为入口 + 基础浏览壳：地址栏 / 后退 / 前进 / 刷新 / 内嵌网页
   · 具体功能（标签页 / 书签 / 历史等）后期添加
   ======================================================================== */
window.MineBrowser = (function () {
  "use strict";

  var I = window.MineIcons;

  /* ---------------- 快捷站点 ---------------- */
  var QUICK = [
    { name: "百度", url: "https://www.baidu.com" },
    { name: "必应", url: "https://www.bing.com" },
    { name: "豆包", url: "https://www.doubao.com" },
    { name: "知乎", url: "https://www.zhihu.com" },
    { name: "B站", url: "https://www.bilibili.com" },
    { name: "GitHub", url: "https://github.com" }
  ];

  /* ---------------- 页面状态 ---------------- */
  var urlInput = null;
  var frame = null;
  var startPage = null;
  var navCount = 0;   // 后退/前进可用性跟踪（简易）

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function normalizeUrl(raw) {
    var s = String(raw || "").trim();
    if (!s) return "";
    if (/^(https?:|about:|data:)/i.test(s)) return s;
    if (s.indexOf("://") > 0) return s;
    // 无协议时补 https://；支持 localhost 与 IP
    if (/^(\d{1,3}\.)/.test(s) || /^localhost/i.test(s)) return "http://" + s;
    return "https://" + s;
  }
  function toast(msg) {
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

  /* ---------------- 渲染页面 ---------------- */
  function renderPage() {
    var detail = document.getElementById("page-detail");
    if (!detail) return;
    detail.innerHTML =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">浏览器</span>' +
        '<span class="nav-right"></span>' +
      '</div>' +
      '<div class="browser-root">' +
        '<div class="browser-toolbar">' +
          '<div class="browser-navbtns">' +
            '<button class="browser-nav-btn" data-nav="back" title="后退">' + I.svg("back", 18) + '</button>' +
            '<button class="browser-nav-btn" data-nav="fwd" title="前进">' + I.svg("skipForward", 18) + '</button>' +
            '<button class="browser-nav-btn" data-nav="reload" title="刷新">' + I.svg("refresh", 18) + '</button>' +
          '</div>' +
          '<div class="browser-addr">' +
            '<input class="browser-url" id="browser-url" type="text" inputmode="url" placeholder="输入网址，如 baidu.com" autocomplete="off" spellcheck="false">' +
            '<button class="browser-go" id="browser-go" title="前往">' + I.svg("send", 16) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="browser-body">' +
          '<iframe class="browser-frame" id="browser-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerpolicy="no-referrer"></iframe>' +
          '<div class="browser-start" id="browser-start">' +
            '<div class="browser-start-title">Mine 浏览器</div>' +
            '<div class="browser-start-sub">在顶部输入网址开始浏览 · 更多功能敬请期待</div>' +
            '<div class="browser-quick">' +
              QUICK.map(function (q) {
                return '<button class="browser-quick-btn" data-url="' + esc(q.url) + '">' +
                  '<span class="browser-quick-dot">' + esc(q.name.slice(0, 1)) + '</span>' +
                  '<span>' + esc(q.name) + '</span>' +
                '</button>';
              }).join("") +
            '</div>' +
            '<div class="browser-hint">部分网站会拒绝被内嵌展示，属正常现象</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    urlInput = document.getElementById("browser-url");
    frame = document.getElementById("browser-frame");
    startPage = document.getElementById("browser-start");
    bindEvents(detail);
  }

  function bindEvents(root) {
    var backBtn = root.querySelector('[data-act="back"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      if (window.MineApp && MineApp.goHome) MineApp.goHome();
    });
    root.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var navBtn = t.closest("[data-nav]");
      if (navBtn) {
        var act = navBtn.getAttribute("data-nav");
        if (act === "back") { try { frame.contentWindow.history.back(); } catch (err) {} }
        else if (act === "fwd") { try { frame.contentWindow.history.forward(); } catch (err) {} }
        else if (act === "reload") { try { frame.contentWindow.location.reload(); } catch (err) {} }
        return;
      }
      var go = t.closest("#browser-go");
      if (go) { navigate(urlInput.value); return; }
      var quick = t.closest("[data-url]");
      if (quick) {
        navigate(quick.getAttribute("data-url"));
        return;
      }
    });
    if (urlInput) {
      urlInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); navigate(urlInput.value); }
      });
    }
  }

  /* ---------------- 导航 ---------------- */
  function navigate(raw) {
    var url = normalizeUrl(raw);
    if (!url) { toast("请输入网址"); return; }
    startPage.style.display = "none";
    frame.style.display = "block";
    try {
      frame.src = url;
      if (urlInput) urlInput.value = url;
    } catch (err) {
      toast("无法打开该网址");
    }
  }

  return { renderPage: renderPage };
})();
