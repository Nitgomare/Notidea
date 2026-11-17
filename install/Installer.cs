// flomo local · 一键安装器（双击运行）
// 做法：查最新 release → 下载完整包 → 解压到 %LOCALAPPDATA%\flomo-local → 建快捷方式 → 启动
// 说明：不用 PowerShell（避免被杀软当成可疑脚本），全部走 .NET Framework 自带 API。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.CSharp;

internal static class Installer
{
    private const string Repo = "Nitgomare/flomo-local";
    private const string AppName = "flomo local";

    private static Form _form;
    private static Label _label;
    private static ProgressBar _bar;

    [STAThread]
    private static void Main()
    {
        // .NET Framework 默认可能还是 TLS 1.0/1.1，GitHub 只收 TLS 1.2+
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
        ServicePointManager.Expect100Continue = false;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        BuildUi();
        _form.Shown += async (s, e) => await RunAsync();
        Application.Run(_form);
    }

    private static void BuildUi()
    {
        _form = new Form
        {
            Text = "安装 " + AppName,
            ClientSize = new Size(460, 130),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterScreen,
            MaximizeBox = false,
            MinimizeBox = false,
            BackColor = Color.FromArgb(243, 243, 247),
            Font = new Font("Microsoft YaHei UI", 9f),
        };
        _label = new Label
        {
            AutoSize = false,
            Size = new Size(420, 44),
            Location = new Point(20, 18),
            Text = "正在准备…",
        };
        _bar = new ProgressBar
        {
            Minimum = 0,
            Maximum = 100,
            Size = new Size(420, 18),
            Location = new Point(20, 70),
        };
        _form.Controls.Add(_label);
        _form.Controls.Add(_bar);
    }

    private static void SetStep(string text, int pct)
    {
        if (_form.IsDisposed) return;
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
        if (_form.IsDisposed) return;
        MessageBox.Show(_form, text, title, MessageBoxButtons.OK, error ? MessageBoxIcon.Error : MessageBoxIcon.Information);
        _form.Close();
    }

    private static async Task RunAsync()
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "flomo-local");
            SetStep("正在获取最新版本…", 3);

            using (var http = new HttpClient())
            {
                http.Timeout = TimeSpan.FromMinutes(60);
                http.DefaultRequestHeaders.Add("User-Agent", "flomo-local-installer");

                var rel = await GetLatestAsync(http);
                SetStep("正在下载 v" + rel.Version + " …", 8);
                var zip = Path.Combine(Path.GetTempPath(), "flomo-local-" + rel.Version + ".zip");
                await DownloadAsync(http, rel.Url, zip, rel.Version);

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

                var exeInStage = Path.Combine(stage, "flomo-local.exe");
                if (!File.Exists(exeInStage))
                    throw new Exception("安装包不完整（缺少 flomo-local.exe），请重新下载。");

                SetStep("正在安装…", 92);
                Directory.CreateDirectory(dir);
                CopyTree(stage, dir);

                SetStep("正在创建快捷方式…", 97);
                var exe = Path.Combine(dir, "flomo-local.exe");
                var ico = Path.Combine(dir, "assets", "flomo-local.ico");
                MakeShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"), exe, dir, ico);
                var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "Microsoft", "Windows", "Start Menu", "Programs");
                if (Directory.Exists(startMenu))
                    MakeShortcut(Path.Combine(startMenu, AppName + ".lnk"), exe, dir, ico);

                SetStep("安装完成，正在启动…", 100);
                try { Process.Start(new ProcessStartInfo(exe, "\"" + dir + "\"") { WorkingDirectory = dir }); } catch { }

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

    private static async Task<Release> GetLatestAsync(HttpClient http)
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

        // 回退：仓库根目录的 version.json
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
        req.ReadWriteTimeout = 30000;
        using (var resp = (HttpWebResponse)req.GetResponse())
        {
            return resp.ContentLength;
        }
    }

    private static async Task DownloadAsync(HttpClient http, string url, string target, string version)
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
        // 保留已有 data\（笔记、配置、日志）
        foreach (var d in Directory.GetDirectories(from))
        {
            var name = Path.GetFileName(d);
            if (string.Equals(name, "data", StringComparison.OrdinalIgnoreCase)) continue;
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
        catch { /* 快捷方式失败不影响安装 */ }
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
