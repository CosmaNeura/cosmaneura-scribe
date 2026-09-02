// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CosmaneuraIOSPCMCore",
  platforms: [
    .iOS(.v15),
    .macOS(.v13),
  ],
  products: [
    .library(name: "CosmaneuraIOSPCMCore", targets: ["CosmaneuraIOSPCMCore"]),
    .library(
      name: "CosmaneuraIOSAVFoundationDriver",
      targets: ["CosmaneuraIOSAVFoundationDriver"]
    ),
    .library(
      name: "CosmaneuraIOSPCMBridgeCore",
      targets: ["CosmaneuraIOSPCMBridgeCore"]
    ),
  ],
  targets: [
    .target(name: "CosmaneuraIOSPCMCore"),
    .target(
      name: "CosmaneuraIOSAVFoundationDriver",
      dependencies: ["CosmaneuraIOSPCMCore"]
    ),
    .target(
      name: "CosmaneuraIOSPCMBridgeCore",
      dependencies: ["CosmaneuraIOSPCMCore", "CosmaneuraIOSAVFoundationDriver"]
    ),
    .testTarget(
      name: "CosmaneuraIOSPCMCoreTests",
      dependencies: ["CosmaneuraIOSPCMCore"]
    ),
    .testTarget(
      name: "CosmaneuraIOSAVFoundationDriverTests",
      dependencies: ["CosmaneuraIOSAVFoundationDriver", "CosmaneuraIOSPCMCore"]
    ),
    .testTarget(
      name: "CosmaneuraIOSPCMBridgeCoreTests",
      dependencies: [
        "CosmaneuraIOSPCMBridgeCore",
        "CosmaneuraIOSPCMCore",
        "CosmaneuraIOSAVFoundationDriver",
      ]
    ),
  ]
)
