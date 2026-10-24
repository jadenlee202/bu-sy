// Screen: "What fits now?" Collects a manual free window, runs the shared
// engine (recommend.js) and explains each suggestion. No logic here decides
// what fits; it only reads the form and renders the engine's result.
import { fmtTime, toHHMM, toMin } from "./clock.js";
import { icon, paw, terrier } from "./icons.js";
import * as engine from "./recommend.js";
import * as src from "./source.js";
import { esc, failure, level, loading } from "./ui.js";

const PRESETS = [30, 45, 60, 90];
const PLAYBACK = [7 * 60, 23 * 60]; // range the demo clock can show

// Kept for the session, so going to a facility and back keeps the inputs.
const draft = { req: null, startEdited: false, minEdited: false, shown: false };

const header = () => `
  <div class="plan-head">
    <h1 class="title">What fits now?</h1>
    <p class="tagline">Make the most of your time between classes.</p>
  </div>`;

export async function planView($view, clock) {
  $view.innerHTML = header() + loading("Loading sample campus data…");
  let campus, histories;
  try {
    campus = await src.getCampus();
    const ids = [...new Set(campus.places.map((p) => p.facility_id))];
    histories = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await src.getHistory(id)])));
  } catch (err) {
    $view.innerHTML = header() + failure(err);
    return {};
  }

  const first = campus.activities[0];
  draft.req ??= {
    activity: first.id, start: toHHMM(clock.minute), minutes: 60, source: "manual", from: "", to: null,
    minActivity: first.default_min, buffer: campus.default_buffer, preferQuiet: true, preferShortTravel: false, needs: [],
  };
  if (!draft.startEdited) draft.req.start = toHHMM(clock.minute);

  const [sample, ...moreSamples] = campus.scenarios;
  $view.innerHTML = `${header()}
    <div class="plan-bar">
      <button class="btn" type="button" data-scenario="${esc(sample.id)}">${paw(16)} Try a sample scenario</button>
      <a class="btn btn-quiet" href="#/places">Browse facilities ${icon("chevron", 16)}</a>
    </div>
    <p class="hint"><span class="tag">${esc(campus.label)}</span> Sample ${esc(campus.demo_day)}.
      More samples: ${moreSamples.map((s) => `<button class="link" type="button" data-scenario="${esc(s.id)}">${esc(s.label)}</button>`).join(" · ")}</p>
    ${formHTML(campus)}
    <section id="results" class="results" tabindex="-1" aria-live="polite" aria-label="Suggestions"></section>`;

  const $form = $view.querySelector("#plan");
  const $results = $view.querySelector("#results");
  fill($form, draft.req, campus);

  function run() {
    const req = readForm($form);
    draft.req = req;
    const $err = $form.querySelector(".form-error");
    for (const el of $form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    const result = engine.recommend(req, campus, histories);
    if (!result.ok) {
      $err.textContent = result.errors.map((e) => e.message).join(" ");
      const bad = result.errors.map((e) => fieldFor($form, e.field)).filter(Boolean);
      for (const el of bad) el.setAttribute("aria-invalid", "true");
      bad[0]?.focus();
      return;
    }
    $err.textContent = "";
    const minute = toMin(req.start);
    if (minute >= PLAYBACK[0] && minute <= PLAYBACK[1]) clock.set(minute); // facility pages show the same demo time
    draft.shown = true;
    $results.classList.remove("is-stale");
    $results.innerHTML = resultsHTML(result, campus);
    $results.focus();
  }

  $form.addEventListener("submit", (e) => { e.preventDefault(); run(); });
  $form.addEventListener("input", (e) => {
    if (e.target.name === "start") draft.startEdited = true;
    if (e.target.name === "minActivity") draft.minEdited = true;
    if (e.target.name === "activity" && !draft.minEdited) {
      $form.elements.minActivity.value = engine.activityInfo(campus, e.target.value).default_min;
    }
    syncForm($form);
    draft.req = readForm($form);
    if (draft.shown) $results.classList.add("is-stale");
  });

  const apply = (req) => {
    fill($form, req, campus);
    draft.req = readForm($form);
    run();
  };
  $view.addEventListener("click", (e) => {
    const scenario = e.target.closest("[data-scenario]");
    if (scenario) {
      draft.startEdited = true;
      draft.minEdited = false;
      apply(engine.requestFromScenario(campus.scenarios.find((s) => s.id === scenario.dataset.scenario)));
    }
    const fix = e.target.closest("[data-patch]");
    if (fix) {
      const patch = JSON.parse(fix.dataset.patch);
      if ("minActivity" in patch && !("activity" in patch)) draft.minEdited = true;
      if ("activity" in patch) draft.minEdited = false;
      apply({ ...readForm($form), ...patch });
    }
  });

  if (draft.shown) run();
  return {};
}

