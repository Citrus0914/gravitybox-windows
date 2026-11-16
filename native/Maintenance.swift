import Cocoa

// MARK: - Segmented Storage Composition Bar (Runtime Cache vs Old Logs vs Protected Core Data)
final class CacheCompositionBar: NSView {
    var safeBytes: Int64 = 0 { didSet { animateFractions() } }
    var statefulBytes: Int64 = 0 { didSet { animateFractions() } }
    var protectedBytes: Int64 = 0 { didSet { animateFractions() } }

    private var displayedSafeFrac: CGFloat = 0
    private var displayedStatefulFrac: CGFloat = 0
    private let motion = DesignMotion()

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 8)
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 8).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
        setAccessibilityLabel(L10n.t("maintenance.composition_a11y"))
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        motion.cancel()
    }

    private func animateFractions() {
        let total = max(1, safeBytes + statefulBytes + protectedBytes)
        let targetSafe = safeBytes > 0 ? CGFloat(safeBytes) / CGFloat(total) : 0
        let targetStateful = statefulBytes > 0 ? CGFloat(statefulBytes) / CGFloat(total) : 0
        motion.cancel()
        let startSafe = displayedSafeFrac
        let startStateful = displayedStatefulFrac
        guard Design.shouldAnimate(in: self),
              (abs(targetSafe - startSafe) >= 0.005 || abs(targetStateful - startStateful) >= 0.005) else {
            displayedSafeFrac = targetSafe
            displayedStatefulFrac = targetStateful
            needsDisplay = true
            return
        }
        motion.animate(in: self, from: 0.0, to: 1.0, curve: .sweep, threshold: 0.005) { [weak self] progress in
            guard let self else { return }
            self.displayedSafeFrac = startSafe + (targetSafe - startSafe) * progress
            self.displayedStatefulFrac = startStateful + (targetStateful - startStateful) * progress
            self.needsDisplay = true
        } completion: { [weak self] in
            self?.displayedSafeFrac = targetSafe
            self?.displayedStatefulFrac = targetStateful
            self?.needsDisplay = true
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            motion.cancel()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let radius = bounds.height / 2
        let trackRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let trackPath = NSBezierPath(roundedRect: trackRect, xRadius: radius, yRadius: radius)
        Design.track.setFill()
        trackPath.fill()

        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

        guard safeBytes > 0 || statefulBytes > 0 || protectedBytes > 0 else { return }

        NSGraphicsContext.current?.saveGraphicsState()
        trackPath.addClip()

        let usableWidth = bounds.width
        var cursorX: CGFloat = 0

        if safeBytes > 0 && displayedSafeFrac > 0 {
            let w = max(8, min(usableWidth, round(usableWidth * displayedSafeFrac)))
            let segRect = NSRect(x: cursorX, y: 0, width: w, height: bounds.height)
            if let grad = NSGradient(starting: Design.blue.withAlphaComponent(0.75), ending: Design.blue) {
                grad.draw(in: segRect, angle: 0)
            } else {
                Design.blue.setFill()
                segRect.fill()
            }
            cursorX = min(usableWidth, cursorX + w + 2)
        }

        if statefulBytes > 0 && displayedStatefulFrac > 0 && cursorX < usableWidth {
            let w = max(6, min(usableWidth - cursorX, round(usableWidth * displayedStatefulFrac)))
            Design.color(0xD97706, 0xFBBF24).withAlphaComponent(0.88).setFill()
            NSRect(x: cursorX, y: 0, width: w, height: bounds.height).fill()
            cursorX = min(usableWidth, cursorX + w + 2)
        }

        if protectedBytes > 0 && cursorX < usableWidth {
            let protWidth = max(0, usableWidth - cursorX)
            if protWidth > 0 {
                let protColor = isDark
                    ? NSColor.white.withAlphaComponent(0.26)
                    : NSColor.black.withAlphaComponent(0.18)
                protColor.setFill()
                NSRect(x: cursorX, y: 0, width: protWidth, height: bounds.height).fill()
            }
        }

        NSGraphicsContext.current?.restoreGraphicsState()
    }
}

// MARK: - Subtle HIG Info Disclosure Button & Zero-Inset Interactive Trigger Group
final class MaintenanceInfoButton: NSButton {
    override var allowsVibrancy: Bool { false }
    var isActivePopover: Bool = false {
        didSet {
            if oldValue != isActivePopover { applyTint() }
        }
    }
    private var hoverTracking: NSTrackingArea?
    private var hovered = false {
        didSet {
            if oldValue != hovered { applyTint() }
        }
    }
    override var isHighlighted: Bool {
        didSet { applyTint() }
    }

