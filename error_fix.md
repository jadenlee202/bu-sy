BU-sy — Complete Website Improvement and Feature Implementation Master Prompt

Website: https://jadenlee202.github.io/bu-sy/#/places

You are working on the existing BU-sy website, a Boston University campus application that helps students discover campus locations, view operating hours, explore clubs, manage their schedules, and find available time.

Your task is to inspect the existing repository and implement the improvements and features specified below directly in the codebase.

The most important requirement is to preserve all existing information, datasets, routes, and functionality unless a change is explicitly requested below. Do not redesign unrelated parts of the application, replace existing datasets with mock data, or make unnecessary architectural changes.

Before coding, inspect the project structure, package configuration, current UI, data sources, calendar implementation, location schedules, club data, and existing tests. Reuse the current components, datasets, styles, and business logic wherever possible.

1. Global UI Consistency and List-Based Layout
1.1 Use the Places tab as the design reference

The existing Places tab is the visual reference for the rest of the application.

Inspect its:

List-based layout.
Typography and text hierarchy.
Colors and backgrounds.
Spacing, padding, and alignment.
Borders and separators.
Icons and status indicators.
Hover and focus effects.
Buttons, filters, and navigation.
Responsive behavior.

Apply these conventions consistently throughout the website wherever appropriate.

1.2 Use list layouts consistently

Convert inconsistent card, grid, or tile layouts to a list-based presentation where appropriate, using the Places tab as the reference.

Display items in clearly separated rows.
Keep labels, descriptions, metadata, and actions aligned.
Preserve all information currently displayed in cards or other components.
Do not delete or abbreviate content simply to make a row fit.
Retain layouts such as the monthly calendar grid where they are functionally necessary.
Keep the interface compact, readable, and responsive.

Do not force every component into a list if doing so would harm its functionality. Instead, use the same visual design language across different component types.

1.3 Standardize hover effects and interaction graphics

Make hover effects consistent across all tabs by reusing the existing Places tab styling.

Apply consistent behavior to:

Navigation tabs and menu items.
Location list items.
Club listings and filters.
Calendar events and controls.
Buttons and links.
Search inputs and dropdowns.
Interactive icons, modals, and popovers.

Match background highlights, border changes, text and icon colors, shadows, transition duration, and easing.

Additional requirements:

Distinguish active, hovered, focused, and disabled states.
Provide accessible keyboard focus indicators.
Do not make static elements appear clickable.
Avoid excessive animations and layout shifts.
Respect reduced-motion preferences.
Preserve touch-device functionality.

Reuse shared CSS variables, classes, and components instead of introducing several competing hover styles.

2. Fix Text Overlap and Responsive Layout Problems

Inspect all tabs, pages, lists, filters, buttons, modals, tooltips, and calendar views for text overlap or overflow.

Fix:

Text overlapping other text, icons, or controls.
Long location and club names overflowing containers.
Buttons or labels being clipped.
Crowded or misaligned filters.
Calendar events becoming unreadable.
Tooltips extending outside the viewport.
Horizontal overflow on mobile.
Inconsistent padding, line height, and spacing.

Requirements:

Use responsive layouts for desktop, tablet, and mobile.
Allow text to wrap naturally.
Preserve all information rather than hiding or deleting it.
Use appropriate flexible layouts and overflow handling.
Prevent content changes from unexpectedly shifting or covering nearby controls.
Ensure long event titles and location names remain readable.

Do not make unrelated visual redesigns.

3. Standardize the Clubs Tab Filters

Improve the spacing and alignment of filters on the Clubs tab.

Arrange filters in a clean, balanced row or responsive grid.
Use consistent gaps between controls.
Align filter labels, dropdowns, search fields, and buttons.
Keep control heights and padding consistent.
Allow filters to wrap naturally on smaller screens.
Prevent overlapping, clipping, and horizontal overflow.
Follow the existing BU-sy visual style.

Preserve all existing club records, filter options, search functionality, sorting, and filtering logic.

Do not change which clubs appear or how filtering works. This is a layout and styling improvement only.

4. Location Information and Operating Hours
4.1 Preserve existing location datasets

Use the existing location datasets as the source of truth for:

