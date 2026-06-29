# Keystone Ledger Lens

**A plain-language guide to Pennsylvania's public spending data.**

[View the live dashboard →](https://keystoneledger.github.io/)

Keystone Ledger Lens reads daily from Pennsylvania's official transparency portal and turns raw government payment records into an interactive dashboard anyone can explore — no spreadsheets, no budget expertise required. If you've ever wondered where your state tax dollars go, this is a starting point.

---

## Where the data comes from

All figures come directly from the **Pennsylvania Treasury's OpenBookPA Checkbook**, available at [patreasury.gov/openbookpa/checkbook.php](https://www.patreasury.gov/openbookpa/checkbook.php).

OpenBookPA is a public transparency tool created by the Pennsylvania Treasury. It lets you search through state payments, operating expenses, and vendor contracts — detailing exactly how taxpayer money is spent across the Commonwealth. The data includes payments issued by state agencies to vendors, contractors, grantees, and other recipients, typically covering multiple fiscal years of history.

Keystone Ledger Lens retrieves this data once per day and refreshes the dashboard automatically. The "Data As Of" timestamp in the dashboard tells you exactly when the most recent pull happened.

---

## What's included — and what isn't

### Payments you can see

The OpenBookPA dataset contains expenses that meet Pennsylvania's transparency standards under the **PennWatch bill** — the state law that requires certain government payments to be published publicly. These include most routine vendor payments, contractor invoices, and grant disbursements processed through the state's central accounting system.

### Payments that are hidden or missing

Not every dollar Pennsylvania spends appears here. There are two main reasons a payment might be absent:

**It didn't meet the PennWatch publishing threshold.** Certain categories of payments are exempt from the public disclosure requirement under state law — for example, payments to individuals (as opposed to businesses or organizations), certain sensitive program expenditures, and payments processed outside the central accounting system. If a payment isn't visible in OpenBookPA, it isn't visible here either.

**It was anonymized for privacy or legal reasons.** Even when a payment's amount and date are published, the recipient's identity is sometimes masked. You'll see these show up as generic placeholder names rather than real vendor names:

| Placeholder | Meaning |
|---|---|
| **ACH Payee** | A payment sent electronically (ACH transfer), often covering many small grant or benefit disbursements to individual recipients who are not publicly identified |
| **CHK Payee** | A payment issued by paper check, where the individual recipient's identity is withheld |
| **WIR Payee** | A wire transfer where the recipient's identity is not published |

These placeholders mean the *payment itself* is visible — you can see that money went out, when, and how much — but not to whom specifically. In the dashboard, ACH Payee amounts are tracked separately because they represent a large share of total spending and would otherwise distort vendor rankings.

---

## How to read the dashboard

### Rolling 30 Days

The banner at the top of the page shows a real-time summary of payments recorded in the last 30 calendar days — the total dollar amount, the number of individual payments, the top payee by dollar value, and a table of the ten largest recipients in that window. This gives you a sense of recent activity without needing to know anything about fiscal-year cycles.

### Top Payees and Top Accounts — current year

Two pie charts appear side by side. The left chart shows the ten vendors or recipients who received the most money in the *current fiscal year*. The right chart shows the ten account codes — Pennsylvania's internal budget categories — that saw the most spending. Hover over a row in either legend table to highlight that slice of the pie. Click a row to open a detailed view showing that payee's or account's payment history for the current year.

### Spend by Month — All Years (radar chart)

The radar chart in the upper-right card shows how spending is distributed across the 12 calendar months when all years of data are combined. Months with larger spokes had higher total spending across the full history of the dataset. This is useful for spotting seasonal patterns — for example, many government payment systems process large disbursements at certain points in the fiscal year regardless of which year it is.

### Fiscal Year [Year]

This section shows the current fiscal year's total spending alongside a trend line of monthly totals for the trailing 12 months. Click the "Fiscal Year" heading to open a full breakdown of every payment in that year. The blue dollar figure in the subtitle is the year-to-date total as of the report date.

### Prior Years

A table listing each previous year in the dataset with its total spending, year-over-year percent change, and a horizontal bar so you can visually compare years at a glance. Click any year to see its individual payments. A negative year-over-year change doesn't necessarily mean the state spent less — it may reflect payments shifting between categories, years with unusually large one-time expenditures, or gaps in the published data.

### ACH / Grant Disbursements by Year

A breakdown of ACH Payee amounts by year — showing how much was disbursed through anonymous electronic transfers in each year of the dataset. Click any year to see the individual ACH payment records for that year. Because ACH Payee covers a very broad range of recipients (grants, benefits, and miscellaneous transfers), the dollar totals here can be large. This section exists to keep those amounts visible without letting a single placeholder vendor dominate the payee rankings.

### Most Common Descriptions

A paginated, searchable list of all expense descriptions in the dataset, sorted from highest total spend to lowest. Each description is a category label that Pennsylvania's accounting system attaches to payments — things like "Software License," "Professional Services," or "Grant Disbursement." Click any description to see a chart of its spending over time and the individual payment records behind it.

---

## Known limitations

**The data is not complete.** As described above, payments exempt from PennWatch disclosure requirements do not appear. The dataset reflects what Pennsylvania publishes, not a full accounting of all state expenditures.

**Some recipients are anonymous.** ACH Payee, CHK Payee, and WIR Payee are placeholders. There is no way to identify the specific individuals or organizations behind these entries from the public data alone.

**The data may be up to 24 hours old.** The dashboard is refreshed once per day. The "Data As Of" field on the dashboard shows when the most recent update occurred. Real-time figures are not available.

**Year-over-year comparisons require care.** A dramatic change between years can reflect genuine spending shifts, one-time large transactions, changes in how payments are categorized, or differences in how much of a year's data has been published at the time the dashboard was generated. Always treat year-over-year figures as a starting point for questions, not a final answer.

**Dollar amounts are gross figures.** The amounts shown represent the gross value of each payment as recorded in the OpenBookPA system. Refunds, reversals, and credits may appear as separate line items rather than offsets against the original payment.

---

## Questions and feedback

This project is open source. If you notice an error, have a question about the data, or want to suggest an improvement, [please open an issue](https://github.com/keystoneledger/keystoneledger.github.io/issues/) in this repository.

For questions about the underlying data itself — what payments are included, why a specific transaction appears or doesn't — the authoritative source is the Pennsylvania Treasury:
[patreasury.gov/openbookpa/checkbook.php](https://www.patreasury.gov/openbookpa/checkbook.php)
