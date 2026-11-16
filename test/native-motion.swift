import Cocoa
import QuartzCore

private final class StrictDisplayLink: CADisplayLink {
    var retainedTarget: AnyObject?
    let selector: Selector
    var invalidated = false
    var invalidateCount = 0
    var removeFromRunLoopCount = 0
    var addedToRunLoopCount = 0
    private var storedFrameRateRange = CAFrameRateRange(minimum: 0, maximum: 0, preferred: 0)

    init(target: Any, selector: Selector) {
        self.retainedTarget = target as AnyObject
        self.selector = selector
        super.init()
    }

    override var preferredFrameRateRange: CAFrameRateRange {
        get { storedFrameRateRange }
        set { storedFrameRateRange = newValue }
    }

    override func add(to runloop: RunLoop, forMode mode: RunLoop.Mode) {
        addedToRunLoopCount += 1
    }

    override func remove(from runloop: RunLoop, forMode mode: RunLoop.Mode) {
        precondition(!invalidated, "Regression #15: remove(from:forMode:) called after invalidate()")
        removeFromRunLoopCount += 1
    }

    override func invalidate() {
        precondition(!invalidated, "Duplicate invalidate() called on CADisplayLink")
        invalidated = true
        invalidateCount += 1
        retainedTarget = nil
    }

    func fire() {
        guard !invalidated, let targetObj = retainedTarget as? NSObject else { return }
        _ = targetObj.perform(selector, with: self)
    }
}

private final class LifetimeProbe {}

@main
struct NativeMotionTests {
    static func main() {
        #if NATIVE_UI_TEST
        fatalError("native-motion must NOT be compiled with NATIVE_UI_TEST")
        #endif

        runStrictCancelAndStateMachineTests()
        runWeakProxyLeakAndTrailingCallbackTests()
        runRealAppKitAndTimerFallbackTests()

        print("NATIVE_MOTION_LIFECYCLE_OK")
    }

    private static func runStrictCancelAndStateMachineTests() {
        var now: CFTimeInterval = 10.0
        var allowAnimate = true
        var links: [StrictDisplayLink] = []

        let motion = DesignMotion(
            shouldAnimate: { _ in allowAnimate },
            makeDisplayLink: { _, target, selector in
                let link = StrictDisplayLink(target: target, selector: selector)
                links.append(link)
                return link
            },
            timeSource: { now }
        )

        // (a) 单次与连续多次幂等 cancel()
        var latestValue: CGFloat = -1
        motion.animate(in: nil, from: 0, to: 1, curve: .hover) { val in
            latestValue = val
        }
        precondition(links.count == 1)
        precondition(links[0].addedToRunLoopCount == 1)

        motion.cancel()
        motion.cancel()
        motion.cancel()
        precondition(links[0].invalidateCount == 1)
        precondition(links[0].removeFromRunLoopCount == 0)
        precondition(links[0].retainedTarget == nil)

        // (b) 高频抢占打断（模拟鼠标快速移入/移出 Hover 元素）
        for i in 0..<10 {
            let fromVal: CGFloat = i % 2 == 0 ? 0 : 1
            let toVal: CGFloat = 1 - fromVal
            motion.animate(in: nil, from: fromVal, to: toVal, curve: .hover) { val in
                latestValue = val
            }
        }
        precondition(links.count == 11)
        for idx in 1..<10 {
            precondition(links[idx].invalidateCount == 1)
            precondition(links[idx].removeFromRunLoopCount == 0)
            precondition(links[idx].retainedTarget == nil)
        }
        precondition(links[10].invalidateCount == 0)
        motion.cancel()
        precondition(links[10].invalidateCount == 1)
        precondition(links[10].removeFromRunLoopCount == 0)

        // (c) 可控时钟推进至完成并自动安全销毁
        now = 20.0
        var completions = 0
        motion.animate(in: nil, from: 0.2, to: 1.0, curve: .hover, apply: { val in
            latestValue = val
        }, completion: {
            completions += 1
        })
        let animLink = links.last!
        now = 20.05
        animLink.fire()
        precondition(latestValue > 0.2 && latestValue < 1.0)
        precondition(completions == 0)
        precondition(animLink.invalidateCount == 0)

        now = 20.20
        animLink.fire()
        precondition(abs(latestValue - 1.0) < 0.0001)
        precondition(completions == 1)
        precondition(animLink.invalidateCount == 1)
        precondition(animLink.removeFromRunLoopCount == 0)

        // (d) completion 回调内链式重入启动下一段动画（模拟呼吸灯脉冲）
        now = 30.0
        var chainCompleted = false
        let chainStartCount = links.count
        motion.animate(in: nil, from: 1.0, to: 0.5, curve: .breathe, apply: { val in
            latestValue = val
        }, completion: {
            motion.animate(in: nil, from: 0.5, to: 1.0, curve: .breathe, apply: { val in
                latestValue = val
            }, completion: {
                chainCompleted = true
            })
        })
        let firstChainLink = links[chainStartCount]
        now = 31.30
        firstChainLink.fire()
        precondition(firstChainLink.invalidateCount == 1)
        precondition(firstChainLink.removeFromRunLoopCount == 0)
        precondition(links.count == chainStartCount + 2)
        let secondChainLink = links[chainStartCount + 1]
        precondition(secondChainLink.invalidateCount == 0)
        precondition(!chainCompleted)

        now = 32.60
        secondChainLink.fire()
        precondition(chainCompleted)
        precondition(abs(latestValue - 1.0) < 0.0001)
        precondition(secondChainLink.invalidateCount == 1)
        precondition(secondChainLink.removeFromRunLoopCount == 0)

        // (e) 动画进行中 shouldAnimate 变为 false（例如系统开启 Reduce Motion 或视图脱离窗口）
        now = 40.0
        var stopCompletions = 0
        motion.animate(in: nil, from: 0.0, to: 1.0, curve: .spring, apply: { val in
            latestValue = val
        }, completion: {
            stopCompletions += 1
        })
        let stopLink = links.last!
        now = 40.05
        stopLink.fire()
        precondition(stopLink.invalidateCount == 0)
        allowAnimate = false
        now = 40.06
        stopLink.fire()
        precondition(abs(latestValue - 1.0) < 0.0001)
        precondition(stopCompletions == 1)
        precondition(stopLink.invalidateCount == 1)
        precondition(stopLink.removeFromRunLoopCount == 0)
    }