Location names and IDs.
Categories.
Addresses and coordinates.
Descriptions and metadata.
Building operating hours.
Weekly schedules.
Date-specific schedules.
Dining hall meal-service periods.

Do not duplicate location records or create independent hardcoded schedules for individual tabs.

Keep all location information available and accessible.

4.2 Make building status accurate

Create or reuse a shared operating-status calculation so every tab determines building status consistently.

Use each location's applicable verified operating schedule.

Before opening time: Closed now.
During operating hours: Open now.
At or after closing time: Closed now.
When the schedule indicates no opening that day: Closed today, where supported.
When hours cannot be verified: Hours unverified.

Use the correct local timezone, including America/New_York for Boston locations.

Respect:

Day of the week.
Date-specific hours.
Holiday schedules.
Temporary closures.
Special operating hours.
Overnight schedules.
Closing times that fall after midnight.

If a location closes at 2:00 AM, account for the fact that it remains open after midnight until its scheduled closing time.

Critical rule: A location must not be marked open outside its applicable building operating hours just because other data exists.

Calendar events, club events, meal-service records, user free time, and availability recommendations must never override building status.

Do not assume a location is open when its hours are missing or unverified.

4.3 Keep status consistent across tabs

Use the same shared location records and status-calculation logic in:

Places.
Open Now.
Location detail pages.
Search results.
Planning recommendations.
Calendar-based location recommendations.

A location must not be shown as Open now in one tab and Closed now in another at the same moment if both statuses refer to building operating hours.

Calendar-selected time must remain separate from actual current-time status.

5. Open Now Tab

Ensure the Open Now tab displays locations that are genuinely open at the current time.

Requirements:

Use the current Boston local time when evaluating Boston locations.
Use the applicable verified building schedule.
Exclude locations that are currently closed.
Include locations that are open even when no meal is being served.
Display the correct current status and today's hours.
Update statuses as time passes without requiring a page reload.
Respect special hours and overnight schedules.
Show a clear empty state when no locations are open.
Distinguish between locations that are closed now but open later and those closed for the entire day.

Do not confidently label locations with missing or unverified hours as open.

Use the shared status-calculation function from the location system rather than creating separate Open Now logic.

6. Dining Hall Meal-Service Status

For dining hall locations only, display the meal currently being served using verified Boston University Dining data.

Official source: https://www.bu.edu/dining/

Use the existing location datasets and verify meal-service hours against the official BU Dining website and relevant location-specific pages.

6.1 Display the correct meal

Display the applicable meal label before its time range or as part of the current status.

Supported labels include:

Serving breakfast
Serving brunch
Serving lunch
Serving dinner

Only display a meal as currently being served when the current Boston local time falls within its verified service period.

If the building is open but no meal is being served, display:

No meal service currently scheduled

If the building is closed, preserve the building's closed status.

Do not assume every dining hall serves the same meals or operates on identical schedules.

Support other explicitly named services only when confirmed by official BU data. Do not incorrectly relabel brunch as breakfast or lunch.

6.2 Separate building hours from meal-service hours

Building status and meal-service status are separate concepts.

Examples:

Building closed, dinner schedule exists → Closed now.
Building open, lunch currently served → Open now · Serving lunch.
Building open between meals → Open now · No meal service currently scheduled.

Never mark a building closed merely because no meal is being served.

Never mark a building open merely because a meal-service record exists.

Apply meal-service logic only to dining halls, not cafes, retail stores, convenience stores, or other non-dining locations.

Do not change the existing weekly schedule layout except where necessary to correct meal-service information.

7. Remove the Serving Food Filter from Places

Remove the Serving Food tab, filter, or selectable option from the Places tab.

Remove the corresponding UI control.
Remove the filter-specific state and logic only if they become unused.
Preserve all other filters, search, sorting, and navigation.
Preserve dining hall meal-service data and status labels.
Do not remove dining hall locations.
Ensure the filter row remains properly aligned after removal.
Do not modify unrelated pages or functionality.

This is a targeted removal of the filter, not a removal of dining hall information.

8. Mugar Memorial Library Operating Hours

Update the existing Mugar Memorial Library record with verified operating hours from the official BU Libraries hours page:

https://www.bu.edu/library/visit-study/hours/

