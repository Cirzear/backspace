# Backspace Android 容器

`@backspace/mobile` 1.7.0 使用 Capacitor core/android/cli **8.5.2** 和 App **8.1.1**，应用标识为 `io.github.backspace.mobile`。

## 构建要求

- Node.js 22+、pnpm，以及 **JDK 21**（设置 `JAVA_HOME`）。
- Android SDK Platform **36**、Build Tools **36.0.0** 和 Platform Tools；设置 `ANDROID_HOME`，或在 `android/local.properties` 写入 `sdk.dir=你的SDK绝对路径`（此文件被忽略）。
- Gradle 使用已包含的 wrapper；首次运行需要下载 Gradle 和 Maven 依赖。
- 必须先准备真实的 `packages/web/dist-mobile/index.html` 及其静态资源。容器不构建前端，也不提供占位页面。

在仓库依赖安装完成、移动前端资源就绪后，从仓库根目录执行：

```sh
pnpm --filter @backspace/mobile sync
pnpm --filter @backspace/mobile android
pnpm --filter @backspace/mobile android:debug
```

`android` 打开 Android Studio；`android:debug` 会先 sync，防止 APK 意外包含旧资源，然后调用 `./gradlew assembleDebug`。Windows 可以在 `packages/mobile/android` 使用 `gradlew.bat assembleDebug`（先执行 sync）。

APK 输出：`packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。

**此 APK 使用 Android 开发环境的 debug 签名，不是正式 release，不可将其当作正式发布身份。** 此工程不生成或配置正式发布密钥。Debug 构建可供安装测试；未连接设备时不能声称已验证运行效果。

## 本地 SPA 与安全边界

- `webDir` 固定为 `../web/dist-mobile`；使用默认 `https://localhost` 本地资源源站。
- 不设置远程 `server.url`，不配置 `allowNavigation`，不覆盖 Capacitor 的外部导航策略；外部页面不得获得原生会话桥接能力。
- 禁用明文流量和 mixed content，不忽略 TLS 错误；后端应使用有效 HTTPS/WSS。前端不能把相对 `/api` 当作已选择的实例地址。
- Android 备份关闭。WebView 仍按用户操作申请摄像头/麦克风；屏幕共享另由 `mediaProjection|microphone` 前台服务维持后台采集与通话。服务只在前台用户授权后启动，不开机自启、不粘性重启。
- 主 Activity 使用 `adjustResize`。仅声明媒体能力为可选，不限制无摄像头设备安装。

## 前端会话约定

通过 `@capacitor/core` 的 `registerPlugin` 使用原生插件，不要依赖 localStorage 保存移动端凭证：

```ts
import { registerPlugin } from '@capacitor/core';

interface BackspaceSessionPlugin {
  read(): Promise<{ value: string | null }>;
  write(options: { value: string }): Promise<void>;
  clear(): Promise<void>;
}

export const BackspaceSession = registerPlugin<BackspaceSessionPlugin>('BackspaceSession');
```

- React/认证 store 启动前 `await read()` 并完成恢复；无记录严格返回 `{ value: null }`。
- `write` 接收完整会话 JSON 字符串，原生层作为不透明字符串保存，不解析业务 schema。**空字符串、非字符串、null 拒绝**；UTF-8 编码最多 **1 MiB**（等于边界允许）。
- SPA 负责 JSON schema、版本和各实例身份/token 的正确恢复，不得混淆联邦用户 ID。持久化调用按顺序提交并等待，退出登录 `await clear()`。
- 会话用 Android Keystore 非导出 AES-256/GCM 密钥保护，Cipher 每次产生随机 12 字节 IV；SharedPreferences 只存 `Base64(IV + ciphertext + tag)`。
- Promise 成功表示 `commit()` 成功。读取损坏、密钥丢失、持久化失败均 reject；调用方应暴露错误，不能静默回退到明文、空会话或自动清除。只允许用户明确操作后清除损坏会话。
- 错误码：`SESSION_INVALID_VALUE`、`SESSION_TOO_LARGE`、`SESSION_READ_FAILED`、`SESSION_WRITE_FAILED`、`SESSION_CLEAR_FAILED`。前端负责用户可见本地化，不展示或记录会话内容。
- `@capacitor/app` 已集成，可由前端处理 Android 返回键和生命周期；本容器不自定义导航逻辑。

## 原生屏幕共享与后台语音

`BackspaceScreenShare` 是 bundled SPA 专用 Capacitor 插件：

