/* Fixed-path cleanup for owner-authorized temporary LG TV observations. ES5.
 * Sources: https://www.webosose.org/docs/reference/ls2-api/com-webos-service-downloadmanager/
 * https://github.com/webosose/luna-downloadmgr/blob/master/src/DownloadService.cpp
 * No shell, directory deletion, broad history clearing, or arbitrary paths.
 */
(function (global) {
  'use strict';
  var SERVICE = 'luna://com.webos.service.downloadmanager/';
  var OWNER = 'com.webos.app.dangbei-overlay';
  var hasOwn = Object.prototype.hasOwnProperty;

  function validTicket(value) {
    return typeof value === 'number' && value >= 0 && value <= 9007199254740991 && value % 1 === 0;
  }
  function checked(config) {
    if (!config || typeof config.runId !== 'string' || !/^[a-f0-9]{8,64}$/.test(config.runId) ||
        typeof config.token !== 'string' || !/^[a-f0-9]{32,128}$/.test(config.token)) throw new Error('Invalid cleanup configuration.');
    var origin = global.location.protocol + '//' + global.location.host;
    var address = String(global.location.hostname || '').split('.');
    var privateAddress = address.length === 4 && address.every(function (part) {
      return /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part;
    }) && (Number(address[0]) === 10 || (Number(address[0]) === 172 && Number(address[1]) >= 16 && Number(address[1]) <= 31) ||
      (Number(address[0]) === 192 && Number(address[1]) === 168));
    if (global.location.protocol !== 'http:' || config.callbackOrigin !== origin || !privateAddress) {
      throw new Error('Cleanup must use the current private HTTP origin.');
    }
    return { runId: config.runId, token: config.token, origin: origin,
      capturePath: '/media/internal/downloads/lg-agent-probe-' + config.runId + '.jpg' };
  }
  function text(value, config) {
    return String(value || '').split(config.token).join('[redacted]')
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted-url]').substring(0, 300);
  }
  function recordTarget(item) {
    if (!item || typeof item !== 'object') return null;
    var record = item;
    if (typeof item.recordString === 'string') {
      try { record = JSON.parse(item.recordString); } catch (ignore) { return null; }
    }
    return record && typeof record.target === 'string' ? record.target : null;
  }
  function historyEntries(response) {
    return response && Array.isArray(response.items) ? response.items : [];
  }
  function start(config, callback, operation) {
    var safe;
    try { safe = checked(config); }
    catch (error) { callback({ ok: false, error: error.message }); return function () {}; }
    var stopped = false;
    var bridges = [];
    var operationTimer = setTimeout(function () { finish({ ok: false, error: 'Cleanup deadline reached.' }); }, 20000);
    function release(bridge) {
      var index = bridges.indexOf(bridge);
      if (index >= 0) bridges.splice(index, 1);
      if (bridge && typeof bridge.cancel === 'function') { try { bridge.cancel(); } catch (ignore) {} }
    }
    function finish(result) {
      if (stopped) return;
      stopped = true;
      clearTimeout(operationTimer);
      bridges.slice().forEach(release);
      callback(result);
    }
    function call(method, payload, done, download) {
      if (stopped) return;
      var bridge;
      var complete = false;
      var ticket = null;
      var target = null;
      var timer;
      function settle(error, response) {
        if (complete || stopped) return;
        complete = true;
        clearTimeout(timer);
        release(bridge);
        done(error, response);
      }
      try {
        if (typeof global.webOSServiceBridge === 'function') bridge = new global.webOSServiceBridge();
        else if (typeof global.PalmServiceBridge === 'function') bridge = new global.PalmServiceBridge();
        else { settle('Privileged service bridge unavailable.'); return; }
        bridges.push(bridge);
        bridge.onservicecallback = function (raw) {
          var response;
          try { response = JSON.parse(raw); }
          catch (error) { settle('Invalid service response.'); return; }
          if (!response || typeof response !== 'object' || Array.isArray(response)) { settle('Invalid service response.'); return; }
          if (response.returnValue === false) { settle(text(response.errorText || 'Service rejected cleanup request.', safe), response); return; }
          if (!download) { settle(null, response); return; }
          if (validTicket(response.ticket)) ticket = response.ticket;
          if (typeof response.target === 'string') target = response.target;
          if (target !== null && target !== safe.capturePath) { settle('Seed download did not target the exact owned capture.'); return; }
          if (!hasOwn.call(response, 'completed')) return;
          if (response.completed !== true || response.aborted !== false || response.interrupted !== false ||
              typeof response.httpStatus !== 'number' || response.httpStatus < 200 || response.httpStatus >= 300 ||
              !validTicket(ticket) || target !== safe.capturePath) { settle('Seed download completion was not verified.'); return; }
          settle(null, { ticket: ticket, target: target, completed: true });
        };
        timer = setTimeout(function () { settle('Cleanup service request timed out.'); }, download ? 10000 : 3000);
        bridge.call(SERVICE + method, JSON.stringify(payload));
      } catch (error) { settle(text(error.message || error, safe)); }
    }
    operation(safe, call, finish);
    return function () { finish({ ok: false, error: 'Cleanup cancelled.' }); };
  }

  // Call before capture. A one-byte PC asset establishes a deletable ticket;
  // the capture service may then overwrite only this exact owned file.
  function prepareCapture(config, callback) {
    return start(config, callback, function (safe, call, finish) {
      call('download', {
        target: safe.origin + '/' + safe.token + '/assets/cleanup-seed.bin',
        targetDir: '/media/internal/downloads',
        targetFilename: 'lg-agent-probe-' + safe.runId + '.jpg',
        subscribe: true
      }, function (error, receipt) {
        if (error) { finish({ ok: false, path: safe.capturePath, error: error }); return; }
        call('downloadStatusQuery', { ticket: receipt.ticket, subscribe: false }, function (queryError, response) {
          if (queryError || !response || response.target !== safe.capturePath || response.completed !== true) {
            finish({ ok: false, path: safe.capturePath, error: queryError || 'Seed target could not be independently verified.' }); return;
          }
          finish({ ok: true, ticket: receipt.ticket, path: safe.capturePath, seedVerified: true });
        });
      }, true);
    });
  }

  // Call only after upload completion. Re-check the ticket's exact target before
  // deletion; an arbitrary numeric ticket cannot select a different file.
  function deleteCapture(config, ticket, callback) {
    if (!validTicket(ticket)) { callback({ ok: false, error: 'Invalid capture ticket.' }); return function () {}; }
    return start(config, callback, function (safe, call, finish) {
      call('downloadStatusQuery', { ticket: ticket, subscribe: false }, function (error, response) {
        if (error || !response || response.target !== safe.capturePath || response.completed !== true) {
          finish({ ok: false, path: safe.capturePath, error: error || 'Ticket does not identify the exact owned capture.' }); return;
        }
        call('deleteDownloadedFile', { ticket: ticket }, function (deleteError, deleted) {
          if (deleteError || !deleted || deleted.returnValue !== true) {
            finish({ ok: false, path: safe.capturePath, error: deleteError || 'Capture deletion was rejected.' }); return;
          }
          call('getAllHistory', { owner: OWNER }, function (historyError, history) {
            var own = historyEntries(history).filter(function (item) {
              return item.ticket === ticket && recordTarget(item) === safe.capturePath;
            });
            var absent = own.length === 1 && own[0].fileExistsOnFilesys === false;
            finish({ ok: true, path: safe.capturePath, ticket: ticket, deletionAccepted: true,
              absenceVerified: absent, verificationError: historyError || (absent ? null : 'File absence was not confirmed by history.') });
          });
        });
      });
    });
  }

  global.LGAgentCleanup = { prepareCapture: prepareCapture, deleteCapture: deleteCapture };
}(window));
