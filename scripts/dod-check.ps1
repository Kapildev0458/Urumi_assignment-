$ErrorActionPreference = 'Stop'
$App = 'http://app.127.0.0.1.nip.io'
$Store = 'http://store.127.0.0.1.nip.io'
$stamp = Get-Date -Format 'HHmmss'

function Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  PASS $t" -ForegroundColor Green }
function Bad($t) { Write-Host "  FAIL $t" -ForegroundColor Red; $script:fails++ }
$script:fails = 0

function Api($session, $method, $path, $body) {
  $p = @{ Uri = "$App/api$path"; Method = $method; WebSession = $session; ContentType = 'application/json'; UseBasicParsing = $true; Headers = @{ 'X-Requested-With' = 'urumi' } }
  if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json -Depth 10 -Compress) }
  Invoke-RestMethod @p
}

function Mcp($key, $method, $params) {
  $body = @{ jsonrpc = '2.0'; id = 1; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
  try {
    $r = Invoke-WebRequest -Uri "$App/mcp" -Method Post -Body $body -UseBasicParsing -ContentType 'application/json' `
      -Headers @{ Authorization = "Bearer $key"; Accept = 'application/json, text/event-stream' }
  } catch {
    $code = [int]$_.Exception.Response.StatusCode
    return @{ httpStatus = $code }
  }
  $text = $r.Content
  if ($text -match '(?m)^data: (.+)$') { $text = $Matches[1] }
  ($text | ConvertFrom-Json)
}

function ToolNames($key) { (Mcp $key 'tools/list' @{}).result.tools | ForEach-Object { $_.name } }

# ---------- Admin (user A) ----------
Step 'Admin login'
$pw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((kubectl -n urumi get secret urumi-gateway-secrets -o jsonpath='{.data.admin-password}')))
$A = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$me = Api $A Post '/auth/login' @{ email = 'admin@urumi.local'; password = $pw }
if ($me.role -eq 'admin') { Ok "logged in as $($me.email)" } else { Bad 'admin login' }

Step 'Servers page: status + tools'
$servers = Api $A Get '/servers'
$servers | ForEach-Object { Write-Host ("  {0,-8} {1,-12} tools={2}" -f $_.name, $_.status, @($_.tools).Count) }
if (($servers | Where-Object { $_.name -eq 'woo' }).status -eq 'connected' -or ($servers | Where-Object { $_.name -eq 'woo' }).status -eq 'Connected') { Ok 'woo registered and connected' } else { Bad 'woo status' }
if (($servers | ForEach-Object { $_ | ConvertTo-Json -Depth 5 }) -match 'credential"\s*:\s*"') { Bad 'a credential is exposed to the browser' } else { Ok 'no upstream credential in API response' }

Step 'Servers page: add / edit / disable / remove'
$timeToken = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((kubectl -n urumi get secret urumi-time-mcp-auth -o jsonpath='{.data.token}')))
$new = Api $A Post '/servers' @{ name = "extra-$stamp"; url = 'http://urumi-time-mcp/mcp'; authType = 'bearer'; credential = $timeToken }
Write-Host "  added $($new.name): $($new.status)"
$ed = Api $A Patch "/servers/$($new.id)" @{ name = "extra2-$stamp" }
if ($ed.name -eq "extra2-$stamp") { Ok 'edit (rename)' } else { Bad 'edit' }
$dis = Api $A Patch "/servers/$($new.id)" @{ enabled = $false }
Write-Host "  after disable: $($dis.status)"
Api $A Delete "/servers/$($new.id)" $null | Out-Null
if (-not ((Api $A Get '/servers') | Where-Object { $_.id -eq $new.id })) { Ok 'remove' } else { Bad 'remove' }

Step 'Members page: invite user B, B accepts and generates own key'
$inv = Api $A Post '/invites' @{ email = "rehearsal-b-$stamp@urumi.local"; role = 'member' }
$token = $inv.link -replace '.*/invite/', ''
$B = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$bUser = Api $B Post "/invites/$token/accept" @{ name = 'Rehearsal B'; password = 'rehearsal-pass-123' }
$bKey = Api $B Post '/keys' @{ name = 'claude-code' }
if ($bKey.key) { Ok "B ($($bUser.email)) has key $($bKey.prefix)..." } else { Bad 'B key' }

# ---------- Chat as A ----------
Step 'Chat (A): create a product'
$prod = "Rehearsal Mug $stamp"
$c1 = Api $A Post '/chat' @{ messages = @(@{ role = 'user'; content = "Create a product called '$prod' with price 12.50" }) }
Write-Host "  reply: $(($c1 | ConvertTo-Json -Depth 8 -Compress).Substring(0, [Math]::Min(400, ($c1 | ConvertTo-Json -Depth 8 -Compress).Length)))"

Step 'Storefront: product visible + COD checkout'
$found = Mcp $bKey.key 'tools/call' @{ name = 'woo__list_products'; arguments = @{ search = $prod } }
$pj = $found.result.content[0].text | ConvertFrom-Json
$prodId = @($pj.products)[0].id
if ($prodId) { Ok "product #$prodId exists" } else { Bad 'product not found'; $pj | ConvertTo-Json -Depth 5 }
$shop = Invoke-WebRequest "$Store/?post_type=product&s=$([uri]::EscapeDataString($prod))" -UseBasicParsing
if ($shop.Content -match [regex]::Escape($prod)) { Ok 'product shows on storefront' } else { Bad 'not on storefront' }
$cart = Invoke-WebRequest "$Store/wp-json/wc/store/v1/cart" -UseBasicParsing
$h = @{ 'Cart-Token' = $cart.Headers['Cart-Token']; Nonce = $cart.Headers['Nonce'] }
Invoke-RestMethod "$Store/wp-json/wc/store/v1/cart/add-item" -Method Post -Headers $h -ContentType 'application/json' -Body (@{ id = $prodId; quantity = 1 } | ConvertTo-Json) | Out-Null
$addr = @{ first_name = 'Rehearsal'; last_name = 'Buyer'; address_1 = '1 Test St'; city = 'Pune'; postcode = '411001'; country = 'IN'; state = 'MH'; email = 'buyer@example.com'; phone = '9999999999' }
$order = Invoke-RestMethod "$Store/wp-json/wc/store/v1/checkout" -Method Post -Headers $h -ContentType 'application/json' -Body (@{ billing_address = $addr; shipping_address = $addr; payment_method = 'cod' } | ConvertTo-Json -Depth 5)
Ok "order #$($order.order_id) placed with COD (status $($order.status))"

Step 'Chat (A): what orders came in today?'
$c2 = Api $A Post '/chat' @{ messages = @(@{ role = 'user'; content = 'What orders came in today?' }) }
$c2s = $c2 | ConvertTo-Json -Depth 8 -Compress
if ($c2s -match "$($order.order_id)") { Ok "chat answer mentions order #$($order.order_id)" } else { Bad 'chat did not return the order'; Write-Host $c2s }

# ---------- External client as B ----------
Step 'External client (B): tools from every server'
$tools = ToolNames $bKey.key
Write-Host "  $(@($tools).Count) tools: $($tools -join ', ')"
foreach ($s in 'woo__', 'notes__', 'time__') { if ($tools -match "^$s") { Ok "has $s tools" } else { Bad "missing $s tools" } }

Step 'External client (B): orders today'
$o = Mcp $bKey.key 'tools/call' @{ name = 'woo__list_orders'; arguments = @{ date = 'today' } }
if ($o.result.content[0].text -match "$($order.order_id)") { Ok 'B sees today''s order' } else { Bad 'B orders today' }

Step 'External client (B): cross-server (time + notes)'
$t = Mcp $bKey.key 'tools/call' @{ name = 'time__current_time'; arguments = @{} }
$n = Mcp $bKey.key 'tools/call' @{ name = 'notes__add_note'; arguments = @{ title = "Rehearsal $stamp"; text = "Time: $($t.result.content[0].text)" } }
if (-not $t.result.isError -and -not $n.result.isError) { Ok 'time + notes calls work' } else { Bad 'cross-server' }

# ---------- Team and control ----------
Step 'Disable notes server -> tools gone for B and for chat'
$notes = (Api $A Get '/servers') | Where-Object { $_.name -eq 'notes' }
Api $A Patch "/servers/$($notes.id)" @{ enabled = $false } | Out-Null
if (-not ((ToolNames $bKey.key) -match '^notes__')) { Ok 'notes tools hidden from B' } else { Bad 'notes still listed' }
if (-not ((Api $A Get '/tools').name -match '^notes__')) { Ok 'notes tools hidden from chat (/api/tools)' } else { Bad 'chat still lists notes' }
Api $A Patch "/servers/$($notes.id)" @{ enabled = $true } | Out-Null
Ok 're-enabled notes'

Step 'Kill time-mcp pod -> Unreachable, woo still works'
kubectl -n urumi scale deploy urumi-time-mcp --replicas=0 | Out-Null
kubectl -n urumi wait --for=delete pod -l app.kubernetes.io/name=time-mcp --timeout=60s 2>$null | Out-Null
$timeSrv = (Api $A Get '/servers') | Where-Object { $_.name -eq 'time' }
Api $A Post "/servers/$($timeSrv.id)/refresh" $null | Out-Null
$timeSrv = (Api $A Get '/servers') | Where-Object { $_.name -eq 'time' }
Write-Host "  time status: $($timeSrv.status)  $($timeSrv.error)"
if ($timeSrv.status -match 'unreachable') { Ok 'time shows Unreachable' } else { Bad 'time not unreachable' }
$w = Mcp $bKey.key 'tools/call' @{ name = 'woo__list_orders'; arguments = @{ date = 'today' } }
if (-not $w.result.isError) { Ok 'woo still works' } else { Bad 'woo broken while time is down' }
$tc = Mcp $bKey.key 'tools/call' @{ name = 'time__current_time'; arguments = @{} }
Write-Host "  calling dead time tool -> $(($tc | ConvertTo-Json -Depth 6 -Compress))"
kubectl -n urumi scale deploy urumi-time-mcp --replicas=1 | Out-Null
kubectl -n urumi rollout status deploy urumi-time-mcp --timeout=120s | Out-Null
Ok 'time-mcp scaled back to 1'

Step 'Revoke B key -> next call rejected'
Api $A Delete "/keys/$($bKey.id)" $null | Out-Null
$r = Mcp $bKey.key 'tools/list' @{}
if ($r.httpStatus -eq 401) { Ok 'revoked key -> 401' } else { Bad "revoked key got: $($r | ConvertTo-Json -Compress)" }

Step 'Audit log'
$audit = Api $A Get '/audit?limit=40'
$audit | Select-Object -First 20 | ForEach-Object { Write-Host ("  {0,-34} {1,-5} {2,-7} {3,-20} {4,-8} {5}ms" -f $_.userEmail, $_.via, $_.server, $_.tool, $_.outcome, $_.durationMs) }
if ($audit | Where-Object { $_.userEmail -eq 'admin@urumi.local' -and $_.via -eq 'chat' }) { Ok 'chat calls audited under admin' } else { Bad 'no admin chat audit' }
if ($audit | Where-Object { $_.userEmail -eq $bUser.email -and $_.outcome -eq 'denied' }) { Ok 'B revoked call audited as denied' } else { Bad 'no denied entry for B' }

Write-Host "`nFailures: $script:fails" -ForegroundColor ($(if ($script:fails) { 'Red' } else { 'Green' }))



