/* ========================================================================
   Mine · 联系人朋友圈模块
   ------------------------------------------------------------------------
   功能：
   · 从联系人个人主页进入其朋友圈
   · 管理联系人的朋友圈字卡（字符 / 图片 / emoji 三类）
   · 添加/删除字卡，UI 与聊天字卡管理一致
   · 点击 + 展开类型选择弹窗，再点击收起折叠
   数据：存储在 contact.momentCards 数组中
   接入：通过 MineApp.page("contact-moments") 钩子接管。
   ======================================================================== */

window.MineContactMoments = (function () {
  "use strict";

  var I = window.MineIcons;
  var pageEl = null;
  var currentContactId = null;
  var currentContact = null;

  /* 字卡类型定义 */
  var CARD_TYPES = [
    { key: "text",  label: "字符", icon: "feather" },
    { key: "image", label: "图片", icon: "image" },
    { key: "emoji", label: "emoji", icon: "smile" }
  ];

  /* ========================================================================
     工具
     ======================================================================== */
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function uid() { return "mc_" + Date.now() + "_" + Math.floor(Math.random() * 1000); }

  function firstChar(name) {
    if (!name) return "?";
    return name.charAt(0);
  }

  /* 图片压缩 */
  function compressImage(dataUrl, maxWidth, callback) {
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (w <= maxWidth) { callback(null); return; }
      var scale = maxWidth / w;
      var canvas = document.createElement("canvas");
      canvas.width = maxWidth;
      canvas.height = Math.round(h * scale);
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try { callback(canvas.toDataURL("image/jpeg", 0.82)); } catch (e) { callback(null); }
    };
    img.onerror = function () { callback(null); };
    img.src = dataUrl;
  }

  /* Toast */
  var toastTimer = null;
  function showToast(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    var existing = document.querySelector(".cm-toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "cm-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add("is-show"); });
    toastTimer = setTimeout(function () {
      toast.classList.remove("is-show");
      setTimeout(function () { toast.remove(); }, 300);
    }, 1800);
  }

  /* ========================================================================
     数据操作
     ======================================================================== */
  function getMomentCards() {
    if (!currentContact) return [];
    if (!currentContact.momentCards) currentContact.momentCards = [];
    return currentContact.momentCards;
  }

  function countByType(type) {
    return getMomentCards().filter(function (c) { return c.type === type; }).length;
  }

  function addCard(type, content) {
    if (!content) return;
    var cards = getMomentCards();
    // 去重
    var exists = cards.some(function (c) { return c.content === content; });
    if (exists) { showToast("已存在相同内容"); return false; }
    cards.push({ id: uid(), type: type, content: content });
    saveContact();
    return true;
  }

  function deleteCard(id) {
    var cards = getMomentCards();
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].id === id) {
        cards.splice(i, 1);
        saveContact();
        return true;
      }
    }
    return false;
  }

  function saveContact() {
    if (window.MineContacts && MineContacts.save) MineContacts.save();
  }

  /* ========================================================================
     封面背景图：从图库随机选图，每 24 小时更换一次
     ======================================================================== */
  var COVER_ROTATION_MS = 24 * 60 * 60 * 1000; // 24 小时

  function getContactCover() {
    if (!currentContact) return null;
    var imageCards = getMomentCards().filter(function (card) {
      return card.type === "image" && card.content;
    });
    if (imageCards.length === 0) {
      // 图库无图片，清除残留封面
      if (currentContact.momentCover) {
        currentContact.momentCover = null;
        currentContact.momentCoverTime = 0;
        saveContact();
      }
      return null;
    }

    var now = Date.now();

    // 当前封面是否仍然有效：存在 + 未过期 + 仍在图库中
    var coverValid = currentContact.momentCover &&
      currentContact.momentCoverTime &&
      (now - currentContact.momentCoverTime < COVER_ROTATION_MS) &&
      imageCards.some(function (card) { return card.content === currentContact.momentCover; });

    if (coverValid) return currentContact.momentCover;

    // 随机选一张新图（每张概率相等，可重复）
    var idx = Math.floor(Math.random() * imageCards.length);
    currentContact.momentCover = imageCards[idx].content;
    currentContact.momentCoverTime = now;
    saveContact();
    return currentContact.momentCover;
  }

  /* ========================================================================
     渲染层
     ======================================================================== */
  function viewMain() {
    var html = '';
    var c = currentContact;
    if (!c) return '<div class="cm-page"><div class="cm-empty">联系人不存在</div></div>';

    // 导航栏
    html += '<div class="cm-nav">';
    html += '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>';
    html += '<span class="nav-title">' + escapeHtml(c.name) + '的朋友圈</span>';
    html += '<span style="width:60px"></span>';
    html += '</div>';

    html += '<div class="cm-page">';
    html += '<div class="cm-scroll">';

    // 封面：自动从图库随机选图，每 24h 更换
    var coverImg = getContactCover();
    html += '<div class="cm-cover">';
    if (coverImg) {
      html += '<img class="cm-cover-img" src="' + escapeHtml(coverImg) + '">';
    } else {
      html += '<div class="cm-cover-empty">' + escapeHtml(c.name) + ' 的朋友圈</div>';
    }
    html += '</div>';

    // 用户信息
    html += '<div class="cm-user-bar">';
    html += '<span class="cm-user-name">' + escapeHtml(c.name) + '</span>';
    html += '<div class="cm-user-avatar">';
    if (c.avatar) {
      html += '<img src="' + escapeHtml(c.avatar) + '">';
    } else {
      html += escapeHtml(firstChar(c.name));
    }
    html += '</div>';
    html += '</div>';

    // 字卡管理区
    var cards = getMomentCards();
    var textCount = countByType("text");
    var imgCount = countByType("image");
    var emojiCount = countByType("emoji");

    html += '<div class="cm-group-head">朋友圈字卡 <span class="count">' + cards.length + '</span>';
    html += '<button class="cm-toggle-btn" id="cm-toggle" data-act="toggle">' + I.svg("plus", 18) + '</button>';
    html += '</div>';

    // 字卡类型弹窗（点击 + 时显示）
    html += '<div class="cm-type-popup" id="cm-type-popup">';
    html += '<button class="cm-type-option" data-type="text">' + I.svg("feather", 20) +
      '<span>字符</span><span class="cm-type-count">' + textCount + '</span></button>';
    html += '<button class="cm-type-option" data-type="image">' + I.svg("image", 20) +
      '<span>图片</span><span class="cm-type-count">' + imgCount + '</span></button>';
    html += '<button class="cm-type-option" data-type="emoji">' + I.svg("smile", 20) +
      '<span>emoji</span><span class="cm-type-count">' + emojiCount + '</span></button>';
    html += '</div>';

    // 字卡列表（默认折叠隐藏，选择类型后展示该类型字卡）
    html += '<div class="cm-cards-list" id="cm-cards-list" style="display:none;">';
    html += renderCardsList();
    html += '</div>';

    // 字符添加行（默认隐藏）
    html += '<div class="cm-add-row" id="cm-text-add-row" style="display:none;">';
    html += '<input type="text" class="cm-add-input" id="cm-add-text" placeholder="输入字卡，空格分隔批量添加 · 回车确认">';
    html += '<button class="cm-add-btn" data-act="add-text">' + I.svg("plus", 18) + '</button>';
    html += '</div>';

    // emoji 添加行（默认隐藏）
    html += '<div class="cm-add-row" id="cm-emoji-add-row" style="display:none;">';
    html += '<input type="text" class="cm-add-input" id="cm-add-emoji" placeholder="输入 emoji，如 😊🎉🍃 · 回车确认">';
    html += '<button class="cm-add-btn" data-act="add-emoji">' + I.svg("plus", 18) + '</button>';
    html += '</div>';

    // 图片添加行（默认隐藏）
    html += '<div class="cm-add-row" id="cm-image-add-row" style="display:none;">';
    html += '<button class="cm-image-add-btn" id="cm-image-add-btn">' + I.svg("image", 18) + ' 选择图片</button>';
    html += '</div>';

    // 隐藏文件选择器
    html += '<input type="file" accept="image/*" id="cm-image-file" style="display:none" multiple>';

    html += '<div class="cm-hint">点击 + 展开类型 · 选择类型查看与添加字卡 · 再点击 + 全部折叠</div>';

    // 查看历史朋友圈入口
    var historyCount = (currentContact.momentHistory || []).length + (currentContact.momentPost ? 1 : 0);
    html += '<div class="cm-feed-entry" data-act="view-feed">';
    html += '<div class="cm-feed-entry-icon">' + I.svg("clock", 18) + '</div>';
    html += '<div class="cm-feed-entry-text">';
    html += '<span class="cm-feed-entry-title">历史朋友圈</span>';
    html += '<span class="cm-feed-entry-sub">' + historyCount + ' 条动态 · 按时间排序</span>';
    html += '</div>';
    html += '<span class="chevron">' + I.svg("back", 16) + '</span>';
    html += '</div>';

    html += '</div>'; // .cm-scroll
    html += '</div>'; // .cm-page
    return html;
  }

  function renderCardsList() {
    var cards = getMomentCards();
    if (currentFilterType) {
      cards = cards.filter(function (c) { return c.type === currentFilterType; });
    }
    if (cards.length === 0) {
      var msg = currentFilterType ? '该类型暂无字卡' : '暂无字卡，点击 + 添加';
      return '<div class="cm-empty">' + msg + '</div>';
    }
    var html = '';
    cards.forEach(function (card) {
      html += '<div class="cm-card-item">';
      if (card.type === "text") {
        html += '<span class="cm-card-text">' + escapeHtml(card.content) + '</span>';
      } else if (card.type === "emoji") {
        html += '<span class="cm-card-emoji">' + escapeHtml(card.content) + '</span>';
      } else if (card.type === "image") {
        html += '<img class="cm-card-image-thumb" src="' + escapeHtml(card.content) + '">';
      }
      html += '<button class="cm-card-del" data-del="' + escapeHtml(card.id) + '">' + I.svg("close", 14) + '</button>';
      html += '</div>';
    });
    return html;
  }

  /* ========================================================================
     事件层
     ======================================================================== */
  var currentAddType = null; // "text" | "image" | "emoji" | null
  var currentFilterType = null; // null = 全部, "text"/"image"/"emoji" = 按类型筛选

  function bindMain() {
    if (!pageEl) return;

    // 返回 → 回到联系人主页
    var backBtn = pageEl.querySelector('[data-act="back"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      if (window.MineContacts && currentContactId) {
        MineContacts.openProfile(currentContactId);
      } else if (window.MineApp && MineApp.switchPage) {
        MineApp.switchPage("contacts");
      }
    });

    // 查看历史朋友圈
    var feedEntry = pageEl.querySelector('[data-act="view-feed"]');
    if (feedEntry) feedEntry.addEventListener("click", function () {
      pageEl.innerHTML = viewFeed();
      bindFeed();
    });

    // + 全部折叠/展开
    var toggleBtn = pageEl.querySelector('[data-act="toggle"]');
    var typePopup = pageEl.querySelector("#cm-type-popup");
    if (toggleBtn && typePopup) {
      toggleBtn.addEventListener("click", function () {
        var isOpen = typePopup.classList.contains("is-show");
        if (isOpen) {
          // 全部折叠：关闭弹窗 + 隐藏添加行 + 隐藏字卡列表 + 重置筛选
          typePopup.classList.remove("is-show");
          toggleBtn.classList.remove("is-open");
          hideAllAddRows();
          hideCardsList();
          currentAddType = null;
          currentFilterType = null;
          pageEl.querySelectorAll(".cm-type-option").forEach(function (o) {
            o.style.borderColor = "";
            o.style.color = "";
          });
        } else {
          // 展开：显示类型弹窗
          typePopup.classList.add("is-show");
          toggleBtn.classList.add("is-open");
        }
      });
    }

    // 类型选择：展示该类型字卡 + 对应添加行
    pageEl.querySelectorAll(".cm-type-option").forEach(function (opt) {
      opt.addEventListener("click", function () {
        var type = opt.getAttribute("data-type");
        currentAddType = type;
        currentFilterType = type;
        // 高亮选中
        pageEl.querySelectorAll(".cm-type-option").forEach(function (o) {
          o.style.borderColor = "";
          o.style.color = "";
        });
        opt.style.borderColor = "var(--accent)";
        opt.style.color = "var(--accent)";
        // 显示对应添加行
        hideAllAddRows();
        if (type === "text") {
          showAddRow("cm-text-add-row");
          var input = pageEl.querySelector("#cm-add-text");
          if (input) input.focus();
        } else if (type === "emoji") {
          showAddRow("cm-emoji-add-row");
          var emojiInput = pageEl.querySelector("#cm-add-emoji");
          if (emojiInput) emojiInput.focus();
        } else if (type === "image") {
          showAddRow("cm-image-add-row");
        }
        // 展示并刷新该类型字卡列表
        showCardsList();
        refreshList();
      });
    });

    // 字符添加
    var addTextBtn = pageEl.querySelector('[data-act="add-text"]');
    var addTextInput = pageEl.querySelector("#cm-add-text");
    if (addTextBtn) {
      addTextBtn.addEventListener("click", function () { doAddText(); });
    }
    if (addTextInput) {
      addTextInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doAddText(); }
      });
    }

    // emoji 添加
    var addEmojiBtn = pageEl.querySelector('[data-act="add-emoji"]');
    var addEmojiInput = pageEl.querySelector("#cm-add-emoji");
    if (addEmojiBtn) {
      addEmojiBtn.addEventListener("click", function () { doAddEmoji(); });
    }
    if (addEmojiInput) {
      addEmojiInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doAddEmoji(); }
      });
    }

    // 图片添加
    var imageAddBtn = pageEl.querySelector("#cm-image-add-btn");
    var imageFile = pageEl.querySelector("#cm-image-file");
    if (imageAddBtn && imageFile) {
      imageAddBtn.addEventListener("click", function () { imageFile.click(); });
      imageFile.addEventListener("change", function (e) {
        var files = e.target.files;
        if (!files || files.length === 0) return;
        var processed = 0;
        var total = files.length;
        Array.prototype.forEach.call(files, function (file) {
          if (!file.type.startsWith("image/")) { processed++; checkDone(); return; }
          var reader = new FileReader();
          reader.onload = function () {
            var result = reader.result;
            compressImage(result, 750, function (compressed) {
              addCard("image", compressed || result);
              processed++;
              checkDone();
            });
          };
          reader.onerror = function () { processed++; checkDone(); };
          reader.readAsDataURL(file);
        });
        function checkDone() {
          if (processed >= total) {
            refreshList();
            showToast("已添加 " + total + " 张图片");
          }
        }
        imageFile.value = "";
      });
    }

    // 删除字卡
    bindDeleteButtons();
  }

  function doAddText() {
    var input = pageEl.querySelector("#cm-add-text");
    var val = input ? input.value.trim() : "";
    if (!val) { showToast("请输入内容"); return; }
    // 空格分隔批量添加
    var items = val.split(/\s+/).filter(Boolean);
    var added = 0;
    items.forEach(function (item) {
      if (addCard("text", item)) added++;
    });
    if (input) input.value = "";
    refreshList();
    if (added > 0) showToast("已添加 " + added + " 张字卡");
  }

  function doAddEmoji() {
    var input = pageEl.querySelector("#cm-add-emoji");
    var val = input ? input.value.trim() : "";
    if (!val) { showToast("请输入 emoji"); return; }
    // 按字符分割（emoji 可能是多字节）
    var items = Array.from(val);
    var added = 0;
    items.forEach(function (item) {
      var trimmed = item.trim();
      if (trimmed && addCard("emoji", trimmed)) added++;
    });
    if (input) input.value = "";
    refreshList();
    if (added > 0) showToast("已添加 " + added + " 个 emoji");
  }

  function bindDeleteButtons() {
    pageEl.querySelectorAll("[data-del]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-del");
        deleteCard(id);
        refreshList();
        showToast("已删除");
      });
    });
  }

  function hideAllAddRows() {
    ["cm-text-add-row", "cm-emoji-add-row", "cm-image-add-row"].forEach(function (id) {
      var el = pageEl.querySelector("#" + id);
      if (el) el.style.display = "none";
    });
  }

  function showAddRow(id) {
    var el = pageEl.querySelector("#" + id);
    if (el) el.style.display = "flex";
  }

  function showCardsList() {
    var el = pageEl.querySelector("#cm-cards-list");
    if (el) el.style.display = "block";
  }

  function hideCardsList() {
    var el = pageEl.querySelector("#cm-cards-list");
    if (el) el.style.display = "none";
  }

  function refreshList() {
    var listEl = pageEl.querySelector("#cm-cards-list");
    if (listEl) {
      listEl.innerHTML = renderCardsList();
      bindDeleteButtons();
    }
    // 更新计数
    pageEl.querySelectorAll(".cm-type-count").forEach(function (el, i) {
      var types = ["text", "image", "emoji"];
      el.textContent = countByType(types[i]);
    });
    // 更新总计数
    var countEl = pageEl.querySelector(".cm-group-head .count");
    if (countEl) countEl.textContent = getMomentCards().length;
  }

  /* ========================================================================
     历史朋友圈 Feed 视图
     ======================================================================== */
  function viewFeed() {
    var html = '';
    var c = currentContact;
    if (!c) return '<div class="cmf-page"><div class="cmf-empty">联系人不存在</div></div>';

    // 导航栏
    html += '<div class="cmf-nav">';
    html += '<button class="nav-btn" data-act="back-main">' + I.svg("back", 20) + '返回</button>';
    html += '<span class="nav-title">' + escapeHtml(c.name) + '的朋友圈</span>';
    html += '<span style="width:60px"></span>';
    html += '</div>';

    html += '<div class="cmf-page">';
    html += '<div class="cmf-scroll">';

    // 封面
    var coverImg = getContactCover();
    html += '<div class="cmf-cover">';
    if (coverImg) {
      html += '<img class="cmf-cover-img" src="' + escapeHtml(coverImg) + '">';
    } else {
      html += '<div class="cmf-cover-empty">' + escapeHtml(c.name) + ' 的朋友圈</div>';
    }
    html += '</div>';

    // 用户信息浮层
    html += '<div class="cmf-user-bar">';
    html += '<span class="cmf-user-name">' + escapeHtml(c.name) + '</span>';
    html += '<div class="cmf-user-avatar">';
    if (c.avatar) {
      html += '<img src="' + escapeHtml(c.avatar) + '">';
    } else {
      html += escapeHtml(firstChar(c.name));
    }
    html += '</div>';
    html += '</div>';

    // 收集所有动态（当前 + 历史），按时间降序
    var allPosts = [];
    if (c.momentPost) {
      allPosts.push({
        text: c.momentPost.text,
        images: c.momentPost.images || [],
        timestamp: c.momentPost.timestamp
      });
    }
    if (c.momentHistory && c.momentHistory.length > 0) {
      allPosts = allPosts.concat(c.momentHistory);
    }
    allPosts.sort(function (a, b) { return b.timestamp - a.timestamp; });

    // 统计条
    html += '<div class="cmf-stats">';
    html += '<div class="cmf-stats-item">' + I.svg("clock", 14) + '<span>' + allPosts.length + ' 条动态</span></div>';
    html += '<div class="cmf-stats-item">' + I.svg("image", 14) + '<span>' + countByType("image") + ' 图卡</span></div>';
    html += '<div class="cmf-stats-item">' + I.svg("feather", 14) + '<span>' + countByType("text") + ' 字卡</span></div>';
    html += '</div>';

    // 动态列表
    html += '<div class="cmf-feed">';
    if (allPosts.length === 0) {
      html += '<div class="cmf-empty">';
      html += '<div class="cmf-empty-icon">📭</div>';
      html += '<div class="cmf-empty-text">暂无历史动态<br>添加字卡后将自动生成</div>';
      html += '</div>';
    } else {
      var lastDateStr = '';
      allPosts.forEach(function (post) {
        // 日期分隔符
        var dateStr = formatDateSep(post.timestamp);
        if (dateStr !== lastDateStr) {
          html += '<div class="cmf-date-sep">' + dateStr + '</div>';
          lastDateStr = dateStr;
        }

        // 动态卡片
        html += '<div class="cmf-post">';

        // 文字
        if (post.text) {
          html += '<div class="cmf-post-text">' + escapeHtml(post.text) + '</div>';
        }

        // 图片九宫格
        if (post.images && post.images.length > 0) {
          var n = post.images.length;
          html += '<div class="cmf-post-images count-' + Math.min(n, 9) + '">';
          post.images.slice(0, 9).forEach(function (src) {
            html += '<div class="cmf-post-img"><img src="' + escapeHtml(src) + '"></div>';
          });
          html += '</div>';
        }

        // 时间
        html += '<div class="cmf-post-time">' + formatRelativeTime(post.timestamp) + '</div>';
        html += '</div>';
      });
    }
    html += '</div>'; // .cmf-feed

    html += '</div>'; // .cmf-scroll
    html += '</div>'; // .cmf-page
    return html;
  }

  function formatDateSep(ts) {
    var d = new Date(ts);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var postDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var diffDays = Math.floor((today - postDay) / 86400000);

    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays === 2) return '前天';
    if (diffDays < 7) return diffDays + ' 天前';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function formatRelativeTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    var d = new Date(ts);
    var now = new Date();
    if (d.getFullYear() === now.getFullYear()) {
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0');
    }
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function bindFeed() {
    if (!pageEl) return;

    // 返回 → 回到字卡管理页
    var backBtn = pageEl.querySelector('[data-act="back-main"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      currentAddType = null;
      currentFilterType = null;
      pageEl.innerHTML = viewMain();
      bindMain();
    });
  }

  /* ========================================================================
     对外接口
     ======================================================================== */
  function open(contactId) {
    pageEl = document.getElementById("page-detail");
    if (!pageEl) {
      // fallback: try page-contacts
      pageEl = document.getElementById("page-contacts");
    }
    if (!pageEl) return;

    // 查找联系人
    if (window.MineContacts) {
      if (MineContacts.loadData) MineContacts.loadData();
      currentContactId = contactId;
      currentContact = MineContacts.findContact(contactId);
    }
    if (!currentContact) {
      pageEl.innerHTML = '<div class="cm-page"><div class="cm-empty">联系人不存在</div></div>';
      if (window.MineApp && MineApp.switchPage) MineApp.switchPage("detail");
      return;
    }

    // 确保 momentCards 初始化
    if (!currentContact.momentCards) currentContact.momentCards = [];

    currentAddType = null;
    currentFilterType = null;
    pageEl.innerHTML = viewMain();
    bindMain();
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("detail");
  }

  return {
    open: open,
    getMomentCards: function (contactId) {
      if (window.MineContacts && MineContacts.findContact) {
        var c = MineContacts.findContact(contactId);
        if (c) return c.momentCards || [];
      }
      return [];
    }
  };
})();
