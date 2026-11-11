"use strict";

// Executar na raiz do projeto WEB. Somente consultas: não inicia o sistema,
// não cria índices, não restaura backups e não chama provedores de pagamento.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { spawn } = require("node:child_process");
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 160 * 1024 * 1024;

function dependencies() {
  try { return { mongoose: require("mongoose"), dotenv: require("dotenv") }; }
  catch { throw Error("Coloque este arquivo na raiz do projeto WEB, ao lado de package.json e node_modules, e execute novamente."); }
}
function normalize(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function pick(doc, fields) { return Object.fromEntries(fields.filter(k => doc[k] !== undefined).map(k => [k, doc[k]])); }
function active(doc) { return doc.ativo !== false && doc.arquivado !== true && doc.excluido !== true && !doc.arquivadoEm && !doc.deletedAt; }
function collectionName(names, aliases, required = false) {
  const matches = names.filter(name => aliases.some(alias => normalize(alias) === normalize(name)));
  if (matches.length > 1) throw Error("Há mais de uma coleção equivalente a " + aliases[0] + ". É necessário revisar antes de exportar.");
  if (!matches.length && required) throw Error("Coleção obrigatória não encontrada: " + aliases[0]);
  return matches[0] || null;
}
function safeDocument(doc) {
  if (Array.isArray(doc)) return doc.map(safeDocument);
  if (!doc || typeof doc !== "object" || doc instanceof Date || doc._bsontype || Buffer.isBuffer(doc)) return doc;
  return Object.fromEntries(Object.entries(doc)
    .filter(([key]) => !/senha|password|secret|token|credential|connectionstring|idempotency|lockid|lockexpira|pixqrcode|pixcopiacola|pagamentoinconsistencia/i.test(key))
    .map(([key, value]) => [key, safeDocument(value)]));
}
function cycleDates(doc = {}) {
  const validDates = (doc.historicoFinanceiro || []).map(v => v.aprovadoEm).filter(v => v && Number.isFinite(new Date(v).getTime()));
  validDates.sort((a, b) => new Date(a) - new Date(b));
  return {
    inicio: doc.planoInicio || null,
    vencimento: doc.planoExpira || null,
    primeiroPagamentoRegistradoEm: validDates[0] || null,
    uso: "Referência histórica. Não ativa licença nem cobrança no desktop.",
  };
}
function scopeQuery(ObjectId, id) { return { estabelecimentoId: { $in: [new ObjectId(id), id] } }; }
function chooseCatalog(products, categories) {
  const visibleCategories = new Set(categories.filter(active).map(c => String(c._id)));
  return products.filter(p => active(p) && visibleCategories.has(String(p.categoriaId)));
}
function enrichOrders(orders, products, categories) {
  const byProduct = new Map(products.map(p => [String(p._id), p]));
  const byCategory = new Map(categories.map(c => [String(c._id), c.nome]));
  return orders.map(order => ({ ...safeDocument(order), itens: (order.itens || []).map(item => {
    const product = byProduct.get(String(item.produtoId));
    const categoriaId = item.categoriaId || product?.categoriaId;
    return { ...safeDocument(item), ...(categoriaId ? { categoriaId, categoriaNome: byCategory.get(String(categoriaId)) || item.categoriaNome || "" } : {}) };
  }) }));
}
const CONFIG_FIELDS = ["_id", "estabelecimentoId", "nomeEstabelecimento", "descricao", "telefone", "endereco", "timezone", "fotoPerfil", "fotoPerfilArquivo", "slug", "horarioAbertura", "horarioFechamento", "diasFuncionamento", "createdAt", "updatedAt"];
const STAFF_FIELDS = ["_id", "estabelecimentoId", "nome", "cpf", "email", "telefone", "endereco", "salario", "foto", "fotoArquivo", "funcao", "ativo", "permissoes", "createdAt", "updatedAt"];

async function collectData({ db, client, ObjectId, id, names, session, progress = () => {} }) {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw Error("Identificador de cliente inválido.");
  const root = collectionName(names, ["registros", "registro"], true);
  const account = await db.collection(root).findOne({ _id: new ObjectId(id) }, { session, projection: { nome: 1, nomeEstabelecimento: 1, email: 1, telefone: 1, cpfCnpj: 1 } });
  if (!account) throw Error("Cliente não encontrado na leitura consistente.");
  const warnings = [];
  async function read(aliases, required = false, projection) {
    const name = collectionName(names, aliases, required);
    if (!name) { warnings.push("Coleção não existente no banco: " + aliases[0]); return []; }
    progress("Lendo " + aliases[0] + "…");
    return db.collection(name).find(scopeQuery(ObjectId, id), { session, ...(projection ? { projection } : {}) }).toArray();
  }
  // Consultas sequenciais compartilham a mesma sessão de snapshot.
  const categories = (await read(["categorias"], true)).filter(c => c.tipo !== "estoque");
  const productSource = await read(["produtos"], true);
  const orders = await read(["pedidos"], true);
  const staff = await read(["funcionarios"], false, Object.fromEntries(STAFF_FIELDS.map(k => [k, 1])));
  const configs = await read(["configuracaos", "configuracoes"], true, Object.fromEntries(CONFIG_FIELDS.map(k => [k, 1])));
  const cities = await read(["cidadeentregas", "cidadesentregas"]);
  const tables = await read(["mesas"]);
  const subscriptionsName = collectionName(names, ["assinaturas"]);
  // Apenas datas históricas do ciclo: nenhum plano, status, ID de cobrança ou credencial.
  const dates = subscriptionsName ? await db.collection(subscriptionsName).findOne(scopeQuery(ObjectId, id), { session, projection: { planoInicio: 1, planoExpira: 1, "historicoFinanceiro.aprovadoEm": 1 } }) : null;
  const products = chooseCatalog(productSource, categories).map(p => {
    const value = safeDocument(p);
    value.adicionais = (value.adicionais || []).filter(active);
    return value;
  });
  const config = configs[0];
  if (configs.length !== 1) throw Error("O cliente não possui exatamente uma configuração. Revise antes de exportar.");
  const data = {
    formato: "comandafacil-web-dados-operacionais",
    versao: 1,
    exportadoEm: new Date(),
    bancoOrigem: db.databaseName,
    leituraConsistente: true,
    estabelecimento: safeDocument(account),
    ciclo: cycleDates(dates || {}),
    configuracaoCardapio: pick(config, CONFIG_FIELDS),
    categorias: categories.map(safeDocument),
    produtos: products,
    pedidos: enrichOrders(orders, productSource, categories),
    funcionarios: staff.map(s => pick(s, STAFF_FIELDS)),
    cidadesEntrega: cities.map(safeDocument),
    mesas: tables.map(safeDocument),
    controle: {
      produtosAtivos: products.length,
      produtosForaDoCatalogo: productSource.length - products.length,
      pedidos: orders.length,
      funcionarios: staff.length,
      observacoes: warnings,
      relatoriosDashboard: "Recompor a partir dos pedidos, pagamentos, custos, descontos, datas e categorias históricos preservados. Não são telas importáveis diretamente.",
      contasFuncionarios: "Senhas não exportadas. Precisam ser definidas no desktop.",
      excluidosDoPacote: ["planos", "assinaturas", "integrações e credenciais", "produtos arquivados no catálogo", "estoque e sua movimentação", "sessões", "fila de impressão", "WhatsApp"],
    },
    imagens: [],
  };
  return data;
}

function mediaReferences(data) {
  const refs = [];
  function add(kind, doc, fileField, valueField) {
    const value = doc?.[fileField]?.url || doc?.[valueField];
    if (value && typeof value === "string") refs.push({ tipo: kind, id: String(doc._id || ""), url: value });
  }
  data.produtos.forEach(p => add("produto", p, "imagemArquivo", "imagem"));
  data.funcionarios.forEach(p => add("funcionario", p, "fotoArquivo", "foto"));
  add("estabelecimento", data.configuracaoCardapio, "fotoPerfilArquivo", "fotoPerfil");
  return refs;
}
async function readRemoteImage(source, baseUrl) {
  let url;
  try { url = new URL(source, baseUrl || undefined); } catch { throw Error("Uma foto possui endereço relativo e o endereço do site não foi informado."); }
  const allowed = new Set(["res.cloudinary.com"]);
  if (baseUrl) { try { allowed.add(new URL(baseUrl).hostname); } catch {} }
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:" || url.username || url.password || !allowed.has(url.hostname)) throw Error("Uma foto usa um endereço não autorizado. Informe o domínio correto do site.");
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(25000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw Error("Redirecionamento inválido em uma foto.");
      url = new URL(location, url); await response.body?.cancel(); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw Error("Não foi possível baixar uma foto (HTTP " + response.status + ")."); }
    const mime = (response.headers.get("content-type") || "").split(";")[0];
    if (!["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(mime)) { await response.body?.cancel(); throw Error("Uma foto retornou formato não suportado."); }
    const chunks = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > MAX_IMAGE_BYTES) throw Error("Uma foto ultrapassou 12 MB."); chunks.push(Buffer.from(part)); }
    return { bytes: Buffer.concat(chunks), mime };
  }
  throw Error("Uma foto possui redirecionamentos demais.");
}
async function addImages(data, baseUrl, include, projectDir, progress) {
  const refs = mediaReferences(data);
  if (!include) {
    data.controle.observacoes.push("Fotos não incorporadas. As referências foram preservadas; ainda será necessário copiá-las.");
    data.controle.imagensIncluidas = false; return;
  }
  const cache = new Map(); let total = 0;
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]; progress("Copiando foto " + (i + 1) + " de " + refs.length + "…");
    let image = cache.get(ref.url);
    if (!image) {
      let local;
      if (/^\/uploads\//.test(ref.url)) {
        const root = path.resolve(projectDir, "public", "uploads");
        const location = path.resolve(root, decodeURIComponent(ref.url.slice("/uploads/".length)));
        if (location.startsWith(root + path.sep)) { try { const stat = await fsp.stat(location); if (stat.isFile() && stat.size <= MAX_IMAGE_BYTES) local = await fsp.readFile(location); } catch {} }
      }
      if (local) {
        const ext = path.extname(ref.url).toLowerCase();
        const mime = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".avif": "image/avif" }[ext];
        if (!mime) throw Error("Uma foto local tem formato desconhecido.");
        image = { bytes: local, mime };
      } else image = await readRemoteImage(ref.url, baseUrl);
      total += image.bytes.length;
      if (total > MAX_TOTAL_IMAGE_BYTES) throw Error("Fotos ultrapassaram 160 MB. Exporte sem fotos e copie-as separadamente.");
      image.sha256 = crypto.createHash("sha256").update(image.bytes).digest("hex");
      cache.set(ref.url, image);
    }
    data.imagens.push({ ...ref, mimeType: image.mime, sha256: image.sha256, base64: image.bytes.toString("base64") });
  }
  data.controle.imagensIncluidas = true;
}
async function saveArchive(data, EJSON, directory) {
  const json = EJSON.stringify(data, { relaxed: false });
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) throw Error("Exportação acima de 256 MB. Será necessário exportar em partes.");
  const compressed = await gzip(json);
  // Verifica o arquivo antes de torná-lo disponível para download.
  const verified = await gunzip(compressed);
  if (!verified.equals(Buffer.from(json))) throw Error("A verificação do arquivo falhou.");
  const name = "dados-web-" + String(data.estabelecimento._id) + "-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex") + ".json.gz";
  const destination = path.join(directory, name);
  await fsp.writeFile(destination, compressed, { mode: 0o600, flag: "wx" });
  return { name, destination, bytes: compressed.length, sha256: crypto.createHash("sha256").update(compressed).digest("hex"), estabelecimento: data.estabelecimento.nomeEstabelecimento, controle: data.controle };
}
function publicFailure(error) {
  if (error?.code === 18 || /authentication|bad auth/i.test(String(error?.message))) return "Usuário ou senha do MongoDB não foram aceitos. Confira o .env do projeto.";
  if (/snapshot/i.test(String(error?.message))) return "A leitura consistente não foi concluída. Nenhum arquivo parcial foi entregue. Aguarde e tente novamente; se persistir, envie apenas esta mensagem.";
  if (/Mongo|ServerSelection|network|ECONN|ENOTFOUND|querySrv|Invalid scheme/i.test(String(error?.name) + " " + String(error?.message))) return "Não foi possível conectar ao MongoDB. Confira a CONNECTIONSTRING do .env e a liberação do IP no Atlas.";
  return String(error?.message || "Falha na exportação.").replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[conexão oculta]").slice(0, 400);
}

