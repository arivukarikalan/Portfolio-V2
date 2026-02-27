function ddParseDateLocal(dateStr) {
  const parts = String(dateStr || "").split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return new Date(dateStr);
  return new Date(y, m - 1, d);
}

function ddResolveTxnBrokerage(txn, settings) {
  const tradeValue = Number(txn.qty) * Number(txn.price);
  if (txn.type === "BUY") {
    return (settings.brokerageBuyPct / 100) * tradeValue;
  }
  return (settings.brokerageSellPct / 100) * tradeValue + Number(settings.dpCharge || 0);
}

function ddEmptyCard(msg) {
  return `<div class="txn-card text-center text-muted">${msg}</div>`;
}

function loadDeepDive() {
  const summaryEl = document.getElementById("deepSummary");
  const unwantedEl = document.getElementById("unwantedBuysList");
  const concentrationEl = document.getElementById("concentrationList");
  const riskEl = document.getElementById("riskList");
  const noReturnEl = document.getElementById("noReturnList");
  if (!summaryEl || !unwantedEl || !concentrationEl || !riskEl || !noReturnEl) return;

  getSettings(settings => {
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .getAll().onsuccess = e => {
        const txns = (e.target.result || []).sort(
          (a, b) => ddParseDateLocal(a.date) - ddParseDateLocal(b.date)
        );

        const byStock = {};
        const gapThresholdPct = 2.5;
        const realized = {};
        const brokerageMap = {};

        txns.forEach(t => {
          byStock[t.stock] ??= {
            lots: [],
            cycleBuys: [],
            cycleFirstDate: null,
            cycleLastDate: null
          };
          realized[t.stock] ??= 0;
          brokerageMap[t.stock] ??= 0;
          const s = byStock[t.stock];

          const txnBrkg = ddResolveTxnBrokerage(t, settings);
          brokerageMap[t.stock] += txnBrkg;

          if (t.type === "BUY") {
            if (s.lots.length === 0) {
              s.cycleBuys = [];
              s.cycleFirstDate = t.date;
            }
            s.cycleLastDate = t.date;
            s.cycleBuys.push({
              date: t.date,
              qty: Number(t.qty),
              price: Number(t.price)
            });
            s.lots.push({
              qty: Number(t.qty),
              price: Number(t.price),
              brokeragePerUnit: txnBrkg / Number(t.qty)
            });
            return;
          }

          let sellQty = Number(t.qty);
          let buyCost = 0;
          let buyBrkg = 0;
          while (sellQty > 0 && s.lots.length) {
            const lot = s.lots[0];
            const used = Math.min(lot.qty, sellQty);
            buyCost += used * lot.price;
            buyBrkg += used * lot.brokeragePerUnit;
            lot.qty -= used;
            sellQty -= used;
            if (lot.qty === 0) s.lots.shift();
          }
          const sellValue = Number(t.qty) * Number(t.price);
          realized[t.stock] += sellValue - buyCost - buyBrkg - txnBrkg;
        });

        const activeRows = Object.keys(byStock).map(stock => {
          const lots = byStock[stock].lots;
          const invested = lots.reduce((a, l) => a + l.qty * (l.price + l.brokeragePerUnit), 0);
          const qty = lots.reduce((a, l) => a + l.qty, 0);
          const holdDays = lots.length && byStock[stock].cycleFirstDate
            ? Math.floor((new Date() - ddParseDateLocal(byStock[stock].cycleFirstDate)) / 86400000)
            : 0;
          return {
            stock,
            lots,
            qty,
            invested,
            holdDays,
            cycleBuys: byStock[stock].cycleBuys,
            firstDate: byStock[stock].cycleFirstDate,
            lastDate: byStock[stock].cycleLastDate,
            realizedNet: realized[stock] || 0,
            brokerage: brokerageMap[stock] || 0
          };
        }).filter(r => r.lots.length > 0);

        const totalActiveInvested = activeRows.reduce((a, r) => a + r.invested, 0);

        const unwantedRows = [];
        activeRows.forEach(r => {
          for (let i = 1; i < r.cycleBuys.length; i++) {
            const prev = r.cycleBuys[i - 1];
            const curr = r.cycleBuys[i];
            const gapPct = prev.price > 0
              ? Math.abs(((curr.price - prev.price) / prev.price) * 100)
              : 0;
            if (gapPct <= gapThresholdPct) {
              unwantedRows.push({
                stock: r.stock,
                prevDate: prev.date,
                prevPrice: prev.price,
                date: curr.date,
                qty: curr.qty,
                price: curr.price,
                gapPct
              });
            }
          }
        });

        const concentrationRows = activeRows
          .map(r => {
            const allocation = totalActiveInvested > 0
              ? (r.invested / totalActiveInvested) * 100
              : 0;
            let tone = "ok";
            let note = "Balanced";
            if (allocation > Number(settings.maxAllocationPct || 25)) {
              tone = "high";
              note = "Trim / rebalance suggested";
            } else if (allocation > 15) {
              tone = "mid";
              note = "Watch closely";
            }
            return { ...r, allocation, tone, note };
          })
          .sort((a, b) => b.allocation - a.allocation);

        const riskRows = concentrationRows
          .map(r => {
            const tightBuys = unwantedRows.filter(u => u.stock === r.stock).length;
            const brokerageRatio = r.invested > 0 ? (r.brokerage / r.invested) * 100 : 0;
            let score = 0;
            const reasons = [];

            if (r.allocation > Number(settings.maxAllocationPct || 25)) {
              score += 2;
              reasons.push("High concentration");
            } else if (r.allocation > 15) {
              score += 1;
              reasons.push("Moderate concentration");
            }

            if (tightBuys >= 2) {
              score += 1;
              reasons.push("Repeated tight-gap buys");
            }

            if (r.realizedNet < 0) {
              score += 1;
              reasons.push("Historical realised loss");
            }

            if (r.holdDays > 90 && r.realizedNet <= 0) {
              score += 1;
              reasons.push("Long hold with no realised edge");
            }

            if (brokerageRatio > 1.2) {
              score += 1;
              reasons.push("High brokerage drag");
            }

            return { ...r, tightBuys, brokerageRatio, score, reasons };
          })
          .filter(r => r.score >= 2)
          .sort((a, b) => b.score - a.score || b.allocation - a.allocation);

        const longNoReturnRows = concentrationRows
          .filter(r => r.holdDays > 90 && r.realizedNet <= 0)
          .sort((a, b) => b.holdDays - a.holdDays);

        summaryEl.innerHTML = `
          <div class="stat-card"><div class="stat-label">Unwanted Buys</div><div class="stat-value">${unwantedRows.length}</div></div>
          <div class="stat-card"><div class="stat-label">Risk Stocks</div><div class="stat-value">${riskRows.length}</div></div>
          <div class="stat-card"><div class="stat-label">Need Rebalance</div><div class="stat-value">${concentrationRows.filter(r => r.allocation > Number(settings.maxAllocationPct || 25)).length}</div></div>
          <div class="stat-card"><div class="stat-label">No Return (90d+)</div><div class="stat-value">${longNoReturnRows.length}</div></div>
        `;

        unwantedEl.innerHTML = unwantedRows.length
          ? unwantedRows.map(u => `
              <div class="txn-card">
                <div class="split-row">
                  <div class="left-col">
                    <div class="txn-name">${u.stock}</div>
                    <div class="tiny-label">${u.prevDate} ₹${u.prevPrice.toFixed(2)} -> ${u.date} ₹${u.price.toFixed(2)}</div>
                  </div>
                  <div class="right-col">
                    <div class="risk-pill bad">${u.gapPct.toFixed(2)}% gap</div>
                    <div class="tiny-label">Qty ${u.qty}</div>
                  </div>
                </div>
              </div>
            `).join("")
          : ddEmptyCard("No tight-gap buy pattern detected in active cycles");

        concentrationEl.innerHTML = concentrationRows.length
          ? concentrationRows.map(r => `
              <div class="txn-card">
                <div class="split-row">
                  <div class="left-col">
                    <div class="txn-name">${r.stock}</div>
                    <div class="tiny-label">Invested: ₹${r.invested.toFixed(2)} | Qty: ${r.qty}</div>
                  </div>
                  <div class="right-col">
                    <div class="metric-strong">${r.allocation.toFixed(2)}%</div>
                    <div class="risk-pill ${r.tone === "high" ? "bad" : r.tone === "mid" ? "warn" : "ok"}">${r.note}</div>
                  </div>
                </div>
              </div>
            `).join("")
          : ddEmptyCard("No active holdings available for concentration analysis");

        riskEl.innerHTML = riskRows.length
          ? riskRows.map(r => `
              <div class="txn-card">
                <div class="split-row">
                  <div class="left-col">
                    <div class="txn-name">${r.stock}</div>
                    <div class="tiny-label">Score: ${r.score} | Allocation: ${r.allocation.toFixed(2)}%</div>
                    <div class="tiny-label">Tight-gap buys: ${r.tightBuys} | Brokerage drag: ${r.brokerageRatio.toFixed(2)}%</div>
                  </div>
                  <div class="right-col">
                    <div class="risk-pill bad">Under Risk</div>
                  </div>
                </div>
                <div class="status-inline">${r.reasons.map(x => `<span class="status-pill-mini bad">${x}</span>`).join("")}</div>
              </div>
            `).join("")
          : ddEmptyCard("No stock currently crosses risk score threshold");

        noReturnEl.innerHTML = longNoReturnRows.length
          ? longNoReturnRows.map(r => `
              <div class="txn-card">
                <div class="split-row">
                  <div class="left-col">
                    <div class="txn-name">${r.stock}</div>
                    <div class="tiny-label">Hold Days: ${r.holdDays} | First Buy: ${r.firstDate}</div>
                    <div class="tiny-label">Invested: ₹${r.invested.toFixed(2)} | Realised Net: ₹${r.realizedNet.toFixed(2)}</div>
                  </div>
                  <div class="right-col">
                    <div class="risk-pill warn">Review Exit Plan</div>
                  </div>
                </div>
              </div>
            `).join("")
          : ddEmptyCard("No 90+ day active holding is flagged as no-return");
      };
  });
}

