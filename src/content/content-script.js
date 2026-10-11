// ============================================================================
// XHS Agent — Content Script（页面执行器）
// ----------------------------------------------------------------------------
// MV3 content script 必须是 CLASSIC 脚本，不能 import/export。
// 本文件自包含，仅依赖浏览器全局：document / window / chrome / setTimeout 等。
//
// 对外契约（被 background service worker 通过 chrome.runtime.sendMessage 调用）：
//   - 接收消息 { action, ...payload }，并通过 sendResponse 回调回复
//     { ok: boolean, data?: any, error?: string }
//   - 支持的 action：waitFor / click / scroll / type / getHTML / getType /
//     getText / closeModal / eval
// ============================================================================

// 与 XPathResult.FIRST_ORDERED_NODE_TYPE 等价（避免在沙箱/老环境中依赖全局常量）。
var XPATH_FIRST_NODE = 9;
// 与 XPathResult.ORDERED_NODE_SNAPSHOT_TYPE 等价，用于取文本包含命中的多个节点。
var XPATH_SNAPSHOT = 7;

// 安全计时器（避免在未注入 setInterval 的 Node 沙箱或特殊环境抛错）
var safeSetInterval = typeof setInterval === 'function' ? setInterval : function (fn, ms) { return setTimeout(fn, ms); };
var safeClearInterval = typeof clearInterval === 'function' ? clearInterval : clearTimeout;

// ----------------------------------------------------------------------------
// 多级备选选择器探测：CSS → XPath → 文本包含
// ----------------------------------------------------------------------------
// 判断元素在页面上是否可见（防隐藏 modal-mask / 占位元素误判）。
function isElementVisible(el) {
  if (!el) return false;
  if (el.offsetParent === null) {
    if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) {
      return false;
    }
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        var style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) {
          return false;
        }
      } catch (e) {
        // 忽略
      }
    }
  }
  return true;
}

// ----------------------------------------------------------------------------
// 计数单位解析器：支持 "1.3万" / "3.3w" / "999+" / "赞" 等小红书真实指标文本
// ----------------------------------------------------------------------------
function parseCount(str) {
  if (str == null) return 0;
  if (typeof str === 'number') return isNaN(str) ? 0 : str;
  var s = String(str).trim();
  if (!s || s === '赞' || s === '收藏' || s === '评论' || s === '分享') return 0;
  // 去除可能的尾随 '+'（如 999+）
  s = s.replace(/\+$/, '');
  // 支持“万”、“w”、“W”
  if (/[万wW]/.test(s)) {
    var numPart = parseFloat(s.replace(/[万wW]/g, ''));
    if (isNaN(numPart)) return 0;
    return Math.round(numPart * 10000);
  }
  // 支持“亿”
  if (/亿/.test(s)) {
    var yiPart = parseFloat(s.replace(/亿/g, ''));
    if (isNaN(yiPart)) return 0;
    return Math.round(yiPart * 100000000);
  }
  var n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n);
}


// 对 selectors 数组中的每个候选，依次尝试：
//   1) CSS 选择器：document.querySelector(sel)
//   2) XPath：把 sel 当作 XPath 表达式，document.evaluate(...)
//   3) 文本包含：找出 textContent 包含 sel 的元素（用 XPath contains 实现）
// 返回第一个命中的元素；都没有则 null。
function findFirstElement(selectors, requireVisible) {
  var list = Array.isArray(selectors) ? selectors : [selectors];
  for (var i = 0; i < list.length; i++) {
    var el = trySelect(String(list[i]));
    if (el) {
      if (requireVisible && !isElementVisible(el)) {
        continue;
      }
      return el;
    }
  }
  return null;
}

