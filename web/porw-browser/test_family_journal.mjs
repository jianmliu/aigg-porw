import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';
const source=fs.readFileSync(new URL('./family_journal.js',import.meta.url));
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/journal.js'?'text/javascript':'text/html');res.end(req.url==='/journal.js'?source:'<!doctype html><title>Journal test</title>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await chromium.launch({headless:true,...(fs.existsSync(chrome)?{executablePath:chrome}: {})});
try {
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(async()=>{
  const {FamilyReplayJournal}=await import('/journal.js');const namespace=crypto.randomUUID();
  const j=new FamilyReplayJournal(namespace,{maxRecords:1,maxBytes:4096});
  await j.put({taskId:'a',manifest:{delta:new Uint8Array([1,2,3]).buffer},response:{execRoot:'root'}});
  const restored=await new FamilyReplayJournal(namespace).get('a');
  let full=false;try{await j.put({taskId:'b'})}catch(e){full=/capacity/.test(e.message)}
  let duplicate=false;try{await j.put({taskId:'a'})}catch(e){duplicate=/already journaled/.test(e.message)}
  let unavailable=false;try{await new FamilyReplayJournal('none',{indexedDB:null}).get('a')}catch(e){unavailable=/unavailable/.test(e.message)}
  const retained=await j.get('a');
  const concurrent=new FamilyReplayJournal(namespace+'race',{maxRecords:1});
  const race=await Promise.allSettled([concurrent.put({taskId:'x'}),concurrent.put({taskId:'y'})]);
  return {full,duplicate,unavailable,bytes:[...new Uint8Array(restored.manifest.delta)],retained:retained.response.execRoot,winners:race.filter(r=>r.status==='fulfilled').length};
 });
 assert.deepEqual(result,{full:true,duplicate:true,unavailable:true,bytes:[1,2,3],retained:'root',winners:1});
 console.log('PASS real IndexedDB: binary reload, bounded atomic writes, no eviction, unavailability');
} finally {await browser.close();await new Promise(r=>server.close(r));}
