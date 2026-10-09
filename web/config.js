// Legacy configuration for the already deployed SSD board (0.1.1).
// The 0.2.0 comparison builds do not use this file: `npm run build` generates
// dist/guest/config.js and dist/supabase/config.js with a `backend` setting.
// This object contains no credentials. The router's existing authenticated
// session authorizes uploads; the URL service supplies the read-back check.
window.BOARD_CONFIG = Object.freeze({
  storagePath: '/HDD1/serotonin-board/data',
  dataUrl: './data/',
  pollMilliseconds: 15000,
  maxEvents: 1000,
  version: '0.1.1',
});
