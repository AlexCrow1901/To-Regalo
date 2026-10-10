/* ========================================================================
   Mine · 字卡生成器（lexicon-card-generator.js）
   ------------------------------------------------------------------------
   依赖（需先加载）：
     lexicon.js          → window.MineLexicon（词库）
     lexicon-engine.js   → window.MineLexiconEngine（拼音还原 + 通顺度评分）
     cards.js            → window.MineCards（字卡池写入）
   功能：
   1) 双路生成
      · 模板路（默认 70%）：句法模板 + 按词性/白名单填词 → 候选字卡
      · 拼音路（默认 30%）：随机组合拼音串（联系人"打字"）→ 本地引擎还原成汉字
   2) 双轨审批
      · 本地 AI 评分审批：scoreSentence(语法正确率 + 语义通顺度) 分档
          ≥ autoThreshold（默认0.8）自动通过 → 入字卡池（后期聊天使用）
          0.5~0.8 进入人工审批队列（发送给用户审批）
          < manualLow（默认0.5）直接丢弃
      · 人工审批：approve 通过 → 入公用字卡池；reject 拒绝 → 丢弃归档
   3) 运行规则全部可配置（两路占比 / 阈值 / 批量 / 每小时候选数上限）
   存储：localStorage（storage.js 增强，自动落 IndexedDB）
     mine.cards.gen.config.v1   配置
     mine.cards.gen.items.v1    候选记录（auto/pending/approved/rejected/dropped）
     mine.cards.gen.last.v1     每联系人生成时间戳（限流）
   ======================================================================== */
