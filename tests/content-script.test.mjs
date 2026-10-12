// Content Script 单元测试（TDD：先写测试，后实现）。
//
// 由于 content script 是 MV3 的 CLASSIC 脚本（不能用 import/export），本测试通过
// Node 的 vm 模块把真实的 src/content/content-script.js 源码加载进一个沙箱（sandbox），
// 在沙箱内注入 mock 的 document / window / chrome / setTimeout 等浏览器全局，
// 然后驱动脚本向 chrome.runtime.onMessage 注册的处理器，断言其行为。
//
// 覆盖要点：
//  1. findFirstElement 的多级备选顺序：CSS 优先 → XPath → 文本包含（证明顺序）。
//  2. steppedScroll 的分段拟人滚动：累积滚动量 ≈ distance，多次调用 scrollBy，最终 resolve。
//  3. onMessage 分发各动作：click / type / getHTML / waitFor / scroll / closeModal / eval
//     均返回 { ok, data?, error? } 形状，错误分支正确。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(__dirname, '..', 'src', 'content', 'content-script.js');

// ----------------------------------------------------------------------------
// 加载真实源码。文件缺失时 readFileSync 抛错 → 整个测试套件失败（符合 TDD 预期）。
// ----------------------------------------------------------------------------
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

// ----------------------------------------------------------------------------
// Mock DOM / Window / Chrome / 计时器
// ----------------------------------------------------------------------------
const docState = {
  cssMatches: {}, // sel -> element（CSS 命中）
  xpathMatches: {}, // xpathExpr -> element（XPath 命中）
  textMatches: {}, // needle -> element（文本包含命中）
  textMatchesDeep: {}, // needle -> [ancestor, deepest, ...]（多节点快照）
  setterCalls: 0, // 原生 value setter 被调用次数（验证 React 路径）
  cssThrows: false, // 模拟 querySelector 抛 SyntaxError（非法选择器）
  scrollTotal: 0,
  scrollCalls: 0,
  dispatched: [], // closeModal 派发的事件
};

class MockKeyboardEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.key = opts.key || '';
    this.keyCode = opts.keyCode || 0;
    this.bubbles = !!opts.bubbles;
  }
}

class MockEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
  }
}

const mockWindow = {
  scrollBy(x, y) {
    docState.scrollTotal += y;
    docState.scrollCalls += 1;
  },
  scrollTo() {},
  dispatchEvent(evt) {
    docState.dispatched.push(evt);
    return true;
  },
  KeyboardEvent: MockKeyboardEvent,
  Event: MockEvent,
  // React 受控组件的原生 value 描述符（用于 setValue 走原生 setter 分支）。
  // 必须是真正的存取器属性，否则 getOwnPropertyDescriptor().set 为 undefined。
  HTMLInputElement: {
    prototype: {
      get value() {
        return this._value;
      },
      set value(v) {
        docState.setterCalls += 1;
        this._value = v;
      },
    },
  },
};

// 文本匹配用的 XPath 形如：//*[contains(normalize-space(.), "needle")]
const TEXT_XPATH_RE = /contains\(\s*normalize-space\([^)]*\)\s*,\s*["'](.*?)["']\s*\)/;

const mockDocument = {
  querySelector(sel) {
    if (docState.cssThrows) throw new SyntaxError('invalid selector');
    return docState.cssMatches[sel] || null;
  },
  // 模拟 document.evaluate（XPathResult.FIRST_ORDERED_NODE_TYPE 的结果对象）。
  evaluate(xpathExpr) {
    if (docState.xpathMatches[xpathExpr]) {
      return { singleNodeValue: docState.xpathMatches[xpathExpr], iterateNext: () => null };
    }
    const m = TEXT_XPATH_RE.exec(xpathExpr);
    if (m) {
      const needle = m[1];
      if (docState.textMatchesDeep[needle]) {
        const list = docState.textMatchesDeep[needle];
        return { snapshotLength: list.length, snapshotItem: (i) => list[i], singleNodeValue: list[0], iterateNext: () => null };
      }
      if (docState.textMatches[needle]) {
        const el = docState.textMatches[needle];
        // 文本包含路径：返回 snapshot 形态（source 取最深节点 snapshotItem(length-1)）。
        return { snapshotLength: 1, snapshotItem: () => el, singleNodeValue: el, iterateNext: () => null };
      }
    }
    return { snapshotLength: 0, snapshotItem: () => null, singleNodeValue: null, iterateNext: () => null };
  },
  querySelectorAll(sel) {
    if (docState.allMatches && docState.allMatches[sel]) {
      return docState.allMatches[sel];
    }
    return [];
  },
  createElement() {
    return makeElement('div');
  },
  dispatchEvent(evt) {
    docState.dispatched.push(evt);
    return true;
  },
};

function makeElement(tag = 'div', props = {}) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    className: props.className != null ? props.className : '',
    textContent: props.textContent != null ? props.textContent : '',
    outerHTML: props.outerHTML != null ? props.outerHTML : `<${tag}>${(props.textContent || '')}</${tag}>`,
    type: props.type != null ? props.type : undefined,
    get value() {
      return this._value != null ? this._value : '';
    },
    set value(v) {
      this._value = v;
    },
    _clicked: false,
    click() {
      this._clicked = true;
      docState.lastClicked = this;
    },
    dispatchEvent(evt) {
      docState.dispatched.push(evt);
      return true;
    },
    getAttribute(name) {
      return props[name] != null ? props[name] : null;
    },
    querySelectorAll(sel) {
      return docState.allMatches && docState.allMatches[sel] ? docState.allMatches[sel] : (this.children || []);
    },
  };
}

