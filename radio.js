/* ========================================================================
   Mine · 心情电台模块
   ------------------------------------------------------------------------
   功能：
   · 上传本地音乐（多选）
   · 添加音乐链接（粘贴音频直链，在线播放，不占用本地存储）
   · 播放 / 暂停 / 上一首 / 下一首 / 退出
   · 悬浮黑胶唱片（全界面可见，旋转动画）
   · 控制面板（点击唱片展开）
   · 歌曲列表持久化（IndexedDB，localStorage 兜底）
   接入：通过 MineCompanion.register("mood-radio") 注册。
   说明：网易云音乐 / QQ 音乐官方未开放第三方网页播放接口（扫码登录
   需自建非官方服务，不稳定且有版权风险），故本站采用"本地音乐 +
   音频直链"两种最简洁的接入方式。
   ======================================================================== */

window.MineRadio = (function () {
  "use strict";

  var I = window.MineIcons;
  var pageEl = null;

  var STORE_KEY = "mine.radio.v1";
  var MODE_KEY = "mine.radio.mode.v1";
  var songs = [];           // [{ id, name, dataUrl }]
  var currentIndex = -1;
  var isPlaying = false;
  var audioEl = null;
  var floatEl = null;
  var panelOpen = false;

  /* 播放模式：0=顺序播放, 1=乱序播放, 2=单曲循环 */
  var playMode = 0;
  var PLAY_MODES = [
    { icon: "listOrder", label: "顺序播放" },
    { icon: "shuffle",  label: "乱序播放" },
    { icon: "repeatOne",label: "单曲循环" }
  ];

  /* ---------------- IndexedDB 存储（替代 localStorage，支持大文件） ---------------- */
  var DB_NAME = "MineRadioDB";
  var DB_STORE = "songs";
  var DB_VERSION = 1;
  var db = null;
  var useDB = false;       // IndexedDB 是否可用
  var dbLoaded = false;    // 数据是否已从 DB 加载完成

  function initDB() {
    try {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function (e) {
        var database = e.target.result;
        if (!database.objectStoreNames.contains(DB_STORE)) {
          database.createObjectStore(DB_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = function (e) {
        db = e.target.result;
        useDB = true;
        loadFromDB();
      };
      request.onerror = function () {
        useDB = false;
        loadFromStorage();
      };
    } catch (e) {
      useDB = false;
      loadFromStorage();
    }
  }

  function loadFromDB() {
    if (!db) { loadFromStorage(); return; }
    try {
      var tx = db.transaction(DB_STORE, "readonly");
      var store = tx.objectStore(DB_STORE);
      var req = store.getAll();
      req.onsuccess = function () {
        var dbSongs = req.result || [];
        /* 迁移 localStorage 旧数据 */
        try {
          var raw = localStorage.getItem(STORE_KEY);
          if (raw) {
            var lsSongs = JSON.parse(raw);
            if (lsSongs && lsSongs.length > dbSongs.length) {
              songs = lsSongs;
              songs.forEach(function (s) { saveSongToDB(s); });
              try { localStorage.removeItem(STORE_KEY); } catch (e2) {}
            } else {
              songs = dbSongs;
            }
          } else {
            songs = dbSongs;
          }
        } catch (e) {
          songs = dbSongs;
        }
        dbLoaded = true;
        afterLoad();
      };
      req.onerror = function () { loadFromStorage(); };
    } catch (e) { loadFromStorage(); }
  }

  function loadFromStorage() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) songs = JSON.parse(raw) || [];
    } catch (e) {}
    if (!songs) songs = [];
    dbLoaded = true;
    afterLoad();
  }

  /* 数据加载完成后的回调：如果页面已渲染，刷新列表 */
  function afterLoad() {
    if (pageEl && pageEl.innerHTML.indexOf("radio-hero") >= 0) {
      pageEl.innerHTML = viewRadio();
      bindRadio();
    }
  }

  function saveSongToDB(song, callback) {
    if (!db) { if (callback) callback(); return; }
    try {
      var tx = db.transaction(DB_STORE, "readwrite");
      var store = tx.objectStore(DB_STORE);
      var req = store.put(song);
      req.onsuccess = function () { if (callback) callback(); };
      req.onerror = function () { if (callback) callback(); };
    } catch (e) { if (callback) callback(); }
  }

  function deleteSongFromDB(id, callback) {
    if (!db) { if (callback) callback(); return; }
    try {
      var tx = db.transaction(DB_STORE, "readwrite");
      var store = tx.objectStore(DB_STORE);
      var req = store.delete(id);
      req.onsuccess = function () { if (callback) callback(); };
      req.onerror = function () { if (callback) callback(); };
    } catch (e) { if (callback) callback(); }
  }

  /* 播放模式仍用 localStorage（数据量极小） */
  function loadMode() {
    try {
      var rawMode = localStorage.getItem(MODE_KEY);
      if (rawMode !== null) playMode = parseInt(rawMode, 10) || 0;
    } catch (e) {}
  }
  function saveMode() {
    try { localStorage.setItem(MODE_KEY, String(playMode)); } catch (e) {}
  }

  /* localStorage 兜底保存（仅在 IndexedDB 不可用时使用） */
  function saveToStorage() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(songs));
    } catch (e) {
      showToast("存储空间不足，请删除部分歌曲");
    }
  }

  /* ---------------- 工具 ---------------- */
  function uid() { return "song_" + Date.now() + "_" + Math.floor(Math.random() * 1000); }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatTime(sec) {
    if (!sec || isNaN(sec)) return "0:00";
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ---------------- 初始化音频元素 ---------------- */
  function initAudio() {
    audioEl = new Audio();
    audioEl.addEventListener("ended", function () { onSongEnded(); });
    audioEl.addEventListener("timeupdate", function () { updateProgress(); });
    audioEl.addEventListener("loadedmetadata", function () {
      updateProgress();
      updateTrackInfo();
    });
    audioEl.addEventListener("play", function () {
      isPlaying = true;
      updateVinyl();
      updatePlayButton();
    });
    audioEl.addEventListener("pause", function () {
      isPlaying = false;
      updateVinyl();
      updatePlayButton();
    });
  }

  /* ---------------- 初始化悬浮唱片 ---------------- */
  function initFloat() {
    floatEl = document.createElement("div");
    floatEl.className = "radio-float";
    floatEl.style.display = "none";
    floatEl.innerHTML =
      '<div class="radio-panel" id="radio-panel">' +
        '<div class="radio-panel-header">' +
          '<div class="radio-panel-track" id="radio-track-name">--</div>' +
          '<button class="radio-ctrl is-mode" id="radio-mode" title="播放模式">' + I.svg("listOrder", 16) + '</button>' +
        '</div>' +
        '<div class="radio-panel-progress">' +
          '<span class="radio-panel-current" id="radio-current">0:00</span>' +
          '<div class="radio-progress-bar" id="radio-progress-bar">' +
            '<div class="radio-progress-fill" id="radio-progress-fill"></div>' +
          '</div>' +
          '<span class="radio-panel-total" id="radio-total">0:00</span>' +
        '</div>' +
        '<div class="radio-panel-controls">' +
          '<button class="radio-ctrl" id="radio-prev">' + I.svg("skipBack", 18) + '</button>' +
          '<button class="radio-ctrl is-main" id="radio-play">' + I.svg("play", 20) + '</button>' +
          '<button class="radio-ctrl" id="radio-next">' + I.svg("skipForward", 18) + '</button>' +
          '<button class="radio-ctrl is-exit" id="radio-exit" title="退出播放">' + I.svg("power", 14) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="radio-vinyl" id="radio-vinyl">' +
        '<div class="radio-vinyl-center"></div>' +
      '</div>';
    document.body.appendChild(floatEl);

    /* 唱片点击 → 展开/收起控制面板 */
    floatEl.querySelector("#radio-vinyl").addEventListener("click", function () {
      togglePanel();
    });

    /* 控制按钮 */
    floatEl.querySelector("#radio-play").addEventListener("click", function (e) {
      e.stopPropagation();
      togglePlay();
    });
    floatEl.querySelector("#radio-prev").addEventListener("click", function (e) {
      e.stopPropagation();
      playPrev();
    });
    floatEl.querySelector("#radio-next").addEventListener("click", function (e) {
      e.stopPropagation();
      playNext();
    });
    floatEl.querySelector("#radio-exit").addEventListener("click", function (e) {
      e.stopPropagation();
      exitPlayer();
    });

    /* 播放模式切换 */
    floatEl.querySelector("#radio-mode").addEventListener("click", function (e) {
      e.stopPropagation();
      cyclePlayMode();
    });

    /* 进度条点击 → 跳转 */
    floatEl.querySelector("#radio-progress-bar").addEventListener("click", function (e) {
      e.stopPropagation();
      var rect = this.getBoundingClientRect();
      var pct = (e.clientX - rect.left) / rect.width;
      if (audioEl && audioEl.duration) {
        audioEl.currentTime = pct * audioEl.duration;
      }
    });
  }

  /* ---------------- 悬浮唱片显隐 ---------------- */
  function showFloat() {
    if (floatEl) floatEl.style.display = "";
  }
  function hideFloat() {
    if (!floatEl) return;
    floatEl.style.display = "none";
    var panel = floatEl.querySelector("#radio-panel");
    if (panel) panel.classList.remove("is-show");
    panelOpen = false;
  }

  /* ---------------- 控制面板展开/收起 ---------------- */
  function togglePanel() {
    panelOpen = !panelOpen;
    var panel = floatEl.querySelector("#radio-panel");
    if (panel) panel.classList.toggle("is-show", panelOpen);
  }

  /* ---------------- 黑胶唱片旋转动画 ---------------- */
  function updateVinyl() {
    var vinyl = floatEl.querySelector("#radio-vinyl");
    if (!vinyl) return;
    if (isPlaying) {
      vinyl.classList.add("is-spinning");
      vinyl.classList.remove("is-paused");
    } else {
      vinyl.classList.add("is-paused");
    }
  }

  /* ---------------- 播放/暂停按钮图标 ---------------- */
  function updatePlayButton() {
    var btn = floatEl.querySelector("#radio-play");
    if (!btn) return;
    btn.innerHTML = isPlaying ? I.svg("pause", 20) : I.svg("play", 20);
  }

  /* ---------------- 更新曲目信息 ---------------- */
  function updateTrackInfo() {
    var nameEl = floatEl.querySelector("#radio-track-name");
    var totalEl = floatEl.querySelector("#radio-total");
    if (nameEl) {
      var name = (currentIndex >= 0 && songs[currentIndex]) ? songs[currentIndex].name : "--";
      nameEl.textContent = name;
    }
    if (totalEl) {
      totalEl.textContent = audioEl ? formatTime(audioEl.duration) : "0:00";
    }
  }

  /* ---------------- 更新进度条 ---------------- */
  function updateProgress() {
    if (!audioEl) return;
    var fill = floatEl.querySelector("#radio-progress-fill");
    var currentEl = floatEl.querySelector("#radio-current");
    var pct = 0;
    if (audioEl.duration > 0) {
      pct = (audioEl.currentTime / audioEl.duration) * 100;
    }
    if (fill) fill.style.width = pct + "%";
    if (currentEl) currentEl.textContent = formatTime(audioEl.currentTime);
  }

  /* ---------------- 更新列表高亮 ---------------- */
  function updateListHighlight() {
    if (!pageEl) return;
    pageEl.querySelectorAll(".radio-item").forEach(function (item, i) {
      item.classList.toggle("is-playing", i === currentIndex);
    });
  }

  /* ---------------- 播放控制 ---------------- */
  function playSong(index) {
    if (index < 0 || index >= songs.length) return;
    currentIndex = index;
    var song = songs[index];
    /* 兼容两种来源：本地上传存 dataUrl，链接添加存 url */
    audioEl.src = song.dataUrl || song.url;
    audioEl.play().catch(function () {});
    showFloat();
    updateVinyl();
    updatePlayButton();
    updateTrackInfo();
    updateListHighlight();
  }

  function togglePlay() {
    if (currentIndex < 0) {
      if (songs.length > 0) playSong(0);
      return;
    }
    if (isPlaying) {
      audioEl.pause();
    } else {
      audioEl.play().catch(function () {});
    }
  }

  /* ---------------- 播放模式切换 ---------------- */
  function cyclePlayMode() {
    playMode = (playMode + 1) % PLAY_MODES.length;
    saveMode();
    updatePlayModeButton();
    showToast(PLAY_MODES[playMode].label);
  }
  function updatePlayModeButton() {
    var btn = floatEl.querySelector("#radio-mode");
    if (!btn) return;
    btn.innerHTML = I.svg(PLAY_MODES[playMode].icon, 16);
    btn.title = PLAY_MODES[playMode].label;
  }

  /* ---------------- 自动播放下一首（根据播放模式） ---------------- */
  function onSongEnded() {
    if (playMode === 2) {
      /* 单曲循环：重新播放当前歌曲 */
      audioEl.currentTime = 0;
      audioEl.play().catch(function () {});
    } else {
      playNext();
    }
  }

  function playNext() {
    if (songs.length === 0) return;
    if (playMode === 1) {
      /* 乱序播放：随机选一首（尽量不选当前） */
      if (songs.length === 1) { playSong(0); return; }
      var rand;
      do { rand = Math.floor(Math.random() * songs.length); }
      while (rand === currentIndex);
      playSong(rand);
    } else {
      /* 顺序播放 */
      playSong((currentIndex + 1) % songs.length);
    }
  }

  function playPrev() {
    if (songs.length === 0) return;
    var prev = (currentIndex - 1 + songs.length) % songs.length;
    playSong(prev);
  }

  function exitPlayer() {
    if (audioEl) {
      audioEl.pause();
      audioEl.src = "";
    }
    isPlaying = false;
    currentIndex = -1;
    hideFloat();
    updateListHighlight();
  }

  /* ---------------- 上传歌曲 ---------------- */
  function addSongs(files) {
    var audioFiles = Array.prototype.filter.call(files, function (f) {
      return f.type.startsWith("audio/");
    });
    if (audioFiles.length === 0) {
      showToast("请选择音频文件");
      return;
    }
    var added = 0;
    var total = audioFiles.length;
    audioFiles.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var dataUrl = e.target.result;
        var name = file.name.replace(/\.[^.]+$/, "");
        var song = { id: uid(), name: name, dataUrl: dataUrl };
        songs.push(song);
        /* 持久化：优先 IndexedDB，不可用时回退 localStorage */
        if (useDB) {
          saveSongToDB(song);
        }
        added++;
        if (added === total) {
          if (!useDB) saveToStorage();
          if (pageEl) {
            pageEl.innerHTML = viewRadio();
            bindRadio();
          }
          showToast("已添加 " + added + " 首歌曲");
        }
      };
      reader.onerror = function () {
        added++;
        if (added === total) {
          if (!useDB) saveToStorage();
          if (pageEl) {
            pageEl.innerHTML = viewRadio();
            bindRadio();
          }
        }
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------------- 添加音乐链接（音频直链） ----------------
     在线播放不占用本地存储；仅接受 http(s) 直链。
     网易云 / QQ 音乐官方未开放网页播放接口，扫码登录暂不可用，
     故采用直链这一最简洁稳定的接入方式。 */
  function addSongByUrl(url, name) {
    var v = String(url || "").trim();
    if (!/^https?:\/\//i.test(v)) {
      showToast("请输入以 http:// 或 https:// 开头的音频链接");
      return false;
    }
    var n = String(name || "").trim();
    if (!n) {
      var parts = v.split("/");
      var last = decodeURIComponent(parts[parts.length - 1] || "");
      n = last.replace(/\.[^.]+$/, "") || "网络音乐";
    }
    var song = { id: uid(), name: n, url: v, type: "url" };
    songs.push(song);
    if (useDB) saveSongToDB(song);
    else saveToStorage();
    if (pageEl) {
      pageEl.innerHTML = viewRadio();
      bindRadio();
    }
    showToast("已添加《" + n + "》");
    return true;
  }

  /* ---------------- 删除歌曲 ---------------- */
  function removeSong(id) {
    var idx = -1;
    for (var i = 0; i < songs.length; i++) {
      if (songs[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return;
    if (idx === currentIndex) {
      exitPlayer();
    } else if (idx < currentIndex) {
      currentIndex--;
    }
    songs.splice(idx, 1);
    /* 持久化删除 */
    if (useDB) {
      deleteSongFromDB(id);
    } else {
      saveToStorage();
    }
    if (pageEl) {
      pageEl.innerHTML = viewRadio();
      bindRadio();
    }
    showToast("已删除");
  }

  /* ---------------- Toast ---------------- */
  var toastTimer = null;
  function showToast(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    var existing = document.querySelector(".radio-toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "radio-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add("is-show"); });
    toastTimer = setTimeout(function () {
      toast.classList.remove("is-show");
      setTimeout(function () { toast.remove(); }, 300);
    }, 1800);
  }

  /* ========================================================================
     渲染：电台页面
     ======================================================================== */
  function viewRadio() {
    var html = '';

    // 导航栏
    html += '<div class="nav-bar">' +
      '<button class="nav-btn" data-act="back">' + I.svg("back", 20) + '返回</button>' +
      '<span class="nav-title">心情电台</span>' +
      '<span class="nav-right"></span>' +
      '</div>';

    html += '<div class="scroll">';

    // 顶部
    html += '<div class="radio-hero">';
    html += '<div class="radio-hero-icon">' + I.svg("music", 28) + '</div>';
    html += '<div class="radio-hero-title">心情电台</div>';
    html += '<div class="radio-hero-sub">依心绪而生的旋律</div>';
    html += '</div>';

    // 上传区
    html += '<div class="radio-upload-zone" id="radio-upload-zone">';
    html += I.svg("upload", 24);
    html += '<div class="radio-upload-text">点击上传本地音乐</div>';
    html += '<div class="radio-upload-hint">支持 MP3 / WAV / M4A 等格式</div>';
    html += '<input type="file" id="radio-file-input" accept="audio/*" multiple style="display:none">';
    html += '</div>';

    // 添加音乐链接区（在线播放，不占用本地存储）
    html += '<div class="radio-url-row">';
    html += '<input class="radio-url-input" id="radio-url-input" ' +
      'placeholder="粘贴音频链接（mp3 / m4a / flac 直链）" inputmode="url">';
    html += '<button class="radio-url-add" id="radio-url-add">添加</button>';
    html += '</div>';
    html += '<div class="radio-url-hint">网易云 / QQ 音乐官方未开放网页播放接口，粘贴音频直链即可全界面播放；也可用下方网易云音乐扫码登录。</div>';

    // 网易云音乐接入区（netease.js 渲染：扫码登录 / 我的歌单 / 搜索）
    html += '<div class="radio-netease" id="radio-netease"></div>';

    // 歌曲列表
    html += '<div class="radio-list">';
    if (songs.length === 0) {
      html += '<div class="radio-empty">还没有歌曲，上传一首开始聆听吧</div>';
    } else {
      html += '<div class="radio-list-label">播放列表 · ' + songs.length + ' 首</div>';
      songs.forEach(function (song, i) {
        var playing = (i === currentIndex) ? ' is-playing' : '';
        var tag = (song.type === "url")
          ? '<span class="radio-item-tag is-url">链接</span>'
          : '<span class="radio-item-tag">本地</span>';
        html += '<div class="radio-item' + playing + '" data-index="' + i + '">';
        html += '<div class="radio-item-num">' + (i + 1) + '</div>';
        html += '<div class="radio-item-info">';
        html += '<div class="radio-item-name">' + escapeHtml(song.name) + tag + '</div>';
        html += '<div class="radio-item-dur">点击播放</div>';
        html += '</div>';
        html += '<div class="radio-item-del" data-del-index="' + i + '">' + I.svg("trash", 14) + '</div>';
        html += '</div>';
      });
    }
    html += '</div>';

    html += '</div>'; // .scroll
    return html;
  }

  /* ========================================================================
     绑定交互
     ======================================================================== */
  function bindRadio() {
    if (!pageEl) return;

    // 返回按钮
    var backBtn = pageEl.querySelector('[data-act="back"]');
    if (backBtn) {
      backBtn.addEventListener("click", function () {
        if (window.MineCompanion) MineCompanion.open();
      });
    }

    // 上传区
    var uploadZone = pageEl.querySelector("#radio-upload-zone");
    var fileInput = pageEl.querySelector("#radio-file-input");
    if (uploadZone && fileInput) {
      uploadZone.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        if (this.files && this.files.length > 0) {
          addSongs(this.files);
          this.value = "";
        }
      });
    }

    // 添加音乐链接
    var urlInput = pageEl.querySelector("#radio-url-input");
    var urlAdd = pageEl.querySelector("#radio-url-add");
    if (urlInput && urlAdd) {
      var doAddUrl = function () {
        if (addSongByUrl(urlInput.value)) urlInput.value = "";
      };
      urlAdd.addEventListener("click", doAddUrl);
      urlInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doAddUrl(); }
      });
    }

    // 网易云音乐区：挂载 netease.js 面板；播放回调 = 加入电台列表并播放
    var neContainer = pageEl.querySelector("#radio-netease");
    if (neContainer && window.MineNetease) {
      MineNetease.mount(neContainer, function (url, name) {
        if (addSongByUrl(url, name)) {
          playSong(songs.length - 1);
        }
      });
    }

    // 歌曲项点击
    pageEl.querySelectorAll(".radio-item").forEach(function (item) {
      item.addEventListener("click", function (e) {
        var delBtn = e.target.closest(".radio-item-del");
        if (delBtn) {
          e.stopPropagation();
          var delIdx = parseInt(delBtn.getAttribute("data-del-index"), 10);
          if (songs[delIdx]) removeSong(songs[delIdx].id);
          return;
        }
        var index = parseInt(item.getAttribute("data-index"), 10);
        playSong(index);
      });
    });
  }

  /* ========================================================================
     对外接口
     ======================================================================== */
  function open() {
    if (!pageEl) pageEl = document.getElementById("page-companion");
    if (!pageEl) return;
    pageEl.innerHTML = viewRadio();
    bindRadio();
    if (window.MineApp && MineApp.switchPage) MineApp.switchPage("companion");
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    loadMode();
    initAudio();
    initFloat();
    updatePlayModeButton();
    pageEl = document.getElementById("page-companion");
    /* 异步加载歌曲数据（IndexedDB 优先，localStorage 兜底） */
    initDB();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    open: open,
    addSongs: addSongs,
    addSongByUrl: addSongByUrl,
    playSong: playSong,
    togglePlay: togglePlay,
    playNext: playNext,
    playPrev: playPrev,
    exitPlayer: exitPlayer,
    cyclePlayMode: cyclePlayMode
  };
})();