// 对单个候选尝试 CSS / XPath / 文本 三级，返回元素或 null。
function trySelect(sel) {
  // 1) CSS
  try {
    if (typeof document.querySelector === 'function') {
      var byCss = document.querySelector(sel);
      if (byCss) return byCss;
    }
  } catch (e) {
    // 非法 CSS 选择器会抛 SyntaxError，忽略后退回 XPath/文本。
  }

  // 2) XPath（把 sel 当作 XPath 表达式）
  try {
    if (typeof document.evaluate === 'function') {
      var xres = document.evaluate(sel, document, null, XPATH_FIRST_NODE, null);
      if (xres && xres.singleNodeValue) return xres.singleNodeValue;
    }
  } catch (e) {
    // 非 XPath 表达式会抛错，忽略后退回文本匹配。
  }

  // 3) 文本包含（用 XPath contains 兜底，避免遍历整棵 DOM）。
  // 取【最内层】命中元素（snapshot 中最后一个 = 文档序最深），避免返回包裹整段的祖先元素。
  try {
    if (typeof document.evaluate === 'function') {
      var textXpath = "//*[contains(normalize-space(.), " + JSON.stringify(sel) + ")]";
      var tres = document.evaluate(textXpath, document, null, XPATH_SNAPSHOT, null);
      if (tres && tres.snapshotLength > 0) {
        return tres.snapshotItem(tres.snapshotLength - 1);
      }
    }
  } catch (e) {
    // 忽略
  }

  return null;
}

// ----------------------------------------------------------------------------
// 拟人分段滚动：把总位移切成多小步，每步带随机抖动并间隔微小延时
// ----------------------------------------------------------------------------
// 返回 Promise：所有步完成后 resolve（累积位移精确等于 distance，不溢出）。
function steppedScroll(distance, duration) {
  duration = typeof duration === 'number' ? duration : 800;
  var stepMs = 80; // 每步基准间隔，模拟人手指/滚轮节奏
  var steps = Math.max(1, Math.round(duration / stepMs));
  var baseStep = distance / steps;
  var remaining = distance;
  var absTotal = Math.abs(distance);

  return new Promise(function (resolve, reject) {
    var i = 0;
    function step() {
      try {
        if (i >= steps || absTotal === 0) {
          resolve();
          return;
        }
        // 随机抖动 ±15%，模拟非匀速的人类滚动。
        var jitter = 1 + (Math.random() * 0.3 - 0.15);
        var delta = baseStep * jitter;
        // 防止溢出剩余位移；最后一步精确补齐，保证累积位移 == distance。
        if (i === steps - 1 || Math.abs(delta) > Math.abs(remaining)) delta = remaining;
        remaining -= delta;
        if (typeof window.scrollBy === 'function') {
          window.scrollBy(0, delta);
        } else if (typeof window.scrollTo === 'function') {
          window.scrollTo(0, (window.scrollY || 0) + delta);
        }
        i += 1;
        setTimeout(step, duration / steps);
      } catch (e) {
        reject(e);
      }
    }
    step();
  });
}

// ----------------------------------------------------------------------------
// onMessage 动作处理
// ----------------------------------------------------------------------------

// 解析选择器入参（同时兼容 selectors 数组与单 selector 字符串）。
function resolveSelectors(msg) {
  if (Array.isArray(msg.selectors)) return msg.selectors;
  if (typeof msg.selector === 'string') return [msg.selector];
  return [];
}

// waitFor：轮询直到元素出现或超时。
function handleWaitFor(msg, sendResponse) {
  var selectors = resolveSelectors(msg);
  var timeout = typeof msg.timeout === 'number' ? msg.timeout : 5000;
  var interval = typeof msg.interval === 'number' ? msg.interval : 50;
  var requireVisible = Boolean(msg.requireVisible);
  var start = Date.now();

  function poll() {
    var el = findFirstElement(selectors, requireVisible);
    if (el) {
      sendResponse({ ok: true });
      return;
    }
    if (Date.now() - start >= timeout) {
      sendResponse({ ok: false, error: 'TIMEOUT' });
      return;
    }
    setTimeout(poll, interval);
  }
  poll();
  return true; // 异步，保持通道开放
}

// click：找到元素并触发 .click()。
function handleClick(msg, sendResponse) {
  var el = findFirstElement(resolveSelectors(msg));
  if (!el) {
    sendResponse({ ok: false, error: 'SELECTOR_NOT_FOUND' });
    return false;
  }
  try {
    el.click();
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
    return false;
  }
  sendResponse({ ok: true });
  return false;
}

