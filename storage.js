/* ========================================================================
   Mine · 大容量存储增强（storage.js）
   ------------------------------------------------------------------------
   · 保持 localStorage 的同步 API（getItem / setItem / removeItem / clear）
   · 底层额外写入 IndexedDB，突破浏览器 5MB 配额限制（图片字卡 / 语音字卡 / 聊天背景等）
   · 原生 localStorage 作为"降级镜像"：写入尽力同步（超配额时静默）
   · 首次加载同步用原生数据种子化缓存 → 兼容历史数据（升级不丢数据）
   · 异步从 IndexedDB 恢复后，以 IndexedDB 中较新的键覆盖缓存
   · 本次会话写入过的键（dirty）恢复时优先保留，防止旧数据覆盖新数据
   数据安全（重要约定）：
   · 迭代升级只优化功能，绝不主动删除聊天记录 / 朋友圈 / 联系人等任何用户数据
   · 写入采用"同步原生镜像 + 短防抖 IndexedDB 持久化 + 卸载/后台立即冲刷"三级保障，
     刷新或关闭页面时尽可能把最新数据落盘，避免丢失
   注意：必须在其它脚本之前加载（见 index.html）。
   ======================================================================== */

(function () {
  "use strict";

  if (window.__mineStorageInstalled) return;
  window.__mineStorageInstalled = true;

  var DB_NAME = "mine-storage";
  var DB_VER = 1;
  var STORE = "kv";
  var META_KEY = "mine.storage.meta.v1";

  /* 捕获原生 localStorage 引用（必须在覆盖 window.localStorage 之前）：
     镜像写入必须走原生对象，否则会递归调用自定义 store 导致栈溢出，
     原生镜像将永远写不进去。 */
  var nativeLS = null;
  try { nativeLS = window.localStorage; } catch (e) {}

  function openDB(cb) {
    var req;
    try { req = indexedDB.open(DB_NAME, DB_VER); }
    catch (e) { cb(null); return; }
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = function () { cb(req.result); };
    req.onerror = function () { cb(null); };
    req.onblocked = function () { /* 等待其它页签关闭连接，不阻塞业务 */ };
  }

  function dbGetAll(db, cb) {
    try {
      var tx = db.transaction(STORE, "readonly");
      var store = tx.objectStore(STORE);
      /* 修复：无 keyPath 的键值仓库 getAll() 只返回值、不含 key，
         必须用 getAllKeys() + get() 还原出 {key, value} 对，
         否则恢复循环里的 e.key 永远为空，IndexedDB 数据永远不会被读回。 */
      var keysReq = store.getAllKeys();
      keysReq.onsuccess = function () {
        var keys = keysReq.result || [];
        if (keys.length === 0) { cb([]); return; }
        var entries = [];
        var pending = keys.length;
        keys.forEach(function (k) {
          var getReq = store.get(k);
          getReq.onsuccess = function () {
            entries.push({ key: k, value: getReq.result });
            if (--pending === 0) cb(entries);
          };
          getReq.onerror = function () { if (--pending === 0) cb(entries); };
        });
      };
      keysReq.onerror = function () { cb([]); };
    } catch (e) { cb([]); }
  }

  function dbPutAll(db, entries, cb) {
    try {
      var tx = db.transaction(STORE, "readwrite");
      var store = tx.objectStore(STORE);
      entries.forEach(function (e) { store.put(e.value, e.key); });
      tx.oncomplete = function () { if (cb) cb(); };
      tx.onerror = function () { if (cb) cb(); };
      tx.onabort = function () { if (cb) cb(); };
    } catch (e) { if (cb) cb(); }
  }

  /* ---- 同步缓存：先用原生 localStorage 种子化（升级兼容） ---- */
  var cache = {};
  var dirty = {};   // 本次会话写入过的键：恢复时优先保留内存中的新值
  try {
    var seedSource = nativeLS || localStorage;
    for (var i = 0; i < seedSource.length; i++) {
      var k = seedSource.key(i);
      if (k != null) cache[k] = seedSource.getItem(k);
    }
  } catch (e) {}

  /* ---- IndexedDB 持久化（防抖 + 立即冲刷） ---- */
  var persistTimer = null;
  var flushing = false;

  /* 立即把当前缓存全量写入 IndexedDB（幂等：写入所有键） */
  var hydrated = false;
  function flushNow() {
    if (flushing) return;
    flushing = true;
    openDB(function (db) {
      flushing = false;
      if (!db) return;
      var entries = [];
      if (!hydrated) {
        for (var key in cache) if (dirty[key]) entries.push({ key: key, value: cache[key] });
      } else {
        for (var key in cache) entries.push({ key: key, value: cache[key] });
      }
      if (entries.length) dbPutAll(db, entries);
    });
  }

  /* 短防抖：合并密集写入，降低 IndexedDB 事务开销 */
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      persistTimer = null;
      flushNow();
    }, 150);
  }

  /* 页面卸载 / 进入后台时立即冲刷（不等防抖），最大限度防丢数据 */
  function flushOnExit() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    flushNow();
  }
  window.addEventListener("pagehide", flushOnExit);
  window.addEventListener("beforeunload", flushOnExit);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushOnExit();
  });

  /* ---- 原生 localStorage 镜像（尽力而为，配额不足静默交给 IndexedDB） ----
     注意：必须写 nativeLS（覆盖前的原生对象），不能用全局 localStorage——
     此时它已被替换成自定义 store，直接调用会无限递归。 */
  function mirrorNative(key, value) {
    if (!nativeLS) return;
    try {
      if (value === null) nativeLS.removeItem(key);
      else nativeLS.setItem(key, value);
    } catch (e) { /* 超配额：交给 IndexedDB 兜底 */ }
  }

  var store = {
    get length() { return Object.keys(cache).length; },
    key: function (i) { return Object.keys(cache)[i] || null; },
    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    },
    setItem: function (key, value) {
      key = String(key);
      value = String(value);
      cache[key] = value;
      dirty[key] = true;
      mirrorNative(key, value);
      schedulePersist();
    },
    removeItem: function (key) {
      key = String(key);
      delete cache[key];
      dirty[key] = true;
      mirrorNative(key, null);
      schedulePersist();
    },
    clear: function () {
      // 仅供用户手动"清除数据"使用；迭代升级不会调用
      cache = {};
      dirty = {};
      try { localStorage.clear(); } catch (e) {}
      flushNow();
    }
  };

  /* ---- 从 IndexedDB 恢复 ----
     恢复时跳过本次会话已写入的键（dirty），避免旧数据覆盖刚写入的新数据；
     其余键以 IndexedDB 中较新的值为准，并回写原生镜像。 */
  openDB(function (db) {
    if (!db) return;
    dbGetAll(db, function (entries) {
      entries.forEach(function (e) {
        if (e && e.key != null) {
          if (!dirty[e.key] && cache[e.key] !== e.value) {
            cache[e.key] = e.value;
            try { localStorage.setItem(e.key, e.value); } catch (err) {}
          }
        }
      });
      // 合并后的全量写回 IndexedDB（含本次会话新写入的键）
      var all = [];
      for (var key in cache) all.push({ key: key, value: cache[key] });
      dbPutAll(db, all);
      /* 预设演示数据清洗：从 IndexedDB 恢复的旧备份中可能含旧版内置的演示联系人/聊天
         （艾琳·格雷/亚瑟·彭德尔顿/维罗妮卡/西奥多），在此统一清除，保证"系统更新不再出现预设数据"；
         用户自建联系人/聊天不受影响。清洗结果经 store.setItem 回写 IndexedDB，一次清洗永久生效。 */
      try {
        var DEMO = ["艾琳·格雷", "亚瑟·彭德尔顿", "维罗妮卡", "西奥多"];
        ["mine.contacts.v1", "mine.contacts.mc.v1"].forEach(function (k) {
          var raw = store.getItem(k);
          if (!raw) return;
          var d = JSON.parse(raw);
          var arr = Array.isArray(d) ? d : (d && Array.isArray(d.contacts) ? d.contacts : null);
          if (!arr) return;
          var kept = arr.filter(function (c) { return c && c.name && DEMO.indexOf(c.name) === -1; });
          if (kept.length === arr.length) return;
          if (Array.isArray(d)) store.setItem(k, JSON.stringify(kept));
          else { d.contacts = kept; store.setItem(k, JSON.stringify(d)); }
        });
        var chatRaw = store.getItem("mine.chat.v1");
        if (chatRaw) {
          var chat = JSON.parse(chatRaw);
          var chatChanged = false;
          Object.keys(chat).forEach(function (ck) {
            var msgs = chat[ck] || [];
            var keptMsgs = msgs.filter(function (m) { return !(m && m.senderName && DEMO.indexOf(m.senderName) !== -1); });
            if (keptMsgs.length !== msgs.length) { chat[ck] = keptMsgs; chatChanged = true; }
            if (!keptMsgs.length) delete chat[ck];
          });
          if (chatChanged) store.setItem("mine.chat.v1", JSON.stringify(chat));
        }
      } catch (e) {}
      /* v2041：一次性清除字卡审批留存数据（联系人生成 pending / AI 生成 auto），
         之后不再执行；用户后续运行产生的字卡不受影响 */
      try {
        if (!store.getItem("mine.cards.gen.cleared.v2041")) {
          var genRaw = store.getItem("mine.cards.gen.items.v1");
          if (genRaw) {
            var genArr = JSON.parse(genRaw);
            if (Array.isArray(genArr)) {
              var genKept = genArr.filter(function (i) { return !(i && (i.status === "auto" || i.status === "pending")); });
              if (genKept.length !== genArr.length) store.setItem("mine.cards.gen.items.v1", JSON.stringify(genKept));
            }
          }
          store.setItem("mine.cards.gen.cleared.v2041", "1");
        }
      } catch (e) {}
      hydrated = true;
      // 版本标记：仅记录存储层版本，不删除任何数据
      try {
        localStorage.setItem(META_KEY, JSON.stringify({ v: 3, ts: Date.now() }));
      } catch (e) {}
      /* 自动申请持久化存储：防止浏览器在存储压力下自动清理本站数据
         （聊天记录"时不时被清空"的主要外部原因），失败静默不影响使用 */
      try {
        if (navigator.storage && navigator.storage.persist) {
          navigator.storage.persist().catch(function () {});
        }
      } catch (e) {}
      try { window.dispatchEvent(new Event("mine:storage-hydrated")); } catch (e) {}
    });
  });

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: function () { return store; }
  });
})();
