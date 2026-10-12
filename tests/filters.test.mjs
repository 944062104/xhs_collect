import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublishedDate, isNoteMatchingThresholds } from '../src/background/filters.js';

test('parsePublishedDate: 处理各种小红书日期格式', () => {
  const refTime = new Date('2026-10-12T12:00:00Z').getTime();

  // 空值与非法值
  assert.equal(parsePublishedDate('', refTime), null);
  assert.equal(parsePublishedDate(null, refTime), null);

  // 相对时间：刚刚、X分钟前、X小时前、X天前
  const justNow = parsePublishedDate('刚刚', refTime);
  assert.equal(justNow, refTime);

  const tenMinsAgo = parsePublishedDate('10分钟前', refTime);
  assert.equal(tenMinsAgo, refTime - 10 * 60 * 1000);

  const twoHoursAgo = parsePublishedDate('2小时前', refTime);
  assert.equal(twoHoursAgo, refTime - 2 * 60 * 60 * 1000);

  const threeDaysAgo = parsePublishedDate('3天前', refTime);
  assert.equal(threeDaysAgo, refTime - 3 * 24 * 60 * 60 * 1000);

  // 包含前缀：“编辑于 3天前”、“发布于 昨天”
  assert.equal(parsePublishedDate('发布于 刚刚', refTime), refTime);
  assert.ok(parsePublishedDate('昨天 14:00', refTime) > 0);

  // 绝对日期：月-日 (03-12)
  const monthDay = parsePublishedDate('03-12', refTime);
  assert.ok(typeof monthDay === 'number' && monthDay > 0);

  // 绝对日期：年-月-日 (2025-05-20)
  const fullDate = parsePublishedDate('2025-05-20', refTime);
  assert.equal(new Date(fullDate).getFullYear(), 2025);
  assert.equal(new Date(fullDate).getMonth(), 4);
});

test('isNoteMatchingThresholds: 无阈值或空阈值时全部放行', () => {
  const note = { likes: 50, collects: 10, totalComments: 5 };
  assert.deepEqual(isNoteMatchingThresholds(note), { pass: true });
  assert.deepEqual(isNoteMatchingThresholds(note, {}), { pass: true });
});

test('isNoteMatchingThresholds: 校验点赞数、收藏数、评论数阈值', () => {
  const note = {
    likes: 150,
    collects: 40,
    totalComments: 12,
  };

  // 通过
  assert.equal(
    isNoteMatchingThresholds(note, { minLikes: 100, minCollects: 30, minComments: 10 }).pass,
    true
  );

  // 点赞未达标
  const likeFail = isNoteMatchingThresholds(note, { minLikes: 200 });
  assert.equal(likeFail.pass, false);
  assert.match(likeFail.reason, /点赞/);

  // 收藏未达标
  const collectFail = isNoteMatchingThresholds(note, { minCollects: 50 });
  assert.equal(collectFail.pass, false);
  assert.match(collectFail.reason, /收藏/);

  // 评论未达标
  const commentFail = isNoteMatchingThresholds(note, { minComments: 20 });
  assert.equal(commentFail.pass, false);
  assert.match(commentFail.reason, /评论/);
});

test('isNoteMatchingThresholds: 支持中文单位“万”解析（如 1.2万）', () => {
  const note = {
    likes: '1.2万',
    collects: '500',
    totalComments: '3000',
  };
  assert.equal(
    isNoteMatchingThresholds(note, { minLikes: 10000, minCollects: 200, minComments: 1000 }).pass,
    true
  );
});

test('isNoteMatchingThresholds: 校验发布日期门槛 minDate', () => {
  const refTime = new Date('2026-10-12T12:00:00Z').getTime();
  const noteRecent = {
    likes: 100,
    publishedAt: '2天前',
  };
  const noteOld = {
    likes: 100,
    publishedAt: '2024-01-01',
  };

  const minDate = new Date('2026-10-01T00:00:00Z').getTime();

  // 最近 2 天的笔记满足 2026-10-01 之后
  assert.equal(
    isNoteMatchingThresholds(noteRecent, { minDate }, refTime).pass,
    true
  );

  // 2024-01-01 的笔记不满足
  const oldRes = isNoteMatchingThresholds(noteOld, { minDate }, refTime);
  assert.equal(oldRes.pass, false);
  assert.match(oldRes.reason, /发布时间/);
});
