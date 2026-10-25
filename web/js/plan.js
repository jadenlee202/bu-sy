// Screen: "What fits now?" Two required choices (activity, free time); the rest
// has visible defaults under Preferences. Results update as choices change.
// No logic here decides what fits: it reads the form, runs the shared engine
// (recommend.js) and renders the engine's result.
import { fmtHHMM, fmtShort, fmtTime, toHHMM, toMin } from "./clock.js";
import { icon, terrier } from "./icons.js";
import * as prefs from "./prefs.js";
import * as engine from "./recommend.js";
import * as src from "./source.js";
import { esc, failure, level, loading } from "./ui.js";

const PRESETS = [30, 45, 60, 90];
const PLAYBACK = [0, 24 * 60 - 1];  // range the demo clock can show (12 AM-11:59 PM)
const TYPING_MS = 600;              // wait this long after typing before updating
const TYPED = new Set(["custom", "start", "minActivity", "buffer"]);

// Kept for the session, so going to a place and back keeps the inputs.
const draft = { req: null, startEdited: false, lastSelected: false };

const header = () => `
  <div class="page-head">
    <h1 class="title">What fits now?</h1>
    <p class="tagline">Find a spot for your free time.</p>
  </div>`;

export async function planView($view, clock) {
  $view.innerHTML = header() + loading("Loading campus data…");
  let campus, histories;
  try {
    campus = await src.getCampus();
    const ids = [...new Set(campus.places.map((p) => p.facility_id))];
    histories = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await src.getHistory(id)])));
  } catch (err) {
    $view.innerHTML = header() + failure(err);
    return {};
  }

  if (!draft.req) {
    const saved = prefs.loadPrefs(campus);
    draft.req = { activity: "", minutes: NaN, start: "", source: "manual", ...prefs.defaults(campus, saved, "") };
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
  fill($form, draft.req, campus);

  /** showErrors: false while someone is still typing, so nothing flashes red mid-entry. */
  function run({ showErrors = true, focus = false } = {}) {
    clearTimeout(typing);
    const req = readForm($form);
    draft.req = req;
    for (const el of $form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    $err.textContent = "";
    $results.classList.remove("is-stale");

    const missing = [!req.activity && "activity", !$form.elements.preset.value && "minutes"].filter(Boolean);
    if (missing.length) {
      if (showErrors && focus) {
        $err.textContent = missing.length === 2 ? "Choose an activity and how long you're free."
          : missing[0] === "activity" ? "Choose an activity." : "Choose how long you're free.";
        fieldFor($form, missing[0])?.focus();
      }
      $results.innerHTML = startState(missing);
      $status.textContent = "";
      $go.textContent = "Find options";
      return;
    }

    const result = engine.recommend(req, campus, histories);
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

  let typing;
  $form.addEventListener("submit", (e) => { e.preventDefault(); run({ focus: true }); });
  $form.addEventListener("input", (e) => {
    if (!TYPED.has(e.target.name)) return;          // choices update on "change" instead
    if (e.target.name === "start") draft.startEdited = true;
    syncForm($form, campus);
    clearTimeout(typing);
    typing = setTimeout(() => run({ showErrors: false }), TYPING_MS);
  });
  $form.addEventListener("change", (e) => {
    const { name } = e.target;
    if (!name) return;
    if (name === "activity") {
      const remembered = prefs.loadPrefs(campus).minByActivity?.[e.target.value];
      $form.elements.minActivity.value = remembered ?? engine.activityInfo(campus, e.target.value).default_min;
    }
    if (name === "preset" && e.target.value === "custom") $form.elements.custom.focus();
    remember($form, name, campus);
    syncForm($form, campus);
    if (name === "preset" && e.target.value === "custom" && !$form.elements.custom.value) return; // wait for a number
    run();
  });

  const apply = (req) => {
    fill($form, req, campus);
    run();
  };
  $view.addEventListener("click", (e) => {
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
  return {};
}

/** Only values changed by hand are remembered (see prefs.js). */
function remember(f, name, campus) {
  const req = readForm(f);
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
    <fieldset class="pick"><legend>Activity</legend>
      ${campus.activities.map((a) => `<label><input type="radio" name="activity" value="${esc(a.id)}"><span>${icon(a.id, 20)}${esc(a.label)}</span></label>`).join("")}
    </fieldset>

    <fieldset class="presets"><legend>Free for <span class="until num" id="until"></span></legend>
      <div class="preset-row">
        ${PRESETS.map((m) => `<label><input type="radio" name="preset" value="${m}"><span class="num">${m} min</span></label>`).join("")}
        <label><input type="radio" name="preset" value="custom"><span>Other</span></label>
      </div>
      <label class="field custom" hidden><span class="field-label">Minutes free</span>
        <input name="custom" type="number" min="5" max="720" inputmode="numeric" enterkeyhint="done"></label>
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
        <p class="help" id="buffer-help">Minimum: time you want there. Buffer: kept free before your next commitment.</p>
        <fieldset class="checks"><legend>Rank by</legend>
          <label class="check"><input type="checkbox" name="preferQuiet"><span>Quieter first</span></label>
          <label class="check"><input type="checkbox" name="preferShortTravel"><span>Shorter walk first</span></label>
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
  return {
    activity, start: d.get("start") || "",
    minutes: preset === "custom" ? num("custom") : preset ? Number(preset) : NaN,
    source: "manual", from: d.get("from") || "", to: d.get("to") || null,
    minActivity: num("minActivity"), buffer: num("buffer"),
    preferQuiet: d.has("preferQuiet"), preferShortTravel: d.has("preferShortTravel"),
    needs: activity === "study" ? d.getAll("needs") : [],
  };
}

function fill(f, req, campus) {
  const el = f.elements;
  for (const r of el.activity) r.checked = r.value === req.activity;
  el.start.value = req.start;
  const preset = !Number.isFinite(req.minutes) ? (el.preset.value === "custom" ? "custom" : "")
    : PRESETS.includes(req.minutes) ? String(req.minutes) : "custom";
  for (const r of el.preset) r.checked = r.value === preset;
  el.custom.value = preset === "custom" && Number.isFinite(req.minutes) ? req.minutes : "";
  el.from.value = req.from ?? "";
  el.to.value = req.to ?? "";
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
  f.querySelector(".custom").hidden = f.elements.preset.value !== "custom";
  f.querySelector(".study-needs").hidden = req.activity !== "study";
  const end = /^\d\d:\d\d$/.test(req.start) && Number.isFinite(req.minutes) ? toMin(req.start) + req.minutes : null;
  f.querySelector("#until").textContent = end == null ? "" : end > engine.DAY_END ? "· past midnight" : `· until ${fmtTime(end % (24 * 60))}`;
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
    activity: el.activity[0], start: el.start, from: el.from, to: el.to, buffer: el.buffer, minActivity: el.minActivity,
    minutes: el.preset.value === "custom" ? el.custom : el.preset[0],
  }[field];
}

// ---------- results ----------
function startState(missing) {
  const text = missing.length === 2 ? "Choose an activity and how long you're free."
    : missing[0] === "activity" ? "Now choose an activity." : "Now choose how long you're free.";
  return `<div class="start-state">${terrier({ size: 44 })}<p class="start-title">${text}</p>
    <p>Options appear here. Everything else has a default under Preferences.</p></div>`;
}

function statusText(r) {
  const fits = r.options.length + r.more.length;
  if (fits) return `${fits} ${fits === 1 ? "place fits" : "places fit"}.`;
  if (r.browse.length) return `${r.browse.length} could work. Travel not checked.`;
  return "Nothing fits this window.";
}

function buttonText(r) {
  const fits = r.options.length + r.more.length;
  if (fits) return `See ${plural(fits, "option", "options")}`;
  if (r.browse.length) return `See ${r.browse.length} that could work`;
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
    `<span class="num">${fmtTime(r.window.start)}–${fmtTime(r.window.end)}</span>`,
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
      <ol class="recs">
        ${card(top, { req, campus, hero: true, featured: r.featured, reason: r.featured?.why ?? tie })}
        ${rest.map((o) => card(o, { req, campus, reason: engine.rankReason(o, top) })).join("")}
      </ol>
      ${r.more.length ? moreList(`${r.more.length} more also fit`, r.more, (o) => `${o.activity} min · ${o.there + o.onward} min walking`) : ""}`;
  } else if (r.browse.length) {
    const shown = r.browse.slice(0, engine.MAX_SHOWN);
    body = `${head(plural(r.browse.length, "place could work", "places could work"))}
      <div class="callout">${icon("walk", 18)}<p><strong>Travel not checked.</strong> Choose a starting point to see what fits with the walk.</p>
        <button class="btn btn-small" type="button" data-focus-from>Set starting point</button></div>
      <ol class="recs">${shown.map((o) => card(o, { req, campus })).join("")}</ol>
      ${r.browse.length > shown.length ? moreList(`${r.browse.length - shown.length} more could work`, r.browse.slice(shown.length), (o) => `Up to ${o.activity} min before walking`) : ""}`;
  } else {
    const considered = r.excluded.length + r.checkHours.length;
    body = `${head("Nothing fits this window")}
      <div class="empty">
        ${r.reasons.length ? `<p>Of ${plural(considered, "place", "places")} for ${esc(act.verb)}: ${r.reasons.map((x) => `${x.count} ${esc(x.text)}`).join("; ")}.</p>` : ""}
        ${r.suggestions.length
          ? `<p class="muted">These changes would fit:</p><div class="fixes">${r.suggestions.map((s) => `<button class="btn" type="button" data-patch="${esc(JSON.stringify(s.patch))}">${esc(s.label)}<span>${esc(s.detail)}</span></button>`).join("")}</div>`
          : `<p class="muted">Try more time, a shorter minimum, or another activity.</p>`}
      </div>
      ${r.excluded.length ? `<ul class="list why-not">${r.excluded.map(excludedRow).join("")}</ul>` : ""}`;
  }

  const check = r.checkHours.length ? `<section class="check-hours"><h3 class="section-title">Hours unknown</h3>
    <p class="help">Enough time, but no hours in the data. Check before going.</p>
    <ul class="list">${r.checkHours.map((o) => `<li class="row row-static"><span class="row-main"><span class="row-name">${esc(o.place.name)}</span>
      <span class="row-sub">${o.upTo ? `Up to ${o.activity} min · walk not checked` : `${o.activity} min · ${o.there + o.onward} min walking`}</span></span>${level(o.busy.level)}</li>`).join("")}</ul></section>` : "";
  const excluded = r.excluded.length && (fits || r.browse.length)
    ? `<details class="more"><summary>Why ${plural(r.excluded.length, "other place doesn't", "other places don't")} fit</summary>
      <ul class="list">${r.excluded.map(excludedRow).join("")}</ul></details>` : "";

  return `${body}${check}${excluded}
    <p class="fineprint">${icon("info", 14)} Suggestions, not reservations. Busyness is simulated: <a href="#/sources">Sources &amp; Simulation</a></p>`;
}

const excludedRow = (e) => `<li class="row row-static"><span class="row-main"><span class="row-name">${esc(e.place.name)}</span>
  <span class="row-sub">${esc(e.reason)}</span></span></li>`;

const moreList = (title, list, sub) => `<details class="more"><summary>${title}</summary><ul class="list">
  ${list.map((o) => `<li class="row row-static"><span class="row-main"><span class="row-name">${esc(o.place.name)}</span>
    <span class="row-sub num">${sub(o)}</span></span>${level(o.busy.level)}</li>`).join("")}</ul></details>`;

const stat = (value, unit, caption) => `<div class="stat"><span class="stat-value"><span class="stat-num num">${value}</span>${unit ? `<span class="stat-unit">${unit}</span>` : ""}</span><span class="stat-cap">${caption}</span></div>`;

function card(o, { req, campus, hero = false, featured = null, reason = null }) {
  const act = engine.activityInfo(campus, req.activity);
  const busy = engine.busynessText(o, req);
  const hours = engine.hoursStatus(o.place);
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
  const scope = o.place.area_id ? "Counts people in this area, not free equipment." : "Counts the whole building, not free seats or equipment.";

  return `<li class="rec${hero ? " rec-hero" : ""}">
    <div class="rec-top">${badge}${modeChip(o.place)}
      <a class="rec-link" href="#/place/${encodeURIComponent(o.place.facility_id)}">View place ${icon("chevron", 14)}</a></div>
    <h3 class="rec-name">${esc(o.place.name)}</h3>
    ${o.place.area_id ? `<p class="rec-sub">${esc(o.place.facility_name)}</p>` : ""}
    <div class="stats">${time}${walk}</div>
    <div class="rec-busy">${level(o.busy.level, busy.label)}</div>
    ${why ? `<p class="rec-reason">${esc(why)}</p>` : ""}
    <details class="why"><summary>${checked ? "Why this fits" : "Details"} ${icon("down", 14)}</summary>
      <div class="why-body">
        ${checked ? `<div class="budget" aria-hidden="true">${o.budget.filter((b) => b.minutes > 0)
          .map((b) => `<span class="seg seg-${b.kind}" style="flex-grow:${b.minutes}"></span>`).join("")}</div>` : ""}
        <p class="why-sum">${esc(engine.budgetSentence(o, req, campus))}</p>
        ${steps.length ? `<ol class="timeline">${steps.map(([k, v]) => `<li><span>${esc(k)}</span><strong class="num">${v}</strong></li>`).join("")}</ol>` : ""}
        ${checked ? `<ul class="why-list">${engine.whyItFits(o, req, campus, featured).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
        <dl class="facts">
          <dt>Busyness</dt><dd>${esc(busy.basis)}${o.busy.observedAt ? ` Last count ${fmtHHMM(o.busy.observedAt)}.` : ""}</dd>
          <dt>Source</dt><dd>${esc(MODE[o.place.data_mode]?.[1] ?? o.place.data_mode)}.</dd>
          <dt>Walk</dt><dd>${esc(campus.travel_note)}</dd>
          <dt>Hours</dt><dd>${esc(hours.text)}</dd>
          <dt>Limits</dt><dd>${scope}</dd>
        </dl>
      </div>
    </details>
  </li>`;
}
