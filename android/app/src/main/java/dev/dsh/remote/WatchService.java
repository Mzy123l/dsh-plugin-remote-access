package dev.dsh.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 「模型在等你选择」的后台哨兵。
 *
 * 为什么是个前台服务：App 一退到后台，网页那一半随时可能被系统掐掉（WebView 的 JS 会被节流、
 * 进程也会被回收），而用户要的恰恰是「人不在电脑前、也没在看手机时，模型一提问就能在状态栏看到」。
 * 所以这里自己拿一条 HTTP 长轮询（不依赖 WebView），并由前台服务把进程保成「活着但不可回收」。
 *
 * 它只做三件事：
 *   1. 长轮询宿主插件的 {@code /__remote_access__/notify}（带着 WebView 里那张放行 cookie）；
 *   2. 判断「该不该响」：宿主说有选择在等 + App 不在前台 + （配置要求时）电脑窗口不可见；
 *   3. 该响就发一条通知，问题答完（宿主那边 pending 清空）就撤掉，并顺手更新常驻通知的文案。
 *
 * 有意不做的事：不解析网页、不碰 DSH 的会话数据 —— 问什么、答没答完都是宿主插件算好的，
 * 这里拿到的就是一份「现在要不要打扰用户」的状态。
 */
public class WatchService extends Service {

  private static final String TAG = "DshWatch";

  /** 前台服务自己的常驻通知（Android 要求前台服务必须挂着一条通知） */
  static final int ID_ONGOING = 1001;
  /**
   * 「模型在等你选择」那条会弹横幅的通知：**两个 id 轮流用**。
   * 为什么不用一个固定 id：更新同一条通知时系统不保证再弹一次横幅，而「下一条问题」
   * 必须是一次真正的新通知才会弹出来 —— 轮着用就等于每次都新建一条。
   */
  static final int ID_CHOICE_A = 1002;
  static final int ID_CHOICE_B = 1003;

  static final String CHANNEL_ONGOING = "dsh-watch";
  static final String CHANNEL_CHOICE = "dsh-choice";

  /** 长轮询一次最多挂多久：宿主上限 30 秒，这里取 20，读超时留足余量 */
  private static final int POLL_WAIT_SECONDS = 20;
  private static final int CONNECT_TIMEOUT_MS = 8000;
  private static final int READ_TIMEOUT_MS = 40000;
  /** 响应体上限：这里只会是一小段 JSON，超过就当异常（免得被别的东西喂爆内存） */
  private static final int MAX_BODY_CHARS = 65536;
  /** 连不上多久就自己收工（电脑关着的时候没必要一直挂着） */
  private static final long GIVE_UP_MS = 5 * 60 * 1000L;
  /** 「等用户去处理」的那两种失败（插件太旧 / 凭据过期）多久重试一次 */
  private static final long NEED_ACTION_RETRY_MS = 60_000L;
  /** 轮询间隔：连着的时候长轮询本来就会挂住，这里只是防止「状态一直变」时打转 */
  private static final long LOOP_IDLE_MS = 300;

  /** App 在前台时由 MainActivity 置位：那会儿用户自己看得到问题，不用打扰 */
  static volatile boolean activityVisible = false;

  private Thread worker;
  private volatile boolean running = false;
  /** 上次拿到的状态版本号：带着它长轮询，状态没变就一直挂着 */
  private volatile int lastRev = -1;
  /** host[:port] 规范化后的基址，例如 http://100.64.0.3:19388 */
  private String base = "";
  /** 当前这条通知的内容指纹：一样就不重复发，免得每次轮询都「叮」一下 */
  private String shownFingerprint = "";
  /** 被用户划掉的那条问题的 id：同一条不再提醒，答完/换问题自动清掉 */
  private String dismissedId = "";
  /** 当前那条「等你选择」的通知用的是哪个 id；0 = 现在没有 */
  private int choiceId = 0;
  /** App 的 versionName（懒查一次） */
  private String cachedVersion = null;
  /** 常驻通知当前那行文案：一样就不重复刷 */
  private String ongoingText = "";

  // ---------------------------------------------------------------- 生命周期

