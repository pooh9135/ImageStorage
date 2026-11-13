using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class NativeHost
{
    const int MaxInput = 16 * 1024 * 1024;
    static readonly object OutputLock = new object();
    static readonly object ConnectionLock = new object();
    static readonly Stream Input = Console.OpenStandardInput();
    static readonly Stream Output = Console.OpenStandardOutput();
    static readonly string ConfigDirectory = Environment.GetEnvironmentVariable("IMAGESTORAGE_EXTENSION_CONFIG_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ImageStorage", "BrowserBridge");
    static Connection Current;

    sealed class Connection : IDisposable
    {
        public NamedPipeClientStream Pipe;
        public StreamReader Reader;
        public StreamWriter Writer;
        public string Token;
        public readonly HashSet<string> Pending = new HashSet<string>();
        public void Dispose() { try { Pipe.Dispose(); } catch { } }
    }

    static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = MaxInput, RecursionLimit = 32 }; }
    static string Text(Dictionary<string, object> data, string key) { object value; return data.TryGetValue(key, out value) ? value as string : null; }
    static bool Flag(Dictionary<string, object> data, string key) { object value; return data.TryGetValue(key, out value) && value is bool && (bool)value; }
    static Dictionary<string, object> ReadConfiguration(string file)
    {
        var name = Path.Combine(ConfigDirectory, file);
        if (!File.Exists(name) || new FileInfo(name).Length > 65536) throw new IOException("連携設定を確認してください。");
        using (var stream = new FileStream(name, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var reader = new StreamReader(stream, Encoding.UTF8)) return Serializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
    }

    static bool ReadExactly(byte[] data, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = Input.Read(data, offset, count - offset);
            if (read == 0) { if (offset == 0) return false; throw new IOException("Incomplete native message"); }
            offset += read;
        }
        return true;
    }

    static void Send(object message)
    {
        byte[] data = Encoding.UTF8.GetBytes(Serializer().Serialize(message));
        if (data.Length > 950000) throw new IOException("Native response is too large");
        byte[] header = BitConverter.GetBytes((uint)data.Length);
        lock (OutputLock) { Output.Write(header, 0, 4); Output.Write(data, 0, data.Length); Output.Flush(); }
    }

    static void Error(string id, string code, string message)
    {
        Send(new { id = id, ok = false, error = new { code = code, message = message } });
    }

    static Connection Connect()
    {
        var config = ReadConfiguration("connection.json");
        string pipeName = Text(config, "pipeName"), token = Text(config, "token");
        if (pipeName == null || !System.Text.RegularExpressions.Regex.IsMatch(pipeName, "^imagestorage-connector-[a-f0-9]{32}$") || token == null || !System.Text.RegularExpressions.Regex.IsMatch(token, "^[a-f0-9]{64}$")) throw new IOException("連携設定が正しくありません。");
        var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try { pipe.Connect(200); }
        catch { pipe.Dispose(); throw; }
        var connection = new Connection { Pipe = pipe, Token = token, Reader = new StreamReader(pipe, new UTF8Encoding(false), false, 8192, true), Writer = new StreamWriter(pipe, new UTF8Encoding(false), 8192, true) { AutoFlush = true, NewLine = "\n" } };
        Current = connection;
        new Thread(delegate() { ReadPipe(connection); }) { IsBackground = true }.Start();
        return connection;
    }

    static void ReadPipe(Connection connection)
    {
        try
        {
            string line;
            while ((line = connection.Reader.ReadLine()) != null)
            {
                if (line.Length > 950000) throw new IOException("Invalid native response");
                var message = Serializer().Deserialize<Dictionary<string, object>>(line);
                lock (ConnectionLock)
                {
                    if (!Object.ReferenceEquals(Current, connection)) return;
                    var id = Text(message, "id");
                    if (id != null) connection.Pending.Remove(id);
                }
                Send(message);
            }
        }
        catch { }
        finally
        {
            string[] pending = null;
            lock (ConnectionLock)
            {
                if (Object.ReferenceEquals(Current, connection))
                {
                    Current = null;
                    pending = new List<string>(connection.Pending).ToArray();
                }
            }
            connection.Dispose();
            if (pending != null) { try { Send(new { @event = "disconnected", ids = pending }); } catch { } }
        }
    }

    static string QuoteArgument(string value)
    {
        // ProcessStartInfo uses Windows command-line quoting, never a shell.
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char valueChar in value)
        {
            if (valueChar == '\\') { slashes++; continue; }
            if (valueChar == '"') result.Append('\\', slashes * 2 + 1).Append('"');
            else result.Append('\\', slashes).Append(valueChar);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    static void LaunchApplication()
    {
        var config = ReadConfiguration("application.json");
        var executable = Text(config, "appPath");
        if (String.IsNullOrEmpty(executable) || !Path.IsPathRooted(executable) || !File.Exists(executable) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new IOException("ImageStorageの最新版で連携セットアップを実行してください。");
        var arguments = new List<string>();
        object raw;
        if (config.TryGetValue("appArgs", out raw))
        {
            var entries = raw as System.Collections.IEnumerable;
            if (raw is string) throw new IOException("Invalid application arguments");
            if (entries != null) foreach (var entry in entries) { if (!(entry is string)) throw new IOException("Invalid application arguments"); arguments.Add(QuoteArgument((string)entry)); }
        }
        arguments.Add(QuoteArgument("--imagestorage-extension"));
        Process.Start(new ProcessStartInfo { FileName = executable, Arguments = String.Join(" ", arguments), WorkingDirectory = Path.GetDirectoryName(executable), UseShellExecute = false, CreateNoWindow = true });
    }

    static Connection EnsureConnection(bool launch)
    {
        lock (ConnectionLock)
        {
            if (Current != null && Current.Pipe.IsConnected) return Current;
            try { return Connect(); } catch { if (!launch) throw; }
        }
        LaunchApplication();
        var deadline = DateTime.UtcNow.AddSeconds(25);
        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(250);
            lock (ConnectionLock) { try { return Connect(); } catch { } }
        }
        throw new IOException("ImageStorageに接続できません。古い版を終了し、0.15.42以降を起動してください。");
    }

    public static int Main(string[] args)
    {
        bool allowed = false;
        if (args.Length > 0) foreach (var id in HostIdentity.ChromiumIds) if (args[0] == "chrome-extension://" + id + "/") allowed = true;
        if (!allowed) foreach (var argument in args) if (argument == HostIdentity.FirefoxId) allowed = true;
        if (!allowed) return 1;
        try
        {
            var header = new byte[4];
            while (ReadExactly(header, 4))
            {
                uint length = BitConverter.ToUInt32(header, 0);
                if (length == 0 || length > MaxInput) return 1;
                var bytes = new byte[(int)length];
                if (!ReadExactly(bytes, bytes.Length)) return 1;
                string id = "";
                string action = "";
                bool forwarding = false;
                try
                {
                    var message = Serializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
                    id = Text(message, "id") ?? "";
                    action = Text(message, "action");
                    if (id.Length == 0 || id.Length > 100 || (action != "list" && action != "import")) { Error(id, "invalid_message", "Invalid connector request"); continue; }
                    var connection = EnsureConnection(Flag(message, "launch"));
                    message["token"] = connection.Token;
                    lock (ConnectionLock)
                    {
                        connection.Pending.Add(id);
                        forwarding = true;
                        connection.Writer.WriteLine(Serializer().Serialize(message));
                    }
                }
                catch (Exception error) { Error(id, forwarding && action == "import" ? "unknown_result" : "not_running", "ImageStorageに接続できません。連携セットアップとアプリの起動を確認してください。 " + error.Message); }
            }
            return 0;
        }
        catch { return 1; }
        finally { lock (ConnectionLock) { if (Current != null) Current.Dispose(); Current = null; } }
    }
}
