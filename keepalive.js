/* ========================================================================
   Mine · 后台保活 + 系统通知（融合 mochi 方案升级版）
   ------------------------------------------------------------------------
   目标（针对 vivo 浏览器 / Edge 安卓版）：
   · 网页进入后台后尽量保持活跃（双通道音频保活 + 退避补播 + 回前台补偿）
   · 后台收到消息 / 来电时弹出系统通知（SW 通道优先，页面通道兜底）
   · 离线消息提醒（PSYNC，学习 mochi）：页面全关 / 被系统杀死后，
     浏览器定期唤醒 SW 补发"你不在时 TA 说的话"系统通知
   · 通知去重闸：前台不弹 / 切后台 15 秒内不弹 / 内容指纹查重
   · 后台分类记账：回到前台汇总"你不在的时候收到 N 条新消息 · M 次来电"
   · 点击通知 → 跳转到对应会话
   · 聊天记录存于 localStorage，切后台 / 重进 / 刷新均不丢失
   说明：受手机系统省电机制限制，任何网页都无法 100% 保证后台永不休眠；
         本模块用「音频保活 + PSYNC 定期唤醒 + 回前台补偿 + 系统通知」
         四层手段把体验做到最好。
   设置：状态存于 localStorage "mine.settings.v1"，由设置页写入；
         本模块通过 setPref / applyPrefs 立即生效。
   接入：index.html 引入（需在 settings.js 之前）；其他模块调用
         MineKeepalive.notify(title, body, { convKey, kind, image, vibrate })。
   ======================================================================== */
