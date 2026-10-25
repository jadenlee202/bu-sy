// Screen: "What fits now?" Two required choices (activity, free time); the rest
// has visible defaults under Preferences. Results update as choices change.
// No logic here decides what fits: it reads the form, runs the shared engine
// (recommend.js) and renders the engine's result.
import { fmtHHMM, fmtShort, fmtTime, toHHMM, toMin } from "./clock.js";
import { dateLabel } from "./hours.js";
import { icon, terrier } from "./icons.js";
import { createPlanSession } from "./plan-session.js";
import * as prefs from "./prefs.js";
import * as engine from "./recommend.js";
import { bostonSkyline } from "./skyline.js";
import * as src from "./source.js";
import { esc, failure, level, loading } from "./ui.js";

const PRESETS = [30, 45, 60, 90];
const PLAYBACK = [0, 24 * 60 - 1];  // range the demo clock can show (12 AM-11:59 PM)
const TYPING_MS = 600;              // wait this long after typing before updating
const TYPED = new Set(["custom", "start", "minActivity", "buffer", "preparation", "cleanup", "until"]);

// Kept for the session, so going to a place and back keeps the inputs.
const draft = { req: null, startEdited: false, lastSelected: false };

const header = () => `<div class="page-head hero-banner hero-skyline planner-skyline">
  <div class="hero-bg" aria-hidden="true">${bostonSkyline()}</div>
  <div class="hero-body"><h1 class="title">What fits now?</h1>
    <p class="tagline">I have a free window. Make it a plan.</p>
    <a href="#/calendar">Preview the sample week · October 25–31</a></div></div>`;

