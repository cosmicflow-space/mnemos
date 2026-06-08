# /do fs <name…> — Windows fuzzy file-name hunt (counterpart of the POSIX `fs`).
#
# Accepts a natural query: spaces, camelCase, or separators. Tokenizes it and
# returns files whose NAME contains EVERY token (case-insensitive, order-free),
# under the user's profile. READ-only: it observes file names, never contents.
# $Query is pre-validated by the dispatcher (letters/digits/spaces and . _ - * ? [ ]).
[CmdletBinding()]
param([Parameter(Mandatory = $true, Position = 0)][string]$Query)

$ErrorActionPreference = 'SilentlyContinue'
$limit = 50
$pruneRe = '\\(node_modules|\.git|AppData|\.cache|\.npm|\.ssh|\.aws|\.gnupg)\\'

# Tokenize: split camelCase, then on any non-alphanumeric, lowercase, drop blanks.
$spaced = [regex]::Replace($Query, '([a-z0-9])([A-Z])', '$1 $2')
$tokens = @([regex]::Split($spaced, '[^A-Za-z0-9]+') | Where-Object { $_ } | ForEach-Object { $_.ToLower() })
if ($tokens.Count -eq 0) { exit 0 }
$seed = ($tokens | Sort-Object { $_.Length } -Descending)[0]

$count = 0
Get-ChildItem -LiteralPath $env:USERPROFILE -Recurse -File -Filter "*$seed*" -Force |
  Where-Object { $_.FullName -notmatch $pruneRe } |
  Where-Object {
    $base = $_.Name.ToLower(); $all = $true
    foreach ($t in $tokens) { if ($base -notlike "*$t*") { $all = $false; break } }
    $all
  } |
  ForEach-Object {
    if ($count -ge $limit) { [Console]::Error.WriteLine("...more than $limit matches; add another word."); break }
    $count++
    $_.FullName
  }
exit 0
