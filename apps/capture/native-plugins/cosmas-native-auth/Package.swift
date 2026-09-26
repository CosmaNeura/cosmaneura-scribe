// swift-tools-version: 6.2
import PackageDescription
let package = Package(
    name: "CosmasNativeAuthQualification", defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CosmasNativeAuth", targets: ["CosmasNativeAuth"]),
        .library(name: "CosmasWorkspaceAuthPlugin", targets: ["CosmasWorkspaceAuthPlugin"]),
    ],
    dependencies: [
        .package(path: "../native-recording"),
        .package(path: "../ios-pcm-capture"),
        .package(path: "../secure-queue"),
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),
    ],
    targets: [
        .target(name: "ClerkKit", path: "vendor/Sources/ClerkKit",
                resources: [.process("Resources")]),
        .target(name: "CosmasNativeAuth", dependencies: ["ClerkKit"]),
        .target(name: "CosmasWorkspaceAuthPlugin", dependencies: [
            "CosmasNativeAuth", .product(name: "Capacitor", package: "capacitor-swift-pm"),
            .product(name: "CosmaneuraNativeRecording", package: "native-recording"),
            .product(name: "CosmaneuraNativeRecordingPCM", package: "native-recording"),
            .product(name: "CosmaneuraIOSPCMCore", package: "ios-pcm-capture"),
            .product(name: "CosmaneuraIOSAVFoundationDriver", package: "ios-pcm-capture"),
            .product(name: "CosmaneuraScribeCapacitorSecureQueue", package: "secure-queue",
                condition: .when(platforms: [.iOS])),
        ], path: "Bridge"),

    ]
)
