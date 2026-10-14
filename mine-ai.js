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

  var CFG_KEY = "mine.cards.gen.config.v1";
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
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) { return {}; }
  }
  function setConfig(patch) {
    var cfg = getConfig();
    if (patch && typeof patch === "object") {
      Object.keys(patch).forEach(function (k) { cfg[k] = patch[k]; });
      try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
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

  /* ---------------- 启用判断 ---------------- */
  function isEnabled() {
    var c = getConfig();
    return !!(c.aiEnabled && c.aiApiKey && (c.aiModel || PROVIDERS[c.aiProvider]));
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

    var ep = resolveEndpoint();
    if (!ep.url || !ep.key || !ep.model) return Promise.resolve({ ok: false, error: "incomplete-config" });

    var persona = getPersona(opts.contactId);
    var sys = "你正在以一个角色的身份和朋友聊天。请根据下面的角色设定，把「输入内容」改写为一条自然的中文聊天消息。" +
      "要求：1) 意思保持不变；2) 像真人随手打字，口语化，不要书面腔；3) 充分体现角色的性格和说话习惯；4) 只输出改写后的消息本身，不要引号、解释、前缀。";
    if (persona) {
      sys += "\n\n【角色设定】\n" + persona + "\n\n请严格按照这个角色的身份、性格、说话习惯来改写消息。";
    }
    var user = "";
    if (opts.route === "pinyin" && opts.input) {
      user = "这是一串拼音：「" + opts.input + "」。请先还原它想表达的意思，再改写成自然的聊天消息。";
    } else {
      user = "输入内容：" + raw;
    }

    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) try { ctrl.abort(); } catch (e) {} }, 20000);

    return fetch(ep.url + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ep.key },
      body: JSON.stringify({
        model: ep.model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ],
        temperature: 0.8,
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
      /* 剥掉模型可能加的引号/书名号包裹 */
      text = text.replace(/^["'「『《\s]+|["'」』》\s]+$/g, "");
      return { ok: true, text: text, raw: raw, via: "ai" };
    }).catch(function (e) {
      clearTimeout(timer);
      return { ok: false, error: (e && e.message) || "request-failed" };
    });
  }

  return {
    isEnabled: isEnabled,
    getConfig: getConfig,
    setConfig: setConfig,
    listProviders: listProviders,
    getPersona: getPersona,
    setPersona: setPersona,
    polish: polish
  };
})();
