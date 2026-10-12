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

// 安全计时器（避免在未注入 setInterval/setTimeout 的 Node 沙箱或特殊环境抛错）
var safeSetInterval = typeof setInterval === 'function' ? setInterval : function (fn, ms) { return setTimeout(fn, ms); };
var safeClearInterval = typeof clearInterval === 'function' ? clearInterval : clearTimeout;
var safeSetTimeout = typeof setTimeout === 'function' ? setTimeout : function (fn, ms) { return setTimeout(fn, ms); };
var safeClearTimeout = typeof clearTimeout === 'function' ? clearTimeout : function () {};

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

// 判断是否为左侧/顶部分类导航栏（如 全部、图文、视频、用户）
function isCategoryTabOrNav(el) {
  if (!el) return false;
  var c = (el.className || '').toString();
  if (/capsule|filter-item|sort-item|tag-item/.test(c)) return false;

  // 若元素本身处于筛选/排序面板内部（如包含“笔记类型”或“排序依据”），绝非分类导航栏
  var p = el.parentElement;
  while (p && p !== document.body) {
    var pTxt = p.textContent || '';
    if (pTxt.includes('排序依据') || pTxt.includes('笔记类型') || pTxt.includes('发布时间')) {
      return false;
    }
    var pCl = String(p.className || '');
    if (/filter-box|filter-panel|filter-dropdown|sort-dropdown/.test(pCl)) {
      return false;
    }
    p = p.parentElement;
  }

  var t = (el.textContent || '').trim();
  if (/^(全部|图文|视频|用户)$/.test(t)) return true;
  if (/channel-filter|tab-list|nav-tabs/.test(c)) return true;
  // 若包含图文和视频，且不含筛选/排序
  if (t.indexOf('图文') !== -1 && t.indexOf('视频') !== -1 && t.indexOf('筛选') === -1 && t.indexOf('排序') === -1 && t.indexOf('最新') === -1) {
    return true;
  }
  return false;
}

// 查找浮层容器（支持“排序依据”小标题，或展开后包含“最新”/“最多点赞”的胶囊容器）
function findSortPopup() {
  // 1. 尝试从包含“排序依据”的结构查找最小公共容器
  var nodes = document.querySelectorAll('div, span, p, label, section, h3, h4');
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (!isElementVisible(node)) continue;
    var txt = (node.textContent || '').trim();
    if (txt === '排序依据' || txt.indexOf('排序依据') === 0) {
      var parent = node.parentElement;
      while (parent && parent !== document.body) {
        var pTxt = parent.textContent || '';
        if (pTxt.includes('最新') || pTxt.includes('最多点赞') || pTxt.includes('综合')) {
          return parent;
        }
        parent = parent.parentElement;
      }
      return node.parentElement || node;
    }
  }

  // 2. 真实 XHS 结构：从包含“最新”或“最多点赞”的非导航栏容器反向查找浮层面板
  var optionSpans = document.querySelectorAll('span, div, button');
  for (var j = 0; j < optionSpans.length; j++) {
    var op = optionSpans[j];
    if (!isElementVisible(op) || isCategoryTabOrNav(op)) continue;
    var ot = (op.textContent || '').trim();
    if (ot === '最新' || ot === '最多点赞' || ot === '最新发布') {
      var p = op.parentElement;
      while (p && p !== document.body) {
        if (isCategoryTabOrNav(p)) break;
        var pClass = String(p.className || '');
        if (/filter|sort|panel|dropdown|popover|box|menu|wrapper|container/.test(pClass) || (p.textContent && p.textContent.indexOf('综合') !== -1 && p.textContent.indexOf('最新') !== -1)) {
          return p;
        }
        p = p.parentElement;
      }
      return op.parentElement;
    }
  }

  // 3. 兼容测试与显式 class
  var pop = document.querySelector('[class*="filter-panel"], [class*="filter-dropdown"], [class*="sort-dropdown"], [class*="filter-box"]');
  if (pop && isElementVisible(pop) && !isCategoryTabOrNav(pop)) return pop;
  return null;
}

