/* ==========================================================================
   pa-checkbook-dashboard.js

   Drives all client-side interactivity for the Keystone Ledger Lens
   Treasury Checkbook report:
     - clickable year / month / payee-name / account-code values that open
       a modal showing a chart + sortable, paginated table of the
       underlying L1 micro-report records
     - the trailing-365-day overview chart on the main page
     - the "report date" auto-loaded month-detail panel

   DATA ACCESS:
   All drill-down data is read via fetch() against relative paths under
   DATA/L1/, e.g.:
     DATA/L1/BY_YEAR/2026/2026-06.json
     DATA/L1/BY_ACCT/6351220/2026-06.json
     DATA/L1/BY_NAME/321_DEVELOPMENT_LP/2026-06.json
   This requires the page to be served over http/https (e.g. GitHub
   Pages) -- fetch() against file:// URLs is blocked by browsers for
   local JSON and is not supported here.

   Each L1 file is a JSON array of raw records with fields:
     {"0": "<row id>", "name": "...", "invoice": "YYYY-MM-DD",
      "gross": "1234.5600", "status": "Paid", "description": "...",
      "alt": "<account code>"}

   No build step / bundler is assumed: this is loaded as a plain
   <script src="..."> after Chart.js, and exposes a small set of
   functions on `window` that the Jinja template's inline onclick
   handlers call directly (PALedger.openYear(...), etc.)
   ========================================================================== */