function page(prefix, nonce) {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comanda Fácil · Exportar dados</title><style>
*{box-sizing:border-box}body{margin:0;background:#f2f5fa;color:#162539;font:16px system-ui,sans-serif}main{max-width:900px;margin:45px auto;padding:26px}article{background:white;border:1px solid #dae2ef;border-radius:18px;padding:28px;margin:18px 0}h1{font-size:32px;margin:12px 0}h2{font-size:21px}p{line-height:1.6;color:#526174}.brand{color:#0068cf;font-weight:800}button,a.download{background:#0968d6;color:white;border:0;border-radius:10px;padding:14px 20px;font:600 16px system-ui;cursor:pointer;display:inline-block;text-decoration:none}button:disabled{opacity:.5;cursor:wait}label{display:block;margin:16px 0;line-height:1.5}input[type=text]{width:100%;padding:12px;border:1px solid #c8d4e5;border-radius:8px;font:16px system-ui}input[type=checkbox]{width:18px;height:18px;margin-right:9px}.account{border-bottom:1px solid #e8edf4;padding:13px 0}.small{font-size:13px;color:#66758a}#message{white-space:pre-wrap;font-weight:600;line-height:1.6}.tag{display:inline-block;background:#e7f2ff;color:#0b5eb8;border-radius:20px;padding:6px 10px;font-size:13px;margin:4px}a{color:#0968d6}#results article{border:1px solid #86c69d}.error{color:#a2212b}code{overflow-wrap:anywhere}@media(max-width:600px){main{padding:14px;margin:15px auto}article{padding:19px}h1{font-size:26px}}</style>
<main><div class="brand">COMANDA FÁCIL</div><h1>Exportar dados do web</h1><p>Escolha os clientes e salve os dados para preparar a migração ao desktop.</p>
<article><h2>1. Encontrar os clientes</h2><p>A conexão será lida do <strong>.env deste projeto</strong>. Você não precisa colar chave ou senha aqui.</p><button id="connect">Carregar clientes</button><p id="connection" class="small"></p></article>
<article id="selection" hidden><h2>2. Escolher o que salvar</h2><div id="accounts"></div><p class="small">Selecione até dois clientes. Confira o nome do cadastro e o nome do cardápio.</p><span class="tag">Produtos ativos</span><span class="tag">Cardápio</span><span class="tag">Pedidos e histórico</span><span class="tag">Funcionários</span><span class="tag">Datas do ciclo</span><p>Relatórios e dashboard serão recompostos a partir do histórico. Produtos arquivados não entram no catálogo; os itens dos pedidos antigos permanecem no histórico.</p><p class="small">Sem planos, assinaturas ou integração de pagamento. As datas do ciclo são apenas uma referência. As senhas dos funcionários precisarão ser definidas no desktop.</p><label>Endereço do site para copiar fotos relativas<input id="site" type="text" placeholder="https://seu-site.com.br"></label><label><input id="photos" type="checkbox" checked>Incluir fotos dos produtos, funcionários e estabelecimento</label><button id="export">Exportar clientes selecionados</button></article>
<article><h2>Andamento</h2><div id="message">Pronto para conectar.</div></article><div id="results"></div><p class="small">Esta ferramenta apenas lê o banco e salva os arquivos neste computador. O pacote exportado ainda precisa de conversão para o desktop; não encerre o MongoDB antes da conferência da migração.</p></main>
<script nonce="${nonce}">
const prefix=${JSON.stringify(prefix)}; let busy=false; let polling;
const $=id=>document.getElementById(id);const message=(text,error=false)=>{$('message').textContent=text;$('message').className=error?'error':''};
async function request(route,data){const r=await fetch(prefix+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});const v=await r.json();if(!r.ok)throw Error(v.error||'Falha na operação');return v;}
$('connect').onclick=async()=>{if(busy)return;busy=true;$('connect').disabled=true;message('Conectando e consultando clientes…');try{const v=await request('connect');$('accounts').replaceChildren();for(const c of v.accounts){const row=document.createElement('label');row.className='account';const check=document.createElement('input');check.type='checkbox';check.value=c.id;row.append(check,document.createTextNode(c.name));const extra=document.createElement('div');extra.className='small';extra.textContent='Cardápio: '+(c.menuName||'não informado')+' · ID: '+c.id;row.append(extra);$('accounts').append(row);}$('site').value=v.site||'';$('connection').textContent='Banco: '+v.database+' · Servidor: '+v.host;$('selection').hidden=false;message('Clientes carregados. Selecione os dois cadastros corretos.');}catch(e){message(e.message,true)}finally{busy=false;$('connect').disabled=false}};
async function update(){try{const r=await fetch(prefix+'status');const v=await r.json();message(v.message,v.state==='error');if(v.state==='done'||v.state==='error'){clearInterval(polling);busy=false;$('export').disabled=false;$('connect').disabled=false;$('results').replaceChildren();for(let i=0;i<v.files.length;i++){const f=v.files[i],card=document.createElement('article'),h=document.createElement('h2'),p=document.createElement('p'),a=document.createElement('a');h.textContent=f.estabelecimento;p.textContent=f.controle.produtosAtivos+' produtos ativos · '+f.controle.pedidos+' pedidos · '+f.controle.funcionarios+' funcionários';a.className='download';a.textContent='Baixar arquivo deste cliente';a.href=prefix+'download/'+i;card.append(h,p,a);if(f.controle.observacoes.length){const note=document.createElement('p');note.textContent=f.controle.observacoes.join(' ');card.append(note)}$('results').append(card)}}}catch{message('A ferramenta local foi encerrada ou perdeu a conexão.',true);clearInterval(polling)}}
$('export').onclick=async()=>{if(busy)return;const ids=[...$('accounts').querySelectorAll('input:checked')].map(x=>x.value);if(!ids.length||ids.length>2){message('Selecione um ou dois clientes.',true);return;}busy=true;$('export').disabled=true;$('connect').disabled=true;$('results').replaceChildren();try{await request('export',{ids,includePhotos:$('photos').checked,site:$('site').value});message('Preparando a exportação…');polling=setInterval(update,1000);await update()}catch(e){busy=false;$('export').disabled=false;$('connect').disabled=false;message(e.message,true)}};
</script></html>`;
}

async function startServer({ mongoose, dotenv }, projectDir = process.cwd(), { openBrowser = true, outputDirectory } = {}) {
  dotenv.config({ path: path.join(projectDir, ".env"), quiet: true });
  const prefix = "/" + crypto.randomBytes(24).toString("hex") + "/";
  const nonce = crypto.randomBytes(18).toString("base64");
  let client, db, names, accounts = [], base;
  let state = { state: "idle", message: "Pronto para conectar.", files: [] };
  const outputDir = outputDirectory || path.join(os.homedir(), "ComandaFacil-Backups");
  async function json(req) {
    let size = 0, chunks = [];
    for await (const part of req) { size += part.length; if (size > 16_384) throw Error("Solicitação muito grande."); chunks.push(part); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-" + nonce + "'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    function send(code, data) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); }
    if (req.headers.host !== new URL(base).host || !req.url.startsWith(prefix)) return send(403, { error: "Acesso local inválido." });
    const route = req.url.slice(prefix.length).split("?")[0];
    if (req.method === "GET" && route === "") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page(prefix, nonce)); }
    if (req.method === "GET" && route === "status") return send(200, state);
    if (req.method === "GET" && /^download\/\d+$/.test(route)) {
      const file = state.files[Number(route.split("/")[1])];
      if (!file || state.state !== "done") return send(404, { error: "Arquivo não disponível." });
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": file.bytes, "Content-Disposition": 'attachment; filename="' + file.name + '"' });
      const stream = fs.createReadStream(file.destination); stream.on("error", () => res.destroy()); return stream.pipe(res);
    }
    if (req.method !== "POST" || req.headers.origin !== base || !String(req.headers["content-type"]).startsWith("application/json")) return send(403, { error: "Origem da solicitação inválida." });
    try {
      if (state.state === "exporting") return send(409, { error: "Aguarde a exportação terminar." });
      if (route === "connect") {
        if (client) { await client.close(); client = null; }
        db = null; names = null; accounts = [];
        const uri = String(process.env.CONNECTIONSTRING || "").trim();
        if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) throw Error("A CONNECTIONSTRING do .env não é válida. Use a mesma configuração que listou as contas corretas.");
        client = new mongoose.mongo.MongoClient(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000, promoteLongs: false });
        await client.connect(); db = client.db("comandafacil");
        names = (await db.listCollections({}, { nameOnly: true }).toArray()).filter(c => c.type !== "view").map(c => c.name);
        const root = collectionName(names, ["registros", "registro"], true);
        const users = await db.collection(root).find({}, { projection: { nomeEstabelecimento: 1 } }).toArray();
        const configName = collectionName(names, ["configuracaos", "configuracoes"]);
        const configs = configName ? await db.collection(configName).find({}, { projection: { estabelecimentoId: 1, nomeEstabelecimento: 1 } }).toArray() : [];
        accounts = users.map(c => ({ id: String(c._id), name: c.nomeEstabelecimento || "Sem nome", menuName: configs.find(v => String(v.estabelecimentoId) === String(c._id))?.nomeEstabelecimento || "" }));
        state = { state: "idle", message: "Clientes carregados.", files: [] };
        let host = "conexão do .env"; try { host = new URL(uri).hostname; } catch {}
        const configuredSite = String(process.env.APP_URL || "");
        return send(200, { accounts, database: db.databaseName, host, site: /^https:\/\//i.test(configuredSite) ? configuredSite : "" });
      }
      if (route === "export") {
        const body = await json(req);
        const ids = [...new Set(Array.isArray(body.ids) ? body.ids : [])];
        if (!client || !db || !ids.length || ids.length > 2 || ids.some(id => !accounts.some(a => a.id === id))) throw Error("Selecione um ou dois clientes da lista carregada.");
        const site = String(body.site || "").trim();
        if (site) { const url = new URL(site); if (url.protocol !== "https:" || url.username || url.password) throw Error("Informe o endereço HTTPS do site, sem usuário ou senha."); }
        state = { state: "exporting", message: "Preparando leitura consistente…", files: [] };
        send(202, { ok: true });
        void (async () => {
          const session = client.startSession({ snapshot: true });
          const completed = [];
          try {
            await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
            const bundles = [];
            for (const id of ids) {
              const data = await collectData({ db, client, ObjectId: mongoose.mongo.ObjectId, id, names, session, progress: text => { state.message = accounts.find(a => a.id === id).name + ": " + text; } });
              bundles.push(data);
            }
            // As fotos não mantêm a sessão de leitura aberta enquanto são baixadas.
            await session.endSession();
            for (const data of bundles) {
              await addImages(data, site, body.includePhotos !== false, projectDir, text => { state.message = text; });
              completed.push(await saveArchive(data, mongoose.mongo.BSON.EJSON, outputDir));
            }
            state = { state: "done", message: "Exportação concluída e arquivos verificados. Cópias salvas em " + outputDir + ". Baixe os arquivos de cada cliente abaixo.", files: completed };
          } catch (error) {
            for (const file of completed) await fsp.unlink(file.destination).catch(() => {});
            state = { state: "error", message: publicFailure(error), files: [] };
          } finally { await session.endSession(); }
        })();
        return;
      }
      send(404, { error: "Operação não encontrada." });
    } catch (error) { send(400, { error: publicFailure(error) }); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;
  const address = base + prefix;
  console.log("Exportador local iniciado. Abra no navegador:\n" + address + "\nPara encerrar, pressione Ctrl+C. Nenhuma credencial será exibida.");
  const opener = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", address]] : process.platform === "darwin" ? ["open", [address]] : ["xdg-open", [address]];
  if (openBrowser) { const child = spawn(opener[0], opener[1], { stdio: "ignore", detached: true }); child.on("error", () => {}); child.unref(); }
  const close = async () => { await client?.close().catch(() => {}); server.close(); };
  process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
  return { server, address, close };
}

module.exports = { active, chooseCatalog, cycleDates, enrichOrders, collectionName, safeDocument, scopeQuery, collectData, mediaReferences, addImages, saveArchive, publicFailure, page, startServer };
if (require.main === module) startServer(dependencies()).catch(error => { console.error(publicFailure(error)); process.exitCode = 1; });
