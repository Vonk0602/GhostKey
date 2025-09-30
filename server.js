// server.js
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const app = express();
app.use(express.json());
app.set('trust proxy', 1);

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const API_SECRET = process.env.API_SECRET || "secret123";
const DB_PATH = process.env.DB_PATH || './sessions.db';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' })
  ]
});

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    logger.error('Ошибка подключения к БД:', err);
    process.exit(1);
  }
  logger.info('Подключено к SQLite БД');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id64 TEXT PRIMARY KEY,
      id2 TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      startDate TEXT NOT NULL,
      online BOOLEAN DEFAULT false,
      lastOnline TEXT,
      lastOffline TEXT,
      messageId TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id64 TEXT NOT NULL,
      time TEXT NOT NULL,
      key TEXT NOT NULL,
      category TEXT NOT NULL,
      FOREIGN KEY(session_id64) REFERENCES sessions(id64) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id64 TEXT NOT NULL,
      time TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      w INTEGER NOT NULL,
      h INTEGER NOT NULL,
      FOREIGN KEY(session_id64) REFERENCES sessions(id64) ON DELETE CASCADE
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id64)');
  db.run('CREATE INDEX IF NOT EXISTS idx_clicks_session ON clicks(session_id64)');
});

db.run(`
  DELETE FROM sessions WHERE datetime(startDate) < datetime('now', '-7 days')
`, (err) => {
  if (err) logger.error('Ошибка очистки старых сессий:', err);
  else logger.info('Очищены старые сессии');
});

const MAX_SESSIONS = 100;
const MAX_LOGS_PER_SESSION = 1000;
const MAX_CLICKS_PER_SESSION = 50;

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  logger.info(`Получен Authorization: ${authHeader || 'отсутствует'}`);
  if (authHeader !== 'Bearer ' + API_SECRET) {
    logger.warn('Попытка несанкционированного доступа');
    return res.status(401).send('Несанкционировано');
  }
  next();
};

const limiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 100 
});
app.use(limiter);

async function loadActiveSessions() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id64 FROM sessions', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.id64));
    });
  });
}

