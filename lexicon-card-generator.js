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
  var TRAIN_KEY = "mine.lexicon.train.v1";     /* 本地训练数据（审批样本 + 训练产物） */
  var BACKLOG_KEY = "mine.cards.gen.backlog.v1"; /* 后台组卡调度（每联系人生成时间戳） */
  var REQ_KEY = "mine.cards.gen.limitreq.v1";    /* 上限调整申请队列 */
  var MAX_ITEMS = 400;                       /* 记录池上限（丢弃/拒绝归档截断线） */

  /* ==================== 默认配置 ==================== */
  var CFG_DEFAULT = {
    templateRatio: 0.7,      /* 模板路占比（拼音路 = 1 - templateRatio） */
    autoThreshold: 0.8,      /* ≥ 此置信度：自动通过入池（可实时发送） */
    manualLow: 0.5,          /* ≥manualLow 且 <autoThreshold：人工审批；<manualLow：丢弃 */
    batchSize: 3,            /* 每次生成候选数 */
    maxPerHour: 10,          /* 每联系人每小时候选数上限（实时/手动批量限流，运行规则可调） */
    autoAddToPool: true,     /* 自动通过的字卡是否直接写入公用字卡池 */
    realtimeSend: true,      /* 自动通过的字卡是否实时发送给对应联系人 */
    disabledWords: [],        /* 用户关闭/删除的字词（词库管理页开关） */
    /* ---- 本地训练（只作用于模板路，批量稳定更新） ---- */
    trainBatchSize: 20,      /* 攒满 N 条人工审批样本后自动执行一次批量训练 */
    /* ---- 后台组卡调度（联系人主动随机组字卡） ---- */
    backlogMax: 20,          /* 每联系人每小时后台自动组卡数量上限（随机 0~N 条） */
    backlogProb: 0.01,       /* 每小时向用户申请调整上限的概率（1%） */
    reqDelta: 5,             /* 申请调整幅度（±5 条） */
    reqMin: 5,               /* 上限下限（条） */
    reqMax: 50,              /* 上限上限（条） */
    reqTimeout: 15,          /* 申请超时（分钟）：未处理则系统自动生效 */
    /* ---- AI 终审接口位（默认关闭，留好接入点） ---- */
    aiEnabled: false,        /* AI 终审开关 */
    aiProvider: "",          /* 服务商：deepseek / qwen / glm 等（OpenAI 兼容格式） */
    aiModel: "",             /* 模型名，如 deepseek-chat */
    aiApiKey: "",            /* API Key（本地存储） */
    aiGrayLow: 0.4,          /* 灰色区间下限：评分低于此不送 AI */
    aiGrayHigh: 0.85         /* 灰色区间上限：评分高于此不送 AI */
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

  /* ==================== 本地训练模块（只作用于模板路，三通道样本） ====================
     训练样本来源（权重不同，全部只作用于模板路）：
       · 后台人工审批：你点通过 = 强正样本(1.0)、点拒绝 = 强负样本(1.0)
       · 实时聊天系统自动通过并发出：弱正样本(0.5)——系统认为好且实际发出使用
       · 实时聊天被系统拦截（低分未发出）：不计入（系统自己的判断，不让你背锅）
     样本攒满 trainBatchSize 条后自动批量训练一次（稳定更新）：
       1) 维度权重：比较本批正/负样本在「语法 / 通顺」两维度的加权平均差
       2) 搭配概率表：通过卡的相邻词搭配加权计数（bigram），拒绝卡记入负表
       3) 个人偏好词：通过卡中的词加权计数、拒绝卡扣减（下限 0）
     评分应用：模板路最终分 = 训练权重 × (语法/通顺) + 训练系数(搭配命中与词偏好)。
     拼音路不参与训练。训练数据可导出 / 导入 / 重置。
     ======================================================================== */
  var TRAIN_DEFAULT = {
    samples: [],      /* 已训练的样本（历史，仅统计展示） */
    pending: [],      /* 待训练样本（攒满阈值触发批量更新） */
    weights: { syntax: 0.55, fluency: 0.45 },  /* 维度权重（总和=1） */
    bigrams: {},      /* 通过卡相邻词搭配计数（正） */
    negBigrams: {},   /* 拒绝卡相邻词搭配计数（负） */
    prefWords: {},    /* 个人偏好词计数（可为 0~N） */
    version: 1,
    updatedAt: 0      /* 最近一次批量训练时间 */
  };

  function loadTrain() {
    var t = loadJSON(TRAIN_KEY, null);
    if (!t || typeof t !== "object") t = {};
    var out = {};
    Object.keys(TRAIN_DEFAULT).forEach(function (k) {
      if (k === "weights") {
        out.weights = { syntax: 0.55, fluency: 0.45 };
        if (t.weights && typeof t.weights === "object") {
          var s = Number(t.weights.syntax);
          if (isFinite(s)) {
            s = Math.max(0.3, Math.min(0.7, s));
            out.weights = { syntax: s, fluency: Math.round((1 - s) * 1000) / 1000 };
          }
        }
      } else if (k === "bigrams" || k === "negBigrams" || k === "prefWords") {
        out[k] = (t[k] && typeof t[k] === "object") ? t[k] : {};
      } else if (k === "samples" || k === "pending") {
        out[k] = Array.isArray(t[k]) ? t[k] : [];
      } else {
        out[k] = (t[k] !== undefined) ? t[k] : TRAIN_DEFAULT[k];
      }
    });
    return out;
  }
  function saveTrain(t) { saveJSON(TRAIN_KEY, t); }

  /* 从文本提取相邻词搭配（按引擎分词，二字词+三字词组合），按样本权重计数 */
  function collectNgrams(text, map, weight) {
    var seg = E.segment(text);
    for (var i = 0; i < seg.length - 1; i++) {
      var g2 = seg[i].w + seg[i + 1].w;
      map[g2] = (map[g2] || 0) + weight;
      if (i < seg.length - 2) {
        var g3 = g2 + seg[i + 2].w;
        map[g3] = (map[g3] || 0) + weight;
      }
    }
  }
  /* 词偏好：通过卡词计数 +weight，拒绝卡 -weight（下限 0；只统计 1~2 字词避免长词过冲） */
  function bumpPrefWords(text, map, weight) {
    var seg = E.segment(text);
    seg.forEach(function (e) {
      if (e.w.length >= 1 && e.w.length <= 2) {
        var nv = Math.max(0, (map[e.w] || 0) + weight);
        if (nv === 0) delete map[e.w];   /* 归零即移除，不留 0 值 */
        else map[e.w] = nv;
      }
    });
  }

  /* 批量训练：一次性处理当前 pending 样本（稳定更新）。
     tr 可选：调用方已持有修改后的训练对象时直接传入，避免重复读取丢失新样本 */
  function trainRun(tr) {
    tr = tr || loadTrain();
    var batch = tr.pending;
    if (!batch.length) return { ok: true, trained: 0 };
    var pos = batch.filter(function (s) { return s.label === 1; });
    var neg = batch.filter(function (s) { return s.label === 0; });
    /* 1) 维度权重：正样本占优的维度加权（按样本权重加权平均） */
    if (pos.length && neg.length) {
      var wavg = function (arr, k) {
        var s = 0, w = 0;
        arr.forEach(function (x) { var wt = Number(x.weight) || 1; s += (Number(x[k]) || 0) * wt; w += wt; });
        return w ? s / w : 0;
      };
      var dSyn = wavg(pos, "syntax") - wavg(neg, "syntax");
      var dFlu = wavg(pos, "fluency") - wavg(neg, "fluency");
      var shift = Math.max(-0.04, Math.min(0.04, (dSyn - dFlu) * 0.3));
      var ns = Math.max(0.35, Math.min(0.65, tr.weights.syntax + shift));
      tr.weights = { syntax: Math.round(ns * 1000) / 1000, fluency: Math.round((1 - ns) * 1000) / 1000 };
    }
    /* 2) 搭配概率表（按样本权重） */
    pos.forEach(function (s) { collectNgrams(s.text, tr.bigrams, Number(s.weight) || 1); });
    neg.forEach(function (s) { collectNgrams(s.text, tr.negBigrams, Number(s.weight) || 1); });
    /* 3) 个人偏好词（按样本权重） */
    pos.forEach(function (s) { bumpPrefWords(s.text, tr.prefWords, Number(s.weight) || 1); });
    neg.forEach(function (s) { bumpPrefWords(s.text, tr.prefWords, -(Number(s.weight) || 1)); });
    /* 归档样本 */
    tr.samples = tr.samples.concat(batch);
    tr.pending = [];
    tr.updatedAt = Date.now();
    saveTrain(tr);
    return { ok: true, trained: batch.length, pos: pos.length, neg: neg.length, weights: tr.weights };
  }

  /* 审批/实时发送时采集训练样本（只采模板路；weight=1 人工强样本 / 0.5 实时自动弱正样本） */
  function trainCollect(item, label, weight) {
    if (!item || item.route !== "template") return;
    var tr = loadTrain();
    tr.pending.push({
      text: item.text, label: label, weight: weight || 1,
      conf: item.conf, syntax: item.syntax, fluency: item.fluency, ts: Date.now()
    });
    /* 攒满阈值 → 立即批量训练（稳定更新；直接传入内存对象，样本不丢失） */
    var cfg = getConfig();
    if (tr.pending.length >= (cfg.trainBatchSize || 20)) {
      trainRun(tr);
    } else {
      saveTrain(tr);
    }
  }

  /* 训练系数：命中用户偏好搭配/词 → 微调模板路评分（温和区间 0.85~1.15） */
  function trainFactor(text) {
    var tr = loadTrain();
    var hasData = Object.keys(tr.bigrams).length || Object.keys(tr.prefWords).length;
    if (!hasData) return 1;
    var seg = E.segment(text);
    var hits = [], miss = 0;
    for (var i = 0; i < seg.length - 1; i++) {
      var g2 = seg[i].w + seg[i + 1].w;
      if (tr.bigrams[g2] !== undefined) hits.push(tr.bigrams[g2]);
      else if (tr.negBigrams[g2] !== undefined) hits.push(-tr.negBigrams[g2]);
      else miss++;
    }
    var avgHit = hits.length ? hits.reduce(function (a, b) { return a + b; }, 0) / hits.length : 0;
    var hitRatio = hits.length / Math.max(1, hits.length + miss);
    var bigGain = avgHit * hitRatio * 0.1;
    var prefs = seg.map(function (e) { return tr.prefWords[e.w] || 0; });
    var avgPref = prefs.length ? prefs.reduce(function (a, b) { return a + b; }, 0) / prefs.length : 0;
    var prefGain = avgPref > 0 ? Math.min(0.06, avgPref * 0.01) : (avgPref < 0 ? Math.max(-0.06, avgPref * 0.02) : 0);
    var f = 1 + bigGain + prefGain;
    return Math.max(0.85, Math.min(1.15, f));
  }
  /* 模板路当前权重（训练后生效） */
  function trainWeights() {
    return loadTrain().weights || { syntax: 0.55, fluency: 0.45 };
  }

  /* ==================== 后台组卡调度 + 上限调整申请 ====================
     运行机制：
       · 每个联系人每小时后台自动组字卡：条数在 [0, backlogMax] 随机（默认 0~20）
         ——全部进入人工审批队列（不系统审批、不自动发送/入池）
       · 每小时 1%（backlogProb）概率：联系人向你申请"增加/降低"每小时组卡上限
         ——方向 50/50 随机，幅度 ±reqDelta（默认 5 条），钳制在 reqMin~reqMax（5~50）
         ——你在 reqTimeout 分钟内通过/拒绝按你的决定；超时未处理 → 系统自动生效
       · tick() 为幂等检查：处理过期申请 + 对每个联系人补跑到期的小时组卡
         （由页面打开 / 审批页进入 / keepalive 心跳 / 60s 定时器触发）
     存储：
       BACKLOG_KEY  { perCid: { lastHour: ts } }      每个联系人最近一次后台组卡时间
       REQ_KEY      [申请记录]  {id, cid, direction, delta, newLimit, createdAt,
                                 expireAt, status: pending/approved/rejected/auto}
     ======================================================================== */
  function getBacklog() {
    var b = loadJSON(BACKLOG_KEY, null);
    return (b && typeof b === "object") ? b : {};
  }
  function saveBacklog(b) { saveJSON(BACKLOG_KEY, b); }
  function getReqs() {
    var r = loadJSON(REQ_KEY, null);
    return Array.isArray(r) ? r : [];
  }
  function saveReqs(r) { saveJSON(REQ_KEY, r); }

  function clampLimit(v, cfg) {
    return Math.max(cfg.reqMin, Math.min(cfg.reqMax, v));
  }

  /* 创建一条上限调整申请（方向随机 50/50） */
  function createLimitRequest(cid, cfg) {
    var cur = cfg.backlogMax;
    var up = Math.random() < 0.5;
    var next = clampLimit(cur + (up ? cfg.reqDelta : -cfg.reqDelta), cfg);
    if (next === cur) return null;   /* 已在边界，无调整空间 */
    var now = Date.now();
    return {
      id: "lr" + now.toString(36) + Math.random().toString(36).slice(2, 6),
      cid: cid,
      direction: up ? "up" : "down",
      delta: cfg.reqDelta,
      newLimit: next,
      createdAt: now,
      expireAt: now + (cfg.reqTimeout || 15) * 60000,
      status: "pending",
      auto: false
    };
  }

  /* 处理超时未处理的申请：系统自动按申请方向修改上限 */
  function processExpiredRequests() {
    var cfg = getConfig();
    var reqs = getReqs();
    var now = Date.now();
    var changed = 0, autoed = 0;
    reqs.forEach(function (r) {
      if (r.status === "pending" && r.expireAt && now >= r.expireAt) {
        cfg.backlogMax = clampLimit(r.newLimit, cfg);
        r.status = "auto";
        r.appliedAt = now;
        autoed++;
      }
    });
    if (autoed) saveJSON(CFG_KEY, cfg);
    var live = reqs.filter(function (r) { return r.status === "pending"; });
    if (live.length !== reqs.length) saveReqs(live);
    return { autoed: autoed, backlogMax: cfg.backlogMax };
  }

  /* 单条后台组卡候选（模板/拼音两路随机，全部进人工审批队列） */
  function backlogCard(cid) {
    var cfg = getConfig();
    var gen = (Math.random() < cfg.templateRatio) ? templateRoute() : pinyinRoute();
    if (!gen) return null;
    var items = getItems();
    var dup = items.some(function (it) { return it.text === gen.text && it.route === gen.route && (it.status === "auto" || it.status === "approved" || it.status === "pending"); });
    if (dup) return null;
    var ev = evaluate(gen);
    var item = {
      id: "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      text: gen.text, input: gen.input, route: gen.route,
      syntax: ev.syntax, fluency: ev.fluency, conf: ev.conf,
      restoreConf: gen.restoreConf || null, candidates: gen.candidates || [],
      status: "pending",          /* 后台组卡全部人工审批 */
      source: "backlog",          /* 标记来源：后台自动组卡 */
      contactId: cid,
      createdAt: Date.now(),
      genWords: gen.words || []
    };
    items.push(item);
    saveItems(items);
    return item;
  }

  /* 幂等检查：①处理过期上限申请；②对每个联系人补跑到期的小时后台组卡 */
  function tick() {
    var cfg = getConfig();
    var exp = processExpiredRequests();
    /* 拿到最新配置（超时自动修改后 backlogMax 可能已变） */
    cfg = getConfig();
    var backlog = getBacklog();
    var now = Date.now();
    var HOUR = 3600000;
    var contacts = (window.MineContacts && MineContacts.getState && MineContacts.getState().contacts) || [];
    var made = 0, reqMade = 0;
    contacts.forEach(function (c) {
      var cid = c.id;
      if (!cid) return;
      var last = backlog[cid] || 0;
      if (now - last < HOUR) return;                    /* 未满 1 小时，跳过 */
      /* 每小时随机生成 [0, backlogMax] 条，全部进人工审批 */
      var n = Math.floor(Math.random() * (cfg.backlogMax + 1));
      for (var i = 0; i < n; i++) { if (backlogCard(cid)) made++; }
      /* 1% 概率：创建上限调整申请 */
      if (Math.random() < (cfg.backlogProb || 0.01)) {
        var req = createLimitRequest(cid, cfg);
        if (req) {
          var reqs = getReqs();
          reqs.push(req);
          saveReqs(reqs);
          reqMade++;
        }
      }
      backlog[cid] = now;
    });
    saveBacklog(backlog);
    /* 有新的后台组卡进入待审批 → 发送通知（与联系人消息通知一致） */
    if (made > 0) {
      var N = window.MineKeepalive;
      if (N && N.notify) {
        try {
          N.notify("字卡审批", "联系人生成了 " + made + " 张新字卡，待你审批", { kind: "cards-approve" });
        } catch (e) {}
      }
    }
    return { made: made, requests: reqMade, autoed: exp.autoed, backlogMax: cfg.backlogMax };
  }

  /* 用户处理上限调整申请：approve 生效 / reject 丢弃（超时由 tick 自动处理） */
  function respondLimitRequest(id, approve) {
    var cfg = getConfig();
    var reqs = getReqs();
    var r = null;
    for (var i = 0; i < reqs.length; i++) {
      if (reqs[i].id === id) { r = reqs[i]; break; }
    }
    if (!r) return { ok: false, reason: "not-found" };
    if (r.status !== "pending") return { ok: false, reason: "closed" };
    if (Date.now() >= r.expireAt) {
      /* 已超时：按自动流程处理 */
      cfg.backlogMax = clampLimit(r.newLimit, cfg);
      r.status = "auto";
      r.appliedAt = Date.now();
      saveJSON(CFG_KEY, cfg);
      var live = reqs.filter(function (x) { return x.status === "pending"; });
      saveReqs(live);
      return { ok: true, mode: "auto" };
    }
    if (approve) {
      cfg.backlogMax = clampLimit(r.newLimit, cfg);
      saveJSON(CFG_KEY, cfg);
      r.status = "approved";
    } else {
      r.status = "rejected";
    }
    r.decidedAt = Date.now();
    saveReqs(reqs.filter(function (x) { return x.status === "pending"; }).concat([r]));
    return { ok: true, mode: approve ? "approved" : "rejected", backlogMax: cfg.backlogMax };
  }

  /* ==================== AI 终审接口位（默认关闭） ====================
     灰色区间（aiGrayLow ~ aiGrayHigh）的候选送外部 AI 判断语义通顺度。
     接口约定：返回 { conf: 调整后置信度(0~1), note: 简短理由 }；
     未启用 / 无 Key / 区间外 / 失败超时 → 返回 null（降级为本地分）。
     启用方式：运行规则页配置 aiEnabled / aiProvider / aiModel / aiApiKey。 */
  function aiReview(item) {
    var cfg = getConfig();
    if (!cfg.aiEnabled || !cfg.aiProvider || !cfg.aiApiKey) return null;
    if (item.conf < (cfg.aiGrayLow || 0.4) || item.conf > (cfg.aiGrayHigh || 0.85)) return null;
    /* TODO(接入点)：调用 provider 的 OpenAI 兼容 chat/completions：
         system: 判断一句中文是否通顺、像日常口语；返回 JSON {"score":0~1,"note":"原因"}
         fetch(apiUrl, {method:'POST', headers:{Authorization:'Bearer '+key}, body:{...}})
       超时/失败/非 200 一律 return null，由本地评分兜底。 */
    return null;
  }

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
    /* 拼音路合并还原置信度：语法通顺 60% + 还原可信度 40%（不参与本地训练） */
    if (gen.route === "pinyin") {
      var confP = 0.6 * sc.total + 0.4 * (gen.restoreConf || 0);
      return {
        syntax: sc.syntax,
        fluency: sc.fluency,
        conf: Math.round(confP * 1000) / 1000
      };
    }
    /* 模板路：训练权重（语法/通顺）+ 训练系数（搭配与词偏好） */
    var w = trainWeights();
    var base = w.syntax * sc.syntax + w.fluency * sc.fluency;
    var confT = base * trainFactor(gen.text);
    return {
      syntax: sc.syntax,
      fluency: sc.fluency,
      conf: Math.round(confT * 1000) / 1000
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
      /* AI 终审接口位：灰色区间卡片送外部 AI 判断（未启用时返回 null，不影响本地分） */
      var ai = aiReview(item);
      if (ai && typeof ai.conf === "number") {
        item.conf = Math.max(0, Math.min(1, ai.conf));
        item.aiNote = ai.note || null;
      }
      /* 后台组卡全部人工审批（无自动通过）：评分 ≥ 人工下限 → 进待审批队列；低分丢弃。
         autoThreshold 仅用于实时组卡（realtimeCard）的实时发出判定。 */
      if (item.conf >= cfg.manualLow) {
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
    var added = false;
    /* 归属：带具体联系人的字卡（后台组卡等）→ 该联系人个人字卡池（仅供本人使用）；
       通用候选（contactId=global）→ 公用字卡池 */
    if (it.contactId && it.contactId !== "global" && window.MineCards && window.MineCards.addPerCard) {
      added = window.MineCards.addPerCard(it.contactId, it.text) !== false;
    } else {
      added = addToPublicPool(it.text);
    }
    it.status = "approved";
    it.judgedBy = "manual";
    it.decidedAt = Date.now();
    saveItems(items);
    /* 本地训练：人工"通过" = 强正样本（只采模板路） */
    trainCollect(it, 1, 1);
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
    /* 本地训练：人工"拒绝" = 强负样本（只采模板路） */
    trainCollect(it, 0, 1);
    return { ok: true };
  }
  function resetLast(contactId) {
    var last = getLast();
    if (contactId) delete last[contactId];
    else { last = {}; }
    saveLast(last);
  }

  /* ==================== 实时聊天组卡（系统审批即发，入池需你审批） ====================
     联系人在实时聊天中组字卡：系统审批（评分 ≥ 自动阈值 → 通过）后**实时发出**，
     聊天体验不变；但该卡**不会自动入池**，转为待审批（来源标记「实时字卡」），
     你审批通过后才进入字卡池（实时字卡栏）；低分被系统拦截。
     发送动作由 chat.js 调用方完成（sendGeneratedCard）。 */
  function realtimeCard(cid) {
    var cfg = getConfig();
    var gen = (Math.random() < cfg.templateRatio) ? templateRoute() : pinyinRoute();
    if (!gen) return null;
    var ev = evaluate(gen);
    var item = {
      id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      text: gen.text, input: gen.input, route: gen.route,
      syntax: ev.syntax, fluency: ev.fluency, conf: ev.conf,
      restoreConf: gen.restoreConf || null, candidates: gen.candidates || [],
      status: "pending", judgedBy: null, source: "realtime",
      contactId: cid || "global",
      createdAt: Date.now(),
      genWords: gen.words || []
    };
    if (ev.conf >= cfg.autoThreshold) {
      item.sentTo = cid || null;
      var items = getItems();
      /* 实时发出（系统审批通过即发，仅实时聊天使用，不入池） */
      /* 去重：待审批/已入池已有同文本卡则不重复添加（避免审批堆积） */
      var dup = items.some(function (it) {
        return it.text === gen.text && (it.status === "pending" || it.status === "approved" || it.status === "auto");
      });
      if (!dup) {
        items.push(item);
        saveItems(items);
        /* 审批通知：与后台组卡一致 */
        var N = window.MineKeepalive;
        if (N && N.notify) {
          try {
            N.notify("字卡审批", "联系人实时发送了一张字卡，待你审批", { kind: "cards-approve" });
          } catch (e) {}
        }
      } else {
        saveItems(items);
      }
      return { ok: true, text: gen.text, conf: ev.conf, item: item };
    }
    /* 低分拦截：记录为 dropped 供统计，不计入训练 */
    item.status = "dropped";
    item.dropReason = "low-confidence";
    var items2 = getItems();
    items2.push(item);
    saveItems(items2);
    return { ok: false, text: gen.text, conf: ev.conf };
  }

  /* ==================== 字卡池删除 ====================
     从生成器记录移除 + 同步从对应字卡池（个人/公用）移除文本 */
  function removePoolItem(id) {
    var items = getItems();
    var it = null, idx = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) { it = items[i]; idx = i; break; }
    }
    if (!it) return { ok: false, reason: "not-found" };
    if (it.status !== "auto" && it.status !== "approved") return { ok: false, reason: "not-in-pool" };
    items.splice(idx, 1);
    saveItems(items);
    var M = window.MineCards;
    if (it.contactId && it.contactId !== "global" && M && M.removePerCardByValue) {
      M.removePerCardByValue(it.contactId, it.text);
    } else if (M && M.removePublicCardByValue) {
      M.removePublicCardByValue(it.text);
    }
    return { ok: true, text: it.text };
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

  /* ==================== 本地训练：查询与管理 ==================== */
  function getTrainStats() {
    var tr = loadTrain();
    return {
      trained: tr.samples.length,
      pending: tr.pending.length,
      batchSize: getConfig().trainBatchSize || 20,
      weights: { syntax: tr.weights.syntax, fluency: tr.weights.fluency },
      bigramCount: Object.keys(tr.bigrams).length,
      negBigramCount: Object.keys(tr.negBigrams).length,
      prefWordCount: Object.keys(tr.prefWords).length,
      updatedAt: tr.updatedAt
    };
  }
  function trainNow() {
    var r = trainRun();
    return r;
  }
  function resetTrain() {
    saveJSON(TRAIN_KEY, null);
    return { ok: true };
  }
  function exportTrain() {
    return JSON.stringify(loadTrain());
  }
  function importTrain(json) {
    try {
      var d = JSON.parse(json);
      if (!d || typeof d !== "object") return { ok: false, reason: "bad-json" };
      var t = loadTrain();
      if (Array.isArray(d.samples)) t.samples = d.samples;
      if (Array.isArray(d.pending)) t.pending = d.pending;
      if (d.weights && typeof d.weights === "object") {
        var s = Number(d.weights.syntax);
        if (isFinite(s)) {
          s = Math.max(0.3, Math.min(0.7, s));
          t.weights = { syntax: Math.round(s * 1000) / 1000, fluency: Math.round((1 - s) * 1000) / 1000 };
        }
      }
      ["bigrams", "negBigrams", "prefWords"].forEach(function (k) {
        if (d[k] && typeof d[k] === "object") t[k] = d[k];
      });
      if (typeof d.updatedAt === "number") t.updatedAt = d.updatedAt;
      saveTrain(t);
      return { ok: true };
    } catch (e) { return { ok: false, reason: "bad-json" }; }
  }

  /* ==================== 定时触发（后台调度幂等检查） ====================
     页面活着时每 60 秒 tick 一次；监听 keepalive 心跳（mine:timeskip）与
     页面可见性变化，保证后台/切页回来也能补跑过期检查。 */
  if (typeof window !== "undefined") {
    try {
      setInterval(function () {
        try { tick(); } catch (e) {}
      }, 60000);
      var doc = window.document;
      if (doc && doc.addEventListener) {
        doc.addEventListener("visibilitychange", function () {
          if (!doc.hidden) { try { tick(); } catch (e) {} }
        });
      }
      window.addEventListener("mine:timeskip", function () {
        try { tick(); } catch (e) {}
      });
    } catch (e) {}
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
    /* 实时聊天组卡（系统审批，不入池） */
    realtimeCard: realtimeCard,
    /* 字卡池删除（记录 + 池同步移除） */
    removePoolItem: removePoolItem,
    /* 后台组卡调度 + 上限调整申请 */
    tick: tick,
    getLimitRequests: function () {
      return getReqs().filter(function (r) { return r.status === "pending"; });
    },
    respondLimitRequest: respondLimitRequest,
    /* 本地训练：查询 / 立即训练 / 重置 / 导出 / 导入 */
    getTrainStats: getTrainStats,
    trainNow: trainNow,
    resetTrain: resetTrain,
    exportTrain: exportTrain,
    importTrain: importTrain,
    /* 词库管理页：自定义词增删查 */
    addCustomWord: addCustomWord,
    removeCustomWord: removeCustomWord,
    getCustomWords: getCustomWords,
    templates: TEMPLATES.length,
    version: "1.3.0"
  };
})();
