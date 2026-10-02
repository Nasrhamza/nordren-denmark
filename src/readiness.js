import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {root} from './config.js';
export async function checkLegalFiles(){
  for(const file of ['terms','privacy','cookies']){
    const text=await readFile(path.join(root,'public','legal',file+'.html'),'utf8');
    if(/DRAFT|TODO|PLACEHOLDER|\[INDSÆT/i.test(text))throw new Error(`Complete public/legal/${file}.html before production`);
  }
}
