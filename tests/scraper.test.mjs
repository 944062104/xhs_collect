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
  assert.ok(task.progress.stepMessage.startsWith('采集失败：'), '失败时 stepMessage 应明确展示采集失败原因');
  assert.deepEqual(tabs.ops.removed, [1], '任务失败时也应安全关闭创建的标签页');
  assert.equal(scraper._tabId, null);
});

test('(m) 搜索阶段提取相对路径时自动补全为 https://www.xiaohongshu.com 开头的绝对路径', async () => {
  const tabs = makeTabs();
  const llm = makeLlm({
    noteUrls: [{ url: '/explore/abc12345', title: '相对路径笔记' }],
  });
  const { scraper, storage } = makeScraper({ tabs, llm });

  const task = baseTask('task_m', { config: { notesLimit: 1 } });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.equal(task.status, 'completed');
  assert.equal(task.progress.noteUrls[0], 'https://www.xiaohongshu.com/explore/abc12345');
});

test('(n) 详情阶段遭遇小红书频控阻断（扫码/当前笔记暂时无法浏览）时触发熔断保护并停止', async () => {
  const tabs = makeTabs();
  const llm = makeLlm({
    noteUrls: [{ url: 'https://xhs.com/explore/rate_limit_1', title: '正常搜索' }],
  });
  const { scraper, storage } = makeScraper({ tabs, llm });

  const origSendMessage = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'getNoteDetail') {
      return { ok: false, error: 'RATE_LIMITED', code: 300031 };
    }
    return origSendMessage(id, msg);
  };

  const task = baseTask('task_n', { config: { notesLimit: 1 } });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.equal(task.status, 'failed');
  assert.ok(task.errors.some((e) => e.code === 'RATE_LIMITED'), 'task.errors 中应记录 RATE_LIMITED');
  assert.ok(task.progress.stepMessage.includes('触发小红书频控保护'), 'stepMessage 应提示频控保护已自动停止');
  assert.deepEqual(tabs.ops.removed, [1], '频控熔断后应安全关闭标签页');
});

test('(o) finishEarly(taskId) 允许用户提前结束采集并将任务以 completed 状态归档保存', async () => {
  const tabs = makeTabs();
  const llm = makeLlm({
    noteUrls: [
      { url: 'https://xhs.com/explore/1', title: 't1' },
      { url: 'https://xhs.com/explore/2', title: 't2' },
      { url: 'https://xhs.com/explore/3', title: 't3' },
    ],
  });
  const { scraper, storage } = makeScraper({ tabs, llm });

  const task = baseTask('task_early_end', { config: { notesLimit: 10 } });
  await storage.saveTask(task);

  // 在第一条采集过程中调用 finishEarly
  const origExtract = llm.extractNoteDetail;
  llm.extractNoteDetail = async (html) => {
    const res = await origExtract(html);
    // 第一篇采完后用户点击「提前完成」
    await scraper.finishEarly(task.id);
    return res;
  };

  await scraper.run(task);

  const finalTask = await storage.getTask('task_early_end');
  assert.equal(finalTask.status, 'completed', '提前结束的任务应处于 completed 状态');
  assert.ok(finalTask.progress.stepMessage.includes('提前完成采集'), 'stepMessage 应提示已保存全部数据');
  assert.deepEqual(tabs.ops.removed, [1], '提前结束后标签页应安全关闭');
});

test('(p) 批量关键词输入（逗号分隔）在搜索阶段分别检索各词并合并去重 URL', async () => {
  const tabs = makeTabs();
  const llm = makeLlm();
  const { scraper, storage } = makeScraper({ tabs, llm });

  // 模拟搜索阶段分别为不同关键词返回不同笔记链接
  let currentNavUrl = '';
  tabs.create = async ({ url }) => {
    currentNavUrl = url;
    tabs.ops.created.push(url);
    return { id: 1 };
  };
  tabs.update = async (id, { url }) => {
    currentNavUrl = url;
    tabs.ops.updated.push(url);
    return { id };
  };
  const origSendMessage = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'getNoteUrls') {
      if (currentNavUrl.includes(encodeURIComponent('护肤'))) {
        return { ok: true, data: ['https://xhs.com/explore/skin1'] };
      }
      if (currentNavUrl.includes(encodeURIComponent('穿搭'))) {
        return { ok: true, data: ['https://xhs.com/explore/outfit1'] };
      }
    }
    return origSendMessage(id, msg);
  };

  const task = baseTask('task_batch_kw', {
    keyword: '护肤, 穿搭',
    config: { notesLimit: 2 },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.equal(task.status, 'completed');
  assert.equal(task.progress.noteUrls.length, 2);
  assert.ok(task.progress.noteUrls.includes('https://xhs.com/explore/skin1'));
  assert.ok(task.progress.noteUrls.includes('https://xhs.com/explore/outfit1'));
});