const mockChrome = {
  runtime: {
    onMessage: {
      listeners: [],
      addListener(fn) {
        this.listeners.push(fn);
      },
    },
  },
};

// 注入到 vm 沙箱。标准内置（Promise/Math/Date/JSON/Array/Function）由 vm 自动提供，
// 这里显式注入浏览器/宿主侧的对象与计时器。
const sandbox = {
  document: mockDocument,
  window: mockWindow,
  chrome: mockChrome,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  KeyboardEvent: MockKeyboardEvent,
  Event: MockEvent,
};
vm.createContext(sandbox);

// 执行真实源码：会向 chrome.runtime.onMessage 注册监听器，并把 findFirstElement /
// steppedScroll 等声明为全局函数（classic 脚本顶层 function 声明即全局属性）。
vm.runInContext(source, sandbox);

const handler = mockChrome.runtime.onMessage.listeners[0];
assert.ok(typeof handler === 'function', 'content script 应注册 onMessage 监听器');

function resetDoc() {
  docState.cssMatches = {};
  docState.xpathMatches = {};
  docState.textMatches = {};
  docState.textMatchesDeep = {};
  docState.allMatches = {};
  docState.setterCalls = 0;
  docState.cssThrows = false;
  docState.scrollTotal = 0;
  docState.scrollCalls = 0;
  docState.dispatched = [];
  docState.lastClicked = null;
}

// 调用处理器并捕获 sendResponse 的响应（支持同步与异步 handler）。
function dispatch(message) {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const sendResponse = (resp) => resolve(resp);
  const ret = handler(message, {}, sendResponse);
  return { ret, response: promise };
}

// ============================================================================
// 1) findFirstElement 多级备选顺序
// ============================================================================

test('findFirstElement：CSS 命中优先于 XPath / 文本', () => {
  resetDoc();
  const cssEl = makeElement('a', { textContent: 'link' });
  docState.cssMatches['#css'] = cssEl;
  const got = sandbox.findFirstElement(['#css']);
  assert.equal(got, cssEl, '应直接返回 CSS 命中的元素');
});

test('findFirstElement：CSS 失败但 XPath 命中 → 返回 XPath 元素', () => {
  resetDoc();
  const xpathEl = makeElement('div', { id: 'x' });
  // 候选作为 XPath 表达式命中
  docState.xpathMatches["//div[@id='x']"] = xpathEl;
  const got = sandbox.findFirstElement(["//div[@id='x']"]);
  assert.equal(got, xpathEl, 'CSS 未命中时应退回到 XPath 命中');
});

test('findFirstElement：CSS + XPath 均失败，文本包含命中 → 返回文本元素', () => {
  resetDoc();
  const textEl = makeElement('button', { textContent: '立即登录' });
  docState.textMatches['登录'] = textEl;
  const got = sandbox.findFirstElement(['登录']);
  assert.equal(got, textEl, 'CSS/XPath 都失败时退回到文本包含匹配');
});

test('findFirstElement：全部失败返回 null', () => {
  resetDoc();
  const got = sandbox.findFirstElement(['#nope', '//div[@id="y"]', '没有这个文本']);
  assert.equal(got, null, '无任何命中时应返回 null');
});

test('findFirstElement：CSS 抛 SyntaxError 时应回退到 XPath 命中', () => {
  resetDoc();
  docState.cssThrows = true; // 模拟 querySelector 对非法选择器抛错
  const xpathEl = makeElement('div', { id: 'x' });
  docState.xpathMatches["//div[@id='x']"] = xpathEl;
  const got = sandbox.findFirstElement(["//div[@id='x']"]);
  assert.equal(got, xpathEl, 'CSS 抛错后应收敛到 XPath 命中');
});

test('findFirstElement：CSS 抛错且 XPath 无匹配时回退到文本包含', () => {
  resetDoc();
  docState.cssThrows = true;
  const textEl = makeElement('button', { textContent: '立即登录' });
  docState.textMatches['登录'] = textEl;
  const got = sandbox.findFirstElement(['登录']);
  assert.equal(got, textEl, 'CSS 抛错、XPath 无果时应回退到文本包含匹配');
});

