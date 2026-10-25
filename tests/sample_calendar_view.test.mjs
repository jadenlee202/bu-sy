import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.location = { search: "", href: "http://example.test/#/calendar" };
globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error("Preview must not save personal preferences"); } };
const requests = [];
globalThis.fetch = async url => {
  requests.push(String(url));
  const payload = String(url) === "data/facilities.json"
    ? [{facility_id:"demo-library",facility_name:"Example library",category:"library",data_mode:"synthetic"}]
    : String(url) === "data/hours.json"
      ? {locations:{"demo-library":{buildingHours:{status:"verified",effectiveFrom:"2026-10-25",effectiveThrough:"2026-10-31",
        weeklyHours:Object.fromEntries(["sunday","monday","tuesday","wednesday","thursday","friday","saturday"].map(day=>[day,[{start:"08:00",end:"22:00"}]]))}}}}
      : null;
  return {ok:payload!==null,status:payload?200:404,headers:{get:()=>"application/json"},json:async()=>payload};
};

// Minimal DOM port for exercising the real view's handlers without a browser dependency.
class Element {
  value=""; checked=false; readOnly=false; listeners=new Map(); content="";
  set innerHTML(value) {
    this.content=value;
    const selected=value.match(/<option value="([^"]+)" selected/);
    const first=value.match(/<option value="([^"]+)"/);
    if(selected||first)this.value=(selected??first)[1];
  }
  get innerHTML(){return this.content;}
  addEventListener(name,fn,options){this.listeners.set(name,fn);options?.signal?.addEventListener("abort",()=>this.listeners.delete(name));}
  async fire(name,target=this){await this.listeners.get(name)?.({target});}
}
class View extends Element {
  nodes=new Map();
  set innerHTML(value) {
    this.content=value;
    for(const match of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){
      const node=new Element();node.value=match[0].match(/value="([^"]*)"/)?.[1]??"";
      node.checked=match[0].includes(" checked");node.readOnly=match[0].includes(" readonly");
      if(match[0].startsWith("<select"))node.innerHTML=value.slice(match.index+match[0].length).split("</select>")[0];
      this.nodes.set('#'+match[1],node);
    }
  }
  get innerHTML(){return this.content;}
  querySelector(selector){const node=this.nodes.get(selector);assert.ok(node,selector);return node;}
}

const {calendarView}=await import("../web/js/calendar.js");
test("static Calendar defaults to the supplied sample and updates the day without Google",async()=>{
  const view=new View();const mounted=await calendarView(view);
  assert.match(view.querySelector("#sample-week").innerHTML,/Symphony \+ Lunch\?/);
  assert.match(view.querySelector("#sample-week").innerHTML,/end estimated/);
  assert.match(view.querySelector("#calendar-connection").innerHTML,/Sample preview/);
  assert.match(view.querySelector("#calendar-results").innerHTML,/8 hr 55 min/);
  assert.match(view.querySelector("#calendar-results").innerHTML,/Monday, October 26/);
  assert.equal(view.querySelector("#calendar-timezone").readOnly,true);
  const selectDay=date=>({closest:selector=>selector==="[data-sample-date]"?{dataset:{sampleDate:date}}:null});
  await view.fire("click",selectDay("2026-10-28"));
  assert.match(view.querySelector("#calendar-results").innerHTML,/Wednesday, October 28/);
  assert.match(view.querySelector("#calendar-results").innerHTML,/4 hr 50 min/);
  const date=view.querySelector("#calendar-date");date.value="2026-11-01";await date.fire("change");
  assert.match(view.querySelector("#calendar-results").innerHTML,/Outside the sample week/);
  assert.ok(requests.every(url=>!url.includes("calendar/")),"Sample must not call Google-calendar endpoints");
  mounted.dispose();assert.equal(view.listeners.has("click"),false);
});
