$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$plan = (& node (Join-Path $PSScriptRoot 'environment-plan.ts') managed) | ConvertFrom-Json
$pythonPath = Join-Path $plan.root 'venv/Scripts/python.exe'
$manifestFile = Join-Path $plan.root 'processes.json'
$prior = $null
if (Test-Path -LiteralPath $manifestFile) { $prior = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json }
$comfyId = $null; $proxyId = $null
function Save-Processes {
  @{ comfy_pid = $script:comfyId; proxy_pid = $script:proxyId; comfy_url = $plan.comfy_url; proxy_url = $plan.proxy_url; checked_at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $manifestFile
}
$stats = $null
try { $stats = Invoke-RestMethod ($plan.comfy_url + '/system_stats') -TimeoutSec 2 } catch {}
if ($stats) {
  if (!$prior -or $prior.comfy_url -ne $plan.comfy_url -or $stats.system.argv -notcontains (Join-Path $plan.root 'user')) { throw 'Existing listener is not the recorded VO environment; nothing stopped or replaced' }
  $comfyId = (Get-NetTCPConnection -State Listen -LocalPort 8288 | Select-Object -First 1).OwningProcess
} else {
  if (Get-NetTCPConnection -State Listen -LocalPort 8288 -ErrorAction SilentlyContinue) { throw 'Port 8288 is occupied; no service stopped' }
  $arguments = @('main.py','--listen','127.0.0.1','--port','8288','--user-directory',('"' + (Join-Path $plan.root 'user') + '"'),'--output-directory',('"' + (Join-Path $plan.root 'output') + '"'),'--extra-model-paths-config',('"' + (Join-Path $plan.root 'extra-model-paths.yaml') + '"'),'--disable-auto-launch','--offline')
  $comfy = Start-Process -FilePath $pythonPath -ArgumentList $arguments -WorkingDirectory (Join-Path $plan.root 'comfyui') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $plan.root 'comfy.stdout.log') -RedirectStandardError (Join-Path $plan.root 'comfy.stderr.log')
  $comfyId = $comfy.Id; Save-Processes
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    try { $stats = Invoke-RestMethod ($plan.comfy_url + '/system_stats') -TimeoutSec 2; break } catch { Start-Sleep -Seconds 1 }
  }
  if (!$stats) { throw 'ComfyUI startup incomplete; the process manifest allows a later resume' }
}
$health = $null
try { $health = Invoke-RestMethod ($plan.proxy_url + '/api/v2/health') -TimeoutSec 2 } catch {}
if ($health) {
  if (!$prior -or $prior.proxy_url -ne $plan.proxy_url -or $health.upstream -ne $plan.comfy_url) { throw 'Existing proxy is not the recorded VO proxy; nothing replaced' }
  $proxyId = (Get-NetTCPConnection -State Listen -LocalPort 8289 | Select-Object -First 1).OwningProcess
} else {
  if (Get-NetTCPConnection -State Listen -LocalPort 8289 -ErrorAction SilentlyContinue) { throw 'Port 8289 is occupied; no service stopped' }
  $proxyArguments = @('--comfyui',$plan.comfy_url,'--host','127.0.0.1','--port','8289','--state-dir',('"' + (Join-Path $plan.root 'proxy-state') + '"'))
  $proxy = Start-Process -FilePath (Join-Path $plan.root 'venv/Scripts/comfy-api-proxy.exe') -ArgumentList $proxyArguments -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $plan.root 'proxy.stdout.log') -RedirectStandardError (Join-Path $plan.root 'proxy.stderr.log')
  $proxyId = $proxy.Id; Save-Processes
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $health = Invoke-RestMethod ($plan.proxy_url + '/api/v2/health') -TimeoutSec 2; break } catch { Start-Sleep -Seconds 1 }
  }
  if (!$health) { throw 'Proxy startup incomplete; existing ComfyUI is retained for resume' }
}
Save-Processes
Write-Output ('VO services ready (existing healthy services reused): ' + $plan.comfy_url + ', ' + $plan.proxy_url)