async function loadSession(id64) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM sessions WHERE id64 = ?', [id64], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function loadAllSessions() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id2, token, online FROM sessions', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function categorizeKey(key) {
  const upperKey = key.toUpperCase();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const digits = '0123456789'.split('');
  const normalKeys = [...letters, ...digits, 'MOUSE1', 'MOUSE2', 'LSHIFT', 'ENTER', 'BACKSPACE', 'SPACE'];
  const mediumKeys = ['KP_0', 'KP_1', 'KP_2', 'KP_3', 'KP_4', 'KP_5', 'KP_6', 'KP_7', 'KP_8', 'KP_9', 'KP_ENTER', 'KP_DECIMAL', 'KP_DIVIDE', 'KP_MULTIPLY', 'KP_MINUS', 'KP_PLUS', 'LALT', 'RALT', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
  const suspiciousKeys = ['RSHIFT', 'LCTRL', 'RCTRL', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'PGUP', 'PGDN', 'INSERT', 'DELETE', 'HOME', 'END', 'MOUSE3', 'MOUSE4', 'MOUSE5', 'MWHEELUP', 'MWHEELDOWN', 'TAB', 'CAPSLOCK', 'ESC', 'PRINTSCREEN', 'SCROLLLOCK', 'PAUSE', 'NUMLOCK'];
  if (normalKeys.includes(upperKey)) return 'Обычные';
  if (mediumKeys.includes(upperKey)) return 'Средние';
  if (suspiciousKeys.includes(upperKey)) return 'Подозрительные';
  return 'Подозрительные';
}

function formatMoscowTime(isoDate) {
  if (!isoDate) return 'N/A';
  return new Date(isoDate).toLocaleString('ru-RU', { 
    timeZone: 'Europe/Moscow', 
    day: '2-digit', 
    month: '2-digit', 
    year: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
}

async function updateDiscordForSession(id64) {
  const session = await loadSession(id64);
  if (!session || !session.messageId || !CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const message = await channel.messages.fetch(session.messageId);
    const viewUrl = `${PUBLIC_URL}/view/${session.token}`;
    const embed = new EmbedBuilder()
      .setTitle(`Сессия для ${session.id2}`)
      .addFields(
        { name: 'SteamID', value: session.id2, inline: true },
        { name: 'Ссылка', value: `[Ссылка](${viewUrl})`, inline: true },
        { name: 'Дата начала', value: formatMoscowTime(session.startDate), inline: true },
        { name: 'Игрок в сети?', value: session.online ? 'Да' : 'Нет', inline: true },
        { name: 'Последний онлайн', value: formatMoscowTime(session.lastOnline), inline: true },
        { name: 'Последний оффлайн', value: formatMoscowTime(session.lastOffline), inline: true }
      )
      .setFooter({ text: 'Специально для доброграда' });
    await message.edit({ embeds: [embed] });
  } catch (err) {
    logger.error('Ошибка обновления Discord:', err);
  }
}

function steamIDTo64(steamID) {
  if (!steamID.startsWith('STEAM_')) return null;
  const parts = steamID.split(':');
  if (parts.length !== 3) return null;
  const universe = 1;
  const auth = parseInt(parts[1]);
  const acc = parseInt(parts[2]);
  const base = BigInt('76561197960265728');
  return (base + BigInt(acc * 2) + BigInt(auth)).toString();
}

client.on('ready', () => {
  logger.info('Бот готов и вошел как ' + client.user.tag);
});

client.on('error', (err) => {
  logger.error('Ошибка клиента Discord:', err);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith('!hotkey')) {
    const args = message.content.split(' ').slice(1);
    if (args.length < 1) return message.reply('Использование: !hotkey <steamid>');
    const id2 = args[0];
    const id64 = steamIDTo64(id2);
    if (!id64) return message.reply('Неверный SteamID');
    const existing = await loadSession(id64);
    if (existing) {
      const viewUrl = `${PUBLIC_URL}/view/${existing.token}`;
      return message.reply(`Сессия уже существует для ${id2}. Просмотр: ${viewUrl}`);
    }
    const sessionCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM sessions', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });
    if (sessionCount >= MAX_SESSIONS) return message.reply('Достигнуто максимальное количество сессий');
    const token = uuidv4();
    const startDate = new Date().toISOString();
    await new Promise((resolve, reject) => {
      db.run('INSERT INTO sessions (id64, id2, token, startDate, online) VALUES (?, ?, ?, ?, ?)', [id64, id2, token, startDate, false], (err) => {
        if (err) {
          logger.error('Ошибка вставки сессии:', err);
          return message.reply('Ошибка создания сессии');
        } else resolve();
      });
    });
    const viewUrl = `${PUBLIC_URL}/view/${token}`;
    if (!CHANNEL_ID) {
      logger.error('CHANNEL_ID не установлен');
      return message.reply('Ошибка: CHANNEL_ID не настроен');
    }
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      const embed = new EmbedBuilder()
        .setTitle(`Сессия для ${id2}`)
        .addFields(
          { name: 'SteamID', value: id2, inline: true },
          { name: 'Ссылка', value: `[Ссылка](${viewUrl})`, inline: true },
          { name: 'Дата начала', value: formatMoscowTime(startDate), inline: true },
          { name: 'Игрок в сети?', value: 'Нет', inline: true }
        )
        .setFooter({ text: 'Специально для доброграда' });
      const msg = await channel.send({ embeds: [embed] });
      await new Promise((resolve, reject) => {
        db.run('UPDATE sessions SET messageId = ? WHERE id64 = ?', [msg.id, id64], (err) => {
          if (err) {
            logger.error('Ошибка обновления MessageId:', err);
          } else resolve();
        });
      });
      logger.info(`Создана сессия для ${id64}`);
      message.reply(`Сессия создана для ${id2}. Просмотр в канале: <#${CHANNEL_ID}> или напрямую: ${viewUrl}`);
    } catch (err) {
      logger.error('Ошибка отправки в канал:', err);
      message.reply('Ошибка отправки в информационный канал');
    }
  } else if (message.content.startsWith('!stophotkey')) {
    const args = message.content.split(' ').slice(1);
    if (args.length < 1) return message.reply('Использование: !stophotkey <steamid>');
    const id2 = args[0];
    const id64 = steamIDTo64(id2);
    if (!id64) return message.reply('Неверный SteamID');
    const existing = await loadSession(id64);
    if (!existing) return message.reply('Сессия не найдена для этого SteamID');
    if (existing.messageId && CHANNEL_ID) {
      try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        const messageToDelete = await channel.messages.fetch(existing.messageId);
        await messageToDelete.delete();
      } catch (err) {
        logger.error('Ошибка удаления сообщения Discord:', err);
      }
    }
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM sessions WHERE id64 = ?', [id64], (err) => {
        if (err) {
          logger.error('Ошибка удаления сессии:', err);
          return message.reply('Ошибка удаления сессии');
        } else resolve();
      });
    });
    logger.info(`Удалена сессия для ${id64}`);
    message.reply(`Сессия остановлена и удалена для ${id2}`);
  } else if (message.content.startsWith('!listhotkey')) {
    if (!CHANNEL_ID) return message.reply('Ошибка: CHANNEL_ID не настроен');
    try {
      const sessions = await loadAllSessions();
      if (sessions.length === 0) return message.reply('Нет активных сессий');
      const channel = await client.channels.fetch(CHANNEL_ID);
      let listMsg = 'Текущие сессии:\n';
      sessions.forEach(s => {
        const viewUrl = `${PUBLIC_URL}/view/${s.token}`;
        listMsg += `${s.id2} - В сети: ${s.online ? 'Да' : 'Нет'} - Просмотр: ${viewUrl}\n`;
      });
      await channel.send(listMsg);
      message.reply(`Список отправлен в канал: <#${CHANNEL_ID}>`);
    } catch (err) {
      logger.error('Ошибка списка сессий:', err);
      message.reply('Ошибка списка сессий');
    }
  }
});

