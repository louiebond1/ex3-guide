(function(){ var d=document.getElementById('_dbg'); if(d) d.remove(); })();
// ── Page navigation ──────────────────────────────────────────────
var _PIN_PAGES = ['estimator', 'sowbuilder', 'discovery'];
var _pinTarget = null;
var _pinBuffer = '';
var _logoTaps = 0;
var _logoTapTimer = null;

// Auto-reveal if already unlocked this session
(function() {
  if (sessionStorage.getItem('impl_hq_unlocked')) revealLockedNav();
})();

function revealLockedNav() {
  document.querySelectorAll('.sb-locked').forEach(function(el) { el.style.display = ''; });
}

// Logo tap counter — 5 taps within 3s opens the PIN modal
document.addEventListener('DOMContentLoaded', function() {
  var logo = document.getElementById('sb-logo-tap');
  if (!logo) return;
  logo.addEventListener('click', function() {
    _logoTaps++;
    clearTimeout(_logoTapTimer);
    if (_logoTaps >= 5) {
      _logoTaps = 0;
      if (sessionStorage.getItem('impl_hq_unlocked')) {
        // Re-lock: hide items, clear session, navigate away if on a locked page
        sessionStorage.removeItem('impl_hq_unlocked');
        document.querySelectorAll('.sb-locked').forEach(function(el) { el.style.display = 'none'; });
        var active = document.querySelector('.page.active');
        if (active && _PIN_PAGES.indexOf(active.id.replace('page-', '')) !== -1) {
          _doShowPage('dashboard');
        }
      } else {
        _pinTarget = null;
        showPinModal();
      }
      return;
    }
    _logoTapTimer = setTimeout(function() { _logoTaps = 0; }, 3000);
  });
});

function showPage(id) {
  if (_PIN_PAGES.indexOf(id) !== -1 && !sessionStorage.getItem('impl_hq_unlocked')) {
    _pinTarget = id;
    showPinModal();
    return;
  }
  _doShowPage(id);
}

function _doShowPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  const items = document.querySelectorAll('.sb-item');
  items.forEach(i => { if (i.getAttribute('onclick') && i.getAttribute('onclick').includes("'" + id + "'")) i.classList.add('active'); });
  window.scrollTo(0,0);
}

function showPinModal() {
  _pinBuffer = '';
  updatePinDots();
  document.getElementById('pin-error').textContent = '';
  document.getElementById('pin-modal').classList.add('pin-active');
}

function hidePinModal() {
  document.getElementById('pin-modal').classList.remove('pin-active');
  _pinBuffer = '';
  _pinTarget = null;
}

function pinOverlayClick(e) {
  if (e.target === document.getElementById('pin-modal')) hidePinModal();
}

function updatePinDots() {
  for (var i = 0; i < 4; i++) {
    var dot = document.getElementById('pd' + i);
    if (dot) dot.className = 'pin-dot' + (_pinBuffer.length > i ? ' filled' : '');
  }
}

function pinKey(digit) {
  if (_pinBuffer.length >= 4) return;
  _pinBuffer += digit;
  updatePinDots();
  if (_pinBuffer.length === 4) {
    setTimeout(checkPin, 120);
  }
}

function pinDel() {
  _pinBuffer = _pinBuffer.slice(0, -1);
  updatePinDots();
  document.getElementById('pin-error').textContent = '';
}

