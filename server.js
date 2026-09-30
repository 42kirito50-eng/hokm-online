const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'hokm-2.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api', (_req, res) => res.json({ name: 'Hokm Online Server', version: '1.0.0' }));

const rooms = new Map();
const SUITS = ['♠','♥','♦','♣'];
const NAMES = ['ربات ۱','ربات ۲','ربات ۳'];
const roomCode = () => {
  let c;
  do c = String(1000 + Math.floor(Math.random() * 9000)); while (rooms.has(c));
  return c;
};
const cleanName = n => String(n || 'بازیکن').trim().slice(0, 14) || 'بازیکن';
const suit = c => Math.floor(c / 13);
const rank = c => c % 13;
const team = (n, s) => n === 4 ? s % 2 : s;
const shuffle = a => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };

function sortHand(h, trump) {
  const score = c => (suit(c) === trump ? -1 : suit(c)) * 100 - rank(c);
  return h.sort((a,b) => score(a)-score(b));
}
function legal(state, s) {
  const h = state.hands[s] || [];
  if (!state.trick.length) return h;
  const lead = suit(state.trick[0].c);
  const same = h.filter(c => suit(c) === lead);
  return same.length ? same : h;
}
function beats(a,b,trump) {
  return suit(a) === suit(b) ? rank(a) > rank(b) : suit(a) === trump && suit(b) !== trump;
}
function best(state) {
  return state.trick.reduce((w,x) => !w || beats(x.c,w.c,state.trump) ? x : w, null);
}
function chooseBot(state,s) {
  const L = legal(state,s);
  if (!L.length) return null;
  if (state.phase === 'trump') {
    const scores = [0,0,0,0];
    state.hands[s].forEach(c => scores[suit(c)] += 3 + (rank(c)>=10 ? rank(c)-8 : 0));
    return scores.indexOf(Math.max(...scores));
  }
  const value = c => (suit(c) === state.trump ? 100 : 0) + rank(c);
  if (!state.trick.length) {
    const ace = L.find(c => rank(c) === 12 && suit(c) !== state.trump);
    if (ace != null) return ace;
    return [...L].sort((a,b)=>value(a)-value(b))[0];
  }
  const b = best(state);
  if (state.n === 4 && team(state.n,b.s) === team(state.n,s)) return [...L].sort((a,b)=>value(a)-value(b))[0];
  const winning = L.filter(c => beats(c,b.c,state.trump));
  return (winning.length ? winning : L).sort((a,b)=>value(a)-value(b))[0];
}

function newRound(room) {
  const d = shuffle([...Array(52).keys()]);
  const n = room.state.n;
  room.state.hands = Array.from({length:n}, (_,i)=>sortHand(d.slice(i*5,i*5+5), -1));
  room.state.rest = d.slice(n*5);
  room.state.phase = 'trump';
  room.state.trump = -1;
  room.state.tw = [0,0];
  room.state.trick = [];
  room.state.turn = room.state.hak;
  room.state.last = null;
  room.state.lw = null;
  room.state.rt = -1;
  room.state.pts = 0;
  room.state.kt = '';
}
function newGame(room) {
  const n = room.n;
  room.state = {
    n,
    hak: Math.floor(Math.random()*n),
    score: [0,0],
    names: room.seats.map((x,i)=>x ? x.name : NAMES[i % NAMES.length]),
    human: room.seats.map(Boolean),
    phase: '', win: -1, trump: -1, tw:[0,0], trick:[], turn:0,
    hands:[], rest:[], last:null, lw:null, rt:-1, pts:0, kt:''
  };
  newRound(room);
}
function publicState(room, viewerSeat) {
  const s = JSON.parse(JSON.stringify(room.state));
  // Never send opponents' private cards to a client.
  s.hands = s.hands.map((h,i) => i === viewerSeat ? h : Array(h.length).fill(null));
  s.rest = [];
  return s;
}
function lobby(room, seat) {
  return {
    code: room.code, n: room.n, seat,
    host: room.hostSeat === seat,
    seats: room.seats.map(x => x ? {name:x.name} : null),
    message: room.started ? 'بازی شروع شده' : ''
  };
}
function emitLobby(room) {
  room.seats.forEach((p,i)=>{ if(p?.socketId) io.to(p.socketId).emit('lobby', lobby(room,i)); });
}
function emitState(room) {
  room.seats.forEach((p,i)=>{ if(p?.socketId) io.to(p.socketId).emit('game:state',{seat:i,state:publicState(room,i)}); });
}
function fail(socket,event,message){ socket.emit(event,{message}); }
function findSeat(room,socketId){ return room.seats.findIndex(p=>p?.socketId===socketId); }

