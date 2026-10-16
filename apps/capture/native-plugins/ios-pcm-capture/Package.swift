// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CosmaneuraIOSPCMCore",
  platforms: [
    .iOS(.v17),
    .macOS(.v13),
  ],
  products: [
    .library(name: "CosmaneuraIOSPCMCore", targets: ["CosmaneuraIOSPCMCore"]),
    .library(name: "CosmaneuraRecordingActivity", targets: ["CosmaneuraRecordingActivity"]),
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
    .target(name: "CosmaneuraRecordingActivity"),
    .target(
      name: "CosmaneuraIOSAVFoundationDriver",
      dependencies: ["CosmaneuraIOSPCMCore", "CosmaneuraRecordingActivity"]
    ),
    .target(
      name: "CosmaneuraIOSPCMBridgeCore",
      dependencies: ["CosmaneuraIOSPCMCore", "CosmaneuraIOSAVFoundationDriver"]
    ),
    .testTarget(
      name: "CosmaneuraIOSPCMBridgeCoreTests",
      dependencies: ["CosmaneuraIOSPCMCore", "CosmaneuraIOSPCMBridgeCore", "CosmaneuraIOSAVFoundationDriver"]
    ),
  ]
)
