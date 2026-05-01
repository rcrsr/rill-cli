import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
const buf = require('buffer');
export default {
  name: 'esm-with-createrequire',
  version: buf.Buffer ? '1' : '0',
};