function startIfNeeded(room) {
  if (!room.started) return;
  emitState(room);
  scheduleBot(room);
}
function scheduleBot(room) {
  if (!room.started || !room.state || room.state.phase === 'over') return;
  const s = room.state.turn;
  if (s < 0 || room.state.human[s]) return;
  clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => {
    if (!rooms.has(room.code) || !room.started) return;
    if (room.state.phase === 'trump') playAction(room,s,'t',chooseBot(room.state,s));
    else if (room.state.phase === 'play') playAction(room,s,'p',chooseBot(room.state,s));
  }, 700);
}
function finishTrick(room) {
  const w = best(room.state).s;
  const t = team(room.state.n,w);
  room.state.tw[t]++;
  room.state.last = room.state.trick;
  room.state.lw = w;
  room.state.trick = [];
  room.state.turn = w;
  room.state.phase = 'play';
  if (room.state.tw[t] >= 7) finishRound(room,t);
}
function finishRound(room,t) {
  const ht = team(room.state.n, room.state.hak);
  const other = room.state.tw[1-t];
  let pts = 1, label='';
  if (!other) { pts = t !== ht ? 3 : 2; label = t !== ht ? ' (حاکم‌کوت!)' : ' (کوت!)'; }
  room.state.score[t] += pts;
  room.state.rt=t; room.state.pts=pts; room.state.kt=label; room.state.phase='re';
  if (room.state.score[t] >= room.target) { room.state.phase='over'; room.state.win=t; return; }
  clearTimeout(room.roundTimer);
  room.roundTimer=setTimeout(()=>{
    if (!rooms.has(room.code) || room.state.phase !== 're') return;
    if (t !== ht) room.state.hak=(room.state.hak+1)%room.state.n;
    newRound(room); emitState(room); scheduleBot(room);
  },2600);
}
function playAction(room,s,type,value) {
  const state=room.state;
  if (!state || state.turn !== s) return;
  if (type === 't') {
    if (state.phase !== 'trump' || value < 0 || value > 3) return;
    state.trump=value;
    state.hands.forEach(h=>{h.push(...state.rest.splice(0,8));sortHand(h,state.trump);});
    state.phase='play'; state.turn=state.hak;
  } else {
    if (state.phase !== 'play' || !Number.isInteger(value)) return;
    const L=legal(state,s);
    if (!L.includes(value)) return;
    const h=state.hands[s]; h.splice(h.indexOf(value),1); state.trick.push({s,c:value});
    if (state.trick.length===state.n) { state.phase='wait'; emitState(room); clearTimeout(room.trickTimer); room.trickTimer=setTimeout(()=>{ if(rooms.has(room.code)) { finishTrick(room); emitState(room); scheduleBot(room); } }, room.speed); return; }
    state.turn=(s+1)%state.n;
  }
  emitState(room); scheduleBot(room);
}

