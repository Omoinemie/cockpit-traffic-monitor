// ============================================================
//  Cockpit Traffic Monitor – src/app.js
// ============================================================

// ---- i18n ----
var _lang = {};
function loadLang(lang) {
  if (typeof cockpit !== 'undefined') {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'po/' + lang + '.json', false);
      xhr.send(null);
      if (xhr.status === 200 || xhr.status === 0) {
        try { _lang = JSON.parse(xhr.responseText); } catch(e) {}
      }
    } catch(e) {}
  }
}
function t(key) { return _lang[key] || key; }
function applyLang() {
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
}

// Detect language
(function() {
  var lang = (navigator.language || 'en').toLowerCase();
  if (lang.indexOf('zh') === 0) {
    loadLang('zh_CN');
  } else {
    loadLang('en');
  }
})();

// ---- Constants ----
var TIME_SPANS = [
  { label: function(){ return t('1 min'); },  seconds: 60 },
  { label: function(){ return t('5 min'); },  seconds: 300 },
  { label: function(){ return t('30 min'); }, seconds: 1800 },
  { label: function(){ return t('1 hour'); }, seconds: 3600 },
  { label: function(){ return t('6 hours'); }, seconds: 21600 },
  { label: function(){ return t('12 hours'); }, seconds: 43200 },
  { label: function(){ return t('24 hours'); }, seconds: 86400 },
  { label: function(){ return t('3 days'); }, seconds: 259200 },
  { label: function(){ return t('7 days'); }, seconds: 604800 }
];

var INTERVAL_OPTIONS = [
  { label: function(){ return t('1 second'); },  value: 1000 },
  { label: function(){ return t('2 seconds'); }, value: 2000 },
  { label: function(){ return t('5 seconds'); }, value: 5000 },
  { label: function(){ return t('10 seconds'); }, value: 10000 },
  { label: function(){ return t('Auto'); },       value: 0 }
];

var CHART_COLORS = [
  '#3370ff', '#34c724', '#ff7d00', '#f54a45', '#a855f7',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#f43f5e', '#8b5cf6', '#0ea5e9', '#d946ef'
];

// ---- State ----
var state = {
  interfaces: {},
  order: [],
  interval: 5000,
  unit: 'binary',
  threshold: 100,
  typeFilter: [],
  activeTypes: null,
  demo: false,
  trendRange: 1800,
  statsRange: 1800,
  detailName: null,
  detailRange: 3600,
  sortField: 'name',
  sortDir: 'asc',
  filterValues: {},
  vnstatAvail: false,
  running: true
};

// ---- History Structure ----
function makeHistory() {
  return {
    minute:  { ts: [], txBytes: [], rxBytes: [], txSpeed: [], rxSpeed: [] },
    hourly:  { ts: [], txBytes: [], rxBytes: [], txSpeed: [], rxSpeed: [] },
    daily:   { ts: [], txBytes: [], rxBytes: [], txSpeed: [], rxSpeed: [] },
    monthly: { ts: [], txBytes: [], rxBytes: [], txSpeed: [], rxSpeed: [] },
    _lastMinuteBucket: null,
    _lastHourlyBucket: null,
    _lastDailyBucket: null,
    _lastMonthlyBucket: null
  };
}

function ensureHistory(name) {
  if (!state.interfaces[name]) {
    state.interfaces[name] = {
      name: name,
      type: 'unknown',
      txBytes: 0, rxBytes: 0,
      txPackets: 0, rxPackets: 0,
      txErrors: 0, rxErrors: 0,
      txDropped: 0, rxDropped: 0,
      txSpeed: 0, rxSpeed: 0,
      totalBytes: 0,
      prevTxBytes: 0, prevRxBytes: 0,
      linkSpeed: '',
      state: 'down',
      mac: '', ipv4: '', ipv6: '',
      wifi: null,
      history: makeHistory(),
      sparkTx: [],
      sparkRx: []
    };
    state.order.push(name);
  }
  return state.interfaces[name];
}

// ---- Tiered History ----
function pushRaw(hist, ts, tx, rx) {
  var lastTs = hist.minute.ts.length > 0 ? hist.minute.ts[hist.minute.ts.length - 1] : 0;
  if (ts <= lastTs) return;
  hist.minute.ts.push(ts);
  hist.minute.txBytes.push(tx);
  hist.minute.rxBytes.push(rx);
  var dt = ts - lastTs;
  if (dt > 0 && lastTs > 0) {
    hist.minute.txSpeed.push((tx - (hist.minute.txBytes[hist.minute.txBytes.length - 2] || tx)) / dt);
    hist.minute.rxSpeed.push((rx - (hist.minute.rxBytes[hist.minute.rxBytes.length - 2] || rx)) / dt);
  } else {
    hist.minute.txSpeed.push(0);
    hist.minute.rxSpeed.push(0);
  }
  rollupMinute(hist);
  trimHistory(hist);
}

function rollupMinute(hist) {
  if (hist.minute.ts.length < 2) return;
  var now = hist.minute.ts[hist.minute.ts.length - 1];
  var bucket = Math.floor(now / 3600) * 3600;
  if (bucket === hist._lastHourlyBucket) return;
  if (hist._lastHourlyBucket === null) { hist._lastHourlyBucket = bucket; return; }
  var startIdx = -1;
  for (var i = hist.minute.ts.length - 1; i >= 0; i--) {
    if (hist.minute.ts[i] < hist._lastHourlyBucket) { startIdx = i + 1; break; }
    if (i === 0) startIdx = 0;
  }
  if (startIdx < 0 || startIdx >= hist.minute.ts.length) { hist._lastHourlyBucket = bucket; return; }
  var sumTx = 0, sumRx = 0;
  for (var j = startIdx; j < hist.minute.ts.length; j++) {
    sumTx += hist.minute.txSpeed[j];
    sumRx += hist.minute.rxSpeed[j];
  }
  var count = hist.minute.ts.length - startIdx;
  hist.hourly.ts.push(hist._lastHourlyBucket);
  hist.hourly.txSpeed.push(count > 0 ? sumTx / count : 0);
  hist.hourly.rxSpeed.push(count > 0 ? sumRx / count : 0);
  hist.hourly.txBytes.push(hist.minute.txBytes[hist.minute.txBytes.length - 1]);
  hist.hourly.rxBytes.push(hist.minute.rxBytes[hist.minute.rxBytes.length - 1]);
  hist._lastHourlyBucket = bucket;
  rollupHourly(hist);
}

