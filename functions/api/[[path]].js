
const API="https://api.cloudflare.com/client/v4";
const GQL=API+"/graphql";

const json=(x,status=200)=>new Response(JSON.stringify(x),{
  status,headers:{"content-type":"application/json;charset=utf-8","cache-control":"no-store"}
});
const good=(data)=>json({success:true,data});
const fail=(message,status=500,extra={})=>json({success:false,error:String(message),...extra},status);

function envConfig(env){
  if(!env.CLOUDFLARE_API_TOKEN) throw new Error("未配置 CLOUDFLARE_API_TOKEN");
  if(!env.CLOUDFLARE_ACCOUNT_ID) throw new Error("未配置 CLOUDFLARE_ACCOUNT_ID");
  return {token:env.CLOUDFLARE_API_TOKEN,account:env.CLOUDFLARE_ACCOUNT_ID};
}
async function rest(path,token){
  const r=await fetch(API+path,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok || d.success===false) throw new Error(d.errors?.map(e=>e.message).join("; ")||`Cloudflare REST ${r.status}`);
  return d.result;
}
/* Cloudflare has several REST endpoints whose result is an array and several
   whose result is an object containing a result array. Normalize all of them. */
function arr(v){
  if(Array.isArray(v)) return v;
  if(v && Array.isArray(v.result)) return v.result;
  if(v && Array.isArray(v.items)) return v.items;
  if(v && Array.isArray(v.buckets)) return v.buckets;
  if(v && Array.isArray(v.namespaces)) return v.namespaces;
  if(v && Array.isArray(v.scripts)) return v.scripts;
  return [];
}
async function gql(query,variables,token){
  const r=await fetch(GQL,{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,Accept:"application/json","Content-Type":"application/json"},
    body:JSON.stringify({query,variables})
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok || d.errors?.length) throw new Error(d.errors?.map(e=>e.message).join("; ")||`GraphQL ${r.status}`);
  return d.data;
}
function range(url,kind="time"){
  const days=Math.min(31,Math.max(1,Number(url.searchParams.get("days")||7)));
  const end=new Date(), start=new Date(end.getTime()-days*86400000);
  const date=s=>s.toISOString().slice(0,10);
  return kind==="date"
    ? {days,start:date(start),end:date(end)}
    : {days,start:start.toISOString(),end:end.toISOString()};
}
const num=v=>Number(v||0);
const sum=(rows,fn)=>rows.reduce((a,r)=>a+num(fn(r)),0);
const by=(rows,key,fn)=>{
  const m={};
  for(const r of rows){const k=String(key(r)??"Unknown");m[k]=(m[k]||0)+num(fn(r));}
  return Object.entries(m).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value);
};
const trend=(rows,dateFn,fn)=>{
  const m={};
  for(const r of rows){const d=dateFn(r);if(d)m[d]=(m[d]||0)+num(fn(r));}
  return Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,value])=>({date,value}));
};