// scroll：执行拟人分段滚动。
function handleScroll(msg, sendResponse) {
  var distance = typeof msg.distance === 'number' ? msg.distance : 600;
  var duration = typeof msg.duration === 'number' ? msg.duration : 800;
  steppedScroll(distance, duration)
    .then(function () {
      sendResponse({ ok: true });
    })
    .catch(function (e) {
      sendResponse({ ok: false, error: String(e) });
    });
  return true;
}

// getHTML：返回元素 outerHTML。
function handleGetHTML(msg, sendResponse) {
  var el = findFirstElement(resolveSelectors(msg));
  if (!el) {
    sendResponse({ ok: false, error: 'SELECTOR_NOT_FOUND' });
    return false;
  }
  sendResponse({ ok: true, data: el.outerHTML != null ? el.outerHTML : '' });
  return false;
}

// getType / getText：返回元素的类型属性或文本。
function handleGetText(msg, sendResponse) {
  var el = findFirstElement(resolveSelectors(msg));
  if (!el) {
    sendResponse({ ok: false, error: 'SELECTOR_NOT_FOUND' });
    return false;
  }
  var data;
  if (msg.action === 'getType') {
    data = el.type != null ? el.type : (el.getAttribute ? el.getAttribute('type') : null);
  } else {
    data = el.textContent != null ? el.textContent : '';
  }
  sendResponse({ ok: true, data: data });
  return false;
}

// 兼容 React 受控组件的赋值：React 重写了 input/textarea 的 value 描述符，
// 直接 `el.value = x` 不会触发其 onChange；必须通过原生原型 setter 写入。
function setValue(el, text) {
  var proto =
    (typeof window !== 'undefined' && (window.HTMLInputElement || window.HTMLTextAreaElement)) || null;
  var setter = null;
  if (proto && proto.prototype) {
    var desc = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
    if (desc && typeof desc.set === 'function') setter = desc.set;
  }
  if (setter) {
    try {
      setter.call(el, text);
      return;
    } catch (e) {
      /* 退化到普通赋值 */
    }
  }
  if ('value' in el) {
    try {
      el.value = text;
      return;
    } catch (e) {
      /* 忽略 */
    }
  }
  if (typeof el.setAttribute === 'function') el.setAttribute('value', text);
}

// type：在输入框中输入文本（模拟用户输入，触发 input/change 事件以便框架感知）。
function handleType(msg, sendResponse) {
  var el = findFirstElement(resolveSelectors(msg));
  if (!el) {
    sendResponse({ ok: false, error: 'SELECTOR_NOT_FOUND' });
    return false;
  }
  var text = typeof msg.text === 'string' ? msg.text : '';
  try {
    setValue(el, text);
    if (typeof el.dispatchEvent === 'function') {
      try { el.dispatchEvent(new window.Event('input', { bubbles: true })); } catch (e) { /* 忽略 */ }
      try { el.dispatchEvent(new window.Event('change', { bubbles: true })); } catch (e) { /* 忽略 */ }
    }
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return false;
}

// closeModal：优先点击遮罩/关闭按钮，并派发 Escape 键盘事件兜底。
function handleCloseModal(msg, sendResponse) {
  var maskCandidates = [
    '.mask',
    '.modal-mask',
    '[class*="mask"]',
    '.close',
    '[class*="close"]',
    '.modal-close',
    '[class*="Modal"] .close',
  ];
  var el = findFirstElement(maskCandidates);
  if (el && typeof el.click === 'function') {
    try { el.click(); } catch (e) { /* 忽略 */ }
  }
  try {
    var evt = new window.KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true });
    if (typeof window.dispatchEvent === 'function') window.dispatchEvent(evt);
    if (typeof document.dispatchEvent === 'function') document.dispatchEvent(evt);
  } catch (e) {
    // 个别环境构造 KeyboardEvent 失败，忽略。
  }
  sendResponse({ ok: true });
  return false;
}

