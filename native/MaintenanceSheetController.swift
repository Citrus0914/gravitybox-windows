import Cocoa

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
