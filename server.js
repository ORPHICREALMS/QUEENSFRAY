// THE QUEEN'S FRAY — game server.
// Hands out the game page (the newest QUEENSFRAY_v*.html sitting next to this file) and runs every friend match.
// The battle rules are read straight out of that page, so updating the game = uploading the new html file only.
const http=require('http'),fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto'),{WebSocketServer}=require('ws');
const PORT=process.env.PORT||3000;

function newestPage(){const f=fs.readdirSync(__dirname).filter(n=>/^QUEENSFRAY_v\d+\.html$/i.test(n)).sort((a,b)=>+a.match(/\d+/)[0]-+b.match(/\d+/)[0]);if(!f.length)throw new Error('Put a QUEENSFRAY_vNN.html file next to server.js');return path.join(__dirname,f[f.length-1])}
let PAGE='',PAGEF='',SIMCODE='',SIMSCRIPT=null;
function loadPage(){const f=newestPage();const st=fs.statSync(f).mtimeMs+'|'+f;if(st==PAGEF)return;PAGEF=st;PAGE=fs.readFileSync(f);
 const s=PAGE.toString('utf8'),a=s.indexOf('/*SIM>*/'),b=s.indexOf('/*<SIM*/');if(a<0||b<0)throw new Error('The game page is missing its battle rules');
 SIMCODE=s.slice(a,b).replace(/^const /gm,'var ').replace(/^let /gm,'var ')+'\n;({newGame,step,cmd,sees,mobile,E,getG:()=>G})';SIMSCRIPT=new vm.Script(SIMCODE,{filename:'battle.js'});console.log('game page:',path.basename(f))}
loadPage();
function newSim(){const ctx=vm.createContext({console,Math,JSON,Date,Object,Array,Uint8Array,Float32Array,Map,Set,Number,String,Boolean,Infinity,NaN,isFinite,parseFloat,parseInt});return SIMSCRIPT.runInContext(ctx)}

const server=http.createServer((req,res)=>{
 if(req.url=='/health'){res.writeHead(200);res.end('ok');return}
 try{loadPage()}catch(e){res.writeHead(500);res.end(String(e.message));return}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(PAGE)});
const wss=new WebSocketServer({server,maxPayload:64*1024});

const rooms=new Map();
const seatOf=(r,ws)=>r.seats.findIndex(s=>s.ws===ws);
const out=(ws,o)=>{if(ws&&ws.readyState==1)ws.send(typeof o=='string'?o:JSON.stringify(o))};
const both=(r,o)=>{const m=JSON.stringify(o);r.seats.forEach(s=>out(s.ws,m))};
function lobby(r){both(r,{t:'lobby',phase:r.phase,conn:r.seats.map(s=>!!s.ws),ready:r.seats.map(s=>!!s.deck),rematch:r.seats.map(s=>!!s.rematch)})}
function newRoom(){let c;do c=String(1000+Math.floor(Math.random()*9000));while(rooms.has(c));
 const r={code:c,phase:'wait',seats:[0,1].map(()=>({ws:null,token:'',deck:null,rematch:false,paused:false})),sim:null,cache:[new Map(),new Map()],fxSent:[0,0],tick:0,resumeAt:0,startAt:0,empty:0};rooms.set(c,r);return r}
const tok=()=>crypto.randomBytes(9).toString('hex');

function validDeck(d){if(!d||typeof d!='object')return false;const ids=[d.q,d.k,d.m,d.base,...(d.b||[]),...(d.n||[]),...(d.r||[])].filter(Boolean);
 return typeof d.q=='string'&&Array.isArray(d.b)&&d.b.length==2&&Array.isArray(d.n)&&d.n.length==2&&Array.isArray(d.r)&&d.r.length==2&&typeof d.m=='string'&&typeof d.base=='string'&&ids.length<=10&&ids.every(i=>typeof i=='string'&&i.length<12)&&d.lanes&&typeof d.lanes=='object'}

