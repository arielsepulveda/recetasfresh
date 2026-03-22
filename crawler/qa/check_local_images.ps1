$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$jsonDir = Join-Path $repoRoot 'crawler\downloads_json'
Write-Output "Start sample check (10 random JSON from crawler/downloads_json)"
$files = Get-ChildItem $jsonDir -Filter '*.json' | Get-Random -Count 10
$report = @()
foreach ($f in $files) {
    $j = Get-Content $f.FullName -Raw | ConvertFrom-Json
    $topok = [bool]$j.localImage
    $ingCount = 0
    $ingMissing = 0
    $ingredients = $j.ingredients
    if (-not $ingredients) { $ingredients = @() }
    foreach ($ing in $ingredients) {
        $ingCount++
        if (-not $ing.localImage) { $ingMissing++ }
    }
    $stepsCount = 0
    $stepsMissing = 0
    $steps = $j.steps
    if (-not $steps) { $steps = @() }
    foreach ($st in $steps) {
        $stepsCount++
        if (-not $st.localImage) { $stepsMissing++ }
    }
    $missingFiles = 0
    $totalFiles = 0
    $paths = @()
    if ($j.localImage) { $paths += $j.localImage }
    foreach ($ing in $ingredients) { if ($ing.localImage) { $paths += $ing.localImage } }
    foreach ($st in $steps) { if ($st.localImage) { $paths += $st.localImage } }

    foreach ($path in $paths) {
        $totalFiles++
        $p = Join-Path $repoRoot ($path.TrimStart('/').Replace('/','\\'))
        if (-not (Test-Path $p)) { $missingFiles++ }
    }
    $topText = 'no'
    if ($topok) { $topText = 'yes' }
    $report += [pscustomobject]@{
        file = $f.Name
        status = $j.status
        top = $topText
        ingredients = "$ingCount total, $ingMissing missing localImage"
        steps = "$stepsCount total, $stepsMissing missing localImage"
        imagesOK = "total $totalFiles, missing $missingFiles"
    }
}
$report | Format-List
Write-Output "Done"
