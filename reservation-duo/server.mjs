import http from 'node:http';
import crypto from 'node:crypto';
import {Pool} from 'pg';
const fs = await import('node:fs');
const demoPath=process.env.STORE_FILE||'/tmp/reservations.json';
let demo=[];
try{demo=JSON.parse(fs.readFileSync(demoPath,'utf8'))}catch{}
const saveDemo=()=>{const tmp=demoPath+'.tmp';fs.writeFileSync(tmp,JSON.stringify(demo));fs.renameSync(tmp,demoPath)};
const fakePool={query:async(sql,a=[])=>{
 if(sql.startsWith('CREATE TABLE'))return {rows:[],rowCount:0};
 if(sql.startsWith('SELECT date::text')){
  const rows=demo.filter(x=>x.date>=a[0]&&x.date<=a[1]).sort((x,y)=>(x.date+x.time).localeCompare(y.date+y.time));
  return {rows:rows.map(x=>({date:x.date,time:x.time,kind:x.kind,name:x.customer_name,phone:x.phone,note:x.note,created_at:x.created_at})),rowCount:rows.length};
 }
 if(sql.startsWith('INSERT INTO appointments')){
  const [date,time,name,phone,note]=a;
  if(demo.some(x=>x.date===date&&x.time===time))return {rows:[],rowCount:0};
  demo.push({date,time,kind:sql.includes("'booked'")?'booked':'blocked',customer_name:name||null,phone:phone||null,note:note||null,created_at:new Date().toISOString()});saveDemo();
  return {rows:[{time}],rowCount:1};
 }
 if(sql.startsWith('DELETE FROM appointments')){
  const ix=demo.findIndex(x=>x.date===a[0]&&x.time===a[1]);if(ix<0)return {rows:[],rowCount:0};
  const removed=demo.splice(ix,1)[0];saveDemo();return {rows:[{kind:removed.kind}],rowCount:1};
 }
 throw Error('Unsupported query');
}};
const PORT=Number(process.env.PORT||3000),HOURS=Array.from({length:13},(_,i)=>String(i+9).padStart(2,'0')+':00');
const DB=process.env.DATABASE_URL,ADMIN_USER=process.env.ADMIN_USER||'amin_orazi',ADMIN_HASH=process.env.ADMIN_PASSWORD_HASH,SECRET=process.env.AUTH_SECRET;
if(!ADMIN_HASH||!SECRET)throw Error('Missing server secrets');
const pool=DB?new Pool({connectionString:DB,ssl:DB.includes('localhost')?false:{rejectUnauthorized:false},max:5}):fakePool,rate=new Map();
await pool.query("CREATE TABLE IF NOT EXISTS appointments (date DATE NOT NULL, time VARCHAR(5) NOT NULL, kind VARCHAR(8) NOT NULL CHECK(kind IN ('booked','blocked')), customer_name VARCHAR(90), phone VARCHAR(15), note VARCHAR(300), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(date,time))");
const json=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'GET,POST,OPTIONS','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))};
const body=req=>new Promise((resolve,reject)=>{let s='';req.on('data',x=>{s+=x;if(s.length>10000){reject(Error('LARGE'));req.destroy()}});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(Error('BAD_JSON'))}});req.on('error',reject)});
function today(){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day}
const clock=()=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
function daysAfter(s){const t=Date.parse(s+'T00:00:00Z');return Number.isFinite(t)&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(t).toISOString().slice(0,10)===s?Math.round((t-Date.parse(today()+'T00:00:00Z'))/86400000):NaN}
const validDate=s=>{const n=typeof s==='string'?daysAfter(s):NaN;return Number.isFinite(n)&&n>=0&&n<=59};
const validSlot=(date,time)=>validDate(date)&&HOURS.includes(time)&&!(date===today()&&time<=clock());
const range=(start,n)=>Array.from({length:n},(_,i)=>new Date(Date.parse(start+'T00:00:00Z')+86400000*i).toISOString().slice(0,10));
const limit=(ip,k,n,ms)=>{const key=ip+k,now=Date.now(),s=rate.get(key)||{count:0,until:now+ms};if(s.until<=now){s.count=0;s.until=now+ms}rate.set(key,s);return ++s.count>n};
function auth(req){const [s,signature]=(req.headers.authorization||'').replace(/^Bearer\s+/i,'').split('.');if(!s||!signature)return false;const good=crypto.createHmac('sha256',SECRET).update(s).digest('base64url');const a=Buffer.from(signature),b=Buffer.from(good);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return false;try{const p=JSON.parse(Buffer.from(s,'base64url'));return p.role==='admin'&&p.exp>Date.now()}catch{return false}}
function passwordOk(pass){if(typeof pass!=='string')return false;const [salt,hex]=ADMIN_HASH.split(':'),a=crypto.scryptSync(pass,salt,32),b=Buffer.from(hex,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}
const token=()=>{const p=Buffer.from(JSON.stringify({role:'admin',exp:Date.now()+43200000})).toString('base64url');return p+'.'+crypto.createHmac('sha256',SECRET).update(p).digest('base64url')};
http.createServer(async(req,res)=>{
if(req.method==='OPTIONS')return json(res,204,{});
const url=new URL(req.url,'https://example.org'),ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0];
try{
if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{ok:true,timezone:'Asia/Tehran'});
if(req.method==='GET'&&url.pathname==='/api/slots'){
 const start=url.searchParams.get('start')||today(),n=Number(url.searchParams.get('days')||7);
 if(!validDate(start)||!Number.isInteger(n)||n<1||n>7)return json(res,400,{error:'INVALID_DATE'});
 const dates=range(start,n).filter(validDate);if(!dates.length)return json(res,400,{error:'INVALID_DATE'});
 const rows=await pool.query('SELECT date::text AS date,time,kind FROM appointments WHERE date BETWEEN $1 AND $2',[dates[0],dates.at(-1)]);
 const dict=Object.fromEntries(rows.rows.map(x=>[x.date+'|'+x.time,x.kind]));
 return json(res,200,{today:today(),serverClock:clock(),hours:HOURS,days:dates.map(date=>({date,slots:HOURS.map(time=>({time,status:dict[date+'|'+time]||(validSlot(date,time)?'free':'past')}))}))});
}
if(req.method==='POST'&&url.pathname==='/api/book'){
 if(limit(ip,'book',12,3600000))return json(res,429,{error:'RATE_LIMIT'});
 const x=await body(req),name=String(x.name||'').trim(),phone=String(x.phone||'').replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).trim(),note=String(x.note||'').trim();
 if(!validSlot(x.date,x.time)||name.length<2||name.length>90||!/^(?:\+98|0)9\d{9}$/.test(phone)||note.length>300)return json(res,400,{error:'INVALID_DETAILS'});
 const q=await pool.query("INSERT INTO appointments(date,time,kind,customer_name,phone,note) VALUES($1,$2,'booked',$3,$4,$5) ON CONFLICT(date,time) DO NOTHING RETURNING time",[x.date,x.time,name,phone,note]);
 if(!q.rowCount)return json(res,409,{error:'SLOT_TAKEN'});
 return json(res,201,{ok:true,booking:{date:x.date,time:x.time,name}});
}
if(req.method==='POST'&&url.pathname==='/api/admin/login'){
 if(limit(ip,'login',8,900000))return json(res,429,{error:'RATE_LIMIT'});
 const x=await body(req);
 if(x.username!==ADMIN_USER||!passwordOk(x.password))return json(res,401,{error:'INVALID_CREDENTIALS'});
 return json(res,200,{token:token(),expiresHours:12});
}
if(url.pathname.startsWith('/api/admin/')){
 if(!auth(req))return json(res,401,{error:'UNAUTHORIZED'});
 if(req.method==='GET'&&url.pathname==='/api/admin/bookings'){
  const start=url.searchParams.get('start')||today(),n=Number(url.searchParams.get('days')||7);
  if(!validDate(start)||!Number.isInteger(n)||n<1||n>30)return json(res,400,{error:'INVALID_DATE'});
  const q=await pool.query('SELECT date::text AS date,time,kind,customer_name AS name,phone,note,created_at FROM appointments WHERE date BETWEEN $1 AND $2 ORDER BY date,time',[start,range(start,n).at(-1)]);
  return json(res,200,{bookings:q.rows});
 }
 if(req.method==='POST'&&url.pathname==='/api/admin/block'){
  const x=await body(req);if(!validSlot(x.date,x.time))return json(res,400,{error:'INVALID_SLOT'});
  const q=await pool.query("INSERT INTO appointments(date,time,kind) VALUES($1,$2,'blocked') ON CONFLICT(date,time) DO NOTHING RETURNING time",[x.date,x.time]);
  return json(res,q.rowCount?201:409,{ok:!!q.rowCount,error:q.rowCount?undefined:'SLOT_TAKEN'});
 }
 if(req.method==='POST'&&url.pathname==='/api/admin/release'){
  const x=await body(req);if(!validDate(x.date)||!HOURS.includes(x.time))return json(res,400,{error:'INVALID_SLOT'});
  const q=await pool.query('DELETE FROM appointments WHERE date=$1 AND time=$2 RETURNING kind',[x.date,x.time]);
  return json(res,200,{ok:true,removed:q.rows[0]?.kind||null});
 }
}
return json(res,404,{error:'NOT_FOUND'});
}catch(e){console.error(e);if(!res.headersSent)json(res,e.message==='BAD_JSON'?400:500,{error:e.message==='BAD_JSON'?'BAD_JSON':'SERVER_ERROR'})}
}).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Reservation server ready'));