test('findFirstElement：文本包含命中多个节点时返回【最内层】节点', () => {
  resetDoc();
  const ancestor = makeElement('div', { textContent: '登录相关段落' });
  const deep = makeElement('button', { textContent: '立即登录' });
  docState.textMatchesDeep['登录'] = [ancestor, deep];
  const got = sandbox.findFirstElement(['登录']);
  assert.equal(got, deep, '应返回文档序最后的（最内层）节点而非外层包裹元素');
});

// ============================================================================
// 2) steppedScroll 分段拟人滚动
// ============================================================================

test('steppedScroll：累积滚动量等于 distance，多次调用 scrollBy 并最终 resolve', async () => {
  resetDoc();
  const distance = 240;
  const duration = 240; // 每步 ~80ms → 3 步
  const p = sandbox.steppedScroll(distance, duration);
  assert.ok(p && typeof p.then === 'function', '应返回 Promise');
  await p;
  assert.ok(
    Math.abs(docState.scrollTotal - distance) < 1e-6,
    `累积滚动位移应≈distance（实际 ${docState.scrollTotal}）`
  );
  assert.ok(docState.scrollCalls >= 2, '应分多步滚动，而非一次性滚动');
});

// ============================================================================
// 3) onMessage 分发
// ============================================================================

test('onMessage click：命中 → { ok: true } 且调用了 .click()', async () => {
  resetDoc();
  const el = makeElement('button', { textContent: 'go' });
  docState.cssMatches['#go'] = el;
  const { ret, response } = dispatch({ action: 'click', selectors: ['#go'] });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.error, undefined);
  assert.equal(el._clicked, true, '应触发元素 .click()');
  assert.equal(ret, false, '同步动作应返回 false（已同步 sendResponse）');
});

test('onMessage click：未命中 → { ok: false, error: SELECTOR_NOT_FOUND }', async () => {
  resetDoc();
  const { response } = dispatch({ action: 'click', selectors: ['#missing'] });
  const resp = await response;
  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'SELECTOR_NOT_FOUND');
});

test('onMessage getHTML：命中 → { ok: true, data: outerHTML }', async () => {
  resetDoc();
  const el = makeElement('section', { outerHTML: '<section>笔记</section>' });
  docState.cssMatches['.note'] = el;
  const { response } = dispatch({ action: 'getHTML', selectors: ['.note'] });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.data, '<section>笔记</section>');
});

test('onMessage getHTML：针对搜索页自适应提取核心交互骨架（筛选栏+代表性卡片），避免整页截断', async () => {
  resetDoc();
  // 模拟搜索页元素
  const filterBtn = makeElement('div', { className: 'filter-box', textContent: '筛选' });
  const card1 = makeElement('section', { className: 'note-item', outerHTML: '<div class="note-item">卡片1</div>' });
  const card2 = makeElement('section', { className: 'note-item', outerHTML: '<div class="note-item">卡片2</div>' });

  docState.allMatches = {
    'a[href*="/explore/"], a[href*="/search_result/"], section, .note-item': [card1, card2],
  };
  docState.cssMatches['.filter-box'] = filterBtn;
  docState.textMatches['筛选'] = filterBtn;

  const { response } = dispatch({
    action: 'getHTML',
    targetType: 'search',
    selectors: ['body'],
  });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.ok(typeof resp.data === 'string');
  assert.ok(resp.data.includes('卡片1') || resp.data.includes('filter-box') || resp.data.includes('筛选'));
});

test('onMessage getText：命中 → { ok: true, data: textContent }', async () => {
  resetDoc();
  const el = makeElement('p', { textContent: '正文内容' });
  docState.cssMatches['.content'] = el;
  const { response } = dispatch({ action: 'getText', selectors: ['.content'] });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.data, '正文内容');
});

test('onMessage waitFor：元素立即存在 → { ok: true }', async () => {
  resetDoc();
  docState.cssMatches['#ready'] = makeElement('div');
  const { response } = dispatch({ action: 'waitFor', selectors: ['#ready'], timeout: 1000 });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.error, undefined);
});

test('onMessage waitFor：永不命中 → { ok: false, error: TIMEOUT }', async () => {
  resetDoc();
  const { ret, response } = dispatch({ action: 'waitFor', selectors: ['#never'], timeout: 150 });
  const resp = await response;
  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'TIMEOUT');
  assert.equal(ret, true, '异步动作应返回 true 以保持消息通道开放');
});

test('onMessage scroll：异步分步滚动 → { ok: true }', async () => {
  resetDoc();
  const { ret, response } = dispatch({ action: 'scroll', distance: 240, duration: 240 });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(ret, true);
  assert.ok(Math.abs(docState.scrollTotal - 240) < 1e-6, 'scroll 应真正执行滚动');
});

