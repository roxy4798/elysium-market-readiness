import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { Queryable } from '../src/database.js';
import { createApiServer } from '../src/api/server.js';
const A='0x245bfe8c6c2429f6a7743d53377ae39b98500459';
const a={token_address:A,symbol:'ELYS',name:'Elysium',assessment_date:'2026-10-03',health_score:'34.00',momentum:'4.50',status:'EARLY',holder_health:'0',transfer_activity:'50',address_activity:'50',concentration_score:'0',consistency_score:'0',data_window_days:7,assessment_id:'0x2ffe882456f2f43d66ce8c4049d55bcacf80a1393afc2cd467a746cec4d18ef3',schema_version:'1.0',methodology_version:'health-v1',assessment_hash:'180f144a819cdcd22d9244feef524dc7f75a80f73505410b9e2efba78d05193c'};
const t={address:A,name:'Elysium',symbol:'ELYS',decimals:18,total_supply:'1000000'};
const m={date:'2026-09-22',holder_count:49,new_holders:49,active_holders:50,transfer_count:78,unique_senders:9,unique_receivers:50,top1_concentration:'0.359313',top5_concentration:'0.921524',top10_concentration:'0.944884'};
let persistedAssessmentDate='2026-10-03';
const persistedAssessmentDates=new Set([persistedAssessmentDate]);
let databaseWrites=0;
function assessmentRow(sql:string){
  const normalized=sql.replace(/\s+/g,' ').toLowerCase();
  // PostgreSQL returns DATE as text for the explicit cast. Without that projection,
  // emulate pg's JavaScript Date value so JSON serialization fails the calendar-string assertion.
  const date=normalized.includes('assessment_date::text as assessment_date')
    ? persistedAssessmentDate
    : new Date(`${persistedAssessmentDate}T00:00:00.000Z`);
  return {...a,assessment_date:date};
}
const db:Queryable={async query(sql:string,values:unknown[]=[]):Promise<any>{const s=sql.replace(/\s+/g,' ').toLowerCase();
if(/^(insert|update|delete|truncate|alter|drop)\b/.test(s))databaseWrites++;
if(s.includes('count(*)')&&s.includes('from tokens'))return{rows:[{total:'2'}]};
if(s.includes('from tokens t')&&s.includes('left join lateral'))return{rows:[{...t,latest_assessment_date:'2026-09-22',health_score:'22.50',momentum:'0.00',status:'EARLY'},{address:'0x0000000000000000000000000000000000000001',name:'New',symbol:null,decimals:null,total_supply:null,latest_assessment_date:null,health_score:null,momentum:null,status:null}]};
if(s.startsWith('select count(*)')&&s.includes('from market_assessments'))return{rows:[{total:'1'}]};
if(s.includes('from tokens where address'))return{rows:values[0]===A?[t]:[]};
if(s.includes('from market_assessments a join tokens'))return{rows:[assessmentRow(sql)]};
if(s.includes('from market_assessments')&&s.includes('assessment_date = $2::date'))return{rows:typeof values[1]==='string'&&persistedAssessmentDates.has(values[1])?[assessmentRow(sql)]:[]};
if(s.includes('from market_assessments')&&s.includes('order by assessment_date asc'))return{rows:[{date:'2026-09-22',value:'0.00'}]};
if(s.includes('from market_assessments')&&s.includes('order by assessment_date desc'))return{rows:[assessmentRow(sql)]};
if(s.includes('from daily_metrics'))return{rows:[m]};
if(s.includes('from assessment_attestations'))return{rows:[]};return{rows:[]};}};
describe('Phase 4A dashboard API',()=>{let server:Server;let base='';beforeAll(async()=>{server=createApiServer(db);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>{const x=server.address();if(typeof x==='object'&&x)base=`http://127.0.0.1:${x.port}`;resolve();}));});afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
it('lists tokens with bounded pagination and null assessment values',async()=>{const r=await fetch(`${base}/v1/tokens?page=1&limit=250`);const b=await r.json() as any;expect(b.limit).toBe(100);expect(b.total).toBe(2);expect(b.tokens[1].health_score).toBeNull();expect(b.tokens[1].status).toBeNull();});
it('rejects invalid pagination and malformed addresses',async()=>{expect((await fetch(`${base}/v1/tokens?page=0`)).status).toBe(400);expect((await fetch(`${base}/v1/tokens/nope/metrics`)).status).toBe(400);});
it('returns persisted assessment history and rejects invalid date filters',async()=>{const b=await(await fetch(`${base}/v1/tokens/${A}/assessments?from=2026-09-01&to=2026-09-30`)).json() as any;expect(b.assessments[0].components.holder_health).toBe(0);expect((await fetch(`${base}/v1/tokens/${A}/assessments?from=bad`)).status).toBe(400);});
it('returns the exact existing assessment without recomputing it',async()=>{const r=await fetch(`${base}/v1/tokens/${A}/assessment?date=2026-10-03`);const b=await r.json() as any;expect(r.status).toBe(200);expect(b).toMatchObject({assessment_id:a.assessment_id,assessment_hash:a.assessment_hash,health_score:34,momentum:4.5,status:'EARLY',methodology_version:'health-v1'});});
it('repeated missing assessment reads return deterministic 404 without writes or rows',async()=>{const beforeRows=persistedAssessmentDates.size;const beforeWrites=databaseWrites;for(let i=0;i<2;i++){const r=await fetch(`${base}/v1/tokens/${A}/assessment?date=2026-10-04`);expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'ASSESSMENT_NOT_FOUND',message:'Assessment not found'});}expect(persistedAssessmentDates.size).toBe(beforeRows);expect(databaseWrites).toBe(beforeWrites);});
it('keeps invalid assessment addresses and dates at 400',async()=>{expect((await fetch(`${base}/v1/tokens/nope/assessment?date=2026-10-03`)).status).toBe(400);expect((await fetch(`${base}/v1/tokens/${A}/assessment?date=not-a-date`)).status).toBe(400);});
it('keeps attestation disabled by default before database or signer access',async()=>{const previous=process.env['ATTESTATION_ENABLED'];delete process.env['ATTESTATION_ENABLED'];const beforeWrites=databaseWrites;try{const r=await fetch(`${base}/v1/assessments/${a.assessment_id}/attest`,{method:'POST'});expect(r.status).toBe(403);expect(await r.json()).toMatchObject({error:'ATTESTATION_DISABLED'});expect(databaseWrites).toBe(beforeWrites);}finally{if(previous!==undefined)process.env['ATTESTATION_ENABLED']=previous;}});
it('returns daily metrics without changing concentration ratios',async()=>{const b=await(await fetch(`${base}/v1/tokens/${A}/metrics`)).json() as any;expect(b.metrics[0]).toEqual(m);});
it('returns persisted momentum values',async()=>{const b=await(await fetch(`${base}/v1/tokens/${A}/momentum`)).json() as any;expect(b.momentum).toEqual([{date:'2026-09-22',value:0}]);});
it('returns overview with explicit unconfigured attestation state',async()=>{const prev=process.env['ATTESTATION_CONTRACT_ADDRESS'];delete process.env['ATTESTATION_CONTRACT_ADDRESS'];try{const b=await(await fetch(`${base}/v1/tokens/${A}/overview`)).json() as any;expect(b.latest_assessment.assessment_id).toBe(a.assessment_id);expect(b.attestation).toMatchObject({configured:false,attested:false,data_matches:false,transaction_hash:null,block_number:null});}finally{if(prev!==undefined)process.env['ATTESTATION_CONTRACT_ADDRESS']=prev;}});
it('preserves persisted assessment dates as exact calendar strings in overview and history',async()=>{
  const originalDate=persistedAssessmentDate;
  try{
    for(const expected of ['2026-01-01','2026-10-03','2026-12-31']){
      persistedAssessmentDate=expected;
      const overview=await(await fetch(`${base}/v1/tokens/${A}/overview`)).json() as any;
      const history=await(await fetch(`${base}/v1/tokens/${A}/assessments`)).json() as any;
      expect(overview.latest_assessment.assessment_date).toBe(expected);
      expect(overview.latest_assessment.assessment_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(history.assessments[0].assessment_date).toBe(expected);
      expect(history.assessments[0].assessment_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }finally{persistedAssessmentDate=originalDate;}
});
it('returns 404 for unknown tokens',async()=>{expect((await fetch(`${base}/v1/tokens/0x0000000000000000000000000000000000000002/overview`)).status).toBe(404);});});
