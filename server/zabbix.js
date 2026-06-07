const fetch = require('node-fetch');

let _token = null;
let _tokenCfg = null;

function buildUrl(cfg) {
  const basePath = (cfg.path || '').replace(/\/+$/, '');
  return `${cfg.proto}://${cfg.host}:${cfg.port}${basePath}/api_jsonrpc.php`;
}

async function zabbixCall(url, method, params, auth = null) {
  const body = { jsonrpc: '2.0', method, params, id: 1 };
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = `Bearer ${auth}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout: 10000,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Zabbix API at ${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.error) throw new Error(`Zabbix error ${json.error.code}: ${json.error.data}`);
  return json.result;
}

async function login(cfg) {
  const url = buildUrl(cfg);
  const cfgKey = `${url}|${cfg.user}`;
  if (_token && _tokenCfg === cfgKey) return _token;
  // Zabbix < 5.4 uses "user", 5.4+ uses "username"
  try {
    _token = await zabbixCall(url, 'user.login', { username: cfg.user, password: cfg.pass });
  } catch (e) {
    if (e.message.includes('-32602')) {
      _token = await zabbixCall(url, 'user.login', { user: cfg.user, password: cfg.pass });
    } else throw e;
  }
  _tokenCfg = cfgKey;
  return _token;
}

// Assign category solely by zabbix_groups configuration
function detectCategory(host, categories) {
  const hostGroups = (host.hostgroups || host.groups || []).map(g => g.name);
  for (const cat of categories) {
    if (cat.zabbix_groups && cat.zabbix_groups.length > 0) {
      const match = cat.zabbix_groups.some(zg =>
        hostGroups.some(hg => hg.toLowerCase().includes(zg.toLowerCase()))
      );
      if (match) return cat.id;
    }
  }
  return null; // non classé
}

const ITEM_KEY_MAP = {
  'icmppingsec':      { metric: 'latency', transform: v => parseFloat((v * 1000).toFixed(2)) },
  'icmpping':         { metric: 'ping',    transform: v => parseInt(v) },
  'system.uptime':    { metric: 'uptime',  transform: v => formatUptime(v) },
  'net.if.in':        { metric: 'traffic_in' },
  'net.if.out':       { metric: 'traffic_out' },
  'rssi':             { metric: 'signal' },
  'signal':           { metric: 'signal' },
  'tx.signal':        { metric: 'signal' },
  'wireless.clients': { metric: 'clients', transform: v => parseInt(v) },
  'association.count':{ metric: 'clients', transform: v => parseInt(v) },
  'clients':          { metric: 'clients', transform: v => parseInt(v) },
  'link.signal':      { metric: 'signal' },
  'connection.failure':{ metric: 'connFailure', transform: v => parseInt(v) },
  'total.power':      { metric: 'power',   transform: v => parseFloat(v) },
  'board.':           { metric: 'temp',    transform: v => parseFloat(v) }, // clé "Board.[Board Temp]" → "board." après suppression des [..]
  'ifAdminStatus':    { metric: 'portsUp' },
  'net.if.discovery': { metric: 'ports' },
  'fps':              { metric: 'fps',     transform: v => parseFloat(v) },
};

function formatUptime(seconds) {
  seconds = parseInt(seconds);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}j ${h}h`;
}

async function getHosts(cfg, categories = []) {
  const url = buildUrl(cfg);
  const auth = await login(cfg);

  const hosts = await zabbixCall(url, 'host.get', {
    output: ['hostid', 'name', 'status'],
    selectHostGroups: ['name'],
    filter: { status: 0 },
  }, auth);

  // Debug: log groups of first host to verify field name
  if (hosts.length > 0) {
    const h = hosts[0];
    console.log(`[Zabbix] Host sample "${h.name}" groups:`, h.hostgroups || h.groups || '(empty)');
  }

  if (!hosts.length) return [];

  const hostIds = hosts.map(h => h.hostid);

  const [items, interfaces] = await Promise.all([
    zabbixCall(url, 'item.get', {
      output: ['hostid', 'key_', 'lastvalue', 'units'],
      hostids: hostIds,
      monitored: true,
      filter: { status: 0 },
    }, auth),
    zabbixCall(url, 'hostinterface.get', {
      output: ['hostid', 'ip'],
      hostids: hostIds,
      main: 1,
    }, auth),
  ]);

  const itemsByHost = {};
  for (const item of items) {
    if (!itemsByHost[item.hostid]) itemsByHost[item.hostid] = [];
    itemsByHost[item.hostid].push(item);
  }
  const ipByHost = {};
  for (const iface of interfaces) ipByHost[iface.hostid] = iface.ip;

  return hosts.map(host => {
    const category = detectCategory(host, categories);
    const hostItems = itemsByHost[host.hostid] || [];
    const metrics = {};

    for (const item of hostItems) {
      const keyLower = item.key_.toLowerCase().replace(/\[.*\]/, '');
      const map = ITEM_KEY_MAP[keyLower];
      if (map) {
        const val = map.transform ? map.transform(item.lastvalue) : item.lastvalue;
        if (metrics[map.metric] === undefined) metrics[map.metric] = val;
      }
    }

    if (metrics.ping !== undefined) metrics.ping = metrics.ping === 1 || metrics.ping === '1';
    else metrics.ping = true;

    return {
      id: `zbx_${host.hostid}`,
      zabbix_id: host.hostid,
      name: host.name,
      type: category || 'uncat',
      ip: ipByHost[host.hostid] || '',
      ...metrics,
      status: 'ok',
    };
  });
}

async function getGroups(cfg) {
  const url = buildUrl(cfg);
  const auth = await login(cfg);
  const groups = await zabbixCall(url, 'hostgroup.get', {
    output: ['name'],
    real_hosts: true,
  }, auth);
  return groups.map(g => g.name).sort();
}

async function testConnection(cfg) {
  const url = buildUrl(cfg);
  const version = await zabbixCall(url, 'apiinfo.version', {});
  // Also verify credentials by actually logging in
  _token = null;
  _tokenCfg = null;
  await login(cfg);
  return version;
}

module.exports = { getHosts, getGroups, testConnection, login };
