using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class SetupConnector
{
    static readonly string DirectoryPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ImageStorage", "BrowserBridge");
    static readonly string HostName = "com.imagestorage.connector";
    static readonly string[] Vendors = { "Google\\Chrome", "Microsoft\\Edge", "Mozilla" };
    static string AppPath = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "ImageStorage.exe"));
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

    static void RegistryEntries(Action<RegistryKey, string> action)
    {
        foreach (var view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
        using (var root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view))
        foreach (var vendor in Vendors) action(root, "Software\\" + vendor + "\\NativeMessagingHosts\\" + HostName);
    }

    static string Json(object value) { return new JavaScriptSerializer().Serialize(value); }
    static string FileHash(string file) { using (var sha = SHA256.Create()) using (var stream = File.OpenRead(file)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }

    static void Install()
    {
        if (!File.Exists(AppPath)) throw new IOException("ImageStorage.exeを選択してください。");
        var metadata = FileVersionInfo.GetVersionInfo(AppPath);
        Version version;
        if (metadata.ProductName != "ImageStorage" || !Version.TryParse(metadata.ProductVersion, out version) || version < new Version(0, 15, 42)) throw new IOException("ImageStorage 0.15.42以降の実行ファイルを選択してください。");
        var source = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-host", "ImageStorage.NativeHost.exe");
        if (!File.Exists(source)) throw new IOException("native-hostフォルダーを含めて展開してください。");
        Directory.CreateDirectory(DirectoryPath);
        var sourceHash = FileHash(source);
        var digest = sourceHash.Substring(0, 16);
        var host = Path.Combine(DirectoryPath, "ImageStorage.NativeHost-" + digest + ".exe");
        if (File.Exists(host) && FileHash(host) != sourceHash) throw new IOException("中継プログラムが一致しません。連携フォルダーを確認してください。");
        if (!File.Exists(host)) File.Copy(source, host);
        File.WriteAllText(Path.Combine(DirectoryPath, "application.json"), Json(new { appPath = AppPath, appArgs = new string[0] }), Utf8);
        var chromium = Path.Combine(DirectoryPath, "chromium-host.json");
        var firefox = Path.Combine(DirectoryPath, "firefox-host.json");
        File.WriteAllText(chromium, Json(new { name = HostName, description = "ImageStorage browser connector", path = host, type = "stdio", allowed_origins = Array.ConvertAll(HostIdentity.ChromiumIds, id => "chrome-extension://" + id + "/") }), Utf8);
        File.WriteAllText(firefox, Json(new { name = HostName, description = "ImageStorage browser connector", path = host, type = "stdio", allowed_extensions = new[] { HostIdentity.FirefoxId } }), Utf8);
        RegistryEntries(delegate(RegistryKey root, string keyPath) {
            using (var key = root.CreateSubKey(keyPath)) key.SetValue("", keyPath.Contains("\\Mozilla\\") ? firefox : chromium, RegistryValueKind.String);
        });
    }

    static void Uninstall()
    {
        RegistryEntries(delegate(RegistryKey root, string keyPath) {
            string expected = Path.Combine(DirectoryPath, keyPath.Contains("\\Mozilla\\") ? "firefox-host.json" : "chromium-host.json");
            bool ours;
            using (var key = root.OpenSubKey(keyPath)) ours = key != null && String.Equals(key.GetValue("") as string, expected, StringComparison.OrdinalIgnoreCase);
            if (ours) root.DeleteSubKey(keyPath, false);
        });
        // Keep application data and running host binaries; only unregister this connector.
    }

    [STAThread]
    public static int Main()
    {
        Application.EnableVisualStyles();
        var form = new Form { Text = "ImageStorage ブラウザー連携", ClientSize = new Size(560, 245), FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, StartPosition = FormStartPosition.CenterScreen };
        form.Controls.Add(new Label { Text = "Chrome・Edge・Zenから、右クリックした画像を送信できます。\nこのWindowsユーザーだけに連携を設定します。", AutoSize = false, Location = new Point(20, 18), Size = new Size(520, 44) });
        var pathLabel = new TextBox { ReadOnly = true, Text = AppPath, Location = new Point(20, 77), Size = new Size(410, 23) };
        var browse = new Button { Text = "アプリを選択", Location = new Point(438, 75), Size = new Size(100, 28) };
        browse.Click += delegate {
            using (var picker = new OpenFileDialog { Title = "ImageStorage.exeを選択", Filter = "ImageStorage|ImageStorage.exe", CheckFileExists = true }) if (picker.ShowDialog(form) == DialogResult.OK) { AppPath = picker.FileName; pathLabel.Text = AppPath; }
        };
        var status = new Label { Text = "拡張機能の読み込み方法は、同じフォルダーの「使い方.txt」を参照してください。", AutoSize = false, Location = new Point(20, 121), Size = new Size(520, 43) };
        var install = new Button { Text = "連携を設定", Location = new Point(320, 185), Size = new Size(106, 34) };
        var remove = new Button { Text = "連携を解除", Location = new Point(20, 185), Size = new Size(106, 34) };
        var done = new Button { Text = "閉じる", Location = new Point(438, 185), Size = new Size(100, 34) };
        install.Click += delegate { try { Install(); status.Text = "連携を設定しました。ブラウザーで拡張機能を読み込んでください。"; } catch (Exception error) { MessageBox.Show(form, error.Message, "連携を設定できませんでした", MessageBoxButtons.OK, MessageBoxIcon.Error); } };
        remove.Click += delegate { try { Uninstall(); status.Text = "連携設定を解除しました。拡張機能を無効化するか、ブラウザーを再起動すると接続も終了します。"; } catch (Exception error) { MessageBox.Show(form, error.Message, "連携を解除できませんでした"); } };
        done.Click += delegate { form.Close(); };
        form.Controls.AddRange(new Control[] { pathLabel, browse, status, install, remove, done });
        Application.Run(form);
        return 0;
    }
}
