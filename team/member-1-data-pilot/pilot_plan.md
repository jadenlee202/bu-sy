# Controlled doorway counting pilot

Goal: learn whether we can measure **occupancy** (people in a room) by counting entries and exits at doorways, and how fast the count drifts. Start small: **one room we control, with only participating teammates**, before any public space.

> No hardware is purchased or installed under this plan. Any sensor or camera trial needs (a) team agreement, (b) permission from whoever controls the room, and (c) for cameras, explicit consent from everyone in view.

## 1. Setup

| Item | Spec |
|------|------|
| Room | One bookable room (study room or club room) with a door count we know |
| Participants | Teammates only, about 4–6 people; everyone has agreed |
| facility_id | `PILOT_<ROOM>` (for example `PILOT_MUGAR_STUDY_3`). The `PILOT_` prefix keeps it apart from `SYN_` (synthetic) and `COD_` data |
| Doorways | **Every usable doorway** gets a `sensor_id`, for example `PILOT_<ROOM>_D1`, `_D2`. That includes fire or side doors that get used. A sealed or alarmed door is recorded as excluded in the session notes |
| Direction | Define **IN = crossing into the room**, per door, and write it on a floor diagram |
| Clocks | All observers sync their phones to network time. Record timestamps in **ISO 8601 with an offset**, for example `2026-10-28T14:05:12-04:00` (America/New_York; mind the DST change on 2026-11-01) |
| Session length | 30–60 minutes per session, 3+ sessions |

## 2. Protocol

1. **Known starting occupancy.** Before t0, an observer headcounts the room and logs it in `headcount_template.csv`. Ideally the room is empty (0).
2. **Event counting.** One counter per doorway logs every crossing in `event_template.csv` as `direction` = `in` or `out` and `count` = people.
3. **Manual ground truth.** A separate observer, not a door counter, does a **full headcount every 5 minutes** and at the end. These rows are the truth we compare against.
4. **Scripted scenarios.** Teammates act these out at known times. The script holder notes each scenario in `observer_note`:

| Scenario | How to log it |
|----------|---------------|
| Single crossing | 1 row, count=1 |
| Group (2–4 together) | 1 row with count=N, **or** N rows. Pick one rule and keep it. The recommendation is 1 row with count=N |
| Turnaround (steps in, leaves without fully entering) | Log **nothing** if the threshold line wasn't fully crossed. If it was crossed, log `in` then `out` |
| Simultaneous in + out | 2 rows, same timestamp, opposite directions |
| Lingering in the doorway | Nothing until a full crossing happens |
| Use of a second door | Logged by that door's counter |

5. **End.** Final headcount, then compare it with the running count.

## 3. Computing occupancy and drift

```
occupancy(t) = start_headcount + Σ count[in, ≤t] − Σ count[out, ≤t]
drift(t)     = occupancy(t) − headcount(t)   # at each ground-truth check
```

**Correcting drift:**
- **Reset at every ground-truth headcount.** Set the running occupancy to the observed count and log the size of the correction. A large correction is a finding to record, not something to hide.
- **Clamp at zero.** Negative occupancy means missed `in` events. Clamp to 0 and flag it.
- **Daily anchor.** In a real facility, reset to 0 (or to the closing headcount) at closing time.
- Report drift **per door** where possible, so a bad doorway can be identified.

## 4. Failed sensor vs. quiet doorway

A door with zero events could be broken or just unused. Tell them apart with:

- **Heartbeat.** The device or counter logs a status row every N minutes (`direction=heartbeat`, `count=0`). A missing heartbeat means a failure. Zero events with heartbeats present means the door is quiet.
- **Scripted test crossing.** A known teammate crosses each door at the start and end of each session. If it's missing, the door's data is suspect.
- **Imbalance check.** Over a closed session, Σin − Σout per door should match the net change seen at the other doors. A door that shows only `in` or only `out` usually means a direction or placement error.
- **Comparison with past sessions.** A door that's usually busy reading zero during busy hours is suspect. A side door reading zero is plausible.

## 5. Method comparison

No accuracy figures are claimed. Each method has to earn its numbers from the ground-truth comparison in this pilot.

| | Manual tally | Directional sensor (for example dual IR beam or ToF) | Local camera line-crossing |
|---|---|---|---|
| Cost | Labour only | Hardware per door | Camera + compute (for example a laptop or SBC) |
| Setup | Minutes | Mounting, power, direction calibration | Mounting, line placement, model setup |
| Groups / side-by-side | Human judgement; good if attentive | Known weak spot: people crossing side by side can merge into one | Can separate people if the view is clear; struggles with occlusion |
| Turnarounds | Human judgement | Depends on beam order logic | Depends on track logic |
| Scales to long periods | No (fatigue) | Yes | Yes |
| Privacy | Low risk (counts only) | Low risk (no images) | **Highest risk.** Process on the device, store counts only, never frames; needs consent and signage; likely needs institutional approval in shared spaces |
| Failure mode | Missed or double counts, fatigue | Misalignment, blocked beam, power loss | Lighting, camera angle, occlusion, model errors |
| Pilot role | **Ground truth + baseline** | Candidate, later, if approved | Candidate, later, teammates-only room, if approved |

Recommended order: manual-only sessions first (to test the protocol and the templates), then optionally one sensor type, compared against manual ground truth in the same sessions.

## 6. What to report after the pilot

- Per session: start headcount, final headcount, final running count, total correction, and the largest drift with when it happened.
- A breakdown by scenario: which scenarios caused the errors.
- Per door: event totals, heartbeat gaps, results of test crossings.

## 7. SYNTHETIC example (illustrative only; not measured)

```
# SYNTHETIC — invented to show the format; not real data
event_id,facility_id,sensor_id,timestamp,direction,count
SYN-E1,SYN_PILOT_ROOM,SYN_PILOT_ROOM_D1,2026-10-28T14:00:30-04:00,in,1
SYN-E2,SYN_PILOT_ROOM,SYN_PILOT_ROOM_D1,2026-10-28T14:02:10-04:00,in,3
SYN-E3,SYN_PILOT_ROOM,SYN_PILOT_ROOM_D1,2026-10-28T14:04:00-04:00,out,1

facility_id,timestamp,observed_count,observer_note
SYN_PILOT_ROOM,2026-10-28T14:00:00-04:00,0,SYNTHETIC start headcount
SYN_PILOT_ROOM,2026-10-28T14:05:00-04:00,3,SYNTHETIC check; running count 3 -> drift 0
```
