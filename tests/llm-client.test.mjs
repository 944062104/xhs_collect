// LLMClient 单元测试（TDD: 先写测试，后实现）。
//
// 覆盖要点：
//  1. 构造函数对空 apiKey 抛错。
//  2. HTML 冗余标签预清洗（<script>/<style>/<svg>/data: 去除）。
//  3. API 调用封装：正确的 URL、请求头、请求体结构；请求体中【不含】script/style 标记。
//  4. JSON 清洗/容错：干净 JSON、```json 围栏、前后夹带散文、尾随逗号修复、以及非 JSON 抛错。
//
// 全程通过 globalThis.fetch 的 mock 验证行为，不依赖任何 HTTP 库或网络。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient, cleanHtml, extractJson } from '../src/background/llm-client.js';

// ----------------------------------------------------------------------------
// fetch mock 工具：捕获最近一次调用，并在每个用例后还原。
// ----------------------------------------------------------------------------
let lastCall = null;
let fetchImpl = null;

function installFetch(handler) {
  fetchImpl = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    lastCall = { url, opts };
    return handler(url, opts);
  };
}

function restoreFetch() {
  globalThis.fetch = fetchImpl;
  lastCall = null;
}

// 构造一个符合 Claude Messages API 响应形状的 mock 结果。
function jsonResponse(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
  };
}

const EXAMPLE_HTML = `
  <html><head><style>.x{color:red}</style>
  <script>var secret='shouldBeStripped';</script></head>
  <body>
    <svg><path d="M0 0"/></svg>
    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" />
    <section class="note-item">
      <a href="/explore/abc">好物推荐</a>
      <span class="author">小明</span>
      <span class="likes">1.2万</span>
    </section>
  </body></html>
`;

test('构造函数：apiKey 为空时抛错', () => {
  assert.throws(() => new LLMClient(''), /apiKey/i);
  assert.throws(() => new LLMClient(null), /apiKey/i);
  assert.throws(() => new LLMClient(undefined), /apiKey/i);
  // 非空则不抛，且默认模型正确。
  const c = new LLMClient('sk-test');
  assert.equal(c.model, 'claude-3-5-sonnet-latest');
  assert.equal(c.apiKey, 'sk-test');
});

test('构造函数：支持配置自定义 apiBase / baseUrl 与 model', () => {
  const client1 = new LLMClient({ apiKey: 'sk-123', apiBase: 'https://api.my-proxy.com', model: 'claude-3-5-haiku-20241022' });
  assert.equal(client1.apiUrl, 'https://api.my-proxy.com/v1/messages');
  assert.equal(client1.model, 'claude-3-5-haiku-20241022');
  assert.equal(client1.protocol, 'anthropic');

  const client2 = new LLMClient({ apiKey: 'sk-123', apiBase: 'https://api.my-proxy.com/v1/messages/' });
  assert.equal(client2.apiUrl, 'https://api.my-proxy.com/v1/messages');
  assert.equal(client2.protocol, 'anthropic');

  const clientOpenAI = new LLMClient({ apiKey: 'sk-openai-key', apiBase: 'https://api.openai.com', model: 'gpt-4o' });
  assert.equal(clientOpenAI.apiUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(clientOpenAI.protocol, 'openai');
});

test('OpenAI 兼容协议：使用 Authorization Bearer 头并解析 choices[0].message.content', async () => {
  installFetch((url, opts) => {
    assert.equal(opts.headers.authorization, 'Bearer sk-fake-key');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.messages[1].role, 'user');
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify([{ title: 'OpenAI 笔记', url: '/p/1' }]) } }],
    });
  });
  try {
    const client = new LLMClient({
      apiKey: 'sk-fake-key',
      apiBase: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
    assert.equal(client.protocol, 'openai');
    const res = await client.extractNoteList('<div>内容</div>');
    assert.equal(res[0].title, 'OpenAI 笔记');
  } finally {
    restoreFetch();
  }
});