// 查找右上角的“筛选”或“已筛选”展开按钮
function findFilterToggleBtn() {
  // 1. 优先寻找文本精确为“筛选”或“已筛选”的可见节点（如 <span>筛选</span> 或 <button>筛选</button>）
  var all = document.querySelectorAll('button, div, span, a');
  var candidates = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!isElementVisible(el)) continue;
    if (isCategoryTabOrNav(el)) continue;
    var txt = (el.textContent || '').trim();
    if (txt === '筛选' || txt === '已筛选' || (/^已?筛选/.test(txt) && txt.length <= 4)) {
      candidates.push(el);
    }
  }

  if (candidates.length > 0) {
    // 优先返回自身或父级 className 包含 filter 的节点（若父级为 filter 容器，优先返回父级交互容器）
    for (var j = 0; j < candidates.length; j++) {
      var c = candidates[j];
      var p = c.parentElement;
      if (p && String(p.className || '').indexOf('filter') !== -1) return p;
      if (String(c.className || '').indexOf('filter') !== -1) return c;
    }
    // 否则取顶部最靠右侧的元素
    var best = candidates[0];
    var maxRight = 0;
    for (var k = 0; k < candidates.length; k++) {
      if (typeof candidates[k].getBoundingClientRect === 'function') {
        var r = candidates[k].getBoundingClientRect();
        if (r.right > maxRight) {
          maxRight = r.right;
          best = candidates[k];
        }
      }
    }
    return best;
  }

  // 2. 备选：查找明确包含 filter 类的可交互按钮容器
  var byClass = document.querySelector('.filter, [class*="filter-btn"], [class*="filterBtn"], [class*="filter-trigger"]');
  if (byClass && isElementVisible(byClass) && !isCategoryTabOrNav(byClass)) {
    return byClass;
  }

  // 3. 文本匹配兜底
  var byText = findFirstElement(["//*[normalize-space(.)='筛选']", "//*[normalize-space(.)='已筛选']", "筛选"], true);
  if (byText && !isCategoryTabOrNav(byText)) return byText;
  return null;
}

// 提取顶部交互控制区域骨架 HTML（导航分类栏 + 筛选控制区域 + 排序浮层），供 LLM 进行区域判断
function extractInteractiveRegionHtml() {
  try {
    var parts = [];
    // 1. 抓取顶部导航栏/分类栏容器（让 LLM 看到并能够识别以排除左侧分类栏）
    var navTabs = document.querySelector('[class*="channel"], [class*="tab-list"], [class*="nav-tabs"], ul[role="tablist"]');
    if (navTabs) {
      parts.push('<div class="skeleton-nav-region">' + (navTabs.outerHTML || '') + '</div>');
    }

    // 2. 抓取筛选按钮及所在的父级容器（操作栏）
    var filterBtn = typeof findFilterToggleBtn === 'function' ? findFilterToggleBtn() : null;
    if (filterBtn) {
      var p = filterBtn;
      for (var k = 0; k < 3 && p.parentElement && p.parentElement !== document.body; k++) {
        p = p.parentElement;
      }
      parts.push('<div class="skeleton-filter-region">' + (p.outerHTML || filterBtn.outerHTML) + '</div>');
    }

    // 3. 抓取排序浮层（若已挂载）
    var popup = typeof findSortPopup === 'function' ? findSortPopup() : null;
    if (popup) {
      parts.push('<div class="skeleton-sort-popup">' + (popup.outerHTML || '') + '</div>');
    }

    // 4. 若未找到特定节点，兜底截取视口顶部 400px 内的非正文容器
    if (parts.length === 0) {
      var topNodes = document.querySelectorAll('header, [class*="filter"], [class*="sort"], [class*="search-header"]');
      for (var i = 0; i < topNodes.length && parts.length < 3; i++) {
        parts.push(topNodes[i].outerHTML || '');
      }
    }

    return '<div class="xhs-interactive-control-skeleton">\n' + parts.join('\n') + '\n</div>';
  } catch (_) {
    return '';
  }
}

function handleGetInteractiveRegionHtml(msg, sendResponse) {
  function finish() {
    var html = extractInteractiveRegionHtml();
    sendResponse({ ok: true, html: html || '<div class="fallback-empty"></div>' });
  }

  // 若浮层未展开，先主动点击筛选按钮展开浮层，等待挂载后再抓取 HTML 供 LLM 分析
  var popup = typeof findSortPopup === 'function' ? findSortPopup() : null;
  if (!popup && typeof findFilterToggleBtn === 'function') {
    var filterBtn = findFilterToggleBtn();
    if (filterBtn) {
      triggerMouseClick(filterBtn);
      safeSetTimeout(finish, 250);
      return true; // 保持通道开放
    }
  }

  finish();
  return false;
}

