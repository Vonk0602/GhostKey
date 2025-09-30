local observing = false
local prev_inputs = {}
local key_queue = {}

local KEY_FIRST = 1
local KEY_LAST = 106
local MOUSE_FIRST = 107
local MOUSE_LAST = 114

net.Receive("start_observe", function()
    observing = true
end)

net.Receive("stop_observe", function()
    observing = false
    prev_inputs = {}
    key_queue = {}
end)

hook.Add("Think", "HotkeyInputLogger", function()
    if not observing then return end

    local new_presses = {}

    for i = KEY_FIRST, MOUSE_LAST do
        local down
        if i <= KEY_LAST then
            down = input.IsKeyDown(i)
        else
            down = input.IsMouseDown(i)
        end

        if down and not prev_inputs[i] then
            local key_name = input.GetKeyName(i) or "Неизвестно"
            if i == 42 then key_name = "LSHIFT" end
            if i == 54 then key_name = "RSHIFT" end
            if i == 29 then key_name = "LCTRL" end
            if i == 157 then key_name = "RCTRL" end
            if i == 56 then key_name = "LALT" end
            if i == 184 then key_name = "RALT" end
            if i == 113 then key_name = "MWHEELUP" end
            if i == 114 then key_name = "MWHEELDOWN" end
            table.insert(new_presses, key_name)
        end

        prev_inputs[i] = down
    end

    for _, key_name in ipairs(new_presses) do
        net.Start("key_press")
        net.WriteString(key_name)
        net.SendToServer()
    end
end)

hook.Add("GUIMousePressed", "LogGuiClick", function(mc, vc)
    if not observing then return end
    local x, y = gui.MousePos()
    local w, h = ScrW(), ScrH()
    if w == 0 or h == 0 then return end
    local x_norm = x / w
    local y_norm = y / h
    net.Start("click_press")
    net.WriteFloat(x_norm)
    net.WriteFloat(y_norm)
    net.WriteUInt(w, 16)
    net.WriteUInt(h, 16)
    net.SendToServer()
end)

local admin_clicks = {}

hook.Add("OnPlayerChat", "HandleClickCommand", function(ply, text)
    if ply ~= LocalPlayer() then return end
    if text:lower() == "!click" then
        local frame = vgui.Create("DFrame")
        frame:SetSize(400, 300)
        frame:Center()
        frame:SetTitle("Ввод координат кликов")
        frame:MakePopup()

        local textEntry = vgui.Create("DTextEntry", frame)
        textEntry:SetMultiline(true)
        textEntry:SetPos(10, 30)
        textEntry:SetSize(380, 200)
        textEntry:SetPlaceholderText("Введите координаты, каждая на новой строке: x y\nПример:\n0.5 0.5\n0.3 0.7")

        local displayBtn = vgui.Create("DButton", frame)
        displayBtn:SetPos(10, 240)
        displayBtn:SetSize(180, 30)
        displayBtn:SetText("Отобразить")
        displayBtn.DoClick = function()
            local input = textEntry:GetValue()
            admin_clicks = {}
            local lines = string.Split(input, "\n")
            for i, line in ipairs(lines) do
                if #admin_clicks >= 25 then break end
                local parts = string.Split(line, " ")
                if #parts >= 2 then
                    local x_norm = tonumber(parts[1])
                    local y_norm = tonumber(parts[2])
                    if x_norm and y_norm then
                        table.insert(admin_clicks, {x = x_norm, y = y_norm, num = i})
                    end
                end
            end
            frame:Close()
        end

        local clearBtn = vgui.Create("DButton", frame)
        clearBtn:SetPos(200, 240)
        clearBtn:SetSize(180, 30)
        clearBtn:SetText("Очистить")
        clearBtn.DoClick = function()
            admin_clicks = {}
            frame:Close()
        end
    end
end)

hook.Add("HUDPaint", "DrawAdminClicks", function()
    if #admin_clicks == 0 then return end
    local w, h = ScrW(), ScrH()
    for _, click in ipairs(admin_clicks) do
        local x = click.x * w
        local y = click.y * h
        surface.SetDrawColor(255, 0, 0, 255)
        surface.DrawCircle(x, y, 10, 255, 0, 0, 255)
        draw.SimpleText(tostring(click.num), "DermaDefaultBold", x + 15, y, Color(255, 0, 0, 255), TEXT_ALIGN_LEFT, TEXT_ALIGN_CENTER)
    end
end)