function rollupHourly(hist) {
  if (hist.hourly.ts.length < 2) return;
  var now = hist.hourly.ts[hist.hourly.ts.length - 1];
  var bucket = Math.floor(now / 86400) * 86400;
  if (bucket === hist._lastDailyBucket) return;
  if (hist._lastDailyBucket === null) { hist._lastDailyBucket = bucket; return; }
  var startIdx = -1;
  for (var i = hist.hourly.ts.length - 1; i >= 0; i--) {
    if (hist.hourly.ts[i] < hist._lastDailyBucket) { startIdx = i + 1; break; }
    if (i === 0) startIdx = 0;
  }
  if (startIdx < 0 || startIdx >= hist.hourly.ts.length) { hist._lastDailyBucket = bucket; return; }
  var sumTx = 0, sumRx = 0;
  for (var j = startIdx; j < hist.hourly.ts.length; j++) {
    sumTx += hist.hourly.txSpeed[j];
    sumRx += hist.hourly.rxSpeed[j];
  }
  var count = hist.hourly.ts.length - startIdx;
  hist.daily.ts.push(hist._lastDailyBucket);
  hist.daily.txSpeed.push(count > 0 ? sumTx / count : 0);
  hist.daily.rxSpeed.push(count > 0 ? sumRx / count : 0);
  hist.daily.txBytes.push(hist.hourly.txBytes[hist.hourly.txBytes.length - 1]);
  hist.daily.rxBytes.push(hist.hourly.rxBytes[hist.hourly.rxBytes.length - 1]);
  hist._lastDailyBucket = bucket;
  rollupDaily(hist);
}

function rollupDaily(hist) {
  if (hist.daily.ts.length < 2) return;
  var now = hist.daily.ts[hist.daily.ts.length - 1];
  var bucket = Math.floor(now / 2592000) * 2592000; // ~30 day month
  if (bucket === hist._lastMonthlyBucket) return;
  if (hist._lastMonthlyBucket === null) { hist._lastMonthlyBucket = bucket; return; }
  var startIdx = -1;
  for (var i = hist.daily.ts.length - 1; i >= 0; i--) {
    if (hist.daily.ts[i] < hist._lastMonthlyBucket) { startIdx = i + 1; break; }
    if (i === 0) startIdx = 0;
  }
  if (startIdx < 0 || startIdx >= hist.daily.ts.length) { hist._lastMonthlyBucket = bucket; return; }
  var sumTx = 0, sumRx = 0;
  for (var j = startIdx; j < hist.daily.ts.length; j++) {
    sumTx += hist.daily.txSpeed[j];
    sumRx += hist.daily.rxSpeed[j];
  }
  var count = hist.daily.ts.length - startIdx;
  hist.monthly.ts.push(hist._lastMonthlyBucket);
  hist.monthly.txSpeed.push(count > 0 ? sumTx / count : 0);
  hist.monthly.rxSpeed.push(count > 0 ? sumRx / count : 0);
  hist.monthly.txBytes.push(hist.daily.txBytes[hist.daily.txBytes.length - 1]);
  hist.monthly.rxBytes.push(hist.daily.rxBytes[hist.daily.rxBytes.length - 1]);
  hist._lastMonthlyBucket = bucket;
}

function trimHistory(hist) {
  var maxMin = 1440;
  if (hist.minute.ts.length > maxMin) {
    hist.minute.ts.splice(0, hist.minute.ts.length - maxMin);
    hist.minute.txBytes.splice(0, hist.minute.txBytes.length - maxMin);
    hist.minute.rxBytes.splice(0, hist.minute.rxBytes.length - maxMin);
    hist.minute.txSpeed.splice(0, hist.minute.txSpeed.length - maxMin);
    hist.minute.rxSpeed.splice(0, hist.minute.rxSpeed.length - maxMin);
  }
  var maxH = 720;
  if (hist.hourly.ts.length > maxH) {
    hist.hourly.ts.splice(0, hist.hourly.ts.length - maxH);
    hist.hourly.txBytes.splice(0, hist.hourly.txBytes.length - maxH);
    hist.hourly.rxBytes.splice(0, hist.hourly.rxBytes.length - maxH);
    hist.hourly.txSpeed.splice(0, hist.hourly.txSpeed.length - maxH);
    hist.hourly.rxSpeed.splice(0, hist.hourly.rxSpeed.length - maxH);
  }
  var maxD = 365;
  if (hist.daily.ts.length > maxD) {
    hist.daily.ts.splice(0, hist.daily.ts.length - maxD);
    hist.daily.txBytes.splice(0, hist.daily.txBytes.length - maxD);
    hist.daily.rxBytes.splice(0, hist.daily.rxBytes.length - maxD);
    hist.daily.txSpeed.splice(0, hist.daily.txSpeed.length - maxD);
    hist.daily.rxSpeed.splice(0, hist.daily.rxSpeed.length - maxD);
  }
  var maxM = 60;
  if (hist.monthly.ts.length > maxM) {
    hist.monthly.ts.splice(0, hist.monthly.ts.length - maxM);
    hist.monthly.txBytes.splice(0, hist.monthly.txBytes.length - maxM);
    hist.monthly.rxBytes.splice(0, hist.monthly.rxBytes.length - maxM);
    hist.monthly.txSpeed.splice(0, hist.monthly.txSpeed.length - maxM);
    hist.monthly.rxSpeed.splice(0, hist.monthly.rxSpeed.length - maxM);
  }
}

function tierForRange(seconds) {
  if (seconds <= 3600) return 'minute';
  if (seconds <= 86400) return 'hourly';
  if (seconds <= 604800) return 'daily';
  return 'monthly';
}

function getChartData(iface, seconds) {
  var tier = tierForRange(seconds);
  var h = iface.history[tier];
  if (!h || h.ts.length === 0) return { ts: [], tx: [], rx: [] };
  var cutoff = Date.now() / 1000 - seconds;
  var ts = [], tx = [], rx = [];
  for (var i = 0; i < h.ts.length; i++) {
    if (h.ts[i] >= cutoff) {
      ts.push(h.ts[i]);
      tx.push(h.txSpeed[i] || 0);
      rx.push(h.rxSpeed[i] || 0);
    }
  }
  return { ts: ts, tx: tx, rx: rx };
}

function getSparkData(iface) {
  return { tx: iface.sparkTx.slice(-30), rx: iface.sparkRx.slice(-30) };
}

// ---- Utilities ----
function fmt(bytes) {
  if (bytes === 0) return '0 B';
  var unit = state.unit === 'decimal' ? 1000 : 1024;
  var suffixes = state.unit === 'decimal'
    ? ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    : ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  var i = Math.floor(Math.log(bytes) / Math.log(unit));
  if (i >= suffixes.length) i = suffixes.length - 1;
  if (i < 0) i = 0;
  return (bytes / Math.pow(unit, i)).toFixed(i > 0 ? 2 : 0) + ' ' + suffixes[i];
}

