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

`sync` 会生成并更新 Capacitor 配置、插件列表和 Cordova 兼容工程。这些构建产物及本机依赖不应提交；Gradle wrapper JAR、脚本及其版本配置必须保留。
