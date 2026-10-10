# DSH · 安卓外壳

把电脑上 DSH 的**远程访问网页**装进一个安卓 App。手机装一次，之后只管填地址。

## 它做了什么

| | |
|---|---|
| 首屏 | **服务器地址页**：只填 `IP或域名:端口`（**不带协议**，例 `100.64.0.3:19388`）；HTTPS 由勾选决定 |
| 失败时 | WebView 打不开（地址错 / 电脑没开 / 不在同一网段）**自动退回地址页**并说明原因 |
| 顶栏 | 网页上是左侧一枚半透明小胶囊（**设置 / 刷新**两枚图标）；**设置页任何时候都进得去**，断网也能改地址 |
| 返回键 | **整个由外壳接管**（见下面「返回键」一段）：先关网页里的抽屉/右栏/设置面板 → 再网页历史后退 → 最后才退出 App |
| 网页 | 就是电脑上那份 DSH：手机布局、`远程UI布局`、`UI 设置` 全由插件配置决定 |
| 权限 | 只有 `INTERNET` 与 `ACCESS_NETWORK_STATE`；允许明文 http（Tailscale 网段内直连） |
| 其它 | 附件选择（`ACTION_GET_CONTENT`）、站外链接交给系统浏览器 |

地址存在 `SharedPreferences`（`dsh_remote`）里，下次打开直接连。

## 返回键

返回键不分给系统默认行为，而是按当前屏幕逐档决定（`MainActivity.handleBack`）：

| 当前屏幕 | 返回键做什么 |
|---|---|
| 地址页（从网页点「设置」进来） | 回网页，**不重新连**、不丢页面状态 |
| 地址页（首次启动，或网页已经坏了） | 退出 App（没有「回去」可回） |
| 错误页 | 回地址页改地址 —— 主框架加载失败之后 WebView 里已经没有能看的页面了，「回网页」只会退回一张白页，所以那一档不做 |
| 网页，手机布局里还开着抽屉 / 右栏 / 设置面板 | **先关掉最上面那层**（走它自己的关闭入口：官方浮层派发 Escape、抽屉点「收起侧边栏」），这一下返回键就此用掉 |
| 网页，没有浮层可关，但 WebView 有历史 | 网页后退 |
| 都没有 | 退出 App |

「网页已经坏了」由主框架导航成没成来判：`onPageStarted` 清标记、`onReceivedError`（只认主框架）立标记，
`onPageFinished` 到的时候没有标记才算「这一版真的渲染出来了」（`webOk`）。地址页那个返回图标看的是同一个标记。

两处实现上的取舍：

1. **两条返回路径都接上**。Android 13（API 33）起系统把返回交给 `OnBackInvokedCallback`
   （清单里 `android:enableOnBackInvokedCallback="true"`），更早的版本只有 `onBackPressed`；
   两条路都进同一个 `handleBack`，所以新旧机器行为一致。代价：返回键由我们裁决，
   系统就不再画「滑回桌面」的预测式预览 —— 换来的是任何一层都有确定的返回行为。
2. **问网页是异步的**。抽屉/右栏/设置面板是浏览器半区（插件 `client.js` 的
   `window.__dshRaBack`）加上去的，WebView 没有同步的询问入口，所以返回键会先
   `evaluateJavascript` 问一次「还有几层能关的」；网页线程卡住时 400ms 后按「没有浮层」处理，
   免得返回键看起来失灵。普通浏览器（没有外壳）里没有这个入口，网页那半边等于不存在。

## 构建

需要 **JDK 17+** 与 **Android SDK**（platform 34 / build-tools 34），Gradle 8.x：

```powershell
cd android
$env:JAVA_HOME = 'C:\Program Files\Android\openjdk\jdk-21.0.8'   # 换成你的 JDK
gradle assembleDebug          # 调试包：app/build/outputs/apk/debug/app-debug.apk
gradle assembleRelease        # 发布包（见下面的签名）
```

依赖只有 Android Gradle Plugin 8.8.0，没有 androidx / Kotlin —— 断网（`--offline`）也能构建。

### 签名（发布包）

仓库里**不放密钥**。要签发布包，自己在 `android/keystore.properties` 写（该文件已 gitignore）：

```properties
storeFile=C:/absolute/path/to/your.jks
storePassword=...
keyAlias=...
keyPassword=...
```

没有这个文件时，`assembleRelease` 产出**未签名**的 APK（也能装，但后续版本必须用同一把钥匙才能覆盖安装）。

生成密钥：

```powershell
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v -keystore dsh-remote.jks `
  -alias dshremote -keyalg RSA -keysize 2048 -validity 10950 `
  -storepass 你的口令 -keypass 你的口令 -dname "CN=DSH Remote, O=personal, C=CN"
```

> 注意 `storeFile` 用**正斜杠**（`C:/...`）：`keystore.properties` 是 Java Properties 格式，反斜杠会被当转义符吃掉。

## 发布

现成的包在 Releases 里（tag 形如 `v<versionName>-android`；应用名 **DSH**，图标是自适应图标 + 各密度 PNG）。换版本时：

1. `android/app/build.gradle` 里抬 `versionCode` / `versionName`（`versionCode` 必须比上一版大，否则覆盖安装会被拒）；
2. 构建、签名，把 APK 传上去；
3. 签名文件与口令放在**仓库外**，别提交。

## 为什么要单独一个 App

浏览器也能用，但手机上：

- 地址栏要手打 `http://` 加长串 IP，还容易打错；
- 打不开时看到的是一张错误页，**改地址得去翻浏览器历史**；
- 没有「下次直接进」的入口。

这个外壳就解决这三件事，网页本身（布局、设置、UI 设置）仍然全在插件里。
