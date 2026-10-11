import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageManager } from '../src/background/storage.js';
import { TaskManager } from '../src/background/task-manager.js';

function makeStorage(name = `xhs-tm-test-${Math.random().toString(36).slice(2)}`) {
  return new StorageManager(name);
}

test('createTask 返回符合规格的 Task 形状并持久化', async () => {
  const tm = new TaskManager(makeStorage());
  const task = await tm.createTask('护肤推荐', { notesLimit: 10, commentsPerNote: 5, outputFormat: 'csv' });

  assert.ok(task.id, '应生成 id');
  assert.equal(task.status, 'pending');
  assert.equal(task.keyword, '护肤推荐');
  assert.deepEqual(task.config, { notesLimit: 10, commentsPerNote: 5, outputFormat: 'csv' });
  assert.deepEqual(task.progress, {
    phase: 'idle',
    notesCollected: 0,
    notesTotal: 0,
    currentNoteIndex: -1,
    commentsCollected: 0,
    scrollCount: 0,
    noteUrls: [],
  });
  assert.ok(typeof task.timestamps.createdAt === 'number', 'createdAt 应为时间戳');
  assert.equal(task.timestamps.startedAt, null);
  assert.equal(task.timestamps.completedAt, null);
  assert.deepEqual(task.errors, []);

  const saved = await tm.getTask(task.id);
  assert.ok(saved, 'createTask 应已持久化任务');
  assert.equal(saved.id, task.id);
});

test('createTask 缺失 config 时使用默认值', async () => {
  const tm = new TaskManager(makeStorage());
  const task = await tm.createTask('美食');
  assert.deepEqual(task.config, { notesLimit: 20, commentsPerNote: 0, outputFormat: 'json' });
});

test('updateStatus pending -> running 设置 startedAt', async () => {
  const tm = new TaskManager(makeStorage());
  const task = await tm.createTask('测试');
  await tm.updateStatus(task, 'running');
  assert.equal(task.status, 'running');
  assert.ok(typeof task.timestamps.startedAt === 'number', 'startedAt 应在 running 时设置');
  assert.equal(task.timestamps.completedAt, null);
  const saved = await tm.getTask(task.id);
  assert.equal(saved.status, 'running');
  assert.ok(typeof saved.timestamps.startedAt === 'number');
});

test('updateStatus running -> completed 设置 completedAt', async () => {
  const tm = new TaskManager(makeStorage());
  const task = await tm.createTask('测试');
  await tm.updateStatus(task, 'running');
  await tm.updateStatus(task, 'completed');
  assert.equal(task.status, 'completed');
  assert.ok(typeof task.timestamps.completedAt === 'number', 'completedAt 应在终态时设置');
  const saved = await tm.getTask(task.id);
  assert.equal(saved.status, 'completed');
  assert.ok(typeof saved.timestamps.completedAt === 'number');
});

test('updateStatus failed -> running 允许重试（不重置 startedAt）', async () => {
  const tm = new TaskManager(makeStorage());
  const task = await tm.createTask('测试');
  await tm.updateStatus(task, 'running');
  const startedAt = task.timestamps.startedAt;
  await tm.updateStatus(task, 'failed');
  assert.equal(task.status, 'failed');
  // 重试
  await tm.updateStatus(task, 'running');
  assert.equal(task.status, 'running');
  assert.equal(task.timestamps.startedAt, startedAt, '重试不应重置 startedAt');
});

test('updateStatus running -> cancelled 合法，cancelled 为终态', async () => {
  const tm = new TaskManager(makeStorage());
  const task = await tm.createTask('测试');
  await tm.updateStatus(task, 'running');
  await tm.updateStatus(task, 'cancelled');
  assert.equal(task.status, 'cancelled');
  assert.ok(typeof task.timestamps.completedAt === 'number', 'cancelled 也应设置 completedAt');
  // 终态不能再转移
  await assert.rejects(() => tm.updateStatus(task, 'running'), /非法状态转移/);
});

test('updateStatus 拒绝非法转移（pending -> completed / running -> pending）', async () => {
  const tm = new TaskManager(makeStorage());
  const t1 = await tm.createTask('a');
  await assert.rejects(() => tm.updateStatus(t1, 'completed'), /非法状态转移/);

  const t2 = await tm.createTask('b');
  await tm.updateStatus(t2, 'running');
  await assert.rejects(() => tm.updateStatus(t2, 'pending'), /非法状态转移/);
});

test('saveProgress 合并进度并持久化', async () => {
  const tm = new TaskManager(makeStorage());
  const task = await tm.createTask('测试');
  await tm.saveProgress(task, { noteUrls: ['u1', 'u2'], notesTotal: 2, phase: 'searching' });
  assert.deepEqual(task.progress.noteUrls, ['u1', 'u2']);
  assert.equal(task.progress.notesTotal, 2);
  assert.equal(task.progress.phase, 'searching');
  // 其余字段保留
  assert.equal(task.progress.currentNoteIndex, -1);

  const saved = await tm.getTask(task.id);
  assert.deepEqual(saved.progress.noteUrls, ['u1', 'u2']);
  assert.equal(saved.progress.phase, 'searching');
});

test('getTask 对不存在的 id 返回 null', async () => {
  const tm = new TaskManager(makeStorage());
  assert.equal(await tm.getTask('no-such-task'), null);
});
