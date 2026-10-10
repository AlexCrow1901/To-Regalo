/* ========================================================================
   Mine · 字卡管理界面（lexicon-admin.js）
   ------------------------------------------------------------------------
   依赖（需先加载）：
     lexicon.js / lexicon-engine.js / lexicon-card-generator.js
     chat.js（实时发送）/ contacts.js（联系人选择）/ cards.js（字卡池）
   四个视图（设置页 → 字卡 入口进入）：
     1) approve  字卡审批：联系人 + 生成一批 → 待审批列表（拼音原文/还原结果/
                    评分）→ 通过（入公用字卡池）/ 拒绝
     2) pool     字卡池：已通过字卡列表（auto 自动 / 人工批准）+ 从池移除
     3) train    本地训练：你的通过/拒绝自动成为训练样本，攒满批量稳定更新
                    （只作用于模板路）——样本量 / 维度权重 / 立即训练 / 重置 / 导出导入
     4) rules    运行规则：两路占比 / 置信度阈值 / 批量 / 限流 / 自动入池 /
                    实时发送 / AI 终审接口（默认关闭）（全部可配置）
     5) lexicon  词库管理：字词 A-Z 排序展示 + 搜索 + 开关 + 添加 / 删除
                    自定义词 + 原词删除（=禁用）
   挂载：MineApp.page 钩子（card-approve / card-pool / card-train / card-rules / card-lexicon）
   ======================================================================== */
