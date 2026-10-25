// Screens: the club directory. Browse → details → sign-up → My clubs, plus an organizer's
// create/edit and review screens. Data and every rule (validation, capacity, waitlist,
// organizer gating) come from source.js, the same in API and static mode; nothing here
// decides who gets a spot. Organizer gating is demo-grade (a device token, not a login).
import { fmtHHMM } from "./clock.js";
import { icon, terrier } from "./icons.js";
import * as src from "./source.js";
import { esc, failure, level, loading } from "./ui.js";

const FILTER_KEY = "busy.clubs.filters";
const NOT_SET = `<span class="muted">Not specified</span>`;
const STATUS_ICON = { Open: "check", Waitlist: "clock", Full: "lock" };
const APP_STATUS = { approved: "Approved", pending: "Pending", waitlisted: "Waitlisted", rejected: "Declined" };

/** Each screen renders into its own wrapper, so its listeners leave with it on navigation. */
function mount($view) {
  const root = document.createElement("div");
  root.className = "screen";
  $view.replaceChildren(root);
  return root;
}

const back = (href, text) => `<a class="back" href="${href}">${icon("back", 16)} ${text}</a>`;
const head = (title, extra = "") => `<div class="page-head"><h1 class="title">${title}</h1>${extra}</div>`;

// ---------- small pieces ----------
/** Availability is never color alone: an icon and the word. */
const statusBadge = (c) => `<span class="club-status" data-status="${c.status.toLowerCase()}">${icon(STATUS_ICON[c.status], 14)}${c.status}</span>`;
const sampleTag = (c) => (c.example ? `<span class="tag tag-sim" title="Sample club for the demo, not a real BU organization">Sample</span>` : "");
const dayShort = (d) => d.slice(0, 3);
const fmtDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

function schedule(c) {
  if (!c.meeting_day && !c.meeting_start) return "Schedule TBD";
  const day = c.meeting_day ? `${c.meeting_day}s` : "Day TBD";
  return c.meeting_start ? `${day}, ${fmtHHMM(c.meeting_start)}–${fmtHHMM(c.meeting_end)}` : `${day}, time TBD`;
}
const place = (c) => [...new Set([c.location_name, c.location_text].filter(Boolean))].join(" · ") || "Location TBD";
const spots = (c) => (c.capacity == null ? "No member limit"
  : `${c.spots_left} of ${c.capacity} spot${c.capacity === 1 ? "" : "s"} left`)
  + (c.waitlist_count ? ` · ${c.waitlist_count} on the waitlist` : "");