// 提取搜索页紧凑核心骨架（顶部操作栏/筛选浮层 + 前几个笔记卡片），防止整页数十万字 HTML 被暴力切断
function extractSearchSkeleton() {
  try {
    var parts = [];

    // 1. 尝试抓取筛选按钮/操作栏区域
    var filterBtn = typeof findFilterToggleBtn === 'function' ? findFilterToggleBtn() : null;
    if (filterBtn) {
      var headerContainer = filterBtn.parentElement || filterBtn;
      parts.push('<div class="skeleton-header-box">' + (headerContainer.outerHTML || filterBtn.outerHTML) + '</div>');
    }

    // 2. 尝试抓取已展开的排序面板
    var popup = typeof findSortPopup === 'function' ? findSortPopup() : null;
    if (popup) {
      parts.push('<div class="skeleton-sort-panel">' + (popup.outerHTML || '') + '</div>');
    }

    // 3. 抓取前 3~5 个笔记卡片示例
    var cardSelectors = [
      'section[class*="note"]',
      'div[class*="note-item"]',
      'a[href*="/explore/"]',
      'a[href*="/search_result/"]',
      '.feeds-container > div',
      '.note-item',
    ];
    var cards = [];
    for (var i = 0; i < cardSelectors.length; i++) {
      try {
        var found = document.querySelectorAll(cardSelectors[i]);
        if (found && found.length > 0) {
          for (var j = 0; j < found.length && cards.length < 5; j++) {
            cards.push(found[j]);
          }
          break;
        }
      } catch (_) {}
    }

    if (cards.length > 0) {
      var cardsHtml = cards.map(function (c) { return c.outerHTML || ''; }).join('\n');
      parts.push('<div class="skeleton-cards-box">' + cardsHtml + '</div>');
    }

    if (parts.length > 0) {
      return '<div class="xhs-search-skeleton">\n' + parts.join('\n') + '\n</div>';
    }
  } catch (_) {}
  return null;
}

// getHTML：返回元素 outerHTML（若 targetType 为 search 或在搜索页，自动优先构建紧凑核心骨架）。
function handleGetHTML(msg, sendResponse) {
  function proceed() {
    var isSearchPage =
      msg.targetType === 'search' ||
      (typeof window !== 'undefined' && window.location && String(window.location.href).includes('search_result'));

    if (isSearchPage) {
      var skeleton = extractSearchSkeleton();
      if (skeleton) {
        sendResponse({ ok: true, data: skeleton, isSkeleton: true });
        return;
      }
    }

    var el = findFirstElement(resolveSelectors(msg));
    if (!el) {
      sendResponse({ ok: false, error: 'SELECTOR_NOT_FOUND' });
      return;
    }
    sendResponse({ ok: true, data: el.outerHTML != null ? el.outerHTML : '' });
  }

  if (msg.expandFilter && typeof findFilterToggleBtn === 'function') {
    try {
      var filterBtn = findFilterToggleBtn();
      if (filterBtn) {
        triggerMouseClick(filterBtn);
        safeSetTimeout(proceed, 200);
        return true;
      }
    } catch (_) {}
  }

  proceed();
  return false;
}

