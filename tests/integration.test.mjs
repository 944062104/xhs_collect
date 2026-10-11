// ===========================================================================
// 端到端集成测试（TDD: 先在 tests/integration.test.mjs 写测试，后实现）。
//
// 真实 Chrome 无法在本环境运行，故本测试用 Node 集成桩驱动【真实】Service Worker +
// 【真实】Scraper + 【真实】StorageManager，并以【模拟 content script】的 chrome.tabs
// 响应和【桩 LLM】替换网络，证明完整链路（搜索→详情+评论→导出）无需浏览器即可跑通。
//
// 覆盖：
//   (a) 核心链路：START_TASK → 完成，3 篇笔记，EXPORT JSON/CSV 正确。
//   (b) 断点续传：seed running 任务 + 2 篇已存笔记 → 闹钟触发 resume → 仅补第 3 篇。
//   (c) 未登录拦截：authWall=true → status=failed，errors 含 AUTH_REQUIRED。
//   (d) 网络波动重试：scroll 瞬态失败 2 次后成功 → 仍完成 3 篇，无错误。
//
// 必须在 import service-worker 之前设置 __XHS_NO_AUTOINSTALL__，阻止浏览器自动 install()。
// ===========================================================================

globalThis.__XHS_NO_AUTOINSTALL__ = true;

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageManager } from '../src/background/storage.js';
import { Scraper, AuthRequiredError } from '../src/background/scraper.js';

const PATTERNS = JSON.parse(
  readFileSync(new URL('../src/config/site-patterns.json', import.meta.url), 'utf8')
);

const { install } = await import('../src/background/service-worker.js');

const STUB_URLS = [
  'https://www.xiaohongshu.com/explore/1',
  'https://www.xiaohongshu.com/explore/2',
  'https://www.xiaohongshu.com/explore/3',
];

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// 桩 LLM：不联网，按固定夹具返回结构化数据（与真实 LLMClient 接口一致）。
// ---------------------------------------------------------------------------
function makeStubLlm(urls = STUB_URLS) {
  return {
    extractNoteList: async () =>
      urls.map((u) => ({ url: u, title: '标题', author: '作者', likes: 1, type: '图文' })),
    extractNoteDetail: async () => ({
      title: '标题',
      content: '正文',
      author: '作者',
      likes: 9,
      tags: ['t1'],
      images: ['i1'],
    }),
    extractComments: async () => [{ author: '评论者', text: '评论', likes: 1, publishedAt: '刚刚' }],
  };
}

// ---------------------------------------------------------------------------
// 模拟 chrome：捕获 onMessage / onAlarm 监听器。
// ---------------------------------------------------------------------------
function makeFakeChrome() {
  const alarms = {
    calls: [],
    create(name, opts) {
      this.calls.push({ name, opts });
    },
    onAlarm: { _handlers: [], addListener(fn) { this._handlers.push(fn); } },
  };
  const runtime = {
    getPlatformInfo(cb) {
      if (typeof cb === 'function') cb();
    },
    onMessage: { _handlers: [], addListener(fn) { this._handlers.push(fn); } },
  };
  return { alarms, runtime, tabs: null };
}