// ---------- form ----------
function formHTML(campus) {
  const options = (blank) => `<option value="">${blank}</option>`
    + campus.locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
  return `<form class="form plan" id="plan" novalidate>
    <fieldset class="segmented seg-3"><legend>I want to</legend>
      ${campus.activities.map((a) => `<label><input type="radio" name="activity" value="${esc(a.id)}"><span>${esc(a.label)}</span></label>`).join("")}
    </fieldset>

    <div class="form-pair">
      <label>Starting at<input name="start" type="time" required></label>
      <div class="readout"><span>Next commitment</span><strong class="num" id="until">—</strong></div>
    </div>

    <fieldset class="presets"><legend>Free for</legend>
      <div class="preset-row">
        ${PRESETS.map((m) => `<label><input type="radio" name="preset" value="${m}"><span>${m} min</span></label>`).join("")}
        <label><input type="radio" name="preset" value="custom"><span>Custom</span></label>
      </div>
      <label class="custom" hidden>Minutes free<input name="custom" type="number" min="5" max="720" inputmode="numeric"></label>
    </fieldset>

    <div class="form-pair">
      <label>Starting from<select name="from" required>${options("Choose a place")}</select></label>
      <label><span>Then heading to <span class="opt">optional</span></span><select name="to">${options("No next stop")}</select></label>
    </div>
    <p class="help" id="route-help"></p>

    <div class="form-pair">
      <label><span>At least <span class="opt">minutes to <span id="verb"></span></span></span><input name="minActivity" type="number" min="5" max="600" inputmode="numeric"></label>
      <label><span>Buffer <span class="opt">minutes</span></span><input name="buffer" type="number" min="0" max="120" inputmode="numeric" aria-describedby="buffer-help"></label>
    </div>
    <p class="help" id="buffer-help">The buffer keeps time free before your next commitment.</p>

    <fieldset class="checks"><legend>Preferences</legend>
      <label class="check"><input type="checkbox" name="preferQuiet"><span>Prefer quieter places</span></label>
      <label class="check"><input type="checkbox" name="preferShortTravel"><span>Prefer shorter walks</span></label>
      <div class="study-needs">
        ${Object.entries(campus.amenity_labels).map(([id, label]) => `<label class="check"><input type="checkbox" name="needs" value="${esc(id)}"><span>Needs ${esc(label.toLowerCase())}</span></label>`).join("")}
        <p class="help">Only places whose sample metadata lists it.</p>
      </div>
      <div class="workout-interests">
        <span class="field-label">Workout type <span class="opt">optional</span></span>
        <div class="interest-row">
          ${Object.entries(campus.interest_labels ?? {}).map(([id, label]) => `<label class="check"><input type="checkbox" name="interests" value="${esc(id)}"><span>${esc(label)}</span></label>`).join("")}
        </div>
        <p class="help">Narrows FitRec to areas tagged for that type in sample metadata. Leave blank for any.</p>
      </div>
    </fieldset>

    <p class="form-error" role="alert"></p>
    <button class="btn btn-primary btn-block">Find options</button>
  </form>`;
}

