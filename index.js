const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ============ ENV ============
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'marco_verify_2024';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_PHONE = process.env.OWNER_PHONE || '17865591119';
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 10000;

// ============ DB ============
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('render.com') ? { rejctUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    slot INTEGER UNIQUE NOT NULL,
    name TEXT,
    alias TEXT,
    whatsapp_group_id TEXT,
    whatsapp_group_name TEXT,
    contact_phone TEXT,
    contact_name TEXT,
    country TEXT,
    notes TEXT,
    active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  const count = await pool.query('SELECT COUNT(*) FROM suppliers');
  if (parseInt(count.rows[0].count) === 0) {
    const values = [];
    for (let i = 1; i <= 50; i++) { values.push(`(${i})`); }
    await pool.query(`INSERT INTO suppliers (slot) VALUES ${values.join(',')}`);
    console.log('Seeded 50 supplier slots');
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS quotes (
    id SERIAL PRIMARY KEY,
    supplier_slot INTEGER REFERENCES suppliers(slot),
    supplier_name TEXT,
    source TEXT DEFAULT 'group',
    raw_text TEXT,
    product TEXT,
    model TEXT,
    capacity TEXT,
    color TEXT,
    condition TEXT DEFAULT 'new',
    price NUMERIC,
    currency TEXT DEFAULT 'USD',
    qty INTEGER,
    incoterm TEXT DEFAULT 'CIF Miami',
    ts TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS quote_requests (
    id SERIAL PRIMARY KEY,
    product TEXT,
    target_price NUMERIC,
    suppliers_sent TEXT,
    message_sent TEXT,
    responses INTEGER DEFAULT 0,
    status TEXT DEFAULT 'open',
    ts TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS group_messages (
    id SERIAL PRIMARY KEY,
    group_id TEXT,
    group_name TEXT,
    sender_phone TEXT,
    sender_name TEXT,
    message_text TEXT,
    has_quote BOOLEAN DEFAULT FALSE,
    processed BOOLEAN DEFAULT FALSE,
    ts TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS purchase_minimums (
    id SERIAL PRIMARY KEY,
    codigo TEXT UNIQUE NOT NULL,
    descripcion TEXT,
    minimo INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Migrations - agregar columnas si no existen
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS target_price NUMERIC`);
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS suppliers_sent TEXT`);
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS message_sent TEXT`);
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS responses INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open'`);
  await pool.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS group_id TEXT`);

  console.log('DB OK');
}

// ============ CLAUDE - EXTRACT QUOTES ============
async function extractQuote(text, supplierName) {
  if (!ANTHROPIC_API_KEY) return { quotes: [] };
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `Eres un asistente que extrae cotizaciones de productos Apple y Samsung de mensajes de proveedores mayoristas. Devuelve SOLO un JSON valido sin markdown ni backticks. Si no hay cotizacion clara o es un mensaje social/saludo, devuelve {"quotes":[]}.

Formato requerido: {"quotes":[{"product":"iPhone","model":"16 Pro Max","capacity":"256GB","color":"Black Titanium","condition":"new","price":950,"currency":"USD","qty":10,"incoterm":"CIF Miami"}]}

Reglas:
- product: iPhone, iPad, MacBook, AirPods, Apple Watch, Samsung Galaxy
- Si no dice condicion, asumir "new"
- Si no dice incoterm, asumir "FOB" 
- Si dice "CIF MIA" o similar, poner "CIF Miami"
- qty puede ser null si no especifica
- Extraer TODAS las cotizaciones del mensaje (puede haber varias lineas/productos)
- Precios siempre en numeros, sin simbolos
- Si el mensaje tiene formato de lista de precios, extraer cada linea como quote separado`,
        messages: [{ role: 'user', content: `Proveedor: ${supplierName}\nMensaje:\n${text}` }]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        }
      }
    );
    const raw = resp.data.content[0].text.trim().replace(/^```[\w]*\n?/,"").replace(/\n?```$/,"").trim();
    return JSON.parse(raw);
  } catch (e) {
    console.error('Claude extract error:', e.message);
    return { quotes: [] };
  }
}

// ============ SAVE QUOTES TO DB ============
async function saveQuotes(quotes, supplierSlot, supplierName, rawText, source) {
  for (const q of quotes) {
    await pool.query(
      `INSERT INTO quotes (supplier_slot, supplier_name, source, raw_text, product, model, capacity, color, condition, price, currency, qty, incoterm) 
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [supplierSlot, supplierName, source || 'group', rawText, q.product, q.model, q.capacity, q.color, q.condition || 'new', q.price, q.currency || 'USD', q.qty, q.incoterm || 'FOB']
    );
  }
}

// ============ META WHATSAPP (for 1-to-1 messages via Cloud API) ============
async function sendWA(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log('WA Cloud API not configured, skipping send to', to);
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('sendWA error:', e.response?.data || e.message);
  }
}

