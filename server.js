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
  <a href="/" class="back-link">← Back to Main Guide</a>
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
.warn{border-left:3px solid #dc2626;background:#fff;padding:10px 14px;font-size:13px;color:#333;margin-top:8px}
.warn strong{color:#dc2626}
.say{border-left:3px solid #2563eb;background:#fff;padding:10px 14px;font-size:13px;color:#333;font-style:italic;margin-top:8px}
.tip-hq{border-left:3px solid #16a34a;background:#fff;padding:10px 14px;font-size:13px;color:#333;margin-top:8px}
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
/* Kickoff Generator */
.gen-card{background:#fff;border:1px solid #e4e2dc;border-radius:12px;padding:32px;margin-bottom:24px}
.gen-section-title{font-size:18px;font-weight:700;color:#0f0f0e;margin-bottom:24px;letter-spacing:-.01em}
.gen-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
.gen-field{display:flex;flex-direction:column;gap:6px}
.gen-field-full{margin-bottom:20px}
.gen-label{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#555}
.gen-req{color:#dc2626}
.gen-input{padding:10px 14px;border:1px solid #e4e2dc;border-radius:8px;font-size:14px;font-family:'Inter',system-ui,sans-serif;color:#0f0f0e;outline:none;transition:border-color .2s;background:#fafaf9}
.gen-input:focus{border-color:#0f0f0f;background:#fff}
.gen-checks{display:flex;flex-wrap:wrap;gap:10px 20px;margin-top:4px}
.gen-check{display:flex;align-items:center;gap:8px;font-size:13px;color:#333;cursor:pointer;padding:8px 14px;border:1px solid #e4e2dc;border-radius:8px;background:#fafaf9;transition:all .15s;user-select:none}
.gen-check:hover{border-color:#0f0f0f}
.gen-check input{accent-color:#0f0f0f;cursor:pointer}
.gen-radio-group{display:flex;gap:12px;flex-wrap:wrap;margin-top:4px}
.gen-radio{display:flex;align-items:center;gap:8px;font-size:13px;color:#333;cursor:pointer;padding:8px 16px;border:1px solid #e4e2dc;border-radius:8px;background:#fafaf9;transition:all .15s;user-select:none}
.gen-radio:hover{border-color:#0f0f0f}
.gen-radio input{accent-color:#0f0f0f;cursor:pointer}
.gen-btn{display:inline-flex;align-items:center;gap:8px;padding:12px 24px;background:#0f0f0f;border:none;border-radius:8px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s;margin-top:8px}
.gen-btn:hover{background:#333}
.gen-btn:disabled{opacity:.4;cursor:not-allowed}
.gen-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:48px;text-align:center}
.gen-loading p{font-size:14px;color:#555}
.gen-spinner{width:32px;height:32px;border:3px solid #e4e2dc;border-top-color:#0f0f0f;border-radius:50%;animation:gen-spin .7s linear infinite}
@keyframes gen-spin{to{transform:rotate(360deg)}}
.gen-result{background:#fff;border:1px solid #e4e2dc;border-radius:12px;padding:32px;margin-bottom:24px}
.gen-result-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #e4e2dc}
.gen-result-header h2{font-size:20px;font-weight:700;color:#0f0f0e;letter-spacing:-.01em;margin:0}
.gen-export-btn{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;background:#0f0f0f;border:none;border-radius:8px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:13px;font-weight:700;cursor:pointer;transition:background .15s}
.gen-export-btn:hover{background:#333}
.gen-section{margin-bottom:28px}
.gen-section-h{font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#0f0f0e;margin-bottom:12px;padding-bottom:6px;border-bottom:2px solid #0f0f0e}
.gen-table{width:100%;border-collapse:collapse;font-size:13px}
.gen-table th{background:#f5f4f1;padding:10px 14px;text-align:left;font-weight:700;color:#0f0f0e;border:1px solid #e4e2dc}
.gen-table td{padding:10px 14px;border:1px solid #e4e2dc;color:#333;line-height:1.5;vertical-align:top}
.gen-table tr:nth-child(even) td{background:#fafaf9}
.risk-high{color:#dc2626;font-weight:700}
.risk-med{color:#d97706;font-weight:700}
.risk-low{color:#16a34a;font-weight:700}
.gen-ol{padding-left:20px;margin:0;line-height:2;font-size:13px;color:#333}
@media(max-width:700px){.gen-grid{grid-template-columns:1fr}}
/* Meeting Coach */
.mc-hero{background:#0f0f0e;padding:56px 48px 52px;margin:-32px -32px 0}
.mc-hero-inner{max-width:680px}
.mc-hero-label{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#666;margin-bottom:16px}
.mc-hero-title{font-size:40px;font-weight:800;color:#fff;letter-spacing:-.03em;line-height:1.1;margin:0 0 16px}
.mc-hero-sub{font-size:14px;color:#888;line-height:1.7;margin:0;max-width:560px}
.mc-form-wrap{padding:32px 0 0}
.mc-form-card{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:28px 32px}
.mc-form-row{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px}
.mc-label{display:block;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#555;margin-bottom:8px}
.mc-optional{font-weight:400;text-transform:none;letter-spacing:0;color:#aaa}
.mc-select,.mc-input{width:100%;padding:11px 14px;border:1px solid #e4e2dc;border-radius:8px;font-size:14px;font-family:'Inter',system-ui,sans-serif;color:#0f0f0e;background:#fafaf9;outline:none;transition:border-color .2s;box-sizing:border-box;appearance:none;-webkit-appearance:none}
.mc-select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%23555' stroke-width='2' viewBox='0 0 24 24'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px}
.mc-select:focus,.mc-input:focus{border-color:#0f0f0e;background:#fff}
.mc-run-btn{display:inline-flex;align-items:center;gap:9px;padding:13px 28px;background:#0f0f0e;border:none;border-radius:8px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s;letter-spacing:-.01em}
.mc-run-btn:hover{background:#2a2a2a}
.mc-run-btn:disabled{opacity:.4;cursor:not-allowed}
.mc-loading{display:none;align-items:center;gap:14px;padding:40px 0;font-size:13px;color:#888}
.mc-spinner{width:20px;height:20px;border:2px solid #e4e2dc;border-top-color:#0f0f0e;border-radius:50%;animation:gen-spin .7s linear infinite;flex-shrink:0}
.mc-brief{margin-top:32px;border:1px solid #e4e2dc;border-radius:10px;overflow:hidden}
.mc-brief-topbar{background:#0f0f0e;padding:24px 32px;display:flex;align-items:center;justify-content:space-between}
.mc-brief-label{font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#555;margin-bottom:6px}
.mc-brief-title{font-size:20px;font-weight:700;color:#fff;letter-spacing:-.02em}
.mc-export-btn{display:inline-flex;align-items:center;gap:8px;padding:9px 18px;background:transparent;border:1px solid #333;border-radius:7px;color:#aaa;font-family:'Inter',system-ui,sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.mc-export-btn:hover{border-color:#fff;color:#fff}
.mc-body{padding:32px}
.mc-two-col{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-bottom:28px}
.mc-section{margin-bottom:28px}
.mc-two-col .mc-section{margin-bottom:0}
.mc-section-label{font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#0f0f0e;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #e4e2dc}
.mc-purpose-text{font-size:14px;color:#333;line-height:1.75}
.mc-agenda-item{padding:14px 0;border-bottom:1px solid #f0ede8}
.mc-agenda-item:last-child{border-bottom:none}
.mc-agenda-item-title{font-size:13px;font-weight:700;color:#0f0f0e;margin-bottom:5px}
.mc-agenda-item-notes{font-size:13px;color:#555;line-height:1.6}
.mc-ol{padding-left:0;margin:0;list-style:none;counter-reset:mc-counter}
.mc-ol li{counter-increment:mc-counter;display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #f5f4f1;font-size:13px;color:#333;line-height:1.6}
.mc-ol li:last-child{border-bottom:none}
.mc-ol li::before{content:counter(mc-counter);display:flex;align-items:center;justify-content:center;min-width:22px;height:22px;background:#0f0f0e;color:#fff;border-radius:4px;font-size:10px;font-weight:800;margin-top:1px;flex-shrink:0}
.mc-warn-list li::before{background:#dc2626}
.mc-qa-table{width:100%;border-collapse:collapse;font-size:13px}
.mc-qa-table th{background:#f5f4f1;padding:10px 16px;text-align:left;font-weight:700;color:#0f0f0e;border:1px solid #e4e2dc;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.mc-qa-table td{padding:12px 16px;border:1px solid #e4e2dc;color:#333;line-height:1.6;vertical-align:top}
.mc-qa-table tr:nth-child(even) td{background:#fafaf9}
.mc-qa-q{font-weight:600;color:#0f0f0e}
@media(max-width:800px){.mc-two-col{grid-template-columns:1fr}.mc-hero{padding:36px 24px 32px}.mc-form-row{grid-template-columns:1fr}.mc-body{padding:20px}.mc-brief-topbar{padding:20px 24px}}
/* Project Workbook Builder */
.pw-hero{background:linear-gradient(160deg,#0f0f0e 0%,#181816 100%);padding:64px 48px 56px;margin:-32px -32px 0;position:relative;overflow:hidden}
.pw-hero::before{content:'';position:absolute;top:-60px;right:-80px;width:500px;height:500px;background:radial-gradient(circle,rgba(99,102,241,.07) 0%,transparent 65%);pointer-events:none}
.pw-hero-inner{max-width:680px;position:relative;z-index:1}
.pw-hero-label{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#3a3a38;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.pw-hero-label::after{content:'';flex:0 0 24px;height:1px;background:#2a2a28}
.pw-hero-title{font-size:38px;font-weight:800;color:#fff;letter-spacing:-.04em;line-height:1.08;margin:0 0 18px}
.pw-hero-sub{font-size:14px;color:#5a5a58;line-height:1.8;margin:0;max-width:540px}
.pw-form-wrap{padding:36px 0 0}
.pw-form-card{background:#fff;border:1px solid #ebe7e1;border-radius:14px;padding:32px 36px;box-shadow:0 2px 8px rgba(0,0,0,.04),0 1px 2px rgba(0,0,0,.03)}
.pw-form-row,.pw-form-row2{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-bottom:28px}
.pw-form-divider{display:flex;align-items:center;gap:16px;margin:4px 0 24px}
.pw-form-divider-label{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#c0bbb4;white-space:nowrap}
.pw-form-divider-line{flex:1;height:1px;background:#ebe7e1}
.pw-label{display:block;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#aaa8a4;margin-bottom:8px}
.pw-input,.pw-select{width:100%;padding:11px 14px;border:1.5px solid #ebe7e1;border-radius:9px;font-size:14px;font-family:'Inter',system-ui,sans-serif;color:#0f0f0e;background:#fff;outline:none;transition:border-color .18s,box-shadow .18s;box-sizing:border-box;appearance:none;-webkit-appearance:none}
.pw-select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%23aaa' stroke-width='2.5' viewBox='0 0 24 24'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px}
.pw-input:focus,.pw-select:focus{border-color:#0f0f0e;box-shadow:0 0 0 3px rgba(15,15,14,.06)}
.pw-areas-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 20px}
.pw-area-check,.pw-int-check{display:flex;align-items:center;gap:9px;cursor:pointer;font-size:13px;color:#444;line-height:1.4;padding:3px 0}
.pw-area-check input{width:15px;height:15px;accent-color:#0f0f0e;cursor:pointer;flex-shrink:0}
.pw-int-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 20px}
.pw-int-check input{width:15px;height:15px;accent-color:#7c3aed;cursor:pointer;flex-shrink:0}
.pw-run-btn{display:inline-flex;align-items:center;gap:10px;padding:13px 28px;background:#0f0f0e;border:none;border-radius:9px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:transform .2s,box-shadow .2s,background .2s;letter-spacing:-.01em}
.pw-run-btn:hover{background:#1c1c1a;transform:translateY(-1px);box-shadow:0 6px 20px rgba(15,15,14,.18)}
.pw-run-btn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.pw-hint{font-size:12px;color:#bbb}
.pw-loading{align-items:flex-start;gap:20px;padding:48px 0;max-width:600px}
.pw-spinner{width:20px;height:20px;border:2px solid #eae6e0;border-top-color:#0f0f0e;border-radius:50%;animation:gen-spin .8s linear infinite;flex-shrink:0;margin-top:3px}
.pw-loading-title{font-size:15px;font-weight:700;color:#0f0f0e;margin-bottom:6px}
.pw-loading-sub{font-size:13px;color:#aaa;line-height:1.7}
.pw-result-topbar{background:#0f0f0e;padding:22px 32px;display:flex;align-items:center;justify-content:space-between;border-radius:14px 14px 0 0;margin-top:36px}
.pw-result-label{font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#3a3a38;margin-bottom:6px}
.pw-result-title{font-size:18px;font-weight:700;color:#fff;letter-spacing:-.025em}
.pw-topbar-right{display:flex;align-items:center;gap:10px}
.pw-export-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:rgba(255,255,255,.5);font-family:'Inter',system-ui,sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;letter-spacing:.01em}
.pw-export-btn:hover{background:rgba(255,255,255,.11);border-color:rgba(255,255,255,.22);color:rgba(255,255,255,.9)}
.pw-export-btn:disabled{opacity:.3;cursor:not-allowed}
.pw-stats-bar{background:#141412;padding:16px 32px;display:flex;gap:36px;border-bottom:1px solid #1e1e1c}
.pw-stat{display:flex;flex-direction:column;gap:3px}
.pw-stat-num{font-size:22px;font-weight:800;color:#fff;letter-spacing:-.04em;line-height:1}
.pw-stat-label{font-size:10px;color:#3e3e3c;text-transform:uppercase;letter-spacing:.14em;font-weight:600}
.pw-view-tabs{background:#141412;padding:0 32px;display:flex;border-bottom:1px solid #1e1e1c}
.pw-view-tab{font-size:10px;font-weight:700;color:#3e3e3c;padding:12px 16px;cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;letter-spacing:.14em;text-transform:uppercase}
.pw-view-tab:hover{color:#888}
.pw-view-tab.active{color:#fff;border-bottom-color:#fff}
.pw-weeks-container,.pw-by-area{border:1px solid #ebe7e1;border-top:none;border-radius:0 0 14px 14px;overflow:hidden;background:#fafaf8}
.pw-container-toolbar{display:flex;align-items:center;justify-content:flex-end;padding:10px 24px;background:#fff;border-bottom:1px solid #ebe7e1;gap:10px}
.pw-toggle-all-btn{font-size:11px;font-weight:600;color:#aaa;background:none;border:1.5px solid #ebe7e1;border-radius:7px;padding:5px 13px;cursor:pointer;transition:all .18s;font-family:'Inter',system-ui,sans-serif;letter-spacing:.02em}
.pw-toggle-all-btn:hover{border-color:#555;color:#333}
.pw-week{background:#fff;border-bottom:1px solid #ebe7e1}
.pw-week:last-child{border-bottom:none}
.pw-week-header{display:flex;align-items:center;justify-content:space-between;padding:20px 28px;cursor:pointer;user-select:none;transition:background .18s;border-left:3px solid #fff}
.pw-week-header:hover{background:#fafaf8;border-left-color:#ebe7e1}
.pw-week-header.open{background:#fafaf8;border-left-color:#0f0f0e}
.pw-week-left{display:flex;align-items:flex-start;gap:20px}
.pw-week-num{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#c8c4be;min-width:50px;padding-top:4px;flex-shrink:0}
.pw-week-theme{font-size:15px;font-weight:700;color:#0f0f0e;letter-spacing:-.02em;margin-bottom:4px;line-height:1.3}
.pw-week-focus{font-size:12px;color:#b0aca6;line-height:1.5;margin-bottom:3px}
.pw-week-milestone{font-size:11px;color:#16a34a;font-weight:600;margin-top:2px}
.pw-week-meta{display:flex;align-items:center;gap:8px;flex-shrink:0}
.pw-week-count{font-size:11px;color:#aaa8a4;font-weight:600;white-space:nowrap;background:#f2efe9;padding:4px 11px;border-radius:20px}
.pw-week-hours{font-size:11px;color:#888;font-weight:600;white-space:nowrap;display:flex;align-items:center;gap:4px}
.pw-week-chevron{width:14px;height:14px;color:#ccc;transition:transform .25s;flex-shrink:0}
.pw-week-header.open .pw-week-chevron{transform:rotate(180deg)}
.pw-week-body{display:none;border-top:1px solid #f2efe9}
.pw-week-body.open{display:block}
.pw-process{padding:24px 28px 20px;border-bottom:1px solid #f5f2ed;border-left:3px solid transparent;transition:background .15s,border-left-color .15s}
.pw-process:last-child{border-bottom:none}
.pw-process:hover{background:#fdfcfb}
.pw-process-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
.pw-process-title-block{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0}
.pw-process-area-badge{font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:3px 8px;border-radius:3px;white-space:nowrap;align-self:flex-start;display:inline-flex;align-items:center;gap:5px;line-height:1.4}
.pw-process-area-badge::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.7;flex-shrink:0}
.pw-process-title{font-size:14px;font-weight:700;color:#0f0f0e;margin:0;letter-spacing:-.015em;line-height:1.4}
.pw-process-nav{font-size:11.5px;color:#bbb;margin:0;line-height:1.5;display:flex;align-items:center;flex-wrap:wrap;gap:2px}
.pw-process-nav span{color:#aaa}
.pw-nav-arrow{color:#d8d4ce;flex-shrink:0}
.pw-process-badges{display:flex;align-items:center;gap:7px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.pw-owner{font-size:10px;font-weight:700;letter-spacing:.04em;padding:4px 11px;border-radius:20px;white-space:nowrap;text-transform:uppercase}
.pw-owner-ex3{background:#0f0f0e;color:#fff}
.pw-owner-client{background:#f0f5ff;color:#2563eb;border:1px solid #bfdbfe}
.pw-owner-both{background:#f7f3ff;color:#7c3aed;border:1px solid #ddd6fe}
.pw-duration{font-size:11px;color:#bbb;font-weight:500;white-space:nowrap;display:flex;align-items:center;gap:4px}
.pw-depends{font-size:12px;color:#888;background:#f8f7f4;border-left:2px solid #d6d1c9;padding:9px 13px;border-radius:0 6px 6px 0;margin-bottom:14px;line-height:1.65}
.pw-depends-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:#c0bab2;display:block;margin-bottom:3px}
.pw-steps{margin:0 0 14px;padding:0;list-style:none;counter-reset:pw-step}
.pw-steps li{counter-increment:pw-step;display:flex;gap:13px;padding:9px 0;border-bottom:1px solid #f5f2ed;font-size:13px;color:#444;line-height:1.7}
.pw-steps li:last-child{border-bottom:none;padding-bottom:2px}
.pw-steps li::before{content:counter(pw-step);display:flex;align-items:center;justify-content:center;min-width:22px;height:22px;background:#f2efe9;color:#999;border-radius:50%;font-size:10px;font-weight:800;margin-top:3px;flex-shrink:0;font-variant-numeric:tabular-nums}
.pw-output{font-size:12.5px;color:#166534;background:transparent;border-left:2px solid #4ade80;padding:8px 12px;border-radius:0;display:flex;gap:10px;align-items:flex-start;margin-bottom:8px}
.pw-output-badge{font-size:9px;font-weight:700;letter-spacing:.1em;color:#16a34a;flex-shrink:0;white-space:nowrap;text-transform:uppercase;padding-top:2px}
.pw-gotcha{font-size:12.5px;color:#92400e;background:transparent;border-left:2px solid #fbbf24;padding:8px 12px;border-radius:0;display:flex;gap:10px;align-items:flex-start}
.pw-gotcha-icon{font-size:12px;flex-shrink:0;color:#f59e0b;font-weight:800;line-height:1.5}
.pw-area-section{border-bottom:1px solid #ebe7e1;background:#fff}
.pw-area-section:last-child{border-bottom:none}
.pw-area-section-header{display:flex;align-items:center;justify-content:space-between;padding:18px 28px;cursor:pointer;user-select:none;transition:background .18s;border-left:3px solid transparent}
.pw-area-section-header:hover{background:#fafaf8}
.pw-area-section-header.open{background:#fafaf8}
.pw-area-section-left{display:flex;align-items:center;gap:12px}
.pw-area-section-title{font-size:13px;font-weight:700;letter-spacing:-.01em}
.pw-area-section-count{font-size:10px;color:#aaa;font-weight:600;background:#f2efe9;padding:3px 10px;border-radius:20px}
.pw-area-chevron{width:14px;height:14px;color:#ccc;transition:transform .25s;flex-shrink:0}
.pw-area-section-header.open .pw-area-chevron{transform:rotate(180deg)}
.pw-area-section-body{display:none;background:#fafaf8}
.pw-area-section-body.open{display:block}
.pw-area-proc-item{padding:8px 28px 0;border-bottom:1px solid #ebe7e1}
.pw-area-proc-item:last-child{border-bottom:none}
.pw-area-week-badge{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:3px 9px;border-radius:3px;display:inline-block;margin-bottom:8px;margin-top:14px}
@media(max-width:900px){.pw-hero{padding:36px 24px 32px}.pw-form-row,.pw-form-row2{grid-template-columns:1fr}.pw-areas-grid,.pw-int-grid{grid-template-columns:1fr 1fr}.pw-result-topbar{flex-direction:column;gap:16px;align-items:flex-start}.pw-week-header{padding:14px 18px}.pw-process{padding:16px 18px}.pw-stats-bar{gap:20px;flex-wrap:wrap}.pw-view-tabs{padding:0 18px}.pw-process-header{flex-direction:column;gap:10px}.pw-process-badges{justify-content:flex-start}}
/* Request a Guide */
.rg-hero{background:linear-gradient(160deg,#0f0f0e 0%,#181816 100%);padding:64px 48px 56px;margin:-32px -32px 0;position:relative;overflow:hidden}
.rg-hero::before{content:'';position:absolute;top:-60px;right:-80px;width:500px;height:500px;background:radial-gradient(circle,rgba(16,185,129,.06) 0%,transparent 65%);pointer-events:none}
.rg-hero-inner{max-width:680px;position:relative;z-index:1}
.rg-hero-label{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#3a3a38;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.rg-hero-label::after{content:'';flex:0 0 24px;height:1px;background:#2a2a28}
.rg-hero-title{font-size:38px;font-weight:800;color:#fff;letter-spacing:-.04em;line-height:1.08;margin:0 0 18px}
.rg-hero-sub{font-size:14px;color:#5a5a58;line-height:1.8;margin:0;max-width:540px}
.rg-form-wrap{padding:36px 0 0;position:relative;z-index:1}
.rg-form-card{background:#fff;border:1px solid #ebe7e1;border-radius:14px;padding:32px 36px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
.rg-label{display:block;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#aaa8a4;margin-bottom:10px}
.rg-textarea{width:100%;padding:14px 16px;border:1.5px solid #ebe7e1;border-radius:9px;font-size:14px;font-family:'Inter',system-ui,sans-serif;color:#0f0f0e;background:#fff;outline:none;transition:border-color .18s,box-shadow .18s;box-sizing:border-box;resize:vertical;min-height:120px;line-height:1.7}
.rg-textarea:focus{border-color:#0f0f0e;box-shadow:0 0 0 3px rgba(15,15,14,.06)}
.rg-examples{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px}
.rg-example{font-size:11.5px;color:#888;background:#f5f4f1;border:1.5px solid #ebe7e1;border-radius:20px;padding:5px 13px;cursor:pointer;transition:all .18s;font-family:'Inter',system-ui,sans-serif;line-height:1.5}
.rg-example:hover{background:#ebe7e1;color:#333;border-color:#d6d1c9}
.rg-run-btn{display:inline-flex;align-items:center;gap:10px;padding:13px 28px;background:#0f0f0e;border:none;border-radius:9px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:transform .2s,box-shadow .2s,background .2s;letter-spacing:-.01em}
.rg-run-btn:hover{background:#1c1c1a;transform:translateY(-1px);box-shadow:0 6px 20px rgba(15,15,14,.18)}
.rg-run-btn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.rg-hint{font-size:12px;color:#bbb}
.rg-loading{align-items:flex-start;gap:20px;padding:48px 0;max-width:600px}
.rg-spinner{width:20px;height:20px;border:2px solid #eae6e0;border-top-color:#0f0f0e;border-radius:50%;animation:gen-spin .8s linear infinite;flex-shrink:0;margin-top:3px}
.rg-loading-title{font-size:15px;font-weight:700;color:#0f0f0e;margin-bottom:6px}
.rg-loading-sub{font-size:13px;color:#aaa;line-height:1.7}
.rg-result-wrap{margin-top:36px;border-radius:14px;overflow:hidden;border:1px solid #ebe7e1}
.rg-result-topbar{background:#0f0f0e;padding:22px 32px;display:flex;align-items:center;justify-content:space-between}
.rg-result-label{font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#3a3a38;margin-bottom:5px}
.rg-result-title{font-size:18px;font-weight:700;color:#fff;letter-spacing:-.025em}
.rg-export-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:rgba(255,255,255,.5);font-family:'Inter',system-ui,sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s}
.rg-export-btn:hover{background:rgba(255,255,255,.11);border-color:rgba(255,255,255,.22);color:rgba(255,255,255,.9)}
.rg-export-btn:disabled{opacity:.3;cursor:not-allowed}
.rg-summary{padding:28px 32px;background:#fafaf8;border-bottom:1px solid #ebe7e1;font-size:14px;color:#555;line-height:1.85}
.rg-body{background:#fff}
.rg-section{padding:26px 32px;border-bottom:1px solid #f5f2ed}
.rg-section:last-child{border-bottom:none}
.rg-section-heading{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#0f0f0e;margin-bottom:14px;display:flex;align-items:center;gap:10px}
.rg-section-heading::after{content:'';flex:1;height:1px;background:#ebe7e1}
.rg-section-body{font-size:13.5px;color:#444;line-height:1.8}
.rg-steps-list{margin:0;padding:0;list-style:none;counter-reset:rg-step}
.rg-steps-list li{counter-increment:rg-step;display:flex;gap:13px;padding:9px 0;border-bottom:1px solid #f5f2ed;font-size:13px;color:#444;line-height:1.7}
.rg-steps-list li:last-child{border-bottom:none;padding-bottom:2px}
.rg-steps-list li::before{content:counter(rg-step);display:flex;align-items:center;justify-content:center;min-width:22px;height:22px;background:#f2efe9;color:#999;border-radius:50%;font-size:10px;font-weight:800;margin-top:3px;flex-shrink:0}
.rg-watch-item{display:flex;gap:12px;padding:8px 12px;border-left:2px solid #fbbf24;margin-bottom:8px;font-size:13px;color:#92400e;line-height:1.65}
.rg-watch-item:last-child{margin-bottom:0}
.rg-watch-icon{color:#f59e0b;font-size:12px;font-weight:800;flex-shrink:0;padding-top:1px}
.rg-raci-row{display:flex;align-items:flex-start;gap:0;border-bottom:1px solid #f5f2ed;padding:10px 0}
.rg-raci-row:last-child{border-bottom:none}
.rg-raci-role{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:3px 11px;border-radius:20px;white-space:nowrap;flex-shrink:0;margin-right:16px;margin-top:1px}
.rg-role-ex3{background:#0f0f0e;color:#fff}
.rg-role-client{background:#f0f5ff;color:#2563eb;border:1px solid #bfdbfe}
.rg-role-both{background:#f7f3ff;color:#7c3aed;border:1px solid #ddd6fe}
.rg-raci-task{font-size:13px;color:#444;line-height:1.65}
.rg-docs-list{display:flex;flex-direction:column;gap:0}
.rg-doc-item{font-size:13px;color:#555;display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #f5f2ed}
.rg-doc-item:last-child{border-bottom:none}
.rg-doc-item::before{content:'';width:5px;height:5px;border-radius:50%;background:#c8c4be;flex-shrink:0}
.est-hero{background:linear-gradient(160deg,#0f0f0e 0%,#181816 100%);padding:64px 48px 56px;margin:-32px -32px 0;position:relative;overflow:hidden}
.est-hero::before{content:'';position:absolute;top:-60px;left:-80px;width:500px;height:500px;background:radial-gradient(circle,rgba(99,102,241,.05) 0%,transparent 65%);pointer-events:none}
.est-hero-inner{max-width:680px;position:relative;z-index:1}
.est-hero-label{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#3a3a38;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.est-hero-label::after{content:'';flex:0 0 24px;height:1px;background:#2a2a28}
.est-hero-title{font-size:38px;font-weight:800;color:#fff;letter-spacing:-.04em;line-height:1.08;margin:0 0 18px}
.est-hero-sub{font-size:14px;color:#5a5a58;line-height:1.8;margin:0;max-width:540px}
.est-wrap{padding:36px 0 0;position:relative;z-index:1}
.est-progress-bar{height:3px;background:#ebe7e1;border-radius:2px;margin-bottom:10px;overflow:hidden}
.est-progress-fill{height:100%;background:#0f0f0e;border-radius:2px;transition:width .4s cubic-bezier(.4,0,.2,1)}
.est-step-count{font-size:11px;font-weight:600;color:#bbb;letter-spacing:.06em;margin-bottom:24px;text-transform:uppercase}
.est-card{background:#fff;border:1px solid #ebe7e1;border-radius:14px;padding:36px 40px;box-shadow:0 2px 8px rgba(0,0,0,.04);margin-bottom:24px}
.est-section-title{font-size:17px;font-weight:800;color:#0f0f0e;letter-spacing:-.03em;margin:0 0 4px}
.est-section-sub{font-size:13px;color:#aaa;margin:0 0 32px;line-height:1.5}
.est-q{margin-bottom:30px}
.est-q:last-child{margin-bottom:0}
.est-q-label{font-size:12px;font-weight:700;color:#0f0f0e;letter-spacing:.01em;margin-bottom:10px;display:block}
.est-q-sub{font-size:11px;color:#bbb;margin-bottom:10px;display:block;margin-top:-6px}
.est-pills{display:flex;flex-wrap:wrap;gap:8px}
.est-pill{position:relative}
.est-pill input{position:absolute;opacity:0;width:0;height:0}
.est-pill label{display:inline-flex;align-items:center;padding:9px 18px;border:1.5px solid #ebe7e1;border-radius:8px;font-size:13px;color:#666;cursor:pointer;transition:all .18s;background:#fafaf8;font-family:'Inter',system-ui,sans-serif;font-weight:500;line-height:1.3;user-select:none}
.est-pill label:hover{border-color:#bbb;color:#111;background:#f5f4f1}
.est-pill input:checked + label{border-color:#0f0f0e;background:#0f0f0e;color:#fff}
.est-checkgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px}
.est-check{position:relative}
.est-check input{position:absolute;opacity:0;width:0;height:0}
.est-check label{display:flex;align-items:center;gap:10px;padding:10px 14px;border:1.5px solid #ebe7e1;border-radius:8px;font-size:13px;color:#666;cursor:pointer;transition:all .18s;background:#fafaf8;font-family:'Inter',system-ui,sans-serif;font-weight:500;user-select:none}
.est-check label::before{content:'';width:14px;height:14px;border:1.5px solid #d6d2cc;border-radius:4px;flex-shrink:0;transition:all .15s;background:#fff}
.est-check input:checked + label{border-color:#0f0f0e;background:#f8f8f6;color:#111}
.est-check input:checked + label::before{background:#0f0f0e;border-color:#0f0f0e;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 5l2.5 2.5L8 3' stroke='white' stroke-width='1.8' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:center}
.est-divider{height:1px;background:#f0ede8;margin:28px 0}
.est-btn-row{display:flex;gap:12px;align-items:center;margin-top:8px}
.est-btn-next{display:inline-flex;align-items:center;gap:10px;padding:13px 28px;background:#0f0f0e;border:none;border-radius:9px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:transform .2s,box-shadow .2s,background .2s;letter-spacing:-.01em}
.est-btn-next:hover{background:#1c1c1a;transform:translateY(-1px);box-shadow:0 6px 20px rgba(15,15,14,.18)}
.est-btn-back{display:inline-flex;align-items:center;gap:8px;padding:13px 20px;background:transparent;border:1.5px solid #ebe7e1;border-radius:9px;color:#888;font-family:'Inter',system-ui,sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:all .18s}
.est-btn-back:hover{border-color:#bbb;color:#333}
.est-loading{display:none;align-items:flex-start;gap:20px;padding:48px 0;max-width:600px}
.est-spinner{width:20px;height:20px;border:2px solid #eae6e0;border-top-color:#0f0f0e;border-radius:50%;animation:gen-spin .8s linear infinite;flex-shrink:0;margin-top:3px}
.est-loading-title{font-size:15px;font-weight:700;color:#0f0f0e;margin-bottom:6px}
.est-loading-sub{font-size:13px;color:#aaa;line-height:1.7}
.est-result{display:none;margin-top:0}
.est-result-wrap{border-radius:14px;overflow:hidden;border:1px solid #ebe7e1}
.est-result-topbar{background:#0f0f0e;padding:28px 36px;display:flex;align-items:flex-start;justify-content:space-between;gap:24px}
.est-result-label{font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#3a3a38;margin-bottom:10px}
.est-result-headline{font-size:34px;font-weight:800;color:#fff;letter-spacing:-.045em;line-height:1;margin-bottom:6px}
.est-result-sub{font-size:13px;color:#555}
.est-result-export{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:rgba(255,255,255,.5);font-family:'Inter',system-ui,sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;white-space:nowrap;flex-shrink:0;margin-top:6px}
.est-result-export:hover{background:rgba(255,255,255,.11);border-color:rgba(255,255,255,.22);color:rgba(255,255,255,.9)}
.est-result-export:disabled{opacity:.3;cursor:not-allowed}
.est-stats-row{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid #ebe7e1}
.est-stat{padding:22px 28px;border-right:1px solid #ebe7e1;background:#fafaf8}
.est-stat:last-child{border-right:none}
.est-stat-label{font-size:9px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#bbb;margin-bottom:8px}
.est-stat-value{font-size:24px;font-weight:800;color:#0f0f0e;letter-spacing:-.04em;line-height:1}
.est-stat-unit{font-size:11px;font-weight:500;color:#aaa;margin-top:4px}
.est-timeline-section{padding:28px 32px;border-bottom:1px solid #ebe7e1;background:#fff}
.est-sec-label{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#0f0f0e;margin-bottom:16px;display:flex;align-items:center;gap:10px}
.est-sec-label::after{content:'';flex:1;height:1px;background:#ebe7e1}
.est-phases{display:flex;gap:0;border:1px solid #ebe7e1;border-radius:10px;overflow:hidden}
.est-phase{flex:1;padding:16px 14px;border-right:1px solid #ebe7e1;background:#fff}
.est-phase:last-child{border-right:none}
.est-phase-name{font-size:9px;font-weight:700;color:#aaa;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;line-height:1.4}
.est-phase-weeks{font-size:20px;font-weight:800;color:#0f0f0e;letter-spacing:-.035em;line-height:1}
.est-phase-wlabel{font-size:10px;color:#bbb;margin-top:3px}
.est-body-section{padding:26px 32px;border-bottom:1px solid #f5f2ed;background:#fff}
.est-body-section:last-child{border-bottom:none}
.est-body-text{font-size:13.5px;color:#444;line-height:1.85}
.est-risk-item{display:flex;gap:12px;padding:9px 12px;border-left:2px solid #fbbf24;margin-bottom:8px;font-size:13px;color:#92400e;line-height:1.65;border-radius:0 6px 6px 0}
.est-risk-item:last-child{margin-bottom:0}
.est-risk-icon{color:#f59e0b;font-size:11px;flex-shrink:0;padding-top:2px}
.est-assume-item{font-size:13px;color:#555;padding:8px 0;border-bottom:1px solid #f5f2ed;display:flex;gap:10px;align-items:flex-start;line-height:1.65}
.est-assume-item:last-child{border-bottom:none}
.est-assume-item::before{content:'';width:5px;height:5px;border-radius:50%;background:#c8c4be;flex-shrink:0;margin-top:8px}
.est-confidence{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:700;padding:4px 12px;border-radius:20px;letter-spacing:.06em;text-transform:uppercase}
.est-conf-high{background:#dcfce7;color:#166534}
.est-conf-med{background:#fef3c7;color:#92400e}
.est-conf-low{background:#fee2e2;color:#991b1b}
.est-reset-btn{display:inline-flex;align-items:center;gap:8px;margin-top:24px;padding:10px 20px;background:transparent;border:1.5px solid #ebe7e1;border-radius:9px;color:#888;font-family:'Inter',system-ui,sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:all .18s}
.est-reset-btn:hover{border-color:#bbb;color:#333}
/* SOW Builder */
#page-sowbuilder{margin-left:260px;padding:40px 48px;max-width:960px;box-sizing:border-box}
.sowb-hero{background:linear-gradient(160deg,#0f0f0e 0%,#181816 100%);padding:64px 48px 56px;margin:-32px -32px 0;position:relative;overflow:hidden}
.sowb-hero::before{content:'';position:absolute;top:-60px;right:-80px;width:500px;height:500px;background:radial-gradient(circle,rgba(124,58,237,.07) 0%,transparent 65%);pointer-events:none}
.sowb-hero-inner{max-width:680px;position:relative;z-index:1}
.sowb-hero-label{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#3a3a38;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.sowb-hero-label::after{content:'';flex:0 0 24px;height:1px;background:#2a2a28}
.sowb-hero-title{font-size:38px;font-weight:800;color:#fff;letter-spacing:-.04em;line-height:1.08;margin:0 0 18px}
.sowb-hero-sub{font-size:14px;color:#5a5a58;line-height:1.8;margin:0;max-width:540px}
.sowb-form-wrap{padding:36px 0 0}
.sowb-form-card{background:#fff;border:1px solid #ebe7e1;border-radius:14px;padding:32px 36px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
.sowb-section-title{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#0f0f0e;margin:24px 0 14px;display:flex;align-items:center;gap:10px}
.sowb-section-title::after{content:'';flex:1;height:1px;background:#ebe7e1}
.sowb-section-title:first-child{margin-top:0}
.sowb-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:4px}
.sowb-grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:4px}
.sowb-label{display:block;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#aaa8a4;margin-bottom:8px}
.sowb-input,.sowb-select{width:100%;padding:11px 14px;border:1.5px solid #ebe7e1;border-radius:9px;font-size:14px;font-family:'Inter',system-ui,sans-serif;color:#0f0f0e;background:#fff;outline:none;transition:border-color .18s,box-shadow .18s;box-sizing:border-box;appearance:none;-webkit-appearance:none}
.sowb-select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%23aaa' stroke-width='2.5' viewBox='0 0 24 24'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px}
.sowb-input:focus,.sowb-select:focus{border-color:#0f0f0e;box-shadow:0 0 0 3px rgba(15,15,14,.06)}
.sowb-textarea{width:100%;padding:12px 14px;border:1.5px solid #ebe7e1;border-radius:9px;font-size:13.5px;font-family:'Inter',system-ui,sans-serif;color:#0f0f0e;background:#fff;outline:none;resize:vertical;min-height:80px;transition:border-color .18s;box-sizing:border-box;line-height:1.7}
.sowb-textarea:focus{border-color:#0f0f0e;box-shadow:0 0 0 3px rgba(15,15,14,.06)}
.sowb-checks{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px}
.sowb-check{display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border:1.5px solid #ebe7e1;border-radius:8px;font-size:13px;color:#555;cursor:pointer;transition:all .18s;font-family:'Inter',system-ui,sans-serif;background:#fafaf8;user-select:none}
.sowb-check:hover{border-color:#bbb;color:#111}
.sowb-check input{width:14px;height:14px;accent-color:#7c3aed;cursor:pointer}
.sowb-check:has(input:checked){background:#f5f3ff;border-color:#7c3aed;color:#5b21b6;font-weight:600}
.sowb-run-btn{display:inline-flex;align-items:center;gap:10px;padding:13px 28px;background:#7c3aed;border:none;border-radius:9px;color:#fff;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:transform .2s,box-shadow .2s,background .2s;letter-spacing:-.01em}
.sowb-run-btn:hover{background:#6d28d9;transform:translateY(-1px);box-shadow:0 6px 20px rgba(124,58,237,.28)}
.sowb-run-btn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.sowb-hint{font-size:12px;color:#bbb;margin-left:14px}
.sowb-result-wrap{margin-top:36px;border-radius:14px;overflow:hidden;border:1px solid #ebe7e1}
.sowb-result-topbar{background:#0f0f0e;padding:22px 32px;display:flex;align-items:center;justify-content:space-between}
.sowb-result-label{font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#3a3a38;margin-bottom:5px}
.sowb-result-title{font-size:18px;font-weight:700;color:#fff;letter-spacing:-.025em}
.sowb-topbar-right{display:flex;gap:8px}
.sowb-export-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:rgba(255,255,255,.5);font-family:'Inter',system-ui,sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s}
.sowb-export-btn:hover{background:rgba(255,255,255,.11);border-color:rgba(255,255,255,.22);color:rgba(255,255,255,.9)}
.sowb-export-btn:disabled{opacity:.3;cursor:not-allowed}
.sowb-output{padding:32px 36px;background:#fff;font-size:13.5px;color:#333;line-height:1.9;white-space:pre-wrap;font-family:'Inter',system-ui,sans-serif;max-height:75vh;overflow-y:auto}
@media(max-width:900px){.sowb-hero{padding:36px 24px 32px}.sowb-grid,.sowb-grid2{grid-template-columns:1fr}}
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
  <a href="/" class="sb-back">
    <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
    Back to Main Guide
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
  <div class="sb-section">Generate</div>
  <div class="sb-item" onclick="showPage('generator')">Kickoff Generator</div>
  <div class="sb-item" onclick="showPage('meetingcoach')">Meeting Coach</div>
  <div class="sb-item" onclick="showPage('workbook')">Project Workbook</div>
  <div class="sb-item" onclick="showPage('guide')">Request a Guide</div>
  <div class="sb-item" onclick="showPage('estimator')">Project Estimator</div>
  <div class="sb-item" onclick="showPage('sowbuilder')">SOW Builder</div>
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

<!-- KICKOFF GENERATOR -->
<div class="page" id="page-generator">
  <div class="hero">
    <span class="hq-badge badge-violet">Generate</span>
    <h1>Project Kickoff Generator</h1>
    <p>Enter your client details and let the AI build a personalised implementation brief — timeline, risk register, reading list, questionnaire, and week-one actions — ready to export as a Word document.</p>
  </div>

  <div class="gen-card">
    <h2 class="gen-section-title">Client Details</h2>
    <div class="gen-grid">
      <div class="gen-field">
        <label class="gen-label">Client Name <span class="gen-req">*</span></label>
        <input class="gen-input" id="gen-client" type="text" placeholder="e.g. Acme Corporation">
      </div>
      <div class="gen-field">
        <label class="gen-label">Go-Live Date <span class="gen-req">*</span></label>
        <input class="gen-input" id="gen-golive" type="date">
      </div>
      <div class="gen-field">
        <label class="gen-label">Number of Hiring Processes</label>
        <input class="gen-input" id="gen-processes" type="number" min="1" placeholder="e.g. 8">
      </div>
      <div class="gen-field">
        <label class="gen-label">Countries in Scope</label>
        <input class="gen-input" id="gen-countries" type="text" placeholder="e.g. UK, Germany, France">
      </div>
    </div>
    <div class="gen-field gen-field-full">
      <label class="gen-label">Integrations Required</label>
      <div class="gen-checks">
        <label class="gen-check"><input type="checkbox" value="SAP SuccessFactors"> SAP SuccessFactors</label>
        <label class="gen-check"><input type="checkbox" value="Workday"> Workday</label>
        <label class="gen-check"><input type="checkbox" value="LinkedIn"> LinkedIn</label>
        <label class="gen-check"><input type="checkbox" value="Indeed"> Indeed</label>
        <label class="gen-check"><input type="checkbox" value="DocuSign"> DocuSign</label>
        <label class="gen-check"><input type="checkbox" value="Greenhouse"> Greenhouse</label>
        <label class="gen-check"><input type="checkbox" value="SSO / SAML"> SSO / SAML</label>
        <label class="gen-check"><input type="checkbox" value="Custom API"> Custom API</label>
      </div>
    </div>
    <div class="gen-field gen-field-full">
      <label class="gen-label">Your Experience Level</label>
      <div class="gen-radio-group">
        <label class="gen-radio"><input type="radio" name="gen-exp" value="junior"> Junior (0–1 implementations)</label>
        <label class="gen-radio"><input type="radio" name="gen-exp" value="mid" checked> Mid (2–5 implementations)</label>
        <label class="gen-radio"><input type="radio" name="gen-exp" value="senior"> Senior (6+ implementations)</label>
      </div>
    </div>
    <button class="gen-btn" id="gen-run-btn" onclick="runGenerator()">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Generate Brief
    </button>
  </div>

  <div class="gen-result" id="gen-result" style="display:none">
    <div class="gen-result-header">
      <h2 id="gen-result-title">Implementation Brief</h2>
      <button class="gen-export-btn" id="gen-export-btn" onclick="exportBrief()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export as Word
      </button>
    </div>
    <div id="gen-preview"></div>
  </div>

  <div class="gen-loading" id="gen-loading" style="display:none">
    <div class="gen-spinner"></div>
    <p>Generating your personalised brief — searching 60 SAP documents...</p>
  </div>
</div>

<!-- MEETING COACH -->
<div class="page" id="page-meetingcoach">
  <div class="mc-hero">
    <div class="mc-hero-inner">
      <div class="mc-hero-label">Meeting Coach</div>
      <h1 class="mc-hero-title">Walk in prepared.<br>Every time.</h1>
      <p class="mc-hero-sub">Select the meeting you're about to run. Get a full intelligence briefing drawn from 60 implementation documents — agenda, questions, client objections, red flags, and what success looks like.</p>
    </div>
  </div>

  <div class="mc-form-wrap">
    <div class="mc-form-card">
      <div class="mc-form-row">
        <div class="mc-form-col">
          <label class="mc-label">Meeting Type</label>
          <select class="mc-select" id="mc-meeting">
            <option value="">— Select a meeting —</option>
            <optgroup label="Project Start">
              <option value="Sales Handover">Sales Handover</option>
              <option value="Implementation Kickoff">Implementation Kickoff</option>
              <option value="Discovery Workshop">Discovery Workshop</option>
            </optgroup>
            <optgroup label="Configuration Sessions">
              <option value="Session 1: System Controls, Settings & User Permissions">Session 1 — System Controls, Settings &amp; User Permissions</option>
              <option value="Session 2: Job Creation & Management">Session 2 — Job Creation &amp; Management</option>
              <option value="Session 3: Functional Integrations & Ecosystem">Session 3 — Functional Integrations &amp; Ecosystem</option>
              <option value="Session 4: Career Site & Candidate Application">Session 4 — Career Site &amp; Candidate Application</option>
              <option value="Session 5: Candidate Management Part 1">Session 5 — Candidate Management Part 1</option>
              <option value="Session 6: Candidate Management Part 2">Session 6 — Candidate Management Part 2</option>
              <option value="Session 7: Offer Management & Hiring">Session 7 — Offer Management &amp; Hiring</option>
              <option value="Session 8: Analytics">Session 8 — Analytics</option>
            </optgroup>
            <optgroup label="Testing & Go-Live">
              <option value="UAT Preparation & Kickoff">UAT Preparation &amp; Kickoff</option>
              <option value="UAT Review & Sign-Off">UAT Review &amp; Sign-Off</option>
              <option value="Go-Live Alignment Call">Go-Live Alignment Call</option>
              <option value="Closing Meeting & BAU Handover">Closing Meeting &amp; BAU Handover</option>
            </optgroup>
          </select>
        </div>
        <div class="mc-form-col">
          <label class="mc-label">Context <span class="mc-optional">(optional)</span></label>
          <input class="mc-input" id="mc-context" type="text" placeholder="e.g. 3 integrations, nervous client, 8 weeks to go-live">
        </div>
      </div>
      <button class="mc-run-btn" id="mc-run-btn" onclick="runMeetingCoach()">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Brief Me
      </button>
    </div>
  </div>

  <div class="mc-loading" id="mc-loading" style="display:none">
    <div class="mc-spinner"></div>
    <span>Searching 60 documents&hellip;</span>
  </div>

  <div class="mc-brief" id="mc-brief" style="display:none">
    <div class="mc-brief-topbar">
      <div>
        <div class="mc-brief-label" id="mc-brief-label"></div>
        <div class="mc-brief-title" id="mc-brief-mtitle"></div>
      </div>
      <button class="mc-export-btn" onclick="exportMeetingBrief()">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export Brief
      </button>
    </div>

    <div class="mc-body">
      <div class="mc-two-col">
        <div class="mc-section" id="mc-purpose-wrap">
          <div class="mc-section-label">Meeting Purpose</div>
          <div class="mc-purpose-text" id="mc-purpose"></div>
        </div>
        <div class="mc-section" id="mc-success-wrap">
          <div class="mc-section-label">What Good Looks Like</div>
          <div class="mc-purpose-text" id="mc-success"></div>
        </div>
      </div>

      <div class="mc-section">
        <div class="mc-section-label">Your Agenda &amp; Talking Points</div>
        <div id="mc-agenda"></div>
      </div>

      <div class="mc-two-col">
        <div class="mc-section">
          <div class="mc-section-label">Questions You Must Ask</div>
          <ol class="mc-ol" id="mc-must-ask"></ol>
        </div>
        <div class="mc-section">
          <div class="mc-section-label">Watch For</div>
          <ol class="mc-ol mc-warn-list" id="mc-watch"></ol>
        </div>
      </div>

      <div class="mc-section">
        <div class="mc-section-label">What the Client Will Ask You</div>
        <div id="mc-qa-table"></div>
      </div>

      <div class="mc-two-col">
        <div class="mc-section">
          <div class="mc-section-label">Before the Meeting</div>
          <ol class="mc-ol" id="mc-pre"></ol>
        </div>
        <div class="mc-section">
          <div class="mc-section-label">After the Meeting</div>
          <ol class="mc-ol" id="mc-post"></ol>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- PROJECT WORKBOOK BUILDER -->
<div class="page" id="page-workbook">
  <div class="pw-hero">
    <div class="pw-hero-inner">
      <div class="pw-hero-label">Project Workbook Builder</div>
      <h1 class="pw-hero-title">Your entire project.<br>Step by step.</h1>
      <p class="pw-hero-sub">Generate a complete week-by-week workbook personalised to your engagement. Every process mapped with exact SmartRecruiters navigation, click-level instructions, owner, time estimates, and gotchas.</p>
    </div>
  </div>

  <div class="pw-form-wrap">
    <div class="pw-form-card">
      <div class="pw-form-row">
        <div>
          <label class="pw-label">Client Name</label>
          <input class="pw-input" id="pw-client" type="text" placeholder="e.g. Acme Corporation">
        </div>
        <div>
          <label class="pw-label">Go-Live Date</label>
          <input class="pw-input" id="pw-golive" type="date">
        </div>
        <div>
          <label class="pw-label">Project Length</label>
          <select class="pw-select" id="pw-weeks">
            <option value="8">8 Weeks</option>
            <option value="10">10 Weeks</option>
            <option value="12" selected>12 Weeks</option>
            <option value="16">16 Weeks</option>
          </select>
        </div>
      </div>

      <div class="pw-form-divider">
        <div class="pw-form-divider-line"></div>
        <div class="pw-form-divider-label">Project Context</div>
        <div class="pw-form-divider-line"></div>
      </div>

      <div class="pw-form-row2">
        <div>
          <label class="pw-label">Countries / Regions</label>
          <input class="pw-input" id="pw-countries" type="text" placeholder="e.g. UK, Germany, UAE">
        </div>
        <div>
          <label class="pw-label">Hiring Processes</label>
          <input class="pw-input" id="pw-processes" type="number" min="1" max="50" placeholder="e.g. 5" value="5">
        </div>
        <div>
          <label class="pw-label">Your Experience</label>
          <select class="pw-select" id="pw-experience">
            <option value="new">New to SmartRecruiters</option>
            <option value="some" selected>1&ndash;2 Implementations</option>
            <option value="experienced">Experienced Consultant</option>
          </select>
        </div>
      </div>

      <div class="pw-form-divider">
        <div class="pw-form-divider-line"></div>
        <div class="pw-form-divider-label">Integrations in Scope</div>
        <div class="pw-form-divider-line"></div>
      </div>

      <div class="pw-int-grid" style="margin-bottom:28px">
        <label class="pw-int-check"><input type="checkbox" value="SAP SuccessFactors Employee Central"><span>SAP SuccessFactors EC</span></label>
        <label class="pw-int-check"><input type="checkbox" value="DocuSign e-signature"><span>DocuSign</span></label>
        <label class="pw-int-check"><input type="checkbox" value="LinkedIn Recruiter"><span>LinkedIn Recruiter</span></label>
        <label class="pw-int-check"><input type="checkbox" value="Indeed"><span>Indeed</span></label>
        <label class="pw-int-check"><input type="checkbox" value="SAP HCM"><span>SAP HCM</span></label>
        <label class="pw-int-check"><input type="checkbox" value="Workday HCM"><span>Workday HCM</span></label>
        <label class="pw-int-check"><input type="checkbox" value="Outlook Calendar"><span>Outlook Calendar</span></label>
        <label class="pw-int-check"><input type="checkbox" value="Google Calendar"><span>Google Calendar</span></label>
        <label class="pw-int-check"><input type="checkbox" value="Background Screening"><span>Background Screening</span></label>
      </div>

      <div class="pw-form-divider">
        <div class="pw-form-divider-line"></div>
        <div class="pw-form-divider-label">Process Areas</div>
        <div class="pw-form-divider-line"></div>
      </div>

      <div class="pw-areas-grid" style="margin-bottom:28px">
        <label class="pw-area-check"><input type="checkbox" value="System Controls &amp; User Permissions" checked><span>System Controls &amp; User Permissions</span></label>
        <label class="pw-area-check"><input type="checkbox" value="Job Creation &amp; Management" checked><span>Job Creation &amp; Management</span></label>
        <label class="pw-area-check"><input type="checkbox" value="Functional Integrations" checked><span>Functional Integrations</span></label>
        <label class="pw-area-check"><input type="checkbox" value="Career Site &amp; Candidate Application" checked><span>Career Site &amp; Candidate Application</span></label>
        <label class="pw-area-check"><input type="checkbox" value="Candidate Management" checked><span>Candidate Management</span></label>
        <label class="pw-area-check"><input type="checkbox" value="Offer Management &amp; Hiring" checked><span>Offer Management &amp; Hiring</span></label>
        <label class="pw-area-check"><input type="checkbox" value="Analytics &amp; Reporting" checked><span>Analytics &amp; Reporting</span></label>
        <label class="pw-area-check"><input type="checkbox" value="Training &amp; Enablement" checked><span>Training &amp; Enablement</span></label>
        <label class="pw-area-check"><input type="checkbox" value="UAT &amp; Testing" checked><span>UAT &amp; Testing</span></label>
        <label class="pw-area-check"><input type="checkbox" value="Go-Live &amp; Cutover" checked><span>Go-Live &amp; Cutover</span></label>
        <label class="pw-area-check"><input type="checkbox" value="Hypercare &amp; Handover" checked><span>Hypercare &amp; Handover</span></label>
      </div>

      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <button class="pw-run-btn" id="pw-run-btn" onclick="runWorkbook()">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Build Workbook
        </button>
        <span class="pw-hint" id="pw-hint" style="display:none">This may take 30&ndash;60 seconds&hellip;</span>
      </div>
    </div>
  </div>

  <div class="pw-loading" id="pw-loading" style="display:none">
    <div class="pw-spinner"></div>
    <div>
      <div class="pw-loading-title">Building your workbook&hellip;</div>
      <div class="pw-loading-sub">Personalising every process to your engagement and generating click-level instructions from 60 documents.</div>
    </div>
  </div>

  <div id="pw-result" style="display:none">
    <div class="pw-result-topbar">
      <div>
        <div class="pw-result-label" id="pw-result-label"></div>
        <div class="pw-result-title" id="pw-result-title"></div>
      </div>
      <div class="pw-topbar-right">
        <button class="pw-export-btn" id="pw-export-btn" onclick="exportWorkbook()">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export Workbook
        </button>
      </div>
    </div>
    <div class="pw-stats-bar" id="pw-stats-bar"></div>
    <div class="pw-view-tabs">
      <div class="pw-view-tab active" id="pw-tab-week" onclick="pwSetView('week')">By Week</div>
      <div class="pw-view-tab" id="pw-tab-area" onclick="pwSetView('area')">By Area</div>
    </div>
    <div id="pw-weeks-container" class="pw-weeks-container"></div>
    <div id="pw-area-container" class="pw-by-area" style="display:none"></div>
  </div>
</div>

<!-- REQUEST A GUIDE -->
<div class="page" id="page-guide">
  <div class="rg-hero">
    <div class="rg-hero-inner">
      <div class="rg-hero-label">Knowledge Guide</div>
      <h1 class="rg-hero-title">Tell me where you are.<br>Get exactly what you need.</h1>
      <p class="rg-hero-sub">Describe your situation in plain English &mdash; whether you&rsquo;re about to run a kickoff, stuck on an integration, or need to understand a SmartRecruiters feature. We search all 57 source documents and build you a focused, professional guide.</p>
    </div>
  </div>

  <div class="rg-form-wrap">
    <div class="rg-form-card">
      <label class="rg-label">What do you need to know?</label>
      <div class="rg-examples">
        <span class="rg-example" onclick="rgSetExample(this)">Going into a kickoff tomorrow and have no idea what to expect</span>
        <span class="rg-example" onclick="rgSetExample(this)">Need to connect SmartRecruiters to an onboarding system</span>
        <span class="rg-example" onclick="rgSetExample(this)">At the UAT stage &mdash; what do I need to prepare?</span>
        <span class="rg-example" onclick="rgSetExample(this)">How do I set up a multi-language career site?</span>
        <span class="rg-example" onclick="rgSetExample(this)">My client is asking about GDPR &mdash; what do I configure?</span>
        <span class="rg-example" onclick="rgSetExample(this)">What is a hiring process and how do I build one?</span>
      </div>
      <textarea class="rg-textarea" id="rg-query" placeholder="e.g. I'm going into a kickoff meeting tomorrow and have no idea what to expect or prepare..."></textarea>
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:20px">
        <button class="rg-run-btn" id="rg-run-btn" onclick="runGuide()">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Request Guide
        </button>
        <span class="rg-hint" id="rg-hint" style="display:none">Searching 57 documents&hellip;</span>
      </div>
    </div>
  </div>

  <div class="rg-loading" id="rg-loading" style="display:none">
    <div class="rg-spinner"></div>
    <div>
      <div class="rg-loading-title">Building your guide&hellip;</div>
      <div class="rg-loading-sub">Searching all 57 source documents and compiling everything relevant to your situation.</div>
    </div>
  </div>

  <div id="rg-result" style="display:none">
    <div class="rg-result-wrap">
      <div class="rg-result-topbar">
        <div>
          <div class="rg-result-label">Knowledge Guide</div>
          <div class="rg-result-title" id="rg-result-title"></div>
        </div>
        <button class="rg-export-btn" id="rg-export-btn" onclick="exportGuide()">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export as Word
        </button>
      </div>
      <div class="rg-summary" id="rg-summary"></div>
      <div class="rg-body" id="rg-body"></div>
    </div>
  </div>
</div>

<!-- PROJECT ESTIMATOR -->
<div class="page" id="page-estimator">
  <div class="est-hero">
    <div class="est-hero-inner">
      <div class="est-hero-label">Project Estimator</div>
      <h1 class="est-hero-title">How long will this<br>implementation take?</h1>
      <p class="est-hero-sub">Answer a short set of questions about your engagement. We&rsquo;ll build you a detailed timeline estimate, phase-by-phase breakdown, and risk summary &mdash; based on your actual project inputs and real implementation data.</p>
    </div>
  </div>

  <div class="est-wrap">
    <div class="est-progress-bar"><div class="est-progress-fill" id="est-progress" style="width:25%"></div></div>
    <div class="est-step-count" id="est-step-count">Step 1 of 4</div>

    <!-- STEP 1: The Engagement -->
    <div class="est-step" id="est-s1">
      <div class="est-card">
        <div class="est-section-title">The Engagement</div>
        <div class="est-section-sub">Tell us about the type of implementation and what&rsquo;s included.</div>

        <div class="est-q">
          <span class="est-q-label">What implementation package applies?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="package" id="pkg-standard" value="Standard"><label for="pkg-standard">Standard</label></div>
            <div class="est-pill"><input type="radio" name="package" id="pkg-essentials" value="Essentials Lite"><label for="pkg-essentials">Essentials Lite</label></div>
            <div class="est-pill"><input type="radio" name="package" id="pkg-enterprise" value="Enterprise"><label for="pkg-enterprise">Enterprise</label></div>
            <div class="est-pill"><input type="radio" name="package" id="pkg-unknown" value="Not sure yet"><label for="pkg-unknown">Not sure yet</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">What&rsquo;s in scope?</span>
          <span class="est-q-sub">Select everything that applies</span>
          <div class="est-checkgrid">
            <div class="est-check"><input type="checkbox" id="sc-core" value="Core Recruiting"><label for="sc-core">Core Recruiting</label></div>
            <div class="est-check"><input type="checkbox" id="sc-career" value="Career Site"><label for="sc-career">Career Site</label></div>
            <div class="est-check"><input type="checkbox" id="sc-analytics" value="Analytics"><label for="sc-analytics">Analytics</label></div>
            <div class="est-check"><input type="checkbox" id="sc-crm" value="CRM / Talent Pools"><label for="sc-crm">CRM / Talent Pools</label></div>
            <div class="est-check"><input type="checkbox" id="sc-offer" value="Offer Management"><label for="sc-offer">Offer Management</label></div>
            <div class="est-check"><input type="checkbox" id="sc-multi" value="Multilingual Support"><label for="sc-multi">Multilingual Support</label></div>
            <div class="est-check"><input type="checkbox" id="sc-sso" value="SSO / SCIM"><label for="sc-sso">SSO / SCIM</label></div>
            <div class="est-check"><input type="checkbox" id="sc-mobile" value="Mobile"><label for="sc-mobile">Mobile</label></div>
          </div>
        </div>
      </div>
      <div class="est-btn-row">
        <button class="est-btn-next" onclick="estNext(1)">Continue <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M5 12h14m-7-7 7 7-7 7"/></svg></button>
      </div>
    </div>

    <!-- STEP 2: The Client -->
    <div class="est-step" id="est-s2" style="display:none">
      <div class="est-card">
        <div class="est-section-title">The Client</div>
        <div class="est-section-sub">Understanding the client profile helps set an accurate baseline.</div>

        <div class="est-q">
          <span class="est-q-label">How many employees does the client have?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="empsize" id="emp-tiny" value="Under 100"><label for="emp-tiny">Under 100</label></div>
            <div class="est-pill"><input type="radio" name="empsize" id="emp-small" value="100&ndash;500"><label for="emp-small">100&ndash;500</label></div>
            <div class="est-pill"><input type="radio" name="empsize" id="emp-mid" value="500&ndash;2,000"><label for="emp-mid">500&ndash;2,000</label></div>
            <div class="est-pill"><input type="radio" name="empsize" id="emp-large" value="2,000&ndash;10,000"><label for="emp-large">2,000&ndash;10,000</label></div>
            <div class="est-pill"><input type="radio" name="empsize" id="emp-xlarge" value="10,000+"><label for="emp-xlarge">10,000+</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">How many countries or regions are in scope?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="countries" id="c1" value="1 country"><label for="c1">1</label></div>
            <div class="est-pill"><input type="radio" name="countries" id="c2" value="2&ndash;5 countries"><label for="c2">2&ndash;5</label></div>
            <div class="est-pill"><input type="radio" name="countries" id="c3" value="6&ndash;20 countries"><label for="c3">6&ndash;20</label></div>
            <div class="est-pill"><input type="radio" name="countries" id="c4" value="20+ countries"><label for="c4">20+</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">How many languages need to be supported in SmartRecruiters?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="langs" id="l1" value="1 language (English only)"><label for="l1">1 (English only)</label></div>
            <div class="est-pill"><input type="radio" name="langs" id="l2" value="2&ndash;3 languages"><label for="l2">2&ndash;3</label></div>
            <div class="est-pill"><input type="radio" name="langs" id="l3" value="4+ languages"><label for="l3">4+</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">Is the client replacing an existing ATS?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="replacing" id="rep-yes" value="Yes, replacing an existing ATS"><label for="rep-yes">Yes, replacing an existing system</label></div>
            <div class="est-pill"><input type="radio" name="replacing" id="rep-no" value="No, greenfield implementation"><label for="rep-no">No, greenfield</label></div>
          </div>
        </div>
      </div>
      <div class="est-btn-row">
        <button class="est-btn-back" onclick="estBack(2)"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M19 12H5m7 7-7-7 7-7"/></svg> Back</button>
        <button class="est-btn-next" onclick="estNext(2)">Continue <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M5 12h14m-7-7 7 7-7 7"/></svg></button>
      </div>
    </div>

    <!-- STEP 3: Integrations & Complexity -->
    <div class="est-step" id="est-s3" style="display:none">
      <div class="est-card">
        <div class="est-section-title">Integrations &amp; Complexity</div>
        <div class="est-section-sub">Integrations are one of the biggest drivers of timeline. Be honest here.</div>

        <div class="est-q">
          <span class="est-q-label">Is there a HRIS integration required?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="hris" id="hris-none" value="No HRIS integration"><label for="hris-none">None</label></div>
            <div class="est-pill"><input type="radio" name="hris" id="hris-workday" value="Workday"><label for="hris-workday">Workday</label></div>
            <div class="est-pill"><input type="radio" name="hris" id="hris-sap" value="SAP SuccessFactors"><label for="hris-sap">SAP SuccessFactors</label></div>
            <div class="est-pill"><input type="radio" name="hris" id="hris-oracle" value="Oracle HCM"><label for="hris-oracle">Oracle HCM</label></div>
            <div class="est-pill"><input type="radio" name="hris" id="hris-other" value="Other HRIS"><label for="hris-other">Other HRIS</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">What other integrations are in scope?</span>
          <span class="est-q-sub">Select all that apply</span>
          <div class="est-checkgrid">
            <div class="est-check"><input type="checkbox" id="int-jb" value="Job board integrations"><label for="int-jb">Job Boards</label></div>
            <div class="est-check"><input type="checkbox" id="int-li" value="LinkedIn integration"><label for="int-li">LinkedIn</label></div>
            <div class="est-check"><input type="checkbox" id="int-onboard" value="Onboarding system integration"><label for="int-onboard">Onboarding System</label></div>
            <div class="est-check"><input type="checkbox" id="int-bg" value="Background check integration"><label for="int-bg">Background Check</label></div>
            <div class="est-check"><input type="checkbox" id="int-assess" value="Assessment / testing integration"><label for="int-assess">Assessments</label></div>
            <div class="est-check"><input type="checkbox" id="int-gdpr" value="GDPR / consent management tool"><label for="int-gdpr">GDPR Tool</label></div>
            <div class="est-check"><input type="checkbox" id="int-custom" value="Custom / bespoke integration"><label for="int-custom">Custom Integration</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">How complex is the career site build?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="csite" id="cs-std" value="Standard template, minimal changes"><label for="cs-std">Standard template</label></div>
            <div class="est-pill"><input type="radio" name="csite" id="cs-light" value="Light customisation required"><label for="cs-light">Light customisation</label></div>
            <div class="est-pill"><input type="radio" name="csite" id="cs-full" value="Full custom build required"><label for="cs-full">Full custom build</label></div>
            <div class="est-pill"><input type="radio" name="csite" id="cs-na" value="Career site not in scope"><label for="cs-na">Not in scope</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">How much custom configuration is expected?</span>
          <span class="est-q-sub">Custom fields, hiring process complexity, approval chains, email templates etc.</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="config" id="cfg-min" value="Minimal — mostly out-of-the-box"><label for="cfg-min">Minimal</label></div>
            <div class="est-pill"><input type="radio" name="config" id="cfg-mod" value="Moderate — some custom fields and workflows"><label for="cfg-mod">Moderate</label></div>
            <div class="est-pill"><input type="radio" name="config" id="cfg-heavy" value="Heavy — extensive custom setup"><label for="cfg-heavy">Heavy</label></div>
          </div>
        </div>
      </div>
      <div class="est-btn-row">
        <button class="est-btn-back" onclick="estBack(3)"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M19 12H5m7 7-7-7 7-7"/></svg> Back</button>
        <button class="est-btn-next" onclick="estNext(3)">Continue <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M5 12h14m-7-7 7 7-7 7"/></svg></button>
      </div>
    </div>

    <!-- STEP 4: Delivery & Readiness -->
    <div class="est-step" id="est-s4" style="display:none">
      <div class="est-card">
        <div class="est-section-title">Delivery &amp; Readiness</div>
        <div class="est-section-sub">The client&rsquo;s own availability and constraints often matter more than the technical scope.</div>

        <div class="est-q">
          <span class="est-q-label">What&rsquo;s the go-live approach?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="golive" id="gl-bang" value="Big bang — all at once"><label for="gl-bang">Big bang &mdash; all at once</label></div>
            <div class="est-pill"><input type="radio" name="golive" id="gl-phase" value="Phased — by region or country"><label for="gl-phase">Phased by region / country</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">How available is the client&rsquo;s project team?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="avail" id="av-low" value="Limited — client team is part-time on this project"><label for="av-low">Limited (part-time)</label></div>
            <div class="est-pill"><input type="radio" name="avail" id="av-mod" value="Moderate — mostly available when needed"><label for="av-mod">Moderate</label></div>
            <div class="est-pill"><input type="radio" name="avail" id="av-high" value="Dedicated — full-time project team on the client side"><label for="av-high">Dedicated team</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">Is there a data migration from an existing system?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="migration" id="mg-yes" value="Yes, data migration required"><label for="mg-yes">Yes</label></div>
            <div class="est-pill"><input type="radio" name="migration" id="mg-no" value="No data migration"><label for="mg-no">No</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">Is there a hard go-live date constraint?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="deadline" id="dl-yes" value="Yes, fixed go-live date"><label for="dl-yes">Yes, fixed date</label></div>
            <div class="est-pill"><input type="radio" name="deadline" id="dl-no" value="Flexible timeline"><label for="dl-no">Flexible</label></div>
          </div>
        </div>

        <div class="est-divider"></div>

        <div class="est-q">
          <span class="est-q-label">What is your team&rsquo;s experience with SmartRecruiters implementations?</span>
          <div class="est-pills">
            <div class="est-pill"><input type="radio" name="experience" id="exp-none" value="No prior SmartRecruiters experience"><label for="exp-none">First time</label></div>
            <div class="est-pill"><input type="radio" name="experience" id="exp-some" value="Some exposure to SmartRecruiters"><label for="exp-some">Some exposure</label></div>
            <div class="est-pill"><input type="radio" name="experience" id="exp-exp" value="Experienced with SmartRecruiters implementations"><label for="exp-exp">Experienced</label></div>
          </div>
        </div>
      </div>
      <div class="est-btn-row">
        <button class="est-btn-back" onclick="estBack(4)"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M19 12H5m7 7-7-7 7-7"/></svg> Back</button>
        <button class="est-btn-next" id="est-submit-btn" onclick="estSubmit()">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Generate Estimate
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div class="est-loading" id="est-loading">
      <div class="est-spinner"></div>
      <div>
        <div class="est-loading-title">Building your estimate&hellip;</div>
        <div class="est-loading-sub">Analysing your inputs against real implementation data from 52 source documents.</div>
      </div>
    </div>

    <!-- Result -->
    <div class="est-result" id="est-result">
      <div class="est-result-wrap">
        <div class="est-result-topbar">
          <div>
            <div class="est-result-label">Project Estimate</div>
            <div class="est-result-headline" id="est-headline"></div>
            <div class="est-result-sub" id="est-sub"></div>
          </div>
          <button class="est-result-export" id="est-export-btn" onclick="exportEstimate()">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export as Word
          </button>
        </div>
        <div class="est-stats-row">
          <div class="est-stat">
            <div class="est-stat-label">Total Timeline</div>
            <div class="est-stat-value" id="est-stat-weeks"></div>
            <div class="est-stat-unit">weeks</div>
          </div>
          <div class="est-stat">
            <div class="est-stat-label">Consultant Days</div>
            <div class="est-stat-value" id="est-stat-cdays"></div>
            <div class="est-stat-unit">estimated effort</div>
          </div>
          <div class="est-stat">
            <div class="est-stat-label">Estimate Confidence</div>
            <div class="est-stat-value" style="font-size:15px;margin-top:6px" id="est-stat-conf"></div>
          </div>
        </div>
        <div class="est-timeline-section">
          <div class="est-sec-label">Phase Breakdown</div>
          <div class="est-phases" id="est-phases"></div>
        </div>
        <div class="est-body-section" id="est-narrative-wrap">
          <div class="est-sec-label">Assessment</div>
          <div class="est-body-text" id="est-narrative"></div>
        </div>
        <div class="est-body-section" id="est-risks-wrap">
          <div class="est-sec-label">Key Risks</div>
          <div id="est-risks"></div>
        </div>
        <div class="est-body-section" id="est-assume-wrap">
          <div class="est-sec-label">Assumptions</div>
          <div id="est-assumptions"></div>
        </div>
      </div>
      <button class="est-reset-btn" onclick="estReset()">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        Start New Estimate
      </button>
    </div>
  </div>
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
    label.style.background = phase.color;
    label.style.color = '#fff';
    group.appendChild(label);
    const stepsRow = document.createElement('div');
    stepsRow.className = 'tl-steps';
    stepsRow.style.background = '#f8f7f4';
    stepsRow.style.borderColor = '#e4e2dc';
    phase.steps.forEach(step => {
      const el = document.createElement('div');
      el.className = 'tl-step';
      el.style.background = '#fff';
      el.style.borderColor = '#e4e2dc';
      el.style.borderTop = '3px solid ' + phase.color;
      el.innerHTML = '<div class="tl-step-title" style="color:#0f0f0e">' + step.title + '</div>';
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

// ── Kickoff Generator ──────────────────────────────────────────────
var genBriefData = null;
function runGenerator() {
  var client = document.getElementById('gen-client').value.trim();
  var golive = document.getElementById('gen-golive').value;
  if(!client || !golive){
    alert('Please enter a client name and go-live date.');
    return;
  }
  var processes = document.getElementById('gen-processes').value || 'not specified';
  var countries = document.getElementById('gen-countries').value.trim() || 'not specified';
  var integrations = [];
  document.querySelectorAll('.gen-checks input:checked').forEach(function(el){ integrations.push(el.value); });
  var expEl = document.querySelector('input[name="gen-exp"]:checked');
  var experience = expEl ? expEl.value : 'mid';

  document.getElementById('gen-result').style.display = 'none';
  document.getElementById('gen-loading').style.display = 'flex';
  document.getElementById('gen-run-btn').disabled = true;

  fetch('/consultant/implementation-hq/generate-brief', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ client, golive, processes, countries, integrations, experience })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    genBriefData = data;
    document.getElementById('gen-loading').style.display = 'none';
    document.getElementById('gen-result').style.display = 'block';
    document.getElementById('gen-result-title').textContent = client + ' — Implementation Brief';
    renderBrief(data);
    document.getElementById('gen-result').scrollIntoView({ behavior:'smooth', block:'start' });
  })
  .catch(function(){
    document.getElementById('gen-loading').style.display = 'none';
    alert('Failed to generate brief. Please try again.');
  })
  .finally(function(){
    document.getElementById('gen-run-btn').disabled = false;
  });
}

function renderBrief(d){
  var html = '';

  html += '<div class="gen-section"><div class="gen-section-h">Project Overview</div>';
  html += '<table class="gen-table"><tbody>';
  html += '<tr><td width="200"><strong>Client</strong></td><td>' + esc(d.overview.client) + '</td></tr>';
  html += '<tr><td><strong>Go-Live Date</strong></td><td>' + esc(d.overview.golive) + '</td></tr>';
  html += '<tr><td><strong>Countries in Scope</strong></td><td>' + esc(d.overview.countries) + '</td></tr>';
  html += '<tr><td><strong>Hiring Processes</strong></td><td>' + esc(d.overview.processes) + '</td></tr>';
  html += '<tr><td><strong>Integrations</strong></td><td>' + esc(d.overview.integrations) + '</td></tr>';
  html += '<tr><td><strong>Consultant Level</strong></td><td>' + esc(d.overview.experience) + '</td></tr>';
  html += '</tbody></table></div>';

  html += '<div class="gen-section"><div class="gen-section-h">Implementation Timeline</div>';
  html += '<table class="gen-table"><thead><tr><th>Milestone</th><th>Target Date</th><th>Notes</th></tr></thead><tbody>';
  d.timeline.forEach(function(row){
    html += '<tr><td>' + esc(row.milestone) + '</td><td>' + esc(row.date) + '</td><td>' + esc(row.notes) + '</td></tr>';
  });
  html += '</tbody></table></div>';

  html += '<div class="gen-section"><div class="gen-section-h">Risk Register</div>';
  html += '<table class="gen-table"><thead><tr><th>Risk</th><th>Severity</th><th>Mitigation</th></tr></thead><tbody>';
  d.risks.forEach(function(row){
    var cls = row.severity === 'High' ? 'risk-high' : row.severity === 'Medium' ? 'risk-med' : 'risk-low';
    html += '<tr><td>' + esc(row.risk) + '</td><td class="' + cls + '">' + esc(row.severity) + '</td><td>' + esc(row.mitigation) + '</td></tr>';
  });
  html += '</tbody></table></div>';

  html += '<div class="gen-section"><div class="gen-section-h">Recommended Reading List</div>';
  html += '<ol class="gen-ol">';
  d.reading.forEach(function(item){ html += '<li>' + esc(item) + '</li>'; });
  html += '</ol></div>';

  html += '<div class="gen-section"><div class="gen-section-h">Client Discovery Questionnaire</div>';
  html += '<ol class="gen-ol">';
  d.questionnaire.forEach(function(item){ html += '<li>' + esc(item) + '</li>'; });
  html += '</ol></div>';

  html += '<div class="gen-section"><div class="gen-section-h">Week 1 Consultant Actions</div>';
  html += '<ol class="gen-ol">';
  d.actions.forEach(function(item){ html += '<li>' + esc(item) + '</li>'; });
  html += '</ol></div>';

  document.getElementById('gen-preview').innerHTML = html;
}

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Meeting Coach ──────────────────────────────────────────────────
var mcBriefData = null;
function runMeetingCoach() {
  var meeting = document.getElementById('mc-meeting').value;
  if(!meeting){ alert('Please select a meeting type.'); return; }
  var context = document.getElementById('mc-context').value.trim();

  document.getElementById('mc-brief').style.display = 'none';
  var loadEl = document.getElementById('mc-loading');
  loadEl.style.display = 'flex';
  document.getElementById('mc-run-btn').disabled = true;

  fetch('/consultant/implementation-hq/meeting-brief', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ meeting, context })
  })
  .then(function(r){ if(!r.ok) throw new Error('failed'); return r.json(); })
  .then(function(data){
    mcBriefData = data;
    loadEl.style.display = 'none';
    renderMeetingBrief(data);
    document.getElementById('mc-brief').style.display = 'block';
    document.getElementById('mc-brief').scrollIntoView({ behavior:'smooth', block:'start' });
  })
  .catch(function(){ loadEl.style.display = 'none'; alert('Failed to generate brief. Please try again.'); })
  .finally(function(){ document.getElementById('mc-run-btn').disabled = false; });
}

function renderMeetingBrief(d) {
  document.getElementById('mc-brief-label').textContent = 'Meeting Brief';
  document.getElementById('mc-brief-mtitle').textContent = d.meeting;

  document.getElementById('mc-purpose').textContent = d.purpose || '';
  document.getElementById('mc-success').textContent = d.success || '';

  var agendaEl = document.getElementById('mc-agenda');
  agendaEl.innerHTML = '';
  (d.agenda || []).forEach(function(item) {
    var div = document.createElement('div');
    div.className = 'mc-agenda-item';
    div.innerHTML = '<div class="mc-agenda-item-title">' + esc(item.item) + '</div>' +
      (item.notes ? '<div class="mc-agenda-item-notes">' + esc(item.notes) + '</div>' : '');
    agendaEl.appendChild(div);
  });

  var askEl = document.getElementById('mc-must-ask');
  askEl.innerHTML = '';
  (d.mustAsk || []).forEach(function(q) {
    var li = document.createElement('li');
    li.textContent = q;
    askEl.appendChild(li);
  });

  var watchEl = document.getElementById('mc-watch');
  watchEl.innerHTML = '';
  (d.watchFor || []).forEach(function(w) {
    var li = document.createElement('li');
    li.textContent = w;
    watchEl.appendChild(li);
  });

  var qaEl = document.getElementById('mc-qa-table');
  if(d.clientWillAsk && d.clientWillAsk.length) {
    var tbl = '<table class="mc-qa-table"><thead><tr><th width="40%">They will ask</th><th>Your answer</th></tr></thead><tbody>';
    d.clientWillAsk.forEach(function(qa) {
      tbl += '<tr><td class="mc-qa-q">' + esc(qa.question) + '</td><td>' + esc(qa.answer) + '</td></tr>';
    });
    tbl += '</tbody></table>';
    qaEl.innerHTML = tbl;
  } else { qaEl.innerHTML = ''; }

  var preEl = document.getElementById('mc-pre');
  preEl.innerHTML = '';
  (d.preMeeting || []).forEach(function(item) {
    var li = document.createElement('li'); li.textContent = item; preEl.appendChild(li);
  });

  var postEl = document.getElementById('mc-post');
  postEl.innerHTML = '';
  (d.followUp || []).forEach(function(item) {
    var li = document.createElement('li'); li.textContent = item; postEl.appendChild(li);
  });
}

function exportMeetingBrief() {
  if(!mcBriefData){ alert('Generate a brief first.'); return; }
  var btn = document.querySelector('.mc-export-btn');
  btn.disabled = true;
  fetch('/consultant/implementation-hq/export-meeting-brief', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(mcBriefData)
  })
  .then(function(r){ if(!r.ok) throw new Error('failed'); return r.blob(); })
  .then(function(blob){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (mcBriefData.meeting||'Meeting').replace(/[^a-z0-9]/gi,'_') + '_Brief.docx';
    a.click();
    URL.revokeObjectURL(url);
  })
  .catch(function(){ alert('Export failed. Please try again.'); })
  .finally(function(){ btn.disabled = false; });
}

function exportBrief(){
  if(!genBriefData){ alert('Generate a brief first.'); return; }
  document.getElementById('gen-export-btn').disabled = true;
  fetch('/consultant/implementation-hq/export-brief', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(genBriefData)
  })
  .then(function(r){
    if(!r.ok) throw new Error('export failed');
    return r.blob();
  })
  .then(function(blob){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (genBriefData.overview.client || 'client').replace(/[^a-z0-9]/gi,'_') + '_Kickoff_Brief.docx';
    a.click();
    URL.revokeObjectURL(url);
  })
  .catch(function(){ alert('Export failed. Please try again.'); })
  .finally(function(){ document.getElementById('gen-export-btn').disabled = false; });
}

// ── Project Workbook Builder ────────────────────────────────────
var pwWorkbookData = null;
var pwAllOpen = false;

var PW_AREA_COLORS = {
  'System Controls & User Permissions': '#6366f1',
  'Job Creation & Management': '#0891b2',
  'Functional Integrations': '#7c3aed',
  'Career Site & Candidate Application': '#db2777',
  'Candidate Management': '#d97706',
  'Offer Management & Hiring': '#16a34a',
  'Analytics & Reporting': '#ea580c',
  'Training & Enablement': '#0284c7',
  'UAT & Testing': '#dc2626',
  'Go-Live & Cutover': '#0f0f0e',
  'Hypercare & Handover': '#71717a'
};

function pwAreaColor(area) {
  return PW_AREA_COLORS[area] || '#0f0f0e';
}

function runWorkbook() {
  var client = document.getElementById('pw-client').value.trim();
  var golive = document.getElementById('pw-golive').value;
  var weeks = document.getElementById('pw-weeks').value;
  var countries = document.getElementById('pw-countries').value.trim();
  var processes = document.getElementById('pw-processes').value.trim();
  var experience = document.getElementById('pw-experience').value;
  if(!client){ alert('Please enter a client name.'); return; }
  if(!golive){ alert('Please select a go-live date.'); return; }

  var areas = [];
  document.querySelectorAll('#page-workbook .pw-area-check input:checked').forEach(function(cb){ areas.push(cb.value); });
  if(!areas.length){ alert('Select at least one process area.'); return; }

  var integrations = [];
  document.querySelectorAll('#page-workbook .pw-int-check input:checked').forEach(function(cb){ integrations.push(cb.value); });

  document.getElementById('pw-result').style.display = 'none';
  var loadEl = document.getElementById('pw-loading');
  loadEl.style.display = 'flex';
  document.getElementById('pw-run-btn').disabled = true;
  document.getElementById('pw-hint').style.display = 'inline';

  fetch('/consultant/implementation-hq/generate-workbook', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ client:client, golive:golive, weeks:weeks, areas:areas, integrations:integrations, countries:countries, processes:processes, experience:experience })
  })
  .then(function(r){ if(!r.ok) throw new Error('failed'); return r.json(); })
  .then(function(data){
    pwWorkbookData = data;
    loadEl.style.display = 'none';
    document.getElementById('pw-hint').style.display = 'none';
    renderWorkbook(data);
    document.getElementById('pw-result').style.display = 'block';
    document.getElementById('pw-result').scrollIntoView({ behavior:'smooth', block:'start' });
  })
  .catch(function(){ loadEl.style.display = 'none'; document.getElementById('pw-hint').style.display = 'none'; alert('Failed to build workbook. Please try again.'); })
  .finally(function(){ document.getElementById('pw-run-btn').disabled = false; });
}

function pwProcCard(proc) {
  var color = pwAreaColor(proc.area || '');
  var ownerClass = proc.owner === 'Client' ? 'pw-owner-client' : proc.owner === 'Both' ? 'pw-owner-both' : 'pw-owner-ex3';
  var ownerLabel = proc.owner || 'EX3';

  var navHtml = '';
  if(proc.navPath) {
    var parts = proc.navPath.split(/\s*(?:→|->|>)\s*/);
    if(parts.length > 1) {
      navHtml = '<div class="pw-process-nav">' + parts.map(function(p,i){ return (i>0?'<svg class="pw-nav-arrow" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>':'')+'<span>'+esc(p.trim())+'</span>'; }).join('') + '</div>';
    } else {
      navHtml = '<div class="pw-process-nav">' + esc(proc.navPath) + '</div>';
    }
  }

  var html = '<div class="pw-process" style="border-left-color:' + color + '">';
  html += '<div class="pw-process-header">' +
    '<div class="pw-process-title-block">' +
    '<span class="pw-process-area-badge" style="background:' + color + '12;color:' + color + '">' + esc(proc.area || '') + '</span>' +
    '<div class="pw-process-title">' + esc(proc.title || '') + '</div>' +
    navHtml +
    '</div>' +
    '<div class="pw-process-badges">' +
    '<span class="pw-owner ' + ownerClass + '">' + esc(ownerLabel) + '</span>' +
    (proc.duration ? '<span class="pw-duration"><svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' + esc(proc.duration) + '</span>' : '') +
    '</div></div>';

  if(proc.depends && proc.depends !== 'null' && proc.depends !== null) {
    html += '<div class="pw-depends"><span class="pw-depends-label">Depends on</span>' + esc(String(proc.depends)) + '</div>';
  }

  if((proc.steps || []).length) {
    html += '<ol class="pw-steps">';
    proc.steps.forEach(function(step){ html += '<li>' + esc(step) + '</li>'; });
    html += '</ol>';
  }

  if(proc.output) {
    html += '<div class="pw-output"><span class="pw-output-badge">Output</span>' + esc(proc.output) + '</div>';
  }
  if(proc.gotcha && proc.gotcha !== 'null' && proc.gotcha !== null) {
    html += '<div class="pw-gotcha"><span class="pw-gotcha-icon">⚠</span>' + esc(String(proc.gotcha)) + '</div>';
  }
  html += '</div>';
  return html;
}

function renderWorkbook(d) {
  var totalProcs = 0;
  var totalHours = 0;
  (d.weeks || []).forEach(function(w){
    totalProcs += (w.processes || []).length;
    (w.processes || []).forEach(function(p){
      if(p.duration){ var m = String(p.duration).match(/(\d+)/); if(m) totalHours += parseInt(m[1], 10); }
    });
  });

  document.getElementById('pw-result-label').textContent = 'Project Workbook';
  document.getElementById('pw-result-title').textContent = (d.client || '') + '  —  ' + (d.totalWeeks || '') + '-Week Implementation';

  var sb = document.getElementById('pw-stats-bar');
  sb.innerHTML =
    '<div class="pw-stat"><div class="pw-stat-num">' + (d.totalWeeks||'') + '</div><div class="pw-stat-label">Weeks</div></div>' +
    '<div class="pw-stat"><div class="pw-stat-num">' + totalProcs + '</div><div class="pw-stat-label">Processes</div></div>' +
    (totalHours > 0 ? '<div class="pw-stat"><div class="pw-stat-num">' + totalHours + 'h+</div><div class="pw-stat-label">Est. Hours</div></div>' : '') +
    '<div class="pw-stat"><div class="pw-stat-num">' + esc(d.golive || '') + '</div><div class="pw-stat-label">Go-Live</div></div>';

  renderByWeek(d);
  renderByArea(d);
  pwSetView('week');
  pwAllOpen = false;
}

function renderByWeek(d) {
  var c = document.getElementById('pw-weeks-container');
  c.innerHTML = '<div class="pw-container-toolbar"><button class="pw-toggle-all-btn" id="pw-expand-all" onclick="pwExpandAll()">Expand All</button></div>';

  (d.weeks || []).forEach(function(week, wi) {
    var procs = week.processes || [];
    var wHrs = 0;
    procs.forEach(function(p){ if(p.duration){ var m = String(p.duration).match(/(\d+)/); if(m) wHrs += parseInt(m[1],10); }});

    var weekDiv = document.createElement('div');
    weekDiv.className = 'pw-week';

    var headerHtml = '<div class="pw-week-header" id="pw-wh-' + wi + '" onclick="pwToggleWeek(' + wi + ')">' +
      '<div class="pw-week-left">' +
      '<div class="pw-week-num">Week ' + week.num + '</div>' +
      '<div><div class="pw-week-theme">' + esc(week.theme || '') + '</div>' +
      (week.focus ? '<div class="pw-week-focus">' + esc(week.focus) + '</div>' : '') +
      (week.milestone ? '<div class="pw-week-milestone">✓ ' + esc(week.milestone) + '</div>' : '') +
      '</div></div>' +
      '<div class="pw-week-meta">' +
      (wHrs > 0 ? '<span class="pw-week-hours">~' + wHrs + 'h</span>' : '') +
      '<span class="pw-week-count">' + procs.length + ' task' + (procs.length !== 1 ? 's' : '') + '</span>' +
      '<svg class="pw-week-chevron" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>' +
      '</div></div>';

    var bodyHtml = '<div class="pw-week-body" id="pw-wb-' + wi + '">';
    procs.forEach(function(proc){ bodyHtml += pwProcCard(proc); });
    bodyHtml += '</div>';

    weekDiv.innerHTML = headerHtml + bodyHtml;
    c.appendChild(weekDiv);

    if(wi === 0) {
      var fh = weekDiv.querySelector('.pw-week-header');
      var fb = weekDiv.querySelector('.pw-week-body');
      if(fh) fh.classList.add('open');
      if(fb) fb.classList.add('open');
    }
  });
}

function renderByArea(d) {
  var areaMap = {};
  var areaOrder = [];
  (d.weeks || []).forEach(function(week) {
    (week.processes || []).forEach(function(proc) {
      var area = proc.area || 'Other';
      if(!areaMap[area]){ areaMap[area] = []; areaOrder.push(area); }
      areaMap[area].push({ proc:proc, weekNum:week.num, weekTheme:week.theme || '' });
    });
  });

  var c = document.getElementById('pw-area-container');
  c.innerHTML = '';

  areaOrder.forEach(function(area, ai) {
    var items = areaMap[area];
    var color = pwAreaColor(area);
    var sectionDiv = document.createElement('div');
    sectionDiv.className = 'pw-area-section';

    var headerHtml = '<div class="pw-area-section-header" id="pw-ah-' + ai + '" onclick="pwToggleArea(' + ai + ')" style="border-left-color:' + color + '">' +
      '<div class="pw-area-section-left">' +
      '<div class="pw-area-section-title" style="color:' + color + '">' + esc(area) + '</div>' +
      '<div class="pw-area-section-count">' + items.length + ' task' + (items.length !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '<svg class="pw-area-chevron" id="pw-ach-' + ai + '" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>' +
      '</div>';

    var bodyHtml = '<div class="pw-area-section-body" id="pw-ab-' + ai + '">';
    items.forEach(function(item) {
      bodyHtml += '<div class="pw-area-proc-item">';
      bodyHtml += '<div class="pw-area-week-badge" style="background:' + color + '18;color:' + color + '">Week ' + item.weekNum + ' — ' + esc(item.weekTheme) + '</div>';
      bodyHtml += pwProcCard(item.proc);
      bodyHtml += '</div>';
    });
    bodyHtml += '</div>';

    sectionDiv.innerHTML = headerHtml + bodyHtml;
    c.appendChild(sectionDiv);
  });
}

function pwSetView(view) {
  document.getElementById('pw-tab-week').className = 'pw-view-tab' + (view === 'week' ? ' active' : '');
  document.getElementById('pw-tab-area').className = 'pw-view-tab' + (view === 'area' ? ' active' : '');
  document.getElementById('pw-weeks-container').style.display = view === 'week' ? 'block' : 'none';
  document.getElementById('pw-area-container').style.display = view === 'area' ? 'block' : 'none';
}

function pwToggleWeek(wi) {
  var h = document.getElementById('pw-wh-' + wi);
  var b = document.getElementById('pw-wb-' + wi);
  if(!h || !b) return;
  if(h.classList.contains('open')){ h.classList.remove('open'); b.classList.remove('open'); }
  else { h.classList.add('open'); b.classList.add('open'); }
}

function pwToggleArea(ai) {
  var h = document.getElementById('pw-ah-' + ai);
  var b = document.getElementById('pw-ab-' + ai);
  var ch = document.getElementById('pw-ach-' + ai);
  if(!h || !b) return;
  if(b.classList.contains('open')){ b.classList.remove('open'); h.classList.remove('open'); if(ch) ch.style.transform=''; }
  else { b.classList.add('open'); h.classList.add('open'); if(ch) ch.style.transform='rotate(180deg)'; }
}

function pwExpandAll() {
  pwAllOpen = !pwAllOpen;
  document.getElementById('pw-expand-all').textContent = pwAllOpen ? 'Collapse All' : 'Expand All';
  document.querySelectorAll('#pw-weeks-container .pw-week-header').forEach(function(h){ pwAllOpen ? h.classList.add('open') : h.classList.remove('open'); });
  document.querySelectorAll('#pw-weeks-container .pw-week-body').forEach(function(b){ pwAllOpen ? b.classList.add('open') : b.classList.remove('open'); });
}

function exportWorkbook() {
  if(!pwWorkbookData){ alert('Generate a workbook first.'); return; }
  var btn = document.getElementById('pw-export-btn');
  btn.disabled = true;
  fetch('/consultant/implementation-hq/export-workbook', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(pwWorkbookData)
  })
  .then(function(r){ if(!r.ok) throw new Error('failed'); return r.blob(); })
  .then(function(blob){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (pwWorkbookData.client || 'Client').replace(/[^a-z0-9]/gi,'_') + '_Project_Workbook.docx';
    a.click();
    URL.revokeObjectURL(url);
  })
  .catch(function(){ alert('Export failed. Please try again.'); })
  .finally(function(){ btn.disabled = false; });
}

// ── Request a Guide ──────────────────────────────────────────────
var rgGuideData = null;

function rgSetExample(el) {
  document.getElementById('rg-query').value = el.textContent.trim();
  document.getElementById('rg-query').focus();
}

function runGuide() {
  var query = document.getElementById('rg-query').value.trim();
  if(!query){ alert('Please describe your situation or what you need to know.'); return; }

  document.getElementById('rg-result').style.display = 'none';
  var loadEl = document.getElementById('rg-loading');
  loadEl.style.display = 'flex';
  document.getElementById('rg-run-btn').disabled = true;
  document.getElementById('rg-hint').style.display = 'inline';

  fetch('/consultant/implementation-hq/request-guide', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ query: query })
  })
  .then(function(r){ if(!r.ok) throw new Error('failed'); return r.json(); })
  .then(function(data){
    rgGuideData = data;
    loadEl.style.display = 'none';
    document.getElementById('rg-hint').style.display = 'none';
    renderGuide(data);
    document.getElementById('rg-result').style.display = 'block';
    document.getElementById('rg-result').scrollIntoView({ behavior:'smooth', block:'start' });
  })
  .catch(function(){
    loadEl.style.display = 'none';
    document.getElementById('rg-hint').style.display = 'none';
    alert('Failed to generate guide. Please try again.');
  })
  .finally(function(){ document.getElementById('rg-run-btn').disabled = false; });
}

function renderGuide(d) {
  document.getElementById('rg-result-title').textContent = d.title || 'Knowledge Guide';
  document.getElementById('rg-summary').textContent = d.summary || '';

  var body = document.getElementById('rg-body');
  body.innerHTML = '';

  (d.sections || []).forEach(function(sec) {
    var div = document.createElement('div');
    div.className = 'rg-section';
    div.innerHTML = '<div class="rg-section-heading">' + esc(sec.heading) + '</div>' +
      '<div class="rg-section-body">' + esc(sec.content) + '</div>';
    body.appendChild(div);
  });

  if((d.steps || []).length) {
    var div = document.createElement('div');
    div.className = 'rg-section';
    var html = '<div class="rg-section-heading">Key Steps</div><ol class="rg-steps-list">';
    d.steps.forEach(function(s){ html += '<li>' + esc(s) + '</li>'; });
    html += '</ol>';
    div.innerHTML = html;
    body.appendChild(div);
  }

  if((d.watchOut || []).length) {
    var div = document.createElement('div');
    div.className = 'rg-section';
    var html = '<div class="rg-section-heading">Watch Out For</div>';
    d.watchOut.forEach(function(w){
      html += '<div class="rg-watch-item"><span class="rg-watch-icon">&#9888;</span>' + esc(w) + '</div>';
    });
    div.innerHTML = html;
    body.appendChild(div);
  }

  if((d.whoDoesWhat || []).length) {
    var div = document.createElement('div');
    div.className = 'rg-section';
    var html = '<div class="rg-section-heading">Who Does What</div>';
    d.whoDoesWhat.forEach(function(r){
      var rc = r.role === 'Client' ? 'rg-role-client' : r.role === 'Both' ? 'rg-role-both' : 'rg-role-ex3';
      html += '<div class="rg-raci-row"><span class="rg-raci-role ' + rc + '">' + esc(r.role) + '</span><span class="rg-raci-task">' + esc(r.task) + '</span></div>';
    });
    div.innerHTML = html;
    body.appendChild(div);
  }

  if((d.keyDocs || []).length) {
    var div = document.createElement('div');
    div.className = 'rg-section';
    var html = '<div class="rg-section-heading">Key Documents</div><div class="rg-docs-list">';
    d.keyDocs.forEach(function(doc){ html += '<div class="rg-doc-item">' + esc(doc) + '</div>'; });
    html += '</div>';
    div.innerHTML = html;
    body.appendChild(div);
  }
}

function exportGuide() {
  if(!rgGuideData){ alert('Generate a guide first.'); return; }
  var btn = document.getElementById('rg-export-btn');
  btn.disabled = true;
  fetch('/consultant/implementation-hq/export-guide', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(rgGuideData)
  })
  .then(function(r){ if(!r.ok) throw new Error('failed'); return r.blob(); })
  .then(function(blob){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (rgGuideData.title || 'Knowledge_Guide').replace(/[^a-z0-9]/gi,'_') + '.docx';
    a.click();
    URL.revokeObjectURL(url);
  })
  .catch(function(){ alert('Export failed. Please try again.'); })
  .finally(function(){ btn.disabled = false; });
}

// ── Project Estimator ───────────────────────────────────────────
var estCurrentStep = 1;
var estData = null;

function estGetVal(name) {
  var el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : '';
}
function estGetChecks(selector) {
  var vals = [];
  document.querySelectorAll(selector + ':checked').forEach(function(el){ vals.push(el.value); });
  return vals;
}
function estSetProgress(step) {
  document.getElementById('est-progress').style.width = (step / 4 * 100) + '%';
  document.getElementById('est-step-count').textContent = 'Step ' + step + ' of 4';
}
function estShowStep(n) {
  for(var i = 1; i <= 4; i++) {
    var el = document.getElementById('est-s' + i);
    if(el) el.style.display = (i === n) ? '' : 'none';
  }
  estCurrentStep = n;
  estSetProgress(n);
  window.scrollTo(0, 0);
}
function estNext(from) {
  if(from === 1) {
    if(!estGetVal('package')){ alert('Please select an implementation package.'); return; }
    estShowStep(2);
  } else if(from === 2) {
    if(!estGetVal('empsize')){ alert('Please select an employee count.'); return; }
    if(!estGetVal('countries')){ alert('Please select the number of countries.'); return; }
    if(!estGetVal('langs')){ alert('Please select the number of languages.'); return; }
    if(!estGetVal('replacing')){ alert('Please indicate if this is a replacement.'); return; }
    estShowStep(3);
  } else if(from === 3) {
    if(!estGetVal('hris')){ alert('Please select the HRIS integration.'); return; }
    if(!estGetVal('csite')){ alert('Please select career site complexity.'); return; }
    if(!estGetVal('config')){ alert('Please select configuration complexity.'); return; }
    estShowStep(4);
  }
}
function estBack(from) {
  estShowStep(from - 1);
}
function estSubmit() {
  if(!estGetVal('golive')){ alert('Please select a go-live approach.'); return; }
  if(!estGetVal('avail')){ alert('Please select client availability.'); return; }
  if(!estGetVal('migration')){ alert('Please indicate if there is data migration.'); return; }
  if(!estGetVal('deadline')){ alert('Please indicate if there is a fixed deadline.'); return; }
  if(!estGetVal('experience')){ alert('Please select your team experience level.'); return; }

  var answers = {
    package: estGetVal('package'),
    scope: estGetChecks('#est-s1 input[type=checkbox]'),
    empsize: estGetVal('empsize'),
    countries: estGetVal('countries'),
    langs: estGetVal('langs'),
    replacing: estGetVal('replacing'),
    hris: estGetVal('hris'),
    integrations: estGetChecks('#est-s3 input[type=checkbox]'),
    careerSite: estGetVal('csite'),
    config: estGetVal('config'),
    goLiveApproach: estGetVal('golive'),
    clientAvailability: estGetVal('avail'),
    migration: estGetVal('migration'),
    deadline: estGetVal('deadline'),
    experience: estGetVal('experience')
  };

  for(var i = 1; i <= 4; i++){
    var el = document.getElementById('est-s' + i);
    if(el) el.style.display = 'none';
  }
  document.getElementById('est-step-count').style.display = 'none';
  document.getElementById('est-progress').parentElement.style.display = 'none';
  var loadEl = document.getElementById('est-loading');
  loadEl.style.display = 'flex';
  document.getElementById('est-result').style.display = 'none';
  document.getElementById('est-submit-btn').disabled = true;

  fetch('/consultant/implementation-hq/project-estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(answers)
  })
  .then(function(r){ if(!r.ok) return r.json().then(function(e){ throw new Error(e.error || 'failed'); }); return r.json(); })
  .then(function(d){
    loadEl.style.display = 'none';
    estData = d;
    estData._answers = answers;
    renderEstimate(d);
    document.getElementById('est-result').style.display = 'block';
    document.getElementById('est-result').scrollIntoView({ behavior:'smooth', block:'start' });
  })
  .catch(function(e){
    loadEl.style.display = 'none';
    alert('Could not generate estimate: ' + e.message);
    estShowStep(4);
    document.getElementById('est-step-count').style.display = '';
    document.getElementById('est-progress').parentElement.style.display = '';
  })
  .finally(function(){ document.getElementById('est-submit-btn').disabled = false; });
}

function renderEstimate(d) {
  document.getElementById('est-headline').textContent = (d.totalWeeks || '?') + ' weeks';
  var confCls = d.confidence === 'High' ? 'est-conf-high' : d.confidence === 'Low' ? 'est-conf-low' : 'est-conf-med';
  document.getElementById('est-sub').textContent = d.package + '  ·  ' + (d.scope && d.scope.length ? d.scope.join(', ') : '');
  document.getElementById('est-stat-weeks').textContent = d.totalWeeks || '?';
  document.getElementById('est-stat-cdays').textContent = d.consultantDays || '?';
  document.getElementById('est-stat-conf').innerHTML = '<span class="est-confidence ' + confCls + '">' + esc(d.confidence || 'Medium') + '</span>';

  var ph = document.getElementById('est-phases');
  ph.innerHTML = '';
  (d.phases || []).forEach(function(p){
    var div = document.createElement('div');
    div.className = 'est-phase';
    div.innerHTML = '<div class="est-phase-name">' + esc(p.name) + '</div>' +
      '<div class="est-phase-weeks">' + esc(p.weeks) + '</div>' +
      '<div class="est-phase-wlabel">weeks</div>';
    ph.appendChild(div);
  });

  document.getElementById('est-narrative').textContent = d.narrative || '';

  var risksEl = document.getElementById('est-risks');
  risksEl.innerHTML = '';
  (d.risks || []).forEach(function(r){
    var div = document.createElement('div');
    div.className = 'est-risk-item';
    div.innerHTML = '<span class="est-risk-icon">&#9888;</span>' + esc(r);
    risksEl.appendChild(div);
  });

  var assumeEl = document.getElementById('est-assumptions');
  assumeEl.innerHTML = '';
  (d.assumptions || []).forEach(function(a){
    var div = document.createElement('div');
    div.className = 'est-assume-item';
    div.textContent = a;
    assumeEl.appendChild(div);
  });
}

function exportEstimate() {
  if(!estData){ alert('Generate an estimate first.'); return; }
  var btn = document.getElementById('est-export-btn');
  btn.disabled = true;
  fetch('/consultant/implementation-hq/export-estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(estData)
  })
  .then(function(r){ if(!r.ok) throw new Error('failed'); return r.blob(); })
  .then(function(blob){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'Project_Estimate.docx';
    a.click();
    URL.revokeObjectURL(url);
  })
  .catch(function(){ alert('Export failed. Please try again.'); })
  .finally(function(){ btn.disabled = false; });
}

function estReset() {
  estData = null;
  document.getElementById('est-result').style.display = 'none';
  document.getElementById('est-step-count').style.display = '';
  document.getElementById('est-progress').parentElement.style.display = '';
  document.querySelectorAll('#page-estimator input').forEach(function(el){ el.checked = false; });
  estShowStep(1);
}

/* ── SOW Builder ── */
var _sowText = '';

function _sowChecked(id) {
  return Array.from(document.querySelectorAll('#' + id + ' input:checked')).map(function(c){ return c.value; });
}

async function generateSOW() {
  var clientName = document.getElementById('sowb-client').value.trim();
  if (!clientName) { document.getElementById('sowb-client').focus(); return; }
  var answers = {
    clientName: clientName,
    orgSize:       document.getElementById('sowb-orgsize').value,
    numUsers:      document.getElementById('sowb-users').value || 'not specified',
    numProcesses:  document.getElementById('sowb-processes').value || 'not specified',
    numTemplates:  document.getElementById('sowb-templates').value || 'not specified',
    timeline:      document.getElementById('sowb-timeline').value || 'to be agreed',
    hypercare:     document.getElementById('sowb-hypercare').value || '4 weeks',
    careerPage:    document.getElementById('sowb-career').value,
    dataMigration: document.getElementById('sowb-datamigration').value,
    integrations:  _sowChecked('sowb-integrations'),
    jobBoards:     _sowChecked('sowb-jobboards'),
    training:      _sowChecked('sowb-training'),
    notes:         document.getElementById('sowb-notes').value.trim(),
  };
  var btn = document.getElementById('sowb-run-btn');
  var resultWrap = document.getElementById('sowb-result-wrap');
  var outputEl = document.getElementById('sowb-output');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  resultWrap.style.display = 'none';
  _sowText = '';
  try {
    var res = await fetch('/consultant/implementation-hq/generate-sow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: answers }),
    });
    if (!res.ok) throw new Error('Server error');
    resultWrap.style.display = 'block';
    outputEl.textContent = '';
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    while (true) {
      var _r = await reader.read();
      if (_r.done) break;
      var chunk = decoder.decode(_r.value, { stream: true });
      _sowText += chunk;
      outputEl.textContent = _sowText;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
    resultWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch(e) {
    alert('Generation failed — please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate SOW';
  }
}

function copySOW() {
  if (!_sowText) return;
  navigator.clipboard.writeText(_sowText).then(function(){
    var btn = document.getElementById('sowb-copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(function(){ btn.textContent = 'Copy text'; }, 2000);
  });
}

async function exportSOW() {
  if (!_sowText) return;
  var clientName = document.getElementById('sowb-client').value.trim() || 'Client';
  var btn = document.getElementById('sowb-export-btn');
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  try {
    var res = await fetch('/consultant/implementation-hq/export-sow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName: clientName, sowText: _sowText }),
    });
    if (!res.ok) throw new Error('failed');
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'SOW - ' + clientName + ' - SmartRecruiters.docx';
    a.click();
    URL.revokeObjectURL(url);
  } catch(e) {
    alert('Export failed. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download .docx';
  }
}
</script>

<!-- SOW BUILDER PAGE -->
<div id="page-sowbuilder" class="page">
  <div class="sowb-hero">
    <div class="sowb-hero-inner">
      <div class="sowb-hero-label">Generate</div>
      <h1 class="sowb-hero-title">SOW Builder</h1>
      <p class="sowb-hero-sub">Generate a professional, client-ready Statement of Work for a SmartRecruiters implementation — based on the full EX3 knowledge base and 60 source documents.</p>
    </div>
  </div>
  <div class="sowb-form-wrap">
    <div class="sowb-form-card">
      <div class="sowb-section-title">Client & Project</div>
      <div class="sowb-grid">
        <div>
          <label class="sowb-label">Client Name</label>
          <input id="sowb-client" class="sowb-input" placeholder="e.g. Acme Corp" />
        </div>
        <div>
          <label class="sowb-label">Organisation Size</label>
          <select id="sowb-orgsize" class="sowb-select">
            <option>SME (under 250 employees)</option>
            <option>Mid-market (250–2,000)</option>
            <option selected>Enterprise (2,000–10,000)</option>
            <option>Large enterprise (10,000+)</option>
          </select>
        </div>
        <div>
          <label class="sowb-label">System Users</label>
          <input id="sowb-users" class="sowb-input" placeholder="e.g. 150" />
        </div>
      </div>
      <div class="sowb-grid" style="margin-top:16px">
        <div>
          <label class="sowb-label">Hiring Workflows</label>
          <input id="sowb-processes" class="sowb-input" placeholder="e.g. 3 (standard, exec, grad)" />
        </div>
        <div>
          <label class="sowb-label">Job Templates</label>
          <input id="sowb-templates" class="sowb-input" placeholder="e.g. 2" />
        </div>
        <div>
          <label class="sowb-label">Project Timeline</label>
          <input id="sowb-timeline" class="sowb-input" placeholder="e.g. 12 weeks" />
        </div>
      </div>
      <div class="sowb-grid2" style="margin-top:16px">
        <div>
          <label class="sowb-label">Hypercare Period</label>
          <input id="sowb-hypercare" class="sowb-input" placeholder="e.g. 4 weeks post go-live" />
        </div>
        <div>
          <label class="sowb-label">Career Site</label>
          <select id="sowb-career" class="sowb-select">
            <option>Career Site Builder (SmartRecruiters hosted)</option>
            <option>Job widget embedded in existing site</option>
            <option>SmartRecruiters hosted page only</option>
            <option>Custom career site via API (client-built)</option>
            <option>No career site in scope</option>
          </select>
        </div>
      </div>

      <div class="sowb-section-title" style="margin-top:28px">Integrations</div>
      <div class="sowb-checks" id="sowb-integrations">
        <label class="sowb-check"><input type="checkbox" value="SAP SuccessFactors Employee Central (EC) — bidirectional HRIS sync"> HRIS / EC</label>
        <label class="sowb-check"><input type="checkbox" value="Payroll — new hire export on hire"> Payroll</label>
        <label class="sowb-check"><input type="checkbox" value="Background screening (e.g. Sterling, Verifile)"> Background screening</label>
        <label class="sowb-check"><input type="checkbox" value="Assessment / testing tools"> Assessments</label>
        <label class="sowb-check"><input type="checkbox" value="SSO / identity provider (e.g. Azure AD, Okta)"> SSO</label>
        <label class="sowb-check"><input type="checkbox" value="DocuSign e-signature"> DocuSign</label>
        <label class="sowb-check"><input type="checkbox" value="Calendar integration (MS365 / Google) for self-scheduling"> Calendar</label>
        <label class="sowb-check"><input type="checkbox" value="LinkedIn Recruiter"> LinkedIn Recruiter</label>
        <label class="sowb-check"><input type="checkbox" value="Data migration from previous ATS"> Data migration</label>
        <label class="sowb-check"><input type="checkbox" value="None"> None</label>
      </div>

      <div class="sowb-section-title" style="margin-top:24px">Job Boards</div>
      <div class="sowb-checks" id="sowb-jobboards">
        <label class="sowb-check"><input type="checkbox" value="Indeed"> Indeed</label>
        <label class="sowb-check"><input type="checkbox" value="LinkedIn"> LinkedIn</label>
        <label class="sowb-check"><input type="checkbox" value="Glassdoor"> Glassdoor</label>
        <label class="sowb-check"><input type="checkbox" value="Reed"> Reed</label>
        <label class="sowb-check"><input type="checkbox" value="Totaljobs"> Totaljobs</label>
        <label class="sowb-check"><input type="checkbox" value="CV-Library"> CV-Library</label>
        <label class="sowb-check"><input type="checkbox" value="Internal job board only"> Internal only</label>
      </div>

      <div class="sowb-section-title" style="margin-top:24px">Training</div>
      <div class="sowb-checks" id="sowb-training">
        <label class="sowb-check"><input type="checkbox" value="Train the Trainer (TTT)" checked> Train the Trainer</label>
        <label class="sowb-check"><input type="checkbox" value="Recruiter live training sessions (2–3 x 90 min virtual)"> Recruiter sessions</label>
        <label class="sowb-check"><input type="checkbox" value="Admin / HRIS team training"> Admin training</label>
        <label class="sowb-check"><input type="checkbox" value="Hiring Manager training (1 x 60 min virtual)"> Hiring Manager</label>
        <label class="sowb-check"><input type="checkbox" value="E-learning / recorded sessions"> E-learning</label>
      </div>

      <div class="sowb-section-title" style="margin-top:24px">Data Migration</div>
      <div>
        <select id="sowb-datamigration" class="sowb-select" style="max-width:400px">
          <option>No data migration required</option>
          <option>Active candidates / open requisitions only</option>
          <option>Historical data (last 12 months)</option>
          <option>Historical data (last 24 months)</option>
          <option>Full historical data</option>
        </select>
      </div>

      <div class="sowb-section-title" style="margin-top:24px">Additional Notes</div>
      <textarea id="sowb-notes" class="sowb-textarea" placeholder="Any specific requirements, constraints, out-of-scope items, or context the AI should factor in…"></textarea>

      <div style="display:flex;align-items:center;margin-top:28px">
        <button id="sowb-run-btn" class="sowb-run-btn" onclick="generateSOW()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Generate SOW
        </button>
        <span class="sowb-hint">Takes ~20 seconds — uses all 60 documents</span>
      </div>
    </div>

    <div id="sowb-result-wrap" class="sowb-result-wrap" style="display:none">
      <div class="sowb-result-topbar">
        <div>
          <div class="sowb-result-label">Generated SOW</div>
          <div class="sowb-result-title">Statement of Work</div>
        </div>
        <div class="sowb-topbar-right">
          <button id="sowb-copy-btn" class="sowb-export-btn" onclick="copySOW()">Copy text</button>
          <button id="sowb-export-btn" class="sowb-export-btn" onclick="exportSOW()">Download .docx</button>
        </div>
      </div>
      <div id="sowb-output" class="sowb-output"></div>
    </div>
  </div>
</div>

</body></html>`);
});

// SOW Builder — Generate
app.post('/consultant/implementation-hq/generate-sow', async (req, res) => {
  const { answers } = req.body;
  if (!answers) return res.status(400).json({ error: 'No answers' });

  const integrations = Array.isArray(answers.integrations) ? answers.integrations.join(', ') : answers.integrations || 'None';
  const jobBoards = Array.isArray(answers.jobBoards) ? answers.jobBoards.join(', ') : answers.jobBoards || 'None';
  const training = Array.isArray(answers.training) ? answers.training.join('; ') : answers.training || 'None';
  const notes = answers.notes ? `\nAdditional notes / constraints: ${answers.notes}` : '';

  const systemPrompt = `You are a senior SmartRecruiters / SAP SuccessFactors implementation consultant at EX3 — a SAP Gold Partner. You write formal, client-ready Statements of Work that are commercially tight, technically accurate, and ready to send without editing.

KNOWLEDGE BASE (sourced from SAP Partner Readiness Guide, SmartRecruiters Implementation Playbook, Advance Planning Considerations, Go-Live Checklist, EX3 internal guides, and 60 source documents):

THE SIX IMPLEMENTATION PHASES (SmartRecruiters standard methodology):
Phase 1 — PRE-DESIGN: Validate playbook, establish governance, define 80/20 rule, identify project team.
Phase 2 — DESIGN: 101 training, 8 structured design workshops (System Controls & Permissions; Job Creation & Management; Functional Integrations & Ecosystem; Career Site & Candidate Application; Candidate Management 1; Candidate Management 2; Offer Management & Hiring; Analytics).
Phase 3 — BUILD & TEST: System built in Sandbox. Integration and functional build run in parallel. Unit testing iteratively validates configuration.
Phase 4 — UAT & PRODUCTION: End-to-end UAT in Sandbox, sign-off, migrate to Production, UAT in Production, final sign-off.
Phase 5 — TRAINING: Delivered after UAT in Production so users train on the final live system.
Phase 6 — GO-LIVE, HYPERCARE & OPTIMISE: Cutover, hypercare support, CSM handover, project close.

CONFIGURATION DELIVERABLES:
System Controls & Permissions: system roles (Administrator/Extended/Standard/Basic/Employee; up to 10 custom roles); hiring team roles (up to 5 custom); Access Groups by org field; GDPR/data retention per country; privacy policy; user provisioning process; IP whitelisting; email domain authentication.
Job Creation & Management: job templates (1 per agreed template count); job and org fields; dependencies; approval chains; job board contract setup; auto-distribute rules.
Career Site: Career Site Builder (SR hosted); pages — Home, Job Search, Job Detail, Application; branding (logo, colours, fonts — assets provided by client); mobile responsive; GDPR consent; SEO; staging to production cutover; DNS changes (client IT).
Candidate Application & Screening: application form; custom candidate fields; EEO/OFCCP; screening question sets (5–7 questions; knockout logic); auto-replies; agency portal.
Candidate Management: hiring processes (default + custom; up to 120 processes, 8 steps per status); workflow automations; rejection/withdrawal reasons; email templates.
Interview Management: interview types; calendar integration (Google/MS365/Exchange — client IT provides admin access); self-scheduling; interview scorecards.
Offer Management: offer letter templates with merge fields; offer approval chains; DocuSign if in scope; new hire form.
Analytics: standard dashboards (pipeline, time-to-hire, source effectiveness, recruiter activity); custom candidate sources; report builder permissions; KPI benchmarks.

INTEGRATIONS SCOPE:
SSO: SR paired with SF instance; users log in via SF credentials (SAML 2.0); EX3 configures SR side; client IT configures IdP (Azure AD/Okta/ADFS).
Calendar: Required for self-scheduling; supported — Google, MS365, Exchange; client IT provides admin access.
EC/HRIS: Bidirectional sync; foundation data feed; new hire record on offer accept; EX3 configures integration; client HRIS confirms mapping.
Background Screening: Marketplace integration; candidate consent in SR; client must hold active vendor contract.
Assessments: Marketplace or redirect integration; client holds vendor contract.
Payroll: New hire export; client payroll team confirms field mapping.
DocuSign: Business or Enterprise licence required; user email must match SR email exactly (case-sensitive).
Data Migration: EX3 provides import template; client extracts and cleans data; max 2 rounds of cleansing; client must unpost old ATS jobs before go-live.

TRAINING:
TTT: EX3 trains 2–4 super-users; includes trainer guide and recordings.
Recruiter live: 2–3 x 90-min virtual sessions; recordings provided.
Admin training: dedicated session on system administration, RBP, user management.
HM training: 1 x 60-min virtual; includes quick reference card.
E-learning: workflow recordings; hosted on client intranet.
All training delivered after UAT in Production.

CLIENT RESPONSIBILITIES:
- Appoint Executive Sponsor (5–10% capacity) and Project Manager (50–75% capacity, named decision-maker)
- Nominate 1–2 System Administrators who attend all workshops
- Complete workshop homework; provide design decisions within 3 business days
- Sign off deliverables within 5 business days (deemed accepted thereafter)
- Provide career site assets (logo, images, brand guidelines) within 5 business days of request
- Provide offer letter templates in Word format with merge fields highlighted
- Provide job board contract credentials
- Provide Legal sign-off on GDPR/data retention settings and consent model
- Provide IT resource for SSO, calendar, email domain auth, DNS — EX3 cannot complete these
- Provide data migration extract in agreed template format
- Execute UAT in agreed window; raise defects via defect log
- Ensure all users created in system before training
- Prepare and send go-live communications

STANDARD ASSUMPTIONS:
- Valid SmartRecruiters/SF licence in place or being procured directly with SAP
- EX3 has full admin access from Week 1
- Single company instance (multi-instance out of scope)
- English language only
- No custom API development or platform extensions
- All third-party vendor contracts (screening, assessments, DocuSign, job boards) are client's responsibility
- Changes after design sign-off handled via formal Change Request

GOVERNANCE:
RACI: EX3 Responsible for configuration and technical delivery; Client Accountable for decisions, sign-off, data, UAT. Change Tolerance: minor changes absorbed within fixed fee; anything beyond requires Change Request (assessed in 3 business days). Deemed Acceptance: deliverables not rejected within 5 business days are deemed accepted.

STANDARD OUT OF SCOPE:
EC configuration beyond RCM integration; Onboarding module; LMS; Performance & Goals; Succession; custom API development; multi-language beyond English; additional instances; post-hypercare support; third-party system configuration; any integration not listed.`;

  const userPrompt = `Write a complete, formal Statement of Work for the following SmartRecruiters implementation. Do NOT use placeholder text — write it exactly as it would be sent to the client.

CLIENT: ${answers.clientName}
Organisation size: ${answers.orgSize}
System users: ${answers.numUsers}
Hiring process workflows: ${answers.numProcesses}
Job templates: ${answers.numTemplates}
Integrations: ${integrations}
Job boards: ${jobBoards}
Career site: ${answers.careerPage}
Data migration: ${answers.dataMigration}
Training: ${training}
Hypercare: ${answers.hypercare}
Timeline: ${answers.timeline}${notes}

Write sections:
1. Project Overview (2–3 paragraphs — client context, platform, objectives)
2. In Scope (detailed bullets grouped by: System Configuration & Permissions, Job Creation & Management, Hiring Process & Candidate Management, Offer Management, Career Site, Integrations, Analytics & Reporting, UAT Support, Training, Go-Live & Hypercare — reference exact numbers above)
3. Out of Scope (clear exclusion list)
4. Client Responsibilities (specific tasks with timelines)
5. Assumptions (full list)
6. Governance & Change Request Process (RACI summary, Change Tolerance, Deemed Acceptance, change procedure)
7. Project Timeline (phase-by-phase using SmartRecruiters 6-phase methodology adapted to the agreed timeline)

Use formal commercial language. Be specific throughout — name exact counts, integration types, training sessions. Write as a senior SmartRecruiters implementation consultant.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      stream: true,
      max_tokens: 4000,
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    for await (const chunk of completion) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) res.write(text);
    }
    res.end();
  } catch(err) {
    console.error('SOW generate error:', err.message);
    res.status(500).json({ error: 'Generation failed' });
  }
});

// SOW Builder — Export .docx
app.post('/consultant/implementation-hq/export-sow', async (req, res) => {
  const { clientName, sowText } = req.body;
  if (!sowText) return res.status(400).json({ error: 'No SOW text' });

  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
    const client = clientName || 'Client';

    const lines = sowText.split('\n');
    const children = [];

    children.push(new Paragraph({
      children: [new TextRun({ text: `Statement of Work`, bold: true, size: 36 })],
      heading: HeadingLevel.TITLE,
      spacing: { after: 200 },
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: `${client} — SmartRecruiters Implementation`, size: 24, color: '666666' })],
      spacing: { after: 400 },
    }));

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { children.push(new Paragraph({ text: '', spacing: { after: 80 } })); continue; }
      if (/^\d+\.\s/.test(trimmed) && trimmed.length < 80) {
        children.push(new Paragraph({ text: trimmed, heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 120 } }));
      } else if (/^[A-Z][A-Z &]+:/.test(trimmed) && trimmed.length < 100) {
        children.push(new Paragraph({ text: trimmed, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } }));
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
        children.push(new Paragraph({ text: trimmed.replace(/^[-•]\s/, ''), bullet: { level: 0 }, spacing: { after: 80 } }));
      } else {
        children.push(new Paragraph({ children: [new TextRun({ text: trimmed, size: 22 })], spacing: { after: 120 } }));
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="SOW - ${client} - SmartRecruiters.docx"`);
    res.send(buffer);
  } catch(err) {
    console.error('SOW export error:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
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

// Kickoff Generator — AI brief generation
app.post('/consultant/implementation-hq/generate-brief', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const { client, golive, processes, countries, integrations, experience } = req.body;
  if (!client || !golive) return res.status(400).json({ error: 'Missing fields' });

  const intList = Array.isArray(integrations) && integrations.length ? integrations.join(', ') : 'None';

  const prompt = `You are an expert SmartRecruiters implementation consultant. Using the knowledge from the implementation documents provided, generate a detailed project kickoff brief for the following engagement:

Client: ${client}
Go-Live Date: ${golive}
Countries in Scope: ${countries}
Number of Hiring Processes: ${processes}
Integrations Required: ${intList}
Consultant Experience Level: ${experience}

Return ONLY a valid JSON object with this exact structure (no markdown, no preamble):
{
  "overview": {
    "client": "${client}",
    "golive": "${golive}",
    "countries": "${countries}",
    "processes": "${processes}",
    "integrations": "${intList}",
    "experience": "${experience}"
  },
  "timeline": [
    { "milestone": "...", "date": "YYYY-MM-DD", "notes": "..." }
  ],
  "risks": [
    { "risk": "...", "severity": "High|Medium|Low", "mitigation": "..." }
  ],
  "reading": ["Doc name — reason to read"],
  "questionnaire": ["Question text"],
  "actions": ["Action item"]
}

Rules:
- timeline: 8-12 milestones from kickoff to go-live, with realistic dates working backwards from ${golive}
- risks: 6-10 risks relevant to this specific engagement (integrations, countries, processes) with severity High/Medium/Low
- reading: 6-8 specific document recommendations drawn from the knowledge base, each with a brief reason
- questionnaire: 8-10 discovery questions the consultant should ask the client in week 1
- actions: 8-10 concrete things the consultant must do in week 1
Be specific to this client's profile. Reference real SmartRecruiters configuration concepts, limits, and integration requirements where relevant.`;

  try {
    const thread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(thread.id, { role: 'user', content: prompt });

    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    const messages = await openai.beta.threads.messages.list(thread.id);
    const last = messages.data.find(m => m.role === 'assistant');
    if (!last) return res.status(500).json({ error: 'No response from AI' });

    let raw = last.content[0]?.text?.value || '';
    raw = raw.replace(/【[^】]*】/g, '').trim();

    // Strip any markdown code fences
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let data;
    try {
      data = JSON.parse(raw);
    } catch(e) {
      // Try to extract JSON from the response
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) data = JSON.parse(match[0]);
      else return res.status(500).json({ error: 'AI returned invalid JSON' });
    }

    return res.json(data);
  } catch(err) {
    console.error('Kickoff generator error:', err.message);
    return res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});

// Kickoff Generator — Word export
app.post('/consultant/implementation-hq/export-brief', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const d = req.body;
  if (!d || !d.overview) return res.status(400).json({ error: 'No brief data' });

  try {
    const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel,
            AlignmentType, BorderStyle, WidthType, ShadingType, convertInchesToTwip } = require('docx');

    const NAVY  = '0f0f0e';
    const GREY  = 'f5f4f1';
    const BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'e4e2dc' };
    const cellBorder = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

    const headerCell = (text, width) => new TableCell({
      width: width ? { size: width, type: WidthType.DXA } : undefined,
      shading: { type: ShadingType.SOLID, color: GREY, fill: GREY },
      borders: cellBorder,
      children: [new Paragraph({
        children: [new TextRun({ text, bold: true, size: 22, color: NAVY, font: 'Calibri' })],
      })],
    });

    const bodyCell = (text) => new TableCell({
      borders: cellBorder,
      children: [new Paragraph({
        children: [new TextRun({ text: String(text || ''), size: 20, font: 'Calibri', color: '333333' })],
      })],
    });

    const riskCell = (text, severity) => {
      const color = severity === 'High' ? 'dc2626' : severity === 'Medium' ? 'd97706' : '16a34a';
      return new TableCell({
        borders: cellBorder,
        children: [new Paragraph({
          children: [new TextRun({ text: String(text || ''), bold: true, size: 20, font: 'Calibri', color })],
        })],
      });
    };

    const sectionHeading = (text) => new Paragraph({
      text,
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 320, after: 160 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: NAVY } },
      children: [new TextRun({ text, bold: true, size: 26, allCaps: true, font: 'Calibri', color: NAVY })],
    });

    const children = [];

    // Title block
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      children: [new TextRun({ text: 'EX3', bold: true, size: 64, font: 'Calibri', color: NAVY })],
    }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      children: [new TextRun({ text: 'Implementation Kickoff Brief', size: 36, font: 'Calibri', color: '555555' })],
    }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      children: [new TextRun({ text: d.overview.client, bold: true, size: 44, font: 'Calibri', color: NAVY })],
    }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 480 },
      children: [new TextRun({ text: 'Go-Live: ' + d.overview.golive + '  |  EX3 Confidential', size: 20, font: 'Calibri', color: '888888', italics: true })],
    }));

    // Project Overview table
    children.push(sectionHeading('Project Overview'));
    const ovRows = [
      ['Client', d.overview.client],
      ['Go-Live Date', d.overview.golive],
      ['Countries in Scope', d.overview.countries],
      ['Hiring Processes', d.overview.processes],
      ['Integrations', d.overview.integrations],
      ['Consultant Level', d.overview.experience],
    ];
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: ovRows.map(([k, v]) => new TableRow({ children: [headerCell(k, 2520), bodyCell(v)] })),
    }));

    // Timeline
    children.push(sectionHeading('Implementation Timeline'));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [headerCell('Milestone'), headerCell('Target Date', 1800), headerCell('Notes')] }),
        ...(d.timeline || []).map(r => new TableRow({ children: [bodyCell(r.milestone), bodyCell(r.date), bodyCell(r.notes)] })),
      ],
    }));

    // Risk Register
    children.push(sectionHeading('Risk Register'));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [headerCell('Risk'), headerCell('Severity', 1440), headerCell('Mitigation')] }),
        ...(d.risks || []).map(r => new TableRow({ children: [bodyCell(r.risk), riskCell(r.severity, r.severity), bodyCell(r.mitigation)] })),
      ],
    }));

    // Reading List
    children.push(sectionHeading('Recommended Reading List'));
    (d.reading || []).forEach((item, i) => {
      children.push(new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({ text: (i + 1) + '.  ' + item, size: 20, font: 'Calibri', color: '333333' })],
      }));
    });

    // Questionnaire
    children.push(sectionHeading('Client Discovery Questionnaire'));
    (d.questionnaire || []).forEach((item, i) => {
      children.push(new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({ text: (i + 1) + '.  ' + item, size: 20, font: 'Calibri', color: '333333' })],
      }));
    });

    // Week 1 Actions
    children.push(sectionHeading('Week 1 Consultant Actions'));
    (d.actions || []).forEach((item, i) => {
      children.push(new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({ text: (i + 1) + '.  ' + item, size: 20, font: 'Calibri', color: '333333' })],
      }));
    });

    // Footer note
    children.push(new Paragraph({
      spacing: { before: 640 },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: d.overview.client + '  |  EX3 Confidential  |  Generated by EX3 Implementation HQ', size: 18, font: 'Calibri', color: 'aaaaaa', italics: true })],
    }));

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="Kickoff_Brief.docx"');
    res.send(buffer);
  } catch(err) {
    console.error('Export error:', err.message);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Meeting Coach — brief generation
app.post('/consultant/implementation-hq/meeting-brief', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const { meeting, context } = req.body;
  if (!meeting) return res.status(400).json({ error: 'Missing meeting type' });

  const contextLine = context ? `\nAdditional context: ${context}` : '';

  const prompt = `You are a senior SmartRecruiters implementation consultant preparing a junior colleague for a client meeting. Using the knowledge from the implementation documents provided, generate a complete meeting intelligence brief for the following meeting:

Meeting: ${meeting}${contextLine}

Return ONLY a valid JSON object with this exact structure (no markdown, no preamble):
{
  "meeting": "${meeting}",
  "purpose": "2-3 sentences on what this meeting is really for — the real goal, not just the agenda",
  "agenda": [
    { "item": "Agenda item title", "notes": "What to actually say or do here — be specific and practical" }
  ],
  "mustAsk": [
    "Question the consultant must ask the client"
  ],
  "watchFor": [
    "Red flag or warning sign to watch for in this meeting"
  ],
  "clientWillAsk": [
    { "question": "Question the client will almost certainly ask", "answer": "Suggested answer the consultant should give" }
  ],
  "preMeeting": [
    "Concrete action to take before the meeting"
  ],
  "followUp": [
    "Concrete action to take after the meeting"
  ],
  "success": "1-2 sentences describing what a successful outcome for this meeting looks like"
}

Rules:
- agenda: 5-8 items, each with practical talking point notes — not generic filler
- mustAsk: 5-6 questions that will genuinely help the consultant understand the client and project
- watchFor: 4-6 specific red flags (e.g. scope creep, integration complexity, client engagement issues)
- clientWillAsk: 4-6 Q&A pairs — the questions a nervous new consultant would not know how to answer
- preMeeting: 4-5 concrete preparation steps
- followUp: 4-5 concrete follow-up actions with specifics (e.g. "Send meeting notes within 24 hours with decisions logged")
- Be specific to ${meeting} — reference actual SmartRecruiters concepts, configuration steps, and document names where relevant
- Write as if briefing a new consultant who has never run this meeting before`;

  try {
    const thread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(thread.id, { role: 'user', content: prompt });

    await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    const messages = await openai.beta.threads.messages.list(thread.id);
    const last = messages.data.find(m => m.role === 'assistant');
    if (!last) return res.status(500).json({ error: 'No response from AI' });

    let raw = (last.content[0]?.text?.value || '').replace(/【[^】]*】/g, '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let data;
    try {
      data = JSON.parse(raw);
    } catch(e) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) data = JSON.parse(match[0]);
      else return res.status(500).json({ error: 'AI returned invalid JSON' });
    }

    return res.json(data);
  } catch(err) {
    console.error('Meeting coach error:', err.message);
    return res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});

// Meeting Coach — Word export
app.post('/consultant/implementation-hq/export-meeting-brief', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const d = req.body;
  if (!d || !d.meeting) return res.status(400).json({ error: 'No brief data' });

  try {
    const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
            AlignmentType, BorderStyle, WidthType, ShadingType } = require('docx');

    const NAVY = '0f0f0e';
    const GREY = 'f5f4f1';
    const BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'e4e2dc' };
    const CB = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

    const hCell = (text, w) => new TableCell({
      width: w ? { size: w, type: WidthType.DXA } : undefined,
      shading: { type: ShadingType.SOLID, color: GREY, fill: GREY },
      borders: CB,
      children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 20, color: NAVY, font: 'Calibri' })] })],
    });
    const bCell = (text) => new TableCell({
      borders: CB,
      children: [new Paragraph({ children: [new TextRun({ text: String(text||''), size: 20, font: 'Calibri', color: '333333' })] })],
    });

    const secHead = (text) => new Paragraph({
      spacing: { before: 360, after: 160 },
      children: [new TextRun({ text, bold: true, size: 22, allCaps: true, font: 'Calibri', color: NAVY })],
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e4e2dc' } },
    });

    const numbered = (items, color) => items.map((item, i) => new Paragraph({
      spacing: { after: 80 },
      children: [
        new TextRun({ text: String(i+1) + '.  ', bold: true, size: 20, font: 'Calibri', color: color || NAVY }),
        new TextRun({ text: String(item||''), size: 20, font: 'Calibri', color: '333333' }),
      ],
    }));

    const children = [];

    // Title block
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 }, children: [new TextRun({ text: 'EX3', bold: true, size: 64, font: 'Calibri', color: NAVY })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 }, children: [new TextRun({ text: 'Meeting Intelligence Brief', size: 32, font: 'Calibri', color: '666666' })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 480 }, children: [new TextRun({ text: d.meeting, bold: true, size: 44, font: 'Calibri', color: NAVY })] }));

    // Purpose + Success
    children.push(secHead('Meeting Purpose'));
    children.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: d.purpose||'', size: 20, font: 'Calibri', color: '333333' })] }));

    children.push(secHead('What Good Looks Like'));
    children.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: d.success||'', size: 20, font: 'Calibri', color: '333333' })] }));

    // Agenda
    children.push(secHead('Your Agenda & Talking Points'));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [hCell('Agenda Item', 2800), hCell('Your Talking Points')] }),
        ...(d.agenda||[]).map(a => new TableRow({ children: [bCell(a.item), bCell(a.notes)] })),
      ],
    }));

    // Must Ask
    children.push(secHead('Questions You Must Ask'));
    children.push(...numbered(d.mustAsk||[]));

    // Watch For
    children.push(secHead('Watch For'));
    children.push(...numbered(d.watchFor||[], 'dc2626'));

    // Client Q&A
    children.push(secHead('What the Client Will Ask You'));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [hCell('They Will Ask', 3200), hCell('Your Answer')] }),
        ...(d.clientWillAsk||[]).map(qa => new TableRow({ children: [bCell(qa.question), bCell(qa.answer)] })),
      ],
    }));

    // Pre + Post
    children.push(secHead('Before the Meeting'));
    children.push(...numbered(d.preMeeting||[]));
    children.push(secHead('After the Meeting'));
    children.push(...numbered(d.followUp||[]));

    // Footer
    children.push(new Paragraph({ spacing: { before: 640 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'EX3 Confidential  |  Generated by EX3 Implementation HQ', size: 18, font: 'Calibri', color: 'aaaaaa', italics: true })] }));

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Meeting_Brief.docx"`);
    res.send(buffer);
  } catch(err) {
    console.error('Meeting export error:', err.message);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Project Workbook Builder — generation
app.post('/consultant/implementation-hq/generate-workbook', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const { client, golive, weeks, areas, integrations, countries, processes, experience } = req.body;
  if (!client || !golive || !weeks || !areas || !areas.length) return res.status(400).json({ error: 'Missing fields' });

  const areasList = Array.isArray(areas) ? areas.join(', ') : areas;
  const integrationsList = Array.isArray(integrations) && integrations.length ? integrations.join(', ') : 'None';
  const weeksNum = parseInt(weeks, 10) || 12;
  const coreEnd = Math.round(weeksNum * 0.62);
  const uatStart = coreEnd + 1;

  const prompt = `You are an expert SmartRecruiters implementation consultant. Generate a complete personalised project workbook for this engagement.

Client: ${client}
Go-Live Date: ${golive}
Total Weeks: ${weeksNum}
Countries/Regions: ${countries || 'Not specified'}
Number of Hiring Processes: ${processes || 'Not specified'}
Integrations in Scope: ${integrationsList}
Consultant Experience: ${experience === 'new' ? 'New to SmartRecruiters — provide extra guidance and context in steps' : experience === 'experienced' ? 'Experienced — be concise and technical' : '1-2 prior implementations'}
Process Areas in Scope: ${areasList}

Return ONLY a valid JSON object (no markdown, no code fences, no preamble):
{
  "client": "${client}",
  "golive": "${golive}",
  "totalWeeks": ${weeksNum},
  "weeks": [
    {
      "num": 1,
      "theme": "Examine & Discovery",
      "focus": "One sentence summary of this week",
      "milestone": "Key deliverable or gate that closes this week e.g. Discovery sign-off received",
      "processes": [
        {
          "area": "System Controls & User Permissions",
          "title": "Descriptive process title",
          "navPath": "Main Menu -> Settings -> Configuration -> Company Settings",
          "steps": [
            "Step 1: exact click-level instruction naming real buttons, fields, toggles",
            "Step 2: ..."
          ],
          "output": "Concrete deliverable e.g. 6-stage hiring process configured with approval chain",
          "gotcha": "Most important platform-specific warning, or null",
          "owner": "EX3",
          "duration": "2-3 hours",
          "depends": "Requires: X completed first, or null"
        }
      ]
    }
  ]
}

Rules:
- Generate exactly ${weeksNum} weeks in the correct structure
- Week 1: Kickoff, environment access, discovery workshops, initial requirements gathering
- Week 2: Detailed discovery, requirements sign-off, configuration planning, tenant setup
- Weeks 3-${coreEnd}: Core configuration in logical order — system controls and RBP first, then jobs, career site, integrations (if in scope), candidate management, offer management, analytics
- Weeks ${uatStart}-${weeksNum - 2}: UAT preparation, UAT execution, training delivery, issue resolution
- Week ${weeksNum - 1}: Go-live activities, data migration final run, cutover
- Week ${weeksNum}: Hypercare, post-go-live support, handover to BAU
- 3-5 processes per week — quality over quantity, each one genuinely useful
- navPath: EXACT SmartRecruiters UI navigation (e.g. "Main Menu -> Settings -> Hiring -> Hiring Stages", "Admin Panel -> Career Site Builder -> Branding")
- steps: 5-8 precise steps naming exact SmartRecruiters elements — field names, button labels, dropdown values, toggle names
- owner: "EX3" (consultant does it alone), "Client" (client action required), "Both" (joint session)
- duration: realistic estimate e.g. "1-2 hours", "Half day", "Full day"
- depends: what must exist before starting, or null
- milestone: closing gate for the week (what signals week is done)
- Personalise for the specific integrations: if SuccessFactors EC is in scope, include connector setup, field mapping, and position sync steps in the integrations weeks; if DocuSign, include offer template e-signature setup
- Personalise for countries: if Middle East or UAE in scope, note Arabic/PDPL compliance configuration; if multiple EU countries, note GDPR data retention settings
- If multiple hiring processes in scope (${processes || '5+'}), include steps for building and testing multiple process variants
- Reference real SmartRecruiters features by name: Hiring Process Builder, SmartMessage templates, Offer Approval Chain, Career Site Builder, RBP Role Configuration, Job Ad Library, Assessment Steps, SmartConnect integration hub, Candidate Portal, Data Retention Policies, Analytics Dashboards`;

  try {
    const thread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(thread.id, { role: 'user', content: prompt });

    await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    const messages = await openai.beta.threads.messages.list(thread.id);
    const last = messages.data.find(m => m.role === 'assistant');
    if (!last) return res.status(500).json({ error: 'No response from AI' });

    let raw = (last.content[0]?.text?.value || '').replace(/【[^】]*】/g, '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let data;
    try {
      data = JSON.parse(raw);
    } catch(e) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { data = JSON.parse(match[0]); }
        catch(e2) { return res.status(500).json({ error: 'AI returned invalid JSON' }); }
      } else {
        return res.status(500).json({ error: 'AI returned invalid JSON' });
      }
    }

    return res.json(data);
  } catch(err) {
    console.error('Workbook generator error:', err.message);
    return res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});

// Project Workbook Builder — Word export
app.post('/consultant/implementation-hq/export-workbook', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const d = req.body;
  if (!d || !d.weeks || !d.weeks.length) return res.status(400).json({ error: 'No workbook data' });

  try {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            AlignmentType, BorderStyle, WidthType, VerticalAlign } = require('docx');

    const children = [];
    const spacer = () => new Paragraph({ children: [new TextRun({ text: '' })] });
    const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const thinBorder = { style: BorderStyle.SINGLE, size: 2, color: 'e4e2dc' };

    // Totals
    let totalProcs = 0;
    (d.weeks || []).forEach(w => { totalProcs += (w.processes || []).length; });

    const now = new Date();
    const months2 = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const dateStr = now.getDate() + ' ' + months2[now.getMonth()] + ' ' + now.getFullYear();

    // ── COVER PAGE ──────────────────────────────────────────────
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 2400, after: 200 },
      children: [new TextRun({ text: 'PROJECT WORKBOOK', size: 15, font: 'Calibri', color: 'aaaaaa', bold: true, allCaps: true, characterSpacing: 200 })],
    }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: d.client || 'Client', size: 72, font: 'Calibri', bold: true, color: '0f0f0e' })],
    }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [new TextRun({ text: (d.totalWeeks || '') + '-Week SmartRecruiters Implementation', size: 26, font: 'Calibri', color: '666666' })],
    }));

    // Summary table
    const summaryRows = [
      ['Client', d.client || ''],
      ['Go-Live Date', d.golive || ''],
      ['Project Duration', (d.totalWeeks || '') + ' weeks'],
      ['Total Processes', String(totalProcs)],
      ['Generated', dateStr],
    ];
    children.push(new Table({
      width: { size: 70, type: WidthType.PERCENTAGE },
      margins: { left: 0 },
      rows: summaryRows.map(row => new TableRow({
        children: [
          new TableCell({
            width: { size: 35, type: WidthType.PERCENTAGE },
            borders: { top: thinBorder, bottom: thinBorder, left: noBorder, right: thinBorder },
            shading: { fill: 'f5f4f1' },
            children: [new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: row[0], size: 18, font: 'Calibri', bold: true, color: '555555' })] })],
          }),
          new TableCell({
            width: { size: 65, type: WidthType.PERCENTAGE },
            borders: { top: thinBorder, bottom: thinBorder, left: thinBorder, right: noBorder },
            children: [new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: row[1], size: 18, font: 'Calibri', color: '0f0f0e' })] })],
          }),
        ],
      })),
    }));

    children.push(new Paragraph({ pageBreakBefore: true, children: [new TextRun({ text: '' })] }));

    // ── WEEKS ──────────────────────────────────────────────────
    (d.weeks || []).forEach((week) => {
      children.push(new Paragraph({
        spacing: { before: 400, after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: '0f0f0e' } },
        children: [
          new TextRun({ text: 'WEEK ' + week.num, size: 18, font: 'Calibri', bold: true, color: '888888', allCaps: true }),
          new TextRun({ text: '   ' + (week.theme || '').toUpperCase(), size: 22, font: 'Calibri', bold: true, color: '0f0f0e', allCaps: true }),
        ],
      }));

      if (week.focus) {
        children.push(new Paragraph({
          spacing: { before: 100, after: 60 },
          children: [new TextRun({ text: week.focus, size: 20, font: 'Calibri', color: '666666', italics: true })],
        }));
      }
      if (week.milestone) {
        children.push(new Paragraph({
          spacing: { before: 0, after: 240 },
          children: [
            new TextRun({ text: 'Milestone: ', size: 18, font: 'Calibri', bold: true, color: '16a34a' }),
            new TextRun({ text: week.milestone, size: 18, font: 'Calibri', color: '16a34a' }),
          ],
        }));
      }

      (week.processes || []).forEach((proc) => {
        // Process header: area + title + owner + duration
        const ownerStr = proc.owner ? '  [' + proc.owner + ']' : '';
        const durStr = proc.duration ? '  ' + proc.duration : '';
        children.push(new Paragraph({
          spacing: { before: 280, after: 60 },
          children: [
            new TextRun({ text: (proc.area || '').toUpperCase(), size: 14, font: 'Calibri', bold: true, color: '888888' }),
            new TextRun({ text: '   ' + (proc.title || ''), size: 22, font: 'Calibri', bold: true, color: '0f0f0e' }),
            new TextRun({ text: ownerStr + durStr, size: 16, font: 'Calibri', color: '888888' }),
          ],
        }));

        if (proc.navPath) {
          children.push(new Paragraph({
            spacing: { before: 0, after: 100 },
            children: [
              new TextRun({ text: 'Navigation: ', size: 18, font: 'Calibri', bold: true, color: '555555' }),
              new TextRun({ text: proc.navPath, size: 18, font: 'Calibri', color: '333333' }),
            ],
          }));
        }

        if (proc.depends && proc.depends !== 'null') {
          children.push(new Paragraph({
            spacing: { before: 0, after: 100 },
            children: [
              new TextRun({ text: 'Depends on: ', size: 18, font: 'Calibri', bold: true, color: '888888' }),
              new TextRun({ text: String(proc.depends), size: 18, font: 'Calibri', color: '555555', italics: true }),
            ],
          }));
        }

        (proc.steps || []).forEach((step, si) => {
          children.push(new Paragraph({
            spacing: { before: 60, after: 60 },
            indent: { left: 360 },
            children: [
              new TextRun({ text: '☐  ' + String(si + 1) + '.  ', size: 19, font: 'Calibri', bold: true, color: '0f0f0e' }),
              new TextRun({ text: step, size: 19, font: 'Calibri', color: '333333' }),
            ],
          }));
        });

        if (proc.output) {
          children.push(new Paragraph({
            spacing: { before: 100, after: 60 },
            children: [
              new TextRun({ text: 'OUTPUT: ', size: 17, font: 'Calibri', bold: true, color: '16a34a' }),
              new TextRun({ text: proc.output, size: 17, font: 'Calibri', color: '166534' }),
            ],
          }));
        }
        if (proc.gotcha && proc.gotcha !== 'null') {
          children.push(new Paragraph({
            spacing: { before: 60, after: 120 },
            children: [
              new TextRun({ text: 'WATCH OUT: ', size: 17, font: 'Calibri', bold: true, color: '92400e' }),
              new TextRun({ text: String(proc.gotcha), size: 17, font: 'Calibri', color: '92400e' }),
            ],
          }));
        }
      });

      children.push(spacer());
    });

    children.push(new Paragraph({
      spacing: { before: 640 },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: (d.client || '') + '  |  EX3 Confidential  |  Generated by EX3 Implementation HQ', size: 16, font: 'Calibri', color: 'aaaaaa', italics: true })],
    }));

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="Project_Workbook.docx"');
    res.send(buffer);
  } catch(err) {
    console.error('Workbook export error:', err.message);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Request a Guide — generation
app.post('/consultant/implementation-hq/request-guide', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const prompt = `You are a senior SmartRecruiters implementation consultant creating a professional knowledge guide. A colleague has described their situation below. Search the implementation documents thoroughly and produce a focused, practical guide.

Situation: ${query}

RULES — follow these exactly:
- Every piece of advice must come directly from the implementation documents — no generic project management advice
- Be specific: name exact SmartRecruiters features, settings, menu paths, field names, and button labels
- Be concise: every sentence must earn its place — no filler, no repetition, no waffle
- Explain what things ARE before telling the person what to DO — write for someone doing this for the first time
- Tone: confident, direct, professional — like advice from a trusted senior colleague, not an AI

Return ONLY a valid JSON object (no markdown, no code fences, no preamble):
{
  "title": "Specific descriptive guide title e.g. 'Running Your First Kickoff Call' or 'Connecting SmartRecruiters to an Onboarding System'",
  "summary": "2-3 sentence plain-English explanation of the topic and why it matters — for someone who has never done this before",
  "sections": [
    {
      "heading": "Section heading e.g. 'What This Is', 'Before You Start', 'How It Works in SmartRecruiters'",
      "content": "3-6 sentences of specific practical guidance drawn from the documents. Name real SmartRecruiters features, settings pages, and terminology. Professional flowing prose — no bullet points inside content."
    }
  ],
  "steps": [
    "Step 1: Specific action with exact SmartRecruiters navigation or context e.g. Go to Main Menu > Settings > Hiring > Hiring Processes and click Create New Process",
    "Step 2: ..."
  ],
  "watchOut": [
    "Specific gotcha or common mistake drawn from the documents — practical, precise, and direct"
  ],
  "whoDoesWhat": [
    { "role": "EX3", "task": "What the consultant owns and delivers in this area" },
    { "role": "Client", "task": "What the client must own, decide, or deliver" }
  ],
  "keyDocs": [
    "Name of a relevant document from the knowledge base this person should read"
  ]
}

Generate 3-4 sections, 5-8 steps, 2-4 watch-outs, 2-4 who-does-what rows, 2-5 key documents.`;

  try {
    const thread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(thread.id, { role: 'user', content: prompt });
    await openai.beta.threads.runs.createAndPoll(thread.id, { assistant_id: process.env.ASSISTANT_ID });

    const messages = await openai.beta.threads.messages.list(thread.id);
    const last = messages.data.find(m => m.role === 'assistant');
    if (!last) return res.status(500).json({ error: 'No response from AI' });

    let raw = (last.content[0]?.text?.value || '').replace(/【[^】]*】/g, '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let data;
    try { data = JSON.parse(raw); }
    catch(e) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) { try { data = JSON.parse(match[0]); } catch(e2) { return res.status(500).json({ error: 'AI returned invalid JSON' }); } }
      else return res.status(500).json({ error: 'AI returned invalid JSON' });
    }

    return res.json(data);
  } catch(err) {
    console.error('Guide generator error:', err.message);
    return res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});

// Request a Guide — Word export
app.post('/consultant/implementation-hq/export-guide', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const d = req.body;
  if (!d || !d.title) return res.status(400).json({ error: 'No guide data' });

  try {
    const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
            AlignmentType, BorderStyle, WidthType, ShadingType } = require('docx');

    const NAVY = '0f0f0e';
    const LIGHT = 'f8f7f4';
    const BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'e4e2dc' };
    const CB = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

    const secHead = (text) => new Paragraph({
      spacing: { before: 400, after: 160 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e4e2dc' } },
      children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 18, font: 'Calibri', color: NAVY, characterSpacing: 80 })],
    });

    const body = (text) => new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({ text: String(text || ''), size: 20, font: 'Calibri', color: '333333' })],
    });

    const children = [];
    const now = new Date();
    const months3 = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const dateStr = now.getDate() + ' ' + months3[now.getMonth()] + ' ' + now.getFullYear();

    // Cover
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 2000, after: 120 }, children: [new TextRun({ text: 'EX3', bold: true, size: 64, font: 'Calibri', color: NAVY })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'Knowledge Guide', size: 28, font: 'Calibri', color: '888888' })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 }, children: [new TextRun({ text: d.title || '', bold: true, size: 48, font: 'Calibri', color: NAVY })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [new TextRun({ text: 'Generated ' + dateStr + '  |  EX3 Implementation HQ', size: 18, font: 'Calibri', color: 'aaaaaa', italics: true })] }));
    children.push(new Paragraph({ pageBreakBefore: true, children: [new TextRun({ text: '' })] }));

    // Summary
    children.push(secHead('Summary'));
    children.push(body(d.summary || ''));

    // Sections
    (d.sections || []).forEach(sec => {
      children.push(secHead(sec.heading || ''));
      children.push(body(sec.content || ''));
    });

    // Steps
    if ((d.steps || []).length) {
      children.push(secHead('Key Steps'));
      d.steps.forEach((step, i) => {
        children.push(new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({ text: String(i + 1) + '.  ', bold: true, size: 20, font: 'Calibri', color: NAVY }),
            new TextRun({ text: String(step || ''), size: 20, font: 'Calibri', color: '333333' }),
          ],
        }));
      });
    }

    // Watch out
    if ((d.watchOut || []).length) {
      children.push(secHead('Watch Out For'));
      d.watchOut.forEach(w => {
        children.push(new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({ text: 'WARNING: ', bold: true, size: 20, font: 'Calibri', color: '92400e' }),
            new TextRun({ text: String(w || ''), size: 20, font: 'Calibri', color: '92400e' }),
          ],
        }));
      });
    }

    // Who does what
    if ((d.whoDoesWhat || []).length) {
      children.push(secHead('Who Does What'));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [
            new TableCell({ width: { size: 20, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: 'f5f4f1', fill: 'f5f4f1' }, borders: CB, children: [new Paragraph({ children: [new TextRun({ text: 'Role', bold: true, size: 20, font: 'Calibri', color: NAVY })] })] }),
            new TableCell({ width: { size: 80, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: 'f5f4f1', fill: 'f5f4f1' }, borders: CB, children: [new Paragraph({ children: [new TextRun({ text: 'Responsibility', bold: true, size: 20, font: 'Calibri', color: NAVY })] })] }),
          ]}),
          ...(d.whoDoesWhat || []).map(r => new TableRow({ children: [
            new TableCell({ width: { size: 20, type: WidthType.PERCENTAGE }, borders: CB, children: [new Paragraph({ children: [new TextRun({ text: String(r.role || ''), bold: true, size: 20, font: 'Calibri', color: NAVY })] })] }),
            new TableCell({ width: { size: 80, type: WidthType.PERCENTAGE }, borders: CB, children: [new Paragraph({ children: [new TextRun({ text: String(r.task || ''), size: 20, font: 'Calibri', color: '333333' })] })] }),
          ]})),
        ],
      }));
    }

    // Key docs
    if ((d.keyDocs || []).length) {
      children.push(secHead('Key Documents'));
      d.keyDocs.forEach((doc, i) => {
        children.push(new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({ text: String(i + 1) + '.  ', bold: true, size: 20, font: 'Calibri', color: '888888' }),
            new TextRun({ text: String(doc || ''), size: 20, font: 'Calibri', color: '333333' }),
          ],
        }));
      });
    }

    // Footer
    children.push(new Paragraph({
      spacing: { before: 640 },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'EX3 Confidential  |  Generated by EX3 Implementation HQ', size: 16, font: 'Calibri', color: 'aaaaaa', italics: true })],
    }));

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="Knowledge_Guide.docx"');
    res.send(buffer);
  } catch(err) {
    console.error('Guide export error:', err.message);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Project Estimator — generate
app.post('/consultant/implementation-hq/project-estimate', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const a = req.body;
  if (!a || !a.package) return res.status(400).json({ error: 'No answers provided' });

  const scopeList = Array.isArray(a.scope) && a.scope.length ? a.scope.join(', ') : 'Not specified';
  const intList = Array.isArray(a.integrations) && a.integrations.length ? a.integrations.join(', ') : 'None';

  const prompt = `You are a senior SmartRecruiters implementation consultant building a project timeline estimate. Using your knowledge of SmartRecruiters implementations, provide a detailed, realistic estimate for the following project:

ENGAGEMENT INPUTS:
- Package: ${a.package}
- Scope: ${scopeList}
- Employee size: ${a.empsize}
- Countries/regions: ${a.countries}
- Languages: ${a.langs}
- Replacing existing ATS: ${a.replacing}
- HRIS integration: ${a.hris}
- Other integrations: ${intList}
- Career site complexity: ${a.careerSite}
- Configuration complexity: ${a.config}
- Go-live approach: ${a.goLiveApproach}
- Client team availability: ${a.clientAvailability}
- Data migration: ${a.migration}
- Fixed deadline: ${a.deadline}
- Consultant team experience: ${a.experience}

Based on these inputs, provide a realistic project timeline estimate. Be specific and honest — if something will add weeks, say so. Do not be optimistic to please, be accurate.

Return ONLY a JSON object with this exact structure:
{
  "package": "${a.package}",
  "scope": ${JSON.stringify(a.scope || [])},
  "totalWeeks": "X–Y",
  "consultantDays": "X–Y",
  "confidence": "High" or "Medium" or "Low",
  "phases": [
    {"name": "Sales Handover & Planning", "weeks": "X–Y"},
    {"name": "Discovery & Workshops", "weeks": "X–Y"},
    {"name": "Configuration", "weeks": "X–Y"},
    {"name": "UAT", "weeks": "X–Y"},
    {"name": "Go-Live & Hypercare", "weeks": "X–Y"}
  ],
  "narrative": "3–4 sentences explaining the key drivers of this estimate and what will determine whether it lands at the shorter or longer end of the range.",
  "risks": ["risk 1", "risk 2", "risk 3", "risk 4", "risk 5"],
  "assumptions": ["assumption 1", "assumption 2", "assumption 3", "assumption 4"]
}

Return only the JSON, no markdown, no extra text.`;

  try {
    if (!process.env.ASSISTANT_ID) return res.status(500).json({ error: 'Assistant not configured' });

    const thread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(thread.id, { role: 'user', content: prompt });
    const run = await openai.beta.threads.runs.createAndPoll(thread.id, { assistant_id: process.env.ASSISTANT_ID });

    if (run.status !== 'completed') return res.status(500).json({ error: 'Assistant run failed: ' + run.status });

    const msgs = await openai.beta.threads.messages.list(thread.id, { order: 'desc', limit: 1 });
    const raw = msgs.data[0]?.content?.[0]?.text?.value || '';
    const clean = raw.replace(/【[^】]*】/g, '').replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch(e) {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else return res.status(500).json({ error: 'Could not parse response' });
    }

    return res.json(parsed);
  } catch(err) {
    console.error('Estimator error:', err.message);
    return res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});

// Project Estimator — Word export
app.post('/consultant/implementation-hq/export-estimate', async (req, res) => {
  const token = req.cookies?.impl_hq_auth;
  if (token !== IMPL_HQ_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const d = req.body;
  if (!d || !d.totalWeeks) return res.status(400).json({ error: 'No estimate data' });

  try {
    const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
            AlignmentType, BorderStyle, WidthType, ShadingType } = require('docx');

    const NAVY = '0f0f0e';
    const BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'e4e2dc' };
    const CB = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

    const secHead = (text) => new Paragraph({
      spacing: { before: 400, after: 160 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e4e2dc' } },
      children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 18, font: 'Calibri', color: NAVY, characterSpacing: 80 })],
    });
    const body = (text) => new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({ text: String(text || ''), size: 20, font: 'Calibri', color: '333333' })],
    });

    const children = [];
    const now = new Date();
    const months4 = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const dateStr = now.getDate() + ' ' + months4[now.getMonth()] + ' ' + now.getFullYear();

    // Cover
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 2000, after: 120 }, children: [new TextRun({ text: 'EX3', bold: true, size: 64, font: 'Calibri', color: NAVY })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'Project Estimator', size: 28, font: 'Calibri', color: '888888' })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 }, children: [new TextRun({ text: (d.totalWeeks || '?') + ' Weeks  —  ' + (d.package || ''), bold: true, size: 40, font: 'Calibri', color: NAVY })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [new TextRun({ text: 'Generated ' + dateStr + '  |  EX3 Implementation HQ', size: 18, font: 'Calibri', color: 'aaaaaa', italics: true })] }));
    children.push(new Paragraph({ pageBreakBefore: true, children: [new TextRun({ text: '' })] }));

    // Summary stats
    children.push(secHead('Estimate Summary'));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [
          new TableCell({ width: { size: 33, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: 'f5f4f1', fill: 'f5f4f1' }, borders: CB, children: [new Paragraph({ children: [new TextRun({ text: 'TOTAL TIMELINE', bold: true, size: 16, font: 'Calibri', color: '999999', characterSpacing: 60 })] })] }),
          new TableCell({ width: { size: 33, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: 'f5f4f1', fill: 'f5f4f1' }, borders: CB, children: [new Paragraph({ children: [new TextRun({ text: 'CONSULTANT DAYS', bold: true, size: 16, font: 'Calibri', color: '999999', characterSpacing: 60 })] })] }),
          new TableCell({ width: { size: 34, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: 'f5f4f1', fill: 'f5f4f1' }, borders: CB, children: [new Paragraph({ children: [new TextRun({ text: 'CONFIDENCE', bold: true, size: 16, font: 'Calibri', color: '999999', characterSpacing: 60 })] })] }),
        ]}),
        new TableRow({ children: [
          new TableCell({ borders: CB, children: [new Paragraph({ children: [new TextRun({ text: (d.totalWeeks || '?') + ' weeks', bold: true, size: 28, font: 'Calibri', color: NAVY })] })] }),
          new TableCell({ borders: CB, children: [new Paragraph({ children: [new TextRun({ text: (d.consultantDays || '?') + ' days', bold: true, size: 28, font: 'Calibri', color: NAVY })] })] }),
          new TableCell({ borders: CB, children: [new Paragraph({ children: [new TextRun({ text: d.confidence || 'Medium', bold: true, size: 28, font: 'Calibri', color: NAVY })] })] }),
        ]}),
      ],
    }));

    // Phase breakdown
    if ((d.phases || []).length) {
      children.push(secHead('Phase Breakdown'));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [
            new TableCell({ width: { size: 60, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: 'f5f4f1', fill: 'f5f4f1' }, borders: CB, children: [new Paragraph({ children: [new TextRun({ text: 'Phase', bold: true, size: 20, font: 'Calibri', color: NAVY })] })] }),
            new TableCell({ width: { size: 40, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: 'f5f4f1', fill: 'f5f4f1' }, borders: CB, children: [new Paragraph({ children: [new TextRun({ text: 'Duration', bold: true, size: 20, font: 'Calibri', color: NAVY })] })] }),
          ]}),
          ...(d.phases || []).map(p => new TableRow({ children: [
            new TableCell({ borders: CB, children: [new Paragraph({ children: [new TextRun({ text: String(p.name || ''), size: 20, font: 'Calibri', color: '333333' })] })] }),
            new TableCell({ borders: CB, children: [new Paragraph({ children: [new TextRun({ text: String(p.weeks || '') + ' weeks', bold: true, size: 20, font: 'Calibri', color: NAVY })] })] }),
          ]})),
        ],
      }));
    }

    // Narrative
    if (d.narrative) {
      children.push(secHead('Assessment'));
      children.push(body(d.narrative));
    }

    // Risks
    if ((d.risks || []).length) {
      children.push(secHead('Key Risks'));
      d.risks.forEach(r => {
        children.push(new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({ text: 'RISK: ', bold: true, size: 20, font: 'Calibri', color: '92400e' }),
            new TextRun({ text: String(r || ''), size: 20, font: 'Calibri', color: '92400e' }),
          ],
        }));
      });
    }

    // Assumptions
    if ((d.assumptions || []).length) {
      children.push(secHead('Assumptions'));
      d.assumptions.forEach((a, i) => {
        children.push(new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({ text: String(i + 1) + '.  ', bold: true, size: 20, font: 'Calibri', color: '888888' }),
            new TextRun({ text: String(a || ''), size: 20, font: 'Calibri', color: '333333' }),
          ],
        }));
      });
    }

    children.push(new Paragraph({
      spacing: { before: 640 },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'EX3 Confidential  |  Generated by EX3 Implementation HQ', size: 16, font: 'Calibri', color: 'aaaaaa', italics: true })],
    }));

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="Project_Estimate.docx"');
    res.send(buffer);
  } catch(err) {
    console.error('Estimate export error:', err.message);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
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


// Web Analytics page
app.all('/analytics/web', requirePassword);
app.get('/analytics/web', (req, res) => {
  const logs = readWebLogs();

  const total = logs.length;
  const errors = logs.filter(l => !l.success).length;
  const uncertain = logs.filter(l => l.uncertain).length;
  const avgMs = total ? Math.round(logs.reduce((s, l) => s + l.ms, 0) / total) : 0;

  // Unique sessions (threadIds)
  const uniqueSessions = new Set(logs.map(l => l.threadId).filter(Boolean)).size;

  // Questions per day
  const byDay = {};
  for (const l of logs) {
    const day = (l.ts || '').slice(0, 10);
    if (day) byDay[day] = (byDay[day] || 0) + 1;
  }

  // Top 10 questions (deduplicated by normalising whitespace + lowercase)
  const qCount = {};
  for (const l of logs) {
    if (!l.question) continue;
    const key = l.question.trim().toLowerCase().replace(/\s+/g, ' ');
    qCount[key] = (qCount[key] || { count: 0, original: l.question });
    qCount[key].count++;
  }
  const top10 = Object.values(qCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Uncertain answers
  const uncertainRows = logs.filter(l => l.uncertain).slice(-20).reverse();

  // Recent 50
  const recent = logs.slice().reverse().slice(0, 50);

  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  const dayRows = Object.entries(byDay).sort().reverse().slice(0, 14)
    .map(([d, c]) => `<tr><td>${d}</td><td><div class="bar-wrap"><div class="bar" style="width:${Math.round(c/Math.max(...Object.values(byDay))*100)}%"></div><span>${c}</span></div></td></tr>`).join('');

  const top10Rows = top10.map((q, i) =>
    `<tr><td class="rank">${i+1}</td><td>${esc(q.original)}</td><td class="cnt">${q.count}</td></tr>`
  ).join('');

  const uncertainHtml = uncertainRows.map(l =>
    `<div class="u-row"><div class="u-q">${esc(l.question)}</div><div class="u-a">${esc((l.answer||'').slice(0,200))}${(l.answer||'').length>200?'…':''}</div><div class="u-ts">${(l.ts||'').replace('T',' ').slice(0,16)}</div></div>`
  ).join('');

  const recentRows = recent.map(l => {
    const status = !l.success ? '<span class="badge err">Error</span>' : l.uncertain ? '<span class="badge unc">Uncertain</span>' : '<span class="badge ok">OK</span>';
    return `<tr>
      <td>${(l.ts||'').replace('T',' ').slice(0,16)}</td>
      <td>${esc(l.question)}</td>
      <td class="preview" onclick="this.classList.toggle('open')" data-full="${esc(l.answer||'')}">${esc((l.answer||'').slice(0,100))}${(l.answer||'').length>100?'<span class="more"> ▾</span>':''}</td>
      <td>${status}</td>
      <td>${((l.ms||0)/1000).toFixed(1)}s</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Chat Analytics</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#f5f4f1;color:#0f0f0e;min-height:100vh}
.topbar{background:#0f0f0e;padding:16px 32px;display:flex;align-items:center;justify-content:space-between}
.topbar-brand{font-size:18px;font-weight:800;color:#fff;letter-spacing:-.02em}
.topbar-nav{display:flex;gap:20px}
.topbar-nav a{font-size:13px;font-weight:600;color:#888;text-decoration:none;transition:color .15s}
.topbar-nav a:hover,.topbar-nav a.active{color:#fff}
.wrap{max-width:1100px;margin:0 auto;padding:32px 24px}
.page-title{font-size:28px;font-weight:800;letter-spacing:-.02em;margin-bottom:8px}
.page-sub{font-size:14px;color:#666;margin-bottom:32px}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-bottom:32px}
.stat{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:20px 24px}
.stat-num{font-size:32px;font-weight:800;color:#0f0f0e;letter-spacing:-.03em;line-height:1}
.stat-label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#888;margin-top:6px}
.stat-err .stat-num{color:#dc2626}
.stat-warn .stat-num{color:#d97706}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px}
.card{background:#fff;border:1px solid #e4e2dc;border-radius:10px;overflow:hidden}
.card-head{padding:16px 20px;border-bottom:1px solid #f0ede8;display:flex;align-items:center;justify-content:space-between}
.card-title{font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#0f0f0e}
.card-body{padding:20px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 14px;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#888;border-bottom:1px solid #e4e2dc}
td{padding:10px 14px;border-bottom:1px solid #f5f4f1;vertical-align:top;color:#333}
tr:last-child td{border-bottom:none}
.rank{font-weight:800;color:#0f0f0e;width:32px}
.cnt{font-weight:700;color:#0f0f0e;text-align:right}
.bar-wrap{display:flex;align-items:center;gap:10px}
.bar{height:8px;background:#0f0f0e;border-radius:4px;min-width:2px}
.bar-wrap span{font-size:12px;font-weight:600;color:#555}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.badge.ok{background:#dcfce7;color:#16a34a}
.badge.err{background:#fee2e2;color:#dc2626}
.badge.unc{background:#fef3c7;color:#d97706}
.u-row{padding:12px 0;border-bottom:1px solid #f5f4f1}
.u-row:last-child{border-bottom:none}
.u-q{font-size:13px;font-weight:600;color:#0f0f0e;margin-bottom:4px}
.u-a{font-size:12px;color:#666;line-height:1.5;margin-bottom:4px}
.u-ts{font-size:11px;color:#aaa}
.preview{cursor:pointer;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.preview.open{white-space:normal;overflow:visible;text-overflow:unset}
.more{color:#0f0f0e;font-size:11px}
.full-card{margin-bottom:24px}
@media(max-width:700px){.stats{grid-template-columns:1fr 1fr}.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-brand">ex3 — Analytics</div>
  <div class="topbar-nav">
    <a href="/analytics">WhatsApp</a>
    <a href="/analytics/web" class="active">Web Chat</a>
    <a href="/conversations">Conversations</a>
  </div>
</div>
<div class="wrap">
  <div class="page-title">Web Chat Analytics</div>
  <div class="page-sub">All questions asked to the EX3 AI assistant via the website chatbot</div>

  <div class="stats">
    <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Total Questions</div></div>
    <div class="stat"><div class="stat-num">${uniqueSessions}</div><div class="stat-label">Unique Sessions</div></div>
    <div class="stat"><div class="stat-num">${avgMs > 0 ? (avgMs/1000).toFixed(1)+'s' : '—'}</div><div class="stat-label">Avg Response Time</div></div>
    <div class="stat stat-warn"><div class="stat-num">${uncertain}</div><div class="stat-label">Uncertain Answers</div></div>
    <div class="stat stat-err"><div class="stat-num">${errors}</div><div class="stat-label">Errors</div></div>
  </div>

  <div class="grid2">
    <div class="card">
      <div class="card-head"><div class="card-title">Top 10 Questions Asked</div></div>
      <table>
        <thead><tr><th>#</th><th>Question</th><th style="text-align:right">Asked</th></tr></thead>
        <tbody>${top10Rows || '<tr><td colspan="3" style="color:#aaa;text-align:center;padding:24px">No data yet</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title">Questions Per Day</div></div>
      <table>
        <thead><tr><th>Date</th><th>Volume</th></tr></thead>
        <tbody>${dayRows || '<tr><td colspan="2" style="color:#aaa;text-align:center;padding:24px">No data yet</td></tr>'}</tbody>
      </table>
    </div>
  </div>

  ${uncertainRows.length ? `<div class="card full-card">
    <div class="card-head"><div class="card-title">Uncertain Answers — Review These</div><span style="font-size:12px;color:#d97706;font-weight:600">${uncertain} total</span></div>
    <div class="card-body">${uncertainHtml}</div>
  </div>` : ''}

  <div class="card full-card">
    <div class="card-head"><div class="card-title">Recent Questions</div><span style="font-size:12px;color:#888">Last 50</span></div>
    <table>
      <thead><tr><th>Time</th><th>Question</th><th>Answer</th><th>Status</th><th>Speed</th></tr></thead>
      <tbody>${recentRows || '<tr><td colspan="5" style="color:#aaa;text-align:center;padding:24px">No data yet</td></tr>'}</tbody>
    </table>
  </div>
</div>
</body></html>`);
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
