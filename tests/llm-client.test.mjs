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

test('网络错误立即抛出且不重试', async () => {
  let calls = 0;
  installFetch(() => {
    calls += 1;
    throw new Error('ECONNRESET');
  });
  try {
    const client = new LLMClient('sk-test');
    await assert.rejects(() => client.extractNoteList(EXAMPLE_HTML), /网络请求失败/i);
    assert.equal(calls, 1, '网络错误不应触发重试');
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

