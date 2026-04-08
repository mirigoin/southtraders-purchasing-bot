const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(express.json());

// ENV
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_PHONE = process.env.OWNER_PHONE || '17865591119';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://southtraders_db_user:INkOK7w8DfOQxB2HNYTJ2fZCrRPds64u@dpg-d76u5iruibrs73a1eugg-a.ohio-postgres.render.com:5432/southtraders_db';
const SHEETS_ID = process.env.SHEETS_ID; // ID de la planilla Google Sheets

// DB
const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized: false } : false });

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS supplier_groups (
    id SERIAL PRIMARY KEY,
    group_id TEXT UNIQUE,
    name TEXT,
    alias TEXT,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS quotes (
    id SERIAL PRIMARY KEY,
    group_id TEXT,
    supplier_name TEXT,
    raw_text TEXT,
    product TEXT,
    model TEXT,
    capacity TEXT,
    price NUMERIC,
    currency TEXT DEFAULT 'USD',
    qty INTEGER,
    ts TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS quote_requests (
    id SERIAL PRIMARY KEY,
    product TEXT,
    groups_sent INTEGER,
    message_sent TEXT,
    ts TIMESTAMPTZ DEFAULT NOW()
  )`);
  console.log('DB OK');
}

// WHATSAPP
async function sendWA(to, text) {
  try {
    await axios.post(
      'https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages',
      { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: text } },
      { headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch(e) { console.error('sendWA error:', e.response && e.response.data || e.message); }
}

// Enviar mensaje a un grupo de WhatsApp
async function sendToGroup(groupId, text) {
  try {
    await axios.post(
      'https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages',
      { messaging_product: 'whatsapp', to: groupId, type: 'text', text: { body: text } },
      { headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch(e) { console.error('sendToGroup error:', groupId, e.message); }
}

// CLAUDE - extraer cotizacion de texto libre
async function extractQuote(text, supplierName) {
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        system: 'Eres un asistente que extrae cotizaciones de electronics de mensajes de proveedores mayoristas. ' +
                'Devuelve SOLO un JSON valido sin markdown. Si no hay cotizacion clara, devuelve {"quotes":[]}. ' +
                'Formato: {"quotes":[{"product":"iPhone","model":"16 Pro","capacity":"128GB","price":850,"currency":"USD","qty":10}]}' +
                'Los productos relevantes son: iPhone 15, iPhone 16, iPhone 17, Samsung S25, Samsung S26, MacBook, AirPods.',
        messages: [{ role: 'user', content: 'Proveedor: ' + supplierName + '\nMensaje: ' + text }]
      },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const raw = resp.data.content[0].text.trim();
    return JSON.parse(raw);
  } catch(e) {
    console.error('extractQuote error:', e.message);
    return { quotes: [] };
  }
}

// GOOGLE SHEETS - agregar fila de cotizacion
async function appendToSheets(quoteData) {
  if (!SHEETS_ID) return;
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const row = [
      new Date().toISOString(),
      quoteData.supplier,
      quoteData.group_name,
      quoteData.product,
      quoteData.model,
      quoteData.capacity,
      quoteData.price,
      quoteData.currency,
      quoteData.qty,
      quoteData.raw_text.slice(0, 200)
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: 'COTIZACIONES!A:J',
      valueInputOption: 'RAW',
      resource: { values: [row] }
    });
  } catch(e) { console.error('Sheets error:', e.message); }
}

// PROCESAR mensaje de grupo proveedor
async function processSupplierMessage(groupId, senderName, text) {
  // Buscar el grupo en la DB
  const gResult = await pool.query('SELECT * FROM supplier_groups WHERE group_id=$1 AND active=TRUE', [groupId]);
  if (!gResult.rows.length) return; // grupo no registrado
  const group = gResult.rows[0];

  console.log('[SUPPLIER] ' + group.alias + ' | ' + senderName + ': ' + text.slice(0, 60));

  // Extraer cotizacion con Claude
  const extracted = await extractQuote(text, senderName || group.alias);
  if (!extracted.quotes || !extracted.quotes.length) return; // sin cotizacion detectable

  // Guardar cada cotizacion en DB y Sheets
  for (const q of extracted.quotes) {
    await pool.query(
      'INSERT INTO quotes (group_id, supplier_name, raw_text, product, model, capacity, price, currency, qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [groupId, senderName || group.alias, text, q.product, q.model, q.capacity, q.price, q.currency || 'USD', q.qty]
    );
    await appendToSheets({
      supplier: senderName || group.alias,
      group_name: group.name,
      product: q.product,
      model: q.model,
      capacity: q.capacity,
      price: q.price,
      currency: q.currency || 'USD',
      qty: q.qty,
      raw_text: text
    });
    console.log('[QUOTE SAVED] ' + q.product + ' ' + q.model + ' $' + q.price);
  }
}

// PROCESAR comando de Chelo (chat privado)
async function processOwnerCommand(text) {
  const t = text.toLowerCase().trim();

  // Comando: "cotizar [producto]"
  if (t.startsWith('cotizar ')) {
    const product = text.slice(8).trim();
    await requestQuotes(product);
    return;
  }

  // Comando: "mejores [producto]"
  if (t.startsWith('mejores ')) {
    const product = text.slice(8).trim();
    await sendBestPrices(product);
    return;
  }

  // Comando: "resumen"
  if (t === 'resumen') {
    await sendDailySummary();
    return;
  }

  // Comando: "grupos"
  if (t === 'grupos') {
    const r = await pool.query('SELECT alias, group_id, active FROM supplier_groups ORDER BY alias');
    if (!r.rows.length) {
      await sendWA(OWNER_PHONE, 'No hay grupos registrados. Agrega grupos con: "agregar grupo [nombre] [group_id]"');
    } else {
      const list = r.rows.map(g => (g.active ? '✅' : '❌') + ' ' + g.alias + ' | ' + g.group_id).join('\n');
      await sendWA(OWNER_PHONE, '📋 Grupos proveedores:\n' + list);
    }
    return;
  }

  // Comando: "agregar grupo [alias] [group_id]"
  if (t.startsWith('agregar grupo ')) {
    const parts = text.slice(14).trim().split(' ');
    const groupId = parts[parts.length - 1];
    const alias = parts.slice(0, -1).join(' ');
    await pool.query(
      'INSERT INTO supplier_groups (group_id, name, alias) VALUES ($1,$2,$3) ON CONFLICT (group_id) DO UPDATE SET name=$2, alias=$3, active=TRUE',
      [groupId, alias, alias]
    );
    await sendWA(OWNER_PHONE, '✅ Grupo agregado: ' + alias);
    return;
  }

  // Help
  await sendWA(OWNER_PHONE,
    '🤖 Bot de Compras South Traders\n\n' +
    'Comandos disponibles:\n' +
    '• cotizar [producto] - Pide precio a todos los grupos\n' +
    '• mejores [producto] - Ver mejores precios del dia\n' +
    '• resumen - Resumen de cotizaciones de hoy\n' +
    '• grupos - Ver grupos registrados\n' +
    '• agregar grupo [nombre] [group_id] - Agregar grupo\n\n' +
    'Ejemplo: cotizar iPhone 16 Pro 256GB'
  );
}

// PEDIR cotizaciones a todos los grupos
async function requestQuotes(product) {
  const groups = await pool.query('SELECT * FROM supplier_groups WHERE active=TRUE');
  if (!groups.rows.length) {
    await sendWA(OWNER_PHONE, 'No hay grupos registrados.');
    return;
  }

  const msg = '📱 Buenos dias! Necesitamos cotizacion de ' + product + '. Por favor indicar precio, disponibilidad y cantidad. Gracias!';

  let sent = 0;
  for (const g of groups.rows) {
    await sendToGroup(g.group_id, msg);
    sent++;
    await new Promise(r => setTimeout(r, 500)); // delay entre mensajes
  }

  await pool.query('INSERT INTO quote_requests (product, groups_sent, message_sent) VALUES ($1,$2,$3)', [product, sent, msg]);
  await sendWA(OWNER_PHONE, '✅ Pedido de cotizacion enviado a ' + sent + ' grupos para: ' + product);
}

// MEJORES precios para un producto
async function sendBestPrices(product) {
  const r = await pool.query(
    `SELECT supplier_name, model, capacity, price, qty, ts
     FROM quotes
     WHERE LOWER(product || ' ' || COALESCE(model,'')) LIKE $1
     AND ts > NOW() - INTERVAL '48 hours'
     ORDER BY price ASC LIMIT 10`,
    ['%' + product.toLowerCase() + '%']
  );

  if (!r.rows.length) {
    await sendWA(OWNER_PHONE, 'No hay cotizaciones recientes para: ' + product);
    return;
  }

  const lines = ['💰 Mejores precios - ' + product + ':'];
  for (const q of r.rows) {
    const time = new Date(q.ts).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    lines.push(q.supplier_name + ' | ' + q.model + ' ' + q.capacity + ' | $' + q.price + ' | ' + (q.qty||'?') + 'u | ' + time);
  }
  await sendWA(OWNER_PHONE, lines.join('\n'));
}

// RESUMEN diario
async function sendDailySummary() {
  const r = await pool.query(
    `SELECT product, model, MIN(price) as min_price, MAX(price) as max_price, COUNT(*) as count
     FROM quotes
     WHERE ts > NOW() - INTERVAL '24 hours'
     GROUP BY product, model
     ORDER BY product, model`
  );

  if (!r.rows.length) {
    await sendWA(OWNER_PHONE, 'No hay cotizaciones en las ultimas 24hs.');
    return;
  }

  const lines = ['📊 Resumen cotizaciones hoy:'];
  for (const q of r.rows) {
    lines.push(q.product + ' ' + (q.model||'') + ' | $' + q.min_price + '-$' + q.max_price + ' | ' + q.count + ' cotiz.');
  }
  await sendWA(OWNER_PHONE, lines.join('\n'));
}

// WEBHOOK
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook', function(req, res) {
  res.sendStatus(200);
  try {
    const entry = req.body && req.body.entry && req.body.entry[0];
    if (!entry) return;
    const change = entry.changes && entry.changes[0] && entry.changes[0].value;
    if (!change || !change.messages) return;

    const m = change.messages[0];
    const from = m.from;
    const isGroup = from.endsWith('@g.us') || (change.metadata && change.metadata.recipient_to && change.metadata.recipient_to !== from);
    const groupId = isGroup ? from : null;
    const senderName = change.contacts && change.contacts[0] && change.contacts[0].profile && change.contacts[0].profile.name || from;

    if (m.type !== 'text') return;
    const text = m.text && m.text.body || '';

    if (from === OWNER_PHONE) {
      // Mensaje de Chelo: comando
      processOwnerCommand(text).catch(console.error);
    } else if (groupId) {
      // Mensaje de grupo proveedor: extraer cotizacion
      processSupplierMessage(groupId, senderName, text).catch(console.error);
    }
  } catch(e) { console.error('webhook error:', e.message); }
});

// API endpoints
app.get('/quotes', async function(req, res) {
  try {
    const r = await pool.query('SELECT * FROM quotes ORDER BY ts DESC LIMIT 100');
    res.json({ ok: true, quotes: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/quotes/best', async function(req, res) {
  try {
    const r = await pool.query(
      `SELECT product, model, capacity, MIN(price) as best_price, supplier_name, MAX(ts) as last_seen
       FROM quotes WHERE ts > NOW() - INTERVAL '48 hours'
       GROUP BY product, model, capacity, supplier_name
       ORDER BY product, model, best_price`
    );
    res.json({ ok: true, quotes: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/groups', async function(req, res) {
  try {
    const r = await pool.query('SELECT * FROM supplier_groups ORDER BY alias');
    res.json({ ok: true, groups: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/groups', async function(req, res) {
  const { group_id, name, alias } = req.body;
  if (!group_id || !alias) return res.status(400).json({ error: 'group_id y alias requeridos' });
  try {
    await pool.query(
      'INSERT INTO supplier_groups (group_id, name, alias) VALUES ($1,$2,$3) ON CONFLICT (group_id) DO UPDATE SET name=$2, alias=$3',
      [group_id, name || alias, alias]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', function(req, res) {
  res.json({ status: 'ok', service: 'South Traders Purchasing Bot' });
});

const PORT = process.env.PORT || 3000;
initDB().then(function() {
  app.listen(PORT, function() { console.log('Purchasing bot online port ' + PORT); });
}).catch(console.error);
