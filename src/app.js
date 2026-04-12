/* ========================================
   Cockpit Traffic Monitor - App v9
   i18n, vnstat monthly, merged error stats
   ======================================== */
(function () {
  'use strict';

  // ---- i18n (cockpit.gettext) ----
  function loadLang(lang) {
    if (typeof cockpit !== 'undefined') {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'lang/' + lang + '.json', false);
        xhr.send(null);
        if (xhr.status === 200) { cockpit.locale(JSON.parse(xhr.responseText)); }
      } catch(e) {}
    }
  }
  function t(key) { return (typeof cockpit !== 'undefined') ? cockpit.gettext(key) : key; }
  function applyLang() {
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) { els[i].textContent = t(els[i].getAttribute('data-i18n')); }
    var phs = document.querySelectorAll('[data-i18n-placeholder]');
    for (var j = 0; j < phs.length; j++) { phs[j].placeholder = t(phs[j].getAttribute('data-i18n-placeholder')); }
  }
  function detectLang() {
    if (typeof cockpit !== 'undefined' && cockpit.language) return cockpit.language.replace('-', '_');
    var nav = navigator.language || '';
    if (nav.toLowerCase().indexOf('zh') === 0) return 'zh_CN';
    return 'en';
  }

  // ---- State ----
  var state = {
    interfaces: [],
    linkSpeeds: {},
    macAddresses: {},
    ipAddresses: {},
    ipv6Addresses: {},
    history: {},
    lastActive: {},
    settings: { interval: 1000, showLoopback: false, showBond: true, showVlan: true, showBridge: true, showFirewall: true, showTap: true, showVeth: true, showVirtual: true, threshold: 100, unit: 'auto' },
    searchQuery: '',
    sortField: 'totalBytes',
    sortDir: 'desc',
    timeRange: 300,
    detailTimeRange: 3600,
    refreshTimer: null,
    selectedInterface: null,
    filters: { status: new Set(), name: new Set(), type: new Set() },
    openFilter: null,
    mousePos: null,
    chartRect: null,
    chartDatasets: null,
    chartPad: null,
    detailChartDatasets: null,
    detailSpeedDatasets: null,
    detailMousePos: null,
    detailSpeedMousePos: null,
    wifiScan: [],
  };

  var TIME_SPANS = [
    { label: function() { return t('1分钟'); }, seconds: 60 },
    { label: function() { return t('5分钟'); }, seconds: 300 },
    { label: function() { return t('30分钟'); }, seconds: 1800 },
    { label: function() { return t('1小时'); }, seconds: 3600 },
    { label: function() { return t('6小时'); }, seconds: 21600 },
    { label: function() { return t('12小时'); }, seconds: 43200 },
    { label: function() { return t('24小时'); }, seconds: 86400 },
    { label: function() { return t('3天'); }, seconds: 259200 },
    { label: function() { return t('7天'); }, seconds: 604800 },
  ];

  function tierForRange(sec) {
    if (sec <= 300) return 'raw';
    if (sec <= 43200) return 'minute';
    if (sec <= 259200) return 'hourly';
    if (sec <= 604800) return 'daily';
    return 'monthly';
  }

  // ---- Utilities ----
  function fmt(bytes, dec) {
    if (bytes === 0) return '0 B';
    dec = dec ?? 1;
    var unit = state.settings.unit;
    if (unit !== 'auto') {
      var u = +unit;
      var labels = { 1: 'B', 1024: 'KB', 1048576: 'MB' };
      return parseFloat((bytes / u).toFixed(dec)) + ' ' + (labels[u] || 'B');
    }
    var k = 1024, s = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dec)) + ' ' + s[Math.min(i, s.length - 1)];
  }
  function fmtS(bps) { return fmt(bps) + '/s'; }
  function fmtSpeed(speedMbps) {
    if (!speedMbps || speedMbps <= 0) return '-';
    if (speedMbps >= 1000) return (speedMbps / 1000).toFixed(1) + ' Gbps';
    return speedMbps + ' Mbps';
  }
  function ifaceType(n) {
    if (n === 'lo') return 'loopback';
    if (/^[^.]+\.\d+$/.test(n) && !/^veth|^tap|^fw|^docker|^br-|^virbr/.test(n)) return 'vlan';
    if (/^bond\d/.test(n)) return 'bond';
    if (/^(vmbr|br-|virbr)/.test(n)) return 'bridge';
    if (/^(fwpr|fwn|fwln|fwbr|fwp|fwt)/.test(n)) return 'firewall';
    if (/^(tap|tun)/.test(n)) return 'tap';
    if (/^veth/.test(n)) return 'veth';
    if (/^(docker|wg|ppp)/.test(n)) return 'virtual';
    if (/^(wlan|wlp|wls|wlo|wlx)/.test(n)) return 'wireless';
    if (/^(eth|enp|eno|ens|enx)/.test(n)) return 'ethernet';
    return 'ethernet';
  }
  var typeLabels = {
    ethernet: function() { return t('物理网卡'); },
    bond: function() { return t('绑定接口'); },
    vlan: function() { return t('VLAN 子接口'); },
    bridge: function() { return t('网桥'); },
    wireless: function() { return t('无线'); },
    firewall: function() { return t('防火墙接口'); },
    tap: function() { return t('TAP 接口'); },
    veth: function() { return t('虚拟以太网'); },
    virtual: function() { return t('虚拟接口'); },
    loopback: function() { return t('回环'); },
  };
  function getTypeLabel(type) { return (typeLabels[type] || function() { return type; })(); }

  // ---- Tiered History ----
  function ensureHistory(name) {
    if (!state.history[name]) {
      state.history[name] = {
        raw: { ts: [], txSpeed: [], rxSpeed: [] },
        minute: { ts: [], txBytes: [], rxBytes: [], txSpeed: [], rxSpeed: [] },
        hourly: { ts: [], txBytes: [], rxBytes: [], txSpeed: [], rxSpeed: [] },
        daily: { ts: [], txBytes: [], rxBytes: [], txSpeed: [], rxSpeed: [] },
        monthly: { ts: [], txBytes: [], rxBytes: [], txSpeed: [], rxSpeed: [] },
        _lastMinuteBucket: null, _lastHourlyBucket: null, _lastDailyBucket: null, _lastMonthlyBucket: null,
        _minuteAcc: { txBytes: 0, rxBytes: 0, txSpeed: [], rxSpeed: [], count: 0 },
      };
    }
    return state.history[name];
  }

  function pushRaw(h, now, txSpeed, rxSpeed) {
    h.raw.ts.push(now); h.raw.txSpeed.push(txSpeed); h.raw.rxSpeed.push(rxSpeed);
    var cutoff = now - 120000;
    while (h.raw.ts.length > 0 && h.raw.ts[0] < cutoff) {
      h.raw.ts.shift(); h.raw.txSpeed.shift(); h.raw.rxSpeed.shift();
    }
  }

  function rollupMinute(h, now, txBytes, rxBytes, txSpeed, rxSpeed) {
    var minuteKey = Math.floor(now / 60000);
    if (h._lastMinuteBucket === null) {
      h._lastMinuteBucket = minuteKey;
      h._minuteAcc = { txBytes: txBytes, rxBytes: rxBytes, txSpeed: [txSpeed], rxSpeed: [rxSpeed], count: 1 };
      return;
    }
    if (minuteKey === h._lastMinuteBucket) {
      h._minuteAcc.txBytes = txBytes; h._minuteAcc.rxBytes = rxBytes;
      h._minuteAcc.txSpeed.push(txSpeed); h._minuteAcc.rxSpeed.push(rxSpeed); h._minuteAcc.count++;
      return;
    }
    var avgTx = h._minuteAcc.txSpeed.reduce(function (a, b) { return a + b; }, 0) / h._minuteAcc.count;
    var avgRx = h._minuteAcc.rxSpeed.reduce(function (a, b) { return a + b; }, 0) / h._minuteAcc.count;
    h.minute.ts.push(h._lastMinuteBucket * 60000);
    h.minute.txBytes.push(h._minuteAcc.txBytes); h.minute.rxBytes.push(h._minuteAcc.rxBytes);
    h.minute.txSpeed.push(avgTx); h.minute.rxSpeed.push(avgRx);
    var cutoff = now - 90000000;
    while (h.minute.ts.length > 0 && h.minute.ts[0] < cutoff) {
      h.minute.ts.shift(); h.minute.txBytes.shift(); h.minute.rxBytes.shift();
      h.minute.txSpeed.shift(); h.minute.rxSpeed.shift();
    }
    rollupHourly(h, now);
    h._lastMinuteBucket = minuteKey;
    h._minuteAcc = { txBytes: txBytes, rxBytes: rxBytes, txSpeed: [txSpeed], rxSpeed: [rxSpeed], count: 1 };
  }

  function rollupHourly(h, now) {
    if (h.minute.ts.length === 0) return;
    var lastMinTs = h.minute.ts[h.minute.ts.length - 1];
    var hourKey = Math.floor(lastMinTs / 3600000);
    if (h._lastHourlyBucket !== null && hourKey === h._lastHourlyBucket) return;
    var hourCutoff = hourKey * 3600000, hourEnd = hourCutoff + 3600000;
    var txSpd = [], rxSpd = [], txB = 0, rxB = 0;
    for (var i = 0; i < h.minute.ts.length; i++) {
      if (h.minute.ts[i] >= hourCutoff && h.minute.ts[i] < hourEnd) {
        txSpd.push(h.minute.txSpeed[i]); rxSpd.push(h.minute.rxSpeed[i]);
        txB = h.minute.txBytes[i]; rxB = h.minute.rxBytes[i];
      }
    }
    if (txSpd.length > 0) {
      h.hourly.ts.push(hourCutoff);
      h.hourly.txBytes.push(txB); h.hourly.rxBytes.push(rxB);
      h.hourly.txSpeed.push(txSpd.reduce(function (a, b) { return a + b; }, 0) / txSpd.length);
      h.hourly.rxSpeed.push(rxSpd.reduce(function (a, b) { return a + b; }, 0) / rxSpd.length);
      var cutoff = now - 691200000;
      while (h.hourly.ts.length > 0 && h.hourly.ts[0] < cutoff) {
        h.hourly.ts.shift(); h.hourly.txBytes.shift(); h.hourly.rxBytes.shift();
        h.hourly.txSpeed.shift(); h.hourly.rxSpeed.shift();
      }
      rollupDaily(h, now);
    }
    h._lastHourlyBucket = hourKey;
  }

  function rollupDaily(h, now) {
    if (h.hourly.ts.length === 0) return;
    var lastHourTs = h.hourly.ts[h.hourly.ts.length - 1];
    var dayKey = Math.floor(lastHourTs / 86400000);
    if (h._lastDailyBucket !== null && dayKey === h._lastDailyBucket) return;
    var dayCutoff = dayKey * 86400000, dayEnd = dayCutoff + 86400000;
    var txSpd = [], rxSpd = [], txB = 0, rxB = 0;
    for (var i = 0; i < h.hourly.ts.length; i++) {
      if (h.hourly.ts[i] >= dayCutoff && h.hourly.ts[i] < dayEnd) {
        txSpd.push(h.hourly.txSpeed[i]); rxSpd.push(h.hourly.rxSpeed[i]);
        txB = h.hourly.txBytes[i]; rxB = h.hourly.rxBytes[i];
      }
    }
    if (txSpd.length > 0) {
      h.daily.ts.push(dayCutoff);
      h.daily.txBytes.push(txB); h.daily.rxBytes.push(rxB);
      h.daily.txSpeed.push(txSpd.reduce(function (a, b) { return a + b; }, 0) / txSpd.length);
      h.daily.rxSpeed.push(rxSpd.reduce(function (a, b) { return a + b; }, 0) / rxSpd.length);
      var cutoff = now - 7776000000;
      while (h.daily.ts.length > 0 && h.daily.ts[0] < cutoff) {
        h.daily.ts.shift(); h.daily.txBytes.shift(); h.daily.rxBytes.shift();
        h.daily.txSpeed.shift(); h.daily.rxSpeed.shift();
      }
      rollupMonthly(h, now);
    }
    h._lastDailyBucket = dayKey;
  }

  function rollupMonthly(h, now) {
    if (h.daily.ts.length === 0) return;
    var lastDayTs = h.daily.ts[h.daily.ts.length - 1];
    var monthKey = new Date(lastDayTs).getFullYear() * 12 + new Date(lastDayTs).getMonth();
    if (h._lastMonthlyBucket !== null && monthKey === h._lastMonthlyBucket) return;
    var monthStart = new Date(Math.floor(monthKey / 12), monthKey % 12, 1).getTime();
    var monthEnd = new Date(Math.floor(monthKey / 12), monthKey % 12 + 1, 1).getTime();
    var txSpd = [], rxSpd = [], txB = 0, rxB = 0;
    for (var i = 0; i < h.daily.ts.length; i++) {
      if (h.daily.ts[i] >= monthStart && h.daily.ts[i] < monthEnd) {
        txSpd.push(h.daily.txSpeed[i]); rxSpd.push(h.daily.rxSpeed[i]);
        txB += h.daily.txBytes[i]; rxB += h.daily.rxBytes[i];
      }
    }
    if (txSpd.length > 0) {
      h.monthly.ts.push(monthStart);
      h.monthly.txBytes.push(txB); h.monthly.rxBytes.push(rxB);
      h.monthly.txSpeed.push(txSpd.reduce(function (a, b) { return a + b; }, 0) / txSpd.length);
      h.monthly.rxSpeed.push(rxSpd.reduce(function (a, b) { return a + b; }, 0) / rxSpd.length);
      var cutoff = now - 31536000000;
      while (h.monthly.ts.length > 0 && h.monthly.ts[0] < cutoff) {
        h.monthly.ts.shift(); h.monthly.txBytes.shift(); h.monthly.rxBytes.shift();
        h.monthly.txSpeed.shift(); h.monthly.rxSpeed.shift();
      }
    }
    h._lastMonthlyBucket = monthKey;
  }

  function getChartData(ifaceName, seconds) {
    var h = state.history[ifaceName];
    if (!h) return { tx: [], rx: [] };
    var cutoff = Date.now() - seconds * 1000;
    var tier = h[tierForRange(seconds)] || h.raw;
    var txData = [], rxData = [];
    for (var i = 0; i < tier.ts.length; i++) {
      if (tier.ts[i] >= cutoff) {
        txData.push({ x: tier.ts[i], y: tier.txSpeed[i] || 0 });
        rxData.push({ x: tier.ts[i], y: tier.rxSpeed[i] || 0 });
      }
    }
    return { tx: txData, rx: rxData };
  }

  function getSparkData(ifaceName) {
    var h = state.history[ifaceName];
    if (!h || h.raw.ts.length < 2) return [];
    var cutoff = Date.now() - 60000, spd = [];
    for (var i = 0; i < h.raw.ts.length; i++) {
      if (h.raw.ts[i] >= cutoff) spd.push(h.raw.txSpeed[i] + h.raw.rxSpeed[i]);
    }
    return spd;
  }

  // ---- vnstat Backend ----
  var vnstatAvailable = false;

  function loadVnstatData() {
    if (typeof cockpit === 'undefined') return;
    cockpit.spawn(['which', 'vnstat'], { err: 'ignore' })
      .then(function () {
        vnstatAvailable = true;
        cockpit.spawn(['vnstat', '--json', 'h'], { err: 'ignore' })
          .then(function (out) { try { ingestVnstatJson(JSON.parse(out), 'hourly'); } catch(e) {} })
          .catch(function () {});
        cockpit.spawn(['vnstat', '--json', 'd'], { err: 'ignore' })
          .then(function (out) { try { ingestVnstatJson(JSON.parse(out), 'daily'); } catch(e) {} })
          .catch(function () {});
        cockpit.spawn(['vnstat', '--json', 'm'], { err: 'ignore' })
          .then(function (out) { try { ingestVnstatJson(JSON.parse(out), 'monthly'); } catch(e) {} })
          .catch(function () {});
      })
      .catch(function () { vnstatAvailable = false; });
  }

  function ingestVnstatJson(data, tierName) {
    if (!data || !data.interfaces) return;
    var now = Date.now();
    for (var ii = 0; ii < data.interfaces.length; ii++) {
      var iface = data.interfaces[ii];
      var name = iface.name || iface.interface || '';
      if (!name) continue;
      var traffic = (iface.traffic && iface.traffic[tierName]) || [];
      if (traffic.length === 0) continue;
      var h = ensureHistory(name);
      var tier = h[tierName];
      tier.ts.length = 0;
      if (tierName === 'hourly') {
        tier.txSpeed.length = 0; tier.rxSpeed.length = 0;
        tier.txBytes.length = 0; tier.rxBytes.length = 0;
        for (var i = 0; i < traffic.length; i++) {
          var rec = traffic[i];
          var ts;
          if (rec.date) {
            var t = rec.time || {};
            ts = new Date(rec.date.year, rec.date.month - 1, rec.date.day, t.hour || 0).getTime();
          } else { continue; }
          if (ts < now - 86400000) continue;
          var txB = rec.tx || 0, rxB = rec.rx || 0;
          tier.ts.push(ts);
          tier.txBytes.push(txB); tier.rxBytes.push(rxB);
          tier.txSpeed.push(txB / 3600);
          tier.rxSpeed.push(rxB / 3600);
        }
      } else if (tierName === 'daily') {
        tier.txSpeed.length = 0; tier.rxSpeed.length = 0;
        tier.txBytes.length = 0; tier.rxBytes.length = 0;
        for (var j = 0; j < traffic.length; j++) {
          var drec = traffic[j];
          var dts;
          if (drec.date) {
            dts = new Date(drec.date.year, drec.date.month - 1, drec.date.day).getTime();
          } else { continue; }
          if (dts < now - 604800000) continue;
          var dtxB = drec.tx || 0, drxB = drec.rx || 0;
          tier.ts.push(dts);
          tier.txBytes.push(dtxB); tier.rxBytes.push(drxB);
          tier.txSpeed.push(dtxB / 86400);
          tier.rxSpeed.push(drxB / 86400);
        }
      } else if (tierName === 'monthly') {
        tier.txSpeed.length = 0; tier.rxSpeed.length = 0;
        tier.txBytes.length = 0; tier.rxBytes.length = 0;
        for (var m = 0; m < traffic.length; m++) {
          var mrec = traffic[m];
          var mts;
          if (mrec.date) {
            mts = new Date(mrec.date.year, mrec.date.month - 1, 1).getTime();
          } else { continue; }
          if (mts < now - 31536000000) continue;
          var mtxB = mrec.tx || 0, mrxB = mrec.rx || 0;
          tier.ts.push(mts);
          tier.txBytes.push(mtxB); tier.rxBytes.push(mrxB);
          tier.txSpeed.push(mtxB / 2592000);
          tier.rxSpeed.push(mrxB / 2592000);
        }
      }
    }
    if (state.chartDatasets) renderChart();
  }

  // ---- Data Collection ----
  function parseNetDev(content) {
    var lines = content.trim().split('\n'), out = [];
    for (var i = 2; i < lines.length; i++) {
      var p = lines[i].trim().split(/\s+/);
      if (p.length < 16) continue;
      out.push({
        name: p[0].replace(':', ''),
        rxBytes: +p[1] || 0, rxPackets: +p[2] || 0, rxErrors: +p[3] || 0, rxDropped: +p[4] || 0,
        txBytes: +p[9] || 0, txPackets: +p[10] || 0, txErrors: +p[11] || 0, txDropped: +p[12] || 0,
      });
    }
    return out;
  }

  function fetchIfaceInfo(names) {
    if (typeof cockpit === 'undefined') {
      for (var n = 0; n < names.length; n++) {
        var nm = names[n];
        if (!state.linkSpeeds[nm]) state.linkSpeeds[nm] = [0, 100, 1000, 2500, 10000][Math.floor(Math.random() * 5)];
        if (!state.macAddresses[nm]) state.macAddresses[nm] = '00:' + Array.from({length:5}, function() { return Math.floor(Math.random()*256).toString(16).padStart(2,'0'); }).join(':');
        if (!state.ipAddresses[nm]) state.ipAddresses[nm] = nm === 'lo' ? '127.0.0.1/8' : '192.168.' + Math.floor(Math.random()*255) + '.' + Math.floor(Math.random()*255) + '/24';
        if (!state.ipv6Addresses[nm]) state.ipv6Addresses[nm] = nm === 'lo' ? '::1/128' : 'fe80::' + Array.from({length:4}, function() { return Math.floor(Math.random()*65536).toString(16); }).join(':') + '/64';
      }
      return;
    }
    for (var ni = 0; ni < names.length; ni++) {
      (function (name) {
        if (!state.macAddresses[name]) {
          cockpit.file('/sys/class/net/' + name + '/address').read()
            .then(function (val) { state.macAddresses[name] = (val || '').trim(); })
            .catch(function () { state.macAddresses[name] = '-'; });
        }
        if (!state.linkSpeeds[name] || state.linkSpeeds[name] <= 0) {
          cockpit.file('/sys/class/net/' + name + '/speed').read()
            .then(function (val) { state.linkSpeeds[name] = parseInt(val) || 0; })
            .catch(function () { state.linkSpeeds[name] = 0; });
        }
      })(names[ni]);
    }
    if (typeof cockpit !== 'undefined') {
      cockpit.spawn(['ip', '-4', '-o', 'addr', 'show'], { err: 'ignore' })
        .then(function (output) {
          var lines = output.trim().split('\n');
          for (var i = 0; i < lines.length; i++) {
            var m = lines[i].match(/^\d+:\s+(\S+)\s+inet\s+([\d.\/]+)/);
            if (m) state.ipAddresses[m[1]] = m[2];
          }
        }).catch(function () {});
      cockpit.spawn(['ip', '-6', '-o', 'addr', 'show'], { err: 'ignore' })
        .then(function (output) {
          var lines = output.trim().split('\n');
          for (var i = 0; i < lines.length; i++) {
            var m = lines[i].match(/^\d+:\s+(\S+)\s+inet6\s+([a-f0-9:\/]+)/);
            if (m) {
              var addr = m[2];
              if (addr.indexOf('fe80') === 0) {
                if (!state.ipv6Addresses[m[1]] || state.ipv6Addresses[m[1]] === '-') state.ipv6Addresses[m[1]] = addr;
              } else {
                state.ipv6Addresses[m[1]] = addr;
              }
            }
          }
        }).catch(function () {});
      cockpit.spawn(['nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,CHAN,FREQ,BARS,SECURITY,MODE', 'device', 'wifi', 'list'], { err: 'ignore' })
        .then(function (output) {
          var lines = output.trim().split('\n');
          var scanList = [];
          for (var i = 0; i < lines.length; i++) {
            var parts = lines[i].split(':');
            if (parts.length >= 7) {
              var inUse = parts[0] === '*';
              var ssid = parts[1];
              var signal = parseInt(parts[2]) || 0;
              var chan = parseInt(parts[3]) || 0;
              var freq = parts[4] || '';
              var bars = parts[5] || '';
              var security = parts[6] || '';
              var mode = parts[7] || '';
              var freqNum = parseInt(freq) || 0;
              var band = freqNum >= 5000 ? '5 GHz' : (freqNum >= 2400 ? '2.4 GHz' : '');
              if (ssid && ssid.length > 0) {
                scanList.push({ inUse: inUse, ssid: ssid, signal: signal, chan: chan, freq: freq, bars: bars, security: security, band: band, mode: mode });
              }
              if (inUse) {
                if (!state.wifiInfo) state.wifiInfo = {};
                for (var di = 0; di < names.length; di++) {
                  if (ifaceType(names[di]) === 'wireless') {
                    if (!state.wifiInfo[names[di]]) state.wifiInfo[names[di]] = {};
                    state.wifiInfo[names[di]].ssid = ssid;
                    state.wifiInfo[names[di]].signal = signal;
                    state.wifiInfo[names[di]].bars = bars;
                    state.wifiInfo[names[di]].rate = state.wifiInfo[names[di]].rate || 0;
                    state.wifiInfo[names[di]].chan = chan;
                    state.wifiInfo[names[di]].band = band;
                    state.wifiInfo[names[di]].security = security;
                    break;
                  }
                }
              }
            }
          }
          state.wifiScan = scanList;
        }).catch(function () {});
      for (var wi = 0; wi < names.length; wi++) {
        (function (ifaceName) {
          if (ifaceType(ifaceName) === 'wireless') {
            cockpit.spawn(['iw', 'dev', ifaceName, 'link'], { err: 'ignore' })
              .then(function (output) {
                if (!state.wifiInfo) state.wifiInfo = {};
                if (!state.wifiInfo[ifaceName]) state.wifiInfo[ifaceName] = {};
                var rxMatch = output.match(/rx bitrate:\s*([\d.]+)\s*(\w+)/);
                var txMatch = output.match(/tx bitrate:\s*([\d.]+)\s*(\w+)/);
                var sigMatch = output.match(/signal:\s*(-?\d+)\s*dBm/);
                if (rxMatch) state.wifiInfo[ifaceName].rxRate = parseFloat(rxMatch[1]) + ' ' + rxMatch[2];
                if (txMatch) state.wifiInfo[ifaceName].txRate = parseFloat(txMatch[1]) + ' ' + txMatch[2];
                if (sigMatch) state.wifiInfo[ifaceName].signal = Math.max(0, 100 + parseInt(sigMatch[1]));
              }).catch(function () {});
          }
        })(names[wi]);
      }
    }
  }

  function updateState(newIfaces) {
    var now = Date.now();
    for (var i = 0; i < newIfaces.length; i++) {
      var iface = newIfaces[i];
      iface.type = ifaceType(iface.name);
      iface.totalBytes = iface.rxBytes + iface.txBytes;
      iface.linkSpeed = state.linkSpeeds[iface.name] || 0;
      iface.mac = state.macAddresses[iface.name] || '-';
      iface.ip = state.ipAddresses[iface.name] || '-';
      iface.ipv6 = state.ipv6Addresses[iface.name] || '-';
      var prev = state.interfaces.find(function (p) { return p.name === iface.name; });
      if (prev) {
        var dt = (now - (prev._ts || now)) / 1000;
        iface.rxSpeed = dt > 0 ? Math.max(0, (iface.rxBytes - prev.rxBytes) / dt) : (prev.rxSpeed || 0);
        iface.txSpeed = dt > 0 ? Math.max(0, (iface.txBytes - prev.txBytes) / dt) : (prev.txSpeed || 0);
      } else {
        iface.rxSpeed = 0; iface.txSpeed = 0;
      }
      iface._ts = now;
      iface.speed = iface.rxSpeed + iface.txSpeed;
      if (iface.speed > 0) {
        state.lastActive[iface.name] = now;
      }
      if (!state.lastActive[iface.name] && iface.ip && iface.ip !== '-' && iface.type !== 'loopback') {
        state.lastActive[iface.name] = now;
      }
      iface.up = (now - (state.lastActive[iface.name] || 0)) < 30000;
      if (iface.type === 'wireless' && state.wifiInfo && state.wifiInfo[iface.name]) {
        iface.wifi = state.wifiInfo[iface.name];
      }
      var h = ensureHistory(iface.name);
      pushRaw(h, now, iface.txSpeed, iface.rxSpeed);
      rollupMinute(h, now, iface.txBytes, iface.rxBytes, iface.txSpeed, iface.rxSpeed);
    }
    state.interfaces = newIfaces;
  }

  function fetchData() {
    if (typeof cockpit !== 'undefined') {
      cockpit.file('/proc/net/dev').read().then(function (c) {
        var ifaces = parseNetDev(c);
        fetchIfaceInfo(ifaces.map(function (i) { return i.name; }));
        updateState(ifaces);
        render();
      }).catch(function (e) { console.error('read /proc/net/dev:', e); });
    } else {
      demoData();
    }
  }

  function demoData() {
    var names = ['eth0', 'eth1', 'wlan0', 'docker0', 'lo', 'veth1a2b3c', 'br-bridge', 'wg0'];
    fetchIfaceInfo(names);
    var ifaces = names.map(function (name) {
      var prev = state.interfaces.find(function (p) { return p.name === name; }) || {};
      var rxB = prev.rxBytes || Math.random() * 1e10;
      var txB = prev.txBytes || Math.random() * 5e9;
      return {
        name: name,
        rxBytes: rxB + Math.random() * 2e6, txBytes: txB + Math.random() * 1e6,
        rxPackets: Math.floor(rxB / 1400), txPackets: Math.floor(txB / 1400),
        rxErrors: Math.floor(Math.random() * 3), txErrors: Math.floor(Math.random() * 2),
        rxDropped: Math.floor(Math.random() * 5), txDropped: Math.floor(Math.random() * 3),
      };
    });
    updateState(ifaces);
    render();
  }

  // ---- Filter / Sort ----
  function getFiltered() {
    var list = state.interfaces.slice();
    if (!state.settings.showLoopback) list = list.filter(function (i) { return i.type !== 'loopback'; });
    if (!state.settings.showBond) list = list.filter(function (i) { return i.type !== 'bond'; });
    if (!state.settings.showVlan) list = list.filter(function (i) { return i.type !== 'vlan'; });
    if (!state.settings.showBridge) list = list.filter(function (i) { return i.type !== 'bridge'; });
    if (!state.settings.showFirewall) list = list.filter(function (i) { return i.type !== 'firewall'; });
    if (!state.settings.showTap) list = list.filter(function (i) { return i.type !== 'tap'; });
    if (!state.settings.showVeth) list = list.filter(function (i) { return i.type !== 'veth'; });
    if (!state.settings.showVirtual) list = list.filter(function (i) { return i.type !== 'virtual'; });
    if (state.searchQuery) {
      var q = state.searchQuery.toLowerCase();
      list = list.filter(function (i) { return i.name.toLowerCase().indexOf(q) !== -1; });
    }
    if (state.filters.status.size > 0) list = list.filter(function (i) { return state.filters.status.has(i.up ? t('活跃') : t('离线')); });
    if (state.filters.name.size > 0) list = list.filter(function (i) { return state.filters.name.has(i.name); });
    if (state.filters.type.size > 0) list = list.filter(function (i) { return state.filters.type.has(getTypeLabel(i.type)); });
    var f = state.sortField, d = state.sortDir === 'desc' ? -1 : 1;
    list.sort(function (a, b) {
      var va = a[f], vb = b[f];
      if (f === 'linkSpeed') { va = va || 0; vb = vb || 0; }
      if (typeof va === 'string') return d * va.localeCompare(vb);
      return d * (va - vb);
    });
    return list;
  }

  // ---- Canvas Charts with Tooltip ----
  function drawLineChart(canvas, datasets, opts) {
    opts = opts || {};
    var parent = canvas.parentElement;
    if (!parent || parent.offsetWidth === 0 || parent.offsetHeight === 0) return null;

    var dpr = window.devicePixelRatio || 1;
    var w = parent.offsetWidth, h = parent.offsetHeight;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    canvas.width = w * dpr; canvas.height = h * dpr;
    var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    var pad = { t: 12, r: 16, b: 32, l: 64 };
    var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    if (cw < 20 || ch < 20) return null;

    var allY = [], allX = [];
    for (var di = 0; di < datasets.length; di++) {
      var ds = datasets[di];
      for (var pi = 0; pi < ds.data.length; pi++) { allY.push(ds.data[pi].y); allX.push(ds.data[pi].x); }
    }
    if (allX.length < 2) {
      ctx.fillStyle = '#6e7681'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(t('等待数据...'), w / 2, h / 2);
      return null;
    }

    var minX = allX[0], maxX = allX[allX.length - 1];
    var maxY = Math.max.apply(null, allY) * 1.15 || 1;
    var rangeX = maxX - minX || 1;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(120,130,140,0.4)'; ctx.lineWidth = 0.5; ctx.font = '10px sans-serif';
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.t + ch - (gi / 4) * ch;
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + cw, gy); ctx.stroke();
      ctx.fillStyle = '#8b949e'; ctx.textAlign = 'right';
      ctx.fillText(fmtS((gi / 4) * maxY), pad.l - 6, gy + 3);
    }
    var xTicks = Math.min(6, Math.floor(cw / 90));
    ctx.textAlign = 'center';
    for (var xi = 0; xi <= xTicks; xi++) {
      var xv = minX + (xi / xTicks) * rangeX;
      var xx = pad.l + (xi / xTicks) * cw;
      var dt = new Date(xv), ts;
      if (rangeX > 86400000 * 2) {
        ts = (dt.getMonth()+1) + '/' + dt.getDate() + ' ' + dt.getHours().toString().padStart(2,'0') + ':00';
      } else if (rangeX > 3600000 * 6) {
        ts = (dt.getMonth()+1) + '/' + dt.getDate() + ' ' + dt.getHours().toString().padStart(2,'0') + ':00';
      } else {
        ts = dt.getHours().toString().padStart(2,'0') + ':' + dt.getMinutes().toString().padStart(2,'0') + ':' + dt.getSeconds().toString().padStart(2,'0');
      }
      ctx.fillStyle = '#8b949e'; ctx.fillText(ts, xx, h - 6);
    }
    for (var dsi = 0; dsi < datasets.length; dsi++) {
      var ds2 = datasets[dsi];
      if (ds2.data.length < 2) continue;
      ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t, cw, ch); ctx.clip();
      ctx.strokeStyle = ds2.color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (var pj = 0; pj < ds2.data.length; pj++) {
        var px = pad.l + ((ds2.data[pj].x - minX) / rangeX) * cw;
        var py = pad.t + ch - (ds2.data[pj].y / maxY) * ch;
        pj === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
      var lastX = pad.l + ((ds2.data[ds2.data.length-1].x - minX) / rangeX) * cw;
      var firstX = pad.l + ((ds2.data[0].x - minX) / rangeX) * cw;
      ctx.lineTo(lastX, pad.t + ch); ctx.lineTo(firstX, pad.t + ch); ctx.closePath();
      ctx.fillStyle = ds2.fill; ctx.fill(); ctx.restore();
    }

    var tooltipPos = opts.mousePos || state.mousePos;
    if (opts.tooltip !== false && tooltipPos && opts.tooltipCanvas === canvas) {
      var mx = tooltipPos.x - pad.l;
      if (mx >= 0 && mx <= cw) {
        var hoverX = minX + (mx / cw) * rangeX;
        var nearestIdx = -1, nearestDist = Infinity;
        for (var ni = 0; ni < datasets[0].data.length; ni++) {
          var dist = Math.abs(datasets[0].data[ni].x - hoverX);
          if (dist < nearestDist) { nearestDist = dist; nearestIdx = ni; }
        }
        if (nearestIdx >= 0) {
          var nd = datasets[0].data[nearestIdx];
          var npx = pad.l + ((nd.x - minX) / rangeX) * cw;
          ctx.strokeStyle = 'rgba(200,200,200,0.3)'; ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(npx, pad.t); ctx.lineTo(npx, pad.t + ch); ctx.stroke(); ctx.setLineDash([]);
          for (var tdi = 0; tdi < datasets.length; tdi++) {
            if (nearestIdx < datasets[tdi].data.length) {
              var dp = datasets[tdi].data[nearestIdx];
              var dpy = pad.t + ch - (dp.y / maxY) * ch;
              ctx.beginPath(); ctx.arc(npx, dpy, 4, 0, Math.PI * 2);
              ctx.fillStyle = datasets[tdi].color; ctx.fill();
              ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
            }
          }
          var dt2 = new Date(nd.x);
          var timeStr;
          if (rangeX > 86400000) {
            timeStr = (dt2.getMonth()+1) + '/' + dt2.getDate() + ' ' + dt2.getHours().toString().padStart(2,'0') + ':' + dt2.getMinutes().toString().padStart(2,'0') + ':' + dt2.getSeconds().toString().padStart(2,'0');
          } else {
            timeStr = dt2.getHours().toString().padStart(2,'0') + ':' + dt2.getMinutes().toString().padStart(2,'0') + ':' + dt2.getSeconds().toString().padStart(2,'0');
          }
          var lines = [t('时间') + ': ' + timeStr];
          for (var li = 0; li < datasets.length; li++) {
            if (nearestIdx < datasets[li].data.length) {
              lines.push(datasets[li].label + ': ' + fmtS(datasets[li].data[nearestIdx].y));
            }
          }
          ctx.font = '11px sans-serif';
          var boxW = 0;
          for (var bl = 0; bl < lines.length; bl++) boxW = Math.max(boxW, ctx.measureText(lines[bl]).width);
          boxW += 20;
          var boxH = lines.length * 18 + 12;
          var boxX = npx + 12;
          if (boxX + boxW > w - pad.r) boxX = npx - boxW - 12;
          var boxY = pad.t + 8;
          ctx.fillStyle = 'rgba(26,31,39,0.95)';
          ctx.strokeStyle = 'rgba(80,90,100,0.6)'; ctx.lineWidth = 1;
          roundRect(ctx, boxX, boxY, boxW, boxH, 6);
          ctx.fill(); ctx.stroke();
          for (var tl = 0; tl < lines.length; tl++) {
            ctx.fillStyle = tl === 0 ? '#c9d1d9' : (datasets[tl-1] ? datasets[tl-1].color : '#c9d1d9');
            ctx.textAlign = 'left';
            ctx.fillText(lines[tl], boxX + 10, boxY + 16 + tl * 18);
          }
        }
      }
    }

    return { minX: minX, maxX: maxX, maxY: maxY, pad: pad, cw: cw, ch: ch };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function drawSparkline(canvas, data, color) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.offsetWidth || 120, h = canvas.offsetHeight || 32;
    canvas.width = w * dpr; canvas.height = h * dpr;
    var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    if (data.length < 2) return;
    var max = Math.max.apply(null, data) || 1;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = (i / (data.length - 1)) * w;
      var y = h - (data[i] / max) * (h - 2) - 1;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = color.replace('1)', '0.08)').replace('rgb', 'rgba'); ctx.fill();
  }

  // ---- Render ----
  function render() {
    renderStats(); renderChart(); renderTable(); rebuildFilters();
    if (state.selectedInterface) renderDetailCharts(state.selectedInterface);
  }

  function renderStats() {
    var ifs = state.interfaces.filter(function (i) { return i.type !== 'loopback'; });
    document.getElementById('stat-total').textContent = ifs.length;
    document.getElementById('stat-active').textContent = ifs.filter(function (i) { return i.up; }).length;
    var totalTx = 0, totalRx = 0, totalSpd = 0;
    for (var i = 0; i < ifs.length; i++) { totalTx += ifs[i].txBytes; totalRx += ifs[i].rxBytes; totalSpd += ifs[i].speed; }
    document.getElementById('stat-upload').textContent = fmt(totalTx);
    document.getElementById('stat-download').textContent = fmt(totalRx);
    document.getElementById('stat-speed').textContent = fmtS(totalSpd);
    document.getElementById('interface-count').innerHTML = ifs.length + ' <span data-i18n="接口">' + t('接口') + '</span>';
  }

  function renderChart() {
    var canvas = document.getElementById('traffic-chart');
    if (!canvas) return;
    var allTs = {}, names = Object.keys(state.history);
    for (var ni = 0; ni < names.length; ni++) {
      var cd = getChartData(names[ni], state.timeRange);
      for (var t1 = 0; t1 < cd.tx.length; t1++) allTs[cd.tx[t1].x] = true;
      for (var t2 = 0; t2 < cd.rx.length; t2++) allTs[cd.rx[t2].x] = true;
    }
    var sorted = Object.keys(allTs).map(Number).sort(function (a, b) { return a - b; });
    var cutoff = Date.now() - state.timeRange * 1000;
    var filtered = sorted.filter(function (t) { return t >= cutoff; });
    var txData = [], rxData = [];
    for (var fi = 0; fi < filtered.length; fi++) {
      var ts = filtered[fi], tx = 0, rx = 0;
      for (var ni2 = 0; ni2 < names.length; ni2++) {
        var cd2 = getChartData(names[ni2], state.timeRange);
        for (var ci = 0; ci < cd2.tx.length; ci++) { if (cd2.tx[ci].x === ts) tx += cd2.tx[ci].y; }
        for (var cj = 0; cj < cd2.rx.length; cj++) { if (cd2.rx[cj].x === ts) rx += cd2.rx[cj].y; }
      }
      txData.push({ x: ts, y: tx }); rxData.push({ x: ts, y: rx });
    }
    state.chartDatasets = [
      { data: txData, color: '#f59e0b', fill: 'rgba(245,158,11,0.08)', label: t('发送') },
      { data: rxData, color: '#3b82f6', fill: 'rgba(59,130,246,0.08)', label: t('接收') },
    ];
    drawLineChart(canvas, state.chartDatasets, { tooltipCanvas: canvas });
  }

  function renderTable() {
    var tbody = document.getElementById('iface-tbody');
    var empty = document.getElementById('empty-state');
    var filtered = getFiltered();
    if (filtered.length === 0) { tbody.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    var html = '';
    for (var ri = 0; ri < filtered.length; ri++) {
      var iface = filtered[ri];
      var warning = (iface.speed / (1024 * 1024)) > state.settings.threshold;
      var linkCell;
      if (iface.type === 'wireless' && iface.wifi) {
        var sig = iface.wifi.signal || 0;
        var sigColor = sig >= 70 ? 'var(--accent-green)' : sig >= 40 ? 'var(--accent-orange)' : 'var(--accent-red)';
        var rateStr = iface.wifi.rate ? iface.wifi.rate + ' Mbit/s' : (iface.wifi.rxRate || '-');
        linkCell = '<span style="color:' + sigColor + '">📶 ' + sig + '%</span> <span class="td-link">' + rateStr + '</span>';
      } else {
        linkCell = fmtSpeed(iface.linkSpeed);
      }
      html += '<tr data-name="' + iface.name + '">'
        + '<td><div class="td-status"><span class="status-dot ' + (iface.up ? 'up' : 'down') + '"></span>' + (iface.up ? t('活跃') : t('离线')) + '</div></td>'
        + '<td class="td-name">' + iface.name + '</td>'
        + '<td><span class="type-tag ' + iface.type + '">' + getTypeLabel(iface.type) + '</span></td>'
        + '<td class="td-link">' + linkCell + '</td>'
        + '<td class="td-speed upload">' + fmtS(iface.txSpeed) + '</td>'
        + '<td class="td-speed download">' + fmtS(iface.rxSpeed) + '</td>'
        + '<td class="td-bytes">' + fmt(iface.txBytes) + '</td>'
        + '<td class="td-bytes">' + fmt(iface.rxBytes) + '</td>'
        + '<td class="td-total' + (warning ? ' td-warning' : '') + '">' + fmt(iface.totalBytes) + '</td>'
        + '<td class="td-sparkline"><canvas id="spark-' + iface.name + '" style="width:120px;height:32px;"></canvas></td>'
        + '</tr>';
    }
    tbody.innerHTML = html;
    var rows = tbody.querySelectorAll('tr');
    for (var ci = 0; ci < rows.length; ci++) rows[ci].addEventListener('click', function () { openDetail(this.dataset.name); });
    requestAnimationFrame(function () {
      for (var si = 0; si < filtered.length; si++) {
        var c = document.getElementById('spark-' + filtered[si].name);
        if (!c) continue;
        var spd = getSparkData(filtered[si].name);
        if (spd.length >= 2) drawSparkline(c, spd, 'rgb(59,130,246)');
      }
    });
  }

  // ---- Time Range Buttons ----
  function buildTimeButtons(containerId, currentRange, onChange) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    for (var i = 0; i < TIME_SPANS.length; i++) {
      var span = TIME_SPANS[i];
      var btn = document.createElement('button');
      btn.className = 'time-btn' + (span.seconds === currentRange ? ' active' : '');
      btn.textContent = span.label(); btn.dataset.range = span.seconds;
      btn.addEventListener('click', function () {
        var btns = container.querySelectorAll('.time-btn');
        for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
        this.classList.add('active'); onChange(+this.dataset.range);
      });
      container.appendChild(btn);
    }
  }

  // ---- Filters ----
  function getUniqueValues(field) {
    var all = state.interfaces.slice();
    if (!state.settings.showLoopback) all = all.filter(function (i) { return i.type !== 'loopback'; });
    if (!state.settings.showBond) all = all.filter(function (i) { return i.type !== 'bond'; });
    if (!state.settings.showVlan) all = all.filter(function (i) { return i.type !== 'vlan'; });
    if (!state.settings.showBridge) all = all.filter(function (i) { return i.type !== 'bridge'; });
    if (!state.settings.showFirewall) all = all.filter(function (i) { return i.type !== 'firewall'; });
    if (!state.settings.showTap) all = all.filter(function (i) { return i.type !== 'tap'; });
    if (!state.settings.showVeth) all = all.filter(function (i) { return i.type !== 'veth'; });
    if (!state.settings.showVirtual) all = all.filter(function (i) { return i.type !== 'virtual'; });
    var counts = {};
    for (var i = 0; i < all.length; i++) {
      var val;
      if (field === 'status') val = all[i].up ? t('活跃') : t('离线');
      else if (field === 'name') val = all[i].name;
      else if (field === 'type') val = getTypeLabel(all[i].type);
      else continue;
      counts[val] = (counts[val] || 0) + 1;
    }
    return Object.keys(counts).sort().map(function (k) { return { value: k, count: counts[k] }; });
  }

  function rebuildFilters() {
    var fields = ['status', 'name', 'type'];
    for (var fi = 0; fi < fields.length; fi++) {
      var dd = document.getElementById('filter-' + fields[fi]);
      if (!dd || (dd.classList.contains('open') && dd.querySelector('.filter-list'))) continue;
      buildFilterDropdown(fields[fi], dd);
    }
  }

  function buildFilterDropdown(field, dropdown) {
    var items = getUniqueValues(field);
    var selected = state.filters[field], hasFilter = selected.size > 0;
    var th = dropdown.closest('th');
    if (th) th.classList.toggle('filter-active', hasFilter);
    var html = '<div class="filter-search"><input type="text" placeholder="' + t('搜索...') + '"></div>'
      + '<div class="filter-actions"><button class="btn-sel-all">' + t('全选') + '</button><button class="btn-sel-none">' + t('清除') + '</button></div><div class="filter-list">';
    for (var i = 0; i < items.length; i++) {
      var checked = hasFilter ? (selected.has(items[i].value) ? ' checked' : '') : ' checked';
      html += '<div class="filter-item"><input type="checkbox"' + checked + ' data-field="' + field + '" data-value="' + items[i].value + '"><label>' + items[i].value + '</label><span class="filter-count">' + items[i].count + '</span></div>';
    }
    html += '</div><div class="filter-footer"><button class="btn-clear">' + t('清除筛选') + '</button><button class="btn-apply">' + t('确定') + '</button></div>';
    dropdown.innerHTML = html;
    dropdown.querySelector('.filter-search input').addEventListener('input', function () {
      var q = this.value.toLowerCase();
      var its = dropdown.querySelectorAll('.filter-item');
      for (var i = 0; i < its.length; i++) its[i].style.display = its[i].querySelector('label').textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
    });
    dropdown.addEventListener('click', function (e) { e.stopPropagation(); });
    dropdown.querySelector('.btn-sel-all').addEventListener('click', function () {
      var cbs = dropdown.querySelectorAll('.filter-item input'); for (var i = 0; i < cbs.length; i++) cbs[i].checked = true;
    });
    dropdown.querySelector('.btn-sel-none').addEventListener('click', function () {
      var cbs = dropdown.querySelectorAll('.filter-item input'); for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
    });
    dropdown.querySelector('.btn-apply').addEventListener('click', function () {
      var cbs = dropdown.querySelectorAll('.filter-item input:checked');
      var sel = new Set(); for (var i = 0; i < cbs.length; i++) sel.add(cbs[i].dataset.value);
      var total = dropdown.querySelectorAll('.filter-item input');
      state.filters[field] = sel.size === total.length ? new Set() : sel;
      dropdown.classList.remove('open'); state.openFilter = null; renderTable();
      if (th) th.classList.toggle('filter-active', state.filters[field].size > 0);
    });
    dropdown.querySelector('.btn-clear').addEventListener('click', function () {
      state.filters[field] = new Set(); dropdown.classList.remove('open'); state.openFilter = null; renderTable();
      if (th) th.classList.remove('filter-active');
    });
  }

  function initFilters() {
    var filterThs = document.querySelectorAll('th.filterable');
    for (var i = 0; i < filterThs.length; i++) {
      (function (th) {
        var field = th.dataset.filter, dropdown = th.querySelector('.filter-dropdown');
        var icon = th.querySelector('.filter-icon');
        if (icon) {
          icon.style.cursor = 'pointer';
          icon.addEventListener('click', function (e) {
            e.stopPropagation();
            if (state.openFilter && state.openFilter !== dropdown) state.openFilter.classList.remove('open');
            if (dropdown.classList.contains('open')) { dropdown.classList.remove('open'); state.openFilter = null; }
            else { buildFilterDropdown(field, dropdown); dropdown.classList.add('open'); state.openFilter = dropdown;
              var inp = dropdown.querySelector('input[type="text"]'); if (inp) inp.focus(); }
          });
        }
      })(filterThs[i]);
    }
    document.addEventListener('click', function (e) {
      if (state.openFilter && !e.target.closest('.filter-dropdown') && !e.target.closest('.filter-icon')) {
        state.openFilter.classList.remove('open'); state.openFilter = null;
      }
    });
  }

  // ---- Sort ----
  function initSort() {
    var ths = document.querySelectorAll('.iface-table thead th.sortable');
    for (var i = 0; i < ths.length; i++) {
      ths[i].addEventListener('click', function (e) {
        if (e.target.closest('.filter-icon') || e.target.closest('.filter-dropdown')) return;
        var field = this.dataset.sort;
        if (state.sortField === field) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        else { state.sortField = field; state.sortDir = 'desc'; }
        var allThs = document.querySelectorAll('.iface-table thead th');
        for (var j = 0; j < allThs.length; j++) allThs[j].classList.remove('sort-asc', 'sort-desc');
        this.classList.add(state.sortDir === 'desc' ? 'sort-desc' : 'sort-asc');
        renderTable();
      });
    }
    var def = document.querySelector('th[data-sort="' + state.sortField + '"]');
    if (def) def.classList.add('sort-desc');
  }

  // ---- Chart Tooltip Mouse ----
  function initChartTooltip() {
    var canvas = document.getElementById('traffic-chart');
    if (!canvas) return;
    canvas.addEventListener('mousemove', function (e) {
      var rect = canvas.getBoundingClientRect();
      state.mousePos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (state.chartDatasets) drawLineChart(canvas, state.chartDatasets, { tooltipCanvas: canvas });
    });
    canvas.addEventListener('mouseleave', function () {
      state.mousePos = null;
      if (state.chartDatasets) drawLineChart(canvas, state.chartDatasets, { tooltipCanvas: false });
    });

    var detailCanvas = document.getElementById('detail-chart');
    if (detailCanvas) {
      detailCanvas.addEventListener('mousemove', function (e) {
        var rect = detailCanvas.getBoundingClientRect();
        var pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        state.detailMousePos = pos;
        if (state.detailChartDatasets) drawLineChart(detailCanvas, state.detailChartDatasets, { tooltipCanvas: detailCanvas, mousePos: pos });
      });
      detailCanvas.addEventListener('mouseleave', function () {
        state.detailMousePos = null;
        if (state.detailChartDatasets) drawLineChart(detailCanvas, state.detailChartDatasets, { tooltipCanvas: false });
      });
    }

    var speedCanvas = document.getElementById('detail-speed-chart');
    if (speedCanvas) {
      speedCanvas.addEventListener('mousemove', function (e) {
        var rect = speedCanvas.getBoundingClientRect();
        var pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        state.detailSpeedMousePos = pos;
        if (state.detailSpeedDatasets) drawLineChart(speedCanvas, state.detailSpeedDatasets, { tooltipCanvas: speedCanvas, mousePos: pos });
      });
      speedCanvas.addEventListener('mouseleave', function () {
        state.detailSpeedMousePos = null;
        if (state.detailSpeedDatasets) drawLineChart(speedCanvas, state.detailSpeedDatasets, { tooltipCanvas: false });
      });
    }
  }

  // ---- Detail Modal ----
  function openDetail(name) {
    var iface = state.interfaces.find(function (i) { return i.name === name; });
    if (!iface) return;
    state.selectedInterface = name; state.detailTimeRange = 3600;
    document.getElementById('modal-title').textContent = iface.name + ' - ' + t('接口详情');
    var basicRows = [
      [t('接口名称'), iface.name], [t('类型'), getTypeLabel(iface.type)],
      [t('MAC 地址'), iface.mac || '-'], [t('IPv4 地址'), iface.ip || '-'],
      [t('IPv6 地址'), iface.ipv6 || '-'],
    ];
    if (iface.type === 'wireless' && iface.wifi) {
      if (iface.wifi.ssid) basicRows.push([t('连接网络'), iface.wifi.ssid]);
      basicRows.push([t('信号强度'), (iface.wifi.signal || 0) + '%']);
      if (iface.wifi.bars) basicRows.push([t('信号质量'), iface.wifi.bars]);
      if (iface.wifi.band) basicRows.push([t('频段'), iface.wifi.band]);
      if (iface.wifi.chan) basicRows.push([t('信道'), iface.wifi.chan]);
      if (iface.wifi.security) basicRows.push([t('加密方式'), iface.wifi.security]);
      if (iface.wifi.rate) basicRows.push([t('无线速率'), iface.wifi.rate + ' Mbit/s']);
      if (iface.wifi.rxRate) basicRows.push([t('接收速率'), iface.wifi.rxRate]);
      if (iface.wifi.txRate) basicRows.push([t('发送速率'), iface.wifi.txRate]);
    } else {
      basicRows.push([t('链接速率'), fmtSpeed(iface.linkSpeed)]);
    }
    basicRows.push([t('状态'), iface.up ? '🟢 ' + t('活跃') : '🔴 ' + t('离线')]);
    document.getElementById('detail-basic').innerHTML = mkRows(basicRows);
    // Merged traffic stats including errors
    var errTotal = (iface.txErrors || 0) + (iface.rxErrors || 0) + (iface.txDropped || 0) + (iface.rxDropped || 0);
    document.getElementById('detail-stats').innerHTML = mkRows([
      [t('总发送流量'), fmt(iface.txBytes)], [t('总接收流量'), fmt(iface.rxBytes)],
      [t('总流量'), fmt(iface.totalBytes)], [t('发送数据包'), iface.txPackets.toLocaleString()],
      [t('接收数据包'), iface.rxPackets.toLocaleString()],
      [t('当前发送速率'), fmtS(iface.txSpeed)], [t('当前接收速率'), fmtS(iface.rxSpeed)],
      [t('发送错误'), iface.txErrors, true], [t('接收错误'), iface.rxErrors, true],
      [t('发送丢包'), iface.txDropped, true], [t('接收丢包'), iface.rxDropped, true],
    ]);
    // WiFi section
    var wifiSection = document.getElementById('detail-wifi-section');
    if (iface.type === 'wireless') {
      wifiSection.style.display = '';
      renderWifiInfo(iface);
    } else {
      wifiSection.style.display = 'none';
    }
    buildTimeButtons('detail-time-range', state.detailTimeRange, function (range) {
      state.detailTimeRange = range; renderDetailCharts(state.selectedInterface);
    });
    renderDetailCharts(name);
    document.getElementById('modal-overlay').classList.add('active');
  }

  function renderWifiInfo(iface) {
    var infoEl = document.getElementById('detail-wifi-info');
    var scanEl = document.getElementById('detail-wifi-scan');
    var wifi = iface.wifi || {};
    infoEl.innerHTML = mkRows([
      [t('连接网络'), wifi.ssid || '-'],
      [t('信号强度'), (wifi.signal || 0) + '%'],
      [t('频段'), wifi.band || '-'],
      [t('信道'), wifi.chan || '-'],
      [t('加密方式'), wifi.security || '-'],
    ]);
    var scanList = state.wifiScan || [];
    if (scanList.length === 0) {
      scanEl.innerHTML = '<div class="wifi-empty">' + t('暂无扫描数据') + '</div>';
      return;
    }
    scanList.sort(function (a, b) { return (b.inUse ? 1000 : 0) + b.signal - (a.inUse ? 1000 : 0) - a.signal; });
    var html = '<table class="wifi-table"><thead><tr><th></th><th>' + t('网络名称') + '</th><th>' + t('信号') + '</th><th>' + t('频段') + '</th><th>' + t('信道') + '</th><th>' + t('加密') + '</th></tr></thead><tbody>';
    for (var i = 0; i < scanList.length; i++) {
      var ap = scanList[i];
      var sigColor = ap.signal >= 70 ? 'var(--accent-green)' : ap.signal >= 40 ? 'var(--accent-orange)' : 'var(--accent-red)';
      html += '<tr class="' + (ap.inUse ? 'wifi-connected' : '') + '">'
        + '<td>' + (ap.inUse ? '●' : '') + '</td>'
        + '<td>' + (ap.ssid || '(隐藏)') + '</td>'
        + '<td style="color:' + sigColor + '">' + ap.signal + '%</td>'
        + '<td>' + (ap.band || '-') + '</td>'
        + '<td>' + (ap.chan || '-') + '</td>'
        + '<td>' + (ap.security || '-') + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>';
    scanEl.innerHTML = html;
  }

  function mkRows(pairs) {
    return pairs.map(function (p) {
      var isError = p[2] === true;
      var valStyle = (isError && p[1] > 0) ? ' style="color:var(--accent-red);font-weight:700;"' : '';
      return '<div class="detail-row"><span class="label">' + p[0] + '</span><span class="value"' + valStyle + '>' + p[1] + '</span></div>';
    }).join('');
  }

  function renderDetailCharts(name) {
    var cd = getChartData(name, state.detailTimeRange);
    state.detailChartDatasets = [
      { data: cd.tx, color: '#f59e0b', fill: 'rgba(245,158,11,0.08)', label: t('发送') },
      { data: cd.rx, color: '#3b82f6', fill: 'rgba(59,130,246,0.08)', label: t('接收') },
    ];
    drawLineChart(document.getElementById('detail-chart'), state.detailChartDatasets, { tooltipCanvas: document.getElementById('detail-chart'), mousePos: state.detailMousePos || undefined });
    var cd60 = getChartData(name, 60);
    state.detailSpeedDatasets = [
      { data: cd60.tx, color: '#f59e0b', fill: 'rgba(245,158,11,0.08)', label: t('发送') },
      { data: cd60.rx, color: '#3b82f6', fill: 'rgba(59,130,246,0.08)', label: t('接收') },
    ];
    drawLineChart(document.getElementById('detail-speed-chart'), state.detailSpeedDatasets, { tooltipCanvas: document.getElementById('detail-speed-chart'), mousePos: state.detailSpeedMousePos || undefined });
    // Update detail stats live
    var iface = state.interfaces.find(function (i) { return i.name === name; });
    if (iface) {
      var statsEl = document.getElementById('detail-stats');
      if (statsEl) {
        statsEl.innerHTML = mkRows([
          [t('总发送流量'), fmt(iface.txBytes)], [t('总接收流量'), fmt(iface.rxBytes)],
          [t('总流量'), fmt(iface.totalBytes)], [t('发送数据包'), iface.txPackets.toLocaleString()],
          [t('接收数据包'), iface.rxPackets.toLocaleString()],
          [t('当前发送速率'), fmtS(iface.txSpeed)], [t('当前接收速率'), fmtS(iface.rxSpeed)],
          [t('发送错误'), iface.txErrors, true], [t('接收错误'), iface.rxErrors, true],
          [t('发送丢包'), iface.txDropped, true], [t('接收丢包'), iface.rxDropped, true],
        ]);
      }
    }
  }

  // ---- Events ----
  function initEvents() {
    initSort(); initFilters(); initChartTooltip();
    buildTimeButtons('chart-time-range', state.timeRange, function (range) { state.timeRange = range; renderChart(); });
    document.getElementById('search-input').addEventListener('input', function () { state.searchQuery = this.value.trim(); renderTable(); });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); document.getElementById('search-input').focus(); }
      if (e.key === 'Escape') closeAllModals();
    });
    document.getElementById('btn-refresh').addEventListener('click', fetchData);
    document.getElementById('btn-settings').addEventListener('click', function () { document.getElementById('settings-overlay').classList.add('active'); });
    document.getElementById('settings-close').addEventListener('click', closeAllModals);
    document.getElementById('settings-overlay').addEventListener('click', function (e) { if (e.target === this) closeAllModals(); });
    document.getElementById('setting-interval').addEventListener('change', function () { state.settings.interval = +this.value; startPolling(); });
    document.getElementById('setting-unit').addEventListener('change', function () { state.settings.unit = this.value; render(); });
    document.getElementById('setting-loopback').addEventListener('change', function () { state.settings.showLoopback = this.checked; renderTable(); });
    document.getElementById('setting-bond').addEventListener('change', function () { state.settings.showBond = this.checked; renderTable(); });
    document.getElementById('setting-vlan').addEventListener('change', function () { state.settings.showVlan = this.checked; renderTable(); });
    document.getElementById('setting-bridge').addEventListener('change', function () { state.settings.showBridge = this.checked; renderTable(); });
    document.getElementById('setting-firewall').addEventListener('change', function () { state.settings.showFirewall = this.checked; renderTable(); });
    document.getElementById('setting-tap').addEventListener('change', function () { state.settings.showTap = this.checked; renderTable(); });
    document.getElementById('setting-veth').addEventListener('change', function () { state.settings.showVeth = this.checked; renderTable(); });
    document.getElementById('setting-virtual').addEventListener('change', function () { state.settings.showVirtual = this.checked; renderTable(); });
    document.getElementById('setting-threshold').addEventListener('change', function () { state.settings.threshold = +this.value || 100; });
    document.getElementById('modal-close').addEventListener('click', closeAllModals);
    document.getElementById('modal-overlay').addEventListener('click', function (e) { if (e.target === this) closeAllModals(); });
  }

  function closeAllModals() {
    document.getElementById('modal-overlay').classList.remove('active');
    document.getElementById('settings-overlay').classList.remove('active');
    state.selectedInterface = null;
    state.detailMousePos = null;
    state.detailSpeedMousePos = null;
  }

  function startPolling() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(fetchData, state.settings.interval);
  }

  function init() {
    loadLang(detectLang());
    applyLang();
    // Read version from manifest
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'manifest.json', false);
      xhr.send(null);
      if (xhr.status === 200) {
        var mf = JSON.parse(xhr.responseText);
        if (mf.version) document.getElementById('footer-ver').textContent = 'v' + mf.version;
      }
    } catch(e) {}
    initEvents(); fetchData(); loadVnstatData(); startPolling();
    var resizeTimer;
    window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 200); });
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
