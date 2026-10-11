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
  querySelectorAll() {
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