test('onMessage closeModal：派发 Escape 事件 → { ok: true }', async () => {
  resetDoc();
  const { response } = dispatch({ action: 'closeModal' });
  const resp = await response;
  assert.equal(resp.ok, true);
  const escape = docState.dispatched.find((e) => e.key === 'Escape');
  assert.ok(escape, '应派发 Escape 键盘事件以关闭弹窗');
});

test('onMessage eval：执行脚本字符串并返回结果 → { ok: true, data }', async () => {
  resetDoc();
  const { response } = dispatch({ action: 'eval', script: 'return 2 + 3' });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.data, 5);
});

test('onMessage 未知动作 → { ok: false, error: UNKNOWN_ACTION }', async () => {
  resetDoc();
  const { response } = dispatch({ action: 'frobnicate' });
  const resp = await response;
  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'UNKNOWN_ACTION');
});

test('onMessage type：命中输入框 → 写入 value 并派发 input/change 事件 → { ok: true }', async () => {
  resetDoc();
  const input = makeElement('input');
  docState.cssMatches['#search'] = input;
  const { response } = dispatch({ action: 'type', selectors: ['#search'], text: '护肤推荐' });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(input.value, '护肤推荐', '应把文本写入输入框 value');
  assert.ok(docState.setterCalls >= 1, '应通过原生原型 setter 写入（兼容 React 受控组件）');
  const types = docState.dispatched.map((e) => e.type);
  assert.ok(types.includes('input'), '应派发 input 事件');
  assert.ok(types.includes('change'), '应派发 change 事件');
});

test('onMessage type：未命中 → { ok: false, error: SELECTOR_NOT_FOUND }', async () => {
  resetDoc();
  const { response } = dispatch({ action: 'type', selectors: ['#missing'], text: 'x' });
  const resp = await response;
  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'SELECTOR_NOT_FOUND');
});

test('onMessage waitFor：requireVisible 为 true 时跳过 display:none 等不可见元素', async () => {
  resetDoc();
  const hiddenEl = makeElement('div');
  hiddenEl.offsetParent = null; // 模拟不可见（在真实 DOM 中 display:none 导致 offsetParent 为 null）
  hiddenEl.style = { display: 'none' };
  docState.cssMatches['.modal-mask'] = hiddenEl;

  // 1. 常规 waitFor（未要求 requireVisible）：依然能命中
  const normal = dispatch({ action: 'waitFor', selectors: ['.modal-mask'], timeout: 100 });
  const normalResp = await normal.response;
  assert.equal(normalResp.ok, true);

  // 2. 携带 requireVisible: true：跳过不可见元素，超时并返回 TIMEOUT
  const visibleOnly = dispatch({ action: 'waitFor', selectors: ['.modal-mask'], requireVisible: true, timeout: 100 });
  const visibleResp = await visibleOnly.response;
  assert.equal(visibleResp.ok, false);
  assert.equal(visibleResp.error, 'TIMEOUT');
});

test('onMessage getNoteDetail：提取标题、正文以及新增的收藏数、发布日期、封面图', async () => {
  resetDoc();
  docState.cssMatches['.note-title'] = makeElement('h1', { textContent: '测试笔记标题' });
  docState.cssMatches['#detail-desc'] = makeElement('div', { textContent: '测试正文内容' });
  docState.cssMatches['.username'] = makeElement('span', { textContent: '小红薯达人' });
  docState.cssMatches['.like-wrapper .count'] = makeElement('span', { textContent: '350' });
  docState.cssMatches['.collect-wrapper .count'] = makeElement('span', { textContent: '128' });
  docState.cssMatches['.date'] = makeElement('span', { textContent: '2026-10-10 14:00' });
  
  // 模拟图片
  const img = makeElement('img');
  img.src = 'https://sns-img.xhscdn.com/cover.jpg';
  docState.allMatches['.note-slider img, div[class*="image"] img, .media-container img, [class*="swiper"] img'] = [img];

  const { response } = dispatch({ action: 'getNoteDetail', selectors: ['.note-title'] });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.data.title, '测试笔记标题');
  assert.equal(resp.data.collects, 128);
  assert.equal(resp.data.publishedAt, '2026-10-10 14:00');
  assert.equal(resp.data.coverUrl, 'https://sns-img.xhscdn.com/cover.jpg');
});