// eval：在页面上下文执行脚本字符串（fallback 逃生舱）。
function handleEval(msg, sendResponse) {
  try {
    var result = new Function(msg.script)();
    sendResponse({ ok: true, data: result });
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return false;
}

// getNoteUrls：从当前页面 DOM 中毫秒级直接提取所有笔记卡片链接。
function handleGetNoteUrls(msg, sendResponse) {
  var selectors = resolveSelectors(msg);
  var urls = [];
  var seen = {};

  function addUrl(raw) {
    if (!raw) return;
    var s = String(raw).trim();
    if (!s || s === '#' || s.startsWith('javascript:')) return;
    var isNoteLink =
      s.includes('/explore/') ||
      s.includes('/search_result/') ||
      s.includes('/discovery/item/');
    if (!isNoteLink && !s.match(/\/[a-f0-9]{24}/)) return;
    var fullUrl = s;
    if (!fullUrl.startsWith('http')) {
      fullUrl = 'https://www.xiaohongshu.com' + (fullUrl.startsWith('/') ? '' : '/') + fullUrl;
    }
    if (!seen[fullUrl]) {
      seen[fullUrl] = true;
      urls.push(fullUrl);
    }
  }

  // 1. 优先通过传入的选择器查找
  for (var i = 0; i < selectors.length; i++) {
    try {
      var els = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        var href = el.getAttribute('href') || (el.href ? el.href : '');
        addUrl(href);
      }
    } catch (_) {}
  }

  // 2. 备选扫描：页面所有符合笔记特征的 a 标签
  try {
    var allA = document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]');
    for (var k = 0; k < allA.length; k++) {
      var aHref = allA[k].getAttribute('href') || allA[k].href;
      addUrl(aHref);
    }
  } catch (_) {}

  // 3. 备选扫描：带有 data-id 或 data-note-id 的卡片
  try {
    var cards = document.querySelectorAll('[data-id], [data-note-id]');
    for (var m = 0; m < cards.length; m++) {
      var card = cards[m];
      var noteId = card.getAttribute('data-note-id') || card.getAttribute('data-id');
      if (noteId && noteId.length >= 16 && !noteId.includes(' ')) {
        addUrl('/explore/' + noteId);
      }
    }
  } catch (_) {}

  sendResponse({ ok: true, data: urls });
  return false;
}

