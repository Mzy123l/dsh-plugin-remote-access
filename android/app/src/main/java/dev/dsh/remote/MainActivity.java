package dev.dsh.remote;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
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
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * DSH 的安卓外壳：地址页（卡片） + 错误页 + 网页，外加两枚「融进页面」的小图标。
 *
 * 三块界面一次只显示一块：
 *   1) 地址页 —— 首次启动 / 点右上角设置 / 从错误页点「改地址」；卡片式，只填 host[:port]，不带协议；
 *   2) 错误页 —— 把 WebView 的错误码翻成人话（解析不了 / 连不上 / 超时），给「重试」与「改地址」；
 *   3) 网页 —— WebView + 右上角一枚半透明胶囊里的两个小图标（设置 / 刷新），没有横条、没有文字按钮；
 *      顶部一条 3dp 进度线；首次连上时提示「首次要下插件、之后走缓存」。
 *
 * 为什么地址页必须能离线进：地址错了/电脑没开时网页里什么都显示不了，
 * 如果设置藏在网页里，就永远改不回来。
 */
public class MainActivity extends Activity {

  private static final String PREFS = "dsh_remote";
  private static final String KEY_HOST = "host";
  private static final String KEY_TLS = "tls";
  private static final String KEY_WARMED = "warmed";

  /** host[:port]：字母数字点横线 + 可选端口；不收协议、路径、空格 */
  private static final java.util.regex.Pattern HOST_RE =
      java.util.regex.Pattern.compile("^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?(:\\d{1,5})?$");

  private static final int REQ_FILE = 1001;

  private FrameLayout root;
  private ScrollView setupView;
  private FrameLayout errorView;
  private FrameLayout webHost;
  private EditText hostInput;
  /** 地址页左上角的返回：只在「已经连过、又点设置进来」的时候出现 */
  private ImageButton setupBack;
  /** 是否已经载入过页面 —— 决定地址页要不要给「返回」 */
  private boolean webLoaded = false;
  private CheckBox tlsCheck;
  private TextView setupError;
  private TextView errorTitle;
  private TextView errorDetail;
  private TextView loadHint;
  private ProgressBar progress;
  private WebView web;
  private ValueCallback<Uri[]> fileCallback;

  private int bgColor;
  private int cardColor;
  private int fgColor;
  private int mutedColor;
  private int lineColor;
  private int fieldColor;
  private int accentColor;
  private int errorColor;
  private boolean dark;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    readPalette();
    root = new FrameLayout(this);
    root.setBackgroundColor(bgColor);
    setContentView(root);

