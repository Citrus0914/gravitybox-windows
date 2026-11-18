import Cocoa

@main struct QuotaContractFixture {
    static var assertionCount = 0
    static func check(_ value: Bool, _ message: String) {
        assertionCount += 1
        if !value { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
    }
    static func main() {
        L10n.shared.setLanguage("zh-Hans", notify: false)
        let unknown: [String: Any] = ["availability":"unknown", "quotaState":"not_reported"]
        let weekly: [String: Any] = ["remaining":0.73, "known":true, "stale":false, "resetCountdown":"6天后重置"]
        let raw: [String: Any] = ["familyWindows":["gemini":["weekly":weekly]], "argonStatus":unknown,
            "geminiFiveHourRemaining":100, "argonWeeklyRemaining":100]
        let contract = QuotaPresentation.contract(raw)
        check(contract.gemini5h == nil, "New contract must override legacy fabricated 5h")
        check(contract.geminiWeekly?.percentage == 73, "Fraction conversion")
        let modelRaw: [String: Any] = ["familyWindows":["gemini":["weekly":weekly]],
            "familyModelQuota":["gemini":["remaining":1,"known":true,"stale":false,"resetCountdown":"4小时59分后重置"],
                                "claude":["remaining":1,"known":true,"stale":false,"resetCountdown":"6天23小时后重置"]]]
        let modelContract = QuotaPresentation.contract(modelRaw)
        check(modelContract.gemini5h == nil && modelContract.claude5h == nil, "Model quota must not fabricate a 5h window")
        check(modelContract.geminiPrimary.window?.percentage == 100 && modelContract.geminiPrimary.label == "模型配额", "Known model quota must remain visible")
        check(modelContract.claudePrimary.window?.resetText == "6天23小时后重置", "Weekly-length model reset must stay intact")
        check(QuotaPresentation.menuQuotaText(modelRaw).contains("模型配额 100%"), "Menu must display model value without fake period")
        check(QuotaPresentation.menuAccountSummary(modelRaw).contains("Claude/GPT 模型配额 100%"), "Account menu shares fallback semantics")
        check(QuotaPresentation.contract(["quota":modelRaw]).geminiPrimary.window?.percentage == 100, "Nested IPC shares model quota")
        var explicitRaw = modelRaw
        explicitRaw["familyWindows"] = ["gemini":["fiveHour":["remaining":0.4,"known":true,"stale":false]]]
        let explicit = QuotaPresentation.contract(explicitRaw)
        check(explicit.geminiPrimary.window?.percentage == 40 && explicit.geminiPrimary.label == "5 小时", "Explicit fresh period wins")
        var zeroRaw = modelRaw; zeroRaw["familyModelQuota"] = ["gemini":["remaining":0,"known":true,"stale":false]]
        check(QuotaPresentation.contract(zeroRaw).geminiPrimary.window?.percentage == 0, "Model zero is exhausted, never unknown")
        check(QuotaPresentation.fingerprint(modelRaw) != QuotaPresentation.fingerprint(zeroRaw), "Model-only updates repaint cards")
        check(contract.argon?.percentage == nil && contract.argon?.title == "Gemini 4 Argon", "No invented Argon week/value")
        check(contract.argon?.resetText == "配额未知", "Missing metadata cannot deny permission")
        check(QuotaPresentation.menuQuotaText(raw).contains("5 小时 未知 · 每周 73%"), "Menu shares contract")
        let nested = QuotaPresentation.contract(["quota":raw])
        check(nested.argon?.placeholder == contract.argon?.placeholder, "Nested IPC shares contract")
        let known = QuotaPresentation.contract(["argonStatus":["availability":"available", "quotaState":"known", "remaining":0.42, "period":"unspecified"]])
        check(known.argon?.percentage == 42 && known.argon?.title == "Gemini 4 Argon" && known.argon?.periodLabel == "模型配额" && known.argon?.resetText == "", "Own quota must not claim weekly or 周期未知")
        let disabled = QuotaPresentation.contract(["argonStatus":["availability":"disabled", "quotaState":"not_reported"]])
        check(disabled.argon?.percentage == nil && disabled.argon?.placeholder == "不可用" && disabled.argon?.resetText == "", "Disabled is not zero and shows 不可用")
        let stale = QuotaPresentation.contract(["familyWindows":["gemini":["weekly":["remaining":0.6,"known":true,"stale":true]]],
            "argonStatus":["availability":"unknown", "quotaState":"stale", "remaining":0.3,"period":"weekly"]])
        check(stale.geminiWeekly?.percentage == 60 && stale.geminiWeekly?.resetText.contains("数据已过期") == true, "Carried values labelled")
        check(stale.argon?.percentage == 30 && stale.argon?.resetText.contains("数据已过期") == true, "Carried Argon labelled")
        check(QuotaPresentation.menuQuotaText(["familyWindows":["gemini":["weekly":["remaining":0.6,"known":true,"stale":true]]]]).contains("数据已过期"), "Menu labels stale")
        let invalid = QuotaPresentation.contract(["argonStatus":["quotaState":"known","remaining":12]])
        check(invalid.argon?.percentage == nil, "Invalid fraction cannot produce 100%")
        let legacy = QuotaPresentation.contract(["geminiFiveHourRemaining":73,"geminiWeeklyRemaining":73,"geminiFiveHourResetCountdown":"以周限额为准"])
        check(legacy.gemini5h?.percentage == nil && legacy.geminiWeekly?.percentage == 73, "Legacy copied value not revived")
        check(QuotaPresentation.fingerprint(raw) != QuotaPresentation.fingerprint(["argonStatus":["availability":"available"]]), "Contract changes repaint cards")
        let warning = QuotaPresentation.contract(["quotaWarnings":["UNVERIFIED_CLOUD_SCOPE: HTTP 403", "OTHER: Other information"]])
        check(QuotaPresentation.warningSummary(warning, excluding:["HTTP 403"]) == "Other information", "Refresh error not repeated; independent warnings retained")
        let same = QuotaPresentation.contract(["quotaWarnings":["UNVERIFIED_CLOUD_SCOPE: HTTP 403"], "refreshState":["complete":false]])
        check(QuotaPresentation.warningSummary(same, excluding:["HTTP 403"]).isEmpty, "Single failure renders only once")
        check(ModelDisplayName.name("gemini-3.8-flash-n") == "gemini-3.8-flash-n", "Response model with -n suffix stays exact")
        check(ModelDisplayName.name("claude-opus-5-5-high") == "claude-opus-5-5-high", "Raw response model with -high suffix is preserved verbatim")
        check(ModelDisplayName.name("gemini-4-argon-trial") == "gemini-4-argon-trial", "Response model with trial variant stays exact raw slug")
        check(ModelDisplayName.name("gemini-4-carbon") == "Gemini 4 Carbon", "Format Gemini 4 Carbon")
        check(ModelDisplayName.name("gemini-4-neon") == "Gemini 4 Neon", "Auto-format future Gemini 4+ codename models")
        check(ModelDisplayName.name("gemini-3.8-flash-exp-a") == "gemini-3.8-flash-exp-a", "Response model with -exp-a suffix stays exact")
        check(ModelDisplayName.name("Gemini 3.8 Flash (High)") == "Gemini 3.8 Flash", "Bracketed reasoning effort is stripped")
        check(ModelDisplayName.name("Claude Sonnet 4.6 (Thinking)") == "Claude Sonnet 4.6 Thinking", "Database thinking suffix preserved")
        let proNoCarbon = QuotaPresentation.contract(["subscription_tier":"PRO", "argonStatus":["availability":"disabled", "quotaState":"not_reported"]])
        check(proNoCarbon.carbon == nil && proNoCarbon.standaloneGroups.isEmpty, "Missing Carbon evidence must not synthesize a fake carbon row")
        let ultraWithNewModel = QuotaPresentation.contract([
            "subscription_tier":"ULTRA",
            "carbonStatus":["availability":"available", "quotaState":"known", "remaining":0.85, "period":"weekly", "modelName":"gemini-4-carbon"],
            "standaloneModels":[
                ["key":"argon", "modelName":"gemini-4-argon", "availability":"available", "quotaState":"known", "remaining":0.5, "period":"weekly"],
                ["key":"carbon", "modelName":"gemini-4-carbon", "availability":"available", "quotaState":"known", "remaining":0.85, "period":"weekly"],
                ["key":"gemini-4-neon", "modelName":"gemini-4-neon", "availability":"available", "quotaState":"known", "remaining":0.92, "period":"weekly"]
            ]
        ])
        check(ultraWithNewModel.carbon?.percentage == 85 && ultraWithNewModel.carbon?.title == "Gemini 4 Carbon · 每周", "Ultra Carbon quota parsed")
        check(ultraWithNewModel.extraStandaloneModels.count == 1 && ultraWithNewModel.extraStandaloneModels.first?.title == "Gemini 4 Neon · 每周" && ultraWithNewModel.extraStandaloneModels.first?.percentage == 92, "Auto-detected standalone model parsed")
        check(InterfaceText.quotaMessage("HTTP 403 (#3501)") == "许可校验失败 · 3501", "Concise service state")
        check(InterfaceText.isMultiAccountSummary("已读取 1 个账号；2 个刷新失败。详情见账号卡片。"), "Detects multi-account summary message")
        check(InterfaceText.quotaMessage("已读取 1 个账号；2 个刷新失败。详情见账号卡片。") == "部分账号配额未更新", "Multi-account partial error must not misreport current account failure")
        // Replaces JS copies of retired UI algorithms with production Swift contracts.
        let dual = QuotaPresentation.contract(["familyWindows":["gemini":[
            "fiveHour":["remaining":1.0,"known":true,"stale":false],
            "weekly":["remaining":0.11,"known":true,"stale":false]
        ]]])
        check(dual.geminiPrimary.window?.percentage == 100 && dual.geminiWeekly?.percentage == 11, "5h and weekly quota retain their distinct values")
        let depleted = QuotaPresentation.contract(["familyWindows":["claude":[
            "fiveHour":["remaining":0.8,"known":true,"stale":false],
            "weekly":["remaining":0.0,"known":true,"stale":false]
        ]]])
        check(depleted.claude5h?.percentage == 80 && depleted.claudeWeekly?.percentage == 0, "Weekly exhaustion must remain visible without relabeling the 5h value")
        for (value, expected) in [(0.0,"$0.00"),(0.000001,"<$0.001"),(0.002,"$0.002"),(0.12,"$0.12")] {
            check(InterfaceText.formatUsd(value) == expected, "Production currency formatting for \(value)")
        }
        let partialScope = InterfaceText.usageScope(scanned: 2, discovered: 3, failed: 1, skipped: 4, unknown: 5)
        check(partialScope.contains("2/3") && partialScope.contains("1 个读取失败") && partialScope.contains("4 条未读取") && partialScope.contains("5 条时间未知"), "Incomplete reads disclose each failure category")
        let completeScope = InterfaceText.usageScope(scanned: 3, discovered: 3, failed: 0, skipped: 0, unknown: 0)
        check(!completeScope.contains("读取失败") && !completeScope.contains("未读取") && !completeScope.contains("时间未知"), "Complete reads do not manufacture warnings")

        // English quota contracts, countdowns, integer locale formatting & weekly-only sentinel (P1-24 / P1-25 / P1-29)
        L10n.shared.setLanguage("en", notify: false)
        check(InterfaceText.countdown("4小时13分钟后重置") == "Resets in 4h 13m", "English countdown formatting")
        check(InterfaceText.countdown("即将重置") == "Resetting soon", "English imminent countdown")
        check(InterfaceText.countdown("已过") == "Passed", "English passed countdown")
        check(InterfaceText.formatInteger(12345) == "12,345", "English integer locale formatting must match en_US")
        for (value, expected) in [(0.0,"$0.00"),(0.000001,"<$0.001"),(0.002,"$0.002"),(0.12,"$0.12")] {
            check(InterfaceText.formatUsd(value) == expected, "English currency formatting for \(value)")
        }
        let enDisabled = QuotaPresentation.contract(["argonStatus":["availability":"disabled", "quotaState":"not_reported"]])
        check(enDisabled.argon?.placeholder == "Unavailable", "English disabled placeholder must show Unavailable")
        let enUnknown = QuotaPresentation.contract(["argonStatus":["availability":"unknown", "quotaState":"not_reported"]])
        check(enUnknown.argon?.resetText == "Unknown", "English unknown reset text must show Unknown")
        let enWeeklyOnly = QuotaPresentation.contract([
            "geminiFiveHourRemaining": 73,
            "geminiWeeklyRemaining": 73,
            "geminiFiveHourPeriodMode": "weekly_only",
            "geminiFiveHourResetCountdown": "Resets by weekly limit"
        ])
        check(enWeeklyOnly.gemini5h?.percentage == nil && enWeeklyOnly.geminiWeekly?.percentage == 73, "English weekly-only sentinel suppresses fabricated 5h quota")
        let hanRegex = "[\\u4E00-\\u9FFF]"
        let enPartialScope = InterfaceText.usageScope(scanned: 2, discovered: 3, failed: 1, skipped: 4, unknown: 5)
        check(enPartialScope.contains("2/3") && enPartialScope.range(of: hanRegex, options: .regularExpression) == nil, "English usageScope must contain no CJK leakage: \(enPartialScope)")
        check(InterfaceText.quotaMessage("HTTP 403 (#3501)").range(of: hanRegex, options: .regularExpression) == nil, "English quotaMessage must contain no CJK leakage")
        L10n.shared.setLanguage("zh-Hans", notify: false)
        check(InterfaceText.countdown("Resets in 6d 12h") == "6 天 12 小时后重置", "Chinese localized countdown must use L10n countdown keys")

        // Dynamic quotaGroups across Ultra, Pro, Free tiers
        let ultraGroupsContract = QuotaPresentation.contract([
            "subscription_tier": "ULTRA",
            "quotaGroups": [
                [
                    "key": "gemini",
                    "displayName": "Gemini",
                    "summaryLabel": "Gemini",
                    "brands": ["gemini"],
                    "isStandalone": false,
                    "availability": "available",
                    "quotaState": "known",
                    "windows": [
                        ["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.64, "stale": false, "resetCountdown": "4小时后重置"],
                        ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.64, "stale": false, "resetCountdown": "6天后重置"]
                    ]
                ],
                [
                    "key": "claude_gpt",
                    "displayName": "Claude/GPT",
                    "summaryLabel": "Claude/GPT",
                    "brands": ["claude", "gpt"],
                    "isStandalone": false,
                    "availability": "available",
                    "quotaState": "known",
                    "windows": [
                        ["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 1.0, "stale": false, "resetCountdown": "5小时后重置"],
                        ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 1.0, "stale": false, "resetCountdown": "7天后重置"]
                    ]
                ]
            ]
        ])
        check(ultraGroupsContract.displayGroups.count == 2 && ultraGroupsContract.standaloneGroups.isEmpty, "Ultra quotaGroups must render only Gemini and Claude/GPT without Argon/Carbon")
        check(ultraGroupsContract.gemini5h?.percentage == 64 && ultraGroupsContract.claude5h?.percentage == 100, "quotaGroups backfills core windows")
        let ultraSummary = QuotaPresentation.menuAccountSummary([
            "subscription_tier": "ULTRA",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.64, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 1.0, "stale": false]]]
            ]
        ])
        check(ultraSummary.contains("Gemini") && ultraSummary.contains("Claude/GPT") && !ultraSummary.contains("Argon") && !ultraSummary.contains("Carbon"), "Ultra summary must omit Argon and Carbon")

        let legacyUnifiedUltra = QuotaPresentation.contract([
            "subscription_tier": "ULTRA",
            "familyWindows": [
                "gemini": ["fiveHour": ["remaining": 0.64, "known": true], "weekly": ["remaining": 0.64, "known": true]],
                "claude": ["fiveHour": ["remaining": 1.0, "known": true], "weekly": ["remaining": 1.0, "known": true]]
            ],
            "argonStatus": ["availability": "available", "quotaState": "known", "mode": "unified", "pooledInFamily": "gemini", "remaining": 0.64],
            "carbonStatus": ["availability": "available", "quotaState": "known", "mode": "unified", "pooledInFamily": "gemini", "remaining": 0.64]
        ])
        check(legacyUnifiedUltra.displayGroups.count == 2 && legacyUnifiedUltra.standaloneGroups.isEmpty, "Unified Argon/Carbon in legacy payload must not create standalone rows")

        let proGroupsContract = QuotaPresentation.contract([
            "subscription_tier": "PRO",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.53, "stale": false], ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.53, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.76, "stale": false], ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.76, "stale": false]]],
                ["key": "argon", "displayName": "Gemini 4 Argon", "summaryLabel": "Argon", "brands": ["gemini"], "isStandalone": true, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.64, "stale": false, "resetCountdown": "6天后重置"]]]
            ]
        ])
        check(proGroupsContract.standaloneGroups.count == 1 && proGroupsContract.standaloneGroups[0].barTitle(for: proGroupsContract.standaloneGroups[0].windows[0]) == "Gemini 4 Argon · 每周" && proGroupsContract.standaloneGroups[0].primaryPercentage == 64, "Pro independent Argon shows real weekly period and 64%")

        let freeDisabledContract = QuotaPresentation.contract([
            "subscription_tier": "FREE",
            "familyWindows": [
                "gemini": ["model_quota": ["remaining": 1.0, "known": true]],
                "claude": ["model_quota": ["remaining": 1.0, "known": true]]
            ],
            "argonStatus": ["availability": "disabled", "quotaState": "not_reported"]
        ])
        check(freeDisabledContract.standaloneGroups.isEmpty, "Free tier disabled Argon must not appear as a standalone group")

        check(QuotaPresentation.localizedWindowLabel(period: "unspecified", label: "周期未知") == "模型配额", "Chinese unspecified window never displays 周期未知")
        L10n.shared.setLanguage("en", notify: false)
        check(QuotaPresentation.localizedWindowLabel(period: "unspecified", label: "") == "Model Quota", "English unspecified window displays Model Quota")
        L10n.shared.setLanguage("zh-Hans", notify: false)

        let fpA = QuotaPresentation.fingerprint(["subscription_tier": "PRO", "quotaGroups": [["key": "gemini"], ["key": "argon"]]])
        let fpB = QuotaPresentation.fingerprint(["subscription_tier": "ULTRA", "quotaGroups": [["key": "gemini"]]])
        check(fpA != fpB && fpA.contains("argon"), "Fingerprint reflects quotaGroups and subscription_tier changes")
        check(QuotaPresentation.inferredBrands(for: "Orchestrator (Argon)") == ["gemini"], "Orchestrator group infers gemini brand icon")
        let slugBrandPro = QuotaPresentation.contract([
            "subscription_tier": "PRO",
            "quotaGroups": [
                ["key": "argon", "displayName": "Gemini 4 Argon", "summaryLabel": "Argon", "brands": ["argon"], "isStandalone": true, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.64, "stale": false]]],
                ["key": "gemini-4-xenon", "displayName": "Gemini 4 Xenon", "summaryLabel": "Gemini 4 Xenon", "brands": ["gemini-4-xenon"], "isStandalone": true, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.9, "stale": false]]]
            ]
        ])
        check(slugBrandPro.standaloneGroups.count == 2 && slugBrandPro.standaloneGroups[0].brands == ["gemini"] && slugBrandPro.standaloneGroups[1].brands == ["gemini"], "Non-canonical standalone brand slugs normalize to canonical icon brands")
        check(QuotaPresentation.monitoredModelDisplayName("argon", accounts: []) == "Gemini 4 Argon", "Monitored model display name resolves argon")

        // Per-tier adaptive monitored scope choices, fallback mapping, and disambiguation subtitles
        let ultraAccPayload: [String: Any] = [
            "subscription_tier": "ULTRA",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.64, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 1.0, "stale": false]]]
            ]
        ]
        let proAccPayload: [String: Any] = [
            "subscription_tier": "PRO",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.53, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.76, "stale": false]]],
                ["key": "argon", "displayName": "Gemini 4 Argon", "summaryLabel": "Argon", "brands": ["gemini"], "isStandalone": true, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.64, "stale": false]]]
            ]
        ]
        let freeAccPayload: [String: Any] = [
            "subscription_tier": "FREE",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 1.0, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 1.0, "stale": false]]]
            ]
        ]

        let proChoices = QuotaPresentation.monitoredScopeChoices(for: proAccPayload)
        check(proChoices.filter { !$0.isSeparator }.map(\.title) == ["全部主力模型", "Gemini 全系（含 Argon）", "Gemini（基础池）", "Claude/GPT", "Gemini 4 Argon"], "Pro monitored choices show combined + base + argon labels")
        check(proChoices.contains(where: { $0.isSeparator }), "Pro monitored choices include separator")
        check(QuotaPresentation.effectiveMonitoredModelKey("argon", activeAccount: proAccPayload) == "argon", "Pro preserves argon selection")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "all", activeAccount: proAccPayload).contains("不受 Argon 独立周限额影响"), "Pro all subtitle clarifies Argon exclusion")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "gemini_all", activeAccount: proAccPayload).contains("同时盯住基础 Gemini 与独立 Argon"), "Pro gemini_all subtitle clarifies combined tracking")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "gemini", activeAccount: proAccPayload).contains("不含独立计费的 Argon"), "Pro base gemini subtitle clarifies Argon exclusion")
        check(QuotaPresentation.monitoredModelDisplayName("gemini", activeAccount: proAccPayload) == "Gemini（基础池）", "Pro display name clarifies base Gemini pool")

        let ultraChoices = QuotaPresentation.monitoredScopeChoices(for: ultraAccPayload)
        check(ultraChoices.filter { !$0.isSeparator }.map(\.title) == ["全部可用模型", "Gemini", "Claude/GPT"], "Ultra monitored choices omit Argon and redundant Gemini All")
        check(QuotaPresentation.effectiveMonitoredModelKey("argon", activeAccount: ultraAccPayload) == "gemini", "Ultra remaps argon to shared gemini pool")
        check(QuotaPresentation.effectiveMonitoredModelKey("gemini_all", activeAccount: ultraAccPayload) == "gemini", "Ultra remaps gemini_all to shared gemini pool")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "gemini", activeAccount: ultraAccPayload).contains("Argon 与 Carbon 并入此共享池"), "Ultra gemini subtitle explains pooled Argon/Carbon")
        check(QuotaPresentation.monitoredModelDisplayName("argon", activeAccount: ultraAccPayload) == "Gemini", "Ultra display name resolves argon to Gemini")

        let freeChoices = QuotaPresentation.monitoredScopeChoices(for: freeAccPayload)
        check(freeChoices.filter { !$0.isSeparator }.map(\.title) == ["全部可用模型", "Gemini", "Claude/GPT"], "Free monitored choices expose only available core pools")
        check(QuotaPresentation.effectiveMonitoredModelKey("argon", activeAccount: freeAccPayload) == "gemini", "Free remaps disabled argon to base gemini")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "all", activeAccount: freeAccPayload).contains("免费账号"), "Free all subtitle clarifies free account pools")

        print("\(assertionCount) native quota assertions passed")
    }
}
