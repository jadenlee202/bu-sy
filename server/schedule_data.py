"""SAMPLE official schedule (placeholders, not the real FitRec timetable).

Class times line up with the multipurpose-room and dance-theatre spikes in
data/bu_campus_synthetic_occupancy.csv (Monday 9 AM, noon, 5-8 PM).
Replace with the published FitRec schedule before showing it as real.
"""
from datetime import time

_CLASS_ROOMS = [f"multipurpose-room-{n}" for n in range(1, 8)] + ["dance-theatre"]
_CLASS_BLOCKS = [(time(9), time(10)), (time(12), time(13)), (time(17), time(20))]

SCHEDULE = [
    {
        "id": f"sample-class-{i}",
        "title": "Group fitness classes (sample)",
        "type": "class",
        "area_ids": _CLASS_ROOMS,
        "day_of_week": 0,
        "start": start,
        "end": end,
        "source": "sample",
    }
    for i, (start, end) in enumerate(_CLASS_BLOCKS)
] + [
    {
        "id": "sample-intramural-1",
        "title": "Intramural basketball (sample)",
        "type": "intramural",
        "area_ids": ["basketball-court-basement"],
        "day_of_week": 0,
        "start": time(19),
        "end": time(21),
        "source": "sample",
    },
]

# Placeholder program lists for /api/programs.
CLUB_SPORTS = ["Climbing (sample)", "Swimming (sample)", "Squash (sample)"]
INTRAMURALS = ["Basketball (sample)", "Volleyball (sample)"]