// getNoteDetail：从当前页面 DOM 中毫秒级直接提取笔记详情（标题、正文、作者、作者主页、点赞、收藏、总评论数、标签、图片）。
function handleGetNoteDetail(msg, sendResponse) {
  try {
    // 0. 优先检测是否进入了限流/扫码/封控拦截页面，避免将提示误当笔记正文
    var bodyText = (document.body && (document.body.innerText || document.body.textContent)) || '';
    if (
      bodyText.indexOf('当前笔记暂时无法浏览') !== -1 ||
      bodyText.indexOf('请打开小红书App扫码查看') !== -1 ||
      bodyText.indexOf('操作过于频繁') !== -1 ||
      bodyText.indexOf('滑动验证') !== -1
    ) {
      sendResponse({ ok: false, error: 'RATE_LIMITED', code: 300031 });
      return false;
    }

    var selectors = resolveSelectors(msg);
    var titleEl = findFirstElement(
      selectors.concat(['#detail-title', '.title', 'h1[class*="title"]', '[class*="title"]'])
    );
    var contentEl = findFirstElement(['#detail-desc', '.note-text', '[class*="desc"]', '[class*="content"]']);
    var authorEl = findFirstElement(['.username', '.author-name', '[class*="author"] [class*="name"]', '[class*="name"]']);
    var authorLinkEl = findFirstElement(['a[href*="/user/profile/"]', '.author-wrapper a', '.info a']);
    var likesEl = findFirstElement(['.like-wrapper .count', '[class*="interact"] [class*="count"]', '[class*="like"] [class*="count"]', '.like-wrapper', '[class*="like"]']);
    var collectsEl = findFirstElement(['.collect-wrapper .count', '[class*="collect"] .count', '[class*="collect-count"]', '.collect-wrapper', '[class*="collect"]']);
    var commentsCountEl = findFirstElement(['.chat-wrapper .count', '[class*="chat"] .count', '[class*="comment-wrapper"] .count', '.chat-wrapper', '[class*="chat"]']);
    var dateEl = findFirstElement(['.date', '[class*="date"]', 'span[class*="time"]', '[class*="publish-date"]']);

    var authorId = '';
    var authorUrl = '';
    if (authorLinkEl) {
      var rawHref = authorLinkEl.getAttribute('href') || authorLinkEl.href || '';
      if (rawHref) {
        authorUrl = rawHref.startsWith('http') ? rawHref : ('https://www.xiaohongshu.com' + (rawHref.startsWith('/') ? '' : '/') + rawHref);
        var idMatch = rawHref.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/);
        if (idMatch) {
          authorId = idMatch[1];
        }
      }
    }

    var tags = [];
    var tagEls = document.querySelectorAll('a[href*="/search_result?keyword="], a[class*="tag"], [class*="hash-tag"]');
    for (var i = 0; i < tagEls.length; i++) {
      var t = tagEls[i].textContent.trim();
      if (t && tags.indexOf(t) === -1) tags.push(t);
    }

    var images = [];
    var imgEls = document.querySelectorAll('.note-slider img, div[class*="image"] img, .media-container img, [class*="swiper"] img');
    for (var j = 0; j < imgEls.length; j++) {
      var src = imgEls[j].src || imgEls[j].getAttribute('src');
      if (src && !src.startsWith('data:') && images.indexOf(src) === -1) images.push(src);
    }

    var likesNum = parseCount(likesEl ? likesEl.textContent : 0);
    var collectsNum = parseCount(collectsEl ? collectsEl.textContent : 0);
    var totalComments = parseCount(commentsCountEl ? commentsCountEl.textContent : 0);

    var publishedAt = dateEl ? dateEl.textContent.trim() : '';
    // 规整发布时间：小红书常带“编辑于”、“发布于”，统一去除多余前缀
    if (publishedAt) {
      publishedAt = publishedAt.replace(/^(编辑于|发布于)\s*/, '').trim();
    }

    var data = {
      title: titleEl ? titleEl.textContent.trim() : '',
      content: contentEl ? contentEl.textContent.trim() : '',
      author: authorEl ? authorEl.textContent.trim() : '',
      authorId: authorId,
      authorUrl: authorUrl,
      likes: likesNum,
      collects: collectsNum,
      totalComments: totalComments,
      publishedAt: publishedAt,
      coverUrl: images.length > 0 ? images[0] : '',
      tags: tags,
      images: images,
    };
    sendResponse({ ok: true, data: data });
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return false;
}


