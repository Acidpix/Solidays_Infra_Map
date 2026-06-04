const fetch = require('node-fetch');

let _token = null;
let _tokenCfg = null; // to detect config changes

function buildUrl(cfg) {
  return `${cfg.proto}://${cfg.host}:${cfg.port}${cfg.path}/api_jsonrpc.php`;
}

async function zabbixCall(url, method, params, auth = null) {
  const body = { jsonrpc: '2.0', method, params, id: 1 };
  if (auth) body.auth = auth;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 10000,
  });
  const json = await res.json();
  if (json.error) throw new Error(`Zabbix error ${json.error.code}: ${json.error.data}`);
  return json.result;
}

async function login(cfg) {
  const url = buildUrl(cfg);
  const cfgKey = `${url}|${cfg.user}`;
  if (_token && _tokenCfg === cfgKey) return _token;
  _token = await zabbixCall(url, 'user.login', { user: cfg.user, password: cfg.pass });
  _tokenCfg = cfgKey;
  return _token;
}

// Detect device category from Zabbix host templates/groups
function detectCategory(host) {
  const name = (host.name || '').toUpperCase();
  const groups = (host.groups || []).map(g => g.name.toUpperCase()).join(' ');
  const templates = (host.parentTemplates || []).map(t => t.name.toUpperCase()).join(' ');
  const all = `${name} ${groups} ${templates}`;
  if (/WAVE|RADWIN|AIRFIBER|UBNT|MIKROTIK.*WAVE/i.test(all)) return 'wave';
  if (/CAMERA|CAM|CCTV|HIKVISION|DAHUA|AXIS/i.test(all)) return 'cam';
  if (/SWITCH|SW-|SW_|L2|L3|VLAN/i.test(all)) return 'sw';
  if (/AP-|AP_|WIFI|WI-FI|ACCESS.POINT|UNIFI|ARUBA/i.test(all)) return 'ap';
  return 'sw'; // default
}

// Map Zabbix item keys to our metrics
const ITEM_KEY_MAP = {
  'icmppingsec':           { metric: 'latency', transform: v => parseFloat((v * 1000).toFixed(2)) },
  'icmpping':              { metric: 'ping',    transform: v => parseInt(v) },
  'system.uptime':         { metric: 'uptime',  transform: v => formatUptime(v) },
  'net.if.in':             { metric: 'traffic_in' },
  'net.if.out':            { metric: 'traffic_out' },
  // Wireless
  'rssi':                  { metric: 'signal' },
  'signal':                { metric: 'signal' },
  'tx.signal':             { metric: 'signal' },
  'wireless.clients':      { metric: 'clients', transform: v => parseInt(v) },
  'association.count':     { metric: 'clients', transform: v => parseInt(v) },
  // Switch
  'ifAdminStatus':         { metric: 'portsUp' },
  'net.if.discovery':      { metric: 'ports' },
  // Camera
  'fps':                   { metric: 'fps',     transform: v => parseFloat(v) },
};

function formatUptime(seconds) {
  seconds = parseInt(seconds);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}j ${h}h`;
}

async function getHosts(cfg) {
  const url = buildUrl(cfg);
  const auth = await login(cfg);

  const hosts = await zabbixCall(url, 'host.get', {
    output: ['hostid', 'name', 'status'],
    selectGroups: ['name'],
    selectParentTemplates: ['name'],
    filter: { status: 0 }, // only enabled hosts
  }, auth);

  if (!hosts.length) return [];

  // Fetch items for all hosts in one call
  const hostIds = hosts.map(h => h.hostid);
  const items = await zabbixCall(url, 'item.get', {
    output: ['hostid', 'key_', 'lastvalue', 'units'],
    hostids: hostIds,
    monitored: true,
    filter: { status: 0 },
  }, auth);

  // Fetch interfaces (IP)
  const interfaces = await zabbixCall(url, 'hostinterface.get', {
    output: ['hostid', 'ip'],
    hostids: hostIds,
    main: 1,
  }, auth);

  // Build lookup maps
  const itemsByHost = {};
  for (const item of items) {
    if (!itemsByHost[item.hostid]) itemsByHost[item.hostid] = [];
    itemsByHost[item.hostid].push(item);
  }
  const ipByHost = {};
  for (const iface of interfaces) ipByHost[iface.hostid] = iface.ip;

  return hosts.map(host => {
    const category = detectCategory(host);
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

    // Ensure ping is boolean
    if (metrics.ping !== undefined) metrics.ping = metrics.ping === 1 || metrics.ping === '1';
    else metrics.ping = true; // assume up if not monitored

    return {
      id: `zbx_${host.hostid}`,
      zabbix_id: host.hostid,
      name: host.name,
      type: category,
      ip: ipByHost[host.hostid] || '',
      ...metrics,
      status: 'ok', // will be computed by trigger evaluation
    };
  });
}

async function testConnection(cfg) {
  const url = buildUrl(cfg);
  const version = await zabbixCall(url, 'apiinfo.version', {});
  return version;
}

module.exports = { getHosts, testConnection, login };
