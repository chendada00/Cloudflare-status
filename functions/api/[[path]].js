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
  const days=Math.min(30,Math.max(1,Number(u.searchParams.get("days")||1)));
  const end=new Date(),start=new Date(end-days*86400000);
  return kind==="date"
    ?{days,start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)}
    :{days,start:start.toISOString(),end:end.toISOString()};
}

async function inventory(env){
  const{token,account}=cfg(env);
  const jobs={
    zones:rest("/zones?per_page=100",token),
    workers:rest(`/accounts/${account}/workers/scripts?per_page=100`,token),
    d1:rest(`/accounts/${account}/d1/database?per_page=100`,token),
    kv:rest(`/accounts/${account}/storage/kv/namespaces?per_page=100`,token),
    r2:rest(`/accounts/${account}/r2/buckets?per_page=100`,token),
    durableObjects:rest(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100`,token),
    queues:rest(`/accounts/${account}/queues?per_page=100`,token),
    workflows:rest(`/accounts/${account}/workflows?per_page=100`,token)
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
      durableObjects:out.durableObjects.map(x=>({id:x.id,name:x.name,script:x.script})),
      queues:out.queues.map(x=>({id:x.queue_id||x.id,name:x.queue_name||x.name})),
      workflows:out.workflows.map(x=>({id:x.id,name:x.name}))
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
  const{token,account}=cfg(env),r=range(u,"date");
  const q=`query($a:String!,$s:Date!,$e:Date!){
    viewer{accounts(filter:{accountTag:$a}){
      durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{requests responseBodySize} dimensions{date namespaceName}
      }
      durableObjectsPeriodicGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{cpuTime}
        quantiles{memoryUsageBytesP50 memoryUsageBytesP90 memoryUsageBytesP99}
        dimensions{date namespaceName}
      }
      durableObjectsStorageGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        max{storedBytes} dimensions{date namespaceName}
      }
      durableObjectsSubrequestsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){
        sum{requests} dimensions{date namespaceName}
      }
    }}
  }`;
  const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
  const i=a.durableObjectsInvocationsAdaptiveGroups||[],
        p=a.durableObjectsPeriodicGroups||[],
        st=a.durableObjectsStorageGroups||[],
        s=a.durableObjectsSubrequestsAdaptiveGroups||[];
  return{
    days:r.days,
    requests:sum(i,x=>x.sum?.requests),
    responseBytes:sum(i,x=>x.sum?.responseBodySize),
    cpu:sum(p,x=>x.sum?.cpuTime),
    subrequests:sum(s,x=>x.sum?.requests),
    storage:Math.max(0,...st.map(x=>n(x.max?.storedBytes))),
    memoryP50:Math.max(0,...p.map(x=>n(x.quantiles?.memoryUsageBytesP50))),
    memoryP90:Math.max(0,...p.map(x=>n(x.quantiles?.memoryUsageBytesP90))),
    memoryP99:Math.max(0,...p.map(x=>n(x.quantiles?.memoryUsageBytesP99))),
    trend:trend(i,x=>x.dimensions?.date,x=>x.sum?.requests),
    namespaces:group(i,x=>x.dimensions?.namespaceName,x=>x.sum?.requests),
    memoryTrend:trend(p,x=>x.dimensions?.date,x=>x.quantiles?.memoryUsageBytesP50),
    cpuTrend:trend(p,x=>x.dimensions?.date,x=>x.sum?.cpuTime),
    storageTrend:trend(st,x=>x.dimensions?.date,x=>x.max?.storedBytes)
  };
}

async function zone(env,u){
  const{token}=cfg(env),zoneTag=u.searchParams.get("zone");
  if(!zoneTag)throw Error("缺少 Zone");
  const r=range(u),o={days:r.days,warnings:[]};

  try{
    const q=`query($z:String!,$s:Time!,$e:Time!){
      viewer{zones(filter:{zoneTag:$z}){
        httpRequestsAdaptiveGroups(limit:10000,filter:{
          datetime_geq:$s,datetime_leq:$e,requestSource:"eyeball"
        }){
          count sum{edgeResponseBytes visits}
          dimensions{datetimeHour clientCountryName clientDeviceType edgeResponseStatus coloCode cacheStatus}
        }
      }}
    }`;
    const x=(await gql(q,{z:zoneTag,s:r.start,e:r.end},token))
      .viewer.zones?.[0]?.httpRequestsAdaptiveGroups||[];
    Object.assign(o,{
      requests:sum(x,r=>r.count),
      bytes:sum(x,r=>r.sum?.edgeResponseBytes),
      visits:sum(x,r=>r.sum?.visits),
      cacheHits:sum(x,r=>r.dimensions?.cacheStatus==="hit"?r.count:0),
      trend:trend(x,r=>r.dimensions?.datetimeHour,r=>r.count),
      bytesTrend:trend(x,r=>r.dimensions?.datetimeHour,r=>r.sum?.edgeResponseBytes),
      countries:group(x,r=>r.dimensions?.clientCountryName,r=>r.count),
      statuses:group(x,r=>r.dimensions?.edgeResponseStatus,r=>r.count),
      colos:group(x,r=>r.dimensions?.coloCode,r=>r.count),
      devices:group(x,r=>r.dimensions?.clientDeviceType,r=>r.count)
    });
  }catch(e){o.warnings.push("流量分析："+e.message)}

  try{
    const q=`query($z:String!,$s:Time!,$e:Time!){
      viewer{zones(filter:{zoneTag:$z}){
        firewallEventsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
          count dimensions{datetime action clientCountryName source}
        }
      }}
    }`;
    const x=(await gql(q,{z:zoneTag,s:r.start,e:r.end},token))
      .viewer.zones?.[0]?.firewallEventsAdaptiveGroups||[];
    Object.assign(o,{
      firewall:sum(x,r=>r.count),
      firewallTrend:trend(x,r=>r.dimensions?.datetime?.slice(0,13),r=>r.count),
      firewallActions:group(x,r=>r.dimensions?.action,r=>r.count),
      firewallSources:group(x,r=>r.dimensions?.source,r=>r.count)
    });
  }catch(e){o.warnings.push("安全事件："+e.message)}
  return o;
}

async function queues(env,u){
  const{token,account}=cfg(env),r=range(u),o={days:r.days,warnings:[]};
  try{
    const x=arr(await rest(`/accounts/${account}/queues?per_page=100`,token));
    o.queues=x.map(q=>({id:q.queue_id||q.id,name:q.queue_name||q.name}));
  }catch(e){o.warnings.push("队列列表："+e.message)}
  try{
    const q=`query($a:String!,$s:Time!,$e:Time!){
      viewer{accounts(filter:{accountTag:$a}){
        queuesBacklogAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
          avg{messages bytes} dimensions{datetimeHour queueID}
        }
        queueConsumerMetricsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
          avg{concurrency} dimensions{datetimeHour queueID}
        }
        queueMessageOperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){
          count sum{bytes} dimensions{datetimeMinute queueID actionType}
        }
      }}
    }`;
    const a=(await gql(q,{a:account,s:r.start,e:r.end},token)).viewer.accounts?.[0]||{};
    const b=a.queuesBacklogAdaptiveGroups||[],
          c=a.queueConsumerMetricsAdaptiveGroups||[],
          m=a.queueMessageOperationsAdaptiveGroups||[];
    Object.assign(o,{
      backlog:avg(b,x=>x.avg?.messages),
      backlogBytes:avg(b,x=>x.avg?.bytes),
      concurrency:avg(c,x=>x.avg?.concurrency),
      operations:sum(m,x=>x.count),
      operationBytes:sum(m,x=>x.sum?.bytes),
      backlogTrend:trend(b,x=>x.dimensions?.datetimeHour,x=>x.avg?.messages),
      concurrencyTrend:trend(c,x=>x.dimensions?.datetimeHour,x=>x.avg?.concurrency),
      operationsTrend:trend(m,x=>x.dimensions?.datetimeMinute,x=>x.count),
      actions:group(m,x=>x.dimensions?.actionType,x=>x.count),
      queueUsage:group(m,x=>x.dimensions?.queueID,x=>x.count)
    });
  }catch(e){o.warnings.push("队列分析："+e.message)}
  return o;
}

async function workflows(env,u){
  const{token,account}=cfg(env),r=range(u),o={days:r.days,warnings:[]};
  try{
    const q=`query($a:String!,$s:Time!,$e:Time!){
      viewer{accounts(filter:{accountTag:$a}){
        workflowsAdaptiveGroups(limit:10000,filter:{datetimeHour_geq:$s,datetimeHour_leq:$e}){
          count sum{wallTime}
          dimensions{datetimeHour workflowName eventType stepCount}
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
    else if(p==="queues")d=await queues(env,u);
    else if(p==="workflows")d=await workflows(env,u);
    else if(p==="health")d={ok:true,time:new Date().toISOString()};
    else return fail("未知 API："+p,404);
    return ok(d);
  }catch(e){return fail(e.message||"请求失败")}
}