const myPill = (a) => (a ? `<span class="pill app-pill" data-app="${a.status}">${APP_STATUS[a.status]}${a.position ? ` · #${a.position}` : ""}</span>` : "");

/** The busyness estimate for the meeting place and time, always labeled as an estimate. */
function hint(c, { detail = false } = {}) {
  const h = c.busyness_hint;
  if (!h) return detail ? `<p class="muted">No estimate: ${c.location_id ? "no meeting time set" : "this place has no busyness data"}.</p>` : "";
  return `<div class="club-hint">${level(h.level, h.label)}</div>
    ${detail ? `<p class="help club-basis">${esc(h.basis)} <a href="#/sources">How places are simulated</a></p>` : ""}`;
}

const modeNote = (mode) => (mode === "static"
  ? `<strong>Demo mode:</strong> clubs you create and your sign-ups are saved in this browser only. Nobody else can see, join or review them.`
  : "Clubs and sign-up counts are shared with everyone using this server. Applications are visible only to each club's organizer.");

function readFilters() {
  try {
    return { query: "", category: "all", day: "all", openOnly: false, ...JSON.parse(src.store.get(FILTER_KEY) ?? "{}") };
  } catch {
    return { query: "", category: "all", day: "all", openOnly: false };
  }
}

// ---------- screen: browse ----------
export async function clubsView($main) {
  const $view = mount($main);
  const mode = await src.getMode();
  const f = readFilters();
  $view.innerHTML = `
    <div class="title-row"><h1 class="title">Clubs</h1>
      <span class="title-actions"><a class="btn" href="#/my-clubs">My clubs</a>
      <a class="btn btn-primary" href="#/clubs/new">${icon("plus", 16)} New club</a></span></div>
    <p class="hint">Find a club, see when it meets and whether it's taking members, then sign up.
      Student-run listings plus labeled sample clubs; not an official BU directory. ${modeNote(mode)}</p>
    <label class="search">${icon("search")}<input type="search" placeholder="Search clubs" aria-label="Search clubs" value="${esc(f.query)}"></label>
    <div id="club-filters"></div>
    <p class="sr-only" id="club-count" role="status"></p>
    <div id="clubs" aria-live="polite">${loading("Loading clubs…")}</div>`;
  const $list = $view.querySelector("#clubs");
  let all, o;
  try {
    [all, o] = await Promise.all([src.clubs.list(), src.clubOptions()]);
  } catch (err) {
    $list.innerHTML = failure(err);
    return {};
  }

  const chips = (name, label, items) => `<div class="chips" role="group" aria-label="${label}">
    ${items.map(([id, text]) => `<button class="chip" data-${name}="${esc(id)}" aria-pressed="${f[name] === id}">${esc(text)}</button>`).join("")}</div>`;
  $view.querySelector("#club-filters").innerHTML = `
    ${chips("category", "Filter by category", [["all", "All"], ...o.categories.map((c) => [c, c])])}
    <div class="chips" role="group" aria-label="Filter by meeting day">
      ${[["all", "Any day"], ...o.days.map((d) => [d, dayShort(d)])].map(([id, text]) => `<button class="chip" data-day="${id}" aria-pressed="${f.day === id}"${id !== "all" ? ` aria-label="${id}"` : ""}>${text}</button>`).join("")}
      <button class="chip chip-toggle" data-open aria-pressed="${f.openOnly}">Open only</button>
    </div>`;

  const save = () => src.store.set(FILTER_KEY, JSON.stringify(f));
  const visible = () => {
    const q = f.query.trim().toLowerCase();
    return all.filter((c) => (f.category === "all" || c.category === f.category)
      && (f.day === "all" || c.meeting_day === f.day)
      && (!f.openOnly || c.status === "Open")
      && (!q || `${c.name} ${c.category} ${c.description} ${c.activities}`.toLowerCase().includes(q)));
  };
  const update = () => {
    const rows = visible();
    $view.querySelector("#club-count").textContent = `${rows.length} club${rows.length === 1 ? "" : "s"} shown`;
    if (!rows.length) {
      $list.innerHTML = `<div class="state">${terrier({ size: 44, sleepy: true })}<p>No clubs match these filters.</p>
        <button class="btn" type="button" data-clear>Clear filters</button></div>`;
      return;
    }
    $list.innerHTML = `<ul class="list clubs">${rows.map(card).join("")}</ul>`;
  };

  $view.querySelector(".search input").addEventListener("input", (e) => { f.query = e.target.value; save(); update(); });
  $view.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (e.target.closest("[data-clear]")) {
      Object.assign(f, { query: "", category: "all", day: "all", openOnly: false });
      $view.querySelector(".search input").value = "";
    } else if (!chip) {
      return;
    }
    if (chip?.dataset.category) f.category = chip.dataset.category;
    if (chip?.dataset.day) f.day = chip.dataset.day;
    if (chip && "open" in chip.dataset) f.openOnly = !f.openOnly;
    for (const c of $view.querySelectorAll(".chip")) {
      c.setAttribute("aria-pressed", c.dataset.category ? f.category === c.dataset.category
        : c.dataset.day ? f.day === c.dataset.day : f.openOnly);
    }
    save();
    update();
  });
  update();
  return {};
}