test('cleanHtml：去除 <script>/<style>/<svg> 与 data: URI', () => {
  const dirty = `
    <style>.a{color:red}</style>
    <script>var x=1;</script>
    <svg><path/></svg>
    <img src="data:image/png;base64,AAAA" />
    <div>保留文本</div>
  `;
  const clean = cleanHtml(dirty);
  assert.ok(!/<script/i.test(clean), '应去除 <script>');
  assert.ok(!/<style/i.test(clean), '应去除 <style>');
  assert.ok(!/<svg/i.test(clean), '应去除 <svg>');
  assert.ok(!/data:/i.test(clean), '应去除 data: URI');
  assert.ok(clean.includes('保留文本'), '正文文本应保留');
});

test('extractNoteList：请求封装正确且请求体不含 script/style', async () => {
  installFetch(() =>
    jsonResponse({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { title: '好物推荐', url: '/explore/abc', author: '小明', likes: '1.2万', type: '图文' },
          ]),
        },
      ],
    })
  );
  try {
    const client = new LLMClient('sk-test');
    const list = await client.extractNoteList(EXAMPLE_HTML);

    // 返回结构校验
    assert.ok(Array.isArray(list), 'extractNoteList 应返回数组');
    assert.equal(list.length, 1);
    assert.equal(list[0].title, '好物推荐');
    assert.equal(list[0].url, '/explore/abc');
    assert.equal(list[0].author, '小明');
    assert.equal(list[0].likes, '1.2万');
    assert.equal(list[0].type, '图文');

    // 请求封装校验
    assert.equal(lastCall.url, 'https://api.anthropic.com/v1/messages');
    const h = lastCall.opts.headers;
    assert.equal(h['x-api-key'], 'sk-test');
    assert.equal(h['anthropic-version'], '2023-06-01');
    assert.equal(h['content-type'], 'application/json');

    const body = JSON.parse(lastCall.opts.body);
    assert.equal(body.model, 'claude-3-5-sonnet-latest');
    assert.equal(body.max_tokens, 4096);
    assert.ok(typeof body.system === 'string' && body.system.length > 0, '应包含 system 提示');
    assert.ok(Array.isArray(body.messages) && body.messages.length === 1);
    assert.equal(body.messages[0].role, 'user');
    assert.ok(typeof body.messages[0].content === 'string');

    // 关键：发送给模型的 HTML 必须经过预清洗，不能包含 script/style 标记与 data: URI
    const sentContent = body.messages[0].content;
    assert.ok(!/<script/i.test(sentContent), '请求体不应包含 <script>');
    assert.ok(!/<style/i.test(sentContent), '请求体不应包含 <style>');
    assert.ok(!/shouldBeStripped/i.test(sentContent), '请求体不应包含 script 内联内容');
    assert.ok(!/data:/i.test(sentContent), '请求体不应包含 data: URI');
    assert.ok(sentContent.includes('好物推荐'), '清洗后的正文文本应被保留并送出');
  } finally {
    restoreFetch();
  }
});

test('extractNoteDetail：返回规范化对象', async () => {
  installFetch(() =>
    jsonResponse({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            title: '笔记标题',
            content: '正文内容',
            author: '作者A',
            likes: 320,
            tags: ['护肤', '测评'],
            images: ['https://xhscdn.com/1.jpg'],
          }),
        },
      ],
    })
  );
  try {
    const client = new LLMClient('sk-test');
    const detail = await client.extractNoteDetail(EXAMPLE_HTML);
    assert.equal(detail.title, '笔记标题');
    assert.equal(detail.content, '正文内容');
    assert.equal(detail.author, '作者A');
    assert.equal(detail.likes, 320);
    assert.deepEqual(detail.tags, ['护肤', '测评']);
    assert.deepEqual(detail.images, ['https://xhscdn.com/1.jpg']);
  } finally {
    restoreFetch();
  }
});

test('extractComments：返回数组', async () => {
  installFetch(() =>
    jsonResponse({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { author: '用户1', text: '好看', likes: 12, publishedAt: '2024-01-02' },
            { author: '用户2', text: '求链接', likes: 3, publishedAt: '2024-01-03' },
          ]),
        },
      ],
    })
  );
  try {
    const client = new LLMClient('sk-test');
    const comments = await client.extractComments(EXAMPLE_HTML);
    assert.ok(Array.isArray(comments));
    assert.equal(comments.length, 2);
    assert.equal(comments[0].author, '用户1');
    assert.equal(comments[1].text, '求链接');
    assert.equal(comments[1].publishedAt, '2024-01-03');
  } finally {
    restoreFetch();
  }
});