// handleVerifySelectors：在当前 DOM 中沙箱回测候选规则并采集匹配数与样本
function handleVerifySelectors(msg, sendResponse) {
  var candidates = msg.candidates || {};

  var hasSortRules = false;
  for (var k in candidates) {
    if (k.indexOf('sort') !== -1 || k.indexOf('filter') !== -1) {
      hasSortRules = true;
      break;
    }
  }

  function doVerify() {
    var results = {};
    for (var key in candidates) {
      if (!Object.prototype.hasOwnProperty.call(candidates, key)) continue;
      var list = Array.isArray(candidates[key]) ? candidates[key] : [candidates[key]];
      var bestCount = 0;
      var bestSel = '';
      var sample = '';

      for (var i = 0; i < list.length; i++) {
        var sel = String(list[i]);
        var count = 0;
        var firstNode = null;

        // 1) 优先尝试 querySelectorAll
        try {
          if (typeof document.querySelectorAll === 'function') {
            var nodes = document.querySelectorAll(sel);
            if (nodes && nodes.length > 0) {
              count = nodes.length;
              firstNode = nodes[0];
            }
          }
        } catch (_) {}

        // 2) 若失败，尝试 XPath
        if (count === 0) {
          try {
            if (typeof document.evaluate === 'function') {
              var xres = document.evaluate(sel, document, null, XPATH_SNAPSHOT, null);
              if (xres && xres.snapshotLength > 0) {
                count = xres.snapshotLength;
                firstNode = xres.snapshotItem(0);
              }
            }
          } catch (_) {}
        }

        // 3) trySelect 兜底
        if (count === 0) {
          var fallbackNode = trySelect(sel);
          if (fallbackNode) {
            count = 1;
            firstNode = fallbackNode;
          }
        }

        if (count > bestCount) {
          bestCount = count;
          bestSel = sel;
          sample = firstNode ? (firstNode.textContent || '').trim().slice(0, 30) : '';
        }
      }

      results[key] = {
        selector: bestSel || (list[0] ? String(list[0]) : ''),
        matchCount: bestCount,
        sampleText: sample,
        valid: bestCount > 0,
      };
    }
    sendResponse({ ok: true, results: results });
  }

  if (hasSortRules && typeof findSortPopup === 'function' && !findSortPopup()) {
    try {
      var btn = typeof findFilterToggleBtn === 'function' ? findFilterToggleBtn() : null;
      if (btn) {
        triggerMouseClick(btn);
        safeSetTimeout(doVerify, 200);
        return true;
      }
    } catch (_) {}
  }

  doVerify();
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

// 触发完整拟人鼠标点击（hover -> pointerdown -> mousedown -> pointerup -> mouseup -> click），确保 React 受控组件接收到事件
function triggerMouseClick(el) {
  if (!el) return;

  var targets = [];
  function addTarget(t) {
    if (t && targets.indexOf(t) === -1) targets.push(t);
  }
  addTarget(el);
  if (el.parentElement) addTarget(el.parentElement);
  if (typeof el.closest === 'function') {
    var cBtn = el.closest('button, [role="button"]');
    if (cBtn) addTarget(cBtn);
    var cFilter = el.closest('.filter, [class*="filter"]');
    if (cFilter) addTarget(cFilter);
    var cTab = el.closest('[class*="tab"]');
    if (cTab) addTarget(cTab);
  }

  var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  var cx = rect ? (rect.left + rect.width / 2) : 100;
  var cy = rect ? (rect.top + rect.height / 2) : 100;

  var eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: typeof window !== 'undefined' ? window : null,
    clientX: cx,
    clientY: cy,
    screenX: cx,
    screenY: cy,
    pageX: cx,
    pageY: cy,
    buttons: 1,
    button: 0,
    which: 1,
  };

  // 1. 悬停展开事件（针对通过 hover/mouseenter 触发的浮层）
  for (var h = targets.length - 1; h >= 0; h--) {
    var hNode = targets[h];
    try {
      if (typeof window !== 'undefined') {
        if (typeof window.PointerEvent === 'function') {
          hNode.dispatchEvent(new PointerEvent('pointerover', eventInit));
          hNode.dispatchEvent(new PointerEvent('pointerenter', eventInit));
        }
        if (typeof window.MouseEvent === 'function') {
          hNode.dispatchEvent(new MouseEvent('mouseover', eventInit));
          hNode.dispatchEvent(new MouseEvent('mouseenter', eventInit));
        }
      }
    } catch (_) {}
  }

  // 2. 按下、释放与点击事件
  for (var p = 0; p < targets.length; p++) {
    var pNode = targets[p];
    try {
      if (typeof window !== 'undefined') {
        if (typeof window.PointerEvent === 'function') {
          pNode.dispatchEvent(new PointerEvent('pointerdown', eventInit));
          pNode.dispatchEvent(new PointerEvent('pointerup', eventInit));
        }
        if (typeof window.MouseEvent === 'function') {
          pNode.dispatchEvent(new MouseEvent('mousedown', eventInit));
          pNode.dispatchEvent(new MouseEvent('mouseup', eventInit));
          pNode.dispatchEvent(new MouseEvent('click', eventInit));
        }
      }
    } catch (_) {}
    try {
      if (typeof pNode.click === 'function') pNode.click();
    } catch (_) {}
  }

  // 3. 针对 Node.js vm mock 测试沙箱兼容（无原生冒泡环境）
  if (typeof window === 'undefined' || !window.document || !window.document.documentElement) {
    if (typeof el.click === 'function') {
      try { el.click(); } catch (_) {}
    }
    if (el.parentElement && typeof el.parentElement.click === 'function') {
      try { el.parentElement.click(); } catch (_) {}
    }
  }
}

