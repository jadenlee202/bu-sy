import assert from "node:assert/strict";
import { test } from "node:test";
import { recommend, rankReason, budgetSentence } from "../web/js/recommend.js";
import { createPlanSession } from "../web/js/plan-session.js";

globalThis.location ??= { search: "" };
const { selectedPlanHTML, directionsURL, metadataHTML } = await import("../web/js/plan.js");

// Synthetic campus only; no live clock, files, downloads or network calls.
const place = (id, more = {}) => ({
  place_id: id, facility_id: id, name: id, location_id: "b", data_mode: "synthetic",
  activities: ["study", "eat", "workout"], amenities: {}, hours: [["06:00", "22:00"]],
  hours_basis: "illustrative", metadata: { access: { group: "fitness", text: "Membership required" } }, ...more,
});
const campus = {
  activities: [
    { id: "workout", label: "Work out", verb: "work out", noun: "workout", default_min: 35 },
    { id: "study", label: "Study", verb: "study", noun: "study session", default_min: 30 },
    { id: "eat", label: "Eat", verb: "eat", noun: "meal", default_min: 20 },
  ], amenity_labels: {}, locations: ["a", "b", "c"].map(id => ({id, name:id})),
  travel: [{from_id:"a",to_id:"b",minutes:10}, {from_id:"b",to_id:"c",minutes:15}],
  places: [place("gym")], travel_note: "Illustrative walks, not routed.",
};
const request = (patch = {}) => ({activity:"workout", start:"15:00", minutes:80,
  from:"a",to:"c",minActivity:35,buffer:10,needs:[],preferQuiet:false,preferShortTravel:false,
  access:{fitness:"yes"}, ...patch});
const result = (patch={}, places=campus.places) => recommend(request(patch), {...campus,places}, {});

test("exact fit with default changing/cleanup: all six components counted once", () => {
  const q=request(), o=result().options[0];
  assert.equal(o.activity,35);
  assert.deepEqual(o.budget.map(x=>[x.kind,x.minutes]), [
    ["there",10],["preparation",5],["activity",35],["cleanup",5],["onward",15],["buffer",10],
  ]);
  assert.equal(o.budget.reduce((n,b)=>n+b.minutes,0),80);
  assert.match(budgetSentence(o,q,campus), /35-minute workout/);
  assert.deepEqual([o.depart,o.arrive,o.activityStart,o.activityEnd,o.leaveBy,o.arriveNext,o.bufferStart,o.bufferEnd],
    [900,910,915,950,955,970,970,980]);
});

test("old 70 minute window fails after changing allowance; suggestions don't mutate inputs", () => {
  const q=request({minutes:70});
  const r=recommend(q,campus,{});
  assert.equal(r.options.length,0);
  assert.equal(r.excluded[0].short,10);
  assert.deepEqual(r.suggestions[0].patch,{minutes:80});
  assert.equal(q.minutes,70); assert.equal(q.minActivity,35);
  for (const s of r.suggestions) assert.ok(recommend({...q,...s.patch},campus,{}).options.length);
});

test("missing onward destination and unknown start retain honest travel semantics", () => {
  const o=result({to:null}).options[0];
  assert.equal(o.onward,0); assert.equal(o.arriveNext,null); assert.equal(o.activity,50);
  assert.equal(o.budget.reduce((n,b)=>n+b.minutes,0),80);
  const r=result({from:""});
  assert.equal(r.options.length,0); assert.equal(r.browse[0].activity,45);
  assert.equal(r.browse[0].depart,undefined);
  assert.equal(selectedPlanHTML(r.browse[0],request(),campus),"");
});

test("the entire visit including preparation and cleanup must fit before closing", () => {
  const p=place("gym",{hours:[["06:00","15:54"]]});
  assert.equal(result({},[p]).excluded[0].code,"closed");
  const o=result({},[place("gym",{hours:[["06:00","15:55"]]})]).options[0];
  assert.equal(o.activity,35); assert.equal(o.leaveBy,955);
  const late=result({start:"05:50",minutes:100}).options[0];
  assert.ok(late.activityStart>=360+5);
});

test("access unknown needs checking, denied is excluded, confirmed enables choice", () => {
  assert.equal(result({access:{}}).checkAccess.length,1);
  assert.equal(result({access:{}}).options.length,0);
  assert.equal(result({access:{fitness:"no"}}).excluded[0].code,"access");
  assert.equal(result().options.length,1);
  assert.equal(result({},[place("gym",{hours:null})]).checkHours.length,1);
});

test("choosing keeps engine result identity; edits immediately invalidate; next stop recalculates", () => {
  const session=createPlanSession(campus,{});
  const r=session.update(request());
  const chosen=session.choose("gym");
  assert.equal(chosen.option,r.options[0]); assert.equal(chosen.request,r.request);
  session.invalidate();
  assert.equal(session.selected,null); assert.equal(session.choose("gym"),null);
  session.update(request({to:null}));
  assert.equal(session.selected,null);
  const newPlan=session.choose("gym");
  assert.equal(newPlan.option.arriveNext,null); assert.equal(newPlan.option.activity,50);
  session.update(request({minutes:NaN}));
  assert.equal(session.choose("gym"),null);
  session.update(request({access:{}}));
  assert.equal(session.choose("gym"),null);
});

test("selected plan renders engine intervals and exposes both return and edit actions", () => {
  const q=request(),o=result().options[0];
  const html=selectedPlanHTML(o,q,campus);
  assert.match(html,/3:15 PM–3:50 PM/);
  for (const text of ["Preparation", "Cleanup", "Latest departure", "Protected buffer", "Commitment boundary", "data-change-plan", "data-edit-inputs", "simulated", "illustrative demo hours"]) assert.ok(html.includes(text),text);
  assert.ok(!html.includes("Open directions"));
});

test("directions require field-level verified address; metadata provenance is escaped", () => {
  assert.equal(directionsURL(place("gym")),null);
  const p=place("gym",{metadata:{address:{text:"123 Example & Main",status:"verified",checked:"2026-10-25",url:"https://www.bu.edu/"}}});
  const url=new URL(directionsURL(p));
  assert.equal(url.searchParams.get("destination"),"123 Example & Main");
  assert.equal(url.searchParams.get("travelmode"),"walking");
  assert.equal(url.searchParams.has("origin"),false);
  assert.match(metadataHTML(p),/Example &amp; Main/);
  assert.match(metadataHTML(p),/checked 2026-10-25/);
  p.metadata.address.status="unknown";
  assert.equal(directionsURL(p),null);
});

test("comparison explanations equal the evaluated differences; missing occupancy permits plans", () => {
  const r=result({to:null},[place("near",{location_id:"a"}),place("far")]);
  const [top,next]=r.options;
  assert.equal(top.activity-next.activity,10);
  assert.equal(rankReason(next,top),"10 fewer minutes of activity than the top option");
  assert.equal(top.busy.level,"unknown"); assert.equal(r.featured,null);
  const walking=result({to:null,preferShortTravel:true},[place("near",{location_id:"a"}),place("far")]);
  assert.equal(rankReason(walking.options[1],walking.options[0]),"10 more minutes walking than the top option");
});

test("serialized adapter payload retains identical plans and excludes historical references", () => {
  const c={...campus,places:[...campus.places,place("COD",{data_mode:"historical_playback"})]};
  assert.deepEqual(recommend(request(),JSON.parse(JSON.stringify(c)),{}),recommend(request(),c,{}));
  assert.ok(recommend(request(),c,{}).options.every(o=>o.place.place_id!=="COD"));
});
