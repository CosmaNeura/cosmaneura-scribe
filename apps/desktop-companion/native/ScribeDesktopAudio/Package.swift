// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ScribeDesktopAudio",
    platforms: [.macOS("14.2")],
    products: [.library(name: "ScribeDesktopAudio", targets: ["ScribeDesktopAudio"]),
               .executable(name: "ScribeDesktopAudioHelper", targets: ["ScribeDesktopAudioHelper"]),
               .executable(name: "ScribeProviderPresentationHelper", targets: ["ScribeProviderPresentationHelper"]),
               .executable(name: "ScribeDesktopAudioStoreService", targets: ["ScribeDesktopAudioStoreService"]),
               .executable(name: "ScribePresentationStoreService", targets: ["ScribePresentationStoreService"])],
    targets: [
        .target(name: "ScribeDesktopAudio", dependencies: ["ScribeStorePipe"]),
        .target(name: "ScribeStorePipe", publicHeadersPath: "include", linkerSettings: [.linkedFramework("Security"), .linkedFramework("CoreFoundation")]),
        .target(name: "ScribeStoreWorkers", dependencies: ["ScribeDesktopAudio", "ScribeStorePipe"]),
        .executableTarget(name: "ScribeDesktopAudioStoreService", dependencies: ["ScribeStoreWorkers", "ScribeStorePipe"]),
        .executableTarget(name: "ScribePresentationStoreService", dependencies: ["ScribeStoreWorkers", "ScribeStorePipe"]),
        .executableTarget(name: "ScribeDesktopAudioHelper", dependencies: ["ScribeDesktopAudio"]),
        .executableTarget(name: "ScribeProviderPresentationHelper", dependencies: ["ScribeDesktopAudio"]),
        .testTarget(name: "ScribeDesktopAudioTests", dependencies: ["ScribeDesktopAudio"], resources: [.copy("Fixtures")]),
    ]
)
