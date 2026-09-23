---
name: react-native-engineering
description: "Work on React Native/Expo apps: components, hooks, navigation, styling, APIs, native modules, Android/iOS build failures, platform behavior, and performance with version-aware verification."
---

# React Native Engineering

Detect React Native version, Expo vs bare workflow, JS/TS, package manager, navigation/state/data libraries, Hermes/native structure, and the target platforms before changing code.

Preserve existing component, styling, navigation, and state conventions. Treat Android/iOS build failures as compatibility problems first: inspect JDK, Gradle, AGP, Kotlin, SDK, CocoaPods/Xcode, Expo/RN versions and the exact failing task before cache deletion or dependency churn.

For UI/data behavior, handle loading/empty/error/success states, lifecycle cleanup, keyboard/safe-area/platform differences, list identity, and accessibility. Avoid effects for derived state and avoid JS-thread work that belongs off the hot path.

Read [workflow.md](references/workflow.md) for build-diagnosis order, platform invariants, performance checks, and verification.
