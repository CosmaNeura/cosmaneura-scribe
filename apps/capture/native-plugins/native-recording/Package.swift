// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CosmaneuraNativeRecording",
  platforms: [.iOS(.v17), .macOS(.v13)],
  products: [
    .library(name: "CosmaneuraNativeRecording", targets: ["CosmaneuraNativeRecording"]),
    .library(name: "CosmaneuraNativeRecordingPCM", targets: ["CosmaneuraNativeRecordingPCM"]),
  ],
  dependencies: [.package(path: "../ios-pcm-capture")],
  targets: [
    .target(name: "CosmaneuraNativeRecording"),
    .target(
      name: "CosmaneuraNativeRecordingPCM",
      dependencies: [
        "CosmaneuraNativeRecording",
        .product(name: "CosmaneuraIOSPCMCore", package: "ios-pcm-capture"),
      ]),
    .testTarget(
      name: "CosmaneuraNativeRecordingTests", dependencies: ["CosmaneuraNativeRecording"]),
    .testTarget(
      name: "CosmaneuraNativeRecordingPCMTests",
      dependencies: [
        "CosmaneuraNativeRecordingPCM",
        .product(name: "CosmaneuraIOSPCMCore", package: "ios-pcm-capture"),
      ]),
  ]
)
