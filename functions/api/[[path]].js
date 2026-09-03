const API="https://api.cloudflare.com/client/v4";
const GQL=`${API}/graphql`;

const json=(x,s=200)=>new Response(JSON.stringify(x),{
  status:s,headers:{"content-type":"application/json;charset=utf-8","cache-control":"no-store"}
});
const ok=data=>json({success:true,data});
const fail=(error,s=500)=>json({success:false,error:String(error)},s);
const n=v=>Number(v??0)||0;
const arr=v=>Array.isArray(v)?v:(v?.result||v?.items||v?.buckets||v?.namespaces||v?.scripts||[]);
const sum=(a,f)=>a.reduce((x,r)=>x+n(f(r)),0);
const avg=(a,f)=>a.length?sum(a,f)/a.length:0;

function group(a,k,f){
  const m=new Map();
  for(const r of a){
    const x=String(k(r)??"Unknown");
    m.set(x,(m.get(x)||0)+n(f(r)));
  }
  return [...m].map(([name,value])=>({name,value}))
    .sort((a,b)=>b.value-a.value);
}
function trend(a,k,f){
  const m=new Map();
  for(const r of a){
    const x=k(r);
    if(x)m.set(x,(m.get(x)||0)+n(f(r)));
  }
  return [...m].map(([date,value])=>({date,value}))
    .sort((a,b)=>a.date.localeCompare(b.date));
}
function cfg(env){
  if(!env.CLOUDFLARE_API_TOKEN)throw Error("未配置 CLOUDFLARE_API_TOKEN");
  if(!env.CLOUDFLARE_ACCOUNT_ID)throw Error("未配置 CLOUDFLARE_ACCOUNT_ID");
  return{token:env.CLOUDFLARE_API_TOKEN,account:env.CLOUDFLARE_ACCOUNT_ID};
}
async function rest(path,token){
  const r=await fetch(API+path,{
    headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d.success===false)
    throw Error(d.errors?.map(x=>x.message).join("; ")||`REST ${r.status}`);
  return d.result;
}
async function gql(query,variables,token){
  const r=await fetch(GQL,{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:JSON.stringify({query,variables})
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d.errors?.length)
    throw Error(d.errors?.map(x=>x.message).join("; ")||`GraphQL ${r.status}`);
  return d.data;
}
function range(u,kind="time"){
  const period=u.searchParams.get("period")||"24h";
  const days=Math.min(30,Math.max(1,Number(u.searchParams.get("days")||1)));
  const now=new Date();
  if(period==="today"){
    const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
    return kind==="date"
      ?{days:1,start:start.toISOString().slice(0,10),end:start.toISOString().slice(0,10),period}
      :{days:1,start:start.toISOString(),end:now.toISOString(),period};
  }
  const start=new Date(now-days*86400000);
  return kind==="date"
    ?{days,start:start.toISOString().slice(0,10),end:now.toISOString().slice(0,10),period}
    :{days,start:start.toISOString(),end:now.toISOString(),period};
}

async function inventory(env){
  const{token,account}=cfg(env);
  const jobs={
    zones:rest("/zones?per_page=100",token),
    workers:rest(`/accounts/${account}/workers/scripts?per_page=100`,token),
    d1:rest(`/accounts/${account}/d1/database?per_page=100`,token),
    kv:rest(`/accounts/${account}/storage/kv/namespaces?per_page=100`,token),
    r2:rest(`/accounts/${account}/r2/buckets?per_page=100`,token),
    durableObjects:rest(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100`,token)
  };
  const out={},warnings=[];
  for(const[k,p]of Object.entries(jobs)){
    try{out[k]=arr(await p)}
    catch(e){out[k]=[];warnings.push({module:k,error:e.message})}
  }
  return{
    counts:Object.fromEntries(Object.entries(out).map(([k,v])=>[k,v.length])),
    warnings,
    resources:{
      zones:out.zones.map(x=>({id:x.id,name:x.name,status:x.status,plan:x.plan?.name||""})),
      workers:out.workers.map(x=>({id:x.id,name:x.id,modified:x.modified_on})),
      d1:out.d1.map(x=>({id:x.uuid,name:x.name,size:x.file_size||0})),
      kv:out.kv.map(x=>({id:x.id,name:x.title})),
      r2:out.r2.map(x=>({id:x.name,name:x.name,created:x.creation_date})),
      durableObjects:out.durableObjects.map(x=>({id:x.id,name:x.name,script:x.script}))
    }
  };
}

async function workers(env,u){
  const{token,account}=cfg(env),r=range(u);
  const q=`query($a:String!,$s:Time!,$e:Time!){
    viewer{accounts(filter:{accountTag:$a}){
      workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        sum{requests errors subrequests}
        quantiles{cpuTimeP50 cpuTimeP99 memoryUsageBytesP50 memoryUsageBytesP90 memoryUsageBytesP99}
        dimensions{datetime scriptName status}
      }
    }}
  }`;
  const rows=(await gql(q,{a:account,s:r.start,e:r.end},token))
    .viewer.accounts?.[0]?.workersInvocationsAdaptive||[];
  return{
    days:r.days,
    requests:sum(rows,x=>x.sum?.requests),
    errors:sum(rows,x=>x.sum?.errors),
    subrequests:sum(rows,x=>x.sum?.subrequests),
    cpuP50:avg(rows,x=>x.quantiles?.cpuTimeP50),
    cpuP99:avg(rows,x=>x.quantiles?.cpuTimeP99),
    memoryP50:avg(rows,x=>x.quantiles?.memoryUsageBytesP50),
    memoryP90:avg(rows,x=>x.quantiles?.memoryUsageBytesP90),
    memoryP99:avg(rows,x=>x.quantiles?.memoryUsageBytesP99),
    trend:trend(rows,x=>x.dimensions?.datetime?.slice(0,13),x=>x.sum?.requests),
    errorTrend:trend(rows,x=>x.dimensions?.datetime?.slice(0,13),x=>x.sum?.errors),
    scripts:group(rows,x=>x.dimensions?.scriptName,x=>x.sum?.requests),
    statuses:group(rows,x=>x.dimensions?.status,x=>x.sum?.requests),
    memoryTrend:trend(rows,x=>x.dimensions?.datetime?.slice(0,13),x=>x.quantiles?.memoryUsageBytesP50)
  };
}

async function d1(env,u){
  const{token,account}=cfg(env),r=range(u,"date");
  const q=`query($a:String!,$s:Date!,$e:Date!){
    viewer{accounts(filter:{accountTag:$a}){
      d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes}
        quantiles{queryBatchTimeMsP50 queryBatchTimeMsP90 queryBatchTimeMsP99}
        dimensions{date databaseId}
      }
      d1StorageAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        max{databaseSizeBytes} dimensions{date databaseId}
      }
    }}
  }`;
  const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
  const x=a.d1AnalyticsAdaptiveGroups||[],st=a.d1StorageAdaptiveGroups||[];
  return{
    days:r.days,
    readQueries:sum(x,r=>r.sum?.readQueries),
    writeQueries:sum(x,r=>r.sum?.writeQueries),
    rowsRead:sum(x,r=>r.sum?.rowsRead),
    rowsWritten:sum(x,r=>r.sum?.rowsWritten),
    responseBytes:sum(x,r=>r.sum?.queryBatchResponseBytes),
    storage:Math.max(0,...st.map(r=>n(r.max?.databaseSizeBytes))),
    p50:avg(x,r=>r.quantiles?.queryBatchTimeMsP50),
    p90:avg(x,r=>r.quantiles?.queryBatchTimeMsP90),
    p99:avg(x,r=>r.quantiles?.queryBatchTimeMsP99),
    readTrend:trend(x,r=>r.dimensions?.date,r=>r.sum?.rowsRead),
    writeTrend:trend(x,r=>r.dimensions?.date,r=>r.sum?.rowsWritten),
    queryTrend:trend(x,r=>r.dimensions?.date,r=>r.sum?.readQueries+r.sum?.writeQueries),
    latencyTrend:trend(x,r=>r.dimensions?.date,r=>r.quantiles?.queryBatchTimeMsP90),
    databases:group(x,r=>r.dimensions?.databaseId,r=>r.sum?.rowsRead),
    storageTrend:trend(st,r=>r.dimensions?.date,r=>r.max?.databaseSizeBytes)
  };
}

async function kv(env,u){
  const{token,account}=cfg(env),r=range(u,"date");
  const q=`query($a:String!,$s:Date!,$e:Date!){
    viewer{accounts(filter:{accountTag:$a}){
      kvOperationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{requests} quantiles{latencyMsP50 latencyMsP90 latencyMsP99}
        dimensions{date actionType namespaceId}
      }
      kvStorageAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        max{keyCount byteCount} dimensions{date namespaceId}
      }
    }}
  }`;
  const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
  const x=a.kvOperationsAdaptiveGroups||[],st=a.kvStorageAdaptiveGroups||[];
  return{
    days:r.days,
    operations:sum(x,r=>r.sum?.requests),
    reads:sum(x,r=>r.dimensions?.actionType==="read"?r.sum?.requests:0),
    writes:sum(x,r=>r.dimensions?.actionType==="write"?r.sum?.requests:0),
    deletes:sum(x,r=>r.dimensions?.actionType==="delete"?r.sum?.requests:0),
    lists:sum(x,r=>r.dimensions?.actionType==="list"?r.sum?.requests:0),
    storage:Math.max(0,...st.map(r=>n(r.max?.byteCount))),
    keys:Math.max(0,...st.map(r=>n(r.max?.keyCount))),
    p50:avg(x,r=>r.quantiles?.latencyMsP50),
    p90:avg(x,r=>r.quantiles?.latencyMsP90),
    p99:avg(x,r=>r.quantiles?.latencyMsP99),
    trend:trend(x,r=>r.dimensions?.date,r=>r.sum?.requests),
    actions:group(x,r=>r.dimensions?.actionType,r=>r.sum?.requests),
    namespaces:group(x,r=>r.dimensions?.namespaceId,r=>r.sum?.requests),
    storageTrend:trend(st,r=>r.dimensions?.date,r=>r.max?.byteCount),
    keyTrend:trend(st,r=>r.dimensions?.date,r=>r.max?.keyCount)
  };
}

async function r2(env,u){
  const{token,account}=cfg(env),r=range(u);
  const q=`query($a:String!,$s:Time!,$e:Time!){
    viewer{accounts(filter:{accountTag:$a}){
      r2OperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        sum{requests} dimensions{datetime actionType actionStatus bucketName responseStatusCode}
      }
      r2StorageAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
        max{objectCount uploadCount payloadSize metadataSize} dimensions{datetime bucketName}
      }
    }}
  }`;
  const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
  const x=a.r2OperationsAdaptiveGroups||[],st=a.r2StorageAdaptiveGroups||[];
  return{
    days:r.days,
    operations:sum(x,r=>r.sum?.requests),
    storage:Math.max(0,...st.map(r=>n(r.max?.payloadSize))),
    metadata:Math.max(0,...st.map(r=>n(r.max?.metadataSize))),
    objects:Math.max(0,...st.map(r=>n(r.max?.objectCount))),
    uploads:Math.max(0,...st.map(r=>n(r.max?.uploadCount))),
    trend:trend(x,r=>r.dimensions?.datetime?.slice(0,13),r=>r.sum?.requests),
    actions:group(x,r=>r.dimensions?.actionType,r=>r.sum?.requests),
    statuses:group(x,r=>r.dimensions?.responseStatusCode,r=>r.sum?.requests),
    buckets:group(x,r=>r.dimensions?.bucketName,r=>r.sum?.requests),
    storageTrend:trend(st,r=>r.dimensions?.datetime?.slice(0,13),r=>r.max?.payloadSize),
    objectsTrend:trend(st,r=>r.dimensions?.datetime?.slice(0,13),r=>r.max?.objectCount)
  };
}

async function durableObjects(env,u){
  const{token,account}=cfg(env),r=range(u,"date"),o={days:r.days,warnings:[]};
  const base=(field)=>`query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){${field}}}}}`;
  try{
    const a=(await gql(base('sum{requests} dimensions{date}'),{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
    const x=a.durableObjectsInvocationsAdaptiveGroups||[];
    o.requests=sum(x,r=>r.sum?.requests);
    o.trend=trend(x,r=>r.dimensions?.date,r=>r.sum?.requests);
  }catch(e){o.warnings.push('请求统计：'+e.message);o.requests=0;o.trend=[]}
  try{
    const a=(await gql(base('sum{responseBodySize} dimensions{date}'),{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
    o.responseBytes=sum(a.durableObjectsInvocationsAdaptiveGroups||[],r=>r.sum?.responseBodySize);
  }catch(e){o.warnings.push('响应流量：'+e.message);o.responseBytes=0}
  try{
    const q=`query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){durableObjectsPeriodicGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{cpuTime} quantiles{memoryUsageBytesP50 memoryUsageBytesP90 memoryUsageBytesP99} dimensions{date}}}}}`;
    const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
    const x=a.durableObjectsPeriodicGroups||[];
    o.cpu=sum(x,r=>r.sum?.cpuTime);
    o.memoryP50=Math.max(0,...x.map(r=>n(r.quantiles?.memoryUsageBytesP50)));
    o.memoryP90=Math.max(0,...x.map(r=>n(r.quantiles?.memoryUsageBytesP90)));
    o.memoryP99=Math.max(0,...x.map(r=>n(r.quantiles?.memoryUsageBytesP99)));
    o.memoryTrend=trend(x,r=>r.dimensions?.date,r=>r.quantiles?.memoryUsageBytesP50);
    o.cpuTrend=trend(x,r=>r.dimensions?.date,r=>r.sum?.cpuTime);
  }catch(e){o.warnings.push('CPU/内存：'+e.message);o.cpu=0;o.memoryP50=0;o.memoryP90=0;o.memoryP99=0;o.memoryTrend=[];o.cpuTrend=[]}
  try{
    const q=`query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){durableObjectsStorageGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){max{storedBytes} dimensions{date}}}}}`;
    const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
    const x=a.durableObjectsStorageGroups||[];
    o.storage=Math.max(0,...x.map(r=>n(r.max?.storedBytes)));
    o.storageTrend=trend(x,r=>r.dimensions?.date,r=>r.max?.storedBytes);
  }catch(e){o.warnings.push('存储：'+e.message);o.storage=0;o.storageTrend=[]}
  try{
    const q=`query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){durableObjectsSubrequestsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{requests} dimensions{date}}}}}`;
    const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
    const x=a.durableObjectsSubrequestsAdaptiveGroups||[];
    o.subrequests=sum(x,r=>r.sum?.requests);
  }catch(e){o.warnings.push('子请求统计：'+e.message);o.subrequests=0}
  o.namespaces=[];
  return o;
}

async function zone(env,u){
  const{token,account}=cfg(env);
  const zoneTag=u.searchParams.get("zone");
  if(!zoneTag)throw Error("缺少 Zone");
  const period=u.searchParams.get("period")||"24h";
  const requestedDays=Math.min(30,Math.max(1,Number(u.searchParams.get("days")||1)));
  const days=period==="today"?1:requestedDays;
  const o={days,warnings:[],requests:0,bytes:0,visits:0,cacheHits:0,trend:[],bytesTrend:[],countries:[],statuses:[],colos:[],devices:[],firewall:0,firewallTrend:[],firewallActions:[],firewallSources:[],securityAvailable:false};
  // HTTP Analytics 对 Zone 查询在较长时间范围存在 1d 限制，因此按天拆分并合并。
  const httpRows=[];
  for(let i=0;i<days;i++){
    const end=period==="today"?new Date():new Date(Date.now()-i*86400000);
    const start=period==="today"?new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),end.getUTCDate())):new Date(end.getTime()-86400000);
    try{
      const q=`query($z:String!,$s:Time!,$e:Time!){viewer{zones(filter:{zoneTag:$z}){httpRequestsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e,requestSource:"eyeball"}){count sum{edgeResponseBytes visits} dimensions{datetimeHour clientCountryName clientDeviceType edgeResponseStatus coloCode cacheStatus}}}}}`;
      const a=(await gql(q,{z:zoneTag,s:start.toISOString(),e:end.toISOString()},token)).viewer.zones?.[0]||{};
      httpRows.push(...(a.httpRequestsAdaptiveGroups||[]));
    }catch(e){ if(i===0)o.warnings.push('流量分析：'+e.message); }
  }
  o.requests=sum(httpRows,r=>r.count);o.bytes=sum(httpRows,r=>r.sum?.edgeResponseBytes);o.visits=sum(httpRows,r=>r.sum?.visits);
  o.cacheHits=sum(httpRows,r=>r.dimensions?.cacheStatus==="hit"?r.count:0);
  o.trend=trend(httpRows,r=>r.dimensions?.datetimeHour,r=>r.count);
  o.bytesTrend=trend(httpRows,r=>r.dimensions?.datetimeHour,r=>r.sum?.edgeResponseBytes);
  o.countries=group(httpRows,r=>r.dimensions?.clientCountryName,r=>r.count);
  o.statuses=group(httpRows,r=>r.dimensions?.edgeResponseStatus,r=>r.count);
  o.colos=group(httpRows,r=>r.dimensions?.coloCode,r=>r.count);
  o.devices=group(httpRows,r=>r.dimensions?.clientDeviceType,r=>r.count);
  // Firewall Analytics 权限可能因账户/Zone 不同而不可用；不可用时不再把无意义的权限报错展示给用户。
  try{
    const q=`query($z:String!,$s:Time!,$e:Time!){viewer{zones(filter:{zoneTag:$z}){firewallEventsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){count dimensions{datetime action clientCountryName source}}}}}`;
    const now=new Date();
    const securityStart=period==="today"
      ?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()))
      :new Date(Date.now()-86400000);
    const a=(await gql(q,{z:zoneTag,s:securityStart.toISOString(),e:now.toISOString()},token)).viewer.zones?.[0]||{};
    const x=a.firewallEventsAdaptiveGroups||[];
    o.firewall=sum(x,r=>r.count);o.firewallTrend=trend(x,r=>r.dimensions?.datetime?.slice(0,13),r=>r.count);o.firewallActions=group(x,r=>r.dimensions?.action,r=>r.count);o.firewallSources=group(x,r=>r.dimensions?.source,r=>r.count);o.securityAvailable=true;
  }catch{}
  return o;
}

async function workflows(env,u){
  const{token,account}=cfg(env),r=range(u),o={days:r.days,warnings:[]};
  try{
    const q=`query($a:String!,$s:Time!,$e:Time!){
      viewer{accounts(filter:{accountTag:$a}){
        workflowsAdaptiveGroups(limit:10000,filter:{datetimeHour_geq:$s,datetimeHour_leq:$e}){
          count sum{wallTime}
          dimensions{datetimeHour workflowName eventType}
        }
      }}
    }`;
    const x=(await gql(q,{a:account,s:r.start,e:r.end},token))
      .viewer.accounts?.[0]?.workflowsAdaptiveGroups||[];
    Object.assign(o,{
      runs:sum(x,r=>r.dimensions?.eventType==="WORKFLOW_START"?r.count:0),
      success:sum(x,r=>r.dimensions?.eventType==="WORKFLOW_SUCCESS"?r.count:0),
      failures:sum(x,r=>r.dimensions?.eventType==="WORKFLOW_FAILURE"?r.count:0),
      wallTime:sum(x,r=>r.sum?.wallTime),
      trend:trend(x,r=>r.dimensions?.datetimeHour,r=>r.count),
      workflows:group(x,r=>r.dimensions?.workflowName,r=>r.count),
      events:group(x,r=>r.dimensions?.eventType,r=>r.count)
    });
  }catch(e){o.warnings.push("Workflows 分析："+e.message)}
  try{
    o.workflowList=arr(await rest(`/accounts/${account}/workflows?per_page=100`,token))
      .map(x=>({id:x.id,name:x.name}));
  }catch(e){o.warnings.push("Workflows 列表："+e.message)}
  return o;
}

export async function onRequest({request,env}){
  const u=new URL(request.url);
  const p=u.pathname.replace(/^\/api\/?/,"").replace(/\/$/,"");
  try{
    let d;
    if(p==="inventory"||p==="overview")d=await inventory(env);
    else if(p==="workers")d=await workers(env,u);
    else if(p==="d1")d=await d1(env,u);
    else if(p==="kv")d=await kv(env,u);
    else if(p==="r2")d=await r2(env,u);
    else if(p==="do"||p==="durable-objects")d=await durableObjects(env,u);
    else if(p==="zone")d=await zone(env,u);
    else if(p==="health")d={ok:true,time:new Date().toISOString()};
    else return fail("未知 API："+p,404);
    return ok(d);
  }catch(e){return fail(e.message||"请求失败")}
}
