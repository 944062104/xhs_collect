// Service Worker 生命周期管理 + 保活机制 单元测试（TDD: 先写测试，后实现）。
//
// 浏览器 Service Worker 无法在 Node 中直接运行，本测试通过注入 mock-chrome 驱动：
// - 在 import 模块【之前】设置 globalThis.__XHS_NO_AUTOINSTALL__，阻止浏览器自动 install()。
// - 使用真实 StorageManager（配合 fake-indexeddb/auto）以真正往返 task / note / config。
// - 注入 FAKE scraper（run/resume/cancel 为记录型 spy），避免依赖真实 Scraper 与网络。
// - 捕获 chromeApi.runtime.onMessage / chromeApi.alarms.onAlarm 的监听器，直接驱动。

// 必须在 import service-worker 之前设置，否则会触发浏览器自动 install()。
globalThis.__XHS_NO_AUTOINSTALL__ = true;

import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageManager } from '../src/background/storage.js';

// 动态 import：__XHS_NO_AUTOINSTALL__ 已在文件顶部设置，模块求值时不会自动 install。
const { install } = await import('../src/background/service-worker.js');

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

function makeStorage(name = `xhs-sw-test-${Math.random().toString(36).slice(2)}`) {
  return new StorageManager(name);
}

// mock chrome：记录 alarms.create 调用、捕获 onAlarm / onMessage 监听器、可选 getPlatformInfo。
function makeMockChrome() {
  const alarms = {
    calls: [],
    create(name, opts) {
      this.calls.push({ name, opts });
    },
    onAlarm: {
      _handlers: [],
      addListener(fn) {
        this._handlers.push(fn);
      },
    },
  };
  const runtime = {
    _platformInfoCalls: 0,
    getPlatformInfo(cb) {
      this._platformInfoCalls += 1;
      if (typeof cb === 'function') cb();
    },
    onMessage: {
      _handlers: [],
      addListener(fn) {
        this._handlers.push(fn);
      },
    },
  };
  return { alarms, runtime, tabs: null };
}

// FAKE scraper：run/resume/cancel 记录入参并（可选）把 task 推进到终态以模拟真实行为。
function makeFakeScraper(storage) {
  const calls = { run: [], resume: [], cancel: [] };
  const run = async (task) => {
    calls.run.push(task);
    if (storage) {
      task.status = 'running';
      await storage.saveTask(task);
      task.status = 'completed';
      await storage.saveTask(task);
    }
    return task;
  };
  run.calls = calls.run;
  const resume = async (task) => {
    calls.resume.push(task);
    return task;
  };
  resume.calls = calls.resume;
  const cancel = async (taskId) => {
    calls.cancel.push(taskId);
    return taskId;
  };
  cancel.calls = calls.cancel;
  calls.finishEarly = [];
  const finishEarly = async (taskId) => {
    calls.finishEarly.push(taskId);
    if (storage) {
      const task = await storage.getTask(taskId);
      if (task) {
        task.status = 'completed';
        task.completedAt = Date.now();
        await storage.saveTask(task);
      }
    }
    return taskId;
  };
  finishEarly.calls = calls.finishEarly;
  return { run, resume, cancel, finishEarly, calls };
}

// sendResponse 记录器：reply 为最后一次调用；responses 为全部调用。
function makeSendResponse() {
  const responses = [];
  const fn = (r) => {
    responses.push(r);
  };
  fn.responses = responses;
  fn.last = () => responses[responses.length - 1];
  return fn;
}

