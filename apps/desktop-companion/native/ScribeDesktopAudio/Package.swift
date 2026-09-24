// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ScribeDesktopAudio",
    platforms: [.macOS("14.2")],
    products: [.library(name: "ScribeDesktopAudio", targets: ["ScribeDesktopAudio"]),
               .executable(name: "ScribeDesktopAudioHelper", targets: ["ScribeDesktopAudioHelper"]),
               .executable(name: "ScribeProviderPresentationHelper", targets: ["ScribeProviderPresentationHelper"])],
    targets: [
        .target(name: "ScribeDesktopAudio"),
        .executableTarget(name: "ScribeDesktopAudioHelper", dependencies: ["ScribeDesktopAudio"]),
        .executableTarget(name: "ScribeProviderPresentationHelper", dependencies: ["ScribeDesktopAudio"]),
        .testTarget(name: "ScribeDesktopAudioTests", dependencies: ["ScribeDesktopAudio"], resources: [.copy("Fixtures")]),
    ]
)
