import Cocoa

final class AddAccountSheet: NSObject {
    static let sheetWidth: CGFloat = 460
    static let collapsedHeight: CGFloat = 294
    static let expandedHeight: CGFloat = 338

    unowned let app: Assistant
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: AddAccountSheet.sheetWidth, height: AddAccountSheet.collapsedHeight),
        styleMask: [.titled],
        backing: .buffered,
        defer: false
    )
    let status = text("", size: 12, color: Design.secondary, wrap: true)
    let spinner = NSProgressIndicator()
    let currentButton = button(L10n.t("add_account.save_current", fallback: "保存当前账号"), target: nil, action: #selector(saveCurrent))
    let googleButton = button(L10n.t("add_account.google_btn", fallback: "Google 授权登录…"), target: nil, action: #selector(signIn))
    let cancelButton = button(L10n.t("common.cancel", fallback: "取消"), target: nil, action: #selector(cancel))
    private var feedback: NSStackView!
    var sessionID: String?
    var pollTimer: Timer?
    var requestInFlight = false
    var closing = false
    var saved: () -> Void
    var onDismiss: (() -> Void)?

    init(app: Assistant, saved: @escaping () -> Void) {
        self.app = app
        self.saved = saved
        super.init()
        window.title = L10n.t("add_account.title", fallback: "添加账号")
        window.isReleasedWhenClosed = false
        currentButton.target = self
        googleButton.target = self
        // F06: 始终只保留一个实心主按钮：已配置 OAuth 客户端凭据时以 Google 授权为主按钮，
        // 未配置时自动将即开即用的“保存当前账号”提升为主按钮，避免默认回车直接落入未配置提示。
        let currentEmail = app.statusValue.liveAccountEmail.isEmpty ? app.statusValue.activeAccountEmail : app.statusValue.liveAccountEmail
        let preferCurrentAccount = !app.statusValue.oauthClientConfigured
        let primaryButton = preferCurrentAccount ? currentButton : googleButton
        let secondaryButton = preferCurrentAccount ? googleButton : currentButton
        currentButton.title = L10n.t("add_account.save_current", fallback: "保存当前账号")
        currentButton.isEnabled = true
        secondaryButton.bezelColor = nil
        secondaryButton.keyEquivalent = ""
        primaryButton.bezelColor = Design.blue
        primaryButton.keyEquivalent = "\r"
        window.initialFirstResponder = primaryButton
        cancelButton.target = self
        cancelButton.keyEquivalent = "\u{1b}"
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            spinner.widthAnchor.constraint(equalToConstant: 16),
            spinner.heightAnchor.constraint(equalToConstant: 16)
        ])

        func choice(_ icon: String, _ title: String, _ subtitle: String, _ action: NSButton) -> NSView {
            let titleLbl = text(title, size: 13, weight: .semibold, color: .labelColor)
            let subLbl = text(subtitle, size: 11, color: Design.secondary, wrap: true)
            subLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
            var textViews: [NSView] = [titleLbl, subLbl]
            if action === currentButton, !currentEmail.isEmpty {
                let emailLbl = text(currentEmail, size: 10.5, color: .secondaryLabelColor)
                enableTextCopy(emailLbl, title: L10n.t("common.copy_full_email", fallback: "复制完整邮箱"))
                emailLbl.font = .systemFont(ofSize: 11.5, weight: .regular)
                emailLbl.lineBreakMode = .byTruncatingMiddle
                emailLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
                emailLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                textViews.append(emailLbl)
            }
            let textCol = vertical(textViews, spacing: 2.5)
            textCol.alignment = .leading
            textCol.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
            textCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            for v in textViews {
                v.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
                fillWidth(v, in: textCol)
            }
            action.setContentHuggingPriority(.required, for: .horizontal)
            action.setContentCompressionResistancePriority(.required, for: .horizontal)
            let badge = iconBadge(icon, tint: Design.blue, size: 30)
            let row = horizontal([badge, textCol, action], spacing: 12)
            row.alignment = .centerY
            return group([row], inset: 14)
        }

        feedback = horizontal([spinner, status], spacing: 8)
        feedback.isHidden = true
        let headerBadge = iconBadge("person.badge.plus", tint: Design.blue, size: 32)
        let headerTitle = text(L10n.t("add_account.title", fallback: "添加账号"), size: 16, weight: .semibold, color: .labelColor)
        let headerRow = horizontal([headerBadge, headerTitle, flexibleSpace()], spacing: 10)
        headerRow.alignment = .centerY
        let root = vertical([
            headerRow,
            choice("person.crop.rectangle", L10n.t("add_account.save_current", fallback: "保存当前账号"), L10n.t("add_account.save_current_sub", fallback: "导入当前 Antigravity 登录账号"), currentButton),
            choice("globe", L10n.t("add_account.google_title", fallback: "Google 授权登录"), L10n.t("add_account.google_sub", fallback: "通过浏览器授权，凭据仅存本机"), googleButton),
            feedback,
            horizontal([flexibleSpace(), cancelButton])
        ], spacing: 12)
        let surface = SheetVisualEffectView()
        let content = fixedPage(root)
        surface.addSubview(content)
        pin(content, to: surface)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = surface
        Design.applyControls(surface)
        surface.layoutSubtreeIfNeeded()
        window.setContentSize(NSSize(width: Self.sheetWidth, height: max(Self.collapsedHeight, ceil(content.fittingSize.height))))
    }

    deinit {
        pollTimer?.invalidate()
    }

    func show(in parent: NSWindow, onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss
        app.presentRetainedSheet(controller: self, sheet: window, in: parent) { [weak self] _ in
            self?.pollTimer?.invalidate()
            self?.onDismiss?()
        }
        // F06: Sheet 成为 key 后再锁定一次初始焦点，避免 AppKit 按视图顺序落到次级按钮。
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window.sheetParent != nil else { return }
            let targetResponder = self.app.statusValue.oauthClientConfigured ? self.googleButton : self.currentButton
            self.window.makeFirstResponder(targetResponder)
        }
    }

    func busy(_ value: Bool) {
        feedback.isHidden = status.stringValue.isEmpty
        window.contentView?.layoutSubtreeIfNeeded()
        let fittingH = ceil(window.contentView?.fittingSize.height ?? 0)
        let targetH = feedback.isHidden ? max(Self.collapsedHeight, fittingH) : max(Self.expandedHeight, fittingH)
        window.setContentSize(NSSize(width: Self.sheetWidth, height: targetH))
        currentButton.isEnabled = !value
        googleButton.isEnabled = !value
        spinner.isHidden = !value
        if value {
            spinner.startAnimation(nil)
        } else {
            spinner.stopAnimation(nil)
        }
    }

    func fail(_ message: String) {
        status.stringValue = message
        status.textColor = accessibleDangerColor()
        busy(false)
        cancelButton.isEnabled = true
    }

    @objc func saveCurrent() {
        status.stringValue = L10n.t("add_account.status.reading_current")
        status.textColor = Design.secondary
        busy(true)
        cancelButton.isEnabled = false
        app.bridge.send(["command": "account_save_current"]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .success:
                self.saved()
                self.dismiss()
            case .failure(let error):
                self.fail(error.localizedDescription)
            }
        }
    }

    @objc func signIn() {
        status.stringValue = L10n.t("add_account.status.opening_google")
        status.textColor = Design.secondary
        busy(true)
        requestInFlight = true
        cancelButton.isEnabled = false
        app.bridge.send(["command": "account_oauth_begin"]) { [weak self] response in
            guard let self else { return }
            self.requestInFlight = false
            self.cancelButton.isEnabled = true
            switch response {
            case .failure(let error):
                self.fail(error.localizedDescription)
            case .success(let value):
                guard let id = value["id"] as? String,
                      let link = value["url"] as? String,
                      let url = URL(string: link),
                      url.scheme == "https",
                      url.host == "accounts.google.com",
                      url.path == "/o/oauth2/v2/auth" else {
                    self.fail(L10n.t("add_account.error.invalid_url"))
                    return
                }
                self.sessionID = id
                #if !NATIVE_UI_TEST
                guard NSWorkspace.shared.open(url) else {
                    self.app.bridge.send(["command": "account_oauth_cancel", "id": id]) { _ in }
                    self.fail(L10n.t("add_account.error.open_browser"))
                    return
                }
                #endif
                self.status.stringValue = L10n.t("add_account.status.complete_in_browser")
                self.pollTimer?.invalidate()
                let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                    self?.checkLogin()
                }
                RunLoop.main.add(timer, forMode: .common)
                self.pollTimer = timer
            }
        }
    }

    func checkLogin() {
        guard let id = sessionID, !requestInFlight, !closing else { return }
        requestInFlight = true
        app.bridge.send(["command": "account_oauth_status", "id": id]) { [weak self] response in
            guard let self else { return }
            self.requestInFlight = false
            switch response {
            case .failure(let error):
                self.pollTimer?.invalidate()
                self.fail(error.localizedDescription)
            case .success(let value):
                let phase = value["phase"] as? String ?? "failed"
                self.cancelButton.isEnabled = phase != "saving"
                if phase == "succeeded" {
                    self.pollTimer?.invalidate()
                    self.saved()
                    self.dismiss()
                } else if ["failed", "cancelled", "expired"].contains(phase) {
                    self.pollTimer?.invalidate()
                    self.fail(value["message"] as? String ?? L10n.t("add_account.error.incomplete"))
                } else if phase == "saving" {
                    self.status.stringValue = L10n.t("add_account.status.saving")
                }
            }
        }
    }

    @objc func cancel() {
        guard cancelButton.isEnabled, !closing else { return }
        guard let id = sessionID else {
            dismiss()
            return
        }
        closing = true
        cancelButton.isEnabled = false
        app.bridge.send(["command": "account_oauth_cancel", "id": id]) { [weak self] response in
            guard let self else { return }
            self.closing = false
            switch response {
            case .failure:
                self.fail(L10n.t("add_account.error.cancel_failed"))
            case .success(let value):
                if value["phase"] as? String == "saving" { return }
                self.dismiss()
            }
        }
    }

    func dismiss() {
        pollTimer?.invalidate()
        window.sheetParent?.endSheet(window)
    }
}