// ----------------------------------------------------------------------------
// extractJson：容错解析（不依赖网络）
// ----------------------------------------------------------------------------
test('extractJson：干净 JSON 直接解析', () => {
  const input = '[{"title":"a","url":"u","author":"au","likes":1,"type":"视频"}]';
  const out = extractJson(input);
  assert.deepEqual(out, [{ title: 'a', url: 'u', author: 'au', likes: 1, type: '视频' }]);
});

test('extractJson：解析 ```json 代码围栏包裹的 JSON', () => {
  const input = '```json\n{"title":"a","content":"b"}\n```';
  const out = extractJson(input);
  assert.deepEqual(out, { title: 'a', content: 'b' });
});

test('extractJson：解析前后夹带散文的 JSON', () => {
  const input = '好的，以下是提取结果：\n[{"author":"x","text":"hi","likes":2,"publishedAt":"2024"}]\n希望对你有帮助。';
  const out = extractJson(input);
  assert.deepEqual(out, [{ author: 'x', text: 'hi', likes: 2, publishedAt: '2024' }]);
});

test('extractJson：修复尾随逗号后解析', () => {
  const input = '[\n  {"title":"a","url":"u",},\n  {"title":"b","url":"v",}\n]';
  const out = extractJson(input);
  assert.deepEqual(out, [
    { title: 'a', url: 'u' },
    { title: 'b', url: 'v' },
  ]);
});

test('extractJson：输入完全非 JSON 时抛错', () => {
  assert.throws(() => extractJson('这根本不是 json 输出'), /JSON/i);
  assert.throws(() => extractJson(''), /JSON/i);
});

test('extractNoteList：模型返回非 JSON 时整体抛错（含一次重试）', async () => {
  let calls = 0;
  installFetch(() => {
    calls += 1;
    return jsonResponse({ content: [{ type: 'text', text: '抱歉我无法提取' }] });
  });
  try {
    const client = new LLMClient('sk-test');
    await assert.rejects(() => client.extractNoteList(EXAMPLE_HTML), /JSON/i);
    // 要求：解析失败后重试一次（即共发起了 2 次 API 调用）。
    assert.equal(calls, 2, '解析失败应重试一次 API');
  } finally {
    restoreFetch();
  }
});

test('extractNoteList：模型返回围栏包裹 JSON 也能端到端解析', async () => {
  installFetch(() =>
    jsonResponse({
      content: [
        {
          type: 'text',
          text: '```json\n[{"title":"端到端","url":"/x","author":"au","likes":5,"type":"图文"}]\n```',
        },
      ],
    })
  );
  try {
    const client = new LLMClient('sk-test');
    const list = await client.extractNoteList(EXAMPLE_HTML);
    assert.equal(list.length, 1);
    assert.equal(list[0].title, '端到端');
  } finally {
    restoreFetch();
  }
});

// ----------------------------------------------------------------------------
// 鲁棒性回归：网络/HTTP 错误不应进入 JSON 重试分支；content 块按 type 选取。
// ----------------------------------------------------------------------------

test('HTTP 错误（含 error body）立即抛出且不重试', async () => {
  let calls = 0;
  installFetch(() => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      json: async () => ({ error: { type: 'rate_limit_error', message: 'rate limited' } }),
    };
  });
  try {
    const client = new LLMClient('sk-test');
    await assert.rejects(() => client.extractNoteList(EXAMPLE_HTML), /HTTP 429.*rate limited/i);
    // 关键：网络/HTTP 错误不应进入 JSON 重试分支（只调用 1 次，避免对 429 二次打击）
    assert.equal(calls, 1, 'HTTP 错误不应触发重试');
  } finally {
    restoreFetch();
  }
});

