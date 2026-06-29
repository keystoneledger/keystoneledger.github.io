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
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
            td.textContent = col.format ? col.format(raw, record) : raw;
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
      },
      {
        key: "gross", label: "Amount", sortable: true, className: "pal-amount-cell",
        sortValue: (r) => parseAmount(r.gross),
        format: (v) => formatAmount(parseAmount(v)),
      },
      {
        key: "description", label: "Category", sortable: true,
        sortValue: (r) => (r.description || "").toLowerCase(),
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

  const CHART_PALETTE = [
    "#2f7da0", "#16365b", "#9dddee", "#fa1b3e", "#5b9279",
    "#c98a3e", "#7a6ba0", "#3e8e7e", "#a85b7a", "#6b8e23",
  ];

  // --------------------------------------------------------------------
  // Public drill-down entry points
  // (called directly from onclick="" attributes in the Jinja template)
  // --------------------------------------------------------------------

  /** Year click: bar chart of that year's 12 months + table of every record. */
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
          legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } },
          title: { display: true, text: "Top payees this month", font: { size: 13, weight: "600" } },
        },
      },
    });

    renderTable(records, standardColumns());
  }

  /** Payee click: line chart of spend over time + table of all their records.
   *  monthKeysCsv is a comma-joined string of "YYYY-MM" keys (from
   *  L3 summary.json) known to have at least one record for this payee.
   *  Passed as a plain comma-joined string rather than a JSON array
   *  literal because embedding a tojson'd array directly inside an HTML
   *  onclick="" attribute collides with the attribute's own quoting. */
  async function openName(rawName, monthKeysCsv) {
    openModal(rawName);
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
          label: `${rawName} -- spend over time`,
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
  }

  /** Account code click: line chart of spend over time + table of all
   *  its records. monthKeysCsv: see openName's note on why this is a
   *  comma-joined string rather than an array. */
  async function openAcct(alt, monthKeysCsv) {
    openModal(`Account ${alt}`);
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
          label: `Account ${alt} -- spend over time`,
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

  /** Renders a top-N doughnut/pie chart from pre-aggregated {label, amount}
   *  entries embedded by the template (current-year top payees/accounts).
   *  Used by both new 2nd-summary pie-chart cards -- same rendering logic,
   *  different data and canvas id. */
  function renderPieChart(canvasId, entries) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !entries || entries.length === 0) return;

    new Chart(canvas.getContext("2d"), {
      type: "doughnut",
      data: {
        labels: entries.map((e) => e.label),
        datasets: [{
          data: entries.map((e) => e.amount),
          backgroundColor: CHART_PALETTE,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } },
        },
      },
    });
  }

  // --------------------------------------------------------------------
  // Init
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

    if (!window.Chart) {
      console.warn("PALedger: Chart.js did not load; charts skipped.");
      return;
    }

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
  }

  document.addEventListener("DOMContentLoaded", init);

  // Expose the public API used by onclick="" handlers in the template.
  window.PALedger = {
    openYear,
    openMonth,
    openName,
    openAcct,
  };
})();
