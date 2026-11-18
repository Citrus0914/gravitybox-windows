import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('Swift L10n 运行时加载、系统语言解析、扩展语言回退及通知触发', { timeout: process.env.CI ? 180000 : 60000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gb-swift-i18n-'));
  try {
    const driverPath = join(temp, 'L10nDriver.swift');
    const binaryPath = join(temp, 'L10nDriver');
    await writeFile(driverPath, `
import Dispatch
import Foundation

@main
struct L10nDriver {
    static func main() throws {
        let i18nDir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let l10n = L10n.shared
        l10n.reloadPacks(directory: i18nDir)

        precondition(l10n.supportedLocales.map(\\.code).contains("zh-Hans"))
        precondition(l10n.supportedLocales.map(\\.code).contains("en"))

        var notifications = 0
        let token = NotificationCenter.default.addObserver(forName: L10n.didChangeNotification, object: nil, queue: nil) { _ in
            notifications += 1
        }
        defer { NotificationCenter.default.removeObserver(token) }

        let resolvedEn = l10n.setLanguage("en", systemLanguages: ["zh-Hans-CN"])
        precondition(resolvedEn == "en")
        precondition(L10n.t("settings.title") == "Settings")
        precondition(L10n.t("settings.language.subtitle") == "Sets UI language for GravityBox and Antigravity, non-invasively")
        precondition(L10n.t("settings.storage.reclaimable", ["size": "52.1 MB"]) == "Reclaim 52.1 MB")

        let resolvedZh = l10n.setLanguage("system", systemLanguages: ["zh-CN"])
        precondition(resolvedZh == "zh-Hans")
        precondition(L10n.t("settings.title") == "设置")
        precondition(notifications >= 1)

        // 验证多语言扩展与回退链 (ja -> en)
        let extDir = FileManager.default.temporaryDirectory.appendingPathComponent("gb-l10n-ext-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: extDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: extDir) }
        try Data(#"{"meta":{"code":"en","nativeName":"English","fallback":"en","hasTargetDictionary":false},"app":{"greet":"Hi {name}","only.en":"Fallback"}}"#.utf8).write(to: extDir.appendingPathComponent("en.json"))
        try Data(#"{"meta":{"code":"ja","nativeName":"日本語","fallback":"en","hasTargetDictionary":false},"app":{"greet":"こんにちは {name}"}}"#.utf8).write(to: extDir.appendingPathComponent("ja.json"))
        l10n.reloadPacks(directory: extDir)
        precondition(l10n.setLanguage("ja-JP", systemLanguages: ["en-US"]) == "ja")
        precondition(L10n.t("greet", ["name": "GB"]) == "こんにちは GB")
        precondition(L10n.t("only.en") == "Fallback")

        // 验证多线程并发读写 L10n 时的锁安全性 (P0-05)
        l10n.reloadPacks(directory: i18nDir)
        DispatchQueue.concurrentPerform(iterations: 80) { i in
            let target = (i % 2 == 0) ? "en" : "zh-Hans"
            _ = l10n.setLanguage(target, systemLanguages: ["en-US"], notify: false)
            let title = L10n.t("settings.title")
            precondition(title == "Settings" || title == "设置")
            _ = l10n.supportedLocales
            _ = l10n.currentMeta
            _ = l10n.foundationLocale
            _ = l10n.isEnglish
        }

        // 验证 GRAVITYBOX_I18N_DIR 环境变量探测（--install-update 独立事务目录 P1-21）
        let envDir = FileManager.default.temporaryDirectory.appendingPathComponent("gb-l10n-env-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: envDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: envDir) }
        try Data(#"{"meta":{"code":"en","nativeName":"English","fallback":"en","hasTargetDictionary":false},"app":{"env.probe":"Env Loaded"}}"#.utf8).write(to: envDir.appendingPathComponent("en.json"))
        setenv("GRAVITYBOX_I18N_DIR", envDir.path, 1)
        defer { unsetenv("GRAVITYBOX_I18N_DIR") }
        l10n.reloadPacks()
        precondition(l10n.setLanguage("en", systemLanguages: ["zh-Hans"], notify: false) == "en")
        precondition(L10n.t("env.probe") == "Env Loaded")
        print("SWIFT_L10N_OK")
    }
}
`);
    await run('/usr/bin/swiftc', [
      '-parse-as-library',
      '-target', 'arm64-apple-macosx14.0',
      '-framework', 'Foundation',
      join(root, 'native/L10n.swift'),
      driverPath,
      '-o', binaryPath,
    ]);
    const res = await run(binaryPath, [join(root, 'assets/i18n')]);
    assert.match(res.stdout, /SWIFT_L10N_OK/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
