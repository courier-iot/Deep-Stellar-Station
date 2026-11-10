// Runs in every tab before the page's own scripts.
(function () {
  try {
    if (window.__dsInit) return;
    Object.defineProperty(window, '__dsInit', { value: 1 });

    // Pop-ups and target=_blank open in the same tab (each tab is a separate private view;
    // new windows would escape the browser's privacy settings).
    var openNative = window.open;
    window.open = function (u) {
      try { if (u) location.href = new URL(u, location.href).href; } catch (e) {}
      return null;
    };
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[target]') : null;
      if (a && a.target !== '_self' && a.href && !a.hasAttribute('download')) {
        e.preventDefault();
        location.href = a.href;
      }
    }, true);

    // WebRTC: relay-only connections, so sites can't learn your local or public IP address.
    var O = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (O) {
      var relay = function (c) { c = Object.assign({}, c || {}); c.iceTransportPolicy = 'relay'; return c; };
      var W = function (config, constraints) { return new O(relay(config), constraints); };
      W.prototype = O.prototype;
      try { Object.setPrototypeOf(W, O); } catch (e) {}
      var sc = O.prototype.setConfiguration;
      if (sc) O.prototype.setConfiguration = function (c) { return sc.call(this, relay(c)); };
      window.RTCPeerConnection = W;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = W;
    }

    // Global Privacy Control signal.
    try { Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: function () { return true; }, configurable: true }); } catch (e) {}
  } catch (e) {}
})();
