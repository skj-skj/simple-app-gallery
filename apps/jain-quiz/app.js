// ============================================================================
// SPL Flash Cards — Application Logic
// Vanilla JS. No build step, no external dependencies. Works fully offline.
// ============================================================================
'use strict';

/* ==========================================================================
   1. CHEAT SHEET — HARDCODED MASTER NAME LIST
   Curated by hand from the attached dataset.
   Only person-like names (Tirthankaras, Munis, Sadhvis, kings, historical /
   religious figures) — places, numbers, dates and generic concepts excluded.
   Actual occurrence counting (Stage 2) happens at runtime against the real
   answers in quizData; only names with count > 1 are ever shown to the user.
   ========================================================================== */
const cheatSheetNames = [
  "गौतम स्वामी",
  "महावीर स्वामी",
  "गोशालक",
  "स्थूलिभद्र",
  "जमाली",
  "चंदनबाला",
  "प्रसन्नचंद्र राजर्षि",
  "नंदन मणियार",
  "रथनेमि",
  "समुद्रपाल",
  "भरत चक्रवर्ती",
  "मम्मण सेठ",
  "शालिभद्र",
  "अर्जुनमाली",
  "इलायची कुमार",
  "अरणिक मुनि",
  "गजसुकुमाल मुनि",
  "सुदर्शन सेठ",
  "सुकुमालिका",
  "अइमुत्ता मुनि",
  "ढंढण मुनि",
  "अनाथी मुनि",
  "मरुदेवी माता",
  "राजीमति",
  "परदेशी राजा",
  "धर्मरूचि अणगार",
  "भगवान ऋषभदेव",
  "जीरण सेठ",
  "दादा जिनदत्तसूरिजी",
  "ज्येष्ठा",
  "शक्रेन्द्र",
  "स्कंधकाचार्य",
  "नंदीषेण",
  "मृगावती",
  "मेघकुमार",
  "नयसार",
  "मुनि बलभद्र",
  "पुष्पचूला",
  "वल्कलचीरी",
  "आषाढ्भूति",
  "कुरगडुमुनि",
  "मेतार्य मुनि",
  "दुर्मुख",
  "बाहुबली",
  "कपिल",
  "अतिमुक्तक कुमार",
  "संयती राजा",
  "स्वयंप्रभा",
  "अरुणकुमार",
  "प्रभव",
  "सुव्रत मुनि",
  "पुंडरिक मुनि",
  "धन्ना अणगार",
  "बलदेव",
  "करकडु राजा",
  "नमि राजर्षि",
  "श्रेणिक राजा",
  "मदनरेखा",
  "कृतपुण्य सेठ",
  "नग्गति राजा",
  "इक्षुकार राजा",
  "रेवती श्राविका",
  "नेमिनाथ भगवान",
  "अभयकुमार",
  "थावच्चापुत्र",
  "मल्लिनाथ जी",
  "जंबू कुमार",
  "भवदेव",
  "नागिला",
  "उदायन राजा",
  "पूरण सेठ",
  "चंडरुद्राचार्य",
  "चिलाती पुत्र",
  "ब्राह्मी",
  "सुंदरी",
  "सती पद्मावती",
  "शैलक राजर्षि",
  "पंथक मुनि",
  "रावण",
  "इंद्रभूति ब्राह्मण",
  "हरिश्चंद्र राजा",
  "ऋषभदत्त",
  "देवानंदा",
  "चंडकौशिक",
  "नंदीवर्धन",
  "त्रिशला",
  "सिद्धार्थ",
  "यशोदा",
  "प्रियदर्शना",
  "सुपार्श्व",
  "चेटक राजा",
  "कोशा वेश्या",
  "सुव्रता साध्वी",
  "केशी श्रमण",
  "पार्श्वनाथ प्रभु",
  "भद्रबाहु स्वामी",
  "सुलसा श्राविका",
  "रोहिणेय",
  "चुलनीमाता",
  "दशार्णभद्र",
  "जितशत्रु राजा",
  "पीठ-महापीठ",
  "आनंद श्रावक",
  "कामदेव",
  "शंख",
  "शतक",
  "जिनवल्लभसूरि",
  "श्री जिनचन्द्रसूरि",
  "श्री जिनमाणिक्यसूरिंजी",
  "गणी मेहुलप्रभसागरजी महाराज",
  "पूज्य आचार्य श्री जिनमणिप्रभसूरिजी",
  "गणिनी श्री सूर्यप्रभाश्रीजी",
  "शेषवती",
  "इक्ष्वाकु",
  "सुदर्शना",
  "समरवीर",
  "यशोदया राणी",
  "चंद्रप्रभा",
  "गर्दभाली मुनि",
  "सुभद्रा",
  "रानी कमलावती",
  "संभूतिजी",
  "ब्रह्मदत्त चक्रवर्ती",
  "कंडरिक मुनि",
  "कालसोकरिक कसाई",
  "आर्द्रकुमार",
  "विजय सेठ",
  "हेमचंद्राचार्य",
  "हरिभद्रसूरि",
  "अभयदेवसूरि",
  "विक्रमादित्य",
  "जयंती श्राविका",
  "जिनकुशलसूरि",
  "आनंदघन",
  "देवचंद्र",
  "जगड्शाह",
  "कुमारपाल",
  "वज्रस्वामी",
  "द्रौपदी",
  "वंकचूल",
  "कैकयी",
  "हनुमान",
  "लव-कुश",
  "जनक राजा",
  "दमयंती",
  "रोहिणी",
  "देवकी",
  "तामली तापस",
  "सगर",
  "सनत्कुमार",
  "मघवा",
  "लक्ष्मण",
  "जरासंध",
  "जटायु",
  "समुद्र विजय",
  "शिवादेवी",
  "सोमचन्द्र",
  "सूर्यकुमार",
  "करमण",
  "सुल्तानकुमार",
  "वाहड़ देवी",
  "देल्हण देवी",
  "श्रीया देवी",
  "श्रीवंतशाह",
  "जयतश्री",
  "मुगापुत्र",
  "आर्जव मुनि",
  "नागश्री ब्राह्मणी"
];