    private static func runWeakProxyLeakAndTrailingCallbackTests() {
        weak var weakMotion: DesignMotion?
        weak var weakProbe: LifetimeProbe?
        weak var weakProxy: AnyObject?
        var capturedLink: StrictDisplayLink?

        // (a) 不显式调用 cancel()，仅依赖 deinit + 弱代理打破强引用环
        autoreleasepool {
            let probe = LifetimeProbe()
            let motion = DesignMotion(
                shouldAnimate: { _ in true },
                makeDisplayLink: { _, target, selector in
                    let link = StrictDisplayLink(target: target, selector: selector)
                    capturedLink = link
                    return link
                },
                timeSource: { 1.0 }
            )
            weakMotion = motion
            weakProbe = probe

            motion.animate(in: nil, from: 0.0, to: 1.0, curve: .spring, apply: { _ in
                _ = probe
            }, completion: {
                _ = probe
            })
            weakProxy = capturedLink?.retainedTarget
            precondition(weakMotion != nil && weakProbe != nil && weakProxy != nil)
        }

        precondition(weakMotion == nil, "DesignMotion leaked via displayLink target retain cycle")
        precondition(weakProbe == nil, "Closure-captured probe leaked")
        precondition(weakProxy == nil, "DisplayLinkTarget proxy leaked")
        precondition(capturedLink?.invalidateCount == 1)
        precondition(capturedLink?.retainedTarget == nil)
        precondition(capturedLink?.removeFromRunLoopCount == 0)

        // (b) cancel() 之后同一帧触发尾随回调：安全无崩溃、幂等不重复 invalidate
        var trailingLink: StrictDisplayLink?
        let motion = DesignMotion(
            shouldAnimate: { _ in true },
            makeDisplayLink: { _, target, selector in
                let link = StrictDisplayLink(target: target, selector: selector)
                trailingLink = link
                return link
            },
            timeSource: { 2.0 }
        )
        var applyCount = 0
        motion.animate(in: nil, from: 0, to: 1, curve: .hover) { _ in
            applyCount += 1
        }
        let retainedTrailingTarget = trailingLink?.retainedTarget as? NSObject
        let selector = trailingLink!.selector
        motion.cancel()
        precondition(trailingLink?.invalidateCount == 1)
        precondition(trailingLink?.retainedTarget == nil)

        _ = retainedTrailingTarget?.perform(selector, with: trailingLink!)
        precondition(trailingLink?.invalidateCount == 1)
        precondition(trailingLink?.removeFromRunLoopCount == 0)
        precondition(applyCount == 0)

        // (c) 宿主 deinit 之后模拟同帧尾随回调
        weak var weakHost: DesignMotion?
        var hostLink: StrictDisplayLink?
        var orphanTarget: NSObject?
        autoreleasepool {
            let localMotion = DesignMotion(
                shouldAnimate: { _ in true },
                makeDisplayLink: { _, target, selector in
                    let link = StrictDisplayLink(target: target, selector: selector)
                    hostLink = link
                    return link
                },
                timeSource: { 3.0 }
            )
            weakHost = localMotion
            localMotion.animate(in: nil, from: 0, to: 1, curve: .hover) { _ in }
            orphanTarget = hostLink?.retainedTarget as? NSObject
        }
        precondition(weakHost == nil)
        precondition(hostLink?.invalidateCount == 1)
        _ = orphanTarget?.perform(hostLink!.selector, with: hostLink!)
        precondition(hostLink?.invalidateCount == 1)
        precondition(hostLink?.removeFromRunLoopCount == 0)
    }

