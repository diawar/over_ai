$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../tools/p1-catalog.ps1')
function Assert-True($condition, $message) { if (-not $condition) { throw $message } }
function Expect-Failure([scriptblock]$action, [string]$message) {
    $failed = $false
    try { & $action | Out-Null } catch { $failed = $true }
    Assert-True $failed $message
}
function New-Page($number, $ids, $total = 3, $pages = 2, $next = $false) {
    [pscustomobject]@{
        hasNext = $next; totalElements = $total; totalPages = $pages; currentPage = $number
        pageItems = @($ids | ForEach-Object { [pscustomobject]@{ skuOver = $_; priceLoan = $null; dealersData = @('TEST (0)'); extraField = 'preserved' } })
    }
}
$valid = { param($n,$size)
    Assert-True ($size -eq 2) 'Requested size lost.'
    if ($n -eq 0) { New-Page 0 @('a','b') 3 2 $true } else { New-Page 1 @('c') }
}
$result = Get-P1Catalog $valid 2 0
Assert-True ($result.items.Count -eq 3) 'Pagination failed.'
Assert-True ($result.items[0].extraField -eq 'preserved') 'Unknown field lost.'
Assert-True ($null -eq $result.items[0].priceLoan) 'Null price lost.'
Expect-Failure { Get-P1Catalog { param($n,$s) if ($n -eq 0) { New-Page 0 @('a','b') 3 2 $true } else { New-Page 1 @('a') } } 2 0 } 'Duplicate accepted.'
Expect-Failure { Get-P1Catalog { New-Page 0 @('a') 2 1 $false } 2 0 } 'Missing products accepted.'
Expect-Failure { Get-P1Catalog { New-Page 1 @('a') 1 2 $false } 2 0 } 'Wrong page accepted.'
Expect-Failure { Get-P1Catalog { New-Page 0 @() 3 2 $true } 2 0 } 'Empty intermediate page accepted.'
Expect-Failure { Get-P1Catalog { param($n,$s) if ($n -eq 0) { New-Page 0 @('a','b') 3 2 $true } else { New-Page 1 @('c') 4 2 $false } } 2 0 } 'Changing total accepted.'
$empty = Get-P1Catalog { New-Page 0 @() 0 0 $false } 2 0
Assert-True ($empty.items.Count -eq 0) 'Empty catalog failed.'
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ('over-p1-test-' + [guid]::NewGuid().ToString('N'))
$testFile = Join-Path $testDirectory 'catalog.json'
try {
    Save-P1Catalog $result $testFile
    Save-P1Catalog $empty $testFile
    $saved = Get-Content -Raw -Encoding UTF8 $testFile | ConvertFrom-Json
    Assert-True ($saved.totalElements -eq 0 -and $saved.items.Count -eq 0) 'Atomic replacement failed.'
} finally {
    if ([IO.File]::Exists($testFile)) { [IO.File]::Delete($testFile) }
    if ([IO.Directory]::Exists($testDirectory)) { [IO.Directory]::Delete($testDirectory) }
}
# Emulate PowerShell's wrongly decoded Content; raw bytes must win.
function Invoke-WebRequest {
    $word = -join @([char]0x041A,[char]0x043E,[char]0x0440,[char]0x043F,[char]0x0443,[char]0x0441)
    $bytes = [Text.Encoding]::UTF8.GetBytes($word)
    $stream = New-Object IO.MemoryStream(,$bytes)
    return [pscustomobject]@{ Content = 'WRONG-DECODED-TEXT'; RawContentStream = $stream }
}
$decoded = Invoke-P1Post '/api/master-catalog/all' @{} 'test-token'
Assert-True ($decoded[0] -eq [char]0x041A -and $decoded.Length -eq 6) 'UTF-8 decoding failed.'
Write-Host 'PASS: pagination, raw fields, duplicates, missing data, changing totals, empty catalog, atomic save, UTF-8 bytes.'