function readForm(f) {
  const d = new FormData(f);
  const num = (k) => (String(d.get(k) ?? "").trim() === "" ? NaN : Number(d.get(k)));
  const preset = d.get("preset");
  const activity = d.get("activity");
  return {
    activity, start: d.get("start") || "", minutes: preset === "custom" ? num("custom") : Number(preset),
    source: "manual", from: d.get("from") || "", to: d.get("to") || null,
    minActivity: num("minActivity"), buffer: num("buffer"),
    preferQuiet: d.has("preferQuiet"), preferShortTravel: d.has("preferShortTravel"),
    needs: activity === "study" ? d.getAll("needs") : [],
    interests: activity === "workout" ? d.getAll("interests") : [],
  };
}

function fill(f, req, campus) {
  const el = f.elements;
  for (const r of el.activity) r.checked = r.value === req.activity;
  el.start.value = req.start;
  const preset = PRESETS.includes(req.minutes) ? String(req.minutes) : "custom";
  for (const r of el.preset) r.checked = r.value === preset;
  el.custom.value = preset === "custom" && Number.isFinite(req.minutes) ? req.minutes : "";
  el.from.value = req.from ?? "";
  el.to.value = req.to ?? "";
  el.minActivity.value = Number.isFinite(req.minActivity) ? req.minActivity : "";
  el.buffer.value = Number.isFinite(req.buffer) ? req.buffer : campus.default_buffer;
  el.preferQuiet.checked = req.preferQuiet;
  el.preferShortTravel.checked = req.preferShortTravel;
  for (const c of f.querySelectorAll('[name="needs"]')) c.checked = req.needs.includes(c.value);
  for (const c of f.querySelectorAll('[name="interests"]')) c.checked = (req.interests ?? []).includes(c.value);
  f.dataset.verbs = JSON.stringify(Object.fromEntries(campus.activities.map((a) => [a.id, a.verb])));
  syncForm(f);
}

/** Small derived bits of the form: custom field, study needs, end time, route note. */
function syncForm(f) {
  const req = readForm(f);
  const custom = f.querySelector(".custom");
  custom.hidden = f.elements.preset.value !== "custom";
  f.querySelector(".study-needs").hidden = req.activity !== "study";
  const interests = f.querySelector(".workout-interests");
  if (interests) interests.hidden = req.activity !== "workout";
  f.querySelector("#verb").textContent = JSON.parse(f.dataset.verbs)[req.activity] ?? "";
  const end = /^\d\d:\d\d$/.test(req.start) && Number.isFinite(req.minutes) ? toMin(req.start) + req.minutes : null;
  f.querySelector("#until").textContent = end == null ? "—" : end > engine.DAY_END ? "After midnight" : fmtTime(end % (24 * 60));
  f.querySelector("#route-help").textContent = req.to
    ? "You pick both places. BU-sy never detects your location."
    : "You pick where you are; BU-sy never detects it. No next stop: onward travel isn't counted.";
}

function fieldFor(f, field) {
  const el = f.elements;
  return {
    activity: el.activity[0], start: el.start, from: el.from, to: el.to, buffer: el.buffer, minActivity: el.minActivity,
    minutes: f.elements.preset.value === "custom" ? el.custom : el.preset[0],
    needs: f.querySelector('[name="needs"]'), interests: f.querySelector('[name="interests"]'),
  }[field];
}

