/* ========================================================================
   Mine · 通用工具库
   ------------------------------------------------------------------------
   · compressImage: 将图片文件压缩为指定尺寸的 dataURL
     解决 localStorage 容量问题（原始大图可达数 MB，压缩后仅数十 KB）
   · sortByPinyin: 按首字拼音第一个字母 A→Z 排序
   · getPinyinInitial: 获取单个字符的拼音首字母
   ======================================================================== */

window.MineUtils = (function () {
  "use strict";

  /**
   * 将图片文件压缩为 dataURL
   * @param {File} file - 图片文件
   * @param {number} maxSize - 最大边长（px），默认 400
   * @param {number} quality - JPEG 质量 0-1，默认 0.8
   * @param {function} callback - 回调，参数为 dataURL 字符串
   */
  function compressImage(file, maxSize, quality, callback) {
    if (!file || !/^image\//.test(file.type)) { callback(null); return; }
    maxSize = maxSize || 400;
    quality = quality || 0.8;

    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement("canvas");
        var ctx = canvas.getContext("2d");

        var w = img.width, h = img.height;
        // 等比缩放
        if (w > h) {
          if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; }
        } else {
          if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; }
        }
        canvas.width = w;
        canvas.height = h;
        // 白底（避免透明 PNG 压成黑底）
        ctx.fillStyle = "#1f2326";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        var dataURL = canvas.toDataURL("image/jpeg", quality);
        callback(dataURL);
      };
      img.onerror = function () { callback(null); };
      img.src = e.target.result;
    };
    reader.onerror = function () { callback(null); };
    reader.readAsDataURL(file);
  }

  /* ========================================================================
     拼音首字母工具
     ------------------------------------------------------------------------
     原理：现代浏览器的 Intl/localeCompare 支持 zh-Hans-CN 拼音排序。
     通过将字符与已知拼音首字母的参考字比较，确定其所属首字母区间。
     ======================================================================== */

  // 每个拼音首字母的参考字（取该字母下拼音排序最早的常用字）
  var PINYIN_REFS = [
    ["A", "\u554A"],  // 啊
    ["B", "\u516B"],  // 八
    ["C", "\u5693"],  // 嚓
    ["D", "\u642D"],  // 搭
    ["E", "\u5C44"],  // 屙
    ["F", "\u53D1"],  // 发
    ["G", "\u65EE"],  // 旮
    ["H", "\u54C8"],  // 哈
    ["J", "\u51E0"],  // 几
    ["K", "\u5496"],  // 咖
    ["L", "\u5783"],  // 垃
    ["M", "\u5988"],  // 妈
    ["N", "\u62FF"],  // 拿
    ["O", "\u5662"],  // 哦
    ["P", "\u556A"],  // 啪
    ["Q", "\u4E03"],  // 七
    ["R", "\u7136"],  // 然
    ["S", "\u6492"],  // 撒
    ["T", "\u584C"],  // 塌
    ["W", "\u6316"],  // 挖
    ["X", "\u5915"],  // 夕
    ["Y", "\u538B"],  // 压
    ["Z", "\u531D"]   // 匝
  ];

  // 缓存 Intl.Collator 实例（性能优化）
  var _collator = null;
  function getCollator() {
    if (!_collator) {
      try { _collator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base" }); }
      catch (e) { _collator = false; }
    }
    return _collator || null;
  }

  function cmpZh(a, b) {
    var col = getCollator();
    if (col) return col.compare(a, b);
    try { return a.localeCompare(b, "zh-Hans-CN"); }
    catch (e) { return a < b ? -1 : a > b ? 1 : 0; }
  }

  /**
   * 获取单个字符的拼音首字母
   * @param {string} ch - 单个字符
   * @returns {string} A-Z 或 "#"（非汉字/符号）
   */
  function getPinyinInitial(ch) {
    if (!ch) return "#";
    ch = String(ch).charAt(0);
    var code = ch.charCodeAt(0);

    // 英文字母直接返回
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      return ch.toUpperCase();
    }
    // 数字和符号
    if (code < 0x4E00 || code > 0x9FFF) return "#";

    // 与参考字比较，找到所属区间
    for (var i = PINYIN_REFS.length - 1; i >= 0; i--) {
      if (cmpZh(ch, PINYIN_REFS[i][1]) >= 0) {
        return PINYIN_REFS[i][0];
      }
    }
    return "#";
  }

  /**
   * 按首字拼音第一个字母从 A 到 Z 排序
   * 英文/数字排在最前，符号排最后。
   * @param {string[]} arr - 字卡数组
   * @returns {string[]} 排序后的新数组（不修改原数组）
   */
  function sortByPinyin(arr) {
    return arr.slice().sort(function (a, b) {
      var sa = (a || "").trim();
      var sb = (b || "").trim();
      if (!sa) return 1;
      if (!sb) return -1;

      var la = getPinyinInitial(sa.charAt(0));
      var lb = getPinyinInitial(sb.charAt(0));

      // 不同首字母 → 按字母顺序
      if (la !== lb) {
        // "#"（数字/符号）排最前
        if (la === "#") return -1;
        if (lb === "#") return 1;
        return la < lb ? -1 : 1;
      }
      // 同首字母 → 用 localeCompare 精排（按完整拼音）
      return cmpZh(sa, sb);
    });
  }

  /**
   * 数组去重（保持顺序）
   * @param {string[]} arr - 字卡数组
   * @returns {string[]} 去重后的新数组
   */
  function deduplicateCards(arr) {
    var seen = {};
    var result = [];
    for (var i = 0; i < arr.length; i++) {
      var card = arr[i];
      if (!seen[card]) {
        seen[card] = true;
        result.push(card);
      }
    }
    return result;
  }

  return {
    compressImage: compressImage,
    sortByPinyin: sortByPinyin,
    getPinyinInitial: getPinyinInitial,
    deduplicateCards: deduplicateCards
  };
})();
