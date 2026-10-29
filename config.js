// -----------------------------------------------------------------------------
// PROXIWARE SETTINGS (Eco Residential, IP Auth, port ranges)
//
//  * IP Auth = no username / password. The extension whitelists your current
//    internet IP automatically through the Proxiware API (see "Auto IP whitelist"
//    in Settings: you paste your API key there once).
//  * Port range 10000-14999 (Quantity 500): port 10000 is rotating, the rest are
//    sticky. The scraper uses the sticky ports 10001..10499; every port is its
//    own IP, and a new IP = the next port.
// -----------------------------------------------------------------------------
const BF_DEFAULTS = {
  proxy: {
    enabled: true,
    host: 'proxy.proxiware.com',
    port: 10000,
    stickyMin: 10001,
    stickyMax: 10499,
    user: '',
    pass: ''
  },
  whitelist: {
    proxyUser: 'm8xvJAuuI4ZQ',   // the "Proxy User" shown in the Proxiware dashboard
    location: 'US'               // location for port range 10000-14999 (empty = do not touch)
  }
};
