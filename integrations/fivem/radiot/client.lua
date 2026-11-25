local station = nil
local enabled = GetResourceKvpInt('radiot_off') ~= 1
local volume = GetResourceKvpFloat('radiot_volume')
if volume <= 0.0 then volume = Config.DefaultVolume end
local playing = false
local radioLocked = false
local lastVeh = 0

local function notify(msg)
  BeginTextCommandThefeedPost('STRING')
  AddTextComponentSubstringPlayerName(msg)
  EndTextCommandThefeedPostTicker(false, false)
end

local function inVehicle()
  return IsPedInAnyVehicle(PlayerPedId(), false)
end

local function shouldPlay()
  if not enabled or not station then return false end
  if Config.VehicleOnly and not inVehicle() then return false end
  return true
end

local function showNow()
  if Config.ShowNowPlaying and station then
    SendNUIMessage({ type = 'now', station = station, seconds = Config.NowPlayingSeconds })
  end
end

local function setGameRadio(locked)
  if not Config.MuteGameRadio or locked == radioLocked then return end
  radioLocked = locked
  SetUserRadioControlEnabled(not locked)
  if locked then
    local veh = GetVehiclePedIsIn(PlayerPedId(), false)
    if veh ~= 0 then SetVehRadioStation(veh, 'OFF') end
  end
end

local function start()
  playing = true
  SendNUIMessage({ type = 'play', station = station, volume = volume })
  showNow()
end

local function stop()
  playing = false
  SendNUIMessage({ type = 'stop' })
end

CreateThread(function()
  TriggerServerEvent('radiot:hello')
  while true do
    local want = shouldPlay()
    if want and not playing then start() elseif not want and playing then stop() end
    setGameRadio(playing and inVehicle())
    -- GTA turns the radio back on in every car you enter; switch it off once per vehicle.
    local veh = GetVehiclePedIsIn(PlayerPedId(), false)
    if radioLocked and veh ~= 0 and veh ~= lastVeh then SetVehRadioStation(veh, 'OFF') end
    lastVeh = veh
    Wait(400)
  end
end)

RegisterNetEvent('radiot:station', function(data, changed)
  station = data
  if playing then
    SendNUIMessage({ type = 'meta', station = station })
    if changed then showNow() end
  end
end)

local function setEnabled(on)
  enabled = on
  SetResourceKvpInt('radiot_off', on and 0 or 1)
  notify(on and '~y~RadioT~s~ on' or '~y~RadioT~s~ off')
  if on and not shouldPlay() and Config.VehicleOnly then notify('Get in a vehicle to listen.') end
end

local function setVolume(v)
  volume = math.max(0.0, math.min(1.0, v))
  SetResourceKvpFloat('radiot_volume', volume)
  SendNUIMessage({ type = 'volume', volume = volume })
  notify(('~y~RadioT~s~ volume %d%%'):format(math.floor(volume * 100 + 0.5)))
end

RegisterCommand(Config.Command, function(_, args)
  local sub = args[1] and args[1]:lower()
  if sub == 'on' then setEnabled(true)
  elseif sub == 'off' then setEnabled(false)
  elseif sub == 'vol' and tonumber(args[2]) then setVolume(tonumber(args[2]) / 100)
  elseif sub == nil then setEnabled(not enabled)
  else notify('Usage: /' .. Config.Command .. ' [on|off|vol 0-100]') end
end, false)

RegisterCommand('radiot_toggle', function() setEnabled(not enabled) end, false)
RegisterCommand('radiot_volup', function() setVolume(volume + 0.1) end, false)
RegisterCommand('radiot_voldown', function() setVolume(volume - 0.1) end, false)
RegisterKeyMapping('radiot_toggle', 'RadioT: radio on/off', 'keyboard', Config.ToggleKey)
RegisterKeyMapping('radiot_volup', 'RadioT: volume up', 'keyboard', Config.VolumeUpKey)
RegisterKeyMapping('radiot_voldown', 'RadioT: volume down', 'keyboard', Config.VolumeDownKey)

AddEventHandler('onResourceStop', function(res)
  if res == GetCurrentResourceName() and radioLocked then SetUserRadioControlEnabled(true) end
end)