// ---------- results ----------
function resultsHTML(r, campus) {
  const req = r.request;
  const act = engine.activityInfo(campus, req.activity);
  const where = `${esc(engine.locationName(campus, req.from))}${req.to ? ` → ${esc(engine.locationName(campus, req.to))}` : ""}`;
  const total = r.options.length + r.more.length;
  const summary = `<p class="results-summary">${esc(act.label)} · ${req.minutes} min from ${fmtTime(r.window.start)} · ${where}</p>
    <p class="stale-note">Inputs changed. Select <strong>Find options</strong> to update.</p>`;

  let body;
  if (total) {
    const note = r.options.length > 1 && !r.featured
      ? `<p class="hint">${r.options[0].busy.level === "unknown"
        ? "No best match: busyness is unavailable for the top option."
        : "No single best match: these are equal on busyness level, walking and time, so they're listed by name."}</p>`
      : "";
    body = `<h2 class="results-title">${total} ${total === 1 ? "place fits" : "places fit"}${total > r.options.length ? `<span class="muted"> · top ${r.options.length}</span>` : ""}</h2>
      ${summary}${note}
      <ol class="recs">${r.options.map((o, i) => card(o, i === 0 ? r.featured : null, req, campus)).join("")}</ol>
      ${r.more.length ? `<details class="more"><summary>${r.more.length} more also fit</summary><ul class="list">
        ${r.more.map((o) => `<li class="row row-static"><span class="row-main"><span class="row-name">${esc(o.grouped ? o.facility_name : o.place.name)}</span>
          <span class="row-sub">${o.grouped ? `${o.areas.length} eligible ${o.areas.length === 1 ? "area" : "areas"} · ` : ""}${o.activity} min · ${o.there + o.onward} min walking</span></span>${level(o.busy.level)}</li>`).join("")}
      </ul></details>` : ""}`;
  } else {
    const considered = r.excluded.length + r.checkHours.length;
    body = `<div class="empty">${terrier({ size: 48, sleepy: true })}
      <h2 class="results-title">Nothing fits this window</h2>
      ${summary}
      ${r.reasons.length ? `<p>Of ${considered} ${considered === 1 ? "place" : "places"} for ${esc(act.verb)}: ${r.reasons.map((x) => `${x.count} ${esc(x.text)}`).join("; ")}.</p>` : ""}
      ${r.suggestions.length
        ? `<p class="muted">These changes would fit:</p><div class="fixes">${r.suggestions.map((s) => `<button class="btn" type="button" data-patch="${esc(JSON.stringify(s.patch))}">${esc(s.label)}<span>${esc(s.detail)}</span></button>`).join("")}</div>`
        : `<p class="muted">Try a longer window, a shorter minimum, or a different activity.</p>`}
    </div>`;
  }

  const check = r.checkHours.length ? `<section class="check-hours"><h3 class="section-title">Check hours before going</h3>
    <p class="hint">These fit your time, but the sample data has no hours for them, so they aren't confirmed.</p>
    <ul class="list">${r.checkHours.map((o) => `<li class="row row-static"><span class="row-main"><span class="row-name">${esc(o.grouped ? o.facility_name : o.place.name)}</span>
      <span class="row-sub">${esc(engine.budgetSentence(o, req, campus))}</span></span>${level(o.busy.level)}</li>`).join("")}</ul></section>` : "";

  const excluded = r.excluded.length && total ? `<details class="more"><summary>Why ${r.excluded.length} other ${r.excluded.length === 1 ? "place doesn't" : "places don't"} fit</summary>
    <ul class="list">${r.excluded.map((e) => `<li class="row row-static"><span class="row-main"><span class="row-name">${esc(e.displayName ?? e.place.name)}</span>
      <span class="row-sub">${esc(e.reason)}</span></span></li>`).join("")}</ul></details>` : "";
  const excludedEmpty = r.excluded.length && !total ? `<ul class="list why-not">${r.excluded.map((e) => `<li class="row row-static"><span class="row-main"><span class="row-name">${esc(e.displayName ?? e.place.name)}</span>
      <span class="row-sub">${esc(e.reason)}</span></span></li>`).join("")}</ul>` : "";

  return `${body}${excludedEmpty}${check}${excluded}
    <p class="disclaimer">${icon("lock", 13)} Suggestions only: not reservations or a guarantee of space. Busyness is a demo count at the selected time,
      not a forecast for when you arrive. Walking times, hours and amenities are samples. <span class="tag">${esc(campus.label)}</span></p>`;
}

