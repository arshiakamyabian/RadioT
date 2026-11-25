Config = {}

-- Base URL of the RadioT API (no trailing slash). Local dev: 'http://localhost:4000'
Config.ApiUrl = 'https://api.radiot.app'

-- How often the game server refreshes now-playing (seconds). One request per server, not per player.
Config.PollSeconds = 5

-- true = plays only inside vehicles, like a car radio. false = plays everywhere.
Config.VehicleOnly = true

-- Turn GTA's own radio off while RadioT is playing in a vehicle.
Config.MuteGameRadio = true

-- 0.0 - 1.0, used until the player changes it (saved per player).
Config.DefaultVolume = 0.5

-- Show the now-playing card on track changes and when the radio turns on.
Config.ShowNowPlaying = true
Config.NowPlayingSeconds = 8

-- Chat command: /radiot, /radiot on, /radiot off, /radiot vol 60
Config.Command = 'radiot'

-- Default key bindings (players can rebind in Settings > Key Bindings > FiveM).
Config.ToggleKey = 'F9'
Config.VolumeUpKey = 'PAGEUP'
Config.VolumeDownKey = 'PAGEDOWN'
