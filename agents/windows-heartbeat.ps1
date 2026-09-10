# Windows heartbeat agent (PowerShell)
#
# Config (do NOT hardcode secrets in this file):
#   1. Environment variables (preferred for Task Scheduler / Intune), OR
#   2. Optional local file: heartbeat.local.ps1 (gitignored) — copy from heartbeat.local.ps1.example
#
# Schedule every 5 minutes:
#   powershell.exe -ExecutionPolicy Bypass -File C:\IT\windows-heartbeat.ps1

$ErrorActionPreference = 'Stop'

# Optional local overrides (never commit real values)
$localConfig = Join-Path $PSScriptRoot 'heartbeat.local.ps1'
if (Test-Path $localConfig) {
  . $localConfig
}

function Get-MitConfig([string]$Name, [string]$Fallback = '') {
  $envVal = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($envVal)) { return $envVal.Trim() }
  $scriptVar = Get-Variable -Name $Name -Scope Script -ErrorAction SilentlyContinue
  if ($scriptVar -and -not [string]::IsNullOrWhiteSpace([string]$scriptVar.Value)) {
    return ([string]$scriptVar.Value).Trim()
  }
  return $Fallback
}

$HeartbeatUrl = Get-MitConfig 'MIT_HEARTBEAT_URL' (Get-MitConfig 'HeartbeatUrl')
$HeartbeatSecret = Get-MitConfig 'MIT_HEARTBEAT_SECRET' (Get-MitConfig 'HeartbeatSecret')
$AgentId = Get-MitConfig 'MIT_AGENT_ID' (Get-MitConfig 'AgentId')
$WorkspaceId = Get-MitConfig 'MIT_WORKSPACE_ID' (Get-MitConfig 'WorkspaceId' 'main')

if ([string]::IsNullOrWhiteSpace($HeartbeatUrl) -or
    [string]::IsNullOrWhiteSpace($HeartbeatSecret) -or
    [string]::IsNullOrWhiteSpace($AgentId)) {
  Write-Error @"
Missing heartbeat config. Set environment variables:
  MIT_HEARTBEAT_URL      e.g. https://YOUR_PROJECT.supabase.co/functions/v1/heartbeat
  MIT_HEARTBEAT_SECRET   same as Supabase HEARTBEAT_SECRET / app Settings
  MIT_AGENT_ID           asset tag from MIT Asset (e.g. IT-LP-001)
  MIT_WORKSPACE_ID       optional, default main

Or copy agents/heartbeat.local.ps1.example to agents/heartbeat.local.ps1 and fill values.
"@
  exit 2
}

$hostname = $env:COMPUTERNAME
$mac = (Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.MacAddress } | Select-Object -First 1).MacAddress

$body = @{
  agentId     = $AgentId
  assetTag    = $AgentId
  hostname    = $hostname
  mac         = $mac
  workspaceId = $WorkspaceId
} | ConvertTo-Json

try {
  Invoke-RestMethod -Method Post -Uri $HeartbeatUrl -Headers @{
    'Content-Type'       = 'application/json'
    'x-heartbeat-secret' = $HeartbeatSecret
  } -Body $body | Out-Null
} catch {
  # Silent fail so the scheduled task does not spam; check MIT Asset "Last seen".
  exit 1
}
