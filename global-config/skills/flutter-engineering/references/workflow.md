# Flutter engineering workflow

Establish Flutter/Dart versions, state-management library, router/navigation approach, generated-code conventions and target platforms.

Trace widget -> state/controller/provider -> repository/API/storage -> navigation/platform boundary. Keep build methods free of expensive side effects and dispose controllers/subscriptions.

For async UI, model loading/success/empty/error explicitly, prevent stale result updates after a newer request or disposal, and preserve state across navigation only when intended.

Respect MediaQuery, safe areas, keyboard insets, text scaling and platform-specific behavior. Use stable keys where identity matters.

For native/plugin changes, verify Android/iOS minimum versions and plugin compatibility rather than changing toolchains blindly.

Verification should include dart/flutter analyze, focused widget/unit tests, the affected navigation/async interaction and platform build/smoke paths when platform-sensitive code changed.