  @Override
  public void onCreate() {
    super.onCreate();
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return;
    // 两条通道分别对应两种打扰程度，这一对必须分得干净：
    //   · 后台待命（IMPORTANCE_LOW）：前台服务按规定必须挂着一条通知。它**只**说明「我在后台盯着」，
    //     不该响、不该震、更不该从顶上弹出来 —— 否则每次退回后台都像来了条消息。
    //   · 模型提问（IMPORTANCE_HIGH）：这才是要「弹出来」的那条。Android 上从屏幕顶部弹出（横幅 /
    //     heads-up）的**唯一**开关就是通道重要性 HIGH，再配合通知本身的高优先级与响铃震动。
    //     用户看到的「只在状态栏里静静躺着」的那条，几乎都是上一条，而不是这一条。
    NotificationChannel watch = new NotificationChannel(
        CHANNEL_ONGOING, "后台待命", NotificationManager.IMPORTANCE_LOW);
    watch.setDescription("App 退到后台时保持连接（这一条不会弹，只在这里说明它在盯着）");
    watch.setShowBadge(false);
    watch.enableVibration(false);
    watch.setSound(null, null);

    NotificationChannel choice = new NotificationChannel(
        CHANNEL_CHOICE, "模型提问", NotificationManager.IMPORTANCE_HIGH);
    choice.setDescription("模型需要你选择时，从屏幕顶部弹出提醒（像收到一条消息）");
    choice.setShowBadge(true);
    choice.enableVibration(true);
    // 显式给上默认提示音：HIGH 通道本来就带，但写出来意图明确，也方便以后改成别的
    try {
      choice.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), null);
    } catch (Throwable ignored) {
      // 拿不到默认铃声就靠通道默认值
    }

    manager.createNotificationChannel(watch);
    manager.createNotificationChannel(choice);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
    String host = String.valueOf(prefs.getString(MainActivity.KEY_HOST, ""));
    boolean tls = prefs.getBoolean(MainActivity.KEY_TLS, false);
    base = host.isEmpty() ? "" : (tls ? "https://" : "http://") + host;

    startAsForeground(base.isEmpty() ? "还没设置电脑地址" : "模型提问时会在这里提醒你");

    if (base.isEmpty()) {
      stopSelf();
      return START_NOT_STICKY;
    }
    // 界面正在前台就别挂了：问题就在眼前，状态栏再弹一条只是噪音
    if (activityVisible) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (worker == null || !worker.isAlive()) {
      running = true;
      worker = new Thread(this::loop, "dsh-choice-watch");
      worker.setDaemon(true);
      worker.start();
    }
    // 被系统回收后尽量自己回来：通知是这个 App 的主要用途，断了就没意义了
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    running = false;
    Thread current = worker;
    worker = null;
    if (current != null) current.interrupt();
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager != null) {
      manager.cancel(ID_ONGOING);
      manager.cancel(ID_CHOICE_A);
      manager.cancel(ID_CHOICE_B);
    }
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  // ---------------------------------------------------------------- 轮询

  /**
   * 一次轮询失败的原因。
   *
   * 为什么要分类，而不是一律说「连不上电脑上的 DSH」：真机踩过一次 —— 电脑上装的还是老插件
   * （没有 `/__remote_access__/notify`，端点回 404），常驻通知却写着「连不上电脑上的 DSH」，
   * 看起来像网络问题，实际上要去电脑上更新插件。**通知上那行字就是用户唯一的线索**，
   * 所以这里把「插件太旧 / 凭据过期 / 真的连不上」分开说。
   */
  private static final class PollFailure extends Exception {
    /** HTTP 状态码；0 = 根本没连上（DNS、超时、拒绝连接…） */
    final int status;
    /** 要不要按「等它回来」那样退避重试（网络类），而不是按「等用户去处理」那样慢慢重试 */
    final boolean transient_;
    /** 通知上给用户看的那句话 */
    final String hint;

    PollFailure(int status, String hint, boolean transient_, Throwable cause) {
      super("HTTP " + status + (cause == null ? "" : ": " + cause), cause);
      this.status = status;
      this.hint = hint;
      this.transient_ = transient_;
    }
  }

  private static PollFailure unreachable(String why, Throwable cause) {
    return new PollFailure(0, "连不上电脑上的 DSH，正在重试…", true, cause == null ? new Exception(why) : cause);
  }

  private void loop() {
    long failedSince = 0;
    int failures = 0;
    while (running) {
      try {
        JSONObject state = pollOnce();
        if (failures > 0) Log.i(TAG, "重新连上 DSH（之前失败 " + failures + " 次）");
        failures = 0;
        failedSince = 0;
        applyState(state);
        sleep(LOOP_IDLE_MS);
      } catch (Exception err) {
        if (!running) return;
        PollFailure failure = err instanceof PollFailure
            ? (PollFailure) err
            : new PollFailure(0, "读取电脑上的插件状态失败，正在重试…", true, err);
        failures += 1;
        Log.w(TAG, "轮询失败（第 " + failures + " 次，status=" + failure.status + "）: " + err);
        updateOngoing(failure.hint);
        if (failure.transient_) {
          if (failedSince == 0) failedSince = System.currentTimeMillis();
          // 电脑关着的时候没必要一直挂着；但「插件太旧 / 凭据过期」是等用户去处理，
          // 所以那两种情况不退避、也不收工，慢慢重试就好（用户处理完不用再碰手机）。
          if (System.currentTimeMillis() - failedSince > GIVE_UP_MS) {
            Log.w(TAG, "连续失败超过 5 分钟，先撤了（下次打开 App 会再起来）");
            stopSelf();
            return;
          }
          sleep(Math.min(60_000L, 5_000L * failures));
        } else {
          failedSince = 0;
          sleep(NEED_ACTION_RETRY_MS);
        }
      }
    }
  }

  /** 长轮询一次；返回宿主那份状态 JSON */
  private JSONObject pollOnce() throws PollFailure {
    int rev = lastRev;
    // 顺带把自己的「通知环境」报给宿主（App 版本 / 通知开没开 / 「模型提问」通道的重要性）：
    // 这样设置页底部那行自检能直接写清「手机端为什么弹不出来」，宿主状态文件里也留一份证据。
    String query = "?rev=" + rev + "&wait=" + POLL_WAIT_SECONDS
        + "&av=" + urlEncode(appVersion())
        + "&n=" + (notificationsEnabled() ? 1 : 0)
        + "&ch=" + choiceChannelImportance();
    HttpURLConnection conn;
    try {
      conn = (HttpURLConnection) new URL(base + "/__remote_access__/notify" + query).openConnection();
    } catch (Exception err) {
      throw unreachable("地址不对: " + base, err);
    }
    try {
      try {
        conn.setRequestMethod("GET");
      } catch (Exception err) {
        throw unreachable("请求方法没设上", err);
      }
      conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
      conn.setReadTimeout(READ_TIMEOUT_MS);
      conn.setRequestProperty("accept", "application/json");
      conn.setRequestProperty("cache-control", "no-store");
      // 放行凭据就在 WebView 的 cookie 里（设了访问密码时是插件发的那张，否则是 DSH 自己的）
      String cookie = CookieManager.getInstance().getCookie(base + "/");
      if (cookie != null && !cookie.isEmpty()) conn.setRequestProperty("cookie", cookie);
      int code;
      try {
        code = conn.getResponseCode();
      } catch (Exception err) {
        throw unreachable("请求失败", err);
      }
      if (code == 404) {
        throw new PollFailure(404, "电脑上的插件版本太旧（没有通知接口），去电脑上更新它", false, null);
      }
      if (code == 401 || code == 403) {
        throw new PollFailure(code, "登录凭据已过期：打开 App 重新输一次访问密码", false, null);
      }
      if (code != 200) {
        throw new PollFailure(code, "电脑上的插件回了 HTTP " + code + "，正在重试…", true, null);
      }
      String text;
      try {
        text = readBody(conn.getInputStream());
      } catch (Exception err) {
        throw unreachable("读响应失败", err);
      }
      JSONObject json;
      try {
        json = new JSONObject(text);
      } catch (Exception err) {
        // 端点答的不是 JSON：多半是上游那张 SPA 页面（插件太旧，请求被转给了 DSH 自己）
        throw new PollFailure(code, "电脑上的插件没有通知接口（返回的不是 JSON），去更新它", false, err);
      }
      if (json.optBoolean("ok", false)) lastRev = json.optInt("rev", lastRev);
      return json;
    } catch (PollFailure failure) {
      throw failure;
    } finally {
      try {
        conn.disconnect();
      } catch (Exception ignored) {
        // 断开失败无所谓
      }
    }
  }

  private static String readBody(InputStream stream) throws Exception {
    StringBuilder text = new StringBuilder();
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
      char[] buffer = new char[4096];
      int read;
      while ((read = reader.read(buffer)) > 0) {
        text.append(buffer, 0, read);
        if (text.length() > MAX_BODY_CHARS) throw new IllegalStateException("响应过大");
      }
    }
    return text.toString();
  }

  private void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }

  // ---------------------------------------------------------------- 通知环境（自检）

  /** App 的 versionName；问一次就缓存（PackageManager 每次都要走一遍 Binder） */
  private String appVersion() {
    if (cachedVersion != null) return cachedVersion;
    try {
      cachedVersion = String.valueOf(getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
    } catch (Throwable err) {
      cachedVersion = "";
    }
    return cachedVersion;
  }

  private static String urlEncode(String text) {
    try {
      return java.net.URLEncoder.encode(text == null ? "" : text, "UTF-8");
    } catch (Exception err) {
      return "";
    }
  }

  /** 通知总开关（Android 13+ 就是 POST_NOTIFICATIONS） */
  private boolean notificationsEnabled() {
    try {
      NotificationManager manager = getSystemService(NotificationManager.class);
      return manager == null || manager.areNotificationsEnabled();
    } catch (Throwable err) {
      return true; // 问不出来就别误报
    }
  }

  /** 「模型提问」通道当前的重要性；查不到返回 0 */
  private int choiceChannelImportance() {
    try {
      NotificationManager manager = getSystemService(NotificationManager.class);
      NotificationChannel channel = manager == null ? null : manager.getNotificationChannel(CHANNEL_CHOICE);
      return channel == null ? 0 : channel.getImportance();
    } catch (Throwable err) {
      return 0;
    }
  }

  /**
   * 手机上「明明发了通知却弹不出来」的两个**可检测**原因；没问题时返回空串。
   *
   * 检测得到的是通知权限与通道重要性；检测不到的是厂商那一层（小米的「悬浮通知/横幅通知」开关、
   * 「后台弹出界面」权限、勿扰模式）——那些只能靠用户去系统设置里打开，所以这里给一条
   * 「点这条去改」的入口（通知上的按钮直接跳到该通道的设置页）。
   */
  private String alertBlockedHint() {
    try {
      if (!notificationsEnabled()) return "手机没给 DSH 通知权限，弹不出来 —— 点这条去打开";
      int importance = choiceChannelImportance();
      if (importance > 0 && importance < NotificationManager.IMPORTANCE_HIGH) {
        return "「模型提问」通道重要性被调低了（现在 " + importance + "），横幅弹不出来 —— 点这条去改";
      }
    } catch (Throwable ignored) {
      // 查不出来就不说
    }
    return "";
  }

  // ---------------------------------------------------------------- 该不该响

  /**
   * 把宿主那份状态落到通知上。
   *
   * 「该响」= 宿主开着通知 + 有待答选择 + App 不在前台 + （配置要求时）电脑窗口不可见。
   * 窗口可见性由电脑上那一页自己回报；它一旦过期（窗口关了 / 电脑休眠），宿主就按「不可见」报，
   * 也就是会响 —— 失效方向是「多提醒一次」，不是「该提醒时没提醒」。
   */
  private void applyState(JSONObject json) {
    boolean enabled = json.optBoolean("enabled", true);
    boolean onlyWindowHidden = json.optBoolean("onlyWhenWindowHidden", true);
    JSONObject desktop = json.optJSONObject("desktop");
    boolean desktopVisible = desktop != null && desktop.optBoolean("visible", false);
    JSONArray pending = json.optJSONArray("pending");
    int count = pending == null ? 0 : pending.length();

    boolean alert = enabled && count > 0 && !activityVisible && (!onlyWindowHidden || !desktopVisible);
    if (!alert) {
      cancelChoice();
      String why = !enabled
          ? "提示已在「设置 → 远程访问」里关掉"
          : activityVisible
              ? "你正在看 App，模型提问会显示在页面上"
              : onlyWindowHidden && desktopVisible
                  ? "电脑上的 DSH 窗口正开着，不打扰你"
                  : "模型提问时会在这里提醒你";
      updateOngoing(why);
      return;
    }

    JSONObject first = pending.optJSONObject(0);
    String title = text(first, "header");
    if (title.isEmpty()) title = "DSH 需要你选择";
    StringBuilder body = new StringBuilder(text(first, "question"));
    if (body.length() == 0) body.append("模型在等你选择");
    JSONArray options = first == null ? null : first.optJSONArray("options");
    if (options != null && options.length() > 0) {
      body.append("\n");
      for (int i = 0; i < options.length(); i++) {
        if (i > 0) body.append(" / ");
        body.append(options.optString(i, "").trim());
      }
    }
    int questions = first == null ? 1 : first.optInt("count", 1);
    if (questions > 1) body.append("\n（这一批共 ").append(questions).append(" 个问题）");

    String text = body.toString();
    String fingerprint = title + "\n" + text;
    String id = first == null ? "" : first.optString("id", "");
    if (fingerprint.equals(shownFingerprint)) {
      // 同一条问题：还挂在通知栏上就什么都别做；被用户划掉了就记下来，别每隔 20 秒再弹一次
      if (choiceActive()) return;
      dismissedId = id;
      return;
    }
    dismissedId = "";
    shownFingerprint = fingerprint;
    notifyChoice(title, text);
    updateOngoing("有 " + count + " 个选择在等你");
  }

  private static String text(JSONObject object, String key) {
    if (object == null) return "";
    return object.optString(key, "").trim();
  }

  // ---------------------------------------------------------------- 通知

  private void startAsForeground(String text) {
    Notification notification = new Notification.Builder(this, CHANNEL_ONGOING)
        .setSmallIcon(R.drawable.ic_notify_watch)
        .setContentTitle("DSH 后台待命")
        .setContentText(text)
        .setContentIntent(openApp())
        .setOngoing(true)
        .setShowWhen(false)
        .setCategory(Notification.CATEGORY_SERVICE)
        .build();
    ongoingText = text;
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        // Android 14 起前台服务必须声明类型，否则启动即抛异常（清单里也声明了 specialUse）
        startForeground(ID_ONGOING, notification, foregroundType());
      } else {
        startForeground(ID_ONGOING, notification);
      }
    } catch (Throwable err) {
      // 后台启动前台服务被系统拒绝（Android 12+ 的限制）时别把服务崩掉，安静收工
      Log.w(TAG, "起前台服务失败: " + err);
      stopSelf();
    }
  }

  private static int foregroundType() {
    if (Build.VERSION.SDK_INT < 34) return 0;
    return ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
  }

  private void updateOngoing(String text) {
    String hint = alertBlockedHint();
    String line = hint.isEmpty() ? text : hint;
    if (line.equals(ongoingText)) return;
    ongoingText = line;
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return;
    try {
      Notification.Builder builder = new Notification.Builder(this, CHANNEL_ONGOING)
          .setSmallIcon(R.drawable.ic_notify_watch)
          .setContentTitle("DSH 后台待命")
          .setContentText(line)
          .setStyle(new Notification.BigTextStyle().bigText(line))
          .setContentIntent(openApp())
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setShowWhen(false)
          .setCategory(Notification.CATEGORY_SERVICE);
      // 弹不出来时，这条常驻通知本身就是入口：点按钮直接跳到「模型提问」通道的设置页
      if (!hint.isEmpty()) builder.addAction(channelSettingsAction());
      manager.notify(ID_ONGOING, builder.build());
    } catch (Throwable err) {
      Log.w(TAG, "更新常驻通知失败: " + err);
    }
  }

  /**
   * 发那条「模型在等你选择」的通知 —— 它必须**从屏幕顶部弹出来**（横幅 / heads-up），
   * 像收到一条微信那样，而不是静静躺进状态栏。
   *
   * Android 上要弹出横幅得同时满足几件事，这里一件件落实（缺一件就只剩状态栏一个图标）：
   *   1. 通道重要性必须是 IMPORTANCE_HIGH（在 onCreate 里建，用户若手动调低就只能去系统设置改回）；
   *   2. 通知本身声明为高优先级、响铃 + 震动（26 以后看通道，但写出来对老系统与厂商 ROM 更稳）；
   *   3. **必须是一条新通知**：更新同 id 的旧通知时，系统不保证再弹一次 ——
   *      所以每条问题轮流用两个 id 发（下一条问题 = 一次真正的「新通知」），旧的那条顺手撤掉；
   *   4. 分类是 CATEGORY_MESSAGE、可见性 PUBLIC，让它按「消息」而不是「后台服务」来对待；
   *   5. 不能是常驻/仅提示一次（setOngoing(false)、setOnlyAlertOnce(false)）。
   *
   * 还剩两件代码管不了的：用户把「模型提问」通道关成静音/关了「横幅」开关（国产 ROM 里常见），
   * 或者开着勿扰。这两种情况在 README 的排查一节里写清楚了。
   */
  private void notifyChoice(String title, String text) {
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return;
    // 换一个新 id：同时撤销上一条，保证系统把它当成「新消息」弹一次横幅
    int previous = choiceId;
    int next = previous == ID_CHOICE_A ? ID_CHOICE_B : ID_CHOICE_A;
    try {
      Notification.Builder builder = new Notification.Builder(this, CHANNEL_CHOICE)
          .setSmallIcon(R.drawable.ic_notify_choice)
          .setContentTitle(title)
          .setContentText(text)
          .setStyle(new Notification.BigTextStyle().bigText(text))
          .setContentIntent(openApp())
          .setAutoCancel(true)
          .setOngoing(false)
          .setOnlyAlertOnce(false)
          .setCategory(Notification.CATEGORY_MESSAGE)
          .setPriority(Notification.PRIORITY_MAX)
          .setDefaults(Notification.DEFAULT_ALL)
          .setVisibility(Notification.VISIBILITY_PUBLIC)
          .setWhen(System.currentTimeMillis())
          .setShowWhen(true)
          .setTicker(text);
      // 「发了但不弹」时的出口：厂商把横幅关掉（小米的「悬浮通知」、后台弹出界面…）只有用户能开，
      // 所以这条通知上直接给一个跳到「模型提问」通道设置页的按钮。
      builder.addAction(channelSettingsAction());
      manager.notify(next, builder.build());
      choiceId = next;
      if (previous != 0 && previous != next) manager.cancel(previous);
    } catch (Throwable err) {
      Log.w(TAG, "发通知失败: " + err);
    }
  }

  private void cancelChoice() {
    shownFingerprint = "";
    dismissedId = "";
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) {
      choiceId = 0;
      return;
    }
    try {
      manager.cancel(ID_CHOICE_A);
      manager.cancel(ID_CHOICE_B);
    } catch (Throwable ignored) {
      // 取消失败无所谓：下一次状态变化还会再撤一次
    }
    choiceId = 0;
  }

  /** 那条「等你选择」的通知还在不在（用户划掉了就要允许再发一次） */
  private boolean choiceActive() {
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return false;
    if (choiceId == 0) return false;
    try {
      for (android.service.notification.StatusBarNotification active : manager.getActiveNotifications()) {
        if (active.getId() == choiceId) return true;
      }
    } catch (Throwable err) {
      return true; // 问不出来就当它还在，避免反复重发
    }
    return false;
  }

  /** 点通知回到 App（复用已经在后台的那个实例，不新建） */
  private PendingIntent openApp() {
    Intent open = new Intent(this, MainActivity.class);
    open.setAction(Intent.ACTION_MAIN);
    open.addCategory(Intent.CATEGORY_LAUNCHER);
    open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    return PendingIntent.getActivity(
        this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  /**
   * 「去改通知设置」那个按钮：直接落到「模型提问」通道的设置页。
   * 厂商那层开关（小米的「悬浮通知 / 横幅通知」、后台弹出界面）就在那一页里，用户找起来最快。
   */
  private Notification.Action channelSettingsAction() {
    Intent intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
        .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_CHOICE)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    PendingIntent pending = PendingIntent.getActivity(
        this, 2, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Action.Builder(
        Icon.createWithResource(this, R.drawable.ic_notify_choice), "去开启横幅", pending).build();
  }
}