function fmtS(speed) {
  return fmt(Math.abs(speed)) + '/s';
}

function fmtSpeed(speed) {
  return fmtS(speed);
}

function ifaceType(name) {
  if (name === 'lo') return 'loopback';
  if (name.indexOf('bond') === 0) return 'bond';
  if (name.indexOf('vlan') === 0 || /\.\d+$/.test(name)) return 'vlan';
  if (name.indexOf('br') === 0 || name.indexOf('virbr') === 0) return 'bridge';
  if (name.indexOf('wl') === 0 || name.indexOf('wlan') === 0) return 'wireless';
  if (name.indexOf('fw') === 0) return 'firewall';
  if (name.indexOf('tap') === 0 || name.indexOf('tun') === 0) return 'taptun';
  if (name.indexOf('veth') === 0) return 'veth';
  if (name.indexOf('docker') === 0 || name.indexOf('vnet') === 0) return 'virtual';
  return 'physical';
}

var typeLabels = {
  physical: function(){ return t('Physical NIC'); },
  bond: function(){ return t('Bond Interface'); },
  vlan: function(){ return t('VLAN Sub-Interface'); },
  bridge: function(){ return t('Network Bridge'); },
  wireless: function(){ return t('Wireless'); },
  firewall: function(){ return t('Firewall Interface'); },
  taptun: function(){ return t('TAP Interface'); },
  veth: function(){ return t('Virtual Ethernet'); },
  virtual: function(){ return t('Virtual Interface'); },
  loopback: function(){ return t('Loopback'); },
  unknown: function(){ return t('Virtual'); }
};

function getTypeLabel(type) {
  var fn = typeLabels[type];
  return fn ? fn() : type;
}

// ---- vnstat Backend ----
function loadVnstatData() {
  if (!state.vnstatAvail) return;
  var names = Object.keys(state.interfaces);
  names.forEach(function(name) {
    ['h', 'd', 'm'].forEach(function(interval) {
      var proc = cockpit.spawn(['vnstat', '-i', name, '--json', interval], { err: 'ignore' });
      proc.done(function(output) {
        ingestVnstatJson(name, output, interval);
      });
    });
  });
}

function ingestVnstatJson(name, jsonStr, interval) {
  try {
    var data = JSON.parse(jsonStr);
  } catch(e) { return; }
  if (!data.interfaces || data.interfaces.length === 0) return;
  var iface = data.interfaces[0];
  var traffic = iface.traffic;
  if (!traffic) return;
  var ifaceState = ensureHistory(name);
  if (interval === 'h' && traffic.hour) {
    var hours = traffic.hour;
    for (var i = 0; i < hours.length; i++) {
      var h = hours[i];
      var ts = new Date(h.date.year, h.date.month - 1, h.date.day, h.time ? h.time.hour : 0).getTime() / 1000;
      var txSpeed = (h.tx || 0) / 3600;
      var rxSpeed = (h.rx || 0) / 3600;
      ifaceState.history.hourly.ts.push(ts);
      ifaceState.history.hourly.txBytes.push(h.tx || 0);
      ifaceState.history.hourly.rxBytes.push(h.rx || 0);
      ifaceState.history.hourly.txSpeed.push(txSpeed);
      ifaceState.history.hourly.rxSpeed.push(rxSpeed);
    }
  } else if (interval === 'd' && traffic.day) {
    var days = traffic.day;
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var ts = new Date(d.date.year, d.date.month - 1, d.date.day).getTime() / 1000;
      var txSpeed = (d.tx || 0) / 86400;
      var rxSpeed = (d.rx || 0) / 86400;
      ifaceState.history.daily.ts.push(ts);
      ifaceState.history.daily.txBytes.push(d.tx || 0);
      ifaceState.history.daily.rxBytes.push(d.rx || 0);
      ifaceState.history.daily.txSpeed.push(txSpeed);
      ifaceState.history.daily.rxSpeed.push(rxSpeed);
    }
  } else if (interval === 'm' && traffic.month) {
    var months = traffic.month;
    for (var i = 0; i < months.length; i++) {
      var m = months[i];
      var ts = new Date(m.date.year, m.date.month - 1, 1).getTime() / 1000;
      var txSpeed = (m.tx || 0) / 2592000;
      var rxSpeed = (m.rx || 0) / 2592000;
      ifaceState.history.monthly.ts.push(ts);
      ifaceState.history.monthly.txBytes.push(m.tx || 0);
      ifaceState.history.monthly.rxBytes.push(m.rx || 0);
      ifaceState.history.monthly.txSpeed.push(txSpeed);
      ifaceState.history.monthly.rxSpeed.push(rxSpeed);
    }
  }
}

// Check vnstat availability
function checkVnstat() {
  var proc = cockpit.spawn(['which', 'vnstat'], { err: 'ignore' });
  proc.done(function() {
    state.vnstatAvail = true;
    loadVnstatData();
  });
  proc.fail(function() {
    state.vnstatAvail = false;
  });
}

// ---- Data Collection ----
function parseNetDev(text) {
  var lines = text.split('\n');
  var result = {};
  for (var i = 2; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    var name = line.substring(0, colonIdx).trim();
    var vals = line.substring(colonIdx + 1).trim().split(/\s+/);
    if (vals.length < 16) continue;
    result[name] = {
      rxBytes: parseInt(vals[0], 10) || 0,
      rxPackets: parseInt(vals[1], 10) || 0,
      rxErrors: parseInt(vals[2], 10) || 0,
      rxDropped: parseInt(vals[3], 10) || 0,
      txBytes: parseInt(vals[8], 10) || 0,
      txPackets: parseInt(vals[9], 10) || 0,
      txErrors: parseInt(vals[10], 10) || 0,
      txDropped: parseInt(vals[11], 10) || 0
    };
  }
  return result;
}

