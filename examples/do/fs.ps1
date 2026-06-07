# /do fs <glob> — Windows counterpart of the POSIX `fs` verb (see examples/do/fs).
#
# Finds files under the user's profile whose NAME matches <glob>. The dispatcher
# runs this via `powershell -NoProfile -File fs.ps1 <glob>`; $Pattern arrives
# ALREADY validated to a bare glob (letters/digits and . _ - * ? [ ] only — no
# '\', '/', '..', quotes, or whitespace), so it is a NAME to match, never a path
# or PowerShell syntax. READ-only: it observes file names, never contents.
#
# Note: Windows has no Spotlight index, so this walks the tree (slower than the
# macOS mdfind fast-path). Glob support is `*` and `?` (FileSystem -Filter);
# character classes like [ab] are not supported here.
[CmdletBinding()]
param([Parameter(Mandatory = $true, Position = 0)][string]$Pattern)

$ErrorActionPreference = 'SilentlyContinue'
$limit = 50
# Prune sensitive / noisy trees (matched anywhere in the path, case-insensitive).
$pruneRe = '\\(node_modules|\.git|AppData|\.cache|\.npm|\.ssh|\.aws|\.gnupg)\\'

# `-First ($limit + 1)` short-circuits the walk early and lets us detect overflow.
$results = Get-ChildItem -LiteralPath $env:USERPROFILE -Recurse -File -Filter $Pattern -Force |
  Where-Object { $_.FullName -notmatch $pruneRe } |
  Select-Object -First ($limit + 1)

$results | Select-Object -First $limit | ForEach-Object { $_.FullName }

if ($results.Count -gt $limit) {
  [Console]::Error.WriteLine("...more than $limit matches; narrow the pattern (e.g. add an extension).")
}
exit 0
