(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function getJson(url) {
    return fetch(url, { headers: { accept: "application/json" } }).then(function (res) {
      return res.json().then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

  /* ---------- character counter ---------- */
  var bodyField = $("p-body");
  bodyField.addEventListener("input", function () {
    $("p-count").textContent = bodyField.value.length;
  });

  /* ---------- header stats + fee panel ---------- */
  function money(n) {
    if (n === null || n === undefined) return "—";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "m";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k";
    return "$" + Math.round(n);
  }

  function refreshStats() {
    getJson("/api/stats").then(function (r) {
      if (!r.ok) return;
      var s = r.body;
      $("cycle").textContent = "Cycle " + s.cycle;
      $("stat-rulings").textContent = s.rulings;
      $("stat-approved").textContent = s.approved;
      $("stat-rate").textContent = s.approvalRate + "%";
      $("stat-burned").textContent = s.burned + " $DEREK";
      $("stat-treasury").textContent = money(s.treasuryUsd);
      $("fee-amount").textContent = s.fee ? s.fee.tokens : "—";
      // The dollar target comes from config; hardcoding it in the markup let
      // the two drift apart the moment the fee changed.
      $("fee-usd").textContent = s.fee
        ? "$DEREK · targeted at ≈ $" + s.fee.usdTarget + " · repriced from the market"
        : "$DEREK · repriced from the market";
      if (s.paused) {
        $("paused-notice").classList.add("is-live");
        $("p-submit").disabled = true;
        $("p-submit").textContent = "Intake paused";
      } else {
        $("paused-notice").classList.remove("is-live");
        $("p-submit").disabled = false;
        $("p-submit").textContent = "Get docket & fee";
      }
    }).catch(function () {});
  }
  refreshStats();
  setInterval(refreshStats, 30000);

  /* ---------- typewriter ---------- */
  var out = $("output");
  var typing = null;
  function type(str, done) {
    var i = 0;
    var el = $("out-text");
    el.textContent = "";
    clearInterval(typing);
    if (reduce) { el.textContent = str; done(); return; }
    out.classList.add("is-typing");
    typing = setInterval(function () {
      el.textContent = str.slice(0, ++i);
      if (i >= str.length) { clearInterval(typing); done(); }
    }, 14);
  }

  function stampFor(verdict) {
    if (verdict === "approved") return { cls: "stamp--yes", word: "Approved" };
    if (verdict === "void") return { cls: "stamp--void", word: "Void" };
    return { cls: "stamp--no", word: "Rejected" };
  }

  function hhmm(ts) {
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function showRuling(docketId, ruling, claim) {
    $("pay-status").textContent = "Fee received · judged";
    out.classList.add("is-live");
    var stamp = $("stamp");
    stamp.className = "output__stamp";
    $("out-docket").textContent = "Docket " + docketId;
    $("out-time").textContent = "Ruled " + hhmm(ruling.ruledAt) + " · read once";
    $("out-burn").textContent = "";

    type(ruling.rulingText, function () {
      out.classList.remove("is-typing");
      var s = stampFor(ruling.verdict);
      stamp.className = "output__stamp " + s.cls + " is-struck";
      stamp.firstChild.nodeValue = s.word;
      $("stamp-id").textContent = hhmm(ruling.ruledAt) + " · " + docketId;
      var burn = "Half the fee is burned either way · full ruling at /r/" + docketId;
      if (ruling.verdict === "approved") {
        burn = "Awarded $" + ruling.awardUsd +
          (claim && claim.code
            ? " · claim code: " + claim.code + " · /claim"
            : " · claim code issues after countersign") +
          " · /r/" + docketId;
      }
      $("out-burn").textContent = burn;
    });
  }

  /* ---------- submission + payment flow ---------- */
  var btn = $("p-submit");
  var pollTimer = null;
  var countdownTimer = null;

  function startCountdown(expiresAt) {
    clearInterval(countdownTimer);
    function tick() {
      var left = Math.max(0, expiresAt - Date.now());
      var m = Math.floor(left / 60000);
      var s = Math.floor((left % 60000) / 1000);
      $("pay-countdown").textContent = m + ":" + String(s).padStart(2, "0");
      if (left <= 0) {
        clearInterval(countdownTimer);
        $("pay-countdown").textContent = "expired quote — fee may be repriced";
      }
    }
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function pollDocket(docketId) {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      getJson("/api/dockets/" + encodeURIComponent(docketId)).then(function (r) {
        if (!r.ok) return;
        var d = r.body;
        if (d.status === "paid") $("pay-status").textContent = "Fee received · queued for the evening read";
        if (d.status === "expired") {
          $("pay-status").textContent = "Docket expired unpaid. Submit again.";
          clearInterval(pollTimer);
        }
        if (d.ruling) {
          clearInterval(pollTimer);
          showRuling(docketId, d.ruling, d.claim || null);
        }
      }).catch(function () {});
    }, 5000);
  }

  btn.addEventListener("click", function () {
    var title = $("p-title").value.trim();
    var amount = parseFloat($("p-amount").value);
    var body = bodyField.value.trim();
    if (!title || !body || !(amount > 0)) {
      $("pay-status").textContent = "";
      alert("Name the thing, give a number, write the proposal.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Filing…";

    fetch("/api/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title, amountUsd: amount, body: body })
    })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (r) {
        btn.disabled = false;
        btn.textContent = "Get docket & fee";
        if (!r.ok) {
          var pay = $("pay");
          pay.classList.add("is-live");
          $("pay-docket").textContent = "—";
          $("pay-addr").textContent = "—";
          $("pay-fee").textContent = "—";
          $("pay-status").textContent = r.body && r.body.message ? r.body.message : "Submission failed.";
          return;
        }
        var d = r.body;
        $("pay").classList.add("is-live");
        $("pay-docket").textContent = d.docketId;
        $("pay-addr").textContent = d.depositAddress;
        $("pay-fee").textContent = d.feeTokens;
        $("pay-qr").src = d.qrDataUrl;
        $("pay-status").textContent = "Waiting for payment…";
        startCountdown(d.quoteExpiresAt);
        pollDocket(d.docketId);
        $("pay").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "Get docket & fee";
      });
  });

  $("pay-copy").addEventListener("click", function () {
    var addr = $("pay-addr").textContent;
    if (addr && addr !== "—" && navigator.clipboard) {
      navigator.clipboard.writeText(addr);
      $("pay-copy").textContent = "Copied";
      setTimeout(function () { $("pay-copy").textContent = "Copy address"; }, 1500);
    }
  });

  /* ---------- ledger ---------- */
  var page = 1;
  var pages = 1;

  function verdictClass(v) {
    return v === "approved" ? "v-yes" : v === "void" ? "v-void" : "v-no";
  }
  function verdictWord(v) {
    return v === "approved" ? "Approved" : v === "void" ? "Void" : "Rejected";
  }

  function renderLedger() {
    getJson("/api/rulings?page=" + page).then(function (r) {
      if (!r.ok) return;
      var data = r.body;
      pages = data.pages;
      var grid = $("ledger-grid");
      $("ledger-empty").hidden = data.total !== 0;

      grid.innerHTML = data.items.map(function (item) {
        var award = item.verdict === "approved" && item.awardGbp !== null
          ? "Awarded <b>$" + esc(item.awardUsd) + "</b> · "
          : "";
        return '<article class="card">' +
          '<div class="card__top"><span>' + esc(item.docketId) + "</span>" +
          '<span class="card__verdict ' + verdictClass(item.verdict) + '">' + verdictWord(item.verdict) + "</span></div>" +
          '<h3 class="card__title"><a href="/r/' + encodeURIComponent(item.docketId) + '">' + esc(item.title) + "</a></h3>" +
          '<p class="card__line">' + esc(item.rulingLine) + "</p>" +
          '<p class="card__foot">Requested <b>$' + esc(item.amountUsd) + "</b> · " + award + esc(item.burned) + " burned</p>" +
          "</article>";
      }).join("");

      $("pcount").textContent = "Page " + data.page + " of " + data.pages;
      $("prev").disabled = page <= 1;
      $("next").disabled = page >= pages;

      // Marquee out of the machine: most recent rulings, only when they exist.
      if (data.items.length > 0 && page === 1) {
        $("feed").hidden = false;
        $("feed-track").innerHTML = data.items.map(function (item) {
          var v = item.verdict === "approved"
            ? "<i>APPROVED $" + esc(item.awardUsd) + "</i>"
            : item.verdict === "void" ? '<span class="v-void">VOID</span>' : "<b>REJECTED</b>";
          return esc(item.docketId) + " " + v + ' "' + esc(item.rulingLine) + '" · &nbsp;&nbsp;';
        }).join("");
      }
    }).catch(function () {});
  }

  $("prev").addEventListener("click", function () { if (page > 1) { page--; renderLedger(); } });
  $("next").addEventListener("click", function () { if (page < pages) { page++; renderLedger(); } });
  renderLedger();
  setInterval(function () { if (page === 1) renderLedger(); }, 60000);
})();
