import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { allowedTarget, parseListeners, verifyPageService } from '../dist/discovery.js';
import { assertLoopback } from '../dist/cdp.js';
import { Controller } from '../dist/controller.js';

test('仅本机且无凭据的调试接口、同一个监听进程', () => {
  assertLoopback('ws://127.0.0.1:1234/devtools/browser/id');
  assert.throws(() => assertLoopback('ws://localhost:1234/'));
  assert.throws(() => assertLoopback('ws://127.0.0.1.example.com:1234/'));
  assert.throws(() => assertLoopback('ws://user:password@127.0.0.1:1234/'));
  assert.deepEqual(parseListeners('p100\nf30\nn127.0.0.1:1234\n', 1234), [{ pid: 100, names: ['127.0.0.1:1234'] }]);
  assert.throws(() => parseListeners('p100\nn*:1234', 1234));
});

test('未知网页、OAuth 页面与非应用标签不允许注入', () => {
  assert.equal(allowedTarget({ type: 'page', url: 'https://127.0.0.1:4321/' }), true);
  for (const path of ['/history','/sidecars','/sidecars/123','/customizations','/customizations/installed','/c/00000000-0000-0000-0000-000000000000','/customizations/plugins/gdrive','/customizations/marketplaces/official/plugins/gdocs']) assert.equal(allowedTarget({ type: 'page', url: 'https://127.0.0.1:4321'+path }), true);
  for (const url of ['https://accounts.google.com/', 'https://evil.example/', 'https://127.0.0.1.evil:4321/', 'https://127.0.0.1:4321/login', 'https://127.0.0.1/', 'file:///tmp/index.html']) assert.equal(allowedTarget({ type: 'page', url }), false);
  assert.equal(allowedTarget({ type: 'iframe', url: 'https://127.0.0.1:4321/' }), false);
  for (const path of ['/c/not-a-conversation','/api/stream','/browser','/preview','/oauth/callback']) assert.equal(allowedTarget({ type: 'page', url: 'https://127.0.0.1:4321'+path }), false);
});

test('其他本机服务不能冒充 Antigravity 页面服务', async () => {
  const server = createServer((_req, res) => res.end('test'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    assert.equal(await verifyPageService(`https://127.0.0.1:${port}/`, '/Applications/Antigravity.app'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Controller 重启恢复：sync 清理无法恢复的未就绪会话，configureHud(true) 触发重连', async () => {
  const targetUrl = 'https://127.0.0.1:43210/';
  let detachClosed = false;
  let targetsPayload = [{
    id: 'page-1',
    type: 'page',
    url: targetUrl,
    webSocketDebuggerUrl: 'ws://127.0.0.1:43210/devtools/page/page-1',
  }];
  const server = createServer((req, res) => {
    res.setHeader('Connection', 'close');
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targetsPayload));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const controller = new Controller({
    appPath: '/Applications/Antigravity.app',
    profile: '/nonexistent',
    fixture: { port, origin: 'https://127.0.0.1:43210' },
    geminiDir: '/nonexistent',
    hudEnabled: true,
    onStatus: () => {},
  });

  try {
    controller['browser'] = { close() {} };
    controller['endpoint'] = { port, browserURL: `ws://127.0.0.1:${port}/devtools/browser/1`, pid: 1, appVersion: '2.25.0', legacyPatch: false };
    controller['pages'].set('page-1', {
      targetId: 'page-1',
      url: targetUrl,
      contextId: undefined,
      detaching: false,
      updateChain: Promise.resolve(),
      cdp: {
        send: async (method) => {
          if (method === 'Page.getFrameTree') throw new Error('stale-session');
          return {};
        },
        evaluate: async () => undefined,
        close() { detachClosed = true; },
      },
    });

    await controller.sync();

    assert.equal(detachClosed, true);
    assert.equal(controller['pages'].size, 0);

    targetsPayload = [];
    controller['reconnectionDelay'] = 30000;
    controller['unverifiedWindowRetries'] = 12;
    await controller.configureHud(false);
    assert.equal(controller.snapshot().mode, 'paused');
    await controller.configureHud(true);
    assert.equal(controller['reconnectionDelay'], 2000);
    assert.equal(controller['unverifiedWindowRetries'], 0);
  } finally {
    await controller.stop();
    server.closeAllConnections?.();
    server.close();
  }
});
