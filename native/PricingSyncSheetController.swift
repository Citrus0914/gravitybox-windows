import Cocoa

private final class SourceLinkButton: NSButton {
    let sourceURL: URL
    private var hoverTracking: NSTrackingArea?
    private var hovered = false {
        didSet {
            if oldValue != hovered { updateAppearance() }
        }
    }

    init(title: String, sourceURL: URL, target: AnyObject?, action: Selector) {
        self.sourceURL = sourceURL
        super.init(frame: .zero)
        self.target = target
        self.action = action
        isBordered = false
        bezelStyle = .inline
        focusRingType = .none
        setButtonType(.momentaryChange)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.link)
        setAccessibilityLabel(title)
        self.title = title
        updateAppearance()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func updateAppearance() {
        let color = hovered ? Design.blue.withAlphaComponent(0.75) : Design.blue
        var attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
            .foregroundColor: color,
        ]
        if hovered {
            attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }
        attributedTitle = NSAttributedString(string: title, attributes: attrs)
        invalidateIntrinsicContentSize()
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTracking { removeTrackingArea(hoverTracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
}

private final class RetiredToggleButton: NSButton {
    override var allowsVibrancy: Bool { false }
    private let labelFont = NSFont.systemFont(ofSize: 11.5, weight: .medium)
    private var hoverTracking: NSTrackingArea?
    private var hovered = false {
        didSet {
            if oldValue != hovered { needsDisplay = true }
        }
    }

    init(title: String, target: AnyObject?, action: Selector) {
        super.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        bezelStyle = .inline
        isBordered = false
        focusRingType = .none
        alignment = .left
        font = labelFont
        setButtonType(.momentaryChange)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var title: String {
        didSet {
            setAccessibilityLabel(title)
            invalidateIntrinsicContentSize()
            needsDisplay = true
        }
    }

    override var intrinsicContentSize: NSSize {
        let size = (title as NSString).size(withAttributes: [.font: labelFont])
        return NSSize(width: ceil(size.width) + 12, height: 24)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { hovered = false }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if hovered {
            let bg = NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6)
            (isDark ? NSColor.white.withAlphaComponent(0.06) : NSColor.black.withAlphaComponent(0.045)).setFill()
            bg.fill()
        }
        let textColor = hovered ? NSColor.labelColor : Design.secondary
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let attrs: [NSAttributedString.Key: Any] = [
            .font: labelFont,
            .foregroundColor: textColor,
            .paragraphStyle: paragraph
        ]
        let textSize = (title as NSString).size(withAttributes: attrs)
        let textRect = NSRect(
            x: 6,
            y: floor((bounds.height - textSize.height) / 2),
            width: max(0, bounds.width - 12),
            height: ceil(textSize.height)
        )
        (title as NSString).draw(in: textRect, withAttributes: attrs)
    }
}

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
    var retiredExpanded = false
    var retiredToggleBtn: NSButton?
    var retiredListStack: NSStackView?
    var renderedRetiredSummaryLines: [String] = []
    private var retiredModelsCount = 0
    private var retiredWidthConstraint: NSLayoutConstraint?
    private var lastPayload: [String: Any]?
    private var languageObserver: NSObjectProtocol?

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
        listStack.detachesHiddenViews = true
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

        languageObserver = NotificationCenter.default.addObserver(
            forName: L10n.didChangeNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            if Thread.isMainThread {
                self?.syncLocalizedChrome()
            } else {
                DispatchQueue.main.async { [weak self] in
                    self?.syncLocalizedChrome()
                }
            }
        }
    }

    deinit {
        if let languageObserver {
            NotificationCenter.default.removeObserver(languageObserver)
        }
    }

    private func syncLocalizedChrome() {
        let localizedTitle = L10n.t("pricing_sheet.title")
        sheet.title = localizedTitle
        titleLabel.stringValue = localizedTitle
        historicalNoteLabel.stringValue = L10n.t("pricing_sheet.note")
        recheckBtn.title = L10n.t("pricing_sheet.recheck")
        recheckBtn.setAccessibilityLabel(recheckBtn.title)
        recheckBtn.invalidateIntrinsicContentSize()
        closeBtn.title = L10n.t("pricing_sheet.done")
        closeBtn.setAccessibilityLabel(closeBtn.title)
        closeBtn.invalidateIntrinsicContentSize()
        if let lastPayload {
            renderPayload(lastPayload, resetScroll: false)
        }
    }

