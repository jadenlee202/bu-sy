// BU-sy release notes: the one place the app's version is defined. Newest first; the first entry
// is the current version, shown at the bottom of every screen and in Version history.
//
// Semantic versioning: major = a change that breaks how people used the app (a new interface,
// removed pages), minor = new features or substantial improvements, patch = fixes and small refinements.
// To release, add an entry at the top, dated the day it reaches main (README: "Releasing a version").
// Releases before 1.1.0 were reconstructed from main's history; `commits` names the range each covers.
export const RELEASES = [
  {
    version: "1.1.0",
    date: "2026-10-25",
    title: "Version history",
    summary: "See which version you're using and what changed in each release.",
    changes: {
      Features: [
        "The current version is shown at the bottom of every screen.",
        "Version history lists every release, newest first, with its changes.",
      ],
    },
  },
  {
    version: "1.0.0",
    date: "2026-10-25",
    title: "One-sentence planner",
    summary: "A new, simpler BU-sy: say how long you have and what you want to do, and it finds a spot.",
    commits: "999c923–8201065",
    changes: {
      Features: [
        "Plan, Schedule and Explore tabs replace the previous interface.",
        "Plan with one sentence, such as “I have 1 hr to study.”",
        "Walking time is estimated from your location, which is never stored or sent.",
        "A busyness meter: three bars beside a word, so the level never depends on colour alone.",
        "Place pages with the day’s busyness, this week’s building hours, today’s meals and sources.",
        "Club pages with upcoming meetings, Add to calendar, and join or withdraw.",
        "An About the data page listing every dataset and its licence.",
        "An on-device people counter that never saves or uploads video.",
      ],
      Improvements: [
        "Custom free time can be entered in minutes or decimal hours.",
      ],
      Fixes: [
        "A slow first load could draw an older screen over a newer one.",
        "The offline cache could serve a stale deploy or take over other pages.",
      ],
      "UI Updates": [
        "Brownstone colours, the pin-clock logo and a new loading screen.",
      ],
    },
  },
  {
    version: "0.2.0",
    date: "2026-10-25",
    title: "Verified hours, calendar and clubs",
    summary: "Verified BU hours and meals, calendar upload, a month view and the club directory.",
    commits: "9c5a291–2fec56a",
    changes: {
      Features: [
        "Verified BU building hours and dining meal schedules.",
        "Upload a calendar (.ics) so plans fit around your classes.",
        "Clubs replace Meetups, with filters for category, day and availability.",
        "A month calendar; weeks start on Sunday, with Monday as an option.",
        "Saved club meetings appear in your calendar and count as busy.",
        "Install BU-sy as an app that opens offline.",
      ],
      Fixes: [
        "Dining halls show the correct meal being served.",
        "Mugar Library uses its general hours.",
        "A building whose hours are only assumed is never shown as open.",
        "Planner and preferences panels no longer overlap on phones.",
      ],
      "UI Updates": [
        "A BU-inspired theme with campus imagery and a Boston skyline.",
        "A phone-sized layout on every screen, with a bottom tab bar.",
        "Raised cards and more noticeable motion.",
      ],
    },
  },
  {
    version: "0.1.0",
    date: "2026-10-24",
    title: "First prototype",
    summary: "The first BU-sy: find what fits in your free time, with simulated campus busyness.",
    commits: "811a22b–d6e43d6",
    changes: {
      Features: [
        "The “What fits now?” planner.",
        "Simulated busyness built from real reference datasets, with a full-day replay.",
        "A Sources & Simulation page that says where every number comes from.",
        "Unofficial student meetups.",
      ],
    },
  },
];

export const CURRENT = RELEASES[0];