// getComments：从当前页面 DOM 中毫秒级直接提取评论列表（含唯一性去重，避免父子嵌套节点重复采集）。
function handleGetComments(msg, sendResponse) {
  try {
    var max = typeof msg.limit === 'number' && msg.limit > 0 ? msg.limit : 20;

    // 尝试展开折叠回复（如“展开 3 条回复”按钮），暴露更多子评论
    try {
      var expandBtns = document.querySelectorAll(
        '.show-more, [class*="show-more"], [class*="reply-expand"], [class*="expand-btn"], [class*="reply-more"], [class*="comment-more"]'
      );
      for (var e = 0; e < expandBtns.length && e < 8; e++) {
        var b = expandBtns[e];
        var t = b.textContent || '';
        if (t.includes('展开') || t.includes('回复')) {
          if (typeof b.click === 'function') b.click();
        }
      }
    } catch (_) {}

    var comments = [];
    var seenKeys = {};
    var itemEls = document.querySelectorAll(
      '.comment-item, div[class*="comment-item"], .parent-comment, div[class*="parent-comment"]'
    );
    for (var i = 0; i < itemEls.length && comments.length < max; i++) {
      var it = itemEls[i];
      var authEl = it.querySelector(
        '.name, .author, [class*="name"], .author-name, [class*="author-name"], a[class*="user"]'
      );
      var textEl = it.querySelector(
        '.content, .text, [class*="content"], .note-text, [class*="comment-text"], .comment-content'
      );
      var likeEl = it.querySelector(
        '.like .count, [class*="like"] .count, [class*="like-wrapper"], [class*="like-count"], [class*="like"]'
      );
      var timeEl = it.querySelector('.date, .time, [class*="date"], [class*="time"]');
      var badgeEl = it.querySelector('.author-badge, [class*="author-badge"], .author-tag, [class*="author-tag"]');
      
      var text = textEl ? textEl.textContent.trim() : '';
      if (!text) continue; // 跳过空文本项

      var author = authEl ? authEl.textContent.trim() : '匿名用户';
      var key = author + '::' + text;
      if (seenKeys[key]) continue; // 避免父子嵌套或重复节点
      seenKeys[key] = true;

      var likesStr = likeEl ? likeEl.textContent.trim() : '0';
      var likesNum = parseCount(likesStr);

      // 提取时间与 IP 属地：小红书格式常见如 "03-12 广东" 或 "昨天 14:00 浙江"
      var rawTime = timeEl ? timeEl.textContent.trim() : '';
      var publishedAt = rawTime;
      var location = '';
      if (rawTime) {
        var parts = rawTime.split(/\s+/);
        if (parts.length > 1) {
          var last = parts[parts.length - 1];
          // 若末尾不含数字或冒号，通常为 IP 属地（如广东、上海、北京）
          if (!/[\d:]/.test(last)) {
            location = last;
            publishedAt = parts.slice(0, parts.length - 1).join(' ');
          }
        }
      }

      var isAuthor = false;
      if (badgeEl && (badgeEl.textContent.includes('作者') || badgeEl.textContent.includes('博主'))) {
        isAuthor = true;
      }

      var className = String(it.className || '');
      var isReply = className.includes('reply') || className.includes('sub-comment');
      var level = isReply ? 'reply' : 'root';

      comments.push({
        author: author,
        text: text,
        likes: likesNum,
        publishedAt: publishedAt,
        location: location,
        isAuthor: isAuthor,
        level: level,
      });
    }
    var sectionFound = document.querySelector(
      '.comments-container, .comment-wrapper, .comments-el, div[class*="comment"], .note-scroller'
    ) != null;

    sendResponse({ ok: true, data: comments, sectionFound: sectionFound });
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return false;
}

// 触发完整拟人鼠标点击（mousedown -> mouseup -> click），确保 React 受控组件接收到事件
function triggerMouseClick(el) {
  if (!el) return;
  try {
    if (typeof window !== 'undefined' && typeof window.MouseEvent === 'function') {
      var down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
      var up = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window });
      var clk = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      el.dispatchEvent(down);
      el.dispatchEvent(up);
      el.dispatchEvent(clk);
    }
  } catch (_) {}
  try {
    if (typeof el.click === 'function') el.click();
  } catch (_) {}
  if (el.parentElement && (el.tagName === 'SPAN' || el.tagName === 'SVG' || el.tagName === 'I')) {
    try {
      if (typeof el.parentElement.click === 'function') el.parentElement.click();
    } catch (_) {}
  }
}

