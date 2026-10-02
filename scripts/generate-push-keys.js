import {readFile,writeFile} from 'node:fs/promises';
import webpush from 'web-push';
const file=new URL('../.env',import.meta.url);let text='';try{text=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
if(/^VAPID_(PUBLIC|PRIVATE)_KEY=.+/m.test(text))throw Error('Existing VAPID keys are preserved. Do not replace keys used by subscribed devices.');
const keys=webpush.generateVAPIDKeys();await writeFile(file,text+'\nVAPID_PUBLIC_KEY='+keys.publicKey+'\nVAPID_PRIVATE_KEY='+keys.privateKey+'\n',{mode:0o600});
console.log('Keys saved to .env without printing secrets. Set VAPID_SUBJECT to your company mailto: address or HTTPS website, then restart the server.');