function card(c) {
  const action = c.is_organizer ? `<a class="btn btn-small" href="#/club/${encodeURIComponent(c.id)}/manage">Manage</a>`
    : c.my_application ? myPill(c.my_application)
    : c.status === "Full" ? `<span class="muted">Not taking sign-ups</span>`
    : `<a class="btn btn-small btn-primary" href="#/club/${encodeURIComponent(c.id)}/join">${c.status === "Waitlist" ? "Join waitlist" : "Join"}</a>`;
  return `<li class="row club">
    <div class="row-main">
      <div class="club-top">${statusBadge(c)}<span class="tag">${esc(c.category)}</span>${sampleTag(c)}</div>
      <h2 class="row-name"><a href="#/club/${encodeURIComponent(c.id)}">${esc(c.name)}</a></h2>
      <p class="club-line">${icon("clock", 14)}<span>${esc(schedule(c))}</span></p>
      <p class="club-line">${icon("pin", 14)}<span>${esc(place(c))}</span></p>
      ${hint(c)}
    </div>
    <div class="row-side"><span class="muted">${esc(spots(c))}</span>${action}</div>
  </li>`;
}

// ---------- screen: one club ----------
export async function clubView($main, id) {
  const $view = mount($main);
  $view.innerHTML = `${back("#/clubs", "Clubs")}${loading("Loading club…")}`;
  let c;
  try {
    c = await src.clubs.get(id);
  } catch (err) {
    $view.innerHTML = `${back("#/clubs", "Clubs")}${failure(err)}`;
    return {};
  }
  const render = () => {
    const list = (items, empty) => (items.length ? `<ul class="plain">${items.join("")}</ul>` : empty);
    $view.innerHTML = `
      ${back("#/clubs", "Clubs")}
      ${head(esc(c.name), `<p class="sub">${statusBadge(c)}<span class="tag">${esc(c.category)}</span>${sampleTag(c)}</p>`)}
      <div class="club-layout">
        <section class="card club-main">
          <p class="club-desc">${esc(c.description)}</p>
          <dl class="facts club-facts">
            <dt>Activities &amp; goals</dt><dd>${c.activities ? esc(c.activities) : NOT_SET}</dd>
            <dt>Schedule</dt><dd>${esc(schedule(c))}${c.next_meeting ? `<span class="cell-note">Next regular meeting: ${esc(fmtDate(c.next_meeting))} (from the weekly schedule)</span>` : ""}</dd>
            <dt>Location</dt><dd>${esc(place(c))}</dd>
            <dt>Busy then?</dt><dd>${hint(c, { detail: true })}</dd>
            <dt>Upcoming</dt><dd>${list(c.upcoming.map((m) => `<li>${esc(fmtDate(m.date))}${m.note ? ` · ${esc(m.note)}` : ""}</li>`), `<span class="muted">No extra meetings scheduled</span>`)}</dd>
            <dt>Officers</dt><dd>${list(c.officers.map((x) => `<li>${esc(x.role)}: ${esc(x.name)}</li>`), NOT_SET)}</dd>
            <dt>Contact</dt><dd>${c.contact ? esc(c.contact) : NOT_SET}</dd>
            <dt>Requirements</dt><dd>${c.requirements ? esc(c.requirements) : NOT_SET}</dd>
            <dt>Joining</dt><dd>${c.requires_approval ? "An officer approves each application" : "Open sign-up: you're in right away if there's a spot"}</dd>
          </dl>
        </section>
        <aside class="card club-side" aria-live="polite">${joinBox(c)}</aside>
      </div>`;
  };
  $view.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-withdraw]")) return;
    if (!confirm(`Withdraw from ${c.name}? Your application will be removed${c.my_application?.status === "approved" ? " and your spot given to the next person" : ""}.`)) return;
    try {
      c = await src.clubs.withdraw(id);
      render();
      $view.querySelector(".club-side").insertAdjacentHTML("afterbegin", `<p class="success" role="status">Withdrawn. You can sign up again any time.</p>`);
    } catch (err) {
      alert(err.message);
    }
  });
  render();
  return {};
}

