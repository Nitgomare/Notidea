// flomo local · 一键安装器（双击运行）
// 流程：选择安装位置 → 下载最新完整包 → 解压安装 → 建快捷方式 → 启动
// 说明：不用 PowerShell（避免被杀软当成可疑脚本），全部走 .NET Framework 自带 API。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.CSharp;

internal static class Installer
{
    private const string Repo = "Nitgomare/flomo-local";
    private const string AppName = "flomo local";
    private const string ExeName = "flomo-local.exe";

    private static Form _form;
    private static Panel _choosePanel;
    private static Panel _progressPanel;
    private static TextBox _pathBox;
    private static Label _label;
    private static ProgressBar _bar;
    private static Button _installBtn;

    private static string _installDir;
    private static bool _skipUi;
    private static bool _noShortcut;
    private static bool _noLaunch;
    private static string _localZip;

    private static string ConfigDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "flomo-local"); }
    }

    private static string RememberFile
    {
        get { return Path.Combine(ConfigDir, "install-dir.txt"); }
    }

    private static string DefaultDir
    {
        get
        {
            try
            {
                if (File.Exists(RememberFile))
                {
                    var saved = File.ReadAllText(RememberFile).Trim();
                    if (saved.Length > 0) return saved;
                }
            }
            catch { }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "flomo-local");
        }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
        ServicePointManager.Expect100Continue = false;

        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (a == "--dir" && i + 1 < args.Length) _installDir = args[++i];
            else if (a == "--zip" && i + 1 < args.Length) _localZip = args[++i];
            else if (a == "--yes") _skipUi = true;
            else if (a == "--no-shortcut") _noShortcut = true;
            else if (a == "--no-launch") _noLaunch = true;
        }
        if (string.IsNullOrEmpty(_installDir)) _installDir = DefaultDir;
        _installDir = Path.GetFullPath(_installDir);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        if (_skipUi)
        {
            Install(_installDir).GetAwaiter().GetResult();
            return;
        }

        BuildUi();
        Application.Run(_form);
    }

    private static void BuildUi()
    {
        _form = new Form
        {
            Text = "安装 " + AppName,
            ClientSize = new Size(520, 210),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterScreen,
            MaximizeBox = false,
            MinimizeBox = false,
            BackColor = Color.FromArgb(243, 243, 247),
            Font = new Font("Microsoft YaHei UI", 9f),
        };

        // ---- 第一步：选安装位置 ----
        _choosePanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(20) };

        var title = new Label
        {
            Text = "选择安装位置",
            AutoSize = true,
            Location = new Point(20, 18),
            Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold),
        };
        var hint = new Label
        {
            Text = "程序本体约 450 MB（含 Electron 运行时）。装在非系统盘可以避免 C 盘占用。",
            AutoSize = false,
            Size = new Size(470, 20),
            Location = new Point(20, 50),
            ForeColor = Color.FromArgb(110, 110, 120),
        };
        _pathBox = new TextBox
        {
            Text = _installDir,
            Location = new Point(20, 78),
            Size = new Size(380, 26),
        };
        var browse = new Button
        {
            Text = "浏览…",
            Location = new Point(408, 77),
            Size = new Size(92, 28),
        };
        browse.Click += (s, e) =>
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择 flomo local 的安装目录";
                dlg.ShowNewFolderButton = true;
                try
                {
                    if (Directory.Exists(_pathBox.Text)) dlg.SelectedPath = _pathBox.Text;
                }
                catch { }
                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    // 选中的目录下再建一层 flomo-local，避免装到盘根或杂乱目录
                    var picked = dlg.SelectedPath.TrimEnd('\\');
                    _pathBox.Text = Path.Combine(picked, "flomo-local");
                }
            }
        };
        var note = new Label
        {
            Text = "会创建「flomo local」桌面快捷方式和开始菜单项；笔记数据不在这个目录里（设置里可改）。",
            AutoSize = false,
            Size = new Size(470, 40),
            Location = new Point(20, 112),
            ForeColor = Color.FromArgb(110, 110, 120),
        };
        var cancel = new Button { Text = "取消", Location = new Point(306, 162), Size = new Size(92, 30) };
        cancel.Click += (s, e) => _form.Close();
        _installBtn = new Button
        {
            Text = "安装",
            Location = new Point(408, 162),
            Size = new Size(92, 30),
            BackColor = Color.FromArgb(91, 76, 245),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
        };
        _installBtn.FlatAppearance.BorderSize = 0;
        _installBtn.Click += async (s, e) =>
        {
            var dir = (_pathBox.Text ?? "").Trim().Trim('"');
            if (dir.Length == 0)
            {
                MessageBox.Show(_form, "请先选择安装位置。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try { _installDir = Path.GetFullPath(dir); }
            catch
            {
                MessageBox.Show(_form, "这个路径不合法：" + dir, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try
            {
                Directory.CreateDirectory(_installDir);
                var probe = Path.Combine(_installDir, ".write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
            }
            catch (Exception ex)
            {
                MessageBox.Show(_form, "这个目录不可写，换一个：\n" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            _choosePanel.Visible = false;
            _progressPanel.Visible = true;
            await Install(_installDir);
        };

        _choosePanel.Controls.AddRange(new Control[] { title, hint, _pathBox, browse, note, cancel, _installBtn });

        // ---- 第二步：进度 ----
        _progressPanel = new Panel { Dock = DockStyle.Fill, Visible = false, Padding = new Padding(20) };
        _label = new Label
        {
            AutoSize = false,
            Size = new Size(470, 44),
            Location = new Point(20, 26),
            Text = "正在准备…",
        };
        _bar = new ProgressBar
        {
            Minimum = 0,
            Maximum = 100,
            Size = new Size(470, 18),
            Location = new Point(20, 76),
        };
        _progressPanel.Controls.Add(_label);
        _progressPanel.Controls.Add(_bar);

        _form.Controls.Add(_choosePanel);
        _form.Controls.Add(_progressPanel);
    }

    private static void SetStep(string text, int pct)
    {
        if (_form == null || _form.IsDisposed) return;
        Action apply = () =>
        {
            _label.Text = text;
            if (pct >= 0) _bar.Value = Math.Max(0, Math.Min(100, pct));
        };
        if (_form.InvokeRequired) _form.Invoke(apply);
        else apply();
    }

    private static void Done(string title, string text, bool error)
    {
        if (_form == null || _form.IsDisposed)
        {
            if (error) Console.Error.WriteLine(text);
            return;
        }
        MessageBox.Show(_form, text, title, MessageBoxButtons.OK, error ? MessageBoxIcon.Error : MessageBoxIcon.Information);
        _form.Close();
    }

    private static async Task Install(string dir)
    {
        try
        {
            SetStep("正在获取最新版本…", 3);

            using (var http = new HttpClient())
            {
                http.Timeout = TimeSpan.FromMinutes(60);
                http.DefaultRequestHeaders.Add("User-Agent", "flomo-local-installer");

                var rel = await GetLatestAsync();
                var zip = Path.Combine(Path.GetTempPath(), "flomo-local-" + rel.Version + ".zip");

                if (!string.IsNullOrEmpty(_localZip))
                {
                    SetStep("正在读取本地安装包…", 10);
                    File.Copy(_localZip, zip, true);
                }
                else
                {
                    SetStep("正在下载 v" + rel.Version + " …", 8);
                    await DownloadAsync(rel.Url, zip, rel.Version);
                }

                SetStep("正在解压…", 86);
                var stage = Path.Combine(Path.GetTempPath(), "flomo-local-stage-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(stage);
                try
                {
                    ZipFile.ExtractToDirectory(zip, stage);
                }
                catch (Exception ex)
                {
                    throw new Exception("解压失败：" + ex.Message);
                }

                if (!File.Exists(Path.Combine(stage, ExeName)))
                    throw new Exception("安装包不完整（缺少 " + ExeName + "），请重新下载。");

                SetStep("正在安装到 " + dir + " …", 92);
                Directory.CreateDirectory(dir);
                CopyTree(stage, dir);

                var exe = Path.Combine(dir, ExeName);
                if (!File.Exists(exe))
                    throw new Exception("安装后没有找到 " + exe);

                if (!_noShortcut)
                {
                    SetStep("正在创建快捷方式…", 97);
                    var ico = Path.Combine(dir, "assets", "flomo-local.ico");
                    MakeShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"), exe, dir, ico);
                    var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                        "Microsoft", "Windows", "Start Menu", "Programs");
                    if (Directory.Exists(startMenu))
                        MakeShortcut(Path.Combine(startMenu, AppName + ".lnk"), exe, dir, ico);
                }

                try
                {
                    Directory.CreateDirectory(ConfigDir);
                    File.WriteAllText(RememberFile, dir);
                }
                catch { }

                SetStep("安装完成，正在启动…", 100);
                if (!_noLaunch)
                {
                    try { Process.Start(new ProcessStartInfo(exe, "\"" + dir + "\"") { WorkingDirectory = dir }); } catch { }
                }

                TryDelete(zip);
                TryDeleteDir(stage);
                Done("安装完成", "已安装 v" + rel.Version + " 到：\n" + dir + "\n\n桌面和开始菜单都创建了「" + AppName + "」快捷方式，以后双击即可。", false);
            }
        }
        catch (Exception ex)
        {
            Done("安装失败", ex.Message + "\n\n也可以到 https://github.com/" + Repo + "/releases 手动下载完整包。", true);
        }
    }

    private sealed class Release
    {
        public string Version;
        public string Url;
    }

    private static async Task<Release> GetLatestAsync()
    {
        try
        {
            var json = await DownloadStringAsync("https://api.github.com/repos/" + Repo + "/releases/latest");
            var tag = Regex.Match(json, "\"tag_name\"\\s*:\\s*\"([^\"]+)\"");
            var url = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]*win-x64\\.zip)\"");
            if (tag.Success && url.Success)
                return new Release { Version = tag.Groups[1].Value.TrimStart('v'), Url = url.Groups[1].Value };
        }
        catch { }

        var vj = await DownloadStringAsync("https://raw.githubusercontent.com/" + Repo + "/main/version.json?t=" + DateTime.Now.Ticks);
        var vm = Regex.Match(vj, "\"version\"\\s*:\\s*\"([^\"]+)\"");
        if (!vm.Success) throw new Exception("无法获取最新版本信息，请检查网络。");
        var ver = vm.Groups[1].Value;
        return new Release
        {
            Version = ver,
            Url = "https://github.com/" + Repo + "/releases/download/v" + ver + "/flomo-local-" + ver + "-win-x64.zip",
        };
    }

    private static async Task<string> DownloadStringAsync(string url)
    {
        using (var wc = new WebClient())
        {
            wc.Headers.Add("User-Agent", "flomo-local-installer");
            return await wc.DownloadStringTaskAsync(new Uri(url));
        }
    }

    private static long GetRemoteSize(string url)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "HEAD";
        req.UserAgent = "flomo-local-installer";
        req.Timeout = 30000;
        using (var resp = (HttpWebResponse)req.GetResponse())
        {
            return resp.ContentLength;
        }
    }

    private static async Task DownloadAsync(string url, string target, string version)
    {
        // 分片 Range 下载：有的网络环境（本地代理）对整包 GET 会先整段缓存再开始回数据，
        // 表现就是进度长时间停在 0；按 8MB 分片请求既能出进度，也能避开这种代理。
        const long Chunk = 8L * 1024 * 1024;
        var total = await Task.Run(() => GetRemoteSize(url));
        if (total <= 0) throw new Exception("无法获取安装包大小，请检查网络。");

        using (var fs = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, true))
        {
            var buf = new byte[1 << 16];
            long done = 0;
            var lastPct = -1;
            for (long from = 0; from < total; from += Chunk)
            {
                long to = Math.Min(from + Chunk - 1, total - 1);
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.UserAgent = "flomo-local-installer";
                req.AddRange(from, to);
                req.Timeout = 120000;
                req.ReadWriteTimeout = 120000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var src = resp.GetResponseStream())
                {
                    int n;
                    while ((n = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        await fs.WriteAsync(buf, 0, n);
                        done += n;
                    }
                }
                var pct = (int)(done * 100 / total);
                if (pct != lastPct)
                {
                    lastPct = pct;
                    SetStep(string.Format("正在下载 v{0} … {1:N0} / {2:N0} MB", version, done / 1048576.0, total / 1048576.0),
                        8 + (int)(pct * 0.75));
                }
            }
        }
    }

    private static void CopyTree(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var d in Directory.GetDirectories(from))
        {
            var name = Path.GetFileName(d);
            if (string.Equals(name, "data", StringComparison.OrdinalIgnoreCase)) continue;   // 不覆盖用户数据
            var target = Path.Combine(to, name);
            if (Directory.Exists(target)) TryDeleteDir(target);
            CopyTree(d, target);
        }
        foreach (var f in Directory.GetFiles(from))
        {
            File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
        }
    }

    private static void MakeShortcut(string lnkPath, string exe, string workDir, string icon)
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            dynamic shell = Activator.CreateInstance(shellType);
            dynamic lnk = shell.CreateShortcut(lnkPath);
            lnk.TargetPath = exe;
            lnk.Arguments = "\"" + workDir + "\"";
            lnk.WorkingDirectory = workDir;
            if (File.Exists(icon)) lnk.IconLocation = icon + ",0";
            lnk.Description = AppName + " - 本地卡片笔记";
            lnk.Save();
        }
        catch { }
    }

    private static void TryDelete(string file)
    {
        try { if (File.Exists(file)) File.Delete(file); } catch { }
    }

    private static void TryDeleteDir(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
    }
}
