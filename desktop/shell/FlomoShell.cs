// flomo local 的无边框桌面外壳（WebView2 / WinForms）
// 用法：FlomoShell.exe <url> <appRoot>
// 特点：没有系统标题栏；顶部 16px 可拖动；四边 5px 可缩放；窗口控制按钮由页面发消息驱动。
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FlomoShell
{
    internal static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr wp, IntPtr lp);
        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll")] public static extern IntPtr SetCapture(IntPtr h);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
        [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
        [DllImport("gdi32.dll")] public static extern IntPtr CreatePolygonRgn(POINT[] pts, int count, int mode);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
    }

    internal sealed class ShellForm : Form
    {
        private const int WM_NCHITTEST = 0x0084;
        private const int WM_NCLBUTTONDBLCLK = 0x00A3;
        private const int HTCLIENT = 1, HTCAPTION = 2, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12,
            HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

        private readonly string _url;
        private readonly string _root;
        private readonly string _stateFile;
        private WebView2 _web;
        private Rectangle _restore = Rectangle.Empty;
        private bool _dragging;
        private bool _dragMoved;
        private Timer _dragTimer;
        private Native.POINT _dragCursor;
        private Point _dragWin;
        private bool _isMax;

        public ShellForm(string url, string root)
        {
            _url = url;
            _root = root;
            _stateFile = Path.Combine(root, "data", "shell-window.json");

            Text = "flomo local";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(243, 243, 247);
            MinimumSize = new Size(720, 520);
            KeyPreview = true;
            DoubleBuffered = true;
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            ApplySavedBounds();
            _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(243, 243, 247) };
            Controls.Add(_web);
            InitAsync();
        }

        private async void InitAsync()
        {
            try
            {
                // profile 放 LOCALAPPDATA，别把便携目录撑大
                var userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "flomolocal", "webview2");
                Directory.CreateDirectory(userData);
                var env = await CoreWebView2Environment.CreateAsync(null, userData, new CoreWebView2EnvironmentOptions());
                await _web.EnsureCoreWebView2Async(env);
                var core = _web.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = true;
                core.Settings.IsZoomControlEnabled = true;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.WebMessageReceived += OnWebMessage;
                core.NavigationCompleted += (s, args) => PostState();
                core.NewWindowRequested += (s, args) =>
                {
                    // 站内链接一律在当前窗口打开，外链交给系统浏览器
                    var uri = args.Uri ?? "";
                    if (uri.StartsWith("http://127.0.0.1") || uri.StartsWith("http://localhost")) return;
                    args.Handled = true;
                    try { System.Diagnostics.Process.Start(uri); } catch { }
                };
                core.Navigate(_url);
            }
            catch (Exception ex)
            {
                // WebView2 运行时缺失等情况：写日志后退出，由 launcher 回退到 Edge
                try
                {
                    Directory.CreateDirectory(Path.Combine(_root, "data"));
                    File.AppendAllText(Path.Combine(_root, "data", "shell.log"),
                        "[" + DateTime.Now.ToString("HH:mm:ss") + "] init failed: " + ex.Message + Environment.NewLine, Encoding.UTF8);
                }
                catch { }
                Environment.Exit(2);
            }
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json;
            try { json = e.WebMessageAsJson ?? ""; } catch { return; }
            LogAction("msg " + json);
            var hit = System.Text.RegularExpressions.Regex.Match(json, "\"hit:(\\d+)\"");
            if (hit.Success)
            {
                StartSystemHit(int.Parse(hit.Groups[1].Value));
                return;
            }
            if (json.IndexOf("\"minimize\"", StringComparison.Ordinal) >= 0) WindowState = FormWindowState.Minimized;
            else if (json.IndexOf("\"maximize\"", StringComparison.Ordinal) >= 0) ToggleMaximize();
            else if (json.IndexOf("\"close\"", StringComparison.Ordinal) >= 0) Close();
            else if (json.IndexOf("\"drag\"", StringComparison.Ordinal) >= 0) StartDrag();
        }

        /// <summary>把缩放交给系统窗口循环（页面在边缘按下时发 hit:N 过来）</summary>
        private void StartSystemHit(int ht)
        {
            try
            {
                Native.ReleaseCapture();
                Native.SendMessage(Handle, 0x00A1 /* WM_NCLBUTTONDOWN */, (IntPtr)ht, IntPtr.Zero);
            }
            catch { }
        }

        /// <summary>自己拖窗口：用定时器跟光标，不抢鼠标捕获，否则页面的双击事件收不到</summary>
        private void StartDrag()
        {
            Native.GetCursorPos(out _dragCursor);
            _dragWin = Location;
            _dragging = true;
            _dragMoved = false;
            if (_dragTimer == null)
            {
                _dragTimer = new Timer { Interval = 15 };
                _dragTimer.Tick += DragTick;
            }
            _dragTimer.Start();
        }

        private void DragTick(object sender, EventArgs e)
        {
            if (!_dragging) { _dragTimer.Stop(); return; }
            if ((Native.GetAsyncKeyState(0x01) & 0x8000) == 0)   // 左键已抬起
            {
                _dragging = false;
                _dragMoved = false;
                _dragTimer.Stop();
                return;
            }
            Native.POINT c;
            Native.GetCursorPos(out c);
            int dx = c.X - _dragCursor.X, dy = c.Y - _dragCursor.Y;
            if (!_dragMoved && Math.Abs(dx) < 3 && Math.Abs(dy) < 3) return;   // 3px 内不算拖动，保留双击
            _dragMoved = true;
            Location = new Point(_dragWin.X + dx, _dragWin.Y + dy);
        }

        private void PostState()
        {
            try
            {
                if (_web == null || _web.CoreWebView2 == null) return;
                _web.CoreWebView2.PostWebMessageAsJson(
                    "{\"type\":\"shell\",\"max\":" + ((_isMax || WindowState == FormWindowState.Maximized) ? "true" : "false") + "}");
            }
            catch { }
        }

        private void ToggleMaximize()
        {
            var wa = Screen.FromControl(this).WorkingArea;
            if (_isMax)
            {
                _isMax = false;
                if (_restore.Width >= 720 && _restore.Height >= 520) Bounds = _restore;
                else Bounds = new Rectangle(wa.X + 80, wa.Y + 60, 1220, 860);
            }
            else
            {
                // 只有当前不是"铺满工作区"时才记恢复尺寸，避免把最大化尺寸记成恢复尺寸
                if (Bounds.Width != wa.Width || Bounds.Height != wa.Height) _restore = Bounds;
                _isMax = true;
                Bounds = wa;
            }
            ApplyRoundedCorners();
            PostState();
            LogAction(_isMax ? "maximize" : "restore");
        }

        private void LogAction(string what)
        {
            try
            {
                Directory.CreateDirectory(Path.Combine(_root, "data"));
                File.AppendAllText(Path.Combine(_root, "data", "shell.log"),
                    "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + what + " " + Bounds + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                // 让 DWM 把它当标准窗口：有阴影、能圆角；仍然没有标题栏
                cp.Style |= 0x00040000;                     // WS_THICKFRAME
                cp.Style |= 0x00020000;                     // WS_MINIMIZEBOX（不要 MAXIMIZEBOX：系统最大化会盖住任务栏）
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyRoundedCorners();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (WindowState == FormWindowState.Maximized) _isMax = true;
            ApplyRegionRounding();
        }

        private static bool IsWin11()
        {
            return Environment.OSVersion.Version.Build >= 22000;
        }

        /// <summary>Win11 用 DWM 的圆角（抗锯齿）；Win10 退回区域裁剪</summary>
        private void ApplyRoundedCorners()
        {
            if (IsWin11())
            {
                try
                {
                    int pref = (_isMax || WindowState == FormWindowState.Maximized) ? 1 : 2;   // DONOTROUND / ROUND
                    Native.DwmSetWindowAttribute(Handle, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, ref pref, 4);
                    int none = unchecked((int)0xFFFFFFFE);   // DWMWA_COLOR_NONE：不要系统边框线
                    Native.DwmSetWindowAttribute(Handle, 34 /* DWMWA_BORDER_COLOR */, ref none, 4);
                    Native.SetWindowRgn(Handle, IntPtr.Zero, true);   // 清掉可能存在的旧区域
                    return;
                }
                catch { }
            }
            ApplyRegionRounding();
        }

        /// <summary>Win10 兜底：正圆弧区域裁剪</summary>
        private void ApplyRegionRounding()
        {
            try
            {
                if (_isMax || WindowState == FormWindowState.Maximized) { Native.SetWindowRgn(Handle, IntPtr.Zero, true); return; }
                const int radius = 16;
                var rgn = Native.CreateRoundRectRgn(0, 0, Width + 1, Height + 1, radius * 2, radius * 2);
                if (rgn != IntPtr.Zero) Native.SetWindowRgn(Handle, rgn, true);
            }
            catch { }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0083 /* WM_NCCALCSIZE */ && m.WParam != IntPtr.Zero)
            {
                m.Result = IntPtr.Zero;   // 客户区铺满整个窗口（不要系统边框）
                return;
            }
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                if ((int)m.Result != HTCLIENT) return;
                var p = PointToClient(Cursor.Position);
                const int edge = 5;
                bool left = p.X <= edge, right = p.X >= ClientSize.Width - edge;
                bool top = p.Y <= edge, bottom = p.Y >= ClientSize.Height - edge;
                if (top && left) { m.Result = (IntPtr)HTTOPLEFT; return; }
                if (top && right) { m.Result = (IntPtr)HTTOPRIGHT; return; }
                if (bottom && left) { m.Result = (IntPtr)HTBOTTOMLEFT; return; }
                if (bottom && right) { m.Result = (IntPtr)HTBOTTOMRIGHT; return; }
                if (left) { m.Result = (IntPtr)HTLEFT; return; }
                if (right) { m.Result = (IntPtr)HTRIGHT; return; }
                if (bottom) { m.Result = (IntPtr)HTBOTTOM; return; }
                if (top) { m.Result = (IntPtr)HTTOP; return; }
                return;
            }
            base.WndProc(ref m);
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == (Keys.Alt | Keys.F4)) { Close(); return true; }
            if (keyData == Keys.F11) { ToggleMaximize(); return true; }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SaveBounds();
            base.OnFormClosing(e);
        }

        private void ApplySavedBounds()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            var b = new Rectangle(wa.X + (wa.Width - 1220) / 2, wa.Y + (wa.Height - 860) / 2, 1220, 860);
            if (b.Width > wa.Width) b.Width = wa.Width;
            if (b.Height > wa.Height) b.Height = wa.Height;
            try
            {
                if (File.Exists(_stateFile))
                {
                    var parts = File.ReadAllText(_stateFile).Split(',');
                    if (parts.Length == 4)
                    {
                        var r = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
                        var scr = Screen.FromRectangle(r).WorkingArea;
                        if (r.Width >= 720 && r.Height >= 520 && scr.IntersectsWith(r)) b = r;
                    }
                }
            }
            catch { }
            Bounds = b;
        }

        private void SaveBounds()
        {
            try
            {
                var r = (_isMax || WindowState == FormWindowState.Maximized) ? _restore : Bounds;
                if (r.Width < 720 || r.Height < 520) return;
                Directory.CreateDirectory(Path.GetDirectoryName(_stateFile));
                File.WriteAllText(_stateFile, string.Format("{0},{1},{2},{3}", r.X, r.Y, r.Width, r.Height));
            }
            catch { }
        }

        [STAThread]
        private static void Main(string[] args)
        {
            string root = args.Length > 1 ? args[1] : Directory.GetCurrentDirectory();
            // 任何未捕获异常都写日志并退出（退出码 2），不要弹 .NET 错误框，交给 launcher 回退
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Crash(root, e.ExceptionObject as Exception);
            Application.ThreadException += (s, e) => Crash(root, e.Exception);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }   // PER_MONITOR_AWARE_V2
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string url = args.Length > 0 ? args[0] : "http://127.0.0.1:7777";
            Application.Run(new ShellForm(url, root));
        }

        private static void Crash(string root, Exception ex)
        {
            try
            {
                Directory.CreateDirectory(Path.Combine(root, "data"));
                File.AppendAllText(Path.Combine(root, "data", "shell.log"),
                    "[" + DateTime.Now.ToString("HH:mm:ss") + "] crash: " + (ex == null ? "unknown" : ex.ToString()) + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { }
            Environment.Exit(2);
        }
    }
}
