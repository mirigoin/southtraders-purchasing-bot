var currentSlot=null;
var suppliers=[];

function showTab(id,el){
  var tabs=document.querySelectorAll('.tab-content');
  for(var i=0;i<tabs.length;i++) tabs[i].classList.remove('active');
  var btns=document.querySelectorAll('.tab');
  for(var i=0;i<btns.length;i++) btns[i].classList.remove('active');
  document.getElementById(id).classList.add('active');
  if(el) el.classList.add('active');
  if(id==='tab-best') loadBest();
  if(id==='tab-suppliers') loadSuppliers();
  if(id==='tab-quotes') loadQuotes();
  if(id==='tab-request') loadQuoteRequests();
  if(id==='tab-messages') loadMessages();
  if(id==='tab-conn'){ loadBaileysStatus(); loadGroups(); }
  if(id==='tab-compras'){ loadCompras(); }
  if(id==='tab-missing'){ loadMissing(); }
}

async function init(){
  await loadStats();
  await loadBest();
  setInterval(loadStats,30000);
}

async function loadStats(){
  try {
    var r=await Promise.all([
      fetch('/api/baileys/status').then(function(x){return x.json();}),
      fetch('/api/suppliers').then(function(x){return x.json();}),
      fetch('/api/quotes?hours=24').then(function(x){return x.json();}),
      fetch('/api/quotes?hours=168').then(function(x){return x.json();}),
      fetch('/api/quote-requests').then(function(x){return x.json();})
    ]);
    var b=r[0],s=r[1],q24=r[2],q7d=r[3],rq=r[4];
    var ok=b.connected;
    document.getElementById('statusDot').style.background=ok?'#22c55e':'#ef4444';
    document.getElementById('statusText').textContent=ok?'WhatsApp conectado':'WhatsApp desconectado';
    document.getElementById('statConn').textContent=ok?'OK':'OFF';
    document.getElementById('statSuppliers').textContent=s.filter(function(x){return x.active;}).length;
    document.getElementById('statQuotes24').textContent=q24.length;
    document.getElementById('statQuotes7d').textContent=q7d.length;
    document.getElementById('statRequests').textContent=rq.length;
    suppliers=s;
  } catch(e){ console.error(e); }
}

async function loadBest(){
  var tb=document.getElementById('bestTbody');
  try {
    var d=await fetch('/api/quotes/best').then(function(x){return x.json();});
    if(!d.length){ tb.innerHTML='<tr><td colspan="8" style="text-align:center;color:#718096;padding:20px">Sin cotizaciones aun</td></tr>'; return; }
    tb.innerHTML=d.map(function(q){
      return '<tr><td>'+(q.product||'')+'</td><td>'+(q.model||'')+'</td><td>'+(q.capacity||'')+'</td><td><strong style="color:#68d391">$'+q.price+' '+q.currency+'</strong></td><td>'+(q.supplier_name||'')+'</td><td>'+(q.qty||'-')+'</td><td>'+(q.incoterm||'')+'</td><td>'+new Date(q.ts).toLocaleDateString()+'</td></tr>';
    }).join('');
  } catch(e){ tb.innerHTML='<tr><td colspan="8" style="color:#f87171">Error</td></tr>'; }
}

async function loadSuppliers(){
  var g=document.getElementById('supplierGrid');
  try {
    var d=await fetch('/api/suppliers').then(function(x){return x.json();});
    suppliers=d;
    g.innerHTML=d.map(function(s){
      return '<div class="supplier-card '+(s.active?'active':'empty')+'" onclick="openSupplier('+s.slot+')"><div class="slot">Slot #'+s.slot+'</div><div class="name">'+(s.name||s.alias||'vacio')+'</div><div class="meta">'+(s.whatsapp_group_name||'')+'</div></div>';
    }).join('');
  } catch(e){ g.innerHTML='Error'; }
}