test('(q) commentsPerNote 为 0 时跳过评论提取阶段（极速模式）', async () => {
  const tabs = makeTabs();
  let commentsRequested = false;
  const llm = makeLlm({
    noteUrls: [{ url: 'https://xhs.com/explore/no_comment', title: 't' }],
  });
  llm.extractComments = async () => {
    commentsRequested = true;
    return [];
  };
  const { scraper, storage } = makeScraper({ tabs, llm });

  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'getComments') {
      commentsRequested = true;
    }
    return origSend(id, msg);
  };

  const task = baseTask('task_no_comment', {
    config: { notesLimit: 1, commentsPerNote: 0 },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.equal(task.status, 'completed');
  assert.equal(commentsRequested, false, 'commentsPerNote 为 0 时不应触发任何评论获取动作');
});

test('(r) cancel(taskId) 立即关闭后台标签页以停止正在进行的页面操作', async () => {
  const tabs = makeTabs();
  const { scraper, storage } = makeScraper({ tabs });
  scraper._tabId = 99; // 模拟当前活动 tab

  const task = baseTask('task_cancel_tab');
  await storage.saveTask(task);
  await scraper.cancel('task_cancel_tab');

  assert.equal(scraper._tabId, null, 'cancel 后 scraper._tabId 应置为 null');
  assert.deepEqual(tabs.ops.removed, [99], 'cancel 后应立即调用 tabs.remove 关闭当前标签页');
});

test('(s) run() 在执行中因取消引发网络/Fetch AbortError 时视为已取消而非失败', async () => {
  const tabs = makeTabs();
  const llm = makeLlm({
    noteUrls: [{ url: 'https://xhs.com/explore/abort_test', title: 't' }],
  });
  const { scraper, storage } = makeScraper({ tabs, llm });

  // 模拟在详情阶段网络请求被 abort（典型如 LLMClient fetch 遇到 abort）
  llm.extractNoteDetail = async () => {
    // 模拟 cancel 动作
    await scraper.cancel('task_abort');
    const err = new Error('LLM API 网络请求失败：The user aborted a request.');
    throw err;
  };

  const task = baseTask('task_abort', { config: { notesLimit: 1 } });
  await storage.saveTask(task);
  await scraper.run(task);

  const saved = await scraper.taskManager.getTask('task_abort');
  assert.equal(saved.status, 'cancelled', '中途取消引发 abort 时任务状态应为 cancelled');
  assert.equal(task.errors.length, 0, '中途取消引发 abort 不应向 task.errors 写入失败记录');
});

test('(t) 搜索阶段返回的笔记数远多于 notesLimit 时（如 DOM 一次性返回 56 条），严格截断至 notesLimit', async () => {
  const tabs = makeTabs();
  const raw56 = Array.from({ length: 56 }, (_, i) => `/explore/note_${i + 1}`);
  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'getNoteUrls') {
      return { ok: true, data: raw56 };
    }
    return origSend(id, msg);
  };

  const { scraper, storage } = makeScraper({ tabs });
  const task = baseTask('task_limit_cap', {
    config: { notesLimit: 20, commentsPerNote: 0 },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  const saved = await scraper.taskManager.getTask('task_limit_cap');
  assert.equal(saved.progress.noteUrls.length, 20, 'noteUrls 数量应被严格限制在 notesLimit (20)');
  assert.equal(saved.progress.notesTotal, 20, 'notesTotal 应等于 notesLimit (20)');
  assert.equal(saved.progress.notesCollected, 20, '采集完成数应为 20');
});