const personAliases = {
  "गौतमस्वामी": "गौतम स्वामी",
  "भगवान महावीर": "महावीर स्वामी",
  "वर्धमान": "महावीर स्वामी",
  "गौशालक": "गोशालक",
  "स्थूलिभद्रजी": "स्थूलिभद्र",
  "स्थूलिभद्र कुमार": "स्थूलिभद्र",
  "प्रसन्नचद्र राजर्धिं": "प्रसन्नचंद्र राजर्षि",
  "प्रसन्नचंद्र राजर्धिं": "प्रसन्नचंद्र राजर्षि",
  "नन्दन मणियार": "नंदन मणियार",
  "रथनेमी": "रथनेमि",
  "भरत": "भरत चक्रवर्ती",
  "शालिभद्रजी": "शालिभद्र",
  "शालीभद्रजी": "शालिभद्र",
  "अर्जुन माली": "अर्जुनमाली",
  "इलायचीकुमार": "इलायची कुमार",
  "अरणिकमुनि": "अरणिक मुनि",
  "गजसुकुमाल": "गजसुकुमाल मुनि",
  "ढंढण अणगार": "ढंढण मुनि",
  "मरूदेवी माता": "मरुदेवी माता",
  "राजुल": "राजीमति",
  "प्रदेशी राजा": "परदेशी राजा",
  "ऋषभदेव": "भगवान ऋषभदेव",
  "श्री जिनदत्तसूरिजी": "दादा जिनदत्तसूरिजी",
  "जिनदत्तसूरि": "दादा जिनदत्तसूरिजी",
  "शक्रेनद्र": "शक्रेन्द्र",
  "स्कदकाचार्य": "स्कंधकाचार्य",
  "स्कधकाचार्य": "स्कंधकाचार्य",
  "स्कंधक संन्यासी": "स्कंधकाचार्य",
  "नंदिषेणमुनि": "नंदीषेण",
  "नंदीषेण मुनि": "नंदीषेण",
  "न॑दिषेण": "नंदीषेण",
  "मेघकुमार मुनि": "मेघकुमार",
  "पुष्पचुला जी": "पुष्पचूला",
  "पुष्पचूलाजी": "पुष्पचूला",
  "मेतारज मुनि": "मेतार्य मुनि",
  "बाहुबलीजी": "बाहुबली",
  "कपिल केवली": "कपिल",
  "कपिल मुनि": "कपिल",
  "राजा संयती": "संयती राजा",
  "प्रभव चोर": "प्रभव",
  "पुंडरिकमुनि": "पुंडरिक मुनि",
  "पुंडरकि मुनि": "पुंडरिक मुनि",
  "धन्ना": "धन्ना अणगार",
  "धन्ना सेठ": "धन्ना अणगार",
  "धन्नाशेठ": "धन्ना अणगार",
  "धन्ना अनगार": "धन्ना अणगार",
  "श्रेणिक": "श्रेणिक राजा",
  "श्रेणिकराजा": "श्रेणिक राजा",
  "श्रेणिक महाराज": "श्रेणिक राजा",
  "सती मदनरेखा": "मदनरेखा",
  "रेवती": "रेवती श्राविका",
  "नेमीनाथ भगवान": "नेमिनाथ भगवान",
  "नेमीनाथजी": "नेमिनाथ भगवान",
  "मल्लीनाथ भगवान": "मल्लिनाथ जी",
  "मल्लीकुवरी": "मल्लिनाथ जी",
  "जंबूस्वामी": "जंबू कुमार",
  "जंबुस्वामी": "जंबू कुमार",
  "जंबुकुमार": "जंबू कुमार",
  "उदयन राजा": "उदायन राजा",
  "चिलातीपुत्र": "चिलाती पुत्र",
  "ब्राह्मी सुन्दरी": "ब्राह्मी",
  "ब्राह्मी-सुंदरी": "ब्राह्मी",
  "पद्मावती": "सती पद्मावती",
  "शैलक": "शैलक राजर्षि",
  "पंथक": "पंथक मुनि",
  "इन्द्रभूति": "इंद्रभूति ब्राह्मण",
  "चंडकोशिक": "चंडकौशिक",
  "चण्डकौशिक": "चंडकौशिक",
  "चेडा राजा": "चेटक राजा",
  "कोशा": "कोशा वेश्या",
  "पार्श्वनाथ": "पार्श्वनाथ प्रभु",
  "सुलसा": "सुलसा श्राविका",
  "रोहिणेय चोर": "रोहिणेय",
  "आनंद": "आनंद श्रावक",
  "जिनचंद्रसूरि": "श्री जिनचन्द्रसूरि",
  "दादा जिनचन्द्रसूरिजी": "श्री जिनचन्द्रसूरि",
  "चचद्रप्रभा": "चंद्रप्रभा",
  "कमलावती": "रानी कमलावती",
  "ब्रह्मदत्त": "ब्रह्मदत्त चक्रवर्ती",
  "कंडरिक": "कंडरिक मुनि",
  "कडरिकमुनि": "कंडरिक मुनि",
  "देवको": "देवकी",
  "लब-कुश": "लव-कुश",
  "जनल राजा": "जनक राजा",
  "नाग श्री ब्राह्मणी": "नागश्री ब्राह्मणी"
};

