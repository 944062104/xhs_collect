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

// ----------------------------------------------------------------------------
// 多级备选选择器探测：CSS → XPath → 文本包含
// ----------------------------------------------------------------------------
// 对 selectors 数组中的每个候选，依次尝试：
//   1) CSS 选择器：document.querySelector(sel)
//   2) XPath：把 sel 当作 XPath 表达式，document.evaluate(...)
//   3) 文本包含：找出 textContent 包含 sel 的元素（用 XPath contains 实现）
// 返回第一个命中的元素；都没有则 null。
function findFirstElement(selectors) {
  var list = Array.isArray(selectors) ? selectors : [selectors];
  for (var i = 0; i < list.length; i++) {
    var el = trySelect(String(list[i]));
    if (el) return el;
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
  var start = Date.now();

  function poll() {
    var el = findFirstElement(selectors);
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
      case 'type':
        return handleType(message, sendResponse);
      case 'getType':
      case 'getText':
        return handleGetText(message, sendResponse);
      case 'closeModal':
        return handleCloseModal(message, sendResponse);
      case 'eval':
        return handleEval(message, sendResponse);
      default:
        sendResponse({ ok: false, error: 'UNKNOWN_ACTION' });
        return false;
    }
  });
}