    init(accessibilityLabel: String, target: AnyObject?, action: Selector) {
        super.init(frame: .zero)
        self.target = target
        self.action = action
        title = ""
        imagePosition = .imageOnly
        isBordered = false
        bezelStyle = .inline
        focusRingType = .none
        toolTip = nil
        setButtonType(.momentaryChange)
        image = NSImage(systemSymbolName: "info.circle", accessibilityDescription: nil)
        symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11.5, weight: .medium)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 16),
            heightAnchor.constraint(equalToConstant: 16)
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setAccessibilityLabel(accessibilityLabel)
        applyTint()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func applyTint() {
        if isActivePopover || isHighlighted {
            contentTintColor = Design.blue
        } else if hovered {
            contentTintColor = Design.blue.withAlphaComponent(0.86)
        } else {
            contentTintColor = Design.secondary.withAlphaComponent(0.68)
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
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
}

final class MaintenanceInteractiveGroup: NSView {
    override var allowsVibrancy: Bool { false }
    override var acceptsFirstResponder: Bool { true }
    var onActivate: ((NSView) -> Void)?
    var isActivePopover: Bool = false {
        didSet {
            if oldValue != isActivePopover { updateAppearanceState() }
        }
    }
    private var hoverTracking: NSTrackingArea?
    private var hovered = false {
        didSet {
            if oldValue != hovered { updateAppearanceState() }
        }
    }
    private var pressed = false {
        didSet {
            if oldValue != pressed { updateAppearanceState() }
        }
    }

    init(content: NSView, accessibilityLabel: String, onActivate: ((NSView) -> Void)? = nil) {
        self.onActivate = onActivate
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = nil
        addSubview(content)
        pin(content, to: self, inset: 0)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(accessibilityLabel)
    }

    required init?(coder: NSCoder) { fatalError() }

    private func updateAppearanceState() {
        if pressed {
            alphaValue = 0.72
        } else if hovered || isActivePopover {
            alphaValue = 0.88
        } else {
            alphaValue = 1.0
        }
    }

    func performClick(_ sender: Any? = nil) {
        onActivate?(self)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = superview?.convert(point, to: self) ?? point
        return bounds.contains(local) ? self : nil
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false; pressed = false }

    override func mouseDown(with event: NSEvent) {
        pressed = true
    }

    override func mouseUp(with event: NSEvent) {
        let wasPressed = pressed
        pressed = false
        let pt = convert(event.locationInWindow, from: nil)
        if wasPressed && bounds.contains(pt) {
            onActivate?(self)
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 49 || event.keyCode == 36 || event.keyCode == 76 {
            onActivate?(self)
        } else {
            super.keyDown(with: event)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            hovered = false
            pressed = false
        }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

// MARK: - Simplified 3-Card · 2-Switch · 1-Click Storage & Maintenance Module ("存储与维护")
final class CachePage: NSObject, NSPopoverDelegate {
    enum DetailKind: String, Equatable {
        case runtime
        case history
        case protected
        case snapshot
    }

    static let popoverWidth: CGFloat = 356

    static var retentionChoices: [(title: String, days: Int)] {
        [
            (L10n.t("maintenance.simple.retention_7d"), 7),
            (L10n.t("maintenance.simple.retention_30d"), 30),
            (L10n.t("maintenance.simple.retention_0d"), 0)
        ]
    }

    static func elasticSpacer() -> NSView {
        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        spacer.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        return spacer
    }

    private static let catalogSpecByName: [String: (prefix: String, icon: String)] = [
        "Cache": ("maintenance.catalog.cache", "internaldrive"),
        "Code Cache": ("maintenance.catalog.code_cache", "cpu"),
        "GPUCache": ("maintenance.catalog.gpu_cache", "sparkles.tv"),
        "DawnCache": ("maintenance.catalog.dawn_cache", "cube.transparent"),
        "DawnWebGPUCache": ("maintenance.catalog.dawn_webgpu_cache", "cube"),
        "DawnGraphiteCache": ("maintenance.catalog.dawn_graphite_cache", "paintbrush.pointed"),
        "GraphiteDawnCache": ("maintenance.catalog.graphite_dawn_cache", "wand.and.rays"),
        "ShaderCache": ("maintenance.catalog.shader_cache", "circle.hexagongrid"),
        "CachedData": ("maintenance.catalog.cached_data", "memorychip"),
        "CachedExtensionVSIXs": ("maintenance.catalog.cached_vsix", "puzzlepiece.extension"),
        "CachedProfilesData": ("maintenance.catalog.cached_profiles", "person.crop.square"),
        "Crashpad": ("maintenance.catalog.crashpad", "waveform.path.ecg"),
        "logs": ("maintenance.catalog.logs", "doc.text"),
        "blob_storage": ("maintenance.catalog.blob_storage", "archivebox"),
        "PartitionsCache": ("maintenance.catalog.partitions_cache", "square.split.2x2"),
        "AgentBrowserCache": ("maintenance.catalog.agent_browser_cache", "globe"),
        "OrphanAgentData": ("maintenance.catalog.orphan_agent_data", "trash.slash"),
        "AgentTaskStepLogs": ("maintenance.catalog.task_step_logs", "terminal"),
        "AgentVerboseTranscripts": ("maintenance.catalog.verbose_transcripts", "doc.on.doc"),
        "AgentSubagentDatabases": ("maintenance.catalog.subagent_dbs", "arrow.triangle.branch"),
        "Service Worker": ("maintenance.catalog.service_worker", "gearshape.2"),
        "Session Storage": ("maintenance.catalog.session_storage", "rectangle.stack"),
        "WebStorage": ("maintenance.catalog.web_storage", "externaldrive"),
        "Local Storage": ("maintenance.catalog.local_storage", "internaldrive"),
        "Cookies": ("maintenance.catalog.cookies", "key"),
        "Network Persistent State": ("maintenance.catalog.network_state", "network")
    ]

    unowned let app: Assistant
    let view: NSView

    // Header & Primary Action Controls
    let scanButton: InlineRefreshButton
    let clearButton: NSButton
    let sheetDoneButton: NSButton

    // Card 1: Hero Space Overview & Composition Controls
    let reclaimableTitleLabel = text(L10n.t("maintenance.simple.hero_title"), size: 11.5, weight: .medium, color: Design.secondary)
    let reclaimableValueLabel = text(L10n.t("maintenance.hero.scanning"), size: 30, weight: .semibold)
    let heroSubtitleLabel = text(L10n.t("maintenance.simple.hero_subtitle"), size: 11.5, color: Design.secondary)
    let compositionBar = CacheCompositionBar()
    let safeLegendLabel = text(L10n.t("maintenance.simple.legend_runtime", ["size": "—"]), size: 11, color: Design.secondary)
    let statefulLegendLabel = text(L10n.t("maintenance.simple.legend_history", ["size": "—"]), size: 11, color: Design.secondary)
    let protectedLegendLabel = text(L10n.t("maintenance.simple.legend_protected_empty"), size: 11, color: Design.secondary)
    let legendRuntimeTrigger: MaintenanceInteractiveGroup
    let legendHistoryTrigger: MaintenanceInteractiveGroup
    let legendProtectedTrigger: MaintenanceInteractiveGroup

    // Card 2: 2-Switch Foolproof Scope Card Controls
    let scopeStack = NSStackView()
    let runtimeTitleLabel = text(L10n.t("maintenance.simple.scope_runtime_title"), size: 13, weight: .semibold, color: .labelColor)
    let runtimeInfoButton: MaintenanceInfoButton
    let runtimeSubtitleLabel = text(L10n.t("maintenance.simple.scope_runtime_sub"), size: 11, color: Design.secondary)
    let runtimeSizeLabel = text("0 B", size: 13, weight: .semibold, color: Design.secondary)
    let runtimeCacheSwitch = DesignSwitch()

    let historyTitleLabel = text(L10n.t("maintenance.simple.scope_history_title"), size: 13, weight: .semibold, color: .labelColor)
    let retentionPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let historyInfoButton: MaintenanceInfoButton
    let historySubtitleLabel = text(L10n.t("maintenance.simple.scope_history_sub"), size: 11, color: Design.secondary)
    let historySizeLabel = text("0 B", size: 13, weight: .semibold, color: Design.secondary)
    let historyLogsSwitch = DesignSwitch()

    // Card 3: Safety & Single-Click Undo Footer Card Controls
    private let recoveryIconBox: NSBox
    private let recoveryIconView: NSImageView
    let recoveryTitleLabel = text(L10n.t("maintenance.simple.safety_idle_title"), size: 13, weight: .semibold, color: .labelColor)
    let recoverySubtitleLabel = text(L10n.t("maintenance.simple.safety_idle_sub"), size: 11, color: Design.secondary)
    let recoveryTriggerView: MaintenanceInteractiveGroup
    let restoreLatestButton: NSButton
    let openTrashButton: NSButton
    let feedbackLabel = text("", size: 11.5, color: Design.secondary)

    // Popover Audit State
    private(set) var detailPopover: NSPopover?
    private(set) var activePopoverKind: DetailKind?
    private var languageObserver: NSObjectProtocol?

    // State
    var entries: [[String: Any]] = []
    var protectedEntries: [[String: Any]] = []
    var snapshots: [[String: Any]] = []
    var runtimeCacheEnabled = true
    var historyLogsEnabled = false
    private var userToggledRuntimeSwitch = false
    private var userToggledHistorySwitch = false
    var hasCompletedScan = false
    var selectedRetentionDays: Int = 7
    var scanToken = ""
    var runtimeBucketBytes: Int64 = 0
    var historyBucketBytes: Int64 = 0
    var runtimeBucketFileCount: Int = 0
    var historyBucketFileCount: Int = 0
    var historyBucketSubagentCount: Int = 0
    var safeCacheBytes: Int64 = 0
    var statefulCacheBytes: Int64 = 0
    var totalProtectedBytes: Int64 = 0
    var appRunning = false
    var browserBusy = false
    var activeTrashPath = ""
    var usingFallbackTrash = false
    var scannedAt: Int = 0
    var busy = false
    private(set) var latestRestorableSnapshotId: String = ""
    private var latestUndoSnapshot: [String: Any]?
    private var lastFetchTime: Date = .distantPast

    private static let snapshotDateFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter

    var selectedScopes: [String] {
        var scopes: [String] = []
        if runtimeCacheEnabled && runtimeBucketBytes > 0 {
            scopes.append("runtime_cache")
        }
        if historyLogsEnabled && historyBucketBytes > 0 {
            scopes.append("history_logs")
        }
        return scopes
    }

    var selectedReclaimableBytes: Int64 {
        var sum: Int64 = 0
        if runtimeCacheEnabled && runtimeBucketBytes > 0 {
            sum += runtimeBucketBytes
        }
        if historyLogsEnabled && historyBucketBytes > 0 {
            sum += historyBucketBytes
        }
        return sum
    }

    init(app: Assistant) {
        self.app = app
        scanButton = InlineRefreshButton(L10n.t("common.refresh"), width: 78, target: nil, action: #selector(scanNow))
        clearButton = button(L10n.t("maintenance.simple.btn_clean_now"), target: nil, action: #selector(clearSelectedCaches))
        clearButton.bezelColor = Design.blue
        clearButton.font = .systemFont(ofSize: 13, weight: .semibold)
        clearButton.isEnabled = false
        clearButton.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            clearButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 106),
            clearButton.heightAnchor.constraint(equalToConstant: 32)
        ])

        retentionPopup.controlSize = .small
        retentionPopup.font = .systemFont(ofSize: 11, weight: .medium)
        retentionPopup.addItems(withTitles: Self.retentionChoices.map(\.title))
        retentionPopup.selectItem(at: 0)
        retentionPopup.setAccessibilityLabel(L10n.t("maintenance.retention_a11y"))
        retentionPopup.translatesAutoresizingMaskIntoConstraints = false
        retentionPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true

        runtimeInfoButton = MaintenanceInfoButton(
            accessibilityLabel: L10n.t("maintenance.popover.runtime_a11y"),
            target: nil,
            action: #selector(runtimeInfoPressed(_:))
        )
        historyInfoButton = MaintenanceInfoButton(
            accessibilityLabel: L10n.t("maintenance.popover.history_a11y"),
            target: nil,
            action: #selector(historyInfoPressed(_:))
        )

        runtimeCacheSwitch.controlSize = .small
        runtimeCacheSwitch.state = .on
        runtimeCacheSwitch.isEnabled = false
        runtimeCacheSwitch.setAccessibilityLabel(L10n.t("maintenance.simple.scope_runtime_a11y"))

        historyLogsSwitch.controlSize = .small
        historyLogsSwitch.state = .off
        historyLogsSwitch.isEnabled = false
        historyLogsSwitch.setAccessibilityLabel(L10n.t("maintenance.simple.scope_history_a11y"))

        let (recBox, recIcon) = Self.makeDynamicIconBadge(symbolName: "checkmark.shield", tint: .systemGreen)
        recoveryIconBox = recBox
        recoveryIconView = recIcon

        restoreLatestButton = button(L10n.t("maintenance.simple.btn_undo"), target: nil, action: #selector(restoreLatestSnapshot))
        restoreLatestButton.controlSize = .small
        restoreLatestButton.bezelColor = Design.blue
        restoreLatestButton.isHidden = true

        openTrashButton = button(L10n.t("maintenance.simple.btn_show_finder"), target: nil, action: #selector(openTrashFolder))
        openTrashButton.controlSize = .small

        sheetDoneButton = button(L10n.t("maintenance.btn.done"), target: nil, action: #selector(MaintenanceSheetController.closeSheet))
        sheetDoneButton.controlSize = .regular
        sheetDoneButton.bezelColor = Design.blue
        sheetDoneButton.keyEquivalent = "\r"
        sheetDoneButton.isHidden = true

        let headerTitle = text(L10n.t("maintenance.title"), size: 22, weight: .semibold)
        headerTitle.identifier = NSUserInterfaceItemIdentifier("page-title")
        let headerRow = horizontal([headerTitle, Self.elasticSpacer(), scanButton], spacing: 10)
        headerRow.alignment = .centerY

        // 1. Hero Space Overview & One-Click Action Card
        reclaimableValueLabel.font = .monospacedDigitSystemFont(ofSize: 30, weight: .semibold)
        reclaimableValueLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        safeLegendLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        statefulLegendLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        protectedLegendLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)

        let textCompressionPriority = NSLayoutConstraint.Priority(740)
        for lbl in [
            reclaimableTitleLabel, heroSubtitleLabel,
            safeLegendLabel, statefulLegendLabel, protectedLegendLabel,
            runtimeTitleLabel, runtimeSubtitleLabel,
            historyTitleLabel, historySubtitleLabel,
            recoveryTitleLabel, recoverySubtitleLabel, feedbackLabel
        ] {
            lbl.maximumNumberOfLines = 1
            lbl.lineBreakMode = .byTruncatingTail
            lbl.cell?.wraps = false
            lbl.cell?.truncatesLastVisibleLine = true
            lbl.toolTip = nil
            lbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
            lbl.setContentCompressionResistancePriority(textCompressionPriority, for: .horizontal)
        }

        let heroLeftCol = vertical([reclaimableTitleLabel, reclaimableValueLabel, heroSubtitleLabel], spacing: 3)
        heroLeftCol.setCustomSpacing(4, after: reclaimableValueLabel)
        heroLeftCol.alignment = .leading
        heroLeftCol.setContentHuggingPriority(.defaultLow, for: .horizontal)
        heroLeftCol.setContentCompressionResistancePriority(textCompressionPriority, for: .horizontal)

        clearButton.setContentHuggingPriority(.required, for: .horizontal)
        clearButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        let heroTopRow = horizontal([heroLeftCol, Self.elasticSpacer(), clearButton], spacing: 14)
        heroTopRow.alignment = .centerY

        let blueDot = Self.makeLegendDot(color: Design.blue)
        let amberDot = Self.makeLegendDot(color: Design.color(0xD97706, 0xFBBF24))
        let grayDot = Self.makeLegendDot(color: Design.color(0x8E8E93, 0x98989D))

        let protectedHintIcon = NSImageView(image: NSImage(systemSymbolName: "info.circle", accessibilityDescription: nil) ?? NSImage())
        protectedHintIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10.5, weight: .medium)
        protectedHintIcon.contentTintColor = Design.secondary.withAlphaComponent(0.62)
        protectedHintIcon.toolTip = nil
        protectedHintIcon.setAccessibilityElement(false)
        protectedHintIcon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            protectedHintIcon.widthAnchor.constraint(equalToConstant: 12),
            protectedHintIcon.heightAnchor.constraint(equalToConstant: 12)
        ])

        let legendSafe = horizontal([blueDot, safeLegendLabel], spacing: 5)
        legendSafe.alignment = .centerY
        let legendHistory = horizontal([amberDot, statefulLegendLabel], spacing: 5)
        legendHistory.alignment = .centerY
        let legendProtected = horizontal([grayDot, protectedLegendLabel, protectedHintIcon], spacing: 5)
        legendProtected.setCustomSpacing(3.5, after: protectedLegendLabel)
        legendProtected.alignment = .centerY

        legendRuntimeTrigger = MaintenanceInteractiveGroup(
            content: legendSafe,
            accessibilityLabel: L10n.t("maintenance.popover.runtime_a11y")
        )
        legendHistoryTrigger = MaintenanceInteractiveGroup(
            content: legendHistory,
            accessibilityLabel: L10n.t("maintenance.popover.history_a11y")
        )
        legendProtectedTrigger = MaintenanceInteractiveGroup(
            content: legendProtected,
            accessibilityLabel: L10n.t("maintenance.popover.protected_a11y")
        )
        for trigger in [legendRuntimeTrigger, legendHistoryTrigger, legendProtectedTrigger] {
            trigger.setContentHuggingPriority(.required, for: .horizontal)
            trigger.setContentCompressionResistancePriority(textCompressionPriority, for: .horizontal)
        }

        let legendRow = horizontal([legendRuntimeTrigger, legendHistoryTrigger, legendProtectedTrigger, Self.elasticSpacer()], spacing: 14)
        legendRow.alignment = .centerY

        let heroCard = group([heroTopRow, compositionBar, legendRow], inset: 14, spacing: 10)
        heroCard.cornerRadius = Design.Radius.card

        // 2. Two-Switch Foolproof Scope Card
        runtimeSizeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
        runtimeSizeLabel.alignment = .right
        runtimeSizeLabel.setContentHuggingPriority(.required, for: .horizontal)
        runtimeSizeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        historySizeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
        historySizeLabel.alignment = .right
        historySizeLabel.setContentHuggingPriority(.required, for: .horizontal)
        historySizeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let runtimeIcon = Self.makeIconBadge(symbolName: "sparkles", tint: Design.blue)
        runtimeTitleLabel.setContentHuggingPriority(.required, for: .horizontal)
        runtimeTitleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        let runtimeTitleRow = horizontal([runtimeTitleLabel, runtimeInfoButton], spacing: 5)
        runtimeTitleRow.alignment = .centerY
        let runtimeCaptions = vertical([runtimeTitleRow, runtimeSubtitleLabel], spacing: 2)
        runtimeCaptions.alignment = .leading
        runtimeCaptions.setContentHuggingPriority(.defaultLow, for: .horizontal)
        runtimeCaptions.setContentCompressionResistancePriority(textCompressionPriority, for: .horizontal)
        let runtimeRight = horizontal([runtimeSizeLabel, runtimeCacheSwitch], spacing: 10)
        runtimeRight.alignment = .centerY
        runtimeRight.setContentHuggingPriority(.required, for: .horizontal)
        runtimeRight.setContentCompressionResistancePriority(.required, for: .horizontal)
        let runtimeRow = horizontal([runtimeIcon, runtimeCaptions, Self.elasticSpacer(), runtimeRight], spacing: 11)
        runtimeRow.alignment = .centerY

        let amberTint = Design.color(0xD97706, 0xFBBF24)
        let historyIcon = Self.makeIconBadge(symbolName: "clock.arrow.circlepath", tint: amberTint)
        historyTitleLabel.setContentHuggingPriority(.required, for: .horizontal)
        historyTitleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        retentionPopup.setContentHuggingPriority(.required, for: .horizontal)
        retentionPopup.setContentCompressionResistancePriority(.required, for: .horizontal)
        let historyTitleRow = horizontal([historyTitleLabel, retentionPopup, historyInfoButton], spacing: 8)
        historyTitleRow.setCustomSpacing(5, after: retentionPopup)
        historyTitleRow.alignment = .centerY
        let historyCaptions = vertical([historyTitleRow, historySubtitleLabel], spacing: 2)
        historyCaptions.alignment = .leading
        historyCaptions.setContentHuggingPriority(.defaultLow, for: .horizontal)
        historyCaptions.setContentCompressionResistancePriority(textCompressionPriority, for: .horizontal)
        let historyRight = horizontal([historySizeLabel, historyLogsSwitch], spacing: 10)
        historyRight.alignment = .centerY
        historyRight.setContentHuggingPriority(.required, for: .horizontal)
        historyRight.setContentCompressionResistancePriority(.required, for: .horizontal)
        let historyRow = horizontal([historyIcon, historyCaptions, Self.elasticSpacer(), historyRight], spacing: 11)
        historyRow.alignment = .centerY

        let scopeDivider = divider()
        scopeStack.orientation = .vertical
        scopeStack.alignment = .leading
        scopeStack.spacing = 11
        for rowView in [runtimeRow, scopeDivider, historyRow] {
            scopeStack.addArrangedSubview(rowView)
            fillWidth(rowView, in: scopeStack)
        }
        let scopeCard = group([scopeStack], inset: 14)
        scopeCard.cornerRadius = Design.Radius.card

        // 3. Safety & Single-Click Undo Footer Card (0pt horizontal trigger wrapper preserves full width budget)
        let recoveryTextCol = vertical([recoveryTitleLabel, recoverySubtitleLabel], spacing: 2)
        recoveryTextCol.alignment = .leading
        recoveryTextCol.setContentHuggingPriority(.defaultLow, for: .horizontal)
        recoveryTextCol.setContentCompressionResistancePriority(textCompressionPriority, for: .horizontal)

        let recoveryLeadRow = horizontal([recoveryIconBox, recoveryTextCol], spacing: 11)
        recoveryLeadRow.alignment = .centerY
        recoveryTriggerView = MaintenanceInteractiveGroup(
            content: recoveryLeadRow,
            accessibilityLabel: L10n.t("maintenance.popover.protected_a11y")
        )
        recoveryTriggerView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        recoveryTriggerView.setContentCompressionResistancePriority(textCompressionPriority, for: .horizontal)

        let recoveryActions = horizontal([restoreLatestButton, openTrashButton], spacing: 8)
        recoveryActions.detachesHiddenViews = true
        recoveryActions.alignment = .centerY
        recoveryActions.setContentHuggingPriority(.required, for: .horizontal)
        recoveryActions.setContentCompressionResistancePriority(.required, for: .horizontal)

        let recoveryRow = horizontal([recoveryTriggerView, Self.elasticSpacer(), recoveryActions], spacing: 11)
        recoveryRow.alignment = .centerY
        let recoveryCard = group([recoveryRow], inset: 12)
        recoveryCard.cornerRadius = Design.Radius.card

        let rootStack = vertical([headerRow, heroCard, scopeCard, recoveryCard], spacing: 10)
        rootStack.setCustomSpacing(12, after: headerRow)
        for child in rootStack.arrangedSubviews {
            fillWidth(child, in: rootStack)
        }

        let container = NSView()
        container.addSubview(rootStack)
        rootStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            rootStack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 22),
            rootStack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -22),
            rootStack.topAnchor.constraint(equalTo: container.topAnchor, constant: 16),
            rootStack.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor, constant: -12)
        ])

        feedbackLabel.isHidden = true
        view = container
        super.init()

        scanButton.target = self
        clearButton.target = self
        runtimeInfoButton.target = self
        historyInfoButton.target = self
        runtimeCacheSwitch.target = self
        runtimeCacheSwitch.action = #selector(runtimeScopeToggled)
        historyLogsSwitch.target = self
        historyLogsSwitch.action = #selector(historyScopeToggled)
        retentionPopup.target = self
        retentionPopup.action = #selector(retentionWindowChanged)
        restoreLatestButton.target = self
        openTrashButton.target = self

        legendRuntimeTrigger.onActivate = { [weak self] anchor in
            self?.toggleDetailPopover(.runtime, relativeTo: anchor, preferredEdge: .maxY)
        }
        legendHistoryTrigger.onActivate = { [weak self] anchor in
            self?.toggleDetailPopover(.history, relativeTo: anchor, preferredEdge: .maxY)
        }
        legendProtectedTrigger.onActivate = { [weak self] anchor in
            self?.toggleDetailPopover(.protected, relativeTo: anchor, preferredEdge: .maxY)
        }
        recoveryTriggerView.onActivate = { [weak self] anchor in
            guard let self else { return }
            let targetKind: DetailKind = (self.latestUndoSnapshot != nil || !self.snapshots.isEmpty) ? .snapshot : .protected
            self.toggleDetailPopover(targetKind, relativeTo: anchor, preferredEdge: .minY)
        }

        languageObserver = NotificationCenter.default.addObserver(
            forName: L10n.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.dismissDetailPopover()
            self?.syncLocalizedTriggerLabels()
        }

        Design.applyControls(view)
        Self.stripTooltipsRecursively(view)
    }

    deinit {
        if let languageObserver {
            NotificationCenter.default.removeObserver(languageObserver)
        }
    }

    private static func stripTooltipsRecursively(_ root: NSView) {
        root.toolTip = nil
        for sub in root.subviews {
            stripTooltipsRecursively(sub)
        }
    }

    private func syncLocalizedTriggerLabels() {
        runtimeInfoButton.setAccessibilityLabel(L10n.t("maintenance.popover.runtime_a11y"))
        historyInfoButton.setAccessibilityLabel(L10n.t("maintenance.popover.history_a11y"))
        legendRuntimeTrigger.setAccessibilityLabel(L10n.t("maintenance.popover.runtime_a11y"))
        legendHistoryTrigger.setAccessibilityLabel(L10n.t("maintenance.popover.history_a11y"))
        legendProtectedTrigger.setAccessibilityLabel(L10n.t("maintenance.popover.protected_a11y"))
        let hasSnap = (latestUndoSnapshot != nil || !snapshots.isEmpty)
        recoveryTriggerView.setAccessibilityLabel(
            L10n.t(hasSnap ? "maintenance.popover.snapshot_a11y" : "maintenance.popover.protected_a11y")
        )
    }

    // MARK: - Stage 1 & Stage 3 Non-Intrusive NSPopover Disclosure
    @objc func runtimeInfoPressed(_ sender: NSView) {
        toggleDetailPopover(.runtime, relativeTo: sender, preferredEdge: .maxY)
    }

    @objc func historyInfoPressed(_ sender: NSView) {
        toggleDetailPopover(.history, relativeTo: sender, preferredEdge: .maxY)
    }

    func toggleDetailPopover(_ kind: DetailKind, relativeTo anchor: NSView, preferredEdge: NSRectEdge = .maxY) {
        if activePopoverKind == kind, detailPopover != nil {
            dismissDetailPopover()
            return
        }
        openDetailPopover(kind, relativeTo: anchor, preferredEdge: preferredEdge)
    }

    func openDetailPopover(_ kind: DetailKind, relativeTo anchor: NSView, preferredEdge: NSRectEdge = .maxY) {
        dismissDetailPopover()
        let contentView = makeDetailPopoverContentView(for: kind)
        Design.applyControls(contentView)
        Self.stripTooltipsRecursively(contentView)
        contentView.layoutSubtreeIfNeeded()

        let vc = NSViewController()
        vc.view = contentView

        let pop = NSPopover()
        pop.contentViewController = vc
        pop.behavior = .transient
        pop.animates = Design.shouldAnimate(in: anchor)
        pop.delegate = self

        detailPopover = pop
        activePopoverKind = kind
        syncPopoverActiveStates()

        if let hostWindow = anchor.window,
           hostWindow.isVisible,
           anchor.bounds.width > 0,
           anchor.bounds.height > 0 {
            pop.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: preferredEdge)
        }
    }

    func dismissDetailPopover() {
        let existing = detailPopover
        detailPopover = nil
        activePopoverKind = nil
        syncPopoverActiveStates()
        if let existing, existing.isShown {
            existing.performClose(nil)
        }
    }

    func popoverDidClose(_ notification: Notification) {
        guard let closed = notification.object as? NSPopover, closed === detailPopover else { return }
        detailPopover = nil
        activePopoverKind = nil
        syncPopoverActiveStates()
    }

    private func syncPopoverActiveStates() {
        runtimeInfoButton.isActivePopover = (activePopoverKind == .runtime)
        historyInfoButton.isActivePopover = (activePopoverKind == .history)
        legendRuntimeTrigger.isActivePopover = (activePopoverKind == .runtime)
        legendHistoryTrigger.isActivePopover = (activePopoverKind == .history)
        legendProtectedTrigger.isActivePopover = (activePopoverKind == .protected)
        recoveryTriggerView.isActivePopover = (activePopoverKind == .snapshot)
    }

    private static func containsCJK(_ value: String) -> Bool {
        value.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) != nil
    }

    private func formatCount(_ count: Int) -> String {
        let fmt = NumberFormatter()
        fmt.numberStyle = .decimal
        fmt.locale = L10n.shared.foundationLocale
        return fmt.string(from: NSNumber(value: max(0, count))) ?? "\(max(0, count))"
    }

    private func localizedRetentionWindowTitle() -> String {
        Self.retentionChoices.first(where: { $0.days == selectedRetentionDays })?.title
            ?? L10n.t("maintenance.simple.retention_7d")
    }

    private func localizedDynamicWindowDesc() -> String {
        selectedRetentionDays > 0
            ? L10n.t("maintenance.window.days_ago", ["days": selectedRetentionDays])
            : L10n.t("maintenance.window.inactive")
    }

    private func localizedCatalogEntry(_ item: [String: Any]) -> (title: String, subtitle: String, icon: String) {
        let rawName = (item["name"] as? String) ?? ""
        let rawTitle = (item["title"] as? String) ?? ""
        let rawSub = (item["subtitle"] as? String) ?? ""
        let rawIcon = (item["icon"] as? String) ?? ""
        let spec = Self.catalogSpecByName[rawName]
        let icon = !rawIcon.isEmpty ? rawIcon : (spec?.icon ?? "folder")
        let needsEnglishOverride = L10n.shared.isEnglish

        let resolvedTitle: String
        if !rawTitle.isEmpty && !(needsEnglishOverride && Self.containsCJK(rawTitle)) {
            resolvedTitle = rawTitle
        } else if let prefix = spec?.prefix {
            resolvedTitle = L10n.t("\(prefix).title", fallback: rawName)
        } else {
            resolvedTitle = rawName
        }

        let resolvedSub: String
        if !rawSub.isEmpty && !(needsEnglishOverride && Self.containsCJK(rawSub)) {
            resolvedSub = rawSub
        } else if rawName == "AgentSubagentDatabases" {
            let subCount = historyBucketSubagentCount > 0 ? historyBucketSubagentCount : max(1, intVal(item, "fileCount"))
            resolvedSub = L10n.t("maintenance.dynamic.subagent_sub", ["windowDesc": localizedDynamicWindowDesc(), "count": subCount])
        } else if rawName == "AgentTaskStepLogs" {
            resolvedSub = L10n.t("maintenance.dynamic.task_step_sub", ["windowDesc": localizedDynamicWindowDesc()])
        } else if rawName == "AgentVerboseTranscripts" {
            resolvedSub = L10n.t("maintenance.dynamic.verbose_sub", ["windowDesc": localizedDynamicWindowDesc()])
        } else if let prefix = spec?.prefix {
            resolvedSub = L10n.t("\(prefix).sub", fallback: L10n.t("maintenance.catalog.default.sub", ["name": rawName]))
        } else {
            resolvedSub = L10n.t("maintenance.catalog.default.sub", ["name": rawName])
        }

        return (resolvedTitle, resolvedSub, icon)
    }

    private func localizedProtectedEntry(_ item: [String: Any]) -> (title: String, subtitle: String, icon: String) {
        let rawId = (item["id"] as? String) ?? "workspace"
        let rawTitle = (item["title"] as? String) ?? ""
        let rawSub = (item["subtitle"] as? String) ?? ""
        let rawIcon = (item["icon"] as? String) ?? ""
        let defaultIcon: String
        switch rawId {
        case "conversations": defaultIcon = "bubble.left.and.bubble.right"
        case "gravitybox": defaultIcon = "lock.shield"
        default: defaultIcon = "folder.badge.gearshape"
        }
        let icon = !rawIcon.isEmpty ? rawIcon : defaultIcon
        let needsEnglishOverride = L10n.shared.isEnglish

        let titleKey = "maintenance.protected.\(rawId).title"
        let subKey = "maintenance.protected.\(rawId).sub"
        let resolvedTitle = (!rawTitle.isEmpty && !(needsEnglishOverride && Self.containsCJK(rawTitle)))
            ? rawTitle
            : L10n.t(titleKey, fallback: L10n.t("maintenance.protected.workspace.title"))
        let resolvedSub = (!rawSub.isEmpty && !(needsEnglishOverride && Self.containsCJK(rawSub)))
            ? rawSub
            : L10n.t(subKey, fallback: L10n.t("maintenance.protected.workspace.sub"))
        return (resolvedTitle, resolvedSub, icon)
    }

    private func effectiveProtectedEntries() -> [[String: Any]] {
        if !protectedEntries.isEmpty {
            return protectedEntries
        }
        return [
            ["id": "workspace", "icon": "folder.badge.gearshape", "bytes": 0],
            ["id": "conversations", "icon": "bubble.left.and.bubble.right", "bytes": 0]
        ]
    }

    private func localizedSnapshotItemTitles(_ snap: [String: Any]) -> [String] {
        let rawNames = (snap["items"] as? [String]) ?? []
        let rawTitles = (snap["itemTitles"] as? [String]) ?? []
        let needsEnglishOverride = L10n.shared.isEnglish
        if !rawTitles.isEmpty && !(needsEnglishOverride && rawTitles.contains(where: Self.containsCJK)) {
            return rawTitles
        }
        if !rawNames.isEmpty {
            return rawNames.map { name in
                if let prefix = Self.catalogSpecByName[name]?.prefix {
                    return L10n.t("\(prefix).title", fallback: name)
                }
                return name
            }
        }
        return rawTitles.filter { !(needsEnglishOverride && Self.containsCJK($0)) }
    }

    func makeDetailPopoverContentView(for kind: DetailKind) -> NSView {
        let headerIcon: String
        let headerTint: NSColor
        let headerTitle: String
        let headerSubtitle: String
        var headerPill: PillBadge?
        var bodyRows: [NSView] = []
        let footerNote: String
        let footerIcon: String

        switch kind {
        case .runtime:
            headerIcon = "sparkles"
            headerTint = Design.blue
            headerTitle = L10n.t("maintenance.popover.runtime.title")
            headerSubtitle = L10n.t("maintenance.popover.runtime.subtitle")
            footerNote = L10n.t("maintenance.popover.runtime.footer")
            footerIcon = "arrow.uturn.backward.circle"

            let runtimeItems = entries
                .filter { !isStatefulItem($0) && ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
                .sorted { intVal($0, "bytes") > intVal($1, "bytes") }
            let totalFiles = runtimeBucketFileCount > 0
                ? runtimeBucketFileCount
                : runtimeItems.reduce(0) { $0 + intVal($1, "fileCount") }
            if runtimeBucketBytes > 0 {
                headerPill = pillBadge(formatBytes(runtimeBucketBytes), color: Design.blue)
            }

            if runtimeItems.isEmpty {
                bodyRows.append(makePopoverEmptyRow(L10n.t("maintenance.popover.runtime.empty")))
            } else {
                let visibleLimit = 5
                for item in runtimeItems.prefix(visibleLimit) {
                    let meta = localizedCatalogEntry(item)
                    let bytes = Int64(intVal(item, "bytes"))
                    let files = intVal(item, "fileCount")
                    bodyRows.append(makePopoverEntryRow(
                        icon: meta.icon,
                        tint: Design.blue,
                        title: meta.title,
                        subtitle: meta.subtitle,
                        trailingPrimary: formatBytes(bytes),
                        trailingSecondary: files > 0 ? L10n.t("maintenance.popover.files_count", ["count": formatCount(files)]) : nil
                    ))
                }
                if runtimeItems.count > visibleLimit {
                    let extraItems = runtimeItems.dropFirst(visibleLimit)
                    let extraBytes = extraItems.reduce(Int64(0)) { $0 + Int64(intVal($1, "bytes")) }
                    let extraFiles = extraItems.reduce(0) { $0 + intVal($1, "fileCount") }
                    bodyRows.append(makePopoverEntryRow(
                        icon: "ellipsis.circle",
                        tint: Design.secondary,
                        title: L10n.t("maintenance.popover.more_items", ["count": extraItems.count]),
                        subtitle: "",
                        trailingPrimary: formatBytes(extraBytes),
                        trailingSecondary: extraFiles > 0 ? L10n.t("maintenance.popover.files_count", ["count": formatCount(extraFiles)]) : nil
                    ))
                }
                if totalFiles > 0 {
                    let summaryText = L10n.t("maintenance.popover.total_summary", [
                        "items": runtimeItems.count,
                        "files": formatCount(totalFiles)
                    ])
                    let sumLbl = text(summaryText, size: 10.5, weight: .medium, color: Design.secondary)
                    sumLbl.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
                    bodyRows.append(sumLbl)
                }
            }

        case .history:
            let amberTint = Design.color(0xD97706, 0xFBBF24)
            let winTitle = localizedRetentionWindowTitle()
            headerIcon = "clock.arrow.circlepath"
            headerTint = amberTint
            headerTitle = L10n.t("maintenance.popover.history.title", ["window": winTitle])
            headerSubtitle = L10n.t("maintenance.popover.history.subtitle")
            footerNote = L10n.t("maintenance.popover.history.footer")
            footerIcon = "checkmark.shield"

            let historyItems = entries
                .filter { isStatefulItem($0) && ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
                .sorted { intVal($0, "bytes") > intVal($1, "bytes") }
            let totalFiles = historyBucketFileCount > 0
                ? historyBucketFileCount
                : historyItems.reduce(0) { $0 + intVal($1, "fileCount") }
            if historyBucketBytes > 0 {
                headerPill = pillBadge(formatBytes(historyBucketBytes), color: amberTint)
            }

            if historyItems.isEmpty {
                bodyRows.append(makePopoverEmptyRow(L10n.t("maintenance.popover.history.empty", ["window": winTitle])))
            } else {
                for item in historyItems {
                    let meta = localizedCatalogEntry(item)
                    let bytes = Int64(intVal(item, "bytes"))
                    let files = intVal(item, "fileCount")
                    bodyRows.append(makePopoverEntryRow(
                        icon: meta.icon,
                        tint: amberTint,
                        title: meta.title,
                        subtitle: meta.subtitle,
                        trailingPrimary: formatBytes(bytes),
                        trailingSecondary: files > 0 ? L10n.t("maintenance.popover.files_count", ["count": formatCount(files)]) : nil
                    ))
                }
                if totalFiles > 0 {
                    let summaryText = L10n.t("maintenance.popover.total_summary", [
                        "items": historyItems.count,
                        "files": formatCount(totalFiles)
                    ])
                    let sumLbl = text(summaryText, size: 10.5, weight: .medium, color: Design.secondary)
                    sumLbl.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
                    bodyRows.append(sumLbl)
                }
            }

        case .protected:
            headerIcon = "checkmark.shield"
            headerTint = .systemGreen
            headerTitle = L10n.t("maintenance.popover.protected.title")
            headerSubtitle = L10n.t("maintenance.popover.protected.subtitle")
            headerPill = pillBadge(L10n.t("maintenance.popover.protected.badge"), color: .systemGreen)
            footerNote = L10n.t("maintenance.popover.protected.footer")
            footerIcon = "lock.shield"

            for prot in effectiveProtectedEntries() {
                let meta = localizedProtectedEntry(prot)
                let bytes = Int64(intVal(prot, "bytes"))
                let files = intVal(prot, "fileCount")
                bodyRows.append(makePopoverEntryRow(
                    icon: meta.icon,
                    tint: .systemGreen,
                    title: meta.title,
                    subtitle: meta.subtitle,
                    trailingPrimary: bytes > 0 ? formatBytes(bytes) : nil,
                    trailingSecondary: files > 0 ? L10n.t("maintenance.popover.files_count", ["count": formatCount(files)]) : nil,
                    wrapSubtitle: true
                ))
            }

        case .snapshot:
            headerIcon = "arrow.uturn.backward.circle"
            headerTint = Design.blue
            headerTitle = L10n.t("maintenance.popover.snapshot.title")
            footerNote = L10n.t("maintenance.popover.snapshot.footer")
            footerIcon = "doc.badge.gearshape"

            if let snap = latestUndoSnapshot ?? snapshots.first {
                let snapId = (snap["id"] as? String) ?? ""
                let fullSnap = snapshots.first(where: { ($0["id"] as? String) == snapId }) ?? snap
                let bytes = Int64(intVal(fullSnap, "totalBytes", fallback: intVal(snap, "totalBytes")))
                let files = max(1, intVal(fullSnap, "fileCount", fallback: intVal(snap, "fileCount", fallback: 1)))
                let ts = intVal(fullSnap, "timestamp", fallback: intVal(snap, "timestamp"))
                let timeStr = ts > 0
                    ? Self.snapshotDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
                    : L10n.t("maintenance.recovery.recent")
                let sizeStr = bytes > 0 ? formatBytes(bytes) : L10n.t("maintenance.recovery.items_count", ["count": 1])
                headerSubtitle = L10n.t("maintenance.popover.snapshot.subtitle", [
                    "time": timeStr,
                    "files": formatCount(files),
                    "size": sizeStr
                ])
                if bytes > 0 {
                    headerPill = pillBadge(sizeStr, color: Design.blue)
                }
                let itemTitles = localizedSnapshotItemTitles(fullSnap)
                if itemTitles.isEmpty {
                    bodyRows.append(makePopoverEntryRow(
                        icon: "checkmark.circle",
                        tint: Design.blue,
                        title: L10n.t("maintenance.recovery.items_count", ["count": max(1, intVal(fullSnap, "movedCount", fallback: 1))]),
                        subtitle: "",
                        trailingPrimary: nil,
                        trailingSecondary: nil
                    ))
                } else {
                    for titleStr in itemTitles.prefix(6) {
                        bodyRows.append(makePopoverEntryRow(
                            icon: "checkmark.circle",
                            tint: Design.blue,
                            title: titleStr,
                            subtitle: "",
                            trailingPrimary: nil,
                            trailingSecondary: nil
                        ))
                    }
                }
            } else {
                headerSubtitle = L10n.t("maintenance.simple.safety_idle_sub")
                bodyRows.append(makePopoverEmptyRow(L10n.t("maintenance.popover.snapshot.empty")))
            }
        }

        let badgeIcon = iconBadge(headerIcon, tint: headerTint, size: 24)
        let titleLbl = text(headerTitle, size: 13, weight: .semibold, color: .labelColor)
        titleLbl.lineBreakMode = .byTruncatingTail
        var topItems: [NSView] = [badgeIcon, titleLbl, Self.elasticSpacer()]
        if let headerPill {
            headerPill.setContentHuggingPriority(.required, for: .horizontal)
            headerPill.setContentCompressionResistancePriority(.required, for: .horizontal)
            topItems.append(headerPill)
        }
        let headerTopRow = horizontal(topItems, spacing: 8)
        headerTopRow.alignment = .centerY

        let subLbl = text(headerSubtitle, size: 11, color: Design.secondary, wrap: true)
        let headerStack = vertical([headerTopRow, subLbl], spacing: 5)
        fillWidth(headerTopRow, in: headerStack)
        fillWidth(subLbl, in: headerStack)

        let rowsStack = vertical(bodyRows, spacing: 8)
        for row in bodyRows {
            fillWidth(row, in: rowsStack)
        }

        let fIcon = symbol(footerIcon, size: 11, color: Design.secondary)
        fIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .medium)
        fIcon.setContentHuggingPriority(.required, for: .horizontal)
        fIcon.setContentCompressionResistancePriority(.required, for: .horizontal)
        let fText = text(footerNote, size: 10.5, color: Design.secondary, wrap: true)
        let footerRow = horizontal([fIcon, fText], spacing: 6)
        footerRow.alignment = .top

        let contentStack = vertical([headerStack, divider(), rowsStack, divider(), footerRow], spacing: 10)
        for section in contentStack.arrangedSubviews {
            fillWidth(section, in: contentStack)
        }

        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(contentStack)
        pin(contentStack, to: container, inset: 14)
        container.widthAnchor.constraint(equalToConstant: Self.popoverWidth).isActive = true
        return container
    }

    private func makePopoverEmptyRow(_ message: String) -> NSView {
        let lbl = text(message, size: 11.5, color: Design.secondary, wrap: true)
        return lbl
    }

    private func makePopoverEntryRow(
        icon: String,
        tint: NSColor,
        title: String,
        subtitle: String,
        trailingPrimary: String?,
        trailingSecondary: String?,
        wrapSubtitle: Bool = false
    ) -> NSView {
        let rowIcon = symbol(icon, size: 12, color: tint)
        rowIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
        rowIcon.setContentHuggingPriority(.required, for: .horizontal)
        rowIcon.setContentCompressionResistancePriority(.required, for: .horizontal)

        let titleLbl = text(title, size: 12, weight: .medium, color: .labelColor)
        titleLbl.lineBreakMode = .byTruncatingTail
        var textItems: [NSView] = [titleLbl]
        if !subtitle.isEmpty {
            let subLbl = text(subtitle, size: 10.5, color: Design.secondary, wrap: wrapSubtitle)
            if wrapSubtitle {
                subLbl.maximumNumberOfLines = 2
            } else {
                subLbl.maximumNumberOfLines = 1
                subLbl.lineBreakMode = .byTruncatingTail
            }
            textItems.append(subLbl)
        }
        let leftCaptions = vertical(textItems, spacing: 1.5)
        leftCaptions.alignment = .leading
        leftCaptions.setContentHuggingPriority(.defaultLow, for: .horizontal)
        leftCaptions.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(720), for: .horizontal)
        for item in textItems {
            fillWidth(item, in: leftCaptions)
        }

        var rowViews: [NSView] = [rowIcon, leftCaptions, Self.elasticSpacer()]
        if trailingPrimary != nil || trailingSecondary != nil {
            var rightItems: [NSView] = []
            if let primary = trailingPrimary, !primary.isEmpty {
                let pLbl = text(primary, size: 11.5, weight: .semibold, color: .labelColor)
                pLbl.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .semibold)
                pLbl.alignment = .right
                pLbl.setContentHuggingPriority(.required, for: .horizontal)
                pLbl.setContentCompressionResistancePriority(.required, for: .horizontal)
                rightItems.append(pLbl)
            }
            if let secondary = trailingSecondary, !secondary.isEmpty {
                let sLbl = text(secondary, size: 10, color: Design.secondary)
                sLbl.font = .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
                sLbl.alignment = .right
                sLbl.setContentHuggingPriority(.required, for: .horizontal)
                sLbl.setContentCompressionResistancePriority(.required, for: .horizontal)
                rightItems.append(sLbl)
            }
            let rightCol = vertical(rightItems, spacing: 1)
            rightCol.alignment = .trailing
            rightCol.setContentHuggingPriority(.required, for: .horizontal)
            rightCol.setContentCompressionResistancePriority(.required, for: .horizontal)
            rowViews.append(rightCol)
        }

        let row = horizontal(rowViews, spacing: 8)
        row.alignment = subtitle.isEmpty ? .centerY : .top
        return row
    }

    // MARK: - Stage 2 Dynamic Running-Cleanup Scope Summary
    func buildRunningClearConfirmationBody() -> String {
        var activeItemCount = 0
        var activeFileCount = 0

        if runtimeCacheEnabled && runtimeBucketBytes > 0 {
            let rtEntries = entries.filter { !isStatefulItem($0) && ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
            activeItemCount += max(1, rtEntries.count)
            let rtFiles = runtimeBucketFileCount > 0
                ? runtimeBucketFileCount
                : rtEntries.reduce(0) { $0 + intVal($1, "fileCount") }
            activeFileCount += rtFiles
        }
        if historyLogsEnabled && historyBucketBytes > 0 {
            let histEntries = entries.filter { isStatefulItem($0) && ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
            activeItemCount += max(1, histEntries.count)
            let histFiles = historyBucketFileCount > 0
                ? historyBucketFileCount
                : histEntries.reduce(0) { $0 + intVal($1, "fileCount") }
            activeFileCount += histFiles
        }

        let targetBytes = selectedReclaimableBytes
        guard activeItemCount > 0, activeFileCount > 0, targetBytes > 0 else {
            return L10n.t("maintenance.simple.confirm_running_body")
        }
        return L10n.t("maintenance.simple.confirm_running_detail", [
            "items": activeItemCount,
            "files": formatCount(activeFileCount),
            "size": formatBytes(targetBytes)
        ])
    }

    private static func makeLegendDot(color: NSColor) -> NSBox {
        let dot = NSBox()
        dot.boxType = .custom
        dot.cornerRadius = 3.5
        dot.borderWidth = 0
        dot.fillColor = color
        dot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 7),
            dot.heightAnchor.constraint(equalToConstant: 7)
        ])
        return dot
    }

    private static func makeIconBadge(symbolName: String, tint: NSColor) -> NSBox {
        let (box, _) = makeDynamicIconBadge(symbolName: symbolName, tint: tint)
        return box
    }

    private static func makeDynamicIconBadge(symbolName: String, tint: NSColor) -> (NSBox, NSImageView) {
        let box = tintedIconBox(size: 28, cornerRadius: 7.5, tint: tint, neutral: false)
        let iconView = symbol(symbolName, size: 13.5, color: tint)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13.5, weight: .medium)
        box.addSubview(iconView)
        NSLayoutConstraint.activate([
            iconView.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: box.centerYAnchor)
        ])
        return (box, iconView)
    }

    private func applyRecoveryBadgeTheme(symbolName: String, tint: NSColor) {
        recoveryIconBox.fillColor = NSColor(name: nil) { app in
            let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return tint.withAlphaComponent(isDark ? 0.18 : 0.10)
        }
        recoveryIconBox.borderColor = NSColor(name: nil) { app in
            let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return tint.withAlphaComponent(isDark ? 0.32 : 0.18)
        }
        recoveryIconView.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        recoveryIconView.contentTintColor = tint
    }

    private func formatBytes(_ bytes: Int64) -> String {
        if bytes <= 0 { return "0 B" }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    func update(force: Bool = false) {
        guard !busy else { return }
        let expired = Date().timeIntervalSince(lastFetchTime) >= 60.0
        if !force && !expired && hasCompletedScan { return }
        fetch(force: force)
    }

    @objc func scanNow() {
        guard !busy else { return }
        dismissDetailPopover()
        feedbackLabel.isHidden = true
        fetch(force: true)
    }

    private func setBusy(_ isBusy: Bool) {
        busy = isBusy
        scanButton.setBusy(isBusy, available: app.reachable)
        retentionPopup.isEnabled = !isBusy && app.reachable
        restoreLatestButton.isEnabled = !isBusy
        if isBusy {
            clearButton.isEnabled = false
            runtimeCacheSwitch.isEnabled = false
            historyLogsSwitch.isEnabled = false
        } else {
            updateSummaryAndControls()
            if app.pendingLocalizedRebuildAfterMaintenance && app.preferencesController?.maintenanceSheet == nil {
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.busy,
                          self.app.pendingLocalizedRebuildAfterMaintenance,
                          self.app.preferencesController?.maintenanceSheet == nil else { return }
                    self.app.pendingLocalizedRebuildAfterMaintenance = false
                    self.app.cachePage = nil
                    self.app.preferencesController = nil
                    if self.app.currentPage == 3 {
                        self.app.navigate(3, force: true)
                    }
                }
            }
        }
    }

    func fetch(force: Bool = false) {
        if !force && Date().timeIntervalSince(lastFetchTime) < 3.0 && hasCompletedScan {
            return
        }
        guard app.reachable, !busy else {
            if !app.reachable {
                if !hasCompletedScan {
                    reclaimableValueLabel.stringValue = "—"
                    clearButton.isEnabled = false
                    runtimeCacheSwitch.isEnabled = false
                    historyLogsSwitch.isEnabled = false
                }
                retentionPopup.isEnabled = false
                heroSubtitleLabel.stringValue = L10n.t("maintenance.hero.waiting_service")
                heroSubtitleLabel.textColor = Design.secondary
                scanButton.setBusy(false, available: false)
            }
            return
        }
        setBusy(true)
        if !hasCompletedScan {
            reclaimableValueLabel.stringValue = L10n.t("maintenance.hero.scanning")
            heroSubtitleLabel.stringValue = L10n.t("maintenance.simple.hero_subtitle")
            heroSubtitleLabel.textColor = Design.secondary
            clearButton.isEnabled = false
        }
        app.bridge.send(["command": "maintenance_scan", "retentionDays": selectedRetentionDays]) { [weak self] response in
            guard let self else { return }
            self.setBusy(false)
            self.lastFetchTime = Date()
            switch response {
            case .failure(let error):
                if !self.hasCompletedScan {
                    self.reclaimableValueLabel.stringValue = L10n.t("maintenance.hero.scan_failed")
                }
                self.heroSubtitleLabel.stringValue = error.localizedDescription
                self.heroSubtitleLabel.textColor = accessibleWarningColor()
                self.clearButton.isEnabled = false
            case .success(let value):
                self.applyScanPayload(value)
                self.app.preferencesController?.applyStorageScanPayload(value)
            }
        }
    }

    @objc func retentionWindowChanged() {
        guard !busy else {
            if let matchIdx = Self.retentionChoices.firstIndex(where: { $0.days == selectedRetentionDays }) {
                retentionPopup.selectItem(at: matchIdx)
            }
            return
        }
        let idx = max(0, min(Self.retentionChoices.count - 1, retentionPopup.indexOfSelectedItem))
        let nextDays = Self.retentionChoices[idx].days
        guard nextDays != selectedRetentionDays else { return }
        dismissDetailPopover()
        selectedRetentionDays = nextDays
        feedbackLabel.isHidden = true
        fetch(force: true)
    }

    @objc func runtimeScopeToggled() {
        guard !busy else { return }
        userToggledRuntimeSwitch = true
        runtimeCacheEnabled = (runtimeCacheSwitch.state == .on) && runtimeBucketBytes > 0
        updateSummaryAndControls()
    }

    @objc func historyScopeToggled() {
        guard !busy else { return }
        userToggledHistorySwitch = true
        historyLogsEnabled = (historyLogsSwitch.state == .on) && historyBucketBytes > 0
        updateSummaryAndControls()
    }

    private func isStatefulItem(_ item: [String: Any]) -> Bool {
        if let cat = item["category"] as? String {
            return cat == "stateful"
        }
        let name = item["name"] as? String ?? ""
        return ["AgentTaskStepLogs", "AgentVerboseTranscripts", "AgentSubagentDatabases"].contains(name)
    }

    func applyScanPayload(_ value: [String: Any]) {
        scanToken = value["token"] as? String ?? ""
        appRunning = value["running"] as? Bool == true
        browserBusy = value["browserBusy"] as? Bool == true
        if let dir = value["trashDir"] as? String, !dir.isEmpty {
            activeTrashPath = dir
        }
        usingFallbackTrash = value["usingFallbackTrash"] as? Bool == true

        if value["retentionDays"] != nil {
            let returnedDays = intVal(value, "retentionDays", fallback: selectedRetentionDays)
            if let matchIdx = Self.retentionChoices.firstIndex(where: { $0.days == returnedDays }) {
                selectedRetentionDays = returnedDays
                if retentionPopup.indexOfSelectedItem != matchIdx {
                    retentionPopup.selectItem(at: matchIdx)
                }
            }
        }
        scannedAt = intVal(value, "scannedAt", fallback: Int(Date().timeIntervalSince1970))
        entries = value["entries"] as? [[String: Any]] ?? []

        let clearableRuntimeEntries = entries.filter { !isStatefulItem($0) && ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
        let clearableHistoryEntries = entries.filter { isStatefulItem($0) && ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
        let fallbackRuntimeBytes = clearableRuntimeEntries.reduce(Int64(0)) { $0 + Int64(intVal($1, "bytes")) }
        let fallbackHistoryBytes = clearableHistoryEntries.reduce(Int64(0)) { $0 + Int64(intVal($1, "bytes")) }
        let fallbackRuntimeFiles = clearableRuntimeEntries.reduce(0) { $0 + intVal($1, "fileCount") }
        let fallbackHistoryFiles = clearableHistoryEntries.reduce(0) { $0 + intVal($1, "fileCount") }

        if let buckets = value["buckets"] as? [String: Any] {
            let rtBucket = buckets["runtimeCache"] as? [String: Any] ?? [:]
            let histBucket = buckets["historyLogs"] as? [String: Any] ?? [:]
            runtimeBucketBytes = Int64(intVal(rtBucket, "clearableBytes", fallback: Int(fallbackRuntimeBytes)))
            historyBucketBytes = Int64(intVal(histBucket, "clearableBytes", fallback: Int(fallbackHistoryBytes)))
            runtimeBucketFileCount = intVal(rtBucket, "fileCount", fallback: fallbackRuntimeFiles)
            historyBucketFileCount = intVal(histBucket, "fileCount", fallback: fallbackHistoryFiles)
            historyBucketSubagentCount = intVal(histBucket, "subagentCount")
        } else {
            runtimeBucketBytes = entries.isEmpty ? Int64(intVal(value, "safeBytes")) : fallbackRuntimeBytes
            historyBucketBytes = entries.isEmpty ? Int64(intVal(value, "statefulBytes")) : fallbackHistoryBytes
            runtimeBucketFileCount = fallbackRuntimeFiles
            historyBucketFileCount = fallbackHistoryFiles
            historyBucketSubagentCount = 0
        }

        safeCacheBytes = runtimeBucketBytes
        statefulCacheBytes = historyBucketBytes

        let rawProtected = value["protectedEntries"] as? [[String: Any]] ?? []
        protectedEntries = rawProtected
        totalProtectedBytes = Int64(intVal(value, "protectedBytes", fallback: rawProtected.reduce(0) { $0 + intVal($1, "bytes") }))

        snapshots = value["snapshots"] as? [[String: Any]] ?? []
        if let latest = value["latestRestorableSnapshot"] as? [String: Any],
           let id = latest["id"] as? String, !id.isEmpty {
            latestUndoSnapshot = latest
            latestRestorableSnapshotId = id
        } else if let firstRestorable = snapshots.first(where: { ($0["restorable"] as? Bool) == true && !(($0["id"] as? String) ?? "").isEmpty }) {
            latestUndoSnapshot = firstRestorable
            latestRestorableSnapshotId = (firstRestorable["id"] as? String) ?? ""
        } else {
            latestUndoSnapshot = nil
            latestRestorableSnapshotId = ""
        }

        if !userToggledRuntimeSwitch {
            runtimeCacheEnabled = runtimeBucketBytes > 0
        } else if runtimeBucketBytes <= 0 {
            runtimeCacheEnabled = false
        }
        if !userToggledHistorySwitch {
            historyLogsEnabled = false
        } else if historyBucketBytes <= 0 {
            historyLogsEnabled = false
        }

        hasCompletedScan = true
        renderAll()
    }

    private func updateSummaryAndControls() {
        let selectedBytes = selectedReclaimableBytes
        reclaimableTitleLabel.stringValue = L10n.t("maintenance.simple.hero_title")
        if hasCompletedScan {
            reclaimableValueLabel.stringValue = formatBytes(selectedBytes)
            heroSubtitleLabel.stringValue = L10n.t("maintenance.simple.hero_subtitle")
            heroSubtitleLabel.textColor = Design.secondary
        }

        compositionBar.safeBytes = runtimeBucketBytes
        compositionBar.statefulBytes = historyBucketBytes
        compositionBar.protectedBytes = totalProtectedBytes

        safeLegendLabel.stringValue = L10n.t("maintenance.simple.legend_runtime", ["size": formatBytes(runtimeBucketBytes)])
        statefulLegendLabel.stringValue = L10n.t("maintenance.simple.legend_history", ["size": formatBytes(historyBucketBytes)])
        protectedLegendLabel.stringValue = totalProtectedBytes > 0
            ? L10n.t("maintenance.simple.legend_protected", ["size": formatBytes(totalProtectedBytes)])
            : L10n.t("maintenance.simple.legend_protected_empty")

        // Row 1: App Runtime Caches
        let canToggleRuntime = runtimeBucketBytes > 0
        let runtimeActive = canToggleRuntime && runtimeCacheEnabled
        runtimeCacheSwitch.state = runtimeActive ? .on : .off
        runtimeCacheSwitch.isEnabled = !busy && canToggleRuntime
        runtimeSizeLabel.stringValue = formatBytes(runtimeBucketBytes)
        runtimeSizeLabel.textColor = runtimeActive ? .labelColor : Design.secondary
        runtimeSubtitleLabel.stringValue = L10n.t("maintenance.simple.scope_runtime_sub")

        // Row 2: Old Background Task Logs
        let canToggleHistory = historyBucketBytes > 0
        let historyActive = canToggleHistory && historyLogsEnabled
        historyLogsSwitch.state = historyActive ? .on : .off
        historyLogsSwitch.isEnabled = !busy && canToggleHistory
        historySizeLabel.stringValue = formatBytes(historyBucketBytes)
        historySizeLabel.textColor = historyActive ? .labelColor : Design.secondary
        historySubtitleLabel.stringValue = canToggleHistory
            ? L10n.t("maintenance.simple.scope_history_sub")
            : L10n.t("maintenance.simple.scope_history_empty")

        // Primary CTA Button
        let canClean = !busy && hasCompletedScan && selectedBytes > 0 && !selectedScopes.isEmpty
        clearButton.isEnabled = canClean
        let nextClearTitle = (!hasCompletedScan || selectedBytes > 0)
            ? L10n.t("maintenance.simple.btn_clean_now")
            : L10n.t("maintenance.simple.btn_nothing_to_clean")
        if clearButton.title != nextClearTitle {
            clearButton.title = nextClearTitle
            clearButton.invalidateIntrinsicContentSize()
        }
    }

    private func updateRecoveryFooter() {
        if let snap = latestUndoSnapshot, !latestRestorableSnapshotId.isEmpty {
            let bytes = Int64(intVal(snap, "totalBytes"))
            let ts = intVal(snap, "timestamp")
            let timeStr = ts > 0
                ? Self.snapshotDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
                : L10n.t("maintenance.recovery.recent")
            let sizeStr = bytes > 0 ? formatBytes(bytes) : L10n.t("maintenance.recovery.items_count", ["count": 1])
            applyRecoveryBadgeTheme(symbolName: "arrow.uturn.backward.circle", tint: Design.blue)
            recoveryTitleLabel.stringValue = L10n.t("maintenance.simple.undo_ready_title", ["size": sizeStr, "time": timeStr])
            recoverySubtitleLabel.stringValue = L10n.t("maintenance.simple.undo_ready_sub")
            restoreLatestButton.isHidden = false
            restoreLatestButton.isEnabled = !busy
        } else if let latestSnap = snapshots.first, latestSnap["restoredAt"] != nil {
            let ts = intVal(latestSnap, "timestamp")
            let timeStr = ts > 0
                ? Self.snapshotDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
                : L10n.t("maintenance.recovery.recent")
            applyRecoveryBadgeTheme(symbolName: "checkmark.shield", tint: .systemGreen)
            recoveryTitleLabel.stringValue = L10n.t("maintenance.simple.undo_done_title", ["time": timeStr])
            recoverySubtitleLabel.stringValue = L10n.t("maintenance.simple.safety_idle_sub")
            restoreLatestButton.isHidden = true
        } else {
            applyRecoveryBadgeTheme(symbolName: "checkmark.shield", tint: .systemGreen)
            recoveryTitleLabel.stringValue = L10n.t("maintenance.simple.safety_idle_title")
            recoverySubtitleLabel.stringValue = L10n.t("maintenance.simple.safety_idle_sub")
            restoreLatestButton.isHidden = true
        }
        recoveryTitleLabel.toolTip = nil
        recoverySubtitleLabel.toolTip = nil
        syncLocalizedTriggerLabels()
    }

    private func renderAll() {
        let state = PerformanceSignpost.begin("CacheRenderAll")
        defer { PerformanceSignpost.end("CacheRenderAll", state) }
        updateSummaryAndControls()
        updateRecoveryFooter()
    }

    @discardableResult
    func rotateSupersededSnapshotsToSystemTrash(_ paths: [String]) -> Int {
        let fm = FileManager.default
        var movedCount = 0
        for rawPath in paths where !rawPath.isEmpty {
            let url = URL(fileURLWithPath: rawPath)
            guard fm.fileExists(atPath: url.path) else { continue }
            do {
                try fm.trashItem(at: url, resultingItemURL: nil)
                movedCount += 1
            } catch {
                // Keep snapshot intact in local vault if Finder Trash XPC is unavailable
            }
        }
        return movedCount
    }

    @objc func openTrashFolder() {
        dismissDetailPopover()
        let fm = FileManager.default
        let activeSnap = latestUndoSnapshot ?? snapshots.first
        if let snapPath = activeSnap?["snapshotPath"] as? String,
           !snapPath.isEmpty,
           fm.fileExists(atPath: snapPath) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: snapPath)])
            return
        }
        if usingFallbackTrash, !activeTrashPath.isEmpty {
            try? fm.createDirectory(atPath: activeTrashPath, withIntermediateDirectories: true)
            if fm.fileExists(atPath: activeTrashPath) {
                NSWorkspace.shared.open(URL(fileURLWithPath: activeTrashPath))
                return
            }
        }
        let trashURL = fm.homeDirectoryForCurrentUser.appendingPathComponent(".Trash")
        NSWorkspace.shared.open(trashURL)
    }

    private func syncLiveRunningState() {
        #if !NATIVE_UI_TEST
        let liveRunning = Assistant.isAntigravityRunning()
        if appRunning != liveRunning {
            appRunning = liveRunning
            updateSummaryAndControls()
        }
        #endif
    }

    private func relaunchAntigravityAndSyncState(delay: TimeInterval) {
        app.suppressLifecycleAutoQuit(seconds: 45.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.app.openAntigravity()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
                guard let self, !self.busy else { return }
                self.syncLiveRunningState()
            }
        }
    }

    private func showPreflightBlockedAlert(_ msg: String) {
        feedbackLabel.isHidden = false
        feedbackLabel.textColor = accessibleWarningColor()
        feedbackLabel.stringValue = msg
        let warn = NSAlert()
        warn.alertStyle = .warning
        warn.messageText = L10n.t("maintenance.preflight_blocked_title")
        warn.informativeText = msg
        warn.addButton(withTitle: L10n.t("maintenance.btn.known"))
        var parentWindow = app.window
        while let sheet = parentWindow?.activeSheetWindow { parentWindow = sheet }
        if let parentWindow, parentWindow.isVisible {
            warn.beginSheetModal(for: parentWindow, completionHandler: nil)
        } else {
            warn.runModal()
        }
    }

    @objc func clearSelectedCaches() {
        guard !busy, hasCompletedScan else { return }
        dismissDetailPopover()
        syncLiveRunningState()
        let scopesToClear = selectedScopes
        let targetBytes = selectedReclaimableBytes
        guard !scopesToClear.isEmpty, targetBytes > 0 else { return }

        #if NATIVE_UI_TEST
        performSmartClear(scopes: scopesToClear, restartAfter: false)
        return
        #else
        if appRunning {
            setBusy(true)
            app.bridge.send(["command": "maintenance_preflight"]) { [weak self] preflightRes in
                guard let self else { return }
                self.setBusy(false)
                switch preflightRes {
                case .failure(let error):
                    self.showPreflightBlockedAlert(error.localizedDescription)
                case .success:
                    let confirm = NSAlert()
                    confirm.alertStyle = .informational
                    confirm.messageText = L10n.t("maintenance.simple.confirm_running_title", ["size": self.formatBytes(targetBytes)])
                    confirm.informativeText = self.buildRunningClearConfirmationBody()
                    confirm.addButton(withTitle: L10n.t("maintenance.simple.confirm_restart_and_clean"))
                    confirm.addButton(withTitle: L10n.t("common.cancel"))

                    let handleChoice: (NSApplication.ModalResponse) -> Void = { [weak self] response in
                        guard let self, response == .alertFirstButtonReturn else { return }
                        self.syncLiveRunningState()
                        if self.appRunning {
                            self.quitAntigravityAndSmartClear(scopes: scopesToClear)
                        } else {
                            self.performSmartClear(scopes: scopesToClear, restartAfter: false)
                        }
                    }

                    var parentWindow = self.app.window
                    while let sheet = parentWindow?.activeSheetWindow { parentWindow = sheet }
                    if let parentWindow, parentWindow.isVisible {
                        confirm.beginSheetModal(for: parentWindow) { handleChoice($0) }
                    } else {
                        NSApp.activate(ignoringOtherApps: true)
                        handleChoice(confirm.runModal())
                    }
                }
            }
        } else {
            performSmartClear(scopes: scopesToClear, restartAfter: false)
        }
        #endif
    }

    private func quitAntigravityAndSmartClear(scopes: [String]) {
        setBusy(true)
        app.suppressLifecycleAutoQuit(seconds: 90.0)
        feedbackLabel.isHidden = false
        feedbackLabel.textColor = Design.secondary
        feedbackLabel.stringValue = L10n.t("maintenance.simple.status_restarting_clean")

        app.quitAntigravityAndWait { [weak self] exited in
            guard let self else { return }
            self.app.suppressLifecycleAutoQuit(seconds: 90.0)
            guard exited else {
                self.setBusy(false)
                let msg = L10n.t("maintenance.error.quit_first_clear")
                self.feedbackLabel.isHidden = false
                self.feedbackLabel.textColor = accessibleWarningColor()
                self.feedbackLabel.stringValue = msg
                self.app.showMessage(msg, error: true)
                self.fetch(force: true)
                return
            }
            self.performSmartClear(scopes: scopes, restartAfter: true)
        }
    }

    private func performSmartClear(scopes: [String], restartAfter: Bool) {
        setBusy(true)
        if restartAfter {
            app.suppressLifecycleAutoQuit(seconds: 90.0)
        } else {
            feedbackLabel.isHidden = false
            feedbackLabel.textColor = Design.secondary
            feedbackLabel.stringValue = L10n.t("maintenance.simple.status_cleaning")
        }
        app.bridge.send([
            "command": "maintenance_smart_clear",
            "scopes": scopes,
            "retentionDays": selectedRetentionDays,
            "keepLocalSnapshots": 1
        ]) { [weak self] response in
            guard let self else { return }
            self.setBusy(false)
            switch response {
            case .failure(let error):
                self.feedbackLabel.isHidden = false
                self.feedbackLabel.textColor = accessibleWarningColor()
                self.feedbackLabel.stringValue = error.localizedDescription
                self.app.showMessage(error.localizedDescription, error: true)
                self.fetch(force: true)
                if restartAfter {
                    self.relaunchAntigravityAndSyncState(delay: 0.5)
                }
            case .success(let value):
                if let dir = value["trashDir"] as? String, !dir.isEmpty {
                    self.activeTrashPath = dir
                }
                if let fallbackFlag = value["usingFallbackTrash"] as? Bool {
                    self.usingFallbackTrash = fallbackFlag
                }
                if let superseded = value["supersededSnapshotPaths"] as? [String], !superseded.isEmpty {
                    self.rotateSupersededSnapshotsToSystemTrash(superseded)
                }
                let clearedBytes = Int64(intVal(value, "clearedBytes"))
                let msg: String
                if let serverMsg = value["message"] as? String, !serverMsg.isEmpty {
                    msg = serverMsg
                } else if clearedBytes > 0 {
                    msg = L10n.t("maintenance.simple.success_cleaned", ["size": self.formatBytes(clearedBytes)])
                } else {
                    msg = L10n.t("maintenance.simple.success_nothing")
                }
                self.feedbackLabel.isHidden = false
                self.feedbackLabel.textColor = Design.secondary
                self.feedbackLabel.stringValue = msg
                self.app.showMessage(msg)
                self.fetch(force: true)
                self.app.overview?.fetch()
                self.app.usagePage?.fetch(force: true)
                if restartAfter {
                    self.relaunchAntigravityAndSyncState(delay: 0.6)
                }
            }
        }
    }

    @objc func restoreLatestSnapshot() {
        guard !busy, !latestRestorableSnapshotId.isEmpty else { return }
        dismissDetailPopover()
        let snapshotId = latestRestorableSnapshotId
        syncLiveRunningState()

        #if NATIVE_UI_TEST
        executeRestoreRequest(snapshotId: snapshotId, restartAfter: false)
        #else
        if appRunning {
            setBusy(true)
            app.bridge.send(["command": "maintenance_preflight"]) { [weak self] preflightRes in
                guard let self else { return }
                self.setBusy(false)
                switch preflightRes {
                case .failure(let error):
                    self.showPreflightBlockedAlert(error.localizedDescription)
                case .success:
                    let alert = NSAlert()
                    alert.alertStyle = .informational
                    alert.messageText = L10n.t("maintenance.simple.undo_running_title")
                    alert.informativeText = L10n.t("maintenance.simple.undo_running_body")
                    alert.addButton(withTitle: L10n.t("maintenance.simple.confirm_restart_and_undo"))
                    alert.addButton(withTitle: L10n.t("common.cancel"))
                    let handleRestoreChoice: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
                        guard let self, resp == .alertFirstButtonReturn else { return }
                        self.syncLiveRunningState()
                        if self.appRunning {
                            self.quitAntigravityAndRestore(snapshotId: snapshotId)
                        } else {
                            self.executeRestoreRequest(snapshotId: snapshotId, restartAfter: false)
                        }
                    }
                    var parentWindow = self.app.window
                    while let sheet = parentWindow?.activeSheetWindow { parentWindow = sheet }
                    if let parentWindow, parentWindow.isVisible {
                        alert.beginSheetModal(for: parentWindow) { handleRestoreChoice($0) }
                    } else {
                        NSApp.activate(ignoringOtherApps: true)
                        handleRestoreChoice(alert.runModal())
                    }
                }
            }
            return
        }
        executeRestoreRequest(snapshotId: snapshotId, restartAfter: false)
        #endif
    }

    private func quitAntigravityAndRestore(snapshotId: String) {
        setBusy(true)
        app.suppressLifecycleAutoQuit(seconds: 90.0)
        feedbackLabel.isHidden = false
        feedbackLabel.textColor = Design.secondary
        feedbackLabel.stringValue = L10n.t("maintenance.simple.status_restarting_undo")

        app.quitAntigravityAndWait { [weak self] exited in
            guard let self else { return }
            self.app.suppressLifecycleAutoQuit(seconds: 90.0)
            guard exited else {
                self.setBusy(false)
                let msg = L10n.t("maintenance.restore.quit_body")
                self.feedbackLabel.isHidden = false
                self.feedbackLabel.textColor = accessibleWarningColor()
                self.feedbackLabel.stringValue = msg
                self.app.showMessage(msg, error: true)
                self.fetch(force: true)
                return
            }
            self.executeRestoreRequest(snapshotId: snapshotId, restartAfter: true)
        }
    }

    private func executeRestoreRequest(snapshotId: String, restartAfter: Bool) {
        setBusy(true)
        if restartAfter {
            app.suppressLifecycleAutoQuit(seconds: 90.0)
        } else {
            feedbackLabel.isHidden = false
            feedbackLabel.textColor = Design.secondary
            feedbackLabel.stringValue = L10n.t("maintenance.simple.status_undoing")
        }
        app.bridge.send(["command": "maintenance_restore", "snapshotId": snapshotId]) { [weak self] response in
            guard let self else { return }
            self.setBusy(false)
            switch response {
            case .failure(let error):
                self.feedbackLabel.isHidden = false
                self.feedbackLabel.textColor = accessibleWarningColor()
                self.feedbackLabel.stringValue = error.localizedDescription
                self.app.showMessage(error.localizedDescription, error: true)
                self.fetch(force: true)
                if restartAfter {
                    self.relaunchAntigravityAndSyncState(delay: 0.5)
                }
            case .success(let value):
                let msg = (value["message"] as? String) ?? L10n.t("maintenance.simple.success_undone")
                self.feedbackLabel.isHidden = false
                self.feedbackLabel.textColor = Design.secondary
                self.feedbackLabel.stringValue = msg
                self.app.showMessage(msg)
                self.fetch(force: true)
                self.app.overview?.fetch()
                self.app.usagePage?.fetch(force: true)
                if restartAfter {
                    self.relaunchAntigravityAndSyncState(delay: 0.6)
                }
            }
        }
    }
}