window.MineLexiconAdmin = (function () {
  "use strict";

  var G = window.MineCardGenerator;
  var L = window.MineLexicon;
  var C = window.MineContacts;
  var M = window.MineCards;

  function iconSvg(name, size) {
    var I = window.MineIcons;
    return I && I.svg ? I.svg(name, size || 16) : "";
  }
  function toast(msg) {
    try {
      var fn = window.MineUtils && MineUtils.showToast ? MineUtils.showToast : (window.showToast || function () {});
      fn(msg);
    } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? "0" + n : n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  var VIEW_TITLES = { approve: "字卡审批", pool: "字卡池", train: "本地训练", rules: "运行规则", lexicon: "词库管理" };
  var VIEW_ICONS = { approve: "check", pool: "bookmark", train: "chart", rules: "settings", lexicon: "book" };

  /* 词库分组展开状态 */
  var lexState = { search: "", expanded: {}, showCount: {}, loadedMore: {} };

  /* 最近一次渲染的视图（用于判断同视图重渲染 → 保持滚动，视图切换 → 回到顶部） */
  var lastRenderedView = "";
  /* ==================== 页面骨架 ==================== */
  function pageShell(view, inner) {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + iconSvg("back", 20) + '返回</button>' +
        '<span class="nav-title">' + VIEW_TITLES[view] + '</span>' +
        '<span class="nav-right"></span>' +
      '</div>';
    var tabs = ["approve", "pool", "train", "rules", "lexicon"].map(function (v) {
      return '<button class="card-tab' + (v === view ? " is-active" : "") + '" data-tab="' + v + '">' +
        iconSvg(VIEW_ICONS[v], 14) + VIEW_TITLES[v] + '</button>';
    }).join("");
    var html = navBar +
      '<div class="scroll me-scroll">' +
        '<div class="card-tabs" style="display:flex;gap:6px;padding:10px 12px;flex-wrap:wrap;">' + tabs + '</div>' +
        inner +
      '</div>';
    var detail = document.getElementById("page-detail");
    if (!detail) return;
    var keepTop = (view === lastRenderedView);
    lastRenderedView = view;
    window.MineScroll.render(detail, html, keepTop, function () { bindShell(detail, view); });
  }
  function bindShell(detail, view) {
    var back = detail.querySelector(".nav-btn[data-act=back]");
    if (back) back.addEventListener("click", function () {
      if (window.MineApp && MineApp.switchPage) MineApp.switchPage("home");
      else history.back();
    });
    Array.prototype.forEach.call(detail.querySelectorAll(".card-tab"), function (btn) {
      btn.addEventListener("click", function () {
        var v = btn.getAttribute("data-tab");
        if (v && v !== view) open(v);
      });
    });
  }

  /* ==================== 视图入口 ==================== */
  function open(view) {
    if (!G) { toast("字卡引擎未加载"); return; }
    if (view === "approve") renderApprove();
    else if (view === "pool") renderPool();
    else if (view === "train") renderTrain();
    else if (view === "rules") renderRules();
    else renderLexicon();
  }

  /* ==================== 1. 字卡审批 ==================== */
  function contactName(cid) {
    if (!cid || cid === "global") return "通用";
    var cs = (C && C.getState) ? (C.getState().contacts || []) : [];
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].id === cid) return cs[i].name || cid;
    }
    return cid;
  }
  function renderLimitReqs() {
    var detail = document.getElementById("page-detail");
    var box = detail.querySelector("#cg-limit-reqs");
    if (!box) return;
    var reqs = G.getLimitRequests();
    if (!reqs.length) { box.innerHTML = ""; return; }
    box.innerHTML = reqs.map(function (r) {
      var dir = r.direction === "up"
        ? '<span style="color:#1d8348;">增加</span>'
        : '<span style="color:#b3571f;">降低</span>';
      var remainMin = Math.max(0, Math.ceil((r.expireAt - Date.now()) / 60000));
      return '<div style="margin:0 12px 10px;border:1px solid #eee;border-radius:12px;padding:12px;background:#fff;">' +
        '<div style="font-size:14px;font-weight:600;">' + esc(contactName(r.cid)) + ' 申请' + dir +
          '每小时组字卡上限至 <b>' + r.newLimit + '</b> 条</div>' +
        '<div style="font-size:12px;color:#999;margin-top:4px;">' +
          (r.direction === "up" ? '想组更多字卡' : '想少组一些') + ' · 幅度 ±' + r.delta + ' 条 · ' +
          '剩余 <b style="color:#c0392b;">' + remainMin + '</b> 分钟（超时自动生效）</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px;">' +
          '<button class="lr-ok" data-id="' + r.id + '" style="flex:1;padding:8px;border-radius:8px;background:#2ecc71;color:#fff;border:none;font-size:13px;">' + iconSvg("check", 13) + ' 同意</button>' +
          '<button class="lr-no" data-id="' + r.id + '" style="flex:1;padding:8px;border-radius:8px;background:#eee;color:#555;border:none;font-size:13px;">拒绝</button>' +
        '</div></div>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll(".lr-ok"), function (btn) {
      btn.addEventListener("click", function () {
        var r = G.respondLimitRequest(btn.getAttribute("data-id"), true);
        toast(r.ok ? ("已同意，上限调整为 " + r.backlogMax + " 条") : "该申请已失效");
        renderApprove();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll(".lr-no"), function (btn) {
      btn.addEventListener("click", function () {
        var r = G.respondLimitRequest(btn.getAttribute("data-id"), false);
        toast(r.ok ? "已拒绝该申请" : "该申请已失效");
        renderApprove();
      });
    });
  }
  function renderApprove() {
    var contacts = (C && C.getState) ? (C.getState().contacts || []) : [];
    var opts = '<option value="global">通用（不入会话）</option>';
    contacts.forEach(function (c) {
      opts += '<option value="' + esc(c.id) + '">' + esc(c.name || c.id) + '</option>';
    });
    var counts = G.getStats();
    var pending = G.getPending();
    var reqs = G.getLimitRequests();
    var inner =
      (reqs.length ? '<div class="group-head">上限调整申请（' + reqs.length + '）</div>' + '<div id="cg-limit-reqs"></div>' : '') +
      '<div class="group-head">待人工审批（' + pending.length + '）</div>' +
      '<div class="card-hint">联系人随时主动组字卡，新卡到达时会收到通知 · 全部由你人工审批：通过后进入对应联系人字卡池，拒绝则丢弃</div>' +
      '<div id="cg-pending-list"></div>' +
      '<div class="list-sep"></div>' +
      '<div class="group-head">手动生成（测试用）</div>' +
      '<div class="card-hint">选择联系人手动触发一批组字卡，用于调试/体验；日常字卡由联系人主动组卡产生。</div>' +
      '<div style="padding:0 12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
        '<select id="cg-contact" style="flex:1;min-width:130px;padding:8px;border-radius:8px;border:1px solid #ccc;font-size:13px;">' + opts + '</select>' +
        '<select id="cg-count" style="width:76px;padding:8px;border-radius:8px;border:1px solid #ccc;font-size:13px;">' +
          [1, 3, 5, 10].map(function (n) { return '<option value="' + n + '">' + n + ' 个</option>'; }).join("") +
        '</select>' +
        '<button class="chat-bg-btn" id="cg-run" style="padding:8px 16px;border-radius:8px;background:#4a90d9;color:#fff;border:none;font-size:13px;">' + iconSvg("send", 14) + ' 生成一批</button>' +
      '</div>' +
      '<div id="cg-result" style="padding:6px 12px 0;"></div>';
    pageShell("approve", inner);
    var detail = document.getElementById("page-detail");
    /* 进入审批页先跑一次调度检查（处理过期申请 + 补跑到期的小时组卡） */
    try { G.tick(); } catch (e) {}
    renderLimitReqs();
    var run = detail.querySelector("#cg-run");
    if (run) run.addEventListener("click", function () {
      var cid = detail.querySelector("#cg-contact").value;
      var n = parseInt(detail.querySelector("#cg-count").value, 10) || 3;
      var r = G.generate(cid, n);
      var res = detail.querySelector("#cg-result");
      if (r.blocked) {
        res.innerHTML = '<div class="card-hint">已达每小时上限（' + r.limit + ' 个），请 ' + r.nextIn + ' 分钟后再试</div>';
      } else {
        res.innerHTML = '<div class="card-hint">已生成 ' + r.created + ' 个：自动通过 ' + r.auto +
          ' · 待审批 ' + r.pending + ' · 丢弃 ' + r.dropped + (r.dup ? ' · 重复跳过 ' + r.dup : '') + '</div>';
        renderPendingList();
      }
    });
    renderPendingList();
  }
  /* 待审批字卡：按联系人分组，组头可点击展开/折叠（默认折叠） */
  var pendingCollapse = {};
  function renderPendingList() {
    var detail = document.getElementById("page-detail");
    var box = detail.querySelector("#cg-pending-list");
    if (!box) return;
    var pending = G.getPending();
    if (!pending.length) {
      box.innerHTML = '<div class="card-hint">暂无待审批字卡。点击上方「生成一批」试试。</div>';
      return;
    }
    /* 按联系人分组：通用 + 各联系人 */
    var groups = {};
    pending.forEach(function (it) {
      var k = (it.contactId && it.contactId !== "global") ? it.contactId : "global";
      (groups[k] = groups[k] || []).push(it);
    });
    var html = "";
    Object.keys(groups).forEach(function (k) {
      var name = k === "global" ? "通用" : contactName(k);
      var open = pendingCollapse[k] === true;
      html += '<div class="group-head cg-group-head" data-cg-group="' + esc(k) + '" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;">' +
        '<span>' + esc(name) + ' 组了 ' + groups[k].length + ' 张，待你审批</span>' +
        '<span style="font-size:12px;color:#888;">' + (open ? '收起 ▲' : '展开 ▼') + '</span>' +
        '</div>';
      if (open) {
        html += groups[k].map(function (it) {
          var routeTag = it.route === "pinyin"
            ? '<span style="background:#fdf0e6;color:#b3571f;padding:1px 6px;border-radius:4px;font-size:11px;">拼音</span>'
            : '<span style="background:#e8f1fb;color:#2563a8;padding:1px 6px;border-radius:4px;font-size:11px;">模板</span>';
          var srcTag = it.source === "backlog"
            ? '<span style="background:#e8f6ef;color:#1d8348;padding:1px 6px;border-radius:4px;font-size:11px;">后台组卡</span>'
            : (it.source === "realtime"
              ? '<span style="background:#fdf3e7;color:#b3571f;padding:1px 6px;border-radius:4px;font-size:11px;">实时</span>'
              : '');
          var inputLine = it.input
            ? '<div style="font-size:12px;color:#888;margin-top:2px;">输入：' + esc(it.input) + ' → 还原为</div>'
            : '';
          return '<div style="margin:0 12px 10px;border:1px solid #eee;border-radius:12px;padding:12px;background:#fff;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<div style="font-size:17px;font-weight:600;">' + esc(it.text) + '</div>' +
              '<div style="display:flex;gap:6px;align-items:center;">' + routeTag + srcTag + '</div>' +
            '</div>' +
            inputLine +
            '<div style="font-size:12px;color:#999;margin-top:6px;">评分 ' + it.conf.toFixed(2) +
              '（语法 ' + it.syntax.toFixed(2) + ' / 通顺 ' + it.fluency.toFixed(2) + '） · ' + fmtTime(it.createdAt) + '</div>' +
            '<div style="display:flex;gap:8px;margin-top:8px;">' +
              '<button class="cg-approve" data-id="' + it.id + '" style="flex:1;padding:8px;border-radius:8px;background:#2ecc71;color:#fff;border:none;font-size:13px;">' + iconSvg("check", 13) + ' 通过</button>' +
              '<button class="cg-reject" data-id="' + it.id + '" style="flex:1;padding:8px;border-radius:8px;background:#eee;color:#555;border:none;font-size:13px;">拒绝</button>' +
            '</div></div>';
        }).join("");
      }
    });
    box.innerHTML = html;
    /* 组头点击：展开 / 折叠 */
    Array.prototype.forEach.call(box.querySelectorAll(".cg-group-head"), function (h) {
      h.addEventListener("click", function () {
        var k = h.getAttribute("data-cg-group");
        pendingCollapse[k] = pendingCollapse[k] !== true;
        renderPendingList();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll(".cg-approve"), function (btn) {
      btn.addEventListener("click", function () {
        var r = G.approve(btn.getAttribute("data-id"));
        toast(r.ok ? "已通过并加入公用字卡池" : (r.reason === "already-approved" ? "该字卡已通过" : "操作失败"));
        renderApprove();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll(".cg-reject"), function (btn) {
      btn.addEventListener("click", function () {
        G.reject(btn.getAttribute("data-id"));
        toast("已拒绝");
        renderApprove();
      });
    });
  }

  /* ==================== 2. 字卡池（筛选 / 搜索 / 删除） ==================== */
  var poolState = { filter: "", kw: "" };
  /* 字卡池卡片 HTML（单张） */
  function poolItemHtml(it) {
    var routeTag = it.route === "pinyin"
      ? '<span style="background:#fdf0e6;color:#b3571f;padding:1px 6px;border-radius:4px;font-size:11px;">拼音</span>'
      : '<span style="background:#e8f1fb;color:#2563a8;padding:1px 6px;border-radius:4px;font-size:11px;">模板</span>';
    var src = it.judgedBy === "manual" ? "人工批准" : "AI 自动通过";
    var owner = it.contactId && it.contactId !== "global"
      ? '<span style="background:#f3f0fa;color:#6c4ab6;padding:1px 6px;border-radius:4px;font-size:11px;">' + esc(contactName(it.contactId)) + '专用</span>'
      : '<span style="background:#eafaf1;color:#1d8348;padding:1px 6px;border-radius:4px;font-size:11px;">公用</span>';
    return '<div style="margin:0 12px 10px;border:1px solid #eee;border-radius:12px;padding:12px;background:#fff;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<div style="font-size:16px;font-weight:600;">' + esc(it.text) + '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;">' + routeTag + owner + '</div></div>' +
      '<div style="font-size:12px;color:#999;margin-top:4px;">' + src + ' · 评分 ' + it.conf.toFixed(2) + ' · ' + fmtTime(it.createdAt) + '</div>' +
      '<button class="cg-pool-rm" data-id="' + it.id + '" style="margin-top:6px;padding:5px 10px;border-radius:6px;background:#fdeaea;color:#c0392b;border:none;font-size:12px;">' + iconSvg("trash", 13) + ' 删除该字卡</button>' +
    '</div>';
  }
  function renderPoolItems(box, arr) {
    if (!arr.length) {
      box.innerHTML = '<div class="card-hint">无符合条件的字卡</div>';
      return;
    }
    box.innerHTML = arr.map(poolItemHtml).join("");
    Array.prototype.forEach.call(box.querySelectorAll(".cg-pool-rm"), function (btn) {
      btn.addEventListener("click", function () {
        var r = G.removePoolItem(btn.getAttribute("data-id"));
        toast(r.ok ? ("已删除字卡「" + r.text + "」") : "删除失败");
        renderPool();
      });
    });
  }
  function renderPool() {
    var stats = G.getStats();
    var pool = G.getPool();
    var contacts = (C && C.getState) ? (C.getState().contacts || []) : [];
    /* 联系人筛选下拉：全部 + 通用 + 各联系人 */
    var opts = '<option value="">全部联系人</option>' +
      '<option value="global"' + (poolState.filter === "global" ? " selected" : "") + '>通用</option>';
    contacts.forEach(function (c) {
      var sel = poolState.filter === c.id ? " selected" : "";
      opts += '<option value="' + esc(c.id) + '"' + sel + '>' + esc(c.name || c.id) + '</option>';
    });
    var kw = poolState.kw.trim();
    var list = pool.filter(function (it) {
      if (poolState.filter && it.contactId !== poolState.filter) return false;
      if (kw && it.text.indexOf(kw) < 0) return false;
      return true;
    });
    /* 分两栏：自动通过 / 人工批准 */
    var autoList = list.filter(function (it) { return it.judgedBy !== "manual"; });
    var manualList = list.filter(function (it) { return it.judgedBy === "manual"; });
    var inner =
      '<div class="group-head">统计</div>' +
      '<div class="card-hint">自动通过 ' + stats.auto + ' · 人工批准 ' + stats.approved +
        ' · 待审批 ' + stats.pending + ' · 拒绝 ' + stats.rejected + ' · 丢弃 ' + stats.dropped + '</div>' +
      '<div class="group-head">筛选</div>' +
      '<div style="padding:0 12px 6px;display:flex;gap:6px;flex-wrap:wrap;">' +
        '<select id="pl-filter" style="flex:1;min-width:110px;padding:8px;border-radius:8px;border:1px solid #ccc;font-size:13px;">' + opts + '</select>' +
        '<input id="pl-search" placeholder="搜索已通过字卡…" value="' + esc(poolState.kw) + '" style="flex:1.4;min-width:140px;padding:8px;border-radius:8px;border:1px solid #ccc;font-size:13px;">' +
      '</div>' +
      '<div class="group-head">自动通过（' + autoList.length + ' / ' + pool.length + '）</div>' +
      '<div id="cg-pool-auto"></div>' +
      '<div class="group-head">人工批准（' + manualList.length + '）</div>' +
      '<div id="cg-pool-manual"></div>';
    pageShell("pool", inner);
    var detail = document.getElementById("page-detail");
    var sel = detail.querySelector("#pl-filter");
    if (sel) sel.addEventListener("change", function () {
      poolState.filter = sel.value;
      renderPool();
    });
    var search = detail.querySelector("#pl-search");
    if (search) search.addEventListener("input", function () {
      poolState.kw = search.value;
      renderPool();
    });
    if (!list.length) {
      var box = detail.querySelector("#cg-pool-auto");
      if (box) box.innerHTML = '<div class="card-hint">' + (pool.length ? '没有符合条件的字卡，试试调整筛选/搜索。' : '还没有通过的字卡。去「字卡审批」生成一批，或调低自动阈值让更多候选自动通过。') + '</div>';
      return;
    }
    renderPoolItems(detail.querySelector("#cg-pool-auto"), autoList);
    renderPoolItems(detail.querySelector("#cg-pool-manual"), manualList);
  }

  /* ==================== 3. 本地训练 ==================== */
  function renderTrain() {
    var st = G.getTrainStats();
    var w = st.weights;
    var updated = st.updatedAt ? fmtTime(st.updatedAt) : "尚未训练";
    var inner =
      '<div class="group-head">训练说明</div>' +
      '<div class="card-hint">你在「字卡审批」里每点一次"通过 / 拒绝"，就是一条训练样本' +
        '（只作用于<strong>模板路</strong>）。攒满 ' + st.batchSize +
        ' 条后自动批量训练一次：系统会学习你偏好的词语搭配与维度权重，让模板路字卡越来越贴合你的口味。稳定更新，不做单条抖动。</div>' +
      '<div class="group-head">训练进度</div>' +
      '<div class="card-hint">已训练样本 ' + st.trained + ' 条 · 待训练 ' + st.pending +
        ' 条（满 ' + st.batchSize + ' 条自动更新）· 最近训练 ' + updated + '</div>' +
      '<div class="group-head">当前维度权重</div>' +
      '<div class="func-row">' +
        '<div class="func-text" style="flex:1;">' +
          '<span class="func-title">语法结构权重</span>' +
          '<span class="func-sub">词性搭配合法性的权重（当前 ' + Math.round(w.syntax * 100) + '%）</span>' +
        '</div>' +
        '<div style="width:110px;flex:none;margin-right:14px;">' +
          '<div style="height:8px;border-radius:4px;background:#eee;overflow:hidden;"><div style="height:100%;width:' + Math.round(w.syntax * 100) + '%;background:#4a90d9;"></div></div>' +
        '</div></div>' +
      '<div class="func-row">' +
        '<div class="func-text" style="flex:1;">' +
          '<span class="func-title">通顺度权重</span>' +
          '<span class="func-sub">词频常用度与句长的权重（当前 ' + Math.round(w.fluency * 100) + '%）</span>' +
        '</div>' +
        '<div style="width:110px;flex:none;margin-right:14px;">' +
          '<div style="height:8px;border-radius:4px;background:#eee;overflow:hidden;"><div style="height:100%;width:' + Math.round(w.fluency * 100) + '%;background:#6bc47f;"></div></div>' +
        '</div></div>' +
      '<div class="card-hint" style="margin:0 12px 4px;">搭配表 ' + st.bigramCount + ' 条 · 反例表 ' + st.negBigramCount +
        ' 条 · 偏好词 ' + st.prefWordCount + ' 个</div>' +
      '<div class="group-head">训练管理</div>' +
      '<div style="padding:0 12px;display:flex;flex-wrap:wrap;gap:8px;">' +
        '<button id="tr-now" class="chat-bg-btn" style="flex:1;min-width:100px;padding:10px;border-radius:8px;background:#4a90d9;color:#fff;border:none;font-size:13px;">' + iconSvg("chart", 14) + ' 立即训练</button>' +
        '<button id="tr-reset" class="chat-bg-btn" style="flex:1;min-width:100px;padding:10px;border-radius:8px;background:#eee;color:#777;border:none;font-size:13px;">重置训练</button>' +
      '</div>' +
      '<div style="padding:8px 12px 0;display:flex;flex-wrap:wrap;gap:8px;">' +
        '<button id="tr-export" class="chat-bg-btn" style="flex:1;min-width:100px;padding:10px;border-radius:8px;background:#eee;color:#555;border:none;font-size:13px;">导出训练数据</button>' +
        '<button id="tr-import" class="chat-bg-btn" style="flex:1;min-width:100px;padding:10px;border-radius:8px;background:#eee;color:#555;border:none;font-size:13px;">导入训练数据</button>' +
      '</div>' +
      '<textarea id="tr-import-box" placeholder="粘贴导出的训练 JSON 后点「导入训练数据」…" style="display:none;margin:10px 12px 0;width:calc(100% - 24px);box-sizing:border-box;height:90px;padding:8px;border-radius:8px;border:1px solid #ccc;font-size:12px;"></textarea>' +
      '<div class="card-hint" style="margin:10px 12px 0;">训练只影响模板路的评分；拼音路不受影响。训练数据仅存本地，导出后可换设备迁移。</div>';
    pageShell("train", inner);
    var detail = document.getElementById("page-detail");
    var now = detail.querySelector("#tr-now");
    if (now) now.addEventListener("click", function () {
      var r = G.trainNow();
      toast(r && r.trained ? "已训练 " + r.trained + " 条样本（正 " + r.pos + " / 负 " + r.neg + "）" : "当前没有待训练样本");
      renderTrain();
    });
    var reset = detail.querySelector("#tr-reset");
    if (reset) reset.addEventListener("click", function () {
      if (window.confirm("确定清空全部训练数据？权重将恢复默认。")) {
        G.resetTrain();
        toast("训练数据已重置");
        renderTrain();
      }
    });
    var exp = detail.querySelector("#tr-export");
    if (exp) exp.addEventListener("click", function () {
      var json = G.exportTrain();
      var ta = detail.querySelector("#tr-import-box");
      ta.style.display = "block";
      ta.value = json;
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      toast("训练数据已导出并复制到剪贴板");
    });
    var imp = detail.querySelector("#tr-import");
    if (imp) imp.addEventListener("click", function () {
      var ta = detail.querySelector("#tr-import-box");
      if (ta.style.display === "none") { ta.style.display = "block"; return; }
      var r = G.importTrain(ta.value.trim());
      toast(r.ok ? "训练数据导入成功" : "导入失败：JSON 格式不正确");
      if (r.ok) renderTrain();
    });
  }

  /* ==================== 4. 运行规则 ==================== */
  function renderRules() {
    var cfg = G.getConfig();
    var inner =
      '<div class="group-head">生成比例</div>' +
      row("rg-template", "模板路占比", "句法模板生成的字卡比例（其余为拼音路）", cfg.templateRatio * 100, "%", 0, 100, 5) +
      '<div class="group-head">置信度阈值（AI 评分审批）</div>' +
      row("rg-auto", "自动通过阈值", "评分 ≥ 此值：自动通过（实时发送 + 入池）", cfg.autoThreshold * 100, "%", 50, 100, 5) +
      row("rg-manual", "人工审批下限", "评分 ≥ 此值且 < 自动阈值：进入人工审批", cfg.manualLow * 100, "%", 30, 70, 5) +
      '<div class="card-hint" style="margin:0 12px;">分档：≥' + Math.round(cfg.autoThreshold * 100) + '% 实时发送 · ' +
        Math.round(cfg.manualLow * 100) + '%~' + Math.round(cfg.autoThreshold * 100) + '% 人工审批 · <' +
        Math.round(cfg.manualLow * 100) + '% 丢弃</div>' +
      '<div class="group-head">运行规则</div>' +
      selRow("rg-batch", "每次生成数量", "单次「生成一批」的候选数", cfg.batchSize, [1, 2, 3, 5, 10]) +
      selRow("rg-max", "每小时候选数上限", "每个联系人每小时最多生成的候选数", cfg.maxPerHour, [5, 10, 20, 50, 100]) +
      switchRow("rg-pool", "自动入字卡池", "自动通过的字卡写入公用字卡池（聊天/主动消息可用）", cfg.autoAddToPool) +
      switchRow("rg-send", "实时发送", "自动通过的字卡立即作为该联系人消息发送", cfg.realtimeSend) +
      '<div class="group-head">本地训练</div>' +
      selRow("rg-train-batch", "训练批量", "攒满多少条人工审批样本后自动批量训练一次", cfg.trainBatchSize, [10, 20, 30, 50]) +
      '<div class="group-head">后台组卡调度</div>' +
      '<div class="card-hint" style="margin:0 12px;">联系人每小时后台自动组字卡（条数在 0~上限 随机），全部进入人工审批；' +
        '每小时 ' + Math.round((cfg.backlogProb || 0.01) * 100) + '% 概率申请调整上限，超时 ' + (cfg.reqTimeout || 15) + ' 分钟自动生效。</div>' +
      row("rg-backlog-max", "每小时组卡上限", "联系人每小时后台自动组字卡条数上限（0~N 随机）", cfg.backlogMax, "条", 5, 50, 1) +
      row("rg-req-timeout", "申请超时", "上限调整申请未处理的自动生效时间", cfg.reqTimeout, "分", 5, 60, 1) +
      '<div class="group-head">AI 终审（接口位，默认关闭）</div>' +
      switchRow("rg-ai", "启用 AI 终审", "灰色区间（aiGrayLow ~ aiGrayHigh）的候选送外部 AI 判断语义通顺度", cfg.aiEnabled) +
      '<div class="card-hint" style="margin:0 12px;">接入后：评分落在灰色区间（默认 0.4~0.85）的候选会调用外部 AI 复核，' +
        'AI 判断结果覆盖本地分；未启用 / 无 Key / 调用失败时自动降级为本地评分。</div>' +
      selRow("rg-ai-provider", "AI 服务商", "OpenAI 兼容接口的服务商（deepseek / qwen / glm 等）", cfg.aiProvider || "deepseek", ["deepseek", "qwen", "glm", "openai"]) +
      rowText("rg-ai-model", "模型名", "如 deepseek-chat / qwen-plus / glm-4-flash", cfg.aiModel, "deepseek-chat") +
      rowText("rg-ai-key", "API Key", "存储在本机浏览器（请注意保管，勿外泄）", cfg.aiApiKey, "") +
      '<div class="group-head">AI 灰色区间</div>' +
      row("rg-ai-low", "灰色区间下限", "评分低于此值不送 AI（直接按本地分处理）", Math.round((cfg.aiGrayLow || 0.4) * 100), "%", 10, 60, 5) +
      row("rg-ai-high", "灰色区间上限", "评分高于此值不送 AI（自动通过）", Math.round((cfg.aiGrayHigh || 0.85) * 100), "%", 60, 95, 5) +
      '<div style="padding:14px 12px;">' +
        '<button id="rg-save" style="width:100%;padding:12px;border-radius:10px;background:#4a90d9;color:#fff;border:none;font-size:14px;">' + iconSvg("check", 14) + ' 保存运行规则</button>' +
      '</div>' +
      '<div class="card-hint">运行规则为可配置参数（此前约定"暂缓定值"），此处随时可调，即时生效。</div>';
    pageShell("rules", inner);
    var detail = document.getElementById("page-detail");
    var save = detail.querySelector("#rg-save");
    if (save) save.addEventListener("click", function () {
      var patch = {
        templateRatio: (parseFloat(detail.querySelector("#rg-template").value) || 70) / 100,
        autoThreshold: (parseFloat(detail.querySelector("#rg-auto").value) || 80) / 100,
        manualLow: (parseFloat(detail.querySelector("#rg-manual").value) || 50) / 100,
        batchSize: parseInt(detail.querySelector("#rg-batch").value, 10) || 3,
        maxPerHour: parseInt(detail.querySelector("#rg-max").value, 10) || 10,
        autoAddToPool: detail.querySelector("#rg-pool").checked,
        realtimeSend: detail.querySelector("#rg-send").checked,
        trainBatchSize: parseInt(detail.querySelector("#rg-train-batch").value, 10) || 20,
        backlogMax: parseInt(detail.querySelector("#rg-backlog-max").value, 10) || 20,
        reqTimeout: parseInt(detail.querySelector("#rg-req-timeout").value, 10) || 15,
        aiEnabled: detail.querySelector("#rg-ai").checked,
        aiProvider: detail.querySelector("#rg-ai-provider").value,
        aiModel: detail.querySelector("#rg-ai-model").value.trim(),
        aiApiKey: detail.querySelector("#rg-ai-key").value.trim(),
        aiGrayLow: (parseFloat(detail.querySelector("#rg-ai-low").value) || 40) / 100,
        aiGrayHigh: (parseFloat(detail.querySelector("#rg-ai-high").value) || 85) / 100
      };
      G.setConfig(patch);
      toast("运行规则已保存并即时生效");
    });
  }
  function row(id, title, sub, val, unit, min, max, step) {
    return '<div class="func-row">' +
      '<div class="func-text" style="flex:1;">' +
        '<span class="func-title">' + title + '</span>' +
        '<span class="func-sub">' + sub + '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;flex:none;">' +
        '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" style="width:110px;">' +
        '<span id="' + id + '-v" style="font-size:13px;color:#333;min-width:44px;text-align:right;">' + val + unit + '</span>' +
      '</div></div>';
  }
  function rowText(id, title, sub, val, ph) {
    return '<div class="func-row">' +
      '<div class="func-text" style="flex:1;">' +
        '<span class="func-title">' + title + '</span>' +
        '<span class="func-sub">' + sub + '</span>' +
      '</div>' +
      '<input type="text" id="' + id + '" value="' + esc(val) + '" placeholder="' + esc(ph || "") + '" style="flex:none;width:120px;padding:7px;border-radius:8px;border:1px solid #ccc;font-size:12px;">' +
      '</div>';
  }
  function selRow(id, title, sub, val, options) {
    var opts = options.map(function (o) {
      return '<option value="' + o + '"' + (o === val ? " selected" : "") + '>' + o + '</option>';
    }).join("");
    return '<div class="func-row">' +
      '<div class="func-text" style="flex:1;">' +
        '<span class="func-title">' + title + '</span>' +
        '<span class="func-sub">' + sub + '</span>' +
      '</div>' +
      '<select id="' + id + '" style="padding:7px;border-radius:8px;border:1px solid #ccc;font-size:13px;">' + opts + '</select>' +
      '</div>';
  }
  function switchRow(id, title, sub, checked) {
    return '<div class="func-row">' +
      '<div class="func-text" style="flex:1;">' +
        '<span class="func-title">' + title + '</span>' +
        '<span class="func-sub">' + sub + '</span>' +
      '</div>' +
      '<label class="proactive-switch"><input type="checkbox" id="' + id + '"' + (checked ? " checked" : "") + '><span class="proactive-switch-track"></span></label>' +
      '</div>';
  }

  /* ==================== 4. 词库管理 ==================== */
  function firstLetter(e) {
    var py = e.p || "";
    var first = (py.split(" ")[0] || "").charAt(0).toUpperCase();
    if (!first || first < "A" || first > "Z") return "#";
    return first;
  }
  function renderLexicon() {
    var cfg = G.getConfig();
    var disabled = {};
    (cfg.disabledWords || []).forEach(function (w) { disabled[w] = true; });
    var custom = G.getCustomWords();
    var customSet = {};
    custom.forEach(function (c) { customSet[c.w] = true; });

    /* 搜索过滤（词 / 拼音包含） */
    var kw = lexState.search.trim().toLowerCase();
    var words = L.words;
    if (kw) {
      words = words.filter(function (e) {
        return e.w.indexOf(kw) >= 0 || (e.p || "").toLowerCase().indexOf(kw) >= 0;
      });
    }

    /* A-Z 分组 */
    var groups = {};
    words.forEach(function (e) {
      var k = firstLetter(e);
      (groups[k] = groups[k] || []).push(e);
    });
    var letters = Object.keys(groups).sort();

    var inner =
      '<div class="group-head">搜索</div>' +
      '<div style="padding:0 12px 6px;">' +
        '<div style="display:flex;gap:6px;">' +
          '<input id="lx-search" placeholder="搜索字词或拼音…" value="' + esc(lexState.search) + '" style="flex:1;padding:9px;border-radius:8px;border:1px solid #ccc;font-size:13px;">' +
          '<button id="lx-search-clear" class="chat-bg-btn icon-only" aria-label="清空" style="flex:none;">' + iconSvg("close", 16) + '</button>' +
        '</div>' +
        '<div class="card-hint">共 ' + words.length + ' 个匹配字词 · 每词可开关（关闭则不参与字卡生成）/ 删除 · 展示按 A-Z 排序，不影响内部逻辑。</div>' +
      '</div>' +
      '<div class="group-head">添加字词</div>' +
      '<div style="padding:0 12px 6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
        '<input id="lx-add-w" placeholder="字词（2-6 字）" style="flex:1;min-width:90px;padding:8px;border-radius:8px;border:1px solid #ccc;font-size:13px;">' +
        '<input id="lx-add-p" placeholder="拼音（空格分隔，如 wo xiang ni）" style="flex:1.4;min-width:150px;padding:8px;border-radius:8px;border:1px solid #ccc;font-size:13px;">' +
        '<select id="lx-add-pos" style="padding:8px;border-radius:8px;border:1px solid #ccc;font-size:13px;">' +
          '<option value="n">名词</option><option value="v">动词</option><option value="a">形容词</option>' +
          '<option value="d">副词</option><option value="r">代词</option><option value="e">叹词</option>' +
        '</select>' +
        '<button id="lx-add-btn" class="chat-bg-btn" style="padding:8px 14px;border-radius:8px;background:#4a90d9;color:#fff;border:none;font-size:13px;">' + iconSvg("plus", 14) + ' 添加</button>' +
      '</div>' +
      '<div class="group-head">字词列表（A-Z）</div>' +
      '<div id="lx-groups"></div>';
    pageShell("lexicon", inner);
    var detail = document.getElementById("page-detail");

    /* 搜索事件 */
    var search = detail.querySelector("#lx-search");
    if (search) search.addEventListener("input", function () {
      lexState.search = search.value;
      renderLexicon();
    });
    var clear = detail.querySelector("#lx-search-clear");
    if (clear) clear.addEventListener("click", function () {
      lexState.search = "";
      renderLexicon();
    });
    /* 添加事件 */
    var addBtn = detail.querySelector("#lx-add-btn");
    if (addBtn) addBtn.addEventListener("click", function () {
      var w = detail.querySelector("#lx-add-w").value.trim();
      var p = detail.querySelector("#lx-add-p").value.trim();
      var pos = detail.querySelector("#lx-add-pos").value;
      var r = G.addCustomWord(w, p, pos);
      if (r.ok) {
        toast(r.mode === "re-enable" ? "已重新启用该词" : "已添加字词");
        detail.querySelector("#lx-add-w").value = "";
        detail.querySelector("#lx-add-p").value = "";
        renderLexicon();
      } else {
        toast({ "bad-word": "请输入 1-6 字词", "not-chinese": "仅支持中文字词", "no-pinyin": "请输入拼音" }[r.reason] || "添加失败");
      }
    });

    /* 分组渲染 */
    var gbox = detail.querySelector("#lx-groups");
    if (!letters.length) {
      gbox.innerHTML = '<div class="card-hint">没有匹配的字词。</div>';
      return;
    }
    gbox.innerHTML = letters.map(function (k) {
      var arr = groups[k].slice().sort(function (a, b) {   /* 组内按拼音 A-Z 排序（仅呈现） */
        var pa = a.p || "", pb = b.p || "";
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
      var exp = lexState.expanded[k] || false;
      var count = lexState.showCount[k] || 100;
      var shown = arr.slice(0, count);
      var rows = shown.map(function (e) {
        var off = !!disabled[e.w];
        var isC = !!customSet[e.w];
        return '<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid #f3f3f3;' + (off ? "opacity:.5;" : "") + '">' +
          '<span style="flex:none;width:30px;height:30px;border-radius:50%;background:' + (off ? "#eee" : "#e8f1fb") + ';color:' + (off ? "#999" : "#2563a8") + ';display:flex;align-items:center;justify-content:center;font-size:15px;">' + esc(e.w[0]) + '</span>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:14px;font-weight:600;">' + esc(e.w) + (isC ? ' <span style="font-size:10px;color:#b3571f;border:1px solid #b3571f;border-radius:3px;padding:0 3px;">自添</span>' : '') + '</div>' +
            '<div style="font-size:11px;color:#999;">' + esc(e.p) + ' · ' + esc(e.pos) + (off ? ' · <span style="color:#a93226;">已关闭</span>' : '') + '</div>' +
          '</div>' +
          '<button class="lx-off" data-w="' + esc(e.w) + '" style="flex:none;padding:4px 9px;border-radius:6px;border:none;font-size:12px;' + (off ? "background:#2ecc71;color:#fff;" : "background:#eee;color:#777;") + '">' + (off ? "开启" : "关闭") + '</button>' +
          '<button class="lx-del" data-w="' + esc(e.w) + '" data-custom="' + isC + '" style="flex:none;padding:4px 9px;border-radius:6px;border:none;background:#fdedec;color:#a93226;font-size:12px;">' + iconSvg("trash", 12) + '</button>' +
        '</div>';
      }).join("");
      var more = arr.length > shown.length
        ? '<button class="lx-more" data-letter="' + k + '" style="width:100%;padding:8px;border:none;background:none;color:#4a90d9;font-size:12px;">显示更多（还有 ' + (arr.length - shown.length) + ' 个）</button>'
        : "";
      return '<div class="lx-group" data-letter="' + k + '">' +
        '<div class="lx-group-head" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#fafafa;cursor:pointer;border-bottom:1px solid #eee;">' +
          '<span style="font-weight:700;color:#333;">' + (k === "#" ? "#" : k) + ' 组</span>' +
          '<span style="font-size:12px;color:#999;">' + arr.length + ' 个 · ' + (exp ? "收起" : "展开") + '</span>' +
        '</div>' +
        (exp ? '<div>' + rows + more + '</div>' : '') +
      '</div>';
    }).join("");

    /* 分组事件 */
    Array.prototype.forEach.call(gbox.querySelectorAll(".lx-group-head"), function (head) {
      head.addEventListener("click", function () {
        var k = head.parentElement.getAttribute("data-letter");
        lexState.expanded[k] = !lexState.expanded[k];
        renderLexicon();
      });
    });
    Array.prototype.forEach.call(gbox.querySelectorAll(".lx-more"), function (btn) {
      btn.addEventListener("click", function () {
        var k = btn.getAttribute("data-letter");
        lexState.showCount[k] = (lexState.showCount[k] || 100) + 100;
        lexState.expanded[k] = true;
        renderLexicon();
      });
    });
    Array.prototype.forEach.call(gbox.querySelectorAll(".lx-off"), function (btn) {
      btn.addEventListener("click", function () {
        var w = btn.getAttribute("data-w");
        var cfg2 = G.getConfig();
        var dis = cfg2.disabledWords.slice();
        var i = dis.indexOf(w);
        if (i >= 0) dis.splice(i, 1); else dis.push(w);
        G.setConfig({ disabledWords: dis });
        toast(i >= 0 ? "已开启该词" : "已关闭该词（不参与字卡生成）");
        renderLexicon();
      });
    });
    Array.prototype.forEach.call(gbox.querySelectorAll(".lx-del"), function (btn) {
      btn.addEventListener("click", function () {
        var w = btn.getAttribute("data-w");
        var isC = btn.getAttribute("data-custom") === "true";
        if (isC) {
          G.removeCustomWord(w);
          toast("已删除自定义词");
        } else {
          var cfg2 = G.getConfig();
          var dis = cfg2.disabledWords.slice();
          if (dis.indexOf(w) < 0) dis.push(w);
          G.setConfig({ disabledWords: dis });
          toast("已删除（该词不再参与字卡生成，可在词库中重新开启）");
        }
        renderLexicon();
      });
    });
  }

  /* ==================== 挂载 APP.page 钩子 ==================== */
  window.MineApp = window.MineApp || {};
  var prevPage = window.MineApp.page;
  window.MineApp.page = function (id) {
    if (id === "card-approve") { open("approve"); return true; }
    if (id === "card-pool") { open("pool"); return true; }
    if (id === "card-train") { open("train"); return true; }
    if (id === "card-rules") { open("rules"); return true; }
    if (id === "card-lexicon") { open("lexicon"); return true; }
    return prevPage ? prevPage(id) : false;
  };

  return {
    open: open,
    renderApprove: renderApprove,
    renderPool: renderPool,
    renderRules: renderRules,
    renderLexicon: renderLexicon
  };
})();
