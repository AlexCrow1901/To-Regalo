/* ========================================================================
   Mine · 设置
   ------------------------------------------------------------------------
   · 后台保活开关（可分别控制）：
     - 消息通知：后台收到新消息 / 来电时是否弹出系统通知
     - 后台运行：是否启用后台保活（音频保活 + 屏幕常亮）
     - 通知逐条弹：开启后每条消息都弹（默认关闭 = 去重合并，防轰炸）
     - 保活不抢其他 App 声音：开启后保活走 WebAudio 通道，
       不占用媒体通道、不压低正在播放的音乐（默认开启）
   · 测试通知：当场体检权限/通道并真发一条系统通知
   · 应用图标：上传图片自定义 PWA 桌面图标（动态重建 manifest，
     重新"添加到主屏幕"后生效）；"恢复默认"回到内置白底黑字 Mine 图标
   · 开关状态存储于 localStorage "mine.settings.v1"；图标存 "mine.icon.v1"
   · 由 keepalive.js 读取并立即生效（MineKeepalive.setPref / applyPrefs）
   · 接入：app.js 注册 "settings" 页钩子；index.html 引入本文件
   ======================================================================== */
window.MineSettings = (function () {
  "use strict";
  /* MineIcons 在本文件之后才加载（见 index.html 脚本顺序），
     必须延迟到调用时再解析，否则 I.svg 抛异常导致设置页打不开。 */
  function iconSvg(name, size) {
    var M = window.MineIcons;
    return M && M.svg ? M.svg(name, size) : "";
  }
  var SETTINGS_KEY = "mine.settings.v1";
  var ICON_KEY = "mine.icon.v1";            // 预览用（localStorage 镜像）
  var ICON_IDB = "mine-icon";               // SW 可读的真实存储（同源 IndexedDB）
  var ICON_IDB_KEY = "mine.icon.custom.v1";
  var prefs = { notify: true, background: true, nodedup: false, noduck: true };

  /* ============ 应用图标自定义（PWA 桌面图标） ============
     新版方案（网站内上传即生效，无需替换仓库文件 / 无需重新添加主屏幕）：
     上传 → 压缩为 512px PNG → 写入 IndexedDB（SW 与页面同源共享）
     → ① 应用内图标立即更新；
     → ② SW 拦截 icons/ 请求返回自定义图（manifest 保持静态可安装）；
     → ③ 动态给 manifest link 加版本戳，浏览器感知后自动同步已安装应用图标。 */
  function iconIdbOpen(cb) {
    try {
      var req = indexedDB.open(ICON_IDB, 1);
      req.onupgradeneeded = function () {
        try {
          if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
        } catch (e) {}
      };
      req.onsuccess = function () { cb(req.result); };
      req.onerror = function () { cb(null); };
    } catch (e) { cb(null); }
  }
  function iconIdbSet(dataUrl, cb) {
    iconIdbOpen(function (db) {
      if (!db) { if (cb) cb(); return; }
      try {
        var tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(dataUrl, ICON_IDB_KEY);
        tx.oncomplete = function () { try { db.close(); } catch (e) {} if (cb) cb(); };
        tx.onerror = function () { try { db.close(); } catch (e) {} if (cb) cb(); };
      } catch (e) { if (cb) cb(); }
    });
  }
  function iconIdbGet(cb) {
    iconIdbOpen(function (db) {
      if (!db) { if (cb) cb(null); return; }
      try {
        var tx = db.transaction("kv", "readonly");
        var rq = tx.objectStore("kv").get(ICON_IDB_KEY);
        rq.onsuccess = function () { try { db.close(); } catch (e) {} cb(rq.result || null); };
        rq.onerror = function () { try { db.close(); } catch (e) {} cb(null); };
      } catch (e) { cb(null); }
    });
  }
  function iconIdbDelete(cb) {
    iconIdbOpen(function (db) {
      if (!db) { if (cb) cb(); return; }
      try {
        var tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").delete(ICON_IDB_KEY);
        tx.oncomplete = function () { try { db.close(); } catch (e) {} if (cb) cb(); };
        tx.onerror = function () { try { db.close(); } catch (e) {} if (cb) cb(); };
      } catch (e) { if (cb) cb(); }
    });
  }
  /* manifest link 加版本戳：让浏览器感知图标变化并同步已安装应用（无需重新添加主屏幕） */
  function bumpManifestVersion() {
    try {
      var link = document.querySelector('link[rel="manifest"]');
      if (!link) return;
      link.href = "manifest.json?v=" + Date.now();
    } catch (e) {}
  }
  function getCustomIcon() {
    try { return localStorage.getItem(ICON_KEY) || null; } catch (e) { return null; }
  }
  /* dataURL → 按目标尺寸重绘为 PNG 并触发下载（严格按原图还原：完整等比 contain，不拉伸不变形，白底，PNG 无损） */
  function downloadPng(dataUrl, filename, size) {
    var img = new Image();
    img.onload = function () {
      try {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var scale = Math.min(size / w, size / h);
        var dw = Math.round(w * scale);
        var dh = Math.round(h * scale);
        var c = document.createElement("canvas");
        c.width = size; c.height = size;
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);
        var a = document.createElement("a");
        a.href = c.toDataURL("image/png");
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (e) {}
    };
    img.src = dataUrl;
  }
  function downloadCustomIcon(size) {
    var data = getCustomIcon();
    if (!data) return;
    downloadPng(data, size === 512 ? "icon-512.png" : "icon-192.png", size);
  }
  /* 应用图标生成：严格按照原图还原桌面图标
     ① 512×512 方形画布（PWA 图标必须方形，系统不会裁切 → 不遮挡）
     ② 白色底 + 完整等比缩放 contain（原图完整显示 → 不变形/不拉伸变宽）
     ③ PNG 无损导出（→ 不模糊）；超大图自动降级为高质量 JPEG 兜底 */
  function makeAppIcon(file, cb) {
    if (!file || !/^image\//.test(file.type)) { cb(null); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        try {
          var S = 512;
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          var scale = Math.min(S / w, S / h);   // contain：完整放入，不裁剪
          var dw = Math.round(w * scale);
          var dh = Math.round(h * scale);
          var dx = Math.round((S - dw) / 2);
          var dy = Math.round((S - dh) / 2);
          var c = document.createElement("canvas");
          c.width = S; c.height = S;
          var ctx = c.getContext("2d");
          ctx.fillStyle = "#ffffff";             // 白底（原图外区域）
          ctx.fillRect(0, 0, S, S);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, dx, dy, dw, dh);
          var png = c.toDataURL("image/png");
          /* 超大 PNG 超出 localStorage 容量时降级为高质量 JPEG（极少发生） */
          if (png.length > 2100000) {
            png = c.toDataURL("image/jpeg", 0.95);
          }
          cb(png);
        } catch (err) { cb(null); }
      };
      img.onerror = function () { cb(null); };
      img.src = e.target.result;
    };
    reader.onerror = function () { cb(null); };
    reader.readAsDataURL(file);
  }
  /* 上传图片 → 生成 512px 方形 PNG → 写入 IndexedDB（SW 代理即时生效）→ 应用内立即生效 */
  function applyCustomIcon(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var done = function (dataURL) {
      if (!dataURL) return;
      try { localStorage.setItem(ICON_KEY, dataURL); } catch (e) {}
      iconIdbSet(dataURL, function () {
        bumpManifestVersion(); // 触发浏览器感知 manifest 变化 → 自动同步已安装桌面图标
        renderPage();
        toast("图标已应用：应用内立即生效；桌面图标将在浏览器同步后自动更新（个别机型未自动更新时，重新添加到主屏幕一次即永久生效）");
      });
    };
    makeAppIcon(file, done);
  }
  function resetCustomIcon() {
    try { localStorage.removeItem(ICON_KEY); } catch (e) {}
    iconIdbDelete(function () {
      bumpManifestVersion();
      renderPage();
      toast("已恢复默认图标");
    });
  }
  /* ---------------- 持久化 ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p.notify === "boolean") prefs.notify = p.notify;
        if (p && typeof p.background === "boolean") prefs.background = p.background;
        if (p && typeof p.nodedup === "boolean") prefs.nodedup = p.nodedup;
        if (p && typeof p.noduck === "boolean") prefs.noduck = p.noduck;
      }
    } catch (e) {}
    // 让保活模块按当前设置生效
    if (window.MineKeepalive) MineKeepalive.applyPrefs();
  }
  function save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); } catch (e) {}
  }
  function getPrefs() {
    return { notify: prefs.notify, background: prefs.background, nodedup: prefs.nodedup, noduck: prefs.noduck };
  }
  function setPref(key, val) {
    if (!(key === "notify" || key === "background" || key === "nodedup" || key === "noduck")) return;
    prefs[key] = !!val;
    save();
    // 同步给保活模块并立即生效
    if (window.MineKeepalive) {
      MineKeepalive.setPref(key, prefs[key]);
      MineKeepalive.applyPrefs();
    }
  }
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace( />/g, "&gt;").replace(/"/g, "&quot;");
  }
  /* 旧图标自动修复：已上传的旧自定义图若尺寸/格式不合规（非 512 方形 PNG），
     自动重绘为 512 方形 + 白底 + 完整等比 + PNG 无损，保证桌面图标严格还原原图 */
  function normalizeStoredIcon(data) {
    if (!data) return;
    var img = new Image();
    img.onload = function () {
      try {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var isSquare512 = (w === 512 && h === 512) && data.indexOf("data:image/png") === 0;
        if (isSquare512) return;
        var S = 512;
        var scale = Math.min(S / w, S / h);
        var dw = Math.round(w * scale), dh = Math.round(h * scale);
        var c = document.createElement("canvas");
        c.width = S; c.height = S;
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, S, S);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, Math.round((S - dw) / 2), Math.round((S - dh) / 2), dw, dh);
        var png = c.toDataURL("image/png");
        if (png.length > 2100000) png = c.toDataURL("image/jpeg", 0.95);
        try { localStorage.setItem(ICON_KEY, png); } catch (e) {}
        iconIdbSet(png, function () { bumpManifestVersion(); });
      } catch (e) {}
    };
    img.onerror = function () {};
    img.src = data;
  }
  /* 页面加载：若有自定义图标 → 规范化旧图 + manifest 加版本戳，让浏览器持续感知并同步已安装桌面图标 */
  (function () {
    setTimeout(function () {
      iconIdbGet(function (data) {
        if (data) {
          normalizeStoredIcon(data);
          bumpManifestVersion();
        }
      });
    }, 600);
  })();
  /* ---------------- 渲染设置页 ---------------- */
  function renderPage() {
    load();
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + iconSvg("back", 20) + '返回</button>' +
        '<span class="nav-title">设置</span>' +
        '<span class="nav-right"></span>' +
      '</div>';
    var html = '<div class="scroll me-scroll">';
    html += '<div class="group-head">后台保活</div>';
    // 消息通知开关
    html += switchRow("set-notify", "chat", "消息通知",
      "后台收到新消息 / 来电时弹出系统通知（打开开关即可请求授权）", prefs.notify);
    // 通知权限状态行（实时提示权限状态与恢复指引）
    html += '<div id="notify-perm-status" class="card-hint" style="margin:-6px 0 10px;"></div>';
    // 后台运行开关
    html += switchRow("set-background", "power", "后台运行",
      "后台保持活跃，回到页面不丢记录", prefs.background);
    // 通知逐条弹开关
    html += switchRow("set-nodedup", "bell", "通知逐条弹",
      "开启后每条消息都弹；关闭则去重合并，避免通知轰炸", prefs.nodedup);
    // 保活不抢其他 App 声音开关
    html += switchRow("set-noduck", "music", "保活不抢其他 App 声音",
      "开启后保活走 WebAudio 通道，不占用媒体通道、不压低音乐（默认开）", prefs.noduck);
    // 测试通知按钮（排版与开关行一致）
    html += '<div class="func-row">' +
      '<div class="func-icon">' + iconSvg("check", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">测试通知</span>' +
        '<span class="func-sub">发送一条系统通知，验证通道是否就绪</span>' +
      '</div>' +
      '<button class="chat-bg-btn icon-only" id="set-test" aria-label="测试通知">' + iconSvg("bell", 16) + '</button>' +
      '</div>';
    html += '<div id="set-test-result"></div>';
    // 应用图标自定义
    html += '<div class="group-head">应用图标</div>';
    html += iconCard();
    // 文件管理（入口收进设置）
    html += '<div class="group-head">文件</div>';
    html += '<div class="func-row">' +
      '<div class="func-icon">' + iconSvg("files", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">文件</span>' +
        '<span class="func-sub">浏览与管理聊天中的文件</span>' +
      '</div>' +
      '<button class="chat-bg-btn icon-only" id="set-files" aria-label="打开文件">' + iconSvg("eye", 16) + '</button>' +
      '</div>';
    // 版本与更新（PWA 安装后浏览器 SW 更新检测不及时，提供手动检测入口）
    html += '<div class="group-head">版本与更新</div>';
    html += '<div class="func-row">' +
      '<div class="func-icon">' + iconSvg("refresh", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">版本更新</span>' +
        '<span class="func-sub">当前版本 v' + appVersion() + ' · 点击检查最新版本</span>' +
      '</div>' +
      '<button class="chat-bg-btn icon-only" id="set-check-update" aria-label="检查更新">' + iconSvg("refresh", 16) + '</button>' +
      '</div>';
    html += '<div id="set-update-result"></div>';
    html += '<div class="card-hint">自定义桌面图标：上传图片即可，网站内即时生效，无需替换仓库文件、无需重新部署。桌面图标由浏览器自动同步（首次未自动更新时，重新"添加到主屏幕"一次即永久生效）。</div>';
    html += '<div class="card-hint">关闭"消息通知"后将不再弹出系统通知；关闭"后台运行"可节省电量，但后台活跃度会下降。受手机系统省电机制限制，网页后台保活尽力而为。</div>';
    html += '<div class="card-hint">聊天记录与朋友圈数据存储于本地，刷新、关闭、更新网站均不会丢失。</div>';
    html += '<div class="card-hint">若收不到通知：① 浏览器地址栏图标 → 权限 → 通知 → 允许；② 手机系统"设置 → 通知"允许该浏览器；③ 勿开启勿扰模式；④ Chrome 可把本站加入"始终保持活动"。</div>';
    html += '</div>'; // .scroll
    var detail = document.getElementById("page-detail");
    if (!detail) return;
    detail.innerHTML = navBar + html;
    bindEvents(detail);
    syncNotifyStatus();
  }
  /* 开关行构建 */
  function switchRow(id, icon, title, sub, checked) {
    return '<div class="func-row">' +
      '<div class="func-icon">' + iconSvg(icon, 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">' + title + '</span>' +
        '<span class="func-sub">' + sub + '</span>' +
      '</div>' +
      '<label class="proactive-switch">' +
        '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="proactive-switch-track"></span>' +
      '</label>' +
      '</div>';
  }
  /* 应用图标卡片（排版与开关行一致：小预览 + 一行文字 + 右侧按钮） */
  function iconCard() {
    var custom = getCustomIcon();
    var src = custom || "icons/icon-192.png";
    var html = '<div class="func-row">' +
      '<div class="func-icon" style="width:30px;height:30px;border-radius:8px;overflow:hidden;flex:none;">' +
        '<img id="set-icon-preview" src="' + src + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">' +
      '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">桌面图标</span>' +
        '<span class="func-sub">' + (custom ? "已使用自定义图标（网站内即时生效）" : "当前为内置图标，可上传自定义") + '</span>' +
      '</div>' +
      '<button class="chat-bg-btn icon-only" id="set-icon-upload" aria-label="选择图片">' +
        iconSvg("image", 16) + '</button>' +
      '</div>' +
      '<input type="file" accept="image/*" id="set-icon-file" class="file-hidden">';
    if (custom) {
      html += '<div class="func-row">' +
        '<div class="func-icon">' + iconSvg("download", 20) + '</div>' +
        '<div class="func-text">' +
          '<span class="func-title">导出图标文件</span>' +
          '<span class="func-sub">下载 PNG 可分享给好友或替换仓库图标</span>' +
        '</div>' +
        '<button class="chat-bg-btn icon-only" id="set-icon-dl512" aria-label="导出 PNG">' + iconSvg("download", 16) + '</button>' +
        '<button class="chat-bg-btn icon-only" id="set-icon-reset" style="margin-left:6px;" aria-label="恢复默认">' + iconSvg("refresh", 16) + '</button>' +
        '</div>';
    }
    return html;
  }
  /* ---------------- 事件绑定 ---------------- */
  /* 轻提示（模块内实现：几秒后自动消失的底部浮层） */
  var settingsToastTimer = null;
  function toast(msg) {
    try {
      var old = document.querySelector(".settings-toast");
      if (old) old.remove();
      var d = document.createElement("div");
      d.className = "settings-toast";
      d.textContent = msg;
      d.style.cssText = "position:fixed;left:50%;bottom:120px;transform:translateX(-50%);max-width:80%;padding:10px 14px;border-radius:12px;background:rgba(0,0,0,.78);color:#fff;font-size:13px;line-height:1.5;z-index:99999;pointer-events:none;";
      document.body.appendChild(d);
      if (settingsToastTimer) clearTimeout(settingsToastTimer);
      settingsToastTimer = setTimeout(function () { try { d.remove(); } catch (e) {} }, 3200);
    } catch (e) {}
  }
  /* ---------------- 版本更新检测（设置页手动触发） ----------------
     PWA 安装后浏览器对 SW 的更新检测不主动、不及时（通常 24h 才轮询一次），
     这里提供手动入口：
     · 点击「检查更新」→ 强制 reg.update() 检测 + 读取 version.json 对比版本号
     · 发现新版本（SW 层面 waiting/installing，或版本号不一致）→ 行内展示
       当前/最新版本 + [立即更新][稍后]
     · 立即更新 → 发 SKIP_WAITING → 新 SW 接管（controllerchange）→ 刷新加载新版本
     · 无新版本 → 提示「已是最新版本」；离线/不支持 → 明确提示
     更新只替换缓存文件，聊天记录等本地数据（localStorage/IndexedDB）不受影响。
     version.json 由 SW 放行不缓存（见 sw.js fetch），读取到的是服务器上的真实版本。 */
  function appVersion() {
    try {
      var m = document.querySelector('meta[name="app-version"]');
      if (m) return m.getAttribute("content") || "1.0.0";
    } catch (e) {}
    return "1.0.0";
  }
  var updateFoundWorker = null;   /* 本次检测出的 waiting SW（可能为 null，仅版本号不一致） */
  var updateCheckTimer = null;
  function setUpdateState(state, latest) {
    var el = document.getElementById("set-update-result");
    if (!el) return;
    if (updateCheckTimer) { clearTimeout(updateCheckTimer); updateCheckTimer = null; }
    var cur = appVersion();
    var html = "";
    if (state === "checking") {
      html = '<div class="card-hint" style="margin-top:8px;">正在检查更新…</div>';
    } else if (state === "latest") {
      html = '<div class="card-hint" style="margin-top:8px;">✓ 已是最新版本 v' + cur + '</div>';
    } else if (state === "nosw") {
      html = '<div class="card-hint" style="margin-top:8px;">当前环境不支持自动更新，请手动刷新页面加载最新版本</div>';
    } else if (state === "error") {
      html = '<div class="card-hint" style="margin-top:8px;">✗ 检查失败：请确认网络连接后重试</div>';
    } else if (state === "found") {
      html = '<div class="card-hint" style="margin-top:8px;">发现新版本' +
        (latest ? ' <b>v' + latest + '</b>（当前 v' + cur + '）' : '（当前 v' + cur + '）') +
        '，更新后聊天记录等本地内容不受影响</div>' +
        '<div class="update-banner-actions" style="margin-top:8px;">' +
          '<button class="update-banner-btn is-primary" id="set-update-now">立即更新</button>' +
          '<button class="update-banner-btn" id="set-update-later">稍后</button>' +
        '</div>';
      el.innerHTML = html;
      var now = el.querySelector("#set-update-now");
      var later = el.querySelector("#set-update-later");
      if (now) now.addEventListener("click", applyUpdateNow);
      if (later) later.addEventListener("click", function () { el.innerHTML = ""; });
      return;
    }
    el.innerHTML = html;
  }
  function checkForUpdate() {
    var checkBtn = document.getElementById("set-check-update");
    if (checkBtn) checkBtn.disabled = true;
    setUpdateState("checking");
    var cur = appVersion();
    var gotFound = false;
    function found(latest, worker) {
      if (gotFound) return;
      gotFound = true;
      updateFoundWorker = worker;
      setUpdateState("found", latest);
      if (checkBtn) checkBtn.disabled = false;
    }
    /* SW 层面强制检查：waiting / installing / updatefound */
    function track(worker) {
      if (!worker) return;
      worker.addEventListener("statechange", function () {
        if (worker.state === "installed" && !gotFound) found(null, worker);
      });
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (!reg) { setUpdateState("nosw"); if (checkBtn) checkBtn.disabled = false; return; }
        if (reg.waiting) { found(null, reg.waiting); return; }
        if (reg.installing) track(reg.installing);
        reg.addEventListener("updatefound", function h() {
          reg.removeEventListener("updatefound", h);
          track(reg.installing);
        });
        try { reg.update(); } catch (e) {}
      }).catch(function () {});
    }
    /* version.json 版本对比（网络真实读取，不被 SW 缓存） */
    fetch("version.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) {
        var latest = d && d.version;
        if (latest && cur && latest !== cur && !gotFound) found(latest, null);
      })
      .catch(function () {});
    /* 兜底：6 秒无结果 → 判定为已是最新 */
    updateCheckTimer = setTimeout(function () {
      updateCheckTimer = null;
      if (!gotFound) setUpdateState("latest");
      if (checkBtn) checkBtn.disabled = false;
    }, 6000);
  }
  /* 新 SW 接管后刷新页面（一次性监听，避免重复 reload） */
  function onceControllerReload() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("controllerchange", function h() {
      navigator.serviceWorker.removeEventListener("controllerchange", h);
      location.reload();
    });
  }
  /* 立即更新：SKIP_WAITING → controllerchange → 刷新 */
  function applyUpdateNow() {
    var worker = updateFoundWorker;
    updateFoundWorker = null;
    if (!("serviceWorker" in navigator)) { location.reload(); return; }
    onceControllerReload();
    if (worker && worker.postMessage) {
      try { worker.postMessage({ type: "SKIP_WAITING" }); } catch (e) {}
      return;
    }
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) { location.reload(); return; }
      if (reg.waiting) { try { reg.waiting.postMessage({ type: "SKIP_WAITING" }); } catch (e) {} return; }
      if (reg.installing) {
        reg.installing.addEventListener("statechange", function () {
          if (reg.installing && reg.installing.state === "installed") {
            try { reg.installing.postMessage({ type: "SKIP_WAITING" }); } catch (e) {}
          }
        });
        return;
      }
      reg.update().then(function () {
        reg.addEventListener("updatefound", function h() {
          reg.removeEventListener("updatefound", h);
          var ni = reg.installing;
          if (!ni) { location.reload(); return; }
          ni.addEventListener("statechange", function () {
            if (ni.state === "installed") {
              try { ni.postMessage({ type: "SKIP_WAITING" }); } catch (e) {}
            }
          });
        });
        setTimeout(function () {
          if (!reg.waiting && !reg.installing) location.reload();
        }, 5000);
      }).catch(function () { location.reload(); });
    }).catch(function () { location.reload(); });
  }
  /* —— 通知权限状态行 + 授权等待轮询（mochi 同款：开关保持开启、允许后自动生效） —— */
  var notifyWatchTimer = null;
  function notifyPermState() {
    try { return ("Notification" in window) ? Notification.permission : "unsupported"; } catch (e) { return "unsupported"; }
  }
  function notifyStatusText() {
    var p = notifyPermState();
    if (p === "unsupported") {
      return "⚠ 当前浏览器不支持系统通知（部分安卓自带浏览器 / 夸克等）：请用 Chrome 或 Edge 打开本站后再开此开关";
    }
    if (p === "granted") {
      return "✓ 通知权限已授予：后台收到消息将直接弹系统通知";
    }
    if (p === "denied") {
      return "⚠ 浏览器已把本站通知记为「阻止」（旧版反复请求导致自动禁止，多半不是你点的拒绝）。恢复：从桌面图标打开的应用 → 长按图标卸载后重新「添加到主屏幕」，安装时允许通知；浏览器标签打开 → 地址栏图标 → 网站设置 → 通知 → 允许（找不到入口就换 Chrome 打开本站重新授权）。允许后自动生效，无需再动此开关";
    }
    return "· 通知权限未授予：打开此开关即请求一次授权，浏览器弹窗选「允许」即可；若没弹窗（被浏览器自动阻止）→ 换 Chrome 打开本站或卸载重装应用，授权后自动生效";
  }
  function syncNotifyStatus() {
    var el = document.getElementById("notify-perm-status");
    if (!el) return;
    el.textContent = notifyStatusText();
  }
  function notifyWatchStart() {
    if (notifyWatchTimer) return;
    var start = Date.now();
    notifyWatchTimer = setInterval(function () {
      var p = notifyPermState();
      if (p === "granted" || p === "denied") {
        clearInterval(notifyWatchTimer);
        notifyWatchTimer = null;
        syncNotifyStatus();
        if (p === "granted") toast("通知权限已授予，消息通知已生效");
      } else if (Date.now() - start > 12000) {
        /* 授权框迟迟未决：保持开启，提示允许后自动生效 */
        clearInterval(notifyWatchTimer);
        notifyWatchTimer = null;
        syncNotifyStatus();
      }
    }, 600);
  }
  function notifyWatchStop() {
    if (notifyWatchTimer) {
      clearInterval(notifyWatchTimer);
      notifyWatchTimer = null;
    }
  }
  function bindEvents(pageEl) {
    var backBtn = pageEl.querySelector('[data-act="back"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      window.MineApp.goHome();
    });
    var notifyEl = pageEl.querySelector("#set-notify");
    if (notifyEl) {
      notifyEl.addEventListener("change", function () {
        setPref("notify", notifyEl.checked);
        if (notifyEl.checked) {
          /* 打开开关 = 在用户手势内立即请求通知权限（mochi 同款） */
          syncNotifyStatus();
          if (window.MineKeepalive) {
            MineKeepalive.requestPermission(function () {
              /* granted：立即生效 */
              notifyWatchStop();
              syncNotifyStatus();
              toast("消息通知已开启");
            }, function (why) {
              if (why === "unsupported") {
                notifyEl.checked = false;
                setPref("notify", false);
                syncNotifyStatus();
                toast("当前浏览器不支持系统通知，请用 Chrome 或 Edge");
              } else if (why === "denied") {
                /* 保持开启 + 等待用户恢复权限后自动生效（mochi 同款） */
                notifyWatchStart();
                syncNotifyStatus();
                toast("通知权限被浏览器阻止：卸载重装应用时允许，或换 Chrome 重新授权；开关已保持开启，允许后自动生效");
              } else {
                /* pending / error：保持开启，等授权结果，允许后自动生效 */
                notifyWatchStart();
                syncNotifyStatus();
                toast("请留意浏览器授权弹窗，选「允许」后自动生效");
              }
            });
          }
        } else {
          notifyWatchStop();
          syncNotifyStatus();
        }
      });
    }
    var bgEl = pageEl.querySelector("#set-background");
    if (bgEl) {
      bgEl.addEventListener("change", function () {
        setPref("background", bgEl.checked);
      });
    }
    var nodedupEl = pageEl.querySelector("#set-nodedup");
    if (nodedupEl) {
      nodedupEl.addEventListener("change", function () {
        setPref("nodedup", nodedupEl.checked);
      });
    }
    var noduckEl = pageEl.querySelector("#set-noduck");
    if (noduckEl) {
      noduckEl.addEventListener("change", function () {
        setPref("noduck", noduckEl.checked);
      });
    }
    /* 应用图标：上传 / 导出 / 恢复默认 */
    var iconUpload = pageEl.querySelector("#set-icon-upload");
    var iconFile = pageEl.querySelector("#set-icon-file");
    var iconReset = pageEl.querySelector("#set-icon-reset");
    var iconDl512 = pageEl.querySelector("#set-icon-dl512");
    var iconDl192 = pageEl.querySelector("#set-icon-dl192");
    if (iconUpload && iconFile) {
      iconUpload.addEventListener("click", function () { iconFile.click(); });
      iconFile.addEventListener("change", function () {
        if (this.files && this.files[0]) applyCustomIcon(this.files[0]);
        this.value = "";
      });
    }
    if (iconReset) {
      iconReset.addEventListener("click", resetCustomIcon);
    }
    if (iconDl512) {
      iconDl512.addEventListener("click", function () { downloadCustomIcon(512); });
    }
    if (iconDl192) {
      iconDl192.addEventListener("click", function () { downloadCustomIcon(192); });
    }
    var testBtn = pageEl.querySelector("#set-test");
    var resultEl = pageEl.querySelector("#set-test-result");
    if (testBtn && resultEl) {
      testBtn.addEventListener("click", function () {
        if (!window.MineKeepalive) { resultEl.innerHTML = '<div class="card-hint">保活模块未加载</div>'; return; }
        /* 同步返回当前状态；权限为 default 时会异步请求，结果通过回调刷新 */
        var st = MineKeepalive.testNotify(function (st2) {
          renderTestResult(st2);
        });
        renderTestResult(st);
      });
    }
    /* 文件入口：打开文件管理页 */
    var filesBtn = pageEl.querySelector("#set-files");
    if (filesBtn) {
      filesBtn.addEventListener("click", function () {
        if (window.MineApp && MineApp.page) {
          MineApp.page("files");
        } else if (window.MineFiles) {
          MineFiles.renderPage();
          if (window.MineApp) MineApp.switchPage("detail", "files");
        }
      });
    }
    /* 版本更新：手动检查更新 */
    var checkUpdateBtn = pageEl.querySelector("#set-check-update");
    if (checkUpdateBtn) {
      checkUpdateBtn.addEventListener("click", checkForUpdate);
    }
    function renderTestResult(st) {
      if (!resultEl) return;
      var msg;
      if (st.requesting) {
        msg = "正在请求通知权限…请留意浏览器弹窗";
      } else if (st.sent) {
        msg = "✓ 已发送一条测试通知，请查看通知栏";
      } else if (st.permission === "unsupported") {
        msg = "✗ 当前浏览器不支持系统通知，请用 Chrome 或 Edge";
      } else if (st.permission === "denied") {
        msg = "✗ 通知权限被拒绝：打开上方「消息通知」开关重新授权，或按权限状态行指引恢复";
      } else if (st.permission === "default") {
        msg = "✗ 未发送：通知权限未授予（弹窗选「允许」后重试；没弹窗＝被浏览器自动阻止，换 Chrome 或卸载重装应用）";
      } else if (st.hint) {
        msg = "✗ " + st.hint;
      } else {
        msg = "✓ 通知通道正常";
      }
      resultEl.innerHTML = '<div class="card-hint" style="margin-top:8px;">' + escapeHtml(msg) + '</div>';
    }
  }
  /* ---------------- 暴露接口 ---------------- */
  return {
    load: load,
    renderPage: renderPage,
    getPrefs: getPrefs,
    setPref: setPref
  };
})();
