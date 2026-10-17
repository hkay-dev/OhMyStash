#Requires -Version 7.0
<#
.SYNOPSIS
Builds the optional Windows permission worker from the existing ACL validator.
.DESCRIPTION
Extracts StorageAclNative unchanged from storage-permissions.ps1 and combines it
with storage-acl-server.cs. Writes storage-acl-worker.cs and storage-acl-worker.exe
only. Requires Windows, PowerShell 7, and the Windows .NET Framework C# compiler.
It doesn't change stash files or permissions and refuses an existing executable.
.PARAMETER OutputDirectory
Existing absolute output directory. Defaults to this extension's directory.
.EXAMPLE
pwsh -NoProfile -File ./extensions/build-storage-worker.ps1
#>
param([string]$OutputDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This optional worker build is Windows-only' }
if (-not [IO.Path]::IsPathFullyQualified($OutputDirectory) -or -not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    throw 'OutputDirectory must be an existing absolute directory'
}
$content = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'storage-permissions.ps1'))
$match = [regex]::Match($content, '(?s)\$source = @''\r?\n(.*?)\r?\n''@')
if (-not $match.Success) { throw 'Existing ACL validator source was not found' }
$entry = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'storage-acl-server.cs'))
$source = Join-Path $OutputDirectory 'storage-acl-worker.cs'
$executable = Join-Path $OutputDirectory 'storage-acl-worker.exe'
if (Test-Path -LiteralPath $executable) { throw 'Worker already exists; stop OMP and move the old worker aside before rebuilding' }
[IO.File]::WriteAllText($source, $match.Groups[1].Value + "`n" + $entry, [Text.UTF8Encoding]::new($false))
$framework = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
& (Join-Path $framework 'csc.exe') /nologo /target:exe /optimize+ /warnaserror+ "/out:$executable" "/reference:$(Join-Path $framework 'System.Web.Extensions.dll')" $source
$code = $LASTEXITCODE
if ($code -ne 0) { throw "Windows worker build exited $code" }
[pscustomobject]@{ Built = $executable; Sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash; ValidatorUnchanged = $true } | ConvertTo-Json -Compress
