// No automatic eviction: settlement alone does not prove a dispute window has closed.
// When full or unavailable, new work fails closed before its signature is delivered.
export function journalSize(value) {
  if(value instanceof ArrayBuffer)return value.byteLength;
  if(ArrayBuffer.isView(value))return value.byteLength;
  if(Array.isArray(value))return value.reduce((n,v)=>n+journalSize(v),0);
  if(value&&typeof value==='object')return Object.entries(value).reduce((n,[k,v])=>n+k.length*2+journalSize(v),0);
  return JSON.stringify(value??null).length*2;
}
export class FamilyReplayJournal {
  constructor(namespace,{indexedDB=globalThis.indexedDB,maxRecords=32,maxBytes=32*1024*1024}={}) {
    Object.assign(this,{indexedDB,maxRecords,maxBytes});this.name='porw-family-replay-v1:'+namespace;this.opening=null;
  }
  open() {
    if(!this.indexedDB)return Promise.reject(new Error('persistent family replay storage unavailable'));
    if(!this.opening)this.opening=new Promise((resolve,reject)=>{const req=this.indexedDB.open(this.name,1);
      req.onupgradeneeded=()=>req.result.createObjectStore('tasks',{keyPath:'taskId'});
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('replay storage open failed'));req.onblocked=()=>reject(new Error('replay storage blocked'));});
    return this.opening;
  }
  async get(taskId) { const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('tasks','readonly'),r=tx.objectStore('tasks').get(taskId);let result;
    r.onsuccess=()=>{result=r.result;};tx.oncomplete=()=>resolve(result?.record);tx.onabort=tx.onerror=()=>reject(tx.error||new Error('replay read failed'));}); }
  async put(record) {
    const size=journalSize(record);if(size>this.maxBytes)throw new Error('family replay journal byte capacity exceeded');
    const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('tasks','readwrite'),store=tx.objectStore('tasks');let failure=null,count=0,total=0,exists=false;
      const cursor=store.openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(c){if(c.key===record.taskId)exists=true;else{count++;total+=c.value.size;}c.continue();return;}
        if(exists){failure=new Error('family replay task already journaled');tx.abort();return;}
        if(count>=this.maxRecords||total+size>this.maxBytes){failure=new Error('family replay journal capacity reached; unresolved records retained');tx.abort();return;}
        store.add({taskId:record.taskId,size,record});};
      tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(failure||tx.error||new Error('family replay journal write failed'));
    });
  }
}
