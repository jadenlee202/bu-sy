# Original file: ROBOD, Room 5 (library space)

`combined_Room5.csv` and `publisher_README.md` are the publisher's files, **unchanged**, extracted from
`SupplementaryData.zip` by `python data/import_robod.py --download`. The archive's MD5 was checked against
the publisher's before anything was stored. `SOURCE.json` records the DOI, version, download URL, retrieval
time and checksums. The other four rooms in the archive aren't used and aren't stored.

- **Dataset:** Zeynep Duygu Tekler, Eikichi Ono, Yuzhen Peng, Sicheng Zhang, Bertrand Lasternas, Adrian Chong
  (2022). *ROBOD, Room-level Occupancy and Building Operation Dataset*. figshare, version 7.
  https://doi.org/10.6084/m9.figshare.19234530
- **Paper:** Tekler, Z.D. et al. (2022). ROBOD, room-level occupancy and building operation dataset.
  *Building Simulation*. https://doi.org/10.1007/s12273-022-0925-9
- **Licence:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
- **What the licence asks of us:** credit the creators (above), link the licence, and say what we changed.
- **What we changed (in derived files only):** `data/clean_robod_library_occupancy.csv` keeps only the
  timestamp and `occupant_count [number]`; `data/generate_campus_simulation.py` averages the recorded Mondays
  and rescales them into BU-sy's simulated Mugar Library values. Those values are a simulation, not
  measurements of Mugar or of this room.
- Room 5 is a library space in the SDE4 building at the National University of Singapore. It is not
  Boston University.