test('网络错误在重试达到上限后抛出且不进入 JSON 换 prompt 分支', async () => {
  let calls = 0;
  installFetch(() => {
    calls += 1;
    throw new Error('ECONNRESET');
  });
  try {
    const client = new LLMClient('sk-test');
    client._retryDelayMs = 5;
    await assert.rejects(() => client.extractNoteList(EXAMPLE_HTML), /网络请求失败/i);
    assert.equal(calls, 3, '网络错误应重试 2 次（共调用 3 次）且不进入 JSON 换 prompt 分支');
  } finally {
    restoreFetch();
  }
});

test('content 中首个文本块（type==="text"）被选中，忽略非文本块', async () => {
  installFetch(() =>
    jsonResponse({
      content: [
        { type: 'thinking', text: '让我想想' },
        { type: 'text', text: JSON.stringify([{ title: 'x', url: '/e', author: 'a', likes: 1, type: '图文' }]) },
      ],
    })
  );
  try {
    const client = new LLMClient('sk-test');
    const list = await client.extractNoteList(EXAMPLE_HTML);
    assert.equal(list[0].title, 'x');
  } finally {
    restoreFetch();
  }
});

test('testConnection：API 正常响应时返回 ok: true', async () => {
  installFetch(() =>
    jsonResponse({
      content: [{ type: 'text', text: 'OK' }],
    })
  );
  try {
    const client = new LLMClient('sk-test');
    const res = await client.testConnection();
    assert.deepEqual(res, { ok: true });
  } finally {
    restoreFetch();
  }
});

test('testConnection：API 抛错时返回 ok: false 与错误说明', async () => {
  installFetch(() => {
    throw new Error('Connection refused');
  });
  try {
    const client = new LLMClient('sk-test');
    const res = await client.testConnection();
    assert.equal(res.ok, false);
    assert.match(res.error, /Connection refused/i);
  } finally {
    restoreFetch();
  }
});

test('LLMClient._callApi 遇到网络故障时自动重试 2 次直至成功', async () => {
  let attempts = 0;
  installFetch(() => {
    attempts++;
    if (attempts < 3) throw new Error('Failed to fetch');
    return jsonResponse({
      content: [{ type: 'text', text: '{"title":"ok"}' }],
    });
  });
  try {
    const client = new LLMClient('sk-test');
    client._retryDelayMs = 10; // 测试中快速重试
    const res = await client._callApi('sys', 'user');
    assert.equal(attempts, 3, '应重试 2 次（共调用 3 次）');
    assert.ok(res.includes('ok'));
  } finally {
    restoreFetch();
  }
});

test('LLMClient._callApi 超时后抛出包含“超时”而非“The user aborted a request”的友好错误', async () => {
  installFetch((_url, opts) => {
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
  try {
    const client = new LLMClient('sk-test');
    client._timeoutMs = 20; // 快速超时
    client._retryDelayMs = 5;
    await assert.rejects(
      async () => client._callApi('sys', 'user'),
      /LLM API 请求超时/
    );
  } finally {
    restoreFetch();
  }
});

test('LLMClient.learnSitePatterns：分析页面 HTML 并提取出结构化选择器', async () => {
  installFetch(() => {
    return jsonResponse({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            search: {
              filterButton: ['.filter-btn'],
              sortTabs: {
                popularity_descending: ['.sort-hot'],
                time_descending: ['.sort-latest'],
              },
            },
          }),
        },
      ],
    });
  });
  try {
    const client = new LLMClient('sk-test');
    const html = '<div class="filter-btn">筛选</div><div class="sort-latest">最新</div>';
    const patterns = await client.learnSitePatterns(html, 'search');
    assert.ok(patterns && patterns.search);
    assert.deepEqual(patterns.search.filterButton, ['.filter-btn']);
    assert.deepEqual(patterns.search.sortTabs.time_descending, ['.sort-latest']);
  } finally {
    restoreFetch();
  }
});