test('onMessage getNoteUrls：保留带 xsec_token 的完整 URL 且补全域名', async () => {
  resetDoc();
  const a1 = makeElement('a', {
    href: '/explore/6a44fd5f00000000110102b9?xsec_token=ABDVsoY00ucAH0BLIM3X3d7CDWFZr6X0PEPVmR0ewM4wk=&xsec_source=pc_feed'
  });
  docState.allMatches['a[href*="/search_result/"], a[href*="/explore/"]'] = [a1];

  const { response } = dispatch({ action: 'getNoteUrls' });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.data.length, 1);
  assert.equal(
    resp.data[0],
    'https://www.xiaohongshu.com/explore/6a44fd5f00000000110102b9?xsec_token=ABDVsoY00ucAH0BLIM3X3d7CDWFZr6X0PEPVmR0ewM4wk=&xsec_source=pc_feed'
  );
});

test('onMessage getNoteDetail：提取 authorId、authorUrl、totalComments，并将万级计数解析为纯数字', async () => {
  resetDoc();
  docState.cssMatches['.note-title'] = makeElement('h1', { textContent: '万赞爆款笔记' });
  docState.cssMatches['#detail-desc'] = makeElement('div', { textContent: '正文内容' });
  docState.cssMatches['.username'] = makeElement('span', { textContent: 'Coco' });
  docState.cssMatches['.like-wrapper .count'] = makeElement('span', { textContent: '3.3万' });
  docState.cssMatches['.collect-wrapper .count'] = makeElement('span', { textContent: '1.2万' });
  docState.cssMatches['.chat-wrapper .count'] = makeElement('span', { textContent: '458' });
  docState.cssMatches['a[href*="/user/profile/"]'] = makeElement('a', {
    href: '/user/profile/5c15a50d000000000703b76c?channel_type=explore_feed'
  });

  const { response } = dispatch({ action: 'getNoteDetail', selectors: ['.note-title'] });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.data.likes, 33000);
  assert.equal(resp.data.collects, 12000);
  assert.equal(resp.data.totalComments, 458);
  assert.equal(resp.data.authorId, '5c15a50d000000000703b76c');
  assert.equal(resp.data.authorUrl, 'https://www.xiaohongshu.com/user/profile/5c15a50d000000000703b76c?channel_type=explore_feed');
});


test('onMessage getComments：提取评论并包含 IP 属地、作者标记与楼中楼层级', async () => {
  resetDoc();
  const c1 = makeElement('div', { className: 'comment-item' });
  const c1Auth = makeElement('span', { className: 'name', textContent: '楼主粉丝' });
  const c1Text = makeElement('div', { className: 'content', textContent: '真不错！' });
  const c1Date = makeElement('span', { className: 'date', textContent: '03-12 广东' });
  c1.querySelector = (sel) => {
    if (sel.includes('name')) return c1Auth;
    if (sel.includes('content')) return c1Text;
    if (sel.includes('date')) return c1Date;
    return null;
  };

  const c2 = makeElement('div', { className: 'comment-item reply-item' });
  const c2Auth = makeElement('span', { className: 'name', textContent: '小红薯达人' });
  const c2Badge = makeElement('span', { className: 'author-badge', textContent: '作者' });
  const c2Text = makeElement('div', { className: 'content', textContent: '感谢支持！' });
  const c2Date = makeElement('span', { className: 'date', textContent: '03-12 浙江' });
  c2.querySelector = (sel) => {
    if (sel.includes('name')) return c2Auth;
    if (sel.includes('author-badge') || sel.includes('author-tag')) return c2Badge;
    if (sel.includes('content')) return c2Text;
    if (sel.includes('date')) return c2Date;
    return null;
  };

  docState.allMatches['.comment-item, div[class*="comment-item"], .parent-comment, div[class*="parent-comment"]'] = [c1, c2];

  const { response } = dispatch({ action: 'getComments', limit: 10 });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.data.length, 2);
  assert.equal(resp.data[0].location, '广东');
  assert.equal(resp.data[0].isAuthor, false);
  assert.equal(resp.data[0].level, 'root');
  assert.equal(resp.data[1].location, '浙江');
  assert.equal(resp.data[1].isAuthor, true);
  assert.equal(resp.data[1].level, 'reply');
});

test('onMessage getComments：解析万级点赞并自动触发展开折叠回复', async () => {
  resetDoc();
  const c1 = makeElement('div', { className: 'comment-item' });
  const c1Auth = makeElement('span', { className: 'name', textContent: '热评大神' });
  const c1Text = makeElement('div', { className: 'content', textContent: '神仙笔记！' });
  const c1Like = makeElement('span', { className: 'count', textContent: '1.2万' });
  c1.querySelector = (sel) => {
    if (sel.includes('name')) return c1Auth;
    if (sel.includes('content')) return c1Text;
    if (sel.includes('like')) return c1Like;
    return null;
  };

  const expandBtn = makeElement('button', { className: 'show-more', textContent: '展开 3 条回复' });
  let clicked = false;
  expandBtn.click = () => { clicked = true; };

  docState.allMatches['.comment-item, div[class*="comment-item"], .parent-comment, div[class*="parent-comment"]'] = [c1];
  docState.allMatches['.show-more, [class*="show-more"], [class*="reply-expand"], [class*="expand-btn"], [class*="reply-more"], [class*="comment-more"]'] = [expandBtn];

  const { response } = dispatch({ action: 'getComments', limit: 10 });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.data[0].likes, 12000);
  assert.equal(clicked, true, '当存在折叠回复按钮时应触发 click 展开');
});

