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

test('patterns.selectors 下所有选择器均为非空字符串数组', () => {
  const selectors = data['xiaohongshu.com'].patterns.selectors;
  const walk = (obj) => {
    for (const [key, val] of Object.entries(obj)) {
      if (Array.isArray(val)) {
        assert.ok(val.length > 0, `选择器 ${key} 不能为空数组`);
        for (const item of val) {
          assert.equal(typeof item, 'string', `选择器 ${key} 的候选必须是字符串`);
        }
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  };
  walk(selectors);
});

test('recipes 含两条核心动作流 (searchAndCollect + collectNoteDetail)', () => {
  const recipes = data['xiaohongshu.com'].recipes;
  assert.ok(Array.isArray(recipes.searchAndCollect) && recipes.searchAndCollect.length > 0, '缺少 searchAndCollect');
  assert.ok(Array.isArray(recipes.collectNoteDetail) && recipes.collectNoteDetail.length > 0, '缺少 collectNoteDetail');
});

test('recipes 中 selectorKey 必须能解析到 patterns.selectors 中的候选列表', () => {
  const node = data['xiaohongshu.com'];
  const recipes = node.recipes;
  const selectors = node.patterns.selectors;

  const resolve = (dottedPath) => {
    return dottedPath.split('.').reduce((acc, key) => {
      if (acc == null || typeof acc !== 'object') return undefined;
      return acc[key];
    }, selectors);
  };

  const knownExtractors = new Set(['llm.extractNoteList', 'llm.extractNoteDetail', 'llm.extractComments']);
  let checked = 0;
  for (const [recipeName, steps] of Object.entries(recipes)) {
    for (const step of steps) {
      if (step.selectorKey) {
        const resolved = resolve(step.selectorKey);
        assert.ok(Array.isArray(resolved) && resolved.length > 0,
          `recipe ${recipeName} 的 selectorKey "${step.selectorKey}" 在 patterns.selectors 中无法解析为非空候选列表`);
        checked += 1;
      }
      if (step.extractor) {
        assert.ok(typeof step.extractor === 'string' && step.extractor.length > 0,
          `recipe ${recipeName} 的 extractor 必须为非空字符串`);
        assert.ok(knownExtractors.has(step.extractor),
          `recipe ${recipeName} 的 extractor "${step.extractor}" 不在已知提取器集合内`);
      }
    }
  }
  assert.ok(checked > 0, '未检测到任何 selectorKey 引用，测试无效');
});