    private static func fmtRate(_ val: Double) -> String {
        let s = priceFormatter.string(from: NSNumber(value: val)) ?? String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), val)
        return "$\(s)"
    }

    private static func availabilityRank(_ raw: String?) -> Int {
        switch raw {
        case "tier_locked": return 1
        case "other_tier_only": return 2
        case "retired": return 3
        default: return 0
        }
    }

    private func makeRigidBadge(_ title: String, color: NSColor) -> PillBadge {
        let badge = pillBadge(title, color: color)
        badge.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)
        return badge
    }

    private func makeTitleViews(key: String, displayName: String?) -> [NSView] {
        let trimmedName = (displayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedName.isEmpty && trimmedName.lowercased() != key.lowercased() {
            let nameLbl = text(trimmedName, size: 12.5, weight: .semibold, color: .labelColor)
            nameLbl.lineBreakMode = .byTruncatingTail
            nameLbl.setContentHuggingPriority(.defaultHigh, for: .horizontal)
            nameLbl.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(500), for: .horizontal)

            let keyLbl = text(key, size: 10.5, color: Design.secondary)
            keyLbl.lineBreakMode = .byTruncatingMiddle
            keyLbl.setContentHuggingPriority(.defaultHigh, for: .horizontal)
            keyLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            return [nameLbl, keyLbl]
        }
        let modelTitle = text(key, size: 12.5, weight: .semibold, color: .labelColor)
        modelTitle.lineBreakMode = .byTruncatingMiddle
        modelTitle.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        modelTitle.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return [modelTitle]
    }

    private func makeCardBox(body: NSView, alpha: CGFloat = 1.0) -> DesignCardBox {
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
        card.alphaValue = alpha
        card.addSubview(body)
        body.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            body.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 11),
            body.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -11),
            body.topAnchor.constraint(equalTo: card.topAnchor, constant: 8),
            body.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -8)
        ])
        return card
    }

    private func buildPriceCard(
        key: String,
        entry: [String: Any],
        rawState: String,
        displayName: String?,
        availabilityBadge: (title: String, color: NSColor)?,
        alpha: CGFloat = 1.0
    ) -> (card: DesignCardBox, summaryLine: String) {
        let inputRate = doubleVal(entry, "input")
        let outputRate = doubleVal(entry, "output")
        let cachedRate = doubleVal(entry, "cached")
        let cacheWriteRate = entry["cacheWrite"] != nil ? doubleVal(entry, "cacheWrite") : nil
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
        let dateText = dateParts.joined(separator: " \u{00B7} ")

        var topViews = makeTitleViews(key: key, displayName: displayName)
        topViews.append(makeRigidBadge(stateTitle, color: stateTint))
        if let av = availabilityBadge {
            topViews.append(makeRigidBadge(av.title, color: av.color))
        }
        let dateLbl = text(dateText, size: 10.5, color: Design.secondary)
        dateLbl.setContentHuggingPriority(.required, for: .horizontal)
        dateLbl.setContentCompressionResistancePriority(.required, for: .horizontal)
        dateLbl.isHidden = dateText.isEmpty
        topViews.append(flexibleSpace())
        topViews.append(dateLbl)

        let topRow = horizontal(topViews, spacing: 6)
        topRow.alignment = .centerY
        topRow.detachesHiddenViews = true

        var rateParts = [
            L10n.t("pricing_sheet.rate.input", ["rate": Self.fmtRate(inputRate)]),
            L10n.t("pricing_sheet.rate.cache_read", ["rate": Self.fmtRate(cachedRate)]),
        ]
        if let cacheWriteRate, cacheWriteRate > 0 {
            rateParts.append(L10n.t("pricing_sheet.rate.cache_write", ["rate": Self.fmtRate(cacheWriteRate)]))
        }
        rateParts.append(L10n.t("pricing_sheet.rate.output", ["rate": Self.fmtRate(outputRate)]))
        let rateLabel = text(rateParts.joined(separator: " \u{00B7} "), size: 11.5, weight: .medium, color: .labelColor)
        rateLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
        rateLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let bottomRow: NSView
        if let url = URL(string: sourceUrl), url.scheme?.lowercased() == "https", url.host != nil {
            let linkBtn = SourceLinkButton(title: L10n.t("pricing_sheet.source_link"), sourceURL: url, target: self, action: #selector(openSourceURL(_:)))
            linkBtn.setContentHuggingPriority(.required, for: .horizontal)
            let row = horizontal([rateLabel, flexibleSpace(), linkBtn], spacing: 8)
            row.alignment = .centerY
            bottomRow = row
        } else {
            bottomRow = rateLabel
        }

        let cardBody = vertical([topRow, bottomRow], spacing: 4)
        for r in cardBody.arrangedSubviews { fillWidth(r, in: cardBody) }
        let card = makeCardBox(body: cardBody, alpha: alpha)

        var summaryLine = "\(key) [\(stateTitle)] \u{00B7} \(rateParts.joined(separator: " \u{00B7} "))"
        if !dateText.isEmpty { summaryLine += " \u{00B7} \(dateText)" }
        if !sourceUrl.isEmpty { summaryLine += " \u{00B7} \(sourceUrl)" }
        if let av = availabilityBadge { summaryLine += " \u{00B7} [\(av.title)]" }
        return (card, summaryLine)
    }

    private func retiredToggleTitle(count: Int) -> String {
        let key = retiredExpanded ? "pricing_sheet.retired.toggle_expanded" : "pricing_sheet.retired.toggle_collapsed"
        return L10n.t(key, ["count": count])
    }

    private func syncRetiredSectionVisibility() {
        guard let retiredStack = retiredListStack, let toggleBtn = retiredToggleBtn else { return }
        retiredStack.isHidden = !retiredExpanded
        if retiredExpanded {
            if retiredWidthConstraint == nil || retiredWidthConstraint?.isActive == false {
                retiredWidthConstraint = retiredStack.widthAnchor.constraint(equalTo: listStack.widthAnchor)
                retiredWidthConstraint?.isActive = true
            }
        } else {
            retiredWidthConstraint?.isActive = false
            retiredWidthConstraint = nil
        }
        toggleBtn.title = retiredToggleTitle(count: retiredModelsCount)
    }

    @objc func toggleRetiredSection() {
        guard retiredListStack != nil, retiredToggleBtn != nil else { return }
        let savedOrigin = listScroll.contentView.bounds.origin
        retiredExpanded.toggle()
        syncRetiredSectionVisibility()
        listScroll.layoutSubtreeIfNeeded()
        let docHeight = listScroll.documentView?.bounds.height ?? 0
        let clipHeight = listScroll.contentView.bounds.height
        let maxY = max(0, docHeight - clipHeight)
        let clampedY = min(max(0, savedOrigin.y), maxY)
        listScroll.contentView.scroll(to: NSPoint(x: savedOrigin.x, y: clampedY))
        listScroll.reflectScrolledClipView(listScroll.contentView)
    }

    func apply(payload: [String: Any]) {
        renderPayload(payload, resetScroll: true)
    }

    private func renderPayload(_ payload: [String: Any], resetScroll: Bool) {
        lastPayload = payload
        let synced = payload["synced"] as? Bool == true
        let healedCount = payload["healedCount"] as? Int ?? 0
        let err = payload["error"] as? String
        let status = payload["status"] as? [String: Any] ?? [:]
        let feedVersion = (payload["version"] as? String) ?? (status["feedVersion"] as? String) ?? ""
        let prices = payload["prices"] as? [String: [String: Any]] ?? [:]
        let retiredPrices = payload["retiredPrices"] as? [String: [String: Any]] ?? [:]
        let pricingStatus = payload["pricingStatus"] as? [String: String] ?? [:]
        let modelCatalogState = payload["modelCatalogState"] as? [String: [String: Any]] ?? [:]
        let rawUnpriced = payload["unpricedLiveModels"] as? [[String: Any]] ?? []
        let validUnpriced = rawUnpriced.compactMap { item -> (key: String, displayName: String, disabled: Bool)? in
            guard let rawKey = item["key"] as? String else { return nil }
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { return nil }
            let displayName = (item["displayName"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let disabled = item["disabled"] as? Bool == true
            return (key: key, displayName: displayName, disabled: disabled)
        }

        let activeCount = prices.count + validUnpriced.count
        let totalModels = activeCount > 0 ? activeCount : (status["modelCount"] as? Int ?? 0)
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

        retiredWidthConstraint?.isActive = false
        retiredWidthConstraint = nil
        retiredToggleBtn = nil
        retiredListStack = nil
        retiredModelsCount = retiredPrices.count
        listStack.arrangedSubviews.forEach {
            listStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        var summaryLines: [String] = []

        for item in validUnpriced {
            let unpricedBadgeTitle = L10n.t("pricing_sheet.availability.unpriced_live")
            var topViews = makeTitleViews(key: item.key, displayName: item.displayName)
            topViews.append(makeRigidBadge(unpricedBadgeTitle, color: accessibleWarningColor()))
            var summarySuffix = ""
            if item.disabled {
                let lockedTitle = L10n.t("pricing_sheet.availability.tier_locked")
                topViews.append(makeRigidBadge(lockedTitle, color: accessibleWarningColor()))
                summarySuffix = " [\(lockedTitle)]"
            }
            topViews.append(flexibleSpace())
            let topRow = horizontal(topViews, spacing: 6)
            topRow.alignment = .centerY

            let descLabel = text(L10n.t("pricing_sheet.unpriced_live_desc"), size: 11.5, color: Design.secondary, wrap: true)
            let cardBody = vertical([topRow, descLabel], spacing: 4)
            for r in cardBody.arrangedSubviews { fillWidth(r, in: cardBody) }
            let card = makeCardBox(body: cardBody)
            listStack.addArrangedSubview(card)
            fillWidth(card, in: listStack)
            summaryLines.append("\(item.key) [\(unpricedBadgeTitle)]\(summarySuffix)")
        }

        let sortedKeys = prices.keys.sorted { lhs, rhs in
            let lr = Self.availabilityRank(modelCatalogState[lhs]?["availability"] as? String)
            let rr = Self.availabilityRank(modelCatalogState[rhs]?["availability"] as? String)
            if lr != rr { return lr < rr }
            return lhs < rhs
        }
        for key in sortedKeys {
            guard let entry = prices[key] else { continue }
            let meta = modelCatalogState[key]
            let availability = meta?["availability"] as? String ?? "available"
            let displayName = meta?["displayName"] as? String
            let avBadge: (title: String, color: NSColor)?
            switch availability {
            case "tier_locked":
                avBadge = (L10n.t("pricing_sheet.availability.tier_locked"), accessibleWarningColor())
            case "other_tier_only":
                let tiers = (meta?["availableInTiers"] as? [String] ?? [])
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                let title = tiers.isEmpty
                    ? L10n.t("pricing_sheet.availability.other_tier")
                    : L10n.t("pricing_sheet.availability.other_tier_named", ["tiers": tiers.joined(separator: "/")])
                avBadge = (title, Design.inactivePill)
            default:
                avBadge = nil
            }
            let built = buildPriceCard(
                key: key,
                entry: entry,
                rawState: pricingStatus[key] ?? "historical",
                displayName: displayName,
                availabilityBadge: avBadge
            )
            listStack.addArrangedSubview(built.card)
            fillWidth(built.card, in: listStack)
            summaryLines.append(built.summaryLine)
        }

        var retiredSummary: [String] = []
        if !retiredPrices.isEmpty {
            if !validUnpriced.isEmpty || !sortedKeys.isEmpty {
                let sep = divider()
                listStack.addArrangedSubview(sep)
                fillWidth(sep, in: listStack)
            }
            let toggleBtn = RetiredToggleButton(
                title: retiredToggleTitle(count: retiredPrices.count),
                target: self,
                action: #selector(toggleRetiredSection)
            )
            retiredToggleBtn = toggleBtn
            listStack.addArrangedSubview(toggleBtn)
            fillWidth(toggleBtn, in: listStack)

            let retiredStack = NSStackView()
            retiredStack.orientation = .vertical
            retiredStack.alignment = .leading
            retiredStack.spacing = 7
            retiredStack.translatesAutoresizingMaskIntoConstraints = false
            retiredListStack = retiredStack

            let retiredBadgeTitle = L10n.t("pricing_sheet.availability.retired")
            for key in retiredPrices.keys.sorted() {
                guard let entry = retiredPrices[key] else { continue }
                let displayName = modelCatalogState[key]?["displayName"] as? String
                let built = buildPriceCard(
                    key: key,
                    entry: entry,
                    rawState: pricingStatus[key] ?? "historical",
                    displayName: displayName,
                    availabilityBadge: (retiredBadgeTitle, Design.inactivePill),
                    alpha: 0.88
                )
                retiredStack.addArrangedSubview(built.card)
                fillWidth(built.card, in: retiredStack)
                retiredSummary.append(built.summaryLine)
            }
            listStack.addArrangedSubview(retiredStack)
            syncRetiredSectionVisibility()
        }
        renderedRetiredSummaryLines = retiredSummary

        if validUnpriced.isEmpty && sortedKeys.isEmpty && retiredPrices.isEmpty {
            let emptyLabel = text(L10n.t("pricing_sheet.empty"), size: 12, color: Design.secondary)
            listStack.addArrangedSubview(emptyLabel)
        }
        renderedSummaryLines = summaryLines
        listScroll.documentView?.layoutSubtreeIfNeeded()
        if resetScroll {
            listScroll.contentView.scroll(to: .zero)
            listScroll.reflectScrolledClipView(listScroll.contentView)
        }
    }

    @objc private func openSourceURL(_ sender: SourceLinkButton) {
        NSWorkspace.shared.open(sender.sourceURL)
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
        retiredExpanded = false
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
