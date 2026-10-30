include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Support for docker
LUCI_DEPENDS:=@(aarch64||arm||x86_64) \
	+luci-compat \
	+luci-lib-jsonc \
	+docker \
	+dockerd \
	+ttyd
LUCI_PKGARCH:=all

PKG_LICENSE:=AGPL-3.0
PKG_MAINTAINER:=lisaac <lisaac.cn@gmail.com> \
		Florian Eckert <fe@dev.tdt.de>

PKG_VERSION:=1.0.0

# luci-lib-docker merged into this package: its only file
# luasrc/docker.lua is now luasrc/docker.lua in this package,
# installed as /usr/lib/lua/luci/docker.lua. Do not install a
# separate luci-lib-docker alongside it (same file would clash).
PKG_PROVIDES:=luci-lib-docker

include $(TOPDIR)/feeds/luci/luci.mk

# Do NOT delete the next line: OpenWrt scan.mk finds packages by
# grepping for 'call BuildPackage' in the Makefile.
# call BuildPackage - OpenWrt buildroot signature