test('parseCount：正确将小红书数值字符串解析为整数', () => {

  // 通过 vm 上下文暴露或在 module.exports 取出
  const fn = sandbox.parseCount;
  assert(typeof fn === 'function', 'parseCount 必须是函数');
  assert.equal(fn('1.3万'), 13000);
  assert.equal(fn('2.5w'), 25000);
  assert.equal(fn('3.3W'), 33000);
  assert.equal(fn('999+'), 999);
  assert.equal(fn('7144'), 7144);
  assert.equal(fn(7144), 7144);
  assert.equal(fn('赞'), 0);
  assert.equal(fn(''), 0);
  assert.equal(fn(null), 0);
  assert.equal(fn(undefined), 0);
  assert.equal(fn('1.5亿'), 150000000);
});

test('onMessage setSearchSort：自动识别并点击筛选浮层中的排序项', async () => {
  resetDoc();
  let filterClicked = false;
  let sortClicked = false;

  const filterBtn = makeElement('div', { textContent: ' 筛选 ' });
  filterBtn.click = () => { filterClicked = true; };

  const sortOption = makeElement('div', { textContent: '最多点赞' });
  sortOption.click = () => { sortClicked = true; };

  // 模拟文本包含命中
  docState.textMatches['筛选'] = filterBtn;
  docState.textMatches['最多点赞'] = sortOption;

  const { response } = dispatch({ action: 'setSearchSort', sortType: 'popularity_descending' });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(sortClicked, true, '应点击最多点赞选项');
});

test('onMessage setSearchSort：在展开的排序依据浮层中精准命中最新/最多点赞胶囊', async () => {
  resetDoc();
  let sortClicked = false;

  const header = makeElement('span', { textContent: '排序依据' });
  const optLatest = makeElement('div', { textContent: '最新' });
  optLatest.click = () => { sortClicked = true; };

  const popup = makeElement('div', { className: 'filter-panel' });
  popup.children = [header, optLatest];
  header.parentElement = popup;
  optLatest.parentElement = popup;

  docState.allMatches = {
    'div, span, p, label, section, h3, h4': [header],
    'button, div, span, a': [optLatest],
  };

  const { response } = dispatch({ action: 'setSearchSort', sortType: 'time_descending' });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(sortClicked, true, '应精准点击排序依据浮层中的【最新】胶囊按钮');
});

test('onMessage setSearchSort：存在左侧分类栏时必须排除分类栏并准确点击右侧筛选按钮', async () => {
  resetDoc();
  let categoryTabClicked = false;
  let filterBtnClicked = false;
  let sortClicked = false;

  // 模拟左侧分类栏，父容器带有 filter-box 类，内部有“图文”、“视频”
  const categoryContainer = makeElement('div', { className: 'filter-box channel-filter' });
  const tabImage = makeElement('div', { textContent: '图文', className: 'tab-item' });
  tabImage.click = () => { categoryTabClicked = true; };
  categoryContainer.children = [tabImage];

  // 模拟右侧真正的筛选按钮
  const realFilterBtn = makeElement('div', { textContent: ' 筛选 ', className: 'filter-btn-trigger' });
  realFilterBtn.click = () => { filterBtnClicked = true; };

  // 排序项
  const sortOption = makeElement('div', { textContent: '最新' });
  sortOption.click = () => { sortClicked = true; };

  docState.cssMatches['[class*="filter-btn"], [class*="filterBtn"], [class*="filterBox"]'] = categoryContainer;
  docState.textMatches['筛选'] = realFilterBtn;
  docState.textMatches['最新'] = sortOption;

  const { response } = dispatch({ action: 'setSearchSort', sortType: 'time_descending' });
  const resp = await response;
  assert.equal(categoryTabClicked, false, '绝不可误触左侧分类栏');
  assert.equal(filterBtnClicked, true, '应点击真正的筛选按钮');
});

test('onMessage setSearchSort：浮层未展开时绝不误判全局文本为排序项', async () => {
  resetDoc();
  let fakeNoteClicked = false;
  let realFilterClicked = false;

  // 页面上存在一篇包含“最新”字样的普通笔记
  const fakeNote = makeElement('div', { textContent: '最新爆款穿搭指南' });
  fakeNote.click = () => { fakeNoteClicked = true; };

  const filterBtn = makeElement('button', { textContent: '筛选' });
  filterBtn.click = () => { realFilterClicked = true; };

  docState.textMatches['最新'] = fakeNote;
  docState.textMatches['筛选'] = filterBtn;

  const { response } = dispatch({ action: 'setSearchSort', sortType: 'time_descending' });
  const resp = await response;
  assert.equal(fakeNoteClicked, false, '绝不可将包含“最新”的普通笔记误判为排序按钮并直接点击');
  assert.equal(realFilterClicked, true, '应先点击展开筛选按钮');
});