app.get('/active-sessions', async (req, res) => {
  try {
    const actives = await loadActiveSessions();
    res.json(actives);
  } catch (err) {
    logger.error('Ошибка получения активных сессий:', err);
    res.status(500).send('Внутренняя ошибка');
  }
});

const keySchema = Joi.object({
  steamid: Joi.string().required(),
  key: Joi.string().max(50).required()
});

app.post('/log-keys', authMiddleware, async (req, res) => {
  const { error } = keySchema.validate(req.body);
  if (error) return res.status(400).send('Неверный запрос');

  const { steamid, key } = req.body;
  try {
    const session = await loadSession(steamid);
    if (!session) return res.status(404).send('Сессия не найдена');

    const logCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM logs WHERE session_id64 = ?', [steamid], (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });
    if (logCount >= MAX_LOGS_PER_SESSION) return res.status(429).send('Достигнуто максимальное количество логов');

    const time = new Date().toISOString();
    const category = categorizeKey(key);
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO logs (session_id64, time, key, category)
        VALUES (?, ?, ?, ?)
      `, [steamid, time, key, category], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    logger.info(`Записана клавиша: ${steamid} - ${key}`);
    res.send('Записано');
  } catch (err) {
    logger.error('Ошибка записи клавиш:', err);
    res.status(500).send('Внутренняя ошибка');
  }
});

const eventSchema = Joi.object({
  steamid: Joi.string().required(),
  event: Joi.string().valid('entered', 'exited').required()
});

app.post('/log-event', authMiddleware, async (req, res) => {
  const { error } = eventSchema.validate(req.body);
  if (error) return res.status(400).send('Неверный запрос');

  const { steamid, event } = req.body;
  try {
    const session = await loadSession(steamid);
    if (!session) return res.status(404).send('Сессия не найдена');

    const time = new Date().toISOString();
    let updates = {};
    if (event === 'entered') {
      updates.online = true;
      updates.lastOnline = time;
      updates.lastOffline = session.lastOffline || null;
    } else if (event === 'exited') {
      updates.online = false;
      updates.lastOffline = time;
      updates.lastOnline = session.lastOnline || null;
    }

    await new Promise((resolve, reject) => {
      db.run(`
        UPDATE sessions SET online = ?, lastOnline = ?, lastOffline = ?
        WHERE id64 = ?
      `, [updates.online, updates.lastOnline, updates.lastOffline, steamid], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO logs (session_id64, time, key, category)
        VALUES (?, ?, ?, ?)
      `, [steamid, time, `Игрок ${event === 'entered' ? 'вошел' : 'вышел'}`, 'Все'], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await updateDiscordForSession(steamid);
    logger.info(`Записано событие: ${steamid} - ${event}`);
    res.send('Событие записано');
  } catch (err) {
    logger.error('Ошибка записи события:', err);
    res.status(500).send('Внутренняя ошибка');
  }
});