function openSupplier(slot){
  var s=suppliers.find(function(x){return x.slot==slot;});
  if(!s) return;
  currentSlot=slot;
  document.getElementById('modalTitle').textContent='Slot #'+slot;
  document.getElementById('mName').value=s.name||'';
  document.getElementById('mAlias').value=s.alias||'';
  document.getElementById('mPhone').value=s.contact_phone||'';
  document.getElementById('mContactName').value=s.contact_name||'';
  document.getElementById('mCountry').value=s.country||'';
  document.getElementById('mActive').value=s.active?'true':'false';
  document.getElementById('mGroupName').value=s.whatsapp_group_name||'';
  document.getElementById('mNotes').value=s.notes||'';
  document.getElementById('modalMsg').textContent='';
  document.getElementById('supplierModal').classList.add('open');
}

function closeModal(){ document.getElementById('supplierModal').classList.remove('open'); }

async function saveSupplier(){
  var body={
    name:document.getElementById('mName').value||null,
    alias:document.getElementById('mAlias').value||null,
    contact_phone:document.getElementById('mPhone').value||null,
    contact_name:document.getElementById('mContactName').value||null,
    country:document.getElementById('mCountry').value||null,
    notes:document.getElementById('mNotes').value||null,
    active:document.getElementById('mActive').value==='true'
  };
  try {
    await fetch('/api/suppliers/'+currentSlot,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    document.getElementById('modalMsg').textContent='Guardado';
    loadSuppliers();
  } catch(e){ document.getElementById('modalMsg').textContent='Error'; }
}

async function loadQuotes(){
  var tb=document.getElementById('quotesTbody');
  var p=document.getElementById('filterProduct').value;
  var h=document.getElementById('filterHours').value;
  var url='/api/quotes?limit=100';
  if(p) url+='&product='+encodeURIComponent(p);
  if(h) url+='&hours='+h;
  try {
    var d=await fetch(url).then(function(x){return x.json();});
    if(!d.length){ tb.innerHTML='<tr><td colspan="9" style="text-align:center;color:#718096;padding:20px">Sin cotizaciones</td></tr>'; return; }
    tb.innerHTML=d.map(function(q){
      return '<tr><td>'+(q.product||'')+'</td><td>'+(q.model||'')+'</td><td>'+(q.capacity||'')+'</td><td>'+(q.color||'')+'</td><td><strong style="color:#68d391">$'+q.price+'</strong></td><td>'+(q.qty||'-')+'</td><td>'+(q.incoterm||'')+'</td><td>'+(q.supplier_name||'')+'</td><td>'+new Date(q.ts).toLocaleDateString()+'</td></tr>';
    }).join('');
  } catch(e){ tb.innerHTML='<tr><td colspan="9" style="color:#f87171">Error</td></tr>'; }
}

async function loadQuoteRequests(){
  var tb=document.getElementById('reqTbody');
  try {
    var d=await fetch('/api/quote-requests').then(function(x){return x.json();});
    if(!d.length){ tb.innerHTML='<tr><td colspan="4" style="text-align:center;color:#718096">Sin pedidos</td></tr>'; return; }
    tb.innerHTML=d.map(function(r){
      return '<tr><td>'+r.product+'</td><td>'+(r.target_price?'$'+r.target_price:'-')+'</td><td>'+(r.suppliers_sent||'-')+'</td><td>'+new Date(r.ts).toLocaleString()+'</td></tr>';
    }).join('');
  } catch(e){}
}

async function sendRequest(){
  var p=document.getElementById('rqProduct').value;
  if(!p) return;
  var tp=document.getElementById('rqPrice').value||null;
  var sr=document.getElementById('rqSlots').value;
  var ss=sr?sr.split(',').map(Number):[];
  try {
    var res=await fetch('/api/request-quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({product:p,target_price:tp,supplier_slots:ss})}).then(function(x){return x.json();});
    document.getElementById('rqResult').textContent='Enviado a '+res.sent+' proveedores';
    loadQuoteRequests();
  } catch(e){ document.getElementById('rqResult').textContent='Error: '+e.message; }
}

async function loadMessages(){
  var c=document.getElementById('msgList');
  var h=document.getElementById('msgHours').value;
  var oq=document.getElementById('onlyQuotes').checked;
  var url='/api/group-messages?hours='+h;
  if(oq) url+='&has_quote=true';
  try {
    var d=await fetch(url).then(function(x){return x.json();});
    if(!d.length){ c.innerHTML='<div style="text-align:center;color:#718096;padding:20px">Sin mensajes</div>'; return; }
    c.innerHTML=d.map(function(m){
      return '<div class="msg-item '+(m.has_quote?'has-quote':'')+'"><div class="msg-meta">'+(m.group_name||m.group_id)+' | '+(m.sender_name||m.sender_phone)+' | '+new Date(m.ts).toLocaleString()+(m.has_quote?' [cotiz]':'')+'</div><div class="msg-text">'+m.message_text+'</div></div>';
    }).join('');
  } catch(e){ c.innerHTML='<div style="color:#f87171">Error</div>'; }
}

async function loadBaileysStatus(){
  try {
    var d=await fetch('/api/baileys/status').then(function(x){return x.json();});
    var el=document.getElementById('baileysStatus');
    var qr=document.getElementById('qrSection');
    if(d.connected){
      el.innerHTML='<span style="color:#22c55e">WhatsApp conectado via Baileys</span>';
      qr.style.display='none';
    } else if(d.status==='waiting_qr'){
      el.innerHTML='<span style="color:#f59e0b">Esperando QR...</span>';
      qr.style.display='block';
      qr.innerHTML='<p style="color:#f59e0b;margin-bottom:12px">Escana con WhatsApp</p><img src="/api/baileys/qr-image?t='+Date.now()+'" style="border:8px solid #fff;border-radius:8px;max-width:280px;display:block;margin:0 auto"><br><button class="btn btn-primary btn-sm" onclick="loadBaileysStatus()" style="margin-top:12px">Actualizar QR</button>';
    } else {
      el.innerHTML='<span style="color:#f87171">Estado: '+d.status+'</span>';
    }
  } catch(e){}
}

async function loadGroups(){
  var tb=document.getElementById('groupsTbody');
  try {
    var d=await fetch('/api/baileys/groups').then(function(x){return x.json();});
    if(d.error){ tb.innerHTML='<tr><td colspan="4" style="color:#718096">'+d.error+'</td></tr>'; return; }
    if(!d.groups||!d.groups.length){ tb.innerHTML='<tr><td colspan="4" style="text-align:center;color:#718096">Sin grupos</td></tr>'; return; }
    tb.innerHTML=d.groups.map(function(g){
      var sid=g.id.replace(/[^a-z0-9]/gi,'_');
      var opts=suppliers.map(function(s){ return '<option value="'+s.slot+'">#'+s.slot+' '+(s.name||'')+'</option>'; }).join('');
      return '<tr><td>'+g.name+'</td><td style="font-size:11px;color:#718096">'+g.id+'</td><td>'+g.participants+'</td><td><select id="gslot_'+sid+'" style="width:80px">'+opts+'</select> <button class="btn btn-green btn-sm" data-id="'+g.id+'" data-name="'+g.name.replace(/"/g,'&quot;')+ '" onclick="linkGroup(this)" style="margin-left:4px">Asignar</button></td></tr>';
    }).join('');
  } catch(e){ tb.innerHTML='<tr><td colspan="4" style="color:#f87171">'+e.message+'</td></tr>'; }
}

async function linkGroup(btn){
  var gid=btn.getAttribute('data-id');
  var gname=btn.getAttribute('data-name');
  var sid=gid.replace(/[^a-z0-9]/gi,'_');
  var el=document.getElementById('gslot_'+sid);
  var slot=el?el.value:null;
  if(!slot) return;
  try {
    await fetch('/api/suppliers/'+slot+'/link-group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({group_id:gid,group_name:gname})});
    alert('Grupo asignado al slot #'+slot);
    loadSuppliers();
  } catch(e){ alert('Error: '+e.message); }
}

async function loadCompras(){
  var tb=document.getElementById('minimosTbody');
  var alerts=document.getElementById('comprasAlerts');
  tb.innerHTML='<tr><td colspan="8" style="text-align:center;color:#718096;padding:20px">Cargando stock de Northtraders...</td></tr>';
  alerts.innerHTML='';
  try {
    var data=await fetch('/api/compras').then(function(r){return r.json();});
    if(data.error){ tb.innerHTML='<tr><td colspan="8" style="color:#f87171">'+data.error+'</td></tr>'; return; }
    var needBuy=data.filter(function(x){return x.alerta;});
    if(needBuy.length>0){
      alerts.innerHTML=needBuy.map(function(x){
        var priceStr=x.mejor_precio?'$'+x.mejor_precio.price+' '+x.mejor_precio.currency+' - '+x.mejor_precio.supplier_name:'Sin cotizacion reciente';
        return '<div style="background:#7f1d1d;border-left:4px solid #ef4444;border-radius:6px;padding:10px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center"><div><strong style="color:#fca5a5">COMPRAR: '+x.descripcion+'</strong><div style="font-size:12px;color:#fca5a5;margin-top:4px">Falta '+x.falta+' u. | Stock: '+x.stock_total+' | Min: '+x.minimo+' | '+priceStr+'</div></div></div>';
      }).join('');
    } else if(data.length>0){
      alerts.innerHTML='<div style="background:#14532d;border-left:4px solid #22c55e;border-radius:6px;padding:10px 14px;color:#86efac">Todo el stock esta por encima de los minimos</div>';
    }
    if(!data.length){ tb.innerHTML='<tr><td colspan="8" style="text-align:center;color:#718096;padding:20px">No hay minimos configurados. Haz click en + Agregar.</td></tr>'; return; }
    tb.innerHTML=data.map(function(x){
      var sc=x.alerta?'color:#f87171;font-weight:600':'color:#68d391';
      var pc=x.mejor_precio?'$'+x.mejor_precio.price+' '+x.mejor_precio.currency+'<br><small style="color:#718096">'+x.mejor_precio.supplier_name+'</small>':'-';
      return '<tr><td style="font-size:12px;color:#718096">'+x.codigo+'</td><td>'+x.descripcion+'</td><td style="'+sc+'">'+x.stock+'</td><td style="color:#718096">'+x.transito+'</td><td>'+x.minimo+'</td><td style="'+(x.falta>0?'color:#f87171;font-weight:600':'color:#718096')+'">'+( x.falta>0?x.falta:'-')+'</td><td>'+pc+'</td><td><button class="btn btn-sm" onclick="deleteMinimo('+x.id+')" style="background:#7f1d1d;color:#fca5a5;font-size:11px">x</button></td></tr>';
    }).join('');
    var sd=await fetch('/api/stock').then(function(r){return r.json();}).catch(function(){return {items:[]};});
    if(sd.items){
      var dl=document.getElementById('stockList');
      if(dl) dl.innerHTML=sd.items.map(function(s){return '<option value="'+s.codigo+'" label="'+s.desc+'">'+ s.codigo+'</option>';}).join('');
    }
  } catch(e){ tb.innerHTML='<tr><td colspan="8" style="color:#f87171">Error: '+e.message+'</td></tr>'; }
}

function openAddMinimo(){
  var f=document.getElementById('addMinimoForm');
  f.style.display=f.style.display==='none'?'block':'none';
}

async function saveMinimo(){
  var codigo=document.getElementById('newCodigo').value.trim();
  var desc=document.getElementById('newDesc').value.trim();
  var minimo=parseInt(document.getElementById('newMinimo').value)||0;
  if(!codigo){ alert('Ingresa el codigo'); return; }
  try {
    await fetch('/api/purchase-minimums',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({codigo:codigo,descripcion:desc,minimo:minimo})});
    document.getElementById('newCodigo').value='';
    document.getElementById('newDesc').value='';
    document.getElementById('newMinimo').value='';
    document.getElementById('addMinimoForm').style.display='none';
    loadCompras();
  } catch(e){ alert('Error: '+e.message); }
}

async function deleteMinimo(id){
  if(!confirm('Eliminar?')) return;
  try {
    await fetch('/api/purchase-minimums/'+id,{method:'DELETE'});
    loadCompras();
  } catch(e){ alert('Error: '+e.message); }
}

document.addEventListener('DOMContentLoaded', init);


async function loadMissing() {
  var sd = document.getElementById('missingStaleDays');
  var staleDays = sd ? parseInt(sd.value) || 7 : 7;
  var summaryEl = document.getElementById('missingSummary');
  var listEl = document.getElementById('missingList');
  if (summaryEl) summaryEl.textContent = 'Cargando...';
  if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">Cargando...</div>';
  try {
    var resp = await fetch('/api/missing-quotes?stale_days=' + staleDays);
    if (!resp.ok) throw new Error(resp.status);
    var data = await resp.json();
    var s = data.summary;
    if (summaryEl) summaryEl.textContent = s.never + ' nunca ÃÂ· ' + s.stale + ' stale ÃÂ· ' + s.fresh + ' fresh ÃÂ· ' + s.total + ' total';
    if (!listEl) return;
    if (!data.items || !data.items.length) { listEl.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">Sin datos</div>'; return; }
    var html = data.items.map(function(item) {
      var color = item.status === 'never' ? '#e74c3c' : (item.status === 'stale' ? '#f39c12' : '#27ae60');
      var badge = item.status === 'never' ? 'Ã°ÂÂÂ´ NUNCA' : (item.status === 'stale' ? 'Ã°ÂÂÂ¡ STALE (' + item.days_since + 'd)' : 'Ã°ÂÂÂ¢ FRESH (' + item.days_since + 'd)');
      var lastLine = item.last_quote ? ('ÃÂltimo: ' + item.last_quote.supplier_name + ' ÃÂ· $' + item.last_quote.price + ' ' + (item.last_quote.currency || '') + ' ÃÂ· ' + (item.last_quote.incoterm || '')) : 'Sin cotizaciÃÂ³n previa';
      var costoLine = item.ultimo_costo ? (' ÃÂ· Costo planilla: $' + item.ultimo_costo) : '';
      return '<div style="padding:12px 14px;margin-bottom:8px;background:white;border-left:4px solid ' + color + ';border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<div style="font-weight:600;font-size:14px;">' + item.desc + '</div>' +
          '<div style="color:' + color + ';font-size:12px;font-weight:600;white-space:nowrap;">' + badge + '</div>' +
        '</div>' +
        '<div style="font-size:12px;color:#666;margin-top:6px;">' + lastLine + costoLine + '</div>' +
      '</div>';
    }).join('');
    listEl.innerHTML = html;
  } catch (e) {
    if (summaryEl) summaryEl.textContent = 'Error cargando';
    if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:40px;color:#c00;">Error: ' + e.message + '</div>';
  }
}


// ================================================================
// FUNCIONES NUEVAS - 2026-04-23
// ================================================================

window.__QC = [];
function norm(s) { return (s || "").toLowerCase().trim(); }
function findQ(p, m, cap, sup) {
  return window.__QC.find(q => norm(q.product)===norm(p)&&norm(q.model)===norm(m)&&norm(q.capacity)===norm(cap)&&norm(q.supplier_name)===norm(sup))
      || window.__QC.find(q => norm(q.product)===norm(p)&&norm(q.supplier_name)===norm(sup));
}
async function refreshQC() {
  try { const r=await fetch("/api/quotes"); const d=await r.json(); window.__QC=Array.isArray(d)?d:(d.quotes||[]); } catch(e) {}
}

function showToast(msg) {
  var t=document.getElementById('__toast');
  if(!t){t=document.createElement('div');t.id='__toast';t.style.cssText='position:fixed;bottom:24px;right:24px;background:#22543d;color:#c6f6d5;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;opacity:0;transition:opacity .3s';document.body.appendChild(t);}
  t.textContent=msg;t.style.opacity='1';clearTimeout(t.__timer);t.__timer=setTimeout(function(){t.style.opacity='0';},3000);
}

async function loadBestPrices() {
  var tbody=document.getElementById('bestTbody');
  if(!tbody)return;
  tbody.innerHTML='<tr><td colspan="9" style="text-align:center;color:#718096;padding:20px">Cargando...</td></tr>';
  try {
    var r=await fetch('/api/best-prices?days=7');
    var d=await r.json();
    var rows=Array.isArray(d)?d:(d.prices||d.quotes||[]);
    if(!rows.length){tbody.innerHTML='<tr><td colspan="9" style="text-align:center;color:#718096;padding:20px">Sin cotizaciones en los Ãºltimos 7 dÃ­as</td></tr>';return;}
    tbody.innerHTML=rows.map(function(q){var date=q.ts?new Date(q.ts).toLocaleDateString('es-AR'):'-';return '<tr><td>'+(q.product||'-')+'</td><td>'+(q.model||'-')+'</td><td>'+(q.capacity||'-')+'</td><td>USD '+(q.price||'-')+'</td><td>'+(q.cost||'-')+'</td><td>'+(q.supplier_name||'-')+'</td><td>'+(q.qty||'-')+'</td><td>'+(q.incoterm||'-')+'</td><td>'+date+'</td></tr>';}).join('');
    attachBestClicks();
  } catch(e) { tbody.innerHTML='<tr><td colspan="9" style="text-align:center;color:#e53e3e;padding:20px">Error: '+e.message+'</td></tr>'; }
}
var loadBest = loadBestPrices;

var _qId=null;
function openQModal(q){_qId=(q&&q.id)||null;var m=[(q.product||""),(q.model||""),(q.capacity||"")].filter(Boolean).join(" ");document.getElementById("qModalTitle").textContent=m||"CotizaciÃ³n";document.getElementById("qModalMeta").textContent="Proveedor: "+(q.supplier_name||"-")+"  |  USD "+(q.price||"-")+"  |  Qty: "+(q.qty||"-");document.getElementById("qModalMsg").textContent=q.raw_text||"(sin mensaje original)";document.getElementById("qModal").classList.add("open");}
function closeQModal(){document.getElementById("qModal").classList.remove("open");_qId=null;}
async function deleteQFromModal(){if(!_qId){alert("Sin ID");return;}if(!confirm("Â¿Eliminar esta cotizaciÃ³n?"))return;try{var r=await fetch("/api/quotes/"+_qId,{method:"DELETE"});var d=await r.json();if(d.ok||d.deleted>=0){window.__QC=window.__QC.filter(function(q){return q.id!==_qId;});closeQModal();if(typeof loadBestPrices==="function")loadBestPrices();showToast("CotizaciÃ³n eliminada");}else alert("Error: "+(d.error||"desconocido"));}catch(e){alert("Error: "+e.message);}}

function attachBestClicks(){var tab=document.getElementById("tab-best");if(!tab)return;tab.querySelectorAll("tbody tr").forEach(function(row){if(row.dataset.mc)return;row.dataset.mc="1";row.classList.add("clickable-row");row.addEventListener("click",function(){var cells=row.querySelectorAll("td");if(!cells.length)return;var p=cells[0]?cells[0].textContent.trim():"";var m=cells[1]?cells[1].textContent.trim():"";var cap=cells[2]?cells[2].textContent.trim():"";var sup=cells[5]?cells[5].textContent.trim():"";var q=findQ(p,m,cap,sup);if(!q)q={product:p,model:m,capacity:cap,supplier_name:sup,price:cells[3]?cells[3].textContent.replace(/[^0-9.]/g,""):"",qty:cells[6]?cells[6].textContent.trim():"",ts:new Date().toISOString(),raw_text:"(Sin mensaje - buscalo en tab Cotizaciones)"};openQModal(q);});});}

function addProdRow(){var row=document.createElement("div");row.className="prod-row";row.innerHTML='<input class="prod-name" placeholder="Ej: iPhone 16 128GB" style="flex:3"><input class="prod-target" placeholder="Target USD (opc)" style="flex:1;max-width:160px"><button onclick="this.parentNode.remove()" style="background:#c53030;color:#fff;border:none;border-radius:6px;padding:5px 9px;cursor:pointer;flex-shrink:0">Ã</button>';document.getElementById("productList").appendChild(row);}
async function sendRequestQuote(){var rows=document.querySelectorAll(".prod-row");var products=[];rows.forEach(function(row){var n=row.querySelector(".prod-name");var t=row.querySelector(".prod-target");if(n&&n.value.trim())products.push({name:n.value.trim(),target:t&&t.value.trim()||null});});if(!products.length){showToast("AgregÃ¡ al menos un producto");return;}var el=document.getElementById("reqResult");el.textContent="Enviando...";try{var body=products.length===1?{product:products[0].name,target_price:products[0].target}:{products:products};var r=await fetch("/api/request-quote",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});var d=await r.json();if(d.ok||d.sent>=0){el.textContent="â Enviado a "+(d.sent||d.groups_sent||"?")+" grupos";showToast("CotizaciÃ³n enviada");}else el.textContent="â "+(d.error||"error al enviar");}catch(e){el.textContent="â "+e.message;}}

refreshQC();
setInterval(function(){attachBestClicks();},2000);
setInterval(refreshQC,60000);
if(document.getElementById("productList"))addProdRow();
