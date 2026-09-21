"""Operator-authored real React/Node/Postgres acceptance application.

Generated only inside the private disposable benchmark worktree. This is not an
application template or a substitute for a user's repository or model generation.
"""
import json
import hashlib
from pathlib import Path


def write_fixture(root):
    root = Path(root)
    files = {
        '.gitignore': 'node_modules/\n.next/\n',
        'frontend/package.json': json.dumps(dict(private=True, type='module', scripts=dict(dev='vite --host 127.0.0.1 --port 3000'), dependencies={'vite': '7.1.3', 'react': '19.1.1', 'react-dom': '19.1.1'})),
        'frontend/index.html': '<html><head><title>Full-stack preview</title></head><body><div id="root"></div><script type="module" src="/src.jsx"></script></body></html>',
        'frontend/vite.config.js': 'export default {server:{watch:{usePolling:true,interval:250}}};\n',
        'frontend/src.jsx': '''import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
function App() {
 const [notes,setNotes]=useState([]), [status,setStatus]=useState('');
 async function request(path, body) {
  const response=await fetch('/api/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Preview-CSRF':'fixture'},body:body?JSON.stringify(body):undefined});
  const result=await response.json(); if(!response.ok) throw Error('Request failed'); return result;
 }
 async function act(kind) {
  try {
   if(kind==='register'||kind==='login') await request(kind,{email:document.querySelector('#email').value,password:document.querySelector('#password').value});
   if(kind==='create') await request('notes',{text:document.querySelector('#note').value});
   if(kind==='load'||kind==='create') setNotes(await request('notes'));
   setStatus(kind+' complete');
  } catch {setStatus('failed');}
 }
 return <main><h1>Preview fixture</h1><label>Email<input id="email"/></label><label>Password<input id="password" type="password"/></label><button onClick={()=>act('register')}>Register</button><button onClick={()=>act('login')}>Log in</button><label>Note<input id="note"/></label><button onClick={()=>act('create')}>Create record</button><button onClick={()=>act('load')}>Load records</button><p role="status">{status}</p><ul>{notes.map(n=><li key={n.id}>{n.text}</li>)}</ul></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
''',
        'backend/package.json': json.dumps(dict(private=True, type='module', dependencies={'express': '5.1.0', 'pg': '8.16.3', 'nodemon': '3.1.10'})),
        'backend/migrate.mjs': '''import pg from 'pg';
const db=new pg.Client({connectionString:process.env.DATABASE_URL}); await db.connect();
await db.query(`CREATE TABLE users(id serial PRIMARY KEY,email text UNIQUE NOT NULL,password_hash text NOT NULL,salt text NOT NULL);
CREATE TABLE sessions(token_hash text PRIMARY KEY,user_id integer REFERENCES users(id));
CREATE TABLE notes(id serial PRIMARY KEY,user_id integer REFERENCES users(id),text text NOT NULL);`);
await db.end();
''',
        'backend/server.mjs': '''import express from 'express'; import pg from 'pg'; import crypto from 'node:crypto';
const app=express(), db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4});
app.use(express.json({limit:'1mb'}));
app.get('/api/health',async(req,res)=>{await db.query('SELECT 1');res.json({healthy:true});});
app.get('/api/version',(_req,res)=>res.json({version:'version-one'}));
app.use((req,res,next)=>{if(req.method==='POST'&&(req.headers.origin!=='https://'+req.headers.host||req.headers['x-preview-csrf']!=='fixture'))return res.status(403).json({error:'denied'});next();});
app.post('/api/register',async(req,res)=>{const salt=crypto.randomBytes(16).toString('hex'), hash=crypto.scryptSync(String(req.body.password),salt,32).toString('hex');await db.query('INSERT INTO users(email,password_hash,salt) VALUES($1,$2,$3)',[req.body.email,hash,salt]);res.json({created:true});});
app.post('/api/login',async(req,res)=>{const {rows}=await db.query('SELECT * FROM users WHERE email=$1',[req.body.email]);const u=rows[0];if(!u||!crypto.timingSafeEqual(Buffer.from(u.password_hash,'hex'),crypto.scryptSync(String(req.body.password),u.salt,32)))return res.status(401).json({error:'denied'});const token=crypto.randomBytes(32).toString('hex');await db.query('INSERT INTO sessions VALUES($1,$2)',[crypto.createHash('sha256').update(token).digest('hex'),u.id]);res.setHeader('Set-Cookie','preview_session='+token+'; Secure; HttpOnly; SameSite=Lax; Path=/api');res.json({authenticated:true});});
app.use(async(req,res,next)=>{const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('preview_session='))?.split('=')[1];if(!token)return res.status(401).json({error:'denied'});const {rows}=await db.query('SELECT user_id FROM sessions WHERE token_hash=$1',[crypto.createHash('sha256').update(token).digest('hex')]);if(!rows[0])return res.status(401).json({error:'denied'});req.user=rows[0].user_id;next();});
app.post('/api/notes',async(req,res)=>{await db.query('INSERT INTO notes(user_id,text) VALUES($1,$2)',[req.user,req.body.text]);res.json({created:true});});
app.get('/api/notes',async(req,res)=>res.json((await db.query('SELECT id,text FROM notes WHERE user_id=$1 ORDER BY id',[req.user])).rows));
app.use((_err,_req,res,_next)=>res.status(500).json({error:'request failed'}));
app.listen(8000,'127.0.0.1');
''',
    }
    for name, text in files.items():
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text)


def manifest(revision, scope):
    install = ['npm', 'install', '--package-lock=false', '--no-audit', '--no-fund']
    result = dict(schema_version=1, scope=scope, revision=revision, worktree_id='fixture',
                runtime_manifest_sha256='a' * 64, preview_manifest_sha256='b' * 64,
                services=[dict(id='frontend', role='frontend', framework='react-vite', directory='frontend',
                               install=install, start=['npm', 'run', 'dev'], migration=None, port=3000, health_path='/', environment_keys=[]),
                          dict(id='backend', role='backend', framework='node', directory='backend', install=install,
                               start=['node', 'node_modules/nodemon/bin/nodemon.js', '--legacy-watch', '--watch', 'server.mjs', 'server.mjs'],
                               migration=['node', 'migrate.mjs'], port=8000, health_path='/api/health', environment_keys=['DATABASE_URL'])],
                resources=[dict(id='db', kind='postgres')],
                quota=dict(cpu=2, memory_mb=2048, disk_mb=4096, pids=256, idle_seconds=300,
                           lifetime_seconds=900, startup_seconds=180, runtime_resources=3, concurrent_previews=1))
    result['runtime_manifest_sha256'] = hashlib.sha256(json.dumps(dict(services=result['services'], resources=result['resources']), sort_keys=True).encode()).hexdigest()
    result['preview_manifest_sha256'] = hashlib.sha256(b'fixture:isolated-localhost-origin:unix-gateway:network-none:v1').hexdigest()
    return result
