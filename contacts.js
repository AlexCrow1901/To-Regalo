  /* ========================================================================
   Mine · 通讯录模块
   ------------------------------------------------------------------------
   功能：
   · 联系人列表（头像 / 昵称 / 状态）
   · 新增 / 编辑 / 删除联系人（头像可上传或自动生成雾色首字）
   · 群聊模式：多选联系人 → 设群名 → 创建群聊
   · 群聊列表与群详情（查看成员）
   · localStorage 持久化
   接入：通过 MineApp.page("contacts") 钩子接管，不改动 app.js 主流程。
   ======================================================================== */

window.MineContacts = (function () {
  "use strict";

  var STORE_KEY = "mine.contacts.v1";
  var I = window.MineIcons;

  /* ---------------- 数据 ---------------- */
  var state = {
    contacts: [],
    groups: []
  };

  // 首次使用的雾都风种子数据（含初始字卡 + 状态池）
  var SEED = [
    { name: "艾琳·格雷",     status: "雾中独行",
      statuses: ["雾中独行", "在窗边读信", "雨打湿了裙摆", "等雾散去", "聆听钟声"],
      cards: ["雾太浓了，看不清前路。", "你听见钟声了吗？", "今天的雨比昨天更冷。", "我在窗边等你很久了。"] },
    { name: "亚瑟·彭德尔顿", status: "在雨中读信",
      statuses: ["在雨中读信", "整理旧书", "炉边沉思", "雾都夜行", "磨墨写信"],
      cards: ["信已寄出，不知能否送达。", "雾都的夜总是这么长。", "你还好吗？", "路灯又灭了一盏。"] },
    { name: "维罗妮卡",       status: "炉火将熄",
      statuses: ["炉火将熄", "缝补旧衣", "望雾出神", "低声哼唱", "独坐灯下"],
      cards: ["炉火快灭了。", "给我讲个故事吧。", "雾里有声音。", "我不想一个人。"] },
    { name: "西奥多",         status: "钟声穿过雾街",
      statuses: ["钟声穿过雾街", "漫步桥上", "数着路灯", "雾中独行", "等待黎明"],
      cards: ["钟声又响了。", "时间在雾里停滞。", "你来了。", "走吧，趁雾还没散。"] }
  ];

  /* ---------------- 持久化 ---------------- */
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        state = JSON.parse(raw);
        // 兼容旧数据：确保每个联系人都有 cards / statuses 字段
        var U = window.MineUtils;
        state.contacts.forEach(function (c) {
          if (!c.cards) c.cards = [];
          if (!c.autoCards) c.autoCards = [];
          if (!c.momentCards) c.momentCards = [];
          if (!c.momentCover) c.momentCover = null;
          if (!c.momentCoverTime) c.momentCoverTime = 0;
          if (c.momentPost === undefined) c.momentPost = null;
          if (!c.momentPostTime) c.momentPostTime = 0;
          if (!c.momentHistory) c.momentHistory = [];
          if (!c.statuses) c.statuses = [];
          // 若 statuses 为空但有 status，用当前状态初始化
          if (c.statuses.length === 0 && c.status) {
            c.statuses = [c.status];
          }
          // 回复延迟（秒），默认 1.5 秒
          if (c.replyDelay === undefined) c.replyDelay = 1.5;
          // 主动发消息设置（默认开启；区间 1 分钟 ~ 12 小时）
          if (c.proactiveOn === undefined) c.proactiveOn = true;
          if (c.proactiveMin === undefined) c.proactiveMin = 1;
          if (c.proactiveMax === undefined) c.proactiveMax = 720;
          // 迁移旧默认：此前默认最短间隔为 60 分钟且从未自定义（60~720 为默认组合）→ 改为 1 分钟
          if (c.proactiveMin === 60 && c.proactiveMax === 720) {
            c.proactiveMin = 1;
            c.proactiveMax = 720;
          }
          // 去重：清理历史遗留的重复字卡
          if (U && c.cards.length > 1) c.cards = U.deduplicateCards(c.cards);
          // 排序字卡（文本按拼音 A→Z，图片追加末尾）
          if (c.cards.length > 1) c.cards = sortCardsMixed(c.cards);
          // 去重 + 排序：自动回复字卡
          if (U && c.autoCards.length > 1) c.autoCards = U.deduplicateCards(c.autoCards);
          if (U && c.autoCards.length > 1) c.autoCards = U.sortByPinyin(c.autoCards);
        });
        // 兼容旧数据：确保每个群都有 avatar / cards 字段
        state.groups.forEach(function (g) {
          if (!g.avatar) g.avatar = null;
          if (!g.cards) g.cards = [];
          if (!g.autoCards) g.autoCards = [];
          // 去重：清理历史遗留的重复群字卡
          if (U && g.cards.length > 1) g.cards = U.deduplicateCards(g.cards);
          // 排序群字卡（文本按拼音 A→Z，图片追加末尾）
          if (g.cards.length > 1) g.cards = sortCardsMixed(g.cards);
          // 去重 + 排序：群自动回复字卡
          if (U && g.autoCards.length > 1) g.autoCards = U.deduplicateCards(g.autoCards);
          if (U && g.autoCards.length > 1) g.autoCards = U.sortByPinyin(g.autoCards);
        });
        return;
      }
    } catch (e) {}
    // 首次：写入种子
    SEED.forEach(function (s, i) {
      var seedCards = (s.cards || []).slice();
      if (window.MineUtils && seedCards.length > 1) {
        seedCards = window.MineUtils.sortByPinyin(seedCards);
      }
      state.contacts.push({
        id: "c" + Date.now() + "_" + i,
        name: s.name,
        status: s.status,
        avatar: null,
        cards: seedCards,
        autoCards: [],
        momentCards: [],
        statuses: (s.statuses || []).slice(),
        replyDelay: 1.5
      });
    });
    save();
  }

  /* ---------------- 工具 ---------------- */
  function uid(p) { return (p || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1000); }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** 判断字卡内容是否为图片（dataURL） */
  function isImageCard(text) {
    return typeof text === "string" && text.indexOf("data:image/") === 0;
  }

  /** 判断字卡内容是否为语音（audio dataURL） */
  function isAudioCard(text) {
    return typeof text === "string" && text.indexOf("data:audio/") === 0;
  }

  /** 判断字卡内容是否为 emoji（由 emoji 字符组成的短串） */
  function isEmojiCard(text) {
    if (typeof text !== "string" || text.length === 0) return false;
    if (isImageCard(text)) return false;
    // 去除变体选择符、零宽连字等修饰字符
    var stripped = text.replace(/[\uFE0F\u200D\u200C\u2640\u2642\u20E3\uFE0E]/g, "");
    var chars = Array.from(stripped);
    if (chars.length === 0 || chars.length > 4) return false;
    // 所有剩余字符须落在 emoji Unicode 区间内
    return chars.every(function (ch) {
      var code = ch.codePointAt(0);
      return (code >= 0x1F300 && code <= 0x1FAFF) ||  // 补充多语言平面 emoji
             (code >= 0x2600 && code <= 0x27BF) ||    // 杂项符号 & 丁贝符
             (code >= 0x2B50 && code <= 0x2BFF) ||    // 杂项符号和箭头（子集）
             (code >= 0x2300 && code <= 0x23FF);       // 杂项技术（⌚⌛等）
    });
  }

  /** 混合排序：文本字卡按拼音 A→Z 排序，emoji 追加其后，图片字卡追加末尾 */
  function sortCardsMixed(cards) {
    if (!window.MineUtils) return cards;
    var textCards = cards.filter(function (x) { return !isImageCard(x) && !isAudioCard(x) && !isEmojiCard(x); });
    var emojiCards = cards.filter(function (x) { return isEmojiCard(x); });
    var imgCards = cards.filter(function (x) { return isImageCard(x); });
    var audioCards = cards.filter(function (x) { return isAudioCard(x); });
    if (textCards.length > 1) textCards = window.MineUtils.sortByPinyin(textCards);
    return textCards.concat(emojiCards, imgCards, audioCards);
  }

  function firstChar(name) {
    return (name || "?").trim().charAt(0).toUpperCase() || "?";
  }

  /** 头像 HTML：有图用图，无图生成雾色首字 */
  function avatarHTML(contact, size, cls) {
    var s = size || 46;
    var c = (cls ? " " + cls : "");
    if (contact && contact.avatar) {
      return '<div class="avatar' + c + '" style="width:' + s + 'px;height:' + s + 'px;">' +
        '<img src="' + escapeHtml(contact.avatar) + '" alt=""></div>';
    }
    return '<div class="avatar avatar-gen' + c + '" style="width:' + s + 'px;height:' + s + 'px;">' +
      escapeHtml(firstChar(contact ? contact.name : "")) + '</div>';
  }

  /** 群头像：有自定义头像用之，否则取前 4 个成员叠放网格 */
  function groupAvatarHTML(group, size, cls) {
    var s = size || 46;
    var c = (cls ? " " + cls : "");

    // 自定义头像优先
    if (group && group.avatar) {
      return '<div class="group-avatar is-single' + c + '" style="width:' + s + 'px;height:' + s + 'px;overflow:hidden;">' +
        '<img src="' + escapeHtml(group.avatar) + '" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;"></div>';
    }

    var members = (group.members || []).map(findContact).filter(Boolean);
    if (members.length === 0) {
      return '<div class="group-avatar is-single' + c + '" style="width:' + s + 'px;height:' + s + 'px;">' +
        I.svg("users", 22) + '</div>';
    }
    if (members.length === 1) {
      return avatarHTML(members[0], s, "group-avatar is-single" + c);
    }
    var cells = "";
    for (var i = 0; i < 4; i++) {
      var m = members[i];
      if (m) {
        cells += '<div class="ga-cell">' + (m.avatar
          ? '<img src="' + escapeHtml(m.avatar) + '">'
          : escapeHtml(firstChar(m.name))) + '</div>';
      } else {
        cells += '<div class="ga-cell"></div>';
      }
    }
    return '<div class="group-avatar' + c + '" style="width:' + s + 'px;height:' + s + 'px;">' +
      '<div class="ga-grid">' + cells + '</div></div>';
  }

  function findContact(id) {
    for (var i = 0; i < state.contacts.length; i++)
      if (state.contacts[i].id === id) return state.contacts[i];
    return null;
  }
  function findContactByName(name) {
    if (!name) return null;
    for (var i = 0; i < state.contacts.length; i++)
      if (state.contacts[i].name === name) return state.contacts[i];
    return null;
  }
  function findGroup(id) {
    for (var i = 0; i < state.groups.length; i++)
      if (state.groups[i].id === id) return state.groups[i];
    return null;
  }

  /* ========================================================================
     视图栈
     ======================================================================== */
  var viewStack = [];   // 每项: { view, data }
  var pageEl = null;     // 通讯录页面容器

  function push(view, data) {
    viewStack.push({ view: view, data: data || {} });
    render();
  }
  function pop() {
    if (viewStack.length > 1) {
      viewStack.pop();
      render();
    } else {
      // 返回主屏
      if (window.MineApp && MineApp.goHome) MineApp.goHome();
    }
  }
  function resetTo(view, data) {
    viewStack = [{ view: view, data: data || {} }];
    render();
  }

  /* ---------------- 顶层导航栏 ---------------- */
  function navBar(opts) {
    var left = opts.left || '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>';
    var right = opts.right || '<span class="nav-right"></span>';
    return '<div class="nav-bar">' +
      '<span class="nav-left">' + left + '</span>' +
      '<span class="nav-title">' + escapeHtml(opts.title) + '</span>' +
      right + '</div>';
  }

  /* ========================================================================
     视图 1 · 联系人列表（主页）
     ======================================================================== */
  function viewList() {
    var html = navBar({
      title: "通讯录",
      right: '<span class="nav-right">' +
        '<button class="nav-btn" data-act="add">' + I.svg("userPlus", 20) + '</button></span>'
    });

    html += '<div class="scroll contacts-scroll">';

    // 功能入口
    html +=
      '<div class="func-row" role="button" tabindex="0" data-act="group-create">' +
        '<div class="func-icon">' + I.svg("users", 20) + '</div>' +
        '<div class="func-text"><span class="func-title">发起群聊</span>' +
        '<span class="func-sub">选择联系人拉入新群</span></div>' +
      '</div>';
    html += '<div class="list-sep"></div>';

    // 群聊区
    if (state.groups.length) {
      html += '<div class="group-head">群聊 <span class="count">' + state.groups.length + '</span></div>';
      state.groups.forEach(function (g) {
        html += groupRowHTML(g);
      });
      html += '<div class="list-sep"></div>';
    }

    // 联系人区
    if (state.contacts.length === 0) {
      html += emptyContactsHTML();
    } else {
      html += '<div class="group-head">联系人 <span class="count">' + state.contacts.length + '</span></div>';
      state.contacts.forEach(function (c) {
        html += contactRowHTML(c);
      });
    }

    html += '</div>';
    return html;
  }

  function contactRowHTML(c) {
    var onlineCls = c.status ? "" : " is-online";
    var statusText = c.status || "在线";
    return '<div class="contact-row" role="button" tabindex="0" data-act="detail" data-id="' + c.id + '">' +
      avatarHTML(c, 46) +
      '<div class="contact-info">' +
        '<span class="contact-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="contact-status' + onlineCls + '">' + escapeHtml(statusText) + '</span>' +
      '</div>' +
      '<button class="contact-call-btn" data-call="' + c.id + '" title="呼叫 ' + escapeHtml(c.name) + '">' +
        I.svg("phone", 17) + '</button>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';
  }

  function groupRowHTML(g) {
    var count = (g.members || []).length + 1;
    return '<div class="contact-row" role="button" tabindex="0" data-act="group-detail" data-id="' + g.id + '">' +
      groupAvatarHTML(g, 46) +
      '<div class="contact-info">' +
        '<span class="contact-name">' + escapeHtml(g.name) + '</span>' +
        '<span class="contact-status">' + count + ' 位成员</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';
  }

  function emptyContactsHTML() {
    return '<div class="contacts-empty">' +
      '<div class="ce-icon">' + I.svg("userPlus", 26) + '</div>' +
      '<div class="ce-title">还没有联系人</div>' +
      '<div class="ce-desc">点击右上角添加第一位联系人</div>' +
      '</div>';
  }

  /* ---------------- 回复延迟标签 ---------------- */
  function formatDelayLabel(sec) {
    sec = parseFloat(sec) || 0;
    if (sec === 0) return "立即回复";
    if (sec < 60) return sec + " 秒";
    var m = Math.floor(sec / 60);
    var s = Math.round(sec % 60);
    if (s === 0) return m + " 分钟";
    return m + " 分 " + s + " 秒";
  }

  /** 主动发消息间隔标签（分钟 → "X 分钟" / "X 小时" / "X 小时 Y 分"） */
  function formatProactiveLabel(min) {
    min = parseInt(min, 10) || 0;
    if (min < 60) return min + " 分钟";
    var h = Math.floor(min / 60);
    var m = min % 60;
    if (m === 0) return h + " 小时";
    return h + " 小时 " + m + " 分";
  }

  /* ========================================================================
     视图 · 联系人主页（信息 + 字卡管理 + 聊天入口）
     ======================================================================== */
  function viewProfile(data) {
    var c = findContact(data.id);
    // 若 ID 查找失败，尝试按名称查找
    if (!c && data.name) {
      c = findContactByName(data.name);
    }
    if (!c) { resetTo("list"); return ""; }

    var left = '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>';
    var right = '<span class="nav-right">' +
      '<button class="nav-btn" data-act="edit">' + I.svg("pencil", 20) + '</button></span>';
    var html = navBar({ title: c.name, left: left, right: right });

    html += '<div class="scroll">';

    // 头部信息
    html += '<div class="profile-hero">' +
      '<div class="avatar-picker">' +
        '<div class="avatar big-avatar profile-avatar" id="profile-avatar" style="position:relative;cursor:pointer;">' +
          (c.avatar
            ? '<img src="' + escapeHtml(c.avatar) + '">'
            : '<span class="avatar-gen-text">' + escapeHtml(firstChar(c.name)) + '</span>') +
          '<div class="cam-badge">' + I.svg("camera", 15) + '</div>' +
        '</div>' +
        '<input type="file" accept="image/*" id="profile-avatar-file" class="file-hidden">' +
      '</div>' +
      '<span class="profile-name">' + escapeHtml(c.name) + '</span>' +
      '<span class="profile-status">' + escapeHtml(c.status || "在线") + '</span>' +
      '</div>';

    // 聊天 / 语音通话按钮
    html += '<div class="profile-actions-row">' +
      '<button class="btn btn-primary" data-act="chat">' +
      I.svg("chat", 18) + ' 发消息</button>' +
      '<button class="btn btn-primary" data-act="call">' +
      I.svg("phone", 18) + ' 语音通话</button>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 搜索聊天记录入口
    html += '<div class="func-row" role="button" tabindex="0" data-act="search-history">' +
      '<div class="func-icon">' + I.svg("search", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">搜索聊天记录</span>' +
        '<span class="func-sub">查找与 ' + escapeHtml(c.name) + ' 的聊天内容</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 状态管理入口
    html += '<div class="func-row" role="button" tabindex="0" data-act="status-edit">' +
      '<div class="func-icon">' + I.svg("refresh", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">状态管理</span>' +
        '<span class="func-sub">' + escapeHtml(c.status || "在线") +
        ' · ' + (c.statuses || []).length + ' 个状态</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 朋友圈入口
    html += '<div class="func-row" role="button" tabindex="0" data-act="contact-moments">' +
      '<div class="func-icon">' + I.svg("moments", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">朋友圈</span>' +
        '<span class="func-sub">' + ((c.momentCards || []).length) + ' 条字卡 · 查看与编辑</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 回复设置区
    var delaySec = c.replyDelay !== undefined ? c.replyDelay : 1.5;
    var delayLabel = formatDelayLabel(delaySec);
    html += '<div class="group-head">回复设置</div>';
    html += '<div class="reply-settings">' +
      '<div class="reply-setting-row">' +
        '<div class="reply-setting-info">' +
          '<span class="func-title">回复延迟</span>' +
          '<span class="func-sub" id="reply-delay-label">' + delayLabel + '</span>' +
        '</div>' +
        '<div class="slider-wrap">' +
          '<input type="range" class="fog-slider" id="reply-delay-slider" ' +
          'min="0" max="600" step="1" value="' + (delaySec * 1) + '">' +
        '</div>' +
      '</div>' +
      '<div class="reply-hint">1% 概率触发自动回复 · 回复时间在 0 ~ 设定值内随机 · 拖动调节 0 秒 ~ 10 分钟</div>';

    // 主动消息设置（对方主动发消息的时间区间，1 分钟 ~ 12 小时，始终开启）
    var proMin = (c.proactiveMin !== undefined) ? c.proactiveMin : 1;
    var proMax = (c.proactiveMax !== undefined) ? c.proactiveMax : 720;
    var proStateLabel = "已开启 · " + formatProactiveLabel(proMin) + " ~ " + formatProactiveLabel(proMax);
    html += '<div class="reply-setting-row proactive-head-row">' +
      '<div class="reply-setting-info">' +
        '<span class="func-title">主动消息</span>' +
        '<span class="func-sub" id="proactive-state-label">' + proStateLabel + '</span>' +
      '</div>' +
      '</div>' +
      '<div id="proactive-sliders">' +
      '<div class="reply-setting-row">' +
        '<div class="reply-setting-info">' +
          '<span class="func-title">最短间隔</span>' +
          '<span class="func-sub" id="proactive-min-label">' + formatProactiveLabel(proMin) + '</span>' +
        '</div>' +
        '<div class="slider-wrap">' +
          '<input type="range" class="fog-slider" id="proactive-min-slider" ' +
          'min="1" max="720" step="1" value="' + proMin + '">' +
        '</div>' +
      '</div>' +
      '<div class="reply-setting-row">' +
        '<div class="reply-setting-info">' +
          '<span class="func-title">最长间隔</span>' +
          '<span class="func-sub" id="proactive-max-label">' + formatProactiveLabel(proMax) + '</span>' +
        '</div>' +
        '<div class="slider-wrap">' +
          '<input type="range" class="fog-slider" id="proactive-max-slider" ' +
          'min="1" max="720" step="1" value="' + proMax + '">' +
        '</div>' +
      '</div>' +
      '<div class="reply-hint">对方会在区间内随机时间主动发消息 · 发送后重新计时 · 群聊中每个成员独立计算 · 拖动调节 1 分钟 ~ 12 小时</div>' +
      '</div>';
    html += '</div>';

    html += '<div class="list-sep"></div>';

    // 自动回复字卡区
    html += '<div class="group-head">自动回复字卡 <span class="count" id="autocard-count">' + (c.autoCards || []).length + '</span>';
    if ((c.autoCards || []).length > 0) {
      html += '<button class="batch-toggle-btn" data-act="toggle-autocard-batch">' + I.svg("trash", 14) + ' 批量删除</button>';
    }
    html += '</div>';
    html += '<div class="cards-section" id="autocards-section">';
    html += renderAutoCardsList(c, false);
    html += '</div>';

    // 自动回复字卡批量操作工具栏（默认隐藏）
    html += '<div class="batch-toolbar" id="autocard-batch-toolbar" style="display:none;">' +
      '<button class="btn btn-sm" data-act="autocard-select-all">全选</button>' +
      '<span class="batch-count" id="autocard-batch-count">未选</span>' +
      '<button class="btn btn-sm btn-danger" data-act="delete-autocard-batch" disabled>删除选中</button>' +
      '<button class="btn btn-sm" data-act="exit-autocard-batch">完成</button>' +
      '</div>';

    // 添加自动回复字卡输入
    html += '<div class="card-add-row">' +
      '<input type="text" class="field-input card-add-input" id="autocard-add-text" ' +
      'placeholder="输入自动回复字卡，空格分隔可批量添加… 自动去重">' +
      '<button class="btn card-add-btn" data-act="add-autocard">' + I.svg("plus", 18) + '</button>' +
      '</div>';

    html += '<div class="card-hint">1% 不回复时自动发送 · 标记「自动回复」· 空格分隔批量添加 · 自动去重 · A→Z 排序</div>';

    html += '<div class="list-sep"></div>';

    // 字卡区
    var _cardCount  = (c.cards || []).length;
    var _textCount  = (c.cards || []).filter(function(x) { return !isImageCard(x) && !isAudioCard(x) && !isEmojiCard(x); }).length;
    var _emojiCount = (c.cards || []).filter(function(x) { return isEmojiCard(x); }).length;
    var _imgCount   = (c.cards || []).filter(function(x) { return isImageCard(x); }).length;
    var _audioCount = (c.cards || []).filter(function(x) { return isAudioCard(x); }).length;
    html += '<div class="group-head">字卡 <span class="count">' + _cardCount + '</span>';
    html += '<button class="card-toggle-btn" data-act="toggle-cards">' + I.svg("plus", 18) + '</button>';
    if (_cardCount > 0) {
      html += '<button class="batch-toggle-btn" data-act="toggle-batch" style="display:none;">' + I.svg("trash", 14) + ' 批量删除</button>';
    }
    html += '</div>';

    // 字卡类型弹窗（点击 + 时显示）
    html += '<div class="card-type-popup" id="card-type-popup">' +
      '<button class="card-type-option" data-type="text">' + I.svg("feather", 20) +
      '<span>字符</span><span class="card-type-count">' + _textCount + '</span></button>' +
      '<button class="card-type-option" data-type="emoji">' + I.svg("smile", 20) +
      '<span>emoji</span><span class="card-type-count">' + _emojiCount + '</span></button>' +
      '<button class="card-type-option" data-type="image">' + I.svg("image", 20) +
      '<span>图片</span><span class="card-type-count">' + _imgCount + '</span></button>' +
      '<button class="card-type-option" data-type="audio">' + I.svg("mic", 20) +
      '<span>语音</span><span class="card-type-count">' + _audioCount + '</span></button>' +
      '</div>';

    // 字卡列表（默认折叠）
    html += '<div class="cards-section" id="cards-section" style="display:none;">';
    html += renderCardsList(c, false, null);
    html += '</div>';

    // 批量操作工具栏（默认隐藏）
    html += '<div class="batch-toolbar" id="batch-toolbar" style="display:none;">' +
      '<button class="btn btn-sm" data-act="select-all">全选</button>' +
      '<span class="batch-count" id="batch-count">未选</span>' +
      '<button class="btn btn-sm btn-danger" data-act="delete-batch" disabled>删除选中</button>' +
      '<button class="btn btn-sm" data-act="exit-batch">完成</button>' +
      '</div>';

    // 文本添加行（仅字符模式显示）
    html += '<div class="card-add-row" id="card-text-add-row" style="display:none;">' +
      '<input type="text" class="field-input card-add-input" id="card-add-text" ' +
      'placeholder="输入字卡，空格分隔批量添加 · 回车确认">' +
      '</div>';

    // emoji 添加行（仅 emoji 模式显示）
    html += '<div class="card-add-row" id="card-emoji-add-row" style="display:none;">' +
      '<input type="text" class="field-input card-add-input" id="card-add-emoji" ' +
      'placeholder="输入 emoji，如 😊🎉🍃 · 回车确认">' +
      '</div>';

    // 图片添加行（仅图片模式显示）
    html += '<div class="card-add-row" id="card-image-add-row" style="display:none;">' +
      '<button class="btn card-image-add-btn" id="card-image-add-btn">' + I.svg("image", 18) + ' 选择图片</button>' +
      '</div>';

    // 语音添加行（仅语音模式显示）
    html += '<div class="card-add-row" id="card-audio-add-row" style="display:none;">' +
      '<button class="btn card-image-add-btn" id="card-audio-add-btn">' + I.svg("mic", 18) + ' 选择语音文件</button>' +
      '</div>';

    // 隐藏文件选择器
    html += '<input type="file" accept="image/*" id="card-image-file" style="display:none" multiple>';
    html += '<input type="file" accept="audio/*" id="card-audio-file" style="display:none" multiple>';

    html += '<div class="card-hint">点击 + 展开字卡 · 选择字符 / emoji / 图片 / 语音 · 字符回车添加 · 图片语音可多选</div>';

    html += '<div class="list-sep"></div>';
    html += '<div style="padding:var(--sp-6) var(--sp-5);">' +
      '<button class="btn btn-block btn-danger" data-act="delete-contact">' +
      I.svg("trash", 18) + ' 删除联系人</button></div>';

    html += '</div>';
    return html;
  }

  function renderCardsList(c, batchMode, typeFilter) {
    var cards = c.cards || [];
    if (cards.length === 0) {
      return '<div class="cards-empty">暂无字卡，添加后对方才能回复你</div>';
    }
    var html = "";
    cards.forEach(function (text, i) {
      var isImg = isImageCard(text);
      var isAud = isAudioCard(text);
      var isEmoji = isEmojiCard(text);
      // 类型过滤：text = 仅文字，emoji = 仅 emoji，image = 仅图片，audio = 仅语音
      if (typeFilter === "text" && (isImg || isAud || isEmoji)) return;
      if (typeFilter === "emoji" && !isEmoji) return;
      if (typeFilter === "image" && !isImg) return;
      if (typeFilter === "audio" && !isAud) return;
      var cardCls = isImg ? ' card-image-item' : (isEmoji ? ' card-emoji-item' : '');
      var inner = isImg
        ? '<img class="card-image-thumb" src="' + escapeHtml(text) + '" alt="图片字卡">'
        : (isAud
          ? MineVoiceBar.html(text, "vb-full")
          : (isEmoji
            ? '<span class="card-emoji">' + escapeHtml(text) + '</span>'
            : '<span class="card-text">' + escapeHtml(text) + '</span>'));
      if (batchMode) {
        html += '<div class="card-item card-selectable' + cardCls + '" data-card-idx="' + i + '">' +
          '<span class="card-check">' + I.svg("check", 14) + '</span>' + inner + '</div>';
      } else {
        html += '<div class="card-item' + cardCls + '">' + inner +
          '<button class="card-del" data-del="' + i + '">' + I.svg("close", 14) + '</button>' +
          '</div>';
      }
    });
    if (!html) {
      if (typeFilter === "text") return '<div class="cards-empty">暂无字符字卡</div>';
      if (typeFilter === "emoji") return '<div class="cards-empty">暂无 emoji 字卡，输入 emoji 添加</div>';
      if (typeFilter === "image") return '<div class="cards-empty">暂无图片字卡，点击「选择图片」添加</div>';
      if (typeFilter === "audio") return '<div class="cards-empty">暂无语音字卡，点击「选择语音文件」添加</div>';
    }
    return html;
  }

  function renderAutoCardsList(c, batchMode) {
    var cards = c.autoCards || [];
    if (cards.length === 0) {
      return '<div class="cards-empty">暂无自动回复字卡，1% 不回复时将保持沉默</div>';
    }
    var html = "";
    cards.forEach(function (text, i) {
      if (batchMode) {
        html += '<div class="card-item card-selectable" data-autocard-idx="' + i + '">' +
          '<span class="card-check">' + I.svg("check", 14) + '</span>' +
          '<span class="card-text">' + escapeHtml(text) + '</span>' +
          '</div>';
      } else {
        html += '<div class="card-item autocard-item">' +
          '<span class="card-text">' + escapeHtml(text) + '</span>' +
          '<button class="card-del" data-del-autocard="' + i + '">' + I.svg("close", 14) + '</button>' +
          '</div>';
      }
    });
    return html;
  }

  function bindProfile(data) {
    var c = findContact(data.id);
    if (!c) return;

    // 编辑
    pageEl.querySelector('[data-act="edit"]').addEventListener("click", function () {
      push("edit", { id: data.id });
    });

    // 删除联系人
    var delContactBtn = pageEl.querySelector('[data-act="delete-contact"]');
    if (delContactBtn) delContactBtn.addEventListener("click", function () {
      if (!confirm("确定删除「" + c.name + "」？此操作不可撤销。")) return;
      state.contacts = state.contacts.filter(function (x) { return x.id !== data.id; });
      state.groups.forEach(function (g) {
        g.members = (g.members || []).filter(function (mid) { return mid !== data.id; });
      });
      save();
      resetTo("list");
    });

    // 聊天
    pageEl.querySelector('[data-act="chat"]').addEventListener("click", function () {
      if (window.MineChat) MineChat.openContact(data.id);
    });
    // 语音通话
    var callBtn = pageEl.querySelector('[data-act="call"]');
    if (callBtn) callBtn.addEventListener("click", function () {
      if (window.MinePhone) MinePhone.callContact(data.id);
    });

    // 搜索聊天记录
    pageEl.querySelector('[data-act="search-history"]').addEventListener("click", function () {
      push("search-history", { type: "contact", id: data.id, name: c.name });
    });

    // 状态管理
    pageEl.querySelector('[data-act="status-edit"]').addEventListener("click", function () {
      push("status-edit", { id: data.id });
    });

    // 朋友圈
    var cmBtn = pageEl.querySelector('[data-act="contact-moments"]');
    if (cmBtn) {
      cmBtn.addEventListener("click", function () {
        if (window.MineContactMoments) {
          MineContactMoments.open(c.id);
        }
      });
    }

    // 头像直接上传（profile 页）
    var pAvatar = pageEl.querySelector("#profile-avatar");
    var pFile = pageEl.querySelector("#profile-avatar-file");
    if (pAvatar && pFile) {
      pAvatar.addEventListener("click", function () { pFile.click(); });
      pFile.addEventListener("change", function () {
        if (this.files && this.files[0]) {
          var f = this.files[0];
          window.MineUtils.compressImage(f, 200, 0.85, function (dataURL) {
            if (!dataURL) return;
            c.avatar = dataURL;
            save();
            // 更新头像显示
            pAvatar.innerHTML = '<img src="' + dataURL + '">' +
              '<div class="cam-badge">' + I.svg("camera", 15) + '</div>';
          });
          this.value = "";
        }
      });
    }

    // 回复延迟滑块
    var delaySlider = pageEl.querySelector("#reply-delay-slider");
    var delayLabel = pageEl.querySelector("#reply-delay-label");
    if (delaySlider && delayLabel) {
      delaySlider.addEventListener("input", function () {
        var val = parseFloat(this.value);
        delayLabel.textContent = formatDelayLabel(val);
      });
      delaySlider.addEventListener("change", function () {
        c.replyDelay = parseFloat(this.value);
        save();
      });
    }

    // 主动消息间隔设置（始终开启，仅保留最短/最长间隔滑块）
    (function () {
      var proState = pageEl.querySelector("#proactive-state-label");
      var proMinS = pageEl.querySelector("#proactive-min-slider");
      var proMaxS = pageEl.querySelector("#proactive-max-slider");
      var proMinL = pageEl.querySelector("#proactive-min-label");
      var proMaxL = pageEl.querySelector("#proactive-max-label");

      // 设置变更后通知聊天模块刷新调度
      var proNotifyChat = function () {
        if (window.MineChat && MineChat.refreshProactive) MineChat.refreshProactive();
      };
      // 刷新"主动消息"行状态标签（始终已开启）
      var proRefreshState = function () {
        if (!proState) return;
        proState.textContent = "已开启 · " + formatProactiveLabel(c.proactiveMin) + " ~ " + formatProactiveLabel(c.proactiveMax);
      };

      // 最短间隔滑块（不超过最长间隔）
      if (proMinS) {
        proMinS.addEventListener("input", function () {
          var v = parseInt(this.value, 10);
          if (c.proactiveMax !== undefined && v > c.proactiveMax) {
            c.proactiveMax = v;
            if (proMaxS) proMaxS.value = v;
            if (proMaxL) proMaxL.textContent = formatProactiveLabel(v);
          }
          c.proactiveMin = v;
          if (proMinL) proMinL.textContent = formatProactiveLabel(v);
          proRefreshState();
        });
        proMinS.addEventListener("change", function () {
          save();
          proNotifyChat();
        });
      }

      // 最长间隔滑块（不低于最短间隔）
      if (proMaxS) {
        proMaxS.addEventListener("input", function () {
          var v = parseInt(this.value, 10);
          if (c.proactiveMin !== undefined && v < c.proactiveMin) {
            c.proactiveMin = v;
            if (proMinS) proMinS.value = v;
            if (proMinL) proMinL.textContent = formatProactiveLabel(v);
          }
          c.proactiveMax = v;
          if (proMaxL) proMaxL.textContent = formatProactiveLabel(v);
          proRefreshState();
        });
        proMaxS.addEventListener("change", function () {
          save();
          proNotifyChat();
        });
      }
    })();

    // 添加字卡（空格分割批量添加 + 拼音排序）
    var addInput = pageEl.querySelector("#card-add-text");
    var toggleBtn = pageEl.querySelector('[data-act="toggle-cards"]');
    var cardTypePopup = pageEl.querySelector("#card-type-popup");
    var cardImageFile = pageEl.querySelector("#card-image-file");
    var imageAddBtn = pageEl.querySelector("#card-image-add-btn");
    var batchSelected = {};  // 批量选中状态 { idx: true }
    var cardViewMode = null;  // null=折叠, "text"=字符, "emoji"=emoji, "image"=图片

    function refreshCards(batchMode) {
      pageEl.querySelector("#cards-section").innerHTML = renderCardsList(c, batchMode, cardViewMode);
      var head = pageEl.querySelector(".group-head .count");
      if (head) head.textContent = (c.cards || []).length;
      // 更新弹窗里的计数
      var _tc = (c.cards || []).filter(function(x) { return !isImageCard(x) && !isAudioCard(x) && !isEmojiCard(x); }).length;
      var _ec = (c.cards || []).filter(function(x) { return isEmojiCard(x); }).length;
      var _ic = (c.cards || []).filter(function(x) { return isImageCard(x); }).length;
      var _ac = (c.cards || []).filter(function(x) { return isAudioCard(x); }).length;
      var counts = pageEl.querySelectorAll(".card-type-count");
      if (counts[0]) counts[0].textContent = _tc;
      if (counts[1]) counts[1].textContent = _ec;
      if (counts[2]) counts[2].textContent = _ic;
      if (counts[3]) counts[3].textContent = _ac;
      if (batchMode) {
        bindBatchCards();
      } else {
        bindCardDels(data);
      }
    }

    function doAddCard() {
      var text = (addInput.value || "").trim();
      if (!text) return;
      if (!c.cards) c.cards = [];
      var newCards = text.split(/\s+/).filter(function (s) { return s.length > 0; });
      if (window.MineUtils) {
        newCards = window.MineUtils.deduplicateCards(newCards);
      } else {
        var _seen = {}; newCards = newCards.filter(function (x) {
          if (_seen[x]) return false; _seen[x] = true; return true;
        });
      }
      newCards = newCards.filter(function (card) {
        return c.cards.indexOf(card) < 0;
      });
      if (newCards.length === 0) {
        addInput.value = "";
        addInput.focus();
        return;
      }
      c.cards = c.cards.concat(newCards);
      c.cards = sortCardsMixed(c.cards);
      addInput.value = "";
      save();
      var toolbar = pageEl.querySelector("#batch-toolbar");
      if (toolbar && toolbar.style.display !== "none") {
        exitBatchMode();
      } else {
        refreshCards(false);
      }
      addInput.focus();
    }

    /* -------- 折叠 / 展开 -------- */
    function showCardTypePopup() { if (cardTypePopup) cardTypePopup.classList.add("is-show"); }
    function hideCardTypePopup() { if (cardTypePopup) cardTypePopup.classList.remove("is-show"); }

    function expandCardView(type) {
      cardViewMode = type;
      hideCardTypePopup();
      // 显示字卡列表
      var cs = pageEl.querySelector("#cards-section");
      if (cs) cs.style.display = "";
      // 显示对应的添加行
      var tr = pageEl.querySelector("#card-text-add-row");
      var er = pageEl.querySelector("#card-emoji-add-row");
      var ir = pageEl.querySelector("#card-image-add-row");
      var ar = pageEl.querySelector("#card-audio-add-row");
      if (tr) tr.style.display = (type === "text") ? "" : "none";
      if (er) er.style.display = (type === "emoji") ? "" : "none";
      if (ir) ir.style.display = (type === "image") ? "" : "none";
      if (ar) ar.style.display = (type === "audio") ? "" : "none";
      // 显示批量删除按钮（仅当该类型有字卡时）
      var batchBtn = pageEl.querySelector('[data-act="toggle-batch"]');
      if (batchBtn) {
        var filteredCount = (c.cards || []).filter(function(x) {
          if (type === "text") return !isImageCard(x) && !isAudioCard(x) && !isEmojiCard(x);
          if (type === "emoji") return isEmojiCard(x);
          if (type === "audio") return isAudioCard(x);
          return isImageCard(x);
        }).length;
        batchBtn.style.display = filteredCount > 0 ? "" : "none";
      }
      // 切换按钮图标 → minus
      if (toggleBtn) toggleBtn.innerHTML = I.svg("minus", 18);
      refreshCards(false);
      if (type === "text" && addInput) addInput.focus();
      if (type === "emoji") {
        var emojiInput = pageEl.querySelector("#card-add-emoji");
        if (emojiInput) emojiInput.focus();
      }
    }

    function collapseCardView() {
      cardViewMode = null;
      hideCardTypePopup();
      var cs = pageEl.querySelector("#cards-section");
      if (cs) cs.style.display = "none";
      var tr = pageEl.querySelector("#card-text-add-row");
      var er = pageEl.querySelector("#card-emoji-add-row");
      var ir = pageEl.querySelector("#card-image-add-row");
      var ar = pageEl.querySelector("#card-audio-add-row");
      if (tr) tr.style.display = "none";
      if (er) er.style.display = "none";
      if (ir) ir.style.display = "none";
      if (ar) ar.style.display = "none";
      var tb = pageEl.querySelector("#batch-toolbar");
      if (tb) tb.style.display = "none";
      var batchBtn = pageEl.querySelector('[data-act="toggle-batch"]');
      if (batchBtn) batchBtn.style.display = "none";
      if (toggleBtn) toggleBtn.innerHTML = I.svg("plus", 18);
    }

    // "+" 按钮：折叠态→弹窗，展开态→折叠
    if (toggleBtn) toggleBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (cardViewMode !== null) {
        collapseCardView();
      } else {
        showCardTypePopup();
      }
    });
    // 点击弹窗外关闭
    document.addEventListener("click", function (e) {
      if (!cardTypePopup || !cardTypePopup.classList.contains("is-show")) return;
      if (!cardTypePopup.contains(e.target) && !(toggleBtn && toggleBtn.contains(e.target))) hideCardTypePopup();
    });
    // 弹窗选项 → 展开
    if (cardTypePopup) {
      cardTypePopup.querySelectorAll(".card-type-option").forEach(function (opt) {
        opt.addEventListener("click", function () {
          var type = opt.getAttribute("data-type");
          expandCardView(type);
        });
      });
    }
    // 图片添加按钮 → 打开文件选择
    if (imageAddBtn) {
      imageAddBtn.addEventListener("click", function () {
        if (cardImageFile) cardImageFile.click();
      });
    }
    // 图片文件选择 → 压缩并添加图片字卡
    if (cardImageFile) {
      cardImageFile.addEventListener("change", function () {
        var files = this.files;
        if (!files || files.length === 0) return;
        if (!c.cards) c.cards = [];
        var processed = 0;
        var total = files.length;
        Array.prototype.forEach.call(files, function (f) {
          window.MineUtils.compressImage(f, 400, 0.85, function (dataURL) {
            if (dataURL && c.cards.indexOf(dataURL) < 0) c.cards.push(dataURL);
            processed++;
            if (processed === total) {
              c.cards = sortCardsMixed(c.cards);
              save();
              // 更新计数
              var head = pageEl.querySelector(".group-head .count");
              if (head) head.textContent = c.cards.length;
              var tb = pageEl.querySelector("#batch-toolbar");
              if (tb && tb.style.display !== "none") exitBatchMode();
              else refreshCards(false);
              // 更新批量按钮可见性
              var batchBtn = pageEl.querySelector('[data-act="toggle-batch"]');
              if (batchBtn && cardViewMode === "image") {
                var ic = c.cards.filter(function(x) { return isImageCard(x); }).length;
                batchBtn.style.display = ic > 0 ? "" : "none";
              }
            }
          });
        });
        this.value = "";
      });
    }

    /* -------- 语音字卡添加（audio 文件 → dataURL） -------- */
    var cardAudioFile = pageEl.querySelector("#card-audio-file");
    var audioAddBtn = pageEl.querySelector("#card-audio-add-btn");
    if (audioAddBtn) {
      audioAddBtn.addEventListener("click", function () {
        if (cardAudioFile) cardAudioFile.click();
      });
    }
    if (cardAudioFile) {
      cardAudioFile.addEventListener("change", function () {
        var files = this.files;
        if (!files || files.length === 0) return;
        if (!c.cards) c.cards = [];
        var processed = 0;
        var total = files.length;
        Array.prototype.forEach.call(files, function (f) {
          if (!f.type || f.type.indexOf("audio/") !== 0) { processed++; checkDone(); return; }
          var reader = new FileReader();
          reader.onload = function () {
            var dataURL = reader.result;
            if (dataURL && c.cards.indexOf(dataURL) < 0) c.cards.push(dataURL);
            processed++;
            checkDone();
          };
          reader.onerror = function () { processed++; checkDone(); };
          reader.readAsDataURL(f);
        });
        function checkDone() {
          if (processed !== total) return;
          c.cards = sortCardsMixed(c.cards);
          save();
          var head = pageEl.querySelector(".group-head .count");
          if (head) head.textContent = c.cards.length;
          var tb = pageEl.querySelector("#batch-toolbar");
          if (tb && tb.style.display !== "none") exitBatchMode();
          else refreshCards(false);
        }
        this.value = "";
      });
    }

    if (addInput) addInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doAddCard(); }
    });

    /* -------- emoji 字卡添加（按字符分割，自动去重） -------- */
    var emojiInput = pageEl.querySelector("#card-add-emoji");
    function doAddEmojiCard() {
      var text = (emojiInput.value || "").trim();
      if (!text) return;
      if (!c.cards) c.cards = [];
      // 按字符分割（emoji 可能是多字节，用 Array.from）
      var newCards = Array.from(text).map(function (ch) { return ch.trim(); }).filter(function (s) { return s.length > 0; });
      // 去重
      if (window.MineUtils) {
        newCards = window.MineUtils.deduplicateCards(newCards);
      } else {
        var _seen = {}; newCards = newCards.filter(function (x) {
          if (_seen[x]) return false; _seen[x] = true; return true;
        });
      }
      newCards = newCards.filter(function (card) {
        return c.cards.indexOf(card) < 0;
      });
      if (newCards.length === 0) {
        emojiInput.value = "";
        emojiInput.focus();
        return;
      }
      c.cards = c.cards.concat(newCards);
      c.cards = sortCardsMixed(c.cards);
      emojiInput.value = "";
      save();
      var toolbar = pageEl.querySelector("#batch-toolbar");
      if (toolbar && toolbar.style.display !== "none") {
        exitBatchMode();
      } else {
        refreshCards(false);
      }
      emojiInput.focus();
    }
    if (emojiInput) emojiInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doAddEmojiCard(); }
    });

    /* -------- 批量删除模式 -------- */
    function updateBatchUI() {
      var count = Object.keys(batchSelected).length;
      var total = (c.cards || []).length;
      var countEl = pageEl.querySelector("#batch-count");
      if (countEl) countEl.textContent = count > 0 ? "已选 " + count + " 项" : "未选";
      var delBtn = pageEl.querySelector('[data-act="delete-batch"]');
      if (delBtn) delBtn.disabled = count === 0;
      var selAllBtn = pageEl.querySelector('[data-act="select-all"]');
      if (selAllBtn) selAllBtn.textContent = count === total && total > 0 ? "取消全选" : "全选";
    }

    function bindBatchCards() {
      pageEl.querySelectorAll(".card-selectable").forEach(function (item) {
        item.addEventListener("click", function () {
          var idx = parseInt(item.getAttribute("data-card-idx"), 10);
          if (batchSelected[idx]) {
            delete batchSelected[idx];
            item.classList.remove("is-selected");
          } else {
            batchSelected[idx] = true;
            item.classList.add("is-selected");
          }
          updateBatchUI();
        });
      });
    }

    function enterBatchMode() {
      var toolbar = pageEl.querySelector("#batch-toolbar");
      if (toolbar) toolbar.style.display = "flex";
      batchSelected = {};
      refreshCards(true);
      updateBatchUI();
    }

    function exitBatchMode() {
      var toolbar = pageEl.querySelector("#batch-toolbar");
      if (toolbar) toolbar.style.display = "none";
      batchSelected = {};
      refreshCards(false);
    }

    // 批量删除按钮
    var toggleBatchBtn = pageEl.querySelector('[data-act="toggle-batch"]');
    if (toggleBatchBtn) toggleBatchBtn.addEventListener("click", enterBatchMode);
    var exitBatchBtn = pageEl.querySelector('[data-act="exit-batch"]');
    if (exitBatchBtn) exitBatchBtn.addEventListener("click", exitBatchMode);

    // 全选/取消全选
    var selAllBtn = pageEl.querySelector('[data-act="select-all"]');
    if (selAllBtn) selAllBtn.addEventListener("click", function () {
      var total = (c.cards || []).length;
      var allSelected = Object.keys(batchSelected).length === total && total > 0;
      if (allSelected) {
        batchSelected = {};
      } else {
        batchSelected = {};
        for (var i = 0; i < total; i++) batchSelected[i] = true;
      }
      refreshCards(true);
      // 恢复选中状态
      pageEl.querySelectorAll(".card-selectable").forEach(function (item) {
        var idx = parseInt(item.getAttribute("data-card-idx"), 10);
        if (batchSelected[idx]) item.classList.add("is-selected");
      });
      updateBatchUI();
    });

    // 删除选中
    var delBatchBtn = pageEl.querySelector('[data-act="delete-batch"]');
    if (delBatchBtn) delBatchBtn.addEventListener("click", function () {
      var indices = Object.keys(batchSelected).map(Number).sort(function (a, b) { return b - a; });
      if (indices.length === 0) return;
      // 从后往前删除，避免索引偏移
      indices.forEach(function (idx) {
        c.cards.splice(idx, 1);
      });
      save();
      exitBatchMode();
    });

    /* -------- 自动回复字卡管理 -------- */
    var acAddInput = pageEl.querySelector("#autocard-add-text");
    var acAddBtn = pageEl.querySelector('[data-act="add-autocard"]');
    var acBatchSelected = {};

    function refreshAutoCards(batchMode) {
      pageEl.querySelector("#autocards-section").innerHTML = renderAutoCardsList(c, batchMode);
      var head = pageEl.querySelector("#autocard-count");
      if (head) head.textContent = (c.autoCards || []).length;
      if (batchMode) {
        bindAutoCardBatch();
      } else {
        bindAutoCardDels(data);
      }
    }

    function doAddAutoCard() {
      var text = (acAddInput.value || "").trim();
      if (!text) return;
      if (!c.autoCards) c.autoCards = [];
      var newCards = text.split(/\s+/).filter(function (s) { return s.length > 0; });
      if (window.MineUtils) {
        newCards = window.MineUtils.deduplicateCards(newCards);
      } else {
        var _seen = {}; newCards = newCards.filter(function (x) {
          if (_seen[x]) return false; _seen[x] = true; return true;
        });
      }
      newCards = newCards.filter(function (card) {
        return c.autoCards.indexOf(card) < 0;
      });
      if (newCards.length === 0) {
        acAddInput.value = "";
        acAddInput.focus();
        return;
      }
      c.autoCards = c.autoCards.concat(newCards);
      if (window.MineUtils) {
        c.autoCards = window.MineUtils.sortByPinyin(c.autoCards);
      }
      acAddInput.value = "";
      save();
      var toolbar = pageEl.querySelector("#autocard-batch-toolbar");
      if (toolbar && toolbar.style.display !== "none") {
        exitAutoCardBatch();
      } else {
        refreshAutoCards(false);
      }
      acAddInput.focus();
    }
    if (acAddBtn) acAddBtn.addEventListener("click", doAddAutoCard);
    if (acAddInput) acAddInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doAddAutoCard(); }
    });

    /* -------- 自动回复字卡批量删除 -------- */
    function updateAutoCardBatchUI() {
      var count = Object.keys(acBatchSelected).length;
      var total = (c.autoCards || []).length;
      var countEl = pageEl.querySelector("#autocard-batch-count");
      if (countEl) countEl.textContent = count > 0 ? "已选 " + count + " 项" : "未选";
      var delBtn = pageEl.querySelector('[data-act="delete-autocard-batch"]');
      if (delBtn) delBtn.disabled = count === 0;
      var selAllBtn = pageEl.querySelector('[data-act="autocard-select-all"]');
      if (selAllBtn) selAllBtn.textContent = count === total && total > 0 ? "取消全选" : "全选";
    }

    function bindAutoCardBatch() {
      pageEl.querySelectorAll("[data-autocard-idx]").forEach(function (item) {
        item.addEventListener("click", function () {
          var idx = parseInt(item.getAttribute("data-autocard-idx"), 10);
          if (acBatchSelected[idx]) {
            delete acBatchSelected[idx];
            item.classList.remove("is-selected");
          } else {
            acBatchSelected[idx] = true;
            item.classList.add("is-selected");
          }
          updateAutoCardBatchUI();
        });
      });
    }

    function enterAutoCardBatch() {
      var toolbar = pageEl.querySelector("#autocard-batch-toolbar");
      if (toolbar) toolbar.style.display = "flex";
      acBatchSelected = {};
      refreshAutoCards(true);
      updateAutoCardBatchUI();
    }

    function exitAutoCardBatch() {
      var toolbar = pageEl.querySelector("#autocard-batch-toolbar");
      if (toolbar) toolbar.style.display = "none";
      acBatchSelected = {};
      refreshAutoCards(false);
    }

    var acToggleBtn = pageEl.querySelector('[data-act="toggle-autocard-batch"]');
    if (acToggleBtn) acToggleBtn.addEventListener("click", enterAutoCardBatch);
    var acExitBtn = pageEl.querySelector('[data-act="exit-autocard-batch"]');
    if (acExitBtn) acExitBtn.addEventListener("click", exitAutoCardBatch);

    var acSelAllBtn = pageEl.querySelector('[data-act="autocard-select-all"]');
    if (acSelAllBtn) acSelAllBtn.addEventListener("click", function () {
      var total = (c.autoCards || []).length;
      var allSelected = Object.keys(acBatchSelected).length === total && total > 0;
      if (allSelected) {
        acBatchSelected = {};
      } else {
        acBatchSelected = {};
        for (var i = 0; i < total; i++) acBatchSelected[i] = true;
      }
      refreshAutoCards(true);
      pageEl.querySelectorAll("[data-autocard-idx]").forEach(function (item) {
        var idx = parseInt(item.getAttribute("data-autocard-idx"), 10);
        if (acBatchSelected[idx]) item.classList.add("is-selected");
      });
      updateAutoCardBatchUI();
    });

    var acDelBatchBtn = pageEl.querySelector('[data-act="delete-autocard-batch"]');
    if (acDelBatchBtn) acDelBatchBtn.addEventListener("click", function () {
      var indices = Object.keys(acBatchSelected).map(Number).sort(function (a, b) { return b - a; });
      if (indices.length === 0) return;
      indices.forEach(function (idx) {
        c.autoCards.splice(idx, 1);
      });
      save();
      exitAutoCardBatch();
    });

    bindAutoCardDels(data);

    bindCardDels(data);
  }

  function bindCardDels(data) {
    var c = findContact(data.id);
    if (!c) return;
    pageEl.querySelectorAll(".card-del").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-del"), 10);
        if (c.cards && c.cards.length > idx) {
          c.cards.splice(idx, 1);
          save();
          pageEl.querySelector("#cards-section").innerHTML = renderCardsList(c);
          var head = pageEl.querySelector(".group-head .count");
          if (head) head.textContent = (c.cards || []).length;
          bindCardDels(data);
        }
      });
    });
  }

  function bindAutoCardDels(data) {
    var c = findContact(data.id);
    if (!c) return;
    pageEl.querySelectorAll("[data-del-autocard]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-del-autocard"), 10);
        if (c.autoCards && c.autoCards.length > idx) {
          c.autoCards.splice(idx, 1);
          save();
          pageEl.querySelector("#autocards-section").innerHTML = renderAutoCardsList(c);
          var head = pageEl.querySelector("#autocard-count");
          if (head) head.textContent = (c.autoCards || []).length;
          bindAutoCardDels(data);
        }
      });
    });
  }

  /* ========================================================================
     视图 · 状态池管理
     ======================================================================== */
  function viewStatusEdit(data) {
    var c = findContact(data.id);
    if (!c) { resetTo("list"); return ""; }

    var left = '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>';
    var html = navBar({ title: "状态管理", left: left });

    html += '<div class="scroll">';

    // 当前状态提示
    html += '<div class="status-current">' +
      '<span class="status-current-label">当前状态</span>' +
      '<span class="status-current-text">' + escapeHtml(c.status || "在线") + '</span>' +
      '<button class="btn status-shuffle-btn" data-act="shuffle">' +
      I.svg("refresh", 16) + ' 随机切换</button>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 状态池
    html += '<div class="group-head">状态池 <span class="count">' + (c.statuses || []).length + '</span></div>';
    html += '<div class="cards-section" id="statuses-section">';
    html += renderStatusesList(c);
    html += '</div>';

    // 添加状态输入
    html += '<div class="card-add-row">' +
      '<input type="text" class="field-input card-add-input" id="status-add-text" ' +
      'placeholder="输入新状态…" maxlength="20">' +
      '<button class="btn card-add-btn" data-act="add-status">' + I.svg("plus", 18) + '</button>' +
      '</div>';

    html += '<div class="card-hint">每小时从状态池中随机切换一个状态</div>';

    html += '</div>';
    return html;
  }

  function renderStatusesList(c) {
    var statuses = c.statuses || [];
    if (statuses.length === 0) {
      return '<div class="cards-empty">暂无状态，添加后才会随机切换</div>';
    }
    var html = "";
    var currentStatus = c.status || "";
    statuses.forEach(function (text, i) {
      var isCurrent = text === currentStatus;
      html += '<div class="card-item' + (isCurrent ? " is-current" : "") + '">' +
        (isCurrent ? '<span class="status-dot"></span>' : "") +
        '<span class="card-text">' + escapeHtml(text) + '</span>' +
        '<button class="card-del" data-del-status="' + i + '">' + I.svg("close", 14) + '</button>' +
        '</div>';
    });
    return html;
  }

  function bindStatusEdit(data) {
    var c = findContact(data.id);
    if (!c) return;

    var addInput = pageEl.querySelector("#status-add-text");
    var addBtn = pageEl.querySelector('[data-act="add-status"]');

    function refreshStatuses() {
      pageEl.querySelector("#statuses-section").innerHTML = renderStatusesList(c);
      var head = pageEl.querySelector(".group-head .count");
      if (head) head.textContent = (c.statuses || []).length;
      bindStatusDels(data);
      // 更新当前状态显示
      var curText = pageEl.querySelector(".status-current-text");
      if (curText) curText.textContent = c.status || "在线";
    }

    function doAddStatus() {
      var text = (addInput.value || "").trim();
      if (!text) return;
      if (!c.statuses) c.statuses = [];
      c.statuses.push(text);
      addInput.value = "";
      save();
      refreshStatuses();
      addInput.focus();
    }

    addBtn.addEventListener("click", doAddStatus);
    addInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doAddStatus(); }
    });

    // 随机切换
    pageEl.querySelector('[data-act="shuffle"]').addEventListener("click", function () {
      shuffleContactStatus(c);
      save();
      refreshStatuses();
    });

    bindStatusDels(data);
  }

  function bindStatusDels(data) {
    var c = findContact(data.id);
    if (!c) return;
    pageEl.querySelectorAll("[data-del-status]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-del-status"), 10);
        if (c.statuses && c.statuses.length > idx) {
          var removed = c.statuses.splice(idx, 1)[0];
          // 若删除的是当前状态，切换到池中第一个
          if (c.status === removed) {
            c.status = c.statuses.length > 0 ? c.statuses[0] : "";
          }
          save();
          // 局部刷新
          pageEl.querySelector("#statuses-section").innerHTML = renderStatusesList(c);
          var head = pageEl.querySelector(".group-head .count");
          if (head) head.textContent = (c.statuses || []).length;
          var curText = pageEl.querySelector(".status-current-text");
          if (curText) curText.textContent = c.status || "在线";
          bindStatusDels(data);
        }
      });
    });
  }

  /* ========================================================================
     状态随机切换逻辑
     ======================================================================== */

  /** 从联系人的状态池中随机选一个（不同于当前） */
  function shuffleContactStatus(c) {
    if (!c.statuses || c.statuses.length === 0) return;
    if (c.statuses.length === 1) {
      c.status = c.statuses[0];
      return;
    }
    var pool = c.statuses.filter(function (s) { return s !== c.status; });
    if (pool.length === 0) pool = c.statuses.slice();
    c.status = pool[Math.floor(Math.random() * pool.length)];
  }

  /** 检查是否该执行每小时切换，并执行 */
  var SHUFFLE_KEY = "mine.contacts.lastShuffle";
  function maybeShuffleAll() {
    var now = Date.now();
    var last = 0;
    try { last = parseInt(localStorage.getItem(SHUFFLE_KEY) || "0", 10); } catch (e) {}
    // 若距上次切换已满 1 小时（或首次），执行切换
    if (now - last >= 3600000) {
      state.contacts.forEach(function (c) {
        if (c.statuses && c.statuses.length > 0) {
          shuffleContactStatus(c);
        }
      });
      save();
      try { localStorage.setItem(SHUFFLE_KEY, String(now)); } catch (e) {}
    }
  }

  /** 手动触发切换（用于首次加载或页面打开时） */
  function shuffleAllNow() {
    state.contacts.forEach(function (c) {
      if (c.statuses && c.statuses.length > 0) {
        shuffleContactStatus(c);
      }
    });
    save();
    try { localStorage.setItem(SHUFFLE_KEY, String(Date.now())); } catch (e) {}
  }

  /* ========================================================================
     视图 2 · 新增 / 编辑联系人
     ======================================================================== */
  function viewEdit(data) {
    var isNew = !data.id;
    var c = data.id ? findContact(data.id) : { name: "", status: "", avatar: null };
    if (!c) c = { name: "", status: "", avatar: null };

    var left = '<button class="nav-btn" data-act="back">' +
      (isNew ? I.svg("close", 20) : I.svg("back", 20)) +
      (isNew ? "取消" : "返回") + '</button>';
    var right = '<span class="nav-right">' +
      '<button class="nav-btn" data-act="save">保存</button></span>';

    var html = navBar({ title: isNew ? "新建联系人" : "编辑联系人", left: left, right: right });

    html += '<div class="scroll"><div class="edit-form">';

    // 头像选择
    html += '<div class="avatar-picker">' +
      '<div class="avatar big-avatar" id="edit-avatar">' +
        (c.avatar
          ? '<img src="' + escapeHtml(c.avatar) + '">'
          : '<span class="avatar-gen-text">' + escapeHtml(firstChar(c.name)) + '</span>') +
        '<div class="cam-badge">' + I.svg("camera", 15) + '</div>' +
      '</div>' +
      '<span class="pick-hint">点击更换头像</span>' +
      '<input type="file" accept="image/*" id="avatar-file" class="file-hidden">' +
      '</div>';

    // 昵称
    html += '<div class="field">' +
      '<label class="field-label">昵称</label>' +
      '<input type="text" class="field-input" id="edit-name" value="' + escapeHtml(c.name) +
      '" placeholder="输入昵称" maxlength="20">' +
      '</div>';

    // 状态
    html += '<div class="field">' +
      '<label class="field-label">状态</label>' +
      '<textarea class="field-input" id="edit-status" placeholder="此刻的状态…" maxlength="40">' +
      escapeHtml(c.status) + '</textarea>' +
      '</div>';

    // 删除（仅编辑）
    if (!isNew) {
      html += '<button class="btn btn-block btn-danger" data-act="delete" style="margin-top:var(--sp-6);">' +
        I.svg("trash", 18) + ' 删除联系人</button>';
    }

    html += '</div></div>';
    return html;
  }

  // 编辑表单暂存
  var editDraft = { avatar: null };

  function bindEdit(data) {
    var isNew = !data.id;
    var c = data.id ? findContact(data.id) : null;
    editDraft.avatar = c ? c.avatar : null;
    editDraft.name = c ? c.name : "";
    editDraft.status = c ? c.status : "";

    var avatarEl = pageEl.querySelector("#edit-avatar");
    var fileEl = pageEl.querySelector("#avatar-file");
    var nameEl = pageEl.querySelector("#edit-name");
    var statusEl = pageEl.querySelector("#edit-status");

    // 头像点击 → 选择文件
    avatarEl.addEventListener("click", function () { fileEl.click(); });
    var pickBtn = pageEl.querySelector('[data-act="pick-avatar"]');
    if (pickBtn) pickBtn.addEventListener("click", function () { fileEl.click(); });
    fileEl.addEventListener("change", function () {
      if (this.files && this.files[0]) {
        var f = this.files[0];
        // 压缩图片，避免 localStorage 溢出
        window.MineUtils.compressImage(f, 200, 0.85, function (dataURL) {
          if (!dataURL) return;
          editDraft.avatar = dataURL;
          avatarEl.innerHTML = '<img src="' + dataURL + '">' +
            '<div class="cam-badge">' + I.svg("camera", 15) + '</div>';
        });
        this.value = ""; // 允许重复选择同一文件
      }
    });

    // 实时同步昵称（更新首字头像）
    nameEl.addEventListener("input", function () {
      editDraft.name = this.value;
      if (!editDraft.avatar) {
        avatarEl.querySelector(".avatar-gen-text").textContent = firstChar(this.value);
      }
    });
    statusEl.addEventListener("input", function () { editDraft.status = this.value; });

    // 保存
    pageEl.querySelector('[data-act="save"]').addEventListener("click", function () {
      var name = (nameEl.value || "").trim();
      if (!name) {
        nameEl.focus();
        nameEl.style.borderColor = "#c97a7a";
        return;
      }
      if (isNew) {
        var newStatus = (statusEl.value || "").trim() || "在线";
        state.contacts.push({
          id: uid("c"),
          name: name,
          status: newStatus,
          avatar: editDraft.avatar,
          cards: [],
          autoCards: [],
          momentCards: [],
          statuses: [newStatus]
        });
      } else {
        var c = findContact(data.id);
        if (c) {
          c.name = name;
          c.status = (statusEl.value || "").trim();
          c.avatar = editDraft.avatar;
        }
      }
      save();
      resetTo("list");
    });

    // 删除
    var delBtn = pageEl.querySelector('[data-act="delete"]');
    if (delBtn) delBtn.addEventListener("click", function () {
      if (!confirm("确定删除「" + (c ? c.name : "") + "」？")) return;
      state.contacts = state.contacts.filter(function (x) { return x.id !== data.id; });
      // 同步从群聊中移除
      state.groups.forEach(function (g) {
        g.members = (g.members || []).filter(function (mid) { return mid !== data.id; });
      });
      save();
      resetTo("list");
    });
  }

  /* ========================================================================
     视图 3 · 群聊多选创建
     ======================================================================== */
  var selectDraft = { selected: {}, name: "" };

  function viewGroupSelect() {
    selectDraft = { selected: {}, name: "" };

    var left = '<button class="nav-btn" data-act="back">' + I.svg("close", 20) + '取消</button>';
    var html = navBar({ title: "选择成员", left: left });

    // 名称输入 + 已选 chips
    html += '<div class="select-header">';
    html += '<input type="text" class="select-name-input" id="group-name" ' +
      'placeholder="群聊名称（可选）" maxlength="20">';
    html += '<div class="selected-chips" id="selected-chips"></div>';
    html += '</div>';

    // 联系人列表
    html += '<div class="scroll contacts-scroll">';
    if (state.contacts.length === 0) {
      html += emptyContactsHTML();
    } else {
      html += '<div class="group-head">联系人 <span class="count">' + state.contacts.length + '</span></div>';
      state.contacts.forEach(function (c) {
        html += '<div class="contact-row selectable" role="button" tabindex="0" data-act="toggle" data-id="' + c.id + '">' +
          avatarHTML(c, 46) +
          '<div class="contact-info">' +
            '<span class="contact-name">' + escapeHtml(c.name) + '</span>' +
            '<span class="contact-status">' + escapeHtml(c.status || "在线") + '</span>' +
          '</div>' +
          '<span class="select-box">' + I.svg("check", 14) + '</span>' +
          '</div>';
      });
    }
    html += '</div>';

    // 底部创建按钮
    var n = Object.keys(selectDraft.selected).length;
    html += '<div class="select-footer">' +
      '<button class="btn btn-primary" data-act="create" disabled>' +
      I.svg("users", 18) + ' 创建群聊（' + n + '）</button></div>';

    return html;
  }

  function bindGroupSelect() {
    var nameInput = pageEl.querySelector("#group-name");
    nameInput.addEventListener("input", function () { selectDraft.name = this.value; });

    pageEl.querySelectorAll('[data-act="toggle"]').forEach(function (row) {
      row.addEventListener("click", function () {
        var id = row.getAttribute("data-id");
        if (selectDraft.selected[id]) {
          delete selectDraft.selected[id];
          row.classList.remove("is-selected");
        } else {
          selectDraft.selected[id] = true;
          row.classList.add("is-selected");
        }
        refreshSelectUI();
      });
    });

    pageEl.querySelector('[data-act="create"]').addEventListener("click", function () {
      var ids = Object.keys(selectDraft.selected);
      if (ids.length < 1) return;
      var name = (selectDraft.name || "").trim();
      if (!name) {
        // 无群名 → 用成员名拼接
        var names = ids.map(function (id) { var c = findContact(id); return c ? c.name : ""; });
        name = names.slice(0, 3).join("、") + (names.length > 3 ? "…" : "");
      }
      state.groups.unshift({
        id: uid("g"),
        name: name,
        avatar: null,
        cards: [],
        autoCards: [],
        members: ids,
        createdAt: Date.now()
      });
      save();
      resetTo("list");
    });
  }

  function refreshSelectUI() {
    var ids = Object.keys(selectDraft.selected);
    var n = ids.length;

    // chips
    var chipsEl = pageEl.querySelector("#selected-chips");
    var chipsHtml = "";
    ids.forEach(function (id) {
      var c = findContact(id);
      if (!c) return;
      chipsHtml += '<span class="chip">' +
        avatarHTML(c, 22, "chip-avatar") +
        '<span>' + escapeHtml(c.name) + '</span>' +
        '<span class="chip-x" data-unselect="' + id + '">' + I.svg("close", 12) + '</span>' +
        '</span>';
    });
    chipsEl.innerHTML = chipsHtml;

    // 取消选中
    chipsEl.querySelectorAll("[data-unselect]").forEach(function (x) {
      x.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = x.getAttribute("data-unselect");
        delete selectDraft.selected[id];
        var row = pageEl.querySelector('.contact-row[data-id="' + id + '"]');
        if (row) row.classList.remove("is-selected");
        refreshSelectUI();
      });
    });

    // 按钮
    var btn = pageEl.querySelector('[data-act="create"]');
    btn.innerHTML = I.svg("users", 18) + ' 创建群聊（' + n + '）';
    btn.disabled = n < 1;
  }

  /* ========================================================================
     视图 · 群聊编辑（自定义头像 + 群名）
     ======================================================================== */
  var groupEditDraft = { avatar: null };

  function viewGroupEdit(data) {
    var g = findGroup(data.id);
    if (!g) { resetTo("list"); return ""; }

    var left = '<button class="nav-btn" data-act="back">' + I.svg("close", 20) + '取消</button>';
    var right = '<span class="nav-right">' +
      '<button class="nav-btn" data-act="save">保存</button></span>';
    var html = navBar({ title: "编辑群聊", left: left, right: right });

    html += '<div class="scroll"><div class="edit-form">';

    // 群头像选择
    groupEditDraft.avatar = g.avatar;
    html += '<div class="avatar-picker">' +
      '<div class="big-avatar" id="group-edit-avatar" style="position:relative;cursor:pointer;border-radius:var(--r-md);width:88px;height:88px;">' +
        (g.avatar
          ? '<img src="' + escapeHtml(g.avatar) + '" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">'
          : groupAvatarHTML(g, 88, "is-single").replace('style="width:88px;height:88px;"', '')) +
        '<div class="cam-badge">' + I.svg("camera", 15) + '</div>' +
      '</div>' +
      '<span class="pick-hint">点击头像或下方按钮更换</span>' +
      '<button class="btn status-shuffle-btn" data-act="pick-avatar">' +
      I.svg("camera", 16) + ' 选择群头像</button>' +
      '<input type="file" accept="image/*" id="group-avatar-file" class="file-hidden">' +
      '</div>';

    // 群名
    html += '<div class="field">' +
      '<label class="field-label">群聊名称</label>' +
      '<input type="text" class="field-input" id="group-edit-name" value="' + escapeHtml(g.name) +
      '" placeholder="输入群名" maxlength="20">' +
      '</div>';

    // 清除自定义头像
    if (g.avatar) {
      html += '<button class="btn btn-block btn-danger" data-act="clear-avatar" style="margin-top:var(--sp-4);">' +
        I.svg("trash", 18) + ' 恢复默认群头像</button>';
    }

    html += '</div></div>';
    return html;
  }

  function bindGroupEdit(data) {
    var g = findGroup(data.id);
    if (!g) return;

    var avatarEl = pageEl.querySelector("#group-edit-avatar");
    var fileEl = pageEl.querySelector("#group-avatar-file");
    var nameEl = pageEl.querySelector("#group-edit-name");

    // 头像点击 → 选择文件
    avatarEl.addEventListener("click", function () { fileEl.click(); });
    fileEl.addEventListener("change", function () {
      if (this.files && this.files[0]) {
        var f = this.files[0];
        window.MineUtils.compressImage(f, 200, 0.85, function (dataURL) {
          if (!dataURL) return;
          groupEditDraft.avatar = dataURL;
          avatarEl.innerHTML = '<img src="' + dataURL + '" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">' +
            '<div class="cam-badge">' + I.svg("camera", 15) + '</div>';
        });
        this.value = "";
      }
    });

    // 清除自定义头像
    var clearBtn = pageEl.querySelector('[data-act="clear-avatar"]');
    if (clearBtn) clearBtn.addEventListener("click", function () {
      groupEditDraft.avatar = null;
      // 恢复默认群头像显示
      avatarEl.innerHTML = groupAvatarHTML({ members: g.members }, 88, "is-single")
        .replace('class="group-avatar is-single is-single"', 'class="group-avatar is-single"')
        .replace('style="width:88px;height:88px;"', '') +
        '<div class="cam-badge">' + I.svg("camera", 15) + '</div>';
    });

    // 保存
    pageEl.querySelector('[data-act="save"]').addEventListener("click", function () {
      var name = (nameEl.value || "").trim();
      if (!name) {
        nameEl.focus();
        nameEl.style.borderColor = "#c97a7a";
        return;
      }
      g.name = name;
      g.avatar = groupEditDraft.avatar;
      save();
      // 回到群详情
      viewStack = [
        { view: "list", data: {} },
        { view: "group-detail", data: { id: g.id } }
      ];
      render();
    });
  }

  /* ========================================================================
     视图 4 · 群聊详情
     ======================================================================== */
  function viewGroupDetail(data) {
    var g = findGroup(data.id);
    if (!g) { resetTo("list"); return ""; }

    var left = '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>';
    var right = '<span class="nav-right">' +
      '<button class="nav-btn" data-act="group-chat">' + I.svg("chat", 20) + '</button>' +
      '<button class="nav-btn" data-act="group-edit-name" style="margin-left:4px;">' + I.svg("pencil", 20) + '</button>' +
      '<button class="nav-btn" data-act="group-edit" style="margin-left:4px;">' + I.svg("userPlus", 20) + '</button></span>';
    var html = navBar({ title: "群信息", left: left, right: right });

    html += '<div class="scroll">';

    // 头部（头像可点击上传）
    html += '<div class="group-detail-hero">' +
      '<div class="avatar-picker" style="margin-bottom:0;">' +
        '<div class="big-avatar" id="group-detail-avatar" style="position:relative;cursor:pointer;width:76px;height:76px;">' +
          groupAvatarHTML(g, 76, "gd-avatar") +
          '<div class="cam-badge">' + I.svg("camera", 15) + '</div>' +
        '</div>' +
        '<input type="file" accept="image/*" id="group-detail-avatar-file" class="file-hidden">' +
      '</div>' +
      '<span class="gd-name">' + escapeHtml(g.name) + '</span>' +
      '<span class="gd-meta">' + (g.members || []).length + 1 + ' 位成员</span>' +
      '<button class="btn status-shuffle-btn" data-act="change-group-avatar" style="margin-top:4px;">' +
      I.svg("camera", 16) + ' 更换群头像</button>' +
      '</div>';

    // 群聊 / 群电话（预留）按钮
    html += '<div class="profile-actions-row">' +
      '<button class="btn btn-primary" data-act="group-chat-btn">' +
      I.svg("chat", 18) + ' 发消息</button>' +
      '<button class="btn btn-primary" data-act="group-call">' +
      I.svg("users", 18) + ' 群电话</button>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 搜索聊天记录入口
    html += '<div class="func-row" role="button" tabindex="0" data-act="search-history">' +
      '<div class="func-icon">' + I.svg("search", 20) + '</div>' +
      '<div class="func-text">' +
        '<span class="func-title">搜索聊天记录</span>' +
        '<span class="func-sub">查找群聊中的聊天内容</span>' +
      '</div>' +
      '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';

    html += '<div class="list-sep"></div>';

    // 群自动回复字卡区
    html += '<div class="group-head">群自动回复字卡 <span class="count" id="group-autocard-count">' + (g.autoCards || []).length + '</span>';
    if ((g.autoCards || []).length > 0) {
      html += '<button class="batch-toggle-btn" data-act="toggle-gautocard-batch">' + I.svg("trash", 14) + ' 批量删除</button>';
    }
    html += '</div>';
    html += '<div class="cards-section" id="group-autocards-section">';
    html += renderGroupAutoCardsList(g, false);
    html += '</div>';

    // 群自动回复字卡批量操作工具栏（默认隐藏）
    html += '<div class="batch-toolbar" id="gautocard-batch-toolbar" style="display:none;">' +
      '<button class="btn btn-sm" data-act="gautocard-select-all">全选</button>' +
      '<span class="batch-count" id="gautocard-batch-count">未选</span>' +
      '<button class="btn btn-sm btn-danger" data-act="delete-gautocard-batch" disabled>删除选中</button>' +
      '<button class="btn btn-sm" data-act="exit-gautocard-batch">完成</button>' +
      '</div>';

    // 添加群自动回复字卡输入
    html += '<div class="card-add-row">' +
      '<input type="text" class="field-input card-add-input" id="group-autocard-add-text" ' +
      'placeholder="输入群自动回复字卡，空格分隔可批量添加… 自动去重">' +
      '<button class="btn card-add-btn" data-act="add-group-autocard">' + I.svg("plus", 18) + '</button>' +
      '</div>';

    html += '<div class="card-hint">1% 不回复时自动发送 · 标记「自动回复」· 空格分隔批量添加 · 自动去重 · A→Z 排序</div>';

    html += '<div class="list-sep"></div>';

    // 群字卡区
    var _gCardCount  = (g.cards || []).length;
    var _gTextCount  = (g.cards || []).filter(function(x) { return !isImageCard(x) && !isAudioCard(x) && !isEmojiCard(x); }).length;
    var _gEmojiCount = (g.cards || []).filter(function(x) { return isEmojiCard(x); }).length;
    var _gImgCount   = (g.cards || []).filter(function(x) { return isImageCard(x); }).length;
    var _gAudioCount = (g.cards || []).filter(function(x) { return isAudioCard(x); }).length;
    html += '<div class="group-head">群字卡 <span class="count" id="group-card-count">' + _gCardCount + '</span>';
    html += '<button class="card-toggle-btn" data-act="toggle-gcards">' + I.svg("plus", 18) + '</button>';
    if (_gCardCount > 0) {
      html += '<button class="batch-toggle-btn" data-act="toggle-gcard-batch" style="display:none;">' + I.svg("trash", 14) + ' 批量删除</button>';
    }
    html += '</div>';

    // 字卡类型弹窗
    html += '<div class="card-type-popup" id="group-card-type-popup">' +
      '<button class="card-type-option" data-type="text">' + I.svg("feather", 20) +
      '<span>字符</span><span class="card-type-count">' + _gTextCount + '</span></button>' +
      '<button class="card-type-option" data-type="emoji">' + I.svg("smile", 20) +
      '<span>emoji</span><span class="card-type-count">' + _gEmojiCount + '</span></button>' +
      '<button class="card-type-option" data-type="image">' + I.svg("image", 20) +
      '<span>图片</span><span class="card-type-count">' + _gImgCount + '</span></button>' +
      '<button class="card-type-option" data-type="audio">' + I.svg("mic", 20) +
      '<span>语音</span><span class="card-type-count">' + _gAudioCount + '</span></button>' +
      '</div>';

    // 字卡列表（默认折叠）
    html += '<div class="cards-section" id="group-cards-section" style="display:none;">';
    html += renderGroupCardsList(g, false, null);
    html += '</div>';

    // 批量操作工具栏（默认隐藏）
    html += '<div class="batch-toolbar" id="gcard-batch-toolbar" style="display:none;">' +
      '<button class="btn btn-sm" data-act="gcard-select-all">全选</button>' +
      '<span class="batch-count" id="gcard-batch-count">未选</span>' +
      '<button class="btn btn-sm btn-danger" data-act="delete-gcard-batch" disabled>删除选中</button>' +
      '<button class="btn btn-sm" data-act="exit-gcard-batch">完成</button>' +
      '</div>';

    // 文本添加行（仅字符模式）
    html += '<div class="card-add-row" id="group-card-text-add-row" style="display:none;">' +
      '<input type="text" class="field-input card-add-input" id="group-card-add-text" ' +
      'placeholder="输入群字卡，空格分隔批量添加 · 回车确认">' +
      '</div>';

    // emoji 添加行（仅 emoji 模式）
    html += '<div class="card-add-row" id="group-card-emoji-add-row" style="display:none;">' +
      '<input type="text" class="field-input card-add-input" id="group-card-add-emoji" ' +
      'placeholder="输入 emoji，如 😊🎉🍃 · 回车确认">' +
      '</div>';

    // 图片添加行（仅图片模式）
    html += '<div class="card-add-row" id="group-card-image-add-row" style="display:none;">' +
      '<button class="btn card-image-add-btn" id="group-card-image-add-btn">' + I.svg("image", 18) + ' 选择图片</button>' +
      '</div>';

    // 语音添加行（仅语音模式）
    html += '<div class="card-add-row" id="group-card-audio-add-row" style="display:none;">' +
      '<button class="btn card-image-add-btn" id="group-card-audio-add-btn">' + I.svg("mic", 18) + ' 选择语音文件</button>' +
      '</div>';

    // 隐藏文件选择器
    html += '<input type="file" accept="image/*" id="group-card-image-file" style="display:none" multiple>';
    html += '<input type="file" accept="audio/*" id="group-card-audio-file" style="display:none" multiple>';

    html += '<div class="card-hint">点击 + 展开群字卡 · 选择字符 / emoji / 图片 / 语音 · 字符回车添加 · 图片语音可多选 · 群字卡可被所有成员在群聊中使用</div>';

    html += '<div class="list-sep"></div>';
    html += '<div class="group-head">群成员</div>';

    // 成员列表
    (g.members || []).forEach(function (id) {
      var c = findContact(id);
      if (!c) return;
      var onlineCls = c.status ? "" : " is-online";
      var statusText = c.status || "在线";
      html += '<div class="contact-row group-member-row" data-mid="' + id + '">' +
        avatarHTML(c, 46) +
        '<div class="contact-info" data-act="detail" data-id="' + c.id + '">' +
          '<span class="contact-name">' + escapeHtml(c.name) + '</span>' +
          '<span class="contact-status' + onlineCls + '">' + escapeHtml(statusText) + '</span>' +
        '</div>' +
        '<button class="btn btn-sm btn-danger group-remove-btn" data-rm-member="' + id + '">移出</button>' +
        '</div>';
    });

    // 解散群聊
    html += '<div style="padding:var(--sp-6) var(--sp-5);">' +
      '<button class="btn btn-block btn-danger" data-act="dissolve">' +
      I.svg("trash", 18) + ' 解散群聊</button></div>';

    html += '</div>';
    return html;
  }

  /* -------- 群字卡渲染与绑定 -------- */
  function renderGroupCardsList(g, batchMode, typeFilter) {
    var cards = g.cards || [];
    if (cards.length === 0) {
      return '<div class="cards-empty">暂无群字卡，添加后成员可在群聊中使用</div>';
    }
    var html = "";
    cards.forEach(function (text, i) {
      var isImg = isImageCard(text);
      var isAud = isAudioCard(text);
      var isEmoji = isEmojiCard(text);
      // 类型过滤
      if (typeFilter === "text" && (isImg || isAud || isEmoji)) return;
      if (typeFilter === "emoji" && !isEmoji) return;
      if (typeFilter === "image" && !isImg) return;
      if (typeFilter === "audio" && !isAud) return;
      var cardCls = isImg ? ' card-image-item' : (isEmoji ? ' card-emoji-item' : '');
      var inner = isImg
        ? '<img class="card-image-thumb" src="' + escapeHtml(text) + '" alt="图片字卡">'
        : (isAud
          ? MineVoiceBar.html(text, "vb-full")
          : (isEmoji
            ? '<span class="card-emoji">' + escapeHtml(text) + '</span>'
            : '<span class="card-text">' + escapeHtml(text) + '</span>'));
      if (batchMode) {
        html += '<div class="card-item card-selectable' + cardCls + '" data-gcard-idx="' + i + '">' +
          '<span class="card-check">' + I.svg("check", 14) + '</span>' + inner + '</div>';
      } else {
        html += '<div class="card-item' + cardCls + '">' + inner +
          '<button class="card-del" data-del-gcard="' + i + '">' + I.svg("close", 14) + '</button>' +
          '</div>';
      }
    });
    if (!html) {
      if (typeFilter === "text") return '<div class="cards-empty">暂无字符群字卡</div>';
      if (typeFilter === "emoji") return '<div class="cards-empty">暂无 emoji 群字卡，输入 emoji 添加</div>';
      if (typeFilter === "image") return '<div class="cards-empty">暂无图片群字卡，点击「选择图片」添加</div>';
      if (typeFilter === "audio") return '<div class="cards-empty">暂无语音群字卡，点击「选择语音文件」添加</div>';
    }
    return html;
  }

  function renderGroupAutoCardsList(g, batchMode) {
    var cards = g.autoCards || [];
    if (cards.length === 0) {
      return '<div class="cards-empty">暂无群自动回复字卡，1% 不回复时将保持沉默</div>';
    }
    var html = "";
    cards.forEach(function (text, i) {
      if (batchMode) {
        html += '<div class="card-item card-selectable" data-gautocard-idx="' + i + '">' +
          '<span class="card-check">' + I.svg("check", 14) + '</span>' +
          '<span class="card-text">' + escapeHtml(text) + '</span>' +
          '</div>';
      } else {
        html += '<div class="card-item autocard-item">' +
          '<span class="card-text">' + escapeHtml(text) + '</span>' +
          '<button class="card-del" data-del-gautocard="' + i + '">' + I.svg("close", 14) + '</button>' +
          '</div>';
      }
    });
    return html;
  }

  function bindGroupCards(data) {
    var g = findGroup(data.id);
    if (!g) return;

    var addInput = pageEl.querySelector("#group-card-add-text");
    var gToggleBtn = pageEl.querySelector('[data-act="toggle-gcards"]');
    var gCardTypePopup = pageEl.querySelector("#group-card-type-popup");
    var gCardImageFile = pageEl.querySelector("#group-card-image-file");
    var gImageAddBtn = pageEl.querySelector("#group-card-image-add-btn");
    var gcardBatchSelected = {};
    var gCardViewMode = null;  // null=折叠, "text"=字符, "emoji"=emoji, "image"=图片

    function refreshGroupCards(batchMode) {
      pageEl.querySelector("#group-cards-section").innerHTML = renderGroupCardsList(g, batchMode, gCardViewMode);
      var countEl = pageEl.querySelector("#group-card-count");
      if (countEl) countEl.textContent = (g.cards || []).length;
      // 更新弹窗计数
      var _tc = (g.cards || []).filter(function(x) { return !isImageCard(x) && !isAudioCard(x) && !isEmojiCard(x); }).length;
      var _ec = (g.cards || []).filter(function(x) { return isEmojiCard(x); }).length;
      var _ic = (g.cards || []).filter(function(x) { return isImageCard(x); }).length;
      var _ac = (g.cards || []).filter(function(x) { return isAudioCard(x); }).length;
      var counts = pageEl.querySelectorAll("#group-card-type-popup .card-type-count");
      if (counts[0]) counts[0].textContent = _tc;
      if (counts[1]) counts[1].textContent = _ec;
      if (counts[2]) counts[2].textContent = _ic;
      if (counts[3]) counts[3].textContent = _ac;
      if (batchMode) {
        bindGcardBatch();
      } else {
        bindGroupCardDels(data);
      }
    }

    function doAddCard() {
      var text = (addInput.value || "").trim();
      if (!text) return;
      if (!g.cards) g.cards = [];
      var newCards = text.split(/\s+/).filter(function (s) { return s.length > 0; });
      if (window.MineUtils) {
        newCards = window.MineUtils.deduplicateCards(newCards);
      } else {
        var _seen = {}; newCards = newCards.filter(function (x) {
          if (_seen[x]) return false; _seen[x] = true; return true;
        });
      }
      newCards = newCards.filter(function (card) {
        return g.cards.indexOf(card) < 0;
      });
      if (newCards.length === 0) {
        addInput.value = "";
        addInput.focus();
        return;
      }
      g.cards = g.cards.concat(newCards);
      g.cards = sortCardsMixed(g.cards);
      addInput.value = "";
      save();
      var toolbar = pageEl.querySelector("#gcard-batch-toolbar");
      if (toolbar && toolbar.style.display !== "none") {
        exitGcardBatch();
      } else {
        refreshGroupCards(false);
      }
      addInput.focus();
    }

    /* -------- 折叠 / 展开 -------- */
    function showGCardTypePopup() { if (gCardTypePopup) gCardTypePopup.classList.add("is-show"); }
    function hideGCardTypePopup() { if (gCardTypePopup) gCardTypePopup.classList.remove("is-show"); }

    function expandGCardView(type) {
      gCardViewMode = type;
      hideGCardTypePopup();
      var cs = pageEl.querySelector("#group-cards-section");
      if (cs) cs.style.display = "";
      var tr = pageEl.querySelector("#group-card-text-add-row");
      var er = pageEl.querySelector("#group-card-emoji-add-row");
      var ir = pageEl.querySelector("#group-card-image-add-row");
      var ar = pageEl.querySelector("#group-card-audio-add-row");
      if (tr) tr.style.display = (type === "text") ? "" : "none";
      if (er) er.style.display = (type === "emoji") ? "" : "none";
      if (ir) ir.style.display = (type === "image") ? "" : "none";
      if (ar) ar.style.display = (type === "audio") ? "" : "none";
      var batchBtn = pageEl.querySelector('[data-act="toggle-gcard-batch"]');
      if (batchBtn) {
        var fc = (g.cards || []).filter(function(x) {
          if (type === "text") return !isImageCard(x) && !isAudioCard(x) && !isEmojiCard(x);
          if (type === "emoji") return isEmojiCard(x);
          if (type === "audio") return isAudioCard(x);
          return isImageCard(x);
        }).length;
        batchBtn.style.display = fc > 0 ? "" : "none";
      }
      if (gToggleBtn) gToggleBtn.innerHTML = I.svg("minus", 18);
      refreshGroupCards(false);
      if (type === "text" && addInput) addInput.focus();
      if (type === "emoji") {
        var gEmojiInput = pageEl.querySelector("#group-card-add-emoji");
        if (gEmojiInput) gEmojiInput.focus();
      }
    }

    function collapseGCardView() {
      gCardViewMode = null;
      hideGCardTypePopup();
      var cs = pageEl.querySelector("#group-cards-section");
      if (cs) cs.style.display = "none";
      var tr = pageEl.querySelector("#group-card-text-add-row");
      var er = pageEl.querySelector("#group-card-emoji-add-row");
      var ir = pageEl.querySelector("#group-card-image-add-row");
      var ar = pageEl.querySelector("#group-card-audio-add-row");
      if (tr) tr.style.display = "none";
      if (er) er.style.display = "none";
      if (ir) ir.style.display = "none";
      if (ar) ar.style.display = "none";
      var tb = pageEl.querySelector("#gcard-batch-toolbar");
      if (tb) tb.style.display = "none";
      var batchBtn = pageEl.querySelector('[data-act="toggle-gcard-batch"]');
      if (batchBtn) batchBtn.style.display = "none";
      if (gToggleBtn) gToggleBtn.innerHTML = I.svg("plus", 18);
    }

    if (gToggleBtn) gToggleBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (gCardViewMode !== null) {
        collapseGCardView();
      } else {
        showGCardTypePopup();
      }
    });
    document.addEventListener("click", function (e) {
      if (!gCardTypePopup || !gCardTypePopup.classList.contains("is-show")) return;
      if (!gCardTypePopup.contains(e.target) && !(gToggleBtn && gToggleBtn.contains(e.target))) hideGCardTypePopup();
    });
    if (gCardTypePopup) {
      gCardTypePopup.querySelectorAll(".card-type-option").forEach(function (opt) {
        opt.addEventListener("click", function () {
          var type = opt.getAttribute("data-type");
          expandGCardView(type);
        });
      });
    }
    if (gImageAddBtn) {
      gImageAddBtn.addEventListener("click", function () {
        if (gCardImageFile) gCardImageFile.click();
      });
    }
    if (gCardImageFile) {
      gCardImageFile.addEventListener("change", function () {
        var files = this.files;
        if (!files || files.length === 0) return;
        if (!g.cards) g.cards = [];
        var processed = 0;
        var total = files.length;
        Array.prototype.forEach.call(files, function (f) {
          window.MineUtils.compressImage(f, 400, 0.85, function (dataURL) {
            if (dataURL && g.cards.indexOf(dataURL) < 0) g.cards.push(dataURL);
            processed++;
            if (processed === total) {
              g.cards = sortCardsMixed(g.cards);
              save();
              var countEl = pageEl.querySelector("#group-card-count");
              if (countEl) countEl.textContent = g.cards.length;
              var tb = pageEl.querySelector("#gcard-batch-toolbar");
              if (tb && tb.style.display !== "none") exitGcardBatch();
              else refreshGroupCards(false);
              var batchBtn = pageEl.querySelector('[data-act="toggle-gcard-batch"]');
              if (batchBtn && gCardViewMode === "image") {
                var ic = g.cards.filter(function(x) { return isImageCard(x); }).length;
                batchBtn.style.display = ic > 0 ? "" : "none";
              }
            }
          });
        });
        this.value = "";
      });
    }

    /* -------- 群语音字卡添加（audio 文件 → dataURL） -------- */
    var gAudioAddBtn = pageEl.querySelector("#group-card-audio-add-btn");
    var gCardAudioFile = pageEl.querySelector("#group-card-audio-file");
    if (gAudioAddBtn) {
      gAudioAddBtn.addEventListener("click", function () {
        if (gCardAudioFile) gCardAudioFile.click();
      });
    }
    if (gCardAudioFile) {
      gCardAudioFile.addEventListener("change", function () {
        var files = this.files;
        if (!files || files.length === 0) return;
        if (!g.cards) g.cards = [];
        var processed = 0;
        var total = files.length;
        Array.prototype.forEach.call(files, function (f) {
          if (!f.type || f.type.indexOf("audio/") !== 0) { processed++; checkDone(); return; }
          var reader = new FileReader();
          reader.onload = function () {
            var dataURL = reader.result;
            if (dataURL && g.cards.indexOf(dataURL) < 0) g.cards.push(dataURL);
            processed++;
            checkDone();
          };
          reader.onerror = function () { processed++; checkDone(); };
          reader.readAsDataURL(f);
        });
        function checkDone() {
          if (processed !== total) return;
          g.cards = sortCardsMixed(g.cards);
          save();
          var countEl = pageEl.querySelector("#group-card-count");
          if (countEl) countEl.textContent = g.cards.length;
          var tb = pageEl.querySelector("#gcard-batch-toolbar");
          if (tb && tb.style.display !== "none") exitGcardBatch();
          else refreshGroupCards(false);
        }
        this.value = "";
      });
    }

    if (addInput) addInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doAddCard(); }
    });

    /* -------- 群 emoji 字卡添加（按字符分割，自动去重） -------- */
    var gEmojiInput = pageEl.querySelector("#group-card-add-emoji");
    function doAddGroupEmojiCard() {
      var text = (gEmojiInput.value || "").trim();
      if (!text) return;
      if (!g.cards) g.cards = [];
      // 按字符分割（emoji 可能是多字节，用 Array.from）
      var newCards = Array.from(text).map(function (ch) { return ch.trim(); }).filter(function (s) { return s.length > 0; });
      // 去重
      if (window.MineUtils) {
        newCards = window.MineUtils.deduplicateCards(newCards);
      } else {
        var _seen = {}; newCards = newCards.filter(function (x) {
          if (_seen[x]) return false; _seen[x] = true; return true;
        });
      }
      newCards = newCards.filter(function (card) {
        return g.cards.indexOf(card) < 0;
      });
      if (newCards.length === 0) {
        gEmojiInput.value = "";
        gEmojiInput.focus();
        return;
      }
      g.cards = g.cards.concat(newCards);
      g.cards = sortCardsMixed(g.cards);
      gEmojiInput.value = "";
      save();
      var toolbar = pageEl.querySelector("#gcard-batch-toolbar");
      if (toolbar && toolbar.style.display !== "none") exitGcardBatch();
      else refreshGroupCards(false);
      gEmojiInput.focus();
    }
    if (gEmojiInput) gEmojiInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doAddGroupEmojiCard(); }
    });

    /* -------- 群字卡批量删除 -------- */
    function updateGcardBatchUI() {
      var count = Object.keys(gcardBatchSelected).length;
      var total = (g.cards || []).length;
      var countEl = pageEl.querySelector("#gcard-batch-count");
      if (countEl) countEl.textContent = count > 0 ? "已选 " + count + " 项" : "未选";
      var delBtn = pageEl.querySelector('[data-act="delete-gcard-batch"]');
      if (delBtn) delBtn.disabled = count === 0;
      var selAllBtn = pageEl.querySelector('[data-act="gcard-select-all"]');
      if (selAllBtn) selAllBtn.textContent = count === total && total > 0 ? "取消全选" : "全选";
    }

    function bindGcardBatch() {
      pageEl.querySelectorAll("[data-gcard-idx]").forEach(function (item) {
        item.addEventListener("click", function () {
          var idx = parseInt(item.getAttribute("data-gcard-idx"), 10);
          if (gcardBatchSelected[idx]) {
            delete gcardBatchSelected[idx];
            item.classList.remove("is-selected");
          } else {
            gcardBatchSelected[idx] = true;
            item.classList.add("is-selected");
          }
          updateGcardBatchUI();
        });
      });
    }

    function enterGcardBatch() {
      var toolbar = pageEl.querySelector("#gcard-batch-toolbar");
      if (toolbar) toolbar.style.display = "flex";
      gcardBatchSelected = {};
      refreshGroupCards(true);
      updateGcardBatchUI();
    }

    function exitGcardBatch() {
      var toolbar = pageEl.querySelector("#gcard-batch-toolbar");
      if (toolbar) toolbar.style.display = "none";
      gcardBatchSelected = {};
      refreshGroupCards(false);
    }

    var toggleBtn = pageEl.querySelector('[data-act="toggle-gcard-batch"]');
    if (toggleBtn) toggleBtn.addEventListener("click", enterGcardBatch);
    var exitBtn = pageEl.querySelector('[data-act="exit-gcard-batch"]');
    if (exitBtn) exitBtn.addEventListener("click", exitGcardBatch);

    var selAllBtn = pageEl.querySelector('[data-act="gcard-select-all"]');
    if (selAllBtn) selAllBtn.addEventListener("click", function () {
      var total = (g.cards || []).length;
      var allSelected = Object.keys(gcardBatchSelected).length === total && total > 0;
      if (allSelected) {
        gcardBatchSelected = {};
      } else {
        gcardBatchSelected = {};
        for (var i = 0; i < total; i++) gcardBatchSelected[i] = true;
      }
      refreshGroupCards(true);
      pageEl.querySelectorAll("[data-gcard-idx]").forEach(function (item) {
        var idx = parseInt(item.getAttribute("data-gcard-idx"), 10);
        if (gcardBatchSelected[idx]) item.classList.add("is-selected");
      });
      updateGcardBatchUI();
    });

    var delBatchBtn = pageEl.querySelector('[data-act="delete-gcard-batch"]');
    if (delBatchBtn) delBatchBtn.addEventListener("click", function () {
      var indices = Object.keys(gcardBatchSelected).map(Number).sort(function (a, b) { return b - a; });
      if (indices.length === 0) return;
      indices.forEach(function (idx) {
        g.cards.splice(idx, 1);
      });
      save();
      exitGcardBatch();
    });

    bindGroupCardDels(data);
  }

  function bindGroupCardDels(data) {
    var g = findGroup(data.id);
    if (!g) return;
    pageEl.querySelectorAll("[data-del-gcard]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-del-gcard"), 10);
        if (g.cards && g.cards.length > idx) {
          g.cards.splice(idx, 1);
          save();
          pageEl.querySelector("#group-cards-section").innerHTML = renderGroupCardsList(g, false, gCardViewMode);
          var countEl = pageEl.querySelector("#group-card-count");
          if (countEl) countEl.textContent = (g.cards || []).length;
          bindGroupCardDels(data);
        }
      });
    });
  }

  /* -------- 群自动回复字卡管理 -------- */
  function bindGroupAutoCards(data) {
    var g = findGroup(data.id);
    if (!g) return;

    var addInput = pageEl.querySelector("#group-autocard-add-text");
    var addBtn = pageEl.querySelector('[data-act="add-group-autocard"]');
    var batchSelected = {};

    function refreshGroupAutoCards(batchMode) {
      pageEl.querySelector("#group-autocards-section").innerHTML = renderGroupAutoCardsList(g, batchMode);
      var countEl = pageEl.querySelector("#group-autocard-count");
      if (countEl) countEl.textContent = (g.autoCards || []).length;
      if (batchMode) {
        bindGAutoCardBatch();
      } else {
        bindGroupAutoCardDels(data);
      }
    }

    function doAddCard() {
      var text = (addInput.value || "").trim();
      if (!text) return;
      if (!g.autoCards) g.autoCards = [];
      var newCards = text.split(/\s+/).filter(function (s) { return s.length > 0; });
      if (window.MineUtils) {
        newCards = window.MineUtils.deduplicateCards(newCards);
      } else {
        var _seen = {}; newCards = newCards.filter(function (x) {
          if (_seen[x]) return false; _seen[x] = true; return true;
        });
      }
      newCards = newCards.filter(function (card) {
        return g.autoCards.indexOf(card) < 0;
      });
      if (newCards.length === 0) {
        addInput.value = "";
        addInput.focus();
        return;
      }
      g.autoCards = g.autoCards.concat(newCards);
      if (window.MineUtils) {
        g.autoCards = window.MineUtils.sortByPinyin(g.autoCards);
      }
      addInput.value = "";
      save();
      var toolbar = pageEl.querySelector("#gautocard-batch-toolbar");
      if (toolbar && toolbar.style.display !== "none") {
        exitGAutoCardBatch();
      } else {
        refreshGroupAutoCards(false);
      }
      addInput.focus();
    }
    if (addBtn) addBtn.addEventListener("click", doAddCard);
    if (addInput) addInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doAddCard(); }
    });

    function updateBatchUI() {
      var count = Object.keys(batchSelected).length;
      var total = (g.autoCards || []).length;
      var countEl = pageEl.querySelector("#gautocard-batch-count");
      if (countEl) countEl.textContent = count > 0 ? "已选 " + count + " 项" : "未选";
      var delBtn = pageEl.querySelector('[data-act="delete-gautocard-batch"]');
      if (delBtn) delBtn.disabled = count === 0;
      var selAllBtn = pageEl.querySelector('[data-act="gautocard-select-all"]');
      if (selAllBtn) selAllBtn.textContent = count === total && total > 0 ? "取消全选" : "全选";
    }

    function bindGAutoCardBatch() {
      pageEl.querySelectorAll("[data-gautocard-idx]").forEach(function (item) {
        item.addEventListener("click", function () {
          var idx = parseInt(item.getAttribute("data-gautocard-idx"), 10);
          if (batchSelected[idx]) {
            delete batchSelected[idx];
            item.classList.remove("is-selected");
          } else {
            batchSelected[idx] = true;
            item.classList.add("is-selected");
          }
          updateBatchUI();
        });
      });
    }

    function enterBatch() {
      var toolbar = pageEl.querySelector("#gautocard-batch-toolbar");
      if (toolbar) toolbar.style.display = "flex";
      batchSelected = {};
      refreshGroupAutoCards(true);
      updateBatchUI();
    }

    function exitGAutoCardBatch() {
      var toolbar = pageEl.querySelector("#gautocard-batch-toolbar");
      if (toolbar) toolbar.style.display = "none";
      batchSelected = {};
      refreshGroupAutoCards(false);
    }

    var toggleBtn = pageEl.querySelector('[data-act="toggle-gautocard-batch"]');
    if (toggleBtn) toggleBtn.addEventListener("click", enterBatch);
    var exitBtn = pageEl.querySelector('[data-act="exit-gautocard-batch"]');
    if (exitBtn) exitBtn.addEventListener("click", exitGAutoCardBatch);

    var selAllBtn = pageEl.querySelector('[data-act="gautocard-select-all"]');
    if (selAllBtn) selAllBtn.addEventListener("click", function () {
      var total = (g.autoCards || []).length;
      var allSelected = Object.keys(batchSelected).length === total && total > 0;
      if (allSelected) {
        batchSelected = {};
      } else {
        batchSelected = {};
        for (var i = 0; i < total; i++) batchSelected[i] = true;
      }
      refreshGroupAutoCards(true);
      pageEl.querySelectorAll("[data-gautocard-idx]").forEach(function (item) {
        var idx = parseInt(item.getAttribute("data-gautocard-idx"), 10);
        if (batchSelected[idx]) item.classList.add("is-selected");
      });
      updateBatchUI();
    });

    var delBatchBtn = pageEl.querySelector('[data-act="delete-gautocard-batch"]');
    if (delBatchBtn) delBatchBtn.addEventListener("click", function () {
      var indices = Object.keys(batchSelected).map(Number).sort(function (a, b) { return b - a; });
      if (indices.length === 0) return;
      indices.forEach(function (idx) {
        g.autoCards.splice(idx, 1);
      });
      save();
      exitGAutoCardBatch();
    });

    bindGroupAutoCardDels(data);
  }

  function bindGroupAutoCardDels(data) {
    var g = findGroup(data.id);
    if (!g) return;
    pageEl.querySelectorAll("[data-del-gautocard]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-del-gautocard"), 10);
        if (g.autoCards && g.autoCards.length > idx) {
          g.autoCards.splice(idx, 1);
          save();
          pageEl.querySelector("#group-autocards-section").innerHTML = renderGroupAutoCardsList(g);
          var countEl = pageEl.querySelector("#group-autocard-count");
          if (countEl) countEl.textContent = (g.autoCards || []).length;
          bindGroupAutoCardDels(data);
        }
      });
    });
  }

  function bindGroupDetail(data) {
    var g = findGroup(data.id);
    if (!g) return;

    // 群字卡管理
    bindGroupCards(data);
    // 群自动回复字卡管理
    bindGroupAutoCards(data);

    // 成员点击 → 跳联系人主页
    pageEl.querySelectorAll('.group-member-row [data-act="detail"]').forEach(function (row) {
      row.addEventListener("click", function () {
        push("profile", { id: row.getAttribute("data-id") });
      });
    });

    // 移除群成员
    pageEl.querySelectorAll('[data-rm-member]').forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var mid = btn.getAttribute("data-rm-member");
        var mc = findContact(mid);
        if (!confirm("确定将「" + (mc ? mc.name : "该成员") + "」移出群聊？")) return;
        g.members = (g.members || []).filter(function (x) { return x !== mid; });
        save();
        // 刷新群详情页
        viewStack = [
          { view: "list", data: {} },
          { view: "group-detail", data: { id: g.id } }
        ];
        render();
      });
    });

    // 添加成员
    pageEl.querySelector('[data-act="group-edit"]').addEventListener("click", function () {
      push("group-add", { groupId: g.id });
    });

    // 编辑群聊（头像+群名）
    pageEl.querySelector('[data-act="group-edit-name"]').addEventListener("click", function () {
      push("group-edit", { id: g.id });
    });

    // 群详情页头像直接上传
    var gdAvatar = pageEl.querySelector("#group-detail-avatar");
    var gdFile = pageEl.querySelector("#group-detail-avatar-file");
    var changeAvatarBtn = pageEl.querySelector('[data-act="change-group-avatar"]');
    function triggerGroupAvatarUpload() { if (gdFile) gdFile.click(); }
    if (gdAvatar) gdAvatar.addEventListener("click", triggerGroupAvatarUpload);
    if (changeAvatarBtn) changeAvatarBtn.addEventListener("click", triggerGroupAvatarUpload);
    if (gdFile) {
      gdFile.addEventListener("change", function () {
        if (this.files && this.files[0]) {
          var f = this.files[0];
          window.MineUtils.compressImage(f, 200, 0.85, function (dataURL) {
            if (!dataURL) return;
            g.avatar = dataURL;
            save();
            // 局部更新头像
            if (gdAvatar) gdAvatar.innerHTML = groupAvatarHTML(g, 76, "gd-avatar") +
              '<div class="cam-badge">' + I.svg("camera", 15) + '</div>';
          });
          this.value = "";
        }
      });
    }

    // 群聊入口（导航栏 + 按钮）
    function startGroupChat() {
      if (window.MineChat) MineChat.openGroup(g.id);
    }
    pageEl.querySelector('[data-act="group-chat"]').addEventListener("click", startGroupChat);
    pageEl.querySelector('[data-act="group-chat-btn"]').addEventListener("click", startGroupChat);
    // 群电话（预留入口，功能后期开放）
    var groupCallBtn = pageEl.querySelector('[data-act="group-call"]');
    if (groupCallBtn) groupCallBtn.addEventListener("click", function () {
      if (window.MinePhone) MinePhone.openGroupCall(g.id);
    });

    // 搜索聊天记录
    pageEl.querySelector('[data-act="search-history"]').addEventListener("click", function () {
      push("search-history", { type: "group", id: g.id, name: g.name });
    });

    // 解散
    pageEl.querySelector('[data-act="dissolve"]').addEventListener("click", function () {
      if (!confirm("确定解散「" + g.name + "」？")) return;
      state.groups = state.groups.filter(function (x) { return x.id !== g.id; });
      save();
      resetTo("list");
    });
  }

  /* ========================================================================
     视图 5 · 群聊添加成员（从详情进入）
     ======================================================================== */
  function viewGroupAdd(data) {
    var g = findGroup(data.groupId);
    if (!g) { resetTo("list"); return ""; }
    selectDraft = { selected: {}, groupId: g.id, name: "" };

    var left = '<button class="nav-btn" data-act="back">' + I.svg("close", 20) + '取消</button>';
    var right = '<span class="nav-right">' +
      '<button class="nav-btn" data-act="add-members">添加</button></span>';
    var html = navBar({ title: "添加成员", left: left, right: right });

    html += '<div class="scroll contacts-scroll">';
    html += '<div class="group-head">联系人</div>';
    state.contacts.forEach(function (c) {
      var inGroup = (g.members || []).indexOf(c.id) >= 0;
      if (inGroup) return;  // 已在群中跳过
      html += '<div class="contact-row selectable" role="button" tabindex="0" data-act="toggle" data-id="' + c.id + '">' +
        avatarHTML(c, 46) +
        '<div class="contact-info">' +
          '<span class="contact-name">' + escapeHtml(c.name) + '</span>' +
          '<span class="contact-status">' + escapeHtml(c.status || "在线") + '</span>' +
        '</div>' +
        '<span class="select-box">' + I.svg("check", 14) + '</span>' +
        '</div>';
    });
    html += '</div>';
    return html;
  }

  function bindGroupAdd(data) {
    pageEl.querySelectorAll('[data-act="toggle"]').forEach(function (row) {
      row.addEventListener("click", function () {
        var id = row.getAttribute("data-id");
        if (selectDraft.selected[id]) {
          delete selectDraft.selected[id];
          row.classList.remove("is-selected");
        } else {
          selectDraft.selected[id] = true;
          row.classList.add("is-selected");
        }
      });
    });
    pageEl.querySelector('[data-act="add-members"]').addEventListener("click", function () {
      var ids = Object.keys(selectDraft.selected);
      if (!ids.length) { pop(); return; }
      var g = findGroup(data.groupId);
      if (g) {
        ids.forEach(function (id) { if (g.members.indexOf(id) < 0) g.members.push(id); });
        save();
      }
      // 回到群详情
      viewStack = [
        { view: "list", data: {} },
        { view: "group-detail", data: { id: data.groupId } }
      ];
      render();
    });
  }

  /* ========================================================================
     视图 · 搜索聊天记录
     ======================================================================== */
  function viewSearchHistory(data) {
    var left = '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>';
    var title = "搜索聊天记录";
    var html = navBar({ title: title, left: left });

    html += '<div class="scroll">';

    // 搜索栏
    html += '<div class="search-bar-wrap">';
    html += '<div class="search-input-wrap">' +
      '<input type="text" class="search-input" id="sh-keyword" ' +
      'placeholder="输入关键词搜索…" autocomplete="off">' +
      '</div>';
    html += '<div class="search-date-row">' +
      '<input type="text" class="search-date-input" id="sh-date" ' +
      'placeholder="按日期搜索，格式：2026年8月26日" autocomplete="off">' +
      '</div>';
    html += '</div>';

    html += '<div class="search-hint">可按关键词或日期搜索 · 两者可同时使用</div>';

    // 搜索结果区域
    html += '<div class="search-results" id="sh-results">';
    html += '<div class="search-empty" id="sh-empty">' +
      '<div class="search-empty-icon">' + I.svg("search", 30) + '</div>' +
      '<div>输入关键词或日期开始搜索</div>' +
      '</div>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  function bindSearchHistory(data) {
    var keywordInput = pageEl.querySelector("#sh-keyword");
    var dateInput = pageEl.querySelector("#sh-date");
    var resultsEl = pageEl.querySelector("#sh-results");

    function doSearch() {
      var keyword = keywordInput.value || "";
      var date = dateInput.value || "";

      if (!keyword.trim() && !date.trim()) {
        resultsEl.innerHTML = '<div class="search-empty" id="sh-empty">' +
          '<div class="search-empty-icon">' + I.svg("search", 30) + '</div>' +
          '<div>输入关键词或日期开始搜索</div>' +
          '</div>';
        return;
      }

      var results = [];
      if (window.MineChat && MineChat.searchHistory) {
        results = MineChat.searchHistory(data.type, data.id, {
          keyword: keyword,
          date: date
        });
      }

      if (results.length === 0) {
        resultsEl.innerHTML = '<div class="search-empty">' +
          '<div class="search-empty-icon">' + I.svg("search", 30) + '</div>' +
          '<div>未找到匹配的聊天记录</div>' +
          '</div>';
        return;
      }

      var html = "";
      var kw = keyword.trim().toLowerCase();
      results.forEach(function (r) {
        // 图片消息显示"[图片]"
        var text;
        if (r.isImage) {
          text = "[图片]";
        } else {
          // 高亮关键词
          text = escapeHtml(r.text);
          if (kw) {
            var safeKw = escapeHtml(kw);
            var reg = new RegExp("(" + safeKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
            text = text.replace(reg, '<span class="sr-highlight">$1</span>');
          }
        }

        // 自动回复标记
        var autoTag = r.isAutoReply ? '<span class="auto-reply-tag" style="font-size:10px;">自动回复</span> ' : '';

        // 发送者头像
        var avatarMarkup = "";
        if (r.from === "me") {
          // 使用"我"的首字头像
          avatarMarkup = '<div class="avatar avatar-gen sr-avatar">我</div>';
        } else {
          /* 一对一聊天：用会话联系人 ID 查找，而非 r.from，
             与 msgRowHTML 中 ctx.id 的逻辑一致 */
          var lookupId = (data.type === "contact") ? data.id : r.from;
          var senderContact = findContact(lookupId);
          if (!senderContact && r.senderName) {
            senderContact = findContactByName(r.senderName);
          }
          avatarMarkup = avatarHTML(senderContact || { name: r.senderName || "?", avatar: r.senderAvatar }, 24, "sr-avatar");
        }

        var name = r.from === "me" ? "我" : (r.senderName || "未知");
        var d = new Date(r.time);
        var h = d.getHours(), m = d.getMinutes();
        var timeStr = (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;

        html += '<div class="search-result-item" data-msg-index="' + r.index + '">' +
          '<div class="sr-header">' +
          avatarMarkup +
          '<span class="sr-name">' + escapeHtml(name) + '</span>' +
          '<span class="sr-time">' + timeStr + '</span>' +
          '</div>' +
          '<div class="sr-text">' + autoTag + text + '</div>' +
          '</div>';
      });

      resultsEl.innerHTML = html;

      // 绑定结果点击 → 打开聊天
      resultsEl.querySelectorAll(".search-result-item").forEach(function (item) {
        item.addEventListener("click", function () {
          // 打开对应聊天
          if (data.type === "contact" && window.MineChat) {
            MineChat.openContact(data.id);
          } else if (data.type === "group" && window.MineChat) {
            MineChat.openGroup(data.id);
          }
        });
      });
    }

    // 防抖搜索
    var debounceTimer = null;
    function debouncedSearch() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(doSearch, 300);
    }

    if (keywordInput) keywordInput.addEventListener("input", debouncedSearch);
    if (dateInput) dateInput.addEventListener("input", debouncedSearch);
  }

  /* ========================================================================
     渲染分发
     ======================================================================== */
  function render() {
    var top = viewStack[viewStack.length - 1];
    if (!top) { resetTo("list"); return; }
    var html = "";
    switch (top.view) {
      case "list":           html = viewList(); break;
      case "profile":        html = viewProfile(top.data); break;
      case "search-history": html = viewSearchHistory(top.data); break;
      case "status-edit":    html = viewStatusEdit(top.data); break;
      case "edit":           html = viewEdit(top.data); break;
      case "group-select":   html = viewGroupSelect(); break;
      case "group-detail":   html = viewGroupDetail(top.data); break;
      case "group-edit":     html = viewGroupEdit(top.data); break;
      case "group-add":      html = viewGroupAdd(top.data); break;
      default:               html = viewList();
    }
    pageEl.innerHTML = html;
    bindEvents(top);
  }

  function bindEvents(top) {
    // 返回
    pageEl.querySelectorAll('[data-act="back"]').forEach(function (b) {
      b.addEventListener("click", pop);
    });

    switch (top.view) {
      case "list":
        pageEl.querySelector('[data-act="add"]').addEventListener("click", function () {
          push("edit", {});
        });
        pageEl.querySelector('[data-act="group-create"]').addEventListener("click", function () {
          push("group-select", {});
        });
        pageEl.querySelectorAll('[data-act="detail"]').forEach(function (row) {
          row.addEventListener("click", function () {
            push("profile", { id: row.getAttribute("data-id") });
          });
        });
        pageEl.querySelectorAll('[data-act="group-detail"]').forEach(function (row) {
          row.addEventListener("click", function () {
            push("group-detail", { id: row.getAttribute("data-id") });
          });
        });
        break;
      case "profile":        bindProfile(top.data); break;
      case "search-history": bindSearchHistory(top.data); break;
      case "status-edit":    bindStatusEdit(top.data); break;
      case "edit":         bindEdit(top.data); break;
      case "group-select":  bindGroupSelect(); break;
      case "group-detail":  bindGroupDetail(top.data); break;
      case "group-edit":    bindGroupEdit(top.data); break;
      case "group-add":    bindGroupAdd(top.data); break;
    }

    // 键盘可达性
    pageEl.querySelectorAll('[role="button"][tabindex="0"]').forEach(function (el) {
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); }
      });
    });
  }

  /* ========================================================================
     入口
     ======================================================================== */
  function open() {
    if (!pageEl) pageEl = document.getElementById("page-contacts");
    if (!pageEl) return;
    load();
    // 检查是否该执行每小时状态随机切换
    maybeShuffleAll();
    viewStack = [{ view: "list", data: {} }];
    render();
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("contacts");
  }

  // 每分钟检查一次是否到切换时间
  setInterval(function () {
    if (state.contacts.length > 0) {
      maybeShuffleAll();
    }
  }, 60000);

  /* ---------------- 注册页面钩子（链式，不覆盖其他模块） ---------------- */
  window.MineApp = window.MineApp || {};
  var prevPage = window.MineApp.page;
  window.MineApp.page = function (id) {
    if (id === "contacts") { open(); return true; }
    return prevPage ? prevPage(id) : false;
  };

  return {
    open: open,
    // 打开联系人主页（供聊天模块调用）
    openProfile: function (contactId, senderName) {
      // 确保 pageEl 已初始化
      if (!pageEl) pageEl = document.getElementById("page-contacts");
      if (pageEl) {
        resetTo("profile", { id: contactId, name: senderName });
        if (window.MineApp && MineApp.switchPage) MineApp.switchPage("contacts");
      } else {
        open();
        resetTo("profile", { id: contactId, name: senderName });
        if (window.MineApp && MineApp.switchPage) MineApp.switchPage("contacts");
      }
    },
    // 仅加载数据到内存（不渲染页面），供其他模块调用
    loadData: function () { load(); },
    // 保存数据到 localStorage，供其他模块调用
    save: save,
    getState: function () { return JSON.parse(JSON.stringify(state)); },
    // 暴露给聊天模块使用
    findContact: findContact,
    findContactByName: findContactByName,
    findGroup: findGroup,
    avatarHTML: avatarHTML,
    groupAvatarHTML: groupAvatarHTML,
    firstChar: firstChar,
    escapeHtml: escapeHtml,
    // 手动触发全部状态随机切换
    shuffleAllNow: shuffleAllNow
  };
})();