function fetchIfaceInfo(name) {
  var promises = [];
  // Get link speed
  var proc = cockpit.spawn(['cat', '/sys/class/net/' + name + '/speed'], { err: 'ignore' });
  proc.done(function(val) {
    var iface = state.interfaces[name];
    if (iface) {
      var speed = parseInt(val.trim(), 10);
      iface.linkSpeed = isNaN(speed) ? '' : (speed + ' Mbps');
    }
  });
  proc.fail(function() {
    var iface = state.interfaces[name];
    if (iface) iface.linkSpeed = '';
  });

  // Get state
  var proc2 = cockpit.spawn(['cat', '/sys/class/net/' + name + '/operstate'], { err: 'ignore' });
  proc2.done(function(val) {
    var iface = state.interfaces[name];
    if (iface) iface.state = val.trim().toLowerCase();
  });

  // Get MAC
  var proc3 = cockpit.spawn(['cat', '/sys/class/net/' + name + '/address'], { err: 'ignore' });
  proc3.done(function(val) {
    var iface = state.interfaces[name];
    if (iface) iface.mac = val.trim();
  });

  // Get IP addresses
  var proc4 = cockpit.spawn(['ip', '-4', 'addr', 'show', name], { err: 'ignore' });
  proc4.done(function(val) {
    var iface = state.interfaces[name];
    if (iface) {
      var m = val.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
      iface.ipv4 = m ? m[1] : '';
    }
  });

  var proc5 = cockpit.spawn(['ip', '-6', 'addr', 'show', name, 'scope', 'global'], { err: 'ignore' });
  proc5.done(function(val) {
    var iface = state.interfaces[name];
    if (iface) {
      var m = val.match(/inet6\s+([0-9a-f:]+)/);
      iface.ipv6 = m ? m[1] : '';
    }
  });

  // WiFi info
  var type = ifaceType(name);
  if (type === 'wireless') {
    var proc6 = cockpit.spawn(['iw', 'dev', name, 'info'], { err: 'ignore' });
    proc6.done(function(val) {
      var iface = state.interfaces[name];
      if (!iface) return;
      var ssid = (val.match(/ssid\s+(.+)/) || [])[1] || '';
      var freq = (val.match(/channel\s+\d+\s+\((\d+)\s+MHz\)/) || [])[1] || '';
      var ch = (val.match(/channel\s+(\d+)/) || [])[1] || '';
      iface.wifi = { ssid: ssid, freq: freq, channel: ch };
    });

    var proc7 = cockpit.spawn(['iw', 'dev', name, 'link'], { err: 'ignore' });
    proc7.done(function(val) {
      var iface = state.interfaces[name];
      if (!iface) return;
      if (!iface.wifi) iface.wifi = {};
      var signal = (val.match(/signal:\s+(-?\d+)/) || [])[1] || '';
      var bitrate = (val.match(/tx bitrate:\s+([\d.]+\s*\w+)/) || [])[1] || '';
      iface.wifi.signal = signal ? parseInt(signal, 10) : null;
      iface.wifi.bitrate = bitrate;
    });
  }
}

function updateState(netdev) {
  var now = Date.now() / 1000;
  var seen = {};
  Object.keys(netdev).forEach(function(name) {
    seen[name] = true;
    var dev = netdev[name];
    var iface = ensureHistory(name);
    iface.type = ifaceType(name);
    var dt = now - (iface._lastUpdate || now);
    if (dt > 0 && iface._lastUpdate) {
      iface.txSpeed = (dev.txBytes - iface.prevTxBytes) / dt;
      iface.rxSpeed = (dev.rxBytes - iface.prevRxBytes) / dt;
    }
    iface.prevTxBytes = iface.txBytes;
    iface.prevRxBytes = iface.rxBytes;
    iface.txBytes = dev.txBytes;
    iface.rxBytes = dev.rxBytes;
    iface.totalBytes = dev.txBytes + dev.rxBytes;
    iface.txPackets = dev.txPackets;
    iface.rxPackets = dev.rxPackets;
    iface.txErrors = dev.txErrors;
    iface.rxErrors = dev.rxErrors;
    iface.txDropped = dev.txDropped;
    iface.rxDropped = dev.rxDropped;
    iface._lastUpdate = now;
    // Push to history
    pushRaw(iface.history, now, dev.txBytes, dev.rxBytes);
    // Sparkline
    iface.sparkTx.push(iface.txSpeed);
    iface.sparkRx.push(iface.rxSpeed);
    if (iface.sparkTx.length > 60) iface.sparkTx.shift();
    if (iface.sparkRx.length > 60) iface.sparkRx.shift();
  });
  // Remove disappeared interfaces
  state.order.forEach(function(name) {
    if (!seen[name] && state.interfaces[name]) {
      state.interfaces[name].state = 'down';
    }
  });
}

function fetchData() {
  var proc = cockpit.spawn(['cat', '/proc/net/dev'], { err: 'ignore' });
  proc.done(function(text) {
    var netdev = parseNetDev(text);
    var newNames = Object.keys(netdev).filter(function(n) { return !state.interfaces[n]; });
    updateState(netdev);
    newNames.forEach(function(name) { fetchIfaceInfo(name); });
    render();
  });
  proc.fail(function() {
    if (!state.demo) {
      state.demo = true;
      demoData();
    }
  });
}

function demoData() {
  var now = Date.now() / 1000;
  var names = ['eth0', 'eth1', 'wlan0', 'lo', 'br0', 'docker0', 'bond0', 'vlan10'];
  names.forEach(function(name, idx) {
    var iface = ensureHistory(name);
    iface.type = ifaceType(name);
    iface.state = name === 'lo' ? 'up' : (Math.random() > 0.3 ? 'up' : 'down');
    iface.linkSpeed = iface.type === 'wireless' ? '300 Mbps' : (iface.type === 'physical' ? '1000 Mbps' : '');
    iface.mac = '00:1a:2b:3c:4d:' + (idx < 10 ? '0' : '') + idx;
    iface.ipv4 = '192.168.1.' + (10 + idx);
    iface.ipv6 = '';
    var txBase = Math.random() * 1e10;
    var rxBase = Math.random() * 1e10;
    var dt = now - (iface._lastUpdate || now - 5);
    if (dt > 0 && iface._lastUpdate) {
      iface.txSpeed = Math.random() * 1e7;
      iface.rxSpeed = Math.random() * 5e7;
    }
    iface.prevTxBytes = iface.txBytes;
    iface.prevRxBytes = iface.rxBytes;
    iface.txBytes = txBase;
    iface.rxBytes = rxBase;
    iface.totalBytes = txBase + rxBase;
    iface.txPackets = Math.floor(txBase / 1500);
    iface.rxPackets = Math.floor(rxBase / 1500);
    iface.txErrors = Math.random() > 0.8 ? Math.floor(Math.random() * 100) : 0;
    iface.rxErrors = Math.random() > 0.8 ? Math.floor(Math.random() * 50) : 0;
    iface.txDropped = Math.random() > 0.9 ? Math.floor(Math.random() * 20) : 0;
    iface.rxDropped = Math.random() > 0.9 ? Math.floor(Math.random() * 10) : 0;
    iface._lastUpdate = now;
    pushRaw(iface.history, now, iface.txBytes, iface.rxBytes);
    iface.sparkTx.push(iface.txSpeed);
    iface.sparkRx.push(iface.rxSpeed);
    if (iface.sparkTx.length > 60) iface.sparkTx.shift();
    if (iface.sparkRx.length > 60) iface.sparkRx.shift();
    if (iface.type === 'wireless') {
      iface.wifi = { ssid: 'MyNetwork', signal: -45, bitrate: '300 Mbit/s', channel: '6', freq: '2437' };
    }
  });
  render();
}