/* ==========================================================================
   2. UTILITIES
   ========================================================================== */

// Deterministic djb2-style string hash -> stable base36 id.
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash | 0;
  }
  return (hash >>> 0).toString(36);
}

function makeQuestionId(section, subsection, question) {
  const key = section + '\u241F' + (subsection || '') + '\u241F' + question;
  return 'q_' + hashString(key);
}

// Fisher-Yates shuffle (returns a new array).
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randInt(min, max) { // inclusive
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Normalize Hindi text for Cheat Sheet name matching: strip whitespace and
// common punctuation, but do NOT alter the actual Devanagari letters.
function normalizeForMatch(str) {
  return String(str)
    .replace(/[।.,\-\/()\[\]{}—–;:!?"'`॰]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ==========================================================================
   3. DATA FLATTENING
   Recursively walks quizData (of arbitrary nesting depth) and produces a
   flat, ordered array of {id, section, subsection, question, answer}.
   A leaf is any key/value pair whose value is a string (question: answer).
   ========================================================================== */

function flattenQuestions(data) {
  const result = [];

  function walk(node, section, subsectionParts) {
    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const value = node[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, section, subsectionParts.concat([key]));
      } else {
        const subsection = subsectionParts.length ? subsectionParts.join(' / ') : null;
        const question = key;
        const answer = String(value);
        result.push({
          id: makeQuestionId(section, subsection, question),
          section: section,
          subsection: subsection,
          question: question,
          answer: answer
        });
      }
    }
  }

  for (const sectionKey in data) {
    if (!Object.prototype.hasOwnProperty.call(data, sectionKey)) continue;
    walk(data[sectionKey], sectionKey, []);
  }

  return result;
}

const flatQuestions = flattenQuestions(quizData);

// Verify no duplicate IDs were produced (data integrity guard, section 39).
(function verifyIdUniqueness() {
  const seen = new Set();
  for (const q of flatQuestions) {
    if (seen.has(q.id)) {
      console.warn('Duplicate question id detected, appending disambiguator:', q.id);
      q.id = q.id + '_' + seen.size;
    }
    seen.add(q.id);
  }
})();

/* ==========================================================================
   4. SECTION TREE — for Home / Full views
   Preserves the original JSON key order (JS preserves string-key insertion
   order), builds per top-level-section and per-subsection id lists.
   ========================================================================== */

function buildSectionTree() {
  const sections = [];
  const topKeys = Object.keys(quizData);

  for (const sectionName of topKeys) {
    const sectionQuestions = flatQuestions.filter(q => q.section === sectionName);
    const subsectionNames = [];
    const seenSub = new Set();
    for (const q of sectionQuestions) {
      if (q.subsection && !seenSub.has(q.subsection)) {
        seenSub.add(q.subsection);
        subsectionNames.push(q.subsection);
      }
    }
    const subsections = subsectionNames.map(subName => ({
      name: subName,
      ids: sectionQuestions.filter(q => q.subsection === subName).map(q => q.id)
    }));

    sections.push({
      name: sectionName,
      ids: sectionQuestions.map(q => q.id),        // ALL questions in section (direct + nested)
      subsections: subsections
    });
  }
  return sections;
}

const sectionTree = buildSectionTree();
const questionsById = new Map(flatQuestions.map(q => [q.id, q]));
const ALL_IDS = flatQuestions.map(q => q.id);

/* ==========================================================================
   5. LOCAL STORAGE — learning progress
   ========================================================================== */

const STORAGE_KEY = 'jain_quiz_flashcards_progress';
let storageAvailable = true;

function loadProgress() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const id in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, id)) continue;
      const entry = parsed[id];
      if (entry && (entry.status === 'learned' || entry.status === 'not-yet-learned') && questionsById.has(id)) {
        clean[id] = { status: entry.status };
      }
    }
    return clean;
  } catch (e) {
    console.warn('Progress could not be read; starting from a clean state.', e);
    return {};
  }
}