Use the schedule specifically for Mugar Library — General Hours, not separate Library Services Desk hours.

Requirements:

Find the existing Mugar location record.
Preserve its location ID, name, category, address, coordinates, description, and other metadata.
Do not create a duplicate record.
Store hours in the same format used by the existing location dataset.
Support different hours for different days.
Respect published date-specific schedules, holidays, and special hours.
Handle overnight closing times correctly.
Use the existing shared operating-status calculation.

Use only verifiable published information. Do not invent missing recurring hours or assume the library has identical hours every week if the official source does not support that assumption.

Ensure Mugar's status is consistent across Places, Open Now, search results, location details, and Planning recommendations.

Do not modify other location schedules.

9. Calendar Tab: Always Display a Calendar

The Calendar tab must always display a functional calendar grid, whether or not a user has uploaded a schedule.

9.1 Default calendar

Display:

The current month and year.
Seven columns representing the days of the week.
Previous-month and next-month navigation.
A highlighted current date.
Clear distinctions between current-month and adjacent-month dates.
A way to return to today.

The monthly grid must remain visible when:

No schedule has been uploaded.
A file upload fails.
The user clears their calendar.
The user replaces an existing schedule.

Never replace the calendar grid with an upload-only screen, loading screen, or empty-state message.

When no schedule is imported, show an empty calendar without fabricated events.

A small message may explain:

No schedule imported yet. Upload your ICS file to display your events.

Keep an Upload Calendar action accessible.

9.2 Calendar interactions
Clicking a date selects it and displays its events in a readable list.
Clicking an event displays its available details.
Dates containing events should be visually distinguishable.
Month navigation must preserve imported events.
Calendar controls must remain usable on mobile.
Avoid cramped or overlapping event titles.

Keep the calendar design consistent with BU-sy's list-based UI wherever practical, while retaining the monthly calendar grid.

10. ICS Calendar Upload and Import

Users must be able to import personal schedules through .ics files instead of connecting Google Calendar.

Do not implement Google OAuth or Google Calendar API integration.

10.1 Upload interface

Provide:

An Upload Calendar button.
A file picker accepting .ics files.
A brief explanation of supported calendar exports.
The imported filename and event count.
Loading, success, invalid-file, and error states.
A way to replace the imported schedule.
A way to clear the imported schedule.

Support standard iCalendar exports from compatible applications such as Google Calendar, Apple Calendar, and Outlook.

Validate file contents instead of trusting the extension alone.

10.2 Parse real events

Use an existing reliable ICS parsing library if available; otherwise, use an appropriate maintained library compatible with the project.

Support:

Standard calendar events.
Event start and end times.
Recurring classes and meetings.
Recurrence rules and exceptions.
Cancelled events.
All-day events.
Multi-day events.
Events spanning midnight.
Timezone information.
Daylight-saving-time changes.
Overlapping events.
Multiple events on the same day.

Correctly interpret TZID, UTC timestamps, and floating local times.

Use America/New_York as the default timezone for floating local times when appropriate for the Boston-based application, without incorrectly converting events that specify a different timezone.

Respect recurrence limits and do not generate unlimited occurrences.

Do not invent event durations or dates.

Invalid events should be handled gracefully rather than assigned fabricated values.

10.3 Populate the calendar automatically

After a successful import:

Display the actual events on the correct dates.
Display event titles and times when available.
Show all-day events clearly.
Represent multi-day events across all applicable dates.
Respect recurrence exceptions and cancellations.
Update the calendar immediately.
Update the imported filename and event count.
Recalculate busy intervals and free-time windows.

When the user replaces an ICS file, replace the old imported schedule instead of combining it with the new file.

A failed upload must not destroy a previously valid schedule.

11. Mark Imported ICS Events as Busy

Every imported event must block the corresponding time interval in the Calendar tab.

Display imported events as Busy periods using a clear, accessible visual treatment.

For example:

9:00 AM–10:15 AM — Biology Lecture — Busy.
10:15 AM–11:30 AM — Available.
11:30 AM–1:00 PM — Class — Busy.

These times are illustrative. Use the actual imported data.

Requirements:

