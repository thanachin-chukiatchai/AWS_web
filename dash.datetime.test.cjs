const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync('dash.html','utf8');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('loadDashboard().catch(error => console.error(error));','');
const elements=new Map();
function el(){return {value:'',disabled:false,textContent:'',style:{},children:[],events:{},attrs:{},setAttribute(k,v){this.attrs[k]=String(v)},append(...x){this.children.push(...x)},add(x){this.children.push(x)},replaceChildren(...x){this.children=x},addEventListener(n,f){this.events[n]=f},reportValidity(){this.checked=true;return /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(this.value)}}}
const get=id=>{if(!elements.has(id))elements.set(id,el());return elements.get(id)};
get('mapMode').value='forecast';
let calls=[],empty=false,available=[],failAvailable=false;
const layer={addTo(){return this},setView(){return this},removeLayer(){},fitBounds(){},getBounds(){return []}};
const expectedMessages=[];
const ctx=vm.createContext({console:{log:console.log,warn:e=>expectedMessages.push(e.message),error:e=>expectedMessages.push(e.message)},URLSearchParams,Option:function(t,v){this.value=v;this.textContent=t},localStorage:{getItem(){return 'test'}},window:{location:{}},L:{map:()=>layer,tileLayer:()=>layer,layerGroup:()=>layer,geoJSON:()=>layer},document:{getElementById:get,createElement:el,createElementNS:el,querySelector:()=>get('header'),querySelectorAll:()=>[el(),el(),el()]},fetch:async url=>{
 calls.push(url);const u=new URL(url,'http://test');let body;
 if(u.pathname.includes('available-times')){if(failAvailable) return {ok:false};body={values:available,latest:[...available].sort().at(-1),hours:available.map(value=>({value,crime_count:472}))}}
 else if(u.pathname.includes('community-areas'))body={features:Array.from({length:77},(_,i)=>({geometry:{},properties:{area_num_1:i+1}}))};
 else if(u.pathname.includes('predictions'))body={data:empty?[]:u.searchParams.has('from')?Array.from({length:24},(_,i)=>({date:'2026-10-' + (i<11?'23':'24') + ' ' + String((i+13)%24).padStart(2,'0') + ':00:00',community_area:1,probability:(i+1)/100})):Array.from({length:25},(_,i)=>({date:'2026-10-23 12:30:00',community_area:i+1,probability:.5}))};
 else if(u.pathname.includes('crime-area-summary'))body={at:u.searchParams.get('at'),data:empty?[]:[{community_area:1,crime_count:41}]};
 else body={summary:{total:empty?0:41,theft:3,arrested:2},types:empty?[]:[{label:'THEFT',value:3}],trend:Array.from({length:24},(_,i)=>({label:`2026-10-${i<11?'22':'23'} ${String((i+13)%24).padStart(2,'0')}:30`,value:i===23?(empty?0:41):i%3===0?0:i,selected:i===23})),data:empty?[]:[{crime_date:u.searchParams.get('at'),primary_type:'THEFT'}]};
 return {ok:true,json:async()=>body};
}});
const run=s=>vm.runInContext(s,ctx);vm.runInContext(code,ctx);
(async()=>{
assert.match(html, /<input id="mapDateTime" type="datetime-local" step="60" required>/);
await run('loadDashboard()');assert.equal(get('mapDateTime').disabled,false);assert.equal(calls.filter(x=>x.includes('predictions')).length,0);
get('mapDateTime').value='2026-10-23T12:30';await get('applyDateTime').events.click();assert.equal(get('totalCrime').textContent,'25');assert.match(get('tablePage').textContent,/Page 1 \/ 2/);
get('mapDateTime').value='2026-11-01T01:15';await get('nextPage').events.click();await new Promise(setImmediate);assert.equal(run('appliedFilter.at'),'2026-10-23T12:30');assert.equal(run('dashboardPage'),2);assert.equal(get('crimeTableBody').children.length,5);
get('mapDateTime').value='';const count=calls.length;await get('applyDateTime').events.click();assert.equal(calls.length,count);assert.equal(run('dashboardPage'),2);
available=['2026-10-23T12:30'];get('mapDateTime').value='2026-10-23T12:30';get('mapMode').value='actual';get('communityFilter').value='7';await get('mapMode').events.change();assert.equal(run('dashboardPage'),1);
let chart=get('analysisChart').children.at(-1);
assert.equal(chart.attrs['aria-label'],'Actual crime counts by hour, last 24 hours');
let points=chart.children.filter(n=>n.attrs.cx!==undefined);
assert.equal(points.length,24);assert.equal(points.filter(n=>n.attrs['data-selected']==='true').length,1);
assert.match(points.at(-1).attrs['aria-label'],/41 cases \(selected hour\)/);
assert(points.some(n=>/: 0 cases/.test(n.attrs['aria-label'])));
assert.match(get('analysisChart').children[0].textContent,/Area 7/);
get('mapDateTime').value='2026-12-01T00:00';get('communityFilter').value='8';await get('nextPage').events.click();
let last=new URL(calls.at(-1),'http://test');assert.equal(last.searchParams.get('at'),'2026-10-23T12:30');assert.equal(last.searchParams.get('community_area'),'7');assert.equal(last.searchParams.get('page'),'2');assert.match(get('analysisChart').children[0].textContent,/Area 7/);assert.equal(get('totalCrime').textContent,'41');
empty=true;await get('applyDateTime').events.click();assert.equal(run('dashboardPage'),1);assert.equal(get('totalCrime').textContent,'0');assert.equal(get('nextPage').disabled,true);assert.equal(get('reportChart').textContent,'No data for this selection');
get('mapMode').value='forecast';await get('mapMode').events.change();assert.equal(get('totalCrime').textContent,'0');assert.equal(run('forecastRows.length'),0);assert.equal(get('nextPage').disabled,true);
empty=false;get('mapDateTime').value='2026-10-23T12:30';await get('applyDateTime').events.click();assert.equal(get('totalCrime').textContent,'25');assert.equal(get('analysisTitle').textContent,'Forecast trend - next 24 hours');assert.equal(get('analysisChart').children.at(-1).attrs['aria-label'],'Citywide mean forecast probability, next 24 hours');assert.equal(get('analysisChart').children.at(-1).children.filter(n=>n.attrs.cx!==undefined).length,24);assert(calls.some(x=>x.includes('from=')&&x.includes('to=')));
get('mapDateTime').value='';available=['2001-01-02T00:00','2001-01-01T00:00'];await run("loadAvailableTimes('test','actual')");assert.equal(get('mapDateTime').value,'2001-01-02T00:00');assert.equal(get('mapDateTime').children.length,0);assert.match(get('availableHours').children[1].textContent,/472/);assert.match(get('availableHours').children[1].textContent,/\u0e04\u0e14\u0e35/);
get('mapMode').value='actual';get('availableHours').value='2001-01-01T00:00';await get('availableHours').events.change();assert.equal(run('appliedFilter.at'),'2001-01-01T00:00');
empty=true;get('mapDateTime').value='2001-01-03T14:00';await get('applyDateTime').events.click();assert.equal(get('totalCrime').textContent,'0');assert.match(get('dashboardStatus').textContent,/No crime data/);assert.equal(run('actualLayer'),null);assert.equal(get('analysisChart').children.at(-1).children.filter(n=>n.attrs.cx!==undefined).length,24);
get('mapDateTime').value='';failAvailable=true;await run("loadAvailableTimes('test','actual')");assert.equal(get('mapDateTime').disabled,false);
assert(!/toISOString|valueAsDate/.test(code));
console.log('PASS: syntax, editable required input, empty suggestions/API failure, populated/empty Actual and Forecast, mode switching, Apply reset/validity, unapplied time/area pagination isolation, wall-clock query preservation.');
})().catch(e=>{console.error(e);process.exitCode=1});
