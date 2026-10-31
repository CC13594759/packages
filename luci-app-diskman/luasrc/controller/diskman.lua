--[[
LuCI - Lua Configuration Interface
Copyright 2019 lisaac <https://github.com/lisaac/luci-app-diskman>
]]--

require "luci.util"
module("luci.controller.diskman",package.seeall)

function index()
  -- check all used executables in disk management are existed
  local CMD = {"parted", "blkid", "smartctl"}
  local executables_all_existed = true
  for _, cmd in ipairs(CMD) do
    local command = luci.sys.exec("/usr/bin/which " .. cmd)
    if not command:match(cmd) then
      executables_all_existed = false
      break
    end
  end

  if not executables_all_existed then return end
  -- entry(path, target, title, order)
  -- set leaf attr to true to pass argument throughe url (e.g. admin/system/disk/partition/sda)
  entry({"admin", "system", "diskman"}, alias("admin", "system", "diskman", "disks"), _("Disk Man"), 55)
  entry({"admin", "system", "diskman", "disks"}, form("diskman/disks"), nil).leaf = true
  entry({"admin", "system", "diskman", "partition"}, form("diskman/partition"), nil).leaf = true
  entry({"admin", "system", "diskman", "btrfs"}, form("diskman/btrfs"), nil).leaf = true
  entry({"admin", "system", "diskman", "format_partition"}, call("format_partition"), nil).leaf = true
  entry({"admin", "system", "diskman", "get_disk_info"}, call("get_disk_info"), nil).leaf = true
  entry({"admin", "system", "diskman", "mk_p_table"}, call("mk_p_table"), nil).leaf = true
  entry({"admin", "system", "diskman", "smartdetail"}, call("smart_detail"), nil).leaf = true
  entry({"admin", "system", "diskman", "smartattr"}, call("smart_attr"), nil).leaf = true
end

function format_partition()
  local partation_name = luci.http.formvalue("partation_name")
  local fs = luci.http.formvalue("file_system")
  if not partation_name then
    luci.http.status(500, "Partition NOT found!")
    luci.http.write_json("Partition NOT found!")
    return
  elseif not nixio.fs.access("/dev/"..partation_name) then
    luci.http.status(500, "Partition NOT found!")
    luci.http.write_json("Partition NOT found!")
    return
  elseif not fs then
    luci.http.status(500, "no file system")
    luci.http.write_json("no file system")
    return
  end
  local dm = require "luci.model.diskman"
  code, msg = dm.format_partition(partation_name, fs)
  luci.http.status(code, msg)
  luci.http.write_json(msg)
end

function get_disk_info(dev)
  if not dev then
    luci.http.status(500, "no device")
    luci.http.write_json("no device")
    return
  elseif not nixio.fs.access("/dev/"..dev) then
    luci.http.status(500, "no device")
    luci.http.write_json("no device")
    return
  end
  local dm = require "luci.model.diskman"
  local device_info = dm.get_disk_info(dev)
  luci.http.status(200, "ok")
  luci.http.prepare_content("application/json")
  luci.http.write_json(device_info)
end

function mk_p_table()
  local p_table = luci.http.formvalue("p_table")
  local dev = luci.http.formvalue("dev")
  if not dev then
    luci.http.status(500, "no device")
    luci.http.write_json("no device")
    return
  elseif not nixio.fs.access("/dev/"..dev) then
    luci.http.status(500, "no device")
    luci.http.write_json("no device")
    return
  end
  local dm = require "luci.model.diskman"
  if p_table == "GPT" or p_table == "MBR" then
    p_table = p_table == "MBR" and "msdos" or "gpt"
    local res = luci.sys.call(dm.command.parted .. " -s /dev/" .. dev .. " mktable ".. p_table)
    if res == 0 then
      luci.http.status(200, "ok")
    else
      luci.http.status(500, "command exec error")
    end
    luci.http.prepare_content("application/json")
    luci.http.write_json({code=res})
  else
    luci.http.status(404, "not support")
    luci.http.prepare_content("application/json")
    luci.http.write_json({code="1"})
  end
