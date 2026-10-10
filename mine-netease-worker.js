/* ========================================================================
   Mine · 网易云音乐 API 精简版（Cloudflare Workers 免费计划）
   ------------------------------------------------------------------------
   实现 NeteaseCloudMusicApi（Binaryify）的核心协议，只保留本网站需要的
   接口：扫码登录 / 我的歌单 / 歌单歌曲 / 搜索 / 获取播放地址（登录后
   可播放 VIP 曲目）。全部逻辑单文件自包含（AES-128-CBC / AES-128-ECB /
   MD5 / RSA-PKCS1 手写实现），不依赖任何第三方库。

   部署（免费、永久）：
   1. 打开 https://dash.cloudflare.com 注册/登录（邮箱即可）
   2. 左侧 Workers & Pages → 创建 Worker（Create Worker）
   3. 名称填 mine-netease-api（随意）
   4. 把本文件全部内容粘贴进代码编辑器，覆盖默认代码
   5. 点右上角 保存并部署（Save and Deploy）
   6. 得到地址 https://mine-netease-api.<你的子域>.workers.dev
   7. 把该地址填进 Mine 电台页「网易云音乐」→ 保存 → 扫码登录

   接口（与 NeteaseCloudMusicApi 返回结构一致）：
   /api/login/qr/key                   获取二维码 key
   /api/login/qr/create?key=&qrimg=true 生成二维码图片
   /api/login/qr/check?key=           轮询扫码状态（803 成功并返回 cookie/profile）
   /api/user/playlist?uid=&limit=&cookie= 我的歌单
   /api/playlist/track/all?id=&cookie= 歌单全部歌曲
   /api/search?keywords=&type=&limit=&cookie= 搜索
   /api/song/url?id=&level=&realIP=&cookie= 播放地址（VIP 需登录）
   ======================================================================== */

"use strict";

/* ---------------- 基础工具 ---------------- */
function utf8(s) { return new TextEncoder().encode(String(s)); }
function bytesToHex(bytes) {
  var h = "";
  for (var i = 0; i < bytes.length; i++) h += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return h;
}
function bytesToB64(bytes) {
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function createSecretKey(n) {
  var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var k = "";
  for (var i = 0; i < n; i++) k += chars[Math.floor(Math.random() * chars.length)];
  return k;
}
function pkcs7Pad(bytes) {
  var pad = 16 - (bytes.length % 16);
  var out = new Uint8Array(bytes.length + pad);
  out.set(bytes);
  for (var i = bytes.length; i < out.length; i++) out[i] = pad;
  return out;
}

/* ---------------- AES-128 ---------------- */
var SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
var RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

function xtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }

