// ---------------------------------------------------------------------
// Map name detection: crop the region of the screen where DBD shows the
// map name (lobby screen and/or loading screen), run OCR on it, and match
// the result against the app's known list of 58 maps.
//
// Calibrated from a 1920x1080 screenshot of the "Players" lobby screen
// (both custom/bot lobbies and public matches use this same style per the
// user). The crop region is stored as PERCENTAGES of screen width/height
// so it scales to other resolutions automatically. If detection is
// consistently missing the text on a given setup, these percentages are
// the first thing to adjust -- see calibrateRegion() below for a way to
// find new ones from a saved screenshot.
// ---------------------------------------------------------------------

const { nativeImage } = require('electron');

// Percentages of (width, height), measured from the reference screenshot:
// the actual text sat at roughly x:36-63%, y:81-86%; this is padded wider
// (25-75%) to comfortably fit a "little wider" stretched-resolution render
// too, per the user's confirmation it still stays within a much bigger
// hand-drawn box at that width.
const DEFAULT_REGION = { left: 0.25, right: 0.75, top: 0.78, bottom: 0.88 };

// Official in-game names differ from this app's internal (often
// community-shorthand) map names for some maps -- e.g. DBD's lobby shows
// "Raccoon City Police Station - East Wing" where this app calls the file
// "Rpd East Wing". Add more pairs here as mismatches get reported; the
// left side should be whatever OCR is likely to read (uppercase is fine,
// matching is case-insensitive), the right side must exactly match a
// `name` value the app already generates (see prettyMapName in
// renderer/index.html) so it can look up the right map file.
const OFFICIAL_NAME_ALIASES = {
  'raccoon city police station east wing': 'RPD East Wing',
  'raccoon city police station west wing': 'RPD West Wing',
  'raccoon city police station - east wing': 'RPD East Wing',
  'raccoon city police station - west wing': 'RPD West Wing'
  // Badham Preschool's 5 layouts are handled separately, by
  // matchNumeralVariant() below -- a plain alias per Roman
  // numeral isn't enough there since OCR commonly misreads "II"/"III" as
  // the digits "11"/"111" (near-identical in most fonts), so that needs
  // its own dedicated handling of multiple possible readings per variant
  // rather than one fixed literal string.
};

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// OCR frequently misreads Roman numerals as similar-looking digit
// sequences -- "II" (two capital I's) and "11" (two digit ones) are
// near-identical in most fonts, same for "III" vs "111". This affects
// EVERY multi-version map, not just Badham Preschool: Ormond II/III, Coal
// Tower II, Groaning Storehouse II, Ironworks Of Misery II, Sanctum of
// Wrath II, Shelter Woods II, Suffocation Pit II, and Family Residence II
// all end in a Roman numeral too. A plain literal alias for "ii"/"iii"
// alone isn't reliable enough on its own, so this instead: strips
// whatever trailing numeral-like suffix (Roman, its digit-doubled OCR
// misread, or a correct Arabic digit) is on the OCR text, converts it to
// a variant number, then looks for a map whose OWN name -- after the
// exact same trailing-numeral stripping -- matches the same base words
// AND variant number. That last part is what makes this work for Badham
// (whose app-internal names use Arabic digits already, e.g. "Badham
// Preschool 2") as well as maps like Ormond (whose app-internal names use
// the Roman numeral directly, e.g. "Ormond II") with the same code path.
var NUMERAL_SUFFIX_TO_VARIANT = {
  'i': 1, '1': 1,
  'ii': 2, '11': 2, '2': 2,
  'iii': 3, '111': 3, '3': 3,
  'iv': 4, '1111': 4, '4': 4,
  'v': 5, '5': 5
};

// Returns { base: 'ormond', variant: 2 } for "ormond ii" / "ormond 11" /
// "ormond 2", or { base: 'ormond', variant: 1 } (implicit "no suffix means
// the first/base version") for plain "ormond". Null if the string is
// empty.
function splitNumeralSuffix(normText) {
  if (!normText) return null;
  var words = normText.split(' ');
  var last = words[words.length - 1];
  if (words.length > 1 && NUMERAL_SUFFIX_TO_VARIANT.hasOwnProperty(last)) {
    return { base: words.slice(0, -1).join(' '), variant: NUMERAL_SUFFIX_TO_VARIANT[last] };
  }
  return { base: normText, variant: 1 };
}

