// Phase 1 content is hardcoded, mirroring design/taco.html. Voting itself is
// real (see lib/votes.ts, app/api/vote) — open to anyone, one vote per
// browser per day, until $TACO bonds and wallet-gated voting takes over.
// See SPEC.md.

export const currentRound = {
  number: 7,
  status: "Open",
  question: "Will Trump back down on striking Iranian energy infrastructure?",
  headline: "Does he chicken out, or does he actually do it?",
  closesIn: "3d 14h",
  optionA: { label: "Option A", name: "Major taco" },
  optionB: { label: "Option B", name: "Oh sh!t" },
};

export const marqueeItems = [
  { label: "Live question", value: "Round 07" },
  { label: "Ceasefire status", value: "collapsed" },
  { label: "Last taco", value: "08 Apr 2026" },
  { label: "Voting", value: "open to everyone, 1 per day" },
];

export const feedItems = [
  {
    source: "CNN",
    date: "01 Aug",
    headline:
      "Trump weighs escalation against Iranian energy sites as regional warnings mount",
    tag: "bearish" as const,
  },
  {
    source: "The Hill",
    date: "Jul",
    headline:
      "Ceasefire declared over after both sides trade strikes, but talks set to continue",
    tag: "mixed" as const,
  },
  {
    source: "CNBC",
    date: "Jul",
    headline: "Trump says Iran asked to keep talking, and the US agreed",
    tag: "bullish" as const,
  },
  {
    source: "Axios",
    date: "Apr",
    headline: "Two-week ceasefire agreed days after maximal public threats",
    tag: "bullish" as const,
  },
];

export const historyRows = [
  {
    date: "Apr 2025",
    title: "Liberation Day tariffs",
    note: "Sweeping tariffs announced, markets sold off hard, then a 90-day pause on most of them arrived within a week.",
    outcome: "taco" as const,
  },
  {
    date: "May 2025",
    title: "China at 145%",
    note: "Headline rate escalated to triple digits, then cut sharply after talks in Geneva.",
    outcome: "taco" as const,
  },
  {
    date: "May 2025",
    title: "EU 50% threat",
    note: "Threatened over a weekend, delayed by Monday.",
    outcome: "taco" as const,
  },
  {
    date: "Apr 2026",
    title: "Iran, first ceasefire",
    note: "Maximal public threats, then a two-week ceasefire mediated by Pakistan, later extended indefinitely.",
    outcome: "taco" as const,
  },
  {
    date: "Jul 2026",
    title: "Iran, ceasefire torn up",
    note: "Ceasefire declared over, naval blockade held, strikes resumed. The indicator got this one wrong.",
    outcome: "no_taco" as const,
  },
];

export const memeWall = [
  { caption: "He said the whole civilization thing again", by: "@holder" },
  { caption: "Ceasefire lasted eleven days, gauge lasted four", by: "@holder" },
  { caption: "POV: you shorted the taco", by: "@holder" },
  { caption: "Needle doing that thing again", by: "@holder" },
  { caption: "90 day pause my beloved", by: "@holder" },
  { caption: "Round 06 winners in shambles", by: "@holder" },
];

export const goalProgress = {
  percent: 37,
  label: "37% of one month",
};

export const roadmapItems = [
  {
    number: "01",
    status: "live" as const,
    title: "The gauge is live",
    detail:
      "Voting is real: open to anyone, one vote per browser per day. The gauge, feed and form guide reflect it — only the feed and form guide are still hardcoded.",
  },
  {
    number: "02",
    status: "next" as const,
    title: "Wallet-gated voting, once $TACO bonds",
    detail:
      "Once the token graduates the bonding curve, voting moves behind a wallet: connect, sign in with Solana, vote against a snapshot taken at round open. One wallet, one vote, no balance weighting — replacing the one-per-browser rule above with one tied to actually holding the token.",
  },
  {
    number: "03",
    status: "planned" as const,
    title: "Feed pulls itself",
    detail:
      "A scheduled job pulls news and Truth Social posts automatically. Nothing goes visible until a human tags it — an algorithm guessing which way something cuts would eventually be embarrassing.",
  },
  {
    number: "04",
    status: "planned" as const,
    title: "Holders pick the next question",
    detail:
      "Anyone can propose a question for the next round. Holders vote on which one runs, same gate as regular voting.",
  },
  {
    number: "05",
    status: "planned" as const,
    title: "Goal bar hits 100%",
    detail:
      "If the community goal ever actually fills, one month of the Truth API gets bought and the invoice gets posted. Not because we need it.",
  },
];
