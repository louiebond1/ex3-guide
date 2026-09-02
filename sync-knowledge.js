#!/usr/bin/env node
/**
 * sync-knowledge.js
 * Uploads all .txt files in ./knowledge-docs/ to the OpenAI Assistant's vector store.
 * Usage: OPENAI_API_KEY=sk-... ASSISTANT_ID=asst_... node sync-knowledge.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const DOCS_DIR = path.join(__dirname, 'knowledge-docs');

if (!API_KEY) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }
if (!ASSISTANT_ID) { console.error('Missing ASSISTANT_ID'); process.exit(1); }

async function apiCall(method, path, body, isMultipart, boundary) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${API_KEY}`,
      'OpenAI-Beta': 'assistants=v2',
    };
    if (isMultipart) {
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const bodyData = isMultipart ? body : (body ? Buffer.from(JSON.stringify(body)) : null);
    if (bodyData) headers['Content-Length'] = bodyData.length;

    const req = https.request({
      hostname: 'api.openai.com',
      path: `/v1${path}`,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

function buildMultipart(boundary, filename, content) {
  const CRLF = '\r\n';
  const purposePart = `--${boundary}${CRLF}Content-Disposition: form-data; name="purpose"${CRLF}${CRLF}assistants${CRLF}`;
  const fileHeader = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: text/plain${CRLF}${CRLF}`;
  const closing = `${CRLF}--${boundary}--`;

  return Buffer.concat([
    Buffer.from(purposePart),
    Buffer.from(fileHeader),
    Buffer.from(content),
    Buffer.from(closing),
  ]);
}

async function main() {
  console.log(`\n🔍 Getting assistant ${ASSISTANT_ID}...`);
  const assistant = await apiCall('GET', `/assistants/${ASSISTANT_ID}`);
  if (assistant.error) { console.error('Assistant error:', assistant.error); process.exit(1); }
  console.log(`✅ Assistant found: ${assistant.name || assistant.id}`);

  // Get vector store IDs from assistant
  const vsIds = assistant.tool_resources?.file_search?.vector_store_ids || [];
  let vectorStoreId;

  if (vsIds.length > 0) {
    vectorStoreId = vsIds[0];
    console.log(`📦 Using existing vector store: ${vectorStoreId}`);
  } else {
    console.log('📦 No vector store found — creating one...');
    const vs = await apiCall('POST', '/vector_stores', { name: 'EX3 Implementation Knowledge Base' });
    vectorStoreId = vs.id;
    console.log(`✅ Created vector store: ${vectorStoreId}`);

    console.log('🔗 Attaching vector store to assistant...');
    await apiCall('POST', `/assistants/${ASSISTANT_ID}`, {
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } }
    });
    console.log('✅ Attached');
  }

  // Get all .txt files in knowledge-docs/
  const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.txt'));
  console.log(`\n📄 Found ${files.length} documents to upload\n`);

  // Check what's already in the vector store
  const existingFiles = await apiCall('GET', `/vector_stores/${vectorStoreId}/files?limit=100`);
  const existingNames = new Set();
  if (existingFiles.data) {
    for (const vf of existingFiles.data) {
      try {
        const fileInfo = await apiCall('GET', `/files/${vf.id}`);
        if (fileInfo.filename) existingNames.add(fileInfo.filename);
      } catch {}
    }
  }
  console.log(`Already in vector store: ${existingNames.size} files\n`);

  let uploaded = 0;
  let skipped = 0;

  for (const filename of files) {
    if (existingNames.has(filename)) {
      console.log(`⏭️  Skipping (already uploaded): ${filename}`);
      skipped++;
      continue;
    }

    const content = fs.readFileSync(path.join(DOCS_DIR, filename), 'utf8');
    const boundary = `----FormBoundary${Date.now()}`;
    const body = buildMultipart(boundary, filename, content);

    process.stdout.write(`⬆️  Uploading: ${filename}...`);
    const uploaded_file = await apiCall('POST', '/files', body, true, boundary);

    if (uploaded_file.error || !uploaded_file.id) {
      console.log(` ❌ Failed: ${JSON.stringify(uploaded_file.error || uploaded_file)}`);
      continue;
    }

    // Add to vector store
    const vsFile = await apiCall('POST', `/vector_stores/${vectorStoreId}/files`, { file_id: uploaded_file.id });
    if (vsFile.error) {
      console.log(` ❌ Vector store add failed: ${JSON.stringify(vsFile.error)}`);
    } else {
      console.log(` ✅ Done (file: ${uploaded_file.id})`);
      uploaded++;
    }
  }

  console.log(`\n✅ Upload complete: ${uploaded} new files uploaded, ${skipped} skipped (already present)`);
  console.log(`📦 Vector store: ${vectorStoreId}`);
  console.log('\nThe AI Coach will now have access to all uploaded documents.\n');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
