const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const data = require(path.join(__dirname, '..', 'src', 'config', 'site-patterns.json'));

test('site-patterns.json 包含 xiaohongshu.com 站点节点', () => {
  assert.ok(data['xiaohongshu.com'], '缺少 xiaohongshu.com 节点');
});

test('xiaohongshu.com 节点包含 meta', () => {
  const node = data['xiaohongshu.com'];
  assert.ok(node.meta, '缺少 meta');
  assert.equal(typeof node.meta.homeUrl, 'string', 'meta.homeUrl 应为字符串');
  assert.ok(node.meta.searchUrlTemplate.includes('{keyword}'), 'meta.searchUrlTemplate 需含 {keyword} 占位符');
});

test('xiaohongshu.com 节点包含 patterns.selectors', () => {
  const selectors = data['xiaohongshu.com'].patterns.selectors;
  assert.ok(selectors, '缺少 patterns.selectors');
  assert.ok(Array.isArray(selectors.search.input), 'selectors.search.input 应为选择器候选数组');
  assert.ok(Array.isArray(selectors.noteDetail.container), 'selectors.noteDetail.container 应为选择器候选数组');
});

test('xiaohongshu.com 节点包含 recipes.searchAndCollect', () => {
  const recipes = data['xiaohongshu.com'].recipes;
  assert.ok(recipes, '缺少 recipes');
  assert.ok(Array.isArray(recipes.searchAndCollect), 'recipes.searchAndCollect 应为动作流数组');
  assert.ok(recipes.searchAndCollect.length > 0, 'recipes.searchAndCollect 不能为空');
});
