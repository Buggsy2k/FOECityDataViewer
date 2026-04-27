$ErrorActionPreference = 'Stop'

$sourceDir = Join-Path $PSScriptRoot 'dist'
$destinationDir = 'W:\FOECityData'
$destinationIndex = Join-Path $destinationDir 'index.html'

if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
    throw "Source folder does not exist: $sourceDir"
}

if (-not (Test-Path -LiteralPath $destinationDir -PathType Container)) {
    throw "Destination folder does not exist: $destinationDir"
}

if (-not (Test-Path -LiteralPath $destinationIndex -PathType Leaf)) {
    throw "Safety check failed: index.html not found in destination: $destinationDir"
}

Copy-Item -Path (Join-Path $sourceDir '*') -Destination $destinationDir -Recurse -Force
Write-Host "Copy complete: $sourceDir -> $destinationDir"
