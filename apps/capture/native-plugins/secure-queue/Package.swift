// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "CosmaneuraSecureQueue",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CosmaneuraScribeCapacitorSecureQueue",
            targets: ["CosmaneuraSecureQueue"]
        ),
    ],
    dependencies: [
        .package(
            url: "https://github.com/ionic-team/capacitor-swift-pm.git",
            exact: "8.5.0"
        ),
    ],
    targets: [
        .target(
            name: "CosmaneuraSecureQueue",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/CosmaneuraSecureQueue"
        ),
        .testTarget(
            name: "CosmaneuraSecureQueueTests",
            dependencies: ["CosmaneuraSecureQueue"],
            path: "ios/Tests/CosmaneuraSecureQueueTests"
        ),
    ]
)