test('onMessage setSearchSort：点击嵌套在 span 中的排序胶囊时事件能够冒泡至外层父容器', async () => {
  resetDoc();
  let parentClicked = false;
  let childClicked = false;

  const popup = makeElement('div', { className: 'filter-panel' });
  const header = makeElement('span', { textContent: '排序依据' });
  const optWrapper = makeElement('div', { className: 'capsule-box' });
  const optSpan = makeElement('span', { textContent: '最多点赞' });

  optSpan.parentElement = optWrapper;
  optWrapper.parentElement = popup;
  header.parentElement = popup;
  popup.children = [header, optWrapper];

  optSpan.click = () => { childClicked = true; };
  optWrapper.click = () => { parentClicked = true; };

  docState.allMatches = {
    'div, span, p, label, section, h3, h4': [header],
    'button, div, span, a': [optSpan],
  };

  const { response } = dispatch({ action: 'setSearchSort', sortType: 'popularity_descending' });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(childClicked, true, '子节点 span 应被触发点击');
  assert.equal(parentClicked, true, '包裹胶囊的父容器 div 亦应被触发点击（满足 React 合成事件）');
});

test('onMessage getInteractiveRegionHtml：提取顶部交互控制区域骨架 HTML', async () => {
  resetDoc();
  const filterBtn = makeElement('div', { textContent: ' 筛选 ', className: 'filter-trigger' });
  docState.textMatches['筛选'] = filterBtn;
  docState.cssMatches['.filter, [class*="filter-btn"], [class*="filterBtn"], [class*="filter-trigger"], div[class*="filter"]'] = filterBtn;

  const { response } = dispatch({ action: 'getInteractiveRegionHtml' });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.ok(typeof resp.html === 'string');
  assert.ok(resp.html.includes('filter-trigger') || resp.html.includes('筛选'));
});

test('onMessage setSearchSort：校验胶囊激活态 active 并返回判断结果', async () => {
  resetDoc();
  const header = makeElement('span', { textContent: '排序依据' });
  // 胶囊带有 active 类名
  const optLatest = makeElement('div', { textContent: '最新', className: 'capsule-btn active' });
  const popup = makeElement('div', { className: 'filter-panel' });
  popup.children = [header, optLatest];
  header.parentElement = popup;

  docState.allMatches = {
    'div, span, p, label, section, h3, h4': [header],
    'button, div, span, a': [optLatest],
  };

  const { response } = dispatch({ action: 'setSearchSort', sortType: 'time_descending' });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.active, true, '应当检测到胶囊处于 active 激活态');
});

test('onMessage setSearchSort：支持限定 regionSelector 区域以排除干扰并精准点击', async () => {
  resetDoc();
  let scopedSortClicked = false;
  // 模拟限定区域内的容器与胶囊
  const regionContainer = makeElement('div', { className: 'custom-filter-box' });
  const optLatest = makeElement('span', { textContent: '最新' });
  optLatest.click = () => { scopedSortClicked = true; };
  regionContainer.children = [optLatest];
  regionContainer.querySelectorAll = (sel) => [optLatest];

  docState.cssMatches['.custom-filter-box'] = regionContainer;

  const { response } = dispatch({
    action: 'setSearchSort',
    sortType: 'time_descending',
    regionSelector: ['.custom-filter-box'],
    sortOption: ['span'],
  });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(scopedSortClicked, true, '应在限定区域内找到并点击最新排序选项');
});

test('onMessage verifySelectors：测试候选选择器并返回匹配计数与文本样本', async () => {
  resetDoc();

  const titleEl = makeElement('h1', { textContent: '夏天清爽穿搭灵感指南' });
  const card1 = makeElement('div', { className: 'note-card' });
  const card2 = makeElement('div', { className: 'note-card' });

  docState.cssMatches['h1.title'] = titleEl;
  docState.allMatches = {
    '.note-card': [card1, card2],
    'h1.title': [titleEl],
    '.invalid-selector': [],
  };

  const { response } = dispatch({
    action: 'verifySelectors',
    candidates: {
      'noteDetail.title': ['h1.title', '.backup-title'],
      'search.noteCard': ['.note-card'],
      'search.emptyField': ['.invalid-selector'],
    },
  });

  const resp = await response;
  assert.equal(resp.ok, true);
  assert.ok(resp.results);
  assert.equal(resp.results['noteDetail.title'].valid, true);
  assert.equal(resp.results['noteDetail.title'].matchCount, 1);
  assert.equal(resp.results['noteDetail.title'].sampleText, '夏天清爽穿搭灵感指南');
  assert.equal(resp.results['search.noteCard'].matchCount, 2);
  assert.equal(resp.results['search.emptyField'].valid, false);
  assert.equal(resp.results['search.emptyField'].matchCount, 0);
});

