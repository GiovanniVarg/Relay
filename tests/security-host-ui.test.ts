import test from 'node:test';
import {securityHostUi} from './fixtures/security-host-ui.js';
for(const kind of ['mcp','telegram','workspace','discussion'] as const)test('actual built App secures '+kind+' receiver/lifetime boundary',{timeout:60000,skip:process.env.RELAY_BROWSER_LIVE!=='1'||process.env.RELAY_SECURITY_HOST_UI!=='1'},async()=>{await securityHostUi(kind);});
