const fs = require('fs'), vm = require('vm'), assert = require('assert');
const routes = new Map(), queries = [];
let rows = [];
const app = { use(){}, get(path,...handlers){routes.set(path, handlers.at(-1));}, post(){}, listen(){} };
const express = Object.assign(()=>app,{json(){},static(){}});
let poolOptions;
const pool = {async query(sql,values){ queries.push({sql,values}); return {rows,rowCount:rows.length}; }};
const stubRequire = name => {
 if(name==='express')return express;
 if(name==='dotenv')return {config(){}};
 if(name==='cors')return ()=>()=>{};
 if(name==='pg')return {Pool: function(options){poolOptions=options;return pool;}};
 if(name==='@aws-sdk/client-s3')throw Error('offline');
 if(name==='./web-ingestion')return ()=>({});
 return require(name);
};
const source=fs.readFileSync('server.js','utf8');
const context=vm.createContext({require:stubRequire,__dirname:process.cwd(),process:{env:{}},console:{log(){},warn(){},error(){}},Buffer});
vm.runInContext(source,context);
async function request(path,query){let body,status=200;const res={status(v){status=v;return this;},json(v){body=v;}};await routes.get(path)({query},res);return {body,status};}
(async()=>{
 assert.equal(queries.length,0,'startup must not query or mutate RDS');
 assert.equal(poolOptions.options,'-c timezone=America/Chicago');
 rows=[{value:'2026-10-23T14:00',crime_count:472},{value:'2026-10-22T13:00',crime_count:12}];
 const times=await request('/api/available-times',{mode:'actual'});
 assert.equal(times.body.latest,'2026-10-23T14:00');assert.equal(times.body.hours[0].crime_count,472);
 assert.match(queries.at(-1).sql,/COUNT\(\*\)::int/);assert.match(queries.at(-1).sql,/GROUP BY date_trunc\('hour', c.crime_date\)/);assert.match(queries.at(-1).sql,/ORDER BY date_trunc\('hour', c.crime_date\) DESC/);
 queries.length=0;rows=[{total:'0',theft:'0',arrested:'0'}];
 const at='2026-10-23T14:00';
 await request('/api/crime-area-summary',{at,community_area:'7'});
 await request('/api/dashboard',{at,community_area:'7',page:'2'});
 assert.equal(queries.length,5);
 const history=queries.find(q=>q.sql.includes('generate_series'));assert(history);
 assert.match(history.sql,/INTERVAL '23 hours'/);assert.match(history.sql,/LEFT JOIN public.crimes/);assert.match(history.sql,/COUNT\(c.crime_date\)::int/);assert.match(history.sql,/GROUP BY h.hour_at ORDER BY h.hour_at/);assert.match(history.sql,/c.community_area = \$2/);assert.match(history.sql,/c.crime_date >= h.hour_at/);assert.match(history.sql,/c.crime_date < h.hour_at \+ INTERVAL '1 hour'/);
 for(const q of queries.filter(q=>q!==history)){assert.match(q.sql,/crime_date >= \$1::timestamp\s+AND crime_date < \$1::timestamp \+ INTERVAL '1 hour'/);assert.match(q.sql,/community_area BETWEEN 1 AND 77/);assert.match(q.sql,/community_area = \$2/);assert.equal(q.values[0],'2026-10-23 14:00:00');assert.equal(q.values[1],7);}
 assert.equal(queries.at(-1).values[3],20);
 queries.length=0;
 await request('/api/dashboard',{at:'2026-10-23T00:30'});
 const allAreaHistory=queries.find(q=>q.sql.includes('generate_series'));
 assert.equal(allAreaHistory.values[0],'2026-10-23 00:30:00');assert.equal(allAreaHistory.values.length,1);
 assert(!allAreaHistory.sql.includes('c.community_area = $2'));
 assert.match(allAreaHistory.sql,/h.hour_at = \$1::timestamp AS selected/);
 assert.equal(queries.filter(q=>q.sql.includes("crime_date >= $1::timestamp AND crime_date < $1::timestamp + INTERVAL '1 hour'")).length,3);
 for(const path of ['/api/dashboard','/api/crime-area-summary'])assert.equal((await request(path,{at:'invalid'})).status,400);
 for(const at of ['2026-02-30T14:00','2026-13-01T14:00','2026-10-23T24:00']) assert.equal((await request('/api/dashboard',{at})).status,400);
 assert.equal((await request('/api/available-times',{community_area:'78'})).status,400);
 assert(!queries.some(q=>/CREATE|INSERT|UPDATE|DELETE/.test(q.sql)));
 console.log('PASS: offline API handlers, hourly SQL/counts/latest, selected-hour KPI/map/table predicates, separate 24-hour zero-fill history SQL and selected marker, applied/all areas, pagination, invalid inputs, Chicago session timezone, no startup DB writes.');
})().catch(error=>{console.error(error);process.exitCode=1;});