(function () {
  "use strict";

  const DATA_ROOT = "DATA/L1";
  const PAGE_SIZE = 25;

  // --------------------------------------------------------------------
  // Small utilities
  // --------------------------------------------------------------------

  /**
   * JS port of parse_pa_checkbook.py's sanitize_for_path(). MUST stay in
   * sync with that function -- it determines the actual folder names
   * under DATA/L1/BY_NAME/ and DATA/L1/BY_ACCT/ on disk, so any drift
   * between this and the Python version causes every drill-down fetch
   * for an affected name to silently 404.
   *   - trim, collapse internal whitespace runs to "_"
   *   - replace / \ : * ? " < > | and ' (and null) with "_"
   *   - empty/"."/".." -> "_EMPTY_"
   */
  function sanitizeForPath(rawValue) {
    let value = String(rawValue || "").trim();
    value = value.replace(/\s+/g, "_");
    value = value.replace(/[\/\\\0:*?"<>|']/g, "_");
    if (value === "" || value === "." || value === "..") return "_EMPTY_";
    return value;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function monthKey(year, month) {
    return `${year}-${pad2(month)}`;
  }

  /** Parse the "gross" field (a string like "1234.5600") to a float. */
  function parseAmount(raw) {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }

  /** Format a number as a plain 2-decimal string with thousands separators, no $. */
  function formatAmount(n) {
    return parseFloat(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Parse a record's "invoice" date string (YYYY-MM-DD) into a Date, or null. */
  function parseRecordDate(record) {
    if (!record || !record.invoice) return null;
    const parts = String(record.invoice).split("-");
    if (parts.length !== 3) return null;
    const [y, m, d] = parts.map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  /**
   * Fetch one L1 JSON file. Returns a Promise resolving to an array of
   * records, or an empty array if the file doesn't exist (e.g. an
   * account/payee had no activity in a given month) -- a 404 here is an
   * expected, normal outcome, not an error to surface to the reader.
   */
  async function fetchRecords(path) {
    try {
      const resp = await fetch(path, { cache: "no-store" });
      if (!resp.ok) return [];
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn("PALedger: failed to fetch", path, err);
      return [];
    }
  }

  /** Fetch every month file for a given year (Jan-Dec), combined into one array. */
  async function fetchYearRecords(year) {
    const fetches = [];
    for (let m = 1; m <= 12; m++) {
      fetches.push(fetchRecords(`${DATA_ROOT}/BY_YEAR/${year}/${monthKey(year, m)}.json`));
    }
    const results = await Promise.all(fetches);
    return results.flat();
  }

  /** Fetch every available month file for a payee or account code by listing
   * known month keys passed in (the template provides the list of months
   * that actually have data, from L3 summary.json, so we don't have to
   * guess/probe for files that don't exist). */
  async function fetchAllMonths(basePath, monthKeys) {
    const fetches = monthKeys.map((mk) => fetchRecords(`${basePath}/${mk}.json`));
    const results = await Promise.all(fetches);
    return results.flat();
  }

  // --------------------------------------------------------------------
  // Modal shell
  // --------------------------------------------------------------------

  let modalChartInstance = null;

  function ensureModal() {
    let modal = document.getElementById("pal-modal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "pal-modal";
    modal.className = "pal-modal-overlay";
    modal.innerHTML = `
      <div class="pal-modal" role="dialog" aria-modal="true" aria-labelledby="pal-modal-title">
        <div class="pal-modal-header">
          <h3 id="pal-modal-title" class="pal-modal-title"></h3>
          <button type="button" class="pal-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="pal-modal-body">
          <div class="pal-modal-chart-wrap">
            <canvas id="pal-modal-chart" height="220"></canvas>
          </div>
          <div class="pal-modal-table-wrap">
            <table class="pal-table" id="pal-modal-table">
              <thead></thead>
              <tbody></tbody>
            </table>
            <div class="pal-pagination" id="pal-modal-pagination"></div>
          </div>
        </div>
        <div class="pal-modal-footer" id="pal-modal-footer">
          <span class="pal-modal-footer-label" id="pal-modal-footer-label">Permalink:</span>
          <a class="pal-modal-footer-url" id="pal-modal-footer-url" href="#" target="_blank"></a>
          <button class="pal-modal-footer-copy" id="pal-modal-footer-copy" title="Copy link" aria-label="Copy permalink to clipboard"><img src="www/img/icons/copy_navy.png" alt="Copy"></button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector(".pal-modal-close").addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("pal-open")) closeModal();
    });

    return modal;
  }

  function openModal(title) {
    const modal = ensureModal();
    modal.querySelector("#pal-modal-title").textContent = title;

    // Always restore the chart wrap and table/pagination, and clear any
    // README content that a previous openReadme() call may have injected.
    // This must happen here -- at the start of every modal open -- so the
    // next drill-down always finds a clean, fully-visible modal structure.
    const chartWrap = modal.querySelector(".pal-modal-chart-wrap");
    if (chartWrap) chartWrap.style.display = "";

    const tableEl = modal.querySelector("#pal-modal-table");
    if (tableEl) tableEl.style.display = "";

    const paginationEl = modal.querySelector("#pal-modal-pagination");
    if (paginationEl) paginationEl.style.display = "";

    const tableWrap = modal.querySelector(".pal-modal-table-wrap");
    if (tableWrap) {
      const readmeContent = tableWrap.querySelector(".pal-readme-body, .pal-readme-loading, .pal-readme-error, .pal-invoice-content");
      if (readmeContent) readmeContent.remove();
    }

    modal.classList.add("pal-open");
    document.body.classList.add("pal-modal-active");
  }

  function closeModal() {
    const modal = document.getElementById("pal-modal");
    if (!modal) return;
    modal.classList.remove("pal-open");
    document.body.classList.remove("pal-modal-active");
    if (modalChartInstance) {
      modalChartInstance.destroy();
      modalChartInstance = null;
    }
  }

  function setModalChart(config) {
    const canvas = document.getElementById("pal-modal-chart");
    if (modalChartInstance) {
      modalChartInstance.destroy();
      modalChartInstance = null;
    }
    if (!config) {
      canvas.style.display = "none";
      return;
    }
    if (typeof window.Chart === "undefined") {
      // Chart.js failed to load (CDN blocked, offline, ad blocker, etc).
      // The table is still the primary, functional data view, so it must
      // render regardless -- hide the canvas rather than throw and abort
      // whatever called us (which would also skip the table render that
      // follows it in every openX() function).
      console.warn("PALedger: Chart.js not available; rendering table only.");
      canvas.style.display = "none";
      return;
    }
    canvas.style.display = "block";
    modalChartInstance = new Chart(canvas.getContext("2d"), config);
  }

  // --------------------------------------------------------------------
  // Sortable, paginated table renderer (shared by every modal view)
  // --------------------------------------------------------------------

  /**
   * Render `records` into the modal's table + pagination controls.
   * `columns` is an array of {key, label, sortable, format} describing
   * how to pull and display a value from each record. Sorting and
   * pagination state is kept local to this call via closures, so each
   * openX() call gets its own fresh table state.
   */
  function renderTable(records, columns) {
    const table = document.getElementById("pal-modal-table");
    const thead = table.querySelector("thead");
    const tbody = table.querySelector("tbody");
    const paginationEl = document.getElementById("pal-modal-pagination");

    let sortKey = columns.find((c) => c.defaultSort) ? columns.find((c) => c.defaultSort).key : null;
    let sortDir = -1; // most recent / largest first by default
    let currentPage = 1;

    function sortedRecords() {
      if (!sortKey) return records;
      const col = columns.find((c) => c.key === sortKey);
      const sorted = [...records].sort((a, b) => {
        const va = col.sortValue ? col.sortValue(a) : a[sortKey];
        const vb = col.sortValue ? col.sortValue(b) : b[sortKey];
        if (va < vb) return -1 * sortDir;
        if (va > vb) return 1 * sortDir;
        return 0;
      });
      return sorted;
    }

    function renderHead() {
      thead.innerHTML = "";
      const tr = document.createElement("tr");
      columns.forEach((col) => {
        const th = document.createElement("th");
        th.textContent = col.label;
        if (col.className) th.classList.add(col.className);
        if (col.sortable) {
          th.classList.add("pal-sortable");
          if (col.key === sortKey) {
            th.classList.add(sortDir === 1 ? "pal-sort-asc" : "pal-sort-desc");
          }
          th.addEventListener("click", () => {
            if (sortKey === col.key) {
              sortDir *= -1;
            } else {
              sortKey = col.key;
              sortDir = -1;
            }
            currentPage = 1;
            renderHead();
            renderBody();
          });
        }
        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }

    function renderBody() {
      const all = sortedRecords();
      const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      currentPage = Math.min(currentPage, totalPages);
      const start = (currentPage - 1) * PAGE_SIZE;
      const pageRecords = all.slice(start, start + PAGE_SIZE);

      tbody.innerHTML = "";
      if (pageRecords.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = columns.length;
        td.className = "pal-empty";
        td.textContent = "No records found.";
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        pageRecords.forEach((record) => {
          const tr = document.createElement("tr");
          columns.forEach((col) => {
            const td = document.createElement("td");
            const raw = col.value ? col.value(record) : record[col.key];
            if (col.render) {
              col.render(td, raw, record, tr, columns.length);
            } else {
              td.textContent = col.format ? col.format(raw, record) : raw;
            }
            if (col.className) td.className = col.className;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
      }

      renderPagination(totalPages);
    }

    function renderPagination(totalPages) {
      paginationEl.innerHTML = "";
      if (totalPages <= 1) return;

      const makeBtn = (label, page, disabled, active) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.disabled = !!disabled;
        if (active) btn.className = "pal-page-active";
        btn.addEventListener("click", () => {
          currentPage = page;
          renderBody();
        });
        return btn;
      };

      paginationEl.appendChild(makeBtn("\u2039 Prev", currentPage - 1, currentPage === 1));

      const maxButtons = 7;
      let startPage = Math.max(1, currentPage - 3);
      let endPage = Math.min(totalPages, startPage + maxButtons - 1);
      startPage = Math.max(1, endPage - maxButtons + 1);

      for (let p = startPage; p <= endPage; p++) {
        paginationEl.appendChild(makeBtn(String(p), p, false, p === currentPage));
      }

      paginationEl.appendChild(makeBtn("Next \u203a", currentPage + 1, currentPage === totalPages));

      const summary = document.createElement("span");
      summary.className = "pal-page-summary";
      summary.textContent = `${records.length.toLocaleString()} record${records.length === 1 ? "" : "s"}`;
      paginationEl.appendChild(summary);
    }

    renderHead();
    renderBody();
  }

  // Standard column set used by every modal table (the raw record shape
  // is identical across BY_YEAR/BY_ACCT/BY_NAME files).
  function standardColumns() {
    return [
      {
        key: "invoice", label: "Date", sortable: true, defaultSort: true,
        sortValue: (r) => r.invoice || "",
      },
      {
        key: "name", label: "Payee", sortable: true,
        sortValue: (r) => (r.name || "").trim().toLowerCase(),
        format: (v) => (v || "").trim(),
        render: (td, raw, record, tr, colCount) => {
          const vk = record["0"] || "";
          const name = (raw || "").trim();
          if (vk) {
            const link = document.createElement("span");
            link.className = "pal-link pal-invoice-trigger";
            link.textContent = name;
            link.title = "Click to view invoice";
            link.addEventListener("click", () =>
              toggleInvoiceRow(tr, vk, name, colCount));
            td.appendChild(link);
          } else {
            td.textContent = name;
          }
        },
      },
      {
        key: "gross", label: "Amount", sortable: true, className: "pal-amount-cell",
        sortValue: (r) => parseAmount(r.gross),
        format: (v) => formatAmount(parseAmount(v)),
      },
      {
        key: "description", label: "Category", sortable: true,
        sortValue: (r) => (r.description || "").toLowerCase(),
        className: "pal-col-category",
      },
      { key: "alt", label: "Account", sortable: true },
    ];
  }

  // --------------------------------------------------------------------
  // Aggregation helpers for modal charts
  // --------------------------------------------------------------------

  /** Sum amounts per calendar month (1-12) across a set of records, for a bar chart. */
  function sumByMonth(records) {
    const totals = new Array(12).fill(0);
    records.forEach((r) => {
      const d = parseRecordDate(r);
      if (!d) return;
      totals[d.getMonth()] += parseAmount(r.gross);
    });
    return totals;
  }

  /** Sum amounts per group key (e.g. payee name or account code), descending, top N + Other. */
  function sumByKey(records, keyFn, topN) {
    const totals = new Map();
    records.forEach((r) => {
      const key = keyFn(r);
      totals.set(key, (totals.get(key) || 0) + parseAmount(r.gross));
    });
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, topN);
    const rest = sorted.slice(topN);
    const otherTotal = rest.reduce((sum, [, v]) => sum + v, 0);
    if (otherTotal > 0) top.push(["Other", otherTotal]);
    return top;
  }

  /** Sum amounts per "YYYY-MM" key across records spanning multiple years, sorted chronologically. */
  function sumByYearMonth(records) {
    const totals = new Map();
    records.forEach((r) => {
      const d = parseRecordDate(r);
      if (!d) return;
      const key = monthKey(d.getFullYear(), d.getMonth() + 1);
      totals.set(key, (totals.get(key) || 0) + parseAmount(r.gross));
    });
    return [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  /** Sum amounts per CALENDAR month (Jan=0..Dec=11), summed across ALL
   *  years present in `records` -- the client-side equivalent of the
   *  Jinja radar_months computation used for the page's main "Spend by
   *  Month (All Years)" radar, needed here because there's no
   *  pre-aggregated L2 field for WIR PAYEE the way there is for
   *  ach_payee; this works from the same raw records already fetched
   *  to build the WIR pie charts. */
  function sumByCalendarMonth(records) {
    const totals = new Array(12).fill(0);
    records.forEach((r) => {
      const d = parseRecordDate(r);
      if (!d) return;
      totals[d.getMonth()] += parseAmount(r.gross);
    });
    return totals;
  }

  const CHART_PALETTE = [
    "#2f7da0", "#16365b", "#9dddee", "#fa1b3e", "#5b9279",
    "#c98a3e", "#7a6ba0", "#3e8e7e", "#a85b7a", "#6b8e23",
  ];

  // Same 10 colors as CHART_PALETTE, reordered, used ONLY by the two
  // WIR pie charts -- every other pie/doughnut on the page (Top
  // Payees, Top Accounts, the ACH breakdown) uses CHART_PALETTE in its
  // original order, so two charts sitting near each other on the page
  // (e.g. ACH's "by description" pie and WIR's "by description" pie)
  // would otherwise assign the same color to their #1-ranked slice,
  // making them look like the same chart restyled rather than two
  // distinct breakdowns. This is purely a different starting order of
  // the identical color set, not a different palette -- WIR still
  // shares the page's overall color language.
  const WIR_CHART_PALETTE = [
    "#7a6ba0", "#3e8e7e", "#fa1b3e", "#9dddee", "#a85b7a",
    "#2f7da0", "#6b8e23", "#16365b", "#c98a3e", "#5b9279",
  ];

  // Ten distinct shuffles of CHART_PALETTE's 10 colors, one assigned to
  // each of the top-10 description subsections. Each pair of pie charts
  // within a subsection shares the same shuffle (payees-left and
  // accounts-right for the same description use the same visual language)
  // but adjacent subsections use a different rotation so they don't
  // all look identical. These are not random -- they are pre-computed
  // rotations of the same set so the page's overall color language is
  // preserved while still giving each subsection a visually distinct
  // first-slice color.
  const DESCRIPTION_PALETTES = [
    ["#5b9279", "#c98a3e", "#7a6ba0", "#2f7da0", "#a85b7a", "#16365b", "#6b8e23", "#fa1b3e", "#3e8e7e", "#9dddee"],
    ["#3e8e7e", "#fa1b3e", "#16365b", "#5b9279", "#9dddee", "#a85b7a", "#c98a3e", "#6b8e23", "#2f7da0", "#7a6ba0"],
    ["#c98a3e", "#9dddee", "#a85b7a", "#3e8e7e", "#6b8e23", "#fa1b3e", "#2f7da0", "#5b9279", "#7a6ba0", "#16365b"],
    ["#a85b7a", "#6b8e23", "#2f7da0", "#c98a3e", "#16365b", "#9dddee", "#fa1b3e", "#7a6ba0", "#5b9279", "#3e8e7e"],
    ["#6b8e23", "#16365b", "#fa1b3e", "#a85b7a", "#7a6ba0", "#3e8e7e", "#9dddee", "#5b9279", "#c98a3e", "#2f7da0"],
    ["#fa1b3e", "#7a6ba0", "#9dddee", "#6b8e23", "#2f7da0", "#5b9279", "#3e8e7e", "#16365b", "#a85b7a", "#c98a3e"],
    ["#9dddee", "#2f7da0", "#5b9279", "#fa1b3e", "#3e8e7e", "#7a6ba0", "#16365b", "#c98a3e", "#6b8e23", "#a85b7a"],
    ["#16365b", "#5b9279", "#c98a3e", "#9dddee", "#fa1b3e", "#6b8e23", "#a85b7a", "#3e8e7e", "#2f7da0", "#7a6ba0"],
    ["#2f7da0", "#a85b7a", "#6b8e23", "#7a6ba0", "#5b9279", "#c98a3e", "#fa1b3e", "#9dddee", "#3e8e7e", "#16365b"],
    ["#7a6ba0", "#3e8e7e", "#2f7da0", "#16365b", "#c98a3e", "#fa1b3e", "#5b9279", "#a85b7a", "#9dddee", "#6b8e23"],
  ];

  // --------------------------------------------------------------------
  // Public drill-down entry points
  // (called directly from onclick="" attributes in the Jinja template)
  // --------------------------------------------------------------------

  /** Year click: bar chart of that year's 12 months + table of every record. */
  // --------------------------------------------------------------------
  // Permalink URL builder and modal footer
  // --------------------------------------------------------------------

  const PERMALINK_BASE = (() => {
    // Works on both keystoneledger.github.io and any local dev server.
    const loc = window.location;
    return `${loc.protocol}//${loc.host}/permalink.html`;
  })();

  /** Build a clean permalink URL for any drill-down type.
   *  params object keys:
   *    year, month           — integers
   *    name, acct, desc      — raw strings (will be encoded)
   *    vk, invoiceName       — invoice voucher key and payee name
   *
   *  year and month are optional modifiers on name/acct/desc to
   *  produce a date-scoped permalink. On the permalink page, presence
   *  of year+month alongside name/acct/desc means "filter to that
   *  period"; presence of year alone on name/acct/desc means "filter
   *  to that year". Standalone year or year+month means the year/month
   *  drill-down itself. */
  function buildPermalinkUrl(params) {
    const p = new URLSearchParams();
    if (params.vk) {
      p.set("vk",   params.vk);
      p.set("name", params.invoiceName || "");
    } else if (params.desc && params.name) {
      // ACH/WIR breakdown detail: filter by description within a named payee
      p.set("name", params.name);
      p.set("desc", params.desc);
      if (params.year)  p.set("year",  params.year);
      if (params.month) p.set("month", params.month);
    } else if (params.acct && params.name) {
      // ACH/WIR breakdown detail: filter by account within a named payee
      p.set("name", params.name);
      p.set("acct", params.acct);
      if (params.year)  p.set("year",  params.year);
      if (params.month) p.set("month", params.month);
    } else if (params.desc) {
      p.set("desc",  params.desc);
      if (params.year)  p.set("year",  params.year);
      if (params.month) p.set("month", params.month);
    } else if (params.acct) {
      p.set("acct",  params.acct);
      if (params.year)  p.set("year",  params.year);
      if (params.month) p.set("month", params.month);
    } else if (params.name) {
      p.set("name",  params.name);
      if (params.year)  p.set("year",  params.year);
      if (params.month) p.set("month", params.month);
    } else if (params.month) {
      p.set("year",  params.year);
      p.set("month", params.month);
    } else if (params.year) {
      p.set("year",  params.year);
    }
    return `${PERMALINK_BASE}?${p.toString()}`;
  }

  /** Set the modal footer to show the permalink for the current view.
   *  Clicking the URL copies it to clipboard and briefly shows "Copied ✓". */
  function setModalFooter(params) {
    const footer  = document.getElementById("pal-modal-footer");
    const label   = document.getElementById("pal-modal-footer-label");
    const urlEl   = document.getElementById("pal-modal-footer-url");
    const copyBtn = document.getElementById("pal-modal-footer-copy");
    if (!footer || !urlEl) return;

    const url = buildPermalinkUrl(params);
    urlEl.href        = url;
    urlEl.textContent = url;
    // Link opens in new tab via target=_blank on the <a> element.
    // No onclick on the link itself — let it navigate normally.

    function doCopy() {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
          label.textContent = "Copied \u2713";
          setTimeout(() => { label.textContent = "Permalink:"; }, 2000);
        });
      } else {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        label.textContent = "Copied \u2713";
        setTimeout(() => { label.textContent = "Permalink:"; }, 2000);
      }
    }

    if (copyBtn) copyBtn.onclick = doCopy;
  }

  async function openYear(year) {
    openModal(`Fiscal Year ${year}`);
    setModalChart(null);
    renderTable([], standardColumns());

    const records = await fetchYearRecords(year);
    const monthTotals = sumByMonth(records);
    const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    setModalChart({
      type: "bar",
      data: {
        labels: monthLabels,
        datasets: [{
          label: `${year} spend by month`,
          data: monthTotals,
          backgroundColor: "#2f7da0",
          borderRadius: 4,
        }],
      },
      options: baseChartOptions("Spend by month"),
    });

    renderTable(records, standardColumns());
    setModalFooter({ year });
  }

  /** Month click: breakdown-by-payee chart + table of every record that month. */
  async function openMonth(year, month) {
    const label = `${["", "January", "February", "March", "April", "May", "June", "July", "August",
      "September", "October", "November", "December"][month]} ${year}`;
    openModal(label);
    setModalChart(null);
    renderTable([], standardColumns());

    const records = await fetchRecords(`${DATA_ROOT}/BY_YEAR/${year}/${monthKey(year, month)}.json`);
    const byPayee = sumByKey(records, (r) => (r.name || "Unknown").trim(), 8);

    setModalChart({
      type: "doughnut",
      data: {
        labels: byPayee.map(([k]) => k),
        datasets: [{
          data: byPayee.map(([, v]) => v),
          backgroundColor: CHART_PALETTE,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          // On a narrow phone, a right-side legend competing for
          // horizontal space with the pie itself makes both unreadably
          // small inside the modal's fixed-height chart wrap -- bottom
          // placement lets the pie use the full available width and
          // the legend wrap onto its own line(s) underneath instead.
          legend: window.matchMedia("(max-width: 430px)").matches
            ? { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } }
            : { position: "right", labels: { boxWidth: 12, font: { size: 11 } } },
          title: { display: true, text: "Top payees this month", font: { size: 13, weight: "600" } },
        },
      },
    });

    renderTable(records, standardColumns());
    setModalFooter({ year, month });
  }

  /** Payee click: line chart of spend over time + table of all their records.
   *  monthKeysCsv is a comma-joined string of "YYYY-MM" keys (from
   *  L3 summary.json) known to have at least one record for this payee.
   *  Passed as a plain comma-joined string rather than a JSON array
   *  literal because embedding a tojson'd array directly inside an HTML
   *  onclick="" attribute collides with the attribute's own quoting.
   *
   *  yearLabel is optional. When the caller already knows the records
   *  are scoped to a single year (e.g. the pie-chart legend rows, which
   *  pass only that year's month keys), pass the year so the modal
   *  title/chart label can say "VENDOR A -- 2026" instead of just
   *  "VENDOR A" -- without it, the title would look identical whether
   *  showing all-history (the sidebar's Top Payees) or just one year
   *  (the pie legend), even though the underlying data scope differs.
   *  Omit it (or pass null/undefined) for all-history call sites. */
  async function openName(rawName, monthKeysCsv, yearLabel) {
    const title = yearLabel ? `${rawName} \u2014 ${yearLabel}` : rawName;
    openModal(title);
    setModalChart(null);
    renderTable([], standardColumns());

    const monthKeys = (monthKeysCsv || "").split(",").filter(Boolean);
    const basePath = `${DATA_ROOT}/BY_NAME/${sanitizeForPath(rawName)}`;
    const records = await fetchAllMonths(basePath, monthKeys);
    const series = sumByYearMonth(records);

    setModalChart({
      type: "line",
      data: {
        labels: series.map(([k]) => k),
        datasets: [{
          label: `${title} -- spend over time`,
          data: series.map(([, v]) => v),
          borderColor: "#16365b",
          backgroundColor: "rgba(22,54,91,0.08)",
          fill: true,
          tension: 0.25,
          pointRadius: 3,
        }],
      },
      options: baseChartOptions("Spend over time"),
    });

    renderTable(records, standardColumns());
    setModalFooter({ name: rawName });
  }

  /** Account code click: line chart of spend over time + table of all
   *  its records. monthKeysCsv: see openName's note on why this is a
   *  comma-joined string rather than an array. yearLabel: see openName's
   *  note -- same optional year-qualification, for the same reason. */
  async function openAcct(alt, monthKeysCsv, yearLabel) {
    const title = yearLabel ? `Account ${alt} \u2014 ${yearLabel}` : `Account ${alt}`;
    openModal(title);
    setModalChart(null);
    renderTable([], standardColumns());

    const monthKeys = (monthKeysCsv || "").split(",").filter(Boolean);
    const basePath = `${DATA_ROOT}/BY_ACCT/${sanitizeForPath(alt)}`;
    const records = await fetchAllMonths(basePath, monthKeys);
    const series = sumByYearMonth(records);

    setModalChart({
      type: "line",
      data: {
        labels: series.map(([k]) => k),
        datasets: [{
          label: `${title} -- spend over time`,
          data: series.map(([, v]) => v),
          borderColor: "#2f7da0",
          backgroundColor: "rgba(47,125,160,0.08)",
          fill: true,
          tension: 0.25,
          pointRadius: 3,
        }],
      },
      options: baseChartOptions("Spend over time"),
    });

    renderTable(records, standardColumns());
    setModalFooter({ acct: alt });
  }

  /** Description click: line chart of spend over time + table of all
   *  its records. monthKeysCsv: see openName's note on why this is a
   *  comma-joined string rather than an array. Reads from
   *  DATA/L1/BY_DESCRIPTION/, added to parse_pa_checkbook.py alongside
   *  BY_NAME/BY_ACCT specifically to support this drill-down. */
  async function openDescription(description, monthKeysCsv) {
    openModal(description);
    setModalChart(null);
    renderTable([], standardColumns());

    const monthKeys = (monthKeysCsv || "").split(",").filter(Boolean);
    const basePath = `${DATA_ROOT}/BY_DESCRIPTION/${sanitizeForPath(description)}`;
    const records = await fetchAllMonths(basePath, monthKeys);
    const series = sumByYearMonth(records);

    setModalChart({
      type: "line",
      data: {
        labels: series.map(([k]) => k),
        datasets: [{
          label: `${description} -- spend over time`,
          data: series.map(([, v]) => v),
          borderColor: "#6b8e23",
          backgroundColor: "rgba(107,142,35,0.08)",
          fill: true,
          tension: 0.25,
          pointRadius: 3,
        }],
      },
      options: baseChartOptions("Spend over time"),
    });

    renderTable(records, standardColumns());
    setModalFooter({ desc: description });
  }

  function baseChartOptions(titleText) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: titleText, font: { size: 13, weight: "600" } },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => "$" + Number(v).toLocaleString() },
        },
      },
    };
  }

  // --------------------------------------------------------------------
  // Trailing-365-day overview chart and the two current-year pie charts
  // (main page, not in a modal). All three are built from data already
  // embedded in the page by the Jinja template (window.PALedgerData),
  // no fetch required -- unlike the modal drill-downs, these never need
  // to hit DATA/L1/ since the template precomputes exactly what they need.
  // --------------------------------------------------------------------

  function renderTrailing365Chart(canvasId, series) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !series || series.length === 0) return;

    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: series.map((p) => p.month),
        datasets: [{
          label: "Spend (trailing 12 months)",
          data: series.map((p) => p.amount),
          borderColor: "#2f7da0",
          backgroundColor: "rgba(47,125,160,0.10)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5,
        }],
      },
      options: baseChartOptions("Spend by month, trailing 12 months"),
    });
  }

  // Registry of created pie/doughnut chart instances, keyed by canvas id,
  // so highlightPieSlice()/clearPieHighlight() (called from the legend
  // table's onmouseenter/onmouseleave) can reach the right Chart.js
  // instance later without re-querying or re-creating it.
  const pieChartRegistry = {};

  /** Renders a top-N doughnut/pie chart from pre-aggregated {label, amount}
   *  entries embedded by the template (current-year top payees/accounts).
   *  Used by both new 2nd-summary pie-chart cards -- same rendering logic,
   *  different data and canvas id. No legend (legend: false) since the
   *  adjacent HTML table in the template already serves as the legend --
   *  a second, separate Chart.js-drawn legend would just duplicate it. */
  /** Renders a top-N doughnut/pie chart from pre-aggregated {label, amount}
   *  entries. `palette` is optional and defaults to the shared
   *  CHART_PALETTE -- pass WIR_CHART_PALETTE explicitly for the WIR
   *  cards so their slices don't visually match every other pie chart
   *  on the page color-for-color. No legend (legend: false) since the
   *  adjacent HTML table in the template already serves as the legend. */
  function renderPieChart(canvasId, entries, palette) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !entries || entries.length === 0) return;

    const chart = new Chart(canvas.getContext("2d"), {
      type: "doughnut",
      data: {
        labels: entries.map((e) => e.label),
        datasets: [{
          data: entries.map((e) => e.amount),
          backgroundColor: palette || CHART_PALETTE,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
      },
    });

    pieChartRegistry[canvasId] = chart;
  }

  /** Highlights one slice of a previously-rendered pie/doughnut chart,
   *  called from the legend table row's onmouseenter. Sets both the
   *  active element (which triggers the segment-offset grow effect) AND
   *  the tooltip's active element (so the tooltip appears over the
   *  highlighted slice), per Chart.js 4's documented programmatic hover
   *  API -- setActiveElements alone is not sufficient to show the tooltip;
   *  chart.tooltip.setActiveElements must also be called. */
  function highlightPieSlice(canvasId, sliceIndex) {
    const chart = pieChartRegistry[canvasId];
    if (!chart) return;
    const activeEl = [{ datasetIndex: 0, index: sliceIndex }];
    chart.setActiveElements(activeEl);
    if (chart.tooltip) {
      chart.tooltip.setActiveElements(activeEl, { x: 0, y: 0 });
    }
    chart.update();
  }

  /** Clears any active-element highlight and tooltip on a chart, called
   *  from the legend table row's onmouseleave. */
  function clearPieHighlight(canvasId) {
    const chart = pieChartRegistry[canvasId];
    if (!chart) return;
    chart.setActiveElements([]);
    if (chart.tooltip) {
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    }
    chart.update();
  }

  // --------------------------------------------------------------------
  // ACH/Grant breakdown by description and by account -- two pie+legend
  // cards below the "ACH / Grant Disbursements by Year" table.
  //
  // Unlike the Top Payees/Top Accounts pie cards (server-rendered by
  // the Jinja template from L2 summary data), this breakdown needs raw
  // per-record description/alt fields that only exist in L1's
  // BY_NAME/ACH_PAYEE/*.json files -- L2's ach_payee only has totals by
  // month. So this fetches ACH PAYEE's full history ONCE on page load,
  // computes both top-20 rankings client-side, and keeps the raw
  // records array in memory afterward so a legend-row click can filter
  // it directly for the drill-down modal -- no second fetch needed.
  // --------------------------------------------------------------------

  let achRecordsCache = null;

  /** Builds the <tbody> rows for one ACH legend table: swatch, name
   *  (clickable, wired for hover-highlight), amount. Mirrors the
   *  server-rendered legend markup in the template (Top Payees/Top
   *  Accounts pie cards) but built in JS since this data isn't
   *  available to Jinja at render time. */
  function renderAchLegendRows(tbodyEl, entries, canvasId, onRowClick, palette) {
    tbodyEl.innerHTML = "";
    if (entries.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="3" class="pal-empty">No ACH/Grant records found.</td>';
      tbodyEl.appendChild(tr);
      return;
    }

    const activePalette = palette || CHART_PALETTE;

    entries.forEach(([label, amount], index) => {
      const tr = document.createElement("tr");
      tr.className = "pal-pie-legend-row";

      const swatchTd = document.createElement("td");
      const swatch = document.createElement("span");
      swatch.className = "pal-swatch";
      swatch.style.backgroundColor = activePalette[index % activePalette.length];
      swatchTd.appendChild(swatch);

      const labelTd = document.createElement("td");
      labelTd.className = "pal-link-cell";
      labelTd.textContent = label;

      const amountTd = document.createElement("td");
      amountTd.className = "pal-amount-cell";
      amountTd.textContent = formatAmount(amount);

      tr.appendChild(swatchTd);
      tr.appendChild(labelTd);
      tr.appendChild(amountTd);

      tr.addEventListener("mouseenter", () => highlightPieSlice(canvasId, index));
      tr.addEventListener("mouseleave", () => clearPieHighlight(canvasId));
      tr.addEventListener("click", () => onRowClick(label));

      tbodyEl.appendChild(tr);
    });
  }

  /** Opens the drill-down modal for one description or account WITHIN
   *  the already-fetched ACH PAYEE record set -- filters the in-memory
   *  array rather than fetching again, per the requirement that this
   *  view reuse data already pulled to build the pie charts. This is
   *  deliberately narrower than openDescription()/openAcct() (which
   *  show that description/account across ALL payees): this view is
   *  ACH-only, matching what the pie chart itself represents. */
  function openAchBreakdownDetail(filterField, filterValue) {
    const title = filterField === "description"
      ? `${filterValue} (ACH/Grant only)`
      : `Account ${filterValue} (ACH/Grant only)`;
    openModal(title);

    const records = (achRecordsCache || []).filter((r) => {
      if (filterField === "description") return (r.description || "").trim() === filterValue;
      return (r.alt || "") === filterValue;
    });

    const series = sumByYearMonth(records);
    setModalChart({
      type: "line",
      data: {
        labels: series.map(([k]) => k),
        datasets: [{
          label: `${title} -- spend over time`,
          data: series.map(([, v]) => v),
          borderColor: "#16365b",
          backgroundColor: "rgba(22,54,91,0.08)",
          fill: true,
          tension: 0.25,
          pointRadius: 3,
        }],
      },
      options: baseChartOptions("Spend over time"),
    });

    renderTable(records, standardColumns());
    setModalFooter(filterField === "description"
      ? { name: "ACH PAYEE", desc: filterValue }
      : { name: "ACH PAYEE", acct: filterValue });
  }

  /** Fetches ACH PAYEE's complete record history once (using the same
   *  DATA_ROOT/BY_NAME path every other payee drill-down uses), then
   *  builds and renders both top-20 pie+legend cards from that single
   *  fetch. monthKeysCsv covers every month with ACH activity across
   *  all years -- the template passes data.ach_payee.months.keys()
   *  directly, the same all-years month list already used to populate
   *  the "ACH / Grant Disbursements by Year" table above these cards. */
  async function initAchBreakdown(monthKeysCsv) {
    const descTbody = document.querySelector("#pal-pie-ach-description-legend tbody");
    const acctTbody = document.querySelector("#pal-pie-ach-account-legend tbody");
    if (!descTbody || !acctTbody) return;

    const monthKeys = (monthKeysCsv || "").split(",").filter(Boolean);
    const basePath = `${DATA_ROOT}/BY_NAME/${sanitizeForPath("ACH PAYEE")}`;
    const records = await fetchAllMonths(basePath, monthKeys);
    achRecordsCache = records;

    const byDescription = sumByKey(records, (r) => (r.description || "Unknown").trim(), 20);
    const byAccount = sumByKey(records, (r) => r.alt || "Unknown", 20);

    if (window.Chart) {
      renderPieChart("pal-pie-ach-description-chart", byDescription.map(([label, amount]) => ({ label, amount })));
      renderPieChart("pal-pie-ach-account-chart", byAccount.map(([label, amount]) => ({ label, amount })));
    }

    renderAchLegendRows(descTbody, byDescription, "pal-pie-ach-description-chart",
      (label) => openAchBreakdownDetail("description", label));
    renderAchLegendRows(acctTbody, byAccount, "pal-pie-ach-account-chart",
      (label) => openAchBreakdownDetail("alt", label));
  }

  // --------------------------------------------------------------------
  // WIR PAYEE breakdown -- sidebar card with a radar (spend by calendar
  // month, all years) + two pie+legend cards (by description, by
  // account), all driven by one fetch. "WIR PAYEE" has no dedicated L2
  // field the way ACH PAYEE does (data.ach_payee) -- it's just a
  // regular entry in data.by_name, so its month-keys come from there
  // via the template, the same way any other sidebar payee's
  // drill-down gets its month list.
  // --------------------------------------------------------------------

  let wirRecordsCache = null;

  /** Builds the <tbody> rows for a SLIM 2-column legend (Name, Total --
   *  no swatch column), matching the existing sidebar-table style used
   *  by Top Payees/Top Accounts immediately above this card, per the
   *  requirement that the WIR card's legends "match the slim 2-column
   *  table design" rather than the wider swatch+name+amount style used
   *  by the ACH breakdown cards. Hover-highlight/click still work
   *  identically -- they only need the row's index into `entries` to
   *  map back to the correct pie slice, not a visible swatch. */
  function renderSlimLegendRows(tbodyEl, entries, canvasId, onRowClick, emptyLabel) {
    tbodyEl.innerHTML = "";
    if (entries.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="2" class="pal-empty">${emptyLabel}</td>`;
      tbodyEl.appendChild(tr);
      return;
    }

    entries.forEach(([label, amount], index) => {
      const tr = document.createElement("tr");

      const labelTd = document.createElement("td");
      const link = document.createElement("span");
      link.className = "pal-link";
      link.textContent = label;
      labelTd.appendChild(link);

      const amountTd = document.createElement("td");
      amountTd.className = "pal-amount-cell";
      amountTd.textContent = formatAmount(amount);

      tr.appendChild(labelTd);
      tr.appendChild(amountTd);

      tr.addEventListener("mouseenter", () => highlightPieSlice(canvasId, index));
      tr.addEventListener("mouseleave", () => clearPieHighlight(canvasId));
      tr.addEventListener("click", () => onRowClick(label));

      tbodyEl.appendChild(tr);
    });
  }

  /** Drill-down for a WIR legend-row click -- filters the already-
   *  fetched wirRecordsCache in memory, exactly mirroring
   *  openAchBreakdownDetail(); no second fetch. */
  function openWirBreakdownDetail(filterField, filterValue) {
    const title = filterField === "description"
      ? `${filterValue} (WIR only)`
      : `Account ${filterValue} (WIR only)`;
    openModal(title);

    const records = (wirRecordsCache || []).filter((r) => {
      if (filterField === "description") return (r.description || "").trim() === filterValue;
      return (r.alt || "") === filterValue;
    });

    const series = sumByYearMonth(records);
    setModalChart({
      type: "line",
      data: {
        labels: series.map(([k]) => k),
        datasets: [{
          label: `${title} -- spend over time`,
          data: series.map(([, v]) => v),
          borderColor: "#7a6ba0",
          backgroundColor: "rgba(122,107,160,0.08)",
          fill: true,
          tension: 0.25,
          pointRadius: 3,
        }],
      },
      options: baseChartOptions("Spend over time"),
    });

    renderTable(records, standardColumns());
    setModalFooter(filterField === "description"
      ? { name: "WIR PAYEE", desc: filterValue }
      : { name: "WIR PAYEE", acct: filterValue });
  }

  /** WIR PAYEE equivalent of initAchBreakdown() -- one fetch of WIR
   *  Payee's full record history, then builds three visuals from that
   *  single fetch: a calendar-month radar (seasonal pattern, all
   *  years) and two pie+legend cards (by description, by account)
   *  using the slim 2-column legend style. */
  async function initWirBreakdown(monthKeysCsv) {
    const descTbody = document.querySelector("#pal-wir-description-legend tbody");
    const acctTbody = document.querySelector("#pal-wir-account-legend tbody");
    if (!descTbody || !acctTbody) return;

    const monthKeys = (monthKeysCsv || "").split(",").filter(Boolean);
    if (monthKeys.length === 0) {
      // No WIR PAYEE activity in this dataset at all -- show empty
      // states rather than leaving "Loading..." displayed forever.
      renderSlimLegendRows(descTbody, [], "pal-wir-description-chart", () => {}, "No WIR PAYEE records found.");
      renderSlimLegendRows(acctTbody, [], "pal-wir-account-chart", () => {}, "No WIR PAYEE records found.");
      return;
    }

    const basePath = `${DATA_ROOT}/BY_NAME/${sanitizeForPath("WIR PAYEE")}`;
    const records = await fetchAllMonths(basePath, monthKeys);
    wirRecordsCache = records;

    if (window.Chart) {
      renderRadarChart("pal-wir-radar-chart", sumByCalendarMonth(records));
    }

    const byDescription = sumByKey(records, (r) => (r.description || "Unknown").trim(), 20);
    const byAccount = sumByKey(records, (r) => r.alt || "Unknown", 20);

    if (window.Chart) {
      renderPieChart("pal-wir-description-chart", byDescription.map(([label, amount]) => ({ label, amount })), WIR_CHART_PALETTE);
      renderPieChart("pal-wir-account-chart", byAccount.map(([label, amount]) => ({ label, amount })), WIR_CHART_PALETTE);
    }

    renderSlimLegendRows(descTbody, byDescription, "pal-wir-description-chart",
      (label) => openWirBreakdownDetail("description", label), "No WIR PAYEE records found.");
    renderSlimLegendRows(acctTbody, byAccount, "pal-wir-account-chart",
      (label) => openWirBreakdownDetail("alt", label), "No WIR PAYEE records found.");
  }

  /** Fetches and sanitizes the L1 invoice HTML for a given VK + payee name.
   *  Returns the sanitized HTML string, or throws on fetch failure.
   *  Used by both openInvoiceModal and the inline expandable row. */
  async function fetchInvoiceHtml(vk, payeeName) {
    const payeeFolder = sanitizeForPath((payeeName || "").trim());
    const safeVk      = (vk || "").replace(/[^A-Za-z0-9._-]/g, "_");
    const url         = `${DATA_ROOT}/BY_INVOICE/${payeeFolder}/${safeVk}.html`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,iframe,form,input,button").forEach(el => el.remove());
    doc.querySelectorAll("*").forEach(el => {
      [...el.attributes].forEach(attr => {
        if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
      });
    });
    doc.querySelectorAll("a").forEach(a => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });

    return doc.body ? doc.body.innerHTML : html;
  }

  /** Toggle an expandable invoice row below `parentTr`.
   *  If the row is already open, collapse it. Otherwise fetch the invoice
   *  from L1 and inject it into a new <tr> spanning all columns. */
  async function toggleInvoiceRow(parentTr, vk, payeeName, colCount) {
    // Check if an expanded row already exists immediately after parentTr.
    const existing = parentTr.nextElementSibling;
    if (existing && existing.classList.contains("pal-invoice-row")) {
      existing.remove();
      parentTr.classList.remove("pal-invoice-row-open");
      return;
    }

    parentTr.classList.add("pal-invoice-row-open");

    const expandTr = document.createElement("tr");
    expandTr.className = "pal-invoice-row";

    const td = document.createElement("td");
    td.colSpan = colCount;
    td.className = "pal-invoice-row-cell";

    // Loading state
    const container = document.createElement("div");
    container.className = "pal-invoice-content pal-readme-loading";
    container.textContent = "Loading invoice\u2026";

    // X close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "pal-invoice-row-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", () => {
      expandTr.remove();
      parentTr.classList.remove("pal-invoice-row-open");
    });

    td.appendChild(closeBtn);
    td.appendChild(container);
    expandTr.appendChild(td);

    // Insert immediately after parentTr
    parentTr.insertAdjacentElement("afterend", expandTr);

    try {
      const html = await fetchInvoiceHtml(vk, payeeName);
      container.className = "pal-invoice-content";
      container.innerHTML = html;
    } catch (err) {
      container.className = "pal-invoice-content pal-readme-error";
      container.textContent = `Invoice not available: ${err.message}. ` +
        "The invoice file may not have been fetched yet \u2014 run the parse script to acquire recent invoices.";
    }
  }

  /** Fetches DATA/L1/BY_INVOICE/<sanitized-payee>/<vk>.html -- the
   *  pre-sanitized invoice file written by parse_pa_checkbook.py --
   *  and displays its content in #pal-modal. The file has already been
   *  sanitized server-side by BeautifulSoup before being committed to
   *  the repo, so no client-side sanitization pass is needed here.
   *  An additional lightweight strip of any surviving on* handlers and
   *  <script> tags is applied as a defence-in-depth measure before
   *  injecting into innerHTML. */
  async function openInvoiceModal(vk, payeeName) {
    openModal(payeeName || "Invoice Detail");

    const chartWrap = document.querySelector("#pal-modal .pal-modal-chart-wrap");
    if (chartWrap) chartWrap.style.display = "none";

    const tableEl      = document.getElementById("pal-modal-table");
    const paginationEl = document.getElementById("pal-modal-pagination");
    if (tableEl)      tableEl.style.display      = "none";
    if (paginationEl) paginationEl.style.display = "none";

    const tableWrap = document.querySelector("#pal-modal .pal-modal-table-wrap");
    if (!tableWrap) return;

    const container = document.createElement("div");
    container.className = "pal-invoice-content pal-readme-loading";
    container.textContent = "Loading invoice\u2026";
    tableWrap.appendChild(container);

    try {
      const html = await fetchInvoiceHtml(vk, payeeName);
      container.className = "pal-invoice-content";
      container.innerHTML = html;
    } catch (err) {
      container.className = "pal-invoice-content pal-readme-error";
      container.textContent = `Invoice not available: ${err.message}. ` +
        "The invoice file may not have been fetched yet -- run the parse script to acquire recent invoices.";
      return;
    }

    setModalFooter({ vk, invoiceName: payeeName });
  }

  // --------------------------------------------------------------------
  // Per-description pie chart breakdowns (top payees + top accounts)
  // These charts are driven entirely by data pre-embedded in the page
  // by the Jinja template (PALedgerData.descriptionBreakdowns), which
  // in turn comes from the new top_payees/top_accounts fields added to
  // each by_description entry in the L2 summary by report_pa_checkbook.py.
  // No fetch is required -- all data is available at DOMContentLoaded.
  // --------------------------------------------------------------------

  /** Renders all per-description pie+legend card pairs. `breakdowns` is
   *  an array of { slug, description, payees: [[name,amt],...],
   *  accounts: [[alt,amt],...] } objects embedded by the template for
   *  the top 10 descriptions. Each pair gets a unique palette from
   *  DESCRIPTION_PALETTES so adjacent subsections are visually distinct. */
  function initDescriptionBreakdowns(breakdowns) {
    if (!breakdowns || breakdowns.length === 0) return;

    breakdowns.forEach((item, i) => {
      const palette = DESCRIPTION_PALETTES[i % DESCRIPTION_PALETTES.length];
      const payeeCanvasId = `pal-desc-payees-chart-${item.slug}`;

      // Convert payees array (objects with name/amount/monthKeys) into
      // the [label, amount] pairs renderPieChart and renderAchLegendRows expect
      const payeeEntries = item.payees.map((p) => [p.name, p.amount]);

      if (window.Chart) {
        renderPieChart(
          payeeCanvasId,
          payeeEntries.map(([label, amount]) => ({ label, amount: parseFloat(amount) })),
          palette
        );
      }

      const payeeTbody = document.querySelector(`#pal-desc-payees-legend-${item.slug} tbody`);
      if (payeeTbody) {
        renderAchLegendRows(
          payeeTbody,
          payeeEntries,
          payeeCanvasId,
          // Pass the payee's own all-time month-keys so openName fetches
          // the right L1 files. Without this, an empty string was passed
          // and fetchAllMonths returned zero records (modal appeared blank).
          (name) => {
            const payeeObj = item.payees.find((p) => p.name === name);
            openName(name, payeeObj ? payeeObj.monthKeys : "");
          },
          palette
        );
      }
    });
  }

  /** Renders the all-history monthly timeline -- a line chart spanning
   *  every month from the start of the dataset to the report date,
   *  with every 4th month labeled on the x-axis to keep the chart
   *  readable across potentially 50+ months of history. Labels start
   *  from the first month (index 0) so they land on consistent
   *  quarters regardless of where the dataset begins. */
  function renderTimelineChart(canvasId, series) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !series || series.length === 0) return;

    const labels = series.map((p) => p.month);
    const values = series.map((p) => p.amount);

    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Monthly spend",
          data: values,
          borderColor: "#2f7da0",
          backgroundColor: "rgba(47,125,160,0.07)",
          fill: true,
          tension: 0.3,
          // Visible circle markers at every data point, matching the
          // Fiscal Year trend chart's pointRadius/pointHoverRadius
          // (renderTrailing365Chart above) so hover locations are
          // equally obvious on both charts.
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: "#2f7da0",
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => " $" + Number(ctx.parsed.y).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
            },
          },
        },
        scales: {
          x: {
            ticks: {
              // Show every 4th label starting from index 0, hide the
              // rest. Angled (-45deg) so labels don't overlap each
              // other across 50+ months of history -- horizontal
              // labels at this density collide regardless of spacing.
              maxRotation: 45,
              minRotation: 45,
              callback: function(val, index) {
                return index % 4 === 0 ? this.getLabelForValue(val) : null;
              },
              autoSkip: false,
            },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            ticks: {
              callback: (v) => "$" + Number(v).toLocaleString("en-US", { notation: "compact" }),
            },
          },
        },
      },
    });
  }

  /** Mobile-only horizontal-bar version of the all-history timeline.
   *  Same data as renderTimelineChart, but as one horizontal bar per
   *  month rather than a compressed line -- avoids cramming 50+ months
   *  into a phone's limited width by instead growing DOWNWARD (one row
   *  per month) inside a fixed-height, vertically-scrollable container
   *  (.pal-timeline-bar-wrap, overflow-y:auto in CSS).
   *
   *  Chart.js's `maintainAspectRatio: false` only controls how the
   *  chart fills ITS canvas -- it doesn't make a short container scroll
   *  to fit more bars. To get genuinely readable per-month bars (not
   *  squished into a fixed 480px regardless of month count), the
   *  canvas's own pixel height is set explicitly here, proportional to
   *  the number of months, and the canvas is allowed to be taller than
   *  its scroll-container -- that's what makes the container scroll. */
  function renderTimelineBarChart(canvasId, series) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !series || series.length === 0) return;

    const labels = series.map((p) => p.month);
    const values = series.map((p) => p.amount);

    // ~28px per bar is comfortable for a month label + bar at mobile
    // font sizes; below ~10 months just fill the visible container
    // height instead of leaving a tiny chart.
    const pxPerBar = 28;
    canvas.style.height = Math.max(480, labels.length * pxPerBar) + "px";

    new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Monthly spend",
          data: values,
          backgroundColor: "#9dddee",
          borderColor: "#16365b",
          borderWidth: 1,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => " $" + Number(ctx.parsed.x).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: {
              callback: (v) => "$" + Number(v).toLocaleString("en-US", { notation: "compact" }),
              font: { size: 9 },
            },
          },
          y: {
            ticks: { font: { size: 10 } },
            grid: { display: false },
          },
        },
      },
    });
  }

  /** Renders the all-years seasonal radar chart into the combined-info
   *  card, showing total spend per calendar month (Jan–Dec) summed
   *  across all years in the dataset. */
  function renderRadarChart(canvasId, monthlyTotals) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !monthlyTotals || monthlyTotals.length !== 12) return;

    new Chart(canvas.getContext("2d"), {
      type: "radar",
      data: {
        labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        datasets: [{
          label: "Spend by month (all years)",
          data: monthlyTotals,
          borderColor: "#2f7da0",
          backgroundColor: "rgba(47,125,160,0.15)",
          pointBackgroundColor: "#16365b",
          pointRadius: 4,
          pointHoverRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          r: {
            beginAtZero: true,
            ticks: {
              callback: (v) => "$" + Number(v).toLocaleString("en-US", { notation: "compact" }),
              font: { size: 9 },
            },
            pointLabels: { font: { size: 11, weight: "600" } },
          },
        },
      },
    });
  }

  // --------------------------------------------------------------------
  // Common Descriptions pager (inline, not a modal) -- a simple
  // standalone show/hide pager over rows already rendered into the page
  // by the template (every description, not just a top-N cutoff). No
  // fetch, no sorting -- the rows are pre-sorted server-side; this just
  // shows 10 at a time and provides Prev/Next + page-number controls,
  // reusing the same .pal-pagination button markup/classes as the modal
  // pager for visual consistency, but as a much smaller standalone
  // implementation (no sort-by-column, no fetch).
  // --------------------------------------------------------------------

  function initDescriptionsPager(tableId, paginationId, pageSize) {
    const table = document.getElementById(tableId);
    const paginationEl = document.getElementById(paginationId);
    if (!table || !paginationEl) return;

    const rows = Array.from(table.querySelectorAll("tbody tr.pal-pager-row"));
    if (rows.length === 0) return;

    let currentPage = 1;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));

    function renderPage() {
      const start = (currentPage - 1) * pageSize;
      const end = start + pageSize;
      rows.forEach((row, i) => {
        row.style.display = (i >= start && i < end) ? "" : "none";
      });
      renderPagination();
    }

    function renderPagination() {
      paginationEl.innerHTML = "";

      const makeBtn = (label, page, disabled, active) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.disabled = !!disabled;
        if (active) btn.className = "pal-page-active";
        btn.addEventListener("click", () => {
          currentPage = page;
          renderPage();
        });
        return btn;
      };

      paginationEl.appendChild(makeBtn("\u2039 Prev", currentPage - 1, currentPage === 1));

      const maxButtons = 7;
      let startPage = Math.max(1, currentPage - 3);
      let endPage = Math.min(totalPages, startPage + maxButtons - 1);
      startPage = Math.max(1, endPage - maxButtons + 1);

      for (let p = startPage; p <= endPage; p++) {
        paginationEl.appendChild(makeBtn(String(p), p, false, p === currentPage));
      }

      paginationEl.appendChild(makeBtn("Next \u203a", currentPage + 1, currentPage === totalPages));

      const summary = document.createElement("span");
      summary.className = "pal-page-summary";
      summary.textContent = `${rows.length.toLocaleString()} description${rows.length === 1 ? "" : "s"}`;
      paginationEl.appendChild(summary);
    }

    renderPage();
  }

  // --------------------------------------------------------------------
  // README modal -- fetches the raw markdown from GitHub, converts it
  // to HTML using marked.js (loaded lazily on first call so pages that
  // never open the README don't pay the load cost), and displays it in
  // the existing #pal-modal. The modal's chart area is hidden since
  // this is a document view, not a data drill-down.
  // --------------------------------------------------------------------

  const README_URL =
    "https://raw.githubusercontent.com/keystoneledger/keystoneledger.github.io/main/README.md";

  /** Load marked.js from CDN lazily (only when the README is first
   *  opened). Returns a Promise that resolves to the global `marked`
   *  object. If marked.js is already on the page, resolves immediately. */
  function loadMarked() {
    if (window.marked) return Promise.resolve(window.marked);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js";
      script.onload = () => resolve(window.marked);
      script.onerror = () => reject(new Error("marked.js failed to load"));
      document.head.appendChild(script);
    });
  }

  /** Opens the existing #pal-modal with the rendered README content.
   *  Replaces whatever the modal was showing (chart + table) with a
   *  scrollable document view. Calling any other openX() function
   *  afterward will restore the normal chart+table layout.
   *
   *  Call this from the README button's onclick, replacing the existing
   *  href/target="_blank" behaviour:
   *    onclick="event.preventDefault(); PALedger.openReadme();"
   */
  async function openReadme() {
    openModal("About This Data");

    // Hide the chart canvas and the existing table/pagination -- this
    // modal shows a document, not a data table. Crucially, we HIDE them
    // rather than remove or replace them: openModal() above already
    // cleared any previous README content, so the table and pagination
    // elements are clean and just need to be out of sight while the
    // README is showing. They'll be un-hidden by openModal() the next
    // time any drill-down is opened.
    const chartWrap = document.querySelector("#pal-modal .pal-modal-chart-wrap");
    if (chartWrap) chartWrap.style.display = "none";

    const tableEl = document.getElementById("pal-modal-table");
    const paginationEl = document.getElementById("pal-modal-pagination");
    if (tableEl) tableEl.style.display = "none";
    if (paginationEl) paginationEl.style.display = "none";

    const tableWrap = document.querySelector("#pal-modal .pal-modal-table-wrap");
    if (!tableWrap) return;

    // Inject a README container div ALONGSIDE the existing table/pagination
    // (not replacing them). openModal() removes this div on the next open.
    const readmeEl = document.createElement("div");
    readmeEl.className = "pal-readme-loading";
    readmeEl.textContent = "Loading\u2026";
    tableWrap.appendChild(readmeEl);

    let markdown, markedLib;
    try {
      [markdown, markedLib] = await Promise.all([
        fetch(README_URL, { cache: "no-store" }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        }),
        loadMarked(),
      ]);
    } catch (err) {
      readmeEl.className = "pal-readme-error";
      readmeEl.innerHTML =
        `Could not load the README: ${err.message}. ` +
        `<a href="${README_URL.replace("raw.githubusercontent.com", "github.com").replace("/main/", "/blob/main/")}" ` +
        `target="_blank" rel="noopener">Open on GitHub instead.</a>`;
      return;
    }

    const html =
      typeof markedLib.parse === "function"
        ? markedLib.parse(markdown)
        : markedLib(markdown);

    readmeEl.className = "pal-readme-body";
    readmeEl.innerHTML = html;

    readmeEl.querySelectorAll("a").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    });
  }

  // --------------------------------------------------------------------

  function init() {
    const cfg = window.PALedgerData || {};

    // Each chart render is independent: a failure in one (e.g. Chart.js
    // failed to load from its CDN due to a network block or ad blocker)
    // must never prevent the others from running.
    try {
      if (window.Chart && window.Chart.defaults) {
        window.Chart.defaults.font.family =
          "proxima-nova, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      }
    } catch (err) {
      console.warn("PALedger: Chart.js font default setup failed", err);
    }

    const chartJsAvailable = !!window.Chart;
    if (!chartJsAvailable) {
      console.warn("PALedger: Chart.js did not load; charts skipped.");
    }

    if (chartJsAvailable) {
      try {
        if (cfg.trailing365 && cfg.trailing365Canvas) {
          renderTrailing365Chart(cfg.trailing365Canvas, cfg.trailing365);
        }
      } catch (err) {
        console.warn("PALedger: trailing-365 chart failed to render", err);
      }

      try {
        if (cfg.piePayees && cfg.piePayeesCanvas) {
          renderPieChart(cfg.piePayeesCanvas, cfg.piePayees);
        }
      } catch (err) {
        console.warn("PALedger: top-payees pie chart failed to render", err);
      }

      try {
        if (cfg.pieAccounts && cfg.pieAccountsCanvas) {
          renderPieChart(cfg.pieAccountsCanvas, cfg.pieAccounts);
        }
      } catch (err) {
        console.warn("PALedger: top-accounts pie chart failed to render", err);
      }

      try {
        if (cfg.radarData && cfg.radarCanvas) {
          renderRadarChart(cfg.radarCanvas, cfg.radarData);
        }
      } catch (err) {
        console.warn("PALedger: radar chart failed to render", err);
      }

      try {
        if (cfg.timelineData) {
          // Matches the CSS breakpoint that swaps .pal-timeline-desktop-only
          // / .pal-timeline-mobile-only visibility (max-width: 430px) --
          // both must agree, or the visible canvas could end up with no
          // chart rendered into it. Checked once at load time rather than
          // on resize, since orientation/window changes mid-session are
          // an edge case not worth the complexity of tearing down and
          // rebuilding a Chart.js instance.
          const isMobileWidth = window.matchMedia("(max-width: 430px)").matches;
          if (isMobileWidth && cfg.timelineBarCanvas) {
            renderTimelineBarChart(cfg.timelineBarCanvas, cfg.timelineData);
          } else if (cfg.timelineCanvas) {
            renderTimelineChart(cfg.timelineCanvas, cfg.timelineData);
          }
        }
      } catch (err) {
        console.warn("PALedger: timeline chart failed to render", err);
      }
    }

    // Independent of the Chart.js-availability guard above: the legend
    // tables and click-through still work without Chart.js (only the
    // pie slices themselves don't render), so this is called
    // unconditionally -- initAchBreakdown() internally checks
    // window.Chart before calling renderPieChart.
    try {
      if (cfg.achMonthKeys) {
        initAchBreakdown(cfg.achMonthKeys);
      }
    } catch (err) {
      console.warn("PALedger: ACH breakdown failed to initialize", err);
    }

    // Per-description pie breakdown charts. Data is fully pre-embedded
    // by the template -- no fetch needed. Guarded same as ACH/WIR.
    try {
      if (cfg.descriptionBreakdowns) {
        initDescriptionBreakdowns(cfg.descriptionBreakdowns);
      }
    } catch (err) {
      console.warn("PALedger: description breakdowns failed to initialize", err);
    }

    // Same reasoning as initAchBreakdown above -- legends/click-through
    // work without Chart.js, only the charts themselves are skipped.
    // monthKeysCsv may legitimately be an empty string if this dataset
    // has no WIR PAYEE activity at all -- initWirBreakdown() handles
    // that by rendering empty-state legends rather than erroring.
    try {
      initWirBreakdown(cfg.wirMonthKeys);
    } catch (err) {
      console.warn("PALedger: WIR breakdown failed to initialize", err);
    }

    // Independent of Chart.js entirely -- the descriptions pager is
    // plain DOM show/hide, so it must run regardless of whether Chart.js
    // loaded. Previously this whole block sat after an `if (!window.Chart)
    // return;` guard, which meant a CDN/ad-blocker failure would have
    // silently skipped the pager too -- moved out of that branch so it's
    // unconditional.
    try {
      initDescriptionsPager("pal-descriptions-table", "pal-descriptions-pagination", 10);
    } catch (err) {
      console.warn("PALedger: descriptions pager failed to initialize", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);


  // --------------------------------------------------------------------
  // Permalink page initialisation
  // Called by permalink.html on DOMContentLoaded via PALedger.initPermalink().
  // All data fetch helpers and renderers are defined here so that any
  // change to paths, chart configs, or table columns only needs to be
  // made in dashboard.js, not in a separate inline script.
  // --------------------------------------------------------------------

  async function initPermalink() {
    "use strict";

    const titleEl      = document.getElementById("pal-permalink-title");
    const subtitleEl   = document.getElementById("pal-permalink-subtitle");
    const chartWrap    = document.getElementById("pal-permalink-chart-wrap");
    const chartCanvas  = document.getElementById("pal-permalink-chart");
    const invoiceWrap  = document.getElementById("pal-permalink-invoice-wrap");
    const tableWrap    = document.getElementById("pal-permalink-table-wrap");
    const tableEl      = document.getElementById("pal-permalink-table");
    const fallbackNote = document.getElementById("pal-permalink-fallback-note");
    const emptyEl      = document.getElementById("pal-permalink-empty");

    const DATA_ROOT = "DATA/L1";
    const L2_PATH   = "DATA/L2/pa_checkbook_summary.json";
    const PAGE_SIZE = 25;

    const MN = ["","January","February","March","April","May","June",
                "July","August","September","October","November","December"];

    const CHART_PALETTE = [
      "#16365b","#2f7da0","#9dddee","#5b9279","#c98a3e",
      "#a85b7a","#6b8e23","#7a6ba0","#fa1b3e","#3e8e7e",
    ];

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function sanitizeForPath(raw) {
      return (raw || "").trim()
        .replace(/\s+/g, "_")
        .replace(/[\/\\:*?"<>|']/g, "_")
        .replace(/_+/g, "_");
    }

    function monthKey(year, month) {
      return `${year}-${String(month).padStart(2, "0")}`;
    }

    function formatAmount(n) {
      return "$" + parseFloat(n).toLocaleString("en-US",
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    async function fetchJSON(path) {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${path}`);
      return resp.json();
    }

    async function fetchRecords(path) {
      try { return await fetchJSON(path); } catch (_) { return []; }
    }

    async function fetchAllMonths(basePath, monthKeys) {
      const results = await Promise.all(
        monthKeys.map(mk => fetchRecords(`${basePath}/${mk}.json`))
      );
      return results.flat();
    }

    function sumByMonth(records) {
      const totals = new Array(12).fill(0);
      records.forEach(r => {
        const d = new Date(r.invoice);
        if (!isNaN(d)) totals[d.getMonth()] += parseFloat(r.gross) || 0;
      });
      return totals;
    }

    function sumByYearMonth(records) {
      const map = new Map();
      records.forEach(r => {
        const mk = (r.invoice || "").slice(0, 7);
        if (mk.length === 7) map.set(mk, (map.get(mk) || 0) + (parseFloat(r.gross) || 0));
      });
      return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    }

    function sumByKey(records, keyFn, n) {
      const map = new Map();
      records.forEach(r => {
        const k = keyFn(r);
        map.set(k, (map.get(k) || 0) + (parseFloat(r.gross) || 0));
      });
      return [...map.entries()].sort(([,a],[,b]) => b - a).slice(0, n);
    }

    // ------------------------------------------------------------------
    // Chart
    // ------------------------------------------------------------------

    function baseChartOptions(titleText) {
      return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: { display: true, text: titleText,
                   font: { size: 13, weight: "600" } },
        },
        scales: {
          y: { beginAtZero: true,
               ticks: { callback: v => "$" + Number(v).toLocaleString() } },
        },
      };
    }

    let chartInstance = null;

    function renderChart(config) {
      if (!window.Chart) { chartWrap.style.display = "none"; return; }
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      chartCanvas.style.display = "block";
      chartInstance = new Chart(chartCanvas.getContext("2d"), config);
    }

    // ------------------------------------------------------------------
    // Subtitle
    // ------------------------------------------------------------------

    function buildExplanation(params) {
      const { vk, name, acct, desc, year, month } = params;
      const period = month && year ? `in ${MN[month]} ${year}`
                   : year          ? `in ${year}`
                   :                 "(all years)";
      if (vk)  return `Invoice detail for ${vk}`;
      if (name === "ACH PAYEE" && desc) return `ACH/Grant payments for description \u201c${desc}\u201d ${period}`;
      if (name === "ACH PAYEE" && acct) return `ACH/Grant payments for account ${acct} ${period}`;
      if (name === "WIR PAYEE" && desc) return `Wire transfer payments for description \u201c${desc}\u201d ${period}`;
      if (name === "WIR PAYEE" && acct) return `Wire transfer payments for account ${acct} ${period}`;
      if (name === "ACH PAYEE") return `All ACH/Grant disbursements ${period}`;
      if (name === "WIR PAYEE") return `All wire transfer payments ${period}`;
      if (name && desc) return `Payments to ${name} for description \u201c${desc}\u201d ${period}`;
      if (name && acct) return `Payments to ${name} for account ${acct} ${period}`;
      if (name)  return `All payments made to ${name} ${period}`;
      if (acct)  return `All payments charged to account ${acct} ${period}`;
      if (desc)  return `All payments with description \u201c${desc}\u201d ${period}`;
      if (month && year) return `All payments in ${MN[month]} ${year}`;
      if (year)  return `All payments in fiscal year ${year}`;
      return "";
    }

    // ------------------------------------------------------------------
    // Table with pagination matching the modal
    // ------------------------------------------------------------------

    function renderPermalinkTable(records) {
      const thead       = tableEl.querySelector("thead");
      const tbody       = tableEl.querySelector("tbody");
      const paginationEl = document.getElementById("pal-permalink-pagination");

      thead.innerHTML = `<tr>
        <th>Date</th><th>Payee</th><th>Description</th>
        <th>Account</th><th>Amount</th>
      </tr>`;

      if (!records || records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="pal-empty">No records found.</td></tr>';
        if (paginationEl) paginationEl.innerHTML = "";
        return;
      }

      const sorted = records.slice()
        .sort((a, b) => (b.invoice || "").localeCompare(a.invoice || ""));

      let currentPage = 1;
      const totalPages = Math.ceil(sorted.length / PAGE_SIZE);

      function renderPage() {
        tbody.innerHTML = "";
        const colCount = 5;
        const start = (currentPage - 1) * PAGE_SIZE;
        sorted.slice(start, start + PAGE_SIZE).forEach(r => {
          const tr = document.createElement("tr");

          const dateTd = document.createElement("td");
          dateTd.textContent = r.invoice || "";

          const nameTd = document.createElement("td");
          const vk = r["0"] || "";
          const name = (r.name || "").trim();
          if (vk) {
            const link = document.createElement("span");
            link.className = "pal-link pal-invoice-trigger";
            link.textContent = name;
            link.title = "Click to view invoice";
            link.addEventListener("click", () =>
              toggleInvoiceRow(tr, vk, name, colCount));
            nameTd.appendChild(link);
          } else {
            nameTd.textContent = name;
          }

          const descTd = document.createElement("td");
          descTd.textContent = r.description || "";

          const acctTd = document.createElement("td");
          acctTd.textContent = r.alt || "";

          const amtTd = document.createElement("td");
          amtTd.className = "pal-amount-cell";
          amtTd.textContent = formatAmount(r.gross);

          tr.appendChild(dateTd);
          tr.appendChild(nameTd);
          tr.appendChild(descTd);
          tr.appendChild(acctTd);
          tr.appendChild(amtTd);
          tbody.appendChild(tr);
        });

        if (!paginationEl) return;
        paginationEl.innerHTML = "";
        if (totalPages <= 1) return;

        const makeBtn = (label, page, disabled, active) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = label;
          btn.disabled = !!disabled;
          if (active) btn.className = "pal-page-active";
          btn.addEventListener("click", () => { currentPage = page; renderPage(); });
          return btn;
        };

        paginationEl.appendChild(makeBtn("\u2039 Prev", currentPage - 1, currentPage === 1));

        const maxButtons = 7;
        let startPage = Math.max(1, currentPage - 3);
        let endPage   = Math.min(totalPages, startPage + maxButtons - 1);
        startPage     = Math.max(1, endPage - maxButtons + 1);
        for (let p = startPage; p <= endPage; p++) {
          paginationEl.appendChild(makeBtn(String(p), p, false, p === currentPage));
        }

        paginationEl.appendChild(makeBtn("Next \u203a", currentPage + 1, currentPage === totalPages));

        const summary = document.createElement("span");
        summary.className = "pal-page-summary";
        summary.textContent = `${sorted.length.toLocaleString()} record${sorted.length === 1 ? "" : "s"}`;
        paginationEl.appendChild(summary);
      }

      renderPage();
    }

    // ------------------------------------------------------------------
    // Fallback / empty states
    // ------------------------------------------------------------------

    function showFallbackNote(msg) {
      if (!fallbackNote) return;
      fallbackNote.textContent = msg;
      fallbackNote.style.display = "block";
    }

    function showEmpty() {
      if (titleEl) titleEl.textContent = "No data found";
      if (chartWrap)   chartWrap.style.display  = "none";
      if (tableWrap)   tableWrap.style.display   = "none";
      if (invoiceWrap) invoiceWrap.style.display = "none";
      if (emptyEl)     emptyEl.style.display     = "block";
    }

    // ------------------------------------------------------------------
    // Fetch with progressive fallback (month -> year -> all history)
    // ------------------------------------------------------------------

    async function fetchWithFallback(basePath, l2MonthKeys, year, month) {
      const yearKeys  = year  ? l2MonthKeys.filter(mk => mk.startsWith(`${year}-`)) : l2MonthKeys;
      const monthKeys = month ? yearKeys.filter(mk => mk === monthKey(year, month))  : yearKeys;

      if (monthKeys.length) {
        const records = await fetchAllMonths(basePath, monthKeys);
        if (records.length) return { records, fallbackMsg: null };
      }

      if (month && yearKeys.length) {
        const records = await fetchAllMonths(basePath, yearKeys);
        if (records.length) return {
          records,
          fallbackMsg: `* Data for ${MN[month]} ${year} is not available — showing all of ${year} instead.`,
        };
      }

      if ((month || year) && l2MonthKeys.length) {
        const attempted = month ? `${MN[month]} ${year}` : `${year}`;
        const records = await fetchAllMonths(basePath, l2MonthKeys);
        if (records.length) return {
          records,
          fallbackMsg: `* Data for ${attempted} is not available — showing full history instead.`,
        };
      }

      return { records: [], fallbackMsg: null };
    }

    // ------------------------------------------------------------------
    // View renderers
    // ------------------------------------------------------------------

    async function renderYear(year) {
      if (titleEl) titleEl.textContent = `Fiscal Year ${year}`;
      document.title = `Fiscal Year ${year} — Keystone Ledger Lens`;

      const records = [];
      for (let m = 1; m <= 12; m++) {
        records.push(...await fetchRecords(
          `${DATA_ROOT}/BY_YEAR/${year}/${monthKey(year, m)}.json`));
      }
      if (!records.length) { showEmpty(); return; }

      renderChart({
        type: "bar",
        data: {
          labels: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
          datasets: [{
            label: `${year} spend by month`,
            data: sumByMonth(records),
            backgroundColor: "#2f7da0",
            borderRadius: 4,
          }],
        },
        options: baseChartOptions("Spend by month"),
      });
      renderPermalinkTable(records);
    }

    async function renderMonth(year, month) {
      const label = `${MN[month]} ${year}`;
      if (titleEl) titleEl.textContent = label;
      document.title = `${label} — Keystone Ledger Lens`;

      const records = await fetchRecords(
        `${DATA_ROOT}/BY_YEAR/${year}/${monthKey(year, month)}.json`);
      if (!records.length) { showEmpty(); return; }

      const byPayee = sumByKey(records, r => (r.name || "Unknown").trim(), 8);
      renderChart({
        type: "doughnut",
        data: {
          labels: byPayee.map(([k]) => k),
          datasets: [{ data: byPayee.map(([,v]) => v), backgroundColor: CHART_PALETTE }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } },
            title: { display: true, text: "Top payees this month",
                     font: { size: 13, weight: "600" } },
          },
        },
      });
      renderPermalinkTable(records);
    }

    async function renderName(name, year, month, l2) {
      const title = [name, year ? (month ? `${MN[month]} ${year}` : year) : null]
        .filter(Boolean).join(" \u2014 ");
      if (titleEl) titleEl.textContent = title;
      document.title = `${title} — Keystone Ledger Lens`;

      const entry = l2.by_name && l2.by_name[name];
      const l2MonthKeys = entry ? Object.keys(entry.months) : [];
      if (!l2MonthKeys.length) { showEmpty(); return; }

      const { records, fallbackMsg } = await fetchWithFallback(
        `${DATA_ROOT}/BY_NAME/${sanitizeForPath(name)}`, l2MonthKeys, year, month);
      if (!records.length) { showEmpty(); return; }
      if (fallbackMsg) showFallbackNote(fallbackMsg);

      renderChart({
        type: "line",
        data: {
          labels: sumByYearMonth(records).map(([k]) => k),
          datasets: [{
            label: `${name} \u2014 spend over time`,
            data: sumByYearMonth(records).map(([,v]) => v),
            borderColor: "#16365b", backgroundColor: "rgba(22,54,91,0.08)",
            fill: true, tension: 0.25, pointRadius: 3,
          }],
        },
        options: baseChartOptions("Spend over time"),
      });
      renderPermalinkTable(records);
    }

    async function renderAcct(acct, year, month, l2) {
      const title = [acct, year ? (month ? `${MN[month]} ${year}` : year) : null]
        .filter(Boolean).join(" \u2014 ");
      if (titleEl) titleEl.textContent = title;
      document.title = `${title} — Keystone Ledger Lens`;

      const entry = l2.by_acct && l2.by_acct[acct];
      const l2MonthKeys = entry ? Object.keys(entry.months) : [];
      if (!l2MonthKeys.length) { showEmpty(); return; }

      const { records, fallbackMsg } = await fetchWithFallback(
        `${DATA_ROOT}/BY_ACCT/${sanitizeForPath(acct)}`, l2MonthKeys, year, month);
      if (!records.length) { showEmpty(); return; }
      if (fallbackMsg) showFallbackNote(fallbackMsg);

      renderChart({
        type: "line",
        data: {
          labels: sumByYearMonth(records).map(([k]) => k),
          datasets: [{
            label: `${acct} \u2014 spend over time`,
            data: sumByYearMonth(records).map(([,v]) => v),
            borderColor: "#2f7da0", backgroundColor: "rgba(47,125,160,0.08)",
            fill: true, tension: 0.25, pointRadius: 3,
          }],
        },
        options: baseChartOptions("Spend over time"),
      });
      renderPermalinkTable(records);
    }

    async function renderDesc(desc, year, month, l2) {
      const title = [desc, year ? (month ? `${MN[month]} ${year}` : year) : null]
        .filter(Boolean).join(" \u2014 ");
      if (titleEl) titleEl.textContent = title;
      document.title = `${title} — Keystone Ledger Lens`;

      const entry = l2.by_description && l2.by_description[desc];
      const l2MonthKeys = entry ? Object.keys(entry.months) : [];
      if (!l2MonthKeys.length) { showEmpty(); return; }

      const { records, fallbackMsg } = await fetchWithFallback(
        `${DATA_ROOT}/BY_DESCRIPTION/${sanitizeForPath(desc)}`, l2MonthKeys, year, month);
      if (!records.length) { showEmpty(); return; }
      if (fallbackMsg) showFallbackNote(fallbackMsg);

      renderChart({
        type: "line",
        data: {
          labels: sumByYearMonth(records).map(([k]) => k),
          datasets: [{
            label: `${desc} \u2014 spend over time`,
            data: sumByYearMonth(records).map(([,v]) => v),
            borderColor: "#6b8e23", backgroundColor: "rgba(107,142,35,0.08)",
            fill: true, tension: 0.25, pointRadius: 3,
          }],
        },
        options: baseChartOptions("Spend over time"),
      });
      renderPermalinkTable(records);
    }

    async function renderNameFiltered(name, desc, acct, year, month, l2) {
      const filterLabel = desc ? `\u201c${desc}\u201d` : `account ${acct}`;
      const title = `${name} \u2014 ${filterLabel}`;
      if (titleEl) titleEl.textContent = title;
      document.title = `${title} \u2014 Keystone Ledger Lens`;

      const entry = l2.by_name && l2.by_name[name];
      const l2MonthKeys = entry ? Object.keys(entry.months) : [];
      if (!l2MonthKeys.length) { showEmpty(); return; }

      const { records: allRecords, fallbackMsg } = await fetchWithFallback(
        `${DATA_ROOT}/BY_NAME/${sanitizeForPath(name)}`, l2MonthKeys, year, month);

      const records = allRecords.filter(r =>
        desc ? (r.description || "").trim() === desc
             : (r.alt || "").trim() === acct);

      if (!records.length) { showEmpty(); return; }
      if (fallbackMsg) showFallbackNote(fallbackMsg);

      renderChart({
        type: "line",
        data: {
          labels: sumByYearMonth(records).map(([k]) => k),
          datasets: [{
            label: `${title} \u2014 spend over time`,
            data: sumByYearMonth(records).map(([,v]) => v),
            borderColor: "#16365b", backgroundColor: "rgba(22,54,91,0.08)",
            fill: true, tension: 0.25, pointRadius: 3,
          }],
        },
        options: baseChartOptions("Spend over time"),
      });
      renderPermalinkTable(records);
    }

    async function renderInvoice(vk, name) {
      if (titleEl) titleEl.textContent = name || "Invoice Detail";
      document.title = `${name || "Invoice"} — Keystone Ledger Lens`;
      if (chartWrap)   chartWrap.style.display   = "none";
      if (tableWrap)   tableWrap.style.display    = "none";
      if (invoiceWrap) invoiceWrap.style.display  = "block";

      invoiceWrap.innerHTML = `<p class="pal-permalink-loading">Loading invoice\u2026</p>`;

      try {
        const html = await fetchInvoiceHtml(vk, name);
        const container = document.createElement("div");
        container.className = "pal-invoice-content";
        container.innerHTML = html;
        invoiceWrap.innerHTML = "";
        invoiceWrap.appendChild(container);
      } catch (err) {
        invoiceWrap.innerHTML =
          `<p class="pal-readme-error">Invoice not available: ${err.message}.</p>` +
          `<a href="/">\u2190 Back to dashboard</a>`;
      }
    }

    // ------------------------------------------------------------------
    // Main dispatch
    // ------------------------------------------------------------------

    const params   = new URLSearchParams(window.location.search);
    const vk       = params.get("vk")    || "";
    const name     = params.get("name")  || "";
    const acct     = params.get("acct")  || "";
    const desc     = params.get("desc")  || "";
    const yearStr  = params.get("year")  || "";
    const monthStr = params.get("month") || "";
    const year     = yearStr  ? parseInt(yearStr,  10) : null;
    const month    = monthStr ? parseInt(monthStr, 10) : null;

    if (subtitleEl) subtitleEl.textContent = buildExplanation({ vk, name, acct, desc, year, month });

    try {
      if (vk)                  { await renderInvoice(vk, name);                     return; }

      let l2 = {};
      try { l2 = await fetchJSON(L2_PATH); } catch (_) {}

      if (name && (desc || acct)) { await renderNameFiltered(name, desc, acct, year, month, l2); return; }
      if (desc)                   { await renderDesc(desc,   year, month, l2);       return; }
      if (acct)                   { await renderAcct(acct,   year, month, l2);       return; }
      if (name)                   { await renderName(name,   year, month, l2);       return; }
      if (month && year)          { await renderMonth(year,  month);                 return; }
      if (year)                   { await renderYear(year);                          return; }

      showEmpty();

    } catch (err) {
      console.error("PALedger permalink error:", err);
      showEmpty();
    }
  }


  // Expose the public API used by onclick="" handlers in the template.
  window.PALedger = {
    openYear,
    openMonth,
    openName,
    openAcct,
    openDescription,
    highlightPieSlice,
    clearPieHighlight,
    openReadme,
    initAchBreakdown,
    initWirBreakdown,
    initDescriptionBreakdowns,
    openInvoiceModal,
    fetchInvoiceHtml,
    toggleInvoiceRow,
    initPermalink,
  };
})();
