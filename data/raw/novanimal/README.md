# Original files: NOVANIMAL aggregated menu sales

`2017_ZHAW_aggregated_menu_sales_NOVANIMAL.csv` and `variables_aggregated_dataset_20201007.pdf` (the
publisher's variable list) are the publisher's files, **unchanged**, as downloaded by
`python data/import_novanimal.py --download` from Zenodo. Their checksums were checked against the
publisher's before anything was stored. `SOURCE.json` records the DOI, download URLs, retrieval time and
checksums.

- **Dataset:** Gian-Andrea Egeler (2020). *Supplementary material (aggregated data set): Egeler, G.-A. &
  Baur, P. (2020). Menüwahl in der Hochschulmensa: Fleisch oder Vegi? Ergebnisse eines 12-wöchigen
  Feldexperiments (NOVANIMAL Working Paper No. 5). ZHAW.* Zenodo. https://doi.org/10.5281/zenodo.3890931
- **Working paper:** https://doi.org/10.21256/zhaw-1405
- **Licence:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
- **What the licence asks of us:** credit the creator (above), link the licence, and say what we changed.
- **What we changed (in derived files only):** `data/clean_novanimal_transactions.csv` groups article lines
  into purchases and counts them per canteen per 15 minutes; `data/generate_campus_simulation.py` turns those
  counts into illustrative diners with an assumed 30-minute meal and rescales them into BU-sy's simulated
  dining-hall lunch values. Those values are a simulation, not measurements of any BU dining hall.
- The data are sales (purchases) at two ZHAW university canteens, Grüental and Vista, in Wädenswil,
  Switzerland, in autumn 2017. They are not counts of people present and not Boston University.
- The more personally detailed individual data set (https://doi.org/10.5281/zenodo.3890949) isn't used.
