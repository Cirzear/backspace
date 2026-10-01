# Android APK client

The Android client lives in `packages/mobile` and embeds the React application from
`packages/web/dist-mobile` using Capacitor 8.5.2. It does not load a remote website
into the privileged WebView. Android application ID: `io.github.backspace.mobile`.

## Build and distribution

Requires Node 22+, pnpm, JDK 21 and Android SDK 36. Set `JAVA_HOME` and
`ANDROID_HOME` for the local toolchain, then run:

```sh
pnpm install
pnpm --filter @backspace/web build:mobile
pnpm --filter @backspace/mobile android:debug
```

Output: `packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
This is a debug-signed sideloadable build, not a production release identity.
Do not commit signing keys. Frontend resources ship with the APK; the mobile build
disables the PWA service worker and its update UI. Updating a server does not
update an installed APK. This first implementation does not negotiate a server
API version; it is intended for servers compatible with this source revision.

## Instance and session boundary

`platform/instanceRuntime.ts` separates the local document origin from the selected
server. A server must be a complete HTTPS origin, with a valid certificate, no
userinfo, path, query or fragment. The picker probes public instance info before
saving `backspace_mobile_origin`. No server is hardcoded. An empty connection
origin still means the primary instance throughout the existing federation layer.
REST, WebSocket, tus, identity comparisons and uploaded media use the server
origin, while bundled icons, sounds and scripts stay local.

`main.tsx` waits for native session restoration before dynamically importing the
application and message orchestrator. `platform/sessionStorage.ts` keeps native
credentials in memory and serializes per-origin credential maps through
`BackspaceSession`. The Java plugin encrypts them with Android Keystore-backed
AES-GCM; preferences contain ciphertext and a random IV, not plaintext tokens.
Writes are ordered. Read/decrypt/schema/write errors block the application rather
than falling back to plaintext or silently deleting credentials. Web/Electron
continue to use their existing browser storage.

The instance-switch control is available only while signed out, waits for queued
credential persistence and reloads the local application. The selected instance
is visible on authentication pages. Federated credentials remain separated by
primary origin, account and remote origin; federation identity rules are unchanged.

## Unsent work policy

Explicitly selected for this first APK: drafts, pending messages and transfer
queues exist only in the current Android session. They do not resume after a
restart. Authentication boundaries clear drafts and pending work, abort active
transfers and invalidate delayed callbacks. Android tus fingerprints are not
persisted. Sent messages remain on the server. Web persistence is unchanged.

## Native interaction

`mobile/NativeLifecycle.tsx` handles Android back: close context menus, dismiss the
newest registered modal, close the global modal, pop a mobile screen, return from
auth subpages, otherwise minimize. `mobile/nativeBack.ts` registers modal dismiss
handlers. Native Android disables the web edge-swipe gesture to avoid duplicate
back actions. The manifest uses `adjustResize` and disables Android backup.
`MainActivity` applies system-bar, cutout and IME insets to the native viewport,
then clears the consumed insets before passing them to WebView. This also protects
fixed dialogs and avoids duplicate CSS padding. Capacitor SystemBars inset handling
is disabled; its dark style reads `android:windowBackground` (`#13131a`) from the
app theme so the status strip stays dark across Android theme changes.

TLS errors are not bypassed; cleartext traffic and mixed content are disabled.
External websites are not allowlisted into the native bridge.

## Limits and verification

Compilation and unit tests are not device verification. Before treating a build
as production-ready, exercise instance selection, login/logout, restart credential
restoration, A→B→A isolation, messages and media, file uploads, keyboard, system
back, external links, microphone/camera permissions and foreground calls on a real
Android device. A device or configured emulator is required for installation and
Keystore/WebView end-to-end validation.