function sendStart(r,i,at){out(r.seats[i].ws,{t:'start',decks:r.seats.map(s=>s.deck),at});r.cache[i]=new Map();r.fxSent[i]=0}
function begin(r){r.phase='count';r.seats.forEach(s=>{s.rematch=false;s.paused=false});lobby(r);r.seats.forEach((s,i)=>sendStart(r,i,3));r.startAt=Date.now()+3000}
function play(r){r.sim=newSim();const d=r.seats.map(s=>JSON.parse(JSON.stringify(s.deck)));for(const x of d)for(const k in x.lanes)x.lanes[k]=Math.max(0,Math.min(2,x.lanes[k]|0));
 r.sim.newGame(d[0],d[1],{ai:r.seats.map(s=>!s.ws)});r.phase='play';r.tick=0;r.cache=[new Map(),new Map()];r.fxSent=[0,0]}

wss.on('connection',ws=>{ws.on('message',buf=>{let m;try{m=JSON.parse(buf)}catch(e){return}if(!m||typeof m.t!='string')return;
 const r=ws.room,i=r?seatOf(r,ws):-1;
 if(m.t=='create'){if(r)return;const R=newRoom();join(R,0,ws);return}
 if(m.t=='join'){const R=rooms.get(String(m.code));if(!R){out(ws,{t:'err',m:'No game with that code. Check the numbers with your opponent.',gone:true});return}
  let s=m.token?R.seats.findIndex(x=>x.token&&x.token===m.token):-1;if(s<0)s=R.seats.findIndex(x=>!x.token);if(s<0){out(ws,{t:'err',m:'That game already has two players.'});return}join(R,s,ws);return}
 if(!r||i<0)return;const S=r.seats[i];
 if(m.t=='ready'&&r.phase=='deck'){if(!validDeck(m.deck))return;S.deck=m.deck;lobby(r);if(r.seats.every(s=>s.deck&&s.ws))begin(r);return}
 if(m.t=='unready'&&r.phase=='deck'){S.deck=null;lobby(r);return}
 if(m.t=='cmd'&&r.phase=='play'&&m.c&&typeof m.c.t=='string'){try{r.sim.cmd(m.c,i)}catch(e){}return}
 if(m.t=='pause'&&r.phase=='play'){S.paused=!!m.v;const any=r.seats.some(s=>s.paused);if(!any)r.resumeAt=Date.now()+3000;both(r,{t:'pause',p:r.seats.map(s=>s.paused),cd:any?0:3});return}
 if(m.t=='rematch'&&r.phase=='over'){S.rematch=true;if(r.seats.every(s=>s.rematch)){r.phase='deck';r.sim=null;r.seats.forEach(s=>{s.deck=null;s.rematch=false;s.paused=false});lobby(r);both(r,{t:'deck'})}else lobby(r);return}
 if(m.t=='leave'){S.token='';S.deck=null;drop(r,i);return}});
 ws.on('close',()=>{const r=ws.room;if(!r)return;const i=seatOf(r,ws);if(i>=0)drop(r,i)})});

function join(r,s,ws){const S=r.seats[s];if(S.ws&&S.ws!==ws){try{S.ws.room=null;S.ws.close()}catch(e){}}S.ws=ws;ws.room=r;if(!S.token)S.token=tok();
 if(r.phase=='wait'&&r.seats.every(x=>x.ws))r.phase='deck';
 out(ws,{t:'room',code:r.code,seat:s,token:S.token,phase:r.phase});lobby(r);
 if(r.phase=='count')sendStart(r,s,Math.max(0,(r.startAt-Date.now())/1000));
 if(r.phase=='play'||r.phase=='over'){sendStart(r,s,0);if(r.phase=='play'){const G=r.sim.getG();G.ai[s]=false;G.mult[s]=1}out(ws,{t:'pause',p:r.seats.map(x=>x.paused)})}}
function drop(r,i){const S=r.seats[i];if(S.ws){S.ws.room=null}S.ws=null;S.paused=false;S.rematch=false;
 if(r.phase=='play'){const G=r.sim.getG();G.ai[i]=true;G.mult[i]=1;if(!r.seats.some(s=>s.paused))both(r,{t:'pause',p:r.seats.map(s=>s.paused)})}
 if(r.phase=='deck'&&!S.token)r.phase=r.seats.some(s=>s.token)?'wait':'deck';
 if(r.phase=='count'){r.phase='deck';r.seats.forEach(s=>s.deck=null)}
 lobby(r)}