// 轮询直到 fn() 为真或超时（用于等待已脱离消息处理的后台异步 run / resume 完成）。
async function waitFor(fn, timeout = 2000) {
  const start = Date.now();
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      /* 忽略瞬时错误，继续轮询 */
    }
    if (Date.now() - start > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// 搭建一个已 install 的 fixture，返回监听器与 fixture 对象。
async function buildFixture() {
  const chromeApi = makeMockChrome();
  const storage = makeStorage();
  const fake = makeFakeScraper(storage);
  install({ chromeApi, storage, scraper: fake });
  const rawHandler = chromeApi.runtime.onMessage._handlers[0];
  // 包装测试用的 handler：调用后自动 await 底层的 promise 保证测试同步取得结果
  const handler = async (...args) => {
    const res = rawHandler(...args);
    if (rawHandler._lastPromise) await rawHandler._lastPromise;
    return res;
  };
  const alarmHandler = chromeApi.alarms.onAlarm._handlers[0];
  return { chromeApi, storage, fake, handler, alarmHandler };
}

const API_KEY = 'sk-test-123';

// ---------------------------------------------------------------------------
// (a) install 注册 keepalive 闹钟
// ---------------------------------------------------------------------------

test('install 注册 keepalive 闹钟，periodInMinutes ≈ 25/60', async () => {
  const { chromeApi } = await buildFixture();
  assert.equal(chromeApi.alarms.calls.length, 1, '应恰好注册一个闹钟');
  assert.equal(chromeApi.alarms.calls[0].name, 'keepalive');
  assert.ok(
    Math.abs(chromeApi.alarms.calls[0].opts.periodInMinutes - 25 / 60) < 1e-9,
    `periodInMinutes 应为 25/60 (=${25 / 60})，实际 ${chromeApi.alarms.calls[0].opts.periodInMinutes}`
  );
});

// ---------------------------------------------------------------------------
// (b) keepalive 闹钟触发 → 有 running 任务则 resume；无则跳过
// ---------------------------------------------------------------------------

test('onAlarm(keepalive) 且存在 running 任务 → fake.resume 被调用一次', async () => {
  const { storage, fake, alarmHandler, chromeApi } = await buildFixture();
  await storage.saveTask({
    id: 'task_run',
    status: 'running',
    keyword: '测试',
    config: {},
    progress: { phase: 'collectingNotes', notesCollected: 0 },
    timestamps: { createdAt: 1, startedAt: 1, completedAt: null },
    errors: [],
  });

  await alarmHandler({ name: 'keepalive' });

  assert.equal(fake.calls.resume.length, 1, 'running 任务应触发一次 resume');
  assert.equal(fake.calls.resume[0].id, 'task_run');
  assert.equal(chromeApi.runtime._platformInfoCalls, 1, '应发出一次保活 ping');
});

test('onAlarm(keepalive) 但无 running 任务 → fake.resume 不被调用', async () => {
  const { storage, fake, alarmHandler, chromeApi } = await buildFixture();
  await storage.saveTask({
    id: 'task_done',
    status: 'completed',
    keyword: '测试',
    config: {},
    progress: {},
    timestamps: { createdAt: 1, startedAt: 1, completedAt: 2 },
    errors: [],
  });

  await alarmHandler({ name: 'keepalive' });

  assert.equal(fake.calls.resume.length, 0, '无 running 任务不应调用 resume');
  assert.equal(chromeApi.runtime._platformInfoCalls, 1, '保活 ping 仍应触发');
});

test('onAlarm 非 keepalive 名称 → 不触发 resume，也不 ping', async () => {
  const { fake, alarmHandler, chromeApi } = await buildFixture();
  await alarmHandler({ name: 'other-alarm' });
  assert.equal(fake.calls.resume.length, 0);
  assert.equal(chromeApi.runtime._platformInfoCalls, 0);
});

// ---------------------------------------------------------------------------
// (c) START_TASK（已配置 apiKey）→ 创建任务、后台 run、回复 {ok:true, taskId}
// ---------------------------------------------------------------------------

test('START_TASK（有 apiKey）创建任务并触发后台 run，回复 ok:true + taskId', async () => {
  const { storage, fake, handler } = await buildFixture();
  await storage.saveConfig('apiKey', API_KEY);
  const sendResponse = makeSendResponse();

  await handler(
    { type: 'START_TASK', keyword: '护肤', config: { notesLimit: 5 } },
    {},
    sendResponse
  );

  const reply = sendResponse.last();
  assert.equal(reply.ok, true, '应回复 ok:true');
  assert.ok(reply.taskId, '应返回 taskId');

  // task 已落库
  const task = await storage.getTask(reply.taskId);
  assert.ok(task, '任务应已创建');
  assert.equal(task.keyword, '护肤');

  // 后台 run 脱离消息处理执行，轮询等待其完成
  await waitFor(async () => fake.calls.run.length === 1);
  assert.equal(fake.calls.run[0].id, task.id);

  // fake.run 把 task 推进到 completed（模拟真实 Scraper.run 终态）
  const after = await storage.getTask(task.id);
  assert.equal(after.status, 'completed', '后台 run 完成后任务应进入终态');
});

// ---------------------------------------------------------------------------
// (g) START_TASK（无 apiKey）→ 回复 NO_API_KEY，且不创建任务
// ---------------------------------------------------------------------------

test('START_TASK（无 apiKey）回复 NO_API_KEY 且不创建任务', async () => {
  const { storage, fake, handler } = await buildFixture();
  const sendResponse = makeSendResponse();

  await handler({ type: 'START_TASK', keyword: '护肤' }, {}, sendResponse);

  const reply = sendResponse.last();
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'NO_API_KEY');
  assert.equal(fake.calls.run.length, 0, '无 apiKey 不应启动 run');
  assert.equal(await storage.getRunningTask(), null, '不应创建 running 任务');
});