// ---- Filter / Sort ----
function getFiltered() {
  var list = state.order.map(function(n) { return state.interfaces[n]; });
  // Type filter
  if (state.activeTypes && state.activeTypes.length > 0) {
    list = list.filter(function(iface) { return state.activeTypes.indexOf(iface.type) >= 0; });
  }
  // Search filter
  var search = (document.getElementById('search-input') || {}).value || '';
  search = search.trim().toLowerCase();
  if (search) {
    list = list.filter(function(iface) { return iface.name.toLowerCase().indexOf(search) >= 0; });
  }
  // Field filters
  Object.keys(state.filterValues).forEach(function(field) {
    var vals = state.filterValues[field];
    if (vals && vals.length > 0) {
      list = list.filter(function(iface) {
        var v = '';
        if (field === 'type') v = iface.type;
        else if (field === 'status') v = iface.state === 'up' ? 'active' : 'offline';
        if (vals.indexOf(v) >= 0) return true;
        return false;
      });
    }
  });
  // Sort
  var field = state.sortField;
  var dir = state.sortDir === 'asc' ? 1 : -1;
  list.sort(function(a, b) {
    var av = a[field], bv = b[field];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
  return list;
}

// ---- Canvas Charts ----
function roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawLineChart(canvas, datasets, labels, opts) {
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.parentElement.getBoundingClientRect();
  var W = rect.width;
  var H = opts && opts.height ? opts.height : 200;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  var pad = { top: 20, right: 16, bottom: 30, left: 60 };
  var cw = W - pad.left - pad.right;
  var ch = H - pad.top - pad.bottom;

  if (!datasets || datasets.length === 0 || !labels || labels.length === 0) {
    ctx.fillStyle = '#8f959e';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t('Waiting for data...'), W / 2, H / 2);
    return;
  }

  // Find max
  var maxVal = 0;
  datasets.forEach(function(ds) {
    ds.data.forEach(function(v) { if (v > maxVal) maxVal = v; });
  });
  if (maxVal === 0) maxVal = 1;

  // Nice number
  var mag = Math.pow(10, Math.floor(Math.log10(maxVal)));
  var niceMax = Math.ceil(maxVal / mag) * mag;
  maxVal = niceMax;

  // Grid
  ctx.strokeStyle = '#e5e6eb';
  ctx.lineWidth = 0.5;
  var gridLines = 5;
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#8f959e';
  ctx.textAlign = 'right';
  for (var i = 0; i <= gridLines; i++) {
    var y = pad.top + ch - (i / gridLines) * ch;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    var val = (i / gridLines) * maxVal;
    ctx.fillText(fmtSpeed(val), pad.left - 6, y + 4);
  }

  // Time labels
  ctx.textAlign = 'center';
  var labelCount = Math.min(6, labels.length);
  var step = Math.max(1, Math.floor(labels.length / labelCount));
  for (var i = 0; i < labels.length; i += step) {
    var x = pad.left + (i / (labels.length - 1 || 1)) * cw;
    var d = new Date(labels[i] * 1000);
    var text = d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
    ctx.fillText(text, x, H - 6);
  }

  // Draw lines
  datasets.forEach(function(ds, di) {
    if (ds.data.length < 2) return;
    ctx.strokeStyle = ds.color || CHART_COLORS[di % CHART_COLORS.length];
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (var i = 0; i < ds.data.length; i++) {
      var x = pad.left + (i / (ds.data.length - 1 || 1)) * cw;
      var y = pad.top + ch - (ds.data[i] / maxVal) * ch;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Area fill
    if (ds.fill !== false) {
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = ds.color || CHART_COLORS[di % CHART_COLORS.length];
      ctx.lineTo(pad.left + cw, pad.top + ch);
      ctx.lineTo(pad.left, pad.top + ch);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  });
}

function drawSparkline(canvas, data, color) {
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var W = 80, H = 24;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (!data || data.length < 2) return;
  var max = 0;
  data.forEach(function(v) { if (v > max) max = v; });
  if (max === 0) max = 1;

  ctx.strokeStyle = color || '#3370ff';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (var i = 0; i < data.length; i++) {
    var x = (i / (data.length - 1 || 1)) * W;
    var y = H - (data[i] / max) * (H - 2) - 1;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ---- Render ----
function render() {
  renderStats();
  renderChart();
  renderTable();
  if (state.detailName) {
    renderDetailCharts();
  }
}

function renderStats() {
  var total = state.order.length;
  var active = 0;
  var totalTx = 0, totalRx = 0, totalSpeed = 0;
  state.order.forEach(function(name) {
    var iface = state.interfaces[name];
    if (iface.state === 'up') active++;
    totalTx += iface.txBytes;
    totalRx += iface.rxBytes;
    totalSpeed += iface.txSpeed + iface.rxSpeed;
  });
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-active').textContent = active;
  document.getElementById('stat-tx').textContent = fmt(totalTx);
  document.getElementById('stat-rx').textContent = fmt(totalRx);
  document.getElementById('stat-speed').textContent = fmtS(totalSpeed);
  document.getElementById('header-count').textContent = total + ' ' + t('interfaces');
}

function renderChart() {
  var canvas = document.getElementById('trend-chart');
  if (!canvas) return;
  // Aggregate all interfaces for trend
  var tier = tierForRange(state.trendRange);
  var now = Date.now() / 1000;
  var cutoff = now - state.trendRange;
  // Build combined time series
  var allTs = {};
  state.order.forEach(function(name) {
    var h = state.interfaces[name].history[tier];
    if (!h) return;
    for (var i = 0; i < h.ts.length; i++) {
      if (h.ts[i] >= cutoff) {
        var key = Math.round(h.ts[i]);
        if (!allTs[key]) allTs[key] = { tx: 0, rx: 0 };
        allTs[key].tx += h.txSpeed[i] || 0;
        allTs[key].rx += h.rxSpeed[i] || 0;
      }
    }
  });
  var keys = Object.keys(allTs).map(Number).sort(function(a,b){return a-b;});
  var ts = keys;
  var txData = keys.map(function(k) { return allTs[k].tx; });
  var rxData = keys.map(function(k) { return allTs[k].rx; });
  drawLineChart(canvas, [
    { label: t('Total TX'), data: txData, color: '#3370ff' },
    { label: t('Total RX'), data: rxData, color: '#34c724' }
  ], ts, { height: 220 });

  // Stats chart (per-interface)
  var canvas2 = document.getElementById('stats-chart');
  if (!canvas2) return;
  var tier2 = tierForRange(state.statsRange);
  var cutoff2 = now - state.statsRange;
  var datasets = [];
  var filtered = getFiltered();
  filtered.forEach(function(iface, idx) {
    var h = iface.history[tier2];
    if (!h || h.ts.length === 0) return;
    var txD = [], tsArr = [];
    for (var i = 0; i < h.ts.length; i++) {
      if (h.ts[i] >= cutoff2) {
        tsArr.push(h.ts[i]);
        txD.push((h.txSpeed[i] || 0) + (h.rxSpeed[i] || 0));
      }
    }
    if (txD.length > 0) {
      datasets.push({ label: iface.name, data: txD, color: CHART_COLORS[idx % CHART_COLORS.length], fill: false });
    }
  });
  var tsArr = datasets.length > 0 ? datasets[0].data.map(function(_, i) {
    // Use first dataset's times
    var tierH = filtered[0].history[tier2];
    var c = 0;
    for (var j = 0; j < tierH.ts.length; j++) {
      if (tierH.ts[j] >= cutoff2) {
        if (c === i) return tierH.ts[j];
        c++;
      }
    }
    return 0;
  }) : [];
  drawLineChart(canvas2, datasets, tsArr, { height: 220 });
}

function renderTable() {
  var tbody = document.getElementById('iface-tbody');
  if (!tbody) return;
  var filtered = getFiltered();
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">' + t('No matching interfaces') + '</td></tr>';
    return;
  }
  var html = '';
  filtered.forEach(function(iface) {
    var isActive = iface.state === 'up';
    var statusClass = isActive ? 'active' : 'offline';
    var statusText = isActive ? t('Active') : t('Offline');
    var typeLabel = getTypeLabel(iface.type);
    var spark = getSparkData(iface);
    html += '<tr class="' + (isActive ? 'active-row' : '') + '" data-name="' + iface.name + '">';
    html += '<td><span class="status-badge ' + statusClass + '">' + statusText + '</span></td>';
    html += '<td><a href="#" class="iface-link" data-name="' + iface.name + '">' + iface.name + '</a></td>';
    html += '<td><span class="type-badge">' + typeLabel + '</span></td>';
    html += '<td>' + (iface.linkSpeed || '—') + '</td>';
    html += '<td>' + fmtS(iface.txSpeed) + '</td>';
    html += '<td>' + fmtS(iface.rxSpeed) + '</td>';
    html += '<td>' + fmt(iface.txBytes) + '</td>';
    html += '<td>' + fmt(iface.rxBytes) + '</td>';
    html += '<td class="spark-cell"><canvas class="spark" data-name="' + iface.name + '"></canvas></td>';
    html += '</tr>';
  });
  tbody.innerHTML = html;

  // Draw sparklines
  tbody.querySelectorAll('canvas.spark').forEach(function(canvas) {
    var name = canvas.getAttribute('data-name');
    var iface = state.interfaces[name];
    if (iface) {
      drawSparkline(canvas, iface.sparkTx.slice(-30), '#3370ff');
      // Draw RX sparkline on a second canvas (or overlay)
      // For simplicity, just TX sparkline
    }
  });

  // Click handlers for detail
  tbody.querySelectorAll('.iface-link').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      openDetail(this.getAttribute('data-name'));
    });
  });
}

