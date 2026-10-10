/* ========================================================================
   Mine · 朋友圈模块
   ------------------------------------------------------------------------
   功能：
   · 参考微信朋友圈的视觉框架与基础交互
   · 动态流（文字 / 图片九宫格 / 定位 / 时间）
   · 点赞 / 评论交互结构（预留扩展）
   · 发表动态编辑器（文字 + 图片占位）
   数据层 / 渲染层 / 事件层 三层分离，方便后续扩展：
     - addPost / deletePost / addComment / toggleLike 可直接复用
     - POST_TYPES 可扩展视频、链接等新类型
     - IMAGE_GRID 可调整九宫格布局规则
   接入：通过 MineApp.page("moments") 钩子接管。
   ======================================================================== */

window.MineMoments = (function () {
  "use strict";

  var I = window.MineIcons;
  var pageEl = null;

  /* ========================================================================
     数据层
     ======================================================================== */

  var STORE_KEY = "mine.moments.v1";
  var COVER_KEY = "mine.moments.cover";

  /* 动态数据结构：
     {
       id:        唯一标识
       authorId:  作者 ID（联系人 ID 或 "me"）
       authorName: 作者昵称
       authorAvatar: 作者头像 URL（可选）
       text:      文字内容
       images:    图片 URL 数组（0~9 张）
       location:  定位文字（可选）
       timestamp: 时间戳
       likes:     点赞用户 ID 数组 [{ id, name }]
       comments:  评论数组 [{ id, name, text, timestamp }]
       type:      动态类型（text / image，未来可扩展 video / link 等）
     }
  */
  var posts = [];
  var currentView = "feed";   // "feed" | "composer"
  var commentTargetId = null; // 当前正在评论的动态 ID

  /* ========================================================================
     扩展点：动态类型注册表
     ------------------------------------------------------------------------
     后续可在此添加新类型，渲染层会根据 type 选择不同的内容渲染逻辑。
     ======================================================================== */
  var POST_TYPES = {
    text:  { label: "文字", icon: "edit" },
    image: { label: "图片", icon: "image" }
    // 预留：video, link, article ...
  };

  /* ========================================================================
     数据持久化
     ======================================================================== */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) posts = JSON.parse(raw) || [];
    } catch (e) {}
    if (!posts) posts = [];
    loadContactInteractions();
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(posts)); } catch (e) {}
  }

  /* 封面图持久化（base64 存 localStorage） */
  function loadCover() {
    try { return localStorage.getItem(COVER_KEY) || null; } catch (e) { return null; }
  }
  function saveCover(dataUrl) {
    try { localStorage.setItem(COVER_KEY, dataUrl); } catch (e) {
      showToast("封面图片过大，无法保存");
    }
  }

  /* ========================================================================
     联系人朋友圈交互存储（用户点赞/评论 + 联系人自动回复）
     ------------------------------------------------------------------------
     · 联系人朋友圈动态是每次渲染时动态生成的，不持久化
     · 但用户对联系人朋友圈的点赞/评论需要持久化
     · 联系人对用户评论的自动回复也需要持久化
     · 存储键：postId → { likes, comments, autoReplies }
     ======================================================================== */
  var CONTACT_INT_KEY = "mine.moments.contactInteractions";
  var contactInteractions = {};

  function loadContactInteractions() {
    try {
      var raw = localStorage.getItem(CONTACT_INT_KEY);
      if (raw) contactInteractions = JSON.parse(raw) || {};
    } catch (e) {}
    if (!contactInteractions) contactInteractions = {};
  }

  function saveContactInteractions() {
    try { localStorage.setItem(CONTACT_INT_KEY, JSON.stringify(contactInteractions)); } catch (e) {}
  }

  function getContactInteraction(postId) {
    if (!contactInteractions[postId]) {
      contactInteractions[postId] = {
        likes: [],
        comments: [],
        autoReplies: { generated: true, replies: [] }
      };
    }
    return contactInteractions[postId];
  }

  /* 从 "cm_<contactId>_<momentPostTime>" 中提取 contactId */
  function extractContactId(postId) {
    var rest = postId.substring(3); // 去掉 "cm_" 前缀
    var lastUnderscore = rest.lastIndexOf("_");
    if (lastUnderscore > 0) return rest.substring(0, lastUnderscore);
    return rest;
  }

  /* ========================================================================
     联系人自动回复生成
     ------------------------------------------------------------------------
     · 用户评论联系人朋友圈后触发
     · 3 次独立 60% 概率，任一成功则回复
     · 回复时间在评论后 1min~24h 区间随机
     · 回复内容从该联系人朋友圈字符/emoji字卡 + 聊天字符字卡随机组合 1~5 条
     ======================================================================== */
  function generateContactAutoReply(postId, contactId, userComment) {
    var C = window.MineContacts;
    if (!C || !C.findContact) return;
    var c = C.findContact(contactId);
    if (!c) return;

    var interaction = getContactInteraction(postId);

    // 3 次独立 60% 评论机会
    var willReply = false;
    for (var i = 0; i < 3; i++) {
      if (Math.random() < 0.60) { willReply = true; break; }
    }
    if (!willReply) return;

    // 构建回复内容池：朋友圈字符/emoji字卡 + 聊天字符字卡
    var pool = [];
    (c.momentCards || []).forEach(function (mc) {
      if (mc.type === "text" || mc.type === "emoji") {
        pool.push(mc.content);
      }
    });
    (c.cards || []).forEach(function (cc) {
      if (typeof cc === "string" && cc.indexOf("data:image/") !== 0) {
        pool.push(cc);
      }
    });
    if (pool.length === 0) return;

    // 随机组合 1~5 条
    var count = Math.floor(Math.random() * 5) + 1;
    var parts = [];
    for (var j = 0; j < count; j++) {
      parts.push(pool[Math.floor(Math.random() * pool.length)]);
    }

    var MIN = 60000;
    var H24 = 24 * 3600000;
    var replyDelay = MIN + Math.floor(Math.random() * (H24 - MIN));

    interaction.autoReplies.replies.push({
      replyTo: userComment.id,
      replyToName: userComment.name,
      id: c.id,
      name: c.name,
      text: parts.join(""),
      timestamp: userComment.timestamp + replyDelay
    });
    // 新增自动回复时刷新通知角标
    if (window.MineNotify) MineNotify.refreshBadges();
  }

  /* ========================================================================
     工具函数
     ======================================================================== */
  function uid() { return "m_" + Date.now() + "_" + Math.floor(Math.random() * 1000); }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* 相对时间格式化 */
  function timeAgo(ts) {
    var now = Date.now();
    var diff = now - ts;
    var min = 60 * 1000;
    var hour = 60 * min;
    var day = 24 * hour;

    if (diff < min) return "刚刚";
    if (diff < hour) return Math.floor(diff / min) + "分钟前";
    if (diff < day) return Math.floor(diff / hour) + "小时前";
    if (diff < 7 * day) return Math.floor(diff / day) + "天前";

    var d = new Date(ts);
    var month = d.getMonth() + 1;
    var date = d.getDate();
    return month + "月" + date + "日";
  }

  /* 获取"我"的信息 */
  function getMyInfo() {
    var name = "Mine";
    var avatar = null;
    try {
      var raw = localStorage.getItem("mine.me.v1");
      if (raw) {
        var me = JSON.parse(raw);
        if (me) {
          if (me.name) name = me.name;
          if (me.avatar) avatar = me.avatar;
        }
      }
    } catch (e) {}
    return { id: "me", name: name, avatar: avatar };
  }

  /* 获取头像 HTML */
  function avatarHTML(item, size, cls) {
    var s = size || 40;
    var c = cls || "moment-avatar";
    if (item && item.avatar) {
      return '<div class="' + c + '" style="width:' + s + 'px;height:' + s + 'px"><img src="' + escapeHtml(item.avatar) + '"></div>';
    }
    var first = (item && item.name || "?").charAt(0);
    return '<div class="' + c + '" style="width:' + s + 'px;height:' + s + 'px">' + escapeHtml(first) + '</div>';
  }

  /* 图片压缩：通过 canvas 缩小到 maxWidth，减少 localStorage 占用 */
  function compressImage(dataUrl, maxWidth, callback) {
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (w <= maxWidth) { callback(null); return; } // 无需压缩
      var scale = maxWidth / w;
      var canvas = document.createElement("canvas");
      canvas.width = maxWidth;
      canvas.height = Math.round(h * scale);
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        callback(canvas.toDataURL("image/jpeg", 0.82));
      } catch (e) {
        callback(null);
      }
    };
    img.onerror = function () { callback(null); };
    img.src = dataUrl;
  }

  /* ========================================================================
     Toast
     ======================================================================== */
  var toastTimer = null;
  function showToast(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    var existing = document.querySelector(".moments-toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "moments-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add("is-show"); });
    toastTimer = setTimeout(function () {
      toast.classList.remove("is-show");
      setTimeout(function () { toast.remove(); }, 300);
    }, 1800);
  }

  /* ========================================================================
     联系人朋友圈动态 → 24小时概率发送机制
     ------------------------------------------------------------------------
     每个联系人每 24 小时：
       · 75% 概率发送，25% 不发送
       · 若发送，文字类型分配：
           50% 单条字符字卡
           20% 多条字符组合（上限为字符字卡总数的20%，用标点/emoji衔接）
           30% 单个 emoji 字卡
       · 若发送，20% 概率搭配图片（1~9张，从图片字卡随机均等抽取）
     缓存：结果存入 c.momentPost，每 24h 重新生成
     ======================================================================== */
  var DAY_MS = 24 * 60 * 60 * 1000;

  function shuffleArr(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function generateContactMomentPost(c) {
    var mc = c.momentCards || [];
    var textCards = mc.filter(function (card) { return card.type === "text"; });
    var emojiCards = mc.filter(function (card) { return card.type === "emoji"; });
    var imageCards = mc.filter(function (card) { return card.type === "image"; });

    // 无字符卡且无 emoji 卡 → 无法发送
    if (textCards.length === 0 && emojiCards.length === 0) return null;

    // 25% 不发送
    if (Math.random() < 0.25) return null;

    var text = "";
    var images = [];

    // 文字类型分配
    var rand = Math.random();
    if (rand < 0.50) {
      /* —— 50%：单条字符字卡 —— */
      if (textCards.length > 0) {
        text = textCards[Math.floor(Math.random() * textCards.length)].content;
      } else {
        // 无字符卡，回退到 emoji
        text = emojiCards[Math.floor(Math.random() * emojiCards.length)].content;
      }
    } else if (rand < 0.70) {
      /* —— 20%：多条字符组合 —— */
      if (textCards.length >= 2) {
        // 组合上限 = 字符字卡总数的 20%（至少 2）
        var maxCount = Math.max(2, Math.ceil(textCards.length * 0.20));
        // 在 [2, maxCount] 内随机取条数
        var count = Math.floor(Math.random() * (maxCount - 1)) + 2;
        count = Math.min(count, textCards.length);
        // 随机抽取 count 张不同字符字卡
        var picked = shuffleArr(textCards).slice(0, count);
        // 用标点 / emoji 衔接
        var seps = ["，", "。", "……", "！"];
        var parts = [];
        for (var i = 0; i < picked.length; i++) {
          parts.push(picked[i].content);
          if (i < picked.length - 1) {
            // 随机选衔接符：标点或 emoji（emoji 可用时约 1/5 概率）
            if (emojiCards.length > 0 && Math.random() < 0.20) {
              parts.push(emojiCards[Math.floor(Math.random() * emojiCards.length)].content);
            } else {
              parts.push(seps[Math.floor(Math.random() * seps.length)]);
            }
          }
        }
        text = parts.join("");
      } else {
        // 少于 2 张字符卡，回退到单条
        text = textCards.length === 1 ? textCards[0].content :
               emojiCards[Math.floor(Math.random() * emojiCards.length)].content;
      }
    } else {
      /* —— 30%：单个 emoji 字卡 —— */
      if (emojiCards.length > 0) {
        text = emojiCards[Math.floor(Math.random() * emojiCards.length)].content;
      } else {
        // 无 emoji，回退到字符
        text = textCards[Math.floor(Math.random() * textCards.length)].content;
      }
    }

    // 20% 概率搭配图片（1~9 张，均等随机）
    if (imageCards.length > 0 && Math.random() < 0.20) {
      var imgCount = Math.floor(Math.random() * 9) + 1;
      imgCount = Math.min(imgCount, imageCards.length);
      images = shuffleArr(imageCards).slice(0, imgCount).map(function (card) {
        return card.content;
      });
    }

    return {
      text: text,
      images: images,
      timestamp: Date.now() - Math.floor(Math.random() * 3600000)
    };
  }

  function getContactMomentPosts() {
    var C = window.MineContacts;
    if (!C || !C.loadData) return [];
    C.loadData();
    // getState() 返回深拷贝，仅用于遍历联系人 ID
    // 必须用 findContact() 获取实际引用才能持久化修改
    var stateCopy = (C.getState && C.getState()) || { contacts: [] };
    var result = [];
    stateCopy.contacts.forEach(function (cCopy) {
      var c = C.findContact ? C.findContact(cCopy.id) : null;
      if (!c) return;
      var mc = c.momentCards || [];
      if (mc.length === 0) return;

      // 24h 缓存：仅用 momentPostTime 判断是否需要重新生成
      // momentPost 为 null（25%不发）时，该决策也应保持 24h
      var now = Date.now();
      var needRegen = !c.momentPostTime ||
        (now - c.momentPostTime >= DAY_MS);

      if (needRegen) {
        // 归档旧动态到历史记录
        if (c.momentPost) {
          if (!c.momentHistory) c.momentHistory = [];
          c.momentHistory.unshift({
            text: c.momentPost.text,
            images: c.momentPost.images || [],
            timestamp: c.momentPost.timestamp
          });
          // 限制历史记录上限，避免无限增长
          if (c.momentHistory.length > 200) {
            c.momentHistory = c.momentHistory.slice(0, 200);
          }
        }
        // 生成新动态（可能为 null = 不发送）
        var generated = generateContactMomentPost(c);
        c.momentPost = generated;
        c.momentPostTime = now;
        // 保存到 localStorage（现在修改的是实际引用）
        if (C.save) C.save();
      }

      // 有动态则加入结果
      if (c.momentPost) {
        var post = c.momentPost;
        var postId = "cm_" + c.id + "_" + c.momentPostTime;
        var stored = contactInteractions[postId];
        result.push({
          id: postId,
          authorId: c.id,
          authorName: c.name,
          authorAvatar: c.avatar,
          text: post.text || "",
          images: post.images || [],
          location: null,
          timestamp: post.timestamp,
          likes: (stored && stored.likes) ? stored.likes.slice() : [],
          comments: (stored && stored.comments) ? stored.comments.slice() : [],
          autoInteractions: {
            generated: true,
            likes: [],
            comments: (stored && stored.autoReplies) ? (stored.autoReplies.replies || []) : []
          },
          type: (post.images && post.images.length > 0) ? "image" : "text",
          isContactMoment: true
        });
      }
    });
    return result;
  }

  /* 合并我的动态 + 联系人动态，按时间排序 */
  function getMergedPosts() {
    var contactPosts = getContactMomentPosts();

    // 为我的每条朋友圈生成自动点赞评论（仅一次）
    var needSave = false;
    posts.forEach(function (post) {
      if (!post.autoInteractions || !post.autoInteractions.generated) {
        generateAutoInteractions(post);
        needSave = true;
      }
    });
    if (needSave) save();

    var all = posts.concat(contactPosts);
    all.sort(function (a, b) { return b.timestamp - a.timestamp; });
    return all;
  }

  /* ========================================================================
     联系人自动点赞评论生成
     ------------------------------------------------------------------------
     · 100% 点赞，时间在 1min~24h 区间随机
     · 3 次独立 60% 概率评论机会，窗口 1min~48h
     · 评论内容从朋友圈字符/emoji字卡 + 聊天字符字卡随机组合 1~5 条
     ======================================================================== */
  function generateAutoInteractions(post) {
    var C = window.MineContacts;
    if (!C || !C.loadData) return;
    C.loadData();
    var stateCopy = (C.getState && C.getState()) || { contacts: [] };

    var postTime = post.timestamp;
    var MIN = 60000;
    var H24 = 24 * 3600000;
    var H48 = 48 * 3600000;

    var likes = [];
    var comments = [];

    stateCopy.contacts.forEach(function (cCopy) {
      var c = C.findContact ? C.findContact(cCopy.id) : null;
      if (!c) return;

      // —— 100% 点赞 ——
      var likeDelay = MIN + Math.floor(Math.random() * (H24 - MIN));
      likes.push({
        id: c.id,
        name: c.name,
        timestamp: postTime + likeDelay
      });

      // —— 3 次独立 60% 评论机会 ——
      var willComment = false;
      for (var i = 0; i < 3; i++) {
        if (Math.random() < 0.60) { willComment = true; break; }
      }
      if (!willComment) return;

      // 构建评论内容池：朋友圈字符/emoji字卡 + 聊天字符字卡
      var pool = [];
      (c.momentCards || []).forEach(function (mc) {
        if (mc.type === "text" || mc.type === "emoji") {
          pool.push(mc.content);
        }
      });
      (c.cards || []).forEach(function (cc) {
        if (typeof cc === "string" && cc.indexOf("data:image/") !== 0) {
          pool.push(cc);
        }
      });

      if (pool.length === 0) return;

      // 随机组合 1~5 条
      var count = Math.floor(Math.random() * 5) + 1;
      var parts = [];
      for (var j = 0; j < count; j++) {
        parts.push(pool[Math.floor(Math.random() * pool.length)]);
      }

      var commentDelay = MIN + Math.floor(Math.random() * (H48 - MIN));
      comments.push({
        id: c.id,
        name: c.name,
        text: parts.join(""),
        timestamp: postTime + commentDelay
      });
    });

    post.autoInteractions = {
      generated: true,
      likes: likes,
      comments: comments
    };
  }

  /* 获取可见的点赞列表（自动 + 用户，按时间过滤） */
  function getVisibleLikes(post) {
    var now = Date.now();
    var auto = [];
    if (post.autoInteractions && post.autoInteractions.likes) {
      auto = post.autoInteractions.likes.filter(function (l) {
        return l.timestamp <= now;
      });
    }
    // 合并用户点赞（去重）
    var userIds = {};
    var userLikes = (post.likes || []).filter(function (l) {
      if (userIds[l.id]) return false;
      userIds[l.id] = true;
      return true;
    });
    return auto.concat(userLikes);
  }

  /* 获取可见的评论列表（自动 + 用户，按时间排序） */
  function getVisibleComments(post) {
    var now = Date.now();
    var auto = [];
    if (post.autoInteractions && post.autoInteractions.comments) {
      auto = post.autoInteractions.comments.filter(function (c) {
        return c.timestamp <= now;
      });
    }
    var merged = auto.concat(post.comments || []);
    merged.sort(function (a, b) {
      return (a.timestamp || 0) - (b.timestamp || 0);
    });
    return merged;
  }

  /* ========================================================================
     渲染层
     ======================================================================== */

  /* ---------- 主页面（动态流） ---------- */
  function viewMain() {
    var html = '';
    var me = getMyInfo();

    // 导航栏
    html += '<div class="moments-nav">';
    html += '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>';
    html += '<span class="nav-title">朋友圈</span>';
    html += '<div class="nav-camera" data-act="compose">' + I.svg("camera", 22) + '</div>';
    html += '</div>';

    html += '<div class="moments-page">';

    // 隐藏的文件选择 input（用于选封面图）
    html += '<input type="file" accept="image/*" id="moments-cover-input" style="display:none">';

    // 可滚动区
    html += '<div class="moments-scroll" id="moments-scroll">';

    // 封面横幅（可点击更换）
    var coverImg = loadCover();
    html += '<div class="moments-cover" id="moments-cover" data-act="change-cover">';
    if (coverImg) {
      html += '<img class="moments-cover-img" src="' + escapeHtml(coverImg) + '">';
    } else {
      html += '<div class="moments-cover-empty">点击设置封面</div>';
    }
    html += '<div class="moments-cover-hint">' + I.svg("camera", 14) + (coverImg ? '更换封面' : '设置封面') + '</div>';
    html += '</div>';

    // 用户信息浮层
    html += '<div class="moments-user-bar">';
    html += '<span class="moments-user-name">' + escapeHtml(me.name) + '</span>';
    html += avatarHTML(me, 64, "moments-user-avatar");
    html += '</div>';

    // 动态流（我的动态 + 联系人动态）
    var mergedPosts = getMergedPosts();
    html += '<div class="moments-feed" id="moments-feed">';
    if (mergedPosts.length === 0) {
      html += '<div class="moments-empty">';
      html += '<div class="moments-empty-icon">📭</div>';
      html += '<div class="moments-empty-text">还没有动态<br>点击右上角相机发表第一条<br>或在联系人主页添加朋友圈字卡</div>';
      html += '</div>';
    } else {
      mergedPosts.forEach(function (post) {
        html += postHTML(post);
      });
    }
    html += '</div>'; // .moments-feed

    html += '</div>'; // .moments-scroll

    // 评论输入栏（默认隐藏，点击评论时显示）
    html += '<div class="moments-comment-bar" id="moments-comment-bar">';
    html += '<input type="text" class="moments-comment-input" id="moments-comment-input" placeholder="评论…" maxlength="200">';
    html += '<button class="moments-comment-send" id="moments-comment-send">发送</button>';
    html += '</div>';

    html += '</div>'; // .moments-page
    return html;
  }

  /* ---------- 单条动态 HTML ---------- */
  function postHTML(post) {
    var html = '';
    var author = { name: post.authorName, avatar: post.authorAvatar };
    var me = getMyInfo();
    var visibleLikes = getVisibleLikes(post);
    var visibleComments = getVisibleComments(post);
    var isLiked = (post.likes || []).some(function (l) { return l.id === "me"; });

    html += '<div class="moment-item" data-post-id="' + escapeHtml(post.id) + '">';
    html += avatarHTML(author, 40, "moment-avatar");

    html += '<div class="moment-body">';

    // 作者名
    html += '<div class="moment-author">' + escapeHtml(post.authorName) + '</div>';

    // 文字内容
    if (post.text) {
      // emoji 与普通文字同等大小显示
      var isEmoji = post.type === "emoji" || (post.text.length <= 4 && /[\u{1F000}-\u{1FFFF}]/u.test(post.text));
      html += '<div class="moment-text' + (isEmoji ? ' moment-emoji' : '') + '">' + escapeHtml(post.text) + '</div>';
    }

    // 图片九宫格
    if (post.images && post.images.length > 0) {
      var n = post.images.length;
      html += '<div class="moment-images count-' + Math.min(n, 9) + '">';
      post.images.slice(0, 9).forEach(function (src) {
        html += '<div class="moment-img"><img src="' + escapeHtml(src) + '"></div>';
      });
      html += '</div>';
    }

    // 定位
    if (post.location) {
      html += '<div class="moment-location">' + I.svg("mapPin", 12) + escapeHtml(post.location) + '</div>';
    }

    // 互动区（点赞 + 评论）
    if (visibleLikes.length > 0 || visibleComments.length > 0) {
      html += '<div class="moment-interact">';

      // 点赞列表
      if (visibleLikes.length > 0) {
        html += '<div class="moment-likes">';
        html += '<span class="moments-likes-icon">' + I.svg("heart", 12) + '</span>';
        var names = visibleLikes.map(function (l) {
          return '<span class="moment-likes-name">' + escapeHtml(l.name) + '</span>';
        });
        html += names.join('，');
        html += '</div>';
      }

      // 评论列表
      if (visibleComments.length > 0) {
        html += '<div class="moment-comments">';
        visibleComments.forEach(function (c) {
          html += '<div class="moment-comment">';
          html += '<span class="cmt-name">' + escapeHtml(c.name) + '</span>';
          if (c.replyToName) {
            html += '<span class="cmt-reply"> 回复 ' + escapeHtml(c.replyToName) + '：</span>';
          }
          html += escapeHtml(c.text);
          html += '</div>';
        });
        html += '</div>';
      }

      html += '</div>';
    }

    // 时间 + 互动按钮
    html += '<div class="moment-meta">';
    html += '<span class="moment-time">' + timeAgo(post.timestamp) + '</span>';
    html += '<div class="moment-actions">';
    html += '<div class="moment-action-btn" data-act="toggle-actions">' + I.svg("more", 14) + '</div>';
    html += '<div class="moment-action-popup" data-popup="' + escapeHtml(post.id) + '">';
    html += '<div class="moment-action-item' + (isLiked ? ' is-liked' : '') + '" data-act="like" data-post-id="' + escapeHtml(post.id) + '">' + I.svg("heart", 14) + (isLiked ? '已赞' : '赞') + '</div>';
    html += '<div class="moment-action-item" data-act="comment" data-post-id="' + escapeHtml(post.id) + '">' + I.svg("chat", 14) + '评论</div>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    html += '</div>'; // .moment-body
    html += '</div>'; // .moment-item
    return html;
  }

  /* ---------- 发表动态编辑器 ---------- */
  function viewComposer() {
    var html = '';

    // 导航栏
    html += '<div class="moments-nav">';
    html += '<button class="nav-btn" data-act="back-feed">' + I.svg("back", 20) + '取消</button>';
    html += '<span class="nav-title">发表动态</span>';
    html += '<span style="width:36px"></span>';
    html += '</div>';

    html += '<div class="moments-composer">';
    html += '<textarea id="composer-text" placeholder="这一刻的想法…" maxlength="500"></textarea>';

    // 图片计数提示
    html += '<div class="moments-composer-count" id="composer-count"></div>';

    // 图片预览区 + 添加块
    html += '<div class="moments-composer-images" id="composer-images">';
    html += '<div class="moments-composer-add" id="composer-add">' + I.svg("image", 24) + '</div>';
    html += '</div>';

    // 隐藏的文件选择 input（多选）
    html += '<input type="file" accept="image/*" multiple id="composer-image-input" style="display:none">';

    // 底部工具栏
    html += '<div class="moments-composer-bar">';
    html += '<div class="moments-composer-tool" data-tool="image">' + I.svg("image", 18) + '</div>';
    html += '<div class="moments-composer-tool" data-tool="location">' + I.svg("mapPin", 18) + '</div>';
    html += '<span class="moments-composer-location" id="composer-location"></span>';
    html += '<button class="moments-composer-send" id="composer-send">发表</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  /* ========================================================================
     事件层
     ======================================================================== */

  /* ---------- 绑定主页面事件 ---------- */
  function bindMain() {
    if (!pageEl) return;

    // 封面点击 → 触发图库选择
    var coverEl = pageEl.querySelector('[data-act="change-cover"]');
    var coverInput = pageEl.querySelector("#moments-cover-input");
    if (coverEl && coverInput) {
      coverEl.addEventListener("click", function () {
        coverInput.click();
      });
      coverInput.addEventListener("change", function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) {
          showToast("请选择图片文件");
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var result = reader.result;
          // 压缩大图：通过 canvas 缩小到最大宽度 750px
          compressImage(result, 750, function (compressed) {
            saveCover(compressed || result);
            pageEl.innerHTML = viewMain();
            bindMain();
            showToast("封面已更新");
          });
        };
        reader.onerror = function () { showToast("读取图片失败"); };
        reader.readAsDataURL(file);
        // 清空 value 允许重复选择同一文件
        coverInput.value = "";
      });
    }

    // 返回
    var backBtn = pageEl.querySelector('[data-act="back"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      if (window.MineApp && MineApp.goHome) MineApp.goHome();
    });

    // 发表按钮（相机图标）
    var composeBtn = pageEl.querySelector('[data-act="compose"]');
    if (composeBtn) composeBtn.addEventListener("click", function () {
      currentView = "composer";
      pageEl.innerHTML = viewComposer();
      bindComposer();
    });

    // 动态互动
    pageEl.querySelectorAll(".moment-action-btn").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var popup = btn.parentElement.querySelector(".moment-action-popup");
        if (!popup) return;
        // 先关闭其他弹窗
        pageEl.querySelectorAll(".moment-action-popup.is-show").forEach(function (p) {
          if (p !== popup) p.classList.remove("is-show");
        });
        popup.classList.toggle("is-show");
      });
    });

    // 点赞
    pageEl.querySelectorAll('[data-act="like"]').forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var postId = btn.getAttribute("data-post-id");
        toggleLike(postId);
        pageEl.innerHTML = viewMain();
        bindMain();
      });
    });

    // 评论
    pageEl.querySelectorAll('[data-act="comment"]').forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var postId = btn.getAttribute("data-post-id");
        openCommentBar(postId);
      });
    });

    // 点击空白关闭弹窗
    pageEl.addEventListener("click", function () {
      pageEl.querySelectorAll(".moment-action-popup.is-show").forEach(function (p) {
        p.classList.remove("is-show");
      });
    });

    // 评论栏发送
    var commentSend = pageEl.querySelector("#moments-comment-send");
    var commentInput = pageEl.querySelector("#moments-comment-input");
    if (commentSend) {
      commentSend.addEventListener("click", function () {
        submitComment();
      });
    }
    if (commentInput) {
      commentInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          submitComment();
        }
      });
    }
  }

  /* ---------- 绑定编辑器事件 ---------- */
  var composerImages = []; // 当前编辑器中选中的图片（data URL 数组）
  var MAX_IMAGES = 9;

  function renderComposerImages() {
    var container = pageEl.querySelector("#composer-images");
    var countEl = pageEl.querySelector("#composer-count");
    if (!container) return;

    var html = '';
    // 已选图片缩略图
    composerImages.forEach(function (src, i) {
      html += '<div class="moments-composer-thumb">';
      html += '<img src="' + escapeHtml(src) + '">';
      html += '<div class="moments-composer-thumb-del" data-del="' + i + '">' + I.svg("close", 10) + '</div>';
      html += '</div>';
    });
    // 添加块（未满 9 张时显示）
    if (composerImages.length < MAX_IMAGES) {
      html += '<div class="moments-composer-add" id="composer-add">' + I.svg("image", 24) + '</div>';
    }
    container.innerHTML = html;

    // 计数提示
    if (countEl) {
      countEl.textContent = composerImages.length > 0 ? (composerImages.length + '/' + MAX_IMAGES + ' 张图片') : '';
    }

    // 绑定删除按钮
    container.querySelectorAll('[data-del]').forEach(function (delBtn) {
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(delBtn.getAttribute("data-del"), 10);
        if (!isNaN(idx)) {
          composerImages.splice(idx, 1);
          renderComposerImages();
        }
      });
    });

    // 绑定添加块点击
    var addBtn = container.querySelector("#composer-add");
    var fileInput = pageEl.querySelector("#composer-image-input");
    if (addBtn && fileInput) {
      addBtn.addEventListener("click", function () { fileInput.click(); });
    }
  }

  function bindComposer() {
    if (!pageEl) return;
    composerImages = []; // 重置

    // 取消返回
    var backBtn = pageEl.querySelector('[data-act="back-feed"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      currentView = "feed";
      pageEl.innerHTML = viewMain();
      bindMain();
    });

    // 图片工具按钮 → 触发文件选择
    var imageTool = pageEl.querySelector('[data-tool="image"]');
    var fileInput = pageEl.querySelector("#composer-image-input");
    if (imageTool && fileInput) {
      imageTool.addEventListener("click", function () { fileInput.click(); });
    }

    // 添加块也触发文件选择
    var addBtn = pageEl.querySelector("#composer-add");
    if (addBtn && fileInput) {
      addBtn.addEventListener("click", function () { fileInput.click(); });
    }

    // 文件选择回调
    if (fileInput) {
      fileInput.addEventListener("change", function (e) {
        var files = e.target.files;
        if (!files || files.length === 0) return;
        var remaining = MAX_IMAGES - composerImages.length;
        if (remaining <= 0) {
          showToast("最多上传 " + MAX_IMAGES + " 张图片");
          return;
        }
        var toProcess = Array.prototype.slice.call(files, 0, remaining);
        if (files.length > remaining) {
          showToast("最多上传 " + MAX_IMAGES + " 张图片，已截取前 " + remaining + " 张");
        }
        var processed = 0;
        toProcess.forEach(function (file) {
          if (!file.type.startsWith("image/")) {
            processed++;
            checkAllDone();
            return;
          }
          var reader = new FileReader();
          reader.onload = function () {
            var result = reader.result;
            compressImage(result, 750, function (compressed) {
              composerImages.push(compressed || result);
              processed++;
              checkAllDone();
            });
          };
          reader.onerror = function () { processed++; checkAllDone(); };
          reader.readAsDataURL(file);
        });
        function checkAllDone() {
          if (processed >= toProcess.length) {
            renderComposerImages();
          }
        }
        fileInput.value = ""; // 允许重复选择
      });
    }

    // 定位按钮（占位）
    var locTool = pageEl.querySelector('[data-tool="location"]');
    if (locTool) {
      locTool.addEventListener("click", function () { showToast("定位功能即将开放"); });
    }

    // 发表
    var sendBtn = pageEl.querySelector("#composer-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", function () {
        var textarea = pageEl.querySelector("#composer-text");
        var text = textarea ? textarea.value.trim() : "";
        if (!text && composerImages.length === 0) {
          showToast("请输入内容或选择图片");
          return;
        }
        var me = getMyInfo();
        var newPost = {
          id: uid(),
          authorId: me.id,
          authorName: me.name,
          authorAvatar: me.avatar,
          text: text,
          images: composerImages.slice(),
          location: null,
          timestamp: Date.now(),
          likes: [],
          comments: [],
          type: composerImages.length > 0 ? "image" : "text"
        };
        posts.unshift(newPost);
        save();
        currentView = "feed";
        composerImages = [];
        pageEl.innerHTML = viewMain();
        bindMain();
        showToast("已发表");
      });
    }
  }

  /* ---------- 评论栏 ---------- */
  function openCommentBar(postId) {
    commentTargetId = postId;
    var bar = pageEl.querySelector("#moments-comment-bar");
    var input = pageEl.querySelector("#moments-comment-input");
    if (bar) bar.classList.add("is-show");
    if (input) {
      input.value = "";
      input.focus();
    }
  }

  function submitComment() {
    if (!commentTargetId) return;
    var input = pageEl.querySelector("#moments-comment-input");
    var text = input ? input.value.trim() : "";
    if (!text) return;

    var me = getMyInfo();
    addComment(commentTargetId, {
      id: uid(),
      name: me.name,
      text: text,
      timestamp: Date.now()
    });

    commentTargetId = null;
    pageEl.innerHTML = viewMain();
    bindMain();
  }

  /* ========================================================================
     数据操作 API（供外部调用 / 未来扩展）
     ======================================================================== */

  function addPost(data) {
    var me = getMyInfo();
    var post = {
      id: data.id || uid(),
      authorId: data.authorId || me.id,
      authorName: data.authorName || me.name,
      authorAvatar: data.authorAvatar || me.avatar,
      text: data.text || "",
      images: data.images || [],
      location: data.location || null,
      timestamp: data.timestamp || Date.now(),
      likes: data.likes || [],
      comments: data.comments || [],
      type: data.type || "text"
    };
    posts.unshift(post);
    save();
    return post;
  }

  function deletePost(id) {
    for (var i = 0; i < posts.length; i++) {
      if (posts[i].id === id) {
        posts.splice(i, 1);
        save();
        return true;
      }
    }
    return false;
  }

  function toggleLike(postId) {
    // 联系人朋友圈动态：使用独立的交互存储
    if (postId.indexOf("cm_") === 0) {
      var interaction = getContactInteraction(postId);
      var me = getMyInfo();
      var idx = -1;
      for (var i = 0; i < interaction.likes.length; i++) {
        if (interaction.likes[i].id === "me") { idx = i; break; }
      }
      if (idx >= 0) {
        interaction.likes.splice(idx, 1);
      } else {
        interaction.likes.push({ id: "me", name: me.name });
      }
      saveContactInteractions();
      return;
    }
    var post = findPost(postId);
    if (!post) return;
    me = getMyInfo();
    idx = -1;
    for (var i = 0; i < post.likes.length; i++) {
      if (post.likes[i].id === "me") { idx = i; break; }
    }
    if (idx >= 0) {
      post.likes.splice(idx, 1);
    } else {
      post.likes.push({ id: "me", name: me.name });
    }
    save();
  }

  function addComment(postId, comment) {
    // 联系人朋友圈动态：存储评论并生成自动回复
    if (postId.indexOf("cm_") === 0) {
      var interaction = getContactInteraction(postId);
      interaction.comments.push(comment);
      // 提取联系人 ID 并生成自动回复
      var contactId = extractContactId(postId);
      generateContactAutoReply(postId, contactId, comment);
      saveContactInteractions();
      return;
    }
    var post = findPost(postId);
    if (!post) return;
    post.comments.push(comment);
    save();
  }

  function findPost(id) {
    for (var i = 0; i < posts.length; i++) {
      if (posts[i].id === id) return posts[i];
    }
    return null;
  }

  /* ========================================================================
     对外接口
     ======================================================================== */

  function open() {
    if (!pageEl) pageEl = document.getElementById("page-moments");
    if (!pageEl) {
      // 回退到 detail 页
      pageEl = document.getElementById("page-detail");
    }
    if (!pageEl) return;
    load();
    currentView = "feed";
    commentTargetId = null;
    pageEl.innerHTML = viewMain();
    bindMain();
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("moments");
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    load();
    pageEl = document.getElementById("page-moments");
  }

  /* ========================================================================
     页面钩子（链式注册）
     ======================================================================== */
  window.MineApp = window.MineApp || {};
  var prevPage = window.MineApp.page;
  window.MineApp.page = function (id) {
    if (id === "moments") { open(); return true; }
    return prevPage ? prevPage(id) : false;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* ========================================================================
     通知接口
     ------------------------------------------------------------------------
     基于时间戳统计"上次查看后新到达"的互动数：
     · 联系人自动点赞/评论用户朋友圈（autoInteractions，有 timestamp）
     · 联系人自动回复用户评论（contactInteractions.autoReplies，有 timestamp）
     ======================================================================== */
  function getUnreadCount() {
    load();
    var lastSeen = (window.MineNotify && MineNotify.getLastSeen) ? MineNotify.getLastSeen("moments") : 0;
    var now = Date.now();
    var count = 0;

    // 用户朋友圈的自动点赞和评论
    posts.forEach(function (p) {
      if (p.authorId !== "me" && p.authorId !== undefined) return;
      if (!p.autoInteractions) return;
      (p.autoInteractions.likes || []).forEach(function (l) {
        if (l.timestamp && l.timestamp <= now && l.timestamp > lastSeen) count++;
      });
      (p.autoInteractions.comments || []).forEach(function (c) {
        if (c.timestamp && c.timestamp <= now && c.timestamp > lastSeen) count++;
      });
    });

    // 联系人自动回复
    Object.keys(contactInteractions).forEach(function (postId) {
      var ci = contactInteractions[postId];
      if (ci.autoReplies && ci.autoReplies.replies) {
        ci.autoReplies.replies.forEach(function (r) {
          if (r.timestamp && r.timestamp <= now && r.timestamp > lastSeen) count++;
        });
      }
    });

    return count;
  }

  /* ---- 公开 API（供其他模块调用 / 未来扩展） ---- */
  return {
    open: open,
    addPost: addPost,
    deletePost: deletePost,
    toggleLike: toggleLike,
    addComment: addComment,
    getPosts: function () { return posts.slice(); },
    getCover: loadCover,
    setCover: saveCover,
    getUnreadCount: getUnreadCount
  };
})();
