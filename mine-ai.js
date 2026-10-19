/* ========================================================================
   Mine · AI 润色客户端（mine-ai.js）
   ------------------------------------------------------------------------
   依赖：storage.js（必须先加载，localStorage 增强层）
   功能：
   · OpenAI 兼容格式通用客户端（DeepSeek 默认，可切换 OpenAI/通义/Kimi/自定义）
   · 联系人人设（每联系人一段，几万字，全量带入 prompt）
   · 核心：polish(raw, input, route, contactId) → Promise
       把组出的碎片句 / 拼音串改写为自然口语句（按联系人性格）
       AI 失败一律 resolve({ok:false})，由调用方降级本地原句，绝不阻塞聊天
   存储：
     mine.cards.gen.config.v1 中扩展字段（与组卡引擎共用配置）
       aiEnabled / aiProvider / aiBaseUrl / aiModel / aiApiKey
     mine.contacts.persona.v1  联系人人设 { cid: "人设文本..." }
   ======================================================================== */
window.MineAI = (function () {
  "use strict";

  var CFG_KEY = "mine.ai.config.v1";
  var CFG_BACKUP_KEY = "mine.ai.config.backup.v1";
  var PERSONA_KEY = "mine.contacts.persona.v1";

  /* ---------------- 服务商预设（OpenAI 兼容格式） ---------------- */
  var PROVIDERS = {
    deepseek: { label: "DeepSeek",  url: "https://api.deepseek.com",                     model: "deepseek-chat" },
    openai:   { label: "OpenAI",    url: "https://api.openai.com/v1",                    model: "gpt-4o-mini" },
    qwen:     { label: "通义千问",  url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    kimi:     { label: "Kimi",      url: "https://api.moonshot.cn/v1",                   model: "moonshot-v1-8k" },
    custom:   { label: "自定义",    url: "",                                              model: "" }
  };

  function getConfig() {
    var cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) {}
    /* 如果主配置为空，自动从备份恢复 */
    if (!cfg.aiApiKey) {
      try {
        var backup = JSON.parse(localStorage.getItem(CFG_BACKUP_KEY)) || {};
        if (backup.aiApiKey) {
          cfg = backup;
          try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
        }
      } catch (e) {}
    }
    /* 如果还是空，自动从旧键迁移（兼容历史配置） */
    if (!cfg.aiApiKey) {
      try {
        var old = JSON.parse(localStorage.getItem("mine.cards.gen.config.v1")) || {};
        if (old.aiApiKey) {
          cfg = {
            aiEnabled: old.aiEnabled,
            aiProvider: old.aiProvider,
            aiBaseUrl: old.aiBaseUrl,
            aiModel: old.aiModel,
            aiApiKey: old.aiApiKey
          };
          try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
        }
      } catch (e) {}
    }
    return cfg;
  }
  function setConfig(patch) {
    var cfg = getConfig();
    if (patch && typeof patch === "object") {
      Object.keys(patch).forEach(function (k) { cfg[k] = patch[k]; });
      try {
        localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
        /* 同时存一份备份，防止主配置丢失 */
        localStorage.setItem(CFG_BACKUP_KEY, JSON.stringify(cfg));
      } catch (e) {}
    }
    return getConfig();
  }
  function listProviders() {
    var out = {};
    Object.keys(PROVIDERS).forEach(function (k) { out[k] = PROVIDERS[k].label; });
    return out;
  }

  /* ---------------- 联系人人设 ---------------- */
  function loadPersonas() {
    try { return JSON.parse(localStorage.getItem(PERSONA_KEY)) || {}; } catch (e) { return {}; }
  }
  function getPersona(contactId) {
    if (!contactId) return "";
    var m = loadPersonas();
    return String(m[contactId] || "");
  }
  function setPersona(contactId, text) {
    if (!contactId) return { ok: false, reason: "no-contact" };
    var m = loadPersonas();
    m[contactId] = String(text || "");
    try { localStorage.setItem(PERSONA_KEY, JSON.stringify(m)); } catch (e) { return { ok: false, reason: "save-failed" }; }
    return { ok: true };
  }

  /* ---------------- 学习语料（手动添加的参考句子，不发送） ---------------- */
  var CORPUS_KEY = "mine.ai.corpus.v1";
  function getStudyCorpus(contactId) {
    if (!contactId) return [];
    try {
      var raw = localStorage.getItem(CORPUS_KEY);
      if (!raw) return [];
      var m = JSON.parse(raw);
      var list = Array.isArray(m[contactId]) ? m[contactId] : [];
      return list.filter(function (s) { return typeof s === "string" && s.trim(); });
    } catch (e) { return []; }
  }
  function setStudyCorpus(contactId, lines) {
    if (!contactId) return { ok: false, reason: "no-contact" };
    try {
      var raw = localStorage.getItem(CORPUS_KEY);
      var m = raw ? JSON.parse(raw) : {};
      m[contactId] = Array.isArray(lines) ? lines.filter(function (s) { return typeof s === "string" && s.trim(); }) : [];
      localStorage.setItem(CORPUS_KEY, JSON.stringify(m));
      return { ok: true };
    } catch (e) { return { ok: false, reason: "save-failed" }; }
  }

  /* ---------------- 从字卡池提取这个联系人的所有文本字卡 ---------------- */
  function getCardSamples(contactId) {
    var samples = [];
    try {
      var raw = localStorage.getItem("mine.cards.v1");
      if (!raw) return samples;
      var d = JSON.parse(raw);
      /* 1. 单独字卡（这个联系人专属的） */
      var per = (d.per && d.per[contactId]) || [];
      /* 2. 公用字卡 */
      var pub = Array.isArray(d.public) ? d.public : [];
      /* 3. 系统字卡（审批通过的组字卡，按联系人分组） */
      var sys = Array.isArray(d.sys) ? d.sys : [];
      /* 合并，只保留短文本（3-30字，口语化特征最明显） */
      per.concat(pub).concat(sys).forEach(function (card) {
        if (typeof card !== "string") return;
        var t = card.trim();
        /* 跳过图片/音频/emoji */
        if (t.indexOf("data:image/") === 0 || t.indexOf("data:audio/") === 0) return;
        /* 只保留 2-30 字的短文本 */
        if (t.length < 2 || t.length > 30) return;
        samples.push(t);
      });
      /* 去重 */
      return samples.filter(function (v, i, a) { return a.indexOf(v) === i; });
    } catch (e) { return samples; }
  }

  /* ---------------- 启用判断 ---------------- */
  function isEnabled() {
    var c = getConfig();
    /* 只要配了API key就默认启用，不用用户手动开开关 */
    return !!(c.aiApiKey && (c.aiModel || PROVIDERS[c.aiProvider]));
  }
  function resolveEndpoint() {
    var c = getConfig();
    var p = PROVIDERS[c.aiProvider] || PROVIDERS.deepseek;
    return {
      url: (c.aiBaseUrl || p.url || "").replace(/\/+$/, ""),
      model: c.aiModel || p.model || "",
      key: c.aiApiKey || ""
    };
  }

  /* ---------------- 核心：润色 ----------------
     opts: { raw: 本地组出的碎片句, input: 拼音串(可选), route: "template"|"pinyin",
             contactId: 联系人id }
     返回 Promise<{ ok, text, raw, via }>；失败 resolve({ok:false, error}) */
  function polish(opts) {
    opts = opts || {};
    var raw = String(opts.raw || "").trim();
    if (!raw) return Promise.resolve({ ok: false, error: "empty" });
    if (!isEnabled()) return Promise.resolve({ ok: false, error: "disabled" });

    /* 单字直接跳过，不走AI（2字以上都润色） */
    if (raw.length <= 1) {
      return Promise.resolve({ ok: true, text: raw, raw: raw, via: "short-skip" });
    }

    var ep = resolveEndpoint();
    if (!ep.url || !ep.key || !ep.model) return Promise.resolve({ ok: false, error: "incomplete-config" });

    var persona = getPersona(opts.contactId);
    var sys = "下面是一段由联系人用词语卡片拼出来的、不连贯的中文碎片，这是联系人本来想表达的意思，只是组得不通顺。";
    sys += "\n你的任务：根据下面的角色设定，把这段碎片理顺、扩展成联系人会自然说出来的口语化聊天句子。";
    sys += "\n要求：1) 最大程度保留碎片本来想表达的意思；2) 像真人随手打字，自然口语，不要书面腔；3) 充分体现角色的性格和说话习惯；4) 只输出改写后的句子本身，不要引号、解释、前缀。";
    /* 说话人定位：最重要的规则 */
    sys += "\n\n【角色定位 - 必须严格遵守】";
    sys += "\n· 你现在就是联系人本人，你正在跟用户（也就是宝宝）聊天，你说的话当然可以有反问、疑问、撒娇、吐槽，这都是正常的。";
    sys += "\n· 句子里大部分时候用「我」就很自然，偶尔用名字也可以，但不要刻意、频繁地把「我」替换成联系人名字，那样很不自然。";
    sys += "\n· 句子里的「你」= 聊天对象 = 用户（宝宝）。";
    sys += "\n· 绝对不能搞反谁在说谁，绝对不能把「我」和「你」的身份互换。";
    sys += "\n· 你说的话当然可以有「我没懂」「我听不懂」这类句子，这是完全正常的——比如你没听懂对方刚才说的话，就可以直接问。";
    sys += "\n· 【绝对禁止】你绝对不能搞反角色，变成「你刚才发的是什么？我没懂欸」这种意思——也就是你不能以为是对方发了一条消息给你、你看不懂对方发的东西。你是说话的人，不是收到消息的人。";
    sys += "\n· 【绝对禁止编造】绝对不能编造或虚构对方（宝宝）说过的话、做过的事、或任何碎片里不存在的事实。你只能基于给定的碎片内容来润色——碎片里没有提到的内容，绝对不能自己编出来说成「你说过……」「你上次……」「你之前……」这类虚构引用。碎片里明确提到的事情可以说、可以顺着说，但碎片里没提到的绝对不能凭空加。";
    sys += "\n· 如果输入碎片逻辑断裂、读不通顺，就根据角色人设合理联想成你最可能想表达的意思，自然润色成句子，不要硬凑出离谱的内容，更不要编造不存在的对话。";
    /* 人称转换规则 */
    if (opts.chatType === "group") {
      sys += "\n\n【人称转换】如果这句话是对着聊天对象说的，请把第三人称「她/他」转换成第二人称「你」；如果是说第三方的，则保留原称。";
    } else {
      sys += "\n\n【人称转换】这是一对一聊天，请把第三人称「她/他」都转换成第二人称「你」。";
    }
    /* 保护词规则：人名、特定称呼绝对不能改 */
    sys += "\n\n【重要保护规则】人名、昵称、特定称呼是固定的，绝对不能改写、替换或转换成其他称呼。例如提到「夏以昼」就还是「夏以昼」，提到「小鹿」就还是「小鹿」，不能改成「我」「你」「他」或其他名字。只润色句子的语气和衔接，保留所有专有名詞不变。";
    if (persona) {
      sys += "\n\n【角色设定】\n" + persona + "\n\n请严格按照这个角色的身份、性格、说话习惯来改写消息。";
    }
    /* 加入这个联系人的所有字卡样本（学习说话风格） */
    var cardSamples = getCardSamples(opts.contactId);
    if (cardSamples.length > 0) {
      sys += "\n\n【这个联系人平时是这样说话的】";
      /* 最多取 50 条，防止 token 爆炸 */
      cardSamples.slice(0, 50).forEach(function (s) {
        sys += "\n「" + s + "」";
      });
      sys += "\n\n请模仿上面这些消息的语气、用词习惯、句长偏好来改写。";
    }
    /* 加入手动添加的学习语料 */
    var corpus = getStudyCorpus(opts.contactId);
    if (corpus.length > 0) {
      sys += "\n\n【补充参考：这个角色可能会说的话】";
      corpus.slice(0, 30).forEach(function (s) {
        sys += "\n「" + s + "」";
      });
    }
    var user = "";
    if (opts.route === "pinyin" && opts.input) {
      user = "这是一串拼音：「" + opts.input + "」。请先还原它想表达的意思，再改写成自然的聊天消息。";
    } else {
      user = "输入内容：" + raw;
    }

    /* ---------------- 本地人称转换兜底（AI可能漏改，本地再强制转一次） ---------------- */
    function localPronounFix(text, chatType) {
      if (!text) return text;
      /* 一对一聊天：所有「她/他」→「你」（联系人在和你说话，第三人称就是指你） */
      if (chatType === "single") {
        text = text.replace(/她/g, "你").replace(/他/g, "你");
        /* 修正：避免出现 "你你" 这种重复 */
        text = text.replace(/你你/g, "你");
      }
      /* 群聊：AI按语境判断，本地不做硬转 */
      return text;
    }

    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) try { ctrl.abort(); } catch (e) {} }, 20000);

    /* 带重试的请求：失败后自动重试，间隔指数增长（1s→2s→4s→8s→16s→30s→60s→120s） */
    function doRequest(attempt) {
      var retryDelays = [1000, 2000, 4000, 8000, 16000, 30000, 60000, 120000];
      setState({ status: "loading", pendingCount: aiState.pendingCount + 1 });
      return fetch(ep.url + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ep.key },
        body: JSON.stringify({
          model: ep.model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user }
          ],
          temperature: 0.7,
          max_tokens: 200
        }),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error("http-" + r.status);
        return r.json();
      }).then(function (data) {
        var text = data && data.choices && data.choices[0] && data.choices[0].message &&
          String(data.choices[0].message.content || "").trim();
        if (!text) throw new Error("empty-response");
        text = text.replace(/^["'「『《\s]+|["'」』》\s]+$/g, "");
        /* 本地人称转换兜底：AI可能漏改，本地再强制转一次 */
        text = localPronounFix(text, opts.chatType);
        setState({ status: "ok", pendingCount: aiState.pendingCount - 1, lastOkTime: Date.now(), lastError: "" });
        return { ok: true, text: text, raw: raw, via: "ai" };
      }).catch(function (e) {
        clearTimeout(timer);
        /* 最多重试 8 次 */
        if (attempt < retryDelays.length) {
          var delay = retryDelays[attempt];
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve(doRequest(attempt + 1));
            }, delay);
          });
        }
        var errMsg = (e && e.message) || "request-failed";
        setState({ status: "error", pendingCount: aiState.pendingCount - 1, lastError: errMsg });
        return { ok: false, error: errMsg };
      });
    }
    return doRequest(0);
  }

  /* ---------------- 保护词配置（人名/特定称呼，不被人称转换） ---------------- */
  var PROTECT_KEY = "mine.ai.protectWords.v1";
  function getProtectWords() {
    try { return JSON.parse(localStorage.getItem(PROTECT_KEY)) || []; } catch (e) { return []; }
  }
  function setProtectWords(list) {
    try {
      localStorage.setItem(PROTECT_KEY, JSON.stringify(Array.isArray(list) ? list : []));
    } catch (e) {}
  }

  /* 公开：本地人称转换（供chat.js在AI失败时兜底用） */
  function localPronounFix(text, chatType, contactId) {
    if (!text) return text;
    text = String(text);
    if (chatType === "single") {
      /* 1. 先把保护词临时替换成占位符，防止被误转 */
      var protectWords = getProtectWords();
      /* 自动加入联系人名字作为保护词 */
      if (contactId && window.MineContacts) {
        try {
          var contact = window.MineContacts.findContact(contactId);
          if (contact && contact.name) protectWords.push(contact.name);
        } catch (e) {}
      }
      /* 去重 + 按长度降序（长的先替换，防止短词先匹配破坏长词） */
      protectWords = protectWords.filter(function(v, i, a) { return v && a.indexOf(v) === i; });
      protectWords.sort(function(a, b) { return b.length - a.length; });

      var placeholders = [];
      protectWords.forEach(function(word, i) {
        if (text.indexOf(word) >= 0) {
          var ph = "\u0000P" + i + "\u0000";
          placeholders.push({ ph: ph, word: word });
          text = text.split(word).join(ph);
        }
      });

      /* 2. 做人称转换 */
      text = text.replace(/她/g, "你").replace(/他/g, "你");
      text = text.replace(/你你/g, "你");

      /* 3. 把保护词换回来 */
      placeholders.forEach(function(item) {
        text = text.split(item.ph).join(item.word);
      });
    }
    return text;
  }

  /* ---------------- 全局状态管理（供UI实时显示） ---------------- */
  var aiState = {
    status: "idle",        // idle | loading | ok | error
    lastOkTime: 0,         // 最近一次成功时间戳
    lastError: "",         // 最近一次错误信息
    pendingCount: 0,       // 当前正在进行的请求数
    listeners: []          // 状态变化监听者
  };

  function getAIState() { return Object.assign({}, aiState); }
  function onStateChange(fn) {
    if (typeof fn === "function") aiState.listeners.push(fn);
  }
  function emitState() {
    var s = getAIState();
    aiState.listeners.forEach(function(fn) { try { fn(s); } catch(e) {} });
  }
  function setState(patch) {
    Object.assign(aiState, patch);
    emitState();
  }
  /* 发一个最小请求测试API是否连通，返回 { ok, status, latency, error } */
  function testConnection() {
    var ep = resolveEndpoint();
    if (!ep.url || !ep.key || !ep.model) {
      var msg0 = "未配置完整（缺少地址/Key/模型）";
      setLastStatus({ checked: true, ok: false, latency: 0, error: msg0, time: Date.now() });
      return Promise.resolve({ ok: false, error: msg0 });
    }
    var t0 = Date.now();
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) try { ctrl.abort(); } catch (e) {} }, 10000);
    return fetch(ep.url + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ep.key },
      body: JSON.stringify({
        model: ep.model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5
      }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      var latency = Date.now() - t0;
      if (r.ok) {
        setLastStatus({ checked: true, ok: true, latency: latency, error: "", time: Date.now() });
        return { ok: true, status: r.status, latency: latency };
      }
      return r.text().then(function (body) {
        var msg = "HTTP " + r.status;
        if (r.status === 401) msg = "Key无效或已过期（401）";
        else if (r.status === 404) msg = "接口地址错误（404）";
        else if (r.status === 429) msg = "请求过多被限流（429）";
        setLastStatus({ checked: true, ok: false, latency: latency, error: msg, time: Date.now() });
        return { ok: false, status: r.status, latency: latency, error: msg, detail: body.slice(0, 200) };
      });
    }).catch(function (e) {
      clearTimeout(timer);
      var latency = Date.now() - t0;
      var msg = "网络请求失败";
      if (e && e.name === "AbortError") msg = "请求超时（10秒）";
      else if (e && e.message) msg = e.message;
      setLastStatus({ checked: true, ok: false, latency: latency, error: msg, time: Date.now() });
      return { ok: false, latency: latency, error: msg };
    });
  }

  /* ---------------- 状态缓存（供UI实时显示） ---------------- */
  var lastStatus = { checked: false, ok: false, latency: 0, error: "", time: 0 };
  function getLastStatus() { return lastStatus; }
  function setLastStatus(s) { lastStatus = s; }

  return {
    isEnabled: isEnabled,
    getConfig: getConfig,
    setConfig: setConfig,
    listProviders: listProviders,
    getPersona: getPersona,
    setPersona: setPersona,
    polish: polish,
    fixPronoun: localPronounFix,
    getProtectWords: getProtectWords,
    setProtectWords: setProtectWords,
    testConnection: testConnection,
    getLastStatus: getLastStatus,
    setLastStatus: setLastStatus,
    getAIState: getAIState,
    onStateChange: onStateChange
  };
})();
