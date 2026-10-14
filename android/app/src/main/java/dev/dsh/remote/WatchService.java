package dev.dsh.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
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
  /** 「模型在等你选择」那条会响的通知 */
  static final int ID_CHOICE = 1002;

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
  /** 常驻通知当前那行文案：一样就不重复刷 */
  private String ongoingText = "";

  // ---------------------------------------------------------------- 生命周期

  @Override
  public void onCreate() {
    super.onCreate();
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return;
    // 两条通道分别对应两种打扰程度：常驻那条不能响（否则每次回后台都震一下）
    NotificationChannel watch = new NotificationChannel(
        CHANNEL_ONGOING, "后台待命", NotificationManager.IMPORTANCE_LOW);
    watch.setDescription("App 退到后台时保持连接，好在模型提问时提醒你");
    watch.setShowBadge(false);
    NotificationChannel choice = new NotificationChannel(
        CHANNEL_CHOICE, "模型提问", NotificationManager.IMPORTANCE_HIGH);
    choice.setDescription("模型需要你选择时提醒（形如「要用哪个方案？」）");
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
      manager.cancel(ID_CHOICE);
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
    HttpURLConnection conn;
    try {
      conn = (HttpURLConnection) new URL(base + "/__remote_access__/notify?rev=" + rev + "&wait=" + POLL_WAIT_SECONDS)
          .openConnection();
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
    if (text.equals(ongoingText)) return;
    ongoingText = text;
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return;
    try {
      manager.notify(ID_ONGOING, new Notification.Builder(this, CHANNEL_ONGOING)
          .setSmallIcon(R.drawable.ic_notify_watch)
          .setContentTitle("DSH 后台待命")
          .setContentText(text)
          .setContentIntent(openApp())
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setShowWhen(false)
          .setCategory(Notification.CATEGORY_SERVICE)
          .build());
    } catch (Throwable err) {
      Log.w(TAG, "更新常驻通知失败: " + err);
    }
  }

  private void notifyChoice(String title, String text) {
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return;
    try {
      manager.notify(ID_CHOICE, new Notification.Builder(this, CHANNEL_CHOICE)
          .setSmallIcon(R.drawable.ic_notify_choice)
          .setContentTitle(title)
          .setContentText(text)
          .setStyle(new Notification.BigTextStyle().bigText(text))
          .setContentIntent(openApp())
          .setAutoCancel(true)
          .setCategory(Notification.CATEGORY_MESSAGE)
          .setPriority(Notification.PRIORITY_HIGH)
          .build());
    } catch (Throwable err) {
      Log.w(TAG, "发通知失败: " + err);
    }
  }

  private void cancelChoice() {
    shownFingerprint = "";
    dismissedId = "";
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager != null) manager.cancel(ID_CHOICE);
  }

  /** 那条「等你选择」的通知还在不在（用户划掉了就要允许再发一次） */
  private boolean choiceActive() {
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return false;
    try {
      for (android.service.notification.StatusBarNotification active : manager.getActiveNotifications()) {
        if (active.getId() == ID_CHOICE) return true;
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
}
