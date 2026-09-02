// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CosmaneuraIOSPCMCore",
  platforms: [
    .iOS(.v15),
    .macOS(.v13),
  ],
  products: [
    .library(name: "CosmaneuraIOSPCMCore", targets: ["CosmaneuraIOSPCMCore"])
  ],
  targets: [
    .target(name: "CosmaneuraIOSPCMCore"),
    .testTarget(
      name: "CosmaneuraIOSPCMCoreTests",
      dependencies: ["CosmaneuraIOSPCMCore"]
    ),
  ]
)
