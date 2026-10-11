// swift-tools-version:5.9
// The Swift host of the chat panel. Add this repository as a package
// dependency and import ClaudeChatPanel; the page (web/) ships as a resource.
import PackageDescription

let package = Package(
    name: "ClaudeChatPanel",
    platforms: [.macOS(.v12)],
    products: [
        .library(name: "ClaudeChatPanel", targets: ["ClaudeChatPanel"]),
        .executable(name: "claude-chat-demo", targets: ["ClaudeChatDemo"]),
    ],
    targets: [
        .target(
            name: "ClaudeChatPanel",
            path: ".",
            exclude: ["hosts/node", "hosts/csharp", "hosts/rust", "examples", "README.md", "PROTOCOL.md", "LICENSE", "NOTICE.md"],
            sources: ["hosts/swift/Sources/ClaudeChatPanel"],
            resources: [.copy("web")]
        ),
        .executableTarget(
            name: "ClaudeChatDemo",
            dependencies: ["ClaudeChatPanel"],
            path: "examples/swift-cli"
        ),
        .testTarget(
            name: "ClaudeChatPanelTests",
            dependencies: ["ClaudeChatPanel"],
            path: "hosts/swift/Tests/ClaudeChatPanelTests"
        ),
    ]
)