// ---- Time Range Buttons ----
function buildTimeButtons(container, currentRange, onChange) {
  if (!container) return;
  var html = '';
  TIME_SPANS.forEach(function(span) {
    var active = span.seconds === currentRange ? ' btn-active' : '';
    html += '<button class="btn btn-sm' + active + '" data-seconds="' + span.seconds + '">' + span.label() + '</button>';
  });
  container.innerHTML = html;
  container.querySelectorAll('button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      container.querySelectorAll('button').forEach(function(b) { b.classList.remove('btn-active'); });
      this.classList.add('btn-active');
      onChange(parseInt(this.getAttribute('data-seconds'), 10));
    });
  });
}

function initTimeButtons() {
  buildTimeButtons(document.getElementById('trend-time-btns'), state.trendRange, function(val) {
    state.trendRange = val;
    renderChart();
  });
  buildTimeButtons(document.getElementById('stats-time-btns'), state.statsRange, function(val) {
    state.statsRange = val;
    renderChart();
  });
}

// ---- Filters ----
function getUniqueValues(field) {
  var vals = {};
  state.order.forEach(function(name) {
    var iface = state.interfaces[name];
    var v = '';
    if (field === 'type') v = iface.type;
    else if (field === 'status') v = iface.state === 'up' ? 'active' : 'offline';
    if (v) vals[v] = true;
  });
  return Object.keys(vals).sort();
}

function rebuildFilters() {
  var container = document.getElementById('filter-dropdowns');
  if (!container) return;
  var html = '';
  // Type filter
  html += buildFilterDropdown('type', t('Type'), getUniqueValues('type'));
  // Status filter
  html += buildFilterDropdown('status', t('Status'), getUniqueValues('status'));
  container.innerHTML = html;
  initFilterDropdowns();
}

function buildFilterDropdown(field, label, values) {
  var selected = state.filterValues[field] || [];
  var hasFilter = selected.length > 0;
  var html = '<div class="filter-dropdown" data-field="' + field + '">';
  html += '<button class="filter-dropdown-btn' + (hasFilter ? ' has-filter' : '') + '">' + label + (hasFilter ? ' (' + selected.length + ')' : '') + ' ▾</button>';
  html += '<div class="filter-dropdown-menu hidden">';
  html += '<input type="text" class="filter-dropdown-search" placeholder="' + t('Search...') + '">';
  html += '<div class="filter-dropdown-list">';
  values.forEach(function(v) {
    var checked = selected.indexOf(v) >= 0 ? ' checked' : '';
    var display = field === 'type' ? getTypeLabel(v) : (v === 'active' ? t('Active') : t('Offline'));
    html += '<label class="filter-dropdown-item"><input type="checkbox" value="' + v + '"' + checked + '> ' + display + '</label>';
  });
  html += '</div>';
  html += '<div class="filter-dropdown-actions">';
  html += '<button class="btn btn-sm filter-select-all">' + t('Select All') + '</button>';
  html += '<button class="btn btn-sm filter-clear">' + t('Clear') + '</button>';
  html += '<button class="btn btn-sm btn-primary filter-apply">' + t('Apply') + '</button>';
  html += '</div>';
  html += '</div></div>';
  return html;
}