```ts
interface ScreenShareState {
  state: 'starting' | 'started' | 'stopped' | 'error';
  error?: string;
}
interface NativeAudioState { micMuted: boolean; deafened: boolean }
interface BackspaceScreenSharePlugin {
  start(options: NativeAudioState & {
    url: string; token: string; voiceToken: string;
    wsUrl: string; wsToken: string; identity: string;
    width: number; height: number; frameRate: number; bitrate: number;
    shareAudio: boolean;
  }): Promise<ScreenShareState>;
  stop(): Promise<ScreenShareState>;
  getState(): Promise<ScreenShareState>;
  updateAudioState(options: NativeAudioState): Promise<void>;
  addListener(event: 'screenShareState', listener: (state: ScreenShareState) => void):
    Promise<{ remove(): Promise<void> }>;
}
```

- URL 必须 `wss`，由当前通话所在实例签发；不得用用户主页实例的凭证代替远端实例身份。`identity` 是 screen helper 身份，两个 LiveKit token 共用 `url`。凭证仅留内存，不写服务 Intent、saved state 或磁盘。
- 宽高同为 `0` 表示设备原尺寸，否则为长短边上限；帧率 1–120，码率单位 **bps**，最大 100 Mbps。切换质量/音频选项需停止并重新申请共享，不复用 Android 14 的一次性授权。
- `start` 等待系统许可、后台 WS 的 `native_voice_bound` 确认、两个 Room 连接、全部请求轨道发布和系统音频 PCM 首帧后才成功。取消返回 `SCREEN_SHARE_CANCELLED`，拒绝麦克风权限返回 `SCREEN_SHARE_AUDIO_PERMISSION_DENIED`；其他错误以稳定 `SCREEN_SHARE_*` code 交给 Web 本地化，不把失败当作无音频成功。
- Web 在 start 前释放自己的麦克风采集并暂停远端 **MICROPHONE** 播放；`stop` / `error` 后恢复。其他屏幕音频仍由 Web 播放。`micMuted/deafened` 与 `updateAudioState` 同步有效静音；原生额外遵守服务端空间/权限静音与耳聋，不能被 Web 解除。
- LiveKit Android **2.29.0**（WebRTC **144.7559.14**）每个 Room 的 ADM 只有一条采集路径，因此必须两个独立 helper：`purpose:'screen-share'` 发布 SCREEN_SHARE/SCREEN_SHARE_AUDIO、不订阅；`purpose:'native-voice'` 发布 MICROPHONE、仅订阅别人 MICROPHONE。二者 metadata 都含实例正确的 `ownerIdentity`。服务端 token 必须禁止数据发布及非对应源。
- screen Room 使用 `NoAudioHandler`，在建 Room 前 `setAudioRecordEnabled(false)` 禁止其真实麦克风 AudioRecord；独立 `AudioPlaybackCapture` 经 recordingless PCM callback 注入 SCREEN_SHARE_AUDIO（48 kHz、双声道、128 kbps，不混入麦克风）。voice Room 使用 SDK 正常音频焦点与路由管理，接管真实麦克风。所有权限与资源在共享结束时释放。
- 系统音频要求 **Android 10+**，旧系统选择 `shareAudio:true` 明确拒绝。仅能捕获允许 playback capture 的 MEDIA/GAME/UNKNOWN 使用类型，排除整个 Backspace UID（含 WebView、通知和原生通话回放）防回音；DRM、禁止采集应用、其他用户配置文件、通话音频受 Android 限制，可能自然无声，不能保证捕获所有系统声音。
- 额外原生 `/ws` 使用现有 auth（`client:'mobile'`）→ `ready` → `native_voice_bind`，不发送 `voice_join/voice_status`。等待 `native_voice_bound` 的 userId/spaceMuted/permissionMuted/deafened，按 userId 过滤后续约束；RFC WebSocket ping/pong 由 OkHttp 原生线程维持。绑定断开、移动/踢出立即结束共享，不用重连偷偷恢复授权。
- 服务具有停止通知、系统投屏停止、显式 stop、Activity/bridge 销毁及任务移除清理路径；切到其他应用不停止。四语通知资源 en/zh/de/ru 按 Android 系统语言选择。Android 13+ 用户关闭通知权限仍显示系统前台服务提示，但通知抽屉中的停止按钮可能不可见，可用系统投屏停止入口。
- Gradle 依赖 LiveKit 官方固定提交的 AudioSwitch fork，JitPack 仓库仅允许 `com.github.davidliu` group；不使用动态依赖版本。Android 原生编译不证明音视频传输、后台麦克风或厂商电池策略已在手机验证。

官方接口依据：[LiveKit SDK](https://github.com/livekit/client-sdk-android/tree/v2.29.0)、[WebRTC AudioRecord recordingless 路径](https://github.com/webrtc-sdk/webrtc/blob/m144_release/sdk/android/src/java/org/webrtc/audio/WebRtcAudioRecord.java)、[Android playback capture](https://developer.android.com/media/platform/av-capture)。

`sync` 会生成并更新 Capacitor 配置、插件列表和 Cordova 兼容工程。这些构建产物及本机依赖不应提交；Gradle wrapper JAR、脚本及其版本配置必须保留。
