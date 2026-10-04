$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$user = $identity.User
$item = Get-Item -Force -LiteralPath ([string]$request.path)
$acl = Get-Acl -LiteralPath $item.FullName

if ($request.action -eq 'short-path') {
    $source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class AclFixtureShortPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathName(string path, StringBuilder text, uint length);
    public static string Get(string path) {
        StringBuilder text = new StringBuilder(32768);
        uint length = GetShortPathName(path, text, (uint)text.Capacity);
        if (length == 0 || length >= text.Capacity) throw new Win32Exception();
        return text.ToString();
    }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp
    $short = [AclFixtureShortPath]::Get($item.FullName)
    [Console]::WriteLine(([pscustomobject]@{
        supported = -not [string]::Equals($short, $item.FullName, [StringComparison]::OrdinalIgnoreCase)
        shortPath = $short
    } | ConvertTo-Json -Compress))
    exit 0
} elseif ($request.action -eq 'case-sensitive') {
    $tool = Join-Path $env:SystemRoot 'System32/fsutil.exe'
    $ErrorActionPreference = 'Continue'
    & $tool file setCaseSensitiveInfo $item.FullName enable *> $null
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) {
        [Console]::WriteLine('{"supported":false}')
        exit 0
    }
} elseif ($request.action -eq 'shared-parent') {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagate = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $user, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagate, $allow)))
    $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $everyone, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit, $propagate, $allow)))
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
} elseif ($request.action -eq 'broaden') {
    $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $everyone, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)))
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
} elseif ($request.action -eq 'foreign-owner') {
    $source = @'
using System;
using System.Runtime.InteropServices;
public static class AclFixturePrivilege {
    [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] private struct Privileges {
        public uint Count; public Luid Luid; public uint Attributes;
    }
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(
        IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool
        LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(
        IntPtr token, bool disableAll, ref Privileges privileges, uint length, IntPtr old, IntPtr needed);
    public static bool EnableRestore() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) return false;
        try {
            Luid luid;
            if (!LookupPrivilegeValue(null, "SeRestorePrivilege", out luid)) return false;
            Privileges privileges = new Privileges { Count = 1, Luid = luid, Attributes = 2 };
            return AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero) &&
                Marshal.GetLastWin32Error() == 0;
        } finally { CloseHandle(token); }
    }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp
    if (-not [AclFixturePrivilege]::EnableRestore()) {
        [Console]::WriteLine('{"supported":false}')
        exit 0
    }
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
} elseif ($request.action -ne 'inspect') {
    throw 'Unknown fixture action'
}

$acl = Get-Acl -LiteralPath $item.FullName
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [pscustomobject]@{
        sid = $_.IdentityReference.Value
        inherited = $_.IsInherited
        allow = $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
    }
})
$reply = [pscustomobject]@{
    supported = $true
    user = $user.Value
    defaultOwner = $identity.Owner.Value
    owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    protected = $acl.AreAccessRulesProtected
    rules = $rules
    sddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner, Access')
}
[Console]::WriteLine(($reply | ConvertTo-Json -Depth 4 -Compress))