    buildSetupView();
    buildErrorView();
    buildWebView();

    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    String saved = prefs.getString(KEY_HOST, "");
    tlsCheck.setChecked(prefs.getBoolean(KEY_TLS, false));
    if (saved == null || saved.trim().isEmpty()) {
      showSetup(null);
    } else {
      hostInput.setText(saved);
      connect(saved, prefs.getBoolean(KEY_TLS, false));
    }
  }

  // ---------------------------------------------------------------- 配色与小工具

  private void readPalette() {
    dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
        == Configuration.UI_MODE_NIGHT_YES;
    bgColor = dark ? 0xFF0B0D12 : 0xFFF2F5FB;
    cardColor = dark ? 0xFF141821 : 0xFFFFFFFF;
    fgColor = dark ? 0xFFE8EAED : 0xFF0F172A;
    mutedColor = dark ? 0xFF9AA4B2 : 0xFF64748B;
    lineColor = dark ? 0xFF242A36 : 0xFFE2E8F0;
    fieldColor = dark ? 0xFF0F131A : 0xFFF8FAFC;
    accentColor = dark ? 0xFF3B82F6 : 0xFF2563EB;
    errorColor = dark ? 0xFFF87171 : 0xFFDC2626;
  }

  private int dp(float v) {
    return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
  }

  private GradientDrawable rounded(int fill, float radiusDp, int strokeColor, float strokeDp) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(fill);
    d.setCornerRadius(dp(radiusDp));
    if (strokeDp > 0) d.setStroke(dp(strokeDp), strokeColor);
    return d;
  }

  private TextView label(String text, float sizeSp, int color, boolean bold) {
    TextView t = new TextView(this);
    t.setText(text);
    t.setTextSize(sizeSp);
    t.setTextColor(color);
    if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
    return t;
  }

  private LinearLayout card() {
    LinearLayout c = new LinearLayout(this);
    c.setOrientation(LinearLayout.VERTICAL);
    c.setBackground(rounded(cardColor, 18, lineColor, 1));
    int p = dp(20);
    c.setPadding(p, p, p, p);
    return c;
  }

  private Button primaryButton(String text) {
    Button b = new Button(this);
    b.setText(text);
    b.setTextSize(16);
    b.setAllCaps(false);
    b.setTextColor(Color.WHITE);
    b.setBackground(rounded(accentColor, 12, 0, 0));
    b.setMinHeight(dp(48));
    b.setPadding(0, 0, 0, 0);
    return b;
  }

  private TextView ghostButton(String text) {
    TextView b = label(text, 15, accentColor, false);
    int p = dp(14);
    b.setPadding(p, p, p, p);
    b.setGravity(Gravity.CENTER);
    b.setBackground(rounded(dark ? 0xFF1B2130 : 0xFFEDF2FB, 12, 0, 0));
    return b;
  }

  // ---------------------------------------------------------------- 1) 地址页

  private void buildSetupView() {
    LinearLayout column = new LinearLayout(this);
    column.setOrientation(LinearLayout.VERTICAL);
    int p = dp(20);
    column.setPadding(p, dp(28), p, dp(28));

    // 左上角返回：从网页点「设置」进来时才有意义（首次启动没有「回去」可回，所以那时不显示）
    setupBack = iconButton(R.drawable.ic_back, "返回");
    setupBack.setOnClickListener(v -> {
      setupView.setVisibility(View.GONE);
      errorView.setVisibility(View.GONE);
      webHost.setVisibility(View.VISIBLE);
    });
    setupBack.setVisibility(View.GONE);
    LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(dp(40), dp(40));
    backParams.bottomMargin = dp(6);
    column.addView(setupBack, backParams);

    LinearLayout brand = new LinearLayout(this);
    brand.setOrientation(LinearLayout.HORIZONTAL);
    brand.setGravity(Gravity.CENTER_VERTICAL);
    TextView mark = label("DSH", 13, Color.WHITE, true);
    mark.setGravity(Gravity.CENTER);
    mark.setBackground(rounded(accentColor, 10, 0, 0));
    brand.addView(mark, new LinearLayout.LayoutParams(dp(38), dp(38)));
    brand.addView(label("  远程访问", 16, fgColor, true));
    LinearLayout.LayoutParams brandParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    brandParams.bottomMargin = dp(16);
    column.addView(brand, brandParams);

    LinearLayout c = card();
    c.addView(label("连接到电脑上的 DSH", 19, fgColor, true));
    TextView sub = label("填电脑上 DSH 的远程访问地址：只写 IP 或域名，端口写在冒号后面。", 13, mutedColor, false);
    sub.setPadding(0, dp(4), 0, dp(16));
    c.addView(sub);

    c.addView(label("服务器地址", 12, mutedColor, false));
    hostInput = new EditText(this);
    hostInput.setHint("100.64.0.3:19388");
    hostInput.setHintTextColor(mutedColor);
    hostInput.setTextColor(fgColor);
    hostInput.setTextSize(18);
    hostInput.setSingleLine(true);
    hostInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    hostInput.setImeOptions(EditorInfo.IME_ACTION_GO);
    hostInput.setBackground(rounded(fieldColor, 12, lineColor, 1));
    int hp = dp(12);
    hostInput.setPadding(hp, hp, hp, hp);
    LinearLayout.LayoutParams hostParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    hostParams.topMargin = dp(6);
    c.addView(hostInput, hostParams);

    tlsCheck = new CheckBox(this);
    tlsCheck.setText("用 HTTPS（反代开了 TLS 才勾）");
    tlsCheck.setTextColor(mutedColor);
    tlsCheck.setTextSize(13);
    LinearLayout.LayoutParams tlsParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    tlsParams.topMargin = dp(8);
    c.addView(tlsCheck, tlsParams);

    Button connect = primaryButton("连接");
    connect.setOnClickListener(v -> connect(hostInput.getText().toString(), tlsCheck.isChecked()));
    LinearLayout.LayoutParams connectParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    connectParams.topMargin = dp(12);
    c.addView(connect, connectParams);

    setupError = label("", 13, errorColor, false);
    setupError.setPadding(0, dp(10), 0, 0);
    c.addView(setupError);

    column.addView(c);

    TextView where = label("地址在哪找：电脑上「设置 → 远程访问」的状态文件 remote-access-url.txt，"
        + "里面『手机访问』那一行。\n设了访问密码的，连上后在页面里输一次（30 天免密）。", 12, mutedColor, false);
    where.setLineSpacing(0, 1.35f);
    where.setPadding(0, dp(14), 0, 0);
    column.addView(where);

    setupView = new ScrollView(this);
    setupView.setFillViewport(true);
    setupView.addView(column);
    root.addView(setupView, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  private void showSetup(String message) {
    setupError.setText(message == null ? "" : message);
    if (setupBack != null) setupBack.setVisibility(webLoaded ? View.VISIBLE : View.GONE);
    setupView.setVisibility(View.VISIBLE);
    errorView.setVisibility(View.GONE);
    webHost.setVisibility(View.GONE);
  }

  // ---------------------------------------------------------------- 2) 错误页

  private void buildErrorView() {
    LinearLayout column = new LinearLayout(this);
    column.setOrientation(LinearLayout.VERTICAL);
    int p = dp(20);
    column.setPadding(p, dp(28), p, dp(28));

    LinearLayout c = card();
    TextView mark = label("!", 20, Color.WHITE, true);
    mark.setGravity(Gravity.CENTER);
    mark.setBackground(rounded(errorColor, 12, 0, 0));
    LinearLayout.LayoutParams markParams = new LinearLayout.LayoutParams(dp(44), dp(44));
    markParams.bottomMargin = dp(14);
    c.addView(mark, markParams);

    errorTitle = label("连不上这台设备", 19, fgColor, true);
    c.addView(errorTitle);
    errorDetail = label("", 13, mutedColor, false);
    errorDetail.setLineSpacing(0, 1.35f);
    errorDetail.setPadding(0, dp(6), 0, dp(16));
    c.addView(errorDetail);

    Button retry = primaryButton("重试");
    retry.setOnClickListener(v -> {
      String host = hostInput.getText().toString().trim();
      if (host.isEmpty()) showSetup("先填地址：形如 100.64.0.3:19388");
      else connect(host, tlsCheck.isChecked());
    });
    c.addView(retry);

    TextView change = ghostButton("改地址");
    change.setOnClickListener(v -> showSetup("把地址改对再点连接。"));
    LinearLayout.LayoutParams changeParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    changeParams.topMargin = dp(10);
    c.addView(change, changeParams);

    column.addView(c);

    errorView = new FrameLayout(this);
    errorView.addView(column, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    errorView.setVisibility(View.GONE);
    root.addView(errorView, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  /** 把 WebView 的错误码翻成人话 —— 它自带那句英文说明对手机用户没有用 */
  private void showError(String url, int errorCode, CharSequence description) {
    String reason;
    switch (errorCode) {
      case WebViewClient.ERROR_HOST_LOOKUP:
        reason = "域名解析不了：地址可能打错了，或者当前网络拿不到 DNS。";
        break;
      case WebViewClient.ERROR_CONNECT:
      case WebViewClient.ERROR_FAILED_SSL_HANDSHAKE:
        reason = "地址通了但端口连不上：电脑上的 DSH 没开、端口不对，或者不在同一网段。";
        break;
      case WebViewClient.ERROR_TIMEOUT:
        reason = "等太久没回应：网络慢，或者那台电脑不在线。";
        break;
      case WebViewClient.ERROR_IO:
        reason = "网络读写失败：多半是不在同一网络（比如没连上 Tailscale）。";
        break;
      default:
        reason = "加载失败：" + description + "。";
        break;
    }
    errorTitle.setText("打不开 " + url);
    errorDetail.setText(reason + "\n\n检查完点「重试」，或点「改地址」换一个。");
    errorView.setVisibility(View.VISIBLE);
    setupView.setVisibility(View.GONE);
    webHost.setVisibility(View.GONE);
    progress.setVisibility(View.GONE);
  }

  // ---------------------------------------------------------------- 3) 网页 + 悬浮图标

  private void buildWebView() {
    webHost = new FrameLayout(this);

    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
    s.setCacheMode(WebSettings.LOAD_DEFAULT);
    CookieManager cookies = CookieManager.getInstance();
    cookies.setAcceptCookie(true);
    cookies.setAcceptThirdPartyCookies(web, true);
    webHost.addView(web, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        String scheme = u.getScheme() == null ? "" : u.getScheme();
        if ("http".equals(scheme) || "https".equals(scheme)) return false; // 站内继续用本 WebView
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) {
          // 设备上没有能接这个 scheme 的应用，忽略
        }
        return true;
      }

      @Override
      public void onPageFinished(WebView view, String url) {
        progress.setVisibility(View.GONE);
        loadHint.setVisibility(View.GONE);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_WARMED, true).apply();
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request == null || !request.isForMainFrame()) return;
        showError(String.valueOf(request.getUrl()), error.getErrorCode(), error.getDescription());
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onProgressChanged(WebView view, int newProgress) {
        progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        progress.setProgress(newProgress);
        if (newProgress >= 60) loadHint.setVisibility(View.GONE);
      }

      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
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

    // 首次加载提示：只对「还没成功连上过」的设备显示一次
    loadHint = label("首次加载要下载插件（十几 MB），只有第一次慢；之后走缓存秒开", 12, fgColor, false);
    loadHint.setGravity(Gravity.CENTER);
    loadHint.setLineSpacing(0, 1.3f);
    int lp = dp(10);
    loadHint.setPadding(lp, lp, lp, lp);
    loadHint.setBackground(rounded(dark ? 0xE61B2130 : 0xF2FFFFFF, 12, lineColor, 1));
    FrameLayout.LayoutParams hintParams = new FrameLayout.LayoutParams(dp(300), ViewGroup.LayoutParams.WRAP_CONTENT);
    hintParams.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
    hintParams.topMargin = dp(18);
    loadHint.setVisibility(View.GONE);
    webHost.addView(loadHint, hintParams);

    // 两个小图标：右上角一枚半透明胶囊，放着会自己淡下去，点一下回来
    // 两枚小图标：竖着贴在**左侧图标栏下方的空白处**（那一列图标下面是空的；顺手也不挡顶部工具栏、
    // 右栏把手与输入区）。放着会自己淡下去，点一下回来。
    LinearLayout pill = new LinearLayout(this);
    pill.setOrientation(LinearLayout.VERTICAL);
    pill.setGravity(Gravity.CENTER_HORIZONTAL);
    pill.setAlpha(0.9f);
    pill.setBackground(rounded(dark ? 0xD9141821 : 0xE6FFFFFF, 20, lineColor, 1));
    int pp = dp(3);
    pill.setPadding(pp, pp, pp, pp);

    ImageButton settings = iconButton(android.R.drawable.ic_menu_preferences, "设置");
    settings.setOnClickListener(v -> showSetup(null));
    pill.addView(settings, new LinearLayout.LayoutParams(dp(34), dp(34)));

    ImageButton reload = iconButton(android.R.drawable.ic_popup_sync, "刷新");
    reload.setOnClickListener(v -> web.reload());
    pill.addView(reload, new LinearLayout.LayoutParams(dp(34), dp(34)));

    FrameLayout.LayoutParams pillParams = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    // 左抽屉收起时是一条 56px 宽的图标栏；6dp 让 34dp 的图标略靠左，52dp 把它抬到列表上方
    pillParams.gravity = Gravity.BOTTOM | Gravity.START;
    pillParams.leftMargin = dp(6);
    pillParams.bottomMargin = dp(52);
    webHost.addView(pill, pillParams);

    pill.postDelayed(() -> pill.animate().alpha(0.3f).setDuration(400), 3500);
    pill.setOnClickListener(v -> pill.animate().alpha(0.95f).setDuration(150));

    progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progress.setMax(100);
    progress.setProgressTintList(ColorStateList.valueOf(accentColor));
    progress.setProgressBackgroundTintList(ColorStateList.valueOf(Color.TRANSPARENT));
    progress.setVisibility(View.GONE);
    FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
    progressParams.gravity = Gravity.TOP;
    webHost.addView(progress, progressParams);

    webHost.setVisibility(View.GONE);
    root.addView(webHost, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  private ImageButton iconButton(int drawable, String description) {
    ImageButton b = new ImageButton(this);
    b.setImageResource(drawable);
    b.setContentDescription(description);
    b.setColorFilter(dark ? 0xFFE8EAED : 0xFF334155);
    b.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
    b.setBackgroundColor(Color.TRANSPARENT);
    b.setPadding(dp(8), dp(8), dp(8), dp(8));
    return b;
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

  /** 规范化输入并开网页：raw 只允许 host[:port]，协议由 tls 决定 */
  private void connect(String raw, boolean tls) {
    String host = raw == null ? "" : raw.trim();
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

    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    prefs.edit().putString(KEY_HOST, host).putBoolean(KEY_TLS, tls).apply();

    hostInput.setText(host);
    setupView.setVisibility(View.GONE);
    errorView.setVisibility(View.GONE);
    webLoaded = true;
    webHost.setVisibility(View.VISIBLE);
    progress.setVisibility(View.VISIBLE);
    progress.setProgress(5);
    loadHint.setVisibility(prefs.getBoolean(KEY_WARMED, false) ? View.GONE : View.VISIBLE);
    web.loadUrl((tls ? "https://" : "http://") + host + "/");
  }

  @Override
  public void onBackPressed() {
    // 地址页开着、而且之前已经连上过：返回键就是「回到网页」，不用重新连
    if (setupView != null && setupView.getVisibility() == View.VISIBLE && webLoaded && webHost != null) {
      setupView.setVisibility(View.GONE);
      webHost.setVisibility(View.VISIBLE);
      return;
    }
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
