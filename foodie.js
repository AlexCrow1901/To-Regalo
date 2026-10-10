/* ========================================================================
   Mine · 觅食模块
   ------------------------------------------------------------------------
   功能：
   · 塔罗牌式食物字卡（无限制数量，可增删）
   · 扇形排列 / 可滑动浏览 / 可抽取 / 可洗牌
   · 随机抽取联系人 + "xxx陪yyy" 顶部展示
   · "替我决定" → 对方抽牌 / "陪我一起" → 我抽牌
   · 食物分类：主食 / 零食 / 点心 / 饮料
   · 主页面分类选择器：选择类别后只在该类别卡牌中抽取
   接入：通过 MineCompanion.register("food-hunt") 注册。
   ======================================================================== */

window.MineFoodie = (function () {
  "use strict";

  var I = window.MineIcons;
  var pageEl = null;

  var STORE_KEY = "mine.foodie.v1";
  var cards = [];           // [{ id, text, category }]
  var currentContact = null; // 随机抽取的联系人
  var drawnText = null;     // 当前抽到的食物文字
  var isAnimating = false;  // 防止动画期间重复操作
  var selectedCat = "all";  // 当前选中的分类（"all" 或具体分类 key）

  /* ---------------- 食物分类定义 ---------------- */
  var CATEGORIES = [
    { key: "staple",  label: "主食", icon: "🍚" },
    { key: "snack",   label: "零食", icon: "🍪" },
    { key: "dessert", label: "点心", icon: "🍰" },
    { key: "drink",   label: "饮料", icon: "🥤" }
  ];

  function catLabel(key) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].key === key) return CATEGORIES[i];
    }
    return CATEGORIES[0];
  }

  function catCount(key) {
    return cards.filter(function (c) { return c.category === key; }).length;
  }

  /* 获取当前筛选后的卡牌列表 */
  function getFilteredCards() {
    if (selectedCat === "all") {
      // 全部模式：按分类排序，同类放在一起
      return cards.slice().sort(function (a, b) {
        var order = { staple: 0, snack: 1, dessert: 2, drink: 3 };
        return (order[a.category] || 0) - (order[b.category] || 0);
      });
    }
    return cards.filter(function (c) { return c.category === selectedCat; });
  }

  /* ---------------- 数据持久化 ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) cards = JSON.parse(raw) || [];
    } catch (e) {}
    if (!cards) cards = [];
    // 兼容旧格式：无 category 字段 → 默认 staple
    cards.forEach(function (card) {
      if (!card.category) card.category = "staple";
    });
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cards)); } catch (e) {}
  }

  /* ---------------- 工具 ---------------- */
  function uid() { return "food_" + Date.now() + "_" + Math.floor(Math.random() * 1000); }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------------- 获取联系人和我的信息 ---------------- */
  function pickRandomContact() {
    var C = window.MineContacts;
    if (!C || !C.loadData) return null;
    C.loadData();
    var contacts = (C.getState && C.getState().contacts) || [];
    if (contacts.length === 0) return null;
    var idx = Math.floor(Math.random() * contacts.length);
    return contacts[idx];
  }

  function getMyName() {
    if (window.MineProfile && MineProfile.getName) return MineProfile.getName();
    return "Mine";
  }

  function getMyAvatarHTML() {
    if (window.MineProfile && MineProfile.avatarHTML) return MineProfile.avatarHTML(44, "foodie-avatar");
    return '<div class="foodie-avatar">M</div>';
  }

  function getContactAvatarHTML(contact) {
    if (!contact) return '<div class="foodie-avatar">?</div>';
    var C = window.MineContacts;
    if (C && C.avatarHTML) return C.avatarHTML(contact, 44, "foodie-avatar");
    var first = (contact.name || "?").charAt(0);
    if (contact.avatar) {
      return '<div class="foodie-avatar"><img src="' + escapeHtml(contact.avatar) + '"></div>';
    }
    return '<div class="foodie-avatar">' + escapeHtml(first) + '</div>';
  }

  /* ---------------- Toast ---------------- */
  var toastTimer = null;
  function showToast(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    var existing = document.querySelector(".foodie-toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "foodie-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add("is-show"); });
    toastTimer = setTimeout(function () {
      toast.classList.remove("is-show");
      setTimeout(function () { toast.remove(); }, 300);
    }, 1800);
  }

  /* ========================================================================
     渲染：主页面
     ======================================================================== */
  function viewMain() {
    var html = '';
    var myName = getMyName();
    var contactName = currentContact ? (currentContact.name || "?") : "—";

    // 导航栏
    html += '<div class="nav-bar">' +
      '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
      '<span class="nav-title">觅食</span>' +
      '<button class="nav-btn" data-act="manage">' + I.svg("edit", 18) + '管理</button>' +
      '</div>';

    html += '<div class="foodie-page">';

    // 顶部人物栏
    html += '<div class="foodie-top">';
    html += getContactAvatarHTML(currentContact);
    html += '<div class="foodie-pair-text">' +
      escapeHtml(contactName) + '<span class="pair-accent">陪</span>' + escapeHtml(myName) +
      '</div>';
    html += getMyAvatarHTML();
    html += '</div>';

    // 抽牌结果区
    html += '<div class="foodie-result" id="foodie-result">';
    if (drawnText) {
      html += '<div class="foodie-result-text" id="foodie-result-label">—</div>';
      html += '<div class="foodie-result-card">' + escapeHtml(drawnText) + '</div>';
    }
    html += '</div>';

    // 卡牌区域
    html += '<div class="foodie-deck-area" id="foodie-deck-area">';
    if (cards.length === 0) {
      html += '<div class="foodie-empty">';
      html += '<div class="foodie-empty-icon">🍽️</div>';
      html += '<div class="foodie-empty-text">还没有食物字卡<br>点击右上角「管理」添加</div>';
      html += '</div>';
    } else {
      html += '<div class="foodie-deck" id="foodie-deck"></div>';
    }
    html += '</div>';

    // 分类选择器（按钮上方）
    html += '<div class="foodie-cat-selector" id="foodie-cat-selector">';
    html += '<button class="foodie-cat-chip' + (selectedCat === "all" ? " is-active" : "") + '" data-cat="all">全部</button>';
    CATEGORIES.forEach(function (cat) {
      var count = catCount(cat.key);
      if (count === 0) return; // 无卡牌的分类不显示
      html += '<button class="foodie-cat-chip' + (selectedCat === cat.key ? " is-active" : "") + '" data-cat="' + cat.key + '">' +
        cat.icon + ' ' + escapeHtml(cat.label) +
        '</button>';
    });
    html += '</div>';

    // 底部按钮
    html += '<div class="foodie-actions">';
    html += '<button class="foodie-btn foodie-btn-decide" id="foodie-decide">' + I.svg("user", 18) + '替我决定</button>';
    html += '<button class="foodie-btn foodie-btn-together" id="foodie-together">' + I.svg("heart", 18) + '陪我一起</button>';
    html += '</div>';

    html += '</div>'; // .foodie-page
    return html;
  }

  /* ========================================================================
     渲染：卡牌管理子页（分类弹窗模式）
     ======================================================================== */
  function viewManage() {
    var html = '';

    html += '<div class="nav-bar">' +
      '<button class="nav-btn" data-act="back-main">' + I.svg("back", 20) + '返回</button>' +
      '<span class="nav-title">食物字卡</span>' +
      '<span class="nav-right"></span>' +
      '</div>';

    html += '<div class="foodie-manage">';

    // 头部：标题 + 计数 + 切换按钮
    html += '<div class="foodie-add-head">';
    html += '<div class="group-head">食物字卡 <span class="count">' + cards.length + '</span></div>';
    html += '<button class="foodie-toggle-btn" id="foodie-toggle">' + I.svg("plus", 18) + '</button>';
    html += '</div>';

    // 分类弹窗（默认隐藏）
    html += '<div class="foodie-cat-popup" id="foodie-cat-popup">';
    CATEGORIES.forEach(function (cat) {
      html += '<button class="foodie-cat-option" data-cat="' + cat.key + '">' +
        '<span class="cat-icon">' + cat.icon + '</span>' +
        '<span>' + cat.label + '</span>' +
        '<span class="cat-count">' + catCount(cat.key) + '</span>' +
        '</button>';
    });
    html += '</div>';

    // 输入行（选中分类后显示）
    html += '<div class="foodie-add-row" id="foodie-add-row">';
    html += '<span class="cat-badge" id="foodie-cat-badge">主食</span>';
    html += '<input type="text" class="foodie-add-input" id="foodie-add-input" placeholder="输入食物名称，回车添加" maxlength="30">';
    html += '<button class="foodie-add-confirm" id="foodie-add-confirm">添加</button>';
    html += '</div>';

    // 提示
    html += '<div class="foodie-manage-hint">点击 + 展开分类 · 选择类别后输入名称 · 回车添加</div>';

    // 字卡列表（按分类分组）
    if (cards.length === 0) {
      html += '<div class="foodie-empty"><div class="foodie-empty-icon">🍽️</div><div class="foodie-empty-text">还没有食物字卡</div></div>';
    } else {
      CATEGORIES.forEach(function (cat) {
        var catCards = cards.filter(function (c) { return c.category === cat.key; });
        if (catCards.length === 0) return;
        html += '<div class="foodie-cat-group">';
        html += '<div class="foodie-cat-group-head"><span class="cat-emoji">' + cat.icon + '</span>' + cat.label + ' (' + catCards.length + ')</div>';
        catCards.forEach(function (card) {
          html += '<div class="card-item" data-card-id="' + escapeHtml(card.id) + '">';
          html += '<span class="card-text">' + escapeHtml(card.text) + '</span>';
          html += '<div class="card-del">' + I.svg("trash", 14) + '</div>';
          html += '</div>';
        });
        html += '</div>';
      });
    }

    html += '</div>'; // .foodie-manage
    return html;
  }

  /* ========================================================================
     扇形排列卡牌（使用筛选后的卡牌）
     ======================================================================== */
  function renderFan() {
    var deck = pageEl ? pageEl.querySelector("#foodie-deck") : null;
    if (!deck) return;
    deck.innerHTML = "";

    var filtered = getFilteredCards();
    var n = filtered.length;
    if (n === 0) return;

    var maxAngle = 50;
    var angleStep = n > 1 ? Math.min(maxAngle / (n - 1), 10) : 0;

    filtered.forEach(function (card, i) {
      var angle = n > 1 ? (i - (n - 1) / 2) * angleStep : 0;
      var arcY = Math.abs(angle) * 0.6;

      var el = document.createElement("div");
      el.className = "tarot-card";
      el.setAttribute("data-card-index", i);
      el.setAttribute("data-card-id", escapeHtml(card.id));
      el.style.transform = "rotate(" + angle + "deg) translateY(" + arcY + "px) translateZ(0)";
      el.style.zIndex = String(i);
      el.innerHTML =
        '<div class="tarot-front">' +
          '<div class="tarot-front-icon">' + (catLabel(card.category).icon) + '</div>' +
          '<div class="tarot-front-text">' + escapeHtml(card.text) + '</div>' +
          '<div class="tarot-front-label">觅食</div>' +
        '</div>' +
        '<div class="tarot-back">' +
          '<div class="tarot-back-pattern">🍽</div>' +
        '</div>';

      deck.appendChild(el);
    });
  }

  /* ========================================================================
     洗牌动画（只洗当前筛选范围内的卡牌）
     ======================================================================== */
  function doShuffle() {
    var deck = pageEl ? pageEl.querySelector("#foodie-deck") : null;
    if (!deck || isAnimating) return;

    var filtered = getFilteredCards();
    if (filtered.length < 2) return;
    isAnimating = true;

    var cardEls = deck.querySelectorAll(".tarot-card");

    // 第一步：散开
    cardEls.forEach(function (el) {
      var rx = (Math.random() - 0.5) * 100;
      var ry = (Math.random() - 0.5) * 60;
      var rr = (Math.random() - 0.5) * 50;
      el.classList.add("is-shuffling");
      el.style.transform = "translate3d(" + rx + "px, " + ry + "px, 0) rotate(" + rr + "deg)";
    });

    // 第二步：重新排列（在筛选范围内打乱）
    setTimeout(function () {
      if (selectedCat === "all") {
        // 全部模式：按分类排序后同类内部打乱
        var groups = {};
        CATEGORIES.forEach(function (cat) { groups[cat.key] = []; });
        cards.forEach(function (c) {
          if (!groups[c.category]) groups[c.category] = [];
          groups[c.category].push(c);
        });
        var newCards = [];
        CATEGORIES.forEach(function (cat) {
          groups[cat.key] = shuffle(groups[cat.key]);
          newCards = newCards.concat(groups[cat.key]);
        });
        cards = newCards;
      } else {
        // 单分类模式：只打乱该分类的卡牌
        var targetIdx = [];
        var targetCards = [];
        cards.forEach(function (c, i) {
          if (c.category === selectedCat) {
            targetIdx.push(i);
            targetCards.push(c);
          }
        });
        targetCards = shuffle(targetCards);
        targetIdx.forEach(function (origIdx, j) {
          cards[origIdx] = targetCards[j];
        });
      }
      save();
      renderFan();
      isAnimating = false;
      showToast("已洗牌");
    }, 380);
  }

  /* ========================================================================
     抽牌动画（只在筛选范围内抽取）
     ======================================================================== */
  function drawCard(isMe) {
    if (isAnimating) return;

    var filtered = getFilteredCards();
    if (filtered.length === 0) {
      showToast(selectedCat === "all" ? "请先添加字卡" : "该类别没有字卡");
      return;
    }
    isAnimating = true;

    var deck = pageEl.querySelector("#foodie-deck");
    var cardEls = deck.querySelectorAll(".tarot-card");
    var n = cardEls.length;
    var drawIdx = Math.floor(Math.random() * n);
    var drawEl = cardEls[drawIdx];
    var card = filtered[drawIdx];

    // 选中的卡牌飞向中心并放大
    drawEl.classList.add("is-drawing");
    drawEl.classList.add("is-revealed");
    drawEl.style.transform = "translate3d(0, -60px, 0) scale(1.35)";
    drawEl.style.zIndex = "999";

    // 其余卡牌完全隐藏
    cardEls.forEach(function (el, i) {
      if (i !== drawIdx) {
        el.style.opacity = "0";
        el.style.transform = "scale(0.8) translateZ(0)";
      }
    });

    // 显示结果
    setTimeout(function () {
      var resultArea = pageEl.querySelector("#foodie-result");
      var contactName = currentContact ? (currentContact.name || "?") : "—";
      var label = isMe
        ? "你抽到了"
        : contactName + "为你抽到了";
      drawnText = card.text;
      if (resultArea) {
        resultArea.innerHTML =
          '<div class="foodie-result-text">' + escapeHtml(label) + '</div>' +
          '<div class="foodie-result-card">' + escapeHtml(card.text) + '</div>';
      }
      isAnimating = false;
    }, 500);
  }

  /* ========================================================================
     滑动浏览（触摸交互）
     ======================================================================== */
  function bindSwipe() {
    var area = pageEl ? pageEl.querySelector("#foodie-deck-area") : null;
    if (!area) return;

    var startX = 0;
    var dragging = false;
    var deck = null;
    var cardEls = null;
    var n = 0;

    function onStart(e) {
      if (isAnimating) return;
      deck = pageEl.querySelector("#foodie-deck");
      if (!deck) return;
      cardEls = deck.querySelectorAll(".tarot-card");
      n = cardEls.length;
      if (n === 0) return;
      dragging = true;
      var touch = e.touches ? e.touches[0] : e;
      startX = touch.clientX;
    }

    function onMove(e) {
      if (!dragging || n === 0) return;
      var touch = e.touches ? e.touches[0] : e;
      var dx = touch.clientX - startX;
      var maxAngle = 50;
      var angleStep = n > 1 ? Math.min(maxAngle / (n - 1), 10) : 0;
      var deltaRot = dx * 0.08;

      cardEls.forEach(function (el, i) {
        var baseAngle = n > 1 ? (i - (n - 1) / 2) * angleStep : 0;
        var arcY = Math.abs(baseAngle) * 0.6;
        el.style.transform = "rotate(" + (baseAngle + deltaRot) + "deg) translateY(" + arcY + "px) translateZ(0)";
      });
    }

    function onEnd() {
      if (!dragging) return;
      dragging = false;
      if (cardEls && n > 0) {
        var maxAngle = 50;
        var angleStep = n > 1 ? Math.min(maxAngle / (n - 1), 10) : 0;
        cardEls.forEach(function (el, i) {
          var baseAngle = n > 1 ? (i - (n - 1) / 2) * angleStep : 0;
          var arcY = Math.abs(baseAngle) * 0.6;
          el.style.transform = "rotate(" + baseAngle + "deg) translateY(" + arcY + "px) translateZ(0)";
        });
      }
    }

    area.addEventListener("touchstart", onStart, { passive: true });
    area.addEventListener("touchmove", onMove, { passive: true });
    area.addEventListener("touchend", onEnd, { passive: true });
    area.addEventListener("mousedown", onStart);
    area.addEventListener("mousemove", onMove);
    area.addEventListener("mouseup", onEnd);
    area.addEventListener("mouseleave", onEnd);
  }

  /* ========================================================================
     绑定主页面事件
     ======================================================================== */
  function bindMain() {
    if (!pageEl) return;

    // 返回
    var backBtn = pageEl.querySelector('[data-act="back"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      if (window.MineCompanion) MineCompanion.open();
    });

    // 管理
    var manageBtn = pageEl.querySelector('[data-act="manage"]');
    if (manageBtn) manageBtn.addEventListener("click", function () {
      pageEl.innerHTML = viewManage();
      bindManage();
    });

    // 替我决定
    var decideBtn = pageEl.querySelector("#foodie-decide");
    if (decideBtn) decideBtn.addEventListener("click", function () {
      drawCard(false);
    });

    // 陪我一起
    var togetherBtn = pageEl.querySelector("#foodie-together");
    if (togetherBtn) togetherBtn.addEventListener("click", function () {
      drawCard(true);
    });

    // 洗牌（双击卡牌区）
    var deckArea = pageEl.querySelector("#foodie-deck-area");
    if (deckArea) {
      deckArea.addEventListener("dblclick", function () {
        doShuffle();
      });
    }

    // 分类选择器
    var catSelector = pageEl.querySelector("#foodie-cat-selector");
    if (catSelector) {
      catSelector.querySelectorAll(".foodie-cat-chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
          selectedCat = chip.getAttribute("data-cat");
          drawnText = null;
          // 更新选中状态
          catSelector.querySelectorAll(".foodie-cat-chip").forEach(function (c) {
            c.classList.remove("is-active");
          });
          chip.classList.add("is-active");
          // 清空结果区
          var resultArea = pageEl.querySelector("#foodie-result");
          if (resultArea) resultArea.innerHTML = "";
          // 重新渲染卡牌
          renderFan();
        });
      });
    }

    // 滑动浏览
    bindSwipe();

    // 渲染扇形卡牌
    renderFan();
  }

  /* ========================================================================
     绑定管理页事件（分类弹窗逻辑，与聊天字卡一致）
     ======================================================================== */
  function bindManage() {
    if (!pageEl) return;

    // 返回主页面
    var backBtn = pageEl.querySelector('[data-act="back-main"]');
    if (backBtn) backBtn.addEventListener("click", function () {
      currentContact = pickRandomContact();
      drawnText = null;
      selectedCat = "all";
      pageEl.innerHTML = viewMain();
      bindMain();
    });

    // 分类弹窗状态
    var toggleBtn = pageEl.querySelector("#foodie-toggle");
    var catPopup = pageEl.querySelector("#foodie-cat-popup");
    var addRow = pageEl.querySelector("#foodie-add-row");
    var catBadge = pageEl.querySelector("#foodie-cat-badge");
    var addInput = pageEl.querySelector("#foodie-add-input");
    var addConfirm = pageEl.querySelector("#foodie-add-confirm");
    var viewState = "collapsed"; // collapsed | popup | adding

    function updateToggleIcon() {
      if (!toggleBtn) return;
      if (viewState === "collapsed") {
        toggleBtn.classList.remove("is-open");
        toggleBtn.innerHTML = I.svg("plus", 18);
      } else {
        toggleBtn.classList.add("is-open");
        toggleBtn.innerHTML = I.svg("plus", 18);
      }
    }

    function showPopup() {
      viewState = "popup";
      if (catPopup) catPopup.classList.add("is-show");
      if (addRow) addRow.classList.remove("is-show");
      updateToggleIcon();
    }

    function collapseAll() {
      viewState = "collapsed";
      if (catPopup) catPopup.classList.remove("is-show");
      if (addRow) addRow.classList.remove("is-show");
      updateToggleIcon();
    }

    function showAddRow(catKey) {
      var cat = catLabel(catKey);
      viewState = "adding";
      if (catPopup) catPopup.classList.remove("is-show");
      if (addRow) {
        addRow.classList.add("is-show");
        if (catBadge) catBadge.textContent = cat.label;
        if (addInput) {
          addInput.value = "";
          addInput.setAttribute("placeholder", "输入" + cat.label + "名称，回车添加");
          addInput.focus();
        }
      }
      updateToggleIcon();
    }

    if (toggleBtn) toggleBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (viewState === "collapsed") {
        showPopup();
      } else {
        collapseAll();
      }
    });

    document.addEventListener("click", function (e) {
      if (viewState === "collapsed") return;
      if (!catPopup || !catPopup.classList.contains("is-show")) {
        if (viewState === "adding") return;
        return;
      }
      if (!catPopup.contains(e.target) && !(toggleBtn && toggleBtn.contains(e.target))) {
        collapseAll();
      }
    });

    if (catPopup) {
      catPopup.querySelectorAll(".foodie-cat-option").forEach(function (opt) {
        opt.addEventListener("click", function () {
          var catKey = opt.getAttribute("data-cat");
          showAddRow(catKey);
        });
      });
    }

    var currentCat = "staple";

    function doAdd() {
      var text = (addInput.value || "").trim();
      if (!text) { showToast("请输入食物名称"); return; }
      if (catBadge) {
        var label = catBadge.textContent;
        for (var i = 0; i < CATEGORIES.length; i++) {
          if (CATEGORIES[i].label === label) { currentCat = CATEGORIES[i].key; break; }
        }
      }
      cards.push({ id: uid(), text: text, category: currentCat });
      save();
      addInput.value = "";
      pageEl.innerHTML = viewManage();
      bindManage();
      var newAddRow = pageEl.querySelector("#foodie-add-row");
      var newToggle = pageEl.querySelector("#foodie-toggle");
      var newBadge = pageEl.querySelector("#foodie-cat-badge");
      var newInput = pageEl.querySelector("#foodie-add-input");
      if (newAddRow) newAddRow.classList.add("is-show");
      if (newToggle) newToggle.classList.add("is-open");
      if (newBadge) newBadge.textContent = catLabel(currentCat).label;
      if (newInput) {
        newInput.setAttribute("placeholder", "输入" + catLabel(currentCat).label + "名称，回车添加");
        newInput.focus();
      }
      showToast("已添加");
    }

    if (addConfirm) addConfirm.addEventListener("click", doAdd);
    if (addInput) {
      addInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") doAdd();
      });
    }

    pageEl.querySelectorAll(".card-item").forEach(function (item) {
      var delBtn = item.querySelector(".card-del");
      if (delBtn) {
        delBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var id = item.getAttribute("data-card-id");
          var idx = -1;
          for (var i = 0; i < cards.length; i++) {
            if (cards[i].id === id) { idx = i; break; }
          }
          if (idx >= 0) {
            cards.splice(idx, 1);
            save();
            pageEl.innerHTML = viewManage();
            bindManage();
            showToast("已删除");
          }
        });
      }
    });
  }

  /* ========================================================================
     对外接口
     ======================================================================== */
  function open() {
    if (!pageEl) pageEl = document.getElementById("page-companion");
    if (!pageEl) return;
    currentContact = pickRandomContact();
    drawnText = null;
    selectedCat = "all";
    pageEl.innerHTML = viewMain();
    bindMain();
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("companion");
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    load();
    pageEl = document.getElementById("page-companion");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    open: open,
    doShuffle: doShuffle,
    drawCard: drawCard
  };
})();