function saveProgress() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (e) {
    storageAvailable = false;
    console.warn('Progress could not be saved (storage unavailable).', e);
  }
}

let progress = loadProgress();

function getStatus(id) {
  const e = progress[id];
  return e ? e.status : 'unseen';
}

function setStatus(id, status) {
  progress[id] = { status: status };
  saveProgress();
}

function resetIds(ids) {
  for (const id of ids) {
    delete progress[id];
  }
  saveProgress();
}

function resetAllProgress() {
  progress = {};
  saveProgress();
}

function computeStats(ids) {
  let learned = 0, notYet = 0;
  for (const id of ids) {
    const s = getStatus(id);
    if (s === 'learned') learned++;
    else if (s === 'not-yet-learned') notYet++;
  }
  return { total: ids.length, learned, notYet, unseen: ids.length - learned - notYet };
}

/* ==========================================================================
   6. CHEAT SHEET — programmatic generation (Stage 2)
   Scans every answer for occurrences of names from the hardcoded master
   list (including their aliases), counts each matching person once per
   Q&A entry, and keeps only names that occur in more than one entry.
   ========================================================================== */

function buildCheatSheetIndex() {
  // canonical name -> Set of normalized surface forms (itself + aliases)
  const surfaceForms = new Map();
  const canonicalOrder = new Map();

  cheatSheetNames.forEach((name, idx) => {
    canonicalOrder.set(name, idx);
    const norm = normalizeForMatch(name);
    if (norm.length >= 2) {
      if (!surfaceForms.has(name)) surfaceForms.set(name, new Set());
      surfaceForms.get(name).add(norm);
    }
  });

  Object.keys(personAliases).forEach(alias => {
    const canon = personAliases[alias];
    if (!canonicalOrder.has(canon)) return; // ignore aliases pointing at unknown names
    const norm = normalizeForMatch(alias);
    if (norm.length < 2) return;
    if (!surfaceForms.has(canon)) surfaceForms.set(canon, new Set());
    surfaceForms.get(canon).add(norm);
  });

  const entries = new Map(); // canonical -> { name, count, matches: [], firstOrder }

  flatQuestions.forEach(q => {
    const normAnswer = normalizeForMatch(q.answer);
    if (!normAnswer) return;
    surfaceForms.forEach((forms, canon) => {
      let matched = false;
      forms.forEach(form => {
        if (!matched && normAnswer.indexOf(form) !== -1) matched = true;
      });
      if (matched) {
        if (!entries.has(canon)) {
          entries.set(canon, { name: canon, count: 0, matches: [], firstOrder: canonicalOrder.get(canon) });
        }
        const e = entries.get(canon);
        e.count += 1;
        e.matches.push(q);
      }
    });
  });

  const list = Array.from(entries.values())
    .filter(e => e.count > 1)
    .sort((a, b) => (b.count - a.count) || (a.firstOrder - b.firstOrder));

  return list;
}

const cheatSheetList = buildCheatSheetIndex();

/* ==========================================================================
   7. SESSION / DECK ENGINE
   Handles Sequential + Random modes, and the Not-Yet-Learned spaced
   reinsertion algorithm shared by both.
   ========================================================================== */

let session = null; // active session object, or null

function startSession(scopeIds, mode, title1, title2, resetTarget) {
  if (!scopeIds.length) return;
  const deckIds = mode === 'random' ? shuffleArray(scopeIds) : scopeIds.slice();
  session = {
    mode: mode,
    scopeIds: scopeIds.slice(),      // fixed set of ids belonging to this deck
    deckIds: deckIds,                // current traversal order (base pass)
    cursor: 0,
    reviewQueue: [],                 // [{id, dueAtCount}]
    lastShownId: null,
    cardsShown: 0,
    title1: title1,
    title2: title2 || '',
    resetTarget: resetTarget,        // used by "reset this session's scope"
    currentCard: null,
    revealed: false,
    sessionLearned: 0,
    sessionNotYet: 0,
    attemptedIds: new Set()
  };
  showView('session');
  renderSessionChrome();
  advanceCard();
}

function restartSession() {
  if (!session) return;
  startSession(session.scopeIds, session.mode, session.title1, session.title2, session.resetTarget);
}