// 判断排序胶囊是否处于 active 激活态
function isOptionActive(el) {
  if (!el) return false;
  var toCheck = [el];
  if (el.parentElement) toCheck.push(el.parentElement);
  if (el.parentElement && el.parentElement.parentElement) toCheck.push(el.parentElement.parentElement);
  if (el.children) {
    for (var c = 0; c < el.children.length; c++) toCheck.push(el.children[c]);
  }

  for (var i = 0; i < toCheck.length; i++) {
    var cur = toCheck[i];
    var cl = String(cur.className || '');
    if (/\b(active|selected|current|is-active|checked|highlight)\b/i.test(cl)) {
      return true;
    }
    if (typeof cur.getAttribute === 'function') {
      if (cur.getAttribute('aria-selected') === 'true' || cur.getAttribute('data-active') === 'true') {
        return true;
      }
    }
  }
  return false;
}

// setSearchSort：在搜索结果页切换排序（支持综合、最新、最多点赞、最多评论）
function handleSetSearchSort(msg, sendResponse) {
  var sortType = msg.sortType;
  if (!sortType || sortType === 'general') {
    sendResponse({ ok: true, active: true, message: '默认综合排序' });
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

  // 目标候选别名列表
  var targetNames = [targetName];
  if (sortType === 'time_descending') {
    targetNames = ['最新', '最新发布'];
  } else if (sortType === 'popularity_descending') {
    targetNames = ['最多点赞', '最热'];
  } else if (sortType === 'comments_descending') {
    targetNames = ['最多评论'];
  }

  // 响应校验函数：等待 React 异步更新 DOM 并渲染 active 类
  function verifyAndRespond(clickedEl, extra) {
    extra = extra || {};
    var checkStart = Date.now();
    var checkTimer = safeSetInterval(function () {
      if (isOptionActive(clickedEl)) {
        safeClearInterval(checkTimer);
        sendResponse(Object.assign({ ok: true, switched: true, active: true }, extra));
        return;
      }

      // 实时全页面扫描是否有匹配 targetNames 且处于 active 的胶囊
      var activeCapsule = null;
      var tabs = document.querySelectorAll('button, div, span');
      for (var t = 0; t < tabs.length; t++) {
        var tabNode = tabs[t];
        if (!isElementVisible(tabNode) || isCategoryTabOrNav(tabNode)) continue;
        var txt = (tabNode.textContent || '').trim();
        if (targetNames.indexOf(txt) !== -1 && isOptionActive(tabNode)) {
          activeCapsule = tabNode;
          break;
        }
      }
      if (activeCapsule) {
        safeClearInterval(checkTimer);
        sendResponse(Object.assign({ ok: true, switched: true, active: true }, extra));
        return;
      }

      // 延长检测窗口至 600ms（留足 React 提交状态与 DOM Diff 的时间）
      if (Date.now() - checkStart >= 600) {
        safeClearInterval(checkTimer);
        sendResponse(Object.assign({ ok: true, switched: true, active: false }, extra));
      }
    }, 40);
  }

  // 步骤 0：若指定了限定区域 (regionSelector)
  var scopedContainer = null;
  if (Array.isArray(msg.regionSelector) && msg.regionSelector.length > 0) {
    for (var rs = 0; rs < msg.regionSelector.length; rs++) {
      try {
        var foundReg = document.querySelector(msg.regionSelector[rs]);
        if (foundReg && !isCategoryTabOrNav(foundReg)) {
          scopedContainer = foundReg;
          break;
        }
      } catch (_) {}
    }
  }

  if (scopedContainer) {
    // 优先在限定区域内直接查找并点击
    var targetInRegion = null;
    if (Array.isArray(msg.sortOption) && msg.sortOption.length > 0) {
      for (var so = 0; so < msg.sortOption.length; so++) {
        try {
          var matchedList = scopedContainer.querySelectorAll(msg.sortOption[so]);
          if (matchedList && matchedList.length > 0) {
            targetInRegion = matchedList[0];
            break;
          }
        } catch (_) {}
      }
    }
    if (!targetInRegion && typeof scopedContainer.querySelectorAll === 'function') {
      var inRegNodes = scopedContainer.querySelectorAll('button, div, span, a');
      for (var ir = 0; ir < inRegNodes.length; ir++) {
        var irt = (inRegNodes[ir].textContent || '').trim();
        if (targetNames.indexOf(irt) !== -1) {
          targetInRegion = inRegNodes[ir];
          break;
        }
      }
    }
    if (targetInRegion) {
      triggerMouseClick(targetInRegion);
      verifyAndRespond(targetInRegion, { scoped: true });
      return true;
    }
  }

  // 在浮层内查找目标胶囊
  function findOptionInPopup(popup) {
    if (!popup) return null;
    var candidates = [];
    if (typeof popup.querySelectorAll === 'function') {
      candidates = popup.querySelectorAll('button, div, span, a');
    } else if (popup.children) {
      candidates = popup.children;
    }
    // 优先匹配胶囊按钮（button 或含 tab/capsule/btn 的元素）
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isElementVisible(el) || isCategoryTabOrNav(el)) continue;
      var t = (el.textContent || '').trim();
      if (targetNames.indexOf(t) !== -1) {
        var isPill = el.tagName === 'BUTTON' || /\b(tab|btn|capsule|pill|tag|item)\b/i.test(el.className || '');
        if (isPill) return el;
      }
    }
    // 兜底匹配普通子节点
    for (var j = 0; j < candidates.length; j++) {
      var el2 = candidates[j];
      if (!isElementVisible(el2) || isCategoryTabOrNav(el2)) continue;
      var t2 = (el2.textContent || '').trim();
      if (targetNames.indexOf(t2) !== -1) {
        return el2;
      }
    }
    return null;
  }

  function tryClickTarget(inPopupOnly) {
    var popup = findSortPopup();
    if (popup) {
      var opt = findOptionInPopup(popup);
      if (opt) {
        triggerMouseClick(opt);
        return opt;
      }
    }
    // 若要求仅在浮层内匹配，未在浮层找到直接返回 null
    if (inPopupOnly) {
      return null;
    }

    // 步骤 2 展开浮层后的精准匹配（遍历页面所有可见非导航元素，精确匹配目标名称）
    var all = document.querySelectorAll('button, div, span');
    // 优先匹配顶部 450px 内的胶囊按钮
    for (var i = 0; i < all.length; i++) {
      var cur = all[i];
      if (!isElementVisible(cur) || isCategoryTabOrNav(cur)) continue;
      var text = (cur.textContent || '').trim();
      if (targetNames.indexOf(text) !== -1) {
        var r = typeof cur.getBoundingClientRect === 'function' ? cur.getBoundingClientRect() : null;
        if (!r || (r.top >= 0 && r.top <= 450 && r.left >= 100)) {
          var isPill = cur.tagName === 'BUTTON' || /\b(tab|btn|capsule|pill|tag|item)\b/i.test(cur.className || '');
          if (isPill) {
            triggerMouseClick(cur);
            return cur;
          }
        }
      }
    }
    // 兜底匹配任意符合文本的可见元素
    for (var j = 0; j < all.length; j++) {
      var cur2 = all[j];
      if (!isElementVisible(cur2) || isCategoryTabOrNav(cur2)) continue;
      var text2 = (cur2.textContent || '').trim();
      if (targetNames.indexOf(text2) !== -1) {
        var r2 = typeof cur2.getBoundingClientRect === 'function' ? cur2.getBoundingClientRect() : null;
        if (!r2 || (r2.top >= 0 && r2.top <= 450 && r2.left >= 100)) {
          triggerMouseClick(cur2);
          return cur2;
        }
      }
    }

    // 兼容 XPath / 文本匹配兜底（在 Node 沙箱或轻量 DOM 中命中）
    for (var k = 0; k < targetNames.length; k++) {
      var name = targetNames[k];
      var exactXpath = "//*[normalize-space(.)=" + JSON.stringify(name) + "]";
      var exactNode = findFirstElement([exactXpath], true);
      if (exactNode && !isCategoryTabOrNav(exactNode)) {
        var exactTxt = (exactNode.textContent || '').trim();
        if (targetNames.indexOf(exactTxt) !== -1) {
          triggerMouseClick(exactNode);
          return exactNode;
        }
      }
      var textNode = findFirstElement([name], true);
      if (textNode && !isCategoryTabOrNav(textNode)) {
        var txt = (textNode.textContent || '').trim();
        if (targetNames.indexOf(txt) !== -1) {
          triggerMouseClick(textNode);
          return textNode;
        }
      }
    }

    return null;
  }

  // 步骤 1：若浮层已展开，直接在浮层中点击（严格禁止在浮层未展开时匹配全局文字）
  var directClicked = tryClickTarget(true);
  if (directClicked) {
    verifyAndRespond(directClicked, { direct: true });
    return true;
  }

  // 步骤 2：若尚未展开，点击右上角「筛选 / 已筛选」按钮展开
  var toggleBtn = findFilterToggleBtn();
  if (toggleBtn) {
    triggerMouseClick(toggleBtn);
  }

  // 步骤 3：轮询等待浮层挂载并点击
  var pollInterval = 50;
  var retriedCount = 0;
  var pollTimer = safeSetInterval(function () {
    var clicked = tryClickTarget(false);
    if (clicked) {
      safeClearInterval(pollTimer);
      verifyAndRespond(clicked);
      return;
    }
    // 若轮询 250ms、500ms 后依然未检测到浮层展开，多阶段重试点击与悬停展开
    var elapsed = Date.now() - startTime;
    if (elapsed >= 250 && retriedCount === 0 && toggleBtn) {
      retriedCount = 1;
      triggerMouseClick(toggleBtn);
    } else if (elapsed >= 500 && retriedCount === 1 && toggleBtn) {
      retriedCount = 2;
      triggerMouseClick(toggleBtn.parentElement || toggleBtn);
    }

    if (elapsed >= timeout) {
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
          if (!r || (r.top >= 0 && r.top <= 450)) {
            fallbackOpt = n;
            break;
          }
        }
      }
      if (fallbackOpt) {
        triggerMouseClick(fallbackOpt);
        verifyAndRespond(fallbackOpt, { fallback: true });
      } else {
        sendResponse({ ok: false, error: 'SORT_OPTION_NOT_FOUND', active: false });
      }
    }
  }, pollInterval);

  return true; // 异步响应
}