function checkPin() {
  if (_pinBuffer === '1703') {
    sessionStorage.setItem('impl_hq_unlocked', '1');
    revealLockedNav();
    hidePinModal();
    if (_pinTarget) _doShowPage(_pinTarget);
    else _doShowPage('estimator');
  } else {
    document.getElementById('pin-error').textContent = 'Incorrect PIN — try again';
    _pinBuffer = '';
    updatePinDots();
  }
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

try { buildTimeline(); } catch(e) {}

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
try { buildPlaybooks(); } catch(e) {}

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
try { buildVault(); } catch(e) {}

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
  { phase:'SAP SF', color:'#b91c1c', title:'SF data sync is irreversible — test in sandbox first', detail:'Once SuccessFactors syncs data into SmartRecruiters, it cannot be undone without raising a support case. Always run and validate the sync in sandbox before enabling in production. A bad production sync can corrupt your user base.' },
  { phase:'SAP SF', color:'#b91c1c', title:'Instance refresh will break the SR-SF integration', detail:'Refreshing the SF instance resets the integration config. If the client plans an instance refresh at any point during the project, the SmartRecruiters integration will need to be fully reconfigured from scratch. Flag this at discovery.' },
  { phase:'SAP SF', color:'#b91c1c', title:'SF user sync disables manual user creation in SR', detail:'Once the SF-to-SR user sync is enabled, SmartRecruiters will block manual user creation. All users must come through the sync. Inform the client before enabling — any users not in SF will lose access.' },
  { phase:'SAP SF', color:'#b91c1c', title:'User sync can take several hours to appear', detail:'After triggering a sync, records can take hours to appear in SmartRecruiters — this is expected behaviour, not a failure. Do not trigger a second sync or raise a support case prematurely. Build this wait time into go-live plans.' },
  { phase:'SAP SF', color:'#b91c1c', title:'Winston Chat is SAP-delivered — EX3 does not own it', detail:'Winston Chat (the SF-to-SR chat integration) is configured and delivered by SAP, not EX3. Any issues or delays are on SAP\'s timeline. Set client expectations early and do not let them assume EX3 can fix or accelerate it.' },
  { phase:'SAP SF', color:'#b91c1c', title:'Coexistence locks clients into one requisition type', detail:'SF Coexistence mode forces clients to choose: all requisitions come from SF, or none do. You cannot mix SF-created and SR-created requisitions in the same instance once coexistence is enabled. This is a one-way door.' },
  { phase:'SAP SF', color:'#b91c1c', title:'Data migration from legacy ATS is not standard scope', detail:'Historical candidate and requisition data migration is explicitly out of scope for a standard SmartRecruiters implementation. If the client expects it, it requires a separate scoping exercise and a Change Request. Do not assume it is included.' },
  { phase:'SAP SF', color:'#b91c1c', title:'Position-to-Job mapping is largely manual', detail:'The Position-to-Job mapping between SF and SR requires manual mapping for most fields. It is not an automatic field-for-field sync. Budget discovery and build time for this — complex org structures can significantly increase the effort.' },
  { phase:'SAP SF', color:'#b91c1c', title:'Marketplace integrations require a SAP support ticket', detail:'Activating any integration from the SAP Marketplace (e.g. pre-packaged connectors) requires raising a ticket with SAP Support — EX3 cannot activate these directly. Factor in SAP support SLA times when planning the project timeline.' },
  { phase:'SAP SF', color:'#b91c1c', title:'SF provisioning takes 3–5 business days', detail:'Provisioning a new SAP SuccessFactors environment is not instant. Allow 3–5 business days from SAP confirming the order. If the client does not have a live licence confirmed at kickoff, this delay flows directly into the project timeline.' },
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
try { buildGotchas(); } catch(e) {}

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
try { buildIntegrations(); } catch(e) {}

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
  var assistantEl = appendAIMsg('assistant', '…');
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
  return String(text || '')
    .replace(/【[^】]*】/g, '')
    .replace(/\n?\s*(FOLLOW\s*UPS?|FOLLOW[- ]?UP QUESTIONS?|SUGGESTED QUESTIONS)\s*:[\s\S]*$/i, '')
    .replace(/\\*\\*(.*?)\\*\\*/g, '$1')
    .replace(/^(.{1,120}?):\s+-\s+/s, '$1:<br>- ')
    .replace(/\s+-\s+/g, '<br>- ')
    .replace(/\n/g, '<br>');
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

// Scoring maps — mirror server.js exactly so live panel matches final result
var _EST = {
  baseline: { 'Essentials Lite': 35, 'Standard': 40, 'Enterprise': 55, 'Not sure yet': 40 },
  hris:     { 'No HRIS integration': 0, 'Workday': 5, 'SAP SuccessFactors': 5, 'Oracle HCM': 7, 'Other HRIS': 3 },
  ints:     { 'Custom / bespoke integration': 3, 'Onboarding system integration': 2, 'Background check integration': 1, 'Assessment / testing integration': 1, 'LinkedIn integration': 1, 'Job board integrations': 0, 'GDPR / consent management tool': 0 },
  careerSite: { 'Career site not in scope': 0, 'Standard template, minimal changes': 1, 'Light customisation required': 3, 'Full custom build required': 10 },
  config:   { 'Minimal — mostly out-of-the-box': 0, 'Moderate — some custom fields and workflows': 3, 'Heavy — extensive custom setup': 10 },
  countries:{ '1 country': 0, '2–5 countries': 3, '6–20 countries': 7, '20+ countries': 12 },
  langs:    { '1 language (English only)': 0, '2–3 languages': 1, '4+ languages': 5 },
  empsize:  { 'Under 100': 0, '100–500': 0, '500–2,000': 1, '2,000–10,000': 3, '10,000+': 5 },
  avail:    { 'Dedicated — full-time project team on the client side': -3, 'Moderate — mostly available when needed': 0, 'Limited — client team is part-time on this project': 12 },
  exp:      { 'No prior SmartRecruiters experience': 5, 'Some exposure to SmartRecruiters': 2, 'Experienced with SmartRecruiters implementations': 0 },
  scope:    { 'Core Recruiting': 0, 'Career Site': 0, 'CRM / Talent Pools': 3, 'Offer Management': 2, 'Analytics': 1, 'SSO / SCIM': 1, 'Multilingual Support': 1, 'Mobile': 0 }
};

function estCalcLive() {
  var panel = document.getElementById('est-live-panel');
  if (!panel) return;

  var rows = [], raw = 0;

  function add(tag, label, days) {
    rows.push({ tag: tag, label: label, days: days });
    raw += days;
  }

  // Package baseline
  var pkg = estGetVal('package');
  if (pkg && _EST.baseline[pkg]) add('base', 'Package: ' + pkg, _EST.baseline[pkg]);

  // Scope extras
  estGetChecks('#est-s1 input[type=checkbox]').forEach(function(s) {
    var d = _EST.scope[s] || 0;
    if (d) add('config', s, d);
  });

  // Client profile
  var emp = estGetVal('empsize');
  if (emp && _EST.empsize[emp]) add('complexity', emp, _EST.empsize[emp]);

  var ctry = estGetVal('countries');
  if (ctry && _EST.countries[ctry]) add('config', ctry, _EST.countries[ctry]);

  var lng = estGetVal('langs');
  if (lng && _EST.langs[lng]) add('config', lng, _EST.langs[lng]);

  if (estGetVal('replacing') && estGetVal('replacing').indexOf('Yes') === 0) add('complexity', 'Replacing existing ATS', 1);

  // Integrations & tech
  var hris = estGetVal('hris');
  if (hris && _EST.hris[hris]) add('integration', 'HRIS: ' + hris, _EST.hris[hris]);

  estGetChecks('#est-s3 input[type=checkbox]').forEach(function(i) {
    var d = _EST.ints[i] || 0;
    if (d) add('integration', i, d);
  });

  var cs = estGetVal('csite');
  if (cs && _EST.careerSite[cs]) add('config', 'Career site (' + cs.split(',')[0].split(' ').slice(0,2).join(' ') + ')', _EST.careerSite[cs]);

  var cfg = estGetVal('config');
  if (cfg && _EST.config[cfg]) add('config', 'Config complexity: ' + cfg.split(' ')[0], _EST.config[cfg]);

  // Delivery
  var gl = estGetVal('golive');
  if (gl && gl.indexOf('Phased') === 0) add('goLive', 'Phased go-live', 3);

  var av = estGetVal('avail');
  if (av && _EST.avail[av] !== undefined && _EST.avail[av] !== 0) add('pm', 'Client availability: ' + av.split(' ')[0], _EST.avail[av]);

  if (estGetVal('migration') && estGetVal('migration').indexOf('Yes') === 0) add('config', 'Data migration', 5);

  var xp = estGetVal('experience');
  if (xp && _EST.exp[xp]) add('pm', 'Team experience (first-time)', _EST.exp[xp]);

  // Consultant tiers
  var pc = function(v) { var m = String(v||'0').match(/\d+/); return m ? parseInt(m[0]) : 0; };
  var nSr = pc(estGetVal('sr-lead')), nLd = pc(estGetVal('lead')), nCo = pc(estGetVal('consultant')), nJr = pc(estGetVal('junior'));
  var total = nSr + nLd + nCo + nJr;
  var tadj = nSr*-6 + nLd*-4 + nCo*-2 + nJr*-1
    + Math.max(0, nJr - (nSr+nLd+nCo))*2
    + ((nSr===0 && nLd===0 && total>1) ? 5 : 0);
  if (tadj !== 0) add('team', 'Consultant team', tadj);

  // Clamp
  var wks = Math.min(Math.max(Math.round(raw / 5), 8), 32);

  // Render
  var weeksEl = document.getElementById('elp-weeks');
  var rowsEl  = document.getElementById('elp-rows');
  var rawEl   = document.getElementById('elp-raw');
  if (!weeksEl || !rowsEl) return;

  if (rows.length === 0) {
    panel.classList.remove('elp-active');
    return;
  }
  panel.classList.add('elp-active');

  weeksEl.innerHTML = wks + ' <span>weeks</span>';
  rowsEl.innerHTML = rows.map(function(r) {
    var sign = r.days > 0 ? '+' : '';
    return '<div class="elp-row"><span class="elp-tag elp-tag-' + r.tag + '">' + r.tag + '</span>'
      + '<span class="elp-lbl">' + r.label + '</span>'
      + '<span class="elp-val' + (r.days < 0 ? ' neg' : '') + '">' + sign + r.days + 'd</span></div>';
  }).join('');

  rawEl.style.display = '';
  rawEl.textContent = 'Raw: ' + raw + 'd → ' + (raw/5).toFixed(1) + ' weeks → clamped to ' + wks + ' weeks (floor 8, ceiling 32)';
}

// Wire live calc to every input change in the estimator
document.addEventListener('change', function(e) {
  if (e.target.closest && e.target.closest('.est-wrap')) estCalcLive();
});

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
  if(!estGetVal('sr-lead')){ alert('Please select the number of Senior Leads.'); return; }
  if(!estGetVal('lead')){ alert('Please select the number of Leads.'); return; }
  if(!estGetVal('consultant')){ alert('Please select the number of Consultants.'); return; }
  if(!estGetVal('junior')){ alert('Please select the number of Juniors.'); return; }
  var _teamTotal = ['sr-lead','lead','consultant','junior'].reduce(function(s,n){ return s + (parseInt(estGetVal(n)) || 0); }, 0);
  if(_teamTotal === 0){ alert('At least one consultant must be assigned to the project.'); return; }
  if(!estGetVal('dedicatedpm')){ alert('Please indicate if a dedicated Project Manager is required.'); return; }

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
    experience: estGetVal('experience'),
    srLead: estGetVal('sr-lead'),
    lead: estGetVal('lead'),
    consultant: estGetVal('consultant'),
    junior: estGetVal('junior'),
    dedicatedPM: estGetVal('dedicatedpm')
  };

  for(var i = 1; i <= 4; i++){
    var el = document.getElementById('est-s' + i);
    if(el) el.style.display = 'none';
  }
  document.getElementById('est-step-count').style.display = 'none';
  document.getElementById('est-progress').parentElement.style.display = 'none';
  var livePanel = document.getElementById('est-live-panel');
  if (livePanel) livePanel.style.display = 'none';
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
    var reason = e.message && e.message !== 'failed' ? e.message : 'The AI could not generate an estimate. Please check your inputs and try again.';
    loadEl.innerHTML = '<div style="padding:24px 0"><p style="color:#e55;font-weight:700;font-size:15px;margin:0 0 8px">Could not generate estimate</p><p style="color:#888;font-size:13px;margin:0 0 20px">' + reason + '</p><button onclick="estReset()" style="padding:10px 20px;background:#fff;border:none;border-radius:8px;color:#0f0f0f;font-weight:700;cursor:pointer;font-size:13px">Start over</button></div>';
    loadEl.style.display = 'flex';
  })
  .finally(function(){ document.getElementById('est-submit-btn').disabled = false; });
}