test('onMessage verifySelectors：候选包含排序且浮层未展开时自动触发筛选展开并回测', async () => {
  resetDoc();
  let filterBtnClicked = false;

  const realFilterBtn = makeElement('div', { textContent: ' 筛选 ', className: 'filter-btn-trigger' });
  realFilterBtn.click = () => { filterBtnClicked = true; };

  const sortLatest = makeElement('div', { textContent: '最新' });

  docState.textMatches['筛选'] = realFilterBtn;
  docState.allMatches = {
    '.sort-latest-tab': [sortLatest],
  };

  const { response } = dispatch({
    action: 'verifySelectors',
    candidates: {
      'search.sortTabs.time_descending': ['.sort-latest-tab'],
    },
  });

  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(filterBtnClicked, true, '应自动触发点击展开筛选按钮');
  assert.equal(resp.results['search.sortTabs.time_descending'].valid, true);
  assert.equal(resp.results['search.sortTabs.time_descending'].matchCount, 1);
});

test('onMessage verifySelectors：支持回测 XPath 与文本锚点意图规则', async () => {
  resetDoc();
  const el = makeElement('span', { textContent: '最新发布' });
  docState.textMatches['最新发布'] = el;

  const { response } = dispatch({
    action: 'verifySelectors',
    candidates: {
      'search.sortLatest': ["//*[text()='最新发布']", '最新发布'],
    },
  });

  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.results['search.sortLatest'].valid, true);
  assert.equal(resp.results['search.sortLatest'].matchCount >= 1, true);
  assert.equal(resp.results['search.sortLatest'].sampleText, '最新发布');
});

test('onMessage checkGoalContract：准确报告目标契约是否满足', async () => {
  resetDoc();
  const optLatest = makeElement('button', { textContent: '最新', className: 'tab active' });
  docState.allMatches = {
    'button, div, span': [optLatest],
  };

  const { response } = dispatch({
    action: 'checkGoalContract',
    goal: { type: 'search_sort', targetNames: ['最新', '最新发布'] },
  });

  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.achieved, true, '应检测到目标契约已达成');
});

test('onMessage executeActionRecipe：执行指定选择器的拟人交互', async () => {
  resetDoc();
  let clicked = false;
  const targetBtn = makeElement('button', { textContent: '最新' });
  targetBtn.click = () => { clicked = true; };
  docState.cssMatches['.target-pill'] = targetBtn;

  const { response } = dispatch({
    action: 'executeActionRecipe',
    recipe: { action: 'HOVER_CLICK', selector: ['.target-pill'] },
  });

  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(clicked, true, '应成功触发目标按钮点击');
});

test('onMessage applySearchFilters：依次点击多维筛选胶囊（排序/类型/时间）并收起', async () => {
  resetDoc();
  let filterBtnClicked = false;
  let sortClicked = false;
  let typeClicked = false;
  let timeClicked = false;
  let collapseClicked = false;

  const filterBtn = makeElement('div', { textContent: ' 筛选 ', className: 'filter-btn-trigger' });
  filterBtn.click = () => { filterBtnClicked = true; };

  const sortBtn = makeElement('button', { textContent: '最多评论', className: 'capsule' });
  sortBtn.click = () => { sortClicked = true; };

  const typeBtn = makeElement('button', { textContent: '图文', className: 'capsule' });
  typeBtn.click = () => { typeClicked = true; };

  const timeBtn = makeElement('button', { textContent: '一周内', className: 'capsule' });
  timeBtn.click = () => { timeClicked = true; };

  const collapseBtn = makeElement('span', { textContent: '收起', className: 'collapse-btn' });
  collapseBtn.click = () => { collapseClicked = true; };

  docState.textMatches['筛选'] = filterBtn;
  docState.allMatches = {
    'button, div, span': [sortBtn, typeBtn, timeBtn, collapseBtn],
  };

  const { response } = dispatch({
    action: 'applySearchFilters',
    filters: {
      sortType: 'comments_descending',
      noteType: 'image',
      publishTime: 'week',
    },
  });

  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(filterBtnClicked, true, '应主动展开筛选面板');
  assert.equal(sortClicked, true, '应点击“最多评论”胶囊');
  assert.equal(typeClicked, true, '应点击“图文”胶囊');
  assert.equal(timeClicked, true, '应点击“一周内”胶囊');
  assert.equal(collapseClicked, true, '应点击“收起”关闭浮层');
});

