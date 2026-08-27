const API="https://api.cloudflare.com/client/v4";
const GQL=API+"/graphql";
const DAY=86400000;

const ok=(data)=>new Response(JSON.stringify({success:true,...data}),{headers:{"content-type":"application/json;charset=utf-8","cache-control":"no-store"}});
const fail=(error,status=500,details=null)=>new Response(JSON.stringify({success:false,error,details}),{status,headers:{"content-type":"application/json;charset=utf-8","cache-control":"no-store"}});
function cfg(env){if(!env.CLOUDFLARE_API_TOKEN||!env.CLOUDFLARE_ACCOUNT_ID)throw Error("缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID 环境变量");return {token:env.CLOUDFLARE_API_TOKEN,account:env.CLOUDFLARE_ACCOUNT_ID};}
async function rest(path,token,init={}){const r=await fetch(API+path,{...init,headers:{authorization:`Bearer ${token}`,...init.headers}});const d=await r.json();if(!r.ok||d.success===false)throw Error(d.errors?.map(x=>x.message).join("；")||`Cloudflare API ${r.status}`);return d.result;}
async function gql(query,variables,token){const r=await fetch(GQL,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({query,variables})});const d=await r.json();if(!r.ok||d.errors)throw Error(d.errors?.map(x=>x.message).join("；")||`GraphQL ${r.status}`);return d.data;}
function range(url){const days=Math.min(30,Math.max(1,Number(url.searchParams.get("days")||7)));const end=new Date(),start=new Date(end.getTime()-days*DAY);return {days,start,end,startISO:start.toISOString(),endISO:end.toISOString(),since:start.toISOString().slice(0,10),until:end.toISOString().slice(0,10)}}
const sum=(a)=>a.reduce((s,x)=>s+(Number(x)||0),0);
const dateRows=(rows,getDate,getValue)=>{const m={};for(const x of rows||[]){const k=(getDate(x)||"").slice(0,10);if(k)m[k]=(m[k]||0)+Number(getValue(x)||0)}return Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,value])=>({date,value}));}
async function inventory(env){const {token,account}=cfg(env);const calls=[
 ["zones",rest("/zones?per_page=100",token)],["workers",rest(`/accounts/${account}/workers/scripts?per_page=100`,token)],
 ["d1",rest(`/accounts/${account}/d1/database?per_page=100`,token)],["kv",rest(`/accounts/${account}/storage/kv/namespaces?per_page=100`,token)],
 ["r2",rest(`/accounts/${account}/r2/buckets?per_page=100`,token)],["do",rest(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100`,token)],
 ["queues",rest(`/accounts/${account}/queues?per_page=100`,token)]
];const settled=await Promise.allSettled(calls.map(x=>x[1]));const data={},warnings=[];
settled.forEach((x,i)=>{const n=calls[i][0];if(x.status==="fulfilled")data[n]=x.value;else{data[n]=null;warnings.push({name:n,error:x.reason.message})}});
return {counts:{zones:data.zones?.length||0,workers:data.workers?.length||0,d1:data.d1?.length||0,kv:data.kv?.length||0,r2:data.r2?.buckets?.length||0,durableObjects:data.do?.length||0,queues:data.queues?.length||0},
resources:{zones:(data.zones||[]).map(x=>({id:x.id,name:x.name,status:x.status,plan:x.plan?.name||""})),workers:(data.workers||[]).map(x=>({id:x.id,modified_on:x.modified_on})),d1:(data.d1||[]).map(x=>({uuid:x.uuid,name:x.name,created_at:x.created_at})),kv:(data.kv||[]).map(x=>({id:x.id,title:x.title})),r2:(data.r2?.buckets||[]).map(x=>({name:x.name,creation_date:x.creation_date})),durableObjects:(data.do||[]).map(x=>({id:x.id,name:x.name,script:x.script})),queues:(data.queues||[]).map(x=>({id:x.queue_id,name:x.queue_name}))},warnings};}

async function zoneAnalytics(env,url){const {token}=cfg(env);const zone=url.searchParams.get("zone");if(!zone)throw Error("请选择 Zone");const r=range(url);
const q=`query($zoneTag:String!,$since:Date!,$until:Date!){viewer{zones(filter:{zoneTag:$zoneTag}){httpRequests1dGroups(limit:100,filter:{date_geq:$since,date_leq:$until}){dimensions{date}sum{requests bytes cachedBytes threats pageViews}uniq{uniques}}httpRequestsAdaptiveGroups(limit:50,orderBy:[sum_requests_DESC],filter:{datetime_geq:$sinceT,datetime_leq:$untilT}){dimensions{clientCountryName edgeResponseStatus}count}}}}`;
try{
 const d=await gql(q,{zoneTag:zone,since:r.since,until:r.until,sinceT:r.startISO,untilT:r.endISO},token);
 const groups=d.viewer.zones[0]?.httpRequests1dGroups||[];
 const status={};for(const x of d.viewer.zones[0]?.httpRequestsAdaptiveGroups||[]){const k=String(x.dimensions?.edgeResponseStatus||"未知");status[k]=(status[k]||0)+(x.count||0)}
 const totals={requests:sum(groups.map(x=>x.sum?.requests)),bytes:sum(groups.map(x=>x.sum?.bytes)),cachedBytes:sum(groups.map(x=>x.sum?.cachedBytes)),threats:sum(groups.map(x=>x.sum?.threats)),pageViews:sum(groups.map(x=>x.sum?.pageViews)),uniques:sum(groups.map(x=>x.uniq?.uniques))};
 return {range:r,totals,trend:groups.map(x=>({date:x.dimensions.date,requests:x.sum?.requests||0,bytes:x.sum?.bytes||0,cachedBytes:x.sum?.cachedBytes||0,threats:x.sum?.threats||0,pageViews:x.sum?.pageViews||0,uniques:x.uniq?.uniques||0})),status};
}catch(e){throw Error("Zone Analytics 查询失败："+e.message)}
}

async function zoneSecurity(env,url){const {token}=cfg(env);const zone=url.searchParams.get("zone");if(!zone)throw Error("请选择 Zone");const r=range(url);
const q=`query($zoneTag:String!,$since:Date!,$until:Date!){viewer{zones(filter:{zoneTag:$zoneTag}){firewallEventsAdaptiveGroups(limit:20,orderBy:[count_DESC],filter:{datetime_geq:$start,datetime_leq:$end}){count dimensions{action clientCountryName}}}}}`;
try{const d=await gql(q,{zoneTag:zone,since:r.since,until:r.until,start:r.startISO,end:r.endISO},token);const rows=d.viewer.zones[0]?.firewallEventsAdaptiveGroups||[];return {range:r,total:sum(rows.map(x=>x.count)),actions:rows.reduce((m,x)=>(m[x.dimensions?.action||"unknown]=(m[x.dimensions?.action||"unknown"]||0)+x.count,m),{}),countries:rows.reduce((m,x)=>(m[x.dimensions?.clientCountryName||"unknown"]=(m[x.dimensions?.clientCountryName||"unknown"]||0)+x.count,m),{})};}catch(e){throw Error("安全事件查询失败："+e.message)}
}

async function workersAnalytics(env,url){const {token,account}=cfg(env);const r=range(url);
const q=`query($accountTag:String!,$start:DateTime!,$end:DateTime!){viewer{accounts(filter:{accountTag:$accountTag}){workersInvocationsAdaptiveGroups(limit:5000,filter:{datetime_geq:$start,datetime_leq:$end}){dimensions{datetime scriptName}sum{requests errors subrequests cpuTime}}}}}`;
const d=await gql(q,{accountTag:account,start:r.startISO,end:r.endISO},token);const rows=d.viewer.accounts[0]?.workersInvocationsAdaptiveGroups||[];
const totals={requests:sum(rows.map(x=>x.sum?.requests)),errors:sum(rows.map(x=>x.sum?.errors)),subrequests:sum(rows.map(x=>x.sum?.subrequests)),cpuTime:sum(rows.map(x=>x.sum?.cpuTime))};
const scripts={};for(const x of rows){const n=x.dimensions?.scriptName||"unknown";scripts[n]||(scripts[n]={name:n,requests:0,errors:0,cpuTime:0,subrequests:0});for(const k of ["requests","errors","cpuTime","subrequests"])scripts[n][k]+=Number(x.sum?.[k]||0)}
return {range:r,totals,trend:{requests:dateRows(rows,x=>x.dimensions?.datetime,x=>x.sum?.requests),errors:dateRows(rows,x=>x.dimensions?.datetime,x=>x.sum?.errors),cpuTime:dateRows(rows,x=>x.dimensions?.datetime,x=>x.sum?.cpuTime)},scripts:Object.values(scripts).sort((a,b)=>b.requests-a.requests)};}

async function d1Analytics(env,url){const {token,account}=cfg(env);const r=range(url);
const q=`query($accountTag:String!,$start:DateTime!,$end:DateTime!){viewer{accounts(filter:{accountTag:$accountTag}){d1AnalyticsAdaptiveGroups(limit:5000,filter:{datetime_geq:$start,datetime_leq:$end}){dimensions{datetime databaseId}sum{readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes queryBatchTimeMs databaseSizeBytes}}}}}`;
const d=await gql(q,{accountTag:account,start:r.startISO,end:r.endISO},token);const rows=d.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups||[];
const fields=["readQueries","writeQueries","rowsRead","rowsWritten","queryBatchResponseBytes","queryBatchTimeMs"];const totals=Object.fromEntries(fields.map(k=>[k,sum(rows.map(x=>x.sum?.[k]))]));totals.databaseSizeBytes=Math.max(0,...rows.map(x=>Number(x.sum?.databaseSizeBytes||0)));
const db={};for(const x of rows){const n=x.dimensions?.databaseId||"unknown";db[n]||(db[n]={id:n});for(const k of fields)db[n][k]=(db[n][k]||0)+Number(x.sum?.[k]||0);db[n].databaseSizeBytes=Math.max(db[n].databaseSizeBytes||0,Number(x.sum?.databaseSizeBytes||0))}
return {range:r,totals,trend:{rowsRead:dateRows(rows,x=>x.dimensions?.datetime,x=>x.sum?.rowsRead),rowsWritten:dateRows(rows,x=>x.dimensions?.datetime,x=>x.sum?.rowsWritten),readQueries:dateRows(rows,x=>x.dimensions?.datetime,x=>x.sum?.readQueries),writeQueries:dateRows(rows,x=>x.dimensions?.datetime,x=>x.sum?.writeQueries)},databases:Object.values(db).sort((a,b)=>b.rowsRead-a.rowsRead)};}

async function kvAnalytics(env,url){const {token,account}=cfg(env);const r=range(url);
const q=`query($accountTag:String!,$start:DateTime!,$end:DateTime!){viewer{accounts(filter:{accountTag:$accountTag}){kvOperationsAdaptiveGroups(limit:5000,filter:{datetime_geq:$start,datetime_leq:$end}){dimensions{datetime action namespaceId}sum{requests}}kvStorageAdaptiveGroups(limit:5000,filter:{datetime_geq:$start,datetime_leq:$end}){dimensions{datetime namespaceId}max{bytes}}}}}`;
const d=await gql(q,{accountTag:account,start:r.startISO,end:r.endISO},token);const a=d.viewer.accounts[0]||{},ops=a.kvOperationsAdaptiveGroups||[],storage=a.kvStorageAdaptiveGroups||[];
const actions={},names={};for(const x of ops){const ac=x.dimensions?.action||"OTHER";actions[ac]=(actions[ac]||0)+Number(x.sum?.requests||0);const id=x.dimensions?.namespaceId||"unknown";names[id]=(names[id]||0)+Number(x.sum?.requests||0)}
const latest={};for(const x of storage){const id=x.dimensions?.namespaceId||"unknown";latest[id]=Math.max(latest[id]||0,Number(x.max?.bytes||0))}
return {range:r,totalRequests:sum(Object.values(actions)),actions,storageBytes:sum(Object.values(latest)),trend:dateRows(ops,x=>x.dimensions?.datetime,x=>x.sum?.requests),namespaces:Object.entries(names).map(([id,requests])=>({id,requests,storageBytes:latest[id]||0})).sort((a,b)=>b.requests-a.requests)};}

async function usage(env){const {token,account}=cfg(env);try{return {result:await rest(`/accounts/${account}/billable-usage`,token)}}catch(e){try{return {result:await rest(`/accounts/${account}/billing/usage`,token)}}catch(e2){throw Error("Billable Usage 当前账户/API 不可用："+e2.message)}}}

export async function onRequest({request,env}){const url=new URL(request.url);const p=url.pathname.replace(/^\/api\/?/,"");try{
 if(p==="config")return ok({siteName:env.SITE_NAME||"Cloudflare Status"});
 if(p==="inventory")return ok(await inventory(env));
 if(p==="zone")return ok(await zoneAnalytics(env,url));
 if(p==="security")return ok(await zoneSecurity(env,url));
 if(p==="workers")return ok(await workersAnalytics(env,url));
 if(p==="d1")return ok(await d1Analytics(env,url));
 if(p==="kv")return ok(await kvAnalytics(env,url));
 if(p==="usage")return ok(await usage(env));
 return fail("API 不存在",404);
}catch(e){return fail(e.message||"服务器错误",500);}}