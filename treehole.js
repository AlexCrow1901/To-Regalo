/* ========================================================================
   Mine · 深夜树洞
   ------------------------------------------------------------------------
   功能架构：
   · 制作问卷（多道选择题，数量无上限）
   · 每份问卷顶部携带独立的验证问题（可编辑、更改、保存）
   · 指定联系人列表作答
   · 验证问题答对 → 问卷有效，可被接收
   · 验证问题答错 → 1-3小时内随机重试，直到答对
   · 问卷发出后1-6小时内随机选择时间回复
   · 数据持久化：localStorage
   ======================================================================== */

window.MineTreeHole = (function () {
  "use strict";

  var I = window.MineIcons;
  var C = window.MineContacts;
  var STORE_KEY = "mine.treehole.v2";
  var VERIFY_KEY = "mine.treehole.verify.v1";
  var PENDING_KEY = "mine.treehole.pending.v2";
  var TEMPLATE_KEY = "mine.treehole.templates.v1";

  /* ==================== 验证问题默认模板 ====================
     全局默认验证问题模板，新建问卷时复制到每份问卷中
     每份问卷可独立编辑自己的验证问题
     { question: "", options: [], correctIndex: 0 }
  */
  var verifyTemplate = {
    question: "深夜的树洞，你确定要推开这扇门吗？",
    options: ["是的，我确定", "不，我走错了", "让我想想", "无所谓"],
    correctIndex: 0
  };

  function loadVerify() {
    try {
      var raw = localStorage.getItem(VERIFY_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data) verifyTemplate = data;
      }
    } catch (e) {}
  }

  function saveVerify() {
    try {
      localStorage.setItem(VERIFY_KEY, JSON.stringify(verifyTemplate));
    } catch (e) {}
  }

  /* 深拷贝验证问题模板 */
  function cloneVerify() {
    return JSON.parse(JSON.stringify(verifyTemplate));
  }

  /* ==================== 问卷模板系统 ====================
     模板结构：
     { id, name, verifyQuestion: { question, options, correctIndex },
       questions: [{ question, options: [] }, ...] }
  */
  var TemplateStore = {
    list: [],

    load: function () {
      try {
        var raw = localStorage.getItem(TEMPLATE_KEY);
        if (raw) this.list = JSON.parse(raw) || [];
      } catch (e) {}
      if (!this.list) this.list = [];
    },

    save: function () {
      try {
        localStorage.setItem(TEMPLATE_KEY, JSON.stringify(this.list));
      } catch (e) {}
    },

    add: function (template) {
      template.id = "tpl_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
      template.savedTime = Date.now();
      this.list.unshift(template);
      this.save();
      return template;
    },

    remove: function (id) {
      var idx = this.list.findIndex(function (t) { return t.id === id; });
      if (idx >= 0) {
        this.list.splice(idx, 1);
        this.save();
      }
    },

    getById: function (id) {
      return this.list.find(function (t) { return t.id === id; });
    }
  };

  /* ==================== 数据层 ====================
     问卷结构：
     { id, verifyQuestion: { question, options, correctIndex },
       questions: [{ question, options: [] }, ...],
       recipients: [{ id, name }],
       sendTime, status: "pending"|"received",
       responses: [{ contactId, contactName, verifyChoice, verifyCorrect,
                    answers: [{ qIndex, choice }], responseTime, valid }]
     }
  */
  var TreeHoleStore = {
    list: [],

    load: function () {
      try {
        var raw = localStorage.getItem(STORE_KEY);
        if (raw) this.list = JSON.parse(raw) || [];
      } catch (e) {}
      if (!this.list) this.list = [];
    },

    save: function () {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.list));
      } catch (e) {}
    },

    add: function (survey) {
      survey.id = "th_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
      survey.sendTime = Date.now();
      survey.status = "pending";
      survey.responses = [];
      this.list.unshift(survey);
      this.save();
      return survey;
    },

    remove: function (id) {
      var idx = this.list.findIndex(function (x) { return x.id === id; });
      if (idx >= 0) {
        this.list.splice(idx, 1);
        this.save();
      }
    },

    getById: function (id) {
      return this.list.find(function (x) { return x.id === id; });
    }
  };

  /* ==================== 回复调度系统 ====================
     流程：
       发出问卷 → 每位收件人独立调度
       → 1-6小时随机延迟 → 生成回复
       → 验证问题随机选择答案
       → 正确：问卷有效，存入回复
       → 错误：1-3小时内随机重试，直到正确
  */
  var pendingReplies = [];
  var checkerTimer = null;

  function loadPending() {
    try {
      var raw = localStorage.getItem(PENDING_KEY);
      if (raw) pendingReplies = JSON.parse(raw) || [];
    } catch (e) {}
    if (!pendingReplies) pendingReplies = [];
  }

  function savePending() {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pendingReplies));
    } catch (e) {}
  }

  /* 调度问卷回复：每位收件人独立调度 */
  function scheduleReply(survey) {
    if (!survey.recipients || survey.recipients.length === 0) return;

    survey.recipients.forEach(function (recipient) {
      // 1-6 小时随机回复延迟
      var replyDelayHours = 1 + Math.random() * 5;
      var replyDelay = replyDelayHours * 60 * 60 * 1000;
      var replyTime = Date.now() + replyDelay;

      pendingReplies.push({
        surveyId: survey.id,
        recipient: { id: recipient.id, name: recipient.name },
        verifyQuestion: survey.verifyQuestion,
        questions: survey.questions,
        replyTime: replyTime,
        attempts: 0,
        resolved: false
      });
    });

    savePending();
    checkPending();
  }

  /* 检查并处理到期的回复 */
  function checkPending() {
    var now = Date.now();
    var changed = false;

    pendingReplies.forEach(function (p) {
      if (!p.resolved && now >= p.replyTime) {
        p.attempts++;

        // 模拟对方回答验证问题（随机选择）
        var vq = p.verifyQuestion;
        var verifyChoice = Math.floor(Math.random() * vq.options.length);
        var verifyCorrect = (verifyChoice === vq.correctIndex);

        if (verifyCorrect) {
          // 验证通过：回答所有问卷问题（每题随机选择）
          var answers = [];
          (p.questions || []).forEach(function (q, qi) {
            answers.push({
              qIndex: qi,
              choice: Math.floor(Math.random() * q.options.length)
            });
          });

          var survey = TreeHoleStore.getById(p.surveyId);
          if (survey) {
            survey.responses.push({
              contactId: p.recipient.id,
              contactName: p.recipient.name,
              verifyChoice: verifyChoice,
              verifyCorrect: true,
              answers: answers,
              responseTime: now,
              valid: true
            });
            if (survey.responses.length >= survey.recipients.length) {
              survey.status = "received";
            }
            TreeHoleStore.save();
          }
          p.resolved = true;
        } else {
          // 验证未通过：1-3小时内随机重试
          var retryDelay = (1 + Math.random() * 2) * 60 * 60 * 1000;
          p.replyTime = now + retryDelay;
        }
        changed = true;
      }
    });

    // 移除已完成的
    var before = pendingReplies.length;
    pendingReplies = pendingReplies.filter(function (p) { return !p.resolved; });
    if (pendingReplies.length !== before) changed = true;

    if (changed) {
      savePending();
      // 新问卷回复到达时刷新通知角标
      if (window.MineNotify) MineNotify.refreshBadges();
    }
  }

  /* 启动定期检查器 */
  function startChecker() {
    if (checkerTimer) clearInterval(checkerTimer);
    checkerTimer = setInterval(checkPending, 30000);
    checkPending();
  }

  /* ==================== 工具函数 ==================== */
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var h = d.getHours(), m = d.getMinutes();
    var time = (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
    if (sameDay) return time;
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + time;
  }

  function getContacts() {
    if (!C) return [];
    if (C.loadData) C.loadData();
    if (C.getState) return C.getState().contacts || [];
    return [];
  }

  function letterFor(index) {
    return String.fromCharCode(65 + index);
  }

  /* 罗马数字用于题号 */
  function questionLabel(index) {
    return "Q" + (index + 1);
  }

  /* ==================== 页面状态 ==================== */
  var pageEl = null;
  var currentView = "main";  // main | compose | verify | read | templates
  var currentSurvey = null;
  var composeData = null;
  var searchQuery = "";
  var searchTimer = null;
  var viewHistory = [];       // 导航历史栈

  /* 前进导航：将当前视图压入历史栈，切换到新视图 */
  function navigateTo(view) {
    viewHistory.push(currentView);
    currentView = view;
    searchQuery = "";
    render();
  }

  /* 返回导航：弹出历史栈顶，返回上一视图 */
  function goBack() {
    searchQuery = "";
    if (viewHistory.length > 0) {
      currentView = viewHistory.pop();
    } else {
      currentView = "main";
    }
    render();
  }

  /* 重置导航并跳转（用于操作完成后） */
  function resetTo(view) {
    viewHistory = [];
    currentView = view;
    searchQuery = "";
    render();
  }

  /* ==================== 搜索 & 分组工具 ==================== */

  /* 生成搜索栏 HTML */
  function searchBarHTML(placeholder) {
    return '<div class="th-search-bar">' +
      '<span class="th-search-icon">' + I.svg("search", 16) + '</span>' +
      '<input type="text" class="th-search-input" id="th-search" ' +
        'placeholder="' + (placeholder || "搜索昵称、问题或选项…") + '" ' +
        'value="' + escapeHtml(searchQuery) + '" autocomplete="off">' +
      (searchQuery ? '<button class="th-search-clear" data-act="clear-search">' + I.svg("close", 14) + '</button>' : '') +
    '</div>';
  }

  /* 获取问卷的收件人名称列表 */
  function surveyNames(s) {
    return (s.recipients || []).map(function (r) { return r.name || ""; }).join("、");
  }

  /* 关键字过滤问卷 */
  function filterSurveys(surveys, query) {
    if (!query || !query.trim()) return surveys;
    var q = query.trim().toLowerCase();
    return surveys.filter(function (s) {
      // 收件人昵称
      if (surveyNames(s).toLowerCase().indexOf(q) >= 0) return true;
      // 验证问题
      var vq = s.verifyQuestion || {};
      if ((vq.question || "").toLowerCase().indexOf(q) >= 0) return true;
      if ((vq.options || []).some(function (o) { return (o || "").toLowerCase().indexOf(q) >= 0; })) return true;
      // 问卷问题
      var questions = s.questions || [];
      for (var i = 0; i < questions.length; i++) {
        if ((questions[i].question || "").toLowerCase().indexOf(q) >= 0) return true;
        if ((questions[i].options || []).some(function (o) { return (o || "").toLowerCase().indexOf(q) >= 0; })) return true;
      }
      // 回复中的内容
      var responses = s.responses || [];
      for (var j = 0; j < responses.length; j++) {
        if ((responses[j].contactName || "").toLowerCase().indexOf(q) >= 0) return true;
      }
      return false;
    });
  }

  /* 按收件人昵称分组问卷 */
  function groupSurveysByName(surveys) {
    var groups = {};
    var order = [];
    surveys.forEach(function (s) {
      var names = (s.recipients || []).map(function (r) { return r.name; });
      var key;
      if (names.length === 0) key = "无收件人";
      else if (names.length === 1) key = names[0];
      else key = names.join("、");
      if (!groups[key]) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(s);
    });
    return order.map(function (name) {
      return { name: name, surveys: groups[name] };
    });
  }

  /* 渲染分组后的问卷列表 */
  function renderGroupedSurveys(surveys) {
    var groups = groupSurveysByName(surveys);
    var html = "";
    if (groups.length === 0) {
      html += '<div class="th-section-empty">未找到匹配的问卷</div>';
      return html;
    }
    groups.forEach(function (g) {
      html += '<div class="th-group-head">' +
        '<span class="th-group-name">' + escapeHtml(g.name) + '</span>' +
        '<span class="th-group-count">' + g.surveys.length + ' 份</span>' +
      '</div>';
      g.surveys.forEach(function (s) {
        html += surveyListItem(s);
      });
    });
    return html;
  }

  /* ==================== 视图层 ==================== */

  /* ---- 主页面 ---- */
  function viewMain() {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">深夜树洞</span>' +
        '<button class="nav-btn nav-right" data-act="verify-edit">' + I.svg("settings", 20) + '</button>' +
      '</div>';

    var html = '<div class="scroll th-scroll">';

    // 搜索栏
    html += searchBarHTML("搜索昵称、问题或选项…");

    // 默认验证问题模板状态（搜索时不显示）
    if (!searchQuery.trim()) {
      html += '<div class="th-verify-status" role="button" tabindex="0" data-act="verify-edit">' +
        '<div class="th-verify-icon">' + I.svg("shield", 20) + '</div>' +
        '<div class="th-verify-info">' +
          '<div class="th-verify-label">默认验证问题模板</div>' +
          '<div class="th-verify-q">' + escapeHtml(verifyTemplate.question) + '</div>' +
          '<div class="th-verify-ans">正确答案：' + escapeHtml(verifyTemplate.options[verifyTemplate.correctIndex] || "") + '</div>' +
        '</div>' +
        '<span class="chevron">' + I.svg("back", 18) + '</span>' +
      '</div>';
      html += '<div class="list-sep"></div>';
    }

    // 问卷列表
    var allSurveys = TreeHoleStore.list;
    var query = searchQuery.trim();
    if (query) {
      allSurveys = filterSurveys(allSurveys, query);
    }

    var pending = allSurveys.filter(function (s) { return s.status === "pending"; });
    var received = allSurveys.filter(function (s) { return s.status === "received"; });

    // 搜索模式：合并显示
    if (query) {
      html += '<div class="th-section-head">搜索结果 · ' + allSurveys.length + '</div>';
      if (allSurveys.length === 0) {
        html += '<div class="th-section-empty">未找到匹配的问卷</div>';
      } else {
        html += renderGroupedSurveys(allSurveys);
      }
    } else {
      // 正常模式：分待回复/已接收，按昵称分组
      html += '<div class="th-section-head">待回复 · ' + pending.length + '</div>';
      if (pending.length === 0) {
        html += '<div class="th-section-empty">暂无待回复问卷</div>';
      } else {
        html += renderGroupedSurveys(pending);
      }

      html += '<div class="list-sep"></div>';

      html += '<div class="th-section-head">已接收 · ' + received.length + '</div>';
      if (received.length === 0) {
        html += '<div class="th-section-empty">暂无已接收问卷</div>';
      } else {
        html += renderGroupedSurveys(received);
      }
    }

    html += '<div class="th-compose-fab" role="button" tabindex="0" data-act="compose">' +
      I.svg("pencil", 22) + '<span>制作问卷</span></div>';

    html += '</div>';
    return navBar + html;
  }

  function surveyListItem(s) {
    var respCount = s.responses ? s.responses.length : 0;
    var total = s.recipients ? s.recipients.length : 0;
    var statusText = s.status === "pending" ? "等待回复" : "已接收";
    var statusCls = s.status === "pending" ? " th-status-pending" : " th-status-received";
    var qCount = (s.questions || []).length;
    var recipientNames = (s.recipients || []).map(function (r) { return r.name; }).join("、");

    // 显示第一道问题作为预览
    var previewQ = "";
    if (s.questions && s.questions.length > 0) {
      previewQ = s.questions[0].question;
      if (qCount > 1) previewQ += "（共" + qCount + "题）";
    }

    var html = '<div class="th-survey-item" role="button" tabindex="0" ' +
      'data-act="read-survey" data-id="' + s.id + '">' +
      '<div class="th-survey-q">' + escapeHtml(previewQ) + '</div>' +
      '<div class="th-survey-meta">' +
        '<span class="th-survey-recipients">' + escapeHtml(recipientNames) + '</span>' +
        '<span class="th-survey-count">' + respCount + '/' + total + ' 回复</span>' +
      '</div>' +
      '<div class="th-survey-bottom">' +
        '<span class="th-survey-time">' + fmtTime(s.sendTime) + '</span>' +
        '<span class="th-survey-status' + statusCls + '">' + statusText + '</span>' +
      '</div>' +
    '</div>';
    return html;
  }

  /* ---- 问卷阅读页 ---- */
  function viewRead(survey) {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back-main">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">问卷详情</span>' +
        '<span class="nav-right"></span>' +
      '</div>';

    var html = '<div class="scroll th-scroll">';

    // 验证问题（放在问卷顶部）
    var vq = survey.verifyQuestion || { question: "", options: [], correctIndex: 0 };
    html += '<div class="th-read-verify-block">';
    html += '<div class="th-read-verify-tag">' + I.svg("shield", 14) + ' 验证问题</div>';
    html += '<div class="th-read-question">' + escapeHtml(vq.question) + '</div>';
    html += '<div class="th-read-options">';
    (vq.options || []).forEach(function (opt, i) {
      var isCorrect = i === vq.correctIndex;
      html += '<div class="th-read-option' + (isCorrect ? " th-read-option-correct" : "") + '">' +
        '<span class="th-read-letter">' + letterFor(i) + '</span>' +
        '<span class="th-read-text">' + escapeHtml(opt) + '</span>' +
        (isCorrect ? '<span class="th-read-correct-mark">' + I.svg("check", 14) + '</span>' : '') +
      '</div>';
    });
    html += '</div>';
    html += '</div>';

    html += '<div class="list-sep"></div>';

    // 问卷问题列表
    (survey.questions || []).forEach(function (q, qi) {
      html += '<div class="th-read-question-block">';
      html += '<div class="th-read-question-label">' + questionLabel(qi) + '</div>';
      html += '<div class="th-read-question">' + escapeHtml(q.question) + '</div>';
      html += '<div class="th-read-options">';
      (q.options || []).forEach(function (opt, oi) {
        html += '<div class="th-read-option">' +
          '<span class="th-read-letter">' + letterFor(oi) + '</span>' +
          '<span class="th-read-text">' + escapeHtml(opt) + '</span>' +
        '</div>';
      });
      html += '</div>';
      html += '</div>';
      if (qi < survey.questions.length - 1) {
        html += '<div class="th-read-q-sep"></div>';
      }
    });

    html += '<div class="list-sep"></div>';

    // 回复列表
    html += '<div class="th-section-head">回复详情</div>';

    if (!survey.responses || survey.responses.length === 0) {
      html += '<div class="th-section-empty">等待回复中…</div>';
    } else {
      survey.responses.forEach(function (r) {
        var verifyText = vq.options[r.verifyChoice] || "未知";
        var validBadge = r.valid
          ? '<span class="th-resp-badge th-resp-valid">有效</span>'
          : '<span class="th-resp-badge th-resp-invalid">无效</span>';

        html += '<div class="th-response-item">';
        html += '<div class="th-resp-head">' +
          '<span class="th-resp-name">' + escapeHtml(r.contactName) + '</span>' +
          validBadge +
          '<span class="th-resp-time">' + fmtTime(r.responseTime) + '</span>' +
        '</div>';

        // 验证结果
        html += '<div class="th-resp-row">' +
          '<span class="th-resp-label">验证</span>' +
          '<span class="th-resp-value">' + escapeHtml(verifyText) + '</span>' +
          (r.verifyCorrect
            ? '<span class="th-resp-mark th-resp-correct">' + I.svg("check", 14) + '</span>'
            : '<span class="th-resp-mark th-resp-wrong">' + I.svg("close", 14) + '</span>') +
        '</div>';

        // 各题回答（显示问题内容 + 选择选项）
        (r.answers || []).forEach(function (a) {
          var q = survey.questions[a.qIndex];
          var qText = q ? q.question : "未知问题";
          var ansText = q ? (q.options[a.choice] || "未知") : "未知";
          html += '<div class="th-resp-qa">';
          html += '<div class="th-resp-q-line">';
          html += '<span class="th-resp-label">' + questionLabel(a.qIndex) + '</span>';
          html += '<span class="th-resp-q-text">' + escapeHtml(qText) + '</span>';
          html += '</div>';
          html += '<div class="th-resp-a-line">';
          html += '<span class="th-resp-arrow">→</span>';
          html += '<span class="th-resp-letter">' + letterFor(a.choice) + '</span>';
          html += '<span class="th-resp-value">' + escapeHtml(ansText) + '</span>';
          html += '</div>';
          html += '</div>';
        });

        html += '</div>';
      });
    }

    // 删除按钮
    html += '<div class="th-read-actions">';
    html += '<button class="btn btn-danger btn-block" data-act="delete-survey" data-id="' + survey.id + '">' +
      I.svg("trash", 18) + '删除问卷</button>';
    html += '</div>';

    html += '</div>';
    return navBar + html;
  }

  /* ---- 制作问卷页 ---- */
  function viewCompose() {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back-main">' + I.svg("close", 20) + '取消</button>' +
        '<span class="nav-title">制作问卷</span>' +
        '<div class="nav-right th-nav-actions">' +
          '<button class="nav-btn-icon" data-act="import-template" title="导入模板">' + I.svg("files", 20) + '</button>' +
          '<button class="nav-btn-icon" data-act="save-template" title="保存为模板">' + I.svg("upload", 20) + '</button>' +
          '<button class="nav-btn" data-act="send-survey">发送</button>' +
        '</div>' +
      '</div>';

    var d = composeData || {
      verifyQuestion: cloneVerify(),
      questions: [{ question: "", options: ["", ""] }],
      recipients: []
    };
    var contacts = getContacts();

    var html = '<div class="scroll th-scroll th-compose">';

    // ===== 验证问题编辑区（问卷顶部） =====
    html += '<div class="th-compose-verify-section">';
    html += '<div class="th-compose-section-head">' +
      '<span class="th-compose-section-icon">' + I.svg("shield", 16) + '</span>' +
      '<span>验证问题（置于问卷顶部）</span>' +
    '</div>';

    // 验证问题文本
    html += '<div class="compose-field">';
    html += '<textarea class="compose-textarea th-vq-input" id="th-vq-question" ' +
      'placeholder="输入验证问题…" maxlength="200" rows="2">' +
      escapeHtml(d.verifyQuestion.question) + '</textarea>';
    html += '</div>';

    // 验证问题选项
    html += '<div id="th-vq-options-wrap">';
    d.verifyQuestion.options.forEach(function (opt, i) {
      html += buildVerifyOptionRow(i, opt, i === d.verifyQuestion.correctIndex, d.verifyQuestion.options.length > 2);
    });
    html += '</div>';
    html += '<button class="th-add-option" id="th-vq-add-opt">' + I.svg("plus", 14) + '添加验证选项</button>';
    html += '</div>';

    html += '<div class="list-sep"></div>';

    // ===== 问卷问题列表 =====
    html += '<div id="th-questions-container">';
    d.questions.forEach(function (q, qi) {
      html += buildQuestionBlock(qi, q, d.questions.length > 1);
    });
    html += '</div>';

    // 添加问题按钮
    html += '<button class="th-add-question" id="th-add-question">' +
      I.svg("plus", 16) + '<span>添加问题</span></button>';

    html += '<div class="list-sep"></div>';

    // ===== 收件人选择 =====
    html += '<div class="compose-field">';
    html += '<label class="compose-label">指定作答人</label>';
    html += '<div class="compose-recipients" id="th-recipients">';
    (d.recipients || []).forEach(function (r, i) {
      html += '<span class="recipient-tag" data-contact-id="' + escapeHtml(r.id) + '">' +
        escapeHtml(r.name) +
        '<button class="recipient-remove" data-act="remove-recipient" data-index="' + i + '">' + I.svg("close", 12) + '</button>' +
      '</span>';
    });
    html += '</div>';
    html += '<div class="compose-contact-picker" id="th-contact-picker">';
    contacts.forEach(function (c) {
      var selected = (d.recipients || []).some(function (r) { return r.id === c.id; });
      html += '<div class="contact-pick-item' + (selected ? " is-selected" : "") + '" ' +
        'data-act="toggle-recipient" data-contact-id="' + escapeHtml(c.id) + '" data-contact-name="' + escapeHtml(c.name) + '">' +
        '<span class="contact-pick-avatar">' + escapeHtml((c.name || "?").charAt(0)) + '</span>' +
        '<span class="contact-pick-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="contact-pick-check">' + I.svg("check", 16) + '</span>' +
      '</div>';
    });
    html += '</div>';
    html += '</div>';

    html += '<div class="compose-actions">';
    html += '<button class="btn btn-primary btn-block" data-act="send-survey">' +
      I.svg("send", 18) + '发送问卷</button>';
    html += '</div>';

    html += '</div>';
    return navBar + html;
  }

  /* 构建一道问题的编辑块 */
  function buildQuestionBlock(qIndex, qData, canDelete) {
    var html = '<div class="th-question-block" data-q-index="' + qIndex + '">';

    // 问题标题行
    html += '<div class="th-question-block-head">';
    html += '<span class="th-question-block-label">' + questionLabel(qIndex) + '</span>';
    if (canDelete) {
      html += '<button class="th-question-del" data-act="delete-question" data-q-index="' + qIndex + '" title="删除问题">' +
        I.svg("close", 14) + '</button>';
    }
    html += '</div>';

    // 问题文本
    html += '<textarea class="compose-textarea th-q-input" ' +
      'placeholder="写下第' + (qIndex + 1) + '个问题…" maxlength="200" rows="2" ' +
      'data-q-index="' + qIndex + '">' +
      escapeHtml(qData.question || "") + '</textarea>';

    // 选项
    html += '<div class="th-q-options-wrap" data-q-index="' + qIndex + '">';
    (qData.options || []).forEach(function (opt, oi) {
      html += buildQuestionOptionRow(qIndex, oi, opt, (qData.options || []).length > 2);
    });
    html += '</div>';
    html += '<button class="th-add-option th-q-add-opt" data-q-index="' + qIndex + '">' +
      I.svg("plus", 14) + '添加选项</button>';

    html += '</div>';
    return html;
  }

  function buildQuestionOptionRow(qIndex, oIndex, value, canDelete) {
    var letter = letterFor(oIndex);
    return '<div class="choice-option-row th-q-option-row" data-q-index="' + qIndex + '" data-o-index="' + oIndex + '">' +
      '<span class="choice-option-label">' + letter + '</span>' +
      '<input type="text" class="choice-option-input th-q-option-input" ' +
        'placeholder="选项 ' + letter + '" maxlength="100" value="' +
        escapeHtml(value || "") + '" data-q-index="' + qIndex + '" data-o-index="' + oIndex + '">' +
      (canDelete ? '<button class="choice-option-del th-q-option-del" title="删除选项">' + I.svg("close", 12) + '</button>' : '') +
    '</div>';
  }

  function buildVerifyOptionRow(index, value, isCorrect, canDelete) {
    var letter = letterFor(index);
    var correctCls = isCorrect ? " is-correct" : "";
    return '<div class="choice-option-row th-vq-option-row' + correctCls + '">' +
      '<span class="choice-option-label">' + letter + '</span>' +
      '<input type="text" class="choice-option-input th-vq-option-input" ' +
        'placeholder="选项 ' + letter + '" maxlength="100" value="' +
        escapeHtml(value || "") + '" data-index="' + index + '">' +
      '<button class="th-verify-correct-btn' + (isCorrect ? " is-active" : "") + '" ' +
        'data-index="' + index + '" title="设为正确答案">' + I.svg("check", 14) + '</button>' +
      (canDelete ? '<button class="choice-option-del th-vq-option-del" title="删除选项">' + I.svg("close", 12) + '</button>' : '') +
    '</div>';
  }

  /* ---- 验证问题模板编辑页 ---- */
  function viewVerifyEdit() {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back-main">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">默认验证问题</span>' +
        '<button class="nav-btn nav-right" data-act="save-verify">保存</button>' +
      '</div>';

    var html = '<div class="scroll th-scroll th-verify-edit">';

    html += '<div class="th-verify-edit-hint">此为新建问卷时的默认验证问题模板。每份问卷可独立编辑自己的验证问题。</div>';

    html += '<div class="compose-field">';
    html += '<label class="compose-label">验证问题</label>';
    html += '<textarea class="compose-textarea th-vq-input" id="th-verify-question" ' +
      'placeholder="输入验证问题…" maxlength="200" rows="2">' +
      escapeHtml(verifyTemplate.question) + '</textarea>';
    html += '</div>';

    html += '<div class="list-sep"></div>';

    html += '<div class="compose-field">';
    html += '<label class="compose-label">答案选项（点击选择正确答案）</label>';
    html += '<div id="th-verify-options-wrap">';
    verifyTemplate.options.forEach(function (opt, i) {
      html += buildVerifyOptionRow(i, opt, verifyTemplate.correctIndex === i, verifyTemplate.options.length > 2);
    });
    html += '</div>';
    html += '<button class="th-add-option" id="th-verify-add-opt">' + I.svg("plus", 14) + '添加选项</button>';
    html += '</div>';

    html += '<div class="th-verify-correct-hint">' +
      I.svg("check", 14) + ' 当前正确答案：' +
      '<strong>' + escapeHtml(verifyTemplate.options[verifyTemplate.correctIndex] || "未设置") + '</strong>' +
    '</div>';

    html += '</div>';
    return navBar + html;
  }

  /* ---- 模板列表页 ---- */
  function viewTemplates() {
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back-compose">' + I.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">问卷模板</span>' +
        '<span class="nav-right"></span>' +
      '</div>';

    var html = '<div class="scroll th-scroll">';

    if (TemplateStore.list.length === 0) {
      html += '<div class="th-section-empty" style="padding-top:var(--sp-10)">暂无保存的模板</div>';
      html += '<div class="th-template-hint">在制作问卷时点击右上角上传图标即可保存当前问卷为模板</div>';
    } else {
      TemplateStore.list.forEach(function (tpl) {
        var qCount = (tpl.questions || []).length;
        var previewQ = "";
        if (tpl.questions && tpl.questions.length > 0) {
          previewQ = tpl.questions[0].question;
        }

        html += '<div class="th-template-item" data-id="' + tpl.id + '">' +
          '<div class="th-template-info" data-act="import-tpl" data-id="' + tpl.id + '">' +
            '<div class="th-template-name">' + escapeHtml(tpl.name || "未命名模板") + '</div>' +
            '<div class="th-template-preview">' + escapeHtml(previewQ) + '</div>' +
            '<div class="th-template-meta">' +
              '<span>' + qCount + ' 题</span>' +
              '<span class="th-template-time">' + fmtTime(tpl.savedTime) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="th-template-actions">' +
            '<button class="th-template-btn th-template-import" data-act="import-tpl" data-id="' + tpl.id + '">' +
              I.svg("download", 16) + '导入</button>' +
            '<button class="th-template-btn th-template-delete" data-act="delete-tpl" data-id="' + tpl.id + '">' +
              I.svg("trash", 16) + '</button>' +
          '</div>' +
        '</div>';
      });
    }

    html += '</div>';
    return navBar + html;
  }

  /* ==================== 事件绑定 ==================== */
  function render() {
    if (!pageEl) return;
    var html;

    if (currentView === "main") html = viewMain();
    else if (currentView === "compose") html = viewCompose();
    else if (currentView === "verify") html = viewVerifyEdit();
    else if (currentView === "read") html = viewRead(currentSurvey);
    else if (currentView === "templates") html = viewTemplates();
    else html = viewMain();

    pageEl.innerHTML = html;
    bindEvents();

    if (window.MineApp && MineApp.switchPage) {
      MineApp.switchPage("detail");
    }
  }

  function bindEvents() {
    if (!pageEl) return;

    // 返回按钮：回到陪伴页（而非主界面）
    pageEl.querySelectorAll('[data-act="back"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (window.MineApp && MineApp.switchPage) {
          MineApp.switchPage("companion");
        } else if (window.MineApp && MineApp.goHome) {
          MineApp.goHome();
        }
      });
    });
    pageEl.querySelectorAll('[data-act="back-main"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        currentSurvey = null;
        composeData = null;
        goBack();
      });
    });

    // 搜索输入
    var searchInput = pageEl.querySelector("#th-search");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        var self = this;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          searchQuery = self.value;
          render();
          var newInput = pageEl.querySelector("#th-search");
          if (newInput) {
            newInput.focus();
            var len = newInput.value.length;
            newInput.setSelectionRange(len, len);
          }
        }, 300);
      });
    }

    // 清除搜索
    pageEl.querySelectorAll('[data-act="clear-search"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        searchQuery = "";
        render();
      });
    });

    // 制作问卷
    pageEl.querySelectorAll('[data-act="compose"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        composeData = {
          verifyQuestion: cloneVerify(),
          questions: [{ question: "", options: ["", ""] }],
          recipients: []
        };
        navigateTo("compose");
      });
    });

    // 验证问题模板编辑
    pageEl.querySelectorAll('[data-act="verify-edit"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        navigateTo("verify");
      });
    });

    // 阅读问卷
    pageEl.querySelectorAll('[data-act="read-survey"]').forEach(function (item) {
      item.addEventListener("click", function () {
        var id = item.getAttribute("data-id");
        var s = TreeHoleStore.getById(id);
        if (s) {
          currentSurvey = s;
          navigateTo("read");
        }
      });
    });

    // 删除问卷
    pageEl.querySelectorAll('[data-act="delete-survey"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        TreeHoleStore.remove(id);
        pendingReplies = pendingReplies.filter(function (p) { return p.surveyId !== id; });
        savePending();
        resetTo("main");
      });
    });

    // 发送问卷
    pageEl.querySelectorAll('[data-act="send-survey"]').forEach(function (btn) {
      btn.addEventListener("click", sendSurvey);
    });

    // 保存验证问题模板
    pageEl.querySelectorAll('[data-act="save-verify"]').forEach(function (btn) {
      btn.addEventListener("click", saveVerifyTemplate);
    });

    // 保存问卷为模板
    pageEl.querySelectorAll('[data-act="save-template"]').forEach(function (btn) {
      btn.addEventListener("click", saveAsTemplate);
    });

    // 导入模板（打开模板列表）
    pageEl.querySelectorAll('[data-act="import-template"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        captureAllInputs();
        navigateTo("templates");
      });
    });

    // 从模板列表返回制作问卷页
    pageEl.querySelectorAll('[data-act="back-compose"]').forEach(function (btn) {
      btn.addEventListener("click", goBack);
    });

    // 导入模板
    pageEl.querySelectorAll('[data-act="import-tpl"]').forEach(function (item) {
      item.addEventListener("click", function () {
        var id = item.getAttribute("data-id");
        var tpl = TemplateStore.getById(id);
        if (tpl) {
          // 深拷贝模板数据，保留当前收件人
          var currentRecipients = (composeData && composeData.recipients) ? composeData.recipients : [];
          composeData = {
            verifyQuestion: JSON.parse(JSON.stringify(tpl.verifyQuestion)),
            questions: JSON.parse(JSON.stringify(tpl.questions)),
            recipients: currentRecipients
          };
          goBack();
        }
      });
    });

    // 删除模板
    pageEl.querySelectorAll('[data-act="delete-tpl"]').forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-id");
        TemplateStore.remove(id);
        render();
      });
    });

    // ===== 制作问卷页事件 =====
    if (currentView === "compose") {
      bindComposeEvents();
    }

    // ===== 验证问题模板编辑页事件 =====
    if (currentView === "verify") {
      bindVerifyTemplateEvents();
    }
  }

  /* ---- 制作问卷页事件 ---- */
  function bindComposeEvents() {
    // 验证问题文本输入
    var vqInput = pageEl.querySelector("#th-vq-question");
    if (vqInput) {
      vqInput.addEventListener("input", function () {
        if (!composeData) return;
        composeData.verifyQuestion.question = this.value;
      });
    }

    // 验证问题选项事件
    var vqWrap = pageEl.querySelector("#th-vq-options-wrap");
    if (vqWrap) {
      bindComposeVerifyOptionEvents(vqWrap);
    }

    // 验证问题添加选项
    var vqAddBtn = pageEl.querySelector("#th-vq-add-opt");
    if (vqAddBtn) {
      vqAddBtn.addEventListener("click", function () {
        if (!composeData) return;
        var opts = composeData.verifyQuestion.options;
        if (opts.length >= 26) return;
        opts.push("");
        rerenderVerifyOptions();
      });
    }

    // 问题文本输入
    pageEl.querySelectorAll(".th-q-input").forEach(function (inp) {
      inp.addEventListener("input", function () {
        if (!composeData) return;
        var qi = parseInt(this.getAttribute("data-q-index"), 10);
        if (composeData.questions[qi]) {
          composeData.questions[qi].question = this.value;
        }
      });
    });

    // 问题选项输入
    pageEl.querySelectorAll(".th-q-option-input").forEach(function (inp) {
      inp.addEventListener("input", function () {
        if (!composeData) return;
        var qi = parseInt(this.getAttribute("data-q-index"), 10);
        var oi = parseInt(this.getAttribute("data-o-index"), 10);
        if (composeData.questions[qi] && composeData.questions[qi].options) {
          composeData.questions[qi].options[oi] = this.value;
        }
      });
    });

    // 问题选项删除
    pageEl.querySelectorAll(".th-q-option-del").forEach(function (delBtn) {
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!composeData) return;
        var row = delBtn.closest(".th-q-option-row");
        if (!row) return;
        var qi = parseInt(row.getAttribute("data-q-index"), 10);
        var oi = parseInt(row.getAttribute("data-o-index"), 10);
        var opts = composeData.questions[qi].options;
        if (opts.length <= 2) return;
        opts.splice(oi, 1);
        rerenderQuestionBlock(qi);
      });
    });

    // 问题添加选项
    pageEl.querySelectorAll(".th-q-add-opt").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!composeData) return;
        var qi = parseInt(this.getAttribute("data-q-index"), 10);
        var opts = composeData.questions[qi].options;
        if (opts.length >= 26) return;
        opts.push("");
        rerenderQuestionBlock(qi);
      });
    });

    // 删除问题
    pageEl.querySelectorAll('[data-act="delete-question"]').forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!composeData) return;
        if (composeData.questions.length <= 1) return;
        var qi = parseInt(this.getAttribute("data-q-index"), 10);
        composeData.questions.splice(qi, 1);
        captureVerifyInputs();
        render();
      });
    });

    // 添加问题
    var addQuestionBtn = pageEl.querySelector("#th-add-question");
    if (addQuestionBtn) {
      addQuestionBtn.addEventListener("click", function () {
        if (!composeData) return;
        captureAllInputs();
        composeData.questions.push({ question: "", options: ["", ""] });
        render();
      });
    }

    // 收件人切换
    pageEl.querySelectorAll('[data-act="toggle-recipient"]').forEach(function (item) {
      item.addEventListener("click", function () {
        var cid = item.getAttribute("data-contact-id");
        var cname = item.getAttribute("data-contact-name");
        if (!composeData) composeData = { verifyQuestion: cloneVerify(), questions: [], recipients: [] };
        if (!composeData.recipients) composeData.recipients = [];

        var idx = composeData.recipients.findIndex(function (r) { return r.id === cid; });
        if (idx >= 0) {
          composeData.recipients.splice(idx, 1);
        } else {
          composeData.recipients.push({ id: cid, name: cname });
        }
        captureAllInputs();
        render();
      });
    });

    // 移除收件人标签
    pageEl.querySelectorAll('[data-act="remove-recipient"]').forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-index"), 10);
        if (composeData && composeData.recipients) {
          composeData.recipients.splice(idx, 1);
          captureAllInputs();
          render();
        }
      });
    });
  }

  /* 重新渲染验证问题选项区域 */
  function rerenderVerifyOptions() {
    var wrap = pageEl.querySelector("#th-vq-options-wrap");
    if (!wrap || !composeData) return;
    var vq = composeData.verifyQuestion;
    wrap.innerHTML = "";
    vq.options.forEach(function (opt, i) {
      wrap.insertAdjacentHTML("beforeend",
        buildVerifyOptionRow(i, opt, i === vq.correctIndex, vq.options.length > 2));
    });
    bindComposeVerifyOptionEvents(wrap);
  }

  /* 重新渲染某道问题的选项区域 */
  function rerenderQuestionBlock(qi) {
    var container = pageEl.querySelector("#th-questions-container");
    if (!container || !composeData) return;
    var q = composeData.questions[qi];
    if (!q) return;
    var block = container.querySelector('.th-question-block[data-q-index="' + qi + '"]');
    if (!block) return;
    var newBlockHtml = buildQuestionBlock(qi, q, composeData.questions.length > 1);
    var tempDiv = document.createElement("div");
    tempDiv.innerHTML = newBlockHtml;
    var newBlock = tempDiv.firstChild;
    block.parentNode.replaceChild(newBlock, block);

    // 重新绑定该块的事件
    bindQuestionBlockEvents(newBlock);
  }

  function bindQuestionBlockEvents(block) {
    // 问题文本
    var qInput = block.querySelector(".th-q-input");
    if (qInput) {
      qInput.addEventListener("input", function () {
        if (!composeData) return;
        var qi = parseInt(this.getAttribute("data-q-index"), 10);
        if (composeData.questions[qi]) {
          composeData.questions[qi].question = this.value;
        }
      });
    }

    // 选项输入
    block.querySelectorAll(".th-q-option-input").forEach(function (inp) {
      inp.addEventListener("input", function () {
        if (!composeData) return;
        var qi = parseInt(this.getAttribute("data-q-index"), 10);
        var oi = parseInt(this.getAttribute("data-o-index"), 10);
        if (composeData.questions[qi] && composeData.questions[qi].options) {
          composeData.questions[qi].options[oi] = this.value;
        }
      });
    });

    // 选项删除
    block.querySelectorAll(".th-q-option-del").forEach(function (delBtn) {
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!composeData) return;
        var row = delBtn.closest(".th-q-option-row");
        if (!row) return;
        var qi = parseInt(row.getAttribute("data-q-index"), 10);
        var oi = parseInt(row.getAttribute("data-o-index"), 10);
        var opts = composeData.questions[qi].options;
        if (opts.length <= 2) return;
        opts.splice(oi, 1);
        rerenderQuestionBlock(qi);
      });
    });

    // 添加选项
    var addBtn = block.querySelector(".th-q-add-opt");
    if (addBtn) {
      addBtn.addEventListener("click", function () {
        if (!composeData) return;
        var qi = parseInt(this.getAttribute("data-q-index"), 10);
        var opts = composeData.questions[qi].options;
        if (opts.length >= 26) return;
        opts.push("");
        rerenderQuestionBlock(qi);
      });
    }

    // 删除问题
    var delQ = block.querySelector('[data-act="delete-question"]');
    if (delQ) {
      delQ.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!composeData) return;
        if (composeData.questions.length <= 1) return;
        var qi = parseInt(this.getAttribute("data-q-index"), 10);
        composeData.questions.splice(qi, 1);
        captureVerifyInputs();
        render();
      });
    }
  }

  /* 验证问题选项事件（制作问卷页） */
  function bindComposeVerifyOptionEvents(wrap) {
    // 正确答案选择
    wrap.querySelectorAll(".th-verify-correct-btn").forEach(function (btn) {
      if (btn._thBound) return;
      btn._thBound = true;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!composeData) return;
        var idx = parseInt(btn.getAttribute("data-index"), 10);
        composeData.verifyQuestion.correctIndex = idx;
        rerenderVerifyOptions();
      });
    });

    // 选项删除
    wrap.querySelectorAll(".th-vq-option-del").forEach(function (delBtn) {
      if (delBtn._thBound) return;
      delBtn._thBound = true;
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!composeData) return;
        var vq = composeData.verifyQuestion;
        var row = delBtn.closest(".th-vq-option-row");
        if (!row) return;
        var rows = wrap.querySelectorAll(".th-vq-option-row");
        if (rows.length <= 2) return;
        var idx = Array.prototype.indexOf.call(rows, row);
        vq.options.splice(idx, 1);
        if (vq.correctIndex >= vq.options.length) {
          vq.correctIndex = 0;
        } else if (vq.correctIndex > idx) {
          vq.correctIndex--;
        }
        rerenderVerifyOptions();
      });
    });

    // 选项输入
    wrap.querySelectorAll(".th-vq-option-input").forEach(function (inp) {
      if (inp._thBound) return;
      inp._thBound = true;
      inp.addEventListener("input", function () {
        if (!composeData) return;
        var idx = parseInt(this.getAttribute("data-index"), 10);
        composeData.verifyQuestion.options[idx] = this.value;
      });
    });
  }

  /* 捕获验证问题输入 */
  function captureVerifyInputs() {
    if (!composeData) return;
    var vqInput = pageEl.querySelector("#th-vq-question");
    if (vqInput) composeData.verifyQuestion.question = vqInput.value;
  }

  /* 捕获所有输入 */
  function captureAllInputs() {
    if (!composeData) return;
    captureVerifyInputs();

    // 捕获所有问题文本
    pageEl.querySelectorAll(".th-q-input").forEach(function (inp) {
      var qi = parseInt(inp.getAttribute("data-q-index"), 10);
      if (composeData.questions[qi]) {
        composeData.questions[qi].question = inp.value;
      }
    });

    // 捕获所有选项输入
    pageEl.querySelectorAll(".th-q-option-input").forEach(function (inp) {
      var qi = parseInt(inp.getAttribute("data-q-index"), 10);
      var oi = parseInt(inp.getAttribute("data-o-index"), 10);
      if (composeData.questions[qi] && composeData.questions[qi].options) {
        composeData.questions[qi].options[oi] = inp.value;
      }
    });

    // 捕获验证问题选项
    pageEl.querySelectorAll(".th-vq-option-input").forEach(function (inp) {
      var idx = parseInt(inp.getAttribute("data-index"), 10);
      composeData.verifyQuestion.options[idx] = inp.value;
    });
  }

  /* ---- 验证问题模板编辑页事件 ---- */
  function bindVerifyTemplateEvents() {
    // 验证问题文本输入
    var vqInput = pageEl.querySelector("#th-verify-question");
    if (vqInput) {
      vqInput.addEventListener("input", function () {
        verifyTemplate.question = this.value;
      });
    }

    // 验证问题选项事件
    var vWrap = pageEl.querySelector("#th-verify-options-wrap");
    if (vWrap) {
      bindTemplateVerifyOptionEvents(vWrap);
    }

    // 添加选项
    var vAddBtn = pageEl.querySelector("#th-verify-add-opt");
    if (vAddBtn) {
      vAddBtn.addEventListener("click", function () {
        var wrap = pageEl.querySelector("#th-verify-options-wrap");
        if (!wrap) return;
        if (verifyTemplate.options.length >= 26) return;
        verifyTemplate.options.push("");
        rerenderTemplateVerifyOptions();
      });
    }
  }

  function rerenderTemplateVerifyOptions() {
    var wrap = pageEl.querySelector("#th-verify-options-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";
    verifyTemplate.options.forEach(function (opt, i) {
      wrap.insertAdjacentHTML("beforeend",
        buildVerifyOptionRow(i, opt, i === verifyTemplate.correctIndex, verifyTemplate.options.length > 2));
    });
    bindTemplateVerifyOptionEvents(wrap);
    // 更新提示
    var hint = pageEl.querySelector(".th-verify-correct-hint strong");
    if (hint) hint.textContent = verifyTemplate.options[verifyTemplate.correctIndex] || "未设置";
  }

  function bindTemplateVerifyOptionEvents(wrap) {
    // 正确答案选择
    wrap.querySelectorAll(".th-verify-correct-btn").forEach(function (btn) {
      if (btn._thBound) return;
      btn._thBound = true;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-index"), 10);
        verifyTemplate.correctIndex = idx;
        rerenderTemplateVerifyOptions();
      });
    });

    // 选项删除
    wrap.querySelectorAll(".th-vq-option-del").forEach(function (delBtn) {
      if (delBtn._thBound) return;
      delBtn._thBound = true;
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var row = delBtn.closest(".th-vq-option-row");
        if (!row) return;
        var rows = wrap.querySelectorAll(".th-vq-option-row");
        if (rows.length <= 2) return;
        var idx = Array.prototype.indexOf.call(rows, row);
        verifyTemplate.options.splice(idx, 1);
        if (verifyTemplate.correctIndex >= verifyTemplate.options.length) {
          verifyTemplate.correctIndex = 0;
        } else if (verifyTemplate.correctIndex > idx) {
          verifyTemplate.correctIndex--;
        }
        rerenderTemplateVerifyOptions();
      });
    });

    // 选项输入
    wrap.querySelectorAll(".th-vq-option-input").forEach(function (inp) {
      if (inp._thBound) return;
      inp._thBound = true;
      inp.addEventListener("input", function () {
        var idx = parseInt(this.getAttribute("data-index"), 10);
        verifyTemplate.options[idx] = this.value;
        if (idx === verifyTemplate.correctIndex) {
          var hint = pageEl.querySelector(".th-verify-correct-hint strong");
          if (hint) hint.textContent = this.value || "未设置";
        }
      });
    });
  }

  /* ==================== 操作 ==================== */
  function sendSurvey() {
    if (!composeData) return;

    captureAllInputs();

    // 验证验证问题
    var vq = composeData.verifyQuestion;
    if (!vq.question || !vq.question.trim()) {
      var vqEl = pageEl.querySelector("#th-vq-question");
      if (vqEl) {
        vqEl.classList.add("shake");
        setTimeout(function () { vqEl.classList.remove("shake"); }, 400);
      }
      return;
    }
    var vqOptions = (vq.options || []).map(function (o) { return (o || "").trim(); }).filter(function (o) { return o.length > 0; });
    if (vqOptions.length < 2) {
      var vqFirstInput = pageEl.querySelector("#th-vq-options-wrap .choice-option-input");
      if (vqFirstInput) {
        vqFirstInput.classList.add("shake");
        setTimeout(function () { vqFirstInput.classList.remove("shake"); }, 400);
      }
      return;
    }

    // 验证问卷问题
    var questions = [];
    for (var i = 0; i < composeData.questions.length; i++) {
      var q = composeData.questions[i];
      var qText = (q.question || "").trim();
      if (!qText) {
        var qEl = pageEl.querySelector('.th-q-input[data-q-index="' + i + '"]');
        if (qEl) {
          qEl.classList.add("shake");
          setTimeout(function () { qEl.classList.remove("shake"); }, 400);
        }
        return;
      }
      var qOptions = (q.options || []).map(function (o) { return (o || "").trim(); }).filter(function (o) { return o.length > 0; });
      if (qOptions.length < 2) {
        var qFirstInput = pageEl.querySelector('.th-q-options-wrap[data-q-index="' + i + '"] .choice-option-input');
        if (qFirstInput) {
          qFirstInput.classList.add("shake");
          setTimeout(function () { qFirstInput.classList.remove("shake"); }, 400);
        }
        return;
      }
      questions.push({ question: qText, options: qOptions });
    }

    if (!composeData.recipients || composeData.recipients.length === 0) {
      var picker = pageEl.querySelector("#th-contact-picker");
      if (picker) {
        picker.style.animation = "none";
        picker.offsetHeight;
        picker.style.animation = "mailShake 0.4s ease";
      }
      return;
    }

    // 修正验证问题的正确答案索引
    var correctIdx = vq.correctIndex;
    // 如果有选项被过滤掉，需要调整 correctIndex
    var vqFilteredOptions = vq.options.map(function (o, idx) {
      return { val: (o || "").trim(), idx: idx };
    }).filter(function (o) { return o.val.length > 0; });
    var newCorrectIdx = 0;
    for (var j = 0; j < vqFilteredOptions.length; j++) {
      if (vqFilteredOptions[j].idx === correctIdx) {
        newCorrectIdx = j;
        break;
      }
    }

    var survey = {
      verifyQuestion: {
        question: vq.question.trim(),
        options: vqFilteredOptions.map(function (o) { return o.val; }),
        correctIndex: newCorrectIdx
      },
      questions: questions,
      recipients: composeData.recipients
    };

    TreeHoleStore.add(survey);
    scheduleReply(survey);

    composeData = null;
    resetTo("main");
  }

  function saveVerifyTemplate() {
    if (!verifyTemplate.question || !verifyTemplate.question.trim()) {
      var qEl = pageEl.querySelector("#th-verify-question");
      if (qEl) {
        qEl.classList.add("shake");
        setTimeout(function () { qEl.classList.remove("shake"); }, 400);
      }
      return;
    }

    verifyTemplate.options = verifyTemplate.options.filter(function (o) { return o && o.trim(); });
    if (verifyTemplate.options.length < 2) return;

    if (verifyTemplate.correctIndex >= verifyTemplate.options.length) {
      verifyTemplate.correctIndex = 0;
    }

    saveVerify();
    resetTo("main");
  }

  /* 保存当前问卷为模板 */
  function saveAsTemplate() {
    if (!composeData) return;
    captureAllInputs();

    // 验证至少有一道完整的问题
    var hasValidQuestion = false;
    var questions = [];
    for (var i = 0; i < composeData.questions.length; i++) {
      var q = composeData.questions[i];
      var qText = (q.question || "").trim();
      var qOptions = (q.options || []).map(function (o) { return (o || "").trim(); }).filter(function (o) { return o.length > 0; });
      if (qText && qOptions.length >= 2) {
        questions.push({ question: qText, options: qOptions });
        hasValidQuestion = true;
      }
    }

    if (!hasValidQuestion) {
      var qEl = pageEl.querySelector(".th-q-input");
      if (qEl) {
        qEl.classList.add("shake");
        setTimeout(function () { qEl.classList.remove("shake"); }, 400);
      }
      return;
    }

    // 使用验证问题（如果有完整填写），否则用默认模板
    var vq = composeData.verifyQuestion;
    var vqQuestion = (vq.question || "").trim();
    var vqOptions = (vq.options || []).map(function (o) { return (o || "").trim(); }).filter(function (o) { return o.length > 0; });
    var verifyData;
    if (vqQuestion && vqOptions.length >= 2) {
      var correctIdx = vq.correctIndex;
      var vqFiltered = vq.options.map(function (o, idx) {
        return { val: (o || "").trim(), idx: idx };
      }).filter(function (o) { return o.val.length > 0; });
      var newCorrectIdx = 0;
      for (var j = 0; j < vqFiltered.length; j++) {
        if (vqFiltered[j].idx === correctIdx) {
          newCorrectIdx = j;
          break;
        }
      }
      verifyData = {
        question: vqQuestion,
        options: vqFiltered.map(function (o) { return o.val; }),
        correctIndex: newCorrectIdx
      };
    } else {
      verifyData = cloneVerify();
    }

    // 以第一道问题作为模板名称
    var tplName = questions[0].question;
    if (tplName.length > 20) tplName = tplName.substring(0, 20) + "…";

    var template = {
      name: tplName,
      verifyQuestion: verifyData,
      questions: questions
    };

    TemplateStore.add(template);

    // 轻提示
    var fab = pageEl.querySelector(".th-compose-fab");
    showToast("已保存为模板");
  }

  /* 轻提示 */
  var toastTimer = null;
  function showToast(msg) {
    var existing = document.querySelector(".th-toast");
    if (existing) existing.remove();
    if (toastTimer) clearTimeout(toastTimer);

    var toast = document.createElement("div");
    toast.className = "th-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);

    requestAnimationFrame(function () {
      toast.classList.add("th-toast-show");
    });

    toastTimer = setTimeout(function () {
      toast.classList.remove("th-toast-show");
      setTimeout(function () { toast.remove(); }, 300);
    }, 2000);
  }

  /* ==================== 初始化 ==================== */
  function init() {
    pageEl = document.getElementById("page-detail");
    TreeHoleStore.load();
    TemplateStore.load();
    loadVerify();
    loadPending();
    startChecker();
  }

  /* ==================== 通知接口 ====================
     供 MineNotify 在 app.js 中注册为 "companion" 聚合 provider 的一部分
     未读 = 问卷回复总数 - 已查看数
  */
  var SEEN_COUNT_KEY = "mine.treehole.seenCount.v1";
  var seenCount = 0;

  function loadSeenCount() {
    try { seenCount = parseInt(localStorage.getItem(SEEN_COUNT_KEY)) || 0; } catch (e) {}
  }
  function saveSeenCount() {
    try { localStorage.setItem(SEEN_COUNT_KEY, String(seenCount)); } catch (e) {}
  }
  function countResponses() {
    TreeHoleStore.load();
    var total = 0;
    TreeHoleStore.list.forEach(function (s) {
      total += (s.responses || []).length;
    });
    return total;
  }
  function getUnreadCount() {
    loadSeenCount();
    return Math.max(0, countResponses() - seenCount);
  }
  function clearUnread() {
    seenCount = countResponses();
    saveSeenCount();
  }

  /* ==================== 公共接口 ==================== */
  return {
    init: init,
    open: function () {
      if (!pageEl) pageEl = document.getElementById("page-detail");
      TreeHoleStore.load();
      TemplateStore.load();
      loadVerify();
      loadPending();
      checkPending();
      viewHistory = [];
      currentView = "main";
      searchQuery = "";
      render();
    },
    getStore: function () { return TreeHoleStore; },
    getTemplateStore: function () { return TemplateStore; },
    getVerifyTemplate: function () { return verifyTemplate; },
    getUnreadCount: getUnreadCount,
    clearUnread: clearUnread
  };
})();
