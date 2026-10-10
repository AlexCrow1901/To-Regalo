/* Mine 本地字卡引擎（自动生成词库的配套引擎）
   ================================================================
   两个能力：
   1) 拼音还原 restorePinyin(input)
      "联系人随机拼出的拼音串" → 最优汉字序列（音节切分 + 动态规划 +
      词频 + 词性搭配消歧），输出还原文本、词序列、置信度(0~1)、同音候选。
      wo ai ni / woaini → 我爱你
   2) 通顺度评分 scoreSentence(text)
      "语法 + 通顺度" 双维度打分（0~1），供 AI 审批与拼音路分档使用：
      ≥0.8 实时发送 / 0.5~0.8 人工审批 / <0.5 丢弃（阈值由上层配置）。
   依赖：window.MineLexicon（lexicon.js，需先加载）。 */
window.MineLexiconEngine = (function () {
  "use strict";
  var L = window.MineLexicon;
  if (!L || !L.words || !L.words.length) return null;

  var MAX_WORD_LEN = 6;            /* 词条最长汉字数（lexicon 限定 1~6） */
  var words = L.words;
  var byWord = {};                 /* 词 → 词条 */
  var pyIndex = {};                /* 拼音串(无空格归一化) → [词条]（按词频降序） */
  var syllableSet = {};
  var maxFreq = 0;
  var logCache = {};

  function normPinyin(s) {
    return String(s || "").toLowerCase().replace(/\s+/g, "").replace(/ü/g, "v").replace(/[0-9]/g, "");
  }
  function logF(f) {
    if (!logCache[f]) logCache[f] = Math.log(f + 1);
    return logCache[f];
  }
  function normWordPinyin(s) {
    return String(s || "").toLowerCase().replace(/ü/g, "v");
  }

  words.forEach(function (e) {
    byWord[e.w] = e;
    if (e.f > maxFreq) maxFreq = e.f;
    /* 音节序列键（"wo|men"），避免连写歧义（"ti|an" ≠ "tian"） */
    var syls = (e.p || "").split(" ").map(normPinyin).filter(Boolean);
    if (syls.length) {
      var key = syls.join("|");
      (pyIndex[key] = pyIndex[key] || []).push(e);
      for (var i = 0; i < syls.length; i++) syllableSet[syls[i]] = true;
    }
  });
  Object.keys(pyIndex).forEach(function (k) {
    pyIndex[k].sort(function (a, b) { return b.f - a.f; });
  });
  var syllableList = Object.keys(syllableSet).sort(function (a, b) { return b.length - a.length; });
  var base = logF(maxFreq);

  /* 前后词性搭配奖励（同音消歧：r→v 优于 r→n/p，如"我想你"选"想"而非"相/向"） */
  var POS_BONUS = {
    n: { v: 0.22, a: 0.15, r: 0.05, p: 0.05, t: 0.05, d: 0.15 },
    r: { v: 0.25, a: 0.12, n: -0.1, p: -0.1 },
    t: { v: 0.15, a: 0.12, n: 0.05, u: 0.05 },
    v: { r: 0.18, n: 0.15, a: 0.08, q: 0.08, m: 0.05, u: 0.05 },
    a: { n: 0.2, u: 0.08, d: 0.05, v: 0.05 },
    d: { v: 0.2, a: 0.2 },
    m: { q: 0.2, n: 0.1 },
    q: { n: 0.15 },
    p: { n: 0.15, r: 0.12 },
    u: { n: 0.05, a: 0.05 },
    l: { v: 0.1, u: 0.05 },
    e: { r: 0.05, n: 0.05, v: 0.05 }
  };
  /* 句首词性奖励（时间词/代词/名词天然更适合开句，如"今"优先于"进"） */
  var START_BONUS = { t: 0.15, r: 0.08, n: 0.05, l: 0.05 };

  /* ==================== 拼音还原 ==================== */
  /* 音节切分：贪心最长优先（xiang 切 xiang 而非 xi+ang），无法识别的字符记为 null */
  function splitSyllables(s) {
    var n = s.length, syls = [], i = 0;
    while (i < n) {
      var found = null;
      for (var j = 0; j < syllableList.length; j++) {
        var sy = syllableList[j];
        if (s.indexOf(sy, i) === i) { found = sy; break; }
      }
      if (found) { syls.push(found); i += found.length; }
      else { syls.push(null); i++; }
    }
    return syls;
  }

  function restorePinyin(input) {
    var s = normPinyin(input);
    if (!s) return { text: "", pinyin: String(input || ""), words: [], confidence: 0, covered: 0, candidates: [] };
    var syls = splitSyllables(s);
    var m = syls.length;
    /* dpc[i]：覆盖前 i 个音节的最优路径 { score, from, w, pos, cands } */
    var dpc = new Array(m + 1);
    dpc[0] = { score: 0, from: -1, w: null, pos: null, cands: null };
    for (var i = 0; i < m; i++) {
      if (!dpc[i]) continue;
      if (!syls[i]) continue;                       /* gap 音节：跳过，贡献未覆盖 */
      var pys = [];
      for (var len = 1; len <= Math.min(MAX_WORD_LEN, m - i); len++) {
        if (!syls[i + len - 1]) break;
        pys.push(syls[i + len - 1]);
        var cands = pyIndex[pys.join("|")];
        if (!cands || !cands.length) continue;
        /* 对每个同音候选计算上下文得分，选最优（输入法式消歧：
           单字减权 ×0.6、多字词 +0.8，整词优先于高频单字堆叠） */
        var prevPos = dpc[i].pos;
        var best = null, bestSc = -Infinity;
        for (var ci = 0; ci < cands.length; ci++) {
          var ce = cands[ci];
          var sc = logF(ce.f) / base;
          if (ce.w.length >= 2) sc += 0.8;          /* 多字词加成 */
          else sc *= 0.6;                            /* 单字减权 */
          if (!prevPos) {
            if (START_BONUS[ce.pos]) sc += START_BONUS[ce.pos];
          } else if (POS_BONUS[prevPos] && POS_BONUS[prevPos][ce.pos]) {
            sc += POS_BONUS[prevPos][ce.pos];
          }
          if (sc > bestSc) { bestSc = sc; best = ce; }
        }
        var e = best;
        var ns = dpc[i].score + bestSc;
        if (!dpc[i + len] || ns > dpc[i + len].score) {
          dpc[i + len] = { score: ns, from: i, w: e, pos: e.pos, cands: cands };
        }
      }
    }
    var end = m;
    while (end > 0 && !dpc[end]) end--;             /* 最优可达终点 */
    if (end === 0) {
      return { text: "", pinyin: s, words: [], confidence: 0, covered: 0, candidates: [] };
    }
    var seq = [], p = end;
    while (p > 0) { seq.unshift(dpc[p].w); p = dpc[p].from; }
    var covered = end / m;
    var text = seq.map(function (e) { return e.w; }).join("");
    /* 置信度 = 覆盖度 × 词频常用度 × 组合合理性（高频单字不罚，低频单字堆叠重罚） */
    var sum = 0, multi = 0;
    seq.forEach(function (e) { sum += logF(e.f) / base; if (e.w.length >= 2) multi++; });
    var freqScore = seq.length ? sum / seq.length : 0;
    var multiRatio = seq.length ? multi / seq.length : 0;
    /* 整词匹配更可信（jieba 语料低估口语词，如"你好""再见"）：多字词加成 */
    freqScore = Math.min(1, freqScore + 0.15 * multiRatio);
    var singleRatio = seq.length ? 1 - multi / seq.length : 1;
    var confidence = covered * (0.35 + 0.65 * freqScore) * (1 - 0.4 * singleRatio * (1 - freqScore));
    if (confidence > 1) confidence = 1;
    /* 同音候选（最优路径上同音词的次选/三选 + 整串直接匹配的整词） */
    var candidates = [text];
    seq.forEach(function (e, idx) {
      var cs = pyIndex[e.p.split(" ").map(normPinyin).join("|")];
      if (!cs) return;
      for (var k = 1; k < cs.length && candidates.length < 3; k++) {
        var alt = cs[k];
        if (alt.w === e.w) continue;
        var t2 = seq.map(function (x, j) { return j === idx ? alt.w : x.w; }).join("");
        if (candidates.indexOf(t2) < 0) candidates.push(t2);
      }
    });
    /* 整串匹配的整词（如 zaijian → 再见/在建）补充进候选 */
    var wholeKey = syls.join("|");
    var wholeCands = pyIndex[wholeKey];
    if (wholeCands) {
      for (var wc = 0; wc < wholeCands.length && candidates.length < 3; wc++) {
        var we = wholeCands[wc];
        if (we.w !== text && candidates.indexOf(we.w) < 0) candidates.push(we.w);
      }
    }
    return {
      text: text,
      pinyin: s,
      words: seq.map(function (e) { return { w: e.w, pos: e.pos, f: e.f }; }),
      confidence: confidence,
      covered: covered,
      candidates: candidates.slice(0, 3)
    };
  }

  /* ==================== 分词（词典最大匹配） ==================== */
  var PUNCT = { "。": 1, "？": 1, "！": 1, "，": 1, "、": 1, "；": 1, "：": 1, "…": 1, "—": 1, "“": 1, "”": 1, "·": 1 };
  function segment(text) {
    var t = String(text || "").trim();
    var out = [];
    var i = 0;
    while (i < t.length) {
      var found = null;
      for (var len = MAX_WORD_LEN; len >= 1; len--) {
        if (i + len > t.length) continue;
        var e = byWord[t.substr(i, len)];
        if (e) { found = e; break; }
      }
      if (found) { out.push(found); i += found.w.length; }
      else { out.push({ w: t[i], pos: PUNCT[t[i]] ? "P" : "x", f: 0 }); i++; }
    }
    return out;
  }

  /* ==================== 通顺度评分 ==================== */
  /* 词性转移允许表（宽松版）：key 是当前词性，value 是允许的后续词性；S=句末/标点 */
  var TRANS = {
    n: ["v", "u", "c", "p", "q", "a", "e", "o", "t", "m", "r", "l", "S"],
    r: ["v", "u", "c", "p", "e", "n", "a", "d", "t", "S"],
    t: ["v", "u", "n", "c", "e", "a", "d", "S"],
    m: ["q", "n", "r", "u", "v", "e", "t", "S"],
    q: ["n", "r", "v", "e", "S"],
    v: ["n", "r", "u", "q", "m", "a", "c", "e", "o", "p", "v", "t", "S"],
    a: ["n", "u", "c", "e", "v", "d", "S"],
    d: ["v", "a", "e", "u", "S"],
    p: ["n", "r", "t", "m", "e", "S"],
    c: ["n", "r", "v", "a", "t", "m", "e", "u", "S"],
    u: ["n", "e", "a", "v", "S"],
    e: ["n", "r", "v", "a", "e", "o", "t", "S"],
    o: ["e", "S"],
    l: ["v", "u", "e", "n", "S"],
    P: ["n", "r", "v", "a", "t", "m", "e", "o", "S"],
    x: ["n", "v", "a", "e", "S"]
  };
  function scoreSentence(text) {
    var seg = segment(text);
    if (!seg.length) return { syntax: 0, fluency: 0, total: 0, detail: { words: 0, hasVerb: false, hasSubject: false } };
    var posSeq = seg.map(function (e) { return e.pos; });
    /* 骨架：有动词，或有"形容词谓语句"（主语 + 形容词结尾，如"今天天气真好"） */
    var hasVerb = posSeq.indexOf("v") >= 0;
    var hasSubject = posSeq.some(function (p) { return p === "n" || p === "r" || p === "t"; });
    var lastPos = posSeq[posSeq.length - 1];
    var hasAdjPred = hasSubject && lastPos === "a";
    var hasPred = hasVerb || hasAdjPred;
    /* 转移合法性 */
    var legal = 0, illegal = 0;
    for (var i = 0; i < posSeq.length - 1; i++) {
      var a = posSeq[i], b = posSeq[i + 1];
      if (a === "P") continue;
      var allow = TRANS[a];
      if (allow && allow.indexOf(b) >= 0) legal++;
      else illegal++;
    }
    var syntax = legal / Math.max(1, legal + illegal);
    if (!hasPred) syntax *= 0.5;
    /* 流畅度：词频常用度 + 句长 + 结尾语气 */
    var sumF = 0;
    seg.forEach(function (e) { if (e.f > 0) sumF += logF(e.f) / base; });
    var freqScore = seg.length ? sumF / seg.length : 0;
    var wc = seg.filter(function (e) { return e.pos !== "P"; }).length;
    var lenScore = wc <= 1 ? 0.4 : (wc <= 10 ? 1 : (wc <= 14 ? 0.8 : 0.6));
    var last = seg[seg.length - 1];
    var endScore = (last.pos === "u" || last.pos === "e" || last.pos === "P") ? 0.1 : 0;
    var fluency = 0.6 * freqScore + 0.3 * lenScore + 0.1 * endScore;
    var total = 0.55 * syntax + 0.45 * fluency;
    /* 语法转移严重异常时整体打折（压制"助词堆叠"等无结构串） */
    if (syntax <= 0.5) total *= 0.7;
    return {
      syntax: Math.round(syntax * 1000) / 1000,
      fluency: Math.round(fluency * 1000) / 1000,
      total: Math.round(total * 1000) / 1000,
      detail: {
        words: seg.map(function (e) { return e.w; }),
        pos: posSeq,
        hasVerb: hasVerb,
        hasSubject: hasSubject,
        legal: legal,
        illegal: illegal,
        freqScore: Math.round(freqScore * 1000) / 1000
      }
    };
  }

  /* ==================== 统计（调试/展示用） ==================== */
  function getStats() {
    var multi = 0, single = 0;
    words.forEach(function (e) { if (e.w.length >= 2) multi++; else single++; });
    return {
      count: words.length,
      multiWord: multi,
      singleChar: single,
      syllables: syllableList.length,
      homophoneGroups: Object.keys(pyIndex).length,
      maxFreq: maxFreq
    };
  }

  return {
    restorePinyin: restorePinyin,
    scoreSentence: scoreSentence,
    segment: segment,
    getStats: getStats
  };
})();
