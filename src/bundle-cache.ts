import {stat} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fetchBundleWithHash} from './bundle.js';
import {bt} from './i18n.js';
import {bundleLayoutPaths} from './platform/paths.js';
/** Memory-only identity-bound fingerprint cache; source bodies are never retained. */
export class BundleCache {
  downloads=0;downloadedBytes=0;
  private hashes=new Map<string,string>();
  private pending=new Map<string,Promise<{hash:string;source:string|undefined;cacheHit:boolean}>>();
  async key(app:string,pid:number,version:string,origin:string){
    const layout=bundleLayoutPaths(app);
    const macAsar=join(app,'Contents/Resources/app.asar');
    const candidates:[string,string][]=[
      ['app.asar',layout.asarPath],
      ['app.asar.unpacked',join(dirname(layout.asarPath),'app.asar.unpacked')],
      ['unpacked.package.json',layout.unpackedPackageJsonPath],
      ['unpacked.main.js',join(dirname(layout.unpackedPackageJsonPath),'dist','main.js')],
    ];
    if(layout.asarPath!==macAsar){
      candidates.push(['mac.app.asar',macAsar],['mac.app.asar.unpacked',join(app,'Contents/Resources/app.asar.unpacked')]);
    }
    const rows=[];
    let primaryError:unknown;
    for(const [label,targetPath] of candidates){
      try{const s=await stat(targetPath);rows.push([label,s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]);}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        if(label==='app.asar')primaryError=error;
      }
    }
    if(rows.length===0)throw primaryError ?? new Error(`ENOENT: no bundle resources found in ${app}`);
    return JSON.stringify([app,pid,version,new URL(origin).origin,rows]);
  }
  async read(app:string,pid:number,version:string,origin:string,fetcher=fetchBundleWithHash){
    const key=await this.key(app,pid,version,origin),hit=this.hashes.get(key);
    if(hit)return {hash:hit,source:undefined,cacheHit:true};
    const pending=this.pending.get(key);if(pending)return {...await pending,cacheHit:true};
    const load=(async()=>{
      const result=await fetcher(origin);this.downloads++;this.downloadedBytes+=result.bytes;
      if(key!==await this.key(app,pid,version,origin))throw new Error(bt('bundle_cache.changed'));
      this.hashes.set(key,result.hash);while(this.hashes.size>2)this.hashes.delete(this.hashes.keys().next().value!);
      return {hash:result.hash,source:result.source,cacheHit:false};
    })();
    this.pending.set(key,load);try{return await load;}finally{this.pending.delete(key);}
  }
}