io.on('connection', socket => {
  socket.on('room:create', ({n,name})=>{
    n = n===4 ? 4 : 2;
    const code=roomCode();
    const room={code,n,target:7,speed:1000,hostSeat:0,started:false,seats:Array(n).fill(null),state:null,botTimer:null,trickTimer:null,roundTimer:null};
    room.seats[0]={socketId:socket.id,name:cleanName(name)};
    rooms.set(code,room); socket.join(code); socket.data.room=code; socket.data.seat=0;
    socket.emit('room:created',lobby(room,0)); emitLobby(room);
  });
  socket.on('room:join', ({code,name})=>{
    code=String(code||'').trim(); const room=rooms.get(code);
    if(!room) return fail(socket,'room:error','اتاق پیدا نشد');
    if(room.started) return fail(socket,'room:error','این بازی شروع شده است');
    const seat=room.seats.findIndex(x=>!x);
    if(seat<0) return fail(socket,'room:error','ظرفیت اتاق پر است');
    room.seats[seat]={socketId:socket.id,name:cleanName(name)}; socket.join(code); socket.data.room=code; socket.data.seat=seat;
    socket.emit('room:joined',lobby(room,seat)); emitLobby(room);
  });
  socket.on('room:reconnect', ({code,name,seat})=>{
    const room=rooms.get(String(code||'')); if(!room) return;
    seat=Number(seat);
    if(!Number.isInteger(seat)||seat<0||seat>=room.n) return;
    const p=room.seats[seat]; if(!p) return;
    p.socketId=socket.id; p.name=cleanName(name||p.name); socket.join(room.code); socket.data.room=room.code; socket.data.seat=seat;
    if(room.started) socket.emit('game:state',{seat,state:publicState(room,seat)}); else socket.emit('lobby',lobby(room,seat));
  });
  socket.on('game:start', ({code})=>{
    const room=rooms.get(String(code||'')); if(!room) return fail(socket,'game:error','اتاق پیدا نشد');
    const seat=findSeat(room,socket.id); if(seat!==room.hostSeat) return fail(socket,'game:error','فقط سازنده اتاق می‌تواند بازی را شروع کند');
    if(room.started) return;
    room.seats=room.seats.map((p,i)=>p||{socketId:null,name:NAMES[i%NAMES.length],bot:true});
    room.started=true; newGame(room); emitState(room); scheduleBot(room);
  });
  socket.on('game:action', ({code,seat,type,value})=>{
    const room=rooms.get(String(code||'')); if(!room||!room.started) return;
    const actual=findSeat(room,socket.id); if(actual!==Number(seat)) return;
    playAction(room,actual,type,Number(value));
  });
  socket.on('room:leave', ({code})=>{
    const room=rooms.get(String(code||'')); if(!room) return;
    const seat=findSeat(room,socket.id); if(seat<0) return;
    if(room.started){ room.seats[seat].socketId=null; room.seats[seat].bot=true; room.seats[seat].name=NAMES[seat%NAMES.length]; room.state.human[seat]=false; room.state.names[seat]=room.seats[seat].name; emitState(room); scheduleBot(room); }
    else { room.seats[seat]=null; if(seat===room.hostSeat){ const next=room.seats.findIndex(Boolean); if(next<0){rooms.delete(room.code);return;} room.hostSeat=next; } emitLobby(room); }
    socket.leave(room.code); socket.data.room=null;
  });
  socket.on('disconnect',()=>{
    const code=socket.data.room, seat=socket.data.seat; if(!code)return;
    const room=rooms.get(code); if(!room)return;
    if(room.started && room.seats[seat]?.socketId===socket.id){
      room.seats[seat].socketId=null; room.seats[seat].bot=true; room.seats[seat].name=NAMES[seat%NAMES.length];
      room.state.human[seat]=false; room.state.names[seat]=room.seats[seat].name; emitState(room); scheduleBot(room);
    } else if(!room.started && room.seats[seat]?.socketId===socket.id){
      room.seats[seat]=null; if(seat===room.hostSeat){const next=room.seats.findIndex(Boolean); if(next<0){rooms.delete(code);return;} room.hostSeat=next;} emitLobby(room);
    }
  });
});

setInterval(()=>{
  for(const [code,room] of rooms){
    const active=room.seats.some(Boolean);
    if(!active){clearTimeout(room.botTimer);clearTimeout(room.trickTimer);clearTimeout(room.roundTimer);rooms.delete(code);}
  }
},60000);

httpServer.listen(PORT,()=>console.log(`Hokm server listening on http://localhost:${PORT}`));