// Alert owner
async function alertOwner(message) {
  // Intentar via Baileys primero (siempre disponible)
  if (baileysClient && baileysStatus === 'connected' && OWNER_PHONE) {
    try {
      const ownerJid = OWNER_PHONE + '@s.whatsapp.net';
      await baileysClient.sendMessage(ownerJid, { text: message });
      return;
    } catch (e) {
      console.error('Baileys alertOwner error:', e.message);
    }
  }
  // Fallback: Meta Cloud API
  await sendWA(OWNER_PHONE, message);
}

// ============ BAILEYS INTEGRATION (WhatsApp Web for groups) ============
let baileysClient = null;
let baileysQR = null;
let baileysStatus = 'disconnected';

async function initBaileys() {
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
    const { Boom } = require('@hapi/boom');

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      browser: ['Marco Bot', 'Chrome', '22.0'],
        getMessage: async (key) => {
      try {
        const r = await pool.query('SELECT message_text FROM group_messages WHERE id = $1 LIMIT 1', [key.id]);
        if (r.rows.length > 0) return { conversation: r.rows[0].message_text };
      } catch(e) {}
      return { conversation: 'placeholder' };
    },
});

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        baileysQR = qr;
        baileysStatus = 'waiting_qr';
        console.log('QR code ready - scan from dashboard');
      }
      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reason !== DisconnectReason.loggedOut) {
          console.log('Reconnecting Baileys...');
          setTimeout(initBaileys, 5000);
        } else {
          baileysStatus = 'logged_out';
          console.log('Baileys logged out');
        }
      } else if (connection === 'open') {
        baileysStatus = 'connected';
        baileysQR = null;
        console.log('Baileys connected to WhatsApp');
      }
    });

    // Listen to ALL group messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const isGroup = msg.key.remoteJid?.endsWith('@g.us');
        if (!isGroup) continue;

        const groupId = msg.key.remoteJid;
        const senderPhone = msg.key.participant?.replace('@s.whatsapp.net', '') || '';
        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || '';

        if (!text || text.length < 3) continue;

        // Get group name
        let groupName = groupId;
        try {
          const meta = await sock.groupMetadata(groupId);
          groupName = meta.subject || groupId;
        } catch (e) { /* ignore */ }

        // Get sender name
        let senderName = senderPhone;
        try {
          senderName = msg.pushName || senderPhone;
        } catch (e) { /* ignore */ }

        // Save raw message
        await pool.query(
          `INSERT INTO group_messages (group_id, group_name, sender_phone, sender_name, message_text) 
          VALUES ($1,$2,$3,$4,$5)`,
          [groupId, groupName, senderPhone, senderName, text]
        );

        // Check if this group belongs to a registered supplier
        const supplier = await pool.query(
          'SELECT * FROM suppliers WHERE whatsapp_group_id = $1 AND active = TRUE',
          [groupId]
        );

        if (supplier.rows.length > 0) {
          const s = supplier.rows[0];

          // Extract quotes with Claude
          const result = await extractQuote(text, s.name || s.alias || groupName);
          if (result.quotes && result.quotes.length > 0) {
            // Mark message as having a quote
            await pool.query(
              `UPDATE group_messages SET has_quote = TRUE, processed = TRUE WHERE id = (SELECT id FROM group_messages WHERE group_id = $1 AND message_text = $2 ORDER BY ts DESC LIMIT 1)`,
              [groupId, text]
            );

            // Save extracted quotes
            await saveQuotes(result.quotes, s.slot, s.name || s.alias, text, 'group');

            // Alert owner with best prices
            const summary = result.quotes.map(q =>
              `${q.product} ${q.model} ${q.capacity}: $${q.price} ${q.currency} x${q.qty || '?'} (${q.incoterm || 'FOB'})`
            ).join('\n');
            await alertOwner(`📊 Cotización de ${s.name || groupName}:\n${summary}`);
          }
        }
      }
    });

    baileysClient = sock;
    console.log('Baileys initialized');
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.log('Baileys not installed - group monitoring disabled. Install with: npm install @whiskeysockets/baileys @hapi/boom');
      baileysStatus = 'not_installed';
    } else {
      console.error('Baileys init error:', e.message);
      baileysStatus = 'error';
    }
  }
}