    private static func runRealAppKitAndTimerFallbackTests() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 200, height: 120),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 120))
        window.contentView = view
        defer { window.close() }

        // 1. 真实 NSView.displayLink 路径（绕过主机 Reduce Motion 设置以确保走真实 CADisplayLink）
        let viewMotion = DesignMotion(
            shouldAnimate: { $0?.window != nil },
            makeDisplayLink: DesignMotion.defaultMakeDisplayLink,
            timeSource: CACurrentMediaTime
        )
        var lastVal: CGFloat = 0
        viewMotion.animate(in: view, from: 0, to: 1, curve: .hover) { val in
            lastVal = val
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        // 抢占重开并立即取消，测试真实 _NSDisplayLink 生命周期
        viewMotion.animate(in: view, from: lastVal, to: 0, curve: .hover) { val in
            lastVal = val
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        viewMotion.cancel()

        // 验证真实 _NSDisplayLink 下不主动调 cancel() 的 deinit 路径
        weak var weakViewMotion: DesignMotion?
        autoreleasepool {
            let transient = DesignMotion(
                shouldAnimate: { $0?.window != nil },
                makeDisplayLink: DesignMotion.defaultMakeDisplayLink,
                timeSource: CACurrentMediaTime
            )
            weakViewMotion = transient
            transient.animate(in: view, from: 0, to: 1, curve: .hover) { _ in }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        precondition(weakViewMotion == nil, "Real CADisplayLink retained DesignMotion on dealloc")

        // 2. view == nil（NSScreen.main?.displayLink 或 Timer 回退）路径
        let screenMotion = DesignMotion(
            shouldAnimate: { _ in true },
            makeDisplayLink: DesignMotion.defaultMakeDisplayLink,
            timeSource: CACurrentMediaTime
        )
        screenMotion.animate(in: nil, from: 0, to: 1, curve: .hover) { _ in }
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        screenMotion.cancel()

        // 3. 纯 Timer 回退路径端到端完成及取消验证
        let timerMotion = DesignMotion(
            shouldAnimate: { _ in true },
            makeDisplayLink: { _, _, _ in nil },
            timeSource: CACurrentMediaTime
        )
        var timerValue: CGFloat = 0
        var timerCompleted = false
        timerMotion.animate(in: nil, from: 0, to: 1, curve: .hover, apply: { val in
            timerValue = val
        }, completion: {
            timerCompleted = true
        })
        let deadline = Date().addingTimeInterval(1.0)
        while !timerCompleted && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        precondition(timerCompleted, "Timer fallback animation did not complete within 1s")
        precondition(abs(timerValue - 1.0) < 0.0001)
        timerMotion.cancel()
        timerMotion.cancel()
    }
}
