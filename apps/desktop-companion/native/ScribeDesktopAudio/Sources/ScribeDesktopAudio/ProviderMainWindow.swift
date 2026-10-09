import AppKit
import CoreGraphics
import Darwin

/// Only metadata from the window server is used. Window titles and pixels are
/// never read. The identity comes from the helper's inherited pipe parent.
struct ProviderWindowMetadata: Sendable {
    let id: UInt32
    let owner: Int32
    let bounds: CGRect
    let alpha: Double
    let layer: Int
}

struct ProviderWindowHandoff {
    enum Action { case keep, hideNative, showNative }
    private var presentingMain = false
    mutating func reconcile(mainCovers: Bool, forceNative: Bool) -> Action {
        if mainCovers {
            defer { presentingMain = true }
            return presentingMain ? .keep : .hideNative
        }
        defer { presentingMain = false }
        return forceNative || presentingMain ? .showNative : .keep
    }
}

func providerMainWindowVisible(_ id: UInt32, parent: Int32, helper: Int32,
                               windows: [ProviderWindowMetadata], screens: [CGRect]) -> Bool {
    guard parent > 1, let index = windows.firstIndex(where: { $0.id == id }) else { return false }
    let target = windows[index]
    guard target.owner == parent, target.alpha == 1,
          target.layer >= NSWindow.Level.statusBar.rawValue,
          target.bounds.width >= 360, target.bounds.height >= 240,
          screens.contains(where: { $0.contains(target.bounds) }) else { return false }
    // The list is front-to-back. A partially covered controller is not proof
    // that Stop is reachable. Ignore only our own fallback and transparent items.
    return !windows[..<index].contains {
        $0.owner != helper && $0.alpha > 0 && $0.bounds.intersects(target.bounds)
    }
}

@MainActor
final class ProviderMainWindowLease {
    private let parent: Int32
    private let owner: (UInt32) -> Int32?
    private let visible: (UInt32, Int32) -> Bool
    private let clock: () -> ContinuousClock.Instant
    private var bound: UInt32?
    private var current: UInt32?
    private var expires: ContinuousClock.Instant?

    init(parent: Int32,
         owner: @escaping (UInt32) -> Int32?,
         visible: @escaping (UInt32, Int32) -> Bool,
         clock: @escaping () -> ContinuousClock.Instant = { .now }) {
        self.parent = parent; self.owner = owner; self.visible = visible; self.clock = clock
    }

    func refresh(_ window: UInt32?) throws {
        guard let window else { current = nil; expires = nil; return }
        guard window > 0, parent > 1, owner(window) == parent,
              bound == nil || bound == window else { throw ProviderPresentationFailure.unavailable }
        bound = window; current = window; expires = clock().advanced(by: .milliseconds(2500))
    }

    var coversRecording: Bool {
        guard let current, let expires, clock() < expires, owner(current) == parent else { return false }
        return visible(current, parent)
    }

    static func system() -> ProviderMainWindowLease {
        let parent = getppid(), helper = getpid()
        return ProviderMainWindowLease(parent: parent, owner: { id in
            guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
                  let row = rows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id })
            else { return nil }
            return (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        }, visible: { id, expectedParent in
            guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                       kCGNullWindowID) as? [[String: Any]] else { return false }
            var windows: [ProviderWindowMetadata] = []
            for row in rows {
                guard let number = row[kCGWindowNumber as String] as? NSNumber,
                      let owner = row[kCGWindowOwnerPID as String] as? NSNumber,
                      let alpha = row[kCGWindowAlpha as String] as? NSNumber,
                      let layer = row[kCGWindowLayer as String] as? NSNumber,
                      let dictionary = row[kCGWindowBounds as String] as? [String: Any],
                      let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
                      bounds.origin.x.isFinite, bounds.origin.y.isFinite,
                      bounds.width.isFinite, bounds.height.isFinite, alpha.doubleValue.isFinite
                else { return false }
                windows.append(ProviderWindowMetadata(id: number.uint32Value, owner: owner.int32Value,
                    bounds: bounds, alpha: alpha.doubleValue, layer: layer.intValue))
            }
            // CGWindow coordinates start at the top of the primary display;
            // AppKit uses its bottom. Convert every work area before comparison.
            guard let primary = NSScreen.screens.first else { return false }
            let screens = NSScreen.screens.map { screen -> CGRect in
                let frame = screen.visibleFrame
                return CGRect(x: frame.minX, y: primary.frame.maxY - frame.maxY,
                              width: frame.width, height: frame.height)
            }
            return providerMainWindowVisible(id, parent: expectedParent, helper: helper,
                                             windows: windows, screens: screens)
        })
    }
}