function matchNumeralVariant(normText, mapNames) {
  var target = splitNumeralSuffix(normText);
  if (!target) return null;
  for (var i = 0; i < mapNames.length; i++) {
    var candidate = splitNumeralSuffix(normalize(mapNames[i].name));
    if (candidate.base === target.base && candidate.variant === target.variant) return mapNames[i];
  }
  return null;
}

// Cheap similarity: fraction of the shorter normalized string's words that
// also appear in the longer one. Good enough to survive minor OCR noise
// (a dropped word, a misread letter here or there) without needing a full
// edit-distance implementation.
function wordOverlapScore(a, b) {
  var wa = normalize(a).split(' ').filter(Boolean);
  var wb = normalize(b).split(' ').filter(Boolean);
  if (!wa.length || !wb.length) return 0;
  var setB = new Set(wb);
  var hits = wa.filter(function (w) { return setB.has(w); }).length;
  return hits / Math.min(wa.length, wb.length);
}

// mapNames: array of { name, file } as already computed by the renderer
// (window.MAP_DATA) -- passed in per-call rather than duplicated here, so
// this file never has to be kept in sync with the map list by hand.
function matchMapName(ocrText, mapNames) {
  if (!ocrText) return null;

  // The lobby screen shows "REALM - MAP NAME" (or just the map name for
  // maps whose realm and map share a name). Try the part after the last
  // " - " first, since that's the more specific/reliable part; fall back
  // to the whole line if there's no dash.
  var firstLine = ocrText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean)[0] || '';
  var afterDash = firstLine.includes(' - ') ? firstLine.split(' - ').slice(1).join(' - ') : firstLine;

  var candidates = [afterDash, firstLine];

  for (var c = 0; c < candidates.length; c++) {
    var norm = normalize(candidates[c]);
    if (!norm) continue;

    var numeralMatch = matchNumeralVariant(norm, mapNames);
    if (numeralMatch) return numeralMatch;

    var alias = OFFICIAL_NAME_ALIASES[norm];
    if (alias) {
      var aliasHit = mapNames.find(function (m) { return m.name === alias; });
      if (aliasHit) return aliasHit;
    }

    var exact = mapNames.find(function (m) { return normalize(m.name) === norm; });
    if (exact) return exact;
  }

  // Fuzzy fallback: best word-overlap score against either candidate,
  // only accepted above a fairly high bar to avoid confident-looking
  // wrong guesses.
  var best = null, bestScore = 0;
  candidates.forEach(function (cand) {
    if (!cand) return;
    mapNames.forEach(function (m) {
      var score = wordOverlapScore(cand, m.name);
      if (score > bestScore) { bestScore = score; best = m; }
    });
  });
  return bestScore >= 0.6 ? best : null;
}

function cropToRegion(fullImage, region) {
  var size = fullImage.getSize();
  var r = region || DEFAULT_REGION;
  var x = Math.round(size.width * r.left);
  var y = Math.round(size.height * r.top);
  var w = Math.round(size.width * (r.right - r.left));
  var h = Math.round(size.height * (r.bottom - r.top));
  return fullImage.crop({ x: x, y: y, width: w, height: h });
}

let ocrWorkerPromise = null;
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    var Tesseract = require('tesseract.js');
    ocrWorkerPromise = Tesseract.createWorker('eng');
  }
  return ocrWorkerPromise;
}

// fullImage: an Electron nativeImage of the whole screen.
// mapNames: window.MAP_DATA-shaped array from the renderer.
// region: optional override of DEFAULT_REGION (same shape), for future
// per-user calibration.
// Returns { match: {name,file}|null, rawText: string, croppedDataUrl: string }
// so the renderer can show *something* useful (like the raw OCR text or
// the exact crop used) even when matching fails, to help diagnose a bad
// region without needing to come back here for more screenshots.
async function detectMapFromImage(fullImage, mapNames, region) {
  var cropped = cropToRegion(fullImage, region);
  // Upscale before OCR: this text is small (roughly 35-40px tall at
  // 1080p) and Tesseract reads small UI text more reliably enlarged.
  var size = cropped.getSize();
  var upscaled = cropped.resize({ width: size.width * 3, height: size.height * 3, quality: 'best' });

  var worker = await getOcrWorker();
  var result = await worker.recognize(upscaled.toPNG());
  var rawText = (result && result.data && result.data.text || '').trim();

  var match = matchMapName(rawText, mapNames);

  return {
    match: match,
    rawText: rawText,
    croppedDataUrl: cropped.toDataURL()
  };
}

module.exports = { detectMapFromImage, matchMapName, DEFAULT_REGION };
