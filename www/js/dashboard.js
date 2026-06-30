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
      const readmeContent = tableWrap.querySelector(".pal-readme-body, .pal-readme-loading, .pal-readme-error");
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
  function renderPieChart(canvasId, entries) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !entries || entries.length === 0) return;

    const chart = new Chart(canvas.getContext("2d"), {
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
  };
})();