// MARK: - Compact Non-Scrolling Maintenance Sheet Window Controller (620 × 464)
final class MaintenanceSheetController: NSObject, NSWindowDelegate {
    static let sheetWidth: CGFloat = 620
    static let sheetHeight: CGFloat = 464

    unowned let app: Assistant
    let sheet = SheetWindow(
        contentRect: NSRect(x: 0, y: 0, width: MaintenanceSheetController.sheetWidth, height: MaintenanceSheetController.sheetHeight),
        styleMask: [.titled, .closable],
        backing: .buffered,
        defer: false
    )
    var cachePage: CachePage
    var onDismiss: (() -> Void)?

    init(app: Assistant) {
        self.app = app
        let page = app.cachePage ?? CachePage(app: app)
        app.cachePage = page
        self.cachePage = page
        super.init()
        sheet.delegate = self
        sheet.title = L10n.t("maintenance.sheet_title")
        sheet.isReleasedWhenClosed = false
        sheet.onCancelOperation = { [weak self] in self?.closeSheet() }

        page.sheetDoneButton.target = self
        page.sheetDoneButton.action = #selector(closeSheet)
        page.sheetDoneButton.isHidden = false

        let surface = SheetVisualEffectView()
        let footerDivider = divider()
        page.feedbackLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        page.sheetDoneButton.setContentHuggingPriority(.required, for: .horizontal)
        page.sheetDoneButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        let footerRow = horizontal([page.feedbackLabel, CachePage.elasticSpacer(), page.sheetDoneButton], spacing: 12)
        footerRow.detachesHiddenViews = true
        footerRow.alignment = .centerY

        page.view.translatesAutoresizingMaskIntoConstraints = false
        footerDivider.translatesAutoresizingMaskIntoConstraints = false
        footerRow.translatesAutoresizingMaskIntoConstraints = false

        surface.addSubview(page.view)
        surface.addSubview(footerDivider)
        surface.addSubview(footerRow)
        NSLayoutConstraint.activate([
            page.view.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
            page.view.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
            page.view.topAnchor.constraint(equalTo: surface.topAnchor),
            page.view.bottomAnchor.constraint(equalTo: footerDivider.topAnchor),
            footerDivider.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: 22),
            footerDivider.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -22),
            footerDivider.bottomAnchor.constraint(equalTo: footerRow.topAnchor, constant: -10),
            footerRow.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: 22),
            footerRow.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -22),
            footerRow.bottomAnchor.constraint(equalTo: surface.bottomAnchor, constant: -12),
        ])
        sheet.isOpaque = false
        sheet.backgroundColor = .clear
        sheet.contentView = surface
        Design.applyControls(surface)
    }

    func show(in parent: NSWindow, onDismiss: (() -> Void)? = nil) {
        guard sheet.sheetParent == nil else { return }
        let clampedHeight = min(Self.sheetHeight, max(448, parent.frame.height - 36))
        sheet.setContentSize(NSSize(width: Self.sheetWidth, height: clampedHeight))
        self.onDismiss = onDismiss
        cachePage.update(force: true)
        app.presentRetainedSheet(controller: self, sheet: sheet, in: parent) { [weak self] _ in
            self?.cachePage.dismissDetailPopover()
            self?.onDismiss?()
        }
    }

    @objc func closeSheet() {
        cachePage.dismissDetailPopover()
        sheet.sheetParent?.endSheet(sheet)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeSheet()
        return false
    }
}
