param([switch]$PlanOnly, [switch]$Start, [switch]$AllowDownloads,
  [ValidateSet('', 'source', 'venv', 'models', 'workflows')][string]$Step = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$plan = (& node (Join-Path $PSScriptRoot 'environment-plan.ts') managed) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Cannot create setup plan' }
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 10; return }
if (!$Step) {
  $arguments = @((Join-Path $PSScriptRoot 'install-environment.ts'))
  if ($Start) { $arguments += '--start' }
  if ($AllowDownloads) { $arguments += '--allow-downloads' }
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Setup failed; inspect runtime/setup-install-state.json and rerun to resume' }
  return
}
$comfyRoot = Join-Path $plan.root 'comfyui'
$pythonPath = Join-Path $plan.root 'venv/Scripts/python.exe'
New-Item -ItemType Directory -Force $plan.root | Out-Null
if ($Step -eq 'source') {
  $markerFile = Join-Path $plan.root 'source-checkout-pending.json'
  if (!(Test-Path -LiteralPath $comfyRoot)) {
    $cloneSource = $plan.source
    if ($env:VO_COMFY_SOURCE_CACHE) {
      $cache = [IO.Path]::GetFullPath($env:VO_COMFY_SOURCE_CACHE)
      $cacheRevision = & git -C $cache rev-parse HEAD
      $cacheOrigin = & git -C $cache remote get-url origin
      $cacheDirty = & git -C $cache status --porcelain --untracked-files=no
      if ($cacheRevision -ne $plan.revision -or $cacheOrigin -ne $plan.source -or $cacheDirty) { throw 'Source cache is not the reviewed clean upstream revision' }
      $cloneSource = $cache
    } elseif (!$AllowDownloads) { throw 'Offline setup requires a verified VO_COMFY_SOURCE_CACHE; no source downloaded' }
    @{ target = $comfyRoot; revision = $plan.revision; pending = $true } | ConvertTo-Json | Set-Content -LiteralPath $markerFile -Encoding utf8
    & git clone --no-checkout --no-hardlinks $cloneSource $comfyRoot
    if ($LASTEXITCODE -ne 0) { throw 'Source clone incomplete; preserve the journal and resume' }
    & git -C $comfyRoot remote set-url origin $plan.source
    if ($LASTEXITCODE -ne 0) { throw 'Cannot record upstream origin' }
  }
  if (!(Test-Path -LiteralPath (Join-Path $comfyRoot '.git'))) { throw 'Existing source directory is not a managed checkout; nothing overwritten' }
  if ((& git -C $comfyRoot remote get-url origin) -ne $plan.source) { throw 'Source origin differs; nothing overwritten' }
  if (Test-Path -LiteralPath $markerFile) {
    $marker = Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json
    if ($marker.pending -and $marker.target -eq $comfyRoot -and $marker.revision -eq $plan.revision) {
      & git -C $comfyRoot checkout --detach $plan.revision
      if ($LASTEXITCODE -ne 0) { throw 'Pinned checkout incomplete; no force or overwrite performed' }
      @{ target = $comfyRoot; revision = $plan.revision; pending = $false } | ConvertTo-Json | Set-Content -LiteralPath $markerFile -Encoding utf8
    }
  }
  if ((& git -C $comfyRoot rev-parse HEAD) -ne $plan.revision) { throw 'Existing revision differs; no update performed' }
}
if ($Step -eq 'venv') {
  $offline = @(); if (!$AllowDownloads) { $offline = @('--offline') }
  if (!(Test-Path -LiteralPath $pythonPath)) {
    & uv venv @offline --python 3.13.17 (Join-Path $plan.root 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python creation incomplete; offline mode never downloads Python' }
  }
  & uv pip sync @offline --python $pythonPath (Join-Path $PSScriptRoot 'comfy-requirements.lock.txt') --extra-index-url https://download.pytorch.org/whl/cu130
  if ($LASTEXITCODE -ne 0) { throw 'Dependency sync incomplete; resume from existing venv and cache' }
}
if ($Step -eq 'models') {
  $pathsFile = Join-Path $plan.root 'extra-model-paths.yaml'
  if (Test-Path -LiteralPath $pathsFile) { throw 'Existing model references are preserved; review before replacing' }
  $categories = @('checkpoints','configs','loras','vae','clip_vision','style_models','embeddings','diffusers','vae_approx','controlnet','gligen','upscale_models','latent_upscale_models','hypernetworks','photomaker','model_patches','audio_encoders','background_removal','frame_interpolation','geometry_estimation','optical_flow','detection')
  $yaml = @('studio:', ('  base_path: ' + ($plan.shared_models -replace '\\','/')))
  foreach ($category in $categories) { $yaml += "  ${category}: $category/" }
  $yaml += @('  text_encoders: |','    text_encoders/','    clip/','  diffusion_models: |','    diffusion_models/','    unet/')
  $yaml | Set-Content -LiteralPath $pathsFile -Encoding utf8
}
if ($Step -eq 'workflows') {
  $workflowRoot = Join-Path $plan.root 'user/default/workflows'
  $apiCopies = Join-Path $plan.root 'workflows-api'
  New-Item -ItemType Directory -Force $workflowRoot, $apiCopies | Out-Null
  $sourceRoot = Join-Path $repoRoot '../../vendor/ComfyUI/ComfyUI/user/default/workflows'
  if (Test-Path -LiteralPath $sourceRoot) {
    Get-ChildItem -LiteralPath $sourceRoot -Filter '*.json' -File | ForEach-Object {
      $target = Join-Path $workflowRoot $_.Name
      if (!(Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath $_.FullName -Destination $target }
    }
  }
  $convert = "import importlib.util,json,sys,pathlib; s=importlib.util.spec_from_file_location('vo_converter',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);src=pathlib.Path(sys.argv[2]);dst=pathlib.Path(sys.argv[3]);[(dst/f.name).write_text(json.dumps(m.convert(json.loads(f.read_text(encoding='utf-8'))).prompt,indent=2),encoding='utf-8') for f in src.glob('*.json') if not (dst/f.name).exists()]"
  & $pythonPath -I -c $convert (Join-Path $PSScriptRoot 'comfy-ui2api.py') $workflowRoot $apiCopies
  if ($LASTEXITCODE -ne 0) { throw 'Workflow conversion incomplete; existing copies retained' }
}