function joinBox(c) {
  const enc = encodeURIComponent(c.id);
  const sampleNote = c.example && c.requires_approval
    ? `<p class="help">Sample club: no officer reviews applications in this demo, so they stay pending.</p>` : "";
  if (c.is_organizer) {
    return `<p class="side-title">You run this club</p>
      <p class="muted">${esc(spots(c))}</p>
      <a class="btn btn-primary btn-block" href="#/club/${enc}/manage">Review applications</a>
      <a class="btn btn-block" href="#/club/${enc}/edit">Edit club</a>
      <p class="help">Organizer tools are demo-grade: they're tied to this browser's device token, not a login.</p>`;
  }
  const a = c.my_application;
  if (a) {
    const next = {
      approved: "You're a member. Meet the club at its next meeting.",
      pending: "An officer will review your application. Check My clubs for the decision.",
      waitlisted: `You're #${a.position} on the waitlist. If a spot opens you move up automatically, in sign-up order.`,
      rejected: "The organizer declined this application.",
    }[a.status];
    return `<p class="side-title">Your status</p>${myPill(a)}<p>${next}</p>
      ${a.status !== "rejected" ? `<button class="btn btn-block" type="button" data-withdraw>Withdraw</button>` : ""}${sampleNote}`;
  }
  if (c.status === "Full") {
    return `<p class="side-title">Full</p><p class="muted">${esc(spots(c))}. This club isn't taking waitlist sign-ups right now.</p>`;
  }
  return `<p class="side-title">${c.status === "Open" ? "Spots available" : "Full, waitlist open"}</p>
    <p class="muted">${esc(spots(c))}</p>
    <a class="btn btn-primary btn-block" href="#/club/${enc}/join">${c.status === "Open" ? (c.requires_approval ? "Apply to join" : "Join") : "Join the waitlist"}</a>
    ${sampleNote}`;
}

// ---------- screen: sign-up ----------
export async function joinView($main, id) {
  const $view = mount($main);
  const backTo = back(`#/club/${encodeURIComponent(id)}`, "Club details");
  $view.innerHTML = `${backTo}${loading("Loading…")}`;
  let c, o, mode;
  try {
    [c, o, mode] = await Promise.all([src.clubs.get(id), src.clubOptions(), src.getMode()]);
  } catch (err) {
    $view.innerHTML = `${backTo}${failure(err)}`;
    return {};
  }
  if (c.my_application || c.is_organizer || c.status === "Full") {
    $view.innerHTML = `${backTo}${head(esc(c.name))}<div class="card"><p>${c.is_organizer ? "You run this club, so you don't sign up for it."
      : c.my_application ? `You already applied: ${APP_STATUS[c.my_application.status]}. See <a href="#/my-clubs">My clubs</a>.`
      : "This club is full and isn't taking waitlist sign-ups."}</p></div>`;
    return {};
  }
  const L = o.limits;
  let waitlist = c.status === "Waitlist";
  $view.innerHTML = `${backTo}
    ${head(waitlist ? "Join the waitlist" : c.requires_approval ? "Apply to join" : "Join")}
    <form class="form panel" id="join-club" novalidate>
      <p class="banner" id="full-note" role="status"${waitlist ? "" : " hidden"}>${icon("info", 16)}<span>This club is full. Sending this adds you to its waitlist, in sign-up order.</span></p>
      <label>Club<input value="${esc(c.name)}" readonly aria-readonly="true"></label>
      <label>Full name<input name="name" required maxlength="${L.applicant_name}" autocomplete="name"></label>
      <label>School email<input name="email" type="email" required maxlength="${L.email}" autocomplete="email" inputmode="email" placeholder="name@bu.edu" aria-describedby="email-help"></label>
      <p class="help" id="email-help">Must end in @bu.edu.</p>
      <label>Year<select name="year" required><option value="">Choose…</option>${o.years.map((y) => `<option>${esc(y)}</option>`).join("")}</select></label>
      <label><span>Other contact <span class="opt">optional</span></span><input name="contact" maxlength="${L.contact}" placeholder="Phone or handle, if you prefer"></label>
      <label><span>Why do you want to join? <span class="opt">optional</span></span><textarea name="reason" rows="3" maxlength="${L.reason}"></textarea></label>
      <label><span>Availability <span class="opt">optional</span></span><input name="availability" maxlength="${L.availability}" placeholder="e.g. weekday evenings"></label>
      <p class="help">Only this club's organizer sees these details. ${mode === "static" ? "Demo mode: they're stored in this browser only." : "They're stored on the BU-sy demo server."}
        BU-sy doesn't send emails.</p>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-block">${waitlist ? "Join waitlist" : c.requires_approval ? "Send application" : "Join club"}</button>
    </form>`;
  const form = $view.querySelector("#join-club");
  const $err = form.querySelector(".form-error");
  const $btn = form.querySelector("button");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    const problem = src.applicationProblem(d, o);          // same rules as the server
    if (problem) {
      $err.textContent = problem.message;
      const field = form.elements.namedItem(problem.field);
      field?.setAttribute("aria-invalid", "true");
      field?.focus();
      return;
    }
    $btn.disabled = true;
    try {
      const updated = await src.clubs.apply(id, { ...d, join_waitlist: waitlist });
      confirmation($view, updated);
    } catch (err) {
      $btn.disabled = false;
      if (err.status === 409 && /waitlist instead/.test(err.message)) {   // filled up while you were typing
        waitlist = true;
        form.querySelector("#full-note").hidden = false;
        $btn.textContent = "Join waitlist";
        $err.textContent = "The last spot was just taken. You can join the waitlist instead.";
      } else {
        $err.textContent = err.message;
      }
    }
  });
  return {};
}