test('(u) 单篇笔记在详情阶段遭遇 LLM 超时时，仅记录该篇错误并跳过，后续笔记继续正常采集', async () => {
  const urls = ['https://xhs.com/explore/1', 'https://xhs.com/explore/2'];
  const llm = makeLlm({ noteUrls: urls.map((u) => ({ url: u })) });
  // 第 1 篇模拟超时抛错，第 2 篇正常
  let call = 0;
  llm.extractNoteDetail = async () => {
    call++;
    if (call === 1) throw new Error('LLM API 请求超时：超过 60 秒无响应');
    return { title: '笔记2', content: '内容2' };
  };

  const { scraper, storage } = makeScraper({ llm });
  const task = baseTask('task_timeout_isolation', { config: { notesLimit: 2, commentsPerNote: 0 } });
  await storage.saveTask(task);
  await scraper.run(task);

  const saved = await scraper.taskManager.getTask('task_timeout_isolation');
  assert.equal(saved.status, 'completed', '单篇超时不应导致任务中断或变为 cancelled');
  assert.equal(saved.progress.notesCollected, 1, '第 2 篇应成功采集');
  assert.equal(saved.errors.length, 1, '第 1 篇错误应登记在 errors 数组中');
  assert.ok(saved.errors[0].error.includes('超时'));
});

test('(v) 当 DOM 提取评论成功且结果为 0 条时（笔记无评论），不回退调用 extractComments', async () => {
  let llmCommentsCalled = false;
  const llm = makeLlm({
    noteUrls: [{ url: 'https://xhs.com/explore/zero_comment' }],
  });
  llm.extractComments = async () => {
    llmCommentsCalled = true;
    return [];
  };

  const tabs = makeTabs();
  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'getNoteDetail') {
      return { ok: true, data: { title: '测试笔记', content: '内容', author: '作者' } };
    }
    if (msg.action === 'getComments') {
      return { ok: true, data: [] }; // DOM 成功执行但笔记实际为 0 条评论
    }
    return origSend(id, msg);
  };

  const { scraper, storage } = makeScraper({ tabs, llm });
  const task = baseTask('task_zero_comments', { config: { notesLimit: 1, commentsPerNote: 10 } });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.equal(llmCommentsCalled, false, 'DOM 已成功确定 0 评论时，不应多余调用 LLM extractComments');
});

test('(w) 搜索阶段若关键词无结果且 LLM 调用失败时，优雅完成而非崩溃，提示未发现笔记', async () => {
  const llm = makeLlm();
  llm.extractNoteList = async () => {
    throw new Error('LLM API 网络请求失败：The user aborted a request.');
  };

  const tabs = makeTabs();
  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'getNoteUrls') {
      return { ok: true, data: [] }; // 模拟敏感词/无结果
    }
    return origSend(id, msg);
  };

  const { scraper, storage } = makeScraper({ tabs, llm });
  const task = baseTask('task_empty_search', { config: { notesLimit: 10 } });
  await storage.saveTask(task);
  await scraper.run(task);

  const saved = await scraper.taskManager.getTask('task_empty_search');
  assert.equal(saved.status, 'completed', '无搜索结果且 LLM 失败时不应崩溃标记为 failed');
  assert.equal(saved.progress.notesTotal, 0, 'notesTotal 应为 0');
  assert.ok(saved.progress.stepMessage.includes('未发现'), 'stepMessage 应提示未发现笔记');
});

test('(x) 搜索阶段根据 config.sortType 优先派发 setSearchSort 动作', async () => {
  const tabs = makeTabs();
  let sortMsg = null;
  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'setSearchSort') {
      sortMsg = msg;
      return { ok: true };
    }
    return origSend(id, msg);
  };

  const { scraper, storage } = makeScraper({ tabs });
  const task = baseTask('task_sort_hot', {
    config: { notesLimit: 1, sortType: 'popularity_descending' },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.ok(sortMsg, '应该触发 setSearchSort 动作');
  assert.equal(sortMsg.sortType, 'popularity_descending');
});

