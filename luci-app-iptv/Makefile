include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-iptv
PKG_VERSION:=2.0.0
PKG_RELEASE:=1

LUCI_TITLE:=LuCI IPTV playlist editor
LUCI_DESCRIPTION:=Edit the /www/iptv playlist file from LuCI (Services -> IPTV)
LUCI_DEPENDS:=+rpcd
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

$(eval $(call BuildPackage,$(PKG_NAME)))
