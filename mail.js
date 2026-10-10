/* ========================================================================
   Mine · 次元信箱
   ------------------------------------------------------------------------
   功能架构（参照 QQ邮箱 / 网易邮箱）：
   · 收件箱：收到联系人发来的邮件
   · 发件箱：已发送的邮件
   · 草稿箱：未发送的草稿
   · 写邮件：支持单独发送 / 群发
   · 数据持久化：localStorage
   
   代码结构预留扩展空间：
   · MailStore.dataManager 可扩展为后端 API
   · MailStore.onSend/onReceive 钩子供后续模拟回复功能
   ======================================================================== */

window.MineMail = (function () {
  "use strict";

  var I = window.MineIcons;
  var C = window.MineContacts;
  var STORE_KEY = "mine.mail.v1";

  /* ==================== 数据层 ====================
     邮件结构：
     { id, type: "in"|"out"|"draft",
       from: { id, name },        // 发件人
       to: [{ id, name }, ...],   // 收件人列表
       subject: "",               // 主题
       body: "",                  // 正文
       time: timestamp,
       read: boolean,             // 是否已读
       starred: boolean           // 星标
     }
  */
  var MailStore = {
    inbox: [],
    outbox: [],
    drafts: [],

    load: function () {
      try {
        var raw = localStorage.getItem(STORE_KEY);
        if (raw) {
          var data = JSON.parse(raw);
          this.inbox = data.inbox || [];
          this.outbox = data.outbox || [];
          this.drafts = data.drafts || [];
        }
      } catch (e) {}
    },

    save: function () {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          inbox: this.inbox,
          outbox: this.outbox,
          drafts: this.drafts
        }));
      } catch (e) {}
    },

    /* 添加邮件到对应信箱 */
    add: function (mail) {
      mail.id = "mail_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
      mail.time = Date.now();
      mail.read = mail.read || false;
      mail.starred = mail.starred || false;

      if (mail.type === "in") this.inbox.unshift(mail);
      else if (mail.type === "out") this.outbox.unshift(mail);
      else if (mail.type === "draft") this.drafts.unshift(mail);

      this.save();
      return mail;
    },

    /* 从草稿发送 */
    sendDraft: function (draftId) {
      var idx = this.drafts.findIndex(function (m) { return m.id === draftId; });
      if (idx < 0) return null;
      var draft = this.drafts.splice(idx, 1)[0];
      draft.type = "out";
      draft.time = Date.now();
      draft.read = true;
      draft.status = "sending";
      this.outbox.unshift(draft);
      this.save();

      // 扩展钩子：发送后可触发收件人自动回复
      if (typeof this.onSend === "function") this.onSend(draft);
      return draft;
    },

    /* 保存草稿 */
    saveDraft: function (data) {
      var draft = {
        type: "draft",
        from: data.from || { id: "me", name: "我" },
        to: data.to || [],
        subject: data.subject || "",
        body: data.body || "",
        time: Date.now(),
        read: true,
        starred: false
      };
      return this.add(draft);
    },

    /* 更新草稿 */
    updateDraft: function (id, data) {
      var d = this.drafts.find(function (m) { return m.id === id; });
      if (!d) return null;
      if (data.to) d.to = data.to;
      if (data.subject !== undefined) d.subject = data.subject;
      if (data.body !== undefined) d.body = data.body;
      d.time = Date.now();
      this.save();
      return d;
    },

    /* 删除邮件 */
    remove: function (type, id) {
      var box = type === "in" ? this.inbox : type === "out" ? this.outbox : this.drafts;
      var idx = box.findIndex(function (m) { return m.id === id; });
      if (idx >= 0) {
        box.splice(idx, 1);
        this.save();
      }
    },

    /* 标记已读 */
    markRead: function (type, id) {
      var box = type === "in" ? this.inbox : type === "out" ? this.outbox : this.drafts;
      var m = box.find(function (x) { return x.id === id; });
      if (m) { m.read = true; this.save(); }
    },

    /* 切换星标 */
    toggleStar: function (type, id) {
      var box = type === "in" ? this.inbox : type === "out" ? this.outbox : this.drafts;
      var m = box.find(function (x) { return x.id === id; });
      if (m) { m.starred = !m.starred; this.save(); }
    },

    /* 获取未读数 */
    unreadCount: function (type) {
      var box = type === "in" ? this.inbox : type === "out" ? this.outbox : this.drafts;
      return box.filter(function (m) { return !m.read; }).length;
    }
  };

  /* ==================== 回信调度系统 ====================
     流程：
       发送邮件 → 1-60分钟随机延迟 → 信件送达 → 1-24小时随机延迟 → 收到回信
     持久化：pendingReplies 存入 localStorage，页面刷新后恢复
  */
  var PENDING_KEY = "mine.mail.pending.v1";
  var pendingReplies = [];
  var replyCheckerTimer = null;

  function loadPending() {
    try {
      var raw = localStorage.getItem(PENDING_KEY);
      if (raw) pendingReplies = JSON.parse(raw) || [];
    } catch (e) {}
    if (!pendingReplies) pendingReplies = [];
  }

  function savePending() {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pendingReplies));
    } catch (e) {}
  }

  /* ==================== 主动来信调度系统 ====================
     流程：
       每24小时检测 → 10%概率触发 → 随机选一位联系人
       → 1-60分钟随机送达延迟 → 信件送达（存入"他的来信"）
     内容机制与回信相同：字卡组合
     持久化：pendingActive 存入 localStorage，页面刷新后恢复
  */
  var ACTIVE_KEY = "mine.mail.active.v1";
  var ACTIVE_CHECK_KEY = "mine.mail.activecheck.v1";
  var pendingActive = [];

  function loadActive() {
    try {
      var raw = localStorage.getItem(ACTIVE_KEY);
      if (raw) pendingActive = JSON.parse(raw) || [];
    } catch (e) {}
    if (!pendingActive) pendingActive = [];
  }

  function saveActive() {
    try {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(pendingActive));
    } catch (e) {}
  }

  /* 调度回信：每位收件人独立调度 */
  function scheduleReply(mail) {
    if (!mail.to || mail.to.length === 0) return;

    mail.to.forEach(function (recipient) {
      // 1-60 分钟随机送达延迟
      var deliveryDelay = (1 + Math.random() * 59) * 60 * 1000;
      var deliveryTime = Date.now() + deliveryDelay;

      // 1-24 小时随机回信延迟（送达后）
      var replyDelayHours = 1 + Math.random() * 23;
      var replyDelay = replyDelayHours * 60 * 60 * 1000;
      var replyTime = deliveryTime + replyDelay;

      pendingReplies.push({
        mailId: mail.id,
        recipient: { id: recipient.id, name: recipient.name },
        originalSubject: mail.subject || "(无主题)",
        originalBody: mail.body || "",
        deliveryTime: deliveryTime,
        replyTime: replyTime,
        delivered: false,
        replied: false
      });
    });

    savePending();
    checkPendingReplies();
  }

  /* 调度主动来信：随机联系人 → 1-60分钟送达 */
  function scheduleActiveLetter(contact) {
    var deliveryDelay = (1 + Math.random() * 59) * 60 * 1000;
    var deliveryTime = Date.now() + deliveryDelay;

    pendingActive.push({
      contact: { id: contact.id, name: contact.name },
      deliveryTime: deliveryTime,
      delivered: false
    });

    saveActive();
    checkPendingReplies();
  }

  /* 每24小时检测是否触发主动来信（10%概率） */
  function checkActiveLetters() {
    var now = Date.now();
    var lastCheck = 0;
    try {
      lastCheck = parseInt(localStorage.getItem(ACTIVE_CHECK_KEY) || "0", 10);
    } catch (e) {}

    if (now - lastCheck < 24 * 60 * 60 * 1000) return;

    try {
      localStorage.setItem(ACTIVE_CHECK_KEY, String(now));
    } catch (e) {}

    // 10% 概率触发主动来信
    if (Math.random() >= 0.10) return;

    var contacts = getContacts();
    if (contacts.length === 0) return;

    // 随机选一位联系人
    var contact = contacts[Math.floor(Math.random() * contacts.length)];
    scheduleActiveLetter(contact);
  }

  /* 检查并处理到期的回信 */
  function checkPendingReplies() {
    var now = Date.now();
    var changed = false;

    pendingReplies.forEach(function (p) {
      // 标记送达
      if (!p.delivered && now >= p.deliveryTime) {
        p.delivered = true;
        // 更新发件箱中对应邮件的状态为"已送达"
        var outMail = MailStore.outbox.find(function (m) { return m.id === p.mailId; });
        if (outMail && outMail.status === "sending") {
          outMail.status = "delivered";
          MailStore.save();
        }
        changed = true;
      }
      // 处理回信
      if (p.delivered && !p.replied && now >= p.replyTime) {
        var replyContent = generateReply(p);
        var reply = {
          type: "in",
          from: { id: p.recipient.id, name: p.recipient.name },
          to: [{ id: "me", name: "我" }],
          subject: "Re: " + p.originalSubject,
          body: replyContent,
          read: false,
          starred: false,
          mailKind: "reply"
        };
        MailStore.add(reply);
        p.replied = true;
        changed = true;
      }
    });

    // 移除已回复的
    var before = pendingReplies.length;
    pendingReplies = pendingReplies.filter(function (p) { return !p.replied; });
    if (pendingReplies.length !== before) changed = true;

    // 处理主动来信送达
    pendingActive.forEach(function (p) {
      if (!p.delivered && now >= p.deliveryTime) {
        var content = generateReply({ recipient: p.contact });
        var activeMail = {
          type: "in",
          from: { id: p.contact.id, name: p.contact.name },
          to: [{ id: "me", name: "我" }],
          subject: "(无主题)",
          body: content,
          read: false,
          starred: false,
          mailKind: "active"
        };
        MailStore.add(activeMail);
        p.delivered = true;
        changed = true;
      }
    });

    // 移除已送达的主动来信
    var beforeActive = pendingActive.length;
    pendingActive = pendingActive.filter(function (p) { return !p.delivered; });
    if (pendingActive.length !== beforeActive) changed = true;

    if (changed) {
      savePending();
      saveActive();
      // 新邮件到达时刷新通知角标
      if (window.MineNotify) MineNotify.refreshBadges();
    }
  }

  /* ==================== 字卡类型检测 ==================== */
  function isImageCard(card) {
    return typeof card === "string" && card.indexOf("data:image/") === 0;
  }

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

  /* 生成回信内容：字卡组合 */
  function generateReply(pending) {
    return generateCardReply(pending.recipient);
  }

  /* 字卡组合回复：
     抽取该联系人字符字卡总量的 5%-20%，
     从字符字卡 + emoji 字卡中随机选择组合，
     每条字卡之间用逗号、句号、感叹号、省略号或 emoji 字卡衔接 */
  function generateCardReply(recipient) {
    var contact = C ? C.findContact(recipient.id) : null;
    if (!contact || !contact.cards || contact.cards.length === 0) {
      return "（信已收到，暂无言以对。）";
    }

    var allCards = contact.cards;

    // 分类：文字字卡 / emoji 字卡（排除图片字卡）
    var textCards = [];
    var emojiCards = [];
    allCards.forEach(function (card) {
      if (isImageCard(card)) return;
      if (isEmojiCard(card)) emojiCards.push(card);
      else textCards.push(card);
    });

    // 组合池：文字字卡 + emoji 字卡
    var pool = textCards.concat(emojiCards);
    if (pool.length === 0) {
      return "（信已收到，暂无言以对。）";
    }

    // 内容总数为字符字卡总条数的 5%-20%
    var textTotal = textCards.length;
    var minCount = Math.max(1, Math.ceil(textTotal * 0.05));
    var maxCount = Math.max(minCount, Math.ceil(textTotal * 0.20));
    var count = minCount + Math.floor(Math.random() * (maxCount - minCount + 1));
    count = Math.min(count, pool.length);

    // 随机抽取（不重复）
    var poolCopy = pool.slice();
    var selected = [];
    for (var i = 0; i < count && poolCopy.length > 0; i++) {
      var idx = Math.floor(Math.random() * poolCopy.length);
      selected.push(poolCopy[idx]);
      poolCopy.splice(idx, 1);
    }

    // 随机衔接符：逗号、句号、感叹号、省略号、或 emoji 字卡
    var puncts = ["，", "。", "！", "……"];
    var result = "";
    for (var j = 0; j < selected.length; j++) {
      result += selected[j];
      if (j < selected.length - 1) {
        // 约 1/5 概率用 emoji 字卡衔接
        var useEmojiConnector = emojiCards.length > 0 && Math.random() < 0.20;
        if (useEmojiConnector) {
          result += emojiCards[Math.floor(Math.random() * emojiCards.length)];
        } else {
          result += puncts[Math.floor(Math.random() * puncts.length)];
        }
      }
    }
    return result;
  }

  /* 启动定期检查器 */
  function startReplyChecker() {
    if (replyCheckerTimer) clearInterval(replyCheckerTimer);
    // 每 30 秒检查一次回信和主动来信
    replyCheckerTimer = setInterval(function () {
      checkPendingReplies();
      checkActiveLetters();
    }, 30000);
    // 立即检查一次（处理离线期间到期的回信和主动来信）
    checkPendingReplies();
    checkActiveLetters();
  }

  /* ==================== 工具函数 ==================== */
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var h = d.getHours(), m = d.getMinutes();
    var time = (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
    if (sameDay) return time;
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + time;
  }

  function getContacts() {
    if (!C) return [];
    if (C.loadData) C.loadData();
    if (C.getState) return C.getState().contacts || [];
    return [];
  }

  function contactById(id) {
    var list = getContacts();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* ==================== 页面状态 ==================== */
  var pageEl = null;
  var currentView = "main";  // main | inbox | outbox | drafts | read | compose
  var currentMail = null;     // 正在阅读的邮件
  var composeData = null;    // 正在编辑的草稿数据
  var searchQuery = "";       // 当前搜索关键字
  var searchTimers = {};      // 防抖计时器
  var viewHistory = [];       // 导航历史栈

  /* 前进导航：将当前视图压入历史栈，切换到新视图 */
  function navigateTo(view) {
    viewHistory.push(currentView);
    currentView = view;
    searchQuery = "";
    render();
  }

  /* 返回导航：弹出历史栈顶，返回上一视图 */
  function goBack() {
    searchQuery = "";
    if (viewHistory.length > 0) {
      currentView = viewHistory.pop();
    } else {
      currentView = "main";
    }
    render();
  }

  /* 重置导航并跳转（用于操作完成后） */
  function resetTo(view) {
    viewHistory = [];
    currentView = view;
    searchQuery = "";
    render();
  }

  /* ==================== 搜索 & 分组工具 ==================== */

  /* 生成搜索栏 HTML */
  function searchBarHTML(placeholder) {
    return '<div class="mail-search-bar">' +
      '<span class="mail-search-icon">' + I.svg("search", 16) + '</span>' +
      '<input type="text" class="mail-search-input" id="mail-search" ' +
        'placeholder="' + (placeholder || "搜索昵称、主题或正文…") + '" ' +
        'value="' + escapeHtml(searchQuery) + '" autocomplete="off">' +
      (searchQuery ? '<button class="mail-search-clear" data-act="clear-search">' + I.svg("close", 14) + '</button>' : '') +
    '</div>';
  }

  /* 获取邮件的关联名称（用于分组） */
  function mailGroupName(mail, boxType) {
    if (boxType === "in") {
      return mail.from ? mail.from.name : "未知";
    }
    // outbox / drafts: 按收件人分组
    if (mail.to && mail.to.length === 1) return mail.to[0].name;
    if (mail.to && mail.to.length > 1) return mail.to[0].name + " 等" + mail.to.length + "人";
    return "无收件人";
  }

  /* 按名称分组 */
  function groupMailsByName(mails, boxType) {
    var groups = {};
    var order = [];
    mails.forEach(function (m) {
      var name = mailGroupName(m, boxType);
      if (!groups[name]) {
        groups[name] = [];
        order.push(name);
      }
      groups[name].push(m);
    });
    return order.map(function (name) {
      return { name: name, mails: groups[name] };
    });
  }

  /* 关键字过滤邮件 */
  function filterMails(mails, query, boxType) {
    if (!query || !query.trim()) return mails;
    var q = query.trim().toLowerCase();
    return mails.filter(function (m) {
      // 昵称
      var fromName = m.from ? (m.from.name || "") : "";
      if (fromName.toLowerCase().indexOf(q) >= 0) return true;
      var toNames = (m.to || []).map(function (t) { return t.name || ""; }).join(" ");
      if (toNames.toLowerCase().indexOf(q) >= 0) return true;
      // 主题
      if ((m.subject || "").toLowerCase().indexOf(q) >= 0) return true;
      // 正文
      if ((m.body || "").toLowerCase().indexOf(q) >= 0) return true;
      return false;
    });
  }

  /* 渲染分组后的邮件列表 */
  function renderGroupedMails(mails, boxType) {
    var groups = groupMailsByName(mails, boxType);
    var html = "";
    if (groups.length === 0) {
      html += '<div class="empty-state">' +
        '<div class="empty-icon">' + I.svg("search", 30) + '</div>' +
        '<div class="empty-title">未找到匹配的信件</div>' +
        '<div class="empty-desc">试试其他关键字</div>' +
      '</div>';
      return html;
    }
    groups.forEach(function (g) {
      html += '<div class="mail-group-head">' +
        '<span class="mail-group-name">' + escapeHtml(g.name) + '</span>' +
        '<span class="mail-group-count">' + g.mails.length + ' 封</span>' +
      '</div>';
      g.mails.forEach(function (mail) {
        html += mailListItem(mail, boxType);
      });
    });
    return html;
  }

  /* ==================== 视图层 ==================== */

  /* ---- 主页面（信箱列表） ---- */
  function viewMain() {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">次元信箱</span>' +
        '<button class="nav-btn nav-right" data-act="compose">' + I.svg("pencil", 20) + '</button>' +
      '</div>';

    var inboxUnread = MailStore.unreadCount("in");
    var outboxUnread = MailStore.unreadCount("out");
    var draftsCount = MailStore.drafts.length;

    var html = '<div class="scroll mail-scroll">';

    // 搜索栏
    html += searchBarHTML("搜索信件…");

    // 搜索模式：显示全部信箱的搜索结果
    if (searchQuery.trim()) {
      var allMails = MailStore.inbox.concat(MailStore.outbox).concat(MailStore.drafts);
      var filtered = filterMails(allMails, searchQuery, "in");
      html += '<div class="mail-section-head">搜索结果 · ' + filtered.length + '</div>';
      if (filtered.length === 0) {
        html += '<div class="empty-state">' +
          '<div class="empty-icon">' + I.svg("search", 30) + '</div>' +
          '<div class="empty-title">未找到匹配的信件</div>' +
          '<div class="empty-desc">试试其他关键字</div>' +
        '</div>';
      } else {
        // 按信箱类型分组显示
        var inMails = filtered.filter(function (m) { return m.type === "in"; });
        var outMails = filtered.filter(function (m) { return m.type === "out"; });
        var draftMails = filtered.filter(function (m) { return m.type === "draft"; });
        if (inMails.length > 0) {
          html += '<div class="mail-group-head"><span class="mail-group-name">收件箱</span><span class="mail-group-count">' + inMails.length + ' 封</span></div>';
          html += renderGroupedMails(inMails, "in");
        }
        if (outMails.length > 0) {
          html += '<div class="mail-group-head"><span class="mail-group-name">发件箱</span><span class="mail-group-count">' + outMails.length + ' 封</span></div>';
          html += renderGroupedMails(outMails, "out");
        }
        if (draftMails.length > 0) {
          html += '<div class="mail-group-head"><span class="mail-group-name">草稿箱</span><span class="mail-group-count">' + draftMails.length + ' 封</span></div>';
          html += renderGroupedMails(draftMails, "drafts");
        }
      }
      html += '</div>';
      return navBar + html;
    }

    // 信箱列表
    html += mailBoxRow("inbox", "收件箱", MailStore.inbox.length, inboxUnread);
    html += mailBoxRow("outbox", "发件箱", MailStore.outbox.length, outboxUnread);
    html += mailBoxRow("drafts", "草稿箱", draftsCount, 0);

    html += '<div class="list-sep"></div>';

    // 快捷操作
    html += '<div class="group-head">快捷操作</div>';
    html += '<div class="func-row mail-action" role="button" tabindex="0" data-act="compose">' +
      '<div class="func-icon">' + I.svg("pencil", 20) + '</div>' +
      '<div class="func-text"><span class="func-title">写邮件</span>' +
      '<span class="func-sub">发送给一位或多位联系人</span></div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span></div>';

    html += '</div>';
    return navBar + html;
  }

  function mailBoxRow(type, name, total, unread) {
    var badge = unread > 0
      ? '<span class="mail-badge">' + unread + '</span>'
      : '';
    return '<div class="func-row mail-box-row" role="button" tabindex="0" data-act="open-box" data-box="' + type + '">' +
      '<div class="func-icon">' + I.svg(type === "inbox" ? "feather" : type === "outbox" ? "send" : "pencil", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">' + name + '</span>' +
        '<span class="func-sub">' + total + ' 封邮件' + (unread > 0 ? ' · ' + unread + ' 封未读' : '') + '</span>' +
      '</div>' +
      badge +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
    '</div>';
  }

  /* ---- 邮件列表（发件箱/草稿箱），按收件人昵称分组 ---- */
  function viewBox(boxType) {
    var titles = { outbox: "发件箱", drafts: "草稿箱" };
    var box = boxType === "out" ? MailStore.outbox : MailStore.drafts;
    var bt = boxType; // "out" | "drafts"

    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back-main">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">' + titles[boxType] + '</span>' +
        (boxType === "drafts"
          ? '<button class="nav-btn nav-right" data-act="compose">' + I.svg("pencil", 20) + '</button>'
          : '<span class="nav-right"></span>') +
      '</div>';

    var html = '<div class="scroll mail-scroll">';

    // 搜索栏
    html += searchBarHTML("搜索昵称、主题或正文…");

    // 搜索过滤
    var mails = box;
    var query = searchQuery.trim();
    if (query) {
      mails = filterMails(mails, query, bt);
    }

    if (mails.length === 0) {
      if (query) {
        html += '<div class="empty-state">' +
          '<div class="empty-icon">' + I.svg("search", 30) + '</div>' +
          '<div class="empty-title">未找到匹配的信件</div>' +
          '<div class="empty-desc">试试其他关键字</div>' +
        '</div>';
      } else {
        html += '<div class="empty-state">' +
          '<div class="empty-icon">' + I.svg(boxType === "drafts" ? "pencil" : "send", 30) + '</div>' +
          '<div class="empty-title">' + (boxType === "drafts" ? "暂无草稿" : "暂无已发送邮件") + '</div>' +
          '<div class="empty-desc">' + (boxType === "drafts" ? "写一封邮件，保存为草稿" : "发送邮件后将显示在这里") + '</div>' +
        '</div>';
      }
    } else {
      html += renderGroupedMails(mails, bt);
    }

    html += '</div>';
    return navBar + html;
  }

  /* ---- 收件箱（分两个板块：他的回信 / 他的来信），按昵称分组 ---- */
  function viewInbox() {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back-main">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">收件箱</span>' +
        '<span class="nav-right"></span>' +
      '</div>';

    // 回信 = mailKind 为 "reply" 或无标记（兼容旧数据）
    var replies = MailStore.inbox.filter(function (m) { return m.mailKind !== "active"; });
    // 来信 = mailKind 为 "active"
    var actives = MailStore.inbox.filter(function (m) { return m.mailKind === "active"; });

    // 搜索过滤
    var query = searchQuery.trim();
    if (query) {
      replies = filterMails(replies, query, "in");
      actives = filterMails(actives, query, "in");
    }

    var html = '<div class="scroll mail-scroll">';

    // 搜索栏
    html += searchBarHTML("搜索昵称、主题或正文…");

    // 板块一：他的回信
    html += '<div class="mail-section-head">他的回信 · ' + replies.length + '</div>';
    if (replies.length === 0) {
      html += '<div class="mail-section-empty">' + (query ? '未找到匹配的回信' : '暂无回信') + '</div>';
    } else {
      html += renderGroupedMails(replies, "in");
    }

    html += '<div class="list-sep"></div>';

    // 板块二：他的来信
    html += '<div class="mail-section-head">他的来信 · ' + actives.length + '</div>';
    if (actives.length === 0) {
      html += '<div class="mail-section-empty">' + (query ? '未找到匹配的来信' : '暂无来信') + '</div>';
    } else {
      html += renderGroupedMails(actives, "in");
    }

    html += '</div>';
    return navBar + html;
  }

  function mailListItem(mail, boxType) {
    var nameField = boxType === "in"
      ? (mail.from ? mail.from.name : "未知")
      : (mail.to && mail.to.length > 0
          ? (mail.to.length === 1 ? mail.to[0].name : mail.to[0].name + " 等" + mail.to.length + "人")
          : "无收件人");

    var unreadCls = !mail.read ? " is-unread" : "";
    var starCls = mail.starred ? " is-starred" : "";

    // 发件箱显示发送状态
    var statusHtml = "";
    if (boxType === "out") {
      if (mail.status === "sending") {
        statusHtml = '<span class="mail-status mail-status-sending">正在发送</span>';
      } else if (mail.status === "delivered") {
        statusHtml = '<span class="mail-status mail-status-delivered">已送达</span>';
      }
    }

    var html = '<div class="mail-item' + unreadCls + '" role="button" tabindex="0" ' +
      'data-act="read-mail" data-box="' + boxType + '" data-id="' + mail.id + '">' +
      '<div class="mail-item-star' + starCls + '" data-act="star" data-id="' + mail.id + '">' +
        I.svg("star", 16) +
      '</div>' +
      '<div class="mail-item-body">' +
        '<div class="mail-item-head">' +
          '<div class="mail-item-from-wrap">' +
            '<span class="mail-item-from">' + escapeHtml(nameField) + '</span>' +
            statusHtml +
          '</div>' +
          '<span class="mail-item-time">' + fmtTime(mail.time) + '</span>' +
        '</div>' +
        '<div class="mail-item-subject">' + escapeHtml(mail.subject || "(无主题)") + '</div>' +
        '<div class="mail-item-preview">' + escapeHtml((mail.body || "").slice(0, 50)) + '</div>' +
      '</div>' +
    '</div>';

    return html;
  }

  /* ---- 阅读邮件 ---- */
  function viewRead(boxType, mail) {
    var titles = { in: "收件箱", out: "发件箱", drafts: "草稿箱" };
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back-box" data-box="' + boxType + '">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">' + titles[boxType] + '</span>' +
        '<span class="nav-right"></span>' +
      '</div>';

    var html = '<div class="scroll mail-scroll">';

    // 邮件头
    var fromName = mail.from ? mail.from.name : "未知";
    var toNames = (mail.to || []).map(function (t) { return t.name; }).join("、") || "无";

    html += '<div class="mail-read">';
    html += '<div class="mail-read-subject">' + escapeHtml(mail.subject || "(无主题)") + '</div>';
    html += '<div class="mail-read-meta">';
    html += '<div class="mail-read-row"><span class="mr-label">发件人</span><span class="mr-value">' + escapeHtml(fromName) + '</span></div>';
    html += '<div class="mail-read-row"><span class="mr-label">收件人</span><span class="mr-value">' + escapeHtml(toNames) + '</span></div>';
    html += '<div class="mail-read-row"><span class="mr-label">时间</span><span class="mr-value">' + fmtTime(mail.time) + '</span></div>';
    if (boxType === "out") {
      var statusText = mail.status === "sending" ? "正在发送…" : mail.status === "delivered" ? "已送达" : "已发送";
      var statusClass = mail.status === "sending" ? " mail-read-status-sending" : mail.status === "delivered" ? " mail-read-status-delivered" : "";
      html += '<div class="mail-read-row"><span class="mr-label">状态</span><span class="mr-value' + statusClass + '">' + statusText + '</span></div>';
    }
    html += '</div>';

    // 正文
    html += '<div class="list-sep"></div>';
    html += '<div class="mail-read-body">' + escapeHtml(mail.body || "").replace(/\n/g, "<br>") + '</div>';

    // 操作按钮
    html += '<div class="mail-read-actions">';

    if (boxType === "drafts") {
      html += '<button class="btn btn-primary btn-block" data-act="edit-draft" data-id="' + mail.id + '">' +
        I.svg("pencil", 18) + '继续编辑</button>';
      html += '<button class="btn btn-block" data-act="send-draft" data-id="' + mail.id + '">' +
        I.svg("send", 18) + '发送</button>';
    } else if (boxType === "in") {
      html += '<button class="btn btn-primary btn-block" data-act="reply" data-id="' + mail.id + '">' +
        I.svg("back", 18) + '回复</button>';
    }

    html += '<button class="btn btn-danger btn-block" data-act="delete-mail" data-box="' + boxType + '" data-id="' + mail.id + '">' +
      I.svg("trash", 18) + '删除</button>';

    html += '</div>'; // .mail-read-actions
    html += '</div>'; // .mail-read
    html += '</div>'; // .scroll

    return navBar + html;
  }

  /* ---- 写邮件 / 编辑草稿 ---- */
  function viewCompose(existingDraft) {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back-main">' + I.svg("close", 20) + '取消</button>' +
        '<span class="nav-title">写邮件</span>' +
        '<button class="nav-btn nav-right" data-act="save-draft">存草稿</button>' +
      '</div>';

    var contacts = getContacts();
    var d = existingDraft || composeData || { to: [], subject: "", body: "" };

    var html = '<div class="scroll mail-scroll mail-compose">';

    // 收件人选择区
    html += '<div class="compose-field">';
    html += '<label class="compose-label">收件人</label>';
    html += '<div class="compose-recipients" id="compose-recipients">';
    // 已选中的收件人标签
    (d.to || []).forEach(function (r, i) {
      html += '<span class="recipient-tag" data-contact-id="' + escapeHtml(r.id) + '">' +
        escapeHtml(r.name) +
        '<button class="recipient-remove" data-act="remove-recipient" data-index="' + i + '">' + I.svg("close", 12) + '</button>' +
      '</span>';
    });
    html += '</div>';
    html += '<div class="compose-contact-picker" id="contact-picker-list">';
    contacts.forEach(function (c) {
      var selected = (d.to || []).some(function (r) { return r.id === c.id; });
      html += '<div class="contact-pick-item' + (selected ? " is-selected" : "") + '" ' +
        'data-act="toggle-recipient" data-contact-id="' + escapeHtml(c.id) + '" data-contact-name="' + escapeHtml(c.name) + '">' +
        '<span class="contact-pick-avatar">' + escapeHtml((c.name || "?").charAt(0)) + '</span>' +
        '<span class="contact-pick-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="contact-pick-check">' + I.svg("check", 16) + '</span>' +
      '</div>';
    });
    html += '</div>';
    html += '</div>'; // .compose-field

    html += '<div class="list-sep"></div>';

    // 主题
    html += '<div class="compose-field compose-field-row">';
    html += '<label class="compose-label">主题</label>';
    html += '<input type="text" class="compose-input" id="compose-subject" placeholder="邮件主题" ' +
      'value="' + escapeHtml(d.subject || "") + '" maxlength="50">';
    html += '</div>';

    // 正文
    html += '<div class="compose-field">';
    html += '<label class="compose-label">正文</label>';
    html += '<textarea class="compose-textarea" id="compose-body" placeholder="写点什么…" ' +
      'maxlength="2000" rows="8">' + escapeHtml(d.body || "") + '</textarea>';
    html += '</div>';

    // 发送按钮
    html += '<div class="compose-actions">';
    html += '<button class="btn btn-primary btn-block" data-act="send-mail">' +
      I.svg("send", 18) + '发送</button>';
    html += '</div>';

    html += '</div>'; // .scroll

    return navBar + html;
  }

  /* ==================== 事件绑定 ==================== */
  function render() {
    if (!pageEl) return;
    var html;

    if (currentView === "main") html = viewMain();
    else if (currentView === "inbox") html = viewInbox();
    else if (currentView === "outbox") html = viewBox("out");
    else if (currentView === "drafts") html = viewBox("drafts");
    else if (currentView === "read") html = viewRead(currentMail._boxType, currentMail);
    else if (currentView === "compose") html = viewCompose(composeData);
    else html = viewMain();

    pageEl.innerHTML = html;
    bindEvents();

    if (window.MineApp && MineApp.switchPage) {
      MineApp.switchPage("detail");
    }
  }

  function bindEvents() {
    if (!pageEl) return;

    // 返回按钮：回到陪伴页（而非主界面）
    pageEl.querySelectorAll('[data-act="back"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (window.MineApp && MineApp.switchPage) {
          MineApp.switchPage("companion");
        } else if (window.MineApp && MineApp.goHome) {
          MineApp.goHome();
        }
      });
    });
    pageEl.querySelectorAll('[data-act="back-main"]').forEach(function (btn) {
      btn.addEventListener("click", goBack);
    });
    pageEl.querySelectorAll('[data-act="back-box"]').forEach(function (btn) {
      btn.addEventListener("click", goBack);
    });

    // 写邮件
    pageEl.querySelectorAll('[data-act="compose"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        composeData = { to: [], subject: "", body: "", _editingId: null };
        navigateTo("compose");
      });
    });

    // 打开信箱
    pageEl.querySelectorAll('[data-act="open-box"]').forEach(function (row) {
      row.addEventListener("click", function () {
        var box = row.getAttribute("data-box");
        navigateTo(box);
      });
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      });
    });

    // 阅读邮件
    pageEl.querySelectorAll('[data-act="read-mail"]').forEach(function (item) {
      item.addEventListener("click", function (e) {
        // 如果点击的是星标，不进入阅读
        if (e.target.closest('[data-act="star"]')) return;
        var boxType = item.getAttribute("data-box");
        var id = item.getAttribute("data-id");
        var box = boxType === "in" ? MailStore.inbox : boxType === "out" ? MailStore.outbox : MailStore.drafts;
        var mail = box.find(function (m) { return m.id === id; });
        if (mail) {
          mail._boxType = boxType;
          MailStore.markRead(boxType, id);
          currentMail = mail;
          navigateTo("read");
        }
      });
    });

    // 星标切换
    pageEl.querySelectorAll('[data-act="star"]').forEach(function (star) {
      star.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = star.getAttribute("data-id");
        // 从当前页面推断 boxType
        var boxType = star.closest("[data-box]");
        var bt = boxType ? boxType.getAttribute("data-box") : "in";
        MailStore.toggleStar(bt, id);
        render();
      });
    });

    // 存草稿
    var saveDraftBtn = pageEl.querySelector('[data-act="save-draft"]');
    if (saveDraftBtn) {
      saveDraftBtn.addEventListener("click", saveDraft);
    }

    // 发送邮件
    var sendBtn = pageEl.querySelector('[data-act="send-mail"]');
    if (sendBtn) {
      sendBtn.addEventListener("click", sendMail);
    }

    // 发送草稿（从阅读页）
    pageEl.querySelectorAll('[data-act="send-draft"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        // 先找到草稿数据用于调度回信
        var draft = MailStore.drafts.find(function (m) { return m.id === id; });
        var sent = MailStore.sendDraft(id);
        if (sent) scheduleReply(sent);
        resetTo("outbox");
      });
    });

    // 编辑草稿
    pageEl.querySelectorAll('[data-act="edit-draft"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        var d = MailStore.drafts.find(function (m) { return m.id === id; });
        if (d) {
          composeData = {
            to: d.to || [],
            subject: d.subject || "",
            body: d.body || "",
            _editingId: d.id
          };
          navigateTo("compose");
        }
      });
    });

    // 删除邮件
    pageEl.querySelectorAll('[data-act="delete-mail"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var boxType = btn.getAttribute("data-box");
        var id = btn.getAttribute("data-id");
        MailStore.remove(boxType, id);
        goBack();
      });
    });

    // 回复
    pageEl.querySelectorAll('[data-act="reply"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        var orig = MailStore.inbox.find(function (m) { return m.id === id; });
        if (orig && orig.from) {
          composeData = {
            to: [{ id: orig.from.id, name: orig.from.name }],
            subject: "Re: " + (orig.subject || ""),
            body: "",
            _editingId: null
          };
          navigateTo("compose");
        }
      });
    });

    // 切换收件人选择
    pageEl.querySelectorAll('[data-act="toggle-recipient"]').forEach(function (item) {
      item.addEventListener("click", function () {
        var cid = item.getAttribute("data-contact-id");
        var cname = item.getAttribute("data-contact-name");
        if (!composeData) composeData = { to: [], subject: "", body: "" };
        if (!composeData.to) composeData.to = [];

        var idx = composeData.to.findIndex(function (r) { return r.id === cid; });
        if (idx >= 0) {
          composeData.to.splice(idx, 1);
        } else {
          composeData.to.push({ id: cid, name: cname });
        }
        render();
      });
    });

    // 移除收件人标签
    pageEl.querySelectorAll('[data-act="remove-recipient"]').forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-index"), 10);
        if (composeData && composeData.to) {
          composeData.to.splice(idx, 1);
          render();
        }
      });
    });

    // 实时捕获主题和正文输入
    var subjectInput = pageEl.querySelector("#compose-subject");
    if (subjectInput) {
      subjectInput.addEventListener("input", function () {
        if (!composeData) composeData = {};
        composeData.subject = this.value;
      });
    }
    var bodyInput = pageEl.querySelector("#compose-body");
    if (bodyInput) {
      bodyInput.addEventListener("input", function () {
        if (!composeData) composeData = {};
        composeData.body = this.value;
      });
    }

    // 搜索输入
    var searchInput = pageEl.querySelector("#mail-search");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        var self = this;
        if (searchTimers.main) clearTimeout(searchTimers.main);
        searchTimers.main = setTimeout(function () {
          searchQuery = self.value;
          render();
          // 重新渲染后聚焦并保持光标在末尾
          var newInput = pageEl.querySelector("#mail-search");
          if (newInput) {
            newInput.focus();
            var len = newInput.value.length;
            newInput.setSelectionRange(len, len);
          }
        }, 300);
      });
    }

    // 清除搜索
    pageEl.querySelectorAll('[data-act="clear-search"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        searchQuery = "";
        render();
      });
    });
  }

  /* ==================== 操作 ==================== */
  function saveDraft() {
    if (!composeData) return;
    var meName = "我";
    try {
      var raw = localStorage.getItem("mine.me.v1");
      if (raw) { var me = JSON.parse(raw); if (me && me.name) meName = me.name; }
    } catch (e) {}

    var data = {
      from: { id: "me", name: meName },
      to: composeData.to || [],
      subject: composeData.subject || "",
      body: composeData.body || ""
    };

    if (composeData._editingId) {
      MailStore.updateDraft(composeData._editingId, data);
    } else {
      MailStore.saveDraft(data);
    }

    composeData = null;
    resetTo("drafts");
  }

  function sendMail() {
    if (!composeData) return;
    if (!composeData.to || composeData.to.length === 0) {
      // 提示选择收件人
      var picker = pageEl.querySelector("#contact-picker-list");
      if (picker) {
        picker.style.animation = "none";
        picker.offsetHeight; // reflow
        picker.style.animation = "mailShake 0.4s ease";
      }
      return;
    }

    var meName = "我";
    try {
      var raw = localStorage.getItem("mine.me.v1");
      if (raw) { var me = JSON.parse(raw); if (me && me.name) meName = me.name; }
    } catch (e) {}

    var mail = {
      type: "out",
      from: { id: "me", name: meName },
      to: composeData.to,
      subject: composeData.subject || "(无主题)",
      body: composeData.body || "",
      read: true,
      starred: false,
      status: "sending"
    };

    // 如果是编辑草稿，先删除原草稿
    if (composeData._editingId) {
      MailStore.remove("drafts", composeData._editingId);
    }

    MailStore.add(mail);

    // 调度回信：送达延迟 + 回信延迟
    scheduleReply(mail);

    composeData = null;
    resetTo("outbox");
  }

  /* ==================== 初始化 ==================== */
  function init() {
    pageEl = document.getElementById("page-detail");
    MailStore.load();
    loadPending();
    loadActive();
    startReplyChecker();
  }

  /* ==================== 通知接口 ====================
     供 MineNotify 在 app.js 中注册为 "companion" 聚合 provider 的一部分
  */
  function getUnreadCount() {
    MailStore.load();
    return MailStore.unreadCount("in");
  }
  function clearUnread() {
    MailStore.load();
    MailStore.inbox.forEach(function (m) { m.read = true; });
    MailStore.save();
  }

  /* ==================== 公共接口 ==================== */
  return {
    init: init,
    open: function () {
      if (!pageEl) pageEl = document.getElementById("page-detail");
      MailStore.load();
      loadPending();
      loadActive();
      checkPendingReplies();
      checkActiveLetters();
      viewHistory = [];
      currentView = "main";
      searchQuery = "";
      render();
    },
    getStore: function () { return MailStore; },
    getUnreadCount: getUnreadCount,
    clearUnread: clearUnread,
    // 扩展接口：注册自动回复机制
    onSend: null,
    // 接收邮件（供其他模块调用，模拟收到来信）
    receiveMail: function (from, to, subject, body) {
      var mail = {
        type: "in",
        from: from,
        to: to,
        subject: subject || "(无主题)",
        body: body || "",
        read: false,
        starred: false
      };
      return MailStore.add(mail);
    }
  };
})();
