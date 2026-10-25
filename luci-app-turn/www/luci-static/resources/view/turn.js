'use strict';
'require view';
'require rpc';
'require ui';

function escapeHtml(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
	});
}

return view.extend({
	load: function() {
		return Promise.resolve();
	},

	render: function() {
		var apiBase = 'http://' + window.location.hostname + ':8081/api';

		// ---- 样式 ----
		var nodeDiv = E('div', {});

		// ---- 节点设置 ----

		nodeDiv = E('div', {});
		var editingId = null;

		function api(path, method, body) {
			return fetch(apiBase + path, {
				method: method,
				headers: { 'Content-Type': 'application/json' },
				body: body ? JSON.stringify(body) : undefined
			}).then(function(r) {
				return r.json().catch(function() { return {}; }).then(function(j) {
					if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
					return j;
				});
			});
		}

		function fmtTest(t) {
			if (!t) return '<span style="color:#999">未测试</span>';
			return t.ok
				? '<span style="color:green">' + t.rttMs + 'ms</span>'
				: '<span style="color:red">失败</span>';
		}

		function refreshNodes() {
			api('/servers', 'GET').then(function(data) {
				var servers = data.servers || [];
				var activeId = data.activeId;
				var tb = document.getElementById('turn-tbody');
				if (!tb) return;
				tb.innerHTML = servers.map(function(s) {
					return '<tr>' +
						'<td style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:13px;">' + escapeHtml(s.name) + '</td>' +
						'<td style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:13px;">' + escapeHtml(s.host) + ':' + s.port + '</td>' +
						'<td style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:13px;">' + escapeHtml(s.username || '-') + '</td>' +
						'<td style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:13px;">' + (s.id === activeId ? '<span style="color:green">当前使用</span>' : '<span style="color:#999">备用</span>') + '</td>' +
						'<td style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:13px;">' + fmtTest(s.lastTest) + '</td>' +
						'<td style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:13px;">' +
							(s.id === activeId ? '' : '<button class="cbi-button cbi-button-action" onclick="turnActivate(\'' + s.id + '\')">设为当前</button> ') +
							'<button class="cbi-button" onclick="turnTest(\'' + s.id + '\')">测试</button> ' +
							'<button class="cbi-button" onclick="turnEdit(\'' + s.id + '\')">编辑</button> ' +
							'<button class="cbi-button cbi-button-negative" onclick="turnDel(\'' + s.id + '\')">删除</button>' +
						'</td></tr>';
				}).join('') || '<tr><td colspan="6" style="color:#999">还没有服务器，先添加一台</td></tr>';
				var btn = document.getElementById('turn-testall');
				if (btn) btn.disabled = servers.length === 0;
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, [ _('加载失败：') + e.message ]), 'error');
			});
			loadUrltest();
		}

		function loadUrltest() {
			api('/urltest', 'GET').then(function(c) {
				document.getElementById('turn-ut-enabled').checked = !!c.enabled;
				document.getElementById('turn-ut-interval').value = c.intervalSec;
				document.getElementById('turn-ut-tolerance').value = c.toleranceMs;
				renderLastRun(c.lastRun);
			}).catch(function() {});
			loadProxyauth();
		}

		function loadProxyauth() {
			api('/proxyauth', 'GET').then(function(c) {
				document.getElementById('turn-pa-enabled').checked = !!c.enabled;
				document.getElementById('turn-pa-username').value = c.username || '';
				document.getElementById('turn-pa-password').value = '';
				document.getElementById('turn-pa-password').placeholder = c.hasPassword ? '已设置（留空不改）' : '';
			}).catch(function() {});
		}

		function renderLastRun(lastRun) {
			var el = document.getElementById('turn-ut-lastrun');
			if (!el) return;
			if (!lastRun) { el.innerHTML = '<span style="color:#999">尚未执行</span>'; return; }
			var html = '<div style="color:#999">上次执行：' + escapeHtml(lastRun.at || '') + '</div>';
			if (lastRun.switched)
				html += '<div>切换：' + escapeHtml(lastRun.switched.from || '无') + ' → <b>' + escapeHtml(lastRun.switched.to) + '</b>（' + lastRun.switched.rttMs + 'ms）</div>';
			else
				html += '<div style="color:#999">未切换（已是最优或全部失败）</div>';
			el.innerHTML = html;
		}

		// 挂到 window 供 onclick 调用
		window.turnActivate = function(id) {
			api('/servers/' + id + '/activate', 'POST').then(refreshNodes)
				.catch(function(e) { alert(_('出错：') + e.message); });
		};
		window.turnTest = function(id) {
			api('/servers/' + id + '/test', 'POST').then(function(r) {
				refreshNodes();
			}).catch(function(e) { ui.addNotification(null, E('p', {}, [ _('出错：') + e.message ]), 'error'); });
		};
		window.turnEdit = function(id) {
			api('/servers', 'GET').then(function(data) {
				var s = (data.servers || []).find(function(x) { return x.id === id; });
				if (!s) return;
				editingId = id;
				document.getElementById('turn-f-name').value = s.name;
				document.getElementById('turn-f-host').value = s.host;
				document.getElementById('turn-f-port').value = s.port;
				document.getElementById('turn-f-user').value = s.username || '';
				document.getElementById('turn-f-pass').value = '';
				document.getElementById('turn-f-submit').textContent = _('保存');
				document.getElementById('turn-f-cancel').hidden = false;
			});
		};
		window.turnDel = function(id) {
			if (!confirm(_('确定删除？'))) return;
			api('/servers/' + id, 'DELETE').then(refreshNodes)
				.catch(function(e) { alert(_('出错：') + e.message); });
		};
		window.turnTestAll = function() {
			var btn = document.getElementById('turn-testall');
			btn.disabled = true; btn.textContent = _('测试中…');
			api('/servers/test-all', 'POST').then(refreshNodes)
				.catch(function(e) { alert(_('出错：') + e.message); })
				.then(function() { btn.disabled = false; btn.textContent = _('测试全部'); });
		};
		window.turnBatchAdd = function() {
			var text = document.getElementById('turn-batch-text').value;
			var btn = document.getElementById('turn-batch-btn');
			btn.disabled = true;
			api('/servers/batch', 'POST', { text: text }).then(function(r) {
				var msg = _('添加成功：') + r.added + _(' 台');
				if (r.failed.length) msg += _('，失败 ') + r.failed.length + _(' 行');
				alert(msg);
				document.getElementById('turn-batch-text').value = '';
				refreshNodes();
			}).catch(function(e) { alert(_('出错：') + e.message); })
			.then(function() { btn.disabled = false; });
		};
		window.turnSaveUrltest = function() {
			var body = {
				enabled: document.getElementById('turn-ut-enabled').checked,
				intervalSec: Number(document.getElementById('turn-ut-interval').value),
				toleranceMs: Number(document.getElementById('turn-ut-tolerance').value)
			};
			api('/urltest', 'PUT', body).then(function() {
				alert(_('已保存'));
				loadUrltest();
			}).catch(function(e) { alert(_('保存失败：') + e.message); });
		};
		window.turnRunUrltest = function() {
			var btn = document.getElementById('turn-ut-run');
			btn.disabled = true; btn.textContent = _('执行中…');
			api('/urltest/run', 'POST').then(function(r) {
				renderLastRun(r);
				refreshNodes();
			}).catch(function(e) { alert(_('出错：') + e.message); })
			.then(function() { btn.disabled = false; btn.textContent = _('立即执行一次'); });
		};
		window.turnSaveProxyauth = function() {
			var body = {
				enabled: document.getElementById('turn-pa-enabled').checked,
				username: document.getElementById('turn-pa-username').value,
				password: document.getElementById('turn-pa-password').value
			};
			if (body.enabled && !body.username) { alert(_('启用认证需要填写用户名')); return; }
			api('/proxyauth', 'PUT', body).then(function() {
				alert(_('已保存'));
				loadProxyauth();
			}).catch(function(e) { alert(_('保存失败：') + e.message); });
		};

		function submitForm(ev) {
			ev.preventDefault();
			var body = {
				name: document.getElementById('turn-f-name').value,
				host: document.getElementById('turn-f-host').value,
				port: Number(document.getElementById('turn-f-port').value) || 3478,
				username: document.getElementById('turn-f-user').value,
				password: document.getElementById('turn-f-pass').value
			};
			var p = editingId
				? api('/servers/' + editingId, 'PUT', body)
				: api('/servers', 'POST', body);
			p.then(function() {
				resetForm();
				refreshNodes();
			}).catch(function(e) { alert(_('出错：') + e.message); });
		}

		function resetForm() {
			editingId = null;
			document.getElementById('turn-f-name').value = '';
			document.getElementById('turn-f-host').value = '';
			document.getElementById('turn-f-port').value = '3478';
			document.getElementById('turn-f-user').value = '';
			document.getElementById('turn-f-pass').value = '';
			document.getElementById('turn-f-submit').textContent = _('添加');
			document.getElementById('turn-f-cancel').hidden = true;
		}

		nodeDiv.appendChild(E('div', { 'class': 'cbi-section', 'style': 'margin:0 0 10px 0 !important;padding:8px 0 !important;' }, [
			E('h3', {}, [
				_('TURN 服务器')
			]),
			E('table', { 'style': 'width:100%;border-collapse:collapse;' }, [
				E('thead', {}, [
					E('tr', {}, [
						E('th', { 'style': 'background:#fafafa;padding:10px;text-align:left;font-weight:600;color:#666;font-size:13px;border-bottom:2px solid #e8e8e8;' }, [ _('名称') ]),
						E('th', { 'style': 'background:#fafafa;padding:10px;text-align:left;font-weight:600;color:#666;font-size:13px;border-bottom:2px solid #e8e8e8;' }, [ _('地址') ]),
						E('th', { 'style': 'background:#fafafa;padding:10px;text-align:left;font-weight:600;color:#666;font-size:13px;border-bottom:2px solid #e8e8e8;' }, [ _('用户名') ]),
						E('th', { 'style': 'background:#fafafa;padding:10px;text-align:left;font-weight:600;color:#666;font-size:13px;border-bottom:2px solid #e8e8e8;' }, [ _('状态') ]),
						E('th', { 'style': 'background:#fafafa;padding:10px;text-align:left;font-weight:600;color:#666;font-size:13px;border-bottom:2px solid #e8e8e8;' }, [ _('上次测试') ]),
						E('th', { 'style': 'background:#fafafa;padding:10px;text-align:left;font-weight:600;color:#666;font-size:13px;border-bottom:2px solid #e8e8e8;' }, [ _('操作') ])
					])
				]),
				E('tbody', { 'id': 'turn-tbody' }, [])
			]),
			E('div', { 'style': 'margin:5px 0;padding:0 15px;' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'id': 'turn-testall',
					'click': function(ev) { ev.preventDefault(); window.turnTestAll(); }
				}, [ _('测试全部') ])
			]),
		]));
		nodeDiv.appendChild(E('div', { 'class': 'cbi-section', 'style': 'margin:0 0 10px 0 !important;padding:8px 0 !important;' }, [
			E('h3', { 'style': 'padding:0 15px !important;margin:0 0 5px 0 !important;' }, [ _('添加 TURN 服务器') ]),
			E('form', { 'id': 'turn-form', 'style': 'padding:0 15px;' }, [
				E('div', { 'style': 'display:flex;gap:10px;align-items:flex-end;flex-wrap:nowrap;margin:5px 0;' }, [
					E('div', { 'style': 'display:flex;flex-direction:column;flex-shrink:0;margin:0;padding:0;' }, [
						E('label', { 'style': 'font-size:12px;color:#666;margin-bottom:4px;display:block;' }, [ _('名称') ]),
						E('input', { 'id': 'turn-f-name', 'class': 'cbi-input-text', 'placeholder': _('备注名') , 'style': 'width:140px;padding:6px 8px;border:1px solid #ddd;border-radius:4px;' })
					]),
					E('div', { 'style': 'display:flex;flex-direction:column;flex-shrink:0;margin:0;padding:0;' }, [
						E('label', { 'style': 'font-size:12px;color:#666;margin-bottom:4px;display:block;' }, [ _('主机 *') ]),
						E('input', { 'id': 'turn-f-host', 'class': 'cbi-input-text', 'placeholder': 'turn.example.com' , 'style': 'width:180px;padding:6px 8px;border:1px solid #ddd;border-radius:4px;' })
					]),
					E('div', { 'style': 'display:flex;flex-direction:column;flex-shrink:0;margin:0;padding:0;' }, [
						E('label', { 'style': 'font-size:12px;color:#666;margin-bottom:4px;display:block;' }, [ _('端口') ]),
						E('input', { 'id': 'turn-f-port', 'class': 'cbi-input-text', 'value': '3478' , 'style': 'width:80px;padding:6px 8px;border:1px solid #ddd;border-radius:4px;' })
					]),
					E('div', { 'style': 'display:flex;flex-direction:column;flex-shrink:0;margin:0;padding:0;' }, [
						E('label', { 'style': 'font-size:12px;color:#666;margin-bottom:4px;display:block;' }, [ _('用户名') ]),
						E('input', { 'id': 'turn-f-user', 'class': 'cbi-input-text', 'placeholder': _('可选') , 'style': 'width:140px;padding:6px 8px;border:1px solid #ddd;border-radius:4px;' })
					]),
					E('div', { 'style': 'display:flex;flex-direction:column;flex-shrink:0;margin:0;padding:0;' }, [
						E('label', { 'style': 'font-size:12px;color:#666;margin-bottom:4px;display:block;' }, [ _('密码') ]),
						E('input', { 'id': 'turn-f-pass', 'type': 'password', 'class': 'cbi-input-text', 'placeholder': _('可选') , 'style': 'width:140px;padding:6px 8px;border:1px solid #ddd;border-radius:4px;' })
					]),
					E('div', { 'style': 'display:flex;flex-direction:column;flex-shrink:0;margin:0;padding:0;' }, [
						E('label', { 'style': 'font-size:12px;color:#666;margin-bottom:4px;display:block;' }, [ '\u00a0' ]),
						E('span', {}, [
							E('button', {
								'class': 'cbi-button cbi-button-positive',
								'id': 'turn-f-submit',
								'click': submitForm
							}, [ _('添加') ]),
							E('button', {
								'class': 'cbi-button',
								'id': 'turn-f-cancel',
								'hidden': true,
								'click': function(ev) { ev.preventDefault(); resetForm(); }
							}, [ _('取消') ])
						])
					])
				])
			]),
			E('h3', { 'style': 'padding:0 15px !important;margin:0 0 5px 0 !important;' }, [ _('批量添加') ]),
			E('p', { 'class': 'cbi-value-description', 'style': 'padding:0 15px !important;margin:5px 0 !important;' }, [
				_('每行一个，格式：turn://用户名:密码@主机:端口，或加备注名：备注名 turn://用户名:密码@主机:端口')
			]),
			E('textarea', {
				'id': 'turn-batch-text',
				'class': 'cbi-input-textarea',
				'rows': '1',
				'style': 'width:16.67%;height:32px;min-height:32px;overflow:hidden;resize:none;line-height:20px;padding:6px 8px;box-sizing:border-box;border:1px solid #ddd;border-radius:4px;margin:5px 15px;',
				'input': function(ev) {
					var t = ev.target;
					t.style.height = 'auto';
					t.style.height = Math.max(32, t.scrollHeight) + 'px';
				}
			}),
			E('div', { 'style': 'margin:5px 0;padding:0 15px;' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'id': 'turn-batch-btn',
					'click': function(ev) { ev.preventDefault(); window.turnBatchAdd(); }
				}, [ _('批量添加') ])
			]),
		]));
		nodeDiv.appendChild(E('div', { 'class': 'cbi-section', 'style': 'margin:0 0 10px 0 !important;padding:8px 0 !important;' }, [
			E('h3', { 'style': 'padding:0 15px !important;margin:0 0 5px 0 !important;' }, [ _('URLTest 自动优选') ]),
			E('div', { 'class': 'cbi-value', 'style': 'padding:0 15px;' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('启用') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'id': 'turn-ut-enabled', 'type': 'checkbox', 'class': 'cbi-input-checkbox' })
				])
			]),
			E('div', { 'class': 'cbi-value', 'style': 'padding:0 15px;' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('检测间隔（秒）') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'id': 'turn-ut-interval', 'class': 'cbi-input-text', 'value': '300' })
				])
			]),
			E('div', { 'class': 'cbi-value', 'style': 'padding:0 15px;' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('切换容差（毫秒）') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'id': 'turn-ut-tolerance', 'class': 'cbi-input-text', 'value': '50' })
				])
			]),
			E('div', { 'style': 'margin:5px 0;padding:0 15px;' }, [
				E('button', {
					'class': 'cbi-button cbi-button-positive',
					'click': function(ev) { ev.preventDefault(); window.turnSaveUrltest(); }
				}, [ _('保存配置') ]),
				E('button', {
					'class': 'cbi-button', 'style': 'background:#34a853;color:#fff;border:1px solid #34a853;',
					'id': 'turn-ut-run',
					'click': function(ev) { ev.preventDefault(); window.turnRunUrltest(); }
				}, [ _('立即执行一次') ])
			]),
			E('div', { 'id': 'turn-ut-lastrun', 'style': 'padding:0 15px 8px;' }, [])
		]));
		nodeDiv.appendChild(E('div', { 'class': 'cbi-section', 'style': 'margin:0 0 10px 0 !important;padding:8px 0 !important;' }, [
			E('h3', { 'style': 'padding:0 15px !important;margin:0 0 5px 0 !important;' }, [ _('代理认证') ]),
			E('div', { 'class': 'cbi-value', 'style': 'padding:0 15px;' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('启用') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'id': 'turn-pa-enabled', 'type': 'checkbox', 'class': 'cbi-input-checkbox' })
				])
			]),
			E('div', { 'class': 'cbi-value', 'style': 'padding:0 15px;' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('HTTP 代理') ]),
				E('div', { 'class': 'cbi-value-field', 'style': 'color:#5e72e4;' }, [
					'http:// ' + window.location.hostname + ':8899'
				])
			]),
			E('div', { 'class': 'cbi-value', 'style': 'padding:0 15px;' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('SOCKS5 代理') ]),
				E('div', { 'class': 'cbi-value-field', 'style': 'color:#5e72e4;' }, [
					'socks5:// ' + window.location.hostname + ':9988'
				])
			]),
			E('div', { 'class': 'cbi-value', 'style': 'padding:0 15px;' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('用户名') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'id': 'turn-pa-username', 'class': 'cbi-input-text' })
				])
			]),
			E('div', { 'class': 'cbi-value', 'style': 'padding:0 15px;' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('密码') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					E('input', { 'id': 'turn-pa-password', 'type': 'password', 'class': 'cbi-input-text' })
				])
			]),
			E('div', { 'style': 'margin:5px 0;padding:0 15px;' }, [
				E('button', {
					'class': 'cbi-button cbi-button-positive',
					'click': function(ev) { ev.preventDefault(); window.turnSaveProxyauth(); }
				}, [ _('保存配置') ])
			])
		]));

		setTimeout(refreshNodes, 100);
		return E('div', { 'style': 'padding:0' }, [ nodeDiv ]);
	}
});