// Picks and displays the next card, or ends the session if none remain.
function advanceCard() {
  const next = getNextCard();
  if (!next) {
    finishSession();
    return;
  }
  session.currentCard = next;
  session.revealed = false;
  session.cardsShown += 1;
  session.lastShownId = next.id;
  renderCard(next, false);
  renderSessionChrome();
}

function getNextCard() {
  // 1. Anything due for review that isn't the card we just showed?
  let dueIndex = -1;
  for (let i = 0; i < session.reviewQueue.length; i++) {
    const item = session.reviewQueue[i];
    if (item.dueAtCount <= session.cardsShown && item.id !== session.lastShownId) {
      dueIndex = i;
      break;
    }
  }
  if (dueIndex !== -1) {
    const item = session.reviewQueue.splice(dueIndex, 1)[0];
    return questionsById.get(item.id);
  }

  // 2. Next new card from the base deck (search ahead if the very next
  //    slot would repeat the card just shown, rather than assuming an
  //    adjacent swap is always possible).
  while (session.cursor < session.deckIds.length) {
    const id = session.deckIds[session.cursor];
    if (id !== session.lastShownId) {
      session.cursor += 1;
      return questionsById.get(id);
    }
    let swapIdx = -1;
    for (let k = session.cursor + 1; k < session.deckIds.length; k++) {
      if (session.deckIds[k] !== session.lastShownId) { swapIdx = k; break; }
    }
    if (swapIdx === -1) break; // nothing left in the base deck avoids the repeat
    const tmp = session.deckIds[swapIdx];
    session.deckIds[swapIdx] = session.deckIds[session.cursor];
    session.deckIds[session.cursor] = tmp;
  }

  // 3. Base deck exhausted — if a not-yet-learned card is waiting but not
  //    yet due, and it's the only thing left, allow it through anyway
  //    (otherwise the session could stall forever) — UNLESS it's the very
  //    card we just showed, in which case end the round instead of
  //    repeating the same question back-to-back.
  if (session.reviewQueue.length) {
    const idx = session.reviewQueue.findIndex(it => it.id !== session.lastShownId);
    if (idx === -1) {
      return null; // only remaining card is the one just shown — end round
    }
    const item = session.reviewQueue.splice(idx, 1)[0];
    return questionsById.get(item.id);
  }

  return null; // deck complete
}

function revealCard() {
  if (!session || !session.currentCard || session.revealed) return;
  session.revealed = true;
  document.getElementById('flash-card').classList.add('flipped');
  document.getElementById('eval-row').classList.remove('hidden');
}

function evaluateCard(correct) {
  if (!session || !session.currentCard || !session.revealed) return;
  const id = session.currentCard.id;
  const remainingInDeck = Math.max(0, session.deckIds.length - session.cursor) + session.reviewQueue.length;
  session.attemptedIds.add(id);

  if (correct) {
    setStatus(id, 'learned');
    session.sessionLearned += 1;
    // remove from review queue if it was pending re-review
    session.reviewQueue = session.reviewQueue.filter(it => it.id !== id);
  } else {
    setStatus(id, 'not-yet-learned');
    session.sessionNotYet += 1;
    const spacing = randInt(3, Math.max(3, Math.min(6, remainingInDeck + 3)));
    // remove any pre-existing pending entry for this id, then re-add with a fresh delay
    session.reviewQueue = session.reviewQueue.filter(it => it.id !== id);
    session.reviewQueue.push({ id: id, dueAtCount: session.cardsShown + spacing });
  }

  document.getElementById('flash-card').classList.remove('flipped');
  document.getElementById('eval-row').classList.add('hidden');
  window.setTimeout(advanceCard, 180);
}

function finishSession() {
  const s = computeStats(session.scopeIds);
  document.getElementById('card-stage').style.display = 'none';
  document.getElementById('eval-row').classList.add('hidden');
  document.getElementById('eval-row').style.display = 'none';
  const complete = document.getElementById('session-complete');
  complete.style.display = 'flex';
  document.getElementById('complete-ring').textContent = s.total + '\nप्रश्न';
  document.getElementById('complete-ring').innerHTML = s.total + '<br>प्रश्न';
  document.getElementById('complete-detail').textContent =
    'इस सत्र में ' + session.sessionLearned + ' सही और ' + session.sessionNotYet + ' अभी बाकी। कुल सीखा: ' + s.learned + ' / ' + s.total;
  session.finished = true;
}

/* ==========================================================================
   8. RENDERING — Home (Sections)
   ========================================================================== */

function fmtStats(stats) {
  return stats.total + ' प्रश्न';
}

function progressPct(stats) {
  if (!stats.total) return 0;
  return Math.round((stats.learned / stats.total) * 100);
}

const chevronSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const trashSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/></svg>';
const playSvg = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>';