function card(o, featured, req, campus) {
  const act = engine.activityInfo(campus, req.activity);
  const busy = engine.busynessText(o, req);
  const hours = engine.hoursStatus(o.place);
  const toName = req.to ? engine.locationName(campus, req.to) : null;
  const grouped = o.grouped && o.areas?.length;
  // One destination card: for a grouped facility (e.g. FitRec) the title is the
  // facility and the eligible areas are listed inside; otherwise it's the place.
  const title = grouped ? o.facility_name : o.place.name;
  const subtitle = grouped
    ? `${esc(act.label)} · ${o.areas.length} eligible ${o.areas.length === 1 ? "area" : "areas"}`
    : `${o.place.area_id ? `${esc(o.place.facility_name)} · ` : ""}${esc(act.label)}`;
  const steps = [
    [o.free ? "Leave at" : "Leave", fmtTime(o.depart)],
    ...(o.there ? [["Arrive", fmtTime(o.arrive)]] : []),
    ["Leave by", fmtTime(o.leaveBy)],
    ...(toName ? [[`At ${toName}`, fmtTime(o.arriveNext)]] : []),
    ["Next commitment", fmtTime(o.windowEnd)],
  ];
  const badge = featured ? `<span class="badge">${featured.kind === "best" ? "Best match" : "Only fit"}</span>` : "";
  return `<li class="rec${featured?.kind === "best" ? " rec-best" : ""}">
    <div class="rec-top">${badge}<span class="tag">${esc(o.place.data_mode === "synthetic" ? "Demo · Synthetic" : o.place.data_mode)}</span></div>
    <h3 class="rec-name">${esc(title)}</h3>
    <p class="rec-sub">${subtitle}</p>
    <div class="rec-busy">${level(o.busy.level, busy.label)}</div>
    <p class="rec-basis">${esc(busy.basis)}${grouped ? " This is the top-ranked area below, not a whole-building count." : ""}</p>
    <div class="budget" aria-hidden="true">${o.budget.filter((b) => b.minutes > 0)
      .map((b) => `<span class="seg seg-${b.kind}" style="flex-grow:${b.minutes}"></span>`).join("")}</div>
    <p class="rec-budget">${esc(engine.budgetSentence(o, req, campus))}</p>
    ${grouped ? areasBlock(o, req, campus) : ""}
    <ol class="timeline">${steps.map(([k, v]) => `<li><span>${esc(k)}</span><strong class="num">${v}</strong></li>`).join("")}</ol>
    <p class="rec-hours">${esc(hours.text)}</p>
    <div class="rec-why"><strong>Why this fits</strong>
      <ul>${engine.whyItFits(o, req, campus, featured).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
    <a class="btn" href="#/place/${encodeURIComponent(o.place.facility_id)}">View facility ${icon("chevron", 16)}</a>
  </li>`;
}

/** Eligible areas inside one facility card. Each keeps its OWN synthetic count
 *  (never summed to a building number) and shows any sample reservation. */
function areasBlock(o, req, campus) {
  const rows = o.areas.map((a) => {
    const b = engine.busynessText(a, req);
    const reserved = a.place.closures.map((c) => esc(c.reason.replace(/^Reserved: /, "")));
    return `<li class="area-row"><span class="row-main"><span class="row-name">${esc(a.place.name)}</span>
      <span class="row-sub">${a.activity} min · ${esc(b.basis)}${reserved.length ? ` · reserved for ${reserved.join(", ")} part of the day (sample)` : ""}</span></span>
      ${level(a.busy.level, b.label)}</li>`;
  }).join("");
  return `<div class="rec-areas"><p class="rec-areas-head">Eligible areas (each a separate sample count, not a building total)</p>
    <ul class="list area-list">${rows}</ul></div>`;
}

