# Upload les checkpoints locaux vers le dataset Kaggle "comfyui-models"
# Usage : .\push-models-dataset.ps1 [-VersionNotes "ajout RealVisXL"]
param([string]$VersionNotes = "models update")
$ErrorActionPreference = 'Stop'
$staging = Join-Path $PSScriptRoot 'dataset-staging'
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# Les ckpts lourds et stables (sdxl) — on copie depuis le ComfyUI local si present
$comfyModels = "$env:COMFYUI_HOME\models\checkpoints"
if (-not $comfyModels -or -not (Test-Path $comfyModels)) {
    $comfyModels = 'F:\ComfyUI_windows_portable\ComfyUI\models\checkpoints'
}
$wanted = @('RealVisXL_V5.0_fp16.safetensors', 'DreamShaperXL_Turbo_v2.safetensors')
foreach ($f in $wanted) {
    $src = Join-Path $comfyModels $f
    $dst = Join-Path $staging $f
    if ((Test-Path $src) -and -not (Test-Path $dst)) { Copy-Item $src $dst }
}

'{"title":"comfyui-models","id":"lascardm/comfyui-models","licenses":[{"name":"other"}]}' |
    Set-Content (Join-Path $staging 'dataset-metadata.json') -Encoding UTF8

$slug = 'lascardm/comfyui-models'
kaggle datasets status $slug 2>$null
if ($LASTEXITCODE -eq 0) {
    kaggle datasets version -p $staging -m $VersionNotes --dir-mode zip
} else {
    kaggle datasets create -p $staging --dir-mode zip
}
