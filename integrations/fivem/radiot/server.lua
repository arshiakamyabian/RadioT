-- Polls the station once for the whole server and fans changes out to players,
-- so the RadioT API sees one request per server instead of one per player.

local station = nil
local lastKey = nil

local receivedAt = 0
local ageMs = 0

local function trackKey(s)
  if not s or not s.now then return 'off' end
  local nextKey = s.next and ((s.next.trackId or '') .. '@' .. (s.next.startsAt or '')) or ''
  return (s.now.trackId or '') .. '|' .. (s.now.startedAt or '') .. '|' .. nextKey
end

-- Players line up with the station clock from `serverTime`, so tell them how old it is by the
-- time they get it (CDN cache age + time this server has held it).
local function withDelay(s)
  s.relayDelayMs = ageMs + (GetGameTimer() - receivedAt)
  return s
end

local function poll()
  PerformHttpRequest(Config.ApiUrl .. '/api/public/station', function(status, body, headers)
    if status ~= 200 or not body then return end
    local ok, data = pcall(json.decode, body)
    if not ok or type(data) ~= 'table' or type(data.serverTime) ~= 'string' then return end
    local age = headers and (headers['Age'] or headers['age'])
    ageMs = (tonumber(age) or 0) * 1000
    receivedAt = GetGameTimer()
    station = data
    local key = trackKey(data)
    if key ~= lastKey then
      lastKey = key
      TriggerClientEvent('radiot:station', -1, withDelay(station), true)
    end
  end, 'GET', '', { ['Accept'] = 'application/json' })
end

CreateThread(function()
  while true do
    poll()
    Wait(math.max(2, Config.PollSeconds) * 1000)
  end
end)

RegisterNetEvent('radiot:hello', function()
  local src = source
  if station then TriggerClientEvent('radiot:station', src, withDelay(station), false) end
end)
