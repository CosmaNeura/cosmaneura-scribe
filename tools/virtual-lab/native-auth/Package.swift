// swift-tools-version: 6.2
import PackageDescription

// Materialized by run.py in an owned output. No remote package dependencies.
let package = Package(
    name: "ScribeNativeAuthLab", defaultLocalization: "en",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "ClerkKit", path: "vendor/Sources/ClerkKit",
                resources: [.process("Resources")]),
        .testTarget(name: "NativeAuthLabTests", dependencies: ["ClerkKit"], path: "Tests"),
    ]
)