function renderHome() {
  const root = document.getElementById('home-list');
  root.innerHTML = '';

  if (!sectionTree.length) {
    root.innerHTML = '<p class="empty-note">कोई प्रश्न नहीं मिला।</p>';
    return;
  }

  sectionTree.forEach((section, sIdx) => {
    const stats = computeStats(section.ids);
    const card = document.createElement('div');
    card.className = 'section-card';

    const hasSub = section.subsections.length > 0;

    card.innerHTML =
      '<h2>' + escapeHtml(section.name) + '</h2>' +
      '<div class="section-meta">' +
        '<span><b>' + stats.total + '</b> प्रश्न</span>' +
        '<span class="pill-learned">सीखा: ' + stats.learned + '</span>' +
        '<span class="pill-notyet">बाकी: ' + stats.notYet + '</span>' +
      '</div>' +
      '<div class="progress-track"><div class="progress-fill" style="width:' + progressPct(stats) + '%"></div></div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-primary" data-action="start-section" data-idx="' + sIdx + '">' + playSvg + ' अभ्यास शुरू करें</button>' +
        '<button class="icon-btn" data-action="reset-section" data-idx="' + sIdx + '" aria-label="' + escapeHtml(section.name) + ' रीसेट करें">' + trashSvg + '</button>' +
      '</div>' +
      (hasSub ? '<button class="expand-toggle" data-action="toggle-sub" data-idx="' + sIdx + '">' + chevronSvg + ' उप-विभाग (' + section.subsections.length + ')</button>' +
        '<div class="subsection-list" data-sublist="' + sIdx + '"></div>' : '');

    root.appendChild(card);

    if (hasSub) {
      const subList = card.querySelector('[data-sublist="' + sIdx + '"]');
      section.subsections.forEach((sub, subIdx) => {
        const subStats = computeStats(sub.ids);
        const row = document.createElement('div');
        row.className = 'subsection-row';
        row.innerHTML =
          '<div class="subsection-info">' +
            '<h3>' + escapeHtml(sub.name) + '</h3>' +
            '<div class="sub-meta">' + subStats.total + ' प्रश्न · सीखा ' + subStats.learned + ' · बाकी ' + subStats.notYet + '</div>' +
          '</div>' +
          '<div class="row-tools">' +
            '<button class="icon-btn" data-action="reset-subsection" data-sidx="' + sIdx + '" data-subidx="' + subIdx + '" aria-label="रीसेट करें">' + trashSvg + '</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="start-subsection" data-sidx="' + sIdx + '" data-subidx="' + subIdx + '">शुरू करें</button>' +
          '</div>';
        subList.appendChild(row);
      });
    }
  });
}

function toggleSubsection(idx) {
  const list = document.querySelector('[data-sublist="' + idx + '"]');
  const btn = document.querySelector('.expand-toggle[data-idx="' + idx + '"]');
  if (!list) return;
  list.classList.toggle('open');
  btn.classList.toggle('open');
}

/* ==========================================================================
   9. RENDERING — Full Mode
   ========================================================================== */

function renderFull() {
  const root = document.getElementById('full-content');
  const stats = computeStats(ALL_IDS);
  root.innerHTML =
    '<div class="full-hero">' +
      '<h2>पूर्ण अभ्यास (Full Mode)</h2>' +
      '<div class="sub">सभी विभागों के ' + stats.total + ' प्रश्न</div>' +
      '<div class="progress-track"><div class="progress-fill" style="width:' + progressPct(stats) + '%"></div></div>' +
      '<div class="section-meta" style="margin-top:10px">' +
        '<span class="pill-learned">सीखा: ' + stats.learned + '</span>' +
        '<span class="pill-notyet">बाकी: ' + stats.notYet + '</span>' +
        '<span>शेष: ' + stats.unseen + '</span>' +
      '</div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-primary" id="full-start-btn">' + playSvg + ' अभ्यास शुरू करें</button>' +
      '</div>' +
    '</div>' +
    '<button class="btn btn-danger btn-block" id="full-reset-btn">' + trashSvg + ' पूरी प्रगति रीसेट करें</button>';

  document.getElementById('full-start-btn').addEventListener('click', () => {
    openModePicker('पूर्ण अभ्यास', stats.total + ' प्रश्न', ALL_IDS, 'सभी विभाग', null, { type: 'all' });
  });
  document.getElementById('full-reset-btn').addEventListener('click', () => {
    openResetConfirm('यह सभी विभागों की पूरी सीखने की प्रगति रीसेट कर देगा। यह पूर्ववत नहीं किया जा सकता।', () => {
      resetAllProgress();
      renderAll();
    });
  });
}

/* ==========================================================================
   10. RENDERING — Cheat Sheet
   ========================================================================== */

