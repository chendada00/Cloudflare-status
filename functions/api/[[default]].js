
const API = "https://api.cloudflare.com/client/v4";
const GQL = API + "/graphql";

const response = (body, status=200) => new Response(JSON.stringify(body), {
  status,
  headers: {"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
});
const ok = data => response({success:true,data});
const err = (message,status=500,details) => response({success:false,error:String(message),details},status);
const arr = v => {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.result)) return v.result;
  if (v && Array.isArray(v.items)) return v.items;
  return [];
};
const n = v => Number(v ?? 0) || 0;

function cfg(env){
  if(!env.CLOUDFLARE_API_TOKEN) throw new Error("未配置 CLOUDFLARE_API_TOKEN");
  if(!env.CLOUDFLARE_ACCOUNT_ID) throw new Error("未配置 CLOUDFLARE_ACCOUNT_ID");
  return {token:env.CLOUDFLARE_API_TOKEN, account:env.CLOUDFLARE_ACCOUNT_ID};
}
async function rest(path, token){
  const r=await fetch(API+path,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok || d.success===false) throw new Error(d.errors?.map(x=>x.message).join("; ")||`Cloudflare REST ${r.status}`);
  return d.result;
}
async function gql(query, variables, token){
  const r=await fetch(GQL,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({query,variables})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok || d.errors?.length) {
    const msg=(d.errors||[]).map(x=>x.message).join("; ")||`GraphQL HTTP ${r.status}`;
    const e=new Error(msg); e.graphql=d.errors||[]; throw e;
  }
  return d.data;
}
function dates(days, type="time"){
  const d=Math.min(31,Math.max(1,Number(days||7)));
  const end=new Date();
  const start=new Date(end.getTime()-d*86400000);
  if(type==="date") return {days:d,start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};
  return {days:d,start:start.toISOString(),end:end.toISOString()};
}
function sum(rows, f){return (rows||[]).reduce((a,r)=>a+n(f(r)),0)}
function group(rows, key, val){
  const m=new Map();
  for(const r of rows||[]){const k=String(key(r) ?? "Unknown");m.set(k,(m.get(k)||0)+n(val(r)))}
  return [...m].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value);
}
function series(rows, key, val){
  const m=new Map();
  for(const r of rows||[]){const k=key(r);if(k)m.set(k,(m.get(k)||0)+n(val(r)))}
  return [...m].map(([date,value])=>({date,value})).sort((a,b)=>a.date.localeCompare(b.date));
}
function avg(rows,f){return rows?.length ? rows.reduce((a,r)=>a+n(f(r)),0)/rows.length : 0}

