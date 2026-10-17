// Built with the unchanged StorageAclNative class by build-storage-worker.ps1.
public static class StorageAclServer
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint pid);

    public static int Main(string[] args)
    {
        int parentId;
        if (args.Length != 2 || !int.TryParse(args[1], out parentId)) return 2;
        try
        {
            using (var parent = System.Diagnostics.Process.GetProcessById(parentId))
            {
                // Retain the original process handle, not just a reusable PID.
                System.GC.KeepAlive(parent.Handle);
                using (var timer = new System.Threading.Timer(delegate {
                    try { if (parent.HasExited) System.Environment.Exit(0); }
                    catch { System.Environment.Exit(0); }
                }, null, 1000, 1000))
                {
                    var security = new System.IO.Pipes.PipeSecurity();
                    var user = System.Security.Principal.WindowsIdentity.GetCurrent().User;
                    security.SetOwner(user);
                    security.SetAccessRuleProtection(true, false);
                    security.AddAccessRule(new System.IO.Pipes.PipeAccessRule(user,
                        System.IO.Pipes.PipeAccessRights.FullControl,
                        System.Security.AccessControl.AccessControlType.Allow));
                    var json = new System.Web.Script.Serialization.JavaScriptSerializer();
                    json.MaxJsonLength = 32 * 1024 * 1024;
                    var utf8 = new System.Text.UTF8Encoding(false, true);
                    while (!parent.HasExited)
                    {
                        using (var pipe = new System.IO.Pipes.NamedPipeServerStream(args[0],
                            System.IO.Pipes.PipeDirection.InOut, 1,
                            System.IO.Pipes.PipeTransmissionMode.Message,
                            System.IO.Pipes.PipeOptions.None, 65536, 65536, security))
                        {
                            pipe.WaitForConnection();
                            uint clientId;
                            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientId) ||
                                clientId != (uint)parentId) continue;
                            try
                            {
                                string line;
                                // Only the owning OMP instance may send a request.
                                using (var reader = new System.IO.StreamReader(pipe, utf8, false, 4096, true))
                                    line = reader.ReadLine();
                                string reply;
                                try
                                {
                                    if (line == null || line.Length > 65536) throw new System.IO.IOException();
                                    var request = json.Deserialize<StorageAclRequest>(line);
                                    reply = json.Serialize(StorageAclNative.Execute(request.action, request.path, request.root));
                                }
                                catch { reply = "{\"ok\":false,\"records\":[]}"; }
                                byte[] bytes = utf8.GetBytes(reply);
                                if (bytes.Length > 32 * 1024 * 1024) throw new System.IO.IOException();
                                pipe.Write(bytes, 0, bytes.Length);
                                pipe.Flush();
                                pipe.WaitForPipeDrain();
                            }
                            catch (System.IO.IOException) { }
                        }
                    }
                }
            }
            return 0;
        }
        catch { return 1; }
    }
}
public sealed class StorageAclRequest
{
    public string action;
    public string path;
    public string root;
}
