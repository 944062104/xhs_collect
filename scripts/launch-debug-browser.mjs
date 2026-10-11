import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC_PATH = path.resolve('src');
const PROFILE_PATH = path.resolve('.chrome-debug-profile');

async function main() {
  console.log('[debug-runner] 正在启动受控 Chrome 浏览器...');
  console.log('[debug-runner] 扩展目录:', SRC_PATH);
  console.log('[debug-runner] 调试配置目录:', PROFILE_PATH);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    defaultViewport: null,
    args: [
      `--load-extension=${SRC_PATH}`,
      `--disable-extensions-except=${SRC_PATH}`,
      `--user-data-dir=${PROFILE_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://www.xiaohongshu.com',
    ],
  });

  console.log('[debug-runner] Chrome 启动成功！正在探测扩展后台 Service Worker...');

  // 寻找 Service Worker target 获取 extensionId
  let extId = null;
  for (let i = 0; i < 20; i++) {
    const targets = browser.targets();
    for (const t of targets) {
      const u = t.url();
      if (u.startsWith('chrome-extension://') && u.includes('background/service-worker.js')) {
        const match = u.match(/chrome-extension:\/\/([^/]+)/);
        if (match) {
          extId = match[1];
          break;
        }
      }
    }
    if (extId) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (extId) {
    console.log(`[debug-runner] 成功识别到扩展 ID: ${extId}`);
    const popupUrl = `chrome-extension://${extId}/popup/index.html`;
    console.log(`[debug-runner] Popup 管理页面: ${popupUrl}`);

    // 打开一个 tab 直接显示 Popup 界面，方便操作和监控
    const popupPage = await browser.newPage();
    await popupPage.goto(popupUrl);
    popupPage.on('console', (msg) => {
      console.log(`[Popup Console ${msg.type()}]:`, msg.text());
    });
  } else {
    console.log('[debug-runner] 提示：暂未捕获扩展 ID，可直接点击 Chrome 工具栏拼图图标打开小红书采集助手。');
  }

  // 监听所有 targets 的 console
  browser.on('targetcreated', async (target) => {
    const u = target.url();
    if (u.includes('xiaohongshu.com') || u.includes('chrome-extension://')) {
      console.log(`[debug-runner] 新标签页/目标创建: ${u}`);
      try {
        const page = await target.page();
        if (page) {
          page.on('console', (msg) => {
            console.log(`[Page Console (${page.url().slice(0, 40)}...) ${msg.type()}]:`, msg.text());
          });
        }
      } catch (_) {}
    }
  });

  console.log('\n======================================================');
  console.log('✅ 受控浏览器已就绪！');
  console.log('1. 请在弹出的浏览器中确认/登录小红书账号（登录状态会自动持久化保存）');
  console.log('2. 在打开的“小红书采集助手”页面中输入关键词并点击“开始一键采集”');
  console.log('3. 所有的后台报错、控制台日志与执行进度将实时打印在此终端中！');
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error('[debug-runner] 启动失败:', err);
  process.exit(1);
});
