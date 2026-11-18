import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPrivacyCheck, scanContentForPrivacy } from '../tools/check-privacy.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('隐私门禁扫描器：放行占位域名与 Retina 资源后缀，拦截真实域名邮箱', () => {
  const safeFixture = `
    const accounts = [
      { email: 'ultra@example.invalid', name: 'Ultra User' },
      { email: 'pro@example.test', name: 'Pro User' },
      { email: 'bot@users.noreply.github.com', name: 'Bot' },
      { icon: 'icon_16x16@2x.png' },
      { desc: '防止无限轮询导致界面卡顿' },
    ];
  `;
  assert.deepEqual(scanContentForPrivacy(safeFixture, 'test/sample.test.mjs'), []);

  const realGmail = ['someone', 'gmail.com'].join('@');
  const realQq = ['123456', 'qq.com'].join('@');
  const unsafeFixture = `
    const first = '${realGmail}';
    const second = '${realQq}';
  `;
  const issues = scanContentForPrivacy(unsafeFixture, 'test/sample.test.mjs');
  assert.equal(issues.length, 2);
  assert.equal(issues[0].code, 'DISALLOWED_EMAIL_DOMAIN');
  assert.equal(issues[1].code, 'DISALLOWED_EMAIL_DOMAIN');
  assert.ok(!issues[0].detail.includes('someone@'), '告警信息不得回显完整邮箱前缀');
});

test('隐私门禁扫描器：支持指纹匹配拦截敏感标识、姓名与引号别名，并豁免词典中正常词条', () => {
  const secretToken = 'syntheticprivatehandle99';
  const secretFullName = 'synthetic private person';
  const secretCjk = '甲乙';
  const secretAlias = '秘密别名';

  const issues = scanContentForPrivacy(
    `
      const handle = '${secretToken}';
      const person = 'Synthetic Private Person';
      // 筛选${secretCjk}测试
      const label = '${secretAlias}';
    `,
    'test/sample.test.mjs',
    {
      tokenHashes: new Set([sha256(secretToken), sha256(secretFullName)]),
      cjkBigramHashes: new Set([sha256(secretCjk)]),
      quotedAliasHashes: new Set([sha256(secretAlias)]),
    }
  );
  assert.deepEqual(
    issues.map(i => i.code),
    ['SENSITIVE_TOKEN_MATCH', 'SENSITIVE_NAME_MATCH', 'SENSITIVE_CJK_NAME_MATCH', 'SENSITIVE_ALIAS_MATCH']
  );

  // dict/ 下允许普通别名翻译词条，不误报
  const dictIssues = scanContentForPrivacy(
    JSON.stringify({ Unlimited: secretAlias }),
    'dict/base.json',
    {
      tokenHashes: new Set(),
      cjkBigramHashes: new Set(),
      quotedAliasHashes: new Set([sha256(secretAlias)]),
    }
  );
  assert.deepEqual(dictIssues, []);
});

test('隐私门禁 --staged 模式：仅检查暂存区快照，不误检未暂存工作区', async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), 'gb-privacy-hook-'));
  try {
    await execFileAsync('git', ['init'], { cwd: tempRepo });
    await mkdir(join(tempRepo, 'test'), { recursive: true });

    const target = join(tempRepo, 'test', 'demo.mjs');
    await writeFile(target, "export const email = 'safe@example.invalid';\n");
    await execFileAsync('git', ['add', 'test/demo.mjs'], { cwd: tempRepo });

    // 未暂存的脏修改不应影响 --staged 校验
    await writeFile(target, `export const email = '${['leak', 'gmail.com'].join('@')}';\n`);
    const cleanStaged = await runPrivacyCheck({ repoRoot: tempRepo, staged: true });
    assert.equal(cleanStaged.issues.length, 0);

    // 暂存真实邮箱后必须被 --staged 拦截
    await execFileAsync('git', ['add', 'test/demo.mjs'], { cwd: tempRepo });
    const blockedStaged = await runPrivacyCheck({ repoRoot: tempRepo, staged: true });
    assert.equal(blockedStaged.issues.length, 1);
    assert.equal(blockedStaged.issues[0].code, 'DISALLOWED_EMAIL_DOMAIN');
  } finally {
    await rm(tempRepo, { recursive: true, force: true }).catch(() => {});
  }
});

test('仓库现状隐私门禁：当前代码库不得存在非白名单邮箱或敏感标识', async () => {
  const result = await runPrivacyCheck({ repoRoot, staged: false });
  assert.ok(result.scannedCount > 50, '应扫描完整仓库文件');
  assert.deepEqual(result.issues, []);
});