Mark events busy for their actual start and end times.
Treat all-day events as busy for the applicable day.
Keep overlapping events individually visible.
Merge overlapping busy intervals for free-time calculations.
Correctly handle events spanning midnight and multiple days.
Update busy periods immediately after imports or replacements.
Remove imported busy periods when the imported schedule is cleared.
Preserve the calendar grid when events are cleared.

Do not allow the visual calendar and availability calculations to use different event data.

12. Clear Calendar Button

Add or preserve a clearly visible Clear Calendar button near the calendar upload controls.

When clicked, show a confirmation dialog:

Clear your calendar?

"This will remove your uploaded schedule and reset your calendar availability. This action cannot be undone."

Buttons:

Cancel.
Clear Calendar.

Only clear the imported schedule after confirmation.

On confirmation, remove:

Imported ICS events.
Parsed recurrence data associated with the imported schedule.
Calculated busy intervals from that schedule.
Free-time calculations derived from those events.
Availability recommendations derived from the deleted schedule.
Imported filename and import status.
Persisted data belonging to the cleared imported schedule.

Return the calendar to its empty state without hiding the calendar grid.

Ensure deleted imported events do not reappear after refreshing the page.

Do not delete unrelated application data, location datasets, settings, or independently saved club events.

If existing storage is shared between different event sources, scope the deletion carefully.

13. Make Upload Your Schedule Collapsible

Make the explanatory content of the Upload Your Schedule section collapsible to reduce visual clutter.

13.1 Default state
Keep the heading visible.
Add a small chevron or arrow to toggle expansion.
Default the explanatory section to collapsed.
Keep the calendar grid visible regardless of the expanded state.
Keep the upload action easy to access.
13.2 Expanded state

When expanded, show all existing explanatory text, .ics upload instructions, privacy notices, and supporting information.

Do not delete or rewrite useful content simply because it is collapsed.

13.3 Interaction and accessibility
Clicking the heading or chevron toggles the section.
Use a subtle transition consistent with the Places tab.
Support keyboard interaction.
Provide visible focus indicators.
Use appropriate accessible attributes, including aria-expanded.
Ensure the control works on desktop and mobile.

Do not hide critical warnings or error messages inside a permanently inaccessible section.

Preserve the upload, replacement, and Clear Calendar functionality.

14. Planning Tab: Custom Free-Time Duration

In the Planning tab, allow users to choose a custom time duration when selecting Other under free time.

When Other is selected, display:

A numeric duration input.
A unit selector with Minutes and Hours.

Examples:

45 Minutes = 45 minutes.
1.5 Hours = 90 minutes.
2 Hours = 120 minutes.

Requirements:

Show custom controls only when Other is selected.
Hide them when a preset duration is selected.
Preserve the existing preset options.
Convert the selected duration to minutes internally.
Update recommendations when the amount or unit changes.
Accept decimal hours where appropriate.
Reject zero, negative values, invalid values, and unreasonable durations.
Provide clear validation messages.
Preserve the selected value when switching units where practical.

Only recommend availability windows that meet or exceed the requested duration.

Use the existing availability calculation functions rather than creating a separate calculation system.

Ensure that location opening hours, dining hall meal-service periods, imported ICS busy periods, and saved club events are respected.

Do not change unrelated Planning tab functionality.

15. Availability Explanation Information Icon

Replace the long, always-visible availability explanation with a small information icon.

Current explanatory text:

"No schedule uploaded, so you're treated as free for all of 08:00–22:00 (America/New_York). Upload your class schedule (.ics) to use your real one. Travel time isn't included."

Show a small ⓘ icon beside the relevant availability heading or control instead of displaying the entire paragraph by default.

When hovered over, show a compact tooltip with the explanation.

Suggested text:

"No schedule uploaded. Availability assumes you're free from 8:00 AM to 10:00 PM in the America/New_York timezone. Upload your class schedule (.ics) to calculate availability using your actual events. Travel time is not included."

Requirements:

Hovering with a mouse displays the tooltip.
Clicking or tapping opens it on touch devices.
Clicking outside or activating the icon again closes it.
Support keyboard focus and Enter/Space activation.
Use an accessible label such as About availability assumptions.
Keep the tooltip within the viewport.
Prevent overlap with important controls.
Match existing BU-sy tooltip styling.