test('(y) 搜索阶段当 setSearchSort 失败时降级通过 selectors 模拟点击，且未匹配时不阻断采集', async () => {
  const tabs = makeTabs();
  let clickMsg = null;
  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'setSearchSort') {
      return { ok: false, error: 'NOT_FOUND' };
    }
    if (msg.action === 'click') {
      clickMsg = msg;
      return { ok: true };
    }
    return origSend(id, msg);
  };

  const { scraper, storage } = makeScraper({ tabs });
  const task = baseTask('task_sort_fallback', {
    config: { notesLimit: 1, sortType: 'popularity_descending' },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.ok(clickMsg, '应该降级触发排序选择器的点击动作');
  assert.ok(clickMsg.selectors.length > 0, '应该传入排序标签的选择器列表');
});

test('(z) 搜索阶段闭环自愈：排序初次未生效时调用 LLM 区域判断学习并二次重试与校验', async () => {
  const tabs = makeTabs();
  let sortCalls = 0;
  let llmLearnCalled = false;
  let retryMsg = null;

  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'setSearchSort') {
      sortCalls++;
      if (sortCalls === 1) {
        // 第一次调用：模拟点击但未激活生效
        return { ok: true, active: false };
      } else {
        // 第二次调用（携带 LLM 学习到的规则）：成功激活
        retryMsg = msg;
        return { ok: true, active: true };
      }
    }
    if (msg.action === 'getInteractiveRegionHtml') {
      return { ok: true, html: '<div class="filter"><span class="btn">筛选</span></div>' };
    }
    return origSend(id, msg);
  };

  const llm = makeLlm();
  llm.learnSearchSortRegion = async (html, targetSortType) => {
    llmLearnCalled = true;
    assert.equal(targetSortType, 'time_descending');
    return {
      regionSelector: ['.filter'],
      filterButton: ['.filter .btn'],
      sortOption: ['//span[text()="最新"]'],
      reason: '识别出右侧筛选区',
    };
  };

  const { scraper, storage } = makeScraper({ tabs, llm });
  const task = baseTask('task_sort_self_healing', {
    config: { notesLimit: 1, sortType: 'time_descending' },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.equal(sortCalls, 2, '应当执行两次 setSearchSort（初次执行 + AI 学习后重试）');
  assert.equal(llmLearnCalled, true, '排序未生效时应当触发 LLM 区域判断自愈学习');
  assert.ok(retryMsg, '第二次重试应携带参数');
  assert.deepEqual(retryMsg.regionSelector, ['.filter'], '重试应携带 LLM 学习到的区域选择器');
  assert.deepEqual(retryMsg.sortOption, ['//span[text()="最新"]'], '重试应携带 LLM 学习到的选项规则');

  // 验证动态规则沉淀到了 storage
  const dynamicRules = await storage.getConfig('dynamic_site_patterns');
  assert.ok(dynamicRules && dynamicRules.search);
  assert.deepEqual(dynamicRules.search.sortRegion, ['.filter']);
});