// ---------------------------------------------------------------------------
// (h) START_TASK 守卫：已有进行中的任务时拒绝新的 START_TASK（TASK_ALREADY_RUNNING）
// ---------------------------------------------------------------------------

test('START_TASK 守卫：进行中拒绝并发 START_TASK（TASK_ALREADY_RUNNING）', async () => {
  const chromeApi = makeMockChrome();
  const storage = makeStorage();
  // run 返回可控 Promise（测试结束前手动 resolve），使 activeRun 持续占用以模拟「采集进行中」。
  const pendingRun = { calls: [], resolver: null };
  const pendingFake = {
    run: (task) => {
      pendingRun.calls.push(task);
      return new Promise((resolve) => { pendingRun.resolver = resolve; });
    },
    resume: async () => {},
    cancel: async () => {},
    calls: pendingRun,
  };
  install({ chromeApi, storage, scraper: pendingFake });
  const rawHandler = chromeApi.runtime.onMessage._handlers[0];
  const handler = async (...args) => {
    rawHandler(...args);
    if (rawHandler._lastPromise) await rawHandler._lastPromise;
  };
  await storage.saveConfig('apiKey', API_KEY);

  const r1 = makeSendResponse();
  await handler({ type: 'START_TASK', keyword: '护肤' }, {}, r1);
  assert.equal(r1.last().ok, true, '首个 START_TASK 应成功');

  const r2 = makeSendResponse();
  await handler({ type: 'START_TASK', keyword: '美妆' }, {}, r2);
  assert.equal(r2.last().ok, false, '并发 START_TASK 应被拒绝');
  assert.equal(r2.last().error, 'TASK_ALREADY_RUNNING');
  assert.equal(pendingRun.calls.length, 1, '不应启动第二个 run');

  pendingRun.resolver && pendingRun.resolver(); // 释放守卫，避免影响其它测试
});

// ---------------------------------------------------------------------------
// (d) CANCEL_TASK → fake.cancel(taskId)，回复 ok:true
// ---------------------------------------------------------------------------

test('CANCEL_TASK 调用 fake.cancel 并回复 ok:true', async () => {
  const { storage, fake, handler } = await buildFixture();
  await storage.saveConfig('apiKey', API_KEY);
  await storage.saveTask({
    id: 'task_cancel',
    status: 'running',
    keyword: 'x',
    config: {},
    progress: {},
    timestamps: { createdAt: 1, startedAt: 1, completedAt: null },
    errors: [],
  });
  const sendResponse = makeSendResponse();

  await handler({ type: 'CANCEL_TASK', taskId: 'task_cancel' }, {}, sendResponse);

  assert.equal(fake.calls.cancel.length, 1);
  assert.equal(fake.calls.cancel[0], 'task_cancel');
  assert.deepEqual(sendResponse.last(), { ok: true });
});

test('FINISH_EARLY_TASK 调用 fake.finishEarly 并将任务标记为 completed', async () => {
  const { storage, fake, handler } = await buildFixture();
  await storage.saveTask({
    id: 'task_early',
    status: 'running',
    keyword: 'x',
    config: {},
    progress: { notesCollected: 3 },
    timestamps: { createdAt: 1, startedAt: 1, completedAt: null },
    errors: [],
  });
  const sendResponse = makeSendResponse();

  await handler({ type: 'FINISH_EARLY_TASK', taskId: 'task_early' }, {}, sendResponse);

  assert.equal(fake.calls.finishEarly.length, 1);
  assert.equal(fake.calls.finishEarly[0], 'task_early');
  assert.deepEqual(sendResponse.last(), { ok: true, taskId: 'task_early' });

  const task = await storage.getTask('task_early');
  assert.equal(task.status, 'completed', '提前结束应将任务转为 completed 终态');
});

// ---------------------------------------------------------------------------
// (e) GET_PROGRESS（已 seed 任务 + 一条 note）→ status / progress / notesCount
// ---------------------------------------------------------------------------

