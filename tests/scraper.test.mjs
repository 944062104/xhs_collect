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