test('(aa) 目标导向自愈循环：基于 planGoalRemediation 动态研判与动作执行，达成目标后记录历史流水', async () => {
  const tabs = makeTabs();
  let executedRecipes = [];
  let contractStatus = false;
  let planCalls = 0;

  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'checkGoalContract') {
      return { ok: true, achieved: contractStatus, currentActive: contractStatus ? '最新' : '综合' };
    }
    if (msg.action === 'setSearchSort') {
      // 模拟直接设置排序失败
      return { ok: true, active: false };
    }
    if (msg.action === 'executeActionRecipe') {
      executedRecipes.push(msg.recipe);
      // 在第二轮动作后模拟 DOM 状态成功变更
      if (planCalls >= 2) {
        contractStatus = true;
      }
      return { ok: true, executed: true };
    }
    if (msg.action === 'getInteractiveRegionHtml') {
      return { ok: true, html: '<div class="filter-box"><button class="pill">最新</button></div>' };
    }
    return origSend(id, msg);
  };

  const llm = makeLlm();
  llm.planGoalRemediation = async (goal, evidence) => {
    planCalls++;
    if (planCalls === 1) {
      return {
        diagnosis: '未展开浮层，先点击筛选',
        nextAction: { action: 'CLICK', selector: ['.filter-trigger'] },
        achieved: false,
      };
    } else {
      return {
        diagnosis: '已展开浮层，点击最新胶囊',
        nextAction: { action: 'HOVER_CLICK', selector: ['.pill'] },
        achieved: false,
        rulePatch: {
          sortTabs: { time_descending: ['.pill'] },
        },
      };
    }
  };

  const { scraper, storage } = makeScraper({ tabs, llm });
  const task = baseTask('task_goal_loop', {
    config: { notesLimit: 1, sortType: 'time_descending' },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.equal(planCalls, 2, '应当进行 2 轮 AI 规划研判');
  assert.equal(contractStatus, true, '最终应当达成目标契约');

  // 验证任务进度中记录了 remediationState 及其自愈流水
  const updatedTask = await storage.getTask('task_goal_loop');
  const remState = updatedTask.progress.remediationState;
  assert.ok(remState, '任务进度中应记录 remediationState');
  assert.equal(remState.history.length, 2, '历史记录应包含两轮决策证据与执行状态');
  assert.equal(remState.history[0].diagnosis, '未展开浮层，先点击筛选');
  assert.equal(remState.history[1].achieved, true, '第二轮决策后达成契约');

  // 验证规则动态沉淀
  const dynamicRules = await storage.getConfig('dynamic_site_patterns');
  assert.deepEqual(dynamicRules.search.sortTabs.time_descending, ['.pill']);
});

test('(bb) 真实 LLMClient 契约兼容：接收扁平 {action, selector, reason} 能正确分发动作与记录流水', async () => {
  const tabs = makeTabs();
  let executedAction = null;
  let contractStatus = false;

  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'checkGoalContract') {
      return { ok: true, achieved: contractStatus };
    }
    if (msg.action === 'setSearchSort') {
      return { ok: true, active: false };
    }
    if (msg.action === 'executeActionRecipe') {
      executedAction = msg.recipe;
      contractStatus = true;
      return { ok: true, executed: true };
    }
    if (msg.action === 'getInteractiveRegionHtml') {
      return { ok: true, html: '<div class="filter"></div>' };
    }
    return origSend(id, msg);
  };

  const llm = makeLlm();
  // 模拟真实 LLMClient 的输出结构（无 nextAction 包裹，reason 代替 diagnosis）
  llm.planGoalRemediation = async (goal, evidence) => {
    return {
      action: 'CLICK',
      selector: ['.real-selector'],
      reason: '定位到真实排序胶囊并点击',
    };
  };

  const { scraper, storage } = makeScraper({ tabs, llm });
  const task = baseTask('task_flat_contract', {
    config: { notesLimit: 1, sortType: 'time_descending', forceAiRemediation: true },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.ok(executedAction, '应当派发 executeActionRecipe 动作');
  assert.equal(executedAction.action, 'CLICK');
  assert.deepEqual(executedAction.selector, ['.real-selector']);

  const updatedTask = await storage.getTask('task_flat_contract');
  const remState = updatedTask.progress.remediationState;
  assert.ok(remState);
  assert.equal(remState.finished, true, '自愈循环结束后应当标记 finished');
  assert.equal(remState.achieved, true, '达成目标后应当标记 achieved');
  assert.equal(remState.history[0].diagnosis, '定位到真实排序胶囊并点击', '应当从 reason 映射出真实 diagnosis');
});