// ============ ROUTES ============

// Health
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Marco - South Traders Purchasing Bot',
    baileys: baileysStatus,
    timestamp: new Date().toISOString()
  });
});

// Dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Baileys QR code
app.get('/api/baileys/qr', (req, res) => {
  res.json({ status: baileysStatus, qr: baileysQR });
});

// Baileys QR image - devuelve PNG para escanear desde el dashboard
app.get('/api/baileys/qr-image', async (req, res) => {
  if (!baileysQR) return res.status(404).json({ error: 'No QR available', status: baileysStatus });
  try {
    const QRCode = require('qrcode');
    const png = await QRCode.toBuffer(baileysQR, { type: 'png', width: 300, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(png);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Baileys status
app.post('/api/baileys/logout', async (req, res) => {
  try {
    if (baileysClient) {
      await baileysClient.logout();
    }
    // Borrar archivos de sesion
    const fs = require('fs');
    const authDir = '/opt/render/project/src/auth_info';
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    baileysStatus = 'disconnected';
    baileysClient = null;
    // Reiniciar Baileys para mostrar QR
    setTimeout(() => initBaileys(), 1000);
    res.json({ ok: true, message: 'Sesion cerrada. Escaneá el QR nuevo.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/baileys/status', (req, res) => {
  res.json({ status: baileysStatus, connected: baileysStatus === 'connected' });
});

// Baileys - list groups the phone is in
app.get('/api/baileys/groups', async (req, res) => {
  if (!baileysClient || baileysStatus !== 'connected') {
    return res.json({ error: 'Baileys not connected', groups: [] });
  }
  try {
    const groups = await baileysClient.groupFetchAllParticipating();
    const list = Object.values(groups).map(g => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length || 0,
      creation: g.creation
    }));
    res.json({ groups: list });
  } catch (e) {
    res.json({ error: e.message, groups: [] });
  }
});

// ============ SUPPLIER MANAGEMENT ============

// List all suppliers
app.get('/api/suppliers', async (req, res) => {
  const result = await pool.query('SELECT * FROM suppliers ORDER BY slot ASC');
  res.json(result.rows);
});

// Update a supplier slot
app.put('/api/suppliers/:slot', async (req, res) => {
  const { slot } = req.params;
  const { name, alias, whatsapp_group_id, whatsapp_group_name, contact_phone, contact_name, country, notes, active } = req.body;
  try {
    await pool.query(
      `UPDATE suppliers SET
        name = COALESCE($1, name),
        alias = COALESCE($2, alias),
        whatsapp_group_id = COALESCE($3, whatsapp_group_id),
        whatsapp_group_name = COALESCE($4, whatsapp_group_name),
        contact_phone = COALESCE($5, contact_phone),
        contact_name = COALESCE($6, contact_name),
        country = COALESCE($7, country),
        notes = COALESCE($8, notes),
        active = COALESCE($9, active),
        updated_at = NOW()
      WHERE slot = $10`,
      [name, alias, whatsapp_group_id, whatsapp_group_name, contact_phone, contact_name, country, notes, active, slot]
    );
    res.json({ ok: true, slot });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Link a WhatsApp group to a supplier slot
app.post('/api/suppliers/:slot/link-group', async (req, res) => {
  const { slot } = req.params;
  const { group_id, group_name } = req.body;
  try {
    await pool.query(
      'UPDATE suppliers SET whatsapp_group_id = $1, whatsapp_group_name = $2, active = TRUE, updated_at = NOW() WHERE slot = $3',
      [group_id, group_name, slot]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ QUOTES ============

// Get all quotes, optionally filtered
app.get('/api/quotes', async (req, res) => {
  const { product, supplier, hours, limit } = req.query;
  let query = 'SELECT * FROM quotes WHERE 1=1';
  const params = [];
  let idx = 1;

  if (product) {
    query += ` AND (product ILIKE $${idx} OR model ILIKE $${idx})`;
    params.push(`%${product}%`);
    idx++;
  }
  if (supplier) {
    query += ` AND (supplier_name ILIKE $${idx})`;
    params.push(`%${supplier}%`);
    idx++;
  }
  if (hours) {
    query += ` AND ts > NOW() - INTERVAL '${parseInt(hours)} hours'`;
  }

  query += ' ORDER BY ts DESC';
  if (limit) query += ` LIMIT ${parseInt(limit)}`;

  const result = await pool.query(query, params);
  res.json(result.rows);
});

// Best prices summary
app.get('/api/quotes/best', async (req, res) => {
  const result = await pool.query(`
    SELECT DISTINCT ON (product, model, capacity)
      product, model, capacity, price, currency, supplier_name, qty, incoterm, ts
    FROM quotes
    WHERE ts > NOW() - INTERVAL '7 days'
    ORDER BY product, model, capacity, price ASC
  `);
  res.json(result.rows);
});

// ============ QUOTE REQUESTS ============

// Request quote from suppliers (sends via Baileys to groups)
app.post('/api/request-quote', async (req, res) => {
  try {
    const { product, target_price, supplier_slots } = req.body;
    if (!product) return res.status(400).json({ error: 'product required' });

    // Obtener proveedores activos con grupo de WA
    const suppRes = await pool.query('SELECT * FROM suppliers WHERE active = true AND whatsapp_group_id IS NOT NULL');
    let targets = suppRes.rows;

    // Filtrar por slots si se especificaron
    if (supplier_slots && supplier_slots.length > 0) {
      const slotsNum = supplier_slots.map(s => parseInt(s));
      targets = targets.filter(s => slotsNum.includes(parseInt(s.slot)));
    }

    // Guardar registro
    const supplierNames = targets.map(s => s.name || 'Slot ' + s.slot).join(', ');
    const msg = 'Cotizacion: ' + product + (target_price ? ' | Target: $' + target_price : '') + ' | Responder con precio, cantidad e incoterm';
    await pool.query(
      'INSERT INTO quote_requests (product, target_price, suppliers_sent, message_sent, status) VALUES ($1,$2,$3,$4,$5)',
      [product, target_price || null, supplierNames || null, msg, 'open']
    );

    // Enviar WhatsApp a cada proveedor
    let sent = 0;
    for (const s of targets) {
      try {
        if (baileysClient && baileysStatus === 'connected') {
          // Intentar al grupo primero
          let destJid = s.whatsapp_group_id;
          let sentOk = false;
          try {
            await baileysClient.sendMessage(destJid, { text: msg });
            sentOk = true;
            console.log('Sent to group ' + s.name + ' at ' + destJid);
          } catch(groupErr) {
            console.log('Group send failed (' + groupErr.message + '), trying contact_phone...');
            // Fallback: mandar directo al contact_phone si existe
            if (s.contact_phone) {
              const phone = s.contact_phone.replace(/[^0-9]/g, '');
              await baileysClient.sendMessage(phone + '@s.whatsapp.net', { text: msg });
              sentOk = true;
              console.log('Sent direct to contact ' + s.name + ' at ' + phone);
            }
          }
          if (sentOk) sent++;
        }
      } catch(e) {
        console.error('Error sending to ' + s.name + ': ' + e.message);
      }
    }
    // Notificar al owner SIEMPRE - con resultado
    const ownerMsg = sent > 0
      ? '📤 Pedido enviado a ' + sent + ' proveedor(es): ' + supplierNames + '\n' + msg
      : '📋 Pedido registrado (envío manual requerido):\n' + supplierNames + '\n' + msg;
    await alertOwner(ownerMsg);

    res.json({ ok: true, sent, suppliers: targets.map(s => s.name || 'Slot'+s.slot) });
  } catch(e) {
    console.error('request-quote error:', e);
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/quote-requests', async (req, res) => {
  const result = await pool.query('SELECT * FROM quote_requests ORDER BY ts DESC LIMIT 50');
  res.json(result.rows);
});

// ============ GROUP MESSAGES ============
app.get('/api/group-messages', async (req, res) => {
  const { group_id, hours, has_quote } = req.query;
  let query = 'SELECT * FROM group_messages WHERE 1=1';
  const params = [];
  let idx = 1;

  if (group_id) {
    query += ` AND group_id = $${idx}`;
    params.push(group_id);
    idx++;
  }
  if (hours) {
    query += ` AND ts > NOW() - INTERVAL '${parseInt(hours)} hours'`;
  }
  if (has_quote === 'true') {
    query += ' AND has_quote = TRUE';
  }

  query += ' ORDER BY ts DESC LIMIT 200';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

// ============ SEND (manual message from dashboard) ============
app.post('/api/send', async (req, res) => {
  const { phone, message, group_id } = req.body;

  if (group_id && baileysClient && baileysStatus === 'connected') {
    try {
      await baileysClient.sendMessage(group_id, { text: message });
      return res.json({ ok: true, via: 'baileys_group' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (phone) {
    await sendWA(phone, message);
    return res.json({ ok: true, via: 'cloud_api' });
  }

  res.status(400).json({ error: 'phone or group_id required' });
});

// ============ WEBHOOK (Meta Cloud API) ============
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    if (!change?.messages) return;

    for (const msg of change.messages) {
      if (msg.type !== 'text') continue;
      const from = msg.from;
      const text = msg.text.body;

      // Check if this is from a known supplier
      const supplier = await pool.query(
        'SELECT * FROM suppliers WHERE contact_phone = $1 AND active = TRUE',
        [from]
      );

      if (supplier.rows.length > 0) {
        const s = supplier.rows[0];
        const result = await extractQuote(text, s.name || s.alias);
        if (result.quotes && result.quotes.length > 0) {
          await saveQuotes(result.quotes, s.slot, s.name || s.alias, text, 'direct');
          const summary = result.quotes.map(q =>
            `${q.product} ${q.model} ${q.capacity}: $${q.price} x${q.qty || '?'}`
          ).join('\n');
          await alertOwner(`📊 Cotización directa de ${s.name}:\n${summary}`);
        }
      }
    }
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
});

// ============ STOCK & COMPRAS ============

// Stock desde Northtraders
app.get('/api/stock', async (req, res) => {
  try {
    const { JSDOM } = require('jsdom');
    const resp = await axios.get('https://northtraders.oppen.io/report/shared?shared=fe0f1305-3a71-4b78-be99-e54e3396cbdd', { timeout: 15000 });
    const dom = new JSDOM(resp.data);
    const rows = dom.window.document.querySelectorAll('table tr');
    const items = [];
    for (let i = 2; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td');
      if (cells.length >= 3) {
        const codigo = cells[0].textContent.trim();
        const desc = cells[1].textContent.trim();
        const stock = parseFloat(cells[2].textContent.trim().replace(',', '.')) || 0;
        const transito = parseFloat(cells[3] ? cells[3].textContent.trim().replace(',', '.') : '0') || 0;
        if (codigo) items.push({ codigo, desc, stock, transito });
      }
    }
    res.json({ ok: true, items, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CRUD purchase_minimums
app.get('/api/purchase-minimums', async (req, res) => {
  const result = await pool.query('SELECT * FROM purchase_minimums ORDER BY descripcion ASC');
  res.json(result.rows);
});

app.post('/api/purchase-minimums', async (req, res) => {
  const { codigo, descripcion, minimo } = req.body;
  try {
    await pool.query(
      'INSERT INTO purchase_minimums (codigo, descripcion, minimo) VALUES ($1,$2,$3) ON CONFLICT (codigo) DO UPDATE SET descripcion=$2, minimo=$3, updated_at=NOW()',
      [codigo, descripcion, minimo]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/purchase-minimums/:id', async (req, res) => {
  await pool.query('DELETE FROM purchase_minimums WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Compras: stock vs minimos + mejor precio
app.get('/api/compras', async (req, res) => {
  try {
    const { JSDOM } = require('jsdom');
    // Obtener stock
    const stockResp = await axios.get('https://northtraders.oppen.io/report/shared?shared=fe0f1305-3a71-4b78-be99-e54e3396cbdd', { timeout: 15000 });
    const dom = new JSDOM(stockResp.data);
    const rows = dom.window.document.querySelectorAll('table tr');
    const stockMap = {};
    for (let i = 2; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td');
      if (cells.length >= 3) {
        const codigo = cells[0].textContent.trim();
        const desc = cells[1].textContent.trim();
        const stock = parseFloat(cells[2].textContent.trim().replace(',', '.')) || 0;
        const transito = parseFloat(cells[3] ? cells[3].textContent.trim().replace(',', '.') : '0') || 0;
        if (codigo) stockMap[codigo] = { desc, stock, transito };
      }
    }
    // Obtener minimos
    const minimoRes = await pool.query('SELECT * FROM purchase_minimums');
    const minimos = minimoRes.rows;
    // Para cada minimo, comparar con stock y buscar mejor precio
    const compras = [];
    for (const m of minimos) {
      const stockItem = stockMap[m.codigo] || { desc: m.descripcion, stock: 0, transito: 0 };
      const stockTotal = stockItem.stock + stockItem.transito;
      const falta = Math.max(0, m.minimo - stockTotal);
      // Buscar mejor cotizacion en ultimos 7 dias por descripcion fuzzy
      const desc = m.descripcion || '';
      const parts = desc.replace(/APPLEs+/i,'').replace(/s+-s+.*/, '').trim().split(/s+/);
      const searchTerm = parts.slice(0,4).join(' ');
      let bestQuote = null;
      if (searchTerm) {
        const qResult = await pool.query(
          `SELECT supplier_name, price, currency, incoterm, qty, ts FROM quotes WHERE (product || ' ' || COALESCE(model,'') || ' ' || COALESCE(capacity,'')) ILIKE $1 AND ts > NOW() - INTERVAL '7 days' ORDER BY price ASC LIMIT 1`,
          ['%' + searchTerm.split(' ').slice(0,2).join('%') + '%']
        );
        if (qResult.rows.length > 0) bestQuote = qResult.rows[0];
      }
      compras.push({
        id: m.id,
        codigo: m.codigo,
        descripcion: m.descripcion || stockItem.desc,
        stock: stockItem.stock,
        transito: stockItem.transito,
        stock_total: stockTotal,
        minimo: m.minimo,
        falta,
        alerta: falta > 0,
        mejor_precio: bestQuote
      });
    }
    // Ordenar: alertas primero
    compras.sort((a,b) => (b.alerta ? 1 : 0) - (a.alerta ? 1 : 0));
    res.json(compras);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ START ============
async function start() {
  await initDB();
  app.listen(PORT, () => console.log(`Marco purchasing bot on port ${PORT}`));

  // Try to start Baileys (won't crash if not installed)
  await initBaileys();
}

start().catch(e => console.error('Start error:', e));
