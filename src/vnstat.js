/* ========================================
   Cockpit Traffic Monitor - vnstat Module
   Extracted from app.js
   ======================================== */
(function () {
  'use strict';

  var _state = null;
  var _ensureHistory = null;
  var _renderChart = null;

  var vnstatAvailable = false;

  /**
   * Initialize the vnstat module with shared dependencies.
   * @param {Object} deps
   * @param {Object} deps.state - The shared state object (must include .history)
   * @param {Function} deps.ensureHistory - Function to ensure history entry exists
   * @param {Function} deps.renderChart - Function to re-render the chart
   */
  function init(deps) {
    _state = deps.state;
    _ensureHistory = deps.ensureHistory;
    _renderChart = deps.renderChart;
  }

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
      var h = _ensureHistory(name);
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
    if (_state && _state.chartDatasets) _renderChart();
  }

  // Expose on window for app.js to consume
  window.Vnstat = {
    init: init,
    loadVnstatData: loadVnstatData,
    ingestVnstatJson: ingestVnstatJson,
    isAvailable: function () { return vnstatAvailable; },
  };
})();
