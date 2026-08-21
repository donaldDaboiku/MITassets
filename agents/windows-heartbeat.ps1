# Windows heartbeat agent (PowerShell)

# 1. Edit the three values below (no admin passwords — heartbeat secret only).
# 2. Save as C:\IT\mit-heartbeat.ps1
# 3. Schedule every 5 minutes (Task Scheduler → Create Basic Task → trigger: 5 min).

$HeartbeatUrl = "https://YOUR_PROJECT.supabase.co/functions/v1/heartbeat"
$HeartbeatSecret = "YOUR_SHARED_SECRET"
$AgentId = "IT-LP-001"   # Use the asset tag from MIT Asset (or a stable serial)

$hostname = $env:COMPUTERNAME
$mac = (Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.MacAddress } | Select-Object -First 1).MacAddress

$body = @{
  agentId     = $AgentId
  assetTag    = $AgentId
  hostname    = $hostname
  mac         = $mac
  workspaceId = "main"
} | ConvertTo-Json

try {
  Invoke-RestMethod -Method Post -Uri $HeartbeatUrl -Headers @{
    "Content-Type"       = "application/json"
    "x-heartbeat-secret" = $HeartbeatSecret
  } -Body $body | Out-Null
} catch {
  # Silent fail so the scheduled task does not spam; check MIT Asset "Last seen".
  exit 1
}
