import Cocoa

final class PricingSyncSheetController: NSObject, NSWindowDelegate {
    private unowned let app: Assistant
    let sheet = SheetWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 492), styleMask: [.titled], backing: .buffered, defer: false)
    private let statusIconBox = NSBox()
    private let statusIconView = NSImageView()
    private let titleLabel = text(L10n.t("pricing_sheet.title"), size: 16, weight: .semibold, color: .labelColor)
    let subtitleLabel = text("", size: 11, color: Design.secondary, wrap: true)
    let summaryPill = pillBadge("", color: Design.blue)
    let historicalNoteLabel = text(L10n.t("pricing_sheet.note"), size: 11, color: Design.secondary, wrap: true)
    private let listStack = NSStackView()
    private let listScroll = NSScrollView()
    let recheckBtn = InlineRefreshButton(L10n.t("pricing_sheet.recheck"), width: 96, target: nil, action: #selector(recheck))
    let closeBtn = button(L10n.t("pricing_sheet.done"), target: nil, action: #selector(closeSheet))
    private var checking = false
    var onDismiss: (() -> Void)?
    var renderedSummaryLines: [String] = []

    private static let checkTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "MM-dd HH:mm"
        return f
    }()

    private static let priceFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 4
        f.usesGroupingSeparator = false
        return f
    }()

    init(app: Assistant) {
        self.app = app
        super.init()
        sheet.title = L10n.t("pricing_sheet.title")
        sheet.isReleasedWhenClosed = false
        sheet.backgroundColor = .clear
        sheet.isOpaque = false
        sheet.delegate = self
        sheet.onCancelOperation = { [weak self] in self?.closeSheet() }

        let surface = SheetVisualEffectView()
        sheet.contentView = surface

        statusIconBox.boxType = .custom
        statusIconBox.cornerRadius = 8.5
        statusIconBox.borderWidth = 0.5
        statusIconBox.contentViewMargins = .zero
        statusIconBox.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            statusIconBox.widthAnchor.constraint(equalToConstant: 32),
            statusIconBox.heightAnchor.constraint(equalToConstant: 32)
        ])
        statusIconBox.setAccessibilityElement(false)
        statusIconView.translatesAutoresizingMaskIntoConstraints = false
        statusIconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        statusIconBox.addSubview(statusIconView)
        NSLayoutConstraint.activate([
            statusIconView.centerXAnchor.constraint(equalTo: statusIconBox.centerXAnchor),
            statusIconView.centerYAnchor.constraint(equalTo: statusIconBox.centerYAnchor)
        ])

        let headerTextCol = vertical([titleLabel, subtitleLabel], spacing: 2)
        fillWidth(titleLabel, in: headerTextCol)
        fillWidth(subtitleLabel, in: headerTextCol)
        summaryPill.setContentHuggingPriority(.required, for: .horizontal)
        summaryPill.setContentCompressionResistancePriority(.required, for: .horizontal)

        let headerRow = horizontal([statusIconBox, headerTextCol, flexibleSpace(), summaryPill], spacing: 10)
        headerRow.alignment = .centerY

        listStack.orientation = .vertical
        listStack.alignment = .leading
        listStack.spacing = 7
        listStack.translatesAutoresizingMaskIntoConstraints = false

        let docWrapper = TopAlignedDocument()
        docWrapper.translatesAutoresizingMaskIntoConstraints = false
        docWrapper.addSubview(listStack)
        NSLayoutConstraint.activate([
            listStack.leadingAnchor.constraint(equalTo: docWrapper.leadingAnchor),
            listStack.trailingAnchor.constraint(equalTo: docWrapper.trailingAnchor),
            listStack.topAnchor.constraint(equalTo: docWrapper.topAnchor),
            listStack.bottomAnchor.constraint(equalTo: docWrapper.bottomAnchor)
        ])

        listScroll.drawsBackground = false
        listScroll.hasVerticalScroller = true
        listScroll.autohidesScrollers = true
        listScroll.borderType = .noBorder
        listScroll.documentView = docWrapper
        listScroll.translatesAutoresizingMaskIntoConstraints = false
        listScroll.heightAnchor.constraint(equalToConstant: 300).isActive = true
        docWrapper.widthAnchor.constraint(equalTo: listScroll.contentView.widthAnchor).isActive = true

        let listCard = group([listScroll], inset: 10)
        listCard.cornerRadius = Design.Radius.medium

        recheckBtn.target = self
        closeBtn.target = self
        closeBtn.bezelColor = Design.blue
        closeBtn.keyEquivalent = "\r"

        let footerRow = horizontal([flexibleSpace(), recheckBtn, closeBtn], spacing: 8)
        footerRow.alignment = .centerY

        let root = vertical([headerRow, listCard, historicalNoteLabel, divider(), footerRow], spacing: 12)
        for child in root.arrangedSubviews { fillWidth(child, in: root) }

        let content = fixedPage(root)
        surface.addSubview(content)
        pin(content, to: surface)
        Design.applyControls(surface)
    }

    private static func fmtRate(_ val: Double) -> String {
        let s = priceFormatter.string(from: NSNumber(value: val)) ?? String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), val)
        return "$\(s)"
    }

    func apply(payload: [String: Any]) {
        let synced = payload["synced"] as? Bool == true
        let healedCount = payload["healedCount"] as? Int ?? 0
        let err = payload["error"] as? String
        let status = payload["status"] as? [String: Any] ?? [:]
        let feedVersion = (payload["version"] as? String) ?? (status["feedVersion"] as? String) ?? ""
        let prices = payload["prices"] as? [String: [String: Any]] ?? [:]
        let pricingStatus = payload["pricingStatus"] as? [String: String] ?? [:]
        let totalModels = prices.count > 0 ? prices.count : (status["modelCount"] as? Int ?? 0)
        let lastCheckMs: Double = (status["lastCheckAt"] as? NSNumber)?.doubleValue
            ?? (status["lastSyncAt"] as? NSNumber)?.doubleValue
            ?? 0

        let badgeTint: NSColor = synced ? .systemGreen : accessibleWarningColor()
        statusIconBox.fillColor = NSColor(name: nil) { app in
            let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return badgeTint.withAlphaComponent(isDark ? 0.18 : 0.11)
        }
        statusIconBox.borderColor = NSColor(name: nil) { app in
            let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return badgeTint.withAlphaComponent(isDark ? 0.34 : 0.20)
        }
        if synced {
            statusIconView.image = NSImage(systemSymbolName: "checkmark.seal.fill", accessibilityDescription: nil)
            statusIconView.contentTintColor = .systemGreen
            titleLabel.stringValue = healedCount > 0 ? L10n.t("pricing_sheet.synced_healed") : L10n.t("pricing_sheet.synced")
            if healedCount > 0 {
                subtitleLabel.stringValue = L10n.t("pricing_sheet.healed_sub", ["count": healedCount])
                subtitleLabel.isHidden = false
            } else {
                subtitleLabel.stringValue = ""
                subtitleLabel.isHidden = true
            }
            summaryPill.tint = Design.blue
        } else {
            statusIconView.image = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil)
            statusIconView.contentTintColor = accessibleWarningColor()
            titleLabel.stringValue = L10n.t("pricing_sheet.sync_incomplete")
            subtitleLabel.stringValue = (err?.isEmpty == false) ? L10n.t("pricing_sheet.check_hint", ["error": err!]) : L10n.t("pricing_sheet.remote_unreachable")
            subtitleLabel.isHidden = false
            summaryPill.tint = accessibleWarningColor()
        }

        if lastCheckMs > 0 {
            let formatted = Self.checkTimeFormatter.string(from: Date(timeIntervalSince1970: lastCheckMs / 1000.0))
            let stateText = synced ? L10n.t("pricing_sheet.pill.synced_at", ["time": formatted]) : L10n.t("pricing_sheet.pill.checked_at", ["time": formatted])
            summaryPill.title = L10n.t("pricing_sheet.pill.count", ["state": stateText, "count": totalModels])
            summaryPill.isHidden = false
        } else if !feedVersion.isEmpty && feedVersion != "unknown" {
            summaryPill.title = L10n.t("pricing_sheet.pill.version_count", ["version": feedVersion, "count": totalModels])
            summaryPill.isHidden = false
        } else {
            summaryPill.title = L10n.t("pricing_sheet.pill.active_count", ["count": totalModels])
            summaryPill.isHidden = totalModels == 0
        }

        listStack.arrangedSubviews.forEach {
            listStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        var summaryLines: [String] = []
        let sortedKeys = prices.keys.sorted()
        for key in sortedKeys {
            guard let entry = prices[key] else { continue }
            let inputRate = doubleVal(entry, "input")
            let outputRate = doubleVal(entry, "output")
            let cachedRate = doubleVal(entry, "cached")
            let cacheWriteRate = entry["cacheWrite"] != nil ? doubleVal(entry, "cacheWrite") : nil
            let rawState = pricingStatus[key] ?? "historical"
            let (stateTitle, stateTint): (String, NSColor) = switch rawState {
            case "confirmed": (L10n.t("pricing_sheet.state.confirmed"), Design.blue)
            case "user": (L10n.t("pricing_sheet.state.user"), .systemPurple)
            case "expired": (L10n.t("pricing_sheet.state.expired"), accessibleWarningColor())
            default: (L10n.t("pricing_sheet.state.historical"), Design.inactivePill)
            }

            let prov = entry["provenance"] as? [String: Any] ?? [:]
            let checkedAt = (prov["checkedAt"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let validUntil = (prov["validUntil"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let sourceUrl = (prov["sourceUrl"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

            var dateParts: [String] = []
            if !checkedAt.isEmpty { dateParts.append(L10n.t("pricing_sheet.date.checked_at", ["date": checkedAt])) }
            if !validUntil.isEmpty {
                let shortDate = validUntil.count >= 10 ? String(validUntil.prefix(10)) : validUntil
                dateParts.append(L10n.t("pricing_sheet.date.valid_until", ["date": shortDate]))
            }
            let dateText = dateParts.joined(separator: " · ")

            let modelTitle = text(key, size: 12.5, weight: .semibold, color: .labelColor)
            modelTitle.lineBreakMode = .byTruncatingMiddle
            let stateBadge = pillBadge(stateTitle, color: stateTint)
            stateBadge.setContentHuggingPriority(.required, for: .horizontal)
            let dateLbl = text(dateText, size: 10.5, color: Design.secondary)
            dateLbl.setContentHuggingPriority(.required, for: .horizontal)
            let topRow = horizontal([modelTitle, stateBadge, flexibleSpace(), dateLbl], spacing: 6)
            topRow.alignment = .centerY

            var rateParts = [
                L10n.t("pricing_sheet.rate.input", ["rate": Self.fmtRate(inputRate)]),
                L10n.t("pricing_sheet.rate.cache_read", ["rate": Self.fmtRate(cachedRate)]),
            ]
            if let cacheWriteRate, cacheWriteRate > 0 {
                rateParts.append(L10n.t("pricing_sheet.rate.cache_write", ["rate": Self.fmtRate(cacheWriteRate)]))
            }
            rateParts.append(L10n.t("pricing_sheet.rate.output", ["rate": Self.fmtRate(outputRate)]))
            let rateLabel = text(rateParts.joined(separator: " · "), size: 11.5, weight: .medium, color: .labelColor)
            rateLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
            rateLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

            let bottomRow: NSView
            if let url = URL(string: sourceUrl), ["http", "https"].contains(url.scheme ?? "") {
                let linkBtn = NSButton(title: L10n.t("pricing_sheet.source_link"), target: self, action: #selector(openSourceURL(_:)))
                linkBtn.isBordered = false
                linkBtn.font = .systemFont(ofSize: 10.5, weight: .medium)
                linkBtn.contentTintColor = Design.blue
                linkBtn.toolTip = sourceUrl
                linkBtn.setContentHuggingPriority(.required, for: .horizontal)
                let row = horizontal([rateLabel, flexibleSpace(), linkBtn], spacing: 8)
                row.alignment = .centerY
                bottomRow = row
            } else {
                bottomRow = rateLabel
            }

            let cardBody = vertical([topRow, bottomRow], spacing: 4)
            for r in cardBody.arrangedSubviews { fillWidth(r, in: cardBody) }
            let card = DesignCardBox()
            card.boxType = .custom
            card.cornerRadius = 9
            card.borderWidth = 0.5
            card.borderColor = Design.border
            card.enablesHoverHighlight = false
            card.fillColor = NSColor(name: nil) { app in
                app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                    ? NSColor.white.withAlphaComponent(0.035)
                    : NSColor.black.withAlphaComponent(0.022)
            }
            card.contentViewMargins = .zero
            card.addSubview(cardBody)
            cardBody.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                cardBody.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 11),
                cardBody.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -11),
                cardBody.topAnchor.constraint(equalTo: card.topAnchor, constant: 8),
                cardBody.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -8)
            ])
            listStack.addArrangedSubview(card)
            fillWidth(card, in: listStack)

            summaryLines.append("\(key) [\(stateTitle)] · \(rateParts.joined(separator: " · "))" + (dateText.isEmpty ? "" : " · \(dateText)") + (sourceUrl.isEmpty ? "" : " · \(sourceUrl)"))
        }

        if sortedKeys.isEmpty {
            let emptyLabel = text(L10n.t("pricing_sheet.empty"), size: 12, color: Design.secondary)
            listStack.addArrangedSubview(emptyLabel)
        }
        renderedSummaryLines = summaryLines
        listScroll.documentView?.layoutSubtreeIfNeeded()
        listScroll.contentView.scroll(to: .zero)
        listScroll.reflectScrolledClipView(listScroll.contentView)
    }

    @objc private func openSourceURL(_ sender: NSButton) {
        guard let raw = sender.toolTip, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func recheck() {
        guard !checking else { return }
        checking = true
        recheckBtn.setBusy(true, available: true)
        app.bridge.send(["command": "pricing_sync_check"]) { [weak self] result in
            guard let self else { return }
            self.checking = false
            self.recheckBtn.setBusy(false, available: self.app.reachable)
            if case .success(let payload) = result {
                self.apply(payload: payload)
                if payload["synced"] as? Bool == true {
                    self.app.invalidateUsageReportCache()
                    self.app.overview?.fetch()
                    self.app.usagePage?.fetch(force: true)
                }
            } else if case .failure(let err) = result {
                self.app.showMessage(L10n.t("pricing_sheet.check_failed", ["error": err.localizedDescription]), error: true)
            }
        }
    }

    func show(in parent: NSWindow, payload: [String: Any], onDismiss: (() -> Void)? = nil) {
        self.onDismiss = onDismiss
        apply(payload: payload)
        if sheet.sheetParent == nil {
            app.presentRetainedSheet(controller: self, sheet: sheet, in: parent) { [weak self] _ in
                self?.onDismiss?()
            }
        }
        sheet.makeFirstResponder(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeSheet()
        return false
    }

    @objc func closeSheet() {
        sheet.sheetParent?.endSheet(sheet)
    }
}