function renderEstimate(d) {
  document.getElementById('est-headline').textContent = (d.totalWeeks || '?') + ' weeks';
  var confCls = d.confidence === 'High' ? 'est-conf-high' : d.confidence === 'Low' ? 'est-conf-low' : 'est-conf-med';
  document.getElementById('est-sub').textContent = d.package + '  ·  ' + (d.scope && d.scope.length ? d.scope.join(', ') : '');
  document.getElementById('est-stat-weeks').textContent = d.totalWeeks || '?';
  document.getElementById('est-stat-cdays').textContent = d.consultantDays || '—';
  var cdaysUnit = document.getElementById('est-stat-cdays-unit');
  if (cdaysUnit) {
    var n = parseInt(d.teamSize || '0', 10);
    cdaysUnit.textContent = n === 0 ? 'no team selected' : n === 1 ? 'days for this consultant' : 'avg days per consultant (' + n + ' total)';
  }
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

/* ── Discovery Builder ── */
var _discText = '';
var _discAnswers = null;

function discToggle(id) {
  document.getElementById('disc-' + id).classList.toggle('open');
}

function _discChecked(groupId) {
  var checks = document.querySelectorAll('#' + groupId + ' input[type=checkbox]:checked');
  return Array.from(checks).map(function(c){ return c.value; }).join(', ') || 'None selected';
}

function _discRadio(name) {
  var el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : 'Not specified';
}

function _discVal(id) {
  var el = document.getElementById(id);
  return el ? (el.value.trim() || 'Not specified') : 'Not specified';
}

async function generateDiscovery() {
  var company = document.getElementById('d-company').value.trim();
  if (!company) { document.getElementById('d-company').focus(); return; }

  var answers = {
    company: company,
    industry: _discVal('d-industry'),
    hq: _discVal('d-hq'),
    countries: _discVal('d-countries'),
    headcount: _discVal('d-headcount'),
    volume: _discVal('d-volume'),
    entities: _discVal('d-entities'),
    peaks: _discVal('d-peaks'),
    rollout: _discVal('d-rollout'),
    languages: _discVal('d-langs'),
    driver: _discVal('d-driver'),
    currentATS: _discVal('d-currentats'),
    hris: _discVal('d-hris'),
    painpoints: _discVal('d-painpoints'),
    payroll: _discVal('d-payroll'),
    calendar: _discVal('d-calendar'),
    bgcheck: _discVal('d-bgcheck'),
    assess: _discVal('d-assess'),
    esign: _discVal('d-esign'),
    idp: _discVal('d-idp'),
    othersystems: _discVal('d-othersystems'),
    processTypes: _discChecked('d-processtypes'),
    processdesc: _discVal('d-processdesc'),
    numprocesses: _discVal('d-numprocesses'),
    jobtemplates: _discVal('d-jobtemplates'),
    offertemplates: _discVal('d-offertemplates'),
    jobapproval: _discVal('d-jobapproval'),
    offerapproval: _discVal('d-offerapproval'),
    interviewtypes: _discChecked('d-interviewtypes'),
    selfschedule: _discVal('d-selfschedule'),
    scorecards: _discVal('d-scorecards'),
    agencyportal: _discRadio('agencyportal'),
    complexprocess: _discVal('d-complexprocess'),
    countryrequirements: _discVal('d-countryrequirements'),
    recruiters: _discVal('d-recruiters'),
    hms: _discVal('d-hms'),
    admins: _discVal('d-admins'),
    sso: _discRadio('sso'),
    internal: _discRadio('internal'),
    access: _discVal('d-access'),
    privacy: _discVal('d-privacy'),
    roles: _discVal('d-roles'),
    workscouncil: _discRadio('workscouncil'),
    integrations: _discChecked('d-integrations'),
    hrisint: _discVal('d-hrisint'),
    jobboards: _discChecked('d-jobboards'),
    boardcontracts: _discRadio('boardcontracts'),
    itlead: _discVal('d-itlead'),
    intblockers: _discVal('d-intblockers'),
    systemchanges: _discVal('d-systemchanges'),
    careersite: _discVal('d-careersite'),
    numsites: _discVal('d-numsites'),
    currentsite: _discVal('d-currentsite'),
    branding: _discRadio('branding'),
    sitelangs: _discVal('d-sitelangs'),
    appform: _discVal('d-appform'),
    screening: _discRadio('screening'),
    eeo: _discRadio('eeo'),
    seo: _discVal('d-seo'),
    dns: _discVal('d-dns'),
    migration: _discVal('d-migration'),
    migrationtypes: _discChecked('d-migrationtypes'),
    migrationvol: _discVal('d-migrationvol'),
    migrationfrom: _discVal('d-migrationfrom'),
    dataquality: _discRadio('dataquality'),
    datacontact: _discVal('d-datacontact'),
    traininggroups: _discChecked('d-traininggroups'),
    trainrecruiters: _discVal('d-trainrecruiters'),
    trainhms: _discVal('d-trainhms'),
    trainloc: _discVal('d-trainloc'),
    trainingformat: _discChecked('d-trainingformat'),
    changeplan: _discRadio('changeplan'),
    ld: _discRadio('ld'),
    trainingnotes: _discVal('d-trainingnotes'),
    metrics: _discChecked('d-metrics'),
    reportdepth: _discRadio('reportdepth'),
    bi: _discVal('d-bi'),
    reportaccess: _discVal('d-reportaccess'),
    compliancereport: _discVal('d-compliancereport'),
    slas: _discVal('d-slas'),
    golive: _discVal('d-golive'),
    deadline: _discVal('d-deadline'),
    sponsor: _discVal('d-sponsor'),
    clientpm: _discVal('d-clientpm'),
    team: _discVal('d-team'),
    uat: _discVal('d-uat'),
    licence: _discVal('d-licence'),
    risks: _discVal('d-risks'),
    outofscope: _discVal('d-outofscope'),
  };

  _discAnswers = answers;

  var btn = document.getElementById('disc-run-btn');
  var resultWrap = document.getElementById('disc-result-wrap');
  var outputEl = document.getElementById('disc-output');
  btn.disabled = true;
  btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Generating...';
  resultWrap.style.display = 'block';
  outputEl.textContent = '';
  _discText = '';

  try {
    var resp = await fetch('/consultant/implementation-hq/generate-discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: answers })
    });
    if (!resp.ok) throw new Error('Server error');
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      var text = decoder.decode(chunk.value, { stream: true });
      _discText += text;
      outputEl.textContent = _discText;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  } catch(e) {
    outputEl.textContent = 'Error generating discovery summary. Please try again.';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> Generate Discovery Summary';
  }
}