function keyExpansion(key) {
  var w = [];
  for (var i = 0; i < 4; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  for (i = 4; i < 44; i++) {
    var t = w[i - 1].slice();
    if (i % 4 === 0) {
      t = [SBOX[t[1]] ^ RCON[(i / 4) - 1], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
    }
    w.push([w[i - 4][0] ^ t[0], w[i - 4][1] ^ t[1], w[i - 4][2] ^ t[2], w[i - 4][3] ^ t[3]]);
  }
  return w;
}

function addRoundKey(s, w, round) {
  for (var c = 0; c < 4; c++) {
    var word = w[round * 4 + c];
    s[4 * c] ^= word[0]; s[4 * c + 1] ^= word[1]; s[4 * c + 2] ^= word[2]; s[4 * c + 3] ^= word[3];
  }
}

function shiftRows(s) {
  var t;
  t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
  t = s[2]; s[2] = s[10]; s[10] = t;
  t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[3]; s[3] = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = t;
}

function mixColumn(s, c) {
  var a = s[4 * c], b = s[4 * c + 1], cc = s[4 * c + 2], d = s[4 * c + 3];
  s[4 * c] = xtime(a) ^ (xtime(b) ^ b) ^ cc ^ d;
  s[4 * c + 1] = a ^ xtime(b) ^ (xtime(cc) ^ cc) ^ d;
  s[4 * c + 2] = a ^ b ^ xtime(cc) ^ (xtime(d) ^ d);
  s[4 * c + 3] = (xtime(a) ^ a) ^ b ^ cc ^ xtime(d);
}

function encryptBlock(block, w) {
  var s = block.slice(), i, c;
  addRoundKey(s, w, 0);
  for (var r = 1; r <= 9; r++) {
    for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    shiftRows(s);
    for (c = 0; c < 4; c++) mixColumn(s, c);
    addRoundKey(s, w, r);
  }
  for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];
  shiftRows(s);
  addRoundKey(s, w, 10);
  return s;
}

function aesCbcEncrypt(plainBytes, keyBytes, ivBytes) {
  var w = keyExpansion(keyBytes);
  var padded = pkcs7Pad(plainBytes);
  var out = new Uint8Array(padded.length);
  var prev = ivBytes.slice();
  for (var off = 0; off < padded.length; off += 16) {
    var block = padded.slice(off, off + 16);
    for (var i = 0; i < 16; i++) block[i] ^= prev[i];
    var enc = encryptBlock(block, w);
    out.set(enc, off);
    prev = enc;
  }
  return out;
}

function aesEcbEncrypt(plainBytes, keyBytes) {
  var w = keyExpansion(keyBytes);
  var padded = pkcs7Pad(plainBytes);
  var out = new Uint8Array(padded.length);
  for (var off = 0; off < padded.length; off += 16) {
    out.set(encryptBlock(padded.slice(off, off + 16), w), off);
  }
  return out;
}

/* ---------------- MD5 ---------------- */
var MD5_T = new Uint32Array(64);
for (var _i = 0; _i < 64; _i++) MD5_T[_i] = Math.floor(Math.abs(Math.sin(_i + 1)) * 4294967296);
var MD5_S = [
  7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
  5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
  4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
  6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];

function md5hex(input) {
  var bytes = utf8(input);
  var bitLenLow = (bytes.length * 8) >>> 0;
  var bitLenHigh = Math.floor(bytes.length * 8 / 4294967296);
  var paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  var padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  var dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLenLow, true);
  dv.setUint32(paddedLen - 4, bitLenHigh, true);
  var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  var M = new Uint32Array(16);
  for (var off = 0; off < paddedLen; off += 64) {
    for (var i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    var A = a0, B = b0, C = c0, D = d0;
    for (i = 0; i < 64; i++) {
      var F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_T[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  function w32le(v) {
    var o = "";
    for (var i = 0; i < 4; i++) {
      var x = (v >>> (8 * i)) & 0xff;
      o += (x < 16 ? "0" : "") + x.toString(16);
    }
    return o;
  }
  return w32le(a0) + w32le(b0) + w32le(c0) + w32le(d0);
}

/* ---------------- 网易云加密协议 ---------------- */
var WEAPI_IV = "0102030405060708";
var WEAPI_NONCE = "0CoJUm6Qyw8W8jud";
var RSA_EXP = "010001";
var RSA_MODULUS = "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
var EAPI_KEY = "e82ckenh8dichen8";

function encryptRSA(hexPlain) {
  var m = BigInt("0x" + hexPlain);
  var e = BigInt("0x" + RSA_EXP);
  var n = BigInt("0x" + RSA_MODULUS);
  var k = 128;
  var dataLen = hexPlain.length / 2;
  var block = new Uint8Array(k);
  block[0] = 0x00; block[1] = 0x02;
  for (var i = 2; i < k - dataLen - 1; i++) block[i] = 0xff;
  block[k - dataLen - 1] = 0x00;
  for (i = 0; i < dataLen; i++) block[k - dataLen + i] = parseInt(hexPlain.slice(i * 2, i * 2 + 2), 16);
  var base = BigInt("0x" + bytesToHex(block));
  var r = 1n, b = base, x = e;
  while (x > 0n) {
    if (x & 1n) r = (r * b) % n;
    b = (b * b) % n;
    x >>= 1n;
  }
  return r.toString(16).padStart(256, "0");
}

/* weapi：双重 AES-CBC + RSA 加密 */
function weapi(obj) {
  var text = JSON.stringify(obj);
  var secretKey = createSecretKey(16);
  var enc1 = aesCbcEncrypt(utf8(text), utf8(WEAPI_NONCE), utf8(WEAPI_IV));
  var enc2 = aesCbcEncrypt(enc1, utf8(secretKey), utf8(WEAPI_IV));
  var params = bytesToB64(enc2);
  var encSecKey = encryptRSA(bytesToHex(utf8(secretKey.split("").reverse().join(""))));
  return { params: params, encSecKey: encSecKey };
}

/* eapi：AES-128-ECB + MD5 签名（用于播放地址接口） */
function eapi(urlPath, obj) {
  var text = JSON.stringify(obj);
  var digest = md5hex("nobody" + urlPath + "use" + text + "md5forencrypt");
  var data = urlPath + "-36cd479b6b5-" + text + "-36cd479b6b5-" + digest;
  var params = bytesToHex(aesEcbEncrypt(utf8(data), utf8(EAPI_KEY))).toUpperCase();
  return { params: params };
}

/* ---------------- HTTP 转发 ---------------- */
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function post(path, data, cookie, cryptoMode, realIP) {
  var headers = {
    "User-Agent": UA,
    "Referer": "https://music.163.com",
    "Content-Type": "application/x-www-form-urlencoded"
  };
  if (cookie) headers.Cookie = cookie;
  /* 默认伪装国内 IP：NeteaseCloudMusicApi 官方亦推荐境外部署时带 realIP，
     可显著降低网易云对境外出口的风控（本地诊断已确认无 realIP 时可能被空响应） */
  headers["X-Real-IP"] = realIP || "116.25.146.177";
  var body;
  if (cryptoMode === "weapi") {
    var w = weapi(data);
    body = "params=" + encodeURIComponent(w.params) + "&encSecKey=" + encodeURIComponent(w.encSecKey);
  } else {
    var e = eapi(path, data);
    body = "params=" + encodeURIComponent(e.params);
    headers.os = "pc";
    headers.appver = "8.2.20";
  }
  return fetch("https://music.163.com" + path, { method: "POST", headers: headers, body: body });
}

async function weapiCall(path, data, cookie) {
  var res = await post(path, data, cookie, "weapi");
  return res.json();
}

async function eapiCall(path, data, cookie, realIP) {
  var res = await post(path, data, cookie, "eapi", realIP);
  return res.json();
}

function extractCookies(headerVal) {
  var out = [];
  var parts = String(headerVal || "").split(",");
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i].split(";")[0].trim();
    if (seg && seg.indexOf("=") > 0) out.push(seg);
  }
  return out.join("; ");
}

/* 扫码登录 + 用户信息（803 成功时返回 cookie 与 profile） */
async function qrCheck(key, cookie) {
  var res = await post("/weapi/login/qrcode/check", { type: 1, key: key }, cookie, "weapi");
  var body = await res.json();
  if (body && body.code === 803) {
    var cookies = extractCookies(res.headers.get("set-cookie") || "");
    if (cookies) {
      body.cookie = cookies;
      try {
        var r2 = await post("/weapi/w/nuser/account/get", {}, cookies, "weapi");
        var b2 = await r2.json();
        if (b2 && b2.profile) {
          body.profile = {
            userId: b2.profile.userId || b2.profile.id || "",
            nickname: b2.profile.nickname || "",
            avatarUrl: b2.profile.avatarUrl || ""
          };
        }
      } catch (e) {}
    }
  }
  return body;
}

/* 歌单全部歌曲：歌单详情 → 批量歌曲详情（对齐 NeteaseCloudMusicApi 返回 { code, songs }） */
async function playlistTrackAll(id, cookie) {
  try {
    var res = await post("/api/v6/playlist/detail", { id: Number(id), n: 100000, s: 8 }, cookie, "weapi");
    var b = await res.json();
    if (!b || b.code !== 200 || !b.playlist) return { code: (b && b.code) || 500, songs: [] };
    var ids = (b.playlist.trackIds || []).slice(0, 100).map(function (t) { return t.id; });
    if (!ids.length) return { code: 200, songs: [] };
    var r2 = await post("/api/v3/song/detail", {
      c: JSON.stringify(ids.map(function (id) { return { id: id }; })),
      ids: "[" + ids.join(",") + "]"
    }, cookie, "weapi");
    var b2 = await r2.json();
    return { code: 200, songs: (b2 && b2.songs) || [] };
  } catch (e) {
    return { code: 500, msg: String((e && e.message) || e), songs: [] };
  }
}

/* ---------------- 请求入口 ---------------- */
async function handle(request) {
  var url = new URL(request.url);
  var path = url.pathname;
  var q = url.searchParams;
  var cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400"
  };
  if (request.method === "OPTIONS") return new Response("", { status: 200, headers: cors });
  var body, status = 200;
  try {
    switch (path) {
      case "/api/login/qr/key":
        body = await weapiCall("/weapi/login/qrcode/unikey", { type: 1 }, q.get("cookie"));
        break;
      case "/api/login/qr/create":
        body = await weapiCall("/weapi/login/qrcode/create", {
          type: 1,
          key: q.get("key") || "",
          qrimg: q.get("qrimg") === "true" ? "true" : "false"
        }, q.get("cookie"));
        break;
      case "/api/login/qr/check":
        body = await qrCheck(q.get("key") || "", q.get("cookie"));
        break;
      case "/api/user/playlist":
        body = await weapiCall("/api/user/playlist", {
          uid: q.get("uid") || "",
          limit: parseInt(q.get("limit") || "30", 10) || 30,
          offset: parseInt(q.get("offset") || "0", 10) || 0,
          includeVideo: true,
          sub: false
        }, q.get("cookie"));
        break;
      case "/api/playlist/track/all":
        body = await playlistTrackAll(q.get("id"), q.get("cookie"));
        break;
      case "/api/search":
        body = await weapiCall("/weapi/cloudsearch/get/web", {
          s: q.get("keywords") || "",
          type: parseInt(q.get("type") || "1", 10) || 1,
          limit: parseInt(q.get("limit") || "30", 10) || 30,
          offset: parseInt(q.get("offset") || "0", 10) || 0,
          total: true
        }, q.get("cookie"));
        break;
      case "/api/song/url":
        body = await eapiCall("/api/song/enhance/player/url/v1", {
          ids: "[" + Number(q.get("id")) + "]",
          level: q.get("level") || "standard",
          encodeType: "aac",
          csrf_token: ""
        }, q.get("cookie"), q.get("realIP"));
        break;
      default:
        body = { code: 404, msg: "not found" };
        status = 404;
    }
  } catch (e) {
    body = { code: 500, msg: String((e && e.message) || e) };
    status = 500;
  }
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors)
  });
}

module.exports = {
  fetch: handle,
  weapi: weapi,
  eapi: eapi,
  md5hex: md5hex,
  aesCbcEncrypt: aesCbcEncrypt,
  aesEcbEncrypt: aesEcbEncrypt,
  encryptRSA: encryptRSA,
  extractCookies: extractCookies
};
