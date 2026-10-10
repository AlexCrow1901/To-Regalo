/* ========================================================================
   Mine · 聊天模块
   ------------------------------------------------------------------------
   功能：
   · 一对一聊天（与联系人列表中的某个人）
   · 群聊（与群内所有人）
   · 我的输入：自由输入任意字符
   · 对方回复：从该联系人的字卡中随机抽取一条
   · 群聊中：我发消息后，随机 1-2 位成员各回一张随机字卡
   · 聊天记录持久化（localStorage）
   · 会话列表（聊天应用主页，显示最近对话）
   接入：通过 MineApp.page("chat") 钩子接管主页；
         openContact(id) / openGroup(id) 供通讯录模块调用。
   通知集成：后台收到消息时由 MineKeepalive 弹系统通知；
             点击通知跳回对应会话；回前台汇总未读通知。
   ======================================================================== */
window.MineChat = (function () {
  "use strict";
  var STORE_KEY = "mine.chat.v1";
  var UNREAD_KEY = "mine.chat.unread.v1";
  var BG_KEY = "mine.chat.bg.v1";   /* 每个会话的自定义背景图 */
  var I = window.MineIcons;
  var C = window.MineContacts;   // 通讯录数据接口
  /* ---------------- 数据：会话存储 ----------------
     conversations: {
       "contact:c1": [ { from:"me"|"c1", text, time }, ... ],
       "group:g1":    [ ... ]
     } */
  var conversations = {};
  /* ---------------- 数据：未读计数 ----------------
     unreadCounts: { "contact:c1": 3, "group:g1": 1, ... } */
  var unreadCounts = {};
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        conversations = JSON.parse(raw) || {};
        // 兼容旧数据：确保我的消息有 read 字段
        Object.keys(conversations).forEach(function (key) {
          var msgs = conversations[key];
          if (Array.isArray(msgs)) {
            msgs.forEach(function (m) {
              if (m.from === "me" && m.read === undefined) {
                // 旧消息默认视为已读
                m.read = true;
              }
            });
          }
        });
      }
    } catch (e) {}
    if (!conversations) conversations = {};
    // 加载未读计数
    try {
      var rawUnread = localStorage.getItem(UNREAD_KEY);
      if (rawUnread) unreadCounts = JSON.parse(rawUnread) || {};
    } catch (e) {}
    if (!unreadCounts) unreadCounts = {};
    // 加载会话背景图
    loadBg();
    loadChatFontColor();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(conversations)); } catch (e) {}
  }
  function saveUnread() {
    try { localStorage.setItem(UNREAD_KEY, JSON.stringify(unreadCounts)); } catch (e) {}
  }
  /* ==================== 每个会话的自定义背景图 ====================
     chatBg: { "contact:c1": "data:image/...", "group:g1": "data:image/..." }
     存储：IndexedDB "mine-chat-bg"（容量远大于 localStorage，避免大图
     写入失败导致"背景闪现一下就消失"）；旧 localStorage 数据自动迁移。 */
  var chatBg = {};
  var chatBgLoaded = false;
  function chatBgDbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("mine-chat-bg", 1);
      req.onupgradeneeded = function () {
        try {
          if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
        } catch (e) {}
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function chatBgDbPut(key, val) {
    return chatBgDbOpen().then(function (db) {
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
  function chatBgDbDel(key) {
    return chatBgDbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction("kv", "readwrite");
          tx.objectStore("kv").delete(key);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        } catch (e) { reject(e); }
      });
    });
  }
  function loadBg() {
    chatBgLoaded = false;
    var bgMap = {};
    chatBgDbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction("kv", "readonly");
          var cur = tx.objectStore("kv").openCursor();
          cur.onsuccess = function () {
            var c = cur.result;
            if (c) { bgMap[c.key] = c.value; c.continue(); }
            else resolve(bgMap);
          };
          cur.onerror = function () { reject(cur.error); };
        } catch (e) { reject(e); }
      });
    }).then(function (bgMap) {
      /* 旧 localStorage 数据迁移（一次性） */
      try {
        var raw = localStorage.getItem(BG_KEY);
        if (raw) {
          var legacy = JSON.parse(raw) || {};
          Object.keys(legacy).forEach(function (k) {
            if (legacy[k] && !bgMap[k]) {
              bgMap[k] = legacy[k];
              chatBgDbPut(k, legacy[k]);
            }
          });
          try { localStorage.removeItem(BG_KEY); } catch (e) {}
        }
      } catch (e) {}
      chatBg = bgMap;
      chatBgLoaded = true;
      if (ctx && ctx.convKey && pageEl) applyConvBg();
      if (pageEl) applyChatFontColor();
    }).catch(function () {
      /* IDB 不可用 → 兜底读旧 localStorage */
      try {
        var raw = localStorage.getItem(BG_KEY);
        if (raw) chatBg = JSON.parse(raw) || {};
      } catch (e) {}
      chatBgLoaded = true;
    });
  }
  function saveBg() {
    /* 全部落 IDB（异步写入，失败静默——背景仍保留在内存） */
    Object.keys(chatBg).forEach(function (k) {
      chatBgDbPut(k, chatBg[k]).catch(function () {});
    });
  }
  function getConvBg(convKey) {
    return chatBg[convKey] || null;
  }
  function setConvBg(convKey, dataUrl) {
    if (dataUrl) {
      chatBg[convKey] = dataUrl;
      chatBgDbPut(convKey, dataUrl).catch(function () {});
    } else {
      delete chatBg[convKey];
      chatBgDbDel(convKey).catch(function () {});
    }
  }
  /* 将背景图应用到聊天页 DOM */
  function applyConvBg() {
    if (!pageEl) return;
    var bg = getConvBg(ctx.convKey);
    var msgArea = pageEl.querySelector(".chat-messages");
    if (bg) {
      pageEl.style.setProperty("--chat-bg-image", "url(" + bg + ")");
      if (msgArea) msgArea.classList.add("has-custom-bg");
    } else {
      pageEl.style.removeProperty("--chat-bg-image");
      if (msgArea) msgArea.classList.remove("has-custom-bg");
    }
  }
  /* ==================== 每个会话的字体颜色（黑/白） ====================
     chatFontColor: { "contact:c1": "black", "group:g1": "white", ... }
     未设置的会话继承主界面字体颜色 */
  var CHAT_FONTCOLOR_KEY = "mine.chat.fontColor.v1";
  var chatFontColor = {};
  var CHAT_FC_COLORS = {
    white: {
      "--t-primary":  "#dde3e6",
      "--t-secondary": "#aab1b6",
      "--t-tertiary":  "#71787d",
      "--t-faint":     "#565c61"
    },
    black: {
      "--t-primary":  "#1a1a1a",
      "--t-secondary": "#3a3a3a",
      "--t-tertiary":  "#6a6a6a",
      "--t-faint":     "#9a9a9a"
    }
  };
  function loadChatFontColor() {
    try {
      var raw = localStorage.getItem(CHAT_FONTCOLOR_KEY);
      if (raw) chatFontColor = JSON.parse(raw) || {};
    } catch (e) {}
    if (!chatFontColor) chatFontColor = {};
  }
  function saveChatFontColor() {
    try { localStorage.setItem(CHAT_FONTCOLOR_KEY, JSON.stringify(chatFontColor)); } catch (e) {}
  }
  function getConvFontColor(convKey) {
    return chatFontColor[convKey] || null;
  }
  function setConvFontColor(convKey, color) {
    if (color) { chatFontColor[convKey] = color; }
    else { delete chatFontColor[convKey]; }
    saveChatFontColor();
  }
  function applyChatFontColor() {
    if (!pageEl) return;
    var fc = getConvFontColor(ctx.convKey);
    if (fc && CHAT_FC_COLORS[fc]) {
      var colors = CHAT_FC_COLORS[fc];
      for (var key in colors) {
        if (colors.hasOwnProperty(key)) {
          pageEl.style.setProperty(key, colors[key]);
        }
      }
    } else {
      /* 清除覆盖，继承主界面字体颜色 */
      pageEl.style.removeProperty("--t-primary");
      pageEl.style.removeProperty("--t-secondary");
      pageEl.style.removeProperty("--t-tertiary");
      pageEl.style.removeProperty("--t-faint");
    }
  }
  /* 打开背景与字体设置面板 */
  function openBgSettings() {
    var overlay = document.createElement("div");
    overlay.className = "chat-bg-overlay";
    var curBg = getConvBg(ctx.convKey);
    var curFc = getConvFontColor(ctx.convKey);
    var sheet = document.createElement("div");
    sheet.className = "chat-bg-sheet";
    sheet.innerHTML =
      '<div class="chat-bg-handle"></div>' +
      '<div class="chat-bg-head">' +
        '<span class="chat-bg-title">聊天设置</span>' +
        '<button class="chat-bg-close" data-act="close">' + I.svg("close", 20) + '</button>' +
      '</div>' +
      '<div class="chat-bg-body">' +
        '<div class="chat-bg-preview" id="bg-preview">' +
          (curBg ? '<img src="' + curBg + '" alt="背景预览">' : '<div class="bg-preview-empty">暂无自定义背景</div>') +
        '</div>' +
        '<div class="chat-bg-actions">' +
          '<button class="chat-bg-btn" data-act="upload">' +
            I.svg("image", 20) + '<span>从图库选择</span></button>' +
          (curBg ? '<button class="chat-bg-btn chat-bg-btn-danger" data-act="clear">' +
            I.svg("trash", 20) + '<span>清除背景</span></button>' : '') +
        '</div>' +
        '<input type="file" id="chat-bg-file" accept="image/*" style="display:none">' +
        '<div class="section-label" style="margin-top:20px;">字体颜色</div>' +
        '<div class="font-color-row">' +
          '<button class="font-color-btn' + (!curFc ? " is-active" : "") + '" data-fc="inherit">' +
            '<span class="fc-swatch fc-inherit">' + I.svg("link", 14) + '</span><span>跟随主界面</span></button>' +
          '<button class="font-color-btn' + (curFc === "white" ? " is-active" : "") + '" data-fc="white">' +
            '<span class="fc-swatch fc-white"></span><span>白色</span></button>' +
          '<button class="font-color-btn' + (curFc === "black" ? " is-active" : "") + '" data-fc="black">' +
            '<span class="fc-swatch fc-black"></span><span>黑色</span></button>' +
        '</div>' +
      '</div>';
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add("is-open"); });
    function closeSheet() {
      overlay.classList.remove("is-open");
      setTimeout(function () { overlay.remove(); }, 300);
    }
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeSheet();
    });
    sheet.querySelector('[data-act="close"]').addEventListener("click", closeSheet);
    var fileInput = sheet.querySelector("#chat-bg-file");
    sheet.querySelector('[data-act="upload"]').addEventListener("click", function () {
      fileInput.click();
    });
    fileInput.addEventListener("change", function () {
      if (this.files && this.files[0]) {
        var file = this.files[0];
        if (!/^image\//.test(file.type)) { closeSheet(); return; }
        if (window.MineUtils && MineUtils.compressImage) {
          MineUtils.compressImage(file, 1080, 0.82, function (dataURL) {
            if (!dataURL) { closeSheet(); return; }
            setConvBg(ctx.convKey, dataURL);
            applyConvBg();
            closeSheet();
          });
        } else {
          var reader = new FileReader();
          reader.onload = function () {
            setConvBg(ctx.convKey, reader.result);
            applyConvBg();
            closeSheet();
          };
          reader.readAsDataURL(file);
        }
      }
    });
    var clearBtn = sheet.querySelector('[data-act="clear"]');
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        setConvBg(ctx.convKey, null);
        applyConvBg();
        closeSheet();
      });
    }
    /* 字体颜色按钮 */
    sheet.querySelectorAll("[data-fc]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var fc = btn.getAttribute("data-fc");
        if (fc === "inherit") {
          setConvFontColor(ctx.convKey, null);
        } else {
          setConvFontColor(ctx.convKey, fc);
        }
        applyChatFontColor();
        sheet.querySelectorAll("[data-fc]").forEach(function (b) {
          b.classList.remove("is-active");
        });
        btn.classList.add("is-active");
      });
    });
  }
  /* ---------------- 未读计数工具 ---------------- */
  var appLevelSeen = false;  // 用户是否已打开过聊天应用（控制主屏角标）
  function incrementUnread(convKey) {
    if (!unreadCounts[convKey]) unreadCounts[convKey] = 0;
    unreadCounts[convKey]++;
    appLevelSeen = false;  // 新消息到达 → 主屏角标重新显示
    saveUnread();
    if (window.MineNotify) MineNotify.refreshBadges();
    /* 后台收到消息 → 系统通知（去重/通道由保活模块统一处理） */
    if (window.MineKeepalive && document.visibilityState !== "visible") {
      MineKeepalive.notify(convTitle(convKey), msgPreviewText(convKey), {
        convKey: convKey,
        kind: "msg"
      });
    }
  }
  /* 会话标题（用于系统通知） */
  function convTitle(convKey) {
    try {
      if (convKey.indexOf("contact:") === 0) {
        var c = C.findContact(convKey.substring(8));
        if (c && c.name) return c.name;
      } else if (convKey.indexOf("group:") === 0) {
        var g = C.findGroup(convKey.substring(6));
        if (g && g.name) return g.name;
      }
    } catch (e) {}
    return "Mine";
  }
  /* 会话最后一条消息预览（用于系统通知正文） */
  function msgPreviewText(convKey) {
    try {
      var msgs = conversations[convKey];
      if (!msgs || msgs.length === 0) return "你收到一条新消息";
      var last = msgs[msgs.length - 1];
      var senderPrefix = "";
      if (last.from !== "me" && last.senderName && convKey.indexOf("group:") === 0) {
        senderPrefix = last.senderName + "：";
      }
      var t = last.text || "";
      if (typeof t === "string" && t.indexOf("data:image/") === 0) t = "[图片]";
      else if (typeof t === "string" && t.length > 40) t = t.substring(0, 40) + "…";
      return (senderPrefix + t) || "你收到一条新消息";
    } catch (e) { return "你收到一条新消息"; }
  }
  function clearUnread(convKey) {
    if (unreadCounts[convKey]) {
      delete unreadCounts[convKey];
      saveUnread();
      if (window.MineNotify) MineNotify.refreshBadges();
    }
  }
  function getUnread(convKey) {
    return unreadCounts[convKey] || 0;
  }
  function getTotalUnread() {
    var total = 0;
    Object.keys(unreadCounts).forEach(function (k) {
      total += unreadCounts[k];
    });
    return total;
  }
  /* 获取通知数：用户已打开聊天应用后不显示主屏角标，但会话角标仍保留 */
  function getNotifyCount() {
    return appLevelSeen ? 0 : getTotalUnread();
  }
  /* 判断当前是否正在查看某个会话 */
  function isViewingConv(convKey) {
    var chatPage = document.getElementById("page-chat");
    if (!chatPage || !chatPage.classList.contains("is-active")) return false;
    return ctx.convKey === convKey;
  }
  /* ---------------- 工具 ---------------- */
  function uid() { return "msg_" + Date.now() + "_" + Math.floor(Math.random() * 1000); }
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace( />/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    var h = d.getHours(); var m = d.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  function fmtDateSep(ts) {
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return "今天";
    var y = d.getFullYear(), mo = d.getMonth() + 1, da = d.getDate();
    return y + "年" + mo + "月" + da + "日";
  }
  /**
   * 将文本按每 N 个字符换行（保留已有换行）
   * @param {string} text - 原始文本
   * @param {number} n - 每行字符数
   * @returns {string} HTML 安全文本，含 <br> 换行
   */
  function wrapText(text, n) {
    n = n || 12;
    var safe = escapeHtml(text);
    // 先按原始换行分割
    var lines = safe.split(/\n/);
    var result = [];
    lines.forEach(function (line) {
      if (line.length === 0) { result.push(""); return; }
      // 每 n 个字符插入 <br>
      for (var i = 0; i < line.length; i += n) {
        result.push(line.substring(i, i + n));
      }
    });
    return result.join("<br>");
  }
  /**
   * 渲染抉择消息：标题行 + ABCD 选项逐行对齐
   * 使用 .choice-msg-options 容器包裹所有选项，确保字母标签列对齐
   * 若该消息已有 choiceAnswers，则被选中的选项会被标注：
   *   · 文字加粗
   *   · 背景色加深
   *   · 显示选择者标签
   * @param {object} msg - 抉择消息对象（含 text 和可选的 choiceAnswers）
   * @returns {string} HTML
   */
  function renderChoiceText(msg) {
    var text = (msg && msg.text) || "";
    var lines = text.split(/\n/);
    var html = "";
    var firstLine = true;
    var optionsHtml = "";
    var hasOptions = false;
    /* 构建选项字母 → 选择者名单 的映射 */
    var selectedMap = {};
    if (msg && msg.choiceAnswers && msg.choiceAnswers.length > 0) {
      msg.choiceAnswers.forEach(function (ans) {
        if (!selectedMap[ans.letter]) selectedMap[ans.letter] = [];
        selectedMap[ans.letter].push(ans.name || "未知");
      });
    }
    var hasAnswers = msg && msg.choiceAnswers && msg.choiceAnswers.length > 0;
    lines.forEach(function (line) {
      var safe = escapeHtml(line);
      if (firstLine) {
        // 第一行是"【抉择】问题"
        html += '<div class="choice-msg-title">' + safe + '</div>';
        firstLine = false;
      } else {
        // 选项行：A. xxx / B. xxx ...（支持 A-Z）
        var match = safe.match(/^([A-Z])\.\s*(.*)$/);
        if (match) {
          hasOptions = true;
          var letter = match[1];
          var isSelected = !!selectedMap[letter];
          var optClass = 'choice-msg-option' + (isSelected ? ' is-selected' : '');
          var badge = '';
          if (isSelected) {
            var names = selectedMap[letter].map(escapeHtml).join('、');
            badge = '<span class="choice-msg-picked">' + names + ' 选择</span>';
          }
          optionsHtml += '<div class="' + optClass + '">' +
            '<span class="choice-msg-letter">' + letter + '</span>' +
            '<span class="choice-msg-text">' + match[2] + '</span>' +
            badge +
            '</div>';
        } else if (safe.length > 0) {
          optionsHtml += '<div class="choice-msg-line">' + safe + '</div>';
        }
      }
    });
    // 用容器包裹选项，确保所有字母标签在同一列对齐
    if (hasOptions) {
      var wrapClass = 'choice-msg-options' + (hasAnswers ? ' has-answers' : '');
      html += '<div class="' + wrapClass + '">' + optionsHtml + '</div>';
    } else {
      html += optionsHtml;
    }
    return html;
  }
  /* ---------------- "我"的头像 ---------------- */
  var ME_KEY = "mine.me.v1";
  var meProfile = null;
  function loadMe() {
    try {
      var raw = localStorage.getItem(ME_KEY);
      if (raw) { meProfile = JSON.parse(raw); return; }
    } catch (e) {}
    meProfile = { name: "我", avatar: null };
    try { localStorage.setItem(ME_KEY, JSON.stringify(meProfile)); } catch (e) {}
  }
  function saveMe() {
    try { localStorage.setItem(ME_KEY, JSON.stringify(meProfile)); } catch (e) {}
  }
  function meAvatarHTML(size, cls) {
    var s = size || 32;
    var c = (cls ? " " + cls : "");
    if (meProfile && meProfile.avatar) {
      return '<div class="avatar' + c + '" style="width:' + s + 'px;height:' + s + 'px;">' +
        '<img src="' + escapeHtml(meProfile.avatar) + '" alt=""></div>';
    }
    return '<div class="avatar avatar-gen' + c + '" style="width:' + s + 'px;height:' + s + 'px;">' +
      escapeHtml(C ? C.firstChar(meProfile ? meProfile.name : "我") : "我") + '</div>';
  }
  /* ---------------- 字卡选择工具 ---------------- */
  /** 我的字卡池（个人中心"字卡"模块配置）：单独字卡(该联系人) + 公用字卡 */
  function mineCardPool(contactId) {
    if (!window.MineCards || !window.MineCards.getReplyPool) return [];
    return window.MineCards.getReplyPool(contactId || null);
  }
  /** 读取可自定义的系统概率（0~1），无配置时回退默认值 */
  function prob(key) {
    var v = null;
    if (window.MineProbs && window.MineProbs.get) v = window.MineProbs.get(key);
    if (typeof v !== "number" || isNaN(v)) v = 0;
    return v / 100;
  }
  /** 判断字卡是否为图片字卡（base64 data URI） */
  function isImageCard(card) {
    return typeof card === "string" && card.indexOf("data:image/") === 0;
  }
  /** 判断字卡是否为语音字卡（audio data URI） */
  function isAudioCard(card) {
    return typeof card === "string" && card.indexOf("data:audio/") === 0;
  }
  /** 判断字卡是否为 emoji 字卡（由 emoji 字符组成的短串） */
  function isEmojiCard(card) {
    if (typeof card !== "string" || card.length === 0) return false;
    if (isImageCard(card)) return false;
    var stripped = card.replace(/[\uFE0F\u200D\u200C\u2640\u2642\u20E3\uFE0E]/g, "");
    var chars = Array.from(stripped);
    if (chars.length === 0 || chars.length > 4) return false;
    return chars.every(function (ch) {
      var code = ch.codePointAt(0);
      return (code >= 0x1F300 && code <= 0x1FAFF) ||
             (code >= 0x2600 && code <= 0x27BF) ||
             (code >= 0x2B50 && code <= 0x2BFF) ||
             (code >= 0x2300 && code <= 0x23FF);
    });
  }
  /** 从卡池中筛选图片字卡 */
  function filterImageCards(cards) {
    if (!cards || cards.length === 0) return [];
    return cards.filter(isImageCard);
  }
  /** 从卡池中筛选 emoji 字卡 */
  function filterEmojiCards(cards) {
    if (!cards || cards.length === 0) return [];
    return cards.filter(isEmojiCard);
  }
  /** 从卡池中筛选语音字卡 */
  function filterAudioCards(cards) {
    if (!cards || cards.length === 0) return [];
    return cards.filter(isAudioCard);
  }
  /** 从卡池中筛选文字字卡（排除图片、语音和 emoji） */
  function filterTextCards(cards) {
    if (!cards || cards.length === 0) return [];
    return cards.filter(function (c) { return !isImageCard(c) && !isAudioCard(c) && !isEmojiCard(c); });
  }
  /**
   * 通用字卡选择器（概率均可自定义，见「概率修改 - 字卡概率」）：
   * · 图片字卡概率 imageCard（默认 5%）
   * · emoji 字卡概率 emojiCard（默认 10%）
   * · 语音字卡概率 audioCard（默认 3%）
   * · 系统字卡概率 sysCard（默认 10%，所有联系人可用）
   * · 其余从文字字卡随机抽取；无文字字卡则从全池随机抽取
   */
  function pickCardWithImageChance(pool) {
    if (!pool || pool.length === 0) return null;
    var sysCards = window.MineCards && window.MineCards.getSysCards ? window.MineCards.getSysCards() : [];
    var imageCards = filterImageCards(pool);
    var emojiCards = filterEmojiCards(pool);
    var audioCards = filterAudioCards(pool);
    var textCards = filterTextCards(pool);
    if (imageCards.length > 0 && Math.random() < prob("imageCard")) {
      return imageCards[Math.floor(Math.random() * imageCards.length)];
    }
    if (emojiCards.length > 0 && Math.random() < prob("emojiCard")) {
      return emojiCards[Math.floor(Math.random() * emojiCards.length)];
    }
    if (audioCards.length > 0 && Math.random() < prob("audioCard")) {
      return audioCards[Math.floor(Math.random() * audioCards.length)];
    }
    /* 系统字卡：所有联系人均可使用，独立发送概率（可配置） */
    if (sysCards.length > 0 && Math.random() < prob("sysCard")) {
      return sysCards[Math.floor(Math.random() * sysCards.length)];
    }
    if (textCards.length > 0) {
      return textCards[Math.floor(Math.random() * textCards.length)];
    }
    /* 兜底：仅剩系统字卡时使用 */
    if (sysCards.length > 0) {
      return sysCards[Math.floor(Math.random() * sysCards.length)];
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }
  /** 从联系人的字卡中随机抽取一条（10% 概率图片字卡，10% 概率 emoji 字卡）
      字卡池 = 我的单独字卡(该联系人) + 我的公用字卡 + 联系人自带字卡 */
  function pickRandomCard(contact) {
    if (!contact) return null;
    var pool = mineCardPool(contact.id);
    if (contact.cards && contact.cards.length) pool = pool.concat(contact.cards);
    if (pool.length === 0) return null;
    return pickCardWithImageChance(pool);
  }
  /**
   * 群聊中合并个人字卡 + 群字卡后随机抽取（10% 概率图片字卡，10% 概率 emoji 字卡）
   * @param contact  回复者
   * @param group    当前群聊对象
   */
  function pickRandomCardForGroup(contact, group) {
    var pool = mineCardPool(contact ? contact.id : null);
    if (contact && contact.cards) pool = pool.concat(contact.cards);
    if (group && group.cards) pool = pool.concat(group.cards);
    return pickCardWithImageChance(pool);
  }
  /** 读取单独"自动回复"字卡（仅自动回复场景使用） */
  function autoCardPool(contactId) {
    if (!window.MineCards || !window.MineCards.getAutoCards) return [];
    return window.MineCards.getAutoCards(contactId || null);
  }
  /** 从联系人的自动回复字卡中随机抽取一条
      优先使用单独"自动回复"字卡（+ 联系人自带 autoCards）；
      未设置时回退原行为（单独字卡 + 公用字卡 + autoCards） */
  function pickRandomAutoCard(contact) {
    if (!contact) return null;
    var pool = autoCardPool(contact.id);
    if (pool.length > 0) {
      if (contact.autoCards && contact.autoCards.length) pool = pool.concat(contact.autoCards);
      return pickCardWithImageChance(pool);
    }
    pool = mineCardPool(contact.id);
    if (contact.autoCards && contact.autoCards.length) pool = pool.concat(contact.autoCards);
    if (pool.length === 0) return null;
    return pickCardWithImageChance(pool);
  }
  /** 群聊中合并自动回复字卡后随机抽取
      （单独"自动回复"字卡 + 个人/群 autoCards；未设置时回退单独+公用+autoCards） */
  function pickRandomAutoCardForGroup(contact, group) {
    var pool = autoCardPool(contact ? contact.id : null);
    if (pool.length > 0) {
      if (contact && contact.autoCards) pool = pool.concat(contact.autoCards);
      if (group && group.autoCards) pool = pool.concat(group.autoCards);
      return pickCardWithImageChance(pool);
    }
    pool = mineCardPool(contact ? contact.id : null);
    if (contact && contact.autoCards) pool = pool.concat(contact.autoCards);
    if (group && group.autoCards) pool = pool.concat(group.autoCards);
    if (pool.length === 0) return null;
    return pickCardWithImageChance(pool);
  }
  /**
   * 附加 emoji 字卡选择器
   * 当主字卡为文字字卡时，15% 概率附加 1~3 条 emoji
   * · 73% → 1 条, 20% → 2 条, 7% → 3 条
   · 每条 emoji 独立等概率从 emoji 池中抽取（可重复）
   * @param pool  字卡池（用于提取 emoji 字卡）
   * @return string[]  附加的 emoji 字卡数组（可能为空）
   */
  function pickEmojiAttachments(pool) {
    var emojiCards = filterEmojiCards(pool);
    if (emojiCards.length === 0) return [];
    if (Math.random() >= prob("emojiAttach")) return [];
    var r = Math.random();
    var count = r < 0.73 ? 1 : (r < 0.93 ? 2 : 3);
    var result = [];
    for (var i = 0; i < count; i++) {
      result.push(emojiCards[Math.floor(Math.random() * emojiCards.length)]);
    }
    return result;
  }
  /**
   * 从群成员中随机选取 n 位可回复的成员
   * 可回复 = 有个人字卡 / 有我的单独字卡 / 我的公用字卡 / 群有群字卡
   */
  function pickRandomMembers(group, n) {
    var groupHasCards = group && group.cards && group.cards.length > 0;
    var hasSysCards = window.MineCards && window.MineCards.getSysCards
      ? window.MineCards.getSysCards().length > 0
      : false;
    var members = (group.members || []).map(C.findContact).filter(function (c) {
      if (!c) return false;
      // 我的单独字卡 + 我的公用字卡（所有联系人可用）+ 系统字卡（所有联系人可用）
      var hasMine = mineCardPool(c.id).length > 0 || hasSysCards;
      // 有个人字卡 或 群有群字卡 → 可回复
      return hasMine || (c.cards && c.cards.length > 0) || groupHasCards;
    });
    if (members.length === 0) return [];
    // 洗牌
    for (var i = members.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = members[i]; members[i] = members[j]; members[j] = tmp;
    }
    return members.slice(0, Math.min(n, members.length));
  }
  /* ---------------- 当前聊天上下文 ---------------- */
  var ctx = {
    type: null,       // "contact" | "group"
    id: null,         // 联系人ID 或 群ID
    convKey: null,    // 存储键 "contact:c1" | "group:g1"
    title: "",
    subtitle: ""
  };
  var pageEl = null;
  var msgContainer = null;
  var inputEl = null;
  var sendBtn = null;
  /* ========================================================================
     打开聊天
     ======================================================================== */
  function openContact(contactId) {
    if (C && C.loadData) C.loadData();
    loadMe();
    var c = C.findContact(contactId);
    /* 兜底（历史数据迁移）：联系人 id 失效时，按最后一条消息的发送者姓名匹配 */
    if (!c && C.findContactByName) {
      load();
      var _name = null;
      try {
        var _msgs = conversations["contact:" + contactId];
        if (_msgs && _msgs.length) {
          for (var _i = _msgs.length - 1; _i >= 0; _i--) {
            if (_msgs[_i].senderName) { _name = _msgs[_i].senderName; break; }
          }
        }
      } catch (e) {}
      if (_name) c = C.findContactByName(_name);
    }
    if (!c) return;
    load();
    /* 重链：联系人实际 id 与存储键不一致时，把旧 id 的会话迁移到当前 id，
       避免历史聊天记录因 id 失效而孤立、不可见 */
    if (c.id !== contactId) {
      try {
        var _old = conversations["contact:" + contactId];
        if (_old && _old.length) {
          var _tgt = conversations["contact:" + c.id];
          conversations["contact:" + c.id] = _tgt ? _tgt.concat(_old) : _old;
          delete conversations["contact:" + contactId];
          save();
        }
      } catch (e) {}
      contactId = c.id;
    }
    clearUnread("contact:" + contactId);
    ctx.type = "contact";
    ctx.id = contactId;
    ctx.convKey = "contact:" + contactId;
    ctx.title = c.name;
    ctx.subtitle = c.status || "在线";
    if (!conversations[ctx.convKey]) conversations[ctx.convKey] = [];
    renderChatPage();
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("chat");
  }
  function openGroup(groupId) {
    if (C && C.loadData) C.loadData();
    loadMe();
    var g = C.findGroup(groupId);
    if (!g) return;
    load();
    clearUnread("group:" + groupId);
    ctx.type = "group";
    ctx.id = groupId;
    ctx.convKey = "group:" + groupId;
    ctx.title = g.name;
    ctx.subtitle = (g.members || []).length + " 位成员";
    if (!conversations[ctx.convKey]) conversations[ctx.convKey] = [];
    renderChatPage();
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("chat");
  }
  /* ========================================================================
     渲染聊天页
     ======================================================================== */
  function renderChatPage() {
    if (!pageEl) pageEl = document.getElementById("page-chat");
    if (!pageEl) return;
    // 导航栏
    var navHtml =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
        '<div class="chat-nav-info">' +
          '<span class="chat-nav-title">' + escapeHtml(ctx.title) + '</span>' +
          '<span class="chat-nav-sub">' + escapeHtml(ctx.subtitle) + '</span>' +
        '</div>' +
        '<span class="nav-right">' +
          (ctx.type === "contact"
            ? '<button class="nav-btn chat-call-btn" data-act="call" title="语音通话">' + I.svg("phone", 20) + '</button>'
            : '<button class="nav-btn chat-call-btn" data-act="group-call" title="群电话（预留）">' + I.svg("phone", 20) + '</button>') +
          '<button class="nav-btn chat-more-btn" data-act="bg-settings">' + I.svg("more", 20) + '</button>' +
        '</span>' +
      '</div>';
    // with me 可折叠栏目
    var withMeHtml =
      '<div class="with-me-bar" id="with-me-bar">' +
        '<div class="with-me-toggle" id="with-me-toggle">' +
          '<span class="with-me-label">with me</span>' +
          '<span class="with-me-chevron" id="with-me-chevron">' + I.svg("back", 12) + '</span>' +
        '</div>' +
        '<div class="with-me-panel" id="with-me-panel">' +
          '<div class="with-me-content" id="with-me-content">' +
            '<div class="with-me-actions">' +
              '<div class="wm-action" role="button" tabindex="0" data-wm="choice">' +
                '<span class="wm-action-icon">' + I.svg("feather", 18) + '</span>' +
                '<span class="wm-action-name">抉择</span>' +
              '</div>' +
              '<div class="wm-action" role="button" tabindex="0" data-wm="image">' +
                '<span class="wm-action-icon">' + I.svg("image", 18) + '</span>' +
                '<span class="wm-action-name">图片</span>' +
              '</div>' +
              (ctx.type === "contact"
                ? '<div class="wm-action" role="button" tabindex="0" data-wm="call">' +
                  '<span class="wm-action-icon">' + I.svg("phone", 18) + '</span>' +
                  '<span class="wm-action-name">电话</span></div>'
                : '<div class="wm-action" role="button" tabindex="0" data-wm="group-call">' +
                  '<span class="wm-action-icon">' + I.svg("users", 18) + '</span>' +
                  '<span class="wm-action-name">群电话</span></div>') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    // 消息区域
    var msgHtml = '<div class="chat-messages" id="chat-messages"></div>';
    // 输入栏
    var inputHtml =
      '<div class="chat-input-bar">' +
        '<textarea class="chat-input" id="chat-input" rows="1" ' +
        'placeholder="输入消息…" maxlength="2000"></textarea>' +
        '<button class="chat-send-btn" id="chat-send" disabled>' + I.svg("send", 18) + '</button>' +
      '</div>';
    pageEl.innerHTML = navHtml + withMeHtml + msgHtml + inputHtml;
    // 缓存 DOM
    msgContainer = pageEl.querySelector("#chat-messages");
    inputEl = pageEl.querySelector("#chat-input");
    sendBtn = pageEl.querySelector("#chat-send");
    // 渲染历史消息
    renderMessages();
    // 应用会话自定义背景
    applyConvBg();
    // 应用会话字体颜色
    applyChatFontColor();
    // 绑定事件
    bindChatEvents();
    // 滚到底部（首次打开强制）
    scrollToBottom(true);
    hideBackBottom();
  }
  /* ---------------- 渲染所有消息 ---------------- */
  function renderMessages() {
    var msgs = conversations[ctx.convKey] || [];
    var html = "";
    var lastDateStr = "";
    msgs.forEach(function (msg) {
      var dateStr = fmtDateSep(msg.time);
      if (dateStr !== lastDateStr) {
        html += '<div class="chat-date-sep">' + dateStr + '</div>';
        lastDateStr = dateStr;
      }
      html += msgRowHTML(msg);
    });
    msgContainer.innerHTML = html;
    scrollToBottom(true);
  }
  /* ---------------- 单条消息 HTML ---------------- */
  function msgRowHTML(msg) {
    var isMe = msg.from === "me";
    var sender = null;
    if (!isMe) {
      // 先尝试从通讯录查找
      if (ctx.type === "group") {
        sender = C.findContact(msg.from);
      } else {
        sender = C.findContact(ctx.id);
      }
      // 若未找到，尝试重新加载通讯录数据后重试
      if (!sender && C.loadData) {
        C.loadData();
        if (ctx.type === "group") {
          sender = C.findContact(msg.from);
        } else {
          sender = C.findContact(ctx.id);
        }
      }
    }
    var avatarHTML = "";
    var senderNameHTML = "";
    if (isMe) {
      // 我的头像显示在右侧
      avatarHTML = meAvatarHTML(32, "msg-avatar avatar-gen");
    } else {
      // 对方头像可点击跳转到主页
      var contactId = ctx.type === "group" ? msg.from : ctx.id;
      // 若 findContact 返回 null，使用消息中存储的 senderName/senderAvatar 作为 fallback
      var displayName = (sender && sender.name) ? sender.name : (msg.senderName || "未知");
      var displayAvatar = (sender && sender.avatar) ? sender.avatar : (msg.senderAvatar || null);
      var fallbackContact = sender || { name: displayName, avatar: displayAvatar };
      avatarHTML = '<div class="avatar-tap" data-contact-id="' + escapeHtml(contactId) + '"' +
        ' data-sender-name="' + escapeHtml(displayName) + '">' +
        C.avatarHTML(fallbackContact, 32, "msg-avatar avatar-gen") + '</div>';
      if (ctx.type === "group") {
        senderNameHTML = '<div class="msg-sender">' + escapeHtml(displayName) + '</div>';
      }
    }
    var bubbleClass = isMe ? "is-me" : "is-them";
    if (msg.isEmpty) bubbleClass += " is-empty";
    if (msg.isChoice) bubbleClass += " is-choice-msg";
    // 图片消息检测
    var isImageMsg = !msg.isChoice && typeof msg.text === "string" && msg.text.indexOf("data:image/") === 0;
    if (isImageMsg) bubbleClass += " is-image-msg";
    // 语音消息检测
    var isAudioMsg = !msg.isChoice && typeof msg.text === "string" && msg.text.indexOf("data:audio/") === 0;
    if (isAudioMsg) bubbleClass += " is-audio-msg";
    // emoji 消息检测
    var isEmojiMsg = !msg.isChoice && typeof msg.text === "string" && isEmojiCard(msg.text);
    if (isEmojiMsg) bubbleClass += " is-emoji-msg";
    var rowClass = isMe ? "msg-row is-me" : "msg-row";
    // 抉择消息使用特殊渲染（ABCD 逐行对齐）；图片消息渲染为图片气泡；语音消息渲染为语音播放条；emoji 消息与文字同等大小
    var bubbleText;
    if (isImageMsg) {
      bubbleText = '<img class="msg-image" src="' + escapeHtml(msg.text) + '" alt="图片">';
    } else if (isAudioMsg) {
      bubbleText = MineVoiceBar.html(msg.text, "vb-inline" + (isMe ? " is-me" : ""));
    } else if (isEmojiMsg) {
      bubbleText = '<span class="msg-emoji">' + escapeHtml(msg.text) + '</span>';
    } else if (msg.isChoice) {
      bubbleText = renderChoiceText(msg);
    } else {
      bubbleText = wrapText(msg.text, 12);
    }
    // 自动回复标记
    var autoTag = "";
    if (msg.isAutoReply) {
      autoTag = '<span class="auto-reply-tag">自动回复</span>';
    }
    // 已读对勾（仅我的消息且已读时才显示）
    var readMark = "";
    if (isMe && msg.read) {
      readMark = '<span class="msg-read is-read">' + I.svg("check", 13) + '</span>';
    }
    return '<div class="' + rowClass + '" data-msg-id="' + escapeHtml(msg.id || "") + '">' +
      (isMe ? "" : avatarHTML) +
      '<div class="msg-content">' +
        senderNameHTML +
        '<div class="msg-bubble ' + bubbleClass + '">' + autoTag + bubbleText + '</div>' +
        '<div class="msg-time">' + readMark +
        '<span class="time-text" data-time="' + fmtTime(msg.time) + '" data-date="' + fmtDateSep(msg.time) + '">' + fmtTime(msg.time) + '</span>' +
        '</div>' +
      '</div>' +
      (isMe ? avatarHTML : "") +
      '</div>';
  }
  /* ---------------- 滚动控制（不打扰用户翻历史） ----------------
     · 仅在用户位于底部附近时自动跟随新消息滚到底部
     · 用户正在向上翻历史时，保持滚动位置不动，并显示"回到底部"按钮 */
  var SCROLL_THRESHOLD = 120;  /* 距底部小于该值视为"在底部附近" */
  var backBottomBtn = null;

  function isNearBottom() {
    if (!msgContainer) return true;
    return (msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight) < SCROLL_THRESHOLD;
  }

  function scrollToBottom(force) {
    requestAnimationFrame(function () {
      if (!msgContainer) return;
      if (force || isNearBottom()) {
        msgContainer.scrollTop = msgContainer.scrollHeight;
        hideBackBottom();
      } else {
        showBackBottom();
      }
    });
  }

  function ensureBackBottomBtn() {
    if (!msgContainer) return null;
    if (backBottomBtn && backBottomBtn.isConnected) return backBottomBtn;
    backBottomBtn = document.createElement("button");
    backBottomBtn.className = "chat-back-bottom";
    backBottomBtn.innerHTML = I.svg("back", 20);
    backBottomBtn.setAttribute("aria-label", "回到底部");
    backBottomBtn.addEventListener("click", function () {
      scrollToBottom(true);
    });
    document.body.appendChild(backBottomBtn);
    return backBottomBtn;
  }
  function showBackBottom() {
    var b = ensureBackBottomBtn();
    if (b) b.classList.add("is-show");
  }
  function hideBackBottom() {
    if (backBottomBtn) backBottomBtn.classList.remove("is-show");
  }
  /* ========================================================================
     绑定事件
     ======================================================================== */
  function bindChatEvents() {
    // 返回 → 回到聊天会话列表
    pageEl.querySelector('[data-act="back"]').addEventListener("click", function () {
      openConvList();
    });
    // 背景设置按钮
    var bgBtn = pageEl.querySelector('[data-act="bg-settings"]');
    if (bgBtn) bgBtn.addEventListener("click", openBgSettings);
    // with me 栏目展开/收起
    var withMeToggle = pageEl.querySelector("#with-me-toggle");
    var withMePanel = pageEl.querySelector("#with-me-panel");
    var withMeChevron = pageEl.querySelector("#with-me-chevron");
    if (withMeToggle && withMePanel) {
      withMeToggle.addEventListener("click", function () {
        var isOpen = withMePanel.classList.toggle("is-open");
        if (withMeChevron) {
          withMeChevron.classList.toggle("is-down", isOpen);
        }
      });
    }
      // 抉择功能
    var choiceBtn = pageEl.querySelector('[data-wm="choice"]');
    if (choiceBtn) {
      choiceBtn.addEventListener("click", openChoiceDialog);
      choiceBtn.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openChoiceDialog(); }
      });
    }
    // 电话：导航栏按钮（一对一呼出 / 群聊预留入口）
    var callNav = pageEl.querySelector('[data-act="call"]');
    if (callNav) {
      callNav.addEventListener("click", function () {
        if (ctx.type === "contact" && window.MinePhone) MinePhone.callContact(ctx.id);
      });
    }
    var groupCallNav = pageEl.querySelector('[data-act="group-call"]');
    if (groupCallNav) {
      groupCallNav.addEventListener("click", function () {
        if (window.MinePhone) MinePhone.openGroupCall(ctx.id);
      });
    }
    // 电话：with me 栏目（一对一呼出 / 群聊预留入口）
    var wmCall = pageEl.querySelector('[data-wm="call"]');
    if (wmCall) {
      wmCall.addEventListener("click", function () {
        if (ctx.type === "contact" && window.MinePhone) MinePhone.callContact(ctx.id);
      });
      wmCall.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (ctx.type === "contact" && window.MinePhone) MinePhone.callContact(ctx.id);
        }
      });
    }
    var wmGroupCall = pageEl.querySelector('[data-wm="group-call"]');
    if (wmGroupCall) {
      wmGroupCall.addEventListener("click", function () {
        if (window.MinePhone) MinePhone.openGroupCall(ctx.id);
      });
      wmGroupCall.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (window.MinePhone) MinePhone.openGroupCall(ctx.id);
        }
      });
    }
    // 图片：with me 栏目（多选图片发送）
    var wmImage = pageEl.querySelector('[data-wm="image"]');
    if (wmImage) {
      wmImage.addEventListener("click", function () { openImagePicker(); });
      wmImage.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openImagePicker();
        }
      });
    }
    // 用户滚动消息区：离开底部时显示"回到底部"，回到底部时隐藏
    msgContainer.addEventListener("scroll", function () {
      if (isNearBottom()) hideBackBottom();
      else showBackBottom();
    });
    // 点击时间 → 切换日期/时间显示
    msgContainer.addEventListener("click", function (e) {
      var timeEl = e.target.closest(".time-text");
      if (!timeEl) return;
      var isShowingTime = timeEl.getAttribute("data-show") !== "date";
      if (isShowingTime) {
        timeEl.textContent = timeEl.getAttribute("data-date");
        timeEl.setAttribute("data-show", "date");
      } else {
        timeEl.textContent = timeEl.getAttribute("data-time");
        timeEl.setAttribute("data-show", "time");
      }
    });
    // 点击对方头像 → 跳转到联系人主页
    msgContainer.addEventListener("click", function (e) {
      var tapEl = e.target.closest(".avatar-tap");
      if (!tapEl) return;
      var contactId = tapEl.getAttribute("data-contact-id");
      var senderName = tapEl.getAttribute("data-sender-name");
      if (!contactId) return;
      if (window.MineContacts && MineContacts.openProfile) {
        MineContacts.openProfile(contactId, senderName);
      }
    });
    /* ---------------- 长按消息 → 删除该条 / 清空聊天记录 ---------------- */
    var lpTimer = null;
    var lpRow = null;
    var suppressClickUntil = 0;
    function lpStart(e) {
      var t = e.target;
      var row = t && t.closest ? t.closest(".msg-row") : null;
      if (!row) return;
      if (lpRow === row) return;
      lpRow = row;
      row.classList.add("is-longpressing");
      lpTimer = setTimeout(function () {
        lpTimer = null;
        row.classList.remove("is-longpressing");
        suppressClickUntil = Date.now() + 500;  // 阻止长按后误触时间切换/头像跳转
        showMsgActionSheet(row);
      }, 600);
    }
    function lpCancel() {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      if (lpRow) { lpRow.classList.remove("is-longpressing"); lpRow = null; }
    }
    msgContainer.addEventListener("touchstart", lpStart, { passive: true });
    msgContainer.addEventListener("touchmove", lpCancel, { passive: true });
    msgContainer.addEventListener("touchend", lpCancel);
    msgContainer.addEventListener("touchcancel", lpCancel);
    msgContainer.addEventListener("mousedown", lpStart);
    msgContainer.addEventListener("mousemove", lpCancel);
    msgContainer.addEventListener("mouseup", lpCancel);
    msgContainer.addEventListener("mouseleave", lpCancel);
    msgContainer.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    // 长按后 500ms 内抑制点击类行为（时间切换 / 头像跳转）
    msgContainer.addEventListener("click", function (e) {
      if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    // 长按消息操作面板
    function showMsgActionSheet(row) {
      var id = row.getAttribute("data-msg-id") || "";
      var msgs = conversations[ctx.convKey] || [];
      var idx = -1;
      for (var i = 0; i < msgs.length; i++) {
        if (msgs[i] && msgs[i].id === id) { idx = i; break; }
      }
      var actions = [];
      actions.push({
        label: "删除这条消息",
        danger: true,
        fn: function () {
          if (idx >= 0) {
            msgs.splice(idx, 1);
            conversations[ctx.convKey] = msgs;
            save();
            renderMessages();
          }
        }
      });
      actions.push({
        label: "清空聊天记录",
        danger: true,
        fn: function () {
          conversations[ctx.convKey] = [];
          save();
          renderMessages();
        }
      });
      openMsgActionSheet("消息操作", actions);
    }
    // 通用底部操作面板（复用 .sheet 样式）
    function openMsgActionSheet(title, actions) {
      var ov = document.createElement("div");
      ov.className = "sheet-overlay";
      ov.innerHTML =
        '<div class="sheet">' +
          '<div class="sheet-handle"></div>' +
          '<div class="sheet-head"><h2>' + escapeHtml(title) + '</h2>' +
          '<button class="nav-btn" data-close="1">' + I.svg("close", 20) + '</button></div>' +
          '<div class="sheet-body">' +
            '<div class="msg-action-list">' +
              actions.map(function (a) {
                return '<button class="msg-action-btn' + (a.danger ? " is-danger" : "") + '" data-action="1">' +
                  escapeHtml(a.label) + '</button>';
              }).join("") +
              '<button class="msg-action-btn" data-close="1">取消</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      requestAnimationFrame(function () {
        ov.classList.add("is-open");
        var sheet = ov.querySelector(".sheet");
        if (sheet) sheet.classList.add("is-open");
      });
      function close() {
        ov.classList.remove("is-open");
        setTimeout(function () { ov.remove(); }, 300);
      }
      ov.addEventListener("click", function (e) {
        var t = e.target;
        if (t === ov || (t && t.closest && t.closest("[data-close]"))) { close(); return; }
        if (t && t.closest && t.closest("[data-action]")) {
          var i = Array.prototype.indexOf.call(ov.querySelectorAll("[data-action]"), t.closest("[data-action]"));
          if (i >= 0 && actions[i]) { close(); actions[i].fn(); }
        }
      });
    }
    // 输入框自适应高度 + 启用发送按钮
    inputEl.addEventListener("input", function () {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 120) + "px";
      sendBtn.disabled = !this.value.trim();
    });
    // Enter 发送（Shift+Enter 换行）
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    // 发送按钮
    sendBtn.addEventListener("click", doSend);
  }
  /* ---------------- 发送锁：移除（用输入框清空防重复即可） ---------------- */
  /* ---------------- 图片发送（with me 栏目 · 多选） ---------------- */
  function openImagePicker() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", function () {
      var files = Array.prototype.slice.call(input.files || []);
      document.body.removeChild(input);
      if (!files.length) return;
      if (files.length > 9) {
        files = files.slice(0, 9);
        var fn = window.showToast || (window.MineUtils && MineUtils.showToast) || function () {};
        fn("最多选择 9 张图片，已自动取前 9 张");
      }
      closeWithMePanel();
      sendImages(files);
    });
    input.click();
  }

  function closeWithMePanel() {
    var panel = document.getElementById("with-me-panel");
    var chevron = document.getElementById("with-me-chevron");
    if (panel) panel.classList.remove("is-open");
    if (chevron) chevron.classList.remove("is-down");
  }

  /* 多张图片：逐张压缩后按选中顺序发送为独立图片消息 */
  function sendImages(files) {
    var queue = files.filter(function (f) { return /^image\//.test(f.type); });
    if (!queue.length) return;
    function next() {
      if (!queue.length) return;
      var file = queue.shift();
      if (window.MineUtils && MineUtils.compressImage) {
        MineUtils.compressImage(file, 1080, 0.82, function (dataURL) {
          if (dataURL) pushImageMsg(dataURL);
          next();
        });
      } else {
        var reader = new FileReader();
        reader.onload = function () {
          pushImageMsg(reader.result);
          next();
        };
        reader.readAsDataURL(file);
      }
    }
    next();
  }

  function pushImageMsg(dataURL) {
    var msgs = conversations[ctx.convKey] || [];
    msgs.push({ id: uid(), from: "me", text: dataURL, time: Date.now(), read: false });
    conversations[ctx.convKey] = msgs;
    save();
    appendMessage(msgs[msgs.length - 1]);
    if (window.MineNotify) MineNotify.refreshBadges();
  }
  /* ---------------- 发送消息 ---------------- */
  function doSend() {
    var text = (inputEl.value || "").trim();
    if (!text) return;
    // 存储我的消息（未读状态）
    var msgs = conversations[ctx.convKey] || [];
    msgs.push({ id: uid(), from: "me", text: text, time: Date.now(), read: false });
    conversations[ctx.convKey] = msgs;
    save();
    // 清空输入并禁用按钮（防止重复发送）
    inputEl.value = "";
    inputEl.style.height = "auto";
    sendBtn.disabled = true;
    // 追加渲染
    appendMessage(msgs[msgs.length - 1]);
    // 触发对方回复
    scheduleReply();
  }
  /* ---------------- 追加单条消息 ---------------- */
  function appendMessage(msg) {
    var dateStr = fmtDateSep(msg.time);
    var lastSep = msgContainer.querySelector(".chat-date-sep:last-of-type");
    // 简单处理：若需要日期分隔
    var msgs = conversations[ctx.convKey] || [];
    var needDate = msgs.length <= 1;
    if (!needDate && msgs.length >= 2) {
      var prev = msgs[msgs.length - 2];
      if (fmtDateSep(prev.time) !== dateStr) needDate = true;
    }
    if (needDate) {
      var sep = document.createElement("div");
      sep.className = "chat-date-sep";
      sep.textContent = dateStr;
      msgContainer.appendChild(sep);
    }
    var row = document.createElement("div");
    row.innerHTML = msgRowHTML(msg);
    msgContainer.appendChild(row.firstChild);
    scrollToBottom();
  }
  /* ---------------- 将我的消息标记为已读并局部刷新 ---------------- */
  function markMyMessagesRead(convKey) {
    var key = convKey || ctx.convKey;
    var msgs = conversations[key];
    if (!msgs) return;
    var changed = false;
    msgs.forEach(function (m) {
      if (m.from === "me" && !m.read) { m.read = true; changed = true; }
    });
    if (changed) {
      save();
      // 局部更新已读标记，避免全量重绘导致与 appendMessage 冲突
      if (isViewingConv(key)) updateReadMarksUI();
    }
  }
  /* ---------------- 局部更新已读对勾 UI ---------------- */
  function updateReadMarksUI() {
    if (!msgContainer) return;
    // 找到所有"我"的消息行中还没有对勾的 msg-time
    var meRows = msgContainer.querySelectorAll(".msg-row.is-me");
    meRows.forEach(function (row) {
      var timeEl = row.querySelector(".msg-time");
      if (!timeEl) return;
      // 已有对勾则跳过
      if (timeEl.querySelector(".msg-read")) return;
      // 插入对勾
      var check = document.createElement("span");
      check.className = "msg-read is-read";
      check.innerHTML = I.svg("check", 13);
      timeEl.insertBefore(check, timeEl.firstChild);
    });
  }
  /* ---------------- 对方回复（随机字卡） ----------------
     关键修复：在调度时捕获当前会话上下文（convKey/type/id），
     避免用户切换或退出聊天后 setTimeout 回调使用过期的 ctx
     导致消息存入错误的会话或操作失效。
  */
  function scheduleReply() {
    // 确保通讯录数据已加载到内存
    if (C && C.loadData) C.loadData();
    // ★ 捕获当前会话上下文（防止用户退出/切换后 ctx 变化）
    var curConvKey = ctx.convKey;
    var curType = ctx.type;
    var curId = ctx.id;
    if (curType === "contact") {
      // 一对一
      var contact = C.findContact(curId);
      // 自动回复沉默概率（可自定义）
      if (Math.random() < prob("silentChance")) {
        scheduleAutoReply(contact, null, curConvKey);
        return;
      }
      // 设定区间内的随机时间（0 ~ replyDelay 秒）
      var maxDelay = (contact && contact.replyDelay !== undefined) ? contact.replyDelay : 1.5;
      var actualDelay = Math.random() * maxDelay * 1000;
      if (actualDelay > 15000) {
        // 延迟较长：在回复前 15 秒显示"正在输入"（仅在查看该会话时显示）
        setTimeout(function () { if (isViewingConv(curConvKey)) showTyping(null); }, actualDelay - 15000);
        setTimeout(function () {
          if (isViewingConv(curConvKey)) hideTyping();
          doContactReply(contact, curConvKey);
        }, actualDelay);
      } else {
        // 延迟很短：立即显示"正在输入"（仅在查看该会话时显示）
        if (isViewingConv(curConvKey)) showTyping(null);
        setTimeout(function () {
          if (isViewingConv(curConvKey)) hideTyping();
          doContactReply(contact, curConvKey);
        }, Math.max(300, actualDelay));
      }
    } else {
      // 群聊：按概率决定回复人数
      var group = C.findGroup(curId);
      // 先获取所有可回复成员，再按概率决定回复人数
      var allResponders = pickRandomMembers(group, 999);
      if (allResponders.length === 0) return;
      var numReply;
      /* 群聊回复人数：逐条累计模型（对任意人数群聊生效）
         · 第一条回复：必然 1 人
         · 第二条回复：命中"群聊第二条回复"概率（默认 40%，需 ≥2 人可回复）→ 回复人数 +1
         · 第三条回复：已有 ≥2 人回复时，命中"群聊第三条回复"概率（默认 15%，需 ≥3 人可回复）→ 回复人数 +1
         · 全员回复：已有 ≥3 人回复时，命中"群聊全员回复"概率（默认 5%，需 ≥4 人可回复）→ 全部成员回复
         · 每级独立判定，最大不超过可回复成员数 */
      numReply = 1;
      if (allResponders.length >= 2 && Math.random() < prob("groupSecond")) {
        numReply = Math.min(numReply + 1, allResponders.length);
      }
      if (allResponders.length >= 3 && numReply >= 2 && Math.random() < prob("groupThird")) {
        numReply = Math.min(numReply + 1, allResponders.length);
      }
      if (allResponders.length >= 4 && numReply >= 3 && Math.random() < prob("groupAll")) {
        numReply = allResponders.length;
      }
      var responders = allResponders.slice(0, Math.min(numReply, allResponders.length));
      if (responders.length === 0) return;
      var firstReply = true;
      responders.forEach(function (member) {
        // 自动回复沉默概率（可自定义）
        if (Math.random() < prob("silentChance")) {
          scheduleAutoReply(member, group, curConvKey);
          return;
        }
        // 设定区间内的随机时间
        var maxDelay = (member.replyDelay !== undefined) ? member.replyDelay : 1.5;
        var mDelay = Math.random() * maxDelay * 1000;
        (function (m, d) {
          function doReply() {
            if (isViewingConv(curConvKey)) hideTyping();
            var card = pickRandomCardForGroup(m, group);
            if (!card) return;
            var msgs = conversations[curConvKey];
            if (!msgs) return;
            var beforeLen = msgs.length;
            msgs.push({
              id: uid(),
              from: m.id,
              text: card,
              time: Date.now(),
              senderName: m.name || "未知",
              senderAvatar: m.avatar || null
            });
            // 文字字卡有 15% 概率附加 1~3 条 emoji（图片/语音字卡不附加）
            if (!isImageCard(card) && !isAudioCard(card) && !isEmojiCard(card)) {
              var _pool = [];
              if (m && m.cards) _pool = _pool.concat(m.cards);
              if (group && group.cards) _pool = _pool.concat(group.cards);
              var emojis = pickEmojiAttachments(_pool);
              for (var i = 0; i < emojis.length; i++) {
                msgs.push({
                  id: uid(),
                  from: m.id,
                  text: emojis[i],
                  time: Date.now(),
                  senderName: m.name || "未知",
                  senderAvatar: m.avatar || null
                });
              }
            }
            save();
            // 未查看时增加未读计数（类微信机制）
            if (!isViewingConv(curConvKey)) {
              incrementUnread(curConvKey);
              if (window.MineNotify) MineNotify.refreshBadges();
            }
            // 第一位成员回复时，将我的消息标记为已读
            if (firstReply) { markMyMessagesRead(curConvKey); firstReply = false; }
            // 仅在查看该会话时才追加 DOM（主消息 + emoji 附件）
            if (isViewingConv(curConvKey)) {
              for (var j = beforeLen; j < msgs.length; j++) {
                appendMessage(msgs[j]);
              }
            }
          }
          if (d > 15000) {
            // 延迟较长：在回复前 15 秒显示"正在输入"
            setTimeout(function () { if (isViewingConv(curConvKey)) showTyping(m); }, d - 15000);
            setTimeout(doReply, d);
          } else {
            // 延迟很短：立即显示"正在输入"
            setTimeout(function () {
              if (isViewingConv(curConvKey)) {
                showTyping(m);
                setTimeout(doReply, Math.max(300, d));
              } else {
                // 不在查看时直接调度回复（不显示"正在输入"）
                setTimeout(doReply, Math.max(300, d));
              }
            }, 0);
          }
        })(member, mDelay);
      });
    }
  }
  /* ---------------- 自动回复（1% 触发时） ----------------
     1% 触发未读通知，100% 使用自动回复字卡（无自动卡时回退普通卡）
     convKey: 调度时捕获的会话键，确保回复存入正确的会话 */
  function scheduleAutoReply(contact, group, convKey) {
    var card = group ? pickRandomAutoCardForGroup(contact, group) : pickRandomAutoCard(contact);
    // 无自动回复字卡 → 回退到普通字卡（确保 100% 触发回复）
    if (!card) {
      card = group ? pickRandomCardForGroup(contact, group) : pickRandomCard(contact);
    }
    // 仍无任何字卡 → 保持沉默
    if (!card) return;
    var maxDelay = (contact && contact.replyDelay !== undefined) ? contact.replyDelay : 1.5;
    var actualDelay = Math.random() * maxDelay * 1000;
    var typingMember = group ? contact : null;
    if (actualDelay > 15000) {
      // 延迟较长：在回复前 15 秒显示"正在输入"
      setTimeout(function () { if (isViewingConv(convKey)) showTyping(typingMember); }, actualDelay - 15000);
      setTimeout(function () {
        if (isViewingConv(convKey)) hideTyping();
        doAutoReply(contact, card, convKey);
      }, actualDelay);
    } else {
      // 延迟很短：立即显示"正在输入"
      setTimeout(function () {
        if (isViewingConv(convKey)) {
          showTyping(typingMember);
          setTimeout(function () {
            if (isViewingConv(convKey)) hideTyping();
            doAutoReply(contact, card, convKey);
          }, Math.max(300, actualDelay));
        } else {
          // 不在查看时直接调度回复
          setTimeout(function () { doAutoReply(contact, card, convKey); }, Math.max(300, actualDelay));
        }
      }, 0);
    }
  }
  function doAutoReply(contact, card, convKey) {
    var key = convKey || ctx.convKey;
    var msgs = conversations[key];
    if (!msgs) return;
    var senderName = (contact && contact.name) ? contact.name : "未知";
    var senderAvatar = (contact && contact.avatar) ? contact.avatar : null;
    var beforeLen = msgs.length;
    msgs.push({
      id: uid(),
      from: contact.id,
      text: card,
      time: Date.now(),
      isAutoReply: true,
      senderName: senderName,
      senderAvatar: senderAvatar
    });
    // 文字字卡有 15% 概率附加 1~3 条 emoji（图片/语音字卡不附加）
    if (!isImageCard(card) && !isAudioCard(card) && !isEmojiCard(card)) {
      var emojis = pickEmojiAttachments(contact.cards || []);
      for (var i = 0; i < emojis.length; i++) {
        msgs.push({
          id: uid(),
          from: contact.id,
          text: emojis[i],
          time: Date.now(),
          isAutoReply: true,
          senderName: senderName,
          senderAvatar: senderAvatar
        });
      }
    }
    save();
    // 未查看时增加未读计数
    if (!isViewingConv(key)) {
      incrementUnread(key);
      if (window.MineNotify) MineNotify.refreshBadges();
    }
    // 自动回复也标记已读
    markMyMessagesRead(key);
    // 仅在查看该会话时才追加 DOM（主消息 + emoji 附件）
    if (isViewingConv(key)) {
      for (var j = beforeLen; j < msgs.length; j++) {
        appendMessage(msgs[j]);
      }
    }
  }
  /* ---------------- 联系人回复执行 ---------------- */
  function doContactReply(contact, convKey) {
    var key = convKey || ctx.convKey;
    var msgs = conversations[key];
    if (!msgs) return;
    var card = pickRandomCard(contact);
    var senderName = (contact && contact.name) ? contact.name : "未知";
    var senderAvatar = (contact && contact.avatar) ? contact.avatar : null;
    var beforeLen = msgs.length;
    if (card) {
      msgs.push({ id: uid(), from: contact.id, text: card, time: Date.now(), senderName: senderName, senderAvatar: senderAvatar });
      // 文字字卡有 15% 概率附加 1~3 条 emoji（图片/语音字卡不附加）
      if (!isImageCard(card) && !isAudioCard(card) && !isEmojiCard(card)) {
        var emojis = pickEmojiAttachments(contact.cards || []);
        for (var i = 0; i < emojis.length; i++) {
          msgs.push({ id: uid(), from: contact.id, text: emojis[i], time: Date.now(), senderName: senderName, senderAvatar: senderAvatar });
        }
      }
    } else {
      // 无字卡 → 沉默占位
      msgs.push({ id: uid(), from: contact.id, text: "……", time: Date.now(), isEmpty: true, senderName: senderName, senderAvatar: senderAvatar });
    }
    save();
    // 未查看时增加未读计数（类微信机制）
    if (!isViewingConv(key)) {
      incrementUnread(key);
      if (window.MineNotify) MineNotify.refreshBadges();
    }
    // 对方回复后，将我的消息标记为已读
    markMyMessagesRead(key);
    // 仅在查看该会话时才追加 DOM（主消息 + emoji 附件）
    if (isViewingConv(key)) {
      for (var j = beforeLen; j < msgs.length; j++) {
        appendMessage(msgs[j]);
      }
    }
  }
  /* ---------------- 输入指示 ---------------- */
  function showTyping(member) {
    hideTyping();
    var typing = document.createElement("div");
    typing.className = "msg-row";
    typing.id = "typing-indicator-row";
    // 若 member 为 null（一对一聊天），不显示头像
    // 若 member 存在但 findContact 可能失败，使用 member 自身信息
    var avatar = "";
    var name = "";
    if (member) {
      avatar = C.avatarHTML(member, 32, "msg-avatar avatar-gen");
      name = (ctx.type === "group") ?
        '<div class="msg-sender">' + escapeHtml(member.name || "未知") + '</div>' : "";
    }
    typing.innerHTML = avatar +
      '<div class="msg-content">' + name +
      '<div class="msg-bubble is-them"><div class="typing-indicator">' +
      '<span></span><span></span><span></span></div></div></div>';
    msgContainer.appendChild(typing);
    scrollToBottom();
  }
  function hideTyping() {
    var t = document.getElementById("typing-indicator-row");
    if (t) t.remove();
  }
  /* ========================================================================
     会话列表（聊天应用主页）
     ======================================================================== */
  /* ========================================================================
     会话列表 · 长按删除对话
     长按会话栏（触摸 650ms / 鼠标按住 650ms）→ 底部弹出操作菜单
     「删除聊天」→ 删除该会话全部消息 + 未读 + 自定义背景/字体色
     ======================================================================== */
  function bindConvLongPress(row) {
    var timer = null;
    var supportsTouch = ("ontouchstart" in window);
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    function start(e) {
      if (e && e.button === 2) return;             /* 右键不触发 */
      cancel();
      timer = setTimeout(function () {
        timer = null;
        showConvActions(row);
      }, 650);
    }
    if (supportsTouch) {
      row.addEventListener("touchstart", start, { passive: true });
      row.addEventListener("touchend", cancel);
      row.addEventListener("touchmove", cancel, { passive: true });
      row.addEventListener("touchcancel", cancel);
    } else {
      row.addEventListener("mousedown", start);
      row.addEventListener("mouseup", cancel);
      row.addEventListener("mousemove", cancel);
      row.addEventListener("mouseleave", cancel);
    }
  }

  /* 底部操作菜单：删除聊天 / 取消 */
  function showConvActions(row) {
    var key = row.getAttribute("data-conv-key");
    if (!key) return;
    var overlay = document.createElement("div");
    overlay.className = "conv-actions-overlay";
    var title = "";
    var nameEl = row.querySelector(".conv-name");
    if (nameEl) title = nameEl.textContent;
    overlay.innerHTML =
      '<div class="conv-actions-sheet">' +
        '<div class="conv-actions-title">' + escapeHtml(title) + '</div>' +
        '<button class="conv-action-btn is-danger" data-act="del">删除聊天</button>' +
        '<button class="conv-action-btn" data-act="cancel">取消</button>' +
      '</div>';
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    overlay.querySelector('[data-act="del"]').addEventListener("click", function () {
      close();
      deleteConversation(key);
    });
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
  }

  /* 删除会话：消息 + 未读 + 会话自定义背景/字体色一并清除 */
  function deleteConversation(convKey) {
    delete conversations[convKey];
    save();
    /* 未读数清零 */
    try {
      var unread = JSON.parse(localStorage.getItem(UNREAD_KEY) || "{}");
      if (unread[convKey]) { delete unread[convKey]; localStorage.setItem(UNREAD_KEY, JSON.stringify(unread)); }
    } catch (e) {}
    /* 会话自定义背景图（内存 + IndexedDB + 旧 localStorage 一并清除） */
    try {
      if (chatBg && chatBg[convKey]) {
        delete chatBg[convKey];
        chatBgDbDel(convKey).catch(function () {});
      }
    } catch (e) {}
    try {
      var bg = JSON.parse(localStorage.getItem(BG_KEY) || "{}");
      if (bg[convKey]) { delete bg[convKey]; localStorage.setItem(BG_KEY, JSON.stringify(bg)); }
    } catch (e) {}
    /* 会话自定义字体颜色 */
    try {
      var fc = JSON.parse(localStorage.getItem(CHAT_FONTCOLOR_KEY) || "{}");
      if (fc[convKey]) { delete fc[convKey]; localStorage.setItem(CHAT_FONTCOLOR_KEY, JSON.stringify(fc)); }
    } catch (e) {}
    if (window.MineNotify) MineNotify.refreshBadges();
    if (typeof toast === "function") toast("已删除聊天记录");
    /* 回到聊天列表（列表页重渲染 / 对话页切回列表） */
    openConvList();
  }

  function openConvList() {
    load();
    hideBackBottom();
    // 确保通讯录数据已加载到内存（可能页面刷新后未加载）
    if (C && C.loadData) C.loadData();
    if (!pageEl) pageEl = document.getElementById("page-chat");
    if (!pageEl) return;
    var navHtml =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="home">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">聊天</span>' +
        '<span class="nav-right"></span>' +
      '</div>';
    // 收集所有有消息的会话
    var convs = [];
    Object.keys(conversations).forEach(function (key) {
      var msgs = conversations[key];
      if (!msgs || msgs.length === 0) return;
      var lastMsg = msgs[msgs.length - 1];
      var title, avatarHTML, type, id;
      if (key.indexOf("contact:") === 0) {
        var c = C.findContact(key.substring(8));
        var rawId = key.substring(8);
        if (!c && C.findContactByName) c = C.findContactByName(lastMsg.senderName);
        if (!c) {
          /* 兜底：历史数据中联系人已不存在，用最后一条消息的发送者信息展示，保证记录不丢失 */
          title = (lastMsg && lastMsg.senderName) ? lastMsg.senderName : "未知联系人";
          avatarHTML = C.avatarHTML({ name: title, avatar: (lastMsg && lastMsg.senderAvatar) || null }, 48, "conv-avatar");
          type = "contact"; id = rawId;
        } else {
          title = c.name;
          avatarHTML = C.avatarHTML(c, 48, "conv-avatar");
          /* id 不一致（按姓名兜底匹配到）时保留存储键的原 id，交给 openContact 重链 */
          type = "contact"; id = (c.id === rawId) ? c.id : rawId;
        }
      } else if (key.indexOf("group:") === 0) {
        var g = C.findGroup(key.substring(6));
        if (!g) return;
        title = g.name;
        avatarHTML = C.groupAvatarHTML(g, 48);
        type = "group"; id = g.id;
      } else return;
      // 图片消息在预览中显示"[图片]"；语音消息显示"[语音]"
      var _isImg = typeof lastMsg.text === "string" && lastMsg.text.indexOf("data:image/") === 0;
      var _isAud = typeof lastMsg.text === "string" && lastMsg.text.indexOf("data:audio/") === 0;
      var _preview = _isImg ? "[图片]" : (_isAud ? "[语音]" : lastMsg.text);
      convs.push({
        key: key, title: title, avatarHTML: avatarHTML,
        type: type, id: id,
        lastText: lastMsg.from === "me" ? "我: " + _preview : _preview,
        lastTime: lastMsg.time,
        unread: getUnread(key)
      });
    });
    // 按最后消息时间排序
    convs.sort(function (a, b) { return b.lastTime - a.lastTime; });
    var bodyHtml = '<div class="scroll"><div class="conv-list">';
    if (convs.length === 0) {
      bodyHtml += '<div class="contacts-empty">' +
        '<div class="ce-icon">' + I.svg("chat", 26) + '</div>' +
        '<div class="ce-title">还没有对话</div>' +
        '<div class="ce-desc">从通讯录中选择联系人开始聊天</div>' +
        '</div>';
    } else {
      convs.forEach(function (conv) {
        // 未读角标
        var badgeHTML = '';
        if (conv.unread > 0) {
          var badgeNum = conv.unread > 99 ? '99+' : String(conv.unread);
          badgeHTML = '<span class="conv-badge">' + escapeHtml(badgeNum) + '</span>';
        }
        bodyHtml += '<div class="conv-row" data-conv-type="' + conv.type + '" data-conv-id="' + conv.id + '" data-conv-key="' + escapeHtml(conv.key) + '">' +
          '<div class="conv-avatar-wrap">' +
            conv.avatarHTML +
            badgeHTML +
          '</div>' +
          '<div class="conv-info">' +
            '<span class="conv-name">' + escapeHtml(conv.title) + '</span>' +
            '<span class="conv-last">' + escapeHtml(conv.lastText) + '</span>' +
          '</div>' +
          '<span class="conv-time">' + fmtTime(conv.lastTime) + '</span>' +
          '</div>';
      });
    }
    bodyHtml += '</div></div>';
    pageEl.innerHTML = navHtml + bodyHtml;
    // 绑定
    pageEl.querySelector('[data-act="home"]').addEventListener("click", function () {
      if (window.MineApp && MineApp.goHome) MineApp.goHome();
    });
    pageEl.querySelectorAll("[data-conv-type]").forEach(function (row) {
      row.addEventListener("click", function () {
        var type = row.getAttribute("data-conv-type");
        var id = row.getAttribute("data-conv-id");
        if (type === "contact") openContact(id);
        else openGroup(id);
      });
      /* 长按联系人栏 → 删除该对话（微信式：弹出操作菜单） */
      bindConvLongPress(row);
    });
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("chat");
  }
  /* ========================================================================
     抉择功能
     ------------------------------------------------------------------------
     弹窗：上 1/4 问题输入 + 下 3/4 四个选项 + 保存提交按钮
     提交后对方在 5 分钟内随机选择一个选项并回复
     ======================================================================== */
  var CHOICE_STORE_KEY = "mine.chat.choices.v1";
  var pendingChoices = {};  // { convKey: { question, options, submitTime } }
  function loadPendingChoices() {
    try {
      var raw = localStorage.getItem(CHOICE_STORE_KEY);
      if (raw) pendingChoices = JSON.parse(raw) || {};
    } catch (e) {}
    if (!pendingChoices) pendingChoices = {};
  }
  function savePendingChoices() {
    try { localStorage.setItem(CHOICE_STORE_KEY, JSON.stringify(pendingChoices)); } catch (e) {}
  }
  function openChoiceDialog() {
    // 移除已有弹窗
    var existing = document.querySelector(".choice-overlay");
    if (existing) existing.remove();
    loadPendingChoices();
    var saved = pendingChoices[ctx.convKey];
    var question = (saved && saved.question) ? saved.question : "";
    var options = (saved && saved.options && saved.options.length > 0)
      ? saved.options.slice()
      : ["", ""];  // 默认 2 个选项
    var overlay = document.createElement("div");
    overlay.className = "choice-overlay";
    var html = '<div class="choice-dialog">' +
      '<div class="choice-header">' +
        '<span class="choice-title">抉择</span>' +
        '<button class="choice-close" id="choice-close">' + I.svg("close", 18) + '</button>' +
      '</div>' +
      '<div class="choice-question-section">' +
        '<textarea class="choice-question-input" id="choice-question" ' +
          'placeholder="写下你想让对方抉择的问题…" maxlength="200" rows="2">' +
          escapeHtml(question) +
        '</textarea>' +
      '</div>' +
      '<div class="choice-options-section" id="choice-options-wrap">';
    for (var i = 0; i < options.length; i++) {
      html += buildOptionRow(i, options[i], options.length > 2);
    }
    html += '</div>' +
      '<div class="choice-footer">' +
        '<button class="choice-add-btn" id="choice-add-opt">' + I.svg("plus", 14) + '添加选项</button>' +
        '<button class="choice-submit-btn" id="choice-submit">保存并提交</button>' +
      '</div>' +
      '</div>';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    // 触发动画
    requestAnimationFrame(function () { overlay.classList.add("is-open"); });
    // 关闭按钮
    overlay.querySelector("#choice-close").addEventListener("click", closeChoiceDialog);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeChoiceDialog();
    });
    // 添加选项按钮
    overlay.querySelector("#choice-add-opt").addEventListener("click", function () {
      addOptionRow();
    });
    // 删除选项按钮（事件委托）
    overlay.querySelector("#choice-options-wrap").addEventListener("click", function (e) {
      var delBtn = e.target.closest(".choice-option-del");
      if (!delBtn) return;
      var row = delBtn.closest(".choice-option-row");
      if (!row) return;
      var wrap = overlay.querySelector("#choice-options-wrap");
      var rows = wrap.querySelectorAll(".choice-option-row");
      if (rows.length <= 2) return;  // 最少保留 2 个选项
      row.remove();
      refreshOptionLabels();
    });
    // 保存并提交
    overlay.querySelector("#choice-submit").addEventListener("click", submitChoice);
  }
  /** 构建单个选项行 HTML */
  function buildOptionRow(index, value, canDelete) {
    var letter = String.fromCharCode(65 + index);
    return '<div class="choice-option-row">' +
      '<span class="choice-option-label">' + letter + '</span>' +
      '<input type="text" class="choice-option-input" ' +
        'placeholder="选项 ' + letter + '" maxlength="100" value="' +
        escapeHtml(value || "") + '">' +
      (canDelete ? '<button class="choice-option-del" title="删除选项">' + I.svg("close", 12) + '</button>' : '') +
    '</div>';
  }
  /** 添加一行选项 */
  function addOptionRow() {
    var wrap = document.querySelector("#choice-options-wrap");
    if (!wrap) return;
    var rows = wrap.querySelectorAll(".choice-option-row");
    var newIndex = rows.length;
    if (newIndex >= 26) return;  // 最多 26 个选项（A-Z）
    wrap.insertAdjacentHTML("beforeend", buildOptionRow(newIndex, "", true));
    refreshOptionLabels();
    // 聚焦到新输入框
    var inputs = wrap.querySelectorAll(".choice-option-input");
    if (inputs[inputs.length - 1]) inputs[inputs.length - 1].focus();
  }
  /** 刷新所有选项行的字母标签和 placeholder */
  function refreshOptionLabels() {
    var wrap = document.querySelector("#choice-options-wrap");
    if (!wrap) return;
    var rows = wrap.querySelectorAll(".choice-option-row");
    var canDelete = rows.length > 2;
    rows.forEach(function (row, idx) {
      var letter = String.fromCharCode(65 + idx);
      var label = row.querySelector(".choice-option-label");
      if (label) label.textContent = letter;
      var input = row.querySelector(".choice-option-input");
      if (input) input.placeholder = "选项 " + letter;
      var delBtn = row.querySelector(".choice-option-del");
      if (canDelete && !delBtn) {
        row.insertAdjacentHTML("beforeend",
          '<button class="choice-option-del" title="删除选项">' + I.svg("close", 12) + '</button>');
      } else if (!canDelete && delBtn) {
        delBtn.remove();
      }
    });
  }
  function closeChoiceDialog() {
    var overlay = document.querySelector(".choice-overlay");
    if (!overlay) return;
    overlay.classList.remove("is-open");
    setTimeout(function () { overlay.remove(); }, 300);
  }
  function submitChoice() {
    var questionEl = document.getElementById("choice-question");
    var question = (questionEl.value || "").trim();
    var options = [];
    var optionInputs = document.querySelectorAll("#choice-options-wrap .choice-option-input");
    optionInputs.forEach(function (el) {
      options.push((el.value || "").trim());
    });
    if (!question) {
      shakeElement(document.getElementById("choice-question"));
      return;
    }
    var filledOptions = options.filter(function (o) { return o.length > 0; });
    if (filledOptions.length < 2) {
      var firstInput = document.querySelector("#choice-options-wrap .choice-option-input");
      if (firstInput) shakeElement(firstInput);
      return;
    }
    // 保存到持久化
    loadPendingChoices();
    pendingChoices[ctx.convKey] = {
      question: question,
      options: options,
      submitTime: Date.now()
    };
    savePendingChoices();
    // 关闭弹窗
    closeChoiceDialog();
    // 在聊天中发送抉择消息
    var choiceMsg = "【抉择】" + question + "\n";
    for (var j = 0; j < options.length; j++) {
      if (options[j]) {
        choiceMsg += String.fromCharCode(65 + j) + ". " + options[j] + "\n";
      }
    }
    choiceMsg = choiceMsg.trimEnd();
    var msgs = conversations[ctx.convKey] || [];
    msgs.push({ id: uid(), from: "me", text: choiceMsg, time: Date.now(), read: false, isChoice: true });
    conversations[ctx.convKey] = msgs;
    save();
    appendMessage(msgs[msgs.length - 1]);
    // 对方在 5 分钟内随机选择并回复
    scheduleChoiceReply(filledOptions);
  }
  function scheduleChoiceReply(filledOptions) {
    // 捕获当前会话上下文（避免用户切换聊天后回复发错对话框）
    var curConvKey = ctx.convKey;
    var curType = ctx.type;
    var curId = ctx.id;
    // 随机延迟范围：10秒 ~ 5分钟
    var minDelay = 10000;
    var maxDelay = 5 * 60 * 1000;
    /** 发送单条抉择回复 */
    function sendChoiceReply(fromId, senderName, senderAvatar, delay) {
      setTimeout(function () {
        // 重新加载数据（确保数据是最新的）
        load();
        var msgs = conversations[curConvKey];
        if (!msgs) return;
        var pickedIdx = Math.floor(Math.random() * filledOptions.length);
        var picked = filledOptions[pickedIdx];
        var pickedLetter = String.fromCharCode(65 + pickedIdx);
        var replyText = "我选择 " + pickedLetter + "：" + picked;
        /* 在原始抉择消息上标注答案：找到最近一条我发送的 isChoice 消息 */
        for (var i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].isChoice && msgs[i].from === "me") {
            if (!msgs[i].choiceAnswers) msgs[i].choiceAnswers = [];
            msgs[i].choiceAnswers.push({
              letter: pickedLetter,
              fromId: fromId,
              name: senderName
            });
            break;
          }
        }
        msgs.push({
          id: uid(),
          from: fromId,
          text: replyText,
          time: Date.now(),
          isChoiceReply: true,
          senderName: senderName,
          senderAvatar: senderAvatar
        });
        save();
        // 未查看时增加未读计数
        if (!isViewingConv(curConvKey)) {
          incrementUnread(curConvKey);
          if (window.MineNotify) MineNotify.refreshBadges();
        }
        // 只有当前正在查看该会话时才更新 UI
        if (isViewingConv(curConvKey)) {
          markMyMessagesRead();
          // 重新渲染以在原始问卷上显示标注的答案
          renderMessages();
        }
      }, delay);
    }
    if (curType === "contact") {
      // 一对一：对方一人回复
      var contact = C.findContact(curId);
      var fromId = contact ? contact.id : curId;
      var name = contact ? (contact.name || "未知") : "未知";
      var avatar = contact ? (contact.avatar || null) : null;
      var delay = minDelay + Math.random() * (maxDelay - minDelay);
      sendChoiceReply(fromId, name, avatar, delay);
    } else if (curType === "group") {
      // 群聊：所有成员均做出选择并回复，各自随机延迟
      var group = C.findGroup(curId);
      if (group && group.members && group.members.length > 0) {
        group.members.forEach(function (m) {
          var memberId = typeof m === "string" ? m : m.id;
          var member = C.findContact(memberId);
          if (!member) return;
          var mDelay = minDelay + Math.random() * (maxDelay - minDelay);
          sendChoiceReply(member.id, member.name || "未知", member.avatar || null, mDelay);
        });
      }
    }
  }
  function shakeElement(el) {
    if (!el) return;
    el.classList.add("shake");
    setTimeout(function () { el.classList.remove("shake"); }, 400);
  }
  /* ========================================================================
     注册页面钩子
     ======================================================================== */
  window.MineApp = window.MineApp || {};
  var prevPage = window.MineApp.page;
  window.MineApp.page = function (id) {
    if (id === "chat") { openConvList(); return true; }
    return prevPage ? prevPage(id) : false;
  };
  /* ---------------- 搜索聊天记录 ---------------- */
  function searchHistory(convType, convId, opts) {
    var key = convType + ":" + convId;
    var msgs = conversations[key] || [];
    if (msgs.length === 0) return [];
    var keyword = (opts && opts.keyword) ? opts.keyword.trim().toLowerCase() : "";
    var dateStr = (opts && opts.date) ? opts.date.trim() : "";
    var results = [];
    msgs.forEach(function (msg, idx) {
      var match = true;
      // 关键词匹配
      if (keyword) {
        match = (msg.text || "").toLowerCase().indexOf(keyword) >= 0;
      }
      // 日期匹配
      if (match && dateStr) {
        var d = new Date(msg.time);
        var msgDate = d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
        match = (msgDate === dateStr);
      }
      if (match) {
        var senderName = "我";
        var senderAvatar = null;
        if (msg.from !== "me") {
          /* 一对一聊天：所有非"我"消息均来自同一联系人（convId），
             用 convId 查找而非 msg.from，与 msgRowHTML 中 ctx.id 的逻辑一致 */
          var lookupId = (convType === "contact") ? convId : msg.from;
          var contact = C.findContact(lookupId);
          senderName = (contact && contact.name) ? contact.name : (msg.senderName || "未知");
          senderAvatar = (contact && contact.avatar) ? contact.avatar : (msg.senderAvatar || null);
        }
        results.push({
          index: idx,
          text: msg.text,
          isImage: typeof msg.text === "string" && msg.text.indexOf("data:image/") === 0,
          time: msg.time,
          from: msg.from,
          senderName: senderName,
          senderAvatar: senderAvatar,
          isAutoReply: !!msg.isAutoReply,
          isEmpty: !!msg.isEmpty
        });
      }
    });
    return results;
  }
  /* ---------------- 用户打开聊天应用时调用 ----------------
     仅清除主屏角标（appLevelSeen = true），保留各会话的未读计数
     （会话列表中的角标仍显示，直到用户点进具体会话） */
  function clearAllUnread() {
    appLevelSeen = true;
    if (window.MineNotify) MineNotify.refreshBadges();
  }
  /* ---------------- 注册 MineNotify provider ---------------- */
  if (window.MineNotify) {
    MineNotify.register("chat", getNotifyCount, clearAllUnread);
  }
  /* ========================================================================
     系统通知联动
     ------------------------------------------------------------------------
     · 点击通知（页面内 / SW 转发）→ 跳转到对应会话
     · 回前台汇总（保活模块广播）→ 轻提示"你不在的时候收到 N 条新消息"
     ======================================================================== */
  document.addEventListener("mine:notify-click", function (e) {
    var d = e.detail || {};
    var key = d.convKey;
    if (!key) return;
    try {
      if (key.indexOf("contact:") === 0) openContact(key.substring(8));
      else if (key.indexOf("group:") === 0) openGroup(key.substring(6));
    } catch (err) {}
  });
  document.addEventListener("mine:notify-summary", function (e) {
    var d = e.detail || {};
    if (!d.total) return;
    var text = "你不在的时候收到 " + d.total + " 条新消息";
    if (d.calls) text += " · " + d.calls + " 次来电";
    var fn = window.showToast || (window.MineUtils && MineUtils.showToast) || function () {};
    try { fn(text); } catch (err) {}
  });
  var api = {
    openContact: openContact,
    openGroup: openGroup,
    openConvList: openConvList,
    getConversations: function () { return JSON.parse(JSON.stringify(conversations)); },
    searchHistory: searchHistory,
    getTotalUnread: getTotalUnread,
    clearAllUnread: clearAllUnread,
    refreshConvListBadges: openConvList,
    /* 会话背景读写（背景管理器按联系人/群聊设置背景时调用） */
    setConvBg: setConvBg,
    getConvBg: getConvBg
  };

  /* 模块启动即预加载会话背景（IndexedDB 异步），
     避免首次进入主屏/会话时背景尚未从存储恢复 */
  loadBg();

  return api;
})();
