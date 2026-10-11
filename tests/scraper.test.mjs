import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageManager } from '../src/background/storage.js';
import { TaskManager } from '../src/background/task-manager.js';
import { Scraper } from '../src/background/scraper.js';

const PATTERNS = JSON.parse(
  readFileSync(new URL('../src/config/site-patterns.json', import.meta.url), 'utf8')
);

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

// 真实 site-patterns.json 的扁平结构（整站文件，按域名嵌套）。
function makeLlm({ noteUrls = [], failDetailCall = null } = {}) {
  let detailCalls = 0;
  return {
    extractNoteList: async () => noteUrls,
    extractNoteDetail: async () => {
      detailCalls += 1;
      if (failDetailCall != null && detailCalls === failDetailCall) {
        throw new Error('LLM extractNoteDetail 模拟失败');
      }
      return { title: '标题', content: '正文', author: '作者', likes: 9, tags: ['t1'], images: ['i1'] };
    },
    extractComments: async () => [{ author: '评论者', text: '评论', likes: 1, publishedAt: '刚刚' }],
    _detailCalls: () => detailCalls,
  };
}

function makeTabs() {
  const ops = { created: [], updated: [], removed: [], messages: [] };
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
    remove: async (id) => {
      ops.removed.push(id);
    },
    sendMessage: async (tabId, msg) => {
      ops.messages.push(msg);
      // 登录弹窗检测：命中 loginDialog 选择器时默认「无弹窗」(ok:false)，避免误触发 AuthRequiredError。
      if (
        msg.action === 'waitFor' &&
        msg.selectors &&
        msg.selectors.some((s) => String(s).includes('login-container'))
      ) {
        return { ok: false };
      }
      switch (msg.action) {
        case 'waitFor':
        case 'scroll':
        case 'click':
        case 'closeModal':
          return { ok: true };
        case 'getHTML':
          return { ok: true, data: `<div class="sel">${msg.selectors?.[0] ?? 'html'}</div>` };
        default:
          return { ok: true };
      }
    },
  };
}

const noSleep = async () => {};

function makeScraper(opts = {}) {
  const storage = opts.storage ?? new StorageManager(`xhs-sc-test-${Math.random().toString(36).slice(2)}`);
  const scraper = new Scraper({
    storage,
    llm: opts.llm ?? makeLlm(),
    patterns: opts.patterns ?? PATTERNS,
    tabs: opts.tabs ?? makeTabs(),
    sleep: opts.sleep ?? noSleep,
  });
  return { scraper, storage };
}