function confirmation($view, c) {
  const a = c.my_application;
  const text = {
    approved: ["You're in", `You're a member of ${esc(c.name)}. Next: come to the next meeting (${esc(schedule(c))}).`],
    pending: ["Application sent", `An officer of ${esc(c.name)} reviews it in BU-sy. Check My clubs for the decision; you won't get an email.`],
    waitlisted: [`You're #${a.position} on the waitlist`, `If a spot opens at ${esc(c.name)}, you move up automatically in sign-up order${c.requires_approval ? ", then an officer approves it" : ""}. Check My clubs.`],
  }[a.status];
  $view.innerHTML = `<div class="state" role="status">${terrier({ size: 52 })}
    <h1 class="title">${text[0]}</h1><p>${text[1]}</p>
    <p class="help">You can withdraw any time from My clubs.</p>
    <span class="title-actions"><a class="btn btn-primary" href="#/my-clubs">My clubs</a><a class="btn" href="#/clubs">Back to clubs</a></span></div>`;
  document.getElementById("view").focus();          // announce the result instead of a vanished form
}

// ---------- screen: my clubs ----------
export async function myClubsView($main) {
  const $view = mount($main);
  $view.innerHTML = `${head("My clubs")}${loading("Loading your clubs…")}`;
  const render = async (message = "") => {
    let all, mode;
    try {
      [all, mode] = await Promise.all([src.clubs.list(), src.getMode()]);
    } catch (err) {
      $view.innerHTML = `${head("My clubs")}${failure(err)}`;
      return;
    }
    const mine = all.filter((c) => c.my_application);
    const run = all.filter((c) => c.is_organizer);
    const row = (c) => `<li class="row">
      <span class="row-main"><a class="row-name" href="#/club/${encodeURIComponent(c.id)}">${esc(c.name)}</a>
        <span class="row-sub">${esc(schedule(c))} ${sampleTag(c)}</span></span>
      <span class="row-side">${myPill(c.my_application)}
      ${c.my_application.status !== "rejected" ? `<button class="link" type="button" data-withdraw="${esc(c.id)}" data-name="${esc(c.name)}">Withdraw</button>` : ""}</span></li>`;
    $view.innerHTML = `${head("My clubs", `<p class="tagline">Clubs this device applied to or runs.</p>`)}
      <p class="hint">${mode === "static" ? "<strong>Demo mode:</strong> this list lives in this browser only." : "Tied to this browser's anonymous device ID, not an account."}
        ${src.clubs.persistent ? "" : " Your browser is blocking storage, so this list lasts only until you close the tab."}</p>
      <p class="success" role="status"${message ? "" : " hidden"}>${esc(message)}</p>
      <section aria-live="polite">${mine.length ? `<ul class="list">${mine.map(row).join("")}</ul>`
        : `<div class="state">${terrier({ size: 44, sleepy: true })}<p>You haven't signed up for any clubs yet.</p><a class="btn btn-primary" href="#/clubs">Browse clubs</a></div>`}</section>
      ${run.length ? `<h2 class="section-title">Clubs you run</h2><ul class="list">${run.map((c) => `<li class="row">
        <span class="row-main"><a class="row-name" href="#/club/${encodeURIComponent(c.id)}">${esc(c.name)}</a><span class="row-sub">${esc(spots(c))}</span></span>
        <span class="row-side"><a class="btn btn-small" href="#/club/${encodeURIComponent(c.id)}/manage">Manage</a></span></li>`).join("")}</ul>` : ""}`;
  };
  $view.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-withdraw]");
    if (!btn || !confirm(`Withdraw from ${btn.dataset.name}? Your application will be removed.`)) return;
    try {
      await src.clubs.withdraw(btn.dataset.withdraw);
      await render(`Withdrawn from ${btn.dataset.name}.`);
    } catch (err) {
      alert(err.message);
    }
  });
  await render();
  return {};
}

// ---------- screen: create / edit (organizer) ----------
export async function clubFormView($main, id = null) {
  const $view = mount($main);
  const backTo = id ? back(`#/club/${encodeURIComponent(id)}`, "Club details") : back("#/clubs", "Clubs");
  $view.innerHTML = `${backTo}${loading()}`;
  let o, c = null, mode;
  try {
    [o, mode] = await Promise.all([src.clubOptions(), src.getMode()]);
    if (id) {
      c = await src.clubs.get(id);
      if (!c.is_organizer) throw new src.SourceError(403, "Only this club's organizer can edit it.");
    }
  } catch (err) {
    $view.innerHTML = `${backTo}${failure(err)}`;
    return {};
  }
  const L = o.limits;
  const v = (k) => esc(c?.[k] ?? "");
  const opt = (value, text, selected) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(text)}</option>`;
  const officerRow = (x = {}) => `<div class="form-row form-row-2 officer"><label>Role<input name="officer_role" maxlength="${L.officer_role}" value="${esc(x.role ?? "")}" placeholder="President"></label>
    <label>Name<input name="officer_name" maxlength="${L.officer_name}" value="${esc(x.name ?? "")}"></label></div>`;
  const meetingRow = (m = {}) => `<div class="form-row form-row-2 meeting"><label>Date<input name="meeting_date" type="date" value="${esc(m.date ?? "")}"></label>
    <label><span>Note <span class="opt">optional</span></span><input name="meeting_note" maxlength="${L.note}" value="${esc(m.note ?? "")}"></label></div>`;

  $view.innerHTML = `${backTo}
    ${head(id ? "Edit club" : "New club")}
    <p class="hint">${id ? "" : "You'll be this club's organizer. "}Organizer access is demo-grade: it's tied to this browser's device token, not a login,
      so anyone using this browser can manage the club. ${mode === "static" ? "<strong>Demo mode:</strong> the club is saved in this browser only." : "Everyone using this server will see it."}</p>
    <form class="form panel" id="club-form" novalidate>
      <label>Club name<input name="name" required maxlength="${L.name}" value="${v("name")}"></label>
      <label>Category<select name="category" required>${opt("", "Choose…", !c)}${o.categories.map((x) => opt(x, x, c?.category === x)).join("")}</select></label>
      <label>Description<textarea name="description" required rows="3" maxlength="${L.description}">${v("description")}</textarea></label>
      <label><span>Activities &amp; goals <span class="opt">optional</span></span><textarea name="activities" rows="2" maxlength="${L.activities}">${v("activities")}</textarea></label>
      <fieldset><legend>Regular meeting <span class="opt">optional</span></legend>
        <div class="form-row">
          <label>Day<select name="meeting_day">${opt("", "Not set", !c?.meeting_day)}${o.days.map((d) => opt(d, d, c?.meeting_day === d)).join("")}</select></label>
          <label>Start<input name="meeting_start" type="time" value="${v("meeting_start")}"></label>
          <label>End<input name="meeting_end" type="time" value="${v("meeting_end")}"></label>
        </div></fieldset>
      <label>Campus place<select name="location_id" aria-describedby="place-help">${opt("", "Somewhere else, or not set", !c?.location_id)}${o.locations.map((l) => opt(l.id, l.name, c?.location_id === l.id)).join("")}</select></label>
      <p class="help" id="place-help">Picking a campus place adds a busyness estimate for your meeting time, from the simulated data.</p>
      <label><span>Location details <span class="opt">optional</span></span><input name="location_text" maxlength="${L.location_text}" value="${v("location_text")}" placeholder="Room, floor or meeting spot"></label>
      <label><span>Member limit <span class="opt">optional</span></span><input name="capacity" type="number" min="1" max="${L.capacity}" inputmode="numeric" value="${v("capacity")}" placeholder="No limit"></label>
      <label class="check"><input type="checkbox" name="requires_approval"${c?.requires_approval ? " checked" : ""}><span>An officer approves each application</span></label>
      <label class="check"><input type="checkbox" name="waitlist"${c ? (c.waitlist ? " checked" : "") : " checked"}><span>Offer a waitlist when full</span></label>
      <fieldset id="officers"><legend>Officers <span class="opt">optional, up to ${L.officers}</span></legend>
        ${(c?.officers?.length ? c.officers : [{}]).map(officerRow).join("")}
        <button class="btn btn-quiet" type="button" data-add="officer">${icon("plus", 14)} Add officer</button></fieldset>
      <label><span>Contact <span class="opt">optional</span></span><input name="contact" maxlength="${L.contact}" value="${v("contact")}" placeholder="Club email or page"></label>
      <label><span>Membership requirements <span class="opt">optional</span></span><textarea name="requirements" rows="2" maxlength="${L.requirements}">${v("requirements")}</textarea></label>
      <fieldset id="meetings"><legend>Extra upcoming meetings <span class="opt">optional, up to ${L.upcoming}</span></legend>
        ${(c?.upcoming ?? []).map(meetingRow).join("")}
        <button class="btn btn-quiet" type="button" data-add="meeting">${icon("plus", 14)} Add meeting</button></fieldset>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-block" type="submit">${id ? "Save changes" : "Create club"}</button>
    </form>`;

  const form = $view.querySelector("#club-form");
  const $err = form.querySelector(".form-error");
  form.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (!add) return;
    const rows = form.querySelectorAll(`.${add.dataset.add}`).length;
    const max = add.dataset.add === "officer" ? L.officers : L.upcoming;
    if (rows >= max) { $err.textContent = `At most ${max}.`; return; }
    add.insertAdjacentHTML("beforebegin", add.dataset.add === "officer" ? officerRow() : meetingRow());
    add.previousElementSibling.querySelector("input").focus();
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const d = new FormData(form);
    const get = (k) => String(d.get(k) ?? "").trim();
    const pairs = (a, b) => d.getAll(a).map((x, i) => [String(x).trim(), String(d.getAll(b)[i] ?? "").trim()]);
    const data = {
      name: get("name"), category: get("category"), description: get("description"), activities: get("activities"),
      meeting_day: get("meeting_day") || null, meeting_start: get("meeting_start") || null, meeting_end: get("meeting_end") || null,
      location_id: get("location_id") || null, location_text: get("location_text"),
      capacity: get("capacity") ? Number(get("capacity")) : null,
      requires_approval: d.has("requires_approval"), waitlist: d.has("waitlist"),
      officers: pairs("officer_role", "officer_name").filter(([r, n]) => r || n).map(([role, name]) => ({ role, name })),
      contact: get("contact"), requirements: get("requirements"),
      upcoming: pairs("meeting_date", "meeting_note").filter(([dt, n]) => dt || n).map(([date, note]) => ({ date, note })),
    };
    for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    const problem = src.clubProblem(data, o);                 // same rules as the server
    if (problem) {
      $err.textContent = problem.message;
      const group = { officers: "#officers input", upcoming: "#meetings input" }[problem.field];
      const field = group ? form.querySelector(group) : form.elements.namedItem(problem.field);
      field?.setAttribute("aria-invalid", "true");
      field?.focus();
      return;
    }
    try {
      const saved = id ? await src.clubs.edit(id, data) : await src.clubs.create(data);
      location.hash = `#/club/${encodeURIComponent(saved.id)}`;
    } catch (err) {
      $err.textContent = err.message;
    }
  });
  return {};
}

