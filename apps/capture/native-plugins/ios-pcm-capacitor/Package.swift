// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CosmaneuraIOSPCMCapacitor",
  platforms: [
    .iOS(.v15),
    .macOS(.v13),
  ],
  products: [
    .library(
      name: "CosmaneuraIOSPCMCapacitor",
      targets: ["CosmaneuraIOSPCMCapacitor"]
    )
  ],
  dependencies: [
    .package(path: "../ios-pcm-capture"),
    .package(
      url: "https://github.com/ionic-team/capacitor-swift-pm.git",
      exact: "8.5.0"
    ),
  ],
  targets: [
    .target(
      name: "CosmaneuraIOSPCMCapacitorTransport",
      dependencies: [
        .product(name: "CosmaneuraIOSPCMBridgeCore", package: "ios-pcm-capture")
      ]
    ),
    .target(
      name: "CosmaneuraIOSPCMCapacitor",
      dependencies: [
        "CosmaneuraIOSPCMCapacitorTransport",
        .product(
          name: "Capacitor",
          package: "capacitor-swift-pm",
          condition: .when(platforms: [.iOS])
        ),
        .product(
          name: "Cordova",
          package: "capacitor-swift-pm",
          condition: .when(platforms: [.iOS])
        ),
      ]
    ),
    .testTarget(
      name: "CosmaneuraIOSPCMCapacitorTransportTests",
      dependencies: [
        "CosmaneuraIOSPCMCapacitorTransport",
        .product(name: "CosmaneuraIOSPCMBridgeCore", package: "ios-pcm-capture"),
      ]
    ),
  ]
)
