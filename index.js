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
  // Suppliers - 50 slots
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

  // Check if slots exist, if not seed 1-50
  const count = await pool.query('SELECT COUNT(*) FROM suppliers');
  if (parseInt(count.rows[0].count) === 0) {
    const values = [];
    for (let i = 1; i <= 50; i++) {
      values.push(`(${i})`);
    }
    await pool.query(`INSERT INTO suppliers (slot) VALUES ${values.join(',')}`);
    console.log('Seeded 50 supplier slots');
  }

  // Quotes - cotizaciones extraidas
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

  // Quote requests - pedidos de cotizacion que mande Marco
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

  // Group messages log - todos los mensajes de grupos
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
              `UPDATE group_messages SET has_quote = TRUE, processed = TRUE WHERE group_id = $1 AND message_text = $2 ORDER BY ts DESC LIMIT 1`,
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
  const { product, target_price, supplier_slots } = req.body;
  if (!product) return res.status(400).json({ error: 'product required' });

  let msg = `📱 South Traders - Pedido de cotización\n\nBuscamos: ${product}`;
  if (target_price) msg += `\n🎯 Target: USD ${target_price}`;
  msg += `\n📦 Cantidad: a confirmar según precio\n\n¿Disponibilidad y mejor precio? Gracias!`;

  let sent = 0;
  const sentTo = [];

  // Get target suppliers
  let suppliers;
  if (supplier_slots && supplier_slots.length > 0) {
    suppliers = await pool.query('SELECT * FROM suppliers WHERE slot = ANY($1) AND active = TRUE', [supplier_slots]);
  } else {
    suppliers = await pool.query('SELECT * FROM suppliers WHERE active = TRUE');
  }

  for (const s of suppliers.rows) {
    if (s.whatsapp_group_id && baileysClient && baileysStatus === 'connected') {
      try {
        await baileysClient.sendMessage(s.whatsapp_group_id, { text: msg });
        sent++;
        sentTo.push(s.name || s.alias || `Slot ${s.slot}`);
      } catch (e) {
        console.error(`Error sending to group ${s.name}:`, e.message);
      }
    } else if (s.contact_phone) {
      // Fallback: send 1-to-1 via Cloud API
      await sendWA(s.contact_phone, msg);
      sent++;
      sentTo.push(s.name || s.alias || `Slot ${s.slot}`);
    }
  }

  // Log the request
  await pool.query(
    'INSERT INTO quote_requests (product, target_price, suppliers_sent, message_sent) VALUES ($1,$2,$3,$4)',
    [product, target_price, sentTo.join(', '), msg]
  );

  res.json({ ok: true, sent, suppliers: sentTo });
});

// List quote requests
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

// ============ START ============
async function start() {
  await initDB();
  app.listen(PORT, () => console.log(`Marco purchasing bot on port ${PORT}`));

  // Try to start Baileys (won't crash if not installed)
  await initBaileys();
}

start().catch(e => console.error('Start error:', e));
