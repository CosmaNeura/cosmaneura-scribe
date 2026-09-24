// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CosmaneuraIOSPCMCapacitor",
  platforms: [
    .iOS(.v17),
    .macOS(.v13),
  ],
  products: [
    .library(
      name: "CosmaneuraIOSPCMCapacitor",
      targets: ["CosmaneuraIOSPCMCapacitor"]
    ),
    .library(
      name: "CosmaneuraScribeCapacitorIosPcm",
      targets: ["CosmaneuraIOSPCMCapacitor"]
    )
  ],
  dependencies: [
    .package(path: "../cosmas-native-auth"),
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
        .product(name: "CosmaneuraIOSPCMBridgeCore", package: "ios-pcm-capture"),
        .product(name: "CosmaneuraIOSPCMCore", package: "ios-pcm-capture")
      ]
    ),
    .target(
      name: "CosmaneuraIOSPCMCapacitor",
      dependencies: [
        .product(name: "CosmasNativeAuth", package: "cosmas-native-auth"),
        "CosmaneuraIOSPCMCapacitorTransport",
        .product(name: "CosmaneuraIOSPCMCore", package: "ios-pcm-capture"),
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
  ]
)
