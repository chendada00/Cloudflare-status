
const CF = "https://api.cloudflare.com/client/v4";
const GQL = "https://api.cloudflare.com/client/v4/graphql";

function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {status, headers:{"content-type":"application/json;charset=UTF-8","cache-control":"no-store",...headers}});
}
function err(message,status=500,extra={}) { return json({success:false,error:message,...extra},status); }
function envConfig(env){
  const token=env.CLOUDFLARE_API_TOKEN;
  const accountId=env.CLOUDFLARE_ACCOUNT_ID;
  if(!token||!accountId) throw new Error("缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID");
  return {token,accountId};
}
async function cf(path, token, init={}) {
  const r=await fetch(CF+path,{...init,headers:{authorization:`Bearer ${token}`,...(init.headers||{})}});
  const d=await r.json();
  if(!r.ok||d.success===false) throw new Error(d.errors?.map(x=>x.message).join("; ")||`Cloudflare API ${r.status}`);
  return d.result;
}
async function gql(query, variables, token) {
  const r=await fetch(GQL,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({query,variables})});
  const d=await r.json();
  if(!r.ok||d.errors) throw new Error(d.errors?.map(x=>x.message).join("; ")||`GraphQL ${r.status}`);
  return d.data;
}
const sum=a=>a.reduce((s,x)=>s+(Number(x)||0),0);
const gb=n=>Number(n||0)/1024/1024/1024;

async function safe(name, fn, warnings){
  try{return [name,await fn()]}catch(e){warnings.push({name,error:String(e.message||e)});return [name,null]}
}

