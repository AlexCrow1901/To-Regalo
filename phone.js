/* ========================================================================
   Mine · 电话模块（v2）
   ------------------------------------------------------------------------
   规则（按需求设定）：
   · 主动来电：每个联系人独立调度，每小时一次抽取机会，触发概率 0.5%
   · 呼出电话：对方 2% 概率直接挂断；挂断后 49% 附字卡留言（取自该联系人
     主页"自动回复字卡"内容）/ 49% 附语音留言（预留，后期植入）/ 2% 不回复
   · 群聊电话：任意成员可发起，邀请任意数量成员；通话名单含我时，
     每个成员按一对一通话规则独立结算；纯成员间通话仅记录（留钩子）
   通话记录持久化（localStorage，配合 storage.js 大容量存储）
   概率全部集中在顶部 CONFIG，后期可随时调整。
   ======================================================================== */

window.MinePhone = (function () {
  "use strict";

  /* ==================== 配置（后期可调，勿删注释） ==================== */
  var CONFIG = {
    /* —— 联系人主动来电：每个联系人独立，每小时一次抽取 —— */
    incomingEnabled: true,          // 总开关：是否允许联系人主动来电
    perContactRollMinutes: 60,      // 每个联系人每多少分钟独立抽取一次（当前：每小时一次）
    incomingChance: 0.005,          // 每个联系人每次抽取触发来电的概率（0.5%）
    incomingRingSec: 20,            // 来电无人接听的最长响铃秒数（超时记为未接）
    /* —— 呼出通话 —— */
    answerMaxSec: 2,                // 正常接听前随机延迟上限（秒）
    hangupChance: 0.02,             // 我拨出时对方直接挂断的概率（2%）
   cardMessageChance: 0.49,        // 呼出被挂断后附赠"字卡留言"概率（49%，内容取自动回复字卡）
    voiceMessageChance: 0.49,       // 呼出被挂断后附赠"语音留言"概率（49%，预留，后期植入）
    missedCardChance: 0.49,         // 未接来电后附赠"字卡留言"概率（49%，从联系人主页全部字卡随机抽）
    missedVoiceChance: 0.49,        // 未接来电后附赠"语音留言"概率（49%，预留，后期植入）
    /* —— 挂断字卡留言的内部构成（后期可调） —— */
    autoCardRatio: 0.70,            // 字卡留言中"自动回复字卡"占比（70%）；其余 30% 为普通文字字卡
    normalCard1Chance: 0.75,        // 普通文字字卡：发 1 条的概率
    normalCard2Chance: 0.20,        // 普通文字字卡：发 2 条的概率（剩 5% 为 3 条）
   emojiAttachChance: 0.02,        // 每组字卡附赠 emoji 字卡的概率（2%）
    emojiAttach2Chance: 0.20,       // 附赠时发 2 个 emoji 的概率（80% 为 1 个）
    /* —— 通话中对方主动挂断 —— */
    connectedHangupCheckSec: 1200,  // 通话中每隔多少秒检查一次对方主动挂断（20 分钟）
    connectedHangupChance: 0.01,    // 每次检查对方主动挂断概率（1%）
    /* —— 语音留言条数分布 —— */
    voiceMsg1Chance: 0.70,           // 语音留言发 1 条的概率
    voiceMsg2Chance: 0.20,           // 语音留言发 2 条的概率（剩 5% 为 3 条）
 

    connectedMinSec: 25,            // 接通后最短通话秒数
    connectedMaxSec: 150,           // 接通后最长通话秒数（超时自动挂断）
    /* —— 群聊电话 —— */
    groupCallEnabled: true,         // 群聊电话总开关
    groupInvite1Chance: 0.10,       // 群成员发起通话时邀请 1 人的概率
    groupInvite2Chance: 0.35,       // 邀请 2 人的概率（剩余 55% 为 3 人及以上）
    groupMaxExtraInvitees: 2,       // "3 人及以上"时在 3 人基础上再随机增加的人数（0~2，实际不超过可选成员数）
    groupRollMinutes: 60,           // 每个群每多少分钟抽取一次"成员发起通话"
    groupCallChance: 0.005          // 每次抽取某成员发起群通话的概率（0.5%，与一对一来电一致）
  };

  var STORE_KEY = "mine.phone.log.v1";
  var MAX_LOG = 200;
  var I = window.MineIcons;

  /* ---------------- 概率自定义（与 MineProbs 联动） ----------------
     CONFIG 中所有 *Chance / *Ratio 概率项均可由"个人中心 → 概率修改"
     实时覆盖。PROB_MAP: [CONFIG 键, MineProbs 键]（MineProbs 值为百分比）。
  */
  var PROB_MAP = {
    incomingChance:         ["phoneIncoming",        0.5],
    hangupChance:           ["phoneHangup",          2],
    cardMessageChance:      ["phoneCardMsg",         49],
    voiceMessageChance:     ["phoneVoiceMsg",        49],
    missedCardChance:       ["phoneMissedCard",      49],
    missedVoiceChance:      ["phoneMissedVoice",     49],
    autoCardRatio:          ["phoneAutoRatio",       70],
    emojiAttachChance:      ["phoneEmojiAttach",     2],
    connectedHangupChance:  ["phoneConnectedHangup", 1],
    groupInvite1Chance:     ["phoneGroupInvite1",    10],
    groupInvite2Chance:     ["phoneGroupInvite2",    35],
    groupCallChance:        ["phoneGroupCall",       0.5],
    normalCard1Chance:      ["phoneNormal1",         75],
    normalCard2Chance:      ["phoneNormal2",         20],
    voiceMsg1Chance:        ["phoneVoice1",          70],
    voiceMsg2Chance:        ["phoneVoice2",          20],
    emojiAttach2Chance:     ["phoneEmoji2",          20]
  };
  function applyProbs() {
    var P = window.MineProbs;
    if (!P || !P.get) return;
    for (var key in PROB_MAP) {
      var v = P.get(PROB_MAP[key][0]);
      if (typeof v === "number" && !isNaN(v)) {
        CONFIG[key] = v / 100;
      }
    }
  }

  /* ---------------- 通话记录 ---------------- */
  var callLog = [];

  function loadLog() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) callLog = JSON.parse(raw) || [];
    } catch (e) {}
    if (!Array.isArray(callLog)) callLog = [];
  }

  function saveLog() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(callLog.slice(-MAX_LOG))); } catch (e) {}
  }

  function addLog(entry) {
    callLog.push(entry);
    saveLog();
  }
  /* 给刚写入的最后一条记录补充字段（挂断标记 / 留言信息等），并持久化 */
  function updateLastLog(patch) {
    if (!patch) return;
    var last = callLog[callLog.length - 1];
    if (!last) return;
    for (var k in patch) last[k] = patch[k];
    saveLog();
  }

  /* ---------------- 当前通话状态 ---------------- */
  var active = null;     // { dir:"out"|"in", contactId, state:"ringing"|"connected", startedAt, connectedAt }
  var overlayEl = null;
  var timerInt = null;
  var timers = [];       // 收集所有延时器，便于统一清理

  /* 群通话状态（与一对一互斥：一方进行中另一方不可发起） */
  var groupCall = null;      // { groupId, invitees:[{id,state,connectedAt}], startedAt, connectedAt, msgs:[] }
  var groupOverlayEl = null;
  var groupTimerInt = null;

  function clearTimers() {
    timers.forEach(function (t) { clearTimeout(t); });
    timers = [];
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    if (groupTimerInt) { clearInterval(groupTimerInt); groupTimerInt = null; }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function findContact(id) {
    return (window.MineContacts && MineContacts.findContact) ? MineContacts.findContact(id) : null;
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ---------------- Toast ---------------- */
  var toastTimer = null;

  function showToast(msg) {
    var el = document.querySelector(".phone-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "phone-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("is-show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("is-show"); }, 2200);
  }

  /* 最小化按钮图标（通话界面 → 悬浮球） */
  var MIN_BTN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  /* ==================== 通话界面 ==================== */
  function buildOverlay(contact, incoming) {
    var I = window.MineIcons;
    var avatarHTML = "";
    if (window.MineContacts && MineContacts.avatarHTML) {
      avatarHTML = MineContacts.avatarHTML(contact, 96, "phone-avatar avatar-gen");
    } else {
      avatarHTML = '<div class="avatar avatar-gen phone-avatar">' +
        esc((contact && contact.name || "?").charAt(0)) + '</div>';
    }

    var ov = document.createElement("div");
    ov.className = "phone-overlay";
    ov.innerHTML =
      '<div class="phone-screen">' +
        '<div class="phone-top"><span class="phone-brand">Mine · 电话</span></div>' +
        '<div class="phone-stage">' +
          '<div class="phone-avatar-wrap">' +
            '<span class="phone-ring r1"></span>' +
            '<span class="phone-ring r2"></span>' +
            avatarHTML +
          '</div>' +
          '<div class="phone-name">' + esc(contact ? contact.name : "未知") + '</div>' +
          '<div class="phone-state" id="phone-state">' + (incoming ? "正在呼入…" : "正在呼叫…") + '</div>' +
          '<div class="phone-timer" id="phone-timer">00:00</div>' +
        '</div>' +
        '<div class="phone-controls">' +
          '<button class="phone-ctl" data-ctl="min" title="最小化">' + MIN_BTN + '</button>' +
          '<button class="phone-ctl" data-ctl="mute" title="静音">' + I.svg("mic", 22) + '</button>' +
          (incoming
            ? '<button class="phone-ctl is-accept" data-ctl="accept" title="接听">' + I.svg("phone", 22) + '</button>'
            : '') +
          '<button class="phone-ctl is-danger" data-ctl="hangup" title="挂断">' + I.svg("phoneOff", 22) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add("is-open"); });

    ov.addEventListener("click", function (e) {
      var btn = (e.target && e.target.closest) ? e.target.closest("[data-ctl]") : null;
      if (!btn) return;
      handleCtl(btn.getAttribute("data-ctl"));
    });
    return ov;
  }

  function setStateText(text) {
    if (overlayEl) {
      var st = overlayEl.querySelector("#phone-state");
      if (st) st.textContent = text;
    }
  }

  /* 接通：进入通话计时状态 */
  function enterConnected() {
    if (!active || active.state !== "ringing") return;
    active.state = "connected";
    active.connectedAt = Date.now();
    if (!overlayEl) return;

    overlayEl.classList.remove("is-ringing");
    overlayEl.classList.add("is-connected");
    setStateText("已接通");

    var timerEl = overlayEl.querySelector("#phone-timer");
    timerInt = setInterval(function () {
      if (timerEl && active && active.state === "connected") {
        timerEl.textContent = fmtDuration((Date.now() - active.connectedAt) / 1000);
      }
    }, 1000);

      // 随机时长后自动结束（模拟对方挂断）
    var dur = CONFIG.connectedMinSec +
      Math.random() * (CONFIG.connectedMaxSec - CONFIG.connectedMinSec);
    timers.push(setTimeout(function () {
      if (active && active.state === "connected") endCall("通话结束");
    }, dur * 1000));

    // 通话中：每隔 20 分钟掷骰，1% 概率对方主动挂断
    // 呼出时挂断走"对方挂断"留言分支；呼入时挂断直接结束
    timers.push(setInterval(function () {
      if (!active || active.state !== "connected") return;
      if (Math.random() >= CONFIG.connectedHangupChance) return;
      var c = findContact(active.contactId);
      if (active.dir === "out") {
        counterpartHangup(c);
      } else {
        var e2 = endCall("对方挂断了通话");
        if (e2) updateLastLog({ hangup: true });
      }
    }, CONFIG.connectedHangupCheckSec * 1000));
  }


  /* 结束通话（notice 可选，结束时弹 toast）——返回本次记录 entry，供调用方补写挂断/留言信息 */
  function endCall(notice) {
    if (!active) return null;
    var entry = {
      dir: active.dir,
      kind: active.state === "connected" ? "answered"
          : (active.dir === "in" ? "missed" : "canceled"),
      contactId: active.contactId,
      time: active.startedAt,
      duration: active.state === "connected"
        ? Math.round((Date.now() - active.connectedAt) / 1000) : 0
    };
    addLog(entry);

    clearTimers();
    removeCallBall();
    var ov = overlayEl;
    active = null;
    overlayEl = null;
    if (ov) {
      if (ov.style.display === "none") {
        ov.remove();            // 悬浮球模式：界面已隐藏，直接移除
      } else {
        ov.classList.remove("is-open");
        setTimeout(function () { ov.remove(); }, 350);
      }
    }
    if (notice) showToast(notice);
    return entry;
  }

  /* ---------------- 控件处理 ---------------- */
  function handleCtl(ctl) {
    if (!active || !overlayEl) return;
    if (ctl === "mute") {
      toggleMute();
    } else if (ctl === "min") {
      minimizeCall();          // 最小化为悬浮球，可边聊边打
    } else if (ctl === "accept") {
      if (active.dir === "in" && active.state === "ringing") enterConnected();
    } else if (ctl === "hangup") {
      if (active.state === "ringing") {
        var isIn = active.dir === "in";
        var e3 = endCall(isIn ? "已拒绝来电" : "");
        if (e3 && isIn) updateLastLog({ declined: true });
      } else {
        endCall();
      }
    }
  }

  function toggleMute() {
    var btn = overlayEl.querySelector('[data-ctl="mute"]');
    if (!btn) return;
    var muted = btn.classList.toggle("is-muted");
    if (window.MineIcons) {
      btn.innerHTML = MineIcons.svg(muted ? "micOff" : "mic", 22);
    }
    setStateText(muted ? "已静音" : (active.state === "connected" ? "已接通" : "正在呼叫…"));
  }

  /* ==================== 呼出电话 ==================== */
  function callContact(contactId) {
    if (active || groupCall) { showToast("通话中，请先挂断"); return; }
    var c = findContact(contactId);
    if (!c) return;

    overlayEl = buildOverlay(c, false);
    active = { dir: "out", contactId: contactId, state: "ringing", startedAt: Date.now() };
    overlayEl.classList.add("is-ringing");

    // 响铃片刻后：2% 概率对方直接挂断，否则正常接听
    var delay = Math.max(900, Math.random() * CONFIG.answerMaxSec * 1000);
    timers.push(setTimeout(function () {
      if (!active || active.dir !== "out" || active.state !== "ringing") return;
      if (Math.random() < CONFIG.hangupChance) {
        counterpartHangup(c);
      } else {
        enterConnected();
      }
    }, delay));
  }

  /* ---------- 字卡类型判断（与 chat.js 同一套规则） ---------- */
  function isImageCard(card) {
    return typeof card === "string" && card.indexOf("data:image/") === 0;
  }
  function isEmojiCard(card) {
    if (typeof card !== "string" || card.length === 0 || isImageCard(card)) return false;
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

  /* ---------- 生成一组挂断留言字卡 ----------
     · 70%：自动回复字卡（c.autoCards）随机抽 1 条（均等）
     · 30%：普通文字字卡（c.cards 里非图片/非 emoji）抽 1~3 条（75/20/5）
     · 每组 2% 概率附赠 1~2 个 emoji 字卡（80%/20%），从 autoCards+cards 全池 emoji 中抽 */
  function buildHangupCards(c) {
    var group = [];
    var auto = (c && c.autoCards) || [];
    var normal = (c && c.cards) || [];
    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    if (Math.random() < CONFIG.autoCardRatio) {
      // 70%：自动回复字卡 1 条
      if (auto.length) group.push(pick(auto));
    } else {
      // 30%：普通文字字卡 1~3 条
      var textNormal = normal.filter(function (x) { return !isImageCard(x) && !isEmojiCard(x); });
      if (textNormal.length) {
        var r = Math.random();
        var n = r < CONFIG.normalCard1Chance ? 1
              : (r < CONFIG.normalCard1Chance + CONFIG.normalCard2Chance ? 2 : 3);
        for (var i = 0; i < n; i++) group.push(pick(textNormal));
      } else if (auto.length) {
        group.push(pick(auto));   // 兜底：无普通文字卡时回退自动回复卡
      }
    }

    // 附赠 emoji 字卡
    if (group.length && Math.random() < CONFIG.emojiAttachChance) {
      var emojiPool = auto.concat(normal).filter(isEmojiCard);
      if (emojiPool.length) {
        var m = Math.random() < (1 - CONFIG.emojiAttach2Chance) ? 1 : 2;
        for (var j = 0; j < m; j++) group.push(pick(emojiPool));
      }
    }
    return group;
  }

  /* ---------- 对方挂断：49% 字卡留言 / 49% 语音留言（预留）/ 2% 不回复 ---------- */
  function counterpartHangup(c) {
    var entry = endCall();   // 结束并记录本次呼出（挂断）
    var msg = null;
    var r = Math.random();
    if (r < CONFIG.cardMessageChance) {
      // 字卡留言：按 buildHangupCards 规则生成一组字卡
      var cards = buildHangupCards(c);
      msg = { cards: cards.length, voices: 0, cardItems: cards, voiceItems: [] };
      showCardMessage(c, cards);
    } else if (r < CONFIG.cardMessageChance + CONFIG.voiceMessageChance) {
      // 语音留言：预留（后期植入）
      var v = showVoiceMessage(c);
      msg = { cards: v.emojis.length, voices: v.voices.length || 1, cardItems: v.emojis, voiceItems: v.voices };
    } else {
      showToast("对方挂断了电话");
    }
    if (entry) updateLastLog({ hangup: true, msg: msg });
  }


  /* ---------- 留言弹层（字卡 / 语音，样式复用 sheet + phone-reserved） ---------- */
  function showMessageSheet(title, c, descHtml) {
    var ov = document.createElement("div");
    ov.className = "sheet-overlay";
    ov.innerHTML =
      '<div class="sheet">' +
        '<div class="sheet-handle"></div>' +
        '<div class="sheet-head"><h2>' + title + '</h2>' +
          '<button class="sheet-close" data-close="1">' + MineIcons.svg("close", 20) + '</button></div>' +
        '<div class="sheet-body">' +
          '<div class="phone-reserved">' +
            '<div class="phone-reserved-icon">' +
              (title === "语音留言" ? MineIcons.svg("mic", 26) : MineIcons.svg("feather", 26)) +
            '</div>' +
            '<div class="phone-reserved-title">来自 ' + esc(c ? c.name : "未知") + '</div>' +
            '<div class="phone-reserved-desc">' + descHtml + '</div>' +
            '<button class="btn btn-primary" data-close="1">收到</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(ov);
    requestAnimationFrame(function () {
      ov.classList.add("is-open");
      var sheet = ov.querySelector(".sheet");
      if (sheet) sheet.classList.add("is-open");
    });

    ov.addEventListener("click", function (e) {
      var closeHit = (e.target === ov) ||
        (e.target && e.target.closest && e.target.closest("[data-close]"));
      if (closeHit) {
        ov.classList.remove("is-open");
        setTimeout(function () { ov.remove(); }, 300);
      }
    });
  }

  /* 单张字卡渲染（字卡留言 / 群通话留言共用） */
  function cardToHtml(card) {
    if (isImageCard(card) ||
        /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(card)) {
      return '<img src="' + card +
        '" style="max-width:100%;max-height:160px;border-radius:12px;display:block;margin:6px auto;" />';
    }
    if (isEmojiCard(card)) {
      return '<div style="font-size:26px;text-align:center;margin:4px 0;">' + esc(card) + '</div>';
    }
    return '<div style="padding:5px 0;">' + esc(card) + '</div>';
  }

  /* 字卡留言：cards 为字符串数组（一组字卡，可含文字 / emoji / 图片） */
  function showCardMessage(c, cards) {
    if (!cards || !cards.length) {
      showMessageSheet("字卡留言", c, "对方挂断了电话，没有留下字卡。");
      return;
    }
    showMessageSheet("字卡留言", c, cards.map(cardToHtml).join(""));
  }

  /* 语音字卡池：联系人朋友圈字卡中 type=audio 的 content（audio dataURL） */
  function audioCardsOf(c) {
    var list = (c && c.momentCards) || [];
    var out = [];
    list.forEach(function (x) {
      if (x && x.type === "audio" && typeof x.content === "string" &&
          x.content.indexOf("data:audio/") === 0) out.push(x.content);
    });
    return out;
  }

  /* 语音留言：70% 1 条 / 20% 2 条 / 5% 3 条；每组 2% 附 1~2 个 emoji 字卡
     返回 { voices: 语音 dataURL 数组, emojis: 附赠 emoji 数组 }，供通话记录留存具体内容 */
  function showVoiceMessage(c) {
    var result = { voices: [], emojis: [] };
    var pool = audioCardsOf(c);
    if (!pool.length) {
      showMessageSheet("语音留言", c,
        '收到一段来自雾中的语音留言。<br>该联系人还没有语音字卡，敬请期待。');
      return result;
    }
    var r = Math.random();
    var n = r < CONFIG.voiceMsg1Chance ? 1
          : (r < CONFIG.voiceMsg1Chance + CONFIG.voiceMsg2Chance ? 2 : 3);
    var html = "";
    for (var i = 0; i < n; i++) {
      var src = pool[Math.floor(Math.random() * pool.length)];
      result.voices.push(src);
      html += MineVoiceBar.html(src, "vb-full");
    }
    // 2% 附 1~2 个 emoji 字卡
    if (Math.random() < CONFIG.emojiAttachChance) {
      var emojiPool = ((c && c.autoCards) || []).concat((c && c.cards) || []).filter(isEmojiCard);
      if (emojiPool.length) {
        var m = Math.random() < (1 - CONFIG.emojiAttach2Chance) ? 1 : 2;
        for (var j = 0; j < m; j++) {
          var emo = emojiPool[Math.floor(Math.random() * emojiPool.length)];
          result.emojis.push(emo);
          html += '<div style="font-size:26px;text-align:center;margin:4px 0;">' +
            esc(emo) + '</div>';
        }
      }
    }
    showMessageSheet("语音留言", c, html);
    return result;
  }

  

  /* ==================== 呼入电话 ==================== */
  function receiveCall(contactId) {
    if (active || groupCall) return;   // 忙线：不打断当前通话
    var c = findContact(contactId);
    if (!c) return;

    overlayEl = buildOverlay(c, true);
    active = { dir: "in", contactId: contactId, state: "ringing", startedAt: Date.now() };
    overlayEl.classList.add("is-ringing");
    // 后台保活：页面不在前台时弹系统通知
    if (window.MineKeepalive && document.visibilityState !== "visible") {
      MineKeepalive.notify(c.name, "邀请你进行语音通话");
    }

     // 响铃超时 → 未接（按概率附赠留言）
    timers.push(setTimeout(function () {
      if (active && active.dir === "in" && active.state === "ringing") {
        onMissedIncoming(c);
      }
    }, CONFIG.incomingRingSec * 1000));
  }

  /* ---------- 未接来电：49% 字卡留言 / 49% 语音留言（预留）/ 2% 不回复 ---------- */
  function onMissedIncoming(c) {
    var entry = endCall();              // 记录本次未接来电
    var msg = null;
    var r = Math.random();
    if (r < CONFIG.missedCardChance) {
      // 字卡留言：从联系人主页"自动回复字卡"中随机抽一张
      var cards = (c && c.autoCards) || [];
      var pick = cards.length ? cards[Math.floor(Math.random() * cards.length)] : null;
      msg = { cards: pick ? 1 : 0, voices: 0, cardItems: pick ? [pick] : [], voiceItems: [] };
      showCardMessage(c, pick ? [pick] : null);
    } else if (r < CONFIG.missedCardChance + CONFIG.missedVoiceChance) {
      // 语音留言：预留（后期植入）
      var v = showVoiceMessage(c);
      msg = { cards: v.emojis.length, voices: v.voices.length || 1, cardItems: v.emojis, voiceItems: v.voices };
    } else {
      showToast("未接来电 · " + (c ? c.name : ""));
    }
    if (entry) updateLastLog({ msg: msg });
  }
 

  /* ==================== 群聊电话 ====================
     · 群内任意成员均可发起，邀请任意数量成员
     · 我发起：被邀请成员各自独立按"一对一通话"规则结算
       （2% 接通前挂断 → 49% 字卡留言 / 49% 语音留言 / 2% 无留言；否则接通）
     · 其他成员发起：邀请 1 人 10% / 2 人 35% / 3 人及以上 55%
       - 名单含我 → 走一对一呼入流程（响铃/接听/未接留言规则一致）
       - 纯成员间通话 → 仅记录（钩子 memberToMemberCall，后期扩展） */
  function findGroup(id) {
    var st = (window.MineContacts && MineContacts.getState)
      ? MineContacts.getState() : null;
    var gs = (st && st.groups) || [];
    for (var i = 0; i < gs.length; i++) if (gs[i].id === id) return gs[i];
    return null;
  }

  /* ---------- 发起入口：选择群成员（任意数量） ---------- */
  function openGroupCall(groupId) {
    if (!CONFIG.groupCallEnabled) return;
    if (active || groupCall) { showToast("通话中，请先挂断"); return; }
    var g = findGroup(groupId);
    if (!g) return;
    var members = (g.members || []).map(findContact).filter(Boolean);
    if (members.length === 0) { showToast("群里还没有可邀请的成员"); return; }

    var rows = members.map(function (m) {
      var av = (window.MineContacts && MineContacts.avatarHTML)
        ? MineContacts.avatarHTML(m, 40, "")
        : '<div class="avatar">' + esc((m.name || "?").charAt(0)) + '</div>';
      return '<div class="contact-row" role="button" tabindex="0" data-pick="' + m.id + '">' +
        av +
        '<div class="contact-info"><span class="contact-name">' + esc(m.name) + '</span></div>' +
        '<span class="pick-check" data-check="' + m.id + '" style="width:22px;height:22px;border-radius:50%;' +
          'border:1px solid rgba(180,190,200,.5);display:inline-block;flex:0 0 auto;transition:background .15s;"></span>' +
        '</div>';
    }).join("");

    var ov = document.createElement("div");
    ov.className = "sheet-overlay";
    ov.innerHTML =
      '<div class="sheet">' +
        '<div class="sheet-handle"></div>' +
        '<div class="sheet-head"><h2>发起群电话</h2>' +
          '<button class="sheet-close" data-close="1">' + MineIcons.svg("close", 20) + '</button></div>' +
        '<div class="sheet-body">' +
          '<div class="phone-reserved-desc" style="margin-bottom:8px;">选择任意数量成员发起通话 · 每人独立按一对一电话规则接听或挂断</div>' +
          rows +
          '<button class="btn btn-primary" id="gc-start" style="margin-top:10px;width:100%;" disabled>' +
            '邀请 0 位成员</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(ov);
    requestAnimationFrame(function () {
      ov.classList.add("is-open");
      var sheet = ov.querySelector(".sheet");
      if (sheet) sheet.classList.add("is-open");
    });

    var picked = {};
    var startBtn = ov.querySelector("#gc-start");
    function refreshStart() {
      var n = Object.keys(picked).length;
      startBtn.textContent = "邀请 " + n + " 位成员";
      startBtn.disabled = n === 0;
    }
    ov.addEventListener("click", function (e) {
      var closeHit = (e.target === ov) ||
        (e.target && e.target.closest && e.target.closest("[data-close]"));
      if (closeHit) {
        ov.classList.remove("is-open");
        setTimeout(function () { ov.remove(); }, 300);
        return;
      }
      var row = (e.target && e.target.closest) ? e.target.closest("[data-pick]") : null;
      if (row) {
        var id = row.getAttribute("data-pick");
        if (picked[id]) {
          delete picked[id];
        } else {
          picked[id] = true;
        }
        var chk = row.querySelector(".pick-check");
        if (chk) chk.style.background = picked[id] ? "rgba(159,180,199,.85)" : "transparent";
        refreshStart();
        return;
      }
      if (e.target.closest && e.target.closest("#gc-start")) {
        var ids = Object.keys(picked);
        if (!ids.length) return;
        ov.classList.remove("is-open");
        setTimeout(function () {
          ov.remove();
          startGroupCall(g, ids);
        }, 200);
      }
    });
  }

  /* ---------- 我发起的群通话：每位被邀请成员独立结算 ---------- */
  function startGroupCall(g, ids) {
    if (active || groupCall) { showToast("通话中，请先挂断"); return; }
    var invitees = ids.map(function (id) {
      return { id: id, state: "ringing", connectedAt: 0 };
    });

    groupCall = { groupId: g.id, invitees: invitees, startedAt: Date.now(), connectedAt: 0, msgs: [] };
    groupOverlayEl = buildGroupOverlay(g, invitees);

    invitees.forEach(function (p) {
      var c = findContact(p.id);
      // 随机响铃后独立结算：2% 接通前挂断，否则接通（与一对一呼出一致）
      var delay = Math.max(900, Math.random() * CONFIG.answerMaxSec * 1000);
      timers.push(setTimeout(function () {
        if (!groupCall) return;
        var pp = null;
        for (var i = 0; i < groupCall.invitees.length; i++) {
          if (groupCall.invitees[i].id === p.id) { pp = groupCall.invitees[i]; break; }
        }
        if (!pp || pp.state !== "ringing") return;
        if (Math.random() < CONFIG.hangupChance) {
          // 接通前挂断 → 按一对一规则排队留言（钩子点：后期可替换群聊专属规则）
          pp.state = "left";
          queueGroupHangupMessage(c);
          updateGroupParticipant(p.id, "已挂断");
          checkGroupCallAllLeft();
        } else {
          pp.state = "connected";
          pp.connectedAt = Date.now();
          if (!groupCall.connectedAt) {
            groupCall.connectedAt = Date.now();
            startGroupTimer();
          }
          updateGroupParticipant(p.id, "已接通");
          // 接通后随机时长自动离开（与一对一"通话结束"一致，不留留言）
          var dur = CONFIG.connectedMinSec +
            Math.random() * (CONFIG.connectedMaxSec - CONFIG.connectedMinSec);
          timers.push(setTimeout(function () {
            if (!groupCall) return;
            var q = null;
            for (var i = 0; i < groupCall.invitees.length; i++) {
              if (groupCall.invitees[i].id === p.id) { q = groupCall.invitees[i]; break; }
            }
            if (!q || q.state !== "connected") return;
            q.state = "left";
            updateGroupParticipant(p.id, "已挂断");
            checkGroupCallAllLeft();
          }, dur * 1000));
        }
      }, delay));
    });
  }

  /* ---------- 群通话界面 ---------- */
  function buildGroupOverlay(g, invitees) {
    var I2 = window.MineIcons;
    var rows = invitees.map(function (p) {
      var c = findContact(p.id);
      var av = (window.MineContacts && MineContacts.avatarHTML)
        ? MineContacts.avatarHTML(c, 34, "")
        : '<div class="avatar">' + esc((c && c.name || "?").charAt(0)) + '</div>';
      return '<div class="gc-row" data-pid="' + p.id + '" style="display:flex;align-items:center;gap:10px;padding:6px 0;">' +
        '<div style="flex:0 0 auto;">' + av + '</div>' +
        '<div style="flex:1 1 auto;text-align:left;font-size:14px;opacity:.85;">' + esc(c ? c.name : "未知") + '</div>' +
        '<div class="gc-state" style="flex:0 0 auto;font-size:12px;opacity:.6;">呼叫中…</div>' +
        '</div>';
    }).join("");

    var ov = document.createElement("div");
    ov.className = "phone-overlay";
    ov.innerHTML =
      '<div class="phone-screen">' +
        '<div class="phone-top"><span class="phone-brand">Mine · 群电话</span></div>' +
        '<div class="phone-stage">' +
          '<div class="phone-avatar-wrap">' +
            '<span class="phone-ring r1"></span>' +
            '<span class="phone-ring r2"></span>' +
            '<div class="avatar avatar-gen phone-avatar" style="display:flex;align-items:center;justify-content:center;">' +
              I2.svg("users", 40) + '</div>' +
          '</div>' +
          '<div class="phone-name">' + esc(g.name) + '</div>' +
          '<div class="phone-state" id="phone-state">呼叫中…</div>' +
          '<div class="phone-timer" id="phone-timer">00:00</div>' +
          '<div class="gc-list" style="max-height:170px;overflow-y:auto;width:100%;padding:0 26px;box-sizing:border-box;">' +
            rows +
          '</div>' +
        '</div>' +
        '<div class="phone-controls">' +
          '<button class="phone-ctl" data-ctl="min" title="最小化">' + MIN_BTN + '</button>' +
          '<button class="phone-ctl" data-ctl="mute" title="静音">' + I2.svg("mic", 22) + '</button>' +
          '<button class="phone-ctl is-danger" data-ctl="hangup" title="挂断">' + I2.svg("phoneOff", 22) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add("is-open"); });
    ov.addEventListener("click", function (e) {
      var btn = (e.target && e.target.closest) ? e.target.closest("[data-ctl]") : null;
      if (!btn) return;
      var ctl = btn.getAttribute("data-ctl");
      if (ctl === "mute") {
        var muted = btn.classList.toggle("is-muted");
        if (window.MineIcons) btn.innerHTML = MineIcons.svg(muted ? "micOff" : "mic", 22);
      } else if (ctl === "min") {
        minimizeGroupCall();   // 最小化为悬浮球，可边聊边打
      } else if (ctl === "hangup") {
        endGroupCall();
      }
    });
    return ov;
  }

  function updateGroupParticipant(id, text) {
    if (!groupOverlayEl) return;
    var row = groupOverlayEl.querySelector('[data-pid="' + id + '"]');
    if (row) {
      var st = row.querySelector(".gc-state");
      if (st) st.textContent = text;
    }
    refreshGroupStateText();
  }

  function refreshGroupStateText() {
    if (!groupCall || !groupOverlayEl) return;
    var connected = groupCall.invitees.filter(function (p) { return p.state === "connected"; }).length;
    var left = groupCall.invitees.filter(function (p) { return p.state === "left"; }).length;
    var stEl = groupOverlayEl.querySelector("#phone-state");
    if (stEl) {
      if (connected > 0) stEl.textContent = "通话中 · " + connected + " 人";
      else if (left >= groupCall.invitees.length) stEl.textContent = "通话已结束";
      else stEl.textContent = "呼叫中…";
    }
  }

  function startGroupTimer() {
    var timerEl = groupOverlayEl ? groupOverlayEl.querySelector("#phone-timer") : null;
    groupTimerInt = setInterval(function () {
      if (groupCall && groupCall.connectedAt && timerEl) {
        timerEl.textContent = fmtDuration((Date.now() - groupCall.connectedAt) / 1000);
      }
    }, 1000);
  }

  function checkGroupCallAllLeft() {
    if (!groupCall) return;
    var all = groupCall.invitees.every(function (p) { return p.state === "left"; });
    if (all) endGroupCall("通话结束");
  }

  /* 接通前挂断的留言：与一对一呼出挂断规则一致（49% 字卡 / 49% 语音 / 2% 无）
     钩子点：后期可在此替换/扩展群聊专属留言规则 */
  function queueGroupHangupMessage(c) {
    if (!c || !groupCall) return;
    var r = Math.random();
    if (r < CONFIG.cardMessageChance) {
      groupCall.msgs.push({ contact: c, kind: "card", cards: buildHangupCards(c) });
    } else if (r < CONFIG.cardMessageChance + CONFIG.voiceMessageChance) {
      groupCall.msgs.push({ contact: c, kind: "voice" });
    }
    // 其余 2%：不留留言
  }

  /* 结束群通话：记录日志 → 关闭界面 → 统一展示挂断成员的留言 */
  function endGroupCall(notice) {
    if (!groupCall) return;
    var duration = groupCall.connectedAt
      ? Math.round((Date.now() - groupCall.connectedAt) / 1000) : 0;
    /* 汇总挂断成员的留言（字卡 / 语音条数与具体内容） */
    var msg = null;
    if (groupCall.msgs && groupCall.msgs.length) {
      var nCards = 0, nVoices = 0, cardItems = [], voiceItems = [];
      groupCall.msgs.forEach(function (m) {
        if (m.kind === "card") {
          nCards++;
          if (m.cards && m.cards.length) cardItems = cardItems.concat(m.cards);
        } else if (m.kind === "voice") {
          nVoices++;
        }
      });
      msg = { cards: nCards, voices: nVoices, cardItems: cardItems, voiceItems: voiceItems };
    }
    addLog({
      type: "group", dir: "out",
      kind: groupCall.connectedAt ? "answered" : "canceled",
      groupId: groupCall.groupId,
      contactIds: groupCall.invitees.map(function (p) { return p.id; }),
      time: groupCall.startedAt,
      duration: duration,
      msg: msg
    });
    var msgs = groupCall.msgs;
    clearTimers();
    removeCallBall();
    var ov = groupOverlayEl;
    groupCall = null;
    groupOverlayEl = null;
    if (ov) {
      if (ov.style.display === "none") {
        ov.remove();            // 悬浮球模式：界面已隐藏，直接移除
      } else {
        ov.classList.remove("is-open");
        setTimeout(function () { ov.remove(); }, 350);
      }
    }
    if (notice) showToast(notice);
    if (msgs && msgs.length) {
      setTimeout(function () { showGroupHangupMessages(msgs); }, 400);
    }
  }

  /* 群通话挂断留言合并展示（字卡 / 语音） */
  function showGroupHangupMessages(list) {
    var html = list.map(function (m) {
      var head = '<div style="margin:10px 0 4px;font-size:13px;opacity:.65;text-align:left;">' +
        esc(m.contact ? m.contact.name : "未知") + '</div>';
      if (m.kind === "card") {
        if (!m.cards || !m.cards.length) return "";
        return head + m.cards.map(cardToHtml).join("");
      }
      // 语音留言：按一对一语音留言规则取该成员语音字卡
      var pool = audioCardsOf(m.contact);
      if (!pool.length) {
        return head + '<div style="padding:4px 0;font-size:13px;opacity:.7;">（该成员暂无语音字卡）</div>';
      }
      var r = Math.random();
      var n = r < CONFIG.voiceMsg1Chance ? 1
            : (r < CONFIG.voiceMsg1Chance + CONFIG.voiceMsg2Chance ? 2 : 3);
      var seg = "";
      for (var i = 0; i < n; i++) {
        var src = pool[Math.floor(Math.random() * pool.length)];
        seg += MineVoiceBar.html(src, "vb-full");
      }
      return head + seg;
    }).join("");
    if (!html) return;
    showMessageSheet("群电话留言", { name: "群聊成员" }, html);
  }

  /* ============================================================
     钩子：群成员 ↔ 群成员 通话（无我参与）
     目前规则：仅仅是"通话"——记录一条群通话日志，无字卡回复、
     无语音留言等任何附加功能。
     后期扩展：在此函数内为通话双方接入字卡/语音等行为即可，
     不影响含我通话的既有逻辑。
     ============================================================ */
  function memberToMemberCall(g, callerId, inviteeIds) {
    addLog({
      type: "group", dir: "member",
      groupId: g.id, callerId: callerId, inviteeIds: inviteeIds,
      time: Date.now(), duration: 0
    });
  }

  /* ==================== 通话悬浮球（最小化后可边聊边打） ====================
     · 通话界面点最小化按钮 → 收起为悬浮球，可任意拖动
     · 点按悬浮球 → 还原通话界面；红色按钮 → 直接挂断
     · 悬浮球期间可正常浏览、发消息、进群聊 */
  var ballEl = null;
  var ballTimerInt = null;
  var ballHandlers = null;

  function removeCallBall() {
    if (ballTimerInt) { clearInterval(ballTimerInt); ballTimerInt = null; }
    if (ballEl) { ballEl.remove(); ballEl = null; }
    ballHandlers = null;
  }

  function showCallBall(getLabel, onTap, onHangup) {
    removeCallBall();
    ballHandlers = { onTap: onTap, onHangup: onHangup };
    var el = document.createElement("div");
    el.style.cssText = "position:fixed;z-index:9999;right:16px;bottom:130px;width:58px;height:58px;" +
      "border-radius:50%;background:rgba(18,26,36,.92);border:1px solid rgba(160,185,205,.45);" +
      "box-shadow:0 6px 18px rgba(0,0,0,.4);display:flex;flex-direction:column;align-items:center;" +
      "justify-content:center;gap:1px;touch-action:none;-webkit-user-select:none;user-select:none;cursor:pointer;";
    el.innerHTML =
      '<span style="width:8px;height:8px;border-radius:50%;background:#7fd39a;box-shadow:0 0 8px #7fd39a;"></span>' +
      '<span class="cb-label" style="font-size:10px;color:#cfe0ee;letter-spacing:.5px;">00:00</span>' +
      '<button class="cb-end" style="position:absolute;top:-3px;right:-3px;width:22px;height:22px;border-radius:50%;' +
        'background:#d9534f;border:1px solid rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;' +
        'cursor:pointer;padding:0;">' +
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="2.4" ' +
          'stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button>';
    document.body.appendChild(el);
    ballEl = el;

    var labelEl = el.querySelector(".cb-label");
    function tick() {
      var t = getLabel();
      if (labelEl && t) labelEl.textContent = t;
    }
    tick();
    ballTimerInt = setInterval(tick, 1000);

    // 红色按钮：挂断（不参与拖动）
    el.querySelector(".cb-end").addEventListener("click", function (e) {
      e.stopPropagation();
      if (ballHandlers && ballHandlers.onHangup) ballHandlers.onHangup();
    });

    // 拖动 + 点按还原（移动超过 8px 判定为拖动）
    var dragging = false, moved = false, sx = 0, sy = 0, offX = 0, offY = 0;
    el.addEventListener("pointerdown", function (e) {
      if (e.target && e.target.closest && e.target.closest(".cb-end")) return;
      dragging = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      var r = el.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) {} }
      e.preventDefault();
    });
    el.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 8) moved = true;
      if (moved) {
        var x = Math.min(Math.max(e.clientX - offX, 0), window.innerWidth - el.offsetWidth);
        var y = Math.min(Math.max(e.clientY - offY, 0), window.innerHeight - el.offsetHeight);
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
      }
    });
    el.addEventListener("pointerup", function () {
      if (dragging && !moved && ballHandlers && ballHandlers.onTap) ballHandlers.onTap();
      dragging = false;
    });
    el.addEventListener("pointercancel", function () { dragging = false; });
  }

  /* 一对一：最小化 / 还原 */
  function minimizeCall() {
    if (!active || !overlayEl) return;
    overlayEl.classList.remove("is-open");
    overlayEl.style.display = "none";
    showCallBall(
      function () {
        if (!active) return "";
        return active.state === "connected"
          ? fmtDuration((Date.now() - active.connectedAt) / 1000) : "呼叫中";
      },
      restoreCall,
      function () { endCall(); }
    );
  }
  function restoreCall() {
    removeCallBall();
    if (active && overlayEl) {
      overlayEl.style.display = "";
      requestAnimationFrame(function () { overlayEl.classList.add("is-open"); });
    }
  }

  /* 群电话：最小化 / 还原 */
  function minimizeGroupCall() {
    if (!groupCall || !groupOverlayEl) return;
    groupOverlayEl.classList.remove("is-open");
    groupOverlayEl.style.display = "none";
    showCallBall(
      function () {
        if (!groupCall || !groupCall.connectedAt) return "呼叫中";
        return fmtDuration((Date.now() - groupCall.connectedAt) / 1000);
      },
      restoreGroupCall,
      function () { endGroupCall(); }
    );
  }
  function restoreGroupCall() {
    removeCallBall();
    if (groupCall && groupOverlayEl) {
      groupOverlayEl.style.display = "";
      requestAnimationFrame(function () { groupOverlayEl.classList.add("is-open"); });
    }
  }

  /* ==================== 电话页（主屏「电话」入口 · 通话记录） ==================== */
  function fmtLogTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    var ymd = (d.getFullYear()) + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
    var hm = (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" +
             (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
    if (d.toDateString() === now.toDateString()) return "今天 " + hm;
    var yesterday = new Date(now.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return "昨天 " + hm;
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
    return ymd + " " + hm;
  }

  /* 留言信息文案：{cards:字卡条数, voices:语音条数} → "留言 字卡×2 语音×1" */
  function msgText(entry) {
    var m = entry && entry.msg;
    if (!m) return "";
    var parts = [];
    if (m.cards > 0) parts.push("字卡×" + m.cards);
    if (m.voices > 0) parts.push("语音×" + m.voices);
    return parts.length ? " · 留言 " + parts.join(" ") : "";
  }

  /* 留言具体内容（字卡文字 / emoji / 图片缩略 / 语音条） */
  function msgDetailHTML(entry) {
    var m = entry && entry.msg;
    if (!m) return "";
    var html = "";
    if (m.cardItems && m.cardItems.length) {
      m.cardItems.forEach(function (card) {
        if (isImageCard(card)) {
          html += '<img class="phone-msg-img" src="' + card + '" alt="图片字卡">';
        } else if (isEmojiCard(card)) {
          html += '<span class="phone-msg-emoji">' + esc(card) + '</span>';
        } else {
          html += '<span class="phone-msg-text">' + esc(card) + '</span>';
        }
      });
    }
    if (m.voiceItems && m.voiceItems.length) {
      m.voiceItems.forEach(function (src) {
        html += MineVoiceBar.html(src, "phone-msg-audio");
      });
    }
    return html ? '<div class="phone-msg-detail">' + html + '</div>' : "";
  }

  /* 群通话记录行 */
  function groupLogRowHTML(entry) {
    var g = findGroup(entry.groupId);
    var gname = g ? g.name : "群聊";
    var durText = entry.duration > 0 ? fmtDuration(entry.duration) : "";
    var kindText;
    if (entry.dir === "out") {
      kindText = "群呼出 · " + ((entry.contactIds || []).length) + " 人 · " + fmtLogTime(entry.time);
    } else {
      var caller = findContact(entry.callerId);
      kindText = (caller ? caller.name : "成员") + " 发起 · " +
        ((entry.inviteeIds || []).length) + " 人 · " + fmtLogTime(entry.time);
    }
    return '<div class="phone-log-row">' +
      '<div class="phone-log-icon">' + I.svg("users", 18) + '</div>' +
      '<div class="phone-log-info">' +
        '<span class="phone-log-name">' + esc(gname) + '</span>' +
        '<span class="phone-log-kind">' + kindText + msgText(entry) + '</span>' +
        msgDetailHTML(entry) +
      '</div>' +
      '<span class="phone-log-dur">' + durText + '</span>' +
    '</div>';
  }

  function logRowHTML(entry) {
    if (entry.type === "group") return groupLogRowHTML(entry);
    var c = findContact(entry.contactId);
    var name = c ? c.name : "未知";
    var iconName = entry.dir === "out" ? "phoneOut"
      : (entry.kind === "answered" ? "phoneIn" : "phoneMissed");
    var kindText;
    if (entry.dir === "out") {
      kindText = entry.kind === "answered"
        ? (entry.hangup ? "呼出 · 对方挂断" : "呼出 · 已接通")
        : (entry.hangup ? "呼出 · 对方挂断" : "呼出 · 已取消");
    } else {
      kindText = entry.kind === "answered"
        ? (entry.hangup ? "呼入 · 对方挂断" : "呼入 · 已接通")
        : (entry.declined ? "已拒绝" : "未接来电");
    }
    kindText += " · " + fmtLogTime(entry.time);
    var durText = entry.duration > 0 ? fmtDuration(entry.duration) : "";
    return '<div class="phone-log-row">' +
      '<div class="phone-log-icon">' + I.svg(iconName, 18) + '</div>' +
      '<div class="phone-log-info">' +
        '<span class="phone-log-name">' + esc(name) + '</span>' +
        '<span class="phone-log-kind' + (entry.kind === "missed" ? " is-missed" : "") + '">' +
          kindText + msgText(entry) + '</span>' +
        msgDetailHTML(entry) +
      '</div>' +
      '<span class="phone-log-dur">' + durText + '</span>' +
    '</div>';
  }

  function renderPage() {
    var detail = document.getElementById("page-detail");
    if (!detail) return;
    var I = window.MineIcons;
    var rows = callLog.slice().reverse();
    var listHtml = "";
    if (rows.length === 0) {
      listHtml = '<div class="empty-state">' +
        '<div class="empty-icon">' + I.svg("phone", 28) + '</div>' +
        '<div class="empty-title">暂无通话记录</div>' +
        '<div class="empty-desc">呼叫联系人，或等待一次来电。</div>' +
      '</div>';
    } else {
      listHtml = rows.map(logRowHTML).join("");
    }
    var html =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">电话</span>' +
        '<span class="nav-right"></span>' +
      '</div>' +
      '<div class="scroll phone-log-scroll">' +
        '<div class="phone-log-head">通话记录 <span class="count">' + callLog.length + '</span></div>' +
        listHtml +
        '<div class="phone-log-hint">在通讯录或聊天页点 <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> 图标可呼叫联系人 · 联系人也会每小时按概率主动来电</div>' +
      '</div>';
    detail.innerHTML = html;
    detail.querySelector('[data-act="back"]').addEventListener("click", function () {
      if (window.MineApp && MineApp.goHome) MineApp.goHome();
    });
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("detail", "phone");
  }

  /* ==================== 联系人主动来电调度（每小时一次，互相独立） ==================== */
  var schedulerInt = null;
  var resumeBound = false;   // 回前台补查事件是否已绑定（避免 init 重复绑定）
  var callSchedule = {};     // contactId -> 下一次抽取时间戳
  var groupSchedule = {};    // groupId -> 下一次"成员发起通话"抽取时间戳

  function schedulerTick() {
    if (!CONFIG.incomingEnabled) return;
    if (active || groupCall) return;           // 通话 / 来电进行中不打扰
    var now = Date.now();
    var st = (window.MineContacts && MineContacts.getState)
      ? MineContacts.getState() : null;
    var list = (st && st.contacts) || [];
    if (list.length === 0) return;

    var rollMs = Math.max(1, CONFIG.perContactRollMinutes) * 60000;
    var hit = null;
    list.forEach(function (c) {
      if (hit) return;                         // 每轮最多触发一个来电
      var t = callSchedule[c.id];
      if (!t) {
        // 首次调度：在当前小时内的随机时刻安排抽取（避免打开即触发）
        callSchedule[c.id] = now + Math.floor(Math.random() * rollMs);
        return;
      }
      if (t <= now) {
        // 到点：安排下一次（每个联系人独立、每小时一次）
        callSchedule[c.id] = now + rollMs;
        if (Math.random() < CONFIG.incomingChance) hit = c;
      }
    });
    if (hit) { receiveCall(hit.id); return; }

    tickGroupCallScheduler(now);
  }

  /* 群成员主动发起通话调度：每群独立抽取（频率/概率见 CONFIG 群聊电话区） */
  function tickGroupCallScheduler(now) {
    var st = (window.MineContacts && MineContacts.getState)
      ? MineContacts.getState() : null;
    var groups = (st && st.groups) || [];
    if (!CONFIG.groupCallEnabled || groups.length === 0) return;

    var rollMs = Math.max(1, CONFIG.groupRollMinutes) * 60000;
    var hit = null;
    groups.forEach(function (g) {
      if (hit) return;                         // 每轮最多触发一次群通话
      var t = groupSchedule[g.id];
      if (!t) {
        groupSchedule[g.id] = now + Math.floor(Math.random() * rollMs);
        return;
      }
      if (t <= now) {
        groupSchedule[g.id] = now + rollMs;
        if (Math.random() < CONFIG.groupCallChance) hit = g;
      }
    });
    if (!hit) return;

    var members = (hit.members || []).filter(function (id) { return findContact(id); });
    if (members.length === 0) return;

    // 发起人：随机一位成员；被邀请名单同样包含"我"（群人数包含我）
    var callerId = members[Math.floor(Math.random() * members.length)];
    var pool = members.filter(function (id) { return id !== callerId; });
    pool.push("me");

    // 邀请人数：1 人 10% / 2 人 35% / 3 人及以上 55%
    var r = Math.random();
    var n;
    if (r < CONFIG.groupInvite1Chance) n = 1;
    else if (r < CONFIG.groupInvite1Chance + CONFIG.groupInvite2Chance) n = 2;
    else n = 3 + Math.floor(Math.random() * (CONFIG.groupMaxExtraInvitees + 1));
    if (n > pool.length) n = pool.length;

    // 随机挑选被邀请成员
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    var invitees = pool.slice(0, n);

    if (invitees.indexOf("me") >= 0) {
      // 名单含我 → 按一对一呼入规则响铃（接听/未接留言与列表联系人一致）
      var others = invitees.filter(function (id) { return id !== "me"; });
      if (others.length) memberToMemberCall(hit, callerId, others);
      receiveCall(callerId);
    } else {
      // 纯成员间通话：仅记录（钩子，后期扩展）
      memberToMemberCall(hit, callerId, invitees);
    }
  }

  /* ==================== 初始化 ==================== */
  function init() {
    applyProbs();                              // 应用概率修改
    loadLog();
    callSchedule = {};                         // 重置调度表
    groupSchedule = {};                        // 重置群通话调度表
    groupCall = null;
    groupOverlayEl = null;
    removeCallBall();
    if (schedulerInt) clearInterval(schedulerInt);
    schedulerInt = setInterval(schedulerTick, 10000);   // 每 10 秒检查一次
    // 后台保活：回到前台 / 时间跳跃恢复时立即补查来电（不必等 10 秒）
    if (!resumeBound) {
      resumeBound = true;
      function onResumeTick() {
        if (document.visibilityState === "visible") { try { schedulerTick(); } catch (e) {} }
      }
      document.addEventListener("visibilitychange", onResumeTick);
      document.addEventListener("mine:timeskip", onResumeTick);
    }
  }

  /* ==================== 列表行内电话按钮（事件委托，捕获阶段拦截行点击） ==================== */
  document.addEventListener("click", function (e) {
    var btn = (e.target && e.target.closest) ? e.target.closest(".contact-call-btn") : null;
    if (!btn) return;
    var id = btn.getAttribute("data-call");
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();   // 阻止通讯录行的跳转
    callContact(id);
  }, true);

  /* ---------------- 公共方法 ---------------- */
  return {
    init: init,
    callContact: callContact,
    receiveCall: receiveCall,
    openGroupCall: openGroupCall,
    renderPage: renderPage,
    /* 通话记录（后期可扩展"通话记录"详情页） */
    getLog: function () { return callLog.slice(); }
  };
})();