test('GET_PROGRESS 返回 status、progress 与 notesCount', async () => {
  const { storage, handler } = await buildFixture();

  // 直接用 storage 写入一个标准任务结构
  await storage.saveTask({
    id: 'task_prog',
    status: 'running',
    keyword: 'k',
    config: { notesLimit: 10 },
    progress: { phase: 'collectingNotes', notesCollected: 3 },
    timestamps: { createdAt: 1, startedAt: 1, completedAt: null },
    errors: [],
  });
  await storage.saveNote({
    id: 'note_1',
    taskId: 'task_prog',
    url: 'http://x/1',
    title: 't',
    content: 'c',
    author: 'a',
    likes: 0,
    tags: [],
    commentList: [],
    collectedAt: 1,
  });

  const sendResponse = makeSendResponse();
  await handler({ type: 'GET_PROGRESS', taskId: 'task_prog' }, {}, sendResponse);

  const reply = sendResponse.last();
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 'running');
  assert.equal(reply.progress.phase, 'collectingNotes');
  assert.equal(reply.notesCount, 1);
});

test('GET_PROGRESS 无任务时回复 NO_TASK', async () => {
  const { handler } = await buildFixture();
  const sendResponse = makeSendResponse();
  await handler({ type: 'GET_PROGRESS' }, {}, sendResponse);
  assert.deepEqual(sendResponse.last(), { ok: false, error: 'NO_TASK' });
});

// ---------------------------------------------------------------------------
// (f) EXPORT_DATA json / csv
// ---------------------------------------------------------------------------

test('EXPORT_DATA json 返回合法 JSON 字符串', async () => {
  const { storage, handler } = await buildFixture();
  await storage.saveTask({
    id: 'task_exp',
    status: 'completed',
    keyword: 'k',
    config: {},
    progress: {},
    timestamps: { createdAt: 1, startedAt: 1, completedAt: 2 },
    errors: [],
  });
  const note = {
    id: 'note_e',
    taskId: 'task_exp',
    url: 'http://x/e',
    title: '标题',
    content: '正文',
    author: '作者',
    likes: 7,
    tags: ['t1', 't2'],
    commentList: [{ author: 'c', text: '好', likes: 1, publishedAt: 'now' }],
    collectedAt: 123,
  };
  await storage.saveNote(note);

  const sendResponse = makeSendResponse();
  await handler({ type: 'EXPORT_DATA', taskId: 'task_exp', format: 'json' }, {}, sendResponse);

  const reply = sendResponse.last();
  assert.equal(reply.ok, true);
  assert.equal(reply.format, 'json');
  assert.equal(reply.filename, 'xhs_task_exp.json');
  const parsed = JSON.parse(reply.data); // 必须可解析
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], note);
});

test('EXPORT_DATA csv 含表头 + 数据行，且正确转义', async () => {
  const { storage, handler } = await buildFixture();
  await storage.saveTask({
    id: 'task_csv',
    status: 'completed',
    keyword: 'k',
    config: {},
    progress: {},
    timestamps: { createdAt: 1, startedAt: 1, completedAt: 2 },
    errors: [],
  });
  // 标题含逗号与双引号，用于验证 CSV 转义
  await storage.saveNote({
    id: 'note_c',
    taskId: 'task_csv',
    url: 'http://x/c',
    title: 'Hello, "World"',
    content: '正文',
    author: '作者',
    likes: 2,
    tags: ['a', 'b'],
    commentList: [{ author: 'c', text: 'x', likes: 0, publishedAt: 't' }],
    collectedAt: 9,
  });

  const sendResponse = makeSendResponse();
  await handler({ type: 'EXPORT_DATA', taskId: 'task_csv', format: 'csv' }, {}, sendResponse);

  const reply = sendResponse.last();
  assert.equal(reply.ok, true);
  assert.equal(reply.format, 'csv');
  assert.equal(reply.filename, 'xhs_task_csv.csv');

  const lines = reply.data.split('\n');
  assert.equal(lines.length, 2, '应恰好为 表头 + 1 数据行');
  assert.equal(
    lines[0],
    'id,taskId,url,title,content,author,likes,tags,commentsCount,collectedAt',
    '表头列应完整'
  );
  // 标题含逗号与引号 → 应被双引号包裹且内部引号翻倍
  assert.ok(lines[1].includes('"Hello, ""World"""'), `标题应被正确转义，实际行: ${lines[1]}`);
  // commentsCount 应等于 commentList 长度
  assert.ok(lines[1].endsWith(',9'), `行尾应为 collectedAt=9，实际: ${lines[1]}`);
});

