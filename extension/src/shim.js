// Must be imported first. The board code expects `window` and the BoardCore rules on the global object; a service worker has neither.
import '../../web/core.js';

if (typeof window === 'undefined') globalThis.window = globalThis;