export async function planView($view, clock) {
  $view.innerHTML = header() + loading("Loading campus data…");
  let campus, histories, hours;
  try {
    // Verified hours are optional: if hours.json can't load, the engine uses the demo hours.
    [campus, hours] = await Promise.all([src.getCampus(), src.getHours().catch(() => null)]);
    const ids = [...new Set(campus.places.map((p) => p.facility_id))];
    histories = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await src.getHistory(id)])));
  } catch (err) {
    $view.innerHTML = header() + failure(err);
    return {};
  }
  const planDate = engine.demoDate(campus, histories);

  if (!draft.req) {
    const saved = prefs.loadPrefs(campus);
    draft.req = { activity: "", minutes: NaN, start: "", source: "manual", mode: "duration", until: "", ...prefs.defaults(campus, saved, "") };
    draft.lastSelected = Boolean(saved.from);
  }
  if (!draft.startEdited) draft.req.start = toHHMM(clock.minute);

  $view.innerHTML = `${header()}
    <div class="plan-layout">
      ${formHTML(campus)}
      <section id="results" class="results" tabindex="-1" aria-label="Options"></section>
    </div>
    <p class="sr-only" role="status" id="plan-status"></p>`;

  const $form = $view.querySelector("#plan");
  const $results = $view.querySelector("#results");
  const $status = $view.querySelector("#plan-status");
  const $err = $form.querySelector(".form-error");
  const $go = $form.querySelector('[type="submit"]');
  const session = createPlanSession(campus, histories, { hours });
  fill($form, draft.req, campus);

  /** showErrors: false while someone is still typing, so nothing flashes red mid-entry. */
  function run({ showErrors = true, focus = false } = {}) {
    clearTimeout(typing);
    const req = readForm($form);
    draft.req = req;
    for (const el of $form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    $err.textContent = "";
    $results.classList.remove("is-stale");

    const until = req.mode === "until";
    const noWindow = until ? !req.until : !$form.elements.preset.value;
    const missing = [!req.activity && "activity", noWindow && (until ? "until" : "minutes")].filter(Boolean);
    if (missing.length) {
      if (showErrors && focus) {
        const window = until ? "when your next class starts" : "how long you're free";
        $err.textContent = missing.length === 2 ? `Choose an activity and ${window}.`
          : missing[0] === "activity" ? "Choose an activity." : `Choose ${window}.`;
        fieldFor($form, missing[0])?.focus();
      }
      $results.innerHTML = startState(missing);
      $status.textContent = "";
      $go.textContent = "Find options";
      return;
    }

    // The plan is for the simulated demo day: the same date the occupancy replays, and the
    // date verified hours are looked up for. The engine is the same in static and API mode.
    const result = session.update({ ...req, date: planDate });
    if (!result.ok) {
      if (!showErrors) {                       // mid-entry: keep the last results, marked out of date
        if ($results.querySelector(".recs, .empty")) $results.classList.add("is-stale");
        return;
      }
      $err.textContent = result.errors.map((e) => e.message).join(" ");
      const bad = result.errors.map((e) => fieldFor($form, e.field)).filter(Boolean);
      for (const el of bad) el.setAttribute("aria-invalid", "true");
      if (bad.some((el) => el.closest("#prefs"))) $form.querySelector("#prefs").open = true;
      if (focus) bad[0]?.focus();
      $results.innerHTML = `<div class="start-state"><p class="start-title">Check the highlighted field</p><p>${esc($err.textContent)}</p></div>`;
      $status.textContent = "";
      $go.textContent = "Find options";
      return;
    }

    const minute = toMin(req.start);
    if (minute >= PLAYBACK[0] && minute <= PLAYBACK[1]) clock.set(minute); // place pages show the same demo time
    $results.innerHTML = resultsHTML(result, campus);
    $status.textContent = statusText(result);
    $go.textContent = buttonText(result);   // on phones the results sit below: the button says what's there
    if (focus) {
      $results.focus({ preventScroll: true });
      $results.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }

  function invalidate() {
    session.invalidate();
    if ($results.querySelector(".selected-plan")) {
      $results.innerHTML = `<p class="stale-note" role="status">Inputs changed. Updating your options…</p>`;
    }
    $results.querySelectorAll("[data-choose]").forEach(b => b.disabled = true);
    $results.classList.add("is-stale");
  }
  let typing;
  $form.addEventListener("submit", (e) => { e.preventDefault(); run({ focus: true }); });
  $form.addEventListener("input", (e) => {
    invalidate();
    if (!TYPED.has(e.target.name)) return;          // choices update on "change" instead
    if (e.target.name === "start") draft.startEdited = true;
    syncForm($form, campus);
    clearTimeout(typing);
    typing = setTimeout(() => run({ showErrors: false }), TYPING_MS);
  });
  $form.addEventListener("change", (e) => {
    invalidate();
    const { name } = e.target;
    if (!name) return;
    if (name === "activity") {
      const d = prefs.defaults(campus, prefs.loadPrefs(campus), e.target.value);
      $form.elements.preparation.value = d.preparation;
      $form.elements.cleanup.value = d.cleanup;
      const remembered = prefs.loadPrefs(campus).minByActivity?.[e.target.value];
      $form.elements.minActivity.value = remembered ?? engine.activityInfo(campus, e.target.value).default_min;
    }
    if (name === "preset" && e.target.value === "custom") $form.elements.custom.focus();
    if (name === "mode") {
      // Carry a valid window across (60 min from 3 PM <-> until 4 PM); keep the other field otherwise.
      const both = { ...readForm($form), minutes: durationMinutes($form), until: $form.elements.until.value };
      fillWindow($form, engine.switchWindowMode(both, e.target.value));
    }
    remember($form, name, campus);
    syncForm($form, campus);
    if (name === "preset" && e.target.value === "custom" && !$form.elements.custom.value) return; // wait for a number
    run({ showErrors: name !== "mode" });
  });

  const apply = (req) => {
    fill($form, req, campus);
    run();
  };
  $view.querySelector(".plan-layout").addEventListener("click", (e) => {
    const choose = e.target.closest("[data-choose]");
    if (choose && !choose.disabled) {
      const chosen = session.choose(choose.dataset.choose);
      if (chosen) {
        $results.innerHTML = selectedPlanHTML(chosen.option, chosen.request, campus);
        $status.textContent = `Chosen plan: ${chosen.option.place.name}. ${chosen.option.activity} minutes of activity.`;
        $results.focus();
        $results.scrollIntoView({ block: "start" });
      }
    }
    if (e.target.closest("[data-change-plan]")) { run(); $results.focus(); }
    if (e.target.closest("[data-edit-inputs]")) {
      run();
      $form.querySelector("#prefs").open = true;
      $form.elements.to.focus();
      $form.scrollIntoView({ block: "start" });
    }
    const accessCheck = e.target.closest("[data-check-access]");
    if (accessCheck) {
      $form.querySelector("#prefs").open = true;
      $form.elements[`access-${accessCheck.dataset.checkAccess}`]?.focus();
      $form.scrollIntoView({ block: "start" });
    }
    const scenario = e.target.closest("[data-scenario]");
    if (scenario) {                                  // samples are demos, so nothing is remembered
      draft.startEdited = true;
      draft.lastSelected = false;
      apply(engine.requestFromScenario(campus.scenarios.find((s) => s.id === scenario.dataset.scenario)));
      if (matchMedia("(max-width: 47.99rem)").matches) $results.scrollIntoView({ block: "start" });
    }
    const fix = e.target.closest("[data-patch]");
    if (fix) apply({ ...readForm($form), ...JSON.parse(fix.dataset.patch) });
    if (e.target.closest("[data-focus-from]")) {
      $form.elements.from.focus();
      $form.elements.from.scrollIntoView({ block: "center" });
    }
    if (e.target.closest("[data-reset]")) {
      prefs.resetPrefs();
      draft.startEdited = false;
      draft.lastSelected = false;
      const req = readForm($form);
      apply({ ...req, start: toHHMM(clock.minute), ...prefs.defaults(campus, {}, req.activity) });
      $status.textContent = "Preferences reset to defaults.";
    }
  });

  run({ showErrors: false });
  return { dispose() { clearTimeout(typing); session.invalidate(); } };
}

/** Only values changed by hand are remembered (see prefs.js). */
function remember(f, name, campus) {
  const req = readForm(f);
  if (["preparation", "cleanup"].includes(name) && req.activity && Number.isInteger(req[name])) {
    prefs.savePrefs({ [`${name}ByActivity`]: { [req.activity]: req[name] } }, campus);
  }
  const int = (v) => Number.isInteger(v);
  if (name === "from") {
    prefs.savePrefs({ from: req.from }, campus);
    draft.lastSelected = false;
  }
  if (name === "buffer" && int(req.buffer)) prefs.savePrefs({ buffer: req.buffer }, campus);
  if (name === "minActivity" && req.activity && int(req.minActivity)) {
    prefs.savePrefs({ minByActivity: { [req.activity]: req.minActivity } }, campus);
  }
  if (name === "preferQuiet" || name === "preferShortTravel") {
    prefs.savePrefs({ preferQuiet: req.preferQuiet, preferShortTravel: req.preferShortTravel }, campus);
  }
  if (name === "needs") prefs.savePrefs({ needs: f.elements.activity.value === "study" ? req.needs : [] }, campus);
}

// ---------- form ----------
function formHTML(campus) {
  const options = (blank) => `<option value="">${blank}</option>`
    + campus.locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
  return `<form class="panel plan" id="plan" novalidate aria-label="Your free time">
    <p class="field-label">I have time to…</p><fieldset class="pick"><legend>Activity</legend>
      ${campus.activities.map((a) => `<label><input type="radio" name="activity" value="${esc(a.id)}"><span>${icon(a.id, 20)}${esc(a.label)}</span></label>`).join("")}
    </fieldset>

    <fieldset class="presets"><legend>Free time <span class="until num" id="until"></span></legend>
      <div class="segmented window-mode" role="radiogroup" aria-label="How to enter your free time">
        <label><input type="radio" name="mode" value="duration"><span>How long</span></label>
        <label><input type="radio" name="mode" value="until"><span>Until next class</span></label>
      </div>
      <div class="duration-block">
        <div class="preset-row">
          ${PRESETS.map((m) => `<label><input type="radio" name="preset" value="${m}"><span class="num">${m} min</span></label>`).join("")}
          <label><input type="radio" name="preset" value="custom"><span>Other</span></label>
        </div>
        <label class="field custom" hidden><span class="field-label">Minutes free</span>
          <input name="custom" type="number" min="5" max="720" inputmode="numeric" enterkeyhint="done"></label>
      </div>
      <div class="until-block" hidden>
        <label class="field"><span class="field-label">Next class or commitment starts</span>
          <input name="until" type="time" aria-describedby="until-help"></label>
        <p class="help" id="until-help"></p>
      </div>
    </fieldset>

    <label class="field"><span class="field-label">Starting point <span class="tag-soft" id="last-selected" hidden>Last selected</span></span>
      <select name="from" aria-describedby="from-help">${options("Not set")}</select></label>
    <p class="help" id="from-help"></p>

    <details class="prefs" id="prefs">
      <summary>${icon("sliders", 18)}<span class="prefs-label">Preferences</span><span class="prefs-sum" id="prefs-sum"></span>${icon("down", 16)}</summary>
      <div class="prefs-body">
        <div class="field-pair">
          <label class="field"><span class="field-label">Start <span class="tag-soft">Demo clock</span></span><input name="start" type="time"></label>
          <label class="field"><span class="field-label">Next stop</span><select name="to" aria-describedby="to-help">${options("None")}</select></label>
        </div>
        <p class="help" id="to-help"></p>
        <div class="field-pair">
          <label class="field"><span class="field-label">Minimum <span class="opt">min</span></span>
            <input name="minActivity" type="number" min="5" max="600" inputmode="numeric" enterkeyhint="done"></label>
          <label class="field"><span class="field-label">Buffer <span class="opt">min</span></span>
            <input name="buffer" type="number" min="0" max="120" inputmode="numeric" enterkeyhint="done" aria-describedby="buffer-help"></label>
        </div>
        <p class="help" id="buffer-help">Minimum: activity time, excluding preparation, cleanup and walking. Buffer: kept free before your next commitment.</p>
        <div class="field-pair">
          <label class="field"><span class="field-label">Preparation (min)</span><input name="preparation" type="number" min="0" max="120" inputmode="numeric"></label>
          <label class="field"><span class="field-label">Cleanup (min)</span><input name="cleanup" type="number" min="0" max="120" inputmode="numeric"></label>
        </div>
        <p class="help">Editable planning allowances: study 3 + 2, eat 5 + 2, work out 5 + 5 minutes. Food preparation includes getting food; these are not measured queues or service times.</p>
        <fieldset class="checks"><legend>Access for this visit</legend>
          ${[["library", "Mugar: I meet the library entry requirements"], ["fitness", "FitRec: membership/eligible student, waiver and Terrier Card"], ["dining", "Dining: I have an accepted meal/payment method and can enter"]].map(([id,label]) => `<label class="field"><span class="field-label">${label}</span><select name="access-${id}"><option value="">Check access</option><option value="yes">Yes, checked</option><option value="no">No</option></select></label>`).join("")}
          <p class="help">Check the facility sources below. No identity collected; access choices stay in this session. Dining access does not establish library access.</p>
        </fieldset>
        <fieldset class="checks"><legend>Rank by (otherwise: More activity time)</legend>
          <label class="check"><input type="checkbox" name="preferQuiet"><span>Prefer quieter</span></label>
          <label class="check"><input type="checkbox" name="preferShortTravel"><span>Less walking</span></label>
        </fieldset>
        <fieldset class="checks study-needs"><legend>Study needs</legend>
          ${Object.entries(campus.amenity_labels).map(([id, label]) => `<label class="check"><input type="checkbox" name="needs" value="${esc(id)}"><span>${esc(label)}</span></label>`).join("")}
          <p class="help">Only places whose sample data lists it.</p>
        </fieldset>
        <button class="btn btn-quiet" type="button" data-reset>${icon("reset", 16)} Reset preferences</button>
      </div>
    </details>

    <p class="form-error" role="alert"></p>
    <button class="btn btn-primary btn-block" type="submit">Find options</button>
    <details class="samples"><summary>Try a sample</summary>
      ${campus.scenarios.map((s) => `<button class="link" type="button" data-scenario="${esc(s.id)}">${esc(s.label)}</button>`).join("")}</details>
  </form>`;
}

function readForm(f) {
  const d = new FormData(f);
  const num = (k) => (String(d.get(k) ?? "").trim() === "" ? NaN : Number(d.get(k)));
  const preset = d.get("preset");
  const activity = d.get("activity") || "";
  const mode = d.get("mode") === "until" ? "until" : "duration";
  const start = d.get("start") || "";
  const until = d.get("until") || "";
  return {
    activity, start, mode, until,
    // "until": minutes come from the two times (the engine re-derives and validates them).
    minutes: mode === "until" ? engine.minutesUntil(start, until) ?? NaN
      : preset === "custom" ? num("custom") : preset ? Number(preset) : NaN,
    source: "manual", from: d.get("from") || "", to: d.get("to") || null,
    preparation: num("preparation"), cleanup: num("cleanup"),
    access: Object.fromEntries(["library", "fitness", "dining"].map(k => [k, d.get(`access-${k}`)])),
    minActivity: num("minActivity"), buffer: num("buffer"),
    preferQuiet: d.has("preferQuiet"), preferShortTravel: d.has("preferShortTravel"),
    needs: activity === "study" ? d.getAll("needs") : [],
  };
}

/** The duration-mode minutes as the preset/custom fields hold them (NaN when unset). */
function durationMinutes(f) {
  const el = f.elements;
  if (el.preset.value === "custom") return el.custom.value.trim() === "" ? NaN : Number(el.custom.value);
  return el.preset.value ? Number(el.preset.value) : NaN;
}

/** Window fields only: mode, duration presets, next-commitment time. */
function fillWindow(f, req) {
  const el = f.elements;
  const mode = req.mode === "until" ? "until" : "duration";
  for (const r of el.mode) r.checked = r.value === mode;
  if (req.until != null) el.until.value = req.until;
  if (mode === "until") return; // the duration fields keep what they had, for switching back
  const preset = !Number.isFinite(req.minutes) ? (el.preset.value === "custom" ? "custom" : "")
    : PRESETS.includes(req.minutes) ? String(req.minutes) : "custom";
  for (const r of el.preset) r.checked = r.value === preset;
  el.custom.value = preset === "custom" && Number.isFinite(req.minutes) ? req.minutes : "";
}

function fill(f, req, campus) {
  const el = f.elements;
  for (const r of el.activity) r.checked = r.value === req.activity;
  el.start.value = req.start;
  // Samples and fixes carry no mode: they are durations, so the form switches back to "How long".
  fillWindow(f, req.mode === "until" ? req : { ...req, mode: "duration" });
  el.from.value = req.from ?? "";
  el.to.value = req.to ?? "";
  const allowance = engine.allowances(req);
  el.preparation.value = allowance.preparation ?? 0;
  el.cleanup.value = allowance.cleanup ?? 0;
  for (const k of ["library", "fitness", "dining"]) el[`access-${k}`].value = req.access?.[k] ?? "";
  el.minActivity.value = Number.isFinite(req.minActivity) ? req.minActivity : "";
  el.buffer.value = Number.isFinite(req.buffer) ? req.buffer : campus.default_buffer;
  el.preferQuiet.checked = req.preferQuiet;
  el.preferShortTravel.checked = req.preferShortTravel;
  for (const c of f.querySelectorAll('[name="needs"]')) c.checked = req.needs.includes(c.value);
  syncForm(f, campus);
}

/** Derived bits: custom field, study needs, end time, help lines, the Preferences summary. */
function syncForm(f, campus) {
  const req = readForm(f);
  const untilMode = req.mode === "until";
  f.querySelector(".duration-block").hidden = untilMode;
  f.querySelector(".until-block").hidden = !untilMode;
  f.querySelector(".custom").hidden = f.elements.preset.value !== "custom";
  f.querySelector(".study-needs").hidden = req.activity !== "study";
  const startOk = /^\d\d:\d\d$/.test(req.start);
  if (untilMode) {
    const m = engine.minutesUntil(req.start, req.until);
    f.querySelector("#until").textContent = m == null ? "" : m > 0 ? `· ${m} min free` : "";
    f.querySelector("#until-help").textContent = startOk
      ? `From ${fmtTime(toMin(req.start))} on the demo clock (change Start under Preferences). Same day only.`
      : "Set a start time under Preferences.";
  } else {
    const end = startOk && Number.isFinite(req.minutes) ? toMin(req.start) + req.minutes : null;
    f.querySelector("#until").textContent = end == null ? "" : end > engine.DAY_END ? "· past midnight" : `· until ${fmtTime(end % (24 * 60))}`;
  }
  f.querySelector("#last-selected").hidden = !(draft.lastSelected && req.from);
  f.querySelector("#from-help").textContent = req.from ? "" : "Set it to check walking time. BU-sy never detects your location.";
  f.querySelector("#to-help").textContent = req.to ? "" : "No next stop: the walk after isn't counted.";
  const rank = req.preferQuiet ? "quieter first" : req.preferShortTravel ? "shorter walk first" : "most time first";
  const start = /^\d\d:\d\d$/.test(req.start) ? fmtTime(toMin(req.start)) : "no start";
  f.querySelector("#prefs-sum").textContent = [
    start, req.to ? `then ${engine.locationName(campus, req.to)}` : null,
    Number.isFinite(req.minActivity) ? `${req.minActivity} min minimum` : null,
    Number.isFinite(req.buffer) ? `${req.buffer}-min buffer` : null, rank,
  ].filter(Boolean).join(" · ");
}

function fieldFor(f, field) {
  const el = f.elements;
  return {
    preparation: el.preparation, cleanup: el.cleanup, activity: el.activity[0], start: el.start, from: el.from, to: el.to, buffer: el.buffer, minActivity: el.minActivity,
    minutes: el.preset.value === "custom" ? el.custom : el.preset[0], until: el.until,
  }[field];
}

// ---------- results ----------
function startState(missing) {
  const window = missing.includes("until") ? "when your next class starts" : "how long you're free";
  const text = missing.length === 2 ? `Choose an activity and ${window}.`
    : missing[0] === "activity" ? "Now choose an activity." : `Now choose ${window}.`;
  return `<div class="start-state">${terrier({ size: 44 })}<p class="start-title">${text}</p>
    <p>Options appear here. Everything else has a default under Preferences.</p></div>`;
}

function statusText(r) {
  const fits = r.options.length + r.more.length;
  if (fits) return `${fits} ${fits === 1 ? "place fits" : "places fit"}.`;
  if (r.browse.length) return `${r.browse.length} could work. Travel not checked.`;
  if (r.checkAccess.length || r.checkHours.length) return "Complete access or operating-hours checks before choosing a plan.";
  return "Nothing fits this window.";
}

function buttonText(r) {
  const fits = r.options.length + r.more.length;
  if (fits) return `See ${plural(fits, "option", "options")}`;
  if (r.browse.length) return `See ${r.browse.length} that could work`;
  if (r.checkAccess.length || r.checkHours.length) return "See checks to complete";
  return "See why nothing fits";
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const MODE = { synthetic: ["Simulated", "Simulated from outside data or a model, not a BU measurement"], historical_playback: ["Historical", "Recorded data replayed, not live"], live: ["Live", "Live feed"] };
/** Data-mode chip; for simulated places it links to Sources & Simulation. */
const modeChip = (place) => {
  const [text, title] = MODE[place.data_mode] ?? [place.data_mode, ""];
  return place.data_mode === "synthetic"
    ? `<a class="chip-mode chip-link" href="#/sources" title="${esc(title)}">${esc(text)}</a>`
    : `<span class="chip-mode" title="${esc(title)}">${esc(text)}</span>`;
};

function resultsHTML(r, campus) {
  const req = r.request;
  const act = engine.activityInfo(campus, req.activity);
  const from = req.from ? engine.locationName(campus, req.from) : null;
  const meta = [
    `${icon(act.id, 14)} ${esc(act.label)}`,
    `<span class="num">${fmtTime(r.window.start)}–${fmtTime(r.window.end)}</span>${req.mode === "until" ? " (until next class)" : ""}`,
    ...(req.date ? [`<span title="The simulated occupancy replays this day; hours are checked for the same date">Demo day ${esc(dateLabel(req.date))}</span>`] : []),
    from ? `${esc(from)}${req.to ? ` → ${esc(engine.locationName(campus, req.to))}` : ""}` : "No starting point",
    ...(from && !req.to ? [`<span title="Only the walk there is counted">No next stop · walk after not counted</span>`] : []),
  ].map((x) => `<span>${x}</span>`).join("");
  const head = (title) => `<div class="results-head"><h2 class="results-title">${title}</h2><p class="results-meta">${meta}</p>
    <p class="stale-note">Finish editing to update.</p></div>`;
  const fits = r.options.length + r.more.length;

  let body;
  if (fits) {
    const [top, ...rest] = r.options;
    const tie = r.options.length > 1 && !r.featured
      ? top.busy.level === "unknown" ? "No best match: no busyness data for this option" : "No clear best match: tied with others, listed by name"
      : null;
    body = `${head(`${plural(fits, "place fits", "places fit")}`)}
      <ol class="recs list">
        ${card(top, { req, campus, hero: true, featured: r.featured, reason: r.featured?.why ?? tie })}
        ${rest.map((o) => card(o, { req, campus, reason: engine.rankReason(o, top) })).join("")}
      </ol>
      ${r.more.length ? `<details class="more"><summary>${r.more.length} more also fit</summary><ol class="recs">${r.more.map(o => card(o, { req, campus, reason: engine.rankReason(o, top) })).join("")}</ol></details>` : ""}`;
  } else if (r.browse.length) {
    const shown = r.browse.slice(0, engine.MAX_SHOWN);
    body = `${head(plural(r.browse.length, "place could work", "places could work"))}
      <div class="callout">${icon("walk", 18)}<p><strong>Travel not checked.</strong> Choose a starting point to see what fits with the walk.</p>
        <button class="btn btn-small" type="button" data-focus-from>Set starting point</button></div>
      <ol class="recs list">${shown.map((o) => card(o, { req, campus })).join("")}</ol>
      ${r.browse.length > shown.length ? moreList(`${r.browse.length - shown.length} more could work`, r.browse.slice(shown.length), (o) => `Up to ${o.activity} min before walking`) : ""}`;
  } else {
    const considered = r.excluded.length + r.checkHours.length;
    body = `${head(r.checkAccess.length || r.checkHours.length ? "Complete the checks below" : "Nothing fits this window")}
      <div class="empty">
        ${r.reasons.length ? `<p>Of ${plural(considered, "place", "places")} for ${esc(act.verb)}: ${r.reasons.map((x) => `${x.count} ${esc(x.text)}`).join("; ")}.</p>` : ""}
        ${r.suggestions.length
          ? `<p class="muted">These changes would fit:</p><div class="fixes">${r.suggestions.map((s) => `<button class="btn" type="button" data-patch="${esc(JSON.stringify(s.patch))}">${esc(s.label)}<span>${esc(s.detail)}</span></button>`).join("")}</div>`
          : `<p class="muted">${r.checkAccess.length || r.checkHours.length ? "Time alone is not confirmation. Complete the checks below before choosing." : "Try more time, a shorter minimum, or another activity."}</p>`}
      </div>
      ${r.excluded.length ? `<ul class="list why-not">${r.excluded.map(excludedRow).join("")}</ul>` : ""}`;
  }

  const check = r.checkHours.length ? `<section class="check-hours"><h3 class="section-title">Hours unknown</h3>
    <p class="help">Enough time, but no hours in the data. Check before going.</p>
    <ul class="list">${r.checkHours.map((o) => `<li class="row row-static"><span class="row-main"><span class="row-name">${esc(o.place.name)}</span>
      <span class="row-sub">${o.upTo ? `Up to ${o.activity} min · walk not checked` : `${o.activity} min · ${o.there + o.onward} min walking`}</span></span>${level(o.busy.level)}<a class="btn" href="#/place/${encodeURIComponent(o.place.facility_id)}">Check details</a></li>`).join("")}</ul></section>` : "";
  const excluded = r.excluded.length && (fits || r.browse.length)
    ? `<details class="more"><summary>Why ${plural(r.excluded.length, "other place doesn't", "other places don't")} fit</summary>
      <ul class="list">${r.excluded.map(excludedRow).join("")}</ul></details>` : "";

  const access = r.checkAccess.length ? `<section><h3>Check access</h3><p class="help">These visits fit the illustrative time budget. Confirm eligibility under Preferences before choosing.</p><ol class="recs">${r.checkAccess.map(o => card(o, { req, campus })).join("")}</ol></section>` : "";
  return `${body}${check}${access}${excluded}
    <p class="fineprint">${icon("info", 14)} Suggestions, not reservations. Busyness is simulated: <a href="#/sources">Sources &amp; Simulation</a></p>`;
}

const excludedRow = (e) => `<li class="row row-static"><span class="row-main"><span class="row-name">${esc(e.place.name)}</span>
  <span class="row-sub">${esc(e.reason)}</span></span>${e.code === "route" ? `<a class="btn" href="#/place/${encodeURIComponent(e.place.facility_id)}">Check details</a>` : ""}</li>`;

const moreList = (title, list, sub) => `<details class="more"><summary>${title}</summary><ul class="list">
  ${list.map((o) => `<li class="row"><span class="row-main"><span class="row-name">${esc(o.place.name)}</span>
    <span class="row-sub num">${sub(o)}</span></span><span class="row-side">${level(o.busy.level)}</span></li>`).join("")}</ul></details>`;

const stat = (value, unit, caption) => `<div class="stat"><span class="stat-value"><span class="stat-num num">${value}</span>${unit ? `<span class="stat-unit">${unit}</span>` : ""}</span><span class="stat-cap">${caption}</span></div>`;

function card(o, { req, campus, hero = false, featured = null, reason = null }) {
  const act = engine.activityInfo(campus, req.activity);
  const busy = engine.busynessText(o, req);
  const visit = engine.visitText(o);
  const hours = o.hours ? { text: engine.hoursBasisText(o.hours) } : engine.hoursStatus(o.place);
  const checked = o.there != null;
  const badge = featured ? `<span class="badge">${featured.kind === "best" ? "Best match" : "Only fit"}</span>` : "";
  const walk = !checked ? stat("—", "", "walk not checked")
    : stat(o.there, "min", o.there ? "walk there" : "same building");
  const time = checked ? stat(o.activity, "min", `to ${esc(act.verb)}`) : stat(o.activity, "min", "at most, before walking");
  const why = reason ?? (checked ? null : o.opensAt ? `Opens at ${fmtShort(o.opensAt)} (sample hours)` : null);

  const toName = req.to ? engine.locationName(campus, req.to) : null;
  const steps = checked ? [
    [o.free ? "Leave at" : "Leave", fmtTime(o.depart)],
    ...(o.there ? [["Arrive", fmtTime(o.arrive)]] : []),
    ["Leave by", fmtTime(o.leaveBy)],
    ...(toName ? [[`At ${toName}`, fmtTime(o.arriveNext)]] : []),
    ["Next commitment", fmtTime(o.windowEnd)],
  ] : [];
  const scope = "Counts the whole building, not free seats, courts or equipment.";

  return `<li class="rec${hero ? " rec-hero" : ""}">
    <div class="rec-top">${badge}${modeChip(o.place)}
      <a class="rec-link" href="#/place/${encodeURIComponent(o.place.facility_id)}">View place ${icon("chevron", 14)}</a></div>
    <h3 class="rec-name">${esc(o.place.name)}</h3>
    <div class="stats">${time}${walk}</div>
    <div class="rec-busy">${level(o.busy.level, `${busy.label}${o.busy.level === "unknown" ? "" : " (when you leave)"}`)}</div>
    ${visit ? `<div class="rec-visit"><span class="visit-label">${esc(visit.label)}</span>
      <span class="visit-bar" aria-hidden="true">${o.visit.segments.map((s) => `<span class="vseg" data-level="${s.level}" style="flex-grow:${s.end - s.start}"></span>`).join("")}</span>
      <span class="visit-span num">${fmtTime(o.visit.start)}–${fmtTime(o.visit.end)} estimated visit</span></div>` : ""}
    ${why ? `<p class="rec-reason">${esc(why)}</p>` : ""}
    ${o.status === "fit" ? `<button type="button" class="btn btn-primary" data-choose="${esc(o.place.place_id)}">Choose this plan</button>` : o.status === "unchecked" ? `<button type="button" class="btn" data-focus-from>Complete travel details</button>` : `<button type="button" class="btn" data-check-access="${esc(o.place.metadata?.access?.group)}">Check access</button>`}
    ${metadataHTML(o.place)}
    <details class="why"><summary>${checked ? "Why this fits" : "Details"} ${icon("down", 14)}</summary>
      <div class="why-body">
        ${checked ? `<div class="budget" aria-hidden="true">${o.budget.filter((b) => b.minutes > 0)
          .map((b) => `<span class="seg seg-${b.kind}" style="flex-grow:${b.minutes}"></span>`).join("")}</div>` : ""}
        <p class="why-sum">${esc(engine.budgetSentence(o, req, campus))}</p>
        ${steps.length ? `<ol class="timeline">${steps.map(([k, v]) => `<li><span>${esc(k)}</span><strong class="num">${v}</strong></li>`).join("")}</ol>` : ""}
        ${checked ? `<ul class="why-list">${engine.whyItFits(o, req, campus, featured).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
        <dl class="facts">
          <dt>When you leave</dt><dd>${esc(busy.basis)}${o.busy.observedAt ? ` Last count ${fmtHHMM(o.busy.observedAt)}.` : ""}</dd>
          <dt>During visit</dt><dd>${visit ? esc(visit.basis) : "Not estimated: choose a starting point so the arrival time can be worked out."}</dd>
          <dt>Source</dt><dd>${esc(MODE[o.place.data_mode]?.[1] ?? o.place.data_mode)}.</dd>
          <dt>Walk</dt><dd>${esc(campus.travel_note)}</dd>
          <dt>Hours</dt><dd>${esc(hours.text)}</dd>
          <dt>Limits</dt><dd>${scope}</dd>
        </dl>
      </div>
    </details>
  </li>`;
}

export function metadataHTML(place) {
  const m = place.metadata;
  if (!m) return "";
  const labels = { identity: "Name", address: "Address", access: "Access", payment: "Payment", currentHours: "Current operating schedule", plannerHours: "Demo schedule", studyAmenities: "Study amenities" };
  return `<details class="why"><summary>Facility details &amp; sources</summary><dl class="facts">${Object.entries(m).filter(([,v]) => v && typeof v === "object" && v.text).map(([k,v]) => `<dt>${esc(labels[k] ?? k)}</dt><dd>${esc(v.text)} <span class="help">${esc((v.status ?? "unknown").replaceAll("_", " "))}${v.checked ? ` · checked ${esc(v.checked)}` : ""}${v.effectiveFrom ? ` · applies ${esc(v.effectiveFrom)} through ${esc(v.effectiveThrough)}` : ""}</span>${v.url ? ` <a href="${esc(v.url)}" target="_blank" rel="noopener">Official source</a>` : ""}</dd>`).join("")}</dl></details>`;
}

export function directionsURL(place) {
  const a = place.metadata?.address;
  return a?.status === "verified" && a.text ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a.text)}&travelmode=walking` : null;
}

export function selectedPlanHTML(o, req, campus) {
  if (o.status !== "fit") return "";
  const act = engine.activityInfo(campus, req.activity);
  const interval = (a,b) => `${fmtTime(a)}–${fmtTime(b)}`;
  const steps = [
    ["Window starts", fmtTime(o.windowStart)],
    ["Depart", fmtTime(o.depart)], ["Arrive at facility", fmtTime(o.arrive)],
    ["Preparation (allowance)", interval(o.arrive,o.activityStart)],
    [act.label, interval(o.activityStart,o.activityEnd)],
    ["Cleanup (allowance)", interval(o.activityEnd,o.leaveBy)],
    ["Latest departure from facility", fmtTime(o.leaveBy)],
    ...(req.to ? [[`Arrive at ${engine.locationName(campus,req.to)}`,fmtTime(o.arriveNext)]] : [["Onward travel", "Not counted: no next destination"]]),
    ["Protected buffer", interval(o.bufferStart,o.bufferEnd)],
    ["Commitment boundary", fmtTime(o.windowEnd)],
  ];
  const directions = directionsURL(o.place);
  const official = o.place.metadata?.identity?.url;
  return `<article class="panel selected-plan" aria-label="Chosen plan">
    <p class="help">Chosen plan · historical demo Monday, October 19, 2026</p>
    <p class="help">Time fit uses ${o.hours?.basis === "verified"
      ? `verified BU ${o.hours.kind === "service" ? "meal-service" : "building"} hours for ${esc(dateLabel(o.hours.date))}`
      : "illustrative demo hours"} and sample walks; access is self-confirmed. Verify current hours before a real visit.</p>
    ${o.visit ? `<p class="help">${esc(engine.visitText(o).label)}: ${esc(engine.visitText(o).basis)}</p>` : ""}
    <h2>${esc(o.place.name)}</h2><p class="title">${o.activity} minutes to ${esc(act.verb)}</p>
    <ol class="timeline">${steps.map(([label,time]) => `<li><span>${esc(label)}</span><strong>${esc(time)}</strong></li>`).join("")}</ol>
    ${o.free ? `<p class="help">${o.free} minutes free before departure while waiting for opening.</p>` : ""}
    ${o.spare ? `<p class="help">${o.spare} minutes unused after leaving early for closing; the buffer stays protected.</p>` : ""}
    <p>${esc(engine.budgetSentence(o,req,campus))}</p>
    <p class="help">${esc(campus.travel_note)} Starting point manually selected: ${esc(engine.locationName(campus,req.from))}. External directions may use a different origin and route; they do not validate these walking allowances.</p>
    ${directions ? `<a class="btn" href="${esc(directions)}" target="_blank" rel="noopener">Open directions</a>` : official ? `<a class="btn" href="${esc(official)}" target="_blank" rel="noopener">Official facility page</a>` : `<a class="btn" href="#/place/${encodeURIComponent(o.place.facility_id)}">Facility details</a>`}
    ${metadataHTML(o.place)}
    <p class="fineprint">No reservation, guaranteed availability or calendar event. Busyness is simulated, not a prediction for arrival. <a href="#/sources">Sources &amp; Simulation</a></p>
    <button class="btn" type="button" data-change-plan>Change plan</button>
    <button class="btn btn-primary" type="button" data-edit-inputs>Edit inputs</button>
  </article>`;
}