Apply the same pattern to other lengthy explanatory notes when useful, but keep essential instructions and warnings visible.

When a calendar is imported, do not continue displaying the no-schedule assumption as if it were still true.

If no ICS schedule exists but club events have been saved, preserve the existing no-ICS assumption while still treating the saved club events as busy.

16. Club Events: Add Events to the Calendar

Allow users to add real club events from the Clubs tab to their personal BU-sy calendar.

16.1 Add to Calendar action

For each club event with valid schedule data, provide an Add to Calendar button.

Use available source data:

Event title.
Club name.
Date.
Start and end times.
Location.
Description.

Inspect the existing club dataset first.

If it contains only club names and descriptions without actual event schedules, do not invent events or dates. Identify available event data sources and implement the feature only for valid events.

16.2 Calendar display

After a user adds an event:

Display it on the correct date and at the correct time.
Identify the associated club.
Show available event details.
Make it visually distinguishable from imported class events.
Preserve the existing monthly calendar grid and list-based styling.

When successfully added, change the action to Added to Calendar and prevent duplicate additions.

Allow users to remove individual saved club events.

16.3 Keep event sources separate

Store saved club events separately from imported ICS events.

Adding a club event must not overwrite an imported schedule.
Replacing an ICS file must preserve club events.
Clearing an imported ICS schedule must preserve independently saved club events.
Removing a club event must not remove unrelated events.
Prevent duplicates using stable event IDs where available.
Preserve club event data across navigation and page refreshes using the existing persistence approach.

Keep the Calendar tab synchronized with both event sources.

16.4 Club events count as Busy

Include saved club events in the availability calculation.

Treat each saved club event as a busy interval.
Merge overlapping intervals for availability calculations.
Keep individual overlapping events visible in the calendar.
Update recommendations immediately when club events are added or removed.
Do not recommend a location visit during a saved club event.

If no ICS schedule has been uploaded, preserve the existing default availability assumptions while blocking time covered by saved club events.

Do not require Google Calendar authentication or send personal calendar data to external services.

17. Privacy, Storage, and Reliability

Calendar data can contain sensitive personal information.

Requirements:

Parse uploaded ICS files locally in the browser whenever feasible.
Do not send personal calendar events to external services or AI models.
Do not log private event titles, descriptions, attendees, or locations.
Do not collect calendar credentials.
Avoid permanently storing raw uploaded files.
Store only the minimum necessary information for calendar display and availability calculations.
Provide a reliable way to remove imported calendar data.
If persistence is used, explain where data is stored and provide a deletion mechanism.
Clear only the intended calendar data.
Handle malformed files and invalid events safely.

Use the existing storage implementation wherever possible, and ensure the application behaves consistently after page refreshes.

18. Remove the Meetups Feature

Remove the Meetups feature from the repository while preserving everything else.

Before deleting files, search the repository for all references to Meetups.

Remove:

The Meetups page and components dedicated exclusively to the feature.
Meetup-specific navigation links, tabs, buttons, and menu items.
Meetup-specific routes and links.
Meetup-specific event creation flows and forms.
Meetup-only mock data, utilities, styles, and dependencies that are no longer needed.

Preserve:

Clubs and club events.
Calendar and ICS functionality.
Planning and availability calculations.
Location records and schedules.
Shared components, styles, and utilities used elsewhere.

Update routing and navigation to avoid broken links.

Do not perform unrelated refactoring or delete shared code.

After removal, confirm no Meetup-specific UI or route remains. If a remaining reference is needed by another feature, retain it and explain why.

19. Data Integrity and Shared Architecture

The entire application should use consistent data sources and business logic.

19.1 Locations

Use existing location records and stable IDs across Places, Open Now, Planning, and Calendar recommendations.

19.2 Operating hours

Use one shared calculation function for determining building operating status.

19.3 Meal services

Keep building hours and meal-service hours separate.

19.4 Calendar events

Keep imported ICS events and saved club events logically separate while combining their busy intervals for availability calculations.

19.5 Availability

Calculate availability using:

Imported ICS events, when available.
Saved club events.
The selected date.
The requested minimum free-time duration.
The preferred time window.
Verified building operating hours.
Verified meal-service hours when recommending dining opportunities.

Do not duplicate or hardcode separate calculations for different tabs.