// ---------------------------------------------------------------------------
// 模拟 content script（通过 chrome.tabs.sendMessage）：按 scenario 返回罐头响应。
//   - 登录墙检测：waitFor 且 selectors 命中 login-container → authWall 时 ok:true（弹窗），否则 ok:false。
//   - 网络波动：transientFailures 中的 action 前 limit 次返回 ok:false,error:TAB_NOT_READY。
// ---------------------------------------------------------------------------
function makeTabs(scenario) {
  const transientCounts = {};
  const ops = { created: [], updated: [], messages: [] };
  return {
    ops,
    create: async ({ url }) => {
      ops.created.push(url);
      return { id: 1 };
    },
    update: async (id, { url }) => {
      ops.updated.push(url);
      return { id };
    },
    sendMessage: async (tabId, msg) => {
      ops.messages.push(msg);
      const action = msg.action;

      // 登录弹窗检测分支
      if (
        action === 'waitFor' &&
        msg.selectors &&
        msg.selectors.some((s) => String(s).includes('login-container'))
      ) {
        return scenario.authWall ? { ok: true } : { ok: false };
      }

      // 瞬态（网络波动）重试分支
      if (scenario.transientFailures && scenario.transientFailures.includes(action)) {
        transientCounts[action] = (transientCounts[action] || 0) + 1;
        const limit = scenario.transientLimit ?? 2;
        if (transientCounts[action] <= limit) {
          return { ok: false, error: 'TAB_NOT_READY' }; // 瞬态错误 → 应触发重试
        }
      }

      switch (action) {
        case 'getHTML':
          return { ok: true, data: `<div class="sel">${msg.selectors?.[0] ?? 'html'}</div>` };
        case 'waitFor':
        case 'scroll':
        case 'click':
        case 'closeModal':
          return { ok: true };
        default:
          return { ok: true };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 搭建已 install 的 fixture；scenario 控制模拟 content script 的行为。
// ---------------------------------------------------------------------------
function buildFixture(scenario = { authWall: false, transientFailures: [] }) {
  const chromeApi = makeFakeChrome();
  const storage = new StorageManager(`xhs-int-${Math.random().toString(36).slice(2)}`);
  const tabs = makeTabs(scenario);
  const scraper = new Scraper({
    storage,
    llm: makeStubLlm(),
    patterns: PATTERNS,
    tabs,
    sleep: noSleep,
  });
  install({ chromeApi, storage, scraper, getApiKey: () => 'test-key' });
  const handler = chromeApi.runtime.onMessage._handlers[0];
  const alarmHandler = chromeApi.alarms.onAlarm._handlers[0];
  return { chromeApi, storage, tabs, scraper, handler, alarmHandler };
}

function makeSendResponse() {
  const responses = [];
  const fn = (r) => responses.push(r);
  fn.responses = responses;
  fn.last = () => responses[responses.length - 1];
  return fn;
}

// 轮询 GET_PROGRESS 直到 status === terminalStatus。
async function waitForTask(handler, taskId, terminalStatus, timeout = 3000) {
  const start = Date.now();
  for (;;) {
    const r = makeSendResponse();
    await handler({ type: 'GET_PROGRESS', taskId }, {}, r);
    const resp = r.last();
    if (resp && resp.ok && resp.status === terminalStatus) return resp;
    if (Date.now() - start > timeout) {
      throw new Error(`waitForTask 超时：期望 ${terminalStatus}，最新 ${resp?.status}`);
    }
    await new Promise((res) => setTimeout(res, 10));
  }
}

async function getProgress(handler, taskId) {
  const r = makeSendResponse();
  await handler({ type: 'GET_PROGRESS', taskId }, {}, r);
  return r.last();
}

// 标准 seed 任务结构（含完整 progress/timestamps，避免 StorageManager 业务逻辑缺失）。
function seedTask(id, overrides = {}) {
  return {
    id,
    status: 'running',
    keyword: '护肤',
    config: { notesLimit: 3, commentsPerNote: 0, outputFormat: 'json' },
    progress: {
      phase: 'collectingNotes',
      notesCollected: 0,
      notesTotal: 0,
      currentNoteIndex: -1,
      commentsCollected: 0,
      scrollCount: 0,
      noteUrls: [],
    },
    timestamps: { createdAt: 1, startedAt: 1, completedAt: null },
    errors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) 核心链路：START_TASK → 完成，3 篇笔记，导出 JSON/CSV 正确。
// ---------------------------------------------------------------------------
test('(a) 核心链路：START_TASK 采集 3 篇并导出 JSON/CSV', async () => {
  const { storage, handler } = buildFixture({ authWall: false, transientFailures: [] });

  const startResp = makeSendResponse();
  await handler({ type: 'START_TASK', keyword: '护肤', config: { notesLimit: 3 } }, {}, startResp);
  const taskId = startResp.last().taskId;
  assert.ok(taskId, 'START_TASK 应返回 taskId');

  await waitForTask(handler, taskId, 'completed');

  const prog = await getProgress(handler, taskId);
  assert.equal(prog.status, 'completed');
  assert.equal(prog.notesCount, 3, '应采集 3 篇笔记');
  assert.equal(prog.progress.phase, 'done', '最终进度 phase 应为 done');

  const notes = await storage.getNotesByTaskId(taskId);
  assert.equal(notes.length, 3, '存储中应落库 3 篇笔记');

  // 导出 JSON 可解析且为 3 条
  const jsonResp = makeSendResponse();
  await handler({ type: 'EXPORT_DATA', taskId, format: 'json' }, {}, jsonResp);
  const json = jsonResp.last();
  assert.equal(json.ok, true);
  assert.equal(json.format, 'json');
  const parsed = JSON.parse(json.data);
  assert.equal(parsed.length, 3, '导出 JSON 应含 3 条笔记');

  // 导出 CSV 含表头 + 3 行
  const csvResp = makeSendResponse();
  await handler({ type: 'EXPORT_DATA', taskId, format: 'csv' }, {}, csvResp);
  const csv = csvResp.last();
  assert.equal(csv.ok, true);
  assert.equal(csv.format, 'csv');
  const lines = csv.data.split('\n');
  assert.equal(lines.length, 4, 'CSV 应为 表头 + 3 数据行');
  assert.equal(
    lines[0],
    'id,taskId,url,title,content,author,likes,tags,commentsCount,collectedAt',
    'CSV 表头应完整'
  );
});

// ---------------------------------------------------------------------------
// (b) 断点续传：seed running 任务（已采 2 篇，currentNoteIndex=1，共 3 个 URL）→
//     闹钟触发 resume → 仅补第 3 篇（总计 3）。
// ---------------------------------------------------------------------------
test('(b) 中断恢复：alarm → resume 仅补采第 3 篇（合计 3）', async () => {
  const { storage, alarmHandler } = buildFixture({ authWall: false, transientFailures: [] });

  const task = seedTask('task_resume', {
    progress: {
      phase: 'collectingNotes',
      notesCollected: 2,
      notesTotal: 3,
      currentNoteIndex: 1,
      commentsCollected: 2,
      scrollCount: 1,
      noteUrls: STUB_URLS,
    },
  });
  await storage.saveTask(task);
  // 已成功采集 index 0,1
  for (let i = 0; i < 2; i++) {
    await storage.saveNote({
      id: `note_task_resume_${i}`,
      taskId: 'task_resume',
      url: STUB_URLS[i],
      title: `已存在${i}`,
      content: 'c',
      author: 'a',
      commentList: [],
      collectedAt: 100 + i,
    });
  }

  // 触发 keepalive 闹钟 → resumeRunning → scraper.resume（端到端）
  await alarmHandler({ name: 'keepalive' });

  const notes = await storage.getNotesByTaskId('task_resume');
  assert.equal(notes.length, 3, '续传后应共 3 篇（原有 2 + 新增 1）');
  assert.ok(
    notes.find((n) => n.id === 'note_task_resume_2' && n.url === STUB_URLS[2]),
    '第 3 篇应被新采集'
  );
  const saved = await storage.getTask('task_resume');
  assert.equal(saved.status, 'completed', '续传完成应标记 completed');
  assert.equal(saved.errors.length, 0, '续传不应产生错误');
});

// ---------------------------------------------------------------------------
// (c) 未登录拦截：authWall=true → status=failed，errors 含 AUTH_REQUIRED。
// ---------------------------------------------------------------------------
test('(c) 未登录拦截：authWall=true → failed 且 errors 含 AUTH_REQUIRED', async () => {
  const { storage, handler } = buildFixture({ authWall: true, transientFailures: [] });

  const startResp = makeSendResponse();
  await handler({ type: 'START_TASK', keyword: '护肤', config: { notesLimit: 3 } }, {}, startResp);
  const taskId = startResp.last().taskId;

  await waitForTask(handler, taskId, 'failed');

  const saved = await storage.getTask(taskId);
  assert.equal(saved.status, 'failed', '未登录应标记 failed（非 generic fatal）');
  assert.ok(
    saved.errors.some((e) => e.code === 'AUTH_REQUIRED'),
    'errors 应含 code=AUTH_REQUIRED 条目'
  );
  assert.equal(saved.progress.phase, 'searching', '鉴权检测应在搜索阶段触发');
});

// ---------------------------------------------------------------------------
// (d) 网络波动重试：scroll 瞬态失败 2 次后成功 → 仍完成 3 篇，无错误。
// ---------------------------------------------------------------------------
test('(d) 网络波动重试：scroll 瞬态失败 2 次后成功 → 仍完成 3 篇', async () => {
  const { storage, tabs, handler } = buildFixture({
    authWall: false,
    transientFailures: ['scroll'],
    transientLimit: 2,
  });

  const startResp = makeSendResponse();
  await handler({ type: 'START_TASK', keyword: '护肤', config: { notesLimit: 3 } }, {}, startResp);
  const taskId = startResp.last().taskId;

  await waitForTask(handler, taskId, 'completed');

  const notes = await storage.getNotesByTaskId(taskId);
  assert.equal(notes.length, 3, '重试成功后应完成 3 篇');
  const saved = await storage.getTask(taskId);
  assert.equal(saved.errors.length, 0, '瞬态重试应无错误记录');

  // 验证 scroll 确实被重试了（前 2 次瞬态失败 + 第 3 次成功 = 至少 3 次调用）
  const scrollCalls = tabs.ops.messages.filter((m) => m.action === 'scroll').length;
  assert.ok(scrollCalls >= 3, `scroll 应被重试（实际 ${scrollCalls} 次）`);
});

// ---------------------------------------------------------------------------
// 单元级校验：AuthRequiredError 应被正确导出。
// ---------------------------------------------------------------------------
test('AuthRequiredError 被导出且 code 为 AUTH_REQUIRED', () => {
  const err = new AuthRequiredError('task_x');
  assert.equal(err.name, 'AuthRequiredError');
  assert.equal(err.code, 'AUTH_REQUIRED');
});