window.MineCardGenerator = (function () {
  "use strict";

  var L = window.MineLexicon;
  var E = window.MineLexiconEngine;
  if (!L || !L.words || !E) return null;

  var CFG_KEY = "mine.cards.gen.config.v1";
  var ITEMS_KEY = "mine.cards.gen.items.v1";
  var LAST_KEY = "mine.cards.gen.last.v1";
  var CUSTOM_KEY = "mine.lexicon.custom.v1";   /* 词库管理页添加的自定义词 */
  var MAX_ITEMS = 400;                       /* 记录池上限（丢弃/拒绝归档截断线） */

  /* ==================== 默认配置 ==================== */
  var CFG_DEFAULT = {
    templateRatio: 0.7,      /* 模板路占比（拼音路 = 1 - templateRatio） */
    autoThreshold: 0.8,      /* ≥ 此置信度：自动通过入池（可实时发送） */
    manualLow: 0.5,          /* ≥manualLow 且 <autoThreshold：人工审批；<manualLow：丢弃 */
    batchSize: 3,            /* 每次生成候选数 */
    maxPerHour: 10,          /* 每联系人每小时候选数上限（运行规则，暂缓定值） */
    autoAddToPool: true,     /* 自动通过的字卡是否直接写入公用字卡池 */
    realtimeSend: true,      /* 自动通过的字卡是否实时发送给对应联系人 */
    disabledWords: []        /* 用户关闭/删除的字词（词库管理页开关） */
  };

  /* ==================== 词性索引 ==================== */
  var posIndex = {};         /* pos → 词条数组（词频降序） */
  var byWord = {};           /* 词 → 词条（白名单快速查找） */
  L.words.forEach(function (e) {
    var arr = posIndex[e.pos] || (posIndex[e.pos] = []);
    arr.push(e);
    byWord[e.w] = e;
  });
  var disabledSet = {};

  /* ==================== 自定义词（词库管理页添加，运行时可扩展） ====================
     自定义词存 localStorage mine.lexicon.custom.v1，加载时合并进 byWord / posIndex /
     词库数组（模板路白名单与拼音路高频池均可使用）；删除自定义词 = 从存储移除。 */
  function loadCustomWords() {
    try {
      var raw = localStorage.getItem(CUSTOM_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (c) {
        if (!c || !c.w || !c.p) return;
        var e = { w: c.w, p: c.p, pos: c.pos || "n", f: (c.f || 10000), isCustom: true };
        byWord[e.w] = e;
        var arr2 = posIndex[e.pos] || (posIndex[e.pos] = []);
        if (arr2.indexOf(e) < 0) arr2.push(e);
        if (L.words.indexOf(e) < 0) L.words.push(e);   /* 拼音路高频池可见 */
      });
    } catch (e) {}
  }
  function saveCustom(arr) {
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(arr || [])); } catch (e) {}
  }
  function addCustomWord(w, p, pos) {
    w = String(w || "").trim();
    if (!w || w.length < 1 || w.length > 6) return { ok: false, reason: "bad-word" };
    if (!/^[\u4e00-\u9fa5]+$/.test(w)) return { ok: false, reason: "not-chinese" };
    p = String(p || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!p) return { ok: false, reason: "no-pinyin" };
    pos = pos || "n";
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem(CUSTOM_KEY)) || []; } catch (e) {}
    if (!Array.isArray(arr)) arr = [];
    /* 已有同词（无论原词还是自定义）：原词 → 解除禁用并覆盖拼音；自定义 → 更新 */
    if (byWord[w] && !byWord[w].isCustom) {
      /* 原词：仅解除禁用（拼音/词性以原词为准，不入自定义） */
      var cfg = getConfig();
      var dis = cfg.disabledWords.filter(function (x) { return x !== w; });
      cfg.disabledWords = dis;
      saveJSON(CFG_KEY, cfg);
      loadCustomWords();
      return { ok: true, mode: "re-enable" };
    }
    var existing = arr.filter(function (c) { return c.w === w; });
    if (existing.length) {
      existing[0].p = p; existing[0].pos = pos;
      saveCustom(arr);
      loadCustomWords();
      return { ok: true, mode: "update" };
    }
    arr.push({ w: w, p: p, pos: pos, f: 10000 });
    saveCustom(arr);
    loadCustomWords();
    return { ok: true, mode: "add" };
  }
  function removeCustomWord(w) {
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem(CUSTOM_KEY)) || []; } catch (e) {}
    if (!Array.isArray(arr)) arr = [];
    var next = arr.filter(function (c) { return c.w !== w; });
    var removed = next.length !== arr.length;
    saveCustom(next);
    loadCustomWords();
    return { ok: removed };
  }
  function getCustomWords() {
    try {
      var arr = JSON.parse(localStorage.getItem(CUSTOM_KEY)) || [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  loadCustomWords();

  /* ==================== 命名槽位（保证模板路通顺 + 语义合理） ====================
     模板槽位带人称/及物性/搭配语义：
       · 主语分第一人称(subj1)/第二三人称(subj2)，避免"你们抱咱们"类人称错配
       · 动词分及物(vTrans 接人称宾语)/单字动作(vActS 接名词宾语)/双字动作
         (vAct2 自带宾语，如"吃饭""上班")/心理状态(vState 配程度副词)
       · 形容词分状态(stateAdj：累/开心)与评价(evalAdj：好/可爱)，搭配不同句位
       · 名词分话题(subjNoun：天气/心情)与宾语(objNoun：饭/水/猫)，避免"山饿"类错配
     抽词规则：命名槽 → 白名单随机；白名单词缺失时回退 posIndex 抽词。 */
  var SLOTS = {
    subj1: ["我", "咱们", "我们", "大家"],               /* 第一人称主语（"自己"作反身代词易错配，已剔除） */
    subj2: ["你", "他", "她", "你们", "他们"],                   /* 第二/三人称主语 */
    obj1:  ["你", "他", "她", "你们", "他们"],                   /* 人称宾语 */
    vTrans:["想", "爱", "懂", "陪", "等", "抱", "亲", "看", "听", "找", "送", "接", "帮", "问", "教", "约", "祝", "谢谢"],
    vActS: ["吃", "喝", "买", "玩", "做", "走", "去", "来", "回", "洗", "穿", "逛", "唱", "跳", "跑", "笑", "哭", "看", "听", "说", "问", "找"],  /* 单字动作，可接宾语（"睡"已剔除，避免"睡衣服"类错配） */
    vAct2: ["上班", "下班", "睡觉", "吃饭", "喝水", "散步", "锻炼", "运动", "旅行", "旅游", "回家", "出门", "聊天",
            "洗澡", "逛街", "熬夜", "打车", "加班", "做饭", "亲亲", "抱抱", "摸摸", "喝茶", "休息", "放假", "加油", "起床"], /* 双字动作，自带宾语 */
    vState:["想", "爱", "懂", "喜欢", "害怕", "担心", "放心", "希望", "相信"],  /* 心理/状态，配程度副词 */
    time:  ["今天", "明天", "昨天", "现在", "晚上", "早上", "中午", "下午", "周末", "一会儿"],
    adv:   ["很", "真", "好", "不", "太", "挺", "更", "最", "就", "都", "也", "还", "又"],
    stateAdj: ["累", "困", "饿", "饱", "开心", "快乐", "高兴", "幸福", "难过", "难受", "紧张", "放心", "忙"],  /* 状态形容词 */
    evalAdj:  ["好", "好看", "好听", "好玩", "温柔", "可爱", "认真", "努力", "漂亮", "帅"],                  /* 评价形容词 */
    subjNoun: ["天气", "心情", "工作", "生活", "身体", "电影", "音乐", "学习", "假期", "周末", "消息", "电话", "事情"],  /* 话题名词（作主语） */
    objNoun:  ["饭", "水", "家", "班", "觉", "茶", "歌", "书", "钱", "车", "街", "床", "菜", "肉", "蛋", "奶", "果", "糖", "药",
               "花", "树", "山", "海", "风", "雨", "雪", "云", "星", "月", "猫", "狗", "鸟", "鱼", "朋友", "家人", "同事",
               "同学", "老师", "礼物", "红包", "惊喜", "奶茶", "咖啡", "火锅", "外卖", "快递", "照片", "眼睛", "头发", "手",
               "脸", "脚", "心", "手机", "游戏", "球", "衣服", "鞋子", "伞", "灯"],  /* 宾语名词 */
    num:   ["一", "两", "三", "几"],
    quan:  ["个", "杯", "碗", "次", "点", "块", "张", "件", "份", "顿", "束"],
    mood:  ["啊", "呀", "哦", "哈", "呢", "嘛", "哟"],
    aux:   ["了", "的", "过", "吗", "吧", "呢"]
  };
  /* 命名槽 → 兜底词性（白名单词全缺时从词库该词性抽词） */
  var SLOT_FALLBACK_POS = {
    subj1: "r", subj2: "r", obj1: "r", vTrans: "v", vActS: "v", vAct2: "v", vState: "v",
    time: "t", adv: "d", stateAdj: "a", evalAdj: "a", subjNoun: "n", objNoun: "n",
    num: "m", quan: "q", mood: "e", aux: "u"
  };

  /* ==================== 句法模板库（情侣日常聊天场景） ==================== */
  var TEMPLATES = [
    ["subj1", "vTrans"],                   /* 我想 / 我爱 / 我懂 */
    ["subj1", "vTrans", "obj1"],           /* 我想你 / 我爱你 / 我懂你 */
    ["subj1", "vActS", "objNoun"],         /* 我吃饭 / 我喝水 / 我买菜 */
    ["subj1", "vAct2"],                    /* 我上班 / 我睡觉 / 我回家 */
    ["subj1", "vTrans", "obj1", "mood"],   /* 我想你呀 / 我爱你啊 */
    ["subj1", "adv", "vState"],            /* 我很想 / 我真爱 */
    ["subj1", "adv", "stateAdj"],          /* 我好累 / 我真开心 */
    ["subj2", "evalAdj"],                  /* 你好 / 他好 */
    ["subj2", "adv", "evalAdj"],           /* 你真可爱 / 她好温柔 */
    ["time", "stateAdj"],                  /* 今天累 / 周末开心 */
    ["time", "adv", "stateAdj"],           /* 今天很累 / 明天好困 */
    ["time", "vActS", "objNoun"],          /* 今天吃饭 / 明天买菜 */
    ["time", "vAct2"],                     /* 明天上班 / 晚上睡觉 */
    ["time", "vTrans", "obj1"],            /* 今天想你 / 明天陪你 */
    ["adv", "vState"],                     /* 很想 / 不想 */
    ["adv", "stateAdj"],                   /* 很累 / 好开心 */
    ["adv", "vState", "obj1"],             /* 很想你 / 不想他 */
    ["vActS", "objNoun"],                  /* 吃饭 / 喝水 / 买菜 */
    ["vAct2"],                             /* 睡觉 / 上班 */
    ["vTrans", "obj1"],                    /* 想你 / 爱你 / 懂你 */
    ["vActS", "aux"],                      /* 吃了 / 睡了 */
    ["vAct2", "aux"],                      /* 睡觉了 / 上班了 */
    ["vActS", "objNoun", "aux"],           /* 吃饭了 / 喝水了 */
    ["num", "quan", "objNoun"],            /* 一个人 / 两杯水 */
    ["subjNoun", "evalAdj"],               /* 天气好 / 心情好 / 电影好看 */
    ["evalAdj", "objNoun"],                /* 好心情 / 可爱猫 / 认真工作 */
    ["subj1", "vActS", "objNoun", "aux"]   /* 我吃饭了 / 我喝水了 */
  ];

  /* ==================== 存储读写 ==================== */
  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return fallback;
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function getConfig() {
    var cfg = loadJSON(CFG_KEY, null);
    if (!cfg || typeof cfg !== "object") cfg = {};
    var out = {};
    Object.keys(CFG_DEFAULT).forEach(function (k) { out[k] = (cfg[k] !== undefined) ? cfg[k] : CFG_DEFAULT[k]; });
    disabledSet = {};
    (out.disabledWords || []).forEach(function (w) { disabledSet[w] = true; });
    return out;
  }
  function getItems() {
    var items = loadJSON(ITEMS_KEY, null);
    return Array.isArray(items) ? items : [];
  }
  function saveItems(items) {
    /* 丢弃/拒绝归档只保留最近 MAX_ITEMS 条，防止无限增长 */
    var archived = items.filter(function (i) { return i.status === "dropped" || i.status === "rejected"; });
    var live = items.filter(function (i) { return i.status !== "dropped" && i.status !== "rejected"; });
    if (archived.length > MAX_ITEMS) archived = archived.slice(archived.length - MAX_ITEMS);
    saveJSON(ITEMS_KEY, live.concat(archived));
  }
  function getLast() {
    return loadJSON(LAST_KEY, {});
  }
  function saveLast(v) { saveJSON(LAST_KEY, v); }

  /* ==================== 抽词 ==================== */
  /* 高频加权随机：取 posIndex 前 topN（按词频已降序），偏前抽取 */
  function pickWeighted(arr, topN) {
    if (!arr || !arr.length) return null;
    var n = Math.min(topN || 200, arr.length);
    var idx = Math.floor(Math.pow(Math.random(), 1.6) * n);   /* 偏高频 */
    return arr[idx];
  }
  function notDisabled(e) { return e && !disabledSet[e.w]; }

  /* 从命名槽抽词：白名单优先 → 兜底词性 posIndex */
  function pickForSlot(slot) {
    var wl = SLOTS[slot];
    if (wl) {
      var cands = [];
      wl.forEach(function (w) {
        var e = byWord[w];
        if (e && !disabledSet[w]) cands.push(e);
      });
      if (cands.length) return cands[Math.floor(Math.random() * cands.length)];
    }
    var fb = SLOT_FALLBACK_POS[slot];
    var arr = (posIndex[fb || slot] || []).filter(notDisabled).filter(function (e) {
      return e.w.length <= 2;
    });
    return pickWeighted(arr, 300);
  }

  /* ==================== 模板路生成 ==================== */
  function templateRoute() {
    var tpl = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
    var words = [];
    for (var i = 0; i < tpl.length; i++) {
      var e = pickForSlot(tpl[i]);
      if (!e) return null;
      words.push(e.w);
    }
    var text = words.join("");
    if (text.length < 2 || text.length > 8) return null;
    return { text: text, input: null, route: "template", words: words };
  }

  /* ==================== 拼音路生成 ====================
     模拟"联系人随机组合拼音"：从词库高频词随机抽 2~3 个，取拼音拼接，
     交给本地引擎还原（还原结果可能因同音歧义而不同于原词——这正是
     "对方在打字、我方判断意思"的场景）。 */
  function pinyinRoute() {
    /* 高频词池：词频前 2500 的 1~2 字词（拼出短拼音串，还原成功率有保障） */
    var pool = [];
    for (var i = 0; i < L.words.length && pool.length < 2500; i++) {
      var e = L.words[i];
      if (disabledSet[e.w]) continue;
      if (e.w.length >= 1 && e.w.length <= 2 && e.p) pool.push(e);
    }
    if (pool.length < 2) return null;
    var n = 2 + Math.floor(Math.random() * 2);              /* 2~3 个词 */
    var parts = [];
    var textWords = [];
    for (var k = 0; k < n; k++) {
      var w = pool[Math.floor(Math.pow(Math.random(), 1.5) * pool.length)];
      if (!w.p) continue;
      parts.push(w.p);
      textWords.push(w.w);
    }
    if (parts.length < 2) return null;
    var input = parts.join(" ");                            /* 联系人的"输入原文" */
    var res = E.restorePinyin(input);
    if (!res || !res.text) return null;
    return {
      text: res.text,
      input: input,
      route: "pinyin",
      restoreConf: res.confidence,
      candidates: res.candidates || [],
      words: textWords
    };
  }

  /* ==================== 评分分档 ==================== */
  function evaluate(gen) {
    var sc = E.scoreSentence(gen.text);
    /* 拼音路合并还原置信度：语法通顺 60% + 还原可信度 40% */
    var conf = gen.route === "pinyin"
      ? 0.6 * sc.total + 0.4 * (gen.restoreConf || 0)
      : sc.total;
    return {
      syntax: sc.syntax,
      fluency: sc.fluency,
      conf: Math.round(conf * 1000) / 1000
    };
  }

  /* ==================== 入公用字卡池 ==================== */
  function addToPublicPool(text) {
    if (window.MineCards && window.MineCards.addPublicCards) {
      var r = window.MineCards.addPublicCards(text);
      return r.added > 0;
    }
    return false;
  }

  /* ==================== 主流程：生成 ==================== */
  function generate(contactId, count) {
    var cfg = getConfig();
    var cid = contactId || "global";
    var last = getLast();
    var now = Date.now();
    var hour = 3600000;
    /* 限流：每联系人每小时候选数上限 */
    var stamps = (last[cid] || []).filter(function (ts) { return now - ts < hour; });
    if (stamps.length >= cfg.maxPerHour) {
      return { blocked: true, reason: "per-hour-limit", limit: cfg.maxPerHour, nextIn: Math.ceil((hour - (now - stamps[0])) / 60000) };
    }
    var batch = count || cfg.batchSize;
    batch = Math.max(1, Math.min(10, batch));
    var items = getItems();
    var created = 0, autoN = 0, pendingN = 0, droppedN = 0, dupN = 0;
    for (var i = 0; i < batch; i++) {
      /* 双路选择（占比可配置） */
      var gen = (Math.random() < cfg.templateRatio) ? templateRoute() : pinyinRoute();
      if (!gen) { continue; }
      /* 去重：同文本同路线的记录已存在则不重复生成 */
      var dup = items.some(function (it) { return it.text === gen.text && it.route === gen.route && (it.status === "auto" || it.status === "approved" || it.status === "pending"); });
      if (dup) { dupN++; continue; }
      var ev = evaluate(gen);
      var item = {
        id: "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        text: gen.text,
        input: gen.input,
        route: gen.route,
        syntax: ev.syntax,
        fluency: ev.fluency,
        conf: ev.conf,
        restoreConf: gen.restoreConf || null,
        candidates: gen.candidates || [],
        status: "pending",
        contactId: cid,
        createdAt: now,
        genWords: gen.words || []
      };
      created++;
      if (ev.conf >= cfg.autoThreshold) {
        item.status = "auto";
        item.judgedBy = "ai";
        if (cfg.autoAddToPool) addToPublicPool(gen.text);
        /* 实时发送联动：指定了联系人且开启实时发送 → 直接作为对方消息入会话 */
        if (cfg.realtimeSend && cid !== "global" && window.MineChat && window.MineChat.sendGeneratedCard) {
          var sr = window.MineChat.sendGeneratedCard(cid, gen.text);
          item.sentTo = sr && sr.ok ? cid : null;
        }
        autoN++;
      } else if (ev.conf >= cfg.manualLow) {
        item.status = "pending";               /* 人工审批队列 */
        item.judgedBy = "ai";
        pendingN++;
      } else {
        item.status = "dropped";
        item.judgedBy = "ai";
        item.dropReason = "low-confidence";
        droppedN++;
      }
      items.push(item);
    }
    saveItems(items);
    /* 限流记录：按实际生成的候选数累计时间戳（一次生成 batch 个 → 记 batch 次） */
    for (var t = 0; t < created; t++) stamps.push(now);
    last[cid] = stamps;
    saveLast(last);
    return { blocked: false, created: created, auto: autoN, pending: pendingN, dropped: droppedN, dup: dupN, limit: cfg.maxPerHour };
  }

  /* ==================== 人工审批 ==================== */
  function approve(id) {
    var items = getItems();
    var it = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) { it = items[i]; break; }
    }
    if (!it) return { ok: false, reason: "not-found" };
    if (it.status === "approved") return { ok: false, reason: "already-approved" };
    if (it.status === "dropped" || it.status === "rejected") return { ok: false, reason: "closed" };
    var added = addToPublicPool(it.text);
    it.status = "approved";
    it.judgedBy = "manual";
    it.decidedAt = Date.now();
    saveItems(items);
    return { ok: true, addedToPool: added };
  }
  function reject(id) {
    var items = getItems();
    var it = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) { it = items[i]; break; }
    }
    if (!it) return { ok: false, reason: "not-found" };
    if (it.status === "dropped" || it.status === "rejected" || it.status === "approved") return { ok: false, reason: "closed" };
    it.status = "rejected";
    it.judgedBy = "manual";
    it.decidedAt = Date.now();
    saveItems(items);
    return { ok: true };
  }
  function resetLast(contactId) {
    var last = getLast();
    if (contactId) delete last[contactId];
    else { last = {}; }
    saveLast(last);
  }

  /* ==================== 查询 ==================== */
  function getItemsBy(status) {
    var items = getItems();
    return status ? items.filter(function (i) { return i.status === status; }) : items;
  }
  function getPending() { return getItemsBy("pending"); }
  function getPool() { return getItemsBy("auto").concat(getItemsBy("approved")); }
  function getDropped() { return getItemsBy("dropped").concat(getItemsBy("rejected")); }
  function getConfigAPI() { return getConfig(); }
  function setConfigAPI(patch) {
    var cfg = getConfig();
    if (patch && typeof patch === "object") {
      Object.keys(patch).forEach(function (k) {
        if (CFG_DEFAULT[k] !== undefined) cfg[k] = patch[k];
      });
      /* 归一化合法区间 */
      cfg.templateRatio = Math.max(0, Math.min(1, Number(cfg.templateRatio) || CFG_DEFAULT.templateRatio));
      cfg.autoThreshold = Math.max(0, Math.min(1, Number(cfg.autoThreshold) || CFG_DEFAULT.autoThreshold));
      cfg.manualLow = Math.max(0, Math.min(Number(cfg.autoThreshold) - 0.01, Number(cfg.manualLow) || CFG_DEFAULT.manualLow));
      cfg.batchSize = Math.max(1, Math.min(10, parseInt(cfg.batchSize, 10) || CFG_DEFAULT.batchSize));
      cfg.maxPerHour = Math.max(1, Math.min(100, parseInt(cfg.maxPerHour, 10) || CFG_DEFAULT.maxPerHour));
      cfg.autoAddToPool = !!cfg.autoAddToPool;
      cfg.disabledWords = Array.isArray(cfg.disabledWords) ? cfg.disabledWords : [];
      saveJSON(CFG_KEY, cfg);
    }
    return getConfig();
  }
  function getStats() {
    var items = getItems();
    var stat = { total: items.length, auto: 0, pending: 0, approved: 0, rejected: 0, dropped: 0 };
    items.forEach(function (i) { if (stat[i.status] !== undefined) stat[i.status]++; });
    return stat;
  }

  return {
    generate: generate,
    approve: approve,
    reject: reject,
    getPending: getPending,
    getPool: getPool,
    getDropped: getDropped,
    getItems: getItemsBy,
    getConfig: getConfigAPI,
    setConfig: setConfigAPI,
    getStats: getStats,
    resetLast: resetLast,
    /* 词库管理页：自定义词增删查 */
    addCustomWord: addCustomWord,
    removeCustomWord: removeCustomWord,
    getCustomWords: getCustomWords,
    templates: TEMPLATES.length,
    version: "1.1.0"
  };
})();