function copyDiscovery() {
  if (!_discText) return;
  navigator.clipboard.writeText(_discText).then(function(){
    var btn = document.getElementById('disc-copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(function(){ btn.textContent = 'Copy text'; }, 2000);
  });
}

async function exportDiscovery() {
  if (!_discText) return;
  var company = document.getElementById('d-company').value.trim() || 'Client';
  var btn = document.getElementById('disc-export-btn');
  btn.disabled = true;
  btn.textContent = 'Exporting...';
  try {
    var resp = await fetch('/consultant/implementation-hq/export-discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName: company, discoveryText: _discText })
    });
    if (!resp.ok) throw new Error('Export failed');
    var blob = await resp.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'Discovery - ' + company + ' - SmartRecruiters.docx';
    a.click();
    URL.revokeObjectURL(url);
  } catch(e) {
    alert('Export failed. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download .docx';
  }
}

function discWatch() {
  function g(id) { return document.getElementById(id); }
  function show(id, v) { var el = g(id); if (el) el.style.display = v ? '' : 'none'; }
  function selVal(id) { var el = g(id); return el ? el.value : ''; }
  function hasStr(str, sub) { return str.toLowerCase().indexOf(sub.toLowerCase()) !== -1; }
  function isChecked(groupId, sub) {
    var cbs = document.querySelectorAll('#' + groupId + ' input[type=checkbox]');
    for (var i = 0; i < cbs.length; i++) {
      if (cbs[i].checked && hasStr(cbs[i].value, sub)) return true;
    }
    return false;
  }
  function radioVal(name) { var el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : ''; }

  // Structural: hide/show empty sections
  function updateStructure() {
    show('d-hrisint-wrap', isChecked('d-integrations', 'HRIS'));
    show('d-jobboards-wrap', isChecked('d-integrations', 'Job board'));
    show('d-migration-detail', !hasStr(selVal('d-migration'), 'no migration'));
    show('d-trainrecruiters-wrap', isChecked('d-traininggroups', 'Recruiter'));
    show('d-trainhms-wrap', isChecked('d-traininggroups', 'Hiring Manager'));
  }

  // Warnings + tips: only shown after user changes something
  function updateWarnings() {
    var cal = selVal('d-calendar');
    var exchg = hasStr(cal, 'Exchange') || hasStr(cal, 'Hybrid');
    var selfSched = !hasStr(selVal('d-selfschedule'), 'No ');
    show('d-calendar-warn', exchg);
    show('d-calendar-other', cal === 'Other');
    show('d-selfschedule-warn', exchg && selfSched);
    show('d-hris-other', selVal('d-hris') === 'Other');
    show('d-suggest-hrisint', !hasStr(selVal('d-hris'), 'No HRIS') && !isChecked('d-integrations', 'HRIS'));
    show('d-esign-other', hasStr(selVal('d-esign'), 'Other'));
    show('d-suggest-docusign', hasStr(selVal('d-esign'), 'DocuSign') && !isChecked('d-integrations', 'DocuSign'));
    show('d-idp-other', hasStr(selVal('d-idp'), 'Other'));
    show('d-sso-suggest', hasStr(radioVal('sso'), 'Yes') && !isChecked('d-integrations', 'SSO'));
    show('d-internal-sepsite-info', hasStr(radioVal('internal'), 'separate'));
    show('d-workscouncil-warn', hasStr(radioVal('workscouncil'), 'Yes'));
    show('d-changeplan-warn', hasStr(radioVal('changeplan'), 'No'));
    updateStructure();
  }

  // Progress bar
  function updateProgress() {
    for (var i = 1; i <= 10; i++) {
      var sec = g('disc-s' + i);
      var seg = g('dp' + i);
      if (!sec || !seg) continue;
      var filled = sec.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked').length > 0;
      if (!filled) {
        var ins = sec.querySelectorAll('input:not([type=radio]):not([type=checkbox]), textarea');
        for (var j = 0; j < ins.length; j++) { if (ins[j].value && ins[j].value.trim()) { filled = true; break; } }
      }
      seg.classList.toggle('done', filled);
    }
  }

  var discPage = g('page-discovery');
  if (discPage) {
    discPage.addEventListener('change', function() { updateWarnings(); updateProgress(); });
    discPage.addEventListener('input', updateProgress);
  }

  updateStructure();
  updateProgress();
}

try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', discWatch);
  } else {
    discWatch();
  }
} catch(e) {}