test('EXPORT_DATA comments_csv 展平评论并输出完整评论明细表', async () => {
  const { storage, handler } = await buildFixture();
  await storage.saveTask({
    id: 'task_comments_csv',
    status: 'completed',
    keyword: 'k',
    config: {},
    progress: {},
    timestamps: { createdAt: 1, startedAt: 1, completedAt: 2 },
    errors: [],
  });
  await storage.saveNote({
    id: 'note_cm_1',
    taskId: 'task_comments_csv',
    url: 'http://x/cm_1',
    title: '精选笔记',
    content: '正文',
    author: '博主',
    likes: 10,
    tags: ['护肤'],
    commentList: [
      { author: '小红', content: '好用！', likes: 5, publishedAt: '今天' },
      { author: '小绿', text: '求链接', likes: 1, publishedAt: '昨天' },
    ],
    collectedAt: 100,
  });

  const sendResponse = makeSendResponse();
  await handler({ type: 'EXPORT_DATA', taskId: 'task_comments_csv', format: 'comments_csv' }, {}, sendResponse);

  const reply = sendResponse.last();
  assert.equal(reply.ok, true);
  assert.equal(reply.format, 'comments_csv');
  assert.equal(reply.filename, 'xhs_task_comments_csv_comments.csv');

  const lines = reply.data.split('\n');
  assert.equal(lines.length, 3, '应为 表头 + 2 条评论行');
  assert.equal(lines[0], 'noteId,noteTitle,noteUrl,commentAuthor,commentContent,commentLikes,commentTime');
  assert.ok(lines[1].includes('note_cm_1') && lines[1].includes('小红') && lines[1].includes('好用！'));
  assert.ok(lines[2].includes('note_cm_1') && lines[2].includes('小绿') && lines[2].includes('求链接'));
});

test('EXPORT_DATA 无任务时回复 NO_TASK', async () => {
  const { handler } = await buildFixture();
  const sendResponse = makeSendResponse();
  await handler({ type: 'EXPORT_DATA', taskId: 'nope', format: 'json' }, {}, sendResponse);
  assert.deepEqual(sendResponse.last(), { ok: false, error: 'NO_TASK' });
});

// ---------------------------------------------------------------------------
// 消息校验
// ---------------------------------------------------------------------------

test('缺少 type 的消息回复 INVALID_MESSAGE 且 handler 返回 true', async () => {
  const { handler } = await buildFixture();
  const sendResponse = makeSendResponse();
  const ret = await handler({}, {}, sendResponse);
  assert.equal(ret, true, 'handler 应返回 true 以保持消息通道');
  assert.deepEqual(sendResponse.last(), { ok: false, error: 'INVALID_MESSAGE' });
});

test('未知 type 回复 UNKNOWN_TYPE 且 handler 返回 true', async () => {
  const { handler } = await buildFixture();
  const sendResponse = makeSendResponse();
  const ret = await handler({ type: 'WAT' }, {}, sendResponse);
  assert.equal(ret, true);
  assert.deepEqual(sendResponse.last(), { ok: false, error: 'UNKNOWN_TYPE' });
});

test('TEST_LLM_CONFIG 验证 API 连接', async () => {
  const { handler } = await buildFixture();
  const sendResponse = makeSendResponse();
  // 注入无效 key
  await handler({ type: 'TEST_LLM_CONFIG', apiKey: '' }, {}, sendResponse);
  assert.equal(sendResponse.last().ok, false);
  assert.equal(sendResponse.last().error, 'NO_API_KEY');
});

test('GET_LATEST_TASK 返回最新任务与笔记预览', async () => {
  const { handler, storage } = await buildFixture();
  const sendResponse = makeSendResponse();
  // 无任务时
  await handler({ type: 'GET_LATEST_TASK' }, {}, sendResponse);
  assert.deepEqual(sendResponse.last(), { ok: true, task: null, notes: [] });

  // 创建任务与笔记
  await storage.saveTask({
    id: 't_latest',
    keyword: '护肤',
    status: 'completed',
    createdAt: 100,
    progress: { notesCollected: 1 },
  });
  await storage.saveNote({
    id: 'n1',
    taskId: 't_latest',
    title: '护肤技巧',
    author: '博主A',
    collectedAt: 100,
  });

  const sendResponse2 = makeSendResponse();
  await handler({ type: 'GET_LATEST_TASK' }, {}, sendResponse2);
  const resp = sendResponse2.last();
  assert.equal(resp.ok, true);
  assert.equal(resp.task.id, 't_latest');
  assert.equal(resp.notes.length, 1);
  assert.equal(resp.notes[0].title, '护肤技巧');
});

test('RESET_TASK 清除当前活动运行状态', async () => {
  const { handler } = await buildFixture();
  const sendResponse = makeSendResponse();
  await handler({ type: 'RESET_TASK' }, {}, sendResponse);
  assert.equal(sendResponse.last().ok, true);
});

