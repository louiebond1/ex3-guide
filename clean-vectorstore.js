require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID || 'vs_69d8b72477a88191a5c3e9e0304a37ee';

// Files to remove: SAP SuccessFactors Recruiting (old system) docs + personal travel docs
// These are confusing the chatbot into giving SAP SF answers instead of SmartRecruiters answers
const REMOVE_PATTERNS = [
  // SAP SuccessFactors Recruiting-specific docs (numbered training series)
  /^1\. Planning an SAP SuccessFactors/i,
  /^2\. Creating and Modifying Job Requisitions/i,
  /^3\. Configuring and Modifying Candidate Profiles/i,
  /^4\. Creating and Modifying Candidate Applications/i,
  /^5\. Advertising Jobs/i,
  /^6\. Managing Candidates Through the Screening Process/i,
  /^7\. Creating Job Offers/i,
  /^8\. Creating and Maintaining Emails and Notifications/i,
  /^9\. Maintaining the SAP SuccessFactors Recruiting System/i,
  // SAP SuccessFactors Career Site Builder docs
  /^designing the career site/i,
  /^Moving the Career Site to Production/i,
  /^engaging potential candidates/i,
  /^Preparing for an SAP SuccessFactors Career Site Builder/i,
  /^Gathering the Customer/i,
  /^Building the Career Site/i,
  /^Completing the Initial Setup of the Recruiting System/i,
  // SAP platform intro
  /^SAP SuccessFactors Platform Introduction Academy/i,
  // Personal travel docs
  /^trip itenarary/i,
  /^spain_itinerary/i,
];

function shouldRemove(filename) {
  return REMOVE_PATTERNS.some(p => p.test(filename));
}

async function listAllFiles() {
  const files = [];
  let after = undefined;
  while (true) {
    const page = await openai.vectorStores.files.list(VECTOR_STORE_ID, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    files.push(...page.data);
    if (!page.has_more) break;
    after = page.data[page.data.length - 1].id;
  }
  return files;
}

async function getFileName(fileId) {
  try {
    const f = await openai.files.retrieve(fileId);
    return f.filename;
  } catch {
    return fileId;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('DRY RUN — no files will actually be removed\n');

  console.log(`Listing files in vector store ${VECTOR_STORE_ID}...`);
  const vsFiles = await listAllFiles();
  console.log(`Found ${vsFiles.length} files in vector store\n`);

  const toRemove = [];
  const toKeep = [];

  for (const vsFile of vsFiles) {
    const name = await getFileName(vsFile.id);
    if (shouldRemove(name)) {
      toRemove.push({ id: vsFile.id, name });
    } else {
      toKeep.push({ id: vsFile.id, name });
    }
  }

  console.log(`FILES TO REMOVE (${toRemove.length}):`);
  toRemove.forEach(f => console.log(`  ✗ ${f.name}`));
  console.log(`\nFILES TO KEEP (${toKeep.length})`);

  if (toRemove.length === 0) {
    console.log('\nNothing to remove.');
    return;
  }

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to actually remove these files.');
    return;
  }

  console.log('\nRemoving files from vector store...');
  let removed = 0;
  for (const f of toRemove) {
    try {
      await openai.vectorStores.files.del(VECTOR_STORE_ID, f.id);
      console.log(`  Removed: ${f.name}`);
      removed++;
    } catch (e) {
      console.log(`  FAILED to remove ${f.name}: ${e.message}`);
    }
  }

  console.log(`\n✅ Done — removed ${removed}/${toRemove.length} files from vector store`);
  console.log(`Vector store now has approximately ${toKeep.length} files`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
