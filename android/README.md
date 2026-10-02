# DSH · 安卓外壳

把电脑上 DSH 的**远程访问网页**装进一个安卓 App。手机装一次，之后只管填地址。

## 它做了什么

| | |
|---|---|
| 首屏 | **服务器地址页**：只填 `IP或域名:端口`（**不带协议**，例 `100.64.0.3:19388`）；HTTPS 由勾选决定 |
| 失败时 | WebView 打不开（地址错 / 电脑没开 / 不在同一网段）**自动退回地址页**并说明原因 |
| 顶栏 | 「设置 / 后退 / 刷新」——**任何时候都能回到地址页**，也就是断网也能改地址 |
| 网页 | 就是电脑上那份 DSH：手机布局、`远程UI布局`、`UI 设置` 全由插件配置决定 |
| 权限 | 只有 `INTERNET` 与 `ACCESS_NETWORK_STATE`；允许明文 http（Tailscale 网段内直连） |
| 其它 | 附件选择（`ACTION_GET_CONTENT`）、站外链接交给系统浏览器、返回键先在网页里后退 |

地址存在 `SharedPreferences`（`dsh_remote`）里，下次打开直接连。

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

现成的包在 Releases 里（本仓库 `v1.0.1-android`；应用名 **DSH**，图标是自适应图标 + 各密度 PNG）。换版本时：

1. `android/app/build.gradle` 里抬 `versionCode` / `versionName`（`versionCode` 必须比上一版大，否则覆盖安装会被拒）；
2. 构建、签名，把 APK 传上去；
3. 签名文件与口令放在**仓库外**，别提交。

## 为什么要单独一个 App

浏览器也能用，但手机上：

- 地址栏要手打 `http://` 加长串 IP，还容易打错；
- 打不开时看到的是一张错误页，**改地址得去翻浏览器历史**；
- 没有「下次直接进」的入口。

这个外壳就解决这三件事，网页本身（布局、设置、UI 设置）仍然全在插件里。