// checkGoalContract：检查当前目标契约在页面 DOM 中是否已满足
function handleCheckGoalContract(msg, sendResponse) {
  var goal = msg.goal || {};
  var achieved = false;
  var currentActive = '';

  if (goal.type === 'search_sort') {
    var targetNames = Array.isArray(goal.targetNames) ? goal.targetNames : [goal.targetLabel || '最新'];
    var tabs = document.querySelectorAll('button, div, span');
    for (var t = 0; t < tabs.length; t++) {
      var tabNode = tabs[t];
      if (!isElementVisible(tabNode) || isCategoryTabOrNav(tabNode)) continue;
      var txt = (tabNode.textContent || '').trim();
      if (targetNames.indexOf(txt) !== -1 && isOptionActive(tabNode)) {
        achieved = true;
        currentActive = txt;
        break;
      }
    }
  }

  sendResponse({
    ok: true,
    achieved: achieved,
    currentActive: currentActive,
    url: typeof window !== 'undefined' && window.location ? window.location.href : '',
  });
  return false;
}

// executeActionRecipe：执行原子动作配方（如根据选择器执行全套拟人交互）
function handleExecuteActionRecipe(msg, sendResponse) {
  var recipe = msg.recipe || {};
  var selectors = [];
  if (Array.isArray(recipe.selectors)) {
    selectors = recipe.selectors;
  } else if (Array.isArray(recipe.selector)) {
    selectors = recipe.selector;
  } else if (typeof recipe.selector === 'string') {
    selectors = [recipe.selector];
  } else if (typeof recipe.selectors === 'string') {
    selectors = [recipe.selectors];
  }
  var el = findFirstElement(selectors, false);
  if (!el) {
    sendResponse({ ok: false, error: 'SELECTOR_NOT_FOUND' });
    return false;
  }

  try {
    triggerMouseClick(el);
    sendResponse({ ok: true, executed: true });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
  return false;
}

// applySearchFilters：在搜索结果页依次应用多维筛选（排序依据、笔记类型、发布时间等）并收起面板
function handleApplySearchFilters(msg, sendResponse) {
  var filters = msg.filters || {};

  // 1. 若浮层未展开，先主动点击筛选按钮展开浮层
  var popup = typeof findSortPopup === 'function' ? findSortPopup() : null;
  var filterBtn = typeof findFilterToggleBtn === 'function' ? findFilterToggleBtn() : null;
  if (!popup && filterBtn) {
    triggerMouseClick(filterBtn);
  }

  // 映射目标文本
  var targetsToClick = [];
  if (filters.sortType && filters.sortType !== 'general') {
    if (filters.sortType === 'popularity_descending') targetsToClick.push(['最多点赞', '最热']);
    else if (filters.sortType === 'time_descending') targetsToClick.push(['最新', '最新发布']);
    else if (filters.sortType === 'comments_descending') targetsToClick.push(['最多评论']);
    else if (filters.sortType === 'collects_descending') targetsToClick.push(['最多收藏']);
  }
  if (filters.noteType && filters.noteType !== 'all') {
    if (filters.noteType === 'video') targetsToClick.push(['视频']);
    else if (filters.noteType === 'image') targetsToClick.push(['图文']);
  }
  if (filters.publishTime && filters.publishTime !== 'all') {
    if (filters.publishTime === 'day') targetsToClick.push(['一天内']);
    else if (filters.publishTime === 'week') targetsToClick.push(['一周内']);
    else if (filters.publishTime === 'half_year') targetsToClick.push(['半年内']);
  }
  if (filters.searchScope && filters.searchScope !== 'all') {
    if (filters.searchScope === 'seen') targetsToClick.push(['已看过']);
    else if (filters.searchScope === 'unseen') targetsToClick.push(['未看过']);
    else if (filters.searchScope === 'followed') targetsToClick.push(['已关注']);
  }
  if (filters.location && filters.location !== 'all') {
    if (filters.location === 'same_city') targetsToClick.push(['同城']);
    else if (filters.location === 'nearby') targetsToClick.push(['附近']);
  }

  var applied = {};

  // 辅助：查找指定名称的胶囊按钮
  function findCapsule(names) {
    for (var j = 0; j < names.length; j++) {
      var name = names[j];
      var el = findFirstElement(["//*[normalize-space(.)='" + name + "']", name], false);
      if (el && !isCategoryTabOrNav(el)) return el;
    }
    var all = document.querySelectorAll('button, div, span');
    for (var i = 0; i < all.length; i++) {
      var item = all[i];
      if (!isElementVisible(item) || isCategoryTabOrNav(item)) continue;
      var txt = (item.textContent || '').trim();
      for (var k = 0; k < names.length; k++) {
        if (txt === names[k]) return item;
      }
    }
    return null;
  }

  // 依次点击选中的胶囊
  for (var k = 0; k < targetsToClick.length; k++) {
    var names = targetsToClick[k];
    var el = findCapsule(names);
    if (el) {
      triggerMouseClick(el);
      applied[names[0]] = true;
    }
  }

  // 点击完成后，尝试点击“收起”按钮关闭面板
  var collapseEl = findCapsule(['收起']);
  if (!collapseEl) {
    collapseEl = findFirstElement(["//*[normalize-space(.)='收起']", "收起"], false);
  }
  if (collapseEl) {
    triggerMouseClick(collapseEl);
  }

  sendResponse({ ok: true, applied: applied });
  return false;
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
      case 'applySearchFilters':
        return handleApplySearchFilters(message, sendResponse);
      case 'getInteractiveRegionHtml':
        return handleGetInteractiveRegionHtml(message, sendResponse);
      case 'verifySelectors':
        return handleVerifySelectors(message, sendResponse);
      case 'checkGoalContract':
        return handleCheckGoalContract(message, sendResponse);
      case 'executeActionRecipe':
        return handleExecuteActionRecipe(message, sendResponse);
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
    handleApplySearchFilters: handleApplySearchFilters,
    handleGetInteractiveRegionHtml: handleGetInteractiveRegionHtml,
    handleVerifySelectors: handleVerifySelectors,
    handleCheckGoalContract: handleCheckGoalContract,
    handleExecuteActionRecipe: handleExecuteActionRecipe,
  };
}


