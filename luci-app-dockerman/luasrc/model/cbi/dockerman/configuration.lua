--[[
LuCI - Lua Configuration Interface
Copyright 2021 Florian Eckert <fe@dev.tdt.de>
Copyright 2021 lisaac <lisaac.cn@gmail.com>
]]--

local uci = (require "luci.model.uci").cursor()

local m, s, o

m = Map("dockerd",
	translate("Docker - Configuration"),
	translate("DockerMan is a simple docker manager client for LuCI"))

if nixio.fs.access("/usr/bin/dockerd") and not m.uci:get_bool("dockerd", "dockerman", "remote_endpoint")  then
	s = m:section(NamedSection, "globals", "section", translate("Docker Daemon settings"))

	o = s:option(Flag, "auto_start", translate("Auto start"))
	o.rmempty = false
	o.write = function(self, section, value)
		if value == "1" then
			luci.util.exec("/etc/init.d/dockerd enable")
		else
			luci.util.exec("/etc/init.d/dockerd disable")
		end
		m.uci:set("dockerd", "globals", "auto_start", value)
	end

	o = s:option(Value, "data_root",
		translate("Docker Root Dir"))
	o.placeholder = "/opt/docker/"
	o:depends("remote_endpoint", 0)

	o = s:option(Value, "bip",
		translate("Default bridge"),
		translate("Configure the default bridge network"))
	o.placeholder = "172.17.0.1/16"
	o.datatype = "ipaddr"
	o:depends("remote_endpoint", 0)

	o = s:option(DynamicList, "registry_mirrors",
		translate("Registry Mirrors"),
		translate("It replaces the daemon registry mirrors with a new set of registry mirrors"))
	o:value("https://hub-mirror.c.163.com", "https://hub-mirror.c.163.com")
	o:depends("remote_endpoint", 0)
	o.forcewrite = true

	o = s:option(ListValue, "log_level",
		translate("Log Level"),
		translate('Set the logging level'))
	o:value("debug", translate("Debug"))
	o:value("", translate("Info")) -- This is the default debug level from the deamon is optin is not set
	o:value("warn", translate("Warning"))
	o:value("error", translate("Error"))
	o:value("fatal", translate("Fatal"))
	o.rmempty = true
	o:depends("remote_endpoint", 0)

end

return m
