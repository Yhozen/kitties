import fs from 'node:fs';

const base='https://api.cloudflare.com/client/v4',headers={Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'};

const api=async(path,method='GET',body)=>{
const options={method,headers};

if(body)options.body=JSON.stringify(body);
const r=await fetch(base+path,options);const v=await r.json();

if(!v.success)throw Error(JSON.stringify({status:r.status,errors:v.errors}));

return v.result;};

const zone=(await api('/zones?name=rccpr.tech'))[0].id;
const rule={ref:'kitties_hook_rate',description:'Kitties signed-hook ingress: 300 requests per 10 seconds per IP',expression:'(http.host in {"hooks-next.kitties.rccpr.tech" "hooks-prod.kitties.rccpr.tech" "hooks.kitties.rccpr.tech"} and starts_with(http.request.uri.path, "/hooks/"))',action:'block',enabled:true,ratelimit:{characteristics:['cf.colo.id','ip.src'],period:10,requests_per_period:300,mitigation_timeout:10}};
const all=await api(`/zones/${zone}/rulesets`);let set=all.find(x=>x.phase==='http_ratelimit'&&x.kind==='zone');

if(!set)set=await api(`/zones/${zone}/rulesets`,'POST',{name:'Kitties hook rate limit',kind:'zone',phase:'http_ratelimit',rules:[rule]});
else{set=await api(`/zones/${zone}/rulesets/${set.id}`);const old=set.rules.find(x=>x.ref===rule.ref);

if(old)await api(`/zones/${zone}/rulesets/${set.id}/rules/${old.id}`,'PATCH',rule);else await api(`/zones/${zone}/rulesets/${set.id}/rules`,'POST',rule);}

const result=await api(`/zones/${zone}/rulesets/${set.id}`);

fs.writeFileSync('docs/effect/evidence/hooks-rate-cloud.json',JSON.stringify({date:new Date().toISOString(),status:'configured',ruleset:result.id,rule:result.rules.find(x=>x.ref===rule.ref)},null,2)+'\n');

console.log('Hook WAF rate rule configured and read back.');
