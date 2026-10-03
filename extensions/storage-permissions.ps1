$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# All paths arrive as JSON data on stdin. No command text contains a storage path.
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class StorageAclRecord
{
    public string path;
    public bool safe;
    public string ino;
    public double birthtimeMs;
    public double mtimeMs;
    public double size;
    public uint nlink;
    public bool directory;
}

public sealed class StorageAclReply
{
    public bool ok;
    public StorageAclRecord[] records;
}

public static class StorageAclNative
{
    private const uint ReadControl = 0x00020000;
    private const uint WriteDac = 0x00040000;
    private const uint WriteOwner = 0x00080000;
    private const uint ReadAttributes = 0x80;
    private const uint ReparsePoint = 0x400;
    private const uint DirectoryAttribute = 0x10;
    private const uint FullControl = 0x001F01FF;
    private const uint OwnerInformation = 1;
    private const uint DaclInformation = 4;
    private const uint ProtectedDacl = 0x80000000;
    private static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
    private static readonly SecurityIdentifier DefaultOwner = WindowsIdentity.GetCurrent().Owner;
    private static readonly SecurityIdentifier Administrators = new SecurityIdentifier("S-1-5-32-544");
    private static readonly bool ElevatedDefaultOwner = DefaultOwner != null &&
        DefaultOwner.Equals(Administrators) &&
        new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path,
        uint size, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstFileName(string path, uint flags, ref uint length,
        StringBuilder name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool FindNextFileName(IntPtr handle, ref uint length, StringBuilder name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FindClose(IntPtr handle);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint information,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint information,
        byte[] descriptor);

    private static SafeFileHandle Open(string path, uint access)
    {
        // Omitting FILE_SHARE_DELETE pins the directory/file against replacement.
        SafeFileHandle handle = CreateFile(path, access, 3, IntPtr.Zero, 3,
            0x02000000 | 0x00200000, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(); }
        return handle;
    }

    private static FileInformation Information(SafeFileHandle handle)
    {
        FileInformation info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception();
        return info;
    }

    private static RawSecurityDescriptor Security(SafeFileHandle handle)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(handle, 1, OwnerInformation | DaclInformation,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try
        {
            uint needed = GetSecurityDescriptorLength(descriptor);
            if (needed == 0 || needed > 1048576) throw new IOException("Invalid security descriptor");
            byte[] bytes = new byte[needed];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            return new RawSecurityDescriptor(bytes, 0);
        }
        finally { LocalFree(descriptor); }
    }

    private static bool InheritedOnly(RawSecurityDescriptor security)
    {
        if ((security.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ||
            security.DiscretionaryAcl == null || security.DiscretionaryAcl.Count == 0) return false;
        foreach (GenericAce ace in security.DiscretionaryAcl)
            if ((ace.AceFlags & AceFlags.Inherited) == 0) return false;
        return true;
    }

    private static bool Owned(RawSecurityDescriptor security)
    {
        return User.Equals(security.Owner) || (ElevatedDefaultOwner &&
            Administrators.Equals(security.Owner) && InheritedOnly(security));
    }

    private static bool Private(RawSecurityDescriptor security, bool directory)
    {
        if (!Owned(security) || security.DiscretionaryAcl == null ||
            security.DiscretionaryAcl.Count == 0) return false;
        bool full = false;
        foreach (GenericAce item in security.DiscretionaryAcl)
        {
            CommonAce ace = item as CommonAce;
            if (ace == null || ace.IsCallback || ace.AceQualifier != AceQualifier.AccessAllowed ||
                !User.Equals(ace.SecurityIdentifier)) return false;
            bool effective = (ace.AceFlags & AceFlags.InheritOnly) == 0;
            bool inheritedChildren = !directory ||
                ((ace.AceFlags & AceFlags.NoPropagateInherit) == 0 &&
                (ace.AceFlags & (AceFlags.ContainerInherit | AceFlags.ObjectInherit)) ==
                (AceFlags.ContainerInherit | AceFlags.ObjectInherit));
            if (effective && inheritedChildren && ((uint)ace.AccessMask & FullControl) == FullControl)
                full = true;
        }
        return full;
    }

    private static void MakePrivate(string path, SafeFileHandle pinned,
        FileInformation info, RawSecurityDescriptor oldSecurity)
    {
        bool changeOwner = !User.Equals(oldSecurity.Owner);
        using (SafeFileHandle writable = Open(path, ReadControl | WriteDac |
            (changeOwner ? WriteOwner : 0)))
        {
            FileInformation fresh = Information(writable);
            if (fresh.VolumeSerialNumber != info.VolumeSerialNumber ||
                fresh.FileIndexHigh != info.FileIndexHigh || fresh.FileIndexLow != info.FileIndexLow ||
                (fresh.Attributes & ReparsePoint) != 0 ||
                fresh.NumberOfLinks != info.NumberOfLinks)
                throw new IOException("Storage identity changed");
            bool directory = (info.Attributes & DirectoryAttribute) != 0;
            RawAcl acl = new RawAcl(2, 1);
            acl.InsertAce(0, new CommonAce(directory ? AceFlags.ContainerInherit | AceFlags.ObjectInherit :
                AceFlags.None, AceQualifier.AccessAllowed, (int)FullControl, User, false, null));
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(
                ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected,
                User, null, null, acl);
            byte[] bytes = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(bytes, 0);
            // Unlike SetSecurityInfo, this call does not walk children and propagate
            // inheritable ACEs. Every existing item is handled through its own pinned,
            // no-follow handle, so a junction or hard link cannot change another tree.
            if (!SetKernelObjectSecurity(writable, DaclInformation | ProtectedDacl |
                (changeOwner ? OwnerInformation : 0), bytes)) throw new Win32Exception();
            if (!Private(Security(pinned), directory)) throw new IOException("ACL setup failed");
        }
    }

    private static string CanonicalPath(SafeFileHandle handle)
    {
        StringBuilder text = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
        if (length == 0 || length >= text.Capacity) throw new Win32Exception();
        string path = text.ToString();
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            path = @"\\" + path.Substring(8);
        else if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path.Substring(4);
        return path.TrimEnd('\\');
    }

    private static double Milliseconds(System.Runtime.InteropServices.ComTypes.FILETIME value)
    {
        long ticks = ((long)(uint)value.dwHighDateTime << 32) | (uint)value.dwLowDateTime;
        return (ticks - 116444736000000000L) / 10000.0;
    }

    private static StorageAclRecord Record(string path, FileInformation info, bool safe)
    {
        bool directory = (info.Attributes & DirectoryAttribute) != 0;
        return new StorageAclRecord {
            path = path, safe = safe, directory = directory,
            ino = (((ulong)info.FileIndexHigh << 32) | info.FileIndexLow).ToString(),
            birthtimeMs = Milliseconds(info.CreationTime), mtimeMs = Milliseconds(info.LastWriteTime),
            nlink = info.NumberOfLinks,
            size = directory ? 0 : ((ulong)info.FileSizeHigh << 32) | info.FileSizeLow
        };
    }

    private static void PinAncestors(string path, string privateRoot, FileInformation? rootIdentity,
        bool migrate, List<SafeFileHandle> pinned)
    {
        string volume = Path.GetPathRoot(path);
        string current = volume;
        string[] names = path.Substring(volume.Length).Split(new char[] { '\\' },
            StringSplitOptions.RemoveEmptyEntries);
        foreach (string name in names)
        {
            bool inTree = privateRoot != null && (String.Equals(current, privateRoot,
                StringComparison.OrdinalIgnoreCase) ||
                current.StartsWith(privateRoot + "\\", StringComparison.OrdinalIgnoreCase));
            SafeFileHandle handle = Open(current, ReadAttributes | (inTree ? ReadControl : 0));
            pinned.Add(handle);
            FileInformation info = Information(handle);
            if ((info.Attributes & ReparsePoint) != 0 || (info.Attributes & DirectoryAttribute) == 0)
                throw new IOException("Linked ancestor");
            if (inTree)
            {
                if (String.Equals(current, privateRoot, StringComparison.OrdinalIgnoreCase) &&
                    (!rootIdentity.HasValue ||
                    info.VolumeSerialNumber != rootIdentity.Value.VolumeSerialNumber ||
                    info.FileIndexHigh != rootIdentity.Value.FileIndexHigh ||
                    info.FileIndexLow != rootIdentity.Value.FileIndexLow))
                    throw new IOException("Alias belongs to another directory");
                RawSecurityDescriptor security = Security(handle);
                if (!Owned(security) || (!migrate && !Private(security, true)))
                    throw new IOException("Unsafe alias directory");
                if (String.Equals(current, privateRoot, StringComparison.OrdinalIgnoreCase) &&
                    (!User.Equals(security.Owner) || !Private(security, true) ||
                    (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0))
                    throw new IOException("Unsafe alias root");
            }
            current = Path.Combine(current, name);
        }
    }

    private static bool InternalLinks(string path, FileInformation info, string privateRoot,
        FileInformation? rootIdentity, bool migrate, List<SafeFileHandle> pinned)
    {
        if (info.NumberOfLinks == 1) return true;
        if (info.NumberOfLinks == 0 || String.IsNullOrEmpty(privateRoot) || !rootIdentity.HasValue) return false;
        StringBuilder name = new StringBuilder(32768);
        uint length = (uint)name.Capacity;
        IntPtr search = FindFirstFileName(path, 0, ref length, name);
        if (search == new IntPtr(-1)) throw new Win32Exception();
        try
        {
            HashSet<string> aliases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (true)
            {
                string relative = name.ToString();
                if (!relative.StartsWith("\\", StringComparison.Ordinal)) return false;
                string alias = Path.GetFullPath(Path.GetPathRoot(path).TrimEnd('\\') + relative);
                if (!alias.StartsWith(privateRoot + "\\", StringComparison.OrdinalIgnoreCase) ||
                    !aliases.Add(alias)) return false;
                PinAncestors(alias, privateRoot, rootIdentity, migrate, pinned);
                SafeFileHandle handle = Open(alias, ReadAttributes);
                pinned.Add(handle);
                FileInformation candidate = Information(handle);
                if ((candidate.Attributes & (ReparsePoint | DirectoryAttribute)) != 0 ||
                    candidate.VolumeSerialNumber != info.VolumeSerialNumber ||
                    candidate.FileIndexHigh != info.FileIndexHigh ||
                    candidate.FileIndexLow != info.FileIndexLow ||
                    candidate.NumberOfLinks != info.NumberOfLinks ||
                    !String.Equals(CanonicalPath(handle), alias, StringComparison.OrdinalIgnoreCase))
                    return false;
                name.Length = 0;
                length = (uint)name.Capacity;
                if (!FindNextFileName(search, ref length, name))
                {
                    // FindNextFileName ends with ERROR_HANDLE_EOF, not ERROR_NO_MORE_FILES.
                    if (Marshal.GetLastWin32Error() != 38) throw new Win32Exception();
                    break;
                }
            }
            return aliases.Count == info.NumberOfLinks;
        }
        finally { FindClose(search); }
    }

    private static void Walk(string path, string privateRoot, FileInformation rootIdentity,
        bool migrate, List<StorageAclRecord> records)
    {
        foreach (string child in Directory.EnumerateFileSystemEntries(path))
        {
            int firstRecord = records.Count;
            List<SafeFileHandle> aliases = new List<SafeFileHandle>();
            try
            {
                using (SafeFileHandle handle = Open(child, ReadControl | ReadAttributes))
                {
                    FileInformation info = Information(handle);
                    if ((info.Attributes & ReparsePoint) != 0 ||
                        ((info.Attributes & DirectoryAttribute) == 0 &&
                        !InternalLinks(child, info, privateRoot, rootIdentity, migrate, aliases)))
                    {
                        records.Add(Record(child, info, false));
                        continue;
                    }
                    RawSecurityDescriptor security = Security(handle);
                    if (!Owned(security)) { records.Add(Record(child, info, false)); continue; }
                    if (migrate) MakePrivate(child, handle, info, security);
                    bool safe = Private(Security(handle), (info.Attributes & DirectoryAttribute) != 0);
                    records.Add(Record(child, Information(handle), safe));
                    if (safe && (info.Attributes & DirectoryAttribute) != 0)
                        Walk(child, privateRoot, rootIdentity, migrate, records);
                }
            }
            catch
            {
                // A rejected directory is never traversed; its descendants are absent
                // from the snapshot and therefore cannot receive permission grants.
                if (records.Count > firstRecord)
                    records.RemoveRange(firstRecord, records.Count - firstRecord);
                records.Add(new StorageAclRecord { path = child, safe = false });
            }
            finally { foreach (SafeFileHandle alias in aliases) alias.Dispose(); }
        }
    }

    public static StorageAclReply Execute(string action, string input, string inputRoot)
    {
        if (User == null || String.IsNullOrEmpty(input) ||
            (action != "prepare" && action != "directory" && action != "tree" && action != "check"))
            throw new IOException("Invalid ACL request");
        string path = Path.GetFullPath(input).TrimEnd('\\');
        string privateRoot = action == "check" ?
            (String.IsNullOrEmpty(inputRoot) ? null : Path.GetFullPath(inputRoot).TrimEnd('\\')) : path;
        FileInformation? rootIdentity = null;
        List<SafeFileHandle> ancestors = new List<SafeFileHandle>();
        try
        {
            PinAncestors(path, null, null, false, ancestors);
            if (action == "check" && privateRoot != null)
            {
                if (!String.Equals(path, privateRoot, StringComparison.OrdinalIgnoreCase) &&
                    !path.StartsWith(privateRoot + "\\", StringComparison.OrdinalIgnoreCase))
                    throw new IOException("File is outside its storage root");
                PinAncestors(privateRoot, null, null, false, ancestors);
                SafeFileHandle tree = Open(privateRoot, ReadControl | ReadAttributes);
                ancestors.Add(tree);
                FileInformation treeInfo = Information(tree);
                RawSecurityDescriptor treeSecurity = Security(tree);
                if ((treeInfo.Attributes & ReparsePoint) != 0 ||
                    (treeInfo.Attributes & DirectoryAttribute) == 0 ||
                    !String.Equals(CanonicalPath(tree), privateRoot, StringComparison.OrdinalIgnoreCase) ||
                    !User.Equals(treeSecurity.Owner) || !Private(treeSecurity, true) ||
                    (treeSecurity.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0)
                    throw new IOException("Unsafe storage root");
                rootIdentity = treeInfo;
                PinAncestors(path, privateRoot, rootIdentity, false, ancestors);
            }
            using (SafeFileHandle handle = Open(path, ReadControl | ReadAttributes))
            {
                FileInformation info = Information(handle);
                if ((info.Attributes & ReparsePoint) != 0 ||
                    !String.Equals(CanonicalPath(handle), path, StringComparison.OrdinalIgnoreCase) ||
                    ((info.Attributes & DirectoryAttribute) == 0 &&
                    !InternalLinks(path, info, privateRoot, rootIdentity, false, ancestors)))
                    throw new IOException("Unsafe storage identity");
                bool directory = (info.Attributes & DirectoryAttribute) != 0;
                RawSecurityDescriptor security = Security(handle);
                bool migrate = false;
                if (action != "check")
                {
                    if (!directory || !Owned(security)) throw new IOException("Unsafe directory owner");
                    bool protectedRoot = User.Equals(security.Owner) && Private(security, true) &&
                        (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0;
                    if (!protectedRoot)
                    {
                        // Only an inherited creation ACL can be converted on first access.
                        // A protected private root that was broadened is never repaired.
                        if (action != "prepare" || !InheritedOnly(security))
                            throw new IOException("Unsafe directory ACL");
                        MakePrivate(path, handle, info, security);
                        migrate = true;
                    }
                }
                if (action != "check") rootIdentity = info;
                bool safe = Private(Security(handle), directory);
                List<StorageAclRecord> records = new List<StorageAclRecord>();
                records.Add(Record(path, Information(handle), safe));
                if (safe && (action == "prepare" || action == "tree"))
                    Walk(path, privateRoot, rootIdentity.Value, migrate, records);
                // GetFullPath can expand 8.3 names. Keep the validated internal
                // paths for all security checks, then restore the caller's root
                // spelling only in the reply that indexes its JavaScript snapshot.
                string requestedRoot = input.Replace('/', '\\').TrimEnd('\\');
                foreach (StorageAclRecord record in records)
                {
                    if (String.Equals(record.path, path, StringComparison.OrdinalIgnoreCase))
                        record.path = requestedRoot;
                    else
                    {
                        if (!record.path.StartsWith(path + "\\", StringComparison.OrdinalIgnoreCase))
                            throw new IOException("Record is outside its validated root");
                        record.path = requestedRoot + record.path.Substring(path.Length);
                    }
                }
                return new StorageAclReply { ok = true, records = records.ToArray() };
            }
        }
        finally { foreach (SafeFileHandle ancestor in ancestors) ancestor.Dispose(); }
    }
}
'@

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -TypeDefinition $source -Language CSharp
    $reply = [StorageAclNative]::Execute([string]$request.action, [string]$request.path, [string]$request.root)
    [Console]::WriteLine(($reply | ConvertTo-Json -Depth 5 -Compress))
    exit 0
} catch {
    [Console]::WriteLine('{"ok":false,"records":[]}')
    exit 1
}