// ---------- screen: review applications (organizer) ----------
export async function manageView($main, id) {
  const $view = mount($main);
  const backTo = back(`#/club/${encodeURIComponent(id)}`, "Club details");
  $view.innerHTML = `${backTo}${loading("Loading applications…")}`;
  const render = async (message = "") => {
    let c, apps;
    try {
      c = await src.clubs.get(id);
      apps = await src.clubs.applications(id);
    } catch (err) {
      $view.innerHTML = `${backTo}${failure(err.status === 403 ? new Error("Only this club's organizer can see its applications.") : err)}`;
      return;
    }
    const field = (label, value) => `<dt>${label}</dt><dd>${value ? esc(value).replace(/\n/g, "<br>") : `<span class="muted">Not given</span>`}</dd>`;
    const appCard = (a, actions) => `<li class="row">
      <div class="row-main"><strong class="row-name">${a.example ? "Sample member (no details)" : esc(a.name)}</strong>
      ${a.example ? "" : `<dl class="facts">${field("Email", a.email)}${field("Year", a.year)}${field("Other contact", a.contact)}
        ${field("Why join", a.reason)}${field("Availability", a.availability)}</dl>`}</div>
      <div class="row-side">${myPill(a)}${actions && !a.example ? `<div class="app-actions">${actions}</div>` : ""}</div></li>`;
    const btn = (a, decision, text, primary = false) => `<button class="btn btn-small${primary ? " btn-primary" : ""}" type="button" data-decide="${decision}" data-app="${esc(a.id)}" data-name="${esc(a.name)}">${text}</button>`;
    const group = (title, items, actions, empty) => `<section class="app-group"><h2 class="section-title">${title} <span class="muted">${items.length}</span></h2>
      ${items.length ? `<ul class="list">${items.map((a) => appCard(a, actions(a))).join("")}</ul>` : `<p class="muted">${empty}</p>`}</section>`;
    const by = (s) => apps.filter((a) => a.status === s);
    const free = c.capacity == null || c.spots_left > 0;
    $view.innerHTML = `${backTo}
      ${head(`Applications · ${esc(c.name)}`, `<p class="sub">${statusBadge(c)}<span>${esc(spots(c))}</span></p>`)}
      <p class="banner" role="note">${icon("lock", 16)}<span>Demo-grade access: this page opens for this browser's device token, not a login. Students only ever see their own status.</span></p>
      <p class="success" role="status"${message ? "" : " hidden"}>${esc(message)}</p>
      <div aria-live="polite">
        ${group("Pending", by("pending"), (a) => btn(a, "approve", "Approve", true) + btn(a, "reject", "Decline"), "No applications waiting.")}
        ${group("Waitlist", by("waitlisted"), (a) => (free ? btn(a, "approve", "Approve", true) : "") + btn(a, "reject", "Decline"),
          c.waitlist ? "Nobody on the waitlist." : "This club doesn't offer a waitlist.")}
        ${group("Members", by("approved"), (a) => btn(a, "reject", "Remove"), "No members yet.")}
        ${group("Declined", by("rejected"), () => "", "None declined.")}
      </div>
      <a class="btn" href="#/club/${encodeURIComponent(id)}/edit">Edit club</a>`;
  };
  $view.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-decide]");
    if (!b) return;
    const { decide, app, name } = b.dataset;
    const removing = b.textContent === "Remove";
    if (decide === "reject" && !confirm(`${removing ? "Remove" : "Decline"} ${name}? ${removing ? "Their spot goes to the next person on the waitlist." : ""}`)) return;
    b.disabled = true;
    try {
      await src.clubs.decide(id, app, decide);
      await render(`${name}: ${decide === "approve" ? "approved" : removing ? "removed" : "declined"}.`);
    } catch (err) {
      b.disabled = false;
      alert(err.message);
    }
  });
  await render();
  return {};
}