function renderCheatList(filterTerm) {
  const root = document.getElementById('cheat-list');
  root.innerHTML = '';
  const term = (filterTerm || '').trim();
  const list = term
    ? cheatSheetList.filter(e => e.name.indexOf(term) !== -1)
    : cheatSheetList;

  if (!list.length) {
    root.innerHTML = '<li class="empty-note">कोई परिणाम नहीं मिला।</li>';
    return;
  }

  list.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'cheat-row';
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.innerHTML =
      '<span class="name">' + escapeHtml(entry.name) + '</span>' +
      '<span class="count"><span class="n">' + entry.count + '</span> प्रश्न</span>';
    li.addEventListener('click', () => openCheatDetail(entry.name));
    li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCheatDetail(entry.name); } });
    root.appendChild(li);
  });
}

function openCheatDetail(name) {
  const entry = cheatSheetList.find(e => e.name === name);
  if (!entry) return;
  document.getElementById('cheat-detail-title').textContent = entry.name;
  document.getElementById('cheat-detail-sub').textContent = entry.count + ' प्रश्नों में मिलता है';

  const listEl = document.getElementById('cheat-detail-list');
  listEl.innerHTML = '';

  // Group hierarchically by section, then subsection, preserving dataset order.
  const groups = []; // [{section, subsection, items:[]}]
  entry.matches.forEach(q => {
    let group = groups.find(g => g.section === q.section && g.subsection === q.subsection);
    if (!group) {
      group = { section: q.section, subsection: q.subsection, items: [] };
      groups.push(group);
    }
    group.items.push(q);
  });

  groups.forEach(g => {
    const title = document.createElement('div');
    title.className = 'cheat-group-title';
    title.innerHTML = escapeHtml(g.section) + (g.subsection ? '<span class="sub">' + escapeHtml(g.subsection) + '</span>' : '');
    listEl.appendChild(title);

    g.items.forEach(q => {
      const card = document.createElement('div');
      card.className = 'cheat-qa';
      card.innerHTML =
        '<div class="q">' + escapeHtml(q.question) + '</div>' +
        '<div class="a">' + escapeHtml(q.answer) + '</div>';
      listEl.appendChild(card);
    });
  });

  showView('cheat-detail');
}

/* ==========================================================================
   11. RENDERING — Session card + chrome
   ========================================================================== */

function renderCard(q, revealed) {
  document.getElementById('card-stage').style.display = 'flex';
  document.getElementById('eval-row').style.display = 'flex';
  document.getElementById('session-complete').style.display = 'none';

  document.getElementById('front-section').textContent = q.section;
  document.getElementById('front-subsection').textContent = q.subsection || '';
  document.getElementById('front-question').textContent = q.question;

  document.getElementById('back-section').textContent = q.section;
  document.getElementById('back-subsection').textContent = q.subsection || '';
  document.getElementById('back-question').textContent = q.question;
  document.getElementById('back-answer').textContent = q.answer;

  const cardEl = document.getElementById('flash-card');
  cardEl.classList.toggle('flipped', !!revealed);
  document.getElementById('eval-row').classList.toggle('hidden', !revealed);
}

function renderSessionChrome() {
  if (!session) return;
  document.getElementById('session-title1').textContent = session.title1;
  document.getElementById('session-title2').textContent = session.title2;

  const total = session.scopeIds.length;
  document.getElementById('session-count').textContent = session.attemptedIds.size + ' / ' + total;

  const stats = computeStats(session.scopeIds);
  document.getElementById('session-progress-fill').style.width = progressPct(stats) + '%';
  document.getElementById('session-learned-n').textContent = stats.learned;
  document.getElementById('session-notyet-n').textContent = stats.notYet;
}

/* ==========================================================================
   12. VIEW / NAV CONTROLLER
   ========================================================================== */

const VIEW_IDS = ['home', 'full', 'cheatsheet', 'cheat-detail', 'session'];

function showView(name) {
  VIEW_IDS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  const navMap = { home: 'home', full: 'full', cheatsheet: 'cheatsheet' };
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', navMap[name] && btn.getAttribute('data-nav') === navMap[name]);
  });
  if (name === 'home') renderHome();
  if (name === 'full') renderFull();
  if (name === 'cheatsheet') renderCheatList(document.getElementById('cheat-search').value);
  window.scrollTo(0, 0);
}

function renderAll() {
  const current = VIEW_IDS.find(v => document.getElementById('view-' + v).classList.contains('active')) || 'home';
  showView(current);
}

/* ==========================================================================
   13. MODE PICKER MODAL
   ========================================================================== */

let pendingModeChoice = null; // {ids, title1, title2, resetTarget}

function openModePicker(title1, title2, ids, subLabel, subIdsLabel, resetTarget) {
  pendingModeChoice = { ids, title1, title2, resetTarget };
  document.getElementById('mode-modal-title').textContent = title1;
  document.getElementById('mode-modal-sub').textContent = title2;
  document.getElementById('modal-mode').classList.add('open');
}

function closeModePicker() {
  document.getElementById('modal-mode').classList.remove('open');
  pendingModeChoice = null;
}

function confirmMode(mode) {
  if (!pendingModeChoice) return;
  const { ids, title1, title2, resetTarget } = pendingModeChoice;
  closeModePicker();
  startSession(ids, mode, title1, title2, resetTarget);
}

