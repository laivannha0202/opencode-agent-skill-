# React Native workflow

## Establish the stack
Read package.json, RN/Expo config, Android Gradle files, iOS Podfile/project metadata when relevant, and the nearest working screen/native integration. Record exact RN/Expo, React, navigation, JDK/Gradle/AGP/Kotlin or Xcode/CocoaPods versions implicated by the task.

## Behavior changes
Trace screen -> state/data hook -> API/storage -> navigation/native boundary. Check stale async updates, effect cleanup, focus lifecycle, repeated requests, stable FlatList keys, keyboard/safe-area behavior, image sizing/caching, and platform-specific branches.

## Android failures
Use the first failing Gradle task and compatibility matrix evidence. Distinguish Java/JDK, Gradle wrapper, AGP, Kotlin, Android SDK/build-tools, CMake/NDK and native-module errors. Do not start with cache clearing.

## iOS failures
Separate JS/Metro issues from Pods, deployment target, Xcode toolchain, signing, native-module, and simulator/device architecture failures.

## Verification
Prefer the original reproduction plus project-native lint/typecheck/tests. For native changes, verify the affected Android/iOS build path. For UI regressions, exercise the interaction on the target platform or the strongest available component/device test. Recheck both platforms when shared code touches platform-sensitive APIs.
