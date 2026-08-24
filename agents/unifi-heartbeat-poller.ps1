# UniFi → MIT Asset heartbeat poller (PowerShell)
#
# Run on a PC/NAS that can reach the UDM (same LAN). Do NOT put UniFi keys in the PWA.
# Schedule every 5 minutes. Requires the heartbeat Edge Function.
#
# Assets match by MAC — fill MAC on each asset (Edit Asset), or set agentId = asset tag
# and keep optional Supabase lookup below so only known inventory is posted.

$UnifiBaseUrl = "https://192.168.1.1"          # UDM / UniFi OS IP or hostname
$UnifiApiKey = "YOUR_UNIFI_API_KEY"            # Network → Control Plane → Integrations
$UnifiSiteId = ""                              # Leave blank to use the first site

$HeartbeatUrl = "https://YOUR_PROJECT.supabase.co/functions/v1/heartbeat"
$HeartbeatSecret = "YOUR_SHARED_SECRET"
$WorkspaceId = "main"

# Optional: only heartbeat MACs that exist in MIT Asset (recommended — skips phones/IoT).
$SupabaseUrl = "https://YOUR_PROJECT.supabase.co"
$SupabaseAnonKey = ""                          # Same anon key as Cloud Settings; leave blank to POST all clients

function Normalize-Mac([string]$mac) {
  if (-not $mac) { return "" }
  return (($mac.ToLower() -replace "[^a-f0-9]", ""))
}

function Trust-UnifiCert {
  if ($PSVersionTable.PSVersion.Major -ge 6) { return }
  if ("TrustAllCertsPolicy" -as [type]) { return }
  Add-Type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class TrustAllCertsPolicy : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; }
}
"@
  [System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Invoke-Unifi($path) {
  $uri = ($UnifiBaseUrl.TrimEnd("/")) + $path
  $headers = @{ "X-API-Key" = $UnifiApiKey; "Accept" = "application/json" }
  if ($PSVersionTable.PSVersion.Major -ge 6) {
    return Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -SkipCertificateCheck
  }
  Trust-UnifiCert
  return Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
}

function Get-ClientList($obj) {
  if ($null -eq $obj) { return @() }
  if ($obj -is [System.Array]) { return @($obj) }
  if ($obj.data) { return @($obj.data) }
  if ($obj.clients) { return @($obj.clients) }
  return @($obj)
}

function Get-ClientMac($c) {
  foreach ($k in @("macAddress", "mac", "user_mac", "ap_mac")) {
    if ($c.$k) { return [string]$c.$k }
  }
  return ""
}

function Get-ClientName($c) {
  foreach ($k in @("name", "hostname", "display_name", "oui", "ipAddress", "ip")) {
    if ($c.$k) { return [string]$c.$k }
  }
  return "unifi-client"
}

# Optional inventory: MAC → asset tag
$macToTag = @{}
if ($SupabaseUrl -and $SupabaseAnonKey) {
  $wsUrl = ($SupabaseUrl.TrimEnd("/")) + "/rest/v1/mit_workspace?workspace_id=eq.$WorkspaceId&select=payload"
  $wsHeaders = @{
    apikey          = $SupabaseAnonKey
    Authorization   = "Bearer $SupabaseAnonKey"
    Accept          = "application/json"
  }
  $rows = Invoke-RestMethod -Method Get -Uri $wsUrl -Headers $wsHeaders
  $assets = @()
  if ($rows -is [System.Array] -and $rows.Count -gt 0) { $assets = @($rows[0].payload.assets) }
  elseif ($rows.payload.assets) { $assets = @($rows.payload.assets) }
  foreach ($a in $assets) {
    $m = Normalize-Mac $a.macAddress
    if ($m.Length -eq 12) { $macToTag[$m] = $a.tag }
  }
}

$siteId = $UnifiSiteId.Trim()
if (-not $siteId) {
  $sites = Invoke-Unifi "/proxy/network/integration/v1/sites"
  $siteList = Get-ClientList $sites
  if (-not $siteList.Count) { throw "No UniFi sites returned — check URL and API key" }
  $siteId = $siteList[0].id
  if (-not $siteId) { $siteId = $siteList[0].siteId }
}

$clients = Get-ClientList (Invoke-Unifi "/proxy/network/integration/v1/sites/$siteId/clients")
$sent = 0
$skipped = 0

foreach ($c in $clients) {
  $mac = Get-ClientMac $c
  $norm = Normalize-Mac $mac
  if ($norm.Length -ne 12) { $skipped++; continue }

  $tag = $null
  if ($macToTag.Count -gt 0) {
    if (-not $macToTag.ContainsKey($norm)) { $skipped++; continue }
    $tag = $macToTag[$norm]
  }

  $agentId = if ($tag) { $tag } else { $norm }
  $bodyObj = @{
    agentId     = $agentId
    assetTag    = $(if ($tag) { $tag } else { $agentId })
    hostname    = Get-ClientName $c
    mac         = $mac
    workspaceId = $WorkspaceId
    meta        = @{ source = "unifi" }
  }
  $json = $bodyObj | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Method Post -Uri $HeartbeatUrl -Headers @{
      "Content-Type"       = "application/json"
      "x-heartbeat-secret" = $HeartbeatSecret
    } -Body $json | Out-Null
    $sent++
  } catch {
    Write-Error $_
    exit 1
  }
}

Write-Output "UniFi poller: $sent heartbeat(s), $skipped skipped"