// ---- what each player is told: only what their own side can see, and only what changed ----
const SKIP=new Set(['p','base','path','hist','camp','think','tgC','ab','hx','hy','lx','ly','wp','toF','shopT','aggroT','itMark','itBurn','rp','by','ramp','src']);
const r10=v=>Math.round(v*10)/10;
const rep=(k,v)=>typeof v=='number'?r10(v):(k!==''&&v&&typeof v=='object'&&v.kind!==undefined&&v.id!==undefined)?{$:v.id}:(v instanceof Uint8Array?Array.from(v):v);
function enc(k,v){if(v===undefined||typeof v=='function')return undefined;if(typeof v=='number')return String(r10(v));if(v===null||typeof v!='object')return JSON.stringify(v);
 if(k=='ch'||k=='m')return JSON.stringify(v.id);if(v.kind!==undefined&&v.id!==undefined)return'{"$":'+v.id+'}';return JSON.stringify(v,rep)}
function snap(r,s){const api=r.sim,G=api.getG(),C=r.cache[s],seen=new Set(),ents=[];
 for(const o of G.e){if(o.team!==s){if(o.kind=='ward'||o.owl)continue;if(api.mobile(o)&&!(o.kind=='hero'&&o.dead)&&!api.sees(s,o))continue}
  seen.add(o.id);let c=C.get(o.id);if(!c){c={};C.set(o.id,c)}const parts=[];
  for(const k in o){if(SKIP.has(k))continue;const e=enc(k,o[k]);if(e===undefined||c[k]===e)continue;c[k]=e;parts.push('"'+k+'":'+e)}
  if(parts.length)ents.push('{"id":'+o.id+','+parts.join(',')+'}')}
 const gone=[];for(const id of C.keys())if(!seen.has(id)){gone.push(id);C.delete(id)}
 const fx=[];for(const f of G.fx)if(f.i>r.fxSent[s])fx.push(f);if(fx.length)r.fxSent[s]=fx[fx.length-1].i;
 const g={t:G.t,gold:G.gold,resc:G.resc,capt:G.capt,buff:G.buff,qu:G.qu,over:G.over,autoShop:G.autoShop,ai:G.ai,ord:G.ord[s],me:G.ctl[s],bin:G.bin,camps:G.camps.map(c=>({x:c.x,y:c.y,type:c.type,n:c.n,t:c.t})),
  zones:G.zones.map(z=>({x:z.x,y:z.y,rad:z.rad,t:z.t,T:z.T,team:z.team,k:z.k,c:z.c,o:z.o})),links:G.links.map(l=>({a:l.a,b:l.b,t:l.t,T:l.T,k:l.k,c:l.c}))};
 return '{"t":"s","g":'+JSON.stringify(g,rep)+',"e":['+ents.join(',')+'],"x":'+JSON.stringify(gone)+',"f":'+JSON.stringify(fx,rep)+'}'}

let fxn=0;
setInterval(()=>{const now=Date.now();
 for(const r of rooms.values()){
  if(!r.seats.some(s=>s.ws)){r.empty+=50;if(r.empty>30*60*1000)rooms.delete(r.code);continue}r.empty=0;
  if(r.phase=='count'&&now>=r.startAt)play(r);
  if(r.phase!='play')continue;
  if(r.seats.some(s=>s.paused)||now<r.resumeAt)continue;
  const G=r.sim.getG();try{r.sim.step(.05)}catch(e){console.error('battle error',e)}
  for(const f of G.fx)if(!f.i)f.i=++fxn;
  if(++r.tick%2==0||G.over>=0)r.seats.forEach((S,i)=>{if(S.ws&&S.ws.bufferedAmount<512*1024)out(S.ws,snap(r,i))});
  if(G.over>=0){r.phase='over';lobby(r)}}},50);

server.listen(PORT,()=>console.log('The Queen\'s Fray server on port',PORT));