Do not fabricate data to fill gaps.

When a data source is missing or uncertain, communicate that uncertainty rather than presenting guessed information as verified.

20. Testing Requirements

Add or update automated tests wherever the project already supports them.

20.1 Location and operating hours

Test:

Before opening time.
During opening hours.
At closing time.
After closing time.
Overnight schedules.
Date-specific schedules.
Holiday closures.
Missing or unverified hours.
Mugar Library's verified schedule.
Consistent status across all tabs.
20.2 Dining hall meal services

Test:

Breakfast, brunch, lunch, and dinner transitions.
Building open between meals.
Building closed while meal data exists.
Different schedules on different days.
Missing or unverified meal-service data.
Non-dining locations remaining unaffected.
20.3 Calendar and ICS

Test:

Empty calendar display.
Month navigation.
Valid and invalid ICS files.
Recurring events and exceptions.
Timezone and daylight-saving conversions.
All-day and multi-day events.
Overlapping events.
Busy interval calculations.
Free-time calculations.
Replacing an ICS schedule.
Clearing imported events.
Persistence after refresh.
Saved club events surviving ICS replacement and clearing.
20.4 Planning

Test:

Preset duration options.
Custom minutes.
Custom hours.
Decimal hours.
Invalid values.
Updating recommendations.
Respecting busy periods and location hours.
20.5 UI and navigation

Test:

Responsive layouts.
Text wrapping and overflow.
Filter alignment.
Hover and focus states.
Collapsible Upload Your Schedule section.
Information tooltip interactions.
Calendar controls.
Removal of the Serving Food filter.
Removal of the Meetups feature.
Existing routes and navigation.

Run the project's build and relevant tests after implementation.

Do not claim tests passed unless they were actually executed.

21. Implementation Strategy

Work in a controlled manner to minimize regressions.

Phase 1: Inspect
Inspect the repository structure and current branch.
Review the package configuration, framework, and build scripts.
Identify the existing location, club, calendar, Planning, and navigation components.
Identify shared styles and calculation utilities.
Determine which requested features already exist and which require implementation.
Identify available verified data sources.
Phase 2: Plan

Prepare a short implementation plan identifying:

Files that need modification.
Existing components to reuse.
Data structures that must remain unchanged.
Shared calculations that should be reused.
Potential regression risks.

Do not rewrite the application from scratch.

Phase 3: Implement

Implement the requested changes directly in the existing repository.

Use minimal, focused changes wherever possible.

Do not replace existing verified datasets with new mock data.

Do not remove unrelated functionality.

Phase 4: Verify

Run the available build, lint, and test commands.

Check the modified features manually or with automated tests where possible.

Verify that all existing pages and functionality remain operational.

Phase 5: Report

When finished, provide:

A summary of completed changes.
The files added, modified, or removed.
Any data sources used to verify operating hours.
The tests and build commands executed.
Any failures, unresolved issues, or unsupported data.
Any requested feature that could not be completed and why.
22. Strict Scope and Preservation Rules

These rules apply to the entire task.

Preserve all existing location information and datasets unless a specific change is requested.
Do not invent location hours, meal periods, club events, calendar entries, or user availability.
Do not delete information to make the UI appear cleaner.
Do not redesign unrelated pages.
Do not introduce Google Calendar integration.
Do not let calendar data override actual building operating status.
Do not let meal-service status override building operating hours.
Do not let clearing an imported ICS schedule delete saved club events.
Do not remove the calendar grid when a schedule is absent or cleared.
Do not remove features other than the explicitly requested Meetups feature and the Serving Food filter.
Keep all remaining tabs visually consistent with the Places tab.
Reuse shared components, data structures, and calculation logic.
Do not fabricate successful test results.
Do not stop at providing a plan or sample code; implement the changes in the repository.

Final objective: Deliver a polished, reliable BU-sy application with consistent list-based styling, accurate location and dining hall operating statuses, a permanently visible calendar populated by real ICS and saved club events, correct Busy/free-time calculations, customizable Planning durations, accessible collapsible explanations, a cleaner Clubs tab, verified Mugar Library hours, and no Meetup feature. Preserve all unrelated data and functionality, and make only the changes required to achieve these goals.
