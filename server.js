require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const path = require('path');
const twilio = require('twilio');
const fs = require('fs');
const https = require('https');
const os = require('os');

const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);
const LOG_FILE = path.join(LOGS_DIR, 'whatsapp.jsonl');
const WEB_LOG_FILE = path.join(LOGS_DIR, 'web.jsonl');
const THREADS_FILE = path.join(LOGS_DIR, 'threads.json');

function getUserThread(phone) {
  if (!fs.existsSync(THREADS_FILE)) return null;
  const threads = JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'));
  return threads[phone] || null;
}

function saveUserThread(phone, threadId) {
  const threads = fs.existsSync(THREADS_FILE)
    ? JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'))
    : {};
  threads[phone] = threadId;
  fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
}

async function downloadAudio(url, destPath) {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Failed to download audio: ${res.status}`);
  const buffer = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}

async function transcribeAudio(filePath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-1',
  });
  return transcription.text;
}
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function logMessage(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

function readLogs() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function logWebMessage(entry) {
  fs.appendFileSync(WEB_LOG_FILE, JSON.stringify(entry) + '\n');
}

function readWebLogs() {
  if (!fs.existsSync(WEB_LOG_FILE)) return [];
  return fs.readFileSync(WEB_LOG_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

const app = express();
const PORT = process.env.PORT || 3000;
const ANALYTICS_PASSWORD = process.env.ANALYTICS_PASSWORD || '4416';

function requirePassword(req, res, next) {
  const token = req.cookies?.analytics_auth;
  if (token === ANALYTICS_PASSWORD) return next();

  if (req.method === 'POST' && req.body?.password === ANALYTICS_PASSWORD) {
    res.setHeader('Set-Cookie', `analytics_auth=${ANALYTICS_PASSWORD}; Path=/; HttpOnly`);
    return res.redirect(req.path);
  }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Analytics — Login</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9f9f9; }
    .box { background: white; padding: 2rem 2.5rem; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.1); text-align: center; }
    h2 { margin-top: 0; color: #333; }
    input { padding: .6rem 1rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem; width: 180px; margin-bottom: 1rem; text-align: center; letter-spacing: .2rem; }
    button { display: block; width: 100%; padding: .6rem; background: #4a90e2; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    .error { color: red; font-size: .85rem; margin-bottom: .5rem; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Analytics</h2>
    ${req.method === 'POST' ? '<p class="error">Incorrect password</p>' : ''}
    <form method="post">
      <input type="password" name="password" placeholder="Password" autofocus />
      <button type="submit">Enter</button>
    </form>
  </div>
</body>
</html>`);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  const cookie = req.headers.cookie || '';
  req.cookies = Object.fromEntries(cookie.split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(([k]) => k));
  next();
});
app.use((req, res, next) => { res.setHeader('ngrok-skip-browser-warning', '1'); next(); });
app.use(express.static(path.join(__dirname)));

const ttsCache = {};
app.get('/api/tts', async (req, res) => {
  const text = (req.query.text || '').trim();
  const stressed = req.query.stressed === '1';
  if (!text) return res.status(400).end();
  const cacheKey = (stressed ? 'stressed:' : '') + text;
  try {
    if (!ttsCache[cacheKey]) {
      if (process.env.ELEVENLABS_API_KEY) {
        const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
        const voiceSettings = stressed
          ? { stability: 0.22, similarity_boost: 0.78, style: 0.65, use_speaker_boost: true }
          : { stability: 0.42, similarity_boost: 0.82, style: 0.18, use_speaker_boost: true };
        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: voiceSettings })
        });
        if (!elRes.ok) {
          const errBody = await elRes.text().catch(()=>'');
          console.error('ElevenLabs ' + elRes.status + ':', errBody.slice(0,200), '— falling back to OpenAI');
          const mp3 = await openai.audio.speech.create({ model: 'tts-1', voice: stressed ? 'echo' : 'nova', input: text, speed: stressed ? 1.05 : 0.92 });
          ttsCache[cacheKey] = Buffer.from(await mp3.arrayBuffer());
        } else {
          ttsCache[cacheKey] = Buffer.from(await elRes.arrayBuffer());
        }
      } else {
        const mp3 = await openai.audio.speech.create({ model: 'tts-1', voice: stressed ? 'echo' : 'nova', input: text, speed: stressed ? 1.05 : 0.92 });
        ttsCache[cacheKey] = Buffer.from(await mp3.arrayBuffer());
      }
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(ttsCache[cacheKey]);
  } catch(e) {
    console.error('TTS error:', e.message);
    res.status(500).end();
  }
});

app.post('/api/ask', async (req, res) => {
  const { question, threadId } = req.body;

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'Question is required.' });
  }

  if (!process.env.ASSISTANT_ID) {
    return res.status(500).json({ error: 'Assistant not configured. Run: node setup.js' });
  }

  const start = Date.now();
  try {
    // Reuse existing thread for conversation memory, or create a new one
    let thread;
    if (threadId) {
      thread = { id: threadId };
    } else {
      thread = await openai.beta.threads.create();
    }

    // Add the user's question, appending a follow-up request
    const messageContent = `${question.trim()}

(After your answer, on a new line write exactly: FOLLOWUPS: [question 1] | [question 2] | [question 3] — 3 short follow-up questions the user might ask next.)`;

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: messageContent,
    });

    // Run the assistant
    let run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    // Poll until complete (with 30s timeout)
    while (run.status === 'in_progress' || run.status === 'queued') {
      if (Date.now() - start > 30000) throw new Error('Request timed out.');
      await new Promise(r => setTimeout(r, 1000));
      run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }

    if (run.status !== 'completed') {
      console.error('Run failed details:', JSON.stringify(run.last_error));
      throw new Error(`Unexpected run status: ${run.status}${run.last_error ? ' — ' + run.last_error.message : ''}`);
    }

    // Get the assistant's reply
    const messages = await openai.beta.threads.messages.list(thread.id);
    const raw = messages.data[0]?.content[0]?.text?.value || '';

    // Strip citation markers like 【4:0†source】
    const cleaned = raw.replace(/【[^】]*】/g, '').trim();

    if (!cleaned) throw new Error('No answer returned.');

    // Parse follow-up questions out of the response
    const followupMatch = cleaned.match(/FOLLOWUPS:\s*(.+)$/m);
    let followUps = [];
    let answer = cleaned;
    if (followupMatch) {
      followUps = followupMatch[1]
        .split('|')
        .map(q => q.replace(/^\[|\]$/g, '').trim())
        .filter(Boolean)
        .slice(0, 3);
      answer = cleaned.replace(/FOLLOWUPS:.*$/m, '').trim();
    }

    logWebMessage({
      ts: new Date().toISOString(),
      threadId: thread.id,
      question: question.trim(),
      answer,
      ms: Date.now() - start,
      success: true,
      uncertain: isUncertain(answer),
    });

    res.json({ answer, threadId: thread.id, followUps });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    logWebMessage({
      ts: new Date().toISOString(),
      threadId: threadId || null,
      question: question.trim(),
      answer: '',
      ms: 0,
      success: false,
      uncertain: false,
    });
    res.status(500).json({ error: 'AI service error.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// WhatsApp webhook — Twilio sends POST with body.Body = user message
app.post('/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  const userMsg = (req.body.Body || '').trim();
  const from = req.body.From || '';
  const twiml = new twilio.twiml.MessagingResponse();

  // Handle voice messages
  const numMedia = parseInt(req.body.NumMedia || '0');
  const mediaType = req.body.MediaContentType0 || '';
  let isVoice = false;

  if (numMedia > 0 && mediaType.startsWith('audio/')) {
    isVoice = true;
    const mediaUrl = req.body.MediaUrl0;
    twiml.message('Got your voice note! Transcribing and looking that up...');
    res.type('text/xml').send(twiml.toString());

    const ext = mediaType.includes('ogg') ? 'ogg' : mediaType.includes('mp4') ? 'mp4' : mediaType.includes('mpeg') ? 'mp3' : 'ogg';
    const tmpFile = path.join(os.tmpdir(), `voice_${Date.now()}.${ext}`);
    try {
      await downloadAudio(mediaUrl, tmpFile);
      const transcribed = await transcribeAudio(tmpFile);
      fs.unlink(tmpFile, () => {});

      if (!transcribed) {
        await twilioClient.messages.create({
          from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
          to: from,
          body: 'Sorry, I couldn\'t make out that voice note. Could you try typing your question?',
        });
        return;
      }

      // Log and answer the transcribed message
      const start = Date.now();
      const existingThreadId = getUserThread(from);
      const thread = existingThreadId ? { id: existingThreadId } : await openai.beta.threads.create();
      saveUserThread(from, thread.id);

      await openai.beta.threads.messages.create(thread.id, { role: 'user', content: transcribed });
      let run = await openai.beta.threads.runs.create(thread.id, { assistant_id: process.env.ASSISTANT_ID });

      while (run.status === 'in_progress' || run.status === 'queued') {
        if (Date.now() - start > 55000) throw new Error('Timed out.');
        await new Promise(r => setTimeout(r, 1000));
        run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      }

      if (run.status !== 'completed') throw new Error(`Run status: ${run.status}`);

      const messages = await openai.beta.threads.messages.list(thread.id);
      let answer = messages.data[0]?.content[0]?.text?.value || '';
      answer = answer.replace(/【[^】]*】/g, '').replace(/FOLLOWUPS:.*$/ms, '').trim();
      if (answer.length > 1580) answer = answer.slice(0, 1577) + '…';

      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: `🎤 _"${transcribed}"_\n\n${answer}`,
      });

      logMessage({
        ts: new Date().toISOString(),
        from,
        question: `[Voice] ${transcribed}`,
        answer,
        ms: Date.now() - start,
        success: true,
        uncertain: isUncertain(answer),
      });
    } catch (err) {
      console.error('Voice transcription error:', err.message);
      fs.unlink(tmpFile, () => {});
      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: 'Sorry, something went wrong with your voice note. Please try typing your question.',
      });
    }
    return;
  }

  const isGreeting = /^(hi|hey|hello|hiya|howdy|good (morning|afternoon|evening)|sup|yo|helo|hii+)[\s!?.]*$/i.test(userMsg);

  if (!userMsg || isGreeting) {
    twiml.message('Hi! 👋 Ask me anything about EX3 and SmartRecruiters — I\'m here to help.');
    return res.type('text/xml').send(twiml.toString());
  }

  // Acknowledge immediately so Twilio doesn't time out
  twiml.message('Got it! Looking that up for you...');
  res.type('text/xml').send(twiml.toString());

  // Process in background and send the real answer as an outbound message
  const start = Date.now();
  let answer = '';
  let success = false;

  try {
    if (!process.env.ASSISTANT_ID) throw new Error('Assistant not configured.');

    const existingThreadId = getUserThread(from);
    const thread = existingThreadId
      ? { id: existingThreadId }
      : await openai.beta.threads.create();
    saveUserThread(from, thread.id);

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMsg,
    });

    let run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    while (run.status === 'in_progress' || run.status === 'queued') {
      if (Date.now() - start > 55000) throw new Error('Timed out.');
      await new Promise(r => setTimeout(r, 1000));
      run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }

    if (run.status !== 'completed') throw new Error(`Run status: ${run.status}`);

    const messages = await openai.beta.threads.messages.list(thread.id);
    answer = messages.data[0]?.content[0]?.text?.value || '';
    answer = answer.replace(/【[^】]*】/g, '').replace(/FOLLOWUPS:.*$/ms, '').trim();

    if (answer.length > 1580) answer = answer.slice(0, 1577) + '…';

    success = true;
    const uncertain = isUncertain(answer);

    await twilioClient.messages.create({
      from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: answer || 'Sorry, I could not find an answer.',
    });

    logMessage({
      ts: new Date().toISOString(),
      from,
      question: userMsg,
      answer,
      ms: Date.now() - start,
      success,
      uncertain,
    });
    return;
  } catch (err) {
    console.error('WhatsApp AI error:', err.message);
    try {
      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: 'Sorry, something went wrong. Please try again.',
      });
    } catch (e) {
      console.error('Failed to send error message:', e.message);
    }
    logMessage({
      ts: new Date().toISOString(),
      from,
      question: userMsg,
      answer,
      ms: Date.now() - start,
      success: false,
      uncertain: false,
    });
  }
});

// Analytics dashboard
app.all('/analytics', requirePassword);
app.get('/analytics', (req, res) => {
  const allLogs = readLogs();
  const search = (req.query.q || '').trim().replace(/\D/g, ''); // digits only
  const logs = search ? allLogs.filter(l => l.from.replace(/\D/g, '').includes(search)) : allLogs;

  const total = logs.length;
  const errors = logs.filter(l => !l.success).length;
  const uncertain = logs.filter(l => l.uncertain).length;
  const avgMs = total ? Math.round(logs.reduce((s, l) => s + l.ms, 0) / total) : 0;

  // Questions per day
  const byDay = {};
  for (const l of logs) {
    const day = l.ts.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  // Unique users (phone numbers)
  const uniqueNumbers = [...new Set(allLogs.map(l => l.from.replace('whatsapp:', '')))];
  const uniqueUsers = new Set(allLogs.map(l => l.from)).size;

  const rows = logs.slice().reverse().map(l => {
    const status = !l.success ? '❌ Error' : l.uncertain ? '⚠️ Uncertain' : '✅';
    const num = l.from.replace('whatsapp:', '');
    return `
    <tr>
      <td>${l.ts.replace('T', ' ').slice(0, 19)}</td>
      <td><a href="/analytics?q=${encodeURIComponent(num)}" style="color:#4a90e2;text-decoration:none">${num}</a></td>
      <td>${escHtml(l.question)}</td>
      <td class="preview" onclick="showAnswer(this)" data-full="${escHtml(l.answer || '—')}">${escHtml(l.answer || '—').slice(0, 120)}${(l.answer || '').length > 120 ? '… <span style="color:#4a90e2;font-size:.8rem">(click to expand)</span>' : ''}</td>
      <td>${status}</td>
      <td>${(l.ms / 1000).toFixed(1)}s</td>
    </tr>`;
  }).join('');

  const dayRows = Object.entries(byDay).sort().reverse().map(([d, c]) =>
    `<tr><td>${d}</td><td>${c}</td></tr>`).join('');

  const numberOptions = uniqueNumbers.map(n =>
    `<option value="${escHtml(n)}" ${search && n.includes(search) ? 'selected' : ''}>${escHtml(n)}</option>`
  ).join('');

  const searchLabel = search ? `— filtered to <strong>${logs[0]?.from.replace('whatsapp:','') || search}</strong> <a href="/analytics" style="font-size:.85rem;color:#4a90e2">clear</a>` : '';

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp Analytics</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; background: #f9f9f9; }
    h1 { color: #333; }
    .cards { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .card { background: white; border-radius: 8px; padding: 1rem 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.1); min-width: 140px; }
    .card .num { font-size: 2rem; font-weight: bold; color: #4a90e2; }
    .card .label { color: #888; font-size: .85rem; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
    th { background: #4a90e2; color: white; padding: .6rem 1rem; text-align: left; }
    td { padding: .55rem 1rem; border-bottom: 1px solid #eee; font-size: .9rem; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    h2 { margin-top: 2rem; color: #555; }
    .search-bar { display: flex; gap: .5rem; align-items: center; margin-bottom: 1.5rem; }
    .search-bar select, .search-bar input { padding: .5rem .75rem; border: 1px solid #ddd; border-radius: 6px; font-size: .95rem; }
    .search-bar button { padding: .5rem 1rem; background: #4a90e2; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: .95rem; }
    .preview { cursor: pointer; color: #555; }
    .preview:hover { color: #4a90e2; }
    .modal-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:100; align-items:center; justify-content:center; }
    .modal-bg.open { display:flex; }
    .modal { background:white; border-radius:10px; padding:1.5rem 2rem; max-width:560px; width:90%; max-height:80vh; overflow-y:auto; box-shadow:0 4px 24px rgba(0,0,0,.2); }
    .modal h3 { margin-top:0; color:#333; }
    .modal p { white-space:pre-wrap; color:#444; line-height:1.6; }
    .modal button { margin-top:1rem; padding:.4rem 1rem; background:#4a90e2; color:white; border:none; border-radius:6px; cursor:pointer; }
  </style>
</head>
<body>
  <nav style="margin-bottom:1.5rem">
    <a href="/analytics" style="margin-right:1rem;color:#4a90e2;text-decoration:none;font-weight:bold;border-bottom:2px solid #4a90e2">WhatsApp</a>
    <a href="/analytics/web" style="color:#4a90e2;text-decoration:none;font-weight:bold">Web Chat</a>
  </nav>
  <h1>WhatsApp Analytics ${searchLabel}</h1>

  <form class="search-bar" method="get" action="/analytics">
    <input name="q" placeholder="Search by phone number..." value="${escHtml(req.query.q || '')}" style="width:240px" />
    <select onchange="this.form.q.value=this.value;this.form.submit()">
      <option value="">— or pick a number —</option>
      ${numberOptions}
    </select>
    <button type="submit">Search</button>
  </form>

  <div class="cards">
    <div class="card"><div class="num">${total}</div><div class="label">${search ? 'Filtered' : 'Total'} messages</div></div>
    <div class="card"><div class="num">${uniqueUsers}</div><div class="label">Unique users</div></div>
    <div class="card"><div class="num">${errors}</div><div class="label">Errors</div></div>
    <div class="card"><div class="num">${uncertain}</div><div class="label">Uncertain answers</div></div>
    <div class="card"><div class="num">${(avgMs/1000).toFixed(1)}s</div><div class="label">Avg response time</div></div>
  </div>

  <h2>Messages per day</h2>
  <table>
    <tr><th>Date</th><th>Messages</th></tr>
    ${dayRows || '<tr><td colspan="2">No data yet</td></tr>'}
  </table>

  <h2>Recent messages</h2>
  <table>
    <tr><th>Time</th><th>From</th><th>Question</th><th>Answer</th><th>OK</th><th>Time</th></tr>
    ${rows || '<tr><td colspan="6">No messages yet</td></tr>'}
  </table>
  <div class="modal-bg" id="modal" onclick="closeModal(event)">
    <div class="modal">
      <h3 id="modal-q"></h3>
      <p id="modal-a"></p>
      <button onclick="document.getElementById('modal').classList.remove('open')">Close</button>
    </div>
  </div>
  <script>
    function showAnswer(td) {
      const row = td.closest('tr');
      const question = row.cells[2].textContent;
      document.getElementById('modal-q').textContent = question;
      document.getElementById('modal-a').textContent = td.dataset.full;
      document.getElementById('modal').classList.add('open');
    }
    function closeModal(e) {
      if (e.target.id === 'modal') document.getElementById('modal').classList.remove('open');
    }
  </script>
</body>
</html>`);
});

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function isUncertain(text) {
  const patterns = [
    /i (don'?t|do not) (have|know|find|see)/i,
    /not (covered|found|available|mentioned|included) in/i,
    /no (information|details?|data|content) (available|found|provided)/i,
    /unable to (find|locate|answer|provide)/i,
    /can'?t (find|answer|help with)/i,
    /outside (the scope|my knowledge)/i,
    /not (in|part of) (the|my|this) (document|guide|knowledge)/i,
    /i can only (assist|help|answer) with/i,
    /only (assist|help|answer) questions (related|about)/i,
    /not (able|here) to (help|assist) with that/i,
    /that('s| is) (outside|beyond|not within)/i,
    /not (relevant|related) to/i,
  ];
  return patterns.some(p => p.test(text));
}

// Consultant Portal
app.get('/consultant', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EX3 Consultant Portal</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:#f8f7f4;color:#0f0f0e;line-height:1.65;font-size:14px}
    a{color:inherit;text-decoration:none}
    .layout{display:flex;min-height:100vh}
    /* Sidebar */
    .sidebar{width:260px;flex-shrink:0;background:#0f0f0f;color:#fff;position:fixed;top:0;left:0;bottom:0;overflow-y:auto;display:flex;flex-direction:column}
    .sb-brand{padding:24px 20px;border-bottom:1px solid #2a2a2a}
    .sb-brand .logo{font-size:36px;font-weight:900;letter-spacing:-.12em;line-height:1}
    .sb-brand .tag{font-size:11px;color:#888;letter-spacing:.08em;text-transform:uppercase;margin-top:4px}
    .sb-back{display:flex;align-items:center;gap:6px;padding:12px 20px;font-size:12px;color:#888;border-bottom:1px solid #2a2a2a;cursor:pointer;transition:color .15s}
    .sb-back:hover{color:#fff}
    .sb-section{padding:16px 20px 4px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#555;font-weight:600}
    .sb-item{display:block;padding:9px 20px;font-size:13px;color:#aaa;cursor:pointer;transition:all .15s;border-left:2px solid transparent}
    .sb-item:hover{color:#fff;background:#1a1a1a}
    .sb-item.active{color:#fff;border-left-color:#fff;background:#1a1a1a}
    /* Main */
    .main{margin-left:260px;flex:1;padding:40px 48px;max-width:900px}
    .page{display:none}.page.active{display:block}
    /* Hero */
    .hero{margin-bottom:40px}
    .hero h1{font-size:32px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px}
    .hero p{font-size:15px;color:#555;max-width:580px}
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:16px}
    .badge-blue{background:#eff4ff;color:#1a56db}
    .badge-green{background:#f0fdf6;color:#0d7c4c}
    .badge-amber{background:#fffbeb;color:#b45309}
    .badge-purple{background:#faf5ff;color:#6b21a8}
    .badge-gray{background:#f3f4f6;color:#374151}
    /* Cards */
    .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-bottom:32px}
    .card{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:20px;transition:box-shadow .15s}
    .card:hover{box-shadow:0 4px 16px rgba(0,0,0,.08)}
    .card h3{font-size:14px;font-weight:600;margin-bottom:6px}
    .card p{font-size:13px;color:#555}
    .card .num{font-size:28px;font-weight:700;color:#0f0f0f;margin-bottom:4px}
    /* Phases */
    .phase{background:#fff;border:1px solid #e4e2dc;border-radius:10px;margin-bottom:16px;overflow:hidden}
    .phase-header{padding:16px 20px;display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none}
    .phase-header:hover{background:#fafaf9}
    .phase-num{width:28px;height:28px;border-radius:50%;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
    .phase-title{font-weight:600;font-size:15px;flex:1}
    .phase-weeks{font-size:12px;color:#888}
    .phase-chevron{transition:transform .2s;color:#888}
    .phase-body{display:none;padding:0 20px 20px;border-top:1px solid #f0eeea}
    .phase-body.open{display:block}
    /* Checklist */
    .checklist{list-style:none;margin-top:12px}
    .checklist li{display:flex;align-items:flex-start;gap:10px;padding:6px 0;font-size:13px;border-bottom:1px solid #f5f4f1}
    .checklist li:last-child{border-bottom:none}
    .checklist li::before{content:'☐';font-size:15px;flex-shrink:0;margin-top:1px;color:#888}
    /* SOW */
    .sow-box{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:28px;margin-bottom:24px}
    .sow-box h2{font-size:18px;font-weight:700;margin-bottom:4px}
    .sow-box .sub{font-size:13px;color:#888;margin-bottom:20px}
    .sow-section{margin-bottom:20px}
    .sow-section h3{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#555;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #f0eeea}
    .sow-section p,.sow-section li{font-size:13px;color:#333;line-height:1.7}
    .sow-section ul{padding-left:18px;margin-top:6px}
    .sow-section li{margin-bottom:4px}
    .copy-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#0f0f0f;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s;font-family:inherit}
    .copy-btn:hover{background:#333}
    /* Roles */
    .role-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:24px}
    .role-card{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:16px;cursor:pointer;transition:all .15s}
    .role-card:hover{box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .role-card.sel{border-color:#0f0f0f;box-shadow:0 0 0 2px #0f0f0f}
    .role-card h3{font-size:13px;font-weight:600;margin-bottom:4px}
    .role-card p{font-size:12px;color:#888}
    .role-content{display:none}.role-content.active{display:block}
    /* Table */
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4e2dc;border-radius:10px;overflow:hidden;margin-bottom:24px}
    th{background:#0f0f0f;color:#fff;padding:10px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:.04em}
    td{padding:10px 14px;border-bottom:1px solid #f0eeea;font-size:13px}
    tr:last-child td{border-bottom:none}
    h2.section-title{font-size:22px;font-weight:700;margin-bottom:6px;letter-spacing:-.01em}
    p.section-sub{font-size:14px;color:#555;margin-bottom:24px}
    .tip{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;font-size:13px;color:#78350f;margin-bottom:16px}
    .tip strong{font-weight:600}
  </style>
</head>
<body>
<div class="layout">

  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="sb-brand">
      <div class="logo">ex3</div>
      <div class="tag">Consultant Portal</div>
    </div>
    <a href="/" class="sb-back">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      Back to main guide
    </a>
    <div class="sb-section">Implementation</div>
    <div class="sb-item active" onclick="showPage('overview')">Overview & Timeline</div>
    <div class="sb-item" onclick="showPage('phases')">Phase Guide</div>
    <div class="sb-item" onclick="showPage('sow')">SOW Template</div>
    <div class="sb-section">Stakeholders</div>
    <div class="sb-item" onclick="showPage('roles')">Roles & Responsibilities</div>
    <div class="sb-section">Resources</div>
    <div class="sb-item" onclick="showPage('checklists')">Checklists</div>
    <div class="sb-item" onclick="showPage('faq')">FAQ & Troubleshooting</div>
    <div class="sb-section">Tools</div>
    <a href="/consultant/sow-builder" style="display:block;padding:9px 20px;font-size:13px;color:#aaa;transition:all .15s;border-left:2px solid transparent;background:#1a3a1a;border-left-color:#4ade80;color:#4ade80;font-weight:600">✨ SOW Builder</a>
    <a href="/consultant/implementation-hq" style="display:block;padding:9px 20px;font-size:13px;transition:all .15s;border-left:2px solid transparent;background:#1B1040;border-left-color:#412288;color:#c4b5fd;font-weight:600;margin-top:4px">🏗 Implementation HQ</a>
  </nav>

  <!-- Main -->
  <main class="main">

    <!-- OVERVIEW -->
    <div class="page active" id="page-overview">
      <div class="hero">
        <span class="badge badge-gray">Consultant Portal</span>
        <h1>SmartRecruiters Implementation Guide</h1>
        <p>Everything you need to deliver a successful SmartRecruiters implementation — from kickoff to go-live.</p>
      </div>
      <div class="cards">
        <div class="card"><div class="num">8–12</div><h3>Typical Weeks</h3><p>For a standard mid-size organisation</p></div>
        <div class="card"><div class="num">6</div><h3>Phases</h3><p>Discovery, Config, Build, UAT, Training, Go-Live</p></div>
        <div class="card"><div class="num">4</div><h3>Key Stakeholders</h3><p>HR, IT, Recruiters, Hiring Managers</p></div>
        <div class="card"><div class="num">3</div><h3>Training Sessions</h3><p>Admin, Recruiter, Hiring Manager</p></div>
      </div>
      <div class="tip"><strong>First time?</strong> Start with the Phase Guide — it walks you through exactly what to do and when. The SOW Template has pre-written scope wording you can use directly with clients.</div>
      <h2 class="section-title">Typical Implementation Timeline</h2>
      <p class="section-sub">Use this as a guide — timelines vary based on client complexity, integrations, and decision speed.</p>
      <table>
        <tr><th>Phase</th><th>Weeks</th><th>Key Output</th></tr>
        <tr><td>1. Discovery & Kickoff</td><td>1–2</td><td>Project plan, stakeholder map, requirements doc</td></tr>
        <tr><td>2. System Configuration</td><td>2–4</td><td>Platform configured, users set up, hiring processes built</td></tr>
        <tr><td>3. Build & Integrate</td><td>3–5</td><td>Integrations live, job boards connected, career page branded</td></tr>
        <tr><td>4. UAT (Testing)</td><td>5–7</td><td>Client signed off, bugs resolved</td></tr>
        <tr><td>5. Training</td><td>6–8</td><td>All users trained, materials delivered</td></tr>
        <tr><td>6. Go-Live & Hypercare</td><td>8–12</td><td>Live in production, 2–4 week support window</td></tr>
      </table>
    </div>

    <!-- PHASES -->
    <div class="page" id="page-phases">
      <div class="hero">
        <span class="badge badge-blue">Phase Guide</span>
        <h1>Implementation Phases</h1>
        <p>A detailed breakdown of every phase — what to do, who's involved, and what to deliver.</p>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">1</div>
          <div class="phase-title">Discovery & Kickoff</div>
          <div class="phase-weeks">Weeks 1–2</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">The goal of discovery is to understand the client's current recruitment process, pain points, and what they need SmartRecruiters to do. Never skip this — it prevents costly rework later.</p>
          <ul class="checklist">
            <li>Host kickoff call with all key stakeholders (HR Director, IT, Lead Recruiter)</li>
            <li>Map the client's current hiring process end-to-end</li>
            <li>Identify number of hiring managers and recruiters who need access</li>
            <li>Confirm which integrations are needed (HRIS, job boards, background check)</li>
            <li>Agree on job templates required (how many, what fields)</li>
            <li>Confirm company branding requirements (logo, colours, career page)</li>
            <li>Clarify data migration needs (historical jobs/candidates?)</li>
            <li>Agree project timeline and sign off project plan</li>
            <li>Confirm who the internal champion/project owner is on the client side</li>
            <li>Send Discovery Questionnaire to client and collect responses</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">2</div>
          <div class="phase-title">System Configuration</div>
          <div class="phase-weeks">Weeks 2–4</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">This is where you build the platform. Work from the inside out — company settings first, then users, then hiring processes, then templates.</p>
          <ul class="checklist">
            <li>Configure company settings (name, logo, timezone, language)</li>
            <li>Set up user roles (Admin, Recruiter, Hiring Manager, Limited)</li>
            <li>Create user accounts and assign roles</li>
            <li>Build hiring process workflows for each job type</li>
            <li>Configure offer approval chains</li>
            <li>Create job templates and custom fields</li>
            <li>Set up email templates (application received, interview invite, rejection, offer)</li>
            <li>Configure interview scheduling settings</li>
            <li>Set up offer letter templates</li>
            <li>Configure compliance and data retention settings</li>
            <li>Set up department and location structure</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">3</div>
          <div class="phase-title">Build & Integrate</div>
          <div class="phase-weeks">Weeks 3–5</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">Connect SmartRecruiters to the client's existing systems. Involve the client's IT team here — you'll need their credentials and access.</p>
          <ul class="checklist">
            <li>Brand and configure the careers page</li>
            <li>Connect job boards (Indeed, LinkedIn, Glassdoor, etc.)</li>
            <li>Set up HRIS integration if required (Workday, SAP, BambooHR)</li>
            <li>Configure background screening integration if required</li>
            <li>Set up SSO (Single Sign-On) if required — needs IT</li>
            <li>Test all integrations end-to-end</li>
            <li>Configure job posting approval workflows</li>
            <li>Set up Winston AI features if in scope</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">4</div>
          <div class="phase-title">UAT — User Acceptance Testing</div>
          <div class="phase-weeks">Weeks 5–7</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">The client tests everything in a staging environment. Your job is to facilitate, log issues, and fix them quickly. Get written sign-off before proceeding to go-live.</p>
          <ul class="checklist">
            <li>Prepare UAT test scripts (one per user role)</li>
            <li>Walk client through the UAT process and what's expected</li>
            <li>Create a test job and run through full hiring process</li>
            <li>Test candidate application journey end-to-end</li>
            <li>Test hiring manager review and feedback flow</li>
            <li>Test offer creation and approval chain</li>
            <li>Test all email templates trigger correctly</li>
            <li>Test integrations with real test data</li>
            <li>Log all issues in a shared tracker</li>
            <li>Resolve all critical issues before proceeding</li>
            <li>Obtain written UAT sign-off from client</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">5</div>
          <div class="phase-title">Training</div>
          <div class="phase-weeks">Weeks 6–8</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">Run separate training sessions per role — don't mix admins and hiring managers in the same session. Keep it practical, hands-on, and recorded where possible.</p>
          <ul class="checklist">
            <li>Schedule Admin training session (90 mins recommended)</li>
            <li>Schedule Recruiter training session (60 mins recommended)</li>
            <li>Schedule Hiring Manager training session (45 mins recommended)</li>
            <li>Prepare training materials and share in advance</li>
            <li>Record sessions for users who couldn't attend</li>
            <li>Create quick reference guides per role</li>
            <li>Share access to this EX3 guide with all users</li>
            <li>Confirm who the internal super-users are (people who help colleagues)</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">6</div>
          <div class="phase-title">Go-Live & Hypercare</div>
          <div class="phase-weeks">Weeks 8–12</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">Go-live day is just the beginning. The hypercare period (2–4 weeks of close support) is where most issues surface. Be proactive — check in daily in the first week.</p>
          <ul class="checklist">
            <li>Confirm go-live date with client at least 2 weeks in advance</li>
            <li>Complete final production environment check</li>
            <li>Migrate any agreed historical data</li>
            <li>Send go-live communication to all users</li>
            <li>Be on standby on go-live day</li>
            <li>Daily check-in calls for first week post go-live</li>
            <li>Weekly check-ins for weeks 2–4</li>
            <li>Log and resolve all post go-live issues</li>
            <li>Handover to support team with full documentation</li>
            <li>Conduct project retrospective with client</li>
            <li>Obtain client satisfaction sign-off</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- SOW -->
    <div class="page" id="page-sow">
      <div class="hero">
        <span class="badge badge-green">SOW Template</span>
        <h1>Statement of Work Template</h1>
        <p>Pre-written scope wording for a standard SmartRecruiters implementation. Edit the highlighted fields for each client.</p>
      </div>
      <div class="tip"><strong>How to use:</strong> Copy the relevant sections below into your SOW document. Replace anything in [brackets] with client-specific details. Always get this reviewed before sending.</div>

      <div class="sow-box">
        <h2>1. Project Overview</h2>
        <div class="sub">Introductory paragraph for the SOW</div>
        <div class="sow-section">
          <p>This Statement of Work defines the scope, deliverables, timeline, and responsibilities for the implementation of SmartRecruiters for [Client Name]. EX3 will provide implementation consultancy services to configure, integrate, and deploy the SmartRecruiters platform in accordance with [Client Name]'s requirements as agreed during the discovery phase.</p>
        </div>
        <button class="copy-btn" onclick="copyText(this, 'This Statement of Work defines the scope, deliverables, timeline, and responsibilities for the implementation of SmartRecruiters for [Client Name]. EX3 will provide implementation consultancy services to configure, integrate, and deploy the SmartRecruiters platform in accordance with [Client Name]\\'s requirements as agreed during the discovery phase.')">Copy</button>
      </div>

      <div class="sow-box">
        <h2>2. In Scope</h2>
        <div class="sub">What EX3 will deliver — use this as your standard scope</div>
        <div class="sow-section">
          <h3>Platform Configuration</h3>
          <ul>
            <li>Configuration of company settings, branding, and system preferences</li>
            <li>Creation and configuration of user roles and permissions</li>
            <li>Setup of up to [X] hiring process workflows</li>
            <li>Configuration of up to [X] job templates with custom fields</li>
            <li>Setup of email notification templates (application, interview, rejection, offer)</li>
            <li>Configuration of offer letter templates (up to [X] templates)</li>
            <li>Setup of interview scheduling configuration</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>Career Page & Advertising</h3>
          <ul>
            <li>Configuration and branding of the SmartRecruiters careers page</li>
            <li>Connection of up to [X] job board accounts (e.g. Indeed, LinkedIn)</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>User Setup</h3>
          <ul>
            <li>Creation of up to [X] user accounts</li>
            <li>Assignment of roles and access permissions</li>
            <li>Bulk user import (if applicable)</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>Testing</h3>
          <ul>
            <li>Facilitation of User Acceptance Testing (UAT) with agreed test scripts</li>
            <li>Resolution of issues identified during UAT</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>Training</h3>
          <ul>
            <li>One Administrator training session (up to 90 minutes)</li>
            <li>One Recruiter training session (up to 60 minutes)</li>
            <li>One Hiring Manager training session (up to 45 minutes)</li>
            <li>Access to the EX3 SmartRecruiters Enablement Guide for all users</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>Go-Live Support</h3>
          <ul>
            <li>Go-live readiness review and final checks</li>
            <li>Hypercare support for [2/4] weeks post go-live</li>
            <li>Post-implementation documentation and handover</li>
          </ul>
        </div>
      </div>

      <div class="sow-box">
        <h2>3. Out of Scope</h2>
        <div class="sub">Be explicit about what's NOT included to avoid scope creep</div>
        <div class="sow-section">
          <ul>
            <li>Migration of historical candidate or job data (unless separately agreed)</li>
            <li>Custom development, API builds, or bespoke integrations not listed above</li>
            <li>SmartRecruiters platform licensing costs (to be contracted directly)</li>
            <li>Ongoing managed services or system administration after the hypercare period</li>
            <li>Training beyond the sessions defined above</li>
            <li>Changes to scope agreed after project kick-off (subject to change request process)</li>
          </ul>
        </div>
      </div>

      <div class="sow-box">
        <h2>4. Client Responsibilities</h2>
        <div class="sub">What the client must provide — critical to include</div>
        <div class="sow-section">
          <ul>
            <li>Appoint an internal project owner with authority to make decisions</li>
            <li>Complete the Discovery Questionnaire within [X] days of kickoff</li>
            <li>Provide timely feedback and approvals at each phase gate</li>
            <li>Ensure key stakeholders are available for scheduled sessions</li>
            <li>Provide IT access and credentials required for integrations</li>
            <li>Provide brand assets (logo, colour palette, imagery) for career page setup</li>
            <li>Complete UAT and provide written sign-off within [X] days</li>
            <li>Ensure all users attend or watch their relevant training session</li>
          </ul>
        </div>
      </div>

      <div class="sow-box">
        <h2>5. Assumptions</h2>
        <div class="sub">Protect yourself — state what you're assuming to be true</div>
        <div class="sow-section">
          <ul>
            <li>The client holds a valid SmartRecruiters licence for the duration of the project</li>
            <li>A named internal project owner will be available throughout the engagement</li>
            <li>Client feedback and approvals will be provided within 3 business days of request</li>
            <li>All integrations use standard SmartRecruiters connectors — no custom development required</li>
            <li>The number of users, templates, and workflows does not exceed the quantities stated above</li>
            <li>Go-live will occur within [X] weeks of project start — delays caused by the client may impact timelines and costs</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- ROLES -->
    <div class="page" id="page-roles">
      <div class="hero">
        <span class="badge badge-purple">Stakeholders</span>
        <h1>Roles & Responsibilities</h1>
        <p>Who needs to be involved, what they're responsible for, and when you need them.</p>
      </div>
      <div class="role-grid">
        <div class="role-card sel" onclick="selectRole(this,'role-consultant')"><h3>EX3 Consultant</h3><p>That's you</p></div>
        <div class="role-card" onclick="selectRole(this,'role-hr')"><h3>HR Director / Owner</h3><p>Client side</p></div>
        <div class="role-card" onclick="selectRole(this,'role-it')"><h3>IT / System Admin</h3><p>Client side</p></div>
        <div class="role-card" onclick="selectRole(this,'role-recruiter')"><h3>Lead Recruiter</h3><p>Client side</p></div>
        <div class="role-card" onclick="selectRole(this,'role-hm')"><h3>Hiring Manager</h3><p>Client side</p></div>
      </div>

      <div class="role-content active" id="role-consultant">
        <h2 class="section-title">EX3 Consultant</h2>
        <p class="section-sub">Your responsibilities across the implementation.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Lead discovery sessions and gather requirements</td><td>Week 1–2</td></tr>
          <tr><td>Own and maintain the project plan</td><td>Throughout</td></tr>
          <tr><td>Configure the SmartRecruiters platform</td><td>Week 2–4</td></tr>
          <tr><td>Set up and test all integrations</td><td>Week 3–5</td></tr>
          <tr><td>Facilitate UAT and manage issue log</td><td>Week 5–7</td></tr>
          <tr><td>Deliver training sessions</td><td>Week 6–8</td></tr>
          <tr><td>Support go-live and hypercare period</td><td>Week 8–12</td></tr>
          <tr><td>Produce handover documentation</td><td>End of project</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-hr">
        <h2 class="section-title">HR Director / Project Owner</h2>
        <p class="section-sub">The most important person on the client side. They make decisions and unblock things.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Sign off project scope and SOW</td><td>Before kickoff</td></tr>
          <tr><td>Attend kickoff and key milestone sessions</td><td>Week 1, 7, go-live</td></tr>
          <tr><td>Make decisions on hiring process design</td><td>Week 1–3</td></tr>
          <tr><td>Approve offer templates and approval chains</td><td>Week 3–4</td></tr>
          <tr><td>Provide UAT sign-off</td><td>Week 5–7</td></tr>
          <tr><td>Champion the system internally</td><td>Throughout</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-it">
        <h2 class="section-title">IT / System Administrator</h2>
        <p class="section-sub">Needed mainly for integrations and SSO. Engage them early — they're often the bottleneck.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Provide HRIS credentials and integration access</td><td>Week 3</td></tr>
          <tr><td>Configure SSO (if required)</td><td>Week 3–4</td></tr>
          <tr><td>Whitelist SmartRecruiters domains on firewall</td><td>Week 2</td></tr>
          <tr><td>Support data migration (if applicable)</td><td>Week 7–8</td></tr>
          <tr><td>Attend integration testing sessions</td><td>Week 4–5</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-recruiter">
        <h2 class="section-title">Lead Recruiter</h2>
        <p class="section-sub">Your day-to-day contact. They know the current process better than anyone.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Map current recruitment process during discovery</td><td>Week 1–2</td></tr>
          <tr><td>Review and approve hiring process configuration</td><td>Week 3–4</td></tr>
          <tr><td>Lead UAT testing for recruiter workflows</td><td>Week 5–6</td></tr>
          <tr><td>Attend recruiter training session</td><td>Week 6–8</td></tr>
          <tr><td>Become internal super-user post go-live</td><td>Week 8+</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-hm">
        <h2 class="section-title">Hiring Manager</h2>
        <p class="section-sub">Often the hardest to engage. Keep their involvement minimal and targeted.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Attend hiring manager training session</td><td>Week 6–8</td></tr>
          <tr><td>Complete UAT for hiring manager workflows</td><td>Week 5–7</td></tr>
          <tr><td>Provide feedback on job approval workflow</td><td>Week 3</td></tr>
        </table>
      </div>
    </div>

    <!-- CHECKLISTS -->
    <div class="page" id="page-checklists">
      <div class="hero">
        <span class="badge badge-amber">Checklists</span>
        <h1>Implementation Checklists</h1>
        <p>Use these before each phase gate to make sure nothing is missed.</p>
      </div>
      <h2 class="section-title" style="margin-bottom:16px">Pre Go-Live Checklist</h2>
      <div style="background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:20px;margin-bottom:24px">
        <ul class="checklist" id="pre-golive-list">
          <li onclick="toggleCheck(this)">All hiring processes configured and tested</li>
          <li onclick="toggleCheck(this)">All user accounts created and roles assigned</li>
          <li onclick="toggleCheck(this)">Email templates reviewed and approved by client</li>
          <li onclick="toggleCheck(this)">Offer templates reviewed and approved by client</li>
          <li onclick="toggleCheck(this)">Career page live and branded correctly</li>
          <li onclick="toggleCheck(this)">All integrations tested with real data</li>
          <li onclick="toggleCheck(this)">UAT completed and written sign-off received</li>
          <li onclick="toggleCheck(this)">All training sessions completed</li>
          <li onclick="toggleCheck(this)">Go-live communication sent to all users</li>
          <li onclick="toggleCheck(this)">Hypercare plan agreed with client</li>
          <li onclick="toggleCheck(this)">Support contact and escalation path documented</li>
        </ul>
      </div>

      <h2 class="section-title" style="margin-bottom:16px">Discovery Questionnaire</h2>
      <div style="background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:20px;margin-bottom:24px">
        <p style="font-size:13px;color:#555;margin-bottom:12px">Send this to the client before or at kickoff. Their answers drive your configuration decisions.</p>
        <ul class="checklist">
          <li>How many open roles do you typically have at any one time?</li>
          <li>How many recruiters will use the system?</li>
          <li>How many hiring managers will need access?</li>
          <li>What does your current hiring process look like? (stages)</li>
          <li>Do different job types have different hiring processes?</li>
          <li>Who approves job postings before they go live?</li>
          <li>Who is involved in approving offers?</li>
          <li>Which job boards do you currently advertise on?</li>
          <li>Do you have an existing HRIS system? (Workday, SAP, BambooHR etc.)</li>
          <li>Do you require Single Sign-On (SSO)?</li>
          <li>Do you use a background screening provider?</li>
          <li>Do you have historical candidate data to migrate?</li>
          <li>What does your employer brand look like? (logo, colours)</li>
          <li>Are there compliance or data retention requirements we need to know about?</li>
        </ul>
      </div>
    </div>

    <!-- FAQ -->
    <div class="page" id="page-faq">
      <div class="hero">
        <span class="badge badge-gray">FAQ</span>
        <h1>FAQ & Troubleshooting</h1>
        <p>Common questions and problems you'll encounter on implementations.</p>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">How long should a SmartRecruiters implementation take?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">For a standard mid-size company (50–500 employees, no complex integrations), expect 8–10 weeks. Larger organisations or those requiring HRIS integrations, SSO, or data migration should plan for 10–16 weeks. The biggest variable is client responsiveness — decisions that take a week instead of a day add up fast.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">What's the most common cause of implementations going over time?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">Slow client decision-making. When no one has authority to approve the hiring process design or sign off UAT, the project stalls. Always confirm who the decision-maker is at kickoff and get it in writing in the SOW under Client Responsibilities.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">What should go in the SOW scope?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">The scope should cover: platform configuration, user setup, integrations (list each one explicitly), career page setup, UAT facilitation, training sessions (specify how many and which roles), go-live support, and hypercare duration. Always include an Out of Scope section — data migration, custom development, and additional training are common areas where clients assume it's included when it isn't.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">What integrations does SmartRecruiters support out of the box?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">SmartRecruiters has a large marketplace of native integrations including: Indeed, LinkedIn, Glassdoor (job boards), Workday, SAP SuccessFactors, BambooHR (HRIS), Sterling, Checkr (background screening), Okta, Azure AD (SSO), DocuSign, and many more. Always check the SmartRecruiters Marketplace for the latest list. Custom integrations via API are out of scope for a standard implementation.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">Client wants to change scope mid-project — what do I do?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">Raise a Change Request. Never agree to scope changes verbally. Document what's being added, the impact on timeline and cost, and get it signed off before doing the work. If the change is minor (e.g. one extra email template), use your judgement — but anything that adds meaningful effort should go through a formal change request.</p></div>
      </div>
    </div>

  </main>
</div>

<script>
  function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
    document.getElementById('page-' + id).classList.add('active');
    event.target.classList.add('active');
  }
  function togglePhase(header) {
    const body = header.nextElementSibling;
    const chevron = header.querySelector('.phase-chevron');
    body.classList.toggle('open');
    chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : '';
  }
  function selectRole(card, contentId) {
    document.querySelectorAll('.role-card').forEach(c => c.classList.remove('sel'));
    document.querySelectorAll('.role-content').forEach(c => c.classList.remove('active'));
    card.classList.add('sel');
    document.getElementById(contentId).classList.add('active');
  }
  function toggleCheck(li) {
    if (li.style.textDecoration === 'line-through') {
      li.style.textDecoration = '';
      li.style.color = '';
      li.style.opacity = '';
      li.querySelector ? null : null;
      li.childNodes[0] && (li.childNodes[0].textContent = '☐');
    } else {
      li.style.textDecoration = 'line-through';
      li.style.color = '#aaa';
    }
  }
  function copyText(btn, text) {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
  }
</script>

<!-- Demo Panel -->
<style>
  .demo-fab { position:fixed; bottom:28px; right:28px; z-index:9000; background:#22c55e; color:#000; border:none; border-radius:50px; padding:12px 22px; font-family:'Inter',system-ui,sans-serif; font-size:13px; font-weight:700; cursor:pointer; box-shadow:0 4px 20px rgba(34,197,94,.35); transition:all .2s; }
  .demo-fab:hover { transform:translateY(-2px); box-shadow:0 6px 24px rgba(34,197,94,.45); }
  .demo-fab.open { background:#1a1a1a; color:#fff; box-shadow:none; }
  .demo-panel { position:fixed; top:0; right:0; width:340px; height:100vh; background:#0f0f0f; color:#fff; z-index:8999; display:flex; flex-direction:column; transform:translateX(100%); transition:transform .3s cubic-bezier(.4,0,.2,1); box-shadow:-8px 0 40px rgba(0,0,0,.3); font-family:'Inter',system-ui,sans-serif; }
  .demo-panel.open { transform:translateX(0); }
  .dp-header { padding:18px 20px 14px; border-bottom:1px solid #1e1e1e; display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }
  .dp-logo { font-size:13px; font-weight:700; color:#22c55e; }
  .dp-timer { font-size:18px; font-weight:800; color:#22c55e; font-variant-numeric:tabular-nums; }
  .dp-progress { height:2px; background:#1a1a1a; flex-shrink:0; }
  .dp-progress-fill { height:100%; background:#22c55e; transition:width .4s; }
  .dp-body { flex:1; overflow-y:auto; padding:20px; }
  .dp-tag { font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:#22c55e; margin-bottom:10px; }
  .dp-title { font-size:20px; font-weight:800; line-height:1.2; margin-bottom:8px; letter-spacing:-.5px; }
  .dp-sub { font-size:12.5px; color:#666; margin-bottom:18px; line-height:1.6; }
  .dp-points { list-style:none; display:flex; flex-direction:column; gap:11px; margin-bottom:20px; }
  .dp-points li { display:flex; gap:10px; font-size:12.5px; color:#bbb; line-height:1.6; }
  .dp-dot { width:6px; height:6px; background:#22c55e; border-radius:50%; flex-shrink:0; margin-top:7px; }
  .dp-note { background:#141414; border:1px solid #1e1e1e; border-radius:10px; padding:14px; font-size:11.5px; color:#555; line-height:1.65; font-style:italic; }
  .dp-nav { padding:14px 20px; border-top:1px solid #1a1a1a; display:flex; gap:10px; flex-shrink:0; }
  .dp-btn { flex:1; padding:10px; border-radius:8px; font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; border:1px solid #2a2a2a; background:#1a1a1a; color:#fff; transition:background .15s; }
  .dp-btn:hover:not(:disabled) { background:#222; }
  .dp-btn.primary { background:#22c55e; color:#000; border-color:#22c55e; }
  .dp-btn.primary:hover { opacity:.9; }
  .dp-btn:disabled { opacity:.25; cursor:not-allowed; }
  .dp-step-count { text-align:center; font-size:11px; color:#444; padding:8px 0 0; flex-shrink:0; }
</style>

<button class="demo-fab" id="demoFab" onclick="toggleDemoPanel()">&#9654; Start Demo</button>

<div class="demo-panel" id="demoPanel">
  <div class="dp-header">
    <div class="dp-logo">EX3 Demo Mode</div>
    <div class="dp-timer" id="dp-timer">00:00</div>
  </div>
  <div class="dp-progress"><div class="dp-progress-fill" id="dp-prog"></div></div>
  <div class="dp-body" id="dp-body"></div>
  <div class="dp-step-count" id="dp-count"></div>
  <div class="dp-nav">
    <button class="dp-btn" id="dp-prev" onclick="dpGo(-1)">&#8592; Prev</button>
    <button class="dp-btn primary" id="dp-next" onclick="dpGo(1)">Next &#8594;</button>
  </div>
</div>

<script>
const dpSteps = [
  {
    tag: 'Consultant Portal',
    title: 'The Implementation Command Centre',
    subtitle: 'Everything an EX3 consultant needs to run a flawless implementation — in one place.',
    points: [
      'Covers every phase of a SmartRecruiters implementation end to end',
      'Built from real EX3 project experience — not generic advice',
      'Role matrix, UAT checklist, and FAQ all in one place',
      'Accessible anywhere — consultants use this live on client calls',
    ],
    note: 'Open with the overview visible. Let them read the phase list before you start clicking.',
  },
  {
    tag: 'Discovery Phase',
    title: 'Phase 1: Discovery',
    subtitle: 'Before any configuration starts, we need to understand the client inside out.',
    points: [
      'Map the client hiring process end-to-end before touching the platform',
      'Run a structured discovery session using the EX3 questionnaire',
      'Identify integrations, job boards, and data migration requirements upfront',
      'Agreeing scope here prevents scope creep later — this phase is critical',
    ],
    note: 'Click into the Discovery phase card. Walk through the key activities listed.',
  },
  {
    tag: 'Configuration Phase',
    title: 'Phase 2: Configuration',
    subtitle: 'This is where SmartRecruiters is built out to match what was agreed in discovery.',
    points: [
      'Users, roles, and permissions set up first — everything else depends on this',
      'Hiring workflows built to match each job type the client uses',
      'Email templates, offer letters, and job templates configured to their brand',
      'Every config decision is documented for the handover pack',
    ],
    note: 'Show the configuration checklist. Each item maps to a deliverable in the SOW.',
  },
  {
    tag: 'Integrations Phase',
    title: 'Phase 3: Integrations',
    subtitle: 'Connecting SmartRecruiters to the rest of the client tech stack.',
    points: [
      'HRIS, SSO, background screening, DocuSign — all require IT involvement from the client',
      'Engage the client IT team at kickoff — do not wait until integration phase starts',
      'Each integration is tested end-to-end before UAT begins',
      'Standard marketplace connectors only — custom dev is out of scope unless agreed',
    ],
    note: 'Show the integrations section. Highlight the note about engaging IT early.',
  },
  {
    tag: 'UAT Phase',
    title: 'Phase 4: User Acceptance Testing',
    subtitle: 'The client signs off before we go anywhere near go-live.',
    points: [
      'UAT is run by the client, supported by EX3 — not the other way around',
      'Test scripts provided covering every hiring workflow and user role',
      'Critical issues must be resolved before go-live — no exceptions',
      'Written sign-off obtained from the project owner before the go-live date is confirmed',
    ],
    note: 'Click on the UAT checklist. Show how each item is tracked.',
  },
  {
    tag: 'Training Phase',
    title: 'Phase 5: Training',
    subtitle: 'Separate sessions per role — never mix admins and hiring managers in the same room.',
    points: [
      'Admin training: 90 mins covering configuration, user management, and reporting',
      'Recruiter training: 60 mins covering end-to-end hiring and candidate management',
      'Hiring Manager training: 45 mins covering review, approval, and interview scheduling',
      'Sessions recorded and uploaded so new starters can watch them later',
    ],
    note: 'Show the training section. Emphasise the role-specific approach.',
  },
  {
    tag: 'Go-Live & Hypercare',
    title: 'Phase 6: Go-Live',
    subtitle: "The moment the client goes live — and when the real work begins.",
    points: [
      'Go-live readiness review with the client project owner the day before',
      'EX3 consultant on call on go-live day — available for any critical issues',
      'Hypercare period: daily check-ins week one, weekly thereafter',
      'Formal handover pack and close-out documentation delivered at end of hypercare',
    ],
    note: 'End on this slide. The hypercare point is a differentiator — competitors often disappear post go-live.',
  },
];

let dpCur = 0;
let dpOpen = false;
let dpStart = null;
let dpTimer = null;

function toggleDemoPanel() {
  dpOpen = !dpOpen;
  document.getElementById('demoPanel').classList.toggle('open', dpOpen);
  document.getElementById('demoFab').classList.toggle('open', dpOpen);
  document.getElementById('demoFab').textContent = dpOpen ? '✕ Exit Demo' : '▶ Start Demo';
  if (dpOpen && !dpStart) {
    dpStart = Date.now();
    dpTimer = setInterval(() => {
      const s = Math.floor((Date.now() - dpStart) / 1000);
      document.getElementById('dp-timer').textContent =
        String(Math.floor(s / 60)).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0');
    }, 1000);
    dpRender();
  }
  if (!dpOpen && dpTimer) { clearInterval(dpTimer); dpTimer = null; dpStart = null; }
}

function dpRender() {
  const s = dpSteps[dpCur];
  const pct = Math.round(((dpCur + 1) / dpSteps.length) * 100);
  document.getElementById('dp-prog').style.width = pct + '%';
  document.getElementById('dp-count').textContent = 'Step ' + (dpCur + 1) + ' of ' + dpSteps.length;
  document.getElementById('dp-prev').disabled = dpCur === 0;
  document.getElementById('dp-next').textContent = dpCur === dpSteps.length - 1 ? 'Finish ✓' : 'Next →';
  document.getElementById('dp-body').innerHTML =
    '<div class="dp-tag">' + String(dpCur+1).padStart(2,'0') + ' / ' + String(dpSteps.length).padStart(2,'0') + ' — ' + s.tag + '</div>' +
    '<div class="dp-title">' + s.title + '</div>' +
    '<div class="dp-sub">' + s.subtitle + '</div>' +
    '<ul class="dp-points">' + s.points.map(p => '<li><span class="dp-dot"></span><span>' + p + '</span></li>').join('') + '</ul>' +
    '<div class="dp-note">' + s.note + '</div>';
}

function dpGo(dir) {
  dpCur = Math.max(0, Math.min(dpSteps.length - 1, dpCur + dir));
  dpRender();
  if (dir === 1 && dpCur === dpSteps.length - 1) {
    setTimeout(() => { if (confirm('Demo complete! Exit demo mode?')) toggleDemoPanel(); }, 300);
  }
}

document.addEventListener('keydown', e => {
  if (!dpOpen) return;
  if (e.key === 'ArrowRight') dpGo(1);
  if (e.key === 'ArrowLeft') dpGo(-1);
  if (e.key === 'Escape') toggleDemoPanel();
});

  window.addEventListener('message', function(e){
    if(!e.data || e.data.type !== 'EX3_DEMO') return;
    var d = e.data;
    if(d.action === 'showPhases') showPage('phases');
    if(d.action === 'openPhase'){
      showPage('phases');
      setTimeout(function(){
        var headers = document.querySelectorAll('.phase-header');
        if(headers[d.index]) headers[d.index].click();
      }, 300);
    }
  });
</script>
</body>
</html>`);
});

// ─── Implementation HQ ───────────────────────────────────────────────────────

const IMPL_HQ_PASSWORD = '4416';

function requireImplPassword(req, res, next) {
  const token = req.cookies?.impl_hq_auth;
  if (token === IMPL_HQ_PASSWORD) return next();
  if (req.method === 'POST' && req.body?.password === IMPL_HQ_PASSWORD) {
    res.setHeader('Set-Cookie', `impl_hq_auth=${IMPL_HQ_PASSWORD}; Path=/; HttpOnly`);
    return res.redirect('/consultant/implementation-hq');
  }
  const wrong = req.method === 'POST';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Implementation HQ — EX3</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#1B1040;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}
.gate{text-align:center;max-width:360px;padding:24px}
.logo{font-size:52px;font-weight:900;letter-spacing:-.15em;line-height:1;margin-bottom:4px;background:linear-gradient(135deg,#c4b5fd,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.portal-tag{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#6d5a9c;margin-bottom:44px}
.lock{font-size:36px;margin-bottom:20px}
.gate-title{font-size:24px;font-weight:700;margin-bottom:8px;letter-spacing:-.02em}
.gate-sub{font-size:13px;color:#7c6fac;margin-bottom:32px;line-height:1.6}
input[type=password]{width:100%;padding:14px 20px;background:#2d1f5e;border:1px solid #412288;border-radius:10px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:22px;letter-spacing:.5em;text-align:center;outline:none;transition:border-color .2s;margin-bottom:14px}
input[type=password]::placeholder{letter-spacing:0;font-size:13px;color:#5a4a8a}
input[type=password]:focus{border-color:#7c3aed;background:#3a2870}
button{width:100%;padding:14px;background:#412288;border:none;border-radius:10px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:600;cursor:pointer;transition:background .2s;letter-spacing:.03em}
button:hover{background:#5b21b6}
.err{color:#FF2E00;font-size:12px;margin-bottom:10px}
.back-link{display:block;margin-top:24px;font-size:12px;color:#5a4a8a;text-decoration:none;transition:color .2s}
.back-link:hover{color:#c4b5fd}
</style>
</head>
<body>
<div class="gate">
  <div class="logo">ex3</div>
  <div class="portal-tag">Consultant Portal</div>
  <div class="gate-title">Implementation HQ</div>
  <div class="gate-sub">Restricted to EX3 implementation consultants.</div>
  <form method="post" action="/consultant/implementation-hq">
    ${wrong ? '<div class="err">Incorrect password — try again</div>' : ''}
    <input type="password" name="password" placeholder="Enter access code" autofocus autocomplete="off"/>
    <button type="submit">Enter Implementation HQ →</button>
  </form>
  <a href="/consultant" class="back-link">← Back to Consultant Portal</a>
</div>
</body></html>`);
}

app.all('/consultant/implementation-hq', requireImplPassword);

app.get('/consultant/implementation-hq', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Implementation HQ — EX3</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#f8f7f4;color:#0f0f0e;line-height:1.65;font-size:14px}
a{color:inherit;text-decoration:none}
.layout{display:flex;min-height:100vh}
/* Sidebar — matches consultant portal exactly */
.sidebar{width:260px;flex-shrink:0;background:#0f0f0f;color:#fff;position:fixed;top:0;left:0;bottom:0;overflow-y:auto;display:flex;flex-direction:column}
.sb-brand{padding:24px 20px;border-bottom:1px solid #2a2a2a}
.sb-logo{font-size:36px;font-weight:900;letter-spacing:-.12em;line-height:1;color:#fff}
.sb-tag{font-size:11px;color:#888;letter-spacing:.08em;text-transform:uppercase;margin-top:4px}
.sb-back{display:flex;align-items:center;gap:6px;padding:12px 20px;font-size:12px;color:#888;border-bottom:1px solid #2a2a2a;cursor:pointer;transition:color .15s;text-decoration:none}
.sb-back:hover{color:#fff}
.sb-section{padding:16px 20px 4px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#555;font-weight:600}
.sb-item{display:block;padding:9px 20px;font-size:13px;color:#aaa;cursor:pointer;transition:all .15s;border-left:2px solid transparent}
.sb-item:hover{color:#fff;background:#1a1a1a}
.sb-item.active{color:#fff;border-left-color:#fff;background:#1a1a1a}
.sb-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;background:#333;color:#fff;margin-left:6px;vertical-align:middle}
/* Main */
.main{margin-left:260px;flex:1;padding:40px 48px;max-width:960px}
.page{display:none}.page.active{display:block}
/* Beginner banner */
.beginner-banner{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin-bottom:28px;display:flex;align-items:center;gap:14px}
.beginner-banner .icon{font-size:22px;flex-shrink:0}
.beginner-banner h3{font-size:14px;font-weight:700;color:#78350f;margin-bottom:2px}
.beginner-banner p{font-size:12px;color:#92400e}
/* Hero */
.hero{margin-bottom:36px}
.hero h1{font-size:30px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px;color:#0f0f0e}
.hero p{font-size:15px;color:#555;max-width:580px}
.hq-badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:16px}
.badge-violet{background:#f5f3ff;color:#4c1d95;border:1px solid #ddd6fe}
.badge-scarlet{background:#fff1f2;color:#9f1239;border:1px solid #fecdd3}
.badge-indigo{background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe}
.badge-green{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
.badge-amber{background:#fffbeb;color:#78350f;border:1px solid #fde68a}
/* Cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:32px}
.card{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:20px;transition:box-shadow .15s;cursor:pointer}
.card:hover{box-shadow:0 4px 16px rgba(0,0,0,.08)}
.card .num{font-size:28px;font-weight:700;color:#0f0f0f;margin-bottom:4px}
.card h3{font-size:14px;font-weight:600;margin-bottom:6px}
.card p{font-size:13px;color:#555}
/* Phase accordion */
.phase{background:#fff;border:1px solid #e4e2dc;border-radius:10px;margin-bottom:14px;overflow:hidden}
.phase-header{padding:16px 20px;display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none;transition:background .15s}
.phase-header:hover{background:#fafaf9}
.phase-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.phase-title{font-weight:600;font-size:15px;flex:1;color:#0f0f0e}
.phase-meta{font-size:12px;color:#888}
.phase-chevron{transition:transform .2s;color:#888}
.phase-body{display:none;padding:0 20px 24px;border-top:1px solid #f0eeea}
.phase-body.open{display:block}
/* Playbook steps */
.step-block{background:#f8f7f4;border:1px solid #e4e2dc;border-radius:10px;margin-top:14px;overflow:hidden}
.step-header{padding:12px 16px;background:#0f0f0f;display:flex;align-items:center;gap:10px}
.step-num{width:24px;height:24px;border-radius:50%;background:#fff;color:#0f0f0f;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.step-title{font-size:13px;font-weight:600;color:#fff}
.step-body{padding:14px 16px;display:grid;gap:10px}
.step-section .label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#888;margin-bottom:5px}
.step-section p,.step-section li{font-size:13px;color:#333;line-height:1.65}
.step-section ul{padding-left:16px}
.step-section li{margin-bottom:3px}
.warn{background:#fff5f5;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;font-size:13px;color:#7f1d1d;margin-top:8px}
.warn strong{color:#dc2626}
.say{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;font-size:13px;color:#1e3a5f;font-style:italic;margin-top:8px}
.tip-hq{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;font-size:13px;color:#14532d;margin-top:8px}
/* Section titles */
h2.sec{font-size:22px;font-weight:700;margin-bottom:6px;letter-spacing:-.01em}
p.sec-sub{font-size:14px;color:#555;margin-bottom:24px}
/* Table */
table.hq{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4e2dc;border-radius:10px;overflow:hidden;margin-bottom:20px}
table.hq th{background:#0f0f0f;color:#fff;padding:10px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:.04em}
table.hq td{padding:10px 14px;border-bottom:1px solid #f0eeea;font-size:13px;color:#333}
table.hq tr:last-child td{border-bottom:none}
/* Timeline */
.timeline-wrap{overflow-x:auto;padding-bottom:16px;margin-bottom:24px}
.timeline{display:flex;gap:0;min-width:max-content;padding:20px 0}
.tl-phase-group{display:flex;flex-direction:column;gap:0;margin-right:10px}
.tl-phase-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:5px 10px;border-radius:6px 6px 0 0;text-align:center;color:#fff}
.tl-steps{display:flex;gap:4px;padding:8px;border-radius:0 0 8px 8px;border:1px solid #e4e2dc;border-top:none;background:#fafaf9}
.tl-step{min-width:106px;padding:10px 8px;border-radius:6px;cursor:pointer;transition:all .2s;text-align:center;border:1px solid #e4e2dc;background:#fff}
.tl-step:hover,.tl-step.active{transform:translateY(-3px);box-shadow:0 4px 14px rgba(0,0,0,.12);z-index:2}
.tl-step-title{font-size:11px;font-weight:600;color:#0f0f0e;line-height:1.3}
.tl-detail{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:20px;margin-bottom:16px;display:none}
.tl-detail.visible{display:block}
.tl-detail h3{font-size:16px;font-weight:700;color:#0f0f0e;margin-bottom:12px}
.tl-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.tl-detail-item .label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#888;margin-bottom:4px}
.tl-detail-item p{font-size:13px;color:#333}
/* Doc vault */
.doc-category{margin-bottom:28px}
.doc-category h3{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#555;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #e4e2dc}
.doc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.doc-item{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:14px 16px;transition:box-shadow .15s;display:flex;align-items:flex-start;gap:12px}
.doc-item:hover{box-shadow:0 2px 8px rgba(0,0,0,.08)}
.doc-icon{font-size:18px;flex-shrink:0;margin-top:1px}
.doc-info h4{font-size:13px;font-weight:600;color:#0f0f0e;margin-bottom:3px}
.doc-info p{font-size:11px;color:#888;line-height:1.4}
.doc-link{display:inline-flex;align-items:center;gap:4px;margin-top:6px;font-size:11px;color:#412288;font-weight:600;transition:color .15s}
.doc-link:hover{color:#5b21b6}
/* Gotcha library */
.gotcha-search{width:100%;padding:12px 16px;background:#fff;border:1px solid #e4e2dc;border-radius:10px;color:#0f0f0e;font-family:'Inter',system-ui,sans-serif;font-size:13px;margin-bottom:16px;outline:none;transition:border-color .2s}
.gotcha-search:focus{border-color:#0f0f0f}
.gotcha-search::placeholder{color:#aaa}
.gotcha-item{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:14px 16px;margin-bottom:8px;transition:box-shadow .15s}
.gotcha-item:hover{box-shadow:0 2px 8px rgba(0,0,0,.08)}
.gotcha-item .g-header{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.gotcha-item .g-phase{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border-radius:4px}
.gotcha-item .g-title{font-size:13px;font-weight:700;color:#0f0f0e}
.gotcha-item .g-detail{font-size:13px;color:#555;line-height:1.6}
/* Integration wizard */
.int-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.int-tab{padding:8px 16px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid #e4e2dc;background:#fff;color:#555;transition:all .15s;font-family:'Inter',system-ui,sans-serif}
.int-tab:hover{border-color:#0f0f0f;color:#0f0f0e}
.int-tab.active{background:#0f0f0f;color:#fff;border-color:#0f0f0f}
.int-content{display:none}.int-content.active{display:block}
.int-section{margin-bottom:20px}
.int-section h3{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#555;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e4e2dc}
.int-step{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #f0eeea}
.int-step:last-child{border-bottom:none}
.int-step-num{width:22px;height:22px;border-radius:50%;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px}
.int-step p{font-size:13px;color:#333;line-height:1.6}
.checklist-hq{list-style:none}
.checklist-hq li{display:flex;align-items:flex-start;gap:8px;padding:6px 0;font-size:13px;color:#333;border-bottom:1px solid #f0eeea}
.checklist-hq li:last-child{border-bottom:none}
.checklist-hq li::before{content:'☐';font-size:14px;flex-shrink:0;color:#aaa}
/* AI Coach */
.ai-fab{position:fixed;bottom:28px;right:28px;z-index:9000;background:#0f0f0f;color:#fff;border:none;border-radius:50px;padding:13px 22px;font-family:'Inter',system-ui,sans-serif;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.25);transition:all .2s;display:flex;align-items:center;gap:8px}
.ai-fab:hover{background:#333;transform:translateY(-2px)}
.ai-panel{position:fixed;bottom:0;right:0;width:400px;height:100vh;background:#0f0f0f;border-left:1px solid #2a2a2a;z-index:8999;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .3s cubic-bezier(.4,0,.2,1)}
.ai-panel.open{transform:translateX(0)}
.ai-header{padding:16px 20px;border-bottom:1px solid #2a2a2a;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.ai-title{font-size:14px;font-weight:700;color:#fff}
.ai-close{background:none;border:none;color:#888;font-size:20px;cursor:pointer;transition:color .15s;line-height:1}
.ai-close:hover{color:#fff}
.ai-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.ai-msg{max-width:85%;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6}
.ai-msg.user{background:#333;color:#fff;align-self:flex-end;border-bottom-right-radius:3px}
.ai-msg.assistant{background:#1a1a1a;color:#ccc;border:1px solid #2a2a2a;align-self:flex-start;border-bottom-left-radius:3px}
.ai-msg.assistant strong{color:#fff}
.ai-quick{padding:12px 16px;border-top:1px solid #2a2a2a;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0}
.ai-quick-btn{padding:6px 12px;border-radius:6px;font-size:11px;font-weight:600;border:1px solid #2a2a2a;background:#1a1a1a;color:#aaa;cursor:pointer;transition:all .15s;font-family:'Inter',system-ui,sans-serif}
.ai-quick-btn:hover{border-color:#fff;color:#fff}
.ai-input-row{padding:12px 16px;border-top:1px solid #2a2a2a;display:flex;gap:8px;flex-shrink:0}
.ai-input{flex:1;padding:10px 14px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:13px;outline:none;transition:border-color .2s;resize:none}
.ai-input:focus{border-color:#555}
.ai-send{padding:10px 16px;background:#fff;border:none;border-radius:8px;color:#0f0f0f;font-family:'Inter',system-ui,sans-serif;font-size:13px;font-weight:700;cursor:pointer;transition:background .15s;flex-shrink:0}
.ai-send:hover{background:#e5e5e5}
.ai-send:disabled{opacity:.4;cursor:not-allowed}
/* Questionnaire */
.q-card{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:24px;margin-bottom:16px}
.q-num{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#888;margin-bottom:8px}
.q-text{font-size:16px;font-weight:700;color:#0f0f0e;margin-bottom:16px;letter-spacing:-.01em}
.q-options{display:flex;flex-direction:column;gap:8px}
.q-opt{padding:12px 16px;border:1px solid #e4e2dc;border-radius:8px;cursor:pointer;transition:all .15s;font-size:13px;color:#555;background:#fff}
.q-opt:hover{border-color:#0f0f0f;color:#0f0f0e;background:#fafaf9}
.q-opt.sel{border-color:#0f0f0f;background:#0f0f0f;color:#fff;font-weight:600}
.q-result{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:24px;margin-bottom:24px;display:none}
.q-result.visible{display:block}
.q-result h2{font-size:20px;font-weight:700;color:#0f0f0e;margin-bottom:8px}
.q-result p{font-size:13px;color:#333;margin-bottom:12px;line-height:1.6}
.q-result .nav-btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;background:#0f0f0f;border:none;border-radius:8px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:background .2s;margin-right:8px;margin-top:4px}
.q-result .nav-btn:hover{background:#333}
</style>
</head>
<body>
<div class="layout">

<!-- Sidebar -->
<nav class="sidebar">
  <div class="sb-brand">
    <div class="sb-logo">ex3</div>
    <div class="sb-tag">Implementation HQ</div>
  </div>
  <a href="/consultant" class="sb-back">
    <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
    Back to Consultant Portal
  </a>
  <div class="sb-section">Start Here</div>
  <div class="sb-item active" onclick="showPage('dashboard')">Dashboard</div>
  <div class="sb-section">Core Tools</div>
  <div class="sb-item" onclick="showPage('timeline')">Implementation Timeline</div>
  <div class="sb-item" onclick="showPage('playbooks')">Phase Playbooks</div>
  <div class="sb-item" onclick="showPage('vault')">Document Vault <span class="sb-badge">60</span></div>
  <div class="sb-section">Reference</div>
  <div class="sb-item" onclick="showPage('gotchas')">Gotcha Library</div>
  <div class="sb-item" onclick="showPage('integrations')">Integration Wizard</div>
</nav>

<!-- Main -->
<main class="main">

<!-- DASHBOARD -->
<div class="page active" id="page-dashboard">
  <div id="beginner-banner" class="beginner-banner" style="display:none">
    <div><h3>Beginner Mode Active</h3><p>Extra guidance and warnings are shown throughout based on your answers.</p></div>
  </div>
  <div class="hero">
    <span class="hq-badge badge-violet">Implementation HQ</span>
    <h1>Implementation Command Centre</h1>
    <p>Everything you need to deliver a flawless SmartRecruiters implementation — playbooks, documents, gotchas, and an AI coach built from 60 source documents.</p>
  </div>

  <div id="q-result" class="q-result">
    <h2 id="q-result-title">Your Profile</h2>
    <p id="q-result-body"></p>
    <button class="nav-btn" onclick="showPage('playbooks')">Go to Phase Playbooks →</button>
    <button class="nav-btn" onclick="showPage('timeline')">View Timeline →</button>
  </div>

  <h2 class="sec">Orientation Questionnaire</h2>
  <p class="sec-sub">Answer four quick questions so we can direct you to the right starting point.</p>

  <div class="q-card">
    <div class="q-num">Question 1 of 4</div>
    <div class="q-text">Have you done a SmartRecruiters implementation before?</div>
    <div class="q-options">
      <div class="q-opt" onclick="selectQ(this,1,'yes','Experienced')">Yes — I've done at least one end to end</div>
      <div class="q-opt" onclick="selectQ(this,1,'partial','Developing')">Partially — I've been involved but not led one</div>
      <div class="q-opt" onclick="selectQ(this,1,'no','New')">No — this is my first time</div>
    </div>
  </div>

  <div class="q-card">
    <div class="q-num">Question 2 of 4</div>
    <div class="q-text">Do you have a signed SOW for this project?</div>
    <div class="q-options">
      <div class="q-opt" onclick="selectQ(this,2,'yes','SOW signed')">Yes — it's signed and I've read it</div>
      <div class="q-opt" onclick="selectQ(this,2,'notyet','SOW not yet signed')">Not yet — we're pre-sales or in proposal stage</div>
      <div class="q-opt" onclick="selectQ(this,2,'no','No SOW')">No — we're starting without one</div>
    </div>
  </div>

  <div class="q-card">
    <div class="q-num">Question 3 of 4</div>
    <div class="q-text">Which phase are you currently in?</div>
    <div class="q-options">
      <div class="q-opt" onclick="selectQ(this,3,'notstarted','Not started yet')">Not started yet — haven't kicked off</div>
      <div class="q-opt" onclick="selectQ(this,3,'discovery','Discovery')">Discovery / Workshops</div>
      <div class="q-opt" onclick="selectQ(this,3,'config','Config / Build')">Configuration or Build</div>
      <div class="q-opt" onclick="selectQ(this,3,'uat','UAT')">UAT (testing)</div>
      <div class="q-opt" onclick="selectQ(this,3,'training','Training')">Training</div>
      <div class="q-opt" onclick="selectQ(this,3,'golive','Go-Live / Hypercare')">Go-Live or Hypercare</div>
    </div>
  </div>

  <div class="q-card">
    <div class="q-num">Question 4 of 4</div>
    <div class="q-text">How confident do you feel about this implementation?</div>
    <div class="q-options">
      <div class="q-opt" onclick="selectQ(this,4,'new','Completely new — need full guidance')">Completely new — I need step-by-step guidance for everything</div>
      <div class="q-opt" onclick="selectQ(this,4,'some','Some experience — mainly need the detail')">Some experience — I know the shape, I need the detail</div>
      <div class="q-opt" onclick="selectQ(this,4,'confident','Confident — using this as a reference')">Confident — I'm using this as a reference tool</div>
    </div>
  </div>

  <button onclick="submitQuestionnaire()" style="padding:13px 28px;background:#0f0f0f;border:none;border-radius:10px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:600;cursor:pointer;transition:background .2s;margin-top:8px">
    Set my profile →
  </button>

  <div style="margin-top:48px">
    <h2 class="sec">Quick Access</h2>
    <div class="cards">
      <div class="card" style="cursor:pointer" onclick="showPage('playbooks')"><div class="num">6</div><h3>Phase Playbooks</h3><p>Fully spoon-fed guides for every phase</p></div>
      <div class="card" style="cursor:pointer" onclick="showPage('vault')"><div class="num">60</div><h3>Documents</h3><p>Every implementation file with Drive links</p></div>
      <div class="card" style="cursor:pointer" onclick="showPage('gotchas')"><div class="num">19</div><h3>Gotchas</h3><p>Real pitfalls extracted from source documents</p></div>
      <div class="card" style="cursor:pointer" onclick="showPage('integrations')"><div class="num">7</div><h3>Integrations</h3><p>Step-by-step setup wizards</p></div>
    </div>
  </div>
</div>

<!-- TIMELINE -->
<div class="page" id="page-timeline">
  <div class="hero">
    <span class="hq-badge badge-violet">Timeline</span>
    <h1>Implementation Timeline</h1>
    <p>Every step from Sales Handover to Hypercare Close. Click any step to expand the full detail.</p>
  </div>

  <div id="tl-detail-panel" class="tl-detail">
    <h3 id="tl-detail-title"></h3>
    <div class="tl-detail-grid">
      <div class="tl-detail-item"><div class="label">What happens</div><p id="tl-what"></p></div>
      <div class="tl-detail-item"><div class="label">Who's involved</div><p id="tl-who"></p></div>
      <div class="tl-detail-item"><div class="label">Document to have open</div><p id="tl-doc"></p></div>
      <div class="tl-detail-item"><div class="label">Output / deliverable</div><p id="tl-output"></p></div>
    </div>
  </div>

  <div class="timeline-wrap">
    <div class="timeline" id="tl-root"></div>
  </div>
  <p style="font-size:12px;color:#aaa;margin-top:-12px">← Scroll horizontally to see full journey</p>
</div>

<!-- PLAYBOOKS (content added in next pass) -->
<div class="page" id="page-playbooks">
  <div id="pb-beginner-tip" class="warn" style="display:none;margin-bottom:24px"><strong>Beginner Mode:</strong> Extra warnings and guidance are shown throughout these playbooks. Read everything — don't skip the "What can go wrong" sections.</div>
  <div class="hero">
    <span class="hq-badge badge-violet">Phase Playbooks</span>
    <h1>Phase Playbooks</h1>
    <p>Exactly what to do, what to say, what to ask, what to prepare, and what can go wrong — for every phase.</p>
  </div>
  <div id="playbooks-content"></div>
</div>

<!-- DOCUMENT VAULT (content added in next pass) -->
<div class="page" id="page-vault">
  <div class="hero">
    <span class="hq-badge badge-indigo">Document Vault</span>
    <h1>Document Vault</h1>
    <p>All 60 implementation documents organised by phase. Every file links directly to Google Drive.</p>
  </div>
  <p style="font-size:13px;color:#555;margin-bottom:20px">
    <a href="https://drive.google.com/drive/folders/1p4Y2PVaBGXOvYdkhldrJrhbYWO6xV_gD" target="_blank" style="color:#412288;font-weight:600">📁 Open full Drive folder →</a>
  </p>
  <div id="vault-content"></div>
</div>

<!-- GOTCHA LIBRARY (content added in next pass) -->
<div class="page" id="page-gotchas">
  <div class="hero">
    <span class="hq-badge badge-scarlet">Gotcha Library</span>
    <h1>Gotcha Library</h1>
    <p>Real implementation pitfalls extracted from source documents. Search by keyword or filter by phase.</p>
  </div>
  <input class="gotcha-search" type="text" id="gotcha-search" placeholder="Search gotchas..." oninput="filterGotchas(this.value)"/>
  <div id="gotcha-phase-filters" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px"></div>
  <div id="gotchas-list"></div>
</div>

<!-- INTEGRATION WIZARD (content added in next pass) -->
<div class="page" id="page-integrations">
  <div class="hero">
    <span class="hq-badge badge-green">Integration Wizard</span>
    <h1>Integration Setup Wizard</h1>
    <p>Step-by-step setup guides for the most common SmartRecruiters integrations — pre-flight checklist, steps, and what to test.</p>
  </div>
  <div class="int-tabs" id="int-tabs"></div>
  <div id="int-contents"></div>
</div>

</main>
</div>

<!-- AI COACH FAB -->
<button class="ai-fab" id="ai-fab" onclick="toggleAI()">
  <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  AI Coach
</button>

<div class="ai-panel" id="ai-panel">
  <div class="ai-header">
    <div class="ai-title">EX3 Implementation Coach</div>
    <button class="ai-close" onclick="toggleAI()">×</button>
  </div>
  <div class="ai-messages" id="ai-messages">
    <div class="ai-msg assistant">Hi! I'm your EX3 Implementation Coach. I have deep knowledge of SmartRecruiters implementations — gotchas, config limits, integration pitfalls, UAT steps, and more. What do you need help with?</div>
  </div>
  <div class="ai-quick">
    <button class="ai-quick-btn" onclick="aiQuick('Walk me through a full implementation from scratch')">From scratch</button>
    <button class="ai-quick-btn" onclick="aiQuick('I am stuck on integrations — help me debug')">Stuck on integrations</button>
    <button class="ai-quick-btn" onclick="aiQuick('Help me prepare for UAT')">Prep for UAT</button>
    <button class="ai-quick-btn" onclick="aiQuick('What are the biggest gotchas I need to know?')">Biggest gotchas</button>
  </div>
  <div class="ai-input-row">
    <textarea class="ai-input" id="ai-input" rows="2" placeholder="Ask anything about your implementation..." onkeydown="aiKeydown(event)"></textarea>
    <button class="ai-send" id="ai-send" onclick="aiSend()">Send</button>
  </div>
</div>

<script>
// ── Page navigation ──────────────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  const items = document.querySelectorAll('.sb-item');
  items.forEach(i => { if (i.getAttribute('onclick') && i.getAttribute('onclick').includes("'" + id + "'")) i.classList.add('active'); });
  window.scrollTo(0,0);
}

// ── Questionnaire ────────────────────────────────────────────────
const answers = {};
function selectQ(el, q, val, label) {
  answers[q] = { val, label };
  el.closest('.q-card').querySelectorAll('.q-opt').forEach(o => o.classList.remove('sel'));
  el.classList.add('sel');
}
function submitQuestionnaire() {
  const beginner = (answers[1] && answers[1].val === 'no') || (answers[4] && answers[4].val === 'new');
  const noSOW = answers[2] && answers[2].val === 'no';
  const phase = answers[3] ? answers[3].label : 'Not specified';
  const exp = answers[1] ? answers[1].label : 'Not specified';
  const banner = document.getElementById('beginner-banner');
  const pbTip = document.getElementById('pb-beginner-tip');
  if (beginner) { banner.style.display = 'flex'; pbTip.style.display = 'block'; }
  let title = 'Your Implementation Profile';
  let body = 'Based on your answers: ';
  body += 'Experience level: <strong>' + exp + '</strong>. ';
  body += 'Current phase: <strong>' + phase + '</strong>. ';
  if (noSOW) body += '<strong style="color:#dc2626">⚠ Warning: No SOW — this is risky. Make sure scope is documented before doing any build work.</strong> ';
  if (beginner) body += 'Beginner Mode is active — extra guidance is shown throughout. ';
  body += 'Jump straight to the Phase Playbooks to get started, or use the AI Coach (bottom right) to ask anything.';
  const resultEl = document.getElementById('q-result');
  document.getElementById('q-result-title').textContent = title;
  document.getElementById('q-result-body').innerHTML = body;
  resultEl.classList.add('visible');
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Timeline data ─────────────────────────────────────────────────
const tlPhases = [
  { label: 'Pre-Project', color: '#374151', bg: '#1f2937',
    steps: [
      { title: 'Sales Handover', what: 'Sales team hands over to implementation. Review the CRM notes, signed SOW, and any pre-sales promises made.', who: 'EX3 Consultant + Sales', doc: 'Signed SOW + CRM notes', output: 'Consultant fully briefed, project set up in PM tool' },
      { title: 'Internal Kickoff', what: 'Internal EX3 prep — set up project tracking, read the SOW line by line, flag any ambiguous scope items before client contact.', who: 'EX3 Consultant (+ PM)', doc: 'SOW, Config Workbook (blank)', output: 'Project plan drafted, kickoff call booked, questionnaire sent' },
    ]
  },
  { label: 'Kickoff', color: '#5b21b6', bg: '#2d1f5e',
    steps: [
      { title: 'Welcome Kickoff Call', what: 'First call with the client. Introductions, review scope, confirm stakeholders, set expectations for the project.', who: 'EX3 Consultant + Client HR, IT, Lead Recruiter', doc: 'Welcome Kickoff deck, SOW', output: 'Stakeholder map, shared project channel/space set up' },
      { title: 'Planning Meeting', what: 'Agree timeline, book discovery workshops, confirm who attends which sessions, agree on sign-off process.', who: 'EX3 Consultant + Client Project Owner', doc: 'Planning Meeting Agenda, Project Management Plan', output: 'Confirmed workshop schedule, RACI agreed, project plan shared' },
    ]
  },
  { label: 'Discovery', color: '#1d4ed8', bg: '#1e3a8a',
    steps: [
      { title: 'WS1: System Controls', what: 'Map user roles, permissions, system access, SSO requirements, and company structure.', who: 'Consultant + HR Admin, IT', doc: 'Session 1 deck, Config Workbook', output: 'User roles defined, SSO decision made, company structure documented' },
      { title: 'WS2: Job Management', what: 'Map job creation process, approval chains, job templates, custom fields, and posting workflow.', who: 'Consultant + Lead Recruiter, HR', doc: 'Session 2 deck, Config Workbook', output: 'Job templates defined, approval chain mapped, custom fields listed' },
      { title: 'WS3: Integrations', what: 'Identify all integrations needed: HRIS, background check, onboarding, LinkedIn, calendar.', who: 'Consultant + IT, HR', doc: 'Session 3 deck, Integrations Workbook', output: 'Integration matrix confirmed, IT contacts identified, timelines agreed' },
      { title: 'WS4: Career Site', what: 'Agree career site design, branding, application flow, and job board connections.', who: 'Consultant + Marketing/Brand, HR', doc: 'Session 4 deck', output: 'Career site requirements doc, brand assets requested' },
      { title: 'WS5: Candidate Mgmt 1', what: 'Map candidate pipeline stages, hiring process steps, interviewer roles, and feedback forms.', who: 'Consultant + Lead Recruiter, Hiring Managers', doc: 'Session 5 deck, Config Workbook', output: 'Hiring process designs for each job type' },
      { title: 'WS6: Candidate Mgmt 2', what: 'Deep dive into offer management, offer approvals, contracts, and rejection communications.', who: 'Consultant + HR, Finance (if offer approvals involve budget)', doc: 'Session 6 deck', output: 'Offer approval chains, offer letter templates spec' },
      { title: 'WS7: Offer & Hiring', what: 'Review onboarding trigger, hire confirmation, and handover to onboarding system.', who: 'Consultant + HR, IT', doc: 'Session 7 deck, Config Workbook', output: 'Hiring/onboarding handoff process documented' },
      { title: 'WS8: Analytics', what: 'Agree on reporting requirements, key metrics, and dashboard configuration.', who: 'Consultant + HR Director, Talent Lead', doc: 'Session 8 deck', output: 'Reporting requirements list, standard vs custom analytics agreed' },
    ]
  },
  { label: 'Config', color: '#0f766e', bg: '#134e4a',
    steps: [
      { title: 'Config Workbook Review', what: 'Validate the completed config workbook with the client before building anything. Every field matters.', who: 'Consultant + Client Project Owner', doc: 'Configuration Workbook', output: 'Signed-off config workbook' },
      { title: 'System Build', what: 'Build the platform: users, roles, hiring processes, job templates, email templates, offer templates.', who: 'EX3 Consultant', doc: 'Config Workbook, Best Practices guide', output: 'Configured sandbox environment' },
    ]
  },
  { label: 'Build', color: '#065f46', bg: '#064e3b',
    steps: [
      { title: 'Integration Build', what: 'Set up all agreed integrations — HRIS, SSO, background check, LinkedIn, calendar. Involve client IT.', who: 'Consultant + Client IT', doc: 'Integrations Workbook', output: 'All integrations built and ready for testing' },
      { title: 'Career Site Build', what: 'Brand the career site, configure the application form, set up job board connections.', who: 'EX3 Consultant (+ Marketing assets from client)', doc: 'Career site requirements doc', output: 'Career site live in sandbox, job boards connected' },
      { title: 'Integration Testing', what: 'End-to-end testing of every integration with real test data. Document pass/fail for each.', who: 'Consultant + Client IT', doc: 'Integrations Workbook', output: 'Integration test report, all critical issues resolved' },
    ]
  },
  { label: 'UAT', color: '#b45309', bg: '#451a03',
    steps: [
      { title: 'UAT Preparation', what: 'Prepare UAT test scripts per role, brief the client team, set up the issue tracker.', who: 'EX3 Consultant + Client Project Owner', doc: 'UAT Prep doc, UAT Scripts', output: 'UAT scripts shared, client team briefed, issue tracker live' },
      { title: 'UAT Execution', what: 'Client runs through test scripts. EX3 supports, logs issues, and triages fixes.', who: 'Client HR, IT, Recruiters, Hiring Managers — supported by Consultant', doc: 'UAT Scripts, Issue tracker', output: 'Issue log with all findings' },
      { title: 'UAT Sign-off', what: 'All critical issues resolved. Client provides written sign-off to confirm the platform is ready for go-live.', who: 'Client Project Owner + Consultant', doc: 'Iteration Sign-off doc', output: 'Signed UAT sign-off document' },
    ]
  },
  { label: 'Training', color: '#0d7c4c', bg: '#064e3b',
    steps: [
      { title: 'Admin Training', what: '90-minute session covering configuration, user management, reporting, and system administration.', who: 'Consultant + Client System Admins', doc: 'Admin Training Guide', output: 'Admins trained, recording shared' },
      { title: 'Recruiter Training', what: '60-minute session covering full hiring workflow, candidate management, and reporting.', who: 'Consultant + Client Recruiters', doc: 'HR/Recruiter Training Guide', output: 'Recruiters trained, Quick Reference Card shared' },
      { title: 'HM Training', what: '45-minute session covering review, approval, interview scheduling, and offer decisions.', who: 'Consultant + Hiring Managers', doc: 'HM Training Guide, HM Quick Reference Card', output: 'HMs trained, Quick Reference Card shared' },
    ]
  },
  { label: 'Go-Live', color: '#b91c1c', bg: '#450a0a',
    steps: [
      { title: 'Go-Live Alignment', what: 'Final check call the day before go-live. Confirm everything is ready, agree on communication plan.', who: 'Consultant + Client Project Owner + IT', doc: 'Go-Live Alignment Call Overview, Go-Live Checklist', output: 'Green light confirmed, go-live comms ready to send' },
      { title: 'Go-Live Day', what: 'Production environment activated. Users get access. EX3 on standby for any critical issues.', who: 'EX3 Consultant (on standby) + all client users', doc: 'Go-Live Checklist, Cutover Plan', output: 'System live in production' },
    ]
  },
  { label: 'Hypercare', color: '#d97706', bg: '#451a03',
    steps: [
      { title: 'Hypercare Week 1', what: 'Daily check-in calls. Log and resolve any issues immediately. Most critical period.', who: 'Consultant + Client Project Owner', doc: 'Hypercare Tracker', output: 'Issues resolved, confidence building' },
      { title: 'Hypercare Wk 2–4', what: 'Weekly check-ins. Issues become less frequent. Build client self-sufficiency.', who: 'Consultant + Client HR', doc: 'Hypercare Tracker', output: 'Issue log closed, client increasingly self-sufficient' },
      { title: 'Closing Meeting', what: 'Formal close-out meeting. Review project vs scope, lessons learned, hand to BAU support.', who: 'Consultant + Client Project Owner + EX3 Account Lead', doc: 'Closing Meeting doc, Lessons Learned log', output: 'Project formally closed, client handed to support' },
    ]
  },
];

function buildTimeline() {
  const root = document.getElementById('tl-root');
  tlPhases.forEach(phase => {
    const group = document.createElement('div');
    group.className = 'tl-phase-group';
    group.style.marginRight = '12px';
    const label = document.createElement('div');
    label.className = 'tl-phase-label';
    label.textContent = phase.label;
    label.style.background = phase.bg;
    label.style.color = '#e2dff7';
    label.style.border = '1px solid ' + phase.color;
    group.appendChild(label);
    const stepsRow = document.createElement('div');
    stepsRow.className = 'tl-steps';
    stepsRow.style.background = phase.bg + '44';
    stepsRow.style.borderColor = phase.color + '44';
    phase.steps.forEach(step => {
      const el = document.createElement('div');
      el.className = 'tl-step';
      el.style.background = phase.bg;
      el.style.borderColor = phase.color;
      el.innerHTML = '<div class="tl-step-title">' + step.title + '</div>';
      el.onclick = () => showTlDetail(step, phase.label, phase.color, el);
      stepsRow.appendChild(el);
    });
    group.appendChild(stepsRow);
    root.appendChild(group);
  });
}

let activeTlStep = null;
function showTlDetail(step, phaseLabel, color, el) {
  if (activeTlStep) activeTlStep.classList.remove('active');
  if (activeTlStep === el) { activeTlStep = null; document.getElementById('tl-detail-panel').classList.remove('visible'); return; }
  activeTlStep = el;
  el.classList.add('active');
  document.getElementById('tl-detail-title').textContent = step.title + ' — ' + phaseLabel;
  document.getElementById('tl-detail-title').style.color = '#c4b5fd';
  document.getElementById('tl-what').textContent = step.what;
  document.getElementById('tl-who').textContent = step.who;
  document.getElementById('tl-doc').textContent = step.doc;
  document.getElementById('tl-output').textContent = step.output;
  const panel = document.getElementById('tl-detail-panel');
  panel.classList.add('visible');
  panel.style.borderColor = color;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

buildTimeline();

// ── Playbooks data ────────────────────────────────────────────────
const playbooks = [
  { num:1, color:'#412288', title:'Sales Handover & Kickoff Prep', weeks:'Before Day 1', steps:[
    { title:'Read the SOW — every line', what:'The SOW is your contract. Understand exactly what is in scope, what is out, how many processes/templates/users are included, and what the hypercare period is.', say:"I've reviewed the SOW in detail and I have a few questions before we meet the client.", ask:['Is there a data migration?','Any integrations not explicitly named?','Were any verbal promises made outside the SOW?','What is the client most worried about?'], prepare:['Signed SOW','CRM / sales notes','Blank config workbook'], output:'List of SOW clarifications raised and answered before kickoff call', warn:'Never start building until you have a signed SOW. If scope is vague, escalate immediately — vague scope becomes scope creep.' },
    { title:'Set up project infrastructure', what:'Create project in PM tool, set up shared folder, draft the project plan, book the welcome kickoff call, send the pre-kickoff questionnaire to the client.', say:"I'm reaching out ahead of our kickoff call to share a short questionnaire — your answers will help us hit the ground running.", ask:['Who is the internal project owner?','Who attends the kickoff?','What is the preferred comms channel?'], prepare:['Project plan template','Pre-kickoff questionnaire'], output:'Project plan v1 shared, kickoff booked, questionnaire sent', warn:'If you cannot identify a single decision-maker on the client side, raise it before kickoff. No decision-maker = stalled project.' },
  ]},
  { num:2, color:'#1d4ed8', title:'Welcome Kickoff & Planning Meeting', weeks:'Week 1', steps:[
    { title:'Welcome Kickoff Call', what:'Introductions, review the SOW scope together, confirm the project team, set communication norms, explain what happens next.', say:"We're really excited to get started. My role is to guide you through every step — you'll always know what's coming next and why.", ask:['Who makes the final decision on hiring process design?','Who owns the technical side — SSO and integrations?','What does success look like for you at the end of this?'], prepare:['Welcome Kickoff deck','SOW'], output:'Shared understanding of scope, named decision-makers confirmed', warn:"Don't let the kickoff drift into discovery. Keep it to introductions and logistics — save the detail for workshops." },
    { title:'Implementation Planning Meeting', what:'Agree the full workshop schedule, confirm attendees for each session, agree on sign-off process, set timeline milestones.', say:"For each workshop I need the right people in the room — I'll send a guide on who should attend what.", ask:['Is the proposed timeline realistic given key people availability?','Are there any immovable dates — holidays, freeze periods?','Who signs off at each phase gate?'], prepare:['Planning Meeting Agenda','RACI template','Workshop Planning doc'], output:'Confirmed workshop schedule, RACI agreed, project plan v2 with real dates', warn:'Never agree a go-live date at the planning meeting. Get through discovery first — you will find complexity that changes the timeline.' },
  ]},
  { num:3, color:'#065f46', title:'Discovery Workshops (8 Sessions)', weeks:'Weeks 2–4', steps:[
    { title:'WS1 — System Controls & User Permissions', what:'Map the org structure, user roles, permission levels, SSO requirements, and system access needs.', say:"There are no wrong answers in discovery — I need to understand how you work today before we design how you'll work in SmartRecruiters.", ask:['How many admins will you have?','Do different business units need different access?','Do you require SSO? If so, which IdP?','Any compliance requirements around user access?'], prepare:['Session 1 deck','Config Workbook — Roles tab'], output:'User role matrix, org structure, SSO decision documented', warn:'Maximum 10 custom system roles. If clients want more, challenge whether they really need them before designing a complex role structure.' },
    { title:'WS2 — Job Management', what:'Map job creation, approval chains, custom fields, job templates, and how jobs are categorised.', say:"Let's walk through a real job you posted recently — that will tell us more than any hypothetical.", ask:['Who creates jobs? Who approves them?','Do different job types need different approval chains?','What custom fields do you capture that are not standard?','Do you track headcount or positions in an HRIS?'], prepare:['Session 2 deck','Config Workbook — Jobs tab'], output:'Job template designs, approval chain map, custom fields list', warn:'Job approvals being turned on prevents population of position/headcount info — known SR bug. Document the workaround upfront if they need both.' },
    { title:'WS3 — Functional Integrations', what:'Identify all integrations, confirm technical contacts, agree on ownership, and set realistic timeline for integration work.', say:"Integrations are where timelines slip — not because they are complex, but because getting IT in the room takes time. Let's lock that in now.", ask:['Which HRIS system do you use? What version?','Do you use a background screening provider?','Do you need LinkedIn Recruiter seat integration?','What calendar system — Office 365 or Google?'], prepare:['Session 3 deck','Integrations Workbook'], output:'Integration matrix — what, who owns it, when', warn:'Never create items manually in production when an integration is in scope — the integration will not match them and will fail. Tell the client this clearly.' },
    { title:'WS4 — Career Site & Applications', what:'Agree career site design, branding, application form, and job board connections.', say:"Your career site is the first thing a candidate sees — it needs to reflect your employer brand, not look like an out-of-the-box ATS.", ask:['Do you have brand guidelines you can share?','Who owns the career site content — HR or Marketing?','Do you need multi-language support?'], prepare:['Session 4 deck','Brand assets request list'], output:'Career site requirements doc, brand assets requested', warn:'Email templates cannot be triggered purely by job ad language — you need org fields to drive language routing for multi-language clients.' },
    { title:'WS5–6 — Candidate Management', what:'Map candidate pipeline stages, hiring process steps for each job type, feedback forms, and rejection communications.', say:"For each different type of role you hire, walk me through the stages a candidate goes through from application to offer.", ask:['Do different job types have different hiring processes?','Who can see candidate profiles?','What information do you collect in structured feedback?','How do you handle internal candidates?'], prepare:['Sessions 5 & 6 decks','Config Workbook — Hiring Processes tab'], output:'Hiring process designs for each job type, feedback form spec', warn:'Maximum 120 hiring processes, maximum 8 steps per status. Design for consolidation early — hard to merge after building.' },
    { title:'WS7–8 — Offer, Hiring & Analytics', what:'Design offer creation, approval chains, offer templates, hiring handoff to onboarding, and agree reporting requirements.', say:"Once a candidate is offered and accepts — what happens next? Walk me through it.", ask:['Who can create an offer? Who approves it?','How many offer letter templates do you need?','What triggers the handoff to your onboarding system?','What are the 3 most important metrics your HR Director looks at?'], prepare:['Sessions 7 & 8 decks','Config Workbook — Offers tab'], output:'Offer approval chain, offer template specs, reporting requirements list', warn:'Do not create the onboarding status field in production until the integration is ready to go live — causes sync issues if it exists before the integration is configured.' },
  ]},
  { num:4, color:'#b45309', title:'UAT — User Acceptance Testing', weeks:'Weeks 5–7', steps:[
    { title:'UAT Preparation', what:'Prepare test scripts per user role, brief the client UAT team, set up the issue tracker, confirm the sign-off process.', say:"UAT is your project team's chance to find anything that doesn't match what we agreed. My job is to support you, log issues, and fix them fast.", ask:['Who will run UAT for each role?','How many business days are available?','Who provides written sign-off?'], prepare:['UAT Scripts','Issue tracker (shared)','UAT Prep overview doc'], output:'UAT scripts shared, issue tracker live, UAT team briefed', warn:'Brief the client on what counts as a bug vs a change request. UAT is not a design phase.' },
    { title:'UAT Execution & Issue Resolution', what:'Client runs test scripts. EX3 triages and fixes issues. Categorise: Critical (blocker), Major (fix before go-live), Minor (post go-live).', say:"Log everything — even minor things. We'd rather have a full picture.", ask:['Is this issue a blocker for go-live?','Does this match what was agreed in the config workbook?','Have all hiring processes been tested end-to-end?'], prepare:['Issue tracker','Config workbook for cross-reference'], output:'Issue log with categories, all critical issues resolved', warn:'Never let the client proceed to go-live with unresolved Critical issues. If they push back, escalate — it is your professional reputation on the line.' },
    { title:'UAT Sign-Off', what:'Confirm all critical issues resolved. Obtain written sign-off from the named project owner before any go-live date is confirmed.', say:"Before we set the go-live date, I need written confirmation from you that the system is ready. This protects both of us.", ask:['Are there any outstanding issues you have not raised?','Is there anything you expected to see that you have not seen?'], prepare:['Iteration Sign-Off doc'], output:'Signed UAT sign-off (email acceptable)', warn:'Email sign-off counts. A reply confirming readiness is acceptable. Do not rely on verbal agreement.' },
  ]},
  { num:5, color:'#0d7c4c', title:'Training', weeks:'Weeks 6–8', steps:[
    { title:'Admin Training (90 mins)', what:'Cover configuration, user management, job setup, email templates, reporting, and system admin tasks.', say:"Admin training is the most important session — the admin is the person who keeps the system healthy after we leave.", ask:['Who will be the go-to admin internally?','Are there backup admins who need training?'], prepare:['Admin Training Guide','System walkthrough plan'], output:'Admins trained, recording shared, Admin Training Guide distributed', warn:"Don't let admins make changes in production until training is complete." },
    { title:'Recruiter Training (60 mins)', what:'Cover posting jobs, managing the candidate pipeline, interview scheduling, communication templates, and reporting.', say:"This session is hands-on — I want you doing things in the system, not just watching me.", ask:['Will there be users who need a recording rather than attending live?'], prepare:['Recruiter Training Guide','Quick Reference Card'], output:'Recruiters trained, Quick Reference Card shared', warn:'' },
    { title:'Hiring Manager Training (45 mins)', what:'Cover reviewing candidates, leaving feedback, approving offers, and interview scheduling. Keep it tight and role-specific.', say:"HMs are busy — we'll cover exactly what you need to do your job in SmartRecruiters, nothing more.", ask:['How tech-savvy is your hiring manager population?'], prepare:['HM Training Guide','HM Quick Reference Card'], output:'HMs trained, Quick Reference Card shared', warn:'Never mix hiring managers and recruiters in the same training session — different workflows, you will confuse both groups.' },
  ]},
  { num:6, color:'#b91c1c', title:'Go-Live & Hypercare', weeks:'Weeks 8–12', steps:[
    { title:'Go-Live Alignment Call', what:'Final readiness check the day before go-live. Confirm communication plan, agree hypercare contacts and escalation path.', say:"We're good to go. Here is exactly what happens tomorrow and what to do if anything comes up.", ask:['Is everyone who needs access set up?','Has the go-live communication been drafted and approved?','Do you have our direct contact details for tomorrow?'], prepare:['Go-Live Checklist','Go-Live Alignment Call Overview','Cutover Plan'], output:'Green light confirmed, go-live comms ready to send', warn:'Do not confirm go-live until the Go-Live Checklist is fully complete. One missing item — like not migrating production users — causes chaos on day 1.' },
    { title:'Go-Live Day', what:'Production activated. Users get access. EX3 on standby all day. Respond within 1 hour to anything reported.', say:"You're live! Message me the moment anything does not look right — I'm available all day.", ask:['Has everyone received their access email?','Are jobs posting successfully?','Are integrations running?'], prepare:['Hypercare Tracker','Direct contact details shared with client'], output:'System live in production, no critical blockers', warn:'The most common go-live issue: sandbox users loaded with production email addresses. Double check before activation — email addresses are globally unique across all SR instances.' },
    { title:'Hypercare (Weeks 1–4)', what:'Week 1: daily check-ins. Weeks 2–4: weekly. Log and resolve all issues. Build client confidence and self-sufficiency.', say:"We'll be in daily contact this first week. No issue is too small to raise — better we catch it early.", ask:['Are users encountering anything unexpected?','Are integrations running cleanly?','Are any hiring managers struggling to adopt the system?'], prepare:['Hypercare Tracker (shared with client)','Lessons Learned log'], output:'Issues resolved, client self-sufficient', warn:'' },
    { title:'Closing Meeting & Formal Close', what:'Review project vs SOW scope, share lessons learned, hand over to BAU support, celebrate success.', say:"This project is officially closed. You're in safe hands with the support team — and you've got this guide forever.", ask:['Is there anything we could have done better?','Do you know how to raise a support case directly with SmartRecruiters?'], prepare:['Closing Meeting agenda','Lessons Learned log','Handover documentation pack'], output:'Project formally closed, client handed to support', warn:'' },
  ]},
];

function buildPlaybooks() {
  const container = document.getElementById('playbooks-content');
  playbooks.forEach(phase => {
    const el = document.createElement('div');
    el.className = 'phase';
    el.innerHTML = '<div class="phase-header" onclick="togglePhase(this)"><div class="phase-dot" style="background:' + phase.color + '"></div><div class="phase-title">' + phase.num + '. ' + phase.title + '</div><div class="phase-meta">' + phase.weeks + '</div><svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></div><div class="phase-body">' +
      phase.steps.map(function(s,i){ return '<div class="step-block"><div class="step-header"><div class="step-num">' + (i+1) + '</div><div class="step-title">' + s.title + '</div></div><div class="step-body"><div class="step-section"><div class="label">Exactly what to do</div><p>' + s.what + '</p></div>' + (s.say ? '<div class="say"><strong>What to say:</strong> &ldquo;' + s.say + '&rdquo;</div>' : '') + (s.ask && s.ask.length ? '<div class="step-section"><div class="label">Key questions to ask</div><ul>' + s.ask.map(function(q){return '<li>'+q+'</li>';}).join('') + '</ul></div>' : '') + (s.prepare && s.prepare.length ? '<div class="step-section"><div class="label">Prepare / have open</div><ul>' + s.prepare.map(function(p){return '<li>'+p+'</li>';}).join('') + '</ul></div>' : '') + (s.output ? '<div class="tip-hq"><strong>Output:</strong> ' + s.output + '</div>' : '') + (s.warn ? '<div class="warn"><strong>Watch out:</strong> ' + s.warn + '</div>' : '') + '</div></div>'; }).join('') + '</div>';
    container.appendChild(el);
  });
}
buildPlaybooks();

// ── Document Vault data ───────────────────────────────────────────
var vaultDocs = [
  { cat:'Configuration Workbooks', icon:'', items:[
    { name:'SFMASTER EXTERNAL Configuration Workbook v2', desc:'Main configuration workbook — the bible of your implementation', id:'13v74fSxV0MgSUoDUUU2AXHhgpIJbVwWb' },
    { name:'SFMASTER EXTERNAL SmartSuccess Configuration Workbook', desc:'SmartSuccess tier configuration workbook', id:'1Bxy_UoPaFWglYcepYOfsRL53ZXFlrZDR' },
    { name:'SFMASTER EXTERNAL Essentials Lite Configuration Workbook', desc:'Essentials Lite tier configuration workbook', id:'1LITLEOygS7ef6XriFCfDqzCQjXUOGmp3' },
    { name:'SF Winston Chat MASTER Configuration Workbook', desc:'Winston AI Chat feature configuration workbook', id:'1bLGB7JaBBT7AfS2fsZRXCl7VXd6yHTFr' },
    { name:'SFMASTER EXTERNAL Integrations Workbook', desc:'Capture all integration requirements — use in WS3', id:'1DrJ5WueJ2PlhkdiJuors3m1a2viT5vrB' },
  ]},
  { cat:'UAT Scripts', icon:'', items:[
    { name:'SFMASTER EXTERNAL General UAT Scripts', desc:'Standard UAT test scripts for all user roles', id:'1-W5PbI4aniXhYyKoSKYhL1keGagC6y4N' },
    { name:'SFMASTER EXTERNAL Example Custom UAT Scripts', desc:'Examples of customised test scripts', id:'1ia47AiaCm13-BalBO8LJnMU3OB9ZzpI1' },
    { name:'SFMASTER EXTERNAL CRM UAT Scripts', desc:'UAT scripts for CRM / candidate sourcing features', id:'1ydypqARgFiissgTD4PIUKIANTDPLTXVH' },
    { name:'SFMASTER EXTERNAL Mobile UAT Scripts', desc:'UAT scripts for mobile experience testing', id:'12sEbvW5k9dDPL2q8BLjr5C-S6Odo_sco' },
  ]},
  { cat:'Go-Live & Cutover', icon:'', items:[
    { name:'SFMASTER EXTERNAL Go Live Checklist and Hypercare Tracker', desc:'Master go-live checklist and hypercare issue tracker', id:'1SqGFbwN98RxmoqjVH5oZnM7jW95dDLVZ' },
    { name:'SF MASTER EXTERNAL Cutover Plan Options', desc:'Cutover strategy options — review with client pre go-live', id:'12ekVpMSePPHPGbSNmt0W0BTH2V3Oknj1' },
    { name:'SF MASTER EXTERNAL Cutover Strategy', desc:'Detailed cutover strategy and execution guide', id:'1aB22z5sfBT7WwAZMXwskHUIvImOtU8aD' },
    { name:'SFMASTER INTERNAL SR Cutover Overview', desc:'Internal EX3 reference for SR cutover approach', id:'1-t95m1DK-4t4YzkqtlBPwamHhD_SNfFa' },
  ]},
  { cat:'Training Materials', icon:'', items:[
    { name:'MASTER HR Recruiter Training Guide', desc:'Full recruiter training guide', id:'1P8w6f_BmvOFGKHD5nZAIHG-C3nZQr3Hm' },
    { name:'MASTER Admin Training Guide', desc:'Full admin training guide', id:'1jF54u1NdGTNTFx2dX-jzHZF4EBUYQnsp' },
    { name:'SF MASTER EXTERNAL Hiring Manager Training Guide', desc:'Hiring manager training guide', id:'1yxAO4jnzl7jQmtToDfsSA008-4i20abz' },
    { name:'SF MASTER EXTERNAL Hiring Manager Quick Reference Card', desc:'One-page quick reference for hiring managers', id:'1uLY_lBVPYlGBJA00VIE2OvYwEAd5ESs6' },
    { name:'SF MASTER INTERNAL ONLY Training Overview', desc:'Internal overview of training approach and session plans', id:'1CULMb8d0ZGqFJ6zsbepuJxnEpDtC50m-' },
  ]},
  { cat:'Closing & Go-Live Alignment', icon:'', items:[
    { name:'SF MASTER Closing Meeting BAU', desc:'Closing meeting agenda and BAU handover template', id:'18msXnrpANj2Vowm3bXDcK-DeUgbN3wOY' },
    { name:'SF MASTER INTERNAL ONLY Go Live Alignment Call Overview', desc:'Internal guide for the go-live alignment call', id:'1gU8WIOUTnH93vJ95XU2rX5hiToX2MSg3' },
  ]},
  { cat:'Reference & Best Practices', icon:'', items:[
    { name:'SFMASTER EXTERNAL Configuration Best Practices HRIS Integrations', desc:'Best practices for HRIS integration configuration', id:'1J7zaTeoD_Fiy1ta6kX5fwpxqPBrp4iSS' },
    { name:'SFMASTER EXTERNAL SmartRecruiters Standard Values', desc:'Standard platform values — departments, locations, job types', id:'13mBUWjmXqsZ8i1kjnr9U4yFQmoY1LHjp' },
    { name:'SF MASTER EXTERNAL Multilingualism Best Practices', desc:'Best practices for multi-language implementations', id:'1aNxs1udLvbbdfoAXKfb76XbaThGx93zg' },
    { name:'SF MASTER Languages in the Platform', desc:'Full list of supported platform languages and limitations', id:'1FOvJ3ExlEhw-mthgYgAgMtZPx6VIRjHC' },
    { name:'SF MASTER EXTERNAL Job Field Translations', desc:'Job field translation reference for multilingual setups', id:'1VpXyFx8Rlz8oJ_81vZ2N7UkYAMk7HLbp' },
    { name:'What Type of Field Should I Create', desc:'Decision guide for custom field type selection', id:'1Cnoyt2NdfIgozquQvmHK5yKZ4Mh82D3J' },
    { name:'SF MASTER Lessons Learned Log', desc:'Accumulated lessons from past implementations', id:'1RkTvfKFgyL2y9P3MUyOVRvCE8Lzx_w6w' },
    { name:'SF Email Template Merge Fields List', desc:'Full list of available merge fields for email templates', id:'1kpSlEV68B8q1aiC1BTWSHCA4HUyX9LWo' },
  ]},
  { cat:'Discovery Workshop Decks', icon:'', items:[
    { name:'Session 1 — System Controls & User Permissions', desc:'Workshop deck for Session 1', id:'1tOoFMiSkRmrZIzT2qiHq7qe0bzTeJzMx' },
    { name:'Session 2 — Job Creation & Management', desc:'Workshop deck for Session 2', id:'1QSovZ5Ny0lTk9-4INRe51Zi-c3v6xHFZ' },
    { name:'Session 3 — Functional Integrations & Ecosystem', desc:'Workshop deck for Session 3', id:'1xHv778Ssn_5sL2deUaarftdzE-FpusqG' },
    { name:'Session 4 — Career Site & Candidate Application', desc:'Workshop deck for Session 4', id:'1ImcSleiPBHnQuNh3ZRrEOMjyGITLh-W8' },
    { name:'Session 5 — Candidate Management 1', desc:'Workshop deck for Session 5', id:'1MqDFkhqZTfPL-4ULHo5cVARG7e923bCO' },
    { name:'Session 6 — Candidate Management 2', desc:'Workshop deck for Session 6', id:'1a0LlScPWj_zaY6h9XjbxCs6FhQ0dL-8l' },
    { name:'Session 7 — Offer Management & Hiring', desc:'Workshop deck for Session 7', id:'1pW17ZjkUfk4x48VV3vGHz_hqN4gUJ8F-' },
    { name:'Session 8 — Analytics', desc:'Workshop deck for Session 8', id:'1tWWqDY-YdMHjPcfmeNroHGHIwplCd-Vh' },
  ]},
  { cat:'Project Management & Governance', icon:'', items:[
    { name:'SF Project Management Plan PMO', desc:'Project management plan template', id:'1vcCTx-RNb5FoRn8QidS-jN4HEhSGQjGB' },
    { name:'SF Iteration Signoff PMO', desc:'Phase gate sign-off document', id:'1e-efaWRmN1e2-6z5TeWL8iMtlWjyuONo' },
    { name:'SF MASTER TEMPLATE RACI', desc:'RACI matrix template', id:'1vqRwmTr8bDraxfYC3wr422kuN3rokohd' },
  ]},
  { cat:'Kickoff & Workshop Planning', icon:'', items:[
    { name:'SF MASTER Welcome Implementation Kickoff', desc:'Welcome kickoff presentation deck', id:'16hHsRIbsYRx2CLapBKxBr8mVrs4YnFmP' },
    { name:'SF MASTER Implementation Planning Meeting Agenda', desc:'Planning meeting agenda template', id:'1SZOxq4jyEDnCE7oubnj9KlA6jL3BkClS' },
    { name:'SF MASTER INTERNAL Implementation Planning Meeting Overview', desc:'Internal guide for running the planning meeting', id:'1yzuAk7a7gnAC8jDNPc6JhNLG-x5f-qhM' },
    { name:'SF MASTER INTERNAL Workshop Planning', desc:'Internal workshop planning guide', id:'12J4y0RG30nWEFoWE4Rx_-hhQ36t0bCej' },
    { name:'SF MASTER INTERNAL Implementation Workshops Overview', desc:'Internal overview of all 8 discovery workshops', id:'1iWUOq3UZatqiDzsfZqGJa975-SCdupQg' },
    { name:'SF MASTER Client Implementation Playbook', desc:'Client-facing implementation playbook', id:'1KC8BYsc-ICgh3XSQyJs0o-1NO55pntyx' },
    { name:'SF MASTER EXTERNAL Discovery Workshops ONLINE Agenda', desc:'Online workshop agenda (remote delivery)', id:'1XD0CbUx3RIqQ156uX4CvytZ-JGkpRyXb' },
    { name:'SF MASTER EXTERNAL Discovery Workshops ONSITE 2 days', desc:'2-day on-site workshop agenda', id:'1nPlSB0vVkCXGawUtViPhl9bY24TnW1BX' },
    { name:'SF MASTER EXTERNAL Discovery Workshops ONSITE 3 days', desc:'3-day on-site workshop agenda', id:'1I00-GOntP9iSph8WSNsEoIkB2bwTTq6E' },
    { name:'SF MASTER INTERNAL Understanding the SOW', desc:'Internal guide to reading and understanding the SOW', id:'1yZqHV-nb5jORtuuSqCbHnW8vDruouoIV' },
  ]},
  { cat:'Internal Reference', icon:'', items:[
    { name:'SFMASTER INTERNAL SR Limits and FYIs', desc:'Platform limits and important FYIs — read before every project', id:'1smJo8hzn4RQA_CA2Y7xH2d05zabmRN5j' },
  ]},
  { cat:'Process Flows & Partner Readiness', icon:'', items:[
    { name:'MHR65 Recruiting for SmartRecruiters DRAFT', desc:'MHR65 recruitment process flow for SR', id:'1xQgto943oLaton9Lm46JZ5SEC74aAsAa' },
    { name:'SAP Partner Readiness Guide SmartRecruiters', desc:'SAP partner readiness and integration guide', id:'1oCzpc8ABb7NE3GisgyvpfDBOjLbHWrCI' },
  ]},
  { cat:'UAT Preparation', icon:'', items:[
    { name:'SF MASTER EXTERNAL UAT Preparation', desc:'Full UAT preparation guide — share 2 weeks before UAT starts', id:'1p-upRtH1Sev1gIUT93ER-A9VXtO79h-y' },
  ]},
  { cat:'Advertising & Analytics', icon:'', items:[
    { name:'A&A Recruiting Marketing Workbook 2024', desc:'Advertising and analytics recruiting marketing workbook', id:'1ZJDRF4d0VyTY3A45ZJGqiPZt4Yc-Ba_V' },
  ]},
];

function buildVault() {
  var container = document.getElementById('vault-content');
  vaultDocs.forEach(function(cat) {
    var section = document.createElement('div');
    section.className = 'doc-category';
    section.innerHTML = '<h3>' + cat.cat + '</h3><div class="doc-grid">' + cat.items.map(function(d){ return '<div class="doc-item"><div class="doc-info"><h4>' + d.name + '</h4><p>' + d.desc + '</p><a href="https://drive.google.com/file/d/' + d.id + '/view" target="_blank" class="doc-link">Open in Drive &#8594;</a></div></div>'; }).join('') + '</div>';
    container.appendChild(section);
  });
}
buildVault();

// ── Gotcha Library data ───────────────────────────────────────────
var gotchas = [
  { phase:'Config', color:'#5b21b6', title:'SSO identifier is case sensitive', detail:'The SSO identifier must match exactly — including case — with what your IdP sends. A mismatch causes login failures. Test with a real user before go-live.' },
  { phase:'Config', color:'#5b21b6', title:'Never use production emails in sandbox', detail:'Email addresses are unique globally across all SR instances. If you create sandbox users with real production email addresses, those emails cannot be reused in production without raising a support case.' },
  { phase:'Build', color:'#065f46', title:'Never create items manually when an integration is in scope', detail:'If a HRIS integration will create departments, locations, or users — do not create them manually first. The integration cannot match manually created records and will either duplicate or fail.' },
  { phase:'Config', color:'#5b21b6', title:'Standard Department field cannot be used in HRIS integrations', detail:'The standard Department field cannot be mapped in integrations. Create a custom field (e.g. Department_HRIS) for the integration to write to.' },
  { phase:'Build', color:'#065f46', title:'Do not create onboarding status field until integration is ready', detail:'Creating the onboarding status field in production before the integration is configured causes sync issues. The integration needs to own this field from day one.' },
  { phase:'Config', color:'#5b21b6', title:'Pre-defined Locations disables location editing in the UI', detail:'Turning on Pre-defined Locations removes the ability for users to free-type a location. They can only select from the predefined list. Brief the client before enabling.' },
  { phase:'Config', color:'#5b21b6', title:'Custom field names must not match standard field names', detail:'If a custom field shares a name with a standard field, the standard field is overwritten and cannot be recovered without a support case. Always use distinct naming.' },
  { phase:'Config', color:'#5b21b6', title:'Job approvals prevent headcount/position population', detail:'Turning on job approvals triggers a known SR bug — Position and Headcount fields cannot be populated. If the client needs both, document the workaround at design stage.' },
  { phase:'Build', color:'#065f46', title:'Job field dependencies fail if integration omits dependent fields', detail:'If a job field has a dependency, the integration must send values for ALL dependent fields — even non-required ones. Omitting them causes the dependency chain to fail silently.' },
  { phase:'Build', color:'#065f46', title:'Do not mark job fields as required after integration is built', detail:'If you add a required flag to a job field after the integration is built, any sync run that omits that field will fail. Agree required fields before building.' },
  { phase:'Config', color:'#5b21b6', title:'Email templates cannot be triggered by job ad language alone', detail:'You need org-level custom fields (e.g. Country or Language preference) to drive language-specific email routing. Job ad language alone is not sufficient.' },
  { phase:'Config', color:'#5b21b6', title:'Custom hiring process steps stay in creation language', detail:'Step names do not auto-translate. For multilingual clients, all step names must be written in the agreed master language to avoid a mixed-language UI.' },
  { phase:'Config', color:'#5b21b6', title:'Maximum 10 custom system roles, 5 custom hiring team roles', detail:'Hard platform limit. If clients want more, challenge whether they really need them at design stage rather than discovering the limit mid-build.' },
  { phase:'Config', color:'#5b21b6', title:'Maximum 120 hiring processes, 8 steps per status', detail:'Hard platform limits. For clients with complex multi-brand or multi-country setups, design for consolidation early.' },
  { phase:'Config', color:'#5b21b6', title:'Maximum 500 candidate custom fields', detail:'Multi-language clients adding fields for each language can approach this. Monitor field count during build.' },
  { phase:'Build', color:'#065f46', title:'Do not use onboarding status field visibility as an integration filter', detail:'Using visibility on the onboarding status field as a trigger or filter causes unreliable behaviour. Use dedicated integration filter fields instead.' },
  { phase:'Discovery', color:'#1d4ed8', title:'Engage IT at kickoff — not at integration phase', detail:'The most common cause of integration delays is not having IT engaged until Week 3. Get IT named at the planning meeting. SSO requires IT — without them you are blocked.' },
  { phase:'UAT', color:'#b45309', title:'UAT is not a design phase', detail:'Clients regularly try to redesign during UAT. Changes to agreed scope require a formal change request. Let them raise bugs, not new requirements.' },
  { phase:'Discovery', color:'#1d4ed8', title:'Verbal promises in sales do not equal scope', detail:"Sales teams sometimes make verbal commitments not in the SOW. Confirm with sales before kickoff whether any out-of-scope promises were made — fix it before the client assumes it's included." },
];

var activeGotchaPhase = 'all';
function buildGotchas() {
  var filters = document.getElementById('gotcha-phase-filters');
  var phases = ['all'];
  gotchas.forEach(function(g){ if(phases.indexOf(g.phase)===-1) phases.push(g.phase); });
  phases.forEach(function(p) {
    var btn = document.createElement('button');
    btn.className = 'int-tab' + (p==='all' ? ' active' : '');
    btn.textContent = p==='all' ? 'All phases' : p;
    btn.onclick = function() {
      activeGotchaPhase = p;
      document.querySelectorAll('#gotcha-phase-filters .int-tab').forEach(function(b){b.classList.remove('active');});
      btn.classList.add('active');
      filterGotchas(document.getElementById('gotcha-search').value);
    };
    filters.appendChild(btn);
  });
  renderGotchas(gotchas);
}
function filterGotchas(search) {
  var term = (search||'').toLowerCase();
  var filtered = gotchas.filter(function(g){
    return (activeGotchaPhase==='all' || g.phase===activeGotchaPhase) &&
           (!term || g.title.toLowerCase().indexOf(term)>=0 || g.detail.toLowerCase().indexOf(term)>=0);
  });
  renderGotchas(filtered);
}
function renderGotchas(list) {
  var container = document.getElementById('gotchas-list');
  if(!list.length){ container.innerHTML='<p style="color:#5a4a8a;font-size:13px">No matching gotchas.</p>'; return; }
  container.innerHTML = list.map(function(g){ return '<div class="gotcha-item"><div class="g-header"><span class="g-phase" style="background:'+g.color+'22;color:'+g.color+';border:1px solid '+g.color+'44">'+g.phase+'</span><span class="g-title">'+g.title+'</span></div><div class="g-detail">'+g.detail+'</div></div>'; }).join('');
}
buildGotchas();

// ── Integration Wizard data ───────────────────────────────────────
var integrationWizard = [
  { id:'usersync', label:'User Sync (HRIS)',
    preflight:['Confirm HRIS system and version','Get HRIS API credentials from IT','Confirm which user attributes to sync (name, email, role, department, location)','Agree on user deprovisioning approach','Confirm sync frequency (real-time vs scheduled)'],
    steps:[{t:'Configure HRIS connector in SR Marketplace',d:'Navigate to SR Admin > Integrations > Marketplace. Find your HRIS connector and enter API credentials from client IT.'},{t:'Map user attributes',d:'Map HRIS fields to SR fields. Key note: do NOT map to the standard Department field — use a custom field. Map: First Name, Last Name, Email, Job Title, custom Department, Location, Manager.'},{t:'Configure user role assignment',d:'Decide whether roles are assigned by the integration or manually. If integration-driven, map HRIS role values to SR role names exactly.'},{t:'Set sync schedule',d:'Configure frequency. Recommended: real-time for new starters and leavers, daily batch for profile updates.'},{t:'Run test sync in sandbox',d:'Run a test with 5-10 test users. Verify all attributes mapped correctly. Never use production email addresses in sandbox.'},{t:'Validate in production',d:'Run first production sync. Verify users created with correct roles and attributes. Confirm deprovisioning works for a test leaver.'}],
    test:['New user in HRIS appears in SR within expected timeframe','User attributes are correct (name, email, department, location)','Role assignment is correct','Deprovisioned user loses SR access','Sync logs show no errors'] },
  { id:'configsync', label:'Config Sync',
    preflight:['Understand what config items will be synced (departments, locations, job types)','Agree which environment is the master source','Confirm sync direction (one-way vs bi-directional)'],
    steps:[{t:'Identify config objects to sync',d:'Determine which config objects the integration manages: departments, locations, cost centres, job types.'},{t:'Configure config sync connector',d:'Set up in SR and map source fields to SR config objects.'},{t:'Test with non-production data',d:'Run a test sync with a subset of config data and verify objects appear correctly.'},{t:'Agree on manual override policy',d:'Decide whether admins can manually add config items alongside the integration. Document this — confusion causes duplicates.'}],
    test:['Config objects appear correctly in SR','Manual additions do not conflict with integration','Deleted source items handled correctly in SR'] },
  { id:'jobsync', label:'Job Sync (HRIS → SR)',
    preflight:['Confirm job/position object structure in HRIS','Agree which fields flow from HRIS vs are managed in SR','Confirm whether headcount/position tracking is required'],
    steps:[{t:'Map job/position fields',d:'Map HRIS position fields to SR job fields. The standard Department field cannot be used — map to a custom department field.'},{t:'Handle job approvals before job sync',d:'If the client needs job approvals AND position tracking, document the known SR bug before building and agree a workaround.'},{t:'Build field dependency handling',d:'Ensure the integration sends values for ALL dependent fields — even non-required ones — or the dependency chain fails silently.'},{t:'Test job creation end-to-end',d:'Create a test position in HRIS. Verify it appears in SR with correct values. Post the job to test the full workflow.'}],
    test:['Position in HRIS appears as job in SR','All mapped fields populated correctly','Job approval workflow triggers if applicable','Field dependencies resolve correctly'] },
  { id:'hiresync', label:'Hire Sync (SR → HRIS)',
    preflight:['Confirm what "hired" trigger means — offer accepted or start date confirmed?','Agree which fields SR sends to HRIS at hire','Confirm HRIS receiving endpoint and credentials'],
    steps:[{t:'Agree hire trigger event',d:'Define exactly what event in SR triggers the hire sync: moved to Hired status, offer countersigned, or a specific step. Document precisely.'},{t:'Map hire payload fields',d:'Define which SR fields are sent: candidate name, start date, job title, department, location, salary (if applicable), manager. Get HR sign-off.'},{t:'Handle onboarding status field carefully',d:'Do NOT create the onboarding status field in production until the integration is configured and ready to go live.'},{t:'Test end-to-end',d:'Create a test candidate in SR, move to hired, verify the hire payload arrives in HRIS correctly.'}],
    test:['Hire event in SR triggers sync within expected timeframe','All hire payload fields arrive in HRIS correctly','No duplicate records created in HRIS','Onboarding status field updates correctly'] },
  { id:'sso', label:'SSO (SuccessFactors / Azure / Okta)',
    preflight:['Confirm IdP provider (Azure AD, Okta, SuccessFactors, ADFS)','Get IT contact who owns the IdP — must be present for setup','Confirm SSO protocol: SAML 2.0 or OIDC','Agree on provisioning: SSO only or SSO + SCIM'],
    steps:[{t:'Obtain SR SSO metadata',d:'SR Admin > Company Settings > Security > Single Sign-On. Download the SR SP metadata XML. Share with client IT.'},{t:'Configure IdP application',d:'Client IT creates SR application in IdP. They upload SR metadata and configure attribute mappings. NameID = email. THE IDENTIFIER IS CASE SENSITIVE.'},{t:'Obtain IdP metadata',d:'Client IT provides their IdP metadata XML (or entityID + SSO URL + certificate). Load into SR SSO settings.'},{t:'Test SSO in sandbox first',d:'Never test SSO in production first. Test in sandbox with at least 2 different users with different roles.'},{t:'Enable in production',d:'Once sandbox confirmed working, replicate config in production. Run a final test before communicating to users.'}],
    test:['SSO login works for at least 3 different users','Users redirected to IdP login correctly','After authentication, user lands in correct SR session with correct role','Failed authentication shows appropriate error (not blank page)'] },
  { id:'linkedin', label:'LinkedIn Recruiter',
    preflight:['Confirm client has LinkedIn Recruiter seats (not just LinkedIn Jobs)','Get LinkedIn account admin contact at the client','Confirm whether InMail sync and profile sync are required'],
    steps:[{t:'Enable LinkedIn RSC in SR',d:'SR Admin > Integrations > LinkedIn Recruiter System Connect. Follow OAuth flow to connect SR to LinkedIn.'},{t:'Connect individual recruiter seats',d:'Each recruiter with a LinkedIn seat must connect their own LinkedIn account to SR. Done per-user in their SR profile settings.'},{t:'Configure profile sync settings',d:'Decide which LinkedIn profile fields sync to SR candidate records.'},{t:'Test with a real LinkedIn profile',d:'Send an InMail from LinkedIn Recruiter — verify it appears in SR candidate timeline. Import a profile and verify field mapping.'}],
    test:['InMails from LinkedIn appear in SR candidate timeline','LinkedIn profiles can be imported to SR','Recruiter seat connections show as active','No duplicate candidate records on import'] },
  { id:'calendar', label:'Calendar (Office 365 / Google)',
    preflight:['Confirm calendar provider: Office 365 or Google Workspace','Confirm whether candidate self-scheduling is required','Get O365/Google admin contact — they may need to grant OAuth permissions'],
    steps:[{t:'Configure calendar integration in SR',d:'SR Admin > Integrations > Calendar. Select provider and follow OAuth flow. Admin may need to grant SR permissions in their tenant.'},{t:'Configure interview scheduling settings',d:'Set default meeting duration options. Configure self-scheduling (if required). Set recruiter availability display.'},{t:'Connect interviewer calendars',d:'Each interviewer must connect their own calendar in their SR profile settings. Test with at least 3 interviewers.'},{t:'Test a live interview booking',d:'Schedule a test interview from SR. Verify calendar invites sent to all parties. Verify accept/decline updates the SR record.'}],
    test:['Calendar invites sent when interview scheduled','Interview visible in SR candidate timeline','Interviewer accept/decline reflected in SR','Candidate self-scheduling works end-to-end (if enabled)','Interview cancellation updates calendar correctly'] },
];

function buildIntegrations() {
  var tabs = document.getElementById('int-tabs');
  var contents = document.getElementById('int-contents');
  integrationWizard.forEach(function(intg, i) {
    var tab = document.createElement('button');
    tab.className = 'int-tab' + (i===0 ? ' active' : '');
    tab.textContent = intg.label;
    tab.onclick = (function(id){ return function() {
      document.querySelectorAll('#int-tabs .int-tab').forEach(function(t){t.classList.remove('active');});
      document.querySelectorAll('.int-content').forEach(function(c){c.classList.remove('active');});
      tab.classList.add('active');
      document.getElementById('intg-'+id).classList.add('active');
    }; })(intg.id);
    tabs.appendChild(tab);
    var div = document.createElement('div');
    div.className = 'int-content' + (i===0 ? ' active' : '');
    div.id = 'intg-' + intg.id;
    div.innerHTML = '<div class="int-section"><h3>Pre-flight Checklist</h3><ul class="checklist-hq">' + intg.preflight.map(function(p){return '<li>'+p+'</li>';}).join('') + '</ul></div>' +
      '<div class="int-section"><h3>Setup Steps</h3>' + intg.steps.map(function(s,j){return '<div class="int-step"><div class="int-step-num">'+(j+1)+'</div><div><strong style="color:#e2dff7;font-size:13px">'+s.t+'</strong><p style="margin-top:4px">'+s.d+'</p></div></div>';}).join('') + '</div>' +
      '<div class="int-section"><h3>What to Test</h3><ul class="checklist-hq">' + intg.test.map(function(t){return '<li>'+t+'</li>';}).join('') + '</ul></div>';
    contents.appendChild(div);
  });
}
buildIntegrations();

// ── Phase accordion ───────────────────────────────────────────────
function togglePhase(header) {
  var body = header.nextElementSibling;
  body.classList.toggle('open');
  var chevron = header.querySelector('.phase-chevron');
  if(chevron) chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : '';
}

// ── AI Coach ──────────────────────────────────────────────────────
var aiOpen = false;
var aiThreadId = null;
function toggleAI() {
  aiOpen = !aiOpen;
  document.getElementById('ai-panel').classList.toggle('open', aiOpen);
  document.getElementById('ai-fab').style.display = aiOpen ? 'none' : 'flex';
}
function aiKeydown(e) {
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); aiSend(); }
}
function aiQuick(msg) {
  document.getElementById('ai-input').value = msg;
  aiSend();
}
async function aiSend() {
  var input = document.getElementById('ai-input');
  var msg = input.value.trim();
  if(!msg) return;
  input.value = '';
  appendAIMsg('user', msg);
  var sendBtn = document.getElementById('ai-send');
  sendBtn.disabled = true;
  var assistantEl = appendAIMsg('assistant', '&#8230;');
  try {
    var resp = await fetch('/consultant/implementation-hq/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ message:msg, threadId:aiThreadId })
    });
    if(!resp.ok) throw new Error('failed');
    aiThreadId = resp.headers.get('X-Thread-Id') || aiThreadId;
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var fullText = '';
    while(true) {
      var read = await reader.read();
      if(read.done) break;
      fullText += decoder.decode(read.value);
      assistantEl.innerHTML = formatAIMsg(fullText);
      document.getElementById('ai-messages').scrollTop = 99999;
    }
  } catch(err) {
    assistantEl.textContent = 'Sorry, something went wrong. Try again.';
  }
  sendBtn.disabled = false;
}
function appendAIMsg(role, text) {
  var el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  el.innerHTML = formatAIMsg(text);
  document.getElementById('ai-messages').appendChild(el);
  document.getElementById('ai-messages').scrollTop = 99999;
  return el;
}
function formatAIMsg(text) {
  return text.replace(/\\*\\*(.*?)\\*\\*/g,'<strong>$1</strong>').replace(/\\n/g,'<br>');
}
</script>
</body></html>`);
});

// Implementation HQ — AI Chat endpoint
app.post('/consultant/implementation-hq/chat', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { message, threadId } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  if (!process.env.ASSISTANT_ID) return res.status(500).json({ error: 'Assistant not configured' });

  try {
    const thread = threadId
      ? { id: threadId }
      : await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, { role: 'user', content: message });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Thread-Id', thread.id);

    await new Promise((resolve, reject) => {
      openai.beta.threads.runs.stream(thread.id, {
        assistant_id: process.env.ASSISTANT_ID,
        additional_instructions: `You are the EX3 Implementation Coach. The user is an EX3 consultant using the Implementation HQ. Focus on implementation methodology, platform limits, gotchas, configuration, integrations, UAT, and go-live. Be specific and practical. Reference document names when relevant. Do not include citation markers in your response.`,
      })
      .on('textDelta', (delta) => {
        const clean = (delta.value || '').replace(/【[^】]*】/g, '');
        if (clean) res.write(clean);
      })
      .on('end', resolve)
      .on('error', reject);
    });

    res.end();
  } catch(err) {
    console.error('AI coach error:', err.message);
    if (!res.headersSent) res.status(500).end('Error generating response');
    else res.end();
  }
});

// SOW AI Generation
app.post('/consultant/sow-ai', async (req, res) => {
  const { answers } = req.body;
  if (!answers) return res.status(400).json({ error: 'No answers provided' });

  const integrations = Array.isArray(answers.integrations) ? answers.integrations.join(', ') : answers.integrations || 'none';
  const jobBoards = Array.isArray(answers.jobBoards) ? answers.jobBoards.join(', ') : answers.jobBoards || 'none';
  const training = Array.isArray(answers.training) ? answers.training.join('; ') : answers.training || 'none';

  const prompt = `You are a senior implementation consultant writing a formal Statement of Work for a SmartRecruiters ATS implementation. Write a complete, professional SOW based on these project details:

Client: ${answers.clientName}
Organisation size: ${answers.orgSize}
Number of users: ${answers.numUsers}
Hiring process workflows: ${answers.numProcesses}
Job templates: ${answers.numTemplates}
Integrations: ${integrations}
Job boards: ${jobBoards}
Career page: ${answers.careerPage}
Data migration: ${answers.dataMigration}
Training: ${training}
Hypercare period: ${answers.hypercare}
Project timeline: ${answers.timeline}

Write a complete SOW with these sections: 1. Project Overview, 2. In Scope (with subsections), 3. Out of Scope, 4. Client Responsibilities, 5. Assumptions, 6. Change Request Process.

Use formal, specific, commercial language. Be concrete — include the exact numbers, integrations, and timelines provided. Make it ready to send directly to the client. Do not use placeholder text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    for await (const chunk of completion) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) res.write(text);
    }
    res.end();
  } catch (err) {
    console.error('SOW AI error:', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// SOW Word Export
app.post('/consultant/sow-export', async (req, res) => {
  const { answers: a, clientName: rawClient } = req.body;
  if (!a) return res.status(400).json({ error: 'No answers' });

  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle, VerticalAlign
  } = require('docx');

  const clientName = rawClient || a.clientName || 'To be confirmed';

  // ── helpers ──────────────────────────────────────────────────────────────
  const h1 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 120 } });
  const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 80 } });
  const h3 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 60 } });
  const body = (text) => new Paragraph({ children: [new TextRun({ text, size: 22 })], spacing: { after: 120 } });
  const bullet = (text) => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 80 } });
  const spacer = () => new Paragraph({ text: '' });

  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
  const headerBorder = { style: BorderStyle.SINGLE, size: 8, color: '0F0F0F' };

  function twoColTable(rows, shade1 = 'F5F5F5') {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map((r, idx) => new TableRow({
        children: [
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: noBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : {},
            verticalAlign: VerticalAlign.TOP,
            children: [new Paragraph({ children: [new TextRun({ text: r[0], size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : '000000' })], spacing: { before: 80, after: 80 } })],
          }),
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: noBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : {},
            verticalAlign: VerticalAlign.TOP,
            children: [new Paragraph({ children: [new TextRun({ text: r[1], size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : '000000' })], spacing: { before: 80, after: 80 } })],
          }),
        ],
      })),
    });
  }

  function raciTable(rows) {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map((r, idx) => new TableRow({
        children: [
          new TableCell({
            width: { size: 70, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: noBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : (idx % 2 === 0 ? { fill: 'FAFAFA' } : {}),
            verticalAlign: VerticalAlign.CENTER,
            children: [new Paragraph({ children: [new TextRun({ text: r[0], size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : '000000' })], spacing: { before: 60, after: 60 } })],
          }),
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: thinBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : (r[1] ? { fill: 'E8F5E9' } : {}),
            verticalAlign: VerticalAlign.CENTER,
            children: [new Paragraph({ children: [new TextRun({ text: r[1] || '', size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : r[1] ? '1B5E20' : '000000' })], alignment: AlignmentType.CENTER, spacing: { before: 60, after: 60 } })],
          }),
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: thinBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : (r[2] ? { fill: 'E8F5E9' } : {}),
            verticalAlign: VerticalAlign.CENTER,
            children: [new Paragraph({ children: [new TextRun({ text: r[2] || '', size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : r[2] ? '1B5E20' : '000000' })], alignment: AlignmentType.CENTER, spacing: { before: 60, after: 60 } })],
          }),
        ],
      })),
    });
  }

  // ── derived flags ─────────────────────────────────────────────────────────
  const integrationsList = Array.isArray(a.integrations) ? a.integrations : [];
  const jobBoardsList = Array.isArray(a.jobBoards) ? a.jobBoards : [];
  const trainingList = Array.isArray(a.training) ? a.training : [];
  const complianceList = Array.isArray(a.compliance) ? a.compliance : [];
  const isMiddleEast = !!(a.geoScope && a.geoScope.indexOf('Middle East') >= 0);
  const hasCareerPage = !!(a.careerPage && a.careerPage.indexOf('not in scope') < 0 && a.careerPage.indexOf('not required') < 0);
  const hasOfferMgmt = !!(a.offerMgmt && a.offerMgmt.indexOf('Not in scope') < 0 && a.offerMgmt.indexOf('not in scope') < 0);
  const hasAgency = !!(a.agencyPortal && a.agencyPortal.indexOf('No external') < 0);
  const hasDocuSign = integrationsList.some(i => i.indexOf('DocuSign') >= 0 || i.indexOf('e-signature') >= 0);
  const hasSFEC = integrationsList.some(i => i.indexOf('Employee Central') >= 0 || i.indexOf('SAP SuccessFactors') >= 0);
  const hasMigration = !!(a.dataMigration && a.dataMigration.toLowerCase().indexOf('not in scope') < 0 && a.dataMigration.toLowerCase().indexOf('no migration') < 0 && a.dataMigration.toLowerCase().indexOf('no data') < 0);

  const now = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dateStr = now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();

  const children = [];

  // ── TITLE PAGE ────────────────────────────────────────────────────────────
  children.push(new Paragraph({
    children: [new TextRun({ text: 'SmartRecruiters Recruiting Implementation', bold: true, size: 52, color: '0F0F0F' })],
    alignment: AlignmentType.CENTER, spacing: { before: 720, after: 160 }
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'via EXcelerate', size: 36, italics: true, color: '444444' })],
    alignment: AlignmentType.CENTER, spacing: { after: 480 }
  }));
  children.push(spacer());
  children.push(twoColTable([
    ['Client', clientName],
    ['Prepared by', 'EX3'],
    ['Date', dateStr],
    ['Version', '1.0 (Draft)'],
  ]));
  children.push(spacer());

  // ── OVERVIEW ──────────────────────────────────────────────────────────────
  children.push(h1('Overview'));
  children.push(body('EX3 has been asked to provide a Statement of Work for the SmartRecruiters implementation for ' + clientName + '. This section outlines the scope, methodology, responsibilities, and deliverables for the SmartRecruiters deployment.'));
  children.push(spacer());
  children.push(body('The modules in scope for this workstream are:'));
  children.push(bullet('SmartRecruiters Recruiting Management (SMRC)'));
  if (hasCareerPage) children.push(bullet('Career Site / Recruiting Marketing configuration'));
  if (integrationsList.length > 0) children.push(bullet('Integration to ' + (hasSFEC ? 'Employee Central (EC), Position Management, and Onboarding' : integrationsList.join('; '))));
  children.push(spacer());
  if (isMiddleEast) {
    children.push(body('The countries in scope are:'));
    children.push(bullet('United Arab Emirates'));
    children.push(bullet('Saudi Arabia'));
    children.push(bullet('Oman'));
    children.push(bullet('Jordan'));
    children.push(bullet('Lebanon'));
    children.push(bullet('Iraq'));
    children.push(spacer());
  }
  children.push(body('EX3 will apply the EXcelerate methodology, which is optimised for rapid deployment using model company content. EXcelerate is designed to deliver a high-quality SmartRecruiters implementation efficiently, leveraging EX3\'s pre-built assets as a baseline while allowing for configuration aligned to ' + clientName + '\'s hiring processes.'));

  // ── PERIOD OF PERFORMANCE ─────────────────────────────────────────────────
  children.push(h1('Period of Performance'));
  children.push(body('The Services for the SmartRecruiters workstream shall take place within ' + (a.timeline || 'a timeline to be agreed') + ' of SOW execution and will run in parallel with the broader implementation.'));
  children.push(spacer());
  children.push(body('Organisation profile:'));
  children.push(bullet('Organisation size: ' + (a.orgSize || 'To be confirmed')));
  children.push(bullet('Geography: ' + (a.geoScope ? a.geoScope.split('.')[0] : 'To be confirmed')));
  children.push(bullet('Platform language: English only'));
  children.push(bullet('Users in scope: ' + (a.numUsers || 'To be confirmed')));

  // ── ENGAGEMENT RESOURCES ──────────────────────────────────────────────────
  children.push(h1('Engagement Resources'));
  children.push(body('As part of this engagement, EX3 will assign the required resources. Resources will have experience of the SmartRecruiters platform and enterprise talent acquisition implementations.'));
  children.push(spacer());
  children.push(body('Key information on our resources:'));
  children.push(bullet('All resources have worked effectively as remote resources on projects scaling from small to very large global implementations'));
  children.push(bullet('Resources will have experience of the SmartRecruiters platform and relevant TA processes'));
  children.push(bullet('Resources have global and Middle East regional experience'));
  children.push(bullet('Resources and responsibilities are subject to change throughout the project'));
  children.push(spacer());
  children.push(body('The EX3 implementation team shall engage with the Customer no later than four (4) weeks from SOW execution. Delivery dates for tasks included in this SOW shall be based upon mutual agreement as documented within an approved project schedule.'));

  // ── METHODOLOGY ───────────────────────────────────────────────────────────
  children.push(h1('Implementation Methodology, Services & Responsibilities'));
  children.push(body('EX3 has created its own implementation methodology, EXcelerate, which incorporates both industry best practices and lessons learned from our years of experience doing high quality SmartRecruiters implementations.'));
  children.push(spacer());
  children.push(body('EXcelerate is structured across the following phases:'));
  children.push(spacer());
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: ['Examine','Adopt','Validate','Launch'].map((ph, i) => new TableCell({
        width: { size: 25, type: WidthType.PERCENTAGE },
        borders: { top: headerBorder, bottom: headerBorder, left: i === 0 ? noBorder : thinBorder, right: noBorder },
        shading: { fill: '0F0F0F' },
        children: [new Paragraph({ children: [new TextRun({ text: ph, bold: true, size: 22, color: 'FFFFFF' })], alignment: AlignmentType.CENTER, spacing: { before: 80, after: 80 } })],
      })) }),
      new TableRow({ children: [
        ['Kick-off, requirements, process mapping, design sign-off, integration scoping'],
        ['Platform config: route maps, job templates, user roles, offer mgmt, career site, integrations, data migration'],
        ['UAT test scripts, facilitation, defect resolution, written sign-off prior to go-live'],
        ['Go-live readiness review, production cutover, training, Hypercare support'],
      ].map((t, i) => new TableCell({
        width: { size: 25, type: WidthType.PERCENTAGE },
        borders: { top: thinBorder, bottom: thinBorder, left: i === 0 ? noBorder : thinBorder, right: noBorder },
        verticalAlign: VerticalAlign.TOP,
        children: [new Paragraph({ children: [new TextRun({ text: t[0], size: 18 })], spacing: { before: 80, after: 80 } })],
      })) }),
    ],
  }));
  children.push(spacer());

  // Phase detail helper
  function phaseSection(phaseName, desc, taskRows, delivRows) {
    children.push(h2(phaseName));
    children.push(body(desc));
    children.push(spacer());
    children.push(h3('Key Tasks'));
    children.push(twoColTable([['Client and EX3', 'EX3'], ...taskRows]));
    children.push(spacer());
    children.push(h3('Deliverables'));
    children.push(twoColTable([['Client', 'EX3'], ...delivRows]));
    children.push(spacer());
  }

  phaseSection(
    'Examine Phase',
    'The purpose of the Examine Phase is to establish the framework for a successful project, confirm platform design, map hiring processes, and sign off the configuration blueprint before Adopt commences.',
    [
      ['Review Examine findings and agree configuration blueprint', 'Lead kick-off workshop and process mapping sessions'],
      ['Confirm route map stages and approval chain definitions', 'Produce platform design document for sign-off'],
      ['Sign off RBP access matrix and job template structure', 'Begin integration scoping and data migration assessment'],
    ],
    [
      ['Signed-off configuration blueprint', 'Kick-off and workshop presentations'],
      ['Completed RBP access matrix', 'Platform design sign-off document'],
      ['Approval chain definitions confirmed', 'Data migration assessment report'],
    ]
  );

  phaseSection(
    'Adopt Phase',
    'The purpose of the Adopt Phase is to configure the SmartRecruiters platform per the agreed design, leveraging EX3 model company content as a baseline. Iterative unit testing occurs throughout this phase.',
    [
      ['Review configuration playbacks and provide timely feedback', 'Configure route maps, job templates, offer management, screening'],
      ['Confirm email copy and brand assets for career site build', 'Configure user accounts, RBP roles, and approval chains'],
      ['Sign off configuration before Validate commences', 'Conduct unit testing and playback sessions'],
    ],
    [
      ['Approved email copy, branding assets, offer letter content', 'Configured SmartRecruiters sandbox environment'],
      ['Build sign-off', 'Updated configuration workbooks'],
      ['', 'Unit test results and playback docs'],
    ]
  );

  phaseSection(
    'Validate Phase',
    'The purpose of the Validate Phase is to confirm all configured functionality through client-led UAT. Written sign-off is required before go-live proceeds.',
    [
      ['Execute UAT test scripts and log all findings', 'Deliver UAT test scripts and facilitate sessions'],
      ['Coordinate feedback, triage calls, and final UAT sign-off', 'Resolve all Critical and High priority defects within SLA'],
      ['Creation of test users', 'Update configuration workbooks post-UAT'],
    ],
    [
      ['Signed UAT sign-off document', 'UAT test scripts'],
      ['', 'Defect log and resolution summary'],
      ['', 'Updated instance configuration'],
    ]
  );

  phaseSection(
    'Launch Phase',
    'The purpose of the Launch Phase is to move configuration to the production environment, support the go-live, deliver training, and provide post-go-live Hypercare for a smooth transition to BAU.',
    [
      ['PROD smoke test', 'Execute cutover checklist and move configuration to PROD'],
      ['Attend training sessions and complete pre-reading', 'Deliver recruiter, admin and hiring manager training'],
      ['Participate in go-live readiness review', 'Administer Hypercare and project closure'],
    ],
    [
      ['PROD smoke test sign-off', 'Final PROD configuration'],
      ['Project closeout complete', 'Post-implementation handover pack'],
      ['', 'HelpMyCloud Hypercare'],
      ['', 'Completed configuration workbooks'],
    ]
  );

  // ── SCOPE OF WORK ─────────────────────────────────────────────────────────
  children.push(h1('Scope of Work'));
  children.push(h2('SmartRecruiters Recruiting Management Scope — EXcelerate Deployment'));

  children.push(h3('Route Maps (Hiring Workflows)'));
  children.push(bullet('Configuration of ' + (a.numProcesses || '6–8') + ' route maps aligned to ' + clientName + ' hiring workflows'));
  children.push(bullet('Stage and status configuration per agreed route map design'));
  children.push(bullet('Rejection reason configuration'));
  children.push(bullet('Route map design to be confirmed and signed off during the Examine Phase'));

  children.push(h3('Job Templates'));
  children.push(bullet('Configuration of ' + (a.numTemplates || '5–8') + ' job templates with custom fields'));
  children.push(bullet('Department and location hierarchy setup'));
  children.push(bullet('Template structure and field requirements to be confirmed during Examine Phase'));

  children.push(h3('Application Template'));
  children.push(bullet('1 Application Template [Single Stage only — up to 3 fields additional or amended]'));
  if (a.screening && a.screening.indexOf('not required') < 0) {
    children.push(bullet('Knockout / screening questions: ' + a.screening));
  } else {
    children.push(bullet('Knockout / screening questions: up to 5 standard screening questions per workflow (e.g. right to work, minimum qualifications)'));
  }
  children.push(bullet('Screening question content to be provided by Client prior to configuration'));

  children.push(h3('Offer Management'));
  if (hasOfferMgmt) {
    children.push(bullet('1 Offer Detail Template'));
    children.push(bullet('1 Offer Letter Template'));
    children.push(bullet('Offer approval workflow configuration — approval chain to be confirmed during Examine Phase'));
    if (hasDocuSign) children.push(bullet('E-signature integration (DocuSign) — subject to integration scope below'));
  } else {
    children.push(bullet('Offer management is not in scope for this engagement'));
  }

  children.push(h3('Approval Workflows'));
  children.push(bullet('Requisition approval: ' + (a.reqApproval || 'multi-level approval chain (e.g. Line Manager → HR → Finance)')));
  children.push(bullet('Exact approval chain structure to be confirmed and signed off during Examine Phase before Adopt commences'));
  children.push(bullet('Up to ' + (a.numProcesses || '6–8') + ' approval workflow configurations'));

  children.push(h3('Candidate Profile & Status Pipeline'));
  children.push(bullet('1 Candidate Profile'));
  children.push(bullet('1 Applicant Status Pipeline'));
  children.push(bullet('Candidate profile fields and data capture configuration'));
  children.push(bullet('Status pipeline aligned to agreed route map stages'));
  children.push(bullet('Rejection reason configuration'));

  children.push(h3('Email Templates'));
  children.push(bullet('Up to 20 recruiting email templates (e.g. application received, interview invite, rejection, offer)'));
  children.push(bullet('1 custom declined email template linked to status'));
  children.push(bullet('Client to provide email copy and branding prior to configuration'));

  if (hasAgency) {
    children.push(h3('Agency / Vendor Portal'));
    children.push(bullet('Basic vendor portal configuration including agency account setup and job sharing'));
    children.push(bullet('Agency account setup for up to 5 agreed vendors (client to provide agency list) or training provided on how to set up additional agencies independently'));
    children.push(bullet('Agency submission workflow and visibility controls'));
  }

  children.push(h3('Interview Scheduling'));
  children.push(bullet('Interview scheduling configuration aligned to agreed route map stages'));
  children.push(bullet('Central interview scheduling setup (no Outlook / Google Calendar integration unless separately scoped)'));

  children.push(h3('Referral Management'));
  children.push(bullet('Enablement of SmartRecruiters standard employee referral portal'));
  children.push(bullet('Employees can view open roles, submit referrals, and track referral status natively within the platform'));
  children.push(bullet('Advanced referral programme features (bonus tracking, leaderboards, automated payments) require a third-party Marketplace integration and are out of scope'));

  children.push(h3('Mobile Enablement'));
  children.push(bullet('Mobile enablement for recruiters and hiring managers via SmartRecruiters native mobile application (iOS and Android)'));
  children.push(bullet('Mobile-responsive career site configuration included within career site scope'));

  children.push(h3('Recruiting Posting'));
  children.push(bullet('1 Posting Profile'));
  if (jobBoardsList.length > 0) {
    children.push(bullet('Up to ' + Math.min(jobBoardsList.length, 5) + ' job boards: ' + jobBoardsList.slice(0, 5).join(', ')));
  } else {
    children.push(bullet('Up to 5 job boards (to be confirmed during Examine Phase — e.g. LinkedIn, Indeed, Bayt)'));
  }
  children.push(bullet('Basic field mapping — 5 key fields'));
  children.push(bullet('Internal posting configuration'));
  children.push(bullet('Standard Internal Careers options'));

  children.push(h3('User Accounts & Role-Based Permissions (RBP)'));
  children.push(bullet('Creation of ' + (a.numUsers || 'agreed number of') + ' user accounts'));
  children.push(bullet('1 Recruiter RBP role (minimal admin permissions)'));
  children.push(bullet('RBP configuration per agreed access matrix'));
  children.push(bullet('EX3 to provide RBP design template; Client to complete and sign off before Adopt commences'));

  children.push(h3('Reporting & Analytics'));
  children.push(bullet('Standard SmartRecruiters dashboards and out-of-the-box reports'));
  children.push(bullet('Configuration of agreed saved reports and scheduled report distribution'));
  if (a.reporting && a.reporting.indexOf('Standard') < 0 && a.reporting.indexOf('standard') < 0) {
    children.push(bullet(a.reporting));
  } else {
    children.push(bullet('No custom report development is included'));
  }

  if (hasCareerPage) {
    children.push(h2('Recruiting Marketing / Career Site Scope — EXcelerate Deployment'));
    children.push(bullet('Integration of Recruiting Management and Career Site'));
    children.push(bullet('Field mapping between Recruiting Management and Career Site'));
    children.push(bullet('1 Brand'));
    children.push(bullet('1 Locale (English only)'));
    children.push(bullet('1 Career Site Homepage'));
    children.push(bullet('Up to 8 Category Pages'));
    children.push(bullet('Up to 3 Content Pages'));
    children.push(bullet('Standard career site builder components only — bespoke front-end development is out of scope'));
    children.push(bullet('Standard job search and apply flow'));
    children.push(bullet('Mobile-responsive career site validation'));
    children.push(bullet('Brand application (logo, colours, imagery) — Client to provide all assets prior to configuration'));
  }

  children.push(h2('Integrations Scope — EXcelerate Deployment'));
  children.push(body('The following standard integrations are in scope:'));
  if (integrationsList.length > 0) {
    integrationsList.forEach(i => children.push(bullet(i)));
  } else if (hasSFEC || isMiddleEast) {
    children.push(bullet('Recruitment to Onboarding to Employee Central'));
    children.push(bullet('Integration to Position Management (EC) — requisition creation from approved positions'));
    children.push(bullet('E-signature / DocuSign — to be confirmed during Examine Phase'));
  } else {
    children.push(bullet('No third-party integrations in scope for this engagement'));
  }
  children.push(spacer());
  children.push(body('All integrations use standard SmartRecruiters Marketplace connectors. Custom API builds or non-standard connectors are out of scope and would require a Change Order.'));

  children.push(h2('Data Privacy & Compliance'));
  children.push(bullet('Candidate consent and privacy notice configuration'));
  children.push(bullet('Data retention policy configuration (automated deletion schedules for candidate records)'));
  if (isMiddleEast || complianceList.some(c => c.indexOf('PDPL') >= 0 || c.indexOf('PDPPL') >= 0)) {
    children.push(bullet('Compliance configuration aligned to applicable regional requirements including UAE Personal Data Protection Law (PDPL), Saudi Arabia Personal Data Protection Law (PDPPL), and GDPR where relevant'));
  } else if (complianceList.length > 0) {
    complianceList.forEach(c => children.push(bullet(c)));
  } else {
    children.push(bullet('Standard data privacy defaults will be applied'));
  }
  children.push(bullet('Specific regional compliance requirements to be confirmed during Examine Phase'));

  children.push(h2('Data Migration Scope'));
  if (hasMigration) {
    children.push(bullet(a.dataMigration));
  } else {
    children.push(bullet('Migration of active job requisitions into SmartRecruiters is included in scope'));
  }
  children.push(bullet('Data mapping document to be agreed during Examine Phase'));
  children.push(bullet('Client responsible for data extraction in the EX3-specified format'));
  children.push(bullet('Migration performed in sandbox environment first for validation before cutover'));
  children.push(bullet('Maximum of 1 test cycle and 1 production migration cycle'));

  children.push(h2('Training Scope'));
  if (trainingList.length > 0) {
    trainingList.forEach(t => children.push(bullet(t)));
  } else {
    children.push(bullet('1 Recruiter training session (up to 60 minutes — end-to-end hiring workflow, candidate management, communication tools)'));
    children.push(bullet('1 Administrator training session (up to 90 minutes — system configuration, user management, reporting)'));
    children.push(bullet('1 Hiring Manager training session (up to 45 minutes — job approval, candidate review, interview scheduling)'));
  }
  children.push(bullet('All users receive access to the EX3 SmartRecruiters Enablement Guide'));
  children.push(bullet('Sessions recorded and shared with Client for future reference'));
  children.push(bullet('Training materials provided in advance for pre-reading'));

  children.push(h2('General Scope'));
  children.push(body('Hypercare: ' + (a.hypercare ? a.hypercare + ' of Hypercare Support' : '10 hours or 20 days of Hypercare Support, whichever comes first')));
  children.push(spacer());
  children.push(body('General Assumptions:'));
  children.push(bullet('A 3-tier landscape will be used for the project: DEV, STAGE (Test), and PROD'));
  children.push(bullet(clientName + ' holds a valid SmartRecruiters licence for the project duration including sandbox/test environments required'));
  children.push(bullet('Testing time will be allocated for both EX3 and the Client in each iteration'));
  children.push(spacer());
  children.push(body('Module Assumptions:'));
  children.push(bullet('We assume all requirements can be met by standard SmartRecruiters platform functionality. Use of third-party applications not listed in scope would require a Change Order and may impact timelines and cost'));
  children.push(bullet('New requirements arising during the project will be considered additional scope and will require a Change Request (CR)'));
  children.push(bullet('EX3 is not responsible for managing any 3rd party vendors or issues that can only be resolved by a 3rd party'));
  children.push(bullet('The project will be executed using EX3\'s EXcelerate Methodology, document templates, and delivery project tools (Smartsheet)'));

  // ── OUT OF SCOPE ──────────────────────────────────────────────────────────
  children.push(h1('Out of Scope'));
  children.push(body('Any item, deliverable or activity not explicitly stated as in scope within this section is to be deemed out of scope for this SOW.'));
  children.push(spacer());
  children.push(body('Other examples of items excluded from scope include:'));
  children.push(bullet('SmartRecruiters platform licensing fees (contracted directly between ' + clientName + ' and SmartRecruiters)'));
  children.push(bullet('Any integrations not explicitly listed in the Integrations Scope section'));
  children.push(bullet('Custom API development, bespoke connectors, or non-standard integration builds'));
  children.push(bullet('Outlook or Google Calendar integration for interview scheduling'));
  children.push(bullet('Advanced referral programme features (bonus tracking, leaderboards, automated payments)'));
  children.push(bullet('Ongoing platform administration or managed services after the Hypercare period'));
  children.push(bullet('Additional training sessions beyond those listed in the Training Scope section'));
  children.push(bullet('Custom dashboards and custom reports'));
  children.push(bullet('Any Training Material beyond the EX3 SmartRecruiters Enablement Guide'));
  children.push(bullet('Arabic or any language configuration other than English'));
  children.push(bullet('Countries or languages beyond those agreed in scope'));
  children.push(bullet('Recruitment process design or HR consultancy beyond system configuration'));
  children.push(bullet('Content creation (job descriptions, email copy, brand assets, offer letter text)'));
  children.push(bullet('Change Management consulting, communications development, or iterative process mapping'));
  children.push(bullet('Management of client resources or creation of client internal project plans'));
  children.push(bullet('Changes arising from SmartRecruiters vendor platform updates'));

  // ── LANGUAGES ─────────────────────────────────────────────────────────────
  children.push(h1('Languages'));
  children.push(bullet('Platform language translation: English'));
  children.push(bullet('All communications and deliverables will occur in English'));
  children.push(bullet('The SmartRecruiters career site and all modules will be implemented in English only. Arabic or any additional language configuration is out of scope and would require a Change Order'));

  // ── TESTING RACI ──────────────────────────────────────────────────────────
  children.push(h1('Testing'));
  children.push(raciTable([
    ['Activity', 'EX3', 'Client'],
    ['Iterative Unit Testing', 'Responsible', ''],
    ['Systems Integration Test (where applicable)', 'Responsible', ''],
    ['Creation of Test Users', 'Responsible', ''],
    ['Detailed Test Scenarios in Smartsheets', 'Responsible', ''],
    ['Confirmation of Testing Approach', 'Responsible', ''],
    ['Cutover to TEST', 'Responsible', ''],
    ['Additional smoke testing cycle', '', 'Responsible'],
    ['Cut-over planning', 'Responsible', ''],
    ['Creation of UAT Approach and Plan', '', 'Responsible'],
    ['Coordination of UAT (feedback, defect, calls)', '', 'Responsible'],
    ['UAT execution', '', 'Responsible'],
    ['UAT coordination during UAT', '', 'Responsible'],
    ['Triage / feedback calls with EX3 (daily)', '', 'Responsible'],
    ['Define Test Approach', '', 'Responsible'],
    ['Delivery of Test Strategy Document', '', 'Responsible'],
    ['Click-level Test Scripts', '', 'Responsible'],
    ['Testing Reports for Entry/Exit from each phase', '', 'Responsible'],
    ['All test planning & coordination', '', 'Responsible'],
    ['Full defect management through formal test phases', '', 'Responsible'],
    ['Support for all Test Governance during deployment', '', 'Responsible'],
  ]));

  // ── DATA MIGRATION RACI ───────────────────────────────────────────────────
  children.push(h1('Data Migration'));
  children.push(raciTable([
    ['Activity', 'EX3', 'Client'],
    ['Provision of Data Load Templates', 'Responsible', ''],
    ['Basic data validation (general format checks)', 'Responsible', ''],
    ['Performing Data Loads (1 test + 1 production)', 'Responsible', ''],
    ['Admin Training on BAU data loading', 'Responsible', ''],
    ['Confirmation of Data Migration Approach', 'Responsible', ''],
    ['Coordination of data migration tasks', 'Responsible', ''],
    ['Support for extraction process from client systems', '', 'Responsible'],
    ['Support for governance around data migration', '', 'Responsible'],
    ['Delivery of Data Migration Strategy Document', '', 'Responsible'],
    ['Data Transformation to SmartRecruiters templates', '', 'Responsible'],
    ['Additional cycle of data migration testing', '', 'Responsible'],
    ['Additional training on data loading', '', 'Responsible'],
    ['Data transformation', '', 'Responsible'],
  ]));

  children.push(spacer());
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Prepared by EX3  |  Confidential  |  via EXcelerate', size: 18, color: '888888', italics: true })],
    alignment: AlignmentType.CENTER, spacing: { before: 400, after: 0 }
  }));

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Arial', size: 22 } },
        heading1: { run: { font: 'Arial', size: 28, bold: true, color: '0F0F0F' }, paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { run: { font: 'Arial', size: 24, bold: true, color: '222222' }, paragraph: { spacing: { before: 240, after: 80 } } },
        heading3: { run: { font: 'Arial', size: 22, bold: true, color: '444444' }, paragraph: { spacing: { before: 160, after: 60 } } },
      }
    },
    sections: [{ properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children }],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = 'SOW_' + clientName.replace(/[^a-z0-9]/gi, '_') + '.docx';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(buffer);
});

// SOW Email
app.post('/consultant/sow-email', async (req, res) => {
  const { content, clientName, toEmail } = req.body;
  if (!content || !toEmail) return res.status(400).json({ error: 'Missing fields' });

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'EX3 Consulting <onboarding@resend.dev>',
        to: [toEmail],
        subject: 'Statement of Work — SmartRecruiters Implementation — ' + (clientName || 'Client'),
        text: content,
        html: '<pre style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;white-space:pre-wrap">' + content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>',
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Send failed');
    res.json({ ok: true });
  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// SOW Builder
app.get('/consultant/sow-builder', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SOW Builder — EX3</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:#f8f7f4;color:#0f0f0e;min-height:100vh;display:flex;flex-direction:column}
    .topbar{background:#0f0f0f;color:#fff;padding:14px 32px;display:flex;align-items:center;justify-content:space-between}
    .topbar .logo{font-size:24px;font-weight:900;letter-spacing:-.1em}
    .topbar a{color:#aaa;font-size:13px;text-decoration:none;transition:color .15s}
    .topbar a:hover{color:#fff}
    .progress-wrap{background:#1a1a1a;padding:0 32px}
    .progress-bar{height:3px;background:#333;border-radius:2px;overflow:hidden}
    .progress-fill{height:100%;background:#fff;border-radius:2px;transition:width .4s ease}
    .progress-label{padding:8px 0;font-size:11px;color:#888;letter-spacing:.06em;text-transform:uppercase}
    .wizard{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 20px}
    .card{background:#fff;border:1px solid #e4e2dc;border-radius:14px;padding:40px 44px;width:100%;max-width:620px;box-shadow:0 2px 16px rgba(0,0,0,.06)}
    .step{display:none}.step.active{display:block}
    .step-num{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#aaa;margin-bottom:10px}
    .step h2{font-size:24px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px}
    .step p{font-size:14px;color:#666;margin-bottom:28px;line-height:1.6}
    .options{display:flex;flex-direction:column;gap:10px}
    .opt{display:flex;align-items:center;gap:14px;padding:14px 18px;border:1.5px solid #e4e2dc;border-radius:10px;cursor:pointer;transition:all .15s;font-size:14px;font-weight:500}
    .opt:hover{border-color:#0f0f0f;background:#fafafa}
    .opt.sel{border-color:#0f0f0f;background:#0f0f0f;color:#fff}
    .opt .opt-icon{font-size:20px;flex-shrink:0;width:28px;text-align:center}
    .opt-multi{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .opt-multi .opt{padding:12px 14px;font-size:13px}
    .custom-input{margin-top:12px;display:none}
    .custom-input.show{display:block}
    .custom-input input,.custom-input textarea{width:100%;padding:12px 16px;border:1.5px solid #e4e2dc;border-radius:8px;font-family:inherit;font-size:14px;color:#0f0f0f;outline:none;transition:border-color .15s;resize:vertical}
    .custom-input input:focus,.custom-input textarea:focus{border-color:#0f0f0f}
    .nav{display:flex;justify-content:space-between;align-items:center;margin-top:32px}
    .btn{padding:12px 28px;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
    .btn-primary{background:#0f0f0f;color:#fff}
    .btn-primary:hover{background:#333}
    .btn-secondary{background:transparent;color:#888;border:1.5px solid #e4e2dc}
    .btn-secondary:hover{border-color:#0f0f0f;color:#0f0f0f}
    .btn:disabled{opacity:.4;cursor:not-allowed}
    /* SOW Output */
    .sow-output{display:none}
    .sow-output.show{display:block}
    .sow-doc{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:40px;line-height:1.8;font-size:14px;white-space:pre-wrap;font-family:'Inter',system-ui,sans-serif;color:#0f0f0e}
    .sow-actions{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;background:#f0fdf6;color:#0d7c4c;margin-bottom:16px}
    .wizard-wrap{max-width:700px;width:100%}
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">ex3</div>
    <a href="/consultant">← Back to Consultant Portal</a>
  </div>
  <div class="progress-wrap">
    <div class="progress-label" id="progress-label">Step 1 of 19</div>
    <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:5%"></div></div>
  </div>

  <div class="wizard">
    <div class="wizard-wrap">

      <!-- Risk banner -->
      <div id="risk-banner" style="display:none;margin-bottom:16px;padding:14px 18px;border-radius:10px;font-size:13px;line-height:1.6"></div>

      <!-- SOW Output (shown at end) -->
      <div class="sow-output" id="sow-output">
        <span class="badge">SOW Generated</span>
        <h2 style="font-size:26px;font-weight:700;margin-bottom:6px;letter-spacing:-.02em">Your Statement of Work</h2>
        <p style="font-size:14px;color:#666;margin-bottom:20px">Review and edit below, then copy, export or email directly to the client.</p>
        <div class="sow-actions">
          <button class="btn btn-primary" onclick="copySow()">📋 Copy</button>
          <button class="btn btn-primary" style="background:#0d7c4c" onclick="exportWord()">⬇️ Export Word</button>
          <button class="btn btn-primary" style="background:#6b21a8" onclick="generateWithAI()">✨ Rewrite with AI</button>
          <button class="btn btn-secondary" onclick="showEmailForm()">📧 Email to client</button>
          <button class="btn btn-secondary" onclick="restartWizard()">↩ Start Again</button>
        </div>
        <div id="email-form" style="display:none;background:#f8f7f4;border:1px solid #e4e2dc;border-radius:10px;padding:20px;margin-bottom:16px">
          <p style="font-size:13px;font-weight:600;margin-bottom:12px">Send SOW by email</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <input id="email-to" type="email" placeholder="Client email address" style="flex:1;min-width:200px;padding:10px 14px;border:1.5px solid #e4e2dc;border-radius:8px;font-family:inherit;font-size:13px;outline:none">
            <button class="btn btn-primary" onclick="sendEmail()">Send</button>
          </div>
          <p id="email-status" style="font-size:12px;margin-top:8px;color:#888"></p>
        </div>
        <div id="ai-status" style="display:none;padding:12px 16px;background:#faf5ff;border:1px solid #ddd6fe;border-radius:8px;margin-bottom:16px;font-size:13px;color:#6b21a8">✨ AI is rewriting your SOW in professional language...</div>
        <div class="sow-doc" id="sow-doc" contenteditable="true"></div>
      </div>

      <!-- Wizard Card -->
      <div class="card" id="wizard-card">

        <!-- Step 1: Client Name -->
        <div class="step active" id="step-1">
          <div class="step-num">Step 1 of 19</div>
          <h2>What's the client's name?</h2>
          <p>This will appear throughout the SOW document.</p>
          <input type="text" id="client-name" placeholder="e.g. Acme Corporation" style="width:100%;padding:14px 18px;border:1.5px solid #e4e2dc;border-radius:10px;font-family:inherit;font-size:15px;outline:none" oninput="answers.clientName=this.value" onfocus="this.style.borderColor='#0f0f0f'" onblur="this.style.borderColor='#e4e2dc'">
        </div>

        <!-- Step 2: Org Size -->
        <div class="step" id="step-2">
          <div class="step-num">Step 2 of 19</div>
          <h2>How large is the organisation?</h2>
          <p>This helps set expectations on implementation complexity.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'orgSize','Small (under 100 employees)')"><span class="opt-icon">🏢</span>Small — under 100 employees</div>
            <div class="opt" onclick="selectOpt(this,'orgSize','Mid-size (100–500 employees)')"><span class="opt-icon">🏬</span>Mid-size — 100 to 500 employees</div>
            <div class="opt" onclick="selectOpt(this,'orgSize','Large (500–2,000 employees)')"><span class="opt-icon">🏭</span>Large — 500 to 2,000 employees</div>
            <div class="opt" onclick="selectOpt(this,'orgSize','Enterprise (2,000+ employees)')"><span class="opt-icon">🌐</span>Enterprise — 2,000+ employees</div>
          </div>
        </div>

        <!-- Step 3: Number of users -->
        <div class="step" id="step-3">
          <div class="step-num">Step 3 of 19</div>
          <h2>How many users will need access?</h2>
          <p>Include all recruiters, hiring managers, and admins.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'numUsers','up to 25 users')"><span class="opt-icon">👤</span>Up to 25 users</div>
            <div class="opt" onclick="selectOpt(this,'numUsers','25–50 users')"><span class="opt-icon">👥</span>25 to 50 users</div>
            <div class="opt" onclick="selectOpt(this,'numUsers','50–100 users')"><span class="opt-icon">👨‍👩‍👧‍👦</span>50 to 100 users</div>
            <div class="opt" onclick="selectOpt(this,'numUsers','over 100 users')"><span class="opt-icon">🏟️</span>Over 100 users</div>
            <div class="opt" onclick="selectCustom(this,'numUsers-custom')"><span class="opt-icon">✏️</span>Custom number</div>
          </div>
          <div class="custom-input" id="numUsers-custom">
            <input type="text" placeholder="e.g. 37 users" oninput="answers.numUsers=this.value">
          </div>
        </div>

        <!-- Step 4: Hiring Processes -->
        <div class="step" id="step-4">
          <div class="step-num">Step 4 of 19</div>
          <h2>How many hiring process workflows are needed?</h2>
          <p>Different job types often have different hiring stages (e.g. office vs warehouse vs graduate).</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'numProcesses','1–2 hiring process workflows')"><span class="opt-icon">1️⃣</span>1 to 2 workflows</div>
            <div class="opt" onclick="selectOpt(this,'numProcesses','3–5 hiring process workflows')"><span class="opt-icon">3️⃣</span>3 to 5 workflows</div>
            <div class="opt" onclick="selectOpt(this,'numProcesses','6–10 hiring process workflows')"><span class="opt-icon">🔢</span>6 to 10 workflows</div>
            <div class="opt" onclick="selectCustom(this,'numProcesses-custom')"><span class="opt-icon">✏️</span>Custom number</div>
          </div>
          <div class="custom-input" id="numProcesses-custom">
            <input type="text" placeholder="e.g. 8 workflows" oninput="answers.numProcesses=this.value">
          </div>
        </div>

        <!-- Step 5: Job templates -->
        <div class="step" id="step-5">
          <div class="step-num">Step 5 of 19</div>
          <h2>How many job templates are required?</h2>
          <p>Job templates speed up requisition creation for common roles.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'numTemplates','up to 5 job templates')"><span class="opt-icon">📄</span>Up to 5 templates</div>
            <div class="opt" onclick="selectOpt(this,'numTemplates','5–10 job templates')"><span class="opt-icon">📋</span>5 to 10 templates</div>
            <div class="opt" onclick="selectOpt(this,'numTemplates','10–20 job templates')"><span class="opt-icon">📚</span>10 to 20 templates</div>
            <div class="opt" onclick="selectOpt(this,'numTemplates','no job templates required at this stage')"><span class="opt-icon">❌</span>None required</div>
            <div class="opt" onclick="selectCustom(this,'numTemplates-custom')"><span class="opt-icon">✏️</span>Custom number</div>
          </div>
          <div class="custom-input" id="numTemplates-custom">
            <input type="text" placeholder="e.g. 15 templates" oninput="answers.numTemplates=this.value">
          </div>
        </div>

        <!-- Step 6: Integrations -->
        <div class="step" id="step-6">
          <div class="step-num">Step 6 of 19</div>
          <h2>Which integrations are required?</h2>
          <p>Select all that apply. Each integration adds complexity and time.</p>
          <div class="options opt-multi" id="integrations-options">
            <div class="opt" onclick="toggleMulti(this,'integrations','SAP SuccessFactors Employee Central (EC) integration — recruitment to onboarding to EC')">🔗 SAP SuccessFactors EC</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','Position Management (EC) integration — requisition creation from approved positions')">📋 Position Management (EC)</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','Onboarding integration — hired candidate data passed to onboarding system')">🚀 Onboarding integration</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','DocuSign / e-signature integration')">✍️ DocuSign / e-signature</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','HRIS integration (e.g. Workday, SAP, BambooHR)')">🗄️ Other HRIS System</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','Single Sign-On (SSO)')">🔐 SSO</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','background screening integration')">🔍 Background Screening</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','video interviewing platform integration')">🎥 Video Interviews</div>
          </div>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
            <div class="opt" onclick="selectOpt(this,'integrations','no third-party integrations required')">❌ No integrations needed</div>
            <div class="opt" onclick="toggleCustomMulti(this,'integrations','integrations-other-input')">✏️ Other / not listed</div>
          </div>
          <div class="custom-input" id="integrations-other-input">
            <input type="text" placeholder="e.g. Greenhouse, Workable, Microsoft Teams…" oninput="setCustomMulti('integrations','integrations-other-val',this.value)">
          </div>
        </div>

        <!-- Step 7: Job Boards -->
        <div class="step" id="step-7">
          <div class="step-num">Step 7 of 19</div>
          <h2>Which job boards need connecting?</h2>
          <p>Select all that apply. Job board credentials will need to be provided by the client.</p>
          <div class="options opt-multi" id="jobboards-options">
            <div class="opt" onclick="toggleMulti(this,'jobBoards','LinkedIn')">LinkedIn</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Indeed')">Indeed</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Bayt')">Bayt</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Naukri Gulf')">Naukri Gulf</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Glassdoor')">Glassdoor</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Wuzzuf')">Wuzzuf</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Reed')">Reed</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Totaljobs')">Totaljobs</div>
          </div>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
            <div class="opt" onclick="selectOpt(this,'jobBoards','no job board connections required at this stage')">❌ None at this stage</div>
            <div class="opt" onclick="toggleCustomMulti(this,'jobBoards','jobboards-other-input')">✏️ Other / not listed</div>
          </div>
          <div class="custom-input" id="jobboards-other-input">
            <input type="text" placeholder="e.g. Bayt, Naukri Gulf, Wuzzuf, Monster…" oninput="setCustomMulti('jobBoards','jobboards-other-val',this.value)">
          </div>
        </div>

        <!-- Step 8: Career Page -->
        <div class="step" id="step-8">
          <div class="step-num">Step 8 of 19</div>
          <h2>Is career page branding in scope?</h2>
          <p>This covers setting up the SmartRecruiters hosted careers page with the client's logo, colours, and imagery.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'careerPage','Configuration and branding of the SmartRecruiters careers page is included in scope. The client will provide brand assets (logo, colour palette, imagery) prior to configuration.')">✅ Yes — brand and configure the careers page</div>
            <div class="opt" onclick="selectOpt(this,'careerPage','Career page setup is not in scope for this engagement.')">❌ No — out of scope</div>
            <div class="opt" onclick="selectOpt(this,'careerPage','Basic career page configuration is included (logo and colour only). Full creative design is out of scope.')">🎨 Basic only — logo and colours only</div>
          </div>
        </div>

        <!-- Step 9: Data Migration -->
        <div class="step" id="step-9">
          <div class="step-num">Step 9 of 19</div>
          <h2>Is data migration required?</h2>
          <p>Moving historical jobs, candidates, or offer data from an existing system into SmartRecruiters.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'dataMigration','Data migration is not in scope for this engagement. Historical data will remain in the client\\'s existing system.')">❌ No migration needed</div>
            <div class="opt" onclick="selectOpt(this,'dataMigration','Migration of active job requisitions into SmartRecruiters is included in scope.')">📋 Active jobs only</div>
            <div class="opt" onclick="selectOpt(this,'dataMigration','Migration of candidate records is included in scope, subject to a data mapping exercise to be completed during discovery.')">👤 Candidate records</div>
            <div class="opt" onclick="selectOpt(this,'dataMigration','Migration of both active job requisitions and candidate records is included in scope, subject to a data mapping exercise to be completed during discovery.')">📦 Both jobs and candidates</div>
          </div>
        </div>

        <!-- Step 10: Training -->
        <div class="step" id="step-10">
          <div class="step-num">Step 10 of 19</div>
          <h2>Which training sessions are required?</h2>
          <p>Select all that apply. Each session is role-specific and delivered separately.</p>
          <div class="options opt-multi">
            <div class="opt" onclick="toggleMulti(this,'training','One Administrator training session (up to 90 minutes, covering system configuration, user management, and reporting)')">🔧 Administrator (90 mins)</div>
            <div class="opt" onclick="toggleMulti(this,'training','One Recruiter training session (up to 60 minutes, covering end-to-end hiring workflow, candidate management, and communication tools)')">📞 Recruiter (60 mins)</div>
            <div class="opt" onclick="toggleMulti(this,'training','One Hiring Manager training session (up to 45 minutes, covering job approval, candidate review, and interview scheduling)')">👔 Hiring Manager (45 mins)</div>
          </div>
        </div>

        <!-- Step 11: Hypercare -->
        <div class="step" id="step-11">
          <div class="step-num">Step 11 of 19</div>
          <h2>How long is the hypercare period?</h2>
          <p>Hypercare is the close-support window immediately after go-live where your team is on hand to resolve issues quickly.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'hypercare','2 weeks')">⚡ 2 weeks — standard</div>
            <div class="opt" onclick="selectOpt(this,'hypercare','4 weeks')">🛡️ 4 weeks — recommended for larger orgs</div>
            <div class="opt" onclick="selectOpt(this,'hypercare','6 weeks')">🔒 6 weeks — enterprise / complex implementations</div>
            <div class="opt" onclick="selectCustom(this,'hypercare-custom')">✏️ Custom</div>
          </div>
          <div class="custom-input" id="hypercare-custom">
            <input type="text" placeholder="e.g. 3 weeks" oninput="answers.hypercare=this.value">
          </div>
        </div>

        <!-- Step 12: Timeline -->
        <div class="step" id="step-12">
          <div class="step-num">Step 12 of 19</div>
          <h2>What is the expected project timeline?</h2>
          <p>From kickoff to go-live. This will appear in the SOW assumptions.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'timeline','8 weeks')">🚀 8 weeks — small / simple implementation</div>
            <div class="opt" onclick="selectOpt(this,'timeline','10 weeks')">📅 10 weeks — standard implementation</div>
            <div class="opt" onclick="selectOpt(this,'timeline','12 weeks')">🗓️ 12 weeks — larger or more complex</div>
            <div class="opt" onclick="selectOpt(this,'timeline','16 weeks')">📆 16 weeks — enterprise / heavily integrated</div>
            <div class="opt" onclick="selectCustom(this,'timeline-custom')">✏️ Custom</div>
          </div>
          <div class="custom-input" id="timeline-custom">
            <input type="text" placeholder="e.g. 14 weeks" oninput="answers.timeline=this.value">
          </div>
        </div>

        <!-- Step 13: Requisition Approval Workflows -->
        <div class="step" id="step-13">
          <div class="step-num">Step 13 of 19</div>
          <h2>How are job requisitions approved before posting?</h2>
          <p>Defines the approval chain a recruiter must go through before a job goes live.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'reqApproval','No approval workflow required — recruiters can post jobs directly without sign-off.')"><span class="opt-icon">⚡</span>No approval — post directly</div>
            <div class="opt" onclick="selectOpt(this,'reqApproval','A single-level approval workflow is required (e.g. line manager or HR Director approves each requisition before posting).')"><span class="opt-icon">1️⃣</span>Single approver (e.g. HR Director)</div>
            <div class="opt" onclick="selectOpt(this,'reqApproval','A multi-level approval workflow is required (e.g. Line Manager → HR → Finance). The exact approval chain will be confirmed during discovery.')"><span class="opt-icon">🔗</span>Multi-level (e.g. Manager → HR → Finance)</div>
            <div class="opt" onclick="selectOpt(this,'reqApproval','Approval workflows vary by role type or department. Configuration of multiple approval chains is in scope, subject to discovery.')"><span class="opt-icon">🗂️</span>Different chains per department/role type</div>
          </div>
        </div>

        <!-- Step 14: Offer Management -->
        <div class="step" id="step-14">
          <div class="step-num">Step 14 of 19</div>
          <h2>Is offer management in scope?</h2>
          <p>SmartRecruiters can manage the full offer lifecycle — templates, approval, e-signature, and candidate acceptance — all in-platform.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'offerMgmt','Offer management is not in scope for this engagement. Offers will be managed outside of SmartRecruiters.')"><span class="opt-icon">❌</span>Not in scope — offers managed externally</div>
            <div class="opt" onclick="selectOpt(this,'offerMgmt','Configuration of offer letter templates is included in scope. Approval and e-signature are not required.')"><span class="opt-icon">📄</span>Offer templates only</div>
            <div class="opt" onclick="selectOpt(this,'offerMgmt','Full offer management is in scope: offer letter templates, an offer approval workflow, and integration with e-signature (DocuSign or equivalent).')"><span class="opt-icon">✅</span>Full — templates + approval + e-signature</div>
            <div class="opt" onclick="selectCustom(this,'offerMgmt-custom')"><span class="opt-icon">✏️</span>Custom — describe below</div>
          </div>
          <div class="custom-input" id="offerMgmt-custom">
            <textarea placeholder="Describe the offer management requirements…" rows="3" oninput="answers.offerMgmt=this.value"></textarea>
          </div>
        </div>

        <!-- Step 15: Pre-screening questions -->
        <div class="step" id="step-15">
          <div class="step-num">Step 15 of 19</div>
          <h2>Are pre-screening or knockout questions required?</h2>
          <p>These are questions candidates must answer when applying — wrong answers can auto-reject them before a recruiter reviews.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'screening','No pre-screening or knockout questions are required at this stage.')"><span class="opt-icon">❌</span>Not required</div>
            <div class="opt" onclick="selectOpt(this,'screening','Basic knockout questions are required (e.g. right to work, minimum qualifications). Configuration of up to 5 standard screening questions per workflow is in scope.')"><span class="opt-icon">✅</span>Basic knockout questions (right to work, qualifications)</div>
            <div class="opt" onclick="selectOpt(this,'screening','Role-specific pre-screening question sets are required for each hiring workflow. The exact questions will be agreed during discovery. Configuration of all question sets is in scope.')"><span class="opt-icon">🎯</span>Role-specific screeners per workflow</div>
            <div class="opt" onclick="selectOpt(this,'screening','A full application form with multi-section screening questions and automatic scoring is required. This will be scoped in detail during the discovery phase.')"><span class="opt-icon">📝</span>Full scored application form</div>
          </div>
        </div>

        <!-- Step 16: Reporting & Analytics -->
        <div class="step" id="step-16">
          <div class="step-num">Step 16 of 19</div>
          <h2>What level of reporting is required?</h2>
          <p>From standard dashboards to fully custom exec-level analytics.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'reporting','Standard SmartRecruiters dashboards and out-of-the-box reports will be used. No custom report configuration is required.')"><span class="opt-icon">📊</span>Standard dashboards only</div>
            <div class="opt" onclick="selectOpt(this,'reporting','Configuration of custom reports is in scope. Up to 5 custom report templates will be created based on requirements agreed during discovery.')"><span class="opt-icon">📈</span>Custom reports (up to 5 agreed templates)</div>
            <div class="opt" onclick="selectOpt(this,'reporting','Executive-level dashboards and custom KPI reports are required. Reporting requirements will be captured during discovery and agreed prior to build.')"><span class="opt-icon">🏆</span>Exec dashboards and custom KPIs</div>
            <div class="opt" onclick="selectOpt(this,'reporting','Business intelligence (BI) tool integration is required (e.g. Power BI, Tableau, Looker). This will be scoped separately.')"><span class="opt-icon">🔌</span>BI tool integration (Power BI, Tableau etc.)</div>
          </div>
        </div>

        <!-- Step 17: GDPR & Compliance -->
        <div class="step" id="step-17">
          <div class="step-num">Step 17 of 19</div>
          <h2>What compliance and data privacy configuration is needed?</h2>
          <p>Select all that apply. GDPR configuration is strongly recommended for all UK/EU clients.</p>
          <div class="options opt-multi" id="compliance-options">
            <div class="opt" onclick="toggleMulti(this,'compliance','Candidate consent and privacy notice configuration')">✅ Candidate consent notices</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','Data retention policy configuration (automated deletion schedules for candidate records)')">🗑️ Data retention policy</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','UAE Personal Data Protection Law (PDPL) compliance configuration')">🇦🇪 UAE PDPL</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','Saudi Arabia Personal Data Protection Law (PDPPL) compliance configuration')">🇸🇦 Saudi PDPPL</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','GDPR compliance configuration (EU/UK)')">🇪🇺 GDPR</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','EEO / diversity monitoring data collection setup')">📋 EEO / diversity monitoring</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','Audit trail and access log configuration')">🔍 Audit trail setup</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','ISO 27001 / SOC 2 evidence documentation support')">🔒 ISO 27001 / SOC 2 support</div>
          </div>
          <div style="margin-top:10px">
            <div class="opt" onclick="selectOpt(this,'compliance','No specific compliance or data privacy configuration is required beyond platform defaults.')">❌ No specific compliance requirements</div>
          </div>
        </div>

        <!-- Step 18: Multi-country / International -->
        <div class="step" id="step-18">
          <div class="step-num">Step 18 of 19</div>
          <h2>What is the geographic scope of the implementation?</h2>
          <p>Multi-country or multilingual setups require additional configuration time.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'geoScope','The implementation is for a single country with a single language (English). No multi-country or multi-language configuration is required.');hideGeoCustom()"><span class="opt-icon">🏢</span>Single country — English only</div>
            <div class="opt" onclick="selectOpt(this,'geoScope','The implementation covers multiple European markets. Multi-country configuration and at least one additional language is in scope. Specific countries and languages will be confirmed during discovery.');hideGeoCustom()"><span class="opt-icon">🇪🇺</span>Multiple European markets</div>
            <div class="opt" onclick="selectOpt(this,'geoScope','The implementation is global in scope. Multi-region configuration, timezone support, and multiple languages are required. Full scope will be confirmed during discovery.');hideGeoCustom()"><span class="opt-icon">🌍</span>Global — multiple regions and languages</div>
            <div class="opt" id="geo-custom-trigger" onclick="selectCustomGeo(this)"><span class="opt-icon">✏️</span>Other / Custom — specify regions below</div>
          </div>
          <div class="custom-input" id="geoScope-custom" style="margin-top:14px">
            <div id="geo-entries" style="display:flex;flex-direction:column;gap:8px"></div>
            <button type="button" onclick="addGeoEntry()" style="margin-top:8px;padding:7px 14px;border:1.5px dashed #ccc;border-radius:8px;background:none;font-family:inherit;font-size:13px;color:#666;cursor:pointer;transition:all .15s" onmouseover="this.style.borderColor='#0f0f0f';this.style.color='#0f0f0f'" onmouseout="this.style.borderColor='#ccc';this.style.color='#666'">＋ Add another region</button>
          </div>
        </div>

        <!-- Step 19: Agency / Vendor Portal -->
        <div class="step" id="step-19">
          <div class="step-num">Step 19 of 19</div>
          <h2>Do you work with external recruitment agencies?</h2>
          <p>SmartRecruiters has a built-in vendor/agency portal for managing third-party recruiters and their submissions.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'agencyPortal','No external recruitment agencies are used. Agency/vendor portal configuration is not in scope.')"><span class="opt-icon">❌</span>No agencies used</div>
            <div class="opt" onclick="selectOpt(this,'agencyPortal','External agencies are used. Basic vendor portal configuration is in scope, including agency account setup and job sharing. The number of agencies will be confirmed during discovery.')"><span class="opt-icon">🤝</span>Yes — basic agency portal setup</div>
            <div class="opt" onclick="selectOpt(this,'agencyPortal','External agencies are a core part of the hiring strategy. Full vendor management configuration is in scope: agency tiers, submission rules, fee agreements, and communication workflows.')"><span class="opt-icon">🏢</span>Yes — full vendor management (tiers, fees, rules)</div>
          </div>
        </div>

        <div class="nav">
          <button class="btn btn-secondary" id="btn-back" onclick="prevStep()" style="display:none">← Back</button>
          <button class="btn btn-primary" id="btn-next" onclick="nextStep()">Next →</button>
        </div>
      </div>

    </div>
  </div>

<script>
  const TOTAL = 19;
  let current = 1;
  const answers = {
    clientName: '', orgSize: '', numUsers: '', numProcesses: '',
    numTemplates: '', integrations: [], jobBoards: [], careerPage: '',
    dataMigration: '', training: [], hypercare: '', timeline: '',
    reqApproval: '', offerMgmt: '', screening: '', reporting: '',
    compliance: [], geoScope: '', agencyPortal: ''
  };

  function selectOpt(el, key, value) {
    // Deselect all in same step
    el.closest('.step').querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
    el.classList.add('sel');
    answers[key] = value;
    // Hide all custom inputs in this step
    el.closest('.step').querySelectorAll('.custom-input').forEach(c => c.classList.remove('show'));
  }

  function selectCustom(el, inputId) {
    el.closest('.step').querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
    el.classList.add('sel');
    const inp = document.getElementById(inputId);
    inp.classList.add('show');
    inp.querySelector('input,textarea').focus();
  }

  function selectCustomGeo(el) {
    el.closest('.step').querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
    el.classList.add('sel');
    const wrap = document.getElementById('geoScope-custom');
    wrap.classList.add('show');
    const entries = document.getElementById('geo-entries');
    if (entries.children.length === 0) addGeoEntry();
    else entries.querySelector('input').focus();
  }

  function hideGeoCustom() {
    const wrap = document.getElementById('geoScope-custom');
    if (wrap) wrap.classList.remove('show');
  }

  function addGeoEntry() {
    const entries = document.getElementById('geo-entries');
    const idx = entries.children.length;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const placeholders = [
      'e.g. Middle East (UAE, KSA, Oman, Jordan, Lebanon, Iraq) — English only, UAE PDPL & Saudi PDPPL apply',
      'e.g. UK & Ireland — English only',
      'e.g. Germany — German + English, GDPR applies',
      'e.g. APAC — Singapore, Australia, Hong Kong',
    ];
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = placeholders[idx] || 'e.g. Country / region — language, compliance notes';
    inp.style.cssText = 'flex:1;padding:10px 14px;border:1.5px solid #e4e2dc;border-radius:8px;font-family:inherit;font-size:13px;color:#0f0f0f;outline:none';
    inp.onfocus = function(){ this.style.borderColor='#0f0f0f'; };
    inp.onblur  = function(){ this.style.borderColor='#e4e2dc'; };
    inp.oninput = updateGeoScope;
    if (idx > 0) {
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Remove';
      del.style.cssText = 'padding:6px 10px;border:1.5px solid #e4e2dc;border-radius:6px;background:none;font-size:12px;color:#999;cursor:pointer;flex-shrink:0';
      del.onclick = function(){ row.remove(); updateGeoScope(); };
      row.appendChild(inp);
      row.appendChild(del);
    } else {
      row.appendChild(inp);
    }
    entries.appendChild(row);
    inp.focus();
  }

  function updateGeoScope() {
    const inputs = document.querySelectorAll('#geo-entries input');
    const vals = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
    answers.geoScope = vals.length ? vals.join('; ') : '';
  }

  function toggleMulti(el, key, value) {
    el.classList.toggle('sel');
    if (!Array.isArray(answers[key])) answers[key] = [];
    if (el.classList.contains('sel')) {
      if (!answers[key].includes(value)) answers[key].push(value);
    } else {
      answers[key] = answers[key].filter(v => v !== value);
    }
  }

  function toggleCustomMulti(el, key, inputId) {
    el.classList.toggle('sel');
    const inp = document.getElementById(inputId);
    inp.classList.toggle('show', el.classList.contains('sel'));
    if (el.classList.contains('sel')) inp.querySelector('input').focus();
    else {
      // Remove custom value from array
      if (Array.isArray(answers[key])) {
        answers[key] = answers[key].filter(v => !v.startsWith('Other:'));
      }
    }
  }

  function setCustomMulti(key, valId, value) {
    if (!Array.isArray(answers[key])) answers[key] = [];
    answers[key] = answers[key].filter(v => !v.startsWith('Other:'));
    if (value.trim()) answers[key].push('Other: ' + value.trim());
  }

  function updateProgress() {
    const pct = Math.round((current / TOTAL) * 100);
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-label').textContent = 'Step ' + current + ' of ' + TOTAL;
    document.getElementById('btn-back').style.display = current > 1 ? 'block' : 'none';
    document.getElementById('btn-next').textContent = current === TOTAL ? 'Generate SOW ✨' : 'Next →';
  }

  function nextStep() {
    // Validate step 1
    if (current === 1) {
      const inp = document.getElementById('client-name');
      const val = inp.value.trim();
      if (!val) {
        inp.style.borderColor = '#ef4444';
        inp.placeholder = 'Please enter the client name to continue';
        inp.focus();
        setTimeout(() => { inp.style.borderColor = '#e4e2dc'; inp.placeholder = 'e.g. Acme Corporation'; }, 3000);
        return;
      }
      answers.clientName = val;
    }
    if (current === TOTAL) {
      generateSOW();
      return;
    }
    document.getElementById('step-' + current).classList.remove('active');
    current++;
    document.getElementById('step-' + current).classList.add('active');
    updateProgress();
  }

  function prevStep() {
    document.getElementById('step-' + current).classList.remove('active');
    current--;
    document.getElementById('step-' + current).classList.add('active');
    updateProgress();
  }

  function generateSOW() {
    var a = answers;
    var L = [];
    function add(s) { L.push(s !== undefined ? s : ''); }

    var intCount = Array.isArray(a.integrations) ? a.integrations.length : 0;
    var integrationsList = Array.isArray(a.integrations) ? a.integrations : [];
    var jobBoardsList = Array.isArray(a.jobBoards) ? a.jobBoards : [];
    var trainingList = Array.isArray(a.training) ? a.training : [];
    var complianceList = Array.isArray(a.compliance) ? a.compliance : [];

    var isEnterprise = !!(a.orgSize && (a.orgSize.indexOf('Enterprise') >= 0 || a.orgSize.indexOf('2,001') >= 0));
    var hasMigration = !!(a.dataMigration && a.dataMigration.toLowerCase().indexOf('not in scope') < 0 && a.dataMigration.toLowerCase().indexOf('no migration') < 0 && a.dataMigration.toLowerCase().indexOf('no data') < 0);
    var isMiddleEast = !!(a.geoScope && a.geoScope.indexOf('Middle East') >= 0);
    var isMultiCountry = !!(a.geoScope && a.geoScope.indexOf('single country') < 0);
    var hasFullOffer = !!(a.offerMgmt && (a.offerMgmt.indexOf('Full offer') >= 0 || a.offerMgmt.indexOf('full') >= 0));
    var hasMultiApproval = !!(a.reqApproval && (a.reqApproval.indexOf('multi-level') >= 0 || a.reqApproval.indexOf('different chains') >= 0));
    var hasAgency = !!(a.agencyPortal && a.agencyPortal.indexOf('No external') < 0);
    var hasCareerPage = !!(a.careerPage && a.careerPage.indexOf('not in scope') < 0 && a.careerPage.indexOf('not required') < 0);
    var hasOfferMgmt = !!(a.offerMgmt && a.offerMgmt.indexOf('Not in scope') < 0 && a.offerMgmt.indexOf('not in scope') < 0);
    var hasDocuSign = integrationsList.some(function(i){ return i.indexOf('DocuSign') >= 0 || i.indexOf('e-signature') >= 0; });
    var hasSFEC = integrationsList.some(function(i){ return i.indexOf('Employee Central') >= 0 || i.indexOf('SAP SuccessFactors') >= 0; });
    var hasPositionMgmt = integrationsList.some(function(i){ return i.indexOf('Position Management') >= 0; });
    var hasOnboarding = integrationsList.some(function(i){ return i.indexOf('Onboarding') >= 0 || i.indexOf('onboarding') >= 0; });

    var now = new Date();
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var dateStr = now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
    var clientName = a.clientName || 'To be confirmed';
    var clientUpper = clientName.toUpperCase();

    // ── HEADER ──────────────────────────────────────────────────────────────
    add('SmartRecruiters Recruiting Implementation');
    add('via EXcelerate');
    add('');
    add('Client:      ' + clientName);
    add('Prepared by: EX3');
    add('Date:        ' + dateStr);
    add('Version:     1.0 (Draft)');
    add('');

    // ── OVERVIEW ─────────────────────────────────────────────────────────────
    add('Overview');
    add('────────────────────────────────────────────────────────────────────────');
    add('');
    add('EX3 has been asked to provide a Statement of Work for the SmartRecruiters');
    add('implementation for ' + clientName + '. This section outlines the scope,');
    add('methodology, responsibilities, and deliverables for the SmartRecruiters');
    add('deployment.');
    add('');
    add('The modules in scope for this workstream are:');
    add('  • SmartRecruiters Recruiting Management (SMRC)');
    if (hasCareerPage) add('  • Career Site / Recruiting Marketing configuration');
    if (integrationsList.length > 0) add('  • Integration to ' + (hasSFEC ? 'Employee Central (EC), Position Management, and Onboarding' : integrationsList.join('; ')));
    add('');
    if (isMiddleEast) {
      add('The countries in scope are:');
      add('  • United Arab Emirates, Saudi Arabia, Oman, Jordan, Lebanon and Iraq');
      add('');
    } else if (a.geoScope) {
      add('Geography: ' + a.geoScope);
      add('');
    }
    add('EX3 will apply the EXcelerate methodology, which is optimised for rapid');
    add('deployment using model company content. EXcelerate is designed to deliver a');
    add('high-quality SmartRecruiters implementation efficiently, leveraging EX3\\'s');
    add('pre-built assets as a baseline while allowing for configuration aligned to');
    add(clientName + '\\'s hiring processes.');
    add('');

    // ── PERIOD OF PERFORMANCE ────────────────────────────────────────────────
    add('Period of Performance');
    add('────────────────────────────────────────────────────────────────────────');
    add('');
    add('The Services for the SmartRecruiters workstream shall take place within');
    add((a.timeline || 'a timeline to be agreed') + ' of SOW execution and will run in parallel');
    add('with the broader implementation.');
    add('');
    add('Organisation profile:');
    add('  • Organisation size: ' + (a.orgSize || 'To be confirmed'));
    add('  • Geography: ' + (a.geoScope ? a.geoScope.split('.')[0] : 'To be confirmed'));
    add('  • Platform language: English only');
    add('  • Users in scope: ' + (a.numUsers || 'To be confirmed'));
    add('');

    // ── ENGAGEMENT RESOURCES ──────────────────────────────────────────────────
    add('Engagement Resources');
    add('────────────────────────────────────────────────────────────────────────');
    add('');
    add('As part of this engagement, EX3 will assign the required resources.');
    add('Resources will have experience of the SmartRecruiters platform and');
    add('enterprise talent acquisition implementations.');
    add('');
    add('Key information on our resources:');
    add('  • All resources have worked effectively as remote resources on projects');
    add('    scaling from small to very large global implementations');
    add('  • Resources will have experience of the SmartRecruiters platform and');
    add('    relevant TA processes');
    add('  • Resources have global and Middle East regional experience');
    add('  • Resources and responsibilities are subject to change throughout the project');
    add('');
    add('The EX3 implementation team shall engage with the Customer no later than');
    add('four (4) weeks from SOW execution. Delivery dates for tasks included in this');
    add('SOW shall be based upon mutual agreement as documented within an approved');
    add('project schedule.');
    add('');

    // ── METHODOLOGY ───────────────────────────────────────────────────────────
    add('Implementation Methodology, Services & Responsibilities');
    add('────────────────────────────────────────────────────────────────────────');
    add('');
    add('EX3 has created its own implementation methodology, EXcelerate, which');
    add('incorporates both industry best practices and lessons learned from our years');
    add('of experience doing high quality SmartRecruiters implementations. We use our');
    add('EXcelerate methodology to efficiently deploy SmartRecruiters while meeting');
    add('our high standards for quality, customer satisfaction and project success.');
    add('');
    add('EXcelerate is optimised for rapid deployment using model company content. It');
    add('is structured across the following phases:');
    add('');
    add('  Examine          Adopt               Validate            Launch');
    add('  ─────────────────────────────────────────────────────────────────');
    add('  Kick-off,        Platform config:    UAT test scripts,   Go-live readiness');
    add('  requirements,    route maps, job     facilitation,       review, production');
    add('  process mapping, templates, user     defect resolution,  cutover, training,');
    add('  design sign-off, roles, offer mgmt,  written sign-off    Hypercare support');
    add('  integration      career site,        prior to go-live');
    add('  scoping          integrations,');
    add('                   data migration');
    add('');

    // ── EXAMINE PHASE ─────────────────────────────────────────────────────────
    add('Examine Phase');
    add('────────────────────────────────────────────────────────────────────────');
    add('The purpose of the Examine Phase is to establish the framework for a');
    add('successful project, confirm platform design, map hiring processes, and sign');
    add('off the configuration blueprint before Adopt commences.');
    add('');
    add('Key Tasks');
    add('');
    add('  Client and EX3                          EX3');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  Review Examine findings and agree         Lead kick-off workshop and');
    add('  configuration blueprint                   process mapping sessions');
    add('');
    add('  Confirm route map stages and approval     Produce platform design document');
    add('  chain definitions                         for sign-off');
    add('');
    add('  Sign off RBP access matrix and job        Begin integration scoping and');
    add('  template structure                        data migration assessment');
    add('');
    add('Deliverables');
    add('');
    add('  Client                                  EX3');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  Signed-off configuration blueprint       Kick-off and workshop presentations');
    add('  Completed RBP access matrix              Platform design sign-off document');
    add('  Approval chain definitions confirmed     Data migration assessment report');
    add('');

    // ── ADOPT PHASE ───────────────────────────────────────────────────────────
    add('Adopt Phase');
    add('────────────────────────────────────────────────────────────────────────');
    add('The purpose of the Adopt Phase is to configure the SmartRecruiters platform');
    add('per the agreed design, leveraging EX3 model company content as a baseline.');
    add('Iterative unit testing occurs throughout this phase.');
    add('');
    add('Key Tasks');
    add('');
    add('  Client and EX3                          EX3');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  Review configuration playbacks and       Configure route maps, job templates,');
    add('  provide timely feedback                  offer management, screening');
    add('');
    add('  Confirm email copy and brand assets      Configure user accounts, RBP roles,');
    add('  for career site build                    and approval chains');
    add('');
    add('  Sign off configuration before            Conduct unit testing and playback');
    add('  Validate commences                       sessions');
    add('');
    add('Deliverables');
    add('');
    add('  Client                                  EX3');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  Approved email copy, branding assets,    Configured SmartRecruiters sandbox');
    add('  offer letter content                     environment');
    add('  Build sign-off                           Updated configuration workbooks');
    add('                                           Unit test results and playback docs');
    add('');

    // ── VALIDATE PHASE ───────────────────────────────────────────────────────
    add('Validate Phase');
    add('────────────────────────────────────────────────────────────────────────');
    add('The purpose of the Validate Phase is to confirm all configured functionality');
    add('through client-led UAT. Written sign-off is required before go-live proceeds.');
    add('');
    add('Key Tasks');
    add('');
    add('  Client                                  EX3');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  Execute UAT test scripts and log         Deliver UAT test scripts and');
    add('  all findings                             facilitate sessions');
    add('');
    add('  Coordinate feedback, triage calls,       Resolve all Critical and High');
    add('  and final UAT sign-off                   priority defects within SLA');
    add('');
    add('  Creation of test users                   Update configuration workbooks');
    add('                                           post-UAT');
    add('');
    add('Deliverables');
    add('');
    add('  Client                                  EX3');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  Signed UAT sign-off document             UAT test scripts');
    add('                                           Defect log and resolution summary');
    add('                                           Updated instance configuration');
    add('');

    // ── LAUNCH PHASE ──────────────────────────────────────────────────────────
    add('Launch Phase');
    add('────────────────────────────────────────────────────────────────────────');
    add('The purpose of the Launch Phase is to move configuration to the production');
    add('environment, support the go-live, deliver training, and provide post-go-live');
    add('Hypercare for a smooth transition to BAU.');
    add('');
    add('Key Tasks');
    add('');
    add('  Client                                  EX3');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  PROD smoke test                          Execute cutover checklist and move');
    add('                                           configuration to PROD');
    add('  Attend training sessions and             Deliver recruiter, admin and hiring');
    add('  complete pre-reading                     manager training');
    add('  Participate in go-live readiness         Administer Hypercare and project');
    add('  review                                   closure');
    add('');
    add('Deliverables');
    add('');
    add('  Client                                  EX3');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  PROD smoke test sign-off                 Final PROD configuration');
    add('  Project closeout complete                Post-implementation handover pack');
    add('                                           HelpMyCloud Hypercare');
    add('                                           Completed configuration workbooks');
    add('');

    // ── SCOPE OF WORK ─────────────────────────────────────────────────────────
    add('Scope of Work');
    add('────────────────────────────────────────────────────────────────────────');
    add('');
    add('SmartRecruiters Recruiting Management Scope — EXcelerate Deployment');
    add('');

    // Route Maps
    add('Route Maps (Hiring Workflows)');
    add('  • Configuration of ' + (a.numProcesses || '6–8') + ' route maps aligned to ' + clientName + ' hiring workflows');
    add('  • Stage and status configuration per agreed route map design');
    add('  • Rejection reason configuration');
    add('  • Route map design to be confirmed and signed off during the Examine Phase');
    add('');

    // Job Templates
    add('Job Templates');
    add('  • Configuration of ' + (a.numTemplates || '5–8') + ' job templates with custom fields');
    add('  • Department and location hierarchy setup');
    add('  • Template structure and field requirements to be confirmed during Examine Phase');
    add('');

    // Application Template
    add('Application Template');
    add('  • 1 Application Template [Single Stage only — up to 3 fields additional or amended]');
    if (a.screening && a.screening.indexOf('not required') < 0) {
      add('  • Knockout / screening questions: ' + a.screening);
    } else {
      add('  • Knockout / screening questions: up to 5 standard screening questions per workflow');
      add('    (e.g. right to work, minimum qualifications)');
    }
    add('  • Screening question content to be provided by Client prior to configuration');
    add('');

    // Offer Management
    add('Offer Management');
    if (hasOfferMgmt) {
      add('  • 1 Offer Detail Template');
      add('  • 1 Offer Letter Template');
      add('  • Offer approval workflow configuration — approval chain to be confirmed during Examine Phase');
      if (hasDocuSign) add('  • E-signature integration (DocuSign) — subject to integration scope below');
    } else {
      add('  • Offer management is not in scope for this engagement');
    }
    add('');

    // Approval Workflows
    add('Approval Workflows');
    add('  • Requisition approval: ' + (a.reqApproval || 'multi-level approval chain (e.g. Line Manager → HR → Finance)'));
    add('  • Exact approval chain structure to be confirmed and signed off during Examine Phase');
    add('    before Adopt commences');
    add('  • Up to ' + (a.numProcesses || '6–8') + ' approval workflow configurations');
    add('');

    // Candidate Profile & Status Pipeline
    add('Candidate Profile & Status Pipeline');
    add('  • 1 Candidate Profile');
    add('  • 1 Applicant Status Pipeline');
    add('  • Candidate profile fields and data capture configuration');
    add('  • Status pipeline aligned to agreed route map stages');
    add('  • Rejection reason configuration');
    add('');

    // Email Templates
    add('Email Templates');
    add('  • Up to 20 recruiting email templates (e.g. application received, interview');
    add('    invite, rejection, offer)');
    add('  • 1 custom declined email template linked to status');
    add('  • Client to provide email copy and branding prior to configuration');
    add('');

    // Agency / Vendor Portal
    if (hasAgency) {
      add('Agency / Vendor Portal');
      add('  • Basic vendor portal configuration including agency account setup and job sharing');
      add('  • Agency account setup for up to 5 agreed vendors (client to provide agency list)');
      add('    or training provided on how to set up additional agencies independently');
      add('  • Agency submission workflow and visibility controls');
      add('');
    }

    // Interview Scheduling
    add('Interview Scheduling');
    add('  • Interview scheduling configuration aligned to agreed route map stages');
    add('  • Central interview scheduling setup (no Outlook / Google Calendar integration');
    add('    unless separately scoped)');
    add('');

    // Referral Management
    add('Referral Management');
    add('  • Enablement of SmartRecruiters standard employee referral portal');
    add('  • Employees can view open roles, submit referrals, and track referral status');
    add('    natively within the platform');
    add('  • Advanced referral programme features (bonus tracking, leaderboards, automated');
    add('    payments) require a third-party Marketplace integration and are out of scope');
    add('');

    // Mobile Enablement
    add('Mobile Enablement');
    add('  • Mobile enablement for recruiters and hiring managers via SmartRecruiters');
    add('    native mobile application (iOS and Android)');
    add('  • Mobile-responsive career site configuration included within career site scope');
    add('');

    // Recruiting Posting
    add('Recruiting Posting');
    add('  • 1 Posting Profile');
    if (jobBoardsList.length > 0) {
      add('  • Up to ' + Math.min(jobBoardsList.length, 5) + ' job boards: ' + jobBoardsList.slice(0, 5).join(', '));
    } else {
      add('  • Up to 5 job boards (to be confirmed during Examine Phase — e.g. LinkedIn, Indeed, Bayt)');
    }
    add('  • Basic field mapping — 5 key fields');
    add('  • Internal posting configuration');
    add('  • Standard Internal Careers options');
    add('');

    // User Accounts & RBP
    add('User Accounts & Role-Based Permissions (RBP)');
    add('  • Creation of ' + (a.numUsers || 'agreed number of') + ' user accounts');
    add('  • 1 Recruiter RBP role (minimal admin permissions)');
    add('  • RBP configuration per agreed access matrix');
    add('  • EX3 to provide RBP design template; Client to complete and sign off before');
    add('    Adopt commences');
    add('');

    // Reporting & Analytics
    add('Reporting & Analytics');
    add('  • Standard SmartRecruiters dashboards and out-of-the-box reports');
    add('  • Configuration of agreed saved reports and scheduled report distribution');
    if (a.reporting && a.reporting.indexOf('Standard') < 0 && a.reporting.indexOf('standard') < 0) {
      add('  • ' + a.reporting);
    } else {
      add('  • No custom report development is included');
    }
    add('');

    // Career Site
    if (hasCareerPage) {
      add('Recruiting Marketing / Career Site Scope — EXcelerate Deployment');
      add('');
      add('  • Integration of Recruiting Management and Career Site');
      add('  • Field mapping between Recruiting Management and Career Site');
      add('  • 1 Brand');
      add('  • 1 Locale (English only)');
      add('  • 1 Career Site Homepage');
      add('  • Up to 8 Category Pages');
      add('  • Up to 3 Content Pages');
      add('  • Standard career site builder components only — bespoke front-end development');
      add('    is out of scope');
      add('  • Standard job search and apply flow');
      add('  • Mobile-responsive career site validation');
      add('  • Brand application (logo, colours, imagery) — Client to provide all assets');
      add('    prior to configuration');
      add('');
    }

    // Integrations
    add('Integrations Scope — EXcelerate Deployment');
    add('');
    if (integrationsList.length > 0) {
      add('The following standard integrations are in scope:');
      integrationsList.forEach(function(i){ add('  • ' + i); });
    } else {
      add('The following standard integrations are in scope:');
      if (hasSFEC || (!integrationsList.length && isMiddleEast)) {
        add('  • Recruitment to Onboarding to Employee Central');
        add('  • Integration to Position Management (EC) — requisition creation from approved positions');
        add('  • E-signature / DocuSign — to be confirmed during Examine Phase');
      } else {
        add('  • No third-party integrations in scope for this engagement');
      }
    }
    add('');
    add('All integrations use standard SmartRecruiters Marketplace connectors. Custom');
    add('API builds or non-standard connectors are out of scope and would require a');
    add('Change Order.');
    add('');

    // Data Privacy & Compliance
    add('Data Privacy & Compliance');
    add('');
    add('  • Candidate consent and privacy notice configuration');
    add('  • Data retention policy configuration (automated deletion schedules for');
    add('    candidate records)');
    if (isMiddleEast || complianceList.some(function(c){ return c.indexOf('PDPL') >= 0 || c.indexOf('PDPPL') >= 0; })) {
      add('  • Compliance configuration aligned to applicable regional requirements including');
      add('    UAE Personal Data Protection Law (PDPL), Saudi Arabia Personal Data Protection');
      add('    Law (PDPPL), and GDPR where relevant');
    } else if (complianceList.length > 0) {
      complianceList.forEach(function(c){ add('  • ' + c); });
    } else {
      add('  • Standard data privacy defaults will be applied');
    }
    add('  • Specific regional compliance requirements to be confirmed during Examine Phase');
    add('');

    // Data Migration
    add('Data Migration Scope');
    add('');
    if (hasMigration) {
      add('  • ' + a.dataMigration);
      add('  • Data mapping document to be agreed during Examine Phase');
      add('  • Client responsible for data extraction in the EX3-specified format');
      add('  • Migration performed in sandbox environment first for validation before cutover');
      add('  • Maximum of 1 test cycle and 1 production migration cycle');
    } else {
      add('  • Migration of active job requisitions into SmartRecruiters is included in scope');
      add('  • Data mapping document to be agreed during Examine Phase');
      add('  • Client responsible for data extraction in the EX3-specified format');
      add('  • Migration performed in sandbox environment first for validation before cutover');
      add('  • Maximum of 1 test cycle and 1 production migration cycle');
    }
    add('');

    // Training
    add('Training Scope');
    add('');
    if (trainingList.length > 0) {
      trainingList.forEach(function(t){ add('  • ' + t); });
    } else {
      add('  • 1 Recruiter training session (up to 60 minutes — end-to-end hiring workflow,');
      add('    candidate management, communication tools)');
      add('  • 1 Administrator training session (up to 90 minutes — system configuration,');
      add('    user management, reporting)');
      add('  • 1 Hiring Manager training session (up to 45 minutes — job approval, candidate');
      add('    review, interview scheduling)');
    }
    add('  • All users receive access to the EX3 SmartRecruiters Enablement Guide');
    add('  • Sessions recorded and shared with Client for future reference');
    add('  • Training materials provided in advance for pre-reading');
    add('');

    // General Scope
    add('General Scope');
    add('');
    add('Hypercare:');
    add('  • ' + (a.hypercare ? a.hypercare + ' of Hypercare Support' : '10 hours or 20 days of Hypercare Support, whichever comes first'));
    add('');
    add('General Assumptions:');
    add('  • A 3-tier landscape will be used for the project: DEV, STAGE (Test), and PROD');
    add('  • ' + clientName + ' holds a valid SmartRecruiters licence for the project duration');
    add('    including sandbox/test environments required');
    add('  • Testing time will be allocated for both EX3 and the Client in each iteration');
    add('');
    add('Module Assumptions:');
    add('  • We assume all requirements can be met by standard SmartRecruiters platform');
    add('    functionality. Use of third-party applications not listed in scope would');
    add('    require a Change Order and may impact timelines and cost');
    add('  • New requirements arising during the project will be considered additional');
    add('    scope and will require a Change Request (CR)');
    add('  • EX3 is not responsible for managing any 3rd party vendors or issues that');
    add('    can only be resolved by a 3rd party');
    add('  • The project will be executed using EX3\\'s EXcelerate Methodology, document');
    add('    templates, and delivery project tools (Smartsheet)');
    add('');

    // ── OUT OF SCOPE ──────────────────────────────────────────────────────────
    add('Out of Scope');
    add('────────────────────────────────────────────────────────────────────────');
    add('');
    add('Any item, deliverable or activity not explicitly stated as in scope within');
    add('this section is to be deemed out of scope for this SOW.');
    add('');
    add('Other examples of items excluded from scope include:');
    add('  • SmartRecruiters platform licensing fees (contracted directly between');
    add('    ' + clientName + ' and SmartRecruiters)');
    add('  • Any integrations not explicitly listed in the Integrations Scope section');
    add('  • Custom API development, bespoke connectors, or non-standard integration builds');
    add('  • Outlook or Google Calendar integration for interview scheduling');
    add('  • Advanced referral programme features (bonus tracking, leaderboards,');
    add('    automated payments)');
    add('  • Ongoing platform administration or managed services after the Hypercare period');
    add('  • Additional training sessions beyond those listed in the Training Scope section');
    add('  • Custom dashboards and custom reports');
    add('  • Any Training Material beyond the EX3 SmartRecruiters Enablement Guide');
    add('  • Arabic or any language configuration other than English');
    add('  • Countries or languages beyond those agreed in scope');
    add('  • Recruitment process design or HR consultancy beyond system configuration');
    add('  • Content creation (job descriptions, email copy, brand assets, offer letter text)');
    add('  • Change Management consulting, communications development, or iterative');
    add('    process mapping');
    add('  • Management of client resources or creation of client internal project plans');
    add('  • Changes arising from SmartRecruiters vendor platform updates');
    add('');

    // ── LANGUAGES ─────────────────────────────────────────────────────────────
    add('Languages');
    add('────────────────────────────────────────────────────────────────────────');
    add('');
    add('  • Platform language translation: English');
    add('  • All communications and deliverables will occur in English');
    add('  • The SmartRecruiters career site and all modules will be implemented in');
    add('    English only. Arabic or any additional language configuration is out of');
    add('    scope and would require a Change Order');
    add('');

    // ── TESTING ───────────────────────────────────────────────────────────────
    add('Testing');
    add('────────────────────────────────────────────────────────────────────────');
    add('');
    add('  Activities                                          EX3        Client');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  Iterative Unit Testing                              Responsible');
    add('  Systems Integration Test (where applicable)                    Responsible');
    add('  Creation of Test Users                             Responsible');
    add('  Detailed Test Scenarios in Smartsheets             Responsible');
    add('  Confirmation of Testing Approach                   Responsible');
    add('  Cutover to TEST                                    Responsible');
    add('  Additional smoke testing cycle                                 Responsible');
    add('  Cut-over planning                                  Responsible');
    add('  Creation of UAT Approach and Plan                             Responsible');
    add('  Coordination of UAT (feedback, defect, calls)                 Responsible');
    add('  UAT execution                                                  Responsible');
    add('  UAT coordination during UAT                                    Responsible');
    add('  Triage / feedback calls with EX3 (daily)                      Responsible');
    add('  Define Test Approach                                           Responsible');
    add('  Delivery of Test Strategy Document                             Responsible');
    add('  Click-level Test Scripts                                       Responsible');
    add('  Testing Reports for Entry/Exit from each phase                 Responsible');
    add('  All test planning & coordination                               Responsible');
    add('  Full defect management through formal test phases              Responsible');
    add('  Support for all Test Governance during deployment              Responsible');
    add('');

    // ── DATA MIGRATION RACI ──────────────────────────────────────────────────
    add('Data Migration');
    add('────────────────────────────────────────────────────────────────────────');
    add('');
    add('  Activities                                          EX3        Client');
    add('  ─────────────────────────────────────────────────────────────────────');
    add('  Provision of Data Load Templates                   Responsible');
    add('  Basic data validation (general format checks)      Responsible');
    add('  Performing Data Loads (1 test + 1 production)      Responsible');
    add('  Admin Training on BAU data loading                 Responsible');
    add('  Confirmation of Data Migration Approach            Responsible');
    add('  Coordination of data migration tasks               Responsible');
    add('  Support for extraction process from client systems             Responsible');
    add('  Support for governance around data migration                   Responsible');
    add('  Delivery of Data Migration Strategy Document                   Responsible');
    add('  Data Transformation to SmartRecruiters templates              Responsible');
    add('  Additional cycle of data migration testing                     Responsible');
    add('  Additional training on data loading                            Responsible');
    add('  Data transformation                                             Responsible');
    add('');

    // ── FOOTER ────────────────────────────────────────────────────────────────
    add('────────────────────────────────────────────────────────────────────────');
    add('Prepared by EX3  |  Confidential  |  via EXcelerate');

    var sow = L.join('\\n');

    // ── end of SOW ──
    document.getElementById('sow-doc').textContent = sow;
    document.getElementById('wizard-card').style.display = 'none';
    document.getElementById('sow-output').classList.add('show');
    document.getElementById('progress-fill').style.width = '100%';
    document.getElementById('progress-label').textContent = 'Complete \u2713';
    checkRisks();
  }

  function checkRisks() {
    const a = answers;
    const risks = [];
    const warnings = [];
    const integrations = Array.isArray(a.integrations) ? a.integrations : [];
    const hasHRIS = integrations.some(i => i.includes('HRIS'));
    const hasSSO = integrations.some(i => i.includes('SSO'));
    const hasMigration = a.dataMigration && !a.dataMigration.includes('not in scope');
    const shortTimeline = a.timeline === '8 weeks';
    const medTimeline = a.timeline === '10 weeks';
    const isEnterprise = a.orgSize && a.orgSize.includes('Enterprise');
    const isLarge = a.orgSize && (a.orgSize.includes('Large') || a.orgSize.includes('Enterprise'));
    const hasFullOffer = a.offerMgmt && a.offerMgmt.includes('Full offer');
    const hasMultiApproval = a.reqApproval && (a.reqApproval.includes('multi-level') || a.reqApproval.includes('different chains'));
    const isMultiCountry = a.geoScope && !a.geoScope.includes('single country');
    const hasAgency = a.agencyPortal && !a.agencyPortal.includes('No external');
    const complianceCount = Array.isArray(a.compliance) ? a.compliance.length : 0;

    if (shortTimeline && hasHRIS && hasSSO) risks.push('HRIS + SSO + 8 weeks is very aggressive — consider extending to at least 12 weeks');
    if (shortTimeline && hasMigration) risks.push('Data migration in 8 weeks is high risk — this typically adds 2–4 weeks');
    if (isEnterprise && (shortTimeline || medTimeline)) risks.push('Enterprise organisations rarely complete in under 12 weeks — consider 16 weeks');
    if (integrations.length >= 3 && shortTimeline) risks.push(integrations.length + ' integrations in 8 weeks is very tight — each integration can take 1–2 weeks');
    if (isMultiCountry && shortTimeline) risks.push('Multi-country scope in 8 weeks is extremely ambitious — plan for at least 16 weeks');
    if (hasMultiApproval && shortTimeline) risks.push('Complex multi-level approval chains require significant configuration time — 8 weeks leaves little room for iteration');
    if (hasFullOffer && hasMigration && shortTimeline) risks.push('Full offer management + data migration + 8 weeks is very high risk — extend timeline or reduce scope');
    if (hasHRIS) warnings.push('HRIS integrations require IT involvement early — confirm credentials are available before the build phase');
    if (hasSSO) warnings.push("SSO setup requires the client's IT team — get them in the kickoff call");
    if (isLarge && a.training && Array.isArray(a.training) && a.training.length < 2) warnings.push('A large organisation with fewer than 2 training sessions may lead to low adoption — consider adding more');
    if (hasMultiApproval) warnings.push('Multi-level approval chains: map the exact approval flow in discovery before build starts — late changes are expensive');
    if (isMultiCountry) warnings.push('Multi-country/language: confirm which markets are live at go-live vs phased in later — scope creep risk is high');
    if (hasAgency) warnings.push('Agency portal: get a list of agencies and their contacts from the client early — account setup takes time');
    if (complianceCount >= 3) warnings.push('High compliance scope (' + complianceCount + ' items) — involve the client\\'s DPO or legal team in discovery');

    const banner = document.getElementById('risk-banner');
    if (risks.length === 0 && warnings.length === 0) { banner.style.display = 'none'; return; }

    let html = '';
    if (risks.length) {
      html += '<div style="font-weight:700;color:#991b1b;margin-bottom:8px">🔴 Risk flags</div>';
      html += risks.map(r => '<div style="margin-bottom:4px">• ' + r + '</div>').join('');
    }
    if (warnings.length) {
      if (risks.length) html += '<div style="margin:10px 0;border-top:1px solid #fde68a"></div>';
      html += '<div style="font-weight:700;color:#92400e;margin-bottom:8px">⚠️ Things to watch</div>';
      html += warnings.map(w => '<div style="margin-bottom:4px">• ' + w + '</div>').join('');
    }
    banner.innerHTML = html;
    banner.style.display = 'block';
    banner.style.background = risks.length ? '#fef2f2' : '#fffbeb';
    banner.style.border = '1px solid ' + (risks.length ? '#fecaca' : '#fde68a');
    banner.style.color = risks.length ? '#7f1d1d' : '#78350f';
  }

  async function generateWithAI() {
    const aiStatus = document.getElementById('ai-status');
    aiStatus.style.display = 'block';
    const doc = document.getElementById('sow-doc');
    doc.textContent = '';

    try {
      const res = await fetch('/consultant/sow-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) throw new Error('AI request failed');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        doc.textContent = text;
      }
      aiStatus.style.display = 'none';
    } catch (err) {
      aiStatus.textContent = 'AI generation failed — please try again.';
      aiStatus.style.background = '#fef2f2';
      aiStatus.style.color = '#991b1b';
    }
  }

  async function exportWord() {
    const res = await fetch('/consultant/sow-export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, clientName: answers.clientName }),
    });
    if (!res.ok) { alert('Export failed'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SOW_' + (answers.clientName || 'Client').replace(/[^a-z0-9]/gi, '_') + '.docx';
    a.click();
    URL.revokeObjectURL(url);
  }

  function showEmailForm() {
    const form = document.getElementById('email-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  }

  async function sendEmail() {
    const toEmail = document.getElementById('email-to').value.trim();
    const status = document.getElementById('email-status');
    if (!toEmail) { status.textContent = 'Please enter an email address'; return; }
    status.textContent = 'Sending...';
    const content = document.getElementById('sow-doc').textContent;
    const res = await fetch('/consultant/sow-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, clientName: answers.clientName, toEmail }),
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = '✅ Sent successfully!';
      status.style.color = '#0d7c4c';
    } else {
      status.textContent = '❌ ' + (data.error || 'Failed to send');
      status.style.color = '#991b1b';
    }
  }

  function copySow() {
    const text = document.getElementById('sow-doc').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = event.target;
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = orig, 2000);
    });
  }

  function restartWizard() {
    location.reload();
  }
  window.addEventListener('message', function(e){
    if(!e.data || e.data.type !== 'EX3_DEMO') return;
    var d = e.data;

    if(d.action === 'demoWalkSOW'){
      var sowOut = document.getElementById('sow-output');
      if(sowOut && sowOut.classList.contains('show')) return;
      var inp = document.getElementById('client-name');
      if(!inp) return;
      inp.value = '';
      var name = 'Acme Corporation';
      var ni = 0;
      var nameT = setInterval(function(){
        if(ni >= name.length){ clearInterval(nameT); answers.clientName = name; setTimeout(runDemoWalk, 500); return; }
        inp.value += name[ni++];
        answers.clientName = inp.value;
      }, 55);

      function q(arr, delay, fn){ var last = arr.length ? arr[arr.length-1][0] : 0; arr.push([last+delay, fn]); return arr; }
      function runDemoWalk(){
        var actions = [];
        function sc(delay, fn){ var last = actions.length ? actions[actions.length-1][0] : 0; actions.push([last+delay, fn]); }
        var nxt = function(){ document.getElementById('btn-next').click(); };
        sc(400, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-2 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-3 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-4 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-5 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#integrations-options .opt'); if(o[0])o[0].click(); setTimeout(function(){ if(o[1])o[1].click(); },250); });
        sc(900, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#jobboards-options .opt'); if(o[0])o[0].click(); setTimeout(function(){ if(o[1])o[1].click(); },220); setTimeout(function(){ if(o[3])o[3].click(); },440); });
        sc(950, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-8 .opt'); if(o[0])o[0].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-9 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-10 .opt'); if(o[1])o[1].click(); setTimeout(function(){ if(o[2])o[2].click(); },250); });
        sc(900, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-11 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-12 .opt'); if(o[2])o[2].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-13 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-14 .opt'); if(o[2])o[2].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-15 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-16 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#compliance-options .opt'); if(o[0])o[0].click(); setTimeout(function(){ if(o[2])o[2].click(); },250); });
        sc(900, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-18 .opt'); if(o[0])o[0].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-19 .opt'); if(o[0])o[0].click(); });
        sc(500, nxt);
        actions.forEach(function(a){ setTimeout(a[1], a[0]); });
      }
    }

    if(d.action === 'triggerAIRewrite'){
      var sowOut2 = document.getElementById('sow-output');
      if(!sowOut2 || !sowOut2.classList.contains('show')) return;
      var btns = document.querySelectorAll('button');
      for(var i=0; i<btns.length; i++){
        if(btns[i].textContent.indexOf('Rewrite with AI') > -1){ btns[i].click(); break; }
      }
    }

    if(d.action === 'scrollToExport'){
      var sa = document.querySelector('.sow-actions');
      if(sa) sa.scrollIntoView({behavior:'smooth'});
    }
  });

</script>
</body>
</html>`);
});

// Demo presenter mode — automated split-screen product demo
app.get('/demo', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EX3 SmartRecruiters \u2014 Live Demo</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{font-family:'Inter',system-ui,sans-serif;background:#060606;color:#fff}

/* ────── START SCREEN ────── */
#start-screen{
  position:fixed;inset:0;z-index:300;
  background:#060606;
  display:flex;align-items:center;justify-content:center;flex-direction:column;
  transition:opacity .6s ease;
}
#start-screen.fade{opacity:0;pointer-events:none}
.ss-logo{font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#2a2a2a;margin-bottom:52px}
.ss-logo em{color:#22c55e;font-style:normal}
.ss-head{font-size:clamp(34px,5.5vw,64px);font-weight:800;letter-spacing:-.04em;text-align:center;line-height:1.05;max-width:680px}
.ss-head em{color:#22c55e;font-style:normal;font-weight:800}
.ss-sub{margin-top:22px;font-size:15px;color:#555;text-align:center;max-width:400px;line-height:1.8}
.ss-pills{display:flex;gap:10px;margin-top:36px;flex-wrap:wrap;justify-content:center}
.ss-pill{padding:7px 15px;border:1px solid #1a1a1a;border-radius:100px;font-size:12px;color:#666;background:#0d0d0d;white-space:nowrap}
.ss-btn{
  margin-top:48px;
  padding:17px 56px;background:#22c55e;color:#000;
  font-family:inherit;font-size:15px;font-weight:800;
  border:none;border-radius:14px;cursor:pointer;
  letter-spacing:-.01em;
  display:flex;align-items:center;gap:10px;
  transition:opacity .15s,transform .15s;
}
.ss-btn:hover{opacity:.9;transform:translateY(-2px)}
.ss-note{margin-top:18px;font-size:11px;color:#2a2a2a}
/* Ambient glow */
#start-screen{overflow:hidden}
#start-screen::before{content:'';position:absolute;width:800px;height:800px;background:radial-gradient(circle,rgba(34,197,94,.08) 0%,transparent 65%);animation:ss-glow 5s ease-in-out infinite;pointer-events:none;z-index:0}
@keyframes ss-glow{0%,100%{transform:scale(1) translate(-10%,10%);opacity:.5}50%{transform:scale(1.25) translate(-10%,10%);opacity:1}}
#start-screen>*{position:relative;z-index:1}
/* Stat counters */
.ss-stats{display:flex;gap:52px;margin-top:44px}
.ss-stat{text-align:center}
.ss-stat-n{display:block;font-size:46px;font-weight:800;letter-spacing:-.04em;color:#22c55e;font-variant-numeric:tabular-nums;line-height:1}
.ss-stat-l{display:block;font-size:11px;color:#333;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-top:6px}
/* CTA wrap with pulse rings */
.ss-cta-wrap{position:relative;margin-top:44px;display:inline-block}
.ss-ring{position:absolute;inset:-10px;border-radius:24px;border:1.5px solid rgba(34,197,94,.3);animation:ss-ring-p 2.5s ease-in-out infinite;pointer-events:none}
.ss-ring2{position:absolute;inset:-20px;border-radius:30px;border:1px solid rgba(34,197,94,.12);animation:ss-ring-p 2.5s ease-in-out infinite .7s;pointer-events:none}
@keyframes ss-ring-p{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:.9;transform:scale(1.025)}}
.ss-btn{margin:0}
/* Auto-advance ring */
#auto-ring{width:38px;height:38px;flex-shrink:0;cursor:pointer;display:none;position:relative;align-self:center}
#auto-ring.show{display:block}
#auto-ring-n{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#22c55e;font-family:inherit}
/* Frame crossfade */
#frame-fade{position:absolute;inset:0;background:#0a0a0a;z-index:8;opacity:0;pointer-events:none;transition:opacity .22s ease}
#frame-fade.in{opacity:1}

/* ────── DEMO SHELL ────── */
#demo{display:flex;flex-direction:column;height:100vh;opacity:0;transition:opacity .5s}
#demo.show{opacity:1}

/* Top bar */
.topbar{
  height:48px;flex-shrink:0;
  display:flex;align-items:center;justify-content:space-between;padding:0 18px;
  background:#0a0a0a;border-bottom:1px solid #111;
}
.tb-logo{font-size:13px;font-weight:700;letter-spacing:.04em}
.tb-logo em{color:#22c55e;font-style:normal}
.tb-step-label{font-size:11px;color:#333;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.tb-ctrl{display:flex;align-items:center;gap:6px}
.cbtn{
  width:30px;height:30px;border-radius:7px;border:1px solid #1e1e1e;background:#111;
  color:#666;font-size:13px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all .15s;font-family:inherit;flex-shrink:0;
}
.cbtn:hover{color:#fff;border-color:#2e2e2e;background:#181818}
.cbtn.on{background:#22c55e;color:#000;border-color:#22c55e}
.cbtn.muted{background:#ef4444;color:#fff;border-color:#ef4444}

/* Progress strip */
.prog-strip{height:2px;flex-shrink:0;background:#0f0f0f}
.prog-fill{height:100%;background:linear-gradient(90deg,#16a34a,#22c55e);transition:width .6s ease;width:0%}

/* Dots */
.dots-row{
  height:34px;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;gap:5px;
  background:#080808;border-bottom:1px solid #0f0f0f;
}
.dot{width:6px;height:6px;border-radius:3px;background:#161616;transition:all .4s ease;cursor:pointer}
.dot:hover{background:#2e2e2e}
.dot.done{background:#166534;width:10px;border-radius:4px}
.dot.cur{background:#22c55e;width:22px;border-radius:4px}

/* Frame area */
.frame-area{flex:1;position:relative;overflow:hidden;min-height:0}
iframe{width:100%;height:100%;border:none;display:block;background:#f8f7f4}
.ph{
  position:absolute;inset:0;display:none;
  align-items:center;justify-content:center;flex-direction:column;gap:18px;
  background:#0a0a0a;
}
.ph-icon{font-size:52px}
.ph-title{font-size:22px;font-weight:800;letter-spacing:-.03em}
.ph-body{font-size:13px;color:#555;max-width:380px;text-align:center;line-height:1.8}
.ph-cta{display:inline-block;margin-top:6px;padding:11px 24px;background:#22c55e;color:#000;border-radius:10px;font-weight:700;font-size:13px;text-decoration:none;transition:opacity .15s}
.ph-cta:hover{opacity:.88}

/* Fake WhatsApp demo */
.wa-shell{display:none;width:100%;height:100%;flex-direction:column;background:#e5ddd5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;overflow:hidden}
.wa-shell.active{display:flex}
.wa-header-wa{background:#075e54;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.wa-avatar{width:38px;height:38px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.wa-hname{font-weight:700;font-size:14px;line-height:1.3}
.wa-hsub{font-size:11px;opacity:.75}
.wa-msgs{flex:1;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:7px;min-height:0}
.wa-bubble{max-width:72%;padding:7px 10px 22px 10px;border-radius:8px;font-size:13px;line-height:1.55;position:relative;word-break:break-word;white-space:pre-line;opacity:0;transform:translateY(8px);transition:opacity .3s,transform .3s}
.wa-bubble.show{opacity:1;transform:translateY(0)}
.wa-bubble.them{background:#fff;align-self:flex-start;border-top-left-radius:0;color:#111}
.wa-bubble.me{background:#dcf8c6;align-self:flex-end;border-top-right-radius:0;color:#111}
.wa-time{position:absolute;bottom:4px;right:8px;font-size:10px;color:#999}
.wa-tick{margin-left:2px;color:#4fc3f7}
.wa-typing-row{padding:4px 10px;flex-shrink:0}
.wa-typing-bubble{display:none;background:#fff;border-radius:8px;border-top-left-radius:0;padding:9px 14px;width:fit-content;align-items:center;gap:4px}
.wa-typing-bubble.show{display:flex}
.wa-dot-t{width:7px;height:7px;border-radius:50%;background:#bbb;animation:wa-bounce .9s infinite ease-in-out}
.wa-dot-t:nth-child(2){animation-delay:.2s}
.wa-dot-t:nth-child(3){animation-delay:.4s}
@keyframes wa-bounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}

/* Callout overlay */
#callout-layer{position:absolute;inset:0;pointer-events:none;z-index:10}
.callout-bubble{
  position:absolute;
  background:rgba(10,10,10,.92);
  backdrop-filter:blur(12px);
  border:1px solid rgba(34,197,94,.35);
  border-left:3px solid #22c55e;
  border-radius:10px;
  padding:10px 14px;
  font-size:12px;font-weight:600;color:#d4d4d4;
  line-height:1.5;max-width:220px;
  box-shadow:0 4px 24px rgba(0,0,0,.6),0 0 20px rgba(34,197,94,.1);
  opacity:0;transform:translateY(6px);
  transition:opacity .4s ease,transform .4s ease;
  pointer-events:none;
}
.callout-bubble.show{opacity:1;transform:translateY(0)}
.callout-bubble strong{color:#22c55e;display:block;font-size:11px;margin-bottom:3px;text-transform:uppercase;letter-spacing:.06em}
.callout-dot{
  position:absolute;
  width:14px;height:14px;border-radius:50%;
  background:#22c55e;
  box-shadow:0 0 0 0 rgba(34,197,94,.5);
  animation:ring 2s ease-in-out infinite;
  transform:translate(-50%,-50%);
  pointer-events:none;
  opacity:0;transition:opacity .4s;
}
.callout-dot.show{opacity:1}
@keyframes ring{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 14px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}

/* Step title pill (floats over iframe) */
#step-pill{
  position:absolute;top:14px;left:50%;transform:translateX(-50%) translateY(-8px);
  background:rgba(8,8,8,.9);backdrop-filter:blur(10px);
  border:1px solid #1e1e1e;border-radius:100px;
  padding:7px 18px;
  display:flex;align-items:center;gap:8px;
  font-size:12px;font-weight:700;white-space:nowrap;
  z-index:20;pointer-events:none;
  opacity:0;transition:opacity .4s,transform .4s;
}
#step-pill.show{opacity:1;transform:translateX(-50%) translateY(0)}
#pill-icon{font-size:16px}

/* ────── NARRATOR PANEL ────── */
.narrator{
  flex-shrink:0;
  background:#0a0a0a;border-top:1px solid #111;
  padding:14px 18px 12px;
}
.nar-inner{display:flex;align-items:flex-start;gap:12px;max-width:1000px;margin:0 auto}
.nar-mic{
  width:34px;height:34px;flex-shrink:0;margin-top:1px;
  border-radius:50%;background:#111;border:1px solid #1e1e1e;
  display:flex;align-items:center;justify-content:center;
}
.bars{display:flex;align-items:center;gap:2.5px;height:16px}
.bar{width:3px;border-radius:2px;background:#333;transition:background .3s,height .15s}
.bar:nth-child(1){height:4px}.bar:nth-child(2){height:10px}.bar:nth-child(3){height:7px}.bar:nth-child(4){height:12px}.bar:nth-child(5){height:5px}.bar:nth-child(6){height:8px}
@keyframes b1{0%,100%{height:4px}50%{height:13px}}
@keyframes b2{0%,100%{height:10px}50%{height:4px}}
@keyframes b3{0%,100%{height:7px}50%{height:15px}}
@keyframes b4{0%,100%{height:12px}50%{height:3px}}
@keyframes b5{0%,100%{height:5px}50%{height:12px}}
@keyframes b6{0%,100%{height:8px}50%{height:4px}}
.speaking .bar{background:#22c55e}
.speaking .bar:nth-child(1){animation:b1 .5s ease-in-out infinite}
.speaking .bar:nth-child(2){animation:b2 .5s ease-in-out infinite .08s}
.speaking .bar:nth-child(3){animation:b3 .5s ease-in-out infinite .16s}
.speaking .bar:nth-child(4){animation:b4 .5s ease-in-out infinite .04s}
.speaking .bar:nth-child(5){animation:b5 .5s ease-in-out infinite .12s}
.speaking .bar:nth-child(6){animation:b6 .5s ease-in-out infinite .2s}
.nar-text{flex:1;min-width:0}
.nar-words{font-size:13.5px;line-height:1.75;color:#444;min-height:46px;padding-right:4px}
.nar-words .w.past{color:#666}
.nar-words .w.now{color:#fff;font-weight:600}
.nar-words .w.future{color:#2a2a2a}
.nar-foot{display:flex;align-items:center;margin-top:8px;gap:10px}
.nar-tag{font-size:10px;font-weight:700;color:#22c55e;letter-spacing:.06em;text-transform:uppercase;flex-shrink:0}
.nar-pb{flex:1;height:2px;background:#141414;border-radius:1px}
.nar-pb-fill{height:100%;background:#22c55e;border-radius:1px;transition:width .3s linear;width:0%}
.nar-controls{display:flex;gap:8px;margin-top:10px}
.nar-btn{padding:9px 12px;border-radius:8px;border:1px solid #222;background:#101010;color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
.nar-btn:hover{background:#171717;border-color:#2e2e2e}
.nar-btn.next{background:#22c55e;color:#000;border-color:#22c55e}
.nar-btn.next:hover{opacity:.92}
@keyframes pulse-next{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}50%{box-shadow:0 0 0 8px rgba(34,197,94,0)}}
.nar-btn.next.ready{animation:pulse-next 1.4s ease-in-out infinite;background:#16a34a}

/* Voice note bubble */
.wa-voice-note{display:flex;align-items:center;gap:8px;min-width:170px}
.wa-voice-play{width:34px;height:34px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.wa-waveform{flex:1;display:flex;align-items:center;gap:2px;height:22px}
.wa-wbar{border-radius:2px;background:rgba(0,0,0,.28);width:3px}
.wa-voice-dur{font-size:11px;color:#999;flex-shrink:0;margin-left:4px}

/* Chapter card panel */
.card-panel{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:#060606;overflow:hidden;z-index:5}
.card-panel.active{display:flex}
.card-panel::before{content:'';position:absolute;width:700px;height:700px;background:radial-gradient(circle,rgba(34,197,94,.06) 0%,transparent 65%);pointer-events:none}
.card-chap{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#22c55e;margin-bottom:18px;opacity:0;transform:translateY(10px);transition:opacity .6s ease .1s,transform .6s ease .1s}
.card-panel.active .card-chap{opacity:1;transform:translateY(0)}
.card-headline{font-size:clamp(34px,5vw,64px);font-weight:800;letter-spacing:-.04em;line-height:1.07;text-align:center;max-width:600px;opacity:0;transform:translateY(20px);transition:opacity .6s ease .28s,transform .6s ease .28s}
.card-panel.active .card-headline{opacity:1;transform:translateY(0)}
.card-headline em{color:#22c55e;font-style:normal}

/* Recording scene */
#wa-recording-scene{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:#080808;z-index:6;transition:opacity .5s ease}
#wa-recording-scene.active{display:flex}
.rec-time{font-size:clamp(52px,9vw,86px);font-weight:800;letter-spacing:-.04em;color:#fff;line-height:1;font-variant-numeric:tabular-nums;opacity:0;transform:translateY(16px);transition:opacity .5s ease .05s,transform .5s ease .05s}
#wa-recording-scene.active .rec-time{opacity:1;transform:translateY(0)}
.rec-info{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#2a2a2a;margin-top:12px;opacity:0;transition:opacity .5s ease .22s}
#wa-recording-scene.active .rec-info{opacity:1}
.rec-row{display:flex;align-items:center;gap:12px;margin-top:30px;opacity:0;transition:opacity .5s ease .38s}
#wa-recording-scene.active .rec-row{opacity:1}
.rec-dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:rec-pulse 1.2s ease-in-out infinite;flex-shrink:0}
@keyframes rec-pulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.4)}70%{box-shadow:0 0 0 10px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
.rec-wave{display:flex;align-items:center;gap:3px;height:30px}
.rec-wbar{width:3.5px;border-radius:2px;background:#22c55e;height:6px}
@keyframes rw1{0%,100%{height:5px}50%{height:22px}}
@keyframes rw2{0%,100%{height:10px}50%{height:26px}}
@keyframes rw3{0%,100%{height:16px}50%{height:7px}}
@keyframes rw4{0%,100%{height:22px}50%{height:5px}}
@keyframes rw5{0%,100%{height:7px}50%{height:24px}}
@keyframes rw6{0%,100%{height:18px}50%{height:6px}}
@keyframes rw7{0%,100%{height:12px}50%{height:28px}}
@keyframes rw8{0%,100%{height:5px}50%{height:18px}}
.rec-wbar:nth-child(1){animation:rw1 .65s ease-in-out infinite}
.rec-wbar:nth-child(2){animation:rw2 .65s ease-in-out infinite .09s}
.rec-wbar:nth-child(3){animation:rw3 .65s ease-in-out infinite .18s}
.rec-wbar:nth-child(4){animation:rw4 .65s ease-in-out infinite .05s}
.rec-wbar:nth-child(5){animation:rw5 .65s ease-in-out infinite .14s}
.rec-wbar:nth-child(6){animation:rw6 .65s ease-in-out infinite .22s}
.rec-wbar:nth-child(7){animation:rw7 .65s ease-in-out infinite .11s}
.rec-wbar:nth-child(8){animation:rw8 .65s ease-in-out infinite .07s}
.rec-label{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#333;margin-top:18px;opacity:0;transition:opacity .5s ease .48s}
#wa-recording-scene.active .rec-label{opacity:1}
#analytics-shell{display:none;width:100%;height:100%;flex-direction:column;background:#0d0f18;color:#e8eaf0;font-family:'Inter',system-ui,sans-serif;padding:20px 22px;box-sizing:border-box;overflow-y:auto;gap:14px}
#analytics-shell.active{display:flex}
.an-header{}
.an-title{font-size:18px;font-weight:800;color:#fff;letter-spacing:-.02em}
.an-period{font-size:11px;color:#6b7280;margin-top:3px}
.an-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.an-kpi{background:#161925;border-radius:10px;padding:14px 14px 12px;border:1px solid #1e2235}
.an-knum{font-size:26px;font-weight:800;color:#818cf8;line-height:1;font-variant-numeric:tabular-nums}
.an-knum-suffix{font-size:16px;font-weight:700}
.an-klabel{font-size:10px;color:#6b7280;margin-top:5px;line-height:1.3}
.an-chart-section{background:#161925;border-radius:10px;padding:16px;border:1px solid #1e2235}
.an-chart-label{font-size:11px;color:#6b7280;margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em}
.an-bars{display:flex;gap:6px;align-items:flex-end;height:72px}
.an-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:5px;height:100%}
.an-bar{width:100%;background:linear-gradient(180deg,#818cf8,#6366f1);border-radius:3px 3px 0 0;height:0;transition:height .9s cubic-bezier(.34,1.56,.64,1)}
.an-bar.grow{height:var(--h)}
.an-bday{font-size:9px;color:#4b5563}
.an-top-qs{background:#161925;border-radius:10px;padding:16px;border:1px solid #1e2235;flex:1}
.an-qs-label{font-size:11px;color:#6b7280;margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em}
.an-q-row{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.an-q-fill{height:28px;background:#818cf8;opacity:.13;border-radius:4px;position:absolute;left:0;top:0;width:0;transition:width .7s ease}
.an-q-wrap{position:relative;flex:1;border-radius:4px;overflow:hidden}
.an-q-text{font-size:11px;color:#cbd5e1;padding:7px 8px;position:relative}
.an-q-count{font-size:12px;font-weight:700;color:#818cf8;min-width:26px;text-align:right}
</style>
</head>
<body>

<!-- ── Start screen ── -->
<div id="start-screen">
  <div class="ss-logo">EX3 <em>SmartRecruiters</em></div>
  <h1 class="ss-head">Everything your team needs.<br><em>On day one.</em></h1>
  <p class="ss-sub">Training, AI assistant, WhatsApp bot, consultant portal, and SOW builder — the complete SmartRecruiters implementation toolkit.</p>
  <div class="ss-stats">
    <div class="ss-stat"><span class="ss-stat-n" id="stat-features">50+</span><span class="ss-stat-l">Features</span></div>
    <div class="ss-stat"><span class="ss-stat-n" id="stat-roles">4</span><span class="ss-stat-l">Roles</span></div>
    <div class="ss-stat"><span class="ss-stat-n" id="stat-time">4</span><span class="ss-stat-l">Minutes</span></div>
  </div>
  <div class="ss-cta-wrap">
    <div class="ss-ring"></div><div class="ss-ring2"></div>
    <button class="ss-btn" onclick="beginDemo()">\u25B6&nbsp;&nbsp;Start Demo</button>
  </div>
  <p class="ss-note">Voice narration &nbsp;&middot;&nbsp; auto-advance &nbsp;&middot;&nbsp; no login required</p>
</div>

<!-- ── Demo ── -->
<div id="demo">
  <div class="topbar">
    <div class="tb-logo">EX3 <em>SmartRecruiters</em></div>
    <div class="tb-step-label" id="tb-step">Step 1 of 13</div>
    <div class="tb-ctrl">
      <button class="cbtn" id="mute-btn" onclick="toggleMute()" title="Mute voice" style="font-size:10px;font-weight:800;letter-spacing:.04em">VOL</button>
      <button class="cbtn" id="pause-btn" onclick="togglePause()" title="Pause">\u23F8</button>
      <button class="cbtn" onclick="go(-1)" title="Previous">\u2190</button>
      <button class="cbtn" onclick="go(1)" title="Next">\u2192</button>
      <button class="cbtn" onclick="restartDemo()" title="Restart">\u21BA</button>
    </div>
  </div>
  <div class="prog-strip"><div class="prog-fill" id="prog-fill"></div></div>
  <div class="dots-row" id="dots-row"></div>
  <div class="frame-area" id="frame-area">
    <iframe id="liveFrame" src="/"></iframe>
    <div id="frame-fade"></div>
    <div class="ph" id="ph">
      <div class="ph-icon" id="ph-icon"></div>
      <div class="ph-title" id="ph-title"></div>
      <div class="ph-body" id="ph-body"></div>
      <a class="ph-cta" id="ph-cta" href="#" target="_blank" style="display:none"></a>
      <div class="wa-shell" id="wa-shell">
        <div class="wa-header-wa">
          <div class="wa-avatar" style="font-size:13px;font-weight:800;letter-spacing:-.02em">EX3</div>
          <div><div class="wa-hname">EX3 AI Assistant</div><div class="wa-hsub">WhatsApp · usually replies instantly</div></div>
        </div>
        <div class="wa-msgs" id="wa-msgs"></div>
        <div class="wa-typing-row">
          <div class="wa-typing-bubble" id="wa-typing">
            <div class="wa-dot-t"></div><div class="wa-dot-t"></div><div class="wa-dot-t"></div>
          </div>
        </div>
      </div>
    </div>
    <div id="analytics-shell">
      <div class="an-header">
        <div class="an-title">EX3 Analytics</div>
        <div class="an-period">Week 14 &middot; Apr 7&ndash;13 &middot; GlobalFirst Bank</div>
      </div>
      <div class="an-kpis">
        <div class="an-kpi"><div class="an-knum" id="an-k1">0</div><div class="an-klabel">AI queries this week</div></div>
        <div class="an-kpi"><div class="an-knum" id="an-k2">0<span class="an-knum-suffix"> hrs</span></div><div class="an-klabel">saved per consultant</div></div>
        <div class="an-kpi"><div class="an-knum" id="an-k3">0<span class="an-knum-suffix">%</span></div><div class="an-klabel">questions answered</div></div>
        <div class="an-kpi"><div class="an-knum" id="an-k4">0</div><div class="an-klabel">active engagements</div></div>
      </div>
      <div class="an-chart-section">
        <div class="an-chart-label">Daily AI queries &mdash; Week 14</div>
        <div class="an-bars" id="an-bars">
          <div class="an-bar-col"><div class="an-bar" style="--h:62%"></div><div class="an-bday">Mon</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:78%"></div><div class="an-bday">Tue</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:55%"></div><div class="an-bday">Wed</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:88%"></div><div class="an-bday">Thu</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:71%"></div><div class="an-bday">Fri</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:23%"></div><div class="an-bday">Sat</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:18%"></div><div class="an-bday">Sun</div></div>
        </div>
      </div>
      <div class="an-top-qs">
        <div class="an-qs-label">Top questions this week</div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:92%"></div><div class="an-q-text">How do I set up an offer letter template?</div></div><div class="an-q-count">38</div></div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:74%"></div><div class="an-q-text">Send Offer button not appearing</div></div><div class="an-q-count">29</div></div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:61%"></div><div class="an-q-text">How do I add workflow automation?</div></div><div class="an-q-count">24</div></div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:46%"></div><div class="an-q-text">Candidate screening filter setup</div></div><div class="an-q-count">18</div></div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:33%"></div><div class="an-q-text">GDPR compliance checklist</div></div><div class="an-q-count">13</div></div>
      </div>
    </div>
    <div class="card-panel" id="card-panel">
      <div class="card-chap" id="card-chap"></div>
      <div class="card-headline" id="card-headline"></div>
    </div>
    <div id="wa-recording-scene">
      <div class="rec-time">06:07</div>
      <div class="rec-info">En route to client site</div>
      <div class="rec-row">
        <div class="rec-dot"></div>
        <div class="rec-wave">
          <div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div>
          <div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div>
        </div>
      </div>
      <div class="rec-label">Recording</div>
    </div>
    <div id="callout-layer">
      <div class="callout-bubble" id="cbubble"></div>
      <div class="callout-dot" id="cdot"></div>
    </div>
    <div id="step-pill"><span id="pill-icon"></span><span id="pill-title"></span></div>
  </div>
  <div class="narrator">
    <div class="nar-inner">
      <div class="nar-mic"><div class="bars" id="bars"><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div></div></div>
      <div class="nar-text">
        <div class="nar-words" id="nar-words"></div>
        <div class="nar-foot">
          <span class="nar-tag" id="nar-tag"></span>
          <div class="nar-pb"><div class="nar-pb-fill" id="nar-pb-fill"></div></div>
        </div>
        <div class="nar-controls">
          <button class="nar-btn" onclick="go(-1)">\u2190 Prev Step</button>
          <button class="nar-btn" onclick="replayStep()">\u21BB Replay Step</button>
          <button class="nar-btn" onclick="retryAudio()">Retry Audio</button>
          <button class="nar-btn next" onclick="go(1)">Next Step \u2192</button>
        </div>
      </div>
      <div id="auto-ring" onclick="stopAutoAdvance();go(1)" title="Click to advance now">
        <svg viewBox="0 0 38 38" width="38" height="38">
          <circle cx="19" cy="19" r="16" fill="none" stroke="#1e1e1e" stroke-width="3"/>
          <circle id="auto-ring-fill" cx="19" cy="19" r="16" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-dasharray="100.5" stroke-dashoffset="100.5" transform="rotate(-90 19 19)"/>
        </svg>
        <div id="auto-ring-n"></div>
      </div>
    </div>
  </div>
</div>

<script>
// ── Steps ──
var steps = [
  {
    icon:'', title:'The EX3 Platform', url:'/', auto:[],
    voice:"Meet Sarah. She runs SmartRecruiters implementations for a Big Four consulting firm. New client just signed — a global bank, twelve thousand employees, going live in sixty days. She has a kickoff call in two hours. This is everything she uses.",
    callout:null
  },
  {
    icon:'', title:'Four Roles, One Platform', url:'/',
    auto:[
      {d:1200,a:{action:'setRole',role:'rec'}},
      {d:4000,a:{action:'setRole',role:'hm'}},
      {d:6500,a:{action:'setRole',role:'cand'}},
      {d:9000,a:{action:'setRole',role:'adm'}}
    ],
    minHold:12000,
    voice:"So before the call, Sarah's getting her team set up. On any SmartRecruiters project you have four types of people involved — the recruiter, the hiring manager, the candidate, and the admin. Each one of them logs in and sees a completely different version of this platform. You can watch it switching between them now.",
    callout:{label:'Role-based views',text:'Recruiter \u00b7 Hiring Manager \u00b7 Candidate \u00b7 Admin',dot:{x:50,y:14},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Recruiter View', url:'/',
    auto:[
      {d:800,a:{action:'setRole',role:'rec'}}
    ],
    minHold:7000,
    voice:"She clicks into the recruiter side. What you're looking at is just their stuff — the tasks that are relevant to them, their process, laid out in a way that makes sense for their role. It's a clean, focused view built around what a recruiter actually does day to day.",
    callout:{label:'Recruiter guide',text:'Job posting \u00b7 Pipelines \u00b7 Offer management',dot:{x:50,y:14},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Schedule Interview — Step by Step', url:'/',
    auto:[
      {d:800, a:{action:'openTaskDetail',taskId:'sched-interview'}},
      {d:4500,a:{action:'expandTaskSteps',taskId:'sched-interview',indices:[0]}}
    ],
    minHold:10000,
    voice:"She opens Schedule Interview. You can see all the steps here — who does each one, what's involved, what order they go in. Before the client has even asked her a question about this, she's already got the full picture in front of her.",
    callout:{label:'Process walkthrough',text:'Every step, every owner — no ambiguity',dot:{x:50,y:50},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Step 2 Has an Issue — Ask AI', url:'/',
    auto:[
      {d:800, a:{action:'expandTaskSteps',taskId:'sched-interview',indices:[1]}},
      {d:4000,a:{action:'openStuck',taskId:'sched-interview',stepIdx:1}},
      {d:7500,a:{action:'askAIForStuck',taskId:'sched-interview',stepIdx:1}}
    ],
    manual:true,
    manualHint:22000,
    voice:"Step two is where teams keep getting stuck. She flags it. EX3 surfaces the likely causes immediately. One click and that exact step goes to the AI — everything pre-loaded. Watch it answer. Click next when you are ready.",
    callout:{label:'Built-in troubleshooting',text:'Flag any step \u2014 AI answers with full context',dot:{x:80,y:20},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Follow-Up — Context Memory', url:'/',
    auto:[
      {d:1000,a:{action:'typeAndAsk',query:'What permission level do I need to schedule on behalf of someone?'}}
    ],
    manual:true,
    manualHint:25000,
    voice:"Now watch the follow-up. She asks a second question — no re-explaining, no starting over. The AI carries the full conversation. That is context memory. Click next when the answer lands.",
    callout:{label:'Context memory',text:'Follow-up questions \u2014 full conversation carried forward',dot:{x:78,y:36},bubble:{x:2,y:4}}
  },
  {
    type:'card', icon:'', title:'Ask anything.', chap:'Chapter II', headline:'Ask anything.<br><em>Get an answer.</em>', countdown:4, auto:[], callout:null,
    voice:"And that AI you just saw — you can ask it literally anything. Not just the stuck steps. Any SmartRecruiters question, any point in the project, any time of day."
  },
  {
    icon:'', title:'Try It — Ask Anything', url:'/',
    auto:[{d:800,a:{action:'openAI'}}],
    manual:true,
    manualHint:5000,
    voice:"Go ahead — ask it anything you like. A SmartRecruiters question, something about the process, whatever comes to mind. Click next whenever you are done.",
    callout:null
  },
  {
    icon:'', title:'Implementation Runbook', url:'/',
    auto:[
      {d:700, a:{action:'closeAI'}},
      {d:1400,a:{action:'openUnifiedFlow'}},
      {d:5500,a:{action:'setFlowProcesses',ids:['post-job','sched-interview','add-workflow','add-assessment'],buildNow:true}}
    ],
    minHold:13000,
    voice:"After the call she builds the implementation runbook. Picks the exact processes the client needs. One click and the full sequence generates — post job, schedule interview, workflow automation, assessments. The whole delivery plan, structured and ready.",
    callout:{label:'One-go workflow',text:'Full implementation sequence \u2014 generated in seconds',dot:{x:50,y:50},bubble:{x:2,y:4}}
  },
  {
    type:'card', icon:'', title:'Same AI. On WhatsApp.', chap:'Chapter III', headline:'Same AI.<br><em>On WhatsApp.</em>', auto:[], callout:null,
    voice:"No app. No login. Just WhatsApp.",
    postVoice:"Quick one. I\\'m five minutes from the client site. Their hiring manager just messaged — the Send Offer button isn\\'t showing up. I need to know what\\'s blocking it before I walk in. Thanks.",
    postVoiceStressed:true
  },
  {
    icon:'', title:'WhatsApp AI Bot',
    url:null,
    ph:{icon:'',title:'',body:'',link:null},
    recordingScene:true,
    calloutDelay:26000,
    minHold:32000,
    waChat:[
      {from:'me', type:'voice', delay:500, ts:'06:07'},
      {from:'them', text:"The Send Offer button only appears once three things are in place:\\n\\n1\ufe0f\u20e3 The candidate is in the *Offer* stage\\n2\ufe0f\u20e3 The job has an active offer letter template\\n3\ufe0f\u20e3 You have the *Offer Manager* permission\\n\\nWhich one would you like to check first?", delay:14000, ts:'06:07'},
      {from:'me', text:"Probably permissions \u2014 how do I check that?", delay:18500, ts:'06:08'},
      {from:'them', text:"Go to *Admin \u2192 User Management*, find your name, and look at your assigned role.\\n\\nYou need either the *Offer Manager* role, or a custom role with the *Create Offer* permission enabled.\\n\\nIf it\\'s missing your SR admin can add it in about 2 minutes.", delay:21000, ts:'06:08'}
    ],
    auto:[],
    voice:"Six oh seven in the morning. Sarah is in the back of a cab, five minutes from the client site. The hiring manager has messaged — the Send Offer button is gone. She does not type. She records a voice note on WhatsApp, presses send, and watches the answer land before she even gets out of the car. Same AI. No app. No login. Around the clock.",
    callout:{label:'WhatsApp AI bot',text:'Voice notes supported \u2014 no app, no login',dot:{x:50,y:50},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Consultant Portal', url:'/consultant',
    auto:[{d:800,a:{action:'showPhases'}},{d:1700,a:{action:'openPhase',index:0}},{d:3500,a:{action:'openPhase',index:1}},{d:5300,a:{action:'openPhase',index:2}},{d:7100,a:{action:'openPhase',index:3}}],
    minHold:9500,
    voice:"Back at her desk, Sarah is running the engagement through the consultant portal. The EXcelerate methodology — four phases, each one fully structured. Examine, Adopt, Validate, Launch. Checklists, RACI, deliverables, timelines. Everything her delivery team needs to run a clean deployment.",
    callout:{label:'EXcelerate methodology',text:'Examine \u00b7 Adopt \u00b7 Validate \u00b7 Launch',dot:{x:50,y:42},bubble:{x:2,y:4}}
  },
  {
    type:'card', icon:'', title:'A complete SOW. In 45 seconds.', chap:'Chapter IV', headline:'A complete SOW.<br><em>In 45 seconds.</em>', countdown:4, auto:[], callout:null,
    voice:"The client has asked for a formal Statement of Work before they will sign off. Watch what happens next."
  },
  {
    icon:'', title:'SOW Builder', url:'/consultant/sow-builder', auto:[{d:500,a:{action:'demoWalkSOW'}}], countdown:10,
    voice:"She opens the SOW builder. Nineteen questions — org size, geography, integrations, approval workflows, compliance, training approach, go-live date. Every single one answered. At the end, a complete Statement of Work structured around every EXcelerate phase.",
    callout:{label:'19-step SOW wizard',text:'Every requirement captured \u2014 EXcelerate format output',dot:{x:50,y:32},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'AI SOW Rewrite', url:'/consultant/sow-builder', auto:[{d:1000,a:{action:'triggerAIRewrite'}}],
    minHold:7000,
    voice:"One click. The AI rewrites the whole thing into polished, client-ready consulting language — streamed live, word by word. Boardroom-ready. Done before the afternoon stand-up.",
    callout:{label:'AI rewrite',text:'Client-ready language, generated instantly',dot:{x:50,y:54},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Export & Email', url:'/consultant/sow-builder', auto:[{d:800,a:{action:'scrollToExport'}}],
    voice:"She exports it as a structured Word document — proper headings, phase tables, RACI matrices. Or sends it straight to the client by email. From generation to delivery, without leaving the page.",
    callout:{label:'One-click delivery',text:'Structured Word doc or direct email to client',dot:{x:50,y:78},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Analytics & Insights',
    url:null,
    analyticsPanel:true,
    auto:[],
    minHold:13000,
    voice:"Three weeks in. The data tells the story. Two hundred and forty seven AI queries this week. Four point two hours saved per consultant. Twelve active engagements running clean. The platform does not just support the work — it measures it.",
    callout:{label:'Live analytics',text:'Queries, time saved, engagement health \u2014 all tracked',dot:{x:50,y:50},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:"That\\'s EX3", url:'/', auto:[{d:600,a:{action:'setRole',role:'rec'}}],
    voice:"The kickoff went well. The SOW is signed. The team is live. Sarah has sixty days to deliver — and everything she needs is right here. Role training for every person. An AI that answers anything. WhatsApp, voice notes, no login. A complete SOW in forty-five seconds. That is EX3.",
    callout:null
  }
];

// ── State ──
var cur = 0, prevCur = -1, paused = false, muted = false;
var autoTimers = [], advTimer = null;
var narrationStepToken = 0;
var currentAudio = null;
var frameInteracted = false;

// ── Frame crossfade ──
function flashFrame(){
  var el=document.getElementById('frame-fade');
  if(!el) return;
  el.classList.add('in');
  setTimeout(function(){ el.classList.remove('in'); },300);
}

// ── Auto-advance ring ──
var autoRingInterval=null;
function startAutoAdvance(secs, onDone){
  stopAutoAdvance();
  var remaining=secs;
  var ring=document.getElementById('auto-ring');
  var fill=document.getElementById('auto-ring-fill');
  var num=document.getElementById('auto-ring-n');
  var circ=100.5;
  if(!ring) return;
  ring.classList.add('show');
  num.textContent=remaining;
  fill.style.strokeDashoffset=circ;
  autoRingInterval=setInterval(function(){
    remaining--;
    num.textContent=remaining;
    fill.style.strokeDashoffset=Math.round(circ - circ*((secs-remaining)/secs));
    if(remaining<=0){ stopAutoAdvance(); onDone(); }
  },1000);
}
function stopAutoAdvance(){
  if(autoRingInterval){ clearInterval(autoRingInterval); autoRingInterval=null; }
  var ring=document.getElementById('auto-ring');
  if(ring) ring.classList.remove('show');
}

function markFrameInteracted(){
  frameInteracted = true;
  clearAuto();
  hideCallout();
}

function stopAudio(){
  if(currentAudio){ currentAudio.pause(); currentAudio.src = ''; currentAudio = null; }
}
function pauseAudio(){ if(currentAudio) currentAudio.pause(); }
function resumeAudio(){ if(currentAudio) currentAudio.play().catch(function(){}); }
function unlockSpeech(){}

// ── Narration ──
function buildWords(text){
  return text.split(' ').map(function(w,i){ return {w:w,i:i}; });
}

function renderWords(text, charPos){
  var words = text.split(' ');
  var pos = 0;
  var html = '';
  for(var i=0;i<words.length;i++){
    var start = pos;
    var end = pos + words[i].length;
    var cls;
    if(charPos < 0){ cls = 'w future'; }
    else if(charPos > end){ cls = 'w past'; }
    else if(charPos >= start){ cls = 'w now'; }
    else { cls = 'w future'; }
    html += '<span class="'+cls+'">'+words[i]+' </span>';
    pos = end + 1;
  }
  document.getElementById('nar-words').innerHTML = html;
}

function speak(text, onDone, stepToken){
  stopAudio();
  document.getElementById('bars').classList.remove('speaking');

  if(muted){
    renderWords(text, -1);
    var est = Math.max(7000, text.split(' ').length * 430);
    autoTimers.push(setTimeout(function(){
      if(stepToken !== narrationStepToken) return;
      if(onDone) onDone();
    }, est));
    return;
  }

  renderWords(text, -1);
  document.getElementById('bars').classList.add('speaking');

  var words = text.split(' ');
  var completed = false;
  var wordTimer = null;

  function finish(){
    if(completed) return;
    completed = true;
    if(wordTimer){ clearInterval(wordTimer); wordTimer = null; }
    stopAudio();
    document.getElementById('bars').classList.remove('speaking');
    document.getElementById('nar-pb-fill').style.width = '100%';
    renderWords(text, text.length + 1);
    setTimeout(function(){ if(onDone) onDone(); }, 300);
  }

  var audio = new Audio('/api/tts?text=' + encodeURIComponent(text));
  currentAudio = audio;

  audio.oncanplay = function(){
    if(stepToken !== narrationStepToken){ stopAudio(); return; }
    audio.play().catch(function(){ if(stepToken === narrationStepToken) finish(); });
  };

  audio.onplay = function(){
    // Animate word highlights proportionally to audio duration
    wordTimer = setInterval(function(){
      if(stepToken !== narrationStepToken){ clearInterval(wordTimer); return; }
      if(!audio.duration || audio.paused) return;
      var pct = audio.currentTime / audio.duration;
      var charPos = Math.floor(pct * text.length);
      renderWords(text, charPos);
      document.getElementById('nar-pb-fill').style.width = Math.min(99, Math.round(pct * 100)) + '%';
    }, 150);
  };

  audio.onended = function(){
    if(stepToken !== narrationStepToken) return;
    finish();
  };

  audio.onerror = function(){
    if(stepToken !== narrationStepToken) return;
    finish();
  };
}

// ── Callout ──
function showCallout(c){
  var bub = document.getElementById('cbubble');
  var dot = document.getElementById('cdot');
  bub.classList.remove('show'); dot.classList.remove('show');
  if(!c) return;
  var fa = document.getElementById('frame-area');
  var fw = fa.offsetWidth, fh = fa.offsetHeight;
  dot.style.left = Math.round(fw * c.dot.x / 100) + 'px';
  dot.style.top  = Math.round(fh * c.dot.y / 100) + 'px';
  var bx = Math.round(fw * c.bubble.x / 100);
  var by = Math.round(fh * c.bubble.y / 100);
  bub.style.left = bx + 'px';
  bub.style.top  = by + 'px';
  bub.innerHTML = '<strong>'+c.label+'</strong>'+c.text;
  setTimeout(function(){ bub.classList.add('show'); dot.classList.add('show'); }, 900);
}

function hideCallout(){
  document.getElementById('cbubble').classList.remove('show');
  document.getElementById('cdot').classList.remove('show');
}

// ── Dots ──
function renderDots(){
  document.getElementById('dots-row').innerHTML = steps.map(function(_,i){
    var cls = i<cur?'dot done':i===cur?'dot cur':'dot';
    return '<div class="'+cls+'" onclick="jumpTo('+i+', true)" title="'+steps[i].title+'"></div>';
  }).join('');
  document.getElementById('prog-fill').style.width = Math.round((cur+1)/steps.length*100)+'%';
}

// ── Step pill ──
function showPill(s, idx){
  var el = document.getElementById('step-pill');
  el.classList.remove('show');
  document.getElementById('pill-icon').textContent = s.icon;
  document.getElementById('pill-title').textContent = s.title;
  setTimeout(function(){ el.classList.add('show'); }, 150);
  setTimeout(function(){ el.classList.remove('show'); }, 4500);
}

// ── postMessage ──
function postToFrame(msg){
  try{ document.getElementById('liveFrame').contentWindow.postMessage(Object.assign({type:'EX3_DEMO'},msg),'*'); }catch(e){}
}

function clearAnalytics(){
  var el = document.getElementById('analytics-shell');
  if(el) el.classList.remove('active');
}
function showAnalytics(){
  var el = document.getElementById('analytics-shell');
  if(!el) return;
  el.classList.add('active');
  // Animate counters
  var targets = [{id:'an-k1',val:247,dec:0},{id:'an-k2',val:4.2,dec:1},{id:'an-k3',val:94,dec:0},{id:'an-k4',val:12,dec:0}];
  targets.forEach(function(t){
    var el2 = document.getElementById(t.id);
    if(!el2) return;
    var suffix = el2.querySelector('.an-knum-suffix') ? el2.querySelector('.an-knum-suffix').outerHTML : '';
    var start = Date.now(), dur = 1400;
    function tick(){
      var p = Math.min((Date.now()-start)/dur, 1);
      var ease = 1-Math.pow(1-p,3);
      var v = t.val * ease;
      el2.innerHTML = (t.dec ? v.toFixed(t.dec) : Math.round(v)) + suffix;
      if(p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  // Animate bars
  setTimeout(function(){
    document.querySelectorAll('#analytics-shell .an-bar').forEach(function(b){ b.classList.add('grow'); });
  }, 200);
  // Animate question fills
  setTimeout(function(){
    document.querySelectorAll('#analytics-shell .an-q-fill').forEach(function(f){ f.style.width = f.style.getPropertyValue('--w') || '50%'; });
  }, 600);
}

var waTimers = [], waVoiceAudio = null;
function clearWaChat(){
  waTimers.forEach(clearTimeout); waTimers = [];
  if(waVoiceAudio){ waVoiceAudio.pause(); waVoiceAudio.currentTime = 0; waVoiceAudio = null; }
  var shell = document.getElementById('wa-shell');
  if(shell) shell.classList.remove('active');
  var msgs = document.getElementById('wa-msgs');
  if(msgs) msgs.innerHTML = '';
  var typ = document.getElementById('wa-typing');
  if(typ) typ.classList.remove('show');
  var rec = document.getElementById('wa-recording-scene');
  if(rec){ rec.classList.remove('active'); rec.style.opacity = ''; }
}
function startWaChat(msgs){
  var list = document.getElementById('wa-msgs');
  var typ = document.getElementById('wa-typing');
  if(!list) return;
  var now = new Date();
  var defaultTs = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
  msgs.forEach(function(msg){
    var ts = msg.ts || defaultTs;
    if(msg.from === 'them'){
      waTimers.push(setTimeout(function(){
        typ.classList.add('show');
        list.scrollTop = list.scrollHeight;
        waTimers.push(setTimeout(function(){
          typ.classList.remove('show');
          var b = document.createElement('div');
          b.className = 'wa-bubble them';
          b.textContent = msg.text;
          var t = document.createElement('span'); t.className='wa-time'; t.textContent=ts;
          b.appendChild(t);
          list.appendChild(b);
          setTimeout(function(){ b.classList.add('show'); },20);
          list.scrollTop = list.scrollHeight;
        }, 1400));
      }, msg.delay || 0));
    } else {
      waTimers.push(setTimeout(function(){
        var b = document.createElement('div');
        b.className = 'wa-bubble me';
        if(msg.type === 'voice'){
          var bh = [4,6,9,14,18,20,16,10,14,20,12,8,6,14,18,14,10,8,12,16,10,8,6,10,14];
          var barHtml = bh.map(function(h){ return '<div class="wa-wbar" style="height:'+h+'px"></div>'; }).join('');
          var dur = msg.voiceText ? Math.round(msg.voiceText.length / 14) : 8;
          b.innerHTML = '<div class="wa-voice-note"><div class="wa-voice-play"><span style="color:#fff;font-size:11px;margin-left:2px">\u25B6</span></div><div class="wa-waveform">'+barHtml+'</div><span class="wa-voice-dur">0:'+dur.toString().padStart(2,'0')+'</span></div>';
          if(msg.voiceText){
            var vt = encodeURIComponent(msg.voiceText);
            setTimeout(function(){
              if(waVoiceAudio){ waVoiceAudio.pause(); waVoiceAudio = null; }
              waVoiceAudio = new Audio('/api/tts?text='+vt+'&stressed=1');
              waVoiceAudio.play().catch(function(){});
            }, 500);
          }
        } else {
          b.textContent = msg.text;
        }
        var t = document.createElement('span'); t.className='wa-time';
        t.innerHTML = ts + ' <span class="wa-tick">\u2713\u2713</span>';
        b.appendChild(t);
        list.appendChild(b);
        setTimeout(function(){ b.classList.add('show'); },20);
        list.scrollTop = list.scrollHeight;
      }, msg.delay || 0));
    }
  });
}

function clearAuto(){
  autoTimers.forEach(function(t){ clearTimeout(t); }); autoTimers = [];
  if(advTimer){ clearTimeout(advTimer); advTimer = null; }
  stopAutoAdvance();
  var btn = document.querySelector('.nar-btn.next');
  if(btn) btn.classList.remove('ready');
}

function fireAuto(s){
  if(!s.auto) return;
  s.auto.forEach(function(cmd){
    autoTimers.push(setTimeout(function(){
      if(frameInteracted) return;
      postToFrame(cmd.a);
    }, cmd.d));
  });
}

function bindFrameInteractionHandlers(){
  try {
    var frame = document.getElementById('liveFrame');
    var win = frame.contentWindow;
    if(!win || win.__ex3DemoBound) return;
    win.addEventListener('pointerdown', markFrameInteracted, { passive: true });
    win.addEventListener('keydown', markFrameInteracted);
    frame.addEventListener('pointerdown', markFrameInteracted, { passive: true });
    frame.addEventListener('focus', markFrameInteracted);
    win.__ex3DemoBound = true;
  } catch(e) {}
}

window.addEventListener('message', function(e){
  if(!e.data || e.data.type !== 'EX3_DEMO_INTERACTION') return;
  markFrameInteracted();
});

// ── Render ──
function render(){
  if(paused) return;
  var s = steps[cur];
  var stepToken = ++narrationStepToken;
  var stepStartTime = Date.now();
  frameInteracted = false;
  document.getElementById('tb-step').textContent = 'Step '+(cur+1)+' of '+steps.length;
  document.getElementById('nar-tag').textContent = s.title;
  document.getElementById('nar-pb-fill').style.width = '0%';
  renderDots();
  showPill(s, cur);
  clearAuto();
  hideCallout();
  stopAudio();
  document.getElementById('bars').classList.remove('speaking');

  // Frame
  var cardPanel = document.getElementById('card-panel');
  var recScene = document.getElementById('wa-recording-scene');
  if(cardPanel) cardPanel.classList.remove('active');
  if(recScene){ recScene.classList.remove('active'); recScene.style.opacity = ''; }
  clearAnalytics();

  if(s.type === 'card'){
    document.getElementById('liveFrame').style.display = 'none';
    document.getElementById('ph').style.display = 'none';
    if(cardPanel){
      document.getElementById('card-chap').textContent = s.chap || '';
      document.getElementById('card-headline').innerHTML = s.headline || '';
      setTimeout(function(){ cardPanel.classList.add('active'); }, 20);
    }
  } else if(s.url){
    var same = prevCur>=0 && steps[prevCur] && steps[prevCur].url===s.url;
    document.getElementById('ph').style.display = 'none';
    document.getElementById('liveFrame').style.display = 'block';
    if(!same){
      flashFrame();
      document.getElementById('liveFrame').src = s.url;
      document.getElementById('liveFrame').onload = function(){
        bindFrameInteractionHandlers();
        fireAuto(s);
        document.getElementById('liveFrame').onload = null;
      };
    } else {
      bindFrameInteractionHandlers();
      fireAuto(s);
    }
  } else {
    document.getElementById('liveFrame').style.display = 'none';
    clearWaChat();
    if(s.analyticsPanel){
      document.getElementById('ph').style.display = 'none';
      setTimeout(function(){ showAnalytics(); }, 80);
    } else if(s.waChat){
      document.getElementById('ph').style.display = 'flex';
      document.getElementById('ph-icon').textContent = '';
      document.getElementById('ph-title').textContent = '';
      document.getElementById('ph-body').textContent = '';
      document.getElementById('ph-cta').style.display = 'none';
      if(s.recordingScene && recScene){
        recScene.classList.add('active');
        autoTimers.push(setTimeout(function(){
          if(narrationStepToken !== stepToken) return;
          recScene.style.opacity = '0';
          autoTimers.push(setTimeout(function(){
            recScene.classList.remove('active');
            recScene.style.opacity = '';
            document.getElementById('wa-shell').classList.add('active');
            startWaChat(s.waChat);
          }, 500));
        }, 3200));
      } else {
        document.getElementById('wa-shell').classList.add('active');
        startWaChat(s.waChat);
      }
    } else {
      document.getElementById('ph').style.display = 'flex';
      var ph = s.ph || {};
      document.getElementById('ph-icon').textContent = ph.icon || s.icon;
      document.getElementById('ph-title').textContent = ph.title || s.title;
      document.getElementById('ph-body').textContent = ph.body || '';
      var cta = document.getElementById('ph-cta');
      if(ph.link){ cta.style.display='inline-block'; cta.textContent=ph.link.label; cta.href=ph.link.url; }
      else{ cta.style.display='none'; }
    }
  }
  prevCur = cur;

  // Show callout after a short delay
  var calloutTimer = setTimeout(function(){ showCallout(s.callout); }, s.calloutDelay || 1500);
  autoTimers.push(calloutTimer);

  // Speak, then auto-advance (ring only for steps with explicit countdown)
  speak(s.voice, function(){
    if(stepToken !== narrationStepToken) return;
    if(paused) return;
    if(cur >= steps.length-1) return;
    if(s.postVoice){
      var pvDone = false;
      function advAfterPV(){ if(pvDone) return; pvDone=true; if(stepToken!==narrationStepToken||paused) return; go(1); }
      var pvAud = new Audio('/api/tts?text='+encodeURIComponent(s.postVoice)+(s.postVoiceStressed?'&stressed=1':''));
      pvAud.play().catch(function(){});
      pvAud.onended = advAfterPV;
      autoTimers.push(setTimeout(advAfterPV, 18000));
      return;
    }
    if(s.countdown){
      startAutoAdvance(s.countdown, function(){ go(1); });
    } else if(s.manual){
      // Wait for user to click Next Step — pulse the button after the AI has had time to answer
      var hint = s.manualHint || 18000;
      autoTimers.push(setTimeout(function(){
        if(stepToken !== narrationStepToken) return;
        var btn = document.querySelector('.nar-btn.next');
        if(btn) btn.classList.add('ready');
      }, hint));
    } else {
      var elapsed = Date.now() - stepStartTime;
      var wait = Math.max(1800, (s.minHold || 0) - elapsed);
      autoTimers.push(setTimeout(function(){
        if(stepToken !== narrationStepToken || paused) return;
        go(1);
      }, wait));
    }
  }, stepToken);
}

// ── Controls ──
function togglePause(){
  paused = !paused;
  var btn = document.getElementById('pause-btn');
  if(paused){
    pauseAudio();
    btn.textContent = '\u25B6';
    btn.classList.add('on');
    if(advTimer){ clearTimeout(advTimer); advTimer = null; }
  } else {
    btn.textContent = '\u23F8';
    btn.classList.remove('on');
    if(currentAudio){ resumeAudio(); }
    else {
      var s = steps[cur];
      var stepToken = narrationStepToken;
      speak(s.voice, function(){
        if(stepToken !== narrationStepToken) return;
      }, stepToken);
      showCallout(s.callout);
    }
  }
}

function toggleMute(){
  muted = !muted;
  var btn = document.getElementById('mute-btn');
  btn.textContent = muted ? 'MUTE' : 'VOL';
  btn.classList.toggle('muted', muted);
  if(muted) stopAudio();
}

function restartDemo(){
  clearAuto();
  stopAudio();
  paused = false;
  document.getElementById('pause-btn').textContent = '\u23F8';
  document.getElementById('pause-btn').classList.remove('on');
  cur = 0; prevCur = -1;
  render();
}

function jumpTo(i, isManual){
  clearAuto();
  stopAudio();
  paused = false;
  document.getElementById('pause-btn').textContent = '\u23F8';
  document.getElementById('pause-btn').classList.remove('on');
  if(isManual && i>cur) {} // no chime
  cur = i;
  render();
}

function go(d){
  var n = Math.max(0,Math.min(steps.length-1,cur+d));
  if(n !== cur) jumpTo(n, d>0);
}

function replayStep(){
  jumpTo(cur, true);
}

function retryAudio(){
  stopAudio();
  var step = steps[cur];
  narrationStepToken++;
  if(step.voice){
    speak(step.voice, null, narrationStepToken);
  }
}

document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if(e.key==='ArrowRight'||e.key===' '){ e.preventDefault(); go(1); }
  if(e.key==='ArrowLeft') go(-1);
  if(e.key==='p'||e.key==='P') togglePause();
  if(e.key==='m'||e.key==='M') toggleMute();
  if(e.key==='r'||e.key==='R') restartDemo();
});

// ── Begin ──
function beginDemo(){
  var ss = document.getElementById('start-screen');
  ss.classList.add('fade');
  setTimeout(function(){
    ss.style.display = 'none';
    document.getElementById('demo').classList.add('show');
    render();
  }, 600);
}

// ── Count-up stats on load ──
(function(){
  var targets = [{id:'stat-features',val:50,suffix:'+'},{id:'stat-roles',val:4},{id:'stat-time',val:4}];
  targets.forEach(function(t,idx){
    setTimeout(function(){
      var el = document.getElementById(t.id); if(!el) return;
      var count=0, step=1, dur=700, interval=Math.round(dur/t.val);
      var iv = setInterval(function(){
        count += step;
        el.textContent = count + (t.suffix||'');
        if(count >= t.val){ el.textContent = t.val + (t.suffix||''); clearInterval(iv); }
      }, interval);
    }, idx*120);
  });
})();
</script>
</body>
</html>`);
});


// Conversation history page
app.all('/conversations', requirePassword);
app.get('/conversations', (req, res) => {
  const allLogs = readWebLogs();
  const whatsappLogs = readLogs();

  // Group web logs by threadId
  const webThreads = {};
  for (const log of allLogs) {
    const id = log.threadId || 'unknown';
    if (!webThreads[id]) webThreads[id] = [];
    webThreads[id].push(log);
  }

  // Group whatsapp logs by phone
  const waThreads = {};
  for (const log of whatsappLogs) {
    const id = log.phone || 'unknown';
    if (!waThreads[id]) waThreads[id] = [];
    waThreads[id].push(log);
  }

  // Build thread list sorted by most recent message
  const webList = Object.entries(webThreads).map(([id, msgs]) => {
    const sorted = msgs.slice().sort((a, b) => a.ts.localeCompare(b.ts));
    return { id, source: 'web', msgs: sorted, last: sorted[sorted.length - 1].ts, first: sorted[0] };
  }).sort((a, b) => b.last.localeCompare(a.last));

  const waList = Object.entries(waThreads).map(([id, msgs]) => {
    const sorted = msgs.slice().sort((a, b) => a.ts.localeCompare(b.ts));
    return { id, source: 'whatsapp', msgs: sorted, last: sorted[sorted.length - 1].ts, first: sorted[0] };
  }).sort((a, b) => b.last.localeCompare(a.last));

  const allThreads = [...webList, ...waList].sort((a, b) => b.last.localeCompare(a.last));

  const threadsJson = JSON.stringify(allThreads).replace(/</g, '\\u003c');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Conversation History — EX3</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Inter',system-ui,sans-serif; background:#f8f7f4; color:#0f0f0e; height:100vh; display:flex; flex-direction:column; }
  .topbar { display:flex; align-items:center; justify-content:space-between; padding:14px 24px; background:#fff; border-bottom:1px solid #e4e2dc; flex-shrink:0; }
  .topbar-title { font-size:16px; font-weight:700; }
  .topbar-nav { display:flex; gap:16px; font-size:13px; }
  .topbar-nav a { color:#4a90e2; text-decoration:none; font-weight:600; }
  .layout { display:flex; flex:1; overflow:hidden; }

  /* Thread list sidebar */
  .thread-sidebar { width:300px; background:#fff; border-right:1px solid #e4e2dc; display:flex; flex-direction:column; flex-shrink:0; }
  .thread-search { padding:12px 16px; border-bottom:1px solid #f0ede8; }
  .thread-search input { width:100%; padding:8px 12px; border:1.5px solid #e4e2dc; border-radius:8px; font-family:inherit; font-size:13px; outline:none; background:#f8f7f4; }
  .thread-search input:focus { border-color:#0f0f0f; }
  .thread-list { flex:1; overflow-y:auto; }
  .thread-item { padding:14px 16px; border-bottom:1px solid #f0ede8; cursor:pointer; transition:background 0.1s; }
  .thread-item:hover { background:#faf9f7; }
  .thread-item.active { background:#f0ede8; }
  .thread-meta { display:flex; align-items:center; justify-content:space-between; margin-bottom:5px; }
  .thread-source { font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; padding:2px 7px; border-radius:4px; }
  .thread-source.web { background:#dbeafe; color:#1d4ed8; }
  .thread-source.whatsapp { background:#dcfce7; color:#166534; }
  .thread-date { font-size:11px; color:#aaa; }
  .thread-preview { font-size:12.5px; color:#555; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:4px; }
  .thread-count { font-size:11px; color:#aaa; }
  .thread-empty { padding:32px 16px; text-align:center; color:#bbb; font-size:13px; }

  /* Chat panel */
  .chat-panel { flex:1; display:flex; flex-direction:column; overflow:hidden; }
  .chat-header { padding:16px 24px; background:#fff; border-bottom:1px solid #e4e2dc; flex-shrink:0; }
  .chat-header-title { font-size:14px; font-weight:700; margin-bottom:2px; }
  .chat-header-sub { font-size:12px; color:#aaa; }
  .chat-messages { flex:1; overflow-y:auto; padding:24px; display:flex; flex-direction:column; gap:20px; }
  .chat-empty { display:flex; align-items:center; justify-content:center; height:100%; color:#ccc; font-size:14px; text-align:center; }

  /* Message bubbles */
  .msg { display:flex; flex-direction:column; max-width:72%; }
  .msg.user { align-self:flex-end; align-items:flex-end; }
  .msg.ai { align-self:flex-start; align-items:flex-start; }
  .msg-label { font-size:10.5px; font-weight:600; color:#aaa; margin-bottom:5px; letter-spacing:0.5px; }
  .msg.user .msg-label { color:#6b7280; }
  .bubble { padding:12px 16px; border-radius:14px; font-size:13.5px; line-height:1.65; white-space:pre-wrap; word-break:break-word; }
  .msg.user .bubble { background:#0f0f0f; color:#fff; border-bottom-right-radius:4px; }
  .msg.ai .bubble { background:#fff; border:1px solid #e4e2dc; color:#0f0f0e; border-bottom-left-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,.04); }
  .msg.ai .bubble.uncertain { border-color:#fde68a; background:#fffbeb; }
  .msg-time { font-size:10.5px; color:#ccc; margin-top:5px; }
  .uncertain-badge { font-size:10px; font-weight:700; color:#92400e; background:#fef3c7; padding:2px 8px; border-radius:4px; margin-top:4px; display:inline-block; }
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-title">Conversation History</div>
  <div class="topbar-nav">
    <a href="/analytics">WhatsApp Analytics</a>
    <a href="/analytics/web">Web Analytics</a>
  </div>
</div>
<div class="layout">
  <div class="thread-sidebar">
    <div class="thread-search">
      <input type="text" id="search" placeholder="Search conversations..." oninput="filterThreads(this.value)">
    </div>
    <div class="thread-list" id="thread-list"></div>
  </div>
  <div class="chat-panel">
    <div class="chat-header" id="chat-header" style="display:none">
      <div class="chat-header-title" id="chat-header-title"></div>
      <div class="chat-header-sub" id="chat-header-sub"></div>
    </div>
    <div class="chat-messages" id="chat-messages">
      <div class="chat-empty">Select a conversation on the left to read it</div>
    </div>
  </div>
</div>
<script>
const threads = ${threadsJson};
let active = null;

function relativeDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  return d.toLocaleDateString([], {day:'numeric', month:'short'});
}

function renderThreadList(list) {
  const el = document.getElementById('thread-list');
  if (!list.length) { el.innerHTML = '<div class="thread-empty">No conversations yet</div>'; return; }
  el.innerHTML = list.map((t, i) => {
    const src = t.source === 'whatsapp' ? 'WhatsApp' : 'Web';
    const srcCls = t.source;
    const preview = t.first.question || t.first.body || '';
    const cls = active === t.id ? ' active' : '';
    return '<div class="thread-item' + cls + '" onclick="openThread(' + i + ')">' +
      '<div class="thread-meta">' +
        '<span class="thread-source ' + srcCls + '">' + src + '</span>' +
        '<span class="thread-date">' + relativeDate(t.last) + '</span>' +
      '</div>' +
      '<div class="thread-preview">' + esc(preview.slice(0, 80)) + '</div>' +
      '<div class="thread-count">' + t.msgs.length + ' message' + (t.msgs.length !== 1 ? 's' : '') + '</div>' +
    '</div>';
  }).join('');
}

function openThread(idx) {
  const t = filteredThreads[idx];
  active = t.id;
  renderThreadList(filteredThreads);

  const label = t.source === 'whatsapp' ? 'WhatsApp — ' + t.id : 'Web Chat — ' + t.id.slice(-12);
  document.getElementById('chat-header').style.display = 'block';
  document.getElementById('chat-header-title').textContent = label;
  document.getElementById('chat-header-sub').textContent =
    t.msgs.length + ' messages · Started ' + new Date(t.msgs[0].ts).toLocaleString();

  const el = document.getElementById('chat-messages');
  el.innerHTML = t.msgs.map(m => {
    const q = m.question || m.body || '';
    const a = m.answer || m.response || '';
    const ts = new Date(m.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const uncertainBadge = m.uncertain ? '<span class="uncertain-badge">⚠ Uncertain answer</span>' : '';
    let html = '';
    if (q) {
      html += '<div class="msg user">' +
        '<div class="msg-label">You</div>' +
        '<div class="bubble">' + esc(q) + '</div>' +
        '<div class="msg-time">' + ts + '</div>' +
      '</div>';
    }
    if (a) {
      html += '<div class="msg ai">' +
        '<div class="msg-label">EX3 AI</div>' +
        '<div class="bubble' + (m.uncertain ? ' uncertain' : '') + '">' + esc(a) + '</div>' +
        uncertainBadge +
        '<div class="msg-time">' + ts + ' · ' + (m.ms ? (m.ms/1000).toFixed(1) + 's' : '') + '</div>' +
      '</div>';
    }
    return html;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let filteredThreads = threads;

function filterThreads(q) {
  q = q.toLowerCase();
  filteredThreads = q ? threads.filter(t =>
    t.msgs.some(m => (m.question||'').toLowerCase().includes(q) || (m.answer||'').toLowerCase().includes(q) || (m.body||'').toLowerCase().includes(q))
  ) : threads;
  renderThreadList(filteredThreads);
}

filteredThreads = threads;
renderThreadList(filteredThreads);
</script>
</body>
</html>`);
});

// ── Demo2: Cinematic product experience ──
app.get('/demo2', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EX3 SmartRecruiters — Experience</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:#060606;color:#fff;font-family:'Inter',system-ui,sans-serif;cursor:none}
*{cursor:none!important}

/* Custom cursor */
#cursor{position:fixed;width:10px;height:10px;border-radius:50%;background:#22c55e;pointer-events:none;z-index:9999;transform:translate(-50%,-50%);transition:transform .08s ease,width .2s ease,height .2s ease,opacity .2s ease;mix-blend-mode:normal}
#cursor-ring{position:fixed;width:38px;height:38px;border-radius:50%;border:1.5px solid rgba(34,197,94,.4);pointer-events:none;z-index:9998;transform:translate(-50%,-50%);transition:transform .18s ease,width .2s ease,height .2s ease,opacity .3s ease}
#cursor.clicked{transform:translate(-50%,-50%) scale(.6)}
#cursor-ring.clicked{width:52px;height:52px;opacity:.2}

/* Scene system */
.scene{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .55s cubic-bezier(.4,0,.2,1)}
.scene.active{opacity:1;pointer-events:all}

/* Flash overlay */
#ovl{position:fixed;inset:0;background:#000;z-index:1000;opacity:0;pointer-events:none;transition:opacity .28s ease}
#ovl.on{opacity:1}

/* Progress line */
#adv{position:fixed;bottom:0;left:0;height:2px;background:linear-gradient(90deg,#16a34a,#22c55e);z-index:500;width:0}

/* Nav dots */
#nav{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:600}
.ndot{width:5px;height:5px;border-radius:3px;background:#1c1c1c;transition:all .4s ease;cursor:pointer!important}
.ndot:hover{background:#333}
.ndot.cur{background:#22c55e;width:20px}
.ndot.done{background:#166534;width:8px}

/* Click hint */
#hint{position:fixed;bottom:52px;right:28px;font-size:9px;color:#1e1e1e;font-weight:800;letter-spacing:.14em;text-transform:uppercase;z-index:600;transition:opacity .6s;display:flex;align-items:center;gap:8px}
#hint::before{content:'';width:18px;height:1px;background:#1e1e1e}

/* Shared ambient glow */
.glow{position:absolute;width:700px;height:700px;background:radial-gradient(circle,rgba(34,197,94,.07) 0%,transparent 60%);pointer-events:none;animation:gp 6s ease-in-out infinite}
@keyframes gp{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.15)}}

/* Appear helpers */
.ap{opacity:0;transform:translateY(22px);transition:opacity .55s ease,transform .55s ease}
.ap.go{opacity:1;transform:translateY(0)}
.ap2{opacity:0;transition:opacity .55s ease}
.ap2.go{opacity:1}
.aps{opacity:0;transform:scale(.92);transition:opacity .65s ease,transform .65s ease}
.aps.go{opacity:1;transform:scale(1)}

/* ── SCENE 0: SPLASH ── */
#s0{background:#060606;flex-direction:column;text-align:center;overflow:hidden}
.splash-logo{font-size:clamp(90px,16vw,200px);font-weight:900;letter-spacing:-.06em;color:#22c55e;line-height:1}
.splash-brand{font-size:clamp(11px,1.4vw,16px);font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#1c1c1c;margin-top:16px}
.splash-tag{font-size:clamp(15px,2vw,24px);color:#2a2a2a;margin-top:28px;font-weight:600;line-height:1.6;max-width:480px}
.splash-tag em{color:#22c55e;font-style:normal}

/* ── SCENE 1: STORY ── */
#s1{background:#060606;flex-direction:column;align-items:flex-start;padding:0 10vw}
.sline{font-size:clamp(30px,5.5vw,76px);font-weight:900;letter-spacing:-.05em;line-height:1.08;margin-bottom:8px;color:#fff}
.sline em{color:#22c55e;font-style:normal}
.sline.grey{color:#111}

/* ── SCENE 2 & 3: SPLIT LAYOUT ── */
.split{width:100%;height:100%;display:flex;align-items:center;gap:5vw;padding:0 6vw}
.sl{flex:0 0 36%;display:flex;flex-direction:column;gap:14px}
.sr{flex:1;min-width:0}
.sc-label{font-size:9px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#22c55e}
.sc-h{font-size:clamp(24px,3.8vw,52px);font-weight:900;letter-spacing:-.05em;line-height:1.08}
.sc-h em{color:#22c55e;font-style:normal}
.sc-sub{font-size:clamp(12px,1.3vw,15px);color:#444;line-height:1.85}
.role-tags{display:flex;flex-wrap:wrap;gap:7px;margin-top:6px}
.rtag{padding:5px 13px;border-radius:100px;border:1px solid #1a1a1a;font-size:10px;color:#2a2a2a;font-weight:700;transition:all .35s ease}
.rtag.on{border-color:#22c55e;color:#22c55e;background:rgba(34,197,94,.06)}

/* Device frame */
.dev{border-radius:10px;overflow:hidden;box-shadow:0 24px 72px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.04);background:#0e0e0e}
.dev-bar{height:26px;background:#141414;display:flex;align-items:center;padding:0 11px;gap:5px;border-bottom:1px solid #0a0a0a}
.dd{width:8px;height:8px;border-radius:50%}
.dev-frame{height:360px;overflow:hidden}
.dev-frame iframe{width:150%;height:150%;border:none;transform:scale(.667);transform-origin:top left;pointer-events:none}

/* ── SCENE 4: AI ── */
#s4{flex-direction:column;gap:24px;padding:0 8vw;text-align:center}
.ai-shell{background:#0a0a0a;border:1px solid #141414;border-radius:14px;max-width:620px;width:100%;margin:0 auto;overflow:hidden;text-align:left}
.ai-topbar{height:34px;background:#0e0e0e;display:flex;align-items:center;padding:0 13px;gap:7px;border-bottom:1px solid #111}
.ai-topbar-label{flex:1;text-align:center;font-size:9px;color:#2a2a2a;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.ai-body{padding:16px 18px;min-height:200px;display:flex;flex-direction:column;gap:12px}
.ai-row{opacity:0;transform:translateY(8px);transition:opacity .4s ease,transform .4s ease}
.ai-row.show{opacity:1;transform:translateY(0)}
.ai-who{font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin-bottom:4px}
.ai-who.you{color:#22c55e}
.ai-who.bot{color:#818cf8}
.ai-txt{font-size:13px;line-height:1.72;color:#999;white-space:pre-wrap}
.ai-txt.you-txt{color:#555;font-size:12px}
.ai-cur{display:inline-block;width:2px;height:13px;background:#22c55e;margin-left:2px;vertical-align:middle;animation:blink .85s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

/* ── SCENE 5: WHATSAPP ── */
#s5{padding:0 6vw}
.wa-phone{width:300px;flex-shrink:0;border-radius:18px;overflow:hidden;box-shadow:0 24px 72px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.04);background:#e5ddd5;font-family:-apple-system,Helvetica,sans-serif}
.wa-hdr{background:#075e54;padding:12px 14px;display:flex;align-items:center;gap:10px}
.wa-av{width:36px;height:36px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#fff;flex-shrink:0}
.wa-nm{font-size:13px;font-weight:700;color:#fff}
.wa-st{font-size:10px;color:rgba(255,255,255,.65)}
.wa-msgs{padding:10px;display:flex;flex-direction:column;gap:7px;min-height:280px;max-height:340px;overflow-y:auto}
.wa-b{padding:7px 10px 18px;border-radius:8px;font-size:12px;line-height:1.55;position:relative;opacity:0;transform:translateY(6px);transition:opacity .3s,transform .3s;max-width:88%;word-break:break-word;white-space:pre-line}
.wa-b.show{opacity:1;transform:translateY(0)}
.wa-b.me{background:#dcf8c6;align-self:flex-end;border-top-right-radius:0;color:#111}
.wa-b.them{background:#fff;align-self:flex-start;border-top-left-radius:0;color:#111}
.wa-ts{position:absolute;bottom:3px;right:8px;font-size:9px;color:#999}
.wa-typ{display:none;background:#fff;border-radius:8px;border-top-left-radius:0;padding:8px 12px;width:fit-content;align-items:center;gap:3px;margin:0 10px 6px}
.wa-typ.show{display:flex}
.wa-td{width:6px;height:6px;border-radius:50%;background:#bbb;animation:wab .9s infinite ease-in-out}
.wa-td:nth-child(2){animation-delay:.2s}.wa-td:nth-child(3){animation-delay:.4s}
@keyframes wab{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
.wa-vnote{display:flex;align-items:center;gap:8px;min-width:155px}
.wa-vplay{width:28px;height:28px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;flex-shrink:0}
.wa-wf{flex:1;display:flex;align-items:center;gap:2px;height:18px}
.wa-wb{border-radius:2px;background:rgba(0,0,0,.22);width:3px}
.wa-vd{font-size:10px;color:#999;margin-left:2px}

/* ── SCENE 6: SOW ── */
#s6{flex-direction:column;text-align:center;gap:14px}
.sow-n{font-size:clamp(100px,18vw,240px);font-weight:900;letter-spacing:-.07em;color:#22c55e;line-height:1}
.sow-w{font-size:clamp(22px,4.5vw,62px);font-weight:900;letter-spacing:-.05em;color:#fff}
.sow-d{font-size:clamp(12px,1.4vw,17px);color:#2a2a2a;line-height:1.8;max-width:400px}

/* ── SCENE 7: NUMBERS ── */
#s7{flex-direction:column;gap:16px}
.stats-head{font-size:10px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#22c55e;text-align:center}
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;max-width:660px;width:100%}
.stat-cell{background:#090909;padding:36px 30px;display:flex;flex-direction:column;gap:8px;border:1px solid #0e0e0e}
.stat-cell:first-child{border-radius:14px 0 0 0}
.stat-cell:nth-child(2){border-radius:0 14px 0 0}
.stat-cell:nth-child(3){border-radius:0 0 0 14px}
.stat-cell:last-child{border-radius:0 0 14px 0}
.stat-n{font-size:clamp(46px,8vw,88px);font-weight:900;letter-spacing:-.05em;color:#22c55e;line-height:1;font-variant-numeric:tabular-nums}
.stat-l{font-size:11px;color:#2a2a2a;font-weight:700;letter-spacing:.06em;text-transform:uppercase}

/* ── SCENE 8: CTA ── */
#s8{flex-direction:column;text-align:center;gap:22px}
.cta-h{font-size:clamp(32px,6.5vw,96px);font-weight:900;letter-spacing:-.06em;line-height:1.04}
.cta-h em{color:#22c55e;font-style:normal}
.cta-s{font-size:clamp(13px,1.5vw,18px);color:#2a2a2a;line-height:1.85;max-width:460px}
.cta-b{padding:18px 56px;background:#22c55e;color:#000;font-family:inherit;font-size:15px;font-weight:900;border:none;border-radius:14px;cursor:pointer!important;letter-spacing:-.01em;position:relative}
.cta-b::before,.cta-b::after{content:'';position:absolute;inset:-10px;border-radius:22px;border:1.5px solid rgba(34,197,94,.25);animation:cta-pulse 2.4s ease-in-out infinite;pointer-events:none}
.cta-b::after{inset:-20px;border-radius:30px;border-color:rgba(34,197,94,.1);animation-delay:.8s}
@keyframes cta-pulse{0%,100%{opacity:.4;transform:scale(1)}50%{opacity:1;transform:scale(1.02)}}
.cta-b:hover{background:#16a34a}
.cta-note{font-size:9px;color:#1a1a1a;letter-spacing:.12em;text-transform:uppercase}
</style>
</head>
<body>

<div id="cursor"></div>
<div id="cursor-ring"></div>
<div id="ovl"></div>
<div id="adv"></div>
<div id="nav"></div>
<div id="hint">Click to continue</div>

<!-- ── S0: SPLASH ── -->
<div class="scene" id="s0">
  <div class="glow" style="top:-100px;left:-100px"></div>
  <div class="glow" style="bottom:-100px;right:-100px;animation-delay:3s"></div>
  <div style="position:relative;text-align:center;display:flex;flex-direction:column;align-items:center">
    <div class="splash-logo aps" id="s0a">EX3</div>
    <div class="splash-brand ap2" id="s0b">SmartRecruiters</div>
    <div class="splash-tag ap" id="s0c">Everything your team needs.<br><em>On day one.</em></div>
  </div>
</div>

<!-- ── S1: STORY ── -->
<div class="scene" id="s1">
  <div style="padding:0 10vw;width:100%">
    <div class="sline ap" id="sl0">New client.</div>
    <div class="sline ap" id="sl1">Twelve thousand employees.</div>
    <div class="sline ap" id="sl2">Sixty days to go-live.</div>
    <div class="sline grey ap" id="sl3" style="margin-top:28px">One consultant.</div>
    <div class="sline grey ap" id="sl4"><em>This is what she uses.</em></div>
  </div>
</div>

<!-- ── S2: PLATFORM ── -->
<div class="scene" id="s2">
  <div class="split">
    <div class="sl">
      <div class="sc-label ap2" id="s2a">The platform guide</div>
      <div class="sc-h ap" id="s2b">Four roles.<br><em>One platform.</em></div>
      <div class="sc-sub ap" id="s2c">Every person on the project sees exactly what they need — and nothing they don't.</div>
      <div class="role-tags ap2" id="s2d">
        <div class="rtag" id="rt-rec">Recruiter</div>
        <div class="rtag" id="rt-hm">Hiring Manager</div>
        <div class="rtag" id="rt-cand">Candidate</div>
        <div class="rtag" id="rt-adm">Admin</div>
      </div>
    </div>
    <div class="sr">
      <div class="dev ap" id="s2e">
        <div class="dev-bar"><div class="dd" style="background:#ff5f56"></div><div class="dd" style="background:#ffbd2e"></div><div class="dd" style="background:#27c93f"></div></div>
        <div class="dev-frame"><iframe id="s2if" src="/"></iframe></div>
      </div>
    </div>
  </div>
</div>

<!-- ── S3: STEP BY STEP ── -->
<div class="scene" id="s3">
  <div class="split">
    <div class="sl">
      <div class="sc-label ap2" id="s3a">Step-by-step guide</div>
      <div class="sc-h ap" id="s3b">Every step.<br><em>No ambiguity.</em></div>
      <div class="sc-sub ap" id="s3c">Every process broken down to the individual action. Who does what, in what order. Before the client even asks the question.</div>
    </div>
    <div class="sr">
      <div class="dev ap" id="s3e">
        <div class="dev-bar"><div class="dd" style="background:#ff5f56"></div><div class="dd" style="background:#ffbd2e"></div><div class="dd" style="background:#27c93f"></div></div>
        <div class="dev-frame"><iframe id="s3if" src="/"></iframe></div>
      </div>
    </div>
  </div>
</div>

<!-- ── S4: AI ── -->
<div class="scene" id="s4">
  <div style="width:100%;max-width:640px;display:flex;flex-direction:column;gap:24px;padding:0 5vw">
    <div style="text-align:center">
      <div class="sc-label ap2" id="s4a" style="margin-bottom:10px">AI assistant</div>
      <div class="sc-h ap" id="s4b" style="font-size:clamp(26px,4.5vw,60px);text-align:center">Ask anything.<br><em>Get an answer.</em></div>
    </div>
    <div class="ai-shell ap" id="s4c">
      <div class="ai-topbar">
        <div class="dd" style="background:#ff5f56"></div><div class="dd" style="background:#ffbd2e"></div><div class="dd" style="background:#27c93f"></div>
        <div class="ai-topbar-label">EX3 AI Assistant</div>
      </div>
      <div class="ai-body" id="s4body"></div>
    </div>
  </div>
</div>

<!-- ── S5: WHATSAPP ── -->
<div class="scene" id="s5">
  <div class="split">
    <div class="sl">
      <div class="sc-label ap2" id="s5a">WhatsApp AI bot</div>
      <div class="sc-h ap" id="s5b" style="font-size:clamp(26px,4.5vw,58px)"><em>6:07am.</em><br>Back of a cab.</div>
      <div class="sc-sub ap" id="s5c">She records a voice note on WhatsApp. The answer lands before she gets out of the car.<br><br>No app. No login. Around the clock.</div>
    </div>
    <div style="flex-shrink:0">
      <div class="wa-phone ap" id="s5d">
        <div class="wa-hdr">
          <div class="wa-av">EX3</div>
          <div><div class="wa-nm">EX3 AI Assistant</div><div class="wa-st">WhatsApp · usually replies instantly</div></div>
        </div>
        <div class="wa-msgs" id="s5msgs"></div>
        <div class="wa-typ" id="s5typ"><div class="wa-td"></div><div class="wa-td"></div><div class="wa-td"></div></div>
      </div>
    </div>
  </div>
</div>

<!-- ── S6: SOW ── -->
<div class="scene" id="s6">
  <div class="glow"></div>
  <div style="position:relative;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px">
    <div class="sc-label ap2" id="s6a" style="margin-bottom:6px">SOW builder</div>
    <div class="sow-n aps" id="s6b">45</div>
    <div class="sow-w ap" id="s6c">seconds.</div>
    <div class="sow-d ap" id="s6d">A complete Statement of Work — structured, professional, client-ready. Generated and delivered without leaving the page.</div>
  </div>
</div>

<!-- ── S7: NUMBERS ── -->
<div class="scene" id="s7">
  <div style="display:flex;flex-direction:column;gap:18px;align-items:center">
    <div class="stats-head ap2" id="s7a">Three weeks in</div>
    <div class="stats-grid ap" id="s7b">
      <div class="stat-cell"><div class="stat-n" id="sn0">0</div><div class="stat-l">AI queries this week</div></div>
      <div class="stat-cell"><div class="stat-n" id="sn1">0<span style="font-size:.42em">hrs</span></div><div class="stat-l">saved per consultant</div></div>
      <div class="stat-cell"><div class="stat-n" id="sn2">0<span style="font-size:.42em">%</span></div><div class="stat-l">questions answered</div></div>
      <div class="stat-cell"><div class="stat-n" id="sn3">0</div><div class="stat-l">active engagements</div></div>
    </div>
  </div>
</div>

<!-- ── S8: CTA ── -->
<div class="scene" id="s8">
  <div class="glow" style="top:-100px;left:-100px"></div>
  <div class="glow" style="bottom:-100px;right:-100px;animation-delay:3s"></div>
  <div style="position:relative;text-align:center;display:flex;flex-direction:column;align-items:center;gap:20px">
    <div class="cta-h ap" id="s8a">Everything your team needs.<br><em>On day one.</em></div>
    <div class="cta-s ap" id="s8b">Training guide, AI assistant, WhatsApp bot, consultant portal, and SOW builder — the complete SmartRecruiters implementation toolkit.</div>
    <div style="position:relative;margin-top:8px" class="ap" id="s8c">
      <button class="cta-b" onclick="window.location.href='mailto:hello@ex3.io'">Book a demo call</button>
    </div>
    <div class="cta-note ap2" id="s8d">No login required &nbsp;·&nbsp; Works on day one &nbsp;·&nbsp; Built for SmartRecruiters</div>
  </div>
</div>

<script>
// ── Cursor ──
var cur$ = document.getElementById('cursor'), ring$ = document.getElementById('cursor-ring');
document.addEventListener('mousemove', function(e){
  cur$.style.left = e.clientX + 'px'; cur$.style.top = e.clientY + 'px';
  ring$.style.left = e.clientX + 'px'; ring$.style.top = e.clientY + 'px';
});
document.addEventListener('mousedown', function(){ cur$.classList.add('clicked'); ring$.classList.add('clicked'); });
document.addEventListener('mouseup', function(){ cur$.classList.remove('clicked'); ring$.classList.remove('clicked'); });

// ── Scene config ──
var SCENES = [
  {id:'s0', dur:4800},
  {id:'s1', dur:7000},
  {id:'s2', dur:13000},
  {id:'s3', dur:10000},
  {id:'s4', dur:14000},
  {id:'s5', dur:18000},
  {id:'s6', dur:7000},
  {id:'s7', dur:10000},
  {id:'s8', dur:0}
];

var curIdx = 0, advTimer = null;
var s2t = [], s5t = [], s4t = [];

// ── Nav ──
function renderNav(){
  document.getElementById('nav').innerHTML = SCENES.map(function(s,i){
    var c = i < curIdx ? 'ndot done' : i === curIdx ? 'ndot cur' : 'ndot';
    return '<div class="' + c + '" onclick="jumpTo(' + i + ')"></div>';
  }).join('');
}

// ── Advance bar ──
function startBar(ms){
  var b = document.getElementById('adv');
  b.style.transition = 'none'; b.style.width = '0';
  b.offsetWidth; // reflow
  b.style.transition = 'width ' + ms + 'ms linear';
  b.style.width = '100%';
}
function stopBar(){
  var b = document.getElementById('adv');
  b.style.transition = 'none'; b.style.width = '0';
}

// ── Goto ──
function killTimers(){
  clearTimeout(advTimer); advTimer = null;
  stopBar();
  s2t.forEach(clearTimeout); s2t = [];
  s4t.forEach(clearTimeout); s4t = [];
  s5t.forEach(clearTimeout); s5t = [];
}

function jumpTo(idx){
  killTimers();
  document.getElementById(SCENES[curIdx].id).classList.remove('active');
  curIdx = idx;
  activateScene(curIdx);
}

function next(){
  if(curIdx >= SCENES.length - 1) return;
  var ovl = document.getElementById('ovl');
  ovl.classList.add('on');
  setTimeout(function(){
    document.getElementById(SCENES[curIdx].id).classList.remove('active');
    killTimers();
    curIdx++;
    activateScene(curIdx);
    setTimeout(function(){ ovl.classList.remove('on'); }, 60);
  }, 260);
}

function activateScene(idx){
  renderNav();
  var s = SCENES[idx];
  var el = document.getElementById(s.id);
  el.classList.add('active');
  var fn = window['enter_' + s.id];
  if(fn) setTimeout(fn, 80);
  if(s.dur > 0){
    startBar(s.dur);
    advTimer = setTimeout(next, s.dur);
  }
}

// ── Click / keyboard ──
document.addEventListener('click', function(e){
  if(e.target.classList.contains('cta-b')) return;
  if(e.target.classList.contains('ndot')) return;
  next();
});
document.addEventListener('keydown', function(e){
  if(e.key === 'ArrowRight' || e.key === ' ') next();
  if(e.key === 'ArrowLeft' && curIdx > 0) jumpTo(curIdx - 1);
});

// ── Helper ──
function go(id){ var e = document.getElementById(id); if(e){ e.classList.add('go'); } }
function t(ms, fn, arr){ var id = setTimeout(fn, ms); if(arr) arr.push(id); return id; }

// ── Scene enters ──

window.enter_s0 = function(){
  t(100, function(){ go('s0a'); });
  t(500, function(){ go('s0b'); });
  t(1100, function(){ go('s0c'); });
};

window.enter_s1 = function(){
  ['sl0','sl1','sl2','sl3','sl4'].forEach(function(id, i){
    t(150 + i * 750, function(){ go(id); });
  });
};

window.enter_s2 = function(){
  t(80,  function(){ go('s2a'); });
  t(160, function(){ go('s2b'); });
  t(340, function(){ go('s2c'); });
  t(520, function(){ go('s2d'); go('s2e'); });

  var roles = ['rec','hm','cand','adm'];
  var roleMap = {rec:'rt-rec',hm:'rt-hm',cand:'rt-cand',adm:'rt-adm'};
  function setRole(r){
    roles.forEach(function(x){ document.getElementById(roleMap[x]).classList.remove('on'); });
    document.getElementById(roleMap[r]).classList.add('on');
    try { document.getElementById('s2if').contentWindow.postMessage({action:'setRole',role:r},'*'); } catch(e){}
  }
  roles.forEach(function(r, i){
    t(1200 + i * 2800, function(){ setRole(r); }, s2t);
  });
};

window.enter_s3 = function(){
  t(80,  function(){ go('s3a'); });
  t(160, function(){ go('s3b'); });
  t(340, function(){ go('s3c'); });
  t(520, function(){ go('s3e'); });
  t(900, function(){
    try { document.getElementById('s3if').contentWindow.postMessage({action:'setRole',role:'rec'},'*'); } catch(e){}
  });
  t(2200, function(){
    try { document.getElementById('s3if').contentWindow.postMessage({action:'openTaskDetail',taskId:'post-job'},'*'); } catch(e){}
  });
};

var AI_Q = 'How do I set up an offer letter template?';
var AI_A = 'Go to Admin \u2192 Offer Management \u2192 Templates and click \u201cNew Template\u201d.\\n\\nUse merge tags like {candidate_name} and {job_title} for dynamic fields, then set your approval chain \u2014 who needs to approve before the offer is sent.\\n\\nOnce active, recruiters see a \u201cSend Offer\u201d button as soon as a candidate reaches the Offer stage.';

window.enter_s4 = function(){
  t(80, function(){ go('s4a'); });
  t(160, function(){ go('s4b'); });
  t(420, function(){ go('s4c'); });

  var body = document.getElementById('s4body');
  body.innerHTML = '';

  var qRow = document.createElement('div');
  qRow.className = 'ai-row';
  qRow.innerHTML = '<div class="ai-who you">You</div><div class="ai-txt you-txt" id="qtxt"></div>';
  body.appendChild(qRow);

  t(700, function(){
    qRow.classList.add('show');
    var qtxt = document.getElementById('qtxt');
    var i = 0;
    var iv = setInterval(function(){
      qtxt.textContent = AI_Q.slice(0, ++i);
      if(i >= AI_Q.length) clearInterval(iv);
    }, 38);
    s4t.push(iv);
  }, s4t);

  t(700 + AI_Q.length * 38 + 800, function(){
    var aRow = document.createElement('div');
    aRow.className = 'ai-row';
    aRow.innerHTML = '<div class="ai-who bot">EX3 AI</div><div class="ai-txt" id="atxt"><span class="ai-cur"></span></div>';
    body.appendChild(aRow);
    aRow.classList.add('show');

    t(1000, function(){
      var atxt = document.getElementById('atxt');
      atxt.innerHTML = '';
      var j = 0;
      var iv2 = setInterval(function(){
        j += 4;
        atxt.textContent = AI_A.slice(0, j);
        body.scrollTop = body.scrollHeight;
        if(j >= AI_A.length){ atxt.textContent = AI_A; clearInterval(iv2); }
      }, 22);
      s4t.push(iv2);
    }, s4t);
  }, s4t);
};

var WA_CHAT = [
  {from:'me', voice:true, ts:'06:07', delay:500},
  {from:'them', text:"The Send Offer button only appears once three things are in place:\\n\\n1\ufe0f\u20e3 Candidate is in the *Offer* stage\\n2\ufe0f\u20e3 Job has an active offer letter template\\n3\ufe0f\u20e3 You have the *Offer Manager* permission\\n\\nWhich would you like to check first?", ts:'06:07', delay:9000},
  {from:'me', text:'Probably permissions \u2014 how do I check?', ts:'06:08', delay:14000},
  {from:'them', text:"Go to *Admin \u2192 User Management*, find your name, check your assigned role.\\n\\nYou need either the *Offer Manager* role or a custom role with *Create Offer* permission.\\n\\nYour SR admin can add it in about 2 minutes.", ts:'06:08', delay:18500}
];
var WH = [8,14,6,18,10,22,7,16,12,20,8,14,6,18,10,22,7,16,12,20,8,14,6,18,10];

window.enter_s5 = function(){
  t(80,  function(){ go('s5a'); });
  t(160, function(){ go('s5b'); });
  t(340, function(){ go('s5c'); });
  t(480, function(){ go('s5d'); });

  var msgs = document.getElementById('s5msgs');
  msgs.innerHTML = '';
  var typ = document.getElementById('s5typ');
  typ.classList.remove('show');

  WA_CHAT.forEach(function(m, i){
    t(m.delay, function(){
      if(m.voice){
        var b = document.createElement('div');
        b.className = 'wa-b me';
        b.innerHTML = '<div class="wa-vnote"><div class="wa-vplay">\u25b6</div><div class="wa-wf">' +
          WH.map(function(h){ return '<div class="wa-wb" style="height:' + h + 'px"></div>'; }).join('') +
          '</div><span class="wa-vd">0:12</span></div><div class="wa-ts">' + m.ts + '</div>';
        msgs.appendChild(b);
        t(40, function(){ b.classList.add('show'); });
        t(600, function(){ typ.classList.add('show'); });
      } else {
        typ.classList.remove('show');
        t(200, function(){
          var b = document.createElement('div');
          b.className = 'wa-b ' + m.from;
          var html = m.text.replace(/\*(.*?)\*/g, '<strong>$1</strong>');
          b.innerHTML = html + '<div class="wa-ts">' + m.ts + '</div>';
          msgs.appendChild(b);
          msgs.scrollTop = msgs.scrollHeight;
          t(40, function(){ b.classList.add('show'); });
          if(i < WA_CHAT.length - 1 && WA_CHAT[i+1].from === 'them'){
            t(500, function(){ typ.classList.add('show'); });
          }
        });
      }
    }, s5t);
  });
};

window.enter_s6 = function(){
  t(80,  function(){ go('s6a'); });
  t(200, function(){ go('s6b'); });
  t(700, function(){ go('s6c'); });
  t(1100,function(){ go('s6d'); });
};

window.enter_s7 = function(){
  t(80, function(){ go('s7a'); });
  t(250, function(){
    go('s7b');
    var targets = [247, 4.2, 94, 12];
    var suffixes = ['','hrs','%',''];
    targets.forEach(function(tgt, i){
      var start = Date.now(), dur = 2200;
      var el = document.getElementById('sn' + i);
      var iv = setInterval(function(){
        var p = Math.min(1, (Date.now()-start)/dur);
        var ease = 1 - Math.pow(1-p, 3);
        var v = tgt * ease;
        var disp = tgt % 1 !== 0 ? v.toFixed(1) : Math.round(v);
        el.innerHTML = disp + (suffixes[i] ? '<span style="font-size:.42em">' + suffixes[i] + '</span>' : '');
        if(p >= 1) clearInterval(iv);
      }, 28);
    });
  });
};

window.enter_s8 = function(){
  t(100, function(){ go('s8a'); });
  t(350, function(){ go('s8b'); });
  t(600, function(){ go('s8c'); });
  t(850, function(){ go('s8d'); });
};

// ── Start ──
activateScene(0);
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// /demo3  — Advanced guided product tour with cursor, zoom, spotlight & voice
// ─────────────────────────────────────────────────────────────────────────────
app.get('/demo3', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EX3 SmartRecruiters — Platform Tour</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:#050505;color:#fff;font-family:\'Sora\',sans-serif}

/* ── Layout ── */
#layout{display:flex;height:100vh;overflow:hidden}

/* ── Chapter nav ── */
#chnav{width:220px;flex-shrink:0;background:#050505;border-right:1px solid #0d0d0d;display:flex;flex-direction:column;padding:24px 0;z-index:100;position:relative}
#chnav-logo{padding:0 22px 28px;font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#22c55e}
#chnav-logo span{color:#333}
.chap{padding:11px 22px;cursor:pointer;transition:background .2s;border-left:2px solid transparent}
.chap:hover{background:rgba(255,255,255,.02)}
.chap.active{border-left-color:#22c55e;background:rgba(34,197,94,.04)}
.chap-num{font-size:8px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#1c1c1c;margin-bottom:3px;transition:color .3s}
.chap.active .chap-num{color:#166534}
.chap-title{font-size:12px;font-weight:700;color:#1c1c1c;transition:color .3s;line-height:1.3}
.chap.active .chap-title{color:#e5e5e5}
.chap-steps{display:flex;gap:4px;margin-top:7px}
.cs{width:14px;height:2px;border-radius:2px;background:#111;transition:all .3s}
.cs.done{background:#166534}
.cs.cur{background:#22c55e;width:22px}

#chnav-bottom{margin-top:auto;padding:0 22px 8px}
.vol-btn{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;background:transparent;border:1px solid #111;color:#2a2a2a;font-family:inherit;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:all .2s;width:100%}
.vol-btn:hover{border-color:#1a1a1a;color:#333}
.vol-btn.muted{border-color:#1f2d1f;color:#22c55e}

/* ── Main area ── */
#main{flex:1;min-width:0;display:flex;flex-direction:column;background:#050505;position:relative}

/* ── Browser chrome ── */
#browser-outer{flex:1;min-height:0;padding:14px 14px 0;display:flex;flex-direction:column}
#browser{flex:1;min-height:0;border-radius:10px 10px 0 0;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.05);position:relative}
#bbar{height:36px;flex-shrink:0;background:#111;display:flex;align-items:center;padding:0 14px;gap:10px;border-bottom:1px solid #0a0a0a}
.bdd{width:9px;height:9px;border-radius:50%}
#burl{flex:1;margin:0 12px;height:20px;background:#0a0a0a;border-radius:5px;display:flex;align-items:center;padding:0 10px;font-size:10px;color:#2a2a2a;font-weight:600;letter-spacing:.02em;overflow:hidden;white-space:nowrap}
#burl-ico{width:8px;height:8px;border-radius:50%;background:#166534;margin-right:6px;flex-shrink:0}

/* ── Frame area ── */
#frame-area{flex:1;min-height:0;position:relative;overflow:hidden;background:#fff}
#live-frame{position:absolute;inset:0;width:100%;height:100%;border:none;transition:transform .9s cubic-bezier(.4,0,.2,1)}

/* ── Spotlight overlay (above iframe, below cursor) ── */
#spotlight{position:absolute;inset:0;pointer-events:none;z-index:20;opacity:0;transition:opacity .6s ease}

/* ── Fake cursor ── */
#fc-wrap{position:absolute;inset:0;pointer-events:none;z-index:30;overflow:hidden}
#fc{position:absolute;width:0;height:0;transition:left .7s cubic-bezier(.4,0,.2,1),top .7s cubic-bezier(.4,0,.2,1)}
#fc-arrow{position:absolute;top:0;left:0;pointer-events:none}
#fc-ring{position:absolute;width:32px;height:32px;border-radius:50%;border:1.5px solid rgba(34,197,94,.5);top:-16px;left:-16px;pointer-events:none;transform:scale(1);transition:transform .2s ease,opacity .2s ease}
#fc.click-anim #fc-ring{transform:scale(1.8);opacity:0}
#fc-click-ripple{position:absolute;width:20px;height:20px;border-radius:50%;background:rgba(34,197,94,.25);top:-10px;left:-10px;pointer-events:none;transform:scale(0);opacity:0}
#fc.click-anim #fc-click-ripple{animation:ripple-out .4s ease-out forwards}
@keyframes ripple-out{0%{transform:scale(0);opacity:.8}100%{transform:scale(2.5);opacity:0}}

/* ── Card scenes (fullscreen takeovers) ── */
#card-overlay{position:fixed;inset:0;background:#050505;z-index:500;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .5s ease}
#card-overlay.active{opacity:1;pointer-events:all}
#card-inner{text-align:center;position:relative}
.card-chap{font-size:9px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22c55e;margin-bottom:20px;opacity:0;transform:translateY(12px);transition:all .5s .1s ease}
.card-hl{font-size:clamp(40px,7vw,96px);font-weight:900;letter-spacing:-.06em;line-height:1.04;opacity:0;transform:translateY(22px);transition:all .6s .25s ease}
.card-hl em{color:#22c55e;font-style:normal}
.card-sub{font-size:clamp(13px,1.5vw,18px);color:#2a2a2a;line-height:1.8;max-width:480px;margin:20px auto 0;opacity:0;transition:all .5s .55s ease}
#card-overlay.go .card-chap,.card-overlay.go .card-hl,.card-overlay.go .card-sub{opacity:1;transform:translateY(0)}
#card-overlay.go .card-hl{opacity:1;transform:translateY(0)}
#card-overlay.go .card-chap{opacity:1;transform:translateY(0)}
#card-overlay.go .card-sub{opacity:1}
.card-glow{position:absolute;width:600px;height:600px;background:radial-gradient(circle,rgba(34,197,94,.06) 0%,transparent 65%);pointer-events:none;animation:gp 5s ease-in-out infinite}
@keyframes gp{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.1)}}
#card-progress{position:absolute;bottom:0;left:0;height:2px;background:linear-gradient(90deg,#16a34a,#22c55e);transition:width 0s linear}

/* ── Narration bar ── */
#nar{position:absolute;bottom:0;left:220px;right:0;z-index:400;pointer-events:none}
#nar-inner{background:linear-gradient(to top,rgba(5,5,5,.98) 0%,rgba(5,5,5,.85) 60%,transparent 100%);padding:18px 24px 16px;display:flex;flex-direction:column;gap:8px}
#nar-words{font-size:13px;line-height:1.75;color:#3a3a3a;min-height:46px;max-width:860px}
#nar-words .w{transition:color .15s,opacity .15s}
#nar-words .w.lit{color:#c4c4c4}
#nar-words .w.done{color:#444}
#nar-controls{display:flex;align-items:center;gap:12px;pointer-events:all}
#nar-pb{flex:1;height:2px;background:#111;border-radius:2px;overflow:hidden}
#nar-pb-fill{height:100%;background:linear-gradient(90deg,#166534,#22c55e);width:0;transition:width .15s linear;border-radius:2px}
.nar-btn{background:transparent;border:1px solid #151515;color:#2a2a2a;font-family:inherit;font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:6px 14px;border-radius:6px;cursor:pointer;transition:all .2s}
.nar-btn:hover{border-color:#222;color:#444}
.nar-btn.next-ready{border-color:#22c55e;color:#22c55e;animation:pulse-next 1.8s ease-in-out infinite}
@keyframes pulse-next{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.4)}50%{box-shadow:0 0 0 6px rgba(34,197,94,0)}}
#bars{display:flex;align-items:center;gap:2px;height:16px;flex-shrink:0}
#bars .b{width:2px;border-radius:2px;background:#1a1a1a;height:100%;transition:height .2s}
#bars.speaking .b:nth-child(1){animation:bh 1.1s .0s ease-in-out infinite}
#bars.speaking .b:nth-child(2){animation:bh 1.1s .15s ease-in-out infinite}
#bars.speaking .b:nth-child(3){animation:bh 1.1s .3s ease-in-out infinite}
#bars.speaking .b:nth-child(4){animation:bh 1.1s .45s ease-in-out infinite}
@keyframes bh{0%,100%{height:3px;background:#1a1a1a}50%{height:14px;background:#22c55e}}

/* ── Start screen ── */
#start-screen{position:fixed;inset:0;z-index:999;background:#050505;display:flex;align-items:center;justify-content:center;flex-direction:column;cursor:pointer;transition:opacity .6s ease;overflow:hidden}
#start-screen.fade{opacity:0;pointer-events:none}
#start-screen::before{content:\'\';position:absolute;width:700px;height:700px;background:radial-gradient(circle,rgba(34,197,94,.07) 0%,transparent 65%);animation:ss-glow 5s ease-in-out infinite;pointer-events:none}
@keyframes ss-glow{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.2);opacity:1}}
.ss-eye{font-size:10px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22c55e;margin-bottom:36px;position:relative}
.ss-h{font-size:clamp(38px,5.5vw,72px);font-weight:900;letter-spacing:-.05em;text-align:center;line-height:1.04;max-width:700px;position:relative}
.ss-h em{color:#22c55e;font-style:normal}
.ss-sub{margin-top:20px;font-size:14px;color:#444;text-align:center;max-width:440px;line-height:1.8;position:relative}
.ss-cta{margin-top:44px;padding:16px 52px;background:#22c55e;color:#000;font-family:inherit;font-size:13px;font-weight:900;letter-spacing:.01em;border:none;border-radius:12px;cursor:pointer;position:relative;transition:transform .15s,opacity .15s}
.ss-cta:hover{transform:translateY(-2px);opacity:.92}
.ss-note{margin-top:14px;font-size:10px;color:#1c1c1c;position:relative}

/* ── Flash ── */
#flash{position:fixed;inset:0;background:#000;z-index:1000;opacity:0;pointer-events:none;transition:opacity .25s ease}
#flash.on{opacity:1}

/* ── WhatsApp panel (replaces iframe) ── */
#wa-panel{position:absolute;inset:0;background:#e5ddd5;display:none;flex-direction:column;z-index:10}
#wa-panel.show{display:flex}
.wa-hdr{background:#075e54;padding:13px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.wa-av{width:38px;height:38px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#fff;flex-shrink:0}
.wa-nm{font-size:14px;font-weight:700;color:#fff}
.wa-st{font-size:10px;color:rgba(255,255,255,.65)}
.wa-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;font-family:-apple-system,Helvetica,sans-serif}
.wa-b{padding:8px 11px 20px;border-radius:8px;font-size:13px;line-height:1.55;position:relative;opacity:0;transform:translateY(6px);transition:opacity .3s,transform .3s;max-width:82%;word-break:break-word;white-space:pre-line}
.wa-b.show{opacity:1;transform:translateY(0)}
.wa-b.me{background:#dcf8c6;align-self:flex-end;border-top-right-radius:0;color:#111}
.wa-b.them{background:#fff;align-self:flex-start;border-top-left-radius:0;color:#111}
.wa-ts{position:absolute;bottom:4px;right:9px;font-size:9px;color:#999;font-family:-apple-system,Helvetica,sans-serif}
.wa-typ{display:none;background:#fff;border-radius:8px;border-top-left-radius:0;padding:9px 13px;width:fit-content;align-items:center;gap:4px;margin:0 12px 6px}
.wa-typ.show{display:flex}
.wa-td{width:6px;height:6px;border-radius:50%;background:#bbb;animation:wab .9s infinite ease-in-out}
.wa-td:nth-child(2){animation-delay:.2s}.wa-td:nth-child(3){animation-delay:.4s}
@keyframes wab{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
/* ── Recording scene ── */
#wa-rec-scene{position:absolute;inset:0;background:#0a0a0a;display:none;flex-direction:column;align-items:center;justify-content:center;z-index:20;transition:opacity .5s ease}
#wa-rec-scene.show{display:flex}
.rec-time{font-size:56px;font-weight:900;color:#fff;letter-spacing:-.04em;font-family:\'Sora\',sans-serif}
.rec-info{font-size:12px;color:#444;margin-top:6px;letter-spacing:.04em}
.rec-row{display:flex;align-items:center;gap:14px;margin-top:28px}
.rec-dot{width:11px;height:11px;border-radius:50%;background:#ef4444;animation:rdot 1s ease-in-out infinite}
@keyframes rdot{0%,100%{opacity:1}50%{opacity:.25}}
.rec-wave{display:flex;align-items:center;gap:3px}
.rec-wbar{width:3px;background:#22c55e;border-radius:2px;animation:rwh .85s ease-in-out infinite}
.rec-wbar:nth-child(1){height:5px;animation-delay:.0s}
.rec-wbar:nth-child(2){height:14px;animation-delay:.1s}
.rec-wbar:nth-child(3){height:8px;animation-delay:.2s}
.rec-wbar:nth-child(4){height:20px;animation-delay:.3s}
.rec-wbar:nth-child(5){height:10px;animation-delay:.4s}
.rec-wbar:nth-child(6){height:16px;animation-delay:.5s}
.rec-wbar:nth-child(7){height:6px;animation-delay:.6s}
.rec-wbar:nth-child(8){height:18px;animation-delay:.7s}
@keyframes rwh{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
.rec-label{font-size:10px;color:#ef4444;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-top:20px}
.wa-vnote{display:flex;align-items:center;gap:8px;min-width:160px}
.wa-vplay{width:28px;height:28px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;flex-shrink:0}
.wa-wf{flex:1;display:flex;align-items:center;gap:2px;height:18px}
.wa-wb{border-radius:2px;background:rgba(0,0,0,.2);width:3px}
.wa-vd{font-size:10px;color:#999;margin-left:2px;font-family:-apple-system,Helvetica,sans-serif}

/* ── Analytics panel (replaces iframe) ── */
#an-panel{position:absolute;inset:0;background:#080808;display:none;flex-direction:column;z-index:10;padding:28px}
#an-panel.show{display:flex}
.an-hd{font-size:10px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#22c55e;margin-bottom:20px}
.an-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.an-kpi{background:#0d0d0d;border:1px solid #111;border-radius:10px;padding:20px 18px}
.an-kn{font-size:clamp(32px,4vw,52px);font-weight:900;letter-spacing:-.04em;color:#22c55e;font-variant-numeric:tabular-nums}
.an-kl{font-size:10px;color:#2a2a2a;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-top:6px}
.an-chart-row{display:flex;gap:12px;flex:1;min-height:0}
.an-bar-chart{flex:1;background:#0d0d0d;border:1px solid #111;border-radius:10px;padding:20px;display:flex;flex-direction:column}
.an-chart-title{font-size:9px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:#2a2a2a;margin-bottom:16px}
.an-bars{flex:1;display:flex;align-items:flex-end;gap:8px}
.an-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px}
.an-bar-fill{width:100%;border-radius:4px 4px 0 0;background:linear-gradient(to top,#166534,#22c55e);transition:height 1.2s cubic-bezier(.4,0,.2,1);height:0}
.an-bar-lbl{font-size:8px;color:#222;font-weight:700}
.an-top{width:280px;background:#0d0d0d;border:1px solid #111;border-radius:10px;padding:20px}
.an-top-title{font-size:9px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:#2a2a2a;margin-bottom:14px}
.an-q-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #0d0d0d;opacity:0;transform:translateX(-8px);transition:all .4s ease}
.an-q-row.show{opacity:1;transform:translateX(0)}
.an-q-txt{flex:1;font-size:11px;color:#333;line-height:1.4}
.an-q-pct{font-size:11px;font-weight:800;color:#22c55e;flex-shrink:0}
</style>
</head>
<body>

<div id="start-screen" onclick="beginDemo()">
  <div class="ss-eye">EX3 SmartRecruiters</div>
  <h1 class="ss-h">The platform your team<br><em>actually uses.</em></h1>
  <p class="ss-sub">Training guide · AI assistant · WhatsApp bot · Consultant portal · Analytics</p>
  <button class="ss-cta">Start Tour</button>
  <div class="ss-note">Voice narration &middot; 4 chapters &middot; ~3 minutes</div>
</div>

<div id="flash"></div>

<!-- ── Card overlay for chapter transitions ── -->
<div id="card-overlay">
  <div class="card-glow" style="top:-80px;left:-80px"></div>
  <div class="card-glow" style="bottom:-80px;right:-80px;animation-delay:2.5s"></div>
  <div id="card-inner">
    <div class="card-chap" id="card-chap"></div>
    <div class="card-hl" id="card-hl"></div>
    <div class="card-sub" id="card-sub"></div>
  </div>
  <div id="card-progress"></div>
</div>

<div id="layout">

  <!-- ── Chapter nav ── -->
  <div id="chnav">
    <div id="chnav-logo">EX3 <span>/ SR Guide</span></div>
    <div id="chap-list"></div>
    <div id="chnav-bottom">
      <button class="vol-btn" id="vol-btn" onclick="toggleMute()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
        <span id="vol-txt">Voice On</span>
      </button>
    </div>
  </div>

  <!-- ── Main ── -->
  <div id="main">
    <div id="browser-outer">
      <div id="browser">
        <div id="bbar">
          <div class="bdd" style="background:#ff5f56"></div>
          <div class="bdd" style="background:#ffbd2e"></div>
          <div class="bdd" style="background:#27c93f"></div>
          <div id="burl"><div id="burl-ico"></div><span id="burl-txt">ex3-guide.railway.app</span></div>
        </div>
        <div id="frame-area">
          <iframe id="live-frame" src="/"></iframe>

          <!-- WhatsApp panel -->
          <div id="wa-panel">
            <div class="wa-hdr">
              <div class="wa-av">EX3</div>
              <div><div class="wa-nm">EX3 AI Assistant</div><div class="wa-st">WhatsApp · usually replies instantly</div></div>
            </div>
            <div class="wa-msgs" id="wa-msgs"></div>
            <div class="wa-typ" id="wa-typ"><div class="wa-td"></div><div class="wa-td"></div><div class="wa-td"></div></div>
            <div id="wa-rec-scene">
              <div class="rec-time">06:07</div>
              <div class="rec-info">En route to client site</div>
              <div class="rec-row">
                <div class="rec-dot"></div>
                <div class="rec-wave">
                  <div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div>
                  <div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div>
                </div>
              </div>
              <div class="rec-label">Recording</div>
            </div>
          </div>

          <!-- Analytics panel -->
          <div id="an-panel">
            <div class="an-hd">Analytics &amp; Insights</div>
            <div class="an-kpis">
              <div class="an-kpi"><div class="an-kn" id="an-k1">0</div><div class="an-kl">AI queries this week</div></div>
              <div class="an-kpi"><div class="an-kn" id="an-k2">0<span style="font-size:.45em">hrs</span></div><div class="an-kl">saved per consultant</div></div>
              <div class="an-kpi"><div class="an-kn" id="an-k3">0<span style="font-size:.45em">%</span></div><div class="an-kl">questions answered</div></div>
              <div class="an-kpi"><div class="an-kn" id="an-k4">0</div><div class="an-kl">active engagements</div></div>
            </div>
            <div class="an-chart-row">
              <div class="an-bar-chart">
                <div class="an-chart-title">Queries by day</div>
                <div class="an-bars" id="an-bars"></div>
              </div>
              <div class="an-top">
                <div class="an-top-title">Top questions</div>
                <div id="an-qs"></div>
              </div>
            </div>
          </div>

          <!-- Spotlight overlay -->
          <div id="spotlight"></div>

          <!-- Fake cursor -->
          <div id="fc-wrap">
            <div id="fc">
              <div id="fc-ring"></div>
              <div id="fc-click-ripple"></div>
              <svg id="fc-arrow" width="22" height="22" viewBox="0 0 22 22" fill="none">
                <path d="M4 2L18 10.5L11.5 12L8.5 19L4 2Z" fill="white" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>
              </svg>
            </div>
          </div>

        </div><!-- /frame-area -->
      </div><!-- /browser -->
    </div><!-- /browser-outer -->

    <!-- ── Narration bar ── -->
    <div id="nar">
      <div id="nar-inner">
        <div id="nar-words"></div>
        <div id="nar-controls">
          <div id="bars"><div class="b"></div><div class="b"></div><div class="b"></div><div class="b"></div></div>
          <div id="nar-pb"><div id="nar-pb-fill"></div></div>
          <button class="nar-btn" onclick="prevStep()">&#8592; Prev</button>
          <button class="nar-btn" onclick="replayAudio()">&#8635; Replay</button>
          <button class="nar-btn" id="next-btn" onclick="nextStep()">Next &#8594;</button>
        </div>
      </div>
    </div>

  </div><!-- /main -->
</div><!-- /layout -->

<script>
// ═══════════════════════════════════════════════════════════════════
// STEPS DATA
// ═══════════════════════════════════════════════════════════════════
var CHAPTERS = [
  {label:\'Chapter I\',   title:\'The Platform\',    steps:[0,1,2,3]},
  {label:\'Chapter II\',  title:\'AI Assistant\',    steps:[4,5,6,7,8]},
  {label:\'Chapter III\', title:\'On WhatsApp\',     steps:[9,10,11]},
  {label:\'Chapter IV\',  title:\'SOW & Results\',   steps:[12,13,14,15,16,17]}
];

var STEPS = [
  // ── 0: CARD – intro ──
  {
    type:\'card\',
    chap:\'EX3 SmartRecruiters\',
    hl:\'The platform<br>your team <em>actually uses.</em>\',
    sub:\'Training guide · AI assistant · WhatsApp bot · Consultant portal\',
    dur:4200
  },
  // ── 1: Four roles cycling ──
  {
    url:\'/\',
    auto:[
      {d:300,  a:{action:\'setRole\',role:\'rec\'}},
      {d:3000, a:{action:\'setRole\',role:\'hm\'}},
      {d:5800, a:{action:\'setRole\',role:\'cand\'}},
      {d:8400, a:{action:\'setRole\',role:\'adm\'}}
    ],
    voice:\'Every person on a SmartRecruiters project sees a completely different platform. Recruiter, hiring manager, candidate, admin — each with their own tasks, their own view, nothing extra. Watch it switch between all four.\',
    minHold:11000
  },
  // ── 2: Recruiter view ──
  {
    url:\'/\',
    role:\'rec\',
    voice:\"Take the recruiter. Every task they'll ever perform is here — post jobs, manage the pipeline, schedule interviews, send offers. Searchable, step by step, before the client even needs to ask.\",
    cursor:[
      {x:7,y:38,d:1200},
      {x:7,y:46,d:2600},
      {x:7,y:54,d:4000},
      {x:7,y:62,d:5400},
      {x:30,y:52,d:7000}
    ],
    minHold:1000
  },
  // ── 3: Schedule interview steps ──
  {
    url:\'/\',
    role:\'rec\',
    voice:\'Click any task and it opens to individual steps. Who does what, in what sequence, exactly how to do it. Every interview, every offer, every system action — documented before the client goes live.\',
    auto:[
      {d:800, a:{action:\'openTaskDetail\',taskId:\'sched-interview\'}},
      {d:2500,a:{action:\'expandTaskSteps\',taskId:\'sched-interview\',indices:[0,1,2]}}
    ],
    cursor:[
      {x:7, y:47,d:600, click:true},
      {x:35,y:40,d:2000},
      {x:35,y:52,d:4000},
      {x:35,y:62,d:6500}
    ],
    minHold:1000
  },
  // ── 4: CARD – AI ──
  {
    type:\'card\',
    chap:\'Chapter II\',
    hl:\"Stuck?<br><em>There's an answer.</em>\",
    sub:\'Every step. Every question. Answered instantly.\',
    dur:3800
  },
  // ── 5: Stuck + AI (manual) ──
  {
    url:\'/\',
    role:\'rec\',
    voice:\"Every step has a help button. When someone gets stuck — mid-interview, mid-approval, mid-offer — they tap it. The AI has full context. It knows the step, the task, the role. Watch it answer. Click next when ready.\",
    auto:[
      {d:800, a:{action:\'openTaskDetail\',taskId:\'sched-interview\'}},
      {d:2000,a:{action:\'openStuck\',taskId:\'sched-interview\',stepIdx:1}},
      {d:3500,a:{action:\'askAIForStuck\',taskId:\'sched-interview\',stepIdx:1}}
    ],
    cursor:[
      {x:7, y:47,d:600, click:true},
      {x:50,y:52,d:1800},
      {x:55,y:62,d:3200,click:true},
      {x:60,y:72,d:6000}
    ],
    manual:true,
    manualHint:18000
  },
  // ── 6: Follow-up – context memory (manual) ──
  {
    url:\'/\',
    voice:\'Now the follow-up. She asks a second question — no re-explaining, no starting over. The AI carries the full conversation. That is context memory. Click next when the answer lands.\',
    auto:[
      {d:800,a:{action:\'typeAndAsk\',query:\'What permission level do I need to schedule on behalf of someone?\'}}
    ],
    manual:true,
    manualHint:22000
  },
  // ── 7: Try it — ask anything (manual) ──
  {
    url:\'/\',
    voice:\'You can ask it anything. Not just stuck steps — any SmartRecruiters question, any point in the project, any time of day. Go ahead, give it a go. Click next when you are done.\',
    auto:[{d:600,a:{action:\'openAI\'}}],
    manual:true,
    manualHint:5000
  },
  // ── 8: Implementation runbook ──
  {
    url:\'/\',
    voice:\'After the call she builds the implementation runbook. Picks the processes the client needs. One click and the full delivery sequence generates — post job, schedule interview, workflow automation, assessments. The whole plan, structured and ready.\',
    auto:[
      {d:700, a:{action:\'closeAI\'}},
      {d:1400,a:{action:\'openUnifiedFlow\'}},
      {d:5000,a:{action:\'setFlowProcesses\',ids:[\'post-job\',\'sched-interview\',\'add-workflow\',\'add-assessment\'],buildNow:true}}
    ],
    minHold:13000
  },
  // ── 9: CARD – WhatsApp ──
  {
    type:\'card\',
    chap:\'Chapter III\',
    hl:\'Same AI.<br><em>On WhatsApp.</em>\',
    sub:\'No app. No login. Around the clock.\',
    voice:\'No app. No login. Just WhatsApp.\',
    postVoice:\'Quick one. I\\\'m five minutes from the client site. Their hiring manager just messaged — the Send Offer button isn\\\'t showing up. I need to know what\\\'s blocking it before I walk in. Thanks.\',
    postVoiceStressed:true,
    dur:3500
  },
  // ── 10: WhatsApp ──
  {
    waChat:true,
    recordingScene:true,
    voice:\'Six oh seven in the morning. Sarah is in the back of a cab, five minutes from the client site. The hiring manager has messaged — the Send Offer button is gone. She records a voice note on WhatsApp. The answer lands before she gets out of the car. No app, no login, around the clock.\',
    waMessages:[
      {from:\'me\',voice:true,ts:\'06:07\',d:6000},
      {from:\'them\',text:\"The Send Offer button appears when three conditions are met:\\n\\n1\\u20e3 Candidate is in the *Offer* stage\\n2\\u20e3 Job has an active offer template\\n3\\u20e3 You have the *Offer Manager* permission\\n\\nWhich would you like me to check first?\",ts:\'06:07\',d:13000},
      {from:\'me\',text:\'Probably permissions — how do I check?\',ts:\'06:08\',d:19500},
      {from:\'them\',text:\"Go to *Admin > User Management*, find your name, and check your assigned role.\\n\\nYou need the *Offer Manager* role or a custom role with *Create Offer* permission.\\n\\nYour SR admin can add it in about two minutes.\",ts:\'06:08\',d:24500}
    ],
    minHold:12000
  },
  // ── 11: Consultant portal ──
  {
    url:\'/consultant\',
    voice:\"For the consultants running the engagement, there's a dedicated portal. EXcelerate methodology — four phases, each fully structured. Examine, Adopt, Validate, Launch. Checklists, deliverables, timelines. Everything the delivery team needs.\",
    auto:[
      {d:1200,a:{action:\'openPhase\',index:0}},
      {d:3000,a:{action:\'openPhase\',index:1}},
      {d:4800,a:{action:\'openPhase\',index:2}},
      {d:6600,a:{action:\'openPhase\',index:3}}
    ],
    cursor:[
      {x:20,y:35,d:1000},
      {x:20,y:48,d:2800},
      {x:20,y:62,d:5500}
    ],
    minHold:2000
  },
  // ── 12: CARD – SOW ──
  {
    type:\'card\',
    chap:\'Chapter IV\',
    hl:\'A complete SOW.<br><em>In 45 seconds.</em>\',
    sub:\'The client has asked for a formal Statement of Work before they will sign.\',
    dur:4000
  },
  // ── 13: SOW Builder ──
  {
    url:\'/consultant/sow-builder\',
    voice:\'She opens the SOW builder. Nineteen questions — org size, geography, integrations, approval workflows, compliance, training, go-live date. Every one answered. At the end, a complete Statement of Work structured around every EXcelerate phase.\',
    auto:[{d:500,a:{action:\'demoWalkSOW\'}}],
    minHold:12000
  },
  // ── 14: AI SOW Rewrite ──
  {
    url:\'/consultant/sow-builder\',
    voice:\'One click. The AI rewrites the whole thing into polished, client-ready consulting language — streamed live, word by word. Boardroom-ready. Done before the afternoon stand-up.\',
    auto:[{d:1000,a:{action:\'triggerAIRewrite\'}}],
    minHold:7000
  },
  // ── 15: Export & Email ──
  {
    url:\'/consultant/sow-builder\',
    voice:\'She exports it as a structured Word document — proper headings, phase tables, RACI matrices. Or sends it straight to the client by email. From generation to delivery, without leaving the page.\',
    auto:[{d:800,a:{action:\'scrollToExport\'}}],
    minHold:5000
  },
  // ── 16: Analytics ──
  {
    analytics:true,
    voice:\'Three weeks in. The data tells the story. Two hundred and forty seven AI queries this week. Four point two hours saved per consultant. Twelve active engagements running clean. The platform does not just support the work — it measures it.\',
    minHold:3000
  },
  // ── 17: CARD – CTA ──
  {
    type:\'card\',
    chap:\'That\\\'s EX3\',
    hl:\'Everything your team needs.<br><em>On day one.</em>\',
    sub:\'Training guide · AI assistant · WhatsApp bot · SOW builder · Analytics\',
    cta:true,
    dur:0
  }
];

// WhatsApp waveform heights
var WH = [8,14,6,18,10,22,7,16,12,20,8,14,6,18,10,22,7,16,12,20,8,14,6,18,10];

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
var cur = 0;
var stepToken = 0;
var muted = false;
var autoTimers = [];
var currentAudio = null;
var waTimers = [];
var fc = document.getElementById(\'fc\');
var fcVisible = false;
var cursorX = 50, cursorY = 50;
var cursorMoveRaf = null;

// ═══════════════════════════════════════════════════════════════════
// CHAPTER NAV
// ═══════════════════════════════════════════════════════════════════
function renderChapNav(){
  var html = \'\';
  CHAPTERS.forEach(function(ch, ci){
    var isActive = ch.steps.indexOf(cur) !== -1;
    html += \'<div class="chap\' + (isActive ? \' active\' : \'\') + \'"\'
          + \' onclick="jumpToChap(\' + ci + \')">\';
    html += \'<div class="chap-num">\'+ ch.label +\'</div>\';
    html += \'<div class="chap-title">\'+ ch.title +\'</div>\';
    html += \'<div class="chap-steps">\';
    ch.steps.forEach(function(si){
      var cls = si < cur ? \'cs done\' : si === cur ? \'cs cur\' : \'cs\';
      html += \'<div class="\' + cls + \'"></div>\';
    });
    html += \'</div></div>\';
  });
  document.getElementById(\'chap-list\').innerHTML = html;
}

function jumpToChap(ci){
  var firstStep = CHAPTERS[ci].steps[0];
  goToStep(firstStep);
}

// ═══════════════════════════════════════════════════════════════════
// CURSOR
// ═══════════════════════════════════════════════════════════════════
function showCursor(){
  if(!fcVisible){ fc.style.opacity=\'1\'; fcVisible=true; }
}
function hideCursor(){
  fc.style.opacity=\'0\'; fcVisible=false;
}
function setCursorPos(x,y){
  fc.style.left = x + \'%\';
  fc.style.top  = y + \'%\';
  cursorX = x; cursorY = y;
}
function easeInOut(t){ return t<.5 ? 2*t*t : -1+(4-2*t)*t; }

function animateCursorTo(tx,ty,dur,onDone,token){
  if(cursorMoveRaf){ cancelAnimationFrame(cursorMoveRaf); cursorMoveRaf=null; }
  var fx=cursorX, fy=cursorY, start=null;
  // Disable CSS transition during JS animation
  fc.style.transition=\'none\';
  function tick(ts){
    if(stepToken!==token) return;
    if(!start) start=ts;
    var p=Math.min((ts-start)/dur,1);
    var e=easeInOut(p);
    setCursorPos(fx+(tx-fx)*e, fy+(ty-fy)*e);
    if(p<1){ cursorMoveRaf=requestAnimationFrame(tick); }
    else {
      if(onDone) onDone();
    }
  }
  cursorMoveRaf=requestAnimationFrame(tick);
}

function clickCursor(){
  fc.classList.remove(\'click-anim\');
  void fc.offsetWidth;
  fc.classList.add(\'click-anim\');
  setTimeout(function(){ fc.classList.remove(\'click-anim\'); },420);
}

function runCursorPath(path, token){
  if(!path||!path.length) return;
  showCursor();
  var prev = {x:50,y:50};
  path.forEach(function(pt){
    var delay = pt.d || 0;
    var dur = Math.max(400, delay - (prev.d||0) - 50);
    autoTimers.push(setTimeout(function(){
      if(stepToken!==token) return;
      animateCursorTo(pt.x, pt.y, Math.max(350, dur), function(){
        if(pt.click && stepToken===token) clickCursor();
      }, token);
    }, delay));
    prev = pt;
  });
}

// ═══════════════════════════════════════════════════════════════════
// ZOOM
// ═══════════════════════════════════════════════════════════════════
var lf = document.getElementById(\'live-frame\');
function zoomFrame(x,y,scale,delayMs,token){
  autoTimers.push(setTimeout(function(){
    if(stepToken!==token) return;
    lf.style.transition=\'transform .85s cubic-bezier(.4,0,.2,1)\';
    lf.style.transformOrigin = x+\'% \'+y+\'%\';
    lf.style.transform=\'scale(\'+scale+\')\';
  },delayMs||0));
}
function resetZoom(token){
  autoTimers.push(setTimeout(function(){
    if(stepToken!==token) return;
    lf.style.transition=\'transform .7s cubic-bezier(.4,0,.2,1)\';
    lf.style.transform=\'scale(1)\';
    lf.style.transformOrigin=\'50% 50%\';
  },0));
}

// ═══════════════════════════════════════════════════════════════════
// SPOTLIGHT
// ═══════════════════════════════════════════════════════════════════
var spl = document.getElementById(\'spotlight\');
function setSpotlight(x,y,r,token,delay){
  autoTimers.push(setTimeout(function(){
    if(stepToken!==token) return;
    spl.style.background=\'radial-gradient(circle \'+r+\'px at \'+x+\'% \'+y+\'%, transparent \'+Math.max(0,r-20)+\'px, rgba(0,0,0,.6) \'+r+\'px)\';
    spl.style.opacity=\'1\';
  },delay||0));
}
function clearSpotlight(){
  spl.style.opacity=\'0\';
}

// ═══════════════════════════════════════════════════════════════════
// NARRATION WORDS
// ═══════════════════════════════════════════════════════════════════
function renderWords(text, charPos){
  var words = text.split(\' \');
  var html=\'\', pos=0;
  words.forEach(function(w,i){
    var cls = pos+w.length < charPos ? \'w done\' : pos <= charPos ? \'w lit\' : \'w\';
    html += \'<span class="\'+cls+\'">\'+w+\'</span> \';
    pos += w.length+1;
  });
  document.getElementById(\'nar-words\').innerHTML=html;
}

// ═══════════════════════════════════════════════════════════════════
// TTS / SPEAK  (Web Audio API — bypasses HTMLAudioElement quirks)
// ═══════════════════════════════════════════════════════════════════
var _actx=null;
var _sourceNode=null;
var _wordTimer=null;

function _getActx(){
  if(!_actx) _actx=new(window.AudioContext||window.webkitAudioContext)();
  return _actx;
}

function stopAudio(){
  if(_sourceNode){ try{ _sourceNode.stop(); }catch(e){} _sourceNode=null; }
  if(_wordTimer){ clearInterval(_wordTimer); _wordTimer=null; }
  currentAudio=null;
  document.getElementById(\'bars\').classList.remove(\'speaking\');
  document.getElementById(\'nar-pb-fill\').style.width=\'0\';
}

function speak(text, onDone, token){
  stopAudio();
  renderWords(text,-1);
  document.getElementById(\'nar-pb-fill\').style.width=\'0\';

  if(muted){
    var est=Math.max(6000,text.split(\' \').length*420);
    autoTimers.push(setTimeout(function(){
      if(token!==stepToken) return;
      renderWords(text,text.length+1);
      if(onDone) onDone();
    },est));
    return;
  }

  document.getElementById(\'bars\').classList.add(\'speaking\');
  var completed=false;

  function finish(){
    if(completed) return;
    completed=true;
    stopAudio();
    renderWords(text,text.length+1);
    document.getElementById(\'nar-pb-fill\').style.width=\'100%\';
    setTimeout(function(){ if(token===stepToken && onDone) onDone(); },300);
  }

  var ctx=_getActx();
  // Resume AudioContext if suspended (requires prior user gesture)
  (ctx.state===\'suspended\' ? ctx.resume() : Promise.resolve())
    .then(function(){
      return fetch(\'/api/tts?text=\'+encodeURIComponent(text));
    })
    .then(function(r){ return r.arrayBuffer(); })
    .then(function(buf){ return ctx.decodeAudioData(buf); })
    .then(function(decoded){
      if(token!==stepToken) return;
      var src=ctx.createBufferSource();
      src.buffer=decoded;
      src.connect(ctx.destination);
      _sourceNode=src;
      currentAudio={paused:false}; // sentinel for stopAudio check
      var startAt=ctx.currentTime;
      var dur=decoded.duration;
      _wordTimer=setInterval(function(){
        if(token!==stepToken){ clearInterval(_wordTimer); _wordTimer=null; return; }
        var pct=Math.min(1,(ctx.currentTime-startAt)/dur);
        renderWords(text,Math.floor(pct*text.length));
        document.getElementById(\'nar-pb-fill\').style.width=Math.min(99,Math.round(pct*100))+\'%\';
      },120);
      src.onended=function(){ if(token===stepToken) finish(); };
      src.start(0);
    })
    .catch(function(){ if(token===stepToken) finish(); });
}

// ═══════════════════════════════════════════════════════════════════
// postMessage to iframe
// ═══════════════════════════════════════════════════════════════════
function postToFrame(msg){
  try{ document.getElementById(\'live-frame\').contentWindow.postMessage(Object.assign({type:\'EX3_DEMO\'},msg),\'*\'); }catch(e){}
}

// ═══════════════════════════════════════════════════════════════════
// WHATSAPP
// ═══════════════════════════════════════════════════════════════════
function clearWaTimers(){ waTimers.forEach(clearTimeout); waTimers=[]; }
function showWa(messages, token){
  document.getElementById(\'wa-panel\').classList.add(\'show\');
  document.getElementById(\'live-frame\').style.display=\'none\';
  var msgs=document.getElementById(\'wa-msgs\');
  var typ=document.getElementById(\'wa-typ\');
  msgs.innerHTML=\'\'; typ.classList.remove(\'show\');

  messages.forEach(function(m){
    waTimers.push(setTimeout(function(){
      if(stepToken!==token) return;
      if(m.voice){
        var b=document.createElement(\'div\');
        b.className=\'wa-b me\';
        b.innerHTML=\'<div class="wa-vnote"><div class="wa-vplay">&#9654;</div><div class="wa-wf">\'+
          WH.map(function(h){ return \'<div class="wa-wb" style="height:\'+h+\'px"></div>\'; }).join(\'\') +
          \'</div><span class="wa-vd">0:12</span></div><div class="wa-ts">\'+m.ts+\'</div>\';
        msgs.appendChild(b);
        setTimeout(function(){ b.classList.add(\'show\'); },40);
        setTimeout(function(){ typ.classList.add(\'show\'); },600);
      } else {
        typ.classList.remove(\'show\');
        setTimeout(function(){
          var b=document.createElement(\'div\');
          b.className=\'wa-b \'+m.from;
          var html=m.text.replace(/\\\\*(.*?)\\\\*/g,\'<strong>$1</strong>\');
          b.innerHTML=html+\'<div class="wa-ts">\'+m.ts+\'</div>\';
          msgs.appendChild(b);
          msgs.scrollTop=msgs.scrollHeight;
          setTimeout(function(){ b.classList.add(\'show\'); },40);
        },200);
      }
    },m.d||0));
  });
}
function hideWa(){
  document.getElementById(\'wa-panel\').classList.remove(\'show\');
  document.getElementById(\'live-frame\').style.display=\'\';
}

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════════
var anInited=false;
function showAnalytics(token){
  document.getElementById(\'an-panel\').classList.add(\'show\');
  document.getElementById(\'live-frame\').style.display=\'none\';
  if(anInited) return;
  anInited=true;

  // KPI counters
  var targets=[{id:\'an-k1\',val:247,dec:0},{id:\'an-k2\',val:4.2,dec:1,suf:\'hrs\'},{id:\'an-k3\',val:94,dec:0,suf:\'%\'},{id:\'an-k4\',val:12,dec:0}];
  targets.forEach(function(t){
    var el=document.getElementById(t.id);
    var start=Date.now(),dur=1800;
    var iv=setInterval(function(){
      var p=Math.min(1,(Date.now()-start)/dur);
      var e=1-Math.pow(1-p,3);
      var v=t.val*e;
      var disp=t.dec>0?v.toFixed(t.dec):Math.round(v);
      el.innerHTML=disp+(t.suf?\'<span style="font-size:.45em">\'+t.suf+\'</span>\':
      \'\');
      if(p>=1) clearInterval(iv);
    },28);
  });

  // Bar chart
  var days=[\'Mon\',\'Tue\',\'Wed\',\'Thu\',\'Fri\',\'Sat\',\'Sun\'];
  var vals=[31,44,38,52,61,18,23];
  var max=Math.max.apply(null,vals);
  var bc=document.getElementById(\'an-bars\');
  bc.innerHTML=days.map(function(d,i){
    return \'<div class="an-bar-col"><div class="an-bar-fill" id="ab\'+i+\'"></div><div class="an-bar-lbl">\'+d+\'</div></div>\';
  }).join(\'\');
  setTimeout(function(){
    vals.forEach(function(v,i){
      var el=document.getElementById(\'ab\'+i);
      if(el) el.style.height=Math.round(v/max*100)+\'%\';
    });
  },200);

  // Top questions
  var qs=[
    [\'How do I move a candidate?\',\'18%\'],
    [\'How do I send an offer?\',\'14%\'],
    [\'How do I set up approval?\',\'11%\'],
    [\'Can candidates self-schedule?\',\'9%\'],
    [\'How do I post to LinkedIn?\',\'8%\']
  ];
  var qc=document.getElementById(\'an-qs\');
  qc.innerHTML=qs.map(function(q){
    return \'<div class="an-q-row"><div class="an-q-txt">\'+q[0]+\'</div><div class="an-q-pct">\'+q[1]+\'</div></div>\';
  }).join(\'\');
  setTimeout(function(){
    qc.querySelectorAll(\'.an-q-row\').forEach(function(r,i){
      setTimeout(function(){ r.classList.add(\'show\'); },i*180+400);
    });
  },500);
}
function hideAnalytics(){
  document.getElementById(\'an-panel\').classList.remove(\'show\');
  document.getElementById(\'live-frame\').style.display=\'\';
}

// ═══════════════════════════════════════════════════════════════════
// CARD OVERLAY
// ═══════════════════════════════════════════════════════════════════
function showCard(step, onDone, token){
  var el=document.getElementById(\'card-overlay\');
  document.getElementById(\'card-chap\').innerHTML=step.chap||\'\';
  document.getElementById(\'card-hl\').innerHTML=step.hl||\'\';
  document.getElementById(\'card-sub\').innerHTML=step.sub||\'\';

  el.classList.remove(\'active\',\'go\');
  var prog=document.getElementById(\'card-progress\');
  prog.style.transition=\'none\'; prog.style.width=\'0\';
  el.classList.add(\'active\');
  void el.offsetWidth;
  el.classList.add(\'go\');

  // CTA button
  if(step.cta){
    if(!document.getElementById(\'cta-btn\')){
      var btn=document.createElement(\'button\');
      btn.id=\'cta-btn\';
      btn.textContent=\'Book a demo call\';
      btn.style.cssText=\'margin-top:28px;padding:16px 48px;background:#22c55e;color:#000;font-family:inherit;font-size:14px;font-weight:900;border:none;border-radius:12px;cursor:pointer;letter-spacing:-.01em\';
      btn.onclick=function(){ window.open(\'mailto:hello@ex3.io\',\'_blank\'); };
      document.getElementById(\'card-inner\').appendChild(btn);
    }
    document.getElementById(\'next-btn\').classList.add(\'next-ready\');
    return;
  }

  function afterNarration(){
    if(token!==stepToken) return;
    if(step.postVoice){
      // Play Sarah stressed voice then advance
      var url=\'/api/tts?text=\'+encodeURIComponent(step.postVoice)+(step.postVoiceStressed?\'&stressed=1\':\'\');
      var ctx=_getActx();
      fetch(url).then(function(r){return r.arrayBuffer();})
        .then(function(buf){return ctx.decodeAudioData(buf);})
        .then(function(decoded){
          if(token!==stepToken) return;
          var src=ctx.createBufferSource();
          src.buffer=decoded; src.connect(ctx.destination);
          src.onended=function(){
            setTimeout(function(){
              if(token!==stepToken) return;
              el.classList.remove(\'active\',\'go\');
              if(onDone) onDone();
            },800);
          };
          src.start(0);
        }).catch(function(){
          if(token!==stepToken) return;
          el.classList.remove(\'active\',\'go\');
          if(onDone) onDone();
        });
    } else if(step.dur>0){
      prog.style.transition=\'none\'; prog.style.width=\'0\';
      setTimeout(function(){
        prog.style.transition=\'width \'+step.dur+\'ms linear\';
        prog.style.width=\'100%\';
      },60);
      autoTimers.push(setTimeout(function(){
        if(token!==stepToken) return;
        el.classList.remove(\'active\',\'go\');
        if(onDone) onDone();
      },step.dur));
    } else {
      document.getElementById(\'next-btn\').classList.add(\'next-ready\');
    }
  }

  if(step.voice){
    speak(step.voice, afterNarration, token);
  } else {
    afterNarration();
  }
}
function hideCard(){
  var el=document.getElementById(\'card-overlay\');
  el.classList.remove(\'active\',\'go\');
}

// ═══════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════
function cleanupStep(){
  autoTimers.forEach(clearTimeout); autoTimers=[];
  clearWaTimers();
  stopAudio();
  clearSpotlight();
  resetZoom(stepToken+1);
  hideCursor();
  hideWa();
  hideAnalytics();
  var rec=document.getElementById(\'wa-rec-scene\');
  if(rec){ rec.classList.remove(\'show\'); rec.style.opacity=\'\'; }
  document.getElementById(\'next-btn\').classList.remove(\'next-ready\');
  if(cursorMoveRaf){ cancelAnimationFrame(cursorMoveRaf); cursorMoveRaf=null; }
}

// ═══════════════════════════════════════════════════════════════════
// RENDER STEP
// ═══════════════════════════════════════════════════════════════════
function goToStep(idx){
  cleanupStep();
  stepToken = ++stepToken;
  var token = stepToken;
  cur = Math.max(0, Math.min(idx, STEPS.length-1));
  renderChapNav();

  var s = STEPS[cur];

  // Flash transition (not on cards auto-advancing)
  var fl=document.getElementById(\'flash\');
  fl.classList.add(\'on\');
  setTimeout(function(){
    fl.classList.remove(\'on\');
  },260);

  setTimeout(function(){
    if(token!==stepToken) return;
    _renderStep(s, token);
  },130);
}

function _renderStep(s, token){
  // ── Card step ──
  if(s.type===\'card\'){
    hideCard();
    showCard(s, function(){
      if(token!==stepToken) return;
      goToStep(cur+1);
    }, token);
    return;
  }

  // ── Live step ──
  hideCard();

  // Handle iframe URL
  if(s.url){
    var lf=document.getElementById(\'live-frame\');
    if(lf.src.replace(location.origin,\'\')!==s.url){
      lf.src=s.url;
    }
    lf.style.display=\'\';
  }

  // Set role if specified
  if(s.role){
    setTimeout(function(){
      if(token!==stepToken) return;
      postToFrame({action:\'setRole\',role:s.role});
    },600);
  }

  // WhatsApp
  if(s.waChat){
    showWa(s.waMessages||[], token);
  }

  // Analytics
  if(s.analytics){
    showAnalytics(token);
  }

  // Update URL bar
  if(s.url){
    document.getElementById(\'burl-txt\').textContent = \'ex3-guide.railway.app\' + (s.url===\'/?\' ? \'\' : s.url);
  }

  // postMessage auto actions
  if(s.auto){
    s.auto.forEach(function(a){
      autoTimers.push(setTimeout(function(){
        if(token!==stepToken) return;
        postToFrame(a.a);
      },a.d));
    });
  }

  // Cursor path
  if(s.cursor){
    autoTimers.push(setTimeout(function(){
      if(token!==stepToken) return;
      runCursorPath(s.cursor, token);
    },400));
  }

  // Zoom
  if(s.zoom){
    resetZoom(token);
    zoomFrame(s.zoom.x, s.zoom.y, s.zoom.scale, s.zoom.d||2000, token);
  }

  // Recording scene (show before WA messages start)
  if(s.recordingScene){
    var rec=document.getElementById(\'wa-rec-scene\');
    if(rec){
      rec.style.opacity=\'1\'; rec.classList.add(\'show\');
      autoTimers.push(setTimeout(function(){
        if(token!==stepToken) return;
        rec.style.opacity=\'0\';
        setTimeout(function(){ rec.classList.remove(\'show\'); rec.style.opacity=\'\'; },500);
      },5200));
    }
  }

  // Voice narration
  if(s.voice){
    speak(s.voice, function(){
      if(token!==stepToken) return;
      var hold = s.minHold||0;
      if(s.manual){
        document.getElementById(\'next-btn\').classList.add(\'next-ready\');
      } else {
        autoTimers.push(setTimeout(function(){
          if(token!==stepToken) return;
          goToStep(cur+1);
        },hold));
      }
    }, token);
  } else {
    document.getElementById(\'next-btn\').classList.add(\'next-ready\');
  }
}

// ═══════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════
function nextStep(){ goToStep(cur+1); }
function prevStep(){ goToStep(Math.max(0,cur-1)); }
function replayAudio(){
  var s=STEPS[cur];
  if(s.voice) speak(s.voice,null,stepToken);
}
function toggleMute(){
  muted=!muted;
  var btn=document.getElementById(\'vol-btn\');
  var txt=document.getElementById(\'vol-txt\');
  btn.classList.toggle(\'muted\',muted);
  txt.textContent=muted?\'Voice Off\':\'Voice On\';
  if(muted) stopAudio();
}

document.addEventListener(\'keydown\',function(e){
  if(e.key===\'ArrowRight\'||e.key===\' \') nextStep();
  if(e.key===\'ArrowLeft\') prevStep();
  if(e.key===\'m\'||e.key===\'M\') toggleMute();
  if(e.key===\'r\'||e.key===\'R\') replayAudio();
});

// ═══════════════════════════════════════════════════════════════════
// WHATSAPP STEP: fix advance timing
// ═══════════════════════════════════════════════════════════════════
// Override _renderStep WA advance — WA messages end around 21s, hold 3s more
var _origRender = _renderStep;
// The WA step auto-advance is handled inline above with 24000ms

// ═══════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════
function beginDemo(){
  _getActx().resume(); // unlock AudioContext during user gesture
  var ss=document.getElementById(\'start-screen\');
  ss.classList.add(\'fade\');
  setTimeout(function(){ ss.style.display=\'none\'; goToStep(0); },600);
}
// Preload iframe silently so it\'s warm when demo starts
document.getElementById(\'live-frame\').src=\'/\';
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  if (!process.env.ASSISTANT_ID) {
    console.warn('⚠  ASSISTANT_ID not set — run "node setup.js" first to upload your documents.');
  }
  console.log(`EX3 Guide running at http://localhost:${PORT}`);
});
