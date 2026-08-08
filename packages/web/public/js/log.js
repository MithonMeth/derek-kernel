(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function money(n) {
    return "$" + Number(n).toLocaleString("en-US");
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function getJson(url) {
    return fetch(url, { headers: { accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }

  /**
   * The Manager writes the decision first and the reasons after, numbered
   * when there is more than one, then one closing line. Render that shape:
   * blank-line-separated blocks, numbered blocks as lists, and the final
   * paragraph set as the close.
   */
  function renderRuling(text) {
    var blocks = String(text).split(/\n\s*\n/).map(function (b) { return b.trim(); })
      .filter(Boolean);

    return blocks.map(function (block, i) {
      var lines = block.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var numbered = lines.length > 1 && lines.every(function (l) { return /^\d+[.)]\s+/.test(l); });

      if (numbered) {
        return "<ol>" + lines.map(function (l) {
          return "<li>" + esc(l.replace(/^\d+[.)]\s+/, "")) + "</li>";
        }).join("") + "</ol>";
      }
      var isClose = i === blocks.length - 1 && blocks.length > 1;
      return '<p' + (isClose ? ' class="ruling__close"' : "") + ">" + esc(block) + "</p>";
    }).join("");
  }

  function stampFor(verdict) {
    if (verdict === "approved") return { cls: "stamp--yes", word: "Approved" };
    if (verdict === "void") return { cls: "stamp--void", word: "Void" };
    return { cls: "stamp--no", word: "Rejected" };
  }

  function renderEntry(item) {
    var d = new Date(item.ruledAt);
    var time = pad(d.getHours()) + ":" + pad(d.getMinutes());
    var date = pad(d.getDate()) + " " + MONTHS[d.getMonth()];
    var stamp = stampFor(item.verdict);
    var flags = item.flags || [];

    var rail = '<span class="rail__docket">' + esc(item.docketId) + "</span>" +
      '<span class="rail__time">' + time + "</span>" +
      '<span class="rail__date">' + date + "</span>";
    if (flags.length) {
      rail += '<span class="rail__flag">' + esc(flags[0].replace(/_/g, " ")) + "</span>";
    }
    if (item.held) {
      rail += '<span class="rail__held">Held · cycle spent</span>';
    }

    var award = '<span>Requested <b>' + money(item.amountGbp) + "</b></span>";
    if (item.verdict === "approved" && item.awardGbp !== null) {
      award += '<span>Awarded <b class="up">' + money(item.awardGbp) + "</b></span>";
    } else {
      award += '<span>Awarded <b class="down">$0</b></span>';
    }
    if (typeof item.gatesPassed === "number") {
      var cleared = item.gatesPassed === 5;
      award += '<span>Gates cleared <b class="' + (cleared ? "up" : "down") + '">' +
        item.gatesPassed + "/5</b></span>";
    }
    if (flags.length) {
      award += '<span>Flags <b class="down">' + esc(flags.join(", ")) + "</b></span>";
    }
    if (item.held) {
      award += '<span>Payment <b class="down">held to next cycle</b></span>';
    }

    return '<article class="entry">' +
      '<div class="entry__rail">' + rail + "</div>" +
      '<div class="entry__body">' +
        '<h2 class="entry__title">' + esc(item.title) + "</h2>" +
        '<p class="entry__from">submitted anonymously · requested ' + money(item.amountGbp) + "</p>" +
        (item.proposal ? '<blockquote class="quote">' + esc(item.proposal) + "</blockquote>" : "") +
        '<div class="ruling">' + renderRuling(item.rulingText || item.rulingLine) + "</div>" +
        '<div class="award">' + award + "</div>" +
      "</div>" +
      '<div class="stamp ' + stamp.cls + '">' + stamp.word +
        "<small>" + time + " · " + esc(item.docketId) + "</small></div>" +
      "</article>";
  }

  /* ---------- duty strip ---------- */
  getJson("/api/stats").then(function (s) {
    $("cycle").textContent = s.cycle;
    $("d-rulings").textContent = Number(s.rulings).toLocaleString("en-GB");
    $("d-approved").textContent = Number(s.approved).toLocaleString("en-GB");
    var days = s.daysSinceApproval;
    $("d-days").textContent = days === null ? "—" : days;
    // The drought is only worth putting in oxblood once it is actually a
    // drought; a fresh approval is not a warning.
    $("d-days").classList.toggle("duty__value--warn", days !== null && days >= 7);

    // The cap actually in force is the smaller of the constitutional maximum
    // and the Treasury's share, which is what rulings are measured against.
    if (s.treasuryUsd === null) {
      $("d-cap").textContent = money(s.maxAward);
    } else {
      var share = Math.floor((s.treasuryUsd * 0.05) / 1.28);
      $("d-cap").textContent = money(Math.min(s.maxAward, share));
    }

    // A deployed slug is not a git checkout, so there may be no commit to
    // quote. The content hash identifies the document itself, which is the
    // thing the colophon is actually vouching for.
    var c = s.constitution || {};
    if (c.commit) {
      $("colo-commit").textContent =
        "Rulings issued under constitution commit " + c.commit.slice(0, 7) + " · variant C";
    } else if (c.sha256) {
      $("colo-commit").textContent =
        "Rulings issued under constitution sha256 " + c.sha256.slice(0, 12) + " · variant C";
    }
  }).catch(function () {});

  /* ---------- entries ---------- */
  var page = 1;
  var pages = 1;

  function render() {
    getJson("/api/rulings?detail=1&page=" + page).then(function (data) {
      pages = data.pages;
      $("entries").innerHTML = data.items.map(renderEntry).join("");
      $("empty").hidden = data.total !== 0;
      $("pager").hidden = data.total === 0;
      $("pcount").textContent = "Page " + data.page + " of " + data.pages;
      $("prev").disabled = page <= 1;
      $("next").disabled = page >= pages;
      window.scrollTo({ top: 0, behavior: "auto" });
    }).catch(function () {
      $("empty").hidden = false;
    });
  }

  $("prev").addEventListener("click", function () { if (page > 1) { page--; render(); } });
  $("next").addEventListener("click", function () { if (page < pages) { page++; render(); } });
  render();
})();