function baseTask(id, overrides = {}) {
  return {
    id,
    status: 'running',
    keyword: '护肤',
    config: { notesLimit: 3, commentsPerNote: 5, outputFormat: 'json' },
    progress: {
      phase: 'idle',
      notesCollected: 0,
      notesTotal: 0,
      currentNoteIndex: -1,
      commentsCollected: 0,
      scrollCount: 0,
      noteUrls: [],
    },
    timestamps: { createdAt: 1, startedAt: null, completedAt: null },
    errors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) 搜索阶段采集 noteUrls 并写入进度
// ---------------------------------------------------------------------------

test('(a) run() 在搜索阶段采集 noteUrls 并保存到 progress', async () => {
  const urls = ['https://xhs.com/explore/1', 'https://xhs.com/explore/2', 'https://xhs.com/explore/3'];
  const llm = makeLlm({ noteUrls: urls.map((u) => ({ url: u, title: 't', author: 'a', likes: 1, type: '图文' })) });
  const { scraper, storage } = makeScraper({ llm });

  const task = baseTask('task_a');
  await storage.saveTask(task);
  await scraper.run(task);

  const saved = await scraper.taskManager.getTask('task_a');
  assert.deepEqual(saved.progress.noteUrls, urls, '搜索阶段应保存 noteUrls');
  assert.equal(saved.progress.notesTotal, 3);
  assert.ok(saved.progress.scrollCount >= 1, '应至少滚动一次');
  assert.equal(saved.progress.phase, 'done');
});

// ---------------------------------------------------------------------------
// (b) 详情+评论阶段落库、标记完成、notesCollected == notesLimit
// ---------------------------------------------------------------------------

test('(b) run() 采集详情与评论、落库、标记 completed，notesCollected == notesLimit', async () => {
  const urls = ['https://xhs.com/explore/1', 'https://xhs.com/explore/2', 'https://xhs.com/explore/3'];
  const llm = makeLlm({ noteUrls: urls.map((u) => ({ url: u })) });
  const { scraper, storage } = makeScraper({ llm });

  const task = baseTask('task_b');
  await storage.saveTask(task);
  await scraper.run(task);

  const notes = await storage.getNotesByTaskId('task_b');
  assert.equal(notes.length, 3, '应保存 3 条笔记');
  assert.equal(task.progress.notesCollected, 3, 'notesCollected 应等于 notesLimit');
  assert.equal(notes[0].commentList.length, 1, '每条笔记应含评论');
  assert.equal(notes[0].taskId, 'task_b');
  assert.ok(notes[0].collectedAt, '应记录采集时间');
  assert.equal(task.status, 'completed', '任务应标记 completed');
});

// ---------------------------------------------------------------------------
// (c) 断点续传：从 currentNoteIndex+1 继续，不重复处理已采集
// ---------------------------------------------------------------------------

test('(c) resume() 从 checkpoint 续传，仅处理 indices 3,4（共 5 条），extractNoteDetail 仅调用 2 次', async () => {
  const urls = [
    'https://xhs.com/explore/1',
    'https://xhs.com/explore/2',
    'https://xhs.com/explore/3',
    'https://xhs.com/explore/4',
    'https://xhs.com/explore/5',
  ];
  // resume 期间 extractNoteDetail 不应重取 0/1/2
  const llm = makeLlm({ noteUrls: urls.map((u) => ({ url: u })) });
  const { scraper, storage } = makeScraper({ llm });

  // 预置：已采集 0,1,2，currentNoteIndex=2，noteUrls 共 5 条
  const task = baseTask('task_c', {
    progress: {
      phase: 'collectingNotes',
      notesCollected: 3,
      notesTotal: 5,
      currentNoteIndex: 2,
      commentsCollected: 3,
      scrollCount: 1,
      noteUrls: urls,
    },
  });
  await storage.saveTask(task);
  for (let i = 0; i < 3; i++) {
    await storage.saveNote({
      id: `note_task_c_${i}`,
      taskId: 'task_c',
      url: urls[i],
      title: `已存在${i}`,
      content: 'c',
      author: 'a',
      commentList: [],
      collectedAt: 100 + i,
    });
  }

  await scraper.resume(task);

  const notes = await storage.getNotesByTaskId('task_c');
  assert.equal(notes.length, 5, '续传后应共 5 条（原有 3 + 新增 2）');
  assert.equal(task.progress.notesCollected, 5, 'notesCollected 应从 3 增至 5');
  assert.equal(task.progress.currentNoteIndex, 4, '续传完成后 currentNoteIndex 应指向最后一条');
  assert.equal(llm._detailCalls(), 2, 'resume 期间 extractNoteDetail 仅应被调用 2 次（indices 3,4）');
  // 原有 3 条应原样保留（未被覆盖/重取）
  assert.ok(notes.find((n) => n.id === 'note_task_c_0' && n.title === '已存在0'));
  assert.equal(task.status, 'completed');
});

// ---------------------------------------------------------------------------
// (d) 单条笔记失败：记录到 errors，其余继续完成
// ---------------------------------------------------------------------------

test('(d) 单条笔记失败被记录到 errors，其余笔记仍完成', async () => {
  const urls = ['https://xhs.com/explore/1', 'https://xhs.com/explore/2', 'https://xhs.com/explore/3'];
  // 让第 2 次 extractNoteDetail 调用（即 index 1）失败
  const llm = makeLlm({ noteUrls: urls.map((u) => ({ url: u })), failDetailCall: 2 });
  const { scraper, storage } = makeScraper({ llm });

  const task = baseTask('task_d');
  await storage.saveTask(task);
  await scraper.run(task);

  const notes = await storage.getNotesByTaskId('task_d');
  assert.equal(notes.length, 2, '失败的笔记不应落库，其余 2 条应保存');
  assert.equal(task.progress.notesCollected, 2, 'notesCollected 应为 2');
  assert.equal(task.errors.length, 1, '应记录 1 条错误');
  assert.equal(task.status, 'completed', '任务仍应整体 completed（不因单条失败中止）');

  // 持久化契约：错误历史应从存储中读回（不在 task.progress 内污染）。
  const saved = await scraper.taskManager.getTask('task_d');
  assert.equal(saved.errors.length, 1, '错误应落库到 task.errors');
  assert.equal(saved.progress.errors, undefined, 'task.progress 不应被 errors 污染');
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

test('cancel(taskId) 将任务标记为 cancelled', async () => {
  const { scraper, storage } = makeScraper();
  const task = baseTask('task_cancel');
  await storage.saveTask(task);
  await scraper.cancel('task_cancel');
  const saved = await scraper.taskManager.getTask('task_cancel');
  assert.equal(saved.status, 'cancelled');
});

// ---------------------------------------------------------------------------
// (e) 进行中的 run() 应被 cancel 中断：循环边界检查取消标志，任务置为 cancelled 而非 failed
// ---------------------------------------------------------------------------

test('(e) 进行中的 run() 被 cancel 中断，任务置为 cancelled（不记为失败）', async () => {
  // LLM 每次只返回同一个 URL，使搜索阶段持续滚动（永远达不到 notesLimit=3）。
  const onlyUrl = 'https://xhs.com/explore/1';
  const llm = makeLlm({ noteUrls: [{ url: onlyUrl }] });
  const tabs = makeTabs();
  const storage = new StorageManager(`xhs-e-${Math.random().toString(36).slice(2)}`);
  const scraper = new Scraper({ storage, llm, patterns: PATTERNS, tabs, sleep: noSleep });
  let cancelTriggered = false;
  // 包装 sleep：首次调用即触发取消（模拟运行中收到取消信号）
  scraper.sleep = async () => {
    if (!cancelTriggered) {
      cancelTriggered = true;
      await scraper.cancel('task_e');
    }
  };

  const task = baseTask('task_e');
  await storage.saveTask(task);
  await scraper.run(task);

  const saved = await scraper.taskManager.getTask('task_e');
  assert.equal(saved.status, 'cancelled', 'run 中途被 cancel 应置为 cancelled');
  assert.notEqual(task.progress.phase, 'done', '被取消的任务不应进入 done 阶段');
  assert.equal(task.errors.length, 0, '取消不应记为失败错误');
});

// ---------------------------------------------------------------------------
// (g) cancel 对已终态（completed）任务幂等返回，不抛「非法状态转移」、不泄漏取消标志
// ---------------------------------------------------------------------------

test('(g) cancel 对已终态（completed）任务幂等，不抛错、不泄漏取消标志', async () => {
  const { scraper, storage } = makeScraper();
  const task = baseTask('task_g', { status: 'completed', progress: { phase: 'done' } });
  await storage.saveTask(task);

  // 不应抛错，应原样返回，状态保持 completed。
  const returned = await scraper.cancel('task_g');
  assert.equal(returned.status, 'completed', '已 completed 的任务 cancel 应幂等、状态不变');

  const saved = await scraper.taskManager.getTask('task_g');
  assert.equal(saved.status, 'completed');
  // 取消标志不应泄漏到实例集合（running 之外的任务不会进入 _cancelled）。
  assert.equal(scraper._cancelled.has('task_g'), false, '非 running 任务不应写入 _cancelled 集合');
});

// ---------------------------------------------------------------------------
// (f) 搜索阶段中断（phase=searching、noteUrls 部分采集）后 resume 应补完搜索
// ---------------------------------------------------------------------------

test('(f) 搜索阶段中断后 resume 会补完搜索，而非静默少采', async () => {
  const urls = ['https://xhs.com/explore/1', 'https://xhs.com/explore/2', 'https://xhs.com/explore/3'];
  const llm = makeLlm({ noteUrls: urls.map((u) => ({ url: u })) });
  const { scraper, storage } = makeScraper({ llm });

  // 预置：搜索阶段中断 —— phase 仍为 searching，noteUrls 仅 1 条（部分采集）
  const task = baseTask('task_f', {
    progress: {
      phase: 'searching',
      notesCollected: 0,
      notesTotal: 1,
      currentNoteIndex: -1,
      commentsCollected: 0,
      scrollCount: 1,
      noteUrls: [urls[0]],
    },
  });
  await storage.saveTask(task);
  await scraper.resume(task);

  const saved = await scraper.taskManager.getTask('task_f');
  assert.equal(saved.progress.noteUrls.length, 3, 'resume 应补完搜索至 notesLimit=3（而不是沿用部分 1 条）');
  assert.equal(task.progress.notesCollected, 3, '三篇笔记都应被采集');
  assert.equal(task.status, 'completed');
});

// ---------------------------------------------------------------------------
// (h) crawlDelay 微调：task.config.crawlDelay > 0 时 _randomPause 使用固定延迟
// ---------------------------------------------------------------------------

test('(h) crawlDelay > 0 时 _randomPause 睡眠固定 ms（而非随机 2-5s）', async () => {
  const sleeps = [];
  const { scraper } = makeScraper({ sleep: async (ms) => { sleeps.push(ms); } });
  await scraper._randomPause({ config: { crawlDelay: 1000 } });
  assert.equal(sleeps.length, 1, '应恰好调用一次 sleep');
  assert.equal(sleeps[0], 1000, 'sleep 应收到固定 crawlDelay=1000ms');
});

test('(h2) crawlDelay 缺省/0 时 _randomPause 仍用随机 2-5s', async () => {
  const sleeps = [];
  const { scraper } = makeScraper({ sleep: async (ms) => { sleeps.push(ms); } });
  await scraper._randomPause({ config: {} });
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 2000 && sleeps[0] <= 5000, `随机延迟应在 2-5s 之间，实际 ${sleeps[0]}`);
});

// ---------------------------------------------------------------------------
// (i) 瞬态错误重试：TAB_NOT_READY 等可重试；SELECTOR_NOT_FOUND 等永久错误快速失败
// ---------------------------------------------------------------------------

test('(i) _send 对瞬态错误（TAB_NOT_READY）重试直至成功', async () => {
  let attempts = 0;
  const tabs = {
    sendMessage: async () => {
      attempts += 1;
      if (attempts <= 2) return { ok: false, error: 'TAB_NOT_READY' }; // 前 2 次瞬态失败
      return { ok: true, data: 'ok' };
    },
  };
  const { scraper } = makeScraper({ tabs, sleep: noSleep });
  const res = await scraper._send(1, { action: 'scroll' });
  assert.equal(attempts, 3, '2 次失败 + 1 次成功 = 共 3 次调用');
  assert.equal(res.ok, true);
});

test('(i2) _send 对永久错误（SELECTOR_NOT_FOUND）立即失败，不重试', async () => {
  let attempts = 0;
  const tabs = {
    sendMessage: async () => {
      attempts += 1;
      return { ok: false, error: 'SELECTOR_NOT_FOUND' };
    },
  };
  const { scraper } = makeScraper({ tabs, sleep: noSleep });
  await assert.rejects(() => scraper._send(1, { action: 'waitFor' }), /SELECTOR_NOT_FOUND/);
  assert.equal(attempts, 1, '永久错误不应重试');
});

test('(i3) _send 对通信层抛错（瞬态）重试后成功', async () => {
  let attempts = 0;
  const tabs = {
    sendMessage: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('tab crashed'); // 通信层抛错 = 瞬态
      return { ok: true };
    },
  };
  const { scraper } = makeScraper({ tabs, sleep: noSleep });
  const res = await scraper._send(1, { action: 'getHTML' });
  assert.equal(attempts, 2, '通信抛错应重试一次后成功');
  assert.equal(res.ok, true);
});

test('(j) 详情采集采用独立 URL 导航时，不再发送多余的 closeModal 消息', async () => {
  const sentActions = [];
  const tabs = {
    create: async () => ({ id: 10 }),
    update: async () => {},
    sendMessage: async (id, msg) => {
      sentActions.push(msg.action);
      if (msg.action === 'getHTML') return { ok: true, data: '<div>mock</div>' };
      return { ok: true };
    },
  };
  const llm = makeLlm();
  const { scraper, storage } = makeScraper({ tabs, llm });

  const task = baseTask('task_j', {
    progress: {
      phase: 'searching',
      notesCollected: 0,
      notesTotal: 1,
      currentNoteIndex: -1,
      commentsCollected: 0,
      scrollCount: 1,
      noteUrls: ['https://xhs.com/explore/1'],
    },
    config: { notesLimit: 1 },
  });
  await storage.saveTask(task);
  await scraper._detailPhase(task);

  assert.equal(sentActions.includes('closeModal'), false, '直接 URL 导航不应发送 closeModal');
});

test('(k) 任务完成 (completed) 后自动关闭后台标签页并释放 _tabId', async () => {
  const tabs = makeTabs();
  const llm = makeLlm({ noteUrls: [{ url: 'https://xhs.com/explore/1', title: 't', author: 'a', likes: 1, type: '图文' }] });
  const { scraper, storage } = makeScraper({ tabs, llm });

  const task = baseTask('task_k', { config: { notesLimit: 1 } });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.equal(task.status, 'completed');
  assert.deepEqual(tabs.ops.removed, [1], '采集完成后应调用 tabs.remove 关闭创建的标签页');
  assert.equal(scraper._tabId, null, 'scraper._tabId 应被重置为 null');
});

test('(l) 任务失败 (failed) 时依然在 finally 块中关闭标签页', async () => {
  const tabs = makeTabs();
  const llm = makeLlm({ failDetailCall: 1, noteUrls: [{ url: 'https://xhs.com/explore/1', title: 't' }] });
  const { scraper, storage } = makeScraper({ tabs, llm });

  // 模拟搜索阶段抛错（如 feedsContainer 超时）
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'waitFor' && msg.selectors?.[0]?.includes('feeds-page')) {
      return { ok: false, error: 'SELECTOR_NOT_FOUND' };
    }
    return { ok: true };
  };

  const task = baseTask('task_l');
  await storage.saveTask(task);
  await scraper.run(task);

  assert.equal(task.status, 'failed');
  assert.deepEqual(tabs.ops.removed, [1], '任务失败时也应安全关闭创建的标签页');
  assert.equal(scraper._tabId, null);
});


