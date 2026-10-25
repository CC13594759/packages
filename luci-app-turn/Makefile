include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-turn
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-turn
  SECTION:=net
  CATEGORY:=Network
  TITLE:=LuCI support for turn
  URL:=https://github.com/CC13594759/OpenWrt-Actions
  DEPENDS:=+node +luci-base
  CONFLICTS:=turn
endef

define Package/luci-app-turn/description
 Configure the turn TURN relay (Services -> TURN), with the turn
 TURN-over-TCP client (HTTP CONNECT + SOCKS5 proxy) included.
endef

# Pure file package: no compilation, override default Build/Compile
define Build/Compile
endef

define Package/luci-app-turn/install
	$(INSTALL_DIR) $(1)/usr/share/turn
	$(INSTALL_DATA) ./usr/share/turn/turn.mjs $(1)/usr/share/turn/
	$(INSTALL_DATA) ./usr/share/turn/turn-protocol.mjs $(1)/usr/share/turn/
	$(INSTALL_DATA) ./usr/share/turn/turn-udp.mjs $(1)/usr/share/turn/
	$(INSTALL_DATA) ./usr/share/turn/turn-socks5.mjs $(1)/usr/share/turn/
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./etc/init.d/turn $(1)/etc/init.d/turn
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./usr/share/luci/menu.d/luci-app-turn.json $(1)/usr/share/luci/menu.d/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./usr/share/rpcd/acl.d/luci-app-turn.json $(1)/usr/share/rpcd/acl.d/
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view
	$(INSTALL_DATA) ./www/luci-static/resources/view/turn.js $(1)/www/luci-static/resources/view/
endef

$(eval $(call BuildPackage,luci-app-turn))
