'use strict';
'require view';
'require fs';
'require ui';
'require rpc';

var callNetworkDump = rpc.declare({
	object: 'network.interface',
	method: 'dump',
	expect: { 'interface': [] }
});

function getLanIPv4(dump) {
	/* rpc.declare(expect) unwraps the reply: dump is already the interface array */
	var ifaces = Array.isArray(dump) ? dump : ((dump && dump.interface) || []);
	for (var i = 0; i < ifaces.length; i++) {
		if (ifaces[i].interface !== 'lan')
			continue;
		var addrs = ifaces[i]['ipv4-address'] || [];
		for (var j = 0; j < addrs.length; j++) {
			var ip = addrs[j].address || '';
			if (ip && ip.indexOf('127.') !== 0)
				return ip;
		}
	}
	return '';
}

return view.extend({
	load: function() {
		return Promise.all([
			callNetworkDump().catch(function() { return { 'interface': [] }; }),
			fs.read('/www/iptv').catch(function() { return ''; })
		]);
	},

	render: function(data) {
		var lanIp = getLanIPv4(data[0]);
		var initial = data[1] || '';

		var titleChildren = [ _('IPTV 播放地址') ];
		if (lanIp) {
			var url = 'http://' + lanIp + '/iptv';
			titleChildren.push(' ');
			titleChildren.push(E('a', {
				'href': url,
				'target': '_blank',
				'rel': 'noopener'
			}, url));
		}

		var counter = E('p', {}, [ '' ]);

		var textarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'style': 'width:100%;min-height:420px;font-family:monospace',
			'wrap': 'off',
			'spellcheck': 'false'
		}, [ initial ]);

		function updateCounter() {
			var v = textarea.value;
			counter.textContent = _('共 %d 行，%d 字符').format(v.split('\n').length, v.length);
		}

		textarea.addEventListener('input', updateCounter);
		updateCounter();

		var btnSave = E('button', {
			'class': 'btn cbi-button cbi-button-apply'
		}, [ _('保存') ]);

		btnSave.addEventListener('click', function() {
			ui.showModal(_('保存'), [
				E('p', { 'class': 'spinning' }, [ _('正在写入 /www/iptv…') ])
			]);

			fs.write('/www/iptv', textarea.value, 0o644 /* -rw-r--r-- */).then(function() {
				ui.hideModal();
				ui.addNotification(null, E('p', _('保存成功')));
			}).catch(function(err) {
				ui.hideModal();
				ui.addNotification(null,
					E('p', _('保存失败：') + (err && err.message ? err.message : err)),
					'error');
			});
		});

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, titleChildren),
			counter,
			E('div', { 'class': 'cbi-section' }, [ textarea ]),
			E('div', { 'class': 'cbi-page-actions' }, [ btnSave ])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
