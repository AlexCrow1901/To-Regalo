 /* ========================================================================
   Mine · 应用主逻辑（UI v2：组件化桌面）
   ------------------------------------------------------------------------
   · 应用注册表（图标 / 标签 / 行为）—— 后续扩展直接在此追加
   · 组件化桌面：3 屏滑动 + 组件库（A-Z 添加、搜索）+ 编辑模式（拖动避让 / ×删除）
   · Dock 渲染（主页 / 陪伴 / 个人中心 / 设置）
   · 状态栏时钟 / 问候语 / 编辑圆点
   · 页面切换（Home ↔ 各功能页，兼容旧 .is-active 与新 .on）
   · 预留扩展：APP.page() 钩子，供聊天 / 通讯录 / 陪伴 / 设置 / 个人中心等接入
   ======================================================================== */
(function () {
  "use strict";
  /* ---------------- 应用注册表 ----------------
     page: 跳转到同名占位页；action:'background' 打开背景管理。
     后续新增功能：在此添加条目，并实现对应 page 钩子即可。 */
  var APPS = [
    { id: "chat",       icon: "chat",       label: "聊天" },
    { id: "phone",      icon: "phone",      label: "电话" },
    { id: "contacts",   icon: "contacts",   label: "通讯录" },
    { id: "companion",  icon: "discover",   label: "陪伴" },
    { id: "moments",    icon: "moments",    label: "朋友圈" },
    { id: "settings",   icon: "settings",   label: "设置" },
    { id: "weather",    icon: "weather",    label: "天气" },
    { id: "browser",    icon: "browser",    label: "浏览器" },
    { id: "files",      icon: "files",      label: "文件" }
  ];
  /* ---------------- 底部 Dock（UI v2：主页 / 陪伴 / 个人中心 / 设置） ---------------- */
  var DOCK = [
    { id: "home",      icon: "home",      label: "主页" },
    { id: "companion", icon: "discover",  label: "陪伴" },
    { id: "me",        icon: "me",        label: "个人中心" },
    { id: "settings",  icon: "settings",  label: "设置" }
  ];
  /* ---------------- 占位页文案（后续替换为真实功能） ---------------- */
  var PLACEHOLDER = {
    chat:     { title: "聊天",   icon: "chat",     desc: "聊天模块加载中…" },
    contacts: { title: "通讯录", icon: "contacts", desc: "联系人系统加载中…" },
    discover: { title: "陪伴",   icon: "discover", desc: "陪伴页正在酝酿之中。" },
    companion: { title: "陪伴",  icon: "discover", desc: "陪伴页正在酝酿之中。" },
    moments:  { title: "朋友圈", icon: "moments",  desc: "动态广场待开放。" },
    files:    { title: "文件",   icon: "files",    desc: "文件管理尚未启用。" },
    settings: { title: "设置",   icon: "settings", desc: "设置项将在后续版本完善。" },
    weather:  { title: "天气",   icon: "weather",  desc: "雾都今日：浓雾，湿冷。\n能见度低，注意脚下石板路。" },
    phone:    { title: "电话",   icon: "phone",    desc: "通话功能正在加载中。" },
    browser:  { title: "浏览",   icon: "browser",  desc: "浏览器尚未启用。" },
    me:       { title: "我",     icon: "me",       desc: "个人中心建设中。" },
    mail:     { title: "次元信箱", icon: "mail",   desc: "信箱模块迁移中。" },
    treehole: { title: "深夜树洞", icon: "moon",   desc: "树洞模块迁移中。" },
    radio:    { title: "心情电台", icon: "music",  desc: "电台模块迁移中。" },
    food:     { title: "觅食",   icon: "utensils", desc: "觅食模块迁移中。" },
    card:     { title: "字卡管理", icon: "card",   desc: "字卡管理迁移中。" },
    cards:    { title: "字卡池", icon: "allcards", desc: "字卡池迁移中。" },
    cm:       { title: "联系人朋友圈", icon: "cm", desc: "联系人朋友圈迁移中。" },
    vinyl:    { title: "黑胶唱片", icon: "music",  desc: "黑胶组件示例，待接电台数据。" },
    quote:    { title: "每日寄语", icon: "quotes", desc: "寄语组件示例，待接陪伴数据。" },
    album:    { title: "拍立得相册", icon: "grid", desc: "相册组件示例，待接记忆数据。" }
  };
  /* ---------------- 公共扩展命名空间 ---------------- */
  var APP = window.MineApp = window.MineApp || {};
  /* ---------------- DOM 引用 ---------------- */
  var dom = {};

  /* ==================== UI v2：组件化桌面 ==================== */
  /* 网格常量（与预览稿 all-ui-preview 一致） */
  var COLS = 4;
  var CELLW = 78, CELLH = 100, GAP = 6;
  var PAD = 8, TOP = 44;
  var MAXROW = 6;

  /* 组件图标库（预览稿 SVG 全集 + 补缺） */
  var SVG = {
    chat: '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    contacts: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    companion: '<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    moments: '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    weather: '<svg viewBox="0 0 24 24"><path d="M17.5 19a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 15.9"/></svg>',
    browser: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/></svg>',
    sunrise: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    wind: '<svg viewBox="0 0 24 24"><path d="M12 22c5.52 0 10-4.48 10-10S17.52 2 12 2 2 6.48 2 12s4.48 10 10 10z"/><path d="M12 8v4l3 3"/></svg>',
    feather: '<svg viewBox="0 0 24 24"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>',
    book: '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    utensils: '<svg viewBox="0 0 24 24"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/></svg>',
    flame: '<svg viewBox="0 0 24 24"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    files: '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    netease: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    cm: '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    card: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
    persona: '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    mycards: '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    allcards: '<svg viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
    probs: '<svg viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    bg: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    theme: '<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    export: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    quotes: '<svg viewBox="0 0 24 24"><path d="M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4a4 4 0 0 1-4 4"/><path d="M21 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4a4 4 0 0 1-4 4"/></svg>',
    mail: '<svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="M3 9l1-5.04h16L21 9"/><path d="M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21v-6h6v6"/></svg>',
    me: '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
  };
  function svgFor(type) {
    return SVG[type] || SVG.feather;
  }

  /* 组件库（A-Z 排序；letter 用于分组） */
  var LIB_ITEMS = [
    { type:"chat",    name:"聊天",      letter:"L" },
    { type:"phone",   name:"电话",      letter:"D" },
    { type:"contacts",name:"通讯录",    letter:"T" },
    { type:"companion",name:"陪伴",     letter:"P" },
    { type:"moments", name:"朋友圈",    letter:"P" },
    { type:"settings",name:"设置",      letter:"S" },
    { type:"weather", name:"天气",      letter:"T" },
    { type:"browser", name:"浏览器",    letter:"L" },
    { type:"vinyl",   name:"黑胶唱片",  letter:"H" },
    { type:"quote",   name:"每日寄语",  letter:"M" },
    { type:"album",   name:"拍立得相册",letter:"P" },
    { type:"daily",   name:"每日陪伴",  letter:"M" },
    { type:"radio",   name:"心情电台",  letter:"X" },
    { type:"breath",  name:"呼吸练习",  letter:"H" },
    { type:"mailbox", name:"次元信箱",  letter:"C" },
    { type:"memory",  name:"记忆相册",  letter:"J" },
    { type:"treehole",name:"深夜树洞",  letter:"S" },
    { type:"food",    name:"觅食",      letter:"M" },
    { type:"flame",   name:"静默炉火",  letter:"J" },
    { type:"heart",   name:"陪伴之心",  letter:"B" },
    { type:"files",   name:"文件",      letter:"W" },
    { type:"netease", name:"网易云音乐", letter:"W" },
    { type:"cm",      name:"联系人朋友圈", letter:"L" },
    { type:"card",    name:"字卡管理",  letter:"Z" },
    { type:"persona", name:"联系人人设", letter:"L" },
    { type:"mycards", name:"我的字卡",  letter:"W" },
    { type:"allcards",name:"全部字卡",  letter:"Q" },
    { type:"probs",   name:"概率修改",  letter:"G" },
    { type:"bg",      name:"背景管理",  letter:"B" },
    { type:"theme",   name:"主题切换",  letter:"Z" },
    { type:"export",  name:"数据导出",  letter:"S" },
    { type:"quotes",  name:"寄语管理",  letter:"J" }
  ].sort(function (a, b) {
    return a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : (a.name < b.name ? -1 : 1);
  });

  function libName(type) {
    for (var i = 0; i < LIB_ITEMS.length; i++) if (LIB_ITEMS[i].type === type) return LIB_ITEMS[i].name;
    return type;
  }
  function templateFor(type) {
    switch (type) {
      case "vinyl":
        return { cls: "w-vinyl", html: '<div class="glass"><div class="disc"><span>To-Regalo</span></div></div><div class="info"><div class="t">CosmicLove</div><div class="a">Finne</div><div class="bar"><i></i></div><div class="ctl"><span>⏮</span><span>▶</span><span>⏭</span></div></div><div class="w-del">×</div>', w: 3, h: 1 };
      case "quote":
        return { cls: "w-quote", html: '<div class="ql">TODAY\'S QUOTE</div><div class="qt">"雾散了又聚，而你始终在灯火阑珊处。"</div><div class="qa">—— 艾琳·格雷</div><div class="w-del">×</div>', w: 4, h: 1 };
      case "album":
        return { cls: "w-album", html: '<div class="w-del">×</div>', w: 1, h: 1 };
    }
    var appTypes = { chat: 1, phone: 1, contacts: 1, companion: 1, moments: 1, settings: 1, weather: 1, browser: 1, files: 1 };
    if (appTypes[type]) return { cls: "w-app", html: '<div class="ic">' + svgFor(type) + '</div><div class="nm">' + libName(type) + '</div><div class="w-del">×</div>', w: 1, h: 1 };
    return { cls: "w-comp", html: '<div class="ic">' + svgFor(type) + '</div><div class="nm">' + libName(type) + '</div><div class="w-del">×</div>', w: 1, h: 1 };
  }

  /* ---- 布局算法（与预览稿一致：重叠检测 + 顺位避让） ---- */
  function overlap(w1, h1, c1, r1, w2, h2, c2, r2) {
    return !(c1 + w1 <= c2 || c2 + w2 <= c1 || r1 + h1 <= r2 || r2 + h2 <= r1);
  }
  function findFreeSlot(w, h, placed, startCol, startRow) {
    var col = startCol || 0, row = startRow || 0;
    for (;;) {
      var ok = true;
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i];
        if (overlap(w, h, col, row, p.w, p.h, p.col, p.row)) { ok = false; break; }
      }
      if (ok) return { col: col, row: row };
      col++;
      if (col >= COLS) { col = 0; row++; }
      if (row > MAXROW) { row = 0; col = 0; }
    }
  }
  function sortByPos(a, b) { return (a.row - b.row) || (a.col - b.col); }

  /* ---- 桌面状态 ---- */
  var homeState = {
    pages: [],      // [{ canvas, widgets:[] }]
    activeIdx: 0,
    editing: false
  };
  function curPage() { return homeState.pages[homeState.activeIdx] || homeState.pages[0]; }
  function renderAll() {
    var page = curPage();
    page.widgets.forEach(function (wd) {
      wd.el.style.left = (PAD + wd.col * (CELLW + GAP)) + "px";
      wd.el.style.top  = (TOP  + wd.row * (CELLH + GAP)) + "px";
      wd.el.style.width = (wd.w * CELLW + (wd.w - 1) * GAP) + "px";
    });
  }
  function placeWidget(wd, col, row) {
    wd.col = col; wd.row = row;
    var list = curPage().widgets.slice();
    var idx = list.indexOf(wd);
    if (idx >= 0) list.splice(idx, 1);
    list.push(wd);
    list.sort(sortByPos);
    var placed = [];
    list.forEach(function (it) {
      var slot = findFreeSlot(it.w, it.h, placed, it.col, it.row);
      it.col = slot.col; it.row = slot.row;
      placed.push(it);
    });
    curPage().widgets = placed;
    renderAll();
  }
  function addWidget(type) {
    var t = templateFor(type);
    var el = document.createElement("div");
    el.className = "widget " + t.cls;
    el.setAttribute("data-w", type);
    el.setAttribute("data-name", libName(type));
    el.innerHTML = t.html;
    curPage().canvas.appendChild(el);
    var wd = { type: type, el: el, w: t.w, h: t.h, col: 0, row: 0 };
    var slot = findFreeSlot(wd.w, wd.h, curPage().widgets, 0, 0);
    wd.col = slot.col; wd.row = slot.row;
    curPage().widgets.push(wd);
    curPage().widgets.sort(sortByPos);
    renderAll();
    enableDrag(wd);
    enableDel(wd);
  }

  /* ---- 拖拽 / 删除 / 点击进入 ---- */
  var dz = null, dragWd = null;
  function ensureDz() {
    if (!dz) {
      dz = document.createElement("div");
      dz.className = "drop-zone";
      curPage().canvas.appendChild(dz);
    }
    return dz;
  }
  function gridFromEvent(e) {
    var cRect = curPage().canvas.getBoundingClientRect();
    var x = e.clientX - cRect.left - PAD + GAP;
    var y = e.clientY - cRect.top - TOP + GAP;
    var col = Math.floor(x / (CELLW + GAP));
    var row = Math.floor(y / (CELLH + GAP));
    col = Math.max(0, Math.min(COLS - 1, col));
    row = Math.max(0, Math.min(MAXROW, row));
    return { col: col, row: row };
  }
  function showDz(col, row, w, h) {
    var d = ensureDz();
    d.style.left = (PAD + col * (CELLW + GAP)) + "px";
    d.style.top  = (TOP  + row * (CELLH + GAP)) + "px";
    d.style.width  = (w * CELLW + (w - 1) * GAP) + "px";
    d.style.height = (h * CELLH + (h - 1) * GAP) + "px";
  }
  function hideDz() { if (dz) { dz.remove(); dz = null; } }
  function enableDrag(wd) {
    var startX = 0, startY = 0, dragging = false;
    wd.el.addEventListener("pointerdown", function (e) {
      if (e.target.classList.contains("w-del")) return;
      startX = e.clientX; startY = e.clientY;
      if (!homeState.editing) return;
      dragging = true;
      wd.el.classList.add("dragging");
      if (wd.el.setPointerCapture) { try { wd.el.setPointerCapture(e.pointerId); } catch (err) {} }
      e.preventDefault();
    });
    wd.el.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var g = gridFromEvent(e);
      g.col = Math.max(0, Math.min(COLS - wd.w, g.col));
      showDz(g.col, g.row, wd.w, wd.h);
    });
    function end(e) {
      if (!dragging) {
        /* 非编辑模式：点击组件 → 进入对应功能页 */
        if (!homeState.editing && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 8) {
          openByType(wd.type);
        }
        return;
      }
      dragging = false;
      wd.el.classList.remove("dragging");
      hideDz();
      if (!homeState.editing) return;
      var g = gridFromEvent(e || { clientX: startX, clientY: startY });
      g.col = Math.max(0, Math.min(COLS - wd.w, g.col));
      placeWidget(wd, g.col, g.row);
    }
    wd.el.addEventListener("pointerup", end);
    wd.el.addEventListener("pointercancel", end);
  }
  function enableDel(wd) {
    var del = wd.el.querySelector(".w-del");
    if (!del) return;
    del.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    del.addEventListener("click", function (e) {
      if (!homeState.editing) return;
      e.stopPropagation();
      var idx = curPage().widgets.indexOf(wd);
      if (idx >= 0) curPage().widgets.splice(idx, 1);
      wd.el.remove();
    });
  }

  /* ---- 3 屏滑动 + 指示点 ---- */
  function setActive(i) {
    homeState.activeIdx = Math.max(0, Math.min(homeState.pages.length - 1, i));
    var dots = document.querySelectorAll("#page-dots i");
    for (var di = 0; di < dots.length; di++) dots[di].classList.toggle("on", di === homeState.activeIdx);
  }
  function bindHomeScroll() {
    var scroll = document.getElementById("home-scroll");
    if (!scroll) return;
    scroll.addEventListener("scroll", function () {
      var i = Math.round(scroll.scrollLeft / scroll.clientWidth);
      if (i !== homeState.activeIdx) setActive(i);
    });
    var dots = document.querySelectorAll("#page-dots i");
    for (var di = 0; di < dots.length; di++) {
      dots[di].addEventListener("click", (function (idx) {
        return function () { scroll.scrollTo({ left: idx * scroll.clientWidth, behavior: "smooth" }); };
      })(di));
    }
  }

  /* ---- 编辑模式 + 组件库 ---- */
  function toggleEditing() {
    var phone = document.getElementById("phone");
    homeState.editing = !homeState.editing;
    if (phone) phone.classList.toggle("editing", homeState.editing);
    var libPanel = document.getElementById("lib-panel");
    var libSearch = document.getElementById("lib-search");
    if (!homeState.editing) {
      if (libPanel) libPanel.classList.remove("open");
      if (libSearch) libSearch.blur();
    }
  }
  function renderLibrary(filter) {
    var libList = document.getElementById("lib-list");
    var libEmpty = document.getElementById("lib-empty");
    if (!libList || !libEmpty) return;
    filter = (filter || "").trim().toLowerCase();
    var groups = {};
    var count = 0;
    LIB_ITEMS.forEach(function (item) {
      if (filter && item.name.toLowerCase().indexOf(filter) === -1) return;
      if (!groups[item.letter]) groups[item.letter] = [];
      groups[item.letter].push(item);
      count++;
    });
    var html = "";
    Object.keys(groups).sort().forEach(function (letter) {
      html += '<div class="lib-group">' + letter + '</div>';
      groups[letter].forEach(function (item) {
        html += '<div class="lib-item" data-type="' + item.type + '">' +
          '<span class="plus">＋</span>' + item.name + '</div>';
      });
    });
    libList.innerHTML = html;
    libEmpty.style.display = count === 0 ? "block" : "none";
    libList.querySelectorAll(".lib-item").forEach(function (btn) {
      btn.addEventListener("pointerdown", function (e) { e.preventDefault(); });
      btn.addEventListener("click", function () {
        addWidget(btn.getAttribute("data-type"));
        toastMsg("已添加「" + libName(btn.getAttribute("data-type")) + "」组件");
      });
    });
  }
  function bindLib() {
    var dot = document.getElementById("edit-dot");
    var grip = document.getElementById("lib-grip");
    var libPanel = document.getElementById("lib-panel");
    var libClose = document.getElementById("lib-close");
    var libSearch = document.getElementById("lib-search");
    if (dot) dot.addEventListener("click", toggleEditing);
    if (libClose) libClose.addEventListener("click", function (e) {
      e.stopPropagation();
      libPanel.classList.remove("open");
      if (libSearch) libSearch.blur();
    });
    if (grip) {
      grip.addEventListener("click", function () {
        libPanel.classList.toggle("open");
        if (libPanel.classList.contains("open")) {
          setTimeout(function () { if (libSearch) libSearch.focus({ preventScroll: true }); }, 320);
        } else {
          if (libSearch) libSearch.blur();
        }
      });
      var dragY = null;
      grip.addEventListener("pointerdown", function (e) { dragY = e.clientY; });
      window.addEventListener("pointermove", function (e) {
        if (dragY === null) return;
        var dy = e.clientY - dragY;
        if (dy > 24 && !libPanel.classList.contains("open")) {
          libPanel.classList.add("open");
          dragY = null;
          setTimeout(function () { if (libSearch) libSearch.focus({ preventScroll: true }); }, 320);
        } else if (dy < -24 && libPanel.classList.contains("open")) {
          libPanel.classList.remove("open");
          dragY = null;
          if (libSearch) libSearch.blur();
        }
      });
      window.addEventListener("pointerup", function () { dragY = null; });
    }
    if (libSearch) {
      libSearch.addEventListener("input", function () { renderLibrary(libSearch.value); });
      libSearch.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { libSearch.value = ""; renderLibrary(""); }
        e.stopPropagation();
      });
    }
    if (libPanel) {
      libPanel.addEventListener("pointerdown", function (e) {
        var t = e.target;
        if (t === libPanel || t.classList.contains("lib-list") || t.classList.contains("lib-head")) {
          e.preventDefault();
        }
      });
    }
  }
  function toastMsg(msg) {
    try {
      var t = document.createElement("div");
      t.className = "mini-toast";
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 2000);
    } catch (e) {}
  }

  /* ---- 组件点击 → 真实功能 ---- */
  function openByType(type) {
    var name = libName(type);
    /* 已有真实页面钩子的核心模块 */
    if (type === "chat" || type === "contacts" || type === "companion" || type === "moments" ||
        type === "settings" || type === "me" || type === "phone" || type === "browser" || type === "files") {
      onAppTap(type);
      return;
    }
    if (type === "bg") {
      if (window.MineBackground) MineBackground.openManager();
      else toastMsg(name + "：背景模块未就绪");
      return;
    }
    if (type === "theme") {
      if (window.MineTheme && MineTheme.openThemePanel) MineTheme.openThemePanel();
      else toastMsg("主题切换：S9 接入");
      return;
    }
    /* 尚未迁移到独立页的模块：提示原入口（功能 100% 保留，UI 迁移见功能对照清单） */
    var pendingHint = {
      mail: "陪伴页 · 次元信箱", mailbox: "陪伴页 · 次元信箱", treehole: "陪伴页 · 深夜树洞",
      radio: "陪伴页 · 心情电台", food: "陪伴页 · 觅食",
      card: "个人中心 · 字卡管理", cards: "个人中心 · 字卡池", persona: "设置 · 字卡 · 联系人人设",
      mycards: "个人中心 · 我的字卡", allcards: "个人中心 · 全部字卡", probs: "个人中心 · 概率修改",
      export: "设置 · 文件 · 数据导出", quotes: "陪伴页 · 每日寄语", netease: "陪伴页 · 电台 · 网易云",
      weather: "桌面占位（天气模块）", cm: "通讯录 · 联系人主页 · 朋友圈",
      vinyl: "示例组件，S9 接电台黑胶", quote: "示例组件，S9 接每日寄语", album: "示例组件，S9 接记忆相册",
      daily: "示例组件，S9 接每日陪伴", breath: "示例组件，S9 接呼吸练习", memory: "示例组件，S9 接记忆相册",
      flame: "示例组件，S9 接静默炉火", heart: "示例组件，S9 接陪伴之心"
    };
    var hint = pendingHint[type];
    if (hint) { toastMsg("「" + name + "」功能已保留（原入口：" + hint + "），UI 迁移中"); return; }
    toastMsg(name);
  }

  /* ---------------- 渲染底部 Dock（UI v2） ---------------- */
  function dockCellHTML(app) {
    var badge = window.MineNotify ? MineNotify.badgeHTML(app.id) : "";
    return '<div class="di' + (app.id === "home" ? " on" : "") + '" role="button" tabindex="0" data-app="' + app.id + '">' +
      svgFor(app.icon) + badge +
      '<span>' + app.label + '</span></div>';
  }
  function setDockActive(id) {
    document.querySelectorAll(".dock .di").forEach(function (c) {
      c.classList.toggle("on", c.getAttribute("data-app") === id);
    });
  }
  function renderDock() {
    dom.dock = document.getElementById("dock");
    if (!dom.dock) return;
    dom.dock.innerHTML = DOCK.map(dockCellHTML).join("");
    document.querySelectorAll(".dock .di").forEach(function (cell) {
      cell.addEventListener("click", function () {
        setDockActive(cell.getAttribute("data-app"));
        onAppTap(cell.getAttribute("data-app"));
      });
      cell.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDockActive(cell.getAttribute("data-app")); onAppTap(cell.getAttribute("data-app")); }
      });
    });
  }

  /* ---------------- 应用点击 ---------------- */
  function onAppTap(appId) {
    if (appId === "home") { goHome(); return; }
    var app = findApp(appId);
    if (!app) { openByType(appId); return; }
    if (app.action === "background") {
      window.MineBackground.openManager();
      return;
    }
    if (window.MineNotify) MineNotify.markSeen(appId);
    if (typeof APP.page === "function" && APP.page(appId) === true) return;
    openPlaceholder(appId);
  }
  function findApp(id) {
    var all = APPS.concat(DOCK);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  /* ---------------- 详情占位页 ---------------- */
  function openPlaceholder(appId) {
    var info = PLACEHOLDER[appId] || { title: appId, icon: "eye", desc: "敬请期待。" };
    var navBar =
      '<div class="nav-bar">' +
        '<button class="nav-btn" data-act="back">' + window.MineIcons.svg("back", 20) + '返回</button>' +
        '<span class="nav-title">' + info.title + '</span>' +
        '<span class="nav-right"></span>' +
      '</div>';
    var desc = info.desc.replace(/\n/g, "<br>");
    var body =
      '<div class="scroll"><div class="empty-state">' +
        '<div class="empty-icon">' + window.MineIcons.svg(info.icon, 30) + '</div>' +
        '<div class="empty-title">' + info.title + '</div>' +
        '<div class="empty-desc">' + desc + '</div>' +
      '</div></div>';
    dom.detail = document.getElementById("page-detail");
    if (!dom.detail) return;
    dom.detail.innerHTML = navBar + body;
    dom.detail.querySelector('[data-act="back"]').addEventListener("click", goHome);
    switchPage("detail", appId);
  }
  function goHome() {
    /* 智能返回：有返回栈时等价于手机返回键，回到上一个界面 */
    if (backStack.length) {
      try { history.back(); return; } catch (e) {}
    }
    setDockActive("home");
    switchPage("home");
  }
  /* ---------------- 页面切换 + 返回栈 ----------------
     每次切换到不同界面：记录上一界面并 pushState；
     手机/浏览器返回键触发 popstate → 弹出栈并还原上一界面。
     UI v2：同时维护 .on（新 CSS）与 .is-active（旧 CSS 兼容）。 */
  var backStack = [];
  var current = { page: "home", appId: null };
  function pushHistory() { try { history.pushState({}, ""); } catch (e) {} }
  function switchPage(name, appId, noRecord) {
    if (!noRecord) {
      var key = name + ":" + (appId || "");
      var curKey = current.page + ":" + (current.appId || "");
      if (key !== curKey) {
        backStack.push({ page: current.page, appId: current.appId });
        if (backStack.length > 60) backStack.shift();
        pushHistory();
      }
    }
    current = { page: name, appId: appId || null };
    document.querySelectorAll(".page").forEach(function (p) {
      var active = p.getAttribute("data-page") === name;
      p.classList.toggle("on", active);
      p.classList.toggle("is-active", active);
    });
    /* 主页不占用 .page 容器：切回主页时隐藏全部 .page，显示桌面 */
    if (name === "home") {
      document.querySelectorAll(".page").forEach(function (p) {
        p.classList.remove("on");
        p.classList.remove("is-active");
      });
    }
  }
  /* 还原上一界面：detail 页需重新渲染对应应用内容 */
  function restoreEntry(entry) {
    if (entry.page === "detail") {
      if (entry.appId === "settings" && window.MineSettings) MineSettings.renderPage();
      else if (entry.appId === "me" && window.MineProfile) MineProfile.renderPage();
      else if (entry.appId === "phone" && window.MinePhone) MinePhone.renderPage();
      else if (entry.appId === "files" && window.MineFiles) MineFiles.renderPage();
      else if (entry.appId === "browser" && window.MineBrowser) MineBrowser.renderPage();
      else if (entry.appId) openPlaceholder(entry.appId);
      switchPage("detail", entry.appId || null, true);
      return;
    }
    switchPage(entry.page, entry.appId || null, true);
  }
  function goBack() {
    if (!backStack.length) { setDockActive("home"); switchPage("home"); return; }
    var entry = backStack.pop();
    restoreEntry(entry);
  }
  window.addEventListener("popstate", goBack);
  /* ---------------- 状态栏时钟 ---------------- */
  function updateClock() {
    var now = new Date();
    var h = now.getHours();
    var m = now.getMinutes();
    dom.time.textContent = (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  function updateGreeting() {
    var now = new Date();
    var week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
    var hello;
    var h = now.getHours();
    if (h < 6) hello = "深夜安";
    else if (h < 11) hello = "早安";
    else if (h < 14) hello = "午安";
    else if (h < 18) hello = "午后好";
    else if (h < 22) hello = "晚安";
    else hello = "夜深了";
    if (dom.hello) {
      var myName = "Mine";
      try {
        var raw = localStorage.getItem("mine.me.v1");
        if (raw) {
          var me = JSON.parse(raw);
          if (me && me.name) myName = me.name;
        }
      } catch (e) {}
      dom.hello.textContent = hello + "，" + myName;
    }
    if (dom.date) dom.date.textContent =
      (now.getMonth() + 1) + "月" + now.getDate() + "日 · " + week;
  }
  /* ---------------- 长按主屏呼出背景管理 ---------------- */
  function bindLongPress() {
    var timer = null;
    var grid = document.getElementById("home-scroll");
    if (!grid) return;
    function start(e) {
      if (homeState.editing) return;
      timer = setTimeout(function () {
        if (window.MineBackground) MineBackground.openManager();
        timer = null;
      }, 650);
    }
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    grid.addEventListener("touchstart", start, { passive: true });
    grid.addEventListener("touchend", cancel);
    grid.addEventListener("touchmove", cancel, { passive: true });
    grid.addEventListener("mousedown", start);
    grid.addEventListener("mouseup", cancel);
    grid.addEventListener("mouseleave", cancel);
    grid.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }
  /* ---------------- 初始化 ---------------- */
  function init() {
    dom.time = document.getElementById("status-time");
    dom.hello = document.getElementById("hello-text");
    dom.date = document.getElementById("date-text");
    /* 组件化桌面：3 屏 canvas */
    for (var pi = 0; pi < 3; pi++) {
      var canvas = document.getElementById("canvas-" + pi);
      homeState.pages.push({ canvas: canvas, widgets: [] });
    }
    /* 初始化第 1 屏组件（顺序添加 = 敲定版布局） */
    ["vinyl", "album", "quote", "chat", "phone", "contacts", "companion", "moments", "settings", "weather", "browser"].forEach(function (t) {
      addWidget(t);
    });
    renderAll();
    renderDock();
    bindHomeScroll();
    bindLib();
    updateClock();
    updateGreeting();
    bindLongPress();
    setInterval(updateClock, 20000);
    setInterval(updateGreeting, 60000);
    // 背景管理器初始化
    if (window.MineBackground) window.MineBackground.init();
    // 个人中心初始化
    if (window.MineProfile) window.MineProfile.init();
    // 字卡初始化（加载本地存储，供个人中心管理面板 / 导入导出使用）
    if (window.MineCards) window.MineCards.init();
    // 次元信箱初始化
    if (window.MineMail) window.MineMail.init();
      // 深夜树洞初始化（启动定期检查器，处理待回复问卷）
    if (window.MineTreeHole) window.MineTreeHole.init();
    // 电话模块初始化（启动联系人主动来电调度）
    if (window.MinePhone) window.MinePhone.init();
    // 统一语音条：全局事件委托（点击播放 / 暂停）
    if (window.MineVoiceBar && window.MineVoiceBar.initGlobal) {
      MineVoiceBar.initGlobal();
    }
    // ===== 注册 MineNotify provider =====
    if (window.MineNotify) {
      // chat provider 已在 chat.js 中注册
      // moments provider：基于时间戳统计新互动数
      if (window.MineMoments) {
        MineNotify.register("moments", function () {
          return MineMoments.getUnreadCount();
        });
      }
      // companion 聚合 provider：次元信箱 + 深夜树洞的未读总数
      // 不注册 onSeen 回调：用户打开陪伴页时不清除未读，
      // 角标保留到用户点进具体子应用（time-mailbox / night-whispers）才清除
      if (window.MineMail || window.MineTreeHole) {
        MineNotify.register("companion",
          function () {
            var count = 0;
            if (window.MineMail) count += MineMail.getUnreadCount();
            if (window.MineTreeHole) count += MineTreeHole.getUnreadCount();
            return count;
          }
        );
      }
      // 陪伴页子卡片单独 provider（卡片角标）
      if (window.MineMail) {
        MineNotify.register("time-mailbox",
          function () { return MineMail.getUnreadCount(); },
          function () { MineMail.clearUnread(); }
        );
      }
      if (window.MineTreeHole) {
        MineNotify.register("night-whispers",
          function () { return MineTreeHole.getUnreadCount(); },
          function () { MineTreeHole.clearUnread(); }
        );
      }
      // 初始刷新角标
      MineNotify.refreshBadges();
    }
    initUpdateNotify();
  }
  /* ---------------- 更新提醒（SW 受控更新） ----------------
     部署新版本（sw.js 内容变化）后，浏览器在下次打开/刷新页面时检测到
     新 SW 进入 waiting → 顶部弹"发现新版本"横幅：
     · 立即更新：向 SW 发 SKIP_WAITING → 接管 → controllerchange → 刷新
     · 稍后更新：关闭横幅；新版本保持等待，下次打开页面再提醒
     更新只替换缓存文件，聊天记录等本地数据（localStorage/IndexedDB）
     不受任何影响。 */
  function initUpdateNotify() {
    if (!("serviceWorker" in navigator)) return;
    var bannerShown = false;
    function showBanner(worker) {
      if (bannerShown) return;
      bannerShown = true;
      try {
        if (document.querySelector(".update-banner")) return;
      } catch (e) {}
      var el = document.createElement("div");
      el.className = "update-banner";
      el.innerHTML =
        '<div class="update-banner-text">发现新版本，更新后聊天记录等本地内容不受影响</div>' +
        '<div class="update-banner-actions">' +
          '<button class="update-banner-btn is-primary" id="update-now">立即更新</button>' +
          '<button class="update-banner-btn" id="update-later">稍后</button>' +
        '</div>';
      document.body.appendChild(el);
      el.querySelector("#update-now").addEventListener("click", function () {
        if (worker && worker.postMessage) {
          try { worker.postMessage({ type: "SKIP_WAITING" }); } catch (e) {}
        }
      });
      el.querySelector("#update-later").addEventListener("click", function () {
        el.remove();
      });
    }
    function trackInstalling(worker) {
      if (!worker) return;
      worker.addEventListener("statechange", function () {
        /* 新版本已下载完成；若有旧页面在运行（controller 存在）→ 提示更新 */
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          showBanner(worker);
        }
      });
    }
    window.addEventListener("load", function () {
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg.waiting) { showBanner(reg.waiting); return; }
        if (reg.installing) { trackInstalling(reg.installing); return; }
        reg.addEventListener("updatefound", function () {
          trackInstalling(reg.installing);
        });
      }).catch(function () {});
    });
    /* 新 SW 接管 → 刷新页面完成更新 */
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (bannerShown) location.reload();
    });
  }
  /* ---------------- 滚动保持渲染（防"操作后跳回顶部"） ----------------
     交互操作触发的全量重渲染会重建页面内容，导致滚动位置丢失、回到顶端。
     MineScroll.render(container, html, keepTop, bindFn) 在重渲染前保存滚动位置，
     渲染后恢复（内容高度变化时自动收敛到新最大值）：
       container  内容容器元素（pageEl / detail / body 等）
       html       新渲染内容
       keepTop    true = 同视图交互重渲染（保持滚动位置）；false = 视图切换（回到顶部）
       bindFn     渲染后的事件绑定函数（可选）
     滚动容器优先取 container 内 .scroll 元素，不存在则取 container 自身。 */
  window.MineScroll = (function () {
    "use strict";
    function scrollElOf(container) {
      if (!container || !container.querySelector) return container || null;
      var sc = container.querySelector(".scroll");
      return sc || container;
    }
    function saveTop(container) {
      var el = scrollElOf(container);
      return el ? (el.scrollTop || 0) : 0;
    }
    function restoreTop(container, saved) {
      if (!container || !saved) return;
      /* 延迟到当前同步渲染链完成后恢复：页面骨架先渲染、列表等内容随后由各模块
         局部填充（如 renderPendingList），立即恢复时 scrollHeight 尚小会被 clamp 到 0 */
      setTimeout(function () {
        var el = scrollElOf(container);
        if (!el) return;
        /* 强制同步布局，确保 scrollHeight 反映最终内容 */
        void el.offsetHeight;
        var max = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
        el.scrollTop = Math.min(saved, max);
      }, 0);
    }
    function render(container, html, keepTop, bindFn) {
      if (!container) return;
      var saved = keepTop ? saveTop(container) : 0;
      container.innerHTML = html;
      if (bindFn) { try { bindFn(); } catch (e) {} }
      if (keepTop && saved > 0) restoreTop(container, saved);
    }
    return { render: render };
  })();
  /* ---------------- 公共方法 ---------------- */
  APP.goHome = goHome;
  APP.switchPage = switchPage;
  APP.openPlaceholder = openPlaceholder;
  APP.refreshGreeting = updateGreeting;
  APP.goBack = goBack;
  APP.openByType = openByType;
  APP.toastMsg = toastMsg;
  APP.addDesktopWidget = addWidget;
   // 个人中心 / 电话页 / 文件管理 / 设置页 / 浏览器 页面钩子（链式：保存前一个 page handler）
  var prevPage = APP.page;
  APP.page = function (id) {
    if (id === "settings" && window.MineSettings) {
      MineSettings.renderPage();
      switchPage("detail", "settings");
      return true;
    }
    if (id === "me" && window.MineProfile) {
      MineProfile.renderPage();
      switchPage("detail", "me");
      return true;
    }
    if (id === "phone" && window.MinePhone) {
      MinePhone.renderPage();
      switchPage("detail", "phone");
      return true;
    }
    if (id === "files" && window.MineFiles) {
      MineFiles.renderPage();
      switchPage("detail", "files");
      return true;
    }
    if (id === "browser" && window.MineBrowser) {
      MineBrowser.renderPage();
      switchPage("detail", "browser");
      return true;
    }
    return prevPage ? prevPage(id) : false;
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
