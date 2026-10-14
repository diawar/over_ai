param(
    [string]$CredentialsPath = (Join-Path $PSScriptRoot '../.secrets/p1.credentials.json'),
    [string]$OutputPath = (Join-Path $PSScriptRoot '../data/p1-catalog.json'),
    [ValidateRange(1,100)][int]$PageSize = 100
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-P1Catalog {
    param([scriptblock]$FetchPage, [int]$Size = 100, [int]$PauseMs = 250)
    $items = New-Object 'System.Collections.Generic.List[object]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $total = -1
    $pages = -1
    $number = 0
    do {
        $page = & $FetchPage $number $Size
        foreach ($field in @('currentPage','totalPages','totalElements','hasNext','pageItems')) {
            if ($null -eq $page -or $null -eq $page.PSObject.Properties[$field]) { throw "Missing field: $field" }
        }
        foreach ($field in @('currentPage','totalPages','totalElements')) {
            $value = $page.$field
            if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0) { throw "Invalid integer: $field" }
        }
        if ($page.hasNext -isnot [bool] -or $page.pageItems -isnot [array]) { throw 'Invalid response types.' }
        if ($total -eq -1) { $total = $page.totalElements; $pages = $page.totalPages }
        if ($page.currentPage -ne $number -or $page.totalElements -ne $total -or $page.totalPages -ne $pages) {
            throw 'Page metadata changed or page order is incorrect. Retry the complete download.'
        }
        if (($total -gt 0 -and $pages -le $number) -or $page.hasNext -ne (($number + 1) -lt $pages)) {
            throw 'Inconsistent pagination metadata.'
        }
        if (($page.hasNext -and $page.pageItems.Count -eq 0) -or $page.pageItems.Count -gt $Size) { throw 'Invalid page length.' }
        foreach ($item in $page.pageItems) {
            if ($null -eq $item -or $null -eq $item.PSObject.Properties['skuOver'] -or
                $item.skuOver -isnot [string] -or [string]::IsNullOrWhiteSpace($item.skuOver)) { throw 'Invalid skuOver.' }
            if (-not $seen.Add($item.skuOver)) { throw 'Duplicate skuOver. Catalog not saved.' }
            $items.Add($item)
        }
        if ($items.Count -gt $total) { throw 'Too many products.' }
        Write-Host ('Page {0}/{1}: {2}/{3} products' -f ($number + 1),$pages,$items.Count,$total)
        $number++
        if ($page.hasNext -and $PauseMs -gt 0) { Start-Sleep -Milliseconds $PauseMs }
    } while ($page.hasNext)
    if ($items.Count -ne $total) { throw 'Incomplete catalog. Catalog not saved.' }
    return [pscustomobject]@{
        source = 'https://p1.overclockers.kz/api/master-catalog/all'
        downloadedAtUtc = [DateTime]::UtcNow.ToString('o')
        totalElements = $total
        pagesFetched = $number
        items = $items.ToArray()
    }
}

function Invoke-P1Post {
    param([string]$Path, $Body, [string]$Token)
    $headers = @{ Accept = 'application/json' }
    if ($Token) { $headers.Authorization = $Token }
    $json = ConvertTo-Json -InputObject $Body -Depth 10 -Compress
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ('https://p1.overclockers.kz' + $Path) `
            -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60 -MaximumRedirection 0
        # Windows PowerShell may decode JSON as Latin-1 when charset is absent.
        # Decode original bytes strictly as UTF-8 instead of using .Content.
        $utf8 = New-Object Text.UTF8Encoding($false, $true)
        return $utf8.GetString($response.RawContentStream.ToArray())
    } catch {
        $status = 'network error'
        if ($null -ne $_.Exception.PSObject.Properties['Response'] -and $null -ne $_.Exception.Response) {
            $status = 'HTTP ' + [int]$_.Exception.Response.StatusCode
        }
        throw "P1 request failed ($status). Server body suppressed. Previous catalog remains unchanged."
    }
}

function Save-P1Catalog {
    param($Catalog, [string]$Path)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $parent = [IO.Path]::GetDirectoryName($fullPath)
    [void][IO.Directory]::CreateDirectory($parent)
    $temporary = Join-Path $parent ([IO.Path]::GetRandomFileName())
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Catalog -Depth 100), (New-Object Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($fullPath)) { [IO.File]::Replace($temporary, $fullPath, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $fullPath) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Start-P1Download {
    if (-not (Test-Path -LiteralPath $CredentialsPath)) { throw 'Create .secrets/p1.credentials.json from config/p1.credentials.example.json.' }
    try { $credentials = Get-Content -LiteralPath $CredentialsPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'Credentials file is not valid JSON.' }
    foreach ($field in @('login','password')) {
        if ($null -eq $credentials.PSObject.Properties[$field] -or $credentials.$field -isnot [string] -or
            [string]::IsNullOrWhiteSpace($credentials.$field)) { throw "Fill credentials field: $field" }
    }
    $rawToken = Invoke-P1Post '/api/auth/login' @{ login = $credentials.login; password = $credentials.password }
    $token = $rawToken.Trim()
    if ($token.StartsWith('"')) {
        try { $token = ConvertFrom-Json -InputObject $token } catch { throw 'Invalid login response.' }
    }
    if ($token -isnot [string] -or [string]::IsNullOrWhiteSpace($token) -or $token -match '[\s{}<>]') { throw 'Login did not return a token string.' }
    $fetch = {
        param($number,$size)
        $body = @{ pageNumber = $number; pageSize = $size; sort = @{ active = ''; direction = '' }; filterModels = @() }
        $raw = Invoke-P1Post '/api/master-catalog/all' $body $token
        try { return ConvertFrom-Json -InputObject $raw } catch { throw 'Catalog response is not valid JSON.' }
    }.GetNewClosure()
    try {
        $catalog = Get-P1Catalog $fetch $PageSize
        Save-P1Catalog $catalog $OutputPath
        Write-Host ('Saved {0} products to {1}' -f $catalog.totalElements,$OutputPath)
    } finally { $token = $null; $rawToken = $null; $credentials = $null }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Start-P1Download } catch { Write-Error $_.Exception.Message; exit 1 }
}