function initFilterDropdowns() {
  document.querySelectorAll('.filter-dropdown').forEach(function(dd) {
    var field = dd.getAttribute('data-field');
    var btn = dd.querySelector('.filter-dropdown-btn');
    var menu = dd.querySelector('.filter-dropdown-menu');
    var search = dd.querySelector('.filter-dropdown-search');
    var list = dd.querySelector('.filter-dropdown-list');

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      document.querySelectorAll('.filter-dropdown-menu').forEach(function(m) { m.classList.add('hidden'); });
      menu.classList.toggle('hidden');
    });

    search.addEventListener('input', function() {
      var q = this.value.toLowerCase();
      list.querySelectorAll('.filter-dropdown-item').forEach(function(item) {
        item.style.display = item.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
      });
    });

    dd.querySelector('.filter-select-all').addEventListener('click', function() {
      list.querySelectorAll('input[type=checkbox]').forEach(function(cb) {
        if (cb.closest('.filter-dropdown-item').style.display !== 'none') cb.checked = true;
      });
    });

    dd.querySelector('.filter-clear').addEventListener('click', function() {
      list.querySelectorAll('input[type=checkbox]').forEach(function(cb) { cb.checked = false; });
      state.filterValues[field] = [];
      btn.classList.remove('has-filter');
      btn.textContent = (field === 'type' ? t('Type') : t('Status')) + ' ▾';
      menu.classList.add('hidden');
      render();
    });

    dd.querySelector('.filter-apply').addEventListener('click', function() {
      var vals = [];
      list.querySelectorAll('input[type=checkbox]:checked').forEach(function(cb) {
        vals.push(cb.value);
      });
      state.filterValues[field] = vals;
      if (vals.length > 0) {
        btn.classList.add('has-filter');
        btn.textContent = (field === 'type' ? t('Type') : t('Status')) + ' (' + vals.length + ') ▾';
      } else {
        btn.classList.remove('has-filter');
        btn.textContent = (field === 'type' ? t('Type') : t('Status')) + ' ▾';
      }
      menu.classList.add('hidden');
      render();
    });
  });

  // Close dropdowns on outside click
  document.addEventListener('click', function() {
    document.querySelectorAll('.filter-dropdown-menu').forEach(function(m) { m.classList.add('hidden'); });
  });
}

function initFilters() {
  var searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      render();
    });
  }
  rebuildFilters();
}