window.MineKeepalive = (function () {
  "use strict";
  var PREF_KEY = "mine.settings.v1";
  var HB_KEY = "mine.keepalive.hb.v1";
  var SW_QUEUE_TTL = 60000;   // SW 未就绪时排队上限（ms）
  var NOTIFY_HIDDEN_MIN = 15000;  // 切后台 15 秒内的旧内容不弹
  var DEDUP_WINDOW = 120000;  // 同内容通知去重窗口（ms）
  var RETRY_BASE = 5000;      // 音频补播基础退避（ms）
  var RETRY_MAX = 60000;      // 音频补播退避上限（ms）
  var RETRY_HIDDEN_MAX = 20000; // 后台退避封顶（ms）

  /* ---------------- 用户偏好（与"设置"页联动） ----------------
     notify:    消息通知（后台新消息/来电时是否弹系统通知）
     background:后台运行（是否启用音频保活 + 屏幕常亮）
     nodedup:   通知逐条弹（true = 关闭去重，每条都弹）
     noduck:    保活不抢其他 App 声音（true = WebAudio 通道，不占媒体通道） */
  var prefs = { notify: true, background: true, nodedup: false, noduck: true };

  /* ---------------- 音频保活状态 ---------------- */
  var keepAudio = null;       // 媒体元素通道（noduck=false 时）
  var waCtx = null;           // WebAudio 通道（noduck=true 时）
  var waGain = null;
  var waSrc = null;
  var audioMode = "wa";       // "wa" | "media"
  var audioStarted = false;
  var kaRetryTimer = null;
  var kaBackoff = 1;

  /* ---------------- 通知状态 ---------------- */
  var hiddenAt = 0;           // 进入后台的时间戳
  var swQueue = [];           // SW 未就绪时的通知队列
  var swQueueTimer = null;
  var recentKeys = {};        // 去重：指纹 → 时间戳
  var hiddenSent = {};        // 后台分类记账 { msg: n, call: n }
  var hiddenByConv = {};      // 后台按会话计数 { convKey: n }
  var stallCount = 0;         // 被系统冻结次数（心跳空洞 > 90s）
  var lastHb = Date.now();

  /* ---------------- 其他 ---------------- */
  var wakeLock = null;
  var listenersBound = false;
  var gestureBound = false;

  /* ==================== 偏好持久化 ==================== */
  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREF_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p.notify === "boolean") prefs.notify = p.notify;
        if (p && typeof p.background === "boolean") prefs.background = p.background;
        if (p && typeof p.nodedup === "boolean") prefs.nodedup = p.nodedup;
        if (p && typeof p.noduck === "boolean") prefs.noduck = p.noduck;
      }
    } catch (e) {}
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
  }
  function getPrefs() {
    return { notify: prefs.notify, background: prefs.background, nodedup: prefs.nodedup, noduck: prefs.noduck };
  }
  function setPref(key, val) {
    if (key === "notify" || key === "background" || key === "nodedup" || key === "noduck") {
      prefs[key] = !!val;
      savePrefs();
      applyPrefs();
    }
  }

  /* ==================== 保活音频（18kHz 人耳几乎听不到的弱音） ====================
     与纯 0 静音不同：部分浏览器会对"完全静音"的音频做静音优化（暂停），
     高频弱音既能维持"正在播放"状态，又几乎不可闻。 */
  function toneWavDataURL(seconds, freq, amp) {
    var sampleRate = 44100;
    var numSamples = Math.floor(sampleRate * seconds);
    var dataSize = numSamples * 2;               // 16-bit 单声道
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);
    function writeString(off, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    }
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                 // PCM
    view.setUint16(22, 1, true);                 // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);    // 字节率
    view.setUint16(32, 2, true);                 // 块对齐
    view.setUint16(34, 16, true);                // 位深
    writeString(36, "data");
    view.setUint32(40, dataSize, true);
    var ampMax = Math.round(amp * 32767);
    for (var i = 0; i < numSamples; i++) {
      var v = Math.sin(2 * Math.PI * freq * i / sampleRate) * ampMax;
      view.setInt16(44 + i * 2, v, true);
    }
    var bytes = new Uint8Array(buffer);
    var binary = "";
    var chunk = 0x8000;
    for (var j = 0; j < bytes.length; j += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(j, j + chunk));
    }
    return "data:audio/wav;base64," + btoa(binary);
  }

  /* ==================== 音量策略 ====================
     前台 volume=0（保持"播放中"状态但不发声）；后台 0.2；
     检测到一次断流升到 0.35（更响一点，帮系统确认"还在播"）。 */
  var kaToneLevel = 0.2;
  function setKaVolume(v) {
    if (audioMode === "media" && keepAudio) {
      try { keepAudio.volume = v; } catch (e) {}
    } else if (waGain && waGain.gain) {
      try {
        var now = waCtx.currentTime;
        waGain.gain.cancelScheduledValues(now);
        waGain.gain.setValueAtTime(Math.max(v, 0.0001), now);
      } catch (e) {}
    }
  }
  function applyVolumeByVisibility() {
    if (document.visibilityState === "visible") setKaVolume(0);
    else setKaVolume(kaToneLevel);
  }

  /* ==================== 退避补播 ====================
     音频被系统暂停/打断/播完 → 指数退避重试（5s→60s，后台封顶 20s）。 */
  function scheduleRetry() {
    if (kaRetryTimer) { clearTimeout(kaRetryTimer); kaRetryTimer = null; }
    var delay = Math.min(RETRY_BASE * kaBackoff, RETRY_MAX);
    if (document.visibilityState !== "visible" && delay > RETRY_HIDDEN_MAX) {
      delay = RETRY_HIDDEN_MAX;
    }
    kaRetryTimer = setTimeout(function () {
      kaRetryTimer = null;
      if (!prefs.background) return;
      startKeepaliveAudio();
    }, delay);
  }
  function markStall() {
    // 断流一次：升音量 + 退避回 1（下次暂停从 5s 开始）
    kaBackoff = 1;
    kaToneLevel = 0.35;
    applyVolumeByVisibility();
  }

  /* ==================== 启动保活音频（按 noduck 选通道） ==================== */
  function startKeepaliveAudio() {
    if (!prefs.background) return;
    if (audioStarted && keepAudio && audioMode === "media") {
      // 媒体模式已在播：补播一次
      try { keepAudio.play(); } catch (e) {}
      return;
    }
    if (audioStarted && waCtx && audioMode === "wa") {
      // WebAudio 已在播：尝试恢复上下文
      try { if (waCtx.state === "suspended") waCtx.resume(); } catch (e) {}
      return;
    }
    audioStarted = true;
    kaBackoff = 1;
    try {
      var wantWA = prefs.noduck;
      if (wantWA) {
        /* ---- WebAudio 通道：不占媒体通道，不压低其他 App 声音 ---- */
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { startMediaKeepalive(); return; }
        stopMediaKeepalive();
        waCtx = new AC();
        var buf = waCtx.createBuffer(1, Math.floor(waCtx.sampleRate * 2), waCtx.sampleRate);
        var data = buf.getChannelData(0);
        for (var i = 0; i < data.length; i++) {
          data[i] = Math.sin(2 * Math.PI * 18000 * i / waCtx.sampleRate) * 0.02;
        }
        waGain = waCtx.createGain();
        waGain.gain.value = 0.0001;
        waSrc = waCtx.createBufferSource();
        waSrc.buffer = buf;
        waSrc.loop = true;
        waSrc.connect(waGain);
        waGain.connect(waCtx.destination);
        waSrc.onended = scheduleRetry;   // 被系统打断
        waSrc.start();
        audioMode = "wa";
        // WebAudio 通道不设置媒体会话横幅（不占媒体通道）
        clearMediaSession();
      } else {
        startMediaKeepalive();
      }
      applyVolumeByVisibility();
    } catch (e) {
      audioStarted = false;
      waCtx = null; waGain = null; waSrc = null;
    }
  }
  /* 媒体元素通道：占媒体通道，通知栏出现"后台保活"媒体横幅 */
  function startMediaKeepalive() {
    stopWAKeeplive();
    var url = toneWavDataURL(2, 18000, 0.02);
    var a = new Audio(url);
    a.loop = true;
    a.preload = "auto";
    a.volume = 0;
    a.addEventListener("pause", scheduleRetry);
    a.addEventListener("ended", scheduleRetry);
    a.play().catch(function () {
      // 自动播放被拒：等下一次手势再试
      audioStarted = false;
      keepAudio = null;
    });
    keepAudio = a;
    audioMode = "media";
    setMediaSession();
  }
  /* 媒体会话横幅（仅媒体通道） */
  function setMediaSession() {
    try {
      if (navigator.mediaSession && "metadata" in navigator.mediaSession) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: "Mine 后台保活", artist: "" });
      }
    } catch (e) {}
  }
  function clearMediaSession() {
    try {
      if (navigator.mediaSession && "metadata" in navigator.mediaSession) {
        navigator.mediaSession.metadata = null;
      }
    } catch (e) {}
  }
  function stopWAKeeplive() {
    try { if (waSrc) { waSrc.onended = null; waSrc.stop(); } } catch (e) {}
    try { if (waCtx && waCtx.state !== "closed") waCtx.close(); } catch (e) {}
    waCtx = null; waGain = null; waSrc = null;
  }
  function stopMediaKeepalive() {
    var a = keepAudio;
    keepAudio = null;
    if (a) {
      try { a.pause(); a.src = ""; } catch (e) {}
    }
    clearMediaSession();
  }
  /* 停止全部保活音频（设置页关闭"后台运行"时调用） */
  function stopAudioKeepalive() {
    if (kaRetryTimer) { clearTimeout(kaRetryTimer); kaRetryTimer = null; }
    stopWAKeeplive();
    stopMediaKeepalive();
    audioStarted = false;
  }

  /* ==================== PSYNC 离线消息提醒（零后端，学习 mochi） ====================
     页面全关 / 被系统杀死后，由浏览器定期唤醒 SW 补发通知。
     页面端职责：把后台期间用户未读的消息文案写入快照（IDB mine-psync），
     并注册 periodicsync；SW 唤醒时读快照 → 弹通知。 */
  var PSYNC_TAG = "mine-msg";
  var PSYNC_SNAP_KEY = "mine.psync.snap.v1";
  var PSYNC_SNAP_TTL = 7 * 24 * 60 * 60 * 1000;
  var PSYNC_MAX = 30;
  var psyncWriteChain = Promise.resolve(); // 串行化快照写入，防并发覆盖
  function psyncSupported() {
    try { return "serviceWorker" in navigator && "PeriodicSyncManager" in window; } catch (e) { return false; }
  }
  function psyncStandalone() {
    try {
      return !!(window.matchMedia && window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches);
    } catch (e) { return false; }
  }
  function psyncOpenDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("mine-psync", 1);
      req.onupgradeneeded = function () {
        try {
          if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
        } catch (e) {}
      };
      req.onsuccess = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("kv")) {
          /* 异常残留（库存在但无 kv store）：删除重建 */
          try { db.close(); } catch (e) {}
          var del = indexedDB.deleteDatabase("mine-psync");
          del.onsuccess = function () {
            var req2 = indexedDB.open("mine-psync", 1);
            req2.onupgradeneeded = function () {
              try {
                if (!req2.result.objectStoreNames.contains("kv")) req2.result.createObjectStore("kv");
              } catch (e) {}
            };
            req2.onsuccess = function () { resolve(req2.result); };
            req2.onerror = function () { reject(req2.error); };
          };
          del.onerror = function () { reject(del.error); };
          return;
        }
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error("psync idb open fail")); };
    });
  }
  function psyncGet(key) {
    return psyncOpenDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("kv", "readonly");
        var rq = tx.objectStore("kv").get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }
  function psyncSet(key, val) {
    return psyncOpenDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  /* 后台消息入快照（供 SW 页面全关后补发提醒；同文本 30 分钟内不重复）
     快照写入不要求 standalone（标签页模式也记录，安装后即可补发）；
     注册 periodicsync 才要求 standalone（浏览器策略）。 */
  function pushPsyncSnapshot(title, body, convKey) {
    if (!psyncSupported()) return;
    var text = String(body || title || "")
      .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[图片]")
      .trim().slice(0, 60);
    if (!text) return;
    psyncWriteChain = psyncWriteChain.then(function () {
      return psyncGet(PSYNC_SNAP_KEY).then(function (snap) {
        if (!snap || typeof snap !== "object") {
          snap = { v: 1, ts: Date.now(), name: "Mine", convKey: convKey || null, texts: [] };
        }
        if (Date.now() - (snap.ts || 0) > PSYNC_SNAP_TTL) {
          snap = { v: 1, ts: Date.now(), name: snap.name || "Mine", convKey: convKey || snap.convKey || null, texts: [] };
        }
        snap.ts = Date.now();
        /* 全量查重：最近 30 分钟内的同文本不重复入 */
        for (var i = snap.texts.length - 1; i >= 0; i--) {
          var it2 = snap.texts[i];
          if (!it2) continue;
          if (Date.now() - (it2.ts || 0) > 30 * 60000) break;
          if (it2.t === text) return;
        }
        snap.texts.push({ t: text, ts: Date.now() });
        if (snap.texts.length > PSYNC_MAX) snap.texts = snap.texts.slice(-PSYNC_MAX);
        return psyncSet(PSYNC_SNAP_KEY, snap);
      }).catch(function () {});
    });
  }
  /* 注册 periodicsync（Chromium + 已添加到主屏时调用；失败静默） */
  function psyncApply() {
    if (!psyncSupported()) return;
    var registerIt = function () {
      try {
        navigator.serviceWorker.ready.then(function (reg) {
          var pm = (reg && reg.periodicSync) || window.navigator.periodicSync;
          if (pm && pm.register) {
            pm.register(PSYNC_TAG, { minInterval: 6 * 60 * 60 * 1000 }).catch(function () {});
          }
        }).catch(function () {});
      } catch (e) {}
    };
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "periodic-background-sync" }).then(function (st) {
          if (st && st.state === "denied") return;
          registerIt();
        }).catch(registerIt);
      } else {
        registerIt();
      }
    } catch (e) {
      registerIt();
    }
  }

  /* ==================== 系统通知 ==================== */
  function notificationsSupported() {
    return typeof window.Notification !== "undefined";
  }
  /* 安全上下文检测：Notification API 仅在 HTTPS（或 localhost）下可用 */
  function isSecureCtx() {
    try {
      if (typeof window.isSecureContext === "boolean") return window.isSecureContext;
      return location.protocol === "https:" ||
             location.hostname === "localhost" ||
             location.hostname === "127.0.0.1" ||
             location.hostname === "[::1]";
    } catch (e) { return false; }
  }
  /* iOS 检测：普通 Safari 网页无 Notification API，需添加到主屏幕以 PWA 运行 */
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent || "");
  }
  function isStandalonePWA() {
    try {
      return navigator.standalone === true ||
             (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    } catch (e) { return false; }
  }
  /* 权限状态 + 环境信息 + 针对性提示（供设置页"测试通知"展示） */
  function getPermissionInfo() {
    var supported = notificationsSupported();
    var info = {
      supported: supported,
      permission: supported ? Notification.permission : "unsupported",
      secure: isSecureCtx(),
      ios: isIOS(),
      standalone: isStandalonePWA(),
      sw: "serviceWorker" in navigator,
      hint: ""
    };
    if (!supported) {
      if (info.ios && !info.standalone) {
        info.hint = "iOS 浏览器普通网页无法使用网页通知：请用 Safari 打开本站，点分享按钮 →「添加到主屏幕」，从主屏幕图标进入后通知功能即可用。";
      } else if (!info.secure) {
        info.hint = "通知功能需要 HTTPS 安全连接（localhost 除外）。当前页面非安全连接，浏览器禁用了通知 API，请使用 HTTPS 地址访问本站。";
      } else {
        info.hint = "当前浏览器不支持网页通知（Notification API）。";
      }
    } else if (info.permission === "default") {
      if (!info.secure) {
        info.hint = "当前页面非 HTTPS 安全连接，通知权限可能无法生效：请用 https:// 地址访问本站后再测试。";
      } else {
        info.hint = "通知权限尚未授予：请点击下方「测试」按钮（浏览器会弹一次授权框，请选「允许」）；若授权框不出现，说明浏览器已自动阻止本站请求——请到 浏览器设置 → 网站设置 → 通知 → 找到本站 → 重置权限/添加网站例外 后再测试。";
      }
    } else if (info.permission === "denied") {
      info.hint = "通知权限已被拒绝/自动禁止：① 地址栏左侧图标 → 网站设置 → 权限 → 通知 → 允许；② 若授权框不再出现（被自动阻止）→ 浏览器设置 → 网站设置 → 通知 → 找到本站（alexcrow1901.github.io）→ 改为「允许」或重置权限；③ 从桌面图标打开时通知由应用自己管理——长按图标卸载后重新「添加到主屏幕/安装」，安装时允许通知。";
    }
    return info;
  }
  /* 请求通知权限：default 时在用户手势内主动请求一次（返回当前状态字符串，异步结果由调用方按需处理） */
  /* 请求通知权限（mochi 同款：仅由用户主动操作触发，绝不自动请求）
     cb(f)  = 授权成功回调；failCb(why) = 'unsupported'|'denied'|'pending'|'error'
     兼容旧同步用法：不传回调时仍返回状态字符串 */
  function requestNotificationPermission(cb, failCb) {
    if (!notificationsSupported()) {
      if (failCb) failCb("unsupported");
      return "unsupported";
    }
    if (Notification.permission === "granted") {
      if (cb) cb();
      return "granted";
    }
    if (Notification.permission === "denied") {
      if (failCb) failCb("denied");
      return "denied";
    }
    try {
      var r = Notification.requestPermission();
      if (r && typeof r.then === "function") {
        r.then(function (p) {
          var final = p || Notification.permission || "default";
          if (final === "granted") { if (cb) cb(); }
          else { if (failCb) failCb(final === "denied" ? "denied" : "pending"); }
        }, function () {
          if (failCb) failCb("error");
        });
        return "default";
      }
      if (typeof r === "string") {
        if (r === "granted") { if (cb) cb(); }
        else { if (failCb) failCb(r === "denied" ? "denied" : "pending"); }
        return r;
      }
      /* 老式/无返回值实现：以当前属性为准 */
      if (Notification.permission === "granted") { if (cb) cb(); }
      else if (failCb) failCb(Notification.permission === "denied" ? "denied" : "pending");
    } catch (e) {
      if (failCb) failCb("error");
    }
    return Notification.permission || "default";
  }
  /* 通知去重指纹 */
  function normKey(s) {
    return String(s || "").replace(/\s+/g, "").replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[img]").slice(0, 100);
  }
  function dedupCheck(title, body) {
    var key = normKey(title) + "|" + normKey(body);
    var now = Date.now();
    if (recentKeys[key] && now - recentKeys[key] < DEDUP_WINDOW) return true; // 重复
    recentKeys[key] = now;
    // 清理过期
    var keys = Object.keys(recentKeys);
    for (var i = 0; i < keys.length; i++) {
      if (now - recentKeys[keys[i]] > DEDUP_WINDOW) delete recentKeys[keys[i]];
    }
    return false;
  }
  /* 页面通道（兜底） */
  function pageNotify(title, body, opts) {
    if (!notificationsSupported() || Notification.permission !== "granted") return false;
    try {
      var o = {
        body: body || "",
        tag: (opts && opts.tag) || aggTag(opts && opts.convKey),
        renotify: true,
        data: { convKey: (opts && opts.convKey) || null, kind: (opts && opts.kind) || "msg" }
      };
      if (opts && opts.image) o.icon = opts.image;
      if (opts && opts.vibrate) o.vibrate = opts.vibrate;
      var n = new Notification(title || "Mine", o);
      n.onclick = function () {
        try { window.focus(); } catch (e) {}
        try { n.close(); } catch (e) {}
        dispatchNotifyClick(opts);
      };
      setTimeout(function () { try { n.close(); } catch (e) {} }, 10000);
      return true;
    } catch (e) { return false; }
  }
  /* SW 通道（首选：页面被冻结/锁屏仍可弹） */
  function swNotify(title, body, opts) {
    if (!("serviceWorker" in navigator)) return "no-sw";
    var reg = null;
    try { reg = navigator.serviceWorker; } catch (e) { return "no-sw"; }
    if (!reg || !reg.ready) return "no-sw";
    // SW 未就绪 → 排队（上限 60s 后转页面通道）
    var item = { title: title, body: body, opts: opts || {} };
    swQueue.push(item);
    scheduleSwQueue();
    return "queued";
  }
  function scheduleSwQueue() {
    if (swQueueTimer) return;
    swQueueTimer = setTimeout(function () {
      swQueueTimer = null;
      if (swQueue.length === 0) return;
      var items = swQueue.splice(0, swQueue.length);
      var pending = [];
      navigator.serviceWorker.ready.then(function (registration) {
        items.forEach(function (it) {
          var o = {
            body: it.body || "",
            tag: (it.opts && it.opts.tag) || aggTag(it.opts && it.opts.convKey),
            renotify: true,
            data: { convKey: (it.opts && it.opts.convKey) || null, kind: (it.opts && it.opts.kind) || "msg" }
          };
          if (it.opts && it.opts.image) o.icon = it.opts.image;
          if (it.opts && it.opts.vibrate) o.vibrate = it.opts.vibrate;
          registration.showNotification(it.title || "Mine", o).catch(function () {
            pending.push(it);
          });
        });
        // showNotification 失败的转页面通道
        pending.forEach(function (it) { pageNotify(it.title, it.body, it.opts); });
      }).catch(function () {
        items.forEach(function (it) { pageNotify(it.title, it.body, it.opts); });
      });
    }, 800); // 等 SW ready 一小会儿；ready 未决时 60s 由外部兜底
  }
  function flushSwQueueToPage() {
    if (swQueueTimer) { clearTimeout(swQueueTimer); swQueueTimer = null; }
    if (swQueue.length === 0) return;
    var items = swQueue.splice(0, swQueue.length);
    items.forEach(function (it) { pageNotify(it.title, it.body, it.opts); });
  }
  /* 点击通知 → 广播事件（页面内 + SW 转发） */
  function dispatchNotifyClick(opts) {
    try {
      document.dispatchEvent(new CustomEvent("mine:notify-click", {
        detail: { convKey: (opts && opts.convKey) || null, kind: (opts && opts.kind) || "msg" }
      }));
    } catch (e) {}
  }
  /* ==================== 微信式聚合通知 ====================
     后台短时间内收到多条消息 → 合并为一条通知：
     · 标题：会话名（N 条新消息）
     · 正文：每条消息一行（最多 4 条，超出显示"共 N 条新消息"）
     · 同会话使用相同 tag → 通知栏内自动替换为最新聚合，
       不再出现"只看到最新一条消息"的问题 */
  var AGG_DELAY = 1500;           // 合并窗口（ms）：窗口内到达的消息并入同一条
  var AGG_MAX_SHOW = 4;           // 正文最多显示条数
  var aggByConv = {};             // convKey -> 聚合缓冲
  function aggTag(convKey) {
    return "mine-" + (convKey || "all");
  }
  function enqueueAgg(title, body, opts) {
    var convKey = opts.convKey || "_all";
    var text = String(body || title || "")
      .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[图片]")
      .trim().slice(0, 80);
    if (!text) text = "(新消息)";
    if (!aggByConv[convKey]) {
      aggByConv[convKey] = {
        title: title || "Mine",
        convKey: opts.convKey || null,
        kind: opts.kind || "msg",
        image: opts.image || null,
        vibrate: opts.vibrate || null,
        items: [],
        timer: null
      };
    }
    var a = aggByConv[convKey];
    a.items.push(text);
    if (a.items.length > 10) a.items.shift();
    /* 连续到达时重置计时器：消息流结束后 AGG_DELAY 再统一弹出 */
    if (a.timer) clearTimeout(a.timer);
    a.timer = setTimeout(function () { flushAgg(convKey); }, AGG_DELAY);
  }
  function flushAgg(convKey) {
    var a = aggByConv[convKey];
    if (!a) return;
    delete aggByConv[convKey];
    if (!a.items.length) return;
    var n = a.items.length;
    var show = a.items.slice(0, AGG_MAX_SHOW);
    var body = show.join("\n");
    var title = a.title;
    if (n > 1) {
      title = a.title + "（" + n + " 条新消息）";
      if (n > AGG_MAX_SHOW) body += "\n… 共 " + n + " 条新消息";
    }
    var opts = {
      convKey: a.convKey,
      kind: a.kind,
      image: a.image,
      vibrate: a.vibrate,
      tag: aggTag(a.convKey)          // 同会话同 tag：通知栏内替换为最新聚合
    };
    var r = swNotify(title, body, opts);
    if (r === "no-sw") pageNotify(title, body, opts);
    else if (r === "queued") {
      // SW ready 超时兜底
      setTimeout(function () {
        if (!("serviceWorker" in navigator)) { flushSwQueueToPage(); return; }
        try {
          navigator.serviceWorker.ready.then(function () {}, function () { flushSwQueueToPage(); });
        } catch (e) { flushSwQueueToPage(); }
      }, SW_QUEUE_TTL);
    }
  }
  /* 对外通知入口（聚合 + 记账 + 通道选择）
     后台多条消息先入聚合缓冲，延迟合并为一条微信式通知 */
  function notify(title, body, opts) {
    if (!prefs.notify) return;
    if (!notificationsSupported()) return;
    if (Notification.permission !== "granted") return;
    opts = opts || {};
    // 去重闸 ①：前台可见不弹（页面在看，无需打扰）
    if (document.visibilityState === "visible") return;
    // 去重闸 ②：切后台 15 秒内的旧内容不弹
    if (hiddenAt && Date.now() - hiddenAt < NOTIFY_HIDDEN_MIN) return;
    // 去重闸 ③：内容指纹查重（开启"逐条弹"则跳过）
    if (!prefs.nodedup && dedupCheck(title, body)) return;
    // 分类记账（用于回前台汇总）
    var kind = opts.kind || "msg";
    if (!hiddenSent[kind]) hiddenSent[kind] = 0;
    hiddenSent[kind]++;
    if (opts.convKey) {
      if (!hiddenByConv[opts.convKey]) hiddenByConv[opts.convKey] = 0;
      hiddenByConv[opts.convKey]++;
    }
    // 入 PSYNC 快照：页面全关后 SW 也能补发提醒（学习 mochi 方案）
    pushPsyncSnapshot(title, body, opts.convKey);
    // 聚合缓冲 → 延迟合并弹出
    enqueueAgg(title, body, opts);
  }

  /* ==================== Wake Lock 屏幕常亮（前台辅助） ==================== */
  function wakeLockSupported() {
    return navigator && typeof navigator.wakeLock === "object" &&
           typeof navigator.wakeLock.request === "function";
  }
  function requestWakeLock() {
    if (!prefs.background) return;
    if (!wakeLockSupported()) return;
    try {
      navigator.wakeLock.request("screen").then(function (lock) {
        wakeLock = lock;
        try { lock.addEventListener("release", function () { wakeLock = null; }); } catch (e) {}
      }).catch(function () { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  function releaseWakeLock() {
    if (wakeLock) {
      try { wakeLock.release(); } catch (e) {}
      wakeLock = null;
    }
  }

  /* ==================== 设置变更后立即生效 ==================== */
  function applyPrefs() {
    if (prefs.background) {
      startKeepaliveAudio();
      requestWakeLock();
    } else {
      stopAudioKeepalive();
      releaseWakeLock();
    }
  }

  /* ==================== 心跳 / 断流检测 ==================== */
  function writeHeartbeat() {
    try { localStorage.setItem(HB_KEY, String(Date.now())); } catch (e) {}
  }
  function checkStall() {
    try {
      var raw = localStorage.getItem(HB_KEY);
      if (raw) {
        var gap = Date.now() - parseInt(raw, 10);
        if (gap > 90000) stallCount++;   // 被冻结过
      }
    } catch (e) {}
    writeHeartbeat();
  }

  /* ==================== 生命周期 ==================== */
  function onBecameVisible() {
    // 汇总后台期间的通知（分类记账 → 广播给 chat.js 显示 toast）
    var total = 0;
    var calls = 0;
    Object.keys(hiddenSent).forEach(function (k) {
      if (k === "call") calls += hiddenSent[k];
      total += hiddenSent[k];
    });
    if (total > 0) {
      try {
        document.dispatchEvent(new CustomEvent("mine:notify-summary", {
          detail: { total: total, calls: calls, byConv: hiddenByConv }
        }));
      } catch (e) {}
      hiddenSent = {};
      hiddenByConv = {};
    }
    // 恢复保活
    startKeepaliveAudio();
    applyVolumeByVisibility();
    requestWakeLock();
    checkStall();
  }
  function onBecameHidden() {
    hiddenAt = Date.now();
    applyVolumeByVisibility();
    writeHeartbeat();
  }
  function bindLifecycle() {
    if (listenersBound) return;
    listenersBound = true;
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") onBecameVisible();
      else onBecameHidden();
    });
    window.addEventListener("pageshow", function (e) {
      if (e.persisted) onBecameVisible();
    });
    window.addEventListener("resume", onBecameVisible);
    window.addEventListener("freeze", function () { writeHeartbeat(); });
    window.addEventListener("pagehide", function () { writeHeartbeat(); });
    // SW 转发通知点击
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", function (e) {
        var d = e.data || {};
        if (d.type === "mine:notify-click") {
          try {
            document.dispatchEvent(new CustomEvent("mine:notify-click", {
              detail: { convKey: d.convKey || null, kind: d.kind || "msg" }
            }));
          } catch (err) {}
        }
      });
    }
  }
  /* 首次用户交互后启动保活（浏览器自动播放策略要求用户手势）
     注意：绝不在此自动请求通知权限！浏览器会把"反复弹出授权框"的
     站点自动静默阻止（权限变自动禁止），此后 requestPermission 不再弹窗。
     权限只由用户显式触发（设置页"测试通知"按钮 / 主动操作）时请求一次。 */
  function bindFirstInteraction() {
    if (gestureBound) return;
    gestureBound = true;
    function gesture() {
      startKeepaliveAudio();
      requestWakeLock();
      writeHeartbeat();
      ["click", "touchstart", "touchend", "keydown"].forEach(function (ev) {
        window.removeEventListener(ev, gesture);
      });
    }
    ["click", "touchstart", "touchend", "keydown"].forEach(function (ev) {
      window.addEventListener(ev, gesture, { passive: true, capture: false });
    });
  }
  /* 心跳：检测真实时间流逝，广播 mine:timeskip */
  function startHeartbeat() {
    lastHb = Date.now();
    setInterval(function () {
      var now = Date.now();
      var gap = now - lastHb;
      lastHb = now;
      if (gap > 6000) {
        try {
          document.dispatchEvent(new CustomEvent("mine:timeskip", { detail: { gap: gap } }));
        } catch (e) {}
      }
    }, 2000);
  }

  /* ==================== 测试体检（设置页"测试"按钮） ====================
     同步返回当前状态；若权限为 default，会在用户手势内发起一次请求，
     结果通过回调 cb(status) 异步返回（granted 后自动补发一条测试通知）。 */
  function testNotify(cb) {
    var info = getPermissionInfo();
    var status = {
      sw: info.sw,
      secure: info.secure,
      ios: info.ios,
      standalone: info.standalone,
      supported: info.supported,
      permission: info.permission,
      hint: info.hint,
      prefs: getPrefs(),
      audioMode: audioMode,
      audioPlaying: audioMode === "media" ? !!keepAudio : !!(waCtx && waCtx.state === "running"),
      wakeLock: !!wakeLock,
      stall: stallCount,
      queue: swQueue.length,
      psync: { supported: psyncSupported(), standalone: psyncStandalone() },
      requesting: false,
      sent: false
    };
    function sendTest() {
      var opts = { convKey: null, kind: "msg" };
      swNotify("Mine 测试通知", "后台保活与消息通知已就绪", opts);
      status.sent = true;
      status.hint = "";
    }
    if (info.permission === "granted") {
      sendTest();
    } else if (info.permission === "default" && info.supported) {
      /* 用户手势内主动请求权限（异步），结果刷新到 status */
      status.requesting = true;
      try {
        var r = Notification.requestPermission();
        if (r && typeof r.then === "function") {
          r.then(function (p) {
            status.requesting = false;
            status.permission = p || Notification.permission || "default";
            if (p === "granted") {
              sendTest();
            } else if (p === "denied") {
              status.hint = "通知权限被拒绝：请在浏览器地址栏左侧图标 → 网站设置/权限 → 通知 → 允许；若浏览器设置已允许，请检查手机「系统设置 → 通知」是否允许该浏览器。";
            } else {
              status.hint = "通知权限仍未授予：请在浏览器地址栏左侧图标 → 网站设置/权限 → 通知 → 允许，然后再次测试。";
            }
            if (cb) cb(status);
          }, function () {
            status.requesting = false;
            if (cb) cb(status);
          });
        } else if (typeof r === "string") {
          status.requesting = false;
          status.permission = r;
          if (r === "granted") sendTest();
          if (cb) cb(status);
        } else {
          /* 老式/无返回值实现：以当前属性为准 */
          status.requesting = false;
          status.permission = Notification.permission || "default";
          if (status.permission === "granted") sendTest();
          if (cb) cb(status);
        }
      } catch (e) {
        status.requesting = false;
        if (cb) cb(status);
      }
    }
    return status;
  }

  /* ==================== 初始化 ==================== */
  function init() {
    loadPrefs();
    bindLifecycle();
    bindFirstInteraction();
    startHeartbeat();
    writeHeartbeat();
    if (document.visibilityState === "visible") {
      startKeepaliveAudio();
      requestWakeLock();
    }
    /* PSYNC 离线提醒：延迟注册（等 SW ready + 权限就绪，失败静默） */
    setTimeout(psyncApply, 5000);
  }
  init();
  return {
    init: init,
    notify: notify,
    requestPermission: requestNotificationPermission,
    startAudioKeepalive: startKeepaliveAudio,
    requestWakeLock: requestWakeLock,
    releaseWakeLock: releaseWakeLock,
    stopAudioKeepalive: stopAudioKeepalive,
    getPrefs: getPrefs,
    setPref: setPref,
    applyPrefs: applyPrefs,
    testNotify: testNotify,
    isBackground: function () { return document.visibilityState !== "visible"; },
    notificationsSupported: notificationsSupported,
    psyncSupported: psyncSupported,
    psyncStandalone: psyncStandalone
  };
})();
