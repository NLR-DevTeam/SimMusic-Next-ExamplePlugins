# Build and package the five example extensions from this directory.
param([string]$GoToolchain = "C:\VM Projects\Go Tool Chain")
$ErrorActionPreference = "Stop"
$workspace = $PSScriptRoot
$release = Join-Path $workspace "release"
$env:PATH = "$(Join-Path $GoToolchain 'go/bin');$env:PATH"
$env:GOCACHE = Join-Path $GoToolchain "gocache"
$env:GOPATH = Join-Path $GoToolchain "gopath"
$goExe = Join-Path $GoToolchain "go/bin/go.exe"
if (!(Test-Path -LiteralPath $goExe)) { throw "Go toolchain not found: $goExe" }
$gccCommand = Get-Command gcc -ErrorAction SilentlyContinue
$gccExe = if ($gccCommand) { $gccCommand.Source } else {
    Join-Path $env:LOCALAPPDATA "Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin/gcc.exe"
}
if (!(Test-Path -LiteralPath $gccExe)) { throw "Windows x64 MinGW GCC is required" }
$compilerDir = Split-Path $gccExe
$env:PATH = "$compilerDir;$env:PATH"
$stageRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "SimMusicNext"))
$stage = Join-Path $stageRoot ("example-build-" + [guid]::NewGuid().ToString("N"))
if (![IO.Path]::GetFullPath($stage).StartsWith($stageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Invalid staging directory"
}
New-Item -ItemType Directory -Force -Path $stage, $release | Out-Null
$savedGoos, $savedGoarch, $savedCgo = $env:GOOS, $env:GOARCH, $env:CGO_ENABLED
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
Push-Location $workspace
try {
    # Taskbar lyrics native window and Windows 11 layout component.
    $taskbar = Join-Path $PSScriptRoot "taskbarLyrics"
    Push-Location (Join-Path $taskbar "native")
    try {
        & (Join-Path $compilerDir "windres.exe") taskbarLyrics.rc -O coff -o (Join-Path $stage "resources.o")
        if ($LASTEXITCODE -ne 0) { throw "Taskbar resource build failed" }
    } finally { Pop-Location }
    & (Join-Path $compilerDir "g++.exe") -std=c++17 -O2 -Wall -shared -static "-specs=$taskbar/native/gcc.specs" (Join-Path $taskbar "native/taskbarLayout.cpp") -o (Join-Path $taskbar "taskbarLayout-1.1.3.dll") -lole32 -loleaut32 -luuid -luser32
    if ($LASTEXITCODE -ne 0) { throw "Taskbar layout build failed" }
    & $gccExe -std=gnu11 -O2 -Wall -municode -mwindows -static "-specs=$taskbar/native/gcc.specs" (Join-Path $taskbar "native/taskbarLyrics.c") (Join-Path $stage "resources.o") -o (Join-Path $taskbar "taskbarLyrics.exe") -luser32 -lgdi32 -lgdiplus -ladvapi32
    if ($LASTEXITCODE -ne 0) { throw "Taskbar window build failed" }

    # The relay carries its own checked-in web assets.
    $musicSync = Join-Path $PSScriptRoot "musicSync"
    $relayTarget = Join-Path $release "musicSyncRelay"
    New-Item -ItemType Directory -Force -Path $relayTarget | Out-Null
    $env:CGO_ENABLED = "0"
    $env:GOARCH = "amd64"
    foreach ($platform in @("windows", "linux")) {
        $env:GOOS = $platform
        $suffix = if ($platform -eq "windows") { ".exe" } else { "" }
        $uploadFlags = if ($platform -eq "windows") { "-s -w -H windowsgui" } else { "-s -w" }
        & $goExe build -trimpath -ldflags $uploadFlags -o (Join-Path $musicSync "musicSyncUpload$suffix") ./musicSync/upload
        if ($LASTEXITCODE -ne 0) { throw "Upload helper build failed: $platform" }
        & $goExe build -trimpath -ldflags "-s -w" -o (Join-Path $relayTarget "musicsync-relay$suffix") ./musicSync/relay
        if ($LASTEXITCODE -ne 0) { throw "Relay build failed: $platform" }
    }

    $packages = @(
        @{ id = "ncmNext"; name = "NcmNext"; files = @("plugin.json", "main.js", "page") },
        @{ id = "taskbarLyrics"; name = "TaskbarLyrics"; files = @("plugin.json", "main.js", "taskbarLyrics.exe", "taskbarLayout-1.1.3.dll") },
        @{ id = "lyricVideo"; name = "LyricVideo"; files = @("plugin.json", "main.js", "mv.html", "mv.css", "mv.js", "preview.svg") },
        @{ id = "lyricWheel"; name = "LyricWheel"; files = @("plugin.json", "main.js", "wheel.html", "wheel.css", "wheel.js", "preview.svg") },
        @{ id = "musicSync"; name = "MusicSync"; files = @("plugin.json", "main.js", "page", "musicSyncUpload.exe", "musicSyncUpload") }
    )
    foreach ($package in $packages) {
        $source = Join-Path $PSScriptRoot $package.id
        $manifest = Get-Content -LiteralPath (Join-Path $source "plugin.json") -Raw -Encoding utf8 | ConvertFrom-Json
        $target = Join-Path $release "SimMusic-$($package.name)-$($manifest.version).simex"
        $packageStage = Join-Path $stage $package.id
        New-Item -ItemType Directory -Path $packageStage | Out-Null
        foreach ($relative in $package.files) {
            Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $packageStage -Recurse
        }
        $archive = [IO.Compression.ZipArchive]::new([IO.File]::Open($target, [IO.FileMode]::Create), [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in Get-ChildItem -LiteralPath $packageStage -Recurse -File) {
                $entry = $file.FullName.Substring($packageStage.Length + 1).Replace("\", "/")
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        } finally { $archive.Dispose() }
        Write-Output $target
    }
    Write-Output $relayTarget
} finally {
    Pop-Location
    $env:GOOS, $env:GOARCH, $env:CGO_ENABLED = $savedGoos, $savedGoarch, $savedCgo
    Remove-Item -LiteralPath $stage -Recurse -Force
}