test('LLMClient.learnSitePatterns：支持扁平意图键名与 XPath/语义规则，并自动兼容', async () => {
  installFetch(() => {
    return jsonResponse({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            'search.filterButton': ['button.filter-btn', '//button[contains(.,"筛选")]'],
            'search.sortTabs.time_descending': ['//div[text()="最新"]', '.sort-item-latest'],
            'search.noteCard': ['a[href*="/explore/"]', '.note-card'],
          }),
        },
      ],
    });
  });
  try {
    const client = new LLMClient('sk-test');
    const html = '<button class="filter-btn">筛选</button><div>最新</div>';
    const patterns = await client.learnSitePatterns(html, 'search');
    assert.ok(patterns);
    // 兼容扁平意图映射或嵌套解析
    const latestRule = patterns['search.sortTabs.time_descending'] || patterns?.search?.sortTabs?.time_descending;
    assert.ok(Array.isArray(latestRule));
    assert.equal(latestRule.length, 2);
    assert.equal(latestRule[0], '//div[text()="最新"]');
  } finally {
    restoreFetch();
  }
});

test('LLMClient.learnSearchSortRegion：对页面控制区域进行区域判断并提取精确排序与筛选规则', async () => {
  installFetch((url, opts) => {
    const bodyStr = opts?.body || '';
    assert.ok(bodyStr.includes('区域判断') || bodyStr.includes('筛选控制区域'));
    assert.ok(bodyStr.includes('最新') || bodyStr.includes('time_descending'));

    return jsonResponse({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            regionSelector: ['.filter', 'div[class*="filter"]'],
            filterButton: ['.filter span', 'button.filter-btn'],
            sortOption: ['//span[text()="最新"]', '.sort-capsule'],
            reason: '已识别右侧筛选控制区域，成功排除左侧图文/视频分类栏',
          }),
        },
      ],
    });
  });

  try {
    const client = new LLMClient('sk-test');
    const skeletonHtml = `
      <div class="nav-tabs"><div class="tab">全部</div><div class="tab">图文</div></div>
      <div class="filter"><span class="btn">筛选</span></div>
    `;
    const res = await client.learnSearchSortRegion(skeletonHtml, 'time_descending');
    assert.ok(res);
    assert.deepEqual(res.regionSelector, ['.filter', 'div[class*="filter"]']);
    assert.deepEqual(res.filterButton, ['.filter span', 'button.filter-btn']);
    assert.deepEqual(res.sortOption, ['//span[text()="最新"]', '.sort-capsule']);
    assert.ok(res.reason.includes('排除左侧'));
  } finally {
    restoreFetch();
  }
});

test('LLMClient.planGoalRemediation：接收目标与现场证据，规划下一步原子交互动作', async () => {
  installFetch((url, opts) => {
    const bodyStr = opts?.body || '';
    assert.ok(bodyStr.includes('search_sort'));
    assert.ok(bodyStr.includes('最新'));

    return jsonResponse({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'HOVER_CLICK',
            selector: ['.filter', 'button.tab'],
            reason: '检测到浮层尚未挂载，先悬停筛选区域再点击最新胶囊',
          }),
        },
      ],
    });
  });

  try {
    const client = new LLMClient('sk-test');
    const goal = { type: 'search_sort', targetValue: 'time_descending', targetLabel: '最新' };
    const evidence = {
      htmlSnippet: '<div class="filter"><span>筛选</span></div>',
      lastAction: { action: 'CLICK', selector: ['span'] },
      lastError: '未检测到 active 激活态',
      history: [],
    };
    const plan = await client.planGoalRemediation(goal, evidence);
    assert.ok(plan);
    assert.equal(plan.action, 'HOVER_CLICK');
    assert.deepEqual(plan.selector, ['.filter', 'button.tab']);
    assert.ok(plan.reason.includes('浮层尚未挂载'));
  } finally {
    restoreFetch();
  }
});

test('LLMClient.planGoalRemediation：当 LLM 返回扁平或单字符串 selector 时自动规范化为数组', async () => {
  installFetch(() => {
    return jsonResponse({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'click',
            selector: '.filter-box',
            reason: '单字符串自动包装为数组',
          }),
        },
      ],
    });
  });

  try {
    const client = new LLMClient('sk-test');
    const plan = await client.planGoalRemediation({ type: 'search_sort' }, { htmlSnippet: '<div></div>' });
    assert.equal(plan.action, 'CLICK');
    assert.deepEqual(plan.selector, ['.filter-box']);
  } finally {
    restoreFetch();
  }
});



