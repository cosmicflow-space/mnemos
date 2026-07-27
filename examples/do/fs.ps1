# /do fs <name…> — Windows fuzzy file-name hunt (counterpart of the POSIX `fs`).
#
# Accepts a natural query: spaces, camelCase, fused ("annualreport"), or separators.
# Tokenizes it and returns files whose NAME — compared with all separators
# stripped — contains EVERY token (case-insensitive, order-free), under the
# user's profile. READ-only: it observes file names, never contents.
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

# Candidates named "*$Seed*", kept when the separator-stripped name contains
# every token — so a fused query still matches a spaced file. `Select-Object
# -First` bounds DISCOVERY, not just output: it stops the upstream recursive
# walk once the cap is reached. One spare item above the cap is what tells the
# caller to print the "narrow it" hint.
function Find-Match([string]$Seed) {
  Get-ChildItem -LiteralPath $env:USERPROFILE -Recurse -File -Filter "*$Seed*" -Force |
    Where-Object { $_.FullName -notmatch $pruneRe } |
    Where-Object {
      $base = ([regex]::Replace($_.Name, '[^A-Za-z0-9]', '')).ToLower(); $all = $true
      foreach ($t in $tokens) { if ($base -notlike "*$t*") { $all = $false; break } }
      $all
    } |
    ForEach-Object { $_.FullName } |
    Select-Object -First ($limit + 1)
}

$out = @(Find-Match $seed)

# A fused token cannot seed a file-name scan: nothing on disk is literally named
# "*annualreport*" — the words are separated there. Retry seeded by the token's
# first four characters, which survive contiguously in the common case. Every
# token is still required to match, so this widens the candidate set without
# loosening the result. LIMIT: the seed must appear contiguously on disk, so a
# compound whose first word is shorter than the prefix ("foobarbaz" vs
# "foo_bar_baz") still misses.
if ($out.Count -eq 0 -and $seed.Length -ge 5) {
  $out = @(Find-Match $seed.Substring(0, 4))
}

if ($out.Count -eq 0) { exit 0 }
$out | Select-Object -First $limit
if ($out.Count -gt $limit) {
  [Console]::Error.WriteLine("...more than $limit matches; add another word to narrow.")
}
exit 0