/* ==========================================================================
   14. RESET CONFIRM MODAL
   ========================================================================== */

let pendingResetAction = null;

function openResetConfirm(message, onConfirm) {
  document.getElementById('reset-modal-text').textContent = message;
  pendingResetAction = onConfirm;
  document.getElementById('modal-reset').classList.add('open');
}

function closeResetConfirm() {
  document.getElementById('modal-reset').classList.remove('open');
  pendingResetAction = null;
}

/* ==========================================================================
   15. EVENT WIRING
   ========================================================================== */

function wireHomeDelegation() {
  document.getElementById('home-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');

    if (action === 'toggle-sub') {
      toggleSubsection(btn.getAttribute('data-idx'));
      return;
    }
    if (action === 'start-section') {
      const s = sectionTree[Number(btn.getAttribute('data-idx'))];
      const stats = computeStats(s.ids);
      openModePicker(s.name, stats.total + ' प्रश्न', s.ids, null, null, { type: 'section', name: s.name });
      return;
    }
    if (action === 'reset-section') {
      const s = sectionTree[Number(btn.getAttribute('data-idx'))];
      openResetConfirm('इससे "' + s.name + '" विभाग की पूरी प्रगति रीसेट हो जाएगी।', () => {
        resetIds(s.ids);
        renderAll();
      });
      return;
    }
    if (action === 'start-subsection') {
      const s = sectionTree[Number(btn.getAttribute('data-sidx'))];
      const sub = s.subsections[Number(btn.getAttribute('data-subidx'))];
      const stats = computeStats(sub.ids);
      openModePicker(sub.name, stats.total + ' प्रश्न', sub.ids, null, null, { type: 'subsection', section: s.name, name: sub.name });
      return;
    }
    if (action === 'reset-subsection') {
      const s = sectionTree[Number(btn.getAttribute('data-sidx'))];
      const sub = s.subsections[Number(btn.getAttribute('data-subidx'))];
      openResetConfirm('इससे "' + sub.name + '" उप-विभाग की प्रगति रीसेट हो जाएगी।', () => {
        resetIds(sub.ids);
        renderAll();
      });
      return;
    }
  });
}

function wireBottomNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.getAttribute('data-nav')));
  });
}

function wireCheatSheet() {
  document.getElementById('cheat-search').addEventListener('input', e => renderCheatList(e.target.value));
  document.getElementById('cheat-detail-back').addEventListener('click', () => showView('cheatsheet'));
}

function wireCard() {
  const cardEl = document.getElementById('flash-card');
  cardEl.addEventListener('click', revealCard);
  cardEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealCard(); }
  });
  document.getElementById('btn-correct').addEventListener('click', () => evaluateCard(true));
  document.getElementById('btn-not-yet').addEventListener('click', () => evaluateCard(false));
  document.getElementById('session-back').addEventListener('click', () => { session = null; showView('home'); });
  document.getElementById('btn-practice-again').addEventListener('click', restartSession);
  document.getElementById('btn-complete-home').addEventListener('click', () => { session = null; showView('home'); });
}

function wireModals() {
  document.getElementById('mode-sequential').addEventListener('click', () => confirmMode('sequential'));
  document.getElementById('mode-random').addEventListener('click', () => confirmMode('random'));
  document.getElementById('mode-cancel').addEventListener('click', closeModePicker);
  document.getElementById('modal-mode').addEventListener('click', e => {
    if (e.target.id === 'modal-mode') closeModePicker();
  });

  document.getElementById('reset-confirm-btn').addEventListener('click', () => {
    const action = pendingResetAction;
    closeResetConfirm();
    if (action) action();
  });
  document.getElementById('reset-cancel-btn').addEventListener('click', closeResetConfirm);
  document.getElementById('modal-reset').addEventListener('click', e => {
    if (e.target.id === 'modal-reset') closeResetConfirm();
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', e => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // never intercept typing (e.g. cheat sheet search)

    // Mode picker: R selects Random
    if (document.getElementById('modal-mode').classList.contains('open')) {
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); confirmMode('random'); }
      if (e.key === 'Escape') closeModePicker();
      return;
    }
    if (document.getElementById('modal-reset').classList.contains('open')) {
      if (e.key === 'Escape') closeResetConfirm();
      return;
    }

    const sessionView = document.getElementById('view-session');
    if (!sessionView.classList.contains('active') || !session || session.finished) return;

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!session.revealed) revealCard();
    } else if (e.key === '1') {
      if (session.revealed) evaluateCard(true);
    } else if (e.key === '2') {
      if (session.revealed) evaluateCard(false);
    }
  });
}

/* ==========================================================================
   16. INIT
   ========================================================================== */

function init() {
  wireHomeDelegation();
  wireBottomNav();
  wireCheatSheet();
  wireCard();
  wireModals();
  wireKeyboard();
  showView('home');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