// setSearchSort：在搜索结果页切换排序（支持综合、最新、最多点赞、最多评论）
function handleSetSearchSort(msg, sendResponse) {
  var sortType = msg.sortType;
  if (!sortType || sortType === 'general') {
    sendResponse({ ok: true, message: '默认综合排序' });
    return false;
  }

  var targetName = '最多点赞';
  if (sortType === 'time_descending') {
    targetName = '最新';
  } else if (sortType === 'popularity_descending') {
    targetName = '最多点赞';
  } else if (sortType === 'comments_descending') {
    targetName = '最多评论';
  }

  var timeout = typeof msg.timeout === 'number' ? msg.timeout : 4000;
  var startTime = Date.now();

  // 判断是否为左侧/顶部分类导航栏（如 全部、图文、视频、用户）
  function isCategoryTabOrNav(el) {
    if (!el) return false;
    var t = (el.textContent || '').trim();
    if (/^(全部|图文|视频|用户)$/.test(t)) return true;
    var c = (el.className || '').toString();
    if (/channel|tab-list|nav-tabs/.test(c)) return true;
    if (typeof el.querySelector === 'function') {
      var sub = el.querySelector('.tab-item, [class*="channel"], [class*="tab"]');
      if (sub) return true;
    }
    // 若子项文本包含明显的多分类词汇且不含“筛选”
    if (t.indexOf('图文') !== -1 && t.indexOf('视频') !== -1 && t.indexOf('筛选') === -1) {
      return true;
    }
    return false;
  }

  // 1. 查找浮层容器（通过“排序依据”精准定位，彻底杜绝误触页面左侧分类和其它元素）
  function findSortPopup() {
    var nodes = document.querySelectorAll('div, span, p, label, section, h3, h4');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!isElementVisible(node)) continue;
      var txt = (node.textContent || '').trim();
      if (txt === '排序依据' || txt.indexOf('排序依据') === 0) {
        var parent = node.parentElement;
        while (parent && parent !== document.body) {
          if (typeof parent.querySelectorAll === 'function') {
            var children = parent.querySelectorAll('div, span, button');
            if (children.length >= 3) {
              var rect = typeof parent.getBoundingClientRect === 'function' ? parent.getBoundingClientRect() : null;
              if (!rect || rect.width < 600) {
                return parent;
              }
            }
          } else if (parent.children && parent.children.length >= 2) {
            return parent;
          }
          parent = parent.parentElement;
        }
        return node.parentElement || node;
      }
    }
    // 兼容测试与特殊 DOM：若无严格 "排序依据" 标签，尝试从 class 带 sort/filter-panel/filter-dropdown 的弹窗中找
    var pop = document.querySelector('[class*="filter-panel"], [class*="filter-dropdown"], [class*="sort-dropdown"]');
    if (pop && isElementVisible(pop) && !isCategoryTabOrNav(pop)) return pop;
    return null;
  }

  // 2. 在排序浮层内查找目标胶囊选项按钮（'最新' / '最多点赞' / '综合' / '最多评论'）
  function findOptionInPopup(popup) {
    if (!popup) return null;
    var candidates = [];
    if (typeof popup.querySelectorAll === 'function') {
      candidates = popup.querySelectorAll('button, div, span, a');
    } else if (popup.children) {
      candidates = popup.children;
    }
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isElementVisible(el)) continue;
      var t = (el.textContent || '').trim();
      if (t === targetName || (targetName === '最新' && (t === '最新' || t === '最新发布'))) {
        return el;
      }
    }
    return null;
  }

  // 3. 查找右上角的“筛选”或“已筛选”展开按钮
  function findFilterToggleBtn() {
    // 优先通过显式 class（排除分类容器）
    var byClass = document.querySelector('[class*="filter-btn"], [class*="filterBtn"], [class*="filter-trigger"]');
    if (byClass && isElementVisible(byClass) && !isCategoryTabOrNav(byClass)) return byClass;

    var all = document.querySelectorAll('button, div, span, a');
    var best = null;
    var maxRight = 0;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!isElementVisible(el)) continue;
      if (isCategoryTabOrNav(el)) continue;
      var txt = (el.textContent || '').trim();
      if ((txt === '筛选' || txt === '已筛选' || (txt.indexOf('筛选') !== -1 && txt.length <= 4))) {
        if (typeof el.getBoundingClientRect === 'function') {
          var rect = el.getBoundingClientRect();
          if (rect.top >= 0 && rect.top <= 250) {
            if (rect.right > maxRight) {
              maxRight = rect.right;
              best = el;
            }
          }
        } else {
          best = el;
        }
      }
    }
    if (best) return best;

    // 文本匹配兜底
    var byText = findFirstElement(["//*[normalize-space(.)='筛选']", "//*[normalize-space(.)='已筛选']", "筛选"], true);
    if (byText && !isCategoryTabOrNav(byText)) return byText;
    return null;
  }

  function tryClickTarget(inPopupOnly) {
    var popup = findSortPopup();
    if (popup) {
      var opt = findOptionInPopup(popup);
      if (opt) {
        triggerMouseClick(opt);
        return true;
      }
    }
    // 若要求仅在浮层内匹配，未在浮层找到直接返回 false
    if (inPopupOnly) {
      return false;
    }

    // 步骤 2 之后展开浮层的兼容逻辑：
    // 1) 优先尝试 XPath 严格全等匹配
    var exactXpath = "//*[normalize-space(.)=" + JSON.stringify(targetName) + "]";
    var exactNode = findFirstElement([exactXpath], true);
    if (exactNode) {
      var exactTxt = (exactNode.textContent || '').trim();
      if (exactTxt === targetName || (targetName === '最新' && exactTxt === '最新发布')) {
        triggerMouseClick(exactNode);
        return true;
      }
    }

    // 2) 文本匹配（严格校验自身文本必须全等于目标词，杜绝命中包含词汇的长文或普通笔记）
    var textNode = findFirstElement([targetName], true);
    if (textNode) {
      var t = (textNode.textContent || '').trim();
      if (t === targetName || (targetName === '最新' && t === '最新发布')) {
        triggerMouseClick(textNode);
        return true;
      }
    }

    return false;
  }

  // 步骤 1：若浮层已展开，直接在浮层中点击（严格禁止在浮层未展开时匹配全局文字）
  if (tryClickTarget(true)) {
    sendResponse({ ok: true, switched: true, direct: true });
    return false;
  }

  // 步骤 2：若尚未展开，点击右上角「筛选 / 已筛选」按钮展开
  var toggleBtn = findFilterToggleBtn();
  if (toggleBtn) {
    triggerMouseClick(toggleBtn);
  }

  // 步骤 3：轮询等待浮层挂载并点击
  var pollInterval = 40;
  var pollTimer = safeSetInterval(function () {
    if (tryClickTarget(false)) {
      safeClearInterval(pollTimer);
      sendResponse({ ok: true, switched: true });
      return;
    }
    if (Date.now() - startTime >= timeout) {
      safeClearInterval(pollTimer);
      // 若超时仍未在浮层中定位，全局兜底在视口上方尝试匹配短文本胶囊
      var fallbackOpt = null;
      var allNodes = document.querySelectorAll('button, div, span');
      for (var j = 0; j < allNodes.length; j++) {
        var n = allNodes[j];
        if (!isElementVisible(n)) continue;
        var s = (n.textContent || '').trim();
        if (s === targetName || (targetName === '最新' && s === '最新发布')) {
          var r = typeof n.getBoundingClientRect === 'function' ? n.getBoundingClientRect() : null;
          if (!r || (r.top >= 0 && r.top <= 350)) {
            fallbackOpt = n;
            break;
          }
        }
      }
      if (fallbackOpt) {
        triggerMouseClick(fallbackOpt);
        sendResponse({ ok: true, switched: true, fallback: true });
      } else {
        sendResponse({ ok: false, error: 'SORT_OPTION_NOT_FOUND' });
      }
    }
  }, pollInterval);

  return true; // 异步响应
}

