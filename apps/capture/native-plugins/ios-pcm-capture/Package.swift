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



  ]
)
