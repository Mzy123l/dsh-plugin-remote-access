package dev.dsh.remote;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * DSH 远程访问的安卓外壳：一个「地址页」 + 一个 WebView。
 *
 * 为什么地址页要放最前面、而且离线也必须能进：
 *   1) 第一次打开时还没有地址，只能先问；
 *   2) 地址填错 / 网没通 / 电脑没开时，WebView 里显示不了任何 DSH 界面 ——
 *      如果设置藏在网页里，就永远改不回来了。所以这里：
 *      首屏就是地址页、WebView 失败时自动退回地址页、顶栏永远有「设置」按钮。
 *
 * 地址只填 host[:port]，不带协议（协议由「用 HTTPS」这一个勾决定），
 * 例：100.64.0.3:19388 或 dsh.example.com
 */
public class MainActivity extends Activity {

  private static final String PREFS = "dsh_remote";
  private static final String KEY_HOST = "host";
  private static final String KEY_TLS = "tls";

  /** host[:port]：字母数字点横线 + 可选端口；故意不收协议、路径、空格 */
  private static final java.util.regex.Pattern HOST_RE =
      java.util.regex.Pattern.compile("^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?(:\\d{1,5})?$");

  private static final int REQ_FILE = 1001;

  private FrameLayout root;
  private ScrollView setupView;
  private LinearLayout webHost;
  private EditText hostInput;
  private CheckBox tlsCheck;
  private TextView setupStatus;
  private TextView titleView;
  private ProgressBar progress;
  private WebView web;
  private ValueCallback<Uri[]> fileCallback;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    root = new FrameLayout(this);
    setContentView(root);
    buildSetupView();
    buildWebView();

    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    String saved = prefs.getString(KEY_HOST, "");
    boolean tls = prefs.getBoolean(KEY_TLS, false);
    tlsCheck.setChecked(tls);
    if (saved == null || saved.trim().isEmpty()) {
      showSetup("第一次使用：填上电脑那台的地址（形如 100.64.0.3:19388），协议不用写。");
    } else {
      hostInput.setText(saved);
      connect(saved, tls);
    }
  }

  private int dp(int v) {
    return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
  }

  // ---------------------------------------------------------------- 地址页

  private void buildSetupView() {
    LinearLayout column = new LinearLayout(this);
    column.setOrientation(LinearLayout.VERTICAL);
    column.setPadding(dp(20), dp(28), dp(20), dp(20));

    TextView title = new TextView(this);
    title.setText("DSH 远程");
    title.setTextSize(24);
    title.setPadding(0, 0, 0, dp(6));
    column.addView(title);

    TextView hint = new TextView(this);
    hint.setText("填电脑上 DSH 的远程访问地址。协议不用写；端口写在冒号后面（没写端口就是 80/443）。");
    hint.setTextSize(14);
    hint.setAlpha(0.75f);
    hint.setPadding(0, 0, 0, dp(18));
    column.addView(hint);

    hostInput = new EditText(this);
    hostInput.setHint("100.64.0.3:19388");
    hostInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    hostInput.setSingleLine(true);
    hostInput.setImeOptions(EditorInfo.IME_ACTION_GO);
    hostInput.setTextSize(18);
    column.addView(hostInput, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    tlsCheck = new CheckBox(this);
    tlsCheck.setText("用 HTTPS（反代开了 TLS 才勾）");
    tlsCheck.setPadding(0, dp(10), 0, dp(6));
    column.addView(tlsCheck);

    Button connectButton = new Button(this);
    connectButton.setText("连接");
    connectButton.setOnClickListener(v -> {
      String raw = hostInput.getText().toString();
      connect(raw, tlsCheck.isChecked());
    });
    column.addView(connectButton, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    setupStatus = new TextView(this);
    setupStatus.setTextSize(14);
    setupStatus.setPadding(0, dp(14), 0, 0);
    column.addView(setupStatus);

    TextView help = new TextView(this);
    help.setTextSize(13);
    help.setAlpha(0.6f);
    help.setPadding(0, dp(22), 0, 0);
    help.setText("地址在哪找：电脑上「设置 → 远程访问」里的状态文件 "
        + "remote-access-url.txt，里面『手机访问』那一行就是。\n"
        + "填了访问密码的，连上后先在页面里输一次密码（30 天免密）。");
    column.addView(help);

    setupView = new ScrollView(this);
    setupView.addView(column);
    setupView.setBackgroundColor(Color.TRANSPARENT);
    root.addView(setupView, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  /** 回到地址页（可带一句原因）。WebView 失败、点「设置」、第一次启动都走这里。 */
  private void showSetup(String message) {
    if (message != null) setupStatus.setText(message);
    setupView.setVisibility(View.VISIBLE);
    webHost.setVisibility(View.GONE);
  }

  // ---------------------------------------------------------------- 网页

  private void buildWebView() {
    webHost = new LinearLayout(this);
    webHost.setOrientation(LinearLayout.VERTICAL);

    LinearLayout bar = new LinearLayout(this);
    bar.setOrientation(LinearLayout.HORIZONTAL);
    bar.setGravity(Gravity.CENTER_VERTICAL);
    bar.setPadding(dp(6), dp(4), dp(6), dp(4));

    Button settingsButton = new Button(this);
    settingsButton.setText("设置");
    settingsButton.setOnClickListener(v -> showSetup(null));
    bar.addView(settingsButton);

    Button backButton = new Button(this);
    backButton.setText("后退");
    backButton.setOnClickListener(v -> {
      if (web.canGoBack()) web.goBack();
    });
    bar.addView(backButton);

    Button reloadButton = new Button(this);
    reloadButton.setText("刷新");
    reloadButton.setOnClickListener(v -> web.reload());
    bar.addView(reloadButton);

    titleView = new TextView(this);
    titleView.setTextSize(13);
    titleView.setAlpha(0.7f);
    titleView.setSingleLine(true);
    titleView.setPadding(dp(8), 0, 0, 0);
    LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
        0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    bar.addView(titleView, titleParams);
    webHost.addView(bar, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progress.setMax(100);
    progress.setVisibility(View.GONE);
    webHost.addView(progress, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, dp(6)));

    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
    CookieManager cookies = CookieManager.getInstance();
    cookies.setAcceptCookie(true);
    cookies.setAcceptThirdPartyCookies(web, true);

    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        String scheme = u.getScheme() == null ? "" : u.getScheme();
        if ("http".equals(scheme) || "https".equals(scheme)) return false; // 站内继续用本 WebView
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) {
          // 设备上没人能接这个 scheme，忽略即可，不要崩
        }
        return true;
      }

      @Override
      public void onPageFinished(WebView view, String url) {
        progress.setVisibility(View.GONE);
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request == null || !request.isForMainFrame()) return;
        progress.setVisibility(View.GONE);
        // 连不上就退回地址页：这样「地址填错 / 电脑没开机 / 网段不对」都还能改回来
        showSetup("打不开 " + request.getUrl() + "：" + error.getDescription()
            + "\n把地址改对再点连接；地址没错就检查电脑上的 DSH 是否在跑、手机是否在同一网段。");
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onProgressChanged(WebView view, int newProgress) {
        progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        progress.setProgress(newProgress);
      }

      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
          FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        try {
          Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
          intent.addCategory(Intent.CATEGORY_OPENABLE);
          intent.setType("*/*");
          startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
          return true;
        } catch (Exception e) {
          fileCallback = null;
          return false;
        }
      }
    });

    webHost.addView(web, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

    root.addView(webHost, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == REQ_FILE) {
      Uri[] result = null;
      if (resultCode == RESULT_OK && data != null && data.getData() != null) {
        result = new Uri[] { data.getData() };
      }
      if (fileCallback != null) {
        fileCallback.onReceiveValue(result);
        fileCallback = null;
      }
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }

  // ---------------------------------------------------------------- 连接

  /** 规范化输入并开网页。raw 只允许 host[:port]；协议由 tls 决定。 */
  private void connect(String raw, boolean tls) {
    String host = raw == null ? "" : raw.trim();
    // 手滑粘了整条网址也不至于没法用：把协议和结尾的斜杠剥掉
    host = host.replaceFirst("(?i)^https?://", "");
    while (host.endsWith("/")) host = host.substring(0, host.length() - 1);
    host = host.replaceAll("\\s+", "");

    if (host.isEmpty()) {
      showSetup("请先填地址，例如 100.64.0.3:19388");
      return;
    }
    if (!HOST_RE.matcher(host).matches()) {
      showSetup("地址只能写成 IP或域名:端口（不要协议、不要路径、不要空格），例如 100.64.0.3:19388");
      return;
    }

    String url = (tls ? "https://" : "http://") + host + "/";
    SharedPreferences.Editor edit = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
    edit.putString(KEY_HOST, host);
    edit.putBoolean(KEY_TLS, tls);
    edit.apply();

    hostInput.setText(host);
    titleView.setText((tls ? "https://" : "http://") + host);
    setupView.setVisibility(View.GONE);
    webHost.setVisibility(View.VISIBLE);
    progress.setVisibility(View.VISIBLE);
    progress.setProgress(0);
    web.loadUrl(url);
  }

  @Override
  public void onBackPressed() {
    if (webHost != null && webHost.getVisibility() == View.VISIBLE && web != null && web.canGoBack()) {
      web.goBack();
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onPause() {
    super.onPause();
    if (web != null) web.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (web != null) web.onResume();
  }
}