end

function smart_detail(dev)
  luci.template.render("diskman/smart_detail", {dev=dev})
end

-- S.M.A.R.T attribute name -> Chinese. Unknown names fall back to the
-- original English name, so no attribute is ever dropped by this table.
local SMART_ATTR_ZH = {
  Raw_Read_Error_Rate = "原始读取错误率",
  Spin_Up_Time = "主轴启动时间",
  Start_Stop_Count = "启停次数",
  Reallocated_Sector_Ct = "重分配扇区数",
  Seek_Error_Rate = "寻道错误率",
  Power_On_Hours = "通电时间",
  Spin_Retry_Count = "主轴启动重试次数",
  Calibration_Retry_Count = "校准重试次数",
  Power_Cycle_Count = "通电次数",
  Power_Off_Retract_Count = "断电磁头收回次数",
  ["Power-Off_Retract_Count"] = "断电磁头收回次数",
  Load_Cycle_Count = "磁头加载/卸载次数",
  Temperature_Celsius = "温度",
  Reallocated_Event_Count = "重分配事件次数",
  Reallocation_Event_Count = "重分配事件次数",
  Current_Pending_Sector = "当前待映射扇区数",
  Offline_Uncorrectable = "脱机无法纠正扇区数",
  UDMA_CRC_Error_Count = "UDMA CRC 错误次数",
  Multi_Zone_Error_Rate = "多区域错误率",
  Read_Error_Rate = "读取错误率",
  Throughput_Performance = "吞吐性能",
  Seek_Time_Performance = "寻道时间性能",
  Hardware_ECC_Recovered = "硬件 ECC 恢复次数",
  Reported_Uncorrectable_Errors = "报告的无法纠正错误数",
  Command_Timeout = "命令超时次数",
  High_Fly_Writes = "高飞写入次数",
  Airflow_Temperature_Cel = "气流温度",
  G_Sense_Error_Rate = "G-Sense 错误率",
  Wear_Leveling_Count = "磨损均衡次数",
  Total_LBAs_Written = "总写入扇区数",
  Total_LBAs_Read = "总读取扇区数",
  Program_Fail_Count = "编程失败次数",
  Erase_Fail_Count = "擦除失败次数",
  Unexpected_Power_Loss_Ct = "意外断电次数",
}

function smart_attr(dev)
  local attr = { }
  local dm = require "luci.model.diskman"
  local cmd = io.popen(dm.command.smartctl ..  " -H -A -i /dev/%s" % dev)
  if cmd then
    local content = cmd:read("*all")
    local ln
    cmd:close()
    if content:match("NVMe Version:")then
      for ln in string.gmatch(content,'[^\r\n]+') do
        if ln:match("^(.-):%s+(.+)") then
          local key, value = ln:match("^(.-):%s+(.+)")
          attr[#attr+1]= {
              key = key,
              value = value
            }
        end
      end
    else
      for ln in string.gmatch(content,'[^\r\n]+') do
        if ln:match("^.*%d+%s+.+%s+.+%s+.+%s+.+%s+.+%s+.+%s+.+%s+.+%s+.+") then
          local id,attrbute,flag,value,worst,thresh,type,updated,raw = ln:match("^%s*(%d+)%s+([%a%p]+)%s+(%w+)%s+(%d+)%s+(%d+)%s+(%d+)%s+([%a%p]+)%s+(%a+)%s+[%w%p]+%s+(.+)")
          id= "%x" % id
          if not id:match("^%w%w") then
            id = "0%s" % id
          end
          attr[#attr+1]= {
              id = id:upper(),
              attrbute = SMART_ATTR_ZH[attrbute] or attrbute,
              flag  = flag,
              value = value,
              worst = worst,
              thresh  = thresh,
              type = (type == "Pre-fail" and "预失败") or (type == "Old_age" and "老化") or type,
              updated = (updated == "Always" and "始终") or (updated == "Offline" and "脱机") or updated,
              raw  = raw
            }
        end
      end
    end
  end
  luci.http.prepare_content("application/json")
  luci.http.write_json(attr)
end