test('(cc) 严格前置门禁：当自愈学习未达成契约时，严禁降级兜底采集，必须终止任务并标记 failed', async () => {
  const tabs = makeTabs();
  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'checkGoalContract') {
      return { ok: true, achieved: false };
    }
    if (msg.action === 'setSearchSort') {
      return { ok: true, active: false };
    }
    if (msg.action === 'executeActionRecipe') {
      return { ok: false, error: 'SELECTOR_NOT_FOUND' };
    }
    if (msg.action === 'getInteractiveRegionHtml') {
      return { ok: true, html: '<div class="broken"></div>' };
    }
    return origSend(id, msg);
  };

  const llm = makeLlm();
  llm.planGoalRemediation = async () => ({
    action: 'CLICK',
    selector: ['.non-existent'],
    reason: '尝试点击失效选择器',
  });

  const { scraper, storage } = makeScraper({ tabs, llm });
  const task = baseTask('task_strict_gate_fail', {
    config: { notesLimit: 5, sortType: 'time_descending', forceAiRemediation: true },
  });
  await storage.saveTask(task);

  await scraper.run(task);

  const updatedTask = await storage.getTask('task_strict_gate_fail');
  assert.equal(updatedTask.status, 'failed', '目标未达成时任务必须置为 failed');
  assert.equal(updatedTask.progress.notesCollected, 0, '未达成目标排序前决不允许抓取笔记');
  assert.equal(updatedTask.progress.noteUrls.length, 0, '未达成目标排序前决不允许抓取笔记列表');
  assert.ok(updatedTask.progress.remediationState.finished, '自愈状态应当为 finished');
  assert.equal(updatedTask.progress.remediationState.achieved, false, '自愈状态应当为 achieved: false');
});

test('(dd) 搜索阶段集成多维筛选：当配置了 noteType 或 publishTime 时派发 applySearchFilters 消息', async () => {
  const tabs = makeTabs();
  let applyFiltersMsg = null;

  const origSend = tabs.sendMessage;
  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'applySearchFilters') {
      applyFiltersMsg = msg;
      return { ok: true, applied: { '最多评论': true, '图文': true } };
    }
    return origSend(id, msg);
  };

  const { scraper, storage } = makeScraper({ tabs });
  const task = baseTask('task_multi_filters', {
    config: {
      notesLimit: 1,
      sortType: 'comments_descending',
      noteType: 'image',
      publishTime: 'week',
    },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  assert.ok(applyFiltersMsg, '应当向页面派发 applySearchFilters 消息');
  assert.equal(applyFiltersMsg.filters.sortType, 'comments_descending');
  assert.equal(applyFiltersMsg.filters.noteType, 'image');
  assert.equal(applyFiltersMsg.filters.publishTime, 'week');
});

test('(ee) 详情阶段数据门槛过滤：未达门槛的笔记被跳过且不计入 notesCollected', async () => {
  const tabs = makeTabs();
  const origSend = tabs.sendMessage;
  let detailCalls = 0;

  tabs.sendMessage = async (id, msg) => {
    if (msg.action === 'getNoteDetail') {
      detailCalls++;
      if (detailCalls === 1) {
        // 第 1 篇：点赞 50（不满足 minLikes: 100）
        return {
          ok: true,
          data: { title: '低赞笔记', content: '测试内容', likes: 50, collects: 10, totalComments: 2 },
        };
      } else {
        // 第 2 篇：点赞 150（满足）
        return {
          ok: true,
          data: { title: '高赞笔记', content: '测试内容', likes: 150, collects: 80, totalComments: 30 },
        };
      }
    }
    if (msg.action === 'getNoteUrls') {
      return { ok: true, data: ['https://www.xiaohongshu.com/explore/note1', 'https://www.xiaohongshu.com/explore/note2'] };
    }
    return origSend(id, msg);
  };

  const { scraper, storage } = makeScraper({ tabs });
  const task = baseTask('task_threshold_filter', {
    config: {
      notesLimit: 2,
      thresholds: { minLikes: 100 },
    },
  });
  await storage.saveTask(task);
  await scraper.run(task);

  const updatedTask = await storage.getTask('task_threshold_filter');
  // 第 1 篇被跳过，第 2 篇通过，因此 notesCollected 应为 1
  assert.equal(updatedTask.progress.notesCollected, 1, '只有达标笔记才计入 notesCollected');
  assert.equal(updatedTask.progress.skippedThresholdCount, 1, '未达标笔记应当增加 skippedThresholdCount');

  // 验证保存的笔记只有高赞笔记
  const allNotes = await storage.getNotesByTaskId('task_threshold_filter');
  assert.equal(allNotes.length, 1);
  assert.equal(allNotes[0].title, '高赞笔记');
});