async function inventory(env){
  const {token,account}=cfg(env);
  const jobs = {
    zones: rest("/zones?per_page=100",token),
    workers: rest(`/accounts/${account}/workers/scripts?per_page=100`,token),
    d1: rest(`/accounts/${account}/d1/database?per_page=100`,token),
    kv: rest(`/accounts/${account}/storage/kv/namespaces?per_page=100`,token),
    r2: rest(`/accounts/${account}/r2/buckets?per_page=100`,token),
    durableObjects: rest(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100`,token),
    queues: rest(`/accounts/${account}/queues?per_page=100`,token).catch(()=>[]),
    workflows: rest(`/accounts/${account}/workflows?per_page=100`,token).catch(()=>[])
  };
  const resources={},warnings=[];
  for(const [k,p] of Object.entries(jobs)){
    try{resources[k]=arr(await p)}catch(e){resources[k]=[];warnings.push({module:k,error:e.message})}
  }
  return {
    counts:Object.fromEntries(Object.entries(resources).map(([k,v])=>[k,v.length])),
    resources:{
      zones:resources.zones.map(x=>({id:x.id,name:x.name,status:x.status,plan:x.plan?.name||""})),
      workers:resources.workers.map(x=>({id:x.id,name:x.id,created:x.created_on,modified:x.modified_on})),
      d1:resources.d1.map(x=>({id:x.uuid,name:x.name,size:x.file_size||0})),
      kv:resources.kv.map(x=>({id:x.id,name:x.title})),
      r2:resources.r2.map(x=>({name:x.name,created:x.creation_date})),
      durableObjects:resources.durableObjects.map(x=>({id:x.id,name:x.name,script:x.script})),
      queues:resources.queues.map(x=>({id:x.queue_id||x.id,name:x.queue_name||x.name})),
      workflows:resources.workflows.map(x=>({id:x.id,name:x.name}))
    },
    warnings
  };
}

async function workers(env,url){
  const {token,account}=cfg(env),r=dates(url.searchParams.get("days"));
  const q=`query($a:String!,$s:Time!,$e:Time!){
    viewer{accounts(filter:{accountTag:$a}){
      workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        sum{requests errors subrequests}
        quantiles{cpuTimeP50 cpuTimeP99}
        dimensions{datetime scriptName status}
      }
    }}}`;
  const a=await gql(q,{a:account,s:r.start,e:r.end},token);
  const rows=a.viewer.accounts?.[0]?.workersInvocationsAdaptive;
  if(!Array.isArray(rows)) throw new Error("Workers Analytics 返回结构不是数组");
  return {
    days:r.days, requests:sum(rows,x=>x.sum?.requests), errors:sum(rows,x=>x.sum?.errors),
    subrequests:sum(rows,x=>x.sum?.subrequests), cpuP50:avg(rows,x=>x.quantiles?.cpuTimeP50),
    cpuP99:avg(rows,x=>x.quantiles?.cpuTimeP99),
    trend:series(rows,x=>x.dimensions?.datetime?.slice(0,13),x=>x.sum?.requests),
    errorTrend:series(rows,x=>x.dimensions?.datetime?.slice(0,13),x=>x.sum?.errors),
    scripts:group(rows,x=>x.dimensions?.scriptName,x=>x.sum?.requests),
    statuses:group(rows,x=>x.dimensions?.status,x=>x.sum?.requests)
  };
}

async function d1(env,url){
  const {token,account}=cfg(env),r=dates(url.searchParams.get("days"),"date");
  const q=`query($a:String!,$s:Date!,$e:Date!){
    viewer{accounts(filter:{accountTag:$a}){
      analytics:d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes queryBatchTimeMs databaseSizeBytes}
        quantiles{queryBatchTimeMsP50 queryBatchTimeMsP90 queryBatchTimeMsP99}
        dimensions{date databaseId}
      }
      storage:d1StorageAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        max{databaseSizeBytes}
        dimensions{date databaseId}
      }
    }}}`;
  const a=await gql(q,{a:account,s:r.start,e:r.end},token);
  const ac=a.viewer.accounts?.[0]||{};
  const rows=Array.isArray(ac.analytics)?ac.analytics:[];
  const storage=Array.isArray(ac.storage)?ac.storage:[];
  const sizes=storage.map(x=>n(x.max?.databaseSizeBytes));
  return {
    days:r.days,readQueries:sum(rows,x=>x.sum?.readQueries),writeQueries:sum(rows,x=>x.sum?.writeQueries),
    rowsRead:sum(rows,x=>x.sum?.rowsRead),rowsWritten:sum(rows,x=>x.sum?.rowsWritten),
    responseBytes:sum(rows,x=>x.sum?.queryBatchResponseBytes),latency:sum(rows,x=>x.sum?.queryBatchTimeMs),
    storage:Math.max(0,...sizes),p50:avg(rows,x=>x.quantiles?.queryBatchTimeMsP50),
    p90:avg(rows,x=>x.quantiles?.queryBatchTimeMsP90),p99:avg(rows,x=>x.quantiles?.queryBatchTimeMsP99),
    readTrend:series(rows,x=>x.dimensions?.date,x=>x.sum?.rowsRead),
    writeTrend:series(rows,x=>x.dimensions?.date,x=>x.sum?.rowsWritten),
    databases:group(rows,x=>x.dimensions?.databaseId,x=>x.sum?.rowsRead),
    storageTrend:series(storage,x=>x.dimensions?.date,x=>x.max?.databaseSizeBytes)
  };
}

async function kv(env,url){
  const {token,account}=cfg(env),r=dates(url.searchParams.get("days"),"date");
  const q=`query($a:String!,$s:Date!,$e:Date!){
    viewer{accounts(filter:{accountTag:$a}){
      operations:kvOperationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{requests} quantiles{latencyMsP50 latencyMsP90 latencyMsP99}
        dimensions{date actionType namespaceId}
      }
      storage:kvStorageAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        max{keyCount byteCount} dimensions{date namespaceId}
      }
    }}}`;
  const a=await gql(q,{a:account,s:r.start,e:r.end},token),ac=a.viewer.accounts?.[0]||{};
  const ops=Array.isArray(ac.operations)?ac.operations:[],st=Array.isArray(ac.storage)?ac.storage:[];
  return {
    days:r.days,operations:sum(ops,x=>x.sum?.requests),
    reads:sum(ops,x=>x.dimensions?.actionType==="read"?x.sum?.requests:0),
    writes:sum(ops,x=>x.dimensions?.actionType==="write"?x.sum?.requests:0),
    deletes:sum(ops,x=>x.dimensions?.actionType==="delete"?x.sum?.requests:0),
    lists:sum(ops,x=>x.dimensions?.actionType==="list"?x.sum?.requests:0),
    storage:Math.max(0,...st.map(x=>n(x.max?.byteCount))),
    keys:Math.max(0,...st.map(x=>n(x.max?.keyCount))),
    p50:avg(ops,x=>x.quantiles?.latencyMsP50),p99:avg(ops,x=>x.quantiles?.latencyMsP99),
    trend:series(ops,x=>x.dimensions?.date,x=>x.sum?.requests),
    actions:group(ops,x=>x.dimensions?.actionType,x=>x.sum?.requests),
    namespaces:group(ops,x=>x.dimensions?.namespaceId,x=>x.sum?.requests),
    storageTrend:series(st,x=>x.dimensions?.date,x=>x.max?.byteCount)
  };
}

async function r2(env,url){
  const {token,account}=cfg(env),r=dates(url.searchParams.get("days"));
  const q=`query($a:String!,$s:Time!,$e:Time!){
    viewer{accounts(filter:{accountTag:$a}){
      operations:r2OperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        sum{requests} dimensions{datetime actionType actionStatus bucketName responseStatusCode}
      }
      storage:r2StorageAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        max{objectCount uploadCount payloadSize metadataSize} dimensions{datetime bucketName}
      }
    }}}`;
  const a=await gql(q,{a:account,s:r.start,e:r.end},token),ac=a.viewer.accounts?.[0]||{};
  const ops=Array.isArray(ac.operations)?ac.operations:[],st=Array.isArray(ac.storage)?ac.storage:[];
  return {
    days:r.days,operations:sum(ops,x=>x.sum?.requests),
    storage:Math.max(0,...st.map(x=>n(x.max?.payloadSize))),
    metadata:Math.max(0,...st.map(x=>n(x.max?.metadataSize))),
    objects:Math.max(0,...st.map(x=>n(x.max?.objectCount))),
    uploads:Math.max(0,...st.map(x=>n(x.max?.uploadCount))),
    trend:series(ops,x=>x.dimensions?.datetime?.slice(0,10),x=>x.sum?.requests),
    actions:group(ops,x=>x.dimensions?.actionType,x=>x.sum?.requests),
    statuses:group(ops,x=>x.dimensions?.responseStatusCode,x=>x.sum?.requests),
    buckets:group(ops,x=>x.dimensions?.bucketName,x=>x.sum?.requests)
  };
}

async function durableObjects(env,url){
  const {token,account}=cfg(env),r=dates(url.searchParams.get("days"),"date");
  const q=`query($a:String!,$s:Date!,$e:Date!){
    viewer{accounts(filter:{accountTag:$a}){
      inv:durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{requests responseBodySize} dimensions{date namespaceName}
      }
      periodic:durableObjectsPeriodicGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{cpuTime} quantiles{memoryUsageBytesP50 memoryUsageBytesP90 memoryUsageBytesP99}
        dimensions{date namespaceName}
      }
      storage:durableObjectsStorageGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        max{storedBytes} dimensions{date namespaceName}
      }
      sub:durableObjectsSubrequestsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{requests} dimensions{date namespaceName}
      }
    }}}`;
  const a=await gql(q,{a:account,s:r.start,e:r.end},token),ac=a.viewer.accounts?.[0]||{};
  const inv=Array.isArray(ac.inv)?ac.inv:[],per=Array.isArray(ac.periodic)?ac.periodic:[],st=Array.isArray(ac.storage)?ac.storage:[],sub=Array.isArray(ac.sub)?ac.sub:[];
  return {
    days:r.days,requests:sum(inv,x=>x.sum?.requests),responseBytes:sum(inv,x=>x.sum?.responseBodySize),
    cpu:sum(per,x=>x.sum?.cpuTime),subrequests:sum(sub,x=>x.sum?.requests),
    storage:Math.max(0,...st.map(x=>n(x.max?.storedBytes))),
    memoryP50:Math.max(0,...per.map(x=>n(x.quantiles?.memoryUsageBytesP50))),
    memoryP90:Math.max(0,...per.map(x=>n(x.quantiles?.memoryUsageBytesP90))),
    memoryP99:Math.max(0,...per.map(x=>n(x.quantiles?.memoryUsageBytesP99))),
    trend:series(inv,x=>x.dimensions?.date,x=>x.sum?.requests),
    namespaces:group(inv,x=>x.dimensions?.namespaceName,x=>x.sum?.requests)
  };
}

async function zone(env,url){
  const {token}=cfg(env), zoneTag=url.searchParams.get("zone");
  if(!zoneTag) throw new Error("缺少 zone 参数");
  const r=dates(url.searchParams.get("days"));
  // Keep HTTP and Firewall queries separate. A field mismatch in the optional
  // security dataset must not destroy the entire Zone dashboard.
  const httpQ=`query($z:String!,$s:Time!,$e:Time!){
    viewer{zones(filter:{zoneTag:$z}){
      httpRequestsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e,requestSource:"eyeball"}){
        count sum{edgeResponseBytes visits}
        dimensions{datetimeHour clientCountryName clientBrowserFamily clientDeviceType edgeResponseStatus coloCode cacheStatus}
      }
    }}}`;
  const firewallQ=`query($z:String!,$s:Time!,$e:Time!){
    viewer{zones(filter:{zoneTag:$z}){
      firewallEventsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        count dimensions{datetimeHour action clientCountryName source}
      }
    }}}`;
  let httpRows=[],fwRows=[],warnings=[];
  try{
    const a=await gql(httpQ,{z:zoneTag,s:r.start,e:r.end},token);
    httpRows=a.viewer.zones?.[0]?.httpRequestsAdaptiveGroups;
    if(!Array.isArray(httpRows)) throw new Error("HTTP Analytics 返回结构不是数组");
  }catch(e){warnings.push("HTTP Analytics: "+e.message)}
  try{
    const a=await gql(firewallQ,{z:zoneTag,s:r.start,e:r.end},token);
    fwRows=a.viewer.zones?.[0]?.firewallEventsAdaptiveGroups;
    if(!Array.isArray(fwRows)) throw new Error("Firewall Analytics 返回结构不是数组");
  }catch(e){warnings.push("Firewall Analytics: "+e.message)}
  if(!httpRows.length && warnings.length===2) throw new Error(warnings.join(" | "));
  return {
    days:r.days,requests:sum(httpRows,x=>x.count),visits:sum(httpRows,x=>x.sum?.visits),
    bytes:sum(httpRows,x=>x.sum?.edgeResponseBytes),
    cacheHits:sum(httpRows,x=>String(x.dimensions?.cacheStatus).toLowerCase()==="hit"?x.count:0),
    trend:series(httpRows,x=>x.dimensions?.datetimeHour,x=>x.count),
    trafficTrend:series(httpRows,x=>x.dimensions?.datetimeHour,x=>x.sum?.edgeResponseBytes),
    countries:group(httpRows,x=>x.dimensions?.clientCountryName,x=>x.count),
    browsers:group(httpRows,x=>x.dimensions?.clientBrowserFamily,x=>x.count),
    devices:group(httpRows,x=>x.dimensions?.clientDeviceType,x=>x.count),
    statuses:group(httpRows,x=>x.dimensions?.edgeResponseStatus,x=>x.count),
    colos:group(httpRows,x=>x.dimensions?.coloCode,x=>x.count),
    cache:group(httpRows,x=>x.dimensions?.cacheStatus,x=>x.count),
    threats:sum(fwRows,x=>x.count),
    threatTrend:series(fwRows,x=>x.dimensions?.datetimeHour,x=>x.count),
    threatActions:group(fwRows,x=>x.dimensions?.action,x=>x.count),
    threatCountries:group(fwRows,x=>x.dimensions?.clientCountryName,x=>x.count),
    sources:group(fwRows,x=>x.dimensions?.source,x=>x.count),
    warnings
  };
}

async function zoneOrigins(env,url){
  const {token}=cfg(env),z=url.searchParams.get("zone"); if(!z) throw new Error("缺少 zone 参数");
  // Origin traffic metrics are not assumed to exist on every account.
  const r=dates(url.searchParams.get("days"));
  const q=`query($z:String!,$s:Time!,$e:Time!){
    viewer{zones(filter:{zoneTag:$z}){
      httpRequestsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e,requestSource:"eyeball"}){
        count sum{edgeResponseBytes}
        dimensions{datetimeHour cacheStatus edgeResponseStatus}
      }
    }}}`;
  const a=await gql(q,{z,s:r.start,e:r.end},token),rows=a.viewer.zones?.[0]?.httpRequestsAdaptiveGroups||[];
  return {days:r.days,requests:sum(rows,x=>x.count),bytes:sum(rows,x=>x.sum?.edgeResponseBytes),
    cached:sum(rows,x=>String(x.dimensions?.cacheStatus).toLowerCase()==="hit"?x.count:0),
    origin:sum(rows,x=>String(x.dimensions?.cacheStatus).toLowerCase()==="hit"?0:x.count),
    trend:series(rows,x=>x.dimensions?.datetimeHour,x=>x.count)};
}

async function schema(env){
  const {token}=cfg(env);
  const q=`{__schema{queryType{fields{name}}}}`;
  const d=await gql(q,{},token);
  return d.__schema.queryType.fields.map(x=>x.name).sort();
}

export async function onRequest({request,env}){
  const u=new URL(request.url), p=u.pathname.replace(/^\/api\/?/,"");
  try{
    if(p==="config") return ok({siteName:env.SITE_NAME||"Cloudflare Status",version:"4.0.0"});
    if(p==="inventory") return ok(await inventory(env));
    if(p==="workers") return ok(await workers(env,u));
    if(p==="d1") return ok(await d1(env,u));
    if(p==="kv") return ok(await kv(env,u));
    if(p==="r2") return ok(await r2(env,u));
    if(p==="do") return ok(await durableObjects(env,u));
    if(p==="zone") return ok(await zone(env,u));
    if(p==="zone-origins") return ok(await zoneOrigins(env,u));
    if(p==="schema") return ok({fields:await schema(env)});
    return err("API 不存在",404);
  }catch(e){return err(e.message||String(e),500,e.graphql||undefined)}
}