async function exportAnswers() {
  if (!_discAnswers) { alert('Fill in the form first, then click Generate before exporting answers.'); return; }
  var a = _discAnswers;
  var company = a.company || 'Client';
  var lines = [
    'DISCOVERY ANSWERS — ' + company,
    'SmartRecruiters Implementation | EX3',
    new Array(50).join('═'),
    '',
    '1. COMPANY & ORGANISATION',
    '  Company: ' + a.company,
    '  Industry: ' + a.industry,
    '  HQ Country: ' + a.hq,
    '  Countries Hiring In: ' + a.countries,
    '  Total Headcount: ' + a.headcount,
    '  Annual Hiring Volume: ' + a.volume,
    '  Legal / Hiring Entities: ' + a.entities,
    '  Peak Hiring Periods: ' + a.peaks,
    '  Rollout Scope: ' + a.rollout,
    '  Languages Required: ' + a.languages,
    '  Business Driver: ' + a.driver,
    '',
    '2. CURRENT TECH STACK',
    '  Current ATS: ' + a.currentATS,
    '  HRIS / HCM: ' + a.hris,
    '  Pain Points: ' + a.painpoints,
    '  Payroll System: ' + a.payroll,
    '  Calendar / Email: ' + a.calendar,
    '  Background Screening: ' + a.bgcheck,
    '  Assessment Provider: ' + a.assess,
    '  E-Signature: ' + a.esign,
    '  Identity Provider (SSO): ' + a.idp,
    '  Other Systems: ' + a.othersystems,
    '',
    '3. RECRUITMENT PROCESSES & CONFIGURATION',
    '  Process Types: ' + a.processTypes,
    '  Process Descriptions: ' + a.processdesc,
    '  No. of Workflows: ' + a.numprocesses,
    '  Job Templates: ' + a.jobtemplates,
    '  Offer Letter Templates: ' + a.offertemplates,
    '  Job Approval Chain: ' + a.jobapproval,
    '  Offer Approval Chain: ' + a.offerapproval,
    '  Interview Types: ' + a.interviewtypes,
    '  Self-Scheduling: ' + a.selfschedule,
    '  Scorecards: ' + a.scorecards,
    '  Agency Portal: ' + a.agencyportal,
    '  Complex / Non-Standard Requirements: ' + a.complexprocess,
    '  Country-Specific Requirements: ' + a.countryrequirements,
    '',
    '4. SYSTEM PERMISSIONS & ACCESS CONTROL',
    '  No. of Recruiters: ' + a.recruiters,
    '  No. of Hiring Managers: ' + a.hms,
    '  No. of Admins: ' + a.admins,
    '  SSO Required: ' + a.sso,
    '  Internal Applications: ' + a.internal,
    '  Access Restrictions: ' + a.access,
    '  Data Privacy / Retention Rules: ' + a.privacy,
    '  Custom Roles: ' + a.roles,
    '  Works Council: ' + a.workscouncil,
    '',
    '5. INTEGRATIONS',
    '  Integrations In Scope: ' + a.integrations,
    '  HRIS Integration Detail: ' + a.hrisint,
    '  Job Boards: ' + a.jobboards,
    '  Board Contracts in Place: ' + a.boardcontracts,
    '  IT Lead for Integrations: ' + a.itlead,
    '  Integration Blockers: ' + a.intblockers,
    '  Planned System Changes: ' + a.systemchanges,
    '',
    '6. CAREER SITE & APPLICATION',
    '  Career Site Type: ' + a.careersite,
    '  No. of Career Sites: ' + a.numsites,
    '  Current Career Site URL: ' + a.currentsite,
    '  Branding Assets: ' + a.branding,
    '  Site Languages: ' + a.sitelangs,
    '  Application Form Requirements: ' + a.appform,
    '  Screening Questions: ' + a.screening,
    '  EEO / OFCCP: ' + a.eeo,
    '  SEO Requirements: ' + a.seo,
    '  DNS / IT Access: ' + a.dns,
    '',
    '7. DATA MIGRATION',
    '  Migration Scope: ' + a.migration,
    '  Data Types: ' + a.migrationtypes,
    '  Record Volume: ' + a.migrationvol,
    '  Migrating From: ' + a.migrationfrom,
    '  Data Quality: ' + a.dataquality,
    '  Data / Tech Contact: ' + a.datacontact,
    '',
    '8. TRAINING & CHANGE MANAGEMENT',
    '  User Groups: ' + a.traininggroups,
    '  No. of Recruiters to Train: ' + a.trainrecruiters,
    '  No. of HMs to Train: ' + a.trainhms,
    '  Locations / Timezones: ' + a.trainloc,
    '  Training Format: ' + a.trainingformat,
    '  Change Management Plan: ' + a.changeplan,
    '  L&D Team Available: ' + a.ld,
    '  Training Notes: ' + a.trainingnotes,
    '',
    '9. REPORTING & ANALYTICS',
    '  Key Metrics: ' + a.metrics,
    '  Report Depth: ' + a.reportdepth,
    '  External BI Tool: ' + a.bi,
    '  Report Access: ' + a.reportaccess,
    '  Compliance Reporting: ' + a.compliancereport,
    '  SLAs / KPI Targets: ' + a.slas,
    '',
    '10. TIMELINE, GOVERNANCE & COMMERCIAL',
    '  Target Go-Live: ' + a.golive,
    '  Hard Deadline: ' + a.deadline,
    '  Executive Sponsor: ' + a.sponsor,
    '  Client PM: ' + a.clientpm,
    '  Project Team: ' + a.team,
    '  UAT Sign-Off: ' + a.uat,
    '  Licence Status: ' + a.licence,
    '  Known Risks: ' + a.risks,
    '  Out of Scope: ' + a.outofscope,
  ].join('\n');

  var btn = document.getElementById('disc-answers-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Exporting...'; }
  try {
    var resp = await fetch('/consultant/implementation-hq/export-discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName: company + ' — Discovery Answers', discoveryText: lines })
    });
    if (!resp.ok) throw new Error('Export failed');
    var blob = await resp.blob();
    var url = URL.createObjectURL(blob);
    var el = document.createElement('a');
    el.href = url; el.download = 'Discovery Answers — ' + company + '.docx'; el.click();
    URL.revokeObjectURL(url);
  } catch(e) { alert('Export failed. Please try again.'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Export Answers'; } }
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