const clickSchema = Joi.object({
  steamid: Joi.string().required(),
  click: Joi.object({
    x: Joi.number().required(),
    y: Joi.number().required(),
    w: Joi.number().integer().required(),
    h: Joi.number().integer().required()
  }).required()
});

app.post('/log-click', authMiddleware, async (req, res) => {
  const { error } = clickSchema.validate(req.body);
  if (error) return res.status(400).send('Неверный запрос');

  const { steamid, click } = req.body;
  try {
    const session = await loadSession(steamid);
    if (!session) return res.status(404).send('Сессия не найдена');

    const clickCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM clicks WHERE session_id64 = ?', [steamid], (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });
    if (clickCount >= MAX_CLICKS_PER_SESSION) return res.status(429).send('Достигнуто максимальное количество кликов');

    const time = new Date().toISOString();
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO clicks (session_id64, time, x, y, w, h)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [steamid, time, click.x, click.y, click.w, click.h], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    logger.info(`Записан клик: ${steamid} - ${JSON.stringify(click)}`);
    res.send('Клик записан');
  } catch (err) {
    logger.error('Ошибка записи клика:', err);
    res.status(500).send('Внутренняя ошибка');
  }
});

app.get('/data/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const session = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM sessions WHERE token = ?', [token], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!session) return res.status(404).json({ error: 'Неверный токен' });

    const logs = await new Promise((resolve, reject) => {
      db.all('SELECT time, key, category FROM logs WHERE session_id64 = ? ORDER BY time DESC', [session.id64], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    const clicks = await new Promise((resolve, reject) => {
      db.all('SELECT time, x, y, w, h FROM clicks WHERE session_id64 = ? ORDER BY time DESC', [session.id64], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({ 
      logs, 
      clicks, 
      session: { 
        online: session.online, 
        lastOnline: session.lastOnline, 
        lastOffline: session.lastOffline 
      } 
    });
  } catch (err) {
    logger.error('Ошибка получения данных:', err);
    res.status(500).json({ error: 'Внутренняя ошибка' });
  }
});

app.get('/view/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const session = await new Promise((resolve, reject) => {
      db.get('SELECT id2 FROM sessions WHERE token = ?', [token], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!session) return res.status(404).send('Неверный токен');

    const categories = ['Все', 'Обычные', 'Средние', 'Подозрительные'];
    let html = `
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px; }
          h1 { color: #333; }
          button { background-color: #007bff; color: white; border: none; padding: 10px 20px; margin: 5px; cursor: pointer; border-radius: 5px; }
          button:hover { background-color: #0056b3; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #007bff; color: white; }
          tr:nth-child(even) { background-color: #f2f2f2; }
          #keys-tab, #clicks-tab { display: none; }
          #keys-tab.active, #clicks-tab.active { display: block; }
          ul { list-style-type: none; padding: 0; }
          li { margin: 10px 0; }
          .copy-btn { margin-left: 10px; background-color: #28a745; }
          .copy-btn:hover { background-color: #218838; }
          @media (max-width: 600px) { table, ul { font-size: 12px; } } /* Responsive */
          #export-btn { background-color: #ffc107; color: black; }
          #export-btn:hover { background-color: #e0a800; }
        </style>
      </head>
      <body>
        <h1>SteamID: ${session.id2}</h1>
        <p>Игрок в сети: <span id="online-status"></span></p>
        <p>Последний онлайн: <span id="last-online"></span></p>
        <p>Последний оффлайн: <span id="last-offline"></span></p>
        <button onclick="showTab('keys')">Клавиши</button>
        <button onclick="showTab('clicks')">Свободные клики</button>
        <div id="keys-tab" class="active">
          <div id="key-buttons">
    `;
    categories.forEach(cat => {
      html += `<button onclick="setCategory('${cat}')">${cat}</button>`;
    });
    html += `
          </div>
          <button id="export-btn" onclick="exportToCSV('logs')">Экспорт в CSV</button>
          <table id="logs"><thead><tr><th>Время (МСК)</th><th>Клавиша</th><th>Категория</th></tr></thead><tbody></tbody></table>
        </div>
        <div id="clicks-tab">
          <button id="export-btn" onclick="exportToCSV('clicks')">Экспорт в CSV</button>
          <ul id="clicks-list"></ul>
        </div>
        <script>
          let currentCategory = 'Все';
          let currentTab = 'keys';
          let allData = { logs: [], clicks: [], session: {} };
          const token = '${token}';

          function showTab(tab) {
            currentTab = tab;
            document.getElementById('keys-tab').classList.toggle('active', tab === 'keys');
            document.getElementById('clicks-tab').classList.toggle('active', tab === 'clicks');
            updateData();
          }

          function updateData() {
            fetch('/data/' + token)
              .then(res => res.json())
              .then(data => {
                allData = data;
                document.getElementById('online-status').innerText = data.session.online ? 'Да' : 'Нет';
                document.getElementById('last-online').innerText = data.session.lastOnline ? new Date(data.session.lastOnline).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'N/A';
                document.getElementById('last-offline').innerText = data.session.lastOffline ? new Date(data.session.lastOffline).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'N/A';
                if (currentTab === 'keys') {
                  let filtered = currentCategory === 'Все' ? data.logs : data.logs.filter(l => l.category === currentCategory);
                  let tbody = '';
                  filtered.forEach(l => {
                    tbody += '<tr><td>' + new Date(l.time).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + '</td><td>' + l.key + '</td><td>' + l.category + '</td></tr>';
                  });
                  document.querySelector('#logs tbody').innerHTML = tbody;
                } else if (currentTab === 'clicks') {
                  let list = '';
                  data.clicks.forEach((c, i) => {
                    const coord = c.x.toFixed(2) + ' ' + c.y.toFixed(2);
                    list += '<li>' + (i+1) + ': ' + coord + ' <button class="copy-btn" onclick="copyToClipboard(\\'' + coord + '\\')">Копировать</button></li>';
                  });
                  document.getElementById('clicks-list').innerHTML = list;
                }
              })
              .catch(err => console.error(err));
          }

          function setCategory(cat) {
            currentCategory = cat;
            updateData();
          }

          function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => alert('Скопировано: ' + text));
          }

          function exportToCSV(type) {
            let csv = '';
            if (type === 'logs') {
              csv = 'Time,Key,Category\\n';
              allData.logs.forEach(l => {
                csv += \`\${new Date(l.time).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })},\${l.key},\${l.category}\\n\`;
              });
            } else if (type === 'clicks') {
              csv = 'Time,X,Y,W,H\\n';
              allData.clicks.forEach(c => {
                csv += \`\${new Date(c.time).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })},\${c.x},\${c.y},\${c.w},\${c.h}\\n\`;
              });
            }
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = \`\${type}.csv\`;
            link.click();
          }

          setInterval(updateData, 5000);
          updateData();
        </script>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    logger.error('Ошибка просмотра:', err);
    res.status(500).send('Внутренняя ошибка');
  }
});

app.listen(PORT, () => logger.info(`Сервер запущен на ${PORT}`));

client.login(DISCORD_TOKEN).catch(err => {
  logger.error('Ошибка входа в Discord:', err);
});

process.on('SIGTERM', () => {
  logger.info('Завершение работы');
  db.close();
  client.destroy();
  process.exit(0);
});