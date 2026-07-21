const crypto = require("crypto");
const { PrintAgent } = require("../models/painelModels");
const sockets = new Map();
function hash(v){return crypto.createHash("sha256").update(String(v)).digest("hex");}
function init(io){
 const ns=io.of("/print-agent");
 ns.use(async(socket,next)=>{
  try{
   const token=String(socket.handshake.auth?.token||""); const code=String(socket.handshake.auth?.code||"");
   let agent=null; let plainToken=token;
   if(token) agent=await PrintAgent.findOne({tokenHash:hash(token),ativo:true});
   if(!agent && code){ agent=await PrintAgent.findOne({codigoVinculacao:code,codigoExpiraEm:{$gt:new Date()},ativo:true}); if(agent){plainToken=crypto.randomBytes(32).toString("hex"); agent.tokenHash=hash(plainToken); agent.codigoVinculacao=""; agent.codigoExpiraEm=null; await agent.save(); socket.data.newToken=plainToken;} }
   if(!agent) return next(new Error("Agente não vinculado. Gere um código no painel."));
   socket.data.agent=agent; return next();
  }catch(e){next(new Error("Falha ao autenticar agente."));}
 });
 ns.on("connection",async socket=>{ const agent=socket.data.agent; const lojaId=String(agent.estabelecimentoId); sockets.set(lojaId,socket); agent.nomeComputador=String(socket.handshake.auth?.computerName||""); agent.ultimaConexao=new Date(); await agent.save(); if(socket.data.newToken) socket.emit("agent:token",{token:socket.data.newToken}); socket.emit("agent:ready",{lojaId}); socket.on("agent:printers",async printers=>{agent.impressoras=Array.isArray(printers)?printers:[];agent.ultimaConexao=new Date();await agent.save();}); socket.on("disconnect",()=>{if(sockets.get(lojaId)?.id===socket.id)sockets.delete(lojaId);}); });
}
function isOnline(id){return Boolean(sockets.get(String(id))?.connected);}
function request(id,event,payload={},timeout=15000){return new Promise((resolve,reject)=>{const socket=sockets.get(String(id));if(!socket?.connected)return reject(new Error("Agente de impressão desconectado."));socket.timeout(timeout).emit(event,payload,(err,result)=>{if(err)return reject(new Error("O agente não respondeu a tempo."));if(result?.success===false)return reject(new Error(result.message||"Falha no agente."));resolve(result?.data??result??{});});});}
module.exports={init,isOnline,request};