// ----------------------------------------------------------------------------
// 消息分发
// ----------------------------------------------------------------------------
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.action) {
      sendResponse({ ok: false, error: 'INVALID_MESSAGE' });
      return false;
    }
    switch (message.action) {
      case 'waitFor':
        return handleWaitFor(message, sendResponse);
      case 'click':
        return handleClick(message, sendResponse);
      case 'scroll':
        return handleScroll(message, sendResponse);
      case 'getHTML':
        return handleGetHTML(message, sendResponse);
      case 'getNoteUrls':
        return handleGetNoteUrls(message, sendResponse);
      case 'getNoteDetail':
        return handleGetNoteDetail(message, sendResponse);
      case 'getComments':
        return handleGetComments(message, sendResponse);
      case 'type':
        return handleType(message, sendResponse);
      case 'getType':
      case 'getText':
        return handleGetText(message, sendResponse);
      case 'closeModal':
        return handleCloseModal(message, sendResponse);
      case 'eval':
        return handleEval(message, sendResponse);
      case 'setSearchSort':
        return handleSetSearchSort(message, sendResponse);
      default:
        sendResponse({ ok: false, error: 'UNKNOWN_ACTION' });
        return false;
    }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseCount: parseCount,
    findFirstElement: findFirstElement,
    resolveSelectors: resolveSelectors,
    handleGetNoteUrls: handleGetNoteUrls,
    handleGetNoteDetail: handleGetNoteDetail,
    handleGetComments: handleGetComments,
    handleSetSearchSort: handleSetSearchSort,
  };
}