async function inventory(env){
  const {token,accountId}=envConfig(env);
  const warnings=[];
  const entries=await Promise.all([
    safe("zones",()=>cf(`/zones?per_page=100`,token),warnings),
    safe("workers",()=>cf(`/accounts/${accountId}/workers/scripts?per_page=100`,token),warnings),
    safe("d1",()=>cf(`/accounts/${accountId}/d1/database?per_page=100`,token),warnings),
    safe("kv",()=>cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`,token),warnings),
    safe("r2",()=>cf(`/accounts/${accountId}/r2/buckets?per_page=100`,token),warnings),
    safe("do",()=>cf(`/accounts/${accountId}/workers/durable_objects/namespaces?per_page=100`,token),warnings),
  ]);
  const x=Object.fromEntries(entries);
  return {counts:{
    zones:x.zones?.length||0,workers:x.workers?.length||0,d1:x.d1?.length||0,
    kv:x.kv?.length||0,r2:x.r2?.buckets?.length||0, durableObjects:x.do?.length||0
  }, resources:{
    zones:(x.zones||[]).map(z=>({id:z.id,name:z.name,status:z.status,plan:z.plan?.name||""})),
    workers:(x.workers||[]).map(w=>({id:w.id,created_on:w.created_on,modified_on:w.modified_on})),
    d1:(x.d1||[]).map(d=>({uuid:d.uuid,name:d.name,created_at:d.created_at,version:d.version})),
    kv:(x.kv||[]).map(k=>({id:k.id,title:k.title})),
    r2:(x.r2?.buckets||[]).map(b=>({name:b.name,creation_date:b.creation_date})),
    durableObjects:(x.do||[]).map(d=>({id:d.id,name:d.name,script:d.script}))
  },warnings};
}

const ACCOUNT_QUERY = `
query($accountTag:String!,$start:DateTime!,$end:DateTime!){
  viewer {
    accounts(filter:{accountTag:$accountTag}) {
      workersInvocationsAdaptive(limit:5000,filter:{datetime_geq:$start,datetime_leq:$end}) {
        sum { requests errors subrequests cpuTime }
        dimensions { datetime }
      }
      d1AnalyticsAdaptiveGroups(limit:5000,filter:{datetime_geq:$start,datetime_leq:$end}) {
        sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes queryBatchTimeMs databaseSizeBytes }
        dimensions { datetime databaseId }
      }
      kvOperationsAdaptiveGroups(limit:5000,filter:{datetime_geq:$start,datetime_leq:$end}) {
        sum { requests }
        dimensions { datetime action namespaceId }
      }
      kvStorageAdaptiveGroups(limit:5000,filter:{datetime_geq:$start,datetime_leq:$end}) {
        max { bytes }
        dimensions { datetime namespaceId }
      }
    }
  }
}`;
const ZONE_QUERY = `
query($zoneTag:String!,$start:DateTime!,$end:DateTime!){
 viewer { zones(filter:{zoneTag:$zoneTag}) {
   httpRequestsAdaptiveGroups(limit:5000,filter:{datetime_geq:$start,datetime_leq:$end}) {
     sum { requests bytes cachedBytes threats }
     dimensions { datetime }
   }
 }}
}`;

async function analytics(env, url){
  const {token,accountId}=envConfig(env);
  const days=Math.min(Math.max(Number(url.searchParams.get("days")||7),1),31);
  const zoneId=url.searchParams.get("zone")||"";
  const end=new Date(); const start=new Date(end.getTime()-days*86400000);
  const vars={accountTag:accountId,start:start.toISOString(),end:end.toISOString()};
  const warnings=[];
  let account=null, zone=null;
  try{account=await gql(ACCOUNT_QUERY,vars,token)}catch(e){warnings.push({name:"账号级 GraphQL 指标",error:e.message})}
  if(zoneId){
    try{zone=await gql(ZONE_QUERY,{zoneTag:zoneId,start:vars.start,end:vars.end},token)}catch(e){warnings.push({name:"Zone GraphQL 指标",error:e.message})}
  }
  const a=account?.viewer?.accounts?.[0]||{};
  const workers=a.workersInvocationsAdaptive||[];
  const d1=a.d1AnalyticsAdaptiveGroups||[];
  const kvOps=a.kvOperationsAdaptiveGroups||[];
  const kvStorage=a.kvStorageAdaptiveGroups||[];
  const z=zone?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups||[];
  const byDay=(rows, field, section="sum")=>{
    const m={}; for(const r of rows){const k=(r.dimensions?.datetime||"").slice(0,10); if(!k)continue; m[k]=(m[k]||0)+Number(r[section]?.[field]||0)}
    return Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,value])=>({date,value}));
  };
  const kvActions={}; for(const r of kvOps){const k=r.dimensions?.action||"OTHER";kvActions[k]=(kvActions[k]||0)+Number(r.sum?.requests||0)}
  const latestStorage={}; for(const r of kvStorage){const k=r.dimensions?.namespaceId||"unknown";latestStorage[k]=Math.max(latestStorage[k]||0,Number(r.max?.bytes||0))}
  const d1Totals={readQueries:sum(d1.map(x=>x.sum?.readQueries)),writeQueries:sum(d1.map(x=>x.sum?.writeQueries)),rowsRead:sum(d1.map(x=>x.sum?.rowsRead)),rowsWritten:sum(d1.map(x=>x.sum?.rowsWritten)),responseBytes:sum(d1.map(x=>x.sum?.queryBatchResponseBytes)),latencyMs:sum(d1.map(x=>x.sum?.queryBatchTimeMs)),storageBytes:Math.max(0,...d1.map(x=>Number(x.sum?.databaseSizeBytes||0)))};
  const workerTotals={requests:sum(workers.map(x=>x.sum?.requests)),errors:sum(workers.map(x=>x.sum?.errors)),subrequests:sum(workers.map(x=>x.sum?.subrequests)),cpuTime:sum(workers.map(x=>x.sum?.cpuTime))};
  const zoneTotals={requests:sum(z.map(x=>x.sum?.requests)),bytes:sum(z.map(x=>x.sum?.bytes)),cachedBytes:sum(z.map(x=>x.sum?.cachedBytes)),threats:sum(z.map(x=>x.sum?.threats))};
  return {days,range:{start:vars.start,end:vars.end},warnings,workers:{totals:workerTotals,trend:byDay(workers,"requests"),errors:byDay(workers,"errors")},d1:{totals:d1Totals,rowsRead:byDay(d1,"rowsRead"),rowsWritten:byDay(d1,"rowsWritten"),readQueries:byDay(d1,"readQueries"),writeQueries:byDay(d1,"writeQueries")},kv:{actions:kvActions,storageBytes:sum(Object.values(latestStorage)),namespaces:Object.keys(latestStorage).length},zone:{id:zoneId,totals:zoneTotals,trend:byDay(z,"requests"),bytes:byDay(z,"bytes")}};
}

async function billable(env){
  const {token,accountId}=envConfig(env);
  const r=await fetch(`${CF}/accounts/${accountId}/billable/usage`,{headers:{authorization:`Bearer ${token}`}});
  const d=await r.json();
  if(!r.ok||d.success===false) throw new Error(d.errors?.map(x=>x.message).join("; ")||"Billable Usage API 不可用");
  return d.result||[];
}

export async function onRequest({request,env}){
  const url=new URL(request.url);
  const p=url.pathname.replace(/^\/api\/?/,"");
  try{
    if(p==="config") return json({success:true,siteName:env.SITE_NAME||"Cloudflare Status",siteIcon:env.SITE_ICON||"/favicon.svg"});
    if(p==="inventory") return json({success:true,...await inventory(env)});
    if(p==="analytics") return json({success:true,...await analytics(env,url)});
    if(p==="billable") return json({success:true,result:await billable(env)});
    return err("API 不存在",404);
  }catch(e){return err(e.message||"服务器错误",500);}
}