// ---- Sort ----
function initSort() {
  document.querySelectorAll('.iface-table th.sortable').forEach(function(th) {
    th.addEventListener('click', function() {
      var field = this.getAttribute('data-sort');
      if (state.sortField === field) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortField = field;
        state.sortDir = 'asc';
      }
      // Update UI
      document.querySelectorAll('.iface-table th').forEach(function(h) {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      this.classList.add('sort-' + state.sortDir);
      render();
    });
  });
}

// ---- Chart Tooltip ----
function initChartTooltip() {
  var tooltip = document.getElementById('chart-tooltip');
  if (!tooltip) return;
  var canvases = ['trend-chart', 'stats-chart', 'detail-chart', 'detail-realtime-chart'];
  canvases.forEach(function(id) {
    var canvas = document.getElementById(id);
    if (!canvas) return;
    canvas.addEventListener('mousemove', function(e) {
      // Simple tooltip showing time
      var rect = canvas.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var pad = { left: 60, right: 16 };
      var cw = rect.width - pad.left - pad.right;
      if (x < pad.left || x > rect.width - pad.right) {
        tooltip.style.display = 'none';
        return;
      }
      var pct = (x - pad.left) / cw;
      // Find the closest data point
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top = (e.clientY - 40) + 'px';
      tooltip.innerHTML = '<div class="tooltip-time">' + t('Time') + ': ' + Math.round(pct * 100) + '%</div>';
    });
    canvas.addEventListener('mouseleave', function() {
      tooltip.style.display = 'none';
    });
  });
}

// ---- Detail Modal ----
function mkRows(pairs) {
  return pairs.map(function(p) {
    return '<div class="detail-row"><span class="label">' + t(p[0]) + '</span><span class="value">' + p[1] + '</span></div>';
  }).join('');
}

function mkStatRow(label, value, isError) {
  var valClass = isError && value > 0 ? ' style="color:var(--accent-red);font-weight:700;"' : '';
  return '<div class="detail-row"><span class="label">' + t(label) + '</span><span class="value"' + valClass + '>' + value + '</span></div>';
}

function openDetail(name) {
  var iface = state.interfaces[name];
  if (!iface) return;
  state.detailName = name;
  var overlay = document.getElementById('detail-overlay');
  overlay.classList.add('visible');
  document.getElementById('detail-title').textContent = t('Interface Detail') + ' - ' + name;

  // Basic info
  document.getElementById('detail-info').innerHTML = mkRows([
    ['Interface Name', iface.name],
    ['Status', iface.state === 'up' ? t('Active') : t('Offline')],
    ['Type', getTypeLabel(iface.type)],
    ['MAC Address', iface.mac || '—'],
    ['IPv4 Address', iface.ipv4 || '—'],
    ['IPv6 Address', iface.ipv6 || '—'],
    ['Link Rate', iface.linkSpeed || '—']
  ]);

  // Traffic stats (merged with errors/dropped)
  document.getElementById('detail-stats').innerHTML =
    mkStatRow('Total TX Traffic', fmt(iface.txBytes)) +
    mkStatRow('Total RX Traffic', fmt(iface.rxBytes)) +
    mkStatRow('Total Traffic', fmt(iface.totalBytes)) +
    mkStatRow('Total Packets TX', iface.txPackets.toLocaleString()) +
    mkStatRow('Total Packets RX', iface.rxPackets.toLocaleString()) +
    mkStatRow('Current TX Speed', fmtS(iface.txSpeed)) +
    mkStatRow('Current RX Speed', fmtS(iface.rxSpeed)) +
    mkStatRow('TX Errors', iface.txErrors, true) +
    mkStatRow('RX Errors', iface.rxErrors, true) +
    mkStatRow('TX Dropped', iface.txDropped, true) +
    mkStatRow('RX Dropped', iface.rxDropped, true);

  // History buttons
  buildTimeButtons(document.getElementById('detail-history-btns'), state.detailRange, function(val) {
    state.detailRange = val;
    renderDetailCharts();
  });

  renderDetailCharts();

  // WiFi info
  if (iface.type === 'wireless' && iface.wifi) {
    document.getElementById('wifi-section').style.display = '';
    renderWifiInfo(iface);
  } else {
    document.getElementById('wifi-section').style.display = 'none';
    document.getElementById('wifi-nearby-section').style.display = 'none';
  }
}

function renderWifiInfo(iface) {
  if (!iface.wifi) return;
  var wifi = iface.wifi;
  document.getElementById('detail-wifi').innerHTML = mkRows([
    ['Network Name', wifi.ssid || '—'],
    ['Signal', wifi.signal !== null ? wifi.signal + ' dBm' : '—'],
    ['Wireless Rate', wifi.bitrate || '—'],
    ['Channel', wifi.channel || '—'],
    ['Band', wifi.freq ? (parseInt(wifi.freq, 10) > 5000 ? '5 GHz' : '2.4 GHz') : '—']
  ]);
}

function renderDetailCharts() {
  var iface = state.interfaces[state.detailName];
  if (!iface) return;
  // History chart
  var canvas = document.getElementById('detail-chart');
  var data = getChartData(iface, state.detailRange);
  drawLineChart(canvas, [
    { label: t('TX Speed'), data: data.tx, color: '#3370ff' },
    { label: t('RX Speed'), data: data.rx, color: '#34c724' }
  ], data.ts, { height: 220 });

  // Realtime chart
  var canvas2 = document.getElementById('detail-realtime-chart');
  if (canvas2) {
    var rtTs = [];
    var rtTx = iface.sparkTx.slice(-60);
    var rtRx = iface.sparkRx.slice(-60);
    var now = Date.now() / 1000;
    for (var i = 0; i < rtTx.length; i++) {
      rtTs.push(now - (rtTx.length - 1 - i) * 5);
    }
    drawLineChart(canvas2, [
      { label: t('TX Speed'), data: rtTx, color: '#3370ff' },
      { label: t('RX Speed'), data: rtRx, color: '#34c724' }
    ], rtTs, { height: 180 });
  }
}

// Close detail modal
document.addEventListener('DOMContentLoaded', function() {
  var detailClose = document.getElementById('detail-close');
  if (detailClose) {
    detailClose.addEventListener('click', function() {
      document.getElementById('detail-overlay').classList.remove('visible');
      state.detailName = null;
    });
  }
  var detailOverlay = document.getElementById('detail-overlay');
  if (detailOverlay) {
    detailOverlay.addEventListener('click', function(e) {
      if (e.target === detailOverlay) {
        detailOverlay.classList.remove('visible');
        state.detailName = null;
      }
    });
  }
});

// ---- Settings ----
function initSettings() {
  var settingsBtn = document.getElementById('btn-settings');
  var settingsOverlay = document.getElementById('settings-overlay');
  var settingsClose = document.getElementById('settings-close');
  var settingsApply = document.getElementById('settings-apply');

  if (settingsBtn) {
    settingsBtn.addEventListener('click', function() {
      settingsOverlay.classList.add('visible');
      loadSettingsUI();
    });
  }
  if (settingsClose) {
    settingsClose.addEventListener('click', function() {
      settingsOverlay.classList.remove('visible');
    });
  }
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', function(e) {
      if (e.target === settingsOverlay) settingsOverlay.classList.remove('visible');
    });
  }
  if (settingsApply) {
    settingsApply.addEventListener('click', function() {
      saveSettings();
      settingsOverlay.classList.remove('visible');
    });
  }

  // Interval selector
  var intervalSelect = document.getElementById('setting-interval');
  if (intervalSelect) {
    var html = '';
    INTERVAL_OPTIONS.forEach(function(opt) {
      var sel = opt.value === state.interval ? ' selected' : '';
      html += '<option value="' + opt.value + '"' + sel + '>' + opt.label() + '</option>';
    });
    intervalSelect.innerHTML = html;
  }
}

function loadSettingsUI() {
  var intervalSelect = document.getElementById('setting-interval');
  if (intervalSelect) intervalSelect.value = state.interval;
  var unitSelect = document.getElementById('setting-unit');
  if (unitSelect) unitSelect.value = state.unit;
  var thresholdInput = document.getElementById('setting-threshold');
  if (thresholdInput) thresholdInput.value = state.threshold;
  buildTypeToggles();
}

function buildTypeToggles() {
  var container = document.getElementById('setting-types');
  if (!container) return;
  var types = Object.keys(typeLabels);
  var html = '';
  types.forEach(function(type) {
    var active = !state.activeTypes || state.activeTypes.indexOf(type) >= 0;
    html += '<span class="type-toggle' + (active ? ' active' : '') + '" data-type="' + type + '">' + getTypeLabel(type) + '</span>';
  });
  container.innerHTML = html;
  container.querySelectorAll('.type-toggle').forEach(function(toggle) {
    toggle.addEventListener('click', function() {
      this.classList.toggle('active');
    });
  });
}

function saveSettings() {
  var intervalSelect = document.getElementById('setting-interval');
  if (intervalSelect) {
    state.interval = parseInt(intervalSelect.value, 10) || 5000;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchData, state.interval > 0 ? state.interval : 5000);
  }
  var unitSelect = document.getElementById('setting-unit');
  if (unitSelect) state.unit = unitSelect.value;
  var thresholdInput = document.getElementById('setting-threshold');
  if (thresholdInput) state.threshold = parseFloat(thresholdInput.value) || 100;
  // Type toggles
  var activeTypes = [];
  document.querySelectorAll('#setting-types .type-toggle.active').forEach(function(el) {
    activeTypes.push(el.getAttribute('data-type'));
  });
  state.activeTypes = activeTypes.length === Object.keys(typeLabels).length ? null : activeTypes;
  render();
  rebuildFilters();
}

// ---- Refresh Button ----
function initRefresh() {
  var btn = document.getElementById('btn-refresh');
  if (btn) {
    btn.addEventListener('click', function() {
      fetchData();
    });
  }
}

// ---- Polling ----
var pollTimer = null;

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  var interval = state.interval > 0 ? state.interval : 5000;
  pollTimer = setInterval(fetchData, interval);
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', function() {
  // Apply i18n to static HTML elements
  applyLang();

  // Initialize components
  initTimeButtons();
  initFilters();
  initSort();
  initChartTooltip();
  initSettings();
  initRefresh();

  // Check vnstat
  checkVnstat();

  // Initial fetch
  fetchData();

  // Start polling
  startPolling();
});
