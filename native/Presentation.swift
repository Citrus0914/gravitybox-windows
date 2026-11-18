import Foundation

enum ModelDisplayName {
    private static let standaloneGeminiRegex = try? NSRegularExpression(
        pattern: "^gemini-((?:3\\.[5-9]|[4-9](?:\\.[0-9]+)?))-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$",
        options: [.caseInsensitive]
    )
    private static let catalogNames: [String: String] = {
        var urls: [URL] = []
        if let resource = Bundle.main.resourceURL {
            urls.append(resource.appendingPathComponent("model-catalog.json"))
        }
        if let path = ProcessInfo.processInfo.environment["GRAVITYBOX_UI_RESOURCES"] {
            urls.append(URL(fileURLWithPath: path).appendingPathComponent("model-catalog.json"))
        }
        urls.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("assets/model-catalog.json"))
        for url in urls {
            if let data = try? Data(contentsOf: url),
               let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let names = value["names"] as? [String: String] {
                return names
            }
        }
        return [:]
    }()

    static func name(_ identifier: String) -> String {
        let names = catalogNames
        let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return identifier }
        let value = trimmed.lowercased()
        if let name = names[value] { return name }
        if value.hasPrefix("google/"), let name = names[String(value.dropFirst(7))] { return name }

        // Strip reasoning effort qualifiers in brackets (e.g. "(High)", "(Medium)", "(Low)", "(Extra Low)") while keeping non-effort qualifiers like "(Thinking)"
        let effortSet: Set<String> = ["high", "medium", "low", "extra low", "extra-low"]
        for brackets in [(" (", ")"), ("（", "）"), ("(", ")")] {
            if trimmed.hasSuffix(brackets.1), let openRange = trimmed.range(of: brackets.0, options: .backwards) {
                let baseRaw = String(trimmed[..<openRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                let innerRaw = String(trimmed[openRange.upperBound..<trimmed.index(before: trimmed.endIndex)]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !baseRaw.isEmpty && !innerRaw.isEmpty {
                    let baseDisplay = names[baseRaw.lowercased()] ?? baseRaw
                    if effortSet.contains(innerRaw.lowercased()) {
                        return baseDisplay
                    }
                    return "\(baseDisplay) \(innerRaw)"
                }
            }
        }

        // Strip preview/thinking suffixes from known models, while keeping raw response_model variant suffixes (such as -n, -exp-a, -tiered, -trial, -high, -medium, -low) verbatim
        let suffixTable: [(String, String?)] = [
            ("-extra-low-thinking", "Thinking"),
            ("-high-thinking", "Thinking"),
            ("-medium-thinking", "Thinking"),
            ("-low-thinking", "Thinking"),
            ("-thinking", "Thinking"),
            ("-preview", "Preview")
        ]
        let strippedValue = value.hasPrefix("google/") ? String(value.dropFirst(7)) : value
        for (suffix, label) in suffixTable where strippedValue.hasSuffix(suffix) {
            let baseKey = String(strippedValue.dropLast(suffix.count))
            if let baseName = names[baseKey] {
                if let label = label, !label.isEmpty {
                    return "\(baseName) \(label)"
                }
                return baseName
            }
        }

        // Auto-format clean standalone Gemini 4+ codename models (e.g. gemini-4-carbon, gemini-4-neon)
        if let match = standaloneGeminiRegex?.firstMatch(in: strippedValue, range: NSRange(location: 0, length: (strippedValue as NSString).length)) {
            let ns = strippedValue as NSString
            let ver = ns.substring(with: match.range(at: 1))
            let rawSlug = ns.substring(with: match.range(at: 2))
            let code = rawSlug.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
            return "Gemini \(ver) \(code)"
        }
        return trimmed
    }
}

enum InterfaceText {
    static let shortDateTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "MM-dd HH:mm"
        return formatter
    }()
    static let shortTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    static func formatInteger(_ value: Int) -> String {
        value.formatted(.number.locale(L10n.shared.foundationLocale))
    }

    static func localizedModelLabel(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "未知模型" || trimmed.caseInsensitiveCompare("Unknown Model") == .orderedSame {
            return L10n.t("menu_panel.unknown_model", fallback: L10n.shared.isEnglish ? "Unknown Model" : "未知模型")
        }
        return trimmed
    }

    static func isInternalDualWindowError(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && (trimmed.contains("双周期") || trimmed.localizedCaseInsensitiveContains("dual window"))
    }

    private static let countdownUnitRegex = try! NSRegularExpression(pattern: "([0-9]+)\\s*(天|小时|分钟|分|秒)")
    private static let englishCountdownUnitRegex = try! NSRegularExpression(pattern: "([0-9]+)\\s*(d|h|m|s)\\b", options: [.caseInsensitive])

    static func countdown(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if L10n.shared.isEnglish {
            if trimmed == "即将重置" { return L10n.t("quota.countdown.soon", fallback: "Resetting soon") }
            if trimmed == "已过" || trimmed == "重置时间已过" { return L10n.t("quota.countdown.passed", fallback: "Passed") }
            let source = trimmed as NSString
            let matches = countdownUnitRegex.matches(in: trimmed, range: NSRange(location: 0, length: source.length))
            if !matches.isEmpty {
                var parts: [String] = []
                for m in matches {
                    let num = source.substring(with: m.range(at: 1))
                    let unit = source.substring(with: m.range(at: 2))
                    let enUnit: String
                    switch unit {
                    case "天": enUnit = L10n.t("quota.countdown.unit.day", fallback: "d")
                    case "小时": enUnit = L10n.t("quota.countdown.unit.hour", fallback: "h")
                    case "分钟", "分": enUnit = L10n.t("quota.countdown.unit.min", fallback: "m")
                    case "秒": enUnit = L10n.t("quota.countdown.unit.sec", fallback: "s")
                    default: enUnit = unit
                    }
                    parts.append("\(num)\(enUnit)")
                }
                let duration = parts.joined(separator: " ")
                return trimmed.contains("后重置") ? L10n.t("quota.countdown.resets_in", ["duration": duration], fallback: "Resets in \(duration)") : duration
            }
            return trimmed
        }
        if trimmed.localizedCaseInsensitiveContains("resetting soon") { return L10n.t("quota.countdown.soon", fallback: "即将重置") }
        if trimmed.caseInsensitiveCompare("passed") == .orderedSame || trimmed.localizedCaseInsensitiveContains("time passed") {
            return L10n.t("quota.countdown.passed", fallback: "已过")
        }
        let enSource = trimmed as NSString
        let enMatches = englishCountdownUnitRegex.matches(in: trimmed, range: NSRange(location: 0, length: enSource.length))
        if !enMatches.isEmpty && !trimmed.contains("小时") && !trimmed.contains("分钟") && !trimmed.contains("天") && !trimmed.contains("秒") {
            var parts: [String] = []
            for m in enMatches {
                let num = enSource.substring(with: m.range(at: 1))
                let unit = enSource.substring(with: m.range(at: 2)).lowercased()
                let zhUnit: String
                switch unit {
                case "d": zhUnit = L10n.t("quota.countdown.unit.day", fallback: "天")
                case "h": zhUnit = L10n.t("quota.countdown.unit.hour", fallback: "小时")
                case "m": zhUnit = L10n.t("quota.countdown.unit.min", fallback: "分钟")
                case "s": zhUnit = L10n.t("quota.countdown.unit.sec", fallback: "秒")
                default: zhUnit = unit
                }
                parts.append("\(num) \(zhUnit)")
            }
            let duration = parts.joined(separator: " ")
            return trimmed.localizedCaseInsensitiveContains("reset") ? L10n.t("quota.countdown.resets_in", ["duration": duration], fallback: "\(duration)后重置") : duration
        }
        let pattern = countdownUnitRegex
        let value = NSMutableString(string: raw)
        let source = raw as NSString
        for match in pattern.matches(in: raw, range: NSRange(location: 0, length: source.length)).reversed() {
            let unit = source.substring(with: match.range(at: 2))
            value.replaceCharacters(in: match.range, with: source.substring(with: match.range(at: 1)) + " " + (unit == "分" ? "分钟" : unit))
        }
        return (value as String).replacingOccurrences(of: "(天|小时|分钟|秒)(?=[0-9])", with: "$1 ", options: .regularExpression)
    }

    static func isMultiAccountSummary(_ raw: String) -> Bool {
        raw.contains("详情见账号卡片")
            || raw.contains("部分刷新")
            || raw.contains("个账号")
            || raw.localizedCaseInsensitiveContains("account card")
            || raw.localizedCaseInsensitiveContains("partial refresh")
            || raw.localizedCaseInsensitiveContains("accounts")
    }

    static func quotaMessage(_ raw: String) -> String {
        if raw.contains("3501") { return L10n.t("quota.msg.license_3501", fallback: "许可校验失败 · 3501") }
        if raw.range(of: "HTTP\\s*403", options: .regularExpression) != nil { return L10n.t("quota.msg.http_403", fallback: "配额查询受限 · 403") }
        if raw.range(of: "HTTP\\s*401|invalid_grant", options: .regularExpression) != nil { return L10n.t("quota.msg.http_401", fallback: "登录已失效") }
        if raw.contains("凭据") || raw.localizedCaseInsensitiveContains("credential") { return L10n.t("quota.msg.credential", fallback: "登录凭据待更新") }
        if raw.contains("超时") || raw.localizedCaseInsensitiveContains("timeout") || raw.localizedCaseInsensitiveContains("timed out") { return L10n.t("quota.msg.timeout", fallback: "配额查询超时") }
        if raw.contains("未返回") || raw.contains("未取得") || raw.contains("沿用") || raw.localizedCaseInsensitiveContains("not returned") || raw.localizedCaseInsensitiveContains("stale") || raw.localizedCaseInsensitiveContains("cached") {
            return L10n.t("quota.msg.not_updated", fallback: "配额未更新")
        }
        if isMultiAccountSummary(raw) { return L10n.t("quota.msg.partial_accounts", fallback: "部分账号配额未更新") }
        return raw.isEmpty ? "" : L10n.t("quota.msg.refresh_failed", fallback: "配额刷新失败")
    }

    static func usageScope(scanned: Int, discovered: Int, failed: Int, skipped: Int, unknown: Int) -> String {
        var parts = [
            discovered > scanned
                ? L10n.t("usage.scope.dbs_fraction", ["scanned": scanned, "discovered": discovered], fallback: "\(scanned)/\(discovered) 个会话数据库")
                : L10n.t("usage.scope.dbs_count", ["scanned": scanned], fallback: "\(scanned) 个会话数据库")
        ]
        if failed > 0 { parts.append(L10n.t("usage.scope.failed_dbs", ["count": failed], fallback: "\(failed) 个读取失败")) }
        if skipped > 0 { parts.append(L10n.t("usage.scope.skipped_records", ["count": skipped], fallback: "\(skipped) 条未读取")) }
        if unknown > 0 { parts.append(L10n.t("usage.scope.unknown_time", ["count": unknown], fallback: "\(unknown) 条时间未知")) }
        return parts.joined(separator: " · ")
    }

    static func formatCompactTokens(_ count: Int, formatSmallWithLocale: Bool = false) -> String {
        let value = max(0, count)
        guard value >= 1_000 else { return formatSmallWithLocale ? formatInteger(value) : "\(value)" }
        let scale = pow(10.0, floor(log10(Double(value))) - 2)
        let rounded = (Double(value) / scale).rounded() * scale
        let divisor = rounded >= 1e9 ? 1e9 : rounded >= 1e6 ? 1e6 : 1e3
        let unit = divisor == 1e9 ? "B" : divisor == 1e6 ? "M" : "K"
        let scaled = rounded / divisor
        let decimals = max(0, 2 - Int(floor(log10(scaled))))
        var number = String(format: "%.*f", locale: Locale(identifier: "en_US_POSIX"), decimals, scaled)
        if number.contains(".") {
            while number.hasSuffix("0") { number.removeLast() }
            if number.hasSuffix(".") { number.removeLast() }
        }
        return number + unit
    }

    private static let standardUsdFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return formatter
    }()

    static func formatUsd(_ value: Double) -> String {
        if !value.isFinite || value <= 0 { return "$0.00" }
        if value < 0.001 { return "<$0.001" }
        if value < 0.01 { return String(format: "$%.3f", locale: Locale(identifier: "en_US_POSIX"), value) }
        if value >= 1000, let grouped = standardUsdFormatter.string(from: NSNumber(value: value)) {
            return "$" + grouped
        }
        return String(format: "$%.2f", locale: Locale(identifier: "en_US_POSIX"), value)
    }
}
