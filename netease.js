/* ========================================================================
   Mine · 网易云音乐接入（v1）
   ------------------------------------------------------------------------
   原理：网易云官方不开放网页播放接口，但开源项目 NeteaseCloudMusicApi
   （Binaryify）支持完整接口（二维码登录 / 我的歌单 / 搜索 / 播放地址），
   可免费一键部署到 Vercel（fork → vercel.com 导入 → Deploy，约 10 分钟）。
   本模块通过用户填写的 API 地址完成：
   · 扫码登录（/login/qr/key → /login/qr/create → 轮询 /login/qr/check）
   · 我的歌单（/user/playlist）+ 歌单歌曲（/playlist/track/all）
   · 搜索（/search）+ 获取播放地址（/song/url，带登录态可播 VIP 曲目）
   播放：取到直链后交给心情电台播放器（全界面悬浮黑胶），不重复造轮子。
   说明：非官方接口属个人学习用途，网易可能随时调整接口导致暂时失效；
   公共演示实例不稳定，建议使用自己 Vercel 部署的 API 地址。
   ======================================================================== */

window.MineNetease = (function () {
  "use strict";

  var STORE_KEY = "mine.netease.v1";

  var state = {
    api: "",        // API 服务地址
    cookie: "",     // 登录凭证
    uid: "",
    nickname: "",
    avatarUrl: ""
  };

  var container = null;   // 面板容器
  var onPlay = null;      // 播放回调 (url, name)
  var qrTimer = null;     // 扫码轮询定时器
  var songCache = {};     // sid → { name, artist }（播放时回传歌名）

  /* ---------------- 持久化 ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) state = JSON.parse(raw) || state;
    } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ---------------- 工具 ---------------- */
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  /* 独立 toast：不依赖 MineRadio/MineUtils（此前两处 API 不存在导致
     所有提示静默失效，点击"没反应"的根因）——内联样式保证任何主题可见 */
  var toastTimer = null;
  function toast(msg) {
    try {
      var el = document.querySelector(".netease-toast");
      if (!el) {
        el = document.createElement("div");
        el.className = "netease-toast";
        el.style.cssText = "position:fixed;left:50%;bottom:100px;transform:translateX(-50%);" +
          "z-index:99999;padding:10px 16px;border-radius:999px;background:rgba(17,17,17,0.92);" +
          "color:#fff;font-size:13px;line-height:1.5;max-width:82%;" +
          "box-shadow:0 4px 16px rgba(0,0,0,0.3);transition:opacity .25s;pointer-events:none;opacity:0;";
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.opacity = "1";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { el.style.opacity = "0"; }, 2600);
    } catch (e) {}
  }
  function apiUrl() {
    return String(state.api || "").trim().replace(/\/+$/, "");
  }
  function cookieParam() {
    return state.cookie ? "&cookie=" + encodeURIComponent(state.cookie) : "";
  }
  function jget(path) {
    var base = apiUrl();
    if (!base) return Promise.reject(new Error("no-api"));
    var url = base + path + (path.indexOf("?") >= 0 ? "&" : "?") + "timestamp=" + Date.now();
    /* 8 秒超时：避免手机网络连不上 API 时"点了没反应"（请求挂起无反馈） */
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("timeout")); }, 8000);
      fetch(url).then(function (r) {
        clearTimeout(timer);
        return r.json();
      }).then(function (d) { resolve(d); }, function (e) {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /* ---------------- 面板渲染 ---------------- */
  function render() {
    if (!container) return;
    var base = apiUrl();
    var html = "";

    html += '<div class="radio-netease-head">' +
      '<span class="radio-netease-title">' + (state.nickname ? "网易云 · " + escapeHtml(state.nickname) : "网易云音乐") + '</span>' +
      (state.nickname
        ? '<button class="radio-netease-btn" id="netease-logout">退出</button>'
        : '<button class="radio-netease-btn is-primary" id="netease-login">扫码登录</button>') +
      '</div>';

    /* API 地址 */
    html += '<div class="radio-netease-api">' +
      '<input class="radio-url-input" id="netease-api-input" placeholder="NeteaseCloudMusicApi 地址，如 https://xxx.vercel.app"' +
      ' value="' + escapeHtml(state.api) + '">' +
      '<button class="radio-url-add" id="netease-api-save">保存</button>' +
      '</div>';

    /* 未填 API → 提示部署 */
    if (!base) {
      html += '<div class="radio-netease-hint">先部署自己的网易云 API（免费、国内可访问）：<br>' +
        '① 打开 <b>dash.cloudflare.com</b>（邮箱注册）→ Workers & Pages → 创建 Worker<br>' +
        '② 把 <b>mine-netease-worker.js</b> 全部内容粘贴进代码编辑器 → 保存并部署<br>' +
        '③ 复制 https://xxx.workers.dev 地址填到上方并保存，即可扫码登录。' +
        '</div>';
      container.innerHTML = html;
      bind(container);
      return;
    }

    /* 未登录 → 展示登录区 */
    if (!state.cookie) {
      html += '<div class="radio-netease-hint">扫码登录后可播放你的歌单与 VIP 曲目（网易云 App 扫码）。</div>';
      container.innerHTML = html;
      bind(container);
      return;
    }

    /* 已登录 → 歌单 + 搜索 */
    html += '<div class="radio-netease-section" id="netease-playlists"></div>';
    html += '<div class="radio-netease-section">' +
      '<div class="radio-netease-search">' +
      '<input class="radio-url-input" id="netease-search-input" placeholder="搜索歌曲 / 歌手">' +
      '<button class="radio-url-add" id="netease-search-btn">搜索</button>' +
      '</div>' +
      '<div class="radio-netease-results" id="netease-results"></div>' +
      '</div>';

    container.innerHTML = html;
    bind(container);
    loadPlaylists();
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind(root) {
    var loginBtn = root.querySelector("#netease-login");
    if (loginBtn) loginBtn.addEventListener("click", startQrLogin);

    var logoutBtn = root.querySelector("#netease-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", function () {
      state.cookie = ""; state.uid = ""; state.nickname = ""; state.avatarUrl = "";
      save(); render(); toast("已退出登录");
    });

    var apiInput = root.querySelector("#netease-api-input");
    var apiSave = root.querySelector("#netease-api-save");
    if (apiInput && apiSave) {
      var doSave = function () {
        state.api = apiInput.value.trim();
        save(); render(); toast("API 地址已保存");
      };
      apiSave.addEventListener("click", doSave);
      apiInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doSave(); }
      });
    }

    var searchBtn = root.querySelector("#netease-search-btn");
    var searchInput = root.querySelector("#netease-search-input");
    if (searchBtn && searchInput) {
      var doSearch = function () {
        var kw = searchInput.value.trim();
        if (!kw) return;
        search(kw);
      };
      searchBtn.addEventListener("click", doSearch);
      searchInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doSearch(); }
      });
    }
  }

  /* ---------------- 扫码登录 ---------------- */
  function startQrLogin() {
    if (!apiUrl()) { toast("请先填写并保存 API 地址"); return; }
    toast("正在获取登录二维码…");
    jget("/login/qr/key").then(function (d) {
      if (!d || !d.data || !d.data.unikey) { toast("获取二维码失败，请检查 API 地址"); return; }
      var key = d.data.unikey;
      return jget("/login/qr/create?key=" + key + "&qrimg=true").then(function (cd) {
        if (!cd || !cd.data || !cd.data.qrimg) { toast("二维码生成失败"); return; }
        showQr(cd.data.qrimg, key);
      });
    }).catch(function (e) {
      if (e && e.message === "timeout") toast("连接超时：当前网络无法访问 API，请检查地址或更换网络");
      else toast("API 连接失败，请检查地址与网络");
    });
  }

  function showQr(qrimg, key) {
    /* 二维码弹层 */
    var overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.addEventListener("click", function () { stopQr(); overlay.remove(); });

    var panel = document.createElement("div");
    panel.className = "sheet scope-picker";
    panel.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-head"><h2>扫码登录</h2>' +
      '<button class="nav-btn" data-act="cancel">' + window.MineIcons.svg("close", 20) + '</button></div>' +
      '<div class="sheet-body netease-qr-body">' +
        '<img class="netease-qr-img" src="' + qrimg + '" alt="登录二维码">' +
        '<div class="netease-qr-status" id="netease-qr-status">请使用网易云音乐 App 扫码</div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    requestAnimationFrame(function () {
      overlay.classList.add("is-open");
      panel.classList.add("is-open");
    });

    panel.querySelector('[data-act="cancel"]').addEventListener("click", function () {
      stopQr(); overlay.remove(); panel.remove();
    });

    /* 轮询扫码状态：800 待扫 / 801 已扫待确认 / 802 过期 / 803 成功 */
    var statusEl = panel.querySelector("#netease-qr-status");
    var attempts = 0;
    stopQr();
    qrTimer = setInterval(function () {
      attempts++;
      jget("/login/qr/check?key=" + key).then(function (d) {
        if (!d) return;
        if (d.code === 800) {
          statusEl.textContent = "请使用网易云音乐 App 扫码";
        } else if (d.code === 801) {
          statusEl.textContent = "已扫码，请在手机上确认登录";
        } else if (d.code === 802) {
          statusEl.textContent = "二维码已过期，请重新获取";
          stopQr();
        } else if (d.code === 803 && d.cookie) {
          stopQr();
          state.cookie = d.cookie;
          if (d.profile) {
            state.uid = String(d.profile.userId || d.profile.id || "");
            state.nickname = d.profile.nickname || "";
            state.avatarUrl = d.profile.avatarUrl || "";
          }
          save();
          overlay.remove(); panel.remove();
          render();
          toast("登录成功：" + (state.nickname || "网易云用户"));
        }
      }).catch(function () {});
      if (attempts > 45) { stopQr(); statusEl.textContent = "超时未扫码，请关闭重试"; }
    }, 2000);
  }
  function stopQr() {
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  }

  /* ---------------- 我的歌单 ---------------- */
  function loadPlaylists() {
    var box = container.querySelector("#netease-playlists");
    if (!box) return;
    if (!state.uid) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="radio-netease-sub">我的歌单</div>';
    jget("/user/playlist?uid=" + encodeURIComponent(state.uid) + "&limit=50" + cookieParam())
      .then(function (d) {
        var list = (d && d.playlist) || [];
        if (!list.length) { box.innerHTML = '<div class="radio-netease-sub">我的歌单</div><div class="radio-netease-empty">暂无歌单</div>'; return; }
        var html = '<div class="radio-netease-sub">我的歌单</div><div class="netease-playlist-grid">';
        list.forEach(function (pl) {
          html += '<div class="netease-playlist" data-plid="' + pl.id + '">' +
            '<img class="netease-playlist-cover" src="' + escapeHtml(pl.coverImgUrl || "") + '" alt="" loading="lazy">' +
            '<div class="netease-playlist-name">' + escapeHtml(pl.name) + '</div>' +
            '<div class="netease-playlist-count">' + (pl.trackCount || 0) + ' 首</div>' +
            '</div>';
        });
        html += '</div>';
        box.innerHTML = html;
        box.querySelectorAll(".netease-playlist").forEach(function (item) {
          item.addEventListener("click", function () {
            openPlaylist(item.getAttribute("data-plid"));
          });
        });
      })
      .catch(function () { box.innerHTML = '<div class="radio-netease-sub">我的歌单</div><div class="radio-netease-empty">加载失败，请检查 API 地址</div>'; });
  }

  /* ---------------- 歌单歌曲 ---------------- */
  function openPlaylist(plid) {
    if (!plid) return;
    var results = container.querySelector("#netease-results");
    if (results) {
      results.innerHTML = '<div class="radio-netease-sub">歌单加载中…</div>';
    }
    jget("/playlist/track/all?id=" + plid + "&limit=100" + cookieParam())
      .then(function (d) {
        var songs = (d && d.songs) || [];
        if (!results) return;
        if (!songs.length) { results.innerHTML = '<div class="radio-netease-empty">歌单为空</div>'; return; }
        results.innerHTML = '<div class="radio-netease-sub">歌单 · ' + songs.length + ' 首（点击播放，自动加入电台）</div>' +
          renderSongList(songs);
        bindSongList(results);
      })
      .catch(function () { if (results) results.innerHTML = '<div class="radio-netease-empty">加载失败</div>'; });
  }

  /* ---------------- 搜索 ---------------- */
  function search(kw) {
    var results = container.querySelector("#netease-results");
    if (!results) return;
    results.innerHTML = '<div class="radio-netease-sub">搜索中…</div>';
    jget("/search?keywords=" + encodeURIComponent(kw) + "&type=1&limit=20" + cookieParam())
      .then(function (d) {
        var songs = (d && d.result && d.result.songs) || [];
        if (!songs.length) { results.innerHTML = '<div class="radio-netease-empty">没有找到相关歌曲</div>'; return; }
        results.innerHTML = '<div class="radio-netease-sub">搜索结果 · ' + songs.length + ' 首</div>' +
          renderSongList(songs);
        bindSongList(results);
      })
      .catch(function () { results.innerHTML = '<div class="radio-netease-empty">搜索失败</div>'; });
  }

  /* ---------------- 歌曲列表渲染 / 播放 ---------------- */
  function renderSongList(songs) {
    var html = '<div class="netease-song-list">';
    songs.forEach(function (s, i) {
      var artist = (s.ar && s.ar[0]) ? s.ar[0].name : "";
      songCache[s.id] = { name: s.name, artist: artist };
      html += '<div class="netease-song" data-sid="' + s.id + '">' +
        '<div class="netease-song-idx">' + (i + 1) + '</div>' +
        '<div class="netease-song-info">' +
          '<div class="netease-song-name">' + escapeHtml(s.name) +
            (s.fee === 1 || s.fee === 4 ? '<span class="netease-vip">VIP</span>' : "") + '</div>' +
          '<div class="netease-song-artist">' + escapeHtml(artist) + '</div>' +
        '</div>' +
        '<div class="netease-song-play">' + window.MineIcons.svg("play", 14) + '</div>' +
        '</div>';
    });
    html += '</div>';
    return html;
  }
  function bindSongList(root) {
    root.querySelectorAll(".netease-song").forEach(function (item) {
      item.addEventListener("click", function () {
        var sid = item.getAttribute("data-sid");
        playSong(sid);
      });
    });
  }

  function playSong(sid) {
    if (!sid) return;
    /* 获取播放地址（带登录态 → 可播放 VIP 曲目；Vercel 部署需 realIP 参数） */
    jget("/song/url?id=" + sid + "&level=standard&realIP=116.25.146.177" + cookieParam())
      .then(function (d) {
        var url = (d && d.data && d.data[0] && d.data[0].url) || "";
        if (!url) { toast("该歌曲暂无可播放地址（VIP 歌曲需登录后播放）"); return; }
        var cache = songCache[sid] || {};
        var name = cache.name
          ? (cache.name + (cache.artist ? " - " + cache.artist : ""))
          : "网易云音乐";
        if (onPlay) onPlay(url, name);
      })
      .catch(function () { toast("获取播放地址失败"); });
  }

  /* ---------------- 挂载 ---------------- */
  function mount(el, playCb) {
    container = el;
    onPlay = playCb || null;
    if (!container) return;
    load();
    render();
  }

  function destroy() {
    stopQr();
  }

  return {
    mount: mount,
    destroy: destroy,
    isLoggedIn: function () { return !!state.cookie; }
  };
})();