async function inventory(env){
  const {token,account}=envConfig(env);
  const jobs={
    zones:rest("/zones?per_page=100",token),
    workers:rest(`/accounts/${account}/workers/scripts?per_page=100`,token),
    d1:rest(`/accounts/${account}/d1/database?per_page=100`,token),
    kv:rest(`/accounts/${account}/storage/kv/namespaces?per_page=100`,token),
    r2:rest(`/accounts/${account}/r2/buckets?per_page=100`,token),
    durableObjects:rest(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100`,token),
    queues:rest(`/accounts/${account}/queues?per_page=100`,token).catch(()=>[]),
    workflows:rest(`/accounts/${account}/workflows?per_page=100`,token).catch(()=>[])
  };
  const out={},warnings=[];
  for(const [k,p] of Object.entries(jobs)){
    try{out[k]=arr(await p)}catch(e){out[k]=[];warnings.push({module:k,error:e.message})}
  }
  return {
    counts:Object.fromEntries(Object.entries(out).map(([k,v])=>[k,v.length])),
    warnings,
    resources:{
      zones:out.zones.map(x=>({id:x.id,name:x.name,status:x.status,plan:x.plan?.name||""})),
      workers:out.workers.map(x=>({id:x.id,name:x.id,created:x.created_on,modified:x.modified_on})),
      d1:out.d1.map(x=>({id:x.uuid,name:x.name,size:x.file_size||0})),
      kv:out.kv.map(x=>({id:x.id,name:x.title})),
      r2:out.r2.map(x=>({name:x.name,created:x.creation_date})),
      durableObjects:out.durableObjects.map(x=>({id:x.id,name:x.name,script:x.script})),
      queues:out.queues.map(x=>({id:x.queue_id||x.id,name:x.queue_name||x.name})),
      workflows:out.workflows.map(x=>({id:x.id,name:x.name}))
    }
  };
}

async function workers(env,url){
  const {token,account}=envConfig(env),r=range(url);
  const q=`query($a:String!,$s:String!,$e:String!){
    viewer{accounts(filter:{accountTag:$a}){
      workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        sum{requests errors subrequests}
        quantiles{cpuTimeP50 cpuTimeP99}
        dimensions{datetime scriptName status}
      }
    }}}`;
  const rows=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]?.workersInvocationsAdaptive||[];
  return {days:r.days,requests:sum(rows,x=>x.sum?.requests),errors:sum(rows,x=>x.sum?.errors),
    subrequests:sum(rows,x=>x.sum?.subrequests),cpuP50:rows.length?rows.reduce((a,x)=>a+num(x.quantiles?.cpuTimeP50),0)/rows.length:0,
    cpuP99:rows.length?rows.reduce((a,x)=>a+num(x.quantiles?.cpuTimeP99),0)/rows.length:0,
    trend:trend(rows,x=>x.dimensions?.datetime?.slice(0,13),x=>x.sum?.requests),
    errorsTrend:trend(rows,x=>x.dimensions?.datetime?.slice(0,13),x=>x.sum?.errors),
    scripts:by(rows,x=>x.dimensions?.scriptName,x=>x.sum?.requests),
    statuses:by(rows,x=>x.dimensions?.status,x=>x.sum?.requests)};
}

async function d1(env,url){
  const {token,account}=envConfig(env),r=range(url,"date");
  const q=`query($a:String!,$s:Date!,$e:Date!){
    viewer{accounts(filter:{accountTag:$a}){
      d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes queryBatchTimeMs databaseSizeBytes}
        quantiles{queryBatchTimeMsP50 queryBatchTimeMsP90 queryBatchTimeMsP99}
        dimensions{date databaseId}
      }
    }}}`;
  const rows=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]?.d1AnalyticsAdaptiveGroups||[];
  return {days:r.days,readQueries:sum(rows,x=>x.sum?.readQueries),writeQueries:sum(rows,x=>x.sum?.writeQueries),
    rowsRead:sum(rows,x=>x.sum?.rowsRead),rowsWritten:sum(rows,x=>x.sum?.rowsWritten),
    responseBytes:sum(rows,x=>x.sum?.queryBatchResponseBytes),latency:sum(rows,x=>x.sum?.queryBatchTimeMs),
    storage:Math.max(0,...rows.map(x=>num(x.sum?.databaseSizeBytes))),
    p50:rows.length?rows.reduce((a,x)=>a+num(x.quantiles?.queryBatchTimeMsP50),0)/rows.length:0,
    p90:rows.length?rows.reduce((a,x)=>a+num(x.quantiles?.queryBatchTimeMsP90),0)/rows.length:0,
    p99:rows.length?rows.reduce((a,x)=>a+num(x.quantiles?.queryBatchTimeMsP99),0)/rows.length:0,
    readTrend:trend(rows,x=>x.dimensions?.date,x=>x.sum?.rowsRead),writeTrend:trend(rows,x=>x.dimensions?.date,x=>x.sum?.rowsWritten),
    databases:by(rows,x=>x.dimensions?.databaseId,x=>x.sum?.rowsRead)};
}

async function kv(env,url){
  const {token,account}=envConfig(env),r=range(url,"date");
  const q=`query($a:String!,$s:Date!,$e:Date!){
    viewer{accounts(filter:{accountTag:$a}){
      kvOperationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{requests} dimensions{date actionType namespaceId}
        quantiles{latencyMsP50 latencyMsP90 latencyMsP99}
      }
      kvStorageAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        max{keyCount byteCount} dimensions{date namespaceId}
      }
    }}}`;
  const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
  const ops=a.kvOperationsAdaptiveGroups||[],st=a.kvStorageAdaptiveGroups||[];
  return {days:r.days,operations:sum(ops,x=>x.sum?.requests),reads:sum(ops,x=>x.dimensions?.actionType==="read"?x.sum?.requests:0),
    writes:sum(ops,x=>x.dimensions?.actionType==="write"?x.sum?.requests:0),
    deletes:sum(ops,x=>x.dimensions?.actionType==="delete"?x.sum?.requests:0),
    lists:sum(ops,x=>x.dimensions?.actionType==="list"?x.sum?.requests:0),
    storage:Math.max(0,...st.map(x=>num(x.max?.byteCount))),keys:Math.max(0,...st.map(x=>num(x.max?.keyCount))),
    trend:trend(ops,x=>x.dimensions?.date,x=>x.sum?.requests),actions:by(ops,x=>x.dimensions?.actionType,x=>x.sum?.requests),
    namespaces:by(ops,x=>x.dimensions?.namespaceId,x=>x.sum?.requests)};
}

async function r2(env,url){
  const {token,account}=envConfig(env),r=range(url);
  const q=`query($a:String!,$s:Time!,$e:Time!){
    viewer{accounts(filter:{accountTag:$a}){
      r2OperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        sum{requests} dimensions{datetime actionType actionStatus bucketName responseStatusCode}
      }
      r2StorageAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        max{objectCount uploadCount payloadSize metadataSize} dimensions{datetime bucketName}
      }
    }}}`;
  const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
  const ops=a.r2OperationsAdaptiveGroups||[],st=a.r2StorageAdaptiveGroups||[];
  return {days:r.days,operations:sum(ops,x=>x.sum?.requests),storage:Math.max(0,...st.map(x=>num(x.max?.payloadSize))),
    metadata:Math.max(0,...st.map(x=>num(x.max?.metadataSize))),objects:Math.max(0,...st.map(x=>num(x.max?.objectCount))),
    uploads:Math.max(0,...st.map(x=>num(x.max?.uploadCount))),
    trend:trend(ops,x=>x.dimensions?.datetime?.slice(0,10),x=>x.sum?.requests),
    actions:by(ops,x=>x.dimensions?.actionType,x=>x.sum?.requests),
    statuses:by(ops,x=>x.dimensions?.responseStatusCode,x=>x.sum?.requests),
    buckets:by(ops,x=>x.dimensions?.bucketName,x=>x.sum?.requests)};
}

async function durableObjects(env,url){
  const {token,account}=envConfig(env),r=range(url,"date");
  const q=`query($a:String!,$s:Date!,$e:Date!){
    viewer{accounts(filter:{accountTag:$a}){
      durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{requests responseBodySize} dimensions{date namespaceName}
      }
      durableObjectsPeriodicGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{cpuTime} quantiles{memoryUsageBytesP50 memoryUsageBytesP90 memoryUsageBytesP99} dimensions{date namespaceName}
      }
      durableObjectsStorageGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        max{storedBytes} dimensions{date namespaceName}
      }
      durableObjectsSubrequestsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{requests} dimensions{date namespaceName}
      }
    }}}`;
  const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
  const inv=a.durableObjectsInvocationsAdaptiveGroups||[],per=a.durableObjectsPeriodicGroups||[],st=a.durableObjectsStorageGroups||[],sub=a.durableObjectsSubrequestsAdaptiveGroups||[];
  return {days:r.days,requests:sum(inv,x=>x.sum?.requests),responseBytes:sum(inv,x=>x.sum?.responseBodySize),
    cpu:sum(per,x=>x.sum?.cpuTime),subrequests:sum(sub,x=>x.sum?.requests),storage:Math.max(0,...st.map(x=>num(x.max?.storedBytes))),
    memoryP50:Math.max(0,...per.map(x=>num(x.quantiles?.memoryUsageBytesP50))),
    memoryP99:Math.max(0,...per.map(x=>num(x.quantiles?.memoryUsageBytesP99))),
    trend:trend(inv,x=>x.dimensions?.date,x=>x.sum?.requests),namespaces:by(inv,x=>x.dimensions?.namespaceName,x=>x.sum?.requests)};
}

async function zone(env,url){
  const {token}=envConfig(env),zoneTag=url.searchParams.get("zone");
  if(!zoneTag) throw new Error("缺少 zone 参数");
  const r=range(url);
  const q=`query($z:String!,$s:Time!,$e:Time!){
    viewer{zones(filter:{zoneTag:$z}){
      httpRequestsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        count sum{edgeResponseBytes visits} dimensions{datetimeHour clientCountryName clientBrowserFamily clientDeviceType edgeResponseStatus coloCode cacheStatus}
      }
      firewallEventsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        count dimensions{datetime action clientCountryName source}
      }
    }}}`;
  const z=(await gql(q,{z:zoneTag,s:r.start,e:r.end},token)).viewer.zones?.[0]||{};
  const h=z.httpRequestsAdaptiveGroups||[],fw=z.firewallEventsAdaptiveGroups||[];
  return {days:r.days,requests:sum(h,x=>x.count),bytes:sum(h,x=>x.sum?.edgeResponseBytes),visits:sum(h,x=>x.sum?.visits),
    cacheHits:sum(h,x=>x.dimensions?.cacheStatus==="hit"?x.count:0),
    trend:trend(h,x=>x.dimensions?.datetimeHour,x=>x.count),trafficTrend:trend(h,x=>x.dimensions?.datetimeHour,x=>x.sum?.edgeResponseBytes),
    countries:by(h,x=>x.dimensions?.clientCountryName,x=>x.count),browsers:by(h,x=>x.dimensions?.clientBrowserFamily,x=>x.count),
    devices:by(h,x=>x.dimensions?.clientDeviceType,x=>x.count),statuses:by(h,x=>x.dimensions?.edgeResponseStatus,x=>x.count),
    colos:by(h,x=>x.dimensions?.coloCode,x=>x.count),cache:by(h,x=>x.dimensions?.cacheStatus,x=>x.count),
    threats:sum(fw,x=>x.count),threatActions:by(fw,x=>x.dimensions?.action,x=>x.count),
    threatCountries:by(fw,x=>x.dimensions?.clientCountryName,x=>x.count),sources:by(fw,x=>x.dimensions?.source,x=>x.count)};
}

async function introspection(env){
  const {token}=envConfig(env);
  const q=`{__schema{queryType{fields{name}}}}`;
  return (await gql(q,{},token)).__schema.queryType.fields.map(x=>x.name);
}

export async function onRequest({request,env}){
  const u=new URL(request.url),p=u.pathname.replace(/^\/api\/?/,"");
  try{
    if(p==="config") return good({siteName:env.SITE_NAME||"Cloudflare Status"});
    if(p==="inventory") return good(await inventory(env));
    if(p==="workers") return good(await workers(env,u));
    if(p==="d1") return good(await d1(env,u));
    if(p==="kv") return good(await kv(env,u));
    if(p==="r2") return good(await r2(env,u));
    if(p==="do") return good(await durableObjects(env,u));
    if(p==="zone") return good(await zone(env,u));
    if(p==="schema") return good({fields:await introspection(env)});
    return fail("API 不存在",404);
  }catch(e){
    return fail(e.message||String(e));
  }